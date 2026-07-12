import { formatCommand } from "./cli/operator-output.mjs";

export function createDomainConfinedPlanningMutations({ client, context, createError } = {}) {
  if (!client || typeof client !== "object") throw new Error("planning_mutation_client_required");
  if (typeof createError !== "function") throw new Error("planning_mutation_error_factory_required");
  const teamId = nonEmptyString(context?.linear?.teamId);
  if (!teamId) throw createError(
    "project_domain_unresolved",
    "Teami could not resolve the Linear team mutation boundary, so it changed nothing.",
    `Run ${formatCommand("doctor")}, resolve the intended domain, then retry.`,
  );

  return Object.freeze({
    async createProject(input = {}) {
      return client.createProject({ ...input, teamIds: [teamId] });
    },
    async updateProject(projectId, patch = {}) {
      await assertProjectInResolvedDomain({ client, teamId, projectId, createError });
      return client.updateProject(projectId, patch);
    },
  });
}

async function assertProjectInResolvedDomain({ client, teamId, projectId, createError } = {}) {
  const readProject = typeof client?.getProject === "function"
    ? client.getProject.bind(client)
    : typeof client?.getProjectContext === "function"
      ? client.getProjectContext.bind(client)
      : null;
  if (!readProject) {
    throw createError(
      "project_domain_validation_unavailable",
      "Teami could not verify which team owns that project, so it left the project unchanged.",
      `Run ${formatCommand("doctor")}, repair the Linear connection, then retry.`,
    );
  }
  let project;
  try {
    project = await readProject(projectId);
  } catch (error) {
    if (!isProjectNotFoundError(error)) throw error;
    throw projectNotFoundError(createError);
  }
  if (!project?.id) throw projectNotFoundError(createError);
  const teamIds = normalizedProjectTeamIds(project);
  if (teamIds.length === 0) {
    throw createError(
      "project_domain_unresolved",
      "Teami could not verify that this project belongs to the resolved team, so it left the project unchanged.",
      "Choose a project owned by that Linear team, or resolve the intended Teami domain and retry.",
    );
  }
  if (teamIds.length !== 1) {
    throw createError(
      "project_domain_ambiguous",
      "That project belongs to multiple Linear teams, so Teami cannot safely change it and left it unchanged.",
      "Use a project owned only by the resolved Teami team, then retry.",
    );
  }
  if (teamIds[0] !== teamId) {
    throw createError(
      "project_outside_domain",
      "That project belongs to a different Linear team, so Teami left it unchanged.",
      "Resolve the project's Teami domain, or choose a project in the currently resolved team.",
    );
  }
  return project;
}

function normalizedProjectTeamIds(project) {
  const candidates = Array.isArray(project?.teamIds)
    ? project.teamIds
    : Array.isArray(project?.teams)
      ? project.teams.map((team) => team?.id)
      : [];
  return [...new Set(candidates.map(nonEmptyString).filter(Boolean))];
}

function isProjectNotFoundError(error) {
  return /Linear project .* (?:was )?not found/i.test(String(error?.message || error || ""));
}

function projectNotFoundError(createError) {
  return createError(
    "project_not_found",
    "Teami could not find that Linear project in the authorized workspace, so nothing was changed.",
    "Check the project link or id, then retry.",
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
