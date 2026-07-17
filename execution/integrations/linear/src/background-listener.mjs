import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import { readGatewayLockLiveness } from "./gateway-loop.mjs";

const READY_SCHEMA = "teami-background-listener-ready/v1";
const METADATA_SCHEMA = "teami-background-listener/v1";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 50;

export function backgroundListenerMetadataPath(home = resolveTeamiHome()) {
  return path.join(home, "background-listener.json");
}

export function backgroundListenerControlDir(home = resolveTeamiHome()) {
  return path.join(home, ".listener-control");
}

export function readBackgroundListenerStatus({ home = resolveTeamiHome() } = {}) {
  const liveness = readGatewayLockLiveness({ home });
  const metadata = readJson(backgroundListenerMetadataPath(home));
  const background = Boolean(
    liveness.live &&
    metadata?.schema_version === METADATA_SCHEMA &&
    metadata.pid === liveness.lock?.pid &&
    metadata.acquired_at === (liveness.lock?.acquired_at || liveness.lock?.created_at) &&
    validControlToken(metadata.control_token),
  );
  return {
    running: liveness.live === true,
    mode: liveness.live ? (background ? "background" : "foreground") : "stopped",
    pid: liveness.live ? liveness.lock?.pid || null : null,
    acquired_at: liveness.live
      ? liveness.lock?.acquired_at || liveness.lock?.created_at || null
      : null,
    background,
  };
}

export async function startBackgroundListener({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  spawnProcess = spawn,
  cliPath = path.resolve(import.meta.dirname, "../cli.mjs"),
  childEnv = process.env,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  sleep = delay,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  acquireStartLock = acquireExclusiveFileLock,
  killSpawnedProcess = (childProcess) => childProcess.kill("SIGTERM"),
} = {}) {
  const existing = readBackgroundListenerStatus({ home });
  if (existing.running) {
    return { ok: true, status: "already_running", ...existing };
  }

  fs.mkdirSync(backgroundListenerControlDir(home), { recursive: true });
  const startLock = acquireStartLock({
    lockPath: path.join(backgroundListenerControlDir(home), "start.lock"),
    purpose: "background_listener_start",
  });
  if (!startLock.ok) {
    return waitForConcurrentStart({ home, timeoutMs, sleep, now });
  }

  try {
    const afterLock = readBackgroundListenerStatus({ home });
    if (afterLock.running) {
      return { ok: true, status: "already_running", ...afterLock };
    }
    sweepOrphanedControlFiles(home);

    const readyNonce = randomBytes(18).toString("base64url");
    const controlToken = randomBytes(18).toString("base64url");
    const readyFile = path.join(backgroundListenerControlDir(home), `start-${readyNonce}.json`);
    const args = [
      cliPath,
      "gateway",
      "start",
      "--background-ready-file",
      readyFile,
      "--background-ready-nonce",
      readyNonce,
    ];
    let child;
    try {
      child = spawnProcess(process.execPath, args, {
        cwd: repoRoot,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...childEnv,
          FACTORY_REPO_ROOT: repoRoot,
          TEAMI_HOME: home,
          TEAMI_BACKGROUND_CONTROL_TOKEN: controlToken,
        },
      });
      child.unref?.();
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        reason: `background_listener_spawn_failed:${error?.code || error?.message || "unknown"}`,
      };
    }

    const childPid = Number.isInteger(child?.pid) ? child.pid : null;
    const deadline = now() + timeoutMs;
    let verified = false;
    try {
      while (now() < deadline) {
        const ready = readJson(readyFile);
        if (ready?.schema_version === READY_SCHEMA && ready.nonce === readyNonce) {
          if (childPid && ready.pid !== childPid) {
            return { ok: false, status: "failed", reason: "background_listener_ready_pid_mismatch" };
          }
          await sleep(POLL_MS);
          const status = readBackgroundListenerStatus({ home });
          if (!status.running || !status.background || status.pid !== ready.pid) {
            return { ok: false, status: "failed", reason: "background_listener_exited_after_ready" };
          }
          verified = true;
          return {
            ok: true,
            status: "started",
            ...status,
          };
        }
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
          return {
            ok: false,
            status: "failed",
            reason: `background_listener_exited_before_ready:${child.exitCode}`,
          };
        }
        if (child?.signalCode !== null && child?.signalCode !== undefined) {
          return {
            ok: false,
            status: "failed",
            reason: `background_listener_signaled_before_ready:${child.signalCode}`,
          };
        }
        await sleep(POLL_MS);
      }
      return { ok: false, status: "failed", reason: "background_listener_start_timeout" };
    } finally {
      fs.rmSync(readyFile, { force: true });
      if (
        !verified &&
        childPid &&
        child?.exitCode === null &&
        child?.signalCode === null
      ) {
        try {
          killSpawnedProcess(child);
        } catch {
          // The child may already have exited. Either way, startup was not verified.
        }
      }
    }
  } finally {
    startLock.release?.();
  }
}

async function waitForConcurrentStart({ home, timeoutMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = readBackgroundListenerStatus({ home });
    if (status.running) {
      return { ok: true, status: "already_running", ...status };
    }
    await sleep(POLL_MS);
  }
  return {
    ok: false,
    status: "failed",
    reason: "background_listener_start_in_progress_timeout",
  };
}

function sweepOrphanedControlFiles(home) {
  const controlDir = backgroundListenerControlDir(home);
  let names = [];
  try {
    names = fs.readdirSync(controlDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^(start|stop)-[A-Za-z0-9_-]+\.json$/.test(name)) {
      fs.rmSync(path.join(controlDir, name), { force: true });
    }
  }
}

export async function stopBackgroundListener({
  home = resolveTeamiHome(),
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  sleep = delay,
  now = () => Date.now(),
} = {}) {
  const liveness = readGatewayLockLiveness({ home });
  if (!liveness.live) {
    fs.rmSync(backgroundListenerMetadataPath(home), { force: true });
    sweepOrphanedControlFiles(home);
    return { ok: true, status: "already_stopped", running: false, mode: "stopped" };
  }
  const pid = liveness.lock?.pid;
  const token = liveness.lock?.token || null;
  if (!Number.isInteger(pid) || pid <= 0 || !token) {
    return {
      ok: false,
      status: "foreground_owned",
      reason: "listener_owner_unverifiable",
      running: true,
    };
  }
  const metadata = readJson(backgroundListenerMetadataPath(home));
  if (
    metadata?.schema_version !== METADATA_SCHEMA ||
    metadata.pid !== pid ||
    metadata.acquired_at !== (liveness.lock?.acquired_at || liveness.lock?.created_at) ||
    !validControlToken(metadata.control_token)
  ) {
    return {
      ok: false,
      status: "foreground_owned",
      reason: "listener_not_background_managed",
      running: true,
    };
  }
  writeStopRequest({ home, controlToken: metadata.control_token });

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const current = readGatewayLockLiveness({ home });
    if (!current.live) {
      const exited = await waitForProcessExit({ pid, sleep, now });
      if (!exited) {
        return {
          ok: true,
          status: "stopping",
          reason: "listener_lock_released_process_exiting",
          running: true,
          mode: "background",
          pid,
        };
      }
      fs.rmSync(backgroundListenerMetadataPath(home), { force: true });
      sweepOrphanedControlFiles(home);
      return { ok: true, status: "stopped", running: false, mode: "stopped", pid };
    }
    if (current.lock?.token !== token) {
      return {
        ok: false,
        status: "restarted",
        reason: "listener_restarted_during_stop",
        running: true,
        mode: readBackgroundListenerStatus({ home }).mode,
      };
    }
    await sleep(POLL_MS);
  }
  return {
    ok: true,
    status: "stopping",
    reason: "listener_finishing_current_work",
    running: true,
    mode: "background",
    pid,
  };
}

async function waitForProcessExit({ pid, sleep, now, timeoutMs = 2_000 }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !processIsAlive(pid);
}

export function consumeBackgroundListenerStopRequest({
  home = resolveTeamiHome(),
  controlToken,
} = {}) {
  if (!validControlToken(controlToken)) return false;
  const requestPath = backgroundListenerStopRequestPath({ home, controlToken });
  if (!fs.existsSync(requestPath)) return false;
  fs.rmSync(requestPath, { force: true });
  return true;
}

export function writeBackgroundListenerReady({
  home = resolveTeamiHome(),
  readyFile,
  nonce,
  controlToken = process.env.TEAMI_BACKGROUND_CONTROL_TOKEN,
  now = () => new Date(),
} = {}) {
  const expectedDir = path.resolve(backgroundListenerControlDir(home));
  const resolvedFile = path.resolve(String(readyFile || ""));
  const relative = path.relative(expectedDir, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("background_listener_ready_path_invalid");
  }
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(nonce)) {
    throw new Error("background_listener_ready_nonce_invalid");
  }
  if (!validControlToken(controlToken)) {
    throw new Error("background_listener_control_token_invalid");
  }
  const liveness = readGatewayLockLiveness({ home });
  if (!liveness.live || liveness.lock?.pid !== process.pid) {
    throw new Error("background_listener_lock_not_owned");
  }
  const readyAt = now().toISOString();
  writeJsonAtomic(backgroundListenerMetadataPath(home), {
    schema_version: METADATA_SCHEMA,
    pid: process.pid,
    acquired_at: liveness.lock.acquired_at || liveness.lock.created_at,
    started_at: readyAt,
    control_token: controlToken,
  });
  writeJsonAtomic(resolvedFile, {
    schema_version: READY_SCHEMA,
    nonce,
    pid: process.pid,
    acquired_at: liveness.lock.acquired_at || liveness.lock.created_at,
    ready_at: readyAt,
  });
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    replaceFileWithRetry(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function replaceFileWithRetry(tempPath, filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
    synchronousDelay(10 * (attempt + 1));
  }
  throw lastError || new Error("background_listener_metadata_replace_failed");
}

function writeStopRequest({ home, controlToken }) {
  if (!validControlToken(controlToken)) throw new Error("background_listener_control_token_invalid");
  const requestPath = backgroundListenerStopRequestPath({ home, controlToken });
  writeJsonAtomic(requestPath, {
    schema_version: "teami-background-listener-stop/v1",
    requested_at: new Date().toISOString(),
  });
}

function backgroundListenerStopRequestPath({ home, controlToken }) {
  return path.join(backgroundListenerControlDir(home), `stop-${controlToken}.json`);
}

function validControlToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,}$/.test(value);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function synchronousDelay(ms) {
  const waitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(waitArray, 0, 0, ms);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return true;
  }
}
