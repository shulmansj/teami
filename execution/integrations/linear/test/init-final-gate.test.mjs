import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  factoryLauncherCommand,
  finishSetupOutput,
  runFinalGate,
} from "../src/cli/linear-setup-command.mjs";

const sourcePath = path.resolve(import.meta.dirname, "../src/cli/linear-setup-command.mjs");

test("runFinalGate passes when runtime smoke and doctor are green", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
      { name: "Linear OAuth", ok: true },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.smokeOk, true);
  assert.equal(result.doctorOk, true);
  assertCall(output, "section", "Verifying setup");
  assertCall(output, "success", "Setup verified.");
});

test("runFinalGate keeps setup green when smoke fails but doctor is green", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    runSmoke: async () => ({ ok: false, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.smokeOk, false);
  assertCall(output, "warn", "Runtime check did not pass; setup will still complete.");
  assertCall(output, "info", "run npm run runtime-smoke");
  assertCall(output, "success", "Setup verified.");
});

test("runFinalGate fails when doctor has a red check", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
      { name: "GitHub connection", ok: false, message: "not connected" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.doctorOk, false);
  assert.ok(
    output.calls.some((call) => call.method === "error" && call.args[0]?.what === "GitHub connection"),
  );
  assert.ok(
    output.calls.some((call) =>
      call.method === "error" &&
      call.args[0]?.what === "Some setup checks need attention" &&
      call.args[0]?.fix === "fix the checks above, then re-run npm run init (setup is resumable)."),
  );
});

test("finishSetupOutput prints closeout on green gate and resumable warning on red gate", async () => {
  const previousExitCode = process.exitCode;
  try {
    const greenOutput = createRecordingOutput();
    process.exitCode = 99;
    await finishSetupOutput({
      output: greenOutput,
      commandOptions: { runGithubPhase: true, readyLabel: "First domain" },
      phoenixAppUrl: "http://127.0.0.1:6006",
      finalGate: async () => ({ ok: true, smokeOk: true, doctorOk: true }),
    });

    assert.equal(process.exitCode, 0);
    assertCall(greenOutput, "done", "Setup complete.");
    assert.ok(
      greenOutput.calls.some((call) =>
        call.method === "nextSteps" &&
        call.args[0].some((item) => item?.text === factoryLauncherCommand("gateway start"))),
    );

    const redOutput = createRecordingOutput();
    process.exitCode = 99;
    await finishSetupOutput({
      output: redOutput,
      commandOptions: { runGithubPhase: true, readyLabel: "First domain" },
      finalGate: async () => ({ ok: false, smokeOk: true, doctorOk: false }),
    });

    assert.equal(process.exitCode, 1);
    assertCall(redOutput, "warn", "Setup is resumable — fix the checks above and re-run npm run init.");
    assert.equal(redOutput.calls.some((call) => call.method === "done" && call.args[0] === "Setup complete."), false);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("runFinalGate is idempotent with injected fakes", async () => {
  const makeArgs = () => ({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output: createRecordingOutput(),
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
    ],
  });

  const first = await runFinalGate(makeArgs());
  const second = await runFinalGate(makeArgs());

  assert.deepEqual(second, first);
});

test("finishSetupOutput fires from both normal finish and GitHub resume paths", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  const callSites = [...source.matchAll(/await finishSetupOutput\(/g)];
  assert.ok(callSites.length >= 2, `expected at least 2 finishSetupOutput call sites, found ${callSites.length}`);

  const resumeStart = source.indexOf("if (githubResumeDomain)");
  const resumeEnd = source.indexOf("output.step(1, totalSteps, commandOptions.runGithubPhase", resumeStart);
  assert.notEqual(resumeStart, -1);
  assert.notEqual(resumeEnd, -1);
  const resumeBlock = source.slice(resumeStart, resumeEnd);
  assert.match(resumeBlock, /await finishSetupOutput\(/);
  assert.match(resumeBlock, /domainId:\s*githubResumeDomain\.id/);
  assert.match(source, /domainId:\s*result\.domain\.id/);
});

test("factoryLauncherCommand returns the platform launcher form and appends the subcommand", () => {
  const prefix = factoryLauncherCommand();
  // Windows (PowerShell/cmd.exe) needs `.\factory.cmd`; POSIX shells use `./factory`.
  assert.match(prefix, /^(\.\\factory\.cmd|\.\/factory)$/);
  assert.equal(factoryLauncherCommand("gateway start"), `${prefix} gateway start`);
  assert.equal(prefix, process.platform === "win32" ? ".\\factory.cmd" : "./factory");
});

function createRecordingOutput() {
  const calls = [];
  const output = {
    calls,
    verbose: false,
    style: {
      dim: (text) => String(text),
    },
    symbols: {
      ellipsis: "...",
    },
    section: record("section"),
    info: record("info"),
    success: record("success"),
    warn: record("warn"),
    error: record("error"),
    detail: record("detail"),
    done: record("done"),
    nextSteps: record("nextSteps"),
    raw: record("raw"),
  };
  return output;

  function record(method) {
    return (...args) => {
      calls.push({ method, args });
    };
  }
}

function assertCall(output, method, value) {
  assert.ok(
    output.calls.some((call) => call.method === method && call.args[0] === value),
    `expected ${method} call with ${JSON.stringify(value)}`,
  );
}
