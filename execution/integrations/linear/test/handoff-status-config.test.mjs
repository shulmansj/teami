import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
  validateWorkflowDefinition,
} from "../../../engine/workflow-registry.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const HANDOFF_WORKFLOW_TYPE = "handoff_status_probe";

function validDefinition(overrides = {}) {
  return {
    workflow_type: HANDOFF_WORKFLOW_TYPE,
    run: async () => ({ status: "noop" }),
    triggers: [],
    roles: ["worker", "orchestrator"],
    invocable_runtime_roles: ["worker"],
    runtime_assignment_roles: ["worker", "orchestrator"],
    commit_effects: [],
    driver: "orchestrator",
    driver_governing_target_key: "prompt/handoff_status_probe/orchestrator_governing",
    eval_namespace: "execution/evals/handoff_status_probe",
    commitPayload: {
      assembleCommitPayload: () => ({}),
      validateCommitPayload: () => ({ ok: true, failureReasons: [] }),
      qualityGateInput: () => null,
    },
    artifact_schema: { schema_version: "handoff-status-probe/v1", kinds: [] },
    ...overrides,
  };
}

function snapshotRegistry() {
  return registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
}

function restoreRegistry(definitions) {
  resetRegistry();
  for (const definition of definitions) registerWorkflow(definition);
}

test("workflow definitions may declare input/output Linear status names", () => {
  const registrySnapshot = snapshotRegistry();
  const definition = validDefinition({
    input_status: "Ready",
    output_status: "In Review",
  });

  try {
    assert.equal(validateWorkflowDefinition(definition), HANDOFF_WORKFLOW_TYPE);
    registerWorkflow(definition);
    assert.ok(registeredWorkflowTypes().includes(HANDOFF_WORKFLOW_TYPE));
    assert.equal(getWorkflowDefinition(HANDOFF_WORKFLOW_TYPE), definition);
  } finally {
    restoreRegistry(registrySnapshot);
  }
});

const INVALID_STATUS_CASES = [
  [
    "empty input_status",
    { input_status: "" },
    `workflow_definition_input_status_required:${HANDOFF_WORKFLOW_TYPE}`,
  ],
  [
    "non-string output_status",
    { output_status: 7 },
    `workflow_definition_output_status_required:${HANDOFF_WORKFLOW_TYPE}`,
  ],
];

for (const [label, overrides, expectedMessage] of INVALID_STATUS_CASES) {
  test(`validateWorkflowDefinition rejects ${label}`, () => {
    assert.throws(
      () => validateWorkflowDefinition(validDefinition(overrides)),
      { message: expectedMessage },
    );
  });
}

test("decomposition declares Planned input status and still validates", () => {
  assert.equal(decompositionDefinition.input_status, "Planned");
  assert.equal(Object.hasOwn(decompositionDefinition, "output_status"), false);
  assert.equal(validateWorkflowDefinition(decompositionDefinition), "decomposition");
  assert.deepEqual(
    decompositionDefinition.triggers.map((trigger) => trigger.trigger_type),
    ["linear.project.planned"],
  );
});
