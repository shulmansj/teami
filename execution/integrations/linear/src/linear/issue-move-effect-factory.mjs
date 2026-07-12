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
  resolveExpectedSource = null,
  expectedSourceMissingReason = "linear_issue_expected_source_missing",
  expectedSourceResolutionFailedReason = "linear_issue_expected_source_resolution_failed",
  sourceMismatchReason = "linear_issue_source_mismatch",
  guardSkippedKey = null,
} = {}) {
  if (!id) throw new Error("linear_issue_move_effect_id_required");
  if (!op) throw new Error("linear_issue_move_effect_op_required");
  if (typeof resolveTarget !== "function") throw new Error("linear_issue_move_target_resolver_required");
  if (resolveExpectedSource !== null && typeof resolveExpectedSource !== "function") {
    throw new Error("linear_issue_move_source_resolver_invalid");
  }
  const skippedKey = guardSkippedKey || `${id}Skipped`;

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

    let sourceIssue = null;
    if (resolveExpectedSource) {
      const sourceResolution = await safelyResolveExpectedSource(ctx);
      if (!sourceResolution.ok || !sourceResolution.target) {
        return {
          ok: false,
          terminal: true,
          reason: sourceResolution.reason || expectedSourceMissingReason,
        };
      }

      const freshRead = await readFreshIssueFromClient(ctx, issueId);
      if (!freshRead.ok) {
        return { ok: false, terminal: true, reason: freshRead.reason };
      }
      sourceIssue = freshRead.issue;
      if (!sourceIssue) {
        return { ok: false, terminal: true, reason: "linear_issue_missing" };
      }
      if (!issueMatchesMoveTarget(sourceIssue, sourceResolution.target)) {
        const skipped = {
          ok: true,
          skipped: true,
          reason: sourceMismatchReason,
          source_state_id: sourceResolution.target.id,
          actual_state_id: sourceIssue.state?.id || null,
        };
        ctx[skippedKey] = skipped;
        return skipped;
      }
    }

    await ctx.onBeforeLinearMutation?.({
      artifactKind: ctx.artifact?.kind || null,
      runId: ctx.runId || ctx.artifact?.run_id || null,
      trace: ctx.trace,
      effectId: id,
    });

    const target = resolved.target;
    const input = await issueMoveUpdateInput({ target });
    const issue = await ctx.client.updateIssue(issueId, input);
    const identity = issueMoveIdentity({ issue, issueId, target, defaultStatusName });
    if (appliedIdentityKey) ctx[appliedIdentityKey] = identity;
    return { ok: true, identity };
  }

  async function verify(ctx = {}) {
    if (appliedIdentityKey && ctx[appliedIdentityKey]) {
      return { ok: true, identity: ctx[appliedIdentityKey] };
    }
    if (resolveExpectedSource && ctx[skippedKey]?.skipped === true) {
      return { ok: true, skipped: true, reason: ctx[skippedKey].reason || sourceMismatchReason };
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

  async function safelyResolveExpectedSource(ctx = {}) {
    try {
      const target = await resolveExpectedSource(ctx);
      return { ok: true, target: normalizeIssueMoveTarget(target) };
    } catch (error) {
      return { ok: false, reason: error?.message || expectedSourceResolutionFailedReason };
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
  return issue.state?.id === normalizedTarget.id;
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
    (target.type ? "status" : null);
  if (targetType !== "status") return null;
  return {
    ...target,
    targetType: "status",
  };
}

async function issueMoveUpdateInput({ target }) {
  return { stateId: target.id };
}

async function readFreshIssueFromClient(ctx = {}, issueId) {
  if (typeof ctx.client?.getIssue === "function") {
    return { ok: true, issue: await ctx.client.getIssue(issueId) };
  }
  if (typeof ctx.client?.getIssueContext === "function") {
    return { ok: true, issue: await ctx.client.getIssueContext(issueId) };
  }
  return { ok: false, reason: "linear_read_issue_unavailable" };
}

async function readIssueFromContext(ctx = {}) {
  const issueId = issueIdFromIssueMoveContext(ctx);
  if (!issueId) return null;
  // Fresh read first: ctx snapshots can lag provider state, and guarded moves
  // compare the current status before mutating.
  const freshRead = await readFreshIssueFromClient(ctx, issueId);
  if (freshRead.ok && freshRead.issue) return freshRead.issue;
  for (const issue of [ctx.issue, ctx.linearIssue, ctx.targetIssue]) {
    if (issue?.id === issueId) return issue;
  }
  return null;
}

function issueMoveIdentity({ issue, issueId, target, defaultStatusName }) {
  const normalizedTarget = normalizeIssueMoveTarget(target);
  const stateId = normalizedTarget?.id || issue?.state?.id || null;
  return {
    linear_issue_id: issue?.id || issueId,
    issue_id: issue?.id || issueId,
    issue_key: firstNonEmptyString([issue?.identifier, issue?.key]),
    target_type: normalizedTarget?.targetType || null,
    target_id: normalizedTarget?.id || null,
    status: firstNonEmptyString([normalizedTarget?.name, issue?.state?.name, defaultStatusName]),
    status_id: stateId,
    state_id: stateId,
  };
}

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
