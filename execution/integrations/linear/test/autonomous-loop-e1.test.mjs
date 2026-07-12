import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAutonomousDiagnosisRecord,
  createAutonomousDiagnosisCallerTestHarness,
  readAutonomousDiagnosisRecord,
  writeAutonomousDiagnosisRecord,
} from "../src/autonomous-diagnosis.mjs";
import {
  computeAutonomousLoopSignals,
} from "../src/promotion/autonomous-loop-state.mjs";
import {
  PROMOTION_POLICY_SCHEMA_VERSION,
  parsePromotionPolicy,
  promotionPolicyValidationFailures,
} from "../src/promotion-policy.mjs";

const NOW = new Date("2026-06-12T10:00:00.000Z");
const DECOMP_NAMESPACE = "execution/evals/decomposition";
const TARGET_KEY = "prompt/decomposition/sr_eng_grounding_pass";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-e1-"));
  process.env.TEAMI_HOME = root;
  return root;
}

function scannerRouting(overrides = {}) {
  const base = {
    enabled: true,
    freshness_window_days: 14,
    eligible_phoenix: {
      project_names: ["teami"],
      dataset_names: ["teami-decomposition-examples"],
      split_names: ["train", "test"],
    },
    explicit_intent_signals: {
      managed_experiment_receipt_intent: "promotion_candidate",
      prompt_version_candidate_tag: "teami_promotion_candidate",
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

function policy(overrides = {}) {
  return {
    schema_version: PROMOTION_POLICY_SCHEMA_VERSION,
    policy_version: "test",
    disabled: false,
    lookback_days: 30,
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
    ...overrides,
    proposal_budget: { max_proposals: 5, period_days: 7, ...(overrides.proposal_budget || {}) },
    scanner_routing: scannerRouting(overrides.scanner_routing || {}),
    risk_defaults: {
      prior_test_split_exposure_defaults_high_risk: true,
      ...(overrides.risk_defaults || {}),
    },
  };
}

function diagnosisRecord(overrides = {}) {
  return buildAutonomousDiagnosisRecord({
    workflowType: "decomposition",
    evalNamespace: DECOMP_NAMESPACE,
    policy: {
      version: "test",
      hash: "a".repeat(64),
      read_path: "unattended_internal_clone_default_branch_head",
    },
    evidenceQuery: {
      provider: "phoenix",
      project: "teami",
      datasets: ["teami-decomposition-examples"],
      splits: ["test"],
      filters: { label: "needs_revision" },
    },
    evidenceWindow: {
      started_at: "2026-06-11T10:00:00.000Z",
      ended_at: "2026-06-12T10:00:00.000Z",
      freshness_window_days: 7,
    },
    targetSelection: {
      target_key: TARGET_KEY,
      selection_source: "eval_namespace_manifest",
      manifest_path: "execution/evals/decomposition/phoenix-assets.json",
      selection_rule: "most_common_failure_mode",
    },
    improvementOpportunity: {
      status: "improvement_opportunity",
      target: TARGET_KEY,
      human_name: "Sr-eng grounding prompt",
      summary: "Synthetic diagnosis found a focused failure.",
      failure_mode_ids: ["missing_acceptance_criteria"],
      next_action: "draft_proposed_change",
      suggested_draft_prompt: "Clarify acceptance criteria before decomposing.",
      evidence_refs: { experiment_ids: ["EXP-E1"] },
    },
    ...overrides,
  });
}

test("promotion policy has no maturity ladder or objective auto-disable block", () => {
  const executionPolicyPath = path.join(process.cwd(), "execution", "evals", "execution", "promotion-policy.json");
  const reviewPolicyPath = path.join(process.cwd(), "execution", "evals", "review", "promotion-policy.json");
  const executionPolicy = parsePromotionPolicy(fs.readFileSync(executionPolicyPath), {
    sourceLabel: "execution promotion policy",
  }).policy;
  const reviewPolicy = parsePromotionPolicy(fs.readFileSync(reviewPolicyPath), {
    sourceLabel: "review promotion policy",
  }).policy;
  const maturityKey = "autonomy" + "_maturity";
  const autoDisableKey = "objective" + "_auto_disable";

  assert.equal(executionPolicy[maturityKey], undefined);
  assert.equal(executionPolicy[autoDisableKey], undefined);
  assert.equal(reviewPolicy[maturityKey], undefined);
  assert.equal(reviewPolicy[autoDisableKey], undefined);
  assert.deepEqual(promotionPolicyValidationFailures({
    ...executionPolicy,
    [maturityKey]: "reckless",
    [autoDisableKey]: { enabled: "invalid" },
  }), []);
});

test("autonomous loop signals are measurement only", () => {
  const signals = computeAutonomousLoopSignals({
    registryRecords: [
      { schema_version: "teami-promotion-candidate-registry/v1", candidate_target_key: TARGET_KEY },
      { schema_version: "teami-promotion-candidate-registry/v1", candidate_target_key: TARGET_KEY },
    ],
    gateReports: [{
      failed_condition_ids: ["improves_target_scores"],
      evidence_counts: { test_human_labeled_examples: 1 },
      disagreements: [{ kind: "human_llm_label_conflict" }],
    }],
    repoMarkerState: {
      counts: {
        active_open_proposals: 0,
        readable_closed_markers: 1,
        closed_unmerged_proposals: 1,
      },
    },
  });
  assert.equal(signals.global_open_auto_prs, 0);
  assert.equal(signals.counts.duplicate_proposals, 1);
  assert.equal(signals.decline_rate, 1);
  assert.equal(signals.duplicate_proposal_rate, 0.5);
  assert.equal(signals.no_experiment_lift, 1);
  assert.equal(signals.gold_label_disagreement_rate, 1);
});

test("tagged autonomous draft scans and opens a PR", async () => {
  const repoRoot = tempRoot();
  const record = diagnosisRecord();
  writeAutonomousDiagnosisRecord({ repoRoot, record });
  const calls = { scanner: 0 };
  const harness = createAutonomousDiagnosisCallerTestHarness({
    runAutonomousImprovementDrafterImpl: async () => ({
      ok: true,
      chain_state: "tagged",
    }),
    scanPromotionCandidatesFn: async () => {
      calls.scanner += 1;
      return {
        ok: true,
        status: "ok",
        candidates: [{
          status: "controller_called_pr_opened",
          proposal_instance_id: "prop-e1-opened",
          normalized_envelope_hash: "d".repeat(64),
          pr: { number: 42, url: "mock://github/pull/42", dry_run: true },
        }],
      };
    },
    now: () => NOW,
  });
  const result = await harness.runAutonomousDiagnosisCaller({
    repoRoot,
    opportunityHash: record.opportunity_hash,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "opened_pr");
  assert.equal(result.pr.number, 42);
  assert.equal(calls.scanner, 1);
});

test("diagnosis pass emits a SEAM-3 record from grades while tolerating empty outcomes", async () => {
  const repoRoot = tempRoot();
  const gateReport = {
    schema_version: "teami-process-change-gate-report/v1",
    gate_report_id: "gate-e1",
    generated_at: "2026-06-12T09:00:00.000Z",
    candidate_target_key: TARGET_KEY,
    failed_condition_ids: ["improves_target_scores"],
  };
  const harness = createAutonomousDiagnosisCallerTestHarness({
    resolveTrustedPolicyReadImpl: () => ({
      ok: true,
      read_path: "user_invoked_active_checkout",
      policy_hash: "b".repeat(64),
      policy: policy({ lookback_days: 14 }),
    }),
    collectAutonomousLoopSignalSurfacesImpl: () => ({
      registry_records: [],
      gate_reports: [gateReport],
      repo_marker_state: null,
    }),
    now: () => NOW,
  });

  const result = await harness.runAutonomousDiagnosisPass({
    repoRoot,
    workflowTypes: ["decomposition"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.diagnosed_count, 1);
  const created = result.results[0];
  const stored = readAutonomousDiagnosisRecord({
    repoRoot,
    opportunityHash: created.opportunity_hash,
  });
  assert.equal(stored.ok, true);
  assert.deepEqual(stored.record.evidence_query.filters.outcome_observations, []);
  assert.equal(stored.record.improvement_opportunity.target, TARGET_KEY);
});
