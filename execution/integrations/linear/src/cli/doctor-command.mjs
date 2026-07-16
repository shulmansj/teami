import fs from "node:fs";

import { readLinearCache } from "../cache.mjs";
import { readClaudePluginHealth } from "../claude-plugin-health.mjs";
import { formatRuntimeRoleAssignmentsSection } from "../config.mjs";
import { doctorCheck, normalizeDoctorChecks } from "../doctor-check.mjs";
import { resolveForegroundTeamCache } from "../team-command-context.mjs";
import { readTeamRegistry } from "../team-registry.mjs";
import { defaultRunCommand, githubConnectionDoctorChecks } from "../github-setup.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../linear-credential-store.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import {
  doctorTeamRegistryFromDisk,
  doctorLinear,
  doctorMergePathGitHubCheck,
} from "../linear-service.mjs";
import {
  createDefaultExecutionPullRequestAdapter,
} from "../execution-pr-adapter.mjs";
import { phoenixStatus } from "../local-phoenix-manager.mjs";
import { resourcesToRepoIdentity } from "../review-pr-discovery.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  runtimeSmokeDoctorChecks,
} from "../runtime-smoke.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { doctorExitCode, renderDoctorReport } from "./doctor-report.mjs";
import {
  completeTeamTeamMissingRecoveryForTeam,
  formatCommand,
} from "./operator-output.mjs";
import { flagValue } from "./flags.mjs";
import { githubDoctorTransportFromConnection } from "./github-command-options.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import { acquireTeamOperationLock } from "../team-operation-lock.mjs";
import { createSetupStateStore } from "../setup-orchestrator.mjs";
const PUBLISHED_CLAUDE_PLUGIN_MARKETPLACE_SOURCE = "https://github.com/shulmansj/teami";
export async function runDoctorCommand({ context, command, args }) {
  const { config, repoRoot, home = resolveTeamiHome(), cachePath, output = createCliOutput() } = context;
  const checks = await doctorGraphqlLinear({
    config,
    repoRoot,
    home,
    cachePath,
    teamRef: flagValue(args, "--team"),
  });
  output.heading(`Teami ${output.symbols.separator} doctor`);
  renderDoctorReport(checks, output);
  for (const line of formatRuntimeRoleAssignmentsSection(config)) output.detail(line);
  process.exitCode = doctorExitCode(checks);
}
export async function runDoctorLinearCommand({ context, command, args }) {
  const { config, repoRoot, home = resolveTeamiHome(), cachePath, output = createCliOutput() } = context;
  const checks = await doctorGraphqlLinear({
    config,
    repoRoot,
    home,
    cachePath,
    teamRef: flagValue(args, "--team"),
    includeRuntimeSmoke: false,
    includePhoenix: false,
    includeGitHub: false,
    includeClaudePlugin: false,
  });
  output.heading(`Teami ${output.symbols.separator} Linear doctor`);
  renderDoctorReport(checks, output);
  for (const line of formatRuntimeRoleAssignmentsSection(config)) output.detail(line);
  process.exitCode = doctorExitCode(checks);
}
async function doctorGraphqlLinear({
  config,
  repoRoot,
  home = resolveTeamiHome(),
  cachePath,
  teamRef = null,
  includeRuntimeSmoke = true,
  includePhoenix = true,
  includeGitHub = true,
  includeClaudePlugin = true,
  claudePluginRunCommand = defaultRunCommand,
  claudePluginMarketplaceSource = PUBLISHED_CLAUDE_PLUGIN_MARKETPLACE_SOURCE,
  acquireTeamAuthority = acquireTeamOperationLock,
}) {
  const adminRevocationCheck = doctorAdminRevocationRequirement({ home });
  const claudePluginCheck = includeClaudePlugin
    ? await doctorClaudePluginContract({
        repoRoot,
        runCommand: claudePluginRunCommand,
        marketplaceSource: claudePluginMarketplaceSource,
      })
    : null;
  const crossSurfaceChecks = [adminRevocationCheck, ...(claudePluginCheck ? [claudePluginCheck] : [])];
  const teamDoctor = doctorTeamRegistryFromDisk({
    repoRoot,
    home,
    orphanHints: likelyTeamOrphans({ cachePath }),
  });
  if (!teamDoctor.registryAvailable) {
    return normalizeDoctorChecks([...teamDoctor.checks, ...crossSurfaceChecks]);
  }

  const registry = readTeamRegistry({ home });
  const selectedTeams = teamRef
    ? registry.teams.filter((team) => team.id === teamRef)
    : registry.teams.filter((team) => team.status === "active");
  const checks = [{
    name: "team registry",
    ok: teamDoctor.healthy,
    message: `${teamDoctor.checks.length} team${teamDoctor.checks.length === 1 ? "" : "s"} configured`,
  }, ...teamDoctor.checks, ...crossSurfaceChecks, ...doctorProductRepoBindingChecksForTeams(
    teamRef ? registry.teams.filter((team) => team.id === teamRef) : registry.teams,
  )];

  if (teamRef && selectedTeams.length === 0) {
    checks.push({
      name: "team selection",
      ok: false,
      message: `team_not_found: ${teamRef}`,
    });
    return normalizeDoctorChecks(checks);
  }

  for (const team of selectedTeams) {
    if (team.status !== "active") continue;
    let foreground;
    try {
      foreground = resolveForegroundTeamCache({ config, repoRoot, home, registry, teamRef: team.id });
    } catch (error) {
      checks.push({
        name: `team ${team.id} selection`,
        ok: false,
        message: redactOAuthSecrets(error.message),
      });
      continue;
    }

    checks.push(...(await doctorLegacyCredentialTargets({
      config,
      repoRoot,
      home,
      context: foreground.context,
    })));

    let teamAuthority = null;
    try {
      teamAuthority = acquireTeamAuthority({ home, installHandlers: false });
      const credentialStore = createLinearCredentialStore({
        config,
        repoRoot,
        home,
        teamContext: foreground.context,
        promoteLegacyOnRead: teamAuthority.ok === true,
      });
      const setupAuth = createLinearSetupGraphqlClient({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        // Doctor remains read-only when a gateway, review, setup cleanup, or
        // another Team lifecycle operation owns authority.
        allowRefresh: teamAuthority.ok === true,
      });
      const authResult = await setupAuth.client.verifyAuth();
      const doctor = await doctorLinear({ client: setupAuth.client, config: foreground.config, cache: foreground.cache });
      const mergePathGitHubCheck = await doctorMergePathGitHubCheck({
        ...mergePathRepoIdentityForTeam(foreground.context),
        createPrAdapter: ({ repoIdentity }) => createDefaultExecutionPullRequestAdapter({ repoIdentity }),
      });
      const teamCheck = doctor.checks.find((check) => check.name === "team");
      const savedTeamCheck = doctor.checks.find((check) => check.name === "cache teamId" && check.ok === false);
      const teamVisibilityCheck = teamTeamVisibilityCheck({
        team,
        teamCheck,
        savedTeamCheck,
        teamKey: foreground.config.linear.team.key,
      });
      checks.push({
        name: `team ${team.id} Linear setup OAuth`,
        ok: true,
        message: `GraphQL auth verified for viewer ${authResult.viewerId}`,
      }, teamVisibilityCheck, {
        ...mergePathGitHubCheck,
        name: `team ${team.id} ${mergePathGitHubCheck.name}`,
      }, ...doctor.checks.map((check) => ({
        ...check,
        name: `team ${team.id} ${check.name}`,
      })));
    } catch (error) {
      checks.push({
        name: `team ${team.id} Linear setup OAuth`,
        ok: false,
        message: redactOAuthSecrets(error.message),
      });
    } finally {
      teamAuthority?.release?.();
    }
  }

  if (includeRuntimeSmoke) {
    checks.push(...(await runtimeSmokeDoctorChecks({
      config,
      cache: readRuntimeSmokeCache(runtimeSmokeCachePath(config, home)),
    })));
  }
  if (includePhoenix) {
    const phoenix = await phoenixStatus({ repoRoot });
    checks.push({
      name: "local Phoenix",
      ok: phoenix.ok,
      message: phoenix.ok ? phoenix.appUrl : `${phoenix.status}${phoenix.repairHint ? `; ${phoenix.repairHint}` : ""}`,
    });
  }
  // Step 11: GitHub connection drift checks run even when Linear auth is
  // broken — the GitHub repair path is independent of the Linear one.
  if (includeGitHub) {
    let githubDoctorTransport = null;
    try {
      githubDoctorTransport = githubDoctorTransportFromConnection({ repoRoot, home, config });
    } catch {
      // githubConnectionDoctorChecks will fail closed for real connections
      // without a live transport instead of reporting dry-run checks as true.
      githubDoctorTransport = null;
    }
    checks.push(...(await githubConnectionDoctorChecks({ repoRoot, home, config, transport: githubDoctorTransport })));
  }
  return normalizeDoctorChecks(checks);
}

async function doctorClaudePluginContract({ repoRoot, runCommand, marketplaceSource } = {}) {
  const health = await readClaudePluginHealth({
    repoRoot,
    runCommand,
    pluginName: "teami",
    marketplaceName: "teami",
    marketplaceSource,
    scope: "user",
  });
  return {
    name: "Claude plugin launch contract",
    ok: health.ok === true,
    message: health.ok
      ? `teami@teami ${health.version} is enabled from the trusted marketplace with an exact npx launch`
      : `${health.reason || "claude_plugin_unhealthy"}${health.detail ? `: ${health.detail}` : ""}; rerun ${formatCommand("init")}`,
  };
}

function doctorAdminRevocationRequirement({ home } = {}) {
  try {
    const requirement = createSetupStateStore({ home }).readAdminRevocationRequirement();
    return {
      name: "one-time Linear admin revocation",
      ok: !requirement,
      message: requirement
        ? "unverified after an interrupted or failed one-shot admin flow; revoke Teami access in Linear Settings -> Applications, then uninstall the blocked local state and start setup again (a fresh token cannot prove the lost token is gone)"
        : "no unresolved one-shot admin grant marker",
    };
  } catch (error) {
    return {
      name: "one-time Linear admin revocation",
      ok: false,
      message: `local revocation evidence is unreadable: ${redactOAuthSecrets(error.message)}`,
    };
  }
}

function teamTeamVisibilityCheck({ team, teamCheck = null, savedTeamCheck = null, teamKey = null } = {}) {
  if (savedTeamCheck?.ok === false && team?.linear?.team_id) {
    const recovery = completeTeamTeamMissingRecoveryForTeam(team);
    return {
      name: `team ${team.id} Linear team visibility`,
      ok: false,
      message: `${recovery.what} ${recovery.why}`,
      fix: recovery.fix,
      showMessage: true,
    };
  }
  return {
    name: `team ${team.id} Linear team visibility`,
    ok: teamCheck?.ok === true,
    message: teamCheck?.ok === true
      ? `can see team ${teamKey || team?.linear?.team_key || "unknown"}`
      : teamCheck?.message || `team ${teamKey || team?.linear?.team_key || "unknown"} not visible`,
  };
}

function mergePathRepoIdentityForTeam(teamContext) {
  try {
    return { repoIdentity: resourcesToRepoIdentity(teamContext) };
  } catch (error) {
    return { repoIdentity: null, repoIdentityError: error.message };
  }
}

function doctorProductRepoBindingChecksForTeams(teams = []) {
  return teams.map((team) => {
    const posture = productRepoBindingPosture(team);
    return doctorCheck({
      name: `team ${team.id} product repo binding`,
      state: posture.state,
      message: [formatProductRepoBindingReadout(team), posture.message].filter(Boolean).join("; "),
      fix: posture.fix,
      showMessage: true,
    });
  });
}

function formatProductRepoBindingReadout(team) {
  const prefix = `team=${formatTeamReadoutName(team)}; linear_team=${formatLinearTeam(team.linear)}`;
  const gitRepo = team.resources.find((resource) => resource.kind === "git_repo");
  if (!gitRepo) {
    return `${prefix}; no product repo granted (team grant authorizes product repos; behavior repo GitHub setup remains separate config.github)`;
  }
  const binding = gitRepo.binding;
  return (
    `${prefix}; product repo remote=${binding.owner}/${binding.repo}; default_branch=${binding.default_branch}; ` +
    "materialization=fresh_remote_clone; " +
    "granted_by=team:grant; behavior repo GitHub setup remains separate config.github"
  );
}

export function doctorProductRepoBindingChecks({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef = null,
} = {}) {
  const registry = readTeamRegistry({ home });
  if (!registry) return [];
  const teams = teamRef
    ? registry.teams.filter((team) => team.id === teamRef)
    : registry.teams;
  return doctorProductRepoBindingChecksForTeams(teams);
}

function productRepoBindingPosture(team) {
  const gitRepo = team.resources.find((resource) => resource.kind === "git_repo");
  if (!gitRepo) return { state: "ok", message: null, fix: null };
  const binding = gitRepo.binding || {};
  const missing = ["owner", "repo", "default_branch"].filter((field) =>
    typeof binding[field] !== "string" || binding[field].trim() === ""
  );
  if (missing.length > 0) {
    return {
      state: "fail",
      message: `product repo binding is missing ${missing.join(", ")} for remote materialization`,
      fix: "Re-grant the team repo with team grant so execution can derive the GitHub remote.",
    };
  }
  return { state: "ok", message: "fresh remote clone ready for execution", fix: null };
}

function formatTeamReadoutName(team) {
  if (isNonEmptyString(team.adopter_provided_name) && team.adopter_provided_name !== team.id) {
    return `${team.adopter_provided_name} (${team.id})`;
  }
  return team.id;
}

function formatLinearTeam(linear = {}) {
  const label = [linear.team_key, linear.team_name]
    .filter(isNonEmptyString)
    .join(" ");
  const teamId = isNonEmptyString(linear.team_id) ? linear.team_id : "missing";
  return label ? `${label} (${teamId})` : teamId;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function doctorLegacyCredentialTargets({ config, repoRoot, home, context }) {
  const checks = [];
  const legacyOAuthStore = createLinearCredentialStore({
    config,
    repoRoot,
    home,
    target: legacyCredentialTargetForConfig(config),
  });

  try {
    const tokenSet = await legacyOAuthStore.readTokenSet();
    checks.push({
      name: `team ${context.teamRef} legacy Linear OAuth credential target`,
      ok: !tokenSet,
      message: tokenSet
        ? `legacy pre-team target found for workspace=${context.linear.workspaceId}; rerun ${formatCommand(`init --team ${context.teamRef}`)} or ${formatCommand("reset")}`
        : "no legacy pre-team target found",
    });
  } catch (error) {
    checks.push({
      name: `team ${context.teamRef} legacy Linear OAuth credential target`,
      ok: false,
      message: redactOAuthSecrets(error.message),
    });
  }

  return checks;
}

function likelyTeamOrphans({ cachePath } = {}) {
  const hints = [];
  if (cachePath && fs.existsSync(cachePath)) {
    hints.push(`legacy Linear cache ${cachePath}`);
    try {
      const cache = readLinearCache(cachePath);
      if (cache?.workspaceId) hints.push(`cached workspace ${cache.workspaceId}`);
      const webhookId = cache?.inbox?.linearWebhook?.id || cache?.webhook?.id;
      if (webhookId) hints.push(`cached webhook ${webhookId}`);
    } catch (error) {
      hints.push(`unreadable legacy cache (${error.message})`);
    }
  }
  return hints;
}

export {
  doctorGraphqlLinear,
  teamTeamVisibilityCheck,
};
