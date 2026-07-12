import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendMutationReconciliation,
  findMutationReconciliation,
  mutationReconciliationJournalPath,
  planMutationRecovery,
  readMutationReconciliationJournal,
} from "../src/mutation-reconciliation-journal.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-reconciliation-journal-"));
}

function appendFixture(home, overrides = {}) {
  return appendMutationReconciliation({
    home,
    domainId: "domain-1",
    objectType: "project",
    objectId: "project-1",
    runId: overrides.runId || "run-1",
    wakeId: overrides.wakeId || "wake-1",
    status: overrides.status || "completed",
    providerUpdateIds: overrides.providerUpdateIds || ["update-1"],
    intentDigest: "b".repeat(64),
    artifactKind: "commit",
    effectEvidenceDigest: "c".repeat(64),
    reconciledAt: overrides.reconciledAt || "2026-07-11T12:00:00.000Z",
    ...(overrides.onBoundary ? { onBoundary: overrides.onBoundary } : {}),
  });
}

test("reconciliation journal is ordered, hash-chained, and queryable by durable scope", () => {
  const home = tempHome();
  try {
    const first = appendFixture(home);
    const second = appendFixture(home, {
      runId: "run-2",
      wakeId: "wake-2",
      status: "paused",
      providerUpdateIds: ["comment-1"],
      reconciledAt: "2026-07-11T12:01:00.000Z",
    });
    const records = readMutationReconciliationJournal({ home });
    assert.equal(records.length, 2);
    assert.equal(first.prior_record_hash, null);
    assert.equal(second.prior_record_hash, first.record_hash);
    assert.equal(findMutationReconciliation({
      records,
      domainId: "domain-1",
      objectType: "project",
      objectId: "project-1",
      runId: "run-2",
    })?.record_id, second.record_id);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reconciliation journal rejects a modified committed record", () => {
  const home = tempHome();
  try {
    appendFixture(home);
    const journalPath = mutationReconciliationJournalPath(home);
    const record = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    record.status = "rejected";
    fs.writeFileSync(journalPath, `${JSON.stringify(record)}\n`);
    assert.throws(
      () => readMutationReconciliationJournal({ home }),
      /mutation_reconciliation_journal_hash_mismatch/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recovery planner enumerates every intent and receipt crash state", () => {
  const intent = { run_id: "run-1" };
  const receipt = { record_id: "receipt-1", record_hash: "a".repeat(64) };
  const terminalWake = {
    mutation_reconciliation: {
      receipt_id: receipt.record_id,
      receipt_hash: receipt.record_hash,
    },
  };
  assert.deepEqual(planMutationRecovery(), { state: "none", action: "none" });
  assert.deepEqual(planMutationRecovery({ intent }), {
    state: "intent_only",
    action: "reconcile_external_effect",
  });
  assert.deepEqual(planMutationRecovery({ intent, receipt }), {
    state: "intent_and_receipt",
    action: "persist_terminal_then_clear_intent",
  });
  assert.deepEqual(planMutationRecovery({ intent, receipt, terminalWake }), {
    state: "intent_and_receipt",
    action: "clear_redundant_intent",
  });
  assert.deepEqual(planMutationRecovery({ receipt }), {
    state: "receipt_only",
    action: "reconstruct_terminal_from_receipt",
  });
  assert.deepEqual(planMutationRecovery({ receipt, terminalWake }), {
    state: "receipt_only",
    action: "done",
  });
});

for (const boundary of [
  "before_temp_write",
  "after_temp_fsync",
  "after_temp_validation",
  "after_rename",
  "after_directory_fsync",
  "after_committed_validation",
]) {
  test(`reconciliation append is recoverable at ${boundary}`, () => {
    const home = tempHome();
    try {
      assert.throws(() => appendFixture(home, {
        onBoundary(name) {
          if (name === boundary) throw new Error(`fault:${boundary}`);
        },
      }), new RegExp(`fault:${boundary}`));
      const journalPath = mutationReconciliationJournalPath(home);
      const committed = ["after_rename", "after_directory_fsync", "after_committed_validation"].includes(boundary);
      assert.equal(fs.existsSync(journalPath), committed);
      assert.equal(readMutationReconciliationJournal({ home }).length, committed ? 1 : 0);
      assert.equal(fs.existsSync(`${journalPath}.lock`), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
