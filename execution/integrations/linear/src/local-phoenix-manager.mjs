import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import { ensureCarriedRuntime } from "./runtime/carried-runtime.mjs";

export const DEFAULT_PHOENIX_APP_URL = "http://127.0.0.1:6006";
export const DEFAULT_PHOENIX_PROJECT = "teami";
export const DEFAULT_PHOENIX_PACKAGE = "arize-phoenix==14.13.0";

const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUNTIME_MANIFEST_PATH = path.join(import.meta.dirname, "runtime", "runtime-manifest.json");

export function phoenixPaths(home = undefined) {
  const root = teamiHomePaths({ home }).phoenixDataDir;
  return {
    root,
    venvDir: path.join(root, "phoenix-venv"),
    dataDir: root,
    logsDir: path.join(root, "logs"),
    serviceFile: path.join(root, "phoenix-service.json"),
    telemetryDir: path.join(root, "telemetry"),
  };
}

export function runtimeFetchDegradationNotice() {
  return "Teami could not prepare its local trace runtime, so product work can continue without Phoenix traces. Retry when network access to GitHub Releases is available.";
}

export function resolvePhoenixConfig({
  home,
  repoRoot = process.cwd(),
  env = process.env,
  appUrl = env.TEAMI_PHOENIX_URL || DEFAULT_PHOENIX_APP_URL,
  projectName = env.TEAMI_PHOENIX_PROJECT || DEFAULT_PHOENIX_PROJECT,
} = {}) {
  const normalizedAppUrl = normalizeLocalPhoenixAppUrl(appUrl);
  const url = new URL(normalizedAppUrl);
  const phoenixHome = resolvePhoenixHome({ home, repoRoot, env });
  const paths = phoenixPaths(phoenixHome);
  return {
    appUrl: normalizedAppUrl,
    collectorUrl: phoenixCollectorUrl(normalizedAppUrl),
    host: url.hostname,
    port: Number(url.port || 80),
    projectName,
    packageSpec: env.TEAMI_PHOENIX_PACKAGE || DEFAULT_PHOENIX_PACKAGE,
    runtimeDir: teamiHomePaths({ home: phoenixHome }).runtimeDir,
    ...paths,
  };
}

function resolvePhoenixHome({ home, repoRoot, env }) {
  if (home !== undefined) return home;
  if (hasTeamiHomeOverride(env) || path.resolve(repoRoot) === path.resolve(process.cwd())) {
    return resolveTeamiHome({ env });
  }
  return repoRoot;
}

function hasTeamiHomeOverride(env) {
  return typeof env?.TEAMI_HOME === "string" && env.TEAMI_HOME.trim() !== "";
}

export function normalizeLocalPhoenixAppUrl(value = DEFAULT_PHOENIX_APP_URL) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Phoenix URL must be http(s).");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Local Phoenix must bind to loopback (127.0.0.1, localhost, or ::1).");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export function phoenixCollectorUrl(appUrl = DEFAULT_PHOENIX_APP_URL) {
  const url = new URL(normalizeLocalPhoenixAppUrl(appUrl));
  url.pathname = "/v1/traces";
  return url.toString();
}

export async function ensurePhoenixReady({
  repoRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
  runCommand = runLocalCommand,
  spawnImpl = spawn,
  probeIdentity = probePhoenixIdentity,
  startProcess = startPhoenixProcess,
  env = process.env,
  now = () => new Date(),
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  runtimeManifestPath = DEFAULT_RUNTIME_MANIFEST_PATH,
  platformKey = `${process.platform}-${process.arch}`,
  onProgress = () => {},
} = {}) {
  const config = resolvePhoenixConfig({ repoRoot, env });
  ensureStateDirs(config);
  const existing = await probeIdentity({ appUrl: config.appUrl, fetchImpl });
  if (existing.ok) {
    const previous = readServiceMetadata(config.serviceFile);
    const stillManaged = previous?.managed === true
      && previous.app_url === config.appUrl
      && previous.pid
      && isProcessAlive(previous.pid);
    const metadata = serviceMetadata({
      config,
      managed: stillManaged,
      pid: stillManaged ? previous.pid : null,
      status: "running",
      lastSuccessfulPreflightAt: now().toISOString(),
    });
    writeServiceMetadata(config.serviceFile, metadata);
    return { ok: true, reused: !stillManaged, managed: stillManaged, started: false, ...config, metadata };
  }
  if (existing.reason === "port_collision") {
    const metadata = serviceMetadata({
      config,
      managed: false,
      pid: null,
      status: "port_collision",
      lastErrorReason: existing.message,
      repairHint: "Stop the non-Phoenix service on 127.0.0.1:6006 or set a loopback Phoenix URL.",
    });
    writeServiceMetadata(config.serviceFile, metadata);
    return { ok: false, reason: "port_collision", repairHint: metadata.repair_hint, ...config, metadata };
  }

  recoverStaleServiceMetadata(config);
  const installed = await ensurePhoenixInstalled({
    config,
    fetchImpl,
    runCommand,
    env,
    onProgress,
    commandTimeoutMs,
    manifestPath: runtimeManifestPath,
    platformKey,
  });
  if (!installed.ok) {
    const metadata = serviceMetadata({
      config,
      managed: false,
      pid: null,
      status: "runtime_fetch_failed",
      lastErrorReason: installed.reason || "runtime_fetch_failed",
      repairHint: installed.repairHint || runtimeFetchDegradationNotice(),
    });
    writeServiceMetadata(config.serviceFile, metadata);
    return { ok: false, reason: "runtime_fetch_failed", repairHint: metadata.repair_hint, ...config, metadata };
  }
  const child = startProcess({ config, spawnImpl, env });
  const metadata = serviceMetadata({
    config,
    managed: true,
    pid: child.pid || null,
    status: "starting",
  });
  writeServiceMetadata(config.serviceFile, metadata);
  const ready = await waitForPhoenix({
    appUrl: config.appUrl,
    fetchImpl,
    probeIdentity,
    timeoutMs: startTimeoutMs,
  });
  const finalMetadata = serviceMetadata({
    config,
    managed: true,
    pid: child.pid || null,
    status: ready.ok ? "running" : "failed",
    lastSuccessfulPreflightAt: ready.ok ? now().toISOString() : null,
    lastErrorReason: ready.ok ? null : ready.reason,
    repairHint: ready.ok ? null : "Check .agent-shell/logs/phoenix-server.err.log and rerun npm run phoenix:start.",
  });
  writeServiceMetadata(config.serviceFile, finalMetadata);
  return ready.ok
    ? { ok: true, reused: false, managed: true, started: true, ...config, metadata: finalMetadata }
    : { ok: false, reason: ready.reason, repairHint: finalMetadata.repair_hint, started: true, ...config, metadata: finalMetadata };
}

export async function phoenixStatus({
  repoRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const config = resolvePhoenixConfig({ repoRoot, env });
  const metadata = readServiceMetadata(config.serviceFile);
  const probe = await probePhoenixIdentity({ appUrl: config.appUrl, fetchImpl });
  return {
    ok: probe.ok,
    status: probe.ok ? "running" : probe.reason,
    appUrl: config.appUrl,
    collectorUrl: config.collectorUrl,
    projectName: config.projectName,
    metadata,
    repairHint: probe.ok ? null : repairHintForProbe(probe),
  };
}

export async function stopPhoenix({
  repoRoot = process.cwd(),
  env = process.env,
  killProcess = killPid,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const config = resolvePhoenixConfig({ repoRoot, env });
  const metadata = readServiceMetadata(config.serviceFile);
  if (!metadata) return { ok: true, stopped: false, reason: "not_managed" };
  if (!metadata.managed) return { ok: true, stopped: false, reason: "external_phoenix_not_stopped" };
  if (metadata.app_url !== config.appUrl) return { ok: false, reason: "service_metadata_url_mismatch" };
  if (metadata.pid && isProcessAlive(metadata.pid)) {
    killProcess(metadata.pid);
    const stopped = await waitForPhoenixStopped({
      appUrl: config.appUrl,
      fetchImpl,
      timeoutMs: 5_000,
    });
    if (!stopped.ok) return { ok: false, stopped: false, reason: stopped.reason };
  }
  writeServiceMetadata(config.serviceFile, {
    ...metadata,
    status: "stopped",
    stopped_at: now().toISOString(),
  });
  return { ok: true, stopped: true };
}

export async function probePhoenixIdentity({
  appUrl = DEFAULT_PHOENIX_APP_URL,
  fetchImpl = globalThis.fetch,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch_unavailable" };
  const base = normalizeLocalPhoenixAppUrl(appUrl);
  try {
    const response = await fetchWithTimeout(`${base}/healthz`, { fetchImpl, timeoutMs: probeTimeoutMs });
    if (response.status >= 200 && response.status < 300) return { ok: true, appUrl: base };
    const root = await fetchWithTimeout(base, { fetchImpl, timeoutMs: probeTimeoutMs });
    const text = await root.text().catch(() => "");
    if (root.status >= 200 && root.status < 300 && /phoenix|arize/i.test(text)) {
      return { ok: true, appUrl: base };
    }
    if (root.status >= 200 && root.status < 500) {
      return { ok: false, reason: "port_collision", message: `Port ${new URL(base).port || 80} is not Phoenix.` };
    }
    return { ok: false, reason: `http_${root.status}` };
  } catch (error) {
    if (/ECONNREFUSED|fetch failed|Failed to fetch|terminated|AbortError/i.test(error.message || error.name || "")) {
      return { ok: false, reason: "unreachable", message: error.message };
    }
    return { ok: false, reason: "probe_failed", message: error.message };
  }
}

export function readServiceMetadata(serviceFile) {
  if (!fs.existsSync(serviceFile)) return null;
  return JSON.parse(fs.readFileSync(serviceFile, "utf8"));
}

export function writeServiceMetadata(serviceFile, metadata) {
  fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
  const tmp = `${serviceFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`);
  fs.renameSync(tmp, serviceFile);
}

export function recoverStaleServiceMetadata(config) {
  const metadata = readServiceMetadata(config.serviceFile);
  if (!metadata?.managed || !metadata.pid || isProcessAlive(metadata.pid)) return false;
  writeServiceMetadata(config.serviceFile, {
    ...metadata,
    status: "stale_pid_recovered",
    pid: null,
    last_error_reason: "managed Phoenix pid no longer exists",
    repair_hint: "Starting a fresh managed Phoenix process.",
  });
  return true;
}

async function ensurePhoenixInstalled({
  config,
  fetchImpl,
  runCommand,
  env,
  onProgress,
  commandTimeoutMs,
  manifestPath,
  platformKey,
}) {
  if (env.TEAMI_PHOENIX_SKIP_INSTALL === "1") return { ok: true, skipped: true };
  onProgress("Preparing the local trace engine...");
  const runtime = await ensureCarriedRuntime({
    runtimeDir: config.runtimeDir,
    manifestPath,
    platformKey,
    fetchImpl,
    onProgress,
  });
  if (!runtime.ok) return runtime;
  onProgress(`Checking carried Phoenix runtime (${config.packageSpec})...`);
  await runCommand(phoenixPythonPath(config), ["-c", "import phoenix"], {
    env,
    timeoutMs: commandTimeoutMs,
  });
  return { ok: true, manifestEntry: runtime.manifestEntry };
}

function startPhoenixProcess({ config, spawnImpl, env }) {
  const out = fs.openSync(path.join(config.logsDir, "phoenix-server.log"), "a");
  const err = fs.openSync(path.join(config.logsDir, "phoenix-server.err.log"), "a");
  const child = spawnImpl(phoenixExecutablePath(config), ["serve", "--host", "127.0.0.1", "--port", String(config.port)], {
    cwd: config.root,
    detached: true,
    windowsHide: true,
    env: {
      ...env,
      PHOENIX_WORKING_DIR: config.dataDir,
    },
    stdio: ["ignore", out, err],
  });
  child.unref?.();
  return child;
}

async function waitForPhoenix({ appUrl, fetchImpl, probeIdentity = probePhoenixIdentity, timeoutMs }) {
  const started = Date.now();
  let last = { ok: false, reason: "startup_timeout" };
  while (Date.now() - started < timeoutMs) {
    last = await probeIdentity({ appUrl, fetchImpl });
    if (last.ok || last.reason === "port_collision") return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, reason: last.reason || "startup_timeout", message: last.message };
}

async function waitForPhoenixStopped({ appUrl, fetchImpl, timeoutMs }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = await probePhoenixIdentity({ appUrl, fetchImpl });
    if (!probe.ok) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, reason: "phoenix_still_running_after_stop" };
}

async function runLocalCommand(command, args, { env, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

function ensureStateDirs(config) {
  for (const dir of [config.root, config.dataDir, config.logsDir, config.telemetryDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function serviceMetadata({
  config,
  managed,
  pid,
  status,
  lastSuccessfulPreflightAt = null,
  lastErrorReason = null,
  repairHint = null,
}) {
  return {
    schema_version: 1,
    app_url: config.appUrl,
    collector_url: config.collectorUrl,
    project_name: config.projectName,
    port: config.port,
    managed,
    pid,
    status,
    working_directory: config.dataDir,
    phoenix_package: config.packageSpec,
    last_successful_preflight_at: lastSuccessfulPreflightAt,
    last_error_reason: lastErrorReason,
    repair_hint: repairHint,
  };
}

export function phoenixPythonPath(config) {
  const runtimeRoot = path.join(config.runtimeDir, "current");
  return process.platform === "win32"
    ? path.join(runtimeRoot, "Scripts", "python.exe")
    : path.join(runtimeRoot, "bin", "python");
}

export function phoenixExecutablePath(config) {
  const runtimeRoot = path.join(config.runtimeDir, "current");
  return process.platform === "win32"
    ? path.join(runtimeRoot, "Scripts", "phoenix.exe")
    : path.join(runtimeRoot, "bin", "phoenix");
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status === 0) return;
  } else {
    try {
      process.kill(-pid);
      return;
    } catch {
      // Fall through to leader-only kill.
    }
  }
  process.kill(pid);
}

function repairHintForProbe(probe) {
  if (probe.reason === "port_collision") return "Stop the non-Phoenix service on the configured Phoenix port.";
  if (probe.reason === "unreachable") return "Run npm run phoenix:start or npm run init to start local Phoenix.";
  return "Run npm run phoenix:doctor for local Phoenix repair guidance.";
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
