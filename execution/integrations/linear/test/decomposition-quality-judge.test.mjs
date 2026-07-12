import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAdvisoryQualityLine,
  buildJudgeFixtureInput,
  buildJudgeInputs,
  buildStoredFixtureJudgeInputs,
  formatAdvisoryQualityLine,
  formatJudgePromptRegistrationReport,
  formatJudgeReport,
  buildMaintainerSuppliedContext,
  judgeAllowedFailureModes,
  judgeAnnotationIdentifier,
  loadJudgePromptContract,
  parseJudgeOutput,
  readJudgeReceipt,
  registerJudgePromptInPhoenix,
  registerPromptInPhoenix,
  registrationReceiptPath,
  runAdvisoryDecompositionQualityCheck,
  runDecompositionQualityJudge,
  runStoredDecompositionFixtureJudge,
} from "../src/decomposition-quality-judge.mjs";
import { emitDeterministicCheckResults } from "../src/deterministic-check-emission.mjs";
import {
  FAILURE_TAXONOMY_VERSION,
  PHOENIX_ASSETS_PATH,
  QUALITY_LABELS,
  RUBRIC_VERSION,
} from "../src/eval-annotation-contract.mjs";
import { collectEvalStatuses, rankEvalWorklist } from "../src/eval-status.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import { createPhoenixTraceAnnotation } from "../src/phoenix-self-improvement.mjs";
import { captureProjectSnapshot } from "../src/project-snapshot-store.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import {
  JUDGE_OUTPUT_SCHEMA_PATH,
  resolveJudgeRuntimeAssignment,
} from "../src/runtime-adapters.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";

const TRACE_ID = "bbbbccccddddeeeeffff000011112222";
const JUDGE_MODEL = "judge-model-x";
const TRACE_IDENTITY = Object.freeze({
  domainId: "support-ops",
  workspaceId: "workspace-1",
  teamId: "team-1",
});
const ARTIFACT_IDENTITY = Object.freeze({
  domain_id: TRACE_IDENTITY.domainId,
  workspace_id: TRACE_IDENTITY.workspaceId,
  team_id: TRACE_IDENTITY.teamId,
});

function tempRepoRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `teami-judge-${label}-`));
  process.env.TEAMI_HOME = root;
  return root;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function judgeConfig({ runtime = "codex", model = JUDGE_MODEL } = {}) {
  const config = {
    runtime: {
      adapters: {
        codex: { command: "codex", tool_policy: { linear_write: false } },
        claude: { command: "claude", tool_policy: { linear_write: false } },
      },
    },
    workflows: {
      decomposition: {
        roles: {
          pm: { runtime: "claude", model: "model-a" },
          sr_eng: { runtime: "codex", model: "model-b" },
          judge: { runtime, model },
        },
      },
    },
  };
  // This fixture represents a factory/accepted judge assignment, not an
  // adopter override. Raw configs without this provenance are covered in
  // runtime-role-defaults.test.mjs and resolve through the repo defaults.
  Object.defineProperty(config.workflows.decomposition, "role_field_sources", {
    value: {
      judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return config;
}

function commitArtifact(runId) {
  const phasePacket = {
    schema_version: "linear-decomposition-phase-packet/v1",
    run_id: runId,
    phase: "pm_synthesis",
    status: "continue",
    reason: "synthesis_complete",
    context_digest: "digest-1",
    source_refs: [],
    assumptions: ["assume-1"],
    constraints: [],
    risks: [],
  };
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: runId,
    ...ARTIFACT_IDENTITY,
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "commit",
      reason: "synthesis_complete",
      context_digest: phasePacket.context_digest,
      source_refs: phasePacket.source_refs,
      assumptions: phasePacket.assumptions,
      constraints: phasePacket.constraints,
      risks: phasePacket.risks,
    },
    evidence: {
      perspectives_run: [{ role: "pm", outcome: "synthesis_complete" }],
    },
    bounds: { rounds_used: 1, max_rounds: 6 },
    runtime_assignments: {
      pm: { runtime: "claude", model: "model-a" },
      sr_eng: { runtime: "codex", model: "model-b" },
    },
    runtime_metadata: {},
    final_issues: [
      {
        decomposition_key: "step/one",
        title: "Do the first thing",
        issue_body_markdown: "body",
        depends_on: [],
      },
      {
        decomposition_key: "step/two",
        title: "Do the second thing",
        issue_body_markdown: "body",
        depends_on: ["step/one"],
      },
    ],
    project_update_markdown: `run_id: ${runId}`,
  };
}

function snapshotProject() {
  return {
    id: "proj-judge",
    name: "Judge Fixture Project",
    description: "fixture",
    content: "## Goal\nShip the thing.",
    status: { name: "Planned", type: "planned" },
    labels: [],
    issues: [],
  };
}

function seedRun(repoRoot, runId, { withSnapshot = true, withReceipt = true } = {}) {
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  if (withSnapshot) {
    captureProjectSnapshot({
      runId,
      domainId: TRACE_IDENTITY.domainId,
      project: snapshotProject(),
      semanticStatus: "planned",
      repoRoot,
    });
  }
  if (withReceipt) {
    recordTestTraceStatus({
      repoRoot,
      runId,
      projectId: "proj-judge",
      traceId: TRACE_ID,
      phoenixAppUrl: "http://127.0.0.1:6006",
      status: "trace_exported",
      observedAt: "2026-06-10T01:00:00.000Z",
    });
  }
}

function recordTestTraceStatus(options) {
  return recordTraceStatus({ ...TRACE_IDENTITY, ...options });
}

function validJudgeJson(overrides = {}) {
  return JSON.stringify({
    label: "pass",
    score: 0.92,
    explanation: "Issues preserve intent and are independently executable.",
    failure_modes: [],
    ...overrides,
  });
}

// Fake runtime: captures every invocation so tests can assert the judge got
// no Linear client or mutation surface — only a command and exec options.
function fakeRuntime(outputs) {
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs];
  const invocations = [];
  const runCommand = async (...args) => {
    invocations.push(args);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { runCommand, invocations };
}

function runtimePromptFromCommand(command) {
  if (typeof command.stdinInput === "string") return command.stdinInput;
  const index = command.args.indexOf("-p");
  if (index >= 0) {
    const promptArg = command.args[index + 1];
    if (typeof promptArg === "string" && promptArg.startsWith("@")) {
      return fs.readFileSync(promptArg.slice(1), "utf8");
    }
    return promptArg;
  }
  return command.args.at(-1);
}

function annotationFetchStub({ posts = [] } = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/v1/trace_annotations?sync=true")) {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ id: `anno-${posts.length}` }] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${target}`);
  };
}

const readyStub = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" });
const noFetch = async (url) => {
  throw new Error(`no Phoenix call expected, got ${url}`);
};

test("advisory quality line renders valid, null, and thrown judge results", async () => {
  const judged = {
    judge_state: "judged",
    judge: {
      label: "pass",
      explanation: "The issue split preserves the project intent.\nNo blockers.",
    },
  };

  assert.equal(
    formatAdvisoryQualityLine(judged),
    "Quality check (advisory, non-gating): pass — The issue split preserves the project intent. No blockers.",
  );
  assert.equal(
    appendAdvisoryQualityLine("run_id: run-quality\n\nAuthored update.", judged),
    "run_id: run-quality\n\nAuthored update.\n\nQuality check (advisory, non-gating): pass — The issue split preserves the project intent. No blockers.",
  );
  assert.equal(
    formatAdvisoryQualityLine(null),
    "Quality check (advisory, non-gating): unavailable (judge_unavailable)",
  );

  const thrown = await runAdvisoryDecompositionQualityCheck({
    runJudgeFn: async () => {
      throw new Error("judge provider unavailable\nretry later");
    },
  });
  assert.equal(thrown.result.judge_state, "judge_missing");
  assert.equal(
    thrown.line,
    "Quality check (advisory, non-gating): unavailable (judge_threw:judge provider unavailable retry later)",
  );
});

test("judge wrapper records rubric version, prompt version, model, and taxonomy version through the shared LLM write path", async () => {
  const repoRoot = tempRepoRoot("happy");
  const runId = "run-judge-happy";
  seedRun(repoRoot, runId);

  const posts = [];
  const rawJudgeOutput = validJudgeJson();
  const { runCommand, invocations } = fakeRuntime(rawJudgeOutput);
  const result = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.judge_state, "judged");
  assert.equal(result.storage, "phoenix_native");
  assert.deepEqual(result.annotation_ids, ["anno-1"]);
  assert.equal(result.run_id, runId);
  assert.equal(result.trace_id, TRACE_ID);
  assert.ok(result.judge_prompt.includes(`run_id: ${runId}`));
  assert.equal(result.judge_inputs.project_update_markdown, `run_id: ${runId}`);
  assert.equal(result.raw_output, rawJudgeOutput);

  // Test item: wrapper records rubric version, prompt version, model, and
  // failure taxonomy version.
  const contract = loadJudgePromptContract();
  assert.equal(result.rubric_version, RUBRIC_VERSION);
  assert.equal(result.failure_taxonomy_version, FAILURE_TAXONOMY_VERSION);
  assert.equal(result.model, JUDGE_MODEL);
  assert.equal(result.prompt_source, "repo_accepted_snapshot");
  assert.equal(result.prompt_version, `sha256:${contract.entry.snapshot_sha256}`);

  // Annotation went through the SHARED write path with annotator_kind LLM and
  // the stable judge identifier including the model identity.
  assert.equal(posts.length, 1);
  const wire = posts[0].data[0];
  assert.equal(wire.name, "quality");
  assert.equal(wire.annotator_kind, "LLM");
  assert.equal(wire.identifier, `decomposition_quality_judge_v1:${JUDGE_MODEL}`);
  assert.equal(wire.trace_id, TRACE_ID);
  assert.equal(wire.result.label, "pass");
  assert.equal(wire.result.score, 0.9);
  assert.ok(wire.result.explanation.length > 0);
  assert.equal(wire.metadata.rubric_version, RUBRIC_VERSION);
  assert.equal(wire.metadata.failure_taxonomy_version, FAILURE_TAXONOMY_VERSION);
  assert.equal(wire.metadata.judge_model, JUDGE_MODEL);
  assert.equal(wire.metadata.judge_runtime, "codex");
  assert.equal(wire.metadata.judge_evaluator_id, "decomposition_quality_judge_v1");
  assert.equal(wire.metadata.judge_prompt_source, "repo_accepted_snapshot");
  assert.equal(wire.metadata.judge_prompt_version, `sha256:${contract.entry.snapshot_sha256}`);
  assert.equal(wire.metadata.workspace_maturity, "new");
  assert.equal(wire.metadata.workflow_type, "decomposition");
  assert.equal(wire.metadata.eval_namespace, "execution/evals/decomposition");
  assert.equal(wire.metadata.source_run_id, runId);
  assert.deepEqual(wire.metadata.failure_modes, []);

  // The judge prompt the runtime received is the repo-ACCEPTED snapshot plus
  // the assembled inputs — including the exact authored project update and
  // the rubric/taxonomy versions being judged against.
  assert.equal(invocations.length, 1);
  const [command] = invocations[0];
  const prompt = runtimePromptFromCommand(command);
  assert.ok(prompt.includes("decomposition quality judge"), "accepted snapshot text must be in the prompt");
  assert.ok(prompt.includes(`run_id: ${runId}`), "exact project update markdown must be in the inputs");
  assert.ok(prompt.includes('"rubric_version": "1.0.0"'));
  assert.ok(prompt.includes('"allowed_failure_modes"'));

  // Local judge receipt records the attempt for the derived worklist.
  const receipt = readJudgeReceipt({ runId, repoRoot });
  assert.equal(receipt.exists, true);
  assert.equal(receipt.receipt.attempts.length, 1);
  assert.equal(receipt.receipt.attempts[0].judge_state, "judged");
  assert.equal(receipt.receipt.attempts[0].prompt_version, `sha256:${contract.entry.snapshot_sha256}`);

  const report = formatJudgeReport(result);
  assert.ok(report.some((line) => line.includes("phoenix_native")));
});

test("judge timeout records judge_missing without a Phoenix annotation and without blocking humans or deterministic checks", async () => {
  const repoRoot = tempRepoRoot("timeout");
  const runId = "run-judge-timeout";
  seedRun(repoRoot, runId);

  const posts = [];
  const fetchImpl = annotationFetchStub({ posts });
  const { runCommand } = fakeRuntime(new Error("Runtime command timed out after 5ms: codex"));
  const result = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand,
    ensureReady: readyStub,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.judge_state, "judge_missing");
  assert.equal(result.storage, "report_only");
  assert.match(result.reason, /judge_runtime_failed/);
  assert.equal(posts.length, 0, "no Phoenix annotation may pretend a judgment happened");
  assert.deepEqual(result.annotation_ids, []);

  const receipt = readJudgeReceipt({ runId, repoRoot });
  assert.equal(receipt.receipt.attempts[0].judge_state, "judge_missing");

  // The run remains evaluable: a HUMAN annotation and the deterministic
  // checks both still work through their own paths.
  const human = await createPhoenixTraceAnnotation({
    repoRoot,
    ensureReady: readyStub,
    fetchImpl,
    traceId: TRACE_ID,
    label: "pass",
    score: 0.9,
    explanation: "human judgment is unaffected by the judge timeout",
    annotatorKind: "HUMAN",
    identifier: "steve",
  });
  assert.deepEqual(human.annotationIds, ["anno-1"]);

  const checksFetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/openapi.json")) {
      return new Response(JSON.stringify({
        paths: { "/v1/trace_annotations": { post: { requestBody: { content: { "application/json": { schema: {
          properties: { data: { items: { properties: {
            annotator_kind: { enum: ["LLM", "CODE", "HUMAN"] },
            identifier: {},
            result: {},
          } } } },
        } } } } } } },
      }), { status: 200 });
    }
    return annotationFetchStub({ posts })(url, init);
  };
  const checks = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    ensureReady: readyStub,
    fetchImpl: checksFetch,
  });
  assert.equal(checks.ok, true, "deterministic checks must not be blocked by judge_missing");
  assert.ok(checks.emitted_count > 0);
});

test("malformed judge output records judge_invalid and surfaces a derived worklist item", async () => {
  const repoRoot = tempRepoRoot("invalid");
  const runId = "run-judge-invalid";
  seedRun(repoRoot, runId);

  const { runCommand } = fakeRuntime(validJudgeJson({ label: "excellent" }));
  const result = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand,
    ensureReady: readyStub,
    fetchImpl: noFetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.judge_state, "judge_invalid");
  assert.equal(result.storage, "report_only");
  assert.match(result.reason, /malformed_judge_output/);
  assert.ok(result.parse_failures.includes("label_not_canonical:excellent"));
  assert.equal(result.judge, null);

  const receipt = readJudgeReceipt({ runId, repoRoot });
  assert.equal(receipt.receipt.attempts[0].judge_state, "judge_invalid");
  assert.ok(receipt.receipt.attempts[0].raw_output_excerpt.includes("excellent"));

  // Derived worklist visibility: the run classifies as judge_attention from
  // the local receipt alone (read-time view; nothing persisted to Phoenix).
  const worklistFetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/projects") {
      return new Response(JSON.stringify({ data: [{ id: "UHJvamVjdDox", name: "teami" }] }), { status: 200 });
    }
    if (/trace_annotations$/.test(parsed.pathname)) {
      return new Response(JSON.stringify({ data: [], next_cursor: null }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const report = await collectEvalStatuses({ repoRoot, fetchImpl: worklistFetch });
  const run = report.runs.find((entry) => entry.run_id === runId);
  assert.equal(run.judge_attempt.judge_state, "judge_invalid");
  const items = rankEvalWorklist(report);
  const item = items.find((entry) => entry.run_id === runId);
  assert.ok(item, "judge_invalid run must be a worklist item");
  assert.equal(item.priority_id, "judge_attention");
});

test("the judge never receives Linear mutation capability", async () => {
  const repoRoot = tempRepoRoot("no-mutation");
  const runId = "run-judge-no-mutation";
  seedRun(repoRoot, runId);

  const { runCommand, invocations } = fakeRuntime(validJudgeJson());
  await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts: [] }),
  });

  // The fake runtime received ONLY a process command and exec options: no
  // Linear client, no mutation surface, no callable capability of any kind.
  assert.equal(invocations.length, 1);
  const [command, options] = invocations[0];
  assert.deepEqual(invocations[0].length, 2);
  assert.deepEqual(Object.keys(options).sort(), ["maxOutputBytes", "timeoutMs"]);
  assert.equal(command.tool_policy.linear_write, false);
  assert.equal(command.tool_policy.project_mutation, "runner_only");
  assert.equal(command.tool_policy.issue_mutation, "runner_only");
  for (const value of [command.command, ...command.args, command.stdinInput].filter((item) => item !== undefined)) {
    assert.equal(typeof value, "string", "the runtime gets strings only, never live objects");
  }

  // Source pin: the judge module never imports a Linear client/service and
  // never touches the live mutation modules (CONSTRAINTS #27).
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "decomposition-quality-judge.mjs"),
    "utf8",
  );
  for (const banned of [
    "linear-graphql-client",
    "linear-service",
    "local-trigger-store",
    "createLocalTriggerStore",
    "linear-webhook",
    "linearClient",
    "getProjectContext",
  ]) {
    assert.ok(!source.includes(banned), `judge module must not reference ${banned}`);
  }
  // And the live mutation modules never import the judge.
  const liveModules = [
    { name: "trigger-runner.mjs", path: path.resolve(import.meta.dirname, "..", "src", "trigger-runner.mjs") },
    { name: "orchestrator-loop.mjs", path: path.resolve(import.meta.dirname, "..", "..", "..", "engine", "orchestrator-loop.mjs") },
    { name: "linear-service.mjs", path: path.resolve(import.meta.dirname, "..", "src", "linear-service.mjs") },
  ];
  for (const liveModule of liveModules) {
    const liveSource = fs.readFileSync(liveModule.path, "utf8");
    assert.ok(
      !liveSource.includes("decomposition-quality-judge"),
      `${liveModule.name} must not import the judge module`,
    );
  }
});

test("canonical label, score, explanation, and taxonomy failure modes are enforced strictly", () => {
  const allowed = judgeAllowedFailureModes();
  assert.ok(allowed.includes("missing_acceptance_criteria"));
  assert.ok(allowed.includes("duplicated_project_truth"));

  const invalidCases = [
    [validJudgeJson({ label: "excellent" }), /label_not_canonical:excellent/],
    [validJudgeJson({ score: 1.5 }), /score_not_in_unit_interval/],
    [validJudgeJson({ score: "0.9" }), /score_not_in_unit_interval/],
    [validJudgeJson({ explanation: "   " }), /missing_explanation/],
    [validJudgeJson({ failure_modes: ["made_up_mode"] }), /unknown_failure_mode:made_up_mode/],
    [JSON.stringify({ label: "pass", score: 0.9, explanation: "x" }), /failure_modes_not_an_array/],
    ["no json at all", /invalid_json_output/],
  ];
  for (const [output, expected] of invalidCases) {
    const parsed = parseJudgeOutput(output, { allowedFailureModes: allowed });
    assert.equal(parsed.ok, false, `must reject: ${output}`);
    assert.ok(
      parsed.failures.some((failure) => expected.test(failure)),
      `expected ${expected} in ${parsed.failures.join(",")}`,
    );
  }

  // Parameterized modes normalize to taxonomy base ids with details preserved.
  const parameterized = parseJudgeOutput(
    validJudgeJson({
      label: "needs_revision",
      score: 0.55,
      failure_modes: ["missing_context_digest:pm_synthesis"],
    }),
    { allowedFailureModes: allowed },
  );
  assert.equal(parameterized.ok, true);
  assert.equal(parameterized.judge.score, 0.6);
  assert.deepEqual(parameterized.judge.failure_modes, ["missing_context_digest"]);
  assert.deepEqual(parameterized.judge.failure_mode_details, ["missing_context_digest:pm_synthesis"]);

  // Raw model scores are accepted only as schema-shaped output; the stored
  // score is derived from the namespace's label band.
  const offBandRawScore = parseJudgeOutput(
    validJudgeJson({ label: "pass", score: 0.55 }),
    { allowedFailureModes: allowed },
  );
  assert.equal(offBandRawScore.ok, true);
  assert.equal(offBandRawScore.judge.score, 0.9);

  // Claude-style result envelopes (fenced JSON inside a result string) parse.
  const envelope = parseJudgeOutput(
    JSON.stringify({ result: "```json\n" + validJudgeJson() + "\n```", session_id: "s-1" }),
    { allowedFailureModes: allowed },
  );
  assert.equal(envelope.ok, true);
  assert.equal(envelope.judge.label, "pass");

  // Two conflicting valid objects are ambiguous, never silently chosen.
  const ambiguous = parseJudgeOutput(
    `${validJudgeJson()}\n${validJudgeJson({ label: "needs_revision", score: 0.5 })}`,
    { allowedFailureModes: allowed },
  );
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.failures, ["ambiguous_judge_output"]);
});

test("judge stores band-derived scores and keeps raw-score artifacts out of Phoenix metadata", async () => {
  const repoRoot = tempRepoRoot("low-conf");
  const runId = "run-judge-low-conf";
  seedRun(repoRoot, runId);

  // Raw band mismatch: pass with a needs_revision-band model score. The
  // stored score is derived from the pass band, so fresh Judge output cannot
  // carry a label/score mismatch.
  const posts = [];
  const normalized = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand: fakeRuntime(validJudgeJson({ label: "pass", score: 0.55 })).runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts }),
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.judge.score, 0.9);
  assert.deepEqual(normalized.low_confidence_reasons, []);
  const stored = posts[0].data[0];
  assert.equal(stored.result.score, 0.9);
  assert.equal(posts[0].data[0].metadata.low_confidence_reasons, undefined);
  const receipt = readJudgeReceipt({ runId, repoRoot });
  assert.equal(receipt.receipt.attempts[0].score, 0.9);
  assert.deepEqual(receipt.receipt.attempts[0].low_confidence_reasons, []);

  // Raw boundary proximity is normalized away before low-confidence checks.
  const boundary = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand: fakeRuntime(validJudgeJson({
      label: "needs_revision",
      score: 0.79,
      failure_modes: ["missing_acceptance_criteria"],
    })).runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts: [] }),
  });
  assert.equal(boundary.judge.score, 0.6);
  assert.deepEqual(boundary.low_confidence_reasons, []);

  const reportLines = formatJudgeReport(boundary);
  assert.ok(!reportLines.some((line) => line.includes("score_at_band_boundary")));
});

test("--candidate-prompt-version executes the Phoenix candidate and labels all metadata with the candidate id", async () => {
  const repoRoot = tempRepoRoot("candidate");
  const runId = "run-judge-candidate";
  seedRun(repoRoot, runId);
  const candidateId = "UHJvbXB0VmVyc2lvbjo5OQ==";

  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v1/prompt_versions/")) {
      assert.ok(target.includes(encodeURIComponent(candidateId)));
      return new Response(JSON.stringify({
        data: {
          id: candidateId,
          template: {
            type: "chat",
            messages: [{ role: "system", content: "CANDIDATE JUDGE PROMPT TEXT" }],
          },
        },
      }), { status: 200 });
    }
    return annotationFetchStub({ posts })(url, init);
  };
  const { runCommand, invocations } = fakeRuntime(validJudgeJson());
  const result = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    candidatePromptVersionId: candidateId,
    runCommand,
    ensureReady: readyStub,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.prompt_source, "phoenix_candidate_version");
  assert.equal(result.prompt_version, candidateId);
  const prompt = runtimePromptFromCommand(invocations[0][0]);
  assert.ok(prompt.includes("CANDIDATE JUDGE PROMPT TEXT"));
  assert.ok(!prompt.includes("Accepted Judge Prompt"), "candidate runs must not silently mix in the accepted snapshot");
  const wire = posts[0].data[0];
  assert.equal(wire.metadata.judge_prompt_source, "phoenix_candidate_version");
  assert.equal(wire.metadata.judge_prompt_version, candidateId);

  // Unresolvable candidate fails closed before any model invocation.
  const failing = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    candidatePromptVersionId: "missing-version",
    runCommand: async () => {
      throw new Error("the model must not be invoked for an unresolvable candidate prompt");
    },
    ensureReady: readyStub,
    fetchImpl: async () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 }),
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.judge_state, "not_run");
  assert.equal(failing.reason, "candidate_prompt_version_unresolvable");
});

test("judge fails closed before model invocation on missing snapshot, missing artifact, and non-terminal runs", async () => {
  const repoRoot = tempRepoRoot("fail-closed");
  const neverRun = async () => {
    throw new Error("the model must not be invoked when required inputs are missing");
  };

  // Missing captured project snapshot (project intent input) — no fallback.
  const runId = "run-judge-no-snapshot";
  seedRun(repoRoot, runId, { withSnapshot: false });
  const missingSnapshot = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig(),
    runCommand: neverRun,
    ensureReady: readyStub,
    fetchImpl: noFetch,
  });
  assert.equal(missingSnapshot.ok, false);
  assert.equal(missingSnapshot.judge_state, "not_run");
  assert.equal(missingSnapshot.reason, "missing_project_snapshot");

  // Missing run artifact.
  const missingArtifact = await runDecompositionQualityJudge({
    repoRoot,
    runId: "run-judge-does-not-exist",
    config: judgeConfig(),
    runCommand: neverRun,
    ensureReady: readyStub,
    fetchImpl: noFetch,
  });
  assert.equal(missingArtifact.judge_state, "not_run");
  assert.equal(missingArtifact.reason, "missing_run_artifact");

  // Non-terminal runs are not judged.
  const checkpointId = "run-judge-checkpoint";
  writeRunArtifact({ runId: checkpointId, repoRoot }, {
    ...commitArtifact(checkpointId),
    kind: "checkpoint",
    phase_packets: [{
      schema_version: "linear-decomposition-phase-packet/v1",
      run_id: checkpointId,
      phase: "pm_product_sufficiency_pass",
      status: "continue",
      reason: "product_context_sufficient",
      context_digest: "checkpoint digest",
      source_refs: [],
      assumptions: [],
      constraints: [],
      risks: [],
    }],
    final_issues: undefined,
    project_update_markdown: undefined,
  });
  captureProjectSnapshot({
    runId: checkpointId,
    domainId: TRACE_IDENTITY.domainId,
    project: snapshotProject(),
    semanticStatus: "planned",
    repoRoot,
  });
  const nonTerminal = await runDecompositionQualityJudge({
    repoRoot,
    runId: checkpointId,
    config: judgeConfig(),
    runCommand: neverRun,
    ensureReady: readyStub,
    fetchImpl: noFetch,
  });
  assert.equal(nonTerminal.judge_state, "not_run");
  assert.equal(nonTerminal.reason, "run_not_terminal");

  // Missing judge model config fails closed (the identifier needs the model).
  const noModel = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: judgeConfig({ model: null }),
    runCommand: neverRun,
    ensureReady: readyStub,
    fetchImpl: noFetch,
  });
  assert.equal(noModel.judge_state, "not_run");
  assert.equal(noModel.reason, "judge_model_not_configured");

  // not_run states never write judge-attempt receipts (they are command
  // errors, not judge attempts).
  assert.equal(readJudgeReceipt({ runId, repoRoot }).exists, false);
});

test("eval-mode parity: in-memory artifact, snapshot, and explicit trace id run without local stores", async () => {
  // Empty temp repoRoot: nothing is read from local stores in this mode.
  const repoRoot = tempRepoRoot("eval-mode");
  const artifact = commitArtifact("run-judge-eval-mode");
  const snapshot = {
    schema_version: "linear-decomposition-project-snapshot/v1",
    run_id: "run-judge-eval-mode",
    capture_source: "eval_mode_memory_snapshot",
    project: {
      id: "proj-mem",
      name: "Memory Project",
      content: "## Goal\nEval mode.",
      status: "planned",
      labels: [],
      existing_issues: [],
    },
  };

  const posts = [];
  const result = await runDecompositionQualityJudge({
    repoRoot,
    artifact,
    snapshot,
    traceId: TRACE_ID,
    config: judgeConfig(),
    runCommand: fakeRuntime(validJudgeJson()).runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts }),
    recordReceipt: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.run_id, "run-judge-eval-mode");
  assert.equal(result.trace_id, TRACE_ID);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data[0].metadata.source_run_id, "run-judge-eval-mode");
  assert.equal(result.receipt_path, undefined);

  // Valid judgment with no trace target stays report-only (nothing to attach
  // a Phoenix annotation to) without losing the judgment.
  const reportOnly = await runDecompositionQualityJudge({
    repoRoot,
    artifact,
    snapshot,
    config: judgeConfig(),
    runCommand: fakeRuntime(validJudgeJson()).runCommand,
    ensureReady: readyStub,
    fetchImpl: noFetch,
    recordReceipt: false,
  });
  assert.equal(reportOnly.ok, false);
  assert.equal(reportOnly.judge_state, "judged");
  assert.equal(reportOnly.storage, "report_only");
  assert.equal(reportOnly.reason, "missing_trace_target");
  assert.equal(reportOnly.judge.label, "pass");
});

test("stored full-input fixtures regrade through the Judge without rerunning decomposition", async () => {
  const repoRoot = tempRepoRoot("stored-regrade");
  const runId = "run-judge-stored-fixture";
  const artifact = commitArtifact(runId);
  const snapshot = {
    schema_version: "linear-decomposition-project-snapshot/v1",
    run_id: runId,
    capture_source: "eval_mode_memory_snapshot",
    project: {
      id: "proj-stored",
      name: "Stored Fixture Project",
      content: "## Goal\nRegrade stored evidence.",
      status: "planned",
      labels: [],
      existing_issues: [],
    },
  };
  const built = buildJudgeInputs({
    artifact,
    snapshot,
    allowedFailureModes: judgeAllowedFailureModes(),
  });
  assert.equal(built.ok, true);
  const projected = buildJudgeFixtureInput({ judgeInputs: built.inputs });
  assert.equal(projected.ok, true);

  const fixture = {
    schema_version: "decomposition-eval-example/v1",
    input: projected,
    metadata: {
      source_run_id: runId,
      source_trace_id: TRACE_ID,
    },
  };

  const posts = [];
  const { runCommand, invocations } = fakeRuntime(validJudgeJson());
  const result = await runStoredDecompositionFixtureJudge({
    repoRoot,
    fixture,
    config: judgeConfig(),
    runCommand,
    ensureReady: readyStub,
    fetchImpl: annotationFetchStub({ posts }),
    recordReceipt: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.run_id, runId);
  assert.equal(result.trace_id, TRACE_ID);
  assert.deepEqual(result.judge_inputs, built.inputs);
  assert.equal(invocations.length, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data[0].metadata.source_run_id, runId);
});

test("stored fixtures missing contract-required Judge input are rejected before model invocation", async () => {
  const artifact = commitArtifact("run-judge-short-fixture");
  const snapshot = {
    project: {
      id: "proj-short",
      name: "Short Fixture Project",
      content: "## Goal\nCatch short captures.",
      status: "planned",
    },
  };
  const built = buildJudgeInputs({
    artifact,
    snapshot,
    allowedFailureModes: judgeAllowedFailureModes(),
  });
  const projected = buildJudgeFixtureInput({ judgeInputs: built.inputs });
  assert.equal(projected.ok, true);
  const shortInput = structuredClone(projected);
  delete shortInput.judge_fixture_input.terminal_reason;

  const stored = buildStoredFixtureJudgeInputs({
    fixture: { input: shortInput },
    refreshMaintainerContext: false,
  });
  assert.equal(stored.ok, false);
  assert.equal(stored.reason, "stored_judge_input_incomplete");
  assert.ok(stored.failures.includes("missing:terminal_reason"));

  const detectionOnly = await runStoredDecompositionFixtureJudge({
    fixture: { input: { ...projected, gradeability: "detection_only" } },
    config: judgeConfig(),
    runCommand: async () => {
      throw new Error("the model must not run for detection-only fixtures");
    },
    fetchImpl: noFetch,
  });
  assert.equal(detectionOnly.judge_state, "not_run");
  assert.equal(detectionOnly.reason, "stored_fixture_not_full_input");
  assert.equal(detectionOnly.gradeability, "detection_only");

  assert.deepEqual(
    buildStoredFixtureJudgeInputs({
      fixture: { input: projected },
      refreshMaintainerContext: false,
    }).inputs,
    built.inputs,
    "stored fixture projection must stay equal to buildJudgeInputs output; adding a Judge input requires capturing it",
  );
  assert.deepEqual(
    buildMaintainerSuppliedContext(),
    projected.maintainer_supplied_context,
  );
});

test("judge prompt registration stages the pin without mutating phoenix-assets.json", async () => {
  const repoRoot = tempRepoRoot("register");
  const manifestBefore = fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8");
  const versionId = "UHJvbXB0VmVyc2lvbjox";

  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, method: init.method ?? "GET", body: init.body ?? null });
    if (target.endsWith("/v1/prompts") && init.method === "POST") {
      return new Response(JSON.stringify({ data: { id: versionId } }), { status: 200 });
    }
    if (target.endsWith("/v1/prompts")) {
      return new Response(JSON.stringify({
        data: [{ id: "UHJvbXB0OjE=", name: "decomposition_quality_judge" }],
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const result = await registerJudgePromptInPhoenix({
    repoRoot,
    config: judgeConfig(),
    ensureReady: readyStub,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.prompt_version_id, versionId);
  assert.equal(result.prompt_id, "UHJvbXB0OjE=");
  assert.equal(result.manifest_mutated, false);

  // The committed manifest is untouched: the repo snapshot stays the accepted
  // baseline until a human (or the promotion controller) applies the pin.
  assert.equal(fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8"), manifestBefore);

  // The registered version content is the EXACT accepted snapshot bytes.
  const contract = loadJudgePromptContract();
  const post = requests.find((request) => request.method === "POST");
  const payload = JSON.parse(post.body);
  assert.equal(payload.prompt.name, "decomposition_quality_judge");
  assert.equal(payload.prompt.metadata.snapshot_sha256, contract.entry.snapshot_sha256);
  assert.equal(payload.version.template.type, "chat");
  assert.equal(payload.version.template.messages[0].content, contract.snapshotText);
  assert.equal(payload.version.template_type, "CHAT");
  assert.equal(payload.version.template_format, "NONE");
  assert.equal(payload.version.model_provider, "OPENAI");
  assert.equal(payload.version.model_name, JUDGE_MODEL);

  // Staged pin is phoenix-assets-shaped and carries the returned version id.
  assert.equal(result.staged_pin.prompts[0].role, "decomposition_quality_judge");
  assert.equal(result.staged_pin.prompts[0].accepted_prompt_version_id, versionId);
  assert.equal(result.staged_pin.prompts[0].snapshot_sha256, contract.entry.snapshot_sha256);
  assert.equal(result.staged_pin.evaluators[0].id, "decomposition_quality_judge_v1");
  assert.equal(result.staged_pin.evaluators[0].prompt_version_id, versionId);
  assert.equal(result.staged_pin.evaluators[0].model, JUDGE_MODEL);

  // Local registration receipt records the staged pin.
  const receiptPath = registrationReceiptPath(repoRoot);
  assert.equal(result.receipt_path, receiptPath);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.registrations.length, 1);
  assert.equal(receipt.registrations[0].prompt_version_id, versionId);
  assert.equal(receipt.registrations[0].staged_pin.prompts[0].accepted_prompt_version_id, versionId);

  // No tag write happened (tags are intent signals owned by the promotion flow).
  assert.ok(!requests.some((request) => request.url.includes("/tags")));

  const lines = formatJudgePromptRegistrationReport(result);
  assert.ok(lines.some((line) => line.includes("was not modified")));
  assert.ok(lines.some((line) => line.includes("staged manifest pin")));
});

test("prompt registration by target key stages a phase prompt pin without mutating manifest or applying a tag", async () => {
  const repoRoot = tempRepoRoot("register-phase");
  const manifestBefore = fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8");
  const manifest = JSON.parse(manifestBefore);
  const targetKey = "prompt/decomposition/pm_product_sufficiency_pass";
  const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
  const snapshotBytes = fs.readFileSync(path.resolve(path.dirname(PHOENIX_ASSETS_PATH), "..", "..", "..", entry.snapshot_path), "utf8");
  const versionId = "UHJvbXB0VmVyc2lvbjoy";

  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, method: init.method ?? "GET", body: init.body ?? null });
    if (target.endsWith("/v1/prompts") && init.method === "POST") {
      return new Response(JSON.stringify({ data: { id: versionId } }), { status: 200 });
    }
    if (target.endsWith("/v1/prompts")) {
      return new Response(JSON.stringify({
        data: [{ id: "UHJvbXB0OjI=", name: "pm_product_sufficiency_pass" }],
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const result = await registerPromptInPhoenix({
    repoRoot,
    targetKey,
    config: judgeConfig(),
    ensureReady: readyStub,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target_key, targetKey);
  assert.equal(result.role, "pm");
  assert.equal(result.prompt_name, "pm_product_sufficiency_pass");
  assert.equal(result.prompt_version_id, versionId);
  assert.equal(result.manifest_mutated, false);
  assert.equal(fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8"), manifestBefore);

  const post = requests.find((request) => request.method === "POST");
  const payload = JSON.parse(post.body);
  assert.equal(payload.prompt.metadata.target_key, targetKey);
  assert.equal(payload.prompt.metadata.snapshot_sha256, entry.snapshot_sha256);
  assert.equal(payload.version.template.type, "chat");
  assert.equal(payload.version.template.messages[0].role, "system");
  assert.equal(payload.version.template.messages[0].content, snapshotBytes);
  assert.equal(payload.version.template_type, "CHAT");
  assert.equal(payload.version.template_format, "NONE");
  assert.equal(payload.version.model_provider, "ANTHROPIC");
  assert.equal(payload.version.model_name, "model-a");

  assert.equal(result.staged_pin.prompts[0].target_key, targetKey);
  assert.equal(result.staged_pin.prompts[0].accepted_prompt_version_id, versionId);
  assert.deepEqual(result.staged_pin.evaluators, []);

  const receipt = JSON.parse(fs.readFileSync(registrationReceiptPath(repoRoot), "utf8"));
  assert.equal(receipt.registrations[0].target_key, targetKey);
  assert.equal(receipt.registrations[0].staged_pin.prompts[0].target_key, targetKey);
  assert.ok(!requests.some((request) => request.url.includes("/tags")));
});

test("prompt registration accepts caller-supplied candidate bytes without reading a disk snapshot as content", async () => {
  const repoRoot = tempRepoRoot("register-caller-content");
  const manifestBefore = fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8");
  const targetKey = "prompt/decomposition/pm_product_sufficiency_pass";
  const draftedContent = "Complete drafted prompt bytes\nwith exact spacing.\n";
  const versionId = "UHJvbXB0VmVyc2lvbjoz";
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, method: init.method ?? "GET", body: init.body ?? null });
    if (target.endsWith("/v1/prompts") && init.method === "POST") {
      return new Response(JSON.stringify({ data: { id: versionId } }), { status: 200 });
    }
    if (target.endsWith("/v1/prompts")) {
      return new Response(JSON.stringify({
        data: [{ id: "UHJvbXB0OjM=", name: "pm_product_sufficiency_pass" }],
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const result = await registerPromptInPhoenix({
    repoRoot,
    targetKey,
    config: judgeConfig(),
    contentText: draftedContent,
    ensureReady: readyStub,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.prompt_version_id, versionId);
  assert.equal(fs.readFileSync(PHOENIX_ASSETS_PATH, "utf8"), manifestBefore);
  const post = requests.find((request) => request.method === "POST");
  const payload = JSON.parse(post.body);
  assert.equal(payload.version.template.type, "chat");
  assert.equal(payload.version.template.messages[0].role, "system");
  assert.equal(payload.version.template.messages[0].content, draftedContent);
  assert.equal(payload.version.template_type, "CHAT");
  assert.equal(payload.version.template_format, "NONE");
  assert.equal(payload.prompt.metadata.registration_content_source, "caller_supplied");
  assert.equal(payload.prompt.metadata.snapshot_sha256, sha256(draftedContent));
  assert.equal(result.snapshot_sha256, sha256(draftedContent));
  assert.equal(result.manifest_mutated, false);
  assert.ok(!requests.some((request) => request.url.includes("/tags")));
});

test("judge runtime assignment follows role conventions and the output schema mirrors the canonical label set", () => {
  const assignment = resolveJudgeRuntimeAssignment(judgeConfig());
  assert.equal(assignment.role, "judge");
  assert.equal(assignment.runtime, "codex");
  assert.equal(assignment.model, JUDGE_MODEL);
  assert.equal(assignment.tool_policy.linear_write, false);
  assert.deepEqual(assignment.warm_continuation, { enabled: false, required: false });
  assert.equal(assignment.generation_schema_path, JUDGE_OUTPUT_SCHEMA_PATH);
  assert.ok(path.isAbsolute(JUDGE_OUTPUT_SCHEMA_PATH));

  const schema = JSON.parse(fs.readFileSync(JUDGE_OUTPUT_SCHEMA_PATH, "utf8"));
  assert.deepEqual(schema.properties.label.enum, [...QUALITY_LABELS]);
  assert.deepEqual(schema.required, ["label", "score", "explanation", "failure_modes"]);

  assert.equal(
    judgeAnnotationIdentifier({ evaluatorId: "decomposition_quality_judge_v1", model: "m1" }),
    "decomposition_quality_judge_v1:m1",
  );
  assert.throws(() => judgeAnnotationIdentifier({ evaluatorId: "x", model: "" }));

  // Input assembly carries the Model Judge Policy required inputs.
  const built = buildJudgeInputs({
    artifact: commitArtifact("run-inputs"),
    snapshot: { project: { id: "p", name: "n", content: "c", status: "planned" } },
    allowedFailureModes: ["missing_acceptance_criteria"],
  });
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.inputs), [
    "project_intent",
    "terminal_status",
    "terminal_reason",
    "final_issues",
    "dependency_relations",
    "project_update_markdown",
    "open_questions_markdown",
    "phase_packet_summaries",
    "rubric_version",
    "failure_taxonomy_version",
    "allowed_failure_modes",
  ]);
  assert.deepEqual(built.inputs.dependency_relations, [{ blocking: "step/one", blocked: "step/two" }]);
  assert.deepEqual(built.inputs.phase_packet_summaries, [{
    phase: "orchestrator_terminal",
    status: "commit",
    reason: "synthesis_complete",
    context_digest: "digest-1",
    assumptions: ["assume-1"],
    constraints: [],
    risks: [],
    source_refs: [],
    perspectives_run: [{ role: "pm", outcome: "synthesis_complete" }],
  }]);

  const paused = buildJudgeInputs({
    artifact: {
      ...commitArtifact("run-paused-inputs"),
      kind: "pause",
      final_issues: undefined,
      project_update_markdown: undefined,
      terminal_output: {
        schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
        run_id: "run-paused-inputs",
        workflow_version: ENGINE_VERSION,
        outcome: "pause",
        reason: "product_questions",
        context_digest: "digest-questions",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      },
      pause_packet: {
        schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
        run_id: "run-paused-inputs",
        phase: "orchestrator_terminal",
        status: "pause",
        reason: "product_questions",
        context_digest: "digest-questions",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
        open_questions_markdown: "- Which segment should launch first?",
      },
    },
    snapshot: { project: { id: "p", name: "n", content: "c", status: "planned" } },
    allowedFailureModes: ["missing_acceptance_criteria"],
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.inputs.terminal_status, "paused");
  assert.equal(paused.inputs.project_update_markdown, null);
  assert.equal(paused.inputs.open_questions_markdown, "- Which segment should launch first?");
});
