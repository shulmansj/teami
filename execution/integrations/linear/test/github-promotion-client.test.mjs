import assert from "node:assert/strict";
import test from "node:test";

import * as githubClientModule from "../src/github-promotion-client.mjs";

const {
  createBrokerGitHubTransport,
  createDryRunGitHubTransport,
  createGitHubPromotionClient,
  createMockGitHubTransport,
  GITHUB_PROMOTION_ENDPOINT_ALLOWLIST,
} = githubClientModule;

const MERGE_SHAPED = /merge|ready|approve|review/i;
const REPO = { owner: "test-owner", repo: "test-repo" };
const PROPOSAL_HEAD = "agentic-factory/promotion/x/abc123abc123";

// ---------------------------------------------------------------------------
// CONSTRAINTS #8: the MVP no-merge promise is enforced in the client. The
// same contents permission needed for proposal commits could merge, so the
// module must have NO merge or mark-ready codepath AT ALL.
// ---------------------------------------------------------------------------

test("endpoint allowlist contains exactly the five PR endpoints and no merge-shaped endpoint", () => {
  assert.deepEqual(
    GITHUB_PROMOTION_ENDPOINT_ALLOWLIST.map((endpoint) => endpoint.id).sort(),
    [
      "create_pull_request",
      "get_pull_request",
      "list_closed_pull_requests",
      "list_open_pull_requests",
      "update_pull_request_body",
    ],
  );
  for (const endpoint of GITHUB_PROMOTION_ENDPOINT_ALLOWLIST) {
    assert.ok(!MERGE_SHAPED.test(endpoint.id), `merge-shaped endpoint id: ${endpoint.id}`);
    assert.ok(!MERGE_SHAPED.test(endpoint.path), `merge-shaped endpoint path: ${endpoint.path}`);
    // GitHub's merge endpoint is PUT /repos/{owner}/{repo}/pulls/{number}/merge;
    // no PUT exists anywhere in the allowlist.
    assert.notEqual(endpoint.method, "PUT");
  }
});

test("the client object exposes no merge-shaped method and the module exports none either", () => {
  const client = createGitHubPromotionClient({
    transport: createDryRunGitHubTransport(),
    repo: REPO,
  });
  for (const key of Object.keys(client)) {
    assert.ok(!MERGE_SHAPED.test(key), `merge-shaped client member: ${key}`);
  }
  assert.equal(client.mergePullRequest, undefined);
  assert.equal(client.markReadyForReview, undefined);
  for (const exportName of Object.keys(githubClientModule)) {
    assert.ok(!MERGE_SHAPED.test(exportName), `merge-shaped module export: ${exportName}`);
  }
});

test("all transports refuse endpoint ids outside the allowlist", async () => {
  const brokerTransport = createBrokerGitHubTransport({
    brokerClient: { async mintInstallationToken() { return { token: "ghs_test" }; } },
    fetchImpl: async () => ({ ok: true, async text() { return "[]"; } }),
  });
  for (const transport of [createDryRunGitHubTransport(), createMockGitHubTransport(), brokerTransport]) {
    await assert.rejects(
      transport.request({ endpointId: "merge_pull_request", method: "PUT", path: "/x", owner: "o", repo: "r" }),
      /github_endpoint_not_allowlisted:merge_pull_request/,
    );
    await assert.rejects(
      transport.request({ endpointId: "create_review", method: "POST", path: "/x", owner: "o", repo: "r" }),
      /github_endpoint_not_allowlisted/,
    );
    for (const endpointId of [
      "mark_ready_for_review",
      "apply_behavior_change",
      "submit_pull_request_review",
      "create_commit_status",
      "create_check_run",
      "bypass_branch_protection",
      "workflow_dispatch",
      "download_actions_artifact",
      "get_actions_log",
    ]) {
      await assert.rejects(
        transport.request({ endpointId, method: "POST", path: "/x", owner: "o", repo: "r" }),
        /github_endpoint_not_allowlisted/,
        `${endpointId} must not be reachable through promotion transports`,
      );
    }
  }
});

test("all transports reject spoofed method/path for allowlisted endpoint ids", async () => {
  const fetchCalls = [];
  const brokerTransport = createBrokerGitHubTransport({
    brokerClient: { async mintInstallationToken() { return { token: "ghs_test" }; } },
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      return { ok: true, async text() { return "{}"; } };
    },
  });
  for (const transport of [createDryRunGitHubTransport(), createMockGitHubTransport(), brokerTransport]) {
    await assert.rejects(
      transport.request({
        endpointId: "create_pull_request",
        method: "DELETE",
        path: "/repos/{owner}/{repo}/actions/runs/{run_id}",
        owner: "o",
        repo: "r",
      }),
      /github_endpoint_shape_mismatch:create_pull_request/,
    );
  }
  assert.equal(fetchCalls.length, 0, "broker transport must not proxy arbitrary GitHub REST shapes");
});

// ---------------------------------------------------------------------------
// Dry-run transport: canned shapes, recorded calls, dry_run: true everywhere,
// no network and no tokens.
// ---------------------------------------------------------------------------

test("dry-run transport records calls and returns canned dry_run shapes", async () => {
  const transport = createDryRunGitHubTransport({ now: () => new Date("2026-06-10T05:00:00.000Z") });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  const open = await client.listOpenPullRequests();
  assert.equal(open.dry_run, true);
  assert.deepEqual(open.data, []);
  const created = await client.createPullRequest({
    title: "t", head: PROPOSAL_HEAD, base: "main", body: "b",
  });
  assert.equal(created.dry_run, true);
  assert.ok(created.data.number > 0);
  assert.match(created.data.html_url, /^dry-run:\/\/github\/test-owner\/test-repo\/pull\//);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(
    transport.calls.map((call) => call.endpointId),
    ["list_open_pull_requests", "create_pull_request"],
  );
});

test("mock transport serves fixtures, tracks created PRs, and injects bounded failures", async () => {
  const transport = createMockGitHubTransport({
    openPullRequests: [{ number: 7, state: "open", body: "x", created_at: "2026-06-09T00:00:00.000Z", merged_at: null, closed_at: null }],
    failures: { create_pull_request: { error: new Error("boom"), times: 1 } },
  });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  const open = await client.listOpenPullRequests();
  assert.equal(open.data.length, 1);
  await assert.rejects(
    client.createPullRequest({ title: "t", head: PROPOSAL_HEAD, base: "main", body: "b" }),
    /boom/,
  );
  const created = await client.createPullRequest({ title: "t", head: PROPOSAL_HEAD, base: "main", body: "b" });
  assert.ok(created.data.number > 0);
  const openAfter = await client.listOpenPullRequests();
  assert.equal(openAfter.data.length, 2);
  const updated = await client.updatePullRequestBody({ number: created.data.number, body: "new body" });
  assert.equal(updated.data.body, "new body");
});

test("promotion PR creation rejects maintainer-origin or non-proposal heads before transport", async () => {
  const transport = createMockGitHubTransport();
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  for (const head of [
    "feature/manual-branch",
    "maintainer:agentic-factory/promotion/x/abc123abc123",
    "refs/heads/agentic-factory/promotion/x/abc123abc123",
  ]) {
    await assert.rejects(
      client.createPullRequest({ title: "t", head, base: "main", body: "b" }),
      /github_promotion_pr_head_not_proposal_branch/,
      `head ${head} must be rejected`,
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("client construction requires a transport and a repo identity", () => {
  assert.throws(() => createGitHubPromotionClient({ repo: REPO }), /github_transport_required/);
  assert.throws(
    () => createGitHubPromotionClient({ transport: createDryRunGitHubTransport() }),
    /github_repo_identity_required/,
  );
});

test("the broker-backed transport fails closed without a configured broker client", () => {
  assert.throws(() => createBrokerGitHubTransport(), /github_broker_not_configured/);
});

test("broker-backed transport mints installation tokens and sends PR bodies only to GitHub", async () => {
  const brokerCalls = [];
  const githubCalls = [];
  const transport = createBrokerGitHubTransport({
    brokerClient: {
      async mintInstallationToken(input) {
        brokerCalls.push(input);
        return { token: `ghs_${brokerCalls.length}` };
      },
    },
    fetchImpl: async (url, init = {}) => {
      githubCalls.push({ url: String(url), init });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            number: 42,
            state: "open",
            html_url: "https://github.com/test-owner/test-repo/pull/42",
          });
        },
      };
    },
  });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  await client.createPullRequest({
    title: "Promotion",
    head: PROPOSAL_HEAD,
    base: "main",
    body: "sensitive proposal evidence body",
  });
  assert.deepEqual(brokerCalls, [{
    owner: "test-owner",
    repo: "test-repo",
    permissions: { contents: "write", pull_requests: "write" },
  }]);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].init.headers.authorization, /^Bearer ghs_1$/);
  assert.match(githubCalls[0].init.body, /sensitive proposal evidence body/);
  assert.ok(!JSON.stringify(brokerCalls).includes("sensitive proposal"));
  assert.equal(transport.calls[0].params.body, "[redacted github body length=32]");
});

test("broker-backed PR listing follows pagination and combines pages", async () => {
  const githubCalls = [];
  const transport = createBrokerGitHubTransport({
    brokerClient: {
      async mintInstallationToken() {
        return { token: "ghs_list" };
      },
    },
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      githubCalls.push(parsed);
      const page = Number(parsed.searchParams.get("page") || "1");
      const payload = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
        : [{ number: 101 }];
      return {
        ok: true,
        async text() {
          return JSON.stringify(payload);
        },
      };
    },
  });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  const listed = await client.listOpenPullRequests();
  assert.equal(listed.data.length, 101);
  assert.deepEqual(githubCalls.map((url) => url.searchParams.get("page")), ["1", "2"]);
});

test("broker-backed PR listing fails closed when a later page cannot be fetched", async () => {
  const transport = createBrokerGitHubTransport({
    brokerClient: {
      async mintInstallationToken() {
        return { token: "ghs_list" };
      },
    },
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get("page") || "1");
      if (page === 1) {
        return {
          ok: true,
          async text() {
            return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
          },
        };
      }
      return {
        ok: false,
        status: 502,
        async text() {
          return JSON.stringify({ message: "bad gateway" });
        },
      };
    },
  });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  await assert.rejects(
    client.listClosedPullRequests(),
    /github_pr_listing_truncated:list_closed_pull_requests:HTTP_502:bad gateway/,
  );
});

test("broker-backed PR listing makes one request for a short single page", async () => {
  const githubCalls = [];
  const transport = createBrokerGitHubTransport({
    brokerClient: {
      async mintInstallationToken() {
        return { token: "ghs_list" };
      },
    },
    fetchImpl: async (url) => {
      githubCalls.push(String(url));
      return {
        ok: true,
        async text() {
          return JSON.stringify([{ number: 1 }]);
        },
      };
    },
  });
  const client = createGitHubPromotionClient({ transport, repo: REPO });
  const listed = await client.listOpenPullRequests();
  assert.equal(listed.data.length, 1);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0], /per_page=100/);
  assert.match(githubCalls[0], /page=1/);
});
