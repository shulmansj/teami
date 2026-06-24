import { escapeGitHubMarkdownProse, renderPromotionMarkerBlock } from "./pr-marker.mjs";

// ---------------------------------------------------------------------------
// Standalone evidence summary, THROUGH the step 4 content gate
// (CONSTRAINTS #29: PR evidence summaries reuse the same allowlist/denylist/
// secret-rejection/sanitizer-reporting engine as rich example promotion).
// ---------------------------------------------------------------------------

const annotationDigestPolicy = {
  object: {
    example_id: { allow: "string" },
    annotation_id: { allow: "string" },
    name: { allow: "string" },
    annotator_kind: { allow: "string" },
    identifier: { allow: "string" },
    label: { allow: "string" },
    score: { allow: "scalar" },
    explanation: { allow: "string" },
    failure_modes: { array: { allow: "string" } },
  },
};

export const PR_EVIDENCE_SUMMARY_CONTENT_POLICY = Object.freeze({
  object: {
    behavior_improved: { array: { allow: "string" } },
    product_risk_remaining: { array: { allow: "string" } },
    human_decision_load: {
      object: {
        open_disagreements: { allow: "scalar" },
        judge_attention_items: { allow: "scalar" },
        band_mismatch_flags: { allow: "scalar" },
        items_requiring_human_judgment: { allow: "scalar" },
      },
    },
    categories_tested: { array: { allow: "string" } },
    key_annotations: { array: annotationDigestPolicy },
    disagreements: {
      array: {
        object: {
          example_id: { allow: "string" },
          kind: { allow: "string" },
          name: { allow: "string" },
          human_identifier: { allow: "string" },
          llm_identifier: { allow: "string" },
          code_identifier: { allow: "string" },
          human_label: { allow: "string" },
          llm_label: { allow: "string" },
          code_failure_modes: { array: { allow: "string" } },
        },
      },
    },
    judge_attention: {
      array: {
        object: {
          example_id: { allow: "string" },
          kind: { allow: "string" },
          reason: { allow: "string" },
        },
      },
    },
    band_mismatches: {
      array: {
        object: {
          example_id: { allow: "string" },
          name: { allow: "string" },
          annotator_kind: { allow: "string" },
          identifier: { allow: "string" },
          label: { allow: "string" },
          score: { allow: "scalar" },
        },
      },
    },
  },
});

// Builds the bounded evidence-summary payload from gate facts plus the
// verified per-example source annotations (real annotation prose flows
// THROUGH the content gate, so token-shaped content anywhere fails closed
// and private URLs are redacted with a report).
export function buildEvidenceSummaryPayload({ gate, evidence } = {}) {
  const keyAnnotations = [];
  for (const entry of evidence?.per_example || []) {
    for (const annotation of entry.source_annotations || []) {
      const failureModes = Array.isArray(annotation.metadata?.failure_modes)
        ? annotation.metadata.failure_modes
        : [];
      if (annotation.label === "pass" && failureModes.length === 0) continue;
      keyAnnotations.push({
        example_id: entry.example_id ?? null,
        annotation_id: annotation.annotation_id ?? null,
        name: annotation.name ?? null,
        annotator_kind: annotation.annotator_kind ?? null,
        identifier: annotation.identifier ?? null,
        label: annotation.label ?? null,
        score: Number.isFinite(annotation.score) ? annotation.score : null,
        explanation: annotation.explanation ?? null,
        failure_modes: failureModes.map(String),
      });
      if (keyAnnotations.length >= 10) break;
    }
    if (keyAnnotations.length >= 10) break;
  }
  return {
    behavior_improved: [...(gate.product_report?.behavior_improved || [])].map(String),
    product_risk_remaining: [...(gate.product_report?.product_risk_remaining || [])].map(String),
    human_decision_load: {
      open_disagreements: gate.product_report?.human_decision_load?.open_disagreements ?? 0,
      judge_attention_items: gate.product_report?.human_decision_load?.judge_attention_items ?? 0,
      band_mismatch_flags: gate.product_report?.human_decision_load?.band_mismatch_flags ?? 0,
      items_requiring_human_judgment:
        gate.product_report?.human_decision_load?.items_requiring_human_judgment ?? 0,
    },
    categories_tested: [...(gate.product_report?.categories_tested || [])].map(String),
    key_annotations: keyAnnotations,
    disagreements: (gate.disagreements || []).map((item) => ({
      example_id: item.example_id ?? null,
      kind: item.kind ?? null,
      name: item.name ?? null,
      human_identifier: item.human_identifier ?? null,
      llm_identifier: item.llm_identifier ?? null,
      code_identifier: item.code_identifier ?? null,
      human_label: item.human_label ?? null,
      llm_label: item.llm_label ?? null,
      code_failure_modes: Array.isArray(item.code_failure_modes)
        ? item.code_failure_modes.map(String)
        : [],
    })),
    judge_attention: (gate.judge_attention || []).map((item) => ({
      example_id: item.example_id ?? null,
      kind: item.kind ?? null,
      reason: item.reason ?? null,
    })),
    band_mismatches: (gate.band_mismatches || []).map((item) => ({
      example_id: item.example_id ?? null,
      name: item.name ?? null,
      annotator_kind: item.annotator_kind ?? null,
      identifier: item.identifier ?? null,
      label: item.label ?? null,
      score: Number.isFinite(item.score) ? item.score : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Proposal document rendering (Track A template structure). One document is
// used as both the in-repo proposal file and the PR body, so the marker and
// standalone evidence summary survive in both custody locations.
// ---------------------------------------------------------------------------

function prose(text) {
  return escapeGitHubMarkdownProse(text);
}

export function renderProposalDocument({
  title,
  candidateTargetKey,
  candidateKind,
  candidateVersionId,
  acceptedBaselineId,
  summary,
  sanitizerReport,
  evidenceCounts,
  evidenceQuality,
  promotionRisk,
  triggerAuthenticity,
  contentTrust,
  phoenixScope,
  pins,
  launchProvenance,
  disclosure,
  controllerRationale,
  marker,
} = {}) {
  const lines = [];
  lines.push(`# Process Change Proposal: ${prose(title)}`);
  lines.push("");
  lines.push("## Candidate");
  lines.push("");
  lines.push(`- \`candidate_target_key\`: \`${candidateTargetKey}\``);
  lines.push(`- \`candidate_kind\`: \`${candidateKind}\``);
  lines.push(`- \`candidate_version_id\`: \`${candidateVersionId}\``);
  lines.push(`- \`accepted_baseline_id\`: \`${acceptedBaselineId}\``);
  lines.push("");
  lines.push("## Evidence summary (standalone)");
  lines.push("");
  lines.push(...buildPromotionEvidenceSummaryLines({
    summary,
    sanitizerReport,
  }).documentEvidenceSummaryLines);
  lines.push("");
  lines.push("## Evidence counts");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({ evidence_counts: evidenceCounts }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Evidence quality");
  lines.push("");
  lines.push(`- \`evidence_quality\`: ${evidenceQuality.label} (rubric-derived advisory)`);
  lines.push(`- Explanation: ${prose(evidenceQuality.explanation)}`);
  lines.push(
    "- Basis: rubric-derived advisory — a deterministic rubric over step 9 gate facts only (no model judgment, prose never read); advisory for the human reviewer and never able to waive a mechanical gate.",
  );
  lines.push("");
  lines.push("## Promotion risk");
  lines.push("");
  lines.push(`- \`promotion_risk\`: ${promotionRisk.label} (rubric-derived advisory)`);
  lines.push(`- Explanation: ${prose(promotionRisk.explanation)}`);
  lines.push(
    "- Basis: rubric-derived advisory — a deterministic rubric over step 9 gate facts only (no model judgment, prose never read); advisory for the human reviewer and never able to waive a mechanical gate.",
  );
  lines.push("");
  lines.push("## Trigger authenticity and content trust");
  lines.push("");
  lines.push(`- \`trigger_authenticity\`: ${triggerAuthenticity.value} (derived from ${triggerAuthenticity.derived_from}; caller-supplied authenticity claims are ignored${triggerAuthenticity.ignored_caller_fields.length > 0 ? ` — ignored fields: ${prose(triggerAuthenticity.ignored_caller_fields.join(", "))}` : ""})`);
  lines.push("- Per-object `content_trust`:");
  lines.push("");
  lines.push("| object | content_trust | note |");
  lines.push("| --- | --- | --- |");
  for (const row of contentTrust) {
    lines.push(`| ${prose(row.object)} | ${row.trust} | ${prose(row.note || "")} |`);
  }
  lines.push("");
  lines.push("## Phoenix pins");
  lines.push("");
  lines.push(`- Phoenix origin/project scope: \`${phoenixScope.origin}\` / \`${phoenixScope.project_name}\``);
  lines.push(`- Prompt version: ${pins.candidate_prompt_version_id ? `\`${pins.candidate_prompt_version_id}\`` : "n/a"}`);
  lines.push(`- Dataset: \`${pins.dataset_name ?? "?"}\` (\`${pins.dataset_id}\`) version \`${pins.dataset_version_id}\``);
  lines.push(`- Experiments: \`${pins.experiment_ids.join("`, `")}\``);
  lines.push(`- Annotations: ${pins.annotation_ids.length > 0 ? `\`${pins.annotation_ids.join("`, `")}\`` : "n/a"}`);
  lines.push("");
  lines.push("## Launch provenance");
  lines.push("");
  lines.push(`- Launch source: \`${launchProvenance.source}\` (${prose(launchProvenance.policy_match_basis)})`);
  lines.push(`- Declared intent: \`${launchProvenance.intent}\` (${prose(launchProvenance.intent_source)})`);
  lines.push(`- Actor: ${prose(launchProvenance.actor ?? "unknown")} (authenticity: ${launchProvenance.actor_authenticity})`);
  lines.push(`- Managed receipt: \`${launchProvenance.receipt_id}\``);
  lines.push(
    `- Test-split exposure: ${launchProvenance.test_split_exposure} (${launchProvenance.test_split_exposure_disclosure}; history incomplete by design)`,
  );
  lines.push(
    `- Cross-version comparison: ${launchProvenance.cross_version_comparison_accepted
      ? "explicitly accepted by the requester (`accept_cross_version_comparison: true` in the request envelope); version-incompatible examples are included and labeled in the gate evidence"
      : "not requested; only version-compatible examples were compared"}`,
  );
  lines.push("");
  lines.push("## Disagreement disclosure");
  lines.push("");
  if (disclosure.none_observed_statement) {
    lines.push(prose(disclosure.none_observed_statement));
  } else {
    lines.push(
      `${disclosure.disagreement_count} disagreement(s), ${disclosure.judge_attention_count} judge-attention item(s), ${disclosure.band_mismatch_count} band-mismatch flag(s) on ${disclosure.checked_example_count} checked item(s); raw records preserved in the evidence summary above and in Phoenix.`,
    );
    if (controllerRationale) {
      lines.push("");
      lines.push(`Controller rationale for proceeding despite disagreement: ${prose(controllerRationale)}`);
    }
  }
  lines.push("");
  lines.push("## Machine-readable marker");
  lines.push("");
  lines.push(renderPromotionMarkerBlock(marker));
  lines.push("");
  return lines.join("\n");
}

export function buildPromotionEvidenceSummaryLines({ summary, sanitizerReport } = {}) {
  const documentEvidenceSummaryLines = [];
  const evidenceSummaryLines = [];
  documentEvidenceSummaryLines.push(
    "This summary stands alone if local Phoenix state is lost; the pins below may stop resolving but the judgment record stays reviewable.",
  );
  documentEvidenceSummaryLines.push("");
  for (const item of summary.behavior_improved) {
    documentEvidenceSummaryLines.push(`- Improved: ${prose(item)}`);
    evidenceSummaryLines.push(`Improved: ${item}`);
  }
  for (const item of summary.product_risk_remaining) {
    documentEvidenceSummaryLines.push(`- Risk remaining: ${prose(item)}`);
    evidenceSummaryLines.push(`Risk remaining: ${item}`);
  }
  const humanLoadLine =
    `Human decision load: ${summary.human_decision_load.items_requiring_human_judgment} item(s) need human judgment (${summary.human_decision_load.open_disagreements} disagreement(s), ${summary.human_decision_load.judge_attention_items} judge-attention, ${summary.human_decision_load.band_mismatch_flags} band-mismatch).`;
  documentEvidenceSummaryLines.push(`- ${humanLoadLine}`);
  evidenceSummaryLines.push(humanLoadLine);
  const categoriesLine = `Categories tested: ${summary.categories_tested.join(", ") || "unknown"}`;
  documentEvidenceSummaryLines.push(`- Categories tested: ${prose(summary.categories_tested.join(", ") || "unknown")}`);
  evidenceSummaryLines.push(categoriesLine);
  if (summary.key_annotations.length > 0) {
    documentEvidenceSummaryLines.push("");
    documentEvidenceSummaryLines.push("Key judgments on the cited evidence (sanitized; raw records remain in Phoenix):");
    documentEvidenceSummaryLines.push("");
    for (const annotation of summary.key_annotations) {
      const line =
        `${annotation.example_id ?? "?"} ${annotation.annotator_kind} ${annotation.identifier ?? "?"}: ${annotation.label}${Number.isFinite(annotation.score) ? ` (score ${annotation.score})` : ""}${annotation.failure_modes.length > 0 ? ` failure_modes=${annotation.failure_modes.join(",")}` : ""}${annotation.explanation ? ` — ${annotation.explanation}` : ""}`;
      documentEvidenceSummaryLines.push(
        `- ${prose(annotation.example_id ?? "?")} ${annotation.annotator_kind} ${prose(annotation.identifier ?? "?")}: ${annotation.label}${Number.isFinite(annotation.score) ? ` (score ${annotation.score})` : ""}${annotation.failure_modes.length > 0 ? ` failure_modes=${prose(annotation.failure_modes.join(","))}` : ""}${annotation.explanation ? ` — ${prose(annotation.explanation)}` : ""}`,
      );
      evidenceSummaryLines.push(`Key judgment: ${line}`);
    }
  }
  documentEvidenceSummaryLines.push("");
  const sanitizerLine =
    `Sanitizer report: ${sanitizerReport.removed_count} removal(s), ${sanitizerReport.transformed_count} transformation(s) (content gate v${sanitizerReport.content_gate_version}).`;
  documentEvidenceSummaryLines.push(sanitizerLine);
  evidenceSummaryLines.push(sanitizerLine);
  return { evidenceSummaryLines, documentEvidenceSummaryLines, sanitizerReport };
}
