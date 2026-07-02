import assert from "node:assert/strict";
import test from "node:test";

import {
  registerWorkflow,
  resetRegistry,
  registeredWorkflowTypes,
  getWorkflowDefinition,
  validateWorkflowDefinition,
} from "../../../engine/workflow-registry.mjs";

// A minimal definition that satisfies every engine-contract field the registry
// validates. Each failure case below clones this and breaks exactly one field.
function validDefinition(overrides = {}) {
  return {
    workflow_type: "probe",
    run: async () => ({ status: "noop" }),
    triggers: [],
    roles: ["worker", "orchestrator"],
    invocable_runtime_roles: ["worker"],
    runtime_assignment_roles: ["worker", "orchestrator"],
    commit_effects: [{
      id: "linear_issues",
      provider: "linear",
      op: "create_issues",
      producedIdentity: {
        resource_kind: "linear_issue",
        target_ids: (identity) => identity?.ids || [],
        identity: (identity) => ({ ids: identity?.ids || [] }),
      },
    }],
    driver: "orchestrator",
    driver_governing_target_key: "prompt/probe/orchestrator_governing",
    eval_namespace: "test/fixtures/probe",
    commitPayload: {
      assembleCommitPayload: () => ({}),
      validateCommitPayload: () => ({ ok: true, failureReasons: [] }),
      qualityGateInput: () => null,
    },
    artifact_schema: { schema_version: "x", kinds: [] },
    ...overrides,
  };
}

test("registerWorkflow indexes a complete definition by workflow_type", () => {
  resetRegistry();
  const definition = validDefinition();
  registerWorkflow(definition);
  assert.deepEqual(registeredWorkflowTypes(), ["probe"]);
  assert.equal(getWorkflowDefinition("probe"), definition);
  resetRegistry();
});

test("validateWorkflowDefinition returns the workflow_type for a valid definition", () => {
  assert.equal(validateWorkflowDefinition(validDefinition()), "probe");
});

test("registerWorkflow accepts an optional outcome_observations declaration", () => {
  resetRegistry();
  const definition = validDefinition({
    outcome_observations: [
      {
        id: "issue_resolution_observed",
        produced_identity_effect_id: "linear_issues",
        label: "Issue resolution observed",
      },
      {
        id: "issue_state_observed",
        produced_identity_effect_id: "linear_issues",
        label: ["Issue state", "Linear state"],
      },
      {
        id: "issue_owner_observed",
        produced_identity_effect_id: "linear_issues",
      },
    ],
  });
  registerWorkflow(definition);
  assert.deepEqual(registeredWorkflowTypes(), ["probe"]);
  assert.equal(getWorkflowDefinition("probe"), definition);
  resetRegistry();
});

const FAILURE_CASES = [
  ["null definition", null, "workflow_definition_required"],
  ["non-object definition", 42, "workflow_definition_required"],
  ["missing workflow_type", validDefinition({ workflow_type: "" }), "workflow_definition_workflow_type_required"],
  ["non-string workflow_type", validDefinition({ workflow_type: 7 }), "workflow_definition_workflow_type_required"],
  ["non-function run", validDefinition({ run: "nope" }), "workflow_definition_run_required:probe"],
  ["non-array triggers", validDefinition({ triggers: {} }), "workflow_definition_triggers_must_be_array:probe"],
  ["non-array roles", validDefinition({ roles: "pm" }), "workflow_definition_roles_must_be_array:probe"],
  [
    "non-array invocable_runtime_roles",
    validDefinition({ invocable_runtime_roles: null }),
    "workflow_definition_invocable_runtime_roles_must_be_array:probe",
  ],
  [
    "non-array runtime_assignment_roles",
    validDefinition({ runtime_assignment_roles: 1 }),
    "workflow_definition_runtime_assignment_roles_must_be_array:probe",
  ],
  ["non-array commit_effects", validDefinition({ commit_effects: "x" }), "workflow_definition_commit_effects_must_be_array:probe"],
  ["empty driver", validDefinition({ driver: "" }), "workflow_definition_driver_required:probe"],
  [
    "empty driver_governing_target_key",
    validDefinition({ driver_governing_target_key: "  " }),
    "workflow_definition_driver_governing_target_key_required:probe",
  ],
  ["empty eval_namespace", validDefinition({ eval_namespace: "" }), "workflow_definition_eval_namespace_required:probe"],
  ["missing commitPayload", validDefinition({ commitPayload: null }), "workflow_definition_commitPayload_required:probe"],
  [
    "commitPayload missing assembleCommitPayload",
    validDefinition({ commitPayload: { validateCommitPayload: () => ({}), qualityGateInput: () => null } }),
    "workflow_definition_commitPayload_assembleCommitPayload_required:probe",
  ],
  [
    "commitPayload missing qualityGateInput",
    validDefinition({
      commitPayload: { assembleCommitPayload: () => ({}), validateCommitPayload: () => ({}) },
    }),
    "workflow_definition_commitPayload_qualityGateInput_required:probe",
  ],
  ["missing artifact_schema", validDefinition({ artifact_schema: null }), "workflow_definition_artifact_schema_required:probe"],
  [
    "non-object trace_descriptor",
    validDefinition({ trace_descriptor: "probe" }),
    "workflow_definition_trace_descriptor_must_be_object:probe",
  ],
  [
    "empty trace_descriptor trace_name",
    validDefinition({ trace_descriptor: { trace_name: "", attribute_keys: [] } }),
    "workflow_definition_trace_descriptor_trace_name_required:probe",
  ],
  [
    "non-array trace_descriptor attribute_keys",
    validDefinition({ trace_descriptor: { trace_name: "probe_trace", attribute_keys: null } }),
    "workflow_definition_trace_descriptor_attribute_keys_must_be_array:probe",
  ],
  [
    "non-string trace_descriptor attribute key",
    validDefinition({ trace_descriptor: { trace_name: "probe_trace", attribute_keys: ["workflow.name", ""] } }),
    "workflow_definition_trace_descriptor_attribute_keys_must_be_strings:probe",
  ],
  [
    "non-array outcome_observations",
    validDefinition({ outcome_observations: {} }),
    "workflow_definition_outcome_observations_must_be_array:probe",
  ],
  [
    "non-object outcome_observations entry",
    validDefinition({ outcome_observations: ["issue_resolution_observed"] }),
    "workflow_definition_outcome_observations_entries_must_be_objects:probe",
  ],
  [
    "empty outcome_observations id",
    validDefinition({ outcome_observations: [{ id: "", produced_identity_effect_id: "linear_issues" }] }),
    "workflow_definition_outcome_observations_id_required:probe",
  ],
  [
    "empty outcome_observations produced_identity_effect_id",
    validDefinition({ outcome_observations: [{ id: "issue_resolution_observed", produced_identity_effect_id: " " }] }),
    "workflow_definition_outcome_observations_produced_identity_effect_id_required:probe",
  ],
  [
    "invalid outcome_observations label",
    validDefinition({
      outcome_observations: [
        { id: "issue_resolution_observed", produced_identity_effect_id: "linear_issues", label: ["ok", 7] },
      ],
    }),
    "workflow_definition_outcome_observations_label_must_be_string_or_string_array:probe",
  ],
];

for (const [label, definition, expectedMessage] of FAILURE_CASES) {
  test(`registerWorkflow rejects ${label}`, () => {
    resetRegistry();
    assert.throws(() => registerWorkflow(definition), { message: expectedMessage });
    assert.deepEqual(registeredWorkflowTypes(), [], "a rejected definition must not be indexed");
    resetRegistry();
  });
}
