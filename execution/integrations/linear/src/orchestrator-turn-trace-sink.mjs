// Bridges the engine's per-turn span push-stream (Seam 8 — the loop calls
// spanSink.recordOrchestratorTurn / recordSubagentTurn each turn) into the run's
// exported Phoenix trace, so operators see turn-level spans by DEFAULT (not only
// when a test injects a capturing sink). The engine emits already-scrubbed
// attribute bags; this maps each to a trace span (matching trace.mjs#recordSpan)
// and drains them into result.trace before traceSink.finishRun exports it.
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
