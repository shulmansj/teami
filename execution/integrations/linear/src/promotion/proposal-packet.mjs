import { findTokenShapedContent } from "../eval-content-gate.mjs";
import {
  PROMOTION_MARKER_KEY,
  escapeGitHubMarkdownProse,
  parsePromotionMarkers,
  renderPromotionMarkerBlock,
} from "./pr-marker.mjs";
import {
  PROPOSAL_PACKET_SCHEMA_VERSION,
  normalizePromotionMarkerPacketFacts,
} from "./proposal-packet-schema.mjs";

const EXCERPT_CHAR_LIMIT = 4000;
const PROMPT_INJECTION_EXFILTRATION_PATTERN =
  /\b(ignore (?:all )?(?:previous|prior) instructions|exfiltrat\w*|reveal (?:the )?(?:secret|token|credential)|print (?:the )?(?:secret|token|credential)|send (?:the )?(?:secret|token|credential))\b/i;

const EVIDENCE_COUNT_LABELS = Object.freeze({
  train_examples: "training examples",
  train_human_labeled_examples: "human-labeled training examples",
  test_examples: "held-out test examples",
  test_human_labeled_examples: "human-labeled held-out test examples",
  human_label_authenticity: "human label authenticity",
  annotations_low_confidence: "low-confidence annotations",
});

const EVIDENCE_COUNT_KEY_ORDER = Object.freeze([
  "train_examples",
  "train_human_labeled_examples",
  "test_examples",
  "test_human_labeled_examples",
  "human_label_authenticity",
  "annotations_low_confidence",
]);

export function buildPromotionProposalPacket({
  target,
  marker,
  humanSummary,
  gateFacts,
  evidenceQualityLabel,
  promotionRiskLabel,
  evidenceSummaryLines,
  sanitizerReport,
  disagreementDisclosure,
  candidateContentExcerpt,
  phoenixDeepLinks,
  machineAuthorship,
  prProvenance,
  allowedOriginPrefix,
} = {}) {
  const markerPayload = promotionMarkerPayload(marker);
  const riskFloor = normalizeRiskFloor(labelValue(promotionRiskLabel));
  const evidenceQuality = normalizeEvidenceQuality(labelValue(evidenceQualityLabel));
  const beforeAfter = buildBeforeAfterExamples({ target, humanSummary });
  const beforeAfterExamples = beforeAfter.examples;
  const evidenceCohortSummary = buildEvidenceCohortSummary({
    gateFacts,
    evidenceSummaryLines,
    evidenceQuality,
  });
  const riskReason = concreteRiskReason({ promotionRiskLabel, riskFloor });
  const risk = {
    deterministic_risk_floor: riskFloor,
    evidence_quality: evidenceQuality,
    concrete_risk_reason: riskReason.text,
    safe_default: safeDefaultForRiskFloor(riskFloor),
  };
  const authorityCustodyAccess = buildAuthorityCustodyAccess(humanSummary);
  const undoBounds = buildUndoBounds();
  const declinePath = {
    owner_action: "Close or decline the proposal PR.",
    result: "The accepted factory behavior does not change.",
    repeat_policy: "The same idea should return only if materially new evidence appears.",
  };
  const deepLinks = filterPhoenixDeepLinks({
    phoenixDeepLinks,
    allowedOriginPrefix: firstNonEmptyString(allowedOriginPrefix, target?.phoenix_origin),
  });
  const markerPacketFacts = normalizePromotionMarkerPacketFacts({
    source: "structured_packet",
    guard_status: "not_evaluated",
    copy_class: riskFloor === "low_risk" ? "decision_ready" : "review_carefully",
    deterministic_risk_floor: riskFloor,
    risk_reason_present: riskReason.substantive,
    evidence_cohort_summary_present: evidenceCohortSummary.substantive,
    before_after_examples_present: beforeAfter.substantive,
    // B-UNDO: reflect real presence — the durable undo frame lives on the
    // marker (`marker.undo_bounds`), so this fact mirrors that rather than being
    // a write-only always-true boolean.
    undo_bounds_present: Boolean(markerPayload?.undo_bounds),
    authority_custody_access_present: Boolean(authorityCustodyAccess.applies),
  });
  const enrichedMarker = withPromotionMarkerPacketFacts(marker, markerPacketFacts);
  return {
    schema_version: PROPOSAL_PACKET_SCHEMA_VERSION,
    packet_use: "live_candidate_render_source",
    source_of_truth: {
      guard_reads: "structured_packet_object",
      markdown_role: "rendered_review_copy_only",
      guard_status: "not_evaluated",
    },
    proposal_identity: {
      proposal_instance_id: markerPayload?.proposal_instance_id ?? null,
      candidate_target_key: markerPayload?.candidate_target_key ?? null,
      candidate_kind: markerPayload?.candidate_kind ?? null,
    },
    consequence_headline: buildConsequenceHeadline({ target, humanSummary, riskFloor }),
    what_changes: buildWhatChanges({ target, humanSummary }),
    why_suggested: buildWhySuggested({ gateFacts, evidenceSummaryLines }),
    before_after_examples: beforeAfterExamples,
    evidence_cohort_summary: evidenceCohortSummary,
    risk,
    authority_custody_access: authorityCustodyAccess,
    undo_bounds: undoBounds,
    decline_path: declinePath,
    pr_provenance: normalizePrProvenance(prProvenance),
    marker: enrichedMarker,
    optional_depth: {
      phoenix: {
        available: deepLinks.rendered.length > 0,
        safe_links: deepLinks.rendered,
        dropped_link_count: deepLinks.dropped,
        note:
          "Optional local evidence depth may help inspection, but the packet must remain understandable without it.",
      },
      technical_change: buildTechnicalChangeDepth({ humanSummary }),
      audit: {
        machine_authorship: nonEmptyString(machineAuthorship) ? String(machineAuthorship).trim() : null,
        candidate_content_excerpt: renderCandidateContentExcerpt(candidateContentExcerpt),
        sanitizer_report: sanitizerReport ?? null,
        disagreement_disclosure: disagreementDisclosure ?? null,
      },
    },
  };
}

export function renderPromotionProposalPacketMarkdown(packet) {
  const lines = [];
  lines.push("## Consequence");
  lines.push("");
  lines.push(prose(packet?.consequence_headline ?? "A factory behavior change is ready for owner review."));
  lines.push("");

  lines.push("## What changes");
  lines.push("");
  lines.push(...renderList(packet?.what_changes));
  lines.push("");

  lines.push("## Why suggested");
  lines.push("");
  lines.push(...renderList(packet?.why_suggested));
  lines.push("");

  lines.push("## Before and after examples");
  lines.push("");
  for (const example of packet?.before_after_examples || []) {
    lines.push(`- ${prose(example.label ?? "Example")}: Before: ${prose(example.before)} After: ${prose(example.after)}`);
  }
  if (!Array.isArray(packet?.before_after_examples) || packet.before_after_examples.length === 0) {
    lines.push("- No before/after example was provided.");
  }
  lines.push("");

  lines.push("## Evidence cohort summary");
  lines.push("");
  lines.push(...renderEvidenceCohortSummary(packet?.evidence_cohort_summary));
  lines.push("");

  lines.push("## Risk and safe default");
  lines.push("");
  lines.push(`- Deterministic risk floor: ${prose(friendlyRiskFloor(packet?.risk?.deterministic_risk_floor))}`);
  lines.push(`- Evidence quality: ${prose(packet?.risk?.evidence_quality ?? "unknown")} (deterministic advisory).`);
  lines.push(`- Concrete risk reason: ${prose(packet?.risk?.concrete_risk_reason ?? "Risk facts were not available.")}`);
  lines.push(`- Safe default: ${prose(packet?.risk?.safe_default ?? "Decline or wait when unsure; nothing changes without approval.")}`);
  if (nonEmptyString(packet?.optional_depth?.audit?.machine_authorship)) {
    lines.push(`- Machine-drafted candidate (${prose(packet.optional_depth.audit.machine_authorship)})`);
  }
  lines.push("");

  lines.push("## Authority and custody access");
  lines.push("");
  lines.push(...renderAuthorityCustodyAccess(packet?.authority_custody_access));
  lines.push("");

  lines.push("## Undo and decline");
  lines.push("");
  lines.push(...renderUndoBounds(packet?.undo_bounds));
  lines.push(`- Decline path: ${prose(packet?.decline_path?.owner_action ?? "Close or decline the proposal PR.")} ${prose(packet?.decline_path?.result ?? "The accepted behavior does not change.")}`);
  if (packet?.decline_path?.repeat_policy) {
    lines.push(`- Repeat policy: ${prose(packet.decline_path.repeat_policy)}`);
  }
  lines.push("");

  const provenance = renderPrProvenance(packet?.pr_provenance);
  if (provenance.length > 0) {
    lines.push("## Provenance");
    lines.push("");
    lines.push(...provenance);
    lines.push("");
  }

  lines.push("## Machine-readable marker");
  lines.push("");
  lines.push(renderPromotionMarkerBlock(packet?.marker));

  const optionalDepth = renderOptionalDepth(packet?.optional_depth);
  if (optionalDepth.length > 0) {
    lines.push("");
    lines.push(...optionalDepth);
  }

  const body = lines.join("\n");
  const markers = parsePromotionMarkers(body);
  if (markers.length !== 1) {
    throw new Error(`promotion_pr_body_marker_count:${markers.length}`);
  }
  const nonRecordablePaths = findTokenShapedContent({ promotionPrBody: body });
  if (nonRecordablePaths.length > 0) {
    throw new Error(`promotion_pr_body_contains_non_recordable_content:${nonRecordablePaths.join(",")}`);
  }
  return body;
}

export function withPromotionMarkerPacketFacts(marker, packetFacts = {}) {
  const payload = promotionMarkerPayload(marker);
  const normalized = normalizePromotionMarkerPacketFacts(packetFacts);
  if (!payload) {
    throw new Error("promotion_marker_missing_for_packet_facts");
  }
  return {
    [PROMOTION_MARKER_KEY]: {
      ...payload,
      packet: normalized,
    },
  };
}

function promotionMarkerPayload(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  if (marker[PROMOTION_MARKER_KEY] && typeof marker[PROMOTION_MARKER_KEY] === "object") {
    return marker[PROMOTION_MARKER_KEY];
  }
  return marker;
}

function buildConsequenceHeadline({ target, humanSummary, riskFloor } = {}) {
  const name = targetName(target);
  if (humanSummary?.kind === "runtime_role_defaults") {
    return `${name} will use new default role assignments after approval.`;
  }
  if (riskFloor === "high_risk") {
    return `${name} would change accepted factory behavior; review the evidence and safe default carefully before approval.`;
  }
  return `${name} would change accepted factory behavior after owner approval.`;
}

function buildWhatChanges({ target, humanSummary } = {}) {
  const name = targetName(target);
  if (humanSummary?.kind === "runtime_role_defaults") {
    const changes = runtimeRoleDefaultChanges(humanSummary);
    const lines = changes.length === 0
      ? [`Default role assignments for ${name} change after approval.`]
      : changes.map((change) =>
      `${change.role}.${change.field} changes from ${change.old} to ${change.new}.`);
    lines.push(`Disclosure: ${runtimeRoleDisclosure(humanSummary)}`);
    return lines;
  }
  const lines = [`Accepted behavior for ${name} changes only if this proposal is approved.`];
  const added = headingList(humanSummary?.added_markdown_section_headings);
  const removed = headingList(humanSummary?.removed_markdown_section_headings);
  if (added.length > 0) lines.push(`Adds reviewer-visible guidance: ${added.join("; ")}.`);
  if (removed.length > 0) lines.push(`Removes reviewer-visible guidance: ${removed.join("; ")}.`);
  if (added.length === 0 && removed.length === 0) {
    lines.push("The behavior files change, with file-level detail left to optional technical review.");
  }
  return lines;
}

function buildWhySuggested({ gateFacts, evidenceSummaryLines } = {}) {
  const lines = [];
  const verdict = gateFacts?.verdict;
  if (verdict === "pass") {
    lines.push("Deterministic evaluation found enough supporting evidence to ask for owner review.");
  } else if (verdict === "fail") {
    lines.push("Deterministic evaluation did not pass; treat this as repair or extra-review evidence, not approval-ready proof.");
  } else if (nonEmptyString(verdict)) {
    lines.push("Deterministic evaluation returned an unrecognized result; review carefully before taking action.");
  } else {
    lines.push("The proposal includes an evidence summary, but the deterministic evaluation result was not available.");
  }
  for (const line of Array.isArray(evidenceSummaryLines) ? evidenceSummaryLines.slice(0, 4) : []) {
    if (nonEmptyString(line)) lines.push(String(line));
  }
  return lines;
}

function buildBeforeAfterExamples({ target, humanSummary } = {}) {
  if (Array.isArray(humanSummary?.before_after_examples) && humanSummary.before_after_examples.length > 0) {
    const examples = humanSummary.before_after_examples
      .filter((example) => example && typeof example === "object")
      .map((example) => ({
        label: firstNonEmptyString(example.label, targetName(target)),
        before: firstNonEmptyString(example.before, "No before state was supplied."),
        after: firstNonEmptyString(example.after, "No after state was supplied."),
      }));
    return { examples, substantive: examples.length > 0 };
  }
  if (humanSummary?.kind === "runtime_role_defaults") {
    const examples = runtimeRoleDefaultChanges(humanSummary).map((change) => ({
      label: `${change.role}.${change.field}`,
      before: `${change.role}.${change.field} used ${change.old}.`,
      after: `${change.role}.${change.field} uses ${change.new}.`,
    }));
    return { examples, substantive: examples.length > 0 };
  }
  const added = headingList(humanSummary?.added_markdown_section_headings);
  const removed = headingList(humanSummary?.removed_markdown_section_headings);
  if (added.length > 0 || removed.length > 0) {
    return { examples: [{
      label: `${targetName(target)} guidance`,
      before: removed.length > 0
        ? `The accepted behavior included ${removed.join("; ")}.`
        : "The accepted behavior did not include the newly proposed guidance.",
      after: added.length > 0
        ? `The accepted behavior includes ${added.join("; ")}.`
        : "The proposed behavior removes the listed guidance.",
    }], substantive: true };
  }
  if (
    nonEmptyString(humanSummary?.old_pinned_version_id)
    || nonEmptyString(humanSummary?.new_pinned_version_id)
    || Number.isFinite(humanSummary?.old_line_count)
    || Number.isFinite(humanSummary?.new_line_count)
  ) {
    return { examples: [{
      label: `${targetName(target)} accepted prompt`,
      before: `The accepted prompt used ${firstNonEmptyString(humanSummary?.old_pinned_version_id, "the prior pinned version")} with ${humanSummary?.old_line_count ?? "unknown"} line(s).`,
      after: `The accepted prompt would use ${firstNonEmptyString(humanSummary?.new_pinned_version_id, "the candidate version")} with ${humanSummary?.new_line_count ?? "unknown"} line(s).`,
    }], substantive: true };
  }
  return { examples: [{
    label: targetName(target),
    before: "The factory used the currently accepted behavior for this area.",
    after: "The factory would use the candidate behavior proposed in this PR.",
  }], substantive: false };
}

function buildEvidenceCohortSummary({ gateFacts, evidenceSummaryLines, evidenceQuality } = {}) {
  const counts = evidenceCounts(gateFacts?.evidence_counts);
  const summaryLines = (Array.isArray(evidenceSummaryLines) ? evidenceSummaryLines : [])
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const lineage = normalizeEvidenceLineage(gateFacts?.evidence_lineage);
  return {
    evidence_quality: evidenceQuality,
    counts,
    lineage,
    substantive: counts.length > 0 || summaryLines.length > 0 || lineage.substantive,
    summary_lines: summaryLines.length > 0
      ? summaryLines
      : ["No standalone evidence summary lines were supplied."],
  };
}

function buildAuthorityCustodyAccess(humanSummary = {}) {
  const declared = humanSummary?.authority_custody_access;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    return {
      applies: Boolean(declared.applies),
      before: stringList(declared.before),
      after: stringList(declared.after),
      safe_default: firstNonEmptyString(
        declared.safe_default,
        "Decline or wait if any access or custody expansion is unclear.",
      ),
    };
  }
  return {
    applies: false,
    before: ["This packet did not declare a repo, Linear, credential, or evidence-custody access change."],
    after: ["No after-state access or custody guarantee is made without an explicit declaration."],
    safe_default: "Decline or wait if any access or custody effect is unclear.",
  };
}

function buildUndoBounds() {
  return {
    before_approval: "Closing or declining the PR changes nothing in accepted factory behavior.",
    after_approval:
      "Undo requires a follow-up owner-reviewed proposal or a manual revert of accepted behavior; this packet does not claim full rollback automation.",
    cannot_undo: [
      "Evidence and proposal history already recorded for review remain as history.",
      "If future runs consume an approved behavior before undo, those downstream effects need separate review.",
    ],
  };
}

function buildTechnicalChangeDepth({ humanSummary } = {}) {
  if (humanSummary?.kind === "runtime_role_defaults") {
    return runtimeRoleDefaultChanges(humanSummary).map((change) => ({
      label: `${change.role}.${change.field}`,
      before: change.old,
      after: change.new,
    }));
  }
  return {
    old_pinned_version_id: humanSummary?.old_pinned_version_id ?? null,
    new_pinned_version_id: humanSummary?.new_pinned_version_id ?? null,
    old_snapshot_sha256_12: humanSummary?.old_snapshot_sha256_12 ?? null,
    new_snapshot_sha256_12: humanSummary?.new_snapshot_sha256_12 ?? null,
    old_line_count: finiteOrNull(humanSummary?.old_line_count),
    new_line_count: finiteOrNull(humanSummary?.new_line_count),
    old_byte_size: finiteOrNull(humanSummary?.old_byte_size),
    new_byte_size: finiteOrNull(humanSummary?.new_byte_size),
  };
}

function renderEvidenceCohortSummary(summary = {}) {
  const lines = [];
  const countLine = renderEvidenceCounts(summary.counts);
  if (countLine) lines.push(`- Cohort: ${countLine}.`);
  for (const line of Array.isArray(summary.summary_lines) ? summary.summary_lines : []) {
    lines.push(`- ${prose(line)}`);
  }
  lines.push(...renderEvidenceLineage(summary.lineage));
  if (lines.length === 0) return ["- No evidence cohort summary was provided."];
  return lines;
}

function renderEvidenceLineage(lineage = {}) {
  if (!lineage?.substantive) return [];
  const lines = [];
  if (lineage.run_window?.from || lineage.run_window?.to) {
    lines.push(`- Run window: ${prose(lineage.run_window.from ?? "unknown")} to ${prose(lineage.run_window.to ?? "unknown")} (${prose(lineage.run_window.basis ?? "recorded lineage")}).`);
  }
  if (lineage.run_set_digest) {
    lines.push(`- Run-set digest: ${prose(lineage.run_set_digest)}.`);
  }
  if (lineage.selection_rule?.inclusion || lineage.selection_rule?.split_selection) {
    const included = Array.isArray(lineage.selection_rule.included_example_ids)
      ? lineage.selection_rule.included_example_ids.join(", ")
      : "";
    lines.push(`- Selection rule: ${prose(lineage.selection_rule.inclusion ?? "recorded selection")} Split selection: ${prose(lineage.selection_rule.split_selection ?? "unknown")}${included ? `; included examples: ${prose(included)}` : ""}.`);
  }
  const representatives = Array.isArray(lineage.representative_traces)
    ? lineage.representative_traces
    : [];
  if (representatives.length > 0) {
    lines.push(`- Representative traces: ${prose(representatives.map((entry) => {
      const handles = [
        entry.source_trace_id ? `source_trace=${entry.source_trace_id}` : null,
        entry.eval_trace_id ? `eval_trace=${entry.eval_trace_id}` : null,
      ].filter(Boolean).join(" ");
      return `${entry.example_id ?? "unknown"}${entry.split ? `/${entry.split}` : ""}${handles ? ` (${handles})` : ""}`;
    }).join("; "))}.`);
  }
  const nonRegression = lineage.counterexamples_non_regressions;
  if (nonRegression?.summary) {
    const regressions = Array.isArray(nonRegression.score_regressions)
      ? nonRegression.score_regressions.length
      : 0;
    const degradations = Array.isArray(nonRegression.human_label_degradations)
      ? nonRegression.human_label_degradations.length
      : 0;
    lines.push(`- Counterexamples/non-regressions: ${prose(nonRegression.summary)} (${degradations} human-label degradation(s), ${regressions} score regression(s)).`);
  }
  const provenance = lineage.annotation_provenance;
  if (provenance) {
    const humanIds = Array.isArray(provenance.human_annotation_ids)
      ? provenance.human_annotation_ids.join(", ")
      : "";
    lines.push(`- Annotation provenance: ${prose(provenance.llm_evaluation_count ?? 0)} LLM evaluation(s), ${prose(provenance.code_evaluation_count ?? 0)} CODE evaluation(s)${humanIds ? `, human annotations: ${prose(humanIds)}` : ""}.`);
  }
  const teams = Array.isArray(lineage.affected_teams) ? lineage.affected_teams : [];
  lines.push(`- Affected teams: ${prose(teams.length > 0
    ? teams.map((team) => team.name || team.key || "unknown").join(", ")
    : "not recorded")}.`);
  const handles = lineage.safe_phoenix_handles;
  if (handles) {
    const handleParts = [
      handles.experiment_id ? `experiment ${handles.experiment_id}` : null,
      handles.dataset_id ? `dataset ${handles.dataset_id}${handles.dataset_version_id ? ` version ${handles.dataset_version_id}` : ""}` : null,
      handles.baseline_experiment_id ? `baseline ${handles.baseline_experiment_id}` : null,
    ].filter(Boolean);
    if (handleParts.length > 0) {
      lines.push(`- Safe Phoenix evidence handles: ${prose(handleParts.join("; "))}.`);
    }
  }
  return lines;
}

function normalizeEvidenceLineage(lineage) {
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
    return { substantive: false };
  }
  return {
    schema_version: lineage.schema_version ?? null,
    run_window: objectOrNull(lineage.run_window),
    run_set_digest: nonEmptyString(lineage.run_set_digest) ? lineage.run_set_digest : null,
    selection_rule: objectOrNull(lineage.selection_rule),
    representative_traces: arrayOfObjects(lineage.representative_traces),
    counterexamples_non_regressions: objectOrNull(lineage.counterexamples_non_regressions),
    annotation_provenance: objectOrNull(lineage.annotation_provenance),
    affected_teams: arrayOfObjects(lineage.affected_teams),
    safe_phoenix_handles: objectOrNull(lineage.safe_phoenix_handles),
    substantive: Boolean(
      lineage.run_set_digest
      || lineage.run_window
      || (Array.isArray(lineage.representative_traces) && lineage.representative_traces.length > 0)
      || (Array.isArray(lineage.affected_teams) && lineage.affected_teams.length > 0)
      || lineage.safe_phoenix_handles
    ),
  };
}

function renderAuthorityCustodyAccess(access = {}) {
  const lines = [];
  const applies = Boolean(access.applies);
  lines.push(`- Access or custody change: ${applies ? "yes, review the before/after plainly" : "none declared"}.`);
  for (const before of stringList(access.before)) lines.push(`- Before: ${prose(before)}`);
  for (const after of stringList(access.after)) lines.push(`- After: ${prose(after)}`);
  if (access.safe_default) lines.push(`- Safe default: ${prose(access.safe_default)}`);
  return lines;
}

function renderUndoBounds(bounds = {}) {
  const lines = [];
  if (bounds.before_approval) lines.push(`- Before approval: ${prose(bounds.before_approval)}`);
  if (bounds.after_approval) lines.push(`- After approval: ${prose(bounds.after_approval)}`);
  for (const item of stringList(bounds.cannot_undo)) {
    lines.push(`- Cannot undo automatically: ${prose(item)}`);
  }
  if (lines.length === 0) return ["- Undo bounds were not supplied."];
  return lines;
}

function renderPrProvenance(provenance = null) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return [];
  const lines = [`- Source run: ${prose(provenance.source_run_id ?? "unknown")}.`];
  if (provenance.experiment_receipt_id) {
    lines.push(`- Experiment receipt: ${prose(provenance.experiment_receipt_id)}.`);
  }
  if (provenance.phoenix_experiment_id) {
    lines.push(`- Phoenix experiment: ${prose(provenance.phoenix_experiment_id)}.`);
  }
  if (provenance.proposal_instance_id || provenance.normalized_envelope_hash) {
    const parts = [
      provenance.proposal_instance_id ? `proposal ${provenance.proposal_instance_id}` : null,
      provenance.normalized_envelope_hash ? `envelope ${provenance.normalized_envelope_hash}` : null,
    ].filter(Boolean);
    lines.push(`- Promotion identity: ${prose(parts.join("; "))}.`);
  }
  if (provenance.github_auth_mode || provenance.push_auth) {
    const parts = [
      provenance.github_auth_mode ? `GitHub mode ${provenance.github_auth_mode}` : null,
      provenance.push_auth ? `push auth ${provenance.push_auth}` : null,
    ].filter(Boolean);
    lines.push(`- GitHub write custody: ${prose(parts.join("; "))}.`);
  }
  return lines;
}

function renderOptionalDepth(optionalDepth = {}) {
  const lines = [];
  const evidenceDepth = renderEvidenceDepth(optionalDepth.phoenix);
  if (evidenceDepth.length > 0) {
    lines.push("<details><summary>Optional evidence depth</summary>");
    lines.push("");
    lines.push(...evidenceDepth);
    lines.push("");
    lines.push("</details>");
  }
  const technicalDepth = renderTechnicalChangeDepth(optionalDepth.technical_change);
  if (technicalDepth.length > 0) {
    lines.push("");
    lines.push("<details><summary>Optional technical change detail</summary>");
    lines.push("");
    lines.push(...technicalDepth);
    lines.push("");
    lines.push("</details>");
  }
  const auditDepth = renderAuditDetails(optionalDepth.audit);
  if (auditDepth.length > 0) {
    lines.push("");
    lines.push("<details><summary>Audit details</summary>");
    lines.push("");
    lines.push(...auditDepth);
    lines.push("</details>");
  }
  return lines.filter((line, index, array) => !(line === "" && array[index - 1] === ""));
}

function renderEvidenceDepth(phoenix = {}) {
  const lines = [];
  if (Array.isArray(phoenix.safe_links)) {
    for (const link of phoenix.safe_links) {
      lines.push(`- Phoenix deep link: ${link}`);
    }
  }
  if (Number.isFinite(phoenix.dropped_link_count) && phoenix.dropped_link_count > 0) {
    lines.push(`- Sanitizer note: dropped ${phoenix.dropped_link_count} Phoenix deep link(s) failing allowed origin prefix.`);
  }
  if (phoenix.note && (lines.length > 0 || phoenix.available)) {
    lines.push(`- Note: ${prose(phoenix.note)}`);
  }
  return lines;
}

function renderTechnicalChangeDepth(depth) {
  if (!depth) return [];
  if (Array.isArray(depth)) {
    return depth.map((row) => `- ${prose(row.label)}: ${prose(row.before)} -> ${prose(row.after)}`);
  }
  if (typeof depth !== "object" || Array.isArray(depth)) return [];
  const lines = [];
  if (depth.old_pinned_version_id || depth.new_pinned_version_id) {
    lines.push(`- Accepted version: ${prose(depth.old_pinned_version_id ?? "unknown")} -> ${prose(depth.new_pinned_version_id ?? "unknown")}`);
  }
  if (depth.old_snapshot_sha256_12 || depth.new_snapshot_sha256_12) {
    lines.push(`- Snapshot sha12: ${prose(depth.old_snapshot_sha256_12 ?? "unknown")} -> ${prose(depth.new_snapshot_sha256_12 ?? "unknown")}`);
  }
  if (depth.old_line_count !== null || depth.new_line_count !== null) {
    lines.push(`- Line count: ${prose(depth.old_line_count ?? "unknown")} -> ${prose(depth.new_line_count ?? "unknown")}`);
  }
  if (depth.old_byte_size !== null || depth.new_byte_size !== null) {
    lines.push(`- Byte size: ${prose(depth.old_byte_size ?? "unknown")} -> ${prose(depth.new_byte_size ?? "unknown")}`);
  }
  lines.push("- Raw file diff is optional technical depth in the PR files view; it is not required to understand the packet.");
  return lines;
}

function renderAuditDetails(audit = {}) {
  const lines = [];
  const excerpt = audit.candidate_content_excerpt;
  if (excerpt && excerpt.text !== "") {
    lines.push("Candidate content excerpt:");
    lines.push("");
    if (excerpt.omittedForCustody) {
      lines.push(excerpt.text);
    } else {
      lines.push("```text");
      lines.push(excerpt.text);
      lines.push("```");
    }
    if (excerpt.truncated) {
      lines.push(`Excerpt truncated after ${EXCERPT_CHAR_LIMIT} character(s); ${excerpt.omitted} character(s) omitted.`);
    }
    lines.push("");
  }
  if (audit.sanitizer_report !== undefined && audit.sanitizer_report !== null) {
    lines.push("Sanitizer report:");
    lines.push("");
    lines.push(...renderSanitizerReport(audit.sanitizer_report));
    lines.push("");
  }
  if (audit.disagreement_disclosure !== undefined && audit.disagreement_disclosure !== null) {
    lines.push("Disagreement disclosure:");
    lines.push("");
    lines.push(...renderEscapedList(audit.disagreement_disclosure));
    lines.push("");
  }
  return lines;
}

function renderList(value) {
  const list = stringList(value);
  return list.length > 0 ? list.map((item) => `- ${prose(item)}`) : ["- none"];
}

function renderEvidenceCounts(counts = []) {
  if (!Array.isArray(counts) || counts.length === 0) return "";
  return counts.map((entry) => `${prose(entry.label)}=${prose(entry.value)}`).join("; ");
}

function evidenceCounts(evidenceCountsValue = {}) {
  if (!evidenceCountsValue || typeof evidenceCountsValue !== "object" || Array.isArray(evidenceCountsValue)) {
    return [];
  }
  const keys = [
    ...EVIDENCE_COUNT_KEY_ORDER.filter((key) => Object.hasOwn(evidenceCountsValue, key)),
    ...Object.keys(evidenceCountsValue)
      .filter((key) => !EVIDENCE_COUNT_KEY_ORDER.includes(key))
      .sort(),
  ];
  return keys.map((key) => ({
    key,
    label: EVIDENCE_COUNT_LABELS[key] ?? key.replaceAll("_", " "),
    value: evidenceCountsValue[key],
  }));
}

function normalizeRiskFloor(value) {
  if (value === "low_risk") return "low_risk";
  if (value === "high_risk") return "high_risk";
  if (value === "unknown") return "unknown";
  return "unknown";
}

function friendlyRiskFloor(value) {
  if (value === "low_risk") return "Low risk, still owner-reviewed";
  if (value === "high_risk") return "High risk - review carefully";
  return "High risk - not enough deterministic risk facts";
}

function normalizeEvidenceQuality(value) {
  return ["high", "medium", "low"].includes(value) ? value : "low";
}

function concreteRiskReason({ promotionRiskLabel, riskFloor } = {}) {
  if (promotionRiskLabel && typeof promotionRiskLabel === "object" && nonEmptyString(promotionRiskLabel.explanation)) {
    return { text: promotionRiskLabel.explanation, substantive: true };
  }
  if (riskFloor === "low_risk") {
    return {
      text: "Deterministic risk facts did not surface a high-risk trigger, but the owner still decides whether the behavior fits their intent.",
      substantive: false,
    };
  }
  if (riskFloor === "high_risk") {
    return {
      text: "Deterministic risk facts classify this as high risk or were incomplete; review the consequence and evidence before approving.",
      substantive: false,
    };
  }
  return {
    text: "Deterministic risk facts were missing; review as high risk until the facts are repaired.",
    substantive: false,
  };
}

function safeDefaultForRiskFloor(riskFloor) {
  if (riskFloor === "low_risk") {
    return "Decline if this does not match your intent; nothing changes unless you approve.";
  }
  return "Decline or wait when unsure; nothing changes unless you approve.";
}

function runtimeRoleDefaultChanges(humanSummary = {}) {
  return (Array.isArray(humanSummary.changes) ? humanSummary.changes : [])
    .filter((change) =>
      change
      && typeof change === "object"
      && typeof change.role === "string"
      && typeof change.field === "string")
    .map((change) => ({
      role: change.role,
      field: change.field,
      old: change.old ?? "unknown",
      new: change.new ?? "unknown",
    }));
}

function runtimeRoleDisclosure(humanSummary = {}) {
  return nonEmptyString(humanSummary.disclosure)
    ? humanSummary.disclosure
    : "Adopters without explicit role overrides change behavior when this merges.";
}

function headingList(headings) {
  if (!Array.isArray(headings)) return [];
  return headings
    .map((heading) => String(heading ?? "").replace(/^#+\s*/, "").trim())
    .filter(Boolean);
}

function filterPhoenixDeepLinks({ phoenixDeepLinks, allowedOriginPrefix } = {}) {
  const rendered = [];
  let dropped = 0;
  const prefix = firstNonEmptyString(allowedOriginPrefix);
  for (const raw of Array.isArray(phoenixDeepLinks) ? phoenixDeepLinks : []) {
    const link = String(raw ?? "").trim();
    if (!prefix || !link.startsWith(prefix) || !isPlainTextUrlSafe(link)) {
      dropped += 1;
      continue;
    }
    rendered.push(link);
  }
  return { rendered, dropped };
}

function isPlainTextUrlSafe(link) {
  return !/[\s<>\u0000-\u001f\u007f`]/.test(link);
}

function renderCandidateContentExcerpt(candidateContentExcerpt) {
  if (candidateContentExcerpt === undefined || candidateContentExcerpt === null || String(candidateContentExcerpt) === "") {
    return { text: "", truncated: false, omitted: 0, omittedForCustody: false };
  }
  const raw = String(candidateContentExcerpt);
  const omissionReason = candidateExcerptCustodyOmissionReason(raw);
  if (omissionReason) {
    return {
      text: `[omitted: ${omissionReason}]`,
      truncated: false,
      omitted: raw.length,
      omittedForCustody: true,
    };
  }
  const truncated = raw.length > EXCERPT_CHAR_LIMIT;
  const capped = truncated ? raw.slice(0, EXCERPT_CHAR_LIMIT) : raw;
  return {
    text: prose(capped),
    truncated,
    omitted: truncated ? raw.length - EXCERPT_CHAR_LIMIT : 0,
    omittedForCustody: false,
  };
}

function candidateExcerptCustodyOmissionReason(raw) {
  if (findTokenShapedContent({ candidateContentExcerpt: raw }).length > 0) {
    return "candidate excerpt contained non-recordable credential-shaped content";
  }
  if (PROMPT_INJECTION_EXFILTRATION_PATTERN.test(raw)) {
    return "candidate excerpt contained an exfiltration instruction";
  }
  return null;
}

function renderSanitizerReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return renderEscapedList(report);
  }
  const lines = [
    `- content_gate_version: ${prose(report.content_gate_version ?? "unknown")}`,
    `- removed_count: ${prose(report.removed_count ?? 0)}`,
    `- transformed_count: ${prose(report.transformed_count ?? 0)}`,
  ];
  for (const entry of Array.isArray(report.removed) ? report.removed : []) {
    lines.push(`- removed: path=${prose(entry?.path ?? "unknown")} rule=${prose(entry?.rule ?? "unknown")}`);
  }
  for (const entry of Array.isArray(report.transformed) ? report.transformed : []) {
    const detail = entry?.detail === undefined ? "" : ` detail=${prose(entry.detail)}`;
    lines.push(`- transformed: path=${prose(entry?.path ?? "unknown")} rule=${prose(entry?.rule ?? "unknown")}${detail}`);
  }
  return lines;
}

function renderEscapedList(value) {
  if (Array.isArray(value)) {
    return value.length > 0
      ? value.map((item) => `- ${prose(renderValue(item))}`)
      : ["- none"];
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return keys.length > 0
      ? keys.map((key) => `- ${prose(key)}: ${prose(renderValue(value[key]))}`)
      : ["- none"];
  }
  return [`- ${prose(renderValue(value))}`];
}

function renderValue(value) {
  if (value && typeof value === "object") return stableStringify(value);
  return String(value ?? "");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function labelValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "label" in value) {
    return value.label;
  }
  return value ?? "unknown";
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (nonEmptyString(value)) return [String(value).trim()];
  return [];
}

function objectOrNull(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function arrayOfObjects(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => JSON.parse(JSON.stringify(entry)));
}

function normalizePrProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    schema_version: "agentic-factory-pr-provenance/v1",
    source_run_id: nullableString(value.source_run_id ?? value.sourceRunId),
    experiment_receipt_id: nullableString(value.experiment_receipt_id ?? value.experimentReceiptId),
    phoenix_experiment_id: nullableString(value.phoenix_experiment_id ?? value.phoenixExperimentId),
    proposal_instance_id: nullableString(value.proposal_instance_id ?? value.proposalInstanceId),
    normalized_envelope_hash: nullableString(value.normalized_envelope_hash ?? value.normalizedEnvelopeHash),
    candidate_target_key: nullableString(value.candidate_target_key ?? value.candidateTargetKey),
    produced_at: nullableString(value.produced_at ?? value.producedAt),
    github_auth_mode: nullableString(value.github_auth_mode ?? value.githubAuthMode),
    push_auth: nullableString(value.push_auth ?? value.pushAuth),
  };
}

function targetName(target) {
  return firstNonEmptyString(target?.human_name, "This factory behavior");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function nullableString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function prose(text) {
  return escapeGitHubMarkdownProse(text);
}
