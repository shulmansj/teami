import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exclusive-lock-"));
  return { root, lockPath: path.join(root, "setup.lock") };
}

test("exclusive lock admits one owner and exposes no ownership token", () => {
  const { root, lockPath } = fixture();
  try {
    const first = acquireExclusiveFileLock({ lockPath, purpose: "setup" });
    assert.equal(first.ok, true);
    assert.equal(Object.hasOwn(first.owner, "token"), false);

    const second = acquireExclusiveFileLock({ lockPath, purpose: "setup" });
    assert.deepEqual(
      { ok: second.ok, reason: second.reason, purpose: second.owner?.purpose },
      { ok: false, reason: "lock_held", purpose: "setup" },
    );

    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    const afterRelease = acquireExclusiveFileLock({ lockPath, purpose: "setup" });
    assert.equal(afterRelease.ok, true);
    assert.equal(afterRelease.release(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive lock reclaims a dead owner but not a live owner", () => {
  const { root, lockPath } = fixture();
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: "teami-exclusive-file-lock/v1",
      purpose: "setup",
      pid: 4444,
      token: "old-owner",
      acquired_at: "2026-07-11T12:00:00.000Z",
    })}\n`);

    const held = acquireExclusiveFileLock({
      lockPath,
      purpose: "setup",
      now: () => Date.parse("2026-07-11T12:00:01.000Z"),
      isProcessAlive: () => true,
    });
    assert.equal(held.ok, false);
    assert.equal(held.reason, "lock_held");

    const reclaimed = acquireExclusiveFileLock({
      lockPath,
      purpose: "setup",
      now: () => Date.parse("2026-07-11T12:00:01.000Z"),
      isProcessAlive: () => false,
    });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.release(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive lock does not reclaim an over-age owner while its pid is live", () => {
  const { root, lockPath } = fixture();
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: "teami-exclusive-file-lock/v1",
      purpose: "setup",
      pid: 5555,
      token: "expired-owner",
      acquired_at: "2026-07-11T11:00:00.000Z",
    })}\n`);
    const held = acquireExclusiveFileLock({
      lockPath,
      purpose: "setup",
      staleAfterMs: 1_000,
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    assert.equal(held.ok, false);
    assert.equal(held.reason, "lock_held");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive lock fails closed when owner liveness is indeterminate", () => {
  const { root, lockPath } = fixture();
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: "teami-exclusive-file-lock/v1",
      purpose: "setup",
      pid: 6666,
      token: "unknown-owner",
      acquired_at: "2026-07-11T11:00:00.000Z",
    })}\n`);
    const held = acquireExclusiveFileLock({
      lockPath,
      purpose: "setup",
      staleAfterMs: 1_000,
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
      isProcessAlive: () => null,
    });
    assert.equal(held.ok, false);
    assert.equal(held.reason, "lock_held");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive lock publishes only a complete fsynced owner record", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-lock-atomic-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "setup.lock");
  const fsApi = Object.create(fs);
  fsApi.linkSync = () => {
    const error = new Error("simulated crash before atomic publish");
    error.code = "EIO";
    throw error;
  };

  assert.throws(
    () => acquireExclusiveFileLock({ lockPath, purpose: "setup", fsApi }),
    /simulated crash before atomic publish/,
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal(acquireExclusiveFileLock({ lockPath, purpose: "setup" }).ok, true);
});
