import fs from "node:fs";

import {
  canonicalJson,
  promotionScannerLockPath,
  readJsonTolerant,
} from "./ledger-store.mjs";

export const PROMOTION_SCANNER_LOCK_SCHEMA_VERSION =
  "agentic-factory-promotion-scanner-lock/v1";
export const DEFAULT_SCANNER_LOCK_STALE_MS = 15 * 60 * 1000;

export function acquirePromotionCandidateScannerLock({
  ledgerDir,
  now = () => new Date(),
  staleAfterMs = DEFAULT_SCANNER_LOCK_STALE_MS,
} = {}) {
  if (!ledgerDir) throw new Error("ledgerDir is required");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const lockPath = promotionScannerLockPath(ledgerDir);
  const acquiredAt = now();
  const writeLock = (staleRecovered = false) => {
    const handle = fs.openSync(lockPath, "wx");
    const record = {
      schema_version: PROMOTION_SCANNER_LOCK_SCHEMA_VERSION,
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
          // A best-effort lock release should not hide the scan result.
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
    const latest = readJsonTolerant(lockPath);
    if (canonicalJson(latest) !== canonicalJson(current)) {
      return {
        ok: false,
        reason: "scanner_lock_held",
        detail:
          "the scanner lock changed while stale-lock recovery was checking it; retry so a fresh owner is not clobbered.",
        lock_path: lockPath,
        owner: latest,
      };
    }
    fs.rmSync(lockPath, { force: true });
    try {
      return writeLock(true);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return {
    ok: false,
    reason: "scanner_lock_held",
    detail:
      "another foreground/supervisor scanner owns the promotion-candidates ledger lock; retry after that scan exits or after the stale-lock window.",
    lock_path: lockPath,
    owner: current,
  };
}
