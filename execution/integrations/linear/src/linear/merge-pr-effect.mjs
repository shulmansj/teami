import { AF_REVIEW_STATUS_CONTEXT } from "../execution-pr-adapter.mjs";
import { decideMergeGateAction } from "./merge-gate-decision.mjs";
import { issueHasLabel } from "./matching-utils.mjs";

export const MERGE_PR_EFFECT_ID = "merge_pr";
export const MERGE_PR_OP = "merge_pr";

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);

export const mergePrEffect = Object.freeze({
  id: MERGE_PR_EFFECT_ID,
  provider: "github",
  op: MERGE_PR_OP,
  probe: probeMergePrEffect,
  apply: applyMergePrEffect,
  verify: verifyMergePrEffect,
});

export function mergePrEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...mergePrEffect,
    ...overrides,
  });
}

export async function readMergeGateSnapshot(ctx = {}) {
  return (await readMergeGateSnapshotRecord(ctx)).snapshot;
}

export async function probeMergePrEffect(ctx = {}) {
  const read = await readDecision(ctx);
  if (!read.ok) return { satisfied: false, reason: read.reason };

  const { decision } = read;
  return {
    satisfied: false,
    reason: decision.reason || `merge gate action is ${decision.action}`,
  };
}

export async function applyMergePrEffect(ctx = {}) {
  const read = await readDecision(ctx);
  if (!read.ok) return terminalFailure(read.reason);

  const { decision, snapshot, issueId, prNumber } = read;
  if (decision.action === "none" && decision.deleteParkRecord === true) {
    // Delete rows cover both the already-landed head and a dead closed-unmerged
    // record; only an actually merged PR finishes "merged" bookkeeping here.
    if (snapshot.prState !== "merged") {
      return terminalFailure(`merge_pr_not_allowed: ${decision.action}: ${decision.reason}`);
    }
    return finishMergedCleanup({
      ctx,
      issueId,
      prNumber,
      headSha: snapshot.currentHeadSha,
      reason: decision.reason,
    });
  }

  if (decision.action !== "merge") {
    return terminalFailure(`merge_pr_not_allowed: ${decision.action}: ${decision.reason}`);
  }

  const adapter = resolvePrAdapter(ctx, ["mergePullRequest"]);
  if (!adapter.ok) return terminalFailure(adapter.reason);

  try {
    const result = await adapter.value.mergePullRequest({
      number: prNumber,
      expectedHeadSha: snapshot.currentHeadSha,
    });
    if (result?.merged !== true) {
      return recordFailedMergeAndStop({
        ctx,
        issueId,
        prNumber,
        headSha: snapshot.currentHeadSha,
        reason: mergeReturnedUnmergedReason(result),
      });
    }
  } catch (error) {
    const reason = knownMergeRequestFailureReason(error);
    if (!reason) throw error;
    return recordFailedMergeAndStop({
      ctx,
      issueId,
      prNumber,
      headSha: snapshot.currentHeadSha,
      reason,
    });
  }

  ctx.mergePrAttempt = {
    issueId,
    prNumber,
    headSha: snapshot.currentHeadSha,
    reason: decision.reason,
  };
  return {
    ok: true,
    identity: mergePrIdentity({
      issueId,
      prNumber,
      headSha: snapshot.currentHeadSha,
      outcome: "merge_requested",
    }),
  };
}

export async function verifyMergePrEffect(ctx = {}) {
  if (ctx.mergePrCleanupIdentity) {
    return { ok: true, identity: ctx.mergePrCleanupIdentity };
  }

  const attempt = ctx.mergePrAttempt;
  if (!attempt) return terminalFailure("merge_pr_attempt_missing");

  const adapter = resolvePrAdapter(ctx, ["getPullRequest"]);
  if (!adapter.ok) return terminalFailure(adapter.reason);

  const pullRequest = await adapter.value.getPullRequest(attempt.prNumber);
  const headSha = pullRequestHeadSha(pullRequest);
  if (headSha !== attempt.headSha) {
    return terminalFailure("merge_pr_landed_different_head");
  }
  if (derivePrState(pullRequest) !== "merged") {
    return { ok: false, reason: "merge_pr_landing_not_observed" };
  }

  return finishMergedCleanup({
    ctx,
    issueId: attempt.issueId,
    prNumber: attempt.prNumber,
    headSha: attempt.headSha,
    reason: "parked head merged",
  });
}

async function readDecision(ctx = {}) {
  try {
    const record = await readMergeGateSnapshotRecord(ctx);
    return {
      ok: true,
      ...record,
      decision: decideMergeGateAction(record.snapshot),
    };
  } catch (error) {
    return { ok: false, reason: error?.message || "merge_gate_snapshot_read_failed" };
  }
}

async function readMergeGateSnapshotRecord(ctx = {}) {
  const issueId = issueIdFromContext(ctx);
  if (!issueId) throw new Error("merge_gate_issue_id_missing");

  const store = resolveStore(ctx, ["parkRecords"]);
  if (!store.ok) throw new Error(store.reason);

  const issue = await readFreshIssue(ctx, issueId);
  const parkRecord = await store.value.parkRecords({ issueId });
  const prNumber = parkRecord?.pr_number || prNumberFromContext(ctx);
  if (!prNumber) throw new Error("merge_gate_pr_number_missing");

  const adapter = resolvePrAdapter(ctx, ["getPullRequest", "getCommitStatuses"]);
  if (!adapter.ok) throw new Error(adapter.reason);

  const pullRequest = await adapter.value.getPullRequest(prNumber);
  const currentHeadSha = pullRequestHeadSha(pullRequest);
  const statuses = await adapter.value.getCommitStatuses(currentHeadSha);
  const latestStatus = latestAfReviewStatus(statuses);
  const checkState = checkStateForAfReviewStatus(latestStatus);
  const issueStatusRole = issueStatusRoleFromContext(ctx, issue);
  const gateLabelId = humanReviewLabelIdFromContext(ctx);
  if (!gateLabelId) throw new Error("merge_gate_human_review_label_missing");

  return {
    issueId,
    prNumber,
    snapshot: Object.freeze({
      issueStatusRole,
      gateLabelPresent: issueHasLabel(issue, gateLabelId),
      parkRecord: parkRecord
        ? {
            parked_head_sha: parkRecord.parked_head_sha,
            pr_number: parkRecord.pr_number,
          }
        : null,
      currentHeadSha,
      checkState,
      checkHeadSha: checkState === "absent" ? null : currentHeadSha,
      prState: derivePrState(pullRequest),
    }),
  };
}

async function readFreshIssue(ctx, issueId) {
  let issue = null;
  if (typeof ctx.client?.getIssue === "function") issue = await ctx.client.getIssue(issueId);
  else if (typeof ctx.client?.getIssueContext === "function") issue = await ctx.client.getIssueContext(issueId);
  else throw new Error("merge_gate_linear_issue_read_unavailable");
  if (!issue?.id) throw new Error("merge_gate_linear_issue_missing");
  return issue;
}

async function finishMergedCleanup({ ctx, issueId, prNumber, headSha, reason }) {
  const recorded = await recordMergeOutcome(ctx, {
    issue_id: issueId,
    pr_number: prNumber,
    head_sha: headSha,
    outcome: "merged",
    reason: reason || "merged",
  });
  if (!recorded.ok) return terminalFailure(recorded.reason);

  const deleted = await deleteParkRecord(ctx, issueId);
  if (!deleted.ok) return terminalFailure(deleted.reason);

  const identity = mergePrIdentity({
    issueId,
    prNumber,
    headSha,
    outcome: "merged",
  });
  ctx.mergePrCleanupIdentity = identity;
  return { ok: true, identity };
}

async function recordFailedMergeAndStop({ ctx, issueId, prNumber, headSha, reason }) {
  const recorded = await recordMergeOutcome(ctx, {
    issue_id: issueId,
    pr_number: prNumber,
    head_sha: headSha,
    outcome: "failed",
    reason,
  });
  if (!recorded.ok) return terminalFailure(recorded.reason);
  return terminalFailure(reason);
}

async function recordMergeOutcome(ctx, mergeOutcome) {
  const store = resolveStore(ctx, ["recordMergeOutcome"]);
  if (!store.ok) return store;
  const wakeId = wakeIdFromContext(ctx);
  const runId = runIdFromContext(ctx);
  if (!wakeId) return { ok: false, reason: "merge_outcome_wake_id_missing" };
  if (!runId) return { ok: false, reason: "merge_outcome_run_id_missing" };

  try {
    const result = await store.value.recordMergeOutcome({
      wakeId,
      runId,
      merge_outcome: {
        ...mergeOutcome,
        observed_at: observedAt(ctx),
      },
    });
    if (result?.ok === false) return { ok: false, reason: result.reason || "merge_outcome_record_failed" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || "merge_outcome_record_failed" };
  }
}

async function deleteParkRecord(ctx, issueId) {
  const store = resolveStore(ctx, ["deleteParkRecord"]);
  if (!store.ok) return store;
  try {
    const result = await store.value.deleteParkRecord(issueId);
    if (result?.ok === false) return { ok: false, reason: result.reason || "park_record_delete_failed" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || "park_record_delete_failed" };
  }
}

function issueStatusRoleFromContext(ctx, issue) {
  const stateId = firstNonEmptyString([issue?.state?.id, issue?.stateId, issue?.state_id]);
  if (!stateId) return null;
  for (const role of ISSUE_STATUS_ROLES) {
    if (statusIdForRole(ctx, role) === stateId) return role;
  }
  return null;
}

function statusIdForRole(ctx, role) {
  const fromShape = ctx.shape?.issueStatuses?.[role];
  const shapeId = typeof fromShape === "string" ? fromShape : fromShape?.id;
  if (shapeId) return shapeId;

  const cache = ctx.cache || ctx.linearCache || null;
  const fromCache = cache?.issueStatuses?.[role];
  return typeof fromCache === "string" && fromCache.trim() !== "" ? fromCache.trim() : null;
}

function humanReviewLabelIdFromContext(ctx) {
  const shapeId = ctx.shape?.issueLabels?.human_review?.id;
  if (shapeId) return shapeId;

  const cache = ctx.cache || ctx.linearCache || null;
  const labelName = ctx.config?.linear?.issue?.labels?.human_review;
  const cachedByName = labelName ? cache?.issueLabels?.[labelName] : null;
  if (cachedByName) return cachedByName;
  return cache?.issueLabels?.human_review || null;
}

function latestAfReviewStatus(statuses) {
  if (!Array.isArray(statuses)) return null;
  let latest = null;
  statuses.forEach((status, index) => {
    if (!status || typeof status !== "object" || Array.isArray(status)) return;
    if (status.context !== AF_REVIEW_STATUS_CONTEXT || !status.state) return;
    const candidate = {
      status,
      index,
      time: timestamp(status.created_at),
    };
    if (!latest || isLaterStatus(candidate, latest)) latest = candidate;
  });
  return latest?.status || null;
}

function isLaterStatus(left, right) {
  const leftHasTime = Number.isFinite(left.time);
  const rightHasTime = Number.isFinite(right.time);
  if (leftHasTime && rightHasTime && left.time !== right.time) return left.time > right.time;
  if (leftHasTime !== rightHasTime) return leftHasTime;
  return left.index < right.index;
}

function checkStateForAfReviewStatus(status) {
  if (!status) return "absent";
  if (status.state === "success") return "green";
  if (status.state === "failure" || status.state === "error") return "red";
  return "absent";
}

function derivePrState(pullRequest) {
  const state = firstNonEmptyString([pullRequest?.state])?.toLowerCase();
  if (state === "open") return "open";
  if (state === "closed") {
    if (pullRequest?.merged === true || pullRequest?.merged_at != null) return "merged";
    return "closed";
  }
  throw new Error(`merge_gate_pr_state_unrecognized:${state || "missing"}`);
}

function pullRequestHeadSha(pullRequest) {
  const headSha = firstNonEmptyString([
    pullRequest?.head?.sha,
    pullRequest?.head_sha,
    pullRequest?.headSha,
  ]);
  if (!headSha || hasUnsafeShaCharacters(headSha)) {
    throw new Error("merge_gate_pr_head_sha_missing");
  }
  return headSha;
}

function knownMergeRequestFailureReason(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.github?.status);
  if (status === 405) return "GitHub refused the merge because the PR was not mergeable.";
  if (status === 409) return "GitHub refused the merge because the PR head no longer matched the expected head sha.";
  return null;
}

function mergeReturnedUnmergedReason(result) {
  const detail = firstNonEmptyString([result?.message, result?.reason]);
  return detail
    ? `GitHub returned merged:false for the merge request: ${oneLine(detail)}`
    : "GitHub returned merged:false for the merge request.";
}

function mergePrIdentity({ issueId, prNumber, headSha, outcome }) {
  return {
    issue_id: issueId,
    linear_issue_id: issueId,
    pr_number: prNumber,
    head_sha: headSha,
    outcome,
  };
}

function resolveStore(ctx, methods = []) {
  const store = ctx.store;
  if (!store || typeof store !== "object") return { ok: false, reason: "merge_gate_store_missing" };
  for (const method of methods) {
    if (typeof store[method] !== "function") {
      return { ok: false, reason: `merge_gate_store_${method}_missing` };
    }
  }
  return { ok: true, value: store };
}

function resolvePrAdapter(ctx, methods = []) {
  const adapter = ctx.prAdapter;
  if (!adapter || typeof adapter !== "object") return { ok: false, reason: "merge_gate_pr_adapter_missing" };
  for (const method of methods) {
    if (typeof adapter[method] !== "function") {
      return { ok: false, reason: `merge_gate_pr_adapter_${method}_missing` };
    }
  }
  return { ok: true, value: adapter };
}

function issueIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.merge?.issue_id,
    ctx.merge?.issueId,
    ctx.mergeGate?.issue_id,
    ctx.mergeGate?.issueId,
    ctx.issueId,
    ctx.issue_id,
    ctx.linearIssueId,
    ctx.linear_issue_id,
    ctx.issue?.id,
    ctx.linearIssue?.id,
    ctx.targetIssue?.id,
    ctx.artifact?.linear_issue_id,
    ctx.artifact?.issue_id,
    ctx.artifact?.payload?.linear_issue_id,
    ctx.artifact?.payload?.issue_id,
    ctx.payload?.linear_issue_id,
    ctx.payload?.issue_id,
  ]);
}

function prNumberFromContext(ctx = {}) {
  return positiveInteger([
    ctx.merge?.pr_number,
    ctx.merge?.prNumber,
    ctx.mergeGate?.pr_number,
    ctx.mergeGate?.prNumber,
    ctx.prNumber,
    ctx.pr_number,
    ctx.pullRequestNumber,
    ctx.pull_request_number,
    ctx.pr?.number,
    ctx.pullRequest?.number,
    ctx.review?.number,
    ctx.artifact?.pr_number,
    ctx.artifact?.prNumber,
    ctx.artifact?.payload?.pr_number,
    ctx.artifact?.payload?.prNumber,
    ctx.payload?.pr_number,
    ctx.payload?.prNumber,
  ]);
}

function wakeIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.wakeId,
    ctx.wake_id,
    ctx.wake?.id,
    ctx.artifact?.wake_id,
    ctx.artifact?.wakeId,
  ]);
}

function runIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.runId,
    ctx.run_id,
    ctx.artifact?.run_id,
    ctx.artifact?.runId,
  ]);
}

function observedAt(ctx = {}) {
  const value = typeof ctx.now === "function" ? ctx.now() : new Date();
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function positiveInteger(values) {
  for (const value of values) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function terminalFailure(reason) {
  return { ok: false, terminal: true, reason };
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function hasUnsafeShaCharacters(value) {
  return /[\x00-\x20\x7f/\\?#]/.test(String(value || ""));
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}
