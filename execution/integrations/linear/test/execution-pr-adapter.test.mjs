import assert from "node:assert/strict";
import test from "node:test";

import {
  AF_REVIEW_COMMENT_MARKER_EXAMPLE,
  AF_REVIEW_STATUS_CONTEXT,
  AMBIENT_GITHUB_TOKEN_ENV_NAMES,
  assertGitHubExecutionPrEndpointShape,
  createExecutionPullRequestAdapter,
  createFetchExecutionPrTransport,
  formatAfReviewCommentBody,
  lookupAfReviewCommentByMarker,
  parseAfReviewCommentMarker,
  resolveAmbientGitHubToken,
  serializeAfReviewMarker,
  validateExecutionBranchRef,
} from "../src/execution-pr-adapter.mjs";
import {
  GITHUB_TOKEN_ENV_NAMES,
  resolveAmbientGitHubToken as pushPathResolveAmbientGitHubToken,
} from "../../git/git-remote-auth.mjs";

const REPO = {
  owner: "acme",
  repo: "app",
  default_branch: "main",
};
const HEAD = "af/execution/lin-123/run-abc";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

test("ensurePullRequest probes an existing execution PR and does not create a duplicate", async () => {
  const existing = pullRequest({ number: 42, head: HEAD, base: "main" });
  const transport = createFakeExecutionPrTransport({ openPullRequests: [existing] });
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });

  const result = await adapter.ensurePullRequest({
    title: "Ship LIN-123",
    body: "Implementation notes",
    head: HEAD,
  });

  assert.equal(result.created, false);
  assert.deepEqual(result.pr, existing);
  assert.deepEqual(transport.created, []);
  assert.deepEqual(
    transport.calls.map(({ endpointId, owner, repo, params }) => ({
      endpointId,
      owner,
      repo,
      params,
    })),
    [{
      endpointId: "probe_execution_pull_request",
      owner: "acme",
      repo: "app",
      params: { head: HEAD, base: "main" },
    }],
  );
});

test("ensurePullRequest creates once, then reuses the probed PR on replay", async () => {
  const transport = createFakeExecutionPrTransport();
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });

  const first = await adapter.ensurePullRequest({
    title: "Ship LIN-123",
    body: "Implementation notes",
    head: HEAD,
    draft: true,
  });
  const second = await adapter.ensurePullRequest({
    title: "Ship LIN-123",
    body: "Implementation notes",
    head: HEAD,
    draft: true,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.pr.number, first.pr.number);
  assert.equal(transport.created.length, 1);
  assert.deepEqual(
    transport.calls.map((call) => call.endpointId),
    [
      "probe_execution_pull_request",
      "create_execution_pull_request",
      "probe_execution_pull_request",
    ],
  );
  assert.deepEqual(transport.created[0].head, {
    ref: HEAD,
    label: "acme:af/execution/lin-123/run-abc",
    repo: { owner: { login: "acme" }, name: "app" },
  });
});

test("execution branch validation accepts only af/execution refs before the transport seam", async () => {
  assert.deepEqual(validateExecutionBranchRef(HEAD), { ok: true, ref: HEAD });

  const transport = createFakeExecutionPrTransport();
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });

  for (const head of [
    "teami/promotion/proposal/abc123",
    "refs/heads/af/execution/lin-123/run-abc",
    "af/execution",
    "af/execution/../main",
  ]) {
    await assert.rejects(
      () => adapter.ensurePullRequest({ title: "Rejected", body: "", head }),
      /github_execution_pr_head/,
      `head ${head} must be rejected`,
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("fetch REST transport uses adopter ambient auth, not the deleted broker token", async () => {
  assert.equal(resolveAmbientGitHubToken({ TEAMI_GITHUB_INSTALLATION_TOKEN: "broker-token" }), null);
  assert.equal(resolveAmbientGitHubToken({ GH_TOKEN: "  fake-tok  " }), "fake-tok");

  const brokerOnly = createFetchExecutionPrTransport({
    env: { TEAMI_GITHUB_INSTALLATION_TOKEN: "broker-token" },
    resolveGhToken: () => null,
    fetchImpl: async () => {
      throw new Error("must_not_fetch_without_ambient_auth");
    },
  });
  await assert.rejects(
    () => brokerOnly.request({
      endpointId: "probe_execution_pull_request",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls",
      owner: "acme",
      repo: "app",
      params: { head: HEAD, base: "main" },
    }),
    /github_execution_pr_auth_required/,
  );

  const fetchCalls = [];
  const rest = createFetchExecutionPrTransport({
    env: { GH_TOKEN: "fake-tok" },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse([]);
    },
  });

  const response = await rest.request({
    endpointId: "probe_execution_pull_request",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    owner: "acme",
    repo: "app",
    params: { head: HEAD, base: "main" },
  });

  assert.deepEqual(response, { data: [] });
  assert.equal(fetchCalls.length, 1);
  const url = new URL(fetchCalls[0].url);
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(url.pathname, "/repos/acme/app/pulls");
  assert.equal(url.searchParams.get("state"), "open");
  assert.equal(url.searchParams.get("head"), `acme:${HEAD}`);
  assert.equal(url.searchParams.get("base"), "main");
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(fetchCalls[0].init.body, null);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer fake-tok");
});

test("PR API auth resolution is the push path's, by identity, not by copy", () => {
  assert.equal(AMBIENT_GITHUB_TOKEN_ENV_NAMES, GITHUB_TOKEN_ENV_NAMES);
  assert.equal(resolveAmbientGitHubToken, pushPathResolveAmbientGitHubToken);
});

// The live 2026-07-05 sandbox failure: a gateway started from a shell where
// gh is logged in but no token env var is exported pushed the branch fine
// (push path falls back to `gh auth token`) and then dead-lettered the run
// with github_execution_pr_auth_required. The PR API leg must fall back to
// the same gh authority.
test("env-less transport with gh logged in resolves PR API auth from the gh CLI, cached across requests", async () => {
  let ghResolutions = 0;
  const fetchCalls = [];
  const rest = createFetchExecutionPrTransport({
    env: {},
    resolveGhToken: () => {
      ghResolutions += 1;
      return "cli-tok";
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse([]);
    },
  });

  await probeRequest(rest);
  await probeRequest(rest);

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer cli-tok");
  assert.equal(fetchCalls[1].init.headers.Authorization, "Bearer cli-tok");
  assert.equal(ghResolutions, 1, "gh must be consulted once per transport, not once per request");
});

test("ambient env token wins without consulting the gh CLI", async () => {
  const fetchCalls = [];
  const rest = createFetchExecutionPrTransport({
    env: { GH_TOKEN: "env-tok" },
    resolveGhToken: () => {
      throw new Error("must_not_spawn_gh_when_env_token_present");
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse([]);
    },
  });

  await probeRequest(rest);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer env-tok");
});

test("a failed gh resolution is not cached, so gh auth login heals a running transport", async () => {
  let ghToken = null;
  const fetchCalls = [];
  const rest = createFetchExecutionPrTransport({
    env: {},
    resolveGhToken: () => ghToken,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse([]);
    },
  });

  await assert.rejects(() => probeRequest(rest), /github_execution_pr_auth_required/);
  assert.equal(fetchCalls.length, 0);

  ghToken = "relog-tok";
  await probeRequest(rest);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer relog-tok");
});

test("gh fallback stays off for a non-default apiBaseUrl so fixture servers never see a real login", async () => {
  const rest = createFetchExecutionPrTransport({
    env: {},
    apiBaseUrl: "http://127.0.0.1:9999",
    resolveGhToken: () => "real-login-must-not-leak",
    fetchImpl: async () => {
      throw new Error("must_not_fetch_without_auth");
    },
  });

  await assert.rejects(() => probeRequest(rest), /github_execution_pr_auth_required/);
});

function probeRequest(transport) {
  return transport.request({
    endpointId: "probe_execution_pull_request",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
    owner: "acme",
    repo: "app",
    params: { head: HEAD, base: "main" },
  });
}

test("fetch REST transport pins review and merge endpoint paths and bodies behind the allowlist", async () => {
  const fetchCalls = [];
  const rest = createFetchExecutionPrTransport({
    env: { GH_TOKEN: "fake-tok" },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse({ id: 777 });
    },
  });

  async function request(endpointId, method, path, params = {}) {
    await rest.request({ endpointId, method, path, owner: "acme", repo: "app", params });
    return fetchCalls[fetchCalls.length - 1];
  }

  let call = await request(
    "get_execution_pull_request",
    "GET",
    "/repos/{owner}/{repo}/pulls/{number}",
    { number: 7 },
  );
  assert.equal(new URL(call.url).pathname, "/repos/acme/app/pulls/7");
  assert.equal(call.init.body, null);

  call = await request(
    "get_execution_pull_request_files",
    "GET",
    "/repos/{owner}/{repo}/pulls/{number}/files",
    { number: 7, page: 2 },
  );
  let url = new URL(call.url);
  assert.equal(url.pathname, "/repos/acme/app/pulls/7/files");
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.equal(url.searchParams.get("page"), "2");

  call = await request(
    "get_execution_commit_statuses",
    "GET",
    "/repos/{owner}/{repo}/commits/{sha}/statuses",
    { head_sha: HEAD_SHA },
  );
  url = new URL(call.url);
  assert.equal(url.pathname, `/repos/acme/app/commits/${HEAD_SHA}/statuses`);
  assert.equal(url.searchParams.get("per_page"), "100");

  call = await request(
    "set_execution_commit_status",
    "POST",
    "/repos/{owner}/{repo}/statuses/{sha}",
    {
      head_sha: HEAD_SHA,
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "failure",
      description: "Review requested changes",
      target_url: "https://example.test/reviews/1",
    },
  );
  assert.equal(new URL(call.url).pathname, `/repos/acme/app/statuses/${HEAD_SHA}`);
  assert.deepEqual(JSON.parse(call.init.body), {
    state: "failure",
    context: AF_REVIEW_STATUS_CONTEXT,
    description: "Review requested changes",
    target_url: "https://example.test/reviews/1",
  });

  call = await request(
    "post_execution_pull_request_comment",
    "POST",
    "/repos/{owner}/{repo}/issues/{number}/comments",
    { number: 7, body: AF_REVIEW_COMMENT_MARKER_EXAMPLE },
  );
  assert.equal(new URL(call.url).pathname, "/repos/acme/app/issues/7/comments");
  assert.deepEqual(JSON.parse(call.init.body), { body: AF_REVIEW_COMMENT_MARKER_EXAMPLE });

  call = await request(
    "list_execution_pull_request_comments",
    "GET",
    "/repos/{owner}/{repo}/issues/{number}/comments",
    { number: 7 },
  );
  url = new URL(call.url);
  assert.equal(url.pathname, "/repos/acme/app/issues/7/comments");
  assert.equal(url.searchParams.get("per_page"), "100");

  call = await request(
    "list_execution_pull_requests_for_head",
    "GET",
    "/repos/{owner}/{repo}/pulls",
    { head: HEAD, state: "all" },
  );
  url = new URL(call.url);
  assert.equal(url.pathname, "/repos/acme/app/pulls");
  assert.equal(url.searchParams.get("state"), "all");
  assert.equal(url.searchParams.get("head"), `acme:${HEAD}`);
  assert.equal(url.searchParams.get("per_page"), "100");

  call = await request(
    "merge_execution_pull_request",
    "PUT",
    "/repos/{owner}/{repo}/pulls/{number}/merge",
    { number: 7, expectedHeadSha: HEAD_SHA },
  );
  assert.equal(new URL(call.url).pathname, "/repos/acme/app/pulls/7/merge");
  assert.deepEqual(JSON.parse(call.init.body), { sha: HEAD_SHA });
});

test("af-review marker bytes are stable and lookup reports found, missing, multiple, and malformed", () => {
  const marker = serializeAfReviewMarker({
    disposition: "approved",
    head_sha: HEAD_SHA,
    run_id: "run-123",
  });
  assert.equal(
    marker,
    `<!-- af-review:{"context":"af-review","disposition":"approved","head_sha":"${HEAD_SHA}","run_id":"run-123"} -->`,
  );
  assert.equal(AF_REVIEW_COMMENT_MARKER_EXAMPLE, `Review notes\n\n${marker}`);
  const body = formatAfReviewCommentBody({
    body: "Review notes\n",
    disposition: "approved",
    head_sha: HEAD_SHA,
    run_id: "run-123",
  });
  assert.equal(body, AF_REVIEW_COMMENT_MARKER_EXAMPLE);

  const parsed = parseAfReviewCommentMarker(body);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.marker, {
    context: AF_REVIEW_STATUS_CONTEXT,
    disposition: "approved",
    head_sha: HEAD_SHA,
    run_id: "run-123",
  });
  assert.deepEqual(parsed.lookup_key, {
    context: AF_REVIEW_STATUS_CONTEXT,
    head_sha: HEAD_SHA,
    disposition: "approved",
  });

  const comments = [{ id: 1, body, created_at: "2026-06-28T00:00:00.000Z" }];
  assert.equal(lookupAfReviewCommentByMarker(comments, {
    head_sha: HEAD_SHA,
    disposition: "approved",
  }).status, "found");
  assert.equal(lookupAfReviewCommentByMarker(comments, {
    head_sha: HEAD_SHA,
    disposition: "request_changes",
  }).status, "missing");
  assert.equal(lookupAfReviewCommentByMarker([...comments, { id: 2, body }], {
    head_sha: HEAD_SHA,
    disposition: "approved",
  }).status, "multiple");
  assert.equal(lookupAfReviewCommentByMarker([{ id: 3, body: "<!-- af-review:{bad-json} -->" }], {
    head_sha: HEAD_SHA,
    disposition: "approved",
  }).status, "malformed");
});

test("adapter writes af-review commit statuses and marker comments, with no review verb", async () => {
  const existing = pullRequest({
    number: 7,
    head: HEAD,
    base: "main",
    headSha: HEAD_SHA,
  });
  const transport = createFakeExecutionPrTransport({ openPullRequests: [existing] });
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });

  assert.equal(typeof adapter.mergePullRequest, "function");
  assert.equal(adapter.createReview, undefined);
  assert.equal(adapter.submitReview, undefined);

  const status = await adapter.setCommitStatus({
    head_sha: HEAD_SHA,
    state: "success",
    description: "Review passed",
    target_url: "https://example.test/reviews/1",
  });
  assert.equal(status.context, AF_REVIEW_STATUS_CONTEXT);
  assert.equal(status.state, "success");

  const statuses = await adapter.getCommitStatuses(HEAD_SHA);
  assert.deepEqual(statuses.map(({ context, state }) => ({ context, state })), [{
    context: AF_REVIEW_STATUS_CONTEXT,
    state: "success",
  }]);

  const posted = await adapter.postPullRequestComment({
    number: 7,
    body: "Review passed",
    disposition: "approved",
    head_sha: HEAD_SHA,
    run_id: "run-123",
  });
  assert.equal(posted.comment_id, 1);

  const comments = await adapter.listPullRequestComments(7);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].comment_id, 1);
  assert.equal(parseAfReviewCommentMarker(comments[0].body).ok, true);

  const lookup = await adapter.findPullRequestCommentByAfReviewMarker({
    number: 7,
    head_sha: HEAD_SHA,
    disposition: "approved",
  });
  assert.equal(lookup.status, "found");
  assert.equal(lookup.comment.comment_id, 1);

  const merged = await adapter.mergePullRequest({
    number: 7,
    expectedHeadSha: HEAD_SHA,
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.sha, HEAD_SHA);
});

test("listPullRequestsForHead uses state all so closed PRs are distinct from no PR", async () => {
  const closed = pullRequest({
    number: 8,
    state: "closed",
    head: HEAD,
    base: "main",
    headSha: HEAD_SHA,
  });
  const transport = createFakeExecutionPrTransport({ closedPullRequests: [closed] });
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });

  assert.equal(await adapter.probePullRequest({ head: HEAD }), null);
  assert.deepEqual(await adapter.listPullRequestsForHead(HEAD, { state: "all" }), [{
    number: 8,
    state: "closed",
    base: "main",
    head_sha: HEAD_SHA,
  }]);
  assert.deepEqual(await adapter.listPullRequestsForHead("af/execution/lin-123/run-none", { state: "all" }), []);
});

test("getPullRequestFiles reports GitHub API diff completeness, not execution diff budget", async () => {
  const complete = await filesResult({
    changed_files: 1,
    files: [pullRequestFile({ filename: "src/app.mjs", patch: "@@ -1 +1 @@" })],
  });
  assert.equal(complete.diff_incomplete, false);
  assert.equal(complete.reason, undefined);

  const cap = await filesResult({
    changed_files: 3001,
    files: [],
  });
  assert.equal(cap.diff_incomplete, true);
  assert.equal(cap.reason, "changed_files_cap_exceeded");

  const mismatch = await filesResult({
    changed_files: 2,
    files: [pullRequestFile({ filename: "src/only-one.mjs", patch: "@@ -1 +1 @@" })],
  });
  assert.equal(mismatch.diff_incomplete, true);
  assert.equal(mismatch.reason, "changed_files_mismatch");

  const cappedFiles = Array.from({ length: 3000 }, (_, index) =>
    pullRequestFile({ filename: `src/file-${index}.mjs`, patch: "@@ -1 +1 @@" }));
  const pageCap = await filesResult({
    changed_files: 3000,
    files: cappedFiles,
  });
  assert.equal(pageCap.diff_incomplete, true);
  assert.equal(pageCap.reason, "files_page_cap_hit");

  const patchMissing = await filesResult({
    changed_files: 1,
    files: [pullRequestFile({ filename: "src/app.mjs" })],
  });
  assert.equal(patchMissing.diff_incomplete, true);
  assert.equal(patchMissing.reason, "patch_missing");

  const binary = await filesResult({
    changed_files: 1,
    files: [pullRequestFile({ filename: "assets/logo.png", binary: true, changes: 1, additions: 0, deletions: 0 })],
  });
  assert.equal(binary.diff_incomplete, true);
  assert.equal(binary.reason, "binary_or_oversized_patch_missing");
});

function createFakeExecutionPrTransport({
  openPullRequests = [],
  closedPullRequests = [],
} = {}) {
  const calls = [];
  const created = [];
  const statusesBySha = new Map();
  const commentsByNumber = new Map();
  let nextCommentId = 1;
  let nextNumber = 100 + openPullRequests.length + closedPullRequests.length;

  function allPullRequests() {
    return [...openPullRequests, ...closedPullRequests, ...created];
  }

  return {
    kind: "fake",
    calls,
    created,
    statusesBySha,
    commentsByNumber,
    async request({ endpointId, method, path, owner, repo, params = {} }) {
      assertGitHubExecutionPrEndpointShape({ endpointId, method, path });
      calls.push({ endpointId, method, path, owner, repo, params: { ...params } });

      if (endpointId === "probe_execution_pull_request") {
        return {
          data: allPullRequests()
            .filter((pr) =>
              pr.state === "open" &&
              pr.head?.ref === params.head &&
              pr.base?.ref === params.base),
        };
      }

      if (endpointId === "create_execution_pull_request") {
        nextNumber += 1;
        const pr = pullRequest({
          number: nextNumber,
          owner,
          repo,
          head: params.head,
          base: params.base,
          title: params.title,
          body: params.body,
          draft: params.draft,
        });
        created.push(pr);
        return { data: pr };
      }

      if (endpointId === "get_execution_pull_request") {
        const pr = allPullRequests().find((candidate) => candidate.number === params.number);
        return { data: pr || null };
      }

      if (endpointId === "merge_execution_pull_request") {
        const pr = allPullRequests().find((candidate) => candidate.number === params.number);
        if (!pr) return { data: { merged: false, message: "not found" } };
        if (pr.head?.sha !== params.expectedHeadSha) {
          return { data: { merged: false, message: "head mismatch" } };
        }
        pr.state = "closed";
        pr.merged = true;
        pr.merged_at = "2026-06-29T00:00:00.000Z";
        return { data: { merged: true, sha: params.expectedHeadSha } };
      }

      if (endpointId === "get_execution_pull_request_files") {
        const pr = allPullRequests().find((candidate) => candidate.number === params.number);
        const files = Array.isArray(pr?.files) ? pr.files : [];
        const perPage = params.per_page || 100;
        const start = ((params.page || 1) - 1) * perPage;
        return { data: files.slice(start, start + perPage) };
      }

      if (endpointId === "get_execution_commit_statuses") {
        return { data: statusesBySha.get(params.head_sha) || [] };
      }

      if (endpointId === "set_execution_commit_status") {
        const status = {
          sha: params.head_sha,
          context: params.context,
          state: params.state,
          description: params.description,
          target_url: params.target_url || null,
        };
        const statuses = statusesBySha.get(params.head_sha) || [];
        statuses.unshift(status);
        statusesBySha.set(params.head_sha, statuses);
        return { data: status };
      }

      if (endpointId === "post_execution_pull_request_comment") {
        const comments = commentsByNumber.get(params.number) || [];
        const comment = {
          id: nextCommentId,
          body: params.body,
          created_at: "2026-06-28T00:00:00.000Z",
        };
        nextCommentId += 1;
        comments.push(comment);
        commentsByNumber.set(params.number, comments);
        return { data: comment };
      }

      if (endpointId === "list_execution_pull_request_comments") {
        return { data: commentsByNumber.get(params.number) || [] };
      }

      if (endpointId === "list_execution_pull_requests_for_head") {
        return {
          data: allPullRequests()
            .filter((pr) =>
              pr.head?.ref === params.head &&
              (params.state === "all" || pr.state === params.state)),
        };
      }

      throw new Error(`unexpected_endpoint:${endpointId}`);
    },
  };
}

function pullRequest({
  number,
  owner = "acme",
  repo = "app",
  state = "open",
  head,
  headSha,
  base,
  title = "Ship execution work",
  body = "Body",
  draft = false,
  changed_files = 0,
  files = [],
} = {}) {
  return {
    number,
    state,
    draft: Boolean(draft),
    title,
    body,
    changed_files,
    files,
    head: {
      ref: head,
      label: `${owner}:${head}`,
      ...(headSha == null ? {} : { sha: headSha }),
      repo: { owner: { login: owner }, name: repo },
    },
    base: { ref: base },
    html_url: `https://github.example/${owner}/${repo}/pull/${number}`,
  };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

async function filesResult({ changed_files, files }) {
  const number = 12;
  const transport = createFakeExecutionPrTransport({
    openPullRequests: [pullRequest({
      number,
      head: HEAD,
      base: "main",
      headSha: HEAD_SHA,
      changed_files,
      files,
    })],
  });
  const adapter = createExecutionPullRequestAdapter({
    transport,
    repoIdentity: REPO,
  });
  return adapter.getPullRequestFiles(number);
}

function pullRequestFile({
  filename,
  patch,
  binary = false,
  changes = 1,
  additions = 1,
  deletions = 0,
} = {}) {
  return {
    filename,
    status: "modified",
    changes,
    additions,
    deletions,
    ...(patch == null ? {} : { patch }),
    ...(binary ? { binary: true } : {}),
  };
}
