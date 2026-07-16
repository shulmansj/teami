import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TEAM_REGISTRY_SCHEMA_VERSION, makeTeamRecord } from "../src/team-registry.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import {
  gatewayState,
  pollGatewayTeam,
} from "../src/gateway-loop.mjs";

registerGitRepoResourceKind();

const HEAD_SHA = "b".repeat(40);

test("In Progress recovery skips an issue with a live wake lease", async () => {
  const repoRoot = tempRepo();
  writeTeamCache(repoRoot);
  const calls = [];

  const result = await pollGatewayTeam({
    repoRoot,
    home: repoRoot,
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state: gatewayState(),
    store: storeFixture({
      wake: {
        lease_token: "lease-live",
        lease_expires_at: "2026-06-29T12:05:00.000Z",
      },
    }),
    now: () => new Date("2026-06-29T12:00:00.000Z"),
    idempotency: { listGitReplayPending: async () => [] },
    createLinearClient: async () => clientFixture({ calls }),
    runWarmResumeIssue: async () => {
      throw new Error("live In Progress issue must not launch a duplicate run");
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.processed, [{
    action: "skipped",
    reason: "execution_wake_live",
    issueId: "issue-in-progress",
    priorRunId: "run-prior",
    wakeId: "wake-prior",
  }]);
  assert.deepEqual(calls.filter((call) => call[0] === "updateIssue"), []);
});

test("In Progress recovery warm-resumes an expired running wake with a failed review PR", async () => {
  const repoRoot = tempRepo();
  writeTeamCache(repoRoot);
  const warmCalls = [];

  const result = await pollGatewayTeam({
    repoRoot,
    home: repoRoot,
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state: gatewayState(),
    store: storeFixture({
      wake: {
        lease_token: "lease-dead",
        lease_expires_at: "2026-06-29T11:55:00.000Z",
      },
    }),
    now: () => new Date("2026-06-29T12:00:00.000Z"),
    idempotency: { listGitReplayPending: async () => [] },
    createLinearClient: async () => clientFixture(),
    runDeps: { prAdapter: prAdapterFixture() },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
    runWarmResumeIssue: async (input) => {
      warmCalls.push(input);
      return { status: "completed", run: { run_id: "run-resume" } };
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].action, "warm_resume");
  assert.equal(result.processed[0].decision.priorRunId, "run-prior");
  await flushAsync();
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].issueId, "issue-in-progress");
});

test("In Progress recovery escalates an expired running wake when no execution PR is found", async () => {
  const repoRoot = tempRepo();
  writeTeamCache(repoRoot);
  const calls = [];

  const result = await pollGatewayTeam({
    repoRoot,
    home: repoRoot,
    config: configFixture(),
    registry: registryFixture(),
    team: teamFixture(),
    state: gatewayState(),
    store: storeFixture({
      wake: {
        lease_token: "lease-dead",
        lease_expires_at: "2026-06-29T11:55:00.000Z",
      },
    }),
    now: () => new Date("2026-06-29T12:00:00.000Z"),
    idempotency: { listGitReplayPending: async () => [] },
    createLinearClient: async () => clientFixture({ calls }),
    runDeps: { prAdapter: prAdapterFixture({ pullRequests: [] }) },
    resolveSessionHandle: () => ({ id: "driver-session-prior" }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].action, "escalate");
  assert.equal(result.processed[0].reason, "ready_fix_pr_missing");
  assert.deepEqual(calls.filter((call) => call[0] === "updateIssue"), [
    ["updateIssue", "issue-in-progress", {
      stateId: "state-needs-principal",
    }],
  ]);
  const commentCalls = calls.filter((call) => call[0] === "createIssueComment");
  assert.equal(commentCalls.length, 1, "the blocking transition must explain itself on the issue");
  assert.equal(commentCalls[0][1], "issue-in-progress");
  assert.match(commentCalls[0][2], /needs a human decision/);
  assert.match(commentCalls[0][2], /move this issue back to Todo/);
  assert.match(commentCalls[0][2], /ready_fix_pr_missing/);
});

function clientFixture({ calls = [] } = {}) {
  const issue = issueFixture();
  return {
    async listPlannedProjectCandidates() {
      return { candidates: [], pageInfo: { hasNextPage: false, endCursor: null } };
    },
    async listReadyIssueCandidates(_teamId, page = {}) {
      calls.push(["listReadyIssueCandidates", page.readyStateId]);
      return {
        candidates: page.readyStateId === "state-in-progress"
          ? [issueFixture()]
          : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async getIssueContext(id) {
      calls.push(["getIssueContext", id]);
      return { ...issue, id };
    },
    async listWorkflowStates(teamId) {
      calls.push(["listWorkflowStates", teamId]);
      return [
        { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId },
      ];
    },
    async findIssueLabelsByName(name, teamId) {
      calls.push(["findIssueLabelsByName", name, teamId]);
      if (teamId !== "team-1") return [];
      const labels = [
        { id: "label-needs-principal", name: "Needs Principal", teamId },
      ];
      return name ? labels.filter((label) => label.name === name) : labels;
    },
    async listIssueComments(id) {
      calls.push(["listIssueComments", id]);
      return calls
        .filter((call) => call[0] === "createIssueComment" && call[1] === id)
        .map((call, index) => ({
          id: `comment-${index + 1}`,
          body: call[2],
          user: { id: "app-viewer-1", name: "Teami App" },
        }));
    },
    async updateIssue(id, input) {
      calls.push(["updateIssue", id, input]);
      issue.state = { id: input.stateId, name: "Principal Escalation", type: "started" };
      if (Object.prototype.hasOwnProperty.call(input, "labelIds")) {
        issue.labels = input.labelIds.map((labelId) => ({ id: labelId }));
      }
      return {
        ...issue,
        id,
      };
    },
    async createIssueComment(id, body) {
      calls.push(["createIssueComment", id, body]);
      return { id: `comment-${calls.length}`, body, user: { id: "app-viewer-1", name: "Teami App" } };
    },
  };
}

function issueFixture() {
  return {
    id: "issue-in-progress",
    identifier: "AF-1",
    title: "Recover execution",
    description: "- Decomposition key: issue-in-progress\n\nRecover the execution.",
    url: "https://linear.test/AF-1",
    createdAt: "2026-06-29T11:00:00.000Z",
    team: { id: "team-1", key: "AF", name: "Teami" },
    project: { id: "project-1", name: "Project", url: "https://linear.test/project-1" },
    assignee: null,
    labels: [],
    state: { id: "state-in-progress", name: "In Progress", type: "started" },
    relations: [],
  };
}

function storeFixture({ wake }) {
  const priorRun = {
    run_id: "run-prior",
    object_id: "issue-in-progress",
    workflow_type: "execution",
    status: "running",
    started_at: "2026-06-29T11:50:00.000Z",
    wake_id: "wake-prior",
    session_handle_pointer: {
      source: "run_artifact.runtime_metadata",
      runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
    },
  };
  return {
    findLatestRunForObject(issueId) {
      assert.equal(issueId, "issue-in-progress");
      return { ...priorRun };
    },
    async getWake(wakeId) {
      assert.equal(wakeId, "wake-prior");
      return {
        id: "wake-prior",
        status: "running",
        ...wake,
      };
    },
  };
}

function prAdapterFixture({ pullRequests = null } = {}) {
  const prs = pullRequests || [{
    number: 7,
    state: "open",
    base: "main",
    head_sha: HEAD_SHA,
  }];
  return {
    async listPullRequestsForHead() {
      return prs.map((pr) => ({ ...pr }));
    },
    async getPullRequest(number) {
      const pr = prs.find((candidate) => candidate.number === number);
      if (!pr) throw new Error(`missing_pr:${number}`);
      return {
        number: pr.number,
        state: pr.state,
        base: { ref: pr.base },
        head: { sha: pr.head_sha, ref: "af/execution/AF-1-5215fde5" },
      };
    },
    async getCommitStatuses() {
      return [{
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        created_at: "2026-06-29T11:58:00.000Z",
      }];
    },
    async listPullRequestComments() {
      return [{
        id: "comment-1",
        body: formatAfReviewCommentBody({
          body: "Needs a fix.",
          disposition: "request-changes",
          head_sha: HEAD_SHA,
          run_id: "run-review",
        }),
        created_at: "2026-06-29T11:59:00.000Z",
      }];
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
      issue: {
        labels: {
          discovery: "Discovery",
          needs_principal: "Needs Principal",
          human_review: "human-review",
        },
        statuses: {
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          human_review: { name: "Principal Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
          done: { name: "Done", type: "completed" },
        },
      },
    },
  };
}

function registryFixture() {
  return {
    schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
    teams: [teamFixture()],
  };
}

function teamFixture() {
  return makeTeamRecord({
    teamRef: "team-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
    webhookId: "webhook-1",
    resources: [{
      id: "repo-1",
      kind: "git_repo",
      role: "primary",
      binding: {
        owner: "acme",
        repo: "product",
        default_branch: "main",
      },
    }],
  });
}

function writeTeamCache(repoRoot) {
  writeLinearCache(
    path.join(repoRoot, "teams", "team-1", "linear.json"),
    {
      teamId: "team-1",
      app_identity_id: "app-viewer-1",
      issueStatuses: {
        todo: "state-todo",
        in_progress: "state-in-progress",
        in_review: "state-in-review",
        human_review: "state-human-review",
        needs_principal: "state-needs-principal",
        done: "state-done",
      },
      projectStatuses: {
        planned: "status-planned",
      },
      issueLabels: {
        Discovery: "label-discovery",
        "Needs Principal": "label-needs-principal",
        "human-review": "label-human-review",
      },
    },
  );
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-in-progress-recovery-"));
  process.env.TEAMI_HOME = root;
  return root;
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
