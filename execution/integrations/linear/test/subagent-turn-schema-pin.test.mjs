import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
  SUBAGENT_TURN_OUTCOMES,
  SUBAGENT_TURN_STATUSES,
} from "../../../engine/orchestrator-turn-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const lenientSchemaPath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "schemas",
  "subagent-turn.schema.json",
);
const strictGenerationSchemaPath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "schemas",
  "subagent-turn.strict-generation.schema.json",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asSortedSet(values) {
  return [...new Set(values)].sort();
}

function flattenedSubagentReasons() {
  return Object.values(SUBAGENT_TURN_OUTCOMES).flat();
}

function assertNoField(schema, field) {
  assert.ok(!schema.required.includes(field), `${field} must not be required`);
  assert.ok(!Object.hasOwn(schema.properties, field), `${field} must not be a property`);
}

test("subagent turn schemas are pinned to the code contract", () => {
  const lenient = readJson(lenientSchemaPath);
  const strict = readJson(strictGenerationSchemaPath);
  const coreFields = [
    "schema_version",
    "run_id",
    "status",
    "reason",
    "context_digest",
    "source_refs",
    "assumptions",
    "constraints",
    "risks",
  ];

  assert.equal(lenient.$id, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.equal(lenient.properties.schema_version.const, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(asSortedSet(lenient.required), asSortedSet(coreFields));
  assert.deepEqual(asSortedSet(lenient.properties.status.enum), asSortedSet(SUBAGENT_TURN_STATUSES));
  assert.deepEqual(asSortedSet(lenient.properties.reason.enum), asSortedSet(flattenedSubagentReasons()));
  assertNoField(lenient, "phase");
  assertNoField(lenient, "evidence");

  assert.equal(strict.$id, "linear-decomposition-orchestrator-subagent-turn/strict-generation/v1");
  assert.notEqual(strict.$id, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.equal(strict.properties.schema_version.const, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(asSortedSet(strict.properties.status.enum), asSortedSet(SUBAGENT_TURN_STATUSES));
  assert.deepEqual(asSortedSet(strict.properties.reason.enum), asSortedSet(flattenedSubagentReasons()));
  assert.deepEqual(asSortedSet(strict.required), asSortedSet(Object.keys(strict.properties)));
  assert.equal(strict.additionalProperties, false);
  assert.equal(lenient.additionalProperties, true);
  assertNoField(strict, "phase");
  assertNoField(strict, "evidence");

  assert.ok(!path.basename(lenientSchemaPath).includes("turn-output"));
  assert.ok(!path.basename(strictGenerationSchemaPath).includes("turn-output"));
});
