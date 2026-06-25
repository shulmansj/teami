import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  defaultRunStoreDir,
  fsyncDirectoryAfterRename,
  readRunArtifact,
  renameWithRetry,
  writeFileAndFsync,
} from "../../../engine/run-store.mjs";
import {
  computeProjectSnapshotHash,
  projectSnapshotProjection,
} from "./project-snapshot-store.mjs";

export const TRIGGER_FINGERPRINT_FIELD = "trigger_fingerprint_v1";
export const UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION =
  "agentic-factory-unconfirmed-linear-mutation-intent/v1";

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MUTATION_INTENT_ARTIFACT_KINDS = new Set(["commit", "pause", "resume"]);
const REPLAYABLE_ARTIFACT_KINDS = new Set(["commit", "pause"]);

export function computeTriggerFingerprint(project) {
  const semanticStatus = project?.status?.name || project?.status?.type || null;
  return computeProjectSnapshotHash(projectSnapshotProjection({ project, semanticStatus }));
}

export function listReplayPending({ domainId, repoRoot = process.cwd(), runStoreDir = null } = {}) {
  requireNonEmptyString(domainId, "domainId");
  const dirPath = mutationIntentDir({ repoRoot, runStoreDir });
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => replayPendingFromIntentPath({
      intentPath: path.join(dirPath, entry.name),
      domainId,
      repoRoot,
      runStoreDir,
    }))
    .filter(Boolean)
    .sort(compareReplayPending)
    .map(({ startedAt, ...pending }) => pending);
}

export function readReplayPending({
  domainId,
  projectId,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(projectId, "projectId");
  return listReplayPending({ domainId, repoRoot, runStoreDir })
    .find((pending) => pending.projectId === projectId) || null;
}

export function writeMutationIntent({
  domainId,
  projectId,
  runId,
  artifactKind,
  wakeId,
  startedAt,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const record = mutationIntentRecord({
    domainId,
    projectId,
    runId,
    artifactKind,
    wakeId,
    startedAt,
  });
  const filePath = mutationIntentPath({ runId, repoRoot, runStoreDir });
  writeJsonAtomic(filePath, record);

  const readBack = readJsonFile(filePath);
  if (JSON.stringify(readBack) !== JSON.stringify(record)) {
    throw new Error("Mutation intent read-back validation failed.");
  }
  return record;
}

export function clearMutationIntent({
  domainId,
  projectId,
  runId,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(domainId, "domainId");
  requireNonEmptyString(projectId, "projectId");
  assertSafeRunId(runId);
  const filePath = mutationIntentPath({ runId, repoRoot, runStoreDir });
  if (!fs.existsSync(filePath)) return { cleared: false };

  const existing = readJsonFile(filePath);
  if (
    existing.domain_id !== domainId ||
    existing.linear_project_id !== projectId ||
    existing.run_id !== runId
  ) {
    throw new Error("mutation_intent_clear_scope_mismatch");
  }

  fs.rmSync(filePath, { force: true });
  fsyncDirectoryAfterRename(path.dirname(filePath));
  return { cleared: true };
}

export function readSuppression({
  projectId,
  fingerprint,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(projectId, "projectId");
  assertFingerprint(fingerprint);
  const filePath = suppressionPath({ projectId, fingerprint, repoRoot, runStoreDir });
  if (!fs.existsSync(filePath)) return null;
  const note = readJsonFile(filePath);
  if (note.project_id !== projectId || note[TRIGGER_FINGERPRINT_FIELD] !== fingerprint) return null;
  validateSuppressionNote(note);
  return note;
}

export function writeSuppression({
  domainId,
  projectId,
  fingerprint,
  runId = null,
  terminalStatus,
  reason,
  createdAt,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const note = suppressionNote({
    domainId,
    projectId,
    fingerprint,
    runId,
    terminalStatus,
    reason,
    createdAt,
  });
  const filePath = suppressionPath({ projectId, fingerprint, repoRoot, runStoreDir });
  writeJsonAtomic(filePath, note);

  const readBack = readSuppression({ projectId, fingerprint, repoRoot, runStoreDir });
  if (JSON.stringify(readBack) !== JSON.stringify(note)) {
    throw new Error("Trigger suppression read-back validation failed.");
  }
  return note;
}

function replayPendingFromIntentPath({ intentPath, domainId, repoRoot, runStoreDir }) {
  const intent = readJsonFile(intentPath);
  validateMutationIntent(intent);
  if (intent.domain_id !== domainId) return null;
  if (!REPLAYABLE_ARTIFACT_KINDS.has(intent.artifact_kind)) return null;

  const artifact = readRunArtifact({ runId: intent.run_id, repoRoot, runStoreDir });
  if (!artifact) throw new Error(`mutation_intent_missing_run_artifact:${intent.run_id}`);
  if (artifact.domain_id !== domainId) throw new Error(`mutation_intent_artifact_domain_mismatch:${intent.run_id}`);
  if (artifact.linear_project_id !== intent.linear_project_id) {
    throw new Error(`mutation_intent_artifact_project_mismatch:${intent.run_id}`);
  }
  if (!REPLAYABLE_ARTIFACT_KINDS.has(artifact.kind)) {
    throw new Error(`mutation_intent_artifact_not_replayable:${intent.run_id}`);
  }
  if (artifact.kind !== intent.artifact_kind) {
    throw new Error(`mutation_intent_artifact_kind_mismatch:${intent.run_id}`);
  }

  return {
    domainId: intent.domain_id,
    projectId: intent.linear_project_id,
    runId: intent.run_id,
    artifactKind: intent.artifact_kind,
    startedAt: intent.started_at,
  };
}

function mutationIntentRecord({ domainId, projectId, runId, artifactKind, wakeId, startedAt }) {
  requireNonEmptyString(domainId, "domainId");
  requireNonEmptyString(projectId, "projectId");
  assertSafeRunId(runId);
  requireNonEmptyString(wakeId, "wakeId");
  if (!MUTATION_INTENT_ARTIFACT_KINDS.has(artifactKind)) {
    throw new Error(`invalid_mutation_intent_artifact_kind:${artifactKind || "missing"}`);
  }
  assertIsoTime(startedAt, "startedAt");
  const record = {
    schema_version: UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION,
    run_id: runId,
    artifact_kind: artifactKind,
    linear_project_id: projectId,
    domain_id: domainId,
    wake_id: wakeId,
    started_at: startedAt,
  };
  validateMutationIntent(record);
  return record;
}

function validateMutationIntent(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("mutation_intent_not_object");
  }
  if (record.schema_version !== UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION) {
    throw new Error("unsupported_mutation_intent_schema_version");
  }
  assertSafeRunId(record.run_id);
  if (!MUTATION_INTENT_ARTIFACT_KINDS.has(record.artifact_kind)) {
    throw new Error(`invalid_mutation_intent_artifact_kind:${record.artifact_kind || "missing"}`);
  }
  requireNonEmptyString(record.linear_project_id, "linear_project_id");
  requireNonEmptyString(record.domain_id, "domain_id");
  requireNonEmptyString(record.wake_id, "wake_id");
  assertIsoTime(record.started_at, "started_at");
  return true;
}

function suppressionNote({
  domainId,
  projectId,
  fingerprint,
  runId,
  terminalStatus,
  reason,
  createdAt,
}) {
  requireNonEmptyString(domainId, "domainId");
  requireNonEmptyString(projectId, "projectId");
  assertFingerprint(fingerprint);
  if (runId !== null) assertSafeRunId(runId);
  requireNonEmptyString(terminalStatus, "terminalStatus");
  requireNonEmptyString(reason, "reason");
  assertIsoTime(createdAt, "createdAt");
  const note = {
    project_id: projectId,
    domain_id: domainId,
    run_id: runId,
    terminal_status: terminalStatus,
    reason,
    [TRIGGER_FINGERPRINT_FIELD]: fingerprint,
    created_at: createdAt,
  };
  validateSuppressionNote(note);
  return note;
}

function validateSuppressionNote(note) {
  if (!note || typeof note !== "object" || Array.isArray(note)) {
    throw new Error("trigger_suppression_not_object");
  }
  requireNonEmptyString(note.project_id, "project_id");
  requireNonEmptyString(note.domain_id, "domain_id");
  if (note.run_id !== null) assertSafeRunId(note.run_id);
  requireNonEmptyString(note.terminal_status, "terminal_status");
  requireNonEmptyString(note.reason, "reason");
  assertFingerprint(note[TRIGGER_FINGERPRINT_FIELD]);
  assertIsoTime(note.created_at, "created_at");
  return true;
}

function compareReplayPending(a, b) {
  return (
    String(a.startedAt).localeCompare(String(b.startedAt)) ||
    a.runId.localeCompare(b.runId) ||
    a.projectId.localeCompare(b.projectId)
  );
}

function mutationIntentPath({ runId, repoRoot, runStoreDir }) {
  assertSafeRunId(runId);
  return path.join(mutationIntentDir({ repoRoot, runStoreDir }), `${runId}.json`);
}

function mutationIntentDir({ repoRoot, runStoreDir }) {
  return path.join(runCustodyDir({ repoRoot, runStoreDir }), "unconfirmed-linear-mutation-intents");
}

function suppressionPath({ projectId, fingerprint, repoRoot, runStoreDir }) {
  requireNonEmptyString(projectId, "projectId");
  assertFingerprint(fingerprint);
  return path.join(
    suppressionDir({ repoRoot, runStoreDir }),
    `${contentAddress(projectId)}.${fingerprint}.json`,
  );
}

function suppressionDir({ repoRoot, runStoreDir }) {
  return path.join(runCustodyDir({ repoRoot, runStoreDir }), "trigger-suppressions");
}

function runCustodyDir({ repoRoot, runStoreDir }) {
  return path.resolve(runStoreDir || defaultRunStoreDir(repoRoot));
}

function writeJsonAtomic(filePath, value) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileAndFsync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    JSON.parse(fs.readFileSync(tempPath, "utf8"));
    renameWithRetry(tempPath, filePath);
    fsyncDirectoryAfterRename(dirPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function contentAddress(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName}_required`);
  }
}

function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid_run_id:${runId || "missing"}`);
  }
}

function assertFingerprint(fingerprint) {
  if (typeof fingerprint !== "string" || !SNAPSHOT_HASH_PATTERN.test(fingerprint)) {
    throw new Error(`invalid_trigger_fingerprint:${fingerprint || "missing"}`);
  }
}

function assertIsoTime(value, fieldName) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName}_invalid`);
  }
}
