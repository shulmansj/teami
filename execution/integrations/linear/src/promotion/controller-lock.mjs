import fs from "node:fs";
import path from "node:path";

import { canonicalJson, readJsonTolerant } from "./registry-store.mjs";

export const PROMOTION_CONTROLLER_LOCK_SCHEMA_VERSION =
  "teami-promotion-controller-lock/v1";
export const DEFAULT_PROMOTION_CONTROLLER_LOCK_STALE_MS = 15 * 60 * 1000;

export function promotionControllerStateDirForRegistryDir(registryDir) {
  if (!registryDir) throw new Error("registryDir is required");
  return path.resolve(path.dirname(registryDir));
}

export function promotionControllerLockPath(stateDir) {
  return path.join(stateDir, "locks", "promotion-controller.lock");
}

export function acquirePromotionControllerLock({
  stateDir,
  now = () => new Date(),
  staleAfterMs = DEFAULT_PROMOTION_CONTROLLER_LOCK_STALE_MS,
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  const lockDir = path.dirname(promotionControllerLockPath(stateDir));
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = promotionControllerLockPath(stateDir);
  const acquiredAt = now();
  const writeLock = (staleRecovered = false) => {
    const handle = fs.openSync(lockPath, "wx");
    const record = {
      schema_version: PROMOTION_CONTROLLER_LOCK_SCHEMA_VERSION,
      pid: process.pid,
      acquired_at: acquiredAt.toISOString(),
      stale_after_ms: staleAfterMs,
      stale_recovered: staleRecovered,
    };
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    return {
      ok: true,
      lock_path: lockPath,
      record,
      release() {
        try {
          const current = readJsonTolerant(lockPath);
          if (current?.pid === process.pid && current?.acquired_at === record.acquired_at) {
            fs.rmSync(lockPath, { force: true });
          }
        } catch {
          // Best-effort release; do not hide the promotion result.
        }
      },
    };
  };

  try {
    return writeLock(false);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const current = readJsonTolerant(lockPath);
  let acquiredMs = current?.acquired_at ? new Date(current.acquired_at).getTime() : NaN;
  if (!Number.isFinite(acquiredMs)) {
    try {
      acquiredMs = fs.statSync(lockPath).mtime.getTime();
    } catch {
      acquiredMs = acquiredAt.getTime();
    }
  }
  if (acquiredAt.getTime() - acquiredMs > staleAfterMs) {
    const changedWhileChecking = (latest) => ({
      ok: false,
      reason: "promotion_in_progress",
      detail:
        "the promotion controller lock changed while stale-lock recovery was checking it; retry so a fresh owner is not clobbered.",
      lock_path: lockPath,
      owner: latest,
    });
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryHandle = null;
    try {
      recoveryHandle = fs.openSync(recoveryPath, "wx");
      fs.writeFileSync(recoveryHandle, `${JSON.stringify({
        schema_version: PROMOTION_CONTROLLER_LOCK_SCHEMA_VERSION,
        pid: process.pid,
        recovering_lock_path: lockPath,
        acquired_at: acquiredAt.toISOString(),
      }, null, 2)}\n`, "utf8");
    } catch (error) {
      if (recoveryHandle !== null) {
        try {
          fs.closeSync(recoveryHandle);
        } catch {
          // Best-effort close; the recovery lock is advisory.
        }
      }
      if (error.code !== "EEXIST") throw error;
      return changedWhileChecking(readJsonTolerant(lockPath));
    }
    try {
      const latest = readJsonTolerant(lockPath);
      if (canonicalJson(latest) !== canonicalJson(current)) {
        return changedWhileChecking(latest);
      }
      fs.rmSync(lockPath, { force: true });
      try {
        return writeLock(true);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        return changedWhileChecking(readJsonTolerant(lockPath));
      }
    } finally {
      try {
        if (recoveryHandle !== null) fs.closeSync(recoveryHandle);
      } catch {
        // Best-effort close; do not hide the lock result.
      }
      try {
        fs.rmSync(recoveryPath, { force: true });
      } catch {
        // Best-effort cleanup; a stale recovery lock only causes a retry.
      }
    }
  }
  return {
    ok: false,
    reason: "promotion_in_progress",
    detail:
      "another promotion controller owns the registry/workspace lock; retry after it exits or after the stale-lock window.",
    lock_path: lockPath,
    owner: current,
  };
}
