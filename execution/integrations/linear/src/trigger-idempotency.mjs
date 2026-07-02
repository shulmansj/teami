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
  "teami-unconfirmed-linear-mutation-intent/v2";
const UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION_V1 =
  "teami-unconfirmed-linear-mutation-intent/v1";
const SUPPORTED_MUTATION_INTENT_SCHEMA_VERSIONS = new Set([
  UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION,
  UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION_V1,
]);

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MUTATION_INTENT_ARTIFACT_KINDS = new Set(["commit", "pause", "resume"]);
const REPLAYABLE_ARTIFACT_KINDS = new Set(["commit", "pause"]);
const MUTATION_INTENT_OBJECT_TYPES = new Set(["project", "issue"]);
const REQUIRED_GIT_IDENTITY_FIELDS = ["owner", "repo", "branch", "base_sha"];
const OBSERVED_GIT_IDENTITY_FIELDS = ["head_sha", "tree_sha"];
const PROJECT_WORKFLOW_TYPE = "decomposition";
const PROJECT_TRIGGER_TYPE = "linear.project.planned";

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
    .filter((pending) => pending.objectType === "project")
    .sort(compareReplayPending)
    .map(({ startedAt, objectType, ...pending }) => pending);
}

export function listGitReplayPending({ domainId, repoRoot = process.cwd(), runStoreDir = null } = {}) {
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
    .filter((pending) => pending.objectType === "issue")
    .sort(compareReplayPending)
    .map(({ startedAt, objectType, ...pending }) => pending);
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

export function readGitReplayPending({
  domainId,
  objectId,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(objectId, "objectId");
  return listGitReplayPending({ domainId, repoRoot, runStoreDir })
    .find((pending) => pending.objectId === objectId) || null;
}

export async function replayPendingGitMutation({
  domainId,
  objectId,
  pending = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  applyGitMutationFn = null,
} = {}) {
  const target = pending || readGitReplayPending({ domainId, objectId, repoRoot, runStoreDir });
  if (!target) return { action: "git_replay", status: "no_pending", cleared: false };
  if (target.objectType && target.objectType !== "issue") {
    return { action: "git_replay", status: "wrong_object_type", cleared: false };
  }
  if (typeof applyGitMutationFn !== "function") {
    return { action: "git_replay", status: "pending_no_executor", cleared: false, pending: target };
  }
  const resolvedObjectId = objectId || target.objectId;
  const result = await applyGitMutationFn({
    domainId,
    objectId: resolvedObjectId,
    pending: target,
    repoRoot,
    runStoreDir,
  });
  return { action: "git_replay", status: "delegated", cleared: false, result, pending: target };
}

export function writeMutationIntent({
  domainId,
  projectId,
  objectType = "project",
  objectId = null,
  runId,
  artifactKind,
  wakeId,
  startedAt,
  workflowType = null,
  triggerType = null,
  git = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const record = mutationIntentRecord({
    domainId,
    projectId,
    objectType,
    objectId,
    runId,
    artifactKind,
    wakeId,
    startedAt,
    workflowType,
    triggerType,
    git,
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
  objectId = null,
  objectType = null,
  runId,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(domainId, "domainId");
  const expectedObjectId = objectId || projectId;
  requireNonEmptyString(expectedObjectId, objectType === "issue" ? "objectId" : "projectId");
  assertSafeRunId(runId);
  const filePath = mutationIntentPath({ runId, repoRoot, runStoreDir });
  if (!fs.existsSync(filePath)) return { cleared: false };

  const existing = normalizeMutationIntent(readJsonFile(filePath));
  if (
    existing.domain_id !== domainId ||
    existing.object_id !== expectedObjectId ||
    existing.run_id !== runId ||
    (objectType && existing.object_type !== objectType)
  ) {
    throw new Error("mutation_intent_clear_scope_mismatch");
  }

  fs.rmSync(filePath, { force: true });
  fsyncDirectoryAfterRename(path.dirname(filePath));
  return { cleared: true };
}

export function readSuppression({
  projectId,
  objectType = "project",
  objectId = null,
  fingerprint,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const identity = suppressionObjectIdentity({ projectId, objectType, objectId });
  assertFingerprint(fingerprint);
  const filePath = suppressionPath({ projectId: identity.objectId, fingerprint, repoRoot, runStoreDir });
  if (!fs.existsSync(filePath)) return null;
  const note = readJsonFile(filePath);
  if (identity.objectType === "project") {
    if (note.project_id !== identity.objectId || note[TRIGGER_FINGERPRINT_FIELD] !== fingerprint) return null;
  } else if (
    note.object_type !== identity.objectType ||
    note.object_id !== identity.objectId ||
    note[TRIGGER_FINGERPRINT_FIELD] !== fingerprint
  ) {
    return null;
  }
  validateSuppressionNote(note);
  return note;
}

export function writeSuppression({
  domainId,
  projectId,
  objectType = "project",
  objectId = null,
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
    objectType,
    objectId,
    fingerprint,
    runId,
    terminalStatus,
    reason,
    createdAt,
  });
  const identity = suppressionObjectIdentity({ projectId, objectType, objectId });
  const filePath = suppressionPath({ projectId: identity.objectId, fingerprint, repoRoot, runStoreDir });
  writeJsonAtomic(filePath, note);

  const readBack = readSuppression({
    projectId,
    objectType,
    objectId,
    fingerprint,
    repoRoot,
    runStoreDir,
  });
  if (JSON.stringify(readBack) !== JSON.stringify(note)) {
    throw new Error("Trigger suppression read-back validation failed.");
  }
  return note;
}

function replayPendingFromIntentPath({ intentPath, domainId, repoRoot, runStoreDir }) {
  const intent = normalizeMutationIntent(readJsonFile(intentPath));
  if (intent.domain_id !== domainId) return null;
  if (!REPLAYABLE_ARTIFACT_KINDS.has(intent.artifact_kind)) return null;

  if (intent.object_type === "issue") {
    return {
      objectType: "issue",
      domainId: intent.domain_id,
      objectId: intent.object_id,
      runId: intent.run_id,
      artifactKind: intent.artifact_kind,
      git: intent.git,
      startedAt: intent.started_at,
    };
  }

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
    objectType: "project",
    domainId: intent.domain_id,
    projectId: intent.linear_project_id,
    runId: intent.run_id,
    artifactKind: intent.artifact_kind,
    startedAt: intent.started_at,
  };
}

function mutationIntentRecord({
  domainId,
  runId,
  artifactKind,
  wakeId,
  startedAt,
  objectType = "project",
  objectId = null,
  projectId = null,
  workflowType = null,
  triggerType = null,
  git = null,
}) {
  requireNonEmptyString(domainId, "domainId");
  assertSafeRunId(runId);
  requireNonEmptyString(wakeId, "wakeId");
  if (!MUTATION_INTENT_ARTIFACT_KINDS.has(artifactKind)) {
    throw new Error(`invalid_mutation_intent_artifact_kind:${artifactKind || "missing"}`);
  }
  assertIsoTime(startedAt, "startedAt");
  if (!MUTATION_INTENT_OBJECT_TYPES.has(objectType)) {
    throw new Error(`invalid_mutation_intent_object_type:${objectType || "missing"}`);
  }

  let resolvedObjectId = null;
  let resolvedWorkflowType = workflowType;
  let resolvedTriggerType = triggerType;
  let normalizedGit = null;
  if (objectType === "project") {
    resolvedObjectId = objectId || projectId;
    requireNonEmptyString(resolvedObjectId, "projectId");
    resolvedWorkflowType ||= PROJECT_WORKFLOW_TYPE;
    resolvedTriggerType ||= PROJECT_TRIGGER_TYPE;
  } else {
    resolvedObjectId = objectId;
    requireNonEmptyString(resolvedObjectId, "objectId");
    requireNonEmptyString(resolvedWorkflowType, "workflowType");
    requireNonEmptyString(resolvedTriggerType, "triggerType");
    normalizedGit = normalizeGitIdentity(git);
  }

  requireNonEmptyString(resolvedWorkflowType, "workflowType");
  requireNonEmptyString(resolvedTriggerType, "triggerType");
  const record = {
    schema_version: UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION,
    run_id: runId,
    artifact_kind: artifactKind,
    object_type: objectType,
    object_id: resolvedObjectId,
    workflow_type: resolvedWorkflowType,
    trigger_type: resolvedTriggerType,
    domain_id: domainId,
    wake_id: wakeId,
    started_at: startedAt,
    ...(objectType === "project" ? { linear_project_id: resolvedObjectId } : {}),
    ...(objectType === "issue" ? { git: normalizedGit } : {}),
  };
  validateMutationIntent(record);
  return record;
}

function validateMutationIntent(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("mutation_intent_not_object");
  }
  if (!SUPPORTED_MUTATION_INTENT_SCHEMA_VERSIONS.has(record.schema_version)) {
    throw new Error("unsupported_mutation_intent_schema_version");
  }
  assertSafeRunId(record.run_id);
  if (!MUTATION_INTENT_ARTIFACT_KINDS.has(record.artifact_kind)) {
    throw new Error(`invalid_mutation_intent_artifact_kind:${record.artifact_kind || "missing"}`);
  }
  requireNonEmptyString(record.domain_id, "domain_id");
  requireNonEmptyString(record.wake_id, "wake_id");
  assertIsoTime(record.started_at, "started_at");

  if (record.schema_version === UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION_V1) {
    requireNonEmptyString(record.linear_project_id, "linear_project_id");
    return true;
  }

  if (!MUTATION_INTENT_OBJECT_TYPES.has(record.object_type)) {
    throw new Error(`invalid_mutation_intent_object_type:${record.object_type || "missing"}`);
  }
  requireNonEmptyString(record.object_id, "object_id");
  requireNonEmptyString(record.workflow_type, "workflow_type");
  requireNonEmptyString(record.trigger_type, "trigger_type");
  if (record.object_type === "project") {
    requireNonEmptyString(record.linear_project_id, "linear_project_id");
    if (record.linear_project_id !== record.object_id) {
      throw new Error("mutation_intent_project_identity_mismatch");
    }
  } else {
    validateGitIdentity(record.git);
  }
  return true;
}

function normalizeMutationIntent(record) {
  validateMutationIntent(record);
  if (record.schema_version === UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION_V1) {
    return {
      object_type: "project",
      object_id: record.linear_project_id,
      linear_project_id: record.linear_project_id,
      workflow_type: PROJECT_WORKFLOW_TYPE,
      trigger_type: PROJECT_TRIGGER_TYPE,
      domain_id: record.domain_id,
      run_id: record.run_id,
      artifact_kind: record.artifact_kind,
      wake_id: record.wake_id,
      started_at: record.started_at,
      git: null,
    };
  }
  return {
    object_type: record.object_type,
    object_id: record.object_id,
    linear_project_id: record.object_type === "project" ? record.object_id : null,
    workflow_type: record.workflow_type,
    trigger_type: record.trigger_type,
    domain_id: record.domain_id,
    run_id: record.run_id,
    artifact_kind: record.artifact_kind,
    wake_id: record.wake_id,
    started_at: record.started_at,
    git: record.object_type === "issue" ? record.git : null,
  };
}

function suppressionNote({
  domainId,
  projectId,
  objectType = "project",
  objectId = null,
  fingerprint,
  runId,
  terminalStatus,
  reason,
  createdAt,
}) {
  const identity = suppressionObjectIdentity({ projectId, objectType, objectId });
  requireNonEmptyString(domainId, "domainId");
  assertFingerprint(fingerprint);
  if (runId !== null) assertSafeRunId(runId);
  requireNonEmptyString(terminalStatus, "terminalStatus");
  requireNonEmptyString(reason, "reason");
  assertIsoTime(createdAt, "createdAt");
  const note = identity.objectType === "project"
    ? {
        project_id: identity.objectId,
        domain_id: domainId,
        run_id: runId,
        terminal_status: terminalStatus,
        reason,
        [TRIGGER_FINGERPRINT_FIELD]: fingerprint,
        created_at: createdAt,
      }
    : {
        object_type: identity.objectType,
        object_id: identity.objectId,
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
  if (note.object_type === "issue") {
    requireNonEmptyString(note.object_id, "object_id");
  } else {
    requireNonEmptyString(note.project_id, "project_id");
  }
  requireNonEmptyString(note.domain_id, "domain_id");
  if (note.run_id !== null) assertSafeRunId(note.run_id);
  requireNonEmptyString(note.terminal_status, "terminal_status");
  requireNonEmptyString(note.reason, "reason");
  assertFingerprint(note[TRIGGER_FINGERPRINT_FIELD]);
  assertIsoTime(note.created_at, "created_at");
  return true;
}

function compareReplayPending(a, b) {
  const aObjectId = a.projectId || a.objectId || "";
  const bObjectId = b.projectId || b.objectId || "";
  return (
    String(a.startedAt).localeCompare(String(b.startedAt)) ||
    a.runId.localeCompare(b.runId) ||
    aObjectId.localeCompare(bObjectId)
  );
}

function normalizeGitIdentity(git) {
  if (!git || typeof git !== "object" || Array.isArray(git)) {
    throw new Error("mutation_intent_git_identity_required");
  }
  const normalized = {};
  for (const field of REQUIRED_GIT_IDENTITY_FIELDS) {
    requireNonEmptyString(git[field], field);
    normalized[field] = git[field];
  }
  if (typeof git.resource_id === "string" && git.resource_id.trim() !== "") {
    normalized.resource_id = git.resource_id.trim();
  }
  const hasHead = typeof git.head_sha === "string" && git.head_sha.trim() !== "";
  const hasTree = typeof git.tree_sha === "string" && git.tree_sha.trim() !== "";
  if (hasHead !== hasTree) {
    throw new Error("mutation_intent_git_observed_identity_incomplete");
  }
  if (hasHead && hasTree) {
    for (const field of OBSERVED_GIT_IDENTITY_FIELDS) {
      normalized[field] = git[field];
    }
  }
  return normalized;
}

function validateGitIdentity(git) {
  normalizeGitIdentity(git);
  return true;
}

function suppressionObjectIdentity({ projectId, objectType = "project", objectId = null }) {
  if (!MUTATION_INTENT_OBJECT_TYPES.has(objectType)) {
    throw new Error(`invalid_suppression_object_type:${objectType || "missing"}`);
  }
  if (objectType === "project") {
    const resolvedProjectId = projectId || objectId;
    requireNonEmptyString(resolvedProjectId, "projectId");
    return { objectType: "project", objectId: resolvedProjectId };
  }
  const resolvedObjectId = objectId || projectId;
  requireNonEmptyString(resolvedObjectId, "objectId");
  return { objectType: "issue", objectId: resolvedObjectId };
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
