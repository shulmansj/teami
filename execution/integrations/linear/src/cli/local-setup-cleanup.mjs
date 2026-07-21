import fs from "node:fs";
import path from "node:path";

import {
  removeTeamRegistryState,
  readTeamRegistry,
  updateTeamRegistry,
} from "../team-registry.mjs";
import { buildTeamContext } from "../team-resolver.mjs";
import { acquireGatewayLock } from "../gateway-loop.mjs";
import { acquireTeamOperationLock } from "../team-operation-lock.mjs";
import { githubConnectionStatePath } from "../github-setup.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../linear-credential-store.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { removeSetupState } from "../local-state.mjs";
import { createSetupStateStore, isSetupOwnerAlive } from "../setup-orchestrator.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { flagValue } from "./flags.mjs";
import { resolveTeamiHome } from "../app-home.mjs";

const LOCAL_SETUP_COMMAND_OPTIONS = Object.freeze({
  reset: {
    fullReset: true,
    startMessage: "Resetting maintainer onboarding test state...",
    completeMessage: "Reset complete.",
    printRevocationReminder: false,
  },
  uninstall: {
    fullReset: false,
    startMessage: "Removing local setup...",
    completeMessage: "Uninstall complete.",
    printRevocationReminder: true,
  },
});

export async function runLocalSetupCleanupCommand({ context, command, args }) {
  const { config, repoRoot, home = resolveTeamiHome(), cachePath, setupStatePath, output = createCliOutput() } = context;
    const commandOptions = LOCAL_SETUP_COMMAND_OPTIONS[command] || LOCAL_SETUP_COMMAND_OPTIONS.uninstall;
    output.heading(
      command === "reset"
        ? `Teami ${output.symbols.separator} reset`
        : `Teami ${output.symbols.separator} uninstall`,
    );
    output.detail(commandOptions.startMessage);
    const result = await removeLocalLinearSetup(cachePath, setupStatePath, {
      config,
      repoRoot,
      home,
      teamRef: flagValue(args, "--team"),
      fullReset: commandOptions.fullReset,
      log: createCleanupProgress(output),
    });
    if (result.ok) {
      output.done(commandOptions.completeMessage);
    }
    if (result.ok && commandOptions.printRevocationReminder) {
      output.warn("Revoke the Linear browser grant in Linear workspace settings to remove server-side access.");
    }
    process.exitCode = result.ok ? 0 : 1;
}
function removeLocalState(filePath, label, log = (line) => console.log(line)) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
    log(`removed: ${label}`);
    return;
  }
  log(`already clean: ${label}`);
}

function createBootstrapLinearCredentialStore({ config, repoRoot, home }) {
  return createLinearCredentialStore({
    config,
    repoRoot,
    home,
    target: legacyCredentialTargetForConfig(config),
  });
}

async function promoteSetupCredentialToTeam({
  setupCredentialStore,
  config,
  repoRoot,
  home,
  teamContext,
  createCredentialStore = createLinearCredentialStore,
  replaceExisting = false,
}) {
  const tokenSet = await setupCredentialStore.readTokenSet();
  if (!tokenSet) {
    throw new Error("The setup credential is missing. Reauthorize Linear before Teami marks this Team active.");
  }
  const teamCredentialStore = createCredentialStore({
    config,
    repoRoot,
    home,
    teamContext,
    promoteLegacyOnRead: replaceExisting !== true,
  });
  const existingTokenSet = replaceExisting === true
    ? await teamCredentialStore.readTokenSet()
    : null;
  const promotion = existingTokenSet
    ? await teamCredentialStore.replaceTokenSetIfEqual(existingTokenSet, tokenSet)
    : await teamCredentialStore.writeTokenSetIfAbsentOrEqual(tokenSet);
  if (!promotion?.ok) {
    throw new Error(
      "A newer Team credential already exists. Teami preserved both credentials; retry authorization instead of overwriting it.",
    );
  }
  const cleanup = await setupCredentialStore.deleteTokenSetIfEqual(tokenSet);
  if (!cleanup?.ok) {
    throw new Error(
      "The setup credential changed during promotion. Teami preserved the newer credential; retry setup.",
    );
  }
}

async function removeLocalLinearSetup(
  cachePath,
  setupStatePath,
  options = {},
) {
  const home = options.home || resolveTeamiHome();
  const log = options.log || ((line) => console.log(line));
  const setupStore = options.setupStateStore || createSetupStateStore({ home });
  const operationLock = setupStore.acquire({ purpose: "local_setup_cleanup" });
  if (!operationLock.ok) {
    log("another setup or cleanup is active; wait for it to finish, then retry.");
    return { ok: false, reason: "setup_lock_held" };
  }
  try {
    const active = setupStore.findActive?.();
    if (active && isSetupOwnerAlive(active) !== false) {
      log(`setup ${active.setup_id} is still active; finish or expire it before removing local state.`);
      return { ok: false, reason: "setup_session_active", setupId: active.setup_id };
    }
    const gatewayReservation = (options.acquireGatewayLock || acquireGatewayLock)({
      home,
      installHandlers: false,
    });
    if (!gatewayReservation.ok) {
      log("the Teami gateway is still running; stop it before removing Team credentials and local state.");
      return { ok: false, reason: "gateway_active" };
    }
    try {
      const teamOperationReservation = (options.acquireTeamOperationLock || acquireTeamOperationLock)({ home });
      if (!teamOperationReservation.ok) {
        log("another Teami planning, review, or credential operation is active; wait for it to finish before removing Team credentials and local state.");
        return { ok: false, reason: "team_operation_active" };
      }
      try {
        return await removeLocalLinearSetupUnderLock(cachePath, setupStatePath, options);
      } finally {
        teamOperationReservation.release?.();
      }
    } finally {
      gatewayReservation.release?.();
    }
  } finally {
    operationLock.release();
  }
}

async function removeLocalLinearSetupUnderLock(
  cachePath,
  setupStatePath,
  {
    config,
    repoRoot,
    home = resolveTeamiHome(),
    teamRef = null,
    fullReset = false,
    removeTeamSetup = removeOneTeamSetup,
    log = (line) => console.log(line),
  },
) {
  const registry = readTeamRegistry({ home });
  if (!registry) {
    return removePreTeamLocalLinearSetup(cachePath, setupStatePath, {
      config,
      repoRoot,
      home,
      log,
    });
  }

  const teams = registry?.teams || [];
  let selectedTeams = fullReset
    ? teams
    : selectTeamsForCommand(teams, teamRef);
  if (!fullReset && selectedTeams.length !== 1) {
    log("could not resolve a single team to uninstall; pass --team <team_ref>.");
    return { ok: false };
  }

  if (!fullReset) {
    const selectedTeam = selectedTeams[0];
    try {
      const outcome = updateTeamRegistry({ home }, (currentRegistry) => {
        const currentTeam = currentRegistry.teams.find((candidate) => candidate.id === selectedTeam.id);
        if (!currentTeam || JSON.stringify(currentTeam) !== JSON.stringify(selectedTeam)) {
          const error = new Error("team_registry_team_conflict");
          error.code = "team_registry_team_conflict";
          throw error;
        }
        currentTeam.status = "removed";
        delete currentTeam.setup_incomplete_cause;
        return { registry: currentRegistry, team: currentTeam };
      });
      selectedTeams = [outcome.team];
      log(`marked removed before local cleanup: team ${outcome.team.id}`);
    } catch (error) {
      if (error?.code !== "team_registry_team_conflict") throw error;
      log(`team ${selectedTeam.id} changed before uninstall cleanup began; retry to use its latest state.`);
      return { ok: false };
    }
  }

  for (const store of legacyCredentialStores({ config, repoRoot, home })) {
    try {
      await store.remove();
      log(`removed: ${store.label}`);
    } catch (error) {
      log(`could not remove ${store.label}: ${redactOAuthSecrets(error.message)}`);
      return { ok: false };
    }
  }

  let ok = true;
  for (const team of selectedTeams) {
    const removed =
      fullReset && team.status === "removed"
        ? await removeRemovedTeamSetup({
            config,
            repoRoot,
            home,
            team,
            removeTeamSetup,
            log,
          })
        : await removeTeamSetup({
          config,
          repoRoot,
          home,
          team,
          log,
        });
    ok = ok && removed.ok;
  }
  if (!ok) {
    log(
      fullReset
        ? "Reset aborted before deleting local team state because one or more local credentials could not be removed."
        : "The team is marked removed, but local cleanup did not complete. Rerun uninstall for this team to finish cleanup.",
    );
    return { ok: false };
  }

  if (!fullReset && registry) {
    log(`local cleanup complete: team ${selectedTeams[0].id}`);
    return { ok };
  }

  removeLocalState(cachePath, "legacy linear cache", log);
  removeRetiredEventPathLocalState({ config, repoRoot, log });
  const teamState = removeTeamRegistryState({ home });
  log(teamState.registryRemoved ? "removed: team registry" : "already clean: team registry");
  log(teamState.teamsDirRemoved ? "removed: per-team Linear caches" : "already clean: per-team Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(home);
  if (fs.existsSync(githubStatePath)) {
    removeLocalState(githubStatePath, "GitHub connection state", log);
  }

  return { ok };
}

async function removePreTeamLocalLinearSetup(
  cachePath,
  setupStatePath,
  { config, repoRoot, home = resolveTeamiHome(), log = (line) => console.log(line) },
) {
  const credentialStore = createBootstrapLinearCredentialStore({ config, repoRoot, home });

  removeLocalState(cachePath, "linear cache", log);
  removeRetiredEventPathLocalState({ config, repoRoot, log });
  const teamState = removeTeamRegistryState({ home });
  log(teamState.registryRemoved ? "removed: team registry" : "already clean: team registry");
  log(teamState.teamsDirRemoved ? "removed: per-team Linear caches" : "already clean: per-team Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(home);
  if (fs.existsSync(githubStatePath)) {
    removeLocalState(githubStatePath, "GitHub connection state", log);
  }
  try {
    await credentialStore.deleteTokenSet();
    log("removed: Linear setup OAuth credential");
  } catch (error) {
    log(`could not remove Linear setup OAuth credential: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  return { ok: true };
}

async function removeOneTeamSetup({
  config,
  repoRoot,
  home = resolveTeamiHome(),
  team,
  createOAuthCredentialStore = createLinearCredentialStore,
  removeLocalFile = removeLocalState,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryTeam({ team, config, repoRoot, home });
  if (!context) {
    log(`skipped: team ${team.id} has incomplete identity; npm run reset will remove local files`);
    return { ok: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, teamContext: context });
  let ok = true;

  removeLocalFile(context.linear.cachePath, `team ${team.id} linear cache`, log);
  removeRetiredEventPathLocalState({ config, repoRoot, teamRef: team.id, log });

  try {
    await credentialStore.deleteTokenSet();
    log(`removed: team ${team.id} Linear setup OAuth credential`);
  } catch (error) {
    log(`could not remove team ${team.id} Linear setup OAuth credential: ${redactOAuthSecrets(error.message)}`);
    ok = false;
  }

  return { ok };
}

async function removeRemovedTeamSetup({
  config,
  repoRoot,
  home = resolveTeamiHome(),
  team,
  removeTeamSetup = removeOneTeamSetup,
  createOAuthCredentialStore = createLinearCredentialStore,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryTeam({ team, config, repoRoot, home });
  if (!context) {
    log(`already clean: removed team ${team.id} has no complete Linear identity`);
    return { ok: true, alreadyClean: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, teamContext: context });
  let tokenSet = null;
  try {
    tokenSet = await credentialStore.readTokenSet?.();
  } catch (error) {
    log(`could not verify removed team ${team.id} credentials: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  if (!tokenSet) {
    removeRetiredEventPathLocalState({ config, repoRoot, teamRef: team.id, log });
    log(`already clean: removed team ${team.id} local credentials`);
    return { ok: true, alreadyClean: true };
  }

  log(`removed team ${team.id} still has local credentials; removing local credential state before reset.`);
  return removeTeamSetup({
    config,
    repoRoot,
    home,
    team,
    log,
  });
}

function selectTeamsForCommand(teams, teamRef = null) {
  if (teamRef) return teams.filter((team) => team.id === teamRef);
  const activeTeams = teams.filter((team) => team.status === "active");
  return activeTeams.length === 1 ? activeTeams : [];
}

function contextForRegistryTeam({ team, config, repoRoot, home }) {
  if (!team?.linear?.workspace_id || !team?.id) return null;
  try {
    return buildTeamContext({ team, config, repoRoot, home });
  } catch {
    return null;
  }
}

function legacyCredentialStores({ config, repoRoot, home }) {
  return [
    {
      label: "legacy Linear setup OAuth credential",
      remove: async () =>
        createLinearCredentialStore({
          config,
          repoRoot,
          home,
          target: legacyCredentialTargetForConfig(config),
        }).deleteTokenSet(),
    },
  ];
}

function removeRetiredEventPathLocalState({
  config,
  repoRoot,
  teamRef = null,
  log = (line) => console.log(line),
} = {}) {
  const inbox = config?.inbox || {};
  const files = [
    path.resolve(repoRoot, inbox.setup_grant_file || path.join(".teami", "inbox-setup-grant.env")),
    teamRef
      ? path.resolve(repoRoot, ".teami", "teams", teamRef, "inbox-runner-credential.json")
      : path.resolve(repoRoot, inbox.credential_file || path.join(".teami", "inbox-runner-credential.json")),
  ];
  for (const filePath of files) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      log(`removed: ${path.relative(repoRoot, filePath)}`);
    }
  }
}

function createCleanupProgress(output) {
  return (line) => {
    const text = String(line || "");
    if (text.startsWith("removed: ")) {
      output.success(`Removed ${cleanupLabel(text.slice("removed: ".length))}`);
      output.detail(text);
      return;
    }
    if (text.startsWith("already clean: ")) {
      output.success(`${capitalize(cleanupLabel(text.slice("already clean: ".length)))} already clean`);
      output.detail(text);
      return;
    }
    const markedRemoved = text.match(/^marked removed: team (.+)$/);
    if (markedRemoved) {
      output.success("Team marked removed");
      output.detail(`team_ref=${markedRemoved[1]}`);
      return;
    }
    if (text.startsWith("could not ") || text.includes(" aborted ")) {
      output.warn(text);
      return;
    }
    if (text.startsWith("Manual cleanup required: ")) {
      output.warn(text.slice("Manual cleanup required: ".length));
      return;
    }
    output.detail(text);
  };
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function cleanupLabel(label) {
  return String(label || "").replace(/^team [^\s]+ /, "team ");
}

export {
  createBootstrapLinearCredentialStore,
  legacyCredentialStores,
  promoteSetupCredentialToTeam,
  removeLocalLinearSetup,
  removeOneTeamSetup,
};
