import { validatePromotionBranchRef } from "./promotion-workspace.mjs";

// GitHub client for the promotion controller. The default controller path can
// still run dry-run, but the real transport below is broker-backed: the hosted
// token broker owns the GitHub App private key and mints short-lived
// installation tokens for this selected repo. The broker receives only repo
// identity + permission request; PR titles/bodies/evidence stay local and are
// sent directly to GitHub by this client.
//
// NO-MERGE PROMISE (CONSTRAINTS #8): the MVP no-merge promise is enforced in
// the CLIENT, not through permission shape — the same contents permission
// needed for proposal commits could merge a PR. This module therefore has:
//   - an explicit endpoint ALLOWLIST with no merge, no mark-ready, and no
//     review-approve endpoint of any kind, and
//   - no merge-shaped method on the client object at all.
// Tests pin both properties. Adding a merge endpoint here is a v2 product
// decision behind the auto-acceptance invariants (plan ~1701-1731), never a
// convenience patch.
//
// TOKEN CUSTODY DESIGN (documented for the real transport; CONSTRAINTS #22):
// the hosted Agentic Factory token broker owns the GitHub App private key and
// mints short-lived installation tokens scoped to the selected behavior repo
// with ONLY metadata:read, contents:read/write, pull_requests:read/write (no
// issues, no workflows). The local transport requests a token per operation,
// keeps it only in local credential custody (OS credential store pattern from
// linear-credential-store.mjs) while active, refreshes mid-operation on
// expiry, and NEVER commits, traces, logs, or sends it to the hosted inbox,
// Linear, Phoenix, model providers, or proposal evidence (reuse
// findSecretContentKeys/redactOAuthSecrets at every boundary). Broker
// unavailable -> GitHub work fails closed and stays pending.

export const GITHUB_PROMOTION_ENDPOINT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "list_open_pull_requests",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    fixed_query: Object.freeze({ state: "open" }),
  }),
  Object.freeze({
    id: "list_closed_pull_requests",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    fixed_query: Object.freeze({ state: "closed" }),
  }),
  Object.freeze({
    id: "get_pull_request",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls/{number}",
  }),
  Object.freeze({
    id: "create_pull_request",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls",
  }),
  Object.freeze({
    id: "update_pull_request_body",
    method: "PATCH",
    path: "/repos/{owner}/{repo}/pulls/{number}",
  }),
]);

function endpointById(endpointId) {
  const endpoint = GITHUB_PROMOTION_ENDPOINT_ALLOWLIST.find((entry) => entry.id === endpointId);
  if (!endpoint) {
    throw new Error(`github_endpoint_not_allowlisted:${endpointId}`);
  }
  return endpoint;
}

export function assertGitHubPromotionEndpointShape({ endpointId, method, path } = {}) {
  const endpoint = endpointById(endpointId);
  if (method !== endpoint.method || path !== endpoint.path) {
    throw new Error(`github_endpoint_shape_mismatch:${endpointId}`);
  }
  return endpoint;
}

export function assertPromotionPullRequestHead(head) {
  if (!validatePromotionBranchRef(head).ok) {
    throw new Error("github_promotion_pr_head_not_proposal_branch");
  }
}

// The client exposes exactly the five allowlisted operations. There is
// deliberately no mergePullRequest, no markReadyForReview, no createReview,
// no approve — not as disabled stubs, but absent codepaths.
export function createGitHubPromotionClient({ transport, repo } = {}) {
  if (!transport || typeof transport.request !== "function") {
    throw new Error("github_transport_required");
  }
  if (!repo?.owner || !repo?.repo) {
    throw new Error("github_repo_identity_required");
  }
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
  return {
    allowlist: GITHUB_PROMOTION_ENDPOINT_ALLOWLIST,
    repo: { owner: repo.owner, repo: repo.repo },
    async listOpenPullRequests() {
      return call("list_open_pull_requests");
    },
    async listClosedPullRequests() {
      return call("list_closed_pull_requests");
    },
    async getPullRequest({ number }) {
      return call("get_pull_request", { number });
    },
    async createPullRequest({ title, head, base, body, draft = false }) {
      assertPromotionPullRequestHead(head);
      return call("create_pull_request", { title, head, base, body, draft });
    },
    async updatePullRequestBody({ number, body }) {
      return call("update_pull_request_body", { number, body });
    },
  };
}

// Dry-run transport: records every call, returns canned shapes, marks
// everything dry_run: true, touches no network and no credentials.
export function createDryRunGitHubTransport({ now = () => new Date() } = {}) {
  const calls = [];
  let nextNumber = 9000;
  return {
    kind: "dry_run",
    calls,
    async request({ endpointId, method, path, owner, repo, params = {} }) {
      assertGitHubPromotionEndpointShape({ endpointId, method, path });
      const call = { endpointId, method, path, owner, repo, params, at: now().toISOString() };
      calls.push(call);
      if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
        return { dry_run: true, data: [] };
      }
      if (endpointId === "get_pull_request") {
        return { dry_run: true, data: null };
      }
      if (endpointId === "create_pull_request") {
        nextNumber += 1;
        return {
          dry_run: true,
          data: {
            number: nextNumber,
            state: "open",
            draft: Boolean(params.draft),
            title: params.title,
            body: params.body,
            head: { ref: params.head },
            base: { ref: params.base },
            html_url: `dry-run://github/${owner}/${repo}/pull/${nextNumber}`,
            created_at: now().toISOString(),
            merged_at: null,
            closed_at: null,
          },
        };
      }
      if (endpointId === "update_pull_request_body") {
        return { dry_run: true, data: { number: params.number, body: params.body } };
      }
      throw new Error(`github_endpoint_not_allowlisted:${endpointId}`);
    },
  };
}

// Mock transport for tests: fixture-backed lists, deterministic created PRs,
// injectable per-endpoint failures (used by the recovery tests).
export function createMockGitHubTransport({
  openPullRequests = [],
  closedPullRequests = [],
  failures = {},
  now = () => new Date("2026-06-10T03:00:00.000Z"),
} = {}) {
  const calls = [];
  const created = [];
  const failureCounters = new Map();
  let nextNumber = 100
    + openPullRequests.length
    + closedPullRequests.length;
  const maybeFail = (endpointId) => {
    const failure = failures[endpointId];
    if (!failure) return;
    const used = failureCounters.get(endpointId) || 0;
    const times = typeof failure.times === "number" ? failure.times : Infinity;
    if (used >= times) return;
    failureCounters.set(endpointId, used + 1);
    throw failure.error instanceof Error ? failure.error : new Error(String(failure.error || `mock_${endpointId}_failure`));
  };
  return {
    kind: "mock",
    calls,
    created,
    async request({ endpointId, method, path, owner, repo, params = {} }) {
      assertGitHubPromotionEndpointShape({ endpointId, method, path });
      calls.push({ endpointId, method, path, owner, repo, params });
      maybeFail(endpointId);
      if (endpointId === "list_open_pull_requests") {
        return { data: [...openPullRequests, ...created.filter((pr) => pr.state === "open")] };
      }
      if (endpointId === "list_closed_pull_requests") {
        return { data: [...closedPullRequests, ...created.filter((pr) => pr.state === "closed")] };
      }
      if (endpointId === "get_pull_request") {
        const all = [...openPullRequests, ...closedPullRequests, ...created];
        return { data: all.find((pr) => pr.number === params.number) || null };
      }
      if (endpointId === "create_pull_request") {
        nextNumber += 1;
        const pr = {
          number: nextNumber,
          state: "open",
          draft: Boolean(params.draft),
          title: params.title,
          body: params.body,
          head: { ref: params.head },
          base: { ref: params.base },
          html_url: `mock://github/${owner}/${repo}/pull/${nextNumber}`,
          created_at: now().toISOString(),
          merged_at: null,
          closed_at: null,
        };
        created.push(pr);
        return { data: pr };
      }
      if (endpointId === "update_pull_request_body") {
        const all = [...openPullRequests, ...closedPullRequests, ...created];
        const pr = all.find((entry) => entry.number === params.number);
        if (pr) pr.body = params.body;
        return { data: pr || null };
      }
      throw new Error(`github_endpoint_not_allowlisted:${endpointId}`);
    },
  };
}

export function createBrokerGitHubTransport({
  brokerClient = null,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = "https://api.github.com",
  now = () => new Date(),
} = {}) {
  if (!brokerClient || typeof brokerClient.mintInstallationToken !== "function") {
    throw new Error("github_broker_not_configured: configure the hosted GitHub token broker client before using the real promotion transport");
  }
  if (typeof fetchImpl !== "function") throw new Error("github_transport_fetch_required");
  const calls = [];
  const baseUrl = apiBaseUrl.replace(/\/+$/, "");
  return {
    kind: "real_broker",
    calls,
    async request({ endpointId, method, path, owner, repo, params = {} }) {
      assertGitHubPromotionEndpointShape({ endpointId, method, path });
      const call = { endpointId, method, path, owner, repo, params: safeCallParams(params), at: now().toISOString() };
      calls.push(call);
      const token = await brokerClient.mintInstallationToken({
        owner,
        repo,
        permissions: permissionsForEndpoint(endpointId),
      });
      const response = await githubRestRequest({
        fetchImpl,
        baseUrl,
        token: token.token,
        endpointId,
        owner,
        repo,
        params,
      });
      return { data: response };
    },
  };
}

function permissionsForEndpoint(endpointId) {
  if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests" || endpointId === "get_pull_request") {
    return { pull_requests: "read" };
  }
  return { contents: "write", pull_requests: "write" };
}

function safeCallParams(params = {}) {
  // Keep transport call traces useful without retaining PR body content or
  // proposal evidence in local logs.
  const copy = { ...params };
  if (typeof copy.body === "string") copy.body = `[redacted github body length=${copy.body.length}]`;
  return copy;
}

async function githubRestRequest({ fetchImpl, baseUrl, token, endpointId, owner, repo, params }) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  let url;
  let method = "GET";
  let body = null;
  if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
    const state = endpointId === "list_open_pull_requests" ? "open" : "closed";
    return githubRestPaginatedPullRequestList({
      fetchImpl,
      baseUrl,
      token,
      headers,
      endpointId,
      owner,
      repo,
      state,
    });
  } else if (endpointId === "get_pull_request") {
    url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(params.number)}`;
  } else if (endpointId === "create_pull_request") {
    method = "POST";
    url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
    body = JSON.stringify({
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: Boolean(params.draft),
    });
  } else if (endpointId === "update_pull_request_body") {
    method = "PATCH";
    url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(params.number)}`;
    body = JSON.stringify({ body: params.body });
  } else {
    throw new Error(`github_endpoint_not_allowlisted:${endpointId}`);
  }
  const response = await fetchImpl(url, {
    method,
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    ...(body ? { body } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`github_api_request_failed:${endpointId}:HTTP_${response.status}:${payload?.message || "unknown"}`);
  }
  return payload;
}

async function githubRestPaginatedPullRequestList({
  fetchImpl,
  baseUrl,
  token,
  headers,
  endpointId,
  owner,
  repo,
  state,
} = {}) {
  const perPage = 100;
  const maxPages = 50;
  const combined = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${perPage}&page=${page}`;
    let response;
    let text;
    let payload;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
      text = await response.text();
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      if (page > 1) {
        throw new Error(`github_pr_listing_truncated:${endpointId}:page_${page}:${error.message}`);
      }
      throw error;
    }
    if (!response.ok) {
      const message = payload?.message || "unknown";
      if (page > 1) {
        throw new Error(`github_pr_listing_truncated:${endpointId}:HTTP_${response.status}:${message}`);
      }
      throw new Error(`github_api_request_failed:${endpointId}:HTTP_${response.status}:${message}`);
    }
    if (!Array.isArray(payload)) {
      throw new Error(`github_api_request_failed:${endpointId}:unexpected_response_shape`);
    }
    combined.push(...payload);
    if (payload.length < perPage) return combined;
  }
  throw new Error(`github_pr_listing_truncated:${endpointId}:page_cap_${maxPages}`);
}
