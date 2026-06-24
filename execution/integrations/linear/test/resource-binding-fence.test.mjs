import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  materializeDomainResources,
} from "../../../engine/materialize.mjs";
import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  DUMMY_VALUE,
  dummyResourceKind,
  registerDummyResourceKind,
} from "./dummy-resource-kind.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RESOURCE_A_ID = "resource-a";
const RESOURCE_B_ID = "resource-b";

test("materialized run contexts expose only the selected domain resource by id", async () => {
  await withMaterializedDummyDomains(async ({ domainA, domainB, runContextA, runContextB }) => {
    const resourceA = domainA.resources[0];
    const resourceB = domainB.resources[0];

    assertRunContextContainsOnly({
      runContext: runContextA,
      expectedResource: resourceA,
      absentResource: resourceB,
    });
    assertRunContextContainsOnly({
      runContext: runContextB,
      expectedResource: resourceB,
      absentResource: resourceA,
    });

    assert.equal(
      Object.values(runContextA.resources).some((record) => record.handle === runContextB.resources.dummy.handle),
      false,
    );
    assert.equal(
      Object.values(runContextB.resources).some((record) => record.handle === runContextA.resources.dummy.handle),
      false,
    );
  });
});

test("commit effects derive write targets from the bound resource record, not agent-authored output", async () => {
  await withMaterializedDummyDomains(async ({ runContextA }) => {
    const recordedTargets = [];
    const ctx = {
      resources: runContextA.resources,
      payload: {
        target: RESOURCE_B_ID,
        terminal_output: `agent requested target ${RESOURCE_B_ID}`,
      },
      artifact: {
        target: RESOURCE_B_ID,
        payload: { target: RESOURCE_B_ID },
      },
    };

    const result = await applyCommitEffects({
      ctx,
      effects: [{
        id: "bind-target",
        probe: () => ({ satisfied: false }),
        apply(receivedCtx) {
          assert.equal(receivedCtx, ctx);
          assert.equal(receivedCtx.payload.target, RESOURCE_B_ID);
          assert.equal(receivedCtx.artifact.payload.target, RESOURCE_B_ID);

          const bound = receivedCtx.resources.dummy;
          if (!bound) {
            return { ok: false, reason: "bound_dummy_missing" };
          }

          const target = bound.id;
          recordedTargets.push(target);
          return { ok: true, identity: target };
        },
        verify: () => ({ ok: true }),
      }],
    });

    assert.deepEqual(result, {
      ok: true,
      applied: [{ id: "bind-target", identity: RESOURCE_A_ID }],
    });
    assert.deepEqual(recordedTargets, [RESOURCE_A_ID]);
    assert.notEqual(recordedTargets[0], ctx.payload.target);
    assert.notEqual(result.applied[0].identity, ctx.artifact.payload.target);
  });
});

async function withMaterializedDummyDomains(assertions) {
  resetResourceRegistry();
  let teardownAllA = async () => {};
  let teardownAllB = async () => {};

  try {
    registerDummyResourceKind();
    const domainA = dummyDomain("domain-a", RESOURCE_A_ID);
    const domainB = dummyDomain("domain-b", RESOURCE_B_ID);

    const materializedA = await materializeDomainResources({
      domainResources: domainA.resources,
      runId: "run-a",
      engineRepoRoot: REPO_ROOT,
    });
    teardownAllA = materializedA.teardownAll;

    const materializedB = await materializeDomainResources({
      domainResources: domainB.resources,
      runId: "run-b",
      engineRepoRoot: REPO_ROOT,
    });
    teardownAllB = materializedB.teardownAll;

    await assertions({
      domainA,
      domainB,
      runContextA: materializedA.runContext,
      runContextB: materializedB.runContext,
    });
  } finally {
    await Promise.allSettled([teardownAllA(), teardownAllB()]);
    resetResourceRegistry();
  }
}

function dummyDomain(domainId, resourceId) {
  return {
    domainId,
    resources: [{
      id: resourceId,
      kind: dummyResourceKind.kind,
      role: "primary",
      binding: { fixture: resourceId },
    }],
  };
}

function assertRunContextContainsOnly({ runContext, expectedResource, absentResource }) {
  const resourceRecords = Object.values(runContext.resources);
  assert.deepEqual(Object.keys(runContext.resources), [dummyResourceKind.kind]);
  assert.deepEqual(resourceRecords.map((record) => record.id), [expectedResource.id]);
  assert.equal(resourceRecords.some((record) => record.id === absentResource.id), false);

  const bound = runContext.resources.dummy;
  assert.equal(bound.id, expectedResource.id);
  assert.equal(bound.kind, dummyResourceKind.kind);
  assert.equal(bound.role, expectedResource.role);
  assert.equal(bound.handle.read(), DUMMY_VALUE);

  assert.deepEqual(runContext.resourceManifest, [{
    kind: dummyResourceKind.kind,
    id: expectedResource.id,
    role: expectedResource.role,
    label: "dummy-fixture",
  }]);
  assert.equal(runContext.resourceManifest.some((entry) => entry.id === absentResource.id), false);
  assert.equal(runContext.resourceManifest.some((entry) => entry.label.includes(absentResource.id)), false);
  assert.equal(runContext.resourceManifest.some((entry) => Object.hasOwn(entry, "handle")), false);
}
