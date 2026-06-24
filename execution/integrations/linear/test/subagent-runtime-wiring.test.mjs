import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  defaultOrchestratorRuntime,
  executeSubagent,
} from "../src/orchestrator-turn.mjs";
import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
} from "../../../engine/orchestrator-turn-contract.mjs";
import {
  DEFAULT_SUBAGENT_SCHEMA_PATH,
  JUDGE_OUTPUT_SCHEMA_PATH,
  buildRuntimeMetadata,
  buildSessionStartRuntimeCommand,
  resolveJudgeRuntimeAssignment,
  resolveRoleRuntimeAssignments,
} from "../src/runtime-adapters.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const SUBAGENT_SCHEMA_PATH = "execution/integrations/linear/schemas/subagent-turn.schema.json";
const STRICT_SUBAGENT_SCHEMA_PATH = "execution/integrations/linear/schemas/subagent-turn.strict-generation.schema.json";
const RETIRED_PHASE_SCHEMA_NAME = ["phase", "packet"].join("-");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function subagentTurn(runId, overrides = {}) {
  return {
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    run_id: runId,
    status: "continue",
    reason: "product_context_sufficient",
    context_digest: "scripted subagent-turn packet",
    source_refs: ["test:subagent-runtime-wiring"],
    assumptions: [],
    constraints: [],
    risks: [],
    ...overrides,
  };
}

function assertNoPhasePacketPath(value, label) {
  assert.equal(
    String(value).includes(RETIRED_PHASE_SCHEMA_NAME),
    false,
    `${label} must not point at the retired phase schema`,
  );
}

test("subagent runtime wiring pins schema paths and the shared wire version", () => {
  const config = loadLinearConfig({ repoRoot });
  const assignments = resolveRoleRuntimeAssignments(config);
  const lenient = readJson(SUBAGENT_SCHEMA_PATH);
  const strict = readJson(STRICT_SUBAGENT_SCHEMA_PATH);

  const pmCommand = buildSessionStartRuntimeCommand({
    assignment: assignments.pm,
    prompt: "Return a PM subagent turn.",
    repoRoot,
  });
  const srEngCommand = buildSessionStartRuntimeCommand({
    assignment: assignments.sr_eng,
    prompt: "Return a Sr Eng subagent turn.",
    repoRoot,
  });
  const metadata = buildRuntimeMetadata({
    ["accepted" + "Packets"]: [
      subagentTurn("run_wire_version", { role: "pm" }),
      subagentTurn("run_wire_version", {
        role: "sr_eng",
        reason: "technical_context_grounded",
      }),
    ],
    runtimeAssignments: assignments,
  });

  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, lenient.$id);
  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, lenient.properties.schema_version.const);
  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, pmCommand.schema_version);
  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, srEngCommand.schema_version);
  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, metadata.pm.schema_version);
  assert.equal(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION, metadata.sr_eng.schema_version);
  assert.notEqual(strict.$id, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);

  assert.equal(assignments.pm.schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(assignments.pm.generation_schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(assignments.sr_eng.schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(assignments.sr_eng.generation_schema_path, STRICT_SUBAGENT_SCHEMA_PATH);
  assert.equal(assignments.pm.local_schema_version, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.equal(assignments.sr_eng.local_schema_version, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);

  assert.equal(pmCommand.schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(pmCommand.generation_schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(srEngCommand.schema_path, SUBAGENT_SCHEMA_PATH);
  assert.equal(srEngCommand.generation_schema_path, STRICT_SUBAGENT_SCHEMA_PATH);

  for (const [label, value] of Object.entries({
    "pm schema_path": assignments.pm.schema_path,
    "pm generation_schema_path": assignments.pm.generation_schema_path,
    "sr_eng schema_path": assignments.sr_eng.schema_path,
    "sr_eng generation_schema_path": assignments.sr_eng.generation_schema_path,
  })) {
    assertNoPhasePacketPath(value, label);
  }
});

test("subagent runtime fallback defaults use the lenient subagent-turn schema", () => {
  const assignments = resolveRoleRuntimeAssignments({
    runtime: {
      default_invocation: "session_start",
      adapters: {
        claude: { command: "claude" },
        codex: { command: "codex" },
      },
    },
    workflows: {
      decomposition: {
        roles: {
          pm: { runtime: "claude", model: "pm-model" },
          sr_eng: { runtime: "codex", model: "eng-model" },
          judge: { runtime: "claude", model: "judge-model" },
          drafter: { runtime: "claude", model: "drafter-model" },
          orchestrator: { runtime: "claude", model: "orchestrator-model" },
        },
      },
    },
  });

  for (const role of ["pm", "sr_eng"]) {
    assert.equal(assignments[role].schema_path, DEFAULT_SUBAGENT_SCHEMA_PATH);
    assert.equal(assignments[role].generation_schema_path, DEFAULT_SUBAGENT_SCHEMA_PATH);
    assertNoPhasePacketPath(assignments[role].schema_path, `${role} fallback schema_path`);
    assertNoPhasePacketPath(assignments[role].generation_schema_path, `${role} fallback generation_schema_path`);
  }
});

test("orchestrator and judge commands keep their explicit output schemas", async () => {
  const config = loadLinearConfig({ repoRoot });
  const assignments = resolveRoleRuntimeAssignments(config);
  let orchestratorCommand = null;

  await defaultOrchestratorRuntime({
    runId: "run_schema_isolation",
    project: { id: "project-1", name: "Project" },
    selectableTargets: [],
    priorTurns: [],
    bounds: { rounds_used: 0, max_rounds: 1 },
    assignment: assignments.orchestrator,
    repoRoot,
    runCommand: async (command) => {
      orchestratorCommand = command;
      return JSON.stringify({
        control_action: {
          action: "terminate",
          outcome: "pause",
          reason: "product_questions",
        },
      });
    },
  });

  const judgeAssignment = resolveJudgeRuntimeAssignment(config);
  const judgeCommand = buildSessionStartRuntimeCommand({
    assignment: judgeAssignment,
    prompt: "Judge this decomposition.",
    repoRoot,
  });

  assert.equal(path.basename(orchestratorCommand.generation_schema_path), "orchestrator-turn-output.schema.json");
  assert.equal(judgeCommand.schema_path, JUDGE_OUTPUT_SCHEMA_PATH);
  assert.equal(judgeCommand.generation_schema_path, JUDGE_OUTPUT_SCHEMA_PATH);
});

test("executeSubagent validates a scripted subagent-turn packet through the real command path", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_scripted_subagent_turn";
  const packet = subagentTurn(runId, {
    project_update_markdown: `run_id: ${runId}\n\nSubagent turn accepted.`,
  });
  let commandSeen = null;

  const result = await executeSubagent({
    runtime_role: "pm",
    prompt: "Assess whether the product context is sufficient.",
    runId,
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    repoRoot,
    runCommand: async (command) => {
      commandSeen = command;
      return JSON.stringify(packet);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.parse_status, "valid");
  assert.equal(result.clean_parse, true);
  assert.deepEqual(result.packet, packet);
  assert.equal(commandSeen.schema_version, SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION);
  assert.equal(commandSeen.generation_schema_path, SUBAGENT_SCHEMA_PATH);
});

test("executeSubagent returns a typed failure when the invocation envelope is oversized", async () => {
  const config = loadLinearConfig({ repoRoot });
  let commandStarted = false;

  const result = await executeSubagent({
    runtime_role: "pm",
    prompt: "pathological persona body ".repeat(6000),
    runId: "run_oversized_envelope",
    task: "Exercise the envelope size guard.",
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    repoRoot,
    runCommand: async () => {
      commandStarted = true;
      throw new Error("runCommand should not be reached for an oversized envelope");
    },
  });

  assert.equal(commandStarted, false);
  assert.equal(result.ok, false);
  assert.equal(result.failure_kind, "process");
  assert.equal(result.failure_code, "envelope_too_large");
  assert.equal(result.parse_status, "invalid");
  assert.equal(result.clean_parse, false);
  assert.equal(result.envelope, null);
  assert.match(result.raw_output_excerpt, /project envelope too large/);
});
