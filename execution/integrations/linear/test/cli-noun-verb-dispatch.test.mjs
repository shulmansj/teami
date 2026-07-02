import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMMAND_INDEX,
  normalizeCommandInvocation,
} from "../src/cli/dispatch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cliPath = path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs");
const exampleConfigPath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
const DISPATCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

test("normalizeCommandInvocation maps noun-verb commands", () => {
  assertNormalization("gateway", ["start"], { command: "gateway", args: [] });
  assertNormalization("gateway", ["start", "--verbose"], { command: "gateway", args: ["--verbose"] });
  assertNormalization("gateway", ["status"], { command: "gateway", args: ["status"] });
  assertNormalization("gateway", ["--verbose", "status"], { command: "gateway", args: ["--verbose", "status"] });
  assertNormalization("gateway", ["status", "--verbose"], { command: "gateway", args: ["status", "--verbose"] });
  assertNormalization("gateway", [], { command: "gateway", args: [] });
  assertNormalization("gateway", ["--verbose"], { command: "gateway", args: ["--verbose"] });
  assertNormalization("gateway", ["frobnicate"], { command: "gateway", args: ["frobnicate"] });
  assertNormalization("domain", ["add"], { command: "domain:add", args: [] });
  assertNormalization("domain", ["--verbose", "add"], { command: "domain", args: ["--verbose", "add"] });
  assertNormalization("domain", ["add", "--verbose"], { command: "domain:add", args: ["--verbose"] });
  assertNormalization("domain", ["add", "--domain", "X"], { command: "domain:add", args: ["--domain", "X"] });
  assertNormalization("domain", ["show", "main"], { command: "domain:show", args: ["main"] });
  assertNormalization("domain", ["grant", "main", "--repo", "acme/app"], {
    command: "domain:grant",
    args: ["main", "--repo", "acme/app"],
  });
  assertNormalization("domain", ["revoke", "main", "--repo", "acme/app"], {
    command: "domain:revoke",
    args: ["main", "--repo", "acme/app"],
  });
  const retiredRepoPathVerb = ["bind", "repo"].join("-");
  assertNormalization("domain", [retiredRepoPathVerb, "--domain", "X", "--path", "Y"], {
    command: "domain",
    args: [retiredRepoPathVerb, "--domain", "X", "--path", "Y"],
  });
  assert.equal(COMMAND_INDEX.has(`domain:${retiredRepoPathVerb}`), false);
  assertNormalization("domain", ["frobnicate"], { command: "domain", args: ["frobnicate"] });
  assertNormalization("execution", ["run", "--issue", "ISS-1"], {
    command: "execution:run",
    args: ["--issue", "ISS-1"],
  });
  assertNormalization("execution", ["--verbose", "run"], {
    command: "execution",
    args: ["--verbose", "run"],
  });
  assertNormalization("execution", ["frobnicate"], { command: "execution", args: ["frobnicate"] });
  assertNormalization("review", ["run", "--issue", "ISS-1"], {
    command: "review:run",
    args: ["--issue", "ISS-1"],
  });
  assertNormalization("review", ["--verbose", "run"], {
    command: "review",
    args: ["--verbose", "run"],
  });
  assertNormalization("review", ["frobnicate"], { command: "review", args: ["frobnicate"] });
  assertNormalization("phoenix", ["open"], { command: "phoenix:open", args: [] });
  assertNormalization("phoenix", ["status"], { command: "phoenix:status", args: [] });
  assertNormalization("phoenix", ["frobnicate"], { command: "phoenix", args: ["frobnicate"] });
  assertNormalization("phoenix", ["start"], { command: "phoenix", args: ["start"] });
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
      // Adopter `gateway status` is now read-only: no poll, so no "could not be read"/no_active_domains.
      expected: /gateway status[\s\S]*Not set up yet/,
      unexpected: /Gateway status could not be read|no_active_domains/,
    },
    {
      name: "domain add",
      tokens: ["domain", "add", "--workspace"],
      expected: /Usage: --workspace requires a workspace name or id/,
    },
    {
      name: "domain show",
      tokens: ["domain", "show", "main"],
      expected: /domain show[\s\S]*Domain show failed[\s\S]*domain_registry_missing/,
    },
    {
      name: "execution run",
      tokens: ["execution", "run", "--issue", "ISS-1"],
      expected: /execution run[\s\S]*Execution run could not start[\s\S]*no_active_domains/,
    },
    {
      name: "review run",
      tokens: ["review", "run", "--issue", "ISS-1"],
      expected: /review run[\s\S]*Review run could not start[\s\S]*no_active_domains/,
    },
    {
      name: "phoenix open",
      tokens: ["phoenix", "open"],
      expected: /phoenix open[\s\S]*Local Phoenix could not start/,
    },
    {
      name: "phoenix status",
      tokens: ["phoenix", "status"],
      expected: /phoenix status[\s\S]*Local Phoenix status could not be read/,
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cli-noun-verb-"));
  const configPath = writeDispatchConfig(tempRoot);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...tokens], {
        cwd: tempRoot,
        env: {
          ...process.env,
          FACTORY_REPO_ROOT: tempRoot,
          TEAMI_LINEAR_CONFIG: configPath,
          TEAMI_PHOENIX_URL: "http://not-loopback.invalid:6006",
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
