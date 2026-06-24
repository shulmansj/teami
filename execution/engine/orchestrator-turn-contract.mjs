// Subagent turn contract (Seam 2 of the agent-driven-orchestrator breakdown).
//
// This is the ROLE-AGNOSTIC turn protocol for a subagent the orchestrator
// invokes. It REPLACES the per-step, position-coupled allowed-outcome rules
// (the old router keyed allowed outcomes by an ordered step + an expected
// position) with a SINGLE role-agnostic allowed (status, reason) set: a
// subagent turn is judged by WHAT it reports, not by WHERE in a sequence it sat.
//
// This module is ADDITIVE. The live router's own contract module is untouched
// in I-2a; I-2b migrates the live validators onto this module and retires the
// position-coupled parts.
//
// RET-CHECK: the allowed set is defined as LITERAL values here. It is
// DELIBERATELY not imported from the router's outcome table -- importing that
// token into a new module would reintroduce retired router vocabulary into the
// retirement surface. The union below is hand-maintained and asserted by the
// unit test.

export const SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION =
  "linear-decomposition-orchestrator-subagent-turn/v2";

// The role-agnostic union of valid subagent outcomes. A subagent reports a
// `status` and a `reason`; this map is `status -> [allowed reasons]`.
//
//   continue -> the subagent reports a finding that advances the run.
//   blocked  -> the subagent reports a need that must be handled before safe
//               decomposition can continue.
//
// The reasons are the UNION of the outcomes the library personas legitimately
// report (product sufficiency, technical grounding, synthesis, blocker check),
// flattened across role and position.
export const SUBAGENT_TURN_OUTCOMES = Object.freeze({
  continue: Object.freeze([
    "product_context_sufficient",
    "technical_context_grounded",
    "synthesis_complete",
    "no_blockers",
  ]),
  blocked: Object.freeze([
    "needs_product_input",
    "needs_discovery",
    "needs_constraint_decision",
  ]),
});

export const SUBAGENT_TURN_STATUSES = Object.freeze(Object.keys(SUBAGENT_TURN_OUTCOMES));

const COMMON_ARRAY_FIELDS = Object.freeze(["source_refs", "assumptions", "constraints", "risks"]);
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Is (status, reason) an allowed role-agnostic subagent turn tuple?
export function isAllowedSubagentOutcome({ status, reason } = {}) {
  return Boolean(SUBAGENT_TURN_OUTCOMES[status]?.includes(reason));
}

// Validate a subagent's returned turn packet WITHOUT a position. The
// role-agnostic analog of the router's position-coupled packet validator: it
// checks identity (run_id, schema version), the common envelope fields, and
// that (status, reason) is an allowed role-agnostic tuple -- but it asserts NO
// expected step and NO ordered position.
//
// Returns { ok, failureReasons }.
export function validateSubagentTurnContract(packet, { runId } = {}) {
  const failureReasons = [];
  if (!isRecord(packet)) {
    return { ok: false, failureReasons: ["missing_subagent_turn"] };
  }

  if (packet.schema_version !== SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION) {
    failureReasons.push("invalid_subagent_turn_schema_version");
  }

  if (!packet.run_id) {
    failureReasons.push("missing_run_id");
  } else if (!SAFE_RUN_ID_PATTERN.test(packet.run_id)) {
    failureReasons.push("invalid_run_id");
  } else if (runId && packet.run_id !== runId) {
    failureReasons.push("run_id_mismatch");
  }

  if (typeof packet.context_digest !== "string" || packet.context_digest.trim() === "") {
    failureReasons.push("missing_context_digest");
  }

  for (const field of COMMON_ARRAY_FIELDS) {
    if (!Array.isArray(packet[field])) failureReasons.push(`missing_${field}`);
  }

  if (typeof packet.status !== "string" || packet.status.trim() === "") {
    failureReasons.push("missing_status");
  }
  if (typeof packet.reason !== "string" || packet.reason.trim() === "") {
    failureReasons.push("missing_reason");
  }
  if (
    typeof packet.status === "string"
    && typeof packet.reason === "string"
    && !isAllowedSubagentOutcome({ status: packet.status, reason: packet.reason })
  ) {
    failureReasons.push(`invalid_status_reason:${packet.status}:${packet.reason}`);
  }

  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}
