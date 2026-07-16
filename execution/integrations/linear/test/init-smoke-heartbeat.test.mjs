import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { runFinalGate } from "../src/cli/linear-setup-command.mjs";
import { createCliOutput } from "../src/cli/cli-output.mjs";

function captureNonTty() {
  const writes = [];
  const stream = { isTTY: false, write: (c) => (writes.push(String(c)), true) };
  return {
    output: createCliOutput({ color: false, unicode: false, stream, errStream: stream }),
    text: () => writes.join(""),
  };
}

function ttyOutput() {
  const sink = { isTTY: true, write: () => true };
  return createCliOutput({ color: true, unicode: true, stream: sink, errStream: sink });
}

test("init smoke wait shows durable, animation-free progress (non-TTY)", async () => {
  const { output, text } = captureNonTty();
  await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    teamRef: "team-one",
    output,
    runSmoke: async () => {
      await sleep(30); // simulate a slow smoke
      return { ok: true, results: [] };
    },
    runDoctor: async () => [{ name: "team registry", ok: true }],
  });

  const out = text();
  assert.match(out, /Running the runtime check/, "a durable progress line is emitted during the wait");
  assert.ok(!out.includes("\r"), "non-TTY smoke progress must not animate with carriage returns");
  assert.ok(!out.includes("\x1b"), "non-TTY smoke progress must contain no ANSI escapes");
});

test("init smoke heartbeat is cleared on both the success and the throw path", async () => {
  const savedCI = process.env.CI;
  delete process.env.CI; // force the animated path so the spinner registers an exit listener
  const baseline = process.listenerCount("exit");
  try {
    await runFinalGate({
      config: {},
      repoRoot: process.cwd(),
      cachePath: "linear-cache.json",
      teamRef: "team-one",
      output: ttyOutput(),
      runSmoke: async () => ({ ok: true, results: [] }),
      runDoctor: async () => [{ name: "team registry", ok: true }],
    });
    assert.equal(process.listenerCount("exit"), baseline, "heartbeat cleared on the success path");

    const result = await runFinalGate({
      config: {},
      repoRoot: process.cwd(),
      cachePath: "linear-cache.json",
      teamRef: "team-one",
      output: ttyOutput(),
      runSmoke: async () => {
        throw new Error("smoke blew up");
      },
      runDoctor: async () => [{ name: "team registry", ok: true }],
    });
    assert.equal(process.listenerCount("exit"), baseline, "heartbeat cleared on the throw path");
    assert.equal(result.smokeOk, false, "a thrown smoke is handled, setup still completes");
  } finally {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  }
});
