import {
  AF_REVIEW_STATUS_CONTEXT,
  lookupAfReviewCommentByMarker,
} from "../execution-pr-adapter.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
} from "../workflows/review/effect-ids.mjs";

export const GITHUB_PR_REVIEW_COMMENT_OP = "post_af_review_comment";
export const GITHUB_AF_REVIEW_STATUS_OP = "set_af_review_status";

export const githubPrReviewCommentEffect = Object.freeze({
  id: GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  provider: "github",
  op: GITHUB_PR_REVIEW_COMMENT_OP,
  probe: probeGithubPrReviewCommentEffect,
  apply: applyGithubPrReviewCommentEffect,
  verify: verifyGithubPrReviewCommentEffect,
  producedIdentity: Object.freeze({
    resource_kind: "github_pull_request_comment",
    target_ids: githubReviewCommentTargetIds,
    identity: githubReviewCommentProducedIdentity,
  }),
});

export const githubAfReviewStatusEffect = Object.freeze({
  id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  provider: "github",
  op: GITHUB_AF_REVIEW_STATUS_OP,
  probe: probeGithubAfReviewStatusEffect,
  apply: applyGithubAfReviewStatusEffect,
  verify: verifyGithubAfReviewStatusEffect,
  producedIdentity: Object.freeze({
    resource_kind: "github_commit_status",
    target_ids: githubAfReviewStatusTargetIds,
    identity: githubAfReviewStatusProducedIdentity,
  }),
});

export const AF_REVIEW_COMMIT_EFFECTS = Object.freeze([
  githubPrReviewCommentEffect,
  githubAfReviewStatusEffect,
]);

export function githubPrReviewCommentEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...githubPrReviewCommentEffect,
    ...overrides,
  });
}

export function githubAfReviewStatusEffectDescriptor(overrides = {}) {
  return Object.freeze({
    ...githubAfReviewStatusEffect,
    ...overrides,
  });
}

export function teamiReviewCommitEffectDescriptors({
  comment = {},
  status = {},
} = {}) {
  return Object.freeze([
    githubPrReviewCommentEffectDescriptor(comment),
    githubAfReviewStatusEffectDescriptor(status),
  ]);
}

export async function probeGithubPrReviewCommentEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requiredMethods: ["listPullRequestComments"],
  });
  if (!resolved.ok) return { satisfied: false, reason: resolved.reason };

  const lookup = await lookupReviewComment({
    adapter: resolved.adapter,
    review: resolved.review,
  });
  if (lookup.status === "found") {
    return {
      satisfied: true,
      identity: githubReviewCommentIdentity({
        review: resolved.review,
        comment: lookup.comment,
      }),
    };
  }

  return {
    satisfied: false,
    reason: reviewCommentLookupReason(lookup),
    ...(isTerminalCommentLookup(lookup) ? { terminal: true } : {}),
  };
}

export async function applyGithubPrReviewCommentEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requireBody: true,
    requireRunId: true,
    requiredMethods: ["getPullRequest", "listPullRequestComments", "postPullRequestComment"],
  });
  if (!resolved.ok) return terminalFailure(resolved.reason);
  const { adapter, review } = resolved;

  const current = await ensurePullRequestStillAtHead({ adapter, review });
  if (!current.ok) return terminalFailure(current.reason);

  const existing = await lookupReviewComment({ adapter, review });
  if (existing.status === "found") {
    return {
      ok: true,
      identity: githubReviewCommentIdentity({ review, comment: existing.comment }),
    };
  }
  if (isTerminalCommentLookup(existing)) {
    return terminalFailure(reviewCommentLookupReason(existing));
  }

  const posted = await adapter.postPullRequestComment({
    number: review.number,
    body: review.body,
    context: AF_REVIEW_STATUS_CONTEXT,
    disposition: review.disposition,
    head_sha: review.head_sha,
    run_id: review.run_id,
  });
  const identity = githubReviewCommentIdentity({ review, comment: posted });
  return { ok: true, identity };
}

export async function verifyGithubPrReviewCommentEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requiredMethods: ["listPullRequestComments"],
  });
  if (!resolved.ok) return terminalFailure(resolved.reason);

  const lookup = await lookupReviewComment({
    adapter: resolved.adapter,
    review: resolved.review,
  });
  if (lookup.status === "found") {
    return {
      ok: true,
      identity: githubReviewCommentIdentity({
        review: resolved.review,
        comment: lookup.comment,
      }),
    };
  }
  if (isTerminalCommentLookup(lookup)) {
    return terminalFailure(reviewCommentLookupReason(lookup));
  }
  return pendingFailure(reviewCommentLookupReason(lookup));
}

export async function probeGithubAfReviewStatusEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requiredMethods: ["getCommitStatuses"],
  });
  if (!resolved.ok) return { satisfied: false, reason: resolved.reason };

  const intended = intendedAfReviewStatusState(resolved.review.disposition);
  if (!intended.ok) return { satisfied: false, terminal: true, reason: intended.reason };

  const inspection = await inspectAfReviewStatus({
    adapter: resolved.adapter,
    review: resolved.review,
    intendedState: intended.state,
  });
  if (inspection.status === "found_intended") {
    return {
      satisfied: true,
      identity: githubAfReviewStatusIdentity({
        review: resolved.review,
        state: intended.state,
      }),
    };
  }
  return {
    satisfied: false,
    reason: inspection.reason,
    ...(inspection.terminal ? { terminal: true } : {}),
  };
}

export async function applyGithubAfReviewStatusEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requiredMethods: ["getPullRequest", "getCommitStatuses", "setCommitStatus"],
  });
  if (!resolved.ok) return terminalFailure(resolved.reason);
  const { adapter, review } = resolved;

  const intended = intendedAfReviewStatusState(review.disposition);
  if (!intended.ok) return terminalFailure(intended.reason);

  const current = await ensurePullRequestStillAtHead({ adapter, review });
  if (!current.ok) return terminalFailure(current.reason);

  const inspection = await inspectAfReviewStatus({
    adapter,
    review,
    intendedState: intended.state,
  });
  if (inspection.status === "found_intended") {
    return {
      ok: true,
      identity: githubAfReviewStatusIdentity({ review, state: intended.state }),
    };
  }
  if (inspection.terminal) return terminalFailure(inspection.reason);

  await adapter.setCommitStatus({
    head_sha: review.head_sha,
    context: AF_REVIEW_STATUS_CONTEXT,
    state: intended.state,
    description: teamiReviewStatusDescription(review.disposition),
    ...(review.target_url ? { target_url: review.target_url } : {}),
  });
  return {
    ok: true,
    identity: githubAfReviewStatusIdentity({ review, state: intended.state }),
  };
}

export async function verifyGithubAfReviewStatusEffect(ctx = {}) {
  const resolved = resolveReviewInputs(ctx, {
    requiredMethods: ["getCommitStatuses"],
  });
  if (!resolved.ok) return terminalFailure(resolved.reason);

  const intended = intendedAfReviewStatusState(resolved.review.disposition);
  if (!intended.ok) return terminalFailure(intended.reason);

  const inspection = await inspectAfReviewStatus({
    adapter: resolved.adapter,
    review: resolved.review,
    intendedState: intended.state,
  });
  if (inspection.status === "found_intended") {
    return {
      ok: true,
      identity: githubAfReviewStatusIdentity({
        review: resolved.review,
        state: intended.state,
      }),
    };
  }
  if (inspection.terminal) return terminalFailure(inspection.reason);
  return pendingFailure(inspection.reason);
}

function resolveReviewInputs(ctx = {}, {
  requireBody = false,
  requireRunId = false,
  requiredMethods = [],
} = {}) {
  const review = normalizeReviewContext(ctx.review, { requireBody });
  if (!review.ok) return review;

  const runId = firstNonEmptyString([
    ctx.review?.run_id,
    ctx.review?.runId,
    ctx.runId,
    ctx.run_id,
    ctx.artifact?.run_id,
    ctx.artifact?.runId,
  ]);
  if (requireRunId && !runId) {
    return invalid("github_pr_review_run_id_missing");
  }

  const adapter = ctx.prAdapter;
  if (!adapter || typeof adapter !== "object") {
    return invalid("github_review_pr_adapter_missing");
  }
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      return invalid(`github_review_pr_adapter_${method}_missing`);
    }
  }

  return {
    ok: true,
    review: Object.freeze({
      ...review.value,
      run_id: runId || null,
    }),
    adapter,
  };
}

function normalizeReviewContext(review = {}, { requireBody = false } = {}) {
  const owner = firstNonEmptyString([review?.owner]);
  const repo = firstNonEmptyString([review?.repo]);
  const number = positiveInteger(review?.number);
  const headSha = firstNonEmptyString([review?.head_sha, review?.headSha]);
  const disposition = firstNonEmptyString([review?.disposition]);
  const body = stringValue(review?.body);
  const targetUrl = firstNonEmptyString([review?.target_url, review?.targetUrl]);

  if (!owner) return invalid("github_review_owner_missing");
  if (!repo) return invalid("github_review_repo_missing");
  if (!number) return invalid("github_review_number_invalid");
  if (!headSha || hasUnsafeShaCharacters(headSha)) return invalid("github_review_head_sha_invalid");
  if (!disposition) return invalid("github_review_disposition_missing");
  if (requireBody && !firstNonEmptyString([body])) return invalid("github_pr_review_body_missing");

  return {
    ok: true,
    value: Object.freeze({
      owner,
      repo,
      number,
      head_sha: headSha,
      disposition,
      body: body ?? "",
      target_url: targetUrl,
    }),
  };
}

async function lookupReviewComment({ adapter, review }) {
  const comments = await adapter.listPullRequestComments(review.number);
  return lookupAfReviewCommentByMarker(comments, {
    context: AF_REVIEW_STATUS_CONTEXT,
    head_sha: review.head_sha,
    disposition: review.disposition,
  });
}

async function inspectAfReviewStatus({ adapter, review, intendedState }) {
  const latest = latestAfReviewStatus(await adapter.getCommitStatuses(review.head_sha));
  if (!latest) {
    return {
      status: "missing",
      reason: "github_af_review_status_missing",
      terminal: false,
    };
  }
  if (latest.state === intendedState) {
    return {
      status: "found_intended",
      reason: null,
      terminal: false,
      status_record: latest,
    };
  }
  return {
    status: "wrong_state",
    reason: "github_af_review_status_state_mismatch",
    terminal: true,
    status_record: latest,
  };
}

async function ensurePullRequestStillAtHead({ adapter, review }) {
  let pullRequest;
  try {
    pullRequest = await adapter.getPullRequest(review.number);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: false, reason: "github_review_pull_request_missing" };
    }
    throw error;
  }

  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    return { ok: false, reason: "github_review_pull_request_missing" };
  }
  const state = firstNonEmptyString([pullRequest.state]);
  if (state && state !== "open") {
    return { ok: false, reason: "github_review_pull_request_not_open" };
  }
  const currentHeadSha = firstNonEmptyString([
    pullRequest.head?.sha,
    pullRequest.head_sha,
  ]);
  if (!currentHeadSha) {
    return { ok: false, reason: "github_review_pull_request_head_sha_missing" };
  }
  if (currentHeadSha !== review.head_sha) {
    return { ok: false, reason: "github_review_pull_request_head_moved" };
  }
  return { ok: true };
}

function latestAfReviewStatus(statuses) {
  if (!Array.isArray(statuses)) return null;
  let latest = null;
  statuses.forEach((status, index) => {
    if (!status || typeof status !== "object" || Array.isArray(status)) return;
    if (status.context !== AF_REVIEW_STATUS_CONTEXT) return;
    if (!firstNonEmptyString([status.state])) return;
    const candidate = {
      status,
      index,
      time: timestamp(status.created_at),
    };
    if (!latest || isLaterStatus(candidate, latest)) latest = candidate;
  });
  return latest?.status || null;
}

function isLaterStatus(left, right) {
  const leftHasTime = Number.isFinite(left.time);
  const rightHasTime = Number.isFinite(right.time);
  if (leftHasTime && rightHasTime && left.time !== right.time) return left.time > right.time;
  if (leftHasTime !== rightHasTime) return leftHasTime;
  return left.index < right.index;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function intendedAfReviewStatusState(disposition) {
  // The canonical disposition vocabulary is S7's: approve | request-changes | escalate.
  // The af-review status is the gate: only an approve is success; both change-request and
  // escalate are failure. Anything else fails closed (never a silent green).
  const normalized = String(disposition || "").trim().toLowerCase();
  if (normalized === "approve") {
    return { ok: true, state: "success" };
  }
  if (normalized === "request-changes" || normalized === "escalate") {
    return { ok: true, state: "failure" };
  }
  return { ok: false, reason: "github_af_review_disposition_invalid" };
}

function teamiReviewStatusDescription(disposition) {
  const intended = intendedAfReviewStatusState(disposition);
  if (intended.state === "success") return "Teami review approved";
  return "Teami review requested changes";
}

function githubReviewCommentIdentity({ review, comment }) {
  return Object.freeze({
    owner: review.owner,
    repo: review.repo,
    number: review.number,
    head_sha: review.head_sha,
    comment_id: firstNonEmptyString([comment?.comment_id, comment?.id]),
  });
}

function githubAfReviewStatusIdentity({ review, state }) {
  return Object.freeze({
    owner: review.owner,
    repo: review.repo,
    head_sha: review.head_sha,
    context: AF_REVIEW_STATUS_CONTEXT,
    state,
  });
}

function githubReviewCommentTargetIds(identity) {
  const repo = repoSlug(identity);
  return stringIds([
    identity?.comment_id,
    repo && identity?.number && identity?.comment_id
      ? `${repo}#${identity.number}:comment:${identity.comment_id}`
      : null,
  ]);
}

function githubReviewCommentProducedIdentity(identity) {
  return githubReviewCommentIdentity({
    review: identity || {},
    comment: identity || {},
  });
}

function githubAfReviewStatusTargetIds(identity) {
  const repo = repoSlug(identity);
  return stringIds([
    repo && identity?.head_sha ? `${repo}@${identity.head_sha}:${AF_REVIEW_STATUS_CONTEXT}` : null,
  ]);
}

function githubAfReviewStatusProducedIdentity(identity) {
  return githubAfReviewStatusIdentity({
    review: identity || {},
    state: identity?.state,
  });
}

function repoSlug(identity) {
  const owner = firstNonEmptyString([identity?.owner]);
  const repo = firstNonEmptyString([identity?.repo]);
  return owner && repo ? `${owner}/${repo}` : null;
}

function reviewCommentLookupReason(lookup) {
  if (lookup?.status === "missing") return "github_pr_review_comment_missing";
  if (lookup?.status === "multiple") return "github_pr_review_comment_multiple";
  if (lookup?.status === "malformed") return "github_pr_review_comment_marker_malformed";
  return "github_pr_review_comment_lookup_failed";
}

function isTerminalCommentLookup(lookup) {
  return lookup?.status === "multiple" || lookup?.status === "malformed";
}

function isNotFoundError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.github?.status);
  if (status === 404) return true;
  return /status_404|not[_ -]?found|missing/i.test(String(error?.message || ""));
}

function terminalFailure(reason) {
  return { ok: false, terminal: true, reason };
}

function pendingFailure(reason) {
  return { ok: false, reason };
}

function invalid(reason) {
  return { ok: false, reason };
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function hasUnsafeShaCharacters(value) {
  return /[\x00-\x20\x7f/\\?#]/.test(String(value || ""));
}

function stringIds(values) {
  return [...new Set(values.map((value) => firstNonEmptyString([value])).filter(Boolean))];
}
