import { readLinearCache } from "../cache.mjs";
import { createIssueMoveEffect } from "./issue-move-effect-factory.mjs";
import { resolveIssueStatusRoleTarget } from "./shape-resolver.mjs";

export const GATE_PARK_MOVE_EFFECT_ID = "gate_park_move";
export const GATE_INVALIDATE_MOVE_EFFECT_ID = "gate_invalidate_move";
export const GATE_BOUNCE_TO_IN_REVIEW_EFFECT_ID = "gate_bounce_to_in_review";
export const GATE_BOUNCE_TO_TODO_EFFECT_ID = "gate_bounce_to_todo";

export const GATE_MOVE_EFFECT_IDS = Object.freeze([
  GATE_PARK_MOVE_EFFECT_ID,
  GATE_INVALIDATE_MOVE_EFFECT_ID,
  GATE_BOUNCE_TO_IN_REVIEW_EFFECT_ID,
  GATE_BOUNCE_TO_TODO_EFFECT_ID,
]);

const gateParkMove = createGateIssueMove({
  id: GATE_PARK_MOVE_EFFECT_ID,
  op: "park_for_human_review",
  sourceRole: "in_review",
  targetRole: "human_review",
  appliedIdentityKey: "gateParkMoveAppliedIdentity",
  defaultStatusName: "Principal Review",
});

const gateInvalidateMove = createGateIssueMove({
  id: GATE_INVALIDATE_MOVE_EFFECT_ID,
  op: "invalidate_human_review",
  sourceRole: "human_review",
  targetRole: "in_review",
  appliedIdentityKey: "gateInvalidateMoveAppliedIdentity",
  defaultStatusName: "In Review",
});

const gateBounceToInReview = createGateIssueMove({
  id: GATE_BOUNCE_TO_IN_REVIEW_EFFECT_ID,
  op: "bounce_to_in_review",
  sourceRole: "done",
  targetRole: "in_review",
  appliedIdentityKey: "gateBounceToInReviewAppliedIdentity",
  defaultStatusName: "In Review",
});

const gateBounceToTodo = createGateIssueMove({
  id: GATE_BOUNCE_TO_TODO_EFFECT_ID,
  op: "bounce_to_todo",
  sourceRole: "done",
  targetRole: "todo",
  appliedIdentityKey: "gateBounceToTodoAppliedIdentity",
  defaultStatusName: "Todo",
});

export const gateParkMoveEffect = gateParkMove.effect;
export const gateInvalidateMoveEffect = gateInvalidateMove.effect;
export const gateBounceToInReviewEffect = gateBounceToInReview.effect;
export const gateBounceToTodoEffect = gateBounceToTodo.effect;

export const probeGateParkMoveEffect = gateParkMove.probe;
export const applyGateParkMoveEffect = gateParkMove.apply;
export const verifyGateParkMoveEffect = gateParkMove.verify;
export const probeGateInvalidateMoveEffect = gateInvalidateMove.probe;
export const applyGateInvalidateMoveEffect = gateInvalidateMove.apply;
export const verifyGateInvalidateMoveEffect = gateInvalidateMove.verify;
export const probeGateBounceToInReviewEffect = gateBounceToInReview.probe;
export const applyGateBounceToInReviewEffect = gateBounceToInReview.apply;
export const verifyGateBounceToInReviewEffect = gateBounceToInReview.verify;
export const probeGateBounceToTodoEffect = gateBounceToTodo.probe;
export const applyGateBounceToTodoEffect = gateBounceToTodo.apply;
export const verifyGateBounceToTodoEffect = gateBounceToTodo.verify;

export function gateParkMoveEffectDescriptor(overrides = {}) {
  return gateParkMove.descriptor(overrides);
}

export function gateInvalidateMoveEffectDescriptor(overrides = {}) {
  return gateInvalidateMove.descriptor(overrides);
}

export function gateBounceToInReviewEffectDescriptor(overrides = {}) {
  return gateBounceToInReview.descriptor(overrides);
}

export function gateBounceToTodoEffectDescriptor(overrides = {}) {
  return gateBounceToTodo.descriptor(overrides);
}

function createGateIssueMove({
  id,
  op,
  sourceRole,
  targetRole,
  appliedIdentityKey,
  defaultStatusName,
}) {
  return createIssueMoveEffect({
    id,
    op,
    appliedIdentityKey,
    targetMissingReason: `linear_issue_${targetRole}_target_missing`,
    targetResolutionFailedReason: `linear_issue_${targetRole}_target_resolution_failed`,
    notAppliedReason: `linear_issue_not_${targetRole}`,
    defaultStatusName,
    resolveTarget: (ctx) => resolveRoleTargetFromContext(ctx, targetRole),
    resolveExpectedSource: (ctx) => resolveRoleTargetFromContext(ctx, sourceRole),
    expectedSourceMissingReason: `linear_issue_${sourceRole}_source_missing`,
    expectedSourceResolutionFailedReason: `linear_issue_${sourceRole}_source_resolution_failed`,
    sourceMismatchReason: `linear_issue_not_${sourceRole}`,
  });
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
