import {
  issueLabelNames,
  projectLabelNames,
  projectTemplateData,
  resolveLabelByNameOrId,
  templateHasRequiredBody,
  uniqueOrThrow,
} from "./matching-utils.mjs";

export async function resolveLinearShape({ client, config, cache = null }) {
  const teams = await client.listTeams();
  const team = uniqueOrThrow(
    teams.filter(
      (candidate) => candidate.id === cache?.teamId || candidate.key === config.linear.team.key,
    ),
    "team",
  );

  const statuses = await resolveProjectStatusMappings({ client, config, cache, failClosed: true });
  const hasOpenQuestionsLabel = await resolveLabelByNameOrId({
    list: await client.findProjectLabelsByName(projectLabelNames(config)[0]),
    id: cache?.projectLabels?.[projectLabelNames(config)[0]],
    label: projectLabelNames(config)[0],
  });
  const discoveryLabel = await resolveLabelByNameOrId({
    list: await client.findIssueLabelsByName(issueLabelNames(config)[0], team.id),
    id: cache?.issueLabels?.[issueLabelNames(config)[0]],
    label: issueLabelNames(config)[0],
  });
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
    projectLabels: {
      hasOpenQuestions: hasOpenQuestionsLabel,
    },
    issueLabels: {
      discovery: discoveryLabel,
    },
  };
}

export async function resolveProjectStatusMappings({ client, config, cache, failClosed }) {
  const statuses = await client.listProjectStatuses();
  const result = {};

  for (const [semanticName, nativeType] of Object.entries(config.linear.project.status_types)) {
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

export async function resolveIssueStatuses(client, config, teamId) {
  const states = await client.listWorkflowStates?.(teamId);
  if (!states) return { ready: null, unstarted: null };

  return {
    ready: resolveWorkflowStateByConfiguredName({
      states,
      name: config.linear.issue?.statuses?.ready?.name,
      semanticName: "Ready",
    }),
    unstarted: resolveWorkflowStateByConfiguredName({
      states,
      name: config.linear.issue?.statuses?.unstarted?.name,
      semanticName: "unstarted",
    }),
  };
}

export function resolveWorkflowStateByConfiguredName({ states, name, semanticName }) {
  if (!name) return null;
  const matches = states.filter((state) => state.name === name);
  if (matches.length !== 1) {
    throw new Error(`Cannot resolve configured ${semanticName} issue status '${name}': found ${matches.length}.`);
  }
  return matches[0];
}

export function stateIdForNewExecutionIssue(_issue, issueStatuses) {
  return issueStatuses.ready?.id ?? issueStatuses.unstarted?.id;
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
