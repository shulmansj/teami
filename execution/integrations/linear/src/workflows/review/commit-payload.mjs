const REVIEW_DISPOSITIONS = Object.freeze([
  "approve",
  "request-changes",
  "escalate",
]);
const REVIEW_DISPOSITION_SET = new Set(REVIEW_DISPOSITIONS);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function assembleCommitPayload(produced) {
  const authored = isRecord(produced) ? produced : {};
  const payload = {
    disposition: authoredString(authored.disposition),
    body: authoredString(
      authored.body ??
      authored.review_body ??
      authored.reviewBody,
    ),
    reviewed_head_sha: authoredString(
      authored.reviewed_head_sha ??
      authored.reviewedHeadSha ??
      authored.head_sha ??
      authored.headSha,
    ),
  };
  // Strict generation schemas emit unused optionals as explicit null (never
  // omitted) — null means ABSENT here, exactly like the other null-unions.
  if (Object.hasOwn(authored, "comments") && authored.comments !== null) {
    payload.comments = normalizeCommentsForOrchestrator(authored.comments);
  }
  const humanBriefing = authoredString(
    authored.human_briefing ??
    authored.humanBriefing ??
    authored.briefing,
  );
  if (humanBriefing) payload.human_briefing = humanBriefing;
  return payload;
}

export function validateCommitPayload(terminalOutput) {
  const output = isRecord(terminalOutput) ? terminalOutput : {};
  const failureReasons = [];

  validateDisposition(output.disposition, failureReasons);
  if (!nonEmptyString(output.body)) failureReasons.push("missing_review_body");
  validateReviewedHeadSha(output.reviewed_head_sha, failureReasons);
  validateOptionalComments(output, failureReasons);

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

function validateDisposition(value, failureReasons) {
  if (!nonEmptyString(value)) {
    failureReasons.push("missing_review_disposition");
    return;
  }
  if (!REVIEW_DISPOSITION_SET.has(value)) {
    failureReasons.push("invalid_review_disposition");
  }
}

function validateReviewedHeadSha(value, failureReasons) {
  if (!nonEmptyString(value)) {
    failureReasons.push("missing_reviewed_head_sha");
    return;
  }
  if (!GIT_SHA_PATTERN.test(value.trim())) {
    failureReasons.push("invalid_reviewed_head_sha");
  }
}

function validateOptionalComments(output, failureReasons) {
  if (!Object.hasOwn(output, "comments")) return;
  if (!Array.isArray(output.comments)) {
    failureReasons.push("invalid_review_comments");
    return;
  }
  for (const comment of output.comments) {
    if (!isRecord(comment)) failureReasons.push("invalid_review_comment");
  }
}

function normalizeCommentsForOrchestrator(comments) {
  if (!Array.isArray(comments)) return comments;
  return comments.map((comment) => isRecord(comment) ? { ...comment } : comment);
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
