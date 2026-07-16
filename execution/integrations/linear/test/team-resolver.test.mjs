import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { resolveForegroundTeamCache } from "../src/team-command-context.mjs";
import { sanitizeProjectMcpError } from "../src/project-mcp-tools.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  makeTeamRecord,
} from "../src/team-registry.mjs";
import {
  allowedRepoPacketFromTeamResources,
  behaviorRepoIdForRepoRoot,
  buildTeamContext,
  resolveForegroundTeamContext,
  resolveWakeTeamContext,
} from "../src/team-resolver.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const home = repoRoot;

test("Exactly-one-intersection resolves; zero returns no context; two-plus active teams fail as cross-team conflict", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
    team("team-c", { workspaceId: "workspace-2", teamId: "team-c", webhookId: "webhook-c" }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    home,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["team-a", "external-team"] },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.teamRef, "team-a");
  assert.equal(resolved.context.linear.cachePath, path.join(home, "teams", "team-a", "linear.json"));
  assert.equal(Object.isFrozen(resolved.context), true);
  assert.equal(Object.isFrozen(resolved.context.linear), true);

  const zero = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["external-team"] },
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, "no_team_project_team_intersection");
  assert.deepEqual(zero.candidates, []);
  assert.equal(zero.context, undefined);

  const ambiguous = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["team-a", "team-b"] },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "cross_team_conflict");
  assert.deepEqual(ambiguous.candidates[0], candidate("team-a", { workspaceId: "workspace-1" }));
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.teamRef), ["team-a", "team-b"]);
  assert.equal(ambiguous.context, undefined);
});

test("Webhook match fails closed when project teamIds intersect two active governed teams", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "team-b"],
    },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "cross_team_conflict");
  assert.deepEqual(resolved.candidates, [
    candidate("team-a", { workspaceId: "workspace-1" }),
    candidate("team-b", { workspaceId: "workspace-1" }),
  ]);
  assert.equal(resolved.context, undefined);
});

test("Webhook match resolves when project teamIds intersect only that active governed team", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "external-team"],
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.teamRef, "team-a");
});

test("Project teamIds intersecting one active and one non-active team resolve to the active team", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", {
      workspaceId: "workspace-1",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "team-b"],
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.teamRef, "team-a");
});

test("Workspace-only selector fails when one active and one paused team share a workspace", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", {
      workspaceId: "workspace-1",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1" },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "insufficient_wake_identity");
  assert.deepEqual(resolved.candidates, [
    candidate("team-a", { workspaceId: "workspace-1" }),
    candidate("team-b", { workspaceId: "workspace-1", status: "paused" }),
  ]);
});

test("Team rename/key change does not affect resolution (ids only)", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamKey: "NEW",
      teamName: "Renamed In Linear",
      webhookId: "webhook-a",
    }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamName: "Old Name That Must Not Route",
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.teamRef, "team-a");
  assert.equal(resolved.context.linear.teamName, "Renamed In Linear");
  assert.equal(resolved.context.linear.teamKey, "NEW");
});

test("Team id mismatch fails closed even when the name matches", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamName: "Matching Name",
      webhookId: "webhook-a",
    }),
  ]);

  const resolved = resolveWakeTeamContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", teamId: "team-wrong", teamName: "Matching Name" },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "team_id_mismatch");
  assert.equal(resolved.context, undefined);
});

test("Multi-team registry plus no --team returns an explicit foreground command error", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", { workspaceId: "workspace-2", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveForegroundTeamContext({ registry, config, repoRoot });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "team_required");
  assert.match(resolved.message, /--team <team_ref>/);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.teamRef), ["team-a", "team-b"]);
});

test("ambiguous same-named Teams expose enough workspace context for an agent to choose safely", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("operations-east", {
      workspaceId: "workspace-east",
      workspaceName: "Acme East",
      teamId: "linear-team-east",
      teamKey: "OPS",
      teamName: "Operations",
      webhookId: "webhook-east",
    }),
    team("operations-west", {
      workspaceId: "workspace-west",
      workspaceName: "Acme West",
      teamId: "linear-team-west",
      teamKey: "OPS",
      teamName: "Operations",
      webhookId: "webhook-west",
    }),
  ]);

  const resolved = resolveForegroundTeamContext({ registry, config, repoRoot });
  assert.equal(resolved.ok, false);
  assert.deepEqual(resolved.candidates, [
    candidate("operations-east", {
      workspaceId: "workspace-east",
      workspaceName: "Acme East",
      teamId: "linear-team-east",
      teamKey: "OPS",
      teamName: "Operations",
    }),
    candidate("operations-west", {
      workspaceId: "workspace-west",
      workspaceName: "Acme West",
      teamId: "linear-team-west",
      teamKey: "OPS",
      teamName: "Operations",
    }),
  ]);

  const error = new Error("selection required");
  error.reason = resolved.reason;
  error.candidates = resolved.candidates;
  assert.deepEqual(sanitizeProjectMcpError(error).error.candidates, resolved.candidates);
});

test("doctor and gateway foreground startup read per-team cache, not legacy cache", () => {
  const config = loadLinearConfig({ repoRoot });
  const tempRoot = path.join(repoRoot, ".tmp-team-command-test");
  const registry = registryWithTeams([
    team("support-ops", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
  ]);
  const seen = [];

  for (const commandName of ["doctor", "gateway", "gateway status"]) {
    const resolved = resolveForegroundTeamCache({
      registry,
      config,
      repoRoot: tempRoot,
      home: tempRoot,
      readCache: (cachePath) => {
        seen.push({ commandName, cachePath });
        return { teamRef: "support-ops", workspaceId: "workspace-1", teamId: "team-a" };
      },
    });
    assert.equal(resolved.context.teamRef, "support-ops");
  }

  assert.deepEqual(
    seen.map((item) => [item.commandName, item.cachePath.replace(/\\/g, "/")]),
    [
      ["doctor", `${tempRoot.replace(/\\/g, "/")}/teams/support-ops/linear.json`],
      ["gateway", `${tempRoot.replace(/\\/g, "/")}/teams/support-ops/linear.json`],
      ["gateway status", `${tempRoot.replace(/\\/g, "/")}/teams/support-ops/linear.json`],
    ],
  );
});

test("Single active foreground team resolves implicitly but wake routing never uses foreground fallback", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    team("team-b", {
      workspaceId: "workspace-2",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const foreground = resolveForegroundTeamContext({ registry, config, repoRoot });
  assert.equal(foreground.ok, true);
  assert.equal(foreground.context.teamRef, "team-a");

  const wake = resolveWakeTeamContext({ registry, config, repoRoot, selector: {} });
  assert.equal(wake.ok, false);
  assert.equal(wake.reason, "missing_workspace_id");
});

test("TeamContext trace contains stable IDs and no team name", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithTeams([
    team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
  ]);

  const resolved = resolveForegroundTeamContext({ registry, config, repoRoot });

  assert.equal(resolved.ok, true);
  assert.deepEqual(Object.keys(resolved.context.trace).sort(), [
    "behavior_repo_id",
    "team_id",
    "team_ref",
    "workspace_id",
  ]);
  assert.equal(resolved.context.trace.team_ref, "team-a");
  assert.equal(resolved.context.trace.workspace_id, "workspace-1");
  assert.equal(resolved.context.trace.team_id, "team-a");
  assert.equal(resolved.context.trace.behavior_repo_id, behaviorRepoIdForRepoRoot(repoRoot));
  assert.equal(Object.hasOwn(resolved.context.trace, "team_name"), false);
});

test("allowed repo packet exposes the S1 wire shape from team resources", () => {
  const resources = [
    {
      id: "git_repo:acme/portal",
      kind: "git_repo",
      role: "primary",
      binding: {
        owner: "Acme",
        repo: "Portal",
        default_branch: "main",
      },
    },
    {
      id: "git_repo:acme/api",
      kind: "git_repo",
      role: "secondary",
      binding: {
        owner: "Acme",
        repo: "Api",
        default_branch: "trunk",
        repo_scope: "automation",
      },
    },
    {
      id: "linear_project",
      kind: "linear_project",
      role: "context",
      binding: {
        owner: "ignored",
        repo: "ignored",
        default_branch: "ignored",
      },
    },
  ];
  const expected = [
    {
      resource_id: "git_repo:acme/portal",
      owner: "Acme",
      repo: "Portal",
      default_branch: "main",
    },
    {
      resource_id: "git_repo:acme/api",
      owner: "Acme",
      repo: "Api",
      default_branch: "trunk",
      repo_scope: "automation",
    },
  ];

  assert.deepEqual(allowedRepoPacketFromTeamResources(resources), expected);

  const teamRecord = {
    ...team("team-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    resources,
  };
  const context = buildTeamContext({ team: teamRecord, config: null, repoRoot });
  assert.deepEqual(context.allowedRepoPacket, allowedRepoPacketFromTeamResources(teamRecord.resources));
  assert.deepEqual(context.allowedRepoPacket, expected);
});

function registryWithTeams(teams) {
  return {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams,
  };
}

function team(id, {
  workspaceId,
  workspaceName = "Example Workspace",
  teamId,
  teamKey = "AF",
  teamName = "Teami",
  webhookId,
  status = "active",
} = {}) {
  return makeTeamRecord({
    teamRef: id,
    status,
    workspaceId,
    workspaceName,
    teamId,
    teamKey,
    teamName,
    teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    webhookId,
  });
}

function candidate(id, {
  status = "active",
  workspaceId,
  workspaceName = "Example Workspace",
  teamId = id,
  teamKey = "AF",
  teamName = "Teami",
} = {}) {
  return {
    teamRef: id,
    status,
    workspaceId,
    workspaceName,
    teamId,
    teamKey,
    teamName,
  };
}
