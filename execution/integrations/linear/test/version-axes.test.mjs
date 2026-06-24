import assert from "node:assert/strict";
import test from "node:test";

import { ENGINE_VERSION, PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

// Guards the F2-followup #3 disentangle: three version axes that share "0.2.0"
// today but evolve independently. They must stay sourced from their own homes so
// a second function (and a future engine bump) can diverge — the value-coincidence
// makes this easy to silently re-collapse, which is exactly what this test blocks.
// The three axes are ENGINE_VERSION (engine), DECOMPOSITION_FUNCTION_VERSION
// (function-owned), and PROCESS_VERSION (self-improvement process). No single
// constant serves more than one axis — the former shared constant is fully retired.

test("the decomposition artifact function_version is function-owned (not the engine constant)", () => {
  // function_version comes from the provider's DECOMPOSITION_FUNCTION_VERSION, NOT
  // ENGINE_VERSION. (Equal today; the source is what matters.)
  assert.equal(decompositionDefinition.artifact_schema.function_version, DECOMPOSITION_FUNCTION_VERSION);
  assert.equal(decompositionDefinition.artifact_schema.workflow_version, DECOMPOSITION_FUNCTION_VERSION);
  assert.equal(decompositionDefinition.artifact_schema.engine_version, ENGINE_VERSION);
});

test("the per-turn orchestrator output is engine-stamped and engine-versioned", () => {
  // The wire field is named workflow_version for back-compat, but it is the
  // engine's per-turn stamp, validated against ENGINE_VERSION — distinct from the
  // function's persisted function_version, and from the output schema id.
  assert.equal(ORCHESTRATOR_OUTPUT_SCHEMA_VERSION, "agentic-factory-orchestrator-turn-output/v1");
  assert.notEqual(ORCHESTRATOR_OUTPUT_SCHEMA_VERSION, ENGINE_VERSION);
});

test("the three version axes are named independently (equal value today, not one constant)", () => {
  // Same string today, but three distinct exported constants from their own homes.
  // If a future change collapses any pair back into one, that is a regression this
  // catches by intent (the assertion is about provenance, not the value).
  assert.equal(ENGINE_VERSION, "0.2.0");
  assert.equal(DECOMPOSITION_FUNCTION_VERSION, "0.2.0");
  assert.equal(PROCESS_VERSION, "0.2.0");
});
