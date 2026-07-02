import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTROL_ACTION_KINDS,
  CONTROL_ACTION_SCHEMA_VERSION,
  ONE_OFF_RUNTIME_ROLES,
  TERMINATE_OUTCOMES,
  TERMINATE_OUTCOME_REASONS,
  parseControlAction,
} from "../../../engine/orchestrator-control-action.mjs";
import {
  AGENT_CHOOSABLE_OUTCOME_REASONS,
  GENERIC_CORE_OUTCOMES,
  GENERIC_CORE_OUTCOME_REASONS,
  deriveAgentChoosableOutcomeReasons,
} from "../../../engine/orchestrator-terminal-vocabulary.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

test("the schema is versioned and exposes exactly three action kinds", () => {
  assert.equal(
    CONTROL_ACTION_SCHEMA_VERSION,
    "teami-orchestrator-control-action/v1",
  );
  assert.deepEqual(CONTROL_ACTION_KINDS, [
    "invoke_library",
    "invoke_one_off",
    "terminate",
  ]);
});

test("control-action generation schema id matches the runtime schema version", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../schemas/orchestrator-control-action.schema.json", import.meta.url),
    "utf8",
  ));

  assert.equal(schema.$id, CONTROL_ACTION_SCHEMA_VERSION);
});

test("the one-off runtime_role whitelist mirrors definition.invocable_runtime_roles (no orchestrator)", () => {
  // Plan-exact literal stamp: pm|sr_eng|judge|drafter. The orchestrator's OWN
  // runtime is the driver's runtime, never a one-off target, so it must be absent.
  assert.deepEqual(ONE_OFF_RUNTIME_ROLES, decompositionDefinition.invocable_runtime_roles);
  assert.deepEqual(ONE_OFF_RUNTIME_ROLES, ["pm", "sr_eng", "judge", "drafter"]);
  assert.deepEqual(decompositionDefinition.invocable_runtime_roles, ["pm", "sr_eng", "judge", "drafter"]);
  assert.ok(!ONE_OFF_RUNTIME_ROLES.includes("orchestrator"));
});

test("the driver is never an invocable one-off target", () => {
  assert.equal(decompositionDefinition.driver, "orchestrator");
  assert.ok(!decompositionDefinition.invocable_runtime_roles.includes(decompositionDefinition.driver));

  const result = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "driver-check",
      task: "Check the driver path",
      prompt: "Check only the driver path.",
      runtime_role: decompositionDefinition.driver,
    },
    { invocableRoles: decompositionDefinition.invocable_runtime_roles },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [
    `invoke_one_off_invalid_runtime_role:${decompositionDefinition.driver}`,
  ]);
});

test("terminate outcome reasons are derived from the generic core vocabulary", () => {
  const previousAgentChoosableSubset = {
    commit: ["synthesis_complete"],
    pause: ["product_questions", "discovery_needed", "needs_pm_review"],
  };

  assert.deepEqual(GENERIC_CORE_OUTCOMES, ["commit", "pause", "failed_closed"]);
  assert.deepEqual(Object.keys(GENERIC_CORE_OUTCOME_REASONS), GENERIC_CORE_OUTCOMES);
  assert.deepEqual(
    deriveAgentChoosableOutcomeReasons(GENERIC_CORE_OUTCOME_REASONS),
    previousAgentChoosableSubset,
  );
  assert.deepEqual(AGENT_CHOOSABLE_OUTCOME_REASONS, previousAgentChoosableSubset);
  assert.deepEqual(TERMINATE_OUTCOME_REASONS, previousAgentChoosableSubset);
});

test("invoke_library parses a valid target_key", () => {
  const result = parseControlAction({
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_synthesis",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_synthesis",
  });
});

test("invoke_library parses an optional instance_id", () => {
  const result = parseControlAction({
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_synthesis",
    instance_id: "pm#parallel_a",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_synthesis",
    instance_id: "pm#parallel_a",
  });
});

test("invoke_library rejects a missing target_key", () => {
  const result = parseControlAction({ action: "invoke_library" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["invoke_library_missing_target_key"]);
});

test("invoke_one_off parses all required fields and a whitelisted runtime_role", () => {
  for (const runtime_role of decompositionDefinition.invocable_runtime_roles) {
    const result = parseControlAction(
      {
        action: "invoke_one_off",
        role_label: "domain-lens",
        task: "Assess regulatory constraints",
        prompt: "You are a compliance reviewer...",
        runtime_role,
      },
      { invocableRoles: decompositionDefinition.invocable_runtime_roles },
    );
    assert.equal(result.ok, true, runtime_role);
    assert.equal(result.action.action, "invoke_one_off");
    assert.equal(result.action.role_label, "domain-lens");
    assert.equal(result.action.runtime_role, runtime_role);
  }
});

test("invoke_one_off parses optional instance_id and still accepts role-only default addressing", () => {
  const withInstance = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "domain-lens",
      task: "Assess regulatory constraints",
      prompt: "You are a compliance reviewer...",
      runtime_role: "pm",
      instance_id: "pm#parallel_a",
    },
    { invocableRoles: decompositionDefinition.invocable_runtime_roles },
  );
  assert.equal(withInstance.ok, true);
  assert.equal(withInstance.action.instance_id, "pm#parallel_a");

  const roleOnly = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "domain-lens",
      task: "Assess regulatory constraints",
      prompt: "You are a compliance reviewer...",
      runtime_role: "pm",
    },
    { invocableRoles: decompositionDefinition.invocable_runtime_roles },
  );
  assert.equal(roleOnly.ok, true);
  assert.equal(Object.hasOwn(roleOnly.action, "instance_id"), false);
});

test("invoke_one_off rejects unsafe or role-mismatched instance_id values", () => {
  const invalid = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "domain-lens",
      task: "Assess regulatory constraints",
      prompt: "You are a compliance reviewer...",
      runtime_role: "pm",
      instance_id: "bad/path",
    },
    { invocableRoles: decompositionDefinition.invocable_runtime_roles },
  );
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.reasons, ["invoke_one_off_invalid_instance_id"]);

  const mismatched = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "domain-lens",
      task: "Assess regulatory constraints",
      prompt: "You are a compliance reviewer...",
      runtime_role: "pm",
      instance_id: "sr_eng#parallel_a",
    },
    { invocableRoles: decompositionDefinition.invocable_runtime_roles },
  );
  assert.equal(mismatched.ok, false);
  assert.deepEqual(mismatched.reasons, [
    "invoke_one_off_instance_id_role_mismatch:sr_eng#parallel_a",
  ]);
});

test("invoke_one_off rejects a runtime_role outside the whitelist (incl. orchestrator)", () => {
  for (const bad of ["orchestrator", "captain", ""]) {
    const result = parseControlAction(
      {
        action: "invoke_one_off",
        role_label: "x",
        task: "t",
        prompt: "p",
        runtime_role: bad,
      },
      { invocableRoles: decompositionDefinition.invocable_runtime_roles },
    );
    assert.equal(result.ok, false, bad);
    assert.ok(
      result.reasons.some((r) => r.startsWith("invoke_one_off_invalid_runtime_role")
        || r === "invoke_one_off_missing_runtime_role"),
      `${bad}: ${result.reasons.join(",")}`,
    );
  }
});

test("parseControlAction binds one-off runtime_role validation to injected invocable role data", () => {
  const widenedInvocableRoles = [...decompositionDefinition.invocable_runtime_roles];
  widenedInvocableRoles.push("orchestrator");
  const widened = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "driver-check",
      task: "Check the driver path",
      prompt: "Check only the driver path.",
      runtime_role: "orchestrator",
    },
    { invocableRoles: widenedInvocableRoles },
  );
  assert.equal(widened.ok, true);
  assert.equal(widened.action.runtime_role, "orchestrator");

  const narrowedInvocableRoles = decompositionDefinition.invocable_runtime_roles
    .filter((role) => role !== "pm");
  const narrowed = parseControlAction(
    {
      action: "invoke_one_off",
      role_label: "pm-check",
      task: "Check the PM path",
      prompt: "Check only the PM path.",
      runtime_role: "pm",
    },
    { invocableRoles: narrowedInvocableRoles },
  );
  assert.equal(narrowed.ok, false);
  assert.deepEqual(narrowed.reasons, ["invoke_one_off_invalid_runtime_role:pm"]);
});

test("invoke_one_off rejects missing required fields", () => {
  const result = parseControlAction({
    action: "invoke_one_off",
    runtime_role: "pm",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.sort(), [
    "invoke_one_off_missing_prompt",
    "invoke_one_off_missing_role_label",
    "invoke_one_off_missing_task",
  ]);
});

test("terminate is EXACTLY { outcome, reason } and parses a valid pair", () => {
  assert.deepEqual(TERMINATE_OUTCOMES, ["commit", "pause"]);
  const result = parseControlAction({
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action, {
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
  });
});

test("terminate accepts every allowed (outcome, reason) pair", () => {
  for (const [outcome, reasons] of Object.entries(TERMINATE_OUTCOME_REASONS)) {
    for (const reason of reasons) {
      const result = parseControlAction({ action: "terminate", outcome, reason });
      assert.equal(result.ok, true, `${outcome}/${reason}`);
    }
  }
});

test("terminate rejects ANY extra field (no terminal-source smuggling)", () => {
  const result = parseControlAction({
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
    terminal_source_turn_id: "turn-7",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("terminate_unexpected_field:terminal_source_turn_id"));
});

test("terminate rejects failed_closed (harness-emitted, never the orchestrator)", () => {
  const result = parseControlAction({
    action: "terminate",
    outcome: "failed_closed",
    reason: "bounds_breach",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith("terminate_invalid_outcome")));
});

test("terminate rejects a reason that does not belong to the outcome", () => {
  const result = parseControlAction({
    action: "terminate",
    outcome: "commit",
    reason: "product_questions",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith("terminate_invalid_reason:commit:product_questions")));
});

test("parseControlAction rejects a non-object and an unknown action", () => {
  assert.deepEqual(parseControlAction(null).reasons, ["control_action_not_object"]);
  assert.deepEqual(parseControlAction("invoke_library").reasons, ["control_action_not_object"]);
  assert.deepEqual(parseControlAction({}).reasons, ["control_action_missing_action"]);
  const unknown = parseControlAction({ action: "spawn_swarm" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.reasons[0].startsWith("control_action_unknown_action:spawn_swarm"));
});
