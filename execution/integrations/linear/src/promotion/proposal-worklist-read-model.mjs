import fs from "node:fs";
import path from "node:path";

import { createGitHubPromotionClient } from "../github-promotion-client.mjs";
import { createProductionGitHubPromotionTransport } from "../github-production-transport.mjs";
import { resolveBehaviorRepoIdentity } from "../github-setup.mjs";
import { resolveAcceptedRefForTarget } from "../../../../engine/run-accepted-refs.mjs";
import { resolveAcceptedBaseline } from "../promotion-scanner/accepted-baseline.mjs";
import {
  defaultPromotionCandidateLedgerDir,
  promotionScannerHealthPath,
  promotionScannerLedgerPath,
} from "../promotion-scanner/ledger-store.mjs";
import { controllerNamespacePr } from "../promotion-workspace.mjs";
import { defaultRunStoreDir, validateRunArtifact } from "../../../../engine/run-store.mjs";
import { decompositionDefinition } from "../workflows/decomposition/definition.mjs";
import { readPromotionMarker } from "./pr-marker.mjs";
import {
  defaultPromotionRegistryDir,
  readJsonTolerant,
} from "./registry-store.mjs";

export const PHASE_2_PROPOSAL_WORKLIST_SCHEMA_VERSION =
  "agentic-factory-phase-2-proposal-worklist/v1";

export const PHASE_2_PROPOSAL_STATE_NAMES = Object.freeze({
  CANDIDATE_CREATED: "candidate-created",
  PR_OPENED_UPDATED: "PR opened/updated",
  PACKET_COMPLETE: "packet-complete",
  HIGH_RISK_REVIEW_CAREFULLY: "high-risk-review-carefully",
  FAILED_CHECK: "failed check",
  BRANCH_CONFLICT: "branch conflict",
  EVIDENCE_DEGRADED: "evidence degraded",
  REJECTION_MEMORY: "rejection memory",
  UNDO_CLOSE: "undo/close",
  BLOCKED_FOR_REPAIR: "blocked-for-repair",
  FYI_RECEIPT: "FYI receipt",
});

export const PHASE_2_PROPOSAL_STATE_NAME_LIST = Object.freeze(
  Object.values(PHASE_2_PROPOSAL_STATE_NAMES),
);

const COPY_CLASS_PRIORITY = Object.freeze({
  blocked_for_repair: 0,
  review_carefully: 1,
  decision_ready: 2,
  fyi_receipt: 3,
  internal_only: 4,
});

const BRANCH_REPAIR_REASONS = new Set([
  "branch_envelope_mismatch",
  "orphan_promotion_branch_requires_repair",
  "registry_pr_branch_mismatch",
  "registry_pr_not_namespaced",
  "registry_pr_marker_envelope_mismatch",
]);

const GITHUB_CONNECTION_REPAIR_REASONS = new Set([
  "missing_github_connection_state",
  "invalid_github_connection_state",
  "github_connection_not_verified",
  "github_transport_unavailable",
  "github_pr_listing_failed",
  "github_pr_listing_truncated",
  "promotion_marker_unreadable",
  "registry_pr_refetch_failed",
]);

const EVIDENCE_REPAIR_STATES = new Set([
  "evidence_repair_needed",
  "phoenix_audit_retry_needed",
]);

const FAILED_CHECK_REASONS = new Set([
  "process_change_gate_failed",
  "process_change_gate_failed_closed",
  "evidence_summary_content_rejected",
  "evidence_summary_needs_sanitization",
]);

const FYI_SCANNER_STATUSES = new Set([
  "discovered_evidence_without_intent",
  "ignored_unmanaged_target",
  "improvement_opportunity",
  "withdrawn_no_action",
  "suppressed_by_policy",
]);

function emptyProposalWorklist({ now, registryDir, ledgerDir }) {
  return {
    schema_version: PHASE_2_PROPOSAL_WORKLIST_SCHEMA_VERSION,
    generated_at: now().toISOString(),
    state_names: PHASE_2_PROPOSAL_STATE_NAME_LIST,
    sources: {
      registry_dir: registryDir,
      scanner_ledger_dir: ledgerDir,
      github_pr_markers: "read_time_when_verified_behavior_repo_connection_exists",
    },
    owner_judgments: [],
    repair_items: [],
    fyi_receipts: [],
    internal_items: [],
    diagnostics: [],
    items: [],
    deferred_writer_dependencies: [
      {
        state: PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE,
        writer: "PKT-02",
        handling: "shown only when marker.packet.guard_status is passed; not inferred from Markdown or not_evaluated packets",
      },
      {
        state: PHASE_2_PROPOSAL_STATE_NAMES.FYI_RECEIPT,
        writer: "Phase 7 engine version-bump PR channel",
        handling: "engine version-bump PR receipts are deferred beyond Phase 2; engine updates arrive as occasional version-bump PRs the owner merges",
      },
    ],
  };
}

export async function collectPhase2ProposalWorklist({
  repoRoot = process.cwd(),
  registryDir = null,
  ledgerDir = null,
  runStoreDir = null,
  githubTransport = null,
  now = () => new Date(),
} = {}) {
  const resolvedRegistryDir = registryDir || defaultPromotionRegistryDir(repoRoot);
  const resolvedLedgerDir = ledgerDir || defaultPromotionCandidateLedgerDir(repoRoot);
  const resolvedRunStoreDir = runStoreDir || defaultRunStoreDir(repoRoot);
  const report = emptyProposalWorklist({
    now,
    registryDir: resolvedRegistryDir,
    ledgerDir: resolvedLedgerDir,
  });
  const builder = createReadModelBuilder(report);
  // The run-version records (B-REFS / S-REFS) the read-time undo answer joins
  // against. Loaded ONCE here and threaded into the merged-PR branch so a
  // worklist read does a single pass over the run store.
  const runVersionRecords = loadRunVersionRecords(resolvedRunStoreDir);

  collectRegistryFacts({ registryDir: resolvedRegistryDir, builder });
  collectScannerFacts({ ledgerDir: resolvedLedgerDir, builder });
  await collectGitHubMarkerFacts({ repoRoot, githubTransport, now, builder, runVersionRecords });

  finalizeReport(report);
  return report;
}

function createReadModelBuilder(report) {
  const items = new Map();
  const ensureItem = ({
    id,
    aliases = [],
    kind,
    copyClass = "internal_only",
    headline,
    whyItMatters,
    blockedBy = null,
    whereToDecide = null,
    optionalTechnical = {},
  }) => {
    const identityKeys = uniqueStrings([id, ...aliases]);
    const existing = identityKeys.map((key) => items.get(key)).find(Boolean);
    if (existing) {
      existing.copy_class = mostProtectiveCopyClass(existing.copy_class, copyClass);
      if (preferItemId(id, existing.id)) existing.id = id;
      if (headline && existing.copy_class === copyClass) existing.headline = headline;
      if (whyItMatters && !existing.why_it_matters) existing.why_it_matters = whyItMatters;
      if (blockedBy && !existing.blocked_by) existing.blocked_by = blockedBy;
      if (whereToDecide && !existing.where_to_decide) existing.where_to_decide = whereToDecide;
      Object.assign(existing.optional_technical, optionalTechnical);
      for (const key of identityKeys) items.set(key, existing);
      return existing;
    }
    const item = {
      id,
      kind,
      copy_class: copyClass,
      states: [],
      headline,
      why_it_matters: whyItMatters,
      blocked_by: blockedBy,
      where_to_decide: whereToDecide,
      source_facts: [],
      optional_technical: { ...optionalTechnical },
    };
    for (const key of identityKeys) items.set(key, item);
    report.items.push(item);
    return item;
  };
  const addState = (item, state, sourceFact) => {
    if (!item.states.includes(state)) item.states.push(state);
    if (sourceFact) item.source_facts.push(sourceFact);
  };
  const addDiagnostic = (diagnostic) => {
    report.diagnostics.push(diagnostic);
  };
  return { addDiagnostic, addState, ensureItem };
}

function mostProtectiveCopyClass(left, right) {
  return COPY_CLASS_PRIORITY[right] < COPY_CLASS_PRIORITY[left] ? right : left;
}

function sourceFact({ surface, fact, durable, detail = null }) {
  return {
    surface,
    fact,
    durable: Boolean(durable),
    ...(detail ? { detail } : {}),
  };
}

function itemId(prefix, ...parts) {
  return [prefix, ...parts.map((part) => String(part ?? "unknown"))].join(":");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function preferItemId(nextId, currentId) {
  if (!nextId || nextId === currentId) return false;
  if (isProposalHashId(currentId) && nextId.startsWith("proposal:") && !isProposalHashId(nextId)) return true;
  if (nextId.startsWith("proposal:") && !currentId.startsWith("proposal:")) return true;
  return currentId.includes(":unknown") && !nextId.includes(":unknown");
}

function isProposalHashId(id) {
  return /^proposal:[0-9a-f]{64}$/i.test(String(id || ""));
}

function proposalWorklistIdentity({
  prNumber = null,
  proposalInstanceId = null,
  normalizedEnvelopeHash = null,
  candidateTargetKey = null,
  candidateVersionId = null,
  requestHash = null,
  candidateKey = null,
  receiptId = null,
  fallbackPrefix = "candidate",
  fallback = "unknown",
} = {}) {
  const targetVersionHash = requestHash || normalizedEnvelopeHash || null;
  const candidateComposite = candidateTargetKey && candidateVersionId
    ? itemId("candidate", candidateTargetKey, candidateVersionId, targetVersionHash || "unknown")
    : null;
  const aliases = uniqueStrings([
    prNumber ? itemId("proposal-pr", prNumber) : null,
    proposalInstanceId ? itemId("proposal", proposalInstanceId) : null,
    normalizedEnvelopeHash ? itemId("proposal", normalizedEnvelopeHash) : null,
    candidateComposite,
    candidateKey ? itemId("candidate", candidateKey) : null,
    receiptId ? itemId("candidate", receiptId) : null,
  ]);
  const id =
    (proposalInstanceId ? itemId("proposal", proposalInstanceId) : null)
    || (normalizedEnvelopeHash ? itemId("proposal", normalizedEnvelopeHash) : null)
    || (prNumber ? itemId("proposal-pr", prNumber) : null)
    || candidateComposite
    || (candidateKey ? itemId("candidate", candidateKey) : null)
    || (receiptId ? itemId("candidate", receiptId) : null)
    || itemId(fallbackPrefix, fallback);
  return { id, aliases };
}

function collectRegistryFacts({ registryDir, builder }) {
  for (const { filePath, record } of readRegistryRecords(registryDir)) {
    const identity = proposalWorklistIdentity({
      prNumber: record.pr?.number,
      proposalInstanceId: record.proposal_instance_id,
      normalizedEnvelopeHash: record.normalized_envelope_hash,
      candidateTargetKey: record.candidate_target_key,
      candidateVersionId: record.candidate_version_id,
      requestHash: record.request_hash,
      candidateKey: record.candidate_key,
      receiptId: record.receipt_id,
      fallbackPrefix: "proposal",
      fallback: path.basename(filePath, ".json"),
    });
    const item = builder.ensureItem({
      id: identity.id,
      aliases: identity.aliases,
      kind: "proposal",
      copyClass: "internal_only",
      headline: "Behavior-change candidate recorded.",
      whyItMatters: "A candidate exists, but it is not an owner approval request by itself.",
      whereToDecide: "No owner decision yet.",
      optionalTechnical: {
        registry_path: filePath,
        normalized_envelope_hash: record.normalized_envelope_hash ?? null,
        proposal_instance_id: record.proposal_instance_id ?? null,
      },
    });
    builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.CANDIDATE_CREATED, sourceFact({
      surface: "local_promotion_registry",
      fact: "registry row exists",
      durable: true,
    }));

    if (record.pr?.number) {
      builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.PR_OPENED_UPDATED, sourceFact({
        surface: "local_promotion_registry_cache",
        fact: "registry pr cache present",
        durable: true,
        detail: "cache only; live PR marker remains authoritative",
      }));
    }

    const gateFailed =
      record.gate?.verdict === "fail"
      || (Array.isArray(record.gate?.failed_condition_ids) && record.gate.failed_condition_ids.length > 0)
      || FAILED_CHECK_REASONS.has(record.outcome?.reason);
    if (gateFailed) {
      markFailedCheck({ builder, item, surface: "local_promotion_registry" });
    }

    if (record.repair_state && record.repair_state !== "none") {
      markBlockedForRepair({
        builder,
        item,
        repairState: record.repair_state,
        surface: "local_promotion_registry",
      });
    }

    const outcomeReason = record.outcome?.reason || lastRegistryBlockReason(record);
    if (BRANCH_REPAIR_REASONS.has(outcomeReason)) {
      markBranchConflict({ builder, item, surface: "local_promotion_registry", reason: outcomeReason });
    }
    if (GITHUB_CONNECTION_REPAIR_REASONS.has(outcomeReason)) {
      markConnectionRepair({ builder, reason: outcomeReason, detail: record.outcome?.detail ?? null });
    }
    if (record.outcome?.outcome === "blocked") {
      if (record.outcome.reason === "improvement_opportunity_no_proposed_change") {
        markFyi({
          builder,
          item,
          headline: "Improvement opportunity recorded; no decision is needed.",
          whyItMatters:
            "Evidence suggested a possible behavior improvement, but no concrete proposal is ready for approval.",
          source: "local_promotion_registry",
        });
      } else if (record.outcome.reason === "suppressed_by_human_rejection") {
        markFyi({
          builder,
          item,
          headline: "Behavior proposal stayed declined; no behavior changed.",
          whyItMatters:
            "The same behavior-change idea is suppressed until an append-only receipt amendment records materially new evidence.",
          source: "local_promotion_registry",
        });
      } else {
        markBlockedForRepair({
          builder,
          item,
          repairState: record.repair_state || "registry_block",
          surface: "local_promotion_registry",
        });
      }
    }

    if (EVIDENCE_REPAIR_STATES.has(record.repair_state) || record.evidence_repair) {
      markEvidenceDegraded({ builder, item, surface: "local_promotion_registry" });
    }
  }
}

function readRegistryRecords(registryDir) {
  if (!fs.existsSync(registryDir)) return [];
  return fs.readdirSync(registryDir)
    .filter((name) => /^[0-9a-f]{64}\.json$/i.test(name))
    .map((name) => {
      const filePath = path.join(registryDir, name);
      return { filePath, record: readJsonTolerant(filePath) };
    })
    .filter(({ record }) =>
      record
      && typeof record === "object"
      && record.schema_version
      && (record.normalized_envelope_hash || record.proposal_instance_id || record.candidate_target_key));
}

function lastRegistryBlockReason(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  for (const event of [...events].reverse()) {
    if (event.retryable_block) return event.retryable_block;
    if (event.reason) return event.reason;
  }
  return null;
}

function collectScannerFacts({ ledgerDir, builder }) {
  const ledgerPath = promotionScannerLedgerPath(ledgerDir);
  let ledger = readJsonTolerant(ledgerPath);
  if (!ledger) {
    if (fs.existsSync(ledgerPath)) {
      builder.addDiagnostic({
        copy_class: "blocked_for_repair",
        headline: "Promotion scan status could not be read.",
        why_it_matters: "Proposal repair status may be incomplete until the local scan cache is rebuilt.",
        source_facts: [sourceFact({
          surface: "scanner_ledger",
          fact: "read failed",
          durable: true,
          detail: "scanner ledger JSON was missing or unreadable",
        })],
      });
    }
    ledger = { entries: [] };
  }
  if (!Array.isArray(ledger.entries)) {
    builder.addDiagnostic({
      copy_class: "blocked_for_repair",
      headline: "Promotion scan status could not be read.",
      why_it_matters: "Proposal repair status may be incomplete until the local scan cache is rebuilt.",
      source_facts: [sourceFact({
        surface: "scanner_ledger",
        fact: "invalid shape",
        durable: true,
        detail: "scanner ledger entries were unavailable",
      })],
    });
    ledger = { entries: [] };
  }

  for (const entry of Array.isArray(ledger.entries) ? ledger.entries : []) {
    const identity = proposalWorklistIdentity({
      prNumber: entry.pr?.number,
      proposalInstanceId: entry.proposal_instance_id,
      normalizedEnvelopeHash: entry.normalized_envelope_hash,
      candidateTargetKey: entry.candidate_target_key,
      candidateVersionId: entry.candidate_version_id,
      requestHash: entry.request_hash,
      candidateKey: entry.candidate_key,
      receiptId: entry.receipt_id,
    });
    const item = builder.ensureItem({
      id: identity.id,
      aliases: identity.aliases,
      kind: "candidate",
      copyClass: "internal_only",
      headline: "Behavior-change candidate found.",
      whyItMatters: "A candidate signal exists; it becomes owner-facing only if it opens or blocks a proposal.",
      whereToDecide: "No owner decision yet.",
      optionalTechnical: {
        candidate_key: entry.candidate_key ?? null,
        candidate_target_key: entry.candidate_target_key ?? null,
        scanner_status: entry.status ?? null,
      },
    });
    builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.CANDIDATE_CREATED, sourceFact({
      surface: "scanner_ledger",
      fact: entry.status || "scanner entry",
      durable: true,
    }));

    if (entry.pr?.number || entry.status === "controller_called_pr_opened") {
      builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.PR_OPENED_UPDATED, sourceFact({
        surface: "scanner_ledger",
        fact: "controller opened or reused a proposal",
        durable: true,
      }));
    }
    if (entry.display_class === "evidence_needs_repair" || entry.evidence_repair) {
      markEvidenceDegraded({ builder, item, surface: "scanner_ledger" });
      markBlockedForRepair({
        builder,
        item,
        repairState: "evidence_repair_needed",
        surface: "scanner_ledger",
      });
    }
    if (entry.controller_outcome === "blocked" && FAILED_CHECK_REASONS.has(entry.controller_reason)) {
      markFailedCheck({ builder, item, surface: "scanner_ledger" });
      markBlockedForRepair({
        builder,
        item,
        repairState: "failed_check",
        surface: "scanner_ledger",
      });
    }
    if (BRANCH_REPAIR_REASONS.has(entry.controller_reason)) {
      markBranchConflict({ builder, item, surface: "scanner_ledger", reason: entry.controller_reason });
    }
    if (entry.status === "blocked_by_verified_repo_state" || GITHUB_CONNECTION_REPAIR_REASONS.has(entry.reason)) {
      markConnectionRepair({ builder, reason: entry.reason || entry.controller_reason, detail: entry.detail });
    }
    if (FYI_SCANNER_STATUSES.has(entry.status)) {
      markFyi({
        builder,
        item,
        headline: fyiHeadlineForScannerEntry(entry),
        whyItMatters: fyiWhyForScannerEntry(entry),
        source: "scanner_ledger",
      });
    }
  }

  const health = readJsonTolerant(promotionScannerHealthPath(ledgerDir));
  if (health?.phoenix_scan?.ok === false || health?.status === "degraded") {
    const item = builder.ensureItem({
      id: itemId("diagnostic", "evidence-degraded"),
      kind: "diagnostic",
      copyClass: "blocked_for_repair",
      headline: "Evidence quality is degraded.",
      whyItMatters: "The system may not have enough reliable evidence to ask for a fair owner decision.",
      blockedBy: "Evidence is incomplete or unreachable; repair evidence before deciding on affected proposals.",
      whereToDecide: "No owner decision yet.",
    });
    markEvidenceDegraded({ builder, item, surface: "scanner_health" });
  }
  if (health?.repo_marker_state && health.repo_marker_state.ok === false) {
    markConnectionRepair({
      builder,
      reason: health.repo_marker_state.reason,
      detail: health.repo_marker_state.detail,
    });
  }
}

async function collectGitHubMarkerFacts({ repoRoot, githubTransport, now, builder, runVersionRecords = [] }) {
  const identity = resolveBehaviorRepoIdentity({ repoRoot });
  if (!identity.ok) {
    markConnectionRepair({ builder, reason: identity.reason, detail: null });
    return;
  }

  let selection;
  try {
    selection = githubTransport
      ? { transport: githubTransport, mode: githubTransport.kind || "test_harness" }
      : createProductionGitHubPromotionTransport({ repoRoot, repoIdentity: identity, now });
  } catch (error) {
    markConnectionRepair({ builder, reason: "github_transport_unavailable", detail: error.message });
    return;
  }

  const github = createGitHubPromotionClient({
    transport: selection.transport,
    repo: identity.repo,
  });
  let openPrs;
  let closedPrs;
  try {
    openPrs = (await github.listOpenPullRequests())?.data || [];
    closedPrs = (await github.listClosedPullRequests())?.data || [];
  } catch (error) {
    const normalized = String(error.message || "").toLowerCase().replace(/\s+/g, "_");
    const reason = /github_pr_listing_truncated|pr_listing_truncated/.test(normalized)
      ? "github_pr_listing_truncated"
      : "github_pr_listing_failed";
    markConnectionRepair({ builder, reason, detail: error.message });
    return;
  }

  for (const pr of openPrs) {
    collectPrMarkerFact({ builder, pr, prState: "open", runVersionRecords, repoRoot });
  }
  for (const pr of closedPrs) {
    collectPrMarkerFact({ builder, pr, prState: "closed", runVersionRecords, repoRoot });
  }
}

function collectPrMarkerFact({ builder, pr, prState, runVersionRecords = [], repoRoot = process.cwd() }) {
  const read = readPromotionMarker(pr?.body);
  if (read.status !== "ok") {
    if (controllerNamespacePr(pr)) {
      markConnectionRepair({
        builder,
        reason: "promotion_marker_unreadable",
        detail: `proposal review #${pr?.number ?? "unknown"} marker ${read.status}${read.reason ? `:${read.reason}` : ""}`,
      });
    }
    return;
  }

  const marker = read.marker;
  const identity = proposalWorklistIdentity({
    prNumber: pr?.number,
    proposalInstanceId: marker.proposal_instance_id,
    normalizedEnvelopeHash: marker.normalized_envelope_hash,
    candidateTargetKey: marker.candidate_target_key,
    candidateVersionId: marker.candidate_version_id,
  });
  const item = builder.ensureItem({
    id: identity.id,
    aliases: identity.aliases,
    kind: "proposal",
    copyClass: "internal_only",
    headline: proposalHeadlineForPr({ pr, marker, prState }),
    whyItMatters: proposalWhyForPr({ marker, prState }),
    whereToDecide: prState === "open"
      ? (pr.html_url || "Open the proposal review.")
      : "No owner decision needed.",
    optionalTechnical: {
      pr_number: pr.number ?? null,
      proposal_instance_id: marker.proposal_instance_id,
      normalized_envelope_hash: marker.normalized_envelope_hash,
      marker_proposal_state: marker.proposal_state,
      marker_repair_state: marker.repair_state,
      packet_guard_status: marker.packet?.guard_status ?? null,
    },
  });

  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.PR_OPENED_UPDATED, sourceFact({
    surface: "github_pr_marker",
    fact: `proposal PR is ${prState}`,
    durable: true,
  }));

  if (prState === "open") {
    const packetState = derivePacketState(marker.packet);
    if (packetState.complete) {
      builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE, sourceFact({
        surface: "github_pr_marker.packet",
        fact: "packet guard passed",
        durable: true,
      }));
      const packetCopyClass = packetState.reviewCarefully ? "review_carefully" : "decision_ready";
      item.copy_class = mostProtectiveCopyClass(item.copy_class, packetCopyClass);
      if (item.copy_class === packetCopyClass) {
        item.headline = packetState.reviewCarefully
          ? "High-risk behavior proposal is ready for careful review."
          : "Behavior proposal is ready for review.";
        item.why_it_matters = packetState.reviewCarefully
          ? "Approval would change factory behavior, and deterministic risk facts say to review the consequence and safe default carefully."
          : "Approval would change factory behavior; decline leaves accepted behavior unchanged.";
      }
      item.where_to_decide = pr.html_url || "Open the proposal review.";
    } else if (marker.proposal_state === "proposed" && marker.repair_state === "none") {
      item.copy_class = mostProtectiveCopyClass(item.copy_class, "blocked_for_repair");
      item.headline = "Behavior proposal is not ready for a decision yet.";
      item.why_it_matters = "The proposal exists, but the structured review packet has not passed the readiness check. This is system work, not an owner decision.";
      item.blocked_by = "The packet readiness check has not completed yet; no owner action is needed until it passes.";
      item.where_to_decide = "No owner approve/decline decision yet.";
      item.deferred = {
        state: PHASE_2_PROPOSAL_STATE_NAMES.PACKET_COMPLETE,
        writer_dependency: "PKT-02 packet-completeness guard",
      };
    }
    if (packetState.highRisk) {
      builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.HIGH_RISK_REVIEW_CAREFULLY, sourceFact({
        surface: "github_pr_marker.packet",
        fact: `deterministic risk floor ${marker.packet?.deterministic_risk_floor ?? "unknown"}`,
        durable: true,
      }));
    }
    if (marker.packet?.guard_status === "blocked") {
      markFailedCheck({ builder, item, surface: "github_pr_marker.packet" });
      markBlockedForRepair({
        builder,
        item,
        repairState: marker.repair_state || "packet_completeness_repair_needed",
        surface: "github_pr_marker.packet",
      });
    }
    if (marker.proposal_state === "blocked" || marker.repair_state !== "none") {
      markBlockedForRepair({
        builder,
        item,
        repairState: marker.repair_state,
        surface: "github_pr_marker",
      });
    }
    if (EVIDENCE_REPAIR_STATES.has(marker.repair_state)) {
      markEvidenceDegraded({ builder, item, surface: "github_pr_marker" });
    }
    if (marker.repair_state === "branch_repair_needed" || prHasBranchConflict(pr)) {
      markBranchConflict({ builder, item, surface: "github_pr_read_time", reason: "branch_conflict" });
    }
    if (marker.proposal_state === "superseded") {
      markFyi({
        builder,
        item,
        headline: "Proposal was replaced by a newer proposal.",
        whyItMatters: "The owner should not decide on the older review.",
        source: "github_pr_marker",
      });
    }
  } else {
    builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.UNDO_CLOSE, sourceFact({
      surface: "github_pr_state",
      fact: pr.merged_at ? "proposal merged" : "proposal closed without merge",
      durable: true,
    }));
    if (!pr.merged_at && !["superseded", "blocked"].includes(marker.proposal_state)) {
      builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.REJECTION_MEMORY, sourceFact({
        surface: "github_pr_marker",
        fact: "closed unmerged proposal marker inside read-time PR state",
        durable: true,
      }));
      markFyi({
        builder,
        item,
        headline: "Behavior proposal was declined; no behavior changed.",
        whyItMatters: "The same idea should not keep returning unless materially new evidence appears.",
        source: "github_pr_marker",
      });
    } else {
      markFyi({
        builder,
        item,
        headline: pr.merged_at
          ? "Behavior proposal was accepted and recorded."
          : "Proposal was closed; no decision is needed.",
        whyItMatters: pr.merged_at
          ? "Undo requires a future owner-reviewed proposal or manual revert."
          : "The owner review is no longer active.",
        source: "github_pr_state",
      });
    }
    if (pr.merged_at) {
      attachUndoAnswer({ builder, item, marker, runVersionRecords, repoRoot });
    }
  }
}

// B-READ (S-READ): for a MERGED proposal, surface the full undo answer on the
// item — the static frame from `marker.undo_bounds` (B-UNDO, proposal-time)
// plus the read-time-computed `consumed_downstream` / `reversible`. Live PR
// state + the live marker are the current-state authority here; the registry
// cache never reaches this branch.
function attachUndoAnswer({ builder, item, marker, runVersionRecords, repoRoot = process.cwd() }) {
  const consumedDownstream = computeConsumedDownstream({ marker, runVersionRecords });
  // Reversible requires BOTH that nothing downstream consumed the change AND
  // that this version is still the CURRENT accepted version for the target. A
  // later PR may have merged a newer version of the same target, superseding
  // this one — undoing a superseded change is not clean, so it is not
  // reversible even when `consumed_downstream === "not_used"`.
  const superseded = isSupersededByCurrentAccepted({ marker, repoRoot });
  const reversible = consumedDownstream === "not_used" && superseded === false;
  const undoAnswer = {
    // The proposal-time-knowable frame, carried verbatim from the marker (or
    // null when this merged proposal predates B-UNDO).
    undo_bounds: marker.undo_bounds ?? null,
    // The read-time facts (NOT on the marker — computed against the live
    // run-version records and the current accepted version at read time).
    consumed_downstream: consumedDownstream,
    // True only when this version is still the current accepted version; a newer
    // merged version supersedes it. `unknown` (could not resolve the current
    // accepted ref) is conservative ⇒ treated as NOT cleanly reversible.
    superseded,
    // Only confidently reversible when a downstream signal exists, no live
    // post-merge run consumed the accepted version, AND this version is still
    // current. `unknown`/`used`/superseded ⇒ NOT reversible (the conservative
    // default for an undo warning).
    reversible,
  };
  item.optional_technical.undo_answer = undoAnswer;
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.UNDO_CLOSE, sourceFact({
    surface: "behavior_ledger_undo_answer",
    fact: `consumed_downstream=${consumedDownstream}`,
    durable: true,
    detail: reversible
      ? "no live post-merge run has consumed the accepted version and it is still the current accepted version"
      : superseded === true
        ? "a newer version of this target has since been accepted (superseded); not cleanly reversible"
        : "treated as possibly-used; not confidently reversible",
  }));
}

// Whether the merged proposal's version has since been SUPERSEDED by a newer
// accepted version of the same target. Resolves the CURRENT accepted ref for
// the target against the current pinned manifest (the same resolver B-REFS uses
// to capture refs) and compares it to the version this proposal became on merge
// (`marker.merged_accepted_ref`):
//   - false   the merged version IS still the current accepted version.
//   - true    the current accepted version differs ⇒ superseded.
//   - "unknown" the join key or the current accepted ref is unavailable ⇒
//               conservative (caller treats as not cleanly reversible).
function isSupersededByCurrentAccepted({ marker, repoRoot }) {
  const mergedRef = marker?.merged_accepted_ref;
  if (!isJoinableRef(mergedRef)) return "unknown";
  const currentRef = resolveAcceptedRefForTarget({
    targetKey: mergedRef.target_key,
    repoRoot,
    definition: decompositionDefinition,
    resolveAcceptedBaseline,
  });
  if (!isJoinableRef(currentRef)) return "unknown";
  return refsIdentifySameVersion(currentRef, mergedRef) ? false : true;
}

// True when two normalized accepted refs name the SAME version of the SAME
// target — same `target_key` and a matching `accepted_baseline_id` OR
// `snapshot_sha256` (the two identifiers B-REFS and B-UNDO mint identically).
function refsIdentifySameVersion(left, right) {
  if (!left || !right || left.target_key !== right.target_key) return false;
  return (
    (nonEmptyRefString(left.accepted_baseline_id)
      && left.accepted_baseline_id === right.accepted_baseline_id)
    || (nonEmptyRefString(left.snapshot_sha256)
      && left.snapshot_sha256 === right.snapshot_sha256)
  );
}

// Compute `consumed_downstream` ∈ {used, not_used, unknown} for a merged
// proposal by joining the run-version records against the marker's post-merge
// version reference (`merged_accepted_ref`), filtered to the live (non-eval)
// run mode:
//   - used      iff a LIVE run has an `accepted_refs[]` entry matching the
//               merged ref for that `target_key`. Because refs are captured
//               AT LOAD (B-REFS) and a candidate becomes the accepted baseline
//               ONLY on merge (a no-diff candidate is blocked), a captured-ref
//               MATCH already implies the run loaded the post-merge version —
//               i.e. downstream/post-merge consumption. No merge-time boundary
//               is needed (and a clock-skew/straddling-run time gate would be
//               both broken and unnecessary); the ref match IS the signal.
//   - not_used  iff at least one live run carries a USABLE (joinable)
//               `accepted_refs` entry for this target at a NON-merged version
//               (real negative coverage) AND no live run is inconclusive for the
//               target (see below). Relies on the writer's capture-at-load
//               completeness: a live run carrying no entry for the target did not
//               consume it.
//   - unknown   iff no usable signal exists (no `merged_accepted_ref`, or the
//               change predates the run-version record so no live run carries
//               refs), OR any live run is INCONCLUSIVE for the target — it
//               records touching the target (a coverage marker) but at an
//               unresolvable version, so it might be the run that consumed the
//               merged version. unknown ⇒ treat as possibly-used (conservative).
// Only reached for a merged proposal (the caller gates on `pr.merged_at`).
//
// COMPLETENESS INVARIANT this relies on: a live run records a usable ref (or a
// coverage marker) AT LOAD for every accepted target it consumes, so "no entry
// for the target" safely means "did not consume it." This holds because each
// proposal target is either ALWAYS captured (the orchestrator's library subagent
// prompts and the runtime-role defaults) or NEVER captured. A never-captured target makes
// EVERY live run neutral for it ⇒ a uniform `unknown`, never a false not_used.
// The quality-judge prompt (`prompt/decomposition/decomposition_quality_judge`)
// is a proposal target consumed OUTSIDE the orchestrator's subagent invocations and is currently never
// captured ⇒ judge-prompt proposals read `unknown` until judge capture lands. A
// target that were SOMETIMES captured would break this invariant — don't add one.
function computeConsumedDownstream({ marker, runVersionRecords }) {
  const mergedRef = marker?.merged_accepted_ref;
  if (!isJoinableRef(mergedRef)) return "unknown"; // no join key ⇒ no signal.

  let sawNegativeCoverage = false;
  let sawInconclusiveCoverage = false;
  for (const record of runVersionRecords) {
    if (record.execution_mode !== "live") continue; // eval / mode-less runs never count.
    if (runConsumedMergedRef(record, mergedRef)) return "used";
    if (recordHasUsableRefForTarget(record, mergedRef.target_key)) {
      // A joinable ref for this target at a NON-merged version: conclusive
      // evidence this run consumed the target at an older version, not the
      // merged one.
      sawNegativeCoverage = true;
    } else if (recordReferencesTargetUnjoinably(record, mergedRef.target_key)) {
      // The run records touching this target but at an UNKNOWN version (a
      // coverage marker with null identifiers — a non-surfacing executor, or
      // runtime defaults whose load-time ref was unavailable). It may have
      // consumed the merged version, so it cannot be ruled out.
      sawInconclusiveCoverage = true;
    }
    // else: no entry for this target at all. Accepted refs are captured AT LOAD
    // for every accepted target the orchestrator consumes (the writer's completeness
    // contract), so a live run carrying no entry for the target did not consume
    // it — neutral.
  }

  // An inconclusive run (touched the target at an unknown version) forbids a
  // confident not_used: it might be the run that consumed the merged version.
  if (sawInconclusiveCoverage) return "unknown";
  return sawNegativeCoverage ? "not_used" : "unknown";
}

// Load the run-version records B-READ joins against: VALIDATED TERMINAL
// decomposition run artifacts (`commit` / `pause`) from the run store. The dir
// holds mixed kinds (checkpoint/pause/commit/resume); only terminal runs are a
// completed decomposition that could have consumed an accepted version, and a
// malformed artifact is skipped rather than trusted.
function loadRunVersionRecords(runStoreDir) {
  if (!runStoreDir || !fs.existsSync(runStoreDir)) return [];
  let names;
  try {
    names = fs.readdirSync(runStoreDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readJsonTolerant(path.join(runStoreDir, name));
    if (!record || typeof record !== "object") continue;
    if (record.kind !== "commit" && record.kind !== "pause") continue;
    try {
      validateRunArtifact(record);
    } catch {
      continue; // not a valid terminal run artifact ⇒ not consumption evidence.
    }
    records.push(record);
  }
  return records;
}

function isJoinableRef(ref) {
  return Boolean(
    ref
    && typeof ref === "object"
    && typeof ref.target_key === "string"
    && ref.target_key !== ""
    && (nonEmptyRefString(ref.accepted_baseline_id) || nonEmptyRefString(ref.snapshot_sha256)),
  );
}

// True when the run consumed the SAME accepted version the candidate becomes on
// merge: same `target_key` AND the same version identity (matching
// `accepted_baseline_id` OR `snapshot_sha256` — the two normalized identifiers
// B-REFS and B-UNDO mint identically).
function runConsumedMergedRef(record, mergedRef) {
  const refs = Array.isArray(record?.accepted_refs) ? record.accepted_refs : [];
  return refs.some((ref) =>
    ref
    && typeof ref === "object"
    && ref.target_key === mergedRef.target_key
    && (
      (nonEmptyRefString(ref.accepted_baseline_id)
        && ref.accepted_baseline_id === mergedRef.accepted_baseline_id)
      || (nonEmptyRefString(ref.snapshot_sha256)
        && ref.snapshot_sha256 === mergedRef.snapshot_sha256)
    ));
}

// True when the run carries a USABLE accepted-ref signal for the target: a
// joinable entry (non-empty target_key plus a non-empty version identifier) for
// this `target_key`. A live run with only missing/empty/unjoinable refs for the
// target has NO usable signal and must not be counted as negative coverage.
function recordHasUsableRefForTarget(record, targetKey) {
  const refs = Array.isArray(record?.accepted_refs) ? record.accepted_refs : [];
  return refs.some((ref) =>
    ref
    && typeof ref === "object"
    && ref.target_key === targetKey
    && (nonEmptyRefString(ref.accepted_baseline_id) || nonEmptyRefString(ref.snapshot_sha256)));
}

// True when the run RECORDS that it touched the target (an `accepted_refs` entry
// for it) but with NO joinable version identity (both identifiers empty) — a
// coverage marker the writer emits when the orchestrator consumed the target's accepted
// artifact but the exact version could not be captured (a non-surfacing
// executor, or runtime defaults whose load-time ref was unavailable). The run
// touched the target at an UNKNOWN version, so it can be neither ruled in nor out.
function recordReferencesTargetUnjoinably(record, targetKey) {
  const refs = Array.isArray(record?.accepted_refs) ? record.accepted_refs : [];
  return refs.some((ref) =>
    ref
    && typeof ref === "object"
    && ref.target_key === targetKey
    && !nonEmptyRefString(ref.accepted_baseline_id)
    && !nonEmptyRefString(ref.snapshot_sha256));
}

function nonEmptyRefString(value) {
  return typeof value === "string" && value !== "";
}

function derivePacketState(packet = {}) {
  const riskFloor = packet?.deterministic_risk_floor || "unknown";
  const complete = packet?.source === "structured_packet" && packet?.guard_status === "passed";
  return {
    complete,
    highRisk: complete && (riskFloor === "high_risk" || riskFloor === "unknown"),
    reviewCarefully: complete && (riskFloor === "high_risk" || riskFloor === "unknown"),
  };
}

function prHasBranchConflict(pr = {}) {
  if (pr.mergeable === false) return true;
  const state = pr.mergeable_state || pr.merge_state_status || null;
  return state === "dirty";
}

function markFailedCheck({ builder, item, surface }) {
  item.copy_class = mostProtectiveCopyClass(item.copy_class, "blocked_for_repair");
  item.headline = "Proposal is blocked by a required check.";
  item.why_it_matters = "The system should not ask for approval until deterministic prerequisites pass.";
  item.blocked_by = "A required safety or evidence check did not pass.";
  item.where_to_decide = "No owner approve/decline decision yet.";
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.FAILED_CHECK, sourceFact({
    surface,
    fact: "deterministic or packet prerequisite failed",
    durable: surface !== "github_pr_read_time",
  }));
}

function markBranchConflict({ builder, item, surface, reason }) {
  item.copy_class = mostProtectiveCopyClass(item.copy_class, "blocked_for_repair");
  item.headline = "Proposal cannot be checked safely until repaired.";
  item.why_it_matters = "The review draft is not safe to compare as-is, so approval would be confusing.";
  item.blocked_by = "The proposal review draft needs repair before it can be judged.";
  item.where_to_decide = "No owner approve/decline decision yet.";
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.BRANCH_CONFLICT, sourceFact({
    surface,
    fact: reason || "branch conflict",
    durable: surface !== "github_pr_read_time",
  }));
}

function markEvidenceDegraded({ builder, item, surface }) {
  item.copy_class = mostProtectiveCopyClass(item.copy_class, "blocked_for_repair");
  item.headline = "Evidence needs repair before this can be decided.";
  item.why_it_matters = "The owner needs a trustworthy explanation and evidence summary before approving behavior changes.";
  item.blocked_by = "Required evidence is incomplete or unreachable.";
  item.where_to_decide = "No owner approve/decline decision yet.";
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.EVIDENCE_DEGRADED, sourceFact({
    surface,
    fact: "evidence degraded or audit repair needed",
    durable: surface !== "github_pr_read_time",
  }));
}

function markBlockedForRepair({ builder, item, repairState, surface }) {
  item.copy_class = mostProtectiveCopyClass(item.copy_class, "blocked_for_repair");
  item.headline = "Work is paused until repair is complete.";
  item.why_it_matters = "The owner should not be asked to decide while the proposal is not judgeable.";
  item.blocked_by = repairCopyForState(repairState);
  item.where_to_decide = "No owner approve/decline decision yet.";
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.BLOCKED_FOR_REPAIR, sourceFact({
    surface,
    fact: repairState || "blocked",
    durable: true,
  }));
}

function markConnectionRepair({ builder, reason, detail }) {
  const item = builder.ensureItem({
    id: itemId("connection", reason || "behavior-rules"),
    kind: "connection",
    copyClass: "blocked_for_repair",
    headline: "Behavior rules connection needs repair.",
    whyItMatters: "Agentic Factory cannot safely tell whether behavior proposals are waiting until this is repaired.",
    blockedBy: "The connection to the behavior rules needs repair before proposals can be checked.",
    whereToDecide: "No owner approve/decline decision yet.",
    optionalTechnical: { reason: reason ?? null, detail: detail ?? null },
  });
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.BLOCKED_FOR_REPAIR, sourceFact({
    surface: "scanner_health_or_read_time_github",
    fact: reason || "github_connection_repair_needed",
    durable: false,
    detail,
  }));
}

function markFyi({ builder, item, headline, whyItMatters, source }) {
  item.copy_class = mostProtectiveCopyClass(item.copy_class, "fyi_receipt");
  item.headline = headline;
  item.why_it_matters = whyItMatters;
  item.blocked_by = null;
  item.where_to_decide = "No decision needed.";
  builder.addState(item, PHASE_2_PROPOSAL_STATE_NAMES.FYI_RECEIPT, sourceFact({
    surface: source,
    fact: "receipt or no-action fact",
    durable: true,
  }));
}

function repairCopyForState(repairState) {
  switch (repairState) {
    case "packet_completeness_repair_needed":
      return "The proposal is missing information needed for a fair decision. Do not approve it yet; repair the packet and rerun promotion.";
    case "evidence_repair_needed":
    case "phoenix_audit_retry_needed":
      return "Evidence is incomplete; repair it before deciding.";
    case "supersede_retry_needed":
      return "An older proposal could not be marked as replaced yet.";
    case "branch_repair_needed":
      return "The proposal cannot be checked safely until repaired.";
    case "github_connection_repair_needed":
      return "The connection to the behavior rules needs repair before proposals can be checked.";
    default:
      return "A repair is needed before this can be safely judged.";
  }
}

function proposalHeadlineForPr({ pr, marker, prState }) {
  if (prState === "closed") return "Proposal review is closed.";
  if (marker.proposal_state === "blocked") return "Proposal is blocked for repair.";
  if (marker.proposal_state === "superseded") return "Proposal was replaced.";
  return pr?.title ? `Proposal waiting: ${pr.title}` : "Behavior proposal is open.";
}

function proposalWhyForPr({ marker, prState }) {
  if (prState === "closed") {
    return "Closed proposal state is retained so the same idea does not keep reappearing without new evidence.";
  }
  if (marker.proposal_state === "blocked") {
    return "The proposal exists, but it is not safe to ask for approval until repaired.";
  }
  return "Approval would change accepted factory behavior; declining leaves current behavior unchanged.";
}

function fyiHeadlineForScannerEntry(entry) {
  if (entry.status === "improvement_opportunity") return "Improvement opportunity found; no proposal is ready yet.";
  if (entry.status === "discovered_evidence_without_intent") return "Evidence was found without a requested behavior change.";
  if (entry.status === "withdrawn_no_action") return "Candidate was withdrawn; no proposal was opened.";
  return "Candidate was recorded with no owner decision needed.";
}

function fyiWhyForScannerEntry(entry) {
  if (entry.status === "improvement_opportunity") {
    return "There may be useful evidence, but a concrete behavior-change proposal still needs to be drafted.";
  }
  if (entry.status === "discovered_evidence_without_intent") {
    return "Evidence alone does not ask the owner to approve a behavior change.";
  }
  return "No accepted behavior changes from this record.";
}

function finalizeReport(report) {
  for (const item of report.items) {
    item.states.sort((a, b) =>
      PHASE_2_PROPOSAL_STATE_NAME_LIST.indexOf(a) - PHASE_2_PROPOSAL_STATE_NAME_LIST.indexOf(b));
  }
  report.items.sort((a, b) =>
    COPY_CLASS_PRIORITY[a.copy_class] - COPY_CLASS_PRIORITY[b.copy_class]
    || a.id.localeCompare(b.id));
  report.owner_judgments = report.items.filter((item) =>
    item.copy_class === "decision_ready" || item.copy_class === "review_carefully");
  report.repair_items = report.items.filter((item) => item.copy_class === "blocked_for_repair");
  report.fyi_receipts = report.items.filter((item) => item.copy_class === "fyi_receipt");
  report.internal_items = report.items.filter((item) => item.copy_class === "internal_only");
}

export function formatPhase2ProposalWorklist(report) {
  const lines = [];
  lines.push(
    `proposal worklist: ${report.owner_judgments.length} owner decision(s), ${report.repair_items.length} repair/setup blocker(s), ${report.fyi_receipts.length} receipt(s)`,
  );
  lines.push("derived from PR markers, local registry rows, scanner health, and read-time facts; no queue is written.");
  appendFormattedGroup(lines, "Owner decisions", report.owner_judgments);
  appendFormattedGroup(lines, "Repair and setup blockers", report.repair_items);
  appendFormattedGroup(lines, "Receipts", report.fyi_receipts);
  return lines;
}

function appendFormattedGroup(lines, title, items) {
  lines.push(title);
  if (items.length === 0) {
    lines.push("  none");
    return;
  }
  for (const item of items) {
    lines.push(`  ${item.headline}`);
    lines.push(`    why: ${item.why_it_matters}`);
    if (item.blocked_by) lines.push(`    blocked: ${item.blocked_by}`);
    if (item.where_to_decide) lines.push(`    where: ${item.where_to_decide}`);
  }
}
