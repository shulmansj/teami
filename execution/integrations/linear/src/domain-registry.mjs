import fs from "node:fs";
import path from "node:path";

import { getResourceKind } from "../../../engine/resource-registry.mjs";

export const DOMAIN_REGISTRY_SCHEMA_VERSION_V1 = "teami-domain-registry/v1";
export const DOMAIN_REGISTRY_SCHEMA_VERSION = "teami-domain-registry/v2";
export const DOMAIN_REGISTRY_SCHEMA_VERSIONS_SUPPORTED_FOR_MIGRATION = Object.freeze([
  DOMAIN_REGISTRY_SCHEMA_VERSION_V1,
]);
export const DOMAIN_REGISTRY_RELATIVE_PATH = path.join(".teami", "domains.json");
export const DOMAIN_LIFECYCLE_STATES = Object.freeze([
  "setup_incomplete",
  "active",
  "paused",
  "removed",
]);
export const DOMAIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DOMAIN_ID_LENGTH = 48;
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
const TOP_LEVEL_KEYS = new Set(["schema_version", "domains"]);
const DOMAIN_KEYS = new Set([
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

export function domainRegistryPath(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, DOMAIN_REGISTRY_RELATIVE_PATH);
}

export function domainCacheRelativePath(domainId) {
  assertDomainId(domainId, "domain_id");
  return path.join(".teami", "domains", domainId, "linear.json").replace(/\\/g, "/");
}

export function domainCachePath({ repoRoot = process.cwd(), domainId, cachePath = null } = {}) {
  const relativePath = cachePath || domainCacheRelativePath(domainId);
  return path.resolve(repoRoot, relativePath);
}

export function emptyDomainRegistry() {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [],
  };
}

export function readDomainRegistry({ repoRoot = process.cwd(), registryPath = domainRegistryPath(repoRoot) } = {}) {
  if (!fs.existsSync(registryPath)) return null;
  const registry = migrateDomainRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
  validateDomainRegistry(registry);
  return registry;
}

export function migrateDomainRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return registry;
  if (registry.schema_version === DOMAIN_REGISTRY_SCHEMA_VERSION) return registry;
  // Future structural registry transforms belong here so reads have one migration path.
  if (DOMAIN_REGISTRY_SCHEMA_VERSIONS_SUPPORTED_FOR_MIGRATION.includes(registry.schema_version)) {
    return { ...registry, schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION };
  }
  return registry;
}

export function writeDomainRegistry(
  { repoRoot = process.cwd(), registryPath = domainRegistryPath(repoRoot) } = {},
  registry,
) {
  validateDomainRegistry(registry);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  validateDomainRegistry(JSON.parse(fs.readFileSync(tempPath, "utf8")));
  renameWithRetry(tempPath, registryPath);
  const readBack = readDomainRegistry({ repoRoot, registryPath });
  if (JSON.stringify(readBack) !== JSON.stringify(registry)) {
    throw new Error("Domain registry read-back validation failed.");
  }
  return registryPath;
}

export function removeDomainRegistryState({ repoRoot = process.cwd() } = {}) {
  const registryPath = domainRegistryPath(repoRoot);
  const domainsDir = path.resolve(repoRoot, ".teami", "domains");
  const removed = {
    registryPath,
    domainsDir,
    registryRemoved: fs.existsSync(registryPath),
    domainsDirRemoved: fs.existsSync(domainsDir),
  };
  fs.rmSync(registryPath, { force: true });
  fs.rmSync(domainsDir, { recursive: true, force: true });
  return removed;
}

export function mintDomainId(name, existingIds = []) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("An explicit domain name is required.");
  }
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_DOMAIN_ID_LENGTH)
    .replace(/-+$/g, "");
  if (!base) throw new Error("Domain name must contain at least one ASCII letter or digit.");

  const existing = new Set([...existingIds].map((id) => String(id)));
  let candidate = base;
  let counter = 2;
  while (existing.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, MAX_DOMAIN_ID_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    counter += 1;
  }
  return candidate;
}

export function makeDomainRecord({
  domainId,
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
  assertDomainId(domainId, "domain_id");
  const record = {
    id: domainId,
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
      cache_path: cachePath || domainCacheRelativePath(domainId),
    },
    resources,
    policy_profile: policyProfile,
    policy_overlay_ref: policyOverlayRef,
  };
  if (isNonEmptyString(adopterProvidedName)) record.adopter_provided_name = adopterProvidedName.trim();
  if (setupIncompleteCause) record.setup_incomplete_cause = setupIncompleteCause;
  validateDomainRecord(record, `domains[${domainId}]`);
  return record;
}

export function upsertDomainRecord(registry, domainRecord) {
  validateDomainRecord(domainRecord, `domains[${domainRecord?.id || "unknown"}]`);
  const next = structuredClone(registry || emptyDomainRegistry());
  validateDomainRegistry(next);
  const existingIndex = next.domains.findIndex((domain) => domain.id === domainRecord.id);
  if (existingIndex === -1) next.domains.push(domainRecord);
  else next.domains[existingIndex] = domainRecord;
  validateDomainRegistry(next);
  return next;
}

export function updateDomainLinearLabels(registry, domainId, { teamName, teamKey, seenAt } = {}) {
  const next = structuredClone(registry);
  validateDomainRegistry(next);
  const domain = next.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`Domain not found: ${domainId}`);
  if (teamName !== undefined) domain.linear.team_name = teamName;
  if (teamKey !== undefined) domain.linear.team_key = teamKey;
  if (seenAt !== undefined) domain.linear.team_name_last_seen_at = seenAt;
  validateDomainRegistry(next);
  return next;
}

export function validateDomainRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Invalid domain registry: document_not_object");
  }
  assertAllowedKeys(registry, TOP_LEVEL_KEYS, "registry");
  const failures = [];
  if (registry.schema_version !== DOMAIN_REGISTRY_SCHEMA_VERSION) failures.push("unsupported_schema_version");
  if (!Array.isArray(registry.domains)) failures.push("domains_not_array");

  const ids = new Set();
  for (const [index, domain] of (registry.domains || []).entries()) {
    try {
      validateDomainRecord(domain, `domains[${index}]`);
      if (ids.has(domain.id)) failures.push(`duplicate_domain_id:${domain.id}`);
      ids.add(domain.id);
    } catch (error) {
      failures.push(error.message.replace(/^Invalid domain registry: /, ""));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid domain registry: ${[...new Set(failures)].join(", ")}`);
  }
  return true;
}

function validateDomainRecord(domain, label) {
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    throw new Error(`Invalid domain registry: ${label}_not_object`);
  }
  assertAllowedKeys(domain, DOMAIN_KEYS, label);
  assertDomainId(domain.id, `${label}.id`);
  if (!DOMAIN_LIFECYCLE_STATES.includes(domain.status)) {
    throw new Error(`Invalid domain registry: invalid_status:${domain.id}`);
  }
  if (Object.hasOwn(domain, "adopter_provided_name") && !isNonEmptyString(domain.adopter_provided_name)) {
    throw new Error(`Invalid domain registry: invalid_adopter_provided_name:${domain.id}`);
  }
  validateSetupCause(domain);
  validateLinearRecord(domain, label);
  validateResourcesRecord(domain.resources, label);
  if (!isNonEmptyString(domain.policy_profile)) {
    throw new Error(`Invalid domain registry: missing_policy_profile:${domain.id}`);
  }
  if (domain.policy_overlay_ref !== null && typeof domain.policy_overlay_ref !== "string") {
    throw new Error(`Invalid domain registry: invalid_policy_overlay_ref:${domain.id}`);
  }
  if (domain.linear.cache_path !== domainCacheRelativePath(domain.id)) {
    throw new Error(`Invalid domain registry: cache_path_domain_mismatch:${domain.id}`);
  }
  return true;
}

function validateSetupCause(domain) {
  if (!Object.hasOwn(domain, "setup_incomplete_cause")) return;
  if (domain.status !== "setup_incomplete") {
    throw new Error(`Invalid domain registry: setup_cause_requires_setup_incomplete:${domain.id}`);
  }
  if (!SETUP_INCOMPLETE_CAUSES.includes(domain.setup_incomplete_cause)) {
    throw new Error(`Invalid domain registry: invalid_setup_incomplete_cause:${domain.id}`);
  }
}

function validateLinearRecord(domain, label) {
  const linear = domain.linear;
  if (!linear || typeof linear !== "object" || Array.isArray(linear)) {
    throw new Error(`Invalid domain registry: missing_linear:${domain.id}`);
  }
  assertAllowedKeys(linear, LINEAR_KEYS, `${label}.linear`);
  if (typeof linear.provisioned_by_teami !== "boolean") {
    throw new Error(`Invalid domain registry: invalid_provisioned_flag:${domain.id}`);
  }
  if (!isNonEmptyString(linear.cache_path)) {
    throw new Error(`Invalid domain registry: missing_cache_path:${domain.id}`);
  }
  if (linear.workspace_name !== null && typeof linear.workspace_name !== "string") {
    throw new Error(`Invalid domain registry: invalid_workspace_name:${domain.id}`);
  }
  if (linear.team_name_last_seen_at !== null && typeof linear.team_name_last_seen_at !== "string") {
    throw new Error(`Invalid domain registry: invalid_team_name_last_seen_at:${domain.id}`);
  }
  if (domain.status === "active") {
    for (const field of ["workspace_id", "team_id", "team_key", "team_name"]) {
      if (!isNonEmptyString(linear[field])) {
        throw new Error(`Invalid domain registry: active_domain_missing_${field}:${domain.id}`);
      }
    }
  }
}

function validateResourcesRecord(resources, label) {
  if (!Array.isArray(resources)) {
    throw new Error("Invalid domain registry: resources_not_array");
  }

  const ids = new Set();
  const kinds = new Set();
  for (const [index, resource] of resources.entries()) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw new Error(`Invalid domain registry: resources_entry_not_object:${index}`);
    }
    assertAllowedKeys(resource, RESOURCE_KEYS, `${label}.resources[${index}]`);
    for (const field of ["id", "kind", "role"]) {
      if (!isNonEmptyString(resource[field])) {
        throw new Error(`Invalid domain registry: resources_missing_${field}:${index}`);
      }
    }
    if (!resource.binding || typeof resource.binding !== "object" || Array.isArray(resource.binding)) {
      throw new Error(`Invalid domain registry: resources_binding_not_object:${index}`);
    }
    if (ids.has(resource.id)) {
      throw new Error(`Invalid domain registry: resources_duplicate_id:${resource.id}`);
    }
    ids.add(resource.id);
    if (resource.kind !== "git_repo" && kinds.has(resource.kind)) {
      throw new Error(`Invalid domain registry: resources_duplicate_kind:${resource.kind}`);
    }
    kinds.add(resource.kind);

    try {
      getResourceKind(resource.kind).validateBinding(resource.binding);
    } catch (error) {
      const reason = error?.message?.replace(/^Invalid domain registry: /, "") || String(error);
      throw new Error(`Invalid domain registry: ${reason}`);
    }
  }
}

function assertDomainId(domainId, label) {
  if (!isNonEmptyString(domainId) || !DOMAIN_ID_PATTERN.test(domainId)) {
    throw new Error(`Invalid domain registry: invalid_domain_id:${label}`);
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid domain registry: unknown_key:${label}.${key}`);
    }
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
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
