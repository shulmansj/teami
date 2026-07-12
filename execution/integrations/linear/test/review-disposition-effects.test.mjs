import assert from "node:assert/strict";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
  parseAfReviewCommentMarker,
} from "../src/execution-pr-adapter.mjs";
import {
  LINEAR_ISSUE_READY_EFFECT_ID,
  issueReadyEffect,
} from "../src/linear/issue-ready-effect.mjs";
import { resolveReadyIssueStatus } from "../src/linear/shape-resolver.mjs";
import {
  selectEffectsForDisposition,
} from "../src/workflows/review/effect-selector.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
} from "../src/workflows/review/effect-ids.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

test("review disposition selector returns the S5 effect set for each route", () => {
  const approveEffects = effectIds(selectEffectsForDisposition("approve", true));
  assert.deepEqual(approveEffects, [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  ]);
  assert.deepEqual(effectIds(selectEffectsForDisposition("approve", true, true)), [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
    LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
  ]);
  assert.equal(approveEffects.includes(LINEAR_ISSUE_READY_EFFECT_ID), false);
  assert.deepEqual(effectIds(selectEffectsForDisposition("request-changes", true)), [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
    LINEAR_ISSUE_READY_EFFECT_ID,
  ]);
  assert.deepEqual(effectIds(selectEffectsForDisposition("escalate", true)), [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  ]);
  assert.deepEqual(effectIds(selectEffectsForDisposition("diff_incomplete", true)), [
    GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
    GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  ]);
  assert.deepEqual(effectIds(selectEffectsForDisposition("escalate", false)), []);

  assert.throws(() => selectEffectsForDisposition("approved", true), /review_disposition_invalid:approved/);
  assert.throws(
    () => selectEffectsForDisposition("request_changes", true),
    /review_disposition_invalid:request_changes/,
  );
});

test("resolveReadyIssueStatus resolves the configured Todo status only", async () => {
  const target = await resolveReadyIssueStatus({
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return [
        { id: "state-backlog", name: "Backlog", type: "backlog", teamId },
        { id: "state-todo", name: "Todo", type: "unstarted", teamId },
      ];
    },
  }, configWithReviewStatuses(), "team-1");

  assert.deepEqual(target, {
    id: "state-todo",
    name: "Todo",
    type: "unstarted",
    teamId: "team-1",
    targetType: "status",
  });
});

test("issue ready effect moves the issue to the Todo execution trigger status", async () => {
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });

  const result = await applyCommitEffects({
    effects: [issueReadyEffect],
    ctx: {
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: { team: { id: "team-1" } },
      runId: "run-review-1",
    },
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(linearUpdates(client), [{
    method: "updateIssue",
    id: "issue-1",
    input: { stateId: "state-todo" },
  }]);
  assert.deepEqual(result.applied, [{
    id: LINEAR_ISSUE_READY_EFFECT_ID,
    identity: {
      linear_issue_id: "issue-1",
      issue_id: "issue-1",
      issue_key: "AF-123",
      target_type: "status",
      target_id: "state-todo",
      status: "Todo",
      status_id: "state-todo",
      state_id: "state-todo",
    },
  }]);
});

test("issue ready effect uses cached Todo status id from shape", async () => {
  const issue = issueInReview();
  const client = createFakeLinearClient({
    issue,
    extraStates: [
      { id: "state-todo-cached", name: "Todo", type: "unstarted", teamId: "team-1" },
    ],
  });

  const result = await applyCommitEffects({
    effects: [issueReadyEffect],
    ctx: {
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: {
        team: { id: "team-1" },
        issueStatuses: {
          todo: { id: "state-todo-cached", name: "Todo", type: "unstarted", teamId: "team-1" },
        },
      },
      runId: "run-review-1",
    },
  });

  assert.equal(result.outcome, "ok");
  assert.equal(client.events.some((event) => event.method === "listWorkflowStates"), false);
  assert.deepEqual(linearUpdates(client), [{
    method: "updateIssue",
    id: "issue-1",
    input: { stateId: "state-todo-cached" },
  }]);
});

test("request-changes replay after comment and status creates one of each before Todo move", async () => {
  const prAdapter = createFakeReviewPrAdapter();
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });
  let failBeforeTodoMove = true;

  const effects = selectEffectsForDisposition("request-changes", true);
  const ctx = {
    runId: "run-review-1",
    review: review({ disposition: "request-changes" }),
    prAdapter,
    client,
    config: configWithReviewStatuses(),
    issue,
    shape: { team: { id: "team-1" } },
    onBeforeLinearMutation(event) {
      assert.equal(event.effectId, LINEAR_ISSUE_READY_EFFECT_ID);
      if (failBeforeTodoMove) {
        failBeforeTodoMove = false;
        throw new Error("simulated_crash_after_review_status_before_todo_move");
      }
    },
  };

  const first = await applyCommitEffects({ effects, ctx });

  assert.equal(first.outcome, "pending");
  assert.equal(first.pending_effect_id, LINEAR_ISSUE_READY_EFFECT_ID);
  assert.equal(prAdapter.commentsByNumber.get(7).length, 1);
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA).length, 1);
  assert.equal(linearUpdates(client).length, 0);

  const replay = await applyCommitEffects({ effects, ctx });

  assert.equal(replay.outcome, "ok");
  assert.equal(prAdapter.commentsByNumber.get(7).length, 1);
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA).length, 1);
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA)[0].state, "failure");
  assert.equal(parseAfReviewCommentMarker(prAdapter.commentsByNumber.get(7)[0].body).ok, true);
  assert.deepEqual(linearUpdates(client), [{
    method: "updateIssue",
    id: "issue-1",
    input: { stateId: "state-todo" },
  }]);
  assert.equal(issue.state.name, "Todo");
  assert.equal(
    prAdapter.events.filter((event) => event.method === "postPullRequestComment").length,
    1,
  );
  assert.equal(
    prAdapter.events.filter((event) => event.method === "setCommitStatus").length,
    1,
  );
});

test("approve disposition leaves the issue in In Review", async () => {
  const prAdapter = createFakeReviewPrAdapter();
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });

  const result = await applyCommitEffects({
    effects: selectEffectsForDisposition("approve", true),
    ctx: {
      runId: "run-review-1",
      review: review({ disposition: "approve" }),
      prAdapter,
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: reviewShape(),
    },
  });

  assert.equal(result.outcome, "ok");
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA)[0].state, "success");
  assert.equal(
    parseAfReviewCommentMarker(prAdapter.commentsByNumber.get(7)[0].body).marker.disposition,
    "approve",
  );
  assert.deepEqual(linearUpdates(client), []);
  assert.equal(issue.state.name, "In Review");
});

test("escalate disposition writes the GitHub review route before the Linear pair runs inline", async () => {
  const prAdapter = createFakeReviewPrAdapter();
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });

  const result = await applyCommitEffects({
    effects: selectEffectsForDisposition("escalate", true),
    ctx: {
      runId: "run-review-1",
      review: review({ disposition: "escalate" }),
      prAdapter,
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: reviewShape(),
    },
  });

  assert.equal(result.outcome, "ok");
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA)[0].state, "failure");
  assert.equal(
    parseAfReviewCommentMarker(prAdapter.commentsByNumber.get(7)[0].body).marker.disposition,
    "escalate",
  );
  assert.deepEqual(linearUpdates(client), []);
  assert.equal(issue.state.name, "In Review");
});

test("no-PR escalation has no generic commit effects before the Linear pair runs inline", async () => {
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });

  const result = await applyCommitEffects({
    effects: selectEffectsForDisposition("escalate", false),
    ctx: {
      runId: "run-review-1",
      review: review({ disposition: "escalate" }),
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: reviewShape(),
    },
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(linearUpdates(client), []);
  assert.equal(issue.state.name, "In Review");
});

test("diff_incomplete applies canonical GitHub failure status before the Linear pair runs inline", async () => {
  const prAdapter = createFakeReviewPrAdapter();
  const issue = issueInReview();
  const client = createFakeLinearClient({ issue });

  const result = await applyCommitEffects({
    effects: selectEffectsForDisposition("diff_incomplete", true),
    ctx: {
      runId: "run-review-1",
      review: review({ disposition: "diff_incomplete" }),
      prAdapter,
      client,
      config: configWithReviewStatuses(),
      issue,
      shape: reviewShape(),
    },
  });

  assert.equal(result.outcome, "ok");
  assert.equal(prAdapter.statusesBySha.get(HEAD_SHA)[0].state, "failure");
  assert.equal(
    parseAfReviewCommentMarker(prAdapter.commentsByNumber.get(7)[0].body).marker.disposition,
    "escalate",
  );
  assert.deepEqual(linearUpdates(client), []);
  assert.equal(issue.state.name, "In Review");
});

function effectIds(effects) {
  return effects.map((effect) => effect.id);
}

function review({ disposition = "approve" } = {}) {
  return {
    owner: "acme",
    repo: "app",
    number: 7,
    head_sha: HEAD_SHA,
    disposition,
    body: "Review notes.",
  };
}

function issueInReview() {
  return {
    id: "issue-1",
    identifier: "AF-123",
    teamId: "team-1",
    state: { id: "state-in-review", name: "In Review", type: "started" },
    labels: [],
  };
}

function configWithReviewStatuses() {
  return {
    linear: {
      issue: {
        labels: { discovery: "Discovery", needs_principal: "Needs Principal" },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
          done: { name: "Done", type: "completed" },
        },
      },
    },
  };
}

function reviewShape() {
  return {
    team: { id: "team-1" },
    issueStatuses: {
      backlog: { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
      todo: { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
      in_progress: { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
      in_review: { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
      needs_principal: { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
      done: { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
    },
    issueLabels: {
      needs_principal: { id: "label-needs-principal", name: "Needs Principal", teamId: "team-1" },
    },
  };
}

function createFakeLinearClient({ issue, extraStates = [] }) {
  const states = new Map([
    ["state-backlog", { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" }],
    ["state-todo", { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" }],
    ["state-in-progress", { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" }],
    ["state-in-review", { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" }],
    ["state-needs-principal", {
      id: "state-needs-principal",
      name: "Principal Escalation",
      type: "started",
      teamId: "team-1",
    }],
    ["state-needs-principal", {
      id: "state-needs-principal",
      name: "Principal Escalation",
      type: "started",
      teamId: "team-1",
    }],
    ["state-done", { id: "state-done", name: "Done", type: "completed", teamId: "team-1" }],
  ]);
  for (const state of extraStates) states.set(state.id, state);
  const events = [];
  return {
    events,
    async listWorkflowStates(teamId) {
      events.push({ method: "listWorkflowStates", teamId });
      return [...states.values()];
    },
    async getIssue(id) {
      events.push({ method: "getIssue", id });
      assert.equal(id, issue.id);
      return issue;
    },
    async updateIssue(id, input) {
      events.push({ method: "updateIssue", id, input });
      assert.equal(id, issue.id);
      if (input.stateId) {
        assert.ok(states.has(input.stateId), `unknown state: ${input.stateId}`);
        issue.state = states.get(input.stateId);
      }
      if (input.labelIds) issue.labels = input.labelIds.map((labelId) => ({ id: labelId }));
      return issue;
    },
  };
}

function linearUpdates(client) {
  return client.events.filter((event) => event.method === "updateIssue");
}

function createFakeReviewPrAdapter() {
  let nextCommentId = 1;
  const events = [];
  const pullRequests = new Map([[7, {
    number: 7,
    state: "open",
    head: { sha: HEAD_SHA },
  }]]);
  const commentsByNumber = new Map();
  const statusesBySha = new Map();
  return {
    events,
    pullRequests,
    commentsByNumber,
    statusesBySha,
    async getPullRequest(number) {
      events.push({ method: "getPullRequest", number });
      return pullRequests.get(number) || null;
    },
    async listPullRequestComments(number) {
      events.push({ method: "listPullRequestComments", number });
      return commentsByNumber.get(number) || [];
    },
    async postPullRequestComment({ number, body, disposition, head_sha, run_id }) {
      events.push({ method: "postPullRequestComment", number, head_sha });
      const comments = commentsByNumber.get(number) || [];
      const posted = {
        id: nextCommentId,
        comment_id: String(nextCommentId),
        body: body.includes("<!-- af-review:")
          ? body
          : formatAfReviewCommentBody({ body, disposition, head_sha, run_id }),
        created_at: "2026-06-28T00:00:00.000Z",
      };
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
      assert.equal(context, AF_REVIEW_STATUS_CONTEXT);
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
