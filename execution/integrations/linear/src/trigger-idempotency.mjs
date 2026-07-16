import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  defaultRunStoreDir,
  readRunArtifact,
} from "../../../engine/run-store.mjs";
import {
  fsyncDirectoryAfterRename,
  writeAtomicJson,
} from "../../../engine/atomic-file.mjs";
import {
  computeProjectSnapshotHash,
  projectSnapshotProjection,
} from "./project-snapshot-store.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import {
  isLegacyTeamIdentityForRead,
  markLegacyTeamIdentityForRead,
  normalizeLegacyTeamIdentityForRead,
} from "../../../engine/legacy-team-state-compat.mjs";

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
  const fingerprintProject = project && typeof project === "object"
    ? { ...project, comments: undefined }
    : project;
  return computeProjectSnapshotHash(projectSnapshotProjection({
    project: fingerprintProject,
    semanticStatus,
  }));
}

export function listReplayPending({
  teamRef,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(teamRef, "teamRef");
  const dirPath = mutationIntentDir({ repoRoot, home, teamRef, runStoreDir });
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => replayPendingFromIntentPath({
      intentPath: path.join(dirPath, entry.name),
      teamRef,
      repoRoot,
      home,
      runStoreDir,
    }))
    .filter(Boolean)
    .filter((pending) => pending.objectType === "project")
    .sort(compareReplayPending)
    .map(({ startedAt, objectType, ...pending }) => pending);
}

export function listGitReplayPending({
  teamRef,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(teamRef, "teamRef");
  const dirPath = mutationIntentDir({ repoRoot, home, teamRef, runStoreDir });
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => replayPendingFromIntentPath({
      intentPath: path.join(dirPath, entry.name),
      teamRef,
      repoRoot,
      home,
      runStoreDir,
    }))
    .filter(Boolean)
    .filter((pending) => pending.objectType === "issue")
    .sort(compareReplayPending)
    .map(({ startedAt, objectType, ...pending }) => pending);
}

export function readReplayPending({
  teamRef,
  projectId,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(projectId, "projectId");
  return listReplayPending({ teamRef, repoRoot, home, runStoreDir })
    .find((pending) => pending.projectId === projectId) || null;
}

export function readGitReplayPending({
  teamRef,
  objectId,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(objectId, "objectId");
  return listGitReplayPending({ teamRef, repoRoot, home, runStoreDir })
    .find((pending) => pending.objectId === objectId) || null;
}

export async function replayPendingGitMutation({
  teamRef,
  objectId,
  pending = null,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
  applyGitMutationFn = null,
} = {}) {
  const target = pending || readGitReplayPending({ teamRef, objectId, repoRoot, home, runStoreDir });
  if (!target) return { action: "git_replay", status: "no_pending", cleared: false };
  if (target.objectType && target.objectType !== "issue") {
    return { action: "git_replay", status: "wrong_object_type", cleared: false };
  }
  if (typeof applyGitMutationFn !== "function") {
    return { action: "git_replay", status: "pending_no_executor", cleared: false, pending: target };
  }
  const resolvedObjectId = objectId || target.objectId;
  const result = await applyGitMutationFn({
    teamRef,
    objectId: resolvedObjectId,
    pending: target,
    repoRoot,
    home,
    runStoreDir,
  });
  return { action: "git_replay", status: "delegated", cleared: false, result, pending: target };
}

export function writeMutationIntent({
  teamRef,
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
  home = resolveTeamiHome(),
  runStoreDir = null,
  onBoundary = () => {},
} = {}) {
  const record = mutationIntentRecord({
    teamRef,
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
  const filePath = mutationIntentPath({ runId, repoRoot, home, teamRef, runStoreDir });
  writeJsonAtomic(filePath, record, { onBoundary });

  const readBack = readJsonFile(filePath);
  if (JSON.stringify(readBack) !== JSON.stringify(record)) {
    throw new Error("Mutation intent read-back validation failed.");
  }
  return record;
}

export function readMutationIntent({
  teamRef,
  runId,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(teamRef, "teamRef");
  assertSafeRunId(runId);
  const filePath = mutationIntentPath({ runId, repoRoot, home, teamRef, runStoreDir });
  if (!fs.existsSync(filePath)) return null;
  const record = readJsonFile(filePath);
  normalizeMutationIntent(record);
  return record;
}

export function mutationIntentDigest(record) {
  const normalized = normalizeMutationIntent(record);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function clearMutationIntent({
  teamRef,
  projectId,
  objectId = null,
  objectType = null,
  runId,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  requireNonEmptyString(teamRef, "teamRef");
  const expectedObjectId = objectId || projectId;
  requireNonEmptyString(expectedObjectId, objectType === "issue" ? "objectId" : "projectId");
  assertSafeRunId(runId);
  const filePath = mutationIntentPath({ runId, repoRoot, home, teamRef, runStoreDir });
  if (!fs.existsSync(filePath)) return { cleared: false };

  const existing = normalizeMutationIntent(readJsonFile(filePath));
  if (
    existing.team_ref !== teamRef ||
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
  teamRef = null,
  projectId,
  objectType = "project",
  objectId = null,
  fingerprint,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  const identity = suppressionObjectIdentity({ projectId, objectType, objectId });
  assertFingerprint(fingerprint);
  const filePath = suppressionPath({ projectId: identity.objectId, fingerprint, repoRoot, home, teamRef, runStoreDir });
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
  teamRef,
  projectId,
  objectType = "project",
  objectId = null,
  fingerprint,
  runId = null,
  terminalStatus,
  reason,
  createdAt,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runStoreDir = null,
} = {}) {
  const note = suppressionNote({
    teamRef,
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
  const filePath = suppressionPath({ projectId: identity.objectId, fingerprint, repoRoot, home, teamRef, runStoreDir });
  writeJsonAtomic(filePath, note);

  const readBack = readSuppression({
    teamRef,
    projectId,
    objectType,
    objectId,
    fingerprint,
    repoRoot,
    home,
    runStoreDir,
  });
  if (JSON.stringify(readBack) !== JSON.stringify(note)) {
    throw new Error("Trigger suppression read-back validation failed.");
  }
  return note;
}

function replayPendingFromIntentPath({ intentPath, teamRef, repoRoot, home, runStoreDir }) {
  const intent = normalizeMutationIntent(readJsonFile(intentPath));
  if (intent.team_ref !== teamRef) return null;
  if (!REPLAYABLE_ARTIFACT_KINDS.has(intent.artifact_kind)) return null;

  if (intent.object_type === "issue") {
    return {
      objectType: "issue",
      teamRef: intent.team_ref,
      objectId: intent.object_id,
      runId: intent.run_id,
      artifactKind: intent.artifact_kind,
      git: intent.git,
      startedAt: intent.started_at,
    };
  }

  const artifact = readRunArtifact({ runId: intent.run_id, repoRoot, home, teamRef, runStoreDir });
  if (!artifact) throw new Error(`mutation_intent_missing_run_artifact:${intent.run_id}`);
  if (artifact.team_ref !== teamRef) throw new Error(`mutation_intent_artifact_team_mismatch:${intent.run_id}`);
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
    teamRef: intent.team_ref,
    projectId: intent.linear_project_id,
    runId: intent.run_id,
    artifactKind: intent.artifact_kind,
    startedAt: intent.started_at,
  };
}

function mutationIntentRecord({
  teamRef,
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
  requireNonEmptyString(teamRef, "teamRef");
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
    team_ref: teamRef,
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
  requireNonEmptyString(record.team_ref, "team_ref");
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
  let normalized;
  if (record.schema_version === UNCONFIRMED_LINEAR_MUTATION_INTENT_SCHEMA_VERSION_V1) {
    normalized = {
      object_type: "project",
      object_id: record.linear_project_id,
      linear_project_id: record.linear_project_id,
      workflow_type: PROJECT_WORKFLOW_TYPE,
      trigger_type: PROJECT_TRIGGER_TYPE,
      team_ref: record.team_ref,
      run_id: record.run_id,
      artifact_kind: record.artifact_kind,
      wake_id: record.wake_id,
      started_at: record.started_at,
      git: null,
    };
  } else {
    normalized = {
      object_type: record.object_type,
      object_id: record.object_id,
      linear_project_id: record.object_type === "project" ? record.object_id : null,
      workflow_type: record.workflow_type,
      trigger_type: record.trigger_type,
      team_ref: record.team_ref,
      run_id: record.run_id,
      artifact_kind: record.artifact_kind,
      wake_id: record.wake_id,
      started_at: record.started_at,
      git: record.object_type === "issue" ? record.git : null,
    };
  }
  return isLegacyTeamIdentityForRead(record)
    ? markLegacyTeamIdentityForRead(normalized)
    : normalized;
}

function suppressionNote({
  teamRef,
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
  requireNonEmptyString(teamRef, "teamRef");
  assertFingerprint(fingerprint);
  if (runId !== null) assertSafeRunId(runId);
  requireNonEmptyString(terminalStatus, "terminalStatus");
  requireNonEmptyString(reason, "reason");
  assertIsoTime(createdAt, "createdAt");
  const note = identity.objectType === "project"
    ? {
        project_id: identity.objectId,
        team_ref: teamRef,
        run_id: runId,
        terminal_status: terminalStatus,
        reason,
        [TRIGGER_FINGERPRINT_FIELD]: fingerprint,
        created_at: createdAt,
      }
    : {
        object_type: identity.objectType,
        object_id: identity.objectId,
        team_ref: teamRef,
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
  requireNonEmptyString(note.team_ref, "team_ref");
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

function mutationIntentPath({ runId, repoRoot, home, teamRef, runStoreDir }) {
  assertSafeRunId(runId);
  return path.join(mutationIntentDir({ repoRoot, home, teamRef, runStoreDir }), `${runId}.json`);
}

function mutationIntentDir({ repoRoot, home, teamRef, runStoreDir }) {
  return path.join(runCustodyDir({ repoRoot, home, teamRef, runStoreDir }), "unconfirmed-linear-mutation-intents");
}

function suppressionPath({ projectId, fingerprint, repoRoot, home, teamRef, runStoreDir }) {
  requireNonEmptyString(projectId, "projectId");
  assertFingerprint(fingerprint);
  return path.join(
    suppressionDir({ repoRoot, home, teamRef, runStoreDir }),
    `${contentAddress(projectId)}.${fingerprint}.json`,
  );
}

function suppressionDir({ repoRoot, home, teamRef, runStoreDir }) {
  return path.join(runCustodyDir({ repoRoot, home, teamRef, runStoreDir }), "trigger-suppressions");
}

function runCustodyDir({ repoRoot, home = resolveTeamiHome(), teamRef, runStoreDir }) {
  void repoRoot;
  return path.resolve(runStoreDir || defaultRunStoreDir({ home, teamRef }));
}

function writeJsonAtomic(filePath, value, { onBoundary = () => {} } = {}) {
  writeAtomicJson({ filePath, value, onBoundary });
}

function readJsonFile(filePath) {
  return normalizeLegacyTeamIdentityForRead(JSON.parse(fs.readFileSync(filePath, "utf8")));
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
