import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  defaultOrchestratorRuntime,
  executeOrchestratorTurn,
} from "../src/orchestrator-turn.mjs";
import { REPAIR_RETRY_TIMEOUT_MS } from "../src/runtime-command.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";
import { terminalArtifact } from "../src/workflows/decomposition/artifacts.mjs";
import {
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
          entry: { target_key: targetKey },
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
      return {
        ok: true,
        packet,
        output: JSON.stringify(packet),
        role: runtime_role,
        runtime: "codex",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: JSON.stringify(packet),
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
} = {}) {
  const packet = subagentTurn(runId, { status, reason });
  return {
    ok: true,
    packet,
    output: JSON.stringify(packet),
    role,
    runtime: "codex",
    parse_status: "valid",
    clean_parse: true,
    raw_output_excerpt: JSON.stringify(packet),
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
test("orchestrator loop: non-default library order then terminate(commit) yields a validated commit", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_commit";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();

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
  // The run consumed the governing prompt + both library refs (the #50 re-key).
  const refTargets = result.acceptedRefs.map((r) => r.target_key);
  assert.ok(refTargets.includes("prompt/decomposition/orchestrator_governing"));
  assert.ok(refTargets.includes("prompt/decomposition/sr_eng_grounding_pass"));
  assert.ok(refTargets.includes("prompt/decomposition/pm_product_sufficiency_pass"));
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
  assert.deepEqual(spans, [
    {
      role: "pm",
      outcome: "product_context_sufficient",
      parse_status: "valid",
      clean_parse: true,
      evidence_ref: evidenceRef,
    },
  ]);
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

test("orchestrator loop: spanSink records orchestrator turns and the single subagent span on the commit path", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_loop_orchestrator_span_sink";
  const evidenceRef = "trace://subagent/pm/commit-path";
  const runtimeExecutor = scriptedSubagentExecutor([
    validSpawn(runId, { role: "pm", evidenceRef }),
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

  assert.equal(terminateSpan.round_index, 2);
  assert.equal(terminateSpan.action, "terminate");
  assert.equal(terminateSpan.outcome, "commit");
  assert.equal(terminateSpan.reason, "synthesis_complete");
  assert.equal(terminateSpan.bounds.rounds_used, 2);
  assert.equal(terminateSpan.bounds.invocations, 1);

  assert.deepEqual(spanSink.subagentTurns, [
    {
      role: "pm",
      outcome: "product_context_sufficient",
      parse_status: "valid",
      clean_parse: true,
      evidence_ref: evidenceRef,
    },
  ]);
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
    content: "## Goal\n\nDo it.\n\n## Open Questions\n",
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
      return { controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] }, evidence: null };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
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
      "agentic-factory-eval-runs-test-readonly",
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
  const assignment = resolveRoleRuntimeAssignments(config).orchestrator;

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
  const secondPrompt = commandsSeen[1].args.find((arg) =>
    typeof arg === "string" && arg.includes("Decisions so far this run:")
  );
  assert.ok(secondPrompt, "second orchestrator turn should include the prompt");
  assert.match(secondPrompt, /"status": "continue"/);
  assert.match(secondPrompt, /"reason": "product_context_sufficient"/);
  assert.match(secondPrompt, /"context_digest": "product_context_sufficient digest"/);
  assert.match(secondPrompt, /"runtime_role": "pm"/);
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
  const runtimeAssignments = resolveRoleRuntimeAssignments(config);

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

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project" },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor: oneOffThenCommit(runId, cleanPrompt),
    roster: fakeRoster(),
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
