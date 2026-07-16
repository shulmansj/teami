import { evaluateDecompositionEligibility } from "./eligibility.mjs";
import { commitPayload } from "./commit-payload.mjs";
import { DECOMPOSITION_COMMIT_EFFECTS } from "./artifact-apply.mjs";
import {
  DECOMPOSITION_FUNCTION_VERSION,
  DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
  PHASE_PACKET_SCHEMA_VERSION,
} from "../../phase-contract.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../../../engine/engine-contract-constants.mjs";
import { RUN_ARTIFACT_KINDS } from "../../../../../engine/run-store.mjs";
export const DECOMPOSITION_WORKFLOW_TYPE = "decomposition";
export const DECOMPOSITION_WAKE_KEY_TEMPLATE = "linear:project:{project_id}:decomposition";
export const DECOMPOSITION_ROLES = Object.freeze(["pm", "sr_eng", "judge", "drafter", "orchestrator"]);
export const DECOMPOSITION_ENGINE_OWNED_EVALUATOR_ROLES = Object.freeze([
  "judge",
  "decomposition_quality_judge",
]);
export const DECOMPOSITION_REQUIRED_CAPABILITIES = Object.freeze([
  "linear.project.planned",
  "decomposition.trigger_runner.v1",
]);

export function buildDecompositionWakeKey(event) {
  const projectId = event?.object?.id;
  if (!projectId) throw new Error("event object id is required to build a wake key.");
  return DECOMPOSITION_WAKE_KEY_TEMPLATE.replace("{project_id}", projectId);
}

const DECOMPOSITION_TRIGGER = Object.freeze({
  trigger_type: "linear.project.planned",
  provider_event_type: "linear.project.updated",
  object_type: "project",
  workflow_type: DECOMPOSITION_WORKFLOW_TYPE,
  candidate_workflow: DECOMPOSITION_WORKFLOW_TYPE,
  wake_key_template: DECOMPOSITION_WAKE_KEY_TEMPLATE,
  build_wake_key: buildDecompositionWakeKey,
  runner_required: true,
});

async function runTriggeredDecompositionFromDefinition(options) {
  const { runTriggeredDecomposition } = await import("../../trigger-runner.mjs");
  return runTriggeredDecomposition(options);
}

export const decompositionDefinition = Object.freeze({
  workflow_type: DECOMPOSITION_WORKFLOW_TYPE,
  // The '## What I did with each part of your project' heading is decomposition
  // vocabulary: a commit's completion update — and a failed_closed stop's authored
  // summary — account for every part of the project. (A product-question pause authors
  // open questions, not a project update, so it carries no such section.) Other
  // functions keep the project-update + run_id floor without this heading.
  require_project_update_accountability_section: true,
  trace_descriptor: Object.freeze({
    trace_name: "decomposition_run",
    // Documents the stable root attributes; dynamic runtime attributes still
    // pass through the existing trace builders.
    attribute_keys: Object.freeze([
      "workflow.name",
      "workflow.version",
      "teami.team_ref",
      "teami.behavior_repo_id",
      "linear.workspace_id",
      "linear.team_id",
      "linear.project_id",
      "linear_project_id",
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
    ]),
  }),
  triggers: Object.freeze([DECOMPOSITION_TRIGGER]),
  input_status: "Planned",
  required_capabilities: DECOMPOSITION_REQUIRED_CAPABILITIES,
  roles: DECOMPOSITION_ROLES,
  driver: "orchestrator",
  driver_governing_target_key: "prompt/decomposition/orchestrator_governing",
  runtime_assignment_roles: DECOMPOSITION_ROLES,
  get engine_owned_evaluator_roles() {
    return DECOMPOSITION_ENGINE_OWNED_EVALUATOR_ROLES;
  },
  // Placed role_capabilities/tool_policy seam: agent write credentials stay
  // absent from contained environments; the engine owns the single validated commit.
  role_capabilities: null,
  packet_schema: Object.freeze({
    schema_version: PHASE_PACKET_SCHEMA_VERSION,
    schema_paths: Object.freeze([
      "execution/integrations/linear/schemas/phase-packet.schema.json",
      "execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json",
    ]),
  }),
  eligibility: evaluateDecompositionEligibility,
  commitPayload,
  commit_effects: DECOMPOSITION_COMMIT_EFFECTS,
  run: runTriggeredDecompositionFromDefinition,
  artifact_schema: Object.freeze({
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: DECOMPOSITION_FUNCTION_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    payload_schema_id: DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
    kinds: RUN_ARTIFACT_KINDS,
  }),
  eval_namespace: "execution/evals/decomposition",
});

import { registerWorkflow } from "../../../../../engine/workflow-registry.mjs";

registerWorkflow(decompositionDefinition);
