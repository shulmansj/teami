import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLinearGraphqlClient } from "../src/linear-graphql-client.mjs";
import { processPlannedProject } from "../src/gateway-loop.mjs";
import { renderResourceTargetBlock } from "../src/resource-target.mjs";
import { isReadyIssueEligible } from "../src/workflows/execution/eligibility.mjs";

const FINGERPRINT = "fingerprint-ready-issue";
const TODO_STATE_ID = "state-todo";
const DISCOVERY_LABEL_ID = "label-discovery";
const WORK_TYPE_CODE_LABEL_ID = "label-code";
const WORK_TYPE_NON_CODE_LABEL_ID = "label-non-code";
const ELIGIBILITY_OPTIONS = {
  todoStateId: TODO_STATE_ID,
  discoveryLabelId: DISCOVERY_LABEL_ID,
};
const ALLOWED_REPO_PACKET = Object.freeze([
  {
    resource_id: "repo-1",
    owner: "acme",
    repo: "product",
    default_branch: "main",
  },
  {
    resource_id: "repo-2",
    owner: "acme",
    repo: "website",
    default_branch: "main",
  },
]);
const RESOURCE_ELIGIBILITY_OPTIONS = {
  ...ELIGIBILITY_OPTIONS,
  allowedRepoPacket: ALLOWED_REPO_PACKET,
  workTypeCodeLabelId: WORK_TYPE_CODE_LABEL_ID,
  workTypeNonCodeLabelId: WORK_TYPE_NON_CODE_LABEL_ID,
};

test("Todo execution issue with a decomposition key and no blockers is eligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({ id: "issue-todo" }), ELIGIBILITY_OPTIONS),
    { eligible: true, blockingIssueIds: [] },
  );
});

test("non-Todo issue with no blockers is ineligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-backlog",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
    }), ELIGIBILITY_OPTIONS),
    { eligible: false, blockingIssueIds: [] },
  );
});

test("Todo execution issue without a decomposition key is ineligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-human",
      description: "A human-created Todo with no authored key.",
    }), ELIGIBILITY_OPTIONS),
    { eligible: false, blockingIssueIds: [] },
  );
});

test("Discovery-labeled Todo issue is ineligible even with a decomposition key", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-discovery",
      labels: [{ id: DISCOVERY_LABEL_ID, name: "Discovery" }],
    }), ELIGIBILITY_OPTIONS),
    { eligible: false, blockingIssueIds: [] },
  );
});

test("Todo execution issue with an incomplete blocker is ineligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-dependent",
      relations: [
        blocksRelation({
          id: "relation-1",
          blocker: relatedIssue("issue-blocker", "started"),
          dependent: relatedIssue("issue-dependent", "unstarted"),
        }),
      ],
    }), ELIGIBILITY_OPTIONS),
    { eligible: false, blockingIssueIds: ["issue-blocker"] },
  );
});

test("Todo execution issue with a completed blocker is eligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-dependent",
      relations: [
        blocksRelation({
          id: "relation-1",
          blocker: relatedIssue("issue-blocker", "completed"),
          dependent: relatedIssue("issue-dependent", "unstarted"),
        }),
      ],
    }), ELIGIBILITY_OPTIONS),
    { eligible: true, blockingIssueIds: [] },
  );
});

test("Todo execution issue with a canceled remediation blocker is eligible", () => {
  for (const stateType of ["canceled", "cancelled"]) {
    assert.deepEqual(
      isReadyIssueEligible(issueContext({
        id: `issue-dependent-${stateType}`,
        relations: [
          blocksRelation({
            id: `relation-${stateType}`,
            blocker: relatedIssue(`issue-remediation-${stateType}`, stateType),
            dependent: relatedIssue(`issue-dependent-${stateType}`, "unstarted"),
          }),
        ],
      }), ELIGIBILITY_OPTIONS),
      { eligible: true, blockingIssueIds: [] },
    );
  }
});

test("Todo execution issue with an open remediation blocker stays ineligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-open-remediation",
      relations: [
        blocksRelation({
          id: "relation-open-remediation",
          blocker: relatedIssue("issue-open-remediation-blocker", "started"),
          dependent: relatedIssue("issue-open-remediation", "unstarted"),
        }),
      ],
    }), ELIGIBILITY_OPTIONS),
    { eligible: false, blockingIssueIds: ["issue-open-remediation-blocker"] },
  );
});

test("code issue without a resource target fails closed for multi-repo allowlists", () => {
  assert.deepEqual(
    isReadyIssueEligible(codeIssueContext({ id: "issue-missing-target" }), RESOURCE_ELIGIBILITY_OPTIONS),
    {
      eligible: false,
      blockingIssueIds: [],
      ineligibleReason: "resource_target_missing",
      resourceRouting: {
        work_type: "code",
        chosen_resource_id: null,
        allowed_resource_ids: ["repo-1", "repo-2"],
        reason: "resource_target_missing",
      },
    },
  );
});

test("code issue with a resource target outside the allowlist fails closed", () => {
  assert.deepEqual(
    isReadyIssueEligible(
      codeIssueContext({
        id: "issue-wrong-target",
        resourceTarget: { kind: "git_repo", id: "repo-3" },
      }),
      RESOURCE_ELIGIBILITY_OPTIONS,
    ),
    {
      eligible: false,
      blockingIssueIds: [],
      ineligibleReason: "resource_target_not_allowed",
      resourceRouting: {
        work_type: "code",
        chosen_resource_id: "repo-3",
        allowed_resource_ids: ["repo-1", "repo-2"],
        reason: "resource_target_not_allowed",
      },
    },
  );
});

test("code issue with an in-allowlist resource target is eligible", () => {
  assert.deepEqual(
    isReadyIssueEligible(
      codeIssueContext({
        id: "issue-valid-target",
        resourceTarget: { kind: "git_repo", id: "repo-2" },
      }),
      RESOURCE_ELIGIBILITY_OPTIONS,
    ),
    {
      eligible: true,
      blockingIssueIds: [],
      ineligibleReason: null,
      resourceRouting: {
        work_type: "code",
        chosen_resource_id: "repo-2",
        allowed_resource_ids: ["repo-1", "repo-2"],
        reason: null,
      },
    },
  );
});

test("code issue without a resource target backfills the single allowed repo", () => {
  assert.deepEqual(
    isReadyIssueEligible(codeIssueContext({ id: "issue-backfill-target" }), {
      ...RESOURCE_ELIGIBILITY_OPTIONS,
      allowedRepoPacket: [ALLOWED_REPO_PACKET[0]],
    }),
    {
      eligible: true,
      blockingIssueIds: [],
      ineligibleReason: null,
      resourceRouting: {
        work_type: "code",
        chosen_resource_id: "repo-1",
        allowed_resource_ids: ["repo-1"],
        reason: null,
      },
    },
  );
});

test("non-code issue is eligible without a resource target even with a repo allowlist", () => {
  assert.deepEqual(
    isReadyIssueEligible(issueContext({
      id: "issue-non-code",
      labels: [{ id: WORK_TYPE_NON_CODE_LABEL_ID, name: "Non-code" }],
    }), RESOURCE_ELIGIBILITY_OPTIONS),
    {
      eligible: true,
      blockingIssueIds: [],
      ineligibleReason: null,
      resourceRouting: {
        work_type: "non_code",
        chosen_resource_id: null,
        allowed_resource_ids: ["repo-1", "repo-2"],
        reason: null,
      },
    },
  );
});

test("code issue without an allowlist preserves existing eligibility behavior", () => {
  assert.deepEqual(
    isReadyIssueEligible(codeIssueContext({ id: "issue-no-allowlist" }), {
      ...ELIGIBILITY_OPTIONS,
      workTypeCodeLabelId: WORK_TYPE_CODE_LABEL_ID,
      workTypeNonCodeLabelId: WORK_TYPE_NON_CODE_LABEL_ID,
    }),
    { eligible: true, blockingIssueIds: [] },
  );
});

test("inverse Linear relation normalization preserves blocker state for eligibility", async () => {
  const calls = [];
  const client = createLinearGraphqlClient({
    tokenProvider: async () => "oauth-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.query.includes("query IssueContext")) {
        return jsonResponse({
          data: {
            issue: issueNode({
              id: "issue-dependent",
              state: { id: TODO_STATE_ID, name: "Todo", type: "unstarted" },
              relations: [],
              inverseRelations: [
                blocksRelation({
                  id: "relation-inverse",
                  blocker: relatedIssue("issue-blocker", "completed"),
                  dependent: relatedIssue("issue-dependent", "unstarted"),
                }),
              ],
            }),
          },
        });
      }
      throw new Error(`unhandled GraphQL operation: ${body.query}`);
    },
  });

  const issue = await client.getIssueContext("issue-dependent");

  assert.match(calls[0].query, /relatedIssue\s*\{[\s\S]*state\s*\{[\s\S]*type[\s\S]*\}/);
  assert.equal(issue.relations.length, 1);
  assert.deepEqual(issue.relations[0].issue.state, { type: "completed" });
  assert.deepEqual(isReadyIssueEligible(issue, ELIGIBILITY_OPTIONS), { eligible: true, blockingIssueIds: [] });
});

test("dependency-blocked fresh runner result does not write trigger suppression", async () => {
  const repoRoot = tempRepo();
  const writes = [];
  let snapshotReads = 0;
  const result = await processPlannedProject({
    repoRoot,
    config: configFixture(),
    domain: domainFixture(),
    domainContext: domainContextFixture(),
    client: {
      async getProjectSnapshotContext(projectId) {
        snapshotReads += 1;
        return projectSnapshot(projectId);
      },
    },
    candidate: { id: "issue-dependent" },
    runTimeoutMs: 0,
    idempotency: {
      computeTriggerFingerprint: () => FINGERPRINT,
      readReplayPending: async () => null,
      readSuppression: async () => null,
      writeSuppression: async (input) => {
        writes.push(input);
        return input;
      },
    },
    runFreshProject: async () => ({
      status: "rejected",
      reason: "dependency_blocked",
      wake: { run_id: "run-blocked" },
      result: {
        status: "ineligible",
        eligibility: {
          eligible: false,
          blockingIssueIds: ["issue-blocker"],
        },
      },
    }),
  });

  assert.equal(result.action, "fresh");
  assert.deepEqual(writes, []);
  assert.equal(snapshotReads, 1);
});

function issueContext({
  id,
  state = { id: TODO_STATE_ID, name: "Todo", type: "unstarted" },
  description = "- Decomposition key: issue-key\n\nDo the work.",
  labels = [],
  relations = [],
} = {}) {
  return {
    id,
    identifier: "AF-1",
    title: "Todo issue",
    description,
    labels,
    state,
    relations,
  };
}

function codeIssueContext({ resourceTarget = null, description = null, ...overrides } = {}) {
  return issueContext({
    ...overrides,
    description: description || descriptionWithResourceTarget(resourceTarget),
    labels: [{ id: WORK_TYPE_CODE_LABEL_ID, name: "Code" }, ...(overrides.labels || [])],
  });
}

function descriptionWithResourceTarget(resourceTarget) {
  return [
    "- Decomposition key: issue-key",
    "",
    resourceTarget ? renderResourceTargetBlock(resourceTarget).trimEnd() : null,
    "Do the work.",
  ].filter(Boolean).join("\n");
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

function issueNode({
  id,
  state,
  relations = [],
  inverseRelations = [],
} = {}) {
  return {
    id,
    identifier: "AF-2",
    title: "Dependent",
    description: "- Decomposition key: dependent\n\nDo the dependent work.",
    url: `https://linear.test/${id}`,
    team: { id: "team-1", key: "AF", name: "Teami" },
    project: { id: "project-1", name: "Project", url: "https://linear.test/project/1" },
    assignee: null,
    state,
    labels: connection([]),
    relations: connection(relations),
    inverseRelations: connection(inverseRelations),
  };
}

function connection(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return { nodes, pageInfo };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {},
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function projectSnapshot(id) {
  return {
    id,
    name: "Dependent issue trigger",
    description: "Issue trigger snapshot.",
    content: "",
    status: { id: "status-planned", name: "Planned", type: "planned" },
    labels: [],
    issues: [],
  };
}

function domainFixture() {
  return { id: "support-ops" };
}

function domainContextFixture() {
  return {
    domainId: "support-ops",
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      cachePath: "unused",
    },
  };
}

function configFixture() {
  return {
    poll: { interval_ms: 10_000 },
    linear: {
      oauth: {
        credential_storage: "file",
        client_id: "client-id",
        redirect_uri: "http://localhost/callback",
      },
      team: { key: "AF", name: "Teami" },
    },
  };
}

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-ready-issue-"));
}
