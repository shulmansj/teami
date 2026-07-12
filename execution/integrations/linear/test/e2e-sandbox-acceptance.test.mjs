import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptanceRecordPasses,
  buildAcceptanceRecord,
  requireExplicitDomainId,
  runE2eSandbox,
  stepTeardown,
  verifyPollScopeApplied,
} from "../uat/e2e-sandbox.mjs";

test("verifyPollScopeApplied passes when every processed project is the seeded project", () => {
  const result = verifyPollScopeApplied(
    pollResult([
      { domainId: "domain-1", processed: [{ projectId: "project-1" }, { projectId: "project-1" }] },
      { domainId: "domain-2", processed: [] },
    ]),
    "project-1",
  );

  assert.deepEqual(result, {
    ok: true,
    processedProjectIds: ["project-1", "project-1"],
    offenders: [],
  });
});

test("verifyPollScopeApplied fails and reports an offender for a different project id", () => {
  const result = verifyPollScopeApplied(
    pollResult([{ domainId: "domain-1", processed: [{ projectId: "project-1" }, { projectId: "project-2" }] }]),
    "project-1",
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.processedProjectIds, ["project-1", "project-2"]);
  assert.deepEqual(result.offenders, [{ domainId: "domain-1", index: 1, projectId: "project-2" }]);
});

test("verifyPollScopeApplied ignores no-project bookkeeping entries but fails when the seeded project was never processed", () => {
  const result = verifyPollScopeApplied(
    pollResult([{ domainId: "domain-1", processed: [{ action: "processed" }] }]),
    "project-1",
  );

  // A processed entry with no project id is non-project poll work (a status/marker
  // sweep), not a scope violation — so it is not an offender. The run still fails
  // because the seeded project itself was never processed.
  assert.equal(result.ok, false);
  assert.deepEqual(result.processedProjectIds, [undefined]);
  assert.deepEqual(result.offenders, []);
});

test("verifyPollScopeApplied passes when the seeded project is processed alongside no-project bookkeeping entries", () => {
  // The real scoped gateway poll interleaves the seeded project (processed by several
  // targets) with no-project sweep entries; the scope held iff the seeded project was
  // processed and no OTHER project id appears.
  const result = verifyPollScopeApplied(
    pollResult([
      {
        domainId: "domain-1",
        processed: [
          { projectId: "project-1" },
          { action: "status-sweep" },
          { action: "marker-sweep" },
          { projectId: "project-1" },
        ],
      },
    ]),
    "project-1",
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.processedProjectIds, ["project-1", undefined, undefined, "project-1"]);
  assert.deepEqual(result.offenders, []);
});

test("verifyPollScopeApplied fails when nothing was processed", () => {
  const result = verifyPollScopeApplied(pollResult([{ domainId: "domain-1", processed: [] }]), "project-1");

  assert.deepEqual(result, {
    ok: false,
    processedProjectIds: [],
    offenders: [],
  });
});

test("buildAcceptanceRecord returns the exact acceptance shape", () => {
  const record = buildAcceptanceRecord({
    domain: { id: "domain-1" },
    seededProjectId: "project-1",
    pollScopeResult: { ok: true },
    produceOk: true,
    judgeOk: true,
    labelOk: true,
    teardown: { ok: true, data: { teardown_action: "archived", board_empty: true } },
  });

  assert.deepEqual(record, {
    domain: "domain-1",
    seeded_project_id: "project-1",
    poll_scope_applied: true,
    loop: { produce: true, judge: true, label: true },
    teardown_action: "archived",
    board_empty: true,
  });
  assert.deepEqual(Object.keys(record), [
    "domain",
    "seeded_project_id",
    "poll_scope_applied",
    "loop",
    "teardown_action",
    "board_empty",
  ]);
  assert.deepEqual(Object.keys(record.loop), ["produce", "judge", "label"]);
});

test("acceptanceRecordPasses is true only when every required field passes", () => {
  const passing = {
    domain: "domain-1",
    seeded_project_id: "project-1",
    poll_scope_applied: true,
    loop: { produce: true, judge: true, label: true },
    teardown_action: "archived",
    board_empty: true,
  };

  assert.equal(acceptanceRecordPasses(passing), true);
  assert.equal(acceptanceRecordPasses({ ...passing, poll_scope_applied: false }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, loop: { ...passing.loop, produce: false } }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, loop: { ...passing.loop, judge: false } }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, loop: { ...passing.loop, label: false } }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, board_empty: false }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, board_empty: null }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, teardown_action: null }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, domain: null }), false);
  assert.equal(acceptanceRecordPasses({ ...passing, seeded_project_id: null }), false);
});

test("stepTeardown archives the seeded project and passes when the test Planned board is clean", async () => {
  const archived = [];
  const { ctx, listCalls } = teardownContext({
    pages: [[]],
    archiveProject: async (projectId) => {
      archived.push(projectId);
      return { id: projectId };
    },
  });

  const result = await stepTeardown(ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { teardown_action: "archived", board_empty: true });
  assert.deepEqual(archived, ["project-1"]);
  assert.deepEqual(listCalls, [{ teamId: "team-1", input: { first: 50, after: null } }]);
});

test("stepTeardown fails when a test-prefixed Planned project remains active", async () => {
  const archived = [];
  const { ctx } = teardownContext({
    pages: [[{ id: "project-lingering", name: "AF-E2E lingering decomposition" }]],
    archiveProject: async (projectId) => {
      archived.push(projectId);
      return { id: projectId };
    },
  });

  const result = await stepTeardown(ctx);

  assert.equal(result.ok, false);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /AF-E2E lingering decomposition/);
  assert.deepEqual(result.data, { teardown_action: "archived", board_empty: false });
  assert.deepEqual(archived, ["project-1"]);
});

test("runE2eSandbox fails closed when --domain is missing", async () => {
  const message = /uat:e2e-sandbox requires --domain <id> \(integration smoke targets one explicit domain\)/;

  assert.throws(() => requireExplicitDomainId({}), message);
  assert.equal(requireExplicitDomainId({ domainId: "domain-1" }), "domain-1");
  await assert.rejects(
    () => runE2eSandbox({ repoRoot: process.cwd(), keep: false, label: "good", preflightOnly: true }),
    message,
  );
});

function pollResult(domains) {
  return { poll: { domains } };
}

function teardownContext({ pages, archiveProject }) {
  const listCalls = [];
  const client = {
    async listPlannedProjectCandidates(teamId, input = {}) {
      listCalls.push({ teamId, input });
      const pageIndex = listCalls.length - 1;
      return {
        candidates: pages[pageIndex] || [],
        pageInfo: {
          hasNextPage: pageIndex < pages.length - 1,
          endCursor: pageIndex < pages.length - 1 ? `cursor-${pageIndex + 1}` : null,
        },
      };
    },
    async updateProject() {
      throw new Error("updateProject should not be called when archiveProject exists");
    },
  };
  if (archiveProject) client.archiveProject = archiveProject;
  return {
    ctx: {
      domain: { linear: { team_id: "team-1" } },
      project: { id: "project-1" },
      shape: { projectStatuses: { backlog: { id: "status-backlog" } } },
      client,
    },
    listCalls,
  };
}
