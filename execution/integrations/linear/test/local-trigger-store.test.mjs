import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalTriggerStore,
  localTriggerStorePath,
  readLocalTriggerState,
} from "../src/local-trigger-store.mjs";

const REQUIRED_CAPABILITIES = ["linear.project.planned", "decomposition.trigger_runner.v1"];

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-local-trigger-store-"));
}

function sequenceIds() {
  const counts = new Map();
  return (prefix = "id") => {
    const next = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function sequenceNow(values) {
  const queue = [...values];
  return () => new Date(queue.shift() || values.at(-1));
}

test("local trigger store drives claim to running to mutation started to complete with idempotency calls", async () => {
  const repoRoot = tempRepo();
  const writes = [];
  const clears = [];
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow([
      "2026-06-24T10:00:00.000Z",
      "2026-06-24T10:01:00.000Z",
      "2026-06-24T10:02:00.000Z",
      "2026-06-24T10:03:00.000Z",
    ]),
    writeMutationIntent: async (input) => {
      writes.push(input);
    },
    clearMutationIntent: async (input) => {
      clears.push(input);
    },
  });

  const claim = await store.claimSyntheticWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.leaseToken, "lease-1");
  assert.deepEqual(claim.wake, {
    id: "wake-1",
    workspace_id: "workspace-1",
    team_ref: "support-ops",
    trigger_type: "linear.project.planned",
    workflow_type: "decomposition",
    object_type: "project",
    object_id: "project-1",
    team_ids: ["team-1"],
    created_at: "2026-06-24T10:00:00.000Z",
    attempt_count: 0,
    source_event_id: "event-1",
    status: "leased",
    claimed_at: "2026-06-24T10:00:00.000Z",
    runner_id: null,
    lease_token: "lease-1",
    lease_expires_at: null,
    started_at: null,
    mutation_started_at: null,
    mutation_artifact_kind: null,
    terminal_at: null,
    run_id: null,
    reason: null,
    routing_error_reason: null,
    routing_candidates: [],
  });
  assert.deepEqual(claim.event, {
    id: "event-1",
    workspace_id: "workspace-1",
    team_ref: "support-ops",
    trigger_type: "linear.project.planned",
    workflow_type: "decomposition",
    object_type: "project",
    object_id: "project-1",
    team_ids: ["team-1"],
    created_at: "2026-06-24T10:00:00.000Z",
  });

  const running = await store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-1",
    teamRef: "support-ops",
  });
  assert.equal(running.ok, true);
  assert.equal(running.wake.status, "running");
  assert.equal(running.wake.runner_id, "runner-1");
  assert.equal(running.wake.run_id, "run-1");

  const mutation = await store.markMutationStarted({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-1",
    artifactKind: "commit",
  });
  assert.equal(mutation.ok, true);
  assert.equal(mutation.wake.mutation_started_at, "2026-06-24T10:02:00.000Z");
  assert.equal(mutation.wake.mutation_artifact_kind, "commit");
  assert.deepEqual(writes, [{
    teamRef: "support-ops",
    projectId: "project-1",
    runId: "run-1",
    artifactKind: "commit",
    wakeId: "wake-1",
    startedAt: "2026-06-24T10:02:00.000Z",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);

  const completed = await store.completeWake({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    status: "completed",
    providerUpdateIds: ["issue-1", "project-update-1"],
    reconciliationVerified: true,
    reconciliationEvidenceDigest: "b".repeat(64),
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.wake.status, "completed");
  assert.equal(completed.run.status, "completed");
  assert.deepEqual(completed.run.provider_update_ids, ["issue-1", "project-update-1"]);
  assert.deepEqual(clears, [{
    teamRef: "support-ops",
    projectId: "project-1",
    runId: "run-1",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);

  const reloaded = readLocalTriggerState(localTriggerStorePath(repoRoot));
  assert.equal(reloaded.wakes[0].status, "completed");
  assert.equal(reloaded.runs[0].status, "completed");
});

test("local trigger store supports release, fresh claim, and dead-letter without clearing mutation intent", async () => {
  const repoRoot = tempRepo();
  const clears = [];
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow([
      "2026-06-24T11:00:00.000Z",
      "2026-06-24T11:01:00.000Z",
      "2026-06-24T11:02:00.000Z",
      "2026-06-24T11:03:00.000Z",
    ]),
    writeMutationIntent: async () => {
      throw new Error("writeMutationIntent should not be called on this path");
    },
    clearMutationIntent: async (input) => {
      clears.push(input);
    },
  });

  const synthetic = await store.claimSyntheticWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-release",
  });
  const released = await store.releaseWake({
    wakeId: synthetic.wake.id,
    runnerId: "runner-foreign-team",
    leaseToken: synthetic.leaseToken,
    reason: "team_not_served",
  });
  assert.deepEqual({
    ok: released.ok,
    wakeId: released.wakeId,
    status: released.status,
    attemptCount: released.attemptCount,
  }, {
    ok: true,
    wakeId: "wake-1",
    status: "queued",
    attemptCount: 0,
  });

  const claimed = await store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: REQUIRED_CAPABILITIES,
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.leaseToken, "lease-2");
  assert.equal(claimed.wake.attempt_count, 1);

  const running = await store.markWakeRunning({
    wakeId: claimed.wake.id,
    runnerId: "runner-1",
    leaseToken: claimed.leaseToken,
    runId: "run-dead",
    teamRef: "support-ops",
  });
  assert.equal(running.ok, true);

  const dead = await store.deadLetterWake({
    wakeId: claimed.wake.id,
    runnerId: "runner-1",
    leaseToken: claimed.leaseToken,
    reason: "runner_failed_before_linear_mutation",
  });
  assert.equal(dead.ok, true);
  assert.equal(dead.wake.status, "dead_letter");
  assert.equal(dead.run.status, "dead_letter");
  assert.deepEqual(clears, []);
});

test("local trigger store persists one cloned park record per issue and isolates them from run lookup", () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: () => new Date("2026-06-26T10:00:00.000Z"),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });

  assert.deepEqual(readLocalTriggerState(localTriggerStorePath(repoRoot)).park_records, []);
  assert.equal(store.findLatestRunForObject("issue-1"), null);

  const first = store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 7,
    parked_head_sha: "head-a",
    parked_at: "2026-06-26T10:00:00.000Z",
    ignored: "extra-field",
  });
  assert.deepEqual(Object.keys(first), ["issue_id", "pr_number", "parked_head_sha", "parked_at"]);
  assert.equal(store.findLatestRunForObject("issue-1"), null);

  first.parked_head_sha = "mutated";
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_head_sha, "head-a");

  const sameHead = store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 7,
    parked_head_sha: "head-a",
    parked_at: "2026-06-26T10:04:00.000Z",
  });
  assert.equal(sameHead.parked_at, "2026-06-26T10:00:00.000Z");
  assert.equal(store.parkRecords({ issueId: "issue-1" }).parked_at, "2026-06-26T10:00:00.000Z");
  assert.equal(store.parkRecords().length, 1);

  const overwritten = store.upsertParkRecord({
    issue_id: "issue-1",
    pr_number: 7,
    parked_head_sha: "head-b",
    parked_at: "2026-06-26T10:05:00.000Z",
  });
  assert.deepEqual(overwritten, {
    issue_id: "issue-1",
    pr_number: 7,
    parked_head_sha: "head-b",
    parked_at: "2026-06-26T10:05:00.000Z",
  });
  assert.equal(store.parkRecords().length, 1);

  store.upsertParkRecord({
    issue_id: "issue-2",
    pr_number: 8,
    parked_head_sha: "head-c",
    parked_at: "2026-06-26T10:10:00.000Z",
  });
  const all = store.parkRecords();
  assert.equal(all.length, 2);
  all[0].issue_id = "mutated";
  assert.equal(store.parkRecords({ issueId: "issue-1" }).issue_id, "issue-1");

  const persisted = readLocalTriggerState(localTriggerStorePath(repoRoot));
  assert.deepEqual(persisted.park_records, [
    {
      issue_id: "issue-1",
      pr_number: 7,
      parked_head_sha: "head-b",
      parked_at: "2026-06-26T10:05:00.000Z",
    },
    {
      issue_id: "issue-2",
      pr_number: 8,
      parked_head_sha: "head-c",
      parked_at: "2026-06-26T10:10:00.000Z",
    },
  ]);

  const reloaded = createLocalTriggerStore({ repoRoot, home: repoRoot });
  assert.equal(reloaded.parkRecords({ issueId: "issue-1" }).parked_head_sha, "head-b");
  assert.deepEqual(reloaded.deleteParkRecord("missing-issue"), { ok: true });
  assert.equal(reloaded.parkRecords().length, 2);
  assert.deepEqual(reloaded.deleteParkRecord("issue-1"), { ok: true });
  assert.equal(reloaded.parkRecords({ issueId: "issue-1" }), null);
  assert.deepEqual(reloaded.deleteParkRecord("issue-1"), { ok: true });
  assert.deepEqual(reloaded.parkRecords().map((record) => record.issue_id), ["issue-2"]);
});

test("local trigger store persists one cloned briefing record per issue, upsert by issue id", () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: () => new Date("2026-06-26T10:00:00.000Z"),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });

  assert.deepEqual(readLocalTriggerState(localTriggerStorePath(repoRoot)).briefing_records, []);
  assert.equal(store.briefingRecords({ issueId: "issue-1" }), null);

  const first = store.upsertBriefingRecord({
    issue_id: "issue-1",
    head_sha: "head-a",
    run_id: "run-1",
    comment_id: "comment-1",
    posted_at: "2026-06-26T10:00:00.000Z",
    ignored: "extra-field",
  });
  assert.deepEqual(Object.keys(first), ["issue_id", "head_sha", "run_id", "comment_id", "posted_at"]);

  first.head_sha = "mutated";
  assert.equal(store.briefingRecords({ issueId: "issue-1" }).head_sha, "head-a");

  const overwritten = store.upsertBriefingRecord({
    issue_id: "issue-1",
    head_sha: "head-b",
    run_id: "run-2",
    comment_id: "comment-2",
    posted_at: "2026-06-26T10:05:00.000Z",
  });
  assert.equal(overwritten.head_sha, "head-b");
  assert.equal(store.briefingRecords().length, 1);

  store.upsertBriefingRecord({
    issue_id: "issue-2",
    head_sha: "head-c",
    run_id: "run-3",
    comment_id: "comment-3",
    posted_at: "2026-06-26T10:10:00.000Z",
  });

  const persisted = readLocalTriggerState(localTriggerStorePath(repoRoot));
  assert.deepEqual(persisted.briefing_records, [
    {
      issue_id: "issue-1",
      head_sha: "head-b",
      run_id: "run-2",
      comment_id: "comment-2",
      posted_at: "2026-06-26T10:05:00.000Z",
    },
    {
      issue_id: "issue-2",
      head_sha: "head-c",
      run_id: "run-3",
      comment_id: "comment-3",
      posted_at: "2026-06-26T10:10:00.000Z",
    },
  ]);

  const reloaded = createLocalTriggerStore({ repoRoot, home: repoRoot });
  assert.equal(reloaded.briefingRecords({ issueId: "issue-1" }).comment_id, "comment-2");
  assert.equal(reloaded.briefingRecords({ issueId: "" }), null);
});

test("local trigger store records merge outcome on the merge run record", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow([
      "2026-06-29T10:00:00.000Z",
      "2026-06-29T10:01:00.000Z",
    ]),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });

  const claim = await store.claimSyntheticIssueWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    objectId: "issue-merge",
    workflowType: "merge",
    triggerType: "linear.issue.done",
  });
  await store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-merge-1",
    teamRef: "support-ops",
  });

  const result = store.recordMergeOutcome({
    wakeId: claim.wake.id,
    runId: "run-merge-1",
    merge_outcome: {
      issue_id: "issue-merge",
      pr_number: 7,
      head_sha: "head-a",
      outcome: "merged",
      reason: "parked head merged",
      observed_at: "2026-06-29T10:02:00.000Z",
      ignored: "extra-field",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.run.merge_outcome, {
    issue_id: "issue-merge",
    pr_number: 7,
    head_sha: "head-a",
    outcome: "merged",
    reason: "parked head merged",
    observed_at: "2026-06-29T10:02:00.000Z",
  });

  result.run.merge_outcome.outcome = "mutated";
  const persisted = readLocalTriggerState(localTriggerStorePath(repoRoot));
  assert.equal(persisted.runs.length, 1);
  assert.equal(persisted.runs[0].workflow_type, "merge");
  assert.equal(persisted.runs[0].merge_outcome.outcome, "merged");
  assert.equal(Object.hasOwn(persisted, "merge_outcomes"), false);

  const executionClaim = await store.claimSyntheticIssueWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    objectId: "issue-merge",
    workflowType: "execution",
    triggerType: "linear.issue.ready",
  });
  await store.markWakeRunning({
    wakeId: executionClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: executionClaim.leaseToken,
    runId: "run-execution-1",
    teamRef: "support-ops",
  });
  store.recordMergeOutcome({
    wakeId: executionClaim.wake.id,
    runId: "run-execution-1",
    merge_outcome: {
      issue_id: "issue-merge",
      pr_number: 7,
      head_sha: "head-a",
      outcome: "failed",
      reason: "non-merge run should not be selected",
      observed_at: "2026-06-29T10:03:00.000Z",
    },
  });

  const latest = store.findLatestMergeRunForIssuePrHead({
    issueId: "issue-merge",
    prNumber: 7,
    headSha: "head-a",
  });
  assert.equal(latest.run_id, "run-merge-1");
  latest.merge_outcome.reason = "mutated clone";
  assert.equal(
    store.findLatestMergeRunForIssuePrHead({
      issueId: "issue-merge",
      prNumber: 7,
      headSha: "head-a",
    }).merge_outcome.reason,
    "parked head merged",
  );
  assert.equal(
    store.findLatestMergeRunForIssuePrHead({
      issueId: "issue-merge",
      prNumber: 8,
      headSha: "head-a",
    }),
    null,
  );
});
