import { createHash, randomBytes } from "node:crypto";

export const DECOMPOSITION_TRIGGER_RUNNER_TRACE_KIND = "decomposition.trigger_runner.v1";
export const PLANNING_SESSION_TRACE_KIND = "planning.session.v1";

export const BASE_RUNNER_CAPABILITIES = Object.freeze([
  "linear.project.planned",
  DECOMPOSITION_TRIGGER_RUNNER_TRACE_KIND,
]);

export const TRACE_KINDS = Object.freeze([
  DECOMPOSITION_TRIGGER_RUNNER_TRACE_KIND,
  PLANNING_SESSION_TRACE_KIND,
]);

export const LOCAL_TRACE_STATUSES = Object.freeze([
  "trace_exported",
  "trace_unavailable",
  "trace_delivery_failed",
  "trace_unknown",
]);
export const TRACE_RECEIPT_SCHEMA_VERSION = 2;
export const CANONICAL_TEAM_TRACE_ATTRIBUTES = Object.freeze([
  "teami.behavior_repo_id",
  "teami.team_ref",
  "linear.workspace_id",
  "linear.team_id",
  "linear.project_id",
  "resource.kind",
  "resource.id",
  "resource.label",
  "work_type",
  "selected_resource_id",
  "resource_id",
  "github.behavior_repo_id",
  "github.behavior_repo_label",
]);

export const DEFAULT_LOCAL_TRACE_POLICY = Object.freeze({
  rich_traces_enabled: false,
  max_trace_payload_bytes: 64 * 1024,
  max_spans_per_export: 200,
});
export const LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS = Object.freeze({
  allowRichTraceContent: true,
});

const SECRET_KEY_PATTERN = /(^|[_\-.])(token|secret|api[_\-.]?key|authorization|password|credential|private[_\-.]?key)($|[_\-.])/i;
const SECRET_VALUE_PATTERN = new RegExp([
  "Bearer\\s+[A-Za-z0-9._~+/=-]{12,}",
  // Basic credentials are base64-wrapped token material; 24-char floor so
  // prose like "Basic authentication" does not trip.
  "Basic\\s+[A-Za-z0-9+/=]{24,}",
  "sk-" + "[A-Za-z0-9_-]{16,}",
  // Classic GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_) AND the fine-grained PAT
  // (github_pat_…); the classic pattern's `gh[pousr]_` does NOT match
  // `github_pat_`, so it needs its own alternative.
  "gh[pousr]_" + "[A-Za-z0-9_]{16,}",
  "github_pat_" + "[A-Za-z0-9_]{20,}",
  "xox[baprs]-" + "[A-Za-z0-9-]{16,}",
  "ri_" + "[A-Fa-f0-9]{16,}",
].join("|"));
// A secret-NAME = value assignment embedded in a free-text string value, e.g.
// `LINEAR_ACCESS_TOKEN=linear-secret-value` or `api_key: abc123def`. The
// SECRET_KEY_PATTERN catches a secret-shaped OBJECT key; this catches the same
// secret name carrying a value INSIDE a string (which SECRET_VALUE_PATTERN's
// provider-specific shapes miss). Case-insensitive; requires `=`/`:` + a 6+ char
// no-space value so a bare mention ("exfiltrate LINEAR_ACCESS_TOKEN") does not trip.
const SECRET_ASSIGNMENT_VALUE_PATTERN =
  /(?:token|secret|api[_\-.]?key|access[_\-.]?token|auth[_\-.]?token|password|credential|private[_\-.]?key)["'\s]*[:=]["'\s]*[^\s"']{6,}/i;
const RICH_CONTENT_KEYS = new Set([
  "prompt",
  "phase_packet",
  "phase_packets",
  "source_context",
  "repo_snippet",
  "shell_output",
]);

export function newTraceId(random = defaultRandomBytes) {
  const bytes = random(16);
  if (!bytes || bytes.length !== 16) throw new Error("trace_id_entropy_must_be_16_bytes");
  bytes[0] ||= 1;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requireCapabilities(actual = [], required = []) {
  const actualSet = new Set(actual || []);
  return required.filter((capability) => !actualSet.has(capability));
}

export function enforceTraceContentPolicy(payload = {}, {
  policy = DEFAULT_LOCAL_TRACE_POLICY,
  allowRichTraceContent = false,
} = {}) {
  const normalizedPolicy = { ...DEFAULT_LOCAL_TRACE_POLICY, ...(policy || {}) };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > normalizedPolicy.max_trace_payload_bytes) {
    return { ok: false, reason: "trace_payload_too_large" };
  }
  const spans = Array.isArray(payload?.spans) ? payload.spans : [];
  if (spans.length > normalizedPolicy.max_spans_per_export) {
    return { ok: false, reason: "too_many_trace_spans" };
  }
  const richKeys = findRichContentKeys(payload);
  if (richKeys.length > 0 && !(allowRichTraceContent || normalizedPolicy.rich_traces_enabled)) {
    return { ok: false, reason: "rich_trace_content_not_allowed", keys: richKeys };
  }
  const secretKeys = findSecretContentKeys(payload);
  if (secretKeys.length > 0) {
    return { ok: false, reason: "trace_payload_contains_token_material", keys: secretKeys };
  }
  return { ok: true, policy: normalizedPolicy };
}

export function findSecretContentKeys(value, path = []) {
  const matches = [];
  if (!value || typeof value !== "object") return matches;
  for (const [key, nested] of Object.entries(value)) {
    const currentPath = [...path, key];
    if (SECRET_KEY_PATTERN.test(key)) matches.push(currentPath.join("."));
    if (
      typeof nested === "string"
      && (SECRET_VALUE_PATTERN.test(nested) || SECRET_ASSIGNMENT_VALUE_PATTERN.test(nested))
    ) {
      matches.push(currentPath.join("."));
    }
    if (nested && typeof nested === "object") {
      matches.push(...findSecretContentKeys(nested, currentPath));
    }
  }
  return [...new Set(matches)];
}

export function findRichContentKeys(value, path = []) {
  const matches = [];
  if (!value || typeof value !== "object") return matches;
  for (const [key, nested] of Object.entries(value)) {
    const currentPath = [...path, key];
    if (RICH_CONTENT_KEYS.has(key)) matches.push(currentPath.join("."));
    if (nested && typeof nested === "object") matches.push(...findRichContentKeys(nested, currentPath));
  }
  return [...new Set(matches)];
}

export function digestTraceField(value) {
  return `sha256:${createHash("sha256").update(traceDigestInput(value), "utf8").digest("hex")}`;
}

export function traceDigestInput(value) {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch {
    // Best-effort observability: fall through to a stable primitive string.
  }
  return String(value ?? "");
}

export function boundedRunReceiptProjection({
  run,
  trace,
  traceStatus = "trace_unknown",
  traceId = null,
  phoenixAppUrl = null,
  artifactPointer = null,
  providerUpdateIds = [],
  repairHint = null,
} = {}) {
  if (!LOCAL_TRACE_STATUSES.includes(traceStatus)) {
    throw new Error(`Invalid local trace status: ${traceStatus}`);
  }
  const teamRef =
    run?.team_ref ||
    trace?.attributes?.["teami.team_ref"] ||
    trace?.attributes?.team_ref ||
    null;
  if (!teamRef) throw new Error("team_ref is required for local trace receipts.");
  const resource = receiptResourceProjection({ run, trace });
  const requiresLinearIdentity = requiresLinearReceiptIdentity(resource?.kind);
  const workspaceId =
    run?.workspace_id ||
    trace?.attributes?.["linear.workspace_id"] ||
    trace?.attributes?.workspace_id ||
    null;
  if (requiresLinearIdentity && !workspaceId) throw new Error("workspace_id is required for local trace receipts.");
  const teamId =
    run?.team_id ||
    trace?.attributes?.["linear.team_id"] ||
    trace?.attributes?.team_id ||
    null;
  if (requiresLinearIdentity && !teamId) throw new Error("team_id is required for local trace receipts.");
  const githubBehaviorRepoId = firstPresent(
    run?.github_behavior_repo_id,
    run?.github?.behavior_repo_id,
    trace?.attributes?.["github.behavior_repo_id"],
    trace?.attributes?.github_behavior_repo_id,
  );
  const githubBehaviorRepoLabel = firstPresent(
    run?.github_behavior_repo_label,
    run?.github?.behavior_repo_label,
    trace?.attributes?.["github.behavior_repo_label"],
    trace?.attributes?.github_behavior_repo_label,
  );
  const receipt = {
    schema_version: TRACE_RECEIPT_SCHEMA_VERSION,
    run_id: run?.run_id || trace?.attributes?.run_id || null,
    team_ref: teamRef,
    workspace_id: workspaceId,
    team_id: teamId,
    workflow_type: run?.workflow_type || trace?.attributes?.["workflow.name"] || null,
    wake_id: run?.wake_id || trace?.attributes?.wake_id || null,
    object_id: run?.object_id || trace?.attributes?.linear_project_id || null,
    status: run?.status || null,
    trace_status: traceStatus,
    trace_id: traceId || trace?.attributes?.trace_id || null,
    phoenix_app_url: phoenixAppUrl,
    terminal_reason: run?.terminal_reason || null,
    artifact_pointer: artifactPointer || run?.artifact_pointer || null,
    provider_update_ids: providerUpdateIds || run?.provider_update_ids || [],
    repair_hint: repairHint,
  };
  if (resource) receipt.resource = resource;
  if (githubBehaviorRepoId) receipt.github_behavior_repo_id = githubBehaviorRepoId;
  if (githubBehaviorRepoLabel) receipt.github_behavior_repo_label = githubBehaviorRepoLabel;
  return receipt;
}

function defaultRandomBytes(size) {
  return randomBytes(size);
}

function receiptResourceProjection({ run, trace } = {}) {
  const kind = firstPresent(
    run?.resource?.kind,
    run?.resource_kind,
    trace?.attributes?.["resource.kind"],
    trace?.attributes?.resource_kind,
  );
  const id = firstPresent(
    run?.resource?.id,
    run?.resource_id,
    trace?.attributes?.["resource.id"],
    trace?.attributes?.resource_id,
  );
  const label = firstPresent(
    run?.resource?.label,
    run?.resource_label,
    trace?.attributes?.["resource.label"],
    trace?.attributes?.resource_label,
  );
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
