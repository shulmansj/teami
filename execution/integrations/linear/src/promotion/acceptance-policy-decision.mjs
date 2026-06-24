export const PROMOTION_ACCEPTANCE_POLICY_DECISION_SCHEMA_VERSION =
  "agentic-factory-promotion-acceptance-policy-decision/v1";

export const PROMOTION_ACCEPTANCE_DECISIONS = Object.freeze([
  "route_to_hitl",
  "blocked",
]);

export function resolvePromotionAcceptancePolicyDecision({
  scope = null,
  packetGuard = null,
  policy = null,
} = {}) {
  if (scope && scope.ok !== true) {
    return decision({
      decision: "blocked",
      reason: "scope_gate_not_passed",
      detail: scope.reason || null,
      policy,
    });
  }
  if (packetGuard && packetGuard.ok !== true) {
    return decision({
      decision: "blocked",
      reason: "packet_guard_not_passed",
      detail: packetGuard.reason || null,
      policy,
    });
  }
  return decision({
    decision: "route_to_hitl",
    reason: "auto_acceptance_policy_not_configured",
    detail:
      "No owner-configured auto-acceptance policy exists in MVP, so valid in-scope behavior proposals route to human PR review.",
    policy,
  });
}

function decision({
  decision: value,
  reason,
  detail = null,
  policy = null,
} = {}) {
  return {
    schema_version: PROMOTION_ACCEPTANCE_POLICY_DECISION_SCHEMA_VERSION,
    decision: value,
    reason,
    detail,
    auto_acceptance_configured: false,
    policy_version: policy?.policy_version ?? null,
  };
}
