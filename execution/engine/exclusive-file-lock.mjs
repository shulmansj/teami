import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAndFsync } from "./atomic-file.mjs";

export function acquireExclusiveFileLock({
  lockPath,
  purpose,
  staleAfterMs = 30 * 60 * 1000,
  now = () => Date.now(),
  pid = process.pid,
  isProcessAlive = processIsAlive,
  fsApi = fs,
} = {}) {
  if (typeof lockPath !== "string" || lockPath.trim() === "") throw new Error("lock_path_required");
  if (typeof purpose !== "string" || purpose.trim() === "") throw new Error("lock_purpose_required");
  fsApi.mkdirSync(path.dirname(lockPath), { recursive: true });

  const token = crypto.randomBytes(18).toString("base64url");
  const owner = {
    schema_version: "teami-exclusive-file-lock/v1",
    purpose,
    pid,
    token,
    acquired_at: new Date(now()).toISOString(),
  };

  // Kept as an accepted option for caller compatibility. Lock age is useful
  // diagnostic context, but it cannot distinguish a long-running owner from a
  // reused PID and therefore is not authority to steal a lock.
  void staleAfterMs;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      installCompleteLock({ lockPath, owner, fsApi });
      return lockHandle({ lockPath, owner, fsApi });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLockOwner(lockPath, fsApi);
      if (!isStaleOwner(existing, { isProcessAlive })) {
        return { ok: false, reason: "lock_held", owner: publicOwner(existing), lockPath };
      }
      removeLockIfOwnerMatches({ lockPath, expectedToken: existing?.token, fsApi });
    }
  }
  return { ok: false, reason: "lock_contended", lockPath };
}

function installCompleteLock({ lockPath, owner, fsApi }) {
  const tempPath = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileAndFsync(tempPath, `${JSON.stringify(owner)}\n`, { flag: "wx", fsApi });
    // A hard link publishes the already-fsynced inode only if lockPath does not
    // exist. Competing acquirers therefore observe either no lock or one complete
    // owner record, never the partial file left by a crash between open and write.
    fsApi.linkSync(tempPath, lockPath);
  } finally {
    fsApi.rmSync(tempPath, { force: true });
  }
}

function lockHandle({ lockPath, owner, fsApi }) {
  let released = false;
  return {
    ok: true,
    lockPath,
    owner: publicOwner(owner),
    release() {
      if (released) return false;
      released = true;
      return removeLockIfOwnerMatches({ lockPath, expectedToken: owner.token, fsApi });
    },
  };
}

function readLockOwner(lockPath, fsApi) {
  try {
    return JSON.parse(fsApi.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function isStaleOwner(owner, { isProcessAlive }) {
  if (!owner || typeof owner !== "object") return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;

  let alive;
  try {
    alive = isProcessAlive(owner.pid);
  } catch {
    return false;
  }

  // Only a process proven absent makes the lock reclaimable. A live PID may be
  // the original owner or a reused PID; without a process-birth identity the
  // safe answer in both cases is to retain the lock. Unknown liveness likewise
  // fails closed instead of risking two concurrent owners.
  return alive === false;
}

function removeLockIfOwnerMatches({ lockPath, expectedToken, fsApi }) {
  const current = readLockOwner(lockPath, fsApi);
  if (!current || current.token !== expectedToken) return false;
  fsApi.rmSync(lockPath, { force: true });
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

function publicOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  return {
    purpose: owner.purpose || null,
    pid: Number.isInteger(owner.pid) ? owner.pid : null,
    acquired_at: owner.acquired_at || null,
  };
}
