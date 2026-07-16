import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalTriggerStore,
  deriveSessionHandlePointerFromRuntimeMetadata,
  localTriggerStorePath,
  readLocalTriggerState,
  runIsResumable,
} from "../src/local-trigger-store.mjs";

test("run records expose session handle pointers derived from runtime metadata", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow([
      "2026-06-25T10:00:00.000Z",
      "2026-06-25T10:01:00.000Z",
      "2026-06-25T10:02:00.000Z",
      "2026-06-25T10:03:00.000Z",
    ]),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });

  const withHandle = await store.claimSyntheticWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-with-handle",
  });
  await store.markWakeRunning({
    wakeId: withHandle.wake.id,
    runnerId: "runner-1",
    leaseToken: withHandle.leaseToken,
    runId: "run-with-handle",
    teamRef: "support-ops",
  });
  await store.completeWake({
    wakeId: withHandle.wake.id,
    runnerId: "runner-1",
    leaseToken: withHandle.leaseToken,
    status: "paused",
    artifactPointer: { artifact_path: path.join(repoRoot, "teams", "support-ops", "runs", "run-with-handle.json") },
    artifact: {
      run_id: "run-with-handle",
      runtime_metadata: {
        pm: {
          session_handle: {
            id: "session-pm",
            role: "pm",
            run_id: "run-with-handle",
            runtime: "claude",
          },
        },
        sr_eng: {
          session_handle: null,
        },
      },
    },
  });

  const withoutHandle = await store.claimSyntheticWake({
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-without-handle",
  });
  await store.markWakeRunning({
    wakeId: withoutHandle.wake.id,
    runnerId: "runner-1",
    leaseToken: withoutHandle.leaseToken,
    runId: "run-without-handle",
    teamRef: "support-ops",
  });
  await store.completeWake({
    wakeId: withoutHandle.wake.id,
    runnerId: "runner-1",
    leaseToken: withoutHandle.leaseToken,
    status: "completed",
    artifact: {
      run_id: "run-without-handle",
      runtime_metadata: {
        pm: { session_handle: null },
      },
    },
  });

  const reloaded = readLocalTriggerState(localTriggerStorePath(repoRoot));
  const runWithHandle = reloaded.runs.find((run) => run.run_id === "run-with-handle");
  const runWithoutHandle = reloaded.runs.find((run) => run.run_id === "run-without-handle");

  assert.deepEqual(runWithHandle.session_handle_pointer, {
    source: "run_artifact.runtime_metadata",
    runtime_metadata_paths: [["runtime_metadata", "pm", "session_handle"]],
  });
  assert.deepEqual(runWithHandle.artifact_pointer, {
    artifact_path: path.join(repoRoot, "teams", "support-ops", "runs", "run-with-handle.json"),
  });
  assert.equal(runIsResumable(runWithHandle), true);
  assert.equal(runIsResumable(runWithoutHandle), false);
  assert.equal(Object.hasOwn(runWithoutHandle, "session_handle_pointer"), false);

  for (const run of [runWithHandle, runWithoutHandle]) {
    assert.equal(Object.hasOwn(run, "resumable"), false);
    assert.equal(Object.hasOwn(run, "resume_from"), false);
    assert.equal(Object.hasOwn(run, "runtime_metadata"), false);
  }
  assert.equal(typeof store.resumeWake, "undefined");
  assert.equal(typeof store.resumeRun, "undefined");
});

test("session handle pointer derivation is presence based", () => {
  assert.deepEqual(
    deriveSessionHandlePointerFromRuntimeMetadata({
      drafter: {
        session_handle: {
          id: "session-drafter",
          role: "drafter",
          run_id: "run-1",
          runtime: "codex",
        },
      },
    }),
    {
      source: "run_artifact.runtime_metadata",
      runtime_metadata_paths: [["runtime_metadata", "drafter", "session_handle"]],
    },
  );
  assert.equal(deriveSessionHandlePointerFromRuntimeMetadata({ drafter: { session_handle: null } }), null);
  assert.equal(runIsResumable({ session_handle_pointer: null }), false);
});

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-session-handle-"));
  process.env.TEAMI_HOME = root;
  return root;
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
