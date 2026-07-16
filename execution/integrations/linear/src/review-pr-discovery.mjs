import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  createDefaultExecutionPullRequestAdapter,
  normalizeExecutionRepoIdentity,
  parseAfReviewCommentMarker,
} from "./execution-pr-adapter.mjs";

export const REVIEW_PR_DISCOVERY_STATUSES = Object.freeze([
  "found",
  "none",
  "multiple",
  "closed",
  "wrong_base",
]);

const adaptersByLocatedPr = new WeakMap();

export function resourcesToRepoIdentity(teamContext = {}, options = {}) {
  const resources = Array.isArray(teamContext)
    ? teamContext
    : teamContext?.resources;
  if (!Array.isArray(resources)) {
    throw new Error("review_git_repo_resources_missing");
  }

  const resourceId = firstNonEmptyString([
    typeof options === "string" ? options : null,
    options?.resourceId,
    options?.resource_id,
    options?.selectedResourceId,
    options?.selected_resource_id,
  ]);
  const gitResources = resources.filter((candidate) => candidate?.kind === "git_repo");
  let resource;
  if (resourceId) {
    resource = gitResources.find((candidate) => candidate?.id === resourceId);
    if (!resource) {
      throw new Error("review_git_repo_resource_not_found");
    }
  } else if (gitResources.length === 1) {
    resource = gitResources[0];
  } else if (gitResources.length > 1) {
    throw new Error("review_git_repo_resource_id_required");
  }
  if (!resource) {
    throw new Error("review_git_repo_resource_missing");
  }
  if (!isRecord(resource.binding)) {
    throw new Error("review_git_repo_binding_missing");
  }

  return normalizeExecutionRepoIdentity({
    owner: resource.binding.owner,
    repo: resource.binding.repo,
    default_branch: resource.binding.default_branch,
  });
}

export async function locatePullRequestForProducedIdentity({
  producedIdentity,
  repoIdentity,
  prAdapter = null,
  createPrAdapter = null,
} = {}) {
  const branch = firstNonEmptyString([
    producedIdentity?.branch,
    producedIdentity?.head_branch,
  ]);
  const resourceId = firstNonEmptyString([producedIdentity?.resource_id]);
  const number = positiveInteger(
    producedIdentity?.pull_request_number ??
    producedIdentity?.pr_number ??
    producedIdentity?.number,
  );
  if (!number) {
    return locationResult("none", {
      branch,
      resource_id: resourceId,
      reason: "review_produced_pr_number_missing",
    });
  }

  let repo;
  try {
    repo = normalizeExecutionRepoIdentity(repoIdentity);
  } catch (error) {
    return locationResult("none", {
      branch,
      resource_id: resourceId,
      reason: errorReason(error, "review_repo_identity_invalid"),
    });
  }
  const base = repo.default_branch;
  if (!base) {
    return locationResult("none", {
      branch,
      resource_id: resourceId,
      reason: "review_repo_default_branch_missing",
    });
  }

  let adapter;
  try {
    adapter = await resolvePrAdapter({ repoIdentity: repo, prAdapter, createPrAdapter });
    requireAdapterMethod(adapter, "getPullRequest");
  } catch (error) {
    return locationResult("none", {
      branch,
      base,
      resource_id: resourceId,
      reason: errorReason(error, "review_pr_adapter_unavailable"),
    });
  }

  let hydrated;
  try {
    hydrated = await adapter.getPullRequest(number);
  } catch (error) {
    return locationResult("none", {
      branch,
      base,
      resource_id: resourceId,
      reason: errorReason(error, "review_pr_hydration_failed"),
    });
  }

  const candidate = normalizeProducedPullRequest(hydrated, {
    number,
    branch,
    headSha: firstNonEmptyString([
      producedIdentity?.head_sha,
      producedIdentity?.headSha,
    ]),
  });
  if (candidate.state !== "open") {
    return locationResult("closed", {
      branch: candidate.branch || branch,
      base,
      resource_id: resourceId,
      pull_request: publicPullRequestSummary(candidate),
      source: "produced_identity",
    });
  }
  if (candidate.base !== base) {
    return locationResult("wrong_base", {
      branch: candidate.branch || branch,
      base,
      resource_id: resourceId,
      expected_base: base,
      actual_base: candidate.base,
      pull_request: publicPullRequestSummary(candidate),
      source: "produced_identity",
    });
  }

  const headSha = candidate.head_sha;
  if (!headSha) {
    return locationResult("none", {
      branch: candidate.branch || branch,
      base,
      resource_id: resourceId,
      pull_request: publicPullRequestSummary(candidate),
      reason: "review_pr_head_sha_missing",
      source: "produced_identity",
    });
  }

  const pr = Object.freeze({
    owner: repo.owner,
    repo: repo.repo,
    number,
    head_sha: headSha,
  });
  adaptersByLocatedPr.set(pr, adapter);
  return locationResult("found", {
    branch: candidate.branch || branch,
    base,
    resource_id: resourceId,
    pr,
    source: "produced_identity",
  });
}

export async function locatePullRequestForIssue({
  issueContext,
  repoIdentity,
  prAdapter = null,
  createPrAdapter = null,
} = {}) {
  let branch;
  try {
    branch = branchNameForIssue(issueIdentifierFromContext(issueContext));
  } catch (error) {
    return locationResult("none", {
      reason: errorReason(error, "review_issue_identifier_missing"),
    });
  }

  let repo;
  try {
    repo = normalizeExecutionRepoIdentity(repoIdentity);
  } catch (error) {
    return locationResult("none", {
      branch,
      reason: errorReason(error, "review_repo_identity_invalid"),
    });
  }
  const base = repo.default_branch;
  if (!base) {
    return locationResult("none", {
      branch,
      reason: "review_repo_default_branch_missing",
    });
  }

  let adapter;
  try {
    adapter = await resolvePrAdapter({ repoIdentity: repo, prAdapter, createPrAdapter });
    requireAdapterMethod(adapter, "listPullRequestsForHead");
  } catch (error) {
    return locationResult("none", {
      branch,
      base,
      reason: errorReason(error, "review_pr_adapter_unavailable"),
    });
  }

  let pullRequests;
  try {
    pullRequests = await adapter.listPullRequestsForHead(branch, { state: "all" });
  } catch (error) {
    return locationResult("none", {
      branch,
      base,
      reason: errorReason(error, "review_pr_head_probe_failed"),
    });
  }

  const matches = Array.isArray(pullRequests)
    ? pullRequests.map(normalizeHeadPullRequest).filter(Boolean)
    : [];
  if (matches.length === 0) {
    return locationResult("none", { branch, base });
  }
  if (matches.length > 1) {
    return locationResult("multiple", {
      branch,
      base,
      pull_requests: Object.freeze(matches.map(publicPullRequestSummary)),
    });
  }

  const candidate = matches[0];
  if (candidate.state !== "open") {
    return locationResult("closed", {
      branch,
      base,
      pull_request: publicPullRequestSummary(candidate),
    });
  }
  if (candidate.base !== base) {
    return locationResult("wrong_base", {
      branch,
      base,
      expected_base: base,
      actual_base: candidate.base,
      pull_request: publicPullRequestSummary(candidate),
    });
  }

  let hydrated;
  try {
    requireAdapterMethod(adapter, "getPullRequest");
    hydrated = await adapter.getPullRequest(candidate.number);
  } catch (error) {
    return locationResult("none", {
      branch,
      base,
      pull_request: publicPullRequestSummary(candidate),
      reason: errorReason(error, "review_pr_hydration_failed"),
    });
  }

  const headSha = headShaFromPullRequest(hydrated) || candidate.head_sha;
  if (!headSha) {
    return locationResult("none", {
      branch,
      base,
      pull_request: publicPullRequestSummary(candidate),
      reason: "review_pr_head_sha_missing",
    });
  }

  const pr = Object.freeze({
    owner: repo.owner,
    repo: repo.repo,
    number: candidate.number,
    head_sha: headSha,
  });
  adaptersByLocatedPr.set(pr, adapter);
  return locationResult("found", {
    branch,
    base,
    pr,
  });
}

export async function hydrateReviewState(
  pr,
  {
    prAdapter = null,
    createPrAdapter = null,
  } = {},
) {
  const normalized = normalizeLocatedPullRequest(pr);
  const repoIdentity = {
    owner: normalized.owner,
    repo: normalized.repo,
    default_branch: null,
  };
  const adapter = await resolvePrAdapter({
    repoIdentity,
    prAdapter: prAdapter || adaptersByLocatedPr.get(pr),
    createPrAdapter,
  });
  requireAdapterMethod(adapter, "getCommitStatuses");
  requireAdapterMethod(adapter, "listPullRequestComments");
  requireAdapterMethod(adapter, "getPullRequestFiles");

  const [statuses, comments, diff] = await Promise.all([
    adapter.getCommitStatuses(normalized.head_sha),
    adapter.listPullRequestComments(normalized.number),
    adapter.getPullRequestFiles(normalized.number),
  ]);
  const latestStatus = latestAfReviewStatus(statuses);
  const latestMarker = latestAfReviewMarkerCommentAtHead({
    comments,
    headSha: normalized.head_sha,
  });

  return Object.freeze({
    af_review_state: latestStatus?.state || null,
    af_review_status: latestStatus,
    latest_marker_comment_at_head: latestMarker,
    diff_incomplete: Boolean(diff?.diff_incomplete),
    ...(diff?.reason ? { diff_incomplete_reason: diff.reason } : {}),
  });
}

function locationResult(status, fields = {}) {
  if (!REVIEW_PR_DISCOVERY_STATUSES.includes(status)) {
    throw new Error(`review_pr_location_status_invalid:${status}`);
  }
  return Object.freeze({
    status,
    ...fields,
  });
}

async function resolvePrAdapter({ repoIdentity, prAdapter, createPrAdapter } = {}) {
  if (typeof prAdapter === "function") return prAdapter({ repoIdentity });
  if (prAdapter && typeof prAdapter === "object") return prAdapter;
  if (typeof createPrAdapter === "function") return createPrAdapter({ repoIdentity });
  return createDefaultExecutionPullRequestAdapter({ repoIdentity });
}

function issueIdentifierFromContext(issueContext = {}) {
  return firstNonEmptyString([
    issueContext?.identifier,
    issueContext?.key,
    issueContext?.issueIdentifier,
    issueContext?.issue_identifier,
    issueContext?.issue?.identifier,
    issueContext?.issue?.key,
  ]);
}

function normalizeHeadPullRequest(pullRequest) {
  if (!isRecord(pullRequest)) return null;
  const number = positiveInteger(pullRequest.number);
  if (!number) return null;
  return Object.freeze({
    number,
    state: firstNonEmptyString([pullRequest.state]) || null,
    base: firstNonEmptyString([
      pullRequest.base,
      pullRequest.base_ref,
      pullRequest.base?.ref,
    ]),
    head_sha: firstNonEmptyString([
      pullRequest.head_sha,
      pullRequest.head?.sha,
    ]),
  });
}

function normalizeProducedPullRequest(pullRequest, {
  number,
  branch = null,
  headSha = null,
} = {}) {
  const hydratedBranch = firstNonEmptyString([
    pullRequest?.head?.ref,
    pullRequest?.head_ref,
  ]);
  return Object.freeze({
    number,
    state: firstNonEmptyString([pullRequest?.state]) || null,
    base: firstNonEmptyString([
      pullRequest?.base,
      pullRequest?.base_ref,
      pullRequest?.base?.ref,
    ]),
    branch: hydratedBranch || branch || null,
    head_sha: firstNonEmptyString([
      pullRequest?.head_sha,
      pullRequest?.head?.sha,
      headSha,
    ]),
  });
}

function publicPullRequestSummary(pullRequest) {
  return Object.freeze({
    number: pullRequest.number,
    state: pullRequest.state || null,
    base: pullRequest.base || null,
    head_sha: pullRequest.head_sha || null,
  });
}

function normalizeLocatedPullRequest(pr) {
  const owner = firstNonEmptyString([pr?.owner]);
  const repo = firstNonEmptyString([pr?.repo]);
  const number = positiveInteger(pr?.number);
  const headSha = firstNonEmptyString([pr?.head_sha]);
  if (!owner) throw new Error("review_pr_owner_missing");
  if (!repo) throw new Error("review_pr_repo_missing");
  if (!number) throw new Error("review_pr_number_invalid");
  if (!headSha) throw new Error("review_pr_head_sha_missing");
  return Object.freeze({ owner, repo, number, head_sha: headSha });
}

function headShaFromPullRequest(pullRequest) {
  return firstNonEmptyString([
    pullRequest?.head?.sha,
    pullRequest?.head_sha,
  ]);
}

function latestAfReviewStatus(statuses) {
  if (!Array.isArray(statuses)) return null;
  const matching = statuses.filter((status) =>
    isRecord(status) && status.context === AF_REVIEW_STATUS_CONTEXT && status.state);
  return latestByCreatedAt(matching);
}

function latestAfReviewMarkerCommentAtHead({ comments, headSha }) {
  if (!Array.isArray(comments)) return null;
  let latest = null;
  comments.forEach((comment, index) => {
    const parsed = parseAfReviewCommentMarker(comment?.body);
    if (!parsed.ok) return;
    if (parsed.marker.context !== AF_REVIEW_STATUS_CONTEXT) return;
    if (parsed.marker.head_sha !== headSha) return;
    const candidate = {
      comment,
      marker: parsed.marker,
      index,
      time: timestamp(comment?.created_at),
    };
    if (!latest || isLater(candidate, latest)) latest = candidate;
  });
  if (!latest) return null;
  return Object.freeze({
    comment: latest.comment,
    marker: latest.marker,
  });
}

function latestByCreatedAt(items) {
  let latest = null;
  items.forEach((item, index) => {
    const candidate = { item, index, time: timestamp(item?.created_at) };
    if (!latest || isLater(candidate, latest)) latest = candidate;
  });
  return latest?.item || null;
}

function isLater(left, right) {
  if (left.time !== right.time) return left.time > right.time;
  return left.index > right.index;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function requireAdapterMethod(adapter, method) {
  if (typeof adapter?.[method] !== "function") {
    throw new Error(`review_pr_adapter_${method}_missing`);
  }
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function errorReason(error, fallback) {
  return firstNonEmptyString([error?.reason, error?.message]) || fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
