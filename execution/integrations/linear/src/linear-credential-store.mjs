import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_FILE_CREDENTIAL_PATH = path.join(".teami", "linear-oauth-token.json");
const CREDENTIAL_ACCOUNT = "refresh_token";
const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = "Stop"
$target = $env:AF_LINEAR_CREDENTIAL_TARGET
$user = $env:AF_LINEAR_CREDENTIAL_ACCOUNT
$action = $env:AF_LINEAR_CREDENTIAL_ACTION

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AgenticFactoryCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
  public static extern void CredFree(IntPtr credentialPtr);
}
"@

$typeGeneric = 1
$persistLocalMachine = 2
$notFound = 1168

if ($action -eq "read") {
  $ptr = [IntPtr]::Zero
  $ok = [AgenticFactoryCredMan]::CredRead($target, $typeGeneric, 0, [ref]$ptr)
  if (-not $ok) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $notFound) { exit 3 }
    throw "Credential Manager read failed"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgenticFactoryCredMan+CREDENTIAL])
    if ($credential.CredentialBlobSize -gt 0) {
      [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, $credential.CredentialBlobSize / 2))
    }
  } finally {
    [AgenticFactoryCredMan]::CredFree($ptr)
  }
} elseif ($action -eq "write") {
  $secret = [Console]::In.ReadToEnd()
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = New-Object AgenticFactoryCredMan+CREDENTIAL
    $credential.Type = $typeGeneric
    $credential.TargetName = $target
    $credential.UserName = $user
    $credential.CredentialBlob = $blob
    $credential.CredentialBlobSize = $bytes.Length
    $credential.Persist = $persistLocalMachine
    $ok = [AgenticFactoryCredMan]::CredWrite([ref]$credential, 0)
    if (-not $ok) { throw "Credential Manager write failed" }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
} elseif ($action -eq "delete") {
  $ok = [AgenticFactoryCredMan]::CredDelete($target, $typeGeneric, 0)
  if (-not $ok -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne $notFound) {
    throw "Credential Manager delete failed"
  }
} else {
  throw "Unsupported credential action"
}
`;

export function createLinearCredentialStore({
  config,
  domainContext = null,
  domainId = null,
  workspaceId = null,
  target = null,
  repoRoot = process.cwd(),
  platform = process.platform,
  run = spawnSync,
} = {}) {
  const oauth = config?.linear?.oauth;
  if (!oauth) throw new Error("Linear OAuth config is required for credential storage.");

  const identity = credentialIdentity({ domainContext, domainId, workspaceId });
  const resolvedTarget = target || credentialTargetForConfig(config, repoRoot, identity);
  if (oauth.credential_storage === "file") {
    return createFileCredentialStore({
      filePath: path.resolve(repoRoot, credentialFilePath({ oauth, domainId: identity.domainId })),
      target: resolvedTarget,
    });
  }

  if (oauth.credential_storage !== "os") {
    throw new Error(`Unsupported Linear OAuth credential storage: ${oauth.credential_storage}`);
  }

  return createOsCredentialStore({ platform, run, target: resolvedTarget });
}

export function credentialTargetForConfig(config, repoRoot = process.cwd(), domainIdentity = {}) {
  const oauth = config?.linear?.oauth || {};
  const identityFields = requireCredentialIdentity(domainIdentity, "Linear OAuth credential target");
  const identity = [
    "teami-linear-oauth",
    oauth.client_id || "",
    oauth.redirect_uri || "",
    path.resolve(repoRoot),
    `workspace_id:${identityFields.workspaceId}`,
    `domain_id:${identityFields.domainId}`,
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryLinearOAuth:${digest}`;
}

export function legacyCredentialTargetForConfig(config, repoRoot = process.cwd()) {
  const oauth = config?.linear?.oauth || {};
  const identity = [
    "teami-linear-oauth",
    oauth.client_id || "",
    oauth.redirect_uri || "",
    path.resolve(repoRoot),
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryLinearOAuth:${digest}`;
}

export function isLegacyCredentialTargetForConfig(target, config, repoRoot = process.cwd()) {
  return target === legacyCredentialTargetForConfig(config, repoRoot);
}

export function createFileCredentialStore({ filePath, target }) {
  const raw = createRawFileCredentialStore({
    filePath,
    target,
    warning:
      "Linear OAuth credential_storage=file stores a local refresh token in an ignored file. Use only for local testing when OS credential storage is unavailable.",
  });
  return {
    kind: "file",
    target,
    warning: raw.warning,

    async readTokenSet() {
      return parseTokenSecret(await raw.readSecret());
    },

    async writeTokenSet(tokenSet) {
      await raw.writeSecret(serializeTokenSet(tokenSet));
    },

    async deleteTokenSet() {
      await raw.deleteSecret();
    },
  };
}

export function createRawFileCredentialStore({ filePath, target, warning = null }) {
  return {
    kind: "file",
    target,
    warning,

    async readSecret() {
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, "utf8");
    },

    async writeSecret(secret) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, secret, { encoding: "utf8", mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort; Windows does not honor POSIX modes the same way.
      }
    },

    async deleteSecret() {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    },
  };
}

export function createOsCredentialStore({ platform = process.platform, run = spawnSync, target }) {
  const raw = createRawOsCredentialStore({ platform, run, target });
  return {
    kind: raw.kind,
    target,

    async readTokenSet() {
      return parseTokenSecret(await raw.readSecret());
    },

    async writeTokenSet(tokenSet) {
      await raw.writeSecret(serializeTokenSet(tokenSet));
    },

    async deleteTokenSet() {
      await raw.deleteSecret();
    },
  };
}

export function createRawOsCredentialStore({ platform = process.platform, run = spawnSync, target }) {
  if (platform === "win32") return createWindowsCredentialStore({ run, target });
  if (platform === "linux") return createLinuxSecretServiceStore({ run, target });
  if (platform === "darwin") {
    throw new Error(
      "macOS Linear OAuth credential storage is not implemented until the Keychain adapter can store tokens without passing them on process argv. Configure credential_storage=file only for local testing.",
    );
  }
  throw new Error(
    "OS Linear OAuth credential storage is not implemented for this platform yet. Configure credential_storage=file only for local testing.",
  );
}

export function parseTokenSecret(secret) {
  if (!secret) return null;
  const trimmed = secret.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return { refreshToken: trimmed };
  const parsed = JSON.parse(trimmed);
  return normalizeTokenSet(parsed);
}

export function serializeTokenSet(tokenSet) {
  const normalized = normalizeTokenSet(tokenSet);
  if (!normalized?.refreshToken) {
    throw new Error("Linear OAuth refresh token is required for credential storage.");
  }
  return `${JSON.stringify(normalized)}\n`;
}

function createWindowsCredentialStore({ run, target }) {
  return {
    kind: "windows-credential-manager",
    target,

    async readSecret() {
      const result = runWindowsCredentialCommand(run, "read", target);
      if (result.status === 3) return null;
      assertCredentialCommandOk(result, "read", "Windows Credential Manager");
      return result.stdout || "";
    },

    async writeSecret(secret) {
      const result = runWindowsCredentialCommand(run, "write", target, secret);
      assertCredentialCommandOk(result, "write", "Windows Credential Manager");
    },

    async deleteSecret() {
      const result = runWindowsCredentialCommand(run, "delete", target);
      assertCredentialCommandOk(result, "delete", "Windows Credential Manager");
    },
  };
}

function createLinuxSecretServiceStore({ run, target }) {
  return {
    kind: "linux-secret-service",
    target,

    async readSecret() {
      const result = run("secret-tool", ["lookup", "service", target, "account", CREDENTIAL_ACCOUNT], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error?.code === "ENOENT") {
        throw new Error("secret-tool is required for Linux Linear OAuth credential storage.");
      }
      if (result.status === 1) return null;
      assertCredentialCommandOk(result, "read", "Linux Secret Service");
      return result.stdout || "";
    },

    async writeSecret(secret) {
      const result = run(
        "secret-tool",
        [
          "store",
          "--label",
          "Teami Linear OAuth",
          "service",
          target,
          "account",
          CREDENTIAL_ACCOUNT,
        ],
        {
          encoding: "utf8",
          input: secret,
          windowsHide: true,
        },
      );
      if (result.error?.code === "ENOENT") {
        throw new Error("secret-tool is required for Linux Linear OAuth credential storage.");
      }
      assertCredentialCommandOk(result, "write", "Linux Secret Service");
    },

    async deleteSecret() {
      const result = run("secret-tool", ["clear", "service", target, "account", CREDENTIAL_ACCOUNT], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error?.code === "ENOENT") {
        throw new Error("secret-tool is required for Linux Linear OAuth credential storage.");
      }
      if (result.status === 1) return;
      assertCredentialCommandOk(result, "delete", "Linux Secret Service");
    },
  };
}

function runWindowsCredentialCommand(run, action, target, input = "") {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AF_LINEAR_CREDENTIAL_ACTION: action,
        AF_LINEAR_CREDENTIAL_TARGET: target,
        AF_LINEAR_CREDENTIAL_ACCOUNT: CREDENTIAL_ACCOUNT,
      },
      input,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
}

function assertCredentialCommandOk(result, action, label) {
  if (!result.error && result.status === 0) return;
  const reason = result.error?.code === "ENOENT" ? "credential helper was not found" : `exit ${result.status ?? "unknown"}`;
  throw new Error(`Could not ${action} Linear OAuth credential from ${label}: ${reason}.`);
}

function normalizeTokenSet(tokenSet) {
  if (!tokenSet) return null;
  const refreshToken = tokenSet.refreshToken || tokenSet.refresh_token || null;
  const accessToken = tokenSet.accessToken || tokenSet.access_token || null;
  return {
    ...(accessToken ? { accessToken } : {}),
    refreshToken,
    ...(tokenSet.expiresAt ? { expiresAt: tokenSet.expiresAt } : {}),
    ...(tokenSet.expires_in ? { expiresIn: tokenSet.expires_in } : {}),
    ...(tokenSet.scope ? { scope: tokenSet.scope } : {}),
    ...(tokenSet.tokenType || tokenSet.token_type
      ? { tokenType: tokenSet.tokenType || tokenSet.token_type }
      : {}),
  };
}

function credentialFilePath({ oauth, domainId }) {
  if (domainId) {
    return path.join(".teami", "domains", domainId, "linear-oauth-token.json");
  }
  return oauth.credential_file || DEFAULT_FILE_CREDENTIAL_PATH;
}

function credentialIdentity(input = {}) {
  const source = input?.domainContext || input?.context || input || {};
  return {
    domainId:
      input.domainId ||
      source.domainId ||
      source.domain_id ||
      source.trace?.domain_id ||
      null,
    workspaceId:
      input.workspaceId ||
      source.workspaceId ||
      source.workspace_id ||
      source.linear?.workspaceId ||
      source.trace?.workspace_id ||
      null,
  };
}

function requireCredentialIdentity(input = {}, label) {
  const identity = credentialIdentity(input);
  const missing = [];
  if (!identity.workspaceId) missing.push("workspace_id");
  if (!identity.domainId) missing.push("domain_id");
  if (missing.length > 0) {
    throw new Error(`${label} requires ${missing.join(" and ")}.`);
  }
  return identity;
}
