import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalTriggerStore,
  localTriggerStorePath,
  recoverLocalMutationReconciliation,
  readLocalTriggerState,
  writeLocalTriggerState,
} from "../src/local-trigger-store.mjs";
import { readMutationIntent } from "../src/trigger-idempotency.mjs";
import { finishWakeFromRunnerResult } from "../src/trigger-runner.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-wake-reconciliation-"));
}

async function runningMutationStore({ home, events, clearFails = false, failTerminalPersist = false }) {
  let id = 0;
  const store = createLocalTriggerStore({
    home,
    repoRoot: home,
    idGenerator: (prefix) => `${prefix}-${++id}`,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    writeMutationIntent: async () => {},
    writeReconciliationReceipt: async (input) => {
      events.push({ kind: "receipt", status: input.status });
      return {
        record_id: "receipt-1",
        record_hash: "a".repeat(64),
        reconciled_at: input.reconciledAt,
      };
    },
    clearMutationIntent: async () => {
      events.push({ kind: "clear" });
      if (clearFails) throw new Error("clear_failed");
    },
    writeState: (statePath, state) => {
      const wake = state.wakes[0];
      events.push({
        kind: "state",
        status: wake?.status || null,
        clear_pending: wake?.mutation_intent_clear_pending,
      });
      if (failTerminalPersist && wake?.status === "completed") throw new Error("terminal_persist_failed");
      writeLocalTriggerState(statePath, state);
    },
  });
  const claim = await store.claimSyntheticWake({
    domainId: "domain-1",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });
  await store.markWakeRunning({
    wakeId: claim.wake.id,
    leaseToken: claim.leaseToken,
    runnerId: "runner-1",
    runId: "run-1",
    domainId: "domain-1",
  });
  await store.markMutationStarted({
    wakeId: claim.wake.id,
    leaseToken: claim.leaseToken,
    runnerId: "runner-1",
    runId: "run-1",
    artifactKind: "commit",
  });
  events.length = 0;
  return { store, claim };
}

test("wake completion persists receipt and terminal proof before intent cleanup", async () => {
  const home = tempHome();
  const events = [];
  try {
    const { store, claim } = await runningMutationStore({ home, events });
    const result = await store.completeWake({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      status: "completed",
      providerUpdateIds: ["update-1"],
      reconciliationVerified: true,
      reconciliationEvidenceDigest: "b".repeat(64),
    });
    assert.deepEqual(events.map((event) => event.kind), ["receipt", "state", "clear", "state"]);
    assert.deepEqual(events[1], { kind: "state", status: "completed", clear_pending: true });
    assert.deepEqual(events[3], { kind: "state", status: "completed", clear_pending: false });
    assert.equal(result.wake.mutation_reconciliation.receipt_id, "receipt-1");
    assert.equal(result.wake.mutation_intent_clear_pending, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("intent cleanup failure leaves durable terminal proof and a pending cleanup flag", async () => {
  const home = tempHome();
  const events = [];
  try {
    const { store, claim } = await runningMutationStore({ home, events, clearFails: true });
    const result = await store.completeWake({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      status: "completed",
      providerUpdateIds: ["update-1"],
      reconciliationVerified: true,
      reconciliationEvidenceDigest: "b".repeat(64),
    });
    assert.equal(result.ok, true);
    assert.equal(result.wake.mutation_intent_clear_pending, true);
    const persisted = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.mutation_reconciliation.receipt_id, "receipt-1");
    assert.equal(persisted.mutation_intent_clear_pending, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("terminal persistence failure never clears the still-durable intent", async () => {
  const home = tempHome();
  const events = [];
  try {
    const { store, claim } = await runningMutationStore({ home, events, failTerminalPersist: true });
    await assert.rejects(() => store.completeWake({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      status: "completed",
      providerUpdateIds: ["update-1"],
      reconciliationVerified: true,
      reconciliationEvidenceDigest: "b".repeat(64),
    }), /terminal_persist_failed/);
    assert.deepEqual(events.map((event) => event.kind), ["receipt", "state"]);
    const persisted = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(persisted.status, "running");
    assert.equal(persisted.mutation_started_at, "2026-07-11T12:00:00.000Z");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pending provider effects retain the intent and never mint a reconciliation receipt", async () => {
  const home = tempHome();
  const events = [];
  try {
    const { store, claim } = await runningMutationStore({ home, events });
    const outcome = await finishWakeFromRunnerResult({
      store,
      wake: claim.wake,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
      result: {
        status: "pending",
        reason: "provider_verification_inconclusive",
        projectUpdate: { id: "possibly-written-update" },
      },
    });
    assert.equal(outcome.status, "dead_letter");
    assert.deepEqual(events.map((event) => event.kind), ["state"]);
    const persisted = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(persisted.status, "dead_letter");
    assert.equal(persisted.mutation_reconciliation, undefined);
    assert.equal(persisted.mutation_reconciliation_required, true);
    assert.equal(persisted.mutation_intent_cleared_at, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("startup reconstructs mutation state after intent durability wins the crash race", async () => {
  const home = tempHome();
  let failIntentStatePersist = true;
  try {
    const store = createLocalTriggerStore({
      home,
      repoRoot: home,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      writeState: (statePath, state) => {
        if (failIntentStatePersist && state.wakes[0]?.mutation_started_at) {
          throw new Error("crash_after_intent_before_wake_state");
        }
        writeLocalTriggerState(statePath, state);
      },
    });
    const claim = await store.claimSyntheticWake({
      domainId: "domain-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      projectId: "project-1",
    });
    await store.markWakeRunning({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      runId: "run-intent-crash",
      domainId: "domain-1",
    });
    await assert.rejects(() => store.markMutationStarted({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      runId: "run-intent-crash",
      artifactKind: "commit",
    }), /crash_after_intent_before_wake_state/);
    assert.ok(readMutationIntent({ domainId: "domain-1", runId: "run-intent-crash", home }));
    assert.equal(readLocalTriggerState(localTriggerStorePath(home)).wakes[0].mutation_started_at, null);

    failIntentStatePersist = false;
    const recovered = recoverLocalMutationReconciliation({ home, repoRoot: home });
    assert.deepEqual(recovered.actions, [{
      wake_id: claim.wake.id,
      action: "reconcile_external_effect",
    }]);
    const wake = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(wake.mutation_started_at, "2026-07-11T12:00:00.000Z");
    assert.equal(wake.mutation_artifact_kind, "commit");
    assert.match(wake.mutation_intent_digest, /^[0-9a-f]{64}$/);
    assert.equal(wake.mutation_reconciliation_required, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("startup closes the cleanup flag after intent deletion wins the crash race", async () => {
  const home = tempHome();
  let failFinalStatePersist = true;
  try {
    const store = createLocalTriggerStore({
      home,
      repoRoot: home,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      writeState: (statePath, state) => {
        const wake = state.wakes[0];
        if (
          failFinalStatePersist &&
          wake?.status === "completed" &&
          wake?.mutation_intent_clear_pending === false
        ) throw new Error("crash_after_intent_clear_before_wake_state");
        writeLocalTriggerState(statePath, state);
      },
    });
    const claim = await store.claimSyntheticWake({
      domainId: "domain-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      projectId: "project-1",
    });
    await store.markWakeRunning({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      runId: "run-clear-crash",
      domainId: "domain-1",
    });
    await store.markMutationStarted({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      runId: "run-clear-crash",
      artifactKind: "commit",
    });
    const completed = await store.completeWake({
      wakeId: claim.wake.id,
      leaseToken: claim.leaseToken,
      runnerId: "runner-1",
      status: "completed",
      providerUpdateIds: ["update-1"],
      reconciliationVerified: true,
      reconciliationEvidenceDigest: "b".repeat(64),
    });
    assert.equal(completed.ok, true);
    assert.equal(readMutationIntent({ domainId: "domain-1", runId: "run-clear-crash", home }), null);
    assert.equal(
      readLocalTriggerState(localTriggerStorePath(home)).wakes[0].mutation_intent_clear_pending,
      true,
    );

    failFinalStatePersist = false;
    const recovered = recoverLocalMutationReconciliation({ home, repoRoot: home });
    assert.deepEqual(recovered.actions, [{
      wake_id: claim.wake.id,
      action: "cleanup_state_finalized",
    }]);
    const wake = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(wake.status, "completed");
    assert.equal(wake.mutation_intent_clear_pending, false);
    assert.equal(wake.mutation_reconciliation_required, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
