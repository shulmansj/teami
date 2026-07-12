import { readLinearCache } from "../cache.mjs";
import { createIssueMoveEffect } from "./issue-move-effect-factory.mjs";
import { resolveIssueStatusRoleTarget } from "./shape-resolver.mjs";

export const LINEAR_ISSUE_DONE_EFFECT_ID = "linear_issue_done";
export const ISSUE_DONE_OP = "move_issue_done";

const baseIssueDoneMove = createIssueMoveEffect({
  id: LINEAR_ISSUE_DONE_EFFECT_ID,
  op: ISSUE_DONE_OP,
  appliedIdentityKey: "issueDoneAppliedIdentity",
  targetMissingReason: "linear_issue_done_target_missing",
  targetResolutionFailedReason: "linear_issue_done_target_resolution_failed",
  notAppliedReason: "linear_issue_not_done",
  defaultStatusName: "Done",
  resolveTarget: (ctx) => resolveRoleTargetFromContext(ctx, "done"),
  resolveExpectedSource: resolveExpectedSourceFromContext,
  expectedSourceMissingReason: "linear_issue_done_source_missing",
  expectedSourceResolutionFailedReason: "linear_issue_done_source_resolution_failed",
  sourceMismatchReason: "linear_issue_done_source_mismatch",
});

export const issueDoneEffect = Object.freeze({
  ...baseIssueDoneMove.effect,
  probe: probeIssueDoneEffect,
});
export const applyIssueDoneEffect = baseIssueDoneMove.apply;
export const verifyIssueDoneEffect = baseIssueDoneMove.verify;

export function issueDoneEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...issueDoneEffect,
    ...overrides,
  });
}

export async function probeIssueDoneEffect(ctx = {}) {
  const source = await safelyResolveExpectedSource(ctx);
  if (!source.ok || !source.target) {
    return { satisfied: false, reason: source.reason || "linear_issue_done_source_missing" };
  }
  return baseIssueDoneMove.probe(ctx);
}

async function resolveExpectedSourceFromContext(ctx = {}) {
  const role = expectedSourceRoleFromContext(ctx);
  if (!role) throw new Error("linear_issue_done_expected_source_role_missing");
  return resolveRoleTargetFromContext(ctx, role);
}

async function resolveRoleTargetFromContext(ctx = {}, role) {
  return resolveIssueStatusRoleTarget({
    client: ctx.client,
    config: ctx.config,
    shape: ctx.shape,
    teamId: teamIdFromContext(ctx),
    cache: cacheFromContext(ctx),
    role,
  });
}

async function safelyResolveExpectedSource(ctx = {}) {
  try {
    const target = await resolveExpectedSourceFromContext(ctx);
    return { ok: true, target };
  } catch (error) {
    return { ok: false, reason: error?.message || "linear_issue_done_source_resolution_failed" };
  }
}

function expectedSourceRoleFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.expectedSourceRole,
    ctx.expected_source_role,
    ctx.linearIssueDone?.expectedSourceRole,
    ctx.linearIssueDone?.expected_source_role,
    ctx.linear_issue_done?.expectedSourceRole,
    ctx.linear_issue_done?.expected_source_role,
    ctx.payload?.expectedSourceRole,
    ctx.payload?.expected_source_role,
    ctx.payload?.linearIssueDone?.expectedSourceRole,
    ctx.payload?.linearIssueDone?.expected_source_role,
    ctx.payload?.linear_issue_done?.expectedSourceRole,
    ctx.payload?.linear_issue_done?.expected_source_role,
    ctx.artifact?.payload?.expectedSourceRole,
    ctx.artifact?.payload?.expected_source_role,
    ctx.artifact?.payload?.linearIssueDone?.expectedSourceRole,
    ctx.artifact?.payload?.linearIssueDone?.expected_source_role,
    ctx.artifact?.payload?.linear_issue_done?.expectedSourceRole,
    ctx.artifact?.payload?.linear_issue_done?.expected_source_role,
  ]);
}

function cacheFromContext(ctx = {}) {
  if (ctx.cache) return ctx.cache;
  if (ctx.linearCache) return ctx.linearCache;
  const cachePath = ctx.domainContext?.linear?.cachePath || ctx.domainContext?.linear?.cache_path;
  return cachePath ? readLinearCache(cachePath) : null;
}

function teamIdFromContext(ctx = {}) {
  return firstNonEmptyString([
    ctx.teamId,
    ctx.team_id,
    ctx.shape?.team?.id,
    ctx.cache?.teamId,
    ctx.linearCache?.teamId,
    ctx.domainContext?.linear?.teamId,
    ctx.domainContext?.linear?.team_id,
    ctx.issue?.teamId,
    ctx.issue?.team?.id,
    ctx.linearIssue?.teamId,
    ctx.linearIssue?.team?.id,
    ctx.targetIssue?.teamId,
    ctx.targetIssue?.team?.id,
  ]);
}

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
