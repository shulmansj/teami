import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  registerResourceKind,
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  createAtomicTeamRegistryWriter,
  teamCacheRelativePath,
  teamRegistryPath,
  emptyTeamRegistry,
  makeTeamRecord,
  mintTeamRef,
  readTeamRegistry,
  removeTeamRegistryState,
  updateTeamLinearLabels,
  updateTeamRegistry,
  upsertTeamRecord,
  validateTeamRegistry,
  writeTeamRegistry,
} from "../src/team-registry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Minting requires an explicit name; ids are path-safe, immutable, collision-suffixed", () => {
  assert.throws(() => mintTeamRef(""), /explicit team name/i);
  assert.throws(() => mintTeamRef("!!!"), /at least one ASCII letter or digit/i);
  assert.equal(mintTeamRef("Customer Success Pilot"), "customer-success-pilot");
  assert.equal(mintTeamRef("Customer Success Pilot", ["customer-success-pilot"]), "customer-success-pilot-2");
  assert.equal(
    mintTeamRef("Customer Success Pilot", ["customer-success-pilot", "customer-success-pilot-2"]),
    "customer-success-pilot-3",
  );
  assert.match(mintTeamRef("A/B: East_2026"), /^[a-z0-9-]+$/);

  const team = makeTeamRecord({
    teamRef: "customer-success-pilot",
    status: "active",
    workspaceId: "workspace-1",
    teamId: "team-1",
    teamKey: "CSP",
    teamName: "Customer Success Pilot",
    webhookId: "webhook-1",
  });
  const renamed = updateTeamLinearLabels(
    { schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] },
    "customer-success-pilot",
    { teamName: "Customer Success", teamKey: "CS", seenAt: "2026-06-11T00:00:00.000Z" },
  ).teams[0];

  assert.equal(renamed.id, "customer-success-pilot");
  assert.equal(renamed.linear.cache_path, "teams/customer-success-pilot/linear.json");
});

test("Default records carry an empty resources list without requiring registered resource kinds", () => {
  resetResourceRegistry();
  const team = makeTeamRecord({ teamRef: "main" });

  assert.deepEqual(team.resources, []);
  validateTeamRegistry({ schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] });
});

test("Active local-poll teams do not require a webhook id", () => {
  const team = makeTeamRecord({
    teamRef: "local-poll",
    status: "active",
    workspaceId: "workspace-1",
    teamId: "team-1",
    teamKey: "LP",
    teamName: "Local Poll",
  });

  assert.equal(team.linear.webhook_id, null);
  validateTeamRegistry({ schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] });
});

test("Resources validate by dispatching to the registered resource-kind definition", () => {
  resetResourceRegistry();
  try {
    registerGitRepoStubResourceKind();
    const resource = gitRepoResource({ id: "primary-repo" });
    const team = makeTeamRecord({
      teamRef: "support-ops",
      status: "active",
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "SO",
      teamName: "Support Ops",
      webhookId: "webhook-1",
      resources: [resource],
    });

    assert.deepEqual(team.resources, [resource]);
    validateTeamRegistry({ schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] });
  } finally {
    resetResourceRegistry();
  }
});

test("Resources reject unknown kinds, invalid bindings, and duplicate ids", () => {
  resetResourceRegistry();
  try {
    assert.throws(
      () =>
        validateTeamRegistry({
          schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
          teams: [{ ...activeTeam("main"), resources: [gitRepoResource({ kind: "missing_kind" })] }],
        }),
      /unknown_resource_kind:missing_kind/,
    );

    registerGitRepoStubResourceKind();
    assert.throws(
      () =>
        validateTeamRegistry({
          schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
          teams: [
            {
              ...activeTeam("main"),
              resources: [gitRepoResource({ binding: { repo: "app", default_branch: "main" } })],
            },
          ],
        }),
      /git_repo_binding_missing_owner/,
    );
    assert.throws(
      () =>
        validateTeamRegistry({
          schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
          teams: [
            {
              ...activeTeam("main"),
              resources: [
                gitRepoResource({ id: "repo-a" }),
                gitRepoResource({ id: "repo-a", role: "secondary" }),
              ],
            },
          ],
        }),
      /resources_duplicate_id:repo-a/,
    );
  } finally {
    resetResourceRegistry();
  }
});

test("Resources allow multiple git_repo records when ids are unique", () => {
  resetResourceRegistry();
  try {
    registerGitRepoStubResourceKind();
    const registry = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [
        {
          ...activeTeam("main"),
          resources: [
            gitRepoResource({ id: "git_repo:acme/app" }),
            gitRepoResource({
              id: "git_repo:acme/api",
              role: "secondary",
              binding: {
                owner: "acme",
                repo: "api",
                default_branch: "main",
              },
            }),
          ],
        },
      ],
    };

    assert.equal(validateTeamRegistry(registry), true);
  } finally {
    resetResourceRegistry();
  }
});

test("A document containing default_team_ref fails validation", () => {
  const registry = emptyTeamRegistry();
  registry.default_team_ref = "main";
  assert.throws(() => validateTeamRegistry(registry), /unknown_key:registry\.default_team_ref/);
});

test("Unknown keys, invalid status, or non-path-safe id fail validation", () => {
  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        teams: [
          {
            ...activeTeam("main"),
            behavior_rules: { hidden: true },
          },
        ],
      }),
    /unknown_key:teams\[0\]\.behavior_rules/,
  );
  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        teams: [{ ...activeTeam("main"), status: "enabled" }],
      }),
    /invalid_status:main/,
  );
  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        teams: [{ ...activeTeam("main"), id: "../main" }],
      }),
    /invalid_team_ref/,
  );
});

test("One Linear Team identity cannot belong to two Teami Teams in any lifecycle state", () => {
  const first = activeTeam("east", { workspaceId: "workspace-1", teamId: "linear-team-1" });
  const second = activeTeam("west", { workspaceId: "workspace-1", teamId: "linear-team-1" });
  assert.throws(
    () => validateTeamRegistry({
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [first, second],
    }),
    /duplicate_linear_team:workspace-1:linear-team-1/,
  );

  second.status = "removed";
  assert.throws(
    () => validateTeamRegistry({
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [first, second],
    }),
    /duplicate_linear_team:workspace-1:linear-team-1/,
  );

  first.status = "setup_incomplete";
  assert.throws(
    () => validateTeamRegistry({
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [first, second],
    }),
    /duplicate_linear_team:workspace-1:linear-team-1/,
  );
});

test("Atomic Team writes preserve other Teams and reject a concurrent change to the selected Team", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-writer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const initial = upsertTeamRecord(
    upsertTeamRecord(emptyTeamRegistry(), activeTeam("east")),
    activeTeam("west"),
  );
  writeTeamRegistry({ home }, initial);
  const writeSelectedTeam = createAtomicTeamRegistryWriter({ home, initialRegistry: initial });

  updateTeamRegistry({ home }, (current) => {
    current.teams.find((team) => team.id === "west").linear.team_name = "West renamed concurrently";
    return { registry: current };
  });
  const changedEast = activeTeam("east", { teamName: "East refreshed" });
  await writeSelectedTeam(upsertTeamRecord(initial, changedEast), changedEast);
  let current = readTeamRegistry({ home });
  assert.equal(current.teams.find((team) => team.id === "east").linear.team_name, "East refreshed");
  assert.equal(current.teams.find((team) => team.id === "west").linear.team_name, "West renamed concurrently");

  const conflictingWriter = createAtomicTeamRegistryWriter({ home, initialRegistry: current });
  updateTeamRegistry({ home }, (registry) => {
    registry.teams.find((team) => team.id === "east").linear.team_key = "NEW";
    return { registry };
  });
  await assert.rejects(
    () => conflictingWriter(current, activeTeam("east", { teamName: "Stale update" })),
    (error) => error?.code === "team_registry_team_conflict",
  );
  current = readTeamRegistry({ home });
  assert.equal(current.teams.find((team) => team.id === "east").linear.team_key, "NEW");
});

test("Cached team_name/team_key can change without changing team_ref or cache path", () => {
  const registry = {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [activeTeam("main")],
  };
  const next = updateTeamLinearLabels(registry, "main", {
    teamName: "Renamed Team",
    teamKey: "RND",
    seenAt: "2026-06-11T12:00:00.000Z",
  });

  assert.equal(next.teams[0].id, "main");
  assert.equal(next.teams[0].linear.team_name, "Renamed Team");
  assert.equal(next.teams[0].linear.team_key, "RND");
  assert.equal(next.teams[0].linear.cache_path, teamCacheRelativePath("main"));
  validateTeamRegistry(next);
});

test("Registry stores the original adopter-provided team name for setup resume", () => {
  const team = makeTeamRecord({
    teamRef: "support-ops-2",
    status: "setup_incomplete",
    adopterProvidedName: "Support Ops",
    workspaceId: "workspace-1",
    workspaceName: "Example Workspace",
  });
  assert.equal(team.adopter_provided_name, "Support Ops");
  validateTeamRegistry({ schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] });

  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        teams: [{ ...team, adopter_provided_name: "" }],
      }),
    /invalid_adopter_provided_name:support-ops-2/,
  );
});

test("Registry path is ignored-local and writes are atomic with read-back validation", () => {
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.teami\/$/m);

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-registry-home-"));
  const registry = upsertTeamRecord(emptyTeamRegistry(), activeTeam("main"));
  const filePath = writeTeamRegistry({ home: tempHome }, registry);

  assert.equal(filePath, teamRegistryPath(tempHome));
  assert.deepEqual(readTeamRegistry({ home: tempHome }), registry);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((file) => file.endsWith(".tmp")),
    [],
  );
});

test("Registry schema does not allow Phoenix project fields", () => {
  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        phoenix: { project_name: "teami" },
        teams: [],
      }),
    /unknown_key:registry\.phoenix/,
  );
  assert.throws(
    () =>
      validateTeamRegistry({
        schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
        teams: [
          {
            ...activeTeam("main"),
            phoenix: { project_name: "team-project" },
          },
        ],
      }),
    /unknown_key:teams\[0\]\.phoenix/,
  );
});

test("reset removes registry and per-team cache dirs", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-reset-home-"));
  const registry = upsertTeamRecord(emptyTeamRegistry(), activeTeam("support-ops"));
  writeTeamRegistry({ home: tempHome }, registry);
  const cacheDir = path.join(tempHome, "teams", "support-ops");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "linear.json"), JSON.stringify({ teamRef: "support-ops" }));

  const removed = removeTeamRegistryState({ home: tempHome });

  assert.equal(removed.registryRemoved, true);
  assert.equal(removed.teamsDirRemoved, true);
  assert.equal(fs.existsSync(teamRegistryPath(tempHome)), false);
  assert.equal(fs.existsSync(path.join(tempHome, "teams")), false);
});

function activeTeam(id, overrides = {}) {
  return makeTeamRecord({
    teamRef: id,
    status: "active",
    workspaceId: `workspace-${id}`,
    workspaceName: "Example Workspace",
    teamId: `team-${id}`,
    teamKey: "AF",
    teamName: "Teami",
    teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    webhookId: `webhook-${id}`,
    ...overrides,
  });
}

function registerGitRepoStubResourceKind() {
  registerResourceKind({
    kind: "git_repo",
    validateBinding(binding) {
      for (const field of ["owner", "repo", "default_branch"]) {
        if (typeof binding?.[field] !== "string" || binding[field].trim() === "") {
          throw new Error(`git_repo_binding_missing_${field}`);
        }
      }
    },
    materialize: async () => ({ kind: "git_repo", handle: {}, teardown() {} }),
    manifestEntry: (resource) => ({
      kind: "git_repo",
      id: resource.id,
      role: resource.role,
      label: `${resource.binding.owner}/${resource.binding.repo}`,
    }),
  });
}

function gitRepoResource({
  id = "repo",
  kind = "git_repo",
  role = "primary",
  binding = {
    owner: "acme",
    repo: "app",
    default_branch: "main",
  },
} = {}) {
  return {
    id,
    kind,
    role,
    binding,
  };
}
