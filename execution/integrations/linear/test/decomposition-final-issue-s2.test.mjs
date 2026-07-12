import assert from "node:assert/strict";
import test from "node:test";

import { parseResourceTargetFromDescription } from "../src/resource-target.mjs";
import {
  normalizeFinalIssuesForOrchestrator,
  validateFinalIssues,
} from "../src/workflows/decomposition/commit-payload.mjs";
import { commitIssuesFromArtifact } from "../src/workflows/decomposition/artifact-apply.mjs";
import { createOrReuseExecutionIssues } from "../src/workflows/decomposition/issue-commit.mjs";

test("final issue normalization carries optional S2 and human review fields and omits them when absent", () => {
  const [withS2, withHumanReviewFalse, withoutOptionalFields] = normalizeFinalIssuesForOrchestrator([
    {
      ...validFinalIssue(),
      work_type: "code",
      requiresHumanReview: true,
      resource_target: {
        kind: "git_repo",
        id: "repo-main",
        repo_scope: "apps/web",
        ignored: "not persisted",
      },
    },
    validFinalIssue({
      decomposition_key: "non-code-docs",
      requires_human_review: false,
    }),
    validFinalIssue({ decomposition_key: "plain-ops" }),
  ]);

  assert.equal(withS2.work_type, "code");
  assert.equal(withS2.requires_human_review, true);
  assert.deepEqual(withS2.resource_target, {
    kind: "git_repo",
    id: "repo-main",
    repo_scope: "apps/web",
  });
  assert.equal(withHumanReviewFalse.requires_human_review, false);
  assert.equal(Object.hasOwn(withoutOptionalFields, "work_type"), false);
  assert.equal(Object.hasOwn(withoutOptionalFields, "requires_human_review"), false);
  assert.equal(Object.hasOwn(withoutOptionalFields, "resource_target"), false);
});

test("final issue normalization treats strict-schema null optionals as absent", () => {
  const [withoutNullOptionals, withScopedResource, withAliasFallbacks] = normalizeFinalIssuesForOrchestrator([
    validFinalIssue({
      work_type: null,
      requires_human_review: null,
      resource_target: null,
    }),
    validFinalIssue({
      decomposition_key: "scoped-resource",
      resource_target: {
        kind: "git_repo",
        id: "repo-main",
        repo_scope: null,
      },
    }),
    validFinalIssue({
      decomposition_key: "alias-fallbacks",
      work_type: null,
      workType: "code",
      requires_human_review: null,
      requiresHumanReview: true,
      resource_target: null,
      resourceTarget: { kind: "git_repo", id: "repo-side", repo_scope: "api" },
    }),
  ]);

  assert.equal(Object.hasOwn(withoutNullOptionals, "work_type"), false);
  assert.equal(Object.hasOwn(withoutNullOptionals, "requires_human_review"), false);
  assert.equal(Object.hasOwn(withoutNullOptionals, "resource_target"), false);
  assert.deepEqual(withScopedResource.resource_target, { kind: "git_repo", id: "repo-main" });
  assert.equal(withAliasFallbacks.work_type, "code");
  assert.equal(withAliasFallbacks.requires_human_review, true);
  assert.deepEqual(withAliasFallbacks.resource_target, {
    kind: "git_repo",
    id: "repo-side",
    repo_scope: "api",
  });
});

test("final issue validation accepts absent optional fields and rejects malformed optional fields", () => {
  const acceptedFailures = [];
  validateFinalIssues(
    [
      validFinalIssue(),
      validFinalIssue({ decomposition_key: "manual-review", requires_human_review: true }),
    ],
    acceptedFailures,
  );
  assert.deepEqual(acceptedFailures, []);

  const nullOptionalFailures = [];
  validateFinalIssues(
    [
      validFinalIssue({
        work_type: null,
        requires_human_review: null,
        resource_target: null,
      }),
      validFinalIssue({
        decomposition_key: "repo-scope-null",
        resource_target: {
          kind: "git_repo",
          id: "repo-main",
          repo_scope: null,
        },
      }),
    ],
    nullOptionalFailures,
  );
  assert.deepEqual(nullOptionalFailures, []);

  const invalidWorkTypeFailures = [];
  validateFinalIssues([validFinalIssue({ work_type: "docs" })], invalidWorkTypeFailures);
  assert.deepEqual(invalidWorkTypeFailures, ["invalid_final_issue_work_type"]);

  const invalidHumanReviewFailures = [];
  validateFinalIssues(
    [validFinalIssue({ requires_human_review: "yes" })],
    invalidHumanReviewFailures,
  );
  assert.deepEqual(invalidHumanReviewFailures, ["invalid_final_issue_requires_human_review"]);

  const malformedResourceTargetFailures = [];
  validateFinalIssues(
    [validFinalIssue({ resource_target: { kind: "git_repo" } })],
    malformedResourceTargetFailures,
  );
  assert.deepEqual(malformedResourceTargetFailures, ["invalid_final_issue_resource_target"]);
});

test("issue creation composes optional work_type and human-review labels", async () => {
  const client = capturingLinearClient();
  const shape = {
    team: { id: "team-1" },
    issueStatuses: { todo: { id: "state-todo" } },
    issueLabels: {
      work_type_code: { id: "label-code", name: "Code" },
      work_type_non_code: { id: "label-non-code", name: "Non-code" },
      human_review: { id: "label-human-review", name: "human-review" },
    },
  };
  const resourceTarget = { kind: "git_repo", id: "repo-main", repo_scope: "apps/web" };
  const issues = [
    validFinalIssue({
      work_type: "code",
      requires_human_review: true,
      resource_target: resourceTarget,
    }),
    validFinalIssue({
      decomposition_key: "manual-ops",
      requires_human_review: true,
    }),
    validFinalIssue({
      decomposition_key: "docs-update",
      work_type: "non_code",
      requires_human_review: false,
    }),
    validFinalIssue({ decomposition_key: "plain-update" }),
  ];

  await createOrReuseExecutionIssues({
    client,
    config: {},
    project: { id: "project-1" },
    shape,
    issues,
  });

  assert.deepEqual(client.created.map((issue) => issue.labelIds), [
    ["label-code", "label-human-review"],
    ["label-human-review"],
    ["label-non-code"],
    [],
  ]);
  assert.deepEqual(parseResourceTargetFromDescription(client.created[0].description), resourceTarget);
  assert.equal(parseResourceTargetFromDescription(client.created[1].description), null);
});

test("commitIssuesFromArtifact reports two of five human-review flagged final issues", async () => {
  const client = capturingLinearClient();
  const shape = {
    team: { id: "team-1" },
    issueStatuses: { todo: { id: "state-todo" } },
    projectStatuses: { in_progress: { id: "project-status-in-progress" } },
    issueLabels: {
      work_type_code: { id: "label-code", name: "Code" },
      work_type_non_code: { id: "label-non-code", name: "Non-code" },
      human_review: { id: "label-human-review", name: "human-review" },
    },
  };
  const artifact = {
    run_id: "run-human-review-flags",
    final_issues: [
      validFinalIssue({
        decomposition_key: "code-human",
        work_type: "code",
        requires_human_review: true,
      }),
      validFinalIssue({
        decomposition_key: "noncode-human",
        work_type: "non_code",
        requires_human_review: true,
      }),
      validFinalIssue({
        decomposition_key: "code-auto",
        work_type: "code",
      }),
      validFinalIssue({
        decomposition_key: "noncode-auto",
        work_type: "non_code",
        requires_human_review: false,
      }),
      validFinalIssue({ decomposition_key: "plain-auto" }),
    ],
    project_update_markdown: [
      "run_id: run-human-review-flags",
      "",
      "Created execution issues.",
      "",
      "## What I did with each part of your project",
      "- Created the final issue set.",
    ].join("\n"),
  };
  const trace = { attributes: {}, spans: [], annotations: [] };

  await commitIssuesFromArtifact({
    client,
    config: {},
    project: { id: "project-1" },
    shape,
    artifact,
    trace,
    replayed: false,
  });

  assert.deepEqual(client.created.map((issue) => issue.labelIds), [
    ["label-code", "label-human-review"],
    ["label-non-code", "label-human-review"],
    ["label-code"],
    ["label-non-code"],
    [],
  ]);
  const span = trace.spans.find((candidate) => candidate.name === "create_linear_issues_or_pause_project");
  assert.equal(span.attributes.final_issue_count, 5);
  assert.equal(span.attributes.human_review_flagged_count, 2);
  assert.deepEqual(span.attributes.human_review_flagged_issue_keys, [
    "code-human",
    "noncode-human",
  ]);
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
  const projectUpdates = [];
  return {
    created,
    projectUpdates,
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
    async updateProject(projectId, input) {
      return { id: projectId, ...input };
    },
    async findProjectUpdateByRunId(projectId, runId) {
      return projectUpdates.find((update) => update.projectId === projectId && update.runId === runId) || null;
    },
    async createProjectUpdate(input) {
      const update = { id: `project-update-${projectUpdates.length + 1}`, ...input };
      projectUpdates.push(update);
      return update;
    },
  };
}
