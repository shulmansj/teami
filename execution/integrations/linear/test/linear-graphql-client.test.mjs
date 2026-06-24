import assert from "node:assert/strict";
import test from "node:test";

import { createLinearGraphqlClient } from "../src/linear-graphql-client.mjs";
import { findIssueByDecompositionKey } from "../src/linear-service.mjs";

test("GraphQL project update creation sends OAuth bearer auth and exact authored body", async () => {
  const calls = [];
  const authoredBody = "run_id: run-live\n\nPause because the PM asked this exact question.";
  const client = createLinearGraphqlClient({
    endpoint: "https://linear.test/graphql",
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        data: {
          projectUpdateCreate: {
            success: true,
            projectUpdate: {
              id: "update-1",
              body: authoredBody,
              health: "atRisk",
              url: "https://linear.test/update-1",
              archivedAt: null,
              createdAt: "2026-06-07T20:00:00.000Z",
              updatedAt: "2026-06-07T20:00:00.000Z",
            },
          },
        },
      });
    },
  });

  const update = await client.createProjectUpdate({
    projectId: "project-1",
    body: authoredBody,
    health: "atRisk",
    isDiffHidden: true,
    runId: "run-live",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://linear.test/graphql");
  assert.equal(calls[0].options.headers.authorization, "Bearer oauth-token");
  assert.equal(calls[0].body.variables.input.body, authoredBody);
  assert.equal(calls[0].body.variables.input.projectId, "project-1");
  assert.equal(calls[0].body.variables.input.health, "atRisk");
  assert.equal(calls[0].body.variables.input.isDiffHidden, true);
  assert.equal(update.body, authoredBody);
  assert.equal(update.runId, "run-live");
});

test("GraphQL project update listing paginates and finds updates by exact run_id line", async () => {
  const cursors = [];
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      cursors.push(body.variables.after);
      if (!body.variables.after) {
        return jsonResponse({
          data: {
            project: {
              projectUpdates: {
                nodes: [
                  {
                    id: "update-old",
                    body: "run_id: run-10\n\nOlder update.",
                    health: "onTrack",
                    url: null,
                    archivedAt: null,
                    createdAt: "2026-06-07T19:00:00.000Z",
                    updatedAt: "2026-06-07T19:00:00.000Z",
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          project: {
            projectUpdates: {
              nodes: [
                {
                  id: "update-target",
                  body: "Context mentions run-1 but does not own it.\n\nrun_id: run-1",
                  health: "onTrack",
                  url: "https://linear.test/update-target",
                  archivedAt: null,
                  createdAt: "2026-06-07T20:00:00.000Z",
                  updatedAt: "2026-06-07T20:00:00.000Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    },
  });

  const updates = await client.listProjectUpdates("project-1");
  const { findProjectUpdateByRunId } = client;
  const existing = await findProjectUpdateByRunId("project-1", "run-1");

  assert.deepEqual(cursors, [null, "cursor-1", null, "cursor-1"]);
  assert.equal(updates.length, 2);
  assert.equal(existing.id, "update-target");
  assert.equal(existing.runId, "run-1");
});

test("GraphQL setup methods implement the Linear service contract", async () => {
  const calls = [];
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.query.includes("query LinearTeams")) {
        return jsonResponse({
          data: {
            teams: connection([{ id: "team-1", key: "AF", name: "Agentic Factory" }]),
          },
        });
      }
      if (body.query.includes("mutation CreateTeam")) {
        return payloadResponse("teamCreate", "team", {
          id: "team-2",
          key: body.variables.input.key,
          name: body.variables.input.name,
          description: body.variables.input.description,
        });
      }
      if (body.query.includes("query ProjectLabels")) {
        return jsonResponse({
          data: {
            projectLabels: connection([{ id: "plabel-1", name: "Has Open Questions" }]),
          },
        });
      }
      if (body.query.includes("mutation CreateProjectLabel")) {
        return payloadResponse("projectLabelCreate", "projectLabel", {
          id: "plabel-2",
          name: body.variables.input.name,
        });
      }
      if (body.query.includes("query IssueLabels")) {
        return jsonResponse({
          data: {
            issueLabels: connection([{ id: "ilabel-1", name: "Discovery", team: { id: "team-1" } }]),
          },
        });
      }
      if (body.query.includes("mutation CreateIssueLabel")) {
        return payloadResponse("issueLabelCreate", "issueLabel", {
          id: "ilabel-2",
          name: body.variables.input.name,
          team: { id: body.variables.input.teamId },
        });
      }
      if (body.query.includes("query ProjectStatuses")) {
        return jsonResponse({
          data: {
            projectStatuses: connection([{ id: "status-planned", name: "Planned", type: "planned" }]),
          },
        });
      }
      if (body.query.includes("query WorkflowStates")) {
        return jsonResponse({
          data: {
            workflowStates: connection([{ id: "state-ready", name: "Ready", type: "unstarted", team: { id: "team-1" } }]),
          },
        });
      }
      if (body.query.includes("query Templates")) {
        return jsonResponse({
          data: {
            templates: [
              {
                id: "template-1",
                type: "project",
                name: "Agentic Factory Roadmap Item",
                description: null,
                templateData: JSON.stringify({ content: "## Open Questions\n" }),
                team: { id: "team-1" },
              },
            ],
          },
        });
      }
      if (body.query.includes("mutation CreateTemplate")) {
        return payloadResponse("templateCreate", "template", {
          id: "template-2",
          type: body.variables.input.type,
          name: body.variables.input.name,
          description: body.variables.input.description,
          templateData: body.variables.input.templateData,
          team: { id: body.variables.input.teamId },
        });
      }
      if (body.query.includes("mutation UpdateTemplate")) {
        return payloadResponse("templateUpdate", "template", {
          id: body.variables.id,
          type: "project",
          name: "Agentic Factory Roadmap Item",
          description: null,
          templateData: body.variables.input.templateData,
          team: { id: "team-1" },
        });
      }
      if (body.query.includes("query Webhooks")) {
        return jsonResponse({
          data: {
            webhooks: connection([
              {
                id: "webhook-1",
                url: "https://inbox.test/v1/webhooks/linear",
                label: "Agentic Factory hosted inbox",
                enabled: true,
                allPublicTeams: false,
                resourceTypes: ["Project"],
                team: { id: "team-1", key: "AF", name: "Agentic Factory" },
              },
            ]),
          },
        });
      }
      if (body.query.includes("mutation CreateWebhook")) {
        return payloadResponse("webhookCreate", "webhook", {
          id: "webhook-2",
          url: body.variables.input.url,
          label: body.variables.input.label,
          enabled: body.variables.input.enabled,
          allPublicTeams: Boolean(body.variables.input.allPublicTeams),
          resourceTypes: body.variables.input.resourceTypes,
          team: { id: body.variables.input.teamId, key: "AF", name: "Agentic Factory" },
        });
      }
      if (body.query.includes("mutation UpdateWebhook")) {
        assert.equal("teamId" in body.variables.input, false);
        assert.equal("allPublicTeams" in body.variables.input, false);
        return payloadResponse("webhookUpdate", "webhook", {
          id: body.variables.id,
          url: body.variables.input.url,
          label: body.variables.input.label,
          enabled: body.variables.input.enabled,
          allPublicTeams: false,
          resourceTypes: body.variables.input.resourceTypes,
          team: { id: "team-1", key: "AF", name: "Agentic Factory" },
        });
      }
      if (body.query.includes("mutation DeleteWebhook")) {
        return jsonResponse({ data: { webhookDelete: { success: true } } });
      }
      throw new Error(`unhandled GraphQL operation: ${body.query}`);
    },
  });

  assert.deepEqual(await client.listTeams(), [
    { id: "team-1", key: "AF", name: "Agentic Factory", description: null },
  ]);
  assert.equal((await client.createTeam({ key: "AF2", name: "Agentic Factory 2" })).key, "AF2");
  assert.equal((await client.findProjectLabelsByName("Has Open Questions"))[0].id, "plabel-1");
  assert.equal((await client.createProjectLabel({ name: "Has Open Questions" })).id, "plabel-2");
  assert.equal((await client.findIssueLabelsByName("Discovery", "team-1"))[0].teamId, "team-1");
  assert.equal((await client.createIssueLabel({ name: "Discovery", teamId: "team-1" })).teamId, "team-1");
  assert.equal((await client.listProjectStatuses())[0].type, "planned");
  assert.equal((await client.listWorkflowStates("team-1"))[0].name, "Ready");
  assert.equal(
    (await client.findTemplatesByName("Agentic Factory Roadmap Item", "project", "team-1"))[0]
      .templateData.content,
    "## Open Questions\n",
  );
  assert.equal(
    (await client.createTemplate({
      name: "Agentic Factory Roadmap Item",
      type: "project",
      teamId: "team-1",
      templateData: { content: "draft" },
    })).teamId,
    "team-1",
  );
  assert.equal(
    (await client.updateTemplate("template-1", { templateData: { content: "updated" } })).templateData
      .content,
    "updated",
  );
  assert.equal((await client.listWebhooks({ teamId: "team-1" }))[0].id, "webhook-1");
  assert.equal(
    (await client.createWebhook({
      url: "https://inbox.test/v1/webhooks/linear",
      label: "Agentic Factory hosted inbox",
      teamId: "team-1",
      resourceTypes: ["Project"],
      secret: "secret-1",
      enabled: true,
    })).id,
    "webhook-2",
  );
  assert.equal(
    (await client.updateWebhook("webhook-1", {
      url: "https://inbox.test/v1/webhooks/linear",
      label: "Agentic Factory hosted inbox",
      teamId: "team-1",
      allPublicTeams: false,
      resourceTypes: ["Project"],
      secret: "secret-2",
      enabled: true,
    })).id,
    "webhook-1",
  );
  assert.deepEqual(await client.deleteWebhook("webhook-1"), { ok: true });

  const projectLabelQuery = calls.find((call) => call.query.includes("query ProjectLabels"));
  assert.deepEqual(projectLabelQuery.variables.filter, { name: { eq: "Has Open Questions" } });
  const issueLabelQuery = calls.find((call) => call.query.includes("query IssueLabels"));
  assert.deepEqual(issueLabelQuery.variables.filter, {
    name: { eq: "Discovery" },
    team: { id: { eq: "team-1" } },
  });
});

test("GraphQL project and issue methods preserve context, prose, and relations", async () => {
  const calls = [];
  let relationLookupCount = 0;
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.query.includes("query ProjectContext")) {
        const firstPage = !body.variables.after;
        return jsonResponse({
          data: {
            project: {
              id: body.variables.projectId,
              name: "Project",
              url: "https://linear.test/project/1",
              description: "Intent",
              content: "## Open Questions\n",
              status: { id: "status-planned", name: "Planned", type: "planned" },
              labels: connection([{ id: "plabel-1", name: "Has Open Questions" }]),
              teams: connection([{ id: "team-1", key: "AF", name: "Agentic Factory" }]),
              issues: connection(
                firstPage
                  ? [issueNode({ id: "issue-1", key: "frontend", title: "Build UI" })]
                  : [issueNode({ id: "issue-2", key: "backend", title: "Build API" })],
                firstPage ? { hasNextPage: true, endCursor: "cursor-1" } : undefined,
              ),
            },
          },
        });
      }
      if (body.query.includes("mutation UpdateProject")) {
        return payloadResponse("projectUpdate", "project", {
          id: body.variables.id,
          name: "Project",
          url: "https://linear.test/project/1",
          description: "Intent",
          content: body.variables.input.content,
          status: { id: body.variables.input.statusId, name: "Started", type: "started" },
          labels: connection([{ id: "plabel-1", name: "Has Open Questions" }]),
          teams: connection([{ id: "team-1", key: "AF", name: "Agentic Factory" }]),
        });
      }
      if (body.query.includes("mutation CreateProject")) {
        return payloadResponse("projectCreate", "project", {
          id: "project-created",
          name: body.variables.input.name,
          url: "https://linear.test/project/created",
          description: body.variables.input.description,
          content: body.variables.input.content,
          status: { id: body.variables.input.statusId, name: "Planned", type: "planned" },
          labels: connection([]),
          teams: connection([{ id: "team-1", key: "AF", name: "Agentic Factory" }]),
        });
      }
      if (body.query.includes("query IssueContext")) {
        relationLookupCount += 1;
        return jsonResponse({
          data: {
            issue: issueNode({
              id: body.variables.issueId,
              key: "blocking",
              title: "Blocking",
              relations:
                relationLookupCount === 1
                  ? [
                      {
                        id: "relation-existing",
                        type: "blocks",
                        issue: relatedIssue("issue-blocker", "Blocking"),
                        relatedIssue: relatedIssue("issue-dependent", "Dependent"),
                      },
                    ]
                  : [],
            }),
          },
        });
      }
      if (body.query.includes("mutation CreateIssueRelation")) {
        return payloadResponse("issueRelationCreate", "issueRelation", {
          id: "relation-created",
          type: body.variables.input.type,
          issue: relatedIssue(body.variables.input.issueId, "Blocking"),
          relatedIssue: relatedIssue(body.variables.input.relatedIssueId, "Dependent"),
        });
      }
      if (body.query.includes("mutation CreateIssue")) {
        return payloadResponse("issueCreate", "issue", issueNode({
          id: "issue-created",
          key: "created",
          title: body.variables.input.title,
          body: body.variables.input.description,
        }));
      }
      if (body.query.includes("mutation UpdateIssue")) {
        return payloadResponse("issueUpdate", "issue", issueNode({
          id: body.variables.id,
          key: "updated",
          title: "Updated",
          body: body.variables.input.description,
        }));
      }
      throw new Error(`unhandled GraphQL operation: ${body.query}`);
    },
  });

  const project = await client.getProjectContext("project-1");
  assert.equal(project.issues.length, 2);
  assert.equal(project.teamIds[0], "team-1");
  assert.equal((await findIssueByDecompositionKey(client, "project-1", "backend")).id, "issue-2");
  assert.equal(
    (await client.createProject({
      name: "New project",
      description: "Intent",
      content: "body",
      statusId: "status-planned",
      teamIds: ["team-1"],
    })).id,
    "project-created",
  );
  assert.equal(
    (await client.updateProject("project-1", {
      content: "## Open Questions\n- Exact question",
      statusId: "status-started",
      labelIds: ["plabel-1"],
    })).content,
    "## Open Questions\n- Exact question",
  );
  const createdIssue = await client.createIssue({
    title: "Created",
    description: "decomposition_key: created\n\nExact issue body.",
    teamId: "team-1",
    projectId: "project-1",
  });
  assert.equal(createdIssue.description, "decomposition_key: created\n\nExact issue body.");
  assert.equal((await client.updateIssue("issue-created", { description: "exact updated body" })).description, "exact updated body");

  assert.deepEqual(await client.findOrCreateIssueRelation({
    issueId: "issue-blocker",
    relatedIssueId: "issue-dependent",
    type: "blocks",
  }), {
    created: false,
    relation: {
      id: "relation-existing",
      type: "blocks",
      issue: relatedIssue("issue-blocker", "Blocking"),
      relatedIssue: relatedIssue("issue-dependent", "Dependent"),
    },
  });
  assert.equal(
    (await client.findOrCreateIssueRelation({
      issueId: "issue-new-blocker",
      relatedIssueId: "issue-new-dependent",
      type: "blocks",
    })).relation.id,
    "relation-created",
  );

  const createRelationCall = calls.find((call) => call.query.includes("mutation CreateIssueRelation"));
  assert.deepEqual(createRelationCall.variables.input, {
    issueId: "issue-new-blocker",
    relatedIssueId: "issue-new-dependent",
    type: "blocks",
  });
});

test("GraphQL issue reads give agents mediated project-scoped context", async () => {
  const calls = [];
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ headers: options.headers, body });
      if (body.query.includes("query Issues")) {
        return jsonResponse({
          data: {
            issues: connection([issueNode({ id: "issue-1", key: "search", title: "Search result" })]),
          },
        });
      }
      if (body.query.includes("query IssueContext")) {
        return jsonResponse({
          data: {
            issue: issueNode({ id: body.variables.issueId, key: "context", title: "Issue context" }),
          },
        });
      }
      throw new Error(`unhandled GraphQL operation: ${body.query}`);
    },
  });

  const issues = await client.searchIssues({
    teamId: "team-1",
    projectId: "project-1",
    query: "cache",
  });
  const issue = await client.getIssueContext("issue-1");

  assert.equal(issues[0].projectId, "project-1");
  assert.equal(issue.title, "Issue context");
  assert.equal(calls[0].headers.authorization, "Bearer oauth-token");
  assert.deepEqual(calls[0].body.variables.filter, {
    and: [
      { team: { id: { eq: "team-1" } } },
      { project: { id: { eq: "project-1" } } },
      {
        or: [
          { title: { containsIgnoreCase: "cache" } },
          { description: { containsIgnoreCase: "cache" } },
        ],
      },
    ],
  });
});

test("GraphQL client preserves Linear structured errors for setup classification", async () => {
  const linearError = {
    message: "Access denied",
    path: ["teamCreate"],
    extensions: {
      type: "forbidden",
      code: "FORBIDDEN",
      statusCode: 403,
      userError: true,
      userPresentableMessage:
        "You have reached the limit of teams allowed in your current plan. Please upgrade to create more teams.",
    },
  };
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "secret-oauth-token",
    fetchImpl: async () =>
      jsonResponse({
        errors: [linearError],
        data: null,
      }),
  });

  await assert.rejects(
    () => client.createTeam({ name: "Blocked Domain" }),
    (error) => {
      assert.match(error.message, /You have reached the limit of teams allowed/);
      assert.doesNotMatch(error.message, /secret-oauth-token/);
      assert.deepEqual(error.errors, [linearError]);
      assert.equal(error.graphqlPayload.errors[0].path[0], "teamCreate");
      return true;
    },
  );
});

test("GraphQL client fails closed on auth and GraphQL errors without leaking tokens", async () => {
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "secret-oauth-token",
    fetchImpl: async () =>
      jsonResponse(
        { errors: [{ message: "Authentication required, not authenticated" }] },
        { ok: false, status: 401 },
      ),
  });

  await assert.rejects(
    () => client.verifyAuth(),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /Authentication required/);
      assert.doesNotMatch(error.message, /secret-oauth-token/);
      return true;
    },
  );
});

test("GraphQL client times out stalled requests without leaking tokens", async () => {
  const client = createLinearGraphqlClient({
    requestTimeoutMs: 1,
    tokenProvider: async () => "secret-oauth-token",
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  await assert.rejects(
    () => client.verifyAuth(),
    (error) => {
      assert.match(error.message, /timed out/);
      assert.doesNotMatch(error.message, /secret-oauth-token/);
      return true;
    },
  );
});

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function payloadResponse(operation, key, value) {
  return jsonResponse({
    data: {
      [operation]: {
        success: true,
        [key]: value,
      },
    },
  });
}

function connection(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return {
    nodes,
    pageInfo,
  };
}

function issueNode({
  id,
  key,
  title,
  body = `- Decomposition key: ${key}\n\nExact body for ${key}.`,
  relations = [],
} = {}) {
  return {
    id,
    identifier: `AF-${id.replace(/\D/g, "") || "1"}`,
    title,
    description: body,
    url: `https://linear.test/${id}`,
    team: { id: "team-1", key: "AF", name: "Agentic Factory" },
    project: { id: "project-1", name: "Project", url: "https://linear.test/project/1" },
    assignee: null,
    state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
    labels: connection([{ id: "ilabel-discovery", name: "Discovery", team: { id: "team-1" } }]),
    relations: connection(relations),
    inverseRelations: connection([]),
  };
}

function relatedIssue(id, title) {
  return {
    id,
    identifier: `AF-${id.replace(/\D/g, "") || "1"}`,
    title,
    url: `https://linear.test/${id}`,
  };
}
