import assert from "node:assert/strict";
import test from "node:test";

import {
  strictParseSubagentTurn,
} from "../src/runtime-adapters.mjs";
import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
} from "../../../engine/orchestrator-turn-contract.mjs";

const RUN_ID = "run-strict-subagent";

function validSubagentTurn(overrides = {}) {
  return {
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    run_id: RUN_ID,
    status: "continue",
    reason: "synthesis_complete",
    context_digest: "strict parse digest",
    source_refs: [],
    assumptions: [],
    constraints: [],
    risks: [],
    ...overrides,
  };
}

test("strictParseSubagentTurn accepts a clean valid packet", () => {
  const packet = validSubagentTurn();
  const result = strictParseSubagentTurn(JSON.stringify(packet), { runId: RUN_ID });

  assert.equal(result.ok, true);
  assert.equal(result.clean_parse, true);
  assert.deepEqual(result.packet, packet);
});

test("strictParseSubagentTurn accepts a clean claude result wrapper", () => {
  const packet = validSubagentTurn();
  const result = strictParseSubagentTurn(
    JSON.stringify({ result: JSON.stringify(packet) }),
    { runId: RUN_ID },
  );

  assert.equal(result.ok, true);
  assert.equal(result.clean_parse, true);
  assert.deepEqual(result.packet, packet);
});

test("strictParseSubagentTurn rejects a fenced (markdown) claude result wrapper", () => {
  const packet = validSubagentTurn();
  const fence = String.fromCharCode(96, 96, 96);
  const fencedResult = fence + "json\n" + JSON.stringify(packet) + "\n" + fence;
  const result = strictParseSubagentTurn(
    JSON.stringify({ result: fencedResult }),
    { runId: RUN_ID },
  );

  assert.equal(result.ok, false);
  assert.equal(result.clean_parse, false);
  assert.deepEqual(result.failureReasons, ["fenced_or_prose_result"]);
});

test("strictParseSubagentTurn rejects prose-wrapped salvageable output", () => {
  const packet = validSubagentTurn();
  const result = strictParseSubagentTurn(
    `diagnostic preamble\n${JSON.stringify(packet)}`,
    { runId: RUN_ID },
  );

  assert.equal(result.ok, false);
  assert.equal(result.clean_parse, false);
  assert.deepEqual(result.failureReasons, ["unclean_runtime_output"]);
});

test("strictParseSubagentTurn rejects clean but contract-invalid output", () => {
  const result = strictParseSubagentTurn(
    JSON.stringify(validSubagentTurn({ context_digest: "" })),
    { runId: RUN_ID },
  );

  assert.equal(result.ok, false);
  assert.equal(result.clean_parse, true);
  assert.ok(result.failureReasons.includes("missing_context_digest"));
});
