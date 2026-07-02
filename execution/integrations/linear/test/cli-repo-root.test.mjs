import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCliRepoRoot } from "../cli.mjs";

const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");

test("resolveCliRepoRoot binds the repo root from the launcher location, not the cwd", () => {
  const savedCwd = process.cwd();
  const savedOverride = process.env.FACTORY_REPO_ROOT;
  delete process.env.FACTORY_REPO_ROOT;
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "af-cli-root-"));
  try {
    process.chdir(elsewhere);
    // Running from a directory outside the repo must still bind the real repo root.
    assert.equal(resolveCliRepoRoot(), realRepoRoot);
    assert.notEqual(resolveCliRepoRoot(), path.resolve(elsewhere));
  } finally {
    process.chdir(savedCwd);
    if (savedOverride === undefined) delete process.env.FACTORY_REPO_ROOT;
    else process.env.FACTORY_REPO_ROOT = savedOverride;
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("resolveCliRepoRoot honors the FACTORY_REPO_ROOT override (test hook)", () => {
  const savedOverride = process.env.FACTORY_REPO_ROOT;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "af-cli-root-override-"));
  try {
    process.env.FACTORY_REPO_ROOT = scratch;
    assert.equal(resolveCliRepoRoot(), path.resolve(scratch));
  } finally {
    if (savedOverride === undefined) delete process.env.FACTORY_REPO_ROOT;
    else process.env.FACTORY_REPO_ROOT = savedOverride;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
