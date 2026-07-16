import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ENGINE_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import {
  ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
} from "../../../engine/orchestrator-output.mjs";
import {
  buildSubagentInvocationEnvelope,
} from "../../../engine/subagent-invocation-envelope.mjs";
import {
  ensureNeedsPrincipalProjectStatus,
  authorizeLinearSetupWorkspace,
} from "../cli.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { emptyTeamRegistry } from "../src/team-registry.mjs";
import { extractDecompositionKey } from "../src/issue-body.mjs";
import {
  initLinear,
  runDecomposition,
  setupLinearTeam,
} from "../src/linear-service.mjs";
import { buildOrchestratorPrompt } from "../src/orchestrator-turn.mjs";
import { buildLinearProjectBody } from "../src/project-body.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("fixture setup provisions Principal Escalation with one-shot admin and preserves app identity", async () => {
  const config = loadLinearConfig({ repoRoot });
  const sharedStatuses = projectStatusesWithoutNeedsPrincipal({ includePaused: true });
  const appClient = new FixtureLinearClient({
    statuses: sharedStatuses,
    viewerId: "app-viewer-1",
    viewerName: "Teami App",
  });
  const adminClient = new FixtureLinearClient({
    statuses: sharedStatuses,
    viewerId: "user-admin-1",
    viewerName: "Workspace Admin",
    adminGrant: true,
  });
  const credentialWrites = [];
  const events = [];
  const logs = [];
  const credentialStore = {
    target: "setup-store",
    writeTokenSet: async (tokenSet) => {
      credentialWrites.push(tokenSet);
    },
  };

  const authorization = await authorizeLinearSetupWorkspace({
    config,
    repoRoot,
    credentialStore,
    registry: emptyTeamRegistry(),
    teamNameHint: "Support Ops",
    isTTY: true,
    createSetupAuth: () =>
      fakeSetupAuth(appClient, {
        tokenSource: "browser",
        onPersist: () => events.push("persist-app-token"),
      }),
    authorizeOneShotAdmin: async (options) => {
      assert.equal(Object.hasOwn(options, "credentialStore"), false);
      events.push("admin-consent");
      return {
        adminClient: {
          createProjectStatus: (input) => adminClient.createProjectStatus(input),
        },
        teardown: async () => events.push("admin-teardown"),
      };
    },
    promptAdminProvisioning: async () => events.push("admin-prompt"),
    promptReauthorize: async () => "",
    log: (line) => logs.push(line),
  });

  assert.equal(authorization.needsPrincipalProjectStatus.id, "status-principal-escalation");
  assert.equal(authorization.needsPrincipalProjectStatus.type, "planned");
  assert.deepEqual(adminClient.createProjectStatusInputs, [{
    name: "Principal Escalation",
    color: "#F2994A",
    position: 20.01,
    type: "planned",
  }]);
  assert.deepEqual(credentialWrites, []);
  assert.deepEqual(events, [
    "admin-prompt",
    "admin-consent",
    "admin-teardown",
    "persist-app-token",
  ]);
  assert.ok(logs.some((line) => /admin approval only to create Principal Escalation/i.test(line)));

  let writtenCache = null;
  await setupLinearTeam({
    client: authorization.setupAuth.client,
    config,
    registry: emptyTeamRegistry(),
    repoRoot,
    teamName: "Support Ops",
    cache: {
      projectStatuses: {
        needs_principal: authorization.needsPrincipalProjectStatus.id,
      },
      projectStatusTypes: {
        needs_principal: authorization.needsPrincipalProjectStatus.type,
      },
    },
    workspace: authorization.workspace,
    declaredWorkspace: authorization.declaredWorkspace,
    writeCache: async (cache) => {
      writtenCache = cache;
    },
    writeRegistry: async () => {},
  });

  assert.equal(writtenCache.app_identity_id, "app-viewer-1");
  assert.equal(writtenCache.app_identity_name, "Teami App");
  assert.notEqual(writtenCache.app_identity_id, "user-admin-1");
  assert.equal(writtenCache.projectStatuses.needs_principal, "status-principal-escalation");

  let prompted = false;
  let consented = false;
  const existing = await ensureNeedsPrincipalProjectStatus({
    appClient,
    interactive: true,
    adminAuth: async () => {
      consented = true;
      throw new Error("admin consent must not be requested when the status exists");
    },
    prompt: async () => {
      prompted = true;
    },
    log: () => {},
  });

  assert.equal(existing.id, "status-principal-escalation");
  assert.equal(prompted, false);
  assert.equal(consented, false);
  assert.equal(adminClient.createProjectStatusInputs.length, 1);
});

test("fixture E2E pauses in comments, carries the human answer into agent context, then resumes to In Progress", async () => {
  const config = loadLinearConfig({ repoRoot });
  const pauseReasons = ["product_questions", "discovery_needed", "needs_pm_review"];

  for (const reason of pauseReasons) {
    const client = await initializedRuntimeClient(config);
    const project = await seedProject(client, { statusId: "status-planned" });
    const originalContent = project.content;
    const runId = `run-pause-${reason.replace(/_/g, "-")}`;
    const questionsMarkdown = [
      `- Question: What should Teami decide for ${reason}?`,
      "  Blocks: The issue split depends on the answer.",
      "  Changes depending on answer: Scope and acceptance evidence may change.",
      "  Owner: Human",
    ].join("\n");

    const result = await runDecomposition({
      client,
      config,
      cache: client.cache,
      projectId: project.id,
      runStoreDir: tempRunStore(),
      runResult: pauseRunResult(runId, { reason, openQuestionsMarkdown: questionsMarkdown }),
    });

    assert.equal(result.status, "paused");
    assert.equal(client.projects[0].status.id, "status-principal-escalation");
    assert.equal(client.projects[0].content, originalContent);
    assertNoRetiredQuestionSection(client.projects[0].content);
    assert.equal(client.issues.length, 0);
    assert.equal(client.issues.some((issue) => /^Discovery\b/i.test(issue.title || "")), false);
    assert.equal(client.projectUpdates.length, 0);
    assert.equal(client.comments.length, 1);
    assert.equal(client.comments[0].projectId, project.id);
    assert.equal(client.comments[0].user.id, "app-viewer-1");
    assert.ok(client.comments[0].body.includes(questionsMarkdown));
    assert.ok(client.comments[0].body.includes(`(code: \`run_id:${runId}\`)`));
    assert.deepEqual(
      client.events
        .filter((event) => event.method === "updateProject")
        .map((event) => event.input),
      [{ statusId: "status-principal-escalation" }],
    );

    if (reason !== "product_questions") continue;

    const answerText =
      "Human answer: optimize the pilot for support admins first, then invite operations leads after the workflow proves stable.";
    client.seedProjectComment({
      projectId: project.id,
      body: answerText,
      user: { id: "user-admin-1", name: "Workspace Admin" },
    });
    await client.updateProject(project.id, { statusId: "status-planned" });

    const resumedProject = await client.getProjectContext(project.id);
    assert.equal(resumedProject.status.id, "status-planned");
    assert.deepEqual(Object.keys(resumedProject.comments[0]), ["author_id", "body", "created_at"]);
    assert.equal(resumedProject.comments[0].author_id, "user-admin-1");
    assert.equal(resumedProject.comments[0].body, answerText);

    const prompt = buildOrchestratorPrompt({
      runId: "run-resume-product-questions",
      project: resumedProject,
      selectableTargets: ["prompt/decomposition/pm_product_sufficiency_pass"],
      priorTurns: [],
      bounds: { rounds_used: 0, max_rounds: 6 },
      invocableRuntimeRoles: ["pm"],
      governingBody: "Use the project context to decompose the work.",
    });
    assert.ok(prompt.includes(answerText));

    const oversizedProject = {
      ...resumedProject,
      content: `${"Long project context.\n".repeat(5000)}Tail content after the cap.`,
      issues: Array.from({ length: 300 }, (_, index) => ({
        id: `existing-${index}`,
        identifier: `EX-${index}`,
        title: `Existing issue ${index}`,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
      })),
    };
    const envelope = buildSubagentInvocationEnvelope({
      body: "Review the project context and return one schema-valid turn.",
      runId: "run-resume-product-questions",
      role: "pm",
      task: "Decide whether the human answer unblocks decomposition.",
      project: oversizedProject,
      allowedOutcomes: [{ status: "continue", reason: "product_context_sufficient" }],
    });
    assert.ok(envelope.includes(answerText));
    assert.ok(envelope.includes("[...truncated...]"));

    const resumeResult = await runDecomposition({
      client,
      config,
      cache: client.cache,
      projectId: project.id,
      runStoreDir: tempRunStore(),
      environment: safeEnvironment(),
      runResult: commitRunResult("run-resume-product-questions"),
    });

    assert.equal(resumeResult.status, "completed");
    assert.equal(client.projects[0].status.id, "status-started");
    assert.equal(client.projectUpdates.length, 1);
    assert.deepEqual(client.issues.map((issue) => extractDecompositionKey(issue.description)), [
      "project-plan",
      "project-build",
    ]);
  }
});

test("fixture E2E surfaces a failed_closed stop as a Principal Escalation comment", async () => {
  const config = loadLinearConfig({ repoRoot });
  const client = await initializedRuntimeClient(config);
  const project = await seedProject(client, { statusId: "status-planned" });

  const result = await runDecomposition({
    client,
    config,
    cache: client.cache,
    projectId: project.id,
    runStoreDir: tempRunStore(),
    runResult: failedClosedRunResult("run-bounds-breach"),
  });

  // A failed_closed safety stop now presents exactly like a product-question pause: one
  // app comment carrying the "why I stopped" summary + a move to Principal Escalation, and
  // no project update. To the human it is simply a project that needs their attention.
  assert.equal(result.status, "failed_closed");
  assert.equal(result.reason, "bounds_breach");
  assert.equal(client.projects[0].status.id, "status-principal-escalation");
  assert.equal(client.issues.length, 0);
  assert.equal(client.projectUpdates.length, 0);
  assert.equal(client.comments.length, 1);
  assert.ok(
    client.comments[0].body.includes(
      projectUpdateMarkdownForRun(
        "run-bounds-breach",
        "Decomposition stopped because the orchestrator hit a safety bound.",
      ),
    ),
  );
  assert.ok(client.comments[0].body.includes("(code: `run_id:run-bounds-breach`)"));
});

async function initializedRuntimeClient(config) {
  const client = new FixtureLinearClient();
  const result = await initLinear({
    client,
    config,
    writeCache: (cache) => {
      client.cache = {
        ...cache,
        teamRef: "support-ops",
        workspaceId: "workspace-1",
        teamId: "team-1",
      };
    },
  });
  assert.equal(result.ok, true);
  return client;
}

async function seedProject(client, { statusId } = {}) {
  return client.createProject({
    name: "Customer onboarding pilot",
    content: buildLinearProjectBody({ name: "Customer onboarding pilot" }),
    teamIds: ["team-1"],
    labelIds: [],
    statusId,
    templateId: "template-1",
  });
}

function pauseRunResult(runId, { reason, openQuestionsMarkdown } = {}) {
  return terminalRunResult({
    runId,
    outcome: "pause",
    reason,
    turns: [{ role: "pm", reason }],
    terminalOutput: {
      open_questions_markdown: openQuestionsMarkdown,
    },
  });
}

function failedClosedRunResult(runId) {
  return terminalRunResult({
    runId,
    outcome: "failed_closed",
    reason: "bounds_breach",
    turns: [],
    terminalOutput: {
      context_digest: "The orchestrator stopped before a safe terminal commit was ready.",
      project_update_markdown: projectUpdateMarkdownForRun(
        runId,
        "Decomposition stopped because the orchestrator hit a safety bound.",
      ),
      open_questions_markdown:
        "- Should this project be narrowed before retrying decomposition?",
    },
    bounds: {
      rounds_used: 7,
      max_rounds: 6,
    },
  });
}

function commitRunResult(runId) {
  return terminalRunResult({
    runId,
    outcome: "commit",
    reason: "synthesis_complete",
    turns: [
      { role: "sr_eng", reason: "technical_context_grounded" },
      { role: "pm", reason: "synthesis_complete" },
    ],
    terminalOutput: {
      project_update_markdown: projectUpdateMarkdownForRun(
        runId,
        "Decomposition completed with two issues.",
      ),
      final_issues: commitFinalIssues(),
    },
  });
}

function terminalRunResult({
  runId,
  outcome,
  reason,
  turns = [],
  terminalOutput,
  bounds = {},
} = {}) {
  const lastTurn = turns.at(-1) || {};
  return {
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome,
      reason,
      context_digest: lastTurn.context_digest || `${outcome} terminal context digest`,
      source_refs: [{ kind: "linear_project", id: "project-1" }],
      assumptions: [],
      constraints: [],
      risks: [],
      ...terminalOutput,
    },
    evidence: {
      perspectives_run: turns.map((turn) => ({
        role: turn.role || "pm",
        outcome: turn.reason || "unknown",
      })),
    },
    bounds: {
      rounds_used: Math.max(turns.length, 1),
      max_rounds: 6,
      ...bounds,
    },
  };
}

function commitFinalIssues() {
  return [
    {
      decomposition_key: "project-plan",
      title: "Prepare execution setup",
      depends_on: [],
      assignment: "Create the minimal execution setup needed for the Linear project.",
      output: "A setup artifact that lets the next implementation issue start.",
      acceptance_criteria: ["Setup artifact exists."],
      issue_body_markdown: [
        "## Assignment",
        "",
        "Create the minimal execution setup needed for the Linear project.",
        "",
        "## Acceptance Criteria",
        "",
        "- Setup artifact exists.",
      ].join("\n"),
    },
    {
      decomposition_key: "project-build",
      title: "Implement execution slice",
      depends_on: ["project-plan"],
      assignment: "Implement the first executable slice.",
      output: "A tested implementation slice ready for review.",
      acceptance_criteria: ["Tests pass."],
      issue_body_markdown: [
        "## Assignment",
        "",
        "Implement the first executable slice.",
        "",
        "## Acceptance Criteria",
        "",
        "- Tests pass.",
      ].join("\n"),
    },
  ];
}

function projectUpdateMarkdownForRun(runId, summary) {
  return [
    `run_id: ${runId}`,
    "",
    summary,
    "",
    "## What I did with each part of your project",
    "- The relevant project sections were accounted for in this decomposition result.",
  ].join("\n");
}

function safeEnvironment() {
  return { agent_write_credentials_present: false };
}

function assertNoRetiredQuestionSection(markdown) {
  assert.doesNotMatch(String(markdown || ""), /^## Open Questions\b/m);
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-pause-fixture-e2e-"));
}

function fakeSetupAuth(client, {
  tokenSource = null,
  onPersist = () => {},
} = {}) {
  return {
    client,
    tokenProvider: {
      lastTokenSource: tokenSource,
      clear: async () => {},
      persistPendingTokenSet: async () => {
        onPersist();
        return true;
      },
      discardPendingTokenSet: async () => {},
    },
  };
}

function projectStatusesWithoutNeedsPrincipal({ includePaused = false } = {}) {
  return [
    { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "status-planned", name: "Planned", type: "planned", position: 20 },
    { id: "status-started", name: "In Progress", type: "started", position: 30 },
    { id: "status-completed", name: "Completed", type: "completed", position: 40 },
    ...(includePaused ? [{ id: "status-paused", name: "Paused", type: "planned", position: 20.02 }] : []),
  ];
}

function defaultProjectStatuses() {
  return [
    ...projectStatusesWithoutNeedsPrincipal(),
    { id: "status-principal-escalation", name: "Principal Escalation", type: "planned", position: 20.01 },
  ];
}

function defaultWorkflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "state-todo", name: "Todo", type: "unstarted", position: 20 },
    { id: "state-in-progress", name: "In Progress", type: "started", position: 30 },
    { id: "state-ready", name: "Ready", type: "unstarted", position: 40 },
    { id: "state-in-review", name: "In Review", type: "started", position: 41 },
    { id: "state-human-review", name: "Principal Review", type: "started", position: 42 },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", position: 30.01 },
    { id: "state-done", name: "Done", type: "completed", position: 50 },
  ];
}

class FixtureLinearClient {
  constructor({
    statuses = defaultProjectStatuses(),
    workflowStates = defaultWorkflowStates(),
    viewerId = "app-viewer-1",
    viewerName = "Teami App",
    workspaceId = "workspace-1",
    workspaceName = "Example Workspace",
    adminGrant = false,
  } = {}) {
    this.projectStatuses = statuses;
    this.workflowStates = workflowStates.map((state) => ({ ...state }));
    this.viewerId = viewerId;
    this.viewerName = viewerName;
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
    this.adminGrant = adminGrant;
    this.teams = [];
    this.projectLabels = [];
    this.issueLabels = [];
    this.templates = [];
    this.projects = [];
    this.issues = [];
    this.issueRelations = [];
    this.comments = [];
    this.projectUpdates = [];
    this.events = [];
    this.createProjectStatusInputs = [];
    this.cache = null;
  }

  async verifyAuth() {
    return { ok: true, viewerId: this.viewerId, viewerName: this.viewerName };
  }

  async getOrganization() {
    return { id: this.workspaceId, name: this.workspaceName };
  }

  async listTeams() {
    return this.teams;
  }

  async createTeam(input) {
    const team = {
      id: `team-${this.teams.length + 1}`,
      name: input.name,
      key: input.key || generatedTeamKey(input.name, this.teams.length + 1),
    };
    this.teams.push(team);
    return team;
  }

  async findProjectLabelsByName(name) {
    return this.projectLabels.filter((label) => !name || label.name === name);
  }

  async createProjectLabel(input) {
    const label = { id: `plabel-${slug(input.name)}`, ...input };
    this.projectLabels.push(label);
    return label;
  }

  async updateProjectLabel(id, input) {
    const label = requiredById(this.projectLabels, id, "project label");
    Object.assign(label, input);
    return label;
  }

  async findIssueLabelsByName(name, teamId) {
    return this.issueLabels.filter(
      (label) => !label.archived && (!name || label.name === name) && (!teamId || label.teamId === teamId),
    );
  }

  async createIssueLabel(input) {
    const label = { id: `ilabel-${slug(input.name) || this.issueLabels.length + 1}`, ...input };
    this.issueLabels.push(label);
    return label;
  }

  async updateIssueLabel(id, input) {
    const label = requiredById(this.issueLabels, id, "issue label");
    Object.assign(label, input);
    return label;
  }

  async listProjectStatuses() {
    return this.projectStatuses;
  }

  async createProjectStatus(input) {
    if (!this.adminGrant) {
      const error = new Error("Linear project status creation requires an admin grant.");
      error.code = "FORBIDDEN";
      error.errors = [{
        message: "Only admin users can create project statuses.",
        path: ["projectStatusCreate"],
        extensions: { code: "FORBIDDEN", statusCode: 403 },
      }];
      throw error;
    }
    this.createProjectStatusInputs.push({ ...input });
    const status = {
      id: input.id || `status-${slug(input.name) || this.projectStatuses.length + 1}`,
      name: input.name,
      type: input.type,
      color: input.color,
      position: input.position,
    };
    this.projectStatuses.push(status);
    return status;
  }

  async listWorkflowStates() {
    return this.workflowStates.filter((state) => !state.archived);
  }

  async createWorkflowState(input) {
    const state = {
      id: `state-${slug(input.name) || this.workflowStates.length + 1}`,
      name: input.name,
      type: input.type,
      teamId: input.teamId || null,
      ...("description" in input ? { description: input.description ?? null } : {}),
      ...("color" in input ? { color: input.color ?? null } : {}),
      ...("position" in input ? { position: input.position } : {}),
    };
    this.workflowStates.push(state);
    return state;
  }

  async updateWorkflowState(id, input) {
    const state = requiredById(this.workflowStates, id, "workflow state");
    Object.assign(state, input);
    return state;
  }

  async archiveWorkflowState(id) {
    requiredById(this.workflowStates, id, "workflow state").archived = true;
    return { ok: true };
  }

  async archiveIssueLabel(id) {
    requiredById(this.issueLabels, id, "issue label").archived = true;
    return { ok: true };
  }

  async findTemplatesByName(name, type, teamId) {
    return this.templates.filter(
      (template) =>
        (!name || template.name === name) &&
        (!type || template.type === type) &&
        (!teamId || template.teamId === teamId),
    );
  }

  async createTemplate(input) {
    const template = { id: `template-${this.templates.length + 1}`, ...input };
    this.templates.push(template);
    return template;
  }

  async updateTemplate(id, input) {
    const template = requiredById(this.templates, id, "template");
    Object.assign(template, input);
    return template;
  }

  async createProject(input) {
    const project = {
      id: `project-${this.projects.length + 1}`,
      url: `https://linear.test/project/${this.projects.length + 1}`,
      ...input,
      status: this.projectStatuses.find((status) => status.id === input.statusId),
      labels: (input.labelIds || []).map((id) => this.projectLabels.find((label) => label.id === id)).filter(Boolean),
    };
    this.projects.push(project);
    return project;
  }

  async updateProject(id, input) {
    this.events.push({ method: "updateProject", projectId: id, input: { ...input } });
    const project = requiredById(this.projects, id, "project");
    if (Object.hasOwn(input, "content")) project.content = input.content;
    if (input.statusId) project.status = this.projectStatuses.find((status) => status.id === input.statusId);
    if (input.labelIds) {
      project.labels = input.labelIds
        .map((labelId) => this.projectLabels.find((label) => label.id === labelId))
        .filter(Boolean);
    }
    return this.getProjectContext(id);
  }

  async getProjectContext(id) {
    const project = requiredById(this.projects, id, "project");
    return {
      ...project,
      comments: this.comments
        .filter((comment) => comment.projectId === id)
        .slice()
        .reverse()
        .map(agentVisibleComment),
      issues: this.issues
        .filter((issue) => issue.projectId === id)
        .map((issue) => ({
          ...issue,
          relations: this.issueRelations.filter(
            (relation) => relation.issue.id === issue.id || relation.relatedIssue.id === issue.id,
          ),
        })),
    };
  }

  async listProjectIssues(projectId) {
    return (await this.getProjectContext(projectId)).issues;
  }

  async findIssueByDecompositionKey(projectId, decompositionKey) {
    return this.issues.find(
      (issue) => issue.projectId === projectId && extractDecompositionKey(issue.description) === decompositionKey,
    ) || null;
  }

  async createIssue(input) {
    const issue = {
      id: `issue-${this.issues.length + 1}`,
      identifier: `LIN-${this.issues.length + 1}`,
      url: `https://linear.test/issue/${this.issues.length + 1}`,
      ...input,
      state: this.workflowStates.find((state) => state.id === input.stateId),
      labels: (input.labelIds || []).map((id) => this.issueLabels.find((label) => label.id === id)).filter(Boolean),
    };
    this.issues.push(issue);
    return issue;
  }

  async findOrCreateIssueRelation(input) {
    const existing = this.issueRelations.find(
      (relation) =>
        relation.type === input.type &&
        relation.issue.id === input.issueId &&
        relation.relatedIssue.id === input.relatedIssueId,
    );
    if (existing) return { created: false, relation: existing };
    const relation = {
      id: `relation-${this.issueRelations.length + 1}`,
      type: input.type,
      issue: requiredById(this.issues, input.issueId, "issue"),
      relatedIssue: requiredById(this.issues, input.relatedIssueId, "related issue"),
    };
    this.issueRelations.push(relation);
    return { created: true, relation };
  }

  async listIssues({ projectId = null, stateId = null, labelId = null } = {}) {
    return this.issues.filter((issue) => {
      if (projectId && issue.projectId !== projectId) return false;
      if (stateId && issue.stateId !== stateId && issue.state?.id !== stateId) return false;
      if (labelId && !issue.labelIds?.includes(labelId) && !issue.labels?.some((label) => label?.id === labelId)) {
        return false;
      }
      return true;
    });
  }

  async listComments({ projectId } = {}) {
    return this.comments
      .filter((comment) => comment.projectId === projectId)
      .slice()
      .reverse()
      .map(cloneComment);
  }

  async createComment({ projectId } = {}, body) {
    const project = requiredById(this.projects, projectId, "project");
    void project;
    return this.seedProjectComment({
      projectId,
      body,
      user: { id: this.viewerId, name: this.viewerName },
    });
  }

  seedProjectComment({ projectId, body, user }) {
    const comment = {
      id: `project-comment-${this.comments.length + 1}`,
      comment_id: `project-comment-${this.comments.length + 1}`,
      projectId,
      body,
      createdAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") + this.comments.length * 1000).toISOString(),
      user: { ...user },
    };
    this.comments.push(comment);
    return cloneComment(comment);
  }

  async findProjectUpdateByRunId(projectId, runId) {
    return this.projectUpdates.find((update) => update.projectId === projectId && update.runId === runId) || null;
  }

  async createProjectUpdate(input) {
    const update = {
      id: `project-update-${this.projectUpdates.length + 1}`,
      ...input,
    };
    this.projectUpdates.push(update);
    return update;
  }

  async listProjectUpdates(projectId) {
    return this.projectUpdates.filter((update) => update.projectId === projectId);
  }
}

function agentVisibleComment(comment) {
  return {
    author_id: comment.user?.id ?? null,
    body: typeof comment.body === "string" ? comment.body : "",
    created_at: comment.createdAt ?? null,
  };
}

function cloneComment(comment) {
  return {
    ...comment,
    user: { ...comment.user },
  };
}

function requiredById(collection, id, label) {
  const found = collection.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ${label} ${id || "unknown"}.`);
  return found;
}

function generatedTeamKey(name, fallbackNumber) {
  const letters = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 3);
  return letters || `T${fallbackNumber}`;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
