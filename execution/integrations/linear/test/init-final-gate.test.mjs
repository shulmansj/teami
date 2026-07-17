import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  confirmCliSetupEffects,
  cliSetupFailureDiagnosis,
  factoryLauncherCommand,
  finishSuccessfulSetupOutput,
  finishSetupOutput,
  renderCliSetupResult,
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
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("runFinalGate passes when runtime smoke and doctor are green", async () => {
  const output = createRecordingOutput();
  const result = await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    teamRef: "team-one",
    output,
    phoenixOk: true,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "team registry", ok: true },
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
    teamRef: "team-one",
    output,
    phoenixOk: true,
    runSmoke: async () => ({ ok: false, results: [] }),
    runDoctor: async () => [
      { name: "team registry", ok: true },
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
    teamRef: "team-one",
    output,
    phoenixOk: true,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "team registry", ok: true },
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
    teamRef: "team-one",
    output,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "team registry", ok: true },
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
      commandOptions: { runGithubPhase: true, readyLabel: "First team" },
      phoenixAppUrl: "http://127.0.0.1:6006",
      finalGate: async () => ({ ok: true, smokeOk: true, doctorOk: true }),
    });

    assert.equal(process.exitCode, 0);
    assertCall(greenOutput, "done", "Teami is ready.");
    assert.ok(
      greenOutput.calls.some((call) =>
        call.method === "nextSteps" &&
        call.args[0].some((item) => item?.text.includes("/teami:plan"))),
    );

    const redOutput = createRecordingOutput();
    process.exitCode = 99;
    await finishSetupOutput({
      output: redOutput,
      commandOptions: { runGithubPhase: true, readyLabel: "First team" },
      finalGate: async () => ({ ok: false, smokeOk: true, doctorOk: false }),
    });

    assert.equal(process.exitCode, 1);
    assertCall(redOutput, "warn", `Setup is resumable — fix the checks above and re-run ${factoryLauncherCommand("init")}.`);
    assert.equal(redOutput.calls.some((call) => call.method === "done" && call.args[0] === "Teami is ready."), false);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("successful interactive init offers to start the listener and keeps the manual command visible", async () => {
  const output = createRecordingOutput();
  let starts = 0;
  await finishSuccessfulSetupOutput({
    context: {
      isTTY: true,
      probeListener: () => ({ state: "idle", evidence: { activeTeamRef: "main" } }),
      promptStartListener: async (message) => {
        assert.match(message, /keep listening in the background/i);
        return "";
      },
      startListener: async () => {
        starts += 1;
        return { ok: true, status: "started" };
      },
    },
    output,
    command: "init",
    config: {},
    repoRoot,
    home: repoRoot,
    phoenixAppUrl: "http://127.0.0.1:6006",
    gate: { ok: true, smokeOk: true, doctorOk: true },
  });

  assert.equal(starts, 1);
  assert.ok(output.calls.some((call) =>
    call.method === "info" &&
    String(call.args[0]).includes(factoryLauncherCommand("gateway start --background"))));
  assertCall(output, "info", "Turning on Teami's background listener.");
  assertCall(output, "info", "Setup is complete and Teami is listening.");
});

test("successful interactive init respects a declined listener start", async () => {
  const output = createRecordingOutput();
  let starts = 0;
  await finishSuccessfulSetupOutput({
    context: {
      isTTY: true,
      probeListener: () => ({ state: "idle", evidence: { activeTeamRef: "main" } }),
      promptStartListener: async () => "n",
      startListener: async () => {
        starts += 1;
      },
    },
    output,
    command: "init",
    config: {},
    repoRoot,
    home: repoRoot,
    phoenixAppUrl: "http://127.0.0.1:6006",
    gate: { ok: true, smokeOk: true, doctorOk: true },
  });

  assert.equal(starts, 0);
  assertCall(output, "info", "Teami will remain stopped. Planned projects wait safely in Linear until you start the listener.");
});

test("interactive init keeps setup complete when the listener prompt closes", async () => {
  const output = createRecordingOutput();
  let starts = 0;
  await finishSuccessfulSetupOutput({
    context: {
      isTTY: true,
      probeListener: () => ({ state: "idle", evidence: { activeTeamRef: "main" } }),
      promptStartListener: async () => { throw new Error("fixture prompt closed"); },
      startListener: async () => { starts += 1; return { ok: true, status: "started" }; },
    },
    output,
    command: "init",
    config: {},
    repoRoot,
    home: repoRoot,
    gate: { ok: true, smokeOk: true, doctorOk: true },
  });

  assert.equal(starts, 0);
  assert.ok(output.calls.some((call) =>
    call.method === "warn" && String(call.args[0]).includes("Start it later")));
  assertCall(output, "info", "Setup is complete. Teami is not listening yet; Planned projects will wait safely in Linear.");
});

test("non-interactive init never prompts and prints the manual listener command", async () => {
  const output = createRecordingOutput();
  let prompts = 0;
  await finishSuccessfulSetupOutput({
    context: {
      isTTY: false,
      probeListener: () => ({ state: "idle", evidence: { activeTeamRef: "main" } }),
      promptStartListener: async () => { prompts += 1; return "y"; },
    },
    output,
    command: "init",
    config: {},
    repoRoot,
    home: repoRoot,
    gate: { ok: true, smokeOk: true, doctorOk: true },
  });

  assert.equal(prompts, 0);
  assert.ok(output.calls.some((call) =>
    call.method === "info" && String(call.args[0]).includes(factoryLauncherCommand("gateway start --background"))));
});

test("interactive init reports a returned listener-start failure instead of claiming success", async () => {
  const previousExitCode = process.exitCode;
  try {
    const output = createRecordingOutput();
    process.exitCode = 0;
    await finishSuccessfulSetupOutput({
      context: {
        isTTY: true,
        probeListener: () => ({ state: "idle", evidence: { activeTeamRef: "main" } }),
        promptStartListener: async () => "y",
        startListener: async () => ({ ok: false, status: "failed", reason: "fixture_start_failed" }),
      },
      output,
      command: "init",
      config: {},
      repoRoot,
      home: repoRoot,
      gate: { ok: true, smokeOk: true, doctorOk: true },
    });

    assert.equal(process.exitCode, 1);
    assert.ok(output.calls.some((call) =>
      call.method === "error" &&
      call.args[0]?.what === "Setup completed, but the listener did not start" &&
      call.args[0]?.why === "fixture_start_failed"));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("runFinalGate is idempotent with injected fakes", async () => {
  const makeArgs = () => ({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    teamRef: "team-one",
    output: createRecordingOutput(),
    phoenixOk: true,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [
      { name: "team registry", ok: true },
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

test("CLI setup uses the same disclosure and requires a simple explicit confirmation", async () => {
  const rejectedOutput = createRecordingOutput();
  const rejected = await confirmCliSetupEffects({
    context: { isTTY: false },
    output: rejectedOutput,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "consent_required");
  assertCall(rejectedOutput, "section", "Welcome to Teami");

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

  let prompt = null;
  const acceptedByPrompt = await confirmCliSetupEffects({
    context: {
      isTTY: true,
      promptSetupEffects: async (value) => {
        prompt = value;
        return "yes";
      },
    },
    output: createRecordingOutput(),
  });
  assert.equal(acceptedByPrompt.ok, true);
  assert.equal(prompt, "Continue? [y/N]: ");
});

test("CLI setup refuses to interleave with a pending conversational setup", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-active-setup-"));
  const previousExitCode = process.exitCode;
  try {
    const store = createSetupStateStore({ home });
    const active = store.start({
      input: { team: "Pending MCP", repo_intent: { mode: "non_code" } },
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

test("CLI init surfaces installed-app recovery while Linear authorization is still pending", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-installed-app-recovery-"));
  const previousExitCode = process.exitCode;
  try {
    const output = createRecordingOutput();
    const result = await runLinearSetupCommand({
      command: "init",
      args: [],
      context: {
        config: loadLinearConfig({ repoRoot }),
        repoRoot,
        home,
        output,
        confirmSetupEffects: async () => true,
        isTTY: true,
        promptTeamName: async () => "",
        authorizationPollTimeoutMs: 50,
        installedAppRecoveryDelayMs: 0,
        startLinearBrowserAuthorization: async () => ({
          authorizationUrl: "https://linear.test/oauth/authorize?pending=true",
          expiresAt: "2099-01-01T00:00:00.000Z",
          browser: { opened: true, reason: null },
          waitForToken: () => new Promise(() => {}),
          close: async () => true,
        }),
      },
    });

    assert.equal(result.status, "blocked");
    const visibleWarning = output.calls
      .filter((call) => call.method === "warn")
      .map((call) => String(call.args[0]))
      .join("\n");
    assert.match(visibleWarning, /Teami already installed/i);
    assert.match(visibleWarning, /old workspace-scoped Teami installation/i);
    assert.match(visibleWarning, /no longer has its matching grant/i);
    assert.match(visibleWarning, /click Manage/i);
    assert.match(visibleWarning, /refresh it/i);
    assert.match(visibleWarning, /session is still open/i);
    assert.match(visibleWarning, /disconnects Teami for everyone/i);
    assert.match(visibleWarning, /coordinate first/i);
    const store = createSetupStateStore({ home });
    assert.equal(store.findActive(), null, "a timed-out CLI session must not strand the next init attempt");
    const timedOut = store.read(result.setup_id);
    assert.equal(timedOut.status, "blocked");
    assert.equal(timedOut.phases.linear.reason, "cli_authorization_poll_timeout");
  } finally {
    process.exitCode = previousExitCode;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI init and team add are renderers over the same resumable onboarding action as MCP", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /if \(\["init", "team:add"\]\.includes\(command\)\) \{\s*return runCliSharedOnboarding\(/);
  assert.match(source, /runCliSharedOnboarding\(\{\s*context:[\s\S]*?command,\s*args,/);
  assert.match(source, /createProjectMcpToolActions/);
  assert.match(source, /actions\.init_onboarding\(input\)/);
  assert.match(source, /const repoIntent = \{ mode: "non_code" \}/);
  assert.match(source, /setupStateStore/);
  assert.doesNotMatch(source, /shared_setup_call_timeout|sharedSetupCallTimeoutMs/);
  assert.doesNotMatch(source, /actionOptions\.promptLinearWorkspaceConfirmation/);
});

test("CLI setup renders the safe Claude plugin cause and exact resumable repair", () => {
  const output = createRecordingOutput();
  const result = {
    ok: false,
    steps: {
      plugin: {
        ok: false,
        reason: "claude_plugin_install_failed",
        detail: "marketplace denied",
        repair: "Repair Claude Code plugin access, then re-run teami init.",
      },
    },
  };
  renderCliSetupResult({ result, output });
  const visible = output.calls.flatMap((call) => call.args).join("\n");
  assert.match(visible, /Claude Code integration: marketplace denied/);
  assert.match(visible, /Repair Claude Code plugin access, then re-run teami init/);
  assert.deepEqual(cliSetupFailureDiagnosis(result), {
    why: "Claude Code integration: marketplace denied",
    fix: "Repair Claude Code plugin access, then re-run teami init.",
  });
});

test("CLI setup renders the failed runtime role and runtime-smoke repair", () => {
  const output = createRecordingOutput();
  const result = {
    ok: false,
    steps: {
      runtime: {
        ok: false,
        reason: "runtime_smoke_failed",
        detail: "codex: configured model unavailable",
        repair: "Run teami runtime-smoke, repair codex, then re-run teami init.",
      },
    },
  };
  renderCliSetupResult({ result, output });
  const visible = output.calls.flatMap((call) => call.args).join("\n");
  assert.match(visible, /Agent runtimes: codex: configured model unavailable/);
  assert.match(visible, /teami runtime-smoke/);
  assert.match(cliSetupFailureDiagnosis(result).why, /configured model unavailable/);
});

test("CLI setup preserves doctor messages and explains a thrown doctor check", () => {
  const failedOutput = createRecordingOutput();
  const failedResult = {
    ok: false,
    steps: {
      doctor: {
        ok: false,
        reason: "doctor_failed",
        checks: [{ name: "GitHub write access", state: "fail", message: "permission was revoked" }],
      },
    },
  };
  renderCliSetupResult({ result: failedResult, output: failedOutput });
  assert.match(failedOutput.calls.flatMap((call) => call.args).join("\n"), /permission was revoked/);
  assert.match(cliSetupFailureDiagnosis(failedResult).why, /permission was revoked/);

  const thrownOutput = createRecordingOutput();
  const thrownResult = {
    ok: false,
    steps: {
      doctor: {
        ok: false,
        reason: "doctor_check_exception",
        detail: "doctor transport stopped",
        repair: "Run teami doctor, then re-run teami init.",
        checks: [],
      },
    },
  };
  renderCliSetupResult({ result: thrownResult, output: thrownOutput });
  assert.match(thrownOutput.calls.flatMap((call) => call.args).join("\n"), /doctor transport stopped/);
  assert.deepEqual(cliSetupFailureDiagnosis(thrownResult), {
    why: "Final health: doctor transport stopped",
    fix: "Run teami doctor, then re-run teami init.",
  });
});

test("CLI setup names doctor warnings before reporting health passed with warnings", () => {
  const output = createRecordingOutput();
  renderCliSetupResult({
    result: {
      ok: true,
      steps: {
        doctor: {
          ok: true,
          checks: [{ name: "Local Phoenix", state: "warn", message: "trace viewer is stopped" }],
        },
      },
    },
    output,
  });
  assertCall(output, "warn", "Local Phoenix: trace viewer is stopped");
  assertCall(output, "success", "Final health check passed with warnings");
  assert.equal(output.calls.some((call) =>
    call.method === "success" && call.args[0] === "Final health check passed"), false);
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
