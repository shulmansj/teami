import { hasRunIdLine } from "../../../engine/engine-markdown.mjs";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const LABEL_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

const TEAM_FIELDS = `
  id
  key
  name
  description
`;

const PROJECT_LABEL_FIELDS = `
  id
  name
`;

const ISSUE_LABEL_FIELDS = `
  id
  name
  team {
    id
  }
`;

const PROJECT_STATUS_FIELDS = `
  id
  name
  type
`;

const WORKFLOW_STATE_FIELDS = `
  id
  name
  type
  team {
    id
  }
`;

const TEMPLATE_FIELDS = `
  id
  type
  name
  description
  templateData
  team {
    id
  }
`;

const WEBHOOK_FIELDS = `
  id
  url
  label
  enabled
  allPublicTeams
  resourceTypes
  team {
    id
    key
    name
  }
`;

const RELATED_ISSUE_FIELDS = `
  id
  identifier
  title
  url
`;

const ISSUE_RELATION_FIELDS = `
  id
  type
  issue {
    ${RELATED_ISSUE_FIELDS}
  }
  relatedIssue {
    ${RELATED_ISSUE_FIELDS}
  }
`;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  team {
    id
    key
    name
  }
  project {
    id
    name
    url
  }
  assignee {
    id
    name
  }
  state {
    id
    name
    type
  }
  labels(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${ISSUE_LABEL_FIELDS}
    }
  }
`;

const ISSUE_WITH_RELATIONS_FIELDS = `
  ${ISSUE_FIELDS}
  relations(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${ISSUE_RELATION_FIELDS}
    }
  }
  inverseRelations(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${ISSUE_RELATION_FIELDS}
    }
  }
`;

const PROJECT_FIELDS = `
  id
  name
  url
  description
  content
  status {
    ${PROJECT_STATUS_FIELDS}
  }
  labels(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${PROJECT_LABEL_FIELDS}
    }
  }
  teams(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${TEAM_FIELDS}
    }
  }
`;

export function createLinearGraphqlClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  tokenProvider,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Linear GraphQL client requires a fetch implementation.");
  }
  if (typeof tokenProvider !== "function") {
    throw new Error("Linear GraphQL client requires an OAuth token provider.");
  }

  async function request(query, variables = {}) {
    const token = await tokenProvider();
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("Linear GraphQL OAuth token is missing.");
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      },
      requestTimeoutMs,
    );
    const payload = await parseGraphqlResponse(response);

    if (!response.ok) {
      throw linearGraphqlRequestError(
        `Linear GraphQL request failed with HTTP ${response.status}: ${graphqlErrorMessage(payload)}`,
        payload,
        response.status,
      );
    }
    if (payload.errors?.length) {
      throw linearGraphqlRequestError(
        `Linear GraphQL request failed: ${graphqlErrorMessage(payload)}`,
        payload,
      );
    }
    if (!payload.data) {
      throw new Error("Linear GraphQL response did not include data.");
    }

    return payload.data;
  }

  async function verifyAuth() {
    const data = await request(`
        query VerifyLinearAuth {
          viewer {
            id
          }
        }
      `);
    if (!data.viewer?.id) throw new Error("Linear GraphQL auth verification failed.");
    return { ok: true, viewerId: data.viewer.id };
  }

  async function getOrganization() {
    const data = await request(`
        query LinearOrganization {
          organization {
            id
            name
            urlKey
          }
        }
      `);
    if (!data.organization?.id) throw new Error("Linear organization was not returned.");
    return {
      id: data.organization.id,
      name: data.organization.name || null,
      urlKey: data.organization.urlKey || null,
    };
  }

  async function listTeams() {
    return paginateConnection({
      query: `
        query LinearTeams($after: String, $first: Int!) {
          teams(first: $first, after: $after, includeArchived: false) {
            nodes {
              ${TEAM_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      getConnection: (data) => data.teams,
      normalize: normalizeTeam,
    });
  }

  async function createTeam(input = {}) {
    const data = await request(
      `
        mutation CreateTeam($input: TeamCreateInput!) {
          teamCreate(input: $input) {
            success
            team {
              ${TEAM_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          key: input.key,
          name: input.name,
          description: input.description,
        }),
      },
    );
    return requirePayload(data.teamCreate, "team", normalizeTeam, "Linear team creation");
  }

  async function findProjectLabelsByName(name) {
    const filter = name ? { name: { eq: name } } : null;
    return paginateConnection({
      query: `
        query ProjectLabels($after: String, $first: Int!, $filter: ProjectLabelFilter) {
          projectLabels(first: $first, after: $after, includeArchived: false, filter: $filter) {
            nodes {
              ${PROJECT_LABEL_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: { filter },
      getConnection: (data) => data.projectLabels,
      normalize: normalizeProjectLabel,
    });
  }

  async function createProjectLabel(input = {}) {
    const data = await request(
      `
        mutation CreateProjectLabel($input: ProjectLabelCreateInput!) {
          projectLabelCreate(input: $input) {
            success
            projectLabel {
              ${PROJECT_LABEL_FIELDS}
            }
          }
        }
      `,
      { input: pickDefined({ name: input.name, description: input.description, color: input.color }) },
    );
    return requirePayload(
      data.projectLabelCreate,
      "projectLabel",
      normalizeProjectLabel,
      "Linear project label creation",
    );
  }

  async function findIssueLabelsByName(name, teamId) {
    const filter = pickDefined({
      ...(name ? { name: { eq: name } } : {}),
      ...(teamId ? { team: { id: { eq: teamId } } } : {}),
    });
    return paginateConnection({
      query: `
        query IssueLabels($after: String, $first: Int!, $filter: IssueLabelFilter) {
          issueLabels(first: $first, after: $after, includeArchived: false, filter: $filter) {
            nodes {
              ${ISSUE_LABEL_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: { filter: Object.keys(filter).length ? filter : null },
      getConnection: (data) => data.issueLabels,
      normalize: normalizeIssueLabel,
    });
  }

  async function createIssueLabel(input = {}) {
    const data = await request(
      `
        mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) {
            success
            issueLabel {
              ${ISSUE_LABEL_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          name: input.name,
          teamId: input.teamId,
          description: input.description,
          color: input.color,
        }),
      },
    );
    return requirePayload(
      data.issueLabelCreate,
      "issueLabel",
      normalizeIssueLabel,
      "Linear issue label creation",
    );
  }

  async function listProjectStatuses() {
    return paginateConnection({
      query: `
        query ProjectStatuses($after: String, $first: Int!) {
          projectStatuses(first: $first, after: $after, includeArchived: false) {
            nodes {
              ${PROJECT_STATUS_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      getConnection: (data) => data.projectStatuses,
      normalize: normalizeProjectStatus,
    });
  }

  async function listWebhooks({ teamId = null } = {}) {
    return paginateConnection({
      query: `
        query Webhooks($after: String, $first: Int!) {
          webhooks(first: $first, after: $after) {
            nodes {
              ${WEBHOOK_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      getConnection: (data) => data.webhooks,
      normalize: normalizeWebhook,
    }).then((webhooks) => webhooks.filter((webhook) => !teamId || webhook.teamId === teamId));
  }

  async function createWebhook(input = {}) {
    const data = await request(
      `
        mutation CreateWebhook($input: WebhookCreateInput!) {
          webhookCreate(input: $input) {
            success
            webhook {
              ${WEBHOOK_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          url: input.url,
          label: input.label,
          teamId: input.teamId,
          allPublicTeams: input.allPublicTeams,
          resourceTypes: input.resourceTypes,
          secret: input.secret,
          enabled: input.enabled,
        }),
      },
    );
    return requirePayload(data.webhookCreate, "webhook", normalizeWebhook, "Linear webhook creation");
  }

  async function updateWebhook(id, input = {}) {
    const data = await request(
      `
        mutation UpdateWebhook($id: String!, $input: WebhookUpdateInput!) {
          webhookUpdate(id: $id, input: $input) {
            success
            webhook {
              ${WEBHOOK_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          url: input.url,
          label: input.label,
          resourceTypes: input.resourceTypes,
          secret: input.secret,
          enabled: input.enabled,
        }),
      },
    );
    return requirePayload(data.webhookUpdate, "webhook", normalizeWebhook, "Linear webhook update");
  }

  async function deleteWebhook(id) {
    const data = await request(
      `
        mutation DeleteWebhook($id: String!) {
          webhookDelete(id: $id) {
            success
          }
        }
      `,
      { id },
    );
    if (data.webhookDelete?.success !== true) throw new Error("Linear webhook deletion failed.");
    return { ok: true };
  }

  async function listWorkflowStates(teamId) {
    const filter = teamId ? { team: { id: { eq: teamId } } } : null;
    return paginateConnection({
      query: `
        query WorkflowStates($after: String, $first: Int!, $filter: WorkflowStateFilter) {
          workflowStates(first: $first, after: $after, includeArchived: false, filter: $filter) {
            nodes {
              ${WORKFLOW_STATE_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: { filter },
      getConnection: (data) => data.workflowStates,
      normalize: normalizeWorkflowState,
    });
  }

  async function findTemplatesByName(name, type, teamId) {
    const data = await request(`
      query Templates {
        templates {
          ${TEMPLATE_FIELDS}
        }
      }
    `);
    return (data.templates || [])
      .map(normalizeTemplate)
      .filter(
        (template) =>
          (!name || template.name === name) &&
          (!type || template.type === type) &&
          (!teamId || template.teamId === teamId),
      );
  }

  async function createTemplate(input = {}) {
    const data = await request(
      `
        mutation CreateTemplate($input: TemplateCreateInput!) {
          templateCreate(input: $input) {
            success
            template {
              ${TEMPLATE_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          type: input.type,
          teamId: input.teamId,
          name: input.name,
          description: input.description,
          templateData: input.templateData,
        }),
      },
    );
    return requirePayload(data.templateCreate, "template", normalizeTemplate, "Linear template creation");
  }

  async function updateTemplate(id, input = {}) {
    const data = await request(
      `
        mutation UpdateTemplate($id: String!, $input: TemplateUpdateInput!) {
          templateUpdate(id: $id, input: $input) {
            success
            template {
              ${TEMPLATE_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          name: input.name,
          description: input.description,
          teamId: input.teamId,
          templateData: input.templateData,
        }),
      },
    );
    return requirePayload(data.templateUpdate, "template", normalizeTemplate, "Linear template update");
  }

  async function createProject(input = {}) {
    const data = await request(
      `
        mutation CreateProject($input: ProjectCreateInput!) {
          projectCreate(input: $input) {
            success
            project {
              ${PROJECT_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          name: input.name,
          description: input.description,
          content: input.content,
          statusId: input.statusId,
          teamIds: input.teamIds,
          templateId: input.templateId,
          lastAppliedTemplateId: input.lastAppliedTemplateId,
          labelIds: input.labelIds,
        }),
      },
    );
    return normalizeProjectBase(
      requirePayload(data.projectCreate, "project", (project) => project, "Linear project creation"),
    );
  }

  async function updateProject(id, input = {}) {
    const data = await request(
      `
        mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
          projectUpdate(id: $id, input: $input) {
            success
            project {
              ${PROJECT_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          name: input.name,
          description: input.description,
          content: input.content,
          statusId: input.statusId,
          teamIds: input.teamIds,
          labelIds: input.labelIds,
        }),
      },
    );
    return normalizeProjectBase(
      requirePayload(data.projectUpdate, "project", (project) => project, "Linear project update"),
    );
  }

  async function getProjectContext(projectId) {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId is required to load Linear project context.");
    }

    const issues = [];
    let after = null;
    let project = null;
    do {
      const data = await request(
        `
          query ProjectContext($projectId: String!, $after: String, $first: Int!) {
            project(id: $projectId) {
              ${PROJECT_FIELDS}
              issues(first: $first, after: $after, includeArchived: true) {
                nodes {
                  ${ISSUE_FIELDS}
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { projectId, after, first: PAGE_SIZE },
      );
      if (!data.project?.id) throw new Error(`Linear project ${projectId} was not found.`);
      project ||= normalizeProjectBase(data.project);
      issues.push(...(data.project.issues?.nodes || []).map(normalizeIssue));
      after = nextCursor(data.project.issues, "project issues");
    } while (after);

    return { ...project, issues };
  }

  async function listProjectIssues(projectId) {
    return (await getProjectContext(projectId)).issues;
  }

  async function getIssueContext(issueId) {
    if (typeof issueId !== "string" || issueId.trim() === "") {
      throw new Error("issueId is required to load Linear issue context.");
    }
    const data = await request(
      `
        query IssueContext($issueId: String!) {
          issue(id: $issueId) {
            ${ISSUE_WITH_RELATIONS_FIELDS}
          }
        }
      `,
      { issueId },
    );
    if (!data.issue?.id) throw new Error(`Linear issue ${issueId} was not found.`);
    return normalizeIssue(data.issue);
  }

  async function listIssues({ teamId, projectId, query: searchText, includeArchived = false } = {}) {
    const filter = issueFilter({ teamId, projectId, searchText });
    return paginateConnection({
      query: `
        query Issues($after: String, $first: Int!, $includeArchived: Boolean!, $filter: IssueFilter) {
          issues(first: $first, after: $after, includeArchived: $includeArchived, filter: $filter) {
            nodes {
              ${ISSUE_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: { includeArchived, filter },
      getConnection: (data) => data.issues,
      normalize: normalizeIssue,
    });
  }

  async function searchIssues(options = {}) {
    return listIssues(options);
  }

  async function createIssue(input = {}) {
    const data = await request(
      `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              ${ISSUE_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          title: input.title,
          description: input.description,
          teamId: input.teamId,
          projectId: input.projectId,
          stateId: input.stateId,
          assigneeId: input.assigneeId,
          labelIds: input.labelIds,
        }),
      },
    );
    return requirePayload(data.issueCreate, "issue", normalizeIssue, "Linear issue creation");
  }

  async function updateIssue(id, input = {}) {
    const data = await request(
      `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              ${ISSUE_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          title: input.title,
          description: input.description,
          assigneeId: input.assigneeId,
          labelIds: input.labelIds,
          stateId: input.stateId,
          projectId: input.projectId,
        }),
      },
    );
    return requirePayload(data.issueUpdate, "issue", normalizeIssue, "Linear issue update");
  }

  async function findOrCreateIssueRelation(input = {}) {
    const existing = await findIssueRelation(input);
    if (existing) return { created: false, relation: existing };

    const data = await request(
      `
        mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) {
            success
            issueRelation {
              ${ISSUE_RELATION_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          type: input.type,
          issueId: input.issueId,
          relatedIssueId: input.relatedIssueId,
        }),
      },
    );
    const relation = requirePayload(
      data.issueRelationCreate,
      "issueRelation",
      normalizeIssueRelation,
      "Linear issue relation creation",
    );
    return { created: true, relation };
  }

  async function createProjectUpdate({ projectId, body, health, isDiffHidden, runId } = {}) {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId is required to create a Linear project update.");
    }
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error("body is required to create a Linear project update.");
    }

    const input = {
      projectId,
      body,
      ...(health ? { health } : {}),
      ...(typeof isDiffHidden === "boolean" ? { isDiffHidden } : {}),
    };

    const data = await request(
      `
          mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
            projectUpdateCreate(input: $input) {
              success
              projectUpdate {
                id
                body
                health
                url
                archivedAt
                createdAt
                updatedAt
              }
            }
          }
        `,
      { input },
    );
    const result = data.projectUpdateCreate;
    if (!result?.success || !result.projectUpdate?.id) {
      throw new Error("Linear project update creation did not return a created update.");
    }
    return normalizeProjectUpdate(result.projectUpdate, runId);
  }

  async function listProjectUpdates(projectId) {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId is required to list Linear project updates.");
    }

    const updates = [];
    let after = null;
    do {
      const data = await request(
        `
            query ProjectUpdates($projectId: String!, $after: String) {
              project(id: $projectId) {
                projectUpdates(first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
                  nodes {
                    id
                    body
                    health
                    url
                    archivedAt
                    createdAt
                    updatedAt
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          `,
        { projectId, after },
      );
      const connection = data.project?.projectUpdates;
      if (!connection) {
        throw new Error("Linear project update list did not return a project update connection.");
      }
      updates.push(...connection.nodes.map((update) => normalizeProjectUpdate(update)));
      after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);

    return updates;
  }

  async function findProjectUpdateByRunId(projectId, runId) {
    const updates = await listProjectUpdates(projectId);
    return (
      updates.find((update) => update.runId === runId || hasRunIdLine(update.body || "", runId)) ||
      null
    );
  }

  async function findIssueRelation({ issueId, relatedIssueId, type } = {}) {
    if (!issueId || !relatedIssueId || !type) {
      throw new Error("issueId, relatedIssueId, and type are required for Linear issue relations.");
    }
    const issue = await getIssueContext(issueId);
    return (
      (issue.relations || []).find(
        (relation) =>
          relation.type === type &&
          relation.issue?.id === issueId &&
          relation.relatedIssue?.id === relatedIssueId,
      ) || null
    );
  }

  return {
    request,
    verifyAuth,
    getOrganization,
    listTeams,
    createTeam,
    findProjectLabelsByName,
    createProjectLabel,
    findIssueLabelsByName,
    createIssueLabel,
    listProjectStatuses,
    listWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    listWorkflowStates,
    findTemplatesByName,
    createTemplate,
    updateTemplate,
    createProject,
    updateProject,
    getProjectContext,
    listProjectIssues,
    getIssueContext,
    getIssue: getIssueContext,
    listIssues,
    searchIssues,
    createIssue,
    updateIssue,
    findOrCreateIssueRelation,
    createProjectUpdate,
    listProjectUpdates,
    findProjectUpdateByRunId,
  };

  async function paginateConnection({ query, variables = {}, getConnection, normalize }) {
    const results = [];
    let after = null;
    do {
      const data = await request(query, { ...variables, after, first: PAGE_SIZE });
      const connection = getConnection(data);
      if (!connection) throw new Error("Linear GraphQL response did not include a connection.");
      results.push(...(connection.nodes || []).map(normalize));
      after = nextCursor(connection, "connection");
    } while (after);
    return results;
  }
}

function issueFilter({ teamId, projectId, searchText }) {
  const clauses = [];
  if (teamId) clauses.push({ team: { id: { eq: teamId } } });
  if (projectId) clauses.push({ project: { id: { eq: projectId } } });
  if (searchText) {
    clauses.push({
      or: [
        { title: { containsIgnoreCase: searchText } },
        { description: { containsIgnoreCase: searchText } },
      ],
    });
  }
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

function requirePayload(payload, key, normalize, actionLabel) {
  if (!payload?.success || !payload[key]?.id) {
    throw new Error(`${actionLabel} did not return a successful payload.`);
  }
  return normalize(payload[key]);
}

function nextCursor(connection, label) {
  if (!connection?.pageInfo?.hasNextPage) return null;
  if (!connection.pageInfo.endCursor) {
    throw new Error(`Linear GraphQL ${label} pagination did not return an end cursor.`);
  }
  return connection.pageInfo.endCursor;
}

function pickDefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeTeam(team) {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description || null,
  };
}

function normalizeProjectLabel(label) {
  return {
    id: label.id,
    name: label.name,
  };
}

function normalizeIssueLabel(label) {
  return {
    id: label.id,
    name: label.name,
    teamId: label.team?.id || null,
    team: label.team ? { id: label.team.id } : null,
  };
}

function normalizeProjectStatus(status) {
  return {
    id: status.id,
    name: status.name,
    type: status.type,
  };
}

function normalizeWebhook(webhook) {
  return {
    id: webhook.id,
    url: webhook.url,
    label: webhook.label || null,
    enabled: webhook.enabled !== false,
    allPublicTeams: Boolean(webhook.allPublicTeams),
    resourceTypes: webhook.resourceTypes || [],
    teamId: webhook.team?.id || null,
    team: webhook.team ? normalizeTeam(webhook.team) : null,
  };
}

function normalizeWorkflowState(state) {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
    teamId: state.team?.id || null,
  };
}

function normalizeTemplate(template) {
  const templateData = parseTemplateData(template.templateData);
  return {
    id: template.id,
    type: template.type,
    name: template.name,
    description: template.description || null,
    templateData,
    teamId: template.team?.id || null,
    team: template.team ? { id: template.team.id } : null,
  };
}

function parseTemplateData(templateData) {
  if (!templateData) return {};
  if (typeof templateData === "object") return templateData;
  if (typeof templateData !== "string") return {};
  try {
    const parsed = JSON.parse(templateData);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("Linear templateData was not valid JSON.");
  }
}

function normalizeProjectBase(project) {
  const labels = connectionNodes(project.labels).map(normalizeProjectLabel);
  const teams = connectionNodes(project.teams).map(normalizeTeam);
  return {
    id: project.id,
    name: project.name,
    url: project.url || null,
    description: project.description || null,
    content: project.content || "",
    status: project.status ? normalizeProjectStatus(project.status) : null,
    labels,
    teams,
    teamIds: teams.map((team) => team.id),
  };
}

function normalizeIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title || "",
    description: issue.description || "",
    url: issue.url || null,
    teamId: issue.team?.id || null,
    team: issue.team
      ? {
          id: issue.team.id,
          key: issue.team.key || null,
          name: issue.team.name || null,
        }
      : null,
    projectId: issue.project?.id || null,
    project: issue.project
      ? {
          id: issue.project.id,
          name: issue.project.name || null,
          url: issue.project.url || null,
        }
      : null,
    assigneeId: issue.assignee?.id || null,
    assignee: issue.assignee
      ? {
          id: issue.assignee.id,
          name: issue.assignee.name || null,
        }
      : null,
    state: issue.state
      ? {
          id: issue.state.id,
          name: issue.state.name,
          type: issue.state.type,
        }
      : null,
    labels: connectionNodes(issue.labels).map(normalizeIssueLabel),
    relations: dedupeById(
      [
        ...connectionNodes(issue.relations).map(normalizeIssueRelation),
        ...connectionNodes(issue.inverseRelations).map(normalizeIssueRelation),
      ].filter((relation) => relation.id),
    ),
  };
}

function normalizeIssueRelation(relation) {
  return {
    id: relation.id,
    type: relation.type,
    issue: normalizeRelatedIssue(relation.issue),
    relatedIssue: normalizeRelatedIssue(relation.relatedIssue),
  };
}

function normalizeRelatedIssue(issue) {
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title || "",
    url: issue.url || null,
  };
}

function connectionNodes(connection) {
  return connection?.nodes || [];
}

function dedupeById(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function normalizeProjectUpdate(update, runId = undefined) {
  return {
    id: update.id,
    body: update.body || "",
    health: update.health || null,
    url: update.url || null,
    archivedAt: update.archivedAt || null,
    createdAt: update.createdAt || null,
    updatedAt: update.updatedAt || null,
    runId: runId || extractRunId(update.body || ""),
  };
}

function extractRunId(markdown) {
  const match = markdown.match(/^run_id:\s*(\S+)\s*$/m);
  return match?.[1] || null;
}

async function parseGraphqlResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Linear GraphQL response was not valid JSON: ${text.slice(0, 160)}`);
  }
}

function linearGraphqlRequestError(message, payload, status = null) {
  const error = new Error(message);
  if (payload?.errors) error.errors = payload.errors;
  if (payload) error.graphqlPayload = payload;
  if (status) error.httpStatus = status;
  return error;
}

function graphqlErrorMessage(payload) {
  const message = payload.errors
    ?.flatMap((error) => [
      error.extensions?.userPresentableMessage,
      error.message,
    ])
    .filter(Boolean)
    .join("; ");
  return message || "unknown error";
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Linear GraphQL request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
