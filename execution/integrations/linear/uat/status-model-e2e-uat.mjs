#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readLinearCache, writeLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readDomainRegistry } from "../src/domain-registry.mjs";
import { buildDomainContext } from "../src/domain-resolver.mjs";
import {
  createLinearCredentialStore,
  parseTokenSecret,
  serializeTokenSet,
} from "../src/linear-credential-store.mjs";
import { redactOAuthSecrets } from "../src/linear-oauth.mjs";
import { createLinearSetupGraphqlClient } from "../src/linear-setup-auth.mjs";
import { MERGE_DONE_AUTOMATION_CHECK_NAME, doctorLinear } from "../src/linear/doctor-service.mjs";
import { configWithLinearTeam } from "../src/linear/matching-utils.mjs";
import { initLinear } from "../src/linear/setup-service.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const DEFAULT_SANDBOX_DOMAIN_ID = "test-1";
const SANDBOX_WORKSPACE_NAME = "agentic factory sandbox";
const STATUS_UAT_TOKEN_SET_ENV = "TEAMI_STATUS_UAT_TOKEN_SET";
const STATUS_UAT_UPDATED_TOKEN_SET_PATH_ENV = "TEAMI_STATUS_UAT_UPDATED_TOKEN_SET_PATH";
const LEGACY_SPIKE_TOKEN_SET_ENV = "TEAMI_LINEAR_SPIKE_TOKEN_SET";
const LEGACY_SPIKE_UPDATED_TOKEN_SET_PATH_ENV = "TEAMI_LINEAR_SPIKE_UPDATED_TOKEN_SET_PATH";
const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
const PROJECT_STATUS_ROLES = Object.freeze(["backlog", "planned", "in_progress", "completed"]);
const TERMINAL_CANCELED_TYPES = new Set(["canceled", "cancelled"]);

class StatusModelUatUserError extends Error {
  constructor(message, code = "status_model_uat_user_error") {
    super(message);
    this.name = "StatusModelUatUserError";
    this.code = code;
  }
}

export function parseStatusModelUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(
      env.TEAMI_STATUS_UAT_REPO_ROOT ||
      env.TEAMI_UAT_REPO_ROOT ||
      REPO_ROOT,
    ),
    domainId: env.TEAMI_STATUS_UAT_DOMAIN_ID || null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--domain" || arg === "--domain-id") {
      options.domainId = requireNext(argv, ++index, arg);
    } else {
      throw new StatusModelUatUserError(`unknown status-model UAT flag: ${arg}`, "usage");
    }
  }

  return options;
}

export function buildStatusModelUatUsage() {
  return [
    "Usage: node execution/integrations/linear/uat/status-model-e2e-uat.mjs [--repo-root <repo>] [--domain test-1]",
    "",
    "Live target:",
    "- Uses the Teami sandbox Linear domain (default: test-1 / agentic factory sandbox).",
    "- This is destructive-but-disposable: it provisions canonical statuses/labels and creates one zz-status-uat issue, then cleans that issue up.",
    "- It does not use GitHub and does not run agent execution.",
    "",
    "Environment:",
    "- TEAMI_STATUS_UAT_DOMAIN_ID selects the sandbox domain.",
    "- TEAMI_STATUS_UAT_TOKEN_SET can env-bridge a Linear OAuth token set for CI-style handoff.",
    "- TEAMI_STATUS_UAT_UPDATED_TOKEN_SET_PATH writes back a refreshed env-bridged token set.",
  ].join("\n");
}

export async function runStatusModelE2eUat(options = parseStatusModelUatArgs()) {
  const context = await prepareLiveStatusModelContext(options);
  const report = {
    ok: false,
    ranAt: new Date().toISOString(),
    script: "status-model-e2e-uat",
    repoRoot: context.repoRoot,
    domain: {
      id: context.domain.id,
      workspaceId: context.domainContext.linear.workspaceId,
      workspaceName: context.domain.linear.workspace_name || null,
      teamId: context.team.id,
      teamKey: context.team.key,
      teamName: context.team.name,
      cachePath: context.domainContext.linear.cachePath,
    },
    oauth: {
      credentialStoreKind: context.credentialStore.kind,
      credentialTarget: context.configuredStore.target,
      usedEnvBridge: context.usesEnvBridge,
      envBridgeSource: context.envBridgeSource,
      hadAccessTokenBefore: Boolean(context.tokenSetBefore?.accessToken),
      hadRefreshTokenBefore: Boolean(context.tokenSetBefore?.refreshToken),
      storedScopeBefore: context.tokenSetBefore?.scope || null,
      configuredScopes: context.config.linear.oauth.scopes,
      actor: context.config.linear.oauth.actor,
    },
    steps: [],
    createdIssue: null,
    cleanup: null,
    error: null,
  };

  let issueId = null;
  try {
    const provision = await recordStep(report, "provision", () => provisionStatusModel(context));
    context.cache = provision.cache;

    await recordStep(report, "verify-cache", () => verifyProvisionedCache(context));
    await recordStep(report, "doctor", () => verifyDoctor(context));

    const created = await recordStep(report, "create-issue", () => createThrowawayIssue(context));
    issueId = created.issue.id;
    report.createdIssue = summarizeIssue(created.issue);

    await recordStep(report, "transition-todo-to-in-progress", () =>
      transitionIssue(context, issueId, "in_progress"));
    await recordStep(report, "transition-in-progress-to-in-review", () =>
      transitionIssue(context, issueId, "in_review"));
    await recordStep(report, "transition-in-review-to-blocked-with-label", () =>
      transitionIssueToBlockedWithReason(context, issueId));
    await recordStep(report, "merge-done-stand-in", () =>
      transitionIssue(context, issueId, "done", { requireCompletedType: true }));

    report.ok = true;
  } catch (error) {
    report.error = summarizeError(error);
    report.ok = false;
  } finally {
    if (issueId) {
      report.cleanup = await cleanupThrowawayIssue(context, issueId);
      if (report.cleanup?.ok === false) report.ok = false;
    }
  }

  return report;
}

async function prepareLiveStatusModelContext(options) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const config = loadLinearConfig({ repoRoot });
  const registry = readDomainRegistry({ repoRoot });
  const domain = selectStatusUatDomain({
    registry,
    domainId: options.domainId || null,
  });
  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const team = {
    id: domainContext.linear.teamId,
    key: domainContext.linear.teamKey,
    name: domainContext.linear.teamName,
  };
  const configForDomain = configWithLinearTeam(config, team);
  const configuredStore = createLinearCredentialStore({ config, repoRoot, domainContext });
  const envBridge = resolveEnvBridge(process.env);
  const credentialStore = envBridge
    ? createEnvCredentialStore({
        tokenSecret: envBridge.tokenSecret,
        target: configuredStore.target,
        tokenUpdatePath: envBridge.tokenUpdatePath,
      })
    : configuredStore;
  const tokenSetBefore = await readRequiredLinearTokenSet(credentialStore);
  const setupAuth = createLinearSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  });

  return {
    repoRoot,
    config,
    registry,
    domain,
    domainContext,
    team,
    configForDomain,
    configuredStore,
    credentialStore,
    usesEnvBridge: Boolean(envBridge),
    envBridgeSource: envBridge?.source || null,
    tokenSetBefore,
    setupAuth,
    client: setupAuth.client,
    cache: null,
  };
}

async function provisionStatusModel(context) {
  const existingCache = readLinearCache(context.domainContext.linear.cachePath);
  let provisioned = null;
  const initResult = await initLinear({
    client: context.client,
    config: context.configForDomain,
    cache: { ...(existingCache || {}), teamId: context.team.id },
    writeCache: (cache) => {
      provisioned = cache;
    },
  });
  if (!provisioned) provisioned = initResult.cache;
  if (!provisioned?.teamId) {
    throw new Error("initLinear did not produce a provisioned Linear cache.");
  }

  const cacheToWrite = {
    ...(existingCache || {}),
    ...provisioned,
    domainId: existingCache?.domainId || context.domain.id,
    workspaceId: existingCache?.workspaceId || context.domainContext.linear.workspaceId,
    ...(existingCache?.localRunner ? { localRunner: existingCache.localRunner } : {}),
  };
  writeLinearCache(context.domainContext.linear.cachePath, cacheToWrite);

  return {
    ok: initResult.ok,
    summary: initResult.summary,
    cache: cacheToWrite,
    cachePath: context.domainContext.linear.cachePath,
  };
}

async function verifyProvisionedCache(context) {
  const cache = context.cache;
  assertCondition(cache && typeof cache === "object", "Provisioned cache is missing.");
  const issueStatuses = assertRoleIdMap(cache.issueStatuses, ISSUE_STATUS_ROLES, "issueStatuses");
  const projectStatuses = assertRoleIdMap(cache.projectStatuses, PROJECT_STATUS_ROLES, "projectStatuses");
  assertCondition(!Object.hasOwn(cache.projectStatuses || {}, "blocked"), "Project status cache must not include blocked.");

  const issueLabelNames = [
    context.configForDomain.linear.issue.labels.discovery,
    context.configForDomain.linear.issue.labels.needs_principal,
  ];
  const projectLabelNames = [
    context.configForDomain.linear.project.labels.has_open_questions,
  ];
  const issueLabels = assertNameIdMap(cache.issueLabels, issueLabelNames, "issueLabels");
  const projectLabels = assertNameIdMap(cache.projectLabels, projectLabelNames, "projectLabels");

  return {
    issueStatuses,
    projectStatuses,
    issueLabels,
    projectLabels,
  };
}

async function verifyDoctor(context) {
  const doctor = await doctorLinear({
    client: context.client,
    config: context.configForDomain,
    cache: context.cache,
  });
  const allowedNonGreen = new Set([MERGE_DONE_AUTOMATION_CHECK_NAME]);
  const nonGreen = doctor.checks.filter((check) => !check.ok && !allowedNonGreen.has(check.name));
  if (nonGreen.length > 0) {
    throw new Error(`Doctor status-model checks failed: ${nonGreen.map((check) => `${check.name}: ${check.message}`).join("; ")}`);
  }

  for (const required of requiredDoctorCheckNames(context.configForDomain)) {
    const check = doctor.checks.find((candidate) => candidate.name === required);
    assertCondition(check?.ok === true, `Required doctor check did not pass: ${required}`);
  }

  return {
    healthy: doctor.healthy,
    statusLabelModelHealthy: nonGreen.length === 0,
    allowedNonGreenChecks: doctor.checks
      .filter((check) => !check.ok && allowedNonGreen.has(check.name))
      .map((check) => ({ name: check.name, message: check.message })),
    checks: doctor.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      message: check.message,
    })),
  };
}

async function createThrowawayIssue(context) {
  const title = `zz-status-uat ${uatStamp()}`;
  const issue = await context.client.createIssue({
    teamId: context.team.id,
    title,
    description: [
      "## Status Model UAT",
      "",
      "Disposable live issue used by Teami to verify the canonical Linear status and label model.",
      "",
      "This issue may be archived, canceled, or left completed after the UAT harness finishes.",
    ].join("\n"),
    stateId: context.cache.issueStatuses.todo,
  });
  const fetched = await context.client.getIssue(issue.id);
  assertIssueState(fetched, context, "todo");
  return { issue: fetched };
}

async function transitionIssue(context, issueId, role, { requireCompletedType = false } = {}) {
  await context.client.updateIssue(issueId, { stateId: context.cache.issueStatuses[role] });
  const issue = await context.client.getIssue(issueId);
  assertIssueState(issue, context, role);
  if (requireCompletedType) {
    assertCondition(issue.state?.type === "completed", `Expected ${role} to be completed, got ${issue.state?.type || "missing"}.`);
  }
  return { issue: summarizeIssue(issue) };
}

async function transitionIssueToBlockedWithReason(context, issueId) {
  const needsPrincipalName = context.configForDomain.linear.issue.labels.needs_principal;
  const needsPrincipalId = context.cache.issueLabels?.[needsPrincipalName];
  assertCondition(isNonEmptyString(needsPrincipalId), `Cached issue label ${needsPrincipalName} is missing.`);

  const before = await context.client.getIssue(issueId);
  const labelIds = uniqueIds([
    ...(before.labels || []).map((label) => label.id),
    needsPrincipalId,
  ]);
  await context.client.updateIssue(issueId, {
    stateId: context.cache.issueStatuses.blocked,
    labelIds,
  });
  const issue = await context.client.getIssue(issueId);
  assertIssueState(issue, context, "blocked");
  assertCondition(
    issue.labels?.some((label) => label.id === needsPrincipalId),
    `Blocked issue does not carry ${needsPrincipalName}.`,
  );
  return {
    issue: summarizeIssue(issue),
    reasonLabel: {
      name: needsPrincipalName,
      id: needsPrincipalId,
    },
  };
}

async function cleanupThrowawayIssue(context, issueId) {
  const result = {
    ok: false,
    issueId,
    action: null,
    issue: null,
    error: null,
  };
  try {
    if (typeof context.client.archiveIssue === "function") {
      const archived = await context.client.archiveIssue(issueId);
      result.ok = true;
      result.action = "archived";
      result.issue = archived ? summarizeIssue(archived) : null;
      return result;
    }

    const canceled = await resolveCanceledWorkflowState(context);
    if (canceled?.id) {
      await context.client.updateIssue(issueId, { stateId: canceled.id });
      const issue = await context.client.getIssue(issueId);
      result.ok = true;
      result.action = "moved_to_canceled";
      result.issue = summarizeIssue(issue);
      return result;
    }

    const issue = await context.client.getIssue(issueId);
    result.ok = issue.state?.id === context.cache?.issueStatuses?.done && issue.state?.type === "completed";
    result.action = result.ok ? "left_completed_done_clearly_named" : "left_clearly_named";
    result.issue = summarizeIssue(issue);
    return result;
  } catch (error) {
    result.ok = false;
    result.action = "cleanup_failed";
    result.error = summarizeError(error);
    return result;
  }
}

async function resolveCanceledWorkflowState(context) {
  const states = await context.client.listWorkflowStates(context.team.id);
  return (
    states.find((state) => TERMINAL_CANCELED_TYPES.has(String(state.type || "").toLowerCase())) ||
    states.find((state) => TERMINAL_CANCELED_TYPES.has(String(state.name || "").trim().toLowerCase())) ||
    null
  );
}

function selectStatusUatDomain({ registry, domainId = null } = {}) {
  const domains = Array.isArray(registry?.domains) ? registry.domains : [];
  const activeWithTeam = domains.filter((domain) => domain.status === "active" && domain.linear?.team_id);
  if (activeWithTeam.length === 0) {
    throw new StatusModelUatUserError("No active Linear domain with a team is configured; run init against the sandbox first.", "no_linear_domain");
  }
  const selected = domainId
    ? activeWithTeam.find((domain) => domain.id === domainId)
    : activeWithTeam[0];
  if (!selected) {
    throw new StatusModelUatUserError(`Status-model UAT domain is not active or not found: ${domainId}`, "domain");
  }
  assertSandboxDomain(selected);
  return selected;
}

function assertSandboxDomain(domain) {
  const labels = [
    domain.id,
    domain.adopter_provided_name,
    domain.linear?.workspace_name,
    domain.linear?.team_name,
  ].filter(Boolean);
  if (labels.some((label) => /af-smoke/i.test(label))) {
    throw new StatusModelUatUserError(
      `Refusing to run status-model UAT against non-sandbox-looking domain ${domain.id}; this harness targets ${DEFAULT_SANDBOX_DOMAIN_ID}.`,
      "wrong_domain",
    );
  }

  const workspaceName = String(domain.linear?.workspace_name || "").trim().toLowerCase();
  if (domain.id !== DEFAULT_SANDBOX_DOMAIN_ID && workspaceName !== SANDBOX_WORKSPACE_NAME) {
    throw new StatusModelUatUserError(
      `Refusing to run status-model UAT against ${domain.id}; expected domain ${DEFAULT_SANDBOX_DOMAIN_ID} or workspace '${SANDBOX_WORKSPACE_NAME}'.`,
      "wrong_domain",
    );
  }
}

function resolveEnvBridge(env) {
  const tokenSecret = env[STATUS_UAT_TOKEN_SET_ENV] || env[LEGACY_SPIKE_TOKEN_SET_ENV] || null;
  if (!tokenSecret) return null;
  const source = env[STATUS_UAT_TOKEN_SET_ENV] ? STATUS_UAT_TOKEN_SET_ENV : LEGACY_SPIKE_TOKEN_SET_ENV;
  const tokenUpdatePath =
    env[STATUS_UAT_UPDATED_TOKEN_SET_PATH_ENV] ||
    env[LEGACY_SPIKE_UPDATED_TOKEN_SET_PATH_ENV] ||
    null;
  return { tokenSecret, tokenUpdatePath, source };
}

function createEnvCredentialStore({ tokenSecret, target, tokenUpdatePath = null }) {
  let tokenSet = parseTokenSecret(tokenSecret);
  return {
    kind: "env-bridged-windows-credential-manager",
    target,
    async readTokenSet() {
      return tokenSet;
    },
    async writeTokenSet(nextTokenSet) {
      tokenSet = nextTokenSet;
      if (tokenUpdatePath) {
        fs.writeFileSync(tokenUpdatePath, serializeTokenSet(nextTokenSet), { encoding: "utf8", mode: 0o600 });
      }
    },
    async deleteTokenSet() {
      tokenSet = null;
    },
  };
}

async function readRequiredLinearTokenSet(credentialStore) {
  const tokenSet = await credentialStore.readTokenSet();
  if (!tokenSet?.accessToken && !tokenSet?.refreshToken) {
    throw new StatusModelUatUserError("Linear OAuth authorization is missing for the selected sandbox domain; run init first.", "no_linear_credential");
  }
  return tokenSet;
}

async function recordStep(report, name, fn) {
  const step = {
    name,
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  report.steps.push(step);
  try {
    const result = await fn();
    Object.assign(step, result, { ok: result?.ok !== false });
    if (result?.ok === false) {
      throw new Error(`Status-model UAT step failed: ${name}`);
    }
    return result;
  } catch (error) {
    step.error = summarizeError(error);
    throw error;
  } finally {
    step.finishedAt = new Date().toISOString();
  }
}

function assertIssueState(issue, context, role) {
  const expectedId = context.cache?.issueStatuses?.[role];
  const expectedType = context.configForDomain.linear.issue.statuses[role]?.type;
  assertCondition(isNonEmptyString(expectedId), `Cached issue status ${role} is missing.`);
  assertCondition(issue?.state?.id === expectedId, `Issue ${issue?.id || "unknown"} state id ${issue?.state?.id || "missing"} did not equal ${role}=${expectedId}.`);
  assertCondition(issue?.state?.type === expectedType, `Issue ${issue?.id || "unknown"} state type ${issue?.state?.type || "missing"} did not equal ${expectedType}.`);
}

function assertRoleIdMap(map, roles, label) {
  assertCondition(map && typeof map === "object" && !Array.isArray(map), `${label} must be an object.`);
  return Object.fromEntries(
    roles.map((role) => {
      const id = map[role];
      assertCondition(isNonEmptyString(id), `${label}.${role} must be a non-empty id.`);
      return [role, id];
    }),
  );
}

function assertNameIdMap(map, names, label) {
  assertCondition(map && typeof map === "object" && !Array.isArray(map), `${label} must be an object.`);
  return Object.fromEntries(
    names.map((name) => {
      const id = map[name];
      assertCondition(isNonEmptyString(id), `${label}[${name}] must be a non-empty id.`);
      return [name, id];
    }),
  );
}

function requiredDoctorCheckNames(config) {
  return [
    "project status mappings",
    "issue status mappings",
    `project label ${config.linear.project.labels.has_open_questions}`,
    `issue label ${config.linear.issue.labels.discovery}`,
    `issue label ${config.linear.issue.labels.needs_principal}`,
  ];
}

function summarizeIssue(issue = {}) {
  return {
    id: issue.id || null,
    identifier: issue.identifier || null,
    title: issue.title || null,
    url: issue.url || null,
    state: issue.state
      ? {
          id: issue.state.id || null,
          name: issue.state.name || null,
          type: issue.state.type || null,
        }
      : null,
    labels: (issue.labels || []).map((label) => ({
      id: label.id,
      name: label.name,
    })),
  };
}

function summarizeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: redactOAuthSecrets(error?.message || String(error)),
  };
}

function redactOutput(value) {
  return JSON.parse(redactOAuthSecrets(JSON.stringify(value)));
}

function uniqueIds(values) {
  return [...new Set(values.filter(isNonEmptyString))];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function uatStamp() {
  return new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15);
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new StatusModelUatUserError(`${flag} requires a value`, "usage");
  }
  return value;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  exit = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let options;
  try {
    options = parseStatusModelUatArgs(argv);
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildStatusModelUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    const report = await runStatusModelE2eUat(options);
    stdout(JSON.stringify(redactOutput(report), null, 2));
    exit(report.ok ? 0 : 1);
    return { ok: report.ok, report };
  } catch (error) {
    const report = {
      ok: false,
      ranAt: new Date().toISOString(),
      script: "status-model-e2e-uat",
      stage: "fatal",
      error: summarizeError(error),
    };
    stdout(JSON.stringify(redactOutput(report), null, 2));
    exit(error instanceof StatusModelUatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "fatal", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(redactOAuthSecrets(`STATUS MODEL UAT FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
