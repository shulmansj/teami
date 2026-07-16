import { createIssueMoveEffect, normalizeIssueMoveTarget } from "./issue-move-effect-factory.mjs";
import { resolveReadyIssueStatus } from "./shape-resolver.mjs";

export const LINEAR_ISSUE_READY_EFFECT_ID = "linear_issue_ready";
export const ISSUE_READY_OP = "move_issue_ready";

const readyMove = createIssueMoveEffect({
  id: LINEAR_ISSUE_READY_EFFECT_ID,
  op: ISSUE_READY_OP,
  appliedIdentityKey: "issueReadyAppliedIdentity",
  targetMissingReason: "linear_issue_ready_target_missing",
  targetResolutionFailedReason: "linear_issue_ready_target_resolution_failed",
  notAppliedReason: "linear_issue_not_ready",
  defaultStatusName: "Todo",
  resolveTarget: resolveReadyIssueTargetFromContext,
});

export const issueReadyEffect = readyMove.effect;
export const probeIssueReadyEffect = readyMove.probe;
export const applyIssueReadyEffect = readyMove.apply;
export const verifyIssueReadyEffect = readyMove.verify;

export function issueReadyEffectDescriptor(overrides = {}) {
  return readyMove.descriptor(overrides);
}

export async function resolveReadyIssueTarget({
  client,
  config,
  shape = null,
  teamId = null,
} = {}) {
  const shapeTarget = normalizeReadyIssueTarget(shape?.issueStatuses?.todo);
  if (shapeTarget) return shapeTarget;
  if (!client || !config) return null;
  const effectiveTeamId = teamId || shape?.team?.id || null;
  const readyStatus = await resolveReadyIssueStatus(client, config, effectiveTeamId);
  return normalizeReadyIssueTarget(readyStatus);
}

export function normalizeReadyIssueTarget(target) {
  return normalizeIssueMoveTarget(target);
}

async function resolveReadyIssueTargetFromContext(ctx = {}) {
  return resolveReadyIssueTarget({
    client: ctx.client,
    config: ctx.config,
    shape: ctx.shape,
    teamId: teamIdFromContext(ctx),
  });
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

function firstNonEmptyString(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
