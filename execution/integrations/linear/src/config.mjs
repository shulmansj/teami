import fs from "node:fs";
import path from "node:path";

import "./workflows/decomposition/definition.mjs";
import {
  getWorkflowDefinition,
  registeredWorkflowTypes,
} from "../../../engine/workflow-registry.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";
import {
  resolveAcceptedRefForTarget,
  RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
} from "../../../engine/run-accepted-refs.mjs";
import { resolveAcceptedBaseline } from "./promotion-scanner/accepted-baseline.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "./workflows/decomposition/eval-paths.mjs";
import { resolvePackagedDefault, resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import {
  BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
  readCachedBehaviorConfigOverrides,
  syncBehaviorConfigOverrides,
} from "./behavior-config-pull.mjs";

export { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";
export { BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH } from "./behavior-config-pull.mjs";

export const DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH = path.posix.join(
  "execution",
  "integrations",
  "linear",
  "config.package-default.json",
);
const DEV_CONFIG_PACKAGE_RELATIVE_PATH = path.posix.join(
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
// Prefer the identity-bearing dev/example config when it exists in the source tree (dev + tests);
// fall back to the identity-clean packaged default that ships in the npm tarball. config.example.json
// is deliberately excluded from the package `files` allowlist (F1), so it is absent for a repo-less
// adopter — there the packaged default (no client_id/github identity) is used.
export const DEFAULT_CONFIG_PATH = resolveDefaultConfigPath();
function resolveDefaultConfigPath() {
  const devDefault = resolvePackagedDefault(DEV_CONFIG_PACKAGE_RELATIVE_PATH);
  if (fs.existsSync(devDefault)) return devDefault;
  return resolvePackagedDefault(DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH);
}
export const ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH = DECOMPOSITION_EVAL_PATHS.accepted_runtime;

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const ACCEPTED_RUNTIME_ROLES_SCHEMA_VERSION = "teami-accepted-runtime-roles/v1";
const DECOMPOSITION_WORKFLOW_TYPE = "decomposition";
const CONFIG_SHAPE_OUTDATED_MESSAGE =
  "config_shape_outdated: move decomposition.runtime.adapters to runtime.adapters, decomposition.runtime.default_invocation to runtime.default_invocation, and decomposition.runtime.roles to workflows.decomposition.roles (see docs/contracts/workflow-definition.md).";
const REQUIRED_LINEAR_OAUTH_SCOPES = Object.freeze(["read", "write"]);
export const LINEAR_OAUTH_CALLBACK = Object.freeze({
  host: "127.0.0.1",
  pathname: "/linear/oauth/callback",
  // The public Linear OAuth application registers this exact redirect URI. Do not silently
  // fall back to an unregistered port: Linear rejects it before the local callback can run.
  portRange: Object.freeze({ start: 8723, end: 8723 }),
});
const RUNTIME_ROLE_FIELDS = Object.freeze(["runtime", "model"]);
const RUNTIME_ROLE_SOURCE_ADOPTER_CONFIG = "adopter_config";
const RUNTIME_ROLE_SOURCE_ACCEPTED_DEFAULTS = "accepted_defaults";
const PROJECT_STATUS_ROLES = Object.freeze(["backlog", "planned", "in_progress", "completed", "needs_principal"]);
const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);
export const BEHAVIOR_CONFIG_COMMIT_FIELD = "behavior_config_commit";
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const MIN_POLL_INTERVAL_MS = 2_000;
export const UNPINNED_RUNTIME_DEV_FLAG = "TEAMI_ALLOW_UNPINNED_RUNTIME";

export function loadLinearConfig({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  configPath = process.env.TEAMI_LINEAR_CONFIG,
  behaviorConfig = true,
  behaviorConfigPuller = readCachedBehaviorConfigOverrides,
} = {}) {
  const resolvedPath = resolveLinearConfigPath({ repoRoot, configPath });
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Linear config not found: ${resolvedPath}`);
  }

  const defaults = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const behavior = resolveBehaviorConfigForLoad({
    behaviorConfig,
    behaviorConfigPuller,
    home,
    repoRoot,
  });
  let parsed = defaults;
  let behaviorRuntimeRoleOverrides = null;
  if (behavior.overrides) {
    validateBehaviorOverrides(
      behavior.overrides,
      behavior.overridesPath || BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
      { defaults },
    );
    behaviorRuntimeRoleOverrides = collectBehaviorRuntimeRoleOverrides(behavior.overrides);
    parsed = mergeLinearConfigDefaults(defaults, behavior.overrides);
  }
  validateLinearConfig(parsed, resolvedPath, { repoRoot, behaviorRuntimeRoleOverrides });
  if (behavior.commit) {
    Object.defineProperty(parsed, BEHAVIOR_CONFIG_COMMIT_FIELD, {
      value: behavior.commit,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return parsed;
}

export async function loadLinearConfigAsync(options = {}) {
  const behaviorConfig = options.behaviorConfig ?? true;
  if (behaviorConfig === false || behaviorConfig === null) return loadLinearConfig(options);
  const behaviorConfigPuller = options.behaviorConfigPuller || syncBehaviorConfigOverrides;
  const pulled = await behaviorConfigPuller({
    ...normalizeBehaviorConfigOptions(behaviorConfig),
    home: options.home || resolveTeamiHome(),
    repoRoot: options.repoRoot || process.cwd(),
  });
  return loadLinearConfig({
    ...options,
    behaviorConfig,
    behaviorConfigPuller: () => pulled,
  });
}

export function validateLinearConfig(
  config,
  source = "config",
  {
    repoRoot = process.cwd(),
    acceptedRuntimeRolesPath = null,
    moduleRootFallback = true,
    env = process.env,
    behaviorRuntimeRoleOverrides = null,
  } = {},
) {
  assertCurrentConfigShape(config);
  applyPollDefaults(config);
  const linear = config?.linear;
  const oauth = linear?.oauth;
  const missing = [];

  // client_id is the single OAuth field the identity-clean packaged default legitimately omits: a
  // repo-less adopter has not registered/authorized the Linear app yet (see the DEFAULT_CONFIG_PATH
  // comment above). Treat its absence as an unconfigured — but valid — fresh-install state rather
  // than a fatal config-load error, so `teami doctor`/first-run report "not set up" instead of
  // crashing. The sign-in path (requiredOAuthConfig in linear-oauth.mjs) still enforces client_id at
  // OAuth time with a clear message. All other OAuth fields below ship in the packaged default.
  if (!oauth?.redirect_uri) missing.push("linear.oauth.redirect_uri");
  if (!Array.isArray(oauth?.scopes) || oauth.scopes.length === 0) {
    missing.push("linear.oauth.scopes");
  }
  if (!oauth?.actor) missing.push("linear.oauth.actor");
  if (!oauth?.credential_storage) missing.push("linear.oauth.credential_storage");
  if (!linear?.team?.key) missing.push("linear.team.key");
  if (!linear?.team?.name) missing.push("linear.team.name");
  if (!linear?.issue?.labels?.discovery) missing.push("linear.issue.labels.discovery");
  if (!linear?.issue?.labels?.human_review) missing.push("linear.issue.labels.human_review");
  collectStatusConfigMissingFields(linear?.project?.statuses, "linear.project.statuses", PROJECT_STATUS_ROLES, missing);
  if (!linear?.project?.template_name) {
    missing.push("linear.project.template_name");
  }
  const workflowRuntimeRoleValidations = registeredWorkflowTypes().map((workflowType) =>
    validateWorkflowRuntimeRoles(config, {
      source,
      repoRoot,
      moduleRootFallback,
      env,
      behaviorRuntimeRoleOverrides,
      workflowType,
      acceptedRuntimeRolesPath: acceptedRuntimeRolesPathForWorkflow(
        workflowType,
        acceptedRuntimeRolesPath,
      ),
    }),
  );
  for (const validation of workflowRuntimeRoleValidations) {
    missing.push(...validation.missing);
  }
  if (missing.length > 0) {
    throw new Error(`${source} is missing required fields: ${missing.join(", ")}`);
  }

  validateOAuthConfig(oauth, source);
  validatePollConfig(config.poll, source);
  validateIssueTargetConfig(linear.issue, source);

  for (const validation of workflowRuntimeRoleValidations) {
    validation.validateRuntimeRoles();
  }

  return true;
}

function validateWorkflowRuntimeRoles(
  config,
  {
    source,
    repoRoot,
    acceptedRuntimeRolesPath,
    moduleRootFallback,
    env,
    workflowType,
    behaviorRuntimeRoleOverrides,
  },
) {
  const runtime = resolveWorkflowRuntime(config, workflowType);
  const workflow = config?.workflows?.[workflowType];
  const workflowRoleNames = roleNamesForWorkflow(workflowType);
  const missing = [];

  if (!workflow) missing.push(`workflows.${workflowType}`);
  if (!workflow?.roles || typeof workflow.roles !== "object" || Array.isArray(workflow.roles)) {
    missing.push(`workflows.${workflowType}.roles`);
  } else {
    validateRoleKeySet({
      roles: workflow.roles,
      expectedRoleNames: workflowRoleNames,
      label: `workflows.${workflowType}.roles`,
      failures: missing,
    });
  }

  return {
    missing,
    validateRuntimeRoles() {
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
        workflowType,
        workflowRoleNames,
        allowUnpinnedRuntimeOverrides: unpinnedRuntimeDevFlagEnabled(env),
        behaviorRuntimeRoleOverrides,
      });

      for (const role of workflowRoleNames) {
        const roleRuntime = runtime.roles[role].runtime;
        if (!["codex", "claude"].includes(roleRuntime)) {
          throw new Error(`${source} has unsupported runtime for ${role}: ${roleRuntime}`);
        }
      }
    },
  };
}

export function loadAcceptedRuntimeRoleDefaults({
  repoRoot = process.cwd(),
  acceptedRuntimeRolesPath = null,
  moduleRootFallback = true,
  workflowType = DECOMPOSITION_WORKFLOW_TYPE,
} = {}) {
  const resolvedAcceptedRuntimeRolesPath = acceptedRuntimeRolesPathForWorkflow(
    workflowType,
    acceptedRuntimeRolesPath,
  );
  const resolution = resolveAcceptedRuntimeRoleDefaults({
    repoRoot,
    acceptedRuntimeRolesPath: resolvedAcceptedRuntimeRolesPath,
    moduleRootFallback,
    workflowType,
  });
  if (!resolution.ok) {
    throw new Error(
      `${resolution.reason}: ${resolution.relative_path || resolvedAcceptedRuntimeRolesPath}`,
    );
  }
  return resolution;
}

export function validateAcceptedRuntimeRoleDefaults(
  defaults,
  source = ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
  {
    workflowType = DECOMPOSITION_WORKFLOW_TYPE,
    expectedRoleNames = acceptedRuntimeRoleNamesForWorkflow(workflowType),
  } = {},
) {
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
    expectedRoleNames,
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

export function cachePathForConfig(config, home = resolveTeamiHome()) {
  const configuredPath = config?.linear?.cache_path || ".teami/linear.json";
  if (path.isAbsolute(configuredPath)) return path.normalize(configuredPath);
  return path.resolve(
    teamiHomePaths({ home }).home,
    stripLegacyTeamiPrefix(configuredPath),
  );
}

export function unpinnedRuntimeTraceAttributes(config, workflowType = DECOMPOSITION_WORKFLOW_TYPE) {
  const unpinnedRuntime = config?.workflows?.[workflowType]?.unpinned_runtime;
  if (!unpinnedRuntime || typeof unpinnedRuntime !== "object" || Array.isArray(unpinnedRuntime)) return {};
  if (Object.keys(unpinnedRuntime).length === 0) return {};
  return {
    "teami.unpinned_runtime": stableJsonValue(unpinnedRuntime),
  };
}

export function mergeLinearConfigDefaults(defaults, overrides) {
  if (overrides === null || overrides === undefined) return cloneEnumerableJsonValue(defaults);
  return mergeEnumerableJsonObjects(defaults, overrides);
}

export function validateBehaviorOverrides(
  overrides,
  source = BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
  { defaults = null } = {},
) {
  const failures = [];
  if (!isPlainObject(overrides)) {
    throw new Error(`${source} must be a JSON object.`);
  }
  const topLevelKeys = Object.keys(overrides);
  for (const key of topLevelKeys) {
    if (key !== "workflows") failures.push(`${source}.${key}`);
  }
  if (Object.hasOwn(overrides, "workflows")) {
    validateBehaviorOverrideWorkflows(
      overrides.workflows,
      `${source}.workflows`,
      failures,
      isPlainObject(defaults?.workflows) ? defaults.workflows : null,
    );
  }
  if (failures.length > 0) {
    throw new Error(`behavior_config_overrides_invalid: ${failures.join(", ")}`);
  }
  return true;
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
    behaviorRuntimeRoleOverrides = null,
  } = {},
) {
  const workflow = config?.workflows?.[workflowType];
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return;
  }
  if (!workflow.roles || typeof workflow.roles !== "object" || Array.isArray(workflow.roles)) {
    workflow.roles = {};
  }
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
        workflowType,
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
          `runtime_role_unresolved:${role}.${field} - not in ${acceptedRuntimeRolesLabelForWorkflow(workflowType)}; stampable runtime/model fields must resolve from accepted defaults`,
        );
      }

      if (
        (allowUnpinnedRuntimeOverrides || behaviorRoleFieldOverridden(behaviorRuntimeRoleOverrides, workflowType, role, field))
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
        targetKey: runtimeRoleDefaultsTargetKey(workflowType),
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

function resolveBehaviorConfigForLoad({
  behaviorConfig,
  behaviorConfigPuller,
  home,
  repoRoot,
}) {
  const options = normalizeBehaviorConfigOptions(behaviorConfig);
  if (!options) return { overrides: null, commit: null, overridesPath: null };
  if (typeof behaviorConfigPuller !== "function") {
    throw new Error("behavior_config_puller_required");
  }
  const result = behaviorConfigPuller({
    ...options,
    home,
    repoRoot,
  });
  if (!result || result.ok === false) {
    const reason = result?.reason || "behavior_config_unavailable";
    if (!options.required && optionalBehaviorConfigSkipReason(reason)) {
      return { overrides: null, commit: null, overridesPath: null };
    }
    throw new Error(`behavior_config_pull_failed:${reason}`);
  }
  return {
    overrides: result.overrides || null,
    commit: typeof result.commit === "string" && result.commit.trim() ? result.commit.trim() : null,
    overridesPath: result.overridesPath || null,
  };
}

function normalizeBehaviorConfigOptions(behaviorConfig) {
  if (behaviorConfig === false || behaviorConfig === null) return null;
  if (behaviorConfig === true || behaviorConfig === undefined) return {};
  if (isPlainObject(behaviorConfig)) return behaviorConfig;
  throw new Error("behavior_config_options_invalid");
}

function optionalBehaviorConfigSkipReason(reason) {
  return [
    "missing_github_connection_state",
    "github_connection_not_verified",
    "github_connection_not_real",
    "behavior_config_cache_missing",
  ].includes(reason);
}

function validateBehaviorOverrideWorkflows(workflows, label, failures, defaultWorkflows = null) {
  if (!isPlainObject(workflows)) {
    failures.push(label);
    return;
  }
  for (const [workflowType, workflow] of Object.entries(workflows)) {
    const workflowLabel = `${label}.${workflowType}`;
    const defaultWorkflow = defaultWorkflows?.[workflowType];
    if (defaultWorkflows && !isPlainObject(defaultWorkflow)) {
      failures.push(workflowLabel);
      continue;
    }
    if (!isPlainObject(workflow)) {
      failures.push(workflowLabel);
      continue;
    }
    const keys = Object.keys(workflow);
    for (const key of keys) {
      if (key !== "roles") failures.push(`${workflowLabel}.${key}`);
    }
    if (Object.hasOwn(workflow, "roles")) {
      validateBehaviorOverrideRoles(
        workflow.roles,
        `${workflowLabel}.roles`,
        failures,
        isPlainObject(defaultWorkflow?.roles) ? defaultWorkflow.roles : null,
      );
    }
  }
}

function validateBehaviorOverrideRoles(roles, label, failures, defaultRoles = null) {
  if (!isPlainObject(roles)) {
    failures.push(label);
    return;
  }
  for (const [role, fields] of Object.entries(roles)) {
    const roleLabel = `${label}.${role}`;
    if (defaultRoles && !Object.hasOwn(defaultRoles, role)) {
      failures.push(roleLabel);
      continue;
    }
    if (!isPlainObject(fields)) {
      failures.push(roleLabel);
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (!RUNTIME_ROLE_FIELDS.includes(field)) {
        failures.push(`${roleLabel}.${field}`);
      } else if (!hasNonEmptyString(value)) {
        failures.push(`${roleLabel}.${field}`);
      }
    }
  }
}

function collectBehaviorRuntimeRoleOverrides(overrides) {
  const workflows = overrides?.workflows;
  if (!isPlainObject(workflows)) return null;
  const collected = {};
  for (const [workflowType, workflow] of Object.entries(workflows)) {
    const roles = workflow?.roles;
    if (!isPlainObject(roles)) continue;
    for (const [role, fields] of Object.entries(roles)) {
      if (!isPlainObject(fields)) continue;
      for (const field of RUNTIME_ROLE_FIELDS) {
        if (!hasNonEmptyString(fields[field])) continue;
        collected[workflowType] ||= {};
        collected[workflowType][role] ||= {};
        collected[workflowType][role][field] = true;
      }
    }
  }
  return Object.keys(collected).length > 0 ? collected : null;
}

function behaviorRoleFieldOverridden(overrides, workflowType, role, field) {
  return overrides?.[workflowType]?.[role]?.[field] === true;
}

function mergeEnumerableJsonObjects(defaults, overrides) {
  if (isPlainObject(defaults) && isPlainObject(overrides)) {
    const merged = {};
    for (const key of Object.keys(defaults)) {
      merged[key] = cloneEnumerableJsonValue(defaults[key]);
    }
    for (const key of Object.keys(overrides)) {
      merged[key] = mergeEnumerableJsonObjects(merged[key], overrides[key]);
    }
    return merged;
  }
  return cloneEnumerableJsonValue(overrides);
}

function cloneEnumerableJsonValue(value) {
  if (Array.isArray(value)) return value.map(cloneEnumerableJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, cloneEnumerableJsonValue(value[key])]),
    );
  }
  return value;
}

function assertCurrentConfigShape(config) {
  if (config?.decomposition?.runtime || !config?.runtime || !config?.workflows) {
    throw new Error(CONFIG_SHAPE_OUTDATED_MESSAGE);
  }
}

function roleNamesForWorkflow(workflowType) {
  return getWorkflowDefinition(workflowType).roles;
}

function acceptedRuntimeRoleNamesForWorkflow(workflowType) {
  const definition = getWorkflowDefinition(workflowType);
  const workflowRoles = definition.roles || [];
  const evaluatorRoles = definition.engine_owned_evaluator_roles || [];
  const hasEvaluatorRuntimeRole = evaluatorRoles.some((role) => workflowRoles.includes(role));
  return [
    ...new Set([
      ...workflowRoles,
      ...(!hasEvaluatorRuntimeRole && evaluatorRoles[0] ? [evaluatorRoles[0]] : []),
    ]),
  ];
}

export function acceptedRuntimeRolesPathForWorkflow(workflowType, overridePath = null) {
  if (overridePath && typeof overridePath === "object" && !Array.isArray(overridePath)) {
    const workflowOverride = overridePath[workflowType];
    if (typeof workflowOverride === "string" && workflowOverride.trim() !== "") {
      return workflowOverride;
    }
  }
  if (typeof overridePath === "string" && overridePath.trim() !== "") {
    return overridePath;
  }
  return acceptedRuntimeRolesLabelForWorkflow(workflowType);
}

function acceptedRuntimeRolesLabelForWorkflow(workflowType) {
  return evalNamespacePaths(getWorkflowDefinition(workflowType)).accepted_runtime;
}

function runtimeRoleDefaultsTargetKey(workflowType) {
  return workflowType === DECOMPOSITION_WORKFLOW_TYPE
    ? RUNTIME_ROLE_DEFAULTS_TARGET_KEY
    : `rule/${workflowType}/runtime_role_assignments`;
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
  acceptedRuntimeRolesPath = null,
  moduleRootFallback = true,
  workflowType = DECOMPOSITION_WORKFLOW_TYPE,
} = {}) {
  const resolvedAcceptedRuntimeRolesPath = acceptedRuntimeRolesPathForWorkflow(
    workflowType,
    acceptedRuntimeRolesPath,
  );
  const candidates = [];
  if (path.isAbsolute(resolvedAcceptedRuntimeRolesPath)) {
    candidates.push(resolvedAcceptedRuntimeRolesPath);
  } else {
    candidates.push(path.resolve(repoRoot || process.cwd(), resolvedAcceptedRuntimeRolesPath));
    if (moduleRootFallback) {
      candidates.push(path.resolve(MODULE_REPO_ROOT, resolvedAcceptedRuntimeRolesPath));
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
    validateAcceptedRuntimeRoleDefaults(parsed, candidatePath, { workflowType });
    return {
      ok: true,
      defaults: parsed,
      path: candidatePath,
      relative_path: resolvedAcceptedRuntimeRolesPath,
    };
  }
  return {
    ok: false,
    reason: "accepted_runtime_roles_not_found",
    relative_path: resolvedAcceptedRuntimeRolesPath,
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

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
  if (redirect.protocol !== "http:" || redirect.hostname !== LINEAR_OAUTH_CALLBACK.host) {
    throw new Error(`${source} must use a loopback Linear OAuth redirect on http://${LINEAR_OAUTH_CALLBACK.host}.`);
  }
  if (
    redirect.pathname !== LINEAR_OAUTH_CALLBACK.pathname ||
    !isLinearOAuthCallbackPort(redirect.port)
  ) {
    throw new Error(
      `${source} must use Linear OAuth redirect_uri=http://${LINEAR_OAUTH_CALLBACK.host}:<port>${LINEAR_OAUTH_CALLBACK.pathname} with port ${linearOAuthCallbackPortRangeLabel()}.`,
    );
  }

  const scopes = new Set(oauth.scopes);
  for (const scope of scopes) {
    if (!REQUIRED_LINEAR_OAUTH_SCOPES.includes(scope)) {
      throw new Error(`${source} has unsupported Linear OAuth scope ${scope}.`);
    }
  }
  for (const requiredScope of REQUIRED_LINEAR_OAUTH_SCOPES) {
    if (!scopes.has(requiredScope)) {
      throw new Error(`${source} must request Linear OAuth scope ${requiredScope}.`);
    }
  }

  if (oauth.actor !== "app") {
    throw new Error(`${source} must use Linear OAuth actor=app; re-run \`npm run init\` to re-authorize as the app.`);
  }

  if (!["os", "file"].includes(oauth.credential_storage)) {
    throw new Error(`${source} has unsupported Linear OAuth credential_storage: ${oauth.credential_storage}`);
  }
}

function applyPollDefaults(config) {
  if (!Object.hasOwn(config || {}, "poll") || config.poll === undefined) {
    config.poll = {};
  }
  if (!config.poll || typeof config.poll !== "object" || Array.isArray(config.poll)) return;
  if (!Object.hasOwn(config.poll, "interval_ms") || config.poll.interval_ms === undefined) {
    config.poll.interval_ms = DEFAULT_POLL_INTERVAL_MS;
  }
}

function validatePollConfig(poll, source) {
  if (!poll || typeof poll !== "object" || Array.isArray(poll)) {
    throw new Error(`${source} poll must be an object.`);
  }
  const unknownKeys = Object.keys(poll).filter((key) => key !== "interval_ms");
  if (unknownKeys.length > 0) {
    throw new Error(
      `${source} has unsupported poll config field(s): ${unknownKeys.map((key) => `poll.${key}`).join(", ")}`,
    );
  }
  if (!Number.isInteger(poll.interval_ms)) {
    throw new Error(`${source} poll.interval_ms must be an integer.`);
  }
  if (poll.interval_ms < MIN_POLL_INTERVAL_MS) {
    throw new Error(`${source} poll.interval_ms must be at least ${MIN_POLL_INTERVAL_MS}.`);
  }
}

function validateIssueTargetConfig(issue, source) {
  for (const statusKey of ISSUE_STATUS_ROLES) {
    validateRequiredIssueStatus(issue, source, statusKey);
  }

  if (Object.hasOwn(issue?.labels || {}, "work_type_code") && !hasNonEmptyString(issue.labels.work_type_code)) {
    throw new Error(`${source} linear.issue.labels.work_type_code must be a non-empty string.`);
  }
  if (Object.hasOwn(issue?.labels || {}, "work_type_non_code") && !hasNonEmptyString(issue.labels.work_type_non_code)) {
    throw new Error(`${source} linear.issue.labels.work_type_non_code must be a non-empty string.`);
  }
  if (Object.hasOwn(issue?.labels || {}, "human_review") && !hasNonEmptyString(issue.labels.human_review)) {
    throw new Error(`${source} linear.issue.labels.human_review must be a non-empty string.`);
  }
}

function validateRequiredIssueStatus(issue, source, statusKey) {
  const status = issue?.statuses?.[statusKey];
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`${source} linear.issue.statuses.${statusKey} must be an object.`);
  }
  if (!hasNonEmptyString(status.name)) {
    throw new Error(`${source} linear.issue.statuses.${statusKey}.name must be a non-empty string.`);
  }
  if (!hasNonEmptyString(status.type)) {
    throw new Error(`${source} linear.issue.statuses.${statusKey}.type must be a non-empty string.`);
  }
}

function collectStatusConfigMissingFields(statuses, basePath, statusKeys, missing) {
  for (const statusKey of statusKeys) {
    const status = statuses?.[statusKey];
    const statusPath = `${basePath}.${statusKey}`;
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      missing.push(statusPath);
      continue;
    }
    if (!hasNonEmptyString(status.name)) missing.push(`${statusPath}.name`);
    if (!hasNonEmptyString(status.type)) missing.push(`${statusPath}.type`);
  }
}

function parseRedirectUri(redirectUri) {
  try {
    return new URL(redirectUri);
  } catch {
    throw new Error("Linear OAuth redirect_uri must be a valid URL.");
  }
}

export function isLinearOAuthCallbackPort(port) {
  const value = Number(port);
  return Number.isInteger(value) &&
    value >= LINEAR_OAUTH_CALLBACK.portRange.start &&
    value <= LINEAR_OAUTH_CALLBACK.portRange.end;
}

function linearOAuthCallbackPortRangeLabel() {
  const { start, end } = LINEAR_OAUTH_CALLBACK.portRange;
  return start === end ? String(start) : `${start}-${end}`;
}

function resolveLinearConfigPath({ repoRoot, configPath }) {
  if (configPath && String(configPath).trim() !== "") {
    return path.resolve(repoRoot || process.cwd(), configPath);
  }
  return DEFAULT_CONFIG_PATH;
}

function stripLegacyTeamiPrefix(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  return normalized === ".teami"
    ? "."
    : normalized.startsWith(".teami/")
      ? normalized.slice(".teami/".length)
      : normalized;
}
