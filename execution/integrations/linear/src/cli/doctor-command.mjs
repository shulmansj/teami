import fs from "node:fs";

import { readLinearCache } from "../cache.mjs";
import { formatRuntimeRoleAssignmentsSection } from "../config.mjs";
import { resolveForegroundDomainCache } from "../domain-command-context.mjs";
import { readDomainRegistry } from "../domain-registry.mjs";
import { githubConnectionDoctorChecks } from "../github-setup.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../linear-credential-store.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import {
  doctorDomainRegistryFromDisk,
  doctorLinear,
} from "../linear-service.mjs";
import { phoenixStatus } from "../local-phoenix-manager.mjs";
import { localSupervisorDoctorChecks } from "../local-supervisor.mjs";
import {
  createRunnerInboxCredentialStore,
  legacyRunnerInboxCredentialTargetForConfig,
} from "../runner-inbox-credential.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  runtimeSmokeDoctorChecks,
} from "../runtime-smoke.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { flagValue } from "./flags.mjs";
import { githubDoctorTransportFromConnection } from "./github-command-options.mjs";
export async function runDoctorCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output = createCliOutput() } = context;
    const checks = await doctorGraphqlLinear({
      config,
      repoRoot,
      inboxClient,
      cachePath,
      domainId: flagValue(args, "--domain"),
    });
    output.heading(`Agentic Factory ${output.symbols.separator} doctor`);
    printDoctorChecks(checks, output);
    for (const line of formatRuntimeRoleAssignmentsSection(config)) output.detail(line);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
export async function runDoctorLinearCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output = createCliOutput() } = context;
    const checks = await doctorGraphqlLinear({
      config,
      repoRoot,
      inboxClient,
      cachePath,
      domainId: flagValue(args, "--domain"),
      includeRunnerCredential: false,
      includeRuntimeSmoke: false,
      includePhoenix: false,
      includeGitHub: false,
      includeLocalSupervisor: false,
    });
    output.heading(`Agentic Factory ${output.symbols.separator} Linear doctor`);
    printDoctorChecks(checks, output);
    for (const line of formatRuntimeRoleAssignmentsSection(config)) output.detail(line);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
async function doctorGraphqlLinear({
  config,
  repoRoot,
  inboxClient,
  cachePath,
  domainId = null,
  includeRunnerCredential = true,
  includeRuntimeSmoke = true,
  includePhoenix = true,
  includeGitHub = true,
  includeLocalSupervisor = true,
  hostedWakeViewLoader = null,
}) {
  const domainDoctor = doctorDomainRegistryFromDisk({
    repoRoot,
    orphanHints: likelyDomainOrphans({ cachePath }),
  });
  if (!domainDoctor.registryAvailable) return domainDoctor.checks;

  const registry = readDomainRegistry({ repoRoot });
  const selectedDomains = domainId
    ? registry.domains.filter((domain) => domain.id === domainId)
    : registry.domains.filter((domain) => domain.status === "active");
  const checks = [{
    name: "domain registry",
    ok: domainDoctor.healthy,
    message: `${domainDoctor.checks.length} domain${domainDoctor.checks.length === 1 ? "" : "s"} configured`,
  }, ...domainDoctor.checks, ...doctorProductRepoBindingChecksForDomains(
    domainId ? registry.domains.filter((domain) => domain.id === domainId) : registry.domains,
  )];

  if (domainId && selectedDomains.length === 0) {
    checks.push({
      name: "domain selection",
      ok: false,
      message: `domain_not_found: ${domainId}`,
    });
    return checks;
  }

  const foregrounds = [];
  for (const domain of selectedDomains) {
    if (domain.status !== "active") continue;
    let foreground;
    try {
      foreground = resolveForegroundDomainCache({ config, repoRoot, registry, domainId: domain.id });
      foregrounds.push(foreground);
    } catch (error) {
      checks.push({
        name: `domain ${domain.id} selection`,
        ok: false,
        message: redactOAuthSecrets(error.message),
      });
      continue;
    }

    checks.push(...(await doctorLegacyCredentialTargets({
      config,
      repoRoot,
      context: foreground.context,
    })));
    checks.push(await doctorInboxSetupGrantConnection({
      inboxClient,
      context: foreground.context,
      domainId: domain.id,
    }));

    const credentialStore = createLinearCredentialStore({
      config,
      repoRoot,
      domainContext: foreground.context,
    });
    try {
      const setupAuth = createLinearSetupGraphqlClient({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      });
      const authResult = await setupAuth.client.verifyAuth();
      const doctor = await doctorLinear({ client: setupAuth.client, config: foreground.config, cache: foreground.cache });
      checks.push({
        name: `domain ${domain.id} Linear setup OAuth`,
        ok: true,
        message: `GraphQL auth verified for viewer ${authResult.viewerId}`,
      }, ...doctor.checks.map((check) => ({
        ...check,
        name: `domain ${domain.id} ${check.name}`,
      })));
      checks.push(await doctorLinearWebhookAdminPermission(setupAuth.client, domain.id));

      if (includeRunnerCredential) {
        checks.push(...(await doctorRunnerInboxCredential({
          runnerCredentialStore: createRunnerInboxCredentialStore({
            config,
            repoRoot,
            domainContext: foreground.context,
          }),
          inboxClient,
          cache: foreground.cache,
          domainId: domain.id,
        })));
      }
    } catch (error) {
      checks.push({
        name: `domain ${domain.id} Linear setup OAuth`,
        ok: false,
        message: redactOAuthSecrets(error.message),
      });
    }
  }

  if (includeRuntimeSmoke) {
    checks.push(...(await runtimeSmokeDoctorChecks({
      config,
      cache: readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot)),
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
      githubDoctorTransport = githubDoctorTransportFromConnection({ repoRoot, config });
    } catch {
      // githubConnectionDoctorChecks will fail closed for real connections
      // without a live transport instead of reporting dry-run checks as true.
      githubDoctorTransport = null;
    }
    checks.push(...(await githubConnectionDoctorChecks({ repoRoot, config, transport: githubDoctorTransport })));
  }
  if (includeLocalSupervisor) {
    const supervisorForeground = foregrounds.length === 1 ? foregrounds[0] : null;
    checks.push(...(await localSupervisorDoctorChecks({
      repoRoot,
      config: supervisorForeground?.config || config,
      cachePath: supervisorForeground?.context?.linear?.cachePath || cachePath,
      runnerCredentialStore: supervisorForeground
        ? createRunnerInboxCredentialStore({
            config,
            repoRoot,
            domainContext: supervisorForeground.context,
          })
        : createRunnerInboxCredentialStore({
            config,
            repoRoot,
            target: legacyRunnerInboxCredentialTargetForConfig(config, repoRoot),
          }),
      hostedWakeViewLoader,
    })));
  }
  return checks;
}

async function ensureWebhookAdminAuthorization({
  setupAuth,
  config,
  repoRoot,
  credentialStore,
  verifyWorkspaceGrant = null,
  onProgress = (line) => console.log(line),
}) {
  try {
    await setupAuth.client.listWebhooks({ teamId: null });
    return setupAuth;
  } catch (error) {
    if (!isMissingLinearAdminPermission(error)) throw error;
    onProgress(
      "Existing Linear authorization is missing admin permission required for webhook registration. Reauthorizing in the browser...",
    );
    await setupAuth.tokenProvider.clear();
    const reauthorized = createLinearSetupGraphqlClient({
      config,
      repoRoot,
      credentialStore,
      allowBrowserAuth: true,
      allowRefresh: true,
      deferTokenPersistence: true,
      onProgress,
    });
    const workspace = verifyWorkspaceGrant ? await verifyWorkspaceGrant(reauthorized) : null;
    await reauthorized.client.listWebhooks({ teamId: null });
    return { setupAuth: reauthorized, workspace };
  }
}

function doctorProductRepoBindingChecksForDomains(domains = []) {
  return domains.map((domain) => ({
    name: `domain ${domain.id} product repo binding`,
    ok: true,
    message: formatProductRepoBindingReadout(domain),
    showMessage: true,
  }));
}

function formatProductRepoBindingReadout(domain) {
  const prefix = `domain=${formatDomainReadoutName(domain)}; linear_team=${formatLinearTeam(domain.linear)}`;
  const gitRepo = domain.resources.find((resource) => resource.kind === "git_repo");
  if (!gitRepo) {
    return `${prefix}; no product repo bound (domain:bind-repo binds product repos; behavior repo GitHub setup remains separate config.github)`;
  }
  const binding = gitRepo.binding;
  return (
    `${prefix}; product repo local_checkout_path=${binding.local_checkout_path}; ` +
    `remote=${binding.owner}/${binding.repo}; default_branch=${binding.default_branch}; ` +
    "bound_by=domain:bind-repo; behavior repo GitHub setup remains separate config.github"
  );
}

export function doctorProductRepoBindingChecks({
  repoRoot = process.cwd(),
  domainId = null,
} = {}) {
  const registry = readDomainRegistry({ repoRoot });
  if (!registry) return [];
  const domains = domainId
    ? registry.domains.filter((domain) => domain.id === domainId)
    : registry.domains;
  return doctorProductRepoBindingChecksForDomains(domains);
}

function formatDomainReadoutName(domain) {
  if (isNonEmptyString(domain.adopter_provided_name) && domain.adopter_provided_name !== domain.id) {
    return `${domain.adopter_provided_name} (${domain.id})`;
  }
  return domain.id;
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

async function doctorLinearWebhookAdminPermission(client, domainId = null) {
  try {
    await client.listWebhooks({ teamId: null });
    return {
      name: domainId ? `domain ${domainId} Linear webhook admin permission` : "Linear webhook admin permission",
      ok: true,
      message: "can read webhook registrations",
    };
  } catch (error) {
    return {
      name: domainId ? `domain ${domainId} Linear webhook admin permission` : "Linear webhook admin permission",
      ok: false,
      message: isMissingLinearAdminPermission(error)
        ? "missing admin permission; rerun npm run init and approve the updated Linear grant"
        : redactOAuthSecrets(error.message),
    };
  }
}

function isMissingLinearAdminPermission(error) {
  return /admin required|Invalid role/i.test(error?.message || "");
}

async function doctorLegacyCredentialTargets({ config, repoRoot, context }) {
  const checks = [];
  const legacyOAuthStore = createLinearCredentialStore({
    config,
    repoRoot,
    target: legacyCredentialTargetForConfig(config, repoRoot),
  });
  const legacyRunnerStore = createRunnerInboxCredentialStore({
    config,
    repoRoot,
    target: legacyRunnerInboxCredentialTargetForConfig(config, repoRoot),
  });

  try {
    const tokenSet = await legacyOAuthStore.readTokenSet();
    checks.push({
      name: `domain ${context.domainId} legacy Linear OAuth credential target`,
      ok: !tokenSet,
      message: tokenSet
        ? `legacy pre-domain target found for workspace=${context.linear.workspaceId}; rerun npm run init -- --domain ${context.domainId} or npm run reset`
        : "no legacy pre-domain target found",
    });
  } catch (error) {
    checks.push({
      name: `domain ${context.domainId} legacy Linear OAuth credential target`,
      ok: false,
      message: redactOAuthSecrets(error.message),
    });
  }

  try {
    const credential = await legacyRunnerStore.readCredential();
    checks.push({
      name: `domain ${context.domainId} legacy runner credential target`,
      ok: !credential,
      message: credential
        ? `legacy pre-domain target found for workspace=${context.linear.workspaceId}; rerun npm run init -- --domain ${context.domainId} or npm run reset`
        : "no legacy pre-domain target found",
    });
  } catch (error) {
    checks.push({
      name: `domain ${context.domainId} legacy runner credential target`,
      ok: false,
      message: redactOAuthSecrets(error.message),
    });
  }

  return checks;
}

async function doctorRunnerInboxCredential({ runnerCredentialStore, inboxClient, cache, domainId = null }) {
  try {
    const credential = await runnerCredentialStore.readCredential();
    if (!credential) {
      return [{ name: domainCheckName(domainId, "runner inbox credential"), ok: false, message: "missing; run npm run init" }];
    }
    const verification = await inboxClient.verifyRunnerCredential({
      workspaceId: cache?.workspaceId || credential.workspaceId,
      credentialId: credential.credentialId,
      token: credential.token,
    });
    return [{
      name: domainCheckName(domainId, "runner inbox credential"),
      ok: verification?.ok === true,
      message: verification?.ok === true ? `verified ${credential.credentialId}` : "hosted inbox rejected credential",
    }];
  } catch (error) {
    return [{ name: domainCheckName(domainId, "runner inbox credential"), ok: false, message: redactOAuthSecrets(error.message) }];
  }
}

async function doctorInboxSetupGrantConnection({ inboxClient, context, domainId = null } = {}) {
  const name = domainCheckName(domainId, "Connection");
  const workspaceId = context?.linear?.workspaceId;
  const teamId = context?.linear?.teamId;
  const repair = setupGrantSelfServeRepair();
  if (!workspaceId || !teamId) {
    return {
      name,
      ok: false,
      message: `missing local workspace/team identity; ${repair}`,
    };
  }
  if (typeof inboxClient?.setupGrantStatus !== "function") {
    return {
      name,
      ok: false,
      message: `hosted inbox cannot report setup grant status; ${repair}`,
    };
  }
  try {
    const status = await inboxClient.setupGrantStatus({ workspaceId, teamId });
    if (status?.ok === false) {
      return {
        name,
        ok: false,
        message: `${status.reason || status.error || "missing"}; ${repair}`,
      };
    }
    const state = setupGrantStatusValue(status);
    if (state === "provisional") {
      return {
        name,
        ok: true,
        message: "waiting for your first Planned project (not yet active)",
      };
    }
    if (state === "confirmed") {
      return {
        name,
        ok: true,
        message: `active (confirmed ${setupGrantConfirmedAt(status) || "unknown"})`,
      };
    }
    return {
      name,
      ok: false,
      message: `${state || "missing"}; ${repair}`,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      message: `${redactOAuthSecrets(error.message)}; ${repair}`,
    };
  }
}

function setupGrantSelfServeRepair() {
  return "rerun npm run init. If it still fails, create a diagnostic export for support; support cannot recover credentials or operate this factory for you";
}

function setupGrantStatusValue(payload = {}) {
  return payload.status || payload.grant?.status || payload.setupGrant?.status || payload.setup_grant?.status || null;
}

function setupGrantConfirmedAt(payload = {}) {
  return (
    payload.confirmedAt ||
    payload.confirmed_at ||
    payload.grant?.confirmedAt ||
    payload.grant?.confirmed_at ||
    payload.setupGrant?.confirmedAt ||
    payload.setupGrant?.confirmed_at ||
    payload.setup_grant?.confirmedAt ||
    payload.setup_grant?.confirmed_at ||
    null
  );
}

function domainCheckName(domainId, name) {
  return domainId ? `domain ${domainId} ${name}` : name;
}

function likelyDomainOrphans({ cachePath } = {}) {
  const hints = [];
  if (cachePath && fs.existsSync(cachePath)) {
    hints.push(`legacy Linear cache ${cachePath}`);
    try {
      const cache = readLinearCache(cachePath);
      if (cache?.workspaceId) hints.push(`cached workspace ${cache.workspaceId}`);
      const webhookId = cache?.inbox?.linearWebhook?.id || cache?.webhook?.id;
      if (webhookId) hints.push(`cached webhook ${webhookId}`);
      if (cache?.inbox?.runnerCredentialId) {
        hints.push(`cached runner credential ${cache.inbox.runnerCredentialId}`);
      }
    } catch (error) {
      hints.push(`unreadable legacy cache (${error.message})`);
    }
  }
  return hints;
}

function printDoctorChecks(checks, output) {
  for (const check of checks) {
    const message = defaultDoctorMessage(check);
    const line = message ? `${check.name}: ${message}` : check.name;
    if (check.ok) {
      output.success(line);
    } else {
      output.error({ what: line });
    }
    if (check.message && !check.showMessage) output.detail(`${check.name}: ${check.message}`);
  }
}

function defaultDoctorMessage(check) {
  if (check.showMessage) return String(check.message || "");
  if (check.ok) return "";
  return compactDoctorDetail(check.message);
}

function compactDoctorDetail(message) {
  return String(message || "")
    .replace(/[A-Za-z]:\\[^\s;,)]+/g, "[path]")
    .replace(/(?:^|\s)\/[^\s;,)]+/g, " [path]")
    .replace(/https?:\/\/[^\s;,)]+/g, "[url]")
    .replace(/\b[0-9a-f]{12,}\b/gi, "[id]")
    .trim();
}

export {
  doctorInboxSetupGrantConnection,
  doctorGraphqlLinear,
  doctorLinearWebhookAdminPermission,
  ensureWebhookAdminAuthorization,
};
