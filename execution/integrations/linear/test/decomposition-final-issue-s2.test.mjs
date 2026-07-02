import assert from "node:assert/strict";
import test from "node:test";

import { parseResourceTargetFromDescription } from "../src/resource-target.mjs";
import {
  normalizeFinalIssuesForOrchestrator,
  validateFinalIssues,
} from "../src/workflows/decomposition/commit-payload.mjs";
import { createOrReuseExecutionIssues } from "../src/workflows/decomposition/issue-commit.mjs";

test("final issue normalization carries optional S2 fields and omits them when absent", () => {
  const [withS2, withoutS2] = normalizeFinalIssuesForOrchestrator([
    {
      ...validFinalIssue(),
      work_type: "code",
      resource_target: {
        kind: "git_repo",
        id: "repo-main",
        repo_scope: "apps/web",
        ignored: "not persisted",
      },
    },
    validFinalIssue({ decomposition_key: "non-code-docs" }),
  ]);

  assert.equal(withS2.work_type, "code");
  assert.deepEqual(withS2.resource_target, {
    kind: "git_repo",
    id: "repo-main",
    repo_scope: "apps/web",
  });
  assert.equal(Object.hasOwn(withoutS2, "work_type"), false);
  assert.equal(Object.hasOwn(withoutS2, "resource_target"), false);
});

test("final issue validation accepts absent S2 fields and rejects malformed optional fields", () => {
  const acceptedFailures = [];
  validateFinalIssues([validFinalIssue()], acceptedFailures);
  assert.deepEqual(acceptedFailures, []);

  const invalidWorkTypeFailures = [];
  validateFinalIssues([validFinalIssue({ work_type: "docs" })], invalidWorkTypeFailures);
  assert.deepEqual(invalidWorkTypeFailures, ["invalid_final_issue_work_type"]);

  const malformedResourceTargetFailures = [];
  validateFinalIssues(
    [validFinalIssue({ resource_target: { kind: "git_repo" } })],
    malformedResourceTargetFailures,
  );
  assert.deepEqual(malformedResourceTargetFailures, ["invalid_final_issue_resource_target"]);
});

test("issue creation applies optional work_type labels and appends resource_target block", async () => {
  const client = capturingLinearClient();
  const shape = {
    team: { id: "team-1" },
    issueStatuses: { todo: { id: "state-todo" } },
    issueLabels: {
      work_type_code: { id: "label-code", name: "Code" },
      work_type_non_code: { id: "label-non-code", name: "Non-code" },
    },
  };
  const resourceTarget = { kind: "git_repo", id: "repo-main", repo_scope: "apps/web" };
  const issues = [
    validFinalIssue({
      work_type: "code",
      resource_target: resourceTarget,
    }),
    validFinalIssue({ decomposition_key: "docs-update" }),
  ];

  await createOrReuseExecutionIssues({
    client,
    config: {},
    project: { id: "project-1" },
    shape,
    issues,
  });

  assert.deepEqual(client.created.map((issue) => issue.labelIds), [["label-code"], []]);
  assert.deepEqual(parseResourceTargetFromDescription(client.created[0].description), resourceTarget);
  assert.equal(parseResourceTargetFromDescription(client.created[1].description), null);
});

function validFinalIssue(overrides = {}) {
  return {
    decomposition_key: "implement-main",
    title: "Implement main path",
    issue_body_markdown: "Build the main path.",
    depends_on: [],
    assignment: "Worker",
    output: "Implementation is ready.",
    acceptance_criteria: ["Tests pass."],
    ...overrides,
  };
}

function capturingLinearClient() {
  const created = [];
  return {
    created,
    async findIssueByDecompositionKey() {
      return null;
    },
    async createIssue(input) {
      const issue = { id: `issue-${created.length + 1}`, ...input };
      created.push(issue);
      return issue;
    },
    async findOrCreateIssueRelation() {
      throw new Error("relations should not be created in this fixture");
    },
  };
}
