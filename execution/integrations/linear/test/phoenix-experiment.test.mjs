import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { runDecompositionEvalTask } from "../src/decomposition-eval-cli.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  makeDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";
import { resolveForegroundDomainContext } from "../src/domain-resolver.mjs";
import { PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import {
  amendExperimentReceipt,
  assertAppendOnlyReceiptUpdate,
  compareExperimentScoreMeans,
  computeEvidenceCounts,
  deriveCandidateTargetKey,
  deriveExperimentReceiptState,
  deriveLaunchBaselineFromManifest,
  EXPERIMENT_RECEIPT_SCHEMA_VERSION,
  experimentReceiptPath,
  formatExperimentReport,
  readExperimentReceipt,
  resolveExperimentIntent,
  runDecompositionExperiment,
} from "../src/phoenix-experiment.mjs";
import { acceptedStateHash } from "../src/promotion-scanner/accepted-baseline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const config = loadLinearConfig({ repoRoot });
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "execution", "evals", "decomposition", "phoenix-assets.json"),
    "utf8",
  ),
);
const EXPECTED_BASELINE_ID = manifest.prompts[0].accepted_prompt_version_id
  || `sha256:${manifest.prompts[0].snapshot_sha256}`;
const EXPECTED_POLICY_BASELINE_ID = `sha256:${acceptedStateHash(manifest)}`;
const RUNTIME_ROLE_TARGET_KEY = "rule/decomposition/runtime_role_assignments";
const RUNTIME_ROLE_MANIFEST_ENTRY = manifest.rules.find((entry) => entry.target_key === RUNTIME_ROLE_TARGET_KEY);
const EXPECTED_RUNTIME_ROLE_BASELINE_ID = `sha256:${RUNTIME_ROLE_MANIFEST_ENTRY.snapshot_sha256}`;
const SR_ENG_TARGET_KEY = "prompt/decomposition/sr_eng_grounding_pass";
const SR_ENG_MANIFEST_ENTRY = manifest.prompts.find((entry) => entry.target_key === SR_ENG_TARGET_KEY);
const EXPECTED_SR_ENG_BASELINE_ID = SR_ENG_MANIFEST_ENTRY.accepted_prompt_version_id
  || `sha256:${SR_ENG_MANIFEST_ENTRY.snapshot_sha256}`;
const POLICY_SHA256 = createHash("sha256")
  .update(fs.readFileSync(
    path.join(repoRoot, "execution", "evals", "decomposition", "workspace-eval-policy.json"),
  ))
  .digest("hex");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-experiment-"));
}

function resolvedEvalDomainContext(root) {
  const registry = {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [
      makeDomainRecord({
        domainId: "support-ops",
        status: "active",
        workspaceId: "workspace-1",
        teamId: "eval-team-1",
        teamKey: config.linear.team.key,
        teamName: config.linear.team.name,
        webhookId: "webhook-eval",
      }),
    ],
  };
  writeDomainRegistry({ repoRoot: root }, registry);
  const resolved = resolveForegroundDomainContext({
    registry,
    domainId: "support-ops",
    config,
    repoRoot: root,
  });
  assert.equal(resolved.ok, true);
  return resolved.context;
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

// Route-table fetch fake: keys are "METHOD /pathname"; handlers may inspect
// query/body and return jsonResponse objects. Every call is recorded so tests
// can assert the wrapper talks to the Phoenix experiment REST API.
function fetchRouter(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method, pathname: parsed.pathname, url: parsed, body };
    calls.push(call);
    const handler = routes[`${method} ${parsed.pathname}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
    return typeof handler === "function" ? handler(call) : handler;
  };
  impl.calls = calls;
  return impl;
}

const readyUp = async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "agentic-factory" });

function projectUpdateMarkdownForRun(runId, summary = "Decomposition completed.") {
  return `run_id: ${runId}\n\n## What I did with each part of your project\n\n${summary}`;
}

const MINIMAL_OPENAPI = {
  paths: {
    "/v1/datasets/{dataset_id}/experiments": { post: {} },
    "/v1/experiments/{experiment_id}/runs": { post: {} },
    "/v1/experiment_evaluations": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpsertExperimentEvaluationRequestBody" },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      UpsertExperimentEvaluationRequestBody: {
        properties: {
          annotator_kind: { enum: ["LLM", "CODE", "HUMAN"] },
          result: { type: "object" },
          error: { type: "string" },
        },
      },
    },
  },
};

function exampleRecord({
  id,
  split = "train",
  sourceTraceId = null,
  humanAnnotationIds = [],
  projectId = "project-exp-1",
}) {
  return {
    id,
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
    metadata: {
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: "active",
      dataset_split: split,
      process_version: PROCESS_VERSION,
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
      source_trace_id: sourceTraceId,
      source_run_id: `source_${id}`,
      content_retention: "sanitized_fixture",
      schema_version: "decomposition-eval-example/v1",
      reference: {
        human_annotations: [],
        ...(humanAnnotationIds.length > 0 ? { human_annotation_ids: humanAnnotationIds } : {}),
      },
    },
  };
}

function fakeTaskResult({
  exampleId,
  ok = true,
  judgeLabel = "pass",
  judgeScore = 0.9,
  reason = null,
}) {
  if (!ok) {
    return { ok: false, status: "failed_closed", reason: reason || "scripted_failure" };
  }
  return {
    ok: true,
    status: "evaluated",
    eval_run_id: `eval-${exampleId}`,
    variant_id: "accepted_baseline",
    inputs_hash: "0".repeat(64),
    accepted_packets: [{}, {}, {}, {}],
    terminal: {
      status: "completed",
      reason: "no_blockers",
      final_issues: [],
      discovery_issues: [],
      dependency_relations: [],
      project_update_markdown: projectUpdateMarkdownForRun(`eval-${exampleId}`),
      open_questions_markdown: null,
    },
    trace: { trace_id: "f".repeat(32), trace_status: "trace_exported" },
    checks: {
      ok: true,
      storage: "report_only",
      checks: [
        {
          status: "evaluated",
          name: "accepted_packet_sufficiency",
          identifier: "accepted_packet_sufficiency_offline_v1",
          annotation: {
            name: "accepted_packet_sufficiency",
            annotator_kind: "CODE",
            label: "pass",
            score: 1,
            explanation: "all packets sufficient",
            identifier: "accepted_packet_sufficiency_offline_v1",
            metadata: { failure_modes: [] },
          },
        },
        {
          status: "skipped",
          name: "decomposition_quality",
          identifier: "decomposition_quality_offline_v1",
          skip_reason: "structured_issue_inputs_not_recorded_in_run_artifact",
        },
      ],
    },
    judge: {
      ok: true,
      judge_state: "judged",
      identifier: "decomposition_quality_judge_v1:test-model",
      model: "test-model",
      prompt_source: "repo_accepted_snapshot",
      prompt_version: EXPECTED_BASELINE_ID,
      judge: {
        label: judgeLabel,
        score: judgeScore,
        explanation: "judged in test",
        failure_modes: [],
        failure_mode_details: [],
      },
    },
  };
}

function baseRoutes({
  records,
  onCreate = null,
  experimentId = "EXP1",
  splitBehavior = "native",
} = {}) {
  let runCounter = 0;
  let evalCounter = 0;
  return {
    "GET /openapi.json": jsonResponse(MINIMAL_OPENAPI),
    "GET /v1/datasets": jsonResponse({ data: [{ id: "DS1", name: "eval-ds" }] }),
    "GET /v1/datasets/DS1/versions": jsonResponse({ data: [{ version_id: "DSV9" }], next_cursor: null }),
    "GET /v1/datasets/DS1/examples": (call) => {
      const split = call.url.searchParams.get("split");
      if (split) {
        if (splitBehavior === "native") {
          return jsonResponse({
            data: {
              dataset_id: "DS1",
              version_id: "DSV9",
              filtered_splits: [split],
              examples: records.filter((record) => record.metadata.dataset_split === split),
            },
          });
        }
        return jsonResponse({ detail: `Dataset splits not found: ${split}` }, 404);
      }
      return jsonResponse({ data: { dataset_id: "DS1", version_id: "DSV9", examples: records } });
    },
    "POST /v1/datasets/DS1/experiments": (call) => {
      if (onCreate) {
        const handled = onCreate(call);
        if (handled) return handled;
      }
      return jsonResponse({
        data: {
          id: experimentId,
          dataset_id: "DS1",
          dataset_version_id: "DSV9",
          repetitions: 1,
          metadata: call.body.metadata || {},
          project_name: "agentic-factory",
        },
      });
    },
    [`POST /v1/experiments/${experimentId}/runs`]: () => {
      runCounter += 1;
      return jsonResponse({ data: { id: `EXPRUN-${runCounter}` } });
    },
    "POST /v1/experiment_evaluations": () => {
      evalCounter += 1;
      return jsonResponse({ data: { id: `EXPEVAL-${evalCounter}` } });
    },
  };
}

function runExperiment({ root, fetchImpl, taskResults = {}, ...overrides }) {
  return runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: "eval-ds",
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: async (args) => {
      const make = taskResults[args.datasetExampleId]
        || (() => fakeTaskResult({ exampleId: args.datasetExampleId }));
      return make(args);
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("experiment wrapper stores through the Phoenix experiment REST API and writes a complete managed receipt", async () => {
  const root = tempRoot();
  const records = [
    exampleRecord({ id: "EX1", split: "train" }),
    exampleRecord({ id: "EX2", split: "test", humanAnnotationIds: ["ann-h1"] }),
  ];
  const fetchImpl = fetchRouter(baseRoutes({ records }));

  const result = await runExperiment({ root, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.phoenix_experiment_id, "EXP1");

  // Phoenix IS the experiment store: experiment created via REST, one run row
  // per example, one evaluation per explicitly-run evaluator result.
  const createCalls = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/datasets/DS1/experiments",
  );
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].body.version_id, "DSV9");
  assert.equal(createCalls[0].body.repetitions, 1);
  const runCalls = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiments/EXP1/runs",
  );
  assert.equal(runCalls.length, 2);
  assert.deepEqual(
    runCalls.map((call) => call.body.dataset_example_id).sort(),
    ["EX1", "EX2"],
  );
  assert.equal(runCalls[0].body.output.status, "evaluated");
  assert.equal(runCalls[0].body.trace_id, "f".repeat(32));
  const evaluationCalls = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiment_evaluations",
  );
  // 2 examples x (1 CODE check + 1 LLM judge) = 4 evaluations.
  assert.equal(evaluationCalls.length, 4);

  // Create-time metadata stamp (best-effort provenance; receipt is primary).
  assert.equal(createCalls[0].body.metadata.agentic_factory_receipt_id, result.receipt_id);
  assert.equal(
    createCalls[0].body.metadata.agentic_factory_run_id,
    result.agentic_factory_run_id,
  );
  assert.equal(createCalls[0].body.metadata.agentic_factory_source, "managed_manual");

  // Managed receipt: every plan-required field, baseline from the manifest.
  const stored = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root });
  assert.equal(stored.exists, true);
  const receipt = stored.receipt;
  assert.equal(receipt.schema_version, EXPERIMENT_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.receipt_id, result.receipt_id);
  assert.equal(receipt.source, "managed_manual");
  assert.equal(receipt.launch.intent, "exploratory");
  assert.equal(receipt.launch.intent_source, "default_exploratory_no_automation_policy");
  assert.equal(receipt.launch.candidate_target_key, "policy/decomposition/accepted_baseline");
  assert.equal(receipt.launch.launch_baseline.accepted_baseline_id, EXPECTED_POLICY_BASELINE_ID);
  assert.notEqual(receipt.launch.launch_baseline.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(
    receipt.launch.launch_baseline.accepted_artifact_hash_vector.accepted_state_sha256,
    EXPECTED_POLICY_BASELINE_ID.replace(/^sha256:/, ""),
  );
  assert.equal(receipt.launch.launch_baseline.derived_from, "phoenix_assets_manifest");
  assert.equal(receipt.launch.candidate.variant_id, "accepted_baseline");
  assert.equal(receipt.launch.candidate.candidate_version_id, "accepted_baseline");
  assert.deepEqual(receipt.launch.dataset, {
    name: "eval-ds",
    dataset_id: "DS1",
    dataset_version_id: "DSV9",
  });
  assert.equal(receipt.launch.split.requested, null);
  assert.equal(receipt.launch.split.selection, "all_examples");
  assert.deepEqual(receipt.launch.split.example_ids, ["EX1", "EX2"]);
  assert.deepEqual(receipt.launch.evaluators.code, [
    "decomposition_quality_offline_v1",
    "accepted_packet_sufficiency_offline_v1",
    "pause_state_correctness_offline_v1",
  ]);
  assert.equal(receipt.launch.evaluators.judge.evaluator_id, "decomposition_quality_judge_v1");
  assert.ok(receipt.launch.evaluators.judge.identifier.startsWith("decomposition_quality_judge_v1:"));
  assert.equal(receipt.launch.evaluators.judge.prompt_version, EXPECTED_BASELINE_ID);
  assert.equal(receipt.launch.promotion_policy, null);
  assert.equal(receipt.launch.workspace_eval_policy.sha256, POLICY_SHA256);
  assert.equal(receipt.launch.actor.authenticity, "asserted");
  assert.ok(receipt.launch.actor.os_username);
  assert.ok(receipt.launch.launched_at);
  assert.deepEqual(receipt.launch.phoenix_scope, {
    origin: "http://127.0.0.1:6006",
    project_name: "agentic-factory",
  });
  assert.ok(receipt.launch.agentic_factory_run_id.startsWith("afexp-"));

  // The Phoenix experiment ID was written back as the primary join.
  assert.equal(receipt.phoenix_experiment_id, "EXP1");
  assert.deepEqual(
    receipt.events.map((event) => event.type),
    ["launched", "phoenix_experiment_created", "completed"],
  );
  assert.equal(receipt.events[1].metadata_stamp, "stamped");

  // evidence_counts contract over the selected examples.
  assert.deepEqual(result.summary.evidence_counts, {
    train_examples: 1,
    train_human_labeled_examples: 0,
    test_examples: 1,
    test_human_labeled_examples: 1,
    human_label_authenticity: "asserted",
  });
  assert.equal(result.summary.baseline_comparison.computable, false);
  assert.equal(
    result.summary.baseline_comparison.reason,
    "no_accepted_baseline_experiment_pinned_in_manifest",
  );
  assert.ok(result.deep_links.experiment.includes("/datasets/DS1/experiments/EXP1"));
  assert.ok(formatExperimentReport(result).some((line) => line.includes("stdout + local receipt only")));
});

test("rule-target launch summaries do not compare against unrelated prompt baselines", async () => {
  const root = tempRoot();
  const manifestPath = path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json");
  const runtimeRolesPath = path.join(root, RUNTIME_ROLE_MANIFEST_ENTRY.artifact_path);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(path.dirname(runtimeRolesPath), { recursive: true });
  const manifestDraft = structuredClone(manifest);
  manifestDraft.experiments = [{
    purpose: "baseline",
    candidate_target_key: SR_ENG_TARGET_KEY,
    experiment_id: "BASE-PROMPT",
    dataset_id: "DS1",
    dataset_version_id: "DSV9",
    accepted_artifact_hash_vector: {
      snapshot_sha256: SR_ENG_MANIFEST_ENTRY.snapshot_sha256,
      accepted_prompt_version_id: SR_ENG_MANIFEST_ENTRY.accepted_prompt_version_id ?? null,
    },
  }];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifestDraft, null, 2)}\n`, "utf8");
  fs.copyFileSync(path.join(repoRoot, RUNTIME_ROLE_MANIFEST_ENTRY.artifact_path), runtimeRolesPath);
  const variantsPath = path.join(root, "variants-runtime-role.json");
  fs.writeFileSync(variantsPath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v2",
    default_variant: "runtime-role",
    variants: {
      "runtime-role": {
        description: "Runtime role candidate.",
        role_overrides: { pm: { model: "candidate-model" } },
        prompt_overrides: {},
        judge_candidate_prompt_version_id: null,
      },
    },
  }, null, 2)}\n`, "utf8");
  const result = await runExperiment({
    root,
    fetchImpl: fetchRouter(baseRoutes({ records: [exampleRecord({ id: "EX1" })] })),
    variantId: "runtime-role",
    variantsPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidate_target_key, RUNTIME_ROLE_TARGET_KEY);
  assert.equal(result.summary.baseline_comparison.computable, false);
  assert.equal(
    result.summary.baseline_comparison.reason,
    "no_accepted_baseline_experiment_pinned_in_manifest",
  );
});

test("native split selection is used when available and the experiment is created with the native split filter", async () => {
  const root = tempRoot();
  const records = [
    exampleRecord({ id: "EX1", split: "train" }),
    exampleRecord({ id: "EX2", split: "test" }),
  ];
  const fetchImpl = fetchRouter(baseRoutes({ records, splitBehavior: "native" }));

  const result = await runExperiment({ root, fetchImpl, split: "test" });

  assert.equal(result.ok, true);
  assert.equal(result.split.selection, "native_split_filter");
  assert.equal(result.split.disclosure, null);
  const exampleCall = fetchImpl.calls.find(
    (call) => call.pathname === "/v1/datasets/DS1/examples" && call.url.searchParams.get("split"),
  );
  assert.equal(exampleCall.url.searchParams.get("split"), "test");
  assert.equal(exampleCall.url.searchParams.get("version_id"), "DSV9");
  const createCall = fetchImpl.calls.find(
    (call) => call.method === "POST" && call.pathname === "/v1/datasets/DS1/experiments",
  );
  assert.deepEqual(createCall.body.splits, ["test"]);
  assert.equal(result.per_example.length, 1);
  assert.equal(result.per_example[0].example_id, "EX2");
  assert.equal(result.per_example[0].split_basis, "native_split_filter");
});

test("metadata.dataset_split fallback is client-side filtered and DISCLOSED, never claimed as native", async () => {
  const root = tempRoot();
  const records = [
    exampleRecord({ id: "EX1", split: "train" }),
    exampleRecord({ id: "EX2", split: "test" }),
  ];
  const fetchImpl = fetchRouter(baseRoutes({ records, splitBehavior: "missing" }));

  const result = await runExperiment({ root, fetchImpl, split: "test" });

  assert.equal(result.ok, true);
  assert.equal(result.split.selection, "metadata_fallback");
  assert.ok(result.split.disclosure.includes("NOT native split evidence"));
  assert.equal(result.summary.split_disclosure, result.split.disclosure);
  assert.equal(result.per_example.length, 1);
  assert.equal(result.per_example[0].example_id, "EX2");
  assert.equal(result.per_example[0].split_basis, "metadata_dataset_split_mirror");
  // The experiment create must NOT claim a native split it could not select.
  const createCall = fetchImpl.calls.find(
    (call) => call.method === "POST" && call.pathname === "/v1/datasets/DS1/experiments",
  );
  assert.equal(createCall.body.splits, undefined);
  const receipt = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root }).receipt;
  assert.equal(receipt.launch.split.selection, "metadata_fallback");
  assert.ok(receipt.launch.split.disclosure);
  assert.ok(
    formatExperimentReport(result).some((line) => line.includes("DISCLOSED fallback")),
  );
});

test("evaluators are run and passed explicitly: the wrapper chains checks+judge and posts exactly those results", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({ records }));
  const taskArgs = [];

  const result = await runExperiment({
    root,
    fetchImpl,
    runEvalTaskFn: async (args) => {
      taskArgs.push(args);
      return fakeTaskResult({ exampleId: args.datasetExampleId, judgeScore: 0.85 });
    },
  });

  assert.equal(result.ok, true);
  // The wrapper explicitly requests the in-memory evaluator chain.
  assert.equal(taskArgs.length, 1);
  assert.equal(taskArgs[0].emitChecks, true);
  assert.equal(taskArgs[0].judge, true);
  // Exactly the explicitly-produced evaluator results are recorded — one CODE
  // check + one LLM judgment; nothing is assumed to auto-run in Phoenix.
  const evaluations = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiment_evaluations",
  );
  assert.equal(evaluations.length, 2);
  const code = evaluations.find((call) => call.body.annotator_kind === "CODE");
  assert.equal(code.body.name, "accepted_packet_sufficiency");
  assert.equal(code.body.result.label, "pass");
  assert.equal(code.body.metadata.identifier, "accepted_packet_sufficiency_offline_v1");
  assert.equal(code.body.experiment_run_id, "EXPRUN-1");
  const llm = evaluations.find((call) => call.body.annotator_kind === "LLM");
  assert.equal(llm.body.name, "decomposition_quality");
  assert.equal(llm.body.result.score, 0.85);
  assert.equal(llm.body.metadata.judge_prompt_source, "repo_accepted_snapshot");
});

test("per-example failure is recorded as an experiment run error and the experiment continues (partial summary)", async () => {
  const root = tempRoot();
  const records = [
    exampleRecord({ id: "EX1" }),
    exampleRecord({ id: "EX2", split: "test" }),
  ];
  const fetchImpl = fetchRouter(baseRoutes({ records }));

  const result = await runExperiment({
    root,
    fetchImpl,
    taskResults: {
      EX1: () => fakeTaskResult({ exampleId: "EX1", ok: false, reason: "missing_terminal_artifact" }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed_with_failures");
  assert.equal(result.summary.failed_example_count, 1);
  assert.equal(result.summary.failed_examples[0].example_id, "EX1");
  assert.ok(result.summary.failed_examples[0].failures[0].includes("missing_terminal_artifact"));

  const runCalls = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiments/EXP1/runs",
  );
  assert.equal(runCalls.length, 2, "the failed example still gets an explainable run row");
  const failedRun = runCalls.find((call) => call.body.dataset_example_id === "EX1");
  assert.equal(failedRun.body.output, null);
  assert.ok(failedRun.body.error.includes("missing_terminal_artifact"));
  const okRun = runCalls.find((call) => call.body.dataset_example_id === "EX2");
  assert.equal(okRun.body.error, null);
  // Evaluations only for the example that produced results.
  const evaluations = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiment_evaluations",
  );
  assert.equal(evaluations.length, 2);
  // The receipt's completed event names the failure (explainable partial).
  const receipt = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root }).receipt;
  const completed = receipt.events.find((event) => event.type === "completed");
  assert.equal(completed.summary.status, "completed_with_failures");
  assert.equal(completed.summary.failed_examples[0].example_id, "EX1");
});

test("create-time metadata stamp is attempted and tolerated when rejected; experiment id still written back", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({
    records,
    onCreate: (call) => (call.body.metadata
      ? jsonResponse({ detail: "metadata is not supported" }, 422)
      : null),
  }));

  const result = await runExperiment({ root, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.metadata_stamp, "rejected_create_succeeded_without_stamp");
  const createCalls = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/datasets/DS1/experiments",
  );
  assert.equal(createCalls.length, 2, "stamped attempt first, tolerated retry without stamp");
  assert.ok(createCalls[0].body.metadata);
  assert.equal(createCalls[1].body.metadata, undefined);
  const receipt = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root }).receipt;
  assert.equal(receipt.phoenix_experiment_id, "EXP1");
  assert.equal(
    receipt.events.find((event) => event.type === "phoenix_experiment_created").metadata_stamp,
    "rejected_create_succeeded_without_stamp",
  );
  assert.ok(
    formatExperimentReport(result).some((line) => line.includes("best-effort provenance")),
  );
});

test("failed experiment creation leaves a registerable receipt; register amendment verifies identity and is append-only", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const routes = baseRoutes({
    records,
    onCreate: () => jsonResponse({ detail: "boom" }, 500),
  });
  const fetchImpl = fetchRouter(routes);

  const failed = await runExperiment({ root, fetchImpl });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "experiment_create_failed");
  assert.ok(failed.repair_hint.includes("phoenix:experiment-amend"));
  const receiptId = failed.receipt_id;
  const before = readExperimentReceipt({ receiptId, repoRoot: root }).receipt;
  assert.equal(before.phoenix_experiment_id, null);
  assert.ok(before.events.some((event) => event.type === "phoenix_experiment_create_failed"));

  // Retroactive registration through the verified resolver.
  const amendFetch = fetchRouter({
    "GET /v1/experiments/EXP9": jsonResponse({
      data: { id: "EXP9", dataset_id: "DS1", dataset_version_id: "DSV10", project_name: "agentic-factory" },
    }),
  });
  const registered = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "register",
    reason: "experiment created manually after launch failure",
    experimentId: "EXP9",
    ensureReady: readyUp,
    fetchImpl: amendFetch,
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.state.phoenix_experiment_id, "EXP9");
  assert.equal(registered.amendment.verification.experiment.id, "EXP9");
  assert.equal(registered.amendment.verification.dataset_version_matches_launch, false);
  assert.ok(registered.amendment.actor.os_username);
  assert.equal(registered.amendment.actor.authenticity, "asserted");

  // Prior facts are untouched: launch block and prior events byte-identical.
  const after = readExperimentReceipt({ receiptId, repoRoot: root }).receipt;
  assert.deepEqual(after.launch, before.launch);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.amendments.length, 1);
  assert.equal(after.phoenix_experiment_id, "EXP9");

  // A second registration with a DIFFERENT id would rewrite the join — refused.
  const conflicting = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "register",
    reason: "trying to swap the join",
    experimentId: "EXP-OTHER",
    ensureReady: readyUp,
    fetchImpl: amendFetch,
  });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.reason, "conflicting_experiment_registration");
});

test("register refuses an experiment from another dataset (receipt/Phoenix mismatch)", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({
    records,
    onCreate: () => jsonResponse({ detail: "boom" }, 500),
  }));
  const failed = await runExperiment({ root, fetchImpl });

  const amendFetch = fetchRouter({
    "GET /v1/experiments/EXP-WRONG": jsonResponse({
      data: { id: "EXP-WRONG", dataset_id: "DS-OTHER", dataset_version_id: "X" },
    }),
  });
  const mismatch = await amendExperimentReceipt({
    repoRoot: root,
    receiptId: failed.receipt_id,
    action: "register",
    reason: "attach wrong experiment",
    experimentId: "EXP-WRONG",
    ensureReady: readyUp,
    fetchImpl: amendFetch,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "experiment_dataset_mismatch");
});

test("reclassify and withdraw are append-only amendments; withdrawal is visible in derived state", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({ records }));
  const launched = await runExperiment({ root, fetchImpl });
  const receiptId = launched.receipt_id;
  const before = readExperimentReceipt({ receiptId, repoRoot: root }).receipt;

  const resolverFetch = fetchRouter({
    "GET /v1/experiments/EXP1": jsonResponse({
      data: { id: "EXP1", dataset_id: "DS1", dataset_version_id: "DSV9" },
    }),
  });

  // Reason is mandatory.
  const noReason = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "withdraw",
    reason: "  ",
    ensureReady: readyUp,
    fetchImpl: resolverFetch,
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.reason, "missing_amendment_reason");

  // Reclassify exploratory -> promotion_candidate (materially new evidence is
  // step 12's concern; here the intent change is an appended amendment only).
  const reclassified = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "reclassify",
    reason: "results look promotion-worthy",
    newIntent: "promotion_candidate",
    ensureReady: readyUp,
    fetchImpl: resolverFetch,
  });
  assert.equal(reclassified.ok, true);
  assert.equal(reclassified.state.intent, "promotion_candidate");
  assert.equal(reclassified.state.intent_source, "amendment_reclassify");
  const midway = readExperimentReceipt({ receiptId, repoRoot: root }).receipt;
  assert.equal(midway.launch.intent, "exploratory", "launch intent fact is never rewritten");
  assert.deepEqual(midway.launch, before.launch);
  assert.equal(midway.amendments.length, 1);
  assert.equal(midway.amendments[0].from_intent, "exploratory");
  assert.equal(midway.amendments[0].to_intent, "promotion_candidate");

  // Withdraw.
  const withdrawn = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "withdraw",
    reason: "superseded by a newer variant",
    ensureReady: readyUp,
    fetchImpl: resolverFetch,
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.state.state, "withdrawn");
  const final = readExperimentReceipt({ receiptId, repoRoot: root }).receipt;
  assert.deepEqual(final.launch, before.launch);
  assert.equal(final.amendments.length, 2);
  assert.equal(deriveExperimentReceiptState(final).state, "withdrawn");
  assert.equal(deriveExperimentReceiptState(final).intent, "promotion_candidate");

  // Withdrawn receipts refuse further amendments (new evidence = new receipt).
  const again = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "withdraw",
    reason: "again",
    ensureReady: readyUp,
    fetchImpl: resolverFetch,
  });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "receipt_already_withdrawn");
  const reRegister = await amendExperimentReceipt({
    repoRoot: root,
    receiptId,
    action: "reclassify",
    reason: "flip flop",
    newIntent: "exploratory",
    ensureReady: readyUp,
    fetchImpl: resolverFetch,
  });
  assert.equal(reRegister.ok, false);
  assert.equal(reRegister.reason, "receipt_withdrawn");
});

test("intent defaults to exploratory (no automation policy exists); promotion_candidate only via the explicit flag", async () => {
  assert.deepEqual(resolveExperimentIntent({}), {
    ok: true,
    intent: "exploratory",
    source: "default_exploratory_no_automation_policy",
  });
  assert.deepEqual(resolveExperimentIntent({ intentFlag: "promotion_candidate" }), {
    ok: true,
    intent: "promotion_candidate",
    source: "explicit_flag",
  });
  assert.equal(resolveExperimentIntent({ intentFlag: "auto" }).ok, false);

  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({ records }));
  const explicit = await runExperiment({
    root,
    fetchImpl,
    intentFlag: "promotion_candidate",
    derivedVariant: {
      id: "promotion-prompt-override",
      prompt_overrides: {
        [SR_ENG_TARGET_KEY]: { candidate_prompt_version_id: "PV-PROMOTION" },
      },
    },
  });
  assert.equal(explicit.intent, "promotion_candidate");
  assert.equal(explicit.intent_source, "explicit_flag");
  const receipt = readExperimentReceipt({ receiptId: explicit.receipt_id, repoRoot: root }).receipt;
  assert.equal(receipt.launch.intent, "promotion_candidate");
  assert.equal(receipt.launch.intent_source, "explicit_flag");
  assert.equal(receipt.launch.candidate_target_key, SR_ENG_TARGET_KEY);

  const invalid = await runExperiment({ root, fetchImpl: fetchRouter({}), intentFlag: "auto" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_intent");
});

test("zero-override accepted-baseline runs cannot be promotion candidates", async () => {
  const root = tempRoot();
  const rejected = await runExperiment({
    root,
    fetchImpl: fetchRouter({}),
    intentFlag: "promotion_candidate",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "not_run");
  assert.equal(rejected.reason, "promotion_candidate_requires_agent_behavior_change");
});

test("promotion candidates must target exactly one agent behavior artifact", async () => {
  const mixedRoot = tempRoot();
  const mixedVariantsPath = path.join(mixedRoot, "variants-mixed-agent-behavior.json");
  fs.writeFileSync(mixedVariantsPath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v2",
    default_variant: "mixed",
    variants: {
      mixed: {
        description: "Prompt and runtime concerns in one variant.",
        role_overrides: { pm: { model: "candidate-model" } },
        prompt_overrides: {
          [SR_ENG_TARGET_KEY]: { candidate_prompt_version_id: "PV-SR-ENG" },
        },
      },
    },
  }, null, 2)}\n`, "utf8");
  const mixed = await runExperiment({
    root: mixedRoot,
    fetchImpl: fetchRouter({}),
    variantsPath: mixedVariantsPath,
    intentFlag: "promotion_candidate",
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.status, "not_run");
  assert.equal(mixed.reason, "promotion_candidate_requires_single_agent_behavior_change");
  assert.match(mixed.detail, /prompt:prompt\/decomposition\/sr_eng_grounding_pass/);
  assert.match(mixed.detail, /rule:runtime_role_assignments/);

  const multiPromptRoot = tempRoot();
  const multiPromptVariantsPath = path.join(multiPromptRoot, "variants-multi-prompt.json");
  fs.writeFileSync(multiPromptVariantsPath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v2",
    default_variant: "multi-prompt",
    variants: {
      "multi-prompt": {
        description: "Two prompt concerns in one variant.",
        role_overrides: {},
        prompt_overrides: {
          [SR_ENG_TARGET_KEY]: { candidate_prompt_version_id: "PV-SR-ENG" },
          "prompt/decomposition/pm_synthesis": { candidate_prompt_version_id: "PV-PM-SYNTH" },
        },
      },
    },
  }, null, 2)}\n`, "utf8");
  const multiPrompt = await runExperiment({
    root: multiPromptRoot,
    fetchImpl: fetchRouter({}),
    variantsPath: multiPromptVariantsPath,
    intentFlag: "promotion_candidate",
  });
  assert.equal(multiPrompt.ok, false);
  assert.equal(multiPrompt.status, "not_run");
  assert.equal(multiPrompt.reason, "promotion_candidate_requires_single_agent_behavior_change");
  assert.match(multiPrompt.detail, /prompt:prompt\/decomposition\/sr_eng_grounding_pass/);
  assert.match(multiPrompt.detail, /prompt:prompt\/decomposition\/pm_synthesis/);
});

test("derivedVariant bypasses committed variants.json and records per-target baseline plus drafted_by verbatim", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const committedVariantsPath = path.join(root, "execution", "evals", "decomposition", "variants.json");
  fs.mkdirSync(path.dirname(committedVariantsPath), { recursive: true });
  fs.writeFileSync(committedVariantsPath, "{ this would fail if read", "utf8");
  const committedBefore = fs.readFileSync(committedVariantsPath, "utf8");
  const fetchImpl = fetchRouter(baseRoutes({ records }));
  const targetKey = SR_ENG_TARGET_KEY;
  const derivedVariant = {
    id: "drafted:draft-20260611T120000000Z-000001",
    prompt_overrides: {
      [targetKey]: { candidate_prompt_version_id: "PV-DRAFT" },
    },
  };
  const taskArgs = [];

  const result = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: "eval-ds",
    derivedVariant,
    draftedBy: "agentic_factory_drafter_v1:test-model",
    intentFlag: "promotion_candidate",
    variantsPath: committedVariantsPath,
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: async (args) => {
      taskArgs.push(args);
      assert.notEqual(args.variantsPath, committedVariantsPath);
      assert.equal(args.variantId, derivedVariant.id);
      const tempVariants = JSON.parse(fs.readFileSync(args.variantsPath, "utf8"));
      assert.deepEqual(tempVariants.variants[derivedVariant.id].prompt_overrides, derivedVariant.prompt_overrides);
      return fakeTaskResult({ exampleId: args.datasetExampleId });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(taskArgs.length, 1);
  assert.equal(fs.readFileSync(committedVariantsPath, "utf8"), committedBefore);
  const receipt = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root }).receipt;
  assert.equal(receipt.launch.intent, "promotion_candidate");
  assert.equal(receipt.launch.drafted_by, "agentic_factory_drafter_v1:test-model");
  assert.equal(receipt.launch.candidate_target_key, targetKey);
  assert.equal(receipt.launch.launch_baseline.accepted_baseline_id, EXPECTED_SR_ENG_BASELINE_ID);
  assert.equal(receipt.launch.launch_baseline.prompt_role, SR_ENG_MANIFEST_ENTRY.role);
  assert.equal(receipt.launch.launch_baseline.accepted_artifact_hash_vector.snapshot_sha256, SR_ENG_MANIFEST_ENTRY.snapshot_sha256);
  assert.equal(receipt.launch.evaluators.judge.prompt_version, EXPECTED_BASELINE_ID);
  assert.equal(receipt.launch.candidate.candidate_version_id, "PV-DRAFT");
  assert.equal(receipt.launch.candidate.judge_candidate_prompt_version_id, "PV-DRAFT");
  assert.deepEqual(receipt.launch.candidate.derived_variant, derivedVariant);
  assert.deepEqual(receipt.launch.candidate.prompt_overrides, derivedVariant.prompt_overrides);
  const createCall = fetchImpl.calls.find((call) =>
    call.method === "POST" && call.pathname === "/v1/datasets/DS1/experiments");
  assert.equal(createCall.body.metadata.agentic_factory_candidate_version_id, "PV-DRAFT");
});

test("judge-target launches keep the existing judge baseline identity", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const variantsPath = path.join(root, "variants-judge-candidate.json");
  fs.writeFileSync(variantsPath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v1",
    default_variant: "judge-candidate",
    variants: {
      "judge-candidate": {
        description: "Candidate judge prompt.",
        role_overrides: {},
        judge_candidate_prompt_version_id: "PV-JUDGE",
      },
    },
  }, null, 2)}\n`, "utf8");

  const result = await runExperiment({
    root,
    fetchImpl: fetchRouter(baseRoutes({ records })),
    variantId: "judge-candidate",
    variantsPath,
  });

  assert.equal(result.ok, true);
  const receipt = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot: root }).receipt;
  assert.equal(receipt.launch.candidate_target_key, "prompt/decomposition/decomposition_quality_judge");
  assert.equal(receipt.launch.launch_baseline.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(receipt.launch.launch_baseline.derived_from, "phoenix_assets_manifest");
  assert.equal(receipt.launch.evaluators.judge.prompt_version, "PV-JUDGE");
});

test("unknown prompt target keys fail closed before launch instead of falling back to the judge baseline", async () => {
  const root = tempRoot();
  const derivedVariant = {
    id: "drafted:draft-20260611T120000000Z-unknown",
    prompt_overrides: {
      "prompt/decomposition/not_in_manifest": { candidate_prompt_version_id: "PV-UNKNOWN" },
    },
  };
  const fetchImpl = fetchRouter({});
  let taskCalls = 0;

  const result = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: "eval-ds",
    derivedVariant,
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: async () => {
      taskCalls += 1;
      return fakeTaskResult({ exampleId: "EX1" });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "not_run");
  assert.equal(result.reason, "launch_target_unknown");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(taskCalls, 0);
});

test("non-prompt launch baselines resolve to their own accepted artifacts and unknown non-prompts fail closed", () => {
  const ruleBaseline = deriveLaunchBaselineFromManifest({ candidateTargetKey: RUNTIME_ROLE_TARGET_KEY });
  assert.equal(ruleBaseline.ok, true);
  assert.equal(ruleBaseline.baseline.accepted_baseline_id, EXPECTED_RUNTIME_ROLE_BASELINE_ID);
  assert.notEqual(ruleBaseline.baseline.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(ruleBaseline.baseline.artifact_kind, "runtime_role_defaults");
  assert.equal(
    ruleBaseline.baseline.accepted_artifact_hash_vector.snapshot_sha256,
    RUNTIME_ROLE_MANIFEST_ENTRY.snapshot_sha256,
  );

  const policyBaseline = deriveLaunchBaselineFromManifest({
    candidateTargetKey: "policy/decomposition/accepted_baseline",
  });
  assert.equal(policyBaseline.ok, true);
  assert.equal(policyBaseline.baseline.accepted_baseline_id, EXPECTED_POLICY_BASELINE_ID);
  assert.notEqual(policyBaseline.baseline.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(policyBaseline.baseline.artifact_kind, "accepted_baseline_manifest");
  assert.equal(
    policyBaseline.baseline.accepted_artifact_hash_vector.accepted_state_sha256,
    EXPECTED_POLICY_BASELINE_ID.replace(/^sha256:/, ""),
  );

  const unknown = deriveLaunchBaselineFromManifest({
    candidateTargetKey: "rule/decomposition/not_in_manifest",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "accepted_artifact_target_unavailable");
});

test("append-only receipt guard rejects rewrites of launch facts, prior events, and the experiment id", () => {
  const receipt = {
    schema_version: EXPERIMENT_RECEIPT_SCHEMA_VERSION,
    receipt_id: "expr-x",
    source: "managed_manual",
    created_at: "2026-06-10T00:00:00Z",
    launch: { intent: "exploratory" },
    phoenix_experiment_id: "EXP1",
    events: [{ type: "launched" }],
    amendments: [],
  };
  const clone = () => JSON.parse(JSON.stringify(receipt));

  const appended = clone();
  appended.events.push({ type: "completed" });
  appended.amendments.push({ action: "withdraw" });
  assert.doesNotThrow(() => assertAppendOnlyReceiptUpdate(receipt, appended));

  const launchEdit = clone();
  launchEdit.launch.intent = "promotion_candidate";
  assert.throws(() => assertAppendOnlyReceiptUpdate(receipt, launchEdit), /launch facts are immutable/);

  const eventRewrite = clone();
  eventRewrite.events[0] = { type: "rewritten" };
  assert.throws(() => assertAppendOnlyReceiptUpdate(receipt, eventRewrite), /events\[0\] was rewritten/);

  const idSwap = clone();
  idSwap.phoenix_experiment_id = "EXP2";
  assert.throws(() => assertAppendOnlyReceiptUpdate(receipt, idSwap), /write-once/);

  const nullToValue = { ...clone(), phoenix_experiment_id: null };
  const filled = clone();
  assert.doesNotThrow(() => assertAppendOnlyReceiptUpdate(nullToValue, filled));
});

test("summary reports human/LLM/CODE disagreements and judge-vs-human regressions from real annotation reads", async () => {
  const root = tempRoot();
  const sourceTraceId = "a".repeat(32);
  const records = [
    exampleRecord({ id: "EX1", split: "test", sourceTraceId, humanAnnotationIds: ["ann-h1"] }),
  ];
  const routes = baseRoutes({ records });
  routes["GET /v1/projects/agentic-factory/trace_annotations"] = jsonResponse({
    data: [
      {
        id: "ann-h1",
        name: "decomposition_quality",
        annotator_kind: "HUMAN",
        identifier: "steve",
        result: { label: "pass", score: 0.95, explanation: "good decomposition" },
      },
    ],
    next_cursor: null,
  });
  const fetchImpl = fetchRouter(routes);

  const result = await runExperiment({
    root,
    fetchImpl,
    taskResults: {
      EX1: () => fakeTaskResult({ exampleId: "EX1", judgeLabel: "needs_revision", judgeScore: 0.55 }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.per_example[0].human_label, "pass");
  assert.equal(result.per_example[0].human_labeled, true);
  assert.deepEqual(result.summary.disagreements, [
    {
      example_id: "EX1",
      signals: { human: "pass", llm: "needs_revision", code: "pass" },
    },
  ]);
  assert.deepEqual(result.summary.judge_vs_human_regressions, [
    { example_id: "EX1", human_label: "pass", judge_label: "needs_revision" },
  ]);
  assert.equal(result.summary.evidence_counts.test_human_labeled_examples, 1);
  const lines = formatExperimentReport(result);
  assert.ok(lines.some((line) => line.includes("disagreement on EX1")));
  assert.ok(lines.some((line) => line.includes("judge-vs-human regression on EX1")));
});

test("score changes vs an accepted baseline experiment are computed when the manifest pins one, else disclosed as not computable", async () => {
  const root = tempRoot();
  const records = [exampleRecord({ id: "EX1" })];
  const routes = baseRoutes({ records });
  routes["GET /v1/experiments/BASE1/json"] = jsonResponse([
    { example_id: "EX1", annotations: [{ name: "decomposition_quality", score: 0.95, label: "pass" }] },
    { example_id: "EX2", annotations: [{ name: "decomposition_quality", score: 0.85, label: "pass" }] },
  ]);
  const fetchImpl = fetchRouter(routes);

  const result = await runExperiment({
    root,
    fetchImpl,
    taskResults: {
      EX1: () => fakeTaskResult({ exampleId: "EX1", judgeScore: 0.8 }),
    },
    baselineExperimentOverride: { purpose: "baseline", experiment_id: "BASE1", dataset_id: "DS1" },
  });

  assert.equal(result.ok, true);
  const comparison = result.summary.baseline_comparison;
  assert.equal(comparison.computable, true);
  assert.equal(comparison.baseline_experiment_id, "BASE1");
  assert.ok(Math.abs(comparison.deltas.decomposition_quality.delta - (0.8 - 0.9)) < 1e-9);
  assert.deepEqual(comparison.regressions, ["decomposition_quality"]);
  assert.ok(
    formatExperimentReport(result).some((line) => line.includes("REGRESSIONS vs baseline")),
  );

  // Pure comparison helper.
  const { deltas, regressions } = compareExperimentScoreMeans({
    currentMeans: { a: 0.5, b: 0.9 },
    baselineMeans: { a: 0.6, c: 0.1 },
  });
  assert.deepEqual(Object.keys(deltas), ["a"]);
  assert.deepEqual(regressions, ["a"]);
});

test("explicit example-id selection filters and fails closed on unknown ids; preflight failure is fail-closed before any write", async () => {
  const root = tempRoot();
  const records = [
    exampleRecord({ id: "EX1" }),
    exampleRecord({ id: "EX2", split: "test" }),
  ];
  const fetchImpl = fetchRouter(baseRoutes({ records }));

  const filtered = await runExperiment({ root, fetchImpl, exampleIds: ["EX2"] });
  assert.equal(filtered.ok, true);
  assert.equal(filtered.per_example.length, 1);
  assert.equal(filtered.per_example[0].example_id, "EX2");

  const missing = await runExperiment({
    root,
    fetchImpl: fetchRouter(baseRoutes({ records })),
    exampleIds: ["EX2", "EX-missing"],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "requested_examples_not_found");
  assert.deepEqual(missing.missing, ["EX-missing"]);

  // Capability preflight failure: no receipt, no experiment, no writes.
  const crippled = fetchRouter({
    "GET /openapi.json": jsonResponse({ paths: {} }),
  });
  const noCapability = await runExperiment({ root: tempRoot(), fetchImpl: crippled });
  assert.equal(noCapability.ok, false);
  assert.equal(noCapability.reason, "experiment_rest_endpoint_missing");
  assert.equal(crippled.calls.filter((call) => call.method === "POST").length, 0);

  // Invalid split flag fails closed before any call.
  const badSplit = await runExperiment({ root, fetchImpl: fetchRouter({}), split: "calibration" });
  assert.equal(badSplit.ok, false);
  assert.equal(badSplit.reason, "invalid_split");
});

test("end-to-end with the real eval task: dataset example runs the real phase loop and the outputs land as experiment rows", async () => {
  const root = tempRoot();
  const domainContext = resolvedEvalDomainContext(root);
  const records = [exampleRecord({ id: "EX1" })];
  const fetchImpl = fetchRouter(baseRoutes({ records }));

  // The free orchestrator drives four library invocations (pm/sr_eng) then a
  // commit — the free-loop analog of the retired fixed four-phase order. Four
  // subagent invocations keep accepted_packet_count === 4 on the experiment row.
  const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";
  const subagentTurn = (runId, reason) => ({
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status: "continue",
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-exp-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  });
  const runtimeExecutor = {
    async executeSubagent({ runtime_role, runId }) {
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      const sessionHandle = {
        id: `${runtime_role}-session`,
        role: runtime_role,
        run_id: runId,
        runtime: runtime_role === "pm" ? "claude" : "codex",
      };
      // pm and sr_eng are each invoked twice, so the second same-role spawn
      // requires observed warm continuation (the handle + ready flag carried on
      // the role's runtime evidence — buildRuntimeMetadata validates it).
      return {
        packet: subagentTurn(runId, reason),
        role: runtime_role,
        sessionHandle,
        evidence: {
          warm_continuation_ready: true,
          handle_acquisition_mode: "captured_from_output",
          session_handle: sessionHandle,
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
  const experimentLibraryOrder = [
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/sr_eng_grounding_pass",
    "prompt/decomposition/pm_synthesis",
    "prompt/decomposition/sr_eng_blocker_check",
  ];
  let orchestratorTurn = 0;
  const orchestratorTurnExecutor = async ({ runId }) => {
    orchestratorTurn += 1;
    if (orchestratorTurn <= experimentLibraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: experimentLibraryOrder[orchestratorTurn - 1] },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: {
        context_digest: "Reviewed project intent and grounded constraints for decomposition.",
        source_refs: [{ kind: "linear_project", id: "project-exp-1" }],
        assumptions: [],
        constraints: [],
        risks: [],
        project_update_markdown: projectUpdateMarkdownForRun(runId),
        final_issues: [
          {
            decomposition_key: "project-plan",
            title: "Prepare execution setup",
            issue_body_markdown: "## Assignment\n\nPlan.\n\n## Acceptance Criteria\n\n- Plan exists.",
            depends_on: [],
            assignment: "Plan.",
            output: "A documented execution setup plan.",
            acceptance_criteria: ["Plan exists."],
          },
        ],
      },
      evidence: null,
      sessionHandle: null,
    };
  };
  const traceSink = {
    async startRun(input) {
      assert.equal(input.domainContext.domainId, "support-ops");
      return { ok: true, traceId: "e".repeat(32), status: "trace_unknown", run: { run_id: input.runId } };
    },
    async finishRun() {
      return { status: "trace_exported", phoenixAppUrl: "http://127.0.0.1:6006" };
    },
    async shutdown() {},
  };

  const result = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: "eval-ds",
    ensureReady: readyUp,
    fetchImpl,
    runtimeExecutor,
    traceSink,
    // The free orchestrator loop loads its governing prompt + library snapshots
    // from the manifest under repoRoot, so the eval task reads from the real repo
    // root; its eval-run record + artifacts still land under the experiment's
    // isolated temp root via evalRunStoreDir (what the record-custody assertion
    // below checks).
    runEvalTaskFn: (args) => runDecompositionEvalTask({
      ...args,
      repoRoot,
      evalRunStoreDir: path.join(root, ".agentic-factory", "eval-runs"),
      domainContext,
      orchestratorTurnExecutor,
    }),
    emitChecksFn: async ({ artifact, traceId }) => ({
      ok: true,
      storage: "report_only",
      run_id: artifact.run_id,
      trace_id: traceId,
      checks: [
        {
          status: "evaluated",
          name: "accepted_packet_sufficiency",
          identifier: "accepted_packet_sufficiency_offline_v1",
          annotation: {
            name: "accepted_packet_sufficiency",
            annotator_kind: "CODE",
            label: "pass",
            score: 1,
            explanation: "ok",
            identifier: "accepted_packet_sufficiency_offline_v1",
            metadata: { failure_modes: [] },
          },
        },
      ],
      emitted_count: 0,
      skipped_count: 0,
      annotation_ids: [],
    }),
    runJudgeFn: async () => ({
      ok: false,
      judge_state: "judge_missing",
      reason: "judge_runtime_failed:scripted",
      identifier: "decomposition_quality_judge_v1:test-model",
      storage: "report_only",
      annotation_ids: [],
      judge: null,
      low_confidence_reasons: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed_with_failures", "judge_missing is a recorded per-example failure");
  const runCall = fetchImpl.calls.find(
    (call) => call.method === "POST" && call.pathname === "/v1/experiments/EXP1/runs",
  );
  assert.equal(runCall.body.dataset_example_id, "EX1");
  assert.equal(runCall.body.output.status, "evaluated");
  assert.equal(runCall.body.output.terminal.status, "completed");
  assert.equal(runCall.body.output.accepted_packet_count, 4);
  assert.equal(runCall.body.trace_id, "e".repeat(32));
  // The real eval task wrote its local eval-run record under this repoRoot.
  const evalRunDir = path.join(root, ".agentic-factory", "eval-runs");
  assert.ok(fs.existsSync(evalRunDir));
  // Judge failure became an experiment evaluation ERROR row (explainable),
  // and the CODE check landed as a CODE evaluation.
  const evaluations = fetchImpl.calls.filter(
    (call) => call.method === "POST" && call.pathname === "/v1/experiment_evaluations",
  );
  assert.equal(evaluations.length, 2);
  const judgeEvaluation = evaluations.find((call) => call.body.annotator_kind === "LLM");
  assert.ok(judgeEvaluation.body.error.startsWith("judge_missing:"));
  assert.equal(judgeEvaluation.body.result, undefined);
  const codeEvaluation = evaluations.find((call) => call.body.annotator_kind === "CODE");
  assert.equal(codeEvaluation.body.result.label, "pass");
});

test("candidate target keys follow the canonical grammar and the baseline derives from the manifest", () => {
  assert.equal(
    deriveCandidateTargetKey({ judge_candidate_prompt_version_id: "ver_1", role_overrides: {} }),
    "prompt/decomposition/decomposition_quality_judge",
  );
  assert.equal(
    deriveCandidateTargetKey({ role_overrides: { pm: { model: "x" } } }),
    "rule/decomposition/runtime_role_assignments",
  );
  assert.equal(
    deriveCandidateTargetKey({
      prompt_overrides: {
        "prompt/decomposition/pm_synthesis": { candidate_prompt_version_id: "PV-PM-SYNTH" },
      },
    }),
    "prompt/decomposition/pm_synthesis",
  );
  assert.equal(
    deriveCandidateTargetKey({
      prompt_overrides: {
        [SR_ENG_TARGET_KEY]: { candidate_prompt_version_id: "PV-SR-ENG" },
        "prompt/decomposition/pm_synthesis": {},
      },
    }),
    SR_ENG_TARGET_KEY,
  );
  assert.equal(
    deriveCandidateTargetKey({ role_overrides: {} }),
    "policy/decomposition/accepted_baseline",
  );
  for (const key of [
    deriveCandidateTargetKey({ judge_candidate_prompt_version_id: "v" }),
    deriveCandidateTargetKey({ role_overrides: { pm: { model: "x" } } }),
    deriveCandidateTargetKey({}),
  ]) {
    assert.match(key, /^(prompt|evaluator_prompt|rule|schema|code_evaluator|phase|policy)\/[a-z_]+\/.+$/);
  }

  const baseline = deriveLaunchBaselineFromManifest();
  assert.equal(baseline.ok, true);
  assert.equal(baseline.baseline.accepted_baseline_id, EXPECTED_BASELINE_ID);
  assert.equal(baseline.baseline.derived_from, "phoenix_assets_manifest");
  assert.equal(
    baseline.baseline.manifest_path,
    "execution/evals/decomposition/phoenix-assets.json",
  );

  // evidence_counts helper contract shape.
  assert.deepEqual(
    computeEvidenceCounts([
      { split: "train", human_labeled: true },
      { split: "test", human_labeled: false },
      { split: null, human_labeled: true },
    ]),
    {
      train_examples: 1,
      train_human_labeled_examples: 1,
      test_examples: 1,
      test_human_labeled_examples: 0,
      human_label_authenticity: "asserted",
    },
  );
});

test("phoenix:experiment-decomposition and phoenix:experiment-amend are wired as first-class CLI tasks", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["phoenix:experiment-decomposition"],
    "node execution/integrations/linear/cli.mjs phoenix:experiment-decomposition",
  );
  assert.equal(
    packageJson.scripts["phoenix:experiment-amend"],
    "node execution/integrations/linear/cli.mjs phoenix:experiment-amend",
  );
  const cliSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "cli.mjs"),
    "utf8",
  );
  assert.ok(cliSource.includes('command === "phoenix:experiment-decomposition"'));
  assert.ok(cliSource.includes('command === "phoenix:experiment-amend"'));
  // Post-split, command bodies live in src/cli/dispatch.mjs; the wiring pin
  // follows the wiring.
  const dispatchSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "dispatch.mjs"),
    "utf8",
  );
  assert.ok(dispatchSource.includes("runDecompositionExperiment"));
  assert.ok(dispatchSource.includes("amendExperimentReceipt"));

  // No custom experiment store: the module's only local writes are the
  // receipt files; experiment results go to Phoenix REST.
  const moduleSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "phoenix-experiment.mjs"),
    "utf8",
  );
  assert.ok(moduleSource.includes("/v1/datasets/${encodeURIComponent(datasetId)}/experiments"));
  assert.ok(moduleSource.includes("/v1/experiments/${encodeURIComponent(experiment.id)}/runs"));
  assert.ok(moduleSource.includes("/v1/experiment_evaluations"));

  const receiptPath = experimentReceiptPath({ receiptId: "expr-test", repoRoot: "/tmp/x" });
  assert.ok(receiptPath.replaceAll("\\", "/").includes(".agentic-factory/experiments/expr-test.json"));
});
