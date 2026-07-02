import fs from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../../../engine/run-store.mjs";

export const LOCAL_SUPERVISOR_STATE_SCHEMA_VERSION =
  "teami-local-supervisor-state/v1";

export function localSupervisorDir(repoRoot = process.cwd()) {
  return path.join(repoRoot, ".teami", "supervisor");
}

export function localSupervisorRegistrationPath(repoRoot = process.cwd()) {
  return path.join(localSupervisorDir(repoRoot), "registration.json");
}

export function localSupervisorStatePath(repoRoot = process.cwd()) {
  return path.join(localSupervisorDir(repoRoot), "state.json");
}

export function localSupervisorDisablePath(repoRoot = process.cwd()) {
  return path.join(localSupervisorDir(repoRoot), "disabled.json");
}

function readSupervisorState({ repoRoot = process.cwd() } = {}) {
  const statePath = localSupervisorStatePath(repoRoot);
  const state = readJsonIfExists(statePath);
  if (!state) return { ok: false, reason: "missing_local_supervisor_state", state_path: statePath };
  if (state.schema_version !== LOCAL_SUPERVISOR_STATE_SCHEMA_VERSION) {
    return { ok: false, reason: "invalid_local_supervisor_state", state_path: statePath };
  }
  return { ok: true, state, state_path: statePath };
}

function writeSupervisorState({ repoRoot = process.cwd(), now = () => new Date(), patch }) {
  const statePath = localSupervisorStatePath(repoRoot);
  const existing = readSupervisorState({ repoRoot });
  const observedAt = now().toISOString();
  const state = {
    schema_version: LOCAL_SUPERVISOR_STATE_SCHEMA_VERSION,
    status: "unknown",
    created_at: observedAt,
    updated_at: observedAt,
    crash_loop: {
      consecutive_failure_count: 0,
      next_allowed_start_at: null,
      last_error: null,
    },
    ...(existing.ok ? existing.state : {}),
    ...patch,
    updated_at: observedAt,
  };
  writeJsonAtomic(statePath, state);
  return state;
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameWithRetry(tempPath, filePath);
  JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function removePathIfExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

export {
  envFlag,
  readJsonIfExists,
  readSupervisorState,
  removePathIfExists,
  writeJsonAtomic,
  writeSupervisorState,
};
