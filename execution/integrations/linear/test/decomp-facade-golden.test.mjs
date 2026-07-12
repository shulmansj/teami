import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PRODUCED_IDENTITIES_TRACE_ATTRIBUTE } from "../../../engine/produced-identities.mjs";
import { readRunArtifact, runArtifactPath } from "../../../engine/run-store.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { extractDecompositionKey } from "../src/issue-body.mjs";
import {
  defaultOrchestratorRuntime,
  executeOrchestratorTurn,
} from "../src/orchestrator-turn.mjs";
import { createOrchestratorRoster } from "../src/orchestrator-roster.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";
import {
  createProcessRuntimeExecutor,
  runDecompositionOrchestrator,
} from "../src/trigger-runner.mjs";
import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import {
  readReplayPending,
  writeMutationIntent,
} from "../src/trigger-idempotency.mjs";
import {
  maybeApplyPersistedArtifact,
} from "../src/workflows/decomposition/artifact-apply.mjs";
import { commitPayload as decompositionCommitPayload } from "../src/workflows/decomposition/commit-payload.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import { reviewDefinition } from "../src/workflows/review/definition.mjs";
import {
  persistRunArtifact,
  terminalArtifact,
} from "../src/workflows/decomposition/artifacts.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";

const TEST_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "decomp-facade");
const SCHEMA_FIXTURE_DIR = path.join(FIXTURE_DIR, "schemas");
const LIVE_SCHEMA_DIR = path.join(REPO_ROOT, "execution", "integrations", "linear", "schemas");
const PROJECT = readJson(path.join(TEST_DIR, "fixtures", "orchestrator-e2e", "webhook-inbox-project.json")).input.project;

const RUN_ID = "run_decomp_facade_commit";
const WAKE_ID = "wake-decomp-facade";
const DOMAIN_ID = "support-ops";
const WORKSPACE_ID = "workspace-1";
const TEAM_ID = "team-1";
const COMPLETED_AT = "2026-06-26T12:00:00.000Z";
const MUTATION_STARTED_AT = "2026-06-26T12:00:01.000Z";
const FIXED_TIME_MS = Date.parse(COMPLETED_AT);
const SR_ENG_TARGET = "prompt/decomposition/sr_eng_grounding_pass";
const PM_TARGET = "prompt/decomposition/pm_product_sufficiency_pass";
const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";
const ENVIRONMENT = Object.freeze({ agent_write_credentials_present: false });
const DOMAIN_TRACE = Object.freeze({
  domain_id: DOMAIN_ID,
  workspace_id: WORKSPACE_ID,
  team_id: TEAM_ID,
  behavior_repo_id: "local:test",
});
const DOMAIN_CONTEXT = Object.freeze({
  domainId: DOMAIN_ID,
  linear: Object.freeze({
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
  }),
  trace: DOMAIN_TRACE,
});

const SCHEMA_GOLDENS = Object.freeze([
  "orchestrator-turn-output.schema.json",
  "phase-packet.schema.json",
  "phase-packet.strict-generation.schema.json",
  "subagent-turn.schema.json",
  "subagent-turn.strict-generation.schema.json",
]);

test("DECOMP-FACADE freezes decomposition generation schema bytes", () => {
  // RV-8 regression backstop: importing the review workflow and X-EXEC branch
  // naming must not change any decomposition generation or persisted bytes.
  assert.equal(reviewDefinition.workflow_type, "review");
  assert.match(branchNameForIssue("AF-1"), /^af\/execution\/AF-1-[0-9a-f]{8}$/);
  assert.deepEqual(decompositionDefinition.packet_schema.schema_paths, [
    "execution/integrations/linear/schemas/phase-packet.schema.json",
    "execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json",
  ]);

  for (const schemaName of SCHEMA_GOLDENS) {
    assert.equal(
      readText(path.join(LIVE_SCHEMA_DIR, schemaName)),
      readText(path.join(SCHEMA_FIXTURE_DIR, schemaName)),
      `${schemaName} drifted from the DECOMP-FACADE frozen generation schema fixture`,
    );
  }
});

test("DECOMP-FACADE golden keeps decomposition persisted artifacts and live apply behavior byte-stable", async (t) => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-decomp-facade-"));
  t.after(() => {
    fs.rmSync(runStoreDir, { recursive: true, force: true });
  });

  const { output, runtimeEvidence, acceptedRefs } = await withFixedDateNow(() =>
    runFixtureOrchestrator(config));
  assert.deepEqual(validateOrchestratorOutput(output, decompositionCommitPayload), {
    ok: true,
    failureReasons: [],
  });
  assertFixtureBytes("orchestrator-output.json", jsonBytes(output));
  assertFixtureBytes("accepted-refs.json", jsonBytes(acceptedRefs));
  assertFixtureBytes("project-update.md", output.terminal_output.project_update_markdown);
  assertFixtureBytes("final-issues.json", jsonBytes(output.terminal_output.final_issues));

  const artifact = terminalArtifact({
    runId: RUN_ID,
    projectId: PROJECT.id,
    domainTrace: DOMAIN_TRACE,
    runResult: output,
    runtimeAssignments: resolveRoleRuntimeAssignments(config, "decomposition"),
    runtimeEvidence,
    environment: ENVIRONMENT,
    acceptedRefs,
    executionMode: "live",
    completedAt: COMPLETED_AT,
  });
  persistRunArtifact({
    artifact,
    repoRoot: REPO_ROOT,
    runStoreDir,
    trace: emptyTrace(),
    returnDurabilityResult: true,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
  });
  const artifactPath = runArtifactPath({ runId: RUN_ID, runStoreDir });
  assertFixtureBytes("commit-artifact.json", readText(artifactPath));
  assert.equal(artifact.project_update_markdown, output.terminal_output.project_update_markdown);
  assert.deepEqual(artifact.final_issues, output.terminal_output.final_issues);

  const persistedArtifact = readRunArtifact({
    runId: RUN_ID,
    runStoreDir,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
    requireTerminalAudit: true,
  });
  assert.deepEqual(persistedArtifact.final_issues, output.terminal_output.final_issues);
  assert.equal(persistedArtifact.project_update_markdown, output.terminal_output.project_update_markdown);

  writeMutationIntent({
    domainId: DOMAIN_ID,
    projectId: PROJECT.id,
    runId: RUN_ID,
    artifactKind: "commit",
    wakeId: WAKE_ID,
    startedAt: MUTATION_STARTED_AT,
    runStoreDir,
  });
  assertFixtureBytes(
    "mutation-intent.json",
    readText(path.join(runStoreDir, "unconfirmed-linear-mutation-intents", `${RUN_ID}.json`)),
  );
  assertFixtureBytes("replay-pending.json", jsonBytes(readReplayPending({
    domainId: DOMAIN_ID,
    projectId: PROJECT.id,
    runStoreDir,
  })));

  const client = createCapturingLinearClient(PROJECT);
  const trace = emptyTrace();
  const preMutationCalls = [];
  const liveResult = await maybeApplyPersistedArtifact({
    evalMode: false,
    client,
    config,
    shape: linearShape(),
    project: client.projectSnapshot(),
    artifact: persistedArtifact,
    payload: persistedArtifact.payload,
    trace,
    repoRoot: REPO_ROOT,
    runStoreDir,
    replayed: true,
    domainContext: DOMAIN_CONTEXT,
    onBeforeLinearMutation: async ({ artifactKind, runId }) => {
      preMutationCalls.push({ artifactKind, runId });
    },
    runId: RUN_ID,
    environment: ENVIRONMENT,
    durable_record: {
      written: true,
      terminal_artifact_schema_valid: true,
      artifact_path: artifactPath,
    },
  });

  assertFixtureBytes("produced-identities.json", jsonBytes(liveResult.produced_identities));
  assert.deepEqual(trace.attributes[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE], liveResult.produced_identities);
  assertFixtureBytes("live-gateway-behavior.json", jsonBytes(liveGatewayBehavior({
    client,
    liveResult,
    preMutationCalls,
    trace,
  })));
});

async function runFixtureOrchestrator(config) {
  const { orchestratorTurnExecutor, runtimeExecutor } = buildRealExecutors(
    config,
    RUN_ID,
    commitTurns(RUN_ID),
  );
  return runDecompositionOrchestrator({
    runId: RUN_ID,
    wake: { id: WAKE_ID, object_id: PROJECT.id },
    event: { id: "event-decomp-facade" },
    project: PROJECT,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: createOrchestratorRoster(),
    repoRoot: REPO_ROOT,
  });
}

function buildRealExecutors(config, runId, scriptedTurns) {
  const { runCommand } = makeFixtureRunCommand(runId, scriptedTurns);
  const orchestratorAssignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;
  const orchestratorTurnExecutor = (args) => executeOrchestratorTurn({
    ...args,
    orchestratorRuntime: (rtArgs) => defaultOrchestratorRuntime({
      ...rtArgs,
      assignment: orchestratorAssignment,
      runCommand,
    }),
  });
  const runtimeExecutor = createProcessRuntimeExecutor({ runCommand, repoRoot: REPO_ROOT });
  return { orchestratorTurnExecutor, runtimeExecutor };
}

function makeFixtureRunCommand(runId, scriptedTurns) {
  let turnIndex = 0;
  async function runCommand(command) {
    const schema = String(command?.generation_schema_path || command?.schema_path || "");
    if (schema.includes("turn-output")) {
      const envelope = scriptedTurns[turnIndex];
      turnIndex += 1;
      if (!envelope) throw new Error(`fixture exhausted at orchestrator turn ${turnIndex}`);
      return JSON.stringify(envelope);
    }
    const role = command?.runtime === "codex" ? "sr_eng" : "pm";
    return subagentPacket(runId, role);
  }
  return { runCommand };
}

function subagentPacket(runId, role) {
  return JSON.stringify({
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status: "continue",
    reason: role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient",
    context_digest: `${role} grounded context for the webhook inbox project.`,
    source_refs: [{ kind: "linear_project", id: PROJECT.id }],
    assumptions: [],
    constraints: [],
    risks: [],
  });
}

function commitTurns(runId) {
  return [
    { control_action: { action: "invoke_library", target_key: SR_ENG_TARGET } },
    { control_action: { action: "invoke_library", target_key: PM_TARGET } },
    {
      control_action: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      produced_content: commitProducedContent(runId),
    },
  ];
}

function commitProducedContent(runId) {
  return {
    context_digest: "Synthesized the webhook-inbox project into an agent-ready issue set.",
    source_refs: [{ kind: "linear_project", id: PROJECT.id }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Decomposed the Event Trigger Webhook Inbox project into an agent-ready issue set.",
      "",
      "## What I did with each part of your project",
      "- Objective + scope became the inbox build and the durable queue.",
      "- Operator-visible status became its own issue, blocked on the inbox build.",
    ].join("\n"),
    final_issues: [
      {
        decomposition_key: "webhook-inbox-core",
        title: "Build the hosted webhook inbox (authenticate, dedupe, normalize)",
        issue_body_markdown: [
          "## Assignment",
          "",
          "Build the hosted inbox.",
          "",
          "## Acceptance Criteria",
          "",
          "- Authenticates Linear + GitHub events.",
          "- Dedupes redelivery.",
          "- Normalizes to the internal wake envelope.",
        ].join("\n"),
        depends_on: [],
        assignment: "Build the hosted inbox: authenticate, dedupe, normalize events to the wake envelope.",
        output: "A hosted inbox that emits normalized wake envelopes.",
        acceptance_criteria: ["Authenticates events", "Dedupes redelivery", "Normalizes to the wake envelope"],
      },
      {
        decomposition_key: "webhook-inbox-queue",
        title: "Add the durable wake queue the Workflow Runner drains",
        issue_body_markdown: [
          "## Assignment",
          "",
          "Add a durable queue.",
          "",
          "## Acceptance Criteria",
          "",
          "- Persists wake envelopes durably.",
          "- Drains in order.",
        ].join("\n"),
        depends_on: [],
        assignment: "Add a durable queue that persists wake envelopes for the Workflow Runner.",
        output: "A durable wake queue.",
        acceptance_criteria: ["Persists wake envelopes durably", "Drains in order"],
      },
      {
        decomposition_key: "webhook-inbox-status",
        title: "Expose operator-visible status for every event",
        issue_body_markdown: [
          "## Assignment",
          "",
          "Expose per-event status.",
          "",
          "## Acceptance Criteria",
          "",
          "- Every event shows accepted / deduped / refused / enqueued.",
        ].join("\n"),
        depends_on: ["webhook-inbox-core"],
        assignment: "Expose operator-visible per-event status across surfaces.",
        output: "Operator-visible event status.",
        acceptance_criteria: ["Every event shows its disposition"],
      },
    ],
  };
}

function createCapturingLinearClient(project) {
  const statuses = {
    planned: { id: "project-status-planned", name: "Planned", type: "planned" },
    in_progress: { id: "project-status-started", name: "In Progress", type: "started" },
    backlog: { id: "project-status-backlog", name: "Backlog", type: "backlog" },
    completed: { id: "project-status-completed", name: "Completed", type: "completed" },
  };
  const state = {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      content: project.content,
      status: statuses.planned,
      labels: [],
      issues: [],
    },
    createdIssues: [],
    projectMutations: [],
    projectUpdates: [],
    relations: [],
  };
  return {
    state,
    projectSnapshot() {
      return clone(state.project);
    },
    async getProjectContext(projectId) {
      assert.equal(projectId, state.project.id);
      return clone(state.project);
    },
    async listWorkflowStates(teamId) {
      assert.equal(teamId, TEAM_ID);
      return [
        { id: "issue-status-backlog", name: "Backlog", type: "backlog" },
        { id: "issue-status-todo", name: "Todo", type: "unstarted" },
        { id: "issue-status-in-progress", name: "In Progress", type: "started" },
        { id: "issue-status-in-review", name: "In Review", type: "started" },
        { id: "issue-status-human-review", name: "Principal Review", type: "started" },
        { id: "issue-status-needs-principal", name: "Principal Escalation", type: "started" },
        { id: "issue-status-done", name: "Done", type: "completed" },
      ];
    },
    async findIssueByDecompositionKey(projectId, decompositionKey) {
      assert.equal(projectId, state.project.id);
      return clone(
        state.project.issues.find((issue) =>
          extractDecompositionKey(issue.description) === decompositionKey) || null,
      );
    },
    async createIssue(input) {
      const issue = {
        id: `issue-${state.createdIssues.length + 1}`,
        identifier: `AF-${state.createdIssues.length + 1}`,
        title: input.title,
        description: input.description,
        teamId: input.teamId,
        projectId: input.projectId,
        stateId: input.stateId,
        state: { id: input.stateId, name: "Todo", type: "unstarted" },
        labelIds: input.labelIds || [],
        labels: [],
        relations: [],
      };
      state.project.issues.push(issue);
      state.createdIssues.push(clone(issue));
      return clone(issue);
    },
    async updateProject(projectId, input) {
      assert.equal(projectId, state.project.id);
      state.projectMutations.push({ projectId, input: clone(input) });
      if (input.statusId === statuses.in_progress.id) state.project.status = statuses.in_progress;
      if (input.statusId === statuses.backlog.id) state.project.status = statuses.backlog;
      if (input.statusId === statuses.planned.id) state.project.status = statuses.planned;
      return clone(state.project);
    },
    async findProjectUpdateByRunId(projectId, runId) {
      assert.equal(projectId, state.project.id);
      return clone(state.projectUpdates.find((update) => update.runId === runId) || null);
    },
    async createProjectUpdate(input) {
      const update = {
        id: `project-update-${state.projectUpdates.length + 1}`,
        projectId: input.projectId,
        body: input.body,
        runId: input.runId,
      };
      state.projectUpdates.push(update);
      return clone(update);
    },
    async findOrCreateIssueRelation(input) {
      const existing = state.relations.find((relation) =>
        relation.issueId === input.issueId &&
        relation.relatedIssueId === input.relatedIssueId &&
        relation.type === input.type);
      if (existing) return { created: false, relation: clone(existing) };
      const relation = {
        id: `relation-${state.relations.length + 1}`,
        issueId: input.issueId,
        relatedIssueId: input.relatedIssueId,
        type: input.type,
      };
      state.relations.push(relation);
      const blocking = state.project.issues.find((issue) => issue.id === input.issueId);
      const dependent = state.project.issues.find((issue) => issue.id === input.relatedIssueId);
      blocking?.relations.push({
        id: relation.id,
        type: relation.type,
        issue: { id: blocking.id },
        relatedIssue: { id: dependent?.id || input.relatedIssueId },
      });
      return { created: true, relation: clone(relation) };
    },
  };
}

function linearShape() {
  return {
    team: { id: TEAM_ID, key: "AF", name: "Teami" },
    projectTemplate: { id: "template-roadmap", name: "Teami Roadmap Item" },
    projectStatuses: {
      planned: { id: "project-status-planned", name: "Planned", type: "planned" },
      backlog: { id: "project-status-backlog", name: "Backlog", type: "backlog" },
      in_progress: { id: "project-status-started", name: "In Progress", type: "started" },
      completed: { id: "project-status-completed", name: "Completed", type: "completed" },
    },
    projectLabels: {
      hasOpenQuestions: { id: "project-label-open-questions", name: "Has Open Questions" },
    },
    issueStatuses: {
      backlog: { id: "issue-status-backlog", name: "Backlog", type: "backlog" },
      todo: { id: "issue-status-todo", name: "Todo", type: "unstarted" },
      in_progress: { id: "issue-status-in-progress", name: "In Progress", type: "started" },
      in_review: { id: "issue-status-in-review", name: "In Review", type: "started" },
      human_review: { id: "issue-status-human-review", name: "Principal Review", type: "started" },
      needs_principal: { id: "issue-status-needs-principal", name: "Principal Escalation", type: "started" },
      done: { id: "issue-status-done", name: "Done", type: "completed" },
    },
    issueLabels: {
      discovery: { id: "issue-label-discovery", name: "Discovery" },
      human_review: { id: "issue-label-human-review", name: "human-review" },
    },
  };
}

function liveGatewayBehavior({ client, liveResult, preMutationCalls, trace }) {
  return {
    status: liveResult.status,
    pre_mutation_calls: preMutationCalls,
    project_mutations: client.state.projectMutations,
    created_issues: client.state.createdIssues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      teamId: issue.teamId,
      projectId: issue.projectId,
      stateId: issue.stateId,
      labelIds: issue.labelIds,
    })),
    relations: client.state.relations,
    project_updates: client.state.projectUpdates,
    final_project_status: client.state.project.status,
    result_summary: {
      status: liveResult.status,
      created_issue_ids: (liveResult.created || []).map((issue) => issue.id),
      reused_issue_ids: (liveResult.reused || []).map((issue) => issue.id),
      created_relation_ids: (liveResult.relationsCreated || []).map((relation) => relation.id),
      reused_relation_ids: (liveResult.relationsReused || []).map((relation) => relation.id),
      project_update_id: liveResult.projectUpdate?.id || null,
      produced_identities: liveResult.produced_identities || [],
    },
    trace_summary: {
      spans: trace.spans.map((span) => ({ name: span.name, attributes: span.attributes })),
      produced_identities: trace.attributes[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE] || [],
    },
  };
}

async function withFixedDateNow(fn) {
  const original = Date.now;
  Date.now = () => FIXED_TIME_MS;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

function assertFixtureBytes(name, actual) {
  if (process.env.UPDATE_DECOMP_FACADE_GOLDEN === "1") {
    fs.writeFileSync(path.join(FIXTURE_DIR, name), actual);
    return;
  }
  assert.equal(actual, readText(path.join(FIXTURE_DIR, name)), `${name} drifted from the DECOMP-FACADE golden`);
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function emptyTrace() {
  return { attributes: {}, spans: [], annotations: [] };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
