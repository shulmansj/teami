import fs from "node:fs";
import path from "node:path";

import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import { normalizeLegacyTeamIdentityForRead } from "../../../engine/legacy-team-state-compat.mjs";
import {
  TRACE_RECEIPT_SCHEMA_VERSION,
  findSecretContentKeys,
  LOCAL_TRACE_STATUSES,
} from "../../../engine/trace-contract.mjs";

const DEFAULT_HEALTH = Object.freeze({
  schema_version: 1,
  latest_success_at: null,
  latest_failure_at: null,
  latest_status: "trace_unknown",
  latest_reason: null,
  consecutive_failure_count: 0,
  recent_failure_count: 0,
  recent_failure_window: [],
  outbox_record_count: 0,
  outbox_byte_size: 0,
});
const RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;

export function traceTelemetryPaths(home = undefined) {
  const telemetryHome = resolveTraceTelemetryHome(home);
  const telemetryDir = path.join(teamiHomePaths({ home: telemetryHome }).phoenixDataDir, "telemetry");
  return {
    telemetryDir,
    healthFile: path.join(telemetryDir, "trace-health.json"),
    runsDir: path.join(telemetryDir, "runs"),
    outboxFile: path.join(telemetryDir, "phoenix-outbox.jsonl"),
  };
}

function resolveTraceTelemetryHome(home) {
  if (home !== undefined && !hasTeamiHomeOverride(process.env) && path.resolve(home) !== path.resolve(process.cwd())) {
    return home;
  }
  return resolveTeamiHome();
}

function hasTeamiHomeOverride(env) {
  return typeof env?.TEAMI_HOME === "string" && env.TEAMI_HOME.trim() !== "";
}

export function recordTraceStatus({
  repoRoot = process.cwd(),
  runId,
  teamRef,
  workspaceId,
  teamId,
  wakeId = null,
  projectId = null,
  attempt = null,
  workflowType = null,
  resource = null,
  resourceKind = null,
  githubBehaviorRepoId = null,
  githubBehaviorRepoLabel = null,
  traceId = null,
  phoenixAppUrl = null,
  status = "trace_unknown",
  reason = null,
  repairHint = null,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!runId) throw new Error("runId is required for local trace status.");
  if (!teamRef) throw new Error("teamRef is required for local trace status.");
  const receiptResource = normalizeReceiptResource(resource, resourceKind);
  const requiresLinearIdentity = requiresLinearReceiptIdentity(receiptResource?.kind);
  if (requiresLinearIdentity && !workspaceId) throw new Error("workspaceId is required for local trace status.");
  if (requiresLinearIdentity && !teamId) throw new Error("teamId is required for local trace status.");
  if (!LOCAL_TRACE_STATUSES.includes(status)) throw new Error(`Invalid local trace status: ${status}`);
  const paths = traceTelemetryPaths(repoRoot);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  const receiptPayload = {
    schema_version: TRACE_RECEIPT_SCHEMA_VERSION,
    run_id: runId,
    team_ref: teamRef,
    workspace_id: workspaceId,
    team_id: teamId,
    wake_id: wakeId,
    project_id: projectId,
    attempt,
    workflow_type: workflowType,
    trace_id: traceId,
    phoenix_app_url: phoenixAppUrl,
    trace_status: status,
    reason,
    repair_hint: repairHint,
    observed_at: observedAt,
  };
  if (receiptResource) receiptPayload.resource = receiptResource;
  if (githubBehaviorRepoId) receiptPayload.github_behavior_repo_id = githubBehaviorRepoId;
  if (githubBehaviorRepoLabel) receiptPayload.github_behavior_repo_label = githubBehaviorRepoLabel;
  const receipt = redactSecretFields(receiptPayload);
  writeJsonAtomic(path.join(paths.runsDir, `${safeFileName(runId)}.json`), receipt);
  const health = updateTraceHealth({ repoRoot, status, reason, observedAt });
  return { receipt, health };
}

export function readTraceHealth({ repoRoot = process.cwd() } = {}) {
  const paths = traceTelemetryPaths(repoRoot);
  if (!fs.existsSync(paths.healthFile)) return { ...DEFAULT_HEALTH };
  return { ...DEFAULT_HEALTH, ...JSON.parse(fs.readFileSync(paths.healthFile, "utf8")) };
}

export function readTraceReceipt({ repoRoot = process.cwd(), runId } = {}) {
  const paths = traceTelemetryPaths(repoRoot);
  const file = path.join(paths.runsDir, `${safeFileName(runId)}.json`);
  if (!fs.existsSync(file)) return null;
  let receipt;
  try {
    receipt = normalizeLegacyTeamIdentityForRead(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    return {
      ok: false,
      reason: "trace_receipt_invalid_json",
      detail: error.message,
      path: file,
    };
  }
  const failures = traceReceiptValidationFailures(receipt);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: legacyTraceReceiptFailures(receipt, failures)
        ? "trace_receipt_schema_legacy"
        : "trace_receipt_schema_invalid",
      detail: `local trace receipt needs re-run: ${failures.join(", ")}`,
      failures,
      path: file,
    };
  }
  return receipt;
}

export function isInvalidTraceReceiptResult(receipt) {
  return Boolean(receipt?.ok === false && typeof receipt.reason === "string" && receipt.reason.startsWith("trace_receipt_"));
}

export function validateTraceReceipt(receipt) {
  const failures = traceReceiptValidationFailures(receipt);
  if (failures.length > 0) {
    throw new Error(`Invalid trace receipt: ${failures.join(", ")}`);
  }
  return true;
}

function traceReceiptValidationFailures(receipt) {
  const failures = [];
  if (!receipt || typeof receipt !== "object") failures.push("receipt_not_object");
  if (receipt?.schema_version !== TRACE_RECEIPT_SCHEMA_VERSION) failures.push("unsupported_trace_receipt_schema_version");
  if (!receipt?.run_id) failures.push("missing_run_id");
  if (!receipt?.team_ref) failures.push("missing_team_ref");
  if (requiresLinearReceiptIdentity(receipt?.resource?.kind)) {
    if (!receipt?.workspace_id) failures.push("missing_workspace_id");
    if (!receipt?.team_id) failures.push("missing_team_id");
  }
  if (!LOCAL_TRACE_STATUSES.includes(receipt?.trace_status)) failures.push("invalid_trace_status");
  return [...new Set(failures)];
}

function legacyTraceReceiptFailures(receipt, failures) {
  const requiresLinearIdentity = requiresLinearReceiptIdentity(receipt?.resource?.kind);
  return receipt?.schema_version === 1
    || failures.includes("missing_team_ref")
    || (requiresLinearIdentity && failures.includes("missing_workspace_id"))
    || (requiresLinearIdentity && failures.includes("missing_team_id"));
}

export function updateTraceHealth({
  repoRoot = process.cwd(),
  status,
  reason = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const paths = traceTelemetryPaths(repoRoot);
  fs.mkdirSync(paths.telemetryDir, { recursive: true });
  const previous = readTraceHealth({ repoRoot });
  const failure = status !== "trace_exported";
  const cutoff = Date.parse(observedAt) - RECENT_FAILURE_WINDOW_MS;
  const recentFailures = (previous.recent_failure_window || [])
    .filter((timestamp) => Date.parse(timestamp) >= cutoff);
  if (failure) recentFailures.push(observedAt);
  const health = {
    ...previous,
    schema_version: 1,
    latest_status: status,
    latest_reason: reason,
    latest_success_at: failure ? previous.latest_success_at : observedAt,
    latest_failure_at: failure ? observedAt : previous.latest_failure_at,
    consecutive_failure_count: failure ? previous.consecutive_failure_count + 1 : 0,
    recent_failure_count: recentFailures.length,
    recent_failure_window: recentFailures.slice(-100),
  };
  writeJsonAtomic(paths.healthFile, health);
  return health;
}

export function appendAuditOnlyTraceOutbox({
  repoRoot = process.cwd(),
  record,
  observedAt = new Date().toISOString(),
} = {}) {
  const paths = traceTelemetryPaths(repoRoot);
  fs.mkdirSync(paths.telemetryDir, { recursive: true });
  const outboxRecord = redactSecretFields({
    schema_version: 1,
    kind: "audit_only_trace_delivery_failure",
    recovery_mode: "audit_only",
    observed_at: observedAt,
    ...record,
  });
  fs.appendFileSync(paths.outboxFile, `${JSON.stringify(outboxRecord)}\n`);
  const stat = fs.statSync(paths.outboxFile);
  const health = readTraceHealth({ repoRoot });
  writeJsonAtomic(paths.healthFile, {
    ...health,
    outbox_record_count: health.outbox_record_count + 1,
    outbox_byte_size: stat.size,
  });
  return outboxRecord;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function redactSecretFields(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  for (const keyPath of findSecretContentKeys(copy)) {
    setPath(copy, keyPath.split("."), "[redacted token material]");
  }
  return copy;
}

function setPath(target, parts, value) {
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor?.[part]) return;
    cursor = cursor[part];
  }
  if (cursor && parts.at(-1) in cursor) cursor[parts.at(-1)] = value;
}

function safeFileName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function normalizeReceiptResource(resource, resourceKind = null) {
  const kind = firstPresent(resource?.kind, resourceKind);
  const id = firstPresent(resource?.id);
  const label = firstPresent(resource?.label);
  if (!kind && !id && !label) return null;
  return {
    kind: kind || null,
    id: id || null,
    label: label || null,
  };
}

function requiresLinearReceiptIdentity(resourceKind) {
  return !resourceKind || String(resourceKind).toLowerCase() === "linear";
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}
