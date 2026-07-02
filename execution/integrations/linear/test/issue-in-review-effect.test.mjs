import assert from "node:assert/strict";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "../src/workflows/execution/effect-ids.mjs";
import {
  resolveInReviewIssueStatus,
  resolveIssueStatuses,
} from "../src/linear/shape-resolver.mjs";

test("resolveInReviewIssueStatus resolves in_review without requiring ready or unstarted", async () => {
  const calls = [];
  const client = {
    async listWorkflowStates(teamId) {
      calls.push(["listWorkflowStates", teamId]);
      return [
        { id: "state-in-review", name: "In Review", type: "started", teamId },
      ];
    },
  };

  const target = await resolveInReviewIssueStatus(client, configWithIssueStatuses(), "team-1");

  assert.deepEqual(calls, [["listWorkflowStates", "team-1"]]);
  assert.deepEqual(target, {
    id: "state-in-review",
    name: "In Review",
    type: "started",
    teamId: "team-1",
    targetType: "status",
  });
});

test("resolveInReviewIssueStatus returns null (does NOT throw) when a team has no In Review state", async () => {
  // Regression: a team not provisioned for the review function must not crash the
  // gateway's hot poll path. Before the optional-resolution fix this threw
  // "Cannot resolve configured in_review issue status 'In Review': found 0",
  // which unwound the whole poll iteration and starved decomposition/execution.
  const client = {
    async listWorkflowStates() {
      return [
        { id: "state-ready", name: "Ready", type: "unstarted", teamId: "team-1" },
        { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
      ];
    },
  };

  const target = await resolveInReviewIssueStatus(client, configWithIssueStatuses(), "team-1");
  assert.equal(target, null);
});

test("resolveInReviewIssueStatus does not fall back to an In Review label", async () => {
  const calls = [];
  const config = configWithIssueStatuses();
  config.linear.issue.labels.in_review = "In Review";
  const client = {
    async listWorkflowStates(teamId) {
      calls.push(["listWorkflowStates", teamId]);
      return [
        { id: "state-ready", name: "Ready", type: "unstarted", teamId: "team-1" },
        { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
      ];
    },
    async findIssueLabelsByName() {
      throw new Error("In Review status resolution must not use labels.");
    },
  };

  const target = await resolveInReviewIssueStatus(client, config, "team-1");

  assert.equal(target, null);
  assert.deepEqual(calls, [["listWorkflowStates", "team-1"]]);
});

test("resolveInReviewIssueStatus still throws on an ambiguous In Review configuration", async () => {
  // The optional path only forgives ABSENCE (found 0); an ambiguous team (found >1)
  // is a real misconfiguration and must still fail loud.
  const client = {
    async listWorkflowStates() {
      return [
        { id: "state-in-review-a", name: "In Review", type: "started", teamId: "team-1" },
        { id: "state-in-review-b", name: "In Review", type: "started", teamId: "team-1" },
      ];
    },
  };

  await assert.rejects(
    () => resolveInReviewIssueStatus(client, configWithIssueStatuses(), "team-1"),
    /found 2/,
  );
});

test("execution issue In Review effect runs last and applies the configured status via updateIssue", async () => {
  const registrySnapshot = snapshotRegistry();
  try {
    const { executionDefinition } = await import("../src/workflows/execution/definition.mjs");
    assert.deepEqual(
      executionDefinition.commit_effects.map((effect) => effect.id),
      [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID],
    );
    const inReviewEffect = executionDefinition.commit_effects.at(-1);
    assert.equal(inReviewEffect.id, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID);
    assert.equal(typeof inReviewEffect.probe, "function");
    assert.equal(typeof inReviewEffect.apply, "function");
    assert.equal(typeof inReviewEffect.verify, "function");

    const events = [];
    const updates = [];
    const issue = {
      id: "issue-1",
      identifier: "AF-123",
      teamId: "team-1",
      state: { id: "state-ready", name: "Ready", type: "unstarted" },
      labels: [],
    };
    const client = {
      async listWorkflowStates(teamId) {
        events.push("linear:listWorkflowStates");
        assert.equal(teamId, "team-1");
        return [
          { id: "state-ready", name: "Ready", type: "unstarted", teamId },
          { id: "state-in-review", name: "In Review", type: "started", teamId },
        ];
      },
      async getIssue(id) {
        events.push("linear:getIssue");
        assert.equal(id, "issue-1");
        return issue;
      },
      async updateIssue(id, input) {
        events.push("linear:updateIssue");
        updates.push({ id, input });
        assert.equal(id, "issue-1");
        assert.deepEqual(input, { stateId: "state-in-review" });
        issue.state = { id: input.stateId, name: "In Review", type: "started" };
        return issue;
      },
    };

    const effects = executionDefinition.commit_effects.map((effect) =>
      effect.id === GIT_REPO_COMMIT_EFFECT_ID ? fakeGitEffect(events) : effect
    );
    const result = await applyCommitEffects({
      effects,
      ctx: {
        client,
        config: configWithIssueStatuses(),
        shape: { team: { id: "team-1" } },
        payload: { linear_issue_id: "issue-1" },
        runId: "run-1",
      },
    });

    assert.equal(result.outcome, "ok");
    assert.deepEqual(events.slice(0, 3), ["git:probe", "git:apply", "git:verify"]);
    assert.equal(events.findIndex((entry) => entry === "linear:updateIssue") > 2, true);
    assert.deepEqual(updates, [{
      id: "issue-1",
      input: { stateId: "state-in-review" },
    }]);
    assert.deepEqual(result.applied.map((effect) => effect.id), [
      GIT_REPO_COMMIT_EFFECT_ID,
      LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
    ]);
    assert.deepEqual(result.applied.at(-1).identity, {
      linear_issue_id: "issue-1",
      issue_id: "issue-1",
      issue_key: "AF-123",
      target_type: "status",
      target_id: "state-in-review",
      status: "In Review",
      status_id: "state-in-review",
      state_id: "state-in-review",
      label_id: null,
    });
    assert.equal(result.produced_identities.at(-1).effect_id, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID);
    assert.equal(result.produced_identities.at(-1).identity.status_id, "state-in-review");
  } finally {
    restoreRegistry(registrySnapshot);
  }
});

test("resolveIssueStatuses resolves the six canonical issue statuses", async () => {
  const statuses = await resolveIssueStatuses({
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-todo", name: "Todo", type: "unstarted" },
        { id: "state-in-progress", name: "In Progress", type: "started" },
        { id: "state-in-review", name: "In Review", type: "started" },
        { id: "state-blocked", name: "Blocked", type: "started" },
        { id: "state-done", name: "Done", type: "completed" },
      ];
    },
  }, configWithIssueStatuses(), "team-1");

  assert.deepEqual(Object.keys(statuses), ["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
  assert.equal(statuses.todo.id, "state-todo");
  assert.equal(statuses.blocked.id, "state-blocked");
});

function fakeGitEffect(events) {
  return {
    id: GIT_REPO_COMMIT_EFFECT_ID,
    provider: "git",
    op: "commit_push_open_pr",
    async probe() {
      events.push("git:probe");
      return { satisfied: false };
    },
    async apply() {
      events.push("git:apply");
      return {
        ok: true,
        identity: {
          owner: "acme",
          repo: "product",
          branch: "af/execution/AF-1-5215fde5",
          pull_request: { id: "pr-1", number: 42 },
        },
      };
    },
    async verify() {
      events.push("git:verify");
      return { ok: true };
    },
  };
}

function configWithIssueStatuses() {
  return {
    linear: {
      issue: {
        labels: {
          discovery: "Discovery",
          needs_principal: "Needs Principal",
        },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          blocked: { name: "Blocked", type: "started" },
          done: { name: "Done", type: "completed" },
          in_review: { name: "In Review", type: "started" },
        },
      },
    },
  };
}

function snapshotRegistry() {
  return registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
}

function restoreRegistry(definitions) {
  resetRegistry();
  for (const definition of definitions) registerWorkflow(definition);
}
