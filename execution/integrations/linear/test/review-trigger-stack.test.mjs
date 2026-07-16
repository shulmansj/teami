import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import { TEAM_REGISTRY_SCHEMA_VERSION, makeTeamRecord } from "../src/team-registry.mjs";
import {
  decideReviewIssue,
  gatewayPollTargets,
  gatewayState,
  listInReviewIssueCandidates,
  processReviewIssue,
} from "../src/gateway-loop.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import { renderResourceTargetBlock } from "../src/resource-target.mjs";
import { runTriggeredReview } from "../src/trigger-runner.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
} from "../src/workflows/review/effect-ids.mjs";
import { ISSUE_NEEDS_PRINCIPAL_EFFECT_ID } from "../src/linear/issue-needs-principal-effect.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO_SHA = "0000000000000000000000000000000000000000";

registerGitRepoResourceKind();

test("In Review poll target is registered and lists issues from the in_review state", async () => {
  const reviewTarget = gatewayPollTargets().find((descriptor) => descriptor.input_status === "In Review");
  assert.ok(reviewTarget, "In Review descriptor should be registered");
  assert.equal(typeof reviewTarget.listCandidates, "function");
  assert.equal(typeof reviewTarget.process, "function");
  assert.equal(typeof reviewTarget.inFlightKey, "function");
  assert.equal(typeof reviewTarget.order, "function");
  assert.equal(reviewTarget.inFlightKey({ id: "issue-1" }), "issue-1");

  const calls = [];
  const page = await listInReviewIssueCandidates({
    config: reviewConfig(),
    team: teamFixture(),
    client: {
      async listWorkflowStates(teamId) {
        calls.push(["states", teamId]);
        return workflowStates();
      },
      async listReadyIssueCandidates(teamId, input) {
        calls.push(["issues", teamId, input]);
        return {
          candidates: [{ id: "issue-1", createdAt: "2026-06-28T00:00:00.000Z" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
    },
  }, { first: 7, after: "cursor-1" });

  assert.deepEqual(page.candidates.map((candidate) => candidate.id), ["issue-1"]);
  assert.deepEqual(calls, [
    ["states", "team-1"],
    ["issues", "team-1", { readyStateId: "state-in-review", first: 7, after: "cursor-1" }],
  ]);
});

test("decideReviewIssue routes PR discovery statuses and idempotency without execution replay markers", async () => {
  const issueContext = issueFixture();
  const repoIdentity = repoIdentityFixture();
  const markerState = {
    af_review_state: "success",
    latest_marker_comment_at_head: { marker: { head_sha: HEAD_SHA } },
  };

  const alreadyReviewed = await decideReviewIssue({
    issueId: "issue-1",
    issueContext,
    repoIdentity,
    locatePr: async () => ({ status: "found", pr: prFixture({ headSha: HEAD_SHA }) }),
    hydrateState: async () => markerState,
    store: {
      readGitReplayPending() {
        throw new Error("decideReviewIssue must not read execution replay markers");
      },
    },
  });
  assert.equal(alreadyReviewed.action, "skip");
  assert.equal(alreadyReviewed.reason, "review_already_applied_at_head");

  const newPush = await decideReviewIssue({
    issueId: "issue-1",
    issueContext,
    repoIdentity,
    locatePr: async () => ({ status: "found", pr: prFixture({ headSha: NEXT_HEAD_SHA }) }),
    hydrateState: async () => ({ af_review_state: null, latest_marker_comment_at_head: null }),
  });
  assert.equal(newPush.action, "review");
  assert.equal(newPush.pr.head_sha, NEXT_HEAD_SHA);

  for (const status of ["closed", "multiple", "wrong_base"]) {
    const decision = await decideReviewIssue({
      issueId: "issue-1",
      issueContext,
      repoIdentity,
      locatePr: async () => ({ status }),
    });
    assert.equal(decision.action, "escalate", status);
    assert.equal(decision.reason, `review_pr_${status}`);
  }

  const wait = await decideReviewIssue({
    issueId: "issue-1",
    issueContext,
    repoIdentity,
    locatePr: async () => ({ status: "none" }),
    store: {
      findLatestRunForObject: () => ({
        object_id: "issue-1",
        workflow_type: "execution",
        status: "running",
        started_at: "2026-06-28T12:00:00.000Z",
      }),
    },
    now: () => new Date("2026-06-28T12:01:00.000Z"),
  });
  assert.equal(wait.action, "wait");
  assert.equal(wait.reason, "review_pr_pending_execution");

  const stale = await decideReviewIssue({
    issueId: "issue-1",
    issueContext,
    repoIdentity,
    locatePr: async () => ({ status: "none", reason: "review_pr_missing" }),
    store: {
      findLatestRunForObject: () => ({
        object_id: "issue-1",
        workflow_type: "execution",
        status: "completed",
        started_at: "2026-06-28T11:00:00.000Z",
        terminal_at: "2026-06-28T11:01:00.000Z",
      }),
    },
    now: () => new Date("2026-06-28T12:00:00.000Z"),
  });
  assert.equal(stale.action, "escalate");
  assert.equal(stale.reason, "review_pr_missing");
});

test("decideReviewIssue uses produced PR identity and scopes branch-search recovery to the selected repo", async () => {
  const teamContext = multiRepoTeamContextFixture();
  const issueContext = issueFixture({
    id: "issue-6",
    identifier: "AF-6",
    description: [
      "Review the produced PR.",
      "",
      renderResourceTargetBlock({ kind: "git_repo", id: "repo-b" }),
    ].join("\n"),
  });
  const branch = branchNameForIssue("AF-6");
  const legacyFirstRepo = teamContext.resources.find((resource) => resource.kind === "git_repo");
  assert.equal(
    legacyFirstRepo.binding.repo,
    "repo-a",
    "the old first-resource lookup would have selected repo A",
  );

  const producedAdapterCalls = [];
  const producedDecision = await decideReviewIssue({
    issueId: "issue-6",
    issueContext,
    teamContext,
    store: {
      findLatestRunForObject: () => executionRunWithProducedPrIdentity({
        resource_id: "repo-b",
        owner: "acme",
        repo: "repo-b",
        branch,
        head_sha: HEAD_SHA,
        pull_request_number: 202,
      }),
    },
    createPrAdapter: async ({ repoIdentity }) => ({
      async getPullRequest(number) {
        producedAdapterCalls.push({ method: "getPullRequest", repoIdentity, number });
        assert.equal(number, 202);
        return {
          number: 202,
          state: "open",
          head: { ref: branch, sha: NEXT_HEAD_SHA },
          base: { ref: "main" },
        };
      },
    }),
    locatePr: async () => {
      throw new Error("branch-search recovery must not run when produced PR identity is usable");
    },
    hydrateState: async () => ({ af_review_state: null, latest_marker_comment_at_head: null }),
  });

  assert.equal(producedDecision.action, "review");
  assert.equal(producedDecision.location.source, "produced_identity");
  assert.equal(producedDecision.repoIdentity.repo, "repo-b");
  assert.equal(producedDecision.pr.repo, "repo-b");
  assert.equal(producedDecision.pr.number, 202);
  assert.equal(producedDecision.pr.head_sha, NEXT_HEAD_SHA);
  assert.deepEqual(producedAdapterCalls.map((call) => ({
    method: call.method,
    repo: call.repoIdentity.repo,
    number: call.number,
  })), [
    { method: "getPullRequest", repo: "repo-b", number: 202 },
  ]);

  const branchSearchCalls = [];
  const recoveryDecision = await decideReviewIssue({
    issueId: "issue-6",
    issueContext,
    teamContext,
    store: {
      findLatestRunForObject: () => executionRunWithProducedPrIdentity(null),
    },
    locatePr: async ({ repoIdentity }) => {
      branchSearchCalls.push(repoIdentity);
      return {
        status: "found",
        branch,
        pr: {
          owner: repoIdentity.owner,
          repo: repoIdentity.repo,
          number: 303,
          head_sha: HEAD_SHA,
        },
      };
    },
    hydrateState: async () => ({ af_review_state: null, latest_marker_comment_at_head: null }),
  });

  assert.equal(recoveryDecision.action, "review");
  assert.equal(recoveryDecision.repoIdentity.repo, "repo-b");
  assert.equal(recoveryDecision.pr.repo, "repo-b");
  assert.deepEqual(branchSearchCalls.map((repoIdentity) => repoIdentity.repo), ["repo-b"]);
});

test("processReviewIssue respects the global maxInFlight gate", async () => {
  const state = gatewayState({ inFlight: new Set(["other-issue"]), maxInFlight: 1 });
  const result = await processReviewIssue({
    team: { id: "team-1" },
    client: {
      async getIssueContext() {
        throw new Error("maxInFlight skip should not read the issue");
      },
    },
    candidate: { id: "issue-1" },
    state,
  });

  assert.deepEqual(result, {
    action: "skipped",
    reason: "max_in_flight",
    issueId: "issue-1",
  });
});

test("runTriggeredReview assembles issue and PR diff, runs review, and writes af-review effects", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-run-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter();
  const observedProjects = [];

  const result = await runTriggeredReview(reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    orchestratorTurnExecutor: async (input) => {
      const packet = JSON.parse(input.project.content);
      observedProjects.push(packet);
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: {
          disposition: "approve",
          body: "Approved. The diff implements the issue.",
          reviewed_head_sha: HEAD_SHA,
          source_refs: [{ kind: "github_pull_request", id: "acme/product#7" }],
          assumptions: [],
          constraints: [],
          risks: [],
        },
      };
    },
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.trace.attributes["review.disposition"], "approve");
  const verdictSpan = result.result.trace.spans.find((span) => span.name === "review_verdict_payload");
  assert.ok(verdictSpan, "review verdict payload span should be recorded");
  assert.equal(verdictSpan.attributes.disposition, "approve");
  assert.equal(verdictSpan.attributes.reviewed_head_sha, HEAD_SHA);
  assert.equal(verdictSpan.attributes.github_owner, "acme");
  assert.equal(verdictSpan.attributes.github_repo, "product");
  assert.equal(verdictSpan.attributes.github_pull_request_number, 7);
  assert.equal(verdictSpan.attributes.body_digest_kind, "sha256");
  assert.equal(verdictSpan.attributes.body_sha256, sha256("Approved. The diff implements the issue."));
  assert.equal(
    verdictSpan.attributes.body_byte_length,
    Buffer.byteLength("Approved. The diff implements the issue.", "utf8"),
  );
  assert.equal(observedProjects.length, 1);
  assert.equal(observedProjects[0].issue.identifier, "AF-1");
  assert.equal(observedProjects[0].pull_request.head_sha, HEAD_SHA);
  assert.match(observedProjects[0].diff.files[0].patch, /42/);
  assert.equal(prAdapter.comments.length, 1);
  assert.match(prAdapter.comments[0].body, /Approved/);
  assert.match(prAdapter.comments[0].body, /"disposition":"approve"/);
  assert.deepEqual(prAdapter.statuses.map((status) => ({
    context: status.context,
    state: status.state,
    head_sha: status.head_sha,
  })), [{
    context: AF_REVIEW_STATUS_CONTEXT,
    state: "success",
    head_sha: HEAD_SHA,
  }]);
  assert.deepEqual(
    result.result.applied.map((entry) => entry.id),
    [GITHUB_PR_REVIEW_COMMENT_EFFECT_ID, GITHUB_AF_REVIEW_STATUS_EFFECT_ID],
  );
});

test("runTriggeredReview posts a Linear human-review briefing from a fresh gate-label read", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-briefing-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter();
  const linearClient = createMutableReviewLinearClient();

  const result = await runTriggeredReview(reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    linearClient,
    orchestratorTurnExecutor: async () => {
      linearClient.addIssueLabel("label-human-review", "human-review");
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: {
          disposition: "approve",
          body: "Approved. The diff implements the issue.",
          human_briefing: "Review the checkout workflow in Linear and accept only if the happy path is visible.",
          reviewed_head_sha: HEAD_SHA,
          source_refs: [{ kind: "github_pull_request", id: "acme/product#7" }],
          assumptions: [],
          constraints: [],
          risks: [],
        },
      };
    },
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.deepEqual(
    result.result.applied.map((entry) => entry.id),
    [
      GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
      GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
    ],
  );
  assert.equal(prAdapter.statuses.at(-1).state, "success");
  assert.equal(linearClient.comments.length, 1);
  assert.equal(
    linearClient.comments[0].body,
    "Review the checkout workflow in Linear and accept only if the happy path is visible.",
  );
  const gateSpan = result.result.trace.spans.find((span) => span.name === "human_review_gate_label_fresh_read");
  assert.equal(gateSpan?.attributes?.selected, true);
  assert.equal(result.result.artifact.payload.human_briefing, "Review the checkout workflow in Linear and accept only if the happy path is visible.");
});

test("runTriggeredReview turns malformed S7 output into an escalation commit", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-malformed-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter();
  const linearClient = createMutableReviewLinearClient();

  const result = await runTriggeredReview(reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    linearClient,
    orchestratorTurnExecutor: async () => ({
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: {
        disposition: "approved",
        body: " ",
        reviewed_head_sha: "abc123",
        comments: "not-an-array",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      },
    }),
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.equal(result.result.status, "completed");
  assert.equal(prAdapter.statuses.at(-1).state, "failure");
  assert.match(prAdapter.comments.at(-1).body, /review_payload_invalid/);
  assert.match(prAdapter.comments.at(-1).body, /"disposition":"escalate"/);
  assert.equal(linearClient.comments.length, 1);
  assert.match(linearClient.comments[0].body, /review_payload_invalid/);
  assert.match(linearClient.comments[0].body, /move this issue back to In Review/);
  assert.doesNotMatch(linearClient.comments[0].body, /af-review/);
  assert.equal(linearClient.issueStateName("issue-1"), "Principal Escalation");
  assert.deepEqual(
    result.result.applied.map((entry) => entry.id),
    [
      GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
      GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
      ISSUE_NEEDS_PRINCIPAL_EFFECT_ID,
    ],
  );
});

test("runTriggeredReview labels a valid non-commit terminal as review_not_completed, not a payload defect", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-pause-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter();
  const linearClient = createMutableReviewLinearClient();

  const result = await runTriggeredReview(reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    linearClient,
    orchestratorTurnExecutor: async (turnInput) => ({
      controlAction: { action: "terminate", outcome: "pause", reason: "discovery_needed" },
      producedContent: {
        context_digest: "Review paused: the packet lacks required acceptance evidence.",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
        project_update_markdown: `run_id: ${turnInput.runId}\n\nPaused the review pending acceptance evidence.`,
        open_questions_markdown: "Please provide the verbatim validation evidence for this PR.",
      },
    }),
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.equal(result.result.status, "completed");
  assert.equal(prAdapter.statuses.at(-1).state, "failure");
  const commentBody = prAdapter.comments.at(-1).body;
  assert.match(commentBody, /review_not_completed/);
  assert.match(commentBody, /review_terminal_outcome_pause:discovery_needed/);
  assert.match(commentBody, /Please provide the verbatim validation evidence for this PR\./);
  assert.doesNotMatch(commentBody, /reviewed_head_sha_mismatch/);
  assert.match(commentBody, /"disposition":"escalate"/);
  assert.equal(linearClient.comments.length, 1);
  assert.match(linearClient.comments[0].body, /review_not_completed/);
  assert.match(linearClient.comments[0].body, /Please provide the verbatim validation evidence for this PR\./);
  assert.equal(linearClient.issueStateName("issue-1"), "Principal Escalation");
});

test("runTriggeredReview escalates incomplete PR diffs without invoking the reviewer", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-diff-incomplete-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter({
    diff: {
      files: [],
      diff_incomplete: true,
      reason: "github_pull_request_files_cap_exceeded",
    },
  });
  const linearClient = createMutableReviewLinearClient();

  const result = await runTriggeredReview(reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    linearClient,
    orchestratorTurnExecutor: async () => {
      throw new Error("diff-incomplete review should not invoke the reviewer");
    },
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.equal(result.result.status, "completed");
  assert.equal(prAdapter.statuses.at(-1).state, "failure");
  assert.match(prAdapter.comments.at(-1).body, /diff_incomplete/);
  assert.equal(linearClient.comments.length, 1);
  assert.match(linearClient.comments[0].body, /diff_incomplete/);
  assert.match(linearClient.comments[0].body, /move this issue back to In Review/);
  assert.equal(linearClient.issueStateName("issue-1"), "Principal Escalation");
});

test("runTriggeredReview preflight no-PR escalation applies only the Linear route", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-no-pr-"));
  writeReviewAcceptedPromptFixture(tempRoot);
  const prAdapter = createReviewPrAdapter();
  const linearClient = createMutableReviewLinearClient();
  const options = reviewRunOptions({
    repoRoot: tempRoot,
    prAdapter,
    linearClient,
    orchestratorTurnExecutor: async () => {
      throw new Error("no-PR preflight escalation should not invoke the reviewer");
    },
  });
  options.reviewDecision = {
    action: "escalate",
    reason: "review_pr_closed",
    location: { status: "closed" },
    repoIdentity: repoIdentityFixture(),
    hasPr: false,
  };

  const result = await runTriggeredReview(options);

  assert.equal(result.status, "completed", JSON.stringify(result, errorJsonReplacer, 2));
  assert.deepEqual(result.result.applied.map((entry) => entry.id), [ISSUE_NEEDS_PRINCIPAL_EFFECT_ID]);
  assert.equal(prAdapter.comments.length, 0);
  assert.equal(prAdapter.statuses.length, 0);
  assert.equal(linearClient.comments.length, 1);
  assert.match(linearClient.comments[0].body, /review_pr_closed/);
  assert.match(linearClient.comments[0].body, /move this issue back to In Review/);
  assert.equal(result.result.artifact.payload.reviewed_head_sha, ZERO_SHA);
  assert.equal(linearClient.issueStateName("issue-1"), "Principal Escalation");
});

function reviewRunOptions({
  repoRoot,
  prAdapter,
  linearClient = createMutableReviewLinearClient(),
  orchestratorTurnExecutor,
  cache = {
    workspaceId: "workspace-1",
    teamId: "team-1",
    app_identity_id: "app-viewer-1",
    issueStatuses: {
      needs_principal: "state-needs-principal",
    },
    issueLabels: {
      "Needs Principal": "label-needs-principal",
      "human-review": "label-human-review",
    },
  },
}) {
  const store = createFakeReviewStore();
  const team = teamFixture();
  const registry = { schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] };
  return {
    issueId: "issue-1",
    reviewDecision: {
      action: "review",
      reason: "review_pr_found",
      pr: prFixture({ headSha: HEAD_SHA }),
      repoIdentity: repoIdentityFixture(),
      hasPr: true,
    },
    teamContext: teamContextFixture(),
    registry,
    claim: {
      ok: true,
      leaseToken: "lease-1",
      event: {
        id: "event-1",
        event_id: "evt-1",
        provider: "linear",
      },
      wake: {
        id: "wake-1",
        workspace_id: "workspace-1",
        team_ref: "team-1",
        trigger_type: "linear.issue.in_review",
        workflow_type: "review",
        object_type: "issue",
        object_id: "issue-1",
        team_ids: ["team-1"],
        created_at: "2026-06-28T00:00:00.000Z",
        attempt_count: 0,
        source_event_id: "event-1",
        status: "leased",
        lease_token: "lease-1",
      },
    },
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient,
    config: reviewConfig(),
    cache,
    repoRoot,
    runStoreDir: path.join(repoRoot, ".teami", "runs"),
    runtimeExecutor: {
      async executeSubagent() {
        throw new Error("subagent executor should not be called by this one-turn fixture");
      },
    },
    orchestratorTurnExecutor,
    runDeps: { store, prAdapter },
  };
}

function createFakeReviewStore() {
  const wakes = new Map();
  const runs = new Map();
  const briefingRows = new Map();
  return {
    triggerEvents: [],
    upsertBriefingRecord(record) {
      briefingRows.set(record.issue_id, { ...record });
      return { ...record };
    },
    briefingRecords(input = {}) {
      if (input && typeof input === "object" && Object.hasOwn(input, "issueId")) {
        const record = briefingRows.get(input.issueId);
        return record ? { ...record } : null;
      }
      return [...briefingRows.values()].map((record) => ({ ...record }));
    },
    async heartbeat() {
      return { ok: true };
    },
    async renewLease({ wakeId }) {
      return { ok: true, wake: structuredClone(wakes.get(wakeId) || null) };
    },
    async markWakeRunning({ wakeId, runnerId, leaseToken, runId, teamRef }) {
      const wake = wakes.get(wakeId) || {
        id: wakeId,
        workspace_id: "workspace-1",
        object_id: "issue-1",
        workflow_type: "review",
        object_type: "issue",
      };
      Object.assign(wake, {
        status: "running",
        runner_id: runnerId,
        lease_token: leaseToken,
        run_id: runId,
        team_ref: teamRef,
      });
      wakes.set(wakeId, wake);
      runs.set(runId, { run_id: runId, wake_id: wakeId, status: "running" });
      return { ok: true, wake: structuredClone(wake) };
    },
    async completeWake({ wakeId, status, reason, providerUpdateIds = [], artifactPointer = null, artifact = null }) {
      const wake = wakes.get(wakeId);
      Object.assign(wake, { status, reason, provider_update_ids: providerUpdateIds });
      const run = runs.get(wake.run_id);
      Object.assign(run, {
        status,
        terminal_reason: reason,
        provider_update_ids: providerUpdateIds,
        artifact_pointer: artifactPointer,
        runtime_metadata: artifact?.runtime_metadata || {},
      });
      return { ok: true, wake: structuredClone(wake), run: structuredClone(run) };
    },
    async getWake(wakeId) {
      return structuredClone(wakes.get(wakeId) || null);
    },
  };
}

function createMutableReviewLinearClient() {
  const states = workflowStates();
  const byStateId = new Map(states.map((state) => [state.id, state]));
  const issue = {
    id: "issue-1",
    identifier: "AF-1",
    title: "Implement review target",
    description: "Review the PR.",
    stateId: "state-in-review",
    createdAt: "2026-06-28T00:00:00.000Z",
    labels: [],
  };
  const comments = [];
  return {
    comments,
    async getIssueContext(id) {
      assert.equal(id, "issue-1");
      return issueView();
    },
    async getIssue(id) {
      assert.equal(id, "issue-1");
      return issueView();
    },
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return states.map((state) => ({ ...state }));
    },
    async updateIssue(id, input) {
      assert.equal(id, "issue-1");
      if (input.stateId) issue.stateId = input.stateId;
      if (Array.isArray(input.labelIds)) issue.labels = input.labelIds.map((labelId) => ({ id: labelId, name: labelId }));
      return issueView();
    },
    async findIssueLabelsByName(name, teamId) {
      assert.equal(name, null);
      assert.equal(teamId, "team-1");
      return [
        { id: "label-needs-principal", name: "Needs Principal", teamId },
      ];
    },
    async listIssueComments(id) {
      assert.equal(id, "issue-1");
      return comments.map((comment) => ({ ...comment }));
    },
    async createIssueComment(id, body) {
      assert.equal(id, "issue-1");
      const comment = {
        id: `linear-comment-${comments.length + 1}`,
        body,
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
        user: { id: "app-viewer-1", name: "Teami App" },
      };
      comments.push(comment);
      return { ...comment };
    },
    addIssueLabel(id, name) {
      issue.labels.push({ id, name });
    },
    issueStateName(id) {
      assert.equal(id, "issue-1");
      return byStateId.get(issue.stateId).name;
    },
  };

  function issueView() {
    return structuredClone({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: "https://linear.test/AF-1",
      createdAt: issue.createdAt,
      state: byStateId.get(issue.stateId),
      team: { id: "team-1", key: "AF", name: "Teami" },
      labels: issue.labels,
      relations: [],
    });
  }
}

function createReviewPrAdapter({
  diff = {
    files: [{
      filename: "src/app.js",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "@@ -1 +1 @@\n-export const value = 41;\n+export const value = () => 42;",
    }],
    diff_incomplete: false,
  },
} = {}) {
  const comments = [];
  const statuses = [];
  return {
    comments,
    statuses,
    async getPullRequest(number) {
      assert.equal(number, 7);
      return {
        number: 7,
        state: "open",
        head: { sha: HEAD_SHA, ref: "af/execution/AF-1-review" },
        base: { ref: "main" },
      };
    },
    async getPullRequestFiles(number) {
      assert.equal(number, 7);
      return structuredClone(diff);
    },
    async getCommitStatuses(headSha) {
      assert.ok([HEAD_SHA, ZERO_SHA].includes(headSha));
      return statuses.filter((status) => status.head_sha === headSha).map((status) => ({ ...status }));
    },
    async setCommitStatus(status) {
      statuses.push({
        ...status,
        created_at: new Date(Date.parse("2026-06-28T00:00:00.000Z") + statuses.length * 1000).toISOString(),
      });
      return { id: `status-${statuses.length}` };
    },
    async postPullRequestComment({ number, body, context, disposition, head_sha, run_id }) {
      assert.equal(number, 7);
      const comment = {
        id: `comment-${comments.length + 1}`,
        body: formatAfReviewCommentBody({ body, context, disposition, head_sha, run_id }),
        created_at: new Date(Date.parse("2026-06-28T00:00:00.000Z") + comments.length * 1000).toISOString(),
      };
      comments.push(comment);
      return { comment_id: comment.id };
    },
    async listPullRequestComments(number) {
      assert.equal(number, 7);
      return comments.map((comment) => ({ ...comment }));
    },
  };
}

function writeReviewAcceptedPromptFixture(repoRoot) {
  const namespaceRoot = path.join(repoRoot, "execution", "evals", "review");
  const promptDir = path.join(namespaceRoot, "accepted-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const governingPath = path.join(promptDir, "orchestrator-governing.md");
  const reviewerPath = path.join(promptDir, "reviewer.md");
  const governing = [
    "# Review Orchestrator",
    "",
    "```yaml",
    "target_key: prompt/review/orchestrator_governing",
    "```",
    "",
    "Run review and emit the S7 review payload.",
    "",
  ].join("\n");
  const reviewer = [
    "# Reviewer",
    "",
    "```yaml",
    "target_key: prompt/review/reviewer",
    "```",
    "",
    "Review the supplied issue and PR diff.",
    "",
  ].join("\n");
  fs.writeFileSync(governingPath, governing, "utf8");
  fs.writeFileSync(reviewerPath, reviewer, "utf8");
  fs.writeFileSync(
    path.join(namespaceRoot, "phoenix-assets.json"),
    `${JSON.stringify({
      prompts: [
        {
          target_key: "prompt/review/orchestrator_governing",
          artifact_kind: "accepted_prompt",
          materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
          role: "orchestrator",
          snapshot_path: "execution/evals/review/accepted-prompts/orchestrator-governing.md",
          snapshot_sha256: sha256(governing),
        },
        {
          target_key: "prompt/review/reviewer",
          artifact_kind: "accepted_prompt",
          materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
          role: "reviewer",
          snapshot_path: "execution/evals/review/accepted-prompts/reviewer.md",
          snapshot_sha256: sha256(reviewer),
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function reviewConfig() {
  return {
    runtime: {
      adapters: {
        codex: {
          command: "codex",
          tool_policy: { linear_write: false },
        },
      },
    },
    workflows: {
      review: {
        roles: {
          reviewer: { runtime: "codex", model: "test-reviewer" },
          orchestrator: { runtime: "codex", model: "test-orchestrator" },
        },
      },
    },
    linear: {
      team: { key: "AF", name: "Teami" },
      issue: {
        labels: {
          needs_principal: "Needs Principal",
          human_review: "human-review",
        },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          human_review: { name: "Principal Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
          done: { name: "Done", type: "completed" },
          ready: { name: "Ready" },
        },
      },
    },
  };
}

function workflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
    { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
    { id: "state-ready", name: "Ready", type: "unstarted", teamId: "team-1" },
    { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
    { id: "state-human-review", name: "Principal Review", type: "started", teamId: "team-1" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
  ];
}

function teamFixture() {
  return makeTeamRecord({
    teamRef: "team-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
    webhookId: "webhook-1",
    resources: [{
      id: "repo-1",
      kind: "git_repo",
      role: "primary",
      binding: {
        owner: "acme",
        repo: "product",
        default_branch: "main",
      },
    }],
  });
}

function teamContextFixture() {
  return {
    teamRef: "team-1",
    status: "active",
    resources: teamFixture().resources,
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "AF",
      teamName: "Teami",
      webhookId: "webhook-1",
      cachePath: "unused-cache.json",
    },
    trace: {
      team_ref: "team-1",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:review-test",
    },
  };
}

function multiRepoTeamContextFixture() {
  return {
    ...teamContextFixture(),
    resources: [
      {
        id: "repo-a",
        kind: "git_repo",
        role: "primary",
        binding: {
          owner: "acme",
          repo: "repo-a",
          default_branch: "main",
        },
      },
      {
        id: "repo-b",
        kind: "git_repo",
        role: "primary",
        binding: {
          owner: "acme",
          repo: "repo-b",
          default_branch: "main",
        },
      },
    ],
  };
}

function issueFixture(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "AF-1",
    title: "Implement review target",
    description: "Review the PR.",
    state: { id: "state-in-review", name: "In Review", type: "started" },
    labels: [],
    relations: [],
    ...overrides,
  };
}

function repoIdentityFixture() {
  return {
    owner: "acme",
    repo: "product",
    default_branch: "main",
  };
}

function prFixture({ headSha }) {
  return {
    owner: "acme",
    repo: "product",
    number: 7,
    head_sha: headSha,
  };
}

function executionRunWithProducedPrIdentity(identity) {
  return {
    object_id: "issue-6",
    workflow_type: "execution",
    status: "completed",
    started_at: "2026-06-28T11:00:00.000Z",
    terminal_at: "2026-06-28T11:01:00.000Z",
    artifact: {
      produced_identities: identity ? [{
        effect_id: "git_repo_commit",
        provider: "github",
        resource_kind: "github_pull_request",
        target_ids: [`${identity.owner}/${identity.repo}#${identity.pull_request_number}`],
        identity,
      }] : [],
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function errorJsonReplacer(_key, value) {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return value;
}
