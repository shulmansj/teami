import fs from "node:fs";
import path from "node:path";

import {
  ENGINE_VERSION,
  LEGACY_RUN_ARTIFACT_SCHEMA_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "./engine-contract-constants.mjs";

const SUPPORTED_RUN_ARTIFACT_SCHEMA_VERSIONS = new Set([
  RUN_ARTIFACT_SCHEMA_VERSION,
  LEGACY_RUN_ARTIFACT_SCHEMA_VERSION,
]);
const DELETE_AFTER_FIXTURE_RUN_ARTIFACT_SCHEMA_VERSIONS = new Set([
  "linear-decomposition-run-artifact/v1",
  "linear-decomposition-run-artifact/v2",
]);
const LEGACY_DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID = "linear-decomposition-run-payload/v1";
export const RUN_ARTIFACT_COMPATIBILITY = Object.freeze({
  schemaVersions: Object.freeze({
    [RUN_ARTIFACT_SCHEMA_VERSION]: "new-write",
    [LEGACY_RUN_ARTIFACT_SCHEMA_VERSION]: "legacy-read",
    "linear-decomposition-run-artifact/v1": "delete-after-fixture",
    "linear-decomposition-run-artifact/v2": "delete-after-fixture",
  }),
  kinds: Object.freeze({
    commit: "legacy-read-and-replay",
    pause: "legacy-read-and-replay",
    resume: "new-write",
    checkpoint: "legacy-read",
  }),
});
// `checkpoint` is a LEGACY kind: the engine no longer writes checkpoints (the
// orchestrator loop goes straight to a terminal `commit`/`pause`), but the kind
// stays recognized so an already-persisted checkpoint still validates as a
// readable artifact and is rejected at replay (artifact-apply.mjs) rather than
// failing as an unknown kind.
export const RUN_ARTIFACT_KINDS = Object.freeze(["checkpoint", "pause", "commit", "resume"]);
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function defaultRunStoreDir(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, ".agentic-factory", "runs");
}

export function runArtifactPath({ runId, repoRoot = process.cwd(), runStoreDir } = {}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("run_id is required for the local run artifact store.");
  }
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run_id for local run artifact store: ${runId}`);
  }
  return path.join(runStoreDir || defaultRunStoreDir(repoRoot), `${runId}.json`);
}

export function readRunArtifact(options = {}) {
  const filePath = runArtifactPath(options);
  if (!fs.existsSync(filePath)) return null;
  const artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
  validateRunArtifact(artifact, options);
  const migrated = migrateLegacyRunArtifactForRead(artifact, options);
  validateRunArtifact(migrated, options);
  return migrated;
}

export function writeRunArtifact(options = {}, artifact) {
  const filePath = runArtifactPath(options);
  const normalized = normalizeRunArtifact(artifact, options);
  validateRunArtifact(normalized, options);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileAndFsync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    validateRunArtifact(JSON.parse(fs.readFileSync(tempPath, "utf8")), options);
    renameWithRetry(tempPath, filePath);
    fsyncDirectoryAfterRename(dirPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }

  const readBack = readRunArtifact(options);
  if (JSON.stringify(readBack) !== JSON.stringify(normalized)) {
    throw new Error("Run artifact read-back validation failed.");
  }
  const result = {
    written: true,
    artifact_schema_valid: true,
    terminal_artifact_schema_valid: isTerminalRunArtifactKind(normalized.kind),
    artifact_path: filePath,
  };
  return options.returnDurabilityResult ? result : filePath;
}

export function assertRunStoreWritable({ repoRoot = process.cwd(), runStoreDir } = {}) {
  const dirPath = runStoreDir || defaultRunStoreDir(repoRoot);
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(
    dirPath,
    `.run-store-writable.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileAndFsync(probePath, "run-store-writable\n", { flag: "wx" });
  } finally {
    if (fs.existsSync(probePath)) fs.rmSync(probePath, { force: true });
  }
  return { ok: true, run_store_dir: dirPath };
}

export function validateRunArtifact(artifact, options = {}) {
  const failures = [];
  if (!artifact || typeof artifact !== "object") failures.push("artifact_not_object");
  if (classifyRunArtifactSchemaVersion(artifact?.schema_version) === "delete-after-fixture") {
    failures.push("delete_after_fixture_run_artifact_schema_version");
  } else if (!SUPPORTED_RUN_ARTIFACT_SCHEMA_VERSIONS.has(artifact?.schema_version)) {
    failures.push("unsupported_run_artifact_schema_version");
  }
  validateRunArtifactVersions(artifact, failures, options);
  if (!artifact?.run_id) failures.push("missing_run_id");
  else if (!SAFE_RUN_ID_PATTERN.test(artifact.run_id)) failures.push("invalid_run_id");
  if (!artifact?.domain_id) failures.push("missing_domain_id");
  else if (!SAFE_RUN_ID_PATTERN.test(artifact.domain_id)) failures.push("invalid_domain_id");
  if (!artifact?.workspace_id) failures.push("missing_workspace_id");
  if (!artifact?.team_id) failures.push("missing_team_id");
  if (!RUN_ARTIFACT_KINDS.includes(artifact?.kind)) {
    failures.push("invalid_artifact_kind");
  }
  if (!artifact?.runtime_assignments || typeof artifact.runtime_assignments !== "object") {
    failures.push("missing_runtime_assignments");
  }
  if (!artifact?.runtime_metadata || typeof artifact.runtime_metadata !== "object") {
    failures.push("missing_runtime_metadata");
  }
  validateRunArtifactPayloadEnvelope(artifact, failures);
  if (artifact?.kind === "commit" || artifact?.kind === "pause") {
    validateTerminalRunArtifactEnvelope(artifact, failures, options);
    validateFunctionRunPayload(artifact, failures, options);
  }
  if (artifact?.kind === "resume" && !artifact.packet) failures.push("missing_resume_packet");
  validateRunVersionRecord(artifact, failures);
  if (failures.length > 0) {
    throw new Error(`Invalid run artifact: ${[...new Set(failures)].join(", ")}`);
  }
  return true;
}

export function classifyRunArtifactSchemaVersion(schemaVersion) {
  if (schemaVersion === RUN_ARTIFACT_SCHEMA_VERSION) return "new-write";
  if (schemaVersion === LEGACY_RUN_ARTIFACT_SCHEMA_VERSION) return "legacy-read";
  if (DELETE_AFTER_FIXTURE_RUN_ARTIFACT_SCHEMA_VERSIONS.has(schemaVersion)) {
    return "delete-after-fixture";
  }
  return null;
}

export function classifyRunArtifactKind(kind) {
  if (kind === "checkpoint") return "legacy-read";
  if (kind === "commit" || kind === "pause") return "legacy-read-and-replay";
  if (kind === "resume") return "new-write";
  return null;
}

// The run-version record (B-REFS / S-REFS): three forward-only, OPTIONAL,
// backward-compatible fields. An old artifact that predates them MUST still
// validate (Q7 recreate-clean, no migration), so each clause only fires when
// the field is present and malformed — mirroring the optional
// `evidence.tool_events` check above.
function validateRunVersionRecord(artifact, failures) {
  if (Object.hasOwn(artifact || {}, "accepted_refs")) {
    if (!Array.isArray(artifact.accepted_refs)) {
      failures.push("invalid_accepted_refs");
    } else {
      for (const ref of artifact.accepted_refs) {
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
          failures.push("invalid_accepted_ref_entry");
          continue;
        }
        if (typeof ref.target_key !== "string" || ref.target_key === "") {
          failures.push("invalid_accepted_ref_target_key");
        }
        if (
          Object.hasOwn(ref, "accepted_baseline_id") &&
          ref.accepted_baseline_id !== null &&
          typeof ref.accepted_baseline_id !== "string"
        ) {
          failures.push("invalid_accepted_ref_accepted_baseline_id");
        }
        if (
          Object.hasOwn(ref, "snapshot_sha256") &&
          ref.snapshot_sha256 !== null &&
          typeof ref.snapshot_sha256 !== "string"
        ) {
          failures.push("invalid_accepted_ref_snapshot_sha256");
        }
      }
    }
  }
  if (
    Object.hasOwn(artifact || {}, "completed_at") &&
    (typeof artifact.completed_at !== "string" || artifact.completed_at === "")
  ) {
    failures.push("invalid_completed_at");
  }
  if (
    Object.hasOwn(artifact || {}, "execution_mode") &&
    !["live", "eval"].includes(artifact.execution_mode)
  ) {
    failures.push("invalid_execution_mode");
  }
}

export function normalizeRunArtifact(artifact, options = {}) {
  const normalized = { ...(isRecord(artifact) ? artifact : {}) };
  normalized.schema_version = normalized.schema_version || RUN_ARTIFACT_SCHEMA_VERSION;
  if (normalized.schema_version === RUN_ARTIFACT_SCHEMA_VERSION) {
    normalized.engine_version = normalized.engine_version || options.engineVersion || ENGINE_VERSION;
    normalized.function_version =
      normalized.function_version ||
      options.functionVersion ||
      normalized.workflow_version ||
      ENGINE_VERSION;
    // Compatibility alias for existing decomposition consumers that still read
    // workflow_version directly; engine_version/function_version are authoritative.
    normalized.workflow_version = normalized.workflow_version || normalized.function_version;
    if (isTerminalRunArtifactKind(normalized.kind)) {
      normalized.payload_schema_id =
        normalized.payload_schema_id || options.payloadSchemaId || "agentic-factory-flat-run-payload/v1";
      normalized.payload = isRecord(normalized.payload)
        ? normalized.payload
        : payloadFromMirroredTerminalFields(normalized);
    }
  } else if (normalized.schema_version === LEGACY_RUN_ARTIFACT_SCHEMA_VERSION) {
    normalized.workflow_version = normalized.workflow_version || options.functionVersion || ENGINE_VERSION;
  }
  return normalized;
}

function payloadFromMirroredTerminalFields(artifact) {
  const payload = {};
  if (isRecord(artifact.terminal_output)) payload.terminal_output = artifact.terminal_output;
  if (Object.hasOwn(artifact, "final_issues")) payload.final_issues = artifact.final_issues;
  if (Object.hasOwn(artifact, "project_update_markdown")) {
    payload.project_update_markdown = artifact.project_update_markdown;
  }
  if (Object.hasOwn(artifact, "pause_packet")) payload.pause_packet = artifact.pause_packet;
  if (Object.hasOwn(artifact, "discovery_issues")) payload.discovery_issues = artifact.discovery_issues;
  return payload;
}

function migrateLegacyRunArtifactForRead(artifact, options = {}) {
  if (!isRecord(artifact) || artifact.schema_version !== LEGACY_RUN_ARTIFACT_SCHEMA_VERSION) {
    return artifact;
  }
  const workflowVersion = artifact.workflow_version || options.functionVersion || ENGINE_VERSION;
  const migrated = {
    ...artifact,
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: artifact.engine_version || workflowVersion,
    function_version: artifact.function_version || workflowVersion,
    workflow_version: workflowVersion,
  };
  if (isTerminalRunArtifactKind(migrated.kind)) {
    migrated.payload_schema_id =
      artifact.payload_schema_id || options.payloadSchemaId || LEGACY_DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID;
    migrated.payload = isRecord(artifact.payload)
      ? { ...artifact.payload }
      : payloadFromMirroredTerminalFields(artifact);
  }
  return migrated;
}

export function writeFileAndFsync(filePath, contents, { flag = "w" } = {}) {
  let fd = null;
  let pendingError = null;
  try {
    fd = fs.openSync(filePath, flag);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    pendingError = error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if (!pendingError) pendingError = error;
      }
    }
  }
  if (pendingError) throw pendingError;
}

export function fsyncDirectoryAfterRename(dirPath) {
  if (process.platform === "win32") return false;
  let fd = null;
  let pendingError = null;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    pendingError = error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if (!pendingError) pendingError = error;
      }
    }
  }
  if (pendingError) throw pendingError;
  return true;
}

function isTerminalRunArtifactKind(kind) {
  return kind === "commit" || kind === "pause";
}

function validateRunArtifactVersions(artifact, failures, options = {}) {
  if (artifact?.schema_version === RUN_ARTIFACT_SCHEMA_VERSION) {
    const expectedEngineVersion = options.engineVersion || ENGINE_VERSION;
    if (artifact.engine_version !== expectedEngineVersion) failures.push("engine_version_mismatch");
    if (typeof artifact.function_version !== "string" || artifact.function_version.trim() === "") {
      failures.push("missing_function_version");
    } else if (options.functionVersion && artifact.function_version !== options.functionVersion) {
      failures.push("function_version_mismatch");
    }
    return;
  }
  if (artifact?.schema_version === LEGACY_RUN_ARTIFACT_SCHEMA_VERSION) {
    if (artifact?.workflow_version !== (options.functionVersion || ENGINE_VERSION)) {
      failures.push("workflow_version_mismatch");
    }
  }
}

function validateRunArtifactPayloadEnvelope(artifact, failures) {
  if (artifact?.schema_version !== RUN_ARTIFACT_SCHEMA_VERSION) return;
  if (!isTerminalRunArtifactKind(artifact?.kind)) return;
  if (typeof artifact.payload_schema_id !== "string" || artifact.payload_schema_id.trim() === "") {
    failures.push("missing_payload_schema_id");
  }
  if (!isRecord(artifact.payload)) failures.push("missing_payload");
}

function validateTerminalRunArtifactEnvelope(artifact, failures, options = {}) {
  const terminalOutput = isRecord(artifact.terminal_output) ? artifact.terminal_output : null;
  if (terminalOutput) {
    validateTerminalOutputAudit(terminalOutput, failures);
  } else if (
    artifact?.schema_version === LEGACY_RUN_ARTIFACT_SCHEMA_VERSION ||
    options.requireTerminalAudit === true
  ) {
    validateTerminalOutputAudit(terminalOutput, failures);
  }
  validateTerminalEvidence(artifact.evidence, failures);
  validateTerminalBounds(artifact.bounds, failures);

  if (artifact.kind === "commit") {
    if (terminalOutput && terminalOutput.outcome !== "commit") {
      failures.push("terminal_output_kind_mismatch");
    }
  }

  if (artifact.kind === "pause") {
    if (terminalOutput && !["pause", "failed_closed"].includes(terminalOutput.outcome)) {
      failures.push("terminal_output_kind_mismatch");
    }
    if (
      (artifact?.schema_version === LEGACY_RUN_ARTIFACT_SCHEMA_VERSION ||
        options.requireTerminalAudit === true) &&
      !isRecord(artifact.pause_packet)
    ) {
      failures.push("missing_pause_packet");
    }
  }
}

function validateFunctionRunPayload(artifact, failures, options = {}) {
  if (artifact?.kind !== "commit") return;
  const payloadValidator = resolvePayloadValidator(options.payloadValidator ?? options.commitPayload);
  if (!payloadValidator) return;
  const validation = payloadValidator(functionPayloadForValidation(artifact));
  if (!validation || validation.ok !== true) {
    const reasons = Array.isArray(validation?.failureReasons)
      ? validation.failureReasons
      : ["invalid_function_payload"];
    failures.push(...reasons);
  }
}

function resolvePayloadValidator(candidate) {
  if (typeof candidate === "function") return candidate;
  if (typeof candidate?.validateCommitPayload === "function") {
    return candidate.validateCommitPayload.bind(candidate);
  }
  return null;
}

function functionPayloadForValidation(artifact) {
  const terminalOutput = isRecord(artifact.terminal_output)
    ? artifact.terminal_output
    : isRecord(artifact.payload?.terminal_output)
      ? artifact.payload.terminal_output
      : {};
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  return {
    ...terminalOutput,
    ...payload,
    final_issues: payload.final_issues ?? artifact.final_issues,
    project_update_markdown: payload.project_update_markdown ?? artifact.project_update_markdown,
  };
}

function validateTerminalOutputAudit(terminalOutput, failures) {
  if (!terminalOutput || typeof terminalOutput !== "object" || Array.isArray(terminalOutput)) {
    failures.push("missing_terminal_output");
    return;
  }
  if (typeof terminalOutput.outcome !== "string" || terminalOutput.outcome.trim() === "") {
    failures.push("missing_terminal_output_outcome");
  }
  if (typeof terminalOutput.reason !== "string" || terminalOutput.reason.trim() === "") {
    failures.push("missing_terminal_output_reason");
  }
  if (
    typeof terminalOutput.context_digest !== "string" ||
    terminalOutput.context_digest.trim() === ""
  ) {
    failures.push("missing_terminal_output_context_digest");
  }
  for (const field of ["source_refs", "assumptions", "constraints", "risks"]) {
    if (!Array.isArray(terminalOutput[field])) failures.push(`missing_terminal_output_${field}`);
  }
}

function validateTerminalEvidence(evidence, failures) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    failures.push("missing_evidence");
    return;
  }
  if (!Array.isArray(evidence.perspectives_run)) {
    failures.push("missing_evidence_perspectives_run");
  }
  if (Object.hasOwn(evidence, "tool_events") && !Array.isArray(evidence.tool_events)) {
    failures.push("invalid_evidence_tool_events");
  }
  if (
    Object.hasOwn(evidence, "evidence_unavailable") &&
    !Array.isArray(evidence.evidence_unavailable)
  ) {
    failures.push("invalid_evidence_unavailable");
  }
}

function validateTerminalBounds(bounds, failures) {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    failures.push("missing_bounds");
    return;
  }
  for (const field of ["rounds_used", "max_rounds"]) {
    if (typeof bounds[field] !== "number" || !Number.isFinite(bounds[field])) {
      failures.push(`missing_bounds_${field}`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function renameWithRetry(tempPath, filePath) {
  const retryable = new Set(["EPERM", "EACCES"]);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error.code)) break;
    }
  }
  if (fs.existsSync(tempPath)) {
    fs.rmSync(tempPath, { force: true });
  }
  throw lastError;
}
