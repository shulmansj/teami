import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { teamiHomePaths } from "./app-home.mjs";

const DEFAULT_FILE_CREDENTIAL_NAME = "linear-oauth-token.json";
const CREDENTIAL_ACCOUNT = "refresh_token";
const WINDOWS_PASSWORD_VAULT_SCRIPT = `
$ErrorActionPreference = "Stop"
$target = $env:AF_LINEAR_CREDENTIAL_TARGET
$user = $env:AF_LINEAR_CREDENTIAL_ACCOUNT
$action = $env:AF_LINEAR_CREDENTIAL_ACTION

[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = New-Object Windows.Security.Credentials.PasswordVault

function Test-TeamiCredentialMissing {
  param($errorRecord)
  $exception = $errorRecord.Exception
  if ($exception.InnerException) { $exception = $exception.InnerException }
  return $exception.HResult -eq -2147023728 -or $exception.Message -match "Element not found|not found"
}

function Get-TeamiCredential {
  param([string]$resource, [string]$userName)
  try {
    $credential = $vault.Retrieve($resource, $userName)
    $credential.RetrievePassword()
    return $credential
  } catch {
    if (Test-TeamiCredentialMissing $_) { return $null }
    throw
  }
}

if ($action -eq "read") {
  $credential = Get-TeamiCredential $target $user
  if ($null -eq $credential) { exit 3 }
  [Console]::Out.Write($credential.Password)
} elseif ($action -eq "write") {
  $secret = [Console]::In.ReadToEnd()
  $existing = Get-TeamiCredential $target $user
  if ($null -ne $existing) { $vault.Remove($existing) }
  $credential = New-Object Windows.Security.Credentials.PasswordCredential -ArgumentList $target, $user, $secret
  $vault.Add($credential)
} elseif ($action -eq "delete") {
  $credential = Get-TeamiCredential $target $user
  if ($null -ne $credential) { $vault.Remove($credential) }
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
  home = undefined,
  platform = process.platform,
  run = spawnSync,
} = {}) {
  const oauth = config?.linear?.oauth;
  if (!oauth) throw new Error("Linear OAuth config is required for credential storage.");

  const identity = credentialIdentity({ domainContext, domainId, workspaceId });
  const resolvedTarget = target || credentialTargetForConfig(config, identity);
  const legacyTargets = target
    ? []
    : legacyCredentialTargetsForConfig(config, {
        repoRoot,
        domainIdentity: identity,
        currentTarget: resolvedTarget,
      });
  if (oauth.credential_storage === "file") {
    return createFileCredentialStore({
      filePath: credentialFilePath({ oauth, domainId: identity.domainId, home }),
      target: resolvedTarget,
    });
  }

  if (oauth.credential_storage !== "os") {
    throw new Error(`Unsupported Linear OAuth credential storage: ${oauth.credential_storage}`);
  }

  return createOsCredentialStore({ platform, run, target: resolvedTarget, legacyTargets });
}

export function credentialTargetForConfig(config, domainIdentity = {}, maybeDomainIdentity = null) {
  const oauth = config?.linear?.oauth || {};
  const identityInput =
    typeof domainIdentity === "string" ? maybeDomainIdentity || {} : domainIdentity;
  const identityFields = requireCredentialIdentity(identityInput, "Linear OAuth credential target");
  const identity = [
    oauth.client_id || "",
    oauth.redirect_uri || "",
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

function legacyDomainCredentialTargetForConfig(config, repoRoot = process.cwd(), domainIdentity = {}) {
  const oauth = config?.linear?.oauth || {};
  const identityFields = requireCredentialIdentity(
    domainIdentity,
    "Legacy Linear OAuth credential target",
  );
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

function legacyCredentialTargetsForConfig(
  config,
  { repoRoot = process.cwd(), domainIdentity = {}, currentTarget = null } = {},
) {
  const targets = [];
  const identity = credentialIdentity(domainIdentity);
  if (identity.domainId && identity.workspaceId) {
    targets.push(legacyDomainCredentialTargetForConfig(config, repoRoot, identity));
  }
  targets.push(legacyCredentialTargetForConfig(config, repoRoot));
  return uniqueCredentialTargets(targets).filter((candidate) => candidate !== currentTarget);
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

export function createOsCredentialStore({
  platform = process.platform,
  run = spawnSync,
  target,
  legacyTargets = [],
}) {
  const raw = createRawOsCredentialStore({ platform, run, target });
  const legacyStores = uniqueCredentialTargets(legacyTargets).map((legacyTarget) =>
    createRawOsCredentialStore({ platform, run, target: legacyTarget }),
  );
  return {
    kind: raw.kind,
    target,

    async readTokenSet() {
      const tokenSet = parseTokenSecret(await raw.readSecret());
      if (tokenSet) return tokenSet;
      return migrateLegacyCredentialForRead({ raw, legacyStores });
    },

    async writeTokenSet(tokenSet) {
      await raw.writeSecret(serializeTokenSet(tokenSet));
    },

    async deleteTokenSet() {
      await raw.deleteSecret();
    },
  };
}

async function migrateLegacyCredentialForRead({ raw, legacyStores }) {
  for (const legacyStore of legacyStores) {
    const tokenSet = parseTokenSecret(await legacyStore.readSecret());
    if (!tokenSet) continue;
    await raw.writeSecret(serializeTokenSet(tokenSet));
    await legacyStore.deleteSecret();
    return tokenSet;
  }
  return null;
}

export function createRawOsCredentialStore({ platform = process.platform, run = spawnSync, target }) {
  if (platform === "win32") return createWindowsCredentialStore({ run, target });
  if (platform === "linux") return createLinuxSecretServiceStore({ run, target });
  if (platform === "darwin") return createMacosKeychainStore({ run, target });
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

function createMacosKeychainStore({ run, target }) {
  return {
    kind: "macos-keychain",
    target,

    async readSecret() {
      const result = runMacosSecurityCommand(run, [
        "find-generic-password",
        "-a",
        CREDENTIAL_ACCOUNT,
        "-s",
        target,
        "-w",
      ]);
      if (isMacosSecurityNotFound(result)) return null;
      assertCredentialCommandOk(result, "read", "macOS Keychain");
      return result.stdout || "";
    },

    async writeSecret(secret) {
      const result = runMacosSecurityCommand(
        run,
        [
          "add-generic-password",
          "-a",
          CREDENTIAL_ACCOUNT,
          "-s",
          target,
          "-U",
          "-w",
        ],
        secret,
      );
      assertCredentialCommandOk(result, "write", "macOS Keychain");
    },

    async deleteSecret() {
      const result = runMacosSecurityCommand(run, [
        "delete-generic-password",
        "-a",
        CREDENTIAL_ACCOUNT,
        "-s",
        target,
      ]);
      if (isMacosSecurityNotFound(result)) return;
      assertCredentialCommandOk(result, "delete", "macOS Keychain");
    },
  };
}

function runWindowsCredentialCommand(run, action, target, input = "") {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PASSWORD_VAULT_SCRIPT],
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

function runMacosSecurityCommand(run, args, input = undefined) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  };
  if (input !== undefined) options.input = input;
  return run("security", args, options);
}

function isMacosSecurityNotFound(result) {
  if (result?.status === 44) return true;
  const output = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  return /specified item could not be found|could not be found in the keychain|not found/i.test(output);
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

function credentialFilePath({ oauth, domainId, home }) {
  const paths = teamiHomePaths({ home });
  const pathApi = pathApiForHome(paths.home);
  const credentialsDir = pathApi.join(paths.home, "credentials");
  if (oauth.credential_file) {
    if (path.isAbsolute(oauth.credential_file) || path.win32.isAbsolute(oauth.credential_file)) {
      return oauth.credential_file;
    }
    return pathApi.join(credentialsDir, oauth.credential_file);
  }
  if (domainId) {
    return pathApi.join(credentialsDir, "domains", domainId, DEFAULT_FILE_CREDENTIAL_NAME);
  }
  return pathApi.join(credentialsDir, DEFAULT_FILE_CREDENTIAL_NAME);
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

function uniqueCredentialTargets(targets) {
  return [...new Set(targets.filter((target) => typeof target === "string" && target.trim() !== ""))];
}

function pathApiForHome(home) {
  if (typeof home === "string" && (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\"))) {
    return path.win32;
  }
  return path.posix;
}
