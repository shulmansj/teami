import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readRunArtifact } from "../../../engine/run-store.mjs";
import {
  appendMutationReconciliation,
  mutationReconciliationJournalPath,
  readMutationReconciliationJournal,
} from "../src/mutation-reconciliation-journal.mjs";
import {
  legacyMutationIntentDigest,
} from "../../../engine/legacy-team-state-compat.mjs";
import {
  localTriggerStorePath,
  readLocalTriggerState,
  recoverLocalMutationReconciliation,
} from "../src/local-trigger-store.mjs";
import {
  readMutationIntent,
  writeMutationIntent,
} from "../src/trigger-idempotency.mjs";
import {
  readTraceReceipt,
  traceTelemetryPaths,
} from "../src/trace-status-store.mjs";
import { TRACE_RECEIPT_SCHEMA_VERSION } from "../../../engine/trace-contract.mjs";

test("released run artifacts remain readable from their prior location and identity field", () => {
  withTempHome((home) => {
    const fixturePath = path.join(
      import.meta.dirname,
      "fixtures",
      "run-artifacts",
      "neutral-v1-commit.json",
    );
    const artifact = legacyizeIdentity(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
    artifact.run_id = "run-before-team-rename";
    artifact.domain_id = "support-ops";
    const oldPath = path.join(
      home,
      "domains",
      "support-ops",
      "runs",
      `${artifact.run_id}.json`,
    );
    writeJson(oldPath, artifact);

    const loaded = readRunArtifact({
      home,
      teamRef: "support-ops",
      runId: artifact.run_id,
    });

    assert.equal(loaded.team_ref, "support-ops");
    assert.equal(Object.hasOwn(loaded, "domain_id"), false);
    assert.equal(fs.existsSync(oldPath), true);
  });
});

test("prior run-state filesystem failures expose only current Team terminology", () => {
  withTempHome((home) => {
    fs.writeFileSync(path.join(home, "domains"), "not-a-directory", "utf8");

    let error = null;
    try {
      readRunArtifact({
        home,
        teamRef: "support-ops",
        runId: "run-before-team-rename",
      });
    } catch (caught) {
      error = caught;
    }

    assert.match(error?.message || "", /Prior Team run state could not be read safely/);
    assert.doesNotMatch(error.message, /domain/i);
    assert.equal(error.cause?.message, "unsupported_prior_team_run_entry");
  });
});

test("released gateway state is normalized in memory without discarding wakes or runs", () => {
  withTempHome((home) => {
    writeJson(localTriggerStorePath(home), {
      schema_version: "teami-local-trigger-store/v1",
      wakes: [{ id: "wake-1", domain_id: "support-ops" }],
      events: [{ id: "event-1", domain_id: "support-ops" }],
      runs: [{ run_id: "run-1", domain_id: "support-ops" }],
      park_records: [],
      briefing_records: [],
      dead_letters: [],
    });

    const state = readLocalTriggerState(localTriggerStorePath(home));

    assert.equal(state.wakes[0].team_ref, "support-ops");
    assert.equal(state.events[0].team_ref, "support-ops");
    assert.equal(state.runs[0].team_ref, "support-ops");
  });
});

test("released reconciliation journal chains are verified before being promoted", () => {
  withTempHome((home) => {
    appendMutationReconciliation({
      home,
      teamRef: "support-ops",
      objectType: "project",
      objectId: "project-1",
      runId: "run-1",
      wakeId: "wake-1",
      status: "completed",
      providerUpdateIds: ["update-1"],
      intentDigest: "b".repeat(64),
      artifactKind: "commit",
      effectEvidenceDigest: "c".repeat(64),
      reconciledAt: "2026-07-15T12:00:00.000Z",
    });
    const journalPath = mutationReconciliationJournalPath(home);
    writeLegacyJournal(journalPath, readJsonLines(journalPath));

    const records = readMutationReconciliationJournal({ home });

    assert.equal(records[0].team_ref, "support-ops");
    assert.equal(Object.hasOwn(records[0], "domain_id"), false);

    appendMutationReconciliation({
      home,
      teamRef: "support-ops",
      objectType: "project",
      objectId: "project-1",
      runId: "run-2",
      wakeId: "wake-2",
      status: "paused",
      providerUpdateIds: ["comment-1"],
      intentDigest: "d".repeat(64),
      artifactKind: "pause",
      effectEvidenceDigest: "e".repeat(64),
      reconciledAt: "2026-07-15T12:01:00.000Z",
    });
    assert.equal(readMutationReconciliationJournal({ home }).length, 2);
    assert.doesNotMatch(fs.readFileSync(journalPath, "utf8"), /domain_id/);
  });
});

test("released journal normalization plus append remains atomic at every persistence boundary", () => {
  const boundaries = [
    "before_temp_write",
    "after_temp_fsync",
    "after_temp_validation",
    "after_rename",
    "after_directory_fsync",
    "after_committed_validation",
  ];
  for (const boundary of boundaries) {
    withTempHome((home) => {
      appendMutationReconciliation({
        home,
        teamRef: "support-ops",
        objectType: "project",
        objectId: "project-1",
        runId: "run-1",
        wakeId: "wake-1",
        status: "completed",
        providerUpdateIds: ["update-1"],
        intentDigest: "b".repeat(64),
        artifactKind: "commit",
        effectEvidenceDigest: "c".repeat(64),
        reconciledAt: "2026-07-15T12:00:00.000Z",
      });
      const journalPath = mutationReconciliationJournalPath(home);
      writeLegacyJournal(journalPath, readJsonLines(journalPath));

      assert.throws(() => appendMutationReconciliation({
        home,
        teamRef: "support-ops",
        objectType: "project",
        objectId: "project-2",
        runId: "run-2",
        wakeId: "wake-2",
        status: "paused",
        providerUpdateIds: ["update-2"],
        intentDigest: "d".repeat(64),
        artifactKind: "pause",
        effectEvidenceDigest: "e".repeat(64),
        reconciledAt: "2026-07-15T12:01:00.000Z",
        onBoundary: (seen) => {
          if (seen === boundary) throw new Error(`crash_at:${boundary}`);
        },
      }), new RegExp(`crash_at:${boundary}`));

      const recovered = readMutationReconciliationJournal({ home });
      assert.ok(recovered.length === 1 || recovered.length === 2);
      assert.equal(recovered[0].team_ref, "support-ops");
      if (recovered.length === 2) assert.equal(recovered[1].run_id, "run-2");
    });
  }
});

test("terminal wake references to released journal hashes are rebuilt from the verified current chain", () => {
  withTempHome((home) => {
    appendMutationReconciliation({
      home,
      teamRef: "support-ops",
      objectType: "project",
      objectId: "project-1",
      runId: "run-terminal",
      wakeId: "wake-terminal",
      status: "completed",
      providerUpdateIds: ["update-1"],
      intentDigest: "b".repeat(64),
      artifactKind: "commit",
      effectEvidenceDigest: "c".repeat(64),
      reconciledAt: "2026-07-15T12:00:00.000Z",
    });
    const journalPath = mutationReconciliationJournalPath(home);
    writeLegacyJournal(journalPath, readJsonLines(journalPath));
    const releasedReceipt = readJsonLines(journalPath)[0];
    writeJson(localTriggerStorePath(home), legacyizeIdentity({
      schema_version: "teami-local-trigger-store/v1",
      wakes: [{
        id: "wake-terminal",
        object_type: "project",
        object_id: "project-1",
        run_id: "run-terminal",
        team_ref: "support-ops",
        status: "completed",
        mutation_reconciliation: {
          receipt_id: releasedReceipt.record_id,
          receipt_hash: releasedReceipt.record_hash,
        },
      }],
      events: [],
      runs: [],
      park_records: [],
      briefing_records: [],
      dead_letters: [],
    }));

    const recovered = recoverLocalMutationReconciliation({ home, repoRoot: home });
    const currentReceipt = readMutationReconciliationJournal({ home })[0];
    const wake = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];

    assert.deepEqual(recovered.actions, [{
      wake_id: "wake-terminal",
      action: "terminal_reconstructed",
    }]);
    assert.notEqual(currentReceipt.record_hash, releasedReceipt.record_hash);
    assert.equal(wake.mutation_reconciliation.receipt_hash, currentReceipt.record_hash);
  });
});

test("an in-flight released mutation reconciles without a false digest mismatch", () => {
  withTempHome((home) => {
    const teamRef = "support-ops";
    const runId = "run-in-flight";
    const wakeId = "wake-in-flight";
    const intent = writeMutationIntent({
      home,
      teamRef,
      projectId: "project-1",
      runId,
      artifactKind: "commit",
      wakeId,
      startedAt: "2026-07-15T12:00:00.000Z",
    });
    const releasedDigest = legacyMutationIntentDigest(intent);
    const intentPath = path.join(
      home,
      "teams",
      teamRef,
      "runs",
      "unconfirmed-linear-mutation-intents",
      `${runId}.json`,
    );
    writeJson(intentPath, legacyizeIdentity(JSON.parse(fs.readFileSync(intentPath, "utf8"))));
    writeJson(localTriggerStorePath(home), legacyizeIdentity({
      schema_version: "teami-local-trigger-store/v1",
      wakes: [{
        id: wakeId,
        object_type: "project",
        object_id: "project-1",
        run_id: runId,
        team_ref: teamRef,
        status: "running",
      }],
      events: [],
      runs: [{ wake_id: wakeId, run_id: runId, team_ref: teamRef, status: "running" }],
      park_records: [],
      briefing_records: [],
      dead_letters: [],
    }));
    appendMutationReconciliation({
      home,
      teamRef,
      objectType: "project",
      objectId: "project-1",
      runId,
      wakeId,
      status: "completed",
      reason: "applied",
      providerUpdateIds: ["update-1"],
      intentDigest: releasedDigest,
      artifactKind: "commit",
      effectEvidenceDigest: "f".repeat(64),
      reconciledAt: "2026-07-15T12:01:00.000Z",
    });
    const journalPath = mutationReconciliationJournalPath(home);
    writeLegacyJournal(journalPath, readJsonLines(journalPath));

    const recovered = recoverLocalMutationReconciliation({ home, repoRoot: home });

    assert.deepEqual(recovered.actions.map((action) => action.action), [
      "terminal_reconstructed",
      "redundant_intent_cleared",
    ]);
    assert.equal(readLocalTriggerState(localTriggerStorePath(home)).wakes[0].status, "completed");
    assert.equal(readMutationIntent({ home, teamRef, runId }), null);
  });
});

test("a current-format intent rejects a receipt carrying only the released digest", () => {
  withTempHome((home) => {
    const teamRef = "support-ops";
    const runId = "run-current-intent";
    const wakeId = "wake-current-intent";
    const intent = writeMutationIntent({
      home,
      teamRef,
      projectId: "project-1",
      runId,
      artifactKind: "commit",
      wakeId,
      startedAt: "2026-07-15T12:00:00.000Z",
    });
    const intentPath = path.join(
      home,
      "teams",
      teamRef,
      "runs",
      "unconfirmed-linear-mutation-intents",
      `${runId}.json`,
    );
    const mixedIntent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
    mixedIntent.domain_id = teamRef;
    writeJson(intentPath, mixedIntent);
    writeJson(localTriggerStorePath(home), {
      schema_version: "teami-local-trigger-store/v1",
      wakes: [{
        id: wakeId,
        object_type: "project",
        object_id: "project-1",
        run_id: runId,
        team_ref: teamRef,
        status: "running",
      }],
      events: [],
      runs: [{ wake_id: wakeId, run_id: runId, team_ref: teamRef, status: "running" }],
      park_records: [],
      briefing_records: [],
      dead_letters: [],
    });
    appendMutationReconciliation({
      home,
      teamRef,
      objectType: "project",
      objectId: "project-1",
      runId,
      wakeId,
      status: "completed",
      reason: "applied",
      providerUpdateIds: ["update-1"],
      intentDigest: legacyMutationIntentDigest(intent),
      artifactKind: "commit",
      effectEvidenceDigest: "f".repeat(64),
      reconciledAt: "2026-07-15T12:01:00.000Z",
    });

    const recovered = recoverLocalMutationReconciliation({ home, repoRoot: home });

    assert.deepEqual(recovered.actions, [{
      wake_id: wakeId,
      action: "fail_closed_digest_mismatch",
    }]);
    const wake = readLocalTriggerState(localTriggerStorePath(home)).wakes[0];
    assert.equal(wake.mutation_reconciliation_required, true);
    assert.equal(wake.mutation_reconciliation_reason, "intent_receipt_digest_mismatch");
    assert.ok(readMutationIntent({ home, teamRef, runId }));
  });
});

test("released trace receipts remain readable under the Team vocabulary", () => {
  withTempHome((home) => {
    const runId = "run-trace-old";
    const receiptPath = path.join(traceTelemetryPaths(home).runsDir, `${runId}.json`);
    writeJson(receiptPath, {
      schema_version: TRACE_RECEIPT_SCHEMA_VERSION,
      run_id: runId,
      domain_id: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      trace_status: "trace_exported",
    });

    const receipt = readTraceReceipt({ repoRoot: home, runId });

    assert.equal(receipt.team_ref, "support-ops");
    assert.equal(Object.hasOwn(receipt, "domain_id"), false);
  });
});

function legacyizeIdentity(value) {
  if (Array.isArray(value)) return value.map(legacyizeIdentity);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const oldKey =
      key === "team_ref"
        ? "domain_id"
        : key === "teamRef"
          ? "domainId"
          : key === "teami.team_ref"
            ? "teami.domain_id"
            : key;
    result[oldKey] = legacyizeIdentity(entry);
  }
  return result;
}

function writeLegacyJournal(filePath, records) {
  let priorHash = null;
  const migrated = records.map((record) => {
    const legacy = legacyizeIdentity(record);
    legacy.prior_record_hash = priorHash;
    const { record_hash: _discarded, ...unsigned } = legacy;
    legacy.record_hash = hash(unsigned);
    priorHash = legacy.record_hash;
    return legacy;
  });
  fs.writeFileSync(filePath, `${migrated.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").map(JSON.parse);
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withTempHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-state-compat-"));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
