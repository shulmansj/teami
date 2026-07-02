import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
  parseAfReviewCommentMarker,
} from "../src/execution-pr-adapter.mjs";
import {
  gatewayState,
  processReadyIssue,
  processReviewIssue,
  runFreshReviewSyntheticWake,
  runWarmResumeIssueSyntheticWake,
} from "../src/gateway-loop.mjs";
import { runTriggeredReview } from "../src/trigger-runner.mjs";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const ISSUE_ID = "issue-review-loop";
const ISSUE_KEY = "AF-1";
const PR_NUMBER = 7;

test("review loop composes request-changes, warm resume fix, approval, and fixed-head idempotency", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network_not_allowed_in_review_loop_fixture");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-review-loop-e2e-"));
  writeReviewAcceptedPromptFixture(tempRoot);

  const runStoreDir = path.join(tempRoot, ".teami", "runs");
  const config = reviewLoopConfig();
  const domain = domainFixture();
  const registry = { schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] };
  const domainContext = domainContextFixture();
  const linearClient = createMutableLinearClient();
  const store = createMutableTriggerStore({
    seedExecutionRun: executionRunRecord({
      runId: "run-prior-execution",
      startedAt: "2026-06-28T09:00:00.000Z",
      terminalAt: "2026-06-28T09:05:00.000Z",
      sessionId: "session-prior-execution",
    }),
  });
  const prAdapter = createMutablePrAdapter({
    branch: branchNameForIssue(ISSUE_KEY),
    headSha: H1,
  });
  const reviewDispositions = ["request-changes", "approve"];
  const reviewPackets = [];
  const warmResumeInvocations = [];
  const state = gatewayState({ maxInFlight: 1 });

  const runFreshReview = (input) =>
    runFreshReviewSyntheticWake({
      config,
      repoRoot: tempRoot,
      runStoreDir,
      registry,
      domain,
      domainContext,
      issueId: input.issueId,
      reviewDecision: input.reviewDecision,
      createStore: () => store,
      createSetupGraphqlClient: createFakeSetupGraphqlClient(linearClient),
      createTraceSink: createNoopTraceSink,
      createRuntimeExecutor: createNoopRuntimeExecutor,
      runDeps: { store, prAdapter },
      idGenerator: () => `run-review-${store.nextReviewRunOrdinal()}`,
      runTriggeredReviewFn: (options) =>
        runTriggeredReview({
          ...options,
          orchestratorTurnExecutor: async (turnInput) => {
            const packet = JSON.parse(turnInput.project.content);
            reviewPackets.push(packet);
            const disposition = reviewDispositions.shift();
            assert.ok(disposition, "fixture reviewer disposition should be scripted");
            return {
              controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
              producedContent: {
                disposition,
                body: disposition === "approve"
                  ? "Approved. The fix addresses the requested change."
                  : "Please add the missing regression proof before approval.",
                reviewed_head_sha: packet.pull_request.head_sha,
                source_refs: [{ kind: "github_pull_request", id: `acme/product#${PR_NUMBER}` }],
                assumptions: [],
                constraints: ["fixture uses in-memory Linear and GitHub transports"],
                risks: [],
              },
              evidence: null,
              sessionHandle: {
                id: `session-review-${packet.pull_request.head_sha}`,
                role: "orchestrator",
                run_id: turnInput.runId,
                runtime: "codex",
              },
            };
          },
        }),
    });

  const runWarmResumeIssue = (input) =>
    runWarmResumeIssueSyntheticWake({
      ...input,
      config,
      repoRoot: tempRoot,
      runStoreDir,
      registry,
      domain,
      domainContext,
      createStore: () => store,
      createSetupGraphqlClient: createFakeSetupGraphqlClient(linearClient),
      createTraceSink: createNoopTraceSink,
      createRuntimeExecutor: createNoopRuntimeExecutor,
      runDeps: { store, prAdapter },
      resolveSessionHandle,
      runTriggeredExecutionFn: async (options) => {
        warmResumeInvocations.push({
          issueId: options.issueId,
          retry: options.retry,
          priorRunId: options.resumeFrom?.priorRunId,
          reviewerNotes: options.resumeFrom?.reviewerNotes,
          headSha: options.resumeFrom?.head_sha,
          sessionHandle: options.resumeFrom?.sessionHandle,
        });
        assert.equal(options.retry, true);
        assert.equal(options.resumeFrom?.priorRunId, "run-prior-execution");
        assert.equal(options.resumeFrom?.head_sha, H1);
        assert.match(options.resumeFrom?.reviewerNotes, /Please add the missing regression proof/);

        prAdapter.advanceHead(H2);
        linearClient.setIssueState(ISSUE_ID, "state-in-review");
        const run = store.recordExecutionRun(executionRunRecord({
          runId: "run-warm-fix",
          startedAt: "2026-06-28T10:00:00.000Z",
          terminalAt: "2026-06-28T10:05:00.000Z",
          sessionId: "session-warm-fix",
          resume: {
            resume_status: "committed",
            terminal_outcome: "commit",
            head_sha: H1,
            prior_run_id: "run-prior-execution",
          },
        }));
        return {
          status: "completed",
          result: {
            status: "completed",
            artifact: {
              run_id: run.run_id,
              linear_issue_id: ISSUE_ID,
              terminal_output: { outcome: "commit", reason: "synthesis_complete" },
              resume: run.resume,
              payload: { resume: run.resume },
            },
          },
        };
      },
    });

  const pollReview = () =>
    processReviewIssue({
      config,
      repoRoot: tempRoot,
      runStoreDir,
      registry,
      domain,
      domainContext,
      client: linearClient,
      candidate: { id: ISSUE_ID },
      state,
      store,
      runDeps: { store, prAdapter },
      runFreshReview,
      runTimeoutMs: 0,
    });

  const firstReview = await pollReview();
  assert.equal(firstReview.action, "review");
  assert.equal(firstReview.decision.pr.head_sha, H1);
  await waitForIdle(state, ISSUE_ID);

  assert.equal(linearClient.issueStateName(ISSUE_ID), "Todo");
  assert.deepEqual(reviewPackets.map((packet) => packet.pull_request.head_sha), [H1]);
  assertMarkedReview({ prAdapter, headSha: H1, disposition: "request-changes", statusState: "failure" });
  assertMutationOrder(prAdapter, [
    ["post_comment", H1, "request-changes"],
    ["set_status", H1, "failure"],
  ]);

  const readyDispatch = await processReadyIssue({
    config,
    repoRoot: tempRoot,
    runStoreDir,
    registry,
    domain,
    domainContext,
    client: linearClient,
    candidate: { id: ISSUE_ID },
    state,
    store,
    runDeps: { store, prAdapter },
    resolveSessionHandle,
    runWarmResumeIssue,
    idempotency: noReplayNoSuppressionIdempotency(),
    runFreshIssue: async () => {
      throw new Error("fix-mode must warm-resume the prior execution run, not start fresh");
    },
    runReplayIssue: async () => {
      throw new Error("fix-mode must run before replay markers");
    },
    runTimeoutMs: 0,
  });
  assert.equal(readyDispatch.action, "warm_resume");
  assert.equal(readyDispatch.decision.priorRunId, "run-prior-execution");
  assert.equal(readyDispatch.decision.prNumber, PR_NUMBER);
  assert.equal(readyDispatch.decision.head_sha, H1);
  await waitForIdle(state, ISSUE_ID);

  assert.equal(warmResumeInvocations.length, 1);
  const reviewerNotesMarker = parseAfReviewCommentMarker(warmResumeInvocations[0].reviewerNotes);
  assert.equal(reviewerNotesMarker.ok, true);
  assert.equal(reviewerNotesMarker.marker.head_sha, H1);
  assert.equal(reviewerNotesMarker.marker.disposition, "request-changes");
  assert.equal(linearClient.issueStateName(ISSUE_ID), "In Review");
  assert.equal(prAdapter.currentHeadSha(), H2);
  assert.equal(prAdapter.created.length, 1);
  assert.equal(prAdapter.created[0].number, PR_NUMBER);

  const secondReview = await pollReview();
  assert.equal(secondReview.action, "review");
  assert.equal(secondReview.decision.pr.head_sha, H2);
  await waitForIdle(state, ISSUE_ID);

  assert.equal(linearClient.issueStateName(ISSUE_ID), "In Review");
  assert.deepEqual(reviewPackets.map((packet) => packet.pull_request.head_sha), [H1, H2]);
  assertMarkedReview({ prAdapter, headSha: H2, disposition: "approve", statusState: "success" });
  assert.deepEqual(
    latestAfReviewStatuses(prAdapter).map(({ head_sha, state }) => ({ head_sha, state })),
    [
      { head_sha: H1, state: "failure" },
      { head_sha: H2, state: "success" },
    ],
  );
  assertMutationOrder(prAdapter, [
    ["post_comment", H1, "request-changes"],
    ["set_status", H1, "failure"],
    ["post_comment", H2, "approve"],
    ["set_status", H2, "success"],
  ]);

  const commentCountBeforeIdempotentRetry = prAdapter.comments.length;
  const statusCountBeforeIdempotentRetry = prAdapter.statuses.length;
  const idempotentRetry = await pollReview();
  assert.equal(idempotentRetry.action, "skipped");
  assert.equal(idempotentRetry.reason, "review_already_applied_at_head");
  assert.equal(prAdapter.comments.length, commentCountBeforeIdempotentRetry);
  assert.equal(prAdapter.statuses.length, statusCountBeforeIdempotentRetry);

  assert.deepEqual(linearClient.transitions.map(({ from, to }) => `${from}->${to}`), [
    "In Review->Todo",
    "Todo->In Review",
  ]);
  assert.equal(prAdapter.created.length, 1, "the autonomous fix must keep the same PR");
  assert.equal(reviewDispositions.length, 0, "both scripted reviewer rounds should be consumed");
});

function createMutableLinearClient() {
  const states = [
    { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
    { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
    { id: "state-ready", name: "Ready", type: "unstarted", teamId: "team-1" },
    { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
    { id: "state-blocked", name: "Blocked", type: "started", teamId: "team-1" },
    { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
  ];
  const byStateId = new Map(states.map((state) => [state.id, state]));
  const issue = {
    id: ISSUE_ID,
    identifier: ISSUE_KEY,
    title: "Close the review loop",
    description: "Implement the review feedback and prove the final review passes.",
    stateId: "state-in-review",
    createdAt: "2026-06-28T08:00:00.000Z",
    labels: [],
  };
  const transitions = [];

  return {
    transitions,
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return states.map((state) => ({ ...state }));
    },
    async listReadyIssueCandidates() {
      return {
        candidates: issue.stateId === "state-ready" ? [{ id: issue.id, createdAt: issue.createdAt }] : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async getIssueContext(id) {
      assert.equal(id, ISSUE_ID);
      return issueView();
    },
    async getIssue(id) {
      assert.equal(id, ISSUE_ID);
      return issueView();
    },
    async updateIssue(id, input) {
      assert.equal(id, ISSUE_ID);
      if (input.stateId) {
        const from = byStateId.get(issue.stateId).name;
        if (!byStateId.has(input.stateId)) throw new Error(`unknown_state:${input.stateId}`);
        issue.stateId = input.stateId;
        transitions.push({ from, to: byStateId.get(issue.stateId).name });
      }
      if (Array.isArray(input.labelIds)) {
        issue.labels = input.labelIds.map((labelId) => ({ id: labelId, name: labelId }));
      }
      return issueView();
    },
    async findIssueLabelsByName() {
      return [];
    },
    setIssueState(id, stateId) {
      assert.equal(id, ISSUE_ID);
      const from = byStateId.get(issue.stateId).name;
      if (!byStateId.has(stateId)) throw new Error(`unknown_state:${stateId}`);
      issue.stateId = stateId;
      transitions.push({ from, to: byStateId.get(issue.stateId).name });
    },
    issueStateName(id) {
      assert.equal(id, ISSUE_ID);
      return byStateId.get(issue.stateId).name;
    },
  };

  function issueView() {
    const state = byStateId.get(issue.stateId);
    return structuredClone({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: `https://linear.test/${ISSUE_KEY}`,
      createdAt: issue.createdAt,
      team: { id: "team-1", key: "AF", name: "Teami" },
      project: { id: "project-1", name: "Review Loop", url: "https://linear.test/project-1" },
      assignee: null,
      labels: issue.labels,
      state,
      relations: [],
    });
  }
}

function createMutablePrAdapter({ branch, headSha }) {
  const events = [];
  const comments = [];
  const statuses = [];
  const pr = {
    id: "pr-7",
    number: PR_NUMBER,
    state: "open",
    title: "Implement AF-1",
    body: "Fixture PR",
    head: { ref: branch, sha: headSha, label: `acme:${branch}` },
    base: { ref: "main" },
    url: `https://github.example/acme/product/pull/${PR_NUMBER}`,
    html_url: `https://github.example/acme/product/pull/${PR_NUMBER}`,
  };
  const created = [pr];
  let tick = 0;

  return {
    created,
    comments,
    statuses,
    events,
    async listPullRequestsForHead(head, { state = "all" } = {}) {
      events.push({ op: "list_prs", head, state });
      assert.equal(head, branch);
      assert.equal(state, "all");
      return [{
        number: pr.number,
        state: pr.state,
        base: pr.base.ref,
        head_sha: pr.head.sha,
      }];
    },
    async getPullRequest(number) {
      events.push({ op: "get_pr", number });
      assert.equal(number, PR_NUMBER);
      return structuredClone(pr);
    },
    async getPullRequestFiles(number) {
      events.push({ op: "get_files", number, head_sha: pr.head.sha });
      assert.equal(number, PR_NUMBER);
      return {
        diff_incomplete: false,
        files: [{
          filename: "src/review-loop.js",
          status: "modified",
          additions: pr.head.sha === H1 ? 1 : 2,
          deletions: 0,
          changes: pr.head.sha === H1 ? 1 : 2,
          patch: pr.head.sha === H1
            ? "@@ -1 +1 @@\n-export const reviewed = false;\n+export const reviewed = 'needs-fix';"
            : "@@ -1 +1 @@\n-export const reviewed = 'needs-fix';\n+export const reviewed = 'approved';",
        }],
      };
    },
    async getCommitStatuses(head_sha) {
      events.push({ op: "get_statuses", head_sha });
      return statuses.filter((status) => status.head_sha === head_sha).map((status) => ({ ...status }));
    },
    async setCommitStatus(status) {
      tick += 1;
      const record = {
        id: `status-${statuses.length + 1}`,
        ...status,
        created_at: isoAt(tick),
      };
      statuses.push(record);
      events.push({
        op: "set_status",
        head_sha: record.head_sha,
        state: record.state,
        context: record.context,
      });
      return { id: record.id };
    },
    async postPullRequestComment({ number, body, context, disposition, head_sha, run_id }) {
      tick += 1;
      assert.equal(number, PR_NUMBER);
      const comment = {
        id: `comment-${comments.length + 1}`,
        comment_id: `comment-${comments.length + 1}`,
        body: formatAfReviewCommentBody({ body, context, disposition, head_sha, run_id }),
        created_at: isoAt(tick),
        user: { type: "Bot" },
      };
      comments.push(comment);
      events.push({ op: "post_comment", head_sha, disposition, comment_id: comment.id });
      return { comment_id: comment.id };
    },
    async listPullRequestComments(number) {
      events.push({ op: "list_comments", number });
      assert.equal(number, PR_NUMBER);
      return comments.map((comment) => ({ ...comment }));
    },
    advanceHead(nextHeadSha) {
      pr.head.sha = nextHeadSha;
    },
    currentHeadSha() {
      return pr.head.sha;
    },
  };
}

function createMutableTriggerStore({ seedExecutionRun } = {}) {
  const wakes = new Map();
  const runs = new Map();
  const executionRuns = [];
  const completed = [];
  const triggerEvents = [];
  let wakeSequence = 0;
  let reviewRunSequence = 0;

  if (seedExecutionRun) executionRuns.push(seedExecutionRun);

  return {
    triggerEvents,
    completed,
    nextReviewRunOrdinal() {
      reviewRunSequence += 1;
      return reviewRunSequence;
    },
    recordExecutionRun(run) {
      executionRuns.push(run);
      runs.set(run.run_id, run);
      return run;
    },
    findLatestRunForObject(objectId) {
      assert.equal(objectId, ISSUE_ID);
      return executionRuns.at(-1) || null;
    },
    async claimSyntheticIssueWake({
      domainId,
      workspaceId,
      teamId,
      objectId,
      workflowType,
      triggerType,
      objectType,
    }) {
      wakeSequence += 1;
      const event = {
        id: `event-${wakeSequence}`,
        event_id: `evt-${wakeSequence}`,
        provider: "linear",
        object: { id: objectId },
      };
      const wake = {
        id: `wake-${workflowType}-${wakeSequence}`,
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: triggerType,
        workflow_type: workflowType,
        object_type: objectType,
        object_id: objectId,
        team_ids: [teamId],
        created_at: isoAt(wakeSequence),
        attempt_count: 0,
        source_event_id: event.id,
        status: "leased",
        lease_token: `lease-${wakeSequence}`,
      };
      triggerEvents.push(event);
      wakes.set(wake.id, wake);
      return { ok: true, wake: structuredClone(wake), event, leaseToken: wake.lease_token };
    },
    async heartbeat() {
      return { ok: true };
    },
    async renewLease({ wakeId }) {
      return { ok: true, wake: structuredClone(wakes.get(wakeId) || null) };
    },
    async markWakeRunning({ wakeId, runnerId, leaseToken, runId, domainId }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, {
        status: "running",
        runner_id: runnerId,
        lease_token: leaseToken,
        run_id: runId,
        domain_id: domainId,
      });
      runs.set(runId, {
        run_id: runId,
        wake_id: wakeId,
        object_id: wake.object_id,
        workflow_type: wake.workflow_type,
        status: "running",
      });
      return { ok: true, wake: structuredClone(wake) };
    },
    async completeWake({ wakeId, status, reason, providerUpdateIds = [], artifactPointer = null, artifact = null }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, { status, reason, provider_update_ids: providerUpdateIds });
      const run = runs.get(wake.run_id) || {
        run_id: wake.run_id,
        wake_id: wakeId,
        object_id: wake.object_id,
        workflow_type: wake.workflow_type,
      };
      Object.assign(run, {
        status,
        terminal_reason: reason,
        provider_update_ids: providerUpdateIds,
        artifact_pointer: artifactPointer,
        runtime_metadata: artifact?.runtime_metadata || {},
      });
      runs.set(run.run_id, run);
      completed.push({
        issueId: wake.object_id,
        workflowType: wake.workflow_type,
        status,
        reason,
        wake: structuredClone(wake),
        run: structuredClone(run),
        artifact: structuredClone(artifact),
      });
      return { ok: true, wake: structuredClone(wake), run: structuredClone(run) };
    },
    async getWake(wakeId) {
      return structuredClone(wakes.get(wakeId) || null);
    },
  };
}

function executionRunRecord({
  runId,
  startedAt,
  terminalAt,
  sessionId,
  resume = null,
} = {}) {
  return {
    run_id: runId,
    object_id: ISSUE_ID,
    workflow_type: "execution",
    status: "completed",
    started_at: startedAt,
    terminal_at: terminalAt,
    session_handle_pointer: {
      source: "run_artifact.runtime_metadata",
      runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
    },
    runtime_metadata: {
      orchestrator: {
        session_handle: {
          id: sessionId,
          role: "orchestrator",
          run_id: runId,
          runtime: "codex",
        },
      },
    },
    ...(resume ? { resume, artifact: { resume, payload: { resume } } } : {}),
  };
}

function resolveSessionHandle(run) {
  const handle = run?.runtime_metadata?.orchestrator?.session_handle;
  return handle ? structuredClone(handle) : null;
}

function assertMarkedReview({ prAdapter, headSha, disposition, statusState }) {
  const matchingComments = prAdapter.comments.filter((comment) => {
    const parsed = parseAfReviewCommentMarker(comment.body);
    return parsed.ok &&
      parsed.marker.context === AF_REVIEW_STATUS_CONTEXT &&
      parsed.marker.head_sha === headSha &&
      parsed.marker.disposition === disposition;
  });
  assert.equal(matchingComments.length, 1, `${disposition}@${headSha} should have one marked comment`);

  const matchingStatuses = prAdapter.statuses.filter((status) =>
    status.context === AF_REVIEW_STATUS_CONTEXT &&
    status.head_sha === headSha &&
    status.state === statusState
  );
  assert.equal(matchingStatuses.length, 1, `${statusState}@${headSha} should have one af-review status`);
}

function assertMutationOrder(prAdapter, expected) {
  assert.deepEqual(
    prAdapter.events
      .filter((event) => event.op === "post_comment" || event.op === "set_status")
      .map((event) => [
        event.op,
        event.head_sha,
        event.op === "post_comment" ? event.disposition : event.state,
      ]),
    expected,
  );
}

function latestAfReviewStatuses(prAdapter) {
  return prAdapter.statuses
    .filter((status) => status.context === AF_REVIEW_STATUS_CONTEXT)
    .map((status) => ({ head_sha: status.head_sha, state: status.state, created_at: status.created_at }));
}

function noReplayNoSuppressionIdempotency() {
  return {
    async readGitReplayPending() {
      return null;
    },
    async readSuppression() {
      return null;
    },
  };
}

function createFakeSetupGraphqlClient(client) {
  return (input = {}) => {
    assert.equal(input.allowBrowserAuth, false);
    return { client };
  };
}

function createNoopRuntimeExecutor() {
  return {
    async executeSubagent() {
      throw new Error("subagent executor should not be called by this fixture");
    },
  };
}

function createNoopTraceSink() {
  return {
    async startRun() {
      return { ok: true, traceId: "trace-review-loop-e2e" };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun() {
      return { status: "stored" };
    },
    async shutdown() {},
  };
}

async function waitForIdle(state, issueId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!state.inFlight.has(issueId)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`issue remained in-flight: ${issueId}`);
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

function reviewLoopConfig() {
  return {
    runner: {
      lease_duration_ms: 60_000,
    },
    runtime: {
      adapters: {
        codex: {
          command: "codex",
          tool_policy: { linear_write: false },
        },
      },
    },
    workflows: {
      execution: {
        roles: {
          worker: {},
          orchestrator: {},
        },
      },
      review: {
        max_autonomous_fix_rounds: 3,
        roles: {
          reviewer: { runtime: "codex", model: "test-reviewer" },
          orchestrator: { runtime: "codex", model: "test-orchestrator" },
        },
      },
    },
    linear: {
      oauth: {
        credential_storage: "file",
        client_id: "client-id",
        redirect_uri: "http://localhost/callback",
      },
      team: { key: "AF", name: "Teami" },
      issue: {
        labels: {
          needs_principal: "Needs Principal",
        },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          blocked: { name: "Blocked", type: "started" },
          done: { name: "Done", type: "completed" },
          ready: { name: "Ready" },
        },
      },
    },
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
    teamNameLastSeenAt: "2026-06-28T00:00:00.000Z",
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
      cachePath: "unused-cache.json",
    },
    trace: {
      domain_id: "domain-1",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:review-loop-e2e",
    },
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
  };
}

function isoAt(offsetSeconds) {
  return new Date(Date.parse("2026-06-28T08:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}
