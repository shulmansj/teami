import { createHash } from "node:crypto";

import { LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS } from "../../../engine/trace-contract.mjs";

// Bridges the engine's per-turn span push-stream (Seam 8 — the loop calls
// spanSink.recordOrchestratorTurn / recordSubagentTurn each turn) into the run's
// exported Phoenix trace, so operators see turn-level spans by DEFAULT (not only
// when a test injects a capturing sink). The engine emits already-scrubbed
// attribute bags using this LOCAL sink's full-content policy; this maps each to
// a trace span (matching trace.mjs#recordSpan) and drains them into result.trace
// before traceSink.finishRun exports it.
//
// Best-effort and side-effect-free on the run: every method swallows its own
// errors, so observability can never change the run outcome. Accumulate-then-drain
// because result.trace does not exist yet while the loop is still emitting turns.
export function createOrchestratorTurnTraceSink({ now = () => new Date() } = {}) {
  const spans = [];

  function record(name, span) {
    try {
      if (!isRecord(span)) return;
      const at = now().toISOString();
      spans.push({ name, attributes: { ...span }, startedAt: at, endedAt: at });
    } catch {
      // never throw into the engine loop
    }
  }

  return {
    traceContentPolicy: LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
    recordOrchestratorTurn(span) {
      record(orchestratorTurnSpanName(span), span);
    },
    recordSubagentTurn(span) {
      record(subagentTurnSpanName(span), span);
    },
    // Read-only view of what has been collected (used by tests).
    get spans() {
      return spans;
    },
    // Append the collected turn spans onto a run trace, then clear. Safe to call
    // with a missing trace (a failed/early run has none) — it simply no-ops.
    drainInto(trace) {
      try {
        if (!trace || spans.length === 0) return;
        if (!Array.isArray(trace.spans)) trace.spans = [];
        trace.spans.push(...spans.splice(0));
      } catch {
        // a drain failure must not fail the run
      }
    },
  };
}

// Incremental delivery on top of the buffering sink: each recorded turn
// schedules a best-effort checkpoint flush of the buffer to the run's trace
// session, so a run that dies mid-flight has already delivered its turn spans
// (the terminal drain used to be the ONLY delivery, which made a crashed run
// invisible in Phoenix). Flushing does NOT drain the buffer — the exporter
// dedupes by span id — so the terminal drainInto/receipt path is unchanged.
// Each span is stamped with a deterministic spanId at record time; the
// exporter's fallback id is positional within one trace object, which would
// break dedupe when the same span later rides result.trace at a different index.
export function createCheckpointFlushingTurnSpanSink({
  traceSink,
  session,
  traceName,
  traceAttributes = {},
  now = () => new Date(),
} = {}) {
  const inner = createOrchestratorTurnTraceSink({ now });
  const traceId = typeof session?.traceId === "string" ? session.traceId : null;
  if (typeof traceSink?.forceFlush !== "function" || !traceId) return inner;
  const liveTrace = {
    name: traceName,
    attributes: { ...traceAttributes },
    get spans() {
      return inner.spans;
    },
  };
  let sequence = 0;
  let chain = Promise.resolve();
  const stampAndFlush = () => {
    try {
      const span = inner.spans.at(-1);
      if (isRecord(span) && !span.spanId) {
        sequence += 1;
        span.spanId = turnSpanId(`${traceId}:turn-span:${sequence}:${span.name}`);
      }
    } catch {
      // stamping is best-effort; an unstamped span still exports positionally
    }
    chain = chain
      .then(() => traceSink.forceFlush({ session, trace: liveTrace, stage: "checkpoint" }))
      .then(
        () => {},
        () => {}, // observability must never change the run outcome
      );
  };
  return {
    traceContentPolicy: inner.traceContentPolicy,
    recordOrchestratorTurn(span) {
      inner.recordOrchestratorTurn(span);
      stampAndFlush();
    },
    recordSubagentTurn(span) {
      inner.recordSubagentTurn(span);
      stampAndFlush();
    },
    get spans() {
      return inner.spans;
    },
    drainInto(trace) {
      inner.drainInto(trace);
    },
    // Await in-flight checkpoint flushes so the terminal final flush never races
    // one (a span mid-flight at final time would double-send). Never rejects.
    settle() {
      return chain;
    },
  };
}

function turnSpanId(input) {
  const hex = createHash("sha256").update(String(input)).digest("hex").slice(0, 16);
  return /^0{16}$/.test(hex) ? "0000000000000001" : hex;
}

function orchestratorTurnSpanName(span) {
  const round = isRecord(span) && span.round_index != null ? span.round_index : "n";
  return `orchestrator_turn.${round}`;
}

function subagentTurnSpanName(span) {
  const role = isRecord(span) && typeof span.role === "string" && span.role.trim() !== "" ? span.role : "unknown";
  return `subagent_turn.${role}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
