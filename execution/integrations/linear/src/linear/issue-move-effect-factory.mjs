import { issueHasLabel } from "./matching-utils.mjs";

export function createIssueMoveEffect({
  id,
  op,
  resolveTarget,
  appliedIdentityKey,
  targetMissingReason,
  targetResolutionFailedReason,
  notAppliedReason,
  defaultStatusName,
  terminal = false,
} = {}) {
  if (!id) throw new Error("linear_issue_move_effect_id_required");
  if (!op) throw new Error("linear_issue_move_effect_op_required");
  if (typeof resolveTarget !== "function") throw new Error("linear_issue_move_target_resolver_required");

  async function probe(ctx = {}) {
    const resolved = await safelyResolveTarget(ctx);
    if (!resolved.ok || !resolved.target) {
      return { satisfied: false, reason: resolved.reason || targetMissingReason };
    }

    const issue = await readIssueFromContext(ctx);
    if (!issue) return { satisfied: false, reason: "linear_issue_missing" };
    if (!issueMatchesMoveTarget(issue, resolved.target)) {
      return { satisfied: false, reason: notAppliedReason };
    }

    return {
      satisfied: true,
      identity: issueMoveIdentity({
        issue,
        issueId: issue.id,
        target: resolved.target,
        defaultStatusName,
      }),
    };
  }

  async function apply(ctx = {}) {
    const issueId = issueIdFromIssueMoveContext(ctx);
    if (!issueId) {
      return { ok: false, terminal: true, reason: "linear_issue_id_missing" };
    }
    if (typeof ctx.client?.updateIssue !== "function") {
      return { ok: false, terminal: true, reason: "linear_update_issue_unavailable" };
    }

    const resolved = await safelyResolveTarget(ctx);
    if (!resolved.ok || !resolved.target) {
      return {
        ok: false,
        terminal: true,
        reason: resolved.reason || targetMissingReason,
      };
    }

    await ctx.onBeforeLinearMutation?.({
      artifactKind: ctx.artifact?.kind || null,
      runId: ctx.runId || ctx.artifact?.run_id || null,
      trace: ctx.trace,
      effectId: id,
    });

    const target = resolved.target;
    const input = await issueMoveUpdateInput({ ctx, target });
    const issue = await ctx.client.updateIssue(issueId, input);
    const identity = issueMoveIdentity({ issue, issueId, target, defaultStatusName });
    if (appliedIdentityKey) ctx[appliedIdentityKey] = identity;
    return { ok: true, identity };
  }

  async function verify(ctx = {}) {
    if (appliedIdentityKey && ctx[appliedIdentityKey]) {
      return { ok: true, identity: ctx[appliedIdentityKey] };
    }

    const issueId = issueIdFromIssueMoveContext(ctx);
    if (!issueId) return { ok: false, terminal: true, reason: "linear_issue_id_missing" };

    const resolved = await safelyResolveTarget(ctx);
    if (!resolved.ok || !resolved.target) {
      return {
        ok: false,
        terminal: true,
        reason: resolved.reason || targetMissingReason,
      };
    }

    const issue = await readIssueFromContext(ctx);
    if (!issue) return { ok: false, reason: "linear_issue_missing" };
    if (!issueMatchesMoveTarget(issue, resolved.target)) {
      return { ok: false, reason: notAppliedReason };
    }

    return {
      ok: true,
      identity: issueMoveIdentity({ issue, issueId, target: resolved.target, defaultStatusName }),
    };
  }

  async function safelyResolveTarget(ctx = {}) {
    try {
      const target = await resolveTarget(ctx);
      return { ok: true, target: normalizeIssueMoveTarget(target) };
    } catch (error) {
      return { ok: false, reason: error?.message || targetResolutionFailedReason };
    }
  }

  const effect = Object.freeze({
    id,
    provider: "linear",
    op,
    ...(terminal ? { terminal: true } : {}),
    probe,
    apply,
    verify,
  });

  return Object.freeze({
    effect,
    descriptor(overrides = {}) {
      return Object.freeze({
        ...effect,
        ...overrides,
      });
    },
    probe,
    apply,
    verify,
  });
}

export function issueMatchesMoveTarget(issue, target) {
  const normalizedTarget = normalizeIssueMoveTarget(target);
  if (!issue || !normalizedTarget) return false;
  if (normalizedTarget.targetType === "status") {
    return issue.state?.id === normalizedTarget.id;
  }
  if (normalizedTarget.targetType === "label") {
    return issueHasLabel(issue, normalizedTarget.id);
  }
  return false;
}

export function issueIdFromIssueMoveContext(ctx = {}) {
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

export function normalizeIssueMoveTarget(target) {
  if (!target?.id) return null;
  const targetType =
    target.targetType ||
    target.target_type ||
    (target.type ? "status" : "label");
  if (!["status", "label"].includes(targetType)) return null;
  return {
    ...target,
    targetType,
  };
}

async function issueMoveUpdateInput({ ctx, target }) {
  if (target.targetType === "status") {
    return { stateId: target.id };
  }

  const issue = await readIssueFromContext(ctx);
  if (!issue) {
    throw new Error("linear_issue_missing");
  }
  const labelIds = new Set((issue.labels || []).map((label) => label.id).filter(Boolean));
  labelIds.add(target.id);
  return { labelIds: [...labelIds] };
}

async function readIssueFromContext(ctx = {}) {
  const issueId = issueIdFromIssueMoveContext(ctx);
  if (!issueId) return null;
  for (const issue of [ctx.issue, ctx.linearIssue, ctx.targetIssue]) {
    if (issue?.id === issueId) return issue;
  }
  if (typeof ctx.client?.getIssue === "function") {
    const issue = await ctx.client.getIssue(issueId);
    if (issue) return issue;
  }
  if (typeof ctx.client?.getIssueContext === "function") {
    const issue = await ctx.client.getIssueContext(issueId);
    if (issue) return issue;
  }
  return null;
}

function issueMoveIdentity({ issue, issueId, target, defaultStatusName }) {
  const normalizedTarget = normalizeIssueMoveTarget(target);
  const stateId = normalizedTarget?.targetType === "status"
    ? normalizedTarget.id
    : issue?.state?.id || null;
  return {
    linear_issue_id: issue?.id || issueId,
    issue_id: issue?.id || issueId,
    issue_key: firstNonEmptyString([issue?.identifier, issue?.key]),
    target_type: normalizedTarget?.targetType || null,
    target_id: normalizedTarget?.id || null,
    status: firstNonEmptyString([normalizedTarget?.name, issue?.state?.name, defaultStatusName]),
    status_id: stateId,
    state_id: stateId,
    label_id: normalizedTarget?.targetType === "label" ? normalizedTarget.id : null,
  };
}

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
