import {
  QUALITY_LABELS,
  scoreAtBandBoundary,
  scoreWithinLabelBand,
} from "./eval-annotation-contract.mjs";

// Deterministic low-confidence judge heuristics (PHOENIX-CAPABILITIES Q13):
// malformed output, label/score band mismatch, score at a band boundary,
// missing rationale/failure modes, judge-vs-CODE and judge-vs-HUMAN conflicts.
export function detectLowConfidenceReasons({
  annotation,
  codeAnnotations = [],
  humanAnnotations = [],
  evalContract = null,
} = {}) {
  const reasons = [];
  const label = annotation?.label;
  const score = annotation?.score;
  const qualityLabels = Array.isArray(evalContract?.quality_labels) && evalContract.quality_labels.length > 0
    ? evalContract.quality_labels
    : QUALITY_LABELS;
  const scoreWithin = evalContract?.scoreWithinLabelBand || scoreWithinLabelBand;
  const scoreAtBoundary = evalContract?.scoreAtBandBoundary || scoreAtBandBoundary;
  const malformed = !qualityLabels.includes(label)
    || !Number.isFinite(score) || score < 0 || score > 1;
  if (malformed) {
    reasons.push("judge_output_malformed");
  } else {
    if (!scoreWithin(label, score)) reasons.push("label_score_band_mismatch");
    if (scoreAtBoundary(score)) reasons.push("score_at_band_boundary");
  }
  if (!String(annotation?.explanation ?? "").trim()) reasons.push("missing_explanation");
  const failureModes = Array.isArray(annotation?.metadata?.failure_modes)
    ? annotation.metadata.failure_modes
    : [];
  if (!malformed && label !== "pass" && failureModes.length === 0) {
    reasons.push("missing_failure_modes");
  }
  const codeFailureModes = codeAnnotations.flatMap((code) =>
    Array.isArray(code?.metadata?.failure_modes) ? code.metadata.failure_modes : []);
  if (!malformed && codeAnnotations.length > 0) {
    if (label === "pass" && codeFailureModes.length > 0) {
      reasons.push("judge_code_failure_mode_conflict");
    }
    if (label !== "pass" && codeFailureModes.length === 0) {
      reasons.push("judge_code_failure_mode_conflict");
    }
  }
  if (humanAnnotations.some((human) =>
    human.name === annotation?.name && human.label && label && human.label !== label)) {
    reasons.push("judge_human_label_conflict");
  }
  return [...new Set(reasons)];
}
