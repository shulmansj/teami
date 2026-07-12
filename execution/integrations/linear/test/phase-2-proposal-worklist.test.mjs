import assert from "node:assert/strict";
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
  collectPhase2ProposalWorklist,
  formatPhase2ProposalWorklist,
  PHASE_2_PROPOSAL_STATE_NAME_LIST,
  PHASE_2_PROPOSAL_STATE_NAMES,
} from "../src/promotion/proposal-worklist-read-model.mjs";
import {
  PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
  PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
} from "../src/promotion-candidate-scanner.mjs";
import { PROMOTION_REGISTRY_SCHEMA_VERSION } from "../src/promotion/registry-store.mjs";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const TARGET = "prompt/decomposition/decomposition_quality_judge";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phase-2-worklist-"));
  process.env.TEAMI_HOME = root;
  return root;
}

function writeVerifiedGitHubState(root) {
  const filePath = path.join(root, "github-connection.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "dry_run",
    status: "verified",
    repo: {
      id: "repo-1",
      owner: "factory-owner",
      name: "behavior-rules",
      full_name: "factory-owner/behavior-rules",
    },
    app_installation: null,
    local_auth: {
      mode: "local_ambient",
      gh_auth: "dry_run",
      git_write: "dry_run",
      real_push_enabled: false,
      push_auth: "https",
      checked_at: NOW.toISOString(),
    },
    push_auth: "https",
    default_branch: "main",
    verified_at: NOW.toISOString(),
  }, null, 2)}\n`);
}

function hex(label) {
  return createHash("sha256").update(label).digest("hex");
}

function marker({
  proposalInstanceId,
  envelopeHash = hex(proposalInstanceId),
  proposalState = "proposed",
  repairState = "none",
  packet = {},
} = {}) {
  return buildPromotionMarker({
    proposalInstanceId,
    candidateTargetKey: TARGET,
    candidateKind: "prompt",
    candidateVersionId: "PV1",
    acceptedBaselineId: "sha256:accepted",
    normalizedEnvelopeHash: envelopeHash,
    policyHash: "policy-hash",
    phoenixScope: { origin: "http://127.0.0.1:6006", project_name: "teami" },
    evidenceIds: {
      experiments: ["EXP1"],
      datasets: [{ dataset_id: "DS1", dataset_version_id: "DSV1" }],
      annotations: ["anno-1"],
    },
    proposalState,
    repairState,
    supersededBy: proposalState === "superseded" ? "prop-newer" : null,
    packet,
  });
}

function pr({
  number,
  body,
  state = "open",
  title = `Proposal ${number}`,
  conflict = false,
  merged = false,
} = {}) {
  return {
    number,
    state,
    title,
    body,
    head: { ref: `teami/promotion/prompt-decomposition-decomposition-quality-judge/${number}` },
    html_url: `mock://github/factory-owner/behavior-rules/pull/${number}`,
    created_at: "2026-06-17T10:00:00.000Z",
    closed_at: state === "closed" ? "2026-06-17T11:00:00.000Z" : null,
    merged_at: merged ? "2026-06-17T11:30:00.000Z" : null,
    mergeable: conflict ? false : true,
  };
}

function writeRegistryRecord(root, overrides = {}) {
  const dir = path.join(root, "promotion-candidates");
  const envelopeHash = overrides.normalized_envelope_hash || hex(overrides.proposal_instance_id || "registry");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${envelopeHash}.json`), `${JSON.stringify({
    schema_version: PROMOTION_REGISTRY_SCHEMA_VERSION,
    normalized_envelope_hash: envelopeHash,
    proposal_instance_id: "prop-registry",
    candidate_target_key: TARGET,
    candidate_kind: "prompt",
    candidate_version_id: "PV1",
    accepted_baseline_id: "sha256:accepted",
    receipt_id: "expr-registry",
    phoenix_scope: { origin: "http://127.0.0.1:6006", project_name: "teami" },
    evidence_ids: { experiments: ["EXP1"], datasets: [], annotations: [] },
    labels: { evidence_quality: "low", promotion_risk: "high_risk" },
    gate: {
      verdict: "fail",
      failed_condition_ids: ["human_label_regression"],
    },
    pr: null,
    outcome: {
      outcome: "blocked",
      reason: "process_change_gate_failed",
      detail: "failed condition(s): human_label_regression",
    },
    repair_state: "none",
    last_stage: "blocked",
    events: [{ stage: "validated", at: NOW.toISOString() }, { stage: "blocked", at: NOW.toISOString(), reason: "process_change_gate_failed" }],
    ...overrides,
  }, null, 2)}\n`);
}

function writeScannerFiles(root) {
  const dir = path.join(root, "promotion-candidates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scanner-ledger.json"), `${JSON.stringify({
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
    updated_at: NOW.toISOString(),
    last_scan_id: "scan-fixture",
    entries: [
      {
        candidate_key: "candidate-created-only",
        source: "managed_experiment_receipt",
        status: "candidate_intent_ready",
        candidate_target_key: TARGET,
        candidate_version_id: "PV2",
      },
      {
        candidate_key: "candidate-evidence-repair",
        source: "phoenix_prompt_candidate_tag",
        status: "needs_reconciliation",
        display_class: "evidence_needs_repair",
        reason: "lost_receipt_phoenix_native_ambiguity",
        candidate_target_key: TARGET,
        candidate_version_id: "PV3",
      },
      {
        candidate_key: "candidate-fyi",
        source: "managed_experiment_receipt",
        status: "discovered_evidence_without_intent",
        reason: "experiment_intent_not_promotion_candidate",
        candidate_target_key: TARGET,
        candidate_version_id: "PV4",
      },
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "scanner-health.json"), `${JSON.stringify({
    schema_version: PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
    scan_id: "scan-fixture",
    status: "degraded",
    started_at: NOW.toISOString(),
    finished_at: NOW.toISOString(),
    summary: {},
    phoenix_scan: { ok: false, reason: "local_phoenix_unavailable" },
    repo_marker_state: { ok: true, controller_calls_allowed: true, reason: null },
  }, null, 2)}\n`);
}

function writeScannerFixture(root, entries) {
  const dir = path.join(root, "promotion-candidates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scanner-ledger.json"), `${JSON.stringify({
    schema_version: PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
    updated_at: NOW.toISOString(),
    last_scan_id: "scan-fixture",
    entries,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "scanner-health.json"), `${JSON.stringify({
    schema_version: PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
    scan_id: "scan-fixture",
    status: "ok",
    started_at: NOW.toISOString(),
    finished_at: NOW.toISOString(),
    summary: {},
    phoenix_scan: { ok: true, reason: null },
    repo_marker_state: { ok: true, controller_calls_allowed: true, reason: null },
  }, null, 2)}\n`);
}

test("Phase 2 proposal worklist derives every contract state from existing facts without writing a queue", async () => {
  const root = tempRoot();
  writeVerifiedGitHubState(root);
  writeRegistryRecord(root);
  writeScannerFiles(root);
  const highRiskPacket = {
    source: "structured_packet",
    guard_status: "passed",
    copy_class: "review_carefully",
    deterministic_risk_floor: "high_risk",
    risk_reason_present: true,
    evidence_cohort_summary_present: true,
    before_after_examples_present: true,
    undo_bounds_present: true,
    authority_custody_access_present: false,
  };
  const blockedPacket = {
    source: "structured_packet",
    guard_status: "blocked",
    copy_class: "blocked_for_repair",
    deterministic_risk_floor: "unknown",
  };
  const transport = createMockGitHubTransport({
    openPullRequests: [
      pr({
        number: 10,
        title: "Safer decomposition behavior",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-high-risk",
          packet: highRiskPacket,
        })),
      }),
      pr({
        number: 11,
        title: "Incomplete proposal packet",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-blocked",
          repairState: "packet_completeness_repair_needed",
          packet: blockedPacket,
        })),
      }),
      pr({
        number: 12,
        title: "Conflicting review draft",
        conflict: true,
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-conflict",
          packet: highRiskPacket,
        })),
      }),
      pr({
        number: 13,
        title: "Superseded proposal",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-superseded",
          proposalState: "superseded",
        })),
      }),
    ],
    closedPullRequests: [
      pr({
        number: 20,
        state: "closed",
        title: "Declined proposal",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-declined",
          packet: highRiskPacket,
        })),
      }),
      pr({
        number: 21,
        state: "closed",
        merged: true,
        title: "Accepted proposal",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId: "prop-accepted",
          packet: highRiskPacket,
        })),
      }),
    ],
  });
  const beforeFiles = fs.readdirSync(path.join(root, "promotion-candidates")).sort();

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    githubTransport: transport,
    now: () => NOW,
  });
  const afterFiles = fs.readdirSync(path.join(root, "promotion-candidates")).sort();

  assert.deepEqual(afterFiles, beforeFiles, "read model must not write a worklist or mutate scanner/registry files");
  assert.deepEqual(PHASE_2_PROPOSAL_STATE_NAME_LIST, [
    "candidate-created",
    "PR opened/updated",
    "packet-complete",
    "high-risk-review-carefully",
    "failed check",
    "branch conflict",
    "evidence degraded",
    "rejection memory",
    "undo/close",
    "blocked-for-repair",
    "FYI receipt",
  ]);
  const allStates = new Set(report.items.flatMap((item) => item.states));
  for (const state of PHASE_2_PROPOSAL_STATE_NAME_LIST) {
    assert.ok(allStates.has(state), `missing derived state: ${state}`);
  }
  assert.ok(
    report.owner_judgments.some((item) =>
      item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE)
      && item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.HIGH_RISK_REVIEW_CAREFULLY)),
    "packet-complete high-risk proposal should be an owner judgment",
  );
  const blockedPacketItem = report.repair_items.find((item) => item.id === "proposal:prop-blocked");
  assert.ok(blockedPacketItem, "blocked packet proposal should be a repair item");
  assert.equal(
    blockedPacketItem.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.HIGH_RISK_REVIEW_CAREFULLY),
    false,
    "unknown risk on an incomplete packet must not emit the high-risk contract state",
  );
  const supersededItem = report.fyi_receipts.find((item) => item.id === "proposal:prop-superseded");
  assert.ok(supersededItem, "superseded proposal should be a receipt");
  assert.equal(
    supersededItem.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.HIGH_RISK_REVIEW_CAREFULLY),
    false,
    "not-evaluated packets must not emit the high-risk contract state",
  );
  assert.ok(
    report.repair_items.some((item) =>
      item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.FAILED_CHECK)
      && item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.BLOCKED_FOR_REPAIR)),
    "failed deterministic/packet checks should become repair blockers",
  );
  assert.ok(
    report.repair_items.some((item) =>
      item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.BRANCH_CONFLICT)),
    "read-time branch conflict should become a repair blocker",
  );
  assert.ok(
    report.fyi_receipts.some((item) =>
      item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.REJECTION_MEMORY)
      && item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.UNDO_CLOSE)),
    "closed unmerged PR marker should surface rejection memory and undo/close receipt",
  );
  assert.ok(
    transport.calls.every((call) =>
      ["list_open_pull_requests", "list_closed_pull_requests"].includes(call.endpointId)),
    "worklist may read PR marker facts but must not create or update PRs",
  );

  const formatted = formatPhase2ProposalWorklist(report).join("\n");
  assert.match(formatted, /Owner decisions/);
  assert.match(formatted, /Repair and setup blockers/);
  assert.match(formatted, /Receipts/);
  assert.doesNotMatch(formatted, /\b(?:git|npm|node|token|raw diff|Phoenix ID|branch)\b/i);
});

test("Phase 2 proposal worklist keeps blocked copy when registry and PR facts merge", async () => {
  const root = tempRoot();
  writeVerifiedGitHubState(root);
  const proposalInstanceId = "prop-merged-blocked";
  const envelopeHash = hex(proposalInstanceId);
  writeRegistryRecord(root, {
    proposal_instance_id: proposalInstanceId,
    normalized_envelope_hash: envelopeHash,
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [
      pr({
        number: 30,
        title: "Merged blocked proposal",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId,
          envelopeHash,
          packet: {
            source: "structured_packet",
            guard_status: "passed",
            deterministic_risk_floor: "high_risk",
          },
        })),
      }),
    ],
    closedPullRequests: [],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    githubTransport: transport,
    now: () => NOW,
  });
  const item = report.items.find((candidate) => candidate.id === `proposal:${proposalInstanceId}`);

  assert.ok(item, "merged proposal item should exist");
  assert.equal(
    report.items.filter((candidate) => candidate.id === `proposal:${proposalInstanceId}`).length,
    1,
    "registry and PR facts for the same proposal must merge into one item",
  );
  assert.equal(item.copy_class, "blocked_for_repair");
  assert.ok(report.repair_items.includes(item), "blocked merged proposal should stay in repair items");
  assert.ok(item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE));
  assert.ok(item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.HIGH_RISK_REVIEW_CAREFULLY));
  assert.ok(item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.FAILED_CHECK));
  assert.doesNotMatch(item.headline, /ready for (?:careful )?review/i);
  assert.match(item.headline, /blocked|repair|paused|check/i);
});

test("Phase 2 proposal worklist dedupes scanner repair facts with PR marker facts", async () => {
  const root = tempRoot();
  writeVerifiedGitHubState(root);
  const proposalInstanceId = "prop-scanner-pr-dedupe";
  const envelopeHash = hex(proposalInstanceId);
  writeScannerFixture(root, [
    {
      candidate_key: "scanner-evidence-repair",
      source: "managed_experiment_receipt",
      status: "needs_reconciliation",
      display_class: "evidence_needs_repair",
      normalized_envelope_hash: envelopeHash,
      candidate_target_key: TARGET,
      candidate_version_id: "PV5",
      pr: { number: 40, url: "mock://pr/40", dry_run: true },
    },
  ]);
  const transport = createMockGitHubTransport({
    openPullRequests: [
      pr({
        number: 40,
        title: "Scanner and PR describe one proposal",
        body: renderPromotionMarkerBlock(marker({
          proposalInstanceId,
          envelopeHash,
          packet: {
            source: "structured_packet",
            guard_status: "passed",
            deterministic_risk_floor: "high_risk",
          },
        })),
      }),
    ],
    closedPullRequests: [],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    githubTransport: transport,
    now: () => NOW,
  });
  const mergedItems = report.items.filter((item) =>
    item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.EVIDENCE_DEGRADED)
    && item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE));

  assert.equal(mergedItems.length, 1, "scanner repair and PR marker facts should surface as one row");
  assert.equal(mergedItems[0].id, `proposal:${proposalInstanceId}`);
  assert.equal(mergedItems[0].copy_class, "blocked_for_repair");
  assert.ok(mergedItems[0].states.includes(PHASE_2_PROPOSAL_STATE_NAMES.CANDIDATE_CREATED));
  assert.ok(mergedItems[0].states.includes(PHASE_2_PROPOSAL_STATE_NAMES.PR_OPENED_UPDATED));
  assert.equal(
    report.repair_items.filter((item) => item.id === `proposal:${proposalInstanceId}`).length,
    1,
  );
});
