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
    teamRef: "team-1",
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
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
});

test("staged credential content blocks commit, intent, push, and pull request", async () => {
  const fixture = createGitFixture("staged-secret");
  const runId = "run_staged_secret";
  const worker = createWorkerCheckout(fixture, runId);
  fs.writeFileSync(
    path.join(worker, ".env"),
    `GITHUB_TOKEN=${["github", "_pat_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].join("")}\n`,
    "utf8",
  );
  const runStoreDir = tempRunStore();
  const prAdapter = createFakePrAdapter();
  const store = createIntentStore({ runStoreDir });
  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: effectContext({ fixture, worker, runId, runStoreDir, prAdapter, store }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_staged_content_guard_failed");
  assert.equal(prAdapter.created.length, 0);
  assert.equal(remoteHead(fixture.remote, branchNameForIssue("AF-1")), "");
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
  assert.equal(git(["rev-parse", "HEAD"], worker).stdout.trim(), fixture.baseSha);
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
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
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
  const preReplay = readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir });
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
  const observed = readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir });
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
          team_ref: "team-1",
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
      executionReadiness: () => ({ ok: true }),
      runId,
      runStoreDir: tempRunStore(),
      teamContext: { teamRef: "team-1" },
      issueId: "issue-1",
      issue: {
        id: "issue-1",
        identifier: "AF-1",
        title: "Implement AF-1",
      },
      artifact: {
        kind: "commit",
        run_id: runId,
        team_ref: "team-1",
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
        team_ref: "team-1",
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

test("git_repo remote commands against GitHub carry in-memory Basic auth and keep the token off the command line", async () => {
  const runId = "run_github_auth_env";
  const branch = branchNameForIssue("AF-1");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const githubRemote = "https://github.com/acme/product.git";
  const calls = [];
  const runGit = fakeReplayRunGit({ calls, injectedRemote: githubRemote, branch, headSha, treeSha });
  const prAdapter = createFakePrAdapter();
  const store = {
    async markMutationStarted() {
      return { ok: true };
    },
  };
  const selectedResource = {
    id: "repo-1",
    kind: "git_repo",
    role: "primary",
    binding: { owner: "acme", repo: "product", default_branch: "main" },
    handle: {
      baseSha,
      owner: "acme",
      repo: "product",
      default_branch: "main",
      remoteUrl: githubRemote,
    },
  };

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: {
      executionReadiness: () => ({ ok: true }),
      runId,
      runStoreDir: tempRunStore(),
      teamContext: { teamRef: "team-1" },
      issueId: "issue-1",
      issue: { id: "issue-1", identifier: "AF-1", title: "Implement AF-1" },
      artifact: {
        kind: "commit",
        run_id: runId,
        team_ref: "team-1",
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
        resources: { "repo-1": selectedResource },
        resourceManifest: [{ kind: "git_repo", id: "repo-1", role: "primary", label: "acme/product" }],
      },
      store,
      wake: {
        id: "wake-1",
        team_ref: "team-1",
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
  const expectedHeader = `Authorization: Basic ${Buffer.from("x-access-token:fixture-token", "utf8").toString("base64")}`;
  const remoteCalls = calls.filter((call) => call.args[0] === "ls-remote" || call.args[0] === "fetch");
  assert.ok(remoteCalls.length > 0, "expected remote-facing git calls");
  for (const call of remoteCalls) {
    assert.equal(call.env.GIT_CONFIG_COUNT, "1");
    assert.equal(call.env.GIT_CONFIG_KEY_0, "http.extraHeader");
    assert.equal(call.env.GIT_CONFIG_VALUE_0, expectedHeader);
  }
  for (const call of calls) {
    assert.equal(
      call.args.some((arg) => String(arg).includes("fixture-token") || String(arg).includes("Basic")),
      false,
      "token material must never appear on a git command line",
    );
  }
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
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
});

test("git_repo pre-push ownership accepts a remote head that descends from the recorded head", async () => {
  const fixture = createGitFixture("descent");
  const runId = "run_descent_resume";
  const branch = branchNameForIssue("AF-1");

  const factory = path.join(fixture.root, "factory");
  git(["clone", "--branch", "main", fixture.remote, factory]);
  git(["config", "user.name", "Factory"], factory);
  git(["config", "user.email", "factory@example.invalid"], factory);
  git(["checkout", "-b", branch], factory);
  fs.writeFileSync(path.join(factory, "feature.txt"), "factory work\n", "utf8");
  git(["add", "feature.txt"], factory);
  git(["commit", "-m", "factory execution"], factory);
  git(["push", "origin", `HEAD:refs/heads/${branch}`], factory);
  const factoryHead = git(["rev-parse", "HEAD"], factory).stdout.trim();
  const factoryTree = git(["rev-parse", "HEAD^{tree}"], factory).stdout.trim();

  fs.writeFileSync(path.join(factory, "cleanup.txt"), "principal cleanup\n", "utf8");
  git(["add", "cleanup.txt"], factory);
  git(["commit", "-m", "principal cleanup"], factory);
  git(["push", "origin", `HEAD:refs/heads/${branch}`], factory);

  const worker = path.join(fixture.root, `worker-${runId}`);
  git(["clone", "--branch", branch, fixture.remote, worker]);
  git(["remote", "remove", "origin"], worker);
  fs.writeFileSync(path.join(worker, "resumed.txt"), "resumed work on top\n", "utf8");
  const runStoreDir = tempRunStore();
  const prAdapter = createFakePrAdapter();

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: {
      ...effectContext({
        fixture,
        worker,
        runId,
        runStoreDir,
        prAdapter,
        store: createIntentStore({ runStoreDir }),
      }),
      pendingGitIntent: {
        runId: "run_previous",
        artifactKind: "commit",
        git: {
          owner: "acme",
          repo: "product",
          resource_id: "repo-1",
          branch,
          base_sha: fixture.baseSha,
          head_sha: factoryHead,
          tree_sha: factoryTree,
        },
      },
    },
  });

  assert.equal(result.outcome, "ok");
  const workerHead = git(["rev-parse", "HEAD"], worker).stdout.trim();
  assert.equal(remoteHead(fixture.remote, branch), workerHead, "the resumed commit must land on top of the human addition");
  const pending = readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir });
  assert.equal(pending.runId, runId);
  assert.equal(pending.git.head_sha, workerHead, "the observed intent must rebaseline to the landed head");
});

test("git_repo pre-push ownership still fails closed when the recorded head was rewritten away", async () => {
  const fixture = createGitFixture("rewritten");
  const runId = "run_rewritten_resume";
  const branch = branchNameForIssue("AF-1");

  const factory = path.join(fixture.root, "factory");
  git(["clone", "--branch", "main", fixture.remote, factory]);
  git(["config", "user.name", "Factory"], factory);
  git(["config", "user.email", "factory@example.invalid"], factory);
  git(["checkout", "-b", branch], factory);
  fs.writeFileSync(path.join(factory, "feature.txt"), "factory work\n", "utf8");
  git(["add", "feature.txt"], factory);
  git(["commit", "-m", "factory execution"], factory);
  git(["push", "origin", `HEAD:refs/heads/${branch}`], factory);
  const factoryHead = git(["rev-parse", "HEAD"], factory).stdout.trim();
  const factoryTree = git(["rev-parse", "HEAD^{tree}"], factory).stdout.trim();

  fs.writeFileSync(path.join(factory, "feature.txt"), "rewritten work\n", "utf8");
  git(["add", "feature.txt"], factory);
  git(["commit", "--amend", "-m", "rewritten execution"], factory);
  git(["push", "--force", "origin", `HEAD:refs/heads/${branch}`], factory);

  const worker = path.join(fixture.root, `worker-${runId}`);
  git(["clone", "--branch", branch, fixture.remote, worker]);
  git(["remote", "remove", "origin"], worker);
  fs.writeFileSync(path.join(worker, "resumed.txt"), "must not land\n", "utf8");
  const runStoreDir = tempRunStore();

  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: {
      ...effectContext({
        fixture,
        worker,
        runId,
        runStoreDir,
        prAdapter: createFakePrAdapter(),
        store: createIntentStore({ runStoreDir }),
      }),
      pendingGitIntent: {
        runId: "run_previous",
        artifactKind: "commit",
        git: {
          owner: "acme",
          repo: "product",
          resource_id: "repo-1",
          branch,
          base_sha: fixture.baseSha,
          head_sha: factoryHead,
          tree_sha: factoryTree,
        },
      },
    },
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_remote_branch_not_owned");
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
});

test("git_repo same-run replay awaits ancestry and rejects a rewritten observed branch", async () => {
  const fixture = createGitFixture("replay-rewritten");
  const runId = "run_replay_rewritten";
  const branch = branchNameForIssue("AF-1");
  const factory = path.join(fixture.root, "factory");
  git(["clone", "--branch", "main", fixture.remote, factory]);
  git(["config", "user.name", "Factory"], factory);
  git(["config", "user.email", "factory@example.invalid"], factory);
  git(["checkout", "-b", branch], factory);
  fs.writeFileSync(path.join(factory, "feature.txt"), "observed work\n", "utf8");
  git(["add", "feature.txt"], factory);
  git(["commit", "-m", "observed execution"], factory);
  git(["push", "origin", `HEAD:refs/heads/${branch}`], factory);
  const observedHead = git(["rev-parse", "HEAD"], factory).stdout.trim();
  const observedTree = git(["rev-parse", "HEAD^{tree}"], factory).stdout.trim();

  fs.writeFileSync(path.join(factory, "feature.txt"), "foreign rewrite\n", "utf8");
  git(["add", "feature.txt"], factory);
  git(["commit", "--amend", "-m", "foreign rewrite"], factory);
  git(["push", "--force", "origin", `HEAD:refs/heads/${branch}`], factory);

  const runStoreDir = tempRunStore();
  const prAdapter = createFakePrAdapter();
  const result = await applyCommitEffects({
    effects: [gitRepoCommitEffectDescriptor({ id: GIT_REPO_COMMIT_EFFECT_ID })],
    ctx: {
      ...effectContext({
        fixture,
        worker: path.join(fixture.root, "missing-worker"),
        runId,
        runStoreDir,
        prAdapter,
        store: createIntentStore({ runStoreDir }),
      }),
      pendingGitIntent: {
        runId,
        artifactKind: "commit",
        git: {
          owner: "acme",
          repo: "product",
          resource_id: "repo-1",
          branch,
          base_sha: fixture.baseSha,
          head_sha: observedHead,
          tree_sha: observedTree,
        },
      },
    },
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.reason, "git_repo_remote_branch_not_owned");
  assert.equal(prAdapter.created.length, 0);
});

test("git_repo replay with no remote branch and no worktree fails closed and clears the stale marker", async () => {
  const fixture = createGitFixture("missing-remote");
  const runId = "run_missing_remote";
  const worker = path.join(fixture.root, "deleted-worker");
  const runStoreDir = tempRunStore();
  writeMutationIntent({
    teamRef: "team-1",
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
  assert.equal(readGitReplayPending({ teamRef: "team-1", objectId: "issue-1", runStoreDir }), null);
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
    executionReadiness: () => ({ ok: true }),
    runId,
    repoRoot: fixture.root,
    runStoreDir,
    teamContext: { teamRef: "team-1" },
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      identifier: "AF-1",
      title: "Implement AF-1",
    },
    artifact: {
      kind: "commit",
      run_id: runId,
      team_ref: "team-1",
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
      team_ref: "team-1",
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
        teamRef: "team-1",
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
          team_ref: "team-1",
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
