import test from "node:test";
import assert from "node:assert/strict";

import {
  MERGE_PATH_AF_REVIEW_CHECK_NAME,
  MERGE_PATH_DONE_CHECK_NAME,
  MERGE_PATH_GITHUB_CHECK_NAME,
  doctorMergePathAfReviewCheck,
  doctorMergePathGitHubCheck,
  doctorLinear,
} from "../src/linear/doctor-service.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
} from "../src/execution-pr-adapter.mjs";

const CONFIG = Object.freeze({
  linear: {
    team: {
      key: "AF",
      name: "Teami",
    },
    project: {
      statuses: {
        backlog: { name: "Backlog", type: "backlog" },
        planned: { name: "Planned", type: "planned" },
        in_progress: { name: "In Progress", type: "started" },
        completed: { name: "Completed", type: "completed" },
        needs_principal: { name: "Principal Escalation", type: "planned" },
      },
      template_name: "Teami Roadmap Item",
    },
    issue: {
      labels: {
        discovery: "Discovery",
        human_review: "human-review",
      },
      statuses: {
        backlog: { name: "Backlog", type: "backlog" },
        todo: { name: "Todo", type: "unstarted" },
        in_progress: { name: "In Progress", type: "started" },
        in_review: { name: "In Review", type: "started" },
        human_review: { name: "Principal Review", type: "started" },
        needs_principal: { name: "Principal Escalation", type: "started" },
        done: { name: "Done", type: "completed" },
      },
    },
  },
});

test("doctor reports merge-path Done and af-review checks without requiring Linear merge automation", async () => {
  const result = await doctorLinear({
    client: new DoctorClient(),
    config: CONFIG,
    cache: healthyCache(),
  });

  const doneCheck = mergePathDoneCheck(result);
  const afReviewCheck = checkByName(result, MERGE_PATH_AF_REVIEW_CHECK_NAME);
  assert.equal(result.healthy, true);
  assert.equal(doneCheck.ok, true);
  assert.match(doneCheck.message, /Done \(completed\)/);
  assert.equal(afReviewCheck.ok, true);
  assert.match(afReviewCheck.message, new RegExp(AF_REVIEW_STATUS_CONTEXT));
  assert.equal(result.checks.some((check) => /merge-to-Done automation/.test(check.name)), false);
  assert.equal(checkByName(result, "issue status mappings").ok, true);
  assert.equal(result.checks.some((check) => check.name === "project label Has Open Questions"), false);
  assert.equal(result.checks.some((check) => check.name === "issue label Needs Principal"), false);
  assert.equal(checkByName(result, "issue label human-review").ok, true);
});

test("doctor issue status mapping failure tells the adopter to rerun setup provisioning", async () => {
  const cache = healthyCache();
  delete cache.issueStatuses.needs_principal;

  const result = await doctorLinear({
    client: new DoctorClient(),
    config: CONFIG,
    cache,
  });

  const check = checkByName(result, "issue status mappings");
  assert.equal(result.healthy, false);
  assert.equal(check.state, "fail");
  assert.equal(check.ok, false);
  assert.equal(check.fix, "npm run init");
  assert.match(check.message, /Cached Linear issue status needs_principal is missing/);
  assert.match(check.message, /provision Linear issue statuses/);
});

test("doctor stays green when external merge-to-Done automation is absent", async () => {
  const result = await doctorLinear({
    client: new DoctorClient(),
    config: CONFIG,
    cache: healthyCache(),
  });

  assert.equal(result.healthy, true);
  assert.equal(mergePathDoneCheck(result).ok, true);
  assert.equal(result.checks.some((check) => /automation/.test(check.name)), false);
});

test("doctor fails loud when the cached Done issue status id is missing", async () => {
  const cache = healthyCache();
  delete cache.issueStatuses.done;

  const result = await doctorLinear({
    client: new DoctorClient(),
    config: CONFIG,
    cache,
  });

  const check = mergePathDoneCheck(result);
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.match(check.message, /Cached Linear issue status done is missing/);
});

test("doctor fails legacy caches that have no app identity", async () => {
  const cache = healthyCache();
  delete cache.app_identity_id;
  delete cache.app_identity_name;

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

  const check = checkByName(result, "app identity");
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.equal(check.fix, "npm run init");
  assert.match(check.message, /re-run `npm run init` to re-authorize as the app/);
});

test("doctor fails when the cached app identity differs from the live viewer", async () => {
  const result = await doctorLinear({
    client: new DoctorClient({
      viewerId: "app-viewer-2",
      automation: {
        mergeWorkflowState: { id: "state-done", name: "Done", type: "completed" },
        gitAutomationStates: [],
      },
    }),
    config: CONFIG,
    cache: healthyCache(),
  });

  const check = checkByName(result, "app identity");
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.equal(check.fix, "npm run init");
  assert.match(check.message, /Cached Linear app identity app-viewer-1 does not match live viewer app-viewer-2/);
});

test("doctor accepts a cached app identity that matches the live viewer", async () => {
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

  const check = checkByName(result, "app identity");
  assert.equal(check.ok, true);
  assert.match(check.message, /Teami App \(app-viewer-1\)/);
});

test("doctor ignores stale cached legacy Needs Principal label ids", async () => {
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

  assert.equal(result.healthy, true);
  assert.equal(result.checks.some((check) => check.name === "issue label Needs Principal"), false);
});

test("doctor fails loud when the cached human-review label id is missing", async () => {
  const cache = healthyCache();
  delete cache.issueLabels["human-review"];

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

  const check = checkByName(result, "issue label human-review");
  assert.equal(result.healthy, false);
  assert.equal(check.ok, false);
  assert.match(check.message, /Cached Linear issue label human-review is missing/);
});

test("af-review doctor check uses the shared execution PR adapter constant", () => {
  const check = doctorMergePathAfReviewCheck();
  assert.equal(check.ok, true);
  assert.match(check.message, new RegExp(AF_REVIEW_STATUS_CONTEXT));

  const mismatch = doctorMergePathAfReviewCheck({ context: "review" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, new RegExp(AF_REVIEW_STATUS_CONTEXT));
});

test("GitHub merge-path doctor check probes PR API without attempting a merge", async () => {
  const adapter = fakePrAdapter();
  const check = await doctorMergePathGitHubCheck({
    repoIdentity: repoIdentity(),
    prAdapter: adapter,
  });

  assert.equal(check.name, MERGE_PATH_GITHUB_CHECK_NAME);
  assert.equal(check.ok, true);
  assert.match(check.message, /Merge permission is proven at the first real merge/);
  assert.deepEqual(adapter.calls, [{
    method: "probePullRequest",
    request: {
      head: "af/execution/doctor-merge-path",
      base: "main",
    },
  }]);
});

test("GitHub merge-path doctor check fails closed when PR API is unreachable", async () => {
  const check = await doctorMergePathGitHubCheck({
    repoIdentity: repoIdentity(),
    prAdapter: fakePrAdapter({ probeError: new Error("github_execution_pr_auth_required") }),
  });

  assert.equal(check.ok, false);
  assert.match(check.message, /github_execution_pr_auth_required/);
  assert.match(check.message, /Merge permission is proven at the first real merge/);
});

test("GitHub merge-path doctor check is healthy and not applicable for domains without a code repo", async () => {
  const check = await doctorMergePathGitHubCheck({
    repoIdentityError: "review_git_repo_resource_missing",
  });

  assert.equal(check.name, MERGE_PATH_GITHUB_CHECK_NAME);
  assert.equal(check.state, "ok");
  assert.equal(check.ok, true);
  assert.match(check.message, /not applicable/);
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
      needs_principal: "status-principal-escalation",
    },
    projectStatusTypes: {
      backlog: "backlog",
      planned: "planned",
      needs_principal: "planned",
      in_progress: "started",
      completed: "completed",
    },
    issueStatuses: {
      backlog: "state-backlog",
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      human_review: "state-human-review",
      needs_principal: "state-needs-principal",
      done: "state-done",
    },
    issueLabels: {
      Discovery: "ilabel-discovery",
      "human-review": "ilabel-human-review",
    },
    app_identity_id: "app-viewer-1",
    app_identity_name: "Teami App",
  };
}

function repoIdentity() {
  return {
    owner: "acme",
    repo: "product",
    default_branch: "main",
  };
}

function fakePrAdapter({ probeError = null } = {}) {
  const calls = [];
  return {
    calls,
    async probePullRequest(request) {
      calls.push({ method: "probePullRequest", request });
      if (probeError) throw probeError;
      return null;
    },
    async getCommitStatuses() {
      throw new Error("doctor should not read statuses without a head sha");
    },
    async mergePullRequest() {
      throw new Error("doctor must not perform a merge");
    },
  };
}

function mergePathDoneCheck(result) {
  return checkByName(result, MERGE_PATH_DONE_CHECK_NAME);
}

function checkByName(result, name) {
  const check = result.checks.find((candidate) => candidate.name === name);
  assert.ok(check, `${name} doctor check should be present`);
  return check;
}

class DoctorClient {
  constructor({ viewerId = "app-viewer-1", viewerName = "Teami App", workflowStates = null } = {}) {
    this.viewerId = viewerId;
    this.viewerName = viewerName;
    this.workflowStates = workflowStates;
  }

  async verifyAuth() {
    return { ok: true, viewerId: this.viewerId, viewerName: this.viewerName };
  }

  async listTeams() {
    return [{ id: "team-1", key: "AF", name: "Teami" }];
  }

  async findProjectLabelsByName(name) {
    return [];
  }

  async findIssueLabelsByName(name, teamId) {
    const labels = ["Discovery", "human-review"].map((labelName) => ({
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
      { id: "status-principal-escalation", name: "Principal Escalation", type: "planned" },
      { id: "status-started", name: "In Progress", type: "started" },
      { id: "status-completed", name: "Completed", type: "completed" },
    ];
  }

  async listWorkflowStates(teamId) {
    assert.equal(teamId, "team-1");
    return this.workflowStates || [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-todo", name: "Todo", type: "unstarted" },
      { id: "state-in-progress", name: "In Progress", type: "started" },
      { id: "state-in-review", name: "In Review", type: "started" },
      { id: "state-human-review", name: "Principal Review", type: "started" },
      { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];
  }

  async getTeamGitAutomationSettings(teamId) {
    throw new Error("doctor should not inspect Linear/GitHub merge automation");
  }
}
