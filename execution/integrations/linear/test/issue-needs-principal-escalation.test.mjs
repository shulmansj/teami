import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  issueNeedsPrincipalEscalationEffect,
  listNeedsPrincipalIssuesForPrincipal,
  needsPrincipalIssuesBacklogFilter,
} from "../src/linear/issue-needs-principal-effect.mjs";
import { resolveNeedsPrincipalIssueStatus } from "../src/linear/shape-resolver.mjs";

test("resolveNeedsPrincipalIssueStatus resolves cached Principal Escalation status", async () => {
  const client = {
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
      ];
    },
  };
  const config = configWithNeedsPrincipalStatus();
  const cache = {
    issueStatuses: { needs_principal: "state-needs-principal" },
  };

  // Resolved on its own; does not require the execution trigger status.
  const target = await resolveNeedsPrincipalIssueStatus(client, config, "team-1", cache);

  assert.equal(target.stateId, "state-needs-principal");
  assert.equal(target.targetType, "status");
  assert.equal(target.state.resolution, "stable_id");
  assert.equal(Object.prototype.hasOwnProperty.call(target, "labelId"), false);
});

test("issue needs_principal effect applies the terminal escalation to an issue via updateIssue", async () => {
  const updates = [];
  const issue = {
    id: "issue-1",
    teamId: "team-1",
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    labels: [{ id: "label-existing", name: "Existing" }],
  };
  const client = {
    async getIssue(id) {
      assert.equal(id, "issue-1");
      return issue;
    },
    async updateIssue(id, input) {
      updates.push({ id, input });
      assert.equal(id, "issue-1");
      assert.equal(Object.prototype.hasOwnProperty.call(input, "labelIds"), false);
      assert.deepEqual(input, {
        stateId: "state-needs-principal",
      });
      issue.state = { id: input.stateId, name: "Principal Escalation", type: "started" };
      return issue;
    },
  };

  const result = await applyCommitEffects({
    effects: [issueNeedsPrincipalEscalationEffect],
    ctx: {
      client,
      config: configWithNeedsPrincipalStatus(),
      issue,
      shape: {
        team: { id: "team-1" },
        issueStatuses: {
          needs_principal: { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
        },
      },
      runId: "run-1",
    },
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(updates, [{
    id: "issue-1",
    input: {
      stateId: "state-needs-principal",
    },
  }]);
  assert.deepEqual(issue.labels, [{ id: "label-existing", name: "Existing" }]);
  assert.deepEqual(result.applied, [{
    id: "linear_issue_needs_principal",
    identity: {
      issue_id: "issue-1",
      target_type: "status",
      target_id: "state-needs-principal",
      state_id: "state-needs-principal",
    },
  }]);
});

test("escalation preserves pre-existing labels through an escalate + release round-trip", async () => {
  // The gateway hands the effect its ready-poll candidate as ctx.issue. The
  // escalation payload must not mention labels, so Linear preserves the issue's
  // existing label set without a full-set rewrite.
  const updates = [];
  const liveIssue = {
    id: "issue-round-trip",
    identifier: "SAN-5",
    teamId: "team-1",
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    labels: [
      { id: "label-code", name: "Code" },
      { id: "label-human-review", name: "human-review" },
    ],
  };
  const pollCandidate = {
    id: "issue-round-trip",
    identifier: "SAN-5",
    teamId: "team-1",
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    labels: [],
  };
  const client = {
    async getIssue(id) {
      assert.equal(id, "issue-round-trip");
      return liveIssue;
    },
    async updateIssue(id, input) {
      assert.equal(id, "issue-round-trip");
      updates.push(input);
      assert.equal(Object.prototype.hasOwnProperty.call(input, "labelIds"), false);
      liveIssue.state = { id: input.stateId, name: "Principal Escalation", type: "started" };
      return liveIssue;
    },
  };

  const result = await applyCommitEffects({
    effects: [issueNeedsPrincipalEscalationEffect],
    ctx: {
      client,
      config: configWithNeedsPrincipalStatus(),
      issue: pollCandidate,
      shape: {
        team: { id: "team-1" },
        issueStatuses: {
          needs_principal: { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
        },
      },
      runId: "run-round-trip",
    },
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(updates, [{ stateId: "state-needs-principal" }]);
  assert.deepEqual(
    liveIssue.labels.map((label) => label.id).sort(),
    ["label-code", "label-human-review"],
  );

  // The release gesture is the principal's own: move the issue out of Principal Escalation.
  liveIssue.state = { id: "state-todo", name: "Todo", type: "unstarted" };
  assert.deepEqual(
    liveIssue.labels.map((label) => label.id).sort(),
    ["label-code", "label-human-review"],
  );
});

test("principal backlog helper lists issues in the needs_principal Linear filter", async () => {
  const target = {
    id: "state-needs-principal",
    name: "Principal Escalation",
    type: "started",
    targetType: "status",
    stateId: "state-needs-principal",
  };
  const filter = needsPrincipalIssuesBacklogFilter({ target, teamId: "team-1" });
  assert.deepEqual(filter, {
    and: [
      { team: { id: { eq: "team-1" } } },
      { state: { id: { eq: "state-needs-principal" } } },
    ],
  });

  let receivedListOptions = null;
  const client = {
    async listIssues(options) {
      receivedListOptions = options;
      return [
        {
          id: "issue-needs-principal",
          state: { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
          labels: [{ id: "label-needs-principal", name: "Needs Principal" }],
        },
        {
          id: "issue-needs-principal-without-label",
          state: { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
          labels: [],
        },
        {
          id: "issue-labeled-without-needs-principal-status",
          state: { id: "state-ready", name: "Ready", type: "unstarted" },
          labels: [{ id: "label-needs-principal", name: "Needs Principal" }],
        },
      ];
    },
  };

  const issues = await listNeedsPrincipalIssuesForPrincipal({
    client,
    shape: {
      team: { id: "team-1" },
      issueStatuses: { needs_principal: target },
    },
  });

  assert.deepEqual(receivedListOptions, {
    teamId: "team-1",
    includeArchived: false,
    filter,
  });
  assert.deepEqual(issues.map((issue) => issue.id), [
    "issue-needs-principal",
    "issue-needs-principal-without-label",
  ]);
});

test("decomposition project pause remains project-scoped and does not use issue escalation", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/workflows/decomposition/artifact-apply.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const functionMatch = source.match(
    /export async function pauseProjectFromArtifact[\s\S]*?\n}\n\nexport async function commitIssuesFromArtifact/,
  );
  assert.ok(functionMatch, "pauseProjectFromArtifact source should be present");
  const pauseSource = functionMatch[0];
  // Both kinds of stop — a product-question pause and a failed_closed safety stop — go through the
  // ONE project comment twin (an app comment + a move to Principal Escalation) and neither posts a
  // project update. The pause stays PROJECT-scoped; it never reaches for issue-level escalation.
  const expectedProjectPauseCore = [
    "  const escalationResult = await applyProjectNeedsPrincipalComment({",
    "    client,",
    "    projectId: project.id,",
    "    runId: artifact.run_id,",
    "    questionsMarkdown: commentMarkdown,",
    "    statusId: shape.projectStatuses.needs_principal.id,",
  ].join("\n");

  assert.ok(pauseSource.includes(expectedProjectPauseCore));
  assert.doesNotMatch(pauseSource, /postAuthoredProjectUpdate|updateProject\(/);
  assert.doesNotMatch(pauseSource, /linear_issue_needs_principal|updateIssue/);
});

function configWithNeedsPrincipalStatus() {
  return {
    linear: {
      issue: {
        labels: { discovery: "Discovery" },
        statuses: {
          needs_principal: { name: "Principal Escalation", type: "started" },
        },
      },
    },
  };
}
