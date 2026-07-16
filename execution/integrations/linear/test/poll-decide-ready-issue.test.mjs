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
import { TEAM_REGISTRY_SCHEMA_VERSION, makeTeamRecord } from "../src/team-registry.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import {
  decideReadyIssue,
  gatewayPollTargets,
  gatewayState,
  pollGatewayTeam,
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
    teamRef: "team-1",
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
    team: teamFixture(),
    teamContext: teamContextFixture(),
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
    teamRef: "team-1",
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
    team: teamFixture(),
    teamContext: teamContextFixture(),
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
    teamRef: "team-1",
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
    resumeContextProvenanceTag: "af_review_failure_marker",
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

test("Ready fix-mode resumes a Todo send-back even when the current review check is green", async () => {
  const issueId = "issue-green-send-back";
  const adapter = createReadyFixPrAdapter({
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  let replayReads = 0;

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    fingerprint: "a".repeat(64),
    cache: linearCacheFixture(),
    repoIdentity: repoIdentityFixture(),
    store: storeWithPriorRun(issueId),
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        replayReads += 1;
        return { runId: "run-replay-marker" };
      },
      readSuppression: async () => null,
    },
  });

  assert.deepEqual(decision, {
    action: "warm_resume",
    prNumber: 7,
    head_sha: HEAD_SHA,
    priorRunId: "run-prior",
    resumeContextProvenanceTag: "linear_todo_reentry",
  });
  assert.equal(replayReads, 0, "green send-back fix-mode must run before replay marker reads");
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    "listPullRequestsForHead",
    "getPullRequest",
    "getCommitStatuses",
  ]);
});

test("processReadyIssue dispatches a green-check Todo send-back to warm_resume", async () => {
  const issueId = "issue-green-warm-dispatch";
  const adapter = createReadyFixPrAdapter({
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  const warmCalls = [];
  let freshRuns = 0;

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
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
        throw new Error("green send-back must warm-resume before replay");
      },
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      freshRuns += 1;
      throw new Error("green send-back must not start fresh execution");
    },
    runWarmResumeIssue: async (input) => {
      warmCalls.push(input);
      return { status: "completed", run: { run_id: "run-fix" } };
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "warm_resume");
  assert.equal(result.status, "started");
  assert.equal(result.decision.resumeContextProvenanceTag, "linear_todo_reentry");
  assert.equal(freshRuns, 0);
  await flushAsync();
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].warmResumeDecision.resumeContextProvenanceTag, "linear_todo_reentry");
  assert.equal(warmCalls[0].prNumber, 7);
  assert.equal(warmCalls[0].head_sha, HEAD_SHA);
});

test("Ready fix-mode resolves the produced PR when a discarded PR makes branch discovery ambiguous", async () => {
  const issueId = "issue-produced-first";
  const branch = branchNameForIssue("AF-1");
  const adapter = createReadyFixPrAdapter({
    pullRequests: [
      { number: 6, state: "closed", base: "main", head_sha: "e".repeat(40) },
      { number: 7, state: "open", base: "main", head_sha: HEAD_SHA },
    ],
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  const store = {
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
        artifact: {
          produced_identities: [{
            resource_kind: "github_pull_request",
            identity: {
              resource_id: "repo-1",
              owner: "acme",
              repo: "product",
              branch,
              pull_request_number: 7,
              head_sha: HEAD_SHA,
            },
          }],
        },
      };
    },
  };

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoIdentity: repoIdentityFixture(),
    store,
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("produced-first fix-mode must decide before replay reads");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "warm_resume");
  assert.equal(decision.prNumber, 7);
  assert.equal(decision.head_sha, HEAD_SHA);
  assert.equal(decision.priorRunId, "run-prior");
  assert.equal(
    adapter.calls.some((call) => call.method === "listPullRequestsForHead"),
    false,
    "the produced PR identity must resolve without ambiguous branch-name discovery",
  );
});

test("Ready fix-mode walks past a non-producing failed resume run to the produced PR identity", async () => {
  const issueId = "issue-produced-walk-back";
  const branch = branchNameForIssue("AF-1");
  const producingRun = {
    run_id: "run-producing",
    object_id: issueId,
    workflow_type: "execution",
    status: "completed",
    started_at: "2026-06-28T10:00:00.000Z",
    terminal_at: "2026-06-28T10:05:00.000Z",
    artifact: {
      produced_identities: [{
        resource_kind: "github_pull_request",
        identity: {
          resource_id: "repo-1",
          owner: "acme",
          repo: "product",
          branch,
          pull_request_number: 7,
          head_sha: HEAD_SHA,
        },
      }],
    },
  };
  const deadLetterRun = {
    run_id: "run-dead-letter",
    object_id: issueId,
    workflow_type: "execution",
    status: "dead_letter",
    terminal_reason: "runner_failed_after_execution_mutation_started:example",
    started_at: "2026-06-28T11:00:00.000Z",
    terminal_at: "2026-06-28T11:00:30.000Z",
  };
  const adapter = githubProbeMustNotRun();
  const store = {
    findLatestRunForObject(id) {
      assert.equal(id, issueId);
      return structuredClone(deadLetterRun);
    },
    findRunsForObject(id) {
      assert.equal(id, issueId);
      return [structuredClone(deadLetterRun), structuredClone(producingRun)];
    },
  };

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoIdentity: repoIdentityFixture(),
    store,
    prAdapter: adapter,
    resolveSessionHandle: () => {
      throw new Error("a non-resumable dead-letter run must escalate before session resolution");
    },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ready_fix_prior_run_not_resumable");
  assert.equal(
    decision.hasPr,
    true,
    "the produced PR behind the dead-letter run must count as surviving work, not fall to ambiguous discovery",
  );
});

test("A rejected resume attempt is transparent to the ready-fix decide", async () => {
  const issueId = "issue-rejected-transparent";
  const branch = branchNameForIssue("AF-1");
  const producingRun = {
    run_id: "run-producing",
    object_id: issueId,
    workflow_type: "execution",
    status: "completed",
    started_at: "2026-06-28T10:00:00.000Z",
    terminal_at: "2026-06-28T10:05:00.000Z",
    session_handle_pointer: {
      source: "run_artifact.runtime_metadata",
      runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
    },
    artifact: {
      produced_identities: [{
        resource_kind: "github_pull_request",
        identity: {
          resource_id: "repo-1",
          owner: "acme",
          repo: "product",
          branch,
          pull_request_number: 7,
          head_sha: HEAD_SHA,
        },
      }],
    },
  };
  const rejectedResumeRun = {
    run_id: "run-rejected-resume",
    object_id: issueId,
    workflow_type: "execution",
    status: "rejected",
    terminal_reason: "warm_continuation_unavailable",
    started_at: "2026-06-28T11:00:00.000Z",
    terminal_at: "2026-06-28T11:00:30.000Z",
  };
  const adapter = createReadyFixPrAdapter({
    pullRequests: [
      { number: 6, state: "closed", base: "main", head_sha: "e".repeat(40) },
      { number: 7, state: "open", base: "main", head_sha: HEAD_SHA },
    ],
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  const store = {
    findLatestRunForObject(id) {
      assert.equal(id, issueId);
      return structuredClone(rejectedResumeRun);
    },
    findRunsForObject(id) {
      assert.equal(id, issueId);
      return [structuredClone(rejectedResumeRun), structuredClone(producingRun)];
    },
  };

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoIdentity: repoIdentityFixture(),
    store,
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "warm_resume", "a rejected attempt left nothing behind and must not block the resume");
  assert.equal(decision.prNumber, 7);
  assert.equal(decision.head_sha, HEAD_SHA);
  assert.equal(decision.priorRunId, "run-producing");
  assert.equal(decision.resumeContextProvenanceTag, "linear_todo_reentry");
});

test("A warm resume rejected by the branch-ownership fence surfaces on the issue instead of stranding silently", async () => {
  const issueId = "issue-warm-resume-fence-rejected";
  const adapter = createReadyFixPrAdapter({
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  const comments = [];
  const updates = [];
  const statusEvents = [];
  const sentBackIssue = readyIssue({
    id: issueId,
    labels: [{ id: "label-human-review", name: "human-review" }],
  });

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    client: escalationClientFixture({ issueId, comments, updates, issue: sentBackIssue }),
    store: storeWithPriorRun(issueId),
    runDeps: { prAdapter: adapter },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      throw new Error("a fence-rejected resume must not start fresh execution");
    },
    runWarmResumeIssue: async () => ({
      status: "rejected",
      reason: "runner_failed_closed:git_repo_remote_branch_not_owned",
    }),
    emitStatus: (event) => {
      statusEvents.push(event);
      return event;
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "warm_resume");
  assert.equal(result.status, "started");
  await flushAsync();

  assert.equal(updates.length, 1, "the rejection must transition the issue to Needs Principal");
  assert.equal(updates[0].input.stateId, "state-needs-principal");
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].input, "labelIds"), false);
  assert.equal(comments.length, 1, "the rejection must be explained on the issue");
  assert.match(comments[0].body, /branch no longer matches the last state Teami produced/);
  assert.match(comments[0].body, /pull request #7/);
  assert.match(comments[0].body, /runner_failed_closed:git_repo_remote_branch_not_owned/);
  assert.match(comments[0].body, /move this issue back to Todo/);
  assert.ok(
    statusEvents.some((event) => event.state === "resume_attention"),
    "the gateway must report the resume as needing attention",
  );
});

test("A warm resume that fails closed before dispatch surfaces on the issue", async () => {
  const issueId = "issue-warm-resume-failed-closed";
  const adapter = createReadyFixPrAdapter({
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });
  const comments = [];
  const updates = [];

  await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    client: escalationClientFixture({ issueId, comments, updates }),
    store: storeWithPriorRun(issueId),
    runDeps: { prAdapter: adapter },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      throw new Error("a failed-closed resume must not start fresh execution");
    },
    runWarmResumeIssue: async () => ({
      status: "failed_closed",
      reason: "warm_resume_prior_run_session_unresolved",
    }),
    runTimeoutMs: 0,
  });

  await flushAsync();
  assert.equal(updates.length, 1, "the failed-closed resume must transition the issue");
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /warm_resume_prior_run_session_unresolved/);
});

test("Ready fix-mode has no review-round bound across repeated green Todo re-entry cycles", async () => {
  const issueId = "issue-repeated-green-send-back";
  const statusEvents = [];
  const results = [];
  const warmCalls = [];
  const state = gatewayState();

  for (const cycle of [1, 2, 3, 4, 5]) {
    const adapter = createReadyFixPrAdapter({
      statuses: [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "success",
        created_at: `2026-06-28T10:1${cycle}:00.000Z`,
      }],
    });

    const result = await processReadyIssue({
      team: teamFixture(),
      teamContext: teamContextWithRepoFixture(),
      config: configWithReadyStatus(),
      cache: linearCacheFixture(),
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
          throw new Error("green send-back must warm-resume before replay");
        },
        readSuppression: async () => null,
      },
      runFreshIssue: async () => {
        throw new Error("green send-back must not start fresh execution");
      },
      runWarmResumeIssue: async (input) => {
        warmCalls.push({
          cycle,
          priorRunId: input.priorRunId,
          prNumber: input.prNumber,
          head_sha: input.head_sha,
          warmResumeDecision: input.warmResumeDecision,
        });
        return { status: "completed", run: { run_id: `run-fix-${cycle}` } };
      },
      emitStatus: (event) => {
        statusEvents.push(event);
        return event;
      },
      runTimeoutMs: 0,
    });

    results.push(result);
    assert.equal(result.action, "warm_resume");
    assert.equal(result.decision.resumeContextProvenanceTag, "linear_todo_reentry");
    await flushAsync();
    assert.equal(state.inFlight.has(issueId), false);
  }

  assert.equal(warmCalls.length, 5);
  assert.deepEqual(statusEvents.map((event) => event.state), [
    "resume_working",
    "resume_working",
    "resume_working",
    "resume_working",
    "resume_working",
  ]);

  for (const disposition of [...results, ...statusEvents, ...warmCalls]) {
    const serialized = JSON.stringify(disposition);
    assert.doesNotMatch(serialized, /\bover_bound\b/);
    assert.doesNotMatch(serialized, /ready_fix_review_round_bound_exceeded/);
  }
});

test("Ready fix-mode escalates on the first persisted paused warm-resume run", async () => {
  const issueId = "issue-paused-resume";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-paused-resume-"));
  process.env.TEAMI_HOME = tempRoot;
  writePausedResumeArtifact(tempRoot, {
    runId: "run-prior",
    issueId,
    headSha: HEAD_SHA,
  });
  const adapter = githubProbeMustNotRun();

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({
      id: issueId,
      state: { id: "state-in-review", name: "In Review", type: "started" },
    }),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRoot,
    home: tempRoot,
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

test("Ready fix-mode releases paused warm-resume Todo re-entry into the existing resume path", async () => {
  const issueId = "issue-paused-resume-todo-reentry";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-paused-resume-todo-"));
  process.env.TEAMI_HOME = tempRoot;
  writePausedResumeArtifact(tempRoot, {
    runId: "run-prior",
    issueId,
    headSha: HEAD_SHA,
  });
  const adapter = createReadyFixPrAdapter({
    statuses: [{
      context: AF_REVIEW_STATUS_CONTEXT,
      state: "success",
      created_at: "2026-06-28T10:10:00.000Z",
    }],
  });

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRoot,
    home: tempRoot,
    repoIdentity: repoIdentityFixture(),
    store: storeWithPriorRun(issueId),
    prAdapter: adapter,
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("paused Todo re-entry must resume before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.notEqual(decision.action, "escalate");
  assert.notEqual(decision.reason, "ready_fix_resume_paused");
  assert.ok(["warm_resume", "fresh"].includes(decision.action));
});

test("Ready issues with no prior execution run do not probe GitHub and remain fresh", async () => {
  const issueId = "issue-no-prior-run";
  let replayReads = 0;
  const decision = await decideReadyIssue({
    teamRef: "team-1",
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
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({
      id: issueId,
      description: descriptionWithResourceTarget({ kind: "git_repo", id: "repo-3" }),
      labels: [{ id: WORK_TYPE_CODE_LABEL_ID, name: "Code" }],
    }),
    teamContext: teamContextWithAllowedRepoPacket(),
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
      const repoRoot = tempRepo();
      const decision = await decideReadyIssue({
        teamRef: "team-1",
        issueId,
        issueContext: readyIssue({ id: issueId }),
        fingerprint: "a".repeat(64),
        repoRoot,
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

test("Ready fix-mode dispatches fresh when a non-resumable prior run left no surface", async () => {
  const issueId = "issue-no-surface";
  const adapter = createReadyFixPrAdapter({ pullRequests: [] });
  let replayReads = 0;

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRepo(),
    repoIdentity: repoIdentityFixture(),
    store: storeWithNonResumablePriorRun(issueId),
    prAdapter: adapter,
    idempotency: {
      readGitReplayPending: async () => {
        replayReads += 1;
        return null;
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "fresh");
  assert.equal(replayReads, 1, "confirmed-empty fix-mode must fall through to the fresh path");
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    "listPullRequestsForHead",
  ], "absence confirmation must not hydrate PR or review state");
});

test("Ready fix-mode still escalates a non-resumable prior run when its PR exists", async () => {
  const issueId = "issue-surface-pr";
  const adapter = createReadyFixPrAdapter();

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRepo(),
    repoIdentity: repoIdentityFixture(),
    store: storeWithNonResumablePriorRun(issueId),
    prAdapter: adapter,
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("surviving surfaces must escalate before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ready_fix_prior_run_not_resumable");
  assert.equal(decision.priorRunId, "run-prior");
  assert.equal(decision.hasPr, true);
  assert.equal(decision.location.pr.number, 7);
  assert.ok(
    !adapter.calls.some((call) => call.method === "getCommitStatuses"),
    "non-resumable escalation must not inspect review state",
  );
});

test("Ready fix-mode escalates a non-resumable prior run whose artifact records a produced PR", async () => {
  const issueId = "issue-surface-recorded";

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRepo(),
    repoIdentity: repoIdentityFixture(),
    store: storeWithNonResumablePriorRun(issueId, {
      artifact: {
        produced_identities: [{
          resource_kind: "github_pull_request",
          identity: {
            resource_id: "repo-1",
            owner: "acme",
            repo: "product",
            pull_request_number: "7",
            branch: "af/execution/AF-1-5215fde5",
            head_sha: HEAD_SHA,
          },
        }],
      },
    }),
    prAdapter: githubProbeMustNotRun(),
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("recorded surfaces must escalate before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ready_fix_prior_run_not_resumable");
  assert.equal(decision.hasPr, true);
});

test("Ready fix-mode escalates a non-resumable prior run when the PR probe is degraded", async () => {
  const issueId = "issue-degraded-probe";
  const adapter = {
    async listPullRequestsForHead() {
      throw new Error("github_unreachable");
    },
  };

  const decision = await decideReadyIssue({
    teamRef: "team-1",
    issueId,
    issueContext: readyIssue({ id: issueId }),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    fingerprint: "a".repeat(64),
    repoRoot: tempRepo(),
    repoIdentity: repoIdentityFixture(),
    store: storeWithNonResumablePriorRun(issueId),
    prAdapter: adapter,
    idempotency: {
      readGitReplayPending: async () => {
        throw new Error("unconfirmed absence must escalate before replay");
      },
      readSuppression: async () => null,
    },
  });

  assert.equal(decision.action, "escalate");
  assert.equal(
    decision.reason,
    "ready_fix_prior_run_not_resumable",
    "a degraded probe is not confirmation of absence and must keep the escalation",
  );
  assert.equal(decision.hasPr, false);
});

test("Ready fix-mode dispatches fresh for surviving prior-run defects with no surface", async (t) => {
  const cases = [
    {
      name: "session unresolved",
      store: (issueId) => storeWithPriorRun(issueId),
      resolveSessionHandle: () => null,
    },
    {
      name: "run id missing",
      store: (issueId) => storeWithNonResumablePriorRun(issueId, { run_id: undefined }),
      resolveSessionHandle: () => {
        throw new Error("session resolution must not run for a record without a run id");
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const issueId = `issue-no-surface-${entry.name.replaceAll(" ", "-")}`;
      const adapter = createReadyFixPrAdapter({ pullRequests: [] });

      const decision = await decideReadyIssue({
        teamRef: "team-1",
        issueId,
        issueContext: readyIssue({ id: issueId }),
        config: configWithReadyStatus(),
        cache: linearCacheFixture(),
        fingerprint: "a".repeat(64),
        repoRoot: tempRepo(),
        repoIdentity: repoIdentityFixture(),
        store: entry.store(issueId),
        prAdapter: adapter,
        resolveSessionHandle: entry.resolveSessionHandle,
        idempotency: {
          readGitReplayPending: async () => null,
          readSuppression: async () => null,
        },
      });

      assert.equal(decision.action, "fresh");
    });
  }
});

test("Ready fix-mode escalation posts one explanatory comment when it transitions the issue", async () => {
  const issueId = "issue-escalation-comment";
  const comments = [];
  const updates = [];

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    repoRoot: tempRepo(),
    client: escalationClientFixture({ issueId, comments, updates }),
    store: storeWithNonResumablePriorRun(issueId),
    runDeps: { prAdapter: createReadyFixPrAdapter() },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      throw new Error("escalation must not start fresh execution");
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "ready_fix_prior_run_not_resumable");
  assert.equal(updates.length, 1);
  assert.equal(result.escalation.comment.outcome, "ok");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueId, issueId);
  assert.match(comments[0].body, /move this issue back to Todo/);
  assert.match(comments[0].body, /ready_fix_prior_run_not_resumable/);
  assert.match(comments[0].body, /pull request #7/);
});

test("Ready fix-mode escalation completes a missing comment for an issue already in Principal Escalation", async () => {
  const issueId = "issue-escalation-already-blocked";
  const comments = [];
  const updates = [];
  const blockedIssue = {
    ...readyIssue({ id: issueId }),
    state: { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
    labels: [],
  };

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    repoRoot: tempRepo(),
    client: escalationClientFixture({ issueId, comments, updates, issue: blockedIssue }),
    store: storeWithNonResumablePriorRun(issueId),
    runDeps: { prAdapter: createReadyFixPrAdapter() },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      throw new Error("escalation must not start fresh execution");
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "escalate");
  assert.equal(updates.length, 0, "an already-escalated issue must not be re-transitioned");
  assert.equal(comments.length, 1, "the pair is complete only once the human-facing comment exists");
  assert.match(comments[0].body, /ready_fix_prior_run_not_resumable/);
  assert.equal(result.escalation.comment.already_present, false);
});

test("Ready fix-mode escalation does not move status when the required comment post fails", async () => {
  const issueId = "issue-escalation-comment-fails";
  const updates = [];

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
    config: configWithReadyStatus(),
    cache: linearCacheFixture(),
    candidate: { id: issueId },
    repoRoot: tempRepo(),
    client: escalationClientFixture({
      issueId,
      updates,
      failComment: new Error("comment_rejected"),
    }),
    store: storeWithNonResumablePriorRun(issueId),
    runDeps: { prAdapter: createReadyFixPrAdapter() },
    idempotency: {
      readGitReplayPending: async () => null,
      readSuppression: async () => null,
    },
    runFreshIssue: async () => {
      throw new Error("escalation must not start fresh execution");
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "escalate");
  assert.equal(updates.length, 0, "status must not move before the human-facing comment exists");
  assert.equal(result.escalation.outcome, "pending");
  assert.equal(result.escalation.reason, "linear_issue_comment_failed:comment_rejected");
});

test("processReadyIssue dispatches warm_resume without reaching fresh execution", async () => {
  const issueId = "issue-warm-dispatch";
  const adapter = createReadyFixPrAdapter();
  const warmCalls = [];
  let freshRuns = 0;
  let replayRuns = 0;
  const state = gatewayState();

  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextWithRepoFixture(),
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
      team: teamFixture(),
      teamContext: teamContextWithRepoFixture(),
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
    team: teamFixture(),
    teamContext: teamContextFixture(),
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
    team: teamFixture(),
    teamContext: teamContextFixture(),
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
  writeTeamCache(repoRoot);
  const result = await pollGatewayTeam({
    repoRoot,
    home: repoRoot,
    config: configWithReadyStatus(),
    registry: registryFixture(),
    team: teamFixture(),
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
    "ready-list:team-1:state-human-review",
  ]);
  assert.equal(state.inFlight.has("issue-1"), true, "background dispatch holds the issue in-flight key");

  issueRun.resolve({ status: "completed", wake: { run_id: "run-1" } });
  await flushAsync();
  assert.equal(state.inFlight.has("issue-1"), false);
});

test("maxInFlight gate prevents overlapping Ready issue execution", async () => {
  const state = gatewayState({ inFlight: new Set(["issue-active"]), maxInFlight: 1 });
  const result = await processReadyIssue({
    team: teamFixture(),
    teamContext: teamContextFixture(),
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
  const repoRoot = tempRepo();
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
    repoRoot,
    home: repoRoot,
    team: teamFixture(),
    client,
    marker: { objectId: "issue-review", runId: "run-review" },
    idempotency,
  });
  const done = await sweepIssueReplayMarker({
    repoRoot,
    home: repoRoot,
    team: teamFixture(),
    client,
    marker: { objectId: "issue-done", runId: "run-done" },
    idempotency,
  });

  assert.equal(retained.status, "retained");
  assert.equal(retained.stateType, "started");
  assert.equal(done.status, "cleared");
  assert.deepEqual(cleared, [{
    teamRef: "team-1",
    objectType: "issue",
    objectId: "issue-done",
    runId: "run-done",
    repoRoot,
    home: repoRoot,
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

function teamContextWithRepoFixture() {
  return {
    ...teamContextFixture(),
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

function storeWithNonResumablePriorRun(issueId, overrides = {}) {
  return {
    findLatestRunForObject(id) {
      assert.equal(id, issueId);
      return {
        run_id: "run-prior",
        object_id: issueId,
        workflow_type: "execution",
        status: "waiting",
        terminal_reason: "dependency_blocked",
        started_at: "2026-06-28T10:00:00.000Z",
        terminal_at: "2026-06-28T10:00:09.000Z",
        ...overrides,
      };
    },
  };
}

function escalationClientFixture({
  issueId,
  issue = null,
  comments = [],
  updates = [],
  failComment = null,
} = {}) {
  const context = issue || readyIssue({ id: issueId });
  return {
    async getIssueContext(id) {
      assert.equal(id, issueId);
      return structuredClone(context);
    },
    async listWorkflowStates(teamId) {
      return [{ id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId }];
    },
    async findIssueLabelsByName(name, teamId) {
      const labels = [{ id: "label-needs-principal", name: "Needs Principal", teamId }];
      return name ? labels.filter((label) => label.name === name) : labels;
    },
    async listIssueComments(id) {
      assert.equal(id, issueId);
      return comments.map((comment) => ({
        ...comment,
        user: { ...(comment.user || { id: "app-viewer-1", name: "Teami App" }) },
      }));
    },
    async updateIssue(id, input) {
      updates.push({ id, input });
      context.state = { id: input.stateId, name: "Principal Escalation", type: "started" };
      if (Object.prototype.hasOwnProperty.call(input, "labelIds")) {
        context.labels = input.labelIds.map((labelId) => ({ id: labelId }));
      }
      return {
        ...context,
        id,
      };
    },
    async createIssueComment(id, body) {
      if (failComment) throw failComment;
      const comment = {
        id: `comment-${comments.length + 1}`,
        issueId: id,
        body,
        user: { id: "app-viewer-1", name: "Teami App" },
      };
      comments.push(comment);
      return { ...comment };
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
    team_ref: "team-1",
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
  const runDir = path.join(repoRoot, "teams", "team-1", "runs");
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
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [teamFixture()],
  };
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
  });
}

function teamContextFixture() {
  return {
    teamRef: "team-1",
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
      team_ref: "team-1",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
    },
  };
}

function teamContextWithAllowedRepoPacket() {
  return {
    ...teamContextFixture(),
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
          human_review: "human-review",
        },
        statuses: {
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          human_review: { name: "Principal Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
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
    app_identity_id: "app-viewer-1",
    issueStatuses: {
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      human_review: "state-human-review",
      needs_principal: "state-needs-principal",
      done: "state-done",
    },
    projectStatuses: {
      planned: "status-planned",
    },
    issueLabels: {
      Discovery: "label-discovery",
      "Needs Principal": "label-needs-principal",
      "human-review": "label-human-review",
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
          team_ref: input.wake?.team_ref || null,
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

function writeTeamCache(repoRoot) {
  writeLinearCache(
    path.join(repoRoot, "teams", "team-1", "linear.json"),
    linearCacheFixture(),
  );
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-ready-poll-"));
  process.env.TEAMI_HOME = root;
  return root;
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
