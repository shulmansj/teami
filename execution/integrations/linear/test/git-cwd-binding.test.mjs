import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  materializeDomainResources,
} from "../../../engine/materialize.mjs";
import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";
import {
  runRuntimeCommand,
} from "../src/runtime-command.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("runtime command cwd is bound to the materialized git worktree handle", async () => {
  resetResourceRegistry();
  registerGitRepoResourceKind();

  const tempSource = fs.mkdtempSync(path.join(os.tmpdir(), "git-cwd-binding-source-"));
  const gitResource = {
    id: "git_repo",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "acme",
      repo: "app",
      default_branch: "main",
      local_checkout_path: tempSource,
    },
  };
  const fakeRunGit = (args, { cwd } = {}) => {
    if (isGitCommand(args, ["status", "--porcelain"])) {
      assert.equal(path.resolve(cwd), path.resolve(tempSource));
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }
    if (isGitCommand(args, ["worktree", "add", "--detach"])) {
      assert.equal(path.resolve(cwd), path.resolve(tempSource));
      assert.equal(args[4], "main");
      fs.mkdirSync(args[3], { recursive: true });
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }
    if (isGitCommand(args, ["rev-parse", "HEAD"])) {
      assert.notEqual(path.resolve(cwd), path.resolve(tempSource));
      return { ok: true, status: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
    }
    if (isGitCommand(args, ["worktree", "remove", "--force"])) {
      assert.equal(path.resolve(cwd), path.resolve(tempSource));
      fs.rmSync(args[3], { recursive: true, force: true });
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }
    return {
      ok: false,
      status: 1,
      stdout: "",
      stderr: `unexpected git command: ${args.join(" ")}`,
    };
  };
  let teardownAll = async () => {};

  try {
    const { runContext, teardownAll: materializedTeardownAll } = await materializeDomainResources({
      domainResources: [gitResource],
      runId: "probe-run",
      engineRepoRoot: REPO_ROOT,
      runGit: fakeRunGit,
    });
    teardownAll = materializedTeardownAll;
    const workingDir = runContext.resources.git_repo.handle.workingDir;

    await runRuntimeCommand(
      { command: process.execPath, args: ["-e", "require('fs').writeFileSync('probe.txt','x')"] },
      { cwd: workingDir },
    );

    assert.equal(fs.existsSync(path.join(workingDir, "probe.txt")), true);
    assert.equal(fs.existsSync(path.join(tempSource, "probe.txt")), false);
    assert.equal(path.resolve(workingDir).startsWith(path.resolve(tempSource) + path.sep), false);

    const engineRuntimeUrl = new URL("../../../engine/runtime-environment.mjs", import.meta.url);
    const engineRuntimePath = path.resolve(fileURLToPath(engineRuntimeUrl));
    assert.equal(fs.existsSync(engineRuntimeUrl), true);
    assert.equal(engineRuntimePath.startsWith(path.resolve(workingDir) + path.sep), false);
  } finally {
    await teardownAll();
    fs.rmSync(tempSource, { recursive: true, force: true });
    resetResourceRegistry();
  }
});

function isGitCommand(args, expectedPrefix) {
  return expectedPrefix.every((part, index) => args[index] === part);
}
