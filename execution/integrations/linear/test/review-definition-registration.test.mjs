import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { resolveEvalContract } from "../../../engine/eval-annotation-contract.mjs";
import {
  hasProducedIdentityProjector,
  projectProducedIdentities,
} from "../../../engine/produced-identities.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
  validateWorkflowDefinition,
} from "../../../engine/workflow-registry.mjs";
import { ISSUE_NEEDS_PRINCIPAL_EFFECT_ID } from "../src/linear/issue-needs-principal-effect.mjs";
import { LINEAR_ISSUE_READY_EFFECT_ID } from "../src/linear/issue-ready-effect.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
} from "../src/workflows/review/effect-ids.mjs";
import {
  REVIEW_FUNCTION_VERSION,
  REVIEW_RUN_PAYLOAD_SCHEMA_ID,
} from "../src/workflows/review/phase-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

test("review definition registers through the trigger-registry load path", async () => {
  const registrySnapshot = snapshotRegistry();
  try {
    const triggerRegistry = await import("../src/trigger-registry.mjs");
    const { reviewDefinition } = await import("../src/workflows/review/definition.mjs");
    registerWorkflow(reviewDefinition);
    const definition = getWorkflowDefinition("review");

    assert.equal(validateWorkflowDefinition(definition), "review");
    assert.equal(Object.hasOwn(definition, "output_status"), false);
    assert.ok(
      triggerRegistry.TRIGGER_REGISTRY.some((trigger) =>
        trigger.workflow_type === "review" &&
        trigger.trigger_type === "linear.issue.in_review" &&
        trigger.object_type === "issue"
      ),
      "review trigger should be visible through the real trigger registry entrypoint",
    );
  } finally {
    restoreRegistry(registrySnapshot);
  }
});

test("review definition validates S7 payloads and declares the S4/S5 effect superset", async () => {
  const registrySnapshot = snapshotRegistry();
  try {
    const { reviewDefinition } = await import("../src/workflows/review/definition.mjs");
    resetRegistry();
    registerWorkflow(reviewDefinition);
    const definition = getWorkflowDefinition("review");

    assert.equal(validateWorkflowDefinition(definition), "review");
    assert.deepEqual(registeredWorkflowTypes(), ["review"]);
    assert.equal(definition.workflow_type, "review");
    assert.equal(definition.input_status, "In Review");
    assert.equal(Object.hasOwn(definition, "output_status"), false);
    assert.deepEqual(definition.roles, ["reviewer", "orchestrator"]);
    assert.deepEqual(definition.invocable_runtime_roles, ["reviewer"]);
    assert.deepEqual(definition.runtime_assignment_roles, ["reviewer", "orchestrator"]);
    assert.deepEqual(definition.engine_owned_evaluator_roles, ["review_quality_judge"]);
    assert.equal(definition.driver, "orchestrator");

    assert.deepEqual(definition.commit_effects.map((effect) => effect.id), [
      GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
      GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      LINEAR_ISSUE_READY_EFFECT_ID,
      ISSUE_NEEDS_PRINCIPAL_EFFECT_ID,
    ]);
    assert.equal(
      hasProducedIdentityProjector(
        definition.commit_effects.find((effect) => effect.id === GITHUB_AF_REVIEW_STATUS_EFFECT_ID),
      ),
      true,
    );
    assert.deepEqual(definition.outcome_observations, [{
      id: "review_af_review_status_outcome",
      produced_identity_effect_id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      label: ["success", "failure"],
    }]);

    const projected = projectProducedIdentities({
      effects: definition.commit_effects,
      applied: [{
        id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
        identity: {
          owner: "acme",
          repo: "product",
          head_sha: HEAD_SHA,
          state: "success",
        },
      }],
    });
    assert.deepEqual(projected, [{
      effect_id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      provider: "github",
      resource_kind: "github_commit_status",
      target_ids: [`acme/product@${HEAD_SHA}:af-review`],
      identity: {
        owner: "acme",
        repo: "product",
        head_sha: HEAD_SHA,
        context: "af-review",
        state: "success",
      },
    }]);

    const assembled = definition.commitPayload.assembleCommitPayload({
      disposition: "approve",
      body: "Approve. The diff is ready to ship.",
      reviewedHeadSha: HEAD_SHA,
      comments: [{ path: "src/app.js", body: "Optional inline note." }],
    });
    assert.deepEqual(assembled, {
      disposition: "approve",
      body: "Approve. The diff is ready to ship.",
      reviewed_head_sha: HEAD_SHA,
      comments: [{ path: "src/app.js", body: "Optional inline note." }],
    });
    assert.deepEqual(definition.commitPayload.validateCommitPayload(assembled), {
      ok: true,
      failureReasons: [],
    });
    assert.deepEqual(
      definition.commitPayload.validateCommitPayload({
        disposition: "approved",
        body: " ",
        reviewed_head_sha: "abc123",
        comments: "not an array",
      }),
      {
        ok: false,
        failureReasons: [
          "invalid_review_disposition",
          "missing_review_body",
          "invalid_reviewed_head_sha",
          "invalid_review_comments",
        ],
      },
    );
    assert.equal(definition.commitPayload.qualityGateInput(assembled), null);

    assert.equal(definition.artifact_schema.function_version, REVIEW_FUNCTION_VERSION);
    assert.equal(definition.artifact_schema.workflow_version, REVIEW_FUNCTION_VERSION);
    assert.equal(definition.artifact_schema.payload_schema_id, REVIEW_RUN_PAYLOAD_SCHEMA_ID);

    const namespacePaths = evalNamespacePaths(definition);
    assert.equal(namespacePaths.manifest, "execution/evals/review/phoenix-assets.json");
    assert.equal(
      fs.existsSync(path.resolve(repoRoot, namespacePaths.manifest)),
      true,
      "review declares a non-empty eval namespace whose accepted assets are present",
    );
    const evalContract = resolveEvalContract(definition, repoRoot);
    assert.equal(evalContract.eval_configured, true);
    assert.equal(evalContract.judge_prompt.role, "review_quality_judge");
    assert.equal(evalContract.judge_prompt.target_key, "prompt/review/review_quality_judge");
  } finally {
    restoreRegistry(registrySnapshot);
  }
});

function snapshotRegistry() {
  return registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
}

function restoreRegistry(definitions) {
  resetRegistry();
  for (const definition of definitions) registerWorkflow(definition);
}
