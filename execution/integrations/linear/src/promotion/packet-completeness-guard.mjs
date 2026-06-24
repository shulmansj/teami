import {
  PROMOTION_MARKER_KEY,
  updateMarkerInBody,
} from "./pr-marker.mjs";
import {
  normalizePromotionMarkerPacketFacts,
} from "./proposal-packet-schema.mjs";
import {
  resolveFactoryChangeDisposition,
} from "./factory-change-disposition.mjs";

export const PACKET_COMPLETENESS_GUARD_REASON =
  "packet_completeness_guard_failed";
export const PACKET_COMPLETENESS_REPAIR_STATE =
  "packet_completeness_repair_needed";

export const PACKET_COMPLETENESS_BLOCKED_OWNER_COPY = Object.freeze({
  headline: "Proposal is blocked for repair.",
  consequence:
    "No owner approval should happen from this proposal yet because the review packet is missing decision-critical context.",
  next_safe_action:
    "Repair the packet inputs and rerun promotion; only a proposal whose packet guard passes should be used for owner review.",
});

const BLOCKED_NOTICE_BEGIN = "<!-- agentic_factory_promotion_repair_notice:begin -->";
const BLOCKED_NOTICE_END = "<!-- agentic_factory_promotion_repair_notice:end -->";

export function ownerCopyForPacketCompletenessRepair() {
  return [
    PACKET_COMPLETENESS_BLOCKED_OWNER_COPY.headline,
    PACKET_COMPLETENESS_BLOCKED_OWNER_COPY.consequence,
    `Next safe action: ${PACKET_COMPLETENESS_BLOCKED_OWNER_COPY.next_safe_action}`,
  ].join(" ");
}

export function validatePromotionPacketCompleteness({
  packet,
  requiredEvidenceIdKinds = [],
  deterministicGate = { ok: true },
  prerequisiteFailures = [],
  evidenceAccess = { ok: true },
  classification = null,
  approvalAttempt = null,
} = {}) {
  const failures = [];
  const marker = promotionMarkerPayload(packet?.marker);
  const markerPacket = marker?.packet || {};

  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    failures.push(failure("packet_missing", "The structured proposal packet was not available."));
  }
  if (!nonEmptyString(packet?.consequence_headline)
    || !nonEmptyArray(packet?.what_changes)
    || !nonEmptyArray(packet?.why_suggested)) {
    failures.push(failure(
      "missing_summary",
      "The packet is missing the plain-language summary needed to understand the consequence.",
    ));
  }
  if (!marker) {
    failures.push(failure("missing_marker", "The packet is missing its machine-readable marker."));
  }
  if (!hasSubstantiveBeforeAfter(packet, markerPacket)) {
    failures.push(failure(
      "missing_before_after_example",
      "The packet is missing a concrete before/after example.",
    ));
  }
  if (!hasConcreteRisk(packet, markerPacket)) {
    failures.push(failure(
      "missing_risk_label_or_reason",
      "The packet is missing a deterministic risk label or a concrete risk reason.",
    ));
  }

  const evidenceFailure = requiredEvidenceFailure({
    marker,
    packet,
    requiredEvidenceIdKinds,
  });
  if (evidenceFailure) failures.push(evidenceFailure);

  if (hasLearningLoopClaim(packet) && !hasEvidenceCohort(packet, markerPacket)) {
    failures.push(failure(
      "missing_learning_loop_evidence_cohort",
      "The packet claims machine-drafted learning-loop authorship but lacks a usable evidence cohort summary.",
    ));
  }

  if (bundlesIncompatibleClasses(classification)) {
    failures.push(failure(
      "bundled_incompatible_classes",
      "The proposed change bundles ordinary behavior with governance or authority changes.",
    ));
  }

  const selfApproval = selfApprovalFailure(approvalAttempt);
  if (selfApproval) failures.push(selfApproval);

  if (evidenceAccess?.ok === false) {
    failures.push(failure(
      "inaccessible_required_evidence",
      "Required evidence could not be accessed through the verified resolver.",
      evidenceAccess.reason || evidenceAccess.detail || null,
    ));
  }

  if (deterministicGate?.ok === false) {
    failures.push(failure(
      "internal_deterministic_gate_failed",
      "An internal deterministic gate did not pass.",
      deterministicGate.reason || deterministicGate.detail || null,
    ));
  }

  for (const reason of Array.isArray(prerequisiteFailures) ? prerequisiteFailures : []) {
    if (nonEmptyString(reason)) {
      failures.push(failure(
        "packet_prerequisite_failed",
        "A packet prerequisite did not pass.",
        reason,
      ));
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    status: ok ? "passed" : "blocked",
    reason: ok ? null : PACKET_COMPLETENESS_GUARD_REASON,
    repair_state: ok ? "none" : PACKET_COMPLETENESS_REPAIR_STATE,
    copy_class: ok ? passedCopyClass(markerPacket, packet) : "blocked_for_repair",
    owner_copy: ok ? null : ownerCopyForPacketCompletenessRepair(),
    failed_checks: failures,
  };
}

export function applyPromotionPacketGuardStatus(packet, guardResult) {
  const marker = promotionMarkerPayload(packet?.marker);
  if (!packet || !marker) return packet;
  const currentFacts = marker.packet || {};
  const status = guardResult?.ok ? "passed" : "blocked";
  const packetFacts = normalizePromotionMarkerPacketFacts({
    ...currentFacts,
    source: "structured_packet",
    guard_status: status,
    copy_class: guardResult?.copy_class || (status === "passed"
      ? passedCopyClass(currentFacts, packet)
      : "blocked_for_repair"),
  });
  return {
    ...packet,
    source_of_truth: {
      ...(packet.source_of_truth || {}),
      guard_status: status,
    },
    marker: {
      [PROMOTION_MARKER_KEY]: {
        ...marker,
        proposal_state: status === "blocked" ? "blocked" : marker.proposal_state,
        repair_state: status === "blocked" ? PACKET_COMPLETENESS_REPAIR_STATE : marker.repair_state,
        packet: packetFacts,
      },
    },
  };
}

export function promotionMarkerPacketGuardPassed(marker) {
  const payload = promotionMarkerPayload(marker);
  return Boolean(
    payload
    && payload.proposal_state === "proposed"
    && payload.repair_state === "none"
    && payload.packet?.source === "structured_packet"
    && payload.packet?.guard_status === "passed",
  );
}

export function blockedPacketMarkerPatch(marker = {}) {
  const payload = promotionMarkerPayload(marker) || {};
  return {
    proposal_state: "blocked",
    repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
    packet: normalizePromotionMarkerPacketFacts({
      ...(payload.packet || {}),
      source: "structured_packet",
      guard_status: "blocked",
      copy_class: "blocked_for_repair",
    }),
  };
}

export function markPromotionPrBodyBlockedForRepair({ body, marker, ownerCopy = null } = {}) {
  const updatedMarkerBody = updateMarkerInBody(body, blockedPacketMarkerPatch(marker));
  const withoutPriorNotice = stripBlockedNotice(updatedMarkerBody);
  const notice = [
    BLOCKED_NOTICE_BEGIN,
    `> **Blocked for repair:** ${ownerCopy || ownerCopyForPacketCompletenessRepair()}`,
    BLOCKED_NOTICE_END,
    "",
  ].join("\n");
  return `${notice}${withoutPriorNotice.trimStart()}`;
}

export function promotionPacketGuardRegistryRecord(guardResult) {
  return {
    status: guardResult?.status || "blocked",
    reason: guardResult?.reason || null,
    repair_state: guardResult?.repair_state || null,
    owner_copy: guardResult?.owner_copy || null,
    failed_checks: (guardResult?.failed_checks || []).map((entry) => ({
      id: entry.id,
      message: entry.message,
      ...(entry.detail ? { detail: entry.detail } : {}),
    })),
  };
}

function requiredEvidenceFailure({ marker, packet, requiredEvidenceIdKinds }) {
  const required = new Set(
    (Array.isArray(requiredEvidenceIdKinds) ? requiredEvidenceIdKinds : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  );
  if (required.size === 0) return null;
  const evidence = marker?.evidence_ids || {};
  const missing = [];
  if (required.has("experiment_id") && !nonEmptyArray(evidence.experiments)) {
    missing.push("experiment_id");
  }
  if (required.has("dataset_id")
    && !datasetEntries(evidence).some((entry) => nonEmptyString(entry.dataset_id))) {
    missing.push("dataset_id");
  }
  if (required.has("dataset_version_id")
    && !datasetEntries(evidence).some((entry) => nonEmptyString(entry.dataset_version_id))) {
    missing.push("dataset_version_id");
  }
  if (required.has("annotation_id") && !nonEmptyArray(evidence.annotations)) {
    missing.push("annotation_id");
  }
  const requiredLinkMissing = requiredHasPhoenixLinkRequirement(required)
    && !hasRequiredPhoenixLinks({ packet, evidence, required });
  if (missing.length > 0 || requiredLinkMissing) {
    return failure(
      "missing_required_evidence_links_or_handles",
      "The packet is missing required evidence IDs or safe Phoenix links.",
      [
        ...(missing.length > 0 ? [`missing handles: ${missing.join(", ")}`] : []),
        ...(requiredLinkMissing ? ["missing safe Phoenix evidence link"] : []),
      ].join("; "),
    );
  }
  return null;
}

function hasRequiredPhoenixLinks({ packet, evidence, required }) {
  const links = packet?.optional_depth?.phoenix?.safe_links;
  if (!nonEmptyArray(links)) return false;
  const normalizedLinks = links.map((entry) => String(entry));
  if (required.has("dataset_id")) {
    for (const dataset of datasetEntries(evidence)) {
      if (nonEmptyString(dataset.dataset_id)
        && !normalizedLinks.some((link) =>
          linkContainsPathSegment(link, "/datasets/", dataset.dataset_id))) {
        return false;
      }
    }
  }
  if (required.has("experiment_id")) {
    for (const experimentId of evidence?.experiments || []) {
      if (nonEmptyString(experimentId)
        && !normalizedLinks.some((link) =>
          linkContainsPathSegment(link, "/experiments/", experimentId))) {
        return false;
      }
    }
  }
  return true;
}

function linkContainsPathSegment(link, prefix, id) {
  const raw = `${prefix}${id}`;
  const encoded = `${prefix}${encodeURIComponent(id)}`;
  return link.includes(raw) || link.includes(encoded);
}

function requiredHasPhoenixLinkRequirement(required) {
  return required.has("experiment_id") || required.has("dataset_id") || required.has("dataset_version_id");
}

function datasetEntries(evidence = {}) {
  return Array.isArray(evidence.datasets) ? evidence.datasets : [];
}

function hasSubstantiveBeforeAfter(packet, markerPacket) {
  return markerPacket?.before_after_examples_present === true
    && Array.isArray(packet?.before_after_examples)
    && packet.before_after_examples.some((example) =>
      nonEmptyString(example?.before) && nonEmptyString(example?.after));
}

function hasConcreteRisk(packet, markerPacket) {
  return ["low_risk", "high_risk"].includes(packet?.risk?.deterministic_risk_floor)
    && nonEmptyString(packet?.risk?.concrete_risk_reason)
    && markerPacket?.risk_reason_present === true;
}

function hasEvidenceCohort(packet, markerPacket) {
  return markerPacket?.evidence_cohort_summary_present === true
    && packet?.evidence_cohort_summary?.substantive === true
    && nonEmptyArray(packet?.evidence_cohort_summary?.summary_lines);
}

function hasLearningLoopClaim(packet) {
  return nonEmptyString(packet?.optional_depth?.audit?.machine_authorship)
    || packet?.evidence_cohort_summary?.learning_loop_claim === true;
}

// Consume the demoted view: ordinary bundled with an ADVISORY-ONLY (path/prose)
// factory label is judgeable, NOT bundled_incompatible_classes. Ordinary bundled
// with a GATING factory class — or with unknown_sensitive (never demoted) — still
// fails. The positive commit allowlist remains the ownership gate.
function bundlesIncompatibleClasses(classification = {}) {
  const classes = new Set(Array.isArray(classification?.mixed_classes)
    ? classification.mixed_classes
    : []);
  if (classification?.class) classes.add(classification.class);
  if (!classes.has("ordinary_semantic")) return false;
  if (classes.has("unknown_sensitive")) return true;
  const disposition = resolveFactoryChangeDisposition(classification);
  return disposition.has_gating_factory_class;
}

function selfApprovalFailure(approvalAttempt) {
  if (!approvalAttempt || approvalAttempt.attempted === false) return null;
  const approver = firstNonEmptyString(
    approvalAttempt.approver_id,
    approvalAttempt.approval_actor_id,
    approvalAttempt.actor_id,
  );
  const author = firstNonEmptyString(
    approvalAttempt.author_id,
    approvalAttempt.candidate_author_id,
    approvalAttempt.drafted_by,
  );
  if (approver && author && approver === author) {
    return failure(
      "self_approval_attempt",
      "The packet tries to let the candidate author approve its own behavior change.",
    );
  }
  return null;
}

function passedCopyClass(markerPacket, packet) {
  if (markerPacket?.deterministic_risk_floor === "high_risk"
    || markerPacket?.deterministic_risk_floor === "unknown"
    || packet?.risk?.deterministic_risk_floor === "high_risk") {
    return "review_carefully";
  }
  return "decision_ready";
}

function promotionMarkerPayload(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  if (marker[PROMOTION_MARKER_KEY] && typeof marker[PROMOTION_MARKER_KEY] === "object") {
    return marker[PROMOTION_MARKER_KEY];
  }
  return marker;
}

function stripBlockedNotice(body) {
  const text = String(body ?? "");
  const pattern = new RegExp(
    `${escapeRegExp(BLOCKED_NOTICE_BEGIN)}[\\s\\S]*?${escapeRegExp(BLOCKED_NOTICE_END)}\\s*`,
    "g",
  );
  return text.replace(pattern, "");
}

function failure(id, message, detail = null) {
  return { id, message, ...(detail ? { detail } : {}) };
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.some((entry) => {
    if (typeof entry === "string") return entry.trim() !== "";
    return entry !== null && entry !== undefined;
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (nonEmptyString(value)) return value.trim();
  }
  return "";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
