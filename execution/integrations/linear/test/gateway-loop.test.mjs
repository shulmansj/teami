import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TEAM_REGISTRY_SCHEMA_VERSION, makeTeamRecord } from "../src/team-registry.mjs";
import {
  acquireGatewayLock,
  decidePlannedProject,
  gatewayLockPath,
  pollGatewayTeam,
  processPlannedProject,
  replayPendingMutation,
  runFreshSyntheticWake,
  runGatewayOnce,
} from "../src/gateway-loop.mjs";

const FINGERPRINT = "fingerprint-1";

test("planned-project decision checks replay before suppression and fresh", async () => {
  const replayCalls = [];
  const suppressionCalls = [];
  const replay = { teamRef: "support-ops", projectId: "project-1", runId: "run-1", artifactKind: "commit" };
  const replayDecision = await decidePlannedProject({
    teamRef: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    idempotency: {
      readReplayPending: async (input) => {
        replayCalls.push(input);
        return replay;
      },
      readSuppression: async (input) => {
        suppressionCalls.push(input);
        return { reason: "must_not_be_read" };
      },
    },
  });
  assert.deepEqual(replayDecision, { action: "replay", replay });
  assert.equal(replayCalls.length, 1);
  assert.equal(suppressionCalls.length, 0);

  const suppression = { reason: "same_rejected_fingerprint" };
  const suppressedDecision = await decidePlannedProject({
    teamRef: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    idempotency: {
      readReplayPending: async () => null,
      readSuppression: async () => suppression,
    },
  });
  assert.deepEqual(suppressedDecision, { action: "suppress", suppression });

  const freshDecision = await decidePlannedProject({
    teamRef: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    idempotency: {
      readReplayPending: async () => null,
      readSuppression: async () => null,
    },
  });
  assert.deepEqual(freshDecision, { action: "fresh" });
});

test("gateway startup drains replay before the first planned-project poll", async () => {
  const calls = [];
  const registry = registryFixture();
  const client = {
    async listPlannedProjectCandidates() {
      calls.push("poll");
      return {
        candidates: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
  };

  const result = await runGatewayOnce({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry,
    runTimeoutMs: 0,
    acquireLock: () => {
      calls.push("lock");
      return {
        ok: true,
        release: () => calls.push("release"),
      };
    },
    createLinearClient: async () => client,
    idempotency: {
      listReplayPending: async () => {
        calls.push("listReplay");
        return [{
          teamRef: "support-ops",
          projectId: "project-1",
          runId: "run-1",
          artifactKind: "commit",
        }];
      },
    },
    runReplayProject: async () => {
      calls.push("replay");
      return { status: "verified", cleared: true, result: { status: "completed" } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["lock", "listReplay", "replay", "poll", "release"]);
});

test("replay clears intent only after verified completed or paused results", async () => {
  const cleared = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-replay-home-"));
  const completed = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    home,
    projectId: "project-1",
    pending: {
      teamRef: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    teamContext: teamContextFixture(),
    runDecompositionFn: async () => ({ status: "completed" }),
    clearMutationIntent: async (input) => {
      cleared.push(input);
    },
  });
  assert.equal(completed.status, "verified");
  assert.equal(completed.cleared, true);
  assert.deepEqual(cleared, [{
    teamRef: "support-ops",
    projectId: "project-1",
    runId: "run-1",
    repoRoot: process.cwd(),
    home,
    runStoreDir: null,
  }]);

  cleared.length = 0;
  const pending = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    home,
    projectId: "project-1",
    pending: {
      teamRef: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    teamContext: teamContextFixture(),
    runDecompositionFn: async () => ({ status: "pending", reason: "linear_issues_verify_failed" }),
    clearMutationIntent: async (input) => {
      cleared.push(input);
    },
  });
  assert.equal(pending.status, "degraded");
  assert.equal(pending.cleared, false);
  assert.deepEqual(cleared, []);
});

test("replay scope mismatch is dead-letter disposition and does not clear intent", async () => {
  const cleared = [];
  const result = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    projectId: "project-1",
    pending: {
      teamRef: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    teamContext: teamContextFixture(),
    runDecompositionFn: async () => {
      throw new Error("artifact_project_mismatch: wrong project");
    },
    clearMutationIntent: async (input) => {
      cleared.push(input);
    },
  });

  assert.equal(result.status, "dead_letter");
  assert.equal(result.cleared, false);
  assert.deepEqual(cleared, []);
});

test("transient replay errors degrade and keep the mutation intent", async () => {
  const cleared = [];
  const result = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    projectId: "project-1",
    pending: {
      teamRef: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    teamContext: teamContextFixture(),
    runDecompositionFn: async () => {
      throw new Error("temporary Linear read failure");
    },
    clearMutationIntent: async (input) => {
      cleared.push(input);
    },
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.cleared, false);
  assert.equal(result.reason, "temporary Linear read failure");
  assert.deepEqual(cleared, []);
});

test("suppressed decision emits repair state and does not run fresh decomposition", async () => {
  const events = [];
  let freshCalls = 0;
  const result = await processPlannedProject({
    repoRoot: tempRepo(),
    config: configFixture(),
    team: teamFixture(),
    teamContext: teamContextFixture(),
    client: snapshotClient(projectFixture()),
    candidate: { id: "project-1" },
    runTimeoutMs: 0,
    emitStatus: (event) => events.push(event),
    idempotency: {
      computeTriggerFingerprint: () => FINGERPRINT,
      readReplayPending: async () => null,
      readSuppression: async () => ({ reason: "same_fingerprint_rejected" }),
    },
    runFreshProject: async () => {
      freshCalls += 1;
      return { status: "completed" };
    },
  });

  assert.equal(result.action, "suppress");
  assert.equal(freshCalls, 0);
  assert.deepEqual(events.map((event) => event.state), ["suppressed"]);
  assert.equal(events[0].projectId, "project-1");
});

test("fresh rejected result writes suppression only when the project remains planned at the same fingerprint", async () => {
  const repoRoot = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-fresh-suppression-home-"));
  const writes = [];
  const events = [];
  const client = snapshotClient(projectFixture());
  const result = await processPlannedProject({
    repoRoot,
    home,
    config: configFixture(),
    cache: cacheFixture(),
    team: teamFixture(),
    teamContext: teamContextFixture(),
    client,
    candidate: { id: "project-1" },
    runTimeoutMs: 0,
    now: () => new Date("2026-06-24T12:00:00.000Z"),
    emitStatus: (event) => events.push(event),
    idempotency: {
      computeTriggerFingerprint: () => FINGERPRINT,
      readReplayPending: async () => null,
      readSuppression: async () => null,
      writeSuppression: async (input) => {
        writes.push(input);
        return input;
      },
    },
    runFreshProject: async () => ({
      status: "rejected",
      reason: "missing_required_template",
      wake: { run_id: "run-rejected" },
    }),
  });

  assert.equal(result.action, "fresh");
  assert.deepEqual(events.map((event) => event.state), ["working"]);
  assert.deepEqual(writes, [{
    teamRef: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    runId: "run-rejected",
    terminalStatus: "rejected",
    reason: "missing_required_template",
    createdAt: "2026-06-24T12:00:00.000Z",
    repoRoot,
    home,
    runStoreDir: null,
  }]);
  assert.equal(client.snapshotReads, 2);
});

test("fresh rejected result writes no suppression when the project is in a same-category attention status", async () => {
  const repoRoot = tempRepo();
  const writes = [];
  const events = [];
  const client = snapshotClient([
    projectFixture(),
    projectFixture({
      status: { id: "status-principal-escalation", name: "Principal Escalation", type: "planned" },
    }),
  ]);
  const result = await processPlannedProject({
    repoRoot,
    config: configFixture(),
    cache: cacheFixture(),
    team: teamFixture(),
    teamContext: teamContextFixture(),
    client,
    candidate: { id: "project-1" },
    runTimeoutMs: 0,
    now: () => new Date("2026-06-24T12:00:00.000Z"),
    emitStatus: (event) => events.push(event),
    idempotency: {
      computeTriggerFingerprint: () => FINGERPRINT,
      readReplayPending: async () => null,
      readSuppression: async () => null,
      writeSuppression: async (input) => {
        writes.push(input);
        return input;
      },
    },
    runFreshProject: async () => ({
      status: "rejected",
      reason: "missing_required_template",
      wake: { run_id: "run-rejected" },
    }),
  });

  assert.equal(result.action, "fresh");
  assert.deepEqual(events.map((event) => event.state), ["working"]);
  assert.deepEqual(writes, []);
  assert.equal(client.snapshotReads, 2);
});

test("paused project result writes no suppression so moving back to Planned fires fresh again", async () => {
  const repoRoot = tempRepo();
  const writes = [];
  const events = [];
  const client = snapshotClient(projectFixture());
  let freshRuns = 0;
  const idempotency = {
    computeTriggerFingerprint: () => FINGERPRINT,
    readReplayPending: async () => null,
    readSuppression: async () => null,
    writeSuppression: async (input) => {
      writes.push(input);
      return input;
    },
  };
  const options = {
    repoRoot,
    config: configFixture(),
    cache: cacheFixture(),
    team: teamFixture(),
    teamContext: teamContextFixture(),
    client,
    candidate: { id: "project-1" },
    runTimeoutMs: 0,
    now: () => new Date("2026-06-24T12:00:00.000Z"),
    emitStatus: (event) => events.push(event),
    idempotency,
    runFreshProject: async () => {
      freshRuns += 1;
      return freshRuns === 1
        ? { status: "paused", reason: "product_questions", wake: { run_id: "run-paused" } }
        : { status: "completed", reason: "synthesis_complete", wake: { run_id: "run-resumed" } };
    },
  };

  const paused = await processPlannedProject(options);
  const refired = await processPlannedProject(options);

  assert.equal(paused.action, "fresh");
  assert.equal(paused.result.status, "paused");
  assert.equal(refired.action, "fresh");
  assert.equal(refired.result.status, "completed");
  assert.equal(freshRuns, 2);
  assert.deepEqual(writes, []);
  assert.deepEqual(events.map((event) => event.state), ["working", "working"]);
});

test("app-actor Planned move is accepted as actorless candidate and does not refire at same fingerprint", async () => {
  const repoRoot = tempRepo();
  const events = [];
  const candidate = { id: "project-1" };
  let freshRuns = 0;
  let sameFingerprintSeen = false;
  const idempotency = {
    computeTriggerFingerprint: () => FINGERPRINT,
    readReplayPending: async () => null,
    readSuppression: async () => sameFingerprintSeen
      ? { reason: "same_fingerprint_app_actor_commit" }
      : null,
  };
  const options = {
    repoRoot,
    config: configFixture(),
    cache: cacheFixture(),
    team: teamFixture(),
    teamContext: teamContextFixture(),
    client: snapshotClient(projectFixture()),
    candidate,
    runTimeoutMs: 0,
    emitStatus: (event) => events.push(event),
    idempotency,
    runFreshProject: async () => {
      freshRuns += 1;
      sameFingerprintSeen = true;
      return { status: "completed", reason: "decomposition_complete" };
    },
  };

  const accepted = await processPlannedProject(options);
  const refired = await processPlannedProject(options);

  assert.deepEqual(Object.keys(candidate), ["id"]);
  assert.equal(accepted.action, "fresh");
  assert.equal(accepted.result.status, "completed");
  assert.equal(refired.action, "suppress");
  assert.equal(freshRuns, 1);
  assert.deepEqual(events.map((event) => event.state), ["working", "suppressed"]);
});

test("Linear rate limits back off the team without reporting an empty poll", async () => {
  const resetAt = Date.parse("2026-06-24T12:05:00.000Z");
  const events = [];
  const state = {
    inFlight: new Set(),
    teamBackoff: new Map(),
  };
  let clientCreates = 0;
  const rateLimit = new Error("rate limited");
  rateLimit.httpStatus = 400;
  rateLimit.errors = [{ extensions: { code: "RATELIMITED" } }];
  rateLimit.rateLimit = { scope: "complexity", resetAt, remaining: 0 };

  const first = await pollGatewayTeam({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state,
    now: () => new Date("2026-06-24T12:00:00.000Z"),
    emitStatus: (event) => events.push(event),
    createLinearClient: async () => {
      clientCreates += 1;
      return {
        async listPlannedProjectCandidates() {
          throw rateLimit;
        },
      };
    },
  });
  assert.equal(first.status, "rate_limited");
  assert.equal(first.nextAttemptAt, resetAt);
  assert.equal(state.teamBackoff.get("support-ops"), resetAt);
  assert.deepEqual(events.map((event) => event.state), ["rate_limited"]);

  const second = await pollGatewayTeam({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state,
    now: () => new Date("2026-06-24T12:01:00.000Z"),
    createLinearClient: async () => {
      clientCreates += 1;
      throw new Error("should not create a client while backing off");
    },
  });
  assert.equal(second.status, "backing_off");
  assert.equal(clientCreates, 1);
});

test("project-context rate limits stop the current team poll immediately", async () => {
  const resetAt = Date.parse("2026-06-24T12:10:00.000Z");
  const state = {
    inFlight: new Set(),
    teamBackoff: new Map(),
  };
  const rateLimit = new Error("context rate limited");
  rateLimit.httpStatus = 400;
  rateLimit.errors = [{ extensions: { code: "RATELIMITED" } }];
  rateLimit.rateLimit = { scope: "requests", resetAt, remaining: 0 };
  let snapshotReads = 0;

  const result = await pollGatewayTeam({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state,
    now: () => new Date("2026-06-24T12:00:00.000Z"),
    createLinearClient: async () => ({
      async listPlannedProjectCandidates() {
        return {
          candidates: [{ id: "project-1" }, { id: "project-2" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      async getProjectSnapshotContext() {
        snapshotReads += 1;
        throw rateLimit;
      },
    }),
  });

  assert.equal(result.status, "rate_limited");
  assert.equal(result.nextAttemptAt, resetAt);
  assert.equal(result.processed.length, 1);
  assert.equal(snapshotReads, 1);
});

test("fresh synthetic wake adapter claims a local wake and passes the claim into the runner", async () => {
  const repoRoot = tempRepo();
  const registry = registryFixture();
  const team = teamFixture();
  const claim = {
    ok: true,
    wake: {
      id: "wake-1",
      workspace_id: "workspace-1",
      team_ref: "support-ops",
      object_id: "project-1",
      team_ids: ["team-1"],
    },
    leaseToken: "lease-1",
    event: { id: "event-1" },
  };
  let claimInput = null;
  let runnerInput = null;
  const store = {
    async claimSyntheticWake(input) {
      claimInput = input;
      return claim;
    },
  };

  const result = await runFreshSyntheticWake({
    repoRoot,
    config: configFixture(),
    registry,
    team,
    projectId: "project-1",
    createStore: () => store,
    createTraceSink: () => ({ shutdown: async () => {} }),
    createRuntimeExecutor: (input) => ({ input }),
    runTriggeredDecompositionFn: async (input) => {
      runnerInput = input;
      return { status: "completed", wake: { run_id: "run-1" } };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(claimInput, {
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });
  assert.equal(runnerInput.store, store);
  assert.equal(runnerInput.claim, claim);
  assert.equal(runnerInput.teamContext.teamRef, "support-ops");
});

test("gateway lock refuses a second live gateway in the same checkout", () => {
  const repoRoot = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-gateway-home-"));
  const first = acquireGatewayLock({
    repoRoot,
    home,
    idGenerator: () => "token-1",
    installHandlers: false,
  });
  assert.equal(first.ok, true);
  const second = acquireGatewayLock({
    repoRoot,
    home,
    idGenerator: () => "token-2",
    installHandlers: false,
    isProcessAlive: () => true,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "gateway_already_running");
  assert.equal(second.lockPath, gatewayLockPath(home));
  assert.ok(!fs.existsSync(path.join(repoRoot, ".teami", "gateway.lock")));
  first.release();
});

test("gateway lock publishes only a complete owner record", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-gateway-atomic-publish-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lockPath = gatewayLockPath(home);
  const fsApi = Object.create(fs);
  fsApi.renameSync = (source, destination) => {
    if (destination !== lockPath) return fs.renameSync(source, destination);
    const error = new Error("simulated gateway crash before atomic publish");
    error.code = "EIO";
    throw error;
  };

  assert.throws(
    () => acquireGatewayLock({ home, installHandlers: false, fsApi }),
    /simulated gateway crash before atomic publish/,
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(home).filter((name) => name.includes(".tmp")),
    [],
  );
  const recovered = acquireGatewayLock({ home, installHandlers: false });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.release(), true);
});

for (const collisionCode of ["ENOTEMPTY", "EACCES"]) {
  test(`a delayed stale gateway reclaimer cannot move a fresh owner (${collisionCode})`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-gateway-stale-race-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const lockPath = gatewayLockPath(home);
    const crashed = acquireGatewayLock({
      home,
      installHandlers: false,
      pid: 7777,
      isProcessAlive: () => true,
    });
    assert.equal(crashed.ok, true);
    let freshOwner = null;
    const fsApi = Object.create(fs);
    fsApi.renameSync = (source, destination) => {
      if (source === lockPath && destination.includes(".stale-")) {
        freshOwner = acquireGatewayLock({
          home,
          installHandlers: false,
          pid: 8888,
          isProcessAlive: (candidatePid) => candidatePid !== 7777,
        });
        assert.equal(freshOwner.ok, true);
        const collision = new Error("simulated delayed gateway reclaimer collision");
        collision.code = collisionCode;
        throw collision;
      }
      return fs.renameSync(source, destination);
    };

    const delayed = acquireGatewayLock({
      home,
      installHandlers: false,
      pid: 9999,
      isProcessAlive: (candidatePid) => candidatePid !== 7777,
      fsApi,
    });
    assert.equal(delayed.ok, false);
    assert.equal(delayed.reason, "gateway_already_running");
    assert.equal(crashed.release(), false);
    assert.equal(freshOwner.release(), true);
  });
}

function snapshotClient(projectOrProjects) {
  const projects = Array.isArray(projectOrProjects) ? projectOrProjects : [projectOrProjects];
  return {
    snapshotReads: 0,
    async getProjectSnapshotContext(projectId) {
      const project = projects[Math.min(this.snapshotReads, projects.length - 1)];
      assert.equal(projectId, project.id);
      this.snapshotReads += 1;
      return structuredClone(project);
    },
  };
}

function projectFixture(overrides = {}) {
  return {
    id: "project-1",
    name: "Customer onboarding pilot",
    description: "Prepare the pilot.",
    content: "Pilot context.",
    status: { id: "status-planned", name: "Planned", type: "planned" },
    labels: [],
    issues: [],
    ...overrides,
  };
}

function registryFixture() {
  return {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [teamFixture()],
  };
}

function teamFixture() {
  return makeTeamRecord({
    teamRef: "support-ops",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "SUP",
    teamName: "Support Ops",
    webhookId: "webhook-1",
  });
}

function teamContextFixture() {
  return {
    teamRef: "support-ops",
    status: "active",
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "SUP",
      teamName: "Support Ops",
      webhookId: "webhook-1",
      cachePath: "unused",
    },
    trace: {
      team_ref: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
    },
  };
}

function cacheFixture() {
  return {
    projectStatuses: { planned: "status-planned" },
  };
}

function configFixture() {
  return {
    poll: { interval_ms: 10_000 },
    linear: {
      oauth: {
        credential_storage: "file",
        client_id: "client-id",
        redirect_uri: "http://localhost/callback",
      },
      team: { key: "SUP", name: "Support Ops" },
    },
    inbox: {
      base_url: "https://inbox.test",
      webhook_url: "https://inbox.test/webhook",
      credential_storage: "file",
      runner: {
        lease_duration_ms: 1000,
        required_capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
      },
    },
  };
}

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-gateway-loop-"));
}
