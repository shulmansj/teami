import assert from "node:assert/strict";
import test from "node:test";

import { createLinearGraphqlClient } from "../src/linear-graphql-client.mjs";

test("GraphQL Ready issue candidates query filters Ready issues, hydrates blocker state, and caps complexity", async () => {
  const calls = [];
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.query.includes("query ReadyIssueCandidates")) {
        return jsonResponse(
          {
            data: {
              issues: connection(
                [
                  issueNode({
                    id: "issue-ready",
                    createdAt: "2026-06-25T12:00:00.000Z",
                    state: { id: "state-ready", name: "Ready", type: "unstarted" },
                    relations: [
                      blocksRelation({
                        id: "relation-1",
                        blocker: relatedIssue("issue-blocker", "started"),
                        dependent: relatedIssue("issue-ready", "unstarted"),
                      }),
                    ],
                  }),
                  issueNode({
                    id: "issue-backlog",
                    createdAt: "2026-06-24T12:00:00.000Z",
                    state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
                  }),
                ],
                { hasNextPage: true, endCursor: "cursor-1" },
              ),
            },
          },
          {
            headers: {
              "x-complexity": "421",
              "x-ratelimit-complexity-limit": "10000",
              "x-ratelimit-complexity-remaining": "9400",
              "x-ratelimit-complexity-reset": "1710000001000",
            },
          },
        );
      }
      throw new Error(`unhandled GraphQL operation: ${body.query}`);
    },
  });

  const result = await client.listReadyIssueCandidates("team-1", {
    readyStateId: "state-ready",
    first: 50,
    after: "cursor-0",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].variables, {
    after: "cursor-0",
    first: 10,
    filter: {
      and: [
        { team: { id: { eq: "team-1" } } },
        { state: { id: { eq: "state-ready" } } },
      ],
    },
  });
  assert.match(calls[0].query, /query ReadyIssueCandidates/);
  assert.match(calls[0].query, /issues\s*\([\s\S]*includeArchived:\s*false[\s\S]*filter:\s*\$filter/);
  assert.match(calls[0].query, /\bcreatedAt\b/);
  assert.match(calls[0].query, /relations\s*\(first:\s*100,\s*includeArchived:\s*true\)/);
  assert.match(calls[0].query, /inverseRelations\s*\(first:\s*100,\s*includeArchived:\s*true\)/);
  assert.match(calls[0].query, /issue\s*\{[\s\S]*state\s*\{[\s\S]*type/);
  assert.match(calls[0].query, /relatedIssue\s*\{[\s\S]*state\s*\{[\s\S]*type/);
  assert.doesNotMatch(calls[0].query, /labels\s*\(/);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "issue-ready");
  assert.equal(result.candidates[0].createdAt, "2026-06-25T12:00:00.000Z");
  assert.deepEqual(result.candidates[0].relations[0].issue.state, { type: "started" });
  assert.deepEqual(result.candidates[0].relations[0].relatedIssue.state, { type: "unstarted" });
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "cursor-1" });
  assert.deepEqual(result.rateLimit, {
    scope: "complexity",
    resetAt: 1710000001000,
    remaining: 9400,
    rawHeaders: {
      "x-complexity": "421",
      "x-ratelimit-complexity-limit": "10000",
      "x-ratelimit-complexity-remaining": "9400",
      "x-ratelimit-complexity-reset": "1710000001000",
    },
  });
});

function issueNode({
  id,
  createdAt,
  state,
  relations = [],
  inverseRelations = [],
} = {}) {
  return {
    id,
    identifier: `AF-${id.replace(/\D/g, "") || "1"}`,
    title: `Issue ${id}`,
    description: `Exact body for ${id}.`,
    url: `https://linear.test/${id}`,
    createdAt,
    team: { id: "team-1", key: "AF", name: "Teami" },
    project: { id: "project-1", name: "Project", url: "https://linear.test/project/1" },
    assignee: null,
    state,
    relations: connection(relations),
    inverseRelations: connection(inverseRelations),
  };
}

function blocksRelation({ id, blocker, dependent }) {
  return {
    id,
    type: "blocks",
    issue: blocker,
    relatedIssue: dependent,
  };
}

function relatedIssue(id, stateType) {
  return {
    id,
    identifier: `AF-${id.replace(/\D/g, "") || "1"}`,
    title: `Issue ${id}`,
    url: `https://linear.test/${id}`,
    state: { type: stateType },
  };
}

function connection(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return {
    nodes,
    pageInfo,
  };
}

function jsonResponse(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
