import { getResourceKind } from "./resource-registry.mjs";

export async function materialize(resource, runContext) {
  const { kind, handle, teardown } = await getResourceKind(resource.kind).materialize(resource, runContext);
  runContext.resources[resource.kind] = { id: resource.id, kind, role: resource.role, handle };
  runContext.resourceManifest.push(getResourceKind(resource.kind).manifestEntry(resource, handle));
  return { kind, handle, teardown };
}

export async function materializeDomainResources({
  domainResources = [],
  runId,
  engineRepoRoot,
  runGit,
}) {
  const runContext = { runId, engineRepoRoot, resources: {}, resourceManifest: [], runGit };
  const teardowns = [];
  let tornDown = false;

  async function teardownAll() {
    if (tornDown) return;
    tornDown = true;
    await runTeardowns(teardowns);
  }

  try {
    for (const resource of domainResources) {
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
