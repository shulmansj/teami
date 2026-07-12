import {
  hasProducedIdentityProjector,
} from "./produced-identities.mjs";

const WORKFLOW_DEFINITIONS_BY_TYPE = new Map();

const REQUIRED_DEFINITION_ARRAY_FIELDS = Object.freeze([
  "triggers",
  "roles",
  "runtime_assignment_roles",
  "commit_effects",
]);
const REQUIRED_DEFINITION_STRING_FIELDS = Object.freeze([
  "driver",
  "driver_governing_target_key",
  "eval_namespace",
]);
const OPTIONAL_STATUS_STRING_FIELDS = Object.freeze([
  "input_status",
  "output_status",
]);
const REQUIRED_COMMIT_PAYLOAD_FUNCTIONS = Object.freeze([
  "assembleCommitPayload",
  "validateCommitPayload",
  "qualityGateInput",
]);

// Validate the engine-contract fields a function must supply, at registration —
// so a malformed definition fails loudly here, not deep inside a run. The engine
// holds `run` as data and calls it; dispatch/role-derivation/the commit gate read
// the rest. (role_capabilities is a placed seam and stays nullable.)
export function validateWorkflowDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("workflow_definition_required");
  }
  const workflowType = definition.workflow_type;
  if (typeof workflowType !== "string" || workflowType.trim() === "") {
    throw new Error("workflow_definition_workflow_type_required");
  }
  if (typeof definition.run !== "function") {
    throw new Error(`workflow_definition_run_required:${workflowType}`);
  }
  for (const field of REQUIRED_DEFINITION_ARRAY_FIELDS) {
    if (!Array.isArray(definition[field])) {
      throw new Error(`workflow_definition_${field}_must_be_array:${workflowType}`);
    }
  }
  for (const field of REQUIRED_DEFINITION_STRING_FIELDS) {
    const value = definition[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`workflow_definition_${field}_required:${workflowType}`);
    }
  }
  for (const field of OPTIONAL_STATUS_STRING_FIELDS) {
    if (!Object.hasOwn(definition, field)) continue;
    const value = definition[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`workflow_definition_${field}_required:${workflowType}`);
    }
  }
  const commitPayload = definition.commitPayload;
  if (!commitPayload || typeof commitPayload !== "object") {
    throw new Error(`workflow_definition_commitPayload_required:${workflowType}`);
  }
  for (const fn of REQUIRED_COMMIT_PAYLOAD_FUNCTIONS) {
    if (typeof commitPayload[fn] !== "function") {
      throw new Error(`workflow_definition_commitPayload_${fn}_required:${workflowType}`);
    }
  }
  if (!definition.artifact_schema || typeof definition.artifact_schema !== "object") {
    throw new Error(`workflow_definition_artifact_schema_required:${workflowType}`);
  }
  validateTraceDescriptor(definition, workflowType);
  validateOutcomeObservations(definition, workflowType);
  return workflowType;
}

function validateTraceDescriptor(definition, workflowType) {
  const descriptor = definition.trace_descriptor;
  if (descriptor === undefined) return;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`workflow_definition_trace_descriptor_must_be_object:${workflowType}`);
  }
  if (typeof descriptor.trace_name !== "string" || descriptor.trace_name.trim() === "") {
    throw new Error(`workflow_definition_trace_descriptor_trace_name_required:${workflowType}`);
  }
  if (!Array.isArray(descriptor.attribute_keys)) {
    throw new Error(`workflow_definition_trace_descriptor_attribute_keys_must_be_array:${workflowType}`);
  }
  for (const key of descriptor.attribute_keys) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error(`workflow_definition_trace_descriptor_attribute_keys_must_be_strings:${workflowType}`);
    }
  }
}

function validateOutcomeObservations(definition, workflowType) {
  const observations = definition.outcome_observations;
  if (observations === undefined) return;
  if (!Array.isArray(observations)) {
    throw new Error(`workflow_definition_outcome_observations_must_be_array:${workflowType}`);
  }
  const commitEffectsById = new Map(
    definition.commit_effects
      .filter((effect) => typeof effect?.id === "string" && effect.id.trim() !== "")
      .map((effect) => [effect.id, effect]),
  );
  for (const observation of observations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      throw new Error(`workflow_definition_outcome_observations_entries_must_be_objects:${workflowType}`);
    }
    if (typeof observation.id !== "string" || observation.id.trim() === "") {
      throw new Error(`workflow_definition_outcome_observations_id_required:${workflowType}`);
    }
    if (
      typeof observation.produced_identity_effect_id !== "string" ||
      observation.produced_identity_effect_id.trim() === ""
    ) {
      throw new Error(`workflow_definition_outcome_observations_produced_identity_effect_id_required:${workflowType}`);
    }
    const observedEffect = commitEffectsById.get(observation.produced_identity_effect_id);
    if (!observedEffect) {
      throw new Error(`workflow_definition_outcome_observations_produced_identity_effect_id_unknown:${workflowType}`);
    }
    if (!hasProducedIdentityProjector(observedEffect)) {
      throw new Error(`workflow_definition_outcome_observations_produced_identity_effect_id_without_projector:${workflowType}`);
    }
    if (observation.label !== undefined) {
      const validLabel =
        typeof observation.label === "string" ||
        (Array.isArray(observation.label) && observation.label.every((label) => typeof label === "string"));
      if (!validLabel) {
        throw new Error(`workflow_definition_outcome_observations_label_must_be_string_or_string_array:${workflowType}`);
      }
    }
  }
}

export function registerWorkflow(definition) {
  const workflowType = validateWorkflowDefinition(definition);
  WORKFLOW_DEFINITIONS_BY_TYPE.set(workflowType, definition);
}

export function resetRegistry() {
  WORKFLOW_DEFINITIONS_BY_TYPE.clear();
}

export function registeredWorkflowTypes() {
  return [...WORKFLOW_DEFINITIONS_BY_TYPE.keys()];
}

export function getWorkflowDefinition(workflowType) {
  const definition = WORKFLOW_DEFINITIONS_BY_TYPE.get(workflowType);
  if (!definition) throw new Error(`unknown_workflow_type:${workflowType}`);
  return definition;
}
