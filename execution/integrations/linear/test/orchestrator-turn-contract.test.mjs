import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
  SUBAGENT_TURN_OUTCOMES,
  SUBAGENT_TURN_STATUSES,
  isAllowedSubagentOutcome,
  validateSubagentTurnContract,
} from "../../../engine/orchestrator-turn-contract.mjs";

const RUN_ID = "run-subagent-1";

function validTurn(overrides = {}) {
  return {
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    run_id: RUN_ID,
    status: "continue",
    reason: "synthesis_complete",
    context_digest: "digest",
    source_refs: [],
    assumptions: [],
    constraints: [],
    risks: [],
    ...overrides,
  };
}

test("the allowed set is role-agnostic: the literal union, no per-position tuples", () => {
  // The flattened union across all four library personas, by status. This is the
  // role-agnostic contract: a turn is judged by WHAT it reports, not WHERE it sits.
  assert.deepEqual(SUBAGENT_TURN_STATUSES, ["continue", "blocked"]);
  assert.deepEqual(SUBAGENT_TURN_OUTCOMES.continue, [
    "product_context_sufficient",
    "technical_context_grounded",
    "synthesis_complete",
    "no_blockers",
  ]);
  assert.deepEqual(SUBAGENT_TURN_OUTCOMES.blocked, [
    "needs_product_input",
    "needs_discovery",
    "needs_constraint_decision",
  ]);
});

test("isAllowedSubagentOutcome accepts every union tuple and rejects cross-status pairings", () => {
  for (const [status, reasons] of Object.entries(SUBAGENT_TURN_OUTCOMES)) {
    for (const reason of reasons) {
      assert.equal(isAllowedSubagentOutcome({ status, reason }), true, `${status}/${reason}`);
    }
  }
  // A reason valid for ONE status is not valid for another (no_blockers is a
  // continue reason, not a blocked reason).
  assert.equal(isAllowedSubagentOutcome({ status: "blocked", reason: "no_blockers" }), false);
  assert.equal(isAllowedSubagentOutcome({ status: "continue", reason: "needs_discovery" }), false);
  assert.equal(isAllowedSubagentOutcome({ status: "made_up", reason: "synthesis_complete" }), false);
});

test("validateSubagentTurnContract accepts a valid role-agnostic turn (no expectedPhase)", () => {
  for (const [status, reasons] of Object.entries(SUBAGENT_TURN_OUTCOMES)) {
    for (const reason of reasons) {
      const result = validateSubagentTurnContract(validTurn({ status, reason }), { runId: RUN_ID });
      assert.deepEqual(result, { ok: true, failureReasons: [] }, `${status}/${reason}`);
    }
  }
});

test("validateSubagentTurnContract rejects an invalid (status, reason) tuple", () => {
  const result = validateSubagentTurnContract(
    validTurn({ status: "blocked", reason: "no_blockers" }),
    { runId: RUN_ID },
  );
  assert.equal(result.ok, false);
  assert.ok(result.failureReasons.includes("invalid_status_reason:blocked:no_blockers"));
});

test("validateSubagentTurnContract enforces identity and envelope fields", () => {
  assert.deepEqual(validateSubagentTurnContract(null).failureReasons, ["missing_subagent_turn"]);

  const wrongSchema = validateSubagentTurnContract(
    validTurn({ schema_version: "something-else" }),
    { runId: RUN_ID },
  );
  assert.ok(wrongSchema.failureReasons.includes("invalid_subagent_turn_schema_version"));

  const wrongRun = validateSubagentTurnContract(validTurn({ run_id: "other" }), { runId: RUN_ID });
  assert.ok(wrongRun.failureReasons.includes("run_id_mismatch"));

  const missingArrays = validateSubagentTurnContract(
    validTurn({ source_refs: undefined, risks: "nope" }),
    { runId: RUN_ID },
  );
  assert.ok(missingArrays.failureReasons.includes("missing_source_refs"));
  assert.ok(missingArrays.failureReasons.includes("missing_risks"));

  const missingDigest = validateSubagentTurnContract(
    validTurn({ context_digest: "" }),
    { runId: RUN_ID },
  );
  assert.ok(missingDigest.failureReasons.includes("missing_context_digest"));
});
