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
import { createLocalTriggerStore } from "../src/local-trigger-store.mjs";
import {
  listReplayPending,
  readGitReplayPending,
  readReplayPending,
  writeMutationIntent,
} from "../src/trigger-idempotency.mjs";

const LEGACY_MUTATION_INTENT_SCHEMA_VERSION =
  "teami-unconfirmed-linear-mutation-intent/v1";

test("legacy project v1 mutation intents replay through the project projection", () => {
  const runStoreDir = tempRunStore();
  const domainId = "support-ops";
  const projectId = "project-legacy";
  const runId = "run-legacy";
  writeRunArtifact(
    { runId, runStoreDir },
    runArtifact({ runId, kind: "commit", domainId, projectId }),
  );

  const intentDir = path.join(runStoreDir, "unconfirmed-linear-mutation-intents");
  fs.mkdirSync(intentDir, { recursive: true });
  fs.writeFileSync(
    path.join(intentDir, `${runId}.json`),
    `${JSON.stringify({
      schema_version: LEGACY_MUTATION_INTENT_SCHEMA_VERSION,
      run_id: runId,
      artifact_kind: "commit",
      linear_project_id: projectId,
      domain_id: domainId,
      wake_id: "wake-legacy",
      started_at: "2026-06-24T12:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );

  const expected = [{
    domainId,
    projectId,
    runId,
    artifactKind: "commit",
  }];
  assert.deepEqual(listReplayPending({ domainId, runStoreDir }), expected);
  assert.deepEqual(readReplayPending({ domainId, projectId, runStoreDir }), expected[0]);
});

test("issue git mutation intents write v2 records and round-trip through git replay reads", () => {
  const runStoreDir = tempRunStore();
  const git = gitIdentity();

  const record = writeMutationIntent({
    domainId: "support-ops",
    objectType: "issue",
    objectId: "issue-123",
    runId: "run-issue",
    artifactKind: "commit",
    wakeId: "wake-issue",
    startedAt: "2026-06-24T12:00:00.000Z",
    workflowType: "execution",
    triggerType: "linear.issue.todo",
    git,
    runStoreDir,
  });

  assert.ok(record.schema_version.endsWith("/v2"));
  assert.equal(record.object_type, "issue");
  assert.equal(record.object_id, "issue-123");
  assert.equal(Object.hasOwn(record, "linear_project_id"), false);
  assert.deepEqual(record.git, git);
  assert.deepEqual(readGitReplayPending({
    domainId: "support-ops",
    objectId: "issue-123",
    runStoreDir,
  }), {
    domainId: "support-ops",
    objectId: "issue-123",
    runId: "run-issue",
    artifactKind: "commit",
    git,
  });
  assert.deepEqual(listReplayPending({ domainId: "support-ops", runStoreDir }), []);
});

test("issue git mutation intents allow the pre-push shape before observed head and tree", () => {
  const runStoreDir = tempRunStore();
  const git = {
    owner: "o",
    repo: "r",
    branch: "af/execution/AF-1-5215fde5",
    base_sha: "a".repeat(40),
  };

  const record = writeMutationIntent({
    domainId: "support-ops",
    objectType: "issue",
    objectId: "issue-123",
    runId: "run-pre-push",
    artifactKind: "commit",
    wakeId: "wake-issue",
    startedAt: "2026-06-24T12:00:00.000Z",
    workflowType: "execution",
    triggerType: "linear.issue.todo",
    git,
    runStoreDir,
  });

  assert.deepEqual(record.git, git);
  assert.deepEqual(readGitReplayPending({
    domainId: "support-ops",
    objectId: "issue-123",
    runStoreDir,
  }).git, git);
});

test("terminal completion clears project mutation intents but skips issue mutation intents", async () => {
  const repoRoot = tempRepo();
  const writes = [];
  const clears = [];
  const git = gitIdentity();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow([
      "2026-06-24T10:00:00.000Z",
      "2026-06-24T10:01:00.000Z",
      "2026-06-24T10:02:00.000Z",
      "2026-06-24T10:03:00.000Z",
      "2026-06-24T10:04:00.000Z",
      "2026-06-24T10:05:00.000Z",
      "2026-06-24T10:06:00.000Z",
      "2026-06-24T10:07:00.000Z",
    ]),
    writeMutationIntent: async (input) => {
      writes.push(input);
    },
    clearMutationIntent: async (input) => {
      clears.push(input);
    },
  });

  const projectClaim = await store.claimSyntheticWake({
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });
  await store.markWakeRunning({
    wakeId: projectClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: projectClaim.leaseToken,
    runId: "run-project",
    domainId: "support-ops",
  });
  await store.markMutationStarted({
    wakeId: projectClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: projectClaim.leaseToken,
    runId: "run-project",
    artifactKind: "commit",
  });
  assert.deepEqual(writes, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-project",
    artifactKind: "commit",
    wakeId: "wake-1",
    startedAt: "2026-06-24T10:02:00.000Z",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);
  await store.completeWake({
    wakeId: projectClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: projectClaim.leaseToken,
    status: "completed",
    providerUpdateIds: ["project-update-1"],
    reconciliationVerified: true,
    reconciliationEvidenceDigest: "b".repeat(64),
  });
  assert.deepEqual(clears, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-project",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);

  const issueClaim = await store.claimSyntheticIssueWake({
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    objectId: "issue-1",
    workflowType: "execution",
    triggerType: "linear.issue.todo",
  });
  await store.markWakeRunning({
    wakeId: issueClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: issueClaim.leaseToken,
    runId: "run-issue",
    domainId: "support-ops",
  });
  await store.markMutationStarted({
    wakeId: issueClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: issueClaim.leaseToken,
    runId: "run-issue",
    artifactKind: "commit",
    git,
  });
  assert.deepEqual(writes, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-project",
    artifactKind: "commit",
    wakeId: "wake-1",
    startedAt: "2026-06-24T10:02:00.000Z",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }, {
    domainId: "support-ops",
    objectType: "issue",
    objectId: "issue-1",
    runId: "run-issue",
    artifactKind: "commit",
    wakeId: "wake-2",
    startedAt: "2026-06-24T10:06:00.000Z",
    workflowType: "execution",
    triggerType: "linear.issue.todo",
    git,
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);
  await store.completeWake({
    wakeId: issueClaim.wake.id,
    runnerId: "runner-1",
    leaseToken: issueClaim.leaseToken,
    status: "completed",
  });

  assert.deepEqual(clears, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-project",
    repoRoot,
    home: repoRoot,
    runStoreDir: null,
  }]);
});

test("claimSyntheticIssueWake returns a leased issue wake and matching event identity", async () => {
  const repoRoot = tempRepo();
  const store = createLocalTriggerStore({
    repoRoot,
    home: repoRoot,
    idGenerator: sequenceIds(),
    now: sequenceNow(["2026-06-24T10:00:00.000Z"]),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });

  const claim = await store.claimSyntheticIssueWake({
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    objectId: "issue-1",
    workflowType: "execution",
    triggerType: "linear.issue.todo",
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.leaseToken, "lease-1");
  assert.equal(claim.wake.object_type, "issue");
  assert.equal(claim.wake.object_id, "issue-1");
  assert.equal(claim.wake.workflow_type, "execution");
  assert.equal(claim.wake.trigger_type, "linear.issue.todo");
  assert.equal(claim.wake.status, "leased");
  assert.equal(claim.event.object_type, "issue");
  assert.equal(claim.event.object_id, "issue-1");
  assert.equal(claim.event.workflow_type, "execution");
  assert.equal(claim.event.trigger_type, "linear.issue.todo");
});

function runArtifact({ runId, kind, domainId, projectId }) {
  return {
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
    terminal_output: {
      run_id: runId,
      outcome: kind,
      reason: "synthesis_complete",
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
        reason: "synthesis_complete",
        context_digest: "Run context.",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      },
    },
  };
}

function gitIdentity() {
  return {
    owner: "o",
    repo: "r",
    branch: "b",
    base_sha: "a".repeat(40),
    head_sha: "c".repeat(40),
    tree_sha: "d".repeat(40),
  };
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-object-trigger-"));
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-object-trigger-repo-"));
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
