import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMockGitHubTransport } from "../src/github-promotion-client.mjs";
import { GITHUB_CONNECTION_SCHEMA_VERSION } from "../src/github-setup.mjs";
import {
  buildPromotionMarker,
  renderPromotionMarkerBlock,
} from "../src/promote-candidate.mjs";
import {
  createPromotionCandidateScannerTestHarness,
  defaultPromotionCandidateLedgerDir,
  formatPromotionCandidateScanReport,
  PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN,
  PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
  PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
  promotionScannerLockPath,
  promotionScannerLedgerPath,
  REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION,
  readPromotionScannerLedger,
  scanPromotionCandidates,
  UNTRUSTED_SCANNER_OVERRIDE_KEYS,
} from "../src/promotion-candidate-scanner.mjs";
import { PROMOTION_POLICY_SCHEMA_VERSION } from "../src/promotion-policy.mjs";
import { acceptedStateHash } from "../src/promotion-scanner/accepted-baseline.mjs";

const repoCheckout = path.resolve(import.meta.dirname, "../../../..");
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(repoCheckout, "execution", "evals", "decomposition", "phoenix-assets.json"),
    "utf8",
  ),
);
// The default scanner sample target is the adopter-owned sr_eng grounding prompt
// (the judge is excluded from adopter self-improvement and would be ignored).
const SAMPLE_PROMPT_ENTRY = manifest.prompts.find(
  (entry) => entry.target_key === "prompt/decomposition/sr_eng_grounding_pass",
);
const EXPECTED_BASELINE_ID = SAMPLE_PROMPT_ENTRY.accepted_prompt_version_id
  || `sha256:${SAMPLE_PROMPT_ENTRY.snapshot_sha256}`;
const RUNTIME_ROLE_TARGET_KEY = "rule/decomposition/runtime_role_assignments";
const EXPECTED_RUNTIME_ROLE_BASELINE_ID = `sha256:${
  manifest.rules.find((entry) => entry.target_key === RUNTIME_ROLE_TARGET_KEY).snapshot_sha256
}`;
const EXPECTED_POLICY_BASELINE_ID = `sha256:${acceptedStateHash(manifest)}`;
const NOW = new Date("2026-06-10T03:00:00.000Z");
const PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION_V1 =
  "agentic-factory-promotion-scanner-ledger/v1";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-scanner-"));
}

function runGitOrThrow(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function initGitRepo(root) {
  runGitOrThrow(["init", "--initial-branch=main"], root);
  runGitOrThrow(["add", "."], root);
  runGitOrThrow(
    ["-c", "user.name=scanner-test", "-c", "user.email=scanner-test@example.invalid", "commit", "-m", "fixture"],
    root,
  );
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

function fetchRouter({
  prompts = [],
  tagsByPrompt = {},
  promptVersions = {},
  experiments = {},
} = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, pathname: parsed.pathname, search: parsed.search, body: init.body ?? null });
    if (method !== "GET") throw new Error(`unexpected mutation: ${method} ${parsed.pathname}`);
    if (parsed.pathname === "/openapi.json") {
      return jsonResponse({
        paths: {
          "/v1/prompts": { get: {} },
          "/v1/prompts/{prompt_identifier}/tags/{tag_name}": { get: {} },
          "/v1/prompt_versions/{prompt_version_id}": { get: {} },
        },
      });
    }
    if (parsed.pathname === "/v1/prompts") return jsonResponse({ data: prompts, next_cursor: null });
    const tagMatch = parsed.pathname.match(/^\/v1\/prompts\/([^/]+)\/tags\/([^/]+)$/);
    if (tagMatch) {
      const promptId = decodeURIComponent(tagMatch[1]);
      const tag = tagsByPrompt[promptId];
      return tag ? jsonResponse({ data: tag }) : jsonResponse({ detail: "not found" }, 404);
    }
    const versionMatch = parsed.pathname.match(/^\/v1\/prompt_versions\/([^/]+)$/);
    if (versionMatch) {
      const versionId = decodeURIComponent(versionMatch[1]);
      const version = promptVersions[versionId];
      return version ? jsonResponse({ data: version }) : jsonResponse({ detail: "not found" }, 404);
    }
    const experimentMatch = parsed.pathname.match(/^\/v1\/experiments\/([^/]+)$/);
    if (experimentMatch) {
      const experimentId = decodeURIComponent(experimentMatch[1]);
      const experiment = experiments[experimentId];
      return experiment ? jsonResponse({ data: experiment }) : jsonResponse({ detail: "not found" }, 404);
    }
    throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
  };
  impl.calls = calls;
  return impl;
}

function readyUp() {
  return { ok: true, appUrl: "http://127.0.0.1:6006", projectName: "agentic-factory" };
}

function scannerRouting(overrides = {}) {
  const base = {
    enabled: true,
    freshness_window_days: 14,
    eligible_phoenix: {
      project_names: ["agentic-factory"],
      dataset_names: ["eval-ds"],
      split_names: ["train", "test"],
    },
    explicit_intent_signals: {
      managed_experiment_receipt_intent: "promotion_candidate",
      prompt_version_candidate_tag: "agentic_factory_promotion_candidate",
      repo_candidate_artifact_intent: "promotion_candidate",
      authenticated_registration: "deferred",
    },
    repo_candidate_artifact_stubs: [],
    phoenix_native_auto_proposal: false,
  };
  return {
    ...base,
    ...overrides,
    eligible_phoenix: { ...base.eligible_phoenix, ...(overrides.eligible_phoenix || {}) },
    explicit_intent_signals: { ...base.explicit_intent_signals, ...(overrides.explicit_intent_signals || {}) },
  };
}

function promotionPolicy(overrides = {}) {
  const base = {
    schema_version: PROMOTION_POLICY_SCHEMA_VERSION,
    policy_version: "1.0.0",
    disabled: false,
    lookback_days: 90,
    max_open_proposals: 3,
    proposal_budget: { max_proposals: 5, period_days: 7 },
    eligible_launch_sources: ["managed_manual", "managed_automated", "phoenix_native_registered"],
    drafting: {
      max_drafts_per_target_per_period: 2,
      period_days: 7,
    },
    scanner_routing: scannerRouting(),
    required_evidence_id_kinds: ["experiment_id", "dataset_id", "dataset_version_id"],
    risk_defaults: { prior_test_split_exposure_defaults_high_risk: true },
  };
  return {
    ...base,
    ...overrides,
    proposal_budget: { ...base.proposal_budget, ...(overrides.proposal_budget || {}) },
    scanner_routing: scannerRouting(overrides.scanner_routing || {}),
    risk_defaults: { ...base.risk_defaults, ...(overrides.risk_defaults || {}) },
  };
}

function writePolicy(root, policy = promotionPolicy()) {
  const policyDir = path.join(root, "execution", "evals", "decomposition");
  fs.mkdirSync(policyDir, { recursive: true });
  const policyPath = path.join(policyDir, "promotion-policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return policyPath;
}

function writePhoenixAssets(root, {
  snapshotText = "accepted scanner prompt\n",
  acceptedPromptVersionId = null,
  extraPrompts = [],
} = {}) {
  const evalDir = path.join(root, "execution", "evals", "decomposition");
  const snapshotRelative = "execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md";
  const snapshotPath = path.join(root, ...snapshotRelative.split("/"));
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, snapshotText, "utf8");
  const snapshotSha = createHash("sha256").update(snapshotText).digest("hex");
  const manifest = {
    schema_version: 1,
    phoenix: {
      expected_origin: "http://127.0.0.1:6006",
      server_package_pin: "arize-phoenix==14.13.0",
      project_name: "agentic-factory",
    },
    prompts: [{
      role: "sr_eng",
      target_key: "prompt/decomposition/sr_eng_grounding_pass",
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      prompt_name: "sr_eng_grounding_pass",
      prompt_id: "P1",
      accepted_prompt_version_id: acceptedPromptVersionId,
      accepted_tag: "agentic_factory_accepted",
      candidate_tag: "agentic_factory_promotion_candidate",
      snapshot_path: snapshotRelative,
      snapshot_sha256: snapshotSha,
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
    }, ...extraPrompts],
    evaluators: [],
    datasets: [{
      name: "eval-ds",
      dataset_id: "DS1",
      accepted_dataset_version_id: "DSV1",
    }],
    experiments: [],
    evidence: { annotation_ids: [], receipt_run_ids: [], pr_urls: [] },
  };
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(
    path.join(evalDir, "phoenix-assets.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { manifest, acceptedBaselineId: acceptedPromptVersionId || `sha256:${snapshotSha}` };
}

function writeRuntimeOnlyPhoenixAssets(root) {
  const evalDir = path.join(root, "execution", "evals", "decomposition");
  const runtimeArtifactRelative = "execution/evals/decomposition/accepted-runtime-roles.json";
  const runtimeArtifactPath = path.join(root, ...runtimeArtifactRelative.split("/"));
  fs.mkdirSync(path.dirname(runtimeArtifactPath), { recursive: true });
  fs.copyFileSync(
    path.join(repoCheckout, ...runtimeArtifactRelative.split("/")),
    runtimeArtifactPath,
  );
  const runtimeRule = structuredClone(
    manifest.rules.find((entry) => entry.target_key === RUNTIME_ROLE_TARGET_KEY),
  );
  const runtimeOnlyManifest = {
    schema_version: 1,
    phoenix: {
      expected_origin: "http://127.0.0.1:6006",
      server_package_pin: "arize-phoenix==14.13.0",
      project_name: "agentic-factory",
    },
    prompts: [],
    evaluators: [],
    rules: [runtimeRule],
    datasets: [{
      name: "eval-ds",
      dataset_id: "DS1",
      accepted_dataset_version_id: "DSV1",
    }],
    experiments: [],
    evidence: { annotation_ids: [], receipt_run_ids: [], pr_urls: [] },
  };
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(
    path.join(evalDir, "phoenix-assets.json"),
    `${JSON.stringify(runtimeOnlyManifest, null, 2)}\n`,
    "utf8",
  );
  return runtimeOnlyManifest;
}

function phasePromptFixture(root, {
  targetKey = "prompt/decomposition/pm_product_sufficiency_pass",
  role = "pm",
  promptName = targetKey.split("/").at(-1),
  snapshotText = "accepted phase scanner prompt\n",
  acceptedPromptVersionId = null,
} = {}) {
  const snapshotRelative =
    `execution/evals/decomposition/accepted-prompts/${promptName.replaceAll("_", "-")}.md`;
  const snapshotPath = path.join(root, ...snapshotRelative.split("/"));
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, snapshotText, "utf8");
  const snapshotSha = createHash("sha256").update(snapshotText).digest("hex");
  return {
    entry: {
      role,
      target_key: targetKey,
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      prompt_name: promptName,
      prompt_id: "P-PM",
      accepted_prompt_version_id: acceptedPromptVersionId,
      accepted_tag: "agentic_factory_accepted",
      candidate_tag: "agentic_factory_promotion_candidate",
      snapshot_path: snapshotRelative,
      snapshot_sha256: snapshotSha,
    },
    acceptedBaselineId: acceptedPromptVersionId || `sha256:${snapshotSha}`,
  };
}

function writeVerifiedGitHubState(root, overrides = {}) {
  const filePath = path.join(root, ".agentic-factory", "github-connection.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state = {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "dry_run",
    status: "verified",
    repo: {
      id: "fixture-repo-1",
      owner: "fixture-owner",
      name: "fixture-behavior",
      full_name: "fixture-owner/fixture-behavior",
    },
    app_installation: null,
    local_auth: {
      mode: "local_ambient",
      gh_auth: "dry_run",
      git_write: "dry_run",
      real_push_enabled: false,
      push_auth: "https",
      checked_at: "2026-06-10T03:00:00.000Z",
    },
    push_auth: "https",
    ...overrides,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

function writeReceipt(root, {
  receiptId = "expr-1",
  experimentId = "EXP1",
  intent = "promotion_candidate",
  launchedAt = "2026-06-10T01:00:00.000Z",
  source = "managed_manual",
  candidateTargetKey = "prompt/decomposition/sr_eng_grounding_pass",
  candidateVersionId = "PV1",
  promptVersionId = "PV1",
  datasetId = "DS1",
  datasetVersionId = "DSV1",
  datasetName = "eval-ds",
  split = "test",
  baselineId = null,
  draftedBy = null,
  amendments = [],
} = {}) {
  const resolvedBaselineId = baselineId || expectedBaselineIdForTarget(candidateTargetKey);
  const receipt = {
    schema_version: "agentic-factory-managed-experiment-receipt/v1",
    receipt_id: receiptId,
    source,
    created_at: launchedAt,
    launch: {
      intent,
      intent_source: intent === "promotion_candidate" ? "explicit_flag" : "default_exploratory_no_automation_policy",
      candidate_target_key: candidateTargetKey,
      launch_baseline: {
        derived_from: "phoenix_assets_manifest",
        accepted_baseline_id: resolvedBaselineId,
        manifest_path: "execution/evals/decomposition/phoenix-assets.json",
        manifest_sha256: "0".repeat(64),
      },
      candidate: {
        variant_id: "variant-1",
        variant_source: "variants_json",
        candidate_version_id: candidateVersionId,
        role_overrides: {},
        judge_candidate_prompt_version_id: promptVersionId,
      },
      dataset: { name: datasetName, dataset_id: datasetId, dataset_version_id: datasetVersionId },
      split: { requested: split, selection: "native_split_filter", disclosure: null, example_ids: [] },
      evaluators: {
        code: ["accepted_packet_sufficiency_offline_v1"],
        judge: {
          evaluator_id: "decomposition_quality_judge_v1",
          model: "test-model",
          runtime: "claude",
          identifier: "decomposition_quality_judge_v1:test-model",
          prompt_source: promptVersionId ? "phoenix_candidate_version" : "repo_accepted_snapshot",
          prompt_version: promptVersionId || resolvedBaselineId,
        },
      },
      promotion_policy: null,
      workspace_eval_policy: { schema_version: "agentic-factory-workspace-eval-policy/v1", sha256: "1".repeat(64) },
      actor: { os_username: "test", authenticity: "asserted" },
      launched_at: launchedAt,
      phoenix_scope: { origin: "http://127.0.0.1:6006", project_name: "agentic-factory" },
      agentic_factory_run_id: `afexp-${receiptId}`,
      ...(draftedBy ? { drafted_by: draftedBy } : {}),
    },
    phoenix_experiment_id: experimentId,
    events: [{ type: "launched", at: launchedAt }],
    amendments,
  };
  const dir = path.join(root, ".agentic-factory", "experiments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${receiptId}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function expectedBaselineIdForTarget(candidateTargetKey) {
  if (candidateTargetKey === RUNTIME_ROLE_TARGET_KEY) return EXPECTED_RUNTIME_ROLE_BASELINE_ID;
  if (candidateTargetKey === "policy/decomposition/accepted_baseline") return EXPECTED_POLICY_BASELINE_ID;
  return EXPECTED_BASELINE_ID;
}

function experimentFixture({
  id = "EXP1",
  datasetId = "DS1",
  datasetVersionId = "DSV1",
  projectName = "agentic-factory",
} = {}) {
  return { id, dataset_id: datasetId, dataset_version_id: datasetVersionId, project_name: projectName, metadata: {} };
}

function markerBody({
  proposalInstanceId = "prop-existing",
  target = "prompt/decomposition/sr_eng_grounding_pass",
  envelopeHash = "a".repeat(64),
  state = "proposed",
} = {}) {
  return renderPromotionMarkerBlock(buildPromotionMarker({
    proposalInstanceId,
    candidateTargetKey: target,
    candidateKind: target.split("/")[0],
    candidateVersionId: "PV-old",
    acceptedBaselineId: EXPECTED_BASELINE_ID,
    normalizedEnvelopeHash: envelopeHash,
    policyHash: "b".repeat(64),
    phoenixScope: { origin: "http://127.0.0.1:6006", project_name: "agentic-factory" },
    evidenceIds: { experiments: ["EXP0"], datasets: [{ dataset_id: "DS1", dataset_version_id: "DSV1" }], annotations: [] },
    proposalState: state,
  }));
}

async function runScanner({
  root,
  policy = promotionPolicy(),
  fetchImpl = null,
  githubTransport = createMockGitHubTransport(),
  ensureReady = readyUp,
  promoteCandidateFn = null,
} = {}) {
  const policyPath = writePolicy(root, policy);
  writeVerifiedGitHubState(root);
  const calls = [];
  const controller = promoteCandidateFn || (async (options) => {
    calls.push(options);
    return {
      ok: true,
      outcome: "route_to_hitl",
      proposal_instance_id: `prop-${calls.length}`,
      pr: { number: 100 + calls.length, url: `mock://pr/${calls.length}`, dry_run: true },
    };
  });
  const harness = createPromotionCandidateScannerTestHarness({
    policyPath,
    ensureReady,
    fetchImpl: fetchImpl || fetchRouter(),
    githubTransport,
    promoteCandidateFn: controller,
    env: { AGENTIC_FACTORY_PROMOTION_WRITE_GUARD: "fail_closed" },
    now: () => NOW,
  });
  const progress = [];
  const result = await harness.scanPromotionCandidates({
    repoRoot: root,
    onProgress: (line) => progress.push(line),
  });
  return { result, calls, progress, githubTransport };
}

test("scanner ledger rows derive outcome statuses and evidence display classes", async () => {
  const routeRoot = tempRoot();
  writeReceipt(routeRoot);
  const route = await runScanner({
    root: routeRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    promoteCandidateFn: async () => ({
      ok: true,
      outcome: "route_to_hitl",
      proposal_instance_id: "prop-route",
      pr_title: "Proposal: improve decomposition judge",
      pr: {
        number: 201,
        url: "mock://pr/route",
        title: "Proposal: improve decomposition judge",
        dry_run: true,
      },
    }),
  });
  assert.equal(route.result.candidates[0].status, "controller_called_pr_opened");
  assert.equal(route.result.candidates[0].pr_title, "Proposal: improve decomposition judge");
  assert.equal(route.result.health.summary.status_counts.controller_called_pr_opened, 1);

  const opportunityRoot = tempRoot();
  writeReceipt(opportunityRoot);
  const improvementOpportunity = {
    status: "improvement_opportunity",
    target: "prompt/decomposition/sr_eng_grounding_pass",
    human_name: "Decomposition quality judge",
    summary: "taxonomy-derived opportunity",
    next_action: "draft_proposed_change",
    evidence_refs: { experiment_ids: ["EXP1"] },
  };
  const opportunity = await runScanner({
    root: opportunityRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    promoteCandidateFn: async () => ({
      ok: false,
      outcome: "blocked",
      reason: "improvement_opportunity_no_proposed_change",
      detail: "no mapped materializer",
      terminal: true,
      improvement_opportunity: improvementOpportunity,
    }),
  });
  assert.equal(opportunity.result.candidates[0].status, "improvement_opportunity");
  assert.deepEqual(opportunity.result.candidates[0].improvement_opportunity, improvementOpportunity);
  assert.equal(opportunity.result.health.summary.improvement_opportunity_count, 1);

  const repairRoot = tempRoot();
  const repairFetch = fetchRouter({
    prompts: [{ id: "P1", name: "sr_eng_grounding_pass" }],
    tagsByPrompt: { P1: { id: "PV-missing" } },
    promptVersions: { "PV-missing": { id: "PV-missing", prompt_id: "P1" } },
  });
  const repair = await runScanner({ root: repairRoot, fetchImpl: repairFetch });
  assert.equal(repair.result.candidates[0].status, "needs_reconciliation");
  assert.equal(repair.result.candidates[0].display_class, "evidence_needs_repair");
  assert.equal(repair.result.health.summary.evidence_needs_repair_count, 1);

  const budgetRoot = tempRoot();
  writeReceipt(budgetRoot);
  const budgetTransport = createMockGitHubTransport({
    openPullRequests: [{
      number: 301,
      body: markerBody(),
      head: { ref: "agentic-factory/promotion/prompt-decomposition-sr-eng-grounding-pass/budget" },
      created_at: "2026-06-10T01:00:00.000Z",
    }],
  });
  const budget = await runScanner({
    root: budgetRoot,
    policy: promotionPolicy({ max_open_proposals: 1 }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: budgetTransport,
  });
  assert.equal(budget.result.candidates[0].status, "blocked_by_policy_budget");
  assert.equal(budget.result.candidates[0].reason, "max_open_proposals_reached");

  const repoStateRoot = tempRoot();
  writePolicy(repoStateRoot);
  writeReceipt(repoStateRoot);
  const statePath = path.join(repoStateRoot, ".agentic-factory", "github-connection.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    status: "pending_org_approval",
    repo: { owner: "fixture-owner", name: "fixture-behavior" },
  }));
  const repoStateHarness = createPromotionCandidateScannerTestHarness({
    policyPath: path.join(repoStateRoot, "execution", "evals", "decomposition", "promotion-policy.json"),
    ensureReady: readyUp,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: createMockGitHubTransport(),
    promoteCandidateFn: async () => {
      throw new Error("controller should not be called");
    },
    env: { AGENTIC_FACTORY_PROMOTION_WRITE_GUARD: "fail_closed" },
    now: () => NOW,
  });
  const repoState = await repoStateHarness.scanPromotionCandidates({ repoRoot: repoStateRoot });
  assert.equal(repoState.candidates[0].status, "blocked_by_verified_repo_state");
  assert.equal(repoState.candidates[0].reason, "github_connection_not_verified");
});

test("v1 scanner ledger migrates deterministically and corrupt cache rebuilds without budget authority", async () => {
  const root = tempRoot();
  const ledgerDir = defaultPromotionCandidateLedgerDir(root);
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = promotionScannerLedgerPath(ledgerDir);
  const structuredOpportunity = {
    status: "improvement_opportunity",
    target: "prompt/decomposition/sr_eng_grounding_pass",
    human_name: "Judge prompt",
    next_action: "draft_proposed_change",
  };
  fs.writeFileSync(ledgerPath, JSON.stringify({
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION_V1,
    updated_at: "2026-06-10T00:00:00.000Z",
    last_scan_id: "scan-v1",
    entries: [
      {
        candidate_key: "route",
        status: "controller_called",
        reason: "controller_invoked",
        controller_called: true,
        controller_outcome: "route_to_hitl",
        pr: { title: "Proposal title", url: "mock://pr/route" },
      },
      {
        candidate_key: "opportunity",
        status: "controller_called",
        reason: "controller_invoked",
        controller_called: true,
        controller_outcome: "blocked",
        controller_reason: "improvement_opportunity_no_proposed_change",
        improvement_opportunity: structuredOpportunity,
      },
      {
        candidate_key: "repair",
        status: "needs_reconciliation",
        reason: "stale_evidence",
      },
      {
        candidate_key: "budget",
        status: "suppressed_by_policy",
        reason: "proposal_budget_exhausted",
      },
      {
        candidate_key: "repo-state",
        status: "suppressed_by_policy",
        reason: "promotion_marker_unreadable",
      },
      {
        candidate_key: "policy-disabled",
        status: "suppressed_by_policy",
        reason: "promotion_disabled_by_policy",
      },
    ],
    repo_marker_cache: { active_open_proposals: 99 },
  }, null, 2));

  const migrated = readPromotionScannerLedger({ ledgerDir });
  const migratedFromDisk = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(migrated.schema_version, PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION);
  assert.equal(migratedFromDisk.schema_version, PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION);
  const byKey = Object.fromEntries(migrated.entries.map((entry) => [entry.candidate_key, entry]));
  assert.equal(byKey.route.status, "controller_called_pr_opened");
  assert.equal(byKey.opportunity.status, "improvement_opportunity");
  assert.deepEqual(byKey.opportunity.improvement_opportunity, structuredOpportunity);
  assert.equal(byKey.repair.status, "needs_reconciliation");
  assert.equal(byKey.repair.display_class, "evidence_needs_repair");
  assert.equal(byKey.budget.status, "blocked_by_policy_budget");
  assert.equal(byKey["repo-state"].status, "blocked_by_verified_repo_state");
  assert.equal(byKey["policy-disabled"].status, "suppressed_by_policy");

  const corruptRoot = tempRoot();
  const corruptLedgerDir = defaultPromotionCandidateLedgerDir(corruptRoot);
  fs.mkdirSync(corruptLedgerDir, { recursive: true });
  fs.writeFileSync(promotionScannerLedgerPath(corruptLedgerDir), "{ not json", "utf8");
  const fresh = readPromotionScannerLedger({ ledgerDir: corruptLedgerDir });
  assert.equal(fresh.schema_version, PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION);
  assert.deepEqual(fresh.entries, []);

  const scanRoot = tempRoot();
  writeReceipt(scanRoot);
  const scanLedgerDir = defaultPromotionCandidateLedgerDir(scanRoot);
  fs.mkdirSync(scanLedgerDir, { recursive: true });
  fs.writeFileSync(promotionScannerLedgerPath(scanLedgerDir), "{ not json", "utf8");
  const markerTransport = createMockGitHubTransport({
    openPullRequests: [{
      number: 401,
      body: markerBody(),
      head: { ref: "agentic-factory/promotion/prompt-decomposition-sr-eng-grounding-pass/cache" },
      created_at: "2026-06-10T01:00:00.000Z",
    }],
  });
  const scan = await runScanner({
    root: scanRoot,
    policy: promotionPolicy({ max_open_proposals: 1 }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: markerTransport,
  });
  assert.equal(scan.calls.length, 0);
  assert.equal(scan.result.candidates[0].status, "blocked_by_policy_budget");
  assert.equal(scan.result.repo_marker_state.counts.active_open_proposals, 1);
});

test("formatted scanner output uses exact plain-English headlines and internal detail lines", () => {
  const lines = formatPromotionCandidateScanReport({
    ok: true,
    status: "blocked",
    candidates: [
      {
        candidate_key: "opportunity",
        status: "improvement_opportunity",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "controller_invoked",
        controller_reason: "improvement_opportunity_no_proposed_change",
        improvement_opportunity: { human_name: "Judge prompt" },
      },
      {
        candidate_key: "evidence-only",
        status: "discovered_evidence_without_intent",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "experiment_intent_not_promotion_candidate",
      },
      {
        candidate_key: "repair",
        status: "needs_reconciliation",
        display_class: "evidence_needs_repair",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "stale_evidence",
      },
      {
        candidate_key: "proposal",
        status: "controller_called_pr_opened",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "controller_invoked",
        pr_title: "Proposal: improve judge",
        pr: { title: "Proposal: improve judge", url: "mock://pr/ready" },
      },
      {
        candidate_key: "budget",
        status: "blocked_by_policy_budget",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "max_open_proposals_reached",
      },
      {
        candidate_key: "repo-state",
        status: "blocked_by_verified_repo_state",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "github_transport_unavailable",
      },
    ],
    policy: {
      policy_version: "1.0.0",
      policy_hash: "f".repeat(64),
      read_path: "fixture-policy",
    },
    repo_marker_state: {
      controller_calls_allowed: false,
      reason: "max_open_proposals_reached",
      counts: {
        active_open_proposals: 3,
        max_open_proposals: 3,
        proposal_budget_period_days: 7,
      },
    },
    phoenix_scan: { ok: true },
    ledger_path: "mock://ledger",
    health_path: "mock://health",
  });

  assert.ok(lines.includes("Improvement opportunity found: Judge prompt"));
  assert.ok(lines.includes("Evidence found, but no change was requested."));
  assert.ok(lines.includes("Evidence needs repair before the system can decide what to do."));
  assert.ok(lines.includes("Proposal ready for review: Proposal: improve judge"));
  assert.ok(lines.includes("mock://pr/ready"));
  assert.ok(lines.includes("Proposal limit reached; no new proposals until an open proposal closes (3/3 open)."));
  assert.ok(lines.includes("GitHub connection needs attention before proposals can be checked."));
  assert.ok(lines.includes("  internal: improvement_opportunity_no_proposed_change"));
  assert.ok(lines.includes("  internal: stale_evidence"));
  assert.ok(lines.includes("  internal: github_transport_unavailable"));
  assert.equal(lines.some((line) => line.includes("needs_reconciliation")), false);
});

test("scanner deterministically orders candidates and controller handoffs", async () => {
  const root = tempRoot();
  writeReceipt(root, {
    receiptId: "expr-b",
    experimentId: "EXP2",
    promptVersionId: null,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
    candidateVersionId: "runtime-v2",
    baselineId: EXPECTED_RUNTIME_ROLE_BASELINE_ID,
  });
  writeReceipt(root, { receiptId: "expr-a", experimentId: "EXP1", promptVersionId: "PV1", candidateVersionId: "PV1" });
  const fetchImpl = fetchRouter({
    experiments: {
      EXP1: experimentFixture({ id: "EXP1" }),
      EXP2: experimentFixture({ id: "EXP2" }),
    },
  });
  const first = await runScanner({ root, fetchImpl });
  const second = await runScanner({ root, fetchImpl });
  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, true);
  assert.deepEqual(
    first.result.candidates.map((entry) => [entry.candidate_key, entry.status, entry.request_hash]),
    second.result.candidates.map((entry) => [entry.candidate_key, entry.status, entry.request_hash]),
  );
  assert.deepEqual(first.calls.map((call) => call.request.experiment_id), ["EXP1", "EXP2"]);
  assert.deepEqual(
    first.calls.map((call) => call.invocation.transport),
    ["promotion_candidate_scanner", "promotion_candidate_scanner"],
  );
  assert.deepEqual(second.calls.map((call) => call.request.experiment_id), ["EXP1", "EXP2"]);
  const ledger = JSON.parse(fs.readFileSync(first.result.ledger_path, "utf8"));
  const health = JSON.parse(fs.readFileSync(first.result.health_path, "utf8"));
  assert.equal(ledger.schema_version, PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION);
  assert.equal(health.schema_version, PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION);
  assert.equal(ledger._note.includes("cache/status only"), true);
});

test("runtime-default candidate catalog does not depend on a judge prompt target", async () => {
  const root = tempRoot();
  writeRuntimeOnlyPhoenixAssets(root);
  writeReceipt(root, {
    receiptId: "expr-runtime-only",
    experimentId: "EXP-RUNTIME",
    promptVersionId: null,
    candidateTargetKey: RUNTIME_ROLE_TARGET_KEY,
    candidateVersionId: "runtime-v2",
    baselineId: EXPECTED_RUNTIME_ROLE_BASELINE_ID,
  });
  const result = await runScanner({
    root,
    fetchImpl: fetchRouter({
      experiments: { "EXP-RUNTIME": experimentFixture({ id: "EXP-RUNTIME" }) },
    }),
  });

  assert.equal(result.result.ok, true);
  assert.deepEqual(result.calls.map((call) => call.request.experiment_id), ["EXP-RUNTIME"]);
  assert.equal(result.result.candidates[0].status, "controller_called_pr_opened");
  assert.equal(result.result.candidates[0].candidate_target_key, RUNTIME_ROLE_TARGET_KEY);
});

test("unattended scanner reads accepted pins and repo candidate artifacts from the internal clone", async () => {
  const root = tempRoot();
  const { acceptedBaselineId } = writePhoenixAssets(root);
  writePolicy(root, promotionPolicy({
    scanner_routing: {
      repo_candidate_artifact_stubs: [{
        directory: "execution/evals/decomposition/candidate-artifacts",
        file_extension: ".candidate.json",
      }],
    },
  }));
  initGitRepo(root);
  writeVerifiedGitHubState(root);
  writeReceipt(root, { baselineId: acceptedBaselineId });

  // Dirty active-checkout edits: if unattended scanner reads repo-owned
  // authorities from repoRoot, this manifest would make the receipt look stale
  // and this uncommitted artifact would appear in the scan. Both must be
  // ignored in favor of the internal clone's default-branch HEAD.
  writePhoenixAssets(root, { acceptedPromptVersionId: "PV-DIRTY-ACTIVE-CHECKOUT" });
  const dirtyArtifactDir = path.join(root, "execution", "evals", "decomposition", "candidate-artifacts");
  fs.mkdirSync(dirtyArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(dirtyArtifactDir, "dirty.candidate.json"), JSON.stringify({
    schema_version: REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION,
    intent: "promotion_candidate",
    candidate_target_key: "rule/decomposition/runtime_role_assignments",
    candidate_version_id: "dirty-runtime",
    experiment_id: "EXP-DIRTY",
    dataset_version_id: "DSV-DIRTY",
  }, null, 2));

  const calls = [];
  const harness = createPromotionCandidateScannerTestHarness({
    policyReadMode: "unattended",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: createMockGitHubTransport(),
    promoteCandidateFn: async (options) => {
      calls.push(options);
      return {
        ok: true,
        outcome: "route_to_hitl",
        proposal_instance_id: "prop-clone",
        pr: { number: 501, url: "mock://pr/clone", dry_run: true },
      };
    },
    env: { AGENTIC_FACTORY_PROMOTION_WRITE_GUARD: "fail_closed" },
    now: () => NOW,
  });
  const result = await harness.scanPromotionCandidates({ repoRoot: root });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(result.policy.read_path, "unattended_internal_clone_default_branch_head");
  assert.equal(result.candidates[0].status, "controller_called_pr_opened");
  assert.equal(result.candidates[0].reason, "controller_invoked");
  assert.equal(result.candidates.some((entry) => entry.source === "repo_candidate_artifact_stub"), false);
});

test("pre-activation unattended scanner records report-only candidates and never calls the controller", async () => {
  const root = tempRoot();
  const { acceptedBaselineId } = writePhoenixAssets(root);
  writePolicy(root);
  initGitRepo(root);
  writeVerifiedGitHubState(root);
  writeReceipt(root, { baselineId: acceptedBaselineId });
  const calls = [];
  const harness = createPromotionCandidateScannerTestHarness({
    policyReadMode: "unattended",
    ensureReady: readyUp,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: createMockGitHubTransport(),
    promoteCandidateFn: async (options) => {
      calls.push(options);
      throw new Error("controller must not be called before guard activation");
    },
    env: {},
    now: () => NOW,
  });

  const result = await harness.scanPromotionCandidates({ repoRoot: root });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, "promotion_write_report_only");
  assert.equal(
    result.candidates[0].reason,
    "promotion_write_guard_pre_activation_unattended_report_only",
  );
  assert.equal(result.candidates[0].controller_called, false);
  assert.equal(result.candidates[0].write_guard.mode, "report_only");
  assert.equal(result.health.summary.controller_call_count, 0);
  assert.equal(result.health.summary.status_counts.promotion_write_report_only, 1);
  assert.match(result.candidates[0].detail, /Proposal writing is waiting/);
});

test("scanner resolves accepted baseline identity per prompt target and never uses legacy judge entry for phase prompts", async () => {
  const phaseTargetKey = "prompt/decomposition/pm_product_sufficiency_pass";

  const readyRoot = tempRoot();
  const phase = phasePromptFixture(readyRoot, { targetKey: phaseTargetKey });
  writePhoenixAssets(readyRoot, { extraPrompts: [phase.entry] });
  writeReceipt(readyRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: phase.acceptedBaselineId,
    promptVersionId: "PV-PM",
    candidateVersionId: "PV-PM",
  });
  const ready = await runScanner({
    root: readyRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(ready.calls.length, 1);
  assert.equal(ready.result.candidates[0].candidate_target_key, phaseTargetKey);
  assert.equal(ready.result.candidates[0].status, "controller_called_pr_opened");

  const staleRoot = tempRoot();
  const stalePhase = phasePromptFixture(staleRoot, { targetKey: phaseTargetKey });
  writePhoenixAssets(staleRoot, { extraPrompts: [stalePhase.entry] });
  writeReceipt(staleRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: EXPECTED_BASELINE_ID,
    promptVersionId: "PV-PM",
    candidateVersionId: "PV-PM",
  });
  const stale = await runScanner({
    root: staleRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(stale.calls.length, 0);
  assert.equal(stale.result.candidates[0].status, "needs_reconciliation");
  assert.equal(stale.result.candidates[0].reason, "stale_baseline_identity");
  assert.match(stale.result.candidates[0].detail, /current repo baseline sha256:/);

  const missingTargetRoot = tempRoot();
  writePhoenixAssets(missingTargetRoot);
  writeReceipt(missingTargetRoot, {
    candidateTargetKey: phaseTargetKey,
    baselineId: EXPECTED_BASELINE_ID,
    promptVersionId: "PV-PM",
    candidateVersionId: "PV-PM",
  });
  const missingTarget = await runScanner({
    root: missingTargetRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(missingTarget.calls.length, 0);
  assert.equal(missingTarget.result.candidates[0].status, "ignored_unmanaged_target");
  assert.equal(missingTarget.result.candidates[0].reason, "candidate_target_not_manifest_agent_behavior");
});

test("scanner ignores a judge candidate even though the judge is in the manifest", async () => {
  // The judge is KEPT in the manifest (re-scoped) so it still runs as an
  // evaluator, but the agent-behavior catalog excludes it via the single source.
  // A judge promotion candidate is therefore never handed to the controller.
  const judgeRoot = tempRoot();
  const judgeSnapshotText = "accepted judge scanner prompt\n";
  writePhoenixAssets(judgeRoot, {
    extraPrompts: [{
      role: "decomposition_quality_judge",
      target_key: "prompt/decomposition/decomposition_quality_judge",
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      prompt_name: "decomposition_quality_judge",
      prompt_id: "P-JUDGE",
      accepted_prompt_version_id: null,
      accepted_tag: "agentic_factory_accepted",
      snapshot_path: "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md",
      snapshot_sha256: createHash("sha256").update(judgeSnapshotText).digest("hex"),
    }],
  });
  writeReceipt(judgeRoot, {
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
    baselineId: `sha256:${createHash("sha256").update(judgeSnapshotText).digest("hex")}`,
  });
  const judge = await runScanner({
    root: judgeRoot,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(judge.calls.length, 0);
  assert.equal(judge.result.candidates[0].status, "ignored_unmanaged_target");
  assert.equal(judge.result.candidates[0].reason, "candidate_target_not_manifest_agent_behavior");
});

test("scanner treats Phoenix generated experiment projects as run storage metadata", async () => {
  assert.equal(String(PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN), String(/^Experiment-[0-9a-f]{24}$/i));

  const generatedRoot = tempRoot();
  writeReceipt(generatedRoot);
  const generated = await runScanner({
    root: generatedRoot,
    fetchImpl: fetchRouter({
      experiments: {
        EXP1: experimentFixture({ projectName: "Experiment-0123456789abcdef01234567" }),
      },
    }),
  });
  assert.equal(generated.calls.length, 1);
  assert.equal(generated.result.candidates[0].status, "controller_called_pr_opened");

  const foreignRoot = tempRoot();
  writeReceipt(foreignRoot);
  const foreign = await runScanner({
    root: foreignRoot,
    fetchImpl: fetchRouter({
      experiments: {
        EXP1: experimentFixture({ projectName: "foreign-project" }),
      },
    }),
  });
  assert.equal(foreign.calls.length, 0);
  assert.equal(foreign.result.candidates[0].status, "needs_reconciliation");
  assert.equal(foreign.result.candidates[0].reason, "phoenix_project_not_eligible");
  assert.equal(foreign.result.candidates[0].detail, "foreign-project");
});

test("scanner records discovered_evidence_without_intent and never calls the controller for exploratory receipts", async () => {
  const root = tempRoot();
  writeReceipt(root, { intent: "exploratory" });
  const { result, calls } = await runScanner({
    root,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(calls.length, 0);
  assert.equal(result.candidates[0].status, "discovered_evidence_without_intent");
  assert.equal(result.candidates[0].reason, "experiment_intent_not_promotion_candidate");
});

test("prompt tags without a receipt degrade to needs_reconciliation, never Phoenix-native auto-proposal", async () => {
  const root = tempRoot();
  const fetchImpl = fetchRouter({
    prompts: [{ id: "P1", name: "sr_eng_grounding_pass" }],
    tagsByPrompt: { P1: { id: "PV-missing" } },
    promptVersions: { "PV-missing": { id: "PV-missing", prompt_id: "P1" } },
  });
  const { result, calls } = await runScanner({ root, fetchImpl });
  assert.equal(calls.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, "needs_reconciliation");
  assert.equal(result.candidates[0].reason, "lost_receipt_phoenix_native_ambiguity");
});

test("scanner routes manifest-declared phase prompt candidate tags to their target keys", async () => {
  const targetCases = [
    {
      promptRole: "pm",
      promptName: "pm_product_sufficiency_pass",
      targetKey: "prompt/decomposition/pm_product_sufficiency_pass",
    },
    {
      promptRole: "sr_eng",
      promptName: "sr_eng_grounding_pass",
      targetKey: "prompt/decomposition/sr_eng_grounding_pass",
    },
    {
      promptRole: "pm",
      promptName: "pm_synthesis",
      targetKey: "prompt/decomposition/pm_synthesis",
    },
  ];

  for (const targetCase of targetCases) {
    const root = tempRoot();
    const phase = phasePromptFixture(root, {
      targetKey: targetCase.targetKey,
      role: targetCase.promptRole,
      promptName: targetCase.promptName,
    });
    writePhoenixAssets(root, { extraPrompts: [phase.entry] });
    const promptId = `P-${targetCase.promptName}`;
    const promptVersionId = `PV-${targetCase.promptName}`;
    const fetchImpl = fetchRouter({
      prompts: [{ id: promptId, name: targetCase.promptName }],
      tagsByPrompt: { [promptId]: { id: promptVersionId } },
      promptVersions: { [promptVersionId]: { id: promptVersionId, prompt_id: promptId } },
    });
    const { result, calls } = await runScanner({ root, fetchImpl });

    assert.equal(calls.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].source, "phoenix_prompt_candidate_tag");
    assert.equal(result.candidates[0].candidate_target_key, targetCase.targetKey);
    assert.equal(result.candidates[0].candidate_version_id, promptVersionId);
    assert.equal(result.candidates[0].status, "needs_reconciliation");
    assert.equal(result.candidates[0].reason, "lost_receipt_phoenix_native_ambiguity");
  }
});

test("scanner treats drafted_by managed receipts as ordinary promotion-intent candidates", async () => {
  const root = tempRoot();
  const receipt = writeReceipt(root, {
    receiptId: "expr-drafted",
    experimentId: "EXP1",
    promptVersionId: "PV-DRAFT",
    candidateVersionId: "PV-DRAFT",
    draftedBy: "agentic_factory_drafter_v1:test-model",
  });
  const { result, calls } = await runScanner({
    root,
    fetchImpl: fetchRouter({
      prompts: [{ id: "P1", name: "sr_eng_grounding_pass" }],
      tagsByPrompt: { P1: { id: "PV-DRAFT" } },
      promptVersions: { "PV-DRAFT": { id: "PV-DRAFT", prompt_id: "P1" } },
      experiments: { EXP1: experimentFixture() },
    }),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, "controller_called_pr_opened");
  assert.equal(result.candidates[0].reason, "controller_invoked");
  assert.equal(receipt.launch.drafted_by, "agentic_factory_drafter_v1:test-model");
  assert.equal(calls[0].request.source, "promotion_candidate_scanner");
  assert.equal(calls[0].request.experiment_id, "EXP1");
  assert.equal(calls[0].request.prompt_version_id, "PV-DRAFT");
  assert.equal("drafted_by" in calls[0].request, false);
});

test("withdrawn receipt plus still-visible Phoenix prompt tag needs reconciliation", async () => {
  const root = tempRoot();
  writeReceipt(root, {
    amendments: [{ action: "withdraw", reason: "operator withdrew", amended_at: "2026-06-10T02:00:00.000Z" }],
  });
  const fetchImpl = fetchRouter({
    prompts: [{ id: "P1", name: "sr_eng_grounding_pass" }],
    tagsByPrompt: { P1: { id: "PV1" } },
    promptVersions: { PV1: { id: "PV1", prompt_id: "P1" } },
    experiments: { EXP1: experimentFixture() },
  });
  const { result, calls } = await runScanner({ root, fetchImpl });
  assert.equal(calls.length, 0);
  assert.equal(result.candidates[0].status, "needs_reconciliation");
  assert.equal(result.candidates[0].reason, "withdrawn_receipt_still_tagged");
});

test("missing, ambiguous, stale, and mismatched joins are needs_reconciliation", async () => {
  const root = tempRoot();
  writeReceipt(root, { receiptId: "missing", experimentId: null, promptVersionId: "PV-missing", candidateVersionId: "PV-missing" });
  writeReceipt(root, { receiptId: "ambig-a", experimentId: "EXP-A", promptVersionId: "PV-ambig-a", candidateVersionId: "PV-ambig-a" });
  writeReceipt(root, { receiptId: "ambig-b", experimentId: "EXP-A", promptVersionId: "PV-ambig-b", candidateVersionId: "PV-ambig-b" });
  writeReceipt(root, { receiptId: "stale", experimentId: "EXP-stale", launchedAt: "2026-05-01T00:00:00.000Z", promptVersionId: "PV-stale", candidateVersionId: "PV-stale" });
  writeReceipt(root, { receiptId: "mismatch", experimentId: "EXP-mismatch", promptVersionId: "PV-mismatch", candidateVersionId: "PV-mismatch" });
  const fetchImpl = fetchRouter({
    experiments: {
      "EXP-A": experimentFixture({ id: "EXP-A" }),
      "EXP-stale": experimentFixture({ id: "EXP-stale" }),
      "EXP-mismatch": experimentFixture({ id: "EXP-mismatch", datasetId: "DS2" }),
    },
  });
  const { result, calls } = await runScanner({ root, fetchImpl });
  assert.equal(calls.length, 0);
  const byReceipt = Object.fromEntries(result.candidates.map((entry) => [entry.receipt_id, entry]));
  assert.equal(byReceipt.missing.reason, "missing_experiment_join");
  assert.equal(byReceipt["ambig-a"].reason, "ambiguous_receipt_join");
  assert.equal(byReceipt["ambig-b"].reason, "ambiguous_receipt_join");
  assert.equal(byReceipt.stale.reason, "stale_evidence");
  assert.equal(byReceipt.mismatch.reason, "experiment_receipt_mismatch");
});

test("scanner ignores receipt targets outside the manifest-declared agent behavior catalog", async () => {
  const root = tempRoot();
  writeReceipt(root, {
    receiptId: "runtime-role",
    experimentId: "EXP-runtime",
    promptVersionId: null,
    candidateTargetKey: "rule/decomposition/not_in_manifest",
    candidateVersionId: "runtime-v2",
  });
  const { result, calls } = await runScanner({
    root,
    fetchImpl: fetchRouter({ experiments: { "EXP-runtime": experimentFixture({ id: "EXP-runtime" }) } }),
  });
  assert.equal(calls.length, 0);
  assert.equal(result.candidates[0].status, "ignored_unmanaged_target");
  assert.equal(result.candidates[0].reason, "candidate_target_not_manifest_agent_behavior");
});

test("scanner reports catalog unavailable distinctly from unmanaged targets", async () => {
  const root = tempRoot();
  const manifestPath = path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, "{ invalid manifest json", "utf8");
  writeReceipt(root, {
    receiptId: "catalog-unavailable",
    experimentId: "EXP-catalog",
  });
  const { result, calls } = await runScanner({
    root,
    fetchImpl: fetchRouter({ experiments: { "EXP-catalog": experimentFixture({ id: "EXP-catalog" }) } }),
  });

  assert.equal(calls.length, 0);
  assert.equal(result.candidates[0].status, "needs_reconciliation");
  assert.equal(result.candidates[0].reason, "agent_behavior_target_catalog_unavailable");
  assert.match(result.candidates[0].detail, /JSON|Expected|Unexpected/i);
});

test("scanner lock enforces a single local writer", async () => {
  const root = tempRoot();
  writePolicy(root);
  writeVerifiedGitHubState(root);
  const ledgerDir = defaultPromotionCandidateLedgerDir(root);
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(promotionScannerLockPath(ledgerDir), JSON.stringify({
    schema_version: "agentic-factory-promotion-scanner-lock/v1",
    pid: 12345,
    acquired_at: NOW.toISOString(),
  }));
  const harness = createPromotionCandidateScannerTestHarness({
    policyPath: path.join(root, "execution", "evals", "decomposition", "promotion-policy.json"),
    now: () => NOW,
    fetchImpl: fetchRouter(),
    promoteCandidateFn: async () => {
      throw new Error("controller should not be called");
    },
  });
  const result = await harness.scanPromotionCandidates({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "scanner_lock_held");
});

test("policy disable, max-open cap, and period budget suppress controller calls from repo-visible markers", async () => {
  const disabledRoot = tempRoot();
  writeReceipt(disabledRoot);
  const disabled = await runScanner({
    root: disabledRoot,
    policy: promotionPolicy({ disabled: true }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
  });
  assert.equal(disabled.calls.length, 0);
  assert.equal(disabled.result.candidates[0].status, "suppressed_by_policy");
  assert.equal(disabled.result.candidates[0].reason, "promotion_disabled_by_policy");

  const maxOpenRoot = tempRoot();
  writeReceipt(maxOpenRoot);
  const maxOpenTransport = createMockGitHubTransport({
    openPullRequests: [{
      number: 10,
      body: markerBody(),
      head: { ref: "agentic-factory/promotion/prompt-decomposition-sr-eng-grounding-pass/aaaa" },
      created_at: "2026-06-10T01:00:00.000Z",
    }],
  });
  const maxOpen = await runScanner({
    root: maxOpenRoot,
    policy: promotionPolicy({ max_open_proposals: 1 }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: maxOpenTransport,
  });
  assert.equal(maxOpen.calls.length, 0);
  assert.equal(maxOpen.result.repo_marker_state.reason, "max_open_proposals_reached");
  assert.ok(maxOpenTransport.calls.some((call) => call.endpointId === "list_open_pull_requests"));

  const nonNamespaceRoot = tempRoot();
  writeReceipt(nonNamespaceRoot);
  const nonNamespaceTransport = createMockGitHubTransport({
    openPullRequests: [{
      number: 12,
      body: markerBody(),
      head: { ref: "feature/copied-promotion-marker" },
      created_at: "2026-06-10T01:00:00.000Z",
    }],
  });
  const nonNamespace = await runScanner({
    root: nonNamespaceRoot,
    policy: promotionPolicy({ max_open_proposals: 1 }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: nonNamespaceTransport,
  });
  assert.equal(nonNamespace.calls.length, 1);
  assert.equal(nonNamespace.result.repo_marker_state.controller_calls_allowed, true);
  assert.equal(nonNamespace.result.repo_marker_state.counts.active_open_proposals, 0);

  const budgetRoot = tempRoot();
  writeReceipt(budgetRoot);
  const budgetTransport = createMockGitHubTransport({
    closedPullRequests: [{
      number: 11,
      body: markerBody({ proposalInstanceId: "prop-recent", envelopeHash: "c".repeat(64) }),
      head: { ref: "agentic-factory/promotion/prompt-decomposition-sr-eng-grounding-pass/bbbb" },
      created_at: "2026-06-10T02:00:00.000Z",
      closed_at: "2026-06-10T02:30:00.000Z",
      merged_at: null,
    }],
  });
  const budget = await runScanner({
    root: budgetRoot,
    policy: promotionPolicy({ proposal_budget: { max_proposals: 1, period_days: 7 } }),
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: budgetTransport,
  });
  assert.equal(budget.calls.length, 0);
  assert.equal(budget.result.repo_marker_state.reason, "proposal_budget_exhausted");
});

test("scanner uses only verified resolveBehaviorRepoIdentity state for repo marker truth", async () => {
  const root = tempRoot();
  writePolicy(root);
  writeReceipt(root);
  const statePath = path.join(root, ".agentic-factory", "github-connection.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    status: "pending_org_approval",
    repo: { owner: "unsafe", name: "partial" },
  }));
  const transport = createMockGitHubTransport();
  const harness = createPromotionCandidateScannerTestHarness({
    policyPath: path.join(root, "execution", "evals", "decomposition", "promotion-policy.json"),
    ensureReady: readyUp,
    fetchImpl: fetchRouter({ experiments: { EXP1: experimentFixture() } }),
    githubTransport: transport,
    promoteCandidateFn: async () => {
      throw new Error("controller should not be called");
    },
    env: {},
    now: () => NOW,
  });
  const result = await harness.scanPromotionCandidates({ repoRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.repo_marker_state.reason, "github_connection_not_verified");
  assert.equal(transport.calls.length, 0, "no GitHub PR marker read may happen without verified identity");
  assert.equal(result.candidates[0].status, "blocked_by_verified_repo_state");
});

test("repo-owned candidate artifact stubs are scanned only when policy describes the path", async () => {
  const root = tempRoot();
  const artifactDir = path.join(root, "execution", "evals", "decomposition", "candidate-artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "runtime.candidate.json"), JSON.stringify({
    schema_version: REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION,
    intent: "promotion_candidate",
    candidate_target_key: "rule/decomposition/runtime_role_assignments",
    candidate_version_id: "runtime-v2",
    experiment_id: "EXP1",
    dataset_version_id: "DSV1",
  }));
  const notDescribed = await runScanner({
    root,
    fetchImpl: fetchRouter(),
  });
  assert.equal(notDescribed.result.candidates.length, 0);

  const described = await runScanner({
    root,
    policy: promotionPolicy({
      scanner_routing: {
        repo_candidate_artifact_stubs: [{
          directory: "execution/evals/decomposition/candidate-artifacts",
          file_extension: ".candidate.json",
        }],
      },
    }),
    fetchImpl: fetchRouter(),
  });
  assert.equal(described.result.candidates.length, 1);
  assert.equal(described.result.candidates[0].source, "repo_candidate_artifact_stub");
  assert.equal(described.result.candidates[0].reason, "repo_candidate_artifact_requires_managed_receipt_in_mvp");
});

test("Phoenix scan failures degrade deterministically with injected ensureReady/fetch", async () => {
  const root = tempRoot();
  writeReceipt(root);
  const { result, calls } = await runScanner({
    root,
    ensureReady: () => ({ ok: false, reason: "phoenix_not_running" }),
    fetchImpl: fetchRouter(),
  });
  assert.equal(calls.length, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.phoenix_scan.reason, "local_phoenix_unavailable");
  assert.equal(result.candidates[0].reason, "phoenix_scan_unavailable");
});

test("scanner production boundary uses promoteCandidate production API, not controller test harness", async () => {
  const scannerSource = fs.readFileSync(
    path.join(repoCheckout, "execution", "integrations", "linear", "src", "promotion-candidate-scanner.mjs"),
    "utf8",
  );
  // Post-split, the production CLI surface is cli.mjs plus src/cli/*; the
  // harness ban applies to the WHOLE surface.
  const cliDir = path.join(repoCheckout, "execution", "integrations", "linear", "src", "cli");
  const cliSurface = [
    path.join(repoCheckout, "execution", "integrations", "linear", "cli.mjs"),
    ...fs.readdirSync(cliDir).sort().map((name) => path.join(cliDir, name)),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.match(scannerSource, /promoteCandidate/);
  assert.doesNotMatch(scannerSource, /createPromoteCandidateTestHarness/);
  assert.match(cliSurface, /scanPromotionCandidates/);
  assert.doesNotMatch(cliSurface, /createPromotionCandidateScannerTestHarness/);
  for (const key of ["githubTransport", "promoteCandidateFn", "policyPath", "fetchImpl", "env"]) {
    assert.ok(UNTRUSTED_SCANNER_OVERRIDE_KEYS.includes(key), `${key} must be production-rejected`);
  }
  for (const key of UNTRUSTED_SCANNER_OVERRIDE_KEYS) {
    await assert.rejects(
      scanPromotionCandidates({ repoRoot: tempRoot(), [key]: {} }),
      new RegExp(`untrusted_scanner_override_rejected:${key}`),
    );
  }
});
