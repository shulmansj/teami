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

export { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";

export const DEFAULT_CONFIG_PATH = path.join(
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
export const ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH = DECOMPOSITION_EVAL_PATHS.accepted_runtime;

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const ACCEPTED_RUNTIME_ROLES_SCHEMA_VERSION = "teami-accepted-runtime-roles/v1";
const DECOMPOSITION_WORKFLOW_TYPE = "decomposition";
const CONFIG_SHAPE_OUTDATED_MESSAGE =
  "config_shape_outdated: move decomposition.runtime.adapters to runtime.adapters, decomposition.runtime.default_invocation to runtime.default_invocation, and decomposition.runtime.roles to workflows.decomposition.roles (see docs/contracts/workflow-definition.md).";
const REQUIRED_LINEAR_OAUTH_SCOPES = Object.freeze(["read", "write"]);
const RUNTIME_ROLE_FIELDS = Object.freeze(["runtime", "model"]);
const RUNTIME_ROLE_SOURCE_ADOPTER_CONFIG = "adopter_config";
const RUNTIME_ROLE_SOURCE_ACCEPTED_DEFAULTS = "accepted_defaults";
const PROJECT_STATUS_ROLES = Object.freeze(["backlog", "planned", "in_progress", "completed"]);
const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const MIN_POLL_INTERVAL_MS = 2_000;
export const UNPINNED_RUNTIME_DEV_FLAG = "TEAMI_ALLOW_UNPINNED_RUNTIME";

export function loadLinearConfig({
  repoRoot = process.cwd(),
  configPath = process.env.TEAMI_LINEAR_CONFIG,
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
    acceptedRuntimeRolesPath = null,
    moduleRootFallback = true,
    env = process.env,
  } = {},
) {
  assertCurrentConfigShape(config);
  applyPollDefaults(config);
  const linear = config?.linear;
  const oauth = linear?.oauth;
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
  if (!linear?.issue?.labels?.needs_principal) missing.push("linear.issue.labels.needs_principal");
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
  validateReviewWorkflowConfig(config.workflows?.review, source);
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

export function cachePathForConfig(config, repoRoot = process.cwd()) {
  return path.resolve(repoRoot, config.linear.cache_path || ".teami/linear.json");
}

export function unpinnedRuntimeTraceAttributes(config, workflowType = DECOMPOSITION_WORKFLOW_TYPE) {
  const unpinnedRuntime = config?.workflows?.[workflowType]?.unpinned_runtime;
  if (!unpinnedRuntime || typeof unpinnedRuntime !== "object" || Array.isArray(unpinnedRuntime)) return {};
  if (Object.keys(unpinnedRuntime).length === 0) return {};
  return {
    "teami.unpinned_runtime": stableJsonValue(unpinnedRuntime),
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

  if (oauth.actor !== "user") {
    throw new Error(`${source} must use Linear OAuth actor=user for local setup.`);
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

function validateReviewWorkflowConfig(review, source) {
  const maxRounds = review?.max_autonomous_fix_rounds;
  if (maxRounds === undefined) return;
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    throw new Error(`${source} workflows.review.max_autonomous_fix_rounds must be a non-negative integer.`);
  }
}

function validateIssueTargetConfig(issue, source) {
  for (const statusKey of ISSUE_STATUS_ROLES) {
    validateRequiredIssueStatus(issue, source, statusKey);
  }

  if (Object.hasOwn(issue?.labels || {}, "needs_principal") && !hasNonEmptyString(issue.labels.needs_principal)) {
    throw new Error(`${source} linear.issue.labels.needs_principal must be a non-empty string.`);
  }
  if (Object.hasOwn(issue?.labels || {}, "work_type_code") && !hasNonEmptyString(issue.labels.work_type_code)) {
    throw new Error(`${source} linear.issue.labels.work_type_code must be a non-empty string.`);
  }
  if (Object.hasOwn(issue?.labels || {}, "work_type_non_code") && !hasNonEmptyString(issue.labels.work_type_non_code)) {
    throw new Error(`${source} linear.issue.labels.work_type_non_code must be a non-empty string.`);
  }
  if (Object.hasOwn(issue?.labels || {}, "in_review") && !hasNonEmptyString(issue.labels.in_review)) {
    throw new Error(`${source} linear.issue.labels.in_review must be a non-empty string.`);
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
