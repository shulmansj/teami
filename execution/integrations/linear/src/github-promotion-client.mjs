import { validatePromotionBranchRef } from "./promotion-workspace.mjs";

// GitHub client for the promotion controller. The default controller path can
// still run dry-run, while production writes go through the adopter's local
// git/gh auth via github-production-transport.mjs.
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
