import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeCommandInvocation } from "../src/cli/dispatch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cliPath = path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs");
const exampleConfigPath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
const DISPATCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

test("normalizeCommandInvocation maps noun-verb commands", () => {
  assertNormalization("gateway", ["start"], { command: "gateway", args: [] });
  assertNormalization("gateway", ["start", "--verbose"], { command: "gateway", args: ["--verbose"] });
  assertNormalization("gateway", ["status"], { command: "gateway", args: ["status"] });
  assertNormalization("gateway", [], { command: "gateway", args: [] });
  assertNormalization("gateway", ["--verbose"], { command: "gateway", args: ["--verbose"] });
  assertNormalization("gateway", ["frobnicate"], { command: "gateway", args: ["frobnicate"] });
  assertNormalization("domain", ["add"], { command: "domain:add", args: [] });
  assertNormalization("domain", ["add", "--domain", "X"], { command: "domain:add", args: ["--domain", "X"] });
  assertNormalization("domain", ["bind-repo", "--domain", "X", "--path", "Y"], {
    command: "domain:bind-repo",
    args: ["--domain", "X", "--path", "Y"],
  });
  assertNormalization("domain", ["frobnicate"], { command: "domain", args: ["frobnicate"] });
  assertNormalization("doctor", [], { command: "doctor", args: [] });
  assertNormalization("domain:add", ["--domain", "X"], { command: "domain:add", args: ["--domain", "X"] });
});

test("CLI noun-verb commands dispatch to shipped command paths", async (t) => {
  const cases = [
    {
      name: "gateway start",
      tokens: ["gateway", "start"],
      expected: /Gateway could not start[\s\S]*no_active_domains/,
      unexpected: /Unknown gateway subcommand/,
    },
    {
      name: "gateway status",
      tokens: ["gateway", "status"],
      expected: /Gateway status could not be read[\s\S]*no_active_domains/,
    },
    {
      name: "domain add",
      tokens: ["domain", "add", "--workspace"],
      expected: /Usage: --workspace requires a workspace name or id/,
    },
  ];

  for (const dispatchCase of cases) {
    await t.test(dispatchCase.name, async (t) => {
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
      if (dispatchCase.unexpected) {
        assert.doesNotMatch(combinedOutput, dispatchCase.unexpected, resultSummary(dispatchCase, result));
      }
    });
  }
});

function assertNormalization(command, args, expected) {
  assert.deepEqual(normalizeCommandInvocation({ command, args }), expected);
}

async function runCliDispatch({ tokens }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-cli-noun-verb-"));
  const configPath = writeDispatchConfig(tempRoot);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...tokens], {
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
      resolve({ tokens, stdout: "", stderr: "", code: null, signal: null, spawnError: error });
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
      resolve({ tokens, stdout, stderr, code: null, signal: null, spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        tokens,
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
  const config = JSON.parse(
    fs.readFileSync(exampleConfigPath, "utf8"),
  );
  config.linear.oauth.credential_storage = "file";
  config.runtime.adapters.codex.command = "definitely-missing-codex-for-cli-noun-verb-test";
  config.runtime.adapters.claude.command = "definitely-missing-claude-for-cli-noun-verb-test";
  const configPath = path.join(tempRoot, "linear-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function resultSummary(dispatchCase, result) {
  return [
    `tokens=${JSON.stringify(dispatchCase.tokens)}`,
    `exit=${result.code} signal=${result.signal || "none"}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ].join("\n");
}
