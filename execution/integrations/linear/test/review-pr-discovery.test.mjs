import assert from "node:assert/strict";
import test from "node:test";

import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import {
  hydrateReviewState,
  locatePullRequestForProducedIdentity,
  locatePullRequestForIssue,
  resourcesToRepoIdentity,
} from "../src/review-pr-discovery.mjs";

const REPO = Object.freeze({
  owner: "acme",
  repo: "app",
  default_branch: "main",
});
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

test("resourcesToRepoIdentity reads the git_repo binding array and ignores tainted handles", () => {
  const identity = resourcesToRepoIdentity({
    resources: [{
      id: "git_repo",
      kind: "git_repo",
      role: "primary",
      binding: REPO,
      handle: {
        owner: "pending-owner",
        repo: "pending-repo",
        default_branch: "pending-base",
      },
    }],
  });

  assert.deepEqual(identity, REPO);
});

test("resourcesToRepoIdentity resolves the selected git_repo id and refuses ambiguous multi-repo domains", () => {
  const repoA = {
    owner: "acme",
    repo: "repo-a",
    default_branch: "main",
  };
  const repoB = {
    owner: "acme",
    repo: "repo-b",
    default_branch: "trunk",
  };
  const domainContext = {
    resources: [
      { id: "repo-a", kind: "git_repo", role: "primary", binding: repoA },
      { id: "repo-b", kind: "git_repo", role: "primary", binding: repoB },
    ],
  };

  assert.deepEqual(resourcesToRepoIdentity(domainContext, { resourceId: "repo-b" }), repoB);
  assert.throws(
    () => resourcesToRepoIdentity(domainContext),
    /review_git_repo_resource_id_required/,
  );
});

test("locatePullRequestForProducedIdentity hydrates the produced PR number without branch search", async () => {
  const branch = branchNameForIssue("AF-124");
  const adapter = createFakePrAdapter({
    pullRequests: [pullRequest({
      number: 43,
      branch,
      base: "main",
      headSha: HEAD_SHA,
    })],
  });

  const result = await locatePullRequestForProducedIdentity({
    producedIdentity: {
      resource_id: "repo-1",
      pull_request_number: 43,
      branch,
      head_sha: NEXT_HEAD_SHA,
    },
    repoIdentity: REPO,
    prAdapter: adapter,
  });

  assert.equal(result.status, "found");
  assert.equal(result.source, "produced_identity");
  assert.equal(result.resource_id, "repo-1");
  assert.deepEqual(result.pr, {
    owner: "acme",
    repo: "app",
    number: 43,
    head_sha: HEAD_SHA,
  });
  assert.deepEqual(adapter.calls.map((call) => call.method), ["getPullRequest"]);
});

test("locatePullRequestForIssue derives the issue branch and returns the PR head commit sha", async () => {
  const branch = branchNameForIssue("AF-123");
  const adapter = createFakePrAdapter({
    pullRequests: [pullRequest({
      number: 42,
      branch,
      base: "main",
      headSha: HEAD_SHA,
    })],
  });

  const result = await locatePullRequestForIssue({
    issueContext: {
      id: "issue-1",
      identifier: "AF-123",
      state: { name: "In Review" },
    },
    repoIdentity: REPO,
    prAdapter: adapter,
  });

  assert.equal(result.status, "found");
  assert.equal(result.branch, branch);
  assert.deepEqual(result.pr, {
    owner: "acme",
    repo: "app",
    number: 42,
    head_sha: HEAD_SHA,
  });
  assert.deepEqual(adapter.calls.map((call) => ({
    method: call.method,
    head: call.head,
    state: call.state,
    number: call.number,
  })), [
    { method: "listPullRequestsForHead", head: branch, state: "all", number: undefined },
    { method: "getPullRequest", head: undefined, state: undefined, number: 42 },
  ]);
});

test("locatePullRequestForIssue returns distinct typed statuses for absent, duplicate, closed, and wrong-base PRs", async (t) => {
  const branch = branchNameForIssue("AF-456");
  const cases = [
    {
      name: "none",
      pullRequests: [],
      expected: { status: "none" },
    },
    {
      name: "multiple",
      pullRequests: [
        pullRequest({ number: 10, branch, base: "main", headSha: HEAD_SHA }),
        pullRequest({ number: 11, branch, base: "main", headSha: NEXT_HEAD_SHA }),
      ],
      expected: { status: "multiple" },
    },
    {
      name: "closed",
      pullRequests: [
        pullRequest({ number: 12, state: "closed", branch, base: "main", headSha: HEAD_SHA }),
      ],
      expected: { status: "closed", number: 12 },
    },
    {
      name: "wrong_base",
      pullRequests: [
        pullRequest({ number: 13, branch, base: "develop", headSha: HEAD_SHA }),
      ],
      expected: { status: "wrong_base", actual_base: "develop", expected_base: "main" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await locatePullRequestForIssue({
        issueContext: { identifier: "AF-456" },
        repoIdentity: REPO,
        prAdapter: createFakePrAdapter({ pullRequests: scenario.pullRequests }),
      });

      assert.equal(result.status, scenario.expected.status);
      if (scenario.expected.number) {
        assert.equal(result.pull_request.number, scenario.expected.number);
      }
      if (scenario.expected.actual_base) {
        assert.equal(result.actual_base, scenario.expected.actual_base);
        assert.equal(result.expected_base, scenario.expected.expected_base);
      }
    });
  }
});

test("hydrateReviewState returns af-review status, latest marker at head, and diff completeness", async () => {
  const branch = branchNameForIssue("AF-789");
  const adapter = createFakePrAdapter({
    pullRequests: [pullRequest({
      number: 99,
      branch,
      base: "main",
      headSha: HEAD_SHA,
    })],
    statusesBySha: new Map([[
      HEAD_SHA,
      [
        { context: "ci/test", state: "success", created_at: "2026-06-28T00:00:00.000Z" },
        { context: AF_REVIEW_STATUS_CONTEXT, state: "failure", created_at: "2026-06-28T00:01:00.000Z" },
        { context: AF_REVIEW_STATUS_CONTEXT, state: "success", created_at: "2026-06-28T00:02:00.000Z" },
      ],
    ]]),
    commentsByNumber: new Map([[
      99,
      [
        comment({
          id: 1,
          body: formatAfReviewCommentBody({
            body: "Old review",
            disposition: "approved",
            head_sha: NEXT_HEAD_SHA,
            run_id: "run-old",
          }),
          createdAt: "2026-06-28T00:03:00.000Z",
        }),
        comment({
          id: 2,
          body: formatAfReviewCommentBody({
            body: "Needs a fix",
            disposition: "request_changes",
            head_sha: HEAD_SHA,
            run_id: "run-review",
          }),
          createdAt: "2026-06-28T00:04:00.000Z",
        }),
      ],
    ]]),
    filesByNumber: new Map([[
      99,
      { files: [], diff_incomplete: true, reason: "changed_files_mismatch" },
    ]]),
  });
  const located = await locatePullRequestForIssue({
    issueContext: { identifier: "AF-789" },
    repoIdentity: REPO,
    prAdapter: adapter,
  });

  const state = await hydrateReviewState(located.pr);

  assert.equal(state.af_review_state, "success");
  assert.equal(state.af_review_status.context, AF_REVIEW_STATUS_CONTEXT);
  assert.equal(state.latest_marker_comment_at_head.comment.comment_id, 2);
  assert.equal(state.latest_marker_comment_at_head.marker.disposition, "request_changes");
  assert.equal(state.latest_marker_comment_at_head.marker.head_sha, HEAD_SHA);
  assert.equal(state.diff_incomplete, true);
  assert.equal(state.diff_incomplete_reason, "changed_files_mismatch");
});

function createFakePrAdapter({
  pullRequests = [],
  statusesBySha = new Map(),
  commentsByNumber = new Map(),
  filesByNumber = new Map(),
} = {}) {
  const calls = [];
  return {
    calls,
    async listPullRequestsForHead(head, { state = "all" } = {}) {
      calls.push({ method: "listPullRequestsForHead", head, state });
      assert.equal(state, "all");
      return pullRequests
        .filter((pr) => pr.head.ref === head)
        .map((pr) => ({
          number: pr.number,
          state: pr.state,
          base: pr.base.ref,
          head_sha: pr.head.sha,
        }));
    },
    async getPullRequest(number) {
      calls.push({ method: "getPullRequest", number });
      const pr = pullRequests.find((candidate) => candidate.number === number);
      if (!pr) throw new Error(`missing_pr:${number}`);
      return pr;
    },
    async getCommitStatuses(head_sha) {
      calls.push({ method: "getCommitStatuses", head_sha });
      return statusesBySha.get(head_sha) || [];
    },
    async listPullRequestComments(number) {
      calls.push({ method: "listPullRequestComments", number });
      return commentsByNumber.get(number) || [];
    },
    async getPullRequestFiles(number) {
      calls.push({ method: "getPullRequestFiles", number });
      return filesByNumber.get(number) || { files: [], diff_incomplete: false };
    },
  };
}

function pullRequest({
  number,
  state = "open",
  branch,
  base,
  headSha,
} = {}) {
  return {
    number,
    state,
    head: {
      ref: branch,
      label: `acme:${branch}`,
      sha: headSha,
      repo: { owner: { login: "acme" }, name: "app" },
    },
    base: { ref: base },
  };
}

function comment({
  id,
  body,
  createdAt,
} = {}) {
  return {
    id,
    comment_id: id,
    body,
    created_at: createdAt,
  };
}
