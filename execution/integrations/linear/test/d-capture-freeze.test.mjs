import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import { captureProjectSnapshot } from "../src/project-snapshot-store.mjs";
import {
  buildRichDecompositionExample,
  DEFAULT_RICH_DATASET_NAME,
  promoteRichDecompositionExample,
  promotionReceiptPath,
  validateExampleAgainstSchema,
} from "../src/rich-promotion.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";
import { loadWorkspaceEvalPolicy } from "../src/workspace-eval-policy.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const policy = loadWorkspaceEvalPolicy();

function tempRepoRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `teami-d-capture-${label}-`));
  process.env.TEAMI_HOME = root;
  return root;
}

function sampleProject() {
  return {
    id: "proj-1",
    name: "Onboarding email refresh",
    description: "Refresh onboarding.",
    content: "## Goal\nHelp users reach the first useful action.",
    labels: [],
    issues: [],
  };
}

function snapshot() {
  return {
    project: {
      id: "proj-1",
      name: "Onboarding email refresh",
      description: "Refresh onboarding.",
      content: "## Goal\nHelp users reach the first useful action.",
      labels: [],
      status: "Planned",
      existing_issues: [],
    },
  };
}

function commitArtifact(runId, overrides = {}) {
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: runId,
    team_ref: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "commit",
      reason: "synthesis_complete",
      context_digest: "loaded project snapshot",
      source_refs: ["linear:project:proj-1"],
      assumptions: [],
      constraints: [],
      risks: [],
    },
    evidence: {
      perspectives_run: [
        { role: "pm", outcome: "synthesis_complete" },
        { role: "sr_eng", outcome: "no_blockers" },
      ],
    },
    bounds: { rounds_used: 1, max_rounds: 4 },
    runtime_assignments: {
      pm: { runtime: "claude", model: "claude-opus-4-8" },
      sr_eng: { runtime: "codex", model: "gpt-5.5" },
    },
    runtime_metadata: { pm: {}, sr_eng: {} },
    final_issues: [
      {
        decomposition_key: "onboarding/copy",
        title: "Draft onboarding copy",
        issue_body_markdown: "Draft copy.\n\n**Acceptance**\n- Copy is approved",
        depends_on: [],
      },
    ],
    project_update_markdown: `run_id: ${runId}\nDecomposed the onboarding update.`,
    produced_identities: [
      {
        effect_id: "linear_issues",
        provider: "linear",
        resource_kind: "linear_issue",
        target_ids: ["issue-1", "issue-2"],
        identity: {
          issue_ids: ["issue-1", "issue-2"],
          dependency_relation_ids: [],
          project_update_id: "project-update-1",
        },
      },
    ],
    ...overrides,
  };
}

function setUpPromotableRun({ repoRoot, runId, artifact = commitArtifact(runId) }) {
  recordTraceStatus({
    repoRoot,
    runId,
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "proj-1",
    traceId: TRACE_ID,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt: "2026-06-10T00:00:00.000Z",
  });
  writeRunArtifact({ repoRoot, runId }, artifact);
  captureProjectSnapshot({
    repoRoot,
    runId,
    teamRef: artifact.team_ref,
    project: sampleProject(),
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T00:00:01.000Z",
  });
}

function humanQualityAnnotation({ id = "anno-human", label = "pass", score = 0.9 } = {}) {
  return {
    id,
    name: "quality",
    annotator_kind: "HUMAN",
    identifier: "adopter-fixture-owner",
    result: {
      label,
      score,
      explanation: "Human fixture label resolved at save time.",
    },
    metadata: {
      failure_modes: [],
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
    },
    created_at: "2026-06-10T00:05:00.000Z",
  };
}

function phoenixFetchMock({ calls = [], traceAnnotations = [], datasetExists = false } = {}) {
  return async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (call.url.includes("/v1/projects/teami/trace_annotations")) {
      return new Response(JSON.stringify({ data: traceAnnotations, next_cursor: null }), { status: 200 });
    }
    if (call.url.includes("/v1/datasets?")) {
      return new Response(JSON.stringify({
        data: datasetExists ? [{ name: DEFAULT_RICH_DATASET_NAME, id: "dataset-1" }] : [],
      }), { status: 200 });
    }
    if (call.url.includes("/v1/datasets/upload")) {
      return new Response(JSON.stringify({
        data: { dataset_id: "dataset-1", version_id: "version-1", num_created_examples: 1 },
      }), { status: 200 });
    }
    throw new Error(`unexpected phoenix URL ${call.url}`);
  };
}

test("D-capture freezes explicit human label provenance and produced target refs on the rich example row", () => {
  const runId = "run-d-capture-freeze-1";
  const build = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot: snapshot(),
    policy,
    annotationIds: ["anno-human"],
    humanFixtureLabel: {
      label: "pass",
      score: 0.9,
      labeled_at: "2026-06-10T00:05:00.000Z",
      annotator_id: "adopter-fixture-owner",
    },
  });

  assert.equal(build.ok, true);
  assert.deepEqual(build.example.reference, {
    human_annotations: [],
    human_annotation_ids: ["anno-human"],
    expected_label: "pass",
    expected_score: 0.9,
    provenance: {
      label_source: "explicit_human",
      label_status: "GOLD",
      labeled_at: "2026-06-10T00:05:00.000Z",
      annotator_id: "adopter-fixture-owner",
    },
  });
  assert.deepEqual(build.example.metadata.source_target_ids, ["issue-1", "issue-2"]);
  assert.deepEqual(build.example.metadata.produced_identity_refs, [{
    effect_id: "linear_issues",
    provider: "linear",
    resource_kind: "linear_issue",
    target_ids: ["issue-1", "issue-2"],
  }]);
  assert.deepEqual(validateExampleAgainstSchema(build.example), []);
});

test("D-capture accepts an explicit human score outside the resolved label band", () => {
  const runId = "run-d-capture-band-1";
  const build = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot: snapshot(),
    policy,
    annotationIds: ["anno-human"],
    humanFixtureLabel: {
      label: "pass",
      score: 0.6,
      labeled_at: "2026-06-10T00:05:00.000Z",
      annotator_id: "adopter-fixture-owner",
    },
  });

  assert.equal(build.ok, true);
  assert.equal(build.example.reference.expected_label, "pass");
  assert.equal(build.example.reference.expected_score, 0.6);
});

test("D-capture resolves HUMAN annotations at save time and does not rewrite the saved fixture on later annotation drift", async () => {
  const repoRoot = tempRepoRoot("annotation-drift");
  const runId = "run-d-capture-promotion-1";
  setUpPromotableRun({ repoRoot, runId });

  const firstCalls = [];
  const first = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    annotationIds: ["anno-human"],
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "teami" }),
    fetchImpl: phoenixFetchMock({
      calls: firstCalls,
      traceAnnotations: [humanQualityAnnotation()],
    }),
    now: () => "2026-06-10T01:00:00.000Z",
  });

  assert.equal(first.ok, true);
  const upload = firstCalls.find((call) => call.url.includes("/v1/datasets/upload"));
  assert.equal(upload.body.metadata[0].reference.expected_label, "pass");
  assert.equal(upload.body.metadata[0].reference.expected_score, 0.9);
  assert.deepEqual(upload.body.metadata[0].source_target_ids, ["issue-1", "issue-2"]);

  const second = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    annotationIds: ["anno-human"],
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "teami" }),
    fetchImpl: phoenixFetchMock({
      traceAnnotations: [humanQualityAnnotation({ label: "needs_revision", score: 0.6 })],
      datasetExists: true,
    }),
    now: () => "2026-06-10T02:00:00.000Z",
  });

  assert.equal(second.ok, false);
  assert.equal(second.state, "duplicate_changed_content");
  assert.notEqual(second.new_content_hash, first.example_content_hash);
  const receipt = JSON.parse(fs.readFileSync(
    promotionReceiptPath({ repoRoot, runId, teamRef: "support-ops" }),
    "utf8",
  ));
  assert.equal(receipt.datasets[0].promotions.length, 1);
  assert.equal(receipt.datasets[0].promotions[0].example_content_hash, first.example_content_hash);
});

test("D-capture refuses non-HUMAN annotations as tuning labels", async () => {
  const repoRoot = tempRepoRoot("non-human");
  const runId = "run-d-capture-non-human-1";
  setUpPromotableRun({ repoRoot, runId });

  const calls = [];
  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    annotationIds: ["anno-llm"],
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006", projectName: "teami" }),
    fetchImpl: phoenixFetchMock({
      calls,
      traceAnnotations: [{
        ...humanQualityAnnotation({ id: "anno-llm" }),
        annotator_kind: "LLM",
        identifier: "decomposition_quality_judge_v1:test-model",
      }],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, "cannot_promote");
  assert.equal(result.reason, "human_fixture_label_requires_human_annotation");
  assert.equal(calls.some((call) => call.url.includes("/v1/datasets/upload")), false);
  assert.equal(fs.existsSync(promotionReceiptPath({ repoRoot, runId, teamRef: "support-ops" })), false);
});
