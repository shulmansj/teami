import {
  projectLabelNames,
  projectTemplateData,
  resolveLabelByNameOrId,
  templateHasRequiredBody,
  uniqueOrThrow,
} from "./matching-utils.mjs";

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);

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
  const projectLabelName = projectLabelNames(config)[0];
  const discoveryLabelName = config.linear.issue.labels.discovery;
  const needsPrincipalLabelName = config.linear.issue.labels.needs_principal;
  const workTypeCodeLabelName = config.linear.issue.labels.work_type_code;
  const workTypeNonCodeLabelName = config.linear.issue.labels.work_type_non_code;
  const hasOpenQuestionsLabel = await resolveLabelByNameOrId({
    list: await client.findProjectLabelsByName(projectLabelName),
    id: cache?.projectLabels?.[projectLabelName],
    label: projectLabelName,
  });
  const discoveryLabel = await resolveIssueLabelByConfiguredNameOrCachedId({
    client,
    teamId: team.id,
    name: discoveryLabelName,
    id: cache?.issueLabels?.[discoveryLabelName],
    semanticName: "discovery",
    requireCachedId: Boolean(cache),
  });
  const needsPrincipalLabel = needsPrincipalLabelName
    ? await resolveIssueLabelByConfiguredNameOrCachedId({
        client,
        teamId: team.id,
        name: needsPrincipalLabelName,
        id: cache?.issueLabels?.[needsPrincipalLabelName],
        semanticName: "needs_principal",
        requireCachedId: Boolean(cache),
      })
    : null;
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
  const templates = await client.findTemplatesByName(
    config.linear.project.template_name,
    "project",
    team.id,
  );
  const projectTemplate = uniqueOrThrow(
    templates.filter(
      (template) =>
        template.id === cache?.projectTemplateId ||
        template.name === config.linear.project.template_name,
    ),
    "project template",
  );

  return {
    team,
    projectTemplate,
    projectStatuses: statuses,
    issueStatuses,
    projectLabels: {
      hasOpenQuestions: hasOpenQuestionsLabel,
    },
    issueLabels: {
      discovery: discoveryLabel,
      ...(needsPrincipalLabel ? { needs_principal: needsPrincipalLabel } : {}),
      ...(workTypeCodeLabel ? { work_type_code: workTypeCodeLabel } : {}),
      ...(workTypeNonCodeLabel ? { work_type_non_code: workTypeNonCodeLabel } : {}),
    },
  };
}

export async function resolveProjectStatusMappings({ client, config, cache, failClosed }) {
  const statuses = await client.listProjectStatuses();
  const result = {};

  for (const [semanticName, configuredStatus] of Object.entries(config.linear.project.statuses)) {
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

    const matches = statuses.filter((status) => status.type === nativeType);
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
    blocked: null,
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
// is the Blocked workflow state plus the Needs Principal reason label.
export async function resolveNeedsPrincipalIssueStatus(
  client,
  config,
  teamId,
  cache = null,
  states = undefined,
) {
  const resolvedStates = states !== undefined ? states : await client.listWorkflowStates?.(teamId);
  if (!resolvedStates) {
    throw new Error("Cannot resolve Linear issue status blocked: client cannot list workflow states.");
  }

  const configuredStatus = config?.linear?.issue?.statuses?.blocked;
  const stateId = cache?.issueStatuses?.blocked;
  if (!stateId) {
    throw new Error("Cached Linear issue status blocked is missing.");
  }
  const state = resolvedStates.find((candidate) => candidate.id === stateId);
  if (!state) {
    throw new Error(`Cached Linear issue status blocked=${stateId} no longer exists.`);
  }
  if (configuredStatus?.type && state.type !== configuredStatus.type) {
    throw new Error(
      `Cached Linear issue status blocked has type ${state.type}, expected ${configuredStatus.type}.`,
    );
  }

  const labelName = config?.linear?.issue?.labels?.needs_principal;
  if (!labelName) {
    throw new Error("Linear issue label needs_principal is not configured.");
  }
  const labelId = cache?.issueLabels?.[labelName];
  if (!labelId) {
    throw new Error(`Cached Linear issue label ${labelName} is missing.`);
  }
  const label = await resolveIssueLabelByCachedId({
    client,
    teamId,
    id: labelId,
    name: labelName,
    semanticName: "needs_principal",
  });

  return needsPrincipalIssueTargetFromParts(
    { ...state, resolution: "stable_id" },
    { ...label, resolution: "stable_id" },
  );
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

export function needsPrincipalIssueTargetFromParts(status, label) {
  if (!status?.id || !label?.id) return null;
  return {
    ...status,
    id: status.id,
    targetType: "status",
    targetId: status.id,
    stateId: status.id,
    statusId: status.id,
    labelId: label.id,
    state: status,
    label,
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

export async function findOrCreateProjectLabel(client, name, summary) {
  const matches = await client.findProjectLabelsByName(name);
  if (matches.length > 1) throw new Error(`Multiple Linear project labels found named ${name}`);
  if (matches.length === 1) {
    summary.found.push(`project-label:${name}`);
    return matches[0];
  }
  const label = await client.createProjectLabel({ name });
  summary.created.push(`project-label:${name}`);
  return label;
}

export async function findOrCreateIssueLabel(client, name, teamId, summary) {
  const matches = await client.findIssueLabelsByName(name, teamId);
  if (matches.length > 1) throw new Error(`Multiple Linear issue labels found named ${name}`);
  if (matches.length === 1) {
    summary.found.push(`issue-label:${name}`);
    return matches[0];
  }
  const label = await client.createIssueLabel({ name, teamId });
  summary.created.push(`issue-label:${name}`);
  return label;
}

export async function findOrCreateProjectTemplate(client, config, teamId, summary) {
  const templateName = config.linear.project.template_name;
  const matches = await client.findTemplatesByName(templateName, "project", teamId);
  if (matches.length > 1) throw new Error(`Multiple Linear project templates found named ${templateName}`);

  const templateData = projectTemplateData();
  if (matches.length === 0) {
    const template = await client.createTemplate({
      name: templateName,
      type: "project",
      teamId,
      templateData,
      description: "Template for Linear projects that decompose into execution issues.",
    });
    summary.created.push(`project-template:${templateName}`);
    return template;
  }

  const template = matches[0];
  if (!templateHasRequiredBody(template)) {
    const updated = await client.updateTemplate(template.id, { templateData });
    summary.updated.push(`project-template:${templateName}`);
    return updated;
  }

  summary.found.push(`project-template:${templateName}`);
  return template;
}
