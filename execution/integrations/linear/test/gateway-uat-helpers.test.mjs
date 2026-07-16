import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReplayRecovery,
  cleanupProjects,
  DEFAULT_CONSECUTIVE_COMMITS,
  DEFAULT_UAT_PREFIX,
  NO_LINEAR_TEAM_MESSAGE,
  parseGatewayUatArgs,
  selectUatTeam,
} from "../uat/gateway-uat.mjs";

test("gateway UAT cleanup archives every created issue before its project", async () => {
  const calls = [];
  const context = {
    keepArtifacts: false,
    client: {
      async getProjectContext(projectId) {
        calls.push(["getProjectContext", projectId]);
        return { id: projectId, issues: [{ id: `${projectId}-1` }, { id: `${projectId}-2` }] };
      },
      async archiveIssue(issueId) {
        calls.push(["archiveIssue", issueId]);
      },
      async archiveProject(projectId) {
        calls.push(["archiveProject", projectId]);
      },
    },
  };

  const result = await cleanupProjects(context, ["project-a", "project-a"]);

  assert.equal(result.ok, true);
  assert.equal(result.archivedProjects, 1);
  assert.equal(result.archivedIssues, 2);
  assert.deepEqual(calls, [
    ["getProjectContext", "project-a"],
    ["archiveIssue", "project-a-1"],
    ["archiveIssue", "project-a-2"],
    ["archiveProject", "project-a"],
  ]);
});

test("gateway UAT cleanup leaves the project visible when any issue cannot be archived", async () => {
  const archivedProjects = [];
  const context = {
    keepArtifacts: false,
    client: {
      async getProjectContext() {
        return { id: "project-a", issues: [{ id: "issue-a" }, { id: "issue-b" }] };
      },
      async archiveIssue(issueId) {
        if (issueId === "issue-b") throw new Error("archive denied");
      },
      async archiveProject(projectId) {
        archivedProjects.push(projectId);
      },
    },
  };

  const result = await cleanupProjects(context, ["project-a"]);

  assert.equal(result.ok, false);
  assert.equal(result.archivedProjects, 0);
  assert.equal(result.archivedIssues, 1);
  assert.deepEqual(archivedProjects, []);
  assert.equal(result.results[0].action, "issue_archive_failed");
});

test("gateway UAT no-team guard fails before any live Linear setup", () => {
  assert.throws(
    () => selectUatTeam({ registry: null }),
    (error) => error.message === NO_LINEAR_TEAM_MESSAGE && error.code === "no_linear_team",
  );
  assert.throws(
    () => selectUatTeam({ registry: { teams: [{ id: "paused", status: "paused" }] } }),
    (error) => error.message === NO_LINEAR_TEAM_MESSAGE && error.code === "no_linear_team",
  );
});

test("gateway UAT team selection requires an explicit disposable team when ambiguous", () => {
  const registry = {
    teams: [
      { id: "alpha", status: "active" },
      { id: "beta", status: "active" },
    ],
  };

  assert.equal(selectUatTeam({ registry, teamRef: "beta" }).id, "beta");
  assert.throws(
    () => selectUatTeam({ registry }),
    /multiple Linear teams configured \(alpha, beta\) - pass --team <team_ref>/,
  );
});

test("gateway UAT args accept flags and env for disposable team selection", () => {
  const parsed = parseGatewayUatArgs([
    "--team",
    "uat-team",
    "--prefix",
    "AF-LIVE-UAT",
    "--consecutive",
    "3",
    "--poll-interval-ms",
    "2500",
    "--timeout-ms",
    "10000",
    "--keep-artifacts",
  ], {});

  assert.equal(parsed.teamRef, "uat-team");
  assert.equal(parsed.prefix, "AF-LIVE-UAT");
  assert.equal(parsed.consecutive, 3);
  assert.equal(parsed.pollIntervalMs, 2500);
  assert.equal(parsed.timeoutMs, 10000);
  assert.equal(parsed.keepArtifacts, true);

  const fromEnv = parseGatewayUatArgs([], {
    TEAMI_UAT_TEAM: "env-team",
    TEAMI_UAT_PREFIX: "ENV-UAT",
  });
  assert.equal(fromEnv.teamRef, "env-team");
  assert.equal(fromEnv.prefix, "ENV-UAT");
  assert.equal(fromEnv.consecutive, DEFAULT_CONSECUTIVE_COMMITS);
  assert.equal(parseGatewayUatArgs([], {}).prefix, DEFAULT_UAT_PREFIX);
});

test("gateway UAT replay classifier rejects fresh redecompose and uncleared intents", () => {
  const pending = {
    teamRef: "support",
    projectId: "project-1",
    runId: "run-1",
    artifactKind: "commit",
  };
  assert.deepEqual(
    classifyReplayRecovery({
      projectId: "project-1",
      expectedRunId: "run-1",
      pendingBefore: pending,
      pendingAfter: null,
      statuses: [
        { projectId: "project-1", state: "replaying", runId: "run-1" },
      ],
    }).ok,
    true,
  );

  const failed = classifyReplayRecovery({
    projectId: "project-1",
    expectedRunId: "run-1",
    pendingBefore: pending,
    pendingAfter: pending,
    statuses: [
      { projectId: "project-1", state: "working" },
    ],
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.reasons, [
    "missing_replaying_status",
    "fresh_decompose_seen_during_replay",
    "pending_intent_not_cleared",
  ]);
});
