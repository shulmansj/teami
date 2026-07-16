import { commitPayload } from "./commit-payload.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
} from "./effect-ids.mjs";
import {
  REVIEW_FUNCTION_VERSION,
  REVIEW_RUN_PAYLOAD_SCHEMA_ID,
} from "./phase-contract.mjs";
import {
  githubAfReviewStatusEffectDescriptor,
  githubPrReviewCommentEffectDescriptor,
  linearHumanReviewBriefingEffectDescriptor,
} from "../../review/teami-review-effects.mjs";
import {
  ISSUE_NEEDS_PRINCIPAL_EFFECT_ID,
  issueNeedsPrincipalEscalationEffectDescriptor,
} from "../../linear/issue-needs-principal-effect.mjs";
import {
  LINEAR_ISSUE_READY_EFFECT_ID,
  issueReadyEffectDescriptor,
} from "../../linear/issue-ready-effect.mjs";
import {
  LINEAR_ISSUE_DONE_EFFECT_ID,
  issueDoneEffectDescriptor,
} from "../../linear/issue-done-effect.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../../../engine/engine-contract-constants.mjs";
import { RUN_ARTIFACT_KINDS } from "../../../../../engine/run-store.mjs";

export const REVIEW_WORKFLOW_TYPE = "review";
export const REVIEW_WAKE_KEY_TEMPLATE = "linear:issue:{issue_id}:review";
export const REVIEW_EVAL_NAMESPACE = "execution/evals/review";
export const REVIEW_ROLES = Object.freeze(["reviewer", "orchestrator"]);
export const REVIEW_ENGINE_OWNED_EVALUATOR_ROLES = Object.freeze(["review_quality_judge"]);
export const REVIEW_REQUIRED_CAPABILITIES = Object.freeze([
  "linear.issue.in_review",
  "review.trigger_runner.v1",
]);

export function buildReviewWakeKey(event) {
  const issueId = event?.object?.id ?? event?.issueId ?? event?.issue_id;
  if (!issueId) throw new Error("event object id is required to build a review wake key.");
  return REVIEW_WAKE_KEY_TEMPLATE.replace("{issue_id}", issueId);
}

const REVIEW_TRIGGER = Object.freeze({
  trigger_type: "linear.issue.in_review",
  provider_event_type: "linear.issue.updated",
  object_type: "issue",
  workflow_type: REVIEW_WORKFLOW_TYPE,
  candidate_workflow: REVIEW_WORKFLOW_TYPE,
  wake_key_template: REVIEW_WAKE_KEY_TEMPLATE,
  build_wake_key: buildReviewWakeKey,
  runner_required: true,
});

async function runTriggeredReviewFromDefinition(options) {
  const { runTriggeredReview } = await import("../../trigger-runner.mjs");
  if (typeof runTriggeredReview !== "function") {
    throw new Error("runTriggeredReview_not_available");
  }
  return runTriggeredReview(options);
}

export const REVIEW_COMMIT_EFFECTS = Object.freeze([
  githubPrReviewCommentEffectDescriptor({ id: GITHUB_PR_REVIEW_COMMENT_EFFECT_ID }),
  githubAfReviewStatusEffectDescriptor({ id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID }),
  linearHumanReviewBriefingEffectDescriptor({ id: LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID }),
  issueReadyEffectDescriptor({ id: LINEAR_ISSUE_READY_EFFECT_ID }),
  issueNeedsPrincipalEscalationEffectDescriptor({ id: ISSUE_NEEDS_PRINCIPAL_EFFECT_ID }),
  issueDoneEffectDescriptor({ id: LINEAR_ISSUE_DONE_EFFECT_ID }),
]);

export const reviewDefinition = Object.freeze({
  workflow_type: REVIEW_WORKFLOW_TYPE,
  trace_descriptor: Object.freeze({
    trace_name: "review_run",
    attribute_keys: Object.freeze([
      "workflow.name",
      "workflow.version",
      "teami.team_ref",
      "teami.behavior_repo_id",
      "linear.workspace_id",
      "linear.team_id",
      "linear.issue_id",
      "run_id",
      "event_id",
      "wake_id",
      "trace_id",
      "attempt",
      "workspace_id",
      "team_ref",
      "team_id",
      "behavior_repo_id",
      "source_provider",
      "source_object_id",
      "trigger_type",
      "runner_id",
      "runner_version",
      "resource.kind",
      "resource.id",
      "resource.label",
      "github.owner",
      "github.repo",
      "github.pull_request_number",
      "github.head_sha",
      "review.disposition",
    ]),
  }),
  triggers: Object.freeze([REVIEW_TRIGGER]),
  input_status: "In Review",
  required_capabilities: REVIEW_REQUIRED_CAPABILITIES,
  roles: REVIEW_ROLES,
  driver: "orchestrator",
  driver_governing_target_key: "prompt/review/orchestrator_governing",
  runtime_assignment_roles: REVIEW_ROLES,
  engine_owned_evaluator_roles: REVIEW_ENGINE_OWNED_EVALUATOR_ROLES,
  role_capabilities: null,
  commitPayload,
  commit_effects: REVIEW_COMMIT_EFFECTS,
  run: runTriggeredReviewFromDefinition,
  artifact_schema: Object.freeze({
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: REVIEW_FUNCTION_VERSION,
    workflow_version: REVIEW_FUNCTION_VERSION,
    payload_schema_id: REVIEW_RUN_PAYLOAD_SCHEMA_ID,
    kinds: RUN_ARTIFACT_KINDS,
  }),
  eval_namespace: REVIEW_EVAL_NAMESPACE,
  outcome_observations: Object.freeze([
    Object.freeze({
      id: "review_af_review_status_outcome",
      produced_identity_effect_id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      label: Object.freeze(["success", "failure"]),
    }),
  ]),
});

import { registerWorkflow } from "../../../../../engine/workflow-registry.mjs";

registerWorkflow(reviewDefinition);
