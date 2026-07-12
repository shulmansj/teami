import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { createSnapshotEvalLinearClient } from "../src/decomposition-eval-cli.mjs";
import {
  ORCHESTRATOR_OUTCOME_REASONS,
  validateOrchestratorOutput,
} from "../../../engine/orchestrator-output.mjs";
import { SUBAGENT_TURN_OUTCOMES } from "../../../engine/orchestrator-turn-contract.mjs";
import { LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS } from "../../../engine/trace-contract.mjs";
import {
  rememberSubagentSessionHandle,
  resolveSubagentInstanceId,
  subagentSessionHandleForInstance,
} from "../../../engine/orchestrator-loop.mjs";
import {
  defaultOrchestratorRuntime,
  executeOrchestratorTurn,
} from "../src/orchestrator-turn.mjs";
import { buildProjectNeedsPrincipalCommentBody } from "../src/linear/project-needs-principal-comment.mjs";
import { REPAIR_RETRY_TIMEOUT_MS } from "../src/runtime-command.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";
import { terminalArtifact } from "../src/workflows/decomposition/artifacts.mjs";
import {
  createProcessRuntimeExecutor,
  createEvalModeReadOnlyLinearClient,
  runDecompositionEvalMode,
  runDecompositionOrchestrator,
} from "../src/trigger-runner.mjs";

// I-2b acceptance fixtures: the deterministic free orchestrator loop driven
// through the injected orchestratorTurnExecutor + runtimeExecutor (the fixtures
// script control actions + subagent turns; the real CLI is never spawned).
//
//   (1) a NON-DEFAULT library order then terminate(commit) with valid
//       producedContent -> a VALIDATED commit;
//   (2) a run that breaches bounds (low maxRounds injection) -> failed_closed/bounds_breach;
//   (3) eval-mode is read-only over the same loop.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

function subagentTurn(runId, { status = "continue", reason = "product_context_sufficient" } = {}) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status,
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

// A roster the orchestrator can pick library subagents from. resolve() yields a
// runtime_role + a snapshot whose body the loop hands to executeSubagent.
function fakeRoster() {
  const byKey = {
    "prompt/decomposition/sr_eng_grounding_pass": "sr_eng",
    "prompt/decomposition/pm_product_sufficiency_pass": "pm",
  };
  return {
    selectableTargets: Object.keys(byKey),
    resolve(targetKey) {
      const role = byKey[targetKey];
      if (!role) return { ok: false, reason: "orchestrator_roster_target_not_selectable" };
      return {
        ok: true,
        runtime_role: role,
        loadSnapshot: () => ({
          entry: {
            target_key: targetKey,
            human_name: role === "sr_eng" ? "Senior engineering grounding pass" : "PM product sufficiency pass",
          },
          contentBytes: `BODY for ${targetKey}`,
          snapshotSha256: `sha-${targetKey}`,
        }),
      };
    },
  };
}

// A subagent executor that returns a valid subagent turn per spawn, keyed by the
// runtime_role the loop resolved. Records the prompt bodies it was handed so the
// fixture can assert the library body (not a phase-prompt) reached the subagent.
function fakeSubagentExecutor() {
  const calls = [];
  return {
    calls,
    async executeSubagent({ runtime_role, prompt, runId, task, priorDigest }) {
      calls.push({
        runtime_role,
        prompt,
        task,
        priorDigest: Array.isArray(priorDigest) ? [...priorDigest] : priorDigest,
      });
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      const packet = subagentTurn(runId, { status: "continue", reason });
      const rawOutput = JSON.stringify(packet);
      return {
        ok: true,
        packet,
        output: rawOutput,
        role: runtime_role,
        runtime: "codex",
        parse_status: "valid",
        clean_parse: true,
        prompt: `fake envelope for ${runtime_role}`,
        raw_output: rawOutput,
        raw_output_excerpt: rawOutput,
        envelope: `fake envelope for ${runtime_role}`,
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
}

function scriptedSubagentExecutor(scriptedResults) {
  const calls = [];
  const queue = [...scriptedResults];
  return {
    calls,
    async executeSubagent(input) {
      calls.push({
        ...input,
        priorDigest: Array.isArray(input.priorDigest) ? [...input.priorDigest] : input.priorDigest,
      });
      const next = queue.shift();
      if (!next) throw new Error("scripted subagent executor exhausted");
      return typeof next === "function" ? next(input) : next;
    },
  };
}

function validSpawn(runId, {
  role = "pm",
  status = "continue",
  reason = "product_context_sufficient",
  envelope = `repair envelope for ${role}`,
  evidenceRef = null,
  packetFields = {},
} = {}) {
  const packet = { ...subagentTurn(runId, { status, reason }), ...packetFields };
  const rawOutput = JSON.stringify(packet);
  return {
    ok: true,
    packet,
    output: rawOutput,
    role,
    runtime: "codex",
    parse_status: "valid",
    clean_parse: true,
    prompt: envelope,
    raw_output: rawOutput,
    raw_output_excerpt: rawOutput,
    envelope,
    sessionHandle: null,
    evidence: {
      ...(evidenceRef ? { evidence_ref: evidenceRef } : {}),
      evidence_unavailable: [
        { scope: `${role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
      ],
    },
  };
}

function captureSpanSink() {
  const orchestratorTurns = [];
  const subagentTurns = [];
  return {
    orchestratorTurns,
    subagentTurns,
    recordOrchestratorTurn(span) {
      orchestratorTurns.push(JSON.parse(JSON.stringify(span)));
    },
    recordSubagentTurn(span) {
      subagentTurns.push(JSON.parse(JSON.stringify(span)));
    },
  };
}

function captureLocalSpanSink() {
  return {
    traceContentPolicy: LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
    ...captureSpanSink(),
  };
}

function parseFailureSpawn({
  role = "pm",
  envelope = `preserved envelope for ${role}`,
  clean_parse = false,
  raw_output_excerpt = "not json",
} = {}) {
  return {
    ok: false,
    runtime: "codex",
    parse_status: "invalid",
    clean_parse,
    prompt: envelope,
    raw_output: raw_output_excerpt,
    raw_output_excerpt,
    failure_kind: "parse",
    failure_code: "invalid_packet",
    envelope,
    role,
  };
}

function processFailureSpawn({
  role = "pm",
  envelope = `preserved envelope for ${role}`,
  failure_code = "timed_out",
} = {}) {
  return {
    ok: false,
    runtime: "codex",
    parse_status: "invalid",
    clean_parse: false,
    prompt: envelope,
    raw_output: "partial stdout",
    raw_output_excerpt: "partial stdout",
    failure_kind: "process",
    failure_code,
    process: { exit: null, signal: "SIGTERM", timed_out: failure_code === "timed_out" },
    envelope,
    role,
  };
}

function commitProducedContent(runId) {
  return {
    context_digest: "Reviewed project intent and grounded constraints for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Decomposed the project into an agent-ready issue set.",
      "",
      "## What I did with each part of your project",
      "- The goal section became the plan issue; nothing is blocked.",
    ].join("\n"),
    final_issues: [
      {
        decomposition_key: "project-plan",
        title: "Prepare execution setup",
        issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
        depends_on: [],
        assignment: "Plan the setup.",
        output: "A documented execution setup plan.",
        acceptance_criteria: ["Plan exists."],
      },
    ],
  };
}

function codeFinalIssue({
  key = "project-plan",
  title = "Prepare execution setup",
  resourceId,
  repoScope = undefined,
} = {}) {
  return {
    decomposition_key: key,
    title,
    issue_body_markdown: "## Assignment\n\nBuild the code change.\n\n## Acceptance Criteria\n\n- Code change is verified.",
    depends_on: [],
    assignment: "Build the code change.",
    output: "A verified code change.",
    acceptance_criteria: ["Code change is verified."],
    work_type: "code",
    resource_target: {
      kind: "git_repo",
      id: resourceId,
      ...(repoScope ? { repo_scope: repoScope } : {}),
    },
  };
}

function nonCodeFinalIssue({
  key = "project-docs",
  title = "Write launch notes",
} = {}) {
  return {
    decomposition_key: key,
    title,
    issue_body_markdown: "## Assignment\n\nWrite launch notes.\n\n## Acceptance Criteria\n\n- Notes are complete.",
    depends_on: [],
    assignment: "Write launch notes.",
    output: "Published launch notes.",
    acceptance_criteria: ["Notes are complete."],
    work_type: "non_code",
  };
}

function commitProducedContentWithIssues(runId, finalIssues) {
  return {
    ...commitProducedContent(runId),
    final_issues: finalIssues,
  };
}

function pauseProducedContent(runId) {
  return {
    context_digest: "The run paused after observing a failed subagent turn.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Paused for product input after a failed subagent turn.",
      "",
      "## What I did with each part of your project",
      "- The failed subagent turn was recorded for the next decomposition decision.",
    ].join("\n"),
    open_questions_markdown: "- Should decomposition be retried after the runtime issue is inspected?",
  };
}

// (1) NON-DEFAULT library order (sr_eng grounding BEFORE pm sufficiency — the
// reverse of the retired fixed phase order) then terminate(commit) carrying valid
// producedContent -> a validated commit.
function promptFromCommand(command, marker) {
  const prompt = runtimePromptFromCommand(command);
  return prompt.includes(marker) ? prompt : "";
}

function runtimePromptFromCommand(command) {
  if (typeof command?.stdinInput === "string") return command.stdinInput;
  const index = command?.args?.indexOf("-p") ?? -1;
  if (index >= 0) {
    const promptArg = command.args[index + 1];
    if (typeof promptArg === "string" && promptArg.startsWith("@")) {
      return fs.readFileSync(promptArg.slice(1), "utf8");
    }
    return promptArg || "";
  }
  return command?.args?.at(-1) || "";
}

function promptSection(prompt, startMarker, endMarker) {
  const startIndex = prompt.indexOf(startMarker);
  assert.notEqual(startIndex, -1, `missing prompt section ${startMarker}`);
  const contentStart = startIndex + startMarker.length;
  const endIndex = endMarker ? prompt.indexOf(endMarker, contentStart) : -1;
  return prompt.slice(contentStart, endIndex === -1 ? undefined : endIndex).trim();
}

test("subagent session handles are keyed by instance id", () => {
  const sessionHandles = {};
  const role = "sr_eng";
  const defaultInstanceId = resolveSubagentInstanceId({ role });
  const instanceA = resolveSubagentInstanceId({ role, instanceKey: "a" });
  const instanceB = resolveSubagentInstanceId({ role, instanceKey: "b" });
  const defaultHandle = { id: "session-default", role, run_id: "run-1", runtime: "codex" };
  const handleA = { id: "session-a", role, run_id: "run-1", runtime: "codex" };
  const handleB = { id: "session-b", role, run_id: "run-1", runtime: "codex" };

  assert.equal(defaultInstanceId, "sr_eng#default");
  assert.equal(resolveSubagentInstanceId({ role, instanceId: "a" }), instanceA);
  assert.equal(resolveSubagentInstanceId({ role, instanceId: instanceA }), instanceA);
  assert.notEqual(instanceA, instanceB);

  rememberSubagentSessionHandle(sessionHandles, { role, sessionHandle: defaultHandle });
  rememberSubagentSessionHandle(sessionHandles, {
    role,
    instanceId: instanceA,
    sessionHandle: handleA,
  });
  rememberSubagentSessionHandle(sessionHandles, {
    role,
    instanceId: instanceB,
    sessionHandle: handleB,
  });

  assert.deepEqual(Object.keys(sessionHandles).sort(), [
    "sr_eng#a",
    "sr_eng#b",
    "sr_eng#default",
  ]);
  assert.deepEqual(sessionHandles[instanceA], {
    role,
    instanceId: instanceA,
    sessionHandle: handleA,
  });
  assert.deepEqual(sessionHandles[instanceB], {
    role,
    instanceId: instanceB,
    sessionHandle: handleB,
  });
  assert.equal(subagentSessionHandleForInstance(sessionHandles, defaultInstanceId), defaultHandle);
  assert.equal(subagentSessionHandleForInstance(sessionHandles, instanceA), handleA);
  assert.equal(subagentSessionHandleForInstance(sessionHandles, instanceB), handleB);
});

test("orchestrator loop: role-only repeated subagent invocation reuses the default instance handle", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_default_instance_handle";
  const calls = [];
  const defaultHandle = { id: "session-pm-default", role: "pm", run_id: runId, runtime: "codex" };
  const runtimeExecutor = {
    async executeSubagent(input) {
      calls.push({ ...input });
      return {
        ...validSpawn(runId, { role: input.runtime_role }),
        sessionHandle: input.sessionHandle || defaultHandle,
      };
    },
  };
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn <= 2) {
      return {
        controlAction: {
          action: "invoke_library",
          target_key: "prompt/decomposition/pm_product_sufficiency_pass",
        },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionHandle, null);
  assert.deepEqual(calls[1].sessionHandle, defaultHandle);
  assert.deepEqual(result.sessionHandles, {
    "pm#default": {
      role: "pm",
      instanceId: "pm#default",
      sessionHandle: defaultHandle,
    },
  });
});

test("orchestrator loop: explicit instance_id spawns and continues distinct same-role instances", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_explicit_instance_handles";
  const calls = [];
  const defaultHandle = { id: "session-pm-default", role: "pm", run_id: runId, runtime: "codex" };
  const sideAHandle = { id: "session-pm-side-a", role: "pm", run_id: runId, runtime: "codex" };
  const sideBHandle = { id: "session-pm-side-b", role: "pm", run_id: runId, runtime: "codex" };
  const handleByTask = new Map([
    ["default first", defaultHandle],
    ["side A first", sideAHandle],
    ["side B first", sideBHandle],
    ["side A continue", sideAHandle],
    ["default continue", defaultHandle],
  ]);
  const runtimeExecutor = {
    async executeSubagent(input) {
      calls.push({ ...input });
      return {
        ...validSpawn(runId, { role: input.runtime_role }),
        sessionHandle: input.sessionHandle || handleByTask.get(input.task),
      };
    },
  };
  const actions = [
    {
      action: "invoke_one_off",
      role_label: "default",
      task: "default first",
      prompt: "Start the default PM instance.",
      runtime_role: "pm",
    },
    {
      action: "invoke_one_off",
      role_label: "side-a",
      task: "side A first",
      prompt: "Start side A.",
      runtime_role: "pm",
      instance_id: "side_a",
    },
    {
      action: "invoke_one_off",
      role_label: "side-b",
      task: "side B first",
      prompt: "Start side B.",
      runtime_role: "pm",
      instance_id: "side_b",
    },
    {
      action: "invoke_one_off",
      role_label: "side-a",
      task: "side A continue",
      prompt: "Continue side A.",
      runtime_role: "pm",
      instance_id: "pm#side_a",
    },
    {
      action: "invoke_one_off",
      role_label: "default",
      task: "default continue",
      prompt: "Continue the default PM instance.",
      runtime_role: "pm",
    },
  ];
  let turn = 0;
  const priorTurnSnapshots = [];
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    priorTurnSnapshots.push(priorTurns.map((prior) => ({ ...prior })));
    if (turn < actions.length) {
      const controlAction = actions[turn];
      turn += 1;
      return { controlAction, evidence: null };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(calls.length, 5);
  assert.equal(calls[0].sessionHandle, null);
  assert.equal(calls[1].sessionHandle, null);
  assert.equal(calls[2].sessionHandle, null);
  assert.deepEqual(calls[3].sessionHandle, sideAHandle);
  assert.deepEqual(calls[4].sessionHandle, defaultHandle);
  assert.deepEqual(Object.keys(result.sessionHandles).sort(), [
    "pm#default",
    "pm#side_a",
    "pm#side_b",
  ]);
  assert.deepEqual(result.sessionHandles["pm#default"].sessionHandle, defaultHandle);
  assert.deepEqual(result.sessionHandles["pm#side_a"].sessionHandle, sideAHandle);
  assert.deepEqual(result.sessionHandles["pm#side_b"].sessionHandle, sideBHandle);
  assert.deepEqual(
    result.output.evidence.perspectives_run.map((entry) => entry.instance_id),
    ["pm#default", "pm#side_a", "pm#side_b", "pm#side_a", "pm#default"],
  );
  assert.deepEqual(
    priorTurnSnapshots.at(-1).map((prior) => prior.instance_id),
    ["pm#default", "pm#side_a", "pm#side_b", "pm#side_a", "pm#default"],
  );
});

test("orchestrator loop: same-role fan-out keeps explicit sr_eng instances independently warm-resumable", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_same_role_fan_out_instances";
  const calls = [];
  const defaultHandle = { id: "session-sr-eng-default", role: "sr_eng", run_id: runId, runtime: "codex" };
  const handleA = { id: "session-sr-eng-a", role: "sr_eng", run_id: runId, runtime: "codex" };
  const handleB = { id: "session-sr-eng-b", role: "sr_eng", run_id: runId, runtime: "codex" };
  const handleByTask = new Map([
    ["spawn A", handleA],
    ["spawn B", handleB],
    ["resume A", handleA],
    ["resume B", handleB],
    ["default first", defaultHandle],
    ["default resume", defaultHandle],
  ]);
  const runtimeExecutor = {
    async executeSubagent(input) {
      calls.push({ ...input });
      return {
        ...validSpawn(runId, {
          role: input.runtime_role,
          reason: "technical_context_grounded",
        }),
        sessionHandle: input.sessionHandle || handleByTask.get(input.task),
      };
    },
  };
  const actions = [
    {
      action: "invoke_one_off",
      role_label: "sr-eng-a",
      task: "spawn A",
      prompt: "Inspect the API boundary for instance A.",
      runtime_role: "sr_eng",
      instance_id: "sr_eng#a",
    },
    {
      action: "invoke_one_off",
      role_label: "sr-eng-b",
      task: "spawn B",
      prompt: "Inspect the persistence boundary for instance B.",
      runtime_role: "sr_eng",
      instance_id: "sr_eng#b",
    },
    {
      action: "invoke_one_off",
      role_label: "sr-eng-a",
      task: "resume A",
      prompt: "Continue instance A on the API boundary.",
      runtime_role: "sr_eng",
      instance_id: "sr_eng#a",
    },
    {
      action: "invoke_one_off",
      role_label: "sr-eng-b",
      task: "resume B",
      prompt: "Continue instance B on the persistence boundary.",
      runtime_role: "sr_eng",
      instance_id: "sr_eng#b",
    },
    {
      action: "invoke_one_off",
      role_label: "sr-eng-default",
      task: "default first",
      prompt: "Start the role-only default sr_eng thread.",
      runtime_role: "sr_eng",
    },
    {
      action: "invoke_one_off",
      role_label: "sr-eng-default",
      task: "default resume",
      prompt: "Continue the role-only default sr_eng thread.",
      runtime_role: "sr_eng",
    },
  ];
  let turn = 0;
  const priorTurnSnapshots = [];
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    priorTurnSnapshots.push(priorTurns.map((prior) => ({ ...prior })));
    if (turn < actions.length) {
      const controlAction = actions[turn];
      turn += 1;
      return { controlAction, evidence: null };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((call) => call.prompt),
    actions.map((action) => action.prompt),
  );
  assert.deepEqual(
    calls.map((call) => call.task),
    ["spawn A", "spawn B", "resume A", "resume B", "default first", "default resume"],
  );
  assert.equal(calls[0].sessionHandle, null);
  assert.equal(calls[1].sessionHandle, null);
  assert.deepEqual(calls[2].sessionHandle, handleA);
  assert.deepEqual(calls[3].sessionHandle, handleB);
  assert.equal(calls[4].sessionHandle, null);
  assert.deepEqual(calls[5].sessionHandle, defaultHandle);

  assert.deepEqual(Object.keys(result.sessionHandles).sort(), [
    "sr_eng#a",
    "sr_eng#b",
    "sr_eng#default",
  ]);
  assert.deepEqual(result.sessionHandles["sr_eng#a"], {
    role: "sr_eng",
    instanceId: "sr_eng#a",
    sessionHandle: handleA,
  });
  assert.deepEqual(result.sessionHandles["sr_eng#b"], {
    role: "sr_eng",
    instanceId: "sr_eng#b",
    sessionHandle: handleB,
  });
  assert.deepEqual(result.sessionHandles["sr_eng#default"], {
    role: "sr_eng",
    instanceId: "sr_eng#default",
    sessionHandle: defaultHandle,
  });
  assert.notEqual(
    result.sessionHandles["sr_eng#a"].sessionHandle.id,
    result.sessionHandles["sr_eng#b"].sessionHandle.id,
  );
  assert.deepEqual(
    result.output.evidence.perspectives_run.map((entry) => entry.instance_id),
    ["sr_eng#a", "sr_eng#b", "sr_eng#a", "sr_eng#b", "sr_eng#default", "sr_eng#default"],
  );
  assert.deepEqual(
    result.runtimeEvidence.sr_eng.turns.map((turnEvidence) => turnEvidence.instance_id),
    ["sr_eng#a", "sr_eng#b", "sr_eng#a", "sr_eng#b", "sr_eng#default", "sr_eng#default"],
  );
  assert.deepEqual(
    priorTurnSnapshots.at(-1).map((prior) => prior.instance_id),
    ["sr_eng#a", "sr_eng#b", "sr_eng#a", "sr_eng#b", "sr_eng#default", "sr_eng#default"],
  );
});

test("orchestrator loop: non-default library order then terminate(commit) yields a validated commit", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_commit";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  const spanSink = captureSpanSink();

  const libraryOrder = [
    "prompt/decomposition/sr_eng_grounding_pass",
    "prompt/decomposition/pm_product_sufficiency_pass",
  ];
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");
  assert.equal(result.output.terminal_output.final_issues.length, 1);
  // The library order the orchestrator chose drove the spawns in that order.
  assert.deepEqual(runtimeExecutor.calls.map((c) => c.runtime_role), ["sr_eng", "pm"]);
  // The library BODY (not a phase prompt) reached the subagent.
  assert.match(runtimeExecutor.calls[0].prompt, /BODY for prompt\/decomposition\/sr_eng_grounding_pass/);
  // perspectives_run reflects the run in invocation order.
  assert.deepEqual(result.output.evidence.perspectives_run.map((p) => p.role), ["sr_eng", "pm"]);
  for (const entry of result.output.evidence.perspectives_run) {
    assert.equal(Object.hasOwn(entry, "subagent_evidence"), false);
  }
  const srEngSubagentEvidence = result.runtimeEvidence.sr_eng.turns[0].subagent_evidence;
  assert.equal(srEngSubagentEvidence.role, "sr_eng");
  assert.equal(srEngSubagentEvidence.runtime, "codex");
  assert.equal(srEngSubagentEvidence.parse_status, "valid");
  assert.equal(srEngSubagentEvidence.clean_parse, true);
  assert.match(srEngSubagentEvidence.raw_output_excerpt, /technical_context_grounded/);
  // rounds_used counts DECISION turns (3); invocations counts SPAWNS (2).
  assert.equal(result.output.bounds.rounds_used, 3);
  assert.equal(result.output.bounds.invocations, 2);
  assert.deepEqual(
    spanSink.orchestratorTurns.map((span) => span.consumed_input_refs),
    [
      [],
      ["1.1"],
      ["2.1", "linear_project:project-1"],
    ],
  );
  assert.deepEqual(
    spanSink.subagentTurns.map((span) => span.consumed_input_refs),
    [
      [1, "linear_project:project-1"],
      [2, "linear_project:project-1"],
    ],
  );
  // The run consumed the governing prompt + both library refs (the #50 re-key).
  const refTargets = result.acceptedRefs.map((r) => r.target_key);
  assert.ok(refTargets.includes("prompt/decomposition/orchestrator_governing"));
  assert.ok(refTargets.includes("prompt/decomposition/sr_eng_grounding_pass"));
  assert.ok(refTargets.includes("prompt/decomposition/pm_product_sufficiency_pass"));
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: allowed repo packet reaches orchestrator and subagent prompts and authored code routing commits", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_allowed_repo_packet_single";
  const allowedRepoPacket = [{
    resource_id: "repo-main",
    owner: "acme",
    repo: "product-app",
    default_branch: "main",
    repo_scope: "product",
  }];
  const project = {
    id: "project-1",
    name: "Project",
    description: "Decompose the product app work.",
    content: "## Goal\n\nShip the product app change.",
  };
  const originalProject = structuredClone(project);
  const assignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;
  const orchestratorCommands = [];
  let orchestratorRuntimeCall = 0;
  const orchestratorRunCommand = async (command) => {
    orchestratorCommands.push(command);
    orchestratorRuntimeCall += 1;
    if (orchestratorRuntimeCall === 1) {
      return JSON.stringify({
        control_action: {
          action: "invoke_library",
          target_key: "prompt/decomposition/pm_product_sufficiency_pass",
        },
      });
    }
    return JSON.stringify({
      control_action: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      produced_content: commitProducedContentWithIssues(runId, [
        codeFinalIssue({ resourceId: "repo-main", repoScope: "product" }),
      ]),
    });
  };
  const orchestratorTurnExecutor = (input) =>
    executeOrchestratorTurn({
      ...input,
      orchestratorRuntime: (runtimeInput) =>
        defaultOrchestratorRuntime({
          ...runtimeInput,
          assignment,
          runCommand: orchestratorRunCommand,
          repoRoot: REPO_ROOT,
        }),
    });

  const subagentCommands = [];
  const runtimeExecutor = createProcessRuntimeExecutor({
    repoRoot: REPO_ROOT,
    runCommand: async (command) => {
      subagentCommands.push(command);
      return JSON.stringify(subagentTurn(runId, { reason: "product_context_sufficient" }));
    },
  });
  const spanSink = captureLocalSpanSink();

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    repoRoot: REPO_ROOT,
    allowedRepoPacket,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.deepEqual(result.output.terminal_output.final_issues.map((issue) => ({
    work_type: issue.work_type,
    resource_target: issue.resource_target,
  })), [{
    work_type: "code",
    resource_target: { kind: "git_repo", id: "repo-main", repo_scope: "product" },
  }]);

  const firstOrchestratorPrompt = promptFromCommand(orchestratorCommands[0], "Project context JSON:");
  assert.ok(firstOrchestratorPrompt.includes("Allowed repo packet (JSON):"));
  assert.match(promptSection(
    firstOrchestratorPrompt,
    "Allowed repo packet (JSON):",
    "\n\nDecisions so far this run:",
  ), /"resource_id": "repo-main"/);
  assert.doesNotMatch(promptSection(
    firstOrchestratorPrompt,
    "Project context JSON:",
    "\n\nAllowed repo packet (JSON):",
  ), /repo-main/);

  const subagentEnvelope = promptFromCommand(subagentCommands[0], "Project context JSON (length-capped):");
  assert.ok(subagentEnvelope.includes("Allowed repo packet (JSON):"));
  assert.match(promptSection(
    subagentEnvelope,
    "Allowed repo packet (JSON):",
    "\n\nAllowed (status, reason) outcomes:",
  ), /"resource_id": "repo-main"/);
  assert.doesNotMatch(promptSection(
    subagentEnvelope,
    "Project context JSON (length-capped):",
    "\n\nAllowed repo packet (JSON):",
  ), /repo-main/);

  assert.deepEqual(project, originalProject, "allowed repo packet must not mutate Linear project content");
  const terminateSpan = spanSink.orchestratorTurns.at(-1);
  assert.deepEqual(terminateSpan.resource_routing.allowed_resource_ids, ["repo-main"]);
  assert.deepEqual(terminateSpan.resource_routing.selected_resource_ids, ["repo-main"]);
  assert.equal(terminateSpan.resource_routing.selection_outcome, "selected");
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: multi-repo authored selections are accepted and observable", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_allowed_repo_packet_multi";
  const allowedRepoPacket = [
    { resource_id: "repo-web", owner: "acme", repo: "web", default_branch: "main", repo_scope: "frontend" },
    { resource_id: "repo-api", owner: "acme", repo: "api", default_branch: "trunk", repo_scope: "backend" },
  ];
  const finalIssues = [
    codeFinalIssue({ key: "web-change", title: "Build web change", resourceId: "repo-web", repoScope: "frontend" }),
    codeFinalIssue({ key: "api-change", title: "Build API change", resourceId: "repo-api", repoScope: "backend" }),
    nonCodeFinalIssue(),
  ];
  const spanSink = captureSpanSink();

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: async () => ({
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContentWithIssues(runId, finalIssues),
    }),
    roster: fakeRoster(),
    allowedRepoPacket,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.deepEqual(
    result.output.terminal_output.final_issues.map((issue) => ({
      key: issue.decomposition_key,
      work_type: issue.work_type,
      resource_target: issue.resource_target ?? null,
    })),
    [
      {
        key: "web-change",
        work_type: "code",
        resource_target: { kind: "git_repo", id: "repo-web", repo_scope: "frontend" },
      },
      {
        key: "api-change",
        work_type: "code",
        resource_target: { kind: "git_repo", id: "repo-api", repo_scope: "backend" },
      },
      {
        key: "project-docs",
        work_type: "non_code",
        resource_target: null,
      },
    ],
  );
  const [span] = spanSink.orchestratorTurns;
  assert.deepEqual(span.resource_routing.allowed_resource_ids, ["repo-web", "repo-api"]);
  assert.deepEqual(span.resource_routing.selected_resource_ids, ["repo-web", "repo-api"]);
  assert.equal(span.resource_routing.selection_outcome, "selected");
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: multi-repo ambiguity pauses for product_questions and emits no final issues", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_allowed_repo_packet_ambiguous";
  const allowedRepoPacket = [
    { resource_id: "repo-web", owner: "acme", repo: "web", default_branch: "main" },
    { resource_id: "repo-api", owner: "acme", repo: "api", default_branch: "trunk" },
  ];
  const spanSink = captureSpanSink();

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: async () => ({
      controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
      producedContent: {
        context_digest: "The code work could belong to more than one allowed repo.",
        source_refs: [{ kind: "linear_project", id: "project-1" }],
        assumptions: [],
        constraints: [],
        risks: ["Repo ownership is ambiguous between the allowed resources."],
        open_questions_markdown: "- Which allowed `resource_id` should own the code issue: `repo-web` or `repo-api`?",
      },
    }),
    roster: fakeRoster(),
    allowedRepoPacket,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "product_questions");
  assert.equal(Object.hasOwn(result.output.terminal_output, "final_issues"), false);
  assert.equal(Object.hasOwn(result.output.terminal_output, "project_update_markdown"), false);
  assert.match(result.output.terminal_output.open_questions_markdown, /resource_id/);
  assert.match(result.output.terminal_output.open_questions_markdown, /repo-web/);
  assert.match(result.output.terminal_output.open_questions_markdown, /repo-api/);
  const [span] = spanSink.orchestratorTurns;
  assert.deepEqual(span.resource_routing.allowed_resource_ids, ["repo-web", "repo-api"]);
  assert.deepEqual(span.resource_routing.selected_resource_ids, []);
  assert.equal(span.resource_routing.terminal_outcome, "pause");
  assert.equal(span.resource_routing.terminal_reason, "product_questions");
  assert.equal(span.resource_routing.selection_outcome, "pause_product_questions");
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: spanSink records subagent spans without changing the commit path", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_subagent_span_sink";
  const evidenceRef = "trace://subagent/pm/1";
  const runtimeExecutor = scriptedSubagentExecutor([
    validSpawn(runId, { role: "pm", evidenceRef }),
  ]);
  const spans = [];
  const spanSink = {
    recordSubagentTurn(span) {
      spans.push({ ...span });
      throw new Error("sink write failed");
    },
    recordOrchestratorTurn() {
      throw new Error("sink write failed");
    },
  };
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.role, "pm");
  assert.equal(span.outcome, "product_context_sufficient");
  assert.equal(span.parse_status, "valid");
  assert.equal(span.clean_parse, true);
  assert.equal(span.evidence_ref, evidenceRef);
  assert.equal(span.agent_turn_id, "1.1");
  assert.equal(span.parent_turn_id, 1);
  assert.deepEqual(span.control_action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });
  assert.deepEqual(span.spawn_reason, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
    target_label: "PM product sufficiency pass",
  });
  assert.equal(span.produced_content.reason, "product_context_sufficient");
  assert.deepEqual(span.evidence_unavailable, [
    { scope: "pm.turn.tool_events", reason: "runtime_tool_event_channel_unavailable" },
  ]);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: over-cap consumed_input_refs drops the list and merges a lineage marker", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_consumed_refs_over_cap";
  const overflowSpawn = validSpawn(runId, { role: "pm" });
  overflowSpawn.packet.source_refs = Array.from({ length: 300 }, (_, index) => ({
    kind: "linear_project",
    id: `project-${index}`,
  }));
  overflowSpawn.raw_output = JSON.stringify(overflowSpawn.packet);
  overflowSpawn.raw_output_excerpt = overflowSpawn.raw_output;
  overflowSpawn.output = overflowSpawn.raw_output;
  const runtimeExecutor = scriptedSubagentExecutor([overflowSpawn]);
  const spanSink = captureSpanSink();
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(spanSink.subagentTurns.length, 1);
  const [subagentSpan] = spanSink.subagentTurns;
  assert.equal(Object.hasOwn(subagentSpan, "consumed_input_refs"), false);
  assert.deepEqual(subagentSpan.evidence_unavailable, [
    { scope: "pm.turn.tool_events", reason: "runtime_tool_event_channel_unavailable" },
    { scope: "lineage.consumed_refs", reason: "too_many_lineage_consumed_refs" },
  ]);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: throwing rich span construction and sink methods do not change the terminal outcome", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_span_thunk_non_interference";
  const spawn = validSpawn(runId, { role: "pm" });
  Object.defineProperty(spawn, "prompt", {
    get() {
      throw new Error("span prompt getter failed");
    },
  });
  const runtimeExecutor = scriptedSubagentExecutor([spawn]);
  const spanSink = {
    recordSubagentTurn() {
      throw new Error("sink write failed");
    },
    recordOrchestratorTurn() {
      throw new Error("sink write failed");
    },
  };
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        get prompt() {
          throw new Error("orchestrator prompt getter failed");
        },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: span scrub digest-substitutes a secret-bearing field and still emits the span", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_span_secret_digest";
  const secretParseStatus = `${"LINEAR_ACCESS_TOKEN"}=${"linear-secret-value"}`;
  const spawn = validSpawn(runId, { role: "pm" });
  spawn.parse_status = secretParseStatus;
  const runtimeExecutor = scriptedSubagentExecutor([spawn]);
  const spanSink = captureSpanSink();
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  const expectedDigest =
    "sha256:" + createHash("sha256").update(secretParseStatus, "utf8").digest("hex");
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(spanSink.subagentTurns.length, 1);
  assert.equal(spanSink.subagentTurns[0].role, "pm");
  assert.equal(spanSink.subagentTurns[0].outcome, "product_context_sufficient");
  assert.equal(spanSink.subagentTurns[0].parse_status, expectedDigest);
  assert.equal(JSON.stringify(spanSink.subagentTurns[0]).includes("linear-secret-value"), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: local trace scrubber preserves rich prompt output and tool diffs while scrubbing secrets", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_local_full_content_trace";
  const promptBody = [
    "Review the local project context and explain whether decomposition can proceed.",
    "diff --git a/app.txt b/app.txt",
    "+ship the full local diff content",
  ].join("\n");
  const rawOutput = [
    "The role inspected the prompt and returned a grounded answer.",
    "diff --git a/app.txt b/app.txt",
    "+preserve this output diff",
  ].join("\n");
  const toolDiff = [
    "diff --git a/package.json b/package.json",
    "+\"test\": \"node --test\"",
  ].join("\n");
  const tokenValue = ["Bearer ", "abcdefghijklmnop"].join("");
  const secretParseStatus = `${"LINEAR_ACCESS_TOKEN"}=${"linear-secret-value"}`;
  const spawn = validSpawn(runId, { role: "pm" });
  spawn.prompt = promptBody;
  spawn.raw_output = rawOutput;
  spawn.parse_status = secretParseStatus;
  spawn.evidence.tool_events = [{
    type: "tool_result",
    name: "shell",
    input: {
      prompt: "Inspect the local diff and report exact findings.",
    },
    output: {
      shell_output: toolDiff,
      note: `runtime returned ${tokenValue}`,
      api_key: "secret-key-value",
    },
  }];
  const runtimeExecutor = scriptedSubagentExecutor([spawn]);
  const spanSink = captureLocalSpanSink();
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        prompt: "Orchestrator local prompt should survive in the local trace.",
        raw_output: "Orchestrator raw output should survive in the local trace.",
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      prompt: "Termination prompt should also be observable locally.",
      raw_output: "Termination raw output selected the commit path.",
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  const expectedDigest =
    "sha256:" + createHash("sha256").update(secretParseStatus, "utf8").digest("hex");
  assert.equal(result.output.terminal_output.outcome, "commit");
  // B1 owns the content posture; F3/G1 owns putting the rich transcript and
  // lineage fields on these in-loop spans.
  const [orchestratorInvokeSpan, orchestratorTerminateSpan] = spanSink.orchestratorTurns;
  assert.equal(orchestratorInvokeSpan.prompt, "Orchestrator local prompt should survive in the local trace.");
  assert.equal(orchestratorInvokeSpan.raw_output, "Orchestrator raw output should survive in the local trace.");
  assert.deepEqual(orchestratorInvokeSpan.control_action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });
  assert.equal(orchestratorInvokeSpan.produced_content, null);
  assert.deepEqual(orchestratorInvokeSpan.evidence_unavailable, [
    { scope: "orchestrator.turn.tool_events", reason: "runtime_tool_event_channel_unavailable" },
  ]);
  assert.equal(orchestratorTerminateSpan.prompt, "Termination prompt should also be observable locally.");
  assert.equal(orchestratorTerminateSpan.raw_output, "Termination raw output selected the commit path.");
  assert.equal(
    orchestratorTerminateSpan.produced_content.context_digest,
    "Reviewed project intent and grounded constraints for decomposition.",
  );

  const subagentSpan = spanSink.subagentTurns[0];
  assert.equal(subagentSpan.parse_status, expectedDigest);
  assert.equal(subagentSpan.prompt, promptBody);
  assert.equal(subagentSpan.raw_output, rawOutput);
  assert.equal(subagentSpan.tool_events[0].input.prompt, "Inspect the local diff and report exact findings.");
  assert.equal(subagentSpan.tool_events[0].output.shell_output, toolDiff);
  assert.equal(subagentSpan.tool_events[0].output.note, "[redacted token material]");
  assert.deepEqual(subagentSpan.tool_events[0].output.redacted_fields, ["api_key"]);

  const toolEvent = result.runtimeEvidence.pm.turns[0].tool_events[0];
  assert.equal(toolEvent.input.prompt, "Inspect the local diff and report exact findings.");
  assert.equal(toolEvent.output.shell_output, toolDiff);
  assert.equal(toolEvent.output.note, "[redacted token material]");
  assert.deepEqual(toolEvent.output.redacted_fields, ["api_key"]);
  assert.equal(JSON.stringify(spanSink).includes("linear-secret-value"), false);
  assert.equal(JSON.stringify(result.runtimeEvidence).includes(tokenValue), false);
  assert.equal(JSON.stringify(result.runtimeEvidence).includes("secret-key-value"), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: spanSink records orchestrator turns and the single subagent span on the commit path", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_orchestrator_span_sink";
  const evidenceRef = "trace://subagent/pm/commit-path";
  const runtimeExecutor = scriptedSubagentExecutor([
    validSpawn(runId, { role: "pm", evidenceRef }),
  ]);
  const spanSink = captureLocalSpanSink();
  let turn = 0;
  let priorTurnsJsonSeenByTerminal = null;
  const terminalProducedContent = commitProducedContent(runId);
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        prompt: "orchestrator prompt: invoke the PM library target",
        raw_output: "{\"control_action\":{\"action\":\"invoke_library\"}}",
        evidence: null,
      };
    }
    priorTurnsJsonSeenByTerminal = JSON.stringify(priorTurns);
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      prompt: "orchestrator prompt: terminate with commit",
      raw_output: "{\"control_action\":{\"action\":\"terminate\",\"outcome\":\"commit\"}}",
      producedContent: terminalProducedContent,
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(spanSink.orchestratorTurns.length, 2);
  assert.equal(spanSink.subagentTurns.length, 1);

  const [invokeSpan, terminateSpan] = spanSink.orchestratorTurns;
  assert.equal(invokeSpan.round_index, 1);
  assert.equal(invokeSpan.action, "invoke_library");
  assert.equal(invokeSpan.outcome, "continue");
  assert.equal(invokeSpan.target_key, "prompt/decomposition/pm_product_sufficiency_pass");
  assert.equal(invokeSpan.bounds.rounds_used, 1);
  assert.equal(invokeSpan.bounds.invocations, 0);
  assert.equal(invokeSpan.prompt, "orchestrator prompt: invoke the PM library target");
  assert.equal(invokeSpan.raw_output, "{\"control_action\":{\"action\":\"invoke_library\"}}");
  assert.deepEqual(invokeSpan.control_action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });
  assert.equal(invokeSpan.produced_content, null);
  assert.equal(invokeSpan.agent_turn_id, 1);
  assert.equal(invokeSpan.parent_turn_id, null);
  assert.deepEqual(invokeSpan.spawn_reason, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });
  assert.equal(Object.hasOwn(invokeSpan.spawn_reason, "target_label"), false);

  assert.equal(terminateSpan.round_index, 2);
  assert.equal(terminateSpan.action, "terminate");
  assert.equal(terminateSpan.outcome, "commit");
  assert.equal(terminateSpan.reason, "synthesis_complete");
  assert.equal(terminateSpan.bounds.rounds_used, 2);
  assert.equal(terminateSpan.bounds.invocations, 1);
  assert.equal(terminateSpan.prompt, "orchestrator prompt: terminate with commit");
  assert.equal(terminateSpan.raw_output, "{\"control_action\":{\"action\":\"terminate\",\"outcome\":\"commit\"}}");
  assert.deepEqual(terminateSpan.control_action, {
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
  });
  assert.deepEqual(terminateSpan.produced_content, terminalProducedContent);
  assert.equal(terminateSpan.agent_turn_id, 2);
  assert.equal(terminateSpan.parent_turn_id, null);
  assert.deepEqual(terminateSpan.spawn_reason, {
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
  });

  assert.deepEqual(
    {
      role: spanSink.subagentTurns[0].role,
      outcome: spanSink.subagentTurns[0].outcome,
      parse_status: spanSink.subagentTurns[0].parse_status,
      clean_parse: spanSink.subagentTurns[0].clean_parse,
      evidence_ref: spanSink.subagentTurns[0].evidence_ref,
    },
    {
      role: "pm",
      outcome: "product_context_sufficient",
      parse_status: "valid",
      clean_parse: true,
      evidence_ref: evidenceRef,
    },
  );
  assert.equal(spanSink.subagentTurns[0].prompt, "repair envelope for pm");
  assert.match(spanSink.subagentTurns[0].raw_output, /product_context_sufficient/);
  assert.deepEqual(spanSink.subagentTurns[0].control_action, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });
  assert.equal(spanSink.subagentTurns[0].produced_content.reason, "product_context_sufficient");
  assert.equal(spanSink.subagentTurns[0].agent_turn_id, "1.1");
  assert.equal(spanSink.subagentTurns[0].parent_turn_id, 1);
  assert.deepEqual(spanSink.subagentTurns[0].spawn_reason, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
    target_label: "PM product sufficiency pass",
  });
  assert.deepEqual(spanSink.subagentTurns[0].evidence_unavailable, [
    { scope: "pm.turn.tool_events", reason: "runtime_tool_event_channel_unavailable" },
  ]);
  assert.equal(
    priorTurnsJsonSeenByTerminal,
    JSON.stringify([{
      controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
      outcome: "product_context_sufficient",
      role: "pm",
      instance_id: "pm#default",
      status: "continue",
      reason: "product_context_sufficient",
      failure_kind: null,
      failure_code: null,
      context_digest: "product_context_sufficient digest",
      open_questions_markdown: null,
      source_refs: [{ kind: "linear_project", id: "project-1" }],
    }]),
  );
  assert.equal(priorTurnsJsonSeenByTerminal.includes("agent_turn_id"), false);
  assert.equal(priorTurnsJsonSeenByTerminal.includes("parent_turn_id"), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: first orchestrator span carries the resolved run-config projection", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const workflow = config.workflows.decomposition;
  Object.defineProperty(workflow, "unpinned_runtime", {
    value: { pm: { model: true } },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  const runId = "run_loop_run_config_projection";
  const runtimeExecutor = scriptedSubagentExecutor([
    validSpawn(runId, { role: "pm" }),
  ]);
  const spanSink = captureSpanSink();
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    maxRounds: 7,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(spanSink.orchestratorTurns.length, 2);
  const [firstSpan, secondSpan] = spanSink.orchestratorTurns;
  assert.equal(secondSpan.run_config, undefined);

  const projection = firstSpan.run_config;
  assert.ok(projection, "first orchestrator turn should carry run_config");
  assert.equal(projection.max_rounds, 7);
  assert.deepEqual(projection.accepted_runtime_defaults_ref, workflow.accepted_runtime_defaults_ref);
  assert.equal(projection.accepted_runtime_defaults_ref.target_key, "rule/decomposition/runtime_role_assignments");

  assert.equal(
    projection.orchestrator_persona_accepted_version.target_key,
    "prompt/decomposition/orchestrator_governing",
  );
  assert.equal(typeof projection.orchestrator_persona_accepted_version.accepted_baseline_id, "string");
  assert.equal(typeof projection.orchestrator_persona_accepted_version.snapshot_sha256, "string");

  assert.deepEqual(
    Object.keys(projection.roles).sort(),
    ["drafter", "judge", "orchestrator", "pm", "sr_eng"],
  );
  assert.deepEqual(projection.roles.pm, {
    runtime: workflow.roles.pm.runtime,
    model: workflow.roles.pm.model,
    provenance: workflow.role_field_sources.pm,
    unpinned: { model: true },
  });
  assert.deepEqual(projection.roles.orchestrator, {
    runtime: workflow.roles.orchestrator.runtime,
    model: workflow.roles.orchestrator.model,
    provenance: workflow.role_field_sources.orchestrator,
  });
  assert.deepEqual(projection.roles.judge, {
    runtime: workflow.roles.judge.runtime,
    model: workflow.roles.judge.model,
    provenance: workflow.role_field_sources.judge,
  });
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// No-abort recovery for the ORCHESTRATOR's OWN turn (parallel to subagent recovery):
// a malformed/failed orchestrator turn must not abort the run. One repair retry, then
// a clean harness failed_closed on exhaustion.
test("orchestrator loop: a malformed orchestrator turn is repaired on retry and the run proceeds", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_orch_repair";
  let calls = 0;
  let retryHint = null;
  const orchestratorTurnExecutor = async ({ repairHint }) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("orchestrator_turn_invalid_control_action: control_action_not_object");
    }
    retryHint = repairHint;
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(calls, 2); // attempt 1 (threw) + one repair retry
  assert.ok(retryHint && retryHint.includes("control_action"), "the retry must carry a repair hint");
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: a malformed orchestrator turn that also fails its repair retry ends failed_closed (no abort)", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_orch_recover_exhausted";
  const spanSink = captureSpanSink();
  let calls = 0;
  const orchestratorTurnExecutor = async () => {
    calls += 1;
    throw new Error("orchestrator_turn_invalid_control_action: control_action_not_object");
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(calls, 2); // attempt + one repair retry, then a clean terminal (never thrown)
  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "orchestrator_turn_validation_failed");
  assert.deepEqual(spanSink.subagentTurns, []);
  assert.equal(spanSink.orchestratorTurns.length, 1);
  const [failedClosedSpan] = spanSink.orchestratorTurns;
  assert.equal(failedClosedSpan.round_index, 1);
  assert.equal(failedClosedSpan.action, "orchestrator_repair_exhausted");
  assert.equal(failedClosedSpan.outcome, "failed_closed");
  assert.equal(failedClosedSpan.reason, "orchestrator_turn_validation_failed");
  assert.equal(failedClosedSpan.bounds.rounds_used, 1);
  assert.equal(failedClosedSpan.bounds.invocations, 0);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// (2) A run that breaches bounds (low maxRounds injection) -> failed_closed /
// bounds_breach, with a valid terminal output.
test("orchestrator loop: a run that breaches bounds ends failed_closed/bounds_breach", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_bounds";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  const spanSink = captureSpanSink();
  // The orchestrator never terminates — it keeps invoking the library, so the
  // harness must emit the bounds breach itself.
  const orchestratorTurnExecutor = async () => ({
    controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
    evidence: null,
    sessionHandle: null,
  });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: null,
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    maxRounds: 2,
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "bounds_breach");
  assert.equal(result.output.bounds.max_rounds, 2);
  // rounds_used counts ACTUAL decision turns executed: with max_rounds=2 the loop
  // runs exactly 2 turns and then stops closed (no phantom 3rd round).
  assert.equal(result.output.bounds.rounds_used, 2);
  assert.match(result.output.terminal_output.open_questions_markdown, /round limit/);
  assert.equal(spanSink.orchestratorTurns.length, 3);
  assert.deepEqual(
    spanSink.orchestratorTurns.slice(0, 2).map((span) => span.action),
    ["invoke_library", "invoke_library"],
  );
  assert.deepEqual(
    spanSink.subagentTurns.map((span) => span.outcome),
    ["product_context_sufficient", "product_context_sufficient"],
  );
  const boundsBreachSpan = spanSink.orchestratorTurns[2];
  assert.equal(boundsBreachSpan.round_index, 3);
  assert.equal(boundsBreachSpan.action, "bounds_breach");
  assert.equal(boundsBreachSpan.outcome, "failed_closed");
  assert.equal(boundsBreachSpan.reason, "bounds_breach");
  assert.equal(boundsBreachSpan.turn_executed, false);
  assert.equal(boundsBreachSpan.bounds.rounds_used, 2);
  assert.equal(boundsBreachSpan.bounds.max_rounds, 2);
  assert.equal(boundsBreachSpan.bounds.invocations, 2);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: prose-wrapped subagent output gets one repair retry and records retry success", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_parse_repair_success";
  const originalPacket = subagentTurn(runId, { reason: "product_context_sufficient" });
  const preservedEnvelope = "PRESERVED SUBAGENT ENVELOPE\nrun_id: run_loop_parse_repair_success";
  const runtimeExecutor = scriptedSubagentExecutor([
    parseFailureSpawn({
      envelope: preservedEnvelope,
      raw_output_excerpt: `diagnostic preamble\n${JSON.stringify(originalPacket)}`,
    }),
    (input) => validSpawn(runId, { envelope: input.envelopeOverride }),
  ]);
  let turn = 0;
  let priorTurnsSeenByTerminal = null;
  const spanSink = captureSpanSink();
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    priorTurnsSeenByTerminal = priorTurns;
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };
  let renewCalls = 0;

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
    renew: async () => { renewCalls += 1; },
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(runtimeExecutor.calls.length, 2);
  assert.equal(runtimeExecutor.calls[1].timeoutMs, REPAIR_RETRY_TIMEOUT_MS);
  assert.ok(runtimeExecutor.calls[1].envelopeOverride.startsWith(`${preservedEnvelope}\n\n`));
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /failure_code: invalid_packet/);
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /diagnostic: prose_wrapped_json_packet/);
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /diagnostic preamble/);
  assert.match(
    runtimeExecutor.calls[1].envelopeOverride,
    /Your previous output was not a single clean JSON packet/,
  );
  assert.equal(result.output.bounds.invocations, 2);
  assert.equal(renewCalls, 3);
  assert.equal(result.output.evidence.perspectives_run.length, 2);
  assert.equal(result.output.evidence.perspectives_run[0].outcome, "subagent_turn_invalid");
  assert.equal(result.output.evidence.perspectives_run[0].failure_code, "invalid_packet");
  assert.equal(result.output.evidence.perspectives_run[1].outcome, "product_context_sufficient");
  assert.equal(result.runtimeEvidence.pm.turns.length, 2);
  assert.equal(result.runtimeEvidence.pm.turns[0].outcome, "subagent_turn_invalid");
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.parse_status, "invalid");
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.clean_parse, false);
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.failure_code, "invalid_packet");
  assert.match(result.runtimeEvidence.pm.turns[0].subagent_evidence.raw_output_excerpt, /diagnostic preamble/);
  assert.equal(result.runtimeEvidence.pm.turns[1].outcome, "product_context_sufficient");
  assert.equal(result.runtimeEvidence.pm.turns[1].subagent_evidence.parse_status, "valid");
  assert.equal(result.runtimeEvidence.pm.turns[1].subagent_evidence.clean_parse, true);
  assert.deepEqual(
    priorTurnsSeenByTerminal.map((priorTurn) => priorTurn.outcome),
    ["subagent_turn_invalid", "product_context_sufficient"],
  );
  assert.deepEqual(
    spanSink.subagentTurns.map((span) => span.agent_turn_id),
    ["1.1", "1.2"],
  );
  assert.deepEqual(
    spanSink.subagentTurns.map((span) => span.parent_turn_id),
    [1, 1],
  );
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: repair exhaustion records a failed turn and fails closed for validation", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_parse_repair_failed";
  const packet = subagentTurn(runId, { reason: "product_context_sufficient" });
  const preservedEnvelope = "PRESERVED ENVELOPE FOR FAILED REPAIR";
  const runtimeExecutor = scriptedSubagentExecutor([
    parseFailureSpawn({
      envelope: preservedEnvelope,
      raw_output_excerpt: `runtime chatter\n${JSON.stringify(packet)}`,
    }),
    parseFailureSpawn({
      envelope: `${preservedEnvelope}\n\nrepair`,
      raw_output_excerpt: "still not a clean packet",
    }),
  ]);
  const orchestratorTurnExecutor = async () => ({
    controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
    evidence: null,
  });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "subagent_turn_validation_failed");
  assert.equal(result.output.bounds.rounds_used, 1);
  assert.equal(result.output.bounds.invocations, 2);
  assert.match(result.output.terminal_output.project_update_markdown, /failed validation after a repair retry/);
  assert.doesNotMatch(result.output.terminal_output.project_update_markdown, /allowed rounds/);
  assert.equal(runtimeExecutor.calls.length, 2);
  assert.ok(runtimeExecutor.calls[1].envelopeOverride.startsWith(`${preservedEnvelope}\n\n`));
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /diagnostic: prose_wrapped_json_packet/);

  assert.equal(result.output.evidence.perspectives_run.length, 2);
  assert.deepEqual(
    result.output.evidence.perspectives_run.map((perspective) => perspective.outcome),
    ["subagent_turn_invalid", "subagent_turn_invalid"],
  );
  assert.deepEqual(
    result.output.evidence.perspectives_run.map((perspective) => perspective.failure_code),
    ["invalid_packet", "invalid_packet"],
  );
  assert.equal(result.runtimeEvidence.pm.turns.length, 2);
  const [firstAttemptEvidence, retryEvidence] = result.runtimeEvidence.pm.turns;
  assert.equal(firstAttemptEvidence.outcome, "subagent_turn_invalid");
  assert.equal(firstAttemptEvidence.failure_code, "invalid_packet");
  assert.equal(firstAttemptEvidence.subagent_evidence.failure_code, "invalid_packet");
  assert.match(firstAttemptEvidence.subagent_evidence.raw_output_excerpt, /runtime chatter/);
  assert.equal(retryEvidence.outcome, "subagent_turn_invalid");
  assert.equal(retryEvidence.failure_code, "invalid_packet");
  assert.equal(retryEvidence.subagent_evidence.failure_code, "invalid_packet");
  assert.match(retryEvidence.subagent_evidence.raw_output_excerpt, /still not a clean packet/);
  assert.equal(JSON.stringify(result.output).includes('"unknown"'), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: pure invalid subagent output without a packet uses the same repair path", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_no_packet_repair";
  const preservedEnvelope = "NO PACKET ORIGINAL ENVELOPE";
  const runtimeExecutor = scriptedSubagentExecutor([
    parseFailureSpawn({
      envelope: preservedEnvelope,
      raw_output_excerpt: "plain text with no json packet",
    }),
    (input) => validSpawn(runId, { envelope: input.envelopeOverride }),
  ]);
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.bounds.invocations, 2);
  assert.ok(runtimeExecutor.calls[1].envelopeOverride.startsWith(`${preservedEnvelope}\n\n`));
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /diagnostic: no_json_packet/);
  assert.match(runtimeExecutor.calls[1].envelopeOverride, /plain text with no json packet/);
  assert.deepEqual(
    result.output.evidence.perspectives_run.map((perspective) => perspective.outcome),
    ["subagent_turn_invalid", "product_context_sufficient"],
  );
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.parse_status, "invalid");
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.clean_parse, false);
  assert.equal(result.runtimeEvidence.pm.turns[1].subagent_evidence.parse_status, "valid");
  assert.equal(result.runtimeEvidence.pm.turns[1].subagent_evidence.clean_parse, true);
});

test("orchestrator loop: blocked subagent needs stay distinct from terminal pause reasons", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_blocked_needs_pause";
  const runtimeExecutor = scriptedSubagentExecutor([
    (input) => validSpawn(runId, {
      role: input.runtime_role,
      status: "blocked",
      reason: "needs_discovery",
      envelope: input.envelopeOverride,
    }),
    (input) => validSpawn(runId, {
      role: input.runtime_role,
      status: "blocked",
      reason: "needs_product_input",
      envelope: input.envelopeOverride,
    }),
  ]);
  const libraryOrder = [
    "prompt/decomposition/sr_eng_grounding_pass",
    "prompt/decomposition/pm_product_sufficiency_pass",
  ];
  let turn = 0;
  let priorTurnsSeenByPause = null;
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        evidence: null,
      };
    }
    priorTurnsSeenByPause = priorTurns;
    return {
      controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
      producedContent: pauseProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  const priorReasons = priorTurnsSeenByPause.map((priorTurn) => priorTurn.reason);
  assert.deepEqual(priorReasons, ["needs_discovery", "needs_product_input"]);
  assert.ok(priorReasons.every((reason) => SUBAGENT_TURN_OUTCOMES.blocked.includes(reason)));
  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "product_questions");
  assert.ok(ORCHESTRATOR_OUTCOME_REASONS.pause.includes(result.output.terminal_output.reason));
  assert.deepEqual(
    SUBAGENT_TURN_OUTCOMES.blocked.filter((reason) => ORCHESTRATOR_OUTCOME_REASONS.pause.includes(reason)),
    [],
  );
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: process failures are recorded and the next orchestrator turn can pause", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_process_failure_pause";
  const runtimeExecutor = scriptedSubagentExecutor([
    processFailureSpawn({ failure_code: "timed_out" }),
  ]);
  let turn = 0;
  let priorTurnsSeenByPause = null;
  const orchestratorTurnExecutor = async ({ priorTurns }) => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    priorTurnsSeenByPause = priorTurns;
    return {
      controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
      producedContent: pauseProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "product_questions");
  assert.equal(result.output.bounds.invocations, 1);
  assert.equal(runtimeExecutor.calls.length, 1);
  assert.equal(runtimeExecutor.calls[0].envelopeOverride, undefined);
  assert.equal(priorTurnsSeenByPause[0].outcome, "subagent_turn_invalid");
  assert.equal(priorTurnsSeenByPause[0].failure_kind, "process");
  assert.equal(priorTurnsSeenByPause[0].failure_code, "timed_out");
  assert.equal(result.output.evidence.perspectives_run[0].outcome, "subagent_turn_invalid");
  assert.equal(result.output.evidence.perspectives_run[0].failure_code, "timed_out");
  assert.equal(result.runtimeEvidence.pm.turns[0].outcome, "subagent_turn_invalid");
  assert.equal(result.runtimeEvidence.pm.turns[0].failure_code, "timed_out");
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.failure_code, "timed_out");
  assert.equal(JSON.stringify(result.output).includes('"unknown"'), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// (3) eval-mode runs the SAME loop read-only: no Linear mutation is reachable,
// and the orchestrator output is produced over the snapshot client.
test("orchestrator loop: eval-mode is read-only over the orchestrator loop", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "eval_loop_readonly";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  const project = {
    id: "project-1",
    name: "Eval Project",
    description: null,
    content: "## Goal\n\nDo it.\n",
    status: "planned",
    labels: [],
    existing_issues: [],
  };
  // The snapshot-backed eval client has NO mutation surface at all; the
  // read-only guard is the second wall.
  const { client: snapshotClient, cache } = createSnapshotEvalLinearClient({ config, project });

  const libraryOrder = [
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/sr_eng_grounding_pass",
  ];
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        prompt: `eval orchestrator prompt ${turn}`,
        raw_output: `eval orchestrator raw output ${turn}`,
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      prompt: "eval orchestrator prompt terminate",
      raw_output: "eval orchestrator raw output terminate",
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const domainContext = Object.freeze({
    domainId: "support-ops",
    linear: Object.freeze({ workspaceId: "ws-1", teamId: "team-1" }),
    trace: Object.freeze({ domain_id: "support-ops", workspace_id: "ws-1", team_id: "team-1", behavior_repo_id: "local:test" }),
  });

  // The eval-mode guard wraps even a live client read-only: a mutation method
  // throws rather than executing.
  const guarded = createEvalModeReadOnlyLinearClient(snapshotClient);
  assert.equal((await guarded.getProjectContext("project-1")).id, "project-1");

  const result = await runDecompositionEvalMode({
    linearClient: snapshotClient,
    config,
    cache,
    projectId: "project-1",
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    runId,
    repoRoot: REPO_ROOT,
    runStoreDir: path.join(
      os.tmpdir(),
      "teami-eval-runs-test-readonly",
      `${runId}-${process.pid}-${Date.now()}`,
    ),
    domainContext,
  });

  // The run produced an orchestrator commit output over the snapshot client; no
  // mutation was reachable (the snapshot client has no mutation surface).
  assert.equal(result.orchestratorOutput.terminal_output.outcome, "commit");
  assert.equal(result.mutationSkipped, true);
  assert.equal(result.subagent_evidence.length, 2);
  assert.deepEqual(result.subagent_evidence.map((record) => record.role), ["pm", "sr_eng"]);
  assert.equal(result.subagent_evidence[0].parse_status, "valid");
  assert.equal(result.subagent_evidence[0].clean_parse, true);
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.role, "pm");
  const exportedOrchestratorSpan = result.trace.spans
    .find((span) => span.name === "orchestrator_turn.1")?.attributes;
  assert.equal(exportedOrchestratorSpan.prompt, "eval orchestrator prompt 1");
  assert.equal(exportedOrchestratorSpan.raw_output, "eval orchestrator raw output 1");
  assert.equal(exportedOrchestratorSpan.agent_turn_id, 1);
  assert.deepEqual(exportedOrchestratorSpan.spawn_reason, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
  });

  const exportedPmSpan = result.trace.spans
    .find((span) => span.name === "subagent_turn.pm")?.attributes;
  assert.equal(exportedPmSpan.prompt, "fake envelope for pm");
  assert.match(exportedPmSpan.raw_output, /product_context_sufficient/);
  assert.equal(exportedPmSpan.agent_turn_id, "1.1");
  assert.equal(exportedPmSpan.parent_turn_id, 1);
  assert.deepEqual(exportedPmSpan.spawn_reason, {
    action: "invoke_library",
    target_key: "prompt/decomposition/pm_product_sufficiency_pass",
    target_label: "PM product sufficiency pass",
  });
  assert.equal(exportedPmSpan.produced_content.reason, "product_context_sufficient");
  assert.deepEqual(exportedPmSpan.evidence_unavailable, [
    { scope: "pm.turn.tool_events", reason: "runtime_tool_event_channel_unavailable" },
  ]);
});

// (4) PRODUCTION-PARSER path (BUG 1 regression): drive the loop through the REAL
// executeOrchestratorTurn -> defaultOrchestratorRuntime -> real envelope parse,
// faking ONLY the CLI subprocess (runCommand). The runtime emits the turn-output
// ENVELOPE { control_action, produced_content }; the real path must lift
// produced_content out and a terminate(commit) must yield a VALIDATED commit.
// A stubbed orchestratorTurnExecutor would have masked the original bug (the real
// runtime returned no producedContent, so commits were impossible).
test("orchestrator loop: the REAL runtime parses the { control_action, produced_content } envelope into a validated commit", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_real_parse";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  const assignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;

  // The fake runCommand stands in for the spawned CLI: it returns a realistic
  // turn-output ENVELOPE string per orchestrator turn (no real CLI is spawned).
  // Turn 1 invokes a library; turn 2 terminates with commit + produced_content
  // carrying one fully-authored final issue.
  let runtimeCall = 0;
  const commandsSeen = [];
  const fakeRunCommand = async (command) => {
    commandsSeen.push(command);
    runtimeCall += 1;
    if (runtimeCall === 1) {
      return JSON.stringify({
        control_action: {
          action: "invoke_library",
          target_key: "prompt/decomposition/pm_product_sufficiency_pass",
        },
      });
    }
    return JSON.stringify({
      control_action: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      produced_content: commitProducedContent(runId),
    });
  };

  // No stubbed orchestratorTurnExecutor: this wrapper runs the REAL
  // executeOrchestratorTurn, whose runtime is the REAL defaultOrchestratorRuntime
  // with only the CLI subprocess faked. parseControlAction + the envelope split
  // both run for real.
  const orchestratorTurnExecutor = (input) =>
    executeOrchestratorTurn({
      ...input,
      orchestratorRuntime: (runtimeInput) =>
        defaultOrchestratorRuntime({ ...runtimeInput, assignment, runCommand: fakeRunCommand, repoRoot: REPO_ROOT }),
    });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    repoRoot: REPO_ROOT,
  });

  // The commit came out of the REAL parse path: produced_content -> final_issues.
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");
  assert.equal(result.output.terminal_output.final_issues.length, 1);
  assert.equal(result.output.terminal_output.final_issues[0].decomposition_key, "project-plan");
  assert.deepEqual(runtimeExecutor.calls.map((c) => c.runtime_role), ["pm"]);
  assert.equal(commandsSeen.length, 2);
  const secondPrompt = promptFromCommand(commandsSeen[1], "Decisions so far this run:");
  assert.ok(secondPrompt, "second orchestrator turn should include the prompt");
  assert.match(secondPrompt, /"status": "continue"/);
  assert.match(secondPrompt, /"reason": "product_context_sufficient"/);
  assert.match(secondPrompt, /"context_digest": "product_context_sufficient digest"/);
  assert.match(secondPrompt, /"runtime_role": "pm"/);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: subagent question text reaches the next prompt and final project comment body", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_question_text";
  const roster = fakeRoster();
  const exactQuestion = [
    "- Question: needs_constraint_decision - should we keep silent retries or show retry failures to users?",
    "  Why it blocks: the issue split changes depending on the trust promise.",
    "  Owner: Human",
  ].join("\n");
  const runtimeExecutor = scriptedSubagentExecutor([
    (input) => validSpawn(runId, {
      role: input.runtime_role,
      status: "blocked",
      reason: "needs_constraint_decision",
      packetFields: {
        open_questions_markdown: exactQuestion,
        technical_explanation_markdown:
          "Silent retries would change the user-visible trust promise for failed integrations.",
      },
    }),
  ]);
  const assignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;
  let runtimeCall = 0;
  const commandsSeen = [];
  const fakeRunCommand = async (command) => {
    commandsSeen.push(command);
    runtimeCall += 1;
    if (runtimeCall === 1) {
      return JSON.stringify({
        control_action: {
          action: "invoke_library",
          target_key: "prompt/decomposition/sr_eng_grounding_pass",
        },
      });
    }
    return JSON.stringify({
      control_action: { action: "terminate", outcome: "pause", reason: "needs_pm_review" },
      produced_content: {
        context_digest: "The technical constraint needs a product decision.",
        source_refs: [{ kind: "linear_project", id: "project-1" }],
        assumptions: [],
        constraints: ["silent retries affect trust copy"],
        risks: [],
        open_questions_markdown: exactQuestion,
      },
    });
  };
  const orchestratorTurnExecutor = (input) =>
    executeOrchestratorTurn({
      ...input,
      orchestratorRuntime: (runtimeInput) =>
        defaultOrchestratorRuntime({ ...runtimeInput, assignment, runCommand: fakeRunCommand, repoRoot: REPO_ROOT }),
    });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    repoRoot: REPO_ROOT,
  });

  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "needs_pm_review");
  assert.equal(result.output.terminal_output.open_questions_markdown, exactQuestion);
  const secondPrompt = promptFromCommand(commandsSeen[1], "Decisions so far this run:");
  assert.ok(secondPrompt, "second orchestrator turn should include the prior-turn digest");
  assert.match(secondPrompt, /needs_constraint_decision/);
  assert.ok(secondPrompt.includes(JSON.stringify(exactQuestion).slice(1, -1)));
  assert.match(secondPrompt, /technical_explanation_markdown/);
  const commentBody = buildProjectNeedsPrincipalCommentBody({
    runId,
    questionsMarkdown: result.output.terminal_output.open_questions_markdown,
  });
  assert.ok(commentBody.includes(exactQuestion));
  assert.doesNotMatch(commentBody, /What product decision should be resolved/);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// (5) COMMIT FLOOR rejects under-specified issues (BUG 2 regression). The commit
// floor must REJECT an issue that authors only a title — it must NOT synthesize
// the agent-ready substance (issue_body_markdown/assignment/output/
// acceptance_criteria/decomposition_key). A {title:"stub"}-only issue fails the
// single commit floor; a fully-authored issue still commits.
test("orchestrator loop: a title-only commit issue is REJECTED (no fabricated substance); a fully-authored issue commits", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const roster = fakeRoster();

  const commitWith = (runId, finalIssues) => {
    let turn = 0;
    return async () => {
      turn += 1;
      if (turn === 1) {
        return {
          controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
          evidence: null,
        };
      }
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: {
          ...commitProducedContent(runId),
          final_issues: finalIssues,
        },
        evidence: null,
      };
    };
  };

  // A {title:"stub"}-only issue is missing every other agent-ready field. The
  // commit floor rejects it (the harness throws on the failed validation) rather
  // than inventing issue_body_markdown/assignment/output/acceptance_criteria.
  await assert.rejects(
    () =>
      runDecompositionOrchestrator({
        runId: "run_loop_stub_issue",
        wake: { id: "wake-1", object_id: "project-1" },
        event: { id: "event-1" },
        project: { id: "project-1", name: "Project" },
        config,
        runtimeExecutor: fakeSubagentExecutor(),
        orchestratorTurnExecutor: commitWith("run_loop_stub_issue", [{ title: "stub" }]),
        roster,
      }),
    (error) => {
      assert.match(error.message, /Orchestrator output failed validation/);
      // The rejection names the MISSING authored fields — proof nothing was
      // fabricated to fill them.
      assert.match(error.message, /missing_final_issue_decomposition_key/);
      assert.match(error.message, /missing_final_issue_issue_body_markdown/);
      assert.match(error.message, /missing_final_issue_assignment/);
      assert.match(error.message, /missing_final_issue_output/);
      assert.match(error.message, /missing_final_issue_acceptance_criteria/);
      return true;
    },
  );

  // The same loop with a fully-authored issue commits cleanly.
  const authoredIssue = {
    decomposition_key: "project-plan",
    title: "Prepare execution setup",
    issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
    depends_on: [],
    assignment: "Plan the setup.",
    output: "A documented execution setup plan.",
    acceptance_criteria: ["Plan exists."],
  };
  const ok = await runDecompositionOrchestrator({
    runId: "run_loop_authored_issue",
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: commitWith("run_loop_authored_issue", [authoredIssue]),
    roster,
  });
  assert.equal(ok.output.terminal_output.outcome, "commit");
  assert.equal(ok.output.terminal_output.final_issues.length, 1);
  assert.deepEqual(validateOrchestratorOutput(ok.output), { ok: true, failureReasons: [] });
});

// (6) ALIAS normalization is preserved (BUG 2: keep aliases, drop synthesis). An
// issue authored with camelCase/alternate spellings still commits — the aliases
// map onto the canonical keys without fabricating any value.
test("orchestrator loop: camelCase issue aliases normalize to a valid commit", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const roster = fakeRoster();
  const runId = "run_loop_aliases";

  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: {
        ...commitProducedContent(runId),
        final_issues: [
          {
            decompositionKey: "project-plan",
            title: "Prepare execution setup",
            description: "## Assignment\n\nPlan the setup.",
            dependsOn: [],
            assignment: "Plan the setup.",
            output: "A documented execution setup plan.",
            acceptanceCriteria: ["Plan exists."],
          },
        ],
      },
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor,
    roster,
  });

  const [issue] = result.output.terminal_output.final_issues;
  assert.equal(issue.decomposition_key, "project-plan");
  assert.equal(issue.issue_body_markdown, "## Assignment\n\nPlan the setup.");
  assert.deepEqual(issue.depends_on, []);
  assert.deepEqual(issue.acceptance_criteria, ["Plan exists."]);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// (7) SAME-ROLE repeat assembles a terminal artifact (BUG 4 regression). The
// orchestrator legitimately invokes the SAME role twice (the roster has pm
// twice: sufficiency + synthesis). Each invocation is an independent
// session_start emitting only evidence_unavailable (no warm continuation). The
// FULL-PATH artifact assembly (terminalArtifact -> buildRuntimeMetadata) must
// succeed for a 2x-same-role run — it must NOT throw demanding warm-continuation
// evidence — and must record honest session_start runtime metadata.
test("orchestrator loop: invoking the same role (pm) twice assembles a terminal commit artifact", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_same_role_twice";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  const runtimeAssignments = resolveRoleRuntimeAssignments(config, "decomposition");

  // Invoke pm TWICE (the same library target both times), then terminate commit.
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn <= 2) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
  });

  // The loop ran pm twice and committed.
  assert.deepEqual(runtimeExecutor.calls.map((c) => c.runtime_role), ["pm", "pm"]);
  assert.equal(result.output.terminal_output.outcome, "commit");
  // pm produced two turns in the run's runtime evidence (the 2x-same-role case).
  assert.equal(result.runtimeEvidence.pm.turns.length, 2);

  // FULL-PATH artifact assembly must NOT throw on the repeated same-role turns.
  let artifact;
  assert.doesNotThrow(() => {
    artifact = terminalArtifact({
      runId,
      projectId: "project-1",
      domainTrace: { domain_id: "support-ops", workspace_id: "ws-1", team_id: "team-1" },
      runResult: result.output,
      runtimeAssignments,
      runtimeEvidence: result.runtimeEvidence,
      environment: result.environment,
    });
  });

  assert.equal(artifact.kind, "commit");
  // Honest session_start metadata for the repeated role: no warm continuation.
  const pmMeta = artifact.runtime_metadata.pm;
  assert.equal(pmMeta.invocation_mode, "session_start");
  assert.equal(pmMeta.observed_warm_continuation, false);
  assert.equal(pmMeta.continuation_capability_flags.warm_continuation_required, false);
});

// (8) I-4 — ONE-OFF EVIDENCE in perspectives_run. When the orchestrator runs an
// invoke_one_off, the harness enriches THAT spawn's perspectives_run entry with a
// sanitized invocation reference (role_label, task, runtime_role + the prompt
// BODY when safe, or ref+digest when the body trips the sanitizer) — enough for a
// human to hand-author a promotion snapshot PR WITHOUT reconstruction. The
// enrichment rides on the existing entry (no one_offs[] array) and does NOT widen
// validateOrchestratorOutput. Library/governing entries are NOT enriched.

// A SECRET-BEARING one-off body: the embedded GitHub-style token (ghp_ + 22
// chars) trips the content-policy sanitizer's SECRET_VALUE_PATTERN
// (findSecretContentKeys / enforceTraceContentPolicy). Assembled by
// concatenation so the literal token is not pasted whole into source.
const SECRET_BEARING_ONE_OFF_PROMPT =
  `Audit the deploy script. Use the token ${"ghp_"}${"abcdef0123456789ABCDEF"} to read CI logs.`;

// Drive an invoke_one_off (runtime_role pm so the fake executor returns a valid
// continue packet) then terminate(commit). A library invocation precedes the
// one-off so the test can assert the library entry is NOT enriched.
function oneOffThenCommit(runId, oneOffPrompt) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
      };
    }
    if (turn === 2) {
      return {
        controlAction: {
          action: "invoke_one_off",
          role_label: "risk_scanner",
          task: "Scan the project for risky deploy steps before decomposition.",
          prompt: oneOffPrompt,
          runtime_role: "pm",
        },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };
}

test("orchestrator loop: a CLEAN one-off body is persisted verbatim on its perspectives_run entry (promotable without reconstruction)", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_one_off_clean";
  const cleanPrompt = "Scan the project description for deploy-time risks and report any that block decomposition.";
  const runtimeExecutor = fakeSubagentExecutor();
  const spanSink = captureSpanSink();

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor: oneOffThenCommit(runId, cleanPrompt),
    roster: fakeRoster(),
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");

  const perspectives = result.output.evidence.perspectives_run;
  // One library spawn (pm) + one one-off spawn (pm) = two entries.
  assert.equal(perspectives.length, 2);
  const [libraryEntry, oneOffEntry] = perspectives;

  // The LIBRARY entry is NOT enriched (no one_off reference).
  assert.equal(libraryEntry.one_off, undefined);

  // The ONE-OFF entry carries the full sanitized reference: a human has the
  // label, task, runtime role, AND the verbatim body — enough to author a
  // promotion PR without reconstructing the invocation.
  assert.ok(oneOffEntry.one_off, "one-off entry should carry a one_off reference");
  assert.equal(oneOffEntry.one_off.role_label, "risk_scanner");
  assert.equal(oneOffEntry.one_off.task, "Scan the project for risky deploy steps before decomposition.");
  assert.equal(oneOffEntry.one_off.runtime_role, "pm");
  assert.equal(oneOffEntry.one_off.prompt_body, cleanPrompt);
  assert.equal(
    runtimeExecutor.calls[1].task,
    "Scan the project for risky deploy steps before decomposition.",
  );
  assert.equal(runtimeExecutor.calls[1].priorDigest.length, 1);
  // A clean body is NOT redacted and carries no digest fallback.
  assert.equal(oneOffEntry.one_off.prompt_body_redacted, undefined);
  assert.equal(oneOffEntry.one_off.prompt_body_digest, undefined);
  assert.deepEqual(spanSink.orchestratorTurns[1].spawn_reason, {
    action: "invoke_one_off",
    runtime_role: "pm",
    role_label: "risk_scanner",
    task: "Scan the project for risky deploy steps before decomposition.",
  });
  assert.equal(spanSink.subagentTurns[1].agent_turn_id, "2.1");
  assert.equal(spanSink.subagentTurns[1].parent_turn_id, 2);
  assert.deepEqual(spanSink.subagentTurns[1].control_action, {
    action: "invoke_one_off",
    runtime_role: "pm",
    role_label: "risk_scanner",
    task: "Scan the project for risky deploy steps before decomposition.",
  });
  assert.deepEqual(spanSink.subagentTurns[1].spawn_reason, {
    action: "invoke_one_off",
    runtime_role: "pm",
    role_label: "risk_scanner",
    task: "Scan the project for risky deploy steps before decomposition.",
  });

  // The enrichment does NOT break the single commit floor.
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: a SECRET-BEARING one-off body falls back to ref+digest (raw secret body is never persisted)", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_one_off_secret";

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: oneOffThenCommit(runId, SECRET_BEARING_ONE_OFF_PROMPT),
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");

  const oneOffEntry = result.output.evidence.perspectives_run[1];
  assert.ok(oneOffEntry.one_off, "one-off entry should carry a one_off reference");
  // Label/task/runtime_role still present (they carry no secret material).
  assert.equal(oneOffEntry.one_off.role_label, "risk_scanner");
  assert.equal(oneOffEntry.one_off.task, "Scan the project for risky deploy steps before decomposition.");
  assert.equal(oneOffEntry.one_off.runtime_role, "pm");
  // The raw body is NOT persisted — only a redaction marker + a verifiable digest.
  assert.equal(oneOffEntry.one_off.prompt_body, undefined);
  assert.equal(oneOffEntry.one_off.prompt_body_redacted, true);
  assert.ok(typeof oneOffEntry.one_off.prompt_body_redaction_reason === "string");
  assert.match(oneOffEntry.one_off.prompt_body_digest, /^sha256:[0-9a-f]{64}$/);

  // The digest lets a human who HOLDS the body verify the match (recompute it).
  const expectedDigest =
    "sha256:" + createHash("sha256").update(SECRET_BEARING_ONE_OFF_PROMPT, "utf8").digest("hex");
  assert.equal(oneOffEntry.one_off.prompt_body_digest, expectedDigest);

  // The secret string appears NOWHERE in the serialized evidence (defense in depth).
  assert.equal(JSON.stringify(result.output.evidence).includes("ghp_"), false);

  // The enrichment does NOT break the single commit floor.
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator loop: a SECRET in a one-off's task or role_label is redacted (not only the prompt body)", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_one_off_field_secret";
  // Token material can ride in task/role_label, not just the prompt body — a
  // github_pat in task, an assignment-form token in role_label. The harness must
  // sanitize EVERY authored free-text field (validatePerspectivesRun gates none
  // of them).
  // The token literals are SPLIT in source so they form a secret only at runtime
  // (the pre-push secret scan scans the tracked source text for contiguous
  // tokens); findSecretContentKeys sees the assembled string and flags it.
  const secretTask = `Use ${"github_pat_"}${"11AAABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"} to read CI logs.`;
  const secretRoleLabel = `scanner ${"LINEAR_ACCESS_TOKEN"}=${"linear-secret-value"}`;
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: {
          action: "invoke_one_off",
          role_label: secretRoleLabel,
          task: secretTask,
          prompt: "Scan the project for deploy risks.",
          runtime_role: "pm",
        },
        evidence: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor,
    roster: fakeRoster(),
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  const oneOff = result.output.evidence.perspectives_run[0].one_off;
  assert.ok(oneOff, "one-off entry should carry a one_off reference");
  // task carried a github_pat -> redacted to a digest; raw task absent.
  assert.equal(oneOff.task, undefined);
  assert.equal(oneOff.task_redacted, true);
  assert.match(oneOff.task_digest, /^sha256:[0-9a-f]{64}$/);
  // role_label carried an assignment-form token -> redacted; raw role_label absent.
  assert.equal(oneOff.role_label, undefined);
  assert.equal(oneOff.role_label_redacted, true);
  assert.match(oneOff.role_label_digest, /^sha256:[0-9a-f]{64}$/);
  // The clean body stays verbatim.
  assert.equal(oneOff.prompt_body, "Scan the project for deploy risks.");
  // Neither secret appears ANYWHERE in the serialized evidence.
  const serialized = JSON.stringify(result.output.evidence);
  assert.equal(serialized.includes("github_pat_"), false);
  assert.equal(serialized.includes("linear-secret-value"), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});
