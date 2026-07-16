import fs from "node:fs";
import path from "node:path";

import {
  fsyncDirectoryAfterRename,
  writeFileAndFsync,
} from "../../../engine/atomic-file.mjs";
import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";
import { getResourceKind } from "../../../engine/resource-registry.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import {
  assertNoPriorTeamStateBeforeCreate,
  migrateLegacyTeamRegistryState,
  removePriorTeamRecoveryState,
} from "./legacy-team-state-migration.mjs";

export const TEAM_REGISTRY_SCHEMA_VERSION = "teami-team-registry/v1";
export const TEAM_REGISTRY_RELATIVE_PATH = "teams.json";
export const TEAM_LIFECYCLE_STATES = Object.freeze([
  "setup_incomplete",
  "active",
  "paused",
  "removed",
]);
export const TEAM_REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_TEAM_REF_LENGTH = 48;
export const TEAM_CREATE_SETUP_CAUSES = Object.freeze([
  "linear_team_create_restricted",
  "linear_team_limit_reached",
  "linear_team_create_unknown_error",
]);
export const SETUP_INCOMPLETE_CAUSES = Object.freeze([
  ...TEAM_CREATE_SETUP_CAUSES,
  "linear_webhook_registration_failed",
  "runner_authority_failed",
  "credential_promotion_failed",
  "cache_write_failed",
  "registry_write_failed",
]);

// These strict key allow-lists are the extension point for future registry fields.
const TOP_LEVEL_KEYS = new Set(["schema_version", "teams"]);
const TEAM_KEYS = new Set([
  "id",
  "status",
  "adopter_provided_name",
  "setup_incomplete_cause",
  "linear",
  "resources",
  "policy_profile",
  "policy_overlay_ref",
]);
const LINEAR_KEYS = new Set([
  "workspace_id",
  "workspace_name",
  "team_id",
  "team_key",
  "team_name",
  "team_name_last_seen_at",
  "provisioned_by_teami",
  "webhook_id",
  "cache_path",
]);
const RESOURCE_KEYS = new Set(["id", "kind", "role", "binding"]);

export function teamRegistryPath(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, TEAM_REGISTRY_RELATIVE_PATH);
}

export function teamCacheRelativePath(teamRef) {
  assertTeamRef(teamRef, "team_ref");
  return path.join("teams", teamRef, "linear.json").replace(/\\/g, "/");
}

export function teamCachePath({ home = resolveTeamiHome(), teamRef, cachePath = null } = {}) {
  const relativePath = cachePath || teamCacheRelativePath(teamRef);
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath);
  return path.resolve(
    teamiHomePaths({ home, teamRef }).home,
    stripLegacyTeamiPrefix(relativePath),
  );
}

export function emptyTeamRegistry() {
  return {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [],
  };
}

export function readTeamRegistry({ home = resolveTeamiHome(), registryPath = teamRegistryPath(home) } = {}) {
  if (!fs.existsSync(registryPath)) {
    const migrated = migrateLegacyTeamRegistryState({
      home,
      destinationRegistryPath: registryPath,
      schemaVersion: TEAM_REGISTRY_SCHEMA_VERSION,
      teamCacheRelativePath,
      validateRegistry: validateTeamRegistry,
      writeRegistry: (registry) => writeTeamRegistryIfAbsent({ home, registryPath }, registry),
    });
    if (migrated) return migrated;
    if (!fs.existsSync(registryPath)) return null;
  }
  return readPublishedTeamRegistry(registryPath);
}

export function writeTeamRegistryIfAbsent(
  { home = resolveTeamiHome(), registryPath = teamRegistryPath(home) } = {},
  registry,
) {
  validateTeamRegistry(registry);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.publish`,
  );
  let published = false;
  try {
    writeFileAndFsync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx" });
    validateTeamRegistry(JSON.parse(fs.readFileSync(tempPath, "utf8")));
    try {
      fs.linkSync(tempPath, registryPath);
      published = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  if (published) {
    fsyncDirectoryAfterRename(path.dirname(registryPath), { committedFilePath: registryPath });
  }
  const readBack = migrateTeamRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
  validateTeamRegistry(readBack);
  if (JSON.stringify(readBack) !== JSON.stringify(registry)) {
    throw new Error(`Team registry exclusive publish read-back validation failed: ${registryPath}`);
  }
  return true;
}

export function migrateTeamRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return registry;
  if (registry.schema_version === TEAM_REGISTRY_SCHEMA_VERSION) {
    return migrateTeamCachePaths(registry);
  }
  return registry;
}

export function writeTeamRegistry(
  { home = resolveTeamiHome(), registryPath = teamRegistryPath(home) } = {},
  registry,
) {
  validateTeamRegistry(registry);
  const lock = acquireTeamRegistryLock(registryPath, "team_registry_write");
  if (!lock.ok) throw new Error("Team registry is being updated; retry after it finishes.");
  try {
    if (!fs.existsSync(registryPath)) assertNoPriorTeamStateBeforeCreate(home);
    return writeTeamRegistryUnderLock({ registryPath, registry });
  } finally {
    lock.release();
  }
}

export function updateTeamRegistry(
  {
    home = resolveTeamiHome(),
    registryPath = teamRegistryPath(home),
    createIfMissingRegistry = null,
  } = {},
  update,
) {
  if (typeof update !== "function") throw new Error("team_registry_update_required");
  const lock = acquireTeamRegistryLock(registryPath, "team_registry_update");
  if (!lock.ok) throw new Error("Team registry is being updated; retry after it finishes.");
  try {
    let currentRegistry;
    if (!fs.existsSync(registryPath)) {
      assertNoPriorTeamStateBeforeCreate(home);
      if (!createIfMissingRegistry) throw new Error("team_registry_missing");
      currentRegistry = structuredClone(createIfMissingRegistry);
      validateTeamRegistry(currentRegistry);
    } else {
      currentRegistry = readPublishedTeamRegistry(registryPath);
    }
    const outcome = update(structuredClone(currentRegistry));
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      throw new Error("team_registry_update_result_invalid");
    }
    const nextRegistry = outcome.registry;
    validateTeamRegistry(nextRegistry);
    const changed = JSON.stringify(nextRegistry) !== JSON.stringify(currentRegistry);
    const committedPath = changed
      ? writeTeamRegistryUnderLock({ registryPath, registry: nextRegistry })
      : null;
    return {
      ...outcome,
      changed,
      registry: nextRegistry,
      registryPath: committedPath,
    };
  } finally {
    lock.release();
  }
}

export function createAtomicTeamRegistryWriter({
  home = resolveTeamiHome(),
  initialRegistry = emptyTeamRegistry(),
  updateRegistry = updateTeamRegistry,
} = {}) {
  validateTeamRegistry(initialRegistry);
  const expectedTeams = new Map(
    initialRegistry.teams.map((team) => [team.id, structuredClone(team)]),
  );

  return async (_proposedRegistry, teamRecord) => {
    if (!teamRecord?.id) throw new Error("team_registry_write_team_required");
    const expected = expectedTeams.get(teamRecord.id) || null;
    const outcome = updateRegistry(
      { home, createIfMissingRegistry: emptyTeamRegistry() },
      (currentRegistry) => {
        const current = currentRegistry.teams.find((team) => team.id === teamRecord.id) || null;
        if (!sameTeamRecord(current, expected)) {
          const error = new Error(
            `Team ${teamRecord.id} changed while setup was running; retry so Teami can use the latest Team state.`,
          );
          error.code = "team_registry_team_conflict";
          throw error;
        }
        return {
          registry: upsertTeamRecord(currentRegistry, teamRecord),
          team: teamRecord,
        };
      },
    );
    expectedTeams.set(teamRecord.id, structuredClone(teamRecord));
    return outcome;
  };
}

export function removeTeamRegistryState({ home = resolveTeamiHome() } = {}) {
  const registryPath = teamRegistryPath(home);
  const teamsDir = path.join(teamiHomePaths({ home }).home, "teams");
  const removed = {
    registryPath,
    teamsDir,
    registryRemoved: fs.existsSync(registryPath),
    teamsDirRemoved: fs.existsSync(teamsDir),
  };
  fs.rmSync(registryPath, { force: true });
  fs.rmSync(teamsDir, { recursive: true, force: true });
  removePriorTeamRecoveryState(home);
  return removed;
}

export function mintTeamRef(name, existingIds = []) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("An explicit team name is required.");
  }
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_TEAM_REF_LENGTH)
    .replace(/-+$/g, "");
  if (!base) throw new Error("Team name must contain at least one ASCII letter or digit.");

  const existing = new Set([...existingIds].map((id) => String(id)));
  let candidate = base;
  let counter = 2;
  while (existing.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, MAX_TEAM_REF_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    counter += 1;
  }
  return candidate;
}

export function makeTeamRecord({
  teamRef,
  status = "setup_incomplete",
  adopterProvidedName = null,
  setupIncompleteCause = null,
  workspaceId = null,
  workspaceName = null,
  teamId = null,
  teamKey = null,
  teamName = null,
  teamNameLastSeenAt = null,
  provisionedByAgenticFactory = true,
  webhookId = null,
  cachePath = null,
  resources = [],
  policyProfile = "default",
  policyOverlayRef = null,
} = {}) {
  assertTeamRef(teamRef, "team_ref");
  const record = {
    id: teamRef,
    status,
    linear: {
      workspace_id: workspaceId,
      workspace_name: workspaceName,
      team_id: teamId,
      team_key: teamKey,
      team_name: teamName,
      team_name_last_seen_at: teamNameLastSeenAt,
      provisioned_by_teami: provisionedByAgenticFactory,
      webhook_id: webhookId,
      cache_path: cachePath || teamCacheRelativePath(teamRef),
    },
    resources,
    policy_profile: policyProfile,
    policy_overlay_ref: policyOverlayRef,
  };
  if (isNonEmptyString(adopterProvidedName)) record.adopter_provided_name = adopterProvidedName.trim();
  if (setupIncompleteCause) record.setup_incomplete_cause = setupIncompleteCause;
  validateTeamRecord(record, `teams[${teamRef}]`);
  return record;
}

export function upsertTeamRecord(registry, teamRecord) {
  validateTeamRecord(teamRecord, `teams[${teamRecord?.id || "unknown"}]`);
  const next = structuredClone(registry || emptyTeamRegistry());
  validateTeamRegistry(next);
  const existingIndex = next.teams.findIndex((team) => team.id === teamRecord.id);
  if (existingIndex === -1) next.teams.push(teamRecord);
  else next.teams[existingIndex] = teamRecord;
  validateTeamRegistry(next);
  return next;
}

export function updateTeamLinearLabels(registry, teamRef, { teamName, teamKey, seenAt } = {}) {
  const next = structuredClone(registry);
  validateTeamRegistry(next);
  const team = next.teams.find((candidate) => candidate.id === teamRef);
  if (!team) throw new Error(`Team not found: ${teamRef}`);
  if (teamName !== undefined) team.linear.team_name = teamName;
  if (teamKey !== undefined) team.linear.team_key = teamKey;
  if (seenAt !== undefined) team.linear.team_name_last_seen_at = seenAt;
  validateTeamRegistry(next);
  return next;
}

export function validateTeamRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Invalid team registry: document_not_object");
  }
  assertAllowedKeys(registry, TOP_LEVEL_KEYS, "registry");
  const failures = [];
  if (registry.schema_version !== TEAM_REGISTRY_SCHEMA_VERSION) failures.push("unsupported_schema_version");
  if (!Array.isArray(registry.teams)) failures.push("teams_not_array");

  const ids = new Set();
  const linearTeamIdentities = new Set();
  for (const [index, team] of (registry.teams || []).entries()) {
    try {
      validateTeamRecord(team, `teams[${index}]`);
      if (ids.has(team.id)) failures.push(`duplicate_team_ref:${team.id}`);
      ids.add(team.id);
      const workspaceId = team.linear?.workspace_id;
      const linearTeamId = team.linear?.team_id;
      if (workspaceId && linearTeamId) {
        const identity = `${workspaceId}:${linearTeamId}`;
        if (linearTeamIdentities.has(identity)) {
          failures.push(`duplicate_linear_team:${identity}`);
        }
        linearTeamIdentities.add(identity);
      }
    } catch (error) {
      failures.push(error.message.replace(/^Invalid team registry: /, ""));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid team registry: ${[...new Set(failures)].join(", ")}`);
  }
  return true;
}

function sameTeamRecord(first, second) {
  if (!first || !second) return first === second;
  return JSON.stringify(first) === JSON.stringify(second);
}

function validateTeamRecord(team, label) {
  if (!team || typeof team !== "object" || Array.isArray(team)) {
    throw new Error(`Invalid team registry: ${label}_not_object`);
  }
  assertAllowedKeys(team, TEAM_KEYS, label);
  assertTeamRef(team.id, `${label}.id`);
  if (!TEAM_LIFECYCLE_STATES.includes(team.status)) {
    throw new Error(`Invalid team registry: invalid_status:${team.id}`);
  }
  if (Object.hasOwn(team, "adopter_provided_name") && !isNonEmptyString(team.adopter_provided_name)) {
    throw new Error(`Invalid team registry: invalid_adopter_provided_name:${team.id}`);
  }
  validateSetupCause(team);
  validateLinearRecord(team, label);
  validateResourcesRecord(team.resources, label);
  if (!isNonEmptyString(team.policy_profile)) {
    throw new Error(`Invalid team registry: missing_policy_profile:${team.id}`);
  }
  if (team.policy_overlay_ref !== null && typeof team.policy_overlay_ref !== "string") {
    throw new Error(`Invalid team registry: invalid_policy_overlay_ref:${team.id}`);
  }
  if (team.linear.cache_path !== teamCacheRelativePath(team.id)) {
    throw new Error(`Invalid team registry: cache_path_team_mismatch:${team.id}`);
  }
  return true;
}

function validateSetupCause(team) {
  if (!Object.hasOwn(team, "setup_incomplete_cause")) return;
  if (team.status !== "setup_incomplete") {
    throw new Error(`Invalid team registry: setup_cause_requires_setup_incomplete:${team.id}`);
  }
  if (!SETUP_INCOMPLETE_CAUSES.includes(team.setup_incomplete_cause)) {
    throw new Error(`Invalid team registry: invalid_setup_incomplete_cause:${team.id}`);
  }
}

function validateLinearRecord(team, label) {
  const linear = team.linear;
  if (!linear || typeof linear !== "object" || Array.isArray(linear)) {
    throw new Error(`Invalid team registry: missing_linear:${team.id}`);
  }
  assertAllowedKeys(linear, LINEAR_KEYS, `${label}.linear`);
  if (typeof linear.provisioned_by_teami !== "boolean") {
    throw new Error(`Invalid team registry: invalid_provisioned_flag:${team.id}`);
  }
  if (!isNonEmptyString(linear.cache_path)) {
    throw new Error(`Invalid team registry: missing_cache_path:${team.id}`);
  }
  if (linear.workspace_name !== null && typeof linear.workspace_name !== "string") {
    throw new Error(`Invalid team registry: invalid_workspace_name:${team.id}`);
  }
  if (linear.team_name_last_seen_at !== null && typeof linear.team_name_last_seen_at !== "string") {
    throw new Error(`Invalid team registry: invalid_team_name_last_seen_at:${team.id}`);
  }
  if (team.status === "active") {
    for (const field of ["workspace_id", "team_id", "team_key", "team_name"]) {
      if (!isNonEmptyString(linear[field])) {
        throw new Error(`Invalid team registry: active_team_missing_${field}:${team.id}`);
      }
    }
  }
}

function validateResourcesRecord(resources, label) {
  if (!Array.isArray(resources)) {
    throw new Error("Invalid team registry: resources_not_array");
  }

  const ids = new Set();
  const kinds = new Set();
  for (const [index, resource] of resources.entries()) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw new Error(`Invalid team registry: resources_entry_not_object:${index}`);
    }
    assertAllowedKeys(resource, RESOURCE_KEYS, `${label}.resources[${index}]`);
    for (const field of ["id", "kind", "role"]) {
      if (!isNonEmptyString(resource[field])) {
        throw new Error(`Invalid team registry: resources_missing_${field}:${index}`);
      }
    }
    if (!resource.binding || typeof resource.binding !== "object" || Array.isArray(resource.binding)) {
      throw new Error(`Invalid team registry: resources_binding_not_object:${index}`);
    }
    if (ids.has(resource.id)) {
      throw new Error(`Invalid team registry: resources_duplicate_id:${resource.id}`);
    }
    ids.add(resource.id);
    if (resource.kind !== "git_repo" && kinds.has(resource.kind)) {
      throw new Error(`Invalid team registry: resources_duplicate_kind:${resource.kind}`);
    }
    kinds.add(resource.kind);

    try {
      getResourceKind(resource.kind).validateBinding(resource.binding);
    } catch (error) {
      const reason = error?.message?.replace(/^Invalid team registry: /, "") || String(error);
      throw new Error(`Invalid team registry: ${reason}`);
    }
  }
}

function assertTeamRef(teamRef, label) {
  if (!isNonEmptyString(teamRef) || !TEAM_REF_PATTERN.test(teamRef)) {
    throw new Error(`Invalid team registry: invalid_team_ref:${label}`);
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid team registry: unknown_key:${label}.${key}`);
    }
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function migrateTeamCachePaths(registry) {
  const next = structuredClone(registry);
  if (!Array.isArray(next.teams)) return next;
  for (const team of next.teams) {
    if (!team?.linear || !isNonEmptyString(team.id)) continue;
    const legacy = path.join(".teami", "teams", team.id, "linear.json").replace(/\\/g, "/");
    if (team.linear.cache_path === legacy) {
      team.linear.cache_path = teamCacheRelativePath(team.id);
    }
  }
  return next;
}

function stripLegacyTeamiPrefix(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  return normalized === ".teami"
    ? "."
    : normalized.startsWith(".teami/")
      ? normalized.slice(".teami/".length)
      : normalized;
}

function renameWithRetry(tempPath, filePath) {
  const retryable = new Set(["EPERM", "EACCES"]);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error.code)) break;
    }
  }
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  throw lastError;
}

function acquireTeamRegistryLock(registryPath, purpose) {
  return acquireExclusiveFileLock({
    lockPath: `${registryPath}.migration.lock`,
    purpose,
  });
}

function readPublishedTeamRegistry(registryPath) {
  const registry = migrateTeamRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
  validateTeamRegistry(registry);
  return registry;
}

function writeTeamRegistryUnderLock({ registryPath, registry }) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileAndFsync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx" });
    validateTeamRegistry(JSON.parse(fs.readFileSync(tempPath, "utf8")));
    renameWithRetry(tempPath, registryPath);
    fsyncDirectoryAfterRename(path.dirname(registryPath), { committedFilePath: registryPath });
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  const readBack = readPublishedTeamRegistry(registryPath);
  if (JSON.stringify(readBack) !== JSON.stringify(registry)) {
    throw new Error(`Team registry read-back validation failed: ${registryPath}`);
  }
  return registryPath;
}
