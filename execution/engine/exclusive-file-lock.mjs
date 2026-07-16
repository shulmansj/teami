import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAndFsync } from "./atomic-file.mjs";

const OWNER_FILE = "owner.json";

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
    schema_version: "teami-exclusive-file-lock/v2",
    purpose,
    pid,
    token,
    acquired_at: new Date(now()).toISOString(),
  };
  void staleAfterMs;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      installCompleteLock({ lockPath, owner, fsApi });
      return lockHandle({ lockPath, owner, fsApi });
    } catch (error) {
      if (!isLockCollision(error)) throw error;
      const existing = readLockOwner(lockPath, fsApi);
      if (!isStaleOwner(existing, { isProcessAlive })) {
        return { ok: false, reason: "lock_held", owner: publicOwner(existing), lockPath };
      }
      if (!quarantineStaleLock({ lockPath, existing, fsApi })) {
        return { ok: false, reason: "lock_contended", owner: publicOwner(existing), lockPath };
      }
    }
  }
  return { ok: false, reason: "lock_contended", lockPath };
}

function installCompleteLock({ lockPath, owner, fsApi }) {
  const tempPath = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fsApi.mkdirSync(tempPath);
    writeFileAndFsync(path.join(tempPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      fsApi,
    });
    // Publishing a non-empty directory is atomic. A deterministic non-empty
    // quarantine directory also prevents a delayed stale reclaimer from moving
    // a fresh owner into the old owner's recovery slot.
    // Windows can replace a legacy file with a directory rename, so explicitly
    // preserve the old v1 file as a collision. A concurrently published v2
    // directory is non-empty and renameSync also rejects that replacement.
    try {
      fsApi.lstatSync(lockPath);
      const collision = new Error("exclusive_lock_exists");
      collision.code = "EEXIST";
      throw collision;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    fsApi.renameSync(tempPath, lockPath);
  } finally {
    fsApi.rmSync(tempPath, { recursive: true, force: true });
  }
}

function quarantineStaleLock({ lockPath, existing, fsApi }) {
  if (!existing?.token) return false;
  const digest = crypto.createHash("sha256").update(existing.token).digest("hex").slice(0, 24);
  const quarantinePath = `${lockPath}.stale-${digest}`;
  try {
    fsApi.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (isLockCollision(error) || error?.code === "ENOENT" || error?.code === "ENOTEMPTY") return false;
    throw error;
  }
  const quarantined = readLockOwner(quarantinePath, fsApi);
  if (quarantined?.token !== existing.token) {
    throw new Error("exclusive_lock_owner_changed_during_recovery");
  }
  // Keep the deterministic tombstone. It is the compare-and-swap witness that
  // makes every delayed reclaimer of this exact dead owner fail harmlessly.
  return true;
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
      return releaseOwnedLock({ lockPath, expectedToken: owner.token, fsApi });
    },
  };
}

function releaseOwnedLock({ lockPath, expectedToken, fsApi }) {
  const current = readLockOwner(lockPath, fsApi);
  if (!current || current.token !== expectedToken) return false;
  const digest = crypto.createHash("sha256").update(expectedToken).digest("hex").slice(0, 24);
  const releasedPath = `${lockPath}.released-${digest}`;
  try {
    // Rename moves only the verified owner's directory. A new owner may publish
    // immediately afterward without being touched by cleanup of releasedPath.
    fsApi.renameSync(lockPath, releasedPath);
  } catch {
    return false;
  }
  try {
    const moved = readLockOwner(releasedPath, fsApi);
    if (moved?.token !== expectedToken) return false;
    fsApi.rmSync(releasedPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(lockPath, fsApi) {
  try {
    const stat = fsApi.lstatSync(lockPath);
    const ownerPath = stat.isDirectory() ? path.join(lockPath, OWNER_FILE) : lockPath;
    return JSON.parse(fsApi.readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function isStaleOwner(owner, { isProcessAlive }) {
  if (!owner || typeof owner !== "object") return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    return isProcessAlive(owner.pid) === false;
  } catch {
    return false;
  }
}

function isLockCollision(error) {
  return ["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code);
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
