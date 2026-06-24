import assert from "node:assert/strict";
import test from "node:test";

import { createOrchestratorTurnTraceSink } from "../src/orchestrator-turn-trace-sink.mjs";

const fixedNow = () => new Date("2026-06-22T00:00:00.000Z");

test("collects orchestrator and subagent turns as named trace spans", () => {
  const sink = createOrchestratorTurnTraceSink({ now: fixedNow });
  sink.recordOrchestratorTurn({ round_index: 0, action: "invoke_library", outcome: "continue", target_key: "k" });
  sink.recordSubagentTurn({ role: "pm", outcome: "ok", parse_status: "valid", clean_parse: true });
  sink.recordOrchestratorTurn({ round_index: 1, action: "terminate", outcome: "commit" });

  assert.deepEqual(
    sink.spans.map((span) => span.name),
    ["orchestrator_turn.0", "subagent_turn.pm", "orchestrator_turn.1"],
  );
  // attributes are copied verbatim (the engine already scrubbed them)
  assert.deepEqual(sink.spans[0].attributes, {
    round_index: 0,
    action: "invoke_library",
    outcome: "continue",
    target_key: "k",
  });
  assert.equal(sink.spans[1].attributes.role, "pm");
  assert.equal(sink.spans[0].startedAt, "2026-06-22T00:00:00.000Z");
});

test("drainInto appends collected spans onto a trace, then clears the collector", () => {
  const sink = createOrchestratorTurnTraceSink({ now: fixedNow });
  sink.recordOrchestratorTurn({ round_index: 0, action: "terminate", outcome: "commit" });
  const trace = { spans: [{ name: "existing" }] };

  sink.drainInto(trace);
  assert.deepEqual(trace.spans.map((span) => span.name), ["existing", "orchestrator_turn.0"]);
  assert.equal(sink.spans.length, 0, "draining clears the collector so a second drain is a no-op");

  sink.drainInto(trace);
  assert.equal(trace.spans.length, 2, "second drain adds nothing");
});

test("is best-effort: tolerates a missing trace, missing spans array, and non-record turns", () => {
  const sink = createOrchestratorTurnTraceSink({ now: fixedNow });
  assert.doesNotThrow(() => sink.drainInto(null));
  assert.doesNotThrow(() => sink.drainInto(undefined));

  sink.recordOrchestratorTurn(null);
  sink.recordSubagentTurn("nope");
  sink.recordOrchestratorTurn(42);
  assert.equal(sink.spans.length, 0, "non-record turns are ignored");

  // unnamed turns still get a stable fallback name
  sink.recordOrchestratorTurn({ action: "terminate", outcome: "commit" });
  sink.recordSubagentTurn({ outcome: "ok" });
  assert.deepEqual(sink.spans.map((s) => s.name), ["orchestrator_turn.n", "subagent_turn.unknown"]);

  const trace = {};
  sink.drainInto(trace);
  assert.equal(trace.spans.length, 2, "drainInto creates the spans array when absent");
});
