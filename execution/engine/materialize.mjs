import { getResourceKind } from "./resource-registry.mjs";

export async function materialize(resource, runContext) {
  const { kind, handle, teardown } = await getResourceKind(resource.kind).materialize(resource, runContext);
  const entry = { id: resource.id, kind, role: resource.role, handle };
  runContext.resources[resource.id] = entry;
  runContext.selectedResourceId = resource.id;
  runContext.selectedResource = entry;
  runContext.resourceManifest.push(getResourceKind(resource.kind).manifestEntry(resource, handle));
  return { kind, handle, teardown };
}

export async function materializeTeamResources({
  teamResources = [],
  runId,
  engineRepoRoot,
  runGit,
  issue = null,
  issueIdentifier = null,
  pendingGitIntent = null,
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
}) {
  const runContext = runContextWithExecutionFacts({
    runId,
    engineRepoRoot,
    runGit,
    issue,
    issueIdentifier,
    pendingGitIntent,
    gitRemoteUrlOverride,
    gitRemoteUrlOverrides,
    resolveGitRemoteUrl,
  });
  const teardowns = [];
  let tornDown = false;

  async function teardownAll() {
    if (tornDown) return;
    tornDown = true;
    await runTeardowns(teardowns);
  }

  try {
    for (const resource of teamResources) {
      const { teardown } = await materialize(resource, runContext);
      teardowns.push(teardown);
    }
  } catch (error) {
    try {
      await runTeardowns(teardowns);
    } catch {
      // Preserve the materialization failure as the caller-visible error.
    }
    throw error;
  }

  return { runContext, teardownAll };
}

export async function materializeRunContext({
  teamContext,
  teamResources = teamContext?.resources,
  runId,
  engineRepoRoot,
  runGit,
  issue = null,
  issueIdentifier = null,
  pendingGitIntent = null,
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
  materializeTeamResourcesFn = materializeTeamResources,
} = {}) {
  const resources = Array.isArray(teamResources) ? teamResources : [];
  if (resources.length === 0) {
    return {
      materialized: false,
      runContext: emptyRunContext({
        runId,
        engineRepoRoot,
        runGit,
        issue,
        issueIdentifier,
        pendingGitIntent,
        gitRemoteUrlOverride,
        gitRemoteUrlOverrides,
        resolveGitRemoteUrl,
      }),
      teardownAll: async () => {},
    };
  }

  const materialized = await materializeTeamResourcesFn({
    teamResources: resources,
    runId,
    engineRepoRoot,
    runGit,
    issue,
    issueIdentifier,
    pendingGitIntent,
    gitRemoteUrlOverride,
    gitRemoteUrlOverrides,
    resolveGitRemoteUrl,
  });
  return { ...materialized, materialized: true };
}

async function runTeardowns(teardowns) {
  const errors = [];
  for (let index = teardowns.length - 1; index >= 0; index -= 1) {
    try {
      await teardowns[index]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "resource_teardown_failed");
  }
}

function emptyRunContext({
  runId,
  engineRepoRoot,
  runGit,
  issue,
  issueIdentifier,
  pendingGitIntent,
  gitRemoteUrlOverride,
  gitRemoteUrlOverrides,
  resolveGitRemoteUrl,
} = {}) {
  return runContextWithExecutionFacts({
    runId,
    engineRepoRoot,
    runGit,
    issue,
    issueIdentifier,
    pendingGitIntent,
    gitRemoteUrlOverride,
    gitRemoteUrlOverrides,
    resolveGitRemoteUrl,
  });
}

function runContextWithExecutionFacts({
  runId,
  engineRepoRoot,
  runGit,
  issue,
  issueIdentifier,
  pendingGitIntent,
  gitRemoteUrlOverride,
  gitRemoteUrlOverrides,
  resolveGitRemoteUrl,
} = {}) {
  return {
    runId,
    engineRepoRoot,
    resources: {},
    selectedResourceId: null,
    selectedResource: null,
    resourceManifest: [],
    runGit,
    ...(issue && typeof issue === "object" ? { issue } : {}),
    ...(typeof issueIdentifier === "string" && issueIdentifier.trim() !== "" ? { issueIdentifier: issueIdentifier.trim() } : {}),
    ...(pendingGitIntent && typeof pendingGitIntent === "object" ? { pendingGitIntent } : {}),
    ...(typeof gitRemoteUrlOverride === "string" && gitRemoteUrlOverride.trim() !== ""
      ? { gitRemoteUrlOverride: gitRemoteUrlOverride.trim() }
      : {}),
    ...(gitRemoteUrlOverrides && typeof gitRemoteUrlOverrides === "object" ? { gitRemoteUrlOverrides } : {}),
    ...(typeof resolveGitRemoteUrl === "function" ? { resolveGitRemoteUrl } : {}),
  };
}
