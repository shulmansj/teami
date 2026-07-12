import { readLinearCache } from "../cache.mjs";
import {
  needsPrincipalIssueTargetFromParts,
  resolveNeedsPrincipalIssueStatus,
} from "./shape-resolver.mjs";

export const ISSUE_NEEDS_PRINCIPAL_EFFECT_ID = "linear_issue_needs_principal";
export const ISSUE_NEEDS_PRINCIPAL_OP = "needs_principal";

export const issueNeedsPrincipalEscalationEffect = Object.freeze({
  id: ISSUE_NEEDS_PRINCIPAL_EFFECT_ID,
  provider: "linear",
  op: ISSUE_NEEDS_PRINCIPAL_OP,
  terminal: true,
  probe: probeIssueNeedsPrincipalEscalationEffect,
  apply: applyIssueNeedsPrincipalEscalationEffect,
  verify: verifyIssueNeedsPrincipalEscalationEffect,
});

export function issueNeedsPrincipalEscalationEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...issueNeedsPrincipalEscalationEffect,
    ...overrides,
  });
}

export async function probeIssueNeedsPrincipalEscalationEffect(ctx = {}) {
  const resolved = await safelyResolveNeedsPrincipalTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return { satisfied: false, reason: resolved.reason || "linear_issue_needs_principal_target_missing" };
  }

  const issue = await readIssueFromContext(ctx);
  if (!issue) return { satisfied: false, reason: "linear_issue_missing" };
  if (!issueMatchesNeedsPrincipalTarget(issue, resolved.target)) {
    return { satisfied: false, reason: "linear_issue_needs_principal_not_applied" };
  }

  return {
    satisfied: true,
    identity: issueNeedsPrincipalIdentity({
      issue,
      issueId: issue.id,
      target: resolved.target,
    }),
  };
}

export async function applyIssueNeedsPrincipalEscalationEffect(ctx = {}) {
  const issueId = issueIdFromEscalationContext(ctx);
  if (!issueId) {
    return { ok: false, terminal: true, reason: "linear_issue_id_missing" };
  }
  if (typeof ctx.client?.updateIssue !== "function") {
    return { ok: false, terminal: true, reason: "linear_update_issue_unavailable" };
  }

  const resolved = await safelyResolveNeedsPrincipalTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return {
      ok: false,
      terminal: true,
      reason: resolved.reason || "linear_issue_needs_principal_target_missing",
    };
  }

  await ctx.onBeforeLinearMutation?.({
    artifactKind: ctx.artifact?.kind || null,
    runId: ctx.runId || ctx.artifact?.run_id || null,
    trace: ctx.trace,
    effectId: ISSUE_NEEDS_PRINCIPAL_EFFECT_ID,
  });

  const target = resolved.target;
  const input = issueNeedsPrincipalUpdateInput({ target });
  const issue = await ctx.client.updateIssue(issueId, input);
  const identity = issueNeedsPrincipalIdentity({ issue, issueId, target });
  return { ok: true, identity };
}

export async function verifyIssueNeedsPrincipalEscalationEffect(ctx = {}) {
  const issueId = issueIdFromEscalationContext(ctx);
  if (!issueId) return { ok: false, terminal: true, reason: "linear_issue_id_missing" };

  const resolved = await safelyResolveNeedsPrincipalTarget(ctx);
  if (!resolved.ok || !resolved.target) {
    return {
      ok: false,
      terminal: true,
      reason: resolved.reason || "linear_issue_needs_principal_target_missing",
    };
  }

  const issue = await readIssueFromContext(ctx);
  if (!issue) return { ok: false, reason: "linear_issue_missing" };
  if (!issueMatchesNeedsPrincipalTarget(issue, resolved.target)) {
    return { ok: false, reason: "linear_issue_needs_principal_not_applied" };
  }

  return {
    ok: true,
    identity: issueNeedsPrincipalIdentity({ issue, issueId, target: resolved.target }),
  };
}

export async function resolveNeedsPrincipalIssueTarget({
  client,
  config,
  shape = null,
  teamId = null,
  cache = null,
} = {}) {
  const shapeTarget = normalizeNeedsPrincipalIssueTarget(
    needsPrincipalIssueTargetFromParts(shape?.issueStatuses?.needs_principal),
  );
  if (shapeTarget) return shapeTarget;
  if (!client || !config) return null;
  const effectiveTeamId = teamId || shape?.team?.id || cache?.teamId || null;
  const needsPrincipalStatus = await resolveNeedsPrincipalIssueStatus(
    client,
    config,
    effectiveTeamId,
    cache,
  );
  return normalizeNeedsPrincipalIssueTarget(needsPrincipalStatus);
}

export function needsPrincipalIssuesBacklogFilter({ target, teamId = null } = {}) {
  const normalizedTarget = normalizeNeedsPrincipalIssueTarget(target);
  if (!normalizedTarget) return null;
  const clauses = [];
  if (teamId) clauses.push({ team: { id: { eq: teamId } } });
  clauses.push({ state: { id: { eq: normalizedTarget.stateId } } });
  return { and: clauses };
}

export async function listNeedsPrincipalIssuesForPrincipal({
  client,
  config,
  shape = null,
  teamId = null,
  cache = null,
  includeArchived = false,
} = {}) {
  const target = await resolveNeedsPrincipalIssueTarget({ client, config, shape, teamId, cache });
  if (!target) {
    throw new Error("linear_issue_needs_principal_target_missing");
  }
  const effectiveTeamId = teamId || shape?.team?.id || cache?.teamId || null;
  const filter = needsPrincipalIssuesBacklogFilter({ target, teamId: effectiveTeamId });
  const listIssues = client?.listIssues || client?.searchIssues;
  if (typeof listIssues !== "function") {
    throw new Error("linear_list_issues_unavailable");
  }
  const issues = await listIssues.call(client, {
    teamId: effectiveTeamId,
    includeArchived,
    filter,
  });
  return (issues || []).filter((issue) => issueMatchesNeedsPrincipalTarget(issue, target));
}

export function issueMatchesNeedsPrincipalTarget(issue, target) {
  const normalizedTarget = normalizeNeedsPrincipalIssueTarget(target);
  if (!issue || !normalizedTarget) return false;
  return issue.state?.id === normalizedTarget.stateId;
}

export function issueIdFromEscalationContext(ctx = {}) {
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
    ctx.payload?.linear_issue_id,
    ctx.payload?.issue_id,
  ]);
}

export function normalizeNeedsPrincipalIssueTarget(target) {
  if (!target) return null;
  const targetLooksLikeStatus =
    target.targetType === "status" ||
    target.target_type === "status" ||
    Boolean(target.type);
  const stateId = firstNonEmptyString([
    target.stateId,
    target.state_id,
    target.statusId,
    target.status_id,
    target.state?.id,
    targetLooksLikeStatus ? target.id : null,
  ]);
  if (!stateId) return null;
  const statusTarget = { ...target };
  delete statusTarget.labelId;
  delete statusTarget.label_id;
  delete statusTarget.reasonLabelId;
  delete statusTarget.reason_label_id;
  delete statusTarget.label;
  return {
    ...statusTarget,
    id: stateId,
    targetType: "status",
    targetId: stateId,
    stateId,
    statusId: stateId,
    state: target.state || {
      id: stateId,
      name: target.name || null,
      type: target.type || null,
      resolution: target.resolution || null,
    },
  };
}

function issueNeedsPrincipalUpdateInput({ target }) {
  const normalizedTarget = normalizeNeedsPrincipalIssueTarget(target);
  return { stateId: normalizedTarget.stateId };
}

async function readIssueFromContext(ctx = {}) {
  const issueId = issueIdFromEscalationContext(ctx);
  if (!issueId) return null;
  // Fresh read first: ctx snapshots can be poll candidates whose status changed
  // after selection; probe and verify compare the provider state.
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

async function safelyResolveNeedsPrincipalTarget(ctx = {}) {
  try {
    const cache = cacheFromContext(ctx);
    const target = await resolveNeedsPrincipalIssueTarget({
      client: ctx.client,
      config: ctx.config,
      shape: ctx.shape,
      teamId: ctx.teamId || ctx.team_id || ctx.issue?.teamId || ctx.issue?.team?.id || null,
      cache,
    });
    return { ok: true, target };
  } catch (error) {
    return { ok: false, reason: error?.message || "linear_issue_needs_principal_target_resolution_failed" };
  }
}

function cacheFromContext(ctx = {}) {
  if (ctx.cache) return ctx.cache;
  if (ctx.linearCache) return ctx.linearCache;
  const cachePath = ctx.domainContext?.linear?.cachePath || ctx.domainContext?.linear?.cache_path;
  return cachePath ? readLinearCache(cachePath) : null;
}

function issueNeedsPrincipalIdentity({ issue, issueId, target }) {
  const normalizedTarget = normalizeNeedsPrincipalIssueTarget(target);
  return {
    issue_id: issue?.id || issueId,
    target_type: normalizedTarget?.targetType || null,
    target_id: normalizedTarget?.stateId || null,
    state_id: normalizedTarget?.stateId || issue?.state?.id || null,
  };
}

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
