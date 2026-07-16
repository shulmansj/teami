import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fsyncDirectoryAfterRename } from "../../../engine/atomic-file.mjs";
import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";

const LEGACY_REGISTRY_SCHEMAS = new Set([
  "teami-domain-registry/v1",
  "teami-domain-registry/v2",
]);
const LEGACY_TOP_LEVEL_KEYS = new Set(["schema_version", "domains"]);
const LEGACY_TEAM_KEYS = new Set([
  "id",
  "status",
  "adopter_provided_name",
  "setup_incomplete_cause",
  "linear",
  "resources",
  "policy_profile",
  "policy_overlay_ref",
]);

/**
 * Promotes the last released registry layout into the Team registry layout.
 *
 * The source is deliberately left in place as recovery evidence. The new
 * registry is not published until every source file has been copied, flushed,
 * and compared byte-for-byte, so an interrupted migration is safe to resume.
 */
export function migrateLegacyTeamRegistryState({
  home,
  destinationRegistryPath,
  schemaVersion,
  teamCacheRelativePath,
  validateRegistry,
  writeRegistry,
  copyDirectory = copyMissingDirectoryRecursively,
  acquireLock = acquireExclusiveFileLock,
  acquireGatewayReservation = acquireGatewayMigrationReservation,
  isProcessAlive = processIsAlive,
} = {}) {
  try {
    return migrateLegacyTeamRegistryStateUnsafe({
      home,
      destinationRegistryPath,
      schemaVersion,
      teamCacheRelativePath,
      validateRegistry,
      writeRegistry,
      copyDirectory,
      acquireLock,
      acquireGatewayReservation,
      isProcessAlive,
    });
  } catch (error) {
    throw publicTeamStateUpgradeError(error);
  }
}

function migrateLegacyTeamRegistryStateUnsafe({
  home,
  destinationRegistryPath,
  schemaVersion,
  teamCacheRelativePath,
  validateRegistry,
  writeRegistry,
  copyDirectory,
  acquireLock,
  acquireGatewayReservation,
  isProcessAlive,
}) {
  if (!assertPlainDirectoryIfPresent(home, "Teami home")) return null;
  if (assertRegularFileIfPresent(destinationRegistryPath, "Team registry")) return null;

  const sourceRegistryPath = legacyRegistryPath(home);
  if (!assertRegularFileIfPresent(sourceRegistryPath, "Prior Team registry")) {
    assertNoUnregisteredLegacyState(home);
    return null;
  }

  const lock = acquireLock({
    lockPath: `${destinationRegistryPath}.migration.lock`,
    purpose: "team_state_upgrade",
  });
  if (!lock.ok) {
    throw teamStateUpgradeError("Team state upgrade is already running; retry after it finishes.");
  }

  let gatewayReservation = null;
  try {
    if (assertRegularFileIfPresent(destinationRegistryPath, "Team registry")) return null;
    gatewayReservation = acquireGatewayReservation({ home, isProcessAlive });

    const sourceRegistrySnapshot = captureRegularFileSnapshot(sourceRegistryPath);
    const source = JSON.parse(sourceRegistrySnapshot.contents.toString("utf8"));
    const registry = convertLegacyRegistry({ source, schemaVersion, teamCacheRelativePath });
    validateRegistry(registry);
    assertPlainDirectoryIfPresent(path.join(home, "domains"), "Prior Team directory");

    const sourceSnapshots = [];
    for (const team of registry.teams) {
      const sourceDir = legacyTeamDirectory(home, team.id);
      if (!assertPlainDirectoryIfPresent(sourceDir, "Prior Team directory")) continue;
      const snapshot = captureDirectorySnapshot(sourceDir);
      sourceSnapshots.push({ sourceDir, snapshot });
      const destinationDir = currentTeamDirectory(home, team.id);
      copyDirectory(sourceDir, destinationDir, { home });
      verifyCopiedSnapshot({ snapshot, destinationDir });
      flushDirectoryTree(destinationDir);
    }

    assertRegularFileSnapshotUnchanged(sourceRegistryPath, sourceRegistrySnapshot);
    for (const { sourceDir, snapshot } of sourceSnapshots) {
      assertDirectorySnapshotUnchanged(sourceDir, snapshot);
    }

    // The exclusive publisher must still refuse to replace a registry created
    // by any non-migration writer that does not participate in this lock.
    if (fs.existsSync(destinationRegistryPath)) return null;
    const published = writeRegistry(registry);
    return published === false ? null : registry;
  } finally {
    gatewayReservation?.release();
    lock.release();
  }
}

export function legacyFileCredentialPath({ home, teamRef, credentialName }) {
  return path.join(home, "credentials", "domains", teamRef, credentialName);
}

export function assertNoPriorTeamStateBeforeCreate(home) {
  try {
    if (assertRegularFileIfPresent(legacyRegistryPath(home), "Prior Team registry")) {
      throw teamStateUpgradeError("Prior Teami Team state must be upgraded before creating a new Team registry.");
    }
    assertNoUnregisteredLegacyState(home);
  } catch (error) {
    throw publicTeamStateUpgradeError(error);
  }
}

export function removePriorTeamRecoveryState(home) {
  try {
    fs.rmSync(legacyRegistryPath(home), { force: true });
    fs.rmSync(path.join(home, "domains"), { recursive: true, force: true });
  } catch (error) {
    throw publicTeamStateUpgradeError(error, "Prior Team recovery state could not be removed safely.");
  }
}

export function legacyTeamCredentialTargetsForConfig(
  config,
  { repoRoot = process.cwd(), teamRef, workspaceId } = {},
) {
  if (!teamRef || !workspaceId) return [];
  const oauth = config?.linear?.oauth || {};
  const releasedIdentity = [
    oauth.client_id || "",
    oauth.redirect_uri || "",
    `workspace_id:${workspaceId}`,
    `domain_id:${teamRef}`,
  ].join("\n");
  const olderRepoIdentity = [
    "teami-linear-oauth",
    oauth.client_id || "",
    oauth.redirect_uri || "",
    path.resolve(repoRoot),
    `workspace_id:${workspaceId}`,
    `domain_id:${teamRef}`,
  ].join("\n");
  return [credentialTarget(releasedIdentity), credentialTarget(olderRepoIdentity)];
}

function convertLegacyRegistry({ source, schemaVersion, teamCacheRelativePath }) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw teamStateUpgradeError("Invalid legacy team registry: document_not_object");
  }
  assertAllowedKeys(source, LEGACY_TOP_LEVEL_KEYS, "registry");
  if (!LEGACY_REGISTRY_SCHEMAS.has(source.schema_version)) {
    throw teamStateUpgradeError("Invalid legacy team registry: unsupported_schema_version");
  }
  if (!Array.isArray(source.domains)) {
    throw teamStateUpgradeError("Invalid legacy team registry: teams_not_array");
  }

  const teams = source.domains.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw teamStateUpgradeError(`Invalid legacy team registry: teams[${index}]_not_object`);
    }
    assertAllowedKeys(record, LEGACY_TEAM_KEYS, `teams[${index}]`);
    const team = structuredClone(record);
    if (team.linear && typeof team.linear === "object" && !Array.isArray(team.linear)) {
      team.linear.cache_path = teamCacheRelativePath(team.id);
    }
    return team;
  });

  return { schema_version: schemaVersion, teams };
}

function legacyRegistryPath(home) {
  return path.join(home, "domains.json");
}

function legacyTeamDirectory(home, teamRef) {
  return path.join(home, "domains", teamRef);
}

function currentTeamDirectory(home, teamRef) {
  return path.join(home, "teams", teamRef);
}

function copyMissingDirectoryRecursively(sourceDir, destinationDir, { home } = {}) {
  assertPlainDirectory(sourceDir, "Prior Team directory");
  ensureDirectory(destinationDir, { rootPath: home });
  for (const entryName of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entryName);
    const destinationPath = path.join(destinationDir, entryName);
    const sourceStat = fs.lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw teamStateUpgradeError("Prior Team state contains an unsupported filesystem entry.");
    }
    if (sourceStat.isDirectory()) {
      const destinationStat = lstatIfPresent(destinationPath);
      if (destinationStat && (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())) {
        throw teamStateUpgradeError(`Prior Team state conflicts with current Team state: ${destinationPath}`);
      }
      copyMissingDirectoryRecursively(sourcePath, destinationPath, { home });
      continue;
    }
    if (!sourceStat.isFile()) {
      throw teamStateUpgradeError("Prior Team state contains an unsupported filesystem entry.");
    }
    const destinationStat = lstatIfPresent(destinationPath);
    if (destinationStat) {
      if (
        destinationStat.isSymbolicLink()
        || !destinationStat.isFile()
        || !filesEqual(sourcePath, destinationPath)
      ) {
        throw teamStateUpgradeError(`Prior Team state conflicts with current Team state: ${destinationPath}`);
      }
      continue;
    }
    copyFileDurablyWithoutOverwrite(sourcePath, destinationPath, { home, sourceStat });
  }
}

function captureDirectorySnapshot(directoryPath) {
  const before = fs.lstatSync(directoryPath);
  assertPlainDirectoryStat(before, "Prior Team directory");
  const names = fs.readdirSync(directoryPath).sort();
  const entries = names.map((name) => {
    const entryPath = path.join(directoryPath, name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw teamStateUpgradeError("Prior Team state contains an unsupported filesystem entry.");
    }
    if (stat.isDirectory()) {
      return { name, type: "directory", snapshot: captureDirectorySnapshot(entryPath) };
    }
    if (!stat.isFile()) {
      throw teamStateUpgradeError("Prior Team state contains an unsupported filesystem entry.");
    }
    return { name, type: "file", snapshot: captureRegularFileSnapshot(entryPath, stat) };
  });
  const after = fs.lstatSync(directoryPath);
  assertSameDirectory(before, after);
  assertSameEntryNames(names, fs.readdirSync(directoryPath).sort());
  return { stat: before, entries };
}

function verifyCopiedSnapshot({ snapshot, destinationDir }) {
  assertPlainDirectory(destinationDir, "Team directory");
  for (const entry of snapshot.entries) {
    const destinationPath = path.join(destinationDir, entry.name);
    const destinationStat = lstatIfPresent(destinationPath);
    if (!destinationStat) {
      throw teamStateUpgradeError("Team state upgrade left a source entry uncopied.");
    }
    if (entry.type === "directory") {
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw teamStateUpgradeError("Team state upgrade produced a mismatched entry type.");
      }
      verifyCopiedSnapshot({ snapshot: entry.snapshot, destinationDir: destinationPath });
      continue;
    }
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      throw teamStateUpgradeError("Team state upgrade produced a mismatched entry type.");
    }
    const destinationContents = readVerifiedRegularFile(destinationPath, {
      expectedStat: destinationStat,
    });
    if (!destinationContents.equals(entry.snapshot.contents)) {
      throw teamStateUpgradeError("Team state upgrade produced mismatched file contents.");
    }
  }
}

function assertDirectorySnapshotUnchanged(directoryPath, snapshot) {
  const current = fs.lstatSync(directoryPath);
  assertSameDirectory(snapshot.stat, current);
  const names = fs.readdirSync(directoryPath).sort();
  assertSameEntryNames(snapshot.entries.map((entry) => entry.name), names);
  for (const entry of snapshot.entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.type === "directory") {
      assertDirectorySnapshotUnchanged(entryPath, entry.snapshot);
    } else {
      assertRegularFileSnapshotUnchanged(entryPath, entry.snapshot);
    }
  }
}

function captureRegularFileSnapshot(filePath, expectedStat = null) {
  const stat = fs.lstatSync(filePath);
  assertRegularFile(stat, "Team state file");
  if (expectedStat) assertSameFile(expectedStat, stat);
  return {
    stat,
    contents: readVerifiedRegularFile(filePath, { expectedStat: stat }),
  };
}

function assertRegularFileSnapshotUnchanged(filePath, snapshot) {
  const stat = fs.lstatSync(filePath);
  assertSameFile(snapshot.stat, stat);
  const contents = readVerifiedRegularFile(filePath, { expectedStat: stat });
  if (!contents.equals(snapshot.contents)) {
    throw teamStateUpgradeError("Team state changed while it was being upgraded; retry after local changes stop.");
  }
}

function assertPlainDirectoryStat(stat, label) {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw teamStateUpgradeError(`${label} is not a supported local directory.`);
  }
}

function assertSameDirectory(expected, actual) {
  assertPlainDirectoryStat(actual, "Team state directory");
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.mtimeMs !== actual.mtimeMs
    || expected.ctimeMs !== actual.ctimeMs
  ) {
    throw teamStateUpgradeError("Team state changed while it was being upgraded; retry after local changes stop.");
  }
}

function assertSameEntryNames(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw teamStateUpgradeError("Team state changed while it was being upgraded; retry after local changes stop.");
  }
}

function copyFileDurablyWithoutOverwrite(
  sourcePath,
  destinationPath,
  { home, sourceStat = null } = {},
) {
  const source = readVerifiedRegularFile(sourcePath, { expectedStat: sourceStat });
  ensureDirectory(path.dirname(destinationPath), { rootPath: home });
  const tempPath = `${destinationPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.migration`;
  let tempFd = null;
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(tempFd, source);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;
    try {
      fs.linkSync(tempPath, destinationPath);
    } catch (error) {
      if (error?.code !== "EEXIST" || !filesEqual(sourcePath, destinationPath)) throw error;
    }
    fsyncDirectoryAfterRename(path.dirname(destinationPath), { committedFilePath: destinationPath });
  } finally {
    if (tempFd !== null) fs.closeSync(tempFd);
    fs.rmSync(tempPath, { force: true });
  }
}

function ensureDirectory(directoryPath, { rootPath } = {}) {
  const root = path.resolve(rootPath || path.dirname(directoryPath));
  const target = path.resolve(directoryPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw teamStateUpgradeError("Team state upgrade refused a directory outside Teami home.");
  }
  assertPlainDirectory(root, "Teami home");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw teamStateUpgradeError("Team state upgrade found an unsupported filesystem entry.");
      }
      continue;
    }
    fs.mkdirSync(current);
    assertPlainDirectory(current, "Team directory");
    fsyncDirectoryAfterRename(path.dirname(current));
  }
}

function flushDirectoryTree(directoryPath) {
  assertPlainDirectory(directoryPath, "Team directory");
  for (const entryName of fs.readdirSync(directoryPath)) {
    const entryPath = path.join(directoryPath, entryName);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw teamStateUpgradeError("Team state upgrade found an unsupported filesystem entry.");
    }
    if (stat.isDirectory()) flushDirectoryTree(entryPath);
    else if (stat.isFile()) flushFile(entryPath);
    else throw teamStateUpgradeError("Team state upgrade found an unsupported filesystem entry.");
  }
  fsyncDirectoryAfterRename(directoryPath);
}

function flushFile(filePath) {
  const before = fs.lstatSync(filePath);
  assertRegularFile(before, "Team state file");
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    assertSameFile(before, fs.fstatSync(fd));
    fs.fsyncSync(fd);
    assertSameFile(before, fs.fstatSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

function filesEqual(firstPath, secondPath) {
  const first = fs.lstatSync(firstPath);
  const second = fs.lstatSync(secondPath);
  if (
    first.isSymbolicLink()
    || second.isSymbolicLink()
    || !first.isFile()
    || !second.isFile()
    || first.size !== second.size
  ) return false;
  return readVerifiedRegularFile(firstPath, { expectedStat: first })
    .equals(readVerifiedRegularFile(secondPath, { expectedStat: second }));
}

function readVerifiedRegularFile(filePath, { expectedStat = null } = {}) {
  const before = fs.lstatSync(filePath);
  assertRegularFile(before, "Team state file");
  if (expectedStat) assertSameFile(expectedStat, before);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    assertSameFile(before, opened);
    const contents = fs.readFileSync(fd);
    assertSameFile(opened, fs.fstatSync(fd));
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

function assertRegularFile(stat, label) {
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw teamStateUpgradeError(`${label} is not a supported regular file.`);
  }
}

function assertSameFile(expected, actual) {
  assertRegularFile(actual, "Team state file");
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs
    || expected.ctimeMs !== actual.ctimeMs
  ) {
    throw teamStateUpgradeError("Team state changed while it was being upgraded; retry after local changes stop.");
  }
}

function acquireGatewayMigrationReservation({ home, isProcessAlive }) {
  const lockPath = path.join(home, "gateway.lock");
  const reservation = acquireExclusiveFileLock({
    lockPath,
    purpose: "gateway",
    isProcessAlive,
  });
  if (reservation.ok) return reservation;

  const lock = readGatewayReservationOwner(lockPath);
  if (!lock) {
    throw teamStateUpgradeError(
      "The Teami gateway lock is unreadable; repair it before upgrading Team state.",
    );
  }
  const pid = Number(lock?.pid);
  const createdAt = Date.parse(lock?.acquired_at || lock?.created_at);
  if (
    !Number.isInteger(pid)
    || pid <= 0
    || !Number.isFinite(createdAt)
    || typeof lock?.token !== "string"
    || lock.token.trim() === ""
    || (lock.schema_version === "teami-exclusive-file-lock/v2" && lock.purpose !== "gateway")
  ) {
    throw teamStateUpgradeError(
      "The Teami gateway lock is invalid; repair it before upgrading Team state.",
    );
  }
  if (pid === process.pid) return { ok: true, borrowed: true, release: () => false };

  let alive = null;
  try {
    alive = isProcessAlive(pid);
  } catch {
    alive = null;
  }
  if (alive === true) {
    throw teamStateUpgradeError("Stop the running Teami gateway before upgrading Team state, then retry.");
  }
  throw teamStateUpgradeError(
    "A stale Teami gateway lock blocks the Team state upgrade; start the gateway once to repair it, then retry.",
  );
}

function readGatewayReservationOwner(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) return null;
    const ownerPath = stat.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    return JSON.parse(readVerifiedRegularFile(ownerPath).toString("utf8"));
  } catch {
    return null;
  }
}

function assertNoUnregisteredLegacyState(home) {
  const legacyRoot = path.join(home, "domains");
  if (!assertPlainDirectoryIfPresent(legacyRoot, "Prior Team directory")) return;
  if (fs.readdirSync(legacyRoot).length > 0) {
    throw teamStateUpgradeError("Prior Teami Team state exists without its registry; restore the registry before continuing.");
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function credentialTarget(identity) {
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryLinearOAuth:${digest}`;
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowedKeys.has(key)) {
      throw teamStateUpgradeError(`Invalid legacy team registry: unknown_key:${label}.${key}`);
    }
  }
}

class TeamStateUpgradeError extends Error {}

function teamStateUpgradeError(message, cause = undefined) {
  return new TeamStateUpgradeError(message, cause === undefined ? undefined : { cause });
}

function publicTeamStateUpgradeError(
  error,
  message = "Team state upgrade could not read or write prior local state safely.",
) {
  if (error instanceof TeamStateUpgradeError) return error;
  return teamStateUpgradeError(message, error);
}

function lstatIfPresent(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFileIfPresent(filePath, label) {
  const stat = lstatIfPresent(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw teamStateUpgradeError(`${label} is not a supported regular file.`);
  }
  return true;
}

function assertPlainDirectoryIfPresent(directoryPath, label) {
  const stat = lstatIfPresent(directoryPath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw teamStateUpgradeError(`${label} is not a supported local directory.`);
  }
  return true;
}

function assertPlainDirectory(directoryPath, label) {
  if (!assertPlainDirectoryIfPresent(directoryPath, label)) {
    throw teamStateUpgradeError(`${label} is missing.`);
  }
}
