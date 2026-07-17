import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readBackgroundListenerStatus,
  startBackgroundListener,
  stopBackgroundListener,
} from "../src/background-listener.mjs";
import { acquireGatewayLock } from "../src/gateway-loop.mjs";
import {
  createNoCheckoutFixture,
  noCheckoutChildEnv,
} from "./no-checkout-harness.mjs";

const fixtureChild = path.resolve(
  import.meta.dirname,
  "fixtures/background-listener-child.mjs",
);

test("background listener survives its starting process and can be stopped later", { timeout: 30_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-background-listener-"));
  t.after(async () => {
    await stopBackgroundListener({ home, timeoutMs: 5_000 });
    fs.rmSync(home, { recursive: true, force: true });
  });

  let spawned = null;
  const started = await startBackgroundListener({
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    home,
    cliPath: fixtureChild,
    timeoutMs: 10_000,
    spawnProcess: (command, args, options) => {
      spawned = { command, args, options };
      return spawn(command, args, options);
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.status, "started");
  assert.equal(started.mode, "background");
  assert.ok(Number.isInteger(started.pid));
  assert.equal(spawned.args.includes("--background-control-token"), false);
  assert.equal(spawned.args.includes(spawned.options.env.TEAMI_BACKGROUND_CONTROL_TOKEN), false);
  assert.doesNotMatch(JSON.stringify(started), new RegExp(spawned.options.env.TEAMI_BACKGROUND_CONTROL_TOKEN));

  const status = readBackgroundListenerStatus({ home });
  assert.equal(status.running, true);
  assert.equal(status.mode, "background");
  assert.equal(status.pid, started.pid);

  const secondStart = await startBackgroundListener({
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    home,
    cliPath: fixtureChild,
    timeoutMs: 10_000,
  });
  assert.equal(secondStart.status, "already_running");
  assert.equal(secondStart.pid, started.pid);

  const stopped = await stopBackgroundListener({ home, timeoutMs: 10_000 });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.status, "stopped");
  assert.equal(readBackgroundListenerStatus({ home }).running, false);
});

test("real CLI dispatch starts and stops the managed background listener", { timeout: 30_000 }, async (t) => {
  const fixture = createNoCheckoutFixture({ prefix: "teami-real-background-cli-" });
  t.after(async () => {
    await stopBackgroundListener({ home: fixture.home, timeoutMs: 10_000 });
    fixture.cleanup();
  });

  const started = await startBackgroundListener({
    repoRoot: fixture.cwdGateway,
    home: fixture.home,
    cliPath: fixture.cliPath,
    childEnv: noCheckoutChildEnv(fixture, { cwd: fixture.cwdGateway }),
    timeoutMs: 15_000,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.status, "started");
  assert.equal(readBackgroundListenerStatus({ home: fixture.home }).mode, "background");

  const stopped = await stopBackgroundListener({ home: fixture.home, timeoutMs: 10_000 });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.status, "stopped");
});

test("simultaneous starts converge on one background listener", { timeout: 30_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-concurrent-listener-"));
  t.after(async () => {
    await stopBackgroundListener({ home, timeoutMs: 5_000 });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const options = {
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    home,
    cliPath: fixtureChild,
    timeoutMs: 10_000,
  };

  const results = await Promise.all([
    startBackgroundListener(options),
    startBackgroundListener(options),
  ]);
  assert.equal(results.every((result) => result.ok), true, JSON.stringify(results));
  assert.deepEqual(results.map((result) => result.status).sort(), ["already_running", "started"]);
  assert.equal(new Set(results.map((result) => result.pid)).size, 1);
});

test("stop refuses to terminate a terminal-owned foreground listener", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-foreground-listener-"));
  const lock = acquireGatewayLock({ home, installHandlers: false });
  assert.equal(lock.ok, true);
  t.after(() => {
    lock.release?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stopped = await stopBackgroundListener({ home, timeoutMs: 100 });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, "foreground_owned");
  assert.equal(readBackgroundListenerStatus({ home }).running, true);
  assert.equal(readBackgroundListenerStatus({ home }).mode, "foreground");
});
