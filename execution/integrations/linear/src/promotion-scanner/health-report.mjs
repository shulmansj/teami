import fs from "node:fs";

import {
  candidateSortKey,
  PROMOTION_SCANNER_CACHE_NOTE,
  PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
  PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
  promotionScannerHealthPath,
  promotionScannerLedgerPath,
  readPromotionScannerLedger,
  safeRelativePolicySource,
  setCandidateStatus,
  statusCounts,
  withDerivedLedgerRowFields,
  writeJsonAtomic,
} from "./ledger-store.mjs";

export function suppressReadyCandidates({ candidates, reason, detail }) {
  for (const candidate of candidates) {
    if (candidate.status !== "candidate_intent_ready") continue;
    setCandidateStatus(candidate, "suppressed_by_policy", reason, detail ?? null);
  }
}

export function ledgerEntry(candidate) {
  const entry = {
    candidate_key: candidate.candidate_key,
    source: candidate.source,
    status: candidate.status,
    reason: candidate.reason ?? null,
    detail: candidate.detail ?? null,
    receipt_id: candidate.receipt_id ?? null,
    experiment_id: candidate.experiment_id ?? null,
    candidate_target_key: candidate.candidate_target_key ?? null,
    candidate_version_id: candidate.candidate_version_id ?? null,
    prompt_version_id: candidate.prompt_version_id ?? null,
    dataset_version_id: candidate.dataset_version_id ?? null,
    request_hash: candidate.request_hash ?? null,
    controller_called: Boolean(candidate.controller_result),
    controller_outcome: candidate.controller_result?.outcome ?? null,
    controller_reason: candidate.controller_result?.reason ?? null,
    controller_detail: candidate.controller_result?.detail ?? null,
    controller_terminal: candidate.controller_result?.terminal ?? null,
    evidence_repair: Boolean(candidate.controller_result?.evidence_repair),
    proposal_instance_id: candidate.controller_result?.proposal_instance_id ?? null,
    pr_title: candidate.controller_result?.pr_title ?? candidate.controller_result?.pr?.title ?? null,
    pr: candidate.controller_result?.pr
      ? {
          number: candidate.controller_result.pr.number ?? null,
          url: candidate.controller_result.pr.url ?? null,
          title: candidate.controller_result.pr.title ?? candidate.controller_result.pr_title ?? null,
          dry_run: Boolean(candidate.controller_result.pr.dry_run),
      }
      : null,
    write_guard: candidate.write_guard ?? null,
    evidence: candidate.evidence ?? {},
  };
  if (candidate.controller_result?.improvement_opportunity) {
    entry.improvement_opportunity = candidate.controller_result.improvement_opportunity;
  }
  return withDerivedLedgerRowFields(entry);
}

export function writeLedgerAndHealth({
  ledgerDir,
  scanId,
  startedAt,
  finishedAt,
  candidates,
  status,
  policyRead,
  phoenixScan,
  repoMarkerState,
}) {
  if (fs.existsSync(promotionScannerLedgerPath(ledgerDir))) {
    readPromotionScannerLedger({ ledgerDir });
  }
  const sortedEntries = candidates.map(ledgerEntry).sort((a, b) =>
    candidateSortKey(a).localeCompare(candidateSortKey(b)));
  const summary = {
    candidate_count: sortedEntries.length,
    status_counts: statusCounts(sortedEntries),
    controller_call_count: sortedEntries.filter((entry) => entry.controller_called).length,
    needs_reconciliation_count: sortedEntries.filter((entry) => entry.status === "needs_reconciliation").length,
    improvement_opportunity_count: sortedEntries.filter((entry) => entry.status === "improvement_opportunity").length,
    evidence_needs_repair_count: sortedEntries.filter((entry) => entry.display_class === "evidence_needs_repair").length,
  };
  const ledger = {
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
    _note: PROMOTION_SCANNER_CACHE_NOTE,
    updated_at: finishedAt,
    last_scan_id: scanId,
    entries: sortedEntries,
    repo_marker_cache: repoMarkerState?.counts ?? null,
  };
  const health = {
    schema_version: PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
    scan_id: scanId,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    summary,
    policy: policyRead
      ? {
          read_path: policyRead.read_path,
          source: safeRelativePolicySource(policyRead.source),
          policy_version: policyRead.policy?.policy_version ?? null,
          policy_hash: policyRead.policy_hash ?? null,
        }
      : null,
    phoenix_scan: phoenixScan,
    repo_marker_state: repoMarkerState
      ? {
          ok: repoMarkerState.ok,
          controller_calls_allowed: repoMarkerState.controller_calls_allowed,
          reason: repoMarkerState.reason ?? null,
          detail: repoMarkerState.detail ?? null,
          source: repoMarkerState.source ?? null,
          repo: repoMarkerState.repo ?? null,
          connection_mode: repoMarkerState.connection_mode ?? null,
          counts: repoMarkerState.counts ?? null,
        }
      : null,
  };
  writeJsonAtomic(promotionScannerLedgerPath(ledgerDir), ledger);
  writeJsonAtomic(promotionScannerHealthPath(ledgerDir), health);
  return { ledger, health };
}

export function deriveScanHealthStatus({ candidates, phoenixReady, tagScan, repoMarkerState }) {
  if (repoMarkerState && repoMarkerState.controller_calls_allowed === false) return "blocked";
  if (!phoenixReady.ok || tagScan?.ok === false || repoMarkerState?.ok === false) return "degraded";
  if (candidates.some((candidate) => candidate.status === "needs_reconciliation")) return "degraded";
  return "ok";
}

function formatBudgetWindowFact(candidate, repoMarkerState) {
  const counts = repoMarkerState?.counts ?? {};
  if (candidate.reason === "max_open_proposals_reached") {
    const activeOpen = counts.active_open_proposals ?? counts.max_open_proposals ?? null;
    const maxOpen = counts.max_open_proposals ?? activeOpen;
    if (activeOpen !== null && maxOpen !== null) {
      return `an open proposal closes (${activeOpen}/${maxOpen} open)`;
    }
    return "an open proposal closes";
  }
  if (candidate.reason === "proposal_budget_exhausted") {
    const periodDays = counts.proposal_budget_period_days ?? null;
    if (periodDays) return `the ${periodDays}-day budget window clears`;
    return "the budget window clears";
  }
  return "the proposal limit clears";
}

function candidateDisplayTarget(candidate) {
  return candidate.candidate_target_key || candidate.candidate_key || "unknown target";
}

function promotionCandidateRowHeadline(candidate, result) {
  if (candidate.status === "improvement_opportunity") {
    const opportunity = candidate.improvement_opportunity || {};
    return `Improvement opportunity found: ${opportunity.human_name || candidateDisplayTarget(candidate)}`;
  }
  if (candidate.status === "discovered_evidence_without_intent") {
    return "Evidence found, but no change was requested.";
  }
  if (candidate.status === "ignored_unmanaged_target") {
    return "Signal ignored because its target is not in the agent-behavior catalog.";
  }
  if (candidate.display_class === "evidence_needs_repair") {
    return "Evidence needs repair before the system can decide what to do.";
  }
  if (candidate.status === "controller_called_pr_opened") {
    const prTitle = candidate.pr?.title || candidate.pr_title || candidateDisplayTarget(candidate);
    return `Proposal ready for review: ${prTitle}`;
  }
  if (candidate.status === "promotion_write_report_only") {
    return "Candidate is ready, but proposal writing is waiting for guard activation.";
  }
  if (candidate.status === "blocked_by_policy_budget") {
    return `Proposal limit reached; no new proposals until ${formatBudgetWindowFact(candidate, result.repo_marker_state)}.`;
  }
  if (candidate.status === "blocked_by_verified_repo_state") {
    return "GitHub connection needs attention before proposals can be checked.";
  }
  if (candidate.status === "withdrawn_no_action") {
    return "Candidate was withdrawn; no proposal was opened.";
  }
  if (candidate.status === "suppressed_by_policy") {
    return "Promotion policy blocked this candidate.";
  }
  if (candidate.status === "controller_called") {
    return "Controller checked the candidate; no proposal was opened.";
  }
  if (candidate.status === "candidate_intent_ready") {
    return "Candidate is ready for promotion review.";
  }
  return "Candidate scan recorded a status.";
}

function internalReasonForCandidate(candidate) {
  return candidate.controller_reason || candidate.reason || null;
}

function formattedStatusCountLabel(candidate) {
  if (candidate.display_class === "evidence_needs_repair") return "evidence_needs_repair";
  switch (candidate.status) {
    case "controller_called_pr_opened":
      return "proposal_ready";
    case "improvement_opportunity":
      return "opportunity_found";
    case "controller_called":
      return "controller_checked";
    case "promotion_write_report_only":
      return "report_only";
    case "discovered_evidence_without_intent":
      return "evidence_without_change_request";
    case "ignored_unmanaged_target":
      return "ignored_unmanaged_target";
    case "blocked_by_policy_budget":
      return "proposal_limit_reached";
    case "blocked_by_verified_repo_state":
      return "github_connection_attention";
    case "candidate_intent_ready":
      return "ready";
    case "withdrawn_no_action":
      return "withdrawn";
    case "suppressed_by_policy":
      return "policy_blocked";
    default:
      return String(candidate.status || "unknown").replaceAll("_", "-");
  }
}

function formattedStatusCounts(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    const label = formattedStatusCountLabel(candidate);
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

export function formatPromotionCandidateScanReport(result) {
  const lines = [];
  if (!result.ok) {
    lines.push(`promotion scanner ${String(result.status || "failed").toUpperCase()}: ${result.reason}${result.detail ? ` - ${result.detail}` : ""}`);
    if (result.lock_path) lines.push(`  lock: ${result.lock_path}`);
    return lines;
  }
  lines.push(`promotion scanner ${result.status.toUpperCase()}: ${result.candidates.length} candidate signal(s) scanned`);
  if (result.policy) {
    lines.push(`  policy: v${result.policy.policy_version} hash ${result.policy.policy_hash.slice(0, 12)} via ${result.policy.read_path}`);
  }
  if (result.repo_marker_state) {
    lines.push(
      `  repo markers: ${result.repo_marker_state.controller_calls_allowed ? "controller calls allowed" : "controller calls blocked"}`,
    );
    if (!result.repo_marker_state.controller_calls_allowed && result.repo_marker_state.reason) {
      lines.push(`  internal: ${result.repo_marker_state.reason}`);
    }
  }
  if (result.phoenix_scan && result.phoenix_scan.ok === false) {
    lines.push(`  Phoenix scan degraded: ${result.phoenix_scan.reason}${result.phoenix_scan.detail ? ` - ${result.phoenix_scan.detail}` : ""}`);
  }
  const counts = formattedStatusCounts(result.candidates);
  lines.push(`  statuses: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`);
  for (const candidate of result.candidates) {
    lines.push(promotionCandidateRowHeadline(candidate, result));
    if (candidate.pr?.url) lines.push(candidate.pr.url);
    lines.push(`  target: ${candidateDisplayTarget(candidate)}`);
    const internal = internalReasonForCandidate(candidate);
    if (internal) lines.push(`  internal: ${internal}`);
    const detail = candidate.controller_detail || candidate.detail || null;
    if (detail) lines.push(`  detail: ${detail}`);
  }
  lines.push(`  ledger: ${result.ledger_path}`);
  lines.push(`  health: ${result.health_path}`);
  return lines;
}
