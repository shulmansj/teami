import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeLinearCache } from "../src/cache.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import {
  gatewayPollTargets,
  replaceGatewayPollTargetsForTest,
  runGatewayOnce,
} from "../src/gateway-loop.mjs";

const NO_POLL_SCOPE = Symbol("NO_POLL_SCOPE");

test("SCOPED run ignores a sibling test-prefixed Planned project", async () => {
  const result = await runGatewayPoll({
    pollScope: { projectIds: ["test-e1-planned-in-scope"] },
    plannedProjects: [
      plannedProject("test-e1-planned-sibling"),
      plannedProject("test-e1-planned-in-scope"),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.poll.domains[0].processed, [{
    action: "processed",
    inputStatus: "Planned",
    projectId: "test-e1-planned-in-scope",
  }]);
});

test("UNSCOPED run still sees the whole team", async () => {
  const projects = [
    plannedProject("test-e1-planned-a"),
    plannedProject("test-e1-planned-b"),
  ];

  const absentScope = await runGatewayPoll({ plannedProjects: projects });
  const nullProjectIds = await runGatewayPoll({
    pollScope: { projectIds: null },
    plannedProjects: projects,
  });

  assert.deepEqual(
    processedProjectIds(absentScope),
    ["test-e1-planned-a", "test-e1-planned-b"],
  );
  assert.deepEqual(
    processedProjectIds(nullProjectIds),
    ["test-e1-planned-a", "test-e1-planned-b"],
  );
});

test("SCOPED run ignores a sibling Ready issue in another project", async () => {
  const result = await runGatewayPoll({
    pollScope: { projectIds: ["test-e1-project-in-scope"] },
    readyIssues: [
      issueCandidate({ id: "test-e1-ready-other", projectId: "test-e1-project-sibling" }),
      issueCandidate({ id: "test-e1-ready-in-scope", projectId: "test-e1-project-in-scope" }),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.poll.domains[0].processed, [{
    action: "processed",
    inputStatus: "Ready",
    issueId: "test-e1-ready-in-scope",
    projectId: "test-e1-project-in-scope",
  }]);
});

test("empty pollScope projectIds processes nothing", async () => {
  const result = await runGatewayPoll({
    pollScope: { projectIds: [] },
    plannedProjects: [plannedProject("test-e1-planned-in-scope")],
    readyIssues: [issueCandidate({ id: "test-e1-ready", projectId: "test-e1-project" })],
    inProgressIssues: [issueCandidate({ id: "test-e1-progress", projectId: "test-e1-project" })],
    inReviewIssues: [issueCandidate({ id: "test-e1-review", projectId: "test-e1-project" })],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.poll.domains[0].processed, []);
});

test("invalid pollScope projectIds throws a clear error", async () => {
  await assert.rejects(
    runGatewayPoll({
      pollScope: { projectIds: "test-e1-project" },
      plannedProjects: [plannedProject("test-e1-project")],
    }),
    /invalid_poll_scope: pollScope\.projectIds must be an array of strings or null\./,
  );
});

async function runGatewayPoll({
  pollScope = NO_POLL_SCOPE,
  plannedProjects = [],
  readyIssues = [],
  inProgressIssues = [],
  inReviewIssues = [],
} = {}) {
  const repoRoot = tempRepo();
  writeDomainCache(repoRoot);
  const restore = replaceGatewayPollTargetsForTest(
    gatewayPollTargets().map((descriptor) => ({
      ...descriptor,
      async process(candidate) {
        return processedCandidate(descriptor.input_status, candidate);
      },
    })),
  );

  try {
    return await runGatewayOnce({
      repoRoot,
      config: configFixture(),
      registry: registryFixture(),
      acquireLock: () => ({ ok: true, release() {} }),
      createLinearClient: async () => clientFixture({
        plannedProjects,
        readyIssues,
        inProgressIssues,
        inReviewIssues,
      }),
      collectResumeReconciliation: async () => emptyResumeReport(),
      idempotency: {
        listReplayPending: async () => [],
        listGitReplayPending: async () => [],
      },
      ...(pollScope === NO_POLL_SCOPE ? {} : { pollScope }),
    });
  } finally {
    restore();
  }
}

function clientFixture({
  plannedProjects,
  readyIssues,
  inProgressIssues,
  inReviewIssues,
}) {
  return {
    async listPlannedProjectCandidates() {
      return page(plannedProjects);
    },
    async listReadyIssueCandidates(_teamId, input = {}) {
      if (input.readyStateId === "state-todo") return page(readyIssues);
      if (input.readyStateId === "state-in-progress") return page(inProgressIssues);
      if (input.readyStateId === "state-in-review") return page(inReviewIssues);
      return page([]);
    },
  };
}

function processedCandidate(inputStatus, candidate) {
  if (inputStatus === "Planned") {
    return {
      action: "processed",
      inputStatus,
      projectId: candidate.id,
    };
  }
  return {
    action: "processed",
    inputStatus,
    issueId: candidate.id,
  };
}

function processedProjectIds(result) {
  return result.poll.domains[0].processed.map((entry) => entry.projectId);
}

function page(candidates) {
  return {
    candidates,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function plannedProject(id) {
  return {
    id,
    name: id,
    status: { id: "status-planned", name: "Planned", type: "planned" },
  };
}

function issueCandidate({
  id,
  projectId,
  createdAt = "2026-06-25T10:00:00.000Z",
}) {
  return {
    id,
    projectId,
    createdAt,
    project: { id: projectId, name: projectId },
  };
}

function writeDomainCache(repoRoot) {
  writeLinearCache(
    path.join(repoRoot, ".teami", "domains", "domain-1", "linear.json"),
    {
      teamId: "team-1",
      issueStatuses: {
        todo: "state-todo",
        in_progress: "state-in-progress",
        in_review: "state-in-review",
      },
      projectStatuses: {
        planned: "status-planned",
      },
    },
  );
}

function registryFixture() {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [domainFixture()],
  };
}

function domainFixture() {
  return makeDomainRecord({
    domainId: "domain-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
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
      team: { key: "AF", name: "Teami" },
      issue: {
        statuses: {
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
        },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-gateway-poll-scope-"));
}
