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
import { JUDGE_ROLE_NAMES } from "../../promotion/agent-behavior-scope.mjs";
export const DECOMPOSITION_WORKFLOW_TYPE = "decomposition";
export const DECOMPOSITION_WAKE_KEY_TEMPLATE = "linear:project:{project_id}:decomposition";
export const DECOMPOSITION_ROLES = Object.freeze(["pm", "sr_eng", "judge", "drafter", "orchestrator"]);
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
  triggers: Object.freeze([DECOMPOSITION_TRIGGER]),
  required_capabilities: DECOMPOSITION_REQUIRED_CAPABILITIES,
  roles: DECOMPOSITION_ROLES,
  driver: "orchestrator",
  driver_governing_target_key: "prompt/decomposition/orchestrator_governing",
  invocable_runtime_roles: Object.freeze(["pm", "sr_eng", "judge", "drafter"]),
  runtime_assignment_roles: DECOMPOSITION_ROLES,
  get engine_owned_evaluator_roles() {
    return JUDGE_ROLE_NAMES;
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
