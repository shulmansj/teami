import fs from "node:fs";
import path from "node:path";

import {
  removeDomainRegistryState,
  readDomainRegistry,
  writeDomainRegistry,
} from "../domain-registry.mjs";
import { buildDomainContext } from "../domain-resolver.mjs";
import { githubConnectionStatePath } from "../github-setup.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../linear-credential-store.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { removeSetupState } from "../local-state.mjs";
import {
  cleanupLocalSupervisorLocalState,
  formatLocalSupervisorCleanupReport,
} from "../local-supervisor.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { flagValue } from "./flags.mjs";

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
  const { config, repoRoot, cachePath, setupStatePath, output = createCliOutput() } = context;
    const commandOptions = LOCAL_SETUP_COMMAND_OPTIONS[command] || LOCAL_SETUP_COMMAND_OPTIONS.uninstall;
    output.heading(
      command === "reset"
        ? `Agentic Factory ${output.symbols.separator} reset`
        : `Agentic Factory ${output.symbols.separator} uninstall`,
    );
    output.detail(commandOptions.startMessage);
    const result = await removeLocalLinearSetup(cachePath, setupStatePath, {
      config,
      repoRoot,
      domainId: flagValue(args, "--domain"),
      fullReset: commandOptions.fullReset,
      log: createCleanupProgress(output),
    });
    output.done(commandOptions.completeMessage);
    if (commandOptions.printRevocationReminder) {
      output.warn("Revoke the Linear browser grant in Linear workspace settings to remove server-side access.");
    }
    process.exit(result.ok ? 0 : 1);
}
function removeLocalState(filePath, label, log = (line) => console.log(line)) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
    log(`removed: ${label}`);
    return;
  }
  log(`already clean: ${label}`);
}

function createBootstrapLinearCredentialStore({ config, repoRoot }) {
  return createLinearCredentialStore({
    config,
    repoRoot,
    target: legacyCredentialTargetForConfig(config, repoRoot),
  });
}

async function promoteSetupCredentialToDomain({
  setupCredentialStore,
  config,
  repoRoot,
  domainContext,
}) {
  const tokenSet = await setupCredentialStore.readTokenSet();
  if (!tokenSet) return;
  const domainCredentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  await domainCredentialStore.writeTokenSet(tokenSet);
  await setupCredentialStore.deleteTokenSet();
}

async function removeLocalLinearSetup(
  cachePath,
  setupStatePath,
  {
    config,
    repoRoot,
    domainId = null,
    fullReset = false,
    removeDomainSetup = removeOneDomainSetup,
    log = (line) => console.log(line),
  },
) {
  const registry = readDomainRegistry({ repoRoot });
  if (!registry) {
    return removePreDomainLocalLinearSetup(cachePath, setupStatePath, {
      config,
      repoRoot,
      log,
    });
  }

  const domains = registry?.domains || [];
  const selectedDomains = fullReset
    ? domains
    : selectDomainsForCommand(domains, domainId);
  if (!fullReset && selectedDomains.length !== 1) {
    log("could not resolve a single domain to uninstall; pass --domain <domain_id>.");
    return { ok: false };
  }

  const supervisorCleanup = cleanupLocalSupervisorLocalState({ repoRoot });
  for (const line of formatLocalSupervisorCleanupReport(supervisorCleanup)) log(line);

  for (const store of legacyCredentialStores({ config, repoRoot })) {
    try {
      await store.remove();
      log(`removed: ${store.label}`);
    } catch (error) {
      log(`could not remove ${store.label}: ${redactOAuthSecrets(error.message)}`);
      return { ok: false };
    }
  }

  let ok = true;
  for (const domain of selectedDomains) {
    const removed =
      fullReset && domain.status === "removed"
        ? await removeRemovedDomainSetup({
            config,
            repoRoot,
            domain,
            removeDomainSetup,
            log,
          })
        : await removeDomainSetup({
          config,
          repoRoot,
          domain,
          log,
        });
    ok = ok && removed.ok;
  }
  if (!ok) {
    log(
      fullReset
        ? "Reset aborted before deleting local domain state because one or more local credentials could not be removed."
        : "Uninstall aborted before marking the domain removed because local cleanup did not complete.",
    );
    return { ok: false };
  }

  if (!fullReset && registry) {
    const nextRegistry = structuredClone(registry);
    const domain = nextRegistry.domains.find((candidate) => candidate.id === selectedDomains[0].id);
    if (domain) {
      domain.status = "removed";
      delete domain.setup_incomplete_cause;
      writeDomainRegistry({ repoRoot }, nextRegistry);
      log(`marked removed: domain ${domain.id}`);
    }
    return { ok };
  }

  removeLocalState(cachePath, "legacy linear cache", log);
  removeRetiredEventPathLocalState({ config, repoRoot, log });
  const domainState = removeDomainRegistryState({ repoRoot });
  log(domainState.registryRemoved ? "removed: domain registry" : "already clean: domain registry");
  log(domainState.domainsDirRemoved ? "removed: per-domain Linear caches" : "already clean: per-domain Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(repoRoot);
  if (fs.existsSync(githubStatePath)) {
    removeLocalState(githubStatePath, "GitHub connection state", log);
  }

  return { ok };
}

async function removePreDomainLocalLinearSetup(
  cachePath,
  setupStatePath,
  { config, repoRoot, log = (line) => console.log(line) },
) {
  const supervisorCleanup = cleanupLocalSupervisorLocalState({ repoRoot });
  for (const line of formatLocalSupervisorCleanupReport(supervisorCleanup)) log(line);

  const credentialStore = createBootstrapLinearCredentialStore({ config, repoRoot });

  removeLocalState(cachePath, "linear cache", log);
  removeRetiredEventPathLocalState({ config, repoRoot, log });
  const domainState = removeDomainRegistryState({ repoRoot });
  log(domainState.registryRemoved ? "removed: domain registry" : "already clean: domain registry");
  log(domainState.domainsDirRemoved ? "removed: per-domain Linear caches" : "already clean: per-domain Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(repoRoot);
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

async function removeOneDomainSetup({
  config,
  repoRoot,
  domain,
  createOAuthCredentialStore = createLinearCredentialStore,
  removeLocalFile = removeLocalState,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryDomain({ domain, config, repoRoot });
  if (!context) {
    log(`skipped: domain ${domain.id} has incomplete identity; npm run reset will remove local files`);
    return { ok: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, domainContext: context });
  let ok = true;

  removeLocalFile(context.linear.cachePath, `domain ${domain.id} linear cache`, log);
  removeRetiredEventPathLocalState({ config, repoRoot, domainId: domain.id, log });

  try {
    await credentialStore.deleteTokenSet();
    log(`removed: domain ${domain.id} Linear setup OAuth credential`);
  } catch (error) {
    log(`could not remove domain ${domain.id} Linear setup OAuth credential: ${redactOAuthSecrets(error.message)}`);
    ok = false;
  }

  return { ok };
}

async function removeRemovedDomainSetup({
  config,
  repoRoot,
  domain,
  removeDomainSetup = removeOneDomainSetup,
  createOAuthCredentialStore = createLinearCredentialStore,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryDomain({ domain, config, repoRoot });
  if (!context) {
    log(`already clean: removed domain ${domain.id} has no complete Linear identity`);
    return { ok: true, alreadyClean: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, domainContext: context });
  let tokenSet = null;
  try {
    tokenSet = await credentialStore.readTokenSet?.();
  } catch (error) {
    log(`could not verify removed domain ${domain.id} credentials: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  if (!tokenSet) {
    removeRetiredEventPathLocalState({ config, repoRoot, domainId: domain.id, log });
    log(`already clean: removed domain ${domain.id} local credentials`);
    return { ok: true, alreadyClean: true };
  }

  log(`removed domain ${domain.id} still has local credentials; removing local credential state before reset.`);
  return removeDomainSetup({
    config,
    repoRoot,
    domain,
    log,
  });
}

function selectDomainsForCommand(domains, domainId = null) {
  if (domainId) return domains.filter((domain) => domain.id === domainId);
  const activeDomains = domains.filter((domain) => domain.status === "active");
  return activeDomains.length === 1 ? activeDomains : [];
}

function contextForRegistryDomain({ domain, config, repoRoot }) {
  if (!domain?.linear?.workspace_id || !domain?.id) return null;
  try {
    return buildDomainContext({ domain, config, repoRoot });
  } catch {
    return null;
  }
}

function legacyCredentialStores({ config, repoRoot }) {
  return [
    {
      label: "legacy Linear setup OAuth credential",
      remove: async () =>
        createLinearCredentialStore({
          config,
          repoRoot,
          target: legacyCredentialTargetForConfig(config, repoRoot),
        }).deleteTokenSet(),
    },
  ];
}

function removeRetiredEventPathLocalState({
  config,
  repoRoot,
  domainId = null,
  log = (line) => console.log(line),
} = {}) {
  const inbox = config?.inbox || {};
  const files = [
    path.resolve(repoRoot, inbox.setup_grant_file || path.join(".agentic-factory", "inbox-setup-grant.env")),
    domainId
      ? path.resolve(repoRoot, ".agentic-factory", "domains", domainId, "inbox-runner-credential.json")
      : path.resolve(repoRoot, inbox.credential_file || path.join(".agentic-factory", "inbox-runner-credential.json")),
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
    const markedRemoved = text.match(/^marked removed: domain (.+)$/);
    if (markedRemoved) {
      output.success("Domain marked removed");
      output.detail(`domain_id=${markedRemoved[1]}`);
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
  return String(label || "").replace(/^domain [^\s]+ /, "domain ");
}

export {
  createBootstrapLinearCredentialStore,
  legacyCredentialStores,
  promoteSetupCredentialToDomain,
  removeLocalLinearSetup,
  removeOneDomainSetup,
};
