export const PROPOSAL_PACKET_SCHEMA_VERSION = "agentic-factory-proposal-packet/v1";

export const PROPOSAL_PACKET_MARKER_SOURCES = Object.freeze([
  "not_rendered",
  "structured_packet",
]);

export const PROPOSAL_PACKET_GUARD_STATUSES = Object.freeze([
  "not_evaluated",
  "passed",
  "blocked",
]);

export const PROPOSAL_PACKET_COPY_CLASSES = Object.freeze([
  // Renderer hint only. WL-02 derives the final copy class from the full
  // read-model merge order.
  "decision_ready",
  "review_carefully",
  "blocked_for_repair",
  "fyi_receipt",
  "internal_only",
]);

export const PROPOSAL_PACKET_RISK_FLOORS = Object.freeze([
  "low_risk",
  "high_risk",
  "unknown",
]);

const MARKER_PACKET_BOOLEAN_FIELDS = Object.freeze([
  "risk_reason_present",
  "evidence_cohort_summary_present",
  "before_after_examples_present",
  "undo_bounds_present",
  "authority_custody_access_present",
]);

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function defaultPromotionMarkerPacketFacts(overrides = {}) {
  return normalizePromotionMarkerPacketFacts({
    schema_version: PROPOSAL_PACKET_SCHEMA_VERSION,
    source: "not_rendered",
    guard_status: "not_evaluated",
    copy_class: "internal_only",
    deterministic_risk_floor: "unknown",
    risk_reason_present: false,
    evidence_cohort_summary_present: false,
    before_after_examples_present: false,
    undo_bounds_present: false,
    authority_custody_access_present: false,
    ...overrides,
  });
}

export function normalizePromotionMarkerPacketFacts(facts = {}) {
  const normalized = {
    schema_version: PROPOSAL_PACKET_SCHEMA_VERSION,
    source: oneOf(facts.source, PROPOSAL_PACKET_MARKER_SOURCES, "not_rendered"),
    guard_status: oneOf(facts.guard_status, PROPOSAL_PACKET_GUARD_STATUSES, "not_evaluated"),
    copy_class: oneOf(facts.copy_class, PROPOSAL_PACKET_COPY_CLASSES, "internal_only"),
    deterministic_risk_floor: oneOf(
      facts.deterministic_risk_floor,
      PROPOSAL_PACKET_RISK_FLOORS,
      "unknown",
    ),
  };
  for (const field of MARKER_PACKET_BOOLEAN_FIELDS) {
    normalized[field] = Boolean(facts[field]);
  }
  return normalized;
}

export function validPromotionMarkerPacketFactsShape(facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return false;
  if (facts.schema_version !== PROPOSAL_PACKET_SCHEMA_VERSION) return false;
  if (!PROPOSAL_PACKET_MARKER_SOURCES.includes(facts.source)) return false;
  if (!PROPOSAL_PACKET_GUARD_STATUSES.includes(facts.guard_status)) return false;
  if (!PROPOSAL_PACKET_COPY_CLASSES.includes(facts.copy_class)) return false;
  if (!PROPOSAL_PACKET_RISK_FLOORS.includes(facts.deterministic_risk_floor)) return false;
  for (const field of MARKER_PACKET_BOOLEAN_FIELDS) {
    if (typeof facts[field] !== "boolean") return false;
  }
  return true;
}
