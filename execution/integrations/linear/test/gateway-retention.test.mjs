import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LIVE_GATEWAY_ITERATION_RETENTION,
  DEFAULT_LIVE_GATEWAY_STATUS_RETENTION,
  runGatewayLoop,
} from "../src/gateway-loop.mjs";

test("unbounded gateway loops retain only recent records while streaming every status", async () => {
  assert.ok(DEFAULT_LIVE_GATEWAY_STATUS_RETENTION > 0);
  assert.ok(DEFAULT_LIVE_GATEWAY_ITERATION_RETENTION > 0);

  const controller = new AbortController();
  const streamed = [];
  let iteration = 0;
  const result = await runGatewayLoop({
    signal: controller.signal,
    statusRetentionLimit: 3,
    iterationRetentionLimit: 2,
    acquireLock: successfulLock,
    runStartup: async () => ({ replay: [] }),
    runPollIteration: async ({ emitStatus }) => {
      iteration += 1;
      emitStatus({ state: "working", projectId: `project-${iteration}`, reason: `start-${iteration}` });
      emitStatus({ state: "degraded", projectId: `project-${iteration}`, reason: `finish-${iteration}` });
      if (iteration === 6) controller.abort();
      return { sequence: iteration };
    },
    sleep: async () => {},
    onStatus: (event) => streamed.push(event),
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(result.iterations.map((entry) => entry.sequence), [5, 6]);
  assert.deepEqual(result.statuses.map((entry) => entry.reason), ["finish-5", "start-6", "finish-6"]);
  assert.deepEqual(result.retention, {
    statuses: { total: 12, retained: 3, dropped: 9, limit: 3 },
    iterations: { total: 6, retained: 2, dropped: 4, limit: 2 },
  });
  assert.equal(streamed.length, 12, "retention must not suppress live status delivery");
  assert.deepEqual(streamed.slice(0, 2).map((entry) => entry.reason), ["start-1", "finish-1"]);
});

test("finite maxIterations loops preserve every iteration and status record", async () => {
  let iteration = 0;
  const result = await runGatewayLoop({
    maxIterations: 4,
    statusRetentionLimit: 1,
    iterationRetentionLimit: 1,
    acquireLock: successfulLock,
    runStartup: async () => ({ replay: [] }),
    runPollIteration: async ({ emitStatus }) => {
      iteration += 1;
      emitStatus({ state: "working", projectId: `project-${iteration}`, reason: `iteration-${iteration}` });
      return { sequence: iteration };
    },
    sleep: async () => {},
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.iterations.map((entry) => entry.sequence), [1, 2, 3, 4]);
  assert.deepEqual(result.statuses.map((entry) => entry.reason), [
    "iteration-1",
    "iteration-2",
    "iteration-3",
    "iteration-4",
  ]);
  assert.deepEqual(result.retention, {
    statuses: { total: 4, retained: 4, dropped: 0, limit: null },
    iterations: { total: 4, retained: 4, dropped: 0, limit: null },
  });
});

test("unbounded gateway loops reject disabled or invalid retention limits", async () => {
  for (const options of [
    { statusRetentionLimit: 0 },
    { iterationRetentionLimit: Number.NaN },
  ]) {
    await assert.rejects(
      () => runGatewayLoop({ ...options, acquireLock: successfulLock }),
      /gateway_live_retention_limit_must_be_a_positive_integer/,
    );
  }
});

test("invalid maxIterations cannot bypass live-loop retention", async () => {
  for (const maxIterations of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => runGatewayLoop({ maxIterations, acquireLock: successfulLock }),
      /gateway_max_iterations_must_be_a_positive_integer/,
    );
  }
});

function successfulLock() {
  return { ok: true, release() {} };
}
