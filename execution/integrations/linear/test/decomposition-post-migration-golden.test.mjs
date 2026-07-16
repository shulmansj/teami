import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeRunArtifact } from "../../../engine/run-store.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import { captureProjectSnapshot } from "../src/project-snapshot-store.mjs";
import { recordTraceStatus } from "../src/trace-status-store.mjs";
import {
  loadJudgePromptContract,
  runDecompositionQualityJudge,
} from "../src/decomposition-quality-judge.mjs";
import {
  createImprovementDrafterTestHarness,
  IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
} from "../src/improvement-drafter.mjs";
import {
  EXPERIMENT_RECEIPT_SCHEMA_VERSION,
  readExperimentReceipt,
  runDecompositionExperiment,
} from "../src/phoenix-experiment.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  makeTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { DEFAULT_ANNOTATION_NAME } from "../src/eval-annotation-contract.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "post-migration-golden",
  "decomposition-self-improvement.json",
);
const UPDATE_FIXTURE = process.env.UPDATE_DECOMPOSITION_POST_MIGRATION_GOLDEN === "1";

const FIXED_NOW = new Date("2026-06-28T12:00:00.000Z");
const TRACE_ID = "11112222333344445555666677778888";
const JUDGE_MODEL = "judge-model-golden";
const DRAFTER_MODEL = "claude-opus-4-8";
const TARGET_KEY = "prompt/decomposition/sr_eng_grounding_pass";
const DATASET_NAME = "teami-decomposition-examples";
const VALID_FAILURE_MODE = "missing_acceptance_criteria";
const DECOMPOSITION_FUNCTION_VERSION = "0.2.0";

test("post-migration decomposition golden pins judge annotation, drafter draft, and experiment receipt bytes", async () => {
  const actual = {
    schema_version: "decomposition-post-migration-golden/v1",
    captured_after: "A0.5a uniform-quality migration",
    surfaces: {
      judge_annotation_body: await captureJudgeAnnotationBody(),
      drafter_draft_bytes: await captureDrafterDraftBytes(),
      experiment_receipt_bytes: await captureExperimentReceiptBytes(),
    },
  };

  const judgeAnnotation = JSON.parse(actual.surfaces.judge_annotation_body).data[0];
  assert.equal(judgeAnnotation.name, DEFAULT_ANNOTATION_NAME);
  assert.equal(DEFAULT_ANNOTATION_NAME, "quality");
  assert.notEqual(judgeAnnotation.name, "decomposition_quality");
  assert.equal(actual.surfaces.judge_annotation_body.includes("\"name\":\"decomposition_quality\""), false);

  if (UPDATE_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.deepEqual(actual, expected);
});

async function captureJudgeAnnotationBody() {
  const repoRoot = tempRoot("judge");
  const runId = "run-post-migration-golden";
  seedJudgeRun(repoRoot, runId);

  const posts = [];
  const result = await runDecompositionQualityJudge({
    repoRoot,
    runId,
    config: runtimeConfig(),
    runCommand: async () => JSON.stringify({
      label: "pass",
      score: 0.92,
      explanation: "Issues preserve intent and are independently executable.",
      failure_modes: [],
    }),
    ensureReady: readyUp,
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/v1/trace_annotations?sync=true")) {
        posts.push(init.body);
        return new Response(JSON.stringify({ data: [{ id: "anno-post-migration-golden" }] }), { status: 200 });
      }
      throw new Error(`unexpected judge request ${target}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "phoenix_native");
  assert.equal(posts.length, 1);
  return posts[0];
}

async function captureDrafterDraftBytes() {
  const repoRoot = tempRoot("drafter");
  copyDecompositionEvalAssets(repoRoot);
  writeTestTeamRegistry(repoRoot);

  const draftContent = [
    "# Accepted Sr Eng Grounding Prompt",
    "",
    "```yaml",
    "prompt_version: post-migration-golden",
    "phoenix_prompt_role: sr_eng",
    `target_key: ${TARGET_KEY}`,
    "```",
    "",
    "## Persona",
    "",
    "Preserve product consequence framing while tightening acceptance-criteria checks.",
    "",
  ].join("\n");
  const runtimeOutput = [
    JSON.stringify({
      schema_version: IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
      target_key: TARGET_KEY,
      draft_content: "@@DRAFT_CONTENT@@",
      change_summary: "Tightens acceptance-criteria coverage.",
    }),
    "-----BEGIN DRAFT CONTENT-----",
    draftContent,
    "-----END DRAFT CONTENT-----",
    "",
  ].join("\n");
  const chain = makeDrafterChain();
  const harness = createImprovementDrafterTestHarness({
    repoRoot,
    config: runtimeConfig(),
    policyPath: path.join(repoRoot, "execution", "evals", "decomposition", "promotion-policy.json"),
    draftDir: path.join(repoRoot, "drafts"),
    registryDir: path.join(repoRoot, "promotion-candidates"),
    githubTransport: emptyGitHubTransport(),
    resolveRepoIdentity: identityOk,
    runCommand: async () => runtimeOutput,
    registerPromptInPhoenixImpl: chain.registerPromptInPhoenixImpl,
    runDecompositionExperimentImpl: chain.runDecompositionExperimentImpl,
    ensureReady: chain.ensureReady,
    fetchImpl: chain.fetchImpl,
    startAgentTraceImpl: async () => null,
    now: () => FIXED_NOW,
    randomHex: () => "000001",
    env: { TEAMI_PHOENIX_URL: "http://127.0.0.1:6006" },
  });

  const result = await harness.runImprovementDrafter({
    repoRoot,
    targetKey: TARGET_KEY,
    failureModeIds: [VALID_FAILURE_MODE],
    datasetName: DATASET_NAME,
    supersedeExistingCandidate: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.chain_state, "tagged");
  assert.equal(chain.registerCalls.length, 1);
  assert.equal(chain.experimentCalls.length, 1);
  assert.equal(chain.tagPosts.length, 1);
  return fs.readFileSync(result.content_path, "utf8");
}

async function captureExperimentReceiptBytes() {
  const repoRoot = tempRoot("experiment");
  const records = [experimentExample({ id: "EX-GOLDEN" })];
  const fetchImpl = fetchRouter(experimentRoutes({ records }));
  const result = await runDecompositionExperiment({
    repoRoot,
    config: runtimeConfig(),
    datasetName: "eval-ds-golden",
    ensureReady: readyUp,
    fetchImpl,
    runEvalTaskFn: async (args) => fakeExperimentTaskResult({ exampleId: args.datasetExampleId }),
    now: () => FIXED_NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.phoenix_experiment_id, "EXP-GOLDEN");
  const stored = readExperimentReceipt({ receiptId: result.receipt_id, repoRoot });
  assert.equal(stored.exists, true);
  assert.equal(stored.receipt.schema_version, EXPERIMENT_RECEIPT_SCHEMA_VERSION);
  return normalizeExperimentReceiptBytes(stored.receipt);
}

function seedJudgeRun(repoRoot, runId) {
  writeRunArtifact({ repoRoot, runId }, commitArtifact(runId));
  captureProjectSnapshot({
    repoRoot,
    runId,
    teamRef: "support-ops",
    project: {
      id: "project-post-migration-golden",
      name: "Post Migration Golden Project",
      description: "fixture",
      content: "## Goal\nShip the golden fixture.",
      status: { name: "Planned", type: "planned" },
      labels: [],
      issues: [],
    },
    semanticStatus: "planned",
  });
  recordTraceStatus({
    repoRoot,
    runId,
    projectId: "project-post-migration-golden",
    traceId: TRACE_ID,
    phoenixAppUrl: "http://127.0.0.1:6006",
    status: "trace_exported",
    observedAt: FIXED_NOW.toISOString(),
    teamRef: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
  });
}

function commitArtifact(runId) {
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
      context_digest: "post-migration golden digest",
      source_refs: [],
      assumptions: ["One active team owns this roadmap item."],
      constraints: [],
      risks: [],
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
        title: "Write the first fixture issue",
        issue_body_markdown: "## Assignment\n\nDo the first thing.",
        depends_on: [],
      },
      {
        decomposition_key: "step/two",
        title: "Write the second fixture issue",
        issue_body_markdown: "## Assignment\n\nDo the second thing.",
        depends_on: ["step/one"],
      },
    ],
    project_update_markdown: `run_id: ${runId}\n\nFixture decomposition completed.`,
  };
}

function fakeExperimentTaskResult({ exampleId }) {
  const contract = loadJudgePromptContract();
  return {
    ok: true,
    status: "evaluated",
    eval_run_id: `eval-${exampleId}`,
    variant_id: "accepted_baseline",
    inputs_hash: "0".repeat(64),
    terminal: {
      status: "completed",
      reason: "no_blockers",
      final_issues: [],
      discovery_issues: [],
      dependency_relations: [],
      project_update_markdown: `run_id: eval-${exampleId}\n\nEvaluated fixture.`,
      open_questions_markdown: null,
    },
    trace: { trace_id: "99998888777766665555444433332222", trace_status: "trace_exported" },
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
      ],
    },
    judge: {
      ok: true,
      judge_state: "judged",
      identifier: `decomposition_quality_judge_v1:${JUDGE_MODEL}`,
      model: JUDGE_MODEL,
      prompt_source: "repo_accepted_snapshot",
      prompt_version: contract.entry.accepted_prompt_version_id || `sha256:${contract.snapshotSha256}`,
      judge: {
        label: "pass",
        score: 0.9,
        explanation: "judged in post-migration golden",
        failure_modes: [],
        failure_mode_details: [],
      },
    },
  };
}

function experimentExample({ id }) {
  return {
    id,
    input: {
      source_type: "linear_project_snapshot",
      project: {
        id: "project-post-migration-golden",
        name: "Post Migration Golden Project",
        description: null,
        content: "## Goal\n\nExercise the decomposition self-improvement loop.",
        status: "planned",
        labels: [],
        existing_issues: [],
      },
      run_envelope: {
        workflow_version: DECOMPOSITION_FUNCTION_VERSION,
        allowed_source_boundaries: [],
        runtime_assignments: { pm: "claude/model-a", sr_eng: "codex/model-b" },
      },
      source_refs: [],
    },
    output: {
      terminal_status: "completed",
      terminal_reason: "no_blockers",
      final_issues: [],
      discovery_issues: [],
      dependency_relations: [],
      project_update_markdown: "run_id: source_run\n\nFixture output.",
    },
    metadata: {
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: "active",
      dataset_split: "train",
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
      source_trace_id: null,
      source_run_id: `source_${id}`,
      content_retention: "sanitized_fixture",
      schema_version: "decomposition-eval-example/v1",
      reference: { human_annotations: [] },
    },
  };
}

function experimentRoutes({ records }) {
  let runCounter = 0;
  let evalCounter = 0;
  return {
    "GET /openapi.json": jsonResponse({
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
    }),
    "GET /v1/datasets": jsonResponse({ data: [{ id: "DS-GOLDEN", name: "eval-ds-golden" }] }),
    "GET /v1/datasets/DS-GOLDEN/versions": jsonResponse({ data: [{ version_id: "DSV-GOLDEN" }], next_cursor: null }),
    "GET /v1/datasets/DS-GOLDEN/examples": jsonResponse({
      data: { dataset_id: "DS-GOLDEN", version_id: "DSV-GOLDEN", examples: records },
    }),
    "POST /v1/datasets/DS-GOLDEN/experiments": (call) => jsonResponse({
      data: {
        id: "EXP-GOLDEN",
        dataset_id: "DS-GOLDEN",
        dataset_version_id: "DSV-GOLDEN",
        repetitions: 1,
        metadata: call.body.metadata || {},
        project_name: "teami",
      },
    }),
    "POST /v1/experiments/EXP-GOLDEN/runs": () => {
      runCounter += 1;
      return jsonResponse({ data: { id: `EXPRUN-GOLDEN-${runCounter}` } });
    },
    "POST /v1/experiment_evaluations": () => {
      evalCounter += 1;
      return jsonResponse({ data: { id: `EXPEVAL-GOLDEN-${evalCounter}` } });
    },
  };
}

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

function makeDrafterChain() {
  const registerCalls = [];
  const experimentCalls = [];
  const tagPosts = [];
  return {
    registerCalls,
    experimentCalls,
    tagPosts,
    registerPromptInPhoenixImpl: async (options) => {
      registerCalls.push(options);
      return {
        ok: true,
        appUrl: "http://127.0.0.1:6006",
        target_key: TARGET_KEY,
        role: "sr_eng",
        human_name: "Sr-eng grounding prompt",
        prompt_name: "sr_eng_grounding_pass",
        prompt_id: "P-GOLDEN",
        prompt_version_id: "PV-GOLDEN",
        receipt_path: path.join(options.repoRoot, "phoenix-prompt-registrations.json"),
        manifest_mutated: false,
      };
    },
    runDecompositionExperimentImpl: async (options) => {
      experimentCalls.push(options);
      return {
        ok: true,
        receipt_id: "expr-draft-golden",
        receipt_path: path.join(options.repoRoot, "experiments", "expr-draft-golden.json"),
        phoenix_experiment_id: "EXP-DRAFT-GOLDEN",
      };
    },
    ensureReady: readyUp,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET" && parsed.pathname === "/v1/prompts/P-GOLDEN/tags/teami_promotion_candidate") {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (method === "POST" && parsed.pathname === "/v1/prompt_versions/PV-GOLDEN/tags") {
        tagPosts.push({ pathname: parsed.pathname, body: init.body ? JSON.parse(init.body) : null });
        return jsonResponse({}, 204);
      }
      throw new Error(`unexpected drafter chain request: ${method} ${parsed.pathname}`);
    },
  };
}

function normalizeExperimentReceiptBytes(receipt) {
  const normalized = structuredClone(receipt);
  normalized.receipt_id = normalizeGeneratedId(normalized.receipt_id, "expr");
  normalized.launch.teami_run_id = normalizeGeneratedId(
    normalized.launch.teami_run_id,
    "afexp",
  );
  normalized.launch.actor.os_username = "<os_username>";
  normalized.events = normalized.events.map((event) => {
    const copy = structuredClone(event);
    if (copy.actor?.os_username) copy.actor.os_username = "<os_username>";
    return copy;
  });
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function normalizeGeneratedId(value, prefix) {
  const stamp = FIXED_NOW.toISOString().replace(/[-:.]/g, "");
  return String(value).replace(new RegExp(`^${prefix}-${stamp}-[a-f0-9]{6}$`), `${prefix}-${stamp}-<random>`);
}

function runtimeConfig() {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  config.runtime ||= {};
  config.runtime.adapters ||= {};
  config.runtime.adapters.codex = {
    ...(config.runtime.adapters.codex || {}),
    command: "codex",
    tool_policy: { linear_write: false },
  };
  config.runtime.adapters.claude = {
    ...(config.runtime.adapters.claude || {}),
    command: "claude",
    tool_policy: { linear_write: false },
  };
  config.workflows ||= {};
  config.workflows.decomposition ||= {};
  config.workflows.decomposition.roles ||= {};
  config.workflows.decomposition.roles.judge = {
    runtime: "codex",
    model: JUDGE_MODEL,
  };
  config.workflows.decomposition.roles.drafter = {
    runtime: "claude",
    model: DRAFTER_MODEL,
  };
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

function copyDecompositionEvalAssets(repoRoot) {
  const source = path.join(REPO_ROOT, "execution", "evals", "decomposition");
  const target = path.join(repoRoot, "execution", "evals", "decomposition");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function writeTestTeamRegistry(repoRoot) {
  writeTeamRegistry(
    { repoRoot },
    {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [
        makeTeamRecord({
          teamRef: "support-ops",
          status: "active",
          workspaceId: "workspace-1",
          workspaceName: "Support Ops",
          teamId: "team-1",
          teamKey: "SUP",
          teamName: "Support Ops",
        }),
      ],
    },
  );
}

function emptyGitHubTransport() {
  return {
    async request({ endpointId }) {
      if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
        return { data: [] };
      }
      throw new Error(`unexpected github request ${endpointId}`);
    },
  };
}

function identityOk() {
  return {
    ok: true,
    connection_mode: "dry_run",
    repo_id: "R-GOLDEN",
    repo: { owner: "octo", repo: "teami" },
  };
}

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `teami-post-migration-${label}-`));
  process.env.TEAMI_HOME = root;
  return root;
}

const readyUp = async () => ({
  ok: true,
  appUrl: "http://127.0.0.1:6006",
  projectName: "teami",
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return status === 204 ? "" : JSON.stringify(body);
    },
  };
}
