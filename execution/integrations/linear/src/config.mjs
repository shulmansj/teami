import fs from "node:fs";
import path from "node:path";

import "./workflows/decomposition/definition.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";
import {
  resolveAcceptedRefForTarget,
  RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
} from "../../../engine/run-accepted-refs.mjs";
import { resolveAcceptedBaseline } from "./promotion-scanner/accepted-baseline.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "./workflows/decomposition/eval-paths.mjs";

export { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";

export const DEFAULT_CONFIG_PATH = path.join(
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
export const ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH = DECOMPOSITION_EVAL_PATHS.accepted_runtime;

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const ACCEPTED_RUNTIME_ROLES_SCHEMA_VERSION = "agentic-factory-accepted-runtime-roles/v1";
const DECOMPOSITION_WORKFLOW_TYPE = "decomposition";
const CONFIG_SHAPE_OUTDATED_MESSAGE =
  "config_shape_outdated: move decomposition.runtime.adapters to runtime.adapters, decomposition.runtime.default_invocation to runtime.default_invocation, and decomposition.runtime.roles to workflows.decomposition.roles (see maintainers/contracts/workflow-definition.md).";
const RUNTIME_ROLE_FIELDS = Object.freeze(["runtime", "model"]);
const RUNTIME_ROLE_SOURCE_ADOPTER_CONFIG = "adopter_config";
const RUNTIME_ROLE_SOURCE_ACCEPTED_DEFAULTS = "accepted_defaults";
export const UNPINNED_RUNTIME_DEV_FLAG = "AGENTIC_FACTORY_ALLOW_UNPINNED_RUNTIME";

export function loadLinearConfig({
  repoRoot = process.cwd(),
  configPath = process.env.AGENTIC_FACTORY_LINEAR_CONFIG,
} = {}) {
  const resolvedPath = path.resolve(repoRoot, configPath || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Linear config not found: ${resolvedPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  validateLinearConfig(parsed, resolvedPath, { repoRoot });
  return parsed;
}

export function validateLinearConfig(
  config,
  source = "config",
  {
    repoRoot = process.cwd(),
    acceptedRuntimeRolesPath = ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
    moduleRootFallback = true,
    env = process.env,
  } = {},
) {
  assertCurrentConfigShape(config);
  const linear = config?.linear;
  const inbox = config?.inbox;
  const oauth = linear?.oauth;
  const runtime = resolveWorkflowRuntime(config, DECOMPOSITION_WORKFLOW_TYPE);
  const workflow = config?.workflows?.[DECOMPOSITION_WORKFLOW_TYPE];
  const workflowRoleNames = roleNamesForWorkflow(DECOMPOSITION_WORKFLOW_TYPE);
  const missing = [];

  if (!oauth?.client_id) missing.push("linear.oauth.client_id");
  if (!oauth?.redirect_uri) missing.push("linear.oauth.redirect_uri");
  if (!Array.isArray(oauth?.scopes) || oauth.scopes.length === 0) {
    missing.push("linear.oauth.scopes");
  }
  if (!oauth?.actor) missing.push("linear.oauth.actor");
  if (!oauth?.credential_storage) missing.push("linear.oauth.credential_storage");
  if (!linear?.team?.key) missing.push("linear.team.key");
  if (!linear?.team?.name) missing.push("linear.team.name");
  if (!linear?.project?.labels?.has_open_questions) {
    missing.push("linear.project.labels.has_open_questions");
  }
  if (!linear?.issue?.labels?.discovery) missing.push("linear.issue.labels.discovery");
  if (!linear?.project?.status_types?.backlog) {
    missing.push("linear.project.status_types.backlog");
  }
  if (!linear?.project?.status_types?.planned) {
    missing.push("linear.project.status_types.planned");
  }
  if (!linear?.project?.status_types?.started) {
    missing.push("linear.project.status_types.started");
  }
  if (!linear?.project?.template_name) {
    missing.push("linear.project.template_name");
  }
  if (!inbox?.base_url) missing.push("inbox.base_url");
  if (!inbox?.webhook_url) missing.push("inbox.webhook_url");
  if (!inbox?.dashboard_url) missing.push("inbox.dashboard_url");
  if (!inbox?.credential_storage) missing.push("inbox.credential_storage");
  if (!inbox?.linear?.webhook_label) missing.push("inbox.linear.webhook_label");
  if (!Array.isArray(inbox?.linear?.resource_types) || inbox.linear.resource_types.length === 0) {
    missing.push("inbox.linear.resource_types");
  }
  if (!Array.isArray(inbox?.runner?.required_capabilities) || inbox.runner.required_capabilities.length === 0) {
    missing.push("inbox.runner.required_capabilities");
  }
  if (!workflow) missing.push(`workflows.${DECOMPOSITION_WORKFLOW_TYPE}`);
  if (!workflow?.roles || typeof workflow.roles !== "object" || Array.isArray(workflow.roles)) {
    missing.push(`workflows.${DECOMPOSITION_WORKFLOW_TYPE}.roles`);
  } else {
    validateRoleKeySet({
      roles: workflow.roles,
      expectedRoleNames: workflowRoleNames,
      label: `workflows.${DECOMPOSITION_WORKFLOW_TYPE}.roles`,
      failures: missing,
    });
  }
  if (!Number.isInteger(inbox?.runner?.lease_duration_ms)) {
    missing.push("inbox.runner.lease_duration_ms");
  }
  if (!Number.isInteger(inbox?.runner?.heartbeat_stale_ms)) {
    missing.push("inbox.runner.heartbeat_stale_ms");
  }
  if (missing.length > 0) {
    throw new Error(`${source} is missing required fields: ${missing.join(", ")}`);
  }

  validateOAuthConfig(oauth, source);
  validateInboxConfig(inbox, source);

  if (
    runtime?.default_invocation &&
    !["session_start", "warm_required"].includes(runtime.default_invocation)
  ) {
    throw new Error(
      `${source} has unsupported runtime.default_invocation=${runtime.default_invocation}; expected session_start.`,
    );
  }

  resolveRuntimeRoleFields(config, {
    source,
    repoRoot,
    acceptedRuntimeRolesPath,
    moduleRootFallback,
    workflowType: DECOMPOSITION_WORKFLOW_TYPE,
    workflowRoleNames,
    allowUnpinnedRuntimeOverrides: unpinnedRuntimeDevFlagEnabled(env),
  });

  for (const role of workflowRoleNames) {
    const roleRuntime = runtime.roles[role].runtime;
    if (!["codex", "claude"].includes(roleRuntime)) {
      throw new Error(`${source} has unsupported runtime for ${role}: ${roleRuntime}`);
    }
  }

  return true;
}

export function loadAcceptedRuntimeRoleDefaults({
  repoRoot = process.cwd(),
  acceptedRuntimeRolesPath = ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
  moduleRootFallback = true,
} = {}) {
  const resolution = resolveAcceptedRuntimeRoleDefaults({
    repoRoot,
    acceptedRuntimeRolesPath,
    moduleRootFallback,
  });
  if (!resolution.ok) {
    throw new Error(
      `${resolution.reason}: ${resolution.relative_path || acceptedRuntimeRolesPath}`,
    );
  }
  return resolution;
}

export function validateAcceptedRuntimeRoleDefaults(defaults, source = ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH) {
  const failures = [];
  requireExactKeys(defaults, ["schema_version", "_note", "roles"], source, failures);
  if (defaults?.schema_version !== ACCEPTED_RUNTIME_ROLES_SCHEMA_VERSION) {
    failures.push(`${source}.schema_version`);
  }
  if (typeof defaults?._note !== "string" || defaults._note.trim() === "") {
    failures.push(`${source}._note`);
  }
  const roleNames = acceptedRuntimeRoleNames(
    defaults?.roles,
    source,
    failures,
    roleNamesForWorkflow(DECOMPOSITION_WORKFLOW_TYPE),
  );
  for (const role of roleNames) {
    const roleDefaults = defaults?.roles?.[role];
    requireExactKeys(roleDefaults, RUNTIME_ROLE_FIELDS, `${source}.roles.${role}`, failures);
    if (typeof roleDefaults?.runtime !== "string" || roleDefaults.runtime.trim() === "") {
      failures.push(`${source}.roles.${role}.runtime`);
    } else if (!["codex", "claude"].includes(roleDefaults.runtime)) {
      failures.push(`${source}.roles.${role}.runtime`);
    }
    if (typeof roleDefaults?.model !== "string" || roleDefaults.model.trim() === "") {
      failures.push(`${source}.roles.${role}.model`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`accepted_runtime_roles_invalid: ${failures.join(", ")}`);
  }
  return true;
}

function acceptedRuntimeRoleNames(
  roles,
  source,
  failures,
  expectedRoleNames = roleNamesForWorkflow(DECOMPOSITION_WORKFLOW_TYPE),
) {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    failures.push(`${source}.roles`);
    return expectedRoleNames;
  }
  validateRoleKeySet({
    roles,
    expectedRoleNames,
    label: `${source}.roles`,
    failures,
  });
  return Object.keys(roles).sort();
}

export function formatRuntimeRoleAssignmentsSection(config) {
  const runtime = resolveWorkflowRuntime(config, DECOMPOSITION_WORKFLOW_TYPE);
  const workflow = config?.workflows?.[DECOMPOSITION_WORKFLOW_TYPE] || {};
  const sources = workflow.role_field_sources || {};
  const lines = ["runtime role assignments:"];
  for (const role of roleNamesForWorkflow(DECOMPOSITION_WORKFLOW_TYPE)) {
    for (const field of RUNTIME_ROLE_FIELDS) {
      lines.push(
        `- ${role}.${field}: ${runtime.roles?.[role]?.[field] ?? "unresolved"} (${sources?.[role]?.[field] ?? "unknown"})`,
      );
    }
  }
  return lines;
}

export function assertRunnableHostedSetupConfig(config, source = "config") {
  const urls = {
    "inbox.base_url": config?.inbox?.base_url,
    "inbox.webhook_url": config?.inbox?.webhook_url,
    "inbox.dashboard_url": config?.inbox?.dashboard_url,
    "github.token_broker.base_url": config?.github?.token_broker?.base_url,
  };
  const reserved = Object.entries(urls)
    .filter(([, value]) => typeof value === "string" && isReservedInvalidHost(value))
    .map(([field]) => field);
  if (reserved.length > 0) {
    throw new Error(
      `hosted_setup_url_not_runnable: ${source} uses reserved .invalid hosted setup URL(s) for ${reserved.join(", ")}; configure a real hosted setup endpoint before running setup.`,
    );
  }
  return true;
}

export function cachePathForConfig(config, repoRoot = process.cwd()) {
  return path.resolve(repoRoot, config.linear.cache_path || ".agentic-factory/linear.json");
}

export function unpinnedRuntimeTraceAttributes(config, workflowType = DECOMPOSITION_WORKFLOW_TYPE) {
  const unpinnedRuntime = config?.workflows?.[workflowType]?.unpinned_runtime;
  if (!unpinnedRuntime || typeof unpinnedRuntime !== "object" || Array.isArray(unpinnedRuntime)) return {};
  if (Object.keys(unpinnedRuntime).length === 0) return {};
  return {
    "agentic_factory.unpinned_runtime": stableJsonValue(unpinnedRuntime),
  };
}

function resolveRuntimeRoleFields(
  config,
  {
    source,
    repoRoot,
    acceptedRuntimeRolesPath,
    moduleRootFallback,
    workflowType = DECOMPOSITION_WORKFLOW_TYPE,
    workflowRoleNames = roleNamesForWorkflow(workflowType),
    allowUnpinnedRuntimeOverrides = false,
  } = {},
) {
  const workflow = config?.workflows?.[workflowType];
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return;
  }
  if (!workflow.roles || typeof workflow.roles !== "object" || Array.isArray(workflow.roles)) {
    workflow.roles = {};
  }
  const runtime = resolveWorkflowRuntime(config, workflowType);
  const roles = workflow.roles;
  const engineOwnedEvaluatorRoles = engineOwnedEvaluatorRoleSet(workflowType, workflowRoleNames);

  const roleFieldSources = {};
  const unpinnedRuntime = {};
  let defaultsResolution = null;
  const acceptedDefaults = () => {
    if (defaultsResolution === null) {
      defaultsResolution = resolveAcceptedRuntimeRoleDefaults({
        repoRoot,
        acceptedRuntimeRolesPath,
        moduleRootFallback,
      });
    }
    return defaultsResolution.ok ? defaultsResolution.defaults : null;
  };

  for (const role of workflowRoleNames) {
    if (!roles[role] || typeof roles[role] !== "object" || Array.isArray(roles[role])) {
      roles[role] = {};
    }
    roleFieldSources[role] = {};
    for (const field of RUNTIME_ROLE_FIELDS) {
      const defaults = acceptedDefaults();
      const defaultValue = defaults?.roles?.[role]?.[field];
      if (!hasNonEmptyString(defaultValue)) {
        throw new Error(
          `runtime_role_unresolved:${role}.${field} - not in ${ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH}; stampable runtime/model fields must resolve from accepted defaults`,
        );
      }

      if (
        allowUnpinnedRuntimeOverrides
        && !engineOwnedEvaluatorRoles.has(role)
        && hasNonEmptyString(roles[role][field])
      ) {
        roleFieldSources[role][field] = RUNTIME_ROLE_SOURCE_ADOPTER_CONFIG;
        unpinnedRuntime[role] ||= {};
        unpinnedRuntime[role][field] = true;
        continue;
      }
      roles[role][field] = defaultValue;
      roleFieldSources[role][field] = RUNTIME_ROLE_SOURCE_ACCEPTED_DEFAULTS;
    }
  }

  Object.defineProperty(workflow, "role_field_sources", {
    value: roleFieldSources,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(workflow, "unpinned_runtime", {
    value: Object.keys(unpinnedRuntime).length > 0 ? unpinnedRuntime : null,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  // Capture-at-load (B-REFS) for the runtime-role defaults: the moment this run
  // resolves ANY role field from the accepted defaults, record which accepted
  // version it read — resolved NOW, against the manifest as pinned at config
  // load, not re-resolved at run finalize (a competing mid-run merge to these
  // defaults would otherwise be mis-recorded as the consumed version). Stashed
  // for `collectRunAcceptedRefs` to attach; null when no field used the defaults
  // or the version could not be resolved (B-READ then degrades to `unknown`).
  //
  // Config validation runs at run START, before any phase executes, under the
  // single-orchestrator model (one run mutates the accepted artifacts at a time).
  // So the values read above and this version pin are consistent: no concurrent
  // writer mutates the accepted-runtime artifacts between the reads. The closed
  // race was the long finalize window; this load-time read carries no practical
  // race under single-tenancy.
  const consumedAcceptedDefaults = Object.values(roleFieldSources).some((fields) =>
    Object.values(fields).some((src) => src === RUNTIME_ROLE_SOURCE_ACCEPTED_DEFAULTS));
  const acceptedRuntimeDefaultsRef = consumedAcceptedDefaults
    ? resolveAcceptedRefForTarget({
        targetKey: RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
        repoRoot,
        definition: getWorkflowDefinition(workflowType),
        resolveAcceptedBaseline,
      })
    : null;
  Object.defineProperty(workflow, "accepted_runtime_defaults_ref", {
    value: acceptedRuntimeDefaultsRef,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function assertCurrentConfigShape(config) {
  if (config?.decomposition?.runtime || !config?.runtime || !config?.workflows) {
    throw new Error(CONFIG_SHAPE_OUTDATED_MESSAGE);
  }
}

function roleNamesForWorkflow(workflowType) {
  return getWorkflowDefinition(workflowType).roles;
}

function engineOwnedEvaluatorRoleSet(workflowType, workflowRoleNames) {
  const definition = getWorkflowDefinition(workflowType);
  const runtimeRoles = new Set(workflowRoleNames);
  return new Set(
    (definition.engine_owned_evaluator_roles || [])
      .filter((role) => runtimeRoles.has(role)),
  );
}

function unpinnedRuntimeDevFlagEnabled(env = process.env) {
  const value = env?.[UNPINNED_RUNTIME_DEV_FLAG];
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function validateRoleKeySet({ roles, expectedRoleNames, label, failures }) {
  const actual = Object.keys(roles).sort();
  const expected = [...expectedRoleNames].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failures.push(`${label} keys`);
  }
}

function resolveAcceptedRuntimeRoleDefaults({
  repoRoot,
  acceptedRuntimeRolesPath = ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
  moduleRootFallback = true,
} = {}) {
  const candidates = [];
  if (path.isAbsolute(acceptedRuntimeRolesPath)) {
    candidates.push(acceptedRuntimeRolesPath);
  } else {
    candidates.push(path.resolve(repoRoot || process.cwd(), acceptedRuntimeRolesPath));
    if (moduleRootFallback) {
      candidates.push(path.resolve(MODULE_REPO_ROOT, acceptedRuntimeRolesPath));
    }
  }

  for (const candidatePath of [...new Set(candidates)]) {
    if (!fs.existsSync(candidatePath)) continue;
    let parsed;
    try {
  // Phoenix manifest drift for this file is pinned by eval-contracts.test.mjs; config loading only resolves defaults.
      parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    } catch (error) {
      throw new Error(`accepted_runtime_roles_json_unparseable:${candidatePath} - ${error.message}`);
    }
    validateAcceptedRuntimeRoleDefaults(parsed, candidatePath);
    return {
      ok: true,
      defaults: parsed,
      path: candidatePath,
      relative_path: acceptedRuntimeRolesPath,
    };
  }
  return {
    ok: false,
    reason: "accepted_runtime_roles_not_found",
    relative_path: acceptedRuntimeRolesPath,
  };
}

function requireExactKeys(value, expectedKeys, label, failures) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(label);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failures.push(`${label} keys`);
  }
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function validateOAuthConfig(oauth, source) {
  const redirect = parseRedirectUri(oauth.redirect_uri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") {
    throw new Error(`${source} must use a loopback Linear OAuth redirect on http://127.0.0.1.`);
  }
  if (redirect.port !== "8723" || redirect.pathname !== "/linear/oauth/callback") {
    throw new Error(
      `${source} must use Linear OAuth redirect_uri=http://127.0.0.1:8723/linear/oauth/callback.`,
    );
  }

  const scopes = new Set(oauth.scopes);
  for (const requiredScope of ["read", "write", "admin"]) {
    if (!scopes.has(requiredScope)) {
      throw new Error(`${source} must request Linear OAuth scope ${requiredScope}.`);
    }
  }

  if (oauth.actor !== "user") {
    throw new Error(`${source} must use Linear OAuth actor=user for local setup.`);
  }

  if (!["os", "file"].includes(oauth.credential_storage)) {
    throw new Error(`${source} has unsupported Linear OAuth credential_storage: ${oauth.credential_storage}`);
  }
}

function validateInboxConfig(inbox, source) {
  for (const [field, value] of Object.entries({
    "inbox.base_url": inbox.base_url,
    "inbox.webhook_url": inbox.webhook_url,
    "inbox.dashboard_url": inbox.dashboard_url,
  })) {
    const parsed = parseUrl(value, field);
    if (parsed.protocol !== "https:") {
      throw new Error(`${source} ${field} must be an HTTPS URL for the hosted inbox.`);
    }
  }

  if (!["os", "file"].includes(inbox.credential_storage)) {
    throw new Error(`${source} has unsupported inbox credential_storage: ${inbox.credential_storage}`);
  }
  if (inbox.runner.lease_duration_ms < 30_000) {
    throw new Error(`${source} inbox.runner.lease_duration_ms must be at least 30000.`);
  }
  if (inbox.runner.heartbeat_stale_ms < 30_000) {
    throw new Error(`${source} inbox.runner.heartbeat_stale_ms must be at least 30000.`);
  }
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
}

function parseRedirectUri(redirectUri) {
  try {
    return new URL(redirectUri);
  } catch {
    throw new Error("Linear OAuth redirect_uri must be a valid URL.");
  }
}

function isReservedInvalidHost(value) {
  try {
    return new URL(value).hostname.endsWith(".invalid");
  } catch {
    return false;
  }
}
