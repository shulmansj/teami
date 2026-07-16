import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatForegroundRunnerReport,
  runForegroundTriggerRunnerOnce,
} from "../src/foreground-runner.mjs";
import { createCliOutput } from "../src/cli/cli-output.mjs";
import { runReviewRunCommand } from "../src/cli/dispatch.mjs";

test("foreground runner leaves Phoenix lifecycle to the trace sink instead of pre-stopping it", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-foreground-runner-"));
  const cachePath = path.join(repoRoot, "linear-cache.json");
  fs.writeFileSync(cachePath, `${JSON.stringify({ workspaceId: "workspace-1" })}\n`);
  let stopCalled = false;
  let shutdownCalled = false;
  let observedInput = null;
  const traceSink = {
    marker: "trace-sink",
    async shutdown() {
      shutdownCalled = true;
    },
  };

  const result = await runForegroundTriggerRunnerOnce({
    config: {
      runner: {
        lease_duration_ms: 1000,
        required_capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
      },
    },
    repoRoot,
    home: repoRoot,
    credentialStore: {},
    cachePath,
    stopPhoenixFn: async () => {
      stopCalled = true;
      return { ok: true, stopped: true };
    },
    createTraceSink: () => traceSink,
    runTriggeredDecompositionFn: async (input) => {
      observedInput = input;
      return { status: "idle", reason: "no_queued_wake" };
    },
  });

  assert.equal(stopCalled, false);
  assert.equal(shutdownCalled, true);
  assert.equal(observedInput.traceSink, traceSink);
  assert.equal(result.foreground_runner.phoenix_lifecycle, "trace_sink_adopt_or_start");
  const report = formatForegroundRunnerReport(result);
  assert.equal(report[0], "local Phoenix: trace sink will adopt or start as needed");
  assert.equal(report.some((line) => line.includes("stopped: managed local Phoenix")), false);
});

test("foreground runner refuses to mutate while another Team lifecycle owner is active", async () => {
  let workflowCalled = false;
  const result = await runForegroundTriggerRunnerOnce({
    config: {},
    home: "unused-home",
    cachePath: "unused-cache",
    credentialStore: {},
    acquireTeamAuthority: () => ({ ok: false, reason: "lock_held" }),
    runTriggeredDecompositionFn: async () => {
      workflowCalled = true;
      return { status: "completed" };
    },
  });

  assert.deepEqual(result, { status: "refused", reason: "team_authority_busy" });
  assert.equal(workflowCalled, false);
});

test("manual review refuses to start without exclusive Team lifecycle authority", async () => {
  const chunks = [];
  const stream = { isTTY: false, write: (chunk) => (chunks.push(String(chunk)), true) };
  const previousExitCode = process.exitCode;
  try {
    await runReviewRunCommand({
      context: {
        config: {},
        repoRoot: "unused-repo",
        home: "unused-home",
        output: createCliOutput({ color: false, unicode: false, stream, errStream: stream }),
      },
      command: "review:run",
      args: ["--issue", "ISS-1"],
      acquireTeamAuthority: () => ({ ok: false, reason: "lock_held" }),
    });
  } finally {
    process.exitCode = previousExitCode;
  }

  assert.match(chunks.join(""), /team_authority_busy/);
});

test("gateway CLI path does not pre-stop Phoenix before trace sink readiness", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "runner-command.mjs"),
    "utf8",
  );
  assert.match(source, /runGatewayLoop/);
  assert.equal(source.includes("stopPhoenix"), false);
  assert.equal(source.includes("stopped: managed local Phoenix"), false);
});

test("runner entry points use the local trigger store instead of a remote wake queue", () => {
  const files = [
    path.resolve(import.meta.dirname, "..", "src", "foreground-runner.mjs"),
    path.resolve(import.meta.dirname, "..", "src", "cli", "runner-command.mjs"),
    path.resolve(import.meta.dirname, "..", "src", "gateway-loop.mjs"),
  ];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.match(source, /createLocalTriggerStore/);
  assert.equal(source.includes("createHostedWakeQueueStore"), false);
});
