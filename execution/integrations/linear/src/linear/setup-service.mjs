import {
  TEAM_CREATE_SETUP_CAUSES,
  emptyDomainRegistry,
  makeDomainRecord,
  mintDomainId,
  upsertDomainRecord,
  validateDomainRegistry,
} from "../domain-registry.mjs";
import { buildDomainContext } from "../domain-resolver.mjs";
import { doctorCheck } from "../doctor-check.mjs";
import {
  findOrCreateIssueLabel,
  findOrCreateIssueLabelGroup,
  findOrCreateProjectLabel,
  findOrCreateTeam,
  resolveProjectStatusMappings,
} from "./shape-resolver.mjs";
import {
  WORK_TYPE_LABEL_GROUP,
  issueLabelMetadata,
  projectLabelMetadata,
} from "./label-metadata.mjs";
import {
  configWithLinearTeam,
  domainNameMatchesRegistryDomain,
  equalsFolded,
  issueLabelRoles,
  knownRegistryWorkspaces,
  normalizeDeclaredWorkspace,
  normalizeLinearWorkspace,
  normalizedErrors,
  projectLabelRoles,
  workspaceLabel,
  workspaceMismatchError,
} from "./matching-utils.mjs";

const PROJECT_NEEDS_PRINCIPAL_ROLE = "needs_principal";
const PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR_CODE = "PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR";

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
  const matches = setupDomainsForName(registry, domainName);
  return matches.find((domain) => domain.status === "setup_incomplete") || null;
}

export function setupCompleteDomainForName(registry = emptyDomainRegistry(), domainName = "") {
  const matches = setupDomainsForName(registry, domainName);
  return matches.find((domain) => domain.status !== "setup_incomplete") || null;
}

function setupDomainsForName(registry = emptyDomainRegistry(), domainName = "") {
  if (typeof domainName !== "string" || domainName.trim() === "") return [];
  const trimmed = domainName.trim();
  const slug = (() => {
    try {
      return mintDomainId(trimmed, []);
    } catch {
      return null;
    }
  })();
  return (registry?.domains || []).filter((domain) =>
    domainNameMatchesRegistryDomain(domain, trimmed, slug),
  );
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
  resumeDomain = null,
  onPreview = () => {},
  behaviorRepoId,
  ensureNeedsPrincipalProjectStatus = null,
} = {}) {
  if (!client) throw new Error("Linear client is required for domain setup.");
  if (!config) throw new Error("Linear config is required for domain setup.");
  if (typeof domainName !== "string" || domainName.trim() === "") {
    throw new Error("An explicit domain name is required before Linear setup can mutate anything.");
  }
  const currentRegistry = registry || emptyDomainRegistry();
  validateDomainRegistry(currentRegistry);
  const trimmedDomainName = domainName.trim();
  const matchedResumeDomain = resumeDomain || setupIncompleteDomainForName(currentRegistry, trimmedDomainName);
  const completeResume = Boolean(matchedResumeDomain && matchedResumeDomain.status !== "setup_incomplete");
  const adopterProvidedName = matchedResumeDomain?.adopter_provided_name || trimmedDomainName;
  const domainId = matchedResumeDomain?.id || mintDomainId(trimmedDomainName, currentRegistry.domains.map((domain) => domain.id));
  const organization = await resolveLinearSetupWorkspace({ client, workspace });
  const effectiveDeclaredWorkspace = declaredWorkspace || declaredWorkspaceFromResumeDomain(matchedResumeDomain);
  verifyDeclaredWorkspace({
    registry: currentRegistry,
    declaredWorkspace: effectiveDeclaredWorkspace,
    grantedWorkspace: organization,
  });
  const workspaceId = organization.id;
  const workspaceName = organization.name;
  let latestRegistry = currentRegistry;
  let latestSetupDomain = matchedResumeDomain || makeSetupIncompleteDomain({
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
    if (completeResume) {
      throw setupIncompleteError({
        cause,
        domain: matchedResumeDomain,
        registry: latestRegistry,
        originalError,
      });
    }
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

  if (!completeResume) {
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
  }

  const teamPlan = await resolveSetupTeamPlan({
    client,
    requestedName: trimmedDomainName,
    domainId,
    resumeDomain: matchedResumeDomain,
    cache,
  });
  if (completeResume && !teamPlan.team) {
    throw new Error(
      `complete_domain_team_missing: domain ${domainId} records Linear team ${matchedResumeDomain.linear?.team_id || "unknown"}, but that team was not found in workspace ${workspaceLabel(organization)}.`,
    );
  }

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
  if (!completeResume) {
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
  }
  let initializedCache = null;
  const initResult = await initLinear({
    client,
    config: configForDomain,
    cache: { ...(cache || {}), teamId: team.id },
    ensureNeedsPrincipalProjectStatus,
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
      if (!completeResume) await persistSetupIncomplete({ team, webhook: webhookRegistration.webhook });
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
    status: completeResume ? matchedResumeDomain.status : "active",
    adopterProvidedName,
    workspaceId,
    workspaceName,
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    teamNameLastSeenAt: new Date().toISOString(),
    webhookId: webhookRegistration.webhook?.id || matchedResumeDomain?.linear?.webhook_id || null,
    resources: matchedResumeDomain?.resources || [],
    policyProfile: matchedResumeDomain?.policy_profile || "default",
    policyOverlayRef: matchedResumeDomain?.policy_overlay_ref || null,
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
    if (completeResume) {
      throw setupIncompleteError({
        cause: "registry_write_failed",
        domain: activeDomain,
        registry: nextRegistry,
        originalError: error,
      });
    }
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

export async function initLinear({
  client,
  config,
  cache = null,
  writeCache,
  ensureNeedsPrincipalProjectStatus = null,
} = {}) {
  const summary = { created: [], found: [], updated: [], failed: [], notes: [], doctorChecks: [] };
  const appIdentity = await resolveSetupAppIdentity(client);

  const configForTeam = cache?.teamId
    ? configWithLinearTeam(config, await cachedLinearTeam(client, cache.teamId))
    : config;
  const team = await findOrCreateTeam(client, configForTeam, cache, summary);
  const projectLabels = {};
  for (const { role, name } of projectLabelRoles(config)) {
    const label = await findOrCreateProjectLabel(client, name, summary, projectLabelMetadata(role));
    projectLabels[name] = label.id;
  }

  const issueRoles = issueLabelRoles(config);
  const workTypeGroup = issueRoles.some(
    ({ role }) => issueLabelMetadata(role)?.groupKey === WORK_TYPE_LABEL_GROUP.key,
  )
    ? await findOrCreateIssueLabelGroup(client, WORK_TYPE_LABEL_GROUP, team.id, summary)
    : null;

  const issueLabels = {};
  for (const { role, name } of issueRoles) {
    const metadata = issueLabelMetadata(role);
    const label = await findOrCreateIssueLabel(client, name, team.id, summary, {
      description: metadata?.description,
      color: metadata?.color,
      ...(metadata?.groupKey === WORK_TYPE_LABEL_GROUP.key ? { parentId: workTypeGroup.id } : {}),
    });
    issueLabels[name] = label.id;
  }

  const projectStatuses = await resolveProjectStatusMappingsWithRepair({
    client,
    config,
    cache,
    failClosed: true,
    ensureNeedsPrincipalProjectStatus,
  });
  const workflowStates = await client.listWorkflowStates?.(team.id);
  if (!workflowStates) {
    throw new Error("Linear client must provide listWorkflowStates to provision issue statuses.");
  }
  const issueStatuses = {};
  for (const role of ISSUE_STATUS_ROLES) {
    const statusConfig = config.linear.issue.statuses[role];
    if (!statusConfig) throw new Error(`Linear issue status role ${role} is not configured.`);
    const status = await findOrCreateWorkflowState(client, {
      role,
      statusConfig,
      statusConfigs: config.linear.issue.statuses,
      teamId: team.id,
      states: workflowStates,
      summary,
      cache,
    });
    issueStatuses[role] = status.id;
  }

  await guardLegacyCutoverArtifacts({ client, config, cache, teamId: team.id, summary });

  const nextCache = {
    teamId: team.id,
    teamKey: team.key,
    projectStatuses: Object.fromEntries(
      Object.entries(projectStatuses).map(([key, value]) => [key, value.id]),
    ),
    projectStatusTypes: Object.fromEntries(
      Object.entries(projectStatuses).map(([key, value]) => [key, value.type]),
    ),
    issueStatuses,
    projectLabels,
    issueLabels,
    app_identity_id: appIdentity.id,
    app_identity_name: appIdentity.name,
  };

  await writeCache?.(nextCache);
  return { ok: summary.failed.length === 0, summary, cache: nextCache };
}

async function resolveProjectStatusMappingsWithRepair({
  client,
  config,
  cache,
  failClosed,
  ensureNeedsPrincipalProjectStatus,
}) {
  try {
    return await resolveProjectStatusMappings({ client, config, cache, failClosed });
  } catch (error) {
    if (!isNeedsPrincipalProjectStatusRepairError(error) || typeof ensureNeedsPrincipalProjectStatus !== "function") {
      throw error;
    }
    const status = await ensureNeedsPrincipalProjectStatus({ client, config, cache, error });
    return await resolveProjectStatusMappings({
      client,
      config,
      cache: cacheWithNeedsPrincipalProjectStatus({ cache, status }),
      failClosed,
    });
  }
}

function cacheWithNeedsPrincipalProjectStatus({ cache = null, status = null } = {}) {
  if (!status?.id) return cache;
  return {
    ...(cache || {}),
    projectStatuses: {
      ...(cache?.projectStatuses || {}),
      [PROJECT_NEEDS_PRINCIPAL_ROLE]: status.id,
    },
    projectStatusTypes: {
      ...(cache?.projectStatusTypes || {}),
      [PROJECT_NEEDS_PRINCIPAL_ROLE]: status.type,
    },
  };
}

function isNeedsPrincipalProjectStatusRepairError(error) {
  return error?.code === PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR_CODE;
}

async function resolveSetupAppIdentity(client) {
  if (typeof client?.verifyAuth !== "function") {
    throw new Error("Linear setup requires app-authored OAuth verification.");
  }
  const result = await client.verifyAuth();
  if (typeof result?.viewerId !== "string" || result.viewerId.trim() === "") {
    throw new Error("Linear setup could not resolve the app viewer id.");
  }
  return {
    id: result.viewerId.trim(),
    name: typeof result.viewerName === "string" && result.viewerName.trim() !== ""
      ? result.viewerName.trim()
      : null,
  };
}

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);
const DEFAULT_WORKFLOW_STATE_COLOR = "#f2c94c";
const PRINCIPAL_ESCALATION_DESCRIPTION =
  "An agent hit a decision only a human can make. Read the latest comment and move the issue when you've answered.";
const PRINCIPAL_ESCALATION_COLOR = "#F2994A";
const LEGACY_HUMAN_REVIEW_WORKFLOW_STATE_NAME = "Human Review";
const WORKFLOW_STATE_POSITION_INCREMENT = 0.01;

function issueStatusMetadata(role) {
  if (role !== "needs_principal") return null;
  return {
    color: PRINCIPAL_ESCALATION_COLOR,
    description: PRINCIPAL_ESCALATION_DESCRIPTION,
  };
}

async function findOrCreateWorkflowState(
  client,
  { role, statusConfig, statusConfigs, teamId, states, summary, cache },
) {
  const { name, type } = statusConfig;
  const cachedId = cache?.issueStatuses?.[role];
  if (cachedId) {
    const cachedMatches = states.filter((state) => state.id === cachedId);
    if (cachedMatches.length === 0) {
      throw new Error(`Cached Linear issue workflow state ${role}=${cachedId} no longer exists.`);
    }
    if (cachedMatches.length > 1) {
      throw new Error(`Cached Linear issue workflow state ${role}=${cachedId} is ambiguous: found ${cachedMatches.length}.`);
    }
    return reconcileWorkflowState(client, role, cachedMatches[0], statusConfig, states, summary);
  }

  if (role === "human_review") {
    const configuredMatches = states.filter((state) => state.name === name);
    const legacyMatches = states.filter((state) => state.name === LEGACY_HUMAN_REVIEW_WORKFLOW_STATE_NAME);
    if (configuredMatches.length > 0 && legacyMatches.length > 0) {
      throw new Error(
        `Cannot safely resolve Linear issue workflow state ${name}: both ${name} and ${LEGACY_HUMAN_REVIEW_WORKFLOW_STATE_NAME} exist without a cached id.`,
      );
    }
    if (legacyMatches.length > 1) {
      throw new Error(`Multiple Linear issue workflow states found named ${LEGACY_HUMAN_REVIEW_WORKFLOW_STATE_NAME}.`);
    }
    if (legacyMatches.length === 1) {
      return reconcileWorkflowState(client, role, legacyMatches[0], statusConfig, states, summary);
    }
  }

  const nameMatches = states.filter((state) => state.name === name);
  if (nameMatches.length > 1) {
    throw new Error(`Multiple Linear issue workflow states found named ${name}.`);
  }
  if (nameMatches.length === 1) {
    return reconcileWorkflowState(client, role, nameMatches[0], statusConfig, states, summary);
  }

  const metadata = issueStatusMetadata(role);
  const input = {
    name,
    type,
    teamId,
    color: metadata?.color || DEFAULT_WORKFLOW_STATE_COLOR,
    ...(metadata?.description ? { description: metadata.description } : {}),
  };
  const position = workflowStatePositionAfterInProgress(states, statusConfigs);
  if (role === "needs_principal" && position !== null) {
    input.position = position;
  }
  const state = await client.createWorkflowState(input);
  if (!states.some((candidate) => candidate.id === state.id)) {
    states.push(state);
  }
  summary.created.push(`issue-status:${name}`);
  if (role === "needs_principal" && position === null) {
    summary.notes.push("Principal Escalation was created. In Linear, drag it just after In Progress.");
  }
  return state;
}

async function reconcileWorkflowState(client, role, state, { name, type }, states, summary) {
  if (state.type !== type) {
    throw new Error(`Linear issue workflow state ${state.name} has type ${state.type}, expected ${type}.`);
  }
  const metadata = issueStatusMetadata(role);
  const patch = {};
  if (role === "human_review" && state.name !== name) {
    const duplicates = states.filter((candidate) => candidate.id !== state.id && candidate.name === name);
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot safely rename Linear issue workflow state ${state.name} to ${name}: ${name} already exists.`,
      );
    }
    patch.name = name;
  }
  if (metadata && descriptionDiffers(state.description, metadata.description)) {
    patch.description = metadata.description;
  }
  if (Object.keys(patch).length === 0) {
    summary.found.push(`issue-status:${name}`);
    return state;
  }
  if (typeof client.updateWorkflowState !== "function") {
    throw new Error(`Cannot reconcile Linear issue workflow state ${state.name}: client cannot update workflow states.`);
  }
  const updated = await client.updateWorkflowState(state.id, patch);
  const index = states.findIndex((candidate) => candidate.id === state.id);
  if (index >= 0) states[index] = updated;
  summary.updated.push(`issue-status:${name}`);
  return updated;
}

function descriptionDiffers(current, canonical) {
  if (typeof canonical !== "string" || canonical === "") return false;
  return (current || "") !== canonical;
}

function workflowStatePositionAfterInProgress(states, statusConfigs) {
  const inProgressConfig = statusConfigs?.in_progress;
  if (!inProgressConfig) return null;
  const matches = states.filter(
    (state) => state.name === inProgressConfig.name && state.type === inProgressConfig.type,
  );
  if (matches.length !== 1) return null;
  const position = Number(matches[0].position);
  if (!Number.isFinite(position)) return null;
  return position + WORKFLOW_STATE_POSITION_INCREMENT;
}

async function guardLegacyCutoverArtifacts({ client, config, cache, teamId, summary }) {
  const artifacts = legacyCutoverArtifacts({ config, cache });
  if (artifacts.length === 0) return;

  for (const artifact of artifacts) {
    let occupants = [];
    try {
      occupants = await listLegacyArtifactOccupants({ client, teamId, artifact });
    } catch (error) {
      pushLegacyGuardWarning(
        summary,
        artifact,
        `Could not check legacy ${artifact.label} before archiving it: ${error.message}. It was left in place.`,
      );
      continue;
    }

    if (occupants.length > 0) {
      pushLegacyGuardWarning(
        summary,
        artifact,
        `Legacy ${artifact.label} still has issues: ${formatIssueIdentifiers(occupants)}. ${LEGACY_LOOP_COPY}`,
      );
      continue;
    }

    if (artifact.configured) continue;

    try {
      await artifact.archive(client);
      summary.updated.push(`archived-legacy:${artifact.kind}:${artifact.name}`);
    } catch (error) {
      pushLegacyGuardWarning(
        summary,
        artifact,
        `Legacy ${artifact.label} is empty but Linear refused to archive it: ${error.message}. It was left in place.`,
      );
    }
  }
}

const LEGACY_LOOP_COPY = "Answer it, move it, remove the old label by hand.";

function legacyCutoverArtifacts({ config, cache }) {
  const artifacts = [];
  const blockedStateId = stringOrNull(cache?.issueStatuses?.blocked);
  if (blockedStateId) {
    artifacts.push({
      kind: "issue-status",
      name: "Blocked",
      label: "Blocked issue status",
      id: blockedStateId,
      configured: ISSUE_STATUS_ROLES.includes("blocked"),
      issueFilter: { stateId: blockedStateId },
      archive: (client) => client.archiveWorkflowState(blockedStateId),
    });
  }

  const legacyLabel = legacyNeedsPrincipalLabel({ config, cache });
  if (legacyLabel?.id) {
    artifacts.push({
      kind: "issue-label",
      name: legacyLabel.name,
      label: `issue label "${legacyLabel.name}"`,
      id: legacyLabel.id,
      configured: legacyLabel.configured,
      issueFilter: { labelId: legacyLabel.id },
      archive: (client) => client.archiveIssueLabel(legacyLabel.id),
    });
  }

  return artifacts;
}

function legacyNeedsPrincipalLabel({ config, cache }) {
  const issueLabels = cache?.issueLabels && typeof cache.issueLabels === "object" && !Array.isArray(cache.issueLabels)
    ? cache.issueLabels
    : {};
  const configuredNames = new Set(issueLabelRoles(config).map(({ name }) => name));
  const staleEntries = Object.entries(issueLabels)
    .map(([name, id]) => [stringOrNull(name), stringOrNull(id)])
    .filter(([name, id]) => name && id && !configuredNames.has(name));
  if (staleEntries.length === 0) return null;
  if (staleEntries.length > 1) {
    const names = staleEntries.map(([name]) => name).join(", ");
    throw new Error(`Cannot derive the legacy Needs Principal label from cache: unconfigured cached labels are ${names}.`);
  }
  const [[name, id]] = staleEntries;
  return {
    name,
    id,
    configured: false,
  };
}

async function listLegacyArtifactOccupants({ client, teamId, artifact }) {
  if (typeof client?.listIssues !== "function") {
    throw new Error("Linear client cannot list issues.");
  }
  return client.listIssues({
    teamId,
    ...artifact.issueFilter,
  });
}

function pushLegacyGuardWarning(summary, artifact, message) {
  const check = doctorCheck({
    name: `legacy ${artifact.label}`,
    state: "warn",
    message,
    showMessage: true,
  });
  summary.doctorChecks.push(check);
  summary.notes.push(`${check.name}: ${message}`);
}

function formatIssueIdentifiers(issues = []) {
  return issues.map(issueIdentifier).join(", ");
}

function issueIdentifier(issue) {
  return stringOrNull(issue?.identifier) || stringOrNull(issue?.key) || stringOrNull(issue?.id) || "unknown issue";
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function cachedLinearTeam(client, teamId) {
  const teams = await client.listTeams();
  const team = teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    throw new Error(`Cached Linear team ${teamId} no longer exists.`);
  }
  return team;
}
