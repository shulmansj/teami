import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  loadLinearConfig,
  validateLinearConfig,
} from "../src/config.mjs";
import {
  resolveJudgeRuntimeAssignment,
  resolveRoleRuntimeAssignments,
} from "../src/runtime-adapters.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const SYNTHETIC_WORKFLOW_TYPE = "runtime_gen_synthetic";

test("decomposition runtime assignments stay pinned when workflowType is explicit", () => {
  const config = loadLinearConfig({ repoRoot });
  assert.equal(validateLinearConfig(config, "config", { repoRoot }), true);

  const assignments = resolveRoleRuntimeAssignments(config, "decomposition");
  assert.deepEqual(Object.keys(assignments).sort(), [
    "drafter",
    "judge",
    "orchestrator",
    "pm",
    "sr_eng",
  ]);

  assert.deepEqual(assignments.pm, {
    role: "pm",
    runtime: "claude",
    model: "claude-opus-4-8",
    command: "claude",
    cli_args_prefix: [],
    schema_path: "execution/integrations/linear/schemas/subagent-turn.schema.json",
    generation_schema_path: "execution/integrations/linear/schemas/subagent-turn.schema.json",
    local_schema_version: "linear-decomposition-orchestrator-subagent-turn/v2",
    warm_continuation: { enabled: false, required: false },
    capabilities: { persisted_session_handles: false },
    version: null,
    tool_policy: {
      linear_write: false,
      project_mutation: "runner_only",
      issue_mutation: "runner_only",
    },
  });
  assert.deepEqual(assignments.sr_eng, {
    role: "sr_eng",
    runtime: "codex",
    model: "gpt-5.5",
    command: "codex",
    cli_args_prefix: ["-c", "service_tier=\"fast\""],
    schema_path: "execution/integrations/linear/schemas/subagent-turn.schema.json",
    generation_schema_path: "execution/integrations/linear/schemas/subagent-turn.strict-generation.schema.json",
    local_schema_version: "linear-decomposition-orchestrator-subagent-turn/v2",
    warm_continuation: { enabled: false, required: false },
    capabilities: { persisted_session_handles: false },
    version: null,
    tool_policy: {
      linear_write: false,
      project_mutation: "runner_only",
      issue_mutation: "runner_only",
    },
  });

  for (const role of ["judge", "drafter", "orchestrator"]) {
    assert.equal(assignments[role].role, role);
    assert.equal(assignments[role].runtime, "claude");
    assert.equal(assignments[role].model, "claude-opus-4-8");
    assert.equal(assignments[role].tool_policy.linear_write, false);
    assert.equal(assignments[role].tool_policy.project_mutation, "runner_only");
    assert.equal(assignments[role].tool_policy.issue_mutation, "runner_only");
    assert.deepEqual(assignments[role].warm_continuation, { enabled: false, required: false });
    assert.deepEqual(assignments[role].capabilities, { persisted_session_handles: false });
  }
});

test("resolveRoleRuntimeAssignments requires workflowType", () => {
  const config = loadLinearConfig({ repoRoot });
  assert.throws(
    () => resolveRoleRuntimeAssignments(config),
    /resolveRoleRuntimeAssignments_workflow_type_required/,
  );
});

test("resolveJudgeRuntimeAssignment derives the evaluator role from the requested workflow definition", () => {
  const workflowType = "runtime_judge_synthetic";
  const registrySnapshot = registeredWorkflowTypes().map((type) => getWorkflowDefinition(type));
  try {
    registerWorkflow({
      workflow_type: workflowType,
      run: async () => {},
      triggers: [],
      roles: ["worker", "quality_evaluator", "driver"],
      invocable_runtime_roles: ["worker", "quality_evaluator"],
      runtime_assignment_roles: ["worker", "quality_evaluator", "driver"],
      engine_owned_evaluator_roles: ["quality_evaluator"],
      commit_effects: [],
      driver: "driver",
      driver_governing_target_key: "prompt/runtime_judge_synthetic/driver_governing",
      eval_namespace: "execution/evals/runtime_judge_synthetic",
      commitPayload: {
        assembleCommitPayload: () => ({}),
        validateCommitPayload: () => true,
        qualityGateInput: () => ({}),
      },
      artifact_schema: {
        schema_version: "runtime-judge-synthetic/v1",
      },
    });

    const definition = getWorkflowDefinition(workflowType);
    const config = {
      workflows: {
        [workflowType]: {
          roles: {
            quality_evaluator: { runtime: "fake", model: "judge-model" },
          },
          role_field_sources: {
            quality_evaluator: { runtime: "accepted_defaults", model: "accepted_defaults" },
          },
        },
      },
    };

    const assignment = resolveJudgeRuntimeAssignment(config, definition);
    assert.equal(assignment.role, "quality_evaluator");
    assert.equal(assignment.runtime, "fake");
    assert.equal(assignment.model, "judge-model");
    assert.deepEqual(assignment.warm_continuation, { enabled: false, required: false });
  } finally {
    resetRegistry();
    for (const definition of registrySnapshot) registerWorkflow(definition);
  }
});

test("runtime assignments derive role keys from the requested workflow definition", () => {
  assert.equal(typeof resetRegistry, "function");
  // validateLinearConfig now iterates every registered workflow, so the synthetic
  // workflow registered here would leak into later test files under shared-process
  // (--test-isolation=none) execution. Snapshot the registry and restore it.
  const registrySnapshot = registeredWorkflowTypes().map((type) => getWorkflowDefinition(type));
  try {
    registerWorkflow({
      workflow_type: SYNTHETIC_WORKFLOW_TYPE,
      run: async () => {},
      triggers: [],
      roles: ["alpha", "beta"],
      invocable_runtime_roles: ["alpha"],
      runtime_assignment_roles: ["alpha", "beta"],
      engine_owned_evaluator_roles: [],
      commit_effects: [],
      driver: "alpha",
      driver_governing_target_key: "prompt/runtime_gen_synthetic/alpha_governing",
      eval_namespace: "execution/evals/runtime_gen_synthetic",
      commitPayload: {
        assembleCommitPayload: () => ({}),
        validateCommitPayload: () => true,
        qualityGateInput: () => ({}),
      },
      artifact_schema: {
        schema_version: "runtime-gen-synthetic/v1",
      },
    });

    assert.ok(registeredWorkflowTypes().includes("decomposition"));
    assert.ok(registeredWorkflowTypes().includes(SYNTHETIC_WORKFLOW_TYPE));
    assert.deepEqual(
      getWorkflowDefinition(SYNTHETIC_WORKFLOW_TYPE).runtime_assignment_roles,
      ["alpha", "beta"],
    );

    const syntheticConfig = {
      runtime: {
        default_invocation: "session_start",
        adapters: {
          claude: { command: "claude" },
          codex: { command: "codex" },
        },
      },
      workflows: {
        [SYNTHETIC_WORKFLOW_TYPE]: {
          roles: {
            alpha: { runtime: "claude", model: "alpha-model" },
            beta: { runtime: "codex", model: "beta-model" },
          },
        },
      },
    };

    const assignments = resolveRoleRuntimeAssignments(syntheticConfig, SYNTHETIC_WORKFLOW_TYPE);
    assert.deepEqual(Object.keys(assignments).sort(), ["alpha", "beta"]);
    assert.equal(assignments.pm, undefined);
    assert.equal(assignments.sr_eng, undefined);
    assert.equal(assignments.alpha.role, "alpha");
    assert.equal(assignments.alpha.runtime, "claude");
    assert.equal(assignments.alpha.model, "alpha-model");
    assert.equal(assignments.alpha.tool_policy.linear_write, false);
    assert.equal(assignments.beta.role, "beta");
    assert.equal(assignments.beta.runtime, "codex");
    assert.equal(assignments.beta.model, "beta-model");
    assert.equal(assignments.beta.tool_policy.linear_write, false);
  } finally {
    resetRegistry();
    for (const definition of registrySnapshot) registerWorkflow(definition);
  }
});
