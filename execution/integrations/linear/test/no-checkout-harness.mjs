import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { teamiHomePaths } from "../src/app-home.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  readTeamRegistry,
  writeTeamRegistry,
} from "../src/team-registry.mjs";
import {
  gatewayLockPath,
  readGatewayLockLiveness,
  runGatewayLoop,
  selectGatewayTeams,
} from "../src/gateway-loop.mjs";
import {
  createLinearCredentialStore,
  serializeTokenSet,
} from "../src/linear-credential-store.mjs";
import { createTeamiProjectMcpServer } from "../src/project-mcp-server.mjs";

export const NO_CHECKOUT_TEAM = Object.freeze({
  teamRef: "support-ops",
  workspaceId: "workspace-1",
  workspaceName: "Fixture Workspace",
  teamId: "team-1",
  teamKey: "OPS",
  teamName: "Support Ops",
});

const TEST_DIR = import.meta.dirname;
const SOURCE_REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const CLI_PATH = path.join(SOURCE_REPO_ROOT, "execution", "integrations", "linear", "cli.mjs");
const EXAMPLE_CONFIG_PATH = path.join(
  SOURCE_REPO_ROOT,
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
const GRAPHQL_SHIM_PATH = path.join(TEST_DIR, "no-checkout-graphql-shim.mjs");
const PROCESS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export function createNoCheckoutFixture({ prefix = "teami-no-checkout-" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const cwdMcp = path.join(root, "cwd-mcp");
  const cwdGateway = path.join(root, "cwd-gateway");
  const cwdTokenWrite = path.join(root, "cwd-token-write");
  const cwdTokenRead = path.join(root, "cwd-token-read");
  for (const dir of [home, cwdMcp, cwdGateway, cwdTokenWrite, cwdTokenRead]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const configPath = path.join(home, "linear-config.json");
  writeNoCheckoutConfig(configPath);
  writeNoCheckoutRegistry(home);
  writeNoCheckoutCache(home);
  writeNoCheckoutCredential(home);

  const fixture = {
    root,
    home,
    configPath,
    cwdMcp,
    cwdGateway,
    cwdTokenWrite,
    cwdTokenRead,
    cliPath: CLI_PATH,
    graphqlShimPath: GRAPHQL_SHIM_PATH,
    team: NO_CHECKOUT_TEAM,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  assertNoCheckoutDirectory(cwdMcp);
  assertNoCheckoutDirectory(cwdGateway);
  assertNoCheckoutDirectory(cwdTokenWrite);
  assertNoCheckoutDirectory(cwdTokenRead);
  return fixture;
}

export async function connectNoCheckoutMcpServer(fixture, { cwd = fixture.cwdMcp } = {}) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.cliPath, "mcp"],
    cwd,
    env: noCheckoutChildEnv(fixture, { cwd }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk).toString("utf8"));
  });
  const client = new Client({ name: "teami-no-checkout-regression", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    if (isSpawnBlocked(error)) {
      return connectNoCheckoutMcpServerInProcess(fixture, { cwd, spawnError: error });
    }
    error.stderr = stderrChunks.join("");
    throw error;
  }
  return {
    client,
    transport,
    stderrText: () => stderrChunks.join(""),
    async close() {
      await Promise.allSettled([client.close(), transport.close()]);
    },
  };
}

export async function runNoCheckoutGatewayStart(
  fixture,
  { cwd = fixture.cwdGateway, graphqlDelayMs = 750 } = {},
) {
  assertNoCheckoutDirectory(cwd);
  let child;
  try {
    child = spawn(process.execPath, [
      fixture.cliPath,
      "gateway",
      "start",
      "--team",
      fixture.team.teamRef,
      "--max-iterations",
      "1",
    ], {
      cwd,
      env: noCheckoutChildEnv(fixture, {
        cwd,
        extraEnv: { TEAMI_NO_CHECKOUT_GRAPHQL_DELAY_MS: String(graphqlDelayMs) },
      }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (isSpawnBlocked(error)) {
      return runNoCheckoutGatewayStartInProcess(fixture, { cwd, spawnError: error });
    }
    throw error;
  }
  const output = collectChildOutput(child);
  const liveLock = await waitForGatewayLockLive({
    home: fixture.home,
    child,
    output,
  });
  const result = await waitForChildExit(child, output);
  return { liveLock, result };
}

export async function runCredentialRoundTripFromNoCheckoutCwds(fixture) {
  const accessToken = ["fixture", "access", "token"].join("-");
  const refreshToken = ["fixture", "refresh", "token"].join("-");
  const common = {
    teamRef: fixture.team.teamRef,
    workspaceId: fixture.team.workspaceId,
    configUrl: pathToFileURL(path.join(SOURCE_REPO_ROOT, "execution", "integrations", "linear", "src", "config.mjs")).href,
    credentialUrl: pathToFileURL(path.join(SOURCE_REPO_ROOT, "execution", "integrations", "linear", "src", "linear-credential-store.mjs")).href,
  };

  try {
    const writeResult = await runNodeModuleSnippet(fixture, {
      cwd: fixture.cwdTokenWrite,
      script: credentialWriterScript({ ...common, accessToken, refreshToken }),
    });
    const readResult = await runNodeModuleSnippet(fixture, {
      cwd: fixture.cwdTokenRead,
      script: credentialReaderScript(common),
    });
    return {
      mode: "spawn",
      written: JSON.parse(writeResult.stdout),
      read: JSON.parse(readResult.stdout),
      expectedTokenSet: { accessToken, refreshToken },
    };
  } catch (error) {
    if (!isSpawnBlocked(error)) throw error;
    return runCredentialRoundTripInProcess(fixture, { accessToken, refreshToken, spawnError: error });
  }
}

export function assertNoCheckoutDirectory(cwd) {
  for (const candidate of [
    path.join(cwd, "config.example.json"),
    path.join(cwd, "execution", "integrations", "linear", "config.example.json"),
    path.join(cwd, ".teami"),
  ]) {
    if (fs.existsSync(candidate)) {
      throw new Error(`Expected no Teami checkout fixture at ${candidate}`);
    }
  }
}

export function noCheckoutChildEnv(fixture, { cwd, extraEnv = {} } = {}) {
  return {
    ...safeInheritedEnv(),
    FACTORY_REPO_ROOT: cwd,
    TEAMI_HOME: fixture.home,
    TEAMI_LINEAR_CONFIG: fixture.configPath,
    TEAMI_PHOENIX_URL: "http://not-loopback.invalid:6006",
    TEAMI_PHOENIX_SKIP_INSTALL: "1",
    NO_COLOR: "1",
    NODE_OPTIONS: nodeOptionsWithImport(fixture.graphqlShimPath),
    ...extraEnv,
  };
}

export function gatewayLockIsUnderHome(home) {
  const lockPath = gatewayLockPath(home);
  return path.resolve(lockPath).startsWith(path.resolve(home) + path.sep);
}

function writeNoCheckoutConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
  config.linear.oauth.credential_storage = "file";
  config.linear.team.key = NO_CHECKOUT_TEAM.teamKey;
  config.linear.team.name = NO_CHECKOUT_TEAM.teamName;
  config.poll.interval_ms = 2_000;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writeNoCheckoutRegistry(home) {
  const registry = emptyTeamRegistry();
  registry.teams.push(
    makeTeamRecord({
      teamRef: NO_CHECKOUT_TEAM.teamRef,
      status: "active",
      workspaceId: NO_CHECKOUT_TEAM.workspaceId,
      workspaceName: NO_CHECKOUT_TEAM.workspaceName,
      teamId: NO_CHECKOUT_TEAM.teamId,
      teamKey: NO_CHECKOUT_TEAM.teamKey,
      teamName: NO_CHECKOUT_TEAM.teamName,
      teamNameLastSeenAt: "2026-07-08T00:00:00.000Z",
    }),
  );
  writeTeamRegistry({ home }, registry);
}

function writeNoCheckoutCache(home) {
  writeLinearCache(teamiHomePaths({ home, teamRef: NO_CHECKOUT_TEAM.teamRef }).teamCachePath, {
    teamRef: NO_CHECKOUT_TEAM.teamRef,
    workspaceId: NO_CHECKOUT_TEAM.workspaceId,
    teamId: NO_CHECKOUT_TEAM.teamId,
    app_identity_id: "app-viewer-1",
    projectStatuses: {
      backlog: "status-backlog",
      planned: "status-planned",
      in_progress: "status-in-progress",
      completed: "status-completed",
      needs_principal: "status-needs-principal",
    },
    projectStatusTypes: {
      backlog: "backlog",
      planned: "planned",
      in_progress: "started",
      completed: "completed",
      needs_principal: "planned",
    },
    issueStatuses: {
      backlog: "state-backlog",
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      human_review: "state-human-review",
      needs_principal: "state-needs-principal",
      done: "state-done",
    },
    issueLabels: {
      Discovery: "label-discovery",
      "human-review": "label-human-review",
      Code: "label-code",
      "Non-code": "label-non-code",
    },
  });
}

function writeNoCheckoutCredential(home) {
  const credentialPath = path.join(
    teamiHomePaths({ home }).home,
    "credentials",
    "teams",
    NO_CHECKOUT_TEAM.teamRef,
    "linear-oauth-token.json",
  );
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(
    credentialPath,
    serializeTokenSet({
      accessToken: ["seeded", "access", "token"].join("-"),
      refreshToken: ["seeded", "refresh", "token"].join("-"),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function waitForGatewayLockLive({ home, child, output, timeoutMs = 5_000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = readGatewayLockLiveness({ home });
    if (last.live) return last;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error([
    "gateway lock did not become live",
    `last=${JSON.stringify(last)}`,
    childOutputSummary(output),
  ].join("\n"));
}

function runNodeModuleSnippet(fixture, { cwd, script }) {
  assertNoCheckoutDirectory(cwd);
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: noCheckoutChildEnv(fixture, { cwd }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw spawnBlockedError(error);
  }
  const output = collectChildOutput(child);
  return waitForChildExit(child, output).then((result) => {
    if (result.code !== 0) {
      throw new Error(`node snippet failed\n${childOutputSummary(output)}`);
    }
    return result;
  });
}

async function connectNoCheckoutMcpServerInProcess(fixture, { cwd, spawnError }) {
  await import(pathToFileURL(fixture.graphqlShimPath).href);
  const restoreEnv = installNoCheckoutProcessEnv(fixture, { cwd });
  try {
    const [{ Client }, server] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      createTeamiProjectMcpServer({
        repoRoot: cwd,
        createPlanningTraceSink: null,
      }),
    ]);
    const transports = linkedMcpTransports();
    await server.connect(transports.server);
    const client = new Client({ name: "teami-no-checkout-regression", version: "0.0.0" });
    await client.connect(transports.client);
    return {
      mode: "in-process-spawn-fallback",
      spawnError,
      client,
      server,
      stderrText: () => "",
      async close() {
        try {
          await Promise.allSettled([client.close(), server.close()]);
        } finally {
          restoreEnv();
        }
      },
    };
  } catch (error) {
    restoreEnv();
    throw error;
  }
}

async function runNoCheckoutGatewayStartInProcess(fixture, { cwd, spawnError }) {
  return withNoCheckoutProcessEnv(fixture, { cwd }, async () => {
    const config = loadLinearConfig({ repoRoot: cwd });
    const registry = readTeamRegistry({ home: fixture.home }) || emptyTeamRegistry();
    const teams = selectGatewayTeams({ registry, teamRef: fixture.team.teamRef });
    let releaseFirstPoll;
    let firstPollStarted;
    const firstPollGate = new Promise((resolve) => {
      firstPollStarted = resolve;
    });
    const firstPollHold = new Promise((resolve) => {
      releaseFirstPoll = resolve;
    });
    let held = false;
    const client = {
      async listPlannedProjectCandidates() {
        if (!held) {
          held = true;
          firstPollStarted();
          await firstPollHold;
        }
        return { candidates: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      async listReadyIssueCandidates() {
        return { candidates: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      async getIssueContext() {
        return null;
      },
    };
    const loop = runGatewayLoop({
      repoRoot: cwd,
      home: fixture.home,
      config,
      registry,
      teams,
      maxIterations: 1,
      createLinearClient: async () => client,
      sleep: async () => {},
    });
    await firstPollGate;
    const liveLock = await waitForGatewayLockLiveInProcess({ home: fixture.home });
    releaseFirstPoll();
    const loopResult = await loop;
    return {
      liveLock,
      result: {
        mode: "in-process-spawn-fallback",
        spawnError,
        code: loopResult.ok ? 0 : 1,
        signal: null,
        stdout: "",
        stderr: "",
        status: loopResult.status,
        loopResult,
      },
    };
  });
}

async function runCredentialRoundTripInProcess(fixture, { accessToken, refreshToken, spawnError }) {
  return withNoCheckoutProcessEnv(fixture, { cwd: fixture.cwdTokenWrite }, async () => {
    const writeConfig = loadLinearConfig({ repoRoot: fixture.cwdTokenWrite });
    const writeStore = createLinearCredentialStore({
      config: writeConfig,
      teamRef: fixture.team.teamRef,
      workspaceId: fixture.team.workspaceId,
    });
    await writeStore.writeTokenSet({ accessToken, refreshToken });
    const written = {
      ok: true,
      cwd: fixture.cwdTokenWrite,
      target: writeStore.target,
    };

    return withNoCheckoutProcessEnv(fixture, { cwd: fixture.cwdTokenRead }, async () => {
      const readConfig = loadLinearConfig({ repoRoot: fixture.cwdTokenRead });
      const readStore = createLinearCredentialStore({
        config: readConfig,
        teamRef: fixture.team.teamRef,
        workspaceId: fixture.team.workspaceId,
      });
      return {
        mode: "in-process-spawn-fallback",
        spawnError,
        written,
        read: {
          ok: true,
          cwd: fixture.cwdTokenRead,
          target: readStore.target,
          tokenSet: await readStore.readTokenSet(),
        },
        expectedTokenSet: { accessToken, refreshToken },
      };
    });
  });
}

async function waitForGatewayLockLiveInProcess({ home, timeoutMs = 5_000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = readGatewayLockLiveness({ home });
    if (last.live) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gateway lock did not become live: ${JSON.stringify(last)}`);
}

async function withNoCheckoutProcessEnv(fixture, { cwd }, fn) {
  const restoreEnv = installNoCheckoutProcessEnv(fixture, { cwd });
  try {
    return await fn();
  } finally {
    restoreEnv();
  }
}

function installNoCheckoutProcessEnv(fixture, { cwd }) {
  const previous = {
    FACTORY_REPO_ROOT: process.env.FACTORY_REPO_ROOT,
    TEAMI_HOME: process.env.TEAMI_HOME,
    TEAMI_LINEAR_CONFIG: process.env.TEAMI_LINEAR_CONFIG,
    TEAMI_PHOENIX_URL: process.env.TEAMI_PHOENIX_URL,
    TEAMI_PHOENIX_SKIP_INSTALL: process.env.TEAMI_PHOENIX_SKIP_INSTALL,
    NO_COLOR: process.env.NO_COLOR,
  };
  Object.assign(process.env, {
    FACTORY_REPO_ROOT: cwd,
    TEAMI_HOME: fixture.home,
    TEAMI_LINEAR_CONFIG: fixture.configPath,
    TEAMI_PHOENIX_URL: "http://not-loopback.invalid:6006",
    TEAMI_PHOENIX_SKIP_INSTALL: "1",
    NO_COLOR: "1",
  });
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function linkedMcpTransports() {
  const client = new InProcessMcpTransport();
  const server = new InProcessMcpTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class InProcessMcpTransport {
  constructor() {
    this.peer = null;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
    this.sessionId = undefined;
  }

  async start() {}

  async send(message) {
    queueMicrotask(() => {
      this.peer?.onmessage?.(message);
    });
  }

  async close() {
    this.onclose?.();
  }
}

function collectChildOutput(child) {
  const output = {
    stdout: "",
    stderr: "",
    outputTooLarge: false,
  };
  const append = (key, chunk) => {
    const next = output[key] + Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
      output.outputTooLarge = true;
      child.kill();
      return;
    }
    output[key] = next;
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  return output;
}

function waitForChildExit(child, output, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`child process timed out\n${childOutputSummary(output)}`));
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (output.outputTooLarge) {
        reject(new Error(`child output exceeded ${MAX_OUTPUT_BYTES} bytes\n${childOutputSummary(output)}`));
        return;
      }
      resolve({ ...result, stdout: output.stdout, stderr: output.stderr });
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
}

function isSpawnBlocked(error) {
  return error?.code === "EPERM" && String(error?.syscall || "").includes("spawn");
}

function spawnBlockedError(error) {
  if (isSpawnBlocked(error)) return error;
  return error;
}

function credentialWriterScript({ configUrl, credentialUrl, teamRef, workspaceId, accessToken, refreshToken }) {
  return `
const { loadLinearConfig } = await import(${JSON.stringify(configUrl)});
const { createLinearCredentialStore } = await import(${JSON.stringify(credentialUrl)});
const config = loadLinearConfig({ repoRoot: process.cwd() });
const store = createLinearCredentialStore({ config, teamRef: ${JSON.stringify(teamRef)}, workspaceId: ${JSON.stringify(workspaceId)} });
await store.writeTokenSet({ accessToken: ${JSON.stringify(accessToken)}, refreshToken: ${JSON.stringify(refreshToken)} });
console.log(JSON.stringify({ ok: true, cwd: process.cwd(), target: store.target }));
`;
}

function credentialReaderScript({ configUrl, credentialUrl, teamRef, workspaceId }) {
  return `
const { loadLinearConfig } = await import(${JSON.stringify(configUrl)});
const { createLinearCredentialStore } = await import(${JSON.stringify(credentialUrl)});
const config = loadLinearConfig({ repoRoot: process.cwd() });
const store = createLinearCredentialStore({ config, teamRef: ${JSON.stringify(teamRef)}, workspaceId: ${JSON.stringify(workspaceId)} });
const tokenSet = await store.readTokenSet();
console.log(JSON.stringify({ ok: true, cwd: process.cwd(), target: store.target, tokenSet }));
`;
}

function nodeOptionsWithImport(shimPath) {
  const current = typeof process.env.NODE_OPTIONS === "string" ? process.env.NODE_OPTIONS.trim() : "";
  return [current, "--import", pathToFileURL(shimPath).href].filter(Boolean).join(" ");
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

function childOutputSummary(output) {
  return [
    "stdout:",
    output.stdout,
    "stderr:",
    output.stderr,
  ].join("\n");
}
