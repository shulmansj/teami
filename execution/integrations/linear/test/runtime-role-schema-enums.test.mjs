import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseControlAction } from "../../../engine/orchestrator-control-action.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { resolveInvocableRuntimeRoles } from "../src/runtime-adapters.mjs";
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

test("one-off runtime_role is schema-open; config is the source of truth enforced at parse", () => {
  // The generation schemas pin NO role list — a config-declared role must be
  // emittable without a schema edit. parseControlAction (fed the config-derived
  // set) is the floor.
  const controlAction = readJson(schemaPaths.controlAction);
  const turnOutput = readJson(schemaPaths.turnOutput);
  assert.equal(controlAction.properties.runtime_role.enum, undefined);
  assert.equal(controlAction.properties.runtime_role.type, "string");
  assert.equal(turnOutput.properties.control_action.properties.runtime_role.enum, undefined);
  assert.deepEqual(turnOutput.properties.control_action.properties.runtime_role.type, ["string", "null"]);

  const config = loadLinearConfig({ repoRoot });
  const invocableRoles = resolveInvocableRuntimeRoles(config, decompositionDefinition);
  assert.deepEqual([...invocableRoles].sort(), ["drafter", "judge", "pm", "sr_eng"]);
  assert.ok(!invocableRoles.includes(decompositionDefinition.driver));

  const oneOff = (runtime_role) =>
    parseControlAction(
      {
        action: "invoke_one_off",
        role_label: "Security researcher",
        task: "Assess the threat model",
        prompt: "Assess the threat model of the proposed change.",
        runtime_role,
      },
      { invocableRoles },
    );
  assert.equal(oneOff("sr_eng").ok, true);
  assert.equal(oneOff("orchestrator").ok, false);
  assert.equal(oneOff("not_configured_role").ok, false);
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
  const config = loadLinearConfig({ repoRoot });
  const invocableRoles = resolveInvocableRuntimeRoles(config, decompositionDefinition);
  assert.deepEqual(runtimeSessionRoleEnum(subagentTurn), STRICT_GENERATION_LIBRARY_RUNTIME_ROLES);
  assert.deepEqual(runtimeSessionRoleEnum(packetStrictGeneration), STRICT_GENERATION_LIBRARY_RUNTIME_ROLES);
  assert.ok(
    STRICT_GENERATION_LIBRARY_RUNTIME_ROLES.every((role) => invocableRoles.includes(role)),
  );
  assert.notDeepEqual(STRICT_GENERATION_LIBRARY_RUNTIME_ROLES, [...invocableRoles]);
});
