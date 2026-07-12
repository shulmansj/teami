import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROJECT_UPDATE_ACCOUNTABILITY_HEADING } from "../../../engine/engine-markdown.mjs";
import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  runRuntimeCommand,
  scrubChildEnv,
} from "../src/runtime-command.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

test("runtime options seam: no options -> child env equals scrubChildEnv(env), cwd inherited", async () => {
  const env = spawnBaseEnv({
    TEAMI_GITHUB_INSTALLATION_TOKEN: "github-installation-token",
    GITHUB_TOKEN: "github-token",
    GH_TOKEN: "gh-token",
    SSH_AUTH_SOCK: "ssh-agent-sock",
    CODEX_ENV_S3_TEST_TOKEN: "codex-runtime-auth",
    CLAUDE_ENV_S3_TEST_TOKEN: "claude-runtime-auth",
    ANTHROPIC_ENV_S3_TEST_TOKEN: "anthropic-runtime-auth",
  });
  let spawnCall = null;

  const result = await runRuntimeCommand(
    { command: "runtime-options-default-check", args: [] },
    {
      env,
      includeEnvironmentProof: true,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
      }),
    },
  );

  assert.deepEqual(spawnCall.options.env, scrubChildEnv(env));
  assert.equal(spawnCall.options.cwd, undefined);
  assert.deepEqual(result.environment, {
    agent_write_credentials_present: false,
  });
});

test("runtime options seam: envAugment overlays the scrubbed env and reaches the child; cwd threads", async () => {
  const env = spawnBaseEnv({
    PATH: "base-path",
    GITHUB_TOKEN: "github-token",
    CODEX_ENV_S3_TEST_TOKEN: "codex-runtime-auth",
  });
  const boundCwd = path.join(os.tmpdir(), "af-runtime-options-bound-cwd");
  let spawnCall = null;

  await runRuntimeCommand(
    { command: "runtime-options-augment-check", args: [] },
    {
      env,
      cwd: boundCwd,
      envAugment: {
        MY_AUGMENT_VAR: "augmented-value",
        PATH: "augmented-path-wins",
      },
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
      }),
    },
  );

  assert.equal(spawnCall.options.cwd, boundCwd);
  assert.equal(spawnCall.options.env.MY_AUGMENT_VAR, "augmented-value");
  assert.equal(spawnCall.options.env.PATH, "augmented-path-wins");
  assert.equal(spawnCall.options.env.CODEX_ENV_S3_TEST_TOKEN, "codex-runtime-auth");
  assert.equal(Object.hasOwn(spawnCall.options.env, "GITHUB_TOKEN"), false);
});

test("runtime options seam: on win32 an envAugment temp override evicts case-variant host duplicates", async () => {
  const env = spawnBaseEnv({
    Temp: "host-temp-case-variant",
    TMP: "host-tmp",
  });
  let spawnCall = null;

  await runRuntimeCommand(
    { command: "runtime-options-temp-check", args: [] },
    {
      env,
      platform: "win32",
      envAugment: {
        TMPDIR: "engine-run-temp",
        TMP: "engine-run-temp",
        TEMP: "engine-run-temp",
      },
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
      }),
    },
  );

  assert.equal(spawnCall.options.env.TMPDIR, "engine-run-temp");
  assert.equal(spawnCall.options.env.TMP, "engine-run-temp");
  assert.equal(spawnCall.options.env.TEMP, "engine-run-temp");
  assert.equal(Object.hasOwn(spawnCall.options.env, "Temp"), false);
});

test("runtime options seam: envAugment carrying a write credential participates in the credential proof", async () => {
  const env = spawnBaseEnv({
    GH_TOKEN: "parent-gh-token",
    GITHUB_TOKEN: "parent-github-token",
  });
  let spawnCall = null;

  const result = await runRuntimeCommand(
    { command: "runtime-options-proof-check", args: [] },
    {
      env,
      envAugment: {
        GH_TOKEN: "augmented-gh-token",
      },
      includeEnvironmentProof: true,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
      }),
    },
  );

  assert.deepEqual(result.environment, {
    agent_write_credentials_present: true,
  });
  assert.equal(spawnCall.options.env.GH_TOKEN, "augmented-gh-token");
  assert.equal(Object.hasOwn(spawnCall.options.env, "GITHUB_TOKEN"), false);
});

test("runtime options seam: runOrchestratorLoop threads cwd/envAugment into spawn input and terminal proof", async () => {
  const augmented = await runLoopRuntimeOptionsFixture({
    runId: "run_runtime_options_augmented",
    cwd: "/c/tmp/bound-cwd",
    envAugment: { GH_TOKEN: "loop-augmented-token" },
  });

  assert.equal(augmented.calls.length, 1);
  assert.equal(augmented.calls[0].cwd, "/c/tmp/bound-cwd");
  assert.equal(augmented.calls[0].envAugment.GH_TOKEN, "loop-augmented-token");
  assert.deepEqual(augmented.result.environment, {
    agent_write_credentials_present: true,
  });

  const defaults = await runLoopRuntimeOptionsFixture({
    runId: "run_runtime_options_defaults",
  });

  assert.equal(defaults.calls.length, 1);
  assert.equal(defaults.calls[0].cwd, undefined);
  assert.deepEqual(defaults.calls[0].envAugment, {});
  assert.deepEqual(defaults.result.environment, {
    agent_write_credentials_present: false,
  });
});

async function runLoopRuntimeOptionsFixture({
  runId,
  cwd = undefined,
  envAugment = undefined,
} = {}) {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const calls = [];
  const runtimeExecutor = {
    async executeSubagent(input) {
      calls.push({
        cwd: input.cwd,
        envAugment: input.envAugment,
        runtime_role: input.runtime_role,
      });
      return validSpawn(input.runId, { role: input.runtime_role });
    },
  };
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: {
          action: "invoke_one_off",
          role_label: "runtime_options_probe",
          task: "Exercise the runtime options seam.",
          prompt: "Return a valid subagent turn.",
          runtime_role: "pm",
        },
        evidence: null,
      };
    }
    return {
      controlAction: {
        action: "terminate",
        outcome: "pause",
        reason: "product_questions",
      },
      producedContent: pauseProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runOrchestratorLoop({
    runId,
    wake: { id: `${runId}_wake`, object_id: "project-1" },
    event: { id: `${runId}_event` },
    project: { id: "project-1", name: "Project", content: "Exercise runtime options." },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: { selectableTargets: [] },
    definition: decompositionDefinition,
    commitPayload: decompositionDefinition.commitPayload,
    repoRoot: REPO_ROOT,
    cwd,
    envAugment,
  });

  return { result, calls };
}

function validSpawn(runId, { role = "pm" } = {}) {
  const packet = subagentTurn(runId);
  const rawOutput = JSON.stringify(packet);
  return {
    ok: true,
    packet,
    output: rawOutput,
    role,
    runtime: "codex",
    parse_status: "valid",
    clean_parse: true,
    prompt: `fake envelope for ${role}`,
    raw_output: rawOutput,
    raw_output_excerpt: rawOutput,
    envelope: `fake envelope for ${role}`,
    sessionHandle: null,
    evidence: {
      evidence_unavailable: [
        { scope: `${role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
      ],
    },
  };
}

function subagentTurn(runId) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status: "continue",
    reason: "product_context_sufficient",
    context_digest: "runtime options seam subagent digest",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

function pauseProducedContent(runId) {
  return {
    context_digest: "Runtime options seam fixture paused after proving propagation.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Paused after proving runtime option propagation.",
      "",
      PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
      "- The one-off subagent spawn exercised the runtime options seam.",
    ].join("\n"),
    open_questions_markdown: "- No product questions for this fixture.",
  };
}

function fakeSpawn({
  stdout = "",
  stderr = "",
  code = 0,
  signal = null,
  error = null,
  stayOpen = false,
  onSpawn = () => {},
} = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };

    const call = { command, args, options };
    onSpawn(call);
    setImmediate(() => {
      const stdoutText = typeof stdout === "function" ? stdout(call) : stdout;
      const stderrText = typeof stderr === "function" ? stderr(call) : stderr;
      if (stdoutText) child.stdout.emit("data", Buffer.from(stdoutText, "utf8"));
      if (stderrText) child.stderr.emit("data", Buffer.from(stderrText, "utf8"));
      if (error) {
        child.emit("error", error);
        return;
      }
      if (!stayOpen) child.emit("close", code, signal);
    });
    return child;
  };
}

function spawnBaseEnv(overrides = {}) {
  const base = {
    HOME: os.tmpdir(),
    USERPROFILE: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  for (const name of ["PATH", "Path", "SystemRoot", "windir"]) {
    if (process.env[name]) base[name] = process.env[name];
  }
  return { ...base, ...overrides };
}
