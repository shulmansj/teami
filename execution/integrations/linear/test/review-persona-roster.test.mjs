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
  UNPINNED_RUNTIME_DEV_FLAG,
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
const configExamplePath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
const REVIEW_REVIEWER_TARGET = "prompt/review/reviewer";
const REVIEW_GOVERNING_TARGET = "prompt/review/orchestrator_governing";

test("review governing and reviewer accepted prompts load through recorder and definition-driven roster", async () => {
  await withReviewWorkflow((reviewDefinition) => {
    assert.equal(reviewDefinition.eval_namespace, "execution/evals/review");
    assert.equal(reviewDefinition.driver_governing_target_key, REVIEW_GOVERNING_TARGET);

    const roster = createOrchestratorRoster({ workflowType: "review", repoRoot });
    assert.deepEqual(roster.selectableTargets, [REVIEW_REVIEWER_TARGET]);
    assert.equal(roster.promotable, true);

    const recorder = createRunRecorder();
    const governingSnapshot = loadAcceptedPromptSnapshot({
      repoRoot,
      definition: reviewDefinition,
      targetKey: REVIEW_GOVERNING_TARGET,
    });
    assert.equal(governingSnapshot.drift, false);
    assert.match(governingSnapshot.contentBytes, /S7 review payload/);
    assert.deepEqual(
      recorder.recordGoverningLoad({
        target_key: REVIEW_GOVERNING_TARGET,
        snapshot: governingSnapshot,
      }),
      {
        target_key: REVIEW_GOVERNING_TARGET,
        accepted_baseline_id: `sha256:${governingSnapshot.snapshotSha256}`,
        snapshot_sha256: governingSnapshot.snapshotSha256,
      },
    );

    const governingFromRoster = roster.resolve(REVIEW_GOVERNING_TARGET);
    assert.equal(governingFromRoster.ok, false);
    assert.equal(governingFromRoster.reason, "orchestrator_roster_target_not_selectable");

    const reviewer = roster.resolve(REVIEW_REVIEWER_TARGET);
    assert.equal(reviewer.ok, true);
    assert.equal(reviewer.runtime_role, "reviewer");
    const reviewerSnapshot = reviewer.loadSnapshot();
    assert.equal(reviewerSnapshot.drift, false);
    assert.match(reviewerSnapshot.contentBytes, /adversarial but practical reviewer/);
    recorder.recordLibraryLoad({ target_key: REVIEW_REVIEWER_TARGET, snapshot: reviewerSnapshot });

    assert.deepEqual(
      recorder.collectRefs().map(({ target_key }) => target_key),
      [REVIEW_GOVERNING_TARGET, REVIEW_REVIEWER_TARGET],
    );
  });
});

test("review runtime roles validate from the review namespace and resolve assignments", async () => {
  await withReviewWorkflow((reviewDefinition) => {
    assert.deepEqual(reviewDefinition.engine_owned_evaluator_roles, ["review_quality_judge"]);
    assert.equal(
      acceptedRuntimeRolesPathForWorkflow("review"),
      "execution/evals/review/accepted-runtime-roles.json",
    );

    const rawConfig = readJson(configExamplePath);
    for (const [role, fields] of Object.entries(rawConfig.workflows.review.roles)) {
      assert.equal(Object.hasOwn(fields, "runtime"), false, `${role}.runtime should not be in config.example`);
      assert.equal(Object.hasOwn(fields, "model"), false, `${role}.model should not be in config.example`);
    }

    const config = loadLinearConfig({ repoRoot });
    assert.equal(validateLinearConfig(config, "config", { repoRoot }), true);
    assert.deepEqual(Object.keys(config.workflows.review.roles).sort(), [
      "orchestrator",
      "reviewer",
    ]);
    assert.deepEqual(config.workflows.review.role_field_sources, {
      reviewer: { runtime: "accepted_defaults", model: "accepted_defaults" },
      orchestrator: { runtime: "accepted_defaults", model: "accepted_defaults" },
    });
    assert.equal(
      config.workflows.review.accepted_runtime_defaults_ref.target_key,
      "rule/review/runtime_role_assignments",
    );

    const assignments = resolveRoleRuntimeAssignments(config, "review");
    assert.deepEqual(Object.keys(assignments).sort(), ["orchestrator", "reviewer"]);
    for (const role of ["reviewer", "orchestrator"]) {
      assert.equal(assignments[role].role, role);
      assert.equal(assignments[role].runtime, "codex");
      assert.equal(assignments[role].model, "gpt-5.5");
      assert.equal(assignments[role].tool_policy.linear_write, false);
      assert.equal(assignments[role].tool_policy.project_mutation, "runner_only");
      assert.equal(assignments[role].tool_policy.issue_mutation, "runner_only");
    }
    assert.deepEqual(assignments.reviewer.warm_continuation, { enabled: false, required: false });
    assert.deepEqual(assignments.orchestrator.warm_continuation, { enabled: true, required: true });
  });
});

test("review reviewer runtime can be assigned a distinct provider and model via config", async () => {
  await withReviewWorkflow(() => {
    const config = readJson(configExamplePath);
    Object.assign(config.workflows.review.roles.reviewer, {
      runtime: "claude",
      model: "adopter-reviewer-model",
    });

    assert.equal(validateLinearConfig(config, "test-config", {
      repoRoot,
      env: { [UNPINNED_RUNTIME_DEV_FLAG]: "1" },
    }), true);

    assert.deepEqual(config.workflows.review.role_field_sources.reviewer, {
      runtime: "adopter_config",
      model: "adopter_config",
    });
    assert.deepEqual(config.workflows.review.unpinned_runtime, {
      reviewer: { runtime: true, model: true },
    });

    const assignments = resolveRoleRuntimeAssignments(config, "review");
    assert.equal(assignments.reviewer.runtime, "claude");
    assert.equal(assignments.reviewer.model, "adopter-reviewer-model");
    assert.equal(assignments.orchestrator.runtime, "codex");
    assert.equal(assignments.orchestrator.model, "gpt-5.5");
    assert.equal(assignments.reviewer.tool_policy.linear_write, false);
  });
});

test("review manifest pins the exact prompt and runtime-default bytes", () => {
  const manifest = readJson(path.join(repoRoot, "execution", "evals", "review", "phoenix-assets.json"));
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function withReviewWorkflow(fn) {
  const registrySnapshot = registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
  const { reviewDefinition } = await import("../src/workflows/review/definition.mjs");
  registerWorkflow(reviewDefinition);
  try {
    return await fn(reviewDefinition);
  } finally {
    resetRegistry();
    for (const definition of registrySnapshot) registerWorkflow(definition);
  }
}
