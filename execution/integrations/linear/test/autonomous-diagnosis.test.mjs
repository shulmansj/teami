import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAutonomousDiagnosisRecord,
  createAutonomousDiagnosisCallerTestHarness,
  readAutonomousDiagnosisRecord,
  runAutonomousDiagnosisCaller,
  runAutonomousDiagnosisScan,
  UNTRUSTED_AUTONOMOUS_DIAGNOSIS_OVERRIDE_KEYS,
  writeAutonomousDiagnosisRecord,
} from "../src/autonomous-diagnosis.mjs";
import { createAutonomousImprovementDrafterTestHarness } from "../src/improvement-drafter.mjs";

const NOW = new Date("2026-06-12T10:00:00.000Z");

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-autonomous-diagnosis-"));
  fs.mkdirSync(path.join(root, ".teami"), { recursive: true });
  return root;
}

function diagnosisRecord(overrides = {}) {
  return buildAutonomousDiagnosisRecord({
    workflowType: "decomposition",
    evalNamespace: "execution/evals/decomposition",
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
      target_key: "prompt/decomposition/sr_eng_grounding_pass",
      selection_source: "eval_namespace_manifest",
      manifest_path: "execution/evals/decomposition/phoenix-assets.json",
      selection_rule: "most_common_failure_mode",
    },
    scannerTrigger: {
      after_chain_state: "tagged",
      command: "promotion:scan",
    },
    improvementOpportunity: {
      status: "improvement_opportunity",
      target: "prompt/decomposition/sr_eng_grounding_pass",
      human_name: "Sr-eng grounding prompt",
      summary: "Synthetic diagnosis found a focused failure.",
      failure_mode_ids: ["missing_acceptance_criteria"],
      next_action: "draft_proposed_change",
      suggested_draft_prompt: "Clarify acceptance criteria before decomposing.",
      evidence_refs: { experiment_ids: ["EXP-AUTO"] },
    },
    ...overrides,
  });
}

test("autonomous diagnosis caller drafts, scans, and returns an opened PR without a human draft step", async () => {
  const repoRoot = tempRoot();
  const record = diagnosisRecord();
  writeAutonomousDiagnosisRecord({ repoRoot, record });

  const calls = { drafter: [], scanner: [] };
  const harness = createAutonomousDiagnosisCallerTestHarness({
    runAutonomousImprovementDrafterImpl: async (options) => {
      calls.drafter.push(options);
      return {
        ok: true,
        chain_state: "tagged",
        receipt_path: path.join(repoRoot, ".teami", "drafts", "draft-test.json"),
        phoenix_experiment_id: "EXP-DRAFT",
      };
    },
    scanPromotionCandidatesFn: async (options) => {
      calls.scanner.push(options);
      return {
        ok: true,
        status: "ok",
        candidates: [{
          status: "controller_called_pr_opened",
          opportunity_hash: record.opportunity_hash,
          normalized_envelope_hash: "b".repeat(64),
          proposal_instance_id: "prop-opened",
          pr: {
            number: 17,
            url: "mock://github/pull/17",
            title: "Proposal: improve sr-eng grounding",
            dry_run: true,
          },
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
  assert.equal(result.outcome, "route_to_hitl");
  assert.equal(result.pr.number, 17);
  assert.equal(calls.drafter.length, 1);
  assert.equal(calls.drafter[0].opportunityHash, record.opportunity_hash);
  assert.equal(calls.scanner.length, 1);
  assert.equal(calls.scanner[0].repoRoot, repoRoot);
  assert.equal(result.pr.merged, undefined);

  const stored = readAutonomousDiagnosisRecord({
    repoRoot,
    opportunityHash: record.opportunity_hash,
  });
  assert.equal(stored.ok, true);
  const actions = stored.record.events.map((event) => event.action);
  assert.deepEqual(actions, [
    "autonomous_chain_started",
    "autonomous_drafter_finished",
    "autonomous_scan_finished",
    "autonomous_chain_completed",
  ]);
});

test("autonomous drafter skips before runtime or tag work when unattended policy is disabled", async () => {
  const repoRoot = tempRoot();
  const record = diagnosisRecord({
    policy: {
      version: "disabled",
      hash: "c".repeat(64),
      read_path: "unattended_internal_clone_default_branch_head",
    },
  });
  writeAutonomousDiagnosisRecord({ repoRoot, record });

  let runtimeCalls = 0;
  let fetchCalls = 0;
  const harness = createAutonomousImprovementDrafterTestHarness({
    ensurePromotionWorkspaceImpl: () => ({
      ok: true,
      cloneDir: path.join(repoRoot, ".teami", "promotion-workspace", "repo"),
    }),
    resolveTrustedPolicyReadImpl: () => ({
      ok: true,
      read_path: "unattended_internal_clone_default_branch_head",
      source: "origin/main:execution/evals/decomposition/promotion-policy.json",
      policy_hash: "d".repeat(64),
      policy: {
        schema_version: "teami-promotion-policy/v1",
        policy_version: "disabled",
        disabled: true,
        drafting: { max_drafts_per_target_per_period: 1, period_days: 7 },
      },
    }),
    runCommand: async () => {
      runtimeCalls += 1;
      return "{}";
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("tag work should not run");
    },
    now: () => NOW,
  });

  const result = await harness.runAutonomousImprovementDrafter({
    repoRoot,
    opportunityHash: record.opportunity_hash,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "skipped");
  assert.equal(result.terminal, true);
  assert.equal(result.reason, "promotion_disabled_by_policy");
  assert.equal(runtimeCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(path.join(repoRoot, ".teami", "drafts")), false);

  const stored = readAutonomousDiagnosisRecord({
    repoRoot,
    opportunityHash: record.opportunity_hash,
  });
  assert.equal(stored.ok, true);
  const skipped = stored.record.events.find((event) => event.action === "autonomous_drafter_skipped");
  assert.ok(skipped);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "promotion_disabled_by_policy");
});

test("autonomous diagnosis production entrypoints reject injection seams", async () => {
  for (const key of UNTRUSTED_AUTONOMOUS_DIAGNOSIS_OVERRIDE_KEYS) {
    await assert.rejects(
      () => runAutonomousDiagnosisCaller({
        opportunityHash: "1".repeat(64),
        [key]: key === "now" ? () => NOW : true,
      }),
      new RegExp(`untrusted_autonomous_diagnosis_override_rejected:${key}`),
    );
    await assert.rejects(
      () => runAutonomousDiagnosisScan({ [key]: key === "now" ? () => NOW : true }),
      new RegExp(`untrusted_autonomous_diagnosis_override_rejected:${key}`),
    );
  }
});
