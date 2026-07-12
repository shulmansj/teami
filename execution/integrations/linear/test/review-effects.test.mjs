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
  applyLinearHumanReviewBriefingEffect,
  githubAfReviewStatusEffect,
  githubPrReviewCommentEffect,
  linearHumanReviewBriefingEffect,
} from "../src/review/teami-review-effects.mjs";
import {
  mergePrEffectDescriptor,
  probeMergePrEffect,
  readMergeGateSnapshot,
} from "../src/linear/merge-pr-effect.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
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
const MERGE_ISSUE_ID = "issue-merge-1";
const MERGE_PR_NUMBER = 17;
const MERGE_HEAD_SHA = "1111111111111111111111111111111111111111";
const MERGE_NEXT_HEAD_SHA = "2222222222222222222222222222222222222222";
const HUMAN_REVIEW_LABEL_ID = "label-human-review";
const MERGE_WAKE_ID = "wake-merge-1";
const MERGE_RUN_ID = "run-merge-1";
const MERGE_SHAPE = Object.freeze({
  issueStatuses: Object.freeze({
    todo: Object.freeze({ id: "state-todo" }),
    in_review: Object.freeze({ id: "state-in-review" }),
    human_review: Object.freeze({ id: "state-human-review" }),
    done: Object.freeze({ id: "state-done" }),
  }),
  issueLabels: Object.freeze({
    human_review: Object.freeze({ id: HUMAN_REVIEW_LABEL_ID }),
  }),
});

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

test("human review briefing effect posts pure prose and records the machine side in the store", async () => {
  const client = createHumanReviewBriefingClient();
  const store = createBriefingRecordStore();
  const effects = [linearHumanReviewBriefingEffect];

  const first = await applyCommitEffects({
    effects,
    ctx: humanReviewBriefingCtx({ client, store }),
  });
  const second = await applyCommitEffects({
    effects,
    ctx: humanReviewBriefingCtx({ client, store }),
  });

  assert.equal(first.outcome, "ok");
  assert.equal(second.outcome, "ok");
  assert.equal(client.comments.length, 1);
  assert.equal(client.events.filter((event) => event.method === "createIssueComment").length, 1);
  // The human surface stays purely human: the comment is the briefing text,
  // nothing else.
  assert.equal(client.comments[0].body, "Check the user-visible workflow before accepting.");
  assert.deepEqual(store.briefingRecords({ issueId: "issue-review-1" }), {
    issue_id: "issue-review-1",
    head_sha: REVIEW.head_sha,
    run_id: "run-review-1",
    comment_id: "comment-1",
    posted_at: "2026-06-28T00:00:00.000Z",
  });
  assert.deepEqual(first.applied, [{
    id: LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
    identity: {
      issue_id: "issue-review-1",
      head_sha: REVIEW.head_sha,
      comment_id: "comment-1",
    },
  }]);
  assert.deepEqual(first.produced_identities, [{
    effect_id: LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
    provider: "linear",
    resource_kind: "linear_issue_comment",
    target_ids: [
      "comment-1",
      `issue-review-1@${REVIEW.head_sha}:human_review_briefing`,
    ],
    identity: {
      issue_id: "issue-review-1",
      head_sha: REVIEW.head_sha,
      comment_id: "comment-1",
    },
  }]);

  const nextHead = await applyCommitEffects({
    effects,
    ctx: humanReviewBriefingCtx({
      client,
      store,
      review: { ...REVIEW, head_sha: NEXT_HEAD_SHA },
      runId: "run-review-2",
    }),
  });

  assert.equal(nextHead.outcome, "ok");
  assert.equal(client.comments.length, 2);
  assert.equal(store.briefingRecords({ issueId: "issue-review-1" }).head_sha, NEXT_HEAD_SHA);
});

test("a briefing record whose comment was deleted does not satisfy the effect", async () => {
  const client = createHumanReviewBriefingClient();
  const store = createBriefingRecordStore();
  store.upsertBriefingRecord({
    issue_id: "issue-review-1",
    head_sha: REVIEW.head_sha,
    run_id: "run-review-0",
    comment_id: "comment-gone",
    posted_at: "2026-06-27T00:00:00.000Z",
  });

  const result = await applyCommitEffects({
    effects: [linearHumanReviewBriefingEffect],
    ctx: humanReviewBriefingCtx({ client, store }),
  });

  assert.equal(result.outcome, "ok");
  assert.equal(client.comments.length, 1, "briefing must be re-posted when the recorded comment is gone");
  assert.equal(store.briefingRecords({ issueId: "issue-review-1" }).comment_id, "comment-1");
});

test("human review briefing effect is advisory when posting fails, text is absent, or the store is absent", async () => {
  const postFailure = await applyLinearHumanReviewBriefingEffect(humanReviewBriefingCtx({
    client: createHumanReviewBriefingClient({
      createError: new Error("linear unavailable"),
    }),
    store: createBriefingRecordStore(),
  }));
  assert.deepEqual(postFailure, {
    ok: true,
    briefing_posted: false,
    reason: "linear_human_review_briefing_post_failed:linear_unavailable",
  });

  const missingText = await applyLinearHumanReviewBriefingEffect(humanReviewBriefingCtx({
    client: createHumanReviewBriefingClient(),
    store: createBriefingRecordStore(),
    review: { ...REVIEW, human_briefing: "" },
  }));
  assert.deepEqual(missingText, {
    ok: true,
    briefing_posted: false,
    reason: "linear_human_review_briefing_missing",
  });

  const missingStore = await applyLinearHumanReviewBriefingEffect(humanReviewBriefingCtx({
    client: createHumanReviewBriefingClient(),
    store: null,
  }));
  assert.deepEqual(missingStore, {
    ok: true,
    briefing_posted: false,
    reason: "linear_human_review_briefing_store_missing",
  });
});

test("readMergeGateSnapshot returns the seven-field decision input from fresh reads", async () => {
  const ctx = mergeCtx({
    client: createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] })),
    store: createMergeStore({
      parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }),
    }),
    prAdapter: createMergePrAdapter({
      pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
      statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
    }),
  });

  const snapshot = await readMergeGateSnapshot(ctx);

  assert.deepEqual(Object.keys(snapshot), [
    "issueStatusRole",
    "gateLabelPresent",
    "parkRecord",
    "currentHeadSha",
    "checkState",
    "checkHeadSha",
    "prState",
  ]);
  assert.deepEqual(snapshot, {
    issueStatusRole: "done",
    gateLabelPresent: true,
    parkRecord: { parked_head_sha: MERGE_HEAD_SHA, pr_number: MERGE_PR_NUMBER },
    currentHeadSha: MERGE_HEAD_SHA,
    checkState: "green",
    checkHeadSha: MERGE_HEAD_SHA,
    prState: "open",
  });
});

test("merge_pr merges only after the final fresh snapshot still says merge, then records and cleans up", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(prAdapter.mergeCalls, [{
    number: MERGE_PR_NUMBER,
    expectedHeadSha: MERGE_HEAD_SHA,
  }]);
  assert.deepEqual(client.updateCalls, []);
  assert.deepEqual(store.deletedIssueIds, [MERGE_ISSUE_ID]);
  assert.equal(store.parkRecords({ issueId: MERGE_ISSUE_ID }), null);
  assert.equal(store.outcomes.length, 1);
  assert.deepEqual(store.outcomes[0], {
    wakeId: MERGE_WAKE_ID,
    runId: MERGE_RUN_ID,
    merge_outcome: {
      issue_id: MERGE_ISSUE_ID,
      pr_number: MERGE_PR_NUMBER,
      head_sha: MERGE_HEAD_SHA,
      outcome: "merged",
      reason: "parked head merged",
      observed_at: "2026-06-29T12:00:00.000Z",
    },
  });
});

test("merge_pr aborts without a merge call when the final fresh read no longer answers merge", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequests: [
      mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
      mergePullRequest({ headSha: MERGE_NEXT_HEAD_SHA, state: "open" }),
    ],
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]], [MERGE_NEXT_HEAD_SHA, []]]),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.pending_effect_id, "merge_pr");
  assert.match(result.reason, /merge_pr_not_allowed: bounce/);
  assert.deepEqual(prAdapter.mergeCalls, []);
  assert.deepEqual(store.deletedIssueIds, []);
  assert.deepEqual(store.outcomes, []);
});

test("merge_pr final-read aborts when a human-review label is added to an ungated In Review merge", async () => {
  const client = createMergeIssueClient([
    mergeIssue({ statusRole: "in_review", labelIds: [] }),
    mergeIssue({ statusRole: "in_review", labelIds: [HUMAN_REVIEW_LABEL_ID] }),
  ]);
  const store = createMergeStore();
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.equal(result.pending_effect_id, "merge_pr");
  assert.match(result.reason, /merge_pr_not_allowed: park/);
  assert.deepEqual(prAdapter.mergeCalls, []);
  assert.deepEqual(store.deletedIssueIds, []);
  assert.deepEqual(store.outcomes, []);
});

test("merge_pr final-read ignores label changes after Done acceptance of the parked head", async () => {
  const client = createMergeIssueClient([
    mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }),
    mergeIssue({ statusRole: "done", labelIds: [] }),
  ]);
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(prAdapter.mergeCalls, [{
    number: MERGE_PR_NUMBER,
    expectedHeadSha: MERGE_HEAD_SHA,
  }]);
  assert.deepEqual(store.deletedIssueIds, [MERGE_ISSUE_ID]);
  assert.equal(store.outcomes[0].merge_outcome.outcome, "merged");
});

test("merge_pr cleans up an already-landed parked head without a GitHub merge call", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "closed", merged: true }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
  });
  const ctx = mergeCtx({ client, store, prAdapter });

  const probe = await probeMergePrEffect(ctx);
  assert.equal(probe.satisfied, false);
  assert.deepEqual(prAdapter.mergeCalls, []);
  assert.deepEqual(store.deletedIssueIds, []);

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx,
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(prAdapter.mergeCalls, []);
  assert.deepEqual(store.deletedIssueIds, [MERGE_ISSUE_ID]);
  assert.equal(store.outcomes.length, 1);
  assert.equal(store.outcomes[0].merge_outcome.outcome, "merged");
  assert.equal(store.outcomes[0].merge_outcome.head_sha, MERGE_HEAD_SHA);
});

test("merge_pr final-read refuses landed bookkeeping when the parked PR closed without merging", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "in_review", labelIds: [] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "closed", merged: false }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.match(result.reason, /merge_pr_not_allowed/);
  assert.match(result.reason, /closed without merging/);
  assert.deepEqual(prAdapter.mergeCalls, []);
  assert.deepEqual(store.deletedIssueIds, []);
  assert.deepEqual(store.outcomes, []);
  assert.equal(store.parkRecords({ issueId: MERGE_ISSUE_ID }).parked_head_sha, MERGE_HEAD_SHA);
});

test("merge_pr records a terminal failure for GitHub head-sha mismatch and keeps the park record", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
    mergeError: Object.assign(new Error("status_409"), { status: 409 }),
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.match(result.reason, /expected head sha/);
  assert.deepEqual(store.deletedIssueIds, []);
  assert.equal(store.parkRecords({ issueId: MERGE_ISSUE_ID }).parked_head_sha, MERGE_HEAD_SHA);
  assert.equal(store.outcomes.length, 1);
  assert.equal(store.outcomes[0].merge_outcome.outcome, "failed");
  assert.match(store.outcomes[0].merge_outcome.reason, /expected head sha/);
});

test("merge_pr records a terminal failure for GitHub merged:false and keeps the park record", async () => {
  const client = createMergeIssueClient(mergeIssue({ statusRole: "done", labelIds: [HUMAN_REVIEW_LABEL_ID] }));
  const store = createMergeStore({ parkRecord: mergeParkRecord({ headSha: MERGE_HEAD_SHA }) });
  const prAdapter = createMergePrAdapter({
    pullRequest: mergePullRequest({ headSha: MERGE_HEAD_SHA, state: "open" }),
    statusesBySha: new Map([[MERGE_HEAD_SHA, [mergeAfReviewStatus("success")]]]),
    mergeResult: { merged: false, message: "merge conflict" },
  });

  const result = await applyCommitEffects({
    effects: [mergePrEffectDescriptor()],
    ctx: mergeCtx({ client, store, prAdapter }),
  });

  assert.equal(result.outcome, "failed_closed");
  assert.match(result.reason, /merged:false/);
  assert.deepEqual(store.deletedIssueIds, []);
  assert.equal(store.outcomes.length, 1);
  assert.equal(store.outcomes[0].merge_outcome.outcome, "failed");
  assert.match(store.outcomes[0].merge_outcome.reason, /merge conflict/);
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

function humanReviewBriefingCtx({
  client,
  store,
  review = REVIEW,
  runId = "run-review-1",
} = {}) {
  const humanBriefing = Object.hasOwn(review, "human_briefing")
    ? review.human_briefing
    : "Check the user-visible workflow before accepting.";
  return {
    client,
    store,
    issueId: "issue-review-1",
    runId,
    review: {
      ...review,
      human_briefing: humanBriefing,
      run_id: runId,
    },
  };
}

function createHumanReviewBriefingClient({ createError = null } = {}) {
  const events = [];
  const comments = [];
  return {
    events,
    comments,
    async listIssueComments(issueId) {
      events.push({ method: "listIssueComments", issueId });
      assert.equal(issueId, "issue-review-1");
      return comments.map((comment) => ({ ...comment }));
    },
    async createIssueComment(issueId, body) {
      events.push({ method: "createIssueComment", issueId, body });
      assert.equal(issueId, "issue-review-1");
      if (createError) throw createError;
      const comment = {
        id: `comment-${comments.length + 1}`,
        body,
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        user: { id: "app-viewer-1", name: "Teami App" },
      };
      comments.push(comment);
      return { ...comment };
    },
  };
}

function createBriefingRecordStore() {
  const rows = new Map();
  return {
    upsertBriefingRecord(record) {
      rows.set(record.issue_id, { ...record });
      return { ...record };
    },
    briefingRecords(input = {}) {
      if (input && typeof input === "object" && Object.hasOwn(input, "issueId")) {
        const record = rows.get(input.issueId);
        return record ? { ...record } : null;
      }
      return [...rows.values()].map((record) => ({ ...record }));
    },
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

function mergeCtx({ client, store, prAdapter }) {
  return {
    client,
    store,
    prAdapter,
    shape: MERGE_SHAPE,
    issueId: MERGE_ISSUE_ID,
    prNumber: MERGE_PR_NUMBER,
    wake: { id: MERGE_WAKE_ID },
    runId: MERGE_RUN_ID,
    now: () => new Date("2026-06-29T12:00:00.000Z"),
  };
}

function createMergeIssueClient(issueOrIssues) {
  const issues = Array.isArray(issueOrIssues) ? issueOrIssues.map(clone) : null;
  const singleIssue = issues ? null : clone(issueOrIssues);
  const readCalls = [];
  const updateCalls = [];
  return {
    readCalls,
    updateCalls,
    async getIssue(issueId) {
      readCalls.push(issueId);
      if (issues) return clone(issues[Math.min(readCalls.length - 1, issues.length - 1)]);
      return clone(singleIssue);
    },
    async updateIssue(issueId, input) {
      updateCalls.push({ issueId, input });
      throw new Error("merge_pr_must_not_move_linear_issues");
    },
  };
}

function createMergeStore({ parkRecord: initialParkRecord = null } = {}) {
  let storedParkRecord = initialParkRecord ? clone(initialParkRecord) : null;
  const outcomes = [];
  const deletedIssueIds = [];
  return {
    outcomes,
    deletedIssueIds,
    parkRecords(input = {}) {
      if (input.issueId) {
        return storedParkRecord?.issue_id === input.issueId ? clone(storedParkRecord) : null;
      }
      return storedParkRecord ? [clone(storedParkRecord)] : [];
    },
    deleteParkRecord(issueId) {
      deletedIssueIds.push(issueId);
      if (storedParkRecord?.issue_id === issueId) storedParkRecord = null;
      return { ok: true };
    },
    recordMergeOutcome(input) {
      outcomes.push(clone(input));
      return { ok: true };
    },
  };
}

function createMergePrAdapter({
  pullRequest: singlePullRequest = null,
  pullRequests = null,
  statusesBySha = new Map(),
  mergeError = null,
  mergeResult = null,
} = {}) {
  const prQueue = pullRequests ? pullRequests.map(clone) : null;
  let currentPullRequest = clone(singlePullRequest || prQueue?.[0]);
  let getPullRequestCount = 0;
  const mergeCalls = [];
  return {
    mergeCalls,
    async getPullRequest(number) {
      assert.equal(number, MERGE_PR_NUMBER);
      if (prQueue) {
        currentPullRequest = clone(prQueue[Math.min(getPullRequestCount, prQueue.length - 1)]);
        getPullRequestCount += 1;
      }
      return clone(currentPullRequest);
    },
    async getCommitStatuses(headSha) {
      return clone(statusesBySha.get(headSha) || []);
    },
    async mergePullRequest(input) {
      mergeCalls.push({ ...input });
      if (mergeError) throw mergeError;
      if (mergeResult) return clone(mergeResult);
      currentPullRequest = {
        ...currentPullRequest,
        state: "closed",
        merged: true,
        merged_at: "2026-06-29T12:00:00.000Z",
      };
      return { merged: true, sha: input.expectedHeadSha };
    },
  };
}

function mergeIssue({ statusRole, labelIds = [] }) {
  return {
    id: MERGE_ISSUE_ID,
    identifier: "LIN-1",
    state: {
      id: `state-${statusRole.replaceAll("_", "-")}`,
      name: statusRole,
    },
    labels: labelIds.map((id) => ({ id })),
  };
}

function mergeParkRecord({ headSha }) {
  return {
    issue_id: MERGE_ISSUE_ID,
    pr_number: MERGE_PR_NUMBER,
    parked_head_sha: headSha,
    parked_at: "2026-06-29T11:00:00.000Z",
  };
}

function mergePullRequest({ headSha, state = "open", merged = false } = {}) {
  return {
    number: MERGE_PR_NUMBER,
    state,
    merged,
    ...(merged ? { merged_at: "2026-06-29T11:30:00.000Z" } : {}),
    head: { sha: headSha },
  };
}

function mergeAfReviewStatus(state, createdAt = "2026-06-29T11:30:00.000Z") {
  return {
    context: AF_REVIEW_STATUS_CONTEXT,
    state,
    created_at: createdAt,
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
