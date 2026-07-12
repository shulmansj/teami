import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  writeAtomicFile,
  writeAtomicJson,
} from "../../../engine/atomic-file.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-atomic-file-"));
}

test("atomic JSON writes validate and read back committed content", () => {
  const root = tempRoot();
  const filePath = path.join(root, "state", "record.json");
  try {
    const result = writeAtomicJson({
      filePath,
      value: { schema_version: "fixture/v1", ok: true },
      validate(value) {
        assert.equal(value.schema_version, "fixture/v1");
      },
    });
    assert.equal(result.written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
      schema_version: "fixture/v1",
      ok: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const boundary of [
  "before_temp_write",
  "after_temp_fsync",
  "after_temp_validation",
  "after_rename",
  "after_directory_fsync",
  "after_committed_validation",
]) {
  test(`atomic write leaves a recoverable state when interrupted at ${boundary}`, () => {
    const root = tempRoot();
    const filePath = path.join(root, "state.json");
    try {
      assert.throws(() => writeAtomicFile({
        filePath,
        contents: '{"ok":true}\n',
        validateTemp(candidatePath) {
          assert.deepEqual(JSON.parse(fs.readFileSync(candidatePath, "utf8")), { ok: true });
        },
        validateCommitted(candidatePath) {
          assert.deepEqual(JSON.parse(fs.readFileSync(candidatePath, "utf8")), { ok: true });
        },
        onBoundary(name) {
          if (name === boundary) throw new Error(`fault:${boundary}`);
        },
      }), new RegExp(`fault:${boundary}`));

      const renamed = ["after_rename", "after_directory_fsync", "after_committed_validation"].includes(boundary);
      assert.equal(fs.existsSync(filePath), renamed);
      if (renamed) assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { ok: true });
      const leftovers = fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Windows durability fallback flushes the committed file after rename", () => {
  const root = tempRoot();
  const filePath = path.join(root, "state.json");
  try {
    const result = writeAtomicFile({
      filePath,
      contents: "ready\n",
      platform: "win32",
    });
    assert.equal(result.directoryFsynced, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "ready\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
