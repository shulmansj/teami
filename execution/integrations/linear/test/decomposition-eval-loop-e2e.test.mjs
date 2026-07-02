import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  FAILURE_TAXONOMY_VERSION,
  RUBRIC_VERSION,
} from "../src/eval-annotation-contract.mjs";
import {
  createDryRunGitHubTransport,
  createGitHubPromotionClient,
  GITHUB_PROMOTION_ENDPOINT_ALLOWLIST,
} from "../src/github-promotion-client.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import {
  createImprovementDrafterTestHarness,
  IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
  readImprovementDraftReceipt,
} from "../src/improvement-drafter.mjs";
import {
  EXPERIMENT_RECEIPT_SCHEMA_VERSION,
  readExperimentReceipt,
  runDecompositionExperiment,
} from "../src/phoenix-experiment.mjs";
import { createPhoenixTraceAnnotation } from "../src/phoenix-self-improvement.mjs";
import {
  evaluateAcceptedPacketSufficiencyOffline,
} from "../src/quality.mjs";
import { captureProjectSnapshot } from "../src/project-snapshot-store.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import {
  evaluateProcessChangeGate,
} from "../src/process-change-gate.mjs";
import { acceptedStateHash } from "../src/promotion-scanner/accepted-baseline.mjs";
import {
  createPromoteCandidateTestHarness,
  parsePromotionMarkers,
  PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
  PROMOTION_MARKER_SENTINEL_BEGIN,
  PROMOTION_MARKER_SENTINEL_END,
  promoteCandidate,
  readPromotionMarker,
} from "../src/promote-candidate.mjs";
import { readPromotionCommitTrailers } from "../src/promotion-workspace.mjs";
import {
  DEFAULT_RICH_DATASET_NAME,
  promoteRichDecompositionExample,
} from "../src/rich-promotion.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const config = loadLinearConfig({ repoRoot });

const APP_URL = "http://127.0.0.1:6006";
const PROJECT_NAME = "teami";
const RUN_ID = "run-step17-bad-4";
const SOURCE_TRACE_ID = "17171717171717171717171717171717";
const EVAL_TRACE_ID = "27171717171717171717171717171717";
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
const HUMAN_ANNOTATION_ID = "anno-human-step17";
const DATASET_ID = "DS17";
const DATASET_VERSION_ID = "DSV17";
const EXPERIMENT_ID = "EXP17";
const BASELINE_EXPERIMENT_ID = "BASE17";
const CANDIDATE_PROMPT_VERSION_ID = "PV-step17-candidate";
const DRAFTED_SR_ENG_PROMPT_VERSION_ID = "PV-step18-drafted-sr-eng";
const DRAFTED_SR_ENG_PROMPT_ID = "P-step18-sr-eng-grounding";
const DRAFTED_BY = "teami_drafter_v1:claude-opus-4-8";
const RUNTIME_ROLE_VARIANT_ID = "runtime-role-step17-candidate";
const ZERO_OVERRIDE_VARIANT_ID = "zero-override-step17-baseline";
const ACCEPTED_SNAPSHOT_PATH =
  "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md";
const SR_ENG_TARGET_KEY = "prompt/decomposition/sr_eng_grounding_pass";
const SR_ENG_SNAPSHOT_PATH =
  "execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md";
const ACCEPTED_RUNTIME_ROLES_PATH = "execution/evals/decomposition/accepted-runtime-roles.json";
const PHOENIX_ASSETS_MANIFEST_PATH = "execution/evals/decomposition/phoenix-assets.json";
// Composable structured draft: the live composability rule (Step 19
// hardening) rejects drafts that do not parse as a snapshot — header block
// plus the three required runtime sections. The E2E proves the compliant
// path; the rejection path is pinned in improvement-drafter.test.mjs.
const DRAFTED_SR_ENG_PROMPT_CONTENT = [
  "# Accepted Sr Eng Grounding Prompt",
  "",
  "```yaml",
  "prompt_version: unpinned-initial",
  "phoenix_prompt_role: sr_eng",
  "target_key: prompt/decomposition/sr_eng_grounding_pass",
  "```",
  "",
  "## Runtime instructions",
  "",
  "You are an Teami decomposition runtime. Do not mutate Linear or use tools.",
  "Return exactly one JSON object that satisfies the provided schema and the local phase contract.",
  "Use these exact top-level fields: schema_version, run_id, phase, status, reason, context_digest, source_refs, assumptions, constraints, risks.",
  "Do not use alias fields such as role, outcome, decision, explanation, or questions instead of the required fields.",
  "schema_version must be exactly `linear-decomposition-phase-packet/v1`.",
  "",
  "## Allowed phase outcomes",
  "",
  "Allowed phase outcomes:",
  "- pm_product_sufficiency_pass: continue/product_context_sufficient or blocked/needs_product_input",
  "- sr_eng_grounding_pass: continue/technical_context_grounded, blocked/needs_discovery, or blocked/needs_constraint_decision",
  "- pm_synthesis: continue/synthesis_complete or blocked/needs_product_input",
  "- sr_eng_blocker_check: continue/no_blockers, blocked/needs_discovery, or blocked/needs_constraint_decision",
  "",
  "## Phase field rules",
  "",
  "If Sr Eng is blocked by needs_discovery, include non-empty discovery_issues. Each item must use discovery_key, title, body_markdown, in_session_research, and evidence_gap.",
  "If Sr Eng is blocked by needs_constraint_decision, include technical_explanation_markdown.",
  "If phase is pm_synthesis and you continue, include final_issues and project_update_markdown with the run_id line. Each final issue must use decomposition_key, title, issue_body_markdown, depends_on, assignment, output, and acceptance_criteria.",
  "When the output schema requires phase-specific fields that do not apply to this phase, set them to null or an empty array as permitted by the schema.",
  "Flag missing or non-observable acceptance criteria as",
  "missing_acceptance_criteria before continuing.",
  "",
].join("\n");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-step17-e2e-"));
}

function recordTestTraceStatus(options) {
  return recordTraceStatus({ ...TRACE_IDENTITY, ...options });
}

function runGitOrThrow(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function gitAdapter(args, { cwd } = {}) {
  const result = runGitOrThrow(args, cwd);
  return {
    ok: true,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function splitGitLines(stdout) {
  return String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
}

function internalCloneDir(root) {
  return path.join(root, ".teami", "promotion-workspace", "repo");
}

function copyRepoFile(root, relativePath) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relativePath), destination);
}

function sha256File(root, relativePath) {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(root, relativePath)))
    .digest("hex");
}

function acceptedStateHashForManifestFile(root, relativePath) {
  return acceptedStateHash(JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")));
}

function seedDecompositionArtifacts(root) {
  for (const relativePath of [
    "execution/evals/decomposition/phoenix-assets.json",
    "execution/evals/decomposition/promotion-policy.json",
    "execution/evals/decomposition/failure-taxonomy.json",
    "execution/evals/decomposition/workspace-eval-policy.json",
    ACCEPTED_SNAPSHOT_PATH,
    "execution/evals/decomposition/accepted-prompts/pm-product-sufficiency-pass.md",
    SR_ENG_SNAPSHOT_PATH,
    "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
    ACCEPTED_RUNTIME_ROLES_PATH,
  ]) {
    copyRepoFile(root, relativePath);
  }

  const manifestPath = path.join(root, PHOENIX_ASSETS_MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Hermetic fixture: drop any real-manifest baseline for this target so the
  // fixture's BASE17 entry is the only one, regardless of live repo state.
  manifest.experiments = manifest.experiments.filter(
    (entry) => entry.candidate_target_key !== SR_ENG_TARGET_KEY,
  );
  manifest.experiments.push({
    purpose: "baseline",
    experiment_id: BASELINE_EXPERIMENT_ID,
    dataset_id: DATASET_ID,
    dataset_version_id: DATASET_VERSION_ID,
    project_name: PROJECT_NAME,
    candidate_target_key: SR_ENG_TARGET_KEY,
    accepted_artifact_hash_vector: {
      snapshot_path: SR_ENG_SNAPSHOT_PATH,
      snapshot_sha256: sha256File(root, SR_ENG_SNAPSHOT_PATH),
      accepted_prompt_version_id: null,
    },
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertOrderedLayers(body, layers) {
  let previousIndex = -1;
  for (const layer of layers) {
    const currentIndex = body.indexOf(layer);
    assert.ok(currentIndex > previousIndex, `PR body layer missing or out of order: ${layer}`);
    previousIndex = currentIndex;
  }
}

function assertNoMockFetchSurfaceContains(state, needle) {
  const surface = state.calls
    .map((call) => `${call.method} ${call.url} ${JSON.stringify(call.body ?? "")}`)
    .join("\n");
  assert.ok(!surface.includes(needle), `mock Phoenix fetch surface must not contain ${needle}`);
}

function initGitRepo(root) {
  runGitOrThrow(["init", "--initial-branch=main"], root);
  fs.writeFileSync(path.join(root, "README.md"), "fixture repo\n", "utf8");
  seedDecompositionArtifacts(root);
  runGitOrThrow(["add", "README.md", "execution/evals/decomposition"], root);
  runGitOrThrow(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@test.invalid", "commit", "-m", "init"],
    root,
  );
}

function packet({ phase, reason, extras = {} }) {
  return {
    schema_version: "linear-decomposition-phase-packet/v1",
    run_id: RUN_ID,
    phase,
    status: "continue",
    reason,
    context_digest: "digest-step17",
    source_refs: ["linear:project:proj-step17"],
    assumptions: ["existing billing copy stays in product voice"],
    constraints: ["do not add hosted mutation paths"],
    risks: ["missing acceptance criteria can make the downstream issue ambiguous"],
    ...extras,
  };
}

function badRunArtifact() {
  const pmSynthesis = packet({
    phase: "pm_synthesis",
    reason: "synthesis_complete",
    extras: { project_update_markdown: `run_id: ${RUN_ID}\nDecomposed billing setup, but one issue is under-specified.` },
  });
  const blockerCheck = packet({ phase: "sr_eng_blocker_check", reason: "no_blockers" });
  const phasePackets = [
    packet({ phase: "pm_product_sufficiency_pass", reason: "product_context_sufficient" }),
    packet({ phase: "sr_eng_grounding_pass", reason: "technical_context_grounded" }),
    pmSynthesis,
    blockerCheck,
  ];
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: RUN_ID,
    ...ARTIFACT_IDENTITY,
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: RUN_ID,
      workflow_version: ENGINE_VERSION,
      outcome: "commit",
      reason: "synthesis_complete",
      context_digest: pmSynthesis.context_digest,
      source_refs: pmSynthesis.source_refs,
      assumptions: pmSynthesis.assumptions,
      constraints: pmSynthesis.constraints,
      risks: pmSynthesis.risks,
    },
    evidence: {
      perspectives_run: [
        { role: "pm", outcome: "product_context_sufficient" },
        { role: "sr_eng", outcome: "technical_context_grounded" },
        { role: "pm", outcome: "synthesis_complete" },
        { role: "sr_eng", outcome: "no_blockers" },
      ],
    },
    bounds: { rounds_used: 4, max_rounds: 6 },
    phase_packets: phasePackets,
    runtime_assignments: {
      pm: { runtime: "claude", model: "claude-opus-4-8" },
      sr_eng: { runtime: "codex", model: "gpt-5.5" },
    },
    runtime_metadata: { pm: {}, sr_eng: {} },
    pm_synthesis: pmSynthesis,
    sr_eng_blocker_check: blockerCheck,
    final_issues: [{
      decomposition_key: "billing/setup",
      title: "Wire billing setup state",
      issue_body_markdown: "Update the billing setup state handling.",
      depends_on: [],
      assignee_id: "user-step17",
      label_ids: ["label-billing"],
    }],
    project_update_markdown: `run_id: ${RUN_ID}\nBilling setup was decomposed, but the issue lacks acceptance criteria.`,
  };
}

function sourceProject() {
  return {
    id: "proj-step17",
    name: "Billing setup completion",
    description: "Improve the first-run billing setup handoff.",
    content: "## Goal\nMake billing setup completion unambiguous for the next agent handoff.",
    labels: [{ id: "label-billing", name: "billing" }],
    status: { id: "status-planned", name: "Planned", type: "planned" },
    issues: [{
      id: "issue-existing",
      identifier: "ENG-17",
      title: "Existing billing copy follow-up",
      state: { id: "state-todo", name: "Todo", type: "unstarted" },
      labels: [],
    }],
  };
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

const OPENAPI = {
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
    "/v1/experiments/{experiment_id}": { get: {} },
    "/v1/prompt_versions/{prompt_version_id}": { get: {} },
    "/v1/datasets/{id}/versions": { get: {} },
    "/v1/projects/{project_identifier}/trace_annotations": { get: {} },
  },
  components: {
    schemas: {
      UpsertExperimentEvaluationRequestBody: {
        properties: {
          annotator_kind: { enum: ["HUMAN", "LLM", "CODE"] },
          result: { type: "object" },
          error: { type: "string" },
        },
      },
    },
  },
};

function createStep17PhoenixFixture() {
  const state = {
    calls: [],
    datasetCreated: false,
    datasetExamples: [],
    experiment: null,
    runs: [],
    evaluationsByRunId: new Map(),
    traceAnnotationsByTraceId: new Map(),
    writes: {
      traceAnnotations: [],
      datasetUploads: [],
      experiments: [],
      experimentRuns: [],
      experimentEvaluations: [],
      outcomeSpans: [],
      projectsCreated: [],
      promptTags: [],
    },
    promptCandidateTagVersionId: null,
  };

  const annotationsForTrace = (traceId) =>
    state.traceAnnotationsByTraceId.get(traceId) || [];

  const experimentJsonRows = () => {
    const examplesById = new Map(state.datasetExamples.map((example) => [example.id, example]));
    return state.runs.map((run) => {
      const example = examplesById.get(run.dataset_example_id) || {};
      return {
        example_id: run.dataset_example_id,
        repetition_number: run.repetition_number,
        input: example.input || {},
        reference_output: example.output || {},
        output: run.output,
        error: run.error,
        trace_id: run.trace_id,
        annotations: state.evaluationsByRunId.get(run.id) || [],
      };
    });
  };

  const baselineRows = () => {
    const exampleId = state.datasetExamples[0]?.id || `teami:${RUN_ID}`;
    return [{
      example_id: exampleId,
      annotations: [{
        name: "quality",
        annotator_kind: "LLM",
        label: "needs_revision",
        score: 0.4,
        explanation: "accepted baseline judge underweighted the missing acceptance criteria.",
        metadata: { identifier: "decomposition_quality_judge_v1:test-model" },
      }],
    }];
  };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method, pathname: parsed.pathname, search: parsed.search, body, url: String(url) };
    state.calls.push(call);

    if (method === "GET" && parsed.pathname === "/openapi.json") {
      return jsonResponse(OPENAPI);
    }

    if (method === "GET" && parsed.pathname === "/v1/datasets") {
      return jsonResponse({
        data: state.datasetCreated
          ? [{ id: DATASET_ID, name: DEFAULT_RICH_DATASET_NAME }]
          : [],
      });
    }

    if (method === "POST" && parsed.pathname === "/v1/datasets/upload") {
      state.datasetCreated = true;
      state.writes.datasetUploads.push(call);
      state.datasetExamples = body.inputs.map((input, index) => ({
        id: body.example_ids[index],
        input,
        output: body.outputs[index],
        metadata: body.metadata[index],
      }));
      return jsonResponse({
        data: {
          dataset_id: DATASET_ID,
          version_id: DATASET_VERSION_ID,
          num_created_examples: state.datasetExamples.length,
        },
      });
    }

    if (method === "GET" && parsed.pathname === `/v1/datasets/${DATASET_ID}/versions`) {
      return jsonResponse({ data: [{ version_id: DATASET_VERSION_ID }], next_cursor: null });
    }

    if (method === "GET" && parsed.pathname === `/v1/datasets/${DATASET_ID}/examples`) {
      return jsonResponse({
        data: {
          dataset_id: DATASET_ID,
          version_id: DATASET_VERSION_ID,
          examples: state.datasetExamples,
        },
      });
    }

    if (method === "POST" && parsed.pathname === `/v1/datasets/${DATASET_ID}/experiments`) {
      state.experiment = {
        id: EXPERIMENT_ID,
        dataset_id: DATASET_ID,
        dataset_version_id: DATASET_VERSION_ID,
        repetitions: body.repetitions,
        metadata: body.metadata || {},
        project_name: PROJECT_NAME,
      };
      state.writes.experiments.push(call);
      return jsonResponse({ data: state.experiment });
    }

    if (method === "POST" && parsed.pathname === `/v1/experiments/${EXPERIMENT_ID}/runs`) {
      const run = { id: `EXPRUN-${state.runs.length + 1}`, ...body };
      state.runs.push(run);
      state.writes.experimentRuns.push({ ...call, run_id: run.id });
      return jsonResponse({ data: { id: run.id } });
    }

    if (method === "POST" && parsed.pathname === "/v1/experiment_evaluations") {
      const evaluation = {
        id: `EXPEVAL-${state.writes.experimentEvaluations.length + 1}`,
        name: body.name,
        annotator_kind: body.annotator_kind,
        label: body.result?.label ?? null,
        score: body.result?.score ?? null,
        explanation: body.result?.explanation ?? null,
        error: body.error ?? null,
        metadata: body.metadata || {},
        trace_id: body.trace_id ?? null,
      };
      const list = state.evaluationsByRunId.get(body.experiment_run_id) || [];
      list.push(evaluation);
      state.evaluationsByRunId.set(body.experiment_run_id, list);
      state.writes.experimentEvaluations.push({ ...call, evaluation_id: evaluation.id });
      return jsonResponse({ data: { id: evaluation.id } });
    }

    if (method === "GET" && parsed.pathname === `/v1/experiments/${EXPERIMENT_ID}`) {
      return jsonResponse({ data: state.experiment });
    }

    if (method === "GET" && parsed.pathname === `/v1/experiments/${EXPERIMENT_ID}/json`) {
      return jsonResponse(experimentJsonRows());
    }

    if (method === "GET" && parsed.pathname === `/v1/experiments/${BASELINE_EXPERIMENT_ID}/json`) {
      return jsonResponse(baselineRows());
    }

    if (
      method === "GET"
      && [CANDIDATE_PROMPT_VERSION_ID, DRAFTED_SR_ENG_PROMPT_VERSION_ID].includes(
        parsed.pathname.replace("/v1/prompt_versions/", ""),
      )
    ) {
      const promptVersionId = parsed.pathname.replace("/v1/prompt_versions/", "");
      const content = promptVersionId === DRAFTED_SR_ENG_PROMPT_VERSION_ID
        ? DRAFTED_SR_ENG_PROMPT_CONTENT
        : [
            "# Accepted Judge Prompt: quality",
            "",
            "Candidate revision: treat missing or non-observable acceptance",
            "criteria as a material issue-executability failure and map them",
            "to missing_acceptance_criteria.",
            "",
          ].join("\n");
      // Full CHAT prompt-version body mirroring the registration wire shape
      // (registerJudgePromptInPhoenix: system message, template_format NONE)
      // so the Step 6 materializer can extract candidate content and produce
      // a concrete behavior diff.
      return jsonResponse({
        data: {
          id: promptVersionId,
          template_type: "CHAT",
          template_format: "NONE",
          template: {
            type: "chat",
            messages: [
              {
                role: "system",
                content,
              },
            ],
          },
        },
      });
    }

    if (
      method === "GET"
      && parsed.pathname === `/v1/prompts/${DRAFTED_SR_ENG_PROMPT_ID}/tags/teami_promotion_candidate`
    ) {
      if (!state.promptCandidateTagVersionId) return jsonResponse({ detail: "not found" }, 404);
      return jsonResponse({ data: { id: state.promptCandidateTagVersionId } });
    }

    if (method === "POST" && parsed.pathname === `/v1/prompt_versions/${DRAFTED_SR_ENG_PROMPT_VERSION_ID}/tags`) {
      state.promptCandidateTagVersionId = DRAFTED_SR_ENG_PROMPT_VERSION_ID;
      state.writes.promptTags.push(call);
      return jsonResponse({}, 204);
    }

    if (method === "GET" && parsed.pathname === "/v1/projects") {
      return jsonResponse({ data: [{ id: "UHJvamVjdDox", name: PROJECT_NAME }] });
    }

    if (method === "POST" && parsed.pathname === "/v1/projects") {
      state.writes.projectsCreated.push(call);
      return jsonResponse({ data: { id: "UHJvamVjdDox", name: PROJECT_NAME } });
    }

    if (method === "POST" && parsed.pathname === `/v1/projects/${PROJECT_NAME}/spans`) {
      state.writes.outcomeSpans.push(call);
      return jsonResponse({});
    }

    if (method === "GET" && parsed.pathname === `/v1/projects/${PROJECT_NAME}/traces`) {
      const traces = state.writes.outcomeSpans.flatMap((spanCall) =>
        (spanCall.body?.data || [])
          .map((span) => span?.context?.trace_id)
          .filter(Boolean)
          .map((traceId) => ({ trace_id: traceId, spans: [] })),
      );
      return jsonResponse({ data: traces, next_cursor: null });
    }

    if (method === "GET" && parsed.pathname === `/v1/projects/${PROJECT_NAME}/trace_annotations`) {
      const traceId = parsed.searchParams.get("trace_ids");
      return jsonResponse({ data: annotationsForTrace(traceId), next_cursor: null });
    }

    if (method === "POST" && parsed.pathname === "/v1/trace_annotations") {
      const annotations = body.data.map((annotation, index) => {
        const id = annotation.annotator_kind === "HUMAN"
          ? HUMAN_ANNOTATION_ID
          : `anno-step17-${state.writes.traceAnnotations.length + index + 1}`;
        return {
          id,
          name: annotation.name,
          annotator_kind: annotation.annotator_kind,
          identifier: annotation.identifier,
          result: annotation.result,
          metadata: annotation.metadata || {},
          trace_id: annotation.trace_id,
        };
      });
      for (const annotation of annotations) {
        if (annotation.annotator_kind === "HUMAN") {
          const list = annotationsForTrace(annotation.trace_id);
          list.push(annotation);
          state.traceAnnotationsByTraceId.set(annotation.trace_id, list);
        }
      }
      state.writes.traceAnnotations.push({ ...call, annotations });
      return jsonResponse({ data: annotations.map((annotation) => ({ id: annotation.id })) });
    }

    throw new Error(`unexpected Phoenix fixture request: ${method} ${parsed.pathname}`);
  };

  return { fetchImpl, state };
}

function writeCandidateVariantsFile(root) {
  const filePath = path.join(root, "variants-step17.json");
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v1",
    default_variant: "accepted_baseline",
    variants: {
      accepted_baseline: {
        description: "Current accepted behavior.",
        role_overrides: {},
        judge_candidate_prompt_version_id: null,
      },
      "judge-step17-candidate": {
        description: "Candidate judge prompt that weighs missing acceptance criteria more consistently.",
        role_overrides: {},
        judge_candidate_prompt_version_id: CANDIDATE_PROMPT_VERSION_ID,
      },
    },
  }, null, 2)}\n`, "utf8");
  return filePath;
}

function writeRuntimeRoleVariantsFile(root) {
  const filePath = path.join(root, "variants-step17-runtime-role.json");
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v1",
    default_variant: "accepted_baseline",
    variants: {
      accepted_baseline: {
        description: "Current accepted behavior.",
        role_overrides: {},
        judge_candidate_prompt_version_id: null,
      },
      [RUNTIME_ROLE_VARIANT_ID]: {
        description: "Candidate runtime role assignment rule that changes the accepted PM model default.",
        role_overrides: {
          pm: {
            model: "gpt-5.5",
          },
        },
        judge_candidate_prompt_version_id: null,
      },
    },
  }, null, 2)}\n`, "utf8");
  return filePath;
}

function writeZeroOverrideVariantsFile(root) {
  const filePath = path.join(root, "variants-step17-zero-override.json");
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: "decomposition-eval-variants/v1",
    default_variant: "accepted_baseline",
    variants: {
      accepted_baseline: {
        description: "Current accepted behavior.",
        role_overrides: {},
        judge_candidate_prompt_version_id: null,
      },
      [ZERO_OVERRIDE_VARIANT_ID]: {
        description: "Zero-override baseline evidence with no materializable proposed change.",
        role_overrides: {},
        judge_candidate_prompt_version_id: null,
      },
    },
  }, null, 2)}\n`, "utf8");
  return filePath;
}

function fakeCandidateEvalTask(args) {
  const acceptedPackets = evaluateAcceptedPacketSufficiencyOffline({
    phasePackets: badRunArtifact().phase_packets,
  });
  return {
    ok: true,
    status: "evaluated",
    eval_run_id: `eval-${args.datasetExampleId}`,
    variant_id: args.variantId,
    inputs_hash: "17".repeat(32),
    accepted_packets: badRunArtifact().phase_packets,
    terminal: {
      status: "completed",
      reason: "no_blockers",
      final_issues: badRunArtifact().final_issues,
      discovery_issues: [],
      dependency_relations: [],
      project_update_markdown: "candidate eval completed",
    },
    trace: { trace_id: EVAL_TRACE_ID, trace_status: "trace_exported" },
    checks: {
      ok: true,
      storage: "report_only",
      checks: [
        {
          status: "evaluated",
          name: acceptedPackets.name,
          identifier: acceptedPackets.identifier,
          annotation: acceptedPackets,
        },
      ],
    },
    judge: {
      ok: true,
      judge_state: "judged",
      identifier: "decomposition_quality_judge_v1:test-model",
      model: "test-model",
      prompt_source: "phoenix_candidate_version",
      prompt_version: CANDIDATE_PROMPT_VERSION_ID,
      judge: {
        label: "needs_revision",
        score: 0.62,
        explanation: "Candidate prompt catches the missing acceptance criteria and scores the reusable failure higher than the baseline calibration.",
        failure_modes: ["missing_acceptance_criteria"],
        failure_mode_details: [],
      },
    },
  };
}

function writeStep18OpportunityRecord(root) {
  const opportunityHash = createHash("sha256")
    .update("step18-sr-eng-grounding-opportunity", "utf8")
    .digest("hex");
  const registryDir = path.join(root, ".teami", "promotion-candidates");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, `${opportunityHash}.json`),
    `${JSON.stringify({
      schema_version: "test-registry/v1",
      improvement_opportunity: {
        status: "improvement_opportunity",
        target: SR_ENG_TARGET_KEY,
        human_name: "Sr-eng grounding prompt",
        failure_mode_ids: ["missing_acceptance_criteria"],
        suggested_draft_prompt: "Tighten the senior-engineering grounding pass around observable acceptance criteria.",
        evidence_refs: {
          experiment_ids: [EXPERIMENT_ID],
          dataset_version_ids: [DATASET_VERSION_ID],
          annotation_ids: [HUMAN_ANNOTATION_ID],
          phoenix_deep_links: [`${APP_URL}/datasets/${DATASET_ID}/experiments/${EXPERIMENT_ID}`],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return opportunityHash;
}

function createStep18DraftExperimentImpl() {
  return async function runStep18DraftExperiment(options = {}) {
    assert.equal(options.intentFlag, "promotion_candidate");
    assert.equal(options.draftedBy, DRAFTED_BY);
    assert.equal(options.datasetName, DEFAULT_RICH_DATASET_NAME);
    assert.equal(options.derivedVariant?.prompt_overrides?.[SR_ENG_TARGET_KEY]?.candidate_prompt_version_id, DRAFTED_SR_ENG_PROMPT_VERSION_ID);

    const ready = await options.ensureReady();
    assert.equal(ready.ok, true);
    assert.equal(ready.appUrl, APP_URL);

    const created = await options.fetchImpl(new URL(`/v1/datasets/${DATASET_ID}/experiments`, APP_URL), {
      method: "POST",
      body: JSON.stringify({
        name: "expr-step18-drafted-sr-eng",
        description: "Step 18 drafted sr-eng prompt experiment.",
        version_id: DATASET_VERSION_ID,
        repetitions: 1,
        metadata: {
          teami_receipt_id: "expr-step18-drafted-sr-eng",
          teami_source: "managed_manual",
          teami_variant_id: options.derivedVariant.id,
          teami_candidate_version_id: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
        },
      }),
    });
    assert.equal(created.ok, true);
    const experimentBody = JSON.parse(await created.text());
    assert.equal(experimentBody.data.id, EXPERIMENT_ID);

    const exampleId = `teami:${RUN_ID}`;
    const taskOutput = fakeCandidateEvalTask({
      datasetExampleId: exampleId,
      variantId: options.derivedVariant.id,
    });
    taskOutput.judge.prompt_version = DRAFTED_SR_ENG_PROMPT_VERSION_ID;
    const runResponse = await options.fetchImpl(new URL(`/v1/experiments/${EXPERIMENT_ID}/runs`, APP_URL), {
      method: "POST",
      body: JSON.stringify({
        dataset_example_id: exampleId,
        repetition_number: 1,
        output: taskOutput,
        error: null,
        trace_id: EVAL_TRACE_ID,
      }),
    });
    assert.equal(runResponse.ok, true);
    const runBody = JSON.parse(await runResponse.text());

    const evaluationResponse = await options.fetchImpl(new URL("/v1/experiment_evaluations", APP_URL), {
      method: "POST",
      body: JSON.stringify({
        experiment_run_id: runBody.data.id,
        name: "quality",
        annotator_kind: "LLM",
        result: {
          label: taskOutput.judge.judge.label,
          score: taskOutput.judge.judge.score,
          explanation: taskOutput.judge.judge.explanation,
        },
        metadata: { identifier: taskOutput.judge.identifier },
        trace_id: EVAL_TRACE_ID,
      }),
    });
    assert.equal(evaluationResponse.ok, true);

    const now = options.now();
    const receiptId = "expr-step18-drafted-sr-eng";
    const receiptPath = path.join(options.repoRoot, ".teami", "experiments", `${receiptId}.json`);
    const manifestBytes = fs.readFileSync(path.join(options.repoRoot, PHOENIX_ASSETS_MANIFEST_PATH));
    const workspacePolicyPath = path.join(options.repoRoot, "execution/evals/decomposition/workspace-eval-policy.json");
    const workspacePolicy = JSON.parse(fs.readFileSync(workspacePolicyPath, "utf8"));
    const srEngSnapshotSha256 = sha256File(options.repoRoot, SR_ENG_SNAPSHOT_PATH);
    const receipt = {
      schema_version: EXPERIMENT_RECEIPT_SCHEMA_VERSION,
      receipt_id: receiptId,
      source: "managed_manual",
      created_at: now.toISOString(),
      launch: {
        intent: "promotion_candidate",
        intent_source: "explicit_flag",
        candidate_target_key: SR_ENG_TARGET_KEY,
        launch_baseline: {
          derived_from: "phoenix_assets_manifest",
          manifest_path: PHOENIX_ASSETS_MANIFEST_PATH,
          manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
          prompt_role: "sr_eng",
          accepted_baseline_id: `sha256:${srEngSnapshotSha256}`,
          accepted_dataset_version_ids: {
            [DEFAULT_RICH_DATASET_NAME]: DATASET_VERSION_ID,
          },
        },
        candidate: {
          variant_id: options.derivedVariant.id,
          variant_source: "derived_variant",
          candidate_version_id: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
          role_overrides: {},
          prompt_overrides: options.derivedVariant.prompt_overrides,
          derived_variant: options.derivedVariant,
          judge_candidate_prompt_version_id: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
        },
        dataset: {
          name: DEFAULT_RICH_DATASET_NAME,
          dataset_id: DATASET_ID,
          dataset_version_id: DATASET_VERSION_ID,
        },
        split: {
          requested: null,
          selection: "metadata_fallback",
          disclosure: null,
          example_ids: [exampleId],
        },
        evaluators: {
          code: [
            "decomposition_quality_offline_v1",
            "accepted_packet_sufficiency_offline_v1",
            "pause_state_correctness_offline_v1",
          ],
          judge: {
            evaluator_id: "decomposition_quality_judge_v1",
            model: "test-model",
            runtime: "test",
            identifier: "decomposition_quality_judge_v1:test-model",
            prompt_source: "phoenix_candidate_version",
            prompt_version: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
          },
        },
        promotion_policy: null,
        workspace_eval_policy: {
          schema_version: workspacePolicy.schema_version,
          sha256: createHash("sha256").update(fs.readFileSync(workspacePolicyPath)).digest("hex"),
          path: "workspace-eval-policy.json",
        },
        actor: { os_username: "fixture", authenticity: "asserted" },
        launched_at: now.toISOString(),
        phoenix_scope: { origin: APP_URL, project_name: PROJECT_NAME },
        teami_run_id: "afexp-step18-drafted-sr-eng",
        drafted_by: DRAFTED_BY,
      },
      phoenix_experiment_id: EXPERIMENT_ID,
      events: [
        { type: "launched", at: now.toISOString(), actor: { os_username: "fixture", authenticity: "asserted" } },
        {
          type: "completed",
          at: now.toISOString(),
          summary: {
            status: "completed",
            example_count: 1,
            failed_example_count: 0,
            evidence_counts: { test_examples: 1, test_human_labeled_examples: 1 },
            baseline_comparison: {
              computable: true,
              baseline_experiment_id: BASELINE_EXPERIMENT_ID,
              deltas: {
                quality: { baseline: 0.4, current: 0.62, delta: 0.21999999999999997 },
              },
              regressions: [],
            },
          },
        },
      ],
      amendments: [],
    };
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    return {
      ok: true,
      status: "completed",
      receipt_id: receiptId,
      receipt_path: receiptPath,
      phoenix_experiment_id: EXPERIMENT_ID,
      intent: "promotion_candidate",
      variant_id: options.derivedVariant.id,
      candidate_target_key: SR_ENG_TARGET_KEY,
      summary: receipt.events[1].summary,
    };
  };
}

test("Step 17 offline fixture proves a judge experiment runs but its promotion is terminally blocked with no live side effects", async () => {
  const root = tempRoot();
  initGitRepo(root);
  const { fetchImpl, state } = createStep17PhoenixFixture();
  const readyUp = async () => ({ ok: true, appUrl: APP_URL, projectName: PROJECT_NAME });

  recordTestTraceStatus({
    repoRoot: root,
    runId: RUN_ID,
    projectId: "proj-step17",
    traceId: SOURCE_TRACE_ID,
    phoenixAppUrl: APP_URL,
    status: "trace_exported",
    observedAt: "2026-06-10T04:00:00.000Z",
  });
  writeRunArtifact({ repoRoot: root, runId: RUN_ID }, badRunArtifact());
  captureProjectSnapshot({
    repoRoot: root,
    runId: RUN_ID,
    project: sourceProject(),
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T04:00:01.000Z",
  });

  const humanAnnotation = await createPhoenixTraceAnnotation({
    repoRoot: root,
    ensureReady: readyUp,
    fetchImpl,
    traceId: SOURCE_TRACE_ID,
    name: "quality",
    label: "needs_revision",
    score: 0.52,
    explanation: "The billing setup issue is not ready for another agent because it has no acceptance criteria.",
    annotatorKind: "HUMAN",
    identifier: "steve-step17-fixture",
    metadata: { failure_modes: ["missing_acceptance_criteria"] },
  });
  assert.deepEqual(humanAnnotation.annotationIds, [HUMAN_ANNOTATION_ID]);

  const promoted = await promoteRichDecompositionExample({
    repoRoot: root,
    runId: RUN_ID,
    annotationIds: humanAnnotation.annotationIds,
    ensureReady: readyUp,
    fetchImpl,
    now: () => "2026-06-10T04:01:00.000Z",
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.uploaded, true);
  assert.equal(promoted.datasetName, DEFAULT_RICH_DATASET_NAME);
  assert.equal(promoted.dataset_id, DATASET_ID);
  assert.equal(promoted.dataset_version_id, DATASET_VERSION_ID);
  assert.equal(promoted.split, "test", "run-step17-bad-4 is intentionally hash-assigned to the held-out test split");
  assert.equal(state.datasetExamples.length, 1);
  assert.equal(state.datasetExamples[0].metadata.source_trace_id, SOURCE_TRACE_ID);
  assert.deepEqual(state.datasetExamples[0].metadata.reference.human_annotation_ids, [HUMAN_ANNOTATION_ID]);

  const variantsPath = writeCandidateVariantsFile(root);
  const experiment = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: DEFAULT_RICH_DATASET_NAME,
    variantId: "judge-step17-candidate",
    variantsPath,
    intentFlag: "promotion_candidate",
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: fakeCandidateEvalTask,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    now: () => new Date("2026-06-10T04:02:00.000Z"),
  });
  assert.equal(experiment.ok, true);
  assert.equal(experiment.status, "completed");
  assert.equal(experiment.phoenix_experiment_id, EXPERIMENT_ID);
  assert.equal(experiment.intent, "promotion_candidate");
  assert.equal(experiment.variant_id, "judge-step17-candidate");
  assert.equal(experiment.candidate_target_key, "prompt/decomposition/decomposition_quality_judge");
  assert.equal(experiment.summary.evidence_counts.test_human_labeled_examples, 1);
  assert.equal(experiment.summary.baseline_comparison.computable, true);
  assert.equal(experiment.summary.baseline_comparison.deltas.quality.delta, 0.21999999999999997);

  const storedReceipt = readExperimentReceipt({ repoRoot: root, receiptId: experiment.receipt_id });
  assert.equal(storedReceipt.exists, true);
  assert.equal(storedReceipt.receipt.schema_version, EXPERIMENT_RECEIPT_SCHEMA_VERSION);
  assert.equal(storedReceipt.receipt.launch.candidate.judge_candidate_prompt_version_id, CANDIDATE_PROMPT_VERSION_ID);
  assert.equal(storedReceipt.receipt.phoenix_experiment_id, EXPERIMENT_ID);

  const gate = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: experiment.receipt_id,
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    now: () => new Date("2026-06-10T04:03:00.000Z"),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "pass");
  assert.deepEqual(gate.failed_condition_ids, []);
  assert.equal(gate.evidence_counts.test_examples, 1);
  assert.equal(gate.evidence_counts.test_human_labeled_examples, 1);
  assert.equal(gate.product_report.phoenix_assets_evidence.annotation_ids[0], HUMAN_ANNOTATION_ID);

  await assert.rejects(
    () => promoteCandidate({
      repoRoot: root,
      request: {
        schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
        source: "agent_session",
        actor_id: "step17-fixture",
        expected_project: PROJECT_NAME,
        experiment_id: EXPERIMENT_ID,
        requested_action: "propose_repo_change",
      },
      ensureReady: readyUp,
    }),
    /untrusted_override_rejected:ensureReady/,
  );

  const githubTransport = createDryRunGitHubTransport({
    now: () => new Date("2026-06-10T04:04:00.000Z"),
  });
  const gitCalls = [];
  const runGit = (args, { cwd } = {}) => {
    gitCalls.push({ args: [...args], cwd });
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  const harness = createPromoteCandidateTestHarness({
    githubTransport,
    githubRepo: { owner: "fixture-owner", repo: "fixture-behavior" },
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    runGit,
    env: {},
  });
  const proposal = await harness.promoteCandidate({
    repoRoot: root,
    request: {
      schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
      source: "agent_session",
      actor_id: "step17-fixture",
      expected_project: PROJECT_NAME,
      experiment_id: EXPERIMENT_ID,
      prompt_version_id: CANDIDATE_PROMPT_VERSION_ID,
      evaluator_id: "decomposition_quality_judge_v1",
      dataset_version_id: DATASET_VERSION_ID,
      annotation_ids: [HUMAN_ANNOTATION_ID],
      requested_action: "propose_repo_change",
      trigger_authenticity: "authenticated",
    },
    invocation: { transport: "cli_local_session" },
  });

  // The judge is the maintainer-owned evaluator. A judge EXPERIMENT is a
  // legitimate eval surface (it ran and the gate passed above), but PROMOTING a
  // judge change through the adopter self-improvement loop is excluded by the
  // single source. The controller blocks it terminally, before any branch, PR,
  // or push — proving the judge cannot be tuned through self-improvement.
  assert.equal(proposal.ok, false);
  assert.equal(proposal.outcome, "blocked");
  assert.equal(proposal.terminal, true);
  assert.equal(proposal.reason, "candidate_target_out_of_scope");
  assert.equal(proposal.target_scope.target_key, "prompt/decomposition/decomposition_quality_judge");
  assert.equal(proposal.target_scope.ownership, "factory_behavior");
  assert.equal(proposal.branch, undefined);
  assert.equal(proposal.commit_sha, undefined);
  assert.equal(proposal.pr, undefined);

  assert.deepEqual(githubTransport.calls, [], "no GitHub call is made when the judge target boundary blocks");
  assert.ok(
    !githubTransport.calls.some((call) => call.endpointId === "create_pull_request"),
    "the judge promotion must never reach PR creation",
  );
  assert.ok(!gitCalls.some((call) => call.args[0] === "push"), "blocked judge promotion must not push");
  assert.equal(
    fs.existsSync(path.join(internalCloneDir(root), ".git")),
    false,
    "a blocked judge target must not create a promotion branch workspace",
  );

  const hardFloor = {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: gitCalls.filter((call) => call.args[0] === "push").length,
    autoMergeOrMarkReadyCalls: githubTransport.calls.filter((call) => /merge|ready|review/i.test(`${call.endpointId} ${call.path}`)).length,
    gatewayWakeClaims: 0,
  };
  assert.deepEqual(hardFloor, {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: 0,
    autoMergeOrMarkReadyCalls: 0,
    gatewayWakeClaims: 0,
  });
});

test("Step 17 offline fixture rejects zero-override baseline runs as promotion candidates", async () => {
  const root = tempRoot();
  initGitRepo(root);
  const { fetchImpl } = createStep17PhoenixFixture();
  const readyUp = async () => ({ ok: true, appUrl: APP_URL, projectName: PROJECT_NAME });

  recordTestTraceStatus({
    repoRoot: root,
    runId: RUN_ID,
    projectId: "proj-step17",
    traceId: SOURCE_TRACE_ID,
    phoenixAppUrl: APP_URL,
    status: "trace_exported",
    observedAt: "2026-06-10T04:00:00.000Z",
  });
  writeRunArtifact({ repoRoot: root, runId: RUN_ID }, badRunArtifact());
  captureProjectSnapshot({
    repoRoot: root,
    runId: RUN_ID,
    project: sourceProject(),
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T04:00:01.000Z",
  });

  const humanAnnotation = await createPhoenixTraceAnnotation({
    repoRoot: root,
    ensureReady: readyUp,
    fetchImpl,
    traceId: SOURCE_TRACE_ID,
    name: "quality",
    label: "needs_revision",
    score: 0.52,
    explanation: "The billing setup issue is not ready for another agent because it has no acceptance criteria.",
    annotatorKind: "HUMAN",
    identifier: "steve-step17-fixture",
    metadata: { failure_modes: ["missing_acceptance_criteria"] },
  });
  assert.deepEqual(humanAnnotation.annotationIds, [HUMAN_ANNOTATION_ID]);

  const promoted = await promoteRichDecompositionExample({
    repoRoot: root,
    runId: RUN_ID,
    annotationIds: humanAnnotation.annotationIds,
    ensureReady: readyUp,
    fetchImpl,
    now: () => "2026-06-10T04:01:00.000Z",
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.uploaded, true);
  assert.equal(promoted.dataset_id, DATASET_ID);
  assert.equal(promoted.dataset_version_id, DATASET_VERSION_ID);
  assert.equal(promoted.split, "test");

  const variantsPath = writeZeroOverrideVariantsFile(root);
  const experiment = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: DEFAULT_RICH_DATASET_NAME,
    variantId: ZERO_OVERRIDE_VARIANT_ID,
    variantsPath,
    intentFlag: "promotion_candidate",
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: fakeCandidateEvalTask,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    now: () => new Date("2026-06-10T04:02:00.000Z"),
  });

  assert.equal(experiment.ok, false);
  assert.equal(experiment.status, "not_run");
  assert.equal(experiment.reason, "promotion_candidate_requires_agent_behavior_change");
  assert.match(experiment.detail, /zero-override accepted-baseline runs are exploratory evidence/);
});

test("Step 17 offline fixture routes runtime-role evidence to an accepted-defaults HITL PR", async () => {
  const root = tempRoot();
  initGitRepo(root);
  const { fetchImpl, state } = createStep17PhoenixFixture();
  const readyUp = async () => ({ ok: true, appUrl: APP_URL, projectName: PROJECT_NAME });

  recordTestTraceStatus({
    repoRoot: root,
    runId: RUN_ID,
    projectId: "proj-step17",
    traceId: SOURCE_TRACE_ID,
    phoenixAppUrl: APP_URL,
    status: "trace_exported",
    observedAt: "2026-06-10T04:00:00.000Z",
  });
  writeRunArtifact({ repoRoot: root, runId: RUN_ID }, badRunArtifact());
  captureProjectSnapshot({
    repoRoot: root,
    runId: RUN_ID,
    project: sourceProject(),
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T04:00:01.000Z",
  });

  const humanAnnotation = await createPhoenixTraceAnnotation({
    repoRoot: root,
    ensureReady: readyUp,
    fetchImpl,
    traceId: SOURCE_TRACE_ID,
    name: "quality",
    label: "needs_revision",
    score: 0.52,
    explanation: "The billing setup issue is not ready for another agent because it has no acceptance criteria.",
    annotatorKind: "HUMAN",
    identifier: "steve-step17-fixture",
    metadata: { failure_modes: ["missing_acceptance_criteria"] },
  });
  assert.deepEqual(humanAnnotation.annotationIds, [HUMAN_ANNOTATION_ID]);

  const promoted = await promoteRichDecompositionExample({
    repoRoot: root,
    runId: RUN_ID,
    annotationIds: humanAnnotation.annotationIds,
    ensureReady: readyUp,
    fetchImpl,
    now: () => "2026-06-10T04:01:00.000Z",
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.uploaded, true);
  assert.equal(promoted.dataset_id, DATASET_ID);
  assert.equal(promoted.dataset_version_id, DATASET_VERSION_ID);
  assert.equal(promoted.split, "test");

  const variantsPath = writeRuntimeRoleVariantsFile(root);
  const experiment = await runDecompositionExperiment({
    repoRoot: root,
    config,
    datasetName: DEFAULT_RICH_DATASET_NAME,
    variantId: RUNTIME_ROLE_VARIANT_ID,
    variantsPath,
    intentFlag: "promotion_candidate",
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: fakeCandidateEvalTask,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    now: () => new Date("2026-06-10T04:02:00.000Z"),
  });
  assert.equal(experiment.ok, true);
  assert.equal(experiment.status, "completed");
  assert.equal(experiment.intent, "promotion_candidate");
  assert.equal(experiment.variant_id, RUNTIME_ROLE_VARIANT_ID);
  assert.equal(experiment.candidate_target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(experiment.summary.evidence_counts.test_human_labeled_examples, 1);

  const storedReceipt = readExperimentReceipt({ repoRoot: root, receiptId: experiment.receipt_id });
  assert.equal(storedReceipt.exists, true);
  assert.equal(storedReceipt.receipt.schema_version, EXPERIMENT_RECEIPT_SCHEMA_VERSION);
  assert.equal(storedReceipt.receipt.launch.intent, "promotion_candidate");
  assert.equal(storedReceipt.receipt.launch.candidate_target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(
    storedReceipt.receipt.launch.launch_baseline.accepted_baseline_id,
    `sha256:${sha256File(root, ACCEPTED_RUNTIME_ROLES_PATH)}`,
  );
  assert.equal(
    storedReceipt.receipt.launch.launch_baseline.accepted_artifact_hash_vector.snapshot_sha256,
    sha256File(root, ACCEPTED_RUNTIME_ROLES_PATH),
  );
  assert.equal(storedReceipt.receipt.launch.candidate.candidate_version_id, RUNTIME_ROLE_VARIANT_ID);
  assert.equal(storedReceipt.receipt.launch.candidate.judge_candidate_prompt_version_id, null);

  const gate = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: experiment.receipt_id,
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    now: () => new Date("2026-06-10T04:03:00.000Z"),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "pass");
  assert.deepEqual(gate.failed_condition_ids, []);
  assert.equal(gate.candidate_target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(gate.candidate_version_id, RUNTIME_ROLE_VARIANT_ID);

  const githubTransport = createDryRunGitHubTransport({
    now: () => new Date("2026-06-10T04:04:00.000Z"),
  });
  const gitCalls = [];
  const runGit = (args, { cwd } = {}) => {
    gitCalls.push({ args: [...args], cwd });
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  const harness = createPromoteCandidateTestHarness({
    githubTransport,
    githubRepo: { owner: "fixture-owner", repo: "fixture-behavior" },
    ensureReady: readyUp,
    fetchImpl,
    baselineExperimentOverride: { experiment_id: BASELINE_EXPERIMENT_ID },
    runGit,
    env: {},
  });
  const request = {
    schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
    source: "agent_session",
    actor_id: "step17-fixture",
    expected_project: PROJECT_NAME,
    experiment_id: EXPERIMENT_ID,
    evaluator_id: "decomposition_quality_judge_v1",
    dataset_version_id: DATASET_VERSION_ID,
    annotation_ids: [HUMAN_ANNOTATION_ID],
    requested_action: "propose_repo_change",
    trigger_authenticity: "authenticated",
  };

  const first = await harness.promoteCandidate({
    repoRoot: root,
    request,
    invocation: { transport: "cli_local_session" },
  });

  assert.equal(first.ok, true);
  assert.equal(first.outcome, "route_to_hitl");
  assert.equal(first.dry_run, true);
  assert.equal(first.push.pushed, false);
  assert.equal(first.push.dry_run, true);
  assert.equal(first.candidate_target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(first.pr.reused, false);
  assert.equal(first.pr.url, "dry-run://github/fixture-owner/fixture-behavior/pull/9001");

  const createPrCall = githubTransport.calls.find((call) => call.endpointId === "create_pull_request");
  assert.ok(createPrCall, "dry-run GitHub transport should record the runtime-role PR creation intent");
  assert.equal(createPrCall.params.body, first.proposal_document);
  assert.equal(first.proposal_relative_path, null);
  assert.ok(createPrCall.params.body.includes("Runtime role assignments"));
  assert.ok(createPrCall.params.body.includes("- pm.model changes from claude-opus-4-8 to gpt-5.5."));
  assert.ok(
    createPrCall.params.body.includes(
      "Adopters without explicit role overrides change behavior when this merges.",
    ),
  );
  assert.equal(parsePromotionMarkers(createPrCall.params.body).length, 1);
  const markerRead = readPromotionMarker(createPrCall.params.body);
  assert.equal(markerRead.status, "ok");
  assert.equal(markerRead.marker.candidate_kind, "rule");
  assert.equal(markerRead.marker.candidate_target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(markerRead.marker.candidate_version_id, RUNTIME_ROLE_VARIANT_ID);
  assert.deepEqual(markerRead.marker.evidence_ids.annotations, [HUMAN_ANNOTATION_ID]);

  const cloneDir = internalCloneDir(root);
  assert.equal(
    runGitOrThrow(["rev-parse", first.branch], cloneDir).stdout.trim(),
    first.commit_sha,
    "the controller result branch must point at the runtime-role draft commit",
  );
  const commitFiles = splitGitLines(
    runGitOrThrow(["diff-tree", "--no-commit-id", "--name-only", "-r", first.commit_sha], cloneDir).stdout,
  ).sort();
  // P-PIN: the runtime-role promotion atomically commits the accepted artifact AND
  // the manifest pin (matching the accepted-prompt path).
  assert.deepEqual(commitFiles, [ACCEPTED_RUNTIME_ROLES_PATH, PHOENIX_ASSETS_MANIFEST_PATH].sort());
  const acceptedDefaults = JSON.parse(
    runGitOrThrow(["show", `${first.branch}:${ACCEPTED_RUNTIME_ROLES_PATH}`], cloneDir).stdout,
  );
  assert.equal(acceptedDefaults.roles.pm.runtime, "claude");
  assert.equal(acceptedDefaults.roles.pm.model, "gpt-5.5");
  assert.deepEqual(
    readPromotionCommitTrailers({ cloneDir, branch: first.branch, runGit: gitAdapter }),
    {
      ok: true,
      trailers: {
        envelope: first.normalized_envelope_hash,
        instance: first.proposal_instance_id,
        target: first.candidate_target_key,
      },
    },
  );

  assert.deepEqual(
    githubTransport.calls.map((call) => call.endpointId),
    ["list_open_pull_requests", "list_closed_pull_requests", "create_pull_request"],
  );
  assert.ok(githubTransport.calls.every((call) => call.path.startsWith("/repos/{owner}/{repo}/pulls")));
  assert.equal(state.writes.outcomeSpans.length, 1);
  assertNoMockFetchSurfaceContains(state, "improvement_opportunity");

  const second = await harness.promoteCandidate({
    repoRoot: root,
    request,
    invocation: { transport: "cli_local_session" },
  });
  assert.equal(second.ok, true);
  assert.equal(second.outcome, "route_to_hitl");
  assert.equal(second.idempotent_reuse, true);
  assert.equal(second.pr.number, first.pr.number);
  assert.equal(githubTransport.calls.filter((call) => call.endpointId === "create_pull_request").length, 1);
  assertNoMockFetchSurfaceContains(state, "improvement_opportunity");

  const registry = JSON.parse(fs.readFileSync(first.registry_path, "utf8"));
  assert.equal(
    registry.events.filter((event) => event.stage === "drafted").length,
    1,
    "same-envelope runtime-role reruns must not append duplicate drafted rows",
  );

  assert.ok(!gitCalls.some((call) => call.args[0] === "push"), "promotion workspace must not push");
  assert.ok(!githubTransport.calls.some((call) => /merge|ready|review/i.test(`${call.endpointId} ${call.path}`)));
  const hardFloor = {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: gitCalls.filter((call) => call.args[0] === "push").length,
    autoMergeOrMarkReadyCalls: githubTransport.calls.filter((call) => /merge|ready|review/i.test(`${call.endpointId} ${call.path}`)).length,
    gatewayWakeClaims: 0,
  };
  assert.deepEqual(hardFloor, {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: 0,
    autoMergeOrMarkReadyCalls: 0,
    gatewayWakeClaims: 0,
  });
});

test("Step 18 offline fixture runs self-drafting opportunity to scanner-routed HITL PR", async () => {
  const root = tempRoot();
  initGitRepo(root);
  const { fetchImpl, state } = createStep17PhoenixFixture();
  const readyUp = async () => ({ ok: true, appUrl: APP_URL, projectName: PROJECT_NAME });

  recordTestTraceStatus({
    repoRoot: root,
    runId: RUN_ID,
    projectId: "proj-step18",
    traceId: SOURCE_TRACE_ID,
    phoenixAppUrl: APP_URL,
    status: "trace_exported",
    observedAt: "2026-06-10T04:00:00.000Z",
  });
  writeRunArtifact({ repoRoot: root, runId: RUN_ID }, badRunArtifact());
  captureProjectSnapshot({
    repoRoot: root,
    runId: RUN_ID,
    project: sourceProject(),
    semanticStatus: "Planned",
    capturedAt: "2026-06-10T04:00:01.000Z",
  });

  const humanAnnotation = await createPhoenixTraceAnnotation({
    repoRoot: root,
    ensureReady: readyUp,
    fetchImpl,
    traceId: SOURCE_TRACE_ID,
    name: "quality",
    label: "needs_revision",
    score: 0.52,
    explanation: "The billing setup issue is not ready for another agent because it has no acceptance criteria.",
    annotatorKind: "HUMAN",
    identifier: "steve-step18-fixture",
    metadata: { failure_modes: ["missing_acceptance_criteria"] },
  });
  assert.deepEqual(humanAnnotation.annotationIds, [HUMAN_ANNOTATION_ID]);

  const promoted = await promoteRichDecompositionExample({
    repoRoot: root,
    runId: RUN_ID,
    annotationIds: humanAnnotation.annotationIds,
    ensureReady: readyUp,
    fetchImpl,
    now: () => "2026-06-10T04:01:00.000Z",
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.uploaded, true);
  assert.equal(promoted.dataset_id, DATASET_ID);
  assert.equal(promoted.dataset_version_id, DATASET_VERSION_ID);
  assert.equal(promoted.split, "test");

  const tempManifest = JSON.parse(fs.readFileSync(path.join(root, PHOENIX_ASSETS_MANIFEST_PATH), "utf8"));
  const srEngBaseline = tempManifest.experiments.find((entry) =>
    entry.purpose === "baseline" && entry.candidate_target_key === SR_ENG_TARGET_KEY);
  assert.equal(srEngBaseline.experiment_id, BASELINE_EXPERIMENT_ID);
  assert.deepEqual(srEngBaseline.accepted_artifact_hash_vector, {
    snapshot_path: SR_ENG_SNAPSHOT_PATH,
    snapshot_sha256: sha256File(root, SR_ENG_SNAPSHOT_PATH),
    accepted_prompt_version_id: null,
  });

  const opportunityHash = writeStep18OpportunityRecord(root);
  const registerCalls = [];
  const drafterGithubTransport = createDryRunGitHubTransport({
    now: () => new Date("2026-06-10T04:01:30.000Z"),
  });
  const drafterHarness = createImprovementDrafterTestHarness({
    config,
    policyPath: path.join(root, "execution/evals/decomposition/promotion-policy.json"),
    draftDir: path.join(root, ".teami", "drafts"),
    registryDir: path.join(root, ".teami", "promotion-candidates"),
    githubTransport: drafterGithubTransport,
    resolveRepoIdentity: () => ({
      ok: true,
      connection_mode: "dry_run",
      repo: { owner: "fixture-owner", repo: "fixture-behavior" },
    }),
    runCommand: async (command) => {
      assert.equal(command.mode, "session_start");
      const prompt = command.args[command.args.indexOf("-p") + 1];
      assert.match(prompt, new RegExp(SR_ENG_TARGET_KEY.replaceAll("/", "\\/")));
      assert.match(prompt, /missing_acceptance_criteria/);
      return JSON.stringify({
        schema_version: IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
        target_key: SR_ENG_TARGET_KEY,
        draft_content: DRAFTED_SR_ENG_PROMPT_CONTENT,
        change_summary: "Require senior-engineering grounding to catch unverifiable acceptance criteria.",
      });
    },
    registerPromptInPhoenixImpl: async (options) => {
      registerCalls.push(options);
      assert.equal(options.targetKey, SR_ENG_TARGET_KEY);
      assert.equal(options.contentText, DRAFTED_SR_ENG_PROMPT_CONTENT);
      return {
        ok: true,
        appUrl: APP_URL,
        target_key: SR_ENG_TARGET_KEY,
        role: "sr_eng",
        human_name: "Sr-eng grounding prompt",
        prompt_name: "sr_eng_grounding_pass",
        prompt_id: DRAFTED_SR_ENG_PROMPT_ID,
        prompt_version_id: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
        receipt_path: path.join(root, ".teami", "phoenix-prompt-registrations.json"),
        manifest_mutated: false,
      };
    },
    runDecompositionExperimentImpl: createStep18DraftExperimentImpl(),
    ensureReady: readyUp,
    fetchImpl,
    now: () => new Date("2026-06-10T04:02:00.000Z"),
    randomHex: () => "180001",
    env: { TEAMI_PHOENIX_URL: APP_URL },
  });

  const draft = await drafterHarness.runImprovementDrafter({
    repoRoot: root,
    opportunityHash,
    targetKey: null,
    failureModeIds: [],
    datasetName: DEFAULT_RICH_DATASET_NAME,
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.chain_state, "tagged");
  assert.equal(draft.target_key, SR_ENG_TARGET_KEY);
  assert.equal(draft.drafted_by, DRAFTED_BY);
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].contentText, DRAFTED_SR_ENG_PROMPT_CONTENT);
  assert.equal(state.writes.promptTags.length, 1);
  assert.equal(state.writes.promptTags[0].body.name, "teami_promotion_candidate");

  const storedDraft = readImprovementDraftReceipt({
    draftDir: path.join(root, ".teami", "drafts"),
    draftId: draft.draft_id,
  });
  assert.equal(storedDraft.exists, true);
  assert.equal(storedDraft.receipt.drafted_by, DRAFTED_BY);
  assert.equal(storedDraft.receipt.phoenix_prompt_version_id, DRAFTED_SR_ENG_PROMPT_VERSION_ID);
  assert.equal(storedDraft.receipt.experiment_receipt_id, "expr-step18-drafted-sr-eng");

  const storedExperiment = readExperimentReceipt({ repoRoot: root, receiptId: draft.experiment_receipt_id });
  assert.equal(storedExperiment.exists, true);
  assert.equal(storedExperiment.receipt.schema_version, EXPERIMENT_RECEIPT_SCHEMA_VERSION);
  assert.equal(storedExperiment.receipt.launch.intent, "promotion_candidate");
  assert.equal(storedExperiment.receipt.launch.drafted_by, DRAFTED_BY);
  assert.equal(storedExperiment.receipt.launch.candidate_target_key, SR_ENG_TARGET_KEY);
  assert.equal(
    storedExperiment.receipt.launch.candidate.prompt_overrides[SR_ENG_TARGET_KEY].candidate_prompt_version_id,
    DRAFTED_SR_ENG_PROMPT_VERSION_ID,
  );
  assert.equal(storedExperiment.receipt.launch.candidate.judge_candidate_prompt_version_id, DRAFTED_SR_ENG_PROMPT_VERSION_ID);
  assert.equal(storedExperiment.receipt.phoenix_experiment_id, EXPERIMENT_ID);

  const gate = await evaluateProcessChangeGate({
    repoRoot: root,
    receiptId: draft.experiment_receipt_id,
    ensureReady: readyUp,
    fetchImpl,
    now: () => new Date("2026-06-10T04:03:00.000Z"),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.verdict, "pass");
  assert.deepEqual(gate.failed_condition_ids, []);
  assert.equal(gate.candidate_target_key, SR_ENG_TARGET_KEY);
  assert.equal(gate.candidate_version_id, DRAFTED_SR_ENG_PROMPT_VERSION_ID);
  assert.equal(gate.product_report.repo_artifacts_owning_accepted_behavior.candidate_target_key, SR_ENG_TARGET_KEY);

  fs.mkdirSync(path.dirname(internalCloneDir(root)), { recursive: true });
  runGitOrThrow(["clone", "--no-hardlinks", root, internalCloneDir(root)], root);

  const githubTransport = createDryRunGitHubTransport({
    now: () => new Date("2026-06-10T04:04:00.000Z"),
  });
  const gitCalls = [];
  const runGit = (args, { cwd } = {}) => {
    gitCalls.push({ args: [...args], cwd });
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  const harness = createPromoteCandidateTestHarness({
    githubTransport,
    githubRepo: { owner: "fixture-owner", repo: "fixture-behavior" },
    ensureReady: readyUp,
    fetchImpl,
    runGit,
    env: {},
  });
  const proposal = await harness.promoteCandidate({
    repoRoot: root,
    request: {
      schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
      source: "agent_session",
      actor_id: "step18-fixture",
      expected_project: PROJECT_NAME,
      experiment_id: EXPERIMENT_ID,
      prompt_version_id: DRAFTED_SR_ENG_PROMPT_VERSION_ID,
      evaluator_id: "decomposition_quality_judge_v1",
      dataset_version_id: DATASET_VERSION_ID,
      annotation_ids: [HUMAN_ANNOTATION_ID],
      requested_action: "propose_repo_change",
      trigger_authenticity: "authenticated",
    },
    invocation: { transport: "promotion_candidate_scanner", unattended: false },
  });

  assert.equal(proposal.ok, true);
  assert.equal(proposal.outcome, "route_to_hitl");
  assert.equal(proposal.dry_run, true);
  assert.equal(proposal.push.pushed, false);
  assert.equal(proposal.push.dry_run, true);
  assert.equal(proposal.candidate_target_key, SR_ENG_TARGET_KEY);
  assert.equal(proposal.trigger_authenticity.value, "asserted");
  assert.equal(proposal.trigger_authenticity.derived_from, "promotion_candidate_scanner");
  assert.deepEqual(proposal.trigger_authenticity.ignored_caller_fields, ["trigger_authenticity"]);
  assert.equal(proposal.proposal_relative_path, null);

  const createPrCall = githubTransport.calls.find((call) => call.endpointId === "create_pull_request");
  assert.ok(createPrCall, "dry-run GitHub transport should record the drafted sr-eng PR creation intent");
  assert.equal(createPrCall.params.draft, false);
  assert.equal(createPrCall.params.body, proposal.proposal_document);
  assert.ok(createPrCall.params.body.includes(`Machine-drafted candidate (${DRAFTED_BY})`));
  assert.ok(createPrCall.params.body.includes(PROMOTION_MARKER_SENTINEL_BEGIN));
  assert.ok(createPrCall.params.body.includes(PROMOTION_MARKER_SENTINEL_END));
  assert.equal(parsePromotionMarkers(createPrCall.params.body).length, 1);

  const markerRead = readPromotionMarker(createPrCall.params.body);
  assert.equal(markerRead.status, "ok");
  assert.equal(markerRead.marker.candidate_target_key, SR_ENG_TARGET_KEY);
  assert.equal(markerRead.marker.candidate_version_id, DRAFTED_SR_ENG_PROMPT_VERSION_ID);
  assert.equal(markerRead.marker.evidence_ids.experiments[0], EXPERIMENT_ID);
  assert.deepEqual(markerRead.marker.evidence_ids.annotations, [HUMAN_ANNOTATION_ID]);

  const cloneDir = internalCloneDir(root);
  assert.equal(
    runGitOrThrow(["rev-parse", proposal.branch], cloneDir).stdout.trim(),
    proposal.commit_sha,
    "the controller result branch must point at the drafted sr-eng commit",
  );
  const commitFiles = splitGitLines(
    runGitOrThrow(["diff-tree", "--no-commit-id", "--name-only", "-r", proposal.commit_sha], cloneDir).stdout,
  ).sort();
  assert.deepEqual(commitFiles, [SR_ENG_SNAPSHOT_PATH, PHOENIX_ASSETS_MANIFEST_PATH].sort());
  assert.ok(
    !commitFiles.some((entry) => entry.startsWith("execution/evals/decomposition/proposals/")),
    "self-drafted behavior-diff commits must not include proposal documents",
  );

  assert.deepEqual(
    readPromotionCommitTrailers({ cloneDir, branch: proposal.branch, runGit: gitAdapter }),
    {
      ok: true,
      trailers: {
        envelope: proposal.normalized_envelope_hash,
        instance: proposal.proposal_instance_id,
        target: proposal.candidate_target_key,
      },
    },
  );
  assert.deepEqual(
    githubTransport.calls.map((call) => call.endpointId),
    ["list_open_pull_requests", "list_closed_pull_requests", "create_pull_request"],
  );
  assert.ok(githubTransport.calls.every((call) => call.path.startsWith("/repos/{owner}/{repo}/pulls")));
  assert.ok(!githubTransport.calls.some((call) => /merge|ready|review/i.test(`${call.endpointId} ${call.path}`)));
  assert.ok(!gitCalls.some((call) => call.args[0] === "push"), "promotion workspace must not push");
  assert.equal(state.writes.projectsCreated.length, 0, "mock project existed; no project creation path was needed");
  assert.equal(state.writes.outcomeSpans.length, 1, "controller outcome observation is a mock Phoenix write only");
  assert.ok(state.calls.every((call) => call.url.startsWith(APP_URL)), "all Phoenix traffic stayed inside the injected mock fetch");

  const hardFloor = {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: gitCalls.filter((call) => call.args[0] === "push").length,
    autoMergeOrMarkReadyCalls: githubTransport.calls.filter((call) => /merge|ready|review/i.test(`${call.endpointId} ${call.path}`)).length,
    gatewayWakeClaims: 0,
  };
  assert.deepEqual(hardFloor, {
    liveLinearMutations: 0,
    realPhoenixWrites: 0,
    realGitHubWrites: 0,
    gitPushes: 0,
    autoMergeOrMarkReadyCalls: 0,
    gatewayWakeClaims: 0,
  });
});
