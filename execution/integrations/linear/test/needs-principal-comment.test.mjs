import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNeedsPrincipalEscalationPair,
  buildNeedsPrincipalCommentBody,
} from "../src/linear/needs-principal-comment.mjs";
import {
  applyProjectNeedsPrincipalComment,
  buildProjectNeedsPrincipalCommentBody,
} from "../src/linear/project-needs-principal-comment.mjs";

test("needs-principal comment body uses status destinations and never label release wording", () => {
  const config = {
    linear: {
      issue: {
        labels: { needs_principal: "Needs Principal" },
        statuses: {
          todo: { name: "Todo" },
          in_review: { name: "In Review" },
        },
      },
    },
  };

  const review = buildNeedsPrincipalCommentBody({
    site: "review",
    reason: "review_payload_invalid",
    siteContent: "The reviewer asked for a human decision.",
    config,
  });
  const ready = buildNeedsPrincipalCommentBody({
    site: "ready_fix",
    reason: "ready_fix_pr_missing",
    siteContent: "Teami expected an existing pull request for this issue but could not find one.",
    config,
  });

  assert.match(review, /^Teami blocked this issue because it needs a human decision before automated work continues\./);
  assert.match(review, /\(code: `review_payload_invalid`\)/);
  assert.match(review, /move this issue back to In Review/);
  assert.match(ready, /\(code: `ready_fix_pr_missing`\)/);
  assert.match(ready, /move this issue back to Todo/);
  assert.doesNotMatch(review, /remove .*label/i);
  assert.doesNotMatch(ready, /remove .*label/i);
});

test("project needs-principal comment body uses run_id marker and project-thread release wording", () => {
  const body = buildProjectNeedsPrincipalCommentBody({
    runId: "run-pause-1",
    questionsMarkdown: "- Which customer segment should come first?",
  });

  assert.match(body, /^Teami blocked this project because it needs a human decision before automated work continues\./);
  assert.match(body, /Which customer segment should come first\?/);
  assert.match(body, /\(code: `run_id:run-pause-1`\)/);
  assert.match(body, /answer the question in this Linear project thread/);
  assert.match(body, /move this project back to Planned/);
});

test("needs-principal pair posts once before status and replays without duplicate comments", async () => {
  const issue = {
    id: "issue-1",
    teamId: "team-1",
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
  };
  const client = createPairClient({ issue });
  client.failNextUpdate = true;

  const first = await applyNeedsPrincipalEscalationPair(pairInput({ client, issue }));

  assert.equal(first.outcome, "pending");
  assert.equal(first.reason, "simulated_status_failure");
  assert.equal(client.comments.length, 1);
  assert.deepEqual(client.events.map((event) => event.method), [
    "listIssueComments",
    "createIssueComment",
    "listIssueComments",
    "listWorkflowStates",
    "getIssue",
    "listWorkflowStates",
    "updateIssue",
  ]);
  assert.match(client.comments[0].body, /\(code: `ready_fix_pr_missing`\)/);

  const replay = await applyNeedsPrincipalEscalationPair(pairInput({ client, issue }));

  assert.equal(replay.outcome, "ok");
  assert.equal(client.comments.length, 1);
  assert.equal(replay.comment.already_present, true);
  assert.deepEqual(
    client.events.filter((event) => event.method === "updateIssue").map((event) => event.input),
    [{ stateId: "state-needs-principal" }, { stateId: "state-needs-principal" }],
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      client.events.filter((event) => event.method === "updateIssue").at(-1).input,
      "labelIds",
    ),
    false,
  );
  assert.equal(issue.state.id, "state-needs-principal");
});

test("needs-principal pair converges a review-site status failure without duplicating the comment", async () => {
  const issue = {
    id: "issue-review-1",
    teamId: "team-1",
    state: { id: "state-in-review", name: "In Review", type: "started" },
  };
  const client = createPairClient({ issue });
  client.failNextUpdate = true;

  const first = await applyNeedsPrincipalEscalationPair({
    ...pairInput({ client, issue }),
    site: "review",
    reason: "review_payload_invalid",
    siteContent: "The review output was incomplete and needs a human decision.",
  });

  assert.equal(first.outcome, "pending");
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].body, /\(code: `review_payload_invalid`\)/);
  assert.match(client.comments[0].body, /move this issue back to In Review/);

  const replay = await applyNeedsPrincipalEscalationPair({
    ...pairInput({ client, issue }),
    site: "review",
    reason: "review_payload_invalid",
    siteContent: "The review output was incomplete and needs a human decision.",
  });

  assert.equal(replay.outcome, "ok");
  assert.equal(client.comments.length, 1);
  assert.equal(replay.comment.already_present, true);
  assert.equal(issue.state.id, "state-needs-principal");
});

test("needs-principal pair fails closed before matching comments without app identity", async () => {
  const issue = {
    id: "issue-1",
    teamId: "team-1",
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
  };
  const client = createPairClient({ issue });

  const result = await applyNeedsPrincipalEscalationPair({
    ...pairInput({ client, issue }),
    cache: {
      teamId: "team-1",
      issueStatuses: { needs_principal: "state-needs-principal" },
    },
  });

  assert.equal(result.outcome, "pending");
  assert.equal(result.reason, "linear_app_identity_missing");
  assert.deepEqual(client.events, []);
  assert.equal(client.comments.length, 0);
});

test("project needs-principal twin posts once before status and replays without duplicate comments", async () => {
  const project = {
    id: "project-1",
    status: { id: "status-planned", name: "Planned", type: "planned" },
  };
  const client = createProjectPairClient({ project });
  client.failNextUpdate = true;

  const first = await applyProjectNeedsPrincipalComment(projectInput({ client, project }));

  assert.equal(first.outcome, "pending");
  assert.equal(first.reason, "linear_project_needs_principal_not_applied:simulated_status_failure");
  assert.equal(client.comments.length, 1);
  assert.deepEqual(client.events.map((event) => event.method), [
    "listComments",
    "createComment",
    "listComments",
    "updateProject",
  ]);
  assert.match(client.comments[0].body, /\(code: `run_id:run-pause-1`\)/);

  const replay = await applyProjectNeedsPrincipalComment(projectInput({ client, project }));

  assert.equal(replay.outcome, "ok");
  assert.equal(client.comments.length, 1);
  assert.equal(replay.comment.already_present, true);
  assert.deepEqual(
    client.events.filter((event) => event.method === "updateProject").map((event) => event.input),
    [{ statusId: "status-needs-principal" }, { statusId: "status-needs-principal" }],
  );
  assert.equal(project.status.id, "status-needs-principal");
});

test("project needs-principal twin posts a new latest comment when the same question pauses under a new run_id", async () => {
  const project = {
    id: "project-1",
    status: { id: "status-planned", name: "Planned", type: "planned" },
  };
  const client = createProjectPairClient({ project });
  const questionsMarkdown = "- Which customer segment should come first?";

  const first = await applyProjectNeedsPrincipalComment(projectInput({
    client,
    project,
    runId: "run-pause-1",
    questionsMarkdown,
  }));
  const second = await applyProjectNeedsPrincipalComment(projectInput({
    client,
    project,
    runId: "run-pause-2",
    questionsMarkdown,
  }));

  assert.equal(first.outcome, "ok");
  assert.equal(second.outcome, "ok");
  assert.equal(client.comments.length, 2);
  assert.equal(second.comment.already_present, false);
  assert.match(client.comments[0].body, /\(code: `run_id:run-pause-1`\)/);
  assert.match(client.comments[1].body, /\(code: `run_id:run-pause-2`\)/);
  assert.equal(client.events.filter((event) => event.method === "createComment").length, 2);
});

function pairInput({ client, issue }) {
  return {
    client,
    config: {
      linear: {
        issue: {
          statuses: {
            todo: { name: "Todo", type: "unstarted" },
            in_review: { name: "In Review", type: "started" },
            needs_principal: { name: "Principal Escalation", type: "started" },
          },
        },
      },
    },
    cache: {
      teamId: "team-1",
      app_identity_id: "app-viewer-1",
      issueStatuses: { needs_principal: "state-needs-principal" },
    },
    issueId: issue.id,
    issue,
    site: "ready_fix",
    reason: "ready_fix_pr_missing",
    siteContent: "Teami expected an existing pull request for this issue but could not find one.",
  };
}

function projectInput({
  client,
  project,
  runId = "run-pause-1",
  questionsMarkdown = "- Which customer segment should come first?",
} = {}) {
  return {
    client,
    projectId: project.id,
    runId,
    questionsMarkdown,
    statusId: "status-needs-principal",
    cache: {
      app_identity_id: "app-viewer-1",
    },
  };
}

function createPairClient({ issue }) {
  const states = new Map([
    ["state-todo", { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" }],
    ["state-in-review", { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" }],
    ["state-needs-principal", { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" }],
  ]);
  return {
    comments: [],
    events: [],
    failNextUpdate: false,
    async listIssueComments(issueId) {
      assert.equal(issueId, issue.id);
      this.events.push({ method: "listIssueComments", issueId });
      return this.comments.map((comment) => ({ ...comment, user: { ...comment.user } }));
    },
    async createIssueComment(issueId, body) {
      assert.equal(issueId, issue.id);
      this.events.push({ method: "createIssueComment", issueId, body });
      const comment = {
        id: `linear-comment-${this.comments.length + 1}`,
        body,
        user: { id: "app-viewer-1", name: "Teami App" },
      };
      this.comments.push(comment);
      return { ...comment };
    },
    async getIssue(issueId) {
      assert.equal(issueId, issue.id);
      this.events.push({ method: "getIssue", issueId });
      return issue;
    },
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      this.events.push({ method: "listWorkflowStates", teamId });
      return [...states.values()];
    },
    async updateIssue(issueId, input) {
      assert.equal(issueId, issue.id);
      this.events.push({ method: "updateIssue", issueId, input });
      if (this.failNextUpdate) {
        this.failNextUpdate = false;
        throw new Error("simulated_status_failure");
      }
      issue.state = states.get(input.stateId) || { id: input.stateId };
      return issue;
    },
  };
}

function createProjectPairClient({ project }) {
  return {
    comments: [],
    events: [],
    failNextUpdate: false,
    async listComments(target) {
      assert.deepEqual(target, { projectId: project.id });
      this.events.push({ method: "listComments", target: { ...target } });
      return [...this.comments].reverse().map(cloneComment);
    },
    async createComment(target, body) {
      assert.deepEqual(target, { projectId: project.id });
      this.events.push({ method: "createComment", target: { ...target }, body });
      const comment = {
        id: `linear-project-comment-${this.comments.length + 1}`,
        body,
        user: { id: "app-viewer-1", name: "Teami App" },
      };
      this.comments.push(comment);
      return cloneComment(comment);
    },
    async updateProject(projectId, input) {
      assert.equal(projectId, project.id);
      this.events.push({ method: "updateProject", projectId, input });
      if (this.failNextUpdate) {
        this.failNextUpdate = false;
        throw new Error("simulated_status_failure");
      }
      project.status = {
        id: input.statusId,
        name: "Principal Escalation",
        type: "planned",
      };
      return { ...project, status: { ...project.status } };
    },
  };
}

function cloneComment(comment) {
  return { ...comment, user: { ...comment.user } };
}
