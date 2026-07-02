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

test("resolveNeedsPrincipalIssueStatus resolves cached Blocked status and Needs Principal label", async () => {
  const client = {
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-blocked", name: "Blocked", type: "started" },
      ];
    },
    async findIssueLabelsByName(name, teamId) {
      assert.equal(name, null);
      assert.equal(teamId, "team-1");
      return [
        { id: "label-needs-principal", name: "Needs Principal", teamId },
      ];
    },
  };
  const config = configWithNeedsPrincipalStatus();
  const cache = {
    issueStatuses: { blocked: "state-blocked" },
    issueLabels: { "Needs Principal": "label-needs-principal" },
  };

  // Resolved on its own — does NOT require the execution trigger status to be resolvable.
  const target = await resolveNeedsPrincipalIssueStatus(client, config, "team-1", cache);

  assert.equal(target.stateId, "state-blocked");
  assert.equal(target.labelId, "label-needs-principal");
  assert.equal(target.targetType, "status");
  assert.equal(target.state.resolution, "stable_id");
  assert.equal(target.label.resolution, "stable_id");
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
      assert.deepEqual(input, {
        stateId: "state-blocked",
        labelIds: ["label-existing", "label-needs-principal"],
      });
      issue.state = { id: input.stateId, name: "Blocked", type: "started" };
      issue.labels = input.labelIds.map((labelId) => ({ id: labelId }));
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
          blocked: { id: "state-blocked", name: "Blocked", type: "started" },
        },
        issueLabels: {
          needs_principal: { id: "label-needs-principal", name: "Needs Principal" },
        },
      },
      runId: "run-1",
    },
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(updates, [{
    id: "issue-1",
    input: {
      stateId: "state-blocked",
      labelIds: ["label-existing", "label-needs-principal"],
    },
  }]);
  assert.deepEqual(result.applied, [{
    id: "linear_issue_needs_principal",
    identity: {
      issue_id: "issue-1",
      target_type: "status",
      target_id: "state-blocked",
      state_id: "state-blocked",
      label_id: "label-needs-principal",
    },
  }]);
});

test("principal backlog helper lists issues in the needs_principal Linear filter", async () => {
  const target = {
    id: "state-blocked",
    name: "Blocked",
    type: "started",
    targetType: "status",
    stateId: "state-blocked",
    labelId: "label-needs-principal",
  };
  const filter = needsPrincipalIssuesBacklogFilter({ target, teamId: "team-1" });
  assert.deepEqual(filter, {
    and: [
      { team: { id: { eq: "team-1" } } },
      { state: { id: { eq: "state-blocked" } } },
      { labels: { id: { eq: "label-needs-principal" } } },
    ],
  });

  let receivedListOptions = null;
  const client = {
    async listIssues(options) {
      receivedListOptions = options;
      return [
        {
          id: "issue-needs-principal",
          state: { id: "state-blocked", name: "Blocked", type: "started" },
          labels: [{ id: "label-needs-principal", name: "Needs Principal" }],
        },
        {
          id: "issue-blocked-without-label",
          state: { id: "state-blocked", name: "Blocked", type: "started" },
          labels: [],
        },
        {
          id: "issue-labeled-without-blocked-status",
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
      issueStatuses: { blocked: target },
      issueLabels: {
        needs_principal: { id: "label-needs-principal", name: "Needs Principal" },
      },
    },
  });

  assert.deepEqual(receivedListOptions, {
    teamId: "team-1",
    includeArchived: false,
    filter,
  });
  assert.deepEqual(issues.map((issue) => issue.id), ["issue-needs-principal"]);
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
  const expectedProjectPauseCore = [
    "  const packet = artifact.pause_packet;",
    "  const content = setOpenQuestionsMarkdown(project.content || \"\", packet.open_questions_markdown);",
    "  const labelIds = new Set((project.labels || []).map((label) => label.id));",
    "  labelIds.add(shape.projectLabels.hasOpenQuestions.id);",
    "",
    "  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });",
    "  await client.updateProject(project.id, {",
    "    content,",
    "    labelIds: [...labelIds],",
    "    statusId: shape.projectStatuses.backlog.id,",
    "  });",
  ].join("\n");

  assert.ok(pauseSource.includes(expectedProjectPauseCore));
  assert.doesNotMatch(pauseSource, /needs_principal|linear_issue_needs_principal|updateIssue/);
});

function configWithNeedsPrincipalStatus() {
  return {
    linear: {
      issue: {
        labels: { discovery: "Discovery", needs_principal: "Needs Principal" },
        statuses: {
          blocked: { name: "Blocked", type: "started" },
        },
      },
    },
  };
}
