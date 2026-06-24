// ---------------------------------------------------------------------------
// Report rendering (transient stdout).
// ---------------------------------------------------------------------------

export function formatPromotionOutcomeReport(result) {
  const lines = [];
  if (result.outcome === "rejected") {
    lines.push(`promote-candidate REJECTED: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    lines.push("  the request never reached evidence resolution; fix the envelope and re-invoke.");
    return lines;
  }
  if (result.outcome === "blocked") {
    if (result.reason === "improvement_opportunity_no_proposed_change") {
      const opportunity = result.improvement_opportunity || {};
      const humanName = opportunity.human_name || result.candidate_target_key || "Unknown target";
      const failureLabels = Array.isArray(opportunity.failure_mode_labels)
        ? opportunity.failure_mode_labels.filter((label) => typeof label === "string" && label.trim() !== "")
        : [];
      lines.push(`Improvement opportunity found: ${humanName}`);
      lines.push(
        `Evidence suggests ${humanName} could improve${failureLabels.length > 0 ? ` on ${failureLabels.join(", ")}` : ""}, but Agentic Factory has not drafted a concrete prompt/policy change yet.`,
      );
      lines.push("No GitHub PR was opened.");
      lines.push("Next step: draft the proposed agent/prompt/policy change, then rerun promotion.");
      return lines;
    }
    if (result.evidence_repair) {
      lines.push("Evidence needs repair before the system can decide what to do.");
      lines.push(`  reason: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
      return lines;
    }
    lines.push(`promote-candidate BLOCKED: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    if (result.terminal === false) {
      lines.push("  this block is retryable: recovery resumes from the last durable stage for the same envelope.");
    }
    if (result.normalized_envelope_hash) lines.push(`  envelope: ${result.normalized_envelope_hash}`);
    if (result.registry_path) lines.push(`  registry: ${result.registry_path}`);
    if (result.phoenix_outcome) {
      lines.push(`  phoenix outcome: ${result.phoenix_outcome.recorded ? `recorded (${result.phoenix_outcome.trace_id})` : `NOT recorded (${result.phoenix_outcome.repair_state})`}`);
    }
    return lines;
  }
  const prTitle = result.pr?.title || result.pr_title || result.candidate_target_key;
  lines.push(`Proposal ready for review: ${prTitle}`);
  if (result.pr?.url) lines.push(result.pr.url);
  return lines;
}
