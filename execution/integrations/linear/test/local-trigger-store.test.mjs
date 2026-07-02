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
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.leaseToken, "lease-1");
  assert.deepEqual(claim.wake, {
    id: "wake-1",
    workspace_id: "workspace-1",
    domain_id: "support-ops",
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
    domain_id: "support-ops",
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
    domainId: "support-ops",
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
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-1",
    artifactKind: "commit",
    wakeId: "wake-1",
    startedAt: "2026-06-24T10:02:00.000Z",
  }]);

  const completed = await store.completeWake({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    status: "completed",
    providerUpdateIds: ["issue-1", "project-update-1"],
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.wake.status, "completed");
  assert.equal(completed.run.status, "completed");
  assert.deepEqual(completed.run.provider_update_ids, ["issue-1", "project-update-1"]);
  assert.deepEqual(clears, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-1",
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
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-release",
  });
  const released = await store.releaseWake({
    wakeId: synthetic.wake.id,
    runnerId: "runner-foreign-domain",
    leaseToken: synthetic.leaseToken,
    reason: "domain_not_served",
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
    domainId: "support-ops",
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
