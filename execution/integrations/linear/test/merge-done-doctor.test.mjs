import test from "node:test";
import assert from "node:assert/strict";

import {
  MERGE_DONE_AUTOMATION_CHECK_NAME,
  doctorLinear,
  mergeDoneAutomationVerdict,
} from "../src/linear/doctor-service.mjs";

const CONFIG = Object.freeze({
  linear: {
    team: {
      key: "AF",
      name: "Teami",
    },
    project: {
      labels: {
        has_open_questions: "Has Open Questions",
      },
      statuses: {
        backlog: { name: "Backlog", type: "backlog" },
        planned: { name: "Planned", type: "planned" },
        in_progress: { name: "In Progress", type: "started" },
        completed: { name: "Completed", type: "completed" },
      },
      template_name: "Teami Roadmap Item",
    },
    issue: {
      labels: {
        discovery: "Discovery",
        needs_principal: "Needs Principal",
      },
      statuses: {
        backlog: { name: "Backlog", type: "backlog" },
        todo: { name: "Todo", type: "unstarted" },
        in_progress: { name: "In Progress", type: "started" },
        in_review: { name: "In Review", type: "started" },
        blocked: { name: "Blocked", type: "started" },
        done: { name: "Done", type: "completed" },
      },
    },
  },
});

test("doctor passes the merge-to-Done check when Linear merge automation targets Done", async () => {
  const result = await doctorLinear({
    client: new DoctorClient({
      automation: {
        mergeWorkflowState: { id: "state-done", name: "Done", type: "completed" },
        gitAutomationStates: [],
      },
    }),
    config: CONFIG,
    cache: healthyCache(),
  });

  const check = mergeDoneCheck(result);
  assert.equal(result.healthy, true);
  assert.equal(check.ok, true);
  assert.match(check.message, /PR merge automation is wired/);
  assert.match(check.message, /Done \(completed\)/);
  assert.equal(checkByName(result, "issue status mappings").ok, true);
  assert.equal(checkByName(result, "issue label Needs Principal").ok, true);
});

test("doctor fails the merge-to-Done check with the dependency-stall message when not wired", async () => {
  const result = await doctorLinear({
    client: new DoctorClient({
      automation: {
        mergeWorkflowState: null,
        gitAutomationStates: [],
      },
    }),
    config: CONFIG,
    cache: healthyCache(),
  });

  const check = mergeDoneCheck(result);
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.match(check.message, /merge-to-Done automation is not wired/);
  assert.match(check.message, /Dependents will stall until you wire this automation/);
  assert.match(check.message, /move issues manually after merging/);
});

test("doctor fails loud when a required cached issue status id is missing", async () => {
  const cache = healthyCache();
  delete cache.issueStatuses.in_review;

  const result = await doctorLinear({
    client: new DoctorClient({
      automation: {
        mergeWorkflowState: { id: "state-done", name: "Done", type: "completed" },
        gitAutomationStates: [],
      },
    }),
    config: CONFIG,
    cache,
  });

  const check = checkByName(result, "issue status mappings");
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.match(check.message, /Cached Linear issue status in_review is missing/);
});

test("doctor fails loud when a cached label id no longer resolves", async () => {
  const cache = healthyCache();
  cache.issueLabels["Needs Principal"] = "ilabel-missing";

  const result = await doctorLinear({
    client: new DoctorClient({
      automation: {
        mergeWorkflowState: { id: "state-done", name: "Done", type: "completed" },
        gitAutomationStates: [],
      },
    }),
    config: CONFIG,
    cache,
  });

  const check = checkByName(result, "issue label Needs Principal");
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.match(check.message, /Cached Linear issue label Needs Principal=ilabel-missing no longer exists/);
});

test("merge-to-Done verdict accepts explicit PR-merge git automation rules", () => {
  const check = mergeDoneAutomationVerdict({
    teamName: "AF Teami",
    automation: {
      mergeWorkflowState: null,
      gitAutomationStates: [{
        id: "automation-1",
        event: "pullRequestMerged",
        branchPattern: "main",
        state: { id: "state-done", name: "Done", type: "completed" },
      }],
    },
  });

  assert.equal(check.ok, true);
  assert.match(check.message, /git automation event pullRequestMerged on main/);
  assert.match(check.message, /Done \(completed\)/);
});

function healthyCache() {
  return {
    teamId: "team-1",
    teamKey: "AF",
    projectTemplateId: "template-1",
    projectStatuses: {
      backlog: "status-backlog",
      planned: "status-planned",
      in_progress: "status-started",
      completed: "status-completed",
    },
    projectStatusTypes: {
      backlog: "backlog",
      planned: "planned",
      in_progress: "started",
      completed: "completed",
    },
    issueStatuses: {
      backlog: "state-backlog",
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      blocked: "state-blocked",
      done: "state-done",
    },
    projectLabels: {
      "Has Open Questions": "plabel-open",
    },
    issueLabels: {
      Discovery: "ilabel-discovery",
      "Needs Principal": "ilabel-needs-principal",
    },
  };
}

function mergeDoneCheck(result) {
  return checkByName(result, MERGE_DONE_AUTOMATION_CHECK_NAME);
}

function checkByName(result, name) {
  const check = result.checks.find((candidate) => candidate.name === name);
  assert.ok(check, `${name} doctor check should be present`);
  return check;
}

class DoctorClient {
  constructor({ automation }) {
    this.automation = automation;
  }

  async verifyAuth() {}

  async listTeams() {
    return [{ id: "team-1", key: "AF", name: "Teami" }];
  }

  async findProjectLabelsByName(name) {
    const labels = [{ id: "plabel-open", name: "Has Open Questions" }];
    return labels.filter((label) => !name || label.name === name);
  }

  async findIssueLabelsByName(name, teamId) {
    const labels = ["Discovery", "Needs Principal"].map((labelName) => ({
      id: `ilabel-${labelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      name: labelName,
      teamId: "team-1",
    }));
    return labels.filter((label) =>
      (!name || label.name === name) && (!teamId || label.teamId === teamId));
  }

  async listProjectStatuses() {
    return [
      { id: "status-backlog", name: "Backlog", type: "backlog" },
      { id: "status-planned", name: "Planned", type: "planned" },
      { id: "status-started", name: "In Progress", type: "started" },
      { id: "status-completed", name: "Completed", type: "completed" },
    ];
  }

  async findTemplatesByName(name, type, teamId) {
    return (!name || name === CONFIG.linear.project.template_name) &&
      (!type || type === "project") &&
      (!teamId || teamId === "team-1")
      ? [{
        id: "template-1",
        name: CONFIG.linear.project.template_name,
        type: "project",
        teamId: "team-1",
        templateData: { content: "## Open Questions\n" },
      }]
      : [];
  }

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
  }

  async getTeamGitAutomationSettings(teamId) {
    assert.equal(teamId, "team-1");
    return {
      id: teamId,
      key: "AF",
      name: "Teami",
      ...this.automation,
    };
  }
}
