import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import {
  computeTriggerFingerprint,
  clearMutationIntent,
  listReplayPending,
  readMutationIntent,
  readReplayPending,
  readSuppression,
  TRIGGER_FINGERPRINT_FIELD,
  writeMutationIntent,
  writeSuppression,
} from "../src/trigger-idempotency.mjs";
import {
  computeProjectSnapshotHash,
  projectSnapshotProjection,
} from "../src/project-snapshot-store.mjs";

test("computeTriggerFingerprint reuses the project snapshot projection and flips when the issue set changes", () => {
  const project = projectFixture();
  const expected = computeProjectSnapshotHash(projectSnapshotProjection({
    project,
    semanticStatus: project.status.name,
  }));

  assert.equal(computeTriggerFingerprint(project), expected);
  assert.equal(computeTriggerFingerprint(structuredClone(project)), expected);
  assert.equal(
    computeTriggerFingerprint({
      ...project,
      comments: [{
        author_id: "user-founder-1",
        body: "Answer: launch concierge onboarding first.",
        created_at: "2026-06-29T10:02:00.000Z",
      }],
    }),
    expected,
  );

  const changed = {
    ...project,
    issues: [
      ...project.issues,
      {
        id: "issue-2",
        identifier: "SUP-2",
        title: "Clarify pilot rollout",
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        labels: [],
      },
    ],
  };
  assert.notEqual(computeTriggerFingerprint(changed), expected);
});

test("mutation intent write/list/read is durable, run-id keyed, and clear removes replay pending state", () => {
  const runStoreDir = tempRunStore();
  writeRunArtifact(
    { runId: "run-commit", runStoreDir },
    runArtifact({
      runId: "run-commit",
      kind: "commit",
      domainId: "support-ops",
      projectId: "project-1",
    }),
  );

  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  fs.fsyncSync = (fd) => {
    fsyncCalls += 1;
    return originalFsync(fd);
  };
  try {
    const intent = writeMutationIntent({
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-commit",
      artifactKind: "commit",
      wakeId: "wake-1",
      startedAt: "2026-06-24T12:00:00.000Z",
      runStoreDir,
    });
    assert.equal(intent.run_id, "run-commit");
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.ok(fsyncCalls >= 1, "mutation intent write must fsync the temp file");

  assert.deepEqual(listReplayPending({ domainId: "support-ops", runStoreDir }), [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-commit",
    artifactKind: "commit",
  }]);
  assert.deepEqual(readReplayPending({ domainId: "support-ops", projectId: "project-1", runStoreDir }), {
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-commit",
    artifactKind: "commit",
  });
  assert.equal(readReplayPending({ domainId: "support-ops", projectId: "project-other", runStoreDir }), null);

  assert.deepEqual(clearMutationIntent({
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-commit",
    runStoreDir,
  }), { cleared: true });
  assert.deepEqual(listReplayPending({ domainId: "support-ops", runStoreDir }), []);
  assert.deepEqual(clearMutationIntent({
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-commit",
    runStoreDir,
  }), { cleared: false });
});

test("replay pending scan excludes resume mutation intents", () => {
  const runStoreDir = tempRunStore();
  writeRunArtifact(
    { runId: "run-resume", runStoreDir },
    runArtifact({
      runId: "run-resume",
      kind: "resume",
      domainId: "support-ops",
      projectId: "project-1",
    }),
  );
  writeMutationIntent({
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-resume",
    artifactKind: "resume",
    wakeId: "wake-resume",
    startedAt: "2026-06-24T12:00:00.000Z",
    runStoreDir,
  });

  assert.deepEqual(listReplayPending({ domainId: "support-ops", runStoreDir }), []);
  assert.equal(readReplayPending({ domainId: "support-ops", projectId: "project-1", runStoreDir }), null);
});

for (const boundary of [
  "before_temp_write",
  "after_temp_fsync",
  "after_temp_validation",
  "after_rename",
  "after_directory_fsync",
  "after_committed_validation",
]) {
  test(`mutation intent recovery is deterministic at ${boundary}`, () => {
    const runStoreDir = tempRunStore();
    assert.throws(() => writeMutationIntent({
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-intent-boundary",
      artifactKind: "commit",
      wakeId: "wake-intent-boundary",
      startedAt: "2026-07-11T12:00:00.000Z",
      runStoreDir,
      onBoundary(name) {
        if (name === boundary) throw new Error(`fault:${boundary}`);
      },
    }), new RegExp(`fault:${boundary}`));
    const committed = [
      "after_rename",
      "after_directory_fsync",
      "after_committed_validation",
    ].includes(boundary);
    assert.equal(Boolean(readMutationIntent({
      domainId: "support-ops",
      runId: "run-intent-boundary",
      runStoreDir,
    })), committed);
  });
}

test("suppression write/read returns only the matching project fingerprint", () => {
  const runStoreDir = tempRunStore();
  const fingerprint = computeTriggerFingerprint(projectFixture());
  const changedFingerprint = computeTriggerFingerprint({
    ...projectFixture(),
    issues: [],
  });
  assert.notEqual(changedFingerprint, fingerprint);

  const note = writeSuppression({
    domainId: "support-ops",
    projectId: "project-1",
    fingerprint,
    runId: null,
    terminalStatus: "rejected",
    reason: "missing_required_template",
    createdAt: "2026-06-24T12:00:00.000Z",
    runStoreDir,
  });

  assert.deepEqual(note, {
    project_id: "project-1",
    domain_id: "support-ops",
    run_id: null,
    terminal_status: "rejected",
    reason: "missing_required_template",
    [TRIGGER_FINGERPRINT_FIELD]: fingerprint,
    created_at: "2026-06-24T12:00:00.000Z",
  });
  assert.deepEqual(readSuppression({ projectId: "project-1", fingerprint, runStoreDir }), note);
  assert.equal(readSuppression({ projectId: "project-1", fingerprint: changedFingerprint, runStoreDir }), null);
});

function projectFixture() {
  return {
    id: "project-1",
    name: "Customer onboarding pilot",
    description: "Prepare the first customer onboarding pilot.",
    content: "Pilot rollout details.",
    status: { id: "status-planned", name: "Planned", type: "planned" },
    labels: [
      { id: "plabel-1", name: "Customer Experience" },
    ],
    issues: [
      {
        id: "issue-1",
        identifier: "SUP-1",
        title: "Collect pilot accounts",
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        labels: [{ id: "ilabel-1", name: "Discovery" }],
      },
    ],
  };
}

function runArtifact({ runId, kind, domainId, projectId }) {
  const base = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: "0.0.1",
    workflow_version: "0.0.1",
    run_id: runId,
    domain_id: domainId,
    workspace_id: "workspace-1",
    team_id: "team-1",
    kind,
    linear_project_id: projectId,
    runtime_assignments: {},
    runtime_metadata: {},
  };
  if (kind === "resume") {
    return {
      ...base,
      packet: {
        run_id: runId,
        discovery_issue_updates: [],
        open_questions_markdown: "",
        project_update_markdown: `run_id: ${runId}\n\nResumed.`,
      },
    };
  }
  return {
    ...base,
    terminal_output: {
      run_id: runId,
      outcome: kind,
      reason: kind === "commit" ? "synthesis_complete" : "open_questions",
      context_digest: "Run context.",
      source_refs: [],
      assumptions: [],
      constraints: [],
      risks: [],
    },
    evidence: { perspectives_run: [] },
    bounds: { rounds_used: 1, max_rounds: 2 },
    payload_schema_id: "probe-run-payload/v1",
    payload: {
      terminal_output: {
        run_id: runId,
        outcome: kind,
        reason: kind === "commit" ? "synthesis_complete" : "open_questions",
        context_digest: "Run context.",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      },
    },
  };
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-trigger-idem-"));
}
