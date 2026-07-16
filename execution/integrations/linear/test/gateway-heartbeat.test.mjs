import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGatewayCommand } from "../src/cli/runner-command.mjs";
import { createCliOutput } from "../src/cli/cli-output.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";

function activeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-gw-heartbeat-"));
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
  writeTeamRegistry({ repoRoot }, registry);
  return repoRoot;
}

function capture() {
  const writes = [];
  const stream = { isTTY: false, write: (c) => (writes.push(String(c)), true) };
  return {
    output: createCliOutput({ color: false, unicode: false, stream, errStream: stream }),
    text: () => writes.join(""),
  };
}

test("the gateway loop heartbeat emits durable, animation-free lines when non-TTY", async () => {
  const repoRoot = activeRepo();
  const { output, text } = capture();
  const savedExit = process.exitCode;

  // Inject a fake loop that emits one activity event, then stops (as Ctrl-C would).
  const fakeLoop = async ({ onStatus }) => {
    onStatus({ state: "working", projectId: "P1", runId: "R1" });
    return {
      ok: true,
      status: "stopped",
      statuses: [{ state: "working" }],
      iterations: [{ teams: [] }, { teams: [] }],
      retention: {
        statuses: { total: 7, retained: 1, dropped: 6, limit: 1 },
        iterations: { total: 2, retained: 2, dropped: 0, limit: null },
      },
    };
  };

  try {
    await runGatewayCommand({
      context: { config: { poll: { interval_ms: 10_000 } }, repoRoot, output },
      command: "gateway",
      args: [],
      loop: fakeLoop,
    });
  } finally {
    process.exitCode = savedExit;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }

  const out = text();
  assert.ok(!out.includes("\r"), "non-TTY heartbeat must not use carriage-return animation");
  assert.ok(!out.includes("\x1b"), "non-TTY heartbeat must contain no ANSI escapes");
  assert.match(out, /Polling every 10 seconds/, "the interval is humanized, not '10000ms'");
  assert.match(out, /still watching/, "a durable heartbeat line is emitted");
  assert.match(out, /working/, "activity events still render");
  assert.match(out, /Gateway stopped/, "completion renders after the loop");
  assert.match(out, /Iterations:\s+2 total; all retained/, "finite loop counts say that all records were retained");
  assert.match(out, /Events:\s+7 total; 1 recent retained; 6 older dropped/, "live loop counts disclose bounded retention");
  assert.doesNotMatch(out, /10000ms/, "the machine-speak interval is gone");
});
