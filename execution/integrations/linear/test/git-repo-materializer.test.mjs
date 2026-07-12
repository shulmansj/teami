import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  getResourceKind,
  registeredResourceKinds,
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import { scrubChildEnv } from "../../../engine/runtime-environment.mjs";
import {
  branchNameForIssue,
} from "../../git/git-branch-names.mjs";
import {
  gitRepoAmbientAuthEnv,
  gitRepoDisplayLabel,
  gitRepoRemoteUrl,
  gitRepoResourceId,
  gitRepoResourceKind,
  registerGitRepoResourceKind,
  validateGitRepoBinding,
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

test("git_repo binding is coordinate-only and remote URL derives from owner/repo", () => {
  resetResourceRegistry();
  try {
    registerGitRepoResourceKind();
    const definition = getResourceKind("git_repo");
    const binding = goodBinding();

    assert.doesNotThrow(() => definition.validateBinding(binding));
    assert.doesNotThrow(() => validateGitRepoBinding(binding));
    for (const field of ["owner", "repo", "default_branch"]) {
      assert.throws(
        () => definition.validateBinding({ ...binding, [field]: "" }),
        { message: `git_repo_binding_missing_${field}` },
      );
    }
    assert.equal(gitRepoRemoteUrl({ owner: " Acme ", repo: " App " }), "https://github.com/Acme/App.git");
  } finally {
    resetResourceRegistry();
  }
});

test("gitRepoResourceId is stable, namespaced, coordinate-derived, and distinct by repo", () => {
  assert.equal(gitRepoResourceId({ owner: " Acme ", repo: " Portal " }), "git_repo:acme/portal");
  assert.equal(gitRepoResourceId({ owner: "acme", repo: "portal" }), "git_repo:acme/portal");
  assert.equal(gitRepoResourceId({ owner: "ACME", repo: "API" }), "git_repo:acme/api");
  assert.notEqual(
    gitRepoResourceId({ owner: "acme", repo: "portal" }),
    gitRepoResourceId({ owner: "acme", repo: "api" }),
  );
  assert.throws(() => gitRepoResourceId({ owner: "", repo: "api" }), { message: "git_repo_resource_id_missing_owner" });
  assert.throws(() => gitRepoResourceId({ owner: "acme", repo: " " }), { message: "git_repo_resource_id_missing_repo" });
});

test("ambient auth env preserves normal git config while disabling prompts", () => {
  const env = gitRepoAmbientAuthEnv({
    HOME: "/host/home",
    USERPROFILE: "C:/Users/example",
    GIT_CONFIG_GLOBAL: "/host/gitconfig",
    GIT_TERMINAL_PROMPT: "1",
  });

  assert.equal(env.HOME, "/host/home");
  assert.equal(env.USERPROFILE, "C:/Users/example");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/host/gitconfig");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("git_repo materialize uses ambient remote clone then contained scrubbed checkout", async (t) => {
  resetResourceRegistry();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-repo-materializer-"));
  const runId = uniqueRunId("materialize");
  const adopterCheckout = path.join(tempRoot, "adopter-checkout");
  fs.mkdirSync(adopterCheckout, { recursive: true });
  const remoteUrl = "file:///tmp/acme-app.git";
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
  const { runGit, calls } = fakeRunGit({
    localInsteadOfKeys: ["url.https://token@example.invalid/.insteadOf"],
  });
  const resource = gitRepoResource();

  result = await getResourceKind("git_repo").materialize(resource, {
    runId,
    runGit,
    gitRemoteUrlOverride: remoteUrl,
  });

  assert.equal(result.kind, "git_repo");
  assert.deepEqual(Object.keys(result.handle).sort(), [
    "baseSha",
    "default_branch",
    "envAugment",
    "owner",
    "remoteUrl",
    "repo",
    "workingDir",
  ]);
  assert.equal(result.handle.baseSha, SHA);
  assert.equal(result.handle.owner, resource.binding.owner);
  assert.equal(result.handle.repo, resource.binding.repo);
  assert.equal(result.handle.default_branch, resource.binding.default_branch);
  assert.equal(result.handle.remoteUrl, remoteUrl);
  assert.ok(path.isAbsolute(result.handle.workingDir));
  assert.ok(fs.existsSync(result.handle.workingDir), "fake clone should create the working dir");
  assert.equal(pathInside(result.handle.workingDir, adopterCheckout), false);
  assert.equal(pathInside(result.handle.workingDir, tempCloneBase()), true);

  assert.equal(result.handle.envAugment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(result.handle.envAugment.GIT_TERMINAL_PROMPT, "0");
  assert.ok(result.handle.envAugment.GIT_CONFIG_GLOBAL.endsWith("gitconfig"));

  const runTempDir = result.handle.envAugment.TMPDIR;
  assert.ok(runTempDir, "engine-owned per-run temp dir expected on the worker env");
  assert.equal(result.handle.envAugment.TMP, runTempDir);
  assert.equal(result.handle.envAugment.TEMP, runTempDir);
  assert.equal(pathInside(runTempDir, path.dirname(result.handle.workingDir)), true);
  assert.equal(pathInside(runTempDir, result.handle.workingDir), false);
  assert.ok(fs.existsSync(runTempDir), "per-run temp dir is created with the run workspace");

  const localAppData = result.handle.envAugment.LOCALAPPDATA;
  assert.ok(localAppData, "engine-owned per-run LOCALAPPDATA expected on the worker env");
  assert.equal(localAppData, path.join(result.handle.envAugment.HOME, "AppData", "Local"));
  assert.equal(result.handle.envAugment.APPDATA, path.join(result.handle.envAugment.HOME, "AppData", "Roaming"));
  assert.equal(pathInside(localAppData, path.dirname(result.handle.workingDir)), true);
  assert.equal(pathInside(localAppData, result.handle.workingDir), false);
  assert.equal(pathInside(result.handle.envAugment.APPDATA, result.handle.workingDir), false);
  assert.ok(fs.existsSync(localAppData), "per-run LOCALAPPDATA dir is created with the run workspace");
  assert.ok(fs.existsSync(result.handle.envAugment.APPDATA), "per-run APPDATA dir is created with the run workspace");
  assert.equal(Object.hasOwn(result.handle.envAugment, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(result.handle.envAugment, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(result.handle.envAugment, "GIT_ASKPASS"), false);
  assert.equal(Object.hasOwn(result.handle.envAugment, "SSH_ASKPASS"), false);
  assert.equal(Object.hasOwn(result.handle.envAugment, "SSH_AUTH_SOCK"), false);

  const clone = calls.find((call) => call.args[0] === "clone");
  assert.ok(clone, "expected ambient clone");
  assert.equal(clone.args[1], "--depth=1");
  assert.equal(clone.args[3], "main");
  assert.equal(clone.args[9], remoteUrl);
  assert.equal(clone.args[10], result.handle.workingDir);
  assert.equal(clone.env.GIT_TERMINAL_PROMPT, "0");
  assert.notEqual(clone.env.HOME, result.handle.envAugment.HOME);
  assert.notEqual(clone.env.GIT_CONFIG_GLOBAL, result.handle.envAugment.GIT_CONFIG_GLOBAL);

  const contained = calls.find((call) => call.args[0] === "checkout");
  assert.equal(contained.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(contained.env.GIT_CONFIG_GLOBAL, result.handle.envAugment.GIT_CONFIG_GLOBAL);

  assert.equal(calls.some((call) => path.resolve(call.cwd || ".") === path.resolve(adopterCheckout)), false);
  assert.deepEqual(commandCalls(calls), [
    { args: ["clone", "--depth=1", "--branch", "main", "--single-branch", "--no-tags", "--no-checkout", "--template", cloneTemplateDir(calls), remoteUrl, result.handle.workingDir], cwd: path.dirname(result.handle.workingDir) },
    { args: ["rev-parse", "--verify", "refs/heads/main^{commit}"], cwd: result.handle.workingDir },
    { args: ["remote"], cwd: result.handle.workingDir },
    { args: ["remote", "remove", "origin"], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--unset-all", "credential.helper"], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--replace-all", "credential.helper", ""], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--unset-all", "http.extraHeader"], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--name-only", "--get-regexp", "^url\\..*\\.insteadOf$"], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--unset-all", "url.https://token@example.invalid/.insteadOf"], cwd: result.handle.workingDir },
    { args: ["config", "--local", "--replace-all", "core.hooksPath", cloneHooksPath(calls)], cwd: result.handle.workingDir },
    { args: ["checkout", "--detach", SHA], cwd: result.handle.workingDir },
    { args: ["rev-parse", "HEAD"], cwd: result.handle.workingDir },
  ]);
});

test("git_repo materialize clones from a local fake remote, leaves adopter checkout untouched, and scrubs the agent dir", async (t) => {
  if (!gitAvailable(t)) return;
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-remote-clone-"));
  const runId = uniqueRunId("remote-clone");
  let materialized = null;
  t.after(async () => {
    try {
      if (materialized) await materialized.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const fixture = createRemoteBackedSourceRepo({ root });
  fs.writeFileSync(path.join(fixture.source, "scratch.txt"), "operator-local-only\n", "utf8");

  materialized = await getResourceKind("git_repo").materialize(
    gitRepoResource(),
    {
      runId,
      gitRemoteUrlOverride: fileUrl(fixture.remote),
    },
  );

  const workerEnv = workerGitEnv(materialized.handle.envAugment);
  assert.equal(workerEnv.LOCALAPPDATA, materialized.handle.envAugment.LOCALAPPDATA);
  assert.equal(workerEnv.APPDATA, materialized.handle.envAugment.APPDATA);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), fixture.baseSha);
  assert.equal(fs.readFileSync(path.join(materialized.handle.workingDir, "README.md"), "utf8"), "# product\n");
  assert.equal(fs.existsSync(path.join(materialized.handle.workingDir, "scratch.txt")), false);
  assert.equal(fs.readFileSync(path.join(fixture.source, "scratch.txt"), "utf8"), "operator-local-only\n");
  assert.equal(git(["remote"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), "");

  const helper = git(["config", "--local", "--get-all", "credential.helper"], {
    cwd: materialized.handle.workingDir,
    env: workerEnv,
    ok: false,
  });
  assert.equal(helper.stdout.trim(), "");
  const header = git(["config", "--local", "--get-all", "http.extraHeader"], {
    cwd: materialized.handle.workingDir,
    env: workerEnv,
    ok: false,
  });
  assert.equal(header.stdout.trim(), "");
  const hooksPath = git(["config", "--local", "--get", "core.hooksPath"], {
    cwd: materialized.handle.workingDir,
    env: workerEnv,
  }).stdout.trim();
  assert.equal(path.isAbsolute(hooksPath), true);
  assert.deepEqual(fs.readdirSync(hooksPath), []);

  const shallow = git(["rev-parse", "--is-shallow-repository"], {
    cwd: materialized.handle.workingDir,
    env: workerEnv,
  }).stdout.trim();
  assert.equal(shallow, "true");
  assert.equal(Object.hasOwn(workerEnv, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(workerEnv, "GITHUB_TOKEN"), false);

  const runDir = path.dirname(path.dirname(materialized.handle.workingDir));
  await materialized.teardown();
  assert.equal(fs.existsSync(runDir), false);
});

test("git_repo materialize re-clones and checks out the durable issue branch from the remote", async (t) => {
  if (!gitAvailable(t)) return;
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-resume-"));
  const runId = uniqueRunId("resume");
  let materialized = null;
  t.after(async () => {
    try {
      if (materialized) await materialized.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const fixture = createRemoteBackedSourceRepo({ root });
  const branch = branchNameForIssue("AF-1");
  const branchWriter = path.join(root, "branch-writer");
  git(["clone", "--branch", "main", fixture.remote, branchWriter]);
  git(["config", "user.name", "Fixture Author"], { cwd: branchWriter });
  git(["config", "user.email", "fixture@example.invalid"], { cwd: branchWriter });
  git(["checkout", "-b", branch], { cwd: branchWriter });
  fs.writeFileSync(path.join(branchWriter, "fix.txt"), "first run content\n", "utf8");
  git(["add", "fix.txt"], { cwd: branchWriter });
  git(["commit", "-m", "first execution"], { cwd: branchWriter });
  git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: branchWriter });
  const branchHead = git(["rev-parse", "HEAD"], { cwd: branchWriter }).stdout.trim();
  const branchTree = git(["rev-parse", "HEAD^{tree}"], { cwd: branchWriter }).stdout.trim();

  assert.equal(git(["rev-parse", "--verify", `${branch}^{commit}`], { cwd: fixture.source, ok: false }).ok, false);

  materialized = await getResourceKind("git_repo").materialize(
    gitRepoResource(),
    {
      runId,
      gitRemoteUrlOverride: fileUrl(fixture.remote),
      issue: { id: "issue-1", identifier: "AF-1" },
      issueIdentifier: "AF-1",
      pendingGitIntent: {
        runId: "run_previous",
        git: {
          resource_id: "repo-1",
          owner: "acme",
          repo: "app",
          branch,
          base_sha: fixture.baseSha,
          head_sha: branchHead,
          tree_sha: branchTree,
        },
      },
    },
  );

  const workerEnv = workerGitEnv(materialized.handle.envAugment);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), branchHead);
  assert.equal(fs.readFileSync(path.join(materialized.handle.workingDir, "fix.txt"), "utf8"), "first run content\n");
  assert.equal(git(["branch", "--show-current"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), branch);
  assert.equal(git(["remote"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), "");
  assert.equal(pathInside(materialized.handle.workingDir, fixture.source), false);
});

test("git_repo materialize resumes on a branch head that descends from the factory's recorded head", async (t) => {
  if (!gitAvailable(t)) return;
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-descend-"));
  const runId = uniqueRunId("descend");
  let materialized = null;
  t.after(async () => {
    try {
      if (materialized) await materialized.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const fixture = createRemoteBackedSourceRepo({ root });
  const branch = branchNameForIssue("AF-1");
  const branchWriter = path.join(root, "branch-writer");
  git(["clone", "--branch", "main", fixture.remote, branchWriter]);
  git(["config", "user.name", "Fixture Author"], { cwd: branchWriter });
  git(["config", "user.email", "fixture@example.invalid"], { cwd: branchWriter });
  git(["checkout", "-b", branch], { cwd: branchWriter });
  fs.writeFileSync(path.join(branchWriter, "fix.txt"), "factory content\n", "utf8");
  git(["add", "fix.txt"], { cwd: branchWriter });
  git(["commit", "-m", "factory execution"], { cwd: branchWriter });
  git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: branchWriter });
  const factoryHead = git(["rev-parse", "HEAD"], { cwd: branchWriter }).stdout.trim();
  const factoryTree = git(["rev-parse", "HEAD^{tree}"], { cwd: branchWriter }).stdout.trim();

  fs.writeFileSync(path.join(branchWriter, "cleanup.txt"), "principal cleanup\n", "utf8");
  git(["add", "cleanup.txt"], { cwd: branchWriter });
  git(["commit", "-m", "principal cleanup"], { cwd: branchWriter });
  git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: branchWriter });
  const cleanedHead = git(["rev-parse", "HEAD"], { cwd: branchWriter }).stdout.trim();

  materialized = await getResourceKind("git_repo").materialize(
    gitRepoResource(),
    {
      runId,
      gitRemoteUrlOverride: fileUrl(fixture.remote),
      issue: { id: "issue-1", identifier: "AF-1" },
      issueIdentifier: "AF-1",
      pendingGitIntent: {
        runId: "run_previous",
        git: {
          resource_id: "repo-1",
          owner: "acme",
          repo: "app",
          branch,
          base_sha: fixture.baseSha,
          head_sha: factoryHead,
          tree_sha: factoryTree,
        },
      },
    },
  );

  const workerEnv = workerGitEnv(materialized.handle.envAugment);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), cleanedHead);
  assert.equal(fs.readFileSync(path.join(materialized.handle.workingDir, "fix.txt"), "utf8"), "factory content\n");
  assert.equal(fs.readFileSync(path.join(materialized.handle.workingDir, "cleanup.txt"), "utf8"), "principal cleanup\n");
  assert.equal(git(["branch", "--show-current"], { cwd: materialized.handle.workingDir, env: workerEnv }).stdout.trim(), branch);
  assert.equal(
    git(["merge-base", "--is-ancestor", factoryHead, "HEAD"], { cwd: materialized.handle.workingDir, env: workerEnv }).ok,
    true,
    "the factory's recorded head must remain in the resumed history",
  );
});

test("git_repo materialize fails closed when the factory's recorded head was rewritten away", async (t) => {
  if (!gitAvailable(t)) return;
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-rewritten-"));
  const runId = uniqueRunId("rewritten");
  t.after(() => {
    cleanupRunDir(runId);
    resetResourceRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fixture = createRemoteBackedSourceRepo({ root });
  const branch = branchNameForIssue("AF-1");
  const branchWriter = path.join(root, "branch-writer");
  git(["clone", "--branch", "main", fixture.remote, branchWriter]);
  git(["config", "user.name", "Fixture Author"], { cwd: branchWriter });
  git(["config", "user.email", "fixture@example.invalid"], { cwd: branchWriter });
  git(["checkout", "-b", branch], { cwd: branchWriter });
  fs.writeFileSync(path.join(branchWriter, "fix.txt"), "factory content\n", "utf8");
  git(["add", "fix.txt"], { cwd: branchWriter });
  git(["commit", "-m", "factory execution"], { cwd: branchWriter });
  git(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: branchWriter });
  const factoryHead = git(["rev-parse", "HEAD"], { cwd: branchWriter }).stdout.trim();
  const factoryTree = git(["rev-parse", "HEAD^{tree}"], { cwd: branchWriter }).stdout.trim();

  fs.writeFileSync(path.join(branchWriter, "fix.txt"), "rewritten content\n", "utf8");
  git(["add", "fix.txt"], { cwd: branchWriter });
  git(["commit", "--amend", "-m", "rewritten execution"], { cwd: branchWriter });
  git(["push", "--force", "origin", `HEAD:refs/heads/${branch}`], { cwd: branchWriter });

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(
      gitRepoResource(),
      {
        runId,
        gitRemoteUrlOverride: fileUrl(fixture.remote),
        issue: { id: "issue-1", identifier: "AF-1" },
        issueIdentifier: "AF-1",
        pendingGitIntent: {
          runId: "run_previous",
          git: {
            resource_id: "repo-1",
            owner: "acme",
            repo: "app",
            branch,
            base_sha: fixture.baseSha,
            head_sha: factoryHead,
            tree_sha: factoryTree,
          },
        },
      },
    ),
    /git_repo_remote_branch_not_owned/,
  );
});

test("git_repo teardown is idempotent and removes the clone directory", async (t) => {
  resetResourceRegistry();
  const runId = uniqueRunId("teardown");
  let result = null;
  t.after(async () => {
    try {
      if (result) await result.teardown();
    } finally {
      cleanupRunDir(runId);
      resetResourceRegistry();
    }
  });

  registerGitRepoResourceKind();
  const { runGit, calls } = fakeRunGit();

  result = await getResourceKind("git_repo").materialize(gitRepoResource(), {
    runId,
    runGit,
    gitRemoteUrlOverride: "file:///tmp/acme-app.git",
  });

  const runDir = path.dirname(path.dirname(result.handle.workingDir));
  await result.teardown();
  await result.teardown();

  assert.equal(calls.some((call) => call.args[0] === "worktree"), false);
  assert.equal(fs.existsSync(runDir), false);
  assert.equal(fs.existsSync(result.handle.envAugment.TMPDIR), false);
  assert.equal(fs.existsSync(result.handle.envAugment.LOCALAPPDATA), false);
  assert.equal(fs.existsSync(result.handle.envAugment.APPDATA), false);
});

test("git_repo materialize cleans up if a post-clone step fails", async (t) => {
  resetResourceRegistry();
  const runId = uniqueRunId("failure");
  let calls = [];
  t.after(() => {
    cleanupCloneDirs(calls);
    cleanupRunDir(runId);
    resetResourceRegistry();
  });

  registerGitRepoResourceKind();
  const fake = fakeRunGit({ failCheckout: true });
  const runGit = fake.runGit;
  calls = fake.calls;

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(gitRepoResource(), {
      runId,
      runGit,
      gitRemoteUrlOverride: "file:///tmp/acme-app.git",
    }),
    /git_repo_checkout_failed:checkout failed/,
  );

  const cloneCall = calls.find((call) => call.args[0] === "clone");
  assert.ok(cloneCall, "expected clone before the failure");
  assert.equal(fs.existsSync(cloneCall.args[10]), false);
});

test("git_repo materialize cleans up if clone creates a directory then fails", async (t) => {
  resetResourceRegistry();
  const runId = uniqueRunId("clone-failure");
  let calls = [];
  t.after(() => {
    cleanupCloneDirs(calls);
    cleanupRunDir(runId);
    resetResourceRegistry();
  });

  registerGitRepoResourceKind();
  const fake = fakeRunGit({ failCloneAfterCreate: true });
  const runGit = fake.runGit;
  calls = fake.calls;

  await assert.rejects(
    () => getResourceKind("git_repo").materialize(gitRepoResource(), {
      runId,
      runGit,
      gitRemoteUrlOverride: "file:///tmp/acme-app.git",
    }),
    /git_repo_clone_failed:clone failed/,
  );

  const cloneCall = calls.find((call) => call.args[0] === "clone");
  assert.ok(cloneCall, "expected clone before the failure");
  assert.equal(fs.existsSync(cloneCall.args[10]), false);
});

test("git_repo manifestEntry returns serializable label facts without baseSha or envAugment", () => {
  const resource = gitRepoResource({
    owner: "acme",
    repo: "portal",
    role: "primary",
    id: "repo-1",
  });

  assert.deepEqual(gitRepoResourceKind.manifestEntry(resource, { baseSha: SHA, envAugment: { HOME: "/tmp/home" } }), {
    kind: "git_repo",
    id: "repo-1",
    role: "primary",
    label: "acme/portal",
  });
  assert.equal(gitRepoDisplayLabel(resource), "acme/portal");
  assert.equal(Object.hasOwn(gitRepoResourceKind.manifestEntry(resource, { baseSha: SHA }), "baseSha"), false);
  assert.equal(Object.hasOwn(gitRepoResourceKind.manifestEntry(resource, { envAugment: {} }), "envAugment"), false);
});

function fakeRunGit({
  failCheckout = false,
  failCloneAfterCreate = false,
  localInsteadOfKeys = [],
} = {}) {
  const calls = [];
  const runGit = (args, { cwd, env, exactEnv } = {}) => {
    calls.push({ args: [...args], cwd, env: { ...(env || {}) }, exactEnv });
    if (args[0] === "clone") {
      fs.mkdirSync(args[10], { recursive: true });
      return failCloneAfterCreate ? fail("clone failed") : ok("");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok(`${SHA}\n`);
    }
    if (args[0] === "remote" && args.length === 1) {
      return ok("origin\n");
    }
    if (args[0] === "remote" && args[1] === "remove") {
      return ok("");
    }
    if (args[0] === "config" && args[3] === "--get-regexp") {
      return localInsteadOfKeys.length > 0 ? ok(`${localInsteadOfKeys.join("\n")}\n`) : fail("no matching config");
    }
    if (args[0] === "config") {
      return ok("");
    }
    if (args[0] === "checkout" && args[1] === "--detach") {
      return failCheckout ? fail("checkout failed") : ok("");
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return ok(`${SHA}\n`);
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

function cloneTemplateDir(calls) {
  const cloneCall = calls.find((call) => call.args[0] === "clone");
  return cloneCall?.args[8];
}

function cloneHooksPath(calls) {
  const hooksCall = calls.find((call) =>
    call.args[0] === "config" &&
    call.args[1] === "--local" &&
    call.args[2] === "--replace-all" &&
    call.args[3] === "core.hooksPath"
  );
  return hooksCall?.args[4];
}

function tempCloneBase() {
  return path.join(os.tmpdir(), "teami", "resource-clones");
}

function uniqueRunId(label) {
  return `${label}-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanupRunDir(runId) {
  fs.rmSync(path.join(tempCloneBase(), safeTestName(runId)), { recursive: true, force: true });
}

function pathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanupCloneDirs(calls) {
  for (const call of calls.filter((entry) => entry.args[0] === "clone")) {
    fs.rmSync(path.dirname(path.dirname(call.args[10])), { recursive: true, force: true });
  }
}

function goodBinding(overrides = {}) {
  return {
    owner: "acme",
    repo: "app",
    default_branch: "main",
    ...overrides,
  };
}

function gitRepoResource({
  id = "repo-1",
  role = "primary",
  owner = "acme",
  repo = "app",
  default_branch = "main",
} = {}) {
  return {
    id,
    kind: "git_repo",
    role,
    binding: goodBinding({
      owner,
      repo,
      default_branch,
    }),
  };
}

function gitAvailable(t) {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    t.skip("git executable is unavailable");
    return false;
  }
  return true;
}

function createRemoteBackedSourceRepo({ root }) {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  git(["init", "--bare", remote]);
  git(["init"], { cwd: source });
  git(["config", "user.name", "Fixture Author"], { cwd: source });
  git(["config", "user.email", "fixture@example.invalid"], { cwd: source });
  fs.writeFileSync(path.join(source, "README.md"), "# product\n", "utf8");
  git(["add", "README.md"], { cwd: source });
  git(["commit", "-m", "initial"], { cwd: source });
  git(["branch", "-M", "main"], { cwd: source });
  git(["remote", "add", "origin", remote], { cwd: source });
  git(["push", "-u", "origin", "main"], { cwd: source });
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const baseSha = git(["rev-parse", "HEAD"], { cwd: source }).stdout.trim();
  return { remote, source, baseSha };
}

function git(args, { cwd, env = process.env, ok: expectOk = true } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  const normalized = {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  if (expectOk && !normalized.ok) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${normalized.stderr || normalized.stdout}`);
  }
  return normalized;
}

function workerGitEnv(envAugment, hostileEnv = {}) {
  return {
    ...scrubChildEnv({
      ...process.env,
      GH_TOKEN: "hostile-gh-token",
      GITHUB_TOKEN: "hostile-github-token",
      GIT_ASKPASS: "hostile-askpass",
      SSH_ASKPASS: "hostile-ssh-askpass",
      SSH_AUTH_SOCK: "hostile-ssh-agent",
      LOCALAPPDATA: "hostile-local-appdata",
      APPDATA: "hostile-roaming-appdata",
      ...hostileEnv,
    }),
    ...envAugment,
  };
}

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function safeTestName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
}
