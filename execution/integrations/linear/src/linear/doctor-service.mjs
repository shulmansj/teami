import {
  doctorCheck,
} from "../doctor-check.mjs";
import {
  domainRegistryPath,
  readDomainRegistry,
  validateDomainRegistry,
} from "../domain-registry.mjs";
import {
  check,
  issueLabelNames,
  projectLabelNames,
  resultFromMatches,
  validateCache,
} from "./matching-utils.mjs";
import {
  PROJECT_NEEDS_PRINCIPAL_REPAIR_COPY,
  needsPrincipalProjectStatusRepairError,
  resolveProjectStatusMappings,
} from "./shape-resolver.mjs";
import { repairPathForSetupIncompleteCause } from "./setup-service.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
} from "../execution-pr-adapter.mjs";
import { resolveTeamiHome } from "../app-home.mjs";

export const MERGE_PATH_DONE_CHECK_NAME = "merge path Done status";
export const MERGE_PATH_AF_REVIEW_CHECK_NAME = "merge path af-review context";
export const MERGE_PATH_GITHUB_CHECK_NAME = "merge path GitHub PR API";
const APP_IDENTITY_REAUTH_FIX = "npm run init";
const APP_IDENTITY_REAUTH_SENTENCE = "re-run `npm run init` to re-authorize as the app";
const ISSUE_STATUS_REPAIR_FIX = "npm run init";
const ISSUE_STATUS_REPAIR_SENTENCE = "re-run `npm run init` to provision Linear issue statuses and refresh the cache";

const PROJECT_STATUS_ROLES = Object.freeze(["backlog", "planned", "in_progress", "completed", "needs_principal"]);
const PROJECT_NEEDS_PRINCIPAL_ROLE = "needs_principal";
const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);

export async function doctorLinear({ client, config, cache = null } = {}) {
  const checks = [];
  let authResult = null;

  await check("auth", checks, async () => {
    authResult = await verifyAppIdentity(client);
  });

  if (cache) {
    checks.push(appIdentityDoctorCheck({ cache, authResult }));
  }

  const teams = await client.listTeams();
  const matchingTeams = teams.filter((team) => team.key === config.linear.team.key);
  checks.push(resultFromMatches("team", matchingTeams, config.linear.team.key));
  const team = matchingTeams[0];

  for (const labelName of projectLabelNames(config)) {
    if (cache) {
      await check(`project label ${labelName}`, checks, async () => {
        await verifyCachedProjectLabel({ client, cache, labelName });
      });
    } else {
      const labels = await client.findProjectLabelsByName(labelName);
      checks.push(resultFromMatches(`project label ${labelName}`, labels, labelName));
    }
  }

  for (const labelName of issueLabelNames(config)) {
    if (cache) {
      await check(`issue label ${labelName}`, checks, async () => {
        await verifyCachedIssueLabel({ client, cache, labelName, teamId: team?.id || cache.teamId });
      });
    } else {
      const labels = await client.findIssueLabelsByName(labelName, team?.id);
      checks.push(resultFromMatches(`issue label ${labelName}`, labels, labelName));
    }
  }

  await doctorProjectStatusMappingsCheck({ client, config, cache, checks });

  if (cache) {
    checks.push(...(await validateCache(client, cache)));
  }

  if (team) {
    checks.push(await doctorIssueStatusMappingsCheck({ client, config, teamId: team.id, cache }));
    checks.push(await doctorMergePathDoneCheck({ client, config, team, cache }));
    checks.push(doctorMergePathAfReviewCheck());
  }

  return {
    healthy: checks.every((checkResult) => checkResult.ok),
    checks,
  };
}

async function verifyAppIdentity(client) {
  if (typeof client?.verifyAuth !== "function") {
    throw new Error("Linear client cannot verify app-authored OAuth identity.");
  }
  const result = await client.verifyAuth();
  if (typeof result?.viewerId !== "string" || result.viewerId.trim() === "") {
    throw new Error("Linear GraphQL auth verification did not return a viewer id.");
  }
  return {
    viewerId: result.viewerId.trim(),
    viewerName: typeof result.viewerName === "string" && result.viewerName.trim() !== ""
      ? result.viewerName.trim()
      : null,
  };
}

function appIdentityDoctorCheck({ cache, authResult } = {}) {
  try {
    verifyCachedAppIdentity({ cache, authResult });
    const display = cache.app_identity_name
      ? `${cache.app_identity_name} (${cache.app_identity_id})`
      : cache.app_identity_id;
    return { name: "app identity", ok: true, message: `cached ${display}` };
  } catch (error) {
    return doctorCheck({
      name: "app identity",
      state: "fail",
      message: error.message,
      fix: APP_IDENTITY_REAUTH_FIX,
    });
  }
}

function verifyCachedAppIdentity({ cache, authResult } = {}) {
  const cachedId = typeof cache?.app_identity_id === "string" ? cache.app_identity_id.trim() : "";
  if (!cachedId) {
    throw new Error(`Cached Linear app identity is missing; ${APP_IDENTITY_REAUTH_SENTENCE}.`);
  }
  const liveId = typeof authResult?.viewerId === "string" ? authResult.viewerId.trim() : "";
  if (!liveId) {
    throw new Error(`Live Linear app identity could not be verified; ${APP_IDENTITY_REAUTH_SENTENCE}.`);
  }
  if (liveId !== cachedId) {
    throw new Error(
      `Cached Linear app identity ${cachedId} does not match live viewer ${liveId}; ${APP_IDENTITY_REAUTH_SENTENCE}.`,
    );
  }
}

async function verifyCachedProjectStatusMappings({ client, config, cache }) {
  const statuses = await client.listProjectStatuses();
  for (const role of PROJECT_STATUS_ROLES) {
    const configuredStatus = config?.linear?.project?.statuses?.[role];
    if (!configuredStatus) {
      throw new Error(`Linear project status role ${role} is not configured.`);
    }
    const cachedId = cache?.projectStatuses?.[role];
    if (!cachedId) {
      throw new Error(`Cached Linear project status ${role} is missing.`);
    }
    if (role === PROJECT_NEEDS_PRINCIPAL_ROLE) {
      const matches = statuses.filter((candidate) => candidate.id === cachedId);
      if (matches.length === 0) {
        throw needsPrincipalProjectStatusRepairError(
          `Cached Linear project status ${role}=${cachedId} no longer exists.`,
        );
      }
      const status = uniqueCachedEntity(matches, `Linear project status ${role}`, cachedId);
      if (isArchivedLinearEntity(status)) {
        throw needsPrincipalProjectStatusRepairError(
          `Cached Linear project status ${role}=${cachedId} no longer exists.`,
        );
      }
      if (status.type !== configuredStatus.type) {
        throw needsPrincipalProjectStatusRepairError(
          `Cached Linear project status ${role} has type ${status.type}, expected ${configuredStatus.type}.`,
        );
      }
      continue;
    }
    const status = uniqueCachedEntity(
      statuses.filter((candidate) => candidate.id === cachedId),
      `Linear project status ${role}`,
      cachedId,
    );
    if (status.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear project status ${role} has type ${status.type}, expected ${configuredStatus.type}.`,
      );
    }
  }
}

async function doctorProjectStatusMappingsCheck({ client, config, cache, checks }) {
  try {
    if (cache) {
      await verifyCachedProjectStatusMappings({ client, config, cache });
    } else {
      await resolveProjectStatusMappings({ client, config, cache, failClosed: true });
    }
    checks.push({ name: "project status mappings", ok: true, message: "ok" });
  } catch (error) {
    checks.push({
      name: "project status mappings",
      ok: false,
      message:
        error?.code === "PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR"
          ? PROJECT_NEEDS_PRINCIPAL_REPAIR_COPY
          : error.message,
    });
  }
}

async function verifyIssueStatusMappings({ client, config, teamId, cache }) {
  const states = await client.listWorkflowStates?.(teamId);
  if (!states) {
    throw new Error("Cannot resolve Linear issue statuses: client cannot list workflow states.");
  }

  for (const role of ISSUE_STATUS_ROLES) {
    const configuredStatus = config?.linear?.issue?.statuses?.[role];
    if (!configuredStatus) {
      throw new Error(`Linear issue status role ${role} is not configured.`);
    }

    if (!cache) {
      const matches = states.filter((state) => state.name === configuredStatus.name);
      if (matches.length !== 1) {
        throw new Error(
          `Cannot resolve issue status mapping '${role}' by configured name '${configuredStatus.name}': found ${matches.length}.`,
        );
      }
      if (matches[0].type !== configuredStatus.type) {
        throw new Error(
          `Configured Linear issue status ${role} has type ${matches[0].type}, expected ${configuredStatus.type}.`,
        );
      }
      continue;
    }

    const cachedId = cache?.issueStatuses?.[role];
    if (!cachedId) {
      throw new Error(`Cached Linear issue status ${role} is missing.`);
    }
    const state = uniqueCachedEntity(
      states.filter((candidate) => candidate.id === cachedId),
      `Linear issue status ${role}`,
      cachedId,
    );
    if (state.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear issue status ${role} has type ${state.type}, expected ${configuredStatus.type}.`,
      );
    }
  }
}

async function doctorIssueStatusMappingsCheck({ client, config, teamId, cache }) {
  try {
    await verifyIssueStatusMappings({ client, config, teamId, cache });
    return { name: "issue status mappings", ok: true, message: "ok" };
  } catch (error) {
    return doctorCheck({
      name: "issue status mappings",
      state: "fail",
      message: `${error.message}; ${ISSUE_STATUS_REPAIR_SENTENCE}.`,
      fix: ISSUE_STATUS_REPAIR_FIX,
    });
  }
}

async function verifyCachedProjectLabel({ client, cache, labelName }) {
  const cachedId = cache?.projectLabels?.[labelName];
  if (!cachedId) {
    throw new Error(`Cached Linear project label ${labelName} is missing.`);
  }
  const labels = await client.findProjectLabelsByName(null);
  uniqueCachedEntity(
    labels.filter((candidate) => candidate.id === cachedId),
    `Linear project label ${labelName}`,
    cachedId,
  );
}

async function verifyCachedIssueLabel({ client, cache, labelName, teamId }) {
  const cachedId = cache?.issueLabels?.[labelName];
  if (!cachedId) {
    throw new Error(`Cached Linear issue label ${labelName} is missing.`);
  }
  const labels = await client.findIssueLabelsByName(null, teamId);
  uniqueCachedEntity(
    labels.filter((candidate) => candidate.id === cachedId),
    `Linear issue label ${labelName}`,
    cachedId,
  );
}

function uniqueCachedEntity(matches, label, id) {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`Cached ${label}=${id} no longer exists.`);
  }
  throw new Error(`Cached ${label}=${id} is ambiguous: found ${matches.length}.`);
}

function isArchivedLinearEntity(entity) {
  return entity?.archived === true || entity?.archivedAt;
}

export async function doctorMergePathDoneCheck({ client, config, team, cache } = {}) {
  try {
    const state = await resolveDoneWorkflowState({ client, config, team, cache });
    return {
      name: MERGE_PATH_DONE_CHECK_NAME,
      ok: true,
      message: `Done resolves to ${formatWorkflowState(state)} by cached issue status id.`,
    };
  } catch (error) {
    return {
      name: MERGE_PATH_DONE_CHECK_NAME,
      ok: false,
      message: error.message,
      fix: "npm run init",
    };
  }
}

export function doctorMergePathAfReviewCheck({ context = AF_REVIEW_STATUS_CONTEXT } = {}) {
  if (context !== AF_REVIEW_STATUS_CONTEXT) {
    return {
      name: MERGE_PATH_AF_REVIEW_CHECK_NAME,
      ok: false,
      message: `merge path review status context is ${context || "missing"}, expected ${AF_REVIEW_STATUS_CONTEXT}.`,
    };
  }
  return {
    name: MERGE_PATH_AF_REVIEW_CHECK_NAME,
    ok: true,
    message: `merge path reads and writes the shared GitHub commit status context ${AF_REVIEW_STATUS_CONTEXT}.`,
  };
}

export async function doctorMergePathGitHubCheck({
  prAdapter = null,
  createPrAdapter = null,
  repoIdentity = null,
  repoIdentityError = null,
} = {}) {
  if (!repoIdentity) {
    const missingReason = repoIdentityError || "no git_repo resource is bound to this domain";
    return doctorCheck({
      name: MERGE_PATH_GITHUB_CHECK_NAME,
      state: "warn",
      message: `${missingReason}; no code merge path is checkable for this domain.`,
    });
  }

  let adapter;
  try {
    adapter = await resolveDoctorPrAdapter({ prAdapter, createPrAdapter, repoIdentity });
    for (const method of ["probePullRequest", "getCommitStatuses", "mergePullRequest"]) {
      if (typeof adapter?.[method] !== "function") {
        throw new Error(`execution PR adapter is missing ${method}`);
      }
    }
  } catch (error) {
    return {
      name: MERGE_PATH_GITHUB_CHECK_NAME,
      ok: false,
      message: `GitHub PR adapter unavailable for ${formatRepoIdentity(repoIdentity)}: ${error.message}.`,
      fix: "repair local GitHub auth or the domain repo binding, then re-run npm run doctor",
    };
  }

  try {
    await adapter.probePullRequest({
      head: "af/execution/doctor-merge-path",
      base: repoIdentity.default_branch,
    });
    return {
      name: MERGE_PATH_GITHUB_CHECK_NAME,
      ok: true,
      message:
        `GitHub PR API reachable for ${formatRepoIdentity(repoIdentity)}; merge endpoint is configured. ` +
        "Merge permission is proven at the first real merge.",
    };
  } catch (error) {
    return {
      name: MERGE_PATH_GITHUB_CHECK_NAME,
      ok: false,
      message:
        `GitHub PR API was not reachable for ${formatRepoIdentity(repoIdentity)}: ${error.message}. ` +
        "Merge permission is proven at the first real merge.",
      fix: "repair local GitHub auth or the domain repo binding, then re-run npm run doctor",
    };
  }
}

async function resolveDoneWorkflowState({ client, config, team, cache } = {}) {
  if (typeof client?.listWorkflowStates !== "function") {
    throw new Error("Cannot resolve merge path Done status: client cannot list workflow states.");
  }
  const teamId = team?.id || cache?.teamId;
  if (!teamId) {
    throw new Error("Cannot resolve merge path Done status: team id is missing.");
  }
  const configuredStatus = config?.linear?.issue?.statuses?.done;
  if (!configuredStatus) {
    throw new Error("Linear issue status role done is not configured.");
  }
  const states = await client.listWorkflowStates(teamId);
  if (!Array.isArray(states)) {
    throw new Error("Cannot resolve merge path Done status: workflow states were not returned.");
  }

  let state;
  if (cache) {
    const cachedId = cache?.issueStatuses?.done;
    if (!cachedId) {
      throw new Error("Cached Linear issue status done is missing.");
    }
    state = uniqueCachedEntity(
      states.filter((candidate) => candidate.id === cachedId),
      "Linear issue status done",
      cachedId,
    );
  } else {
    const matches = states.filter((candidate) => candidate.name === configuredStatus.name);
    if (matches.length !== 1) {
      throw new Error(
        `Cannot resolve merge path Done status by configured name '${configuredStatus.name}': found ${matches.length}.`,
      );
    }
    state = matches[0];
  }

  if (state.type !== configuredStatus.type || state.type !== "completed") {
    throw new Error(
      `Merge path Done status resolves to ${formatWorkflowState(state)}, expected ${configuredStatus.name} (completed).`,
    );
  }
  return state;
}

async function resolveDoctorPrAdapter({ prAdapter, createPrAdapter, repoIdentity } = {}) {
  if (typeof prAdapter === "function") return prAdapter({ repoIdentity });
  if (prAdapter && typeof prAdapter === "object") return prAdapter;
  if (typeof createPrAdapter === "function") return createPrAdapter({ repoIdentity });
  throw new Error("execution PR adapter was not provided");
}

function formatRepoIdentity(repoIdentity = {}) {
  const owner = repoIdentity.owner || "unknown";
  const repo = repoIdentity.repo || "unknown";
  const branch = repoIdentity.default_branch || "unknown";
  return `${owner}/${repo}@${branch}`;
}

function formatWorkflowState(state) {
  if (!state) return "no workflow state";
  const name = state.name || state.id || "unknown";
  return state.type ? `${name} (${state.type})` : name;
}

export function doctorDomainRegistryFromDisk({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  orphanHints = [],
} = {}) {
  void repoRoot;
  try {
    const registry = readDomainRegistry({ home });
    if (!registry) {
      return doctorDomainRegistry({
        registryError: new Error(`Domain registry not found: ${domainRegistryPath(home)}`),
        orphanHints,
      });
    }
    return doctorDomainRegistry({ registry, orphanHints });
  } catch (error) {
    return doctorDomainRegistry({ registryError: error, orphanHints });
  }
}

export function doctorDomainRegistry({ registry = null, registryError = null, orphanHints = [] } = {}) {
  if (registryError) {
    const orphanText = orphanHints.length > 0
      ? ` Likely orphaned local state: ${orphanHints.join("; ")}.`
      : " No specific orphaned local state was found in this pass.";
    return {
      healthy: false,
      registryAvailable: false,
      checks: [{
        name: "domain registry",
        ok: false,
        message:
          `${registryError.message}.${orphanText} Run npm run reset to remove local setup state; no domain was inferred from names.`,
      }],
    };
  }

  validateDomainRegistry(registry);
  const checks = registry.domains.map((domain) => {
    if (domain.status === "setup_incomplete") {
      const cause = domain.setup_incomplete_cause || "setup_incomplete";
      return {
        name: `domain ${domain.id}`,
        ok: false,
        message: `${cause}; ${repairPathForSetupIncompleteCause(cause)}`,
        fix: repairPathForSetupIncompleteCause(cause),
      };
    }
    return {
      name: `domain ${domain.id}`,
      ok: domain.status === "active",
      message:
        `${domain.status}; workspace=${domain.linear.workspace_id || "missing"}; ` +
        `team=${domain.linear.team_id || "missing"} ${domain.linear.team_key || ""} ${domain.linear.team_name || ""}; ` +
        `webhook=${domain.linear.webhook_id || "missing"}; cache=${domain.linear.cache_path}`,
    };
  });
  return {
    healthy: checks.every((check) => check.ok),
    registryAvailable: true,
    checks,
  };
}
