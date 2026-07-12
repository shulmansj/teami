import assert from "node:assert/strict";
import test from "node:test";

import { toolPolicyToFlags } from "../src/runtime-adapters.mjs";

test("toolPolicyToFlags returns Claude no-tool flags for tool-less decomposition runs", () => {
  assert.deepEqual(
    toolPolicyToFlags({
      runtime: "claude",
      toolPolicy: { linear_write: false },
    }),
    ["--allowedTools", ""],
  );
});

test("toolPolicyToFlags returns Codex no-tool flags for tool-less decomposition runs", () => {
  assert.deepEqual(
    toolPolicyToFlags({
      runtime: "codex",
      toolPolicy: { linear_write: false },
    }),
    ["-s", "read-only"],
  );
});

test("toolPolicyToFlags grants codex workspace-write only via the explicit sandbox mode", () => {
  assert.deepEqual(
    toolPolicyToFlags({
      runtime: "codex",
      toolPolicy: { linear_write: false },
      sandbox: "workspace-write",
    }),
    ["-s", "workspace-write"],
  );
  // Unknown/absent sandbox values fail closed to read-only — never inherit the
  // adopter's codex config default.
  assert.deepEqual(
    toolPolicyToFlags({ runtime: "codex", toolPolicy: { linear_write: false }, sandbox: "danger-full-access" }),
    ["-s", "read-only"],
  );
});

test("the execution WORKER is the only role with the engine-owned workspace-write sandbox", async () => {
  const { resolveRoleRuntimeAssignments } = await import("../src/runtime-adapters.mjs");
  const { registerWorkflow } = await import("../../../engine/workflow-registry.mjs");
  const { executionDefinition } = await import("../src/workflows/execution/definition.mjs");
  try { registerWorkflow(executionDefinition); } catch { /* already registered */ }
  const config = { workflows: {} };
  const execution = resolveRoleRuntimeAssignments(config, "execution");
  assert.equal(execution.worker?.sandbox, "workspace-write");
  for (const [role, assignment] of Object.entries(execution)) {
    if (role === "worker") continue;
    assert.equal(assignment.sandbox ?? null, null, `role ${role} must stay read-only`);
  }
  const decomposition = resolveRoleRuntimeAssignments(config, "decomposition");
  for (const [role, assignment] of Object.entries(decomposition)) {
    assert.equal(assignment.sandbox ?? null, null, `decomposition role ${role} must stay read-only`);
  }
});
