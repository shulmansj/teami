import {
  needsPrincipalCodeMarker,
  needsPrincipalThesisLine,
} from "./needs-principal-comment-format.mjs";

const COMMENT_PENDING_EFFECT_ID = "linear_project_needs_principal_comment";
const PROJECT_THESIS_LINE = needsPrincipalThesisLine("project");
const DEFAULT_QUESTIONS_MARKDOWN = "Teami needs the Principal to answer the human-decision question before decomposition continues.";

export function buildProjectNeedsPrincipalCommentBody({
  runId = null,
  questionsMarkdown = null,
} = {}) {
  const normalizedRunId = nonEmptyString(runId);
  if (!normalizedRunId) throw new Error("runId is required to build a project needs-principal comment.");
  return [
    PROJECT_THESIS_LINE,
    "",
    nonEmptyString(questionsMarkdown) || DEFAULT_QUESTIONS_MARKDOWN,
    "",
    projectRunMarker(normalizedRunId),
    "",
    "To release it: answer the question in this Linear project thread, then move this project back to Planned. Teami will pick it up on its next pass.",
  ].join("\n");
}

export async function applyProjectNeedsPrincipalComment({
  client,
  projectId = null,
  runId = null,
  questionsMarkdown = null,
  statusId = null,
  cache = null,
} = {}) {
  const appIdentityId = nonEmptyString(cache?.app_identity_id);
  if (!appIdentityId) {
    return pendingPair("linear_app_identity_missing");
  }
  const targetProjectId = nonEmptyString(projectId);
  if (!targetProjectId) {
    return pendingPair("linear_project_id_missing");
  }
  const normalizedRunId = nonEmptyString(runId);
  if (!normalizedRunId) {
    return pendingPair("linear_run_id_missing");
  }
  const targetStatusId = nonEmptyString(statusId);
  if (!targetStatusId) {
    return pendingPair("linear_project_status_id_missing");
  }
  if (typeof client?.listComments !== "function") {
    return pendingPair("linear_project_comments_unavailable");
  }
  if (typeof client?.createComment !== "function") {
    return pendingPair("linear_project_comment_unavailable");
  }
  if (typeof client?.updateProject !== "function") {
    return pendingPair("linear_project_update_unavailable");
  }

  const body = buildProjectNeedsPrincipalCommentBody({
    runId: normalizedRunId,
    questionsMarkdown,
  });
  const probe = await findProjectNeedsPrincipalComment({
    client,
    projectId: targetProjectId,
    appIdentityId,
    runId: normalizedRunId,
  });
  if (probe.outcome !== "ok") return { outcome: "pending", comment: probe, project: null, reason: probe.reason };

  let comment = probe.comment
    ? commentResult({ comment: probe.comment, alreadyPresent: true })
    : null;
  if (!comment) {
    try {
      await client.createComment({ projectId: targetProjectId }, body);
    } catch (error) {
      return pendingPair(`linear_project_comment_failed:${safeErrorMessage(error)}`);
    }
    const verified = await findProjectNeedsPrincipalComment({
      client,
      projectId: targetProjectId,
      appIdentityId,
      runId: normalizedRunId,
    });
    if (verified.outcome !== "ok") {
      return { outcome: "pending", comment: verified, project: null, reason: verified.reason };
    }
    if (!verified.comment) {
      return pendingPair("linear_project_comment_verify_missing");
    }
    comment = commentResult({ comment: verified.comment, alreadyPresent: false });
  }

  try {
    const project = await client.updateProject(targetProjectId, { statusId: targetStatusId });
    return { outcome: "ok", comment, project };
  } catch (error) {
    return {
      outcome: "pending",
      comment,
      project: null,
      reason: `linear_project_needs_principal_not_applied:${safeErrorMessage(error)}`,
    };
  }
}

async function findProjectNeedsPrincipalComment({ client, projectId, appIdentityId, runId }) {
  let comments;
  try {
    comments = await client.listComments({ projectId });
  } catch (error) {
    return pendingComment(`linear_project_comment_probe_failed:${safeErrorMessage(error)}`);
  }
  if (!Array.isArray(comments)) {
    return pendingComment("linear_project_comments_required");
  }
  const marker = projectRunMarker(runId);
  const comment = comments.find((candidate) =>
    nonEmptyString(candidate?.user?.id) === appIdentityId &&
    String(candidate?.body || "").includes(PROJECT_THESIS_LINE) &&
    String(candidate?.body || "").includes(marker)
  );
  return { outcome: "ok", comment: comment || null };
}

function projectRunMarker(runId) {
  return needsPrincipalCodeMarker(`run_id:${runId}`);
}

function pendingPair(reason) {
  const comment = pendingComment(reason);
  return { outcome: "pending", comment, project: null, reason: comment.reason };
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
