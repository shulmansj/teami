import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  fsyncDirectoryAfterRename,
  renameWithRetry,
} from "../../../engine/atomic-file.mjs";
import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";
import { teamiHomePaths } from "./app-home.mjs";
import {
  legacyFileCredentialPath,
  legacyTeamCredentialTargetsForConfig,
} from "./legacy-team-state-migration.mjs";
import { readTeamRegistry, teamRegistryPath } from "./team-registry.mjs";

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
  teamContext = null,
  teamRef = null,
  workspaceId = null,
  target = null,
  repoRoot = process.cwd(),
  home = undefined,
  platform = process.platform,
  run = spawnSync,
  promoteLegacyOnRead = true,
} = {}) {
  const oauth = config?.linear?.oauth;
  if (!oauth) throw new Error("Linear OAuth config is required for credential storage.");

  const identity = credentialIdentity({ teamContext, teamRef, workspaceId });
  const resolvedTarget = target || credentialTargetForConfig(config, identity);
  const resolvedHome = teamiHomePaths({ home }).home;
  const promotionLockPath = credentialPromotionLockPath({
    home: resolvedHome,
    target: resolvedTarget,
  });
  const legacyTargets = target
    ? []
    : legacyCredentialTargetsForConfig(config, {
        repoRoot,
        teamIdentity: identity,
        currentTarget: resolvedTarget,
      });
  if (oauth.credential_storage === "file") {
    const filePath = credentialFilePath({ oauth, teamRef: identity.teamRef, home });
    return createFileCredentialStore({
      filePath,
      safeRoot: resolvedHome,
      promotionLockPath,
      legacyFilePaths:
        !oauth.credential_file && identity.teamRef
          ? [
              legacyFileCredentialPath({
                home: resolvedHome,
                teamRef: identity.teamRef,
                credentialName: DEFAULT_FILE_CREDENTIAL_NAME,
              }),
            ]
          : [],
      target: resolvedTarget,
      promoteLegacyOnRead,
    });
  }

  if (oauth.credential_storage !== "os") {
    throw new Error(`Unsupported Linear OAuth credential storage: ${oauth.credential_storage}`);
  }

  return createOsCredentialStore({
    platform,
    run,
    target: resolvedTarget,
    legacyTargets,
    promotionLockPath,
    safeRoot: resolvedHome,
    promoteLegacyOnRead,
    onTokenSetReady: target || !promoteLegacyOnRead
      ? null
      : () => cleanupSharedBootstrapIfSafe({ config, repoRoot, home, platform, run }),
  });
}

export function credentialTargetForConfig(config, teamIdentity = {}, maybeTeamIdentity = null) {
  const oauth = config?.linear?.oauth || {};
  const identityInput =
    typeof teamIdentity === "string" ? maybeTeamIdentity || {} : teamIdentity;
  const identityFields = requireCredentialIdentity(identityInput, "Linear OAuth credential target");
  const identity = [
    oauth.client_id || "",
    oauth.redirect_uri || "",
    `workspace_id:${identityFields.workspaceId}`,
    `team_ref:${identityFields.teamRef}`,
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

function legacyCredentialTargetsForConfig(
  config,
  { repoRoot = process.cwd(), teamIdentity = {}, currentTarget = null } = {},
) {
  // Exhaustive shipped history through the Team terminology release:
  // released Team-scoped, older checkout+Team-scoped, then checkout bootstrap.
  const targets = [];
  const identity = credentialIdentity(teamIdentity);
  if (identity.teamRef && identity.workspaceId) {
    targets.push(
      ...legacyTeamCredentialTargetsForConfig(config, {
        repoRoot,
        teamRef: identity.teamRef,
        workspaceId: identity.workspaceId,
      }).map((target) => ({ target, deleteAfterPromotion: true })),
    );
  }
  // The oldest bootstrap target was checkout-scoped rather than Team-scoped.
  // Multiple Teams can still depend on it, so promotion must never delete it.
  targets.push({
    target: legacyCredentialTargetForConfig(config, repoRoot),
    deleteAfterPromotion: false,
  });
  return uniqueLegacyCredentialTargets(targets)
    .filter((candidate) => candidate.target !== currentTarget);
}

export function createFileCredentialStore({
  filePath,
  legacyFilePaths = [],
  target,
  safeRoot = path.dirname(filePath),
  promotionLockPath = `${filePath}.promotion.lock`,
  acquireLock = acquireExclusiveFileLock,
  promoteLegacyOnRead = true,
}) {
  const raw = createRawFileCredentialStore({
    filePath,
    safeRoot,
    target,
    warning:
      "Linear OAuth credential_storage=file stores a local refresh token in an ignored file. Use only for local testing when OS credential storage is unavailable.",
  });
  const legacyStores = uniqueCredentialTargets(legacyFilePaths).map((legacyFilePath) => ({
    store: createRawFileCredentialStore({
      filePath: legacyFilePath,
      safeRoot,
      target,
      warning: raw.warning,
    }),
    deleteAfterPromotion: true,
  }));
  let cleanupChecked = false;
  return {
    kind: "file",
    target,
    warning: raw.warning,

    async readTokenSet() {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, async () => {
        const current = parseTokenSecret(await raw.readSecret());
        if (!promoteLegacyOnRead) return current;
        if (current) {
          if (!cleanupChecked) {
            cleanupChecked = true;
            await cleanSafeLegacyDuplicates({ current, legacyStores });
          }
          return current;
        }
        const migrated = await migrateLegacyCredentialForRead({ raw, legacyStores });
        if (migrated) cleanupChecked = true;
        return migrated;
      });
    },

    async writeTokenSet(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => raw.writeSecret(serializeTokenSet(tokenSet)));
    },

    async writeTokenSetIfAbsentOrEqual(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => writeTokenSetWithoutOverwrite({ raw, legacyStores, tokenSet }));
    },

    async replaceTokenSetIfEqual(expectedTokenSet, tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => replaceMatchingTokenSet({ raw, expectedTokenSet, tokenSet }));
    },

    async deleteTokenSetIfEqual(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => deleteMatchingTokenSet({ raw, tokenSet }));
    },

    async deleteTokenSet() {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, async () => {
        await raw.deleteSecret();
        for (const legacy of legacyStores) await legacy.store.deleteSecret();
      });
    },
  };
}

export function createRawFileCredentialStore({
  filePath,
  target,
  warning = null,
  safeRoot = path.dirname(filePath),
}) {
  return {
    kind: "file",
    target,
    warning,

    async readSecret() {
      return readCredentialFileSafely({ filePath, safeRoot });
    },

    async writeSecret(secret) {
      writeCredentialFileAtomically({ filePath, safeRoot, secret });
    },

    async deleteSecret() {
      deleteCredentialFileSafely({ filePath, safeRoot });
    },
  };
}

export function createOsCredentialStore({
  platform = process.platform,
  run = spawnSync,
  target,
  legacyTargets = [],
  onTokenSetReady = null,
  promotionLockPath = null,
  safeRoot = null,
  acquireLock = acquireExclusiveFileLock,
  promoteLegacyOnRead = true,
}) {
  const raw = createRawOsCredentialStore({ platform, run, target });
  const legacyStores = uniqueLegacyCredentialTargets(legacyTargets).map((legacy) => ({
    store: createRawOsCredentialStore({ platform, run, target: legacy.target }),
    deleteAfterPromotion: legacy.deleteAfterPromotion,
  }));
  let cleanupChecked = false;
  let tokenReadyChecked = false;
  const notifyTokenReady = async () => {
    if (tokenReadyChecked) return;
    tokenReadyChecked = true;
    await onTokenSetReady?.();
  };
  return {
    kind: raw.kind,
    target,

    async readTokenSet() {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, async () => {
        const tokenSet = parseTokenSecret(await raw.readSecret());
        if (!promoteLegacyOnRead) return tokenSet;
        if (tokenSet) {
          if (!cleanupChecked) {
            cleanupChecked = true;
            await cleanSafeLegacyDuplicates({ current: tokenSet, legacyStores });
          }
          await notifyTokenReady();
          return tokenSet;
        }
        const migrated = await migrateLegacyCredentialForRead({ raw, legacyStores });
        if (migrated) cleanupChecked = true;
        if (migrated) await notifyTokenReady();
        return migrated;
      });
    },

    async writeTokenSet(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => raw.writeSecret(serializeTokenSet(tokenSet)));
    },

    async writeTokenSetIfAbsentOrEqual(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => writeTokenSetWithoutOverwrite({ raw, legacyStores, tokenSet }));
    },

    async replaceTokenSetIfEqual(expectedTokenSet, tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => replaceMatchingTokenSet({ raw, expectedTokenSet, tokenSet }));
    },

    async deleteTokenSetIfEqual(tokenSet) {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, () => deleteMatchingTokenSet({ raw, tokenSet }));
    },

    async deleteTokenSet() {
      return withCredentialPromotionLock({
        promotionLockPath,
        safeRoot,
        acquireLock,
      }, async () => {
        await raw.deleteSecret();
        for (const legacy of legacyStores) {
          if (legacy.deleteAfterPromotion) await legacy.store.deleteSecret();
        }
      });
    },
  };
}

async function cleanupSharedBootstrapIfSafe({
  config,
  repoRoot,
  home,
  platform,
  run,
}) {
  const resolvedHome = teamiHomePaths({ home }).home;
  const bootstrapStore = createLinearCredentialStore({
    config,
    repoRoot,
    home: resolvedHome,
    platform,
    run,
    target: legacyCredentialTargetForConfig(config, repoRoot),
  });
  let bootstrapToken;
  try {
    bootstrapToken = await bootstrapStore.readTokenSet();
    if (!bootstrapToken) return false;
  } catch {
    return false;
  }
  if (!fs.existsSync(teamRegistryPath(resolvedHome))) return false;
  let registry;
  try {
    registry = readTeamRegistry({ home: resolvedHome });
  } catch {
    return false;
  }
  const identities = (registry?.teams || [])
    .filter((team) => team.status !== "removed" && team.linear?.workspace_id)
    .map((team) => ({ teamRef: team.id, workspaceId: team.linear.workspace_id }));
  if (identities.length === 0) return false;

  try {
    for (const identity of identities) {
      const currentTarget = credentialTargetForConfig(config, identity);
      const currentStore = createRawOsCredentialStore({ platform, run, target: currentTarget });
      if (!parseTokenSecret(await currentStore.readSecret())) return false;
    }
    const deleted = await bootstrapStore.deleteTokenSetIfEqual(bootstrapToken);
    return deleted?.ok === true;
  } catch {
    // Credential cleanup cannot turn a working Team into an authorization failure.
    return false;
  }
}

async function migrateLegacyCredentialForRead({ raw, legacyStores }) {
  for (const legacy of legacyStores) {
    const tokenSet = parseTokenSecret(await legacy.store.readSecret());
    if (!tokenSet) continue;
    await raw.writeSecret(serializeTokenSet(tokenSet));
    const readBack = parseTokenSecret(await raw.readSecret());
    if (!sameTokenSet(readBack, tokenSet)) {
      throw new Error("Linear OAuth credential promotion read-back validation failed.");
    }
    if (legacy.deleteAfterPromotion) await legacy.store.deleteSecret();
    return tokenSet;
  }
  return null;
}

async function cleanSafeLegacyDuplicates({ current, legacyStores }) {
  for (const legacy of legacyStores) {
    if (!legacy.deleteAfterPromotion) continue;
    const prior = parseTokenSecret(await legacy.store.readSecret());
    if (prior && sameTokenSet(prior, current)) await legacy.store.deleteSecret();
  }
}

function sameTokenSet(first, second) {
  if (!first || !second) return false;
  return serializeTokenSet(first) === serializeTokenSet(second);
}

async function writeTokenSetWithoutOverwrite({ raw, legacyStores, tokenSet }) {
  let current = parseTokenSecret(await raw.readSecret());
  if (!current) current = await migrateLegacyCredentialForRead({ raw, legacyStores });
  if (current) {
    return sameTokenSet(current, tokenSet)
      ? { ok: true, status: "already_current" }
      : { ok: false, status: "conflict" };
  }
  await raw.writeSecret(serializeTokenSet(tokenSet));
  const readBack = parseTokenSecret(await raw.readSecret());
  if (!sameTokenSet(readBack, tokenSet)) {
    throw new Error("Linear OAuth credential promotion read-back validation failed.");
  }
  return { ok: true, status: "written" };
}

async function deleteMatchingTokenSet({ raw, tokenSet }) {
  const current = parseTokenSecret(await raw.readSecret());
  if (!current) return { ok: true, status: "absent" };
  if (!sameTokenSet(current, tokenSet)) return { ok: false, status: "conflict" };
  await raw.deleteSecret();
  const readBack = parseTokenSecret(await raw.readSecret());
  if (readBack) throw new Error("Linear OAuth credential deletion read-back validation failed.");
  return { ok: true, status: "deleted" };
}

async function replaceMatchingTokenSet({ raw, expectedTokenSet, tokenSet }) {
  const current = parseTokenSecret(await raw.readSecret());
  if (!sameTokenSet(current, expectedTokenSet)) return { ok: false, status: "conflict" };
  await raw.writeSecret(serializeTokenSet(tokenSet));
  const readBack = parseTokenSecret(await raw.readSecret());
  if (!sameTokenSet(readBack, tokenSet)) {
    throw new Error("Linear OAuth credential replacement read-back validation failed.");
  }
  return { ok: true, status: "replaced" };
}

async function withCredentialPromotionLock(
  { promotionLockPath, safeRoot, acquireLock },
  action,
) {
  if (!promotionLockPath) return action();
  let lock;
  try {
    if (safeRoot) ensureSafeCredentialParent({
      filePath: promotionLockPath,
      safeRoot,
      create: true,
    });
    lock = acquireLock({
      lockPath: promotionLockPath,
      purpose: "linear_credential_update",
    });
  } catch (error) {
    throw publicCredentialFileError(error);
  }
  if (!lock.ok) {
    throw new Error("Linear OAuth credential is being updated; retry after it finishes.");
  }
  try {
    return await action();
  } finally {
    lock.release();
  }
}

function credentialPromotionLockPath({ home, target }) {
  const digest = crypto.createHash("sha256").update(String(target)).digest("hex");
  return path.join(home, "credentials", ".promotion-locks", `${digest}.lock`);
}

function readCredentialFileSafely({ filePath, safeRoot }) {
  try {
    if (!ensureSafeCredentialParent({ filePath, safeRoot, create: false })) return null;
    const before = lstatCredentialEntry(filePath);
    if (!before) return null;
    assertRegularCredentialFile(before);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(filePath, flags);
    try {
      const opened = fs.fstatSync(fd);
      assertSameCredentialFile(before, opened);
      const contents = fs.readFileSync(fd, "utf8");
      const after = fs.fstatSync(fd);
      assertSameCredentialFile(opened, after);
      return contents;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw publicCredentialFileError(error);
  }
}

function writeCredentialFileAtomically({ filePath, safeRoot, secret }) {
  try {
    ensureSafeCredentialParent({ filePath, safeRoot, create: true });
    const existing = lstatCredentialEntry(filePath);
    if (existing) assertRegularCredentialFile(existing);
    const directory = path.dirname(filePath);
    const tempPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
    );
    let fd = null;
    try {
      fd = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(fd, secret, "utf8");
      fs.fsyncSync(fd);
      const tempStat = fs.fstatSync(fd);
      assertRegularCredentialFile(tempStat);
      fs.closeSync(fd);
      fd = null;
      try {
        fs.chmodSync(tempPath, 0o600);
      } catch {
        // Best effort; Windows does not honor POSIX modes the same way.
      }
      renameWithRetry(tempPath, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort; Windows does not honor POSIX modes the same way.
      }
      const committedStat = fs.lstatSync(filePath);
      assertRegularCredentialFile(committedStat);
      const committedFd = fs.openSync(
        filePath,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        assertSameCredentialFile(committedStat, fs.fstatSync(committedFd));
        fs.fsyncSync(committedFd);
        assertSameCredentialFile(committedStat, fs.fstatSync(committedFd));
      } finally {
        fs.closeSync(committedFd);
      }
      fsyncDirectoryAfterRename(directory, { committedFilePath: filePath });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      fs.rmSync(tempPath, { force: true });
    }
    if (readCredentialFileSafely({ filePath, safeRoot }) !== secret) {
      throw credentialFileError("Linear OAuth credential file read-back validation failed.");
    }
  } catch (error) {
    throw publicCredentialFileError(error);
  }
}

function deleteCredentialFileSafely({ filePath, safeRoot }) {
  try {
    if (!ensureSafeCredentialParent({ filePath, safeRoot, create: false })) return;
    const stat = lstatCredentialEntry(filePath);
    if (!stat) return;
    assertRegularCredentialFile(stat);
    fs.rmSync(filePath, { force: true });
    fsyncDirectoryAfterRename(path.dirname(filePath));
  } catch (error) {
    throw publicCredentialFileError(error);
  }
}

function ensureSafeCredentialParent({ filePath, safeRoot, create }) {
  const root = path.resolve(safeRoot || path.dirname(filePath));
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw credentialFileError("Linear OAuth credential file is outside its allowed local directory.");
  }
  let rootStat = lstatCredentialEntry(root);
  if (!rootStat) {
    if (!create) return false;
    fs.mkdirSync(root, { recursive: true });
    rootStat = lstatCredentialEntry(root);
  }
  assertPlainCredentialDirectory(rootStat);
  const parentRelative = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = lstatCredentialEntry(current);
    if (!stat) {
      if (!create) return false;
      fs.mkdirSync(current);
      stat = lstatCredentialEntry(current);
    }
    assertPlainCredentialDirectory(stat);
  }
  return true;
}

function lstatCredentialEntry(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPlainCredentialDirectory(stat) {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw credentialFileError("Linear OAuth credential directory is not a supported local directory.");
  }
}

function assertRegularCredentialFile(stat) {
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw credentialFileError("Linear OAuth credential file is not a supported regular file.");
  }
}

function assertSameCredentialFile(expected, actual) {
  assertRegularCredentialFile(actual);
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs
    || expected.ctimeMs !== actual.ctimeMs
  ) {
    throw credentialFileError("Linear OAuth credential file changed while it was being read.");
  }
}

class CredentialFileError extends Error {}

function credentialFileError(message, cause = undefined) {
  return new CredentialFileError(message, cause === undefined ? undefined : { cause });
}

function publicCredentialFileError(error) {
  if (error instanceof CredentialFileError) return error;
  return credentialFileError("Linear OAuth credential file could not be accessed safely.", error);
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

function credentialFilePath({ oauth, teamRef, home }) {
  const paths = teamiHomePaths({ home });
  const pathApi = pathApiForHome(paths.home);
  const credentialsDir = pathApi.join(paths.home, "credentials");
  if (oauth.credential_file) {
    if (path.isAbsolute(oauth.credential_file) || path.win32.isAbsolute(oauth.credential_file)) {
      return oauth.credential_file;
    }
    return pathApi.join(credentialsDir, oauth.credential_file);
  }
  if (teamRef) {
    return pathApi.join(credentialsDir, "teams", teamRef, DEFAULT_FILE_CREDENTIAL_NAME);
  }
  return pathApi.join(credentialsDir, DEFAULT_FILE_CREDENTIAL_NAME);
}

function credentialIdentity(input = {}) {
  const source = input?.teamContext || input?.context || input || {};
  return {
    teamRef:
      input.teamRef ||
      source.teamRef ||
      source.team_ref ||
      source.trace?.team_ref ||
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
  if (!identity.teamRef) missing.push("team_ref");
  if (missing.length > 0) {
    throw new Error(`${label} requires ${missing.join(" and ")}.`);
  }
  return identity;
}

function uniqueCredentialTargets(targets) {
  return [...new Set(targets.filter((target) => typeof target === "string" && target.trim() !== ""))];
}

function uniqueLegacyCredentialTargets(targets) {
  const unique = new Map();
  for (const entry of targets) {
    const normalized = typeof entry === "string"
      ? { target: entry, deleteAfterPromotion: true }
      : entry;
    if (typeof normalized?.target !== "string" || normalized.target.trim() === "") continue;
    const existing = unique.get(normalized.target);
    unique.set(normalized.target, {
      target: normalized.target,
      deleteAfterPromotion:
        Boolean(normalized.deleteAfterPromotion) && (existing?.deleteAfterPromotion ?? true),
    });
  }
  return [...unique.values()];
}

function pathApiForHome(home) {
  if (typeof home === "string" && (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\"))) {
    return path.win32;
  }
  return path.posix;
}
