import { LINEAR_ISSUE_IN_REVIEW_EFFECT_ID } from "../workflows/execution/effect-ids.mjs";
import { resolveInReviewIssueStatus } from "./shape-resolver.mjs";

export const ISSUE_IN_REVIEW_OP = "move_issue_in_review";

export const issueInReviewEffect = Object.freeze({
  id: LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
  provider: "linear",
  op: ISSUE_IN_REVIEW_OP,
  probe: probeIssueInReviewEffect,
  apply: applyIssueInReviewEffect,
  verify: verifyIssueInReviewEffect,
});

export function issueInReviewEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...issueInReviewEffect,
    ...overrides,
  });
}

export async function probeIssueInReviewEffect(ctx = {}) {
  const resolved = await safelyResolveInReviewTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return { satisfied: false, reason: resolved.reason || "linear_issue_in_review_target_missing" };
  }

  const issue = await readIssueFromContext(ctx);
  if (!issue) return { satisfied: false, reason: "linear_issue_missing" };
  if (!issueMatchesInReviewTarget(issue, resolved.target)) {
    return { satisfied: false, reason: "linear_issue_not_in_review" };
  }

  return {
    satisfied: true,
    identity: issueInReviewIdentity({
      issue,
      issueId: issue.id,
      target: resolved.target,
    }),
  };
}

export async function applyIssueInReviewEffect(ctx = {}) {
  const issueId = issueIdFromExecutionContext(ctx);
  if (!issueId) {
    return { ok: false, terminal: true, reason: "linear_issue_id_missing" };
  }
  if (typeof ctx.client?.updateIssue !== "function") {
    return { ok: false, terminal: true, reason: "linear_update_issue_unavailable" };
  }

  const resolved = await safelyResolveInReviewTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return {
      ok: false,
      terminal: true,
      reason: resolved.reason || "linear_issue_in_review_target_missing",
    };
  }

  const target = resolved.target;
  const input = await issueInReviewUpdateInput({ target });
  await ctx.onBeforeLinearMutation?.({
    artifactKind: ctx.artifact?.kind || null,
    runId: ctx.runId || ctx.artifact?.run_id || null,
    trace: ctx.trace,
    effectId: LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
  });
  const issue = await ctx.client.updateIssue(issueId, input);
  const identity = issueInReviewIdentity({ issue, issueId, target });
  ctx.issueInReviewAppliedIdentity = identity;
  return { ok: true, identity };
}

export async function verifyIssueInReviewEffect(ctx = {}) {
  if (ctx.issueInReviewAppliedIdentity) {
    return { ok: true, identity: ctx.issueInReviewAppliedIdentity };
  }

  const issueId = issueIdFromExecutionContext(ctx);
  if (!issueId) return { ok: false, terminal: true, reason: "linear_issue_id_missing" };

  const resolved = await safelyResolveInReviewTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return {
      ok: false,
      terminal: true,
      reason: resolved.reason || "linear_issue_in_review_target_missing",
    };
  }

  const issue = await readIssueFromContext(ctx);
  if (!issue) return { ok: false, reason: "linear_issue_missing" };
  if (!issueMatchesInReviewTarget(issue, resolved.target)) {
    return { ok: false, reason: "linear_issue_not_in_review" };
  }

  return {
    ok: true,
    identity: issueInReviewIdentity({ issue, issueId, target: resolved.target }),
  };
}

export function issueMatchesInReviewTarget(issue, target) {
  const normalizedTarget = normalizeInReviewIssueTarget(target);
  if (!issue || !normalizedTarget) return false;
  return issue.state?.id === normalizedTarget.id;
}

export function issueIdFromExecutionContext(ctx = {}) {
  return firstNonEmptyString([
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

export function normalizeInReviewIssueTarget(target) {
  if (!target?.id) return null;
  const targetType =
    target.targetType ||
    target.target_type ||
    (target.type ? "status" : null);
  if (targetType !== "status") return null;
  return {
    ...target,
    targetType: "status",
  };
}

async function issueInReviewUpdateInput({ target }) {
  return { stateId: target.id };
}

async function readIssueFromContext(ctx = {}) {
  const issueId = issueIdFromExecutionContext(ctx);
  if (!issueId) return null;
  if (typeof ctx.client?.getIssue === "function") {
    const issue = await ctx.client.getIssue(issueId);
    if (issue) return issue;
  }
  if (typeof ctx.client?.getIssueContext === "function") {
    const issue = await ctx.client.getIssueContext(issueId);
    if (issue) return issue;
  }
  for (const issue of [ctx.issue, ctx.linearIssue, ctx.targetIssue]) {
    if (issue?.id === issueId) return issue;
  }
  return null;
}

async function safelyResolveInReviewTarget(ctx = {}) {
  try {
    const target = await resolveInReviewIssueStatus(
      ctx.client,
      ctx.config,
      teamIdFromContext(ctx),
      ctx.cache,
    );
    return { ok: true, target: normalizeInReviewIssueTarget(target) };
  } catch (error) {
    return { ok: false, reason: error?.message || "linear_issue_in_review_target_resolution_failed" };
  }
}

function teamIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.teamId,
    ctx.team_id,
    ctx.shape?.team?.id,
    ctx.teamContext?.linear?.teamId,
    ctx.issue?.teamId,
    ctx.issue?.team?.id,
    ctx.linearIssue?.teamId,
    ctx.linearIssue?.team?.id,
    ctx.targetIssue?.teamId,
    ctx.targetIssue?.team?.id,
  ]);
}

function issueInReviewIdentity({ issue, issueId, target }) {
  const normalizedTarget = normalizeInReviewIssueTarget(target);
  const stateId = normalizedTarget?.id || issue?.state?.id || null;
  return {
    linear_issue_id: issue?.id || issueId,
    issue_id: issue?.id || issueId,
    issue_key: firstNonEmptyString([issue?.identifier, issue?.key]),
    target_type: normalizedTarget?.targetType || null,
    target_id: normalizedTarget?.id || null,
    status: firstNonEmptyString([normalizedTarget?.name, issue?.state?.name, "In Review"]),
    status_id: stateId,
    state_id: stateId,
  };
}

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
