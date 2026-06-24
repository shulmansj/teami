import fs from "node:fs";

import { readLinearCache } from "../cache.mjs";
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
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import { removeLinearWebhookRegistration } from "../linear-webhook-registration.mjs";
import { removeSetupState } from "../local-state.mjs";
import {
  cleanupLocalSupervisorLocalState,
  formatLocalSupervisorCleanupReport,
} from "../local-supervisor.mjs";
import {
  createRunnerInboxCredentialStore,
  legacyRunnerInboxCredentialTargetForConfig,
  removeRunnerInboxCredential,
} from "../runner-inbox-credential.mjs";
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
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output = createCliOutput() } = context;
    const commandOptions = LOCAL_SETUP_COMMAND_OPTIONS[command] || LOCAL_SETUP_COMMAND_OPTIONS.uninstall;
    output.heading(
      command === "reset"
        ? `Agentic Factory ${output.symbols.separator} reset`
        : `Agentic Factory ${output.symbols.separator} uninstall`,
    );
    output.detail(commandOptions.startMessage);
    const result = await removeLocalLinearSetup(cachePath, setupStatePath, {
      config,
      inboxClient,
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
    inboxClient,
    repoRoot,
    domainId = null,
    fullReset = false,
    createSetupAuth = createLinearSetupGraphqlClient,
    removeDomainSetup = removeOneDomainSetup,
    log = (line) => console.log(line),
  },
) {
  const registry = readDomainRegistry({ repoRoot });
  if (!registry) {
    return removePreDomainLocalLinearSetup(cachePath, setupStatePath, {
      config,
      inboxClient,
      repoRoot,
      createSetupAuth,
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

  const legacyCache = readLinearCache(cachePath);
  const legacySetupCredentialStore = createBootstrapLinearCredentialStore({ config, repoRoot });
  if (legacyCache?.inbox?.linearWebhook?.id || legacyCache?.webhook?.id || legacyCache?.workspaceId) {
    try {
      const setupAuth = createSetupAuth({
        config,
        repoRoot,
        credentialStore: legacySetupCredentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      });
      await removeLinearWebhookRegistration({
        linearClient: setupAuth.client,
        inboxClient,
        workspaceId: legacyCache.workspaceId,
        teamId: legacyCache.teamId,
        webhookId: legacyCache?.inbox?.linearWebhook?.id || legacyCache?.webhook?.id,
      });
      log("removed: Linear webhook inbox registration");
    } catch (error) {
      log(`could not remove Linear webhook inbox registration: ${redactOAuthSecrets(error.message)}`);
    }
  }

  for (const store of legacyCredentialStores({ config, repoRoot, inboxClient })) {
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
            inboxClient,
            domain,
            removeDomainSetup,
            log,
          })
        : await removeDomainSetup({
            config,
            repoRoot,
            inboxClient,
            domain,
            log,
          });
    ok = ok && removed.ok;
  }
  if (!ok) {
    log(
      fullReset
        ? "Reset aborted before deleting local domain state because one or more hosted credentials or webhooks could not be removed."
        : "Uninstall aborted before marking the domain removed because hosted cleanup did not complete.",
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
  const domainState = removeDomainRegistryState({ repoRoot });
  log(domainState.registryRemoved ? "removed: domain registry" : "already clean: domain registry");
  log(domainState.domainsDirRemoved ? "removed: per-domain Linear caches" : "already clean: per-domain Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(repoRoot);
  if (fs.existsSync(githubStatePath)) {
    removeLocalState(githubStatePath, "GitHub connection state", log);
    log(
      "Manual cleanup required: uninstall the Agentic Factory GitHub App from the behavior repo and confirm the one-time setup grant is revoked (GitHub -> Settings -> Applications). Local state removal alone does not revoke server-side access.",
    );
  }

  return { ok };
}

async function removePreDomainLocalLinearSetup(
  cachePath,
  setupStatePath,
  { config, inboxClient, repoRoot, createSetupAuth = createLinearSetupGraphqlClient, log = (line) => console.log(line) },
) {
  const supervisorCleanup = cleanupLocalSupervisorLocalState({ repoRoot });
  for (const line of formatLocalSupervisorCleanupReport(supervisorCleanup)) log(line);

  const cache = readLinearCache(cachePath);
  const webhookId = cache?.inbox?.linearWebhook?.id || cache?.webhook?.id;
  const credentialStore = createBootstrapLinearCredentialStore({ config, repoRoot });
  if (webhookId || cache?.workspaceId) {
    try {
      const setupAuth = createSetupAuth({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      });
      await removeLinearWebhookRegistration({
        linearClient: setupAuth.client,
        inboxClient,
        workspaceId: cache?.workspaceId,
        teamId: cache?.teamId,
        webhookId,
      });
      log("removed: Linear webhook inbox registration");
    } catch (error) {
      log(`could not remove Linear webhook inbox registration: ${redactOAuthSecrets(error.message)}`);
    }
  }

  try {
    await removeRunnerInboxCredential({
      inboxClient,
      credentialStore: createRunnerInboxCredentialStore({
        config,
        repoRoot,
        target: legacyRunnerInboxCredentialTargetForConfig(config, repoRoot),
      }),
      workspaceId: cache?.workspaceId,
    });
    log("removed: runner inbox credential");
  } catch (error) {
    log(`could not remove runner inbox credential: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  removeLocalState(cachePath, "linear cache", log);
  const domainState = removeDomainRegistryState({ repoRoot });
  log(domainState.registryRemoved ? "removed: domain registry" : "already clean: domain registry");
  log(domainState.domainsDirRemoved ? "removed: per-domain Linear caches" : "already clean: per-domain Linear caches");
  removeSetupState(setupStatePath);
  const githubStatePath = githubConnectionStatePath(repoRoot);
  if (fs.existsSync(githubStatePath)) {
    removeLocalState(githubStatePath, "GitHub connection state", log);
    log(
      "Manual cleanup required: uninstall the Agentic Factory GitHub App from the behavior repo and confirm the one-time setup grant is revoked (GitHub -> Settings -> Applications). Local state removal alone does not revoke server-side access.",
    );
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
  inboxClient,
  domain,
  createSetupAuth = createLinearSetupGraphqlClient,
  createOAuthCredentialStore = createLinearCredentialStore,
  createRunnerCredentialStore = createRunnerInboxCredentialStore,
  removeLocalFile = removeLocalState,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryDomain({ domain, config, repoRoot });
  if (!context) {
    log(`skipped: domain ${domain.id} has incomplete identity; npm run reset will remove local files`);
    return { ok: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, domainContext: context });
  const runnerCredentialStore = createRunnerCredentialStore({ config, repoRoot, domainContext: context });
  let ok = true;

  if (!context.linear.webhookId) {
    log(
      `could not remove domain ${domain.id} Linear webhook inbox registration: missing webhook_id in the domain registry; run npm run doctor and delete the webhook manually in Linear if needed.`,
    );
    return { ok: false, reason: "missing_webhook_id" };
  }

  try {
    const setupAuth = createSetupAuth({
      config,
      repoRoot,
      credentialStore,
      allowBrowserAuth: false,
      allowRefresh: true,
    });
    await removeLinearWebhookRegistration({
      linearClient: setupAuth.client,
      inboxClient,
      workspaceId: context.linear.workspaceId,
      teamId: context.linear.teamId,
      webhookId: context.linear.webhookId,
    });
    log(`removed: domain ${domain.id} Linear webhook inbox registration`);
  } catch (error) {
    log(`could not remove domain ${domain.id} Linear webhook inbox registration: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  try {
    await removeRunnerInboxCredential({
      inboxClient,
      credentialStore: runnerCredentialStore,
      workspaceId: context.linear.workspaceId,
    });
    log(`removed: domain ${domain.id} runner inbox credential`);
  } catch (error) {
    log(`could not remove domain ${domain.id} runner inbox credential: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  removeLocalFile(context.linear.cachePath, `domain ${domain.id} linear cache`, log);

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
  inboxClient,
  domain,
  removeDomainSetup = removeOneDomainSetup,
  createOAuthCredentialStore = createLinearCredentialStore,
  createRunnerCredentialStore = createRunnerInboxCredentialStore,
  log = (line) => console.log(line),
}) {
  const context = contextForRegistryDomain({ domain, config, repoRoot });
  if (!context) {
    log(`already clean: removed domain ${domain.id} has no complete Linear identity`);
    return { ok: true, alreadyClean: true };
  }

  const credentialStore = createOAuthCredentialStore({ config, repoRoot, domainContext: context });
  const runnerCredentialStore = createRunnerCredentialStore({ config, repoRoot, domainContext: context });
  let tokenSet = null;
  let runnerCredential = null;
  try {
    tokenSet = await credentialStore.readTokenSet?.();
    runnerCredential = await runnerCredentialStore.readCredential?.();
  } catch (error) {
    log(`could not verify removed domain ${domain.id} credentials: ${redactOAuthSecrets(error.message)}`);
    return { ok: false };
  }

  if (!tokenSet && !runnerCredential) {
    log(`already clean: removed domain ${domain.id} hosted credentials`);
    return { ok: true, alreadyClean: true };
  }

  log(`removed domain ${domain.id} still has local credentials; attempting hosted cleanup before reset.`);
  return removeDomainSetup({
    config,
    repoRoot,
    inboxClient,
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

function legacyCredentialStores({ config, repoRoot, inboxClient }) {
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
    {
      label: "legacy runner inbox credential",
      remove: async () =>
        removeRunnerInboxCredential({
          inboxClient,
          credentialStore: createRunnerInboxCredentialStore({
            config,
            repoRoot,
            target: legacyRunnerInboxCredentialTargetForConfig(config, repoRoot),
          }),
        }),
    },
  ];
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
