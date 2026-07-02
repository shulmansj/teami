import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { createCliOutput } from "../src/cli/cli-output.mjs";

function fakeStream(isTTY) {
  const writes = [];
  return {
    isTTY,
    writes,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    text() {
      return writes.join("");
    },
  };
}

test("progress on a non-TTY stream emits durable lines with no animation or ANSI", () => {
  const stream = fakeStream(false);
  const output = createCliOutput({ color: false, unicode: false, stream });

  const p = output.progress("working");
  p.update("still working");
  p.succeed("done");

  const text = stream.text();
  assert.ok(!text.includes("\r"), "non-TTY output must not use carriage-return redraws");
  assert.ok(!text.includes("\x1b"), "non-TTY output must contain no ANSI escapes");
  // One durable line per state: start, update, terminal.
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "expected exactly one durable line per state");
  assert.match(lines[0], /working$/);
  assert.match(lines[1], /still working$/);
  assert.match(lines[2], /\+ done$/); // ASCII success marker, no color
});

test("progress on a non-TTY stream marks failure with a durable line, no ANSI", () => {
  const stream = fakeStream(false);
  const output = createCliOutput({ color: false, unicode: false, stream });

  const p = output.progress("trying");
  p.fail("nope");

  const text = stream.text();
  assert.ok(!text.includes("\r"));
  assert.ok(!text.includes("\x1b"));
  assert.match(text, /x nope/); // ASCII failure marker
});

test("progress animates on a TTY and cleans up its own timer + exit listener on succeed", async () => {
  const savedCI = process.env.CI;
  delete process.env.CI;
  const baselineExitListeners = process.listenerCount("exit");
  try {
    const stream = fakeStream(true);
    const output = createCliOutput({ color: true, unicode: true, stream });

    const p = output.progress("spinning");
    // The first frame is drawn synchronously on start.
    const first = stream.writes[0];
    assert.ok(first.includes("\r"), "animated mode redraws in place with \\r");
    assert.ok(first.includes("\x1b"), "animated frame is colorized");
    assert.equal(
      process.listenerCount("exit"),
      baselineExitListeners + 1,
      "an active spinner registers exactly one exit listener",
    );

    p.succeed("finished");
    const text = stream.text();
    assert.match(text, /finished/);
    assert.match(text, /✓/); // Unicode success marker
    assert.equal(
      process.listenerCount("exit"),
      baselineExitListeners,
      "succeed() removes its own exit listener",
    );

    // The timer is cleared: no further frames are drawn after the terminal call.
    const writesAfter = stream.writes.length;
    await sleep(150); // > 1 spinner interval (80ms)
    assert.equal(stream.writes.length, writesAfter, "no frames are drawn after succeed()");
  } finally {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  }
});

test("progress stop() clears the spinner without printing a terminal mark", async () => {
  const savedCI = process.env.CI;
  delete process.env.CI;
  const baselineExitListeners = process.listenerCount("exit");
  try {
    const stream = fakeStream(true);
    const output = createCliOutput({ color: true, unicode: true, stream });

    const p = output.progress("spinning");
    p.stop();

    // Last write is the erase (\r + clear), and no ✓/✗ terminal mark was printed.
    assert.equal(
      process.listenerCount("exit"),
      baselineExitListeners,
      "stop() removes its own exit listener",
    );
    assert.ok(!stream.text().includes("✓"));
    assert.ok(!stream.text().includes("✗"));

    const writesAfter = stream.writes.length;
    await sleep(150);
    assert.equal(stream.writes.length, writesAfter, "no frames are drawn after stop()");
  } finally {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  }
});

test("progress is CI-aware: a TTY under CI uses durable lines, not animation", () => {
  const savedCI = process.env.CI;
  process.env.CI = "true";
  try {
    const stream = fakeStream(true);
    const output = createCliOutput({ color: true, unicode: true, stream });
    const p = output.progress("ci-wait");
    p.succeed("ci-done");
    const text = stream.text();
    assert.ok(!text.includes("\r"), "under CI even a TTY must not animate");
  } finally {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  }
});
