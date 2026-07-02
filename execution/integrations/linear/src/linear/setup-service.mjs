import {
  TEAM_CREATE_SETUP_CAUSES,
  emptyDomainRegistry,
  makeDomainRecord,
  mintDomainId,
  upsertDomainRecord,
  validateDomainRegistry,
} from "../domain-registry.mjs";
import { buildDomainContext } from "../domain-resolver.mjs";
import {
  findOrCreateIssueLabel,
  findOrCreateProjectLabel,
  findOrCreateProjectTemplate,
  findOrCreateTeam,
  resolveProjectStatusMappings,
} from "./shape-resolver.mjs";
import {
  configWithLinearTeam,
  domainNameMatchesRegistryDomain,
  equalsFolded,
  issueLabelNames,
  knownRegistryWorkspaces,
  normalizeDeclaredWorkspace,
  normalizeLinearWorkspace,
  normalizedErrors,
  projectLabelNames,
  workspaceLabel,
  workspaceMismatchError,
} from "./matching-utils.mjs";

export async function resolveLinearSetupWorkspace({ client, workspace = null } = {}) {
  const resolved = normalizeLinearWorkspace(workspace || (await client.getOrganization?.()) || {});
  if (!resolved.id) {
    throw new Error("Linear organization did not return a workspace id.");
  }
  return resolved;
}

export function verifyDeclaredWorkspace({ registry = emptyDomainRegistry(), declaredWorkspace = null, grantedWorkspace } = {}) {
  const declared = normalizeDeclaredWorkspace(declaredWorkspace);
  if (!declared) return { ok: true, mode: "undeclared" };

  const granted = normalizeLinearWorkspace(grantedWorkspace);
  if (declared.mode === "known") {
    if (!declared.workspaceId || !granted.id) {
      throw workspaceMismatchError({
        granted,
        declared,
        detail: "known_workspace_id_required",
      });
    }
    const idMatched = Boolean(declared.workspaceId && granted.id && declared.workspaceId === granted.id);
    if (idMatched) {
      return { ok: true, mode: "known", matchedBy: "workspace_id" };
    }
    throw workspaceMismatchError({
      granted,
      declared,
      detail: "known_workspace_mismatch",
    });
  }

  if (declared.mode === "expected") {
    const expected = declared.value;
    const idMatched = Boolean(expected && granted.id && expected === granted.id);
    const nameMatched = Boolean(expected && granted.name && equalsFolded(expected, granted.name));
    if (idMatched || nameMatched) {
      return { ok: true, mode: "expected", matchedBy: idMatched ? "workspace_id" : "workspace_name" };
    }
    throw workspaceMismatchError({
      granted,
      declared: expected || "expected_workspace",
      detail: "expected_workspace_mismatch",
    });
  }

  if (declared.mode === "different") {
    const known = knownRegistryWorkspaces(registry).find((workspace) => {
      if (workspace.workspaceId && granted.id) return workspace.workspaceId === granted.id;
      return Boolean(workspace.workspaceName && granted.name && equalsFolded(workspace.workspaceName, granted.name));
    });
    if (!known) return { ok: true, mode: "different" };
    throw workspaceMismatchError({
      granted,
      declared: { value: "a different workspace" },
      detail: "different_workspace_already_known",
      domains: known.domains.map((domain) => domain.id),
    });
  }

  throw new Error(`Unknown declared workspace mode: ${declared.mode}`);
}

export function isWorkspaceMismatchError(error) {
  return error?.code === "workspace_mismatch";
}

export function setupIncompleteDomainForName(registry = emptyDomainRegistry(), domainName = "") {
  if (typeof domainName !== "string" || domainName.trim() === "") return null;
  const trimmed = domainName.trim();
  const slug = (() => {
    try {
      return mintDomainId(trimmed, []);
    } catch {
      return null;
    }
  })();
  const matches = (registry?.domains || []).filter((domain) =>
    domainNameMatchesRegistryDomain(domain, trimmed, slug),
  );
  return matches.find((domain) => domain.status === "setup_incomplete") || null;
}

export function declaredWorkspaceFromResumeDomain(domain = null) {
  if (!domain?.linear?.workspace_id) return null;
  return {
    mode: "known",
    workspaceId: domain.linear.workspace_id,
    workspaceName: domain.linear.workspace_name || null,
  };
}

export async function setupLinearDomain({
  client,
  config,
  registry = null,
  repoRoot = process.cwd(),
  domainName,
  cache = null,
  writeCache = async () => {},
  writeRegistry = async () => {},
  registerWebhook,
  ensureRunnerCredential,
  promoteCredential = async () => {},
  workspace = null,
  declaredWorkspace = null,
  onPreview = () => {},
  behaviorRepoId,
} = {}) {
  if (!client) throw new Error("Linear client is required for domain setup.");
  if (!config) throw new Error("Linear config is required for domain setup.");
  if (typeof domainName !== "string" || domainName.trim() === "") {
    throw new Error("An explicit domain name is required before Linear setup can mutate anything.");
  }
  const currentRegistry = registry || emptyDomainRegistry();
  validateDomainRegistry(currentRegistry);
  const trimmedDomainName = domainName.trim();
  const resumeDomain = setupIncompleteDomainForName(currentRegistry, trimmedDomainName);
  const adopterProvidedName = resumeDomain?.adopter_provided_name || trimmedDomainName;
  const domainId = resumeDomain?.id || mintDomainId(trimmedDomainName, currentRegistry.domains.map((domain) => domain.id));
  const organization = await resolveLinearSetupWorkspace({ client, workspace });
  const effectiveDeclaredWorkspace = declaredWorkspace || declaredWorkspaceFromResumeDomain(resumeDomain);
  verifyDeclaredWorkspace({
    registry: currentRegistry,
    declaredWorkspace: effectiveDeclaredWorkspace,
    grantedWorkspace: organization,
  });
  const workspaceId = organization.id;
  const workspaceName = organization.name;
  let latestRegistry = currentRegistry;
  let latestSetupDomain = makeSetupIncompleteDomain({
    domainId,
    domainName: adopterProvidedName,
    workspaceId,
    workspaceName,
  });

  async function persistSetupIncomplete({
    setupIncompleteCause = null,
    team: setupTeam = null,
    webhook = null,
  } = {}) {
    const domain = makeSetupIncompleteDomain({
      domainId,
      domainName: adopterProvidedName,
      setupIncompleteCause,
      workspaceId,
      workspaceName,
      team: setupTeam,
      webhook,
    });
    const nextRegistry = upsertDomainRecord(latestRegistry, domain);
    await writeRegistry(nextRegistry, domain);
    latestRegistry = nextRegistry;
    latestSetupDomain = domain;
    return { registry: nextRegistry, domain };
  }

  async function failWithSetupIncomplete(cause, originalError, state = {}) {
    const fallbackDomain = makeSetupIncompleteDomain({
      domainId,
      domainName: adopterProvidedName,
      setupIncompleteCause: cause,
      workspaceId,
      workspaceName,
      ...state,
    });
    let result = { registry: upsertDomainRecord(latestRegistry, fallbackDomain), domain: fallbackDomain };
    try {
      result = await persistSetupIncomplete({
        setupIncompleteCause: cause,
        ...state,
      });
    } catch (writeError) {
      if (cause !== "registry_write_failed") {
        const setupError = setupIncompleteError({
          cause: "registry_write_failed",
          domain: fallbackDomain,
          registry: result.registry,
          originalError: writeError,
        });
        setupError.originalSetupError = originalError;
        throw setupError;
      }
    }
    throw setupIncompleteError({
      cause,
      domain: result.domain,
      registry: result.registry,
      originalError,
    });
  }

  try {
    await persistSetupIncomplete();
  } catch (error) {
    throw setupIncompleteError({
      cause: "registry_write_failed",
      domain: latestSetupDomain,
      registry: latestRegistry,
      originalError: error,
    });
  }

  const teamPlan = await resolveSetupTeamPlan({
    client,
    requestedName: trimmedDomainName,
    domainId,
    resumeDomain,
    cache,
  });

  onPreview(
    teamPlan.mode === "adopt"
      ? setupPreviewLine({
          action: "use",
          teamName: teamPlan.team.name,
          organization,
          registerWebhook,
        })
      : setupPreviewLine({
          action: "create",
          teamName: teamPlan.input.name,
          organization,
          registerWebhook,
        }),
  );

  let team = teamPlan.team || null;
  try {
    if (!team) {
      team = await client.createTeam(teamPlan.input);
    }
  } catch (error) {
    const setupIncompleteCause = classifyTeamCreateError(error);
    await failWithSetupIncomplete(setupIncompleteCause, error);
  }

  if (!team?.id || !team?.key || !team?.name) {
    throw new Error("Linear teamCreate did not return id, key, and name.");
  }

  const configForDomain = configWithLinearTeam(config, team);
  try {
    await persistSetupIncomplete({ team });
  } catch (error) {
    throw setupIncompleteError({
      cause: "registry_write_failed",
      domain: makeSetupIncompleteDomain({ domainId, domainName: adopterProvidedName, workspaceId, workspaceName, team }),
      registry: latestRegistry,
      originalError: error,
    });
  }
  let initializedCache = null;
  const initResult = await initLinear({
    client,
    config: configForDomain,
    cache: { ...(cache || {}), teamId: team.id },
    writeCache: (nextCache) => {
      initializedCache = nextCache;
    },
  });
  if (!initializedCache?.teamId) {
    throw new Error("Linear domain setup did not produce a verified cache.");
  }

  let webhookRegistration = null;
  if (typeof registerWebhook === "function") {
    try {
      webhookRegistration = await registerWebhook({
        client,
        config: configForDomain,
        cache: initializedCache,
        workspaceId,
        teamId: team.id,
      });
    } catch (error) {
      await failWithSetupIncomplete("linear_webhook_registration_failed", error, { team });
    }
    try {
      await persistSetupIncomplete({ team, webhook: webhookRegistration.webhook });
    } catch (error) {
      throw setupIncompleteError({
        cause: "registry_write_failed",
        domain: makeSetupIncompleteDomain({
          domainId,
          domainName: adopterProvidedName,
          workspaceId,
          workspaceName,
          team,
          webhook: webhookRegistration.webhook,
        }),
        registry: latestRegistry,
        originalError: error,
      });
    }
  } else {
    webhookRegistration = {
      skipped: true,
      reason: "local_gateway_poll",
      webhook: null,
    };
  }

  let runnerCredential = null;
  if (typeof ensureRunnerCredential === "function") {
    try {
      runnerCredential = await ensureRunnerCredential({
        workspaceId,
        teamId: team.id,
        domainId,
      });
    } catch (error) {
      await failWithSetupIncomplete("runner_authority_failed", error, {
        team,
        webhook: webhookRegistration.webhook,
      });
    }
  } else {
    runnerCredential = {
      skipped: true,
      reason: "local_gateway_runner_identity",
      credential: null,
    };
  }
  const localRunnerCache = {
    triggerSource: "local_gateway_poll",
  };
  if (webhookRegistration.webhook) localRunnerCache.legacyWebhook = webhookRegistration.webhook;
  const runnerCredentialId = runnerCredential.credential?.credentialId || runnerCredential.credentialId;
  if (runnerCredentialId) localRunnerCache.legacyRunnerCredentialId = runnerCredentialId;
  const finalCache = {
    ...initializedCache,
    domainId,
    workspaceId,
    teamId: team.id,
    localRunner: localRunnerCache,
  };
  const activeDomain = makeDomainRecord({
    domainId,
    status: "active",
    adopterProvidedName,
    workspaceId,
    workspaceName,
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    teamNameLastSeenAt: new Date().toISOString(),
    webhookId: webhookRegistration.webhook?.id || null,
  });
  const nextRegistry = upsertDomainRecord(currentRegistry, activeDomain);
  const context = buildDomainContext({
    domain: activeDomain,
    config: configForDomain,
    repoRoot,
    behaviorRepoId,
  });

  try {
    await writeCache(finalCache, context);
  } catch (error) {
    await failWithSetupIncomplete("cache_write_failed", error, {
      team,
      webhook: webhookRegistration.webhook,
    });
  }
  try {
    await promoteCredential({
      context,
      cache: finalCache,
      domain: activeDomain,
      registry: nextRegistry,
    });
  } catch (error) {
    await failWithSetupIncomplete("credential_promotion_failed", error, {
      team,
      webhook: webhookRegistration.webhook,
    });
  }
  try {
    await writeRegistry(nextRegistry, activeDomain, context);
  } catch (error) {
    try {
      await persistSetupIncomplete({
        setupIncompleteCause: "registry_write_failed",
        team,
        webhook: webhookRegistration.webhook,
      });
    } catch {
      // The registry writer is already failing; surface the original registry failure loudly.
    }
    throw setupIncompleteError({
      cause: "registry_write_failed",
      domain: makeSetupIncompleteDomain({
        domainId,
        domainName: adopterProvidedName,
        setupIncompleteCause: "registry_write_failed",
        workspaceId,
        workspaceName,
        team,
        webhook: webhookRegistration.webhook,
      }),
      registry: latestRegistry,
      originalError: error,
    });
  }
  return {
    ok: initResult.ok,
    summary: initResult.summary,
    cache: finalCache,
    registry: nextRegistry,
    domain: activeDomain,
    context,
    webhookRegistration,
    runnerCredential,
  };
}

function setupPreviewLine({ action, teamName, organization, registerWebhook }) {
  const verb = action === "use" ? "use" : "create";
  const suffix = typeof registerWebhook === "function"
    ? " and register one webhook"
    : " and start runs from the local gateway";
  return `will ${verb} Linear team '${teamName}' in workspace ${workspaceLabel(organization)}${suffix}`;
}

function makeSetupIncompleteDomain({
  domainId,
  domainName = null,
  setupIncompleteCause = null,
  workspaceId = null,
  workspaceName = null,
  team = null,
  webhook = null,
} = {}) {
  return makeDomainRecord({
    domainId,
    status: "setup_incomplete",
    adopterProvidedName: domainName,
    setupIncompleteCause,
    workspaceId,
    workspaceName,
    teamId: team?.id || team?.teamId || null,
    teamKey: team?.key || team?.teamKey || null,
    teamName: team?.name || team?.teamName || null,
    teamNameLastSeenAt: team?.name || team?.teamName ? new Date().toISOString() : null,
    webhookId: webhook?.id || webhook?.webhookId || null,
  });
}

async function resolveSetupTeamPlan({
  client,
  requestedName,
  domainId,
  resumeDomain = null,
  cache = null,
} = {}) {
  const existingTeams = await client.listTeams?.() || [];
  const recordedTeam = findRecordedSetupTeam(existingTeams, { domainId, resumeDomain, cache });
  if (recordedTeam) {
    return {
      mode: "adopt",
      team: recordedTeam,
      existingTeams,
    };
  }

  return {
    mode: "create",
    input: teamCreateInputForSetup({ requestedName, existingTeams }),
    existingTeams,
  };
}

function findRecordedSetupTeam(teams, { domainId, resumeDomain = null, cache = null } = {}) {
  const recordedTeamId =
    resumeDomain?.linear?.team_id ||
    (cache?.domainId === domainId ? cache?.teamId : null);
  if (recordedTeamId) {
    const team = teams.find((candidate) => candidate.id === recordedTeamId);
    if (team) return team;
  }

  const recordedTeamKey = resumeDomain?.linear?.team_key || null;
  if (recordedTeamKey) {
    const keyMatches = teams.filter((candidate) => candidate.key === recordedTeamKey);
    if (keyMatches.length === 1) return keyMatches[0];
  }

  return null;
}

function teamCreateInputForSetup({ requestedName, existingTeams = [] } = {}) {
  const name = uniqueTeamName(requestedName, existingTeams);
  if (name === requestedName) return { name };

  return {
    name,
    key: uniqueTeamKey(teamKeyBase(name), existingTeams),
  };
}

function uniqueTeamName(requestedName, existingTeams) {
  const existingNames = new Set(
    existingTeams
      .map((team) => String(team.name || "").trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  if (!existingNames.has(String(requestedName).trim().toLocaleLowerCase())) return requestedName;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${requestedName} (${suffix})`;
    if (!existingNames.has(candidate.toLocaleLowerCase())) return candidate;
  }

  throw new Error(`Could not find an available Linear team name for ${requestedName}.`);
}

function uniqueTeamKey(baseKey, existingTeams) {
  const existingKeys = new Set(
    existingTeams
      .map((team) => String(team.key || "").trim().toLocaleUpperCase())
      .filter(Boolean),
  );
  if (!existingKeys.has(baseKey)) return baseKey;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${baseKey.slice(0, Math.max(1, 5 - suffixText.length))}${suffixText}`;
    if (!existingKeys.has(candidate)) return candidate;
  }

  throw new Error(`Could not find an available Linear team key for ${baseKey}.`);
}

function teamKeyBase(name) {
  const tokens = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[A-Za-z0-9]+/g) || [];
  const compact = tokens.join("")
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
  return compact || "TEAM";
}

function setupIncompleteError({ cause, domain, registry, originalError } = {}) {
  const runnerAuthorityDetail =
    cause === "runner_authority_failed" && originalError?.message
      ? ` Runner authority error: ${originalError.message}.`
      : "";
  const teamCreateDetail = TEAM_CREATE_SETUP_CAUSES.includes(cause)
    ? teamCreateErrorDetail(originalError)
    : "";
  const setupError = new Error(
    `${cause}:${runnerAuthorityDetail}${teamCreateDetail} ${repairPathForSetupIncompleteCause(cause)}`,
  );
  setupError.setupIncompleteCause = cause;
  setupError.domain = domain;
  setupError.registry = registry;
  setupError.originalError = originalError;
  if (originalError) setupError.cause = originalError;
  return setupError;
}

export function classifyTeamCreateError(payload) {
  const { teamCreateErrors, scopedErrors } = scopedTeamCreateErrors(payload);
  const text = teamCreateErrorText(scopedErrors);

  const hasLimit =
    text.includes("team limit") ||
    text.includes("teams allowed") ||
    text.includes("maximum number of teams") ||
    text.includes("cannot create more teams") ||
    text.includes("subscription") ||
    text.includes("plan");
  if (teamCreateErrors.length && hasLimit) return "linear_team_limit_reached";

  const hasRestriction =
    text.includes("team creation may be restricted") ||
    text.includes("restrict team creation") ||
    text.includes("only admin users") ||
    text.includes("only admins") ||
    text.includes("admin users");
  if (teamCreateErrors.length && hasRestriction) return "linear_team_create_restricted";

  return "linear_team_create_unknown_error";
}

function scopedTeamCreateErrors(payload) {
  const errors = normalizedErrors(payload);
  const teamCreateErrors = errors.filter(isTeamCreateError);
  const scopedErrors = teamCreateErrors.length ? teamCreateErrors : errors;
  return { errors, teamCreateErrors, scopedErrors };
}

function isTeamCreateError(error) {
  return Array.isArray(error.path)
    ? error.path.includes("teamCreate")
    : String(error.path || "").includes("teamCreate");
}

function teamCreateErrorText(errors) {
  return errors
    .flatMap((error) => [
      error.extensions?.userPresentableMessage,
      error.extensions?.userMessage,
      error.extensions?.message,
      error.extensions?.reason,
      error.message,
      error.extensions?.code,
      error.extensions?.type,
      error.type,
    ])
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function teamCreateErrorDetail(payload) {
  const { scopedErrors } = scopedTeamCreateErrors(payload);
  const detail = scopedErrors
    .flatMap((error) => [
      error.extensions?.userPresentableMessage,
      error.extensions?.userMessage,
      error.extensions?.message,
      error.message,
    ])
    .find((value) => typeof value === "string" && value.trim() !== "");
  return detail ? ` Linear teamCreate error: ${sentence(detail)}` : "";
}

function sentence(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function repairPathForSetupIncompleteCause(cause) {
  if (cause === "linear_team_create_restricted") {
    return "Ask a Linear workspace admin to allow team creation for your account, then rerun npm run init.";
  }
  if (cause === "linear_team_limit_reached") {
    return "Free or Basic Linear workspaces may be at their team limit; remove an unused team or upgrade, then rerun npm run init.";
  }
  if (cause === "linear_webhook_registration_failed") {
    return "Rerun npm run init after confirming Linear webhook admin authorization; npm run reset removes local setup state if needed.";
  }
  if (cause === "runner_authority_failed") {
    return "Rerun npm run init after repairing the local runner authority issue; npm run reset removes local setup state if needed.";
  }
  if (cause === "credential_promotion_failed") {
    return "Rerun npm run init to move the setup OAuth credential into the domain-scoped credential target; npm run reset removes local setup state if needed.";
  }
  if (cause === "cache_write_failed") {
    return "Fix local filesystem permissions for .teami, then rerun npm run init or npm run reset.";
  }
  if (cause === "registry_write_failed") {
    return "Fix local filesystem permissions for .teami/domains.json, then rerun npm run init or npm run reset.";
  }
  if (TEAM_CREATE_SETUP_CAUSES.includes(cause)) {
    return "Review the Linear teamCreate error, repair the workspace condition, then rerun npm run init.";
  }
  return "Run npm run doctor for repair guidance.";
}

export async function initLinear({ client, config, cache = null, writeCache } = {}) {
  const summary = { created: [], found: [], updated: [], failed: [] };
  await client.verifyAuth?.();

  const configForTeam = cache?.teamId
    ? configWithLinearTeam(config, await cachedLinearTeam(client, cache.teamId))
    : config;
  const team = await findOrCreateTeam(client, configForTeam, cache, summary);
  const projectLabels = {};
  for (const labelName of projectLabelNames(config)) {
    const label = await findOrCreateProjectLabel(client, labelName, summary);
    projectLabels[labelName] = label.id;
  }

  const issueLabels = {};
  for (const labelName of issueLabelNames(config)) {
    const label = await findOrCreateIssueLabel(client, labelName, team.id, summary);
    issueLabels[labelName] = label.id;
  }

  const projectStatuses = await resolveProjectStatusMappings({
    client,
    config,
    cache,
    failClosed: true,
  });
  const workflowStates = await client.listWorkflowStates?.(team.id);
  if (!workflowStates) {
    throw new Error("Linear client must provide listWorkflowStates to provision issue statuses.");
  }
  const issueStatuses = {};
  for (const role of ISSUE_STATUS_ROLES) {
    const statusConfig = config.linear.issue.statuses[role];
    if (!statusConfig) throw new Error(`Linear issue status role ${role} is not configured.`);
    const status = await findOrCreateWorkflowState(client, statusConfig, team.id, workflowStates, summary);
    issueStatuses[role] = status.id;
  }

  const template = await findOrCreateProjectTemplate(client, config, team.id, summary);

  const nextCache = {
    teamId: team.id,
    teamKey: team.key,
    projectTemplateId: template.id,
    projectStatuses: Object.fromEntries(
      Object.entries(projectStatuses).map(([key, value]) => [key, value.id]),
    ),
    projectStatusTypes: Object.fromEntries(
      Object.entries(projectStatuses).map(([key, value]) => [key, value.type]),
    ),
    issueStatuses,
    projectLabels,
    issueLabels,
  };

  await writeCache?.(nextCache);
  return { ok: summary.failed.length === 0, summary, cache: nextCache };
}

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
const DEFAULT_WORKFLOW_STATE_COLOR = "#f2c94c";

async function findOrCreateWorkflowState(client, { name, type }, teamId, states, summary) {
  const nameMatches = states.filter((state) => state.name === name);
  if (nameMatches.length > 1) {
    throw new Error(`Multiple Linear issue workflow states found named ${name}.`);
  }
  if (nameMatches.length === 1) {
    const state = nameMatches[0];
    if (state.type !== type) {
      throw new Error(`Linear issue workflow state ${name} has type ${state.type}, expected ${type}.`);
    }
    summary.found.push(`issue-status:${name}`);
    return state;
  }

  const state = await client.createWorkflowState({
    name,
    type,
    teamId,
    color: DEFAULT_WORKFLOW_STATE_COLOR,
  });
  if (!states.some((candidate) => candidate.id === state.id)) {
    states.push(state);
  }
  summary.created.push(`issue-status:${name}`);
  return state;
}

async function cachedLinearTeam(client, teamId) {
  const teams = await client.listTeams();
  const team = teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    throw new Error(`Cached Linear team ${teamId} no longer exists.`);
  }
  return team;
}
