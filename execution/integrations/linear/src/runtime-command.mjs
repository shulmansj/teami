import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyEnvAugment,
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../../../engine/runtime-environment.mjs";
import { redactGitHubSecrets } from "./github-secret-hygiene.mjs";
export {
  REPAIR_RETRY_TIMEOUT_MS,
  applyEnvAugment,
  perRunTempEnvSubset,
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../../../engine/runtime-environment.mjs";

export const DEFAULT_RUNTIME_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RUNTIME_OUTPUT_BYTES = 1024 * 1024;
const RUNTIME_PROMPT_TEMP_PREFIX = "teami-runtime-prompt-";

export function sanitizeRuntimeDiagnostic(text) {
  return redactGitHubSecrets(String(text || ""))
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/((?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GITHUB|GH|LINEAR|AF_LINEAR|AGENTIC_FACTORY|NPM|AWS)[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)([^\s'"]+)/gi, "$1[redacted]")
    .replace(/((?:token|api[_-]?key|secret|password|credential)\s*[=:]\s*)([^\s'"]+)/gi, "$1[redacted]");
}

export function runRuntimeCommand(command, {
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  cwd = undefined,
  envAugment = {},
  includeEnvironmentProof = false,
  includeStreams = false,
  spawnImpl = spawn,
} = {}) {
  if (!command?.command) throw new Error("Runtime command is missing an executable.");
  const childEnv = applyEnvAugment(scrubChildEnv(env), envAugment, { platform });
  const environment = runtimeCommandEnvironmentProof(childEnv);
  // Spawn resolution consults the HOST env: locating the host's installed
  // runtime is a host concern, and the worker env augment redirects APPDATA
  // into the per-run profile, which must not hide the host's npm-global
  // codex install from the win32 shim resolution.
  const spawnCommand = resolveRuntimeSpawnCommand(command.command, command.args || [], {
    env,
    platform,
    nodePath,
  });
  const stdinInput = command.stdinInput;
  const hasStdinInput = stdinInput !== undefined && stdinInput !== null;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const cleanup = () => cleanupRuntimeCommandTempPaths(command);
    const rejectSettled = (error) => {
      cleanup();
      reject(error);
    };
    const resolveSettled = (value) => {
      cleanup();
      resolve(value);
    };
    try {
      child = spawnImpl(spawnCommand.command, spawnCommand.args, {
        env: childEnv,
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectSettled(runtimeCommandError(
        `Runtime command could not start ${command.command}: ${error.message}`,
        { failure_code: "could_not_start", stdout, stderr },
      ));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectSettled(runtimeCommandError(
        `Runtime command timed out after ${timeoutMs}ms: ${command.command}`,
        { failure_code: "timed_out", stdout, stderr },
      ));
    }, timeoutMs);

    if (hasStdinInput && !child.stdin) {
      settled = true;
      clearTimeout(timer);
      child.kill?.();
      rejectSettled(runtimeCommandError(
        `Runtime command stdin unavailable: ${command.command}`,
        { failure_code: "process_failed", stdout, stderr },
      ));
      return;
    }
    if (child.stdin) {
      child.stdin.on?.("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectSettled(runtimeCommandError(
          `Runtime command stdin failed (${command.command}): ${error.message}`,
          { failure_code: "process_failed", stdout, stderr },
        ));
      });
      try {
        if (hasStdinInput) child.stdin.write(stdinInput);
        child.stdin.end();
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill?.();
        rejectSettled(runtimeCommandError(
          `Runtime command stdin failed (${command.command}): ${error.message}`,
          { failure_code: "process_failed", stdout, stderr },
        ));
        return;
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        rejectSettled(runtimeCommandError(
          `Runtime command exceeded ${maxOutputBytes} output bytes: ${command.command}`,
          { failure_code: "process_failed", stdout, stderr },
        ));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        rejectSettled(runtimeCommandError(
          `Runtime command exceeded ${maxOutputBytes} stderr bytes: ${command.command}`,
          { failure_code: "process_failed", stdout, stderr },
        ));
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectSettled(runtimeCommandError(
        `Runtime command could not start ${command.command}: ${error.message}`,
        { failure_code: "could_not_start", stdout, stderr },
      ));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectSettled(runtimeCommandError(
          `Runtime command failed (${command.command}) exit=${code} signal=${signal || "none"}: ${sanitizeRuntimeDiagnostic(stderr.trim())}`,
          {
            failure_code: "process_failed",
            exit: code,
            signal: signal || null,
            stdout,
            stderr,
          },
        ));
        return;
      }
      // `output` stays CLEAN (strict turn validation parses it as-is). Callers
      // that need the stderr banner too — codex >= 0.141.0 prints the session id
      // there while the final message rides stdout — opt in via includeStreams.
      const output = stdout.trim() || stderr.trim();
      if (includeEnvironmentProof || includeStreams) {
        resolveSettled({
          output,
          ...(includeStreams ? { stdout, stderr } : {}),
          ...(includeEnvironmentProof ? { environment } : {}),
        });
        return;
      }
      resolveSettled(output);
    });
  });
}

function runtimeCommandError(message, {
  failure_code,
  exit = null,
  signal = null,
  stdout = "",
  stderr = "",
} = {}) {
  const error = new Error(message);
  error.failure_code = failure_code;
  error.exit = exit;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

export function resolveRuntimeSpawnCommand(command, args = [], {
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
} = {}) {
  if (platform === "win32" && command === "codex" && env.APPDATA) {
    const codexJsPath = path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(codexJsPath)) {
      return {
        command: nodePath,
        args: [codexJsPath, ...args],
      };
    }
  }
  if (platform === "win32" && command === "npm") {
    // npm ships as npm.cmd on Windows; spawn(shell:false) cannot exec .cmd shims.
    // Resolve the real entry script under the Node install, same as the codex shim.
    const npmCliPath = path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCliPath)) {
      return {
        command: nodePath,
        args: [npmCliPath, ...args],
      };
    }
  }
  return { command, args };
}

function cleanupRuntimeCommandTempPaths(command) {
  const cleanupPaths = Array.isArray(command?.cleanup_paths) ? command.cleanup_paths : [];
  for (const cleanupPath of cleanupPaths) {
    if (!safeRuntimePromptTempPath(cleanupPath)) continue;
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; runtime success/failure should reflect the child process.
    }
  }
}

function safeRuntimePromptTempPath(cleanupPath) {
  if (typeof cleanupPath !== "string" || cleanupPath.trim() === "") return false;
  const resolved = path.resolve(cleanupPath);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    path.basename(resolved).startsWith(RUNTIME_PROMPT_TEMP_PREFIX)
  );
}
