import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readClaudePluginHealth } from "../src/claude-plugin-health.mjs";
import { resolveTeamiHome, teamiHomePaths } from "../src/app-home.mjs";
import {
  ensurePhoenixReady,
  phoenixPythonPath,
  resolvePhoenixConfig,
} from "../src/local-phoenix-manager.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimeManifestPath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "src",
  "runtime",
  "runtime-manifest.json",
);

test("Claude plugin health retries a transient read before blocking setup", async () => {
  let marketplaceReads = 0;
  const health = await readClaudePluginHealth({
    repoRoot,
    marketplaceSource: "https://github.com/shulmansj/teami",
    runCommand: async (_command, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        marketplaceReads += 1;
        if (marketplaceReads === 1) {
          return { ok: false, status: 1, stdout: "", stderr: "transient read failure" };
        }
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify([{
            name: "teami",
            source: "git",
            url: "https://github.com/shulmansj/teami.git",
          }]),
          stderr: "",
        };
      }
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify([{
          id: "teami@teami",
          version: "0.3.20",
          scope: "user",
          enabled: true,
          mcpServers: {
            teami: {
              command: "npx",
              args: ["-y", "@shulmansj/teami@0.3.20", "mcp"],
            },
          },
        }]),
        stderr: "",
      };
    },
  });

  assert.equal(health.ok, true);
  assert.equal(marketplaceReads, 2);
});

test("Claude plugin health survives a short run of transient read failures", async () => {
  let marketplaceReads = 0;
  const readTimeouts = [];
  const health = await readClaudePluginHealth({
    repoRoot,
    marketplaceSource: "https://github.com/shulmansj/teami",
    readRetryDelaysMs: [0, 0, 0, 0],
    runCommand: async (_command, args, options) => {
      readTimeouts.push(options.timeoutMs);
      if (args.join(" ") === "plugin marketplace list --json") {
        marketplaceReads += 1;
        if (marketplaceReads < 5) {
          return { ok: false, status: 1, stdout: "", stderr: "transient read failure" };
        }
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify([{
            name: "teami",
            source: "git",
            url: "https://github.com/shulmansj/teami.git",
          }]),
          stderr: "",
        };
      }
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify([{
          id: "teami@teami",
          version: "0.3.20",
          scope: "user",
          enabled: true,
          mcpServers: {
            teami: {
              command: "npx",
              args: ["-y", "@shulmansj/teami@0.3.20", "mcp"],
            },
          },
        }]),
        stderr: "",
      };
    },
  });

  assert.equal(health.ok, true);
  assert.equal(marketplaceReads, 5);
  assert.deepEqual(readTimeouts, Array(6).fill(10_000));
});

test("Claude plugin health still blocks after its bounded retry budget", async () => {
  let marketplaceReads = 0;
  const health = await readClaudePluginHealth({
    repoRoot,
    marketplaceSource: "https://github.com/shulmansj/teami",
    readRetryDelaysMs: [0, 0, 0, 0],
    runCommand: async () => {
      marketplaceReads += 1;
      return { ok: false, status: 1, stdout: "", stderr: "persistent read failure" };
    },
  });

  assert.equal(health.ok, false);
  assert.equal(health.reason, "claude_plugin_marketplace_list_failed");
  assert.equal(marketplaceReads, 5);
});

test("Claude plugin health fails closed on an invalid retry policy without running commands", async () => {
  let commandCalls = 0;
  const health = await readClaudePluginHealth({
    repoRoot,
    marketplaceSource: "https://github.com/shulmansj/teami",
    readRetryDelaysMs: ["invalid"],
    runCommand: async () => {
      commandCalls += 1;
      return { ok: true, status: 0, stdout: "[]", stderr: "" };
    },
  });

  assert.equal(health.ok, false);
  assert.equal(health.reason, "claude_plugin_read_policy_invalid");
  assert.equal(commandCalls, 0);
});

test("Claude plugin health does not repeat a timed-out read command", async () => {
  let marketplaceReads = 0;
  const health = await readClaudePluginHealth({
    repoRoot,
    marketplaceSource: "https://github.com/shulmansj/teami",
    readRetryDelaysMs: [0, 0, 0, 0],
    runCommand: async () => {
      marketplaceReads += 1;
      return { ok: false, status: null, stdout: "", stderr: "read timed out", timedOut: true };
    },
  });

  assert.equal(health.ok, false);
  assert.equal(health.reason, "claude_plugin_marketplace_list_failed");
  assert.equal(marketplaceReads, 1);
});

test("published npm installs keep Phoenix state in the per-user Teami home", () => {
  const env = { ...process.env };
  delete env.TEAMI_HOME;
  const installedRoot = path.join(os.tmpdir(), "consumer", "node_modules", "@shulmansj", "teami");
  const expectedHome = resolveTeamiHome({ env });
  const config = resolvePhoenixConfig({ repoRoot: installedRoot, env });

  assert.equal(config.runtimeDir, teamiHomePaths({ home: expectedHome }).runtimeDir);
  assert.equal(config.runtimeDir.startsWith(installedRoot), false);
});

test("a carried runtime missing Phoenix degrades instead of installing an unpinned dependency graph", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-package-repair-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, TEAMI_HOME: home };
  const paths = teamiHomePaths({ home });
  const config = resolvePhoenixConfig({ repoRoot, env });
  fs.mkdirSync(path.join(paths.runtimeDir, "current", "python"), { recursive: true });
  const runtimePython = phoenixPythonPath(config);
  assert.match(runtimePython, new RegExp(`python[\\\\/]${process.platform === "win32" ? "python\\.exe" : "bin"}`));
  fs.mkdirSync(path.dirname(runtimePython), { recursive: true });
  fs.writeFileSync(runtimePython, "fixture python");
  fs.copyFileSync(runtimeManifestPath, path.join(paths.runtimeDir, "runtime-manifest.json"));

  const calls = [];
  const result = await ensurePhoenixReady({
    repoRoot,
    env,
    runtimeManifestPath,
    platformKey: "win32-x64",
    fetchImpl: async () => {
      throw new Error("current carried runtime must not be downloaded again");
    },
    probeIdentity: async () => ({ ok: false, reason: "unreachable" }),
    runCommand: async (command, args) => {
      calls.push({ command, args: [...args] });
      throw new Error("No module named phoenix");
    },
    spawnImpl: () => {
      throw new Error("invalid runtime must not start Phoenix");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "phoenix_runtime_bundle_invalid");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, runtimePython);
  assert.deepEqual(calls[0].args, [
    "-c",
    "import importlib.metadata as m; import phoenix; assert m.version('arize-phoenix') == '14.13.0'",
  ]);
  assert.equal(calls.some((call) => call.args.includes("pip")), false);
  assert.match(result.repairHint, /removed the unusable local trace runtime/i);
  assert.equal(fs.existsSync(path.join(paths.runtimeDir, "current")), false);
  assert.equal(fs.existsSync(path.join(paths.runtimeDir, "runtime-manifest.json")), false);
});
