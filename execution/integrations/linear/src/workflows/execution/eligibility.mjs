import { extractDecompositionKey } from "../../issue-body.mjs";
import { isIssueClosed, issueHasLabel } from "../../linear/matching-utils.mjs";
import { parseResourceTargetFromDescription } from "../../resource-target.mjs";
import { requiredResourceKindForWorkType } from "./work-type.mjs";

const RESOURCE_TARGET_MISSING_REASON = "resource_target_missing";
const RESOURCE_TARGET_NOT_ALLOWED_REASON = "resource_target_not_allowed";

export function isReadyIssueEligible(issueContext, options = {}) {
  const {
    todoStateId = null,
    discoveryLabelId = null,
    readyStateIds = null,
    allowedRepoPacket = null,
    workTypeCodeLabelId = null,
    workTypeNonCodeLabelId = null,
  } = options;
  const selfId = issueContext?.id || null;
  const blockingIssueIds = selfId ? incompleteBlockingIssueIds(issueContext, selfId) : [];
  const eligibleStateIds = Array.isArray(readyStateIds) && readyStateIds.length > 0
    ? readyStateIds
    : [todoStateId];
  const baseEligible =
    isReadyState(issueContext?.state, eligibleStateIds) &&
    extractDecompositionKey(issueContext?.description) !== null &&
    discoveryLabelId !== null &&
    !issueHasLabel(issueContext, discoveryLabelId) &&
    blockingIssueIds.length === 0;
  const routing = resourceRoutingForIssue(issueContext, {
    allowedRepoPacket,
    workTypeCodeLabelId,
    workTypeNonCodeLabelId,
  });
  if (!routing) {
    return {
      eligible: baseEligible,
      blockingIssueIds,
    };
  }
  return {
    eligible: baseEligible && routing.reason === null,
    blockingIssueIds,
    ineligibleReason: routing.reason,
    resourceRouting: routing,
  };
}

function resourceRoutingForIssue(issueContext, {
  allowedRepoPacket = null,
  workTypeCodeLabelId = null,
  workTypeNonCodeLabelId = null,
} = {}) {
  if (!Array.isArray(allowedRepoPacket) || allowedRepoPacket.length === 0) return null;
  const codeLabelId = nonEmptyString(workTypeCodeLabelId);
  if (!codeLabelId) return null;

  const allowedResourceIds = allowedRepoPacket
    .map((repo) => nonEmptyString(repo?.resource_id))
    .filter(Boolean);
  const workType = issueHasLabel(issueContext, codeLabelId)
    ? "code"
    : issueHasLabel(issueContext, workTypeNonCodeLabelId)
      ? "non_code"
      : null;
  const routing = {
    work_type: workType,
    chosen_resource_id: null,
    allowed_resource_ids: allowedResourceIds,
    reason: null,
  };
  const requiredKind = requiredResourceKindForWorkType(workType);
  if (requiredKind === null) return routing;

  const target = parseResourceTargetFromDescription(issueContext?.description);
  const singleAllowedResourceId = allowedRepoPacket.length === 1
    ? nonEmptyString(allowedRepoPacket[0]?.resource_id)
    : null;
  if (!target) {
    if (singleAllowedResourceId) {
      return {
        ...routing,
        chosen_resource_id: singleAllowedResourceId,
      };
    }
    return {
      ...routing,
      reason: RESOURCE_TARGET_MISSING_REASON,
    };
  }

  const allowedIds = new Set(allowedResourceIds);
  if (target.kind !== requiredKind || !allowedIds.has(target.id)) {
    return {
      ...routing,
      chosen_resource_id: target.id,
      reason: RESOURCE_TARGET_NOT_ALLOWED_REASON,
    };
  }

  return {
    ...routing,
    chosen_resource_id: target.id,
  };
}

function incompleteBlockingIssueIds(issueContext, selfId) {
  const blockingIssueIds = [];
  for (const relation of issueContext?.relations || []) {
    if (relation?.type !== "blocks") continue;
    if (relation.relatedIssue?.id !== selfId) continue;

    const blocker = relation.issue;
    if (!blocker?.id) continue;
    if (!isIssueClosed(blocker)) blockingIssueIds.push(blocker.id);
  }
  return blockingIssueIds;
}

function isReadyState(state, readyStateIds) {
  return readyStateIds
    .filter((id) => typeof id === "string" && id.trim() !== "")
    .some((id) => state?.id === id);
}

function nonEmptyString(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}
