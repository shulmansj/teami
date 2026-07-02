import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { resolveEvalContract } from "../src/eval-annotation-contract.mjs";
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
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "../src/workflows/execution/effect-ids.mjs";
import {
  EXECUTION_FUNCTION_VERSION,
  EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
} from "../src/workflows/execution/phase-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("execution definition registers through the trigger-registry load path and validates O6 joins", async () => {
  const registrySnapshot = snapshotRegistry();
  try {
    const triggerRegistry = await import("../src/trigger-registry.mjs");
    const definition = getWorkflowDefinition("execution");

    assert.equal(validateWorkflowDefinition(definition), "execution");
    assert.equal(typeof definition.run, "function");
    assert.equal(definition.workflow_type, "execution");
    assert.equal(definition.input_status, "Ready");
    assert.equal(definition.output_status, "In Review");
    assert.equal(definition.eval_namespace, "execution/evals/execution");
    assert.deepEqual(definition.engine_owned_evaluator_roles, ["execution_quality_judge"]);
    assert.deepEqual(definition.invocable_runtime_roles, ["worker"]);

    assert.ok(
      triggerRegistry.TRIGGER_REGISTRY.some((trigger) =>
        trigger.workflow_type === "execution" &&
        trigger.trigger_type === "linear.issue.ready" &&
        trigger.object_type === "issue"
      ),
      "execution trigger should be visible through the real trigger registry entrypoint",
    );

    assert.deepEqual(
      definition.commit_effects.map((effect) => effect.id),
      [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID],
    );
    assert.ok(definition.commit_effects.every(hasProducedIdentityProjector));
    assert.deepEqual(
      definition.outcome_observations.map((observation) => observation.produced_identity_effect_id),
      [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID],
    );

    const projected = projectProducedIdentities({
      effects: definition.commit_effects,
      applied: [
        {
          id: GIT_REPO_COMMIT_EFFECT_ID,
          identity: {
            owner: "acme",
            repo: "product",
            resource_id: "repo-1",
            branch: "af/execution/AF-123-f6f50d78",
            head_sha: "abc123",
            pull_request: {
              id: "pr_1",
              number: 42,
              url: "https://github.example/acme/product/pull/42",
            },
          },
        },
        {
          id: LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
          identity: {
            linear_issue_id: "lin_1",
            issue_key: "AF-123",
            status_id: "state_in_review",
          },
        },
      ],
    });
    assert.deepEqual(projected.map((entry) => entry.effect_id), [
      GIT_REPO_COMMIT_EFFECT_ID,
      LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
    ]);
    assert.deepEqual(projected.map((entry) => entry.resource_kind), [
      "github_pull_request",
      "linear_issue",
    ]);
    assert.deepEqual(projected[0].target_ids, [
      "pr_1",
      "acme/product#42",
      "repo-1",
      "https://github.example/acme/product/pull/42",
    ]);
    assert.equal(projected[0].identity.resource_id, "repo-1");
    assert.deepEqual(projected[1].target_ids, ["lin_1"]);

    const assembled = definition.commitPayload.assembleCommitPayload({
      pr_title: "Implement EXEC-DEF",
      pr_body: "Adds the execution workflow definition.",
      issue_id: "lin_1",
    });
    assert.equal(assembled.pr_title, "Implement EXEC-DEF");
    assert.equal(assembled.pr_body, "Adds the execution workflow definition.");
    assert.equal(assembled.linear_issue_id, "lin_1");
    assert.deepEqual(definition.commitPayload.validateCommitPayload(assembled), {
      ok: true,
      failureReasons: [],
    });
    assert.deepEqual(
      definition.commitPayload.validateCommitPayload({ pr_title: "x" }),
      {
        ok: false,
        failureReasons: ["missing_pr_body", "missing_linear_issue_id"],
      },
    );
    assert.equal(definition.commitPayload.qualityGateInput(assembled), null);

    assert.equal(definition.artifact_schema.function_version, EXECUTION_FUNCTION_VERSION);
    assert.equal(definition.artifact_schema.workflow_version, EXECUTION_FUNCTION_VERSION);
    assert.equal(definition.artifact_schema.payload_schema_id, EXECUTION_RUN_PAYLOAD_SCHEMA_ID);

    const namespacePaths = evalNamespacePaths(definition);
    assert.equal(namespacePaths.manifest, "execution/evals/execution/phoenix-assets.json");
    assert.equal(
      fs.existsSync(path.resolve(repoRoot, namespacePaths.manifest)),
      true,
      "execution declares a non-empty eval namespace whose accepted assets are present",
    );

    const evalContract = resolveEvalContract(definition, repoRoot);
    assert.equal(evalContract.eval_configured, true);
    assert.equal(evalContract.reason, null);
    assert.equal(evalContract.workflow_type, "execution");
    assert.equal(evalContract.eval_namespace, "execution/evals/execution");
    assert.equal(evalContract.manifest.prompts[0].role, "worker");
    assert.equal(evalContract.judge_prompt.role, "execution_quality_judge");
    assert.equal(evalContract.judge_prompt.target_key, "prompt/execution/execution_quality_judge");
    assert.equal(evalContract.judge_prompt.evaluator_entry.id, "execution_quality_judge_v1");
    assert.equal(evalContract.annotation_schema.$id, "execution-eval-annotation/v1");
    assert.equal(evalContract.example_schema.$id, "execution-eval-example/v1");
    assert.deepEqual([...evalContract.quality_labels], ["pass", "needs_revision", "blocking_failure"]);
    assert.deepEqual([...evalContract.quality_dimension_names], [
      "quality",
      "correctness",
      "scope_fit",
      "acceptance_criteria_met",
      "test_coverage",
      "no_unrelated_churn",
      "code_quality_fit",
      "safety_and_side_effects",
      "escalation_judgment",
    ]);
    assert.equal(evalContract.rubric_version, "1.0.0");
    assert.equal(evalContract.failure_taxonomy_version, "1.0.0");
    assert.equal(evalContract.failure_taxonomy_workflow_key, "execution");
    assert.deepEqual([...evalContract.allowed_failure_modes], [
      "exec_introduced_regression",
      "exec_logic_error",
      "exec_missing_scope",
      "exec_scope_creep",
      "exec_acceptance_criteria_unmet",
      "exec_inadequate_tests",
      "exec_tests_do_not_exercise_change",
      "exec_unrelated_churn",
      "exec_style_mismatch",
      "exec_committed_secret",
      "exec_unsafe_side_effect",
      "exec_product_question_not_escalated",
    ]);
    assert.equal(evalContract.rich_example_dataset_name, "teami-execution-examples");
    assert.equal(evalContract.scoreWithinLabelBand("pass", 0.9), true);
    assert.equal(evalContract.scoreAtBandBoundary(0.8), true);
    assert.deepEqual(
      evalContract.judge_input_contract.required_fields,
      [
        "source_type",
        "run",
        "issue",
        "pull_request",
        "diff",
        "files_changed",
        "tests",
        "terminal_output",
        "rubric_version",
        "failure_taxonomy_version",
        "allowed_failure_modes",
      ],
    );
    assert.deepEqual(evalContract.findBannedWorkflowStateMetadataKeys({ queue_state: true }), ["queue_state"]);

    resetRegistry();
    registerWorkflow(definition);
    assert.deepEqual(registeredWorkflowTypes(), ["execution"]);
    assert.equal(getWorkflowDefinition("execution"), definition);
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
