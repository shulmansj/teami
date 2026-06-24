import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cliPath = path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs");
const exampleConfigPath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
const DISPATCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

const DISPATCH_CASES = Object.freeze([
  { command: "doctor", args: [], expected: /[✗×x] domain registry:/ },
  { command: "doctor:linear", args: [], expected: /[✗×x] domain registry:/ },
  { command: "domain:add", args: ["--workspace"], expected: /Usage: --workspace requires a workspace name or id\./ },
  { command: "domain:bind-repo", args: [], expected: /Agentic Factory [·-] domain bind repo[\s\S]*[✗×x] Usage: npm run domain:bind-repo/ },
  { command: "draft-improvement", args: [], expected: /Agentic Factory [·-] draft improvement[\s\S]*[✗×x] Usage: npm run draft-improvement/ },
  { command: "eval:decomposition", args: [], expected: /Agentic Factory [·-] eval decomposition[\s\S]*[✗×x] Eval decomposition could not run[\s\S]*no_active_domains:/ },
  { command: "eval:disagreements", args: [], expected: /Agentic Factory [·-] eval disagreements[\s\S]*[✗×x] Usage: npm run eval:disagreements/ },
  { command: "eval:emit-checks", args: [], expected: /Agentic Factory [·-] eval emit-checks[\s\S]*[✗×x] Usage: npm run eval:emit-checks/ },
  { command: "eval:gate", args: [], expected: /Agentic Factory [·-] eval gate[\s\S]*[✗×x] Usage: npm run eval:gate/ },
  { command: "eval:judge", args: [], expected: /Agentic Factory [·-] eval judge[\s\S]*[✗×x] Usage: npm run eval:judge/ },
  { command: "eval:register-judge-prompt", args: [], expected: /Agentic Factory [·-] eval register judge prompt[\s\S]*[✗×x] Prompt registration failed/ },
  { command: "eval:register-prompt", args: [], expected: /Agentic Factory [·-] eval register prompt[\s\S]*[✗×x] Usage: npm run eval:register-prompt/ },
  { command: "github:init", args: ["--github-dry-run"], expected: /GitHub connection failed|Repo connected:/ },
  { command: "init", args: ["--workspace"], expected: /Usage: --workspace requires a workspace name or id\./ },
  { command: "phoenix:annotate-trace", args: [], expected: /Agentic Factory [·-] phoenix annotate trace[\s\S]*[✗×x] Usage: npm run phoenix:annotate-trace/ },
  { command: "phoenix:doctor", args: [], expected: /Agentic Factory [·-] phoenix doctor[\s\S]*[✗×x] Local Phoenix doctor could not run[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:experiment-amend", args: [], expected: /Agentic Factory [·-] phoenix experiment amend[\s\S]*[✗×x] Usage: npm run phoenix:experiment-amend/ },
  { command: "phoenix:experiment-decomposition", args: [], expected: /Agentic Factory [·-] phoenix experiment decomposition[\s\S]*[✗×x] Usage: npm run phoenix:experiment-decomposition/ },
  { command: "phoenix:preflight", args: [], expected: /Agentic Factory [·-] phoenix preflight[\s\S]*[✗×x] Local Phoenix preflight could not run[\s\S]*no_active_domains:/ },
  { command: "phoenix:promote-decomposition", args: [], expected: /Agentic Factory [·-] phoenix promote decomposition[\s\S]*[✗×x] Usage: npm run phoenix:promote-decomposition/ },
  { command: "phoenix:promote-run", args: [], expected: /Agentic Factory [·-] phoenix promote run[\s\S]*[✗×x] Usage: npm run phoenix:promote-run/ },
  { command: "phoenix:start", args: [], expected: /Agentic Factory [·-] phoenix start[\s\S]*[✗×x] Local Phoenix could not start[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:status", args: [], expected: /Agentic Factory [·-] phoenix status[\s\S]*[✗×x] Local Phoenix status could not be read[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "phoenix:stop", args: [], expected: /Agentic Factory [·-] phoenix stop[\s\S]*[✗×x] Local Phoenix stop failed[\s\S]*Local Phoenix must bind to loopback/ },
  { command: "promote-candidate", args: [], expected: /Agentic Factory [·-] promote candidate[\s\S]*[✗×x] Usage: npm run promote-candidate/ },
  { command: "promotion:scan", args: [], expected: /Agentic Factory [·-] promotion scan[\s\S]*(?:[✗×x] Promotion scan could not complete|[✓+] Promotion scan completed)/ },
  { command: "reset", args: [], expected: /[✓√+] Reset complete\./ },
  { command: "runner", args: [], expected: /Agentic Factory [·-] runner[\s\S]*[✗×x] Runner could not start[\s\S]*no_active_domains:/ },
  { command: "runtime-smoke", args: [], expected: /Agentic Factory [·-] runtime smoke[\s\S]*[✗×x] Runtime smoke (?:could not run|found runtime checks that need repair)/ },
  { command: "supervisor", args: ["--max-iterations", "0"], expected: /Agentic Factory [·-] supervisor run[\s\S]*[✗×x] Supervisor run needs attention[\s\S]*preflight checks need attention/ },
  { command: "supervisor:disable", args: [], expected: /Agentic Factory [·-] supervisor disable[\s\S]*[✓+] Supervisor disabled\./ },
  { command: "supervisor:enable", args: [], expected: /Agentic Factory [·-] supervisor enable[\s\S]*[✓+] Supervisor enabled\./ },
  { command: "supervisor:reconcile", args: [], expected: /Agentic Factory [·-] supervisor reconcile[\s\S]*Next resume[\s\S]*[✓+] No stalled resume work needs intervention\./ },
  { command: "supervisor:register", args: [], expected: /Agentic Factory [·-] supervisor register[\s\S]*[✗×x] Supervisor registration requires explicit consent/ },
  { command: "supervisor:run", args: ["--max-iterations", "0"], expected: /Agentic Factory [·-] supervisor run[\s\S]*[✗×x] Supervisor run needs attention[\s\S]*preflight checks need attention/ },
  { command: "supervisor:status", args: [], expected: /Agentic Factory [·-] supervisor status[\s\S]*[✗×x] Supervisor status needs attention[\s\S]*missing_local_supervisor_registration/ },
  { command: "supervisor:unregister", args: [], expected: /Agentic Factory [·-] supervisor unregister[\s\S]*[✓+] Supervisor local state cleaned up\.[\s\S]*(?:Already clean: local supervisor|Real OS login\/autostart deregistration)/ },
  { command: "trigger-status", args: [], expected: /Agentic Factory [·-] trigger status[\s\S]*[✗×x] Trigger status could not be read[\s\S]*no_active_domains:/ },
  { command: "uninstall", args: [], expected: /[✓√+] Uninstall complete\./ },
  { command: "worklist", args: [], expected: /Agentic Factory [·-] worklist[\s\S]*Behavior proposal decisions[\s\S]*Repair and setup blockers[\s\S]*Local evidence[\s\S]*Local evidence status could not be read/ },
]);

const JAVASCRIPT_CRASH_PATTERN =
  /\b(?:ReferenceError|TypeError|SyntaxError)\b|Cannot access .* before initialization|Cannot read properties of| is not defined|\n\s+at .*cli\.mjs:/i;

test("CLI dispatch fixture covers every command branch in cli.mjs", () => {
  const source = fs.readFileSync(cliPath, "utf8");
  const dispatchCommands = [...source.matchAll(/command === "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  const coveredCommands = DISPATCH_CASES.map((entry) => entry.command).sort();

  assert.deepEqual(coveredCommands, dispatchCommands);
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
          /\b(?:git|npm|node|token|raw diff|Phoenix ID|check-log|broker|branch)\b/i,
          resultSummary(dispatchCase, result),
        );
      }
    });
  }
});

async function runCliDispatch({ command, args }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-cli-dispatch-"));
  const configPath = writeDispatchConfig(tempRoot);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, command, ...args], {
        cwd: tempRoot,
        env: {
          ...process.env,
          AGENTIC_FACTORY_LINEAR_CONFIG: configPath,
          AGENTIC_FACTORY_PHOENIX_URL: "http://not-loopback.invalid:6006",
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
    fs.readFileSync(exampleConfigPath, "utf8")
      .replaceAll("public-hosted-setup.agentic-factory.invalid", "dispatch-fixture.agentic-factory.invalid"),
  );
  config.linear.oauth.credential_storage = "file";
  config.inbox.credential_storage = "file";
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
