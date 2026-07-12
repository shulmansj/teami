import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanStagedContent } from "../../git/staged-content-guard.mjs";

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-staged-guard-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Teami Test"]);
  git(root, ["config", "user.email", "teami@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

test("staged guard rejects secret-shaped paths and token-shaped staged blobs", async () => {
  const root = repoFixture();
  try {
    const fakeToken = ["github", "_pat_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].join("");
    fs.writeFileSync(path.join(root, ".env"), `GITHUB_TOKEN=${fakeToken}\n`);
    git(root, ["add", ".env"]);
    const result = await scanStagedContent({ runGit: runFixtureGit, workingDir: root });
    assert.equal(result.ok, false);
    assert.ok(result.report.findings.some((finding) => finding.rule === "secret_shaped_path"));
    assert.ok(result.report.findings.some((finding) => finding.rule === "token_shaped_content"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staged guard inspects type changes and rejects a regular file changed to a symlink", async () => {
  const root = repoFixture();
  try {
    fs.writeFileSync(path.join(root, "symlink-target.txt"), "outside-target\n");
    const blob = git(root, ["hash-object", "-w", "symlink-target.txt"]).stdout.trim();
    git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},tracked.txt`]);
    const status = git(root, ["diff", "--cached", "--name-status"]).stdout;
    assert.match(status, /^T\s+tracked\.txt/m);
    const result = await scanStagedContent({ runGit: runFixtureGit, workingDir: root });
    assert.equal(result.ok, false);
    assert.ok(result.report.findings.some((finding) => finding.path === "tracked.txt" && finding.rule === "symlink"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = runFixtureGit(args, { cwd });
  assert.equal(result.ok, true, result.stderr);
  return result;
}

function runFixtureGit(args, { cwd } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}
