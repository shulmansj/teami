export const JUDGE_IMPROVEMENT_CLAIM = "judge_improved";
export const JUDGE_ALIGNMENT_EVIDENCE_SCHEMA_VERSION =
  "teami-judge-alignment-evidence/v1";

export function computeJudgeAlignmentMetrics({
  rows = [],
  defaultWorkflowType = null,
  defaultEvalNamespace = null,
} = {}) {
  const normalizedRows = rows
    .map((row) => normalizeAlignmentRow(row, {
      defaultWorkflowType,
      defaultEvalNamespace,
    }))
    .filter(Boolean);
  const groups = new Map();
  for (const row of normalizedRows) {
    const key = [
      row.workflow_type,
      row.eval_namespace,
      row.label_source,
    ].join("\u0000");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const strata = [...groups.values()].map(computeStratumMetrics)
    .sort((a, b) =>
      a.workflow_type.localeCompare(b.workflow_type)
      || a.eval_namespace.localeCompare(b.eval_namespace)
      || a.label_source.localeCompare(b.label_source));
  const byLabelSource = {};
  for (const stratum of strata) {
    if (!byLabelSource[stratum.label_source]) byLabelSource[stratum.label_source] = [];
    byLabelSource[stratum.label_source].push(stratum);
  }
  return {
    schema_version: JUDGE_ALIGNMENT_EVIDENCE_SCHEMA_VERSION,
    row_count: normalizedRows.length,
    strata,
    by_label_source: byLabelSource,
  };
}

export function judgeImprovementEvidenceFromGate({
  claim = null,
  rows = [],
  metrics = null,
} = {}) {
  const normalizedClaim = normalizeClaim(claim);
  if (normalizedClaim !== JUDGE_IMPROVEMENT_CLAIM) {
    return {
      applies: false,
      claim: normalizedClaim,
      metrics: null,
      pr_language: null,
    };
  }
  const resolvedMetrics = metrics?.schema_version === JUDGE_ALIGNMENT_EVIDENCE_SCHEMA_VERSION
    ? metrics
    : computeJudgeAlignmentMetrics({ rows });
  return {
    applies: true,
    claim: JUDGE_IMPROVEMENT_CLAIM,
    metrics: resolvedMetrics,
    pr_language:
      `Judge alignment metrics are attached for ${resolvedMetrics.row_count} labeled comparison row(s) across ${resolvedMetrics.strata.length} stratum/strata.`,
  };
}

export function judgeImprovementClaimFromGate(gate = {}) {
  const ctx = gate?.evidence_quality_context || {};
  const claims = [
    gate?.claim,
    gate?.evidence_claim,
    ctx.claim,
    ctx.evidence_claim,
    ...(Array.isArray(gate?.claims) ? gate.claims : []),
    ...(Array.isArray(ctx.claims) ? ctx.claims : []),
  ];
  return claims.some((claim) => normalizeClaim(claim) === JUDGE_IMPROVEMENT_CLAIM)
    ? JUDGE_IMPROVEMENT_CLAIM
    : null;
}

export function judgeImprovementEvidenceFromProcessGate(gate = {}) {
  const ctx = gate?.evidence_quality_context || {};
  return judgeImprovementEvidenceFromGate({
    claim: judgeImprovementClaimFromGate(gate),
    rows: ctx.judge_alignment_rows || gate?.judge_alignment_rows || [],
    metrics: ctx.judge_alignment_metrics || gate?.judge_alignment_metrics || null,
  });
}

function computeStratumMetrics(rows) {
  const labels = [...new Set(rows.flatMap((row) => [row.expected_label, row.judge_label]))]
    .filter(Boolean)
    .sort();
  const byLabel = {};
  for (const label of labels) {
    const tp = rows.filter((row) => row.expected_label === label && row.judge_label === label).length;
    const fp = rows.filter((row) => row.expected_label !== label && row.judge_label === label).length;
    const fn = rows.filter((row) => row.expected_label === label && row.judge_label !== label).length;
    const precision = ratioOrNull(tp, tp + fp);
    const recall = ratioOrNull(tp, tp + fn);
    byLabel[label] = {
      true_positive: tp,
      false_positive: fp,
      false_negative: fn,
      precision,
      recall,
      f1: f1OrNull(precision, recall),
    };
  }
  const f1Values = Object.values(byLabel)
    .map((entry) => entry.f1)
    .filter((value) => Number.isFinite(value));
  const agreementCount = rows.filter((row) => row.expected_label === row.judge_label).length;
  return {
    workflow_type: rows[0].workflow_type,
    eval_namespace: rows[0].eval_namespace,
    label_source: rows[0].label_source,
    label_statuses: [...new Set(rows.map((row) => row.label_status).filter(Boolean))].sort(),
    labeled_fixture_count: rows.length,
    frozen_labeled_fixture_count: rows.filter((row) => row.frozen_label).length,
    holdout_count: rows.filter((row) => row.holdout).length,
    frozen_holdout_count: rows.filter((row) => row.frozen_label && row.holdout).length,
    agreement_count: agreementCount,
    disagreement_count: rows.length - agreementCount,
    agreement_rate: ratioOrNull(agreementCount, rows.length),
    precision_recall_f1_by_label: byLabel,
    macro_f1: f1Values.length > 0
      ? f1Values.reduce((total, value) => total + value, 0) / f1Values.length
      : null,
    disagreements: rows
      .filter((row) => row.expected_label !== row.judge_label)
      .map((row) => ({
        example_id: row.example_id,
        expected_label: row.expected_label,
        judge_label: row.judge_label,
      })),
  };
}

function normalizeAlignmentRow(row, { defaultWorkflowType, defaultEvalNamespace }) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const metadata = objectOrEmpty(row.metadata);
  const reference = objectOrEmpty(row.reference ?? metadata.reference);
  const provenance = objectOrEmpty(row.provenance ?? reference.provenance ?? row.fixture_provenance);
  const expectedLabel = textOrNull(row.expected_label ?? reference.expected_label);
  const judgeLabel = textOrNull(
    row.judge_label
    ?? row.llm_label
    ?? row.judge?.label
    ?? row.annotation?.label
    ?? firstRollupLabel(row.llms),
  );
  if (!expectedLabel || !judgeLabel) return null;
  const labelSource = textOrNull(row.label_source ?? provenance.label_source) || "unknown";
  const labelStatus = textOrNull(row.label_status ?? provenance.label_status);
  const split = textOrNull(row.split ?? row.dataset_split ?? metadata.dataset_split);
  return {
    example_id: textOrNull(row.example_id ?? row.id ?? row.source_example_id ?? metadata.source_example_id),
    workflow_type: textOrNull(row.workflow_type ?? metadata.workflow_type ?? defaultWorkflowType) || "unknown",
    eval_namespace:
      textOrNull(row.eval_namespace ?? metadata.eval_namespace ?? defaultEvalNamespace) || "unknown",
    label_source: labelSource,
    label_status: labelStatus,
    expected_label: expectedLabel,
    judge_label: judgeLabel,
    holdout: row.holdout === true || split === "test",
    frozen_label: row.frozen_label === true || Boolean(expectedLabel && labelStatus === "GOLD"),
  };
}

function firstRollupLabel(llms) {
  if (!Array.isArray(llms)) return null;
  const rollup = llms.find((entry) => entry?.name === "quality" && entry?.label);
  return rollup?.label ?? null;
}

function normalizeClaim(claim) {
  const value = textOrNull(claim);
  if (value === "judge_improved" || value === "judge improved") return JUDGE_IMPROVEMENT_CLAIM;
  return value;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function ratioOrNull(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function f1OrNull(precision, recall) {
  if (!Number.isFinite(precision) || !Number.isFinite(recall)) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}
