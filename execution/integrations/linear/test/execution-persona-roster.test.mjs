import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadAcceptedPromptSnapshot } from "../../../engine/accepted-prompt-snapshot.mjs";
import { createRunRecorder } from "../../../engine/run-accepted-refs.mjs";
import {
  acceptedRuntimeRolesPathForWorkflow,
  loadLinearConfig,
  validateLinearConfig,
} from "../src/config.mjs";
import { createOrchestratorRoster } from "../src/orchestrator-roster.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const EXECUTION_WORKER_TARGET = "prompt/execution/code_worker";
const EXECUTION_GOVERNING_TARGET = "prompt/execution/orchestrator_governing";
const DECOMPOSITION_SELECTABLE_TARGETS = Object.freeze([
  "prompt/decomposition/pm_product_sufficiency_pass",
  "prompt/decomposition/sr_eng_grounding_pass",
  "prompt/decomposition/pm_synthesis",
  "prompt/decomposition/sr_eng_blocker_check",
]);

test("execution governing and worker accepted prompts load through recorder and definition-driven roster", async () => {
  await withExecutionWorkflow((executionDefinition) => {
    assert.equal(executionDefinition.eval_namespace, "execution/evals/execution");
    assert.equal(executionDefinition.driver_governing_target_key, EXECUTION_GOVERNING_TARGET);

    const roster = createOrchestratorRoster({ workflowType: "execution", repoRoot });
    assert.deepEqual(roster.selectableTargets, [EXECUTION_WORKER_TARGET]);
    assert.equal(roster.promotable, true);

    const recorder = createRunRecorder();
    const governingSnapshot = loadAcceptedPromptSnapshot({
      repoRoot,
      definition: executionDefinition,
      targetKey: EXECUTION_GOVERNING_TARGET,
    });
    assert.equal(governingSnapshot.drift, false);
    assert.match(governingSnapshot.contentBytes, /your tests must pass/);
    assert.deepEqual(
      recorder.recordGoverningLoad({
        target_key: EXECUTION_GOVERNING_TARGET,
        snapshot: governingSnapshot,
      }),
      {
        target_key: EXECUTION_GOVERNING_TARGET,
        accepted_baseline_id: `sha256:${governingSnapshot.snapshotSha256}`,
        snapshot_sha256: governingSnapshot.snapshotSha256,
      },
    );

    const governingFromRoster = roster.resolve(EXECUTION_GOVERNING_TARGET);
    assert.equal(governingFromRoster.ok, false);
    assert.equal(governingFromRoster.reason, "orchestrator_roster_target_not_selectable");

    const worker = roster.resolve(EXECUTION_WORKER_TARGET);
    assert.equal(worker.ok, true);
    assert.equal(worker.runtime_role, "worker");
    const workerSnapshot = worker.loadSnapshot();
    assert.equal(workerSnapshot.drift, false);
    assert.match(workerSnapshot.contentBytes, /your tests must pass/);
    recorder.recordLibraryLoad({ target_key: EXECUTION_WORKER_TARGET, snapshot: workerSnapshot });

    assert.deepEqual(
      recorder.collectRefs().map(({ target_key }) => target_key),
      [EXECUTION_GOVERNING_TARGET, EXECUTION_WORKER_TARGET],
    );
  });
});

test("execution runtime roles validate from the execution namespace and resolve assignments", async () => {
  await withExecutionWorkflow(() => {
    assert.equal(
      acceptedRuntimeRolesPathForWorkflow("execution"),
      "execution/evals/execution/accepted-runtime-roles.json",
    );

    const config = loadLinearConfig({ repoRoot });
    assert.equal(validateLinearConfig(config, "config", { repoRoot }), true);
    assert.deepEqual(Object.keys(config.workflows.execution.roles).sort(), [
      "execution_quality_judge",
      "orchestrator",
      "worker",
    ]);
    assert.deepEqual(config.workflows.execution.role_field_sources, {
      worker: { runtime: "accepted_defaults", model: "accepted_defaults" },
      execution_quality_judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
      orchestrator: { runtime: "accepted_defaults", model: "accepted_defaults" },
    });
    assert.equal(
      config.workflows.execution.accepted_runtime_defaults_ref.target_key,
      "rule/execution/runtime_role_assignments",
    );

    const assignments = resolveRoleRuntimeAssignments(config, "execution");
    assert.deepEqual(Object.keys(assignments).sort(), [
      "execution_quality_judge",
      "orchestrator",
      "worker",
    ]);
    for (const role of ["worker", "execution_quality_judge", "orchestrator"]) {
      assert.equal(assignments[role].role, role);
      assert.equal(assignments[role].runtime, "codex");
      assert.equal(assignments[role].model, "gpt-5.5");
      assert.equal(assignments[role].tool_policy.linear_write, false);
      assert.equal(assignments[role].tool_policy.project_mutation, "runner_only");
      assert.equal(assignments[role].tool_policy.issue_mutation, "runner_only");
    }
  });
});

test("execution manifest pins the exact prompt and runtime-default bytes", () => {
  const manifest = readJson(path.join(repoRoot, "execution", "evals", "execution", "phoenix-assets.json"));
  const entries = [
    ...manifest.prompts.map((entry) => ({
      path: entry.snapshot_path,
      sha: entry.snapshot_sha256,
    })),
    ...manifest.rules.map((entry) => ({
      path: entry.artifact_path,
      sha: entry.snapshot_sha256,
    })),
  ];

  for (const entry of entries) {
    assert.equal(sha256(fs.readFileSync(path.join(repoRoot, entry.path))), entry.sha, entry.path);
  }
});

test("decomposition roster and config role block remain on the legacy role set", () => {
  const roster = createOrchestratorRoster({ workflowType: "decomposition", repoRoot });
  assert.deepEqual([...roster.selectableTargets].sort(), [...DECOMPOSITION_SELECTABLE_TARGETS].sort());

  const config = readJson(path.join(repoRoot, "execution", "integrations", "linear", "config.example.json"));
  assert.deepEqual(Object.keys(config.workflows.decomposition.roles), [
    "pm",
    "sr_eng",
    "judge",
    "drafter",
    "orchestrator",
  ]);
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function withExecutionWorkflow(fn) {
  const registrySnapshot = registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
  const { executionDefinition } = await import("../src/workflows/execution/definition.mjs");
  registerWorkflow(executionDefinition);
  try {
    return await fn(executionDefinition);
  } finally {
    resetRegistry();
    for (const definition of registrySnapshot) registerWorkflow(definition);
  }
}
