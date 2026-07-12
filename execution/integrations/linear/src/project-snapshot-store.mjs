import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultRunStoreDir, renameWithRetry } from "../../../engine/run-store.mjs";
import { resolveTeamiHome } from "./app-home.mjs";

// Local, gitignored plumbing for the future rich dataset promotion step.
// A decomposition run captures the exact Linear project context it ran against
// into `.teami/runs/<run_id>.snapshot.json` (a sibling of the run
// artifact, never inside it). Rich promotion must consume this captured-at-run
// snapshot (or an explicitly supplied one) and must NEVER pull live Linear
// state at promotion time; when no snapshot exists the loader returns a typed
// missing-snapshot result so promotion fails closed. docs/operating-model.md#state-model
// owns the state authority for this rule.
// The snapshot is never written to Phoenix and never committed.
export const PROJECT_SNAPSHOT_SCHEMA_VERSION = "linear-decomposition-project-snapshot/v1";
export const PROJECT_SNAPSHOT_CAPTURE_SOURCES = Object.freeze([
  // Captured from the Linear project context loaded at decomposition-run time.
  "linear_run_context",
  // Eval-mode run over a memory/offline snapshot: the supplied snapshot IS the capture.
  "eval_mode_memory_snapshot",
]);

const SUPPORTED_PROJECT_SNAPSHOT_SCHEMA_VERSIONS = new Set([PROJECT_SNAPSHOT_SCHEMA_VERSION]);
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function projectSnapshotPath({
  runId,
  repoRoot = null,
  home = resolveTeamiHome(),
  domainId = null,
  runStoreDir,
} = {}) {
  void repoRoot;
  if (!runId || typeof runId !== "string") {
    throw new Error("run_id is required for the local project snapshot store.");
  }
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run_id for local project snapshot store: ${runId}`);
  }
  // Same custody directory as run artifacts. `<runId>.snapshot.json` cannot
  // collide with another run's `<runId>.json` because run ids cannot contain dots.
  return path.join(runStoreDir || defaultRunStoreDir({ home, domainId }), `${runId}.snapshot.json`);
}

// Deterministic JSON serialization (recursively sorted object keys) so the
// snapshot hash is stable across key insertion order and process runs.
export function canonicalJsonStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`).join(",")}}`;
}

export function computeProjectSnapshotHash(snapshotProject) {
  return createHash("sha256").update(canonicalJsonStringify(snapshotProject), "utf8").digest("hex");
}

// Bounded projection of a Linear project context into the `input.project`
// shape of execution/evals/decomposition/example.schema.json (id, name,
// content, semantic status, labels, existing issues summary).
export function projectSnapshotProjection({ project = {}, semanticStatus = null } = {}) {
  return {
    id: project.id || null,
    name: project.name || null,
    description: typeof project.description === "string" ? project.description : null,
    ...(Array.isArray(project.comments)
      ? { comments: project.comments.map(agentVisibleProjectComment) }
      : {}),
    content: typeof project.content === "string" ? project.content : "",
    status: semanticStatus || project.status?.name || project.status?.type || null,
    labels: (project.labels || []).map((label) => ({
      id: label?.id ?? null,
      name: label?.name ?? null,
    })),
    existing_issues: (project.issues || []).map((issue) => ({
      id: issue?.id ?? null,
      identifier: issue?.identifier ?? null,
      title: issue?.title ?? null,
      state: issue?.state
        ? {
            id: issue.state.id ?? null,
            name: issue.state.name ?? null,
            type: issue.state.type ?? null,
          }
        : null,
      labels: (issue?.labels || []).map((label) => ({
        id: label?.id ?? null,
        name: label?.name ?? null,
      })),
    })),
  };
}

function agentVisibleProjectComment(comment) {
  return {
    author_id: comment?.author_id ?? comment?.user?.id ?? null,
    body: typeof comment?.body === "string" ? comment.body : "",
    created_at: comment?.created_at ?? comment?.createdAt ?? null,
  };
}

export function buildProjectSnapshot({
  runId,
  project,
  semanticStatus = null,
  captureSource = "linear_run_context",
  capturedAt = new Date().toISOString(),
} = {}) {
  const snapshotProject = projectSnapshotProjection({ project, semanticStatus });
  return {
    schema_version: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    run_id: runId,
    captured_at: capturedAt,
    capture_source: captureSource,
    snapshot_hash: computeProjectSnapshotHash(snapshotProject),
    project: snapshotProject,
  };
}

export function projectSnapshotValidationFailures(snapshot) {
  const failures = [];
  if (!snapshot || typeof snapshot !== "object") return ["snapshot_not_object"];
  if (!SUPPORTED_PROJECT_SNAPSHOT_SCHEMA_VERSIONS.has(snapshot.schema_version)) {
    failures.push("unsupported_project_snapshot_schema_version");
  }
  if (!snapshot.run_id) failures.push("missing_run_id");
  else if (!SAFE_RUN_ID_PATTERN.test(snapshot.run_id)) failures.push("invalid_run_id");
  if (typeof snapshot.captured_at !== "string" || Number.isNaN(Date.parse(snapshot.captured_at))) {
    failures.push("invalid_captured_at");
  }
  if (!PROJECT_SNAPSHOT_CAPTURE_SOURCES.includes(snapshot.capture_source)) {
    failures.push("invalid_capture_source");
  }
  if (typeof snapshot.snapshot_hash !== "string" || !SNAPSHOT_HASH_PATTERN.test(snapshot.snapshot_hash)) {
    failures.push("invalid_snapshot_hash");
  }
  const project = snapshot.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    failures.push("missing_project");
  } else {
    if (!project.id || typeof project.id !== "string") failures.push("missing_project_id");
    if (!project.name || typeof project.name !== "string") failures.push("missing_project_name");
    if (typeof project.content !== "string") failures.push("missing_project_content");
    if (!project.status || typeof project.status !== "string") failures.push("missing_project_status");
    if (!Array.isArray(project.labels)) failures.push("missing_project_labels");
    if (!Array.isArray(project.existing_issues)) failures.push("missing_existing_issues");
    if (
      typeof snapshot.snapshot_hash === "string" &&
      SNAPSHOT_HASH_PATTERN.test(snapshot.snapshot_hash) &&
      computeProjectSnapshotHash(project) !== snapshot.snapshot_hash
    ) {
      failures.push("snapshot_hash_mismatch");
    }
  }
  return [...new Set(failures)];
}

export function validateProjectSnapshot(snapshot) {
  const failures = projectSnapshotValidationFailures(snapshot);
  if (failures.length > 0) {
    throw new Error(`Invalid project snapshot: ${failures.join(", ")}`);
  }
  return true;
}

// Schema-versioned, read-back-validated atomic write, mirroring the run-store
// convention. The run artifact schema itself stays at
// linear-decomposition-run-artifact/v1: the snapshot is a sibling local file
// with its own schema id, not a new run-artifact field.
export function writeProjectSnapshot(options = {}, snapshot) {
  const filePath = projectSnapshotPath(options);
  validateProjectSnapshot(snapshot);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  validateProjectSnapshot(JSON.parse(fs.readFileSync(tempPath, "utf8")));
  renameWithRetry(tempPath, filePath);

  const readBack = loadCapturedProjectSnapshot(options.runId, options);
  if (!readBack.ok || JSON.stringify(readBack.snapshot) !== JSON.stringify(snapshot)) {
    throw new Error("Project snapshot read-back validation failed.");
  }
  return filePath;
}

export function captureProjectSnapshot({
  runId,
  project,
  semanticStatus = null,
  captureSource = "linear_run_context",
  capturedAt = new Date().toISOString(),
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  domainId = null,
  runStoreDir = null,
} = {}) {
  const snapshot = buildProjectSnapshot({ runId, project, semanticStatus, captureSource, capturedAt });
  const filePath = writeProjectSnapshot({ runId, repoRoot, home, domainId, runStoreDir }, snapshot);
  return { snapshot, path: filePath };
}

// Pure local loader for the later rich-promotion step. Reads ONLY the local
// snapshot store; there is intentionally no live-Linear fallback of any kind
// (docs/operating-model.md#state-model: rich promotion fails closed on a
// missing snapshot).
export function loadCapturedProjectSnapshot(runId, {
  repoRoot = null,
  home = resolveTeamiHome(),
  domainId = null,
  runStoreDir = null,
} = {}) {
  let filePath;
  try {
    filePath = projectSnapshotPath({ runId, repoRoot, home, domainId, runStoreDir });
  } catch (error) {
    return { ok: false, reason: "invalid_run_id", run_id: runId ?? null, error: error.message };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: "missing_project_snapshot", run_id: runId, path: filePath };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {
      ok: false,
      reason: "invalid_project_snapshot",
      run_id: runId,
      path: filePath,
      failures: ["unparseable_snapshot_json"],
    };
  }
  const failures = projectSnapshotValidationFailures(parsed);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: failures.includes("snapshot_hash_mismatch")
        ? "snapshot_hash_mismatch"
        : "invalid_project_snapshot",
      run_id: runId,
      path: filePath,
      failures,
    };
  }
  return { ok: true, run_id: runId, path: filePath, snapshot: parsed };
}
