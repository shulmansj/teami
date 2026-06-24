import fs from "node:fs";
import path from "node:path";

import { readLocalEvalInputs } from "../eval-status.mjs";
import {
  defaultPromotionRegistryDir,
  PROMOTION_REGISTRY_SCHEMA_VERSION,
} from "../promote-candidate.mjs";
import {
  defaultPromotionCandidateLedgerDir,
  promotionScannerLedgerPath,
  promotionScannerHealthPath,
} from "../promotion-candidate-scanner.mjs";
import { readTraceHealth, traceTelemetryPaths } from "../trace-status-store.mjs";

import {
  readJsonIfExists,
  readSupervisorState,
} from "./state-store.mjs";

function collectSupervisorResumeItems({ repoRoot, observedAtDate, agedAfterMs, sources, addItem }) {
  const stateRead = readSupervisorState({ repoRoot });
  sources.push({
    id: "supervisor_state",
    status: stateRead.ok ? "ok" : "missing",
    path: stateRead.state_path,
    reason: stateRead.ok ? null : stateRead.reason,
  });
  if (!stateRead.ok) return;
  const state = stateRead.state;
  const last = state.last_iteration || null;
  const lastFinishedAt = last?.finished_at || state.updated_at || null;
  const ageMs = millisecondsSince(lastFinishedAt, observedAtDate);
  if (ageMs !== null && ageMs > agedAfterMs) {
    addItem({
      id: "supervisor:aged",
      pm_state: "Blocked but safe",
      classification: "aged",
      source: "supervisor_state",
      ref: "local supervisor",
      reason: "supervisor_last_iteration_aged",
      detail: `last finished at ${lastFinishedAt}; run npm run supervisor:run or inspect npm run supervisor:status`,
      observed_at: lastFinishedAt,
      age_ms: ageMs,
      next_surface: "supervisor:status",
    });
  }
  if (["blocked", "backoff", "failed", "degraded"].includes(state.status)) {
    addItem({
      id: `supervisor:${state.status}`,
      pm_state: "Blocked but safe",
      classification: "attention",
      source: "supervisor_state",
      ref: "local supervisor",
      reason: `supervisor_${state.status}`,
      detail: last?.reason || state.crash_loop?.last_error || "local supervisor needs operator inspection",
      observed_at: lastFinishedAt,
      age_ms: ageMs,
      next_surface: "doctor or supervisor:status",
    });
  }
}

function collectScannerResumeItems({ repoRoot, observedAtDate, agedAfterMs, sources, addItem }) {
  const ledgerDir = defaultPromotionCandidateLedgerDir(repoRoot);
  const healthPath = promotionScannerHealthPath(ledgerDir);
  const ledgerPath = promotionScannerLedgerPath(ledgerDir);
  const health = readJsonIfExists(healthPath);
  const ledger = readJsonIfExists(ledgerPath);
  sources.push({
    id: "scanner_health",
    status: health ? "ok" : "missing",
    path: healthPath,
    reason: health ? null : "missing_scanner_health",
  });
  sources.push({
    id: "scanner_ledger",
    status: ledger ? "ok" : "missing",
    path: ledgerPath,
    reason: ledger ? null : "missing_scanner_ledger",
  });
  if (health) {
    const ageMs = millisecondsSince(health.finished_at, observedAtDate);
    if (ageMs !== null && ageMs > agedAfterMs) {
      addItem({
        id: "scanner:aged",
        pm_state: "Blocked but safe",
        classification: "aged",
        source: "scanner_health",
        ref: "promotion scanner",
        reason: "scanner_last_scan_aged",
        detail: `last scan finished at ${health.finished_at}; run npm run promotion:scan or npm run supervisor:run`,
        observed_at: health.finished_at,
        age_ms: ageMs,
        next_surface: "promotion:scan or supervisor:status",
      });
    }
    if (["blocked", "degraded"].includes(health.status)) {
      addItem({
        id: `scanner:${health.status}`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "scanner_health",
        ref: "promotion scanner",
        reason: `scanner_${health.status}`,
        detail: health.phoenix_scan?.reason || health.repo_marker_state?.reason || "scanner health is degraded",
        observed_at: health.finished_at,
        age_ms: ageMs,
        next_surface: "promotion:scan or supervisor:status",
      });
    }
  }
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  for (const entry of entries) {
    const ref = entry.candidate_target_key || entry.candidate_key || entry.receipt_id || "scanner entry";
    if ((entry.status === "controller_called" || entry.status === "controller_called_pr_opened") && entry.pr) {
      addItem({
        id: entry.proposal_instance_id ? `proposal:${entry.proposal_instance_id}` : `scanner:proposal:${ref}`,
        pm_state: "Proposal ready",
        classification: "proposal-ready",
        source: "scanner_ledger",
        ref,
        reason: "controller_routed_to_hitl",
        detail: entry.pr.url
          ? `PR #${entry.pr.number || "?"} ${entry.pr.url}${entry.pr.dry_run ? " [DRY RUN]" : ""}`
          : `PR #${entry.pr.number || "?"}${entry.pr.dry_run ? " [DRY RUN]" : ""}`,
        next_surface: "GitHub PR / PR evidence summary",
      });
    } else if (entry.status === "improvement_opportunity") {
      const opportunity = entry.improvement_opportunity || {};
      addItem({
        id: `scanner:improvement:${entry.candidate_key || ref}`,
        pm_state: "Needs your decision",
        classification: "attention",
        source: "scanner_ledger",
        ref,
        reason: entry.reason || entry.controller_reason || "improvement_opportunity_no_proposed_change",
        detail: `Improvement opportunity found: ${opportunity.human_name || ref}`,
        next_surface: "promotion:scan or agent session",
      });
    } else if (entry.status === "blocked_by_verified_repo_state") {
      addItem({
        id: `scanner:verified-repo-state:${entry.candidate_key || ref}`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "scanner_ledger",
        ref,
        reason: entry.reason || "blocked_by_verified_repo_state",
        detail: entry.detail || entry.reason || "blocked_by_verified_repo_state",
        next_surface: "promotion:scan or supervisor:status",
      });
    } else if (["needs_reconciliation", "discovered_evidence_without_intent"].includes(entry.status)) {
      addItem({
        id: `scanner:${entry.status}:${entry.candidate_key || ref}`,
        pm_state: "Needs your decision",
        classification: "attention",
        source: "scanner_ledger",
        ref,
        reason: entry.reason || entry.status,
        detail: entry.detail || "promotion evidence needs operator reconciliation before any controller call",
        next_surface: "promotion:scan or agent session",
      });
    } else if (entry.status === "suppressed_by_policy") {
      addItem({
        id: `scanner:suppressed:${entry.candidate_key || ref}`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "scanner_ledger",
        ref,
        reason: entry.reason || "suppressed_by_policy",
        detail: entry.detail || "policy suppressed controller calls; no proposal was opened",
        next_surface: "promotion:scan or PR marker review",
      });
    } else if (entry.status === "ignored_unmanaged_target") {
      addItem({
        id: `scanner:ignored:${entry.candidate_key || ref}`,
        pm_state: "No action",
        classification: "info",
        source: "scanner_ledger",
        ref,
        reason: entry.reason || "ignored_unmanaged_target",
        detail: entry.detail || "target is outside the manifest-declared agent-behavior catalog; no proposal was opened",
        next_surface: "none",
      });
    }
  }
}

function collectLocalRunResumeItems({ repoRoot, sources, addItem }) {
  const telemetry = traceTelemetryPaths(repoRoot);
  const healthPath = telemetry.healthFile;
  const healthExists = fs.existsSync(healthPath);
  const traceHealth = readTraceHealth({ repoRoot });
  sources.push({
    id: "trace_health",
    status: healthExists ? "ok" : "missing",
    path: healthPath,
    reason: healthExists ? null : "missing_trace_health",
  });
  if (traceHealth.consecutive_failure_count > 0) {
    addItem({
      id: "trace:delivery-degraded",
      pm_state: "Blocked but safe",
      classification: "attention",
      source: "trace_health",
      ref: "local Phoenix trace delivery",
      reason: traceHealth.latest_status || "trace_delivery_degraded",
      detail: traceHealth.latest_reason || "trace export has recent failures; repo artifacts and local receipts remain authoritative",
      observed_at: traceHealth.latest_failure_at,
      next_surface: "phoenix:status or doctor",
    });
  }

  const local = readLocalEvalInputs({ repoRoot });
  sources.push({
    id: "local_run_receipts",
    status: "ok",
    path: local.receiptsDir,
    reason: null,
    count: local.runs.length,
  });
  sources.push({
    id: "local_run_artifacts",
    status: "ok",
    path: local.artifactsDir,
    reason: null,
    count: local.runs.filter((run) => run.artifact_kind).length,
  });
  for (const run of local.runs) {
    const artifact = readJsonIfExists(path.join(local.artifactsDir, `${safeFileName(run.run_id)}.json`));
    if (run.artifact_kind === "pause") {
      addItem({
        id: `run:${run.run_id}:pause`,
        pm_state: "Needs your decision",
        classification: "attention",
        source: "local_run_artifacts",
        ref: `run ${run.run_id}`,
        reason: "paused_with_open_questions",
        detail: "the run paused for product/scope questions; answer in the existing Linear/agent surface before resume",
        observed_at: run.observed_at,
        next_surface: "Linear project update or agent session",
      });
    }
    if (run.artifact_kind === "resume") {
      const openQuestions = String(artifact?.packet?.open_questions_markdown || "").trim();
      addItem({
        id: `run:${run.run_id}:resume`,
        pm_state: openQuestions ? "Needs your decision" : "Working",
        classification: openQuestions ? "attention" : "resumed",
        source: "local_run_artifacts",
        ref: `run ${run.run_id}`,
        reason: openQuestions ? "resume_still_has_open_questions" : "resume_processed",
        detail: openQuestions
          ? "a resume artifact was applied but open questions remain"
          : "a resume artifact was processed; no new PM state is persisted",
        observed_at: run.observed_at,
        next_surface: openQuestions ? "Linear project update or agent session" : "run summary",
      });
    }
    if (run.judge_attempt?.judge_state === "judge_invalid" || run.judge_attempt?.judge_state === "judge_missing") {
      addItem({
        id: `run:${run.run_id}:judge-attention`,
        pm_state: "Needs your decision",
        classification: "attention",
        source: "local_run_receipts",
        ref: `run ${run.run_id}`,
        reason: run.judge_attempt.judge_state,
        detail: run.judge_attempt.reason || "judge output needs attention before trusting this evidence",
        observed_at: run.judge_attempt.attempted_at || run.observed_at,
        next_surface: "worklist or eval:judge",
      });
    }
    if (run.trace_status && run.trace_status !== "trace_exported") {
      addItem({
        id: `run:${run.run_id}:trace`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "local_run_receipts",
        ref: `run ${run.run_id}`,
        reason: run.trace_status,
        detail: "local run receipt exists, but Phoenix trace delivery did not complete",
        observed_at: run.observed_at,
        next_surface: "phoenix:status or eval:emit-checks",
      });
    }
  }
}

function collectLocalProposalResumeItems({ repoRoot, sources, addItem }) {
  const registryDir = defaultPromotionRegistryDir(repoRoot);
  const files = listJsonFilesShallow(registryDir);
  sources.push({
    id: "proposal_registry",
    status: fs.existsSync(registryDir) ? "ok" : "missing",
    path: registryDir,
    reason: fs.existsSync(registryDir) ? null : "missing_promotion_registry",
    count: files.length,
  });
  for (const file of files) {
    const record = readJsonIfExists(file);
    if (record?.schema_version !== PROMOTION_REGISTRY_SCHEMA_VERSION) continue;
    const ref = record.proposal_instance_id || record.normalized_envelope_hash || path.basename(file, ".json");
    if (record.pr?.number || record.pr?.url) {
      addItem({
        id: `proposal:${ref}`,
        pm_state: "Proposal ready",
        classification: "proposal-ready",
        source: "proposal_registry",
        ref,
        reason: record.repair_state === "phoenix_audit_retry_needed"
          ? "proposal_ready_with_phoenix_audit_repair"
          : "proposal_ready",
        detail: record.pr?.url
          ? `PR #${record.pr.number || "?"} ${record.pr.url}${record.pr.dry_run ? " [DRY RUN]" : ""}`
          : `PR #${record.pr.number || "?"}${record.pr.dry_run ? " [DRY RUN]" : ""}`,
        next_surface: "GitHub PR / PR evidence summary",
      });
    } else if (record.outcome?.outcome === "blocked") {
      addItem({
        id: `proposal:${ref}:blocked`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "proposal_registry",
        ref,
        reason: record.outcome.reason || "proposal_blocked",
        detail: record.outcome.detail || "promotion controller recorded a terminal blocked outcome",
        next_surface: "promote-candidate report or registry record",
      });
    } else if (["validated", "drafted", "committed"].includes(record.last_stage)) {
      addItem({
        id: `proposal:${ref}:resume`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "proposal_registry",
        ref,
        reason: "proposal_resume_pending",
        detail: `promotion registry last_stage=${record.last_stage}; re-invoking the same envelope resumes from the durable stage`,
        next_surface: "promote-candidate",
      });
    }
  }
}

async function collectHostedWakeResumeItems({
  hostedWakeViews,
  hostedWakeViewLoader,
  observedAtDate,
  agedAfterMs,
  sources,
  addItem,
}) {
  let views = hostedWakeViews;
  let source = {
    id: "hosted_wake_views",
    status: Array.isArray(views) ? "ok" : "not_configured",
    path: "hosted inbox /v1/wakeups/views via trigger-status store path",
    reason: Array.isArray(views) ? null : "no_hosted_wake_loader",
    count: Array.isArray(views) ? views.length : 0,
  };
  if (!Array.isArray(views) && typeof hostedWakeViewLoader === "function") {
    try {
      views = await hostedWakeViewLoader();
      source = {
        ...source,
        status: "ok",
        reason: null,
        count: Array.isArray(views) ? views.length : 0,
      };
    } catch (error) {
      source = {
        ...source,
        status: "unavailable",
        reason: redactHostedSourceReason(error?.message || String(error)),
        count: 0,
      };
      views = [];
    }
  }
  sources.push(source);
  for (const wake of Array.isArray(views) ? views : []) {
    const status = wake.derived_status || wake.status || "unknown";
    const ref = wake.object_id || wake.wake_key || wake.id || "hosted wake";
    const createdOrStartedAt = wake.started_at || wake.claimed_at || wake.created_at || wake.terminal_at || null;
    const ageMs = millisecondsSince(createdOrStartedAt, observedAtDate);
    const expired = ["leased", "running"].includes(wake.status)
      && wake.lease_expires_at
      && Date.parse(wake.lease_expires_at) <= observedAtDate.getTime();
    if (wake.status === "dead_letter" || status === "dead_letter") {
      addItem({
        id: `wake:${wake.id || ref}:dead-lettered`,
        pm_state: "Blocked but safe",
        classification: "dead-lettered",
        source: "hosted_wake_views",
        ref,
        reason: wake.reason || "dead_letter",
        detail: "hosted wake is terminally dead-lettered; local artifacts/receipts are the recovery evidence",
        observed_at: wake.terminal_at || createdOrStartedAt,
        age_ms: millisecondsSince(wake.terminal_at || createdOrStartedAt, observedAtDate),
        next_surface: "trigger-status or agent session",
      });
      continue;
    }
    if (expired) {
      addItem({
        id: `wake:${wake.id || ref}:expired`,
        pm_state: "Blocked but safe",
        classification: "expired",
        source: "hosted_wake_views",
        ref,
        reason: "hosted_wake_lease_expired",
        detail: `lease expired at ${wake.lease_expires_at}; stale runners have no mutation authority after lease expiry`,
        observed_at: wake.lease_expires_at,
        age_ms: millisecondsSince(wake.lease_expires_at, observedAtDate),
        next_surface: "trigger-status or foreground runner",
      });
      continue;
    }
    if (status === "paused") {
      addItem({
        id: `wake:${wake.id || ref}:paused`,
        pm_state: "Needs your decision",
        classification: "attention",
        source: "hosted_wake_views",
        ref,
        reason: wake.reason || "wake_paused",
        detail: "hosted wake terminal status says the decomposition paused for human input",
        observed_at: wake.terminal_at || createdOrStartedAt,
        age_ms: millisecondsSince(wake.terminal_at || createdOrStartedAt, observedAtDate),
        next_surface: "Linear project update or trigger-status",
      });
      continue;
    }
    if (status === "rejected") {
      addItem({
        id: `wake:${wake.id || ref}:rejected`,
        pm_state: "Blocked but safe",
        classification: "attention",
        source: "hosted_wake_views",
        ref,
        reason: wake.reason || "wake_rejected",
        detail: "hosted wake failed before a successful terminal run",
        observed_at: wake.terminal_at || createdOrStartedAt,
        age_ms: millisecondsSince(wake.terminal_at || createdOrStartedAt, observedAtDate),
        next_surface: "trigger-status or agent session",
      });
      continue;
    }
    if (status === "waiting_for_runner") {
      addItem({
        id: `wake:${wake.id || ref}:waiting`,
        pm_state: "Blocked but safe",
        classification: ageMs !== null && ageMs > agedAfterMs ? "aged" : "attention",
        source: "hosted_wake_views",
        ref,
        reason: "hosted_wake_waiting_for_runner",
        detail: "a queued wake has no fresh compatible runner heartbeat; supervisor does not claim hosted wakes under tonight's hard floor",
        observed_at: createdOrStartedAt,
        age_ms: ageMs,
        next_surface: "trigger-status or foreground runner",
      });
      continue;
    }
    if (ageMs !== null && ageMs > agedAfterMs && ["queued", "leased", "running"].includes(status)) {
      addItem({
        id: `wake:${wake.id || ref}:aged`,
        pm_state: "Blocked but safe",
        classification: "aged",
        source: "hosted_wake_views",
        ref,
        reason: `hosted_wake_${status}_aged`,
        detail: "hosted wake is non-terminal and older than the resume reconciliation threshold",
        observed_at: createdOrStartedAt,
        age_ms: ageMs,
        next_surface: "trigger-status or foreground runner",
      });
      continue;
    }
    if (["queued", "leased", "running"].includes(status)) {
      addItem({
        id: `wake:${wake.id || ref}:working`,
        pm_state: "Working",
        classification: "working",
        source: "hosted_wake_views",
        ref,
        reason: `hosted_wake_${status}`,
        detail: "hosted wake is active in the existing wake surface",
        observed_at: createdOrStartedAt,
        age_ms: ageMs,
        next_surface: "trigger-status",
      });
    }
  }
  return source;
}

function millisecondsSince(value, nowDate) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowDate.getTime() - parsed);
}

function listJsonFilesShallow(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function safeFileName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function redactHostedSourceReason(value) {
  return String(value || "unknown").replace(/token=[^)\s]+/gi, "token=[redacted]");
}

export {
  collectHostedWakeResumeItems,
  collectLocalProposalResumeItems,
  collectLocalRunResumeItems,
  collectScannerResumeItems,
  collectSupervisorResumeItems,
};
