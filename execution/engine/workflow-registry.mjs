const WORKFLOW_DEFINITIONS_BY_TYPE = new Map();

const REQUIRED_DEFINITION_ARRAY_FIELDS = Object.freeze([
  "triggers",
  "roles",
  "invocable_runtime_roles",
  "runtime_assignment_roles",
  "commit_effects",
]);
const REQUIRED_DEFINITION_STRING_FIELDS = Object.freeze([
  "driver",
  "driver_governing_target_key",
  "eval_namespace",
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
  return workflowType;
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
