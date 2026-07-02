import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import {
  gatewayPollTargets,
  pollGatewayDomain,
  registerPollTarget,
  replaceGatewayPollTargetsForTest,
} from "../src/gateway-loop.mjs";

const FINGERPRINT = "fingerprint-1";

test("project poll runs through the registered Planned descriptor", async (t) => {
  const projectDescriptor = gatewayPollTargets().find((descriptor) => descriptor.input_status === "Planned");
  assert.ok(projectDescriptor, "the Planned project descriptor is registered");
  assert.equal(typeof projectDescriptor.listCandidates, "function");
  assert.equal(typeof projectDescriptor.process, "function");
  assert.equal(typeof projectDescriptor.inFlightKey, "function");
  assert.equal(typeof projectDescriptor.order, "function");
  assert.equal(projectDescriptor.inFlightKey({ id: "project-1" }), "project-1");

  const calls = [];
  const wrappedDescriptor = {
    ...projectDescriptor,
    async listCandidates(domainCtx, page) {
      calls.push(["descriptor-list", domainCtx.domain.id, page]);
      return projectDescriptor.listCandidates(domainCtx, page);
    },
    async process(candidate, domainCtx) {
      calls.push(["descriptor-process", candidate.id]);
      return projectDescriptor.process(candidate, domainCtx);
    },
  };
  const restore = replaceGatewayPollTargetsForTest([wrappedDescriptor]);
  t.after(restore);

  const repoRoot = tempRepo();
  const suppression = { reason: "same_fingerprint_rejected" };
  const events = [];
  const client = {
    async listPlannedProjectCandidates(teamId, page) {
      calls.push(["client-list", teamId, page]);
      assert.equal(teamId, "team-1");
      assert.deepEqual(page, { first: 25, after: null });
      return {
        candidates: [{ id: "project-1" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async getProjectSnapshotContext(projectId) {
      calls.push(["snapshot", projectId]);
      assert.equal(projectId, "project-1");
      return projectFixture();
    },
  };

  const result = await pollGatewayDomain({
    repoRoot,
    config: configFixture(),
    registry: registryFixture(),
    domain: domainFixture(),
    runTimeoutMs: 0,
    emitStatus: (event) => events.push(event),
    createLinearClient: async () => client,
    idempotency: {
      computeTriggerFingerprint: (snapshot) => {
        calls.push(["fingerprint", snapshot.id]);
        return FINGERPRINT;
      },
      readReplayPending: async (input) => {
        calls.push(["read-replay", input.projectId]);
        assert.deepEqual(input, {
          domainId: "support-ops",
          projectId: "project-1",
          repoRoot,
          runStoreDir: null,
        });
        return null;
      },
      readSuppression: async (input) => {
        calls.push(["read-suppression", input.projectId]);
        assert.deepEqual(input, {
          projectId: "project-1",
          fingerprint: FINGERPRINT,
          repoRoot,
          runStoreDir: null,
        });
        return suppression;
      },
    },
    runFreshProject: async () => {
      throw new Error("suppressed project should not run fresh decomposition");
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.processed, [{
    action: "suppress",
    projectId: "project-1",
    fingerprint: FINGERPRINT,
    suppression,
  }]);
  assert.deepEqual(events.map((event) => event.state), ["suppressed"]);
  assert.deepEqual(calls.map((call) => call[0]), [
    "descriptor-list",
    "client-list",
    "descriptor-process",
    "snapshot",
    "fingerprint",
    "read-replay",
    "read-suppression",
  ]);
});

test("a second registered descriptor is iterated by pollGatewayDomain", async (t) => {
  const calls = [];
  const unregister = registerPollTarget({
    input_status: "Ready",
    async listCandidates(domainCtx, page) {
      calls.push(["stub-list", domainCtx.domain.id, page]);
      return {
        candidates: [{ id: "issue-1" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async process(candidate) {
      calls.push(["stub-process", candidate.id]);
      return { action: "stub", id: candidate.id };
    },
    inFlightKey: (candidate) => candidate.id,
    order: () => 0,
  });
  t.after(unregister);

  const result = await pollGatewayDomain({
    repoRoot: tempRepo(),
    config: configFixture(),
    registry: registryFixture(),
    domain: domainFixture(),
    createLinearClient: async () => ({
      async listPlannedProjectCandidates() {
        calls.push(["project-list"]);
        return {
          candidates: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
    }),
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.processed, [{ action: "stub", id: "issue-1" }]);
  assert.deepEqual(calls, [
    ["project-list"],
    ["stub-list", "support-ops", { first: 25, after: null }],
    ["stub-process", "issue-1"],
  ]);
});

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-poll-target-"));
}
