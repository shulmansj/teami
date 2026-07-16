import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";

import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import {
  readTeamRegistry,
  writeTeamRegistry,
} from "../src/team-registry.mjs";
import { TEAMI_PROJECT_MCP_TOOL_NAMES } from "../src/project-mcp-tools.mjs";
import {
  assertNoCheckoutDirectory,
  connectNoCheckoutMcpServer,
  createNoCheckoutFixture,
  noCheckoutChildEnv,
} from "./no-checkout-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const manifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");
const PROCESS_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

test(
  "Claude plugin manifest launches packed teami MCP from a no-checkout directory",
  { timeout: 120_000 },
  async (t) => {
    const spawnBlocker = childProcessSpawnBlocker();
    const fixture = createNoCheckoutFixture({ prefix: "teami-plugin-no-checkout-" });
    try {
      const gitRepoResource = bindFixtureGitRepoResource(fixture);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const tarballPath = spawnBlocker
        ? path.join(fixture.root, "pack", expectedPackedTarballFilename({ version: "0.0.0" }))
        : await packLocalTeamiPackage({ fixture });
      const launch = pluginMcpLaunchFromManifest({
        manifest,
        tarballPath,
        cwd: fixture.cwdMcp,
      });

      assert.equal(launch.manifestArgs.length, 3);
      assert.equal(launch.manifestArgs[0], "-y");
      assert.equal(launch.manifestArgs[2], "mcp");
      if (fs.existsSync(path.join(repoRoot, "private", "publication"))) {
        assert.equal(launch.manifestArgs[1], "@shulmansj/teami@__TEAMI_VERSION__");
      } else {
        assert.match(
          launch.manifestArgs[1],
          /^@shulmansj\/teami@\d+\.\d+\.\d+-sha[0-9a-f]{40}$/,
        );
      }
      assert.equal(launch.command, "npx");
      assert.equal(launch.args[0], "-y");
      assert.match(launch.args[1], /^file:/);
      assert.equal(launch.args[2], "mcp");
      assert.equal(launch.args.some((arg) => String(arg).includes("__TEAMI_VERSION__")), false);
      assert.equal(launch.args.some((arg) => String(arg).includes("latest")), false);

      let mcp;
      try {
        mcp = spawnBlocker
          ? await connectNoCheckoutMcpServer(fixture)
          : await connectManifestMcpServer({ fixture, launch });
      } catch (error) {
        // The real npx launch installs teami's dependency closure. If this environment has
        // neither a warm cache nor network, that install cannot complete â€” skip rather than
        // fail, matching the other packaging proofs. A server that starts and then misbehaves
        // is a genuine failure and still throws.
        if (!spawnBlocker && isOfflineInstallFailure(error)) {
          t.diagnostic(
            `packaged npx launch could not fetch dependencies (cold cache + no network): ${firstStderrLine(error)}`,
          );
          t.skip("packaged npx launch requires a warm npm cache or network access");
          return;
        }
        throw error;
      }
      try {
        await assertAllMcpToolsWork({ mcp, fixture, gitRepoResource });
      } finally {
        await mcp.close();
      }

      assert.deepEqual(
        mcp.transport?.nonProtocolStdoutLines || [],
        [],
        `stdout must contain JSON-RPC protocol lines only\nstderr:\n${mcp.stderrText()}`,
      );
      if (spawnBlocker) {
        t.diagnostic(`child process spawn blocked by sandbox: ${spawnBlocker.code}; used in-process MCP fallback`);
      }
      assertNoCheckoutDirectory(fixture.cwdMcp);
    } finally {
      fixture.cleanup();
    }
  },
);

function bindFixtureGitRepoResource(fixture) {
  registerGitRepoResourceKind();
  const registry = readTeamRegistry({ home: fixture.home });
  const team = registry.teams.find((candidate) => candidate.id === fixture.team.teamRef);
  assert.ok(team, "fixture team must exist before binding git_repo");
  const resource = {
    id: "git_repo:acme/product",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "acme",
      repo: "product",
      default_branch: "main",
    },
  };
  team.resources = [resource];
  writeTeamRegistry({ home: fixture.home }, registry);
  return resource;
}

async function packLocalTeamiPackage({ fixture }) {
  const packDir = path.join(fixture.root, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  const result = await runProcess(npmCommand(), [
    "pack",
    "--json",
    "--pack-destination",
    packDir,
  ], {
    cwd: repoRoot,
    env: {
      ...safeInheritedEnv(),
      ...npmCacheEnv(),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_progress: "false",
      npm_config_update_notifier: "false",
    },
  });
  const packed = JSON.parse(result.stdout);
  const filename = packed?.[0]?.filename;
  assert.equal(filename, expectedPackedTarballFilename());
  const tarballPath = path.join(packDir, filename);
  assert.equal(fs.existsSync(tarballPath), true);
  return tarballPath;
}

function expectedPackedTarballFilename({ version } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packageStem = String(packageJson.name || "")
    .replace(/^@/, "")
    .replaceAll("/", "-");
  return `${packageStem}-${version || packageJson.version}.tgz`;
}

function pluginMcpLaunchFromManifest({ manifest, tarballPath, cwd }) {
  const server = manifest.mcpServers?.teami;
  assert.ok(server, "manifest must declare mcpServers.teami");
  assert.equal(server.command, "npx");
  assert.equal(server.args?.length, 3);
  assert.equal(server.args[0], "-y");
  assert.match(
    server.args[1],
    /^@shulmansj\/teami@(?:__TEAMI_VERSION__|\d+\.\d+\.\d+-sha[0-9a-f]{40})$/,
  );
  assert.equal(server.args[2], "mcp");

  const tarballSpec = localFilePackageSpec({ fromDir: cwd, tarballPath });
  const args = [...server.args];
  args[1] = tarballSpec;
  return {
    command: server.command,
    manifestArgs: server.args,
    args,
  };
}

async function connectManifestMcpServer({ fixture, launch }) {
  assertNoCheckoutDirectory(fixture.cwdMcp);
  const transport = new CapturingStdioTransport({
    command: launch.command,
    args: launch.args,
    cwd: fixture.cwdMcp,
    env: {
      ...noCheckoutChildEnv(fixture, { cwd: fixture.cwdMcp }),
      ...npmCacheEnv(),
      npm_config_audit: "false",
      npm_config_fund: "false",
      // Prefer the warm npm cache but allow a network fallback for dependency metadata.
      // The bundled npm on the supported node floor (20.11 / npm 10) needs cached *metadata*
      // to resolve the tarball's deps offline, which `npm ci` does not populate â€” a hard-offline
      // dead registry therefore ENOTCACHEs there (npm 11 is more lenient). prefer-offline matches
      // this repo's other packaging proofs (real cache + net fallback + graceful skip below).
      npm_config_prefer_offline: "true",
      npm_config_progress: "false",
      npm_config_update_notifier: "false",
    },
  });
  const client = new Client({ name: "teami-plugin-no-checkout-launch", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    error.stderr = transport.stderrText();
    error.nonProtocolStdout = transport.nonProtocolStdoutLines.join("\n");
    throw error;
  }
  return {
    client,
    transport,
    stderrText: () => transport.stderrText(),
    async close() {
      await Promise.allSettled([client.close(), transport.close()]);
    },
  };
}

async function assertAllMcpToolsWork({ mcp, fixture, gitRepoResource }) {
  const listed = await mcp.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [...TEAMI_PROJECT_MCP_TOOL_NAMES].sort(),
  );

  const onboarding = await mcp.client.callTool({
    name: "init_onboarding",
    arguments: {},
  });
  assert.equal(onboarding.isError, undefined, JSON.stringify(onboarding.structuredContent));
  assert.equal(onboarding.structuredContent.ok, false);
  assert.deepEqual(onboarding.structuredContent.needs.map((need) => need.field), ["confirm"]);
  assert.deepEqual(onboarding.structuredContent.defaults, {
    team: fixture.team.teamRef,
    product_repositories: "none",
  });
  assert.equal(Object.hasOwn(onboarding.structuredContent, "authorization_url"), false);

  const resolved = await mcp.client.callTool({
    name: "check_team_context",
    arguments: { team: fixture.team.teamRef },
  });
  assert.equal(resolved.isError, undefined, JSON.stringify(resolved.structuredContent));
  assert.doesNotMatch(JSON.stringify(resolved), /unknown_resource_kind:git_repo/);
  assert.equal(resolved.structuredContent.team.team_ref, fixture.team.teamRef);
  assert.equal(resolved.structuredContent.cache.present, true);

  const created = await mcp.client.callTool({
    name: "project_create",
    arguments: {
      team: fixture.team.teamRef,
      name: "Packaged plugin planning project",
      description: "Created by a repo-less packaged-launch regression harness.",
    },
  });
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  assert.equal(created.structuredContent.team.team_ref, fixture.team.teamRef);
  assert.equal(created.structuredContent.status.id, "status-backlog");

  const projectId = created.structuredContent.project.id;
  const body = "## Problem Or Opportunity\n\nThe Claude plugin should launch Teami without a checkout.\n";
  const written = await mcp.client.callTool({
    name: "project_write_body",
    arguments: {
      team: fixture.team.teamRef,
      project_id: projectId,
      content: body,
    },
  });
  assert.equal(written.isError, undefined, JSON.stringify(written.structuredContent));
  assert.equal(written.structuredContent.content_length, body.length);

  const moved = await mcp.client.callTool({
    name: "project_move_status",
    arguments: {
      team: fixture.team.teamRef,
      project_id: projectId,
      confirm: true,
    },
  });
  assert.equal(moved.isError, undefined, JSON.stringify(moved.structuredContent));
  assert.equal(moved.structuredContent.status.id, "status-planned");

  assert.deepEqual(gitRepoResource.binding, {
    owner: "acme",
    repo: "product",
    default_branch: "main",
  });
}

class CapturingStdioTransport {
  constructor({ command, args, cwd, env }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.nonProtocolStdoutLines = [];
    this.protocolStdoutLines = [];
    this.stderrChunks = [];
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
    this.sessionId = undefined;
    this.child = null;
    this.stdoutRemainder = "";
    this.outputBytes = 0;
    this.closePromise = null;
  }

  async start() {
    if (this.child) throw new Error("CapturingStdioTransport already started");
    let child;
    try {
      child = spawn(commandForSpawn(this.command), this.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw decorateSpawnError(error, this.command, this.args);
    }
    this.child = child;
    this.closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.recordStdoutRemainder();
        this.child = null;
        this.onclose?.();
        resolve({ code, signal });
      });
    });
    child.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk) => this.handleStderr(chunk));
    return await new Promise((resolve, reject) => {
      let spawned = false;
      const timer = setTimeout(() => {
        if (!spawned) {
          child.kill();
          reject(new Error(`Timed out starting ${this.command}`));
        }
      }, 10_000);
      child.once("spawn", () => {
        spawned = true;
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        const decorated = decorateSpawnError(error, this.command, this.args);
        if (!spawned) reject(decorated);
        this.onerror?.(decorated);
      });
    });
  }

  async send(message) {
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error("MCP stdio child stdin is not writable");
    const payload = serializeMessage(message);
    return await new Promise((resolve, reject) => {
      child.stdin.write(payload, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([
      this.closePromise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  stderrText() {
    return this.stderrChunks.join("");
  }

  handleStdout(chunk) {
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > MAX_OUTPUT_BYTES) {
      const error = new Error(`MCP stdout exceeded ${MAX_OUTPUT_BYTES} bytes`);
      this.onerror?.(error);
      this.child?.kill();
      return;
    }
    this.stdoutRemainder += Buffer.from(chunk).toString("utf8");
    for (;;) {
      const index = this.stdoutRemainder.indexOf("\n");
      if (index === -1) break;
      const line = this.stdoutRemainder.slice(0, index).replace(/\r$/, "");
      this.stdoutRemainder = this.stdoutRemainder.slice(index + 1);
      this.handleStdoutLine(line);
    }
  }

  handleStdoutLine(line) {
    try {
      const message = deserializeMessage(line);
      this.protocolStdoutLines.push(line);
      this.onmessage?.(message);
    } catch (error) {
      this.nonProtocolStdoutLines.push(line);
      this.onerror?.(new Error(`non_protocol_stdout:${line.slice(0, 120)}`, { cause: error }));
    }
  }

  handleStderr(chunk) {
    this.stderrChunks.push(Buffer.from(chunk).toString("utf8"));
  }

  recordStdoutRemainder() {
    if (this.stdoutRemainder.trim() !== "") {
      this.nonProtocolStdoutLines.push(this.stdoutRemainder);
    }
    this.stdoutRemainder = "";
  }
}

function runProcess(command, args, { cwd, env, timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(decorateSpawnError(error, command, args));
      return;
    }
    const output = { stdout: "", stderr: "", bytes: 0 };
    const append = (key, chunk) => {
      output.bytes += Buffer.byteLength(chunk);
      if (output.bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error(`${command} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      output[key] += Buffer.from(chunk).toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(decorateSpawnError(error, command, args));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ...output, code, signal });
        return;
      }
      reject(new Error([
        `${command} exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
        "stdout:",
        output.stdout,
        "stderr:",
        output.stderr,
      ].join("\n")));
    });
  });
}

function localFilePackageSpec({ fromDir, tarballPath }) {
  const relative = path.relative(fromDir, tarballPath).replace(/\\/g, "/");
  return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function commandForSpawn(command) {
  if (process.platform === "win32" && command === "npx") return "npx.cmd";
  return command;
}

function childProcessSpawnBlocker() {
  try {
    for (const [command, args] of [
      [process.execPath, ["-e", ""]],
      [npmCommand(), ["--version"]],
    ]) {
      const result = spawnSync(command, args, { stdio: "ignore" });
      if (isSpawnBlocked(result.error)) return result.error;
    }
    return null;
  } catch (error) {
    return isSpawnBlocked(error) ? error : null;
  }
}

function isSpawnBlocked(error) {
  return ["EPERM", "EINVAL"].includes(error?.code) && String(error?.syscall || "").includes("spawn");
}

function decorateSpawnError(error, command, args) {
  if (error && typeof error === "object") {
    error.message = `${error.message} while spawning ${[command, ...args].join(" ")}`;
  }
  return error;
}

function safeInheritedEnv() {
  const names = [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "Path",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMFILES",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === "string" && !process.env[name].startsWith("()"))
      .map((name) => [name, process.env[name]]),
  );
}

function npmCacheEnv() {
  return {
    ...(process.env.npm_config_cache ? { npm_config_cache: process.env.npm_config_cache } : {}),
    ...(process.env.NPM_CONFIG_CACHE ? { NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE } : {}),
  };
}

function firstStderrLine(error) {
  const text = typeof error?.stderr === "string" ? error.stderr : "";
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || error?.message || "unknown error";
}

// True when the packaged npx launch failed because npm itself could not obtain teami's
// dependency closure (cold cache with no reachable registry), rather than because the launched
// server misbehaved. Gated on npm's own error prefix plus a network/cache signature so a real
// server fault still fails the test.
function isOfflineInstallFailure(error) {
  const text = typeof error?.stderr === "string" ? error.stderr : "";
  if (!/npm (error|warn)/i.test(text)) return false;
  return (
    /\b(ENOTCACHED|ETARGET|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPROTO|E\d{3})\b/.test(text) ||
    /request to https?:\/\/\S+ failed/i.test(text) ||
    /offline mode/i.test(text)
  );
}
