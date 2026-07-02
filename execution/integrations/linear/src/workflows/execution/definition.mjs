import { commitPayload } from "./commit-payload.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "./effect-ids.mjs";
import { gitRepoCommitEffectDescriptor } from "../../../../git/git-repo-commit-effect.mjs";
import { issueInReviewEffectDescriptor } from "../../linear/issue-in-review-effect.mjs";
import {
  EXECUTION_FUNCTION_VERSION,
  EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
} from "./phase-contract.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../../../engine/engine-contract-constants.mjs";
import { RUN_ARTIFACT_KINDS } from "../../../../../engine/run-store.mjs";

export const EXECUTION_WORKFLOW_TYPE = "execution";
export const EXECUTION_WAKE_KEY_TEMPLATE = "linear:issue:{issue_id}:execution";
export const EXECUTION_EVAL_NAMESPACE = "execution/evals/execution";
export const EXECUTION_ROLES = Object.freeze([
  "worker",
  "execution_quality_judge",
  "orchestrator",
]);
export const EXECUTION_ENGINE_OWNED_EVALUATOR_ROLES = Object.freeze([
  "execution_quality_judge",
]);
export const EXECUTION_REQUIRED_CAPABILITIES = Object.freeze([
  "linear.issue.ready",
  "execution.trigger_runner.v1",
]);

export function buildExecutionWakeKey(event) {
  const issueId = event?.object?.id ?? event?.issueId ?? event?.issue_id;
  if (!issueId) throw new Error("event object id is required to build an execution wake key.");
  return EXECUTION_WAKE_KEY_TEMPLATE.replace("{issue_id}", issueId);
}

const EXECUTION_TRIGGER = Object.freeze({
  trigger_type: "linear.issue.ready",
  provider_event_type: "linear.issue.updated",
  object_type: "issue",
  workflow_type: EXECUTION_WORKFLOW_TYPE,
  candidate_workflow: EXECUTION_WORKFLOW_TYPE,
  wake_key_template: EXECUTION_WAKE_KEY_TEMPLATE,
  build_wake_key: buildExecutionWakeKey,
  runner_required: true,
});

async function runTriggeredExecutionFromDefinition(options) {
  const { runTriggeredExecution } = await import("../../trigger-runner.mjs");
  if (typeof runTriggeredExecution !== "function") {
    throw new Error("runTriggeredExecution_not_available");
  }
  return runTriggeredExecution(options);
}

export const EXECUTION_COMMIT_EFFECTS = Object.freeze([
  gitRepoCommitEffectDescriptor({
    id: GIT_REPO_COMMIT_EFFECT_ID,
    producedIdentity: Object.freeze({
      resource_kind: "github_pull_request",
      target_ids: gitPullRequestTargetIds,
      identity: gitPullRequestProducedIdentity,
    }),
  }),
  issueInReviewEffectDescriptor({
    producedIdentity: Object.freeze({
      resource_kind: "linear_issue",
      target_ids: linearIssueTargetIds,
      identity: linearIssueProducedIdentity,
    }),
  }),
]);

export const executionDefinition = Object.freeze({
  workflow_type: EXECUTION_WORKFLOW_TYPE,
  trace_descriptor: Object.freeze({
    trace_name: "execution_run",
    attribute_keys: Object.freeze([
      "workflow.name",
      "workflow.version",
      "teami.domain_id",
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
      "domain_id",
      "team_id",
      "behavior_repo_id",
      "source_provider",
      "source_object_id",
      "trigger_type",
      "runner_id",
      "runner_version",
      "work_type",
      "selected_resource_id",
      "resource_id",
      "resource.kind",
      "resource.id",
      "resource.label",
      "github.owner",
      "github.repo",
      "github.branch",
      "github.pull_request_number",
    ]),
  }),
  triggers: Object.freeze([EXECUTION_TRIGGER]),
  input_status: "Ready",
  output_status: "In Review",
  required_capabilities: EXECUTION_REQUIRED_CAPABILITIES,
  roles: EXECUTION_ROLES,
  driver: "orchestrator",
  driver_governing_target_key: "prompt/execution/orchestrator_governing",
  invocable_runtime_roles: Object.freeze(["worker"]),
  runtime_assignment_roles: EXECUTION_ROLES,
  engine_owned_evaluator_roles: EXECUTION_ENGINE_OWNED_EVALUATOR_ROLES,
  role_capabilities: null,
  commitPayload,
  commit_effects: EXECUTION_COMMIT_EFFECTS,
  run: runTriggeredExecutionFromDefinition,
  artifact_schema: Object.freeze({
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: EXECUTION_FUNCTION_VERSION,
    workflow_version: EXECUTION_FUNCTION_VERSION,
    payload_schema_id: EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
    kinds: RUN_ARTIFACT_KINDS,
  }),
  eval_namespace: EXECUTION_EVAL_NAMESPACE,
  outcome_observations: Object.freeze([
    Object.freeze({
      id: "execution_pr_review_outcome",
      produced_identity_effect_id: GIT_REPO_COMMIT_EFFECT_ID,
      label: Object.freeze(["merged", "changes_requested"]),
    }),
    Object.freeze({
      id: "execution_issue_in_review_observed",
      produced_identity_effect_id: LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
      label: "in_review",
    }),
  ]),
});

function gitPullRequestTargetIds(identity) {
  const pullRequest = identity?.pull_request ?? identity?.pr ?? {};
  const repo = identity?.repo_identity ?? identity?.repository ?? {};
  const repoSlug = repoSlugFromIdentity(identity);
  const number = firstString(
    pullRequest.number,
    identity?.pull_request_number,
    identity?.pr_number,
  );
  const stableNumber = repoSlug && number ? `${repoSlug}#${number}` : null;
  return stringIds([
    pullRequest.id,
    pullRequest.node_id,
    identity?.pull_request_id,
    identity?.pr_id,
    stableNumber,
    identity?.resource_id,
    repo.resource_id,
    identity?.resource?.id,
    identity?.resource_target?.id,
    pullRequest.url,
    pullRequest.html_url,
    identity?.pull_request_url,
    identity?.pr_url,
  ]);
}

function gitPullRequestProducedIdentity(identity) {
  const pullRequest = identity?.pull_request ?? identity?.pr ?? {};
  const repo = identity?.repo_identity ?? identity?.repository ?? {};
  return {
    owner: firstString(identity?.owner, repo.owner),
    repo: firstString(identity?.repo, repo.repo, repo.name),
    branch: firstString(identity?.branch, identity?.head_branch),
    head_sha: firstString(identity?.head_sha, identity?.head_commit_sha),
    base_sha: firstString(identity?.base_sha),
    resource_id: firstString(
      identity?.resource_id,
      repo.resource_id,
      identity?.resource?.id,
      identity?.resource_target?.id,
    ),
    pull_request_id: firstString(pullRequest.id, identity?.pull_request_id, identity?.pr_id),
    pull_request_number: firstString(
      pullRequest.number,
      identity?.pull_request_number,
      identity?.pr_number,
    ),
    pull_request_url: firstString(
      pullRequest.url,
      pullRequest.html_url,
      identity?.pull_request_url,
      identity?.pr_url,
    ),
  };
}

function linearIssueTargetIds(identity) {
  const issue = identity?.issue ?? {};
  return stringIds([
    identity?.linear_issue_id,
    identity?.issue_id,
    issue.id,
  ]);
}

function linearIssueProducedIdentity(identity) {
  const issue = identity?.issue ?? {};
  return {
    linear_issue_id: firstString(identity?.linear_issue_id, identity?.issue_id, issue.id),
    issue_key: firstString(identity?.issue_key, issue.identifier, issue.key),
    status: firstString(identity?.status, issue.state?.name, "In Review"),
    status_id: firstString(identity?.status_id, identity?.state_id, issue.state?.id),
  };
}

function repoSlugFromIdentity(identity) {
  const repo = identity?.repo_identity ?? identity?.repository ?? {};
  const owner = firstString(identity?.owner, repo.owner);
  const repoName = firstString(identity?.repo, repo.repo, repo.name);
  return owner && repoName ? `${owner}/${repoName}` : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function stringIds(values) {
  const ids = values
    .map((value) => firstString(value))
    .filter(Boolean);
  return [...new Set(ids)];
}

import { registerWorkflow } from "../../../../../engine/workflow-registry.mjs";

registerWorkflow(executionDefinition);
