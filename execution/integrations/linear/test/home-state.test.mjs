import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { homeStateProbe, HOME_STATE } from "../src/cli/home-state.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";

// All fixtures place the config at the default repo-relative path under a scratch repoRoot, so the
// probe resolves it without an env override. Clear any inherited override for this process.
delete process.env.TEAMI_LINEAR_CONFIG;

const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleConfigPath = path.join(realRepoRoot, "execution", "integrations", "linear", "config.example.json");

function freshRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "af-home-state-"));
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "af-home-state-home-"));
}

function writeValidConfig(repoRoot) {
  const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(exampleConfigPath, target);
  return target;
}

function writeActiveRegistry(home) {
  const registry = emptyTeamRegistry();
  registry.teams.push(
    makeTeamRecord({
      teamRef: "main",
      status: "active",
      workspaceId: "workspace-main",
      workspaceName: "Example Workspace",
      teamId: "team-main",
      teamKey: "AF",
      teamName: "Teami",
      teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    }),
  );
  writeTeamRegistry({ home }, registry);
}

function writeGatewayLock(home, lock) {
  const lockPath = path.join(home, "gateway.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, "utf8");
}

function cleanup(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

test("uninitialized: a fresh checkout with no config and no registry", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  const previous = process.env.TEAMI_LINEAR_CONFIG;
  try {
    process.env.TEAMI_LINEAR_CONFIG = path.join(repoRoot, "missing-config.json");
    const result = homeStateProbe({ repoRoot, home });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.hasConfig, false);
  } finally {
    if (previous === undefined) delete process.env.TEAMI_LINEAR_CONFIG;
    else process.env.TEAMI_LINEAR_CONFIG = previous;
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("uninitialized: config present but the team registry has not been written", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.hasConfig, true);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("uninitialized: registry exists but has no active team", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    writeTeamRegistry({ home }, emptyTeamRegistry());
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.activeTeamRef, null);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("degraded: a present-but-unreadable config", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  const previous = process.env.TEAMI_LINEAR_CONFIG;
  try {
    const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ not valid json", "utf8");
    process.env.TEAMI_LINEAR_CONFIG = target;
    const result = homeStateProbe({ repoRoot, home });
    assert.equal(result.state, HOME_STATE.DEGRADED);
  } finally {
    if (previous === undefined) delete process.env.TEAMI_LINEAR_CONFIG;
    else process.env.TEAMI_LINEAR_CONFIG = previous;
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("degraded: a present-but-corrupt team registry", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    const registryPath = path.join(home, "teams.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, "{ corrupt", "utf8");
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.DEGRADED);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("idle: active team, no gateway lock", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(home);
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.IDLE);
    assert.equal(result.evidence.activeTeamRef, "main");
    assert.equal(result.evidence.lockLive, false);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("idle: active team with a stale (invalid-pid) gateway lock", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(home);
    writeGatewayLock(home, { pid: 0, token: "x", created_at: new Date().toISOString() });
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.IDLE);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("listening: active team with a live gateway lock", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(home);
    // The current test process is alive, so its pid makes the lock live.
    writeGatewayLock(home, { pid: process.pid, token: "x", created_at: new Date().toISOString() });
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.LISTENING);
    assert.equal(result.evidence.lockLive, true);
  } finally {
    cleanup(repoRoot);
    cleanup(home);
  }
});

test("the probe is strictly read-only: it makes no filesystem writes", () => {
  const repoRoot = freshRepo();
  const home = freshHome();
  // A fully-set-up fixture so the probe exercises its complete read path (config + registry + lock).
  writeValidConfig(repoRoot);
  writeActiveRegistry(home);
  writeGatewayLock(home, { pid: process.pid, token: "x", created_at: new Date().toISOString() });

  const guarded = ["writeFileSync", "mkdirSync", "openSync", "rmSync", "renameSync", "appendFileSync", "copyFileSync"];
  const originals = {};
  for (const name of guarded) {
    originals[name] = fs[name];
    fs[name] = () => {
      throw new Error(`home-state probe attempted fs.${name} (must be read-only)`);
    };
  }
  try {
    const result = homeStateProbe({ repoRoot, home, config: {} });
    assert.equal(result.state, HOME_STATE.LISTENING);
  } finally {
    for (const name of guarded) fs[name] = originals[name];
    cleanup(repoRoot);
    cleanup(home);
  }
});
