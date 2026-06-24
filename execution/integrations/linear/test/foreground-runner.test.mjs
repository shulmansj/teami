import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatForegroundRunnerReport,
  runForegroundTriggerRunnerOnce,
} from "../src/foreground-runner.mjs";

test("foreground runner leaves Phoenix lifecycle to the trace sink instead of pre-stopping it", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-foreground-runner-"));
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
      inbox: {
        runner: {
          lease_duration_ms: 1000,
          required_capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
        },
      },
    },
    repoRoot,
    credentialStore: {},
    runnerCredentialStore: {
      async readCredential() {
        return {
          credentialId: "runner-credential-1",
          workspaceId: "workspace-1",
          token: "runner-token",
          endpoint: "https://inbox.test",
          capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
        };
      },
    },
    inboxClient: {},
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

test("domain runner CLI path does not pre-stop Phoenix before trace sink readiness", () => {
  // Post-split, the domain runner body lives in src/cli/runner-command.mjs;
  // the body pin follows the wiring.
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "runner-command.mjs"),
    "utf8",
  );
  const start = source.indexOf("async function runOneDomainTriggerWake");
  const end = source.indexOf("function selectRunnerDomains", start);
  assert.ok(start > 0, "runOneDomainTriggerWake must exist");
  assert.ok(end > start, "runOneDomainTriggerWake body must be bounded");
  const body = source.slice(start, end);
  assert.equal(body.includes("stopPhoenix"), false);
  assert.equal(body.includes("stopped: managed local Phoenix"), false);
});
