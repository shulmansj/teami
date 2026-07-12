import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "../../../engine/orchestrator-turn-contract.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { createLocalPhoenixTraceExporter } from "../src/local-phoenix-trace-sink.mjs";
import { createCheckpointFlushingTurnSpanSink } from "../src/orchestrator-turn-trace-sink.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";

// Turn spans flush to the trace session AS THEY HAPPEN (best-effort checkpoint
// per recorded turn), so a run that dies mid-flight has already delivered its
// activity to Phoenix. The buffer is not drained by flushing and every span
// carries a deterministic spanId, so the terminal drain + final flush neither
// lose spans nor double-send them.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SESSION = { traceId: "11112222333344445555666677778888" };

function captureTraceSink() {
  const flushes = [];
  return {
    flushes,
    async forceFlush({ session, trace, stage }) {
      flushes.push({
        session,
        stage,
        spanNames: trace.spans.map((span) => span.name),
        spanIds: trace.spans.map((span) => span.spanId),
      });
      return { ok: true };
    },
  };
}

test("each recorded turn schedules a checkpoint flush without draining the buffer", async () => {
  const traceSink = captureTraceSink();
  const sink = createCheckpointFlushingTurnSpanSink({
    traceSink,
    session: SESSION,
    traceName: "execution_run",
    traceAttributes: { run_id: "run-1" },
  });

  sink.recordOrchestratorTurn({ round_index: 1, action: "invoke_one_off", outcome: "continue" });
  sink.recordSubagentTurn({ role: "worker", outcome: "continue:no_blockers" });
  await sink.settle();

  assert.equal(traceSink.flushes.length, 2);
  assert.ok(traceSink.flushes.every((flush) => flush.stage === "checkpoint"));
  assert.deepEqual(traceSink.flushes.at(-1).spanNames, ["orchestrator_turn.1", "subagent_turn.worker"]);
  for (const spanId of traceSink.flushes.at(-1).spanIds) {
    assert.match(spanId, /^[0-9a-f]{16}$/);
  }

  // Buffer intact: the terminal drain still delivers every span, ids unchanged.
  assert.equal(sink.spans.length, 2);
  const finalTrace = { name: "execution_run", spans: [{ name: "earlier_runner_span" }] };
  sink.drainInto(finalTrace);
  assert.equal(sink.spans.length, 0);
  assert.deepEqual(
    finalTrace.spans.map((span) => span.name),
    ["earlier_runner_span", "orchestrator_turn.1", "subagent_turn.worker"],
  );
  assert.deepEqual(
    finalTrace.spans.slice(1).map((span) => span.spanId),
    traceSink.flushes.at(-1).spanIds,
  );
});

test("a flush failure is swallowed and later turns still flush", async () => {
  const flushes = [];
  let calls = 0;
  const traceSink = {
    async forceFlush({ trace }) {
      calls += 1;
      if (calls === 1) throw new Error("phoenix down");
      flushes.push(trace.spans.map((span) => span.name));
      return { ok: true };
    },
  };
  const sink = createCheckpointFlushingTurnSpanSink({
    traceSink,
    session: SESSION,
    traceName: "execution_run",
  });

  sink.recordOrchestratorTurn({ round_index: 1, action: "invoke_one_off" });
  sink.recordOrchestratorTurn({ round_index: 2, action: "terminate", outcome: "pause" });
  await sink.settle();

  assert.equal(calls, 2);
  assert.deepEqual(flushes, [["orchestrator_turn.1", "orchestrator_turn.2"]]);
});

test("without a trace session the sink falls back to plain buffering", () => {
  const noSession = createCheckpointFlushingTurnSpanSink({
    traceSink: captureTraceSink(),
    session: { traceId: null },
  });
  noSession.recordOrchestratorTurn({ round_index: 1, action: "terminate" });
  assert.equal(noSession.spans.length, 1);
  assert.equal(noSession.settle, undefined);

  const noSink = createCheckpointFlushingTurnSpanSink({ session: SESSION });
  noSink.recordOrchestratorTurn({ round_index: 1, action: "terminate" });
  assert.equal(noSink.spans.length, 1);
});

test("the real exporter dedupes checkpoint-flushed spans at the final flush by their stamped ids", async () => {
  const posts = [];
  const fetchImpl = async (url, options) => {
    posts.push(JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans.map((span) => span.name));
    return { ok: true, status: 200 };
  };
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami-test",
    traceId: SESSION.traceId,
    fetchImpl,
  });
  const traceSink = {
    async forceFlush({ trace, stage }) {
      return exporter.forceFlush({ trace, run: { run_id: "run-1", status: "running" }, stage });
    },
  };
  const sink = createCheckpointFlushingTurnSpanSink({
    traceSink,
    session: SESSION,
    traceName: "execution_run",
    traceAttributes: { run_id: "run-1" },
  });

  sink.recordOrchestratorTurn({ round_index: 1, action: "invoke_one_off" });
  sink.recordSubagentTurn({ role: "worker", outcome: "continue:no_blockers" });
  await sink.settle();

  // Terminal path: turn spans land in a DIFFERENT trace object at different
  // indexes; the stamped ids keep the exporter from re-sending them.
  const finalTrace = {
    name: "execution_run",
    attributes: { run_id: "run-1" },
    spans: [{ name: "persist_run_artifact" }],
  };
  sink.drainInto(finalTrace);
  await exporter.forceFlush({ trace: finalTrace, run: { run_id: "run-1", status: "completed" }, stage: "final" });

  const finalPost = posts.at(-1);
  assert.ok(finalPost.includes("persist_run_artifact"));
  assert.ok(!finalPost.includes("orchestrator_turn.1"), "checkpoint-flushed span must not be re-sent");
  assert.ok(!finalPost.includes("subagent_turn.worker"), "checkpoint-flushed span must not be re-sent");
});

test("a run that dies mid-flight has already delivered its turn spans", async () => {
  const traceSink = captureTraceSink();
  const spanSink = createCheckpointFlushingTurnSpanSink({
    traceSink,
    session: SESSION,
    traceName: "execution_run",
    traceAttributes: { run_id: "run-dies" },
  });
  let turn = 0;

  const result = await runOrchestratorLoop({
    runId: "run-dies",
    wake: { id: "wake-1", object_id: "issue-1", workflow_type: "execution" },
    event: { id: "event-1" },
    project: { id: "issue-1", title: "Fix the bug" },
    config: loadLinearConfig({ repoRoot: REPO_ROOT }),
    runtimeExecutor: {
      async executeSubagent({ runId, runtime_role }) {
        const packet = {
          schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
          run_id: runId,
          status: "continue",
          reason: "no_blockers",
          context_digest: "worker inspected the issue",
          source_refs: [{ kind: "linear_issue", id: "issue-1" }],
          assumptions: [],
          constraints: [],
          risks: [],
        };
        const output = JSON.stringify(packet);
        return {
          ok: true,
          packet,
          output,
          role: runtime_role,
          runtime: "codex",
          parse_status: "valid",
          clean_parse: true,
          prompt: "worker prompt",
          raw_output: output,
          raw_output_excerpt: output,
          envelope: "worker prompt",
          sessionHandle: null,
          evidence: {
            evidence_unavailable: [
              { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
            ],
          },
        };
      },
    },
    orchestratorTurnExecutor: async () => {
      turn += 1;
      if (turn === 1) {
        return {
          controlAction: {
            action: "invoke_one_off",
            role_label: "Worker",
            task: "Inspect the issue",
            prompt: "Inspect the issue.",
            runtime_role: "worker",
          },
        };
      }
      throw new Error("orchestrator runtime crashed");
    },
    roster: { selectableTargets: [], resolve: () => ({ ok: false, reason: "not_selectable" }) },
    definition: executionDefinition,
    commitPayload: null,
    repoRoot: REPO_ROOT,
    spanSink,
  });
  await spanSink.settle();

  // The run closed without ever reaching a terminal drain/finish for these
  // spans — yet the trace session already received them.
  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  const delivered = traceSink.flushes.at(-1).spanNames;
  assert.ok(delivered.includes("orchestrator_turn.1"));
  assert.ok(delivered.includes("subagent_turn.worker"));
});
