import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  ACCEPTED_BASELINE_VARIANT_ID,
  EVAL_RUN_RECORD_SCHEMA_VERSION,
  buildEvalRunEnvelope,
  computeEvalInputsHash,
  createSnapshotEvalLinearClient,
  defaultEvalRunStoreDir,
  formatEvalRunReport,
  resolveDecompositionEvalInput,
  resolveEvalVariant,
  runDecompositionEvalTask,
} from "../src/decomposition-eval-cli.mjs";
import { PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import {
  buildProjectSnapshot,
  loadCapturedProjectSnapshot,
  writeProjectSnapshot,
} from "../src/project-snapshot-store.mjs";
import {
  createEvalModeReadOnlyLinearClient,
  runDecompositionEvalMode,
} from "../src/trigger-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const config = loadLinearConfig({ repoRoot });

// The two library subagent targets the orchestrator picks in these fixtures
// (both selectable: materializer-backed accepted_prompt entries, neither the
// judge nor the governing prompt).
const PM_LIBRARY_TARGET = "prompt/decomposition/pm_product_sufficiency_pass";
const SR_ENG_LIBRARY_TARGET = "prompt/decomposition/sr_eng_grounding_pass";

// The role-agnostic subagent turn schema (the retired per-phase packet schema is
// gone — the loop spawns role/prompt subagents, not phases).
const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function evalDomainContext() {
  return Object.freeze({
    domainId: "support-ops",
    status: "active",
    linear: Object.freeze({
      workspaceId: "workspace-1",
      teamId: "eval-team-1",
      teamKey: config.linear.team.key,
      teamName: config.linear.team.name,
      webhookId: "webhook-eval",
      cachePath: "unused",
    }),
    trace: Object.freeze({
      domain_id: "support-ops",
      workspace_id: "workspace-1",
      team_id: "eval-team-1",
      behavior_repo_id: "local:test-eval",
    }),
  });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-eval-cli-"));
}

function projectUpdateMarkdownForRun(runId, summary = "Decomposition completed.") {
  return `run_id: ${runId}\n\n## What I did with each part of your project\n\n${summary}`;
}

function copyAcceptedPromptAssets(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "execution", "evals", "decomposition", "phoenix-assets.json"), "utf8"),
  );
  const manifestPath = path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const entry of manifest.prompts || []) {
    if (!entry.snapshot_path) continue;
    const sourcePath = path.join(repoRoot, entry.snapshot_path);
    const destinationPath = path.join(root, entry.snapshot_path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
  return manifest;
}

function validExample({ projectId = "project-eval-1" } = {}) {
  return {
    schema_version: "decomposition-eval-example/v1",
    input: {
      source_type: "linear_project_snapshot",
      project: {
        id: projectId,
        name: "Customer onboarding pilot",
        description: null,
        content: "## Goal\n\nDecompose the onboarding pilot.\n\n## Open Questions\n",
        status: "planned",
        labels: [],
        existing_issues: [],
      },
      run_envelope: {
        workflow_version: DECOMPOSITION_FUNCTION_VERSION,
        allowed_source_boundaries: [],
        runtime_assignments: { pm: "claude/claude-opus-4-8", sr_eng: "codex/gpt-5.5" },
      },
      source_refs: [],
    },
    output: {
      terminal_status: "completed",
      terminal_reason: "no_blockers",
      phase_packets: [],
      final_issues: [],
      discovery_issues: [],
      dependency_relations: [],
      project_update_markdown: projectUpdateMarkdownForRun("source_run"),
    },
    reference: { human_annotations: [] },
    metadata: {
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: "active",
      dataset_split: "train",
      process_version: PROCESS_VERSION,
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
      source_trace_id: null,
      source_run_id: "source_run",
      content_retention: "sanitized_fixture",
    },
  };
}

function writeExampleFile(dir, example) {
  const filePath = path.join(dir, "example.json");
  fs.writeFileSync(filePath, `${JSON.stringify(example, null, 2)}\n`, "utf8");
  return filePath;
}

// A role-agnostic subagent turn (the free-loop analog of the retired per-phase
// packet): NO phase field, a distinct schema_version.
function subagentTurn(runId, { status = "continue", reason = "product_context_sufficient" } = {}) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status,
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-eval-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

// The runtimeExecutor the loop calls per spawn (invoke_library / invoke_one_off).
// It returns a valid subagent turn keyed by the resolved runtime_role and records
// the prompt body it was handed so a fixture can assert which body reached the
// subagent.
function fakeSubagentExecutor() {
  const calls = [];
  return {
    calls,
    async executeSubagent({ runtime_role, prompt, runId }) {
      calls.push({ runtime_role, prompt });
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      return {
        packet: subagentTurn(runId, { status: "continue", reason }),
        role: runtime_role,
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
}

function commitProducedContent(runId) {
  return {
    context_digest: "Reviewed project intent and grounded constraints for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-eval-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: projectUpdateMarkdownForRun(runId),
    final_issues: [
      {
        decomposition_key: "project-plan",
        title: "Prepare execution setup",
        issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
        depends_on: [],
        assignment: "Plan the setup.",
        output: "A documented execution setup plan.",
        acceptance_criteria: ["Plan exists."],
      },
      {
        decomposition_key: "project-build",
        title: "Implement execution slice",
        issue_body_markdown: "## Assignment\n\nBuild the setup.\n\n## Acceptance Criteria\n\n- Tests pass.",
        depends_on: ["project-plan"],
        assignment: "Build the setup.",
        output: "A tested execution slice.",
        acceptance_criteria: ["Tests pass."],
      },
    ],
  };
}

function pauseProducedContent(runId) {
  return {
    context_digest: "PM paused decomposition pending a product decision.",
    source_refs: [{ kind: "linear_project", id: "project-eval-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: projectUpdateMarkdownForRun(runId, "PM paused decomposition for product questions."),
    open_questions_markdown: "- Question: Which product decision should unblock decomposition?",
  };
}

// A scripted orchestratorTurnExecutor: invoke each library target in order, then
// terminate(commit) carrying authored producedContent on the terminating turn.
function fakeOrchestrator(runId, {
  libraryOrder = [PM_LIBRARY_TARGET, SR_ENG_LIBRARY_TARGET],
  terminal = { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
  producedContent = commitProducedContent(runId),
} = {}) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        evidence: null,
        sessionHandle: null,
      };
    }
    return { controlAction: terminal, producedContent, evidence: null, sessionHandle: null };
  };
}

// A scripted orchestratorTurnExecutor that pauses for product questions on its
// first decision turn (no library spawns).
function pauseOrchestrator(runId) {
  return async () => ({
    controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
    producedContent: pauseProducedContent(runId),
    evidence: null,
    sessionHandle: null,
  });
}

// A candidate accepted-prompt snapshot body for the prompt-override fixture: a
// well-formed accepted-prompt snapshot (header + sections, no forbidden
// sentinels/placeholders) — there are no required phase sections anymore.
function candidatePromptSnapshotText({
  targetKey = PM_LIBRARY_TARGET,
  runtimeInstructions = "CANDIDATE runtime instructions for one target only.",
} = {}) {
  return [
    "# Accepted Candidate Prompt",
    "",
    "```yaml",
    "prompt_version: candidate-test",
    `target_key: ${targetKey}`,
    "```",
    "",
    "## Runtime instructions",
    runtimeInstructions,
    "",
  ].join("\n");
}

function promptVersionResponse({ id, content }) {
  return jsonResponse({
    data: {
      id,
      template_type: "CHAT",
      template_format: "NONE",
      template: {
        type: "chat",
        messages: [{ role: "system", content }],
      },
    },
  });
}

function recordingTraceSink({ traceId = "f".repeat(32), failStart = false } = {}) {
  const events = [];
  return {
    events,
    async startRun(input) {
      events.push(["startRun", input]);
      if (failStart) {
        return { ok: false, traceId: null, status: "trace_unavailable", reason: "phoenix_unavailable" };
      }
      return {
        ok: true,
        traceId,
        status: "trace_unknown",
        phoenixAppUrl: "http://127.0.0.1:6006",
        run: { run_id: input.runId },
      };
    },
    async finishRun(input) {
      events.push(["finishRun", input]);
      return { status: "trace_exported", traceId, phoenixAppUrl: "http://127.0.0.1:6006" };
    },
    async shutdown() {
      events.push(["shutdown"]);
    },
  };
}

const phoenixDownProbe = async () => ({ ok: false, reason: "phoenix_not_running" });

const KNOWN_LINEAR_MUTATION_METHODS = [
  "createIssue",
  "updateIssue",
  "updateProject",
  "createProjectUpdate",
  "postProjectUpdate",
  "findOrCreateIssueRelation",
  "createTeam",
  "createProject",
  "createProjectLabel",
  "createIssueLabel",
  "createTemplate",
  "updateTemplate",
  "createWebhook",
  "updateWebhook",
];

function mutationRecordingClient(project) {
  const { client, cache } = createSnapshotEvalLinearClient({ config, project });
  const calls = [];
  const recorder = (name) =>
    async (...args) => {
      calls.push([name, args]);
      return {};
    };
  const recording = { ...client };
  for (const method of KNOWN_LINEAR_MUTATION_METHODS) {
    recording[method] = recorder(method);
  }
  return { client: recording, cache, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("eval:decomposition runs the orchestrator loop over a memory example and returns subagent invocations + terminal artifact", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const evalRunId = "eval-test-commit-1";
  const sink = recordingTraceSink();

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: sink,
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.status, "evaluated");
  assert.equal(result.non_mutating, true);
  assert.equal(result.mutation_skipped, true);
  assert.equal(result.variant_id, ACCEPTED_BASELINE_VARIANT_ID);
  // The orchestrator invoked pm then sr_eng (its chosen library order), one
  // subagent invocation per spawn.
  assert.deepEqual(
    result.subagent_invocations.map((entry) => entry.role),
    ["pm", "sr_eng"],
  );
  assert.equal(result.artifact.kind, "commit");
  assert.equal(result.terminal.status, "completed");
  assert.equal(result.terminal.final_issues.length, 2);
  assert.deepEqual(result.terminal.dependency_relations, [
    { blocking: "project-plan", blocked: "project-build" },
  ]);
  assert.ok(result.terminal.project_update_markdown.includes(`run_id: ${evalRunId}`));
  assert.equal(result.trace.trace_id, "f".repeat(32));
  assert.equal(result.trace.trace_status, "trace_exported");

  // Evaluator inputs for the step-8 chain: the step-5 checkInputs shape and
  // the step-6 in-memory judge inputs.
  assert.equal(
    result.evaluator_inputs.check_inputs.accepted_packet_sufficiency.terminalOutput.outcome,
    "commit",
  );
  assert.equal(
    result.evaluator_inputs.check_inputs.accepted_packet_sufficiency.terminalOutput.project_update_markdown,
    result.artifact.project_update_markdown,
  );
  assert.equal(result.evaluator_inputs.judge_inputs.artifact, result.artifact);
  assert.equal(result.evaluator_inputs.judge_inputs.trace_id, "f".repeat(32));
  assert.equal(
    result.evaluator_inputs.judge_inputs.snapshot.capture_source,
    "eval_mode_memory_snapshot",
  );

  // Local custody: terminal run artifact + captured memory snapshot live
  // under the eval-run store, never the live wake-run store.
  const evalArtifactDir = path.join(defaultEvalRunStoreDir(root), "runs");
  assert.ok(result.artifact_path.startsWith(path.join(defaultEvalRunStoreDir(root))));
  assert.ok(fs.existsSync(result.artifact_path));
  const captured = loadCapturedProjectSnapshot(evalRunId, { runStoreDir: evalArtifactDir });
  assert.equal(captured.ok, true);
  assert.equal(captured.snapshot.capture_source, "eval_mode_memory_snapshot");
  assert.equal(
    captured.snapshot.snapshot_hash,
    result.evaluator_inputs.judge_inputs.snapshot.snapshot_hash,
  );

  // Eval-run record.
  assert.ok(fs.existsSync(result.record_path));
  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.schema_version, EVAL_RUN_RECORD_SCHEMA_VERSION);
  assert.equal(record.inputs_hash, result.inputs_hash);
  assert.equal(record.status, "evaluated");
  assert.equal(record.non_mutating, true);
  assert.equal(record.variant.id, ACCEPTED_BASELINE_VARIANT_ID);
  assert.equal(record.subagent_invocation_count, 2);
  assert.equal(record.trace.trace_id, "f".repeat(32));
  assert.ok(formatEvalRunReport(result).some((line) => line.includes("non-mutating")));
});

test("pause-path eval run returns the pause artifact with authored prose and no mutation", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const evalRunId = "eval-test-pause-1";

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: pauseOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
  });

  assert.equal(result.status, "evaluated");
  assert.equal(result.mutation_skipped, true);
  assert.equal(result.artifact.kind, "pause");
  assert.equal(result.terminal.status, "paused");
  assert.equal(result.terminal.reason, "product_questions");
  assert.ok(result.terminal.open_questions_markdown.includes("Which product decision"));
  // The orchestrator paused on its first decision turn, before any spawn.
  assert.equal(result.subagent_invocations.length, 0);
});

test("eval-mode cannot call Linear mutation methods (recording fake sees zero calls on commit and pause paths)", async () => {
  const paths = [
    { orchestrator: (runId) => fakeOrchestrator(runId), expectedInvocations: 2 },
    { orchestrator: (runId) => pauseOrchestrator(runId), expectedInvocations: 0 },
  ];
  for (const { orchestrator, expectedInvocations } of paths) {
    const root = tempRoot();
    copyAcceptedPromptAssets(root);
    const { client, cache, calls } = mutationRecordingClient(validExample().input.project);
    const result = await runDecompositionEvalMode({
      linearClient: client,
      config,
      cache,
      domainContext: evalDomainContext(),
      projectId: "project-eval-1",
      runtimeExecutor: fakeSubagentExecutor(),
      orchestratorTurnExecutor: orchestrator("eval-no-mutation"),
      runId: "eval-no-mutation",
      repoRoot: root,
      runStoreDir: path.join(root, "runs"),
    });
    assert.equal(result.status, "evaluated");
    assert.equal(result.mutationSkipped, true);
    assert.equal(result.orchestratorOutput.evidence.perspectives_run.length, expectedInvocations);
    assert.deepEqual(calls, [], "eval mode must never invoke a Linear mutation method");
  }
});

test("eval-mode requires a resolved foreground DomainContext instead of cache-derived identity", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const { client, cache } = mutationRecordingClient(validExample().input.project);
  await assert.rejects(
    () => runDecompositionEvalMode({
      linearClient: client,
      config,
      cache,
      projectId: "project-eval-1",
      runtimeExecutor: fakeSubagentExecutor(),
      orchestratorTurnExecutor: fakeOrchestrator("eval-domain-required"),
      runId: "eval-domain-required",
      repoRoot: root,
      runStoreDir: path.join(root, "runs"),
    }),
    /domain_context_required/,
  );
});

test("eval-mode Linear client guard throws on mutation methods and the snapshot client has no mutation surface at all", async () => {
  const project = validExample().input.project;
  const { client: snapshotClient } = createSnapshotEvalLinearClient({ config, project });
  for (const method of KNOWN_LINEAR_MUTATION_METHODS) {
    assert.equal(
      typeof snapshotClient[method],
      "undefined",
      `snapshot eval client must not expose ${method}`,
    );
  }

  const { client: recording, calls } = mutationRecordingClient(project);
  const guarded = createEvalModeReadOnlyLinearClient(recording);
  assert.equal((await guarded.listTeams()).length, 1);
  assert.equal((await guarded.getProjectContext("project-eval-1")).id, "project-eval-1");
  for (const method of KNOWN_LINEAR_MUTATION_METHODS) {
    assert.throws(
      () => guarded[method]({}),
      new RegExp(`eval_mode_forbidden_linear_client_method:${method}`),
    );
  }
  assert.deepEqual(calls, []);
});

test("eval-mode never claims gateway wakes: no lease surface exists on the eval path", async () => {
  // Structural pin: the eval CLI module has no local trigger-store / lease
  // imports or calls at all.
  const evalSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "decomposition-eval-cli.mjs"),
    "utf8",
  );
  for (const banned of [
    "local-trigger-store",
    "createLocalTriggerStore",
    "claimNextWake",
    "markWakeRunning",
    "completeWake",
    "renewLease",
    "heartbeat",
    "deadLetterWake",
    "markMutationStarted",
  ]) {
    assert.ok(!evalSource.includes(banned), `decomposition-eval-cli.mjs must not reference ${banned}`);
  }
  // And the wrapped runDecompositionEvalMode itself takes no wake store:
  // its source carries no store/lease interaction.
  const triggerSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "trigger-runner.mjs"),
    "utf8",
  );
  const start = triggerSource.indexOf("export async function runDecompositionEvalMode");
  const end = triggerSource.indexOf("export function mapRunnerOutcomeToWake");
  assert.ok(start > 0 && end > start);
  const evalModeSource = triggerSource.slice(start, end);
  for (const banned of ["store.", "claimNextWake", "leaseToken", "heartbeat", "completeWake"]) {
    assert.ok(!evalModeSource.includes(banned), `runDecompositionEvalMode must not reference ${banned}`);
  }

  // The only wake-shaped object is the local eval pseudo-wake handed to the
  // trace sink; nothing is claimed anywhere.
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const sink = recordingTraceSink();
  await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId: "eval-wakefree-1",
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator("eval-wakefree-1"),
    traceSink: sink,
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
  });
  const startRun = sink.events.find(([name]) => name === "startRun")[1];
  assert.equal(startRun.wake.trigger_type, "eval.local");
  assert.ok(startRun.wake.id.startsWith("eval_"));
});

test("eval task works fully offline: degraded trace, report-only checks with honest named skips", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const evalRunId = "eval-offline-1";

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
    emitChecks: true,
  });

  assert.equal(result.ok, true, "Phoenix being down must not fail the eval run itself");
  assert.equal(result.checks.storage, "report_only");
  assert.equal(result.checks.reason, "local_phoenix_unavailable");
  const byName = Object.fromEntries(result.checks.checks.map((check) => [check.name, check]));
  assert.equal(byName.accepted_packet_sufficiency.status, "evaluated");
  assert.equal(byName.accepted_packet_sufficiency.annotation.annotator_kind, "CODE");
  // Honest evaluator-input policy (D10): structured issue inputs and the
  // post-mutation pause-state view do not exist in a non-mutating eval run.
  assert.equal(byName.decomposition_quality.status, "skipped");
  assert.equal(
    byName.decomposition_quality.skip_reason,
    "structured_issue_inputs_not_recorded_in_run_artifact",
  );
  assert.equal(byName.pause_state_correctness.status, "skipped");

  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.checks.storage, "report_only");
});

test("--example fails closed on schema mismatch and writes nothing", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const broken = validExample();
  delete broken.output.terminal_reason;
  broken.metadata.dataset_split = "nonsense";
  const examplePath = writeExampleFile(root, broken);

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator("eval-unused"),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "not_run");
  assert.equal(result.reason, "example_schema_mismatch");
  assert.ok(result.schema_errors.length > 0);
  assert.ok(!fs.existsSync(defaultEvalRunStoreDir(root)), "no eval-run record on fail-closed input");
});

test("--run fails closed on a missing captured snapshot and loads a present one", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const liveRunStoreDir = path.join(root, "live-runs");

  const missing = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    runId: "run_without_snapshot",
    liveRunStoreDir,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator("eval-unused"),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "not_run");
  assert.equal(missing.reason, "missing_project_snapshot");

  const projectContext = {
    id: "project-eval-1",
    name: "Customer onboarding pilot",
    content: "## Goal\n\nDecompose.\n\n## Open Questions\n",
    labels: [],
    issues: [],
  };
  writeProjectSnapshot(
    { runId: "run_with_snapshot", runStoreDir: liveRunStoreDir },
    buildProjectSnapshot({
      runId: "run_with_snapshot",
      project: projectContext,
      semanticStatus: "planned",
    }),
  );
  const evalRunId = "eval-from-run-1";
  const loaded = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    runId: "run_with_snapshot",
    liveRunStoreDir,
    evalRunId,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source.mode, "run");
  assert.equal(loaded.source.run_id, "run_with_snapshot");
  assert.equal(loaded.source.capture_source, "linear_run_context");
  assert.equal(loaded.artifact.kind, "commit");
});

test("--variant resolves runtime/model overrides, labels outputs, and fails closed on unknown variants", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const variantsPath = path.join(root, "variants.json");
  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v1",
      default_variant: "accepted_baseline",
      variants: {
        accepted_baseline: { description: "baseline", role_overrides: {} },
        candidate_pm: {
          description: "candidate PM model",
          role_overrides: { pm: { model: "candidate-model-x" } },
          judge_candidate_prompt_version_id: "ver_candidate_123",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const evalRunId = "eval-variant-1";
  let judgeArgs = null;
  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    variantId: "candidate_pm",
    variantsPath,
    judge: true,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
    runJudgeFn: async (args) => {
      judgeArgs = args;
      return { ok: false, judge_state: "judge_missing", reason: "test_stub", storage: "report_only", annotation_ids: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.variant_id, "candidate_pm");
  // The variant resolves into a DERIVED config: pm overridden, sr_eng intact,
  // committed config untouched.
  assert.notEqual(config.workflows.decomposition.roles.pm.model, "candidate-model-x");
  // The judge chain receives the variant's candidate prompt version reference
  // and the derived config.
  assert.equal(judgeArgs.candidatePromptVersionId, "ver_candidate_123");
  assert.equal(judgeArgs.config.workflows.decomposition.roles.pm.model, "candidate-model-x");
  assert.equal(
    judgeArgs.config.workflows.decomposition.roles.sr_eng.model,
    config.workflows.decomposition.roles.sr_eng.model,
  );
  assert.equal(result.judge.variant_id, "candidate_pm");
  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.variant.id, "candidate_pm");
  assert.deepEqual(record.variant.role_overrides, { pm: { model: "candidate-model-x" } });
  assert.equal(record.variant.judge_candidate_prompt_version_id, "ver_candidate_123");
  assert.deepEqual(record.variant.prompt_overrides, {});
  assert.deepEqual(record.variant.resolved_prompt_overrides, {});
  // Inputs hash is variant-aware.
  assert.notEqual(
    result.inputs_hash,
    computeEvalInputsHash({
      project: validExample().input.project,
      runEnvelope: buildEvalRunEnvelope({ config }),
      variant: { id: ACCEPTED_BASELINE_VARIANT_ID, role_overrides: {}, judge_candidate_prompt_version_id: null },
    }),
  );

  const unknown = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    variantId: "does_not_exist",
    variantsPath,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator("eval-unused"),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown_variant");
  assert.deepEqual(unknown.available.sort(), ["accepted_baseline", "candidate_pm"]);

  const missingFile = resolveEvalVariant({
    variantId: "anything",
    variantsPath: path.join(root, "nope.json"),
  });
  assert.equal(missingFile.ok, false);
  assert.equal(missingFile.reason, "variants_config_missing");
});

test("variants v2 accepts empty prompt overrides and fails closed on unknown target keys or fields", () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const variantsPath = path.join(root, "variants-v2.json");
  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v2",
      default_variant: "accepted_baseline",
      variants: {
        accepted_baseline: { role_overrides: {}, prompt_overrides: {} },
        phase_candidate: {
          role_overrides: {},
          prompt_overrides: {
            "prompt/decomposition/pm_product_sufficiency_pass": {
              candidate_prompt_version_id: "PV-PM-1",
            },
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const baseline = resolveEvalVariant({ variantsPath, repoRoot: root });
  assert.equal(baseline.ok, true);
  assert.deepEqual(baseline.variant.prompt_overrides, {});
  const populated = resolveEvalVariant({ variantId: "phase_candidate", variantsPath, repoRoot: root });
  assert.equal(populated.ok, true);
  assert.deepEqual(populated.variant.prompt_overrides, {
    "prompt/decomposition/pm_product_sufficiency_pass": {
      candidate_prompt_version_id: "PV-PM-1",
    },
  });

  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v2",
      default_variant: "bad",
      variants: {
        bad: {
          role_overrides: {},
          prompt_overrides: {
            "prompt/decomposition/not_a_manifest_target": {
              candidate_prompt_version_id: "PV-unknown",
            },
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const unknownTarget = resolveEvalVariant({ variantsPath, repoRoot: root });
  assert.equal(unknownTarget.ok, false);
  assert.equal(unknownTarget.reason, "invalid_variants_config");
  assert.ok(unknownTarget.failures.some((failure) => failure.includes("unknown_prompt_override_target")));

  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v2",
      default_variant: "bad",
      variants: {
        bad: {
          role_overrides: {},
          prompt_overrides: {
            "prompt/decomposition/pm_product_sufficiency_pass": {
              candidate_prompt_version_id: "PV-PM-1",
              surprise: true,
            },
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const unknownField = resolveEvalVariant({ variantsPath, repoRoot: root });
  assert.equal(unknownField.ok, false);
  assert.ok(unknownField.failures.some((failure) => failure.includes("unknown_prompt_override_key")));

  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v1",
      default_variant: "bad",
      variants: {
        bad: {
          role_overrides: {},
          prompt_overrides: {},
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const v1WithV2Field = resolveEvalVariant({ variantsPath, repoRoot: root });
  assert.equal(v1WithV2Field.ok, false);
  assert.ok(v1WithV2Field.failures.some((failure) => failure === "unknown_variant_key:bad:prompt_overrides"));
});

test("eval prompt override delivers the candidate body to the targeted library subagent and records its hash", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const targetKey = PM_LIBRARY_TARGET;
  const candidateVersionId = "PV-PM-OVERRIDE";
  const candidateContent = candidatePromptSnapshotText({
    targetKey,
    runtimeInstructions: "CANDIDATE_PM_PRODUCT_SUFFICIENCY_ONLY",
  });
  const variantsPath = path.join(root, "variants-v2.json");
  fs.writeFileSync(
    variantsPath,
    `${JSON.stringify({
      schema_version: "decomposition-eval-variants/v2",
      default_variant: "accepted_baseline",
      variants: {
        accepted_baseline: { role_overrides: {}, prompt_overrides: {} },
        candidate_prompt_override: {
          role_overrides: {},
          prompt_overrides: {
            [targetKey]: { candidate_prompt_version_id: candidateVersionId },
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === `/v1/prompt_versions/${candidateVersionId}`) {
      return promptVersionResponse({ id: candidateVersionId, content: candidateContent });
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  };
  const evalRunId = "eval-prompt-override-1";
  // The orchestrator invokes ONLY the overridden target so we can assert the
  // candidate body — not the manifest snapshot — reached the subagent. The real
  // eval roster (built inside runDecompositionEvalTask from the resolved
  // override) substitutes the candidate body for that target's library load.
  const runtimeExecutor = fakeSubagentExecutor();

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    variantId: "candidate_prompt_override",
    variantsPath,
    runtimeExecutor,
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId, { libraryOrder: [targetKey] }),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl,
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  // The candidate body reached the only spawned subagent (the overridden
  // target); the manifest snapshot body did not.
  assert.equal(runtimeExecutor.calls.length, 1);
  assert.equal(runtimeExecutor.calls[0].runtime_role, "pm");
  assert.ok(runtimeExecutor.calls[0].prompt.includes("CANDIDATE_PM_PRODUCT_SUFFICIENCY_ONLY"));
  // The candidate sha256 is recorded on the result + the eval record.
  const expectedSha = createHash("sha256").update(Buffer.from(candidateContent, "utf8")).digest("hex");
  assert.equal(result.prompt_overrides[targetKey].candidate_prompt_sha256, expectedSha);
  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.variant.resolved_prompt_overrides[targetKey].candidate_prompt_version_id, candidateVersionId);
  assert.equal(record.variant.resolved_prompt_overrides[targetKey].candidate_prompt_sha256, expectedSha);
});

test("--emit-checks and --judge chain over the in-memory outputs without re-reading run stores", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());
  const evalRunId = "eval-chain-1";
  let checkArgs = null;
  let judgeArgs = null;

  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    examplePath,
    evalRunId,
    emitChecks: true,
    judge: true,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: phoenixDownProbe,
    ensureReady: phoenixDownProbe,
    emitChecksFn: async (args) => {
      checkArgs = args;
      return {
        ok: true,
        storage: "phoenix_native",
        run_id: evalRunId,
        trace_id: args.traceId,
        checks: [],
        emitted_count: 1,
        skipped_count: 2,
        annotation_ids: ["ann-1"],
      };
    },
    runJudgeFn: async (args) => {
      judgeArgs = args;
      return {
        ok: true,
        judge_state: "judged",
        storage: "phoenix_native",
        annotation_ids: ["ann-2"],
        judge: { label: "pass", score: 0.92, explanation: "ok", failure_modes: [], failure_mode_details: [] },
        low_confidence_reasons: [],
        rubric_version: "1.0.0",
        failure_taxonomy_version: "1.0.0",
      };
    },
  });

  // In-memory chaining: the EXACT artifact object, the rebuilt memory
  // snapshot, and the trace id are handed over; no run id is passed, so the
  // chained evaluators never re-read the run stores.
  assert.equal(checkArgs.artifact, result.artifact);
  assert.equal(checkArgs.runId, undefined);
  assert.equal(checkArgs.traceId, result.trace.trace_id);
  assert.equal(checkArgs.receipt.trace_id, result.trace.trace_id);
  assert.deepEqual(Object.keys(checkArgs.checkInputs), ["accepted_packet_sufficiency"]);
  assert.equal(checkArgs.checkInputs.accepted_packet_sufficiency.terminalOutput.outcome, "commit");
  assert.equal(checkArgs.requirePhoenixNative, false);

  assert.equal(judgeArgs.artifact, result.artifact);
  assert.equal(judgeArgs.snapshot.capture_source, "eval_mode_memory_snapshot");
  assert.equal(judgeArgs.snapshot.project.id, "project-eval-1");
  assert.equal(judgeArgs.traceId, result.trace.trace_id);
  assert.equal(judgeArgs.recordReceipt, false, "eval runs must not write live judge receipts");

  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.checks.annotation_ids[0], "ann-1");
  assert.equal(record.judge.annotation_ids[0], "ann-2");
  assert.equal(record.judge.variant_id, ACCEPTED_BASELINE_VARIANT_ID);
});

test("eval-run record is written atomically with a deterministic inputs hash", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const examplePath = writeExampleFile(root, validExample());

  const run = (evalRunId) =>
    runDecompositionEvalTask({
      repoRoot: root,
      config,
      domainContext: evalDomainContext(),
      examplePath,
      evalRunId,
      runtimeExecutor: fakeSubagentExecutor(),
      orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
      traceSink: recordingTraceSink(),
      phoenixProbe: phoenixDownProbe,
      ensureReady: phoenixDownProbe,
    });

  const first = await run("eval-hash-a");
  const second = await run("eval-hash-b");
  assert.equal(first.inputs_hash, second.inputs_hash, "same inputs + variant must hash identically");
  assert.equal(
    first.inputs_hash,
    computeEvalInputsHash({
      project: validExample().input.project,
      runEnvelope: buildEvalRunEnvelope({ config }),
      variant: { id: ACCEPTED_BASELINE_VARIANT_ID, role_overrides: {}, judge_candidate_prompt_version_id: null },
    }),
  );

  const storeDir = defaultEvalRunStoreDir(root);
  const leftovers = fs.readdirSync(storeDir).filter((name) => name.startsWith("."));
  assert.deepEqual(leftovers, [], "no temp files may survive the atomic record write");
  const record = JSON.parse(fs.readFileSync(path.join(storeDir, "eval-hash-a.json"), "utf8"));
  assert.equal(record.eval_run_id, "eval-hash-a");
  assert.equal(record.inputs_hash, first.inputs_hash);
});

test("--dataset fetches the example via the verified REST GET path and degrades gracefully when Phoenix is unreachable", async () => {
  const root = tempRoot();
  copyAcceptedPromptAssets(root);
  const example = validExample();
  const datasetFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/datasets") {
      return jsonResponse({ data: [{ id: "RGF0YXNldDox", name: "eval-ds" }] });
    }
    if (parsed.pathname === "/v1/datasets/RGF0YXNldDox/examples") {
      return jsonResponse({
        data: {
          examples: [
            {
              id: "EX1",
              input: example.input,
              output: example.output,
              metadata: {
                ...example.metadata,
                schema_version: example.schema_version,
                reference: example.reference,
              },
            },
          ],
        },
      });
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  };
  const upProbe = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" });

  const evalRunId = "eval-dataset-1";
  const result = await runDecompositionEvalTask({
    repoRoot: root,
    config,
    domainContext: evalDomainContext(),
    datasetName: "eval-ds",
    datasetExampleId: "EX1",
    evalRunId,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: fakeOrchestrator(evalRunId),
    traceSink: recordingTraceSink(),
    phoenixProbe: upProbe,
    ensureReady: phoenixDownProbe,
    fetchImpl: datasetFetch,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.source, {
    mode: "dataset",
    dataset_name: "eval-ds",
    dataset_id: "RGF0YXNldDox",
    example_id: "EX1",
  });

  const down = await resolveDecompositionEvalInput({
    repoRoot: root,
    datasetName: "eval-ds",
    datasetExampleId: "EX1",
    phoenixProbe: phoenixDownProbe,
    fetchImpl: datasetFetch,
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, "local_phoenix_unavailable");

  const notFound = await resolveDecompositionEvalInput({
    repoRoot: root,
    datasetName: "eval-ds",
    datasetExampleId: "EX-missing",
    phoenixProbe: upProbe,
    fetchImpl: datasetFetch,
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, "dataset_example_not_found");
});

test("input selection requires exactly one source", async () => {
  const both = await resolveDecompositionEvalInput({
    runId: "run-1",
    examplePath: "example.json",
  });
  assert.equal(both.ok, false);
  assert.equal(both.reason, "invalid_input_selection");

  const none = await resolveDecompositionEvalInput({});
  assert.equal(none.ok, false);
  assert.equal(none.reason, "invalid_input_selection");

  const datasetWithoutId = await resolveDecompositionEvalInput({ datasetName: "ds" });
  assert.equal(datasetWithoutId.ok, false);
  assert.equal(datasetWithoutId.reason, "invalid_input_selection");
});

test("eval:decomposition is wired as a first-class CLI task", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["eval:decomposition"],
    "node execution/integrations/linear/cli.mjs eval:decomposition",
  );
  const cliSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "cli.mjs"),
    "utf8",
  );
  assert.ok(cliSource.includes('command === "eval:decomposition"'));
  // Post-split, command bodies live in src/cli/dispatch.mjs (cli.mjs keeps the
  // literal dispatch chain); the wiring pin follows the wiring.
  const dispatchSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "dispatch.mjs"),
    "utf8",
  );
  assert.ok(dispatchSource.includes("runDecompositionEvalTask"));
  assert.ok(dispatchSource.includes("resolveForegroundDomainCache"));
  assert.ok(dispatchSource.includes("domainContext: foreground.context"));
  // The repo-owned variants config exists with the no-override accepted
  // baseline as the default.
  const variants = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "execution", "evals", "decomposition", "variants.json"), "utf8"),
  );
  assert.equal(variants.schema_version, "decomposition-eval-variants/v2");
  assert.equal(variants.default_variant, "accepted_baseline");
  assert.deepEqual(variants.variants.accepted_baseline.role_overrides, {});
  assert.deepEqual(variants.variants.accepted_baseline.prompt_overrides, {});
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}
