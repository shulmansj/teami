const PROJECT_STATUSES = Object.freeze([
  { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
  { id: "status-planned", name: "Planned", type: "planned", position: 20 },
  { id: "status-in-progress", name: "In Progress", type: "started", position: 30 },
  { id: "status-completed", name: "Completed", type: "completed", position: 40 },
  { id: "status-needs-principal", name: "Principal Escalation", type: "planned", position: 21 },
]);

const WORKFLOW_STATES = Object.freeze([
  { id: "state-backlog", name: "Backlog", type: "backlog", position: 10, team: { id: "team-1" } },
  { id: "state-todo", name: "Todo", type: "unstarted", position: 20, team: { id: "team-1" } },
  { id: "state-in-progress", name: "In Progress", type: "started", position: 30, team: { id: "team-1" } },
  { id: "state-in-review", name: "In Review", type: "started", position: 40, team: { id: "team-1" } },
  { id: "state-human-review", name: "Principal Review", type: "started", position: 50, team: { id: "team-1" } },
  { id: "state-needs-principal", name: "Principal Escalation", type: "started", position: 60, team: { id: "team-1" } },
  { id: "state-done", name: "Done", type: "completed", position: 70, team: { id: "team-1" } },
]);

const TEAM = Object.freeze({
  id: "team-1",
  key: "OPS",
  name: "Support Ops",
  description: "No-checkout regression fixture team.",
});

const ISSUE_LABELS = Object.freeze([
  issueLabel("label-discovery", "Discovery"),
  issueLabel("label-human-review", "human-review"),
  issueLabel("label-code", "Code"),
  issueLabel("label-non-code", "Non-code"),
]);

const state = {
  delayedOnce: false,
  nextProjectNumber: 1,
  projects: [],
};

globalThis.fetch = async function noCheckoutFetch(input, init = {}) {
  const url = urlString(input);
  if (isLinearGraphqlUrl(url)) {
    await maybeDelayGraphqlOnce();
    return jsonResponse(handleGraphqlRequest(init));
  }
  throw new Error(`no-checkout fixture blocked unexpected fetch: ${url}`);
};

function handleGraphqlRequest(init) {
  const body = JSON.parse(String(init.body || "{}"));
  const query = String(body.query || "");
  const variables = body.variables || {};

  if (/\bquery\s+LinearTeams\b/.test(query)) {
    return {
      data: {
        teams: {
          nodes: [TEAM],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  if (/\bquery\s+ProjectStatuses\b/.test(query)) {
    return {
      data: {
        projectStatuses: {
          nodes: PROJECT_STATUSES,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  if (/\bquery\s+WorkflowStates\b/.test(query)) {
    return {
      data: {
        workflowStates: {
          nodes: WORKFLOW_STATES,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  if (/\bquery\s+IssueLabels\b/.test(query)) {
    return {
      data: {
        issueLabels: {
          nodes: ISSUE_LABELS,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  if (/\bmutation\s+CreateProject\b/.test(query)) {
    return { data: { projectCreate: { success: true, project: createProject(variables.input || {}) } } };
  }

  if (/\bquery\s+ProjectById\b/.test(query)) {
    return {
      data: {
        project: state.projects.find((candidate) => candidate.id === variables.projectId) || null,
      },
    };
  }

  if (/\bmutation\s+UpdateProject\b/.test(query)) {
    return { data: { projectUpdate: { success: true, project: updateProject(variables.id, variables.input || {}) } } };
  }

  if (/\bquery\s+PlannedProjectCandidates\b/.test(query)) {
    return {
      data: {
        team: {
          id: variables.teamId || TEAM.id,
          projects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  }

  if (/\bquery\s+ReadyIssueCandidates\b/.test(query)) {
    return {
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  return {
    errors: [{ message: `Unexpected no-checkout GraphQL operation: ${operationLabel(query)}` }],
  };
}

function createProject(input) {
  const id = `project-${state.nextProjectNumber++}`;
  const project = projectShape({
    id,
    name: input.name || id,
    description: input.description || null,
    content: input.content,
    statusId: input.statusId || "status-backlog",
    teamIds: input.teamIds || [TEAM.id],
  });
  state.projects.push(project);
  return project;
}

function updateProject(id, input) {
  let project = state.projects.find((candidate) => candidate.id === id);
  if (!project) {
    project = projectShape({ id, name: id, statusId: "status-backlog", teamIds: [TEAM.id] });
    state.projects.push(project);
  }
  if (Object.hasOwn(input, "name")) project.name = input.name;
  if (Object.hasOwn(input, "description")) project.description = input.description;
  if (Object.hasOwn(input, "content")) project.content = input.content;
  if (Object.hasOwn(input, "statusId")) project.status = projectStatus(input.statusId);
  if (Object.hasOwn(input, "teamIds")) project.teams = connection((input.teamIds || []).map(teamById));
  return project;
}

function projectShape({
  id,
  name,
  description = null,
  content = undefined,
  statusId,
  teamIds,
}) {
  return {
    id,
    name,
    url: `https://linear.local/${id}`,
    description,
    ...(content !== undefined ? { content } : {}),
    status: projectStatus(statusId),
    labels: connection([]),
    teams: connection((teamIds || [TEAM.id]).map(teamById)),
  };
}

function projectStatus(id) {
  return PROJECT_STATUSES.find((status) => status.id === id) || PROJECT_STATUSES[0];
}

function teamById(id) {
  return id === TEAM.id ? TEAM : { id, key: id, name: id, description: null };
}

function issueLabel(id, name) {
  return {
    id,
    name,
    team: { id: TEAM.id },
    description: null,
    color: null,
    isGroup: false,
    parent: null,
  };
}

function connection(nodes) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

async function maybeDelayGraphqlOnce() {
  const delayMs = Number(process.env.TEAMI_NO_CHECKOUT_GRAPHQL_DELAY_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0 || state.delayedOnce) return;
  state.delayedOnce = true;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isLinearGraphqlUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "api.linear.app" && url.pathname === "/graphql";
  } catch {
    return false;
  }
}

function urlString(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url || String(input);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operationLabel(query) {
  return query.replace(/\s+/g, " ").trim().slice(0, 120);
}
