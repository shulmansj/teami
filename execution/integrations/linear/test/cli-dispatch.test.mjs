import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { COMMAND_REGISTRY } from "../src/cli/dispatch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cliPath = path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs");
const exampleConfigPath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
// This matrix detects commands that hang or crash; it is not a performance
// budget. Keep enough margin for a fully parallel test run on slower hosts.
const DISPATCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

const DISPATCH_CASES = Object.freeze([
  { command: "doctor", args: [], expected: /[✗×x] domain registry:/ },
  { command: "doctor:linear", args: [], expected: /[✗×x] domain registry:/ },
  { command: "domain:add", args: ["--workspace"], expected: /Usage: --workspace requires a workspace name or id\./ },
  { command: "domain:grant", args: [], expected: /Teami [·-] domain grant[\s\S]*[✗×x] Usage: .*domain grant <id> --repo <owner\/name>/ },
  { command: "domain:revoke", args: [], expected: /Teami [·-] domain revoke[\s\S]*[✗×x] Usage: .*domain revoke <id> --repo <owner\/name>/ },
  { command: "domain:show", args: [], expected: /Teami [·-] domain show[\s\S]*[✗×x] Usage: .*domain show <id>/ },
  { command: "draft-improvement", args: [], expected: /Teami [·-] draft improvement[\s\S]*[✗×x] Usage: npm run draft-improvement/ },
  { command: "eval:decomposition", args: [], expected: /Teami [·-] eval decomposition[\s\S]*[✗×x] Eval decomposition could not run[\s\S]*no_active_domains:/ },
  { command: "eval:disagreements", args: [], expected: /Teami [·-] eval disagreements[\s\S]*[✗×x] Usage: npm run eval:disagreements/ },
  { command: "eval:emit-checks", args: [], expected: /Teami [·-] eval emit-checks[\s\S]*[✗×x] Usage: npm run eval:emit-checks/ },
  { command: "eval:gate", args: [], expected: /Teami [·-] eval gate[\s\S]*[✗×x] Usage: npm run eval:gate/ },
  { command: "eval:judge", args: [], expected: /Teami [·-] eval judge[\s\S]*[✗×x] Usage: npm run eval:judge/ },
  { command: "review:run", args: [], expected: /Teami [·-] review run[\s\S]*[✗×x] Usage: .*teami(?:\.cmd)? review run --issue/ },
  { command: "eval:register-judge-prompt", args: [], expected: /Teami [·-] eval register judge prompt[\s\S]*[✗×x] Prompt registration failed/ },
  { command: "eval:register-prompt", args: [], expected: /Teami [·-] eval register prompt[\s\S]*[✗×x] Usage: npm run eval:register-prompt/ },
  { command: "github:init", args: ["--github-dry-run"], expected: /GitHub connection failed|Repo connected:/ },
  { command: "gateway", args: [], expected: /Teami [·-] gateway[\s\S]*[✗×x] Gateway could not start[\s\S]*no_active_domains:/ },
  { command: "init", args: ["--workspace"], expected: /Usage: --workspace requires a workspace name or id\./ },
  { command: "phoenix:annotate-trace", args: [], expected: /Teami [·-] phoenix annotate trace[\s\S]*[✗×x] Usage: npm run phoenix:annotate-trace/ },
  { command: "phoenix:doctor", args: [], expected: /Teami [·-] phoenix doctor[\s\S]*[✗×x] Local Phoenix doctor could not run[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:experiment-amend", args: [], expected: /Teami [·-] phoenix experiment amend[\s\S]*[✗×x] Usage: npm run phoenix:experiment-amend/ },
  { command: "phoenix:experiment-decomposition", args: [], expected: /Teami [·-] phoenix experiment decomposition[\s\S]*[✗×x] Usage: npm run phoenix:experiment-decomposition/ },
  { command: "phoenix:open", args: [], expected: /phoenix open[\s\S]*Local Phoenix could not start[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:preflight", args: [], expected: /Teami [·-] phoenix preflight[\s\S]*[✗×x] Local Phoenix preflight could not run[\s\S]*no_active_domains:/ },
  { command: "phoenix:promote-decomposition", args: [], expected: /Teami [·-] phoenix promote decomposition[\s\S]*[✗×x] Usage: npm run phoenix:promote-decomposition/ },
  { command: "phoenix:promote-run", args: [], expected: /Teami [·-] phoenix promote run[\s\S]*[✗×x] Usage: npm run phoenix:promote-run/ },
  { command: "phoenix:start", args: [], expected: /Teami [·-] phoenix start[\s\S]*[✗×x] Local Phoenix could not start[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:status", args: [], expected: /Teami [·-] phoenix status[\s\S]*[✗×x] Local Phoenix status could not be read[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:stop", args: [], expected: /Teami [·-] phoenix stop[\s\S]*[✗×x] Local Phoenix stop failed[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "promote-candidate", args: [], expected: /Teami [·-] promote candidate[\s\S]*[✗×x] Usage: npm run promote-candidate/ },
  { command: "promotion:scan", args: [], expected: /Teami [·-] promotion scan[\s\S]*(?:[✗×x] Promotion scan could not complete|[✓+] Promotion scan completed)/ },
  { command: "reset", args: [], expected: /[✓√+] Reset complete\./ },
  { command: "runner", args: [], expected: /Teami [·-] gateway[\s\S]*[✗×x] Gateway could not start[\s\S]*no_active_domains:/ },
  { command: "runtime-smoke", args: [], expected: /Teami [·-] runtime smoke[\s\S]*[✗×x] Runtime smoke (?:could not run|found runtime checks that need repair)/ },
  { command: "trigger-status", args: [], expected: /Teami [·-] gateway status[\s\S]*[✗×x] Gateway status could not be read[\s\S]*no_active_domains:/ },
  { command: "uninstall", args: [], expected: /[✓√+] Uninstall complete\./ },
  { command: "worklist", args: [], expected: /Teami [·-] worklist[\s\S]*Behavior proposal decisions[\s\S]*Repair and setup blockers[\s\S]*Local evidence[\s\S]*Local evidence status could not be read/ },
]);

const HELP_CASES = Object.freeze([
  // <command> --help renders in the platform launcher form, not "npm run ...".
  { command: "init", args: ["--help"], expected: /teami(?:\.cmd)? init \[--domain <name>\]/ },
  { command: "doctor", args: ["--help"], expected: /teami(?:\.cmd)? doctor/ },
  { command: "domain:grant", args: ["--help"], expected: /teami(?:\.cmd)? domain grant <id> --repo <owner\/name>/ },
  { command: "domain:revoke", args: ["--help"], expected: /teami(?:\.cmd)? domain revoke <id> --repo <owner\/name>/ },
  { command: "domain:show", args: ["--help"], expected: /teami(?:\.cmd)? domain show <id>/ },
  // gateway --help renders the bare-noun form (not "gateway start"); gateway status --help too.
  { command: "gateway", args: ["--help"], expected: /teami(?:\.cmd)? gateway \[status\]/ },
  { command: "gateway", args: ["status", "--help"], expected: /teami(?:\.cmd)? gateway \[status\]/ },
  // phoenix:status is now an adopter noun-verb: its --help shows the space form (colon still resolves).
  { command: "phoenix:status", args: ["--help"], expected: /teami(?:\.cmd)? phoenix status/ },
  // The default surface is curated grouped help, not the old command wall.
  { command: "--help", args: [], expected: /Setup[\s\S]*Run[\s\S]*Manage/ },
  { command: "help", args: [], expected: /Setup[\s\S]*Run[\s\S]*Manage/ },
  { command: "help", args: ["--all"], expected: /Operator & maintenance[\s\S]*eval:/ },
]);

const JAVASCRIPT_CRASH_PATTERN =
  /\b(?:ReferenceError|TypeError|SyntaxError)\b|Cannot access .* before initialization|Cannot read properties of| is not defined|\n\s+at .*cli\.mjs:/i;

test("CLI dispatch fixture covers every routable registry command", () => {
  const routableTokens = [...new Set(
    COMMAND_REGISTRY.flatMap((descriptor) => [descriptor.invokeCommand, ...descriptor.aliases]),
  )].sort();
  const coveredCommands = DISPATCH_CASES.map((entry) => entry.command).sort();

  assert.deepEqual(coveredCommands, routableTokens);
});

test("CLI dispatch commands fail closed or print help without JavaScript initialization crashes", async (t) => {
  for (const dispatchCase of DISPATCH_CASES) {
    await t.test(dispatchCase.command, async (t) => {
      const result = await runCliDispatch(dispatchCase);
      if (result.spawnError?.code === "EPERM") {
        t.skip(`subprocess spawn is blocked in this sandbox: ${result.spawnError.message}`);
        return;
      }
      assert.ifError(result.spawnError);

      const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
      assert.equal(result.timedOut, false, resultSummary(dispatchCase, result));
      assert.equal(result.outputTooLarge, false, resultSummary(dispatchCase, result));
      assert.ok([0, 1, 2].includes(result.code), resultSummary(dispatchCase, result));
      assert.match(combinedOutput, dispatchCase.expected, resultSummary(dispatchCase, result));
      assert.doesNotMatch(combinedOutput, JAVASCRIPT_CRASH_PATTERN, resultSummary(dispatchCase, result));
      if (dispatchCase.command === "worklist") {
        const proposalOutput = combinedOutput.split(/\bLocal evidence\b/)[0] || combinedOutput;
        assert.doesNotMatch(
          proposalOutput,
          /\b(?:git|npm|node|token|raw diff|Phoenix ID|check-log|branch)\b/i,
          resultSummary(dispatchCase, result),
        );
      }
    });
  }
});

test("CLI help flags do not load config or enter command side effects", async (t) => {
  for (const helpCase of HELP_CASES) {
    await t.test(helpCase.command, async (t) => {
      const result = await runCliDispatchWithoutConfig(helpCase);
      if (result.spawnError?.code === "EPERM") {
        t.skip(`subprocess spawn is blocked in this sandbox: ${result.spawnError.message}`);
        return;
      }
      assert.ifError(result.spawnError);

      const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
      assert.equal(result.timedOut, false, resultSummary(helpCase, result));
      assert.equal(result.outputTooLarge, false, resultSummary(helpCase, result));
      assert.equal(result.code, 0, resultSummary(helpCase, result));
      assert.match(combinedOutput, helpCase.expected, resultSummary(helpCase, result));
      assert.doesNotMatch(combinedOutput, /Linear config not found|Opening Linear authorization|Authorizing grants/i);
    });
  }
});

async function runCliDispatch({ command, args }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-dispatch-"));
  const home = path.join(tempRoot, "teami-home");
  const configPath = writeDispatchConfig(tempRoot);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, command, ...args], {
        cwd: tempRoot,
        env: {
          ...process.env,
          FACTORY_REPO_ROOT: tempRoot,
          TEAMI_HOME: home,
          TEAMI_LINEAR_CONFIG: configPath,
          TEAMI_PHOENIX_URL: "http://not-loopback.invalid:6006",
          NO_COLOR: "1",
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ command, args, stdout: "", stderr: "", code: null, signal: null, spawnError: error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DISPATCH_TIMEOUT_MS);
    const append = (stream, chunk) => {
      const next = stream + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill();
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, args, stdout, stderr, code: null, signal: null, spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        outputTooLarge,
        spawnError: null,
      });
    });
  });
}

async function runCliDispatchWithoutConfig({ command, args }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-help-"));
  const home = path.join(tempRoot, "teami-home");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, command, ...args], {
        cwd: tempRoot,
        env: {
          ...process.env,
          FACTORY_REPO_ROOT: tempRoot,
          TEAMI_HOME: home,
          TEAMI_LINEAR_CONFIG: path.join(tempRoot, "missing-config.json"),
          NO_COLOR: "1",
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ command, args, stdout: "", stderr: "", code: null, signal: null, spawnError: error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DISPATCH_TIMEOUT_MS);
    const append = (stream, chunk) => {
      const next = stream + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill();
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, args, stdout, stderr, code: null, signal: null, spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        outputTooLarge,
        spawnError: null,
      });
    });
  });
}

function writeDispatchConfig(tempRoot) {
  // This smoke matrix tests command dispatch wiring, not real downstream calls,
  // so keep it on a non-resolvable fixture host while still passing the clients'
  // fail-closed placeholder guard covered directly by the client unit tests.
  const config = JSON.parse(
    fs.readFileSync(exampleConfigPath, "utf8"),
  );
  config.linear.oauth.credential_storage = "file";
  config.runtime.adapters.codex.command = "definitely-missing-codex-for-cli-dispatch-test";
  config.runtime.adapters.claude.command = "definitely-missing-claude-for-cli-dispatch-test";
  const configPath = path.join(tempRoot, "linear-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function resultSummary(dispatchCase, result) {
  return [
    `command=${dispatchCase.command} args=${JSON.stringify(dispatchCase.args)}`,
    `exit=${result.code} signal=${result.signal || "none"}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ].join("\n");
}
