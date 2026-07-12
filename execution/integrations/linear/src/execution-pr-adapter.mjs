import {
  GITHUB_TOKEN_ENV_NAMES,
  resolveAmbientGitHubToken,
  resolveGhCliToken,
} from "../../git/git-remote-auth.mjs";

export const EXECUTION_PR_HEAD_PREFIX = "af/execution/";
export const AF_REVIEW_STATUS_CONTEXT = "af-review";
export const AF_REVIEW_COMMENT_MARKER_EXAMPLE = "Review notes\n\n<!-- af-review:{\"context\":\"af-review\",\"disposition\":\"approved\",\"head_sha\":\"0123456789abcdef0123456789abcdef01234567\",\"run_id\":\"run-123\"} -->";

// Auth is shared with the git push leg (git-remote-auth.mjs) by identity, not
// by copy, so the REST transport can never accept a different GitHub identity
// than the one that pushed the branch it operates on.
export const AMBIENT_GITHUB_TOKEN_ENV_NAMES = GITHUB_TOKEN_ENV_NAMES;
export { resolveAmbientGitHubToken };

export const GITHUB_EXECUTION_PR_ENDPOINT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "probe_execution_pull_request",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    fixed_query: Object.freeze({ state: "open" }),
  }),
  Object.freeze({
    id: "create_execution_pull_request",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls",
  }),
  Object.freeze({
    id: "get_execution_pull_request",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls/{number}",
  }),
  Object.freeze({
    id: "merge_execution_pull_request",
    method: "PUT",
    path: "/repos/{owner}/{repo}/pulls/{number}/merge",
  }),
  Object.freeze({
    id: "get_execution_pull_request_files",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls/{number}/files",
  }),
  Object.freeze({
    id: "get_execution_commit_statuses",
    method: "GET",
    path: "/repos/{owner}/{repo}/commits/{sha}/statuses",
  }),
  Object.freeze({
    id: "set_execution_commit_status",
    method: "POST",
    path: "/repos/{owner}/{repo}/statuses/{sha}",
  }),
  Object.freeze({
    id: "post_execution_pull_request_comment",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues/{number}/comments",
  }),
  Object.freeze({
    id: "list_execution_pull_request_comments",
    method: "GET",
    path: "/repos/{owner}/{repo}/issues/{number}/comments",
  }),
  Object.freeze({
    id: "list_execution_pull_requests_for_head",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    fixed_query: Object.freeze({ state: "all" }),
  }),
]);

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "teami-execution-pr-adapter";
const GITHUB_PULL_REQUEST_FILES_PER_PAGE = 100;
const GITHUB_PULL_REQUEST_FILES_MAX_PAGES = 30;
const GITHUB_PULL_REQUEST_FILES_CAP = 3000;

export function createExecutionPullRequestAdapter({ transport, repoIdentity } = {}) {
  if (!transport || typeof transport.request !== "function") {
    throw new Error("github_execution_pr_transport_required");
  }
  const repo = normalizeExecutionRepoIdentity(repoIdentity);

  const call = async (endpointId, params = {}) => {
    const endpoint = endpointById(endpointId);
    return transport.request({
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      owner: repo.owner,
      repo: repo.repo,
      params,
    });
  };

  async function probePullRequest({ head, base = repo.default_branch } = {}) {
    const headRef = assertExecutionBranchRef(head);
    const baseRef = assertBranchRef(base, "base");
    const response = await call("probe_execution_pull_request", {
      head: headRef,
      base: baseRef,
    });
    const data = unwrapGitHubData(response);
    if (!Array.isArray(data)) {
      throw new Error("github_execution_pr_probe_unexpected_response_shape");
    }
    return data.find((pullRequest) =>
      matchesExecutionPullRequest({
        pullRequest,
        owner: repo.owner,
        head: headRef,
        base: baseRef,
      })) || null;
  }

  async function createPullRequest({
    title,
    body = "",
    head,
    base = repo.default_branch,
    draft = false,
  } = {}) {
    const headRef = assertExecutionBranchRef(head);
    const baseRef = assertBranchRef(base, "base");
    const prTitle = assertNonEmptyString(title, "title");
    const prBody = body == null ? "" : String(body);
    const response = await call("create_execution_pull_request", {
      title: prTitle,
      body: prBody,
      head: headRef,
      base: baseRef,
      draft: Boolean(draft),
    });
    const data = unwrapGitHubData(response);
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error("github_execution_pr_create_unexpected_response_shape");
    }
    return data;
  }

  async function ensurePullRequest(request = {}) {
    const existing = await probePullRequest(request);
    if (existing) {
      return { created: false, pr: existing };
    }

    try {
      const pr = await createPullRequest(request);
      return { created: true, pr };
    } catch (error) {
      if (isDuplicatePullRequestError(error)) {
        const recovered = await probePullRequest(request);
        if (recovered) return { created: false, pr: recovered };
      }
      throw error;
    }
  }

  async function getPullRequest(number) {
    const response = await call("get_execution_pull_request", {
      number: assertPullRequestNumber(number),
    });
    const data = unwrapGitHubData(response);
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error("github_execution_pr_get_unexpected_response_shape");
    }
    return data;
  }

  async function mergePullRequest({ number, expectedHeadSha } = {}) {
    const response = await call("merge_execution_pull_request", {
      number: assertPullRequestNumber(number),
      expectedHeadSha: assertHeadSha(expectedHeadSha),
    });
    const data = unwrapGitHubData(response);
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error("github_execution_pr_merge_unexpected_response_shape");
    }
    return data;
  }

  async function getPullRequestFiles(number) {
    const prNumber = assertPullRequestNumber(number);
    const pullRequest = await getPullRequest(prNumber);
    const changedFiles = normalizeChangedFilesCount(pullRequest.changed_files);
    const changedFilesCapExceeded = changedFiles != null && changedFiles > GITHUB_PULL_REQUEST_FILES_CAP;

    const files = [];
    let pageCapHit = false;
    for (let page = 1; page <= GITHUB_PULL_REQUEST_FILES_MAX_PAGES; page += 1) {
      const response = await call("get_execution_pull_request_files", {
        number: prNumber,
        page,
        per_page: GITHUB_PULL_REQUEST_FILES_PER_PAGE,
      });
      const pageFiles = unwrapGitHubData(response);
      if (!Array.isArray(pageFiles)) {
        throw new Error("github_execution_pr_files_unexpected_response_shape");
      }
      files.push(...pageFiles);
      if (pageFiles.length < GITHUB_PULL_REQUEST_FILES_PER_PAGE) break;
      if (page === GITHUB_PULL_REQUEST_FILES_MAX_PAGES) {
        pageCapHit = true;
      }
    }

    const completeness = evaluateGitHubPullRequestFilesCompleteness({
      files,
      changedFiles,
      changedFilesCapExceeded,
      pageCapHit,
    });
    return Object.freeze({
      files: Object.freeze(files),
      diff_incomplete: completeness.diff_incomplete,
      ...(completeness.reason ? { reason: completeness.reason } : {}),
    });
  }

  async function getCommitStatuses(head_sha) {
    const response = await call("get_execution_commit_statuses", {
      head_sha: assertHeadSha(head_sha),
    });
    const data = unwrapGitHubData(response);
    if (!Array.isArray(data)) {
      throw new Error("github_execution_pr_statuses_unexpected_response_shape");
    }
    return data;
  }

  async function setCommitStatus({
    head_sha,
    context = AF_REVIEW_STATUS_CONTEXT,
    state,
    description,
    target_url,
  } = {}) {
    const response = await call("set_execution_commit_status", {
      head_sha: assertHeadSha(head_sha),
      context: assertAfReviewStatusContext(context),
      state: assertCommitStatusState(state),
      description: assertNonEmptyString(description, "status_description"),
      ...(target_url == null || target_url === "" ? {} : { target_url: assertUrlString(target_url, "target_url") }),
    });
    const data = unwrapGitHubData(response);
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error("github_execution_pr_status_create_unexpected_response_shape");
    }
    return data;
  }

  async function postPullRequestComment({
    number,
    body,
    context = AF_REVIEW_STATUS_CONTEXT,
    disposition,
    head_sha,
    run_id,
  } = {}) {
    const commentBody = bodyHasAfReviewMarker(body)
      ? String(body)
      : formatAfReviewCommentBody({
        body,
        context,
        disposition,
        head_sha,
        run_id,
      });
    const response = await call("post_execution_pull_request_comment", {
      number: assertPullRequestNumber(number),
      body: commentBody,
    });
    const data = unwrapGitHubData(response);
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error("github_execution_pr_comment_create_unexpected_response_shape");
    }
    const commentId = data.comment_id ?? data.id;
    if (commentId == null || String(commentId).trim() === "") {
      throw new Error("github_execution_pr_comment_create_missing_id");
    }
    return Object.freeze({ comment_id: commentId });
  }

  async function listPullRequestComments(number) {
    const response = await call("list_execution_pull_request_comments", {
      number: assertPullRequestNumber(number),
    });
    const data = unwrapGitHubData(response);
    if (!Array.isArray(data)) {
      throw new Error("github_execution_pr_comments_unexpected_response_shape");
    }
    return data.map(normalizePullRequestComment);
  }

  async function findPullRequestCommentByAfReviewMarker({
    number,
    context = AF_REVIEW_STATUS_CONTEXT,
    head_sha,
    disposition,
  } = {}) {
    const comments = await listPullRequestComments(number);
    return lookupAfReviewCommentByMarker(comments, {
      context,
      head_sha,
      disposition,
    });
  }

  async function listPullRequestsForHead(head, { state = "all" } = {}) {
    const headRef = assertExecutionBranchRef(head);
    const response = await call("list_execution_pull_requests_for_head", {
      head: headRef,
      state: assertPullRequestHeadListState(state),
    });
    const data = unwrapGitHubData(response);
    if (!Array.isArray(data)) {
      throw new Error("github_execution_pr_head_list_unexpected_response_shape");
    }
    return data
      .filter((pullRequest) => matchesPullRequestHead({ pullRequest, owner: repo.owner, head: headRef }))
      .map(normalizePullRequestForHead);
  }

  return Object.freeze({
    repo,
    probePullRequest,
    createPullRequest,
    ensurePullRequest,
    getPullRequest,
    mergePullRequest,
    getPullRequestFiles,
    getCommitStatuses,
    setCommitStatus,
    postPullRequestComment,
    listPullRequestComments,
    findPullRequestCommentByAfReviewMarker,
    listPullRequestsForHead,
  });
}

export function createDefaultExecutionPullRequestAdapter({
  repoIdentity,
  env = process.env,
  fetchImpl = globalThis.fetch,
  token,
  apiBaseUrl,
  userAgent,
} = {}) {
  return createExecutionPullRequestAdapter({
    repoIdentity,
    transport: createFetchExecutionPrTransport({
      env,
      fetchImpl,
      token,
      apiBaseUrl,
      userAgent,
    }),
  });
}

// Cross-platform production seam: REST over fetch. Tests can replace the
// whole transport with an in-memory fake. Token resolution mirrors the git
// push leg (git-remote-auth.mjs, the single gh authority): explicit token,
// then ambient env vars, then `gh auth token` — a gateway started from a
// shell where gh is logged in but no token env var is exported must reach
// the PR API with the same identity that just pushed the branch. The gh CLI
// result is cached per transport (one spawn, not one per request); a failed
// resolution is deliberately not cached, so `gh auth login` heals a running
// gateway on its next request. The fallback stays off for a non-default
// apiBaseUrl: gh holds a real github.com login, and a fixture server must
// never receive it.
export function createFetchExecutionPrTransport({
  fetchImpl = globalThis.fetch,
  env = process.env,
  token,
  apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
  userAgent = DEFAULT_USER_AGENT,
  resolveGhToken = resolveGhCliToken,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("github_execution_pr_fetch_required");
  }
  const ghFallbackAllowed =
    String(apiBaseUrl || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "") === DEFAULT_GITHUB_API_BASE_URL;
  let cachedGhToken = null;
  const resolveToken = async () => {
    const explicit = typeof token === "function" ? await token() : token;
    const ambient = explicit || resolveAmbientGitHubToken(env);
    if (ambient || !ghFallbackAllowed) return ambient;
    if (cachedGhToken) return cachedGhToken;
    const resolved = await resolveGhToken();
    if (resolved) cachedGhToken = resolved;
    return resolved;
  };

  return {
    kind: "rest_ambient",
    async request({ endpointId, method, path, owner, repo, params = {} } = {}) {
      assertGitHubExecutionPrEndpointShape({ endpointId, method, path });
      const authToken = assertNonEmptyString(await resolveToken(), "auth_token", {
        error: "github_execution_pr_auth_required",
      });
      const url = githubApiUrlForRequest({
        apiBaseUrl,
        endpointId,
        owner,
        repo,
        params,
      });
      const body = githubApiBodyForRequest({ endpointId, params });
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${authToken}`,
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      };
      if (body !== null) headers["Content-Type"] = "application/json";

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body,
        });
      } catch (error) {
        throw githubRequestError({
          endpointId,
          status: "network",
          detail: error?.message || String(error),
          token: authToken,
        });
      }

      const { payload, raw } = await parseFetchJsonResponse({
        endpointId,
        response,
        token: authToken,
      });
      if (!response?.ok) {
        throw githubRequestError({
          endpointId,
          status: response?.status ?? "unknown",
          detail: githubErrorDetail(payload, raw, response),
          token: authToken,
          payload,
        });
      }
      return { data: payload };
    },
  };
}

export function validateExecutionBranchRef(ref) {
  const value = typeof ref === "string" ? ref : "";
  if (value === "") return invalid("github_execution_pr_head_required");
  if (value.trim() !== value) return invalid("github_execution_pr_head_invalid");
  if (!value.startsWith(EXECUTION_PR_HEAD_PREFIX)) {
    return invalid("github_execution_pr_head_not_execution_ref");
  }
  return validateGitBranchRef(value, "github_execution_pr_head_invalid");
}

export function assertExecutionBranchRef(ref) {
  const result = validateExecutionBranchRef(ref);
  if (!result.ok) throw new Error(result.reason);
  return result.ref;
}

export function normalizeExecutionRepoIdentity(repoIdentity = {}) {
  const identity = repoIdentity || {};
  const owner = stringValue(identity.owner ?? identity.repo?.owner);
  const repoName = stringValue(
    typeof identity.repo === "string"
      ? identity.repo
      : identity.repo?.repo,
  );
  const defaultBranch = stringValue(
    identity.default_branch
      ?? identity.defaultBranch
      ?? identity.repo?.default_branch,
  );

  if (!owner) throw new Error("github_execution_pr_repo_identity_missing_owner");
  if (!repoName) throw new Error("github_execution_pr_repo_identity_missing_repo");
  assertRepoSlug(owner, "owner");
  assertRepoSlug(repoName, "repo");
  return Object.freeze({
    owner,
    repo: repoName,
    default_branch: defaultBranch || null,
  });
}

export function assertGitHubExecutionPrEndpointShape({ endpointId, method, path } = {}) {
  const endpoint = endpointById(endpointId);
  if (method !== endpoint.method || path !== endpoint.path) {
    throw new Error(`github_execution_pr_endpoint_shape_mismatch:${endpointId}`);
  }
  return endpoint;
}

function endpointById(endpointId) {
  const endpoint = GITHUB_EXECUTION_PR_ENDPOINT_ALLOWLIST.find((entry) => entry.id === endpointId);
  if (!endpoint) {
    throw new Error(`github_execution_pr_endpoint_not_allowlisted:${endpointId}`);
  }
  return endpoint;
}

function githubApiUrlForRequest({ apiBaseUrl, endpointId, owner, repo, params = {} }) {
  const endpoint = endpointById(endpointId);
  const base = String(apiBaseUrl || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "");
  let path = endpoint.path
    .replace("{owner}", encodeURIComponent(assertNonEmptyString(owner, "owner")))
    .replace("{repo}", encodeURIComponent(assertNonEmptyString(repo, "repo")));
  if (path.includes("{number}")) {
    path = path.replace("{number}", encodeURIComponent(String(assertPullRequestNumber(params.number))));
  }
  if (path.includes("{sha}")) {
    path = path.replace("{sha}", encodeURIComponent(assertHeadSha(params.head_sha)));
  }
  const url = new URL(`${base}${path}`);

  if (endpointId === "probe_execution_pull_request") {
    url.searchParams.set("state", "open");
    url.searchParams.set("head", `${owner}:${assertExecutionBranchRef(params.head)}`);
    url.searchParams.set("base", assertBranchRef(params.base, "base"));
    url.searchParams.set("per_page", "100");
  }

  if (endpointId === "get_execution_pull_request_files") {
    url.searchParams.set("per_page", String(GITHUB_PULL_REQUEST_FILES_PER_PAGE));
    url.searchParams.set("page", String(assertPositiveInteger(params.page ?? 1, "page")));
  }

  if (endpointId === "get_execution_commit_statuses") {
    url.searchParams.set("per_page", "100");
  }

  if (endpointId === "list_execution_pull_request_comments") {
    url.searchParams.set("per_page", "100");
  }

  if (endpointId === "list_execution_pull_requests_for_head") {
    url.searchParams.set("state", assertPullRequestHeadListState(params.state ?? "all"));
    url.searchParams.set("head", `${owner}:${assertExecutionBranchRef(params.head)}`);
    url.searchParams.set("per_page", "100");
  }

  return url.toString();
}

function githubApiBodyForRequest({ endpointId, params = {} }) {
  if (endpointId === "create_execution_pull_request") {
    return JSON.stringify({
      title: assertNonEmptyString(params.title, "title"),
      head: assertExecutionBranchRef(params.head),
      base: assertBranchRef(params.base, "base"),
      body: params.body == null ? "" : String(params.body),
      draft: Boolean(params.draft),
    });
  }
  if (endpointId === "set_execution_commit_status") {
    return JSON.stringify({
      state: assertCommitStatusState(params.state),
      context: assertAfReviewStatusContext(params.context),
      description: assertNonEmptyString(params.description, "status_description"),
      ...(params.target_url == null || params.target_url === "" ? {} : { target_url: assertUrlString(params.target_url, "target_url") }),
    });
  }
  if (endpointId === "merge_execution_pull_request") {
    return JSON.stringify({
      sha: assertHeadSha(params.expectedHeadSha),
    });
  }
  if (endpointId === "post_execution_pull_request_comment") {
    return JSON.stringify({
      body: assertNonEmptyString(params.body, "comment_body"),
    });
  }
  return null;
}

async function parseFetchJsonResponse({ endpointId, response, token }) {
  const raw = typeof response?.text === "function"
    ? await response.text()
    : "";
  if (raw.trim() === "") return { payload: null, raw };
  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    throw githubRequestError({
      endpointId,
      status: response?.status ?? "unknown",
      detail: "malformed_json",
      token,
    });
  }
}

function githubRequestError({
  endpointId,
  status,
  detail,
  token,
  payload = null,
}) {
  const error = new Error(redactToken(
    `github_execution_pr_request_failed:${endpointId}:status_${status}:${detail || "unknown"}`,
    token,
  ));
  error.endpointId = endpointId;
  error.status = status;
  error.github = payload;
  return error;
}

function githubErrorDetail(payload, raw, response) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.message) {
    return String(payload.message);
  }
  return raw?.trim() || response?.statusText || "request_failed";
}

function matchesExecutionPullRequest({ pullRequest, owner, head, base }) {
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) return false;
  if (pullRequest.state && pullRequest.state !== "open") return false;
  const headRef = pullRequest.head?.ref;
  const headLabel = pullRequest.head?.label;
  const headOwner = pullRequest.head?.repo?.owner?.login
    ?? pullRequest.head?.user?.login;
  if (headRef !== head && headLabel !== `${owner}:${head}`) return false;
  if (headOwner && headOwner !== owner && headLabel !== `${owner}:${head}`) return false;
  return pullRequest.base?.ref === base;
}

function matchesPullRequestHead({ pullRequest, owner, head }) {
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) return false;
  const headRef = pullRequest.head?.ref;
  const headLabel = pullRequest.head?.label;
  const headOwner = pullRequest.head?.repo?.owner?.login
    ?? pullRequest.head?.user?.login;
  if (headRef !== head && headLabel !== `${owner}:${head}`) return false;
  if (headOwner && headOwner !== owner && headLabel !== `${owner}:${head}`) return false;
  return true;
}

function normalizePullRequestForHead(pullRequest) {
  return Object.freeze({
    number: pullRequest.number,
    state: pullRequest.state,
    base: pullRequest.base?.ref ?? pullRequest.base ?? null,
    head_sha: stringValue(pullRequest.head?.sha ?? pullRequest.head_sha) || null,
  });
}

function normalizePullRequestComment(comment) {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
    throw new Error("github_execution_pr_comment_unexpected_response_shape");
  }
  const commentId = comment.comment_id ?? comment.id;
  if (commentId == null || String(commentId).trim() === "") {
    throw new Error("github_execution_pr_comment_missing_id");
  }
  return Object.freeze({
    ...comment,
    comment_id: commentId,
  });
}

function unwrapGitHubData(response) {
  if (response && typeof response === "object" && Object.hasOwn(response, "data")) {
    return response.data;
  }
  return response;
}

function isDuplicatePullRequestError(error) {
  const status = error?.status ?? error?.statusCode ?? error?.github?.status;
  if (Number(status) !== 422) return false;
  const message = `${error?.message || ""} ${error?.github?.message || ""}`;
  return /pull request|validation failed|already exists/i.test(message);
}

function assertBranchRef(ref, label) {
  const value = assertNonEmptyString(ref, label, {
    error: `github_execution_pr_${label}_ref_required`,
  });
  const result = validateGitBranchRef(value, `github_execution_pr_${label}_ref_invalid`);
  if (!result.ok) throw new Error(result.reason);
  return result.ref;
}

function assertPullRequestNumber(number) {
  return assertPositiveInteger(number, "pull_request_number");
}

function assertPositiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`github_execution_pr_${label}_invalid`);
  }
  return number;
}

function assertHeadSha(value) {
  const sha = assertNonEmptyString(value, "head_sha");
  if (/[\x00-\x20\x7f/\\?#]/.test(sha)) {
    throw new Error("github_execution_pr_head_sha_invalid");
  }
  return sha;
}

function assertAfReviewStatusContext(value) {
  const context = assertNonEmptyString(value, "status_context");
  if (context !== AF_REVIEW_STATUS_CONTEXT) {
    throw new Error("github_execution_pr_status_context_not_af_review");
  }
  return context;
}

function assertCommitStatusState(value) {
  const state = assertNonEmptyString(value, "status_state");
  if (state !== "success" && state !== "failure") {
    throw new Error("github_execution_pr_status_state_invalid");
  }
  return state;
}

function assertPullRequestHeadListState(value) {
  const state = assertNonEmptyString(value, "pull_request_state");
  if (state !== "all") {
    throw new Error("github_execution_pr_head_list_state_must_be_all");
  }
  return state;
}

function assertUrlString(value, label) {
  const url = assertNonEmptyString(value, label);
  try {
    new URL(url);
  } catch {
    throw new Error(`github_execution_pr_${label}_invalid`);
  }
  return url;
}

function normalizeChangedFilesCount(value) {
  if (value == null) return null;
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("github_execution_pr_changed_files_unexpected_response_shape");
  }
  return count;
}

function evaluateGitHubPullRequestFilesCompleteness({
  files,
  changedFiles,
  changedFilesCapExceeded,
  pageCapHit,
}) {
  if (changedFilesCapExceeded) {
    return { diff_incomplete: true, reason: "changed_files_cap_exceeded" };
  }
  if (pageCapHit) {
    return { diff_incomplete: true, reason: "files_page_cap_hit" };
  }
  if (changedFiles != null && files.length !== changedFiles) {
    return { diff_incomplete: true, reason: "changed_files_mismatch" };
  }
  const missingPatchFile = files.find((file) => filePatchMissing(file));
  if (missingPatchFile) {
    return {
      diff_incomplete: true,
      reason: isBinaryOrOversizedPullRequestFile(missingPatchFile)
        ? "binary_or_oversized_patch_missing"
        : "patch_missing",
    };
  }
  return { diff_incomplete: false };
}

function filePatchMissing(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("github_execution_pr_file_unexpected_response_shape");
  }
  return typeof file.patch !== "string";
}

function isBinaryOrOversizedPullRequestFile(file) {
  if (file.binary === true || file.is_binary === true || file.truncated === true || file.too_large === true) {
    return true;
  }
  if (typeof file.reason === "string" && /binary|large|oversize|truncated/i.test(file.reason)) {
    return true;
  }
  const changes = Number(file.changes ?? 0);
  const additions = Number(file.additions ?? 0);
  const deletions = Number(file.deletions ?? 0);
  return changes > 0 && additions === 0 && deletions === 0;
}

function validateGitBranchRef(ref, invalidReason) {
  const value = typeof ref === "string" ? ref : "";
  if (value === "" || value.trim() !== value) return invalid(invalidReason);
  if (value.startsWith("/") || value.endsWith("/")) return invalid(invalidReason);
  if (value.startsWith("refs/heads/")) return invalid(invalidReason);
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return invalid(invalidReason);
  if (value.endsWith(".") || value.endsWith(".lock")) return invalid(invalidReason);
  if (/[\x00-\x20\x7f~^:?*\[\\\]]/.test(value)) return invalid(invalidReason);
  const segments = value.split("/");
  if (segments.some((segment) =>
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.startsWith(".") ||
    segment.endsWith(".lock"))) {
    return invalid(invalidReason);
  }
  return { ok: true, ref: value };
}

function assertRepoSlug(value, label) {
  if (/[\x00-\x20\x7f/\\]/.test(value)) {
    throw new Error(`github_execution_pr_repo_identity_invalid_${label}`);
  }
}

function assertNonEmptyString(value, label, { error } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(error || `github_execution_pr_${label}_required`);
  }
  return value.trim();
}

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function invalid(reason) {
  return { ok: false, reason };
}

export function formatAfReviewCommentBody({
  body,
  context = AF_REVIEW_STATUS_CONTEXT,
  disposition,
  head_sha,
  run_id,
} = {}) {
  const humanBody = assertNonEmptyString(body, "comment_body").replace(/\s+$/u, "");
  return `${humanBody}\n\n${serializeAfReviewMarker({
    context,
    disposition,
    head_sha,
    run_id,
  })}`;
}

export function serializeAfReviewMarker({
  context = AF_REVIEW_STATUS_CONTEXT,
  disposition,
  head_sha,
  run_id,
} = {}) {
  const payload = normalizeAfReviewMarkerPayload({
    context,
    disposition,
    head_sha,
    run_id,
  });
  return `<!-- af-review:${JSON.stringify(payload)} -->`;
}

export function parseAfReviewCommentMarker(body) {
  const text = typeof body === "string" ? body : "";
  const matches = [...text.matchAll(/^<!-- af-review:(\{.*\}) -->$/gm)];
  if (matches.length === 0) {
    return Object.freeze({ ok: false, reason: "missing" });
  }
  const raw = matches[matches.length - 1][1];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: "malformed",
      raw,
      error: error?.message || String(error),
    });
  }
  try {
    const marker = normalizeAfReviewMarkerPayload(parsed);
    return Object.freeze({
      ok: true,
      marker,
      lookup_key: markerLookupKey(marker),
      marker_count: matches.length,
      raw,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: "malformed",
      raw,
      error: error?.message || String(error),
    });
  }
}

export function lookupAfReviewCommentByMarker(
  comments,
  {
    context = AF_REVIEW_STATUS_CONTEXT,
    head_sha,
    disposition,
  } = {},
) {
  if (!Array.isArray(comments)) {
    throw new Error("github_execution_pr_comments_required");
  }
  const expected = markerLookupKey(normalizeAfReviewMarkerPayload({
    context,
    disposition,
    head_sha,
    run_id: "lookup-run-id",
  }));
  const matches = [];
  const malformed = [];

  for (const comment of comments) {
    const parsed = parseAfReviewCommentMarker(comment?.body);
    if (parsed.ok) {
      if (sameMarkerLookupKey(parsed.lookup_key, expected)) {
        matches.push(Object.freeze({
          comment: normalizePullRequestComment(comment),
          marker: parsed.marker,
        }));
      }
      continue;
    }
    if (parsed.reason === "malformed") {
      malformed.push(Object.freeze({
        comment: comment && typeof comment === "object" ? normalizePullRequestComment(comment) : comment,
        parse: parsed,
      }));
    }
  }

  if (malformed.length > 0) {
    return Object.freeze({
      status: "malformed",
      matches: Object.freeze(matches),
      malformed: Object.freeze(malformed),
    });
  }
  if (matches.length === 0) {
    return Object.freeze({
      status: "missing",
      matches: Object.freeze([]),
      malformed: Object.freeze([]),
    });
  }
  if (matches.length > 1) {
    return Object.freeze({
      status: "multiple",
      matches: Object.freeze(matches),
      malformed: Object.freeze([]),
    });
  }
  return Object.freeze({
    status: "found",
    comment: matches[0].comment,
    marker: matches[0].marker,
    matches: Object.freeze(matches),
    malformed: Object.freeze([]),
  });
}

function bodyHasAfReviewMarker(body) {
  return parseAfReviewCommentMarker(typeof body === "string" ? body : "").ok;
}

function normalizeAfReviewMarkerPayload(payload = {}) {
  const context = assertAfReviewStatusContext(payload.context);
  const disposition = assertNonEmptyString(payload.disposition, "review_disposition");
  const headSha = assertHeadSha(payload.head_sha);
  const runId = assertNonEmptyString(payload.run_id, "run_id");
  return Object.freeze({
    context,
    disposition,
    head_sha: headSha,
    run_id: runId,
  });
}

function markerLookupKey(marker) {
  return Object.freeze({
    context: marker.context,
    head_sha: marker.head_sha,
    disposition: marker.disposition,
  });
}

function sameMarkerLookupKey(left, right) {
  return left?.context === right?.context
    && left?.head_sha === right?.head_sha
    && left?.disposition === right?.disposition;
}

function redactToken(text, token) {
  const value = String(text ?? "");
  if (typeof token !== "string" || token === "") return value;
  return value.split(token).join("[redacted]");
}
