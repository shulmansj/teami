import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getResourceKind,
  registeredResourceKinds,
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  gitRepoResourceKind,
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("registerGitRepoResourceKind registers the git_repo definition", () => {
  resetResourceRegistry();
  try {
    registerGitRepoResourceKind();

    assert.deepEqual(registeredResourceKinds(), ["git_repo"]);
    assert.equal(getResourceKind("git_repo"), gitRepoResourceKind);
  } finally {
    resetResourceRegistry();
  }
});

test("git_repo validateBinding accepts a complete binding and rejects each required missing field", () => {
  resetResourceRegistry();
  try {
    registerGitRepoResourceKind();
    const definition = getResourceKind("git_repo");
    const binding = goodBinding({ local_checkout_path: "<local-checkout-path>" });

    assert.doesNotThrow(() => definition.validateBinding(binding));
    for (const field of ["owner", "repo", "default_branch", "local_checkout_path"]) {
      assert.throws(
        () => definition.validateBinding({ ...binding, [field]: "" }),
        { message: `git_repo_binding_missing_${field}` },
      );
    }
  } finally {
    resetResourceRegistry();
  }
});

test("git_repo materialize creates a detached worktree from the bound local_checkout_path", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-git-repo-materializer-"));
  const runId = uniqueRunId("materialize");
  let result = null;
  t.after(async () => {
    try {
      if (result) await result.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  registerGitRepoResourceKind();
  const source = path.join(tempRoot, "bound-repo");
  fs.mkdirSync(source, { recursive: true });
  const { runGit, calls } = fakeRunGit();
  const resource = gitRepoResource({ local_checkout_path: source });

  result = await getResourceKind("git_repo").materialize(resource, {
    runId,
    runGit,
  });

  assert.equal(result.kind, "git_repo");
  assert.deepEqual(Object.keys(result.handle).sort(), ["baseSha", "workingDir"]);
  assert.equal(result.handle.baseSha, SHA);
  assert.ok(path.isAbsolute(result.handle.workingDir));
  assert.ok(fs.existsSync(result.handle.workingDir), "fake worktree add should create the working dir");
  assert.equal(path.dirname(path.dirname(result.handle.workingDir)), tempWorktreeBase());
  assert.equal(pathInside(result.handle.workingDir, source), false);

  assert.deepEqual(commandCalls(calls), [
    { args: ["status", "--porcelain"], cwd: source },
    { args: ["worktree", "add", "--detach", result.handle.workingDir, "main"], cwd: source },
    { args: ["rev-parse", "HEAD"], cwd: result.handle.workingDir },
  ]);
});

test("git_repo materialize fails closed on a dirty source before creating a worktree", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-git-repo-dirty-"));
  const runId = uniqueRunId("dirty");
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    cleanupRunDir(runId);
  });

  registerGitRepoResourceKind();
  const source = path.join(tempRoot, "bound-repo");
  fs.mkdirSync(source, { recursive: true });
  const { runGit, calls } = fakeRunGit({ dirtyStatus: " M src/app.js\n" });

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(gitRepoResource({ local_checkout_path: source }), { runId, runGit }),
    { message: "git_repo_source_dirty" },
  );

  assert.deepEqual(commandCalls(calls), [{ args: ["status", "--porcelain"], cwd: source }]);
  assert.equal(fs.existsSync(path.join(tempWorktreeBase(), runId)), false);
});

test("git_repo teardown is idempotent and removes the worktree", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-git-repo-teardown-"));
  const runId = uniqueRunId("teardown");
  let result = null;
  t.after(async () => {
    try {
      if (result) await result.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  registerGitRepoResourceKind();
  const source = path.join(tempRoot, "bound-repo");
  fs.mkdirSync(source, { recursive: true });
  const { runGit, calls } = fakeRunGit();

  result = await getResourceKind("git_repo").materialize(gitRepoResource({ local_checkout_path: source }), {
    runId,
    runGit,
  });

  await result.teardown();
  await result.teardown();

  const cleanupCalls = calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "remove");
  assert.equal(cleanupCalls.length, 1);
  assert.deepEqual(cleanupCalls[0], {
    args: ["worktree", "remove", "--force", result.handle.workingDir],
    cwd: source,
  });
  assert.equal(fs.existsSync(result.handle.workingDir), false);
});

test("git_repo materialize cleans up if a post-worktree step fails", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-git-repo-failure-"));
  const runId = uniqueRunId("failure");
  let calls = [];
  t.after(() => {
    cleanupWorktreeDirs(calls);
    cleanupRunDir(runId);
    resetResourceRegistry();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  registerGitRepoResourceKind();
  const source = path.join(tempRoot, "bound-repo");
  fs.mkdirSync(source, { recursive: true });
  const fake = fakeRunGit({ failHeadRevParse: true });
  const runGit = fake.runGit;
  calls = fake.calls;

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(gitRepoResource({ local_checkout_path: source }), { runId, runGit }),
    /git_repo_base_sha_failed:bad HEAD/,
  );

  const addCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  const cleanupCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "remove");
  assert.ok(addCall, "expected worktree add before the failure");
  assert.ok(cleanupCall, "expected cleanup after the failure");
  assert.equal(cleanupCall.cwd, source);
  assert.equal(cleanupCall.args[3], addCall.args[3]);
  assert.equal(fs.existsSync(addCall.args[3]), false);
});

test("git_repo materialize cleans up if worktree add creates a directory then fails", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-git-repo-add-failure-"));
  const runId = uniqueRunId("add-failure");
  let calls = [];
  t.after(() => {
    cleanupWorktreeDirs(calls);
    cleanupRunDir(runId);
    resetResourceRegistry();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  registerGitRepoResourceKind();
  const source = path.join(tempRoot, "bound-repo");
  fs.mkdirSync(source, { recursive: true });
  const fake = fakeRunGit({ failWorktreeAddAfterCreate: true });
  const runGit = fake.runGit;
  calls = fake.calls;

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(gitRepoResource({ local_checkout_path: source }), { runId, runGit }),
    /git_repo_worktree_add_failed:add failed/,
  );

  const addCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  const cleanupCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "remove");
  assert.ok(addCall, "expected worktree add before the failure");
  assert.ok(cleanupCall, "expected cleanup after the failed add");
  assert.equal(cleanupCall.args[3], addCall.args[3]);
  assert.equal(fs.existsSync(addCall.args[3]), false);
});

test("git_repo manifestEntry returns serializable label facts without baseSha", () => {
  const resource = gitRepoResource({
    owner: "acme",
    repo: "portal",
    role: "primary",
    id: "repo-1",
    local_checkout_path: "<local-checkout-path>",
  });

  assert.deepEqual(gitRepoResourceKind.manifestEntry(resource, { baseSha: SHA }), {
    kind: "git_repo",
    id: "repo-1",
    role: "primary",
    label: "acme/portal",
  });
  assert.equal(Object.hasOwn(gitRepoResourceKind.manifestEntry(resource, { baseSha: SHA }), "baseSha"), false);
});

function fakeRunGit({
  dirtyStatus = "",
  failHeadRevParse = false,
  failWorktreeAddAfterCreate = false,
} = {}) {
  const calls = [];
  const runGit = (args, { cwd } = {}) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "status" && args[1] === "--porcelain") {
      return ok(dirtyStatus);
    }
    if (args[0] === "worktree" && args[1] === "add") {
      fs.mkdirSync(args[3], { recursive: true });
      return failWorktreeAddAfterCreate ? fail("add failed") : ok("");
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return failHeadRevParse ? fail("bad HEAD") : ok(`${SHA}\n`);
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      fs.rmSync(args[3], { recursive: true, force: true });
      return ok("");
    }
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
  return { runGit, calls };
}

function ok(stdout) {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr) {
  return { ok: false, status: 1, stdout: "", stderr };
}

function commandCalls(calls) {
  return calls.map((call) => ({ args: call.args, cwd: call.cwd }));
}

function tempWorktreeBase() {
  return path.join(os.tmpdir(), "agentic-factory", "resource-worktrees");
}

function uniqueRunId(label) {
  return `${label}-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanupRunDir(runId) {
  fs.rmSync(path.join(tempWorktreeBase(), runId), { recursive: true, force: true });
}

function pathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanupWorktreeDirs(calls) {
  for (const call of calls.filter((entry) => entry.args[0] === "worktree" && entry.args[1] === "add")) {
    fs.rmSync(call.args[3], { recursive: true, force: true });
  }
}

function goodBinding(overrides = {}) {
  return {
    owner: "acme",
    repo: "app",
    default_branch: "main",
    local_checkout_path: "/work/acme-app",
    ...overrides,
  };
}

function gitRepoResource({
  id = "repo-1",
  role = "primary",
  owner = "acme",
  repo = "app",
  default_branch = "main",
  local_checkout_path = "/work/acme-app",
} = {}) {
  return {
    id,
    kind: "git_repo",
    role,
    binding: goodBinding({
      owner,
      repo,
      default_branch,
      local_checkout_path,
    }),
  };
}
