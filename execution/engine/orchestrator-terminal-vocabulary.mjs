export const GENERIC_CORE_OUTCOME_REASONS = Object.freeze({
  commit: Object.freeze(["synthesis_complete"]),
  pause: Object.freeze(["product_questions", "discovery_needed", "needs_pm_review"]),
  failed_closed: Object.freeze([
    "bounds_breach",
    "environment_breach",
    "warm_continuation_unavailable",
    "subagent_turn_validation_failed",
    "orchestrator_turn_validation_failed",
  ]),
});

export const GENERIC_CORE_OUTCOMES = Object.freeze(Object.keys(GENERIC_CORE_OUTCOME_REASONS));

export const HARNESS_ONLY_TERMINAL_OUTCOMES = Object.freeze(["failed_closed"]);

export function deriveAgentChoosableOutcomeReasons(
  outcomeReasons = GENERIC_CORE_OUTCOME_REASONS,
) {
  const harnessOnly = new Set(HARNESS_ONLY_TERMINAL_OUTCOMES);
  return Object.freeze(Object.fromEntries(
    Object.entries(outcomeReasons)
      .filter(([outcome]) => !harnessOnly.has(outcome))
      .map(([outcome, reasons]) => [outcome, Object.freeze([...reasons])]),
  ));
}

export const AGENT_CHOOSABLE_OUTCOME_REASONS = deriveAgentChoosableOutcomeReasons();
