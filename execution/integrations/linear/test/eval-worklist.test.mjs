import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BANNED_WORKFLOW_STATE_METADATA_KEYS,
  DEFAULT_ANNOTATION_NAME,
  FAILURE_TAXONOMY_VERSION,
  QUALITY_DIMENSION_NAMES,
  RUBRIC_VERSION,
} from "../src/eval-annotation-contract.mjs";
import {
  collectEvalStatuses,
  deriveRunEvalStatus,
  detectLowConfidenceReasons,
  formatEvalStatusReport,
  formatWorklistReport,
  rankEvalWorklist,
} from "../src/eval-status.mjs";
import {
  buildTraceAnnotationPayload,
  createPhoenixTraceAnnotation,
  resolveAnnotationIdentifier,
} from "../src/phoenix-self-improvement.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";

const TRACE_IDS = {
  low1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
  low2: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02",
  bhuman: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03",
  risk: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04",
  calib: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05",
  disagree: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa06",
  judge: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa07",
  fresh: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa08",
};
const TRACE_IDENTITY = Object.freeze({
  teamRef: "support-ops",
  workspaceId: "workspace-1",
  teamId: "team-1",
});

function makeRepoRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.TEAMI_HOME = root;
  return root;
}

function writeReceipt(repoRoot, { runId, traceId, projectId, observedAt }) {
  recordTraceStatus({
    ...TRACE_IDENTITY,
    repoRoot,
    runId,
    projectId,
    traceId,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt,
  });
}

function writeRunArtifactFile(repoRoot, { runId, kind = "commit", phasePackets = [] }) {
  const runsDir = path.join(repoRoot, "teams", TRACE_IDENTITY.teamRef, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    schema_version: "linear-decomposition-run-artifact/v1",
    workflow_version: "0.2.0",
    kind,
    run_id: runId,
    team_ref: TRACE_IDENTITY.teamRef,
    workspace_id: TRACE_IDENTITY.workspaceId,
    team_id: TRACE_IDENTITY.teamId,
    phase_packets: phasePackets,
    runtime_assignments: {},
    runtime_metadata: {},
  }, null, 2));
}

function annotationEntry({
  name = DEFAULT_ANNOTATION_NAME,
  kind,
  identifier,
  label,
  score,
  explanation = "because the rubric says so",
  failureModes = [],
}) {
  return {
    id: `anno-${identifier}-${name}`,
    name,
    annotator_kind: kind,
    identifier,
    result: { label, score, explanation },
    metadata: {
      failure_modes: failureModes,
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    },
  };
}

// Fake Phoenix that answers exactly the verified read paths the worklist uses.
function createPhoenixReadMock({ annotationsByTrace = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? null, body: init.body ?? null });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/projects") {
      return new Response(JSON.stringify({
        data: [{ id: "UHJvamVjdDox", name: "teami" }],
      }), { status: 200 });
    }
    if (/^\/v1\/projects\/[^/]+\/trace_annotations$/.test(parsed.pathname)) {
      const traceId = parsed.searchParams.get("trace_ids");
      return new Response(JSON.stringify({
        data: annotationsByTrace[traceId] || [],
        next_cursor: null,
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}

test("trace annotation payload requires non-empty identifier and canonical name/label/kind", () => {
  const valid = {
    traceId: "11111111111111111111111111111111",
    label: "pass",
    score: 0.92,
    explanation: "issues are independently executable",
    identifier: "steve",
  };
  const payload = buildTraceAnnotationPayload(valid);
  assert.equal(payload.data[0].name, "quality");
  assert.equal(payload.data[0].identifier, "steve");
  assert.equal(payload.data[0].annotator_kind, "HUMAN");
  // The contract metadata is stamped from the repo-owned artifacts.
  assert.equal(payload.data[0].metadata.rubric_version, RUBRIC_VERSION);
  assert.equal(payload.data[0].metadata.failure_taxonomy_version, FAILURE_TAXONOMY_VERSION);
  assert.equal(payload.data[0].metadata.workspace_maturity, "new");
  assert.deepEqual(payload.data[0].metadata.failure_modes, []);

  // Identifier is required and non-empty: Phoenix upserts by
  // (name, target, identifier) and defaults it to "".
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, identifier: undefined }), /identifier is required/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, identifier: "" }), /identifier is required/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, identifier: "   " }), /identifier is required/);

  // Canonical label set and rubric dimension names; the legacy free-form
  // name/label combinations are rejected at the write path.
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, label: "useful" }), /label must be one of/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, name: "teami_quality" }), /not canonical/);
  for (const dimension of QUALITY_DIMENSION_NAMES) {
    assert.doesNotThrow(() => buildTraceAnnotationPayload({ ...valid, name: dimension }));
  }
  // Deterministic-check names are CODE storage only, never HUMAN/LLM.
  assert.throws(
    () => buildTraceAnnotationPayload({ ...valid, name: "accepted_packet_sufficiency" }),
    /not canonical/,
  );
  assert.doesNotThrow(() => buildTraceAnnotationPayload({
    ...valid,
    name: "accepted_packet_sufficiency",
    annotatorKind: "CODE",
    identifier: "accepted_packet_sufficiency_offline_v1",
  }));
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, annotatorKind: "MODEL" }), /annotator_kind/);

  // Wire quality results require label, score, AND explanation.
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, score: null }), /score is required/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, score: 1.2 }), /score is required/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, explanation: "  " }), /explanation is required/);
  assert.throws(() => buildTraceAnnotationPayload({ ...valid, workspaceMaturity: "expert" }), /workspace_maturity/);
});

test("banned workflow-state metadata keys are rejected at the annotation write path", () => {
  const valid = {
    traceId: "11111111111111111111111111111111",
    label: "pass",
    score: 0.9,
    explanation: "fine",
    identifier: "steve",
  };
  // The denylist is imported from the shared contract module (derived from
  // annotation.schema.json), not duplicated here.
  assert.ok(BANNED_WORKFLOW_STATE_METADATA_KEYS.length >= 9);
  for (const bannedKey of BANNED_WORKFLOW_STATE_METADATA_KEYS) {
    assert.throws(
      () => buildTraceAnnotationPayload({ ...valid, metadata: { [bannedKey]: true } }),
      new RegExp(`workflow_state_keys:.*${bannedKey}`),
      `metadata key "${bannedKey}" must be rejected at the write path`,
    );
  }
  // Benign extensibility stays open.
  assert.doesNotThrow(() => buildTraceAnnotationPayload({
    ...valid,
    metadata: { benign_metric_count: 3 },
  }));
});

test("annotation identifier resolution: explicit flag, then local config, then OS username (HUMAN only)", () => {
  const config = { evals: { human_annotator_identifier: "configured-id" } };
  assert.deepEqual(
    resolveAnnotationIdentifier({ identifier: "flag-id", config, osUserName: () => "os-user" }),
    { identifier: "flag-id", source: "explicit" },
  );
  assert.deepEqual(
    resolveAnnotationIdentifier({ config, osUserName: () => "os-user" }),
    { identifier: "configured-id", source: "local_config" },
  );
  assert.deepEqual(
    resolveAnnotationIdentifier({ config: {}, osUserName: () => "os-user" }),
    { identifier: "os-user", source: "os_username" },
  );
  assert.throws(
    () => resolveAnnotationIdentifier({ config: {}, osUserName: () => "" }),
    /pass --identifier/,
  );
  // LLM/CODE identifiers (judge id / evaluator id) have no safe default.
  assert.throws(
    () => resolveAnnotationIdentifier({ annotatorKind: "LLM", config, osUserName: () => "os-user" }),
    /judge id for LLM/,
  );
  assert.throws(
    () => resolveAnnotationIdentifier({ annotatorKind: "CODE", config, osUserName: () => "os-user" }),
    /evaluator id for CODE/,
  );
  assert.deepEqual(
    resolveAnnotationIdentifier({ annotatorKind: "LLM", identifier: "decomposition_quality_judge_v1" }),
    { identifier: "decomposition_quality_judge_v1", source: "explicit" },
  );
});

test("distinct identifiers coexist; same (name, target, identifier) upserts", async () => {
  // Mirrors the pinned Phoenix upsert semantics: unique by
  // (name, target, identifier), so different identifiers never overwrite.
  const store = new Map();
  const fetchImpl = async (url, init = {}) => {
    assert.match(String(url), /\/v1\/trace_annotations\?sync=true$/);
    const body = JSON.parse(init.body);
    const data = body.data.map((entry) => {
      const key = `${entry.name}|${entry.trace_id}|${entry.identifier}`;
      store.set(key, entry);
      return { id: `anno:${key}` };
    });
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const repoRoot = makeRepoRoot("teami-anno-upsert-");
  const base = {
    repoRoot,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl,
    traceId: "11111111111111111111111111111111",
  };

  await createPhoenixTraceAnnotation({
    ...base, label: "pass", score: 0.9, explanation: "human pass", identifier: "steve",
  });
  await createPhoenixTraceAnnotation({
    ...base,
    label: "needs_revision",
    score: 0.55,
    explanation: "judge dissent",
    annotatorKind: "LLM",
    identifier: "decomposition_quality_judge_v1",
    metadata: { failure_modes: ["prose_dependency_instead_of_relation"] },
  });
  assert.equal(store.size, 2, "different identifiers on the same (name, target) must coexist");

  await createPhoenixTraceAnnotation({
    ...base, label: "needs_revision", score: 0.6, explanation: "human revised view", identifier: "steve",
  });
  assert.equal(store.size, 2, "same (name, target, identifier) must update in place, not duplicate");
  assert.equal(
    store.get("quality|11111111111111111111111111111111|steve").result.label,
    "needs_revision",
  );
  assert.equal(
    store.get("quality|11111111111111111111111111111111|decomposition_quality_judge_v1").result.label,
    "needs_revision",
  );
});

test("derived statuses: none, human-only, agreement, label conflict, code-vs-human failure modes", () => {
  const human = (overrides = {}) => ({
    name: DEFAULT_ANNOTATION_NAME,
    annotator_kind: "HUMAN",
    identifier: "steve",
    label: "pass",
    score: 0.9,
    explanation: "good",
    metadata: { failure_modes: [] },
    ...overrides,
  });
  const llm = (overrides = {}) => ({
    name: DEFAULT_ANNOTATION_NAME,
    annotator_kind: "LLM",
    identifier: "decomposition_quality_judge_v1",
    label: "pass",
    score: 0.9,
    explanation: "rubric satisfied",
    metadata: { failure_modes: [] },
    ...overrides,
  });
  const code = (overrides = {}) => ({
    name: DEFAULT_ANNOTATION_NAME,
    annotator_kind: "CODE",
    identifier: "decomposition_quality_offline_v1",
    label: "needs_revision",
    score: 0,
    explanation: "structural gaps",
    metadata: { failure_modes: ["missing_acceptance_criteria"] },
    ...overrides,
  });

  // No annotations at all -> needs_human.
  const none = deriveRunEvalStatus({ annotations: [] });
  assert.equal(none.derived_status, "needs_human");
  assert.deepEqual(
    [none.has_human, none.has_llm, none.has_code, none.judge_missing],
    [false, false, false, false],
  );

  // Human only -> has_human, nothing open.
  const humanOnly = deriveRunEvalStatus({ annotations: [human()] });
  assert.equal(humanOnly.derived_status, "has_human");
  assert.deepEqual(humanOnly.disagreements, []);
  assert.equal(humanOnly.judge_missing, false, "a judge that never ran is not 'missing judge output'");

  // Human + LLM agree -> has_human, no disagreement.
  const agree = deriveRunEvalStatus({ annotations: [human(), llm()] });
  assert.equal(agree.derived_status, "has_human");
  assert.deepEqual(agree.disagreements, []);

  // Human vs LLM label conflict -> disagreement_open.
  const conflict = deriveRunEvalStatus({
    annotations: [human(), llm({ label: "needs_revision", score: 0.55, metadata: { failure_modes: ["prose_dependency_instead_of_relation"] } })],
  });
  assert.equal(conflict.derived_status, "disagreement_open");
  assert.equal(conflict.disagreements[0].kind, "human_llm_label_conflict");

  // CODE vs human: compare primarily on failure modes. Human pass with no
  // acknowledgment of the structural failure modes -> disagreement_open.
  const codeConflict = deriveRunEvalStatus({ annotations: [human(), code()] });
  assert.equal(codeConflict.derived_status, "disagreement_open");
  assert.equal(codeConflict.disagreements[0].kind, "code_human_failure_mode_conflict");
  assert.deepEqual(codeConflict.disagreements[0].code_failure_modes, ["missing_acceptance_criteria"]);

  // Human already acknowledges the failure mode -> no disagreement.
  const acknowledged = deriveRunEvalStatus({
    annotations: [
      human({ label: "needs_revision", score: 0.6, metadata: { failure_modes: ["missing_acceptance_criteria"] } }),
      code(),
    ],
  });
  assert.equal(acknowledged.derived_status, "has_human");
  assert.deepEqual(acknowledged.disagreements, []);

  // CODE present without a judge -> judge output is missing.
  const judgeMissing = deriveRunEvalStatus({ annotations: [code()] });
  assert.equal(judgeMissing.judge_missing, true);
  assert.equal(judgeMissing.derived_status, "needs_human");
});

test("low-confidence judge heuristics are deterministic and cheap", () => {
  const judge = (overrides = {}) => ({
    name: DEFAULT_ANNOTATION_NAME,
    annotator_kind: "LLM",
    identifier: "decomposition_quality_judge_v1",
    label: "pass",
    score: 0.9,
    explanation: "rubric satisfied",
    metadata: { failure_modes: [] },
    ...overrides,
  });
  assert.deepEqual(detectLowConfidenceReasons({ annotation: judge() }), []);
  assert.ok(detectLowConfidenceReasons({ annotation: judge({ label: "excellent" }) })
    .includes("judge_output_malformed"));
  assert.ok(detectLowConfidenceReasons({ annotation: judge({ score: 1.5 }) })
    .includes("judge_output_malformed"));
  assert.ok(detectLowConfidenceReasons({ annotation: judge({ score: 0.5 }) })
    .includes("label_score_band_mismatch"));
  assert.ok(detectLowConfidenceReasons({ annotation: judge({ score: 0.81 }) })
    .includes("score_at_band_boundary"));
  assert.ok(detectLowConfidenceReasons({ annotation: judge({ explanation: "  " }) })
    .includes("missing_explanation"));
  assert.ok(detectLowConfidenceReasons({
    annotation: judge({ label: "needs_revision", score: 0.5, metadata: { failure_modes: [] } }),
  }).includes("missing_failure_modes"));
  assert.ok(detectLowConfidenceReasons({
    annotation: judge(),
    codeAnnotations: [{ metadata: { failure_modes: ["missing_acceptance_criteria"] } }],
  }).includes("judge_code_failure_mode_conflict"));
  assert.ok(detectLowConfidenceReasons({
    annotation: judge(),
    humanAnnotations: [{ name: DEFAULT_ANNOTATION_NAME, label: "needs_revision" }],
  }).includes("judge_human_label_conflict"));
});

test("worklist ranking matches the plan's priority order across fixture classes", async () => {
  const repoRoot = makeRepoRoot("teami-worklist-rank-");
  // Priority 1: repeated area (proj-A) with zero human grounding.
  writeReceipt(repoRoot, { runId: "run-low1", traceId: TRACE_IDS.low1, projectId: "proj-A", observedAt: "2026-06-09T01:00:00.000Z" });
  writeReceipt(repoRoot, { runId: "run-low2", traceId: TRACE_IDS.low2, projectId: "proj-A", observedAt: "2026-06-09T02:00:00.000Z" });
  // proj-B is human-grounded by run-bhuman (settled, off the worklist).
  writeReceipt(repoRoot, { runId: "run-bhuman", traceId: TRACE_IDS.bhuman, projectId: "proj-B", observedAt: "2026-06-09T03:00:00.000Z" });
  // Priority 2: high-risk paused run (open product/scope questions).
  writeReceipt(repoRoot, { runId: "run-risk", traceId: TRACE_IDS.risk, projectId: "proj-B", observedAt: "2026-06-09T04:00:00.000Z" });
  writeRunArtifactFile(repoRoot, {
    runId: "run-risk",
    kind: "pause",
    phasePackets: [{ phase: "pm_product_sufficiency", status: "pause", open_questions_markdown: "- pricing?" }],
  });
  // Priority 6: passing example for judge calibration (also in proj-B).
  writeReceipt(repoRoot, { runId: "run-calib", traceId: TRACE_IDS.calib, projectId: "proj-B", observedAt: "2026-06-09T05:00:00.000Z" });
  // Priority 3: human/model disagreement.
  writeReceipt(repoRoot, { runId: "run-disagree", traceId: TRACE_IDS.disagree, projectId: "proj-C", observedAt: "2026-06-09T06:00:00.000Z" });
  // Priority 4: low-confidence judge output (band mismatch) without disagreement.
  writeReceipt(repoRoot, { runId: "run-judge", traceId: TRACE_IDS.judge, projectId: "proj-D", observedAt: "2026-06-09T07:00:00.000Z" });
  // Priority 5: brand-new project area, first run of its kind.
  writeReceipt(repoRoot, { runId: "run-new", traceId: TRACE_IDS.fresh, projectId: "proj-E", observedAt: "2026-06-09T08:00:00.000Z" });

  const { fetchImpl, calls } = createPhoenixReadMock({
    annotationsByTrace: {
      [TRACE_IDS.bhuman]: [
        annotationEntry({ kind: "HUMAN", identifier: "steve", label: "pass", score: 0.9 }),
      ],
      [TRACE_IDS.calib]: [
        annotationEntry({ kind: "LLM", identifier: "decomposition_quality_judge_v1", label: "pass", score: 0.92 }),
        annotationEntry({ kind: "CODE", identifier: "decomposition_quality_offline_v1", label: "pass", score: 1 }),
      ],
      [TRACE_IDS.disagree]: [
        annotationEntry({ kind: "HUMAN", identifier: "steve", label: "pass", score: 0.9 }),
        annotationEntry({
          kind: "LLM",
          identifier: "decomposition_quality_judge_v1",
          label: "needs_revision",
          score: 0.55,
          failureModes: ["prose_dependency_instead_of_relation"],
        }),
      ],
      [TRACE_IDS.judge]: [
        annotationEntry({ kind: "HUMAN", identifier: "steve", label: "pass", score: 0.95 }),
        annotationEntry({ kind: "LLM", identifier: "decomposition_quality_judge_v1", label: "pass", score: 0.79 }),
      ],
    },
  });

  const report = await collectEvalStatuses({ repoRoot, fetchImpl });
  assert.equal(report.phoenix.ok, true);
  const items = rankEvalWorklist(report);

  // Settled human-annotated run never appears as a judgment target.
  assert.ok(!items.some((item) => item.run_id === "run-bhuman"));
  assert.deepEqual(
    items.map((item) => [item.run_id, item.priority_class, item.priority_id]),
    [
      ["run-low2", 1, "low_human_grounding"],
      ["run-low1", 1, "low_human_grounding"],
      ["run-risk", 2, "high_risk"],
      ["run-disagree", 3, "disagreement_open"],
      ["run-judge", 4, "judge_attention"],
      ["run-new", 5, "new_category"],
      ["run-calib", 6, "calibration_pass_example"],
    ],
    "ranking must follow the plan's priority order (low grounding, high risk, disagreement, judge attention, new category, calibration)",
  );

  // The worklist is read-only: Phoenix sees GETs only (no method override, no
  // bodies, no mutation endpoints).
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.method, null, `unexpected non-GET request: ${call.url}`);
    assert.equal(call.body, null, `unexpected request body: ${call.url}`);
    assert.match(call.url, /\/v1\/projects(\/|\?)/, "only verified read paths may be used");
  }

  // Deep links derive their origin from local config, never caller input.
  assert.equal(
    items[0].phoenix_url,
    `http://127.0.0.1:6006/projects/UHJvamVjdDox/traces/${TRACE_IDS.low2}`,
  );

  // Nothing durable is persisted: local stores are unchanged after computing.
  const receiptsDir = path.join(repoRoot, "phoenix-data", "telemetry", "runs");
  const artifactsDir = path.join(repoRoot, "teams", TRACE_IDENTITY.teamRef, "runs");
  const before = [fs.readdirSync(receiptsDir).sort(), fs.readdirSync(artifactsDir).sort()];
  const lines = formatWorklistReport({ report, items });
  assert.ok(lines.some((line) => line.includes("never persisted")));
  await collectEvalStatuses({ repoRoot, fetchImpl });
  const after = [fs.readdirSync(receiptsDir).sort(), fs.readdirSync(artifactsDir).sort()];
  assert.deepEqual(after, before);
});

test("worklist degrades gracefully with an explicit notice when Phoenix is unreachable", async () => {
  const repoRoot = makeRepoRoot("teami-worklist-degraded-");
  writeReceipt(repoRoot, { runId: "run-1", traceId: TRACE_IDS.low1, projectId: "proj-A", observedAt: "2026-06-09T01:00:00.000Z" });
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:6006");
  };

  const report = await collectEvalStatuses({ repoRoot, fetchImpl });
  assert.equal(report.phoenix.ok, false);
  assert.match(report.phoenix.notice, /unreachable/);
  assert.match(report.phoenix.notice, /phoenix:start/);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].annotation_visibility, "unknown_phoenix_unreachable");
  assert.equal(report.runs[0].derived_status, "needs_human");
  assert.equal(report.runs[0].has_human, null, "annotation presence is unknown, not false");

  const items = rankEvalWorklist(report);
  assert.equal(items.length, 1);
  const lines = formatWorklistReport({ report, items });
  assert.ok(lines.some((line) => line.startsWith("NOTICE") && /unreachable/.test(line)));
  assert.ok(lines.some((line) => /human=unknown/.test(line)));

  const statusLines = formatEvalStatusReport(report);
  assert.ok(statusLines[0].includes("derived at read time"));
  assert.ok(statusLines.some((line) => line.startsWith("NOTICE")));
});

test("status report covers per-run flags including dataset-membership receipts", async () => {
  const repoRoot = makeRepoRoot("teami-eval-status-");
  writeReceipt(repoRoot, { runId: "run-promoted", traceId: TRACE_IDS.low1, projectId: "proj-A", observedAt: "2026-06-09T01:00:00.000Z" });
  writeRunArtifactFile(repoRoot, { runId: "run-promoted", kind: "commit" });
  const artifactsDir = path.join(repoRoot, "teams", TRACE_IDENTITY.teamRef, "runs");
  // Local dataset-membership receipt (sibling file; read-only input here).
  fs.writeFileSync(path.join(artifactsDir, "run-promoted.promotion.json"), JSON.stringify({
    datasets: [{ name: "teami-decomposition-examples", dataset_id: "RGF0YXNldDox" }],
  }));
  // Preflight receipts are synthetic and never judgment targets.
  writeReceipt(repoRoot, { runId: "phoenix-preflight-1", traceId: TRACE_IDS.low2, projectId: null, observedAt: "2026-06-09T02:00:00.000Z" });

  const { fetchImpl } = createPhoenixReadMock({
    annotationsByTrace: {
      [TRACE_IDS.low1]: [
        annotationEntry({ kind: "HUMAN", identifier: "steve", label: "pass", score: 0.9 }),
      ],
    },
  });
  const report = await collectEvalStatuses({ repoRoot, fetchImpl });
  assert.equal(report.runs.length, 1, "preflight receipts are excluded");
  const run = report.runs[0];
  assert.equal(run.run_id, "run-promoted");
  assert.equal(run.derived_status, "has_human");
  assert.equal(run.promoted_to_dataset, true);
  assert.deepEqual(run.promoted_datasets, ["teami-decomposition-examples"]);

  const lines = formatEvalStatusReport(report);
  assert.ok(lines[0].includes("never persisted to Phoenix"));
  const runLine = lines.find((line) => line.includes("run-promoted"));
  assert.match(runLine, /status=has_human/);
  assert.match(runLine, /human=yes/);
  assert.match(runLine, /model=no/);
  assert.match(runLine, /code=no/);
  assert.match(runLine, /disagreement=no/);
  assert.match(runLine, /promoted=yes/);

  // A settled run produces an empty worklist, reported as such.
  const items = rankEvalWorklist(report);
  assert.deepEqual(items, []);
  const worklistLines = formatWorklistReport({ report, items });
  assert.ok(worklistLines.some((line) => line.includes("Nothing needs your judgment")));
});
