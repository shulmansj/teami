import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  branchNameForIssue,
  DEFAULT_GIT_REPO_DIFF_BUDGET,
  gitRepoCommitEffectDescriptor,
} from "../../git/git-repo-commit-effect.mjs";
import {
  readGitReplayPending,
  writeMutationIntent,
} from "../src/trigger-idempotency.mjs";
import { GIT_REPO_COMMIT_EFFECT_ID } from "../src/workflows/execution/effect-ids.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";

test("execution definition attaches the git_repo commit effect body to its effect id", () => {
  const effect = executionDefinition.commit_effects.find((candidate) => candidate.id === GIT_REPO_COMMIT_EFFECT_ID);

  assert.equal(effect?.id, GIT_REPO_COMMIT_EFFECT_ID);
  assert.equal(effect.provider, "git");
  assert.equal(effect.op, "commit_push_open_pr");
  assert.equal(typeof effect.probe, "function");
  assert.equal(typeof effect.apply, "function");
  assert.equal(typeof effect.verify, "function");
});

test("branchNameForIssue derives a deterministic Linear issue-keyed branch", () => {
  assert.equal(branchNameForIssue("LIN-123"), "af/execution/LIN-123-70755421");
  assert.equal(branchNameForIssue("AF 1"), "af/execution/AF-1-3bebe4ab");
  assert.equal(branchNameForIssue(" LIN-123 "), "af/execution/LIN-123-70755421");
  assert.throws(() => branchNameForIssue(""), /git_repo_issue_identifier_required/);
});

test("git_repo commit effect commits, pushes, persists observed intent, and opens one PR", async () => {
  const fixture = createGitFixture("happy");
  const runId = "run_happy";
  const worker = createWorkerCheckout(fixture, runId);
  fs.writeFileSync(path.join(worker, "feature.txt"), "reviewable change\n", "utf8");
  const runStoreDir = tempRunStore();
  const prAdapter = createFakePrAdapter();
  const store = createIntentStore({ runStoreDir });

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({ fixture, worker, runId, runStoreDir, prAdapter, store }),
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.applied.map((entry) => entry.id), [GIT_REPO_COMMIT_EFFECT_ID]);
  assert.equal(prAdapter.created.length, 1);
  assert.equal(prAdapter.created[0].title, "Implement AF-1");
  assert.equal(remoteHead(fixture.remote, branchNameForIssue("AF-1")).length >= 40, true);

  const pending = readGitReplayPending({
    domainId: "domain-1",
    objectId: "issue-1",
    runStoreDir,
  });
  assert.equal(pending.git.branch, branchNameForIssue("AF-1"));
  assert.equal(pending.git.base_sha, fixture.baseSha);
  assert.equal(pending.git.resource_id, "repo-1");
  assert.equal(pending.git.head_sha, remoteHead(fixture.remote, pending.git.branch));
  assert.equal(pending.git.tree_sha.length >= 40, true);

  assert.equal(git(["log", "-1", "--format=%an <%ae>"], worker).stdout.trim(), "AF Bot <af@example.invalid>");
});

test("git_repo commit effect returns failed_closed for an empty staged diff and writes no replay marker", async () => {
  const fixture = createGitFixture("empty");
  const runId = "run_empty";
  const worker = createWorkerCheckout(fixture, runId);
  const runStoreDir = tempRunStore();
  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter: createFakePrAdapter(),
      store: createIntentStore({ runStoreDir }),
    }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.pending_effect_id, GIT_REPO_COMMIT_EFFECT_ID);
  assert.equal(result.reason, "git_repo_empty_diff");
  assert.equal(readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir }), null);
});

test("git_repo commit effect returns failed_closed when the staged diff exceeds the circuit breaker", async () => {
  const fixture = createGitFixture("over-budget");
  const runId = "run_over_budget";
  const worker = createWorkerCheckout(fixture, runId);
  for (let index = 0; index <= DEFAULT_GIT_REPO_DIFF_BUDGET.maxChangedFiles; index += 1) {
    fs.writeFileSync(path.join(worker, `file-${index}.txt`), `change ${index}\n`, "utf8");
  }
  const runStoreDir = tempRunStore();
  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter: createFakePrAdapter(),
      store: createIntentStore({ runStoreDir }),
    }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_diff_over_budget_changed_files");
  assert.equal(readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir }), null);
});

test("git_repo replay after push and before PR open derives remote head from an absent worktree and creates exactly one PR", async () => {
  const fixture = createGitFixture("replay");
  const runId = "run_replay";
  const worker = createWorkerCheckout(fixture, runId);
  fs.writeFileSync(path.join(worker, "feature.txt"), "pushed before crash\n", "utf8");
  const runStoreDir = tempRunStore();
  const prAdapter = createFakePrAdapter();
  const store = createIntentStore({ runStoreDir });
  const effects = [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })];

  const first = await applyCommitEffects({
    effects,
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter,
      store,
      killPoint: "after_git_push_before_pr",
      killPointHandler: async () => {
        throw new Error("simulated_crash_after_push_before_pr");
      },
    }),
  });

  assert.equal(first.outcome, "pending");
  assert.equal(first.pending_effect_id, GIT_REPO_COMMIT_EFFECT_ID);
  assert.equal(prAdapter.created.length, 0);
  const preReplay = readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir });
  assert.equal(preReplay.git.branch, branchNameForIssue("AF-1"));
  assert.equal(Object.hasOwn(preReplay.git, "head_sha"), false);
  assert.equal(remoteHead(fixture.remote, preReplay.git.branch).length >= 40, true);

  fs.rmSync(worker, { recursive: true, force: true });
  const replay = await applyCommitEffects({
    effects,
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter,
      store,
    }),
  });

  assert.equal(replay.outcome, "ok");
  assert.equal(prAdapter.created.length, 1);
  const observed = readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir });
  assert.equal(observed.git.head_sha, remoteHead(fixture.remote, observed.git.branch));
  assert.equal(observed.git.tree_sha.length >= 40, true);

  const secondReplay = await applyCommitEffects({
    effects,
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter,
      store,
    }),
  });
  assert.equal(secondReplay.outcome, "ok");
  assert.equal(prAdapter.created.length, 1);
});

test("git_repo replay resolves gitRepoResourceId-keyed remote override when the selected handle omits remoteUrl", async () => {
  const runId = "run_replay_override";
  const branch = branchNameForIssue("AF-1");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const injectedRemote = "file:///virtual/acme-product.git";
  const calls = [];
  const runGit = fakeReplayRunGit({ calls, injectedRemote, branch, headSha, treeSha });
  const prAdapter = createFakePrAdapter();
  const store = {
    writes: [],
    async markMutationStarted(input) {
      this.writes.push(structuredClone(input));
      return {
        ok: true,
        wake: {
          id: "wake-1",
          domain_id: "domain-1",
          object_type: "issue",
          object_id: "issue-1",
          workflow_type: "execution",
          trigger_type: "linear.issue.ready",
        },
      };
    },
  };
  const selectedResource = {
    id: "repo-1",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "acme",
      repo: "product",
      default_branch: "main",
    },
    handle: {
      baseSha,
      owner: "acme",
      repo: "product",
      default_branch: "main",
    },
  };

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: {
      runId,
      runStoreDir: tempRunStore(),
      domainContext: { domainId: "domain-1" },
      issueId: "issue-1",
      issue: {
        id: "issue-1",
        identifier: "AF-1",
        title: "Implement AF-1",
      },
      artifact: {
        kind: "commit",
        run_id: runId,
        domain_id: "domain-1",
        linear_issue_id: "issue-1",
        payload: payload(),
      },
      payload: payload(),
      pendingGitIntent: {
        runId,
        artifactKind: "commit",
        git: {
          owner: "acme",
          repo: "product",
          resource_id: "repo-1",
          branch,
          base_sha: baseSha,
        },
      },
      runGit,
      githubToken: "fixture-token",
      runContext: {
        selectedResourceId: "repo-1",
        selectedResource,
        resources: {
          "repo-1": selectedResource,
        },
        resourceManifest: [{
          kind: "git_repo",
          id: "repo-1",
          role: "primary",
          label: "acme/product",
        }],
        gitRemoteUrlOverrides: {
          "git_repo:acme/product": injectedRemote,
        },
      },
      store,
      wake: {
        id: "wake-1",
        domain_id: "domain-1",
        object_type: "issue",
        object_id: "issue-1",
        workflow_type: "execution",
        trigger_type: "linear.issue.ready",
      },
      runnerId: "runner-1",
      leaseToken: "lease-1",
      prAdapter,
    },
  });

  assert.equal(result.outcome, "ok");
  assert.equal(prAdapter.created.length, 1);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].git.head_sha, headSha);
  assert.equal(store.writes[0].git.tree_sha, treeSha);
  const remoteUsages = calls
    .filter((call) => call.args[0] === "ls-remote" || call.args[0] === "fetch")
    .map((call) => call.args[0] === "ls-remote" ? call.args[2] : call.args[3]);
  assert.deepEqual([...new Set(remoteUsages)], [injectedRemote]);
  assert.equal(
    calls.some((call) => call.args.some((arg) => String(arg).includes("github.com"))),
    false,
  );
});

test("git_repo pre-push branch ownership failure leaves no replay marker", async () => {
  const fixture = createGitFixture("pre-push");
  const runId = "run_pre_push";
  pushForeignBranch(fixture, branchNameForIssue("AF-1"));
  const worker = createWorkerCheckout(fixture, runId);
  fs.writeFileSync(path.join(worker, "feature.txt"), "must not push over foreign ref\n", "utf8");
  const runStoreDir = tempRunStore();

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter: createFakePrAdapter(),
      store: createIntentStore({ runStoreDir }),
    }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_remote_branch_not_owned");
  assert.equal(readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir }), null);
});

test("git_repo replay with no remote branch and no worktree fails closed and clears the stale marker", async () => {
  const fixture = createGitFixture("missing-remote");
  const runId = "run_missing_remote";
  const worker = path.join(fixture.root, "deleted-worker");
  const runStoreDir = tempRunStore();
  writeMutationIntent({
    domainId: "domain-1",
    objectType: "issue",
    objectId: "issue-1",
    runId,
    artifactKind: "commit",
    wakeId: "wake-1",
    startedAt: "2026-06-24T12:00:00.000Z",
    workflowType: "execution",
    triggerType: "linear.issue.ready",
    git: {
      owner: "acme",
      repo: "product",
      branch: branchNameForIssue("AF-1"),
      base_sha: fixture.baseSha,
    },
    runStoreDir,
  });

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({
      fixture,
      worker,
      runId,
      runStoreDir,
      prAdapter: createFakePrAdapter(),
      store: createIntentStore({ runStoreDir }),
    }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_replay_remote_branch_missing_worktree_absent");
  assert.equal(readGitReplayPending({ domainId: "domain-1", objectId: "issue-1", runStoreDir }), null);
});

function createGitFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `teami-git-effect-${name}-`));
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  git(["init", "--bare", remote]);
  git(["init"], source);
  git(["config", "user.name", "Fixture Author"], source);
  git(["config", "user.email", "fixture@example.invalid"], source);
  fs.writeFileSync(path.join(source, "README.md"), "# Product\n", "utf8");
  git(["add", "README.md"], source);
  git(["commit", "-m", "Initial commit"], source);
  git(["branch", "-M", "main"], source);
  git(["remote", "add", "origin", remote], source);
  git(["push", "-u", "origin", "main"], source);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const baseSha = git(["rev-parse", "HEAD"], source).stdout.trim();
  return { root, remote, source, baseSha };
}

function createWorkerCheckout(fixture, runId) {
  const worker = path.join(fixture.root, `worker-${runId}`);
  git(["clone", "--no-hardlinks", fixture.source, worker]);
  git(["remote", "remove", "origin"], worker);
  git(["checkout", "--detach", fixture.baseSha], worker);
  return worker;
}

function pushForeignBranch(fixture, branch) {
  const foreign = path.join(fixture.root, "foreign");
  git(["clone", "--branch", "main", fixture.remote, foreign]);
  git(["config", "user.name", "Foreign Author"], foreign);
  git(["config", "user.email", "foreign@example.invalid"], foreign);
  git(["checkout", "-b", branch], foreign);
  fs.writeFileSync(path.join(foreign, "foreign.txt"), "foreign branch\n", "utf8");
  git(["add", "foreign.txt"], foreign);
  git(["commit", "-m", "Foreign branch"], foreign);
  git(["push", "origin", `HEAD:refs/heads/${branch}`], foreign);
}

function fakeReplayRunGit({ calls, injectedRemote, branch, headSha, treeSha }) {
  return (args, options = {}) => {
    calls.push({ args: [...args], cwd: options.cwd || null, env: { ...(options.env || {}) } });
    if (args[0] === "ls-remote") {
      if (args[2] !== injectedRemote) return gitCommandFailure(`unexpected remote: ${args[2]}`);
      assert.equal(args[3], `refs/heads/${branch}`);
      return gitCommandSuccess(`${headSha}\trefs/heads/${branch}\n`);
    }
    if (args[0] === "init") return gitCommandSuccess("");
    if (args[0] === "fetch") {
      if (args[3] !== injectedRemote) return gitCommandFailure(`unexpected remote: ${args[3]}`);
      assert.equal(args[4], `refs/heads/${branch}`);
      return gitCommandSuccess("");
    }
    if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD^{tree}") {
      return gitCommandSuccess(`${treeSha}\n`);
    }
    return gitCommandFailure(`unexpected git command: ${args.join(" ")}`);
  };
}

function gitCommandSuccess(stdout) {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function gitCommandFailure(stderr) {
  return { ok: false, status: 1, stdout: "", stderr };
}

function effectContext({
  fixture,
  worker,
  runId,
  runStoreDir,
  prAdapter,
  store,
  killPoint = null,
  killPointHandler = null,
}) {
  const selectedResource = {
    id: "repo-1",
    kind: "git_repo",
    role: "primary",
    handle: {
      workingDir: worker,
      baseSha: fixture.baseSha,
      owner: "acme",
      repo: "product",
      default_branch: "main",
      remoteUrl: fixture.remote,
    },
  };
  return {
    runId,
    repoRoot: fixture.root,
    runStoreDir,
    domainContext: { domainId: "domain-1" },
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      identifier: "AF-1",
      title: "Implement AF-1",
    },
    artifact: {
      kind: "commit",
      run_id: runId,
      domain_id: "domain-1",
      linear_issue_id: "issue-1",
      payload: payload(),
    },
    payload: payload(),
    resources: {
      "repo-1": selectedResource,
    },
    runContext: {
      selectedResourceId: "repo-1",
      selectedResource,
      resources: {
        "repo-1": selectedResource,
      },
      resourceManifest: [{
        kind: "git_repo",
        id: "repo-1",
        role: "primary",
        label: "acme/product",
      }],
    },
    config: {
      workflows: {
        execution: {
          git: {
            author: {
              name: "AF Bot",
              email: "af@example.invalid",
            },
          },
        },
      },
    },
    store,
    wake: {
      id: "wake-1",
      domain_id: "domain-1",
      object_type: "issue",
      object_id: "issue-1",
      workflow_type: "execution",
      trigger_type: "linear.issue.ready",
    },
    runnerId: "runner-1",
    leaseToken: "lease-1",
    prAdapter,
    killPoint,
    runDeps: killPointHandler ? { killPoint: killPointHandler } : {},
  };
}

function payload() {
  return {
    pr_title: "Implement AF-1",
    pr_body: "Adds the requested implementation.",
    linear_issue_id: "issue-1",
  };
}

function createIntentStore({ runStoreDir }) {
  let tick = 0;
  return {
    writes: [],
    async markMutationStarted(input) {
      tick += 1;
      this.writes.push(structuredClone(input));
      writeMutationIntent({
        domainId: "domain-1",
        objectType: "issue",
        objectId: "issue-1",
        runId: input.runId,
        artifactKind: input.artifactKind,
        wakeId: "wake-1",
        startedAt: new Date(Date.parse("2026-06-24T12:00:00.000Z") + tick * 1000).toISOString(),
        workflowType: "execution",
        triggerType: "linear.issue.ready",
        git: input.git,
        runStoreDir,
      });
      return {
        ok: true,
        wake: {
          id: "wake-1",
          domain_id: "domain-1",
          object_type: "issue",
          object_id: "issue-1",
          workflow_type: "execution",
          trigger_type: "linear.issue.ready",
          mutation_started_at: "2026-06-24T12:00:01.000Z",
        },
      };
    },
  };
}

function createFakePrAdapter() {
  const created = [];
  return {
    created,
    async probePullRequest({ head, base }) {
      return created.find((pr) => pr.head.ref === head && pr.base.ref === base) || null;
    },
    async ensurePullRequest({ title, body, head, base }) {
      const existing = await this.probePullRequest({ head, base });
      if (existing) return { created: false, pr: existing };
      const pr = {
        id: `pr-${created.length + 1}`,
        number: created.length + 1,
        state: "open",
        title,
        body,
        head: { ref: head, label: `acme:${head}` },
        base: { ref: base },
        html_url: `https://github.example/acme/product/pull/${created.length + 1}`,
      };
      created.push(pr);
      return { created: true, pr };
    },
  };
}

function remoteHead(remote, branch) {
  const result = git(["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  return result.stdout.trim().split(/\s+/)[0] || "";
}

function git(args, cwd = undefined) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git failed: git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-effect-runs-"));
}
