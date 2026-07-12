import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalTriggerStore } from "../src/local-trigger-store.mjs";
import {
  gatewayPollTargets,
  listHumanReviewIssueCandidates,
  processMergeGateIssueCandidate,
  sweepIssueReplayMarker,
} from "../src/gateway-loop.mjs";
import { AF_REVIEW_STATUS_CONTEXT } from "../src/execution-pr-adapter.mjs";

const HEAD_SHA = "a".repeat(40);
const NEXT_HEAD_SHA = "b".repeat(40);

test("Principal Review and park-record sweep targets are registered after In Review", () => {
  const statuses = gatewayPollTargets().map((target) => target.input_status);

  assert.ok(statuses.includes("Principal Review"));
  assert.ok(statuses.includes("Merge Gate Watchlist"));
  assert.equal(statuses.includes("Principal Escalation"), false);
  assert.ok(statuses.indexOf("Principal Review") > statuses.indexOf("In Review"));
  assert.ok(statuses.indexOf("Merge Gate Watchlist") > statuses.indexOf("Principal Review"));
});

test("Principal Review polling uses the cached role id even if the status has been renamed", async () => {
  const calls = [];
  const page = await listHumanReviewIssueCandidates({
    domain: domainFixture(),
    cache: cacheFixture(),
    pollScope: null,
    client: {
      async listReadyIssueCandidates(teamId, input) {
        calls.push({ teamId, input });
        return {
          candidates: [issueCandidate({ id: "issue-human-review", projectId: "project-1" })],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.readyStateId, "state-human-review");
  assert.equal(page.candidates[0].id, "issue-human-review");
});

test("green labeled In Review issue writes a park record before moving to Principal Review", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
  });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: ["human_review"] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({ headSha: HEAD_SHA }),
    }),
  );

  assert.equal(result.action, "park");
  assert.equal(result.status, "completed");
  assert.deepEqual(store.parkRecords({ issueId: "issue-1" }), {
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T12:00:00.000Z",
  });
  assert.equal(client.events.filter((event) => event.method === "updateIssue").length, 1);
  assert.equal(client.issue.state.id, "state-human-review");
});

test("gate resolves the PR from the produced identity when branch discovery is ambiguous", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  // A discarded PR shares the reused issue branch with the live one, so
  // branch-name discovery reports "multiple" — the factory's produced identity
  // must carry the gate to the live PR instead.
  const gateStore = {
    ...store,
    findLatestRunForObject: () => ({
      run_id: "run-exec-1",
      object_id: "issue-1",
      workflow_type: "execution",
      status: "completed",
      started_at: "2026-06-30T11:30:00.000Z",
      artifact: {
        produced_identities: [{
          effect_id: "github_pr",
          resource_kind: "github_pull_request",
          identity: { pull_request_number: 17 },
        }],
      },
    }),
  };
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });
  prAdapter.listPullRequestsForHead = async () => [
    { number: 9, state: "closed", base: "main", head_sha: "1".repeat(40) },
    { number: 17, state: "open", base: "main", head_sha: HEAD_SHA },
  ];

  const result = await processMergeGateIssueCandidate(
    issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
    mergeGateOptions({
      repoRoot,
      store: gateStore,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "park");
  assert.equal(result.status, "completed");
  assert.deepEqual(store.parkRecords({ issueId: "issue-1" }), {
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T12:00:00.000Z",
  });
  assert.equal(client.issue.state.id, "state-human-review");
});

test("green labeled In Review issue re-parks by overwriting a stale record before moving", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: "0".repeat(40),
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
  });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: ["human_review"] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({ headSha: HEAD_SHA }),
    }),
  );

  assert.equal(result.action, "park");
  assert.equal(result.status, "completed");
  assert.deepEqual(store.parkRecords({ issueId: "issue-1" }), {
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T12:00:00.000Z",
  });
  assert.deepEqual(store.parkRecords().map((record) => record.issue_id), ["issue-1"]);
  assert.equal(client.issue.state.id, "state-human-review");
});

test("ungated green In Review merge pairs the factory Done move and records a merge run", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: [] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: [] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "merge");
  assert.equal(result.status, "completed");
  assert.equal(client.issue.state.id, "state-done");
  assert.deepEqual(
    client.events.filter((event) => event.method === "updateIssue").map((event) => event.input),
    [{ stateId: "state-done" }],
  );
  assert.equal(prAdapter.calls.filter((call) => call.method === "mergePullRequest").length, 1);

  const mergeRun = store.findLatestMergeRunForIssuePrHead({
    issueId: "issue-1",
    prNumber: 17,
    headSha: HEAD_SHA,
  });
  assert.equal(mergeRun.workflow_type, "merge");
  assert.deepEqual(mergeRun.merge_outcome, {
    issue_id: "issue-1",
    pr_number: 17,
    head_sha: HEAD_SHA,
    outcome: "merged",
    reason: "parked head merged",
    observed_at: "2026-06-30T12:00:00.000Z",
  });
});

test("human-review un-gate merges the parked head, moves Done, and deletes the stale record", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "human_review", labels: [] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    issueFixture({ stateRole: "human_review", labels: [] }),
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "merge");
  assert.equal(result.status, "completed");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.issue.state.id, "state-done");
  assert.equal(prAdapter.calls.filter((call) => call.method === "mergePullRequest").length, 1);
});

test("human-review un-gate does not merge a drifted head and keeps the stale record", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "human_review", labels: [] }),
  });
  const prAdapter = prAdapterFixture({ headSha: NEXT_HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    issueFixture({ stateRole: "human_review", labels: [] }),
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "invalidate");
  assert.equal(result.status, "completed");
  assert.equal(client.issue.state.id, "state-in-review");
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("merge conflict-class failure bounces an ungated In Review issue to Todo", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: [] }),
  });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: [] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({
        headSha: HEAD_SHA,
        mergeResult: { merged: false, message: "merge conflict" },
      }),
    }),
  );

  assert.equal(result.action, "merge");
  assert.equal(result.status, "failed_closed");
  assert.equal(result.bridge.action, "bounce");
  assert.equal(result.bridge.status, "completed");
  assert.equal(client.issue.state.id, "state-todo");

  const mergeRun = store.findLatestMergeRunForIssuePrHead({
    issueId: "issue-1",
    prNumber: 17,
    headSha: HEAD_SHA,
  });
  assert.equal(mergeRun.merge_outcome.outcome, "failed");
  assert.match(mergeRun.merge_outcome.reason, /merged:false/);
});

test("GitHub not-mergeable refusal bounces to Todo, but a head-sha race does not bridge", async () => {
  const notMergeable = await runUngatedMergeFailure({
    mergeResult: Object.assign(new Error("not mergeable"), { status: 405 }),
  });
  assert.equal(notMergeable.result.status, "failed_closed");
  assert.equal(notMergeable.result.bridge.action, "bounce");
  assert.equal(notMergeable.result.bridge.status, "completed");
  assert.equal(notMergeable.client.issue.state.id, "state-todo");
  assert.match(notMergeable.mergeRun.merge_outcome.reason, /not mergeable/i);

  const headRace = await runUngatedMergeFailure({
    mergeResult: Object.assign(new Error("head moved"), { status: 409 }),
  });
  assert.equal(headRace.result.status, "failed_closed");
  assert.equal(Object.hasOwn(headRace.result, "bridge"), false);
  assert.equal(headRace.client.issue.state.id, "state-in-review");
  assert.match(headRace.mergeRun.merge_outcome.reason, /expected head sha/);
});

test("Done cleanup row deletes the park record without moving or merging", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "done", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({
    headSha: HEAD_SHA,
    merged: true,
  });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "delete_park_record");
  assert.equal(result.status, "completed");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("Done mismatch rows keep surfacing while labeled and delete after label acknowledgment", async () => {
  const labeled = await runDoneMergedMismatch({ labels: ["human_review"] });
  assert.equal(labeled.result.action, "surface");
  assert.equal(labeled.result.status, "degraded");
  assert.equal(labeled.store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
  assert.equal(labeled.client.events.some((event) => event.method === "updateIssue"), false);

  const acknowledged = await runDoneMergedMismatch({ labels: [] });
  assert.equal(acknowledged.result.action, "delete_park_record");
  assert.equal(acknowledged.result.status, "completed");
  assert.equal(acknowledged.store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(acknowledged.client.events.some((event) => event.method === "updateIssue"), false);
});

test("Done bounce rows only move never-merged work and keep the park record", async () => {
  const driftedOpen = await runDoneBounce({
    prAdapter: prAdapterFixture({ headSha: NEXT_HEAD_SHA }),
  });
  assert.equal(driftedOpen.result.action, "bounce");
  assert.equal(driftedOpen.result.bounceTo, "in_review");
  assert.equal(driftedOpen.result.status, "completed");
  assert.equal(driftedOpen.client.issue.state.id, "state-in-review");
  assert.equal(driftedOpen.store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);

  const closedUnmerged = await runDoneBounce({
    prAdapter: prAdapterFixture({ headSha: HEAD_SHA, pullRequestState: "closed" }),
  });
  assert.equal(closedUnmerged.result.action, "bounce");
  assert.equal(closedUnmerged.result.bounceTo, "todo");
  assert.equal(closedUnmerged.result.status, "completed");
  assert.equal(closedUnmerged.client.issue.state.id, "state-todo");
  assert.equal(closedUnmerged.store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
});

test("stale park record on a closed unmerged PR is deleted instead of re-parking the In Review issue", async () => {
  // SAN-5 regression: parked at PR head H, human send-back, PR closed + branch
  // deleted in a discard-and-restart, fresh execution opened a new PR, issue back
  // in In Review. The gate resolved PR context from the stale record, saw the
  // closed PR's old green head, and parked an unreviewed issue in Principal Review.
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA, pullRequestState: "closed" });

  const result = await processMergeGateIssueCandidate(
    issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
      reviewLoopFallback: true,
    }),
  );

  assert.equal(result.action, "delete_park_record");
  assert.equal(result.status, "completed");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(client.issue.state.id, "state-in-review");
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("watchlist sweep deletes a send-back park record whose PR was closed without merging", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "todo", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA, pullRequestState: "closed" });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "delete_park_record");
  assert.equal(result.status, "completed");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
});

test("watchlist sweep leaves an escalated issue park record while its PR is open", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "needs_principal", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "merge_gate_none");
  assert.equal(result.snapshot.issueStatusRole, "needs_principal");
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("watchlist sweep deletes an escalated issue park record whose PR closed without merging", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "needs_principal", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA, pullRequestState: "closed" });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "delete_park_record");
  assert.equal(result.snapshot.issueStatusRole, "needs_principal");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("watchlist sweep fails closed for an unknown issue status without touching Linear or the park record", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const unknownIssue = {
    ...issueFixture({ stateRole: "todo", labels: ["human_review"] }),
    state: { id: "state-outsider", name: "Attention", type: "started" },
  };
  const client = linearClientFixture({ issue: unknownIssue });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "surface");
  assert.equal(result.snapshot.issueStatusRole, null);
  assert.match(result.reason, /unrecognized merge gate combination/);
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("parked issue whose PR closed without merging invalidates to In Review, then sheds the record", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "human_review", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA, pullRequestState: "closed" });

  const invalidated = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({ repoRoot, store, client, prAdapter }),
  );

  assert.equal(invalidated.action, "invalidate");
  assert.equal(invalidated.status, "completed");
  assert.equal(client.issue.state.id, "state-in-review");
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_head_sha, HEAD_SHA);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);

  const cleaned = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({ repoRoot, store, client, prAdapter }),
  );

  assert.equal(cleaned.action, "delete_park_record");
  assert.equal(cleaned.status, "completed");
  assert.equal(store.parkRecords({ issueId: "issue-1" }), null);
  assert.equal(client.issue.state.id, "state-in-review");
});

test("unvetted Done without a park record is surfaced without moving or merging", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "done", labels: ["human_review"] }),
  });
  const prAdapter = prAdapterFixture({ headSha: HEAD_SHA });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "done", labels: ["human_review"] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  assert.equal(result.action, "surface");
  assert.equal(result.status, "degraded");
  assert.match(result.reason, /unrecognized merge gate combination/);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
  assert.equal(prAdapter.calls.some((call) => call.method === "mergePullRequest"), false);
});

test("manual Principal Review drag without a park record surfaces out of order without PR reads", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "human_review", labels: ["human_review"] }),
  });

  const result = await processMergeGateIssueCandidate(
    issueFixture({ stateRole: "human_review", labels: ["human_review"] }),
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: null,
    }),
  );

  assert.equal(result.action, "surface");
  assert.match(result.reason, /out of order/);
  assert.equal(client.events.some((event) => event.method === "updateIssue"), false);
});

test("completed issues with park records retain replay markers until park cleanup", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });

  const result = await sweepIssueReplayMarker({
    repoRoot,
    domain: domainFixture(),
    store,
    marker: { objectId: "issue-1", runId: "run-execution-1" },
    client: {
      async getIssueContext() {
        return issueFixture({ stateRole: "done", labels: ["human_review"] });
      },
    },
    idempotency: {
      async clearMutationIntent() {
        throw new Error("marker_must_not_clear_while_park_record_exists");
      },
    },
  });

  assert.equal(result.status, "retained");
  assert.equal(result.reason, "park_record_present");
});

test("In Review red or absent review evidence falls back to the review loop", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: ["human_review"] }),
  });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: ["human_review"] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({ headSha: HEAD_SHA, checkState: "failure" }),
      reviewLoopFallback: true,
    }),
  );

  assert.equal(result.action, "review_loop");
  assert.equal(result.reason, "review is not green at the current head; leave the review loop in control");
}
);

function mergeGateOptions({
  repoRoot,
  store,
  client,
  prAdapter,
  reviewLoopFallback = false,
} = {}) {
  return {
    repoRoot,
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    config: configFixture(),
    cache: cacheFixture(),
    client,
    store,
    runDeps: { prAdapter, store },
    reviewLoopFallback,
    now: fixedNow,
    emitStatus: () => {},
  };
}

function linearClientFixture({ issue }) {
  const client = {
    issue: structuredClone(issue),
    events: [],
    async getIssueContext(id) {
      this.events.push({ method: "getIssueContext", id });
      assert.equal(id, "issue-1");
      return structuredClone(this.issue);
    },
    async updateIssue(id, input) {
      this.events.push({ method: "updateIssue", id, input });
      assert.equal(id, "issue-1");
      if (input.stateId) {
        this.issue.state = stateById(input.stateId);
      }
      return structuredClone(this.issue);
    },
    async listWorkflowStates() {
      this.events.push({ method: "listWorkflowStates" });
      return workflowStates();
    },
  };
  return client;
}

function prAdapterFixture({
  headSha = HEAD_SHA,
  checkState = "success",
  merged = false,
  pullRequestState = null,
  mergeResult = null,
} = {}) {
  let isMerged = merged;
  let stateOverride = pullRequestState;
  const calls = [];
  return {
    calls,
    async getPullRequest(number) {
      calls.push({ method: "getPullRequest", number });
      assert.equal(number, 17);
      return {
        number,
        state: stateOverride || (isMerged ? "closed" : "open"),
        merged: isMerged,
        merged_at: isMerged ? "2026-06-30T12:00:00.000Z" : null,
        head_sha: headSha,
      };
    },
    async getCommitStatuses(sha) {
      calls.push({ method: "getCommitStatuses", sha });
      assert.equal(sha, headSha);
      return checkState === "absent"
        ? []
        : [{
            context: AF_REVIEW_STATUS_CONTEXT,
            state: checkState,
            created_at: "2026-06-30T11:59:00.000Z",
          }];
    },
    async mergePullRequest(input) {
      calls.push({ method: "mergePullRequest", input });
      assert.deepEqual(input, { number: 17, expectedHeadSha: headSha });
      if (mergeResult instanceof Error) throw mergeResult;
      if (mergeResult) return mergeResult;
      isMerged = true;
      stateOverride = null;
      return { merged: true, sha: headSha };
    },
    async listPullRequestsForHead() {
      return [{
        number: 17,
        state: isMerged ? "closed" : "open",
        head_sha: headSha,
        head: { sha: headSha, ref: "af/execution/AF-123" },
        base: { ref: "main" },
      }];
    },
  };
}

async function runUngatedMergeFailure({ mergeResult }) {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "in_review", labels: [] }),
  });

  const result = await processMergeGateIssueCandidate(
    { ...issueFixture({ stateRole: "in_review", labels: [] }), pr_number: 17 },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({
        headSha: HEAD_SHA,
        mergeResult,
      }),
    }),
  );

  return {
    result,
    client,
    mergeRun: store.findLatestMergeRunForIssuePrHead({
      issueId: "issue-1",
      prNumber: 17,
      headSha: HEAD_SHA,
    }),
  };
}

async function runDoneMergedMismatch({ labels }) {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "done", labels }),
  });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter: prAdapterFixture({
        headSha: NEXT_HEAD_SHA,
        merged: true,
      }),
    }),
  );

  return { result, store, client };
}

async function runDoneBounce({ prAdapter }) {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({ repoRoot, home: repoRoot, now: fixedNow });
  store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 17,
    parked_head_sha: HEAD_SHA,
    parked_at: "2026-06-30T11:00:00.000Z",
  });
  const client = linearClientFixture({
    issue: issueFixture({ stateRole: "done", labels: ["human_review"] }),
  });

  const result = await processMergeGateIssueCandidate(
    { issue_id: "issue-1" },
    mergeGateOptions({
      repoRoot,
      store,
      client,
      prAdapter,
    }),
  );

  return { result, store, client };
}

function issueFixture({ stateRole, labels = [] } = {}) {
  return {
    id: "issue-1",
    identifier: "AF-123",
    title: "Ship the checkout button",
    description: "",
    team: { id: "team-1" },
    teamId: "team-1",
    projectId: "project-1",
    state: stateForRole(stateRole),
    labels: labels.map(labelForRole),
  };
}

function issueCandidate({ id, projectId }) {
  return {
    id,
    projectId,
    createdAt: "2026-06-30T10:00:00.000Z",
  };
}

function stateForRole(role) {
  return stateById(cacheFixture().issueStatuses[role]);
}

function stateById(id) {
  const state = workflowStates().find((candidate) => candidate.id === id);
  if (!state) throw new Error(`unknown_state:${id}`);
  return structuredClone(state);
}

function labelForRole(role) {
  if (role !== "human_review") throw new Error(`unknown_label:${role}`);
  return { id: "label-human-review", name: "human-review" };
}

function workflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog" },
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-in-progress", name: "In Progress", type: "started" },
    { id: "state-in-review", name: "In Review", type: "started" },
    { id: "state-human-review", name: "Founder Acceptance", type: "started" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
    { id: "state-done", name: "Done", type: "completed" },
  ];
}

function configFixture() {
  return {
    linear: {
      issue: {
        labels: {
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
        },
      },
    },
  };
}

function cacheFixture() {
  return {
    teamId: "team-1",
    issueStatuses: {
      backlog: "state-backlog",
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      human_review: "state-human-review",
      needs_principal: "state-needs-principal",
      done: "state-done",
    },
    issueLabels: {
      "human-review": "label-human-review",
    },
  };
}

function domainFixture() {
  return {
    id: "domain-1",
    linear: {
      workspace_id: "workspace-1",
      team_id: "team-1",
    },
  };
}

function domainContextFixture() {
  return {
    domainId: "domain-1",
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
    },
    resources: [],
  };
}

function fixedNow() {
  return new Date("2026-06-30T12:00:00.000Z");
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-merge-gate-scan-"));
  process.env.TEAMI_HOME = root;
  return root;
}
