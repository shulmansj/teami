import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGatewayCommand } from "../src/cli/runner-command.mjs";
import { teamiHomePaths } from "../src/app-home.mjs";
import { createCliOutput } from "../src/cli/cli-output.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";

// homeStateProbe resolves config from the default repo-relative path; clear any inherited override.
delete process.env.TEAMI_LINEAR_CONFIG;

const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleConfigPath = path.join(realRepoRoot, "execution", "integrations", "linear", "config.example.json");

function freshRepoWithConfig() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-gw-status-"));
  const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(exampleConfigPath, target);
  return repoRoot;
}

function writeActiveRegistry(repoRoot) {
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
  writeTeamRegistry({ home: repoRoot }, registry);
}

function capture() {
  const writes = [];
  const stream = { isTTY: false, write: (c) => (writes.push(String(c)), true) };
  // Capture stdout + stderr together (output.error writes to errStream).
  return {
    output: createCliOutput({ color: false, unicode: false, stream, errStream: stream }),
    text: () => writes.join(""),
  };
}

async function withSavedExitCode(fn) {
  const saved = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = saved;
  }
}

test("adopter `gateway status` is read-only: no poll, replay, or Planned-candidate sections", async () => {
  const repoRoot = freshRepoWithConfig();
  writeActiveRegistry(repoRoot);
  const config = loadLinearConfig({ repoRoot });
  const { output, text } = capture();
  await withSavedExitCode(() =>
    runGatewayCommand({ context: { config, repoRoot, home: repoRoot, output }, command: "gateway", args: ["status"] }),
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });

  const out = text();
  // Read-only render: a status line + humanized interval, no live-poll sections.
  assert.match(out, /Stopped/); // active team, no live gateway lock
  assert.match(out, /every 10 seconds/); // humanized from config.poll.interval_ms = 10000
  assert.doesNotMatch(out, /Planned projects/, "must not render the live Planned poll");
  assert.doesNotMatch(out, /pass completed/, "must not run the one-pass");
});

test("adopter `gateway status` reports Running when a live gateway lock is present", async () => {
  const repoRoot = freshRepoWithConfig();
  writeActiveRegistry(repoRoot);
  const lockPath = teamiHomePaths({ home: repoRoot }).gatewayLockPath;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: process.pid, token: "x", created_at: new Date().toISOString() })}\n`,
    "utf8",
  );
  const config = loadLinearConfig({ repoRoot });
  const { output, text } = capture();
  await withSavedExitCode(() =>
    runGatewayCommand({ context: { config, repoRoot, home: repoRoot, output }, command: "gateway", args: ["status"] }),
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });

  const out = text();
  assert.match(out, /Running/);
  assert.match(out, /Stop: Ctrl-C/);
});

test("`trigger-status` still runs the active one-pass (preserved operator path)", async () => {
  const repoRoot = freshRepoWithConfig(); // no active registry -> one-pass fails closed with no_active_teams
  const config = loadLinearConfig({ repoRoot });
  const { output, text } = capture();
  await withSavedExitCode(() =>
    runGatewayCommand({ context: { config, repoRoot, home: repoRoot, output }, command: "trigger-status", args: [] }),
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });

  // The one-pass path attempts a real selection/poll and fails closed without an active team.
  assert.match(text(), /Gateway status could not be read|no_active_teams/);
});
