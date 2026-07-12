#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const canaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-claude-plugin-canary-"));
const claudeConfigDir = path.join(canaryRoot, "claude");
const timeoutMsByStep = Object.freeze({
  version: 15_000,
  manifest_validation: 30_000,
  marketplace_registration: 60_000,
  plugin_installation: 120_000,
  plugin_read_back: 30_000,
});
let report = null;

try {
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const version = runClaude(["--version"], { env, step: "version" }).trim();
  runClaude([
    "plugin", "validate", "--strict", path.join(repoRoot, ".claude-plugin", "marketplace.json"),
  ], { env, step: "manifest_validation" });
  runClaude(["plugin", "marketplace", "add", repoRoot, "--scope", "user"], {
    env,
    step: "marketplace_registration",
  });
  runClaude(["plugin", "install", "teami@teami", "--scope", "user"], {
    env,
    step: "plugin_installation",
  });
  const installed = JSON.parse(runClaude(["plugin", "list", "--json"], {
    env,
    step: "plugin_read_back",
  }));
  const plugin = installed.find((entry) => entry?.id === "teami@teami");
  if (!plugin?.enabled || plugin?.scope !== "user") {
    throw new Error("claude_source_template_plugin_read_back_mismatch");
  }
  const server = plugin.mcpServers?.teami;
  if (server?.command !== "npx" || JSON.stringify(server?.args) !== JSON.stringify([
    "-y", "@shulmansj/teami@__TEAMI_VERSION__", "mcp",
  ])) {
    throw new Error("claude_source_template_mcp_server_mismatch");
  }
  report = {
    ok: true,
    canary: "claude_plugin_source_template_contract",
    claude_version: version,
    plugin_id: plugin.id,
    plugin_version: plugin.version,
    isolated_config: true,
    runnable: false,
    publication_required: true,
  };
} finally {
  fs.rmSync(canaryRoot, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ ...report, cleaned_up: !fs.existsSync(canaryRoot) })}\n`);

function runClaude(args, { env, step }) {
  const result = spawnSync("claude", args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMsByStep[step] || 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`claude_source_template_timeout:${step}`);
  }
  if (result.error) throw new Error(`claude_source_template_spawn_failed:${step}:${result.error.code || "unknown"}`);
  if (result.status !== 0) throw new Error(`claude_source_template_step_failed:${step}:exit_${result.status}`);
  return result.stdout || "";
}
