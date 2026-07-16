import fs from "node:fs";
import path from "node:path";

import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";

export const TEAM_OPERATION_LOCK_RELATIVE_PATH = "team-operation.lock";

export function teamOperationLockPath(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, TEAM_OPERATION_LOCK_RELATIVE_PATH);
}

// Short-lived authority for non-gateway Linear reads that may refresh credentials
// and for explicit planning/review mutations. The gateway deliberately does not
// hold this lock: adopters must be able to plan while the listener is running.
// Destructive lifecycle operations reserve both this lock and the gateway lock.
export function acquireTeamOperationLock({
  home = resolveTeamiHome(),
  lockPath = teamOperationLockPath(home),
  now = () => Date.now(),
  isProcessAlive = undefined,
  fsApi = fs,
  pid = process.pid,
  acquireLock = acquireExclusiveFileLock,
} = {}) {
  return acquireLock({
    lockPath,
    purpose: "team-operation",
    now,
    pid,
    ...(isProcessAlive ? { isProcessAlive } : {}),
    fsApi,
  });
}
