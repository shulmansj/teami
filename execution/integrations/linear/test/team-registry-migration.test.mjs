import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateLegacyTeamRegistryState } from "../src/legacy-team-state-migration.mjs";
import { acquireGatewayLock } from "../src/gateway-loop.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  teamCacheRelativePath,
  teamRegistryPath,
  migrateTeamRegistry,
  readTeamRegistry,
  removeTeamRegistryState,
  validateTeamRegistry,
  writeTeamRegistry,
  writeTeamRegistryIfAbsent,
} from "../src/team-registry.mjs";

for (const schemaVersion of ["teami-domain-registry/v1", "teami-domain-registry/v2"]) {
  test(`readTeamRegistry promotes ${schemaVersion} state and cached context without data loss`, () => {
    withTempHome((home) => {
      const source = legacyRegistry(schemaVersion, "support-ops");
      writeJson(path.join(home, "domains.json"), source);
      writeJson(path.join(home, "domains", "support-ops", "linear.json"), {
        workspaceId: "workspace-support-ops",
        teamId: "team-support-ops",
      });

      const migrated = readTeamRegistry({ home });

      assert.equal(migrated.schema_version, TEAM_REGISTRY_SCHEMA_VERSION);
      assert.equal(migrated.teams[0].id, "support-ops");
      assert.equal(migrated.teams[0].linear.cache_path, teamCacheRelativePath("support-ops"));
      assert.equal(validateTeamRegistry(migrated), true);
      assert.equal(fs.existsSync(teamRegistryPath(home)), true);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(home, "teams", "support-ops", "linear.json"), "utf8")),
        { workspaceId: "workspace-support-ops", teamId: "team-support-ops" },
      );
      assert.equal(fs.existsSync(path.join(home, "domains.json")), true);
      assert.equal(fs.existsSync(path.join(home, "domains", "support-ops", "linear.json")), true);
    });
  });
}

test("legacy promotion resumes an additive partial destination copy without losing newer files", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "sales-ops"));
    writeJson(path.join(home, "domains", "sales-ops", "linear.json"), { source: "complete" });
    writeJson(path.join(home, "domains", "sales-ops", "runs", "prior.json"), { source: "prior" });
    writeJson(path.join(home, "teams", "sales-ops", "runs", "newer.json"), { source: "newer" });

    const first = readTeamRegistry({ home });
    const second = readTeamRegistry({ home });

    assert.deepEqual(second, first);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(home, "teams", "sales-ops", "linear.json"), "utf8")),
      { source: "complete" },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(home, "teams", "sales-ops", "runs", "prior.json"), "utf8")),
      { source: "prior" },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(home, "teams", "sales-ops", "runs", "newer.json"), "utf8")),
      { source: "newer" },
    );
  });
});

test("legacy promotion fails closed instead of overwriting conflicting Team state", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "sales-ops"));
    writeJson(path.join(home, "domains", "sales-ops", "linear.json"), { source: "prior" });
    writeJson(path.join(home, "teams", "sales-ops", "linear.json"), { source: "newer" });

    assert.throws(() => readTeamRegistry({ home }), /conflicts with current Team state/);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(home, "teams", "sales-ops", "linear.json"), "utf8")),
      { source: "newer" },
    );
  });
});

test("copy failure leaves the new registry unpublished and retryable", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    writeJson(path.join(home, "domains", "research", "linear.json"), { source: "safe" });
    let writeCalled = false;

    let error = null;
    try {
      migrateLegacyTeamRegistryState({
          home,
          destinationRegistryPath: teamRegistryPath(home),
          schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
          teamCacheRelativePath,
          validateRegistry: validateTeamRegistry,
          writeRegistry: () => {
            writeCalled = true;
          },
          copyDirectory: () => {
            throw new Error("injected copy failure");
          },
        });
    } catch (caught) {
      error = caught;
    }
    assert.match(error?.message || "", /Team state upgrade could not read or write prior local state safely/);
    assert.match(error.cause?.message || "", /injected copy failure/);

    assert.equal(writeCalled, false);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
    assert.equal(readTeamRegistry({ home }).teams[0].id, "research");
  });
});

test("legacy promotion rejects a same-content source directory replacement", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    const sourceDir = path.join(home, "domains", "research");
    writeJson(path.join(sourceDir, "linear.json"), { source: "safe" });
    let published = false;

    assert.throws(
      () => migrateLegacyTeamRegistryState({
        home,
        destinationRegistryPath: teamRegistryPath(home),
        schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
        teamCacheRelativePath,
        validateRegistry: validateTeamRegistry,
        writeRegistry: () => {
          published = true;
        },
        copyDirectory: (_source, destination) => {
          fs.renameSync(sourceDir, `${sourceDir}.original`);
          writeJson(path.join(sourceDir, "linear.json"), { source: "safe" });
          writeJson(path.join(destination, "linear.json"), { source: "safe" });
        },
      }),
      /Team state changed while it was being upgraded/,
    );
    assert.equal(published, false);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

test("a concurrent state upgrade fails closed before copying or publishing", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    let copied = false;
    let published = false;

    assert.throws(
      () => migrateLegacyTeamRegistryState({
        home,
        destinationRegistryPath: teamRegistryPath(home),
        schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
        teamCacheRelativePath,
        validateRegistry: validateTeamRegistry,
        writeRegistry: () => {
          published = true;
        },
        copyDirectory: () => {
          copied = true;
        },
        acquireLock: () => ({ ok: false, reason: "lock_held" }),
      }),
      /already running/,
    );

    assert.equal(copied, false);
    assert.equal(published, false);
  });
});

test("a live gateway in another process blocks the state upgrade", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    writeJson(path.join(home, "gateway.lock"), {
      pid: process.pid + 1000,
      token: "live-gateway",
      created_at: "2026-07-15T12:00:00.000Z",
    });

    assert.throws(
      () => migrateLegacyTeamRegistryState({
        home,
        destinationRegistryPath: teamRegistryPath(home),
        schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
        teamCacheRelativePath,
        validateRegistry: validateTeamRegistry,
        writeRegistry: () => true,
        isProcessAlive: () => true,
      }),
      /Stop the running Teami gateway/,
    );
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

test("the state upgrade reserves the gateway lock through registry publication", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    let competingGateway = null;

    const migrated = migrateLegacyTeamRegistryState({
      home,
      destinationRegistryPath: teamRegistryPath(home),
      schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
      teamCacheRelativePath,
      validateRegistry: validateTeamRegistry,
      writeRegistry: () => {
        competingGateway = acquireGatewayLock({ home, installHandlers: false });
        return true;
      },
    });

    assert.equal(migrated.teams[0].id, "research");
    assert.equal(competingGateway.ok, false);
    assert.equal(competingGateway.reason, "gateway_already_running");
    const afterUpgrade = acquireGatewayLock({ home, installHandlers: false });
    assert.equal(afterUpgrade.ok, true);
    afterUpgrade.release();
  });
});

test("an unreadable gateway lock fails the state upgrade closed", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    fs.writeFileSync(path.join(home, "gateway.lock"), "{", "utf8");

    assert.throws(
      () => readTeamRegistry({ home }),
      /gateway lock is unreadable/,
    );
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

test("a linked prior Team root is rejected without reading outside Teami home", (t) => {
  withTempHome((home) => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-registry-external-"));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    writeJson(path.join(external, "research", "linear.json"), { source: "outside" });
    if (!createDirectoryLink(t, external, path.join(home, "domains"))) return;

    assert.throws(() => readTeamRegistry({ home }), /not a supported local directory/);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(external, "research", "linear.json"), "utf8")),
      { source: "outside" },
    );
  });
});

test("a linked current Team root is rejected without writing outside Teami home", (t) => {
  withTempHome((home) => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-registry-external-"));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "research"));
    writeJson(path.join(home, "domains", "research", "linear.json"), { source: "inside" });
    if (!createDirectoryLink(t, external, path.join(home, "teams"))) return;

    assert.throws(() => readTeamRegistry({ home }), /unsupported filesystem entry/);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
    assert.deepEqual(fs.readdirSync(external), []);
  });
});

test("unregistered prior Team directories fail closed instead of appearing fresh", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains", "orphan", "linear.json"), { source: "orphan" });

    assert.throws(() => readTeamRegistry({ home }), /exists without its registry/);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

test("explicit Team reset removes retained prior recovery state", () => {
  withTempHome((home) => {
    const recoveryRegistryPath = path.join(home, "domains.json");
    const recoveryDir = path.join(home, "domains", "support-ops");
    writeJson(recoveryRegistryPath, legacyRegistry("teami-domain-registry/v2", "support-ops"));
    writeJson(path.join(recoveryDir, "linear.json"), { source: "recovery" });

    removeTeamRegistryState({ home });

    assert.equal(fs.existsSync(recoveryRegistryPath), false);
    assert.equal(fs.existsSync(recoveryDir), false);
  });
});

test("an already-published Team registry takes precedence over retained recovery state", () => {
  withTempHome((home) => {
    const current = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [validTeam("current-team")],
    };
    writeTeamRegistry({ home }, current);
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "old-team"));

    assert.deepEqual(readTeamRegistry({ home }), current);
    assert.equal(fs.existsSync(path.join(home, "teams", "old-team")), false);
  });
});

test("every current registry creation path blocks before orphaning prior Team state", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), legacyRegistry("teami-domain-registry/v2", "old-team"));
    const fresh = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [validTeam("fresh-team")],
    };

    assert.throws(
      () => writeTeamRegistry({ home }, fresh),
      /must be upgraded before creating/,
    );
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

test("exclusive registry publication never replaces a registry published by another writer", () => {
  withTempHome((home) => {
    const first = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [validTeam("first-team")],
    };
    const second = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [validTeam("second-team")],
    };
    writeTeamRegistry({ home }, first);

    assert.equal(writeTeamRegistryIfAbsent({ home }, second), false);
    assert.deepEqual(readTeamRegistry({ home }), first);
  });
});

test("migrateTeamRegistry leaves the current Team schema unchanged", () => {
  const registry = {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [validTeam("sales-ops")],
  };

  assert.deepEqual(migrateTeamRegistry(registry), registry);
  assert.equal(validateTeamRegistry(registry), true);
});

test("unsupported Team registry schema versions still fail validation loudly", () => {
  assert.throws(
    () => validateTeamRegistry({ schema_version: "teami-team-registry/v999", teams: [] }),
    /unsupported_schema_version/,
  );
});

test("malformed recovery state fails closed instead of being silently discarded", () => {
  withTempHome((home) => {
    writeJson(path.join(home, "domains.json"), {
      schema_version: "teami-domain-registry/v2",
      domains: [{ ...validTeam("support"), surprise: true }],
    });
    assert.throws(() => readTeamRegistry({ home }), /unknown_key/);
    assert.equal(fs.existsSync(teamRegistryPath(home)), false);
  });
});

function legacyRegistry(schemaVersion, id) {
  const team = validTeam(id);
  team.linear.cache_path = `domains/${id}/linear.json`;
  return { schema_version: schemaVersion, domains: [team] };
}

function validTeam(id) {
  return {
    id,
    status: "active",
    linear: {
      workspace_id: `workspace-${id}`,
      workspace_name: "Example Workspace",
      team_id: `team-${id}`,
      team_key: "AF",
      team_name: "Teami",
      team_name_last_seen_at: "2026-06-30T00:00:00.000Z",
      provisioned_by_teami: true,
      webhook_id: `webhook-${id}`,
      cache_path: teamCacheRelativePath(id),
    },
    resources: [],
    policy_profile: "default",
    policy_overlay_ref: null,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withTempHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-registry-migration-"));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function createDirectoryLink(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}
