import { spawn } from "node:child_process";

export const SUBPROCESS_CLASSIFICATIONS = Object.freeze({
  read: "read",
  mutation: "mutation",
});

export const BOUNDED_OPERATION_POLICIES = Object.freeze({
  git_read: policy("read", 15_000, 512 * 1024),
  git_network_read: policy("read", 60_000, 1024 * 1024),
  git_clone: policy("mutation", 120_000, 1024 * 1024),
  git_fetch: policy("mutation", 90_000, 1024 * 1024),
  git_checkout: policy("mutation", 30_000, 512 * 1024),
  git_local_mutation: policy("mutation", 30_000, 1024 * 1024),
  git_push: policy("mutation", 90_000, 1024 * 1024),
  gh_auth_read: policy("read", 20_000, 256 * 1024),
  gh_api_read: policy("read", 60_000, 2 * 1024 * 1024),
  gh_api_mutation: policy("mutation", 90_000, 2 * 1024 * 1024),
  security_git_read: policy("read", 60_000, 8 * 1024 * 1024),
});

const NON_INTERACTIVE_ENV = Object.freeze({
  CI: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GH_PROMPT_DISABLED: "1",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
});

const TERMINATION_GRACE_MS = 750;
const TERMINATION_CONFIRMATION_MS = 750;

export async function runBoundedSubprocess({
  command,
  args = [],
  operation,
  cwd = undefined,
  env = undefined,
  exactEnv = false,
  input = null,
  timeoutMs = null,
  maxOutputBytes = null,
  spawnImpl = spawn,
  platform = process.platform,
  killProcess = process.kill.bind(process),
  classifyFailure = null,
} = {}) {
  const normalizedCommand = requiredString(command, "bounded_subprocess_command_required");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("bounded_subprocess_args_must_be_strings");
  }
  const selected = resolveOperationPolicy({ operation, timeoutMs, maxOutputBytes });
  const childEnv = nonInteractiveEnv({ env, exactEnv });

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let finalizationTimer = null;
    let terminationTimer = null;
    let timeoutTimer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capturedBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const finish = ({ code = null, signal = null, spawnError = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (finalizationTimer) clearTimeout(finalizationTimer);
      const outputTruncated = stdoutTruncated || stderrTruncated;
      const ok = !timedOut && !spawnError && code === 0 && !outputTruncated;
      const rawStdout = stdout.toString("utf8");
      const rawStderr = stderr.toString("utf8");
      const failureCode = !ok && typeof classifyFailure === "function"
        ? safeFailureClassification(classifyFailure, {
            stdout: rawStdout,
            stderr: rawStderr,
            code,
            signal,
            timedOut,
            spawnError,
          })
        : null;
      const reconciliationRequired = (timedOut || outputTruncated) &&
        selected.classification === SUBPROCESS_CLASSIFICATIONS.mutation;
      resolve({
        ok,
        status: code,
        signal,
        stdout: ok ? rawStdout : "",
        stderr: ok ? rawStderr : redactedFailureOutput({ timedOut, spawnError }),
        timedOut,
        terminationUnconfirmed: signal === "termination_unconfirmed",
        outputTruncated,
        stdoutTruncated,
        stderrTruncated,
        operation,
        classification: selected.classification,
        outcome: reconciliationRequired
          ? "reconciliation_required"
          : timedOut
            ? "timed_out"
            : outputTruncated
              ? "output_truncated"
            : ok
              ? "ok"
              : "failed",
        reconciliationRequired,
        failureCode,
      });
    };

    try {
      child = spawnImpl(normalizedCommand, args, {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ spawnError: error });
      return;
    }

    drainStream(child.stdout, {
      maxBytes: selected.maxOutputBytes,
      onChunk: (chunk) => {
        const captured = appendWithinLimit(stdout, chunk, selected.maxOutputBytes - capturedBytes);
        stdout = captured.value;
        capturedBytes += captured.appendedBytes;
        stdoutTruncated ||= captured.truncated;
      },
    });
    drainStream(child.stderr, {
      maxBytes: selected.maxOutputBytes,
      onChunk: (chunk) => {
        const captured = appendWithinLimit(stderr, chunk, selected.maxOutputBytes - capturedBytes);
        stderr = captured.value;
        capturedBytes += captured.appendedBytes;
        stderrTruncated ||= captured.truncated;
      },
    });
    child.once("error", (error) => finish({ spawnError: error }));
    child.once("close", (code, signal) => finish({ code, signal }));

    if (child.stdin) {
      child.stdin.on?.("error", () => {});
      if (input !== null && input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateBoundedProcessTree({ child, platform, spawnImpl, killProcess, force: false });
      terminationTimer = setTimeout(() => {
        if (settled) return;
        terminateBoundedProcessTree({ child, platform, spawnImpl, killProcess, force: true });
        finalizationTimer = setTimeout(() => {
          if (settled) return;
          finish({ signal: "termination_unconfirmed" });
        }, TERMINATION_CONFIRMATION_MS);
      }, TERMINATION_GRACE_MS);
    }, selected.timeoutMs);
  });
}

export function gitOperationForArgs(args = []) {
  const command = gitSubcommandForArgs(args);
  if (command === "clone") return "git_clone";
  if (command === "fetch") return "git_fetch";
  if (command === "push") return "git_push";
  if (["checkout", "switch", "reset", "restore"].includes(command)) return "git_checkout";
  if (["add", "commit", "init", "remote", "config", "branch", "tag"].includes(command)) {
    return "git_local_mutation";
  }
  if (["ls-remote"].includes(command)) return "git_network_read";
  return "git_read";
}

function gitSubcommandForArgs(args = []) {
  if (!Array.isArray(args)) return null;
  const globalOptionsWithSeparateValue = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--work-tree",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    if (globalOptionsWithSeparateValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--") return null;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function runBoundedGit(args, options = {}) {
  return runBoundedSubprocess({
    command: "git",
    args,
    ...options,
    operation: options.operation || gitOperationForArgs(args),
  });
}

export function resolveOperationPolicy({ operation, timeoutMs = null, maxOutputBytes = null } = {}) {
  const base = BOUNDED_OPERATION_POLICIES[operation];
  if (!base) throw new Error(`bounded_subprocess_operation_unknown:${operation || "missing"}`);
  return {
    classification: base.classification,
    timeoutMs: boundedPositiveIntegerOrDefault(timeoutMs, base.timeoutMs, "bounded_subprocess_timeout_invalid"),
    maxOutputBytes: boundedPositiveIntegerOrDefault(
      maxOutputBytes,
      base.maxOutputBytes,
      "bounded_subprocess_output_limit_invalid",
    ),
  };
}

export function nonInteractiveEnv({ env = undefined, exactEnv = false } = {}) {
  const base = exactEnv ? normalizeEnv(env) : normalizeEnv({ ...process.env, ...(env || {}) });
  return { ...base, ...NON_INTERACTIVE_ENV };
}

export function terminateBoundedProcessTree({ child, platform, spawnImpl, killProcess, force = false }) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    try {
      const killer = spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: "ignore",
      });
      killer.on?.("error", () => {
        tryKillRoot(child, force);
      });
      killer.unref?.();
    } catch {
      tryKillRoot(child, force);
    }
    return;
  }
  try {
    killProcess(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    tryKillRoot(child, force);
  }
}

function tryKillRoot(child, force) {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may already have exited between timeout and termination.
  }
}

function drainStream(stream, { onChunk }) {
  stream?.on?.("data", (chunk) => onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stream?.resume?.();
}

function appendWithinLimit(current, chunk, remainingBytes) {
  const remaining = Math.max(0, remainingBytes);
  if (remaining === 0) return { value: current, appendedBytes: 0, truncated: chunk.length > 0 };
  const appended = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  return {
    value: Buffer.concat([current, appended]),
    appendedBytes: appended.length,
    truncated: chunk.length > remaining,
  };
}

function redactedFailureOutput({ timedOut, spawnError }) {
  if (timedOut) return "[captured failure output redacted: command timed out]";
  if (spawnError) return "[captured failure output redacted: command could not start]";
  return "[captured failure output redacted]";
}

function safeFailureClassification(classifier, input) {
  try {
    const value = classifier(input);
    return typeof value === "string" && /^[a-z0-9_.:-]{1,96}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function policy(classification, timeoutMs, maxOutputBytes) {
  return Object.freeze({ classification, timeoutMs, maxOutputBytes });
}

function boundedPositiveIntegerOrDefault(value, fallback, reason) {
  if (value === null || value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(reason);
  return Math.min(value, fallback);
}

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value;
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}
