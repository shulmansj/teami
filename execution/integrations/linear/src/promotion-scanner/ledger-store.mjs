import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../../../engine/run-store.mjs";

export const PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION =
  "agentic-factory-promotion-scanner-ledger/v2";
export const PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION =
  "agentic-factory-promotion-scanner-health/v2";
const PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION_V1 =
  "agentic-factory-promotion-scanner-ledger/v1";
export const PROMOTION_SCANNER_CACHE_NOTE =
  "Scanner ledger is cache/status only. Budgets, caps, dedupe, and rejection memory derive from repo-visible PR markers, never this file.";
const POLICY_BUDGET_BLOCK_REASONS = new Set([
  "max_open_proposals_reached",
  "proposal_budget_exhausted",
]);
const VERIFIED_REPO_STATE_BLOCK_REASONS = new Set([
  "missing_github_connection_state",
  "invalid_github_connection_state",
  "github_connection_not_verified",
  "github_transport_unavailable",
  "github_pr_listing_failed",
  "github_pr_listing_truncated",
  "promotion_marker_unreadable",
]);

export function defaultPromotionCandidateLedgerDir(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, ".agentic-factory", "promotion-candidates");
}

export function promotionScannerLedgerPath(ledgerDir) {
  return path.join(ledgerDir, "scanner-ledger.json");
}

export function promotionScannerHealthPath(ledgerDir) {
  return path.join(ledgerDir, "scanner-health.json");
}

export function promotionScannerLockPath(ledgerDir) {
  return path.join(ledgerDir, "scanner.lock");
}
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function scanIdFromDate(date) {
  return `scan-${date.toISOString().replace(/[-:.]/g, "")}`;
}

export function readJsonTolerant(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = JSON.parse(JSON.stringify(value));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(tempPath, "utf8"));
  renameWithRetry(tempPath, filePath);
  return filePath;
}

export function normalizeOrigin(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}

export function statusCounts(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    counts[candidate.status] = (counts[candidate.status] || 0) + 1;
  }
  return counts;
}

function freshPromotionScannerLedger() {
  return {
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
    _note: PROMOTION_SCANNER_CACHE_NOTE,
    updated_at: null,
    last_scan_id: null,
    entries: [],
    repo_marker_cache: null,
  };
}

function controllerResultFromRowLike(row) {
  return {
    outcome: row.controller_result?.outcome ?? row.controller_outcome ?? null,
    reason: row.controller_result?.reason ?? row.controller_reason ?? null,
    detail: row.controller_result?.detail ?? row.controller_detail ?? null,
    terminal: row.controller_result?.terminal ?? row.controller_terminal ?? null,
    evidence_repair: Boolean(row.controller_result?.evidence_repair ?? row.evidence_repair),
    improvement_opportunity:
      row.controller_result?.improvement_opportunity ?? row.improvement_opportunity ?? null,
    pr_title: row.controller_result?.pr_title ?? row.pr_title ?? row.pr?.title ?? null,
    pr: row.controller_result?.pr ?? row.pr ?? null,
  };
}

function statusForSuppressedPolicyRow(reason) {
  if (POLICY_BUDGET_BLOCK_REASONS.has(reason)) return "blocked_by_policy_budget";
  if (VERIFIED_REPO_STATE_BLOCK_REASONS.has(reason)) return "blocked_by_verified_repo_state";
  return "suppressed_by_policy";
}

function deriveLedgerRowStatus(row) {
  const controller = controllerResultFromRowLike(row);
  if (row.status === "controller_called") {
    if (controller.outcome === "route_to_hitl") return "controller_called_pr_opened";
    if (
      controller.outcome === "blocked"
      && controller.reason === "improvement_opportunity_no_proposed_change"
    ) {
      return "improvement_opportunity";
    }
    if (controller.outcome === "blocked" && controller.evidence_repair) {
      return "needs_reconciliation";
    }
  }
  if (row.status === "suppressed_by_policy") {
    return statusForSuppressedPolicyRow(row.reason ?? null);
  }
  return row.status;
}

export function withDerivedLedgerRowFields(row) {
  const controller = controllerResultFromRowLike(row);
  const status = deriveLedgerRowStatus(row);
  const entry = { ...row, status };
  if (status === "needs_reconciliation") {
    entry.display_class = "evidence_needs_repair";
  }
  if (status === "improvement_opportunity" && controller.improvement_opportunity) {
    entry.improvement_opportunity = controller.improvement_opportunity;
  }
  return entry;
}

function migratePromotionScannerLedgerV1ToV2(ledger) {
  // Deterministic v1->v2 row status table:
  // controller_called + route_to_hitl -> controller_called_pr_opened
  // controller_called + blocked/improvement_opportunity_no_proposed_change -> improvement_opportunity
  // controller_called + blocked/evidence_repair -> needs_reconciliation + display_class=evidence_needs_repair
  // needs_reconciliation -> needs_reconciliation + display_class=evidence_needs_repair
  // suppressed_by_policy + max_open_proposals_reached/proposal_budget_exhausted -> blocked_by_policy_budget
  // suppressed_by_policy + GitHub identity/transport/listing/marker-read reasons -> blocked_by_verified_repo_state
  // every other row keeps its v1 status.
  const entries = Array.isArray(ledger.entries)
    ? ledger.entries.map((entry) => withDerivedLedgerRowFields(entry))
    : [];
  return {
    ...freshPromotionScannerLedger(),
    ...ledger,
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
    _note: PROMOTION_SCANNER_CACHE_NOTE,
    entries,
    repo_marker_cache: ledger.repo_marker_cache ?? null,
  };
}

export function readPromotionScannerLedger({ ledgerDir } = {}) {
  if (!ledgerDir) throw new Error("ledgerDir is required");
  const ledgerPath = promotionScannerLedgerPath(ledgerDir);
  if (!fs.existsSync(ledgerPath)) return freshPromotionScannerLedger();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch {
    // The ledger is a cache only (CONSTRAINTS #10/#18): corrupt local status
    // is rebuilt fresh and never supplies budget, cap, dedupe, or rejection truth.
    const ledger = freshPromotionScannerLedger();
    writeJsonAtomic(ledgerPath, ledger);
    return ledger;
  }
  if (parsed?.schema_version === PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION) return parsed;
  if (parsed?.schema_version === PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION_V1) {
    const ledger = migratePromotionScannerLedgerV1ToV2(parsed);
    writeJsonAtomic(ledgerPath, ledger);
    return ledger;
  }
  const ledger = freshPromotionScannerLedger();
  writeJsonAtomic(ledgerPath, ledger);
  return ledger;
}

export function setCandidateStatus(candidate, status, reason, detail = null) {
  candidate.status = status;
  candidate.reason = reason;
  candidate.detail = detail;
  return candidate;
}

export function isTerminalNoControllerStatus(status) {
  return status !== "candidate_intent_ready";
}

export function candidateSortKey(candidate) {
  return [
    candidate.candidate_target_key ?? "",
    candidate.candidate_version_id ?? "",
    candidate.experiment_id ?? "",
    candidate.receipt_id ?? "",
    candidate.candidate_key ?? "",
  ].join("\u0000");
}

export function safeRelativePolicySource(source) {
  return String(source || "").replaceAll("\\", "/");
}

export function normalizeRepoRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const posix = path.posix.normalize(normalized);
  if (posix === "." || posix.startsWith("../") || posix === "..") return null;
  return posix;
}
