import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeDomainResources,
} from "../../../engine/materialize.mjs";
import {
  registerResourceKind,
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";

test("materializeDomainResources builds a lean run-context for selected resources only", async () => {
  resetResourceRegistry();
  try {
    const handle = { label: "Fake Resource", read() {} };
    const runGit = () => {};
    registerFakeKind({ kind: "fake", handle });
    registerFakeKind({ kind: "unused", handle: { label: "Unused Resource" } });

    const { runContext, teardownAll } = await materializeDomainResources({
      domainResources: [fakeResource({ kind: "fake", id: "resource-1", role: "primary" })],
      runId: "run-1",
      engineRepoRoot: "C:/agentic-factory",
      runGit,
    });

    assert.deepEqual(Object.keys(runContext).sort(), [
      "engineRepoRoot",
      "resourceManifest",
      "resources",
      "runGit",
      "runId",
    ]);
    assert.equal(runContext.runId, "run-1");
    assert.equal(runContext.engineRepoRoot, "C:/agentic-factory");
    assert.equal(runContext.runGit, runGit);
    assert.deepEqual(Object.keys(runContext.resources), ["fake"]);
    assert.deepEqual(runContext.resources.fake, {
      id: "resource-1",
      kind: "fake",
      role: "primary",
      handle,
    });
    assert.equal(Object.hasOwn(runContext.resources.fake, "teardown"), false);

    assert.deepEqual(runContext.resourceManifest, [{
      kind: "fake",
      id: "resource-1",
      role: "primary",
      label: "Fake Resource",
    }]);
    assert.equal(Object.hasOwn(runContext.resourceManifest[0], "handle"), false);
    assert.equal(Object.hasOwn(runContext.resourceManifest[0], "read"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(runContext.resourceManifest[0])), runContext.resourceManifest[0]);

    await teardownAll();
  } finally {
    resetResourceRegistry();
  }
});

test("teardownAll is async, idempotent, and tears down resources in reverse order", async () => {
  resetResourceRegistry();
  try {
    const teardownLog = [];
    registerFakeKind({
      kind: "first",
      teardown: () => teardownLog.push("first"),
    });
    registerFakeKind({
      kind: "second",
      teardown: async () => {
        await Promise.resolve();
        teardownLog.push("second");
      },
    });

    const { teardownAll } = await materializeDomainResources({
      domainResources: [
        fakeResource({ kind: "first" }),
        fakeResource({ kind: "second" }),
      ],
      runId: "run-2",
      engineRepoRoot: "C:/agentic-factory",
    });

    const teardownPromise = teardownAll();
    assert.equal(typeof teardownPromise.then, "function");
    await teardownPromise;
    await teardownAll();

    assert.deepEqual(teardownLog, ["second", "first"]);
  } finally {
    resetResourceRegistry();
  }
});

test("teardownAll attempts all teardowns and throws an aggregate when one fails", async () => {
  resetResourceRegistry();
  try {
    const teardownLog = [];
    const teardownFailure = new Error("bad_teardown_failed");
    registerFakeKind({
      kind: "ok",
      teardown: () => teardownLog.push("ok"),
    });
    registerFakeKind({
      kind: "bad",
      teardown: () => {
        teardownLog.push("bad");
        throw teardownFailure;
      },
    });

    const { teardownAll } = await materializeDomainResources({
      domainResources: [
        fakeResource({ kind: "ok" }),
        fakeResource({ kind: "bad" }),
      ],
      runId: "run-3",
      engineRepoRoot: "C:/agentic-factory",
    });

    await assert.rejects(
      () => teardownAll(),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.message, "resource_teardown_failed");
        assert.deepEqual(error.errors, [teardownFailure]);
        return true;
      },
    );

    assert.deepEqual(teardownLog, ["bad", "ok"]);
  } finally {
    resetResourceRegistry();
  }
});

test("materializeDomainResources tears down built resources and propagates the original mid-materialize error", async () => {
  resetResourceRegistry();
  try {
    const teardownLog = [];
    const materializeFailure = new Error("broken_materialize_failed");
    registerFakeKind({
      kind: "built",
      teardown: () => teardownLog.push("built"),
    });
    registerFakeKind({
      kind: "broken",
      materialize: async () => {
        throw materializeFailure;
      },
    });

    await assert.rejects(
      () => materializeDomainResources({
        domainResources: [
          fakeResource({ kind: "built" }),
          fakeResource({ kind: "broken" }),
        ],
        runId: "run-4",
        engineRepoRoot: "C:/agentic-factory",
      }),
      materializeFailure,
    );

    assert.deepEqual(teardownLog, ["built"]);
  } finally {
    resetResourceRegistry();
  }
});

function registerFakeKind({
  kind,
  handle = { label: `${kind} Resource` },
  teardown = () => {},
  materialize = async () => ({ kind, handle, teardown }),
} = {}) {
  registerResourceKind({
    kind,
    validateBinding() {},
    materialize,
    manifestEntry(resource, receivedHandle) {
      return {
        kind,
        id: resource.id,
        role: resource.role,
        label: receivedHandle.label,
      };
    },
  });
}

function fakeResource({
  kind,
  id = `${kind}-resource`,
  role = "primary",
  binding = {},
} = {}) {
  return { id, kind, role, binding };
}
