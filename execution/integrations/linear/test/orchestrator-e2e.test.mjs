import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadLinearConfig } from "../src/config.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import {
  defaultOrchestratorRuntime,
  executeOrchestratorTurn,
} from "../src/orchestrator-turn.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";
import { createOrchestratorRoster } from "../src/orchestrator-roster.mjs";
import {
  createProcessRuntimeExecutor,
  runDecompositionOrchestrator,
} from "../src/trigger-runner.mjs";
import { createOrReuseExecutionIssues } from "../src/workflows/decomposition/issue-commit.mjs";
import "../src/workflows/decomposition/definition.mjs";

// ---------------------------------------------------------------------------
// Orchestrator MACHINERY end-to-end.
//
// This drives the REAL orchestrator stack — the real runDecompositionOrchestrator
// loop, the real executeOrchestratorTurn + defaultOrchestratorRuntime (so the real
// turn-output ENVELOPE parser runs), the real executeSubagent (so the real subagent
// packet parser runs), the real roster, and the real run-scoped #50 recorder — over
// a FROZEN, self-contained project fixture. The ONLY thing faked is the CLI
// subprocess: an injected runCommand returns scripted stdout.
//
// This is the level the existing fixtures miss: orchestrator-loop.test.mjs injects
// at the EXECUTOR seam (orchestratorTurnExecutor / runtimeExecutor return objects
// directly), which bypasses the envelope/packet parsing where 4 of the 7 build bugs
// lived. Here we inject one level lower (the subprocess), so the real parse →
// assemble → validate machinery all runs.
//
// It tests the MACHINERY, not decomposition quality (quality is an evals concern).
// The scripted runtime output is a known-good run; assertions are about what the
// machinery does with it, never about whether a real model would produce it.
// ---------------------------------------------------------------------------

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(TEST_DIR, "fixtures/orchestrator-e2e/webhook-inbox-project.json"), "utf8"),
);
const PROJECT = FIXTURE.input.project;
const COMMIT_PAYLOAD = getWorkflowDefinition("decomposition").commitPayload;

function validate(runResult) {
  return validateOrchestratorOutput(runResult, COMMIT_PAYLOAD);
}

// Real library target_keys: the real roster resolves these to the real
// accepted-prompt snapshot bodies, and the real #50 recorder captures them.
const SR_ENG_TARGET = "prompt/decomposition/sr_eng_grounding_pass";
const PM_TARGET = "prompt/decomposition/pm_product_sufficiency_pass";

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

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
        issue_body_markdown:
          "## Assignment\n\nBuild the hosted inbox.\n\n## Acceptance Criteria\n\n- Authenticates Linear + GitHub events.\n- Dedupes redelivery.\n- Normalizes to the internal wake envelope.",
        depends_on: [],
        assignment: "Build the hosted inbox: authenticate, dedupe, normalize events to the wake envelope.",
        output: "A hosted inbox that emits normalized wake envelopes.",
        acceptance_criteria: ["Authenticates events", "Dedupes redelivery", "Normalizes to the wake envelope"],
      },
      {
        decomposition_key: "webhook-inbox-queue",
        title: "Add the durable wake queue the Workflow Runner drains",
        issue_body_markdown:
          "## Assignment\n\nAdd a durable queue.\n\n## Acceptance Criteria\n\n- Persists wake envelopes durably.\n- Drains in order.",
        depends_on: [],
        assignment: "Add a durable queue that persists wake envelopes for the Workflow Runner.",
        output: "A durable wake queue.",
        acceptance_criteria: ["Persists wake envelopes durably", "Drains in order"],
      },
      {
        decomposition_key: "webhook-inbox-status",
        title: "Expose operator-visible status for every event",
        issue_body_markdown:
          "## Assignment\n\nExpose per-event status.\n\n## Acceptance Criteria\n\n- Every event shows accepted / deduped / refused / enqueued.",
        depends_on: ["webhook-inbox-core"],
        assignment: "Expose operator-visible per-event status across surfaces.",
        output: "Operator-visible event status.",
        acceptance_criteria: ["Every event shows its disposition"],
      },
    ],
  };
}

// The known-good "commit" script: ground with sr_eng, sufficiency-check with pm,
// then terminate(commit) carrying the proposal.
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

// A runCommand that fakes ONLY the CLI subprocess. It dispatches on the command's
// generation schema: the orchestrator turn carries the turn-output schema; a
// subagent spawn carries the packet schema. Orchestrator turns are returned from a
// scripted sequence; subagent spawns return a valid packet keyed by runtime.
function makeFixtureRunCommand(runId, scriptedTurns) {
  let turnIndex = 0;
  const calls = [];
  async function runCommand(command) {
    const schema = String(command?.generation_schema_path || command?.schema_path || "");
    const isOrchTurn = schema.includes("turn-output");
    calls.push({ kind: isOrchTurn ? "orchestrator_turn" : "subagent", runtime: command?.runtime });
    if (isOrchTurn) {
      const envelope = scriptedTurns[turnIndex];
      turnIndex += 1;
      if (!envelope) throw new Error(`fixture exhausted at orchestrator turn ${turnIndex}`);
      return JSON.stringify(envelope);
    }
    const role = command?.runtime === "codex" ? "sr_eng" : "pm";
    return subagentPacket(runId, role);
  }
  return { runCommand, calls };
}

function buildRealExecutors(config, runId, scriptedTurns) {
  const { runCommand, calls } = makeFixtureRunCommand(runId, scriptedTurns);
  const orchestratorAssignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;
  // The REAL orchestrator-turn executor + the REAL runtime, with only the
  // subprocess (runCommand) faked. executeOrchestratorTurn nulls `assignment` when
  // a custom runtime is supplied, so the wrapper re-supplies it.
  const orchestratorTurnExecutor = (args) =>
    executeOrchestratorTurn({
      ...args,
      orchestratorRuntime: (rtArgs) =>
        defaultOrchestratorRuntime({ ...rtArgs, assignment: orchestratorAssignment, runCommand }),
    });
  const runtimeExecutor = createProcessRuntimeExecutor({ runCommand, repoRoot: REPO_ROOT });
  return { orchestratorTurnExecutor, runtimeExecutor, calls };
}

test("orchestrator machinery E2E: real loop over a frozen project, only the CLI faked, assembles a validated commit", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_e2e_machinery_commit";
  const { orchestratorTurnExecutor, runtimeExecutor, calls } = buildRealExecutors(config, runId, commitTurns(runId));

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-e2e", object_id: PROJECT.id },
    event: { id: "event-e2e" },
    project: PROJECT,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: createOrchestratorRoster(),
    repoRoot: REPO_ROOT,
  });

  // Terminal outcome assembled from the produced_content the real envelope parser pulled.
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");

  // The assembled issues are EXACTLY the scripted proposal — not fabricated, not dropped.
  assert.deepEqual(
    result.output.terminal_output.final_issues.map((i) => i.decomposition_key),
    ["webhook-inbox-core", "webhook-inbox-queue", "webhook-inbox-status"],
  );

  // The real roster resolved the library targets to runtime roles, in invocation order.
  assert.deepEqual(result.output.evidence.perspectives_run.map((p) => p.role), ["sr_eng", "pm"]);

  // Bounds reuse: 3 decision turns, 2 spawns.
  assert.equal(result.output.bounds.rounds_used, 3);
  assert.equal(result.output.bounds.invocations, 2);

  // #50 ledger completeness: the governing prompt (run-start) + both library refs were recorded.
  const refTargets = result.acceptedRefs.map((r) => r.target_key);
  assert.ok(refTargets.includes("prompt/decomposition/orchestrator_governing"));
  assert.ok(refTargets.includes(SR_ENG_TARGET));
  assert.ok(refTargets.includes(PM_TARGET));

  // The commit floor passes on the assembled output.
  assert.deepEqual(validate(result.output), { ok: true, failureReasons: [] });

  // Proof the SUBPROCESS seam ran (not the executor-level fake): the real loop made
  // the exact orchestrator-turn / subagent CLI calls, in order.
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["orchestrator_turn", "subagent", "orchestrator_turn", "subagent", "orchestrator_turn"],
  );
});

// A Linear client that CAPTURES the would-be writes instead of performing them, so
// the test asserts on the ACTIONS (createIssue / relation calls) the engine takes
// from the proposal — the real write machinery, never touching Linear.
function capturingLinearClient() {
  const created = [];
  const relations = [];
  return {
    created,
    relations,
    async findIssueByDecompositionKey() {
      return null; // every issue is new
    },
    async createIssue(input) {
      const issue = { id: `issue-${created.length + 1}`, ...input };
      created.push(issue);
      return issue;
    },
    async findOrCreateIssueRelation(input) {
      relations.push(input);
      return { created: true, relation: { id: `rel-${relations.length}`, ...input } };
    },
  };
}

test("orchestrator machinery E2E: the engine turns the proposal into the right createIssue actions", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_e2e_write_actions";
  // The proposal the loop assembles (same shape the loop committed above).
  const issues = commitProducedContent(runId).final_issues;
  const client = capturingLinearClient();
  const shape = { team: { id: "team-1" }, issueStatuses: { todo: { id: "state-todo" } } };

  const result = await createOrReuseExecutionIssues({ client, config, project: PROJECT, shape, issues });

  // Three NEW issues were created (the engine's actions), in proposal order, with
  // the proposal titles mapped onto createIssue calls.
  assert.equal(client.created.length, 3);
  assert.equal(result.reused.length, 0);
  assert.deepEqual(client.created.map((c) => c.title), [
    "Build the hosted webhook inbox (authenticate, dedupe, normalize)",
    "Add the durable wake queue the Workflow Runner drains",
    "Expose operator-visible status for every event",
  ]);

  // Each create targets the project + the resolved "todo" state, and embeds its
  // decomposition_key into the rendered body (the idempotency anchor).
  for (const c of client.created) {
    assert.equal(c.projectId, PROJECT.id);
    assert.equal(c.stateId, "state-todo");
  }
  assert.match(client.created[0].description, /webhook-inbox-core/);
  assert.match(client.created[2].description, /webhook-inbox-status/);

  // The one declared dependency (status BLOCKED ON core) became exactly one "blocks"
  // relation, wired from the core issue to the status issue.
  assert.equal(client.relations.length, 1);
  assert.equal(client.relations[0].type, "blocks");
  const coreId = client.created.find((c) => /webhook-inbox-core/.test(c.description)).id;
  const statusId = client.created.find((c) => /webhook-inbox-status/.test(c.description)).id;
  assert.equal(client.relations[0].issueId, coreId); // the blocker
  assert.equal(client.relations[0].relatedIssueId, statusId); // the blocked
  assert.equal(result.relationsCreated.length, 1);
});

// A runtime that never terminates (always invoke_library). With a low max_rounds the
// loop must fail CLOSED into a valid terminal artifact — not stop silently.
function makeAlwaysInvokeRunCommand(runId) {
  async function runCommand(command) {
    const schema = String(command?.generation_schema_path || command?.schema_path || "");
    if (schema.includes("turn-output")) {
      return JSON.stringify({ control_action: { action: "invoke_library", target_key: SR_ENG_TARGET } });
    }
    return subagentPacket(runId, "sr_eng");
  }
  return runCommand;
}

test("orchestrator machinery E2E: a run that never terminates fails closed at the bounds, not silently", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_e2e_bounds_breach";
  const runCommand = makeAlwaysInvokeRunCommand(runId);
  const orchestratorAssignment = resolveRoleRuntimeAssignments(config, "decomposition").orchestrator;
  const orchestratorTurnExecutor = (args) =>
    executeOrchestratorTurn({
      ...args,
      orchestratorRuntime: (rtArgs) =>
        defaultOrchestratorRuntime({ ...rtArgs, assignment: orchestratorAssignment, runCommand }),
    });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-bounds", object_id: PROJECT.id },
    event: { id: "event-bounds" },
    project: PROJECT,
    config,
    runtimeExecutor: createProcessRuntimeExecutor({ runCommand, repoRoot: REPO_ROOT }),
    orchestratorTurnExecutor,
    roster: createOrchestratorRoster(),
    repoRoot: REPO_ROOT,
    maxRounds: 2,
  });

  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "bounds_breach");
  assert.equal(result.output.bounds.max_rounds, 2);
  // A failed_closed run still produces a schema-valid terminal output (the commit
  // floor's "no terminal predicate blocks its own outcome" invariant).
  assert.deepEqual(validate(result.output), { ok: true, failureReasons: [] });
});

// ---------------------------------------------------------------------------
// The other two control-action paths through the real loop: pause + invoke_one_off.
// ---------------------------------------------------------------------------

function pauseProducedContent(runId) {
  return {
    context_digest: "Paused: the inbound-event auth model is underspecified for a safe issue set.",
    source_refs: [{ kind: "linear_project", id: PROJECT.id }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Paused decomposition: one product question blocks an agent-ready issue set.",
      "",
      "## What I did with each part of your project",
      "- Reviewed the objective and scope; the inbound-event auth model is unspecified.",
    ].join("\n"),
    open_questions_markdown: "- Which identity provider authenticates inbound Linear/GitHub webhooks?",
  };
}

test("orchestrator machinery E2E: a terminate(pause) assembles a schema-valid pause, no issues", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_e2e_pause";
  const scriptedTurns = [
    { control_action: { action: "invoke_library", target_key: PM_TARGET } },
    {
      control_action: { action: "terminate", outcome: "pause", reason: "product_questions" },
      produced_content: pauseProducedContent(runId),
    },
  ];
  const { orchestratorTurnExecutor, runtimeExecutor } = buildRealExecutors(config, runId, scriptedTurns);

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-pause", object_id: PROJECT.id },
    event: { id: "event-pause" },
    project: PROJECT,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: createOrchestratorRoster(),
    repoRoot: REPO_ROOT,
  });

  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "product_questions");
  // A pause carries a question, not an issue set.
  assert.equal(result.output.terminal_output.final_issues, undefined);
  assert.equal(typeof result.output.terminal_output.open_questions_markdown, "string");
  assert.ok(result.output.terminal_output.open_questions_markdown.trim().length > 0);
  // The pause terminal output is schema-valid (non-commit floor: no final_issues needed).
  assert.deepEqual(validate(result.output), { ok: true, failureReasons: [] });
});

test("orchestrator machinery E2E: an invoke_one_off spawns on an existing runtime and is recorded sanitized", async () => {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const runId = "run_e2e_one_off";
  const scriptedTurns = [
    {
      control_action: {
        action: "invoke_one_off",
        role_label: "security_reviewer",
        task: "Assess the webhook inbox's authentication and egress posture.",
        prompt: "You are a security reviewer. Report risks in the inbox's auth + egress controls.",
        runtime_role: "sr_eng",
      },
    },
    {
      control_action: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      produced_content: commitProducedContent(runId),
    },
  ];
  const { orchestratorTurnExecutor, runtimeExecutor, calls } = buildRealExecutors(config, runId, scriptedTurns);

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-oneoff", object_id: PROJECT.id },
    event: { id: "event-oneoff" },
    project: PROJECT,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster: createOrchestratorRoster(),
    repoRoot: REPO_ROOT,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  // The one-off spawned on the sr_eng runtime (codex) — the real loop reached the real
  // executeSubagent through the subprocess seam.
  assert.deepEqual(calls.map((c) => c.kind), ["orchestrator_turn", "subagent", "orchestrator_turn"]);
  assert.equal(calls[1].runtime, "codex");
  // The one-off invocation is recorded in perspectives_run under a sanitized
  // `one_off` reference (Seam 4 / I-4): runtime_role + the authored label/task/prompt,
  // persisted verbatim because they are clean (a secret-bearing field would redact).
  const oneOff = result.output.evidence.perspectives_run.find((p) => p.one_off?.role_label === "security_reviewer");
  assert.ok(oneOff, "the one-off invocation must appear in perspectives_run");
  assert.equal(oneOff.role, "sr_eng");
  assert.equal(oneOff.one_off.runtime_role, "sr_eng");
  assert.match(oneOff.one_off.prompt_body, /security reviewer/);
  assert.deepEqual(validate(result.output), { ok: true, failureReasons: [] });
});
