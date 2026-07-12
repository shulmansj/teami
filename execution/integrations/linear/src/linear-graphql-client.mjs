import { hasRunIdLine } from "../../../engine/engine-markdown.mjs";
import { parseResourceTargetFromDescription } from "./resource-target.mjs";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const LABEL_PAGE_SIZE = 100;
// Ready candidates hydrate relation edges for blocker state; keep this page
// capped below project candidate pages to stay under Linear's 10k complexity cap.
const READY_ISSUE_CANDIDATE_PAGE_SIZE = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const LINEAR_RATE_LIMIT_HEADER_NAMES = [
  "x-ratelimit-requests-remaining",
  "x-ratelimit-requests-reset",
  "x-complexity",
  "x-ratelimit-complexity-limit",
  "x-ratelimit-complexity-remaining",
  "x-ratelimit-complexity-reset",
  "x-ratelimit-endpoint-requests-remaining",
  "x-ratelimit-endpoint-requests-reset",
];

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

// Label CRUD paths (find/create/update) read the metadata fields so setup can
// reconcile description and group membership. Issue/project queries embed the
// lean shapes above instead: every label of every issue would otherwise pay
// the extra query complexity for fields only provisioning consumes.
const PROJECT_LABEL_DETAIL_FIELDS = `
  ${PROJECT_LABEL_FIELDS}
  description
  color
  isGroup
  parent {
    id
  }
`;

const ISSUE_LABEL_DETAIL_FIELDS = `
  ${ISSUE_LABEL_FIELDS}
  description
  color
  isGroup
  parent {
    id
  }
`;

const PROJECT_STATUS_FIELDS = `
  id
  name
  type
  position
`;

const WORKFLOW_STATE_FIELDS = `
  id
  name
  type
  description
  position
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
  state {
    type
  }
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

const ISSUE_COMMENT_FIELDS = `
  id
  body
  createdAt
  updatedAt
  user {
    id
    name
    displayName
  }
`;

const READY_ISSUE_CANDIDATE_FIELDS = `
  id
  identifier
  title
  description
  url
  createdAt
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

const SNAPSHOT_ISSUE_FIELDS = `
  id
  identifier
  title
  state {
    id
    name
    type
  }
  labels(first: ${LABEL_PAGE_SIZE}, includeArchived: true) {
    nodes {
      ${PROJECT_LABEL_FIELDS}
    }
  }
`;

export function isLinearRateLimited(error) {
  return (
    error?.httpStatus === 400 &&
    Array.isArray(error.errors) &&
    error.errors.some((entry) => entry?.extensions?.code === "RATELIMITED")
  );
}

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
    return (await requestWithMeta(query, variables)).data;
  }

  async function requestWithMeta(query, variables = {}) {
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
    const rateLimit = readLinearRateLimitHeaders(response.headers);
    let payload;
    try {
      payload = await parseGraphqlResponse(response);
    } catch (error) {
      error.rateLimit = rateLimit;
      throw error;
    }

    if (!response.ok) {
      throw linearGraphqlRequestError(
        `Linear GraphQL request failed with HTTP ${response.status}: ${graphqlErrorMessage(payload)}`,
        payload,
        response.status,
        rateLimit,
      );
    }
    if (payload.errors?.length) {
      throw linearGraphqlRequestError(
        `Linear GraphQL request failed: ${graphqlErrorMessage(payload)}`,
        payload,
        null,
        rateLimit,
      );
    }
    if (!payload.data) {
      throw new Error("Linear GraphQL response did not include data.");
    }

    return { data: payload.data, rateLimit };
  }

  async function verifyAuth() {
    const data = await request(`
        query VerifyLinearAuth {
          viewer {
            id
            name
          }
        }
      `);
    if (!data.viewer?.id) throw new Error("Linear GraphQL auth verification failed.");
    return { ok: true, viewerId: data.viewer.id, viewerName: data.viewer.name || null };
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
              ${PROJECT_LABEL_DETAIL_FIELDS}
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
              ${PROJECT_LABEL_DETAIL_FIELDS}
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

  async function updateProjectLabel(id, input = {}) {
    const data = await request(
      `
        mutation UpdateProjectLabel($id: String!, $input: ProjectLabelUpdateInput!) {
          projectLabelUpdate(id: $id, input: $input) {
            success
            projectLabel {
              ${PROJECT_LABEL_DETAIL_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          name: input.name,
          description: input.description,
          color: input.color,
        }),
      },
    );
    return requirePayload(
      data.projectLabelUpdate,
      "projectLabel",
      normalizeProjectLabel,
      "Linear project label update",
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
              ${ISSUE_LABEL_DETAIL_FIELDS}
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
              ${ISSUE_LABEL_DETAIL_FIELDS}
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
          parentId: input.parentId,
          isGroup: input.isGroup,
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

  async function updateIssueLabel(id, input = {}) {
    const data = await request(
      `
        mutation UpdateIssueLabel($id: String!, $input: IssueLabelUpdateInput!) {
          issueLabelUpdate(id: $id, input: $input) {
            success
            issueLabel {
              ${ISSUE_LABEL_DETAIL_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          name: input.name,
          description: input.description,
          color: input.color,
          parentId: input.parentId,
          isGroup: input.isGroup,
        }),
      },
    );
    return requirePayload(
      data.issueLabelUpdate,
      "issueLabel",
      normalizeIssueLabel,
      "Linear issue label update",
    );
  }

  async function archiveIssueLabel(id) {
    const data = await request(
      `
        mutation ArchiveIssueLabel($id: String!) {
          issueLabelRetire(id: $id) {
            success
          }
        }
      `,
      { id },
    );
    if (data.issueLabelRetire?.success !== true) throw new Error("Linear issue label archive failed.");
    return { ok: true };
  }

  async function createWorkflowState(input = {}) {
    const data = await request(
      `
        mutation CreateWorkflowState($input: WorkflowStateCreateInput!) {
          workflowStateCreate(input: $input) {
            success
            workflowState {
              ${WORKFLOW_STATE_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          name: input.name,
          type: input.type,
          teamId: input.teamId,
          color: input.color,
          description: input.description,
          position: input.position,
        }),
      },
    );
    return requirePayload(
      data.workflowStateCreate,
      "workflowState",
      normalizeWorkflowState,
      "Linear workflow state creation",
    );
  }

  async function updateWorkflowState(id, input = {}) {
    const data = await request(
      `
        mutation UpdateWorkflowState($id: String!, $input: WorkflowStateUpdateInput!) {
          workflowStateUpdate(id: $id, input: $input) {
            success
            workflowState {
              ${WORKFLOW_STATE_FIELDS}
            }
          }
        }
      `,
      {
        id,
        input: pickDefined({
          name: input.name,
          description: input.description,
          color: input.color,
          position: input.position,
        }),
      },
    );
    return requirePayload(
      data.workflowStateUpdate,
      "workflowState",
      normalizeWorkflowState,
      "Linear workflow state update",
    );
  }

  async function archiveWorkflowState(id) {
    const data = await request(
      `
        mutation ArchiveWorkflowState($id: String!) {
          workflowStateArchive(id: $id) {
            success
          }
        }
      `,
      { id },
    );
    if (data.workflowStateArchive?.success !== true) throw new Error("Linear workflow state archive failed.");
    return { ok: true };
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

  async function createProjectStatus(input = {}) {
    const data = await request(
      `
        mutation CreateProjectStatus($input: ProjectStatusCreateInput!) {
          projectStatusCreate(input: $input) {
            success
            status {
              ${PROJECT_STATUS_FIELDS}
            }
          }
        }
      `,
      {
        input: pickDefined({
          name: input.name,
          color: input.color,
          position: input.position,
          type: input.type,
          description: input.description,
          id: input.id,
          indefinite: input.indefinite,
        }),
      },
    );
    return requirePayload(
      data.projectStatusCreate,
      "status",
      normalizeProjectStatus,
      "Linear project status creation",
    );
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

  async function getTeamGitAutomationSettings(teamId) {
    if (typeof teamId !== "string" || teamId.trim() === "") {
      throw new Error("teamId is required to inspect Linear Git automation settings.");
    }

    const gitAutomationStates = [];
    let after = null;
    let team = null;
    do {
      const data = await request(
        `
          query TeamGitAutomationSettings($teamId: String!, $after: String, $first: Int!) {
            team(id: $teamId) {
              id
              key
              name
              mergeWorkflowState {
                id
                name
                type
              }
              gitAutomationStates(first: $first, after: $after, includeArchived: false) {
                nodes {
                  id
                  event
                  branchPattern
                  state {
                    id
                    name
                    type
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { teamId, after, first: PAGE_SIZE },
      );
      if (!data.team?.id) throw new Error(`Linear team ${teamId} was not returned.`);
      team ||= {
        id: data.team.id,
        key: data.team.key || null,
        name: data.team.name || null,
        mergeWorkflowState: normalizeNullableWorkflowState(data.team.mergeWorkflowState),
      };
      const connection = data.team.gitAutomationStates;
      if (!connection) throw new Error("Linear team git automation settings were not returned.");
      gitAutomationStates.push(...connectionNodes(connection).map(normalizeGitAutomationState));
      after = nextCursor(connection, "team git automation states");
    } while (after);

    return { ...team, gitAutomationStates };
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

  async function getProject(id) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("projectId is required to load a Linear project.");
    }
    const data = await request(
      `
        query ProjectById($projectId: String!) {
          project(id: $projectId) {
            ${PROJECT_FIELDS}
          }
        }
      `,
      { projectId: id },
    );
    if (!data.project?.id) throw new Error(`Linear project ${id} was not found.`);
    return normalizeProjectBase(data.project);
  }

  async function archiveProject(projectId) {
    const data = await request(
      `
        mutation ArchiveProject($id: String!) {
          projectArchive(id: $id) {
            success
            entity {
              ${PROJECT_FIELDS}
            }
          }
        }
      `,
      { id: projectId },
    );
    const payload = data.projectArchive;
    if (payload?.success !== true) throw new Error("Linear project archive failed.");
    if (!payload.entity?.id) throw new Error("Linear project archive did not return an archived project.");
    return normalizeProjectBase(payload.entity);
  }

  async function listPlannedProjectCandidates(teamId, { plannedStateId = null, first = 25, after = null } = {}) {
    if (typeof teamId !== "string" || teamId.trim() === "") {
      throw new Error("teamId is required to list planned Linear project candidates.");
    }
    const { data, rateLimit } = await requestWithMeta(
      `
        query PlannedProjectCandidates($teamId: String!, $after: String, $first: Int!) {
          team(id: $teamId) {
            id
            projects(first: $first, after: $after) {
              nodes {
                id
                name
                status {
                  ${PROJECT_STATUS_FIELDS}
                }
                teams(first: ${LABEL_PAGE_SIZE}) {
                  nodes {
                    id
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { teamId, after, first },
    );
    // Linear's ProjectFilter has no `teams` field and its `state` filter does not
    // filter by status type, so we scope by the team's own projects connection and
    // filter to `planned` client-side (isPlannedProjectCandidateForTeam). Verified
    // against the live API 2026-06-24.
    const projectsConnection = data.team?.projects;
    if (!projectsConnection) {
      throw new Error("Linear planned projects query did not return a team projects connection.");
    }
    return {
      candidates: connectionNodes(projectsConnection)
        .filter((project) => isPlannedProjectCandidateForTeam(project, teamId, plannedStateId))
        .map(normalizePlannedProjectCandidate),
      pageInfo: normalizePageInfo(projectsConnection.pageInfo),
      rateLimit,
    };
  }

  async function listReadyIssueCandidates(
    teamId,
    { readyStateId, first = READY_ISSUE_CANDIDATE_PAGE_SIZE, after = null } = {},
  ) {
    if (typeof teamId !== "string" || teamId.trim() === "") {
      throw new Error("teamId is required to list Ready Linear issue candidates.");
    }
    if (typeof readyStateId !== "string" || readyStateId.trim() === "") {
      throw new Error("readyStateId is required to list Ready Linear issue candidates.");
    }

    const boundedFirst = readyIssueCandidatePageSize(first);
    const { data, rateLimit } = await requestWithMeta(
      `
        query ReadyIssueCandidates($after: String, $first: Int!, $filter: IssueFilter!) {
          issues(first: $first, after: $after, includeArchived: false, filter: $filter) {
            nodes {
              ${READY_ISSUE_CANDIDATE_FIELDS}
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        after,
        first: boundedFirst,
        filter: issueFilter({ teamId, stateId: readyStateId }),
      },
    );
    const issuesConnection = data.issues;
    if (!issuesConnection) {
      throw new Error("Linear Ready issue candidates query did not return an issues connection.");
    }
    return {
      candidates: connectionNodes(issuesConnection)
        .filter((issue) => isReadyIssueCandidateForTeam(issue, teamId, readyStateId))
        .map(normalizeReadyIssueCandidate),
      pageInfo: normalizePageInfo(issuesConnection.pageInfo),
      rateLimit,
    };
  }

  async function getProjectSnapshotContext(projectId) {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId is required to load Linear project snapshot context.");
    }

    const issues = [];
    let after = null;
    let project = null;
    do {
      const data = await request(
        `
          query ProjectSnapshotContext($projectId: String!, $after: String, $first: Int!) {
            project(id: $projectId) {
              id
              name
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
              issues(first: $first, after: $after, includeArchived: true) {
                nodes {
                  ${SNAPSHOT_ISSUE_FIELDS}
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
      project ||= normalizeProjectSnapshotBase(data.project);
      issues.push(...connectionNodes(data.project.issues).map(normalizeSnapshotIssue));
      after = nextCursor(data.project.issues, "project snapshot issues");
    } while (after);

    return { ...project, issues };
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

    const comments = (await listComments({ projectId })).map(agentVisibleProjectComment);
    return { ...project, comments, issues };
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

  async function listComments(target = {}) {
    const commentTarget = resolveCommentTarget(target, "list");
    // Project comments are NOT exposed on `project.comments` — that connection does not
    // surface directly-attached project comments (grounded live: introspection + create/read
    // against the Linear API, 2026-07-07). They are read via the top-level `comments`
    // connection filtered by project. Issue comments still use `issue(id).comments`.
    if (commentTarget.root === "project") {
      return listProjectComments(commentTarget.id);
    }
    const comments = [];
    let after = null;
    do {
      const data = await request(
        `
          query ${commentTarget.queryName}($${commentTarget.key}: String!, $after: String, $first: Int!) {
            ${commentTarget.root}(id: $${commentTarget.key}) {
              id
              comments(first: $first, after: $after) {
                nodes {
                  ${ISSUE_COMMENT_FIELDS}
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { [commentTarget.key]: commentTarget.id, after, first: PAGE_SIZE },
      );
      if (!data[commentTarget.root]?.id) {
        throw new Error(`Linear ${commentTarget.label} ${commentTarget.id} was not found.`);
      }
      const connection = data[commentTarget.root].comments;
      if (!connection) {
        throw new Error(`Linear ${commentTarget.label} comment list did not return a comment connection.`);
      }
      comments.push(...connection.nodes.map(normalizeComment));
      after = nextCursor(connection, `${commentTarget.label} comments`);
    } while (after);
    return comments.reverse();
  }

  async function listProjectComments(projectId) {
    const comments = [];
    let after = null;
    do {
      const data = await request(
        `
          query ProjectComments($projectId: ID!, $after: String, $first: Int!) {
            comments(filter: { project: { id: { eq: $projectId } } }, first: $first, after: $after) {
              nodes {
                ${ISSUE_COMMENT_FIELDS}
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { projectId, after, first: PAGE_SIZE },
      );
      const connection = data.comments;
      if (!connection) {
        throw new Error("Linear project comment list did not return a comment connection.");
      }
      comments.push(...connection.nodes.map(normalizeComment));
      after = nextCursor(connection, "project comments");
    } while (after);
    // Newest-first, deterministic (the top-level comments connection order is not guaranteed).
    return comments.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async function listIssueComments(issueId) {
    return listComments({ issueId });
  }

  async function createComment(target = {}, body) {
    const commentTarget = resolveCommentTarget(target, "create");
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error("body is required to create a Linear comment.");
    }
    const data = await request(
      `
        mutation CreateIssueComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              ${ISSUE_COMMENT_FIELDS}
            }
          }
        }
      `,
      { input: { [commentTarget.key]: commentTarget.id, body } },
    );
    return requirePayload(data.commentCreate, "comment", normalizeComment, "Linear comment creation");
  }

  async function createIssueComment(issueId, body) {
    return createComment({ issueId }, body);
  }

  async function listIssues({
    teamId,
    projectId,
    query: searchText,
    includeArchived = false,
    filter: explicitFilter = null,
    stateId = null,
    labelId = null,
  } = {}) {
    const filter = explicitFilter || issueFilter({ teamId, projectId, searchText, stateId, labelId });
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

  async function archiveIssue(issueId) {
    const data = await request(
      `
        mutation ArchiveIssue($id: String!) {
          issueArchive(id: $id) {
            success
            entity {
              ${ISSUE_FIELDS}
            }
          }
        }
      `,
      { id: issueId },
    );
    const payload = data.issueArchive;
    if (payload?.success !== true) throw new Error("Linear issue archive failed.");
    if (!payload.entity?.id) throw new Error("Linear issue archive did not return an archived issue.");
    return normalizeIssue(payload.entity);
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
    updateProjectLabel,
    findIssueLabelsByName,
    createIssueLabel,
    updateIssueLabel,
    archiveIssueLabel,
    createWorkflowState,
    updateWorkflowState,
    archiveWorkflowState,
    listProjectStatuses,
    createProjectStatus,
    listWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    listWorkflowStates,
    getTeamGitAutomationSettings,
    findTemplatesByName,
    createTemplate,
    updateTemplate,
    createProject,
    updateProject,
    getProject,
    archiveProject,
    listPlannedProjectCandidates,
    listReadyIssueCandidates,
    getProjectSnapshotContext,
    getProjectContext,
    listProjectIssues,
    getIssueContext,
    getIssue: getIssueContext,
    listComments,
    listIssueComments,
    createComment,
    createIssueComment,
    listIssues,
    searchIssues,
    createIssue,
    updateIssue,
    archiveIssue,
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

export function createLinearProjectStatusAdminClient(options = {}) {
  const client = createLinearGraphqlClient(options);
  return {
    getOrganization: client.getOrganization,
    createProjectStatus: client.createProjectStatus,
  };
}

function issueFilter({ teamId, projectId, searchText, stateId, labelId }) {
  const clauses = [];
  if (teamId) clauses.push({ team: { id: { eq: teamId } } });
  if (projectId) clauses.push({ project: { id: { eq: projectId } } });
  if (stateId) clauses.push({ state: { id: { eq: stateId } } });
  if (labelId) clauses.push({ labels: { id: { eq: labelId } } });
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

function resolveCommentTarget(target, action) {
  const issueId = typeof target?.issueId === "string" ? target.issueId.trim() : "";
  const projectId = typeof target?.projectId === "string" ? target.projectId.trim() : "";
  if (issueId && projectId) {
    throw new Error(`issueId or projectId, not both, is required to ${action} Linear comments.`);
  }
  if (issueId) {
    return { key: "issueId", id: issueId, root: "issue", label: "issue", queryName: "IssueComments" };
  }
  if (projectId) {
    return { key: "projectId", id: projectId, root: "project", label: "project", queryName: "ProjectComments" };
  }
  throw new Error(`issueId or projectId is required to ${action} Linear comments.`);
}

function agentVisibleProjectComment(comment) {
  return {
    author_id: comment?.user?.id ?? null,
    body: typeof comment?.body === "string" ? comment.body : "",
    created_at: comment?.createdAt || null,
  };
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

// The metadata fields only exist on label CRUD reads (the *_DETAIL_FIELDS
// shapes). Labels embedded in issue/project queries are read lean, and a lean
// read must not claim description/parent are null when Linear simply wasn't
// asked — so the fields are included only when the payload carried them.
function normalizeProjectLabel(label) {
  return {
    id: label.id,
    name: label.name,
    ...labelMetadataFields(label),
  };
}

function normalizeIssueLabel(label) {
  return {
    id: label.id,
    name: label.name,
    teamId: label.team?.id || null,
    team: label.team ? { id: label.team.id } : null,
    ...labelMetadataFields(label),
  };
}

function labelMetadataFields(label) {
  return {
    ...("description" in label ? { description: label.description ?? null } : {}),
    ...("color" in label ? { color: label.color ?? null } : {}),
    ...("isGroup" in label ? { isGroup: label.isGroup ?? false } : {}),
    ...("parent" in label ? { parentId: label.parent?.id || null } : {}),
  };
}

function normalizeProjectStatus(status) {
  return {
    id: status.id,
    name: status.name,
    type: status.type,
    ...("position" in status ? { position: status.position } : {}),
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
    ...("description" in state ? { description: state.description ?? null } : {}),
    ...("position" in state ? { position: state.position ?? null } : {}),
  };
}

function normalizeNullableWorkflowState(state) {
  if (!state) return null;
  return {
    id: state.id,
    name: state.name || null,
    type: state.type || null,
  };
}

function normalizeGitAutomationState(state) {
  return {
    id: state.id,
    event: state.event || null,
    branchPattern: state.branchPattern || null,
    state: normalizeNullableWorkflowState(state.state),
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

function isPlannedProjectCandidateForTeam(project, teamId, plannedStateId = null) {
  const belongsToTeam = connectionNodes(project.teams).some((team) => team?.id === teamId);
  if (!belongsToTeam) return false;
  if (plannedStateId) return project?.status?.id === plannedStateId;
  return project?.status?.type === "planned";
}

function isReadyIssueCandidateForTeam(issue, teamId, readyStateId) {
  return issue?.team?.id === teamId && issue?.state?.id === readyStateId;
}

function normalizePlannedProjectCandidate(project) {
  return {
    id: project.id,
    name: project.name,
    status: normalizeProjectStatus(project.status),
    teams: {
      nodes: connectionNodes(project.teams).map((team) => ({ id: team.id })),
    },
  };
}

function normalizeReadyIssueCandidate(issue) {
  return {
    ...normalizeIssue(issue),
    createdAt: issue.createdAt || null,
  };
}

function readyIssueCandidatePageSize(first) {
  if (first === null || first === undefined) return READY_ISSUE_CANDIDATE_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1) {
    throw new Error("Ready Linear issue candidate page size must be a positive integer.");
  }
  return Math.min(first, READY_ISSUE_CANDIDATE_PAGE_SIZE);
}

function normalizeProjectSnapshotBase(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || null,
    content: project.content || "",
    status: project.status ? normalizeProjectStatus(project.status) : null,
    labels: connectionNodes(project.labels).map(normalizeProjectLabel),
  };
}

function normalizeSnapshotIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title || "",
    state: issue.state
      ? {
          id: issue.state.id,
          name: issue.state.name,
          type: issue.state.type,
        }
      : null,
    labels: connectionNodes(issue.labels).map(normalizeProjectLabel),
  };
}

function normalizeIssue(issue) {
  const description = issue.description || "";
  const resourceTarget = parseResourceTargetFromDescription(description);
  return {
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title || "",
    description,
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
    ...(resourceTarget ? { resource_target: resourceTarget } : {}),
  };
}

export function normalizeComment(comment) {
  return {
    id: comment.id,
    body: comment.body || "",
    createdAt: comment.createdAt || null,
    updatedAt: comment.updatedAt || null,
    user: comment.user
      ? {
          id: comment.user.id || null,
          name: comment.user.name || null,
          displayName: comment.user.displayName || null,
        }
      : null,
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
  const normalized = {
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title || "",
    url: issue.url || null,
  };
  if (Object.hasOwn(issue, "state")) {
    normalized.state = issue.state ? { type: issue.state.type || null } : null;
  }
  return normalized;
}

function connectionNodes(connection) {
  return connection?.nodes || [];
}

function normalizePageInfo(pageInfo) {
  return {
    hasNextPage: Boolean(pageInfo?.hasNextPage),
    endCursor: pageInfo?.endCursor || null,
  };
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

function linearGraphqlRequestError(message, payload, status = null, rateLimit = null) {
  const error = new Error(message);
  if (payload?.errors) error.errors = payload.errors;
  if (payload) error.graphqlPayload = payload;
  if (status) error.httpStatus = status;
  if (rateLimit) error.rateLimit = rateLimit;
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

function readLinearRateLimitHeaders(headers) {
  const rawHeaders = {};
  for (const name of LINEAR_RATE_LIMIT_HEADER_NAMES) {
    const value = readHeader(headers, name);
    if (value !== null) rawHeaders[name] = value;
  }
  const scopes = [
    {
      scope: "endpoint",
      remaining: parseHeaderInteger(rawHeaders["x-ratelimit-endpoint-requests-remaining"]),
      resetAt: parseHeaderInteger(rawHeaders["x-ratelimit-endpoint-requests-reset"]),
    },
    {
      scope: "complexity",
      remaining: parseHeaderInteger(rawHeaders["x-ratelimit-complexity-remaining"]),
      resetAt: parseHeaderInteger(rawHeaders["x-ratelimit-complexity-reset"]),
    },
    {
      scope: "requests",
      remaining: parseHeaderInteger(rawHeaders["x-ratelimit-requests-remaining"]),
      resetAt: parseHeaderInteger(rawHeaders["x-ratelimit-requests-reset"]),
    },
  ];
  const selected = selectRateLimitScope(scopes);
  return {
    scope: selected?.scope || null,
    resetAt: selected?.resetAt ?? null,
    remaining: selected?.remaining ?? null,
    rawHeaders,
  };
}

function selectRateLimitScope(scopes) {
  const populated = scopes.filter((scope) => scope.remaining !== null || scope.resetAt !== null);
  if (populated.length === 0) return null;
  const exhausted = populated.find((scope) => scope.remaining !== null && scope.remaining <= 0);
  if (exhausted) return exhausted;
  const withRemaining = populated.filter((scope) => scope.remaining !== null);
  if (withRemaining.length > 0) {
    return withRemaining.sort((left, right) => left.remaining - right.remaining)[0];
  }
  return populated[0];
}

function parseHeaderInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  const loweredName = name.toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(name) ?? headers.get(loweredName);
    if (value !== undefined && value !== null) return String(value);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === loweredName && value !== undefined && value !== null) {
      return String(value);
    }
  }
  return null;
}
