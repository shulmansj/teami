import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FAILURE_TAXONOMY_VERSION,
  RUBRIC_VERSION,
} from "../src/eval-annotation-contract.mjs";
import { PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import {
  computeTestSplitExposureHistory,
  defaultGateReportDir,
  evaluateProcessChangeGate,
  formatProcessChangeGateReport,
  GATE_CONDITION_IDS,
  GATE_REPORT_SCHEMA_VERSION,
  resolveHumanLabelRegressionPolicy,
} from "../src/process-change-gate.mjs";
import { acceptedStateHash } from "../src/promotion-scanner/accepted-baseline.mjs";
import { loadWorkspaceEvalPolicy } from "../src/workspace-eval-policy.mjs";

const repoCheckout = path.resolve(import.meta.dirname, "../../../..");
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(repoCheckout, "execution", "evals", "decomposition", "phoenix-assets.json"),
    "utf8",
  ),
);
const EXPECTED_BASELINE_ID = manifest.prompts[0].accepted_prompt_version_id
  || `sha256:${manifest.prompts[0].snapshot_sha256}`;
const RUNTIME_ROLE_TARGET_KEY = "rule/decomposition/runtime_role_assignments";
const ACCEPTED_RUNTIME_ROLES_PATH = "execution/evals/decomposition/accepted-runtime-roles.json";
const POLICY_SHA256 = createHash("sha256")
  .update(fs.readFileSync(
    path.join(repoCheckout, "execution", "evals", "decomposition", "workspace-eval-policy.json"),
  ))
  .digest("hex");

const T1 = "d".repeat(31) + "1";
const T2 = "d".repeat(31) + "2";
const T3 = "d".repeat(31) + "3";

const readyUp = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "agentic-factory" });

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-gate-"));
}

function writeManifestFixture(root, mutateManifest = () => {}) {
  const draft = JSON.parse(JSON.stringify(manifest));
  mutateManifest(draft);
  const manifestPath = path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  for (const entry of draft.prompts || []) {
    if (!entry.snapshot_path) continue;
    const sourcePath = path.join(repoCheckout, entry.snapshot_path);
    const destinationPath = path.join(root, entry.snapshot_path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
  for (const entry of draft.rules || []) {
    if (!entry.artifact_path) continue;
    const sourcePath = path.join(repoCheckout, entry.artifact_path);
    const destinationPath = path.join(root, entry.artifact_path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
  return draft;
}

function acceptedBaselineIdForTarget(manifestLike, targetKey) {
  if (targetKey === "policy/decomposition/accepted_baseline") {
    return `sha256:${acceptedStateHash(manifestLike)}`;
  }
  if (targetKey.startsWith("rule/")) {
    const entry = (manifestLike.rules || []).find((rule) => rule.target_key === targetKey);
    assert.ok(entry, `missing rule entry for ${targetKey}`);
    return `sha256:${entry.snapshot_sha256}`;
  }
  const entry = (manifestLike.prompts || []).find((prompt) => prompt.target_key === targetKey);
  assert.ok(entry, `missing prompt entry for ${targetKey}`);
  return entry.accepted_prompt_version_id || `sha256:${entry.snapshot_sha256}`;
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

function humanAnnotation({ label = "pass", score = 0.9, failureModes = [], id = "anno-h1" } = {}) {
  return {
    id,
    name: "decomposition_quality",
    annotator_kind: "HUMAN",
    identifier: "steve",
    result: { label, score, explanation: "human taste judgment" },
    metadata: {
      failure_modes: failureModes,
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    },
  };
}

function exampleRecord({
  id,
  split = "train",
  sourceTraceId = null,
  humanAnnotationIds = [],
  lifecycleState = "active",
  rubricVersion = RUBRIC_VERSION,
  processVersion = PROCESS_VERSION,
  taxonomyVersion = FAILURE_TAXONOMY_VERSION,
}) {
  return {
    id,
    input: {},
    output: {},
    metadata: {
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: lifecycleState,
      dataset_split: split,
      process_version: processVersion,
      rubric_version: rubricVersion,
      failure_taxonomy_version: taxonomyVersion,
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
      name: "decomposition_quality",
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
      name: "decomposition_quality",
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

function baselineRow(exampleId, score) {
  return {
    example_id: exampleId,
    annotations: [{
      name: "decomposition_quality",
      annotator_kind: "LLM",
      label: score >= 0.8 ? "pass" : "needs_revision",
      score,
      explanation: "baseline judgment",
      metadata: { identifier: "decomposition_quality_judge_v1:test-model" },
    }],
  };
}

function writeReceiptFixture(root, {
  receiptId = "expr-gate-1",
  experimentId = "EXP1",
  baselineId = EXPECTED_BASELINE_ID,
  candidateTargetKey = "prompt/decomposition/decomposition_quality_judge",
  judgeCandidatePromptVersionId = "PV1",
  splitRequested = null,
  selection = "all_examples",
  origin = "http://127.0.0.1:6006",
  projectName = "agentic-factory",
  launchedAt = "2026-06-10T01:00:00.000Z",
  amendments = [],
} = {}) {
  const dir = path.join(root, ".agentic-factory", "experiments");
  fs.mkdirSync(dir, { recursive: true });
  const receipt = {
    schema_version: "agentic-factory-managed-experiment-receipt/v1",
    receipt_id: receiptId,
    source: "managed_manual",
    created_at: launchedAt,
    launch: {
      intent: "promotion_candidate",
      intent_source: "explicit_flag",
      candidate_target_key: candidateTargetKey,
      launch_baseline: {
        derived_from: "phoenix_assets_manifest",
        manifest_path: "execution/evals/decomposition/phoenix-assets.json",
        manifest_sha256: "0".repeat(64),
        prompt_role: "decomposition_quality_judge",
        accepted_baseline_id: baselineId,
        accepted_dataset_version_ids: {},
      },
      candidate: {
        variant_id: "judge-v2",
        variant_source: "variants_json",
        candidate_version_id: judgeCandidatePromptVersionId || "judge-v2",
        role_overrides: {},
        judge_candidate_prompt_version_id: judgeCandidatePromptVersionId,
      },
      dataset: { name: "eval-ds", dataset_id: "DS1", dataset_version_id: "DSV9" },
      split: { requested: splitRequested, selection, disclosure: null, example_ids: [] },
      evaluators: {
        code: ["accepted_packet_sufficiency_offline_v1"],
        judge: {
          evaluator_id: "decomposition_quality_judge_v1",
          model: "test-model",
          runtime: "claude",
          identifier: "decomposition_quality_judge_v1:test-model",
          prompt_source: "phoenix_candidate_version",
          prompt_version: judgeCandidatePromptVersionId || baselineId,
        },
      },
      promotion_policy: null,
      workspace_eval_policy: {
        schema_version: "agentic-factory-workspace-eval-policy/v1",
        sha256: POLICY_SHA256,
        path: "workspace-eval-policy.json",
      },
      actor: { os_username: "test-user", authenticity: "asserted" },
      launched_at: launchedAt,
      phoenix_scope: { origin, project_name: projectName },
      agentic_factory_run_id: `afexp-${receiptId}`,
    },
    phoenix_experiment_id: experimentId,
    events: [{ type: "launched", at: launchedAt }],
    amendments,
  };
  fs.writeFileSync(path.join(dir, `${receiptId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

// The well-formed pass fixture: one passing example, one captured reusable
// failure, one held-out human-labeled test example; baseline scores improve.
function passFixture() {
  const records = [
    exampleRecord({ id: "EX-OK", split: "train", sourceTraceId: T1, humanAnnotationIds: ["anno-h1"] }),
    exampleRecord({ id: "EX-FAILCAP", split: "train", sourceTraceId: T2, humanAnnotationIds: ["anno-h2"] }),
    exampleRecord({ id: "EX-TEST", split: "test", sourceTraceId: T3, humanAnnotationIds: ["anno-h3"] }),
  ];
  const rows = [
    experimentRow({ exampleId: "EX-OK", judge: { label: "pass", score: 0.9 }, code: { label: "pass", score: 1 }, traceId: "e".repeat(32) }),
    experimentRow({
      exampleId: "EX-FAILCAP",
      judge: { label: "needs_revision", score: 0.55, failureModes: ["missing_acceptance_criteria"] },
      code: { label: "needs_revision", score: 0, failureModes: ["missing_assumptions"] },
    }),
    experimentRow({ exampleId: "EX-TEST", judge: { label: "pass", score: 0.9 }, code: { label: "pass", score: 1 } }),
  ];
  const baselineRows = [baselineRow("EX-OK", 0.8), baselineRow("EX-FAILCAP", 0.4), baselineRow("EX-TEST", 0.88)];
  const annotationsByTrace = {
    [T1]: [humanAnnotation({ label: "pass", score: 0.9, id: "anno-h1" })],
    [T2]: [humanAnnotation({ label: "needs_revision", score: 0.55, failureModes: ["missing_acceptance_criteria"], id: "anno-h2" })],
    [T3]: [humanAnnotation({ label: "pass", score: 0.92, id: "anno-h3" })],
  };
  return { records, rows, baselineRows, annotationsByTrace };
}

function gateRoutes({ records, rows, baselineRows }) {
  return {
    "GET /v1/experiments/EXP1": jsonResponse({
      data: { id: "EXP1", dataset_id: "DS1", dataset_version_id: "DSV9", project_name: "agentic-factory", metadata: {} },
    }),
    "GET /v1/experiments/EXP1/json": jsonResponse(rows),
    "GET /v1/datasets/DS1/examples": jsonResponse({ data: { examples: records } }),
    "GET /v1/projects": jsonResponse({ data: [{ id: "UHJvamVjdDox", name: "agentic-factory" }] }),
    "GET /v1/experiments/BASE1/json": jsonResponse(baselineRows),
    "GET /v1/prompt_versions/PV1": jsonResponse({ data: { id: "PV1" } }),
  };
}

async function runGate({ root, fixture, receiptOverrides = {}, gateOverrides = {} }) {
  writeReceiptFixture(root, receiptOverrides);
  const fetchImpl = fetchRouter(gateRoutes(fixture), { annotationsByTrace: fixture.annotationsByTrace });
  const result = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: receiptOverrides.receiptId || "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: "BASE1" },
    ...gateOverrides,
  });
  return { result, fetchImpl };
}

// ---------------------------------------------------------------------------
// Pass path.
// ---------------------------------------------------------------------------

test("gate passes a well-formed fixture experiment and writes the product-terms report locally, never to Phoenix", async () => {
  const root = tempRoot();
  const { result, fetchImpl } = await runGate({ root, fixture: passFixture() });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.failed_condition_ids, []);
  // Every named gate condition is evaluated exactly once, in plan order.
  assert.deepEqual(result.conditions.map((entry) => entry.id), [...GATE_CONDITION_IDS]);

  // evidence_counts contract block + band-mismatch low-confidence count.
  assert.deepEqual(result.evidence_counts, {
    train_examples: 2,
    train_human_labeled_examples: 2,
    test_examples: 1,
    test_human_labeled_examples: 1,
    human_label_authenticity: "asserted",
    annotations_low_confidence: 0,
  });

  // The gate computes facts, not advisory labels.
  assert.ok(!("evidence_quality" in result));
  assert.ok(!("promotion_risk" in result));
  assert.match(result.evidence_quality_context.note, /controller.*assigns/);
  assert.equal(result.evidence_quality_context.missing_test_split_evidence, false);
  assert.equal(result.evidence_quality_context.workspace_eval_policy_hash_matches_launch, true);
  assert.equal(result.defaults_high_risk, false);
  assert.equal(result.test_split_exposure.disclosure, "machine_local_best_effort");
  assert.equal(result.test_split_exposure.history_complete, false);

  // Product-terms report (plan ~1738-1748).
  assert.ok(result.product_report.behavior_improved[0].includes("decomposition_quality"));
  assert.deepEqual(result.product_report.categories_tested, ["code"]);
  assert.equal(result.product_report.human_decision_load.items_requiring_human_judgment, 0);
  assert.equal(result.product_report.phoenix_assets_evidence.experiment_id, "EXP1");
  assert.equal(result.product_report.phoenix_assets_evidence.baseline_experiment_id, "BASE1");
  assert.deepEqual(
    result.product_report.phoenix_assets_evidence.annotation_ids.sort(),
    ["anno-h1", "anno-h2", "anno-h3"],
  );
  assert.equal(
    result.product_report.repo_artifacts_owning_accepted_behavior.accepted_baseline_id,
    EXPECTED_BASELINE_ID,
  );

  // PR disclosure shape: none observed, stated only after actually checking.
  assert.match(result.pr_disclosure.none_observed_statement, /none observed \(checked 3/);
  assert.equal(result.pr_disclosure.proceeds_despite_disagreement_requires_rationale, false);

  // Local gate-report record: atomic, schema-versioned, gitignored custody.
  assert.ok(result.record_path.startsWith(defaultGateReportDir(root)));
  const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
  assert.equal(record.schema_version, GATE_REPORT_SCHEMA_VERSION);
  assert.equal(record.verdict, "pass");
  assert.ok(!fs.readdirSync(path.dirname(result.record_path)).some((name) => name.endsWith(".tmp")));

  // NEVER written to Phoenix: the gate is GET-only against Phoenix.
  for (const call of fetchImpl.calls) {
    assert.ok(call.method === null || call.method === "GET", `non-GET Phoenix request observed: ${call.pathname}`);
    assert.equal(call.body, null);
  }

  const lines = formatProcessChangeGateReport(result);
  assert.ok(lines[0].includes("PASS"));
  assert.ok(lines.some((line) => line.includes("behavior improved")));
  assert.ok(lines.some((line) => line.includes("never written to Phoenix")));
});

// ---------------------------------------------------------------------------
// Fail-closed paths (CONSTRAINTS #34).
// ---------------------------------------------------------------------------

test("gate fails closed when no receipt evidence exists", async () => {
  const root = tempRoot();
  const result = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: "expr-missing",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "fail");
  assert.equal(result.fail_closed, true);
  assert.equal(result.reason, "experiment_receipt_not_found");
  // Even hard failures leave a local audit record.
  assert.ok(fs.existsSync(result.record_path));
});

test("gate fails closed on a withdrawn receipt and on a missing Phoenix experiment pin", async () => {
  const root = tempRoot();
  writeReceiptFixture(root, {
    receiptId: "expr-withdrawn",
    amendments: [{ action: "withdraw", reason: "superseded", amended_at: "2026-06-10T02:00:00.000Z" }],
  });
  const withdrawn = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: "expr-withdrawn",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({}),
  });
  assert.equal(withdrawn.ok, false);
  assert.equal(withdrawn.reason, "receipt_withdrawn");

  const root2 = tempRoot();
  writeReceiptFixture(root2, { receiptId: "expr-unpinned", experimentId: null });
  const unpinned = await evaluateProcessChangeGate({
    repoRoot: root2,
    receiptId: "expr-unpinned",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({}),
  });
  assert.equal(unpinned.ok, false);
  assert.equal(unpinned.reason, "missing_phoenix_experiment_pin");
  assert.equal(unpinned.verdict, "fail");
});

test("gate fails closed when the experiment produced no annotation evidence", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  fixture.records = fixture.records.map((record) => ({
    ...record,
    metadata: { ...record.metadata, source_trace_id: null, reference: { human_annotations: [] } },
  }));
  fixture.rows = fixture.rows.map((row) => ({ ...row, annotations: [] }));
  fixture.annotationsByTrace = {};
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("evidence_present"));
  assert.ok(result.failed_condition_ids.includes("tied_to_annotation_or_failure_mode"));
});

test("gate fails closed when no regression example captures a reusable failure", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // Every source judgment passes and no example sits in the regression split:
  // nothing in the dataset captures the failure this change claims to fix.
  fixture.annotationsByTrace = {
    [T1]: [humanAnnotation({ label: "pass", score: 0.9, id: "anno-h1" })],
    [T2]: [humanAnnotation({ label: "pass", score: 0.85, id: "anno-h2" })],
    [T3]: [humanAnnotation({ label: "pass", score: 0.92, id: "anno-h3" })],
  };
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("reusable_failure_dataset_example"));
  const conditionEntry = result.conditions.find((entry) => entry.id === "reusable_failure_dataset_example");
  assert.match(conditionEntry.detail, /no regression example/);
});

test("gate fails closed when no human-labeled subset exists for the reusable failure", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // Keep a reusable-failure example via the regression split, but remove all
  // human labels (no annotation ids, no human trace annotations).
  fixture.records = fixture.records.map((record) => ({
    ...record,
    metadata: {
      ...record.metadata,
      dataset_split: record.id === "EX-FAILCAP" ? "regression" : record.metadata.dataset_split,
      source_trace_id: null,
      reference: { human_annotations: [] },
    },
  }));
  fixture.annotationsByTrace = {};
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("human_labeled_subset_present"));
  assert.ok(!result.failed_condition_ids.includes("reusable_failure_dataset_example"));
  const conditionEntry = result.conditions.find((entry) => entry.id === "human_labeled_subset_present");
  assert.match(conditionEntry.detail, /annotate at least one example or defer/);
});

test("gate fails/pauses with product-risk framing when a human-labeled label degrades (D5)", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // Candidate judge degrades the human-labeled test example: pass -> needs_revision.
  fixture.rows = fixture.rows.map((row) =>
    row.example_id === "EX-TEST"
      ? experimentRow({
          exampleId: "EX-TEST",
          judge: { label: "needs_revision", score: 0.55, failureModes: ["missing_acceptance_criteria"] },
          code: { label: "needs_revision", score: 0, failureModes: ["missing_assumptions"] },
        })
      : row);
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("no_human_labeled_regression"));
  const conditionEntry = result.conditions.find((entry) => entry.id === "no_human_labeled_regression");
  assert.match(conditionEntry.detail, /REGRESSES/);
  assert.match(conditionEntry.detail, /reject or pause/);
  assert.deepEqual(conditionEntry.evidence.label_degradations, [{
    example_id: "EX-TEST",
    human_identifier: "steve",
    human_label: "pass",
    judge_label: "needs_revision",
  }]);
  // The degradation is also a human/LLM disagreement, so the PR-bound
  // disclosure demands a controller rationale if the proposal proceeds.
  assert.equal(result.pr_disclosure.proceeds_despite_disagreement_requires_rationale, true);
  assert.ok(result.product_report.product_risk_remaining.some((line) => line.includes("taste regressions")));
});

test("gate fails closed when the mean test-split score drops beyond the policy threshold (D5)", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // Same labels (no label degradation), but the held-out test score drops
  // 0.95 -> 0.85: a 0.10 drop against the 0.05 policy threshold.
  fixture.rows = fixture.rows.map((row) =>
    row.example_id === "EX-TEST"
      ? experimentRow({ exampleId: "EX-TEST", judge: { label: "pass", score: 0.85 }, code: { label: "pass", score: 1 } })
      : row);
  fixture.baselineRows = [baselineRow("EX-OK", 0.8), baselineRow("EX-FAILCAP", 0.4), baselineRow("EX-TEST", 0.95)];
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.failed_condition_ids, ["no_human_labeled_regression"]);
  const conditionEntry = result.conditions.find((entry) => entry.id === "no_human_labeled_regression");
  assert.match(conditionEntry.detail, /beyond the accepted threshold 0.05/);
  assert.ok(Math.abs(conditionEntry.evidence.mean_drop - 0.1) < 1e-9);
});

test("gate fails closed on missing test-split evidence and reports the lowered evidence-quality context", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  fixture.records = fixture.records.map((record) => ({
    ...record,
    metadata: { ...record.metadata, dataset_split: "train" },
  }));
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("test_split_evidence"));
  // Missing test evidence also makes the regression mean clause incomputable:
  // absence is never proof.
  assert.ok(result.failed_condition_ids.includes("no_human_labeled_regression"));
  assert.equal(result.evidence_quality_context.missing_test_split_evidence, true);
  const conditionEntry = result.conditions.find((entry) => entry.id === "test_split_evidence");
  assert.match(conditionEntry.detail, /lowered evidence-quality context/);
});

test("gate fails closed on missing Phoenix pins (unresolvable candidate prompt version)", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  const routes = gateRoutes(fixture);
  routes["GET /v1/prompt_versions/PV1"] = jsonResponse({ detail: "not found" }, 404);
  writeReceiptFixture(root, {});
  const fetchImpl = fetchRouter(routes, { annotationsByTrace: fixture.annotationsByTrace });
  const result = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: "BASE1" },
  });
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.failed_condition_ids, ["phoenix_pins_exact"]);
  const conditionEntry = result.conditions.find((entry) => entry.id === "phoenix_pins_exact");
  assert.match(conditionEntry.detail, /candidate_prompt_version_unresolvable/);
});

test("gate blocks on a stale receipt baseline (manifest owns baseline identity)", async () => {
  const root = tempRoot();
  const { result } = await runGate({
    root,
    fixture: passFixture(),
    receiptOverrides: { baselineId: "sha256:stale-baseline" },
  });
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.failed_condition_ids, ["baseline_identity_current"]);
  const conditionEntry = result.conditions.find((entry) => entry.id === "baseline_identity_current");
  assert.match(conditionEntry.detail, /STALE baseline/);
  assert.equal(conditionEntry.evidence.manifest_baseline_id, EXPECTED_BASELINE_ID);
});

test("gate anchors rule and policy targets to their own accepted artifacts", async () => {
  const ruleRoot = tempRoot();
  const ruleManifest = writeManifestFixture(ruleRoot);
  const ruleBaselineId = acceptedBaselineIdForTarget(ruleManifest, RUNTIME_ROLE_TARGET_KEY);
  writeReceiptFixture(ruleRoot, {
    candidateTargetKey: RUNTIME_ROLE_TARGET_KEY,
    baselineId: ruleBaselineId,
    judgeCandidatePromptVersionId: null,
  });
  const ruleFixture = passFixture();
  const rule = await evaluateProcessChangeGate({
    repoRoot: ruleRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: fetchRouter(gateRoutes(ruleFixture), { annotationsByTrace: ruleFixture.annotationsByTrace }),
    baselineExperimentOverride: { experiment_id: "BASE1" },
  });
  assert.equal(rule.verdict, "pass");
  assert.equal(rule.baseline_context.accepted_baseline_id, ruleBaselineId);
  assert.notEqual(rule.baseline_context.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(
    rule.product_report.repo_artifacts_owning_accepted_behavior.accepted_prompt_snapshot,
    null,
  );
  assert.equal(
    rule.product_report.repo_artifacts_owning_accepted_behavior.accepted_artifact_hash_vector.snapshot_sha256,
    ruleBaselineId.replace(/^sha256:/, ""),
  );

  const policyRoot = tempRoot();
  const policyManifest = writeManifestFixture(policyRoot);
  const policyBaselineId = acceptedBaselineIdForTarget(
    policyManifest,
    "policy/decomposition/accepted_baseline",
  );
  writeReceiptFixture(policyRoot, {
    candidateTargetKey: "policy/decomposition/accepted_baseline",
    baselineId: policyBaselineId,
    judgeCandidatePromptVersionId: null,
  });
  const policyFixture = passFixture();
  const policy = await evaluateProcessChangeGate({
    repoRoot: policyRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: fetchRouter(gateRoutes(policyFixture), { annotationsByTrace: policyFixture.annotationsByTrace }),
    baselineExperimentOverride: { experiment_id: "BASE1" },
  });
  assert.equal(policy.verdict, "pass");
  assert.equal(policy.baseline_context.accepted_baseline_id, policyBaselineId);
  assert.notEqual(policy.baseline_context.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(
    policy.product_report.repo_artifacts_owning_accepted_behavior.accepted_prompt_snapshot,
    null,
  );
  assert.equal(
    policy.product_report.repo_artifacts_owning_accepted_behavior.accepted_artifact_hash_vector.accepted_state_sha256,
    policyBaselineId.replace(/^sha256:/, ""),
  );
});

test("gate reports an actionable missing-baseline bootstrap path for a rule target with no target-keyed baseline row", async () => {
  const root = tempRoot();
  const ruleManifest = writeManifestFixture(root);
  const ruleBaselineId = acceptedBaselineIdForTarget(ruleManifest, RUNTIME_ROLE_TARGET_KEY);
  writeReceiptFixture(root, {
    candidateTargetKey: RUNTIME_ROLE_TARGET_KEY,
    baselineId: ruleBaselineId,
    judgeCandidatePromptVersionId: null,
  });
  const fixture = passFixture();
  const result = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: fetchRouter(gateRoutes(fixture), { annotationsByTrace: fixture.annotationsByTrace }),
  });
  const expectedDetail = `no accepted baseline experiment is pinned for ${RUNTIME_ROLE_TARGET_KEY}; run a baseline experiment for this target and accept it into phoenix-assets.json experiments before promoting against it.`;
  assert.equal(result.verdict, "fail");
  const conditionEntry = result.conditions.find((entry) => entry.id === "improves_target_scores");
  assert.equal(conditionEntry.evidence.reason, "accepted_baseline_experiment_missing");
  assert.equal(conditionEntry.detail, expectedDetail);
  assert.equal(conditionEntry.evidence.detail, expectedDetail);
});

test("per-target baseline matrix: missing pin, stale vector, legacy judge disclosure, wrong-target legacy, and explicit cross-version acceptance", async () => {
  const phaseTargetKey = "prompt/decomposition/pm_product_sufficiency_pass";

  // A phase target cannot reuse the legacy unkeyed judge baseline pin.
  const missingRoot = tempRoot();
  const missingManifest = writeManifestFixture(missingRoot);
  writeReceiptFixture(missingRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: acceptedBaselineIdForTarget(missingManifest, phaseTargetKey),
  });
  const missingFixture = passFixture();
  const missingFetch = fetchRouter(gateRoutes(missingFixture), { annotationsByTrace: missingFixture.annotationsByTrace });
  const missing = await evaluateProcessChangeGate({
    repoRoot: missingRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: missingFetch,
  });
  assert.equal(missing.verdict, "fail");
  const missingCondition = missing.conditions.find((entry) => entry.id === "improves_target_scores");
  assert.equal(missingCondition.evidence.reason, "accepted_baseline_experiment_missing");
  assert.equal(
    missingCondition.evidence.detail,
    `no accepted baseline experiment is pinned for ${phaseTargetKey}; run a baseline experiment for this target and accept it into phoenix-assets.json experiments before promoting against it.`,
  );
  assert.equal(missing.product_report.phoenix_assets_evidence.baseline_experiment_id, null);

  // A target-keyed baseline with a stale accepted artifact hash vector blocks.
  const staleRoot = tempRoot();
  const staleManifest = writeManifestFixture(staleRoot, (draft) => {
    draft.experiments = [{
      purpose: "baseline",
      candidate_target_key: phaseTargetKey,
      accepted_artifact_hash_vector: {
        snapshot_sha256: "0".repeat(64),
        accepted_prompt_version_id: null,
      },
      experiment_id: "BASE1",
      dataset_id: "DS1",
      dataset_version_id: "DSV9",
    }];
  });
  writeReceiptFixture(staleRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: acceptedBaselineIdForTarget(staleManifest, phaseTargetKey),
  });
  const staleFixture = passFixture();
  const staleFetch = fetchRouter(gateRoutes(staleFixture), { annotationsByTrace: staleFixture.annotationsByTrace });
  const stale = await evaluateProcessChangeGate({
    repoRoot: staleRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: staleFetch,
  });
  assert.equal(stale.verdict, "fail");
  const staleCondition = stale.conditions.find((entry) => entry.id === "improves_target_scores");
  assert.equal(staleCondition.evidence.reason, "baseline_stale_for_accepted_artifact");
  assert.match(staleCondition.detail, /baseline_stale_for_accepted_artifact/);

  // The legacy unkeyed, no-vector baseline still counts for the judge target,
  // but the gate context discloses that the hash vector was not verified.
  const legacyRoot = tempRoot();
  writeManifestFixture(legacyRoot, (draft) => {
    draft.experiments = [{
      purpose: "baseline",
      experiment_id: "BASE1",
      dataset_id: "DS1",
      dataset_version_id: "DSV9",
    }];
  });
  writeReceiptFixture(legacyRoot, {});
  const legacyFixture = passFixture();
  const legacyFetch = fetchRouter(gateRoutes(legacyFixture), { annotationsByTrace: legacyFixture.annotationsByTrace });
  const legacy = await evaluateProcessChangeGate({
    repoRoot: legacyRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: legacyFetch,
  });
  assert.equal(legacy.verdict, "pass");
  assert.equal(legacy.baseline_context.baseline_hash_vector_unverified, true);
  assert.equal(legacy.product_report.phoenix_assets_evidence.baseline_hash_vector_unverified, true);

  // With explicit cross-version acceptance, a stale baseline vector can be
  // compared and is disclosed as accepted.
  const acceptedRoot = tempRoot();
  const acceptedManifest = writeManifestFixture(acceptedRoot, (draft) => {
    draft.experiments = [{
      purpose: "baseline",
      candidate_target_key: phaseTargetKey,
      accepted_artifact_hash_vector: {
        snapshot_sha256: "1".repeat(64),
        accepted_prompt_version_id: null,
      },
      experiment_id: "BASE1",
      dataset_id: "DS1",
      dataset_version_id: "DSV9",
    }];
  });
  writeReceiptFixture(acceptedRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: acceptedBaselineIdForTarget(acceptedManifest, phaseTargetKey),
  });
  const acceptedFixture = passFixture();
  const acceptedFetch = fetchRouter(gateRoutes(acceptedFixture), { annotationsByTrace: acceptedFixture.annotationsByTrace });
  const accepted = await evaluateProcessChangeGate({
    repoRoot: acceptedRoot,
    receiptId: "expr-gate-1",
    ensureReady: readyUp,
    fetchImpl: acceptedFetch,
    acceptCrossVersion: true,
  });
  assert.equal(accepted.verdict, "pass");
  assert.equal(accepted.baseline_context.baseline_cross_version_accepted, true);
  const acceptedCondition = accepted.conditions.find((entry) => entry.id === "improves_target_scores");
  assert.equal(acceptedCondition.evidence.baseline_cross_version_accepted, true);
});

test("referenced-but-unreadable human annotations fail the gate closed as human_annotations_unresolvable (FIX 6)", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // EX-TEST's metadata references anno-h3, but its source trace returns NO
  // annotations: the referenced human label cannot actually be read.
  fixture.annotationsByTrace = { ...fixture.annotationsByTrace, [T3]: [] };
  const { result } = await runGate({ root, fixture });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "fail");
  assert.equal(result.fail_closed, true);
  assert.equal(result.reason, "human_annotations_unresolvable");
  // The failure is LISTED, never silently dropped.
  assert.equal(result.human_annotation_failures.length, 1);
  assert.equal(result.human_annotation_failures[0].example_id, "EX-TEST");
  assert.equal(result.human_annotation_failures[0].reason, "referenced_human_annotation_ids_unresolved");
  assert.deepEqual(result.human_annotation_failures[0].missing_annotation_ids, ["anno-h3"]);
  // Even hard failures leave a local audit record.
  assert.ok(fs.existsSync(result.record_path));

  // Referenced ids WITHOUT any source trace to read them from also fail closed.
  const root2 = tempRoot();
  const fixture2 = passFixture();
  fixture2.records = fixture2.records.map((record) =>
    record.id === "EX-TEST"
      ? { ...record, metadata: { ...record.metadata, source_trace_id: null } }
      : record);
  const { result: result2 } = await runGate({ root: root2, fixture: fixture2 });
  assert.equal(result2.ok, false);
  assert.equal(result2.reason, "human_annotations_unresolvable");
  assert.equal(
    result2.human_annotation_failures[0].reason,
    "referenced_human_annotation_ids_without_source_trace",
  );
});

test("examples count as human-labeled ONLY when a HUMAN annotation actually resolved (FIX 6)", async () => {
  // The pass fixture resolves every referenced annotation: counts stand.
  const root = tempRoot();
  const { result } = await runGate({ root, fixture: passFixture() });
  assert.equal(result.verdict, "pass");
  assert.equal(result.evidence_counts.train_human_labeled_examples, 2);
  assert.equal(result.evidence_counts.test_human_labeled_examples, 1);

  // Metadata reference WITHOUT a resolved HUMAN annotation no longer counts:
  // strip the references (no failures to trip on) and return only LLM
  // annotations from the source traces — human-labeled must drop to zero.
  const root2 = tempRoot();
  const fixture2 = passFixture();
  fixture2.records = fixture2.records.map((record) => ({
    ...record,
    metadata: {
      ...record.metadata,
      reference: { human_annotations: [] },
    },
  }));
  fixture2.annotationsByTrace = Object.fromEntries(
    Object.entries(fixture2.annotationsByTrace).map(([traceId, annotations]) => [
      traceId,
      annotations.map((annotation) => ({ ...annotation, annotator_kind: "LLM" })),
    ]),
  );
  const { result: result2 } = await runGate({ root: root2, fixture: fixture2 });
  assert.equal(result2.evidence_counts.train_human_labeled_examples, 0);
  assert.equal(result2.evidence_counts.test_human_labeled_examples, 0);
  assert.ok(result2.failed_condition_ids.includes("human_labeled_subset_present"));
});

test("gate refuses cross-scope evidence (receipt Phoenix scope must match local config)", async () => {
  const root = tempRoot();
  const { result } = await runGate({
    root,
    fixture: passFixture(),
    receiptOverrides: { origin: "http://127.0.0.1:9999" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phoenix_scope_mismatch");
});

// ---------------------------------------------------------------------------
// Version compatibility and lifecycle.
// ---------------------------------------------------------------------------

test("cross-version comparison fails closed without explicit acceptance and derives relabel-needed at read time", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  fixture.records = fixture.records.map((record) => ({
    ...record,
    metadata: { ...record.metadata, rubric_version: "0.9.0" },
  }));
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failed_condition_ids.includes("version_compatibility"));
  const conditionEntry = result.conditions.find((entry) => entry.id === "version_compatibility");
  assert.match(conditionEntry.detail, /cross_version_comparison_requires_explicit_acceptance/);
  // Relabel-needed is DERIVED in the report, never persisted anywhere.
  assert.equal(result.excluded_examples.version_incompatible.length, 3);
  for (const excluded of result.excluded_examples.version_incompatible) {
    assert.equal(excluded.relabel_needed, true);
    assert.match(excluded.note, /never persisted/);
  }

  // With explicit acceptance the same evidence is comparable and the
  // well-formed fixture clears the gate.
  const root2 = tempRoot();
  const { result: accepted } = await runGate({
    root: root2,
    fixture,
    gateOverrides: { acceptCrossVersion: true },
  });
  assert.equal(accepted.verdict, "pass");
  const acceptedCondition = accepted.conditions.find((entry) => entry.id === "version_compatibility");
  assert.match(acceptedCondition.detail, /explicitly accepted/);
});

test("deprecated examples are excluded from default gates", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // A deprecated example with a conflicting judgment and an out-of-band human
  // score: if it leaked into the gate it would create a disagreement and a
  // low-confidence count.
  const T4 = "d".repeat(31) + "4";
  fixture.records.push(exampleRecord({
    id: "EX-DEP",
    split: "test",
    sourceTraceId: T4,
    humanAnnotationIds: ["anno-h4"],
    lifecycleState: "deprecated",
  }));
  fixture.rows.push(experimentRow({
    exampleId: "EX-DEP",
    judge: { label: "needs_revision", score: 0.55, failureModes: ["missing_acceptance_criteria"] },
  }));
  fixture.annotationsByTrace[T4] = [humanAnnotation({ label: "pass", score: 0.5, id: "anno-h4" })];
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.excluded_examples.deprecated, ["EX-DEP"]);
  assert.deepEqual(result.disagreements, [], "deprecated example conflicts must not enter the gate");
  assert.equal(result.evidence_counts.annotations_low_confidence, 0);
  assert.equal(result.evidence_counts.test_examples, 1, "deprecated test example is not counted");
});

// ---------------------------------------------------------------------------
// Band mismatch (Track A review obligation) and exposure history.
// ---------------------------------------------------------------------------

test("band-mismatched annotations stay valid evidence but are flagged and counted as low-confidence", async () => {
  const root = tempRoot();
  const fixture = passFixture();
  // Human says pass but scores 0.5 — outside the documented pass band.
  fixture.annotationsByTrace[T3] = [humanAnnotation({ label: "pass", score: 0.5, id: "anno-h3" })];
  const { result } = await runGate({ root, fixture });
  assert.equal(result.verdict, "pass", "band mismatch lowers confidence; it does not invalidate evidence");
  assert.equal(result.evidence_counts.annotations_low_confidence, 1);
  assert.equal(result.evidence_counts.test_human_labeled_examples, 1, "the example still counts as human-labeled");
  assert.deepEqual(result.band_mismatches.map((entry) => [entry.example_id, entry.annotator_kind, entry.reason]), [
    ["EX-TEST", "HUMAN", "label_score_band_mismatch"],
  ]);
  assert.equal(result.band_mismatches[0].still_valid_evidence, true);
  const lines = formatProcessChangeGateReport(result);
  assert.ok(lines.some((line) => line.includes("BAND MISMATCH EX-TEST")));
});

test("prior test-split exposure on the same target lineage is disclosed machine-local best-effort and defaults high risk", async () => {
  const root = tempRoot();
  // A PRIOR receipt for the same candidate target ran over all examples
  // (test split included), plus a local dataset-mode eval run for the same
  // variant whose split is unknown.
  writeReceiptFixture(root, {
    receiptId: "expr-prior",
    experimentId: "EXPOLD",
    splitRequested: "test",
    selection: "native_split_filter",
    launchedAt: "2026-06-09T01:00:00.000Z",
  });
  const evalRunsDir = path.join(root, ".agentic-factory", "eval-runs");
  fs.mkdirSync(evalRunsDir, { recursive: true });
  fs.writeFileSync(path.join(evalRunsDir, "eval-1.json"), JSON.stringify({
    schema_version: "linear-decomposition-eval-run/v1",
    eval_run_id: "eval-1",
    created_at: "2026-06-09T02:00:00.000Z",
    source: { mode: "dataset", dataset_name: "eval-ds", example_id: "EX-TEST" },
    variant: { id: "judge-v2", judge_candidate_prompt_version_id: "PV1" },
  }));

  const { result } = await runGate({ root, fixture: passFixture() });
  assert.equal(result.verdict, "pass");
  assert.equal(result.test_split_exposure.disclosure, "machine_local_best_effort");
  assert.equal(result.test_split_exposure.history_complete, false);
  assert.equal(result.test_split_exposure.prior_test_split_exposure, "definite");
  assert.equal(result.defaults_high_risk, true, "prior test-split exposure defaults the candidate to high_risk for step 10");
  assert.deepEqual(
    result.test_split_exposure.records.map((record) => record.source).sort(),
    ["eval_run_record", "experiment_receipt", "experiment_receipt"],
  );
  assert.ok(result.product_report.product_risk_remaining.some((line) => line.includes("prior test-split exposure")));
});

test("computeTestSplitExposureHistory classifies none/possible/definite conservatively", () => {
  const root = tempRoot();
  const candidate = { variant_id: "judge-v2", candidate_version_id: "PV1", judge_candidate_prompt_version_id: "PV1" };
  const empty = computeTestSplitExposureHistory({
    repoRoot: root,
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
    candidate,
    currentReceiptId: "expr-current",
  });
  assert.equal(empty.prior_test_split_exposure, "none");
  assert.equal(empty.disclosure, "machine_local_best_effort");

  // A train-only prior receipt is NOT test exposure.
  writeReceiptFixture(root, { receiptId: "expr-train-only", splitRequested: "train", selection: "native_split_filter" });
  const trainOnly = computeTestSplitExposureHistory({
    repoRoot: root,
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
    candidate,
    currentReceiptId: "expr-current",
  });
  assert.equal(trainOnly.prior_test_split_exposure, "none");

  // A dataset-mode eval run with unknown split is POSSIBLE exposure (when
  // unsure -> high risk downstream).
  const evalRunsDir = path.join(root, ".agentic-factory", "eval-runs");
  fs.mkdirSync(evalRunsDir, { recursive: true });
  fs.writeFileSync(path.join(evalRunsDir, "eval-2.json"), JSON.stringify({
    schema_version: "linear-decomposition-eval-run/v1",
    eval_run_id: "eval-2",
    created_at: "2026-06-09T02:00:00.000Z",
    source: { mode: "dataset", dataset_name: "eval-ds", example_id: "EX-A" },
    variant: { id: "judge-v2", judge_candidate_prompt_version_id: "PV1" },
  }));
  const possible = computeTestSplitExposureHistory({
    repoRoot: root,
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
    candidate,
    currentReceiptId: "expr-current",
  });
  assert.equal(possible.prior_test_split_exposure, "possible");
});

// ---------------------------------------------------------------------------
// Policy plumbing and CLI wiring.
// ---------------------------------------------------------------------------

test("D5 regression thresholds come from workspace-eval-policy.json and fail closed when absent", () => {
  const policy = loadWorkspaceEvalPolicy();
  const resolved = resolveHumanLabelRegressionPolicy(policy);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.anyLabelDegradationBlocks, true);
  assert.equal(resolved.maxMeanTestScoreDrop, 0.05);

  assert.equal(resolveHumanLabelRegressionPolicy({}).ok, false);
  assert.equal(resolveHumanLabelRegressionPolicy({}).reason, "human_label_regression_policy_missing");
  assert.equal(
    resolveHumanLabelRegressionPolicy({ human_label_regression: { any_label_degradation_blocks: true, max_mean_test_score_drop: -1 } }).ok,
    false,
  );
});

test("eval:disagreements and eval:gate are wired as first-class CLI tasks", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoCheckout, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["eval:disagreements"],
    "node execution/integrations/linear/cli.mjs eval:disagreements",
  );
  assert.equal(
    packageJson.scripts["eval:gate"],
    "node execution/integrations/linear/cli.mjs eval:gate",
  );
  const cliSource = fs.readFileSync(
    path.join(repoCheckout, "execution", "integrations", "linear", "cli.mjs"),
    "utf8",
  );
  assert.ok(cliSource.includes('command === "eval:disagreements"'));
  assert.ok(cliSource.includes('command === "eval:gate"'));
});
