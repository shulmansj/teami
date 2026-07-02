import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import {
  decideReadyIssue,
  gatewayPollTargets,
  gatewayState,
  pollGatewayDomain,
  processReadyIssue,
  sweepIssueReplayMarker,
} from "../src/gateway-loop.mjs";
import { renderResourceTargetBlock } from "../src/resource-target.mjs";

const WORK_TYPE_CODE_LABEL_ID = "label-code";
const WORK_TYPE_NON_CODE_LABEL_ID = "label-non-code";

test("Ready descriptor registers after the project descriptor with issue id in-flight keys", () => {
  const targets = gatewayPollTargets();
  const plannedIndex = targets.findIndex((descriptor) => descriptor.input_status === "Planned");
  const readyIndex = targets.findIndex((descriptor) => descriptor.input_status === "Ready");

  assert.notEqual(plannedIndex, -1, "planned project descriptor remains registered");
  assert.notEqual(readyIndex, -1, "Ready issue descriptor is registered");
  assert.equal(plannedIndex, 0, "project decomposition remains the first polled descriptor");
  assert.ok(readyIndex > plannedIndex, "Ready issue polling must not precede project polling");
  assert.equal(targets[readyIndex].inFlightKey({ id: "issue-1" }), "issue-1");
});

test("dependency-blocked Ready issues are not suppressed and run after the blocker reaches Done", async () => {
  const issueId = "issue-dependent";
  const blocked = readyIssue({
    id: issueId,
    blockerStateType: "started",
  });
  const unblocked = readyIssue({
    id: issueId,
    blockerStateType: "completed",
  });
  let suppressionReads = 0;
  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: blocked,
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => {
        suppressionReads += 1;
        return { reason: "must_not_suppress_blocked" };
      },
    },
  });

  assert.equal(decision.action, "dependency_blocked");
  assert.deepEqual(decision.blockingIssueIds, ["issue-blocker"]);
  assert.equal(suppressionReads, 0, "blocked issues must not consult suppression");

  const contexts = [blocked, unblocked];
  const suppressionWrites = [];
  let freshRuns = 0;
  const state = gatewayState();
  const options = {
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    state,
    client: {
      async getIssueContext(id) {
        assert.equal(id, issueId);
        return structuredClone(contexts.shift() || unblocked);
      },
    },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => {
        suppressionReads += 1;
        return null;
      },
      writeSuppression: async (input) => {
        suppressionWrites.push(input);
        return input;
      },
    },
    runFreshIssue: async () => {
      freshRuns += 1;
      return { status: "completed", wake: { run_id: "run-issue" } };
    },
    runTimeoutMs: 0,
  };

  const first = await processReadyIssue(options);
  assert.equal(first.action, "skipped");
  assert.equal(first.reason, "dependency_blocked");
  assert.equal(freshRuns, 0);
  assert.equal(suppressionWrites.length, 0);
  assert.equal(state.inFlight.has(issueId), false);

  const second = await processReadyIssue(options);
  assert.equal(second.action, "fresh");
  assert.equal(second.status, "started");
  assert.equal(freshRuns, 1);
  await flushAsync();
  assert.equal(state.inFlight.has(issueId), false);
  assert.equal(suppressionWrites.length, 0);
});

test("a Ready issue with a git replay marker replays instead of starting a fresh run", async () => {
  const issueId = "issue-open-pr";
  const pending = {
    domainId: "domain-1",
    objectId: issueId,
    runId: "run-open-pr",
    artifactKind: "commit",
    git: {
      owner: "acme",
      repo: "product",
      branch: "af/execution/AF-1-5215fde5",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    },
  };
  const replayCalls = [];
  let freshRuns = 0;
  let suppressionReads = 0;
  const state = gatewayState();

  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    candidate: { id: issueId },
    state,
    client: {
      async getIssueContext() {
        return readyIssue({ id: issueId });
      },
    },
    idempotency: {
      readGitReplayPending: async (input) => {
        assert.deepEqual(input.objectId, issueId);
        return pending;
      },
      readSuppression: async () => {
        suppressionReads += 1;
        return null;
      },
    },
    runReplayIssue: async (input) => {
      replayCalls.push(input);
      return { status: "completed", run: { run_id: pending.runId } };
    },
    runFreshIssue: async () => {
      freshRuns += 1;
      throw new Error("fresh execution must not run when a marker is present");
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "replay");
  assert.equal(result.status, "started");
  assert.equal(freshRuns, 0);
  assert.equal(suppressionReads, 0);
  assert.equal(replayCalls.length, 1);
  assert.equal(replayCalls[0].pending, pending);
  assert.equal(replayCalls[0].retry, true);
  await flushAsync();
  assert.equal(state.inFlight.has(issueId), false);
});

test("Ready fix-mode chooses warm_resume before retained replay markers", async () => {
  const issueId = "issue-fix-mode";
  const adapter = createReadyFixPrAdapter();
  let replayReads = 0;
  let suppressionReads = 0;

  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    fingerprint: "a".repeat(64),
    repoIdentity: repoIdentityFixture(),
    store: storeWithPriorRun(issueId),
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        replayReads += 1;
        return { runId: "run-replay-marker" };
      },
      readSuppression: async () => {
        suppressionReads += 1;
        return null;
      },
    },
  });

  assert.deepEqual(decision, {
    action: "warm_resume",
    prNumber: 7,
    head_sha: HEAD_SHA,
    priorRunId: "run-prior",
  });
  assert.equal(replayReads, 0, "warm fix-mode must run before replay marker reads");
  assert.equal(suppressionReads, 0, "warm fix-mode must run before suppression reads");
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    "listPullRequestsForHead",
    "getPullRequest",
    "getCommitStatuses",
    "listPullRequestComments",
  ]);
});

test("Ready fix-mode escalates when verified review-failure rounds exceed the configured bound", async () => {
  const issueId = "issue-round-bound";
  const priorHeadSha = "c".repeat(40);
  const adapter = createReadyFixPrAdapter({
    statusesByHead: {
      [HEAD_SHA]: [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-28T10:10:00.000Z",
      }],
      [priorHeadSha]: [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-28T09:10:00.000Z",
      }],
    },
    comments: [
      {
        id: "comment-prior",
        user: { type: "Bot" },
        body: formatAfReviewCommentBody({
          body: "Prior failed review round.",
          disposition: "request-changes",
          head_sha: priorHeadSha,
          run_id: "run-review-prior",
        }),
        created_at: "2026-06-28T09:11:00.000Z",
      },
      {
        id: "comment-current",
        user: { type: "Bot" },
        body: formatAfReviewCommentBody({
          body: "Current failed review round.",
          disposition: "request-changes",
          head_sha: HEAD_SHA,
          run_id: "run-review-current",
        }),
        created_at: "2026-06-28T10:11:00.000Z",
      },
    ],
  });

  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    fingerprint: "a".repeat(64),
    config: {
      workflows: {
        review: {
          max_autonomous_fix_rounds: 1,
        },
      },
    },
    repoIdentity: repoIdentityFixture(),
    store: storeWithPriorRun(issueId),
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("over-bound fix-mode must escalate before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ready_fix_review_round_bound_exceeded");
  assert.equal(decision.roundState.count, 2);
  assert.equal(decision.roundState.max, 1);
  assert.deepEqual(new Set(decision.roundState.head_shas), new Set([HEAD_SHA, priorHeadSha]));
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    "listPullRequestsForHead",
    "getPullRequest",
    "getCommitStatuses",
    "listPullRequestComments",
    "getCommitStatuses",
  ]);
  assert.equal(adapter.calls.at(-1).head_sha, priorHeadSha);
});

test("processReadyIssue moves an over-bound ready fix to needs_principal", async () => {
  const issueId = "issue-round-bound-move";
  const priorHeadSha = "c".repeat(40);
  const issue = readyIssue({ id: issueId });
  const updates = [];
  const adapter = createReadyFixPrAdapter({
    statusesByHead: {
      [HEAD_SHA]: [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-28T10:10:00.000Z",
      }],
      [priorHeadSha]: [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-28T09:10:00.000Z",
      }],
    },
    comments: [
      {
        id: "comment-prior",
        body: formatAfReviewCommentBody({
          body: "Prior failed review round.",
          disposition: "request-changes",
          head_sha: priorHeadSha,
          run_id: "run-review-prior",
        }),
        created_at: "2026-06-28T09:11:00.000Z",
      },
      {
        id: "comment-current",
        body: formatAfReviewCommentBody({
          body: "Current failed review round.",
          disposition: "request-changes",
          head_sha: HEAD_SHA,
          run_id: "run-review-current",
        }),
        created_at: "2026-06-28T10:11:00.000Z",
      },
    ],
  });

  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextWithRepoFixture(),
    config: configWithNeedsPrincipalAndReviewBound(1),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    client: {
      async getIssueContext(id) {
        assert.equal(id, issueId);
        return issue;
      },
      async listWorkflowStates(teamId) {
        assert.equal(teamId, "team-1");
        return [
          { id: "state-ready", name: "Ready", type: "unstarted" },
          { id: "state-blocked", name: "Blocked", type: "started" },
        ];
      },
      async findIssueLabelsByName(name, teamId) {
        assert.equal(name, null);
        assert.equal(teamId, "team-1");
        return [
          { id: "label-needs-principal", name: "Needs Principal", teamId },
        ];
      },
      async updateIssue(id, input) {
        updates.push({ id, input });
        issue.state = { id: input.stateId, name: "Blocked", type: "started" };
        issue.labels = input.labelIds.map((labelId) => ({ id: labelId }));
        return issue;
      },
    },
    store: storeWithPriorRun(issueId),
    runDeps: { prAdapter: adapter },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("over-bound ready fix escalation must run before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "ready_fix_review_round_bound_exceeded");
  assert.equal(result.escalation.outcome, "ok");
  assert.deepEqual(updates, [{
    id: issueId,
    input: { stateId: "state-blocked", labelIds: ["label-needs-principal"] },
  }]);
});

test("Ready fix-mode escalates on the first persisted paused warm-resume run", async () => {
  const issueId = "issue-paused-resume";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-paused-resume-"));
  writePausedResumeArtifact(tempRoot, {
    runId: "run-prior",
    issueId,
    headSha: HEAD_SHA,
  });
  const adapter = githubProbeMustNotRun();

  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    fingerprint: "a".repeat(64),
    repoRoot: tempRoot,
    repoIdentity: repoIdentityFixture(),
    store: storeWithPriorRun(issueId),
    prAdapter: adapter,
    resolveSessionHandle: () => {
      throw new Error("paused warm-resume runs must escalate before session resolution");
    },
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("paused warm-resume runs must escalate before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ready_fix_resume_paused");
  assert.deepEqual(decision.resumeRecord, {
    resume_status: "paused",
    terminal_outcome: "pause",
    head_sha: HEAD_SHA,
    prior_run_id: "run-before-pause",
  });
  assert.deepEqual(adapter.calls, undefined);
});

test("Ready issues with no prior execution run do not probe GitHub and remain fresh", async () => {
  const issueId = "issue-no-prior-run";
  let replayReads = 0;
  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoIdentity: repoIdentityFixture(),
    store: {
      findLatestRunForObject(id) {
        assert.equal(id, issueId);
        return null;
      },
    },
    prAdapter: githubProbeMustNotRun(),
    idempotency: {
      readGitReplayPending: async () => {
        replayReads += 1;
        return null;
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "fresh");
  assert.equal(replayReads, 1);
});

test("Ready code issue resource routing is emitted through the gateway trace sink", async () => {
  const issueId = "issue-wrong-resource";
  const traceSink = recordingTraceSink();
  const decision = await decideReadyIssue({
    domainId: "domain-1",
    issueId,
    issueContext: readyIssue({
      id: issueId,
      description: descriptionWithResourceTarget({ kind: "git_repo", id: "repo-3" }),
      labels: [{ id: WORK_TYPE_CODE_LABEL_ID, name: "Code" }],
    }),
    domainContext: domainContextWithAllowedRepoPacket(),
    config: configWithReadyStatusAndWorkTypeLabels(),
    cache: linearCacheWithWorkTypeLabels(),
    fingerprint: "a".repeat(64),
    traceSink,
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => {
        throw new Error("resource-invalid issues must not reach suppression reads");
      },
    },
  });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "resource_target_not_allowed");

  const finishRun = traceSink.events.find((event) => event.type === "finishRun")?.input;
  assert.ok(finishRun, "ready eligibility trace must be finished");
  assert.equal(finishRun.result.status, "rejected");
  assert.equal(finishRun.result.reason, "resource_target_not_allowed");
  const span = finishRun.result.trace.spans.find((candidate) => candidate.name === "ready_issue_eligibility");
  assert.ok(span, "ready_issue_eligibility span must be emitted");
  assert.equal(span.attributes.issue_id, issueId);
  assert.equal(span.attributes.work_type, "code");
  assert.equal(span.attributes.chosen_resource_id, "repo-3");
  assert.deepEqual(span.attributes.allowed_resource_ids, ["repo-1", "repo-2"]);
  assert.equal(span.attributes.reason, "resource_target_not_allowed");
});

test("Ready fix-mode escalates prior-run issues when the execution PR is closed or missing", async (t) => {
  const cases = [
    {
      name: "closed",
      adapter: createReadyFixPrAdapter({ prState: "closed" }),
      reason: "ready_fix_pr_closed",
    },
    {
      name: "missing",
      adapter: createReadyFixPrAdapter({ pullRequests: [] }),
      reason: "ready_fix_pr_missing",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const issueId = `issue-pr-${entry.name}`;
      const decision = await decideReadyIssue({
        domainId: "domain-1",
        issueId,
        issueContext: readyIssue({ id: issueId }),
        fingerprint: "a".repeat(64),
        repoIdentity: repoIdentityFixture(),
        store: storeWithPriorRun(issueId),
        prAdapter: entry.adapter,
        resolveSessionHandle: () => ({ id: "driver-session-prior" }),
        idempotency: {
          readGitReplayPending: async () => {
            throw new Error("closed/missing fix-mode PRs must escalate before replay");
          },
          readSuppression: async () => null,
        },
      });

      assert.equal(decision.action, "escalate");
      assert.equal(decision.reason, entry.reason);
      assert.equal(decision.priorRunId, "run-prior");
    });
  }
});

test("processReadyIssue dispatches warm_resume without reaching fresh execution", async () => {
  const issueId = "issue-warm-dispatch";
  const adapter = createReadyFixPrAdapter();
  const warmCalls = [];
  let freshRuns = 0;
  let replayRuns = 0;
  const state = gatewayState();

  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextWithRepoFixture(),
    candidate: { id: issueId },
    state,
    client: {
      async getIssueContext(id) {
        assert.equal(id, issueId);
        return readyIssue({ id });
      },
    },
    store: storeWithPriorRun(issueId),
    runDeps: { prAdapter: adapter },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("warm_resume must run before replay");
      },
      readSuppression: async () => null,
    },
    runReplayIssue: async () => {
      replayRuns += 1;
      throw new Error("warm_resume must not run replay execution");
    },
    runFreshIssue: async () => {
      freshRuns += 1;
      throw new Error("warm_resume must not run fresh execution");
    },
    runWarmResumeIssue: async (input) => {
      warmCalls.push(input);
      return { status: "completed", run: { run_id: "run-fix" } };
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "warm_resume");
  assert.equal(result.status, "started");
  assert.equal(result.issueId, issueId);
  assert.equal(result.decision.priorRunId, "run-prior");
  assert.equal(freshRuns, 0);
  assert.equal(replayRuns, 0);

  await flushAsync();
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].issueId, issueId);
  assert.equal(warmCalls[0].priorRunId, "run-prior");
  assert.equal(warmCalls[0].prNumber, 7);
  assert.equal(warmCalls[0].head_sha, HEAD_SHA);
  assert.equal(freshRuns, 0);
  assert.equal(replayRuns, 0);
  assert.equal(state.inFlight.has(issueId), false);
});

test("In Progress fix-mode cold-reconstructs when the local run store is empty", async () => {
  const issueId = "issue-cold-reconstruct";
  const adapter = createReadyFixPrAdapter();
  const warmCalls = [];
  const state = gatewayState();
  const inProgressTarget = gatewayPollTargets().find((target) => target.input_status === "In Progress");

  const result = await inProgressTarget.process(
    { id: issueId },
    {
      domain: domainFixture(),
      domainContext: domainContextWithRepoFixture(),
      candidate: { id: issueId },
      state,
      client: {
        async getIssueContext(id) {
          assert.equal(id, issueId);
          return readyIssue({ id });
        },
      },
      store: {
        findLatestRunForObject(id) {
          assert.equal(id, issueId);
          return null;
        },
      },
      runDeps: { prAdapter: adapter },
      runWarmResumeIssue: async (input) => {
        warmCalls.push(input);
        return { status: "completed", run: { run_id: "run-cold" } };
      },
      runTimeoutMs: 0,
    },
  );

  assert.equal(result.action, "warm_resume");
  assert.equal(result.status, "started");
  assert.equal(result.decision.resumeMode, "cold_reconstruct");
  assert.equal(result.decision.coldReconstructReason, "ready_fix_prior_run_missing");
  assert.equal(result.decision.prNumber, 7);
  assert.equal(result.decision.head_sha, HEAD_SHA);
  assert.equal(result.decision.branch, "af/execution/AF-1-5215fde5");
  assert.equal(result.decision.durableIdentity.resource_id, "repo-1");

  await flushAsync();
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].warmResumeDecision.resumeMode, "cold_reconstruct");
  assert.equal(warmCalls[0].prNumber, 7);
  assert.equal(warmCalls[0].head_sha, HEAD_SHA);
  assert.equal(state.inFlight.has(issueId), false);
});

test("Ready issue deterministic git failures write suppression after current-state re-read", async () => {
  const issueId = "issue-empty-diff";
  const writes = [];
  const contexts = [readyIssue({ id: issueId }), readyIssue({ id: issueId })];
  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    client: {
      async getIssueContext(id) {
        assert.equal(id, issueId);
        return structuredClone(contexts.shift() || readyIssue({ id }));
      },
    },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
      writeSuppression: async (input) => {
        writes.push(input);
        return input;
      },
    },
    runFreshIssue: async () => ({
      status: "rejected",
      reason: "git_repo_empty_diff",
      wake: { run_id: "run-empty" },
    }),
    now: () => new Date("2026-06-26T12:00:00.000Z"),
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "fresh");
  await flushAsync();
  assert.equal(contexts.length, 0, "suppression must re-read current issue state before writing");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].objectType, "issue");
  assert.equal(writes[0].objectId, issueId);
  assert.equal(writes[0].terminalStatus, "rejected");
  assert.equal(writes[0].reason, "git_repo_empty_diff");
  assert.equal(writes[0].runId, "run-empty");
  assert.equal(writes[0].createdAt, "2026-06-26T12:00:00.000Z");
});

test("claimed In Progress issue deterministic git failures still write suppression", async () => {
  const issueId = "issue-claimed-empty-diff";
  const writes = [];
  const contexts = [
    readyIssue({ id: issueId }),
    readyIssue({
      id: issueId,
      state: { id: "state-in-progress", name: "In Progress", type: "started" },
    }),
  ];
  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    client: {
      async getIssueContext(id) {
        assert.equal(id, issueId);
        return structuredClone(contexts.shift() || readyIssue({ id }));
      },
    },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
      writeSuppression: async (input) => {
        writes.push(input);
        return input;
      },
    },
    runFreshIssue: async () => ({
      status: "rejected",
      reason: "git_repo_empty_diff",
      wake: { run_id: "run-claimed-empty" },
    }),
    now: () => new Date("2026-06-26T12:30:00.000Z"),
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "fresh");
  await flushAsync();
  assert.equal(contexts.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].objectId, issueId);
  assert.equal(writes[0].runId, "run-claimed-empty");
  assert.equal(writes[0].createdAt, "2026-06-26T12:30:00.000Z");
});

test("project polling still runs first and issue dispatch does not block the descriptor loop", async () => {
  const calls = [];
  const state = gatewayState();
  const issueRun = deferred();
  const repoRoot = tempRepo();
  writeDomainCache(repoRoot);
  const result = await pollGatewayDomain({
    repoRoot,
    config: configWithReadyStatus(),
    registry: registryFixture(),
    domain: domainFixture(),
    state,
    idempotency: {
      listGitReplayPending: async () => [],
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    createLinearClient: async () => ({
      async listPlannedProjectCandidates() {
        calls.push("project-list");
        return {
          candidates: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      async listWorkflowStates(teamId) {
        calls.push(`state-list:${teamId}`);
        return [{ id: "state-todo", name: "Todo", type: "unstarted" }];
      },
      async listReadyIssueCandidates(teamId, page) {
        calls.push(`ready-list:${teamId}:${page.readyStateId}`);
        if (page.readyStateId !== "state-todo") {
          return {
            candidates: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }
        return {
          candidates: [readyIssue({ id: "issue-1", createdAt: "2026-06-25T10:00:00.000Z" })],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      async getIssueContext(issueId) {
        calls.push(`issue-context:${issueId}`);
        return readyIssue({ id: issueId });
      },
    }),
    runFreshIssue: async ({ issueId }) => {
      calls.push(`fresh-run:${issueId}`);
      return issueRun.promise;
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.processed, [{
    action: "fresh",
    status: "started",
    issueId: "issue-1",
    fingerprint: result.processed[0].fingerprint,
  }]);
  assert.deepEqual(calls, [
    "project-list",
    "ready-list:team-1:state-todo",
    "issue-context:issue-1",
    "fresh-run:issue-1",
    "ready-list:team-1:state-in-progress",
    "ready-list:team-1:state-in-review",
  ]);
  assert.equal(state.inFlight.has("issue-1"), true, "background dispatch holds the issue in-flight key");

  issueRun.resolve({ status: "completed", wake: { run_id: "run-1" } });
  await flushAsync();
  assert.equal(state.inFlight.has("issue-1"), false);
});

test("maxInFlight gate prevents overlapping Ready issue execution", async () => {
  const state = gatewayState({ inFlight: new Set(["issue-active"]), maxInFlight: 1 });
  const result = await processReadyIssue({
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    candidate: { id: "issue-queued" },
    state,
    client: {
      async getIssueContext() {
        throw new Error("in-flight gate must run before issue context reads");
      },
    },
    runFreshIssue: async () => {
      throw new Error("in-flight gate must prevent execution dispatch");
    },
  });

  assert.deepEqual(result, {
    action: "skipped",
    reason: "max_in_flight",
    issueId: "issue-queued",
  });
  assert.deepEqual([...state.inFlight], ["issue-active"]);
});

test("marker sweep clears issue git replay markers only after Linear reports completed", async () => {
  const cleared = [];
  const client = {
    async getIssueContext(issueId) {
      return issueId === "issue-done"
        ? readyIssue({ id: issueId, state: { id: "state-done", name: "Done", type: "completed" } })
        : readyIssue({ id: issueId, state: { id: "state-review", name: "In Review", type: "started" } });
    },
  };
  const idempotency = {
    clearMutationIntent: async (input) => {
      cleared.push(input);
      return { cleared: true };
    },
  };

  const retained = await sweepIssueReplayMarker({
    domain: domainFixture(),
    client,
    marker: { objectId: "issue-review", runId: "run-review" },
    idempotency,
  });
  const done = await sweepIssueReplayMarker({
    domain: domainFixture(),
    client,
    marker: { objectId: "issue-done", runId: "run-done" },
    idempotency,
  });

  assert.equal(retained.status, "retained");
  assert.equal(retained.stateType, "started");
  assert.equal(done.status, "cleared");
  assert.deepEqual(cleared, [{
    domainId: "domain-1",
    objectType: "issue",
    objectId: "issue-done",
    runId: "run-done",
    repoRoot: process.cwd(),
    runStoreDir: null,
  }]);
});

const HEAD_SHA = "b".repeat(40);

function repoIdentityFixture() {
  return {
    owner: "acme",
    repo: "product",
    default_branch: "main",
  };
}

function domainContextWithRepoFixture() {
  return {
    ...domainContextFixture(),
    resources: [{
      id: "repo-1",
      kind: "git_repo",
      role: "target",
      binding: {
        owner: "acme",
        repo: "product",
        default_branch: "main",
      },
    }],
  };
}

function storeWithPriorRun(issueId) {
  return {
    findLatestRunForObject(id) {
      assert.equal(id, issueId);
      return {
        run_id: "run-prior",
        object_id: issueId,
        workflow_type: "execution",
        status: "completed",
        started_at: "2026-06-28T10:00:00.000Z",
        terminal_at: "2026-06-28T10:05:00.000Z",
        session_handle_pointer: {
          source: "run_artifact.runtime_metadata",
          runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
        },
      };
    },
  };
}

function writePausedResumeArtifact(repoRoot, {
  runId,
  issueId,
  headSha,
} = {}) {
  const terminalOutput = {
    outcome: "pause",
    reason: "reviewer_notes_disagreement",
    context_digest: "Warm resume paused because reviewer notes need human arbitration.",
    source_refs: [],
    assumptions: [],
    constraints: [],
    risks: [],
  };
  const resume = {
    resume_status: "paused",
    terminal_outcome: "pause",
    head_sha: headSha,
    prior_run_id: "run-before-pause",
  };
  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: "test-execution",
    workflow_version: "test-execution",
    kind: "pause",
    run_id: runId,
    domain_id: "domain-1",
    workspace_id: "workspace-1",
    team_id: "team-1",
    linear_issue_id: issueId,
    terminal_output: terminalOutput,
    evidence: { perspectives_run: [] },
    bounds: { rounds_used: 1, max_rounds: 99 },
    environment: {},
    runtime_assignments: {},
    runtime_metadata: {},
    payload_schema_id: "teami-flat-run-payload/v1",
    payload: {
      terminal_output: terminalOutput,
      linear_issue_id: issueId,
      resume,
      pause_packet: {},
    },
    pause_packet: {},
    resume,
  };
  const runDir = path.join(repoRoot, ".teami", "runs");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${runId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function createReadyFixPrAdapter({
  prState = "open",
  pullRequests = null,
  statuses = null,
  statusesByHead = null,
  comments = null,
} = {}) {
  const calls = [];
  const branch = branchNameForIssue("AF-1");
  const prs = pullRequests || [{
    number: 7,
    state: prState,
    base: "main",
    head_sha: HEAD_SHA,
  }];
  const statusList = statuses || [{
    context: AF_REVIEW_STATUS_CONTEXT,
    state: "failure",
    created_at: "2026-06-28T10:10:00.000Z",
  }];
  const commentList = comments || [{
    id: "comment-1",
    body: formatAfReviewCommentBody({
      body: "Needs a fix.",
      disposition: "request-changes",
      head_sha: HEAD_SHA,
      run_id: "run-review",
    }),
    created_at: "2026-06-28T10:11:00.000Z",
  }];

  return {
    calls,
    async listPullRequestsForHead(head, { state = "all" } = {}) {
      calls.push({ method: "listPullRequestsForHead", head, state });
      assert.equal(head, branch);
      assert.equal(state, "all");
      return prs.map((pr) => ({ ...pr }));
    },
    async getPullRequest(number) {
      calls.push({ method: "getPullRequest", number });
      const pr = prs.find((candidate) => candidate.number === number);
      if (!pr) throw new Error(`missing_pr:${number}`);
      return {
        number: pr.number,
        state: pr.state,
        base: { ref: pr.base },
        head: { sha: pr.head_sha, ref: branch },
      };
    },
    async getCommitStatuses(head_sha) {
      calls.push({ method: "getCommitStatuses", head_sha });
      if (!statusesByHead) assert.equal(head_sha, HEAD_SHA);
      const headStatuses = statusesByHead?.[head_sha] || statusList;
      return headStatuses.map((status) => ({ ...status }));
    },
    async listPullRequestComments(number) {
      calls.push({ method: "listPullRequestComments", number });
      assert.equal(number, 7);
      return commentList.map((comment) => ({ ...comment }));
    },
  };
}

function githubProbeMustNotRun() {
  return {
    async listPullRequestsForHead() {
      throw new Error("GitHub PR lookup must not run without a prior execution run");
    },
    async getPullRequest() {
      throw new Error("GitHub PR hydration must not run without a prior execution run");
    },
    async getCommitStatuses() {
      throw new Error("GitHub status lookup must not run without a prior execution run");
    },
    async listPullRequestComments() {
      throw new Error("GitHub comment lookup must not run without a prior execution run");
    },
  };
}

function readyIssue({
  id = "issue-1",
  createdAt = "2026-06-25T10:00:00.000Z",
  state = { id: "state-todo", name: "Todo", type: "unstarted" },
  blockerStateType = null,
  description = "- Decomposition key: issue-key\n\nDo the work.",
  labels = [],
} = {}) {
  return {
    id,
    identifier: "AF-1",
    title: "Todo execution issue",
    description,
    url: `https://linear.test/${id}`,
    createdAt,
    team: { id: "team-1", key: "AF", name: "Teami" },
    project: { id: "project-1", name: "Project", url: "https://linear.test/project-1" },
    assignee: null,
    labels,
    state,
    relations: blockerStateType
      ? [{
          id: "relation-1",
          type: "blocks",
          issue: {
            id: "issue-blocker",
            identifier: "AF-0",
            title: "Blocker",
            state: { type: blockerStateType },
          },
          relatedIssue: {
            id,
            identifier: "AF-1",
            title: "Dependent",
            state: { type: state.type },
          },
        }]
      : [],
  };
}

function registryFixture() {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [domainFixture()],
  };
}

function domainFixture() {
  return makeDomainRecord({
    domainId: "domain-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
    webhookId: "webhook-1",
  });
}

function domainContextFixture() {
  return {
    domainId: "domain-1",
    status: "active",
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "AF",
      teamName: "Teami",
      webhookId: "webhook-1",
      cachePath: "unused",
    },
    trace: {
      domain_id: "domain-1",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
    },
  };
}

function domainContextWithAllowedRepoPacket() {
  return {
    ...domainContextFixture(),
    allowedRepoPacket: allowedRepoPacketFixture(),
  };
}

function allowedRepoPacketFixture() {
  return [
    {
      resource_id: "repo-1",
      owner: "acme",
      repo: "product",
      default_branch: "main",
    },
    {
      resource_id: "repo-2",
      owner: "acme",
      repo: "website",
      default_branch: "main",
    },
  ];
}

function configWithReadyStatus() {
  return {
    poll: { interval_ms: 10_000 },
    linear: {
      oauth: {
        credential_storage: "file",
        client_id: "client-id",
        redirect_uri: "http://localhost/callback",
      },
      team: { key: "AF", name: "Teami" },
      issue: {
        labels: {
          discovery: "Discovery",
          needs_principal: "Needs Principal",
        },
        statuses: {
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          blocked: { name: "Blocked", type: "started" },
          done: { name: "Done", type: "completed" },
        },
      },
    },
  };
}

function configWithReadyStatusAndWorkTypeLabels() {
  const config = configWithReadyStatus();
  config.linear.issue.labels.work_type_code = "Code";
  config.linear.issue.labels.work_type_non_code = "Non-code";
  return config;
}

function configWithNeedsPrincipalAndReviewBound(maxAutonomousFixRounds) {
  return {
    linear: {
      issue: {
        labels: {
          needs_principal: "Needs Principal",
        },
        statuses: {
          blocked: { name: "Blocked", type: "started" },
        },
      },
    },
    workflows: {
      review: {
        max_autonomous_fix_rounds: maxAutonomousFixRounds,
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function linearCacheFixture() {
  return {
    teamId: "team-1",
    issueStatuses: {
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      blocked: "state-blocked",
      done: "state-done",
    },
    projectStatuses: {
      planned: "status-planned",
    },
    issueLabels: {
      Discovery: "label-discovery",
      "Needs Principal": "label-needs-principal",
    },
  };
}

function linearCacheWithWorkTypeLabels() {
  const cache = linearCacheFixture();
  cache.issueLabels.Code = WORK_TYPE_CODE_LABEL_ID;
  cache.issueLabels["Non-code"] = WORK_TYPE_NON_CODE_LABEL_ID;
  return cache;
}

function descriptionWithResourceTarget(resourceTarget) {
  return [
    "- Decomposition key: issue-key",
    "",
    renderResourceTargetBlock(resourceTarget).trimEnd(),
    "Do the work.",
  ].join("\n");
}

function recordingTraceSink() {
  const events = [];
  return {
    events,
    async startRun(input) {
      events.push({ type: "startRun", input });
      return {
        ok: true,
        traceId: "trace-ready-eligibility",
        run: {
          run_id: input.runId,
          domain_id: input.wake?.domain_id || null,
          workspace_id: input.wake?.workspace_id || null,
          team_id: input.wake?.team_id || null,
          workflow_type: input.wake?.workflow_type || null,
        },
      };
    },
    async finishRun(input) {
      events.push({ type: "finishRun", input });
      return {
        status: "trace_exported",
        traceId: input.session?.traceId || null,
      };
    },
  };
}

function writeDomainCache(repoRoot) {
  writeLinearCache(
    path.join(repoRoot, ".teami", "domains", "domain-1", "linear.json"),
    linearCacheFixture(),
  );
}

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-ready-poll-"));
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
