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
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  runtimeSmokeDoctorChecks,
} from "../runtime-smoke.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { flagValue } from "./flags.mjs";
import { githubDoctorTransportFromConnection } from "./github-command-options.mjs";
export async function runDoctorCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, output = createCliOutput() } = context;
  const checks = await doctorGraphqlLinear({
    config,
    repoRoot,
    cachePath,
    domainId: flagValue(args, "--domain"),
  });
  output.heading(`Agentic Factory ${output.symbols.separator} doctor`);
  printDoctorChecks(checks, output);
  for (const line of formatRuntimeRoleAssignmentsSection(config)) output.detail(line);
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
export async function runDoctorLinearCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, output = createCliOutput() } = context;
  const checks = await doctorGraphqlLinear({
    config,
    repoRoot,
    cachePath,
    domainId: flagValue(args, "--domain"),
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
  cachePath,
  domainId = null,
  includeRuntimeSmoke = true,
  includePhoenix = true,
  includeGitHub = true,
  includeLocalSupervisor = true,
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
      const teamCheck = doctor.checks.find((check) => check.name === "team");
      checks.push({
        name: `domain ${domain.id} Linear setup OAuth`,
        ok: true,
        message: `GraphQL auth verified for viewer ${authResult.viewerId}`,
      }, {
        name: `domain ${domain.id} Linear team visibility`,
        ok: teamCheck?.ok === true,
        message: teamCheck?.ok === true
          ? `can see team ${foreground.config.linear.team.key}`
          : teamCheck?.message || `team ${foreground.config.linear.team.key} not visible`,
      }, ...doctor.checks.map((check) => ({
        ...check,
        name: `domain ${domain.id} ${check.name}`,
      })));
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
    })));
  }
  return checks;
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

async function doctorLegacyCredentialTargets({ config, repoRoot, context }) {
  const checks = [];
  const legacyOAuthStore = createLinearCredentialStore({
    config,
    repoRoot,
    target: legacyCredentialTargetForConfig(config, repoRoot),
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

  return checks;
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
  doctorGraphqlLinear,
};
