import { applyCommitEffects } from "../../../../engine/commit-effects.mjs";
import { issueNeedsPrincipalEscalationEffectDescriptor } from "./issue-needs-principal-effect.mjs";

const THESIS_LINE = "Teami blocked this issue because it needs a human decision before automated work continues.";
const COMMENT_PENDING_EFFECT_ID = "linear_needs_principal_comment";

export function buildNeedsPrincipalCommentBody({
  site = null,
  reason = null,
  siteContent = null,
  config = null,
} = {}) {
  const normalizedReason = nonEmptyString(reason) || `${nonEmptyString(site) || "needs_principal"}_escalation_required`;
  const middle = nonEmptyString(siteContent) || "Teami needs the Principal to decide how this issue should continue.";
  const destination = releaseDestinationName({ site, config });
  return [
    THESIS_LINE,
    "",
    middle,
    "",
    `(code: \`${normalizedReason}\`)`,
    "",
    `To release it: answer the decision in Linear, then move this issue back to ${destination}. Teami will pick it up on its next pass.`,
  ].join("\n");
}

export async function applyNeedsPrincipalEscalationPair({
  client,
  config = null,
  cache = null,
  issueId = null,
  issue = null,
  domainContext = null,
  trace = null,
  runId = null,
  site = null,
  reason = null,
  siteContent = null,
} = {}) {
  const appIdentityId = nonEmptyString(cache?.app_identity_id);
  if (!appIdentityId) {
    return pendingPair("linear_app_identity_missing");
  }
  const targetIssueId = nonEmptyString(issueId) || nonEmptyString(issue?.id);
  if (!targetIssueId) {
    return pendingPair("linear_issue_id_missing");
  }
  if (typeof client?.listIssueComments !== "function") {
    return pendingPair("linear_issue_comments_unavailable");
  }

  const normalizedReason = nonEmptyString(reason) || `${nonEmptyString(site) || "needs_principal"}_escalation_required`;
  const body = buildNeedsPrincipalCommentBody({
    site,
    reason: normalizedReason,
    siteContent,
    config,
  });
  const probe = await findNeedsPrincipalComment({
    client,
    issueId: targetIssueId,
    appIdentityId,
    reason: normalizedReason,
  });
  if (probe.outcome !== "ok") return { outcome: "pending", comment: probe, escalation: null, reason: probe.reason };

  let comment = probe.comment
    ? commentResult({ comment: probe.comment, alreadyPresent: true })
    : null;
  if (!comment) {
    if (typeof client?.createIssueComment !== "function") {
      return pendingPair("linear_issue_comment_unavailable");
    }
    try {
      await client.createIssueComment(targetIssueId, body);
    } catch (error) {
      return pendingPair(`linear_issue_comment_failed:${safeErrorMessage(error)}`);
    }
    const verified = await findNeedsPrincipalComment({
      client,
      issueId: targetIssueId,
      appIdentityId,
      reason: normalizedReason,
    });
    if (verified.outcome !== "ok") {
      return { outcome: "pending", comment: verified, escalation: null, reason: verified.reason };
    }
    if (!verified.comment) {
      return pendingPair("linear_issue_comment_verify_missing");
    }
    comment = commentResult({ comment: verified.comment, alreadyPresent: false });
  }

  const teamId =
    nonEmptyString(issue?.teamId) ||
    nonEmptyString(issue?.team?.id) ||
    nonEmptyString(domainContext?.linear?.teamId) ||
    nonEmptyString(cache?.teamId);
  const escalation = await applyCommitEffects({
    effects: [issueNeedsPrincipalEscalationEffectDescriptor()],
    ctx: {
      client,
      config,
      cache,
      issue,
      issueId: targetIssueId,
      linearIssueId: targetIssueId,
      domainContext,
      trace,
      runId,
      teamId,
    },
    trace,
  });
  if (escalation.outcome !== "ok") {
    return {
      outcome: escalation.outcome,
      comment,
      escalation,
      reason: escalation.reason || "linear_issue_needs_principal_not_applied",
    };
  }
  return { outcome: "ok", comment, escalation };
}

async function findNeedsPrincipalComment({ client, issueId, appIdentityId, reason }) {
  let comments;
  try {
    comments = await client.listIssueComments(issueId);
  } catch (error) {
    return pendingComment(`linear_issue_comment_probe_failed:${safeErrorMessage(error)}`);
  }
  if (!Array.isArray(comments)) {
    return pendingComment("linear_issue_comments_required");
  }
  const marker = `(code: \`${reason}\`)`;
  const comment = comments.find((candidate) =>
    nonEmptyString(candidate?.user?.id) === appIdentityId &&
    String(candidate?.body || "").includes(THESIS_LINE) &&
    String(candidate?.body || "").includes(marker)
  );
  return { outcome: "ok", comment: comment || null };
}

function releaseDestinationName({ site, config }) {
  const statusKey = nonEmptyString(site) === "review" ? "in_review" : "todo";
  return nonEmptyString(config?.linear?.issue?.statuses?.[statusKey]?.name) ||
    (statusKey === "in_review" ? "In Review" : "Todo");
}

function pendingPair(reason) {
  const comment = pendingComment(reason);
  return { outcome: "pending", comment, escalation: null, reason: comment.reason };
}

function pendingComment(reason) {
  return {
    outcome: "pending",
    pending_effect_id: COMMENT_PENDING_EFFECT_ID,
    reason,
  };
}

function commentResult({ comment, alreadyPresent }) {
  return {
    outcome: "ok",
    comment_id: nonEmptyString(comment?.comment_id) || nonEmptyString(comment?.id),
    already_present: alreadyPresent === true,
  };
}

function nonEmptyString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function safeErrorMessage(error) {
  return String(error?.message || error || "unknown_error").replace(/\s+/g, "_").slice(0, 160);
}
