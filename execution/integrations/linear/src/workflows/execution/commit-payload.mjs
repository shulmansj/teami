const COMMIT_ISSUE_REVIEW_SUMMARY =
  "Execution completed with a reviewable pull request.";

export function assembleCommitPayload(produced, ctx = {}) {
  const authored = isRecord(produced) ? produced : {};
  return {
    project_update_fallback_body: commitIssueReviewFallbackBody(ctx),
    pr_title: authoredString(
      authored.pr_title ??
      authored.prTitle ??
      authored.title,
    ),
    pr_body: authoredString(
      authored.pr_body ??
      authored.prBody ??
      authored.body_markdown ??
      authored.body,
    ),
    linear_issue_id: authoredString(
      authored.linear_issue_id ??
      authored.linearIssueId ??
      authored.issue_id ??
      authored.issueId,
    ),
  };
}

export function validateCommitPayload(terminalOutput) {
  const output = isRecord(terminalOutput) ? terminalOutput : {};
  const failureReasons = [];

  if (!nonEmptyString(output.pr_title)) failureReasons.push("missing_pr_title");
  if (!nonEmptyString(output.pr_body)) failureReasons.push("missing_pr_body");
  if (!nonEmptyString(output.linear_issue_id) && !nonEmptyString(output.issue_id)) {
    failureReasons.push("missing_linear_issue_id");
  }

  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}

export function qualityGateInput() {
  return null;
}

export const commitPayload = Object.freeze({
  assembleCommitPayload,
  validateCommitPayload,
  qualityGateInput,
});

function commitIssueReviewFallbackBody(ctx) {
  if (typeof ctx?.projectUpdateFallbackBody === "function") {
    return ctx.projectUpdateFallbackBody(COMMIT_ISSUE_REVIEW_SUMMARY);
  }
  return [
    COMMIT_ISSUE_REVIEW_SUMMARY,
    "",
    "- Review the pull request linked from this run before merging.",
    "- The Linear issue is expected to move to In Review after effects converge.",
  ].join("\n");
}

function authoredString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
