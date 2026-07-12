import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  confirmCliSetupEffects,
  factoryLauncherCommand,
  finishSetupOutput,
  runLinearSetupCommand,
  runFinalGate,
} from "../src/cli/linear-setup-command.mjs";
import {
  SETUP_DISCLOSURE_HASH,
  SETUP_DISCLOSURE_VERSION,
  createSetupStateStore,
  setupEffectsDisclosure,
} from "../src/setup-orchestrator.mjs";

const sourcePath = path.resolve(import.meta.dirname, "../src/cli/linear-setup-command.mjs");

test("runFinalGate passes when runtime smoke and doctor are green", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    phoenixOk: true,
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

test("runFinalGate blocks completion when runtime smoke fails even if doctor is green", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    phoenixOk: true,
    runSmoke: async () => ({ ok: false, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.smokeOk, false);
  assertCall(output, "warn", "Runtime check did not pass; setup cannot be marked complete.");
  assertCall(output, "info", `You can re-run the check any time with ${factoryLauncherCommand("runtime-smoke")}.`);
  assert.equal(output.calls.some((call) => call.method === "success" && call.args[0] === "Setup verified."), false);
});

test("runFinalGate fails when doctor has a red check", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    phoenixOk: true,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
      { name: "GitHub connection", ok: false, message: "not connected" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.doctorOk, false);
  assert.ok(
    output.calls.some((call) => call.method === "raw" && String(call.args[0]).includes("GitHub connection")),
    "the failing check renders through the shared doctor renderer",
  );
  assert.ok(
    output.calls.some((call) =>
      call.method === "error" &&
      call.args[0]?.what === "Some setup checks need attention" &&
      call.args[0]?.fix === `fix the checks above, then re-run ${factoryLauncherCommand("init")} (setup is resumable).`),
  );
});

test("runFinalGate reports degraded when required Phoenix is only a warning", async () => {
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
      { name: "local Phoenix", state: "warn", message: "not running" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "degraded");
  assert.equal(result.phoenixOk, false);
  assert.equal(result.doctorOk, true);
  assertCall(output, "warn", "Setup health is degraded; local Phoenix must pass before setup is complete.");
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
    assertCall(redOutput, "warn", `Setup is resumable — fix the checks above and re-run ${factoryLauncherCommand("init")}.`);
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
    phoenixOk: true,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "domain registry", ok: true },
    ],
  });

  const first = await runFinalGate(makeArgs());
  const second = await runFinalGate(makeArgs());

  const withoutObservationTimes = (result) => ({
    ...result,
    health: result.health.map(({ observed_at: _observedAt, ...step }) => step),
  });
  assert.deepEqual(withoutObservationTimes(second), withoutObservationTimes(first));
});

test("CLI setup uses the same disclosure and requires an explicit exact confirmation", async () => {
  const rejectedOutput = createRecordingOutput();
  const rejected = await confirmCliSetupEffects({
    context: { isTTY: false },
    output: rejectedOutput,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "consent_required");
  assertCall(rejectedOutput, "section", "Setup effects and access");

  let presented = null;
  const acceptedOutput = createRecordingOutput();
  const accepted = await confirmCliSetupEffects({
    context: {
      confirmSetupEffects: async (disclosure) => {
        presented = disclosure;
        return true;
      },
    },
    output: acceptedOutput,
  });
  assert.equal(accepted.ok, true);
  assert.match(presented.version, /^teami-setup-effects\/v\d+$/);
  assert.match(presented.hash, /^[a-f0-9]{64}$/);
  assert.equal(presented.effects.length, 6);
  const rendered = acceptedOutput.calls.flatMap((call) => call.args).filter((value) => typeof value === "string").join("\n");
  for (const effect of setupEffectsDisclosure().effects) {
    assert.match(rendered, new RegExp(escapeRegExp(effect.detail)));
    assert.match(rendered, new RegExp(escapeRegExp(effect.authority)));
    assert.match(rendered, new RegExp(escapeRegExp(effect.retention)));
  }
});

test("CLI setup refuses to interleave with a pending conversational setup", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-active-setup-"));
  const previousExitCode = process.exitCode;
  try {
    const store = createSetupStateStore({ home });
    const active = store.start({
      input: { domain: "Pending MCP", repo_intent: { mode: "non_code" } },
      consent: {
        confirmed: true,
        version: SETUP_DISCLOSURE_VERSION,
        hash: SETUP_DISCLOSURE_HASH,
      },
    });
    store.recordPhase(active.setup_id, "linear", {
      status: "awaiting_authorization",
      reason: "callback_pending",
      setupStatus: "awaiting_authorization",
    });
    const output = createRecordingOutput();
    const result = await runLinearSetupCommand({
      command: "init",
      args: [],
      context: {
        home,
        output,
        setupStateStore: store,
        confirmSetupEffects: async () => true,
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "setup_session_active");
    assert.equal(result.setup_id, active.setup_id);
    assert.equal(process.exitCode, 1);
    assert.ok(output.calls.some((call) =>
      call.method === "error" && call.args[0]?.what === "A conversational setup is waiting for authorization"));
  } finally {
    process.exitCode = previousExitCode;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI init is a renderer over the same resumable onboarding action as MCP", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /if \(command === "init"\) \{\s*return runCliSharedOnboarding\(/);
  assert.match(source, /createProjectMcpToolActions/);
  assert.match(source, /actions\.init_onboarding\(input\)/);
  assert.match(source, /setupStateStore/);
});

test("factoryLauncherCommand returns the platform launcher form and appends the subcommand", () => {
  const prefix = factoryLauncherCommand();
  // Windows (PowerShell/cmd.exe) needs `.\teami.cmd`; POSIX shells use `./teami`.
  assert.match(prefix, /^(\.\\teami\.cmd|\.\/teami)$/);
  assert.equal(factoryLauncherCommand("gateway start"), `${prefix} gateway start`);
  assert.equal(prefix, process.platform === "win32" ? ".\\teami.cmd" : "./teami");
});

function createRecordingOutput() {
  const calls = [];
  const output = {
    calls,
    verbose: false,
    style: {
      dim: (text) => String(text),
      red: (text) => String(text),
      yellow: (text) => String(text),
      green: (text) => String(text),
      cyan: (text) => String(text),
      bold: (text) => String(text),
    },
    symbols: {
      ellipsis: "...",
      success: "+",
      error: "x",
      warn: "!",
      step: ">",
      arrow: "->",
      separator: "-",
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
    progress: (label) => {
      calls.push({ method: "progress", args: [label] });
      const noop = (text) => calls.push({ method: "progress.terminal", args: [text] });
      return { update: noop, succeed: noop, fail: noop, stop: () => noop() };
    },
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
