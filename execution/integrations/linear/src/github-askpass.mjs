import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function buildGitHubInstallationTokenAskPassScript({ platform = process.platform } = {}) {
  if (platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      "set \"PROMPT=%~1\"",
      "if /I not \"%PROMPT:Username=%\"==\"%PROMPT%\" (",
      "  echo x-access-token",
      ") else (",
      "  echo %AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN%",
      ")",
      "endlocal",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*|*username*) printf '%s\\n' 'x-access-token' ;;",
    "  *) printf '%s\\n' \"$AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
}

export function createGitHubInstallationTokenAskPass({
  token,
  tempRoot = os.tmpdir(),
  prefix = "agentic-factory-git-askpass-",
} = {}) {
  if (!token) throw new Error("github_installation_token_required");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, prefix));
  const askpassPath = path.join(tempDir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  fs.writeFileSync(askpassPath, buildGitHubInstallationTokenAskPassScript(), "utf8");
  if (process.platform !== "win32") fs.chmodSync(askpassPath, 0o700);
  return {
    askpassPath,
    tempDir,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
      AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN: token,
    },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
