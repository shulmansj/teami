import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectMcpToolActions } from "../src/project-mcp-tools.mjs";

test("listener tools check, explicitly start a persistent background process, and stop it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-listener-tools-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let lockLive = false;
  let starts = 0;
  let stops = 0;

  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: { poll: { interval_ms: 10_000 } },
    registry: {
      teams: [
        { id: "main", status: "active" },
        { id: "alexandria", status: "active" },
        { id: "retired", status: "inactive" },
      ],
    },
    packageVersion: "9.8.7-test.1",
    probeListener: () => ({
      state: lockLive ? "listening" : "idle",
      evidence: { activeTeamRef: "main", lockLive },
    }),
    readListenerProcessStatus: () => ({
      running: lockLive,
      mode: lockLive ? "background" : "stopped",
      background: lockLive,
    }),
    startListener: async () => {
      starts += 1;
      if (lockLive) return { ok: true, status: "already_running", running: true, mode: "background" };
      lockLive = true;
      return { ok: true, status: "started", running: true, mode: "background" };
    },
    stopListener: async () => {
      stops += 1;
      if (!lockLive) return { ok: true, status: "already_stopped", running: false };
      lockLive = false;
      return { ok: true, status: "stopped", running: false };
    },
  });

  const stopped = await actions.listener_status();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.running, false);
  assert.deepEqual(stopped.scope, {
    mode: "all_active_teams",
    team_refs: ["main", "alexandria"],
  });
  assert.match(stopped.summary, /wait safely in Linear/i);

  await assert.rejects(
    () => actions.listener_start(),
    (error) => error.code === "confirmation_required",
  );
  assert.equal(starts, 0);

  const started = await actions.listener_start({ confirm: true });
  assert.equal(started.status, "started");
  assert.equal(started.running, true);
  assert.equal(started.lifecycle.mode, "background");
  assert.match(started.lifecycle.detail, /keeps running after the agent session/i);
  assert.equal(starts, 1);

  const running = await actions.listener_status();
  assert.equal(running.status, "running");
  assert.equal(running.lifecycle.mode, "background");

  const idempotent = await actions.listener_start({ confirm: true });
  assert.equal(idempotent.status, "already_running");
  assert.equal(idempotent.read_only, false);
  assert.equal(starts, 1);

  await assert.rejects(
    () => actions.listener_stop(),
    (error) => error.code === "confirmation_required",
  );
  assert.equal(stops, 0);
  const stoppedResult = await actions.listener_stop({ confirm: true });
  assert.equal(stoppedResult.status, "stopped");
  assert.equal(stops, 1);
  const afterClose = await actions.listener_status();
  assert.equal(afterClose.status, "stopped");
  assert.equal(afterClose.running, false);
});

test("listener start fails closed when setup is not ready", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-listener-not-ready-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: {},
    registry: { teams: [] },
    probeListener: () => ({ state: "uninitialized", evidence: {} }),
  });

  await assert.rejects(
    () => actions.listener_start({ confirm: true }),
    (error) => {
      assert.equal(error.code, "listener_not_ready");
      assert.match(error.repair, /init/);
      return true;
    },
  );
});

test("listener stop explains that a terminal-owned foreground process needs Ctrl-C", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-listener-foreground-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: {},
    registry: { teams: [{ id: "main", status: "active" }] },
    stopListener: async () => ({
      ok: false,
      status: "foreground_owned",
      reason: "listener_not_background_managed",
      running: true,
    }),
  });

  await assert.rejects(
    () => actions.listener_stop({ confirm: true }),
    (error) => {
      assert.equal(error.code, "listener_foreground_owned");
      assert.match(error.repair, /Ctrl-C/);
      return true;
    },
  );
});

test("listener status reports stopped when lock probes disagree during a race", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-listener-race-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: {},
    registry: { teams: [{ id: "main", status: "active" }] },
    probeListener: () => ({ state: "listening", evidence: {} }),
    readListenerProcessStatus: () => ({ running: false, mode: "stopped", background: false }),
  });

  const result = await actions.listener_status();
  assert.equal(result.status, "stopped");
  assert.equal(result.running, false);
});

test("listener stop truthfully reports a graceful stop still in progress", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-listener-stopping-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: {},
    registry: { teams: [{ id: "main", status: "active" }] },
    stopListener: async () => ({ ok: true, status: "stopping", running: true, mode: "background" }),
  });

  const result = await actions.listener_stop({ confirm: true });
  assert.equal(result.status, "stopping");
  assert.equal(result.running, true);
  assert.match(result.summary, /finishing current work/i);
});
