import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../../../engine/runtime-environment.mjs";
export {
  REPAIR_RETRY_TIMEOUT_MS,
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../../../engine/runtime-environment.mjs";

export const DEFAULT_RUNTIME_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RUNTIME_OUTPUT_BYTES = 1024 * 1024;

export function sanitizeRuntimeDiagnostic(text) {
  return String(text || "")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{8,})/g, "[redacted]")
    .replace(/(github_pat_[A-Za-z0-9_]{8,})/gi, "[redacted]")
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
  includeEnvironmentProof = false,
  spawnImpl = spawn,
} = {}) {
  if (!command?.command) throw new Error("Runtime command is missing an executable.");
  const childEnv = scrubChildEnv(env);
  const environment = runtimeCommandEnvironmentProof(childEnv);
  const spawnCommand = resolveRuntimeSpawnCommand(command.command, command.args || [], {
    env: childEnv,
    platform,
    nodePath,
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawnImpl(spawnCommand.command, spawnCommand.args, {
        env: childEnv,
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(runtimeCommandError(
        `Runtime command could not start ${command.command}: ${error.message}`,
        { failure_code: "could_not_start", stdout, stderr },
      ));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(runtimeCommandError(
        `Runtime command timed out after ${timeoutMs}ms: ${command.command}`,
        { failure_code: "timed_out", stdout, stderr },
      ));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(runtimeCommandError(
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
        reject(runtimeCommandError(
          `Runtime command exceeded ${maxOutputBytes} stderr bytes: ${command.command}`,
          { failure_code: "process_failed", stdout, stderr },
        ));
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(runtimeCommandError(
        `Runtime command could not start ${command.command}: ${error.message}`,
        { failure_code: "could_not_start", stdout, stderr },
      ));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(runtimeCommandError(
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
      const output = stdout.trim() || stderr.trim();
      resolve(includeEnvironmentProof ? { output, environment } : output);
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
  return { command, args };
}
