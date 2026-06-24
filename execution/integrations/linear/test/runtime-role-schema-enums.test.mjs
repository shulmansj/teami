import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

const schemaPaths = {
  controlAction: path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "orchestrator-control-action.schema.json",
  ),
  turnOutput: path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "orchestrator-turn-output.schema.json",
  ),
  subagentTurnStrictGeneration: path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "subagent-turn.strict-generation.schema.json",
  ),
};

const STRICT_GENERATION_LIBRARY_RUNTIME_ROLES = ["pm", "sr_eng"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runtimeSessionRoleEnum(schema) {
  return schema.properties.runtime_session_handle.properties.role.enum;
}

test("orchestrator one-off runtime_role schema enums mirror the invocable role facet", () => {
  const expected = [...decompositionDefinition.invocable_runtime_roles];
  const controlAction = readJson(schemaPaths.controlAction);
  const turnOutput = readJson(schemaPaths.turnOutput);

  assert.deepEqual(controlAction.properties.runtime_role.enum, expected);
  assert.deepEqual(turnOutput.properties.control_action.properties.runtime_role.enum, expected);
});

test("strict-generation runtime session handles deliberately stay on the library subset", () => {
  const subagentTurn = readJson(schemaPaths.subagentTurnStrictGeneration);
  const packetStrictGeneration = readJson(
    path.join(
      repoRoot,
      decompositionDefinition.packet_schema.schema_paths.find((schemaPath) =>
        schemaPath.endsWith(".strict-generation.schema.json"),
      ),
    ),
  );

  // This is not the invocable runtime-role facet. These strict-generation
  // schemas constrain the library subagent packet producers, which are still
  // the pm/sr_eng runtime personas.
  assert.deepEqual(runtimeSessionRoleEnum(subagentTurn), STRICT_GENERATION_LIBRARY_RUNTIME_ROLES);
  assert.deepEqual(runtimeSessionRoleEnum(packetStrictGeneration), STRICT_GENERATION_LIBRARY_RUNTIME_ROLES);
  assert.ok(
    STRICT_GENERATION_LIBRARY_RUNTIME_ROLES.every((role) =>
      decompositionDefinition.invocable_runtime_roles.includes(role),
    ),
  );
  assert.notDeepEqual(STRICT_GENERATION_LIBRARY_RUNTIME_ROLES, [
    ...decompositionDefinition.invocable_runtime_roles,
  ]);
});
