import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { createCliOutput } from "../src/cli/cli-output.mjs";

class MemoryStream extends Writable {
  constructor({ isTTY = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.output = "";
  }

  _write(chunk, encoding, callback) {
    this.output += chunk.toString("utf8");
    callback();
  }
}

test("cli output color auto-detect respects TTY, NO_COLOR, TERM=dumb, and color:false", async (t) => {
  await withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
    const stream = new MemoryStream({ isTTY: true });
    createCliOutput({ stream }).success("connected");
    assert.match(stream.output, /\x1b\[32m/);
  });

  await withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
    const stream = new MemoryStream({ isTTY: false });
    createCliOutput({ stream }).success("connected");
    assert.doesNotMatch(stream.output, /\x1b\[/);
  });

  await withEnv({ NO_COLOR: "1", TERM: "xterm-256color" }, () => {
    const stream = new MemoryStream({ isTTY: true });
    createCliOutput({ stream }).success("connected");
    assert.doesNotMatch(stream.output, /\x1b\[/);
  });

  await withEnv({ NO_COLOR: undefined, TERM: "dumb" }, () => {
    const stream = new MemoryStream({ isTTY: true });
    createCliOutput({ stream }).success("connected");
    assert.doesNotMatch(stream.output, /\x1b\[/);
  });

  await withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
    const stream = new MemoryStream({ isTTY: true });
    createCliOutput({ stream, color: false }).success("connected");
    assert.doesNotMatch(stream.output, /\x1b\[/);
  });
});

test("detail output is gated by verbose", () => {
  const quiet = new MemoryStream();
  createCliOutput({ stream: quiet, color: false }).detail("webhook_id=abc");
  assert.equal(quiet.output, "");

  const verbose = new MemoryStream();
  createCliOutput({ stream: verbose, verbose: true, color: false }).detail("webhook_id=abc");
  assert.equal(verbose.output, "  webhook_id=abc\n");
});

test("cli output primitives keep the expected shape without color", () => {
  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: true });

  output.step(1, 2, "Connect Linear");
  output.success("Workspace: Sandbox");
  output.info("Linear connected.");
  output.warn("Phoenix is degraded");
  output.heading("Next");
  output.nextSteps([
    "Move a project to Planned",
    { text: "npm run doctor", hint: "check everything's healthy" },
  ]);
  output.done("Setup complete.");
  output.raw("raw");

  assert.equal(
    stream.output,
    [
      "",
      "▸ Step 1/2  Connect Linear",
      "  ✓ Workspace: Sandbox",
      "  Linear connected.",
      "  ⚠ Phoenix is degraded",
      "",
      "Next",
      "",
      "Next steps",
      "  → Move a project to Planned",
      "  → npm run doctor  check everything's healthy",
      "",
      "✓ Setup complete.",
      "raw",
    ].join("\n"),
  );
});

test("error writes what, why, and fix to the error stream", () => {
  const stream = new MemoryStream();
  const errStream = new MemoryStream();
  const output = createCliOutput({ stream, errStream, color: false, unicode: true });

  output.error({
    what: "GitHub App is not installed",
    why: "Setup needs a verified GitHub connection.",
    fix: "Install the app and rerun npm run init.",
  });

  assert.equal(stream.output, "");
  assert.equal(
    errStream.output,
    [
      "✗ GitHub App is not installed",
      "  Setup needs a verified GitHub connection.",
      "  → Fix: Install the app and rerun npm run init.",
      "",
    ].join("\n"),
  );
});

test("keyValues renders an aligned two-column block without color", () => {
  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: true });

  output.keyValues([
    ["Dataset", "teami-decomposition-examples"],
    ["Version", "v1"],
    ["Split", "calibration"],
  ], { heading: "Promotion" });

  assert.equal(
    stream.output,
    [
      "",
      "  Promotion",
      "  Dataset:  teami-decomposition-examples",
      "  Version:  v1",
      "  Split:    calibration",
      "",
    ].join("\n"),
  );
});

test("keyValues with an empty list produces no output", () => {
  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: true });

  output.keyValues([], { heading: "Empty" });

  assert.equal(stream.output, "");
});

test("section renders a compact sub-heading without color", () => {
  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: true });

  output.section("Evaluation status");

  assert.equal(
    stream.output,
    [
      "",
      "  Evaluation status",
      "",
    ].join("\n"),
  );
});

test("ascii fallback swaps the glyphs for legacy consoles (unicode:false)", () => {
  const stream = new MemoryStream();
  const errStream = new MemoryStream();
  const output = createCliOutput({ stream, errStream, color: false, unicode: false });

  output.step(1, 2, "Connect Linear");
  output.success("Workspace: Sandbox");
  output.warn("Phoenix is degraded");
  output.done("Setup complete.");
  output.nextSteps([{ text: "npm run doctor", hint: "check" }]);
  output.error({ what: "Boom", fix: "do x" });

  assert.equal(
    stream.output,
    [
      "",
      "> Step 1/2  Connect Linear",
      "  + Workspace: Sandbox",
      "  ! Phoenix is degraded",
      "",
      "+ Setup complete.",
      "",
      "Next steps",
      "  -> npm run doctor  check",
      "",
    ].join("\n"),
  );
  assert.equal(
    errStream.output,
    [
      "x Boom",
      "  -> Fix: do x",
      "",
    ].join("\n"),
  );
});

async function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
