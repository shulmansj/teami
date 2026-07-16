import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  branchNameForIssue,
  GIT_REPO_COMMIT_BRANCH_PREFIX,
} from "./git-branch-names.mjs";
import { gitRemoteAuthEnv } from "./git-remote-auth.mjs";
import {
  resolveGitRepoRemoteUrl,
} from "./git-repo-materializer.mjs";
import { scanStagedContent } from "./staged-content-guard.mjs";
import { runBoundedGit } from "./bounded-subprocess.mjs";
import { shippedExecutionReadiness } from "../linear/src/execution-readiness-gate.mjs";

export const GIT_REPO_COMMIT_OP = "commit_push_open_pr";
export const GIT_REPO_COMMIT_EFFECT_ID = "git_repo_commit";
export {
  branchNameForIssue,
  GIT_REPO_COMMIT_BRANCH_PREFIX,
};

export const DEFAULT_GIT_REPO_DIFF_BUDGET = Object.freeze({
  maxChangedFiles: 500,
  maxTotalBytes: 5 * 1024 * 1024,
  maxDeletionRatio: 0.95,
  minDeletedLinesForRatio: 200,
});

const DEFAULT_AF_COMMIT_AUTHOR = Object.freeze({
  name: "Teami",
  email: "teami@example.invalid",
});

export const gitRepoCommitEffect = Object.freeze({
  id: GIT_REPO_COMMIT_EFFECT_ID,
  provider: "git",
  op: GIT_REPO_COMMIT_OP,
  probe: probeGitRepoCommitEffect,
  apply: applyGitRepoCommitEffect,
  verify: verifyGitRepoCommitEffect,
});

export function gitRepoCommitEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...gitRepoCommitEffect,
    ...overrides,
  });
}

export async function probeGitRepoCommitEffect(ctx = {}) {
  const pending = await readPendingGitIntent(ctx);
  const resolved = resolveGitInputs(ctx, { pending, requireWorkingDir: false });
  if (!resolved.ok) return { satisfied: false, reason: resolved.reason };

  const remote = await safeProbeRemoteBranch(resolved.value);
  if (!remote.ok) return { satisfied: false, reason: remote.reason };
  if (!remote.branch.exists) return { satisfied: false, reason: "git_repo_remote_branch_absent" };
  const ownership = await pendingGitOwnsRemoteBranch({ pending, inputs: resolved.value, remoteBranch: remote.branch });
  if (!ownership.ok) return { satisfied: false, reason: ownership.reason };
  if (!pendingRunMatchesCurrent(pending, resolved.value)) {
    return { satisfied: false, reason: "git_repo_pending_marker_different_run" };
  }

  const pr = await probePullRequest(ctx, resolved.value);
  if (!pr) return { satisfied: false, reason: "git_repo_pull_request_absent" };

  return {
    satisfied: true,
    identity: gitRepoCommitIdentity({
      inputs: resolved.value,
      remoteBranch: remote.branch,
      pullRequest: pr,
    }),
  };
}

export async function applyGitRepoCommitEffect(ctx = {}) {
  let mutationStarted = false;
  let hooksDir = null;
  let inputs = null;

  try {
    const readiness = (ctx.executionReadiness || shippedExecutionReadiness)();
    if (!readiness?.ok) return terminalFailure("product_repo_execution_not_released");
    const pending = await readPendingGitIntent(ctx);
    const resolved = resolveGitInputs(ctx, { pending, requireWorkingDir: false });
    if (!resolved.ok) return terminalFailure(resolved.reason);
    inputs = resolved.value;
    hooksDir = createEmptyHooksDir();

    const replay = await continueReplayIfRemoteBranchExists({ ctx, inputs, pending });
    if (replay.done) return replay.result;
    if (replay.mutationStarted) mutationStarted = true;

    if (!inputs.workingDir || !fs.existsSync(inputs.workingDir)) {
      await clearGitIntent(ctx).catch(() => {});
      return terminalFailure("git_repo_replay_remote_branch_missing_worktree_absent");
    }

    const owned = await ensureRemoteBranchIsOwnedBeforePush({ ctx, inputs, pending });
    if (!owned.ok) return terminalFailure(owned.reason);

    const prepared = pending?.git && pendingRunMatchesCurrent(pending, inputs) && await checkoutExistingLocalExecutionCommit(inputs)
      ? { ok: true, reusedLocalCommit: true }
      : await prepareCommit({ ctx, inputs, hooksDir });
    if (!prepared.ok) return terminalFailure(prepared.reason);

    await persistGitIntent(ctx, prePushGitIdentity(inputs));
    mutationStarted = true;

    const push = await pushBranch({ inputs, hooksDir });
    const afterPushRemote = await safeProbeRemoteBranch(inputs);
    if (!push.ok && push.reconciliationRequired && (!afterPushRemote.ok || !afterPushRemote.branch.exists)) {
      return pendingFailure("git_repo_push_reconciliation_required");
    }
    if (!push.ok && (!afterPushRemote.ok || !afterPushRemote.branch.exists)) {
      await clearGitIntent(ctx).catch(() => {});
      return terminalFailure("git_repo_push_failed_no_remote_branch");
    }
    if (!push.ok && afterPushRemote.branch.exists) {
      return pendingFailure("git_repo_push_failed_after_probeable_mutation");
    }

    await runEffectKillPoint(ctx, "after_git_push_before_pr");

    const remote = afterPushRemote.ok ? afterPushRemote : await safeProbeRemoteBranch(inputs);
    if (!remote.ok || !remote.branch.exists) return pendingFailure(remote.reason || "git_repo_remote_branch_missing_after_push");

    const expectedHead = await localHeadSha(inputs);
    if (expectedHead && remote.branch.head_sha !== expectedHead) {
      return pendingFailure("git_repo_remote_head_mismatch_after_push");
    }

    const observedGit = observedGitIdentity(inputs, remote.branch);
    try {
      await persistGitIntent(ctx, observedGit);
    } catch {
      return pendingFailure("git_repo_observed_intent_persist_failed");
    }
    try {
      await clearPriorDifferentRunGitIntent(ctx, pending, inputs);
    } catch {
      return pendingFailure("git_repo_prior_intent_clear_failed");
    }

    const pr = await ensurePullRequest(ctx, inputs);
    const identity = gitRepoCommitIdentity({
      inputs,
      remoteBranch: remote.branch,
      pullRequest: pr,
    });
    ctx.gitRepoCommitAppliedIdentity = identity;
    return { ok: true, identity };
  } catch (error) {
    const reason = errorReason(error, "git_repo_commit_effect_failed");
    return mutationStarted ? pendingFailure(reason) : terminalFailure(reason);
  } finally {
    if (hooksDir) fs.rmSync(hooksDir, { recursive: true, force: true });
  }
}

export async function verifyGitRepoCommitEffect(ctx = {}) {
  if (ctx.gitRepoCommitAppliedIdentity) {
    return { ok: true, identity: ctx.gitRepoCommitAppliedIdentity };
  }

  const probe = await probeGitRepoCommitEffect(ctx);
  if (probe.satisfied) return { ok: true, identity: probe.identity };
  return { ok: false, reason: probe.reason || "git_repo_commit_not_verified" };
}

export async function computeStagedDiffMetrics({ runGit = runBoundedGit, workingDir, baseSha = null, gitEnv = {} } = {}) {
  const baseArgs = baseSha ? [baseSha] : [];
  const numstat = await runGit(["diff", "--cached", "--numstat", ...baseArgs, "--"], {
    cwd: workingDir,
    env: gitEnv,
  });
  if (!numstat.ok) return { ok: false, reason: "git_repo_diff_numstat_failed" };

  const patch = await runGit(["diff", "--cached", "--binary", ...baseArgs, "--"], {
    cwd: workingDir,
    env: gitEnv,
  });
  if (!patch.ok) return { ok: false, reason: "git_repo_diff_patch_failed" };

  let changedFiles = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of String(numstat.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split(/\t/);
    changedFiles += 1;
    additions += parseNumstatCount(added);
    deletions += parseNumstatCount(deleted);
  }
  const totalChurn = additions + deletions;
  return {
    ok: true,
    changedFiles,
    additions,
    deletions,
    deletionRatio: totalChurn > 0 ? deletions / totalChurn : 0,
    totalBytes: Buffer.byteLength(String(patch.stdout || ""), "utf8"),
  };
}

export function evaluateDiffBudget(metrics, budget = DEFAULT_GIT_REPO_DIFF_BUDGET) {
  if (!metrics?.ok) return metrics || { ok: false, reason: "git_repo_diff_metrics_missing" };
  if (metrics.changedFiles === 0 && metrics.totalBytes === 0) {
    return { ok: false, terminal: true, reason: "git_repo_empty_diff", metrics };
  }
  const normalizedBudget = normalizeDiffBudget(budget);
  if (metrics.changedFiles > normalizedBudget.maxChangedFiles) {
    return { ok: false, terminal: true, reason: "git_repo_diff_over_budget_changed_files", metrics };
  }
  if (metrics.totalBytes > normalizedBudget.maxTotalBytes) {
    return { ok: false, terminal: true, reason: "git_repo_diff_over_budget_total_bytes", metrics };
  }
  if (
    metrics.deletions >= normalizedBudget.minDeletedLinesForRatio &&
    metrics.deletionRatio > normalizedBudget.maxDeletionRatio
  ) {
    return { ok: false, terminal: true, reason: "git_repo_diff_over_budget_deletion_ratio", metrics };
  }
  return { ok: true, metrics };
}

async function continueReplayIfRemoteBranchExists({ ctx, inputs, pending }) {
  if (!pending?.git || !pendingRunMatchesCurrent(pending, inputs)) return { done: false, mutationStarted: false };
  const baseMatches = pending.git.base_sha === inputs.baseSha;
  if (!baseMatches) {
    return { done: true, result: terminalFailure("git_repo_intent_base_mismatch"), mutationStarted: false };
  }
  if (pending.git.branch !== inputs.branch) {
    return { done: true, result: terminalFailure("git_repo_remote_branch_not_owned"), mutationStarted: false };
  }

  const remote = await safeProbeRemoteBranch(inputs);
  if (!remote.ok || !remote.branch.exists) {
    if (!inputs.workingDir || !fs.existsSync(inputs.workingDir)) {
      await clearGitIntent(ctx).catch(() => {});
      return {
        done: true,
        result: terminalFailure("git_repo_replay_remote_branch_missing_worktree_absent"),
        mutationStarted: false,
      };
    }
    return { done: false, mutationStarted: false };
  }

  if (
    hasObservedGitHeadTree(pending.git) &&
    !remoteMatchesGitIdentity(remote.branch, pending.git) &&
    !await remoteDescendsFromGitIdentity({ inputs, remoteBranch: remote.branch, git: pending.git })
  ) {
    return { done: true, result: terminalFailure("git_repo_remote_branch_not_owned"), mutationStarted: false };
  }

  const observedGit = observedGitIdentity(inputs, remote.branch);
  try {
    await persistGitIntent(ctx, observedGit);
  } catch {
    return {
      done: true,
      result: pendingFailure("git_repo_observed_intent_persist_failed"),
      mutationStarted: true,
    };
  }

  try {
    await runEffectKillPoint(ctx, "after_git_replay_remote_probe_before_pr");
  } catch (error) {
    return {
      done: true,
      result: pendingFailure(errorReason(error, "git_repo_replay_interrupted_before_pr")),
      mutationStarted: true,
    };
  }

  let pr = null;
  try {
    pr = await ensurePullRequest(ctx, inputs);
  } catch (error) {
    return {
      done: true,
      result: pendingFailure(errorReason(error, "git_repo_pull_request_open_failed")),
      mutationStarted: true,
    };
  }
  const identity = gitRepoCommitIdentity({
    inputs,
    remoteBranch: remote.branch,
    pullRequest: pr,
  });
  ctx.gitRepoCommitAppliedIdentity = identity;
  return { done: true, result: { ok: true, identity }, mutationStarted: true };
}

async function ensureRemoteBranchIsOwnedBeforePush({ inputs, pending }) {
  const remote = await safeProbeRemoteBranch(inputs);
  if (!remote.ok) return { ok: false, reason: remote.reason };
  if (!remote.branch.exists) return { ok: true };
  return pendingGitOwnsRemoteBranch({ pending, inputs, remoteBranch: remote.branch });
}

async function prepareCommit({ ctx, inputs, hooksDir }) {
  const { runGit, workingDir, localGitEnv } = inputs;
  const add = await runGit(["add", "-A"], { cwd: workingDir, env: localGitEnv });
  if (!add.ok) return { ok: false, reason: "git_repo_stage_failed" };

  const stagedGuard = await (ctx.scanStagedContent || scanStagedContent)({
    runGit,
    workingDir,
    gitEnv: localGitEnv,
  });
  if (!stagedGuard.ok) {
    return {
      ok: false,
      reason: "git_repo_staged_content_guard_failed",
      staged_content_guard: stagedGuard.report,
    };
  }

  const metrics = await computeStagedDiffMetrics({
    runGit,
    workingDir,
    baseSha: inputs.baseSha,
    gitEnv: localGitEnv,
  });
  const budget = evaluateDiffBudget(metrics, diffBudgetFromContext(ctx));
  if (!budget.ok) return { ok: false, reason: budget.reason, metrics: budget.metrics };

  const checkout = await runGit(["checkout", "-B", inputs.branch], {
    cwd: workingDir,
    env: localGitEnv,
  });
  if (!checkout.ok) return { ok: false, reason: "git_repo_branch_checkout_failed" };

  const author = resolveCommitAuthor(ctx);
  const commit = await runGit([
    "-c",
    `core.hooksPath=${hooksDir}`,
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "--no-verify",
    "-m",
    commitMessage(ctx, inputs),
  ], {
    cwd: workingDir,
    env: localGitEnv,
  });
  if (!commit.ok) return { ok: false, reason: "git_repo_commit_failed" };
  return { ok: true, metrics: budget.metrics };
}

async function checkoutExistingLocalExecutionCommit(inputs) {
  const { runGit, workingDir, localGitEnv, branch, baseSha } = inputs;
  if (!workingDir || !fs.existsSync(workingDir)) return false;
  const branchHead = await runGit(["rev-parse", "--verify", `${branch}^{commit}`], {
    cwd: workingDir,
    env: localGitEnv,
  });
  if (!branchHead.ok) return false;
  const headSha = branchHead.stdout.trim();
  if (!headSha || headSha === baseSha) return false;
  const checkout = await runGit(["checkout", branch], {
    cwd: workingDir,
    env: localGitEnv,
  });
  return checkout.ok;
}

async function pushBranch({ inputs, hooksDir }) {
  return inputs.runGit([
    "-c",
    `core.hooksPath=${hooksDir}`,
    "push",
    "--porcelain",
    inputs.remoteUrl,
    `HEAD:refs/heads/${inputs.branch}`,
  ], {
    cwd: inputs.workingDir,
    env: inputs.remoteGitEnv,
  });
}

async function safeProbeRemoteBranch(inputs) {
  try {
    const branch = await probeRemoteBranch(inputs);
    return { ok: true, branch };
  } catch (error) {
    return { ok: false, reason: errorReason(error, "git_repo_remote_branch_probe_failed") };
  }
}

export async function probeRemoteBranch({
  runGit = runBoundedGit,
  remoteUrl,
  branch,
  remoteGitEnv = {},
} = {}) {
  const ref = `refs/heads/${branch}`;
  const lsRemote = await runGit(["ls-remote", "--heads", remoteUrl, ref], {
    env: remoteGitEnv,
  });
  if (!lsRemote.ok) throw new Error("git_repo_remote_branch_probe_failed");
  const line = String(lsRemote.stdout || "").split(/\r?\n/).find(Boolean);
  if (!line) return { exists: false, branch, head_sha: null, tree_sha: null };
  const [headSha] = line.trim().split(/\s+/);
  if (!isShaLike(headSha)) throw new Error("git_repo_remote_branch_probe_invalid_head");
  const treeSha = await fetchRemoteTreeSha({
    runGit,
    remoteUrl,
    branch,
    remoteGitEnv,
  });
  return { exists: true, branch, head_sha: headSha, tree_sha: treeSha };
}

async function fetchRemoteTreeSha({
  runGit = runBoundedGit,
  remoteUrl,
  branch,
  remoteGitEnv = {},
} = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-git-probe-"));
  try {
    const init = await runGit(["init"], { cwd: tempDir, env: remoteGitEnv });
    if (!init.ok) throw new Error("git_repo_remote_tree_probe_init_failed");
    const fetch = await runGit([
      "fetch",
      "--depth=1",
      "--no-tags",
      remoteUrl,
      `refs/heads/${branch}`,
    ], {
      cwd: tempDir,
      env: remoteGitEnv,
    });
    if (!fetch.ok) throw new Error("git_repo_remote_tree_probe_fetch_failed");
    const tree = await runGit(["rev-parse", "FETCH_HEAD^{tree}"], {
      cwd: tempDir,
      env: remoteGitEnv,
    });
    if (!tree.ok) throw new Error("git_repo_remote_tree_probe_rev_parse_failed");
    const treeSha = tree.stdout.trim();
    if (!isShaLike(treeSha)) throw new Error("git_repo_remote_tree_probe_invalid_tree");
    return treeSha;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function ensurePullRequest(ctx, inputs) {
  const adapter = await resolvePrAdapter(ctx, inputs);
  if (typeof adapter.ensurePullRequest !== "function") {
    throw new Error("git_repo_pr_adapter_ensure_missing");
  }
  const result = await adapter.ensurePullRequest({
    title: nonEmptyString(ctx.payload?.pr_title) || nonEmptyString(ctx.artifact?.payload?.pr_title),
    body: stringValue(ctx.payload?.pr_body ?? ctx.artifact?.payload?.pr_body) || "",
    head: inputs.branch,
    base: inputs.defaultBranch,
  });
  return result?.pr || result;
}

async function probePullRequest(ctx, inputs) {
  const adapter = await resolvePrAdapter(ctx, inputs, { allowMissing: true });
  if (!adapter || typeof adapter.probePullRequest !== "function") return null;
  return adapter.probePullRequest({
    head: inputs.branch,
    base: inputs.defaultBranch,
  });
}

async function resolvePrAdapter(ctx, inputs, { allowMissing = false } = {}) {
  if (typeof ctx.prAdapter === "function") return ctx.prAdapter({ repoIdentity: inputs.repoIdentity });
  if (ctx.prAdapter && typeof ctx.prAdapter === "object") return ctx.prAdapter;
  if (typeof ctx.createPrAdapter === "function") return ctx.createPrAdapter({ repoIdentity: inputs.repoIdentity });
  if (typeof ctx.runDeps?.createPrAdapter === "function") {
    return ctx.runDeps.createPrAdapter({ repoIdentity: inputs.repoIdentity });
  }
  try {
    const { createDefaultExecutionPullRequestAdapter } = await import("../linear/src/execution-pr-adapter.mjs");
    return createDefaultExecutionPullRequestAdapter({ repoIdentity: inputs.repoIdentity });
  } catch (error) {
    if (allowMissing) return null;
    throw error;
  }
}

function resolveGitInputs(ctx = {}, { pending = null, requireWorkingDir = true } = {}) {
  const handle = gitRepoHandleFromContext(ctx);
  const pendingGit = pending?.git || null;
  const resourceId = firstNonEmptyString([
    ctx.runContext?.selectedResourceId,
    ctx.runContext?.selectedResource?.id,
    ctx.selectedResourceId,
    ctx.selectedResource?.id,
    ctx.git_repo?.id,
    ctx.gitRepo?.id,
    ctx.resource_id,
    ctx.resourceId,
    pendingGit?.resource_id,
    gitRepoManifestEntry(ctx)?.id,
  ]);
  const runId = nonEmptyString(ctx.runId) || nonEmptyString(ctx.artifact?.run_id) || nonEmptyString(pending?.runId);
  if (!runId) return invalid("git_repo_run_id_required");
  const issueIdentifier = issueIdentifierFromContext(ctx);
  if (!issueIdentifier) return invalid("git_repo_issue_identifier_required");

  let branch;
  try {
    branch = branchNameForIssue(issueIdentifier);
  } catch {
    return invalid("git_repo_branch_invalid");
  }
  if (!branch.startsWith(GIT_REPO_COMMIT_BRANCH_PREFIX)) {
    return invalid("git_repo_branch_not_owned_namespace");
  }

  const defaultBranch = firstNonEmptyString([
    handle.default_branch,
    handle.defaultBranch,
    ctx.repoIdentity?.default_branch,
    ctx.repoIdentity?.defaultBranch,
  ]);
  if (!defaultBranch) return invalid("git_repo_default_branch_required");
  if (branch === defaultBranch) return invalid("git_repo_branch_is_default_branch");

  const baseSha = firstNonEmptyString([
    handle.baseSha,
    handle.base_sha,
    pendingGit?.base_sha,
    ctx.baseSha,
    ctx.base_sha,
  ]);
  if (!baseSha) return invalid("git_repo_base_sha_required");

  const owner = firstNonEmptyString([
    handle.owner,
    pendingGit?.owner,
    ctx.repoIdentity?.owner,
  ]);
  const repo = firstNonEmptyString([
    handle.repo,
    pendingGit?.repo,
    ctx.repoIdentity?.repo,
    ctx.repoIdentity?.name,
  ]);
  if (!owner) return invalid("git_repo_owner_required");
  if (!repo) return invalid("git_repo_repo_required");
  const repoIdentity = {
    owner,
    repo,
    default_branch: defaultBranch,
  };

  const workingDir = firstNonEmptyString([
    handle.workingDir,
    handle.working_dir,
    ctx.workingDir,
    ctx.working_dir,
  ]);
  if (requireWorkingDir && (!workingDir || !fs.existsSync(workingDir))) {
    return invalid("git_repo_working_dir_missing");
  }

  const runGit = ctx.runGit || ctx.runContext?.runGit || runBoundedGit;
  const runContext = ctx.runContext || {};
  // Honor the same offline remote-URL override the materializer uses, so paths
  // that resolve the remote WITHOUT a materializer handle (e.g. the after-push
  // replay that opens the PR for an already-pushed branch) push/probe against
  // the same remote the clone came from. In production the override is absent
  // and this falls through to the real GitHub remote.
  const resolvedRemoteUrl = resolveGitRepoRemoteUrl({
    resource: gitRepoRemoteResourceFromContext({ ctx, resourceId, repoIdentity }),
    repoIdentity,
    runContext,
  });
  const remoteUrl = firstNonEmptyString([
    handle.remoteUrl,
    handle.remote_url,
    ctx.remoteUrl,
    ctx.remote_url,
    ctx.gitRemoteUrl,
    ctx.git_remote_url,
    resolvedRemoteUrl,
  ]);
  if (!remoteUrl) return invalid("git_repo_remote_url_required");
  const localGitEnv = normalizeGitEnv({
    ...(isRecord(handle.envAugment) ? handle.envAugment : {}),
  });
  const remoteGitEnv = gitRemoteEnv({ ctx, remoteUrl });

  return {
    ok: true,
    value: {
      runId,
      issueIdentifier,
      branch,
      baseSha,
      owner,
      repo,
      defaultBranch,
      workingDir,
      remoteUrl,
      repoIdentity,
      resourceId,
      runGit,
      localGitEnv,
      remoteGitEnv,
    },
  };
}

function gitRepoHandleFromContext(ctx = {}) {
  return (
    ctx.runContext?.selectedResource?.handle ||
    ctx.selectedResource?.handle ||
    ctx.git_repo?.handle ||
    ctx.gitRepo?.handle ||
    ctx.gitRepoHandle ||
    {}
  );
}

function gitRepoManifestEntry(ctx = {}) {
  const manifest = Array.isArray(ctx.resourceManifest)
    ? ctx.resourceManifest
    : Array.isArray(ctx.runContext?.resourceManifest)
      ? ctx.runContext.resourceManifest
      : [];
  return manifest.find((entry) => entry?.kind === "git_repo") || null;
}

function gitRepoRemoteResourceFromContext({ ctx = {}, resourceId = null, repoIdentity } = {}) {
  const resource = [
    ctx.runContext?.selectedResource,
    ctx.selectedResource,
    resourceId ? ctx.runContext?.resources?.[resourceId] : null,
    resourceId ? ctx.resources?.[resourceId] : null,
  ].find((candidate) => isRecord(candidate)) || {};
  const binding = isRecord(resource.binding) ? resource.binding : {};
  return {
    ...resource,
    id: nonEmptyString(resource.id) || resourceId,
    kind: nonEmptyString(resource.kind) || "git_repo",
    binding: {
      ...binding,
      owner: nonEmptyString(binding.owner) || repoIdentity.owner,
      repo: nonEmptyString(binding.repo) || repoIdentity.repo,
      default_branch:
        nonEmptyString(binding.default_branch) ||
        nonEmptyString(binding.defaultBranch) ||
        repoIdentity.default_branch,
    },
  };
}

async function readPendingGitIntent(ctx = {}) {
  if (ctx.pending?.git) return ctx.pending;
  if (ctx.pendingGitIntent?.git) return ctx.pendingGitIntent;
  if (ctx.gitIntent?.git) return ctx.gitIntent;

  const teamRef = teamRefFromContext(ctx);
  const objectId = issueIdFromContext(ctx);
  if (!teamRef || !objectId) return null;
  try {
    const { readGitReplayPending } = await import("../linear/src/trigger-idempotency.mjs");
    return readGitReplayPending({
      teamRef,
      objectId,
      repoRoot: ctx.repoRoot || process.cwd(),
      runStoreDir: ctx.runStoreDir || null,
    });
  } catch {
    return null;
  }
}

async function persistGitIntent(ctx, git) {
  const artifactKind = ctx.artifact?.kind || "commit";
  const runId = ctx.runId || ctx.artifact?.run_id;
  if (typeof ctx.store?.markMutationStarted === "function") {
    const result = await ctx.store.markMutationStarted({
      wakeId: ctx.wake?.id,
      runnerId: ctx.runnerId,
      leaseToken: ctx.leaseToken,
      runId,
      artifactKind,
      git,
    });
    if (!result?.ok) throw new Error(result?.reason || "git_repo_mutation_intent_write_failed");
    if (result.wake) ctx.wake = result.wake;
    return result;
  }

  const teamRef = teamRefFromContext(ctx);
  const objectId = issueIdFromContext(ctx);
  const wakeId = ctx.wake?.id || ctx.traceContext?.wake_id || ctx.artifact?.wake_id;
  if (!teamRef || !objectId || !runId || !wakeId) {
    throw new Error("git_repo_mutation_intent_store_unavailable");
  }
  const { writeMutationIntent } = await import("../linear/src/trigger-idempotency.mjs");
  return writeMutationIntent({
    teamRef,
    objectType: "issue",
    objectId,
    runId,
    artifactKind,
    wakeId,
    startedAt: new Date().toISOString(),
    workflowType: ctx.wake?.workflow_type || "execution",
    triggerType: ctx.wake?.trigger_type || "linear.issue.ready",
    git,
    repoRoot: ctx.repoRoot || process.cwd(),
    runStoreDir: ctx.runStoreDir || null,
  });
}

async function clearGitIntent(ctx = {}, { runId: runIdOverride = null } = {}) {
  const teamRef = teamRefFromContext(ctx);
  const objectId = issueIdFromContext(ctx);
  const runId = runIdOverride || ctx.runId || ctx.artifact?.run_id;
  if (!teamRef || !objectId || !runId) return { cleared: false, reason: "git_repo_intent_clear_scope_missing" };
  const { clearMutationIntent } = await import("../linear/src/trigger-idempotency.mjs");
  return clearMutationIntent({
    teamRef,
    objectType: "issue",
    objectId,
    runId,
    repoRoot: ctx.repoRoot || process.cwd(),
    runStoreDir: ctx.runStoreDir || null,
  });
}

async function clearPriorDifferentRunGitIntent(ctx, pending, inputs) {
  if (!pending?.git || !pending.runId || pending.runId === inputs.runId) return { cleared: false };
  return clearGitIntent(ctx, { runId: pending.runId });
}

function prePushGitIdentity(inputs) {
  return {
    owner: inputs.owner,
    repo: inputs.repo,
    branch: inputs.branch,
    base_sha: inputs.baseSha,
    ...(inputs.resourceId ? { resource_id: inputs.resourceId } : {}),
  };
}

function observedGitIdentity(inputs, remoteBranch) {
  return {
    ...prePushGitIdentity(inputs),
    head_sha: remoteBranch.head_sha,
    tree_sha: remoteBranch.tree_sha,
  };
}

function gitRepoCommitIdentity({ inputs, remoteBranch, pullRequest }) {
  return {
    ...(inputs.resourceId ? { resource_id: inputs.resourceId } : {}),
    owner: inputs.owner,
    repo: inputs.repo,
    repo_identity: inputs.repoIdentity,
    branch: inputs.branch,
    base_sha: inputs.baseSha,
    head_sha: remoteBranch?.head_sha || null,
    tree_sha: remoteBranch?.tree_sha || null,
    pull_request: pullRequest || null,
  };
}

async function localHeadSha(inputs) {
  const head = await inputs.runGit(["rev-parse", "HEAD"], {
    cwd: inputs.workingDir,
    env: inputs.localGitEnv,
  });
  return head.ok ? head.stdout.trim() : null;
}

function commitMessage(ctx, inputs) {
  const issueKey = firstNonEmptyString([
    ctx.issue?.identifier,
    ctx.issue?.key,
    ctx.issueId,
    ctx.artifact?.linear_issue_id,
  ]);
  const title = nonEmptyString(ctx.payload?.pr_title) || nonEmptyString(ctx.artifact?.payload?.pr_title) || "Execution work";
  const subjectPrefix = issueKey ? `${issueKey}: ` : "";
  return [
    `${subjectPrefix}${title}`,
    "",
    `Teami execution run: ${inputs.runId}`,
  ].join("\n");
}

function resolveCommitAuthor(ctx = {}) {
  const candidates = [
    ctx.gitAuthor,
    ctx.config?.git?.execution_author,
    ctx.config?.git?.author,
    ctx.config?.workflows?.execution?.git?.author,
    ctx.config?.workflows?.execution?.git_author,
    ctx.config?.execution?.git_author,
  ];
  for (const candidate of candidates) {
    const name = nonEmptyString(candidate?.name);
    const email = nonEmptyString(candidate?.email);
    if (name && email) return { name, email };
  }
  return { ...DEFAULT_AF_COMMIT_AUTHOR };
}

function diffBudgetFromContext(ctx = {}) {
  return (
    ctx.gitRepoDiffBudget ||
    ctx.git_repo_diff_budget ||
    ctx.config?.git?.execution_diff_budget ||
    ctx.config?.workflows?.execution?.git?.diff_budget ||
    DEFAULT_GIT_REPO_DIFF_BUDGET
  );
}

function normalizeDiffBudget(budget = DEFAULT_GIT_REPO_DIFF_BUDGET) {
  return {
    maxChangedFiles: positiveInteger(budget.maxChangedFiles ?? budget.max_changed_files, DEFAULT_GIT_REPO_DIFF_BUDGET.maxChangedFiles),
    maxTotalBytes: positiveInteger(budget.maxTotalBytes ?? budget.max_total_bytes, DEFAULT_GIT_REPO_DIFF_BUDGET.maxTotalBytes),
    maxDeletionRatio: positiveNumber(budget.maxDeletionRatio ?? budget.max_deletion_ratio, DEFAULT_GIT_REPO_DIFF_BUDGET.maxDeletionRatio),
    minDeletedLinesForRatio: positiveInteger(
      budget.minDeletedLinesForRatio ?? budget.min_deleted_lines_for_ratio,
      DEFAULT_GIT_REPO_DIFF_BUDGET.minDeletedLinesForRatio,
    ),
  };
}

function gitRemoteEnv({ ctx = {}, remoteUrl }) {
  return gitRemoteAuthEnv({
    baseEnv: ctx.remoteGitEnv || ctx.gitRemoteEnv || {},
    remoteUrl,
    token: nonEmptyString(ctx.githubToken),
  });
}

async function runEffectKillPoint(ctx, point) {
  if (ctx.killPoint !== point) return;
  if (typeof ctx.runDeps?.killPoint === "function") {
    await ctx.runDeps.killPoint(point, ctx);
    return;
  }
  if (typeof ctx.killPointHandler === "function") {
    await ctx.killPointHandler(point, ctx);
  }
}

function createEmptyHooksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-empty-hooks-"));
}

function issueIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.issueId,
    ctx.issue_id,
    ctx.linearIssueId,
    ctx.linear_issue_id,
    ctx.issue?.id,
    ctx.artifact?.linear_issue_id,
    ctx.artifact?.payload?.linear_issue_id,
    ctx.payload?.linear_issue_id,
    ctx.wake?.object_id,
  ]);
}

function issueIdentifierFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.issueIdentifier,
    ctx.issue_identifier,
    ctx.issue?.identifier,
  ]);
}

function teamRefFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.teamContext?.teamRef,
    ctx.teamContext?.team_ref,
    ctx.artifact?.team_ref,
    ctx.wake?.team_ref,
  ]);
}

function hasObservedGitHeadTree(git) {
  return Boolean(nonEmptyString(git?.head_sha) && nonEmptyString(git?.tree_sha));
}

function hasObservedGitHead(git) {
  return Boolean(nonEmptyString(git?.head_sha));
}

function remoteMatchesGitIdentity(remoteBranch, git) {
  if (remoteBranch?.exists !== true) return false;
  if (remoteBranch.head_sha !== git?.head_sha) return false;
  const treeSha = nonEmptyString(git?.tree_sha);
  return !treeSha || remoteBranch.tree_sha === treeSha;
}

async function pendingGitOwnsRemoteBranch({ pending, inputs, remoteBranch }) {
  if (!pending?.git || pending.git.branch !== inputs.branch) {
    return { ok: false, reason: "git_repo_remote_branch_not_owned" };
  }
  if (!hasObservedGitHead(pending.git)) {
    return { ok: false, reason: "git_repo_pending_observed_identity_missing" };
  }
  if (
    !remoteMatchesGitIdentity(remoteBranch, pending.git) &&
    !await remoteDescendsFromGitIdentity({ inputs, remoteBranch, git: pending.git })
  ) {
    return { ok: false, reason: "git_repo_remote_branch_not_owned" };
  }
  return { ok: true };
}

// A remote head that strictly descends from the factory's recorded head means
// the factory's work is intact underneath additions a person pushed to the
// branch — the factory collaborates on top of them instead of failing closed.
// Ancestry is answered from the local checkout, whose materialization proved
// the same descent; when the objects are absent (worktree gone, or the remote
// moved again mid-run) this answers false and the caller stays fail-closed —
// the plain (non-force) push remains the final collision guard either way.
async function remoteDescendsFromGitIdentity({ inputs, remoteBranch, git }) {
  const recordedHead = nonEmptyString(git?.head_sha);
  const remoteHead = nonEmptyString(remoteBranch?.head_sha);
  if (!recordedHead || !remoteHead || recordedHead === remoteHead) return false;
  if (!inputs?.workingDir || !fs.existsSync(inputs.workingDir)) return false;
  const ancestry = await inputs.runGit(["merge-base", "--is-ancestor", recordedHead, remoteHead], {
    cwd: inputs.workingDir,
    env: inputs.localGitEnv,
  });
  return ancestry.ok === true;
}

function pendingRunMatchesCurrent(pending, inputs) {
  return pending?.runId === inputs.runId;
}

function terminalFailure(reason) {
  return { ok: false, terminal: true, reason };
}

function pendingFailure(reason) {
  return { ok: false, reason };
}

function errorReason(error, fallback) {
  return nonEmptyString(error?.reason) || nonEmptyString(error?.message)?.split(/\r?\n/)[0] || fallback;
}

function parseNumstatCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isShaLike(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function normalizeGitEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const string = nonEmptyString(value);
    if (string) return string;
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reason) {
  return { ok: false, reason };
}
