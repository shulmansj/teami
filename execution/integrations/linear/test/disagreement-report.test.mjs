import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FAILURE_TAXONOMY_VERSION,
  RUBRIC_VERSION,
} from "../src/eval-annotation-contract.mjs";
import {
  deriveRunEvalStatus,
  detectAnnotationDisagreements,
} from "../src/eval-status.mjs";
import {
  buildPrDisagreementDisclosure,
  collectDisagreementReport,
  detectBandMismatchedAnnotations,
  detectHumanLabelDegradations,
  formatDisagreementReport,
  qualityLabelRank,
} from "../src/disagreement-report.mjs";
import { PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import {
  recordTraceStatus,
  traceTelemetryPaths,
} from "../src/trace-status-store.mjs";

const TRACE_RUN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01";
const TRACE_SRC = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
const TRACE_IDENTITY = Object.freeze({
  domainId: "support-ops",
  workspaceId: "workspace-1",
  teamId: "team-1",
});

const readyUp = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "teami" });

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-disagreement-"));
  process.env.TEAMI_HOME = root;
  return root;
}

function recordTestTraceStatus(options) {
  return recordTraceStatus({ ...TRACE_IDENTITY, ...options });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

// Route-table fetch fake. Exact "METHOD /pathname" keys win; the
// trace_annotations pattern is handled via the annotationsByTrace map.
function fetchRouter(routes, { annotationsByTrace = {} } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const call = {
      method: init.method ?? null,
      body: init.body ?? null,
      pathname: parsed.pathname,
      url: parsed,
    };
    calls.push(call);
    if (/^\/v1\/projects\/[^/]+\/trace_annotations$/.test(parsed.pathname)) {
      const traceId = parsed.searchParams.get("trace_ids");
      return jsonResponse({ data: annotationsByTrace[traceId] || [], next_cursor: null });
    }
    const handler = routes[`${method} ${parsed.pathname}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
    return typeof handler === "function" ? handler(call) : handler;
  };
  impl.calls = calls;
  return impl;
}

function humanAnnotation({ label = "pass", score = 0.9, failureModes = [], identifier = "steve", id = "anno-h1" } = {}) {
  return {
    id,
    name: "quality",
    annotator_kind: "HUMAN",
    identifier,
    result: { label, score, explanation: "human taste judgment" },
    metadata: {
      failure_modes: failureModes,
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    },
  };
}

function llmAnnotation({ label = "pass", score = 0.9, failureModes = [], id = "anno-l1" } = {}) {
  return {
    id,
    name: "quality",
    annotator_kind: "LLM",
    identifier: "decomposition_quality_judge_v1:test-model",
    result: { label, score, explanation: "rubric verdict" },
    metadata: {
      failure_modes: failureModes,
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    },
  };
}

function codeAnnotation({ label = "needs_revision", score = 0, failureModes = ["missing_acceptance_criteria"], id = "anno-c1" } = {}) {
  return {
    id,
    name: "quality",
    annotator_kind: "CODE",
    identifier: "decomposition_quality_offline_v1",
    result: { label, score, explanation: "structural gaps" },
    metadata: { failure_modes: failureModes },
  };
}

function projectsRoute() {
  return jsonResponse({ data: [{ id: "UHJvamVjdDox", name: "teami" }] });
}

// ---------------------------------------------------------------------------
// One source of truth: the report's detector IS the worklist's detector.
// ---------------------------------------------------------------------------

test("worklist and disagreement report share one detection source of truth", () => {
  const humans = [
    { name: "quality", annotator_kind: "HUMAN", identifier: "steve", label: "pass", score: 0.9, explanation: "good", metadata: { failure_modes: [] } },
  ];
  const llms = [
    { name: "quality", annotator_kind: "LLM", identifier: "judge", label: "needs_revision", score: 0.55, explanation: "gaps", metadata: { failure_modes: ["prose_dependency_instead_of_relation"] } },
  ];
  const codes = [
    { name: "quality", annotator_kind: "CODE", identifier: "code", label: "needs_revision", score: 0, explanation: "structural", metadata: { failure_modes: ["missing_acceptance_criteria"] } },
  ];
  const shared = detectAnnotationDisagreements({ humans, llms, codes });
  const status = deriveRunEvalStatus({ annotations: [...humans, ...llms, ...codes] });
  // deriveRunEvalStatus (the step 3 worklist derivation) and the exported
  // shared detector must produce byte-identical disagreement sets.
  assert.deepEqual(status.disagreements, shared);
  assert.deepEqual(
    shared.map((item) => item.kind).sort(),
    ["code_human_failure_mode_conflict", "human_llm_label_conflict"],
  );
});

test("band-mismatch check flags HUMAN/LLM out-of-band scores but never CODE binary scores", () => {
  const flagged = detectBandMismatchedAnnotations([
    // HUMAN pass with a needs_revision-band score: flagged, still valid.
    { name: "quality", annotator_kind: "HUMAN", identifier: "steve", label: "pass", score: 0.5 },
    // LLM in band: not flagged.
    { name: "quality", annotator_kind: "LLM", identifier: "judge", label: "pass", score: 0.9 },
    // CODE binary scores are structural, not taste: never band-checked.
    { name: "accepted_packet_sufficiency", annotator_kind: "CODE", identifier: "code", label: "needs_revision", score: 0 },
    { name: "accepted_packet_sufficiency", annotator_kind: "CODE", identifier: "code", label: "pass", score: 1 },
  ]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].annotator_kind, "HUMAN");
  assert.equal(flagged[0].reason, "label_score_band_mismatch");
  assert.equal(flagged[0].still_valid_evidence, true);
});

test("human label degradation ordering follows the canonical label ranks", () => {
  assert.ok(qualityLabelRank("pass") > qualityLabelRank("needs_revision"));
  assert.ok(qualityLabelRank("needs_revision") > qualityLabelRank("blocking_failure"));
  const degradations = detectHumanLabelDegradations([
    { example_id: "EX1", judge_label: "needs_revision", human_labels: [{ identifier: "steve", label: "pass" }] },
    { example_id: "EX2", judge_label: "pass", human_labels: [{ identifier: "steve", label: "needs_revision" }] },
    { example_id: "EX3", judge_label: "pass", human_labels: [{ identifier: "steve", label: "pass" }] },
  ]);
  assert.deepEqual(degradations, [
    { example_id: "EX1", human_identifier: "steve", human_label: "pass", judge_label: "needs_revision" },
  ]);
});

test("PR disclosure shape: rationale required when proceeding despite disagreement; none-observed only after checking", () => {
  const withItems = buildPrDisagreementDisclosure({
    items: [{ example_id: "EX1", kind: "human_llm_label_conflict" }],
    checked: true,
    checkedExampleCount: 3,
  });
  assert.equal(withItems.proceeds_despite_disagreement_requires_rationale, true);
  assert.equal(withItems.controller_rationale, null, "the gate never invents the controller's rationale");
  assert.equal(withItems.none_observed_statement, null);

  const clean = buildPrDisagreementDisclosure({ checked: true, checkedExampleCount: 2 });
  assert.match(clean.none_observed_statement, /none observed \(checked 2/);

  const unchecked = buildPrDisagreementDisclosure({ checked: false, checkedExampleCount: 0 });
  assert.equal(unchecked.none_observed_statement, null, "'none observed' may only be stated after actually checking");
});

// ---------------------------------------------------------------------------
// Run mode.
// ---------------------------------------------------------------------------

test("run mode detects human/LLM label conflict and preserves raw records and Phoenix links", async () => {
  const repoRoot = tempRoot();
  recordTestTraceStatus({
    repoRoot,
    runId: "run-conflict",
    projectId: "proj-A",
    traceId: TRACE_RUN,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt: "2026-06-10T01:00:00.000Z",
  });
  const fetchImpl = fetchRouter(
    { "GET /v1/projects": projectsRoute() },
    {
      annotationsByTrace: {
        [TRACE_RUN]: [
          humanAnnotation({ label: "pass", score: 0.9 }),
          llmAnnotation({ label: "needs_revision", score: 0.55, failureModes: ["prose_dependency_instead_of_relation"] }),
        ],
      },
    },
  );

  const report = await collectDisagreementReport({
    repoRoot,
    runId: "run-conflict",
    ensureReady: readyUp,
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, "run");
  assert.equal(report.derived_status, "disagreement_open");
  assert.equal(report.disagreements[0].kind, "human_llm_label_conflict");
  assert.equal(report.disagreements[0].human_label, "pass");
  assert.equal(report.disagreements[0].llm_label, "needs_revision");

  // Raw records preserved: scores, rationales, failure modes, annotation ids.
  const llm = report.annotations.find((entry) => entry.annotator_kind === "LLM");
  assert.equal(llm.score, 0.55);
  assert.equal(llm.explanation, "rubric verdict");
  assert.deepEqual(llm.metadata.failure_modes, ["prose_dependency_instead_of_relation"]);
  assert.equal(llm.annotation_id, "anno-l1");
  assert.equal(report.annotations_raw.length, 2);

  // Phoenix link with origin from local config, never caller input.
  assert.equal(
    report.phoenix.deep_link,
    `http://127.0.0.1:6006/projects/UHJvamVjdDox/traces/${TRACE_RUN}`,
  );

  // Worklist item derived (never persisted) + PR disclosure shape.
  assert.ok(report.worklist_items.some((item) => item.priority_id === "disagreement_open"));
  assert.equal(report.pr_disclosure.proceeds_despite_disagreement_requires_rationale, true);

  // Derived view only: GET-only fetches, nothing persisted locally.
  for (const call of fetchImpl.calls) {
    assert.equal(call.method, null, `non-GET request observed: ${call.pathname}`);
    assert.equal(call.body, null);
  }
  assert.ok(!fs.existsSync(path.join(repoRoot, "gate-reports")));

  const lines = formatDisagreementReport(report);
  assert.ok(lines[0].includes("never persisted"));
  assert.ok(lines.some((line) => line.includes("DISAGREEMENT")));
});

test("run mode detects CODE-vs-human failure-mode conflict without forcing checks onto the taste scale", async () => {
  const repoRoot = tempRoot();
  recordTestTraceStatus({
    repoRoot,
    runId: "run-code",
    projectId: "proj-A",
    traceId: TRACE_RUN,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt: "2026-06-10T01:00:00.000Z",
  });
  const fetchImpl = fetchRouter(
    { "GET /v1/projects": projectsRoute() },
    {
      annotationsByTrace: {
        [TRACE_RUN]: [humanAnnotation({ label: "pass", score: 0.9 }), codeAnnotation()],
      },
    },
  );

  const report = await collectDisagreementReport({
    repoRoot,
    runId: "run-code",
    ensureReady: readyUp,
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(report.disagreements[0].kind, "code_human_failure_mode_conflict");
  assert.deepEqual(report.disagreements[0].code_failure_modes, ["missing_acceptance_criteria"]);
  // CODE binary score (0) is not band-checked: comparison is on failure modes.
  assert.deepEqual(report.band_mismatches, []);
});

test("run mode surfaces judge_invalid and judge_missing receipt attempts as worklist items", async () => {
  for (const judgeState of ["judge_invalid", "judge_missing"]) {
    const repoRoot = tempRoot();
    recordTestTraceStatus({
      repoRoot,
      runId: "run-judge",
      projectId: "proj-A",
      traceId: TRACE_RUN,
      phoenixAppUrl: "http://127.0.0.1:6006",
      status: "trace_exported",
      observedAt: "2026-06-10T01:00:00.000Z",
    });
    const runsDir = path.join(repoRoot, "domains", "support-ops", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, "run-judge.judge.json"), JSON.stringify({
      schema_version: 1,
      run_id: "run-judge",
      attempts: [{
        attempted_at: "2026-06-10T02:00:00.000Z",
        judge_state: judgeState,
        identifier: "decomposition_quality_judge_v1:test-model",
        reason: judgeState === "judge_invalid" ? "non_canonical_label" : "runtime_timeout",
        low_confidence_reasons: [],
      }],
    }));
    const fetchImpl = fetchRouter(
      { "GET /v1/projects": projectsRoute() },
      { annotationsByTrace: { [TRACE_RUN]: [] } },
    );

    const report = await collectDisagreementReport({
      repoRoot,
      runId: "run-judge",
      ensureReady: readyUp,
      fetchImpl,
    });
    assert.equal(report.ok, true);
    const item = report.worklist_items.find((entry) => entry.kind === judgeState);
    assert.ok(item, `${judgeState} must surface as a derived worklist item`);
    assert.equal(item.priority_id, "judge_attention");
    // The failed judge attempt also lands in the PR disclosure shape.
    assert.equal(report.pr_disclosure.judge_attention_count, 1);
    assert.equal(report.pr_disclosure.proceeds_despite_disagreement_requires_rationale, true);
  }
});

test("disagreement report fails closed on missing/ambiguous input selection and missing trace receipt", async () => {
  const repoRoot = tempRoot();
  const none = await collectDisagreementReport({ repoRoot, ensureReady: readyUp });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "invalid_input_selection");
  const both = await collectDisagreementReport({
    repoRoot,
    runId: "run-x",
    experimentRef: "expr-x",
    ensureReady: readyUp,
  });
  assert.equal(both.ok, false);
  assert.equal(both.reason, "invalid_input_selection");
  const missing = await collectDisagreementReport({
    repoRoot,
    runId: "run-without-receipt",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({}),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_trace_receipt");

  const legacyPaths = traceTelemetryPaths(repoRoot);
  fs.mkdirSync(legacyPaths.runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyPaths.runsDir, "run-legacy.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: "run-legacy",
      trace_id: "55555555555555555555555555555555",
      trace_status: "trace_exported",
    }, null, 2)}\n`,
  );
  const legacy = await collectDisagreementReport({
    repoRoot,
    runId: "run-legacy",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({}),
  });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.status, "not_run");
  assert.equal(legacy.reason, "trace_receipt_schema_legacy");
  assert.equal(legacy.repairable, true);
  assert.match(legacy.detail, /re-run the source workflow/);
});

// ---------------------------------------------------------------------------
// Experiment mode.
// ---------------------------------------------------------------------------

function exampleRecord({ id, split = "train", sourceTraceId = null, humanAnnotationIds = [] }) {
  return {
    id,
    input: {},
    output: {},
    metadata: {
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: "active",
      dataset_split: split,
      process_version: PROCESS_VERSION,
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
      source_trace_id: sourceTraceId,
      source_run_id: `source_${id}`,
      content_retention: "sanitized_fixture",
      reference: {
        human_annotations: [],
        ...(humanAnnotationIds.length > 0 ? { human_annotation_ids: humanAnnotationIds } : {}),
      },
    },
  };
}

function experimentRow({ exampleId, judge = null, judgeError = null, code = null, traceId = null }) {
  const annotations = [];
  if (judge) {
    annotations.push({
      name: "quality",
      annotator_kind: "LLM",
      label: judge.label,
      score: judge.score,
      explanation: judge.explanation ?? "judged in experiment",
      trace_id: traceId,
      error: null,
      metadata: {
        identifier: "decomposition_quality_judge_v1:test-model",
        failure_modes: judge.failureModes ?? [],
      },
    });
  }
  if (judgeError) {
    annotations.push({
      name: "quality",
      annotator_kind: "LLM",
      label: null,
      score: null,
      explanation: null,
      trace_id: traceId,
      error: judgeError,
      metadata: { identifier: "decomposition_quality_judge_v1:test-model" },
    });
  }
  if (code) {
    annotations.push({
      name: "accepted_packet_sufficiency",
      annotator_kind: "CODE",
      label: code.label,
      score: code.score,
      explanation: "structural check",
      trace_id: traceId,
      error: null,
      metadata: {
        identifier: "accepted_packet_sufficiency_offline_v1",
        failure_modes: code.failureModes ?? [],
      },
    });
  }
  return {
    example_id: exampleId,
    repetition_number: 1,
    input: {},
    reference_output: {},
    output: { status: "evaluated" },
    error: null,
    latency_ms: 12,
    start_time: "2026-06-10T01:00:00.000Z",
    end_time: "2026-06-10T01:00:01.000Z",
    trace_id: traceId,
    annotations,
  };
}

test("experiment mode compares human/LLM/CODE per example through verified GETs and surfaces judge evaluation errors", async () => {
  const repoRoot = tempRoot();
  const records = [
    exampleRecord({ id: "EX-CONFLICT", split: "test", sourceTraceId: TRACE_SRC, humanAnnotationIds: ["anno-h1"] }),
    exampleRecord({ id: "EX-JUDGEFAIL", split: "train" }),
  ];
  const rows = [
    experimentRow({
      exampleId: "EX-CONFLICT",
      judge: { label: "needs_revision", score: 0.55, failureModes: ["prose_dependency_instead_of_relation"] },
      code: { label: "pass", score: 1, failureModes: [] },
      traceId: "c".repeat(32),
    }),
    experimentRow({ exampleId: "EX-JUDGEFAIL", judgeError: "judge_invalid:non_canonical_label" }),
  ];
  const fetchImpl = fetchRouter(
    {
      "GET /v1/experiments/EXP1": jsonResponse({
        data: { id: "EXP1", dataset_id: "DS1", dataset_version_id: "DSV9", project_name: "teami", metadata: {} },
      }),
      "GET /v1/experiments/EXP1/json": jsonResponse(rows),
      "GET /v1/datasets/DS1/examples": jsonResponse({ data: { examples: records } }),
      "GET /v1/projects": projectsRoute(),
    },
    { annotationsByTrace: { [TRACE_SRC]: [humanAnnotation({ label: "pass", score: 0.92 })] } },
  );

  const report = await collectDisagreementReport({
    repoRoot,
    experimentRef: "EXP1",
    ensureReady: readyUp,
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, "experiment");
  assert.equal(report.phoenix_experiment_id, "EXP1");
  assert.equal(report.receipt_id, null, "no managed receipt: discovered evidence, reported only");

  // Human (source trace) vs candidate LLM label conflict, via the SAME
  // detector the worklist uses.
  assert.deepEqual(
    report.disagreements.map((item) => [item.example_id, item.kind]),
    [["EX-CONFLICT", "human_llm_label_conflict"]],
  );
  // Step 8 summary parity: detectSignalDisagreements over the same labels.
  assert.deepEqual(report.signal_summary, [
    { example_id: "EX-CONFLICT", signals: { human: "pass", llm: "needs_revision", code: "pass" } },
  ]);
  // judge_invalid evaluation error rows become derived worklist items.
  const judgeItem = report.worklist_items.find((item) => item.kind === "judge_invalid");
  assert.ok(judgeItem);
  assert.equal(judgeItem.priority_id, "judge_attention");
  assert.equal(judgeItem.ref, "EX-JUDGEFAIL");

  // Raw records preserved on both sides of the comparison.
  const entry = report.per_example.find((item) => item.example_id === "EX-CONFLICT");
  assert.equal(entry.humans[0].score, 0.92);
  assert.equal(entry.humans[0].annotation_id, "anno-h1");
  assert.equal(entry.llms[0].score, 0.55);
  assert.deepEqual(entry.llms[0].metadata.failure_modes, ["prose_dependency_instead_of_relation"]);
  assert.equal(entry.evaluations_raw.length, 2);
  assert.ok(entry.deep_links.source_trace.includes(TRACE_SRC));

  // GET-only by construction: derived report, no Phoenix writes.
  for (const call of fetchImpl.calls) {
    assert.ok(call.method === null || call.method === "GET", `non-GET request observed: ${call.pathname}`);
    assert.equal(call.body, null);
  }

  const lines = formatDisagreementReport(report);
  assert.ok(lines.some((line) => line.includes("DISAGREEMENT EX-CONFLICT")));
  assert.ok(lines.some((line) => line.includes("judge error: judge_invalid")));
});

test("human-labeled requires an actually-resolved HUMAN annotation; referenced-but-unread ids are failures (FIX 6)", async () => {
  const repoRoot = tempRoot();
  const records = [
    // References anno-h9 but the source trace returns NO annotations.
    exampleRecord({ id: "EX-PHANTOM", split: "test", sourceTraceId: TRACE_SRC, humanAnnotationIds: ["anno-h9"] }),
    // References anno-h8 but carries no source trace to read it from.
    exampleRecord({ id: "EX-NOTRACE", split: "train", humanAnnotationIds: ["anno-h8"] }),
    // Resolves anno-h1 from its source trace: genuinely human-labeled.
    exampleRecord({ id: "EX-REAL", split: "train", sourceTraceId: TRACE_RUN, humanAnnotationIds: ["anno-h1"] }),
  ];
  const rows = [
    experimentRow({ exampleId: "EX-PHANTOM", judge: { label: "pass", score: 0.9 } }),
    experimentRow({ exampleId: "EX-NOTRACE", judge: { label: "pass", score: 0.9 } }),
    experimentRow({ exampleId: "EX-REAL", judge: { label: "pass", score: 0.9 } }),
  ];
  const fetchImpl = fetchRouter(
    {
      "GET /v1/experiments/EXP1": jsonResponse({
        data: { id: "EXP1", dataset_id: "DS1", dataset_version_id: "DSV9", project_name: "teami", metadata: {} },
      }),
      "GET /v1/experiments/EXP1/json": jsonResponse(rows),
      "GET /v1/datasets/DS1/examples": jsonResponse({ data: { examples: records } }),
      "GET /v1/projects": projectsRoute(),
    },
    // TRACE_SRC deliberately returns nothing; TRACE_RUN resolves anno-h1.
    { annotationsByTrace: { [TRACE_RUN]: [humanAnnotation({ label: "pass", score: 0.9, id: "anno-h1" })] } },
  );
  const report = await collectDisagreementReport({
    repoRoot,
    experimentRef: "EXP1",
    ensureReady: readyUp,
    fetchImpl,
  });
  assert.equal(report.ok, true);

  const phantom = report.per_example.find((entry) => entry.example_id === "EX-PHANTOM");
  const noTrace = report.per_example.find((entry) => entry.example_id === "EX-NOTRACE");
  const real = report.per_example.find((entry) => entry.example_id === "EX-REAL");
  assert.equal(phantom.human_labeled, false, "a metadata reference alone is never human-labeled");
  assert.equal(noTrace.human_labeled, false);
  assert.equal(real.human_labeled, true, "a resolved HUMAN annotation counts");

  // Referenced-but-unresolved ids are listed as failures with their reasons.
  assert.deepEqual(
    report.human_annotation_failures
      .map((failure) => [failure.example_id, failure.reason, failure.missing_annotation_ids])
      .sort(),
    [
      ["EX-NOTRACE", "referenced_human_annotation_ids_without_source_trace", ["anno-h8"]],
      ["EX-PHANTOM", "referenced_human_annotation_ids_unresolved", ["anno-h9"]],
    ],
  );
  // Disagreements were NOT fully checked: never "none observed".
  assert.equal(report.checked, false);
  assert.equal(report.pr_disclosure.checked, false);
  assert.equal(report.pr_disclosure.none_observed_statement, null);
  const lines = formatDisagreementReport(report);
  assert.ok(lines.some((line) => line.includes("human annotations unreadable for 2 example(s)")));
});
