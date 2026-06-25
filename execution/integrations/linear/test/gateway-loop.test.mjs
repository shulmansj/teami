import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import {
  acquireGatewayLock,
  decidePlannedProject,
  gatewayLockPath,
  pollGatewayDomain,
  processPlannedProject,
  replayPendingMutation,
  runFreshSyntheticWake,
  runGatewayOnce,
  runGatewayStartup,
} from "../src/gateway-loop.mjs";

const FINGERPRINT = "fingerprint-1";

test("planned-project decision checks replay before suppression and fresh", async () => {
  const replayCalls = [];
  const suppressionCalls = [];
  const replay = { domainId: "support-ops", projectId: "project-1", runId: "run-1", artifactKind: "commit" };
  const replayDecision = await decidePlannedProject({
    domainId: "support-ops",
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
    domainId: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    idempotency: {
      readReplayPending: async () => null,
      readSuppression: async () => suppression,
    },
  });
  assert.deepEqual(suppressedDecision, { action: "suppress", suppression });

  const freshDecision = await decidePlannedProject({
    domainId: "support-ops",
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
          domainId: "support-ops",
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
    collectResumeReconciliation: async () => {
      calls.push("resume");
      return emptyResumeReport();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["lock", "listReplay", "replay", "resume", "poll", "release"]);
});

test("replay clears intent only after verified completed or paused results", async () => {
  const cleared = [];
  const completed = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    projectId: "project-1",
    pending: {
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    domainContext: domainContextFixture(),
    runDecompositionFn: async () => ({ status: "completed" }),
    clearMutationIntent: async (input) => {
      cleared.push(input);
    },
  });
  assert.equal(completed.status, "verified");
  assert.equal(completed.cleared, true);
  assert.deepEqual(cleared, [{
    domainId: "support-ops",
    projectId: "project-1",
    runId: "run-1",
    repoRoot: process.cwd(),
    runStoreDir: null,
  }]);

  cleared.length = 0;
  const pending = await replayPendingMutation({
    client: {},
    config: configFixture(),
    cache: {},
    projectId: "project-1",
    pending: {
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    domainContext: domainContextFixture(),
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
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    domainContext: domainContextFixture(),
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
      domainId: "support-ops",
      projectId: "project-1",
      runId: "run-1",
      artifactKind: "commit",
    },
    domainContext: domainContextFixture(),
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
    domain: domainFixture(),
    domainContext: domainContextFixture(),
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
  const writes = [];
  const events = [];
  const client = snapshotClient(projectFixture());
  const result = await processPlannedProject({
    repoRoot,
    config: configFixture(),
    domain: domainFixture(),
    domainContext: domainContextFixture(),
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
    domainId: "support-ops",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    runId: "run-rejected",
    terminalStatus: "rejected",
    reason: "missing_required_template",
    createdAt: "2026-06-24T12:00:00.000Z",
    repoRoot,
    runStoreDir: null,
  }]);
  assert.equal(client.snapshotReads, 2);
});

test("Linear rate limits back off the domain without reporting an empty poll", async () => {
  const resetAt = Date.parse("2026-06-24T12:05:00.000Z");
  const events = [];
  const state = {
    inFlight: new Set(),
    domainBackoff: new Map(),
  };
  let clientCreates = 0;
  const rateLimit = new Error("rate limited");
  rateLimit.httpStatus = 400;
  rateLimit.errors = [{ extensions: { code: "RATELIMITED" } }];
  rateLimit.rateLimit = { scope: "complexity", resetAt, remaining: 0 };

  const first = await pollGatewayDomain({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    domain: domainFixture(),
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
  assert.equal(state.domainBackoff.get("support-ops"), resetAt);
  assert.deepEqual(events.map((event) => event.state), ["rate_limited"]);

  const second = await pollGatewayDomain({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    domain: domainFixture(),
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

test("project-context rate limits stop the current domain poll immediately", async () => {
  const resetAt = Date.parse("2026-06-24T12:10:00.000Z");
  const state = {
    inFlight: new Set(),
    domainBackoff: new Map(),
  };
  const rateLimit = new Error("context rate limited");
  rateLimit.httpStatus = 400;
  rateLimit.errors = [{ extensions: { code: "RATELIMITED" } }];
  rateLimit.rateLimit = { scope: "requests", resetAt, remaining: 0 };
  let snapshotReads = 0;

  const result = await pollGatewayDomain({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    domain: domainFixture(),
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

test("startup emits resume reconciliation as resume_attention and resume_working status events", async () => {
  const events = [];
  const startup = await runGatewayStartup({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    runTimeoutMs: 0,
    createLinearClient: async () => ({ listPlannedProjectCandidates: async () => ({ candidates: [] }) }),
    idempotency: {
      listReplayPending: async () => [],
    },
    collectResumeReconciliation: async () => ({
      ...emptyResumeReport(),
      items: [
        {
          pm_state: "Needs your decision",
          classification: "attention",
          source: "local-run",
          ref: "run-1",
          reason: "operator_question",
          detail: "Answer the open question.",
        },
        {
          pm_state: "Working",
          classification: "working",
          source: "supervisor",
          ref: "wake-1",
          reason: "runner_active",
          detail: "Runner is still active.",
        },
      ],
    }),
    emitStatus: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => event.state), ["resume_attention", "resume_working"]);
  assert.equal(events[0].ref, "run-1");
  assert.equal(events[0].pmState, "Needs your decision");
  assert.equal(events[1].ref, "wake-1");
  assert.deepEqual(startup.followUps, [
    "Verify resume crash-safety in the poll model, or extend the replay gate to resume.",
  ]);
});

test("fresh synthetic wake adapter claims a local wake and passes the claim into the runner", async () => {
  const repoRoot = tempRepo();
  const registry = registryFixture();
  const domain = domainFixture();
  const claim = {
    ok: true,
    wake: {
      id: "wake-1",
      workspace_id: "workspace-1",
      domain_id: "support-ops",
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
    domain,
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
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });
  assert.equal(runnerInput.store, store);
  assert.equal(runnerInput.claim, claim);
  assert.equal(runnerInput.domainContext.domainId, "support-ops");
});

test("gateway lock refuses a second live gateway in the same checkout", () => {
  const repoRoot = tempRepo();
  const first = acquireGatewayLock({
    repoRoot,
    idGenerator: () => "token-1",
    installHandlers: false,
  });
  assert.equal(first.ok, true);
  const second = acquireGatewayLock({
    repoRoot,
    idGenerator: () => "token-2",
    installHandlers: false,
    isProcessAlive: () => true,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "gateway_already_running");
  assert.equal(second.lockPath, gatewayLockPath(repoRoot));
  first.release();
});

function snapshotClient(project) {
  return {
    snapshotReads: 0,
    async getProjectSnapshotContext(projectId) {
      assert.equal(projectId, project.id);
      this.snapshotReads += 1;
      return structuredClone(project);
    },
  };
}

function projectFixture() {
  return {
    id: "project-1",
    name: "Customer onboarding pilot",
    description: "Prepare the pilot.",
    content: "Pilot context.",
    status: { id: "status-planned", name: "Planned", type: "planned" },
    labels: [],
    issues: [],
  };
}

function registryFixture() {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [domainFixture()],
  };
}

function domainFixture() {
  return makeDomainRecord({
    domainId: "support-ops",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "SUP",
    teamName: "Support Ops",
    webhookId: "webhook-1",
  });
}

function domainContextFixture() {
  return {
    domainId: "support-ops",
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
      domain_id: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
    },
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

function emptyResumeReport() {
  return {
    ok: true,
    summary: { item_count: 0, by_pm_state: {}, by_classification: {} },
    generated_at: "2026-06-24T12:00:00.000Z",
    items: [],
    sources: [],
  };
}

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-gateway-loop-"));
}
