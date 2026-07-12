import {
  uniqueOrThrow,
} from "./matching-utils.mjs";

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);
const PROJECT_NEEDS_PRINCIPAL_ROLE = "needs_principal";
const PROJECT_NEEDS_PRINCIPAL_TYPE = "planned";
const LEGACY_PAUSED_PROJECT_STATUS_NAME = "Paused";
export const PROJECT_NEEDS_PRINCIPAL_REPAIR_COPY =
  "Re-run `init` from a desktop session with a browser to recreate the Principal Escalation project status (one approval).";

export async function resolveLinearShape({ client, config, cache = null }) {
  const teams = await client.listTeams();
  const team = uniqueOrThrow(
    teams.filter(
      (candidate) => candidate.id === cache?.teamId || candidate.key === config.linear.team.key,
    ),
    "team",
  );

  const statuses = await resolveProjectStatusMappings({ client, config, cache, failClosed: true });
  const issueStatuses = await resolveIssueStatusMappings({
    client,
    config,
    cache,
    teamId: team.id,
    failClosed: true,
  });
  const discoveryLabelName = config.linear.issue.labels.discovery;
  const humanReviewLabelName = config.linear.issue.labels.human_review;
  const workTypeCodeLabelName = config.linear.issue.labels.work_type_code;
  const workTypeNonCodeLabelName = config.linear.issue.labels.work_type_non_code;
  const discoveryLabel = await resolveIssueLabelByConfiguredNameOrCachedId({
    client,
    teamId: team.id,
    name: discoveryLabelName,
    id: cache?.issueLabels?.[discoveryLabelName],
    semanticName: "discovery",
    requireCachedId: Boolean(cache),
  });
  if (!humanReviewLabelName) {
    throw new Error("Linear issue label human_review is not configured.");
  }
  const humanReviewLabel = await resolveIssueLabelByConfiguredNameOrCachedId({
    client,
    teamId: team.id,
    name: humanReviewLabelName,
    id: cache?.issueLabels?.[humanReviewLabelName],
    semanticName: "human_review",
    requireCachedId: Boolean(cache),
  });
  const workTypeCodeLabel = workTypeCodeLabelName
    ? await resolveOptionalIssueLabelByConfiguredNameOrCachedId({
        client,
        teamId: team.id,
        name: workTypeCodeLabelName,
        id: cache?.issueLabels?.[workTypeCodeLabelName],
        semanticName: "work_type_code",
      })
    : null;
  const workTypeNonCodeLabel = workTypeNonCodeLabelName
    ? await resolveOptionalIssueLabelByConfiguredNameOrCachedId({
        client,
        teamId: team.id,
        name: workTypeNonCodeLabelName,
        id: cache?.issueLabels?.[workTypeNonCodeLabelName],
        semanticName: "work_type_non_code",
      })
    : null;
  return {
    team,
    projectStatuses: statuses,
    issueStatuses,
    projectLabels: {},
    issueLabels: {
      discovery: discoveryLabel,
      human_review: humanReviewLabel,
      ...(workTypeCodeLabel ? { work_type_code: workTypeCodeLabel } : {}),
      ...(workTypeNonCodeLabel ? { work_type_non_code: workTypeNonCodeLabel } : {}),
    },
  };
}

export async function resolveProjectStatusMappings({ client, config, cache, failClosed }) {
  const statuses = await client.listProjectStatuses();
  const result = {};
  const configuredStatuses = config?.linear?.project?.statuses || {};
  const nativeTypeExclusions = new Set();

  const needsPrincipalConfig = configuredStatuses[PROJECT_NEEDS_PRINCIPAL_ROLE];
  if (needsPrincipalConfig) {
    const needsPrincipalStatus = resolveNeedsPrincipalProjectStatus({
      statuses,
      configuredStatus: needsPrincipalConfig,
      cachedId: cache?.projectStatuses?.[PROJECT_NEEDS_PRINCIPAL_ROLE],
      failClosed,
    });
    if (needsPrincipalStatus) {
      result[PROJECT_NEEDS_PRINCIPAL_ROLE] = needsPrincipalStatus;
      nativeTypeExclusions.add(needsPrincipalStatus.id);
    }
    for (const status of legacyPausedProjectStatuses(statuses)) {
      nativeTypeExclusions.add(status.id);
    }
  }

  for (const [semanticName, configuredStatus] of Object.entries(configuredStatuses)) {
    if (semanticName === PROJECT_NEEDS_PRINCIPAL_ROLE) continue;
    const nativeType = configuredStatus.type;
    const cachedId = cache?.projectStatuses?.[semanticName];
    if (cachedId) {
      const cachedStatus = statuses.find((status) => status.id === cachedId);
      if (!cachedStatus) {
        throw new Error(`Cached Linear project status ${semanticName}=${cachedId} no longer exists.`);
      }
      if (cachedStatus.type !== nativeType) {
        throw new Error(
          `Cached Linear project status ${semanticName} has type ${cachedStatus.type}, expected ${nativeType}.`,
        );
      }
      result[semanticName] = { ...cachedStatus, resolution: "stable_id" };
      continue;
    }

    const matches = statuses.filter(
      (status) => status.type === nativeType && !nativeTypeExclusions.has(status.id),
    );
    if (matches.length !== 1) {
      if (!failClosed) continue;
      throw new Error(
        `Cannot resolve project status mapping '${semanticName}' by native type '${nativeType}': found ${matches.length}. Configure a stable Linear status ID.`,
      );
    }
    result[semanticName] = { ...matches[0], resolution: "native_type" };
  }

  return result;
}

function resolveNeedsPrincipalProjectStatus({ statuses, configuredStatus, cachedId, failClosed }) {
  if (configuredStatus?.type !== PROJECT_NEEDS_PRINCIPAL_TYPE) {
    throw new Error(
      `Linear project status ${PROJECT_NEEDS_PRINCIPAL_ROLE} must be configured with type ${PROJECT_NEEDS_PRINCIPAL_TYPE}.`,
    );
  }

  if (cachedId) {
    const cachedStatus = statuses.find((status) => status.id === cachedId);
    if (!cachedStatus || isArchivedLinearEntity(cachedStatus)) {
      throw needsPrincipalProjectStatusRepairError(
        `Cached Linear project status ${PROJECT_NEEDS_PRINCIPAL_ROLE}=${cachedId} no longer exists.`,
      );
    }
    assertNeedsPrincipalCachedProjectStatusType(cachedStatus);
    return { ...cachedStatus, resolution: "stable_id" };
  }

  const configuredMatches = statuses.filter(
    (status) => status.name === configuredStatus.name && !isArchivedLinearEntity(status),
  );
  if (configuredMatches.length > 0) {
    if (configuredMatches.length !== 1) {
      if (!failClosed) return null;
      throw new Error(
        `Cannot resolve project status mapping '${PROJECT_NEEDS_PRINCIPAL_ROLE}' by configured name '${configuredStatus.name}': found ${configuredMatches.length}.`,
      );
    }
    assertNeedsPrincipalProjectStatusType(configuredMatches[0], "Configured");
    return { ...configuredMatches[0], resolution: "configured_name" };
  }

  if (!failClosed) return null;
  throw needsPrincipalProjectStatusRepairError(
    `Cannot resolve project status mapping '${PROJECT_NEEDS_PRINCIPAL_ROLE}' by configured name '${configuredStatus.name}'.`,
  );
}

function assertNeedsPrincipalProjectStatusType(status, source) {
  if (status.type === PROJECT_NEEDS_PRINCIPAL_TYPE) return;
  throw new Error(
    `${source} Linear project status ${PROJECT_NEEDS_PRINCIPAL_ROLE} has type ${status.type}, expected ${PROJECT_NEEDS_PRINCIPAL_TYPE}.`,
  );
}

function assertNeedsPrincipalCachedProjectStatusType(status) {
  if (status.type === PROJECT_NEEDS_PRINCIPAL_TYPE) return;
  throw needsPrincipalProjectStatusRepairError(
    `Cached Linear project status ${PROJECT_NEEDS_PRINCIPAL_ROLE} has type ${status.type}, expected ${PROJECT_NEEDS_PRINCIPAL_TYPE}.`,
  );
}

function isArchivedLinearEntity(entity) {
  return entity?.archived === true || entity?.archivedAt;
}

function legacyPausedProjectStatuses(statuses) {
  return statuses.filter(
    (status) => status.name === LEGACY_PAUSED_PROJECT_STATUS_NAME && !isArchivedLinearEntity(status),
  );
}

export function needsPrincipalProjectStatusRepairError(message) {
  const error = new Error(message);
  error.code = "PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR";
  return error;
}

export async function resolveIssueStatusMappings({ client, config, cache = null, teamId, failClosed }) {
  const states = await client.listWorkflowStates?.(teamId);
  if (!states) {
    if (!failClosed) return {};
    throw new Error("Cannot resolve Linear issue statuses: client cannot list workflow states.");
  }
  const result = {};

  for (const semanticName of ISSUE_STATUS_ROLES) {
    const configuredStatus = config?.linear?.issue?.statuses?.[semanticName];
    if (!configuredStatus) {
      if (!failClosed) continue;
      throw new Error(`Linear issue status role ${semanticName} is not configured.`);
    }
    const cachedId = cache?.issueStatuses?.[semanticName];
    if (cachedId) {
      const cachedState = states.find((state) => state.id === cachedId);
      if (!cachedState) {
        throw new Error(`Cached Linear issue status ${semanticName}=${cachedId} no longer exists.`);
      }
      if (cachedState.type !== configuredStatus.type) {
        throw new Error(
          `Cached Linear issue status ${semanticName} has type ${cachedState.type}, expected ${configuredStatus.type}.`,
        );
      }
      result[semanticName] = { ...cachedState, resolution: "stable_id" };
      continue;
    }

    const matches = states.filter((state) => state.name === configuredStatus.name);
    if (matches.length !== 1) {
      if (!failClosed) continue;
      throw new Error(
        `Cannot resolve issue status mapping '${semanticName}' by configured name '${configuredStatus.name}': found ${matches.length}.`,
      );
    }
    if (matches[0].type !== configuredStatus.type) {
      throw new Error(
        `Configured Linear issue status ${semanticName} has type ${matches[0].type}, expected ${configuredStatus.type}.`,
      );
    }
    result[semanticName] = { ...matches[0], resolution: "configured_name" };
  }

  return result;
}

export async function resolveIssueStatuses(client, config, teamId, cache = null, { failClosed = false } = {}) {
  const statuses = {
    backlog: null,
    todo: null,
    in_progress: null,
    in_review: null,
    human_review: null,
    needs_principal: null,
    done: null,
  };

  const mappings = await resolveIssueStatusMappings({
    client,
    config,
    cache,
    teamId,
    failClosed,
  });
  for (const semanticName of Object.keys(statuses)) {
    statuses[semanticName] = mappings[semanticName] || null;
  }

  return statuses;
}

// Resolve ONLY the needs_principal target without touching review
// request-changes target resolution. Cached ids are authoritative: the target
// is the Principal Escalation workflow state.
export async function resolveNeedsPrincipalIssueStatus(
  client,
  config,
  teamId,
  cache = null,
  states = undefined,
) {
  const resolvedStates = states !== undefined ? states : await client.listWorkflowStates?.(teamId);
  if (!resolvedStates) {
    throw new Error("Cannot resolve Linear issue status needs_principal: client cannot list workflow states.");
  }

  const configuredStatus = config?.linear?.issue?.statuses?.needs_principal;
  if (!configuredStatus) {
    throw new Error("Linear issue status needs_principal is not configured.");
  }
  const stateId = cache?.issueStatuses?.needs_principal;
  if (!stateId) {
    throw new Error("Cached Linear issue status needs_principal is missing.");
  }
  const state = resolvedStates.find((candidate) => candidate.id === stateId);
  if (!state) {
    throw new Error(`Cached Linear issue status needs_principal=${stateId} no longer exists.`);
  }
  if (configuredStatus?.type && state.type !== configuredStatus.type) {
    throw new Error(
      `Cached Linear issue status needs_principal has type ${state.type}, expected ${configuredStatus.type}.`,
    );
  }

  return needsPrincipalIssueTargetFromParts({ ...state, resolution: "stable_id" });
}

// Resolve ONLY the in_review status target without touching the review
// request-changes target helper. The cached id is authoritative when present;
// cacheless fixtures can still fall back to the configured status name.
export async function resolveInReviewIssueStatus(client, config, teamId, cache = null) {
  const states = await client.listWorkflowStates?.(teamId);
  if (!states) return null;

  const configuredStatus = config?.linear?.issue?.statuses?.in_review;
  const cachedId = cache?.issueStatuses?.in_review;
  if (cachedId) {
    const cachedState = states.find((state) => state.id === cachedId);
    if (!cachedState) {
      throw new Error(`Cached Linear issue status in_review=${cachedId} no longer exists.`);
    }
    if (configuredStatus?.type && cachedState.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear issue status in_review has type ${cachedState.type}, expected ${configuredStatus.type}.`,
      );
    }
    return { ...cachedState, targetType: "status", resolution: "stable_id" };
  }

  // in_review is optional on cacheless fixtures: a team not yet provisioned for
  // the review function must not crash the gateway's hot poll path. Absence is
  // null, ambiguity still fails loud.
  const inReviewStatus = resolveWorkflowStateByConfiguredName({
    states,
    name: configuredStatus?.name,
    semanticName: "in_review",
    optional: true,
  });
  return inReviewStatus ? { ...inReviewStatus, targetType: "status" } : null;
}

// Resolve ONLY the Todo target for review request-changes routing. This stays
// separate from the canonical issue-creation status resolver while the trigger
// helper names remain frozen.
export async function resolveReadyIssueStatus(client, config, teamId, states = undefined) {
  const resolvedStates = states !== undefined ? states : await client.listWorkflowStates?.(teamId);
  if (!resolvedStates) return null;
  const todoStatus = resolveWorkflowStateByConfiguredName({
    states: resolvedStates,
    name: config.linear.issue?.statuses?.todo?.name,
    semanticName: "Todo",
  });
  return todoStatus ? { ...todoStatus, targetType: "status" } : null;
}

export async function resolveIssueStatusRoleTarget({
  client,
  config,
  shape = null,
  teamId = null,
  cache = null,
  role,
  states = undefined,
  optional = false,
  requireCachedId = Boolean(cache),
} = {}) {
  if (!ISSUE_STATUS_ROLES.includes(role)) {
    throw new Error(`Linear issue status role ${role || "missing"} is not recognized.`);
  }

  const shapeState = shape?.issueStatuses?.[role];
  if (shapeState?.id) return issueStatusTarget(shapeState);

  const configuredStatus = config?.linear?.issue?.statuses?.[role];
  if (!configuredStatus) {
    if (optional) return null;
    throw new Error(`Linear issue status role ${role} is not configured.`);
  }

  const resolvedStates = states !== undefined ? states : await client?.listWorkflowStates?.(teamId);
  if (!resolvedStates) {
    if (optional) return null;
    throw new Error(`Cannot resolve Linear issue status ${role}: client cannot list workflow states.`);
  }

  const cachedId = cache?.issueStatuses?.[role];
  if (cachedId) {
    const cachedState = resolvedStates.find((state) => state.id === cachedId);
    if (!cachedState) {
      throw new Error(`Cached Linear issue status ${role}=${cachedId} no longer exists.`);
    }
    if (configuredStatus.type && cachedState.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear issue status ${role} has type ${cachedState.type}, expected ${configuredStatus.type}.`,
      );
    }
    return issueStatusTarget({ ...cachedState, resolution: "stable_id" });
  }

  if (requireCachedId) {
    throw new Error(`Cached Linear issue status ${role} is missing.`);
  }

  const state = resolveWorkflowStateByConfiguredName({
    states: resolvedStates,
    name: configuredStatus.name,
    semanticName: role,
    optional,
  });
  if (!state) return null;
  if (configuredStatus.type && state.type !== configuredStatus.type) {
    throw new Error(
      `Configured Linear issue status ${role} has type ${state.type}, expected ${configuredStatus.type}.`,
    );
  }
  return issueStatusTarget({ ...state, resolution: "configured_name" });
}

export async function resolveIssueLabelByConfiguredName({ client, teamId, name, semanticName }) {
  if (!name) return null;
  if (typeof client.findIssueLabelsByName !== "function") {
    throw new Error(`Cannot resolve configured ${semanticName} issue label '${name}': client cannot list issue labels.`);
  }
  const matches = await client.findIssueLabelsByName(name, teamId);
  if (matches.length !== 1) {
    throw new Error(`Cannot resolve configured ${semanticName} issue label '${name}': found ${matches.length}.`);
  }
  return matches[0];
}

export async function resolveIssueLabelByConfiguredNameOrCachedId({
  client,
  teamId,
  name,
  id,
  semanticName,
  requireCachedId = false,
}) {
  if (id) {
    return resolveIssueLabelByCachedId({ client, teamId, id, name, semanticName });
  }
  if (requireCachedId) {
    throw new Error(`Cached Linear issue label ${semanticName}${name ? ` (${name})` : ""} is missing.`);
  }
  return resolveIssueLabelByConfiguredName({ client, teamId, name, semanticName });
}

async function resolveOptionalIssueLabelByConfiguredNameOrCachedId({
  client,
  teamId,
  name,
  id,
  semanticName,
}) {
  if (id) {
    return resolveIssueLabelByCachedId({ client, teamId, id, name, semanticName });
  }
  if (!name) return null;
  if (typeof client.findIssueLabelsByName !== "function") {
    throw new Error(`Cannot resolve configured ${semanticName} issue label '${name}': client cannot list issue labels.`);
  }
  const matches = await client.findIssueLabelsByName(name, teamId);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Cannot resolve configured ${semanticName} issue label '${name}': found ${matches.length}.`);
  }
  return matches[0];
}

export async function resolveIssueLabelByCachedId({ client, teamId, id, name = null, semanticName }) {
  if (!id) return null;
  if (typeof client.findIssueLabelsByName !== "function") {
    throw new Error(`Cannot resolve cached ${semanticName} issue label '${id}': client cannot list issue labels.`);
  }
  const labels = await client.findIssueLabelsByName(null, teamId);
  const match = labels.find((label) => label.id === id);
  if (match) return match;

  const namedLabels = name ? await client.findIssueLabelsByName(name, teamId) : [];
  const namedMatch = namedLabels.find((label) => label.id === id);
  if (namedMatch) return namedMatch;

  throw new Error(`Cached Linear issue label ${semanticName}=${id} no longer exists.`);
}

export function needsPrincipalIssueTargetFromParts(status) {
  if (!status?.id) return null;
  return {
    ...status,
    id: status.id,
    targetType: "status",
    targetId: status.id,
    stateId: status.id,
    statusId: status.id,
    state: status,
  };
}

export function resolveWorkflowStateByConfiguredName({ states, name, semanticName, optional = false }) {
  if (!name) return null;
  const matches = states.filter((state) => state.name === name);
  if (matches.length === 1) return matches[0];
  // `optional` lets a caller treat an ABSENT (found 0) status as "this team is
  // not provisioned for that status" -> null, while STILL failing loud on an
  // AMBIGUOUS (found >1) configuration. Required callers (the default) fail
  // closed on either, preserving strict resolution where a status is mandatory.
  if (optional && matches.length === 0) return null;
  throw new Error(`Cannot resolve configured ${semanticName} issue status '${name}': found ${matches.length}.`);
}

function issueStatusTarget(state) {
  return {
    ...state,
    id: state.id,
    targetType: "status",
    targetId: state.id,
    stateId: state.id,
    statusId: state.id,
  };
}

export function stateIdForNewExecutionIssue(_issue, issueStatuses) {
  return issueStatuses.todo?.id;
}

export async function findOrCreateTeam(client, config, cache, summary) {
  const teams = await client.listTeams();
  if (cache?.teamId) {
    const cachedTeam = teams.find((team) => team.id === cache.teamId);
    if (!cachedTeam) {
      throw new Error(`Cached Linear team ${cache.teamId} no longer exists.`);
    }
    if (cachedTeam.key !== config.linear.team.key || cachedTeam.name !== config.linear.team.name) {
      throw new Error(
        `Cached Linear team ${cache.teamId} does not match configured team ${config.linear.team.key}.`,
      );
    }
    summary.found.push(`team:${cachedTeam.key}`);
    return cachedTeam;
  }

  const keyMatches = teams.filter((team) => team.key === config.linear.team.key);
  const nameMatches = teams.filter((team) => team.name === config.linear.team.name);
  if (keyMatches.length > 0 || nameMatches.length > 0) {
    throw new Error(
      `Linear team ${config.linear.team.name} (${config.linear.team.key}) already exists but is not recorded in local setup state.`,
    );
  }

  const team = await client.createTeam(config.linear.team);
  summary.created.push(`team:${team.key}`);
  return team;
}

export async function findOrCreateProjectLabel(client, name, summary, metadata = null) {
  const matches = await client.findProjectLabelsByName(name);
  if (matches.length > 1) throw new Error(`Multiple Linear project labels found named ${name}`);
  if (matches.length === 1) {
    summary.found.push(`project-label:${name}`);
    return reconcileProjectLabelMetadata(client, matches[0], metadata, summary);
  }
  const label = await client.createProjectLabel({
    name,
    description: metadata?.description,
    color: metadata?.color,
  });
  summary.created.push(`project-label:${name}`);
  return label;
}

export async function findOrCreateIssueLabel(client, name, teamId, summary, metadata = null) {
  const matches = await client.findIssueLabelsByName(name, teamId);
  if (matches.length > 1) throw new Error(`Multiple Linear issue labels found named ${name}`);
  if (matches.length === 1) {
    summary.found.push(`issue-label:${name}`);
    return reconcileIssueLabelMetadata(client, matches[0], metadata, summary);
  }
  const label = await client.createIssueLabel({
    name,
    teamId,
    description: metadata?.description,
    color: metadata?.color,
    parentId: metadata?.parentId,
  });
  summary.created.push(`issue-label:${name}`);
  return label;
}

// The group label an issue label can be parented under (e.g. Work type). A
// pre-existing plain label squatting on the group name is a real conflict the
// adopter must resolve, not something to silently adopt: parenting under a
// non-group label is not what the metadata contract promised.
export async function findOrCreateIssueLabelGroup(client, group, teamId, summary) {
  const matches = await client.findIssueLabelsByName(group.name, teamId);
  if (matches.length > 1) throw new Error(`Multiple Linear issue labels found named ${group.name}`);
  if (matches.length === 1) {
    const existing = matches[0];
    if (!existing.isGroup) {
      throw new Error(
        `Linear issue label ${group.name} already exists but is not a label group; rename or remove it so setup can provision the group.`,
      );
    }
    summary.found.push(`issue-label-group:${group.name}`);
    return reconcileIssueLabelMetadata(client, existing, { description: group.description }, summary, {
      summaryKind: "issue-label-group",
    });
  }
  const label = await client.createIssueLabel({
    name: group.name,
    teamId,
    description: group.description,
    color: group.color,
    isGroup: true,
  });
  summary.created.push(`issue-label-group:${group.name}`);
  return label;
}

// Reconcile machinery-owned metadata on a found label: description (it
// documents what the factory does) and group membership (a machinery
// invariant). Color is deliberately NOT reconciled — presentation belongs to
// the adopter, so a recoloring sticks across setup passes.
async function reconcileIssueLabelMetadata(client, label, metadata, summary, { summaryKind = "issue-label" } = {}) {
  const patch = {};
  if (metadata && descriptionDiffers(label.description, metadata.description)) {
    patch.description = metadata.description;
  }
  if (metadata && Object.hasOwn(metadata, "parentId") && (label.parentId || null) !== (metadata.parentId || null)) {
    patch.parentId = metadata.parentId;
  }
  if (Object.keys(patch).length === 0) return label;
  if (typeof client.updateIssueLabel !== "function") {
    throw new Error(`Cannot reconcile Linear issue label ${label.name}: client cannot update issue labels.`);
  }
  const updated = await client.updateIssueLabel(label.id, patch);
  summary.updated.push(`${summaryKind}:${label.name}`);
  return updated;
}

async function reconcileProjectLabelMetadata(client, label, metadata, summary) {
  if (!metadata || !descriptionDiffers(label.description, metadata.description)) return label;
  if (typeof client.updateProjectLabel !== "function") {
    throw new Error(`Cannot reconcile Linear project label ${label.name}: client cannot update project labels.`);
  }
  const updated = await client.updateProjectLabel(label.id, { description: metadata.description });
  summary.updated.push(`project-label:${label.name}`);
  return updated;
}

function descriptionDiffers(current, canonical) {
  if (typeof canonical !== "string" || canonical === "") return false;
  return (current || "") !== canonical;
}
