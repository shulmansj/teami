import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { homeStateProbe, HOME_STATE } from "../src/cli/home-state.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

// All fixtures place the config at the default repo-relative path under a scratch repoRoot, so the
// probe resolves it without an env override. Clear any inherited override for this process.
delete process.env.TEAMI_LINEAR_CONFIG;

const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleConfigPath = path.join(realRepoRoot, "execution", "integrations", "linear", "config.example.json");

function freshRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "af-home-state-"));
}

// Write a valid config at the default config path under the scratch repo (config.example.json is
// the production default and validates via module-root fallback for accepted runtime roles).
function writeValidConfig(repoRoot) {
  const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(exampleConfigPath, target);
}

function writeActiveRegistry(repoRoot) {
  const registry = emptyDomainRegistry();
  registry.domains.push(
    makeDomainRecord({
      domainId: "main",
      status: "active",
      workspaceId: "workspace-main",
      workspaceName: "Example Workspace",
      teamId: "team-main",
      teamKey: "AF",
      teamName: "Teami",
      teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    }),
  );
  writeDomainRegistry({ repoRoot }, registry);
}

function writeGatewayLock(repoRoot, lock) {
  const lockPath = path.join(repoRoot, ".teami", "gateway.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, "utf8");
}

function cleanup(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

test("uninitialized: a fresh checkout with no config and no registry", () => {
  const repoRoot = freshRepo();
  try {
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.hasConfig, false);
  } finally {
    cleanup(repoRoot);
  }
});

test("uninitialized: config present but the domain registry has not been written", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.hasConfig, true);
  } finally {
    cleanup(repoRoot);
  }
});

test("uninitialized: registry exists but has no active domain", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    writeDomainRegistry({ repoRoot }, emptyDomainRegistry());
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.UNINITIALIZED);
    assert.equal(result.evidence.activeDomainId, null);
  } finally {
    cleanup(repoRoot);
  }
});

test("degraded: a present-but-unreadable config", () => {
  const repoRoot = freshRepo();
  try {
    const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ not valid json", "utf8");
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.DEGRADED);
  } finally {
    cleanup(repoRoot);
  }
});

test("degraded: a present-but-corrupt domain registry", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    const registryPath = path.join(repoRoot, ".teami", "domains.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, "{ corrupt", "utf8");
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.DEGRADED);
  } finally {
    cleanup(repoRoot);
  }
});

test("idle: active domain, no gateway lock", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(repoRoot);
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.IDLE);
    assert.equal(result.evidence.activeDomainId, "main");
    assert.equal(result.evidence.lockLive, false);
  } finally {
    cleanup(repoRoot);
  }
});

test("idle: active domain with a stale (invalid-pid) gateway lock", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(repoRoot);
    writeGatewayLock(repoRoot, { pid: 0, token: "x", created_at: new Date().toISOString() });
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.IDLE);
  } finally {
    cleanup(repoRoot);
  }
});

test("listening: active domain with a live gateway lock", () => {
  const repoRoot = freshRepo();
  try {
    writeValidConfig(repoRoot);
    writeActiveRegistry(repoRoot);
    // The current test process is alive, so its pid makes the lock live.
    writeGatewayLock(repoRoot, { pid: process.pid, token: "x", created_at: new Date().toISOString() });
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.LISTENING);
    assert.equal(result.evidence.lockLive, true);
  } finally {
    cleanup(repoRoot);
  }
});

test("the probe is strictly read-only: it makes no filesystem writes", () => {
  const repoRoot = freshRepo();
  // A fully-set-up fixture so the probe exercises its complete read path (config + registry + lock).
  writeValidConfig(repoRoot);
  writeActiveRegistry(repoRoot);
  writeGatewayLock(repoRoot, { pid: process.pid, token: "x", created_at: new Date().toISOString() });

  const guarded = ["writeFileSync", "mkdirSync", "openSync", "rmSync", "renameSync", "appendFileSync", "copyFileSync"];
  const originals = {};
  for (const name of guarded) {
    originals[name] = fs[name];
    fs[name] = () => {
      throw new Error(`home-state probe attempted fs.${name} (must be read-only)`);
    };
  }
  try {
    const result = homeStateProbe({ repoRoot });
    assert.equal(result.state, HOME_STATE.LISTENING);
  } finally {
    for (const name of guarded) fs[name] = originals[name];
    cleanup(repoRoot);
  }
});
