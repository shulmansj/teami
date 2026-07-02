import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
  parseAfReviewCommentMarker,
} from "../src/execution-pr-adapter.mjs";
import {
  AF_REVIEW_COMMIT_EFFECTS,
  githubAfReviewStatusEffect,
  githubPrReviewCommentEffect,
} from "../src/review/teami-review-effects.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  REVIEW_COMMIT_EFFECT_IDS,
} from "../src/workflows/review/effect-ids.mjs";

const REVIEW = Object.freeze({
  owner: "acme",
  repo: "app",
  number: 7,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  disposition: "approve",
  body: "Review passed.",
});
const NEXT_HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

test("review effect ids are leaf constants and descriptors are ordered comment before status", () => {
  assert.deepEqual(REVIEW_COMMIT_EFFECT_IDS, [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  ]);
  assert.deepEqual(AF_REVIEW_COMMIT_EFFECTS.map((effect) => effect.id), REVIEW_COMMIT_EFFECT_IDS);

  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/workflows/review/effect-ids.mjs"),
    "utf8",
  );
  assert.equal(source.includes("teami-review-effects"), false);
});

test("review effects post the marker comment before setting the green af-review status", async () => {
  const prAdapter = createFakeReviewPrAdapter();

  const result = await applyCommitEffects({
    effects: AF_REVIEW_COMMIT_EFFECTS,
    ctx: reviewCtx({ prAdapter }),
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.applied, [
    {
      id: GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
      identity: {
        owner: "acme",
        repo: "app",
        number: 7,
        head_sha: REVIEW.head_sha,
        comment_id: "1",
      },
    },
    {
      id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      identity: {
        owner: "acme",
        repo: "app",
        head_sha: REVIEW.head_sha,
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "success",
      },
    },
  ]);
  assert.deepEqual(result.produced_identities.map((entry) => entry.effect_id), [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  ]);
  assert.equal(prAdapter.commentsByNumber.get(7).length, 1);
  assert.equal(parseAfReviewCommentMarker(prAdapter.commentsByNumber.get(7)[0].body).ok, true);
  assert.equal(prAdapter.statusesBySha.get(REVIEW.head_sha).length, 1);

  const postIndex = prAdapter.events.findIndex((event) => event.method === "postPullRequestComment");
  const statusIndex = prAdapter.events.findIndex((event) => event.method === "setCommitStatus");
  assert.equal(postIndex >= 0, true);
  assert.equal(statusIndex > postIndex, true);
});

test("af-review status maps the S7 dispositions: approve->success, request-changes/escalate->failure", async () => {
  const cases = [
    { disposition: "approve", state: "success" },
    { disposition: "request-changes", state: "failure" },
    { disposition: "escalate", state: "failure" },
  ];
  for (const { disposition, state } of cases) {
    const prAdapter = createFakeReviewPrAdapter();
    const result = await applyCommitEffects({
      effects: AF_REVIEW_COMMIT_EFFECTS,
      ctx: reviewCtx({ prAdapter, review: { ...REVIEW, disposition } }),
    });
    assert.equal(result.outcome, "ok", `${disposition} applies`);
    const status = result.applied.find((entry) => entry.id === GITHUB_AF_REVIEW_STATUS_EFFECT_ID);
    assert.equal(status.identity.state, state, `${disposition} -> af-review ${state}`);
  }
});

test("replay after a kill between review comment and status creates exactly one comment and one status", async () => {
  const prAdapter = createFakeReviewPrAdapter({
    failSetCommitStatusOnce: new Error("simulated_crash_after_comment_before_status"),
  });
  const effects = AF_REVIEW_COMMIT_EFFECTS;

  const first = await applyCommitEffects({
    effects,
    ctx: reviewCtx({ prAdapter }),
  });

  assert.equal(first.outcome, "pending");
  assert.equal(first.pending_effect_id, GITHUB_AF_REVIEW_STATUS_EFFECT_ID);
  assert.equal(prAdapter.commentsByNumber.get(7).length, 1);
  assert.equal(prAdapter.statusesBySha.get(REVIEW.head_sha)?.length || 0, 0);

  const replay = await applyCommitEffects({
    effects,
    ctx: reviewCtx({ prAdapter }),
  });

  assert.equal(replay.outcome, "ok");
  assert.equal(prAdapter.commentsByNumber.get(7).length, 1);
  assert.equal(prAdapter.statusesBySha.get(REVIEW.head_sha).length, 1);
  assert.equal(
    prAdapter.events.filter((event) => event.method === "postPullRequestComment").length,
    1,
  );
  const postIndex = prAdapter.events.findIndex((event) => event.method === "postPullRequestComment");
  const firstStatusAttemptIndex = prAdapter.events.findIndex((event) => event.method === "setCommitStatus");
  assert.equal(firstStatusAttemptIndex > postIndex, true);
});

test("review effects are idempotent per head_sha and re-apply on a new head", async () => {
  const prAdapter = createFakeReviewPrAdapter();
  const effects = AF_REVIEW_COMMIT_EFFECTS;

  const first = await applyCommitEffects({ effects, ctx: reviewCtx({ prAdapter }) });
  assert.equal(first.outcome, "ok");

  prAdapter.pullRequests.set(7, pullRequest({ headSha: NEXT_HEAD_SHA }));
  const second = await applyCommitEffects({
    effects,
    ctx: reviewCtx({
      prAdapter,
      review: { ...REVIEW, head_sha: NEXT_HEAD_SHA },
      runId: "run-review-2",
    }),
  });
  assert.equal(second.outcome, "ok");

  const third = await applyCommitEffects({
    effects,
    ctx: reviewCtx({
      prAdapter,
      review: { ...REVIEW, head_sha: NEXT_HEAD_SHA },
      runId: "run-review-2",
    }),
  });
  assert.equal(third.outcome, "ok");

  assert.equal(prAdapter.commentsByNumber.get(7).length, 2);
  assert.equal(prAdapter.statusesBySha.get(REVIEW.head_sha).length, 1);
  assert.equal(prAdapter.statusesBySha.get(NEXT_HEAD_SHA).length, 1);
  assert.equal(
    prAdapter.events.filter((event) => event.method === "postPullRequestComment").length,
    2,
  );
  assert.equal(
    prAdapter.events.filter((event) => event.method === "setCommitStatus").length,
    2,
  );
});

test("comment effect returns pending for uncertain writes and failed_closed for ambiguous marker state", async () => {
  const pendingAdapter = createFakeReviewPrAdapter({
    failPostPullRequestComment: new Error("github temporarily unavailable"),
  });
  const pending = await applyCommitEffects({
    effects: [githubPrReviewCommentEffect],
    ctx: reviewCtx({ prAdapter: pendingAdapter }),
  });
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.pending_effect_id, GITHUB_PR_REVIEW_COMMENT_EFFECT_ID);

  const terminalAdapter = createFakeReviewPrAdapter({
    commentsByNumber: new Map([[
      7,
      [
        comment({ id: 1, body: markerBody() }),
        comment({ id: 2, body: markerBody() }),
      ],
    ]]),
  });
  const terminal = await applyCommitEffects({
    effects: [githubPrReviewCommentEffect],
    ctx: reviewCtx({ prAdapter: terminalAdapter }),
  });
  assert.equal(terminal.outcome, "failed_closed");
  assert.equal(terminal.pending_effect_id, GITHUB_PR_REVIEW_COMMENT_EFFECT_ID);
  assert.equal(terminal.reason, "github_pr_review_comment_multiple");
  assert.equal(terminalAdapter.commentsByNumber.get(7).length, 2);
});

test("status effect returns pending for uncertain writes and failed_closed for wrong latest state", async () => {
  const pendingAdapter = createFakeReviewPrAdapter({
    failSetCommitStatus: new Error("github temporarily unavailable"),
  });
  const pending = await applyCommitEffects({
    effects: [githubAfReviewStatusEffect],
    ctx: reviewCtx({ prAdapter: pendingAdapter }),
  });
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.pending_effect_id, GITHUB_AF_REVIEW_STATUS_EFFECT_ID);

  const terminalAdapter = createFakeReviewPrAdapter({
    statusesBySha: new Map([[
      REVIEW.head_sha,
      [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-28T00:00:00.000Z",
      }],
    ]]),
  });
  const terminal = await applyCommitEffects({
    effects: [githubAfReviewStatusEffect],
    ctx: reviewCtx({ prAdapter: terminalAdapter }),
  });
  assert.equal(terminal.outcome, "failed_closed");
  assert.equal(terminal.pending_effect_id, GITHUB_AF_REVIEW_STATUS_EFFECT_ID);
  assert.equal(terminal.reason, "github_af_review_status_state_mismatch");
  assert.equal(terminalAdapter.statusesBySha.get(REVIEW.head_sha).length, 1);
});

test("review effects fail closed before mutation when the PR is gone or the head moved", async () => {
  const goneAdapter = createFakeReviewPrAdapter({ missingPullRequest: true });
  const gone = await applyCommitEffects({
    effects: [githubPrReviewCommentEffect],
    ctx: reviewCtx({ prAdapter: goneAdapter }),
  });
  assert.equal(gone.outcome, "failed_closed");
  assert.equal(gone.reason, "github_review_pull_request_missing");
  assert.equal(goneAdapter.events.some((event) => event.method === "postPullRequestComment"), false);

  const movedAdapter = createFakeReviewPrAdapter({
    pullRequests: new Map([[7, pullRequest({ headSha: NEXT_HEAD_SHA })]]),
  });
  const moved = await applyCommitEffects({
    effects: [githubAfReviewStatusEffect],
    ctx: reviewCtx({ prAdapter: movedAdapter }),
  });
  assert.equal(moved.outcome, "failed_closed");
  assert.equal(moved.reason, "github_review_pull_request_head_moved");
  assert.equal(movedAdapter.events.some((event) => event.method === "setCommitStatus"), false);
});

function reviewCtx({
  prAdapter,
  review = REVIEW,
  runId = "run-review-1",
} = {}) {
  return {
    runId,
    review,
    prAdapter,
  };
}

function createFakeReviewPrAdapter({
  pullRequests = new Map([[7, pullRequest({ headSha: REVIEW.head_sha })]]),
  commentsByNumber = new Map(),
  statusesBySha = new Map(),
  missingPullRequest = false,
  failPostPullRequestComment = null,
  failSetCommitStatus = null,
  failSetCommitStatusOnce = null,
} = {}) {
  let nextCommentId = 1;
  const events = [];
  let remainingSetCommitStatusOnce = failSetCommitStatusOnce;
  return {
    events,
    pullRequests,
    commentsByNumber,
    statusesBySha,
    async getPullRequest(number) {
      events.push({ method: "getPullRequest", number });
      if (missingPullRequest) {
        const error = new Error("not_found");
        error.status = 404;
        throw error;
      }
      return pullRequests.get(number) || null;
    },
    async listPullRequestComments(number) {
      events.push({ method: "listPullRequestComments", number });
      return commentsByNumber.get(number) || [];
    },
    async postPullRequestComment({ number, body, disposition, head_sha, run_id }) {
      events.push({ method: "postPullRequestComment", number, head_sha });
      if (failPostPullRequestComment) throw failPostPullRequestComment;
      const comments = commentsByNumber.get(number) || [];
      const posted = comment({
        id: nextCommentId,
        body: body.includes("<!-- af-review:")
          ? body
          : formatAfReviewCommentBody({ body, disposition, head_sha, run_id }),
      });
      nextCommentId += 1;
      comments.push(posted);
      commentsByNumber.set(number, comments);
      return { comment_id: posted.comment_id };
    },
    async getCommitStatuses(head_sha) {
      events.push({ method: "getCommitStatuses", head_sha });
      return statusesBySha.get(head_sha) || [];
    },
    async setCommitStatus({ head_sha, context, state, description }) {
      events.push({ method: "setCommitStatus", head_sha, context, state, description });
      if (remainingSetCommitStatusOnce) {
        const error = remainingSetCommitStatusOnce;
        remainingSetCommitStatusOnce = null;
        throw error;
      }
      if (failSetCommitStatus) throw failSetCommitStatus;
      const statuses = statusesBySha.get(head_sha) || [];
      statuses.unshift({
        context,
        state,
        description,
        created_at: "2026-06-28T00:00:00.000Z",
      });
      statusesBySha.set(head_sha, statuses);
      return statuses[0];
    },
  };
}

function pullRequest({ headSha } = {}) {
  return {
    number: 7,
    state: "open",
    head: {
      sha: headSha,
    },
  };
}

function comment({ id, body = markerBody() } = {}) {
  return {
    id,
    comment_id: String(id),
    body,
    created_at: "2026-06-28T00:00:00.000Z",
  };
}

function markerBody() {
  return formatAfReviewCommentBody({
    body: REVIEW.body,
    disposition: REVIEW.disposition,
    head_sha: REVIEW.head_sha,
    run_id: "run-review-1",
  });
}
