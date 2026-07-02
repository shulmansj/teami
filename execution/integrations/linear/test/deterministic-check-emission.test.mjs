import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  emitDeterministicCheckResults,
  emitDeterministicChecksBestEffort,
  formatDeterministicCheckReport,
  PHOENIX_CODE_CHECK_STORAGE_CAPABILITY,
  preflightPhoenixCodeCheckStorage,
  runDeterministicChecksForArtifact,
} from "../src/deterministic-check-emission.mjs";
import { QUALITY_LABELS } from "../src/eval-annotation-contract.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import {
  CODE_EMITTED_LABELS,
  evaluateAcceptedPacketSufficiencyOffline,
  evaluateDecompositionQualityOffline,
  evaluatePauseState,
} from "../src/quality.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";

const TRACE_ID = "aaaabbbbccccddddeeeeffff00001111";
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
const AUDIT_FIELDS = Object.freeze({
  context_digest: "terminal context digest",
  source_refs: [{ kind: "linear_project", id: "project-1" }],
  assumptions: [],
  constraints: [],
  risks: [],
});

function tempRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `teami-check-emission-${label}-`));
}

function commitArtifact(runId) {
  const projectUpdate = `run_id: ${runId}`;
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: runId,
    ...ARTIFACT_IDENTITY,
    runtime_assignments: {
      pm: { runtime: "claude", model: "model-a" },
      sr_eng: { runtime: "codex", model: "model-b" },
    },
    runtime_metadata: {},
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "commit",
      reason: "synthesis_complete",
      ...AUDIT_FIELDS,
    },
    evidence: { perspectives_run: [{ role: "pm", outcome: "synthesis_complete" }] },
    bounds: { rounds_used: 2, max_rounds: 4 },
    final_issues: [],
    project_update_markdown: projectUpdate,
  };
}

function pauseArtifact(runId) {
  const projectUpdate = `run_id: ${runId}`;
  const openQuestions = "- Which provider tier?";
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "pause",
    run_id: runId,
    ...ARTIFACT_IDENTITY,
    runtime_assignments: {
      pm: { runtime: "claude", model: "model-a" },
      sr_eng: { runtime: "codex", model: "model-b" },
    },
    runtime_metadata: {},
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "pause",
      reason: "product_questions",
      ...AUDIT_FIELDS,
    },
    evidence: { perspectives_run: [{ role: "pm", outcome: "product_questions" }] },
    bounds: { rounds_used: 1, max_rounds: 4 },
    pause_packet: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      phase: "orchestrator_terminal",
      status: "pause",
      reason: "product_questions",
      ...AUDIT_FIELDS,
      open_questions_markdown: openQuestions,
      project_update_markdown: projectUpdate,
    },
    discovery_issues: [],
  };
}

function recordTestTraceStatus(options) {
  return recordTraceStatus({ ...TRACE_IDENTITY, ...options });
}

// FastAPI-shaped openapi document mirroring the pinned arize-phoenix 14.13.0
// trace annotation surface ($ref chain: path -> request body -> data items).
function openapiSpec({ annotatorKinds = ["LLM", "CODE", "HUMAN"], includePath = true } = {}) {
  return {
    paths: includePath
      ? {
          "/v1/trace_annotations": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/AnnotateTracesRequestBody" },
                  },
                },
              },
            },
          },
        }
      : {},
    components: {
      schemas: {
        AnnotateTracesRequestBody: {
          properties: {
            data: { items: { $ref: "#/components/schemas/TraceAnnotationData" } },
          },
        },
        TraceAnnotationData: {
          properties: {
            name: { type: "string" },
            annotator_kind: { enum: annotatorKinds, type: "string" },
            trace_id: { type: "string" },
            result: {
              anyOf: [{ $ref: "#/components/schemas/AnnotationResult" }, { type: "null" }],
            },
            metadata: { anyOf: [{ type: "object" }, { type: "null" }] },
            identifier: { type: "string", default: "" },
          },
        },
        AnnotationResult: {
          properties: { label: {}, score: {}, explanation: {} },
        },
      },
    },
  };
}

function phoenixFetchStub({ spec = openapiSpec(), posts = [] } = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/openapi.json")) {
      return new Response(JSON.stringify(spec), { status: 200 });
    }
    if (target.endsWith("/v1/trace_annotations?sync=true")) {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ id: `anno-${posts.length}` }] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${target}`);
  };
}

const readyStub = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" });

test("preflight verifies CODE annotation storage against the live openapi shape", async () => {
  const result = await preflightPhoenixCodeCheckStorage({
    repoRoot: tempRepoRoot("preflight-ok"),
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.capability, PHOENIX_CODE_CHECK_STORAGE_CAPABILITY);
  assert.equal(result.checkedPath, "/v1/trace_annotations");
  assert.ok(result.annotatorKinds.includes("CODE"));
});

test("preflight fails closed on Phoenix unavailability and version drift", async () => {
  const repoRoot = tempRepoRoot("preflight-drift");

  const down = await preflightPhoenixCodeCheckStorage({
    repoRoot,
    ensureReady: async () => ({ ok: false, reason: "phoenix_not_running" }),
    fetchImpl: async () => {
      throw new Error("must not fetch when Phoenix is unavailable");
    },
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, "local_phoenix_unavailable");

  const missingEndpoint = await preflightPhoenixCodeCheckStorage({
    repoRoot,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ spec: openapiSpec({ includePath: false }) }),
  });
  assert.equal(missingEndpoint.ok, false);
  assert.equal(missingEndpoint.reason, "trace_annotation_endpoint_missing");

  // Version drift: a future Phoenix that drops CODE from the annotator kinds
  // must fail the capability, never downgrade to HUMAN/LLM storage.
  const noCode = await preflightPhoenixCodeCheckStorage({
    repoRoot,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ spec: openapiSpec({ annotatorKinds: ["LLM", "HUMAN"] }) }),
  });
  assert.equal(noCode.ok, false);
  assert.equal(noCode.reason, "code_annotator_kind_unsupported");

  const noOpenapi = await preflightPhoenixCodeCheckStorage({
    repoRoot,
    ensureReady: readyStub,
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  assert.equal(noOpenapi.ok, false);
  assert.equal(noOpenapi.reason, "openapi_unavailable");
});

test("emission loads the run artifact and trace receipt and writes CODE annotations on the receipt's trace id", async () => {
  const repoRoot = tempRepoRoot("happy");
  const runId = "run-emit-happy";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const posts = [];
  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    requirePhoenixNative: true,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ posts }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "phoenix_native");
  assert.equal(result.failed_closed, false);
  assert.equal(result.trace_id, TRACE_ID);
  assert.equal(result.emitted_count, 1);
  assert.equal(result.skipped_count, 2);
  assert.deepEqual(result.annotation_ids, ["anno-1"]);

  // The CODE annotation went through the shared write path with the
  // evaluator's stable identifier and rubric/taxonomy versions, attached to
  // the receipt's trace id.
  assert.equal(posts.length, 1);
  const wire = posts[0].data[0];
  assert.equal(wire.annotator_kind, "CODE");
  assert.equal(wire.name, "accepted_packet_sufficiency");
  assert.equal(wire.identifier, "accepted_packet_sufficiency_offline_v1");
  assert.equal(wire.trace_id, TRACE_ID);
  assert.equal(wire.result.label, "pass");
  assert.equal(wire.result.score, 1);
  assert.deepEqual(wire.metadata.failure_modes, []);
  assert.deepEqual(wire.metadata.failure_mode_details, []);
  assert.equal(wire.metadata.rubric_version, "1.0.0");
  assert.equal(wire.metadata.failure_taxonomy_version, "1.0.0");
  assert.equal(wire.metadata.workspace_maturity, "new");
  assert.equal(wire.metadata.source_run_id, runId);

  // Checks whose required inputs are not recorded in run artifacts are
  // skipped with named reasons (Error/Rescue: skipped, never guessed).
  const skipReasons = Object.fromEntries(
    result.checks.filter((check) => check.status === "skipped")
      .map((check) => [check.name, check.skip_reason]),
  );
  assert.deepEqual(skipReasons, {
    quality: "structured_issue_inputs_not_recorded_in_run_artifact",
    pause_state_correctness: "not_applicable_run_not_paused",
  });

  const report = formatDeterministicCheckReport(result);
  assert.ok(report.some((line) => line.includes("storage: phoenix_native")));
});

test("deterministic checks emit through an externally managed healthy Phoenix collector", async () => {
  const repoRoot = tempRepoRoot("external-collector");
  const runId = "run-emit-external-collector";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const posts = [];
  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    requirePhoenixNative: true,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: false,
      reused: true,
      started: false,
    }),
    fetchImpl: phoenixFetchStub({ posts }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "phoenix_native");
  assert.equal(result.failed_closed, false);
  assert.equal(result.trace_id, TRACE_ID);
  assert.equal(result.emitted_count, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data[0].annotator_kind, "CODE");
  assert.equal(posts[0].data[0].trace_id, TRACE_ID);
});

test("preflight failure falls back to report output and fails closed for Phoenix-native workflows", async () => {
  const repoRoot = tempRepoRoot("fallback");
  const runId = "run-emit-fallback";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const posts = [];
  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    requirePhoenixNative: true,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ spec: openapiSpec({ annotatorKinds: ["LLM", "HUMAN"] }), posts }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.storage, "report_only");
  assert.equal(result.failed_closed, true);
  assert.equal(result.reason, "code_annotator_kind_unsupported");
  assert.equal(posts.length, 0, "no annotation may be written under a non-CODE kind");
  // The deterministic results are still recorded in the report output.
  const evaluatedCheck = result.checks.find((check) => check.status === "evaluated");
  assert.equal(evaluatedCheck.name, "accepted_packet_sufficiency");
  assert.equal(evaluatedCheck.annotation.label, "pass");
  const report = formatDeterministicCheckReport(result);
  assert.ok(report.some((line) => line.includes("report_only")));
  assert.ok(report.some((line) => line.includes("never stored as HUMAN or LLM")));
});

test("deterministic checks are never emitted as HUMAN or LLM even when flags or config are malformed", async () => {
  const repoRoot = tempRepoRoot("no-spoof");
  const runId = "run-emit-no-spoof";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const posts = [];
  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ posts }),
    // Malformed/hostile options: there is no annotator-kind parameter, so
    // these must be ignored — the write site hardcodes CODE.
    annotatorKind: "HUMAN",
    kind: "LLM",
    annotator_kind: "HUMAN",
  });

  assert.equal(result.ok, true);
  assert.ok(posts.length > 0);
  for (const post of posts) {
    for (const entry of post.data) {
      assert.equal(entry.annotator_kind, "CODE");
    }
  }
});

test("missing run artifact skips every check with a named reason and fails the emission", async () => {
  const repoRoot = tempRepoRoot("missing-artifact");
  const runId = "run-emit-missing-artifact";
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const posts = [];
  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    requirePhoenixNative: true,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ posts }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_run_artifact");
  assert.equal(result.storage, "report_only");
  assert.equal(result.failed_closed, true);
  assert.equal(posts.length, 0);
  assert.equal(result.checks.length, 3);
  for (const check of result.checks) {
    assert.equal(check.status, "skipped");
    assert.equal(check.skip_reason, "missing_run_artifact");
  }
});

test("missing trace receipt yields report-only results with missing_trace_target", async () => {
  const repoRoot = tempRepoRoot("missing-receipt");
  const runId = "run-emit-missing-receipt";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));

  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("preflight must not run without a trace target");
    },
    fetchImpl: async () => {
      throw new Error("no Phoenix call may happen without a trace target");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.storage, "report_only");
  assert.equal(result.reason, "missing_trace_target");
  // Results are still computed and recorded in the report output.
  assert.ok(result.checks.some((check) => check.status === "evaluated"));
});

test("eval-mode parity: in-memory artifact, explicit trace id, and supplied evaluator inputs emit all three checks", async () => {
  // Empty temp repoRoot: nothing is read from local stores in this mode.
  const repoRoot = tempRepoRoot("eval-mode");
  const artifact = pauseArtifact("run-eval-mode");
  const posts = [];

  const result = await emitDeterministicCheckResults({
    repoRoot,
    artifact,
    traceId: TRACE_ID,
    checkInputs: {
      quality: {
        issues: [{
          assignment: "Do the work",
          output: "The deliverable",
          acceptanceCriteria: ["Observable check"],
          decompositionKey: "eval/one",
        }],
        dependencies: [],
        assumptions: [],
      },
      pause_state_correctness: {
        project: {
          labels: [{ id: "label-open-questions" }],
          status: { id: "status-backlog", type: "backlog" },
          content: "## Open Questions\n- Which provider tier?",
        },
        hasOpenQuestionsLabelId: "label-open-questions",
        backlogStatusId: "status-backlog",
      },
    },
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ posts }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "phoenix_native");
  assert.equal(result.run_id, "run-eval-mode");
  assert.equal(result.emitted_count, 3);
  assert.equal(result.skipped_count, 0);
  assert.equal(posts.length, 3);
  const byName = Object.fromEntries(posts.map((post) => [post.data[0].name, post.data[0]]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "accepted_packet_sufficiency",
    "pause_state_correctness",
    "quality",
  ]);
  for (const entry of Object.values(byName)) {
    assert.equal(entry.annotator_kind, "CODE");
    assert.equal(entry.trace_id, TRACE_ID);
  }
  assert.equal(byName.quality.identifier, "decomposition_quality_offline_v1");
  assert.equal(byName.quality.result.label, "pass");
  assert.equal(byName.pause_state_correctness.identifier, "pause_state_correctness_offline_v1");
  assert.equal(byName.pause_state_correctness.result.label, "pass");
});

test("artifact-driven pause runs name the missing post-mutation project state instead of guessing", () => {
  const checks = runDeterministicChecksForArtifact({ artifact: pauseArtifact("run-pause") });
  const pauseCheck = checks.find((check) => check.name === "pause_state_correctness");
  assert.equal(pauseCheck.status, "skipped");
  assert.equal(pauseCheck.skip_reason, "post_mutation_project_state_not_recorded_in_run_artifact");
  assert.deepEqual(pauseCheck.missing_inputs, [
    "project",
    "hasOpenQuestionsLabelId",
    "backlogStatusId",
  ]);
  // The packet sufficiency check still runs from the recorded packets.
  const sufficiency = checks.find((check) => check.name === "accepted_packet_sufficiency");
  assert.equal(sufficiency.status, "evaluated");
  assert.equal(sufficiency.annotation.label, "pass");
});

test("artifact-driven accepted packet sufficiency reads terminal_output before stale phase packets", () => {
  const artifact = commitArtifact("run-terminal-sufficiency");
  artifact.terminal_output.context_digest = "";
  artifact.phase_packets = [{
    phase: "legacy_packet_that_should_not_be_read",
    status: "continue",
    reason: "synthesis_complete",
    context_digest: "legacy digest",
    source_refs: [],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: `run_id: ${artifact.run_id}`,
  }];

  const checks = runDeterministicChecksForArtifact({ artifact });
  const sufficiency = checks.find((check) => check.name === "accepted_packet_sufficiency");
  assert.equal(sufficiency.status, "evaluated");
  assert.equal(sufficiency.annotation.label, "needs_revision");
  assert.deepEqual(sufficiency.annotation.metadata.failure_modes, ["missing_context_digest"]);
  assert.deepEqual(sufficiency.annotation.metadata.failure_mode_details, [
    "missing_context_digest:orchestrator_output",
  ]);
});

test("artifact-driven accepted packet sufficiency does not revive packet-only terminal artifacts", () => {
  const artifact = {
    ...commitArtifact("run-packet-only-terminal"),
    terminal_output: undefined,
    phase_packets: [{
      phase: "legacy_packet_that_should_not_be_read",
      status: "continue",
      reason: "synthesis_complete",
      context_digest: "legacy digest",
      source_refs: [],
      assumptions: [],
      constraints: [],
      risks: [],
      project_update_markdown: "run_id: run-packet-only-terminal",
    }],
  };

  const checks = runDeterministicChecksForArtifact({ artifact });
  const sufficiency = checks.find((check) => check.name === "accepted_packet_sufficiency");
  assert.equal(sufficiency.status, "skipped");
  assert.equal(sufficiency.skip_reason, "missing_terminal_output");
  assert.deepEqual(sufficiency.missing_inputs, ["terminal_output"]);
});

test("annotation write failures are reported per check and fail the emission without throwing", async () => {
  const repoRoot = tempRepoRoot("write-failure");
  const runId = "run-emit-write-failure";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  const result = await emitDeterministicCheckResults({
    repoRoot,
    runId,
    requirePhoenixNative: true,
    ensureReady: readyStub,
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/openapi.json")) {
        return new Response(JSON.stringify(openapiSpec()), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.storage, "phoenix_native");
  assert.equal(result.reason, "annotation_write_failed");
  assert.equal(result.failed_closed, true);
  assert.equal(result.emitted_count, 0);
  const failed = result.checks.find((check) => check.status === "evaluated");
  assert.match(failed.error, /phoenix_http_500/);
});

test("best-effort post-terminal emission never throws and cannot alter the runner outcome", async () => {
  const repoRoot = tempRepoRoot("best-effort");
  const runId = "run-best-effort";
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId));
  recordTestTraceStatus({ repoRoot, runId, traceId: TRACE_ID, status: "trace_exported" });

  // The runner fixes status and exit mapping BEFORE the hook runs; emission
  // failure may only produce a notice.
  const runnerResult = Object.freeze({ status: "completed", reason: null });
  const exitOk = ["completed", "paused", "rejected", "idle"].includes(runnerResult.status);

  const failed = await emitDeterministicChecksBestEffort({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("simulated Phoenix explosion");
    },
    fetchImpl: async () => {
      throw new Error("simulated network failure");
    },
  });
  assert.equal(failed.attempted, true);
  assert.equal(failed.ok, false);
  assert.equal(runnerResult.status, "completed");
  assert.equal(
    ["completed", "paused", "rejected", "idle"].includes(runnerResult.status),
    exitOk,
    "run outcome mapping must be unchanged by emission failure",
  );

  // Unresolvable run id: the hook reports instead of throwing.
  const unresolved = await emitDeterministicChecksBestEffort({ repoRoot, runId: null });
  assert.equal(unresolved.attempted, false);
  assert.equal(unresolved.reason, "run_id_unresolved");

  // And a working Phoenix lets the hook emit without affecting the outcome.
  const posts = [];
  const succeeded = await emitDeterministicChecksBestEffort({
    repoRoot,
    runId,
    ensureReady: readyStub,
    fetchImpl: phoenixFetchStub({ posts }),
  });
  assert.equal(succeeded.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(runnerResult.status, "completed");
});

test("live mutation path stays free of deterministic check emission", () => {
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const engineDir = path.resolve(import.meta.dirname, "..", "..", "..", "engine");
  // The live decomposition mutation path gains no emission import/call:
  // deterministic checks never run in the live mutation decision path
  // (CONSTRAINTS #27); emission is post-run/on-demand/eval-mode only.
  const liveModules = [
    { name: "trigger-runner.mjs", path: path.join(srcDir, "trigger-runner.mjs") },
    { name: "orchestrator-loop.mjs", path: path.join(engineDir, "orchestrator-loop.mjs") },
    { name: "linear-service.mjs", path: path.join(srcDir, "linear-service.mjs") },
  ];
  for (const liveModule of liveModules) {
    const source = fs.readFileSync(liveModule.path, "utf8");
    assert.ok(
      !source.includes("deterministic-check-emission"),
      `${liveModule.name} must not import the emission module`,
    );
    assert.ok(
      !source.includes("emitDeterministicCheck"),
      `${liveModule.name} must not call deterministic check emission`,
    );
  }
  const cliSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "runner-command.mjs"),
    "utf8",
  );
  assert.ok(!cliSource.includes("deterministic-check-emission"));
  assert.ok(!cliSource.includes("emitDeterministicCheck"));
});

test("code evaluators emit only the documented pass|needs_revision subset of the canonical label set", () => {
  // Label reconciliation (plan Track D2): blocking_failure is NOT a
  // code-emitted label in MVP; it stays a human/model trust judgment.
  assert.deepEqual([...CODE_EMITTED_LABELS], ["pass", "needs_revision"]);
  for (const label of CODE_EMITTED_LABELS) {
    assert.ok(QUALITY_LABELS.includes(label), `code label ${label} must stay canonical`);
  }
  assert.ok(QUALITY_LABELS.includes("blocking_failure"));
  assert.ok(!CODE_EMITTED_LABELS.includes("blocking_failure"));

  const outputs = [
    evaluateDecompositionQualityOffline({ issues: [], dependencies: [] }),
    evaluateDecompositionQualityOffline({
      issues: [{
        assignment: "a",
        output: "b",
        acceptanceCriteria: ["c"],
        decompositionKey: "k",
      }],
      dependencies: [],
    }),
    evaluateAcceptedPacketSufficiencyOffline({ phasePackets: [] }),
    evaluatePauseState({
      project: { labels: [], status: { id: "s" }, content: "" },
      hasOpenQuestionsLabelId: "l",
      backlogStatusId: "s2",
    }),
  ];
  for (const output of outputs) {
    assert.ok(
      CODE_EMITTED_LABELS.includes(output.label),
      `evaluator ${output.identifier} emitted non-code label ${output.label}`,
    );
    assert.equal(output.annotator_kind, "CODE");
  }
});

test("the asset manifest pins the stable identifier of every deterministic CODE evaluator", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "..", "..", "..", "evals", "decomposition", "phoenix-assets.json",
    ),
    "utf8",
  ));
  const codeEvaluatorIds = manifest.evaluators
    .filter((evaluator) => evaluator.kind === "code")
    .map((evaluator) => evaluator.id);
  assert.deepEqual(codeEvaluatorIds, [
    "decomposition_quality_offline_v1",
    "accepted_packet_sufficiency_offline_v1",
    "pause_state_correctness_offline_v1",
  ]);
});
