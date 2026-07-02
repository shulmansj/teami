import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyDeniedContentKey,
  findTokenShapedContent,
  RICH_EXAMPLE_CONTENT_POLICY,
  sanitizeAndClassifyContent,
  sanitizeStringContent,
} from "../src/eval-content-gate.mjs";
import { buildDatasetUploadPayloadFromTraceReceipt } from "../src/phoenix-self-improvement.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import { captureProjectSnapshot } from "../src/project-snapshot-store.mjs";
import {
  buildRichDecompositionExample,
  computeExampleContentHash,
  DEFAULT_RICH_DATASET_NAME,
  promoteRichDecompositionExample,
  promotionReceiptPath,
  validateExampleAgainstSchema,
} from "../src/rich-promotion.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";
import {
  assignDatasetSplit,
  FLAG_ONLY_SPLITS,
  loadWorkspaceEvalPolicy,
  resolveProjectCategory,
  workspaceEvalPolicyValidationFailures,
} from "../src/workspace-eval-policy.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
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
const TERMINAL_AUDIT_FIELDS = Object.freeze({
  context_digest: "digest-of-loaded-context",
  source_refs: ["linear:project:proj-1"],
  assumptions: ["existing provider stays"],
  constraints: ["no new tracking domains"],
  risks: ["copy approval may slip"],
});

function tempRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `teami-rich-promotion-${label}-`));
}

function commitArtifact(runId, overrides = {}) {
  const projectUpdate = `run_id: ${runId}\nDecomposed the refresh into two sequenced issues.`;
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
      ...TERMINAL_AUDIT_FIELDS,
    },
    evidence: {
      perspectives_run: [
        { role: "pm", outcome: "synthesis_complete" },
        { role: "sr_eng", outcome: "no_blockers" },
      ],
    },
    bounds: { rounds_used: 2, max_rounds: 4 },
    runtime_assignments: {
      pm: { runtime: "claude", model: "claude-opus-4-8" },
      sr_eng: { runtime: "codex", model: "gpt-5.5" },
    },
    runtime_metadata: { pm: {}, sr_eng: {} },
    final_issues: [
      {
        decomposition_key: "area/copy",
        title: "Draft refreshed copy",
        issue_body_markdown: "Write replacement copy.\n\n**Acceptance**\n- observable check",
        depends_on: [],
        assignee_id: "user-1",
        label_ids: ["label-1"],
      },
      {
        decomposition_key: "area/wire",
        title: "Wire refreshed copy",
        issue_body_markdown: "Update templates. Spec: https://example.com/spec",
        depends_on: ["area/copy"],
        assignee_id: "user-1",
        label_ids: [],
      },
    ],
    project_update_markdown: projectUpdate,
    ...overrides,
  };
}

function pauseArtifact(runId) {
  const projectUpdate = `run_id: ${runId}\nPaused on open product questions.`;
  const openQuestions = "- Which provider tier should we keep?";
  const pausePacket = {
    schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
    run_id: runId,
    phase: "orchestrator_terminal",
    status: "pause",
    reason: "product_questions",
    ...TERMINAL_AUDIT_FIELDS,
    open_questions_markdown: openQuestions,
    project_update_markdown: projectUpdate,
  };
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "pause",
    run_id: runId,
    ...ARTIFACT_IDENTITY,
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "pause",
      reason: "product_questions",
      ...TERMINAL_AUDIT_FIELDS,
    },
    evidence: { perspectives_run: [{ role: "pm", outcome: "product_questions" }] },
    bounds: { rounds_used: 1, max_rounds: 4 },
    runtime_assignments: {
      pm: { runtime: "claude", model: "claude-opus-4-8" },
      sr_eng: { runtime: "codex", model: "gpt-5.5" },
    },
    runtime_metadata: { pm: {}, sr_eng: {} },
    pause_packet: pausePacket,
    discovery_issues: [],
  };
}

function recordTestTraceStatus(options) {
  return recordTraceStatus({ ...TRACE_IDENTITY, ...options });
}

function sampleProject() {
  return {
    id: "proj-1",
    name: "Onboarding email refresh",
    description: "Refresh the onboarding sequence.",
    content: "## Goal\nReach the first useful action within one session.",
    labels: [{ id: "lbl-web", name: "web" }],
    issues: [
      {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Existing tracking issue",
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        labels: [],
      },
    ],
  };
}

function setUpPromotableRun({ repoRoot, runId, artifact = null, project = sampleProject() }) {
  recordTestTraceStatus({
    repoRoot,
    runId,
    projectId: project.id,
    traceId: TRACE_ID,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt: "2026-06-10T00:00:00.000Z",
  });
  writeRunArtifact({ runId, repoRoot }, artifact || commitArtifact(runId));
  captureProjectSnapshot({
    runId,
    project,
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T00:00:01.000Z",
    repoRoot,
  });
}

function phoenixFetchMock({
  datasetExists = false,
  failSplits = false,
  calls = [],
  traceAnnotations = [],
} = {}) {
  return async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (call.url.includes("/v1/datasets?")) {
      return new Response(JSON.stringify({
        data: datasetExists ? [{ name: DEFAULT_RICH_DATASET_NAME, id: "RGF0YXNldDox" }] : [],
      }), { status: 200 });
    }
    if (call.url.includes("/v1/projects/teami/trace_annotations")) {
      return new Response(JSON.stringify({ data: traceAnnotations, next_cursor: null }), { status: 200 });
    }
    assert.match(call.url, /\/v1\/datasets\/upload\?sync=true$/);
    if (failSplits && call.body.splits) {
      return new Response(JSON.stringify({ detail: "splits is not a supported upload field" }), { status: 422 });
    }
    return new Response(JSON.stringify({
      data: { dataset_id: "RGF0YXNldDox", version_id: "RGF0YXNldFZlcnNpb246MQ==", num_created_examples: 1 },
    }), { status: 200 });
  };
}

const policy = loadWorkspaceEvalPolicy();

// ---------------------------------------------------------------------------
// Workspace eval policy
// ---------------------------------------------------------------------------

test("workspace eval policy artifact is valid, human-set, and structurally pinned", () => {
  assert.equal(policy.schema_version, "teami-workspace-eval-policy/v1");
  assert.equal(policy.workspace_maturity, "new");
  assert.equal(policy.project_category.default, "code");
  assert.equal(policy.project_impact_level.default, "low");
  assert.equal(policy.split_assignment.method, "sha256_of_example_id_mod_total_buckets");
  // Default test fraction: 1 bucket of 5 => 4:1 train:test.
  assert.equal(policy.split_assignment.test_buckets, 1);
  assert.equal(policy.split_assignment.total_buckets, 5);
  assert.deepEqual(policy.split_assignment.flag_only_splits, ["calibration", "regression"]);
  assert.deepEqual([...FLAG_ONLY_SPLITS], ["calibration", "regression"]);

  // Structural validation rejects drifted policies.
  assert.deepEqual(workspaceEvalPolicyValidationFailures(policy), []);
  assert.ok(workspaceEvalPolicyValidationFailures({ ...policy, workspace_maturity: "expert" })
    .includes("invalid_workspace_maturity"));
  assert.ok(workspaceEvalPolicyValidationFailures({
    ...policy,
    project_category: { default: "everything", overrides: {} },
  }).includes("invalid_project_category_default"));
  assert.ok(workspaceEvalPolicyValidationFailures({
    ...policy,
    split_assignment: { ...policy.split_assignment, test_buckets: 5 },
  }).includes("split_test_buckets_must_be_less_than_total_buckets"));
  assert.ok(workspaceEvalPolicyValidationFailures({
    ...policy,
    split_assignment: { ...policy.split_assignment, flag_only_splits: ["calibration"] },
  }).includes("invalid_flag_only_splits"));
});

test("split assignment is deterministic by example id and flag-only for calibration/regression", () => {
  const first = assignDatasetSplit(policy, { exampleId: "teami:run-stable" });
  const second = assignDatasetSplit(policy, { exampleId: "teami:run-stable" });
  assert.deepEqual(first, second, "same example id must always produce the same assignment");
  assert.ok(["train", "test"].includes(first.split));

  // The hash rule matches its documented definition exactly.
  const digest = createHash("sha256").update("teami:run-stable", "utf8").digest();
  const expectedBucket = Number(digest.readBigUInt64BE(0) % 5n);
  assert.equal(first.bucket, expectedBucket);
  assert.equal(first.split, expectedBucket < 1 ? "test" : "train");

  // Both splits occur across many ids (deterministic spread, no counter).
  const splits = new Set();
  for (let index = 0; index < 64; index += 1) {
    splits.add(assignDatasetSplit(policy, { exampleId: `teami:run-${index}` }).split);
  }
  assert.deepEqual([...splits].sort(), ["test", "train"]);

  // calibration/regression are explicit-flag-only; train/test can never be forced.
  const calibration = assignDatasetSplit(policy, {
    exampleId: "teami:run-stable",
    explicitSplit: "calibration",
  });
  assert.equal(calibration.split, "calibration");
  assert.equal(calibration.method, "explicit_flag");
  assert.throws(
    () => assignDatasetSplit(policy, { exampleId: "x", explicitSplit: "test" }),
    /only calibration\|regression/,
  );

  // Category/impact overrides resolve by project id with policy default fallback.
  const overridden = {
    ...policy,
    project_category: { default: "code", overrides: { "proj-marketing": "marketing" } },
  };
  assert.deepEqual(
    resolveProjectCategory(overridden, { projectId: "proj-marketing" }),
    { value: "marketing", source: "project_id_override" },
  );
  assert.deepEqual(
    resolveProjectCategory(overridden, { projectId: "proj-other" }),
    { value: "code", source: "policy_default" },
  );
});

// ---------------------------------------------------------------------------
// Content gate
// ---------------------------------------------------------------------------

test("content gate refuses token-shaped content (mandatory but not sufficient)", () => {
  const fakePat = ["gh", "p_", "abcdefghijklmnopqrstuvwx"].join("");
  const fakePrivateKeyHeader = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
  const tokens = [
    ["Bearer ", "abcdefghijklmnopqrstuvwxyz"].join(""),
    ["sk", "-", "abcdefghijklmnopqrstuvwx"].join(""),
    fakePat,
    ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    fakePrivateKeyHeader,
    ["https://user", ":", "hunter2@internal.example.com/x"].join(""),
  ];
  for (const token of tokens) {
    const result = sanitizeAndClassifyContent({
      value: { input: { project: { content: `body with ${token}` } } },
      policy: RICH_EXAMPLE_CONTENT_POLICY,
    });
    assert.equal(result.ok, false, `token must fail the gate: ${token.slice(0, 12)}…`);
    assert.equal(result.state, "cannot_promote");
    assert.equal(result.reason, "token_or_secret_like");
    assert.ok(result.secret_paths.length > 0);
  }

  // Secret-shaped KEYS fail closed too, even with boring values.
  const keyResult = sanitizeAndClassifyContent({
    value: { input: { project: { api_key: "not-really" } } },
    policy: RICH_EXAMPLE_CONTENT_POLICY,
  });
  assert.equal(keyResult.ok, false);
  assert.equal(keyResult.reason, "token_or_secret_like");

  assert.ok(findTokenShapedContent({ note: `uses ${fakePat}` }).length > 0);
});

test("content gate rejects unknown fields into needs_sanitization, never silently passes them", () => {
  const result = sanitizeAndClassifyContent({
    value: {
      input: {
        project: {
          id: "proj-1",
          mystery_payload: { anything: true },
        },
      },
    },
    policy: RICH_EXAMPLE_CONTENT_POLICY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "needs_sanitization");
  assert.equal(result.reason, "unclassified_content");
  assert.ok(result.unclassified_paths.some((entry) => entry.includes("$.input.project.mystery_payload")));
});

test("content gate removes denylisted content classes and reports every removal and transform", () => {
  const result = sanitizeAndClassifyContent({
    value: {
      output: {
        terminal_status: "completed",
        phase_packets: [{
          phase: "pm_synthesis",
          status: "continue",
          reason: "synthesis_complete",
          prompt: "FULL RAW PHASE PROMPT — never promoted",
          tool_transcript: ["call 1", "call 2"],
          shell_output: "$ rm -rf",
          repo_snippet: "function secretSauce() {}",
          source_refs: ["repo:teami:execution/x.mjs"],
          project_update_markdown: "See http://127.0.0.1:6006/projects/p/traces/t and https://linear.app/team/issue/ENG-1",
        }],
      },
    },
    policy: RICH_EXAMPLE_CONTENT_POLICY,
  });
  assert.equal(result.ok, true);
  const removedPaths = result.report.removed.map((entry) => entry.path);
  for (const expected of [
    "$.output.phase_packets[0].prompt",
    "$.output.phase_packets[0].tool_transcript",
    "$.output.phase_packets[0].shell_output",
    "$.output.phase_packets[0].repo_snippet",
    "$.output.phase_packets[0].source_refs",
  ]) {
    assert.ok(removedPaths.includes(expected), `sanitizer report must list removal of ${expected}`);
  }
  const removedRules = new Map(result.report.removed.map((entry) => [entry.path, entry.rule]));
  assert.equal(removedRules.get("$.output.phase_packets[0].prompt"), "prompt_content");
  assert.equal(removedRules.get("$.output.phase_packets[0].shell_output"), "shell_output");
  assert.equal(removedRules.get("$.output.phase_packets[0].source_refs"), "source_refs_not_promoted");
  // Removed content is gone from the sanitized value.
  const sanitizedPacket = result.value.output.phase_packets[0];
  assert.equal(sanitizedPacket.prompt, undefined);
  assert.equal(sanitizedPacket.shell_output, undefined);
  // Private/loopback URL redacted with a reported transform; public URL kept.
  assert.ok(sanitizedPacket.project_update_markdown.includes("[redacted-private-url]"));
  assert.ok(sanitizedPacket.project_update_markdown.includes("https://linear.app/team/issue/ENG-1"));
  assert.ok(result.report.transformed.some((entry) =>
    entry.rule === "private_url_redacted" && entry.path === "$.output.phase_packets[0].project_update_markdown"));
  assert.equal(result.report.removed_count, result.report.removed.length);

  assert.equal(classifyDeniedContentKey("prompt"), "prompt_content");
  assert.equal(classifyDeniedContentKey("customer_email_address"), "customer_data");
  assert.equal(classifyDeniedContentKey("issue_body_markdown"), null);

  const { value: cleaned, transformed } = sanitizeStringContent("file://C:/secrets.txt and https://example.com");
  assert.ok(cleaned.includes("[redacted-url]"));
  assert.ok(cleaned.includes("https://example.com"));
  assert.equal(transformed[0].rule, "non_http_url_redacted");
});

// ---------------------------------------------------------------------------
// Rich promotion pipeline
// ---------------------------------------------------------------------------

test("rich promotion fails closed on missing receipt, artifact, or snapshot, naming the run id", async () => {
  const neverFetch = async () => {
    throw new Error("no network call is allowed on fail-closed paths");
  };
  const neverReady = async () => {
    throw new Error("Phoenix must not be started on fail-closed paths");
  };

  // Missing trace receipt.
  const missingReceiptRoot = tempRepoRoot("missing-receipt");
  const noReceipt = await promoteRichDecompositionExample({
    repoRoot: missingReceiptRoot,
    runId: "run-missing-receipt",
    ensureReady: neverReady,
    fetchImpl: neverFetch,
  });
  assert.deepEqual(
    { ok: noReceipt.ok, state: noReceipt.state, reason: noReceipt.reason, run_id: noReceipt.run_id },
    { ok: false, state: "cannot_promote", reason: "missing_trace_receipt", run_id: "run-missing-receipt" },
  );

  // Receipt exists, run artifact missing.
  const missingArtifactRoot = tempRepoRoot("missing-artifact");
  recordTestTraceStatus({
    repoRoot: missingArtifactRoot,
    runId: "run-missing-artifact",
    traceId: TRACE_ID,
    status: "trace_exported",
  });
  const noArtifact = await promoteRichDecompositionExample({
    repoRoot: missingArtifactRoot,
    runId: "run-missing-artifact",
    ensureReady: neverReady,
    fetchImpl: neverFetch,
  });
  assert.equal(noArtifact.ok, false);
  assert.equal(noArtifact.reason, "missing_run_artifact");
  assert.equal(noArtifact.run_id, "run-missing-artifact");

  // Receipt + artifact exist, captured snapshot missing: NO live Linear fallback.
  const missingSnapshotRoot = tempRepoRoot("missing-snapshot");
  recordTestTraceStatus({
    repoRoot: missingSnapshotRoot,
    runId: "run-missing-snapshot",
    traceId: TRACE_ID,
    status: "trace_exported",
  });
  writeRunArtifact({ runId: "run-missing-snapshot", repoRoot: missingSnapshotRoot }, commitArtifact("run-missing-snapshot"));
  const noSnapshot = await promoteRichDecompositionExample({
    repoRoot: missingSnapshotRoot,
    runId: "run-missing-snapshot",
    ensureReady: neverReady,
    fetchImpl: neverFetch,
  });
  assert.equal(noSnapshot.ok, false);
  assert.equal(noSnapshot.state, "cannot_promote");
  assert.equal(noSnapshot.reason, "missing_project_snapshot");
  assert.equal(noSnapshot.run_id, "run-missing-snapshot");
  assert.match(noSnapshot.detail, /live Linear state is never used/);
});

test("rich promotion rejects a short Judge-input capture before upload", () => {
  const runId = "run-rich-short-capture-1";
  const artifact = commitArtifact(runId);
  delete artifact.project_update_markdown;
  const result = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact,
    snapshot: {
      project: {
        ...sampleProject(),
        status: "Planned",
        existing_issues: [],
      },
    },
    policy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "cannot_promote");
  assert.equal(result.reason, "judge_input_incomplete");
  assert.ok(result.failures.includes("missing:project_update_markdown"));
});

test("rich promotion assembles a schema-valid example field-for-field, uploads with native splits, and records the receipt", async () => {
  const repoRoot = tempRepoRoot("happy");
  const runId = "run-rich-commit-1";
  setUpPromotableRun({ repoRoot, runId });

  const calls = [];
  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    annotationIds: ["anno-1", "anno-2"],
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({
      calls,
      traceAnnotations: [{
        id: "anno-1",
        name: "quality",
        annotator_kind: "HUMAN",
        identifier: "adopter-fixture-owner",
        result: {
          label: "pass",
          score: 0.9,
          explanation: "The decomposition is executable and preserves the project intent.",
        },
        metadata: {
          failure_modes: [],
          rubric_version: "1.0.0",
          failure_taxonomy_version: "1.0.0",
        },
        created_at: "2026-06-10T00:05:00.000Z",
      }, {
        id: "anno-2",
        name: "human_decision_load",
        annotator_kind: "HUMAN",
        identifier: "adopter-fixture-owner",
        result: {
          label: "pass",
          score: 0.9,
          explanation: "The human has little residual decision load.",
        },
        metadata: {
          failure_modes: [],
          rubric_version: "1.0.0",
          failure_taxonomy_version: "1.0.0",
        },
        created_at: "2026-06-10T00:05:01.000Z",
      }],
    }),
    now: () => "2026-06-10T01:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.uploaded, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.datasetName, DEFAULT_RICH_DATASET_NAME);
  assert.equal(result.action, "create");
  assert.equal(result.dataset_id, "RGF0YXNldDox");
  assert.equal(result.dataset_version_id, "RGF0YXNldFZlcnNpb246MQ==");
  assert.equal(result.split_assignment, "native");
  assert.match(result.example_content_hash, /^[0-9a-f]{64}$/);

  const expectedSplit = assignDatasetSplit(policy, { exampleId: `teami:${runId}` }).split;
  assert.equal(result.split, expectedSplit);

  // Upload call shape: native per-example splits at upload time.
  const upload = calls.find((call) => call.url.includes("/v1/datasets/upload"));
  assert.ok(upload, "expected a dataset upload call");
  assert.deepEqual(upload.body.splits, [expectedSplit]);
  assert.equal(upload.body.name, DEFAULT_RICH_DATASET_NAME);
  assert.equal(upload.body.action, "create");

  // Example field-for-field (input/output/reference/metadata).
  const terminalOutputSummary = () => ({
    schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
    run_id: runId,
    phase: "orchestrator_output",
    status: "commit",
    reason: "synthesis_complete",
    context_digest: "digest-of-loaded-context",
    assumptions: ["existing provider stays"],
    constraints: ["no new tracking domains"],
    risks: ["copy approval may slip"],
    project_update_markdown: `run_id: ${runId}\nDecomposed the refresh into two sequenced issues.`,
  });
  const expectedProject = {
    id: "proj-1",
    name: "Onboarding email refresh",
    description: "Refresh the onboarding sequence.",
    content: "## Goal\nReach the first useful action within one session.",
    status: "Planned",
    labels: [{ id: "lbl-web", name: "web" }],
    existing_issues: [{
      id: "issue-1",
      identifier: "ENG-1",
      title: "Existing tracking issue",
      state: { id: "state-1", name: "Todo", type: "unstarted" },
      labels: [],
    }],
  };
  const expectedFinalIssues = [
    {
      decomposition_key: "area/copy",
      title: "Draft refreshed copy",
      issue_body_markdown: "Write replacement copy.\n\n**Acceptance**\n- observable check",
      depends_on: [],
    },
    {
      decomposition_key: "area/wire",
      title: "Wire refreshed copy",
      issue_body_markdown: "Update templates. Spec: https://example.com/spec",
      depends_on: ["area/copy"],
    },
  ];
  const expectedMaintainerContext = upload.body.inputs[0].maintainer_supplied_context;
  assert.deepEqual(Object.keys(expectedMaintainerContext), [
    "rubric_version",
    "failure_taxonomy_version",
    "allowed_failure_modes",
  ]);
  assert.ok(expectedMaintainerContext.allowed_failure_modes.includes("missing_acceptance_criteria"));
  assert.deepEqual(upload.body.inputs[0], {
    gradeability: "full_input",
    judge_fixture_input: {
      project_intent: expectedProject,
      terminal_status: "completed",
      terminal_reason: "synthesis_complete",
      final_issues: expectedFinalIssues,
      discovery_issues: [],
      dependency_relations: [{ blocking: "area/copy", blocked: "area/wire" }],
      project_update_markdown: `run_id: ${runId}\nDecomposed the refresh into two sequenced issues.`,
      open_questions_markdown: null,
      phase_packet_summaries: [{
        phase: "orchestrator_terminal",
        status: "commit",
        reason: "synthesis_complete",
        context_digest: "digest-of-loaded-context",
        source_refs: ["linear:project:proj-1"],
        assumptions: ["existing provider stays"],
        constraints: ["no new tracking domains"],
        risks: ["copy approval may slip"],
        perspectives_run: [
          { role: "pm", outcome: "synthesis_complete" },
          { role: "sr_eng", outcome: "no_blockers" },
        ],
      }],
    },
    maintainer_supplied_context: expectedMaintainerContext,
    source_type: "linear_project_snapshot",
    project: expectedProject,
    run_envelope: {
      workflow_version: "0.2.0",
      allowed_source_boundaries: [],
      runtime_assignments: { pm: "claude/claude-opus-4-8", sr_eng: "codex/gpt-5.5" },
    },
    source_refs: [],
  });
  assert.deepEqual(upload.body.outputs[0], {
    terminal_status: "completed",
    terminal_reason: "synthesis_complete",
    phase_packets: [terminalOutputSummary()],
    final_issues: expectedFinalIssues,
    discovery_issues: [],
    dependency_relations: [{ blocking: "area/copy", blocked: "area/wire" }],
    project_update_markdown: `run_id: ${runId}\nDecomposed the refresh into two sequenced issues.`,
  });
  assert.deepEqual(upload.body.metadata[0], {
    workspace_maturity: "new",
    project_category: "code",
    project_impact_level: "low",
    lifecycle_state: "active",
    dataset_split: expectedSplit,
    process_version: "0.2.0",
    rubric_version: "1.0.0",
    failure_taxonomy_version: "1.0.0",
    source_trace_id: TRACE_ID,
    source_run_id: runId,
    source_target_ids: [],
    produced_identity_refs: [],
    content_retention: "rich_local",
    schema_version: "decomposition-eval-example/v1",
    reference: {
      human_annotations: [],
      human_annotation_ids: ["anno-1", "anno-2"],
      expected_label: "pass",
      expected_score: 0.9,
      provenance: {
        label_source: "explicit_human",
        label_status: "GOLD",
        labeled_at: "2026-06-10T00:05:00.000Z",
        annotator_id: "adopter-fixture-owner",
      },
    },
  });
  // The sanitizer report and raw denylisted fields never reach Phoenix.
  const uploadJson = JSON.stringify(upload.body);
  assert.doesNotMatch(uploadJson, /sanitizer_report|source_refs_not_promoted|assignee_id|label_ids/);
  assert.doesNotMatch(uploadJson, /"prompt"|shell_output|repo_snippet/);

  // The assembled example passes the SAME structural checks the eval-contract
  // tests use, before upload.
  const build = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot: {
      project: upload.body.inputs[0].project,
    },
    policy,
    annotationIds: ["anno-1", "anno-2"],
    humanFixtureLabel: {
      label: "pass",
      score: 0.9,
      labeled_at: "2026-06-10T00:05:00.000Z",
      annotator_id: "adopter-fixture-owner",
    },
  });
  assert.equal(build.ok, true);
  assert.deepEqual(validateExampleAgainstSchema(build.example), []);
  assert.equal(build.content_hash, computeExampleContentHash(build.example));

  // Sanitizer report lists every removal (issue routing ids + terminal audit source_refs).
  const removedPaths = result.sanitizer_report.removed.map((entry) => entry.path);
  for (const expected of [
    "$.output.final_issues[0].assignee_id",
    "$.output.final_issues[0].label_ids",
    "$.output.final_issues[1].assignee_id",
    "$.output.final_issues[1].label_ids",
    "$.output.phase_packets[0].source_refs",
  ]) {
    assert.ok(removedPaths.includes(expected), `sanitizer report must include ${expected}`);
  }

  // Local promotion receipt: dataset + version + split + content hash + report.
  const receiptFile = promotionReceiptPath({ runId, repoRoot });
  assert.equal(result.receipt_path, receiptFile);
  const promotionReceipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(promotionReceipt.schema_version, "linear-decomposition-promotion-receipt/v1");
  assert.equal(promotionReceipt.run_id, runId);
  assert.equal(promotionReceipt.datasets.length, 1);
  const datasetEntry = promotionReceipt.datasets[0];
  assert.equal(datasetEntry.name, DEFAULT_RICH_DATASET_NAME);
  assert.equal(datasetEntry.dataset_id, "RGF0YXNldDox");
  assert.equal(datasetEntry.promotions.length, 1);
  const event = datasetEntry.promotions[0];
  assert.equal(event.dataset_version_id, "RGF0YXNldFZlcnNpb246MQ==");
  assert.equal(event.split, expectedSplit);
  assert.equal(event.split_assignment, "native");
  assert.equal(event.example_content_hash, result.example_content_hash);
  assert.deepEqual(event.annotation_ids, ["anno-1", "anno-2"]);
  assert.equal(event.content_retention, "rich_local");
  assert.ok(event.sanitizer_report.removed.length > 0, "receipt stores the sanitizer report locally");
});

test("paused runs promote with open questions and authored pause update", async () => {
  const repoRoot = tempRepoRoot("paused");
  const runId = "run-rich-pause-1";
  setUpPromotableRun({ repoRoot, runId, artifact: pauseArtifact(runId) });

  const calls = [];
  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({ calls }),
  });
  assert.equal(result.ok, true);
  const upload = calls.find((call) => call.url.includes("/v1/datasets/upload"));
  assert.equal(upload.body.outputs[0].terminal_status, "paused");
  assert.equal(upload.body.outputs[0].terminal_reason, "product_questions");
  assert.equal(upload.body.outputs[0].open_questions_markdown, "- Which provider tier should we keep?");
  assert.match(upload.body.outputs[0].project_update_markdown, /Paused on open product questions/);
  assert.deepEqual(upload.body.outputs[0].final_issues, []);
});

test("re-promotion with identical content is idempotent and never re-uploads", async () => {
  const repoRoot = tempRepoRoot("idempotent");
  const runId = "run-rich-idem-1";
  setUpPromotableRun({ repoRoot, runId });

  const firstCalls = [];
  const first = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({ calls: firstCalls }),
  });
  assert.equal(first.ok, true);
  assert.equal(first.uploaded, true);

  const secondCalls = [];
  const second = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("idempotent reuse must not touch Phoenix");
    },
    fetchImpl: async () => {
      throw new Error("idempotent reuse must not make any network call");
    },
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.uploaded, false);
  assert.equal(second.example_content_hash, first.example_content_hash);
  assert.equal(second.dataset_id, first.dataset_id);
  assert.match(second.detail, /already promoted .* identical content/);
  assert.equal(secondCalls.length, 0);

  // The receipt still records exactly one promotion event.
  const promotionReceipt = JSON.parse(fs.readFileSync(promotionReceiptPath({ runId, repoRoot }), "utf8"));
  assert.equal(promotionReceipt.datasets[0].promotions.length, 1);
});

test("changed content without --force-new-version is an explicit duplicate report; with it, a new version is recorded", async () => {
  const repoRoot = tempRepoRoot("changed");
  const runId = "run-rich-changed-1";
  setUpPromotableRun({ repoRoot, runId });

  const first = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({}),
  });
  assert.equal(first.ok, true);

  // Content changes (re-authored update) -> explicit duplicate/changed report.
  writeRunArtifact({ runId, repoRoot }, commitArtifact(runId, {
    project_update_markdown: `run_id: ${runId}\nRe-authored update after review.`,
  }));
  const blocked = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("changed content without --force-new-version must not touch Phoenix");
    },
    fetchImpl: async () => {
      throw new Error("changed content without --force-new-version must not upload");
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.state, "duplicate_changed_content");
  assert.equal(blocked.previous_content_hash, first.example_content_hash);
  assert.notEqual(blocked.new_content_hash, first.example_content_hash);
  assert.match(blocked.detail, /--force-new-version/);

  const forcedCalls = [];
  const forced = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    forceNewVersion: true,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({ datasetExists: true, calls: forcedCalls }),
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.action, "append");
  assert.notEqual(forced.example_content_hash, first.example_content_hash);
  const promotionReceipt = JSON.parse(fs.readFileSync(promotionReceiptPath({ runId, repoRoot }), "utf8"));
  assert.equal(promotionReceipt.datasets[0].promotions.length, 2, "promotion events are append-only");
  assert.equal(promotionReceipt.datasets[0].promotions.at(-1).forced_new_version, true);
});

test("native split write failure falls back to metadata.dataset_split and discloses it", async () => {
  const repoRoot = tempRepoRoot("fallback");
  const runId = "run-rich-fallback-1";
  setUpPromotableRun({ repoRoot, runId });

  const calls = [];
  const progress = [];
  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: phoenixFetchMock({ failSplits: true, calls }),
    onProgress: (line) => progress.push(line),
  });
  assert.equal(result.ok, true);
  assert.equal(result.split_assignment, "metadata_fallback");
  assert.match(result.split_assignment_note, /metadata\.dataset_split only/);
  assert.match(result.split_assignment_note, /native split membership wins/i);
  assert.ok(progress.some((line) => /WARNING/.test(line)));

  const uploads = calls.filter((call) => call.url.includes("/v1/datasets/upload"));
  assert.equal(uploads.length, 2, "expected splits attempt then metadata-only retry");
  assert.deepEqual(uploads[0].body.splits, [uploads[0].body.metadata[0].dataset_split]);
  assert.equal(uploads[1].body.splits, undefined, "fallback upload must not claim native splits");
  assert.ok(uploads[1].body.metadata[0].dataset_split, "metadata mirror still carries the split");

  const promotionReceipt = JSON.parse(fs.readFileSync(promotionReceiptPath({ runId, repoRoot }), "utf8"));
  const event = promotionReceipt.datasets[0].promotions[0];
  assert.equal(event.split_assignment, "metadata_fallback");
  assert.match(event.split_assignment_note, /pending|assign the native split/i);
});

test("token-shaped content in run output fails rich promotion closed before any upload", async () => {
  const repoRoot = tempRepoRoot("secret");
  const runId = "run-rich-secret-1";
  const fakePat = ["gh", "p_", "abcdefghijklmnopqrstuvwx"].join("");
  setUpPromotableRun({
    repoRoot,
    runId,
    artifact: commitArtifact(runId, {
      project_update_markdown: `run_id: ${runId}\nDeploy with token ${fakePat} now.`,
    }),
  });

  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("secret-bearing content must not reach Phoenix readiness");
    },
    fetchImpl: async () => {
      throw new Error("secret-bearing content must never upload");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "cannot_promote");
  assert.equal(result.reason, "token_or_secret_like");
  assert.ok(result.secret_paths.some((entry) => entry.includes("project_update_markdown")));
  assert.equal(fs.existsSync(promotionReceiptPath({ runId, repoRoot })), false);
});

test("unclassifiable rich content rejects into needs_sanitization before any upload", async () => {
  const repoRoot = tempRepoRoot("unknown");
  const runId = "run-rich-unknown-1";
  const artifact = commitArtifact(runId);
  artifact.final_issues[0].vendor_payload = { raw: "who knows" };
  setUpPromotableRun({ repoRoot, runId, artifact });

  const result = await promoteRichDecompositionExample({
    repoRoot,
    runId,
    ensureReady: async () => {
      throw new Error("unsanitized content must not reach Phoenix readiness");
    },
    fetchImpl: async () => {
      throw new Error("unsanitized content must never upload");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "needs_sanitization");
  assert.equal(result.reason, "unclassified_content");
  assert.ok(result.unclassified_paths.some((entry) =>
    entry.includes("$.output.final_issues[0].vendor_payload")));
  assert.equal(fs.existsSync(promotionReceiptPath({ runId, repoRoot })), false);
});

test("banned workflow-state keys cannot enter Phoenix-bound example metadata", () => {
  const runId = "run-rich-banned-1";
  const snapshot = {
    project: sampleProject(),
  };
  snapshot.project.existing_issues = [];
  snapshot.project.status = "Planned";
  delete snapshot.project.issues;

  const banned = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot,
    policy,
    additionalMetadata: { queue_state: "pending" },
  });
  assert.equal(banned.ok, false);
  assert.match(banned.reason, /workflow_state_keys_banned_in_phoenix_metadata:queue_state/);

  // Unlisted metadata keys are not silently passed either: the gate rejects
  // them as unclassified content (fail closed, extend the policy explicitly).
  const unknownMetadata = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot,
    policy,
    additionalMetadata: { benign_metric_count: 3 },
  });
  assert.equal(unknownMetadata.ok, false);
  assert.equal(unknownMetadata.state, "needs_sanitization");
});

test("non-terminal runs and invalid split requests cannot promote", () => {
  const runId = "run-rich-nonterminal-1";
  const snapshot = { project: { ...sampleProject(), status: "Planned", existing_issues: [] } };
  delete snapshot.project.issues;

  const checkpoint = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: { ...commitArtifact(runId), kind: "checkpoint" },
    snapshot,
    policy,
  });
  assert.equal(checkpoint.ok, false);
  assert.equal(checkpoint.reason, "run_not_terminal");

  const badSplit = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot,
    policy,
    explicitSplit: "train",
  });
  assert.equal(badSplit.ok, false);
  assert.equal(badSplit.reason, "invalid_split_request");

  const calibration = buildRichDecompositionExample({
    receipt: { run_id: runId, trace_id: TRACE_ID },
    artifact: commitArtifact(runId),
    snapshot,
    policy,
    explicitSplit: "calibration",
  });
  assert.equal(calibration.ok, true);
  assert.equal(calibration.example.metadata.dataset_split, "calibration");
  assert.equal(calibration.split_assignment.method, "explicit_flag");
});

test("bounded receipt promotion stays bounded even when the receipt is polluted with rich fields", () => {
  const payload = buildDatasetUploadPayloadFromTraceReceipt({
    receipt: {
      run_id: "run-bounded-1",
      trace_id: TRACE_ID,
      status: "completed",
      // Pollution that must never leak into the bounded payload:
      phase_packets: [{ prompt: "raw prompt" }],
      prompt: "raw prompt",
      shell_output: "$ rm -rf",
    },
    datasetName: "teami-decomposition-runs",
    action: "create",
  });
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /prompt|phase_packet|shell_output|repo_snippet/);
  assert.equal(payload.inputs[0].run_id, "run-bounded-1");
});
