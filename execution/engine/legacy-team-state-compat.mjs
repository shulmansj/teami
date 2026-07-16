import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LEGACY_TEAM_IDENTITY_MARKER = Symbol("teami.legacyTeamIdentity");

export function legacyTeamRunArtifactPath({ home, teamRef, runId }) {
  return path.join(home, "domains", teamRef, "runs", `${runId}.json`);
}

export function findLegacyTeamRunArtifactPath({ home, runId, teamRef = null }) {
  try {
    const root = path.join(home, "domains");
    const rootStat = lstatIfPresent(root);
    if (!rootStat) return null;
    assertPlainDirectory(rootStat);
    const teamRefs = teamRef ? [teamRef] : fs.readdirSync(root);
    for (const candidateTeamRef of teamRefs) {
      const teamDir = safeChildPath(root, candidateTeamRef);
      const teamStat = lstatIfPresent(teamDir);
      if (!teamStat) continue;
      assertPlainDirectory(teamStat);
      const runsDir = path.join(teamDir, "runs");
      const runsStat = lstatIfPresent(runsDir);
      if (!runsStat) continue;
      assertPlainDirectory(runsStat);
      const candidate = legacyTeamRunArtifactPath({
        home,
        teamRef: candidateTeamRef,
        runId,
      });
      assertContainedPath(runsDir, candidate);
      const candidateStat = lstatIfPresent(candidate);
      if (!candidateStat) continue;
      if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
        throw new Error("unsupported_prior_team_run_entry");
      }
      return candidate;
    }
    return null;
  } catch (error) {
    throw new Error("Prior Team run state could not be read safely.", { cause: error });
  }
}

export function normalizeLegacyTeamIdentityForRead(value) {
  if (Array.isArray(value)) return value.map(normalizeLegacyTeamIdentityForRead);
  if (!value || typeof value !== "object") return value;
  const containsLegacyIdentity =
    hasLegacyTeamIdentity(value) && !hasCurrentTeamIdentity(value);
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const currentKey =
      key === "domain_id"
        ? "team_ref"
        : key === "domainId"
          ? "teamRef"
          : key === "teami.domain_id"
            ? "teami.team_ref"
            : key;
    if (Object.hasOwn(normalized, currentKey) && currentKey !== key) continue;
    normalized[currentKey] = normalizeLegacyTeamIdentityForRead(entry);
  }
  if (containsLegacyIdentity) markLegacyTeamIdentityForRead(normalized);
  return normalized;
}

export function markLegacyTeamIdentityForRead(value) {
  if (value && typeof value === "object") {
    Object.defineProperty(value, LEGACY_TEAM_IDENTITY_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return value;
}

export function isLegacyTeamIdentityForRead(value) {
  return Boolean(value?.[LEGACY_TEAM_IDENTITY_MARKER]);
}

export function normalizeLegacyMutationJournalForRead(records) {
  if (!records.some(hasLegacyTeamIdentity)) return records;

  let sourcePriorHash = null;
  let destinationPriorHash = null;
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const { record_hash: sourceHash, ...sourceUnsigned } = record;
    if (record.prior_record_hash !== sourcePriorHash || sourceHash !== hashRecord(sourceUnsigned)) {
      throw new Error(`legacy_mutation_reconciliation_journal_hash_mismatch:${index + 1}`);
    }
    sourcePriorHash = sourceHash;

    const migrated = normalizeLegacyTeamIdentityForRead(record);
    migrated.prior_record_hash = destinationPriorHash;
    const { record_hash: _discardedHash, ...destinationUnsigned } = migrated;
    migrated.record_hash = hashRecord(destinationUnsigned);
    destinationPriorHash = migrated.record_hash;
    return migrated;
  });
}

export function legacyMutationIntentDigest(record) {
  if (!record?.team_ref) return null;
  const legacyShape = {
    object_type: record.object_type,
    object_id: record.object_id,
    linear_project_id: record.linear_project_id,
    workflow_type: record.workflow_type,
    trigger_type: record.trigger_type,
    domain_id: record.team_ref,
    run_id: record.run_id,
    artifact_kind: record.artifact_kind,
    wake_id: record.wake_id,
    started_at: record.started_at,
    git: record.git,
  };
  return hashRecord(legacyShape);
}

function hasLegacyTeamIdentity(value) {
  if (Array.isArray(value)) return value.some(hasLegacyTeamIdentity);
  if (!value || typeof value !== "object") return false;
  if (
    Object.hasOwn(value, "domain_id") ||
    Object.hasOwn(value, "domainId") ||
    Object.hasOwn(value, "teami.domain_id")
  ) return true;
  return Object.values(value).some(hasLegacyTeamIdentity);
}

function hasCurrentTeamIdentity(value) {
  if (Array.isArray(value)) return value.some(hasCurrentTeamIdentity);
  if (!value || typeof value !== "object") return false;
  if (
    Object.hasOwn(value, "team_ref") ||
    Object.hasOwn(value, "teamRef") ||
    Object.hasOwn(value, "teami.team_ref")
  ) return true;
  return Object.values(value).some(hasCurrentTeamIdentity);
}

function hashRecord(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function lstatIfPresent(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPlainDirectory(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("unsupported_prior_team_run_entry");
  }
}

function safeChildPath(parent, child) {
  const candidate = path.resolve(parent, String(child));
  assertContainedPath(parent, candidate);
  return candidate;
}

function assertContainedPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("unsupported_prior_team_run_entry");
  }
}
