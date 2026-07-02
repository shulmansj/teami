import assert from "node:assert/strict";
import test from "node:test";

import {
  computeJudgeAlignmentMetrics,
  judgeImprovementEvidenceFromGate,
} from "../src/promotion/judge-alignment-evidence.mjs";
import {
  deriveEvidenceQualityLabel,
} from "../src/promotion/request-contract.mjs";

function alignmentRow({
  id,
  expected = "pass",
  judge = "pass",
  split = "train",
  labelSource = "explicit_human",
  labelStatus = "GOLD",
  workflowType = "decomposition",
  evalNamespace = "execution/evals/decomposition",
} = {}) {
  return {
    id,
    expected_label: expected,
    judge_label: judge,
    provenance: {
      label_source: labelSource,
      label_status: labelStatus,
      labeled_at: "2026-06-29T12:00:00.000Z",
    },
    metadata: {
      workflow_type: workflowType,
      eval_namespace: evalNamespace,
      dataset_split: split,
    },
  };
}

function eligibleRows() {
  return [
    alignmentRow({ id: "ex-1", expected: "pass", judge: "pass", split: "test" }),
    alignmentRow({ id: "ex-2", expected: "pass", judge: "pass" }),
    alignmentRow({ id: "ex-3", expected: "needs_revision", judge: "pass" }),
    alignmentRow({ id: "ex-4", expected: "needs_revision", judge: "needs_revision" }),
    alignmentRow({ id: "ex-5", expected: "blocking_failure", judge: "blocking_failure" }),
    alignmentRow({ id: "ex-6", expected: "needs_revision", judge: "needs_revision" }),
    alignmentRow({
      id: "ex-ambiguous",
      expected: "pass",
      judge: "pass",
      split: "test",
      labelSource: "ambiguous",
      labelStatus: "excluded",
    }),
  ];
}

function highGateWithAlignment(rows) {
  return {
    verdict: "pass",
    evidence_counts: {
      train_examples: 5,
      train_human_labeled_examples: 5,
      test_examples: 1,
      test_human_labeled_examples: 1,
      human_label_authenticity: "asserted",
      annotations_low_confidence: 0,
    },
    evidence_quality_context: {
      claims: ["judge_improved"],
      missing_test_split_evidence: false,
      human_annotation_read_failures: 0,
      version_incompatible_examples: 0,
      judge_alignment_rows: rows,
    },
    disagreements: [],
    judge_attention: [],
  };
}

test("judge alignment metrics are reported by label_source with agreement and P/R/F1", () => {
  const metrics = computeJudgeAlignmentMetrics({ rows: eligibleRows() });
  assert.deepEqual(Object.keys(metrics.by_label_source).sort(), ["ambiguous", "explicit_human"]);

  const explicitHuman = metrics.by_label_source.explicit_human[0];
  assert.equal(explicitHuman.workflow_type, "decomposition");
  assert.equal(explicitHuman.eval_namespace, "execution/evals/decomposition");
  assert.equal(explicitHuman.labeled_fixture_count, 6);
  assert.equal(explicitHuman.frozen_labeled_fixture_count, 6);
  assert.equal(explicitHuman.frozen_holdout_count, 1);
  assert.equal(explicitHuman.agreement_count, 5);
  assert.equal(explicitHuman.disagreement_count, 1);
  assert.equal(explicitHuman.disagreements[0].example_id, "ex-3");
  assert.equal(explicitHuman.disagreements[0].expected_label, "needs_revision");
  assert.equal(explicitHuman.disagreements[0].judge_label, "pass");
  assert.ok(Math.abs(explicitHuman.agreement_rate - (5 / 6)) < 0.000001);
  assert.ok(Math.abs(explicitHuman.precision_recall_f1_by_label.pass.precision - (2 / 3)) < 0.000001);
  assert.equal(explicitHuman.precision_recall_f1_by_label.pass.recall, 1);
  assert.ok(Math.abs(explicitHuman.precision_recall_f1_by_label.pass.f1 - 0.8) < 0.000001);

  const ambiguous = metrics.by_label_source.ambiguous[0];
  assert.equal(ambiguous.label_statuses[0], "excluded");
  assert.equal(ambiguous.frozen_labeled_fixture_count, 0);
  assert.equal(ambiguous.frozen_holdout_count, 0);
});

test("judge improved claims attach alignment metrics without threshold gating", () => {
  const evidence = judgeImprovementEvidenceFromGate({
    claim: "judge_improved",
    rows: eligibleRows(),
  });
  assert.equal(evidence.applies, true);
  assert.equal(evidence.metrics.row_count, 7);
  assert.equal(evidence.metrics.by_label_source.explicit_human[0].frozen_holdout_count, 1);
  assert.equal(evidence.metrics.by_label_source.ambiguous[0].frozen_holdout_count, 0);
  assert.match(evidence.pr_language, /Judge alignment metrics are attached/);

  const sparse = judgeImprovementEvidenceFromGate({
    claim: "judge_improved",
    rows: eligibleRows().slice(0, 4),
  });
  assert.equal(sparse.applies, true);
  assert.equal(sparse.metrics.row_count, 4);
  assert.equal(sparse.metrics.strata[0].frozen_labeled_fixture_count, 4);
});

test("evidence_quality keeps its normal label while reporting sparse judge alignment", () => {
  const result = deriveEvidenceQualityLabel({
    gate: highGateWithAlignment(eligibleRows().slice(0, 4)),
  });
  assert.equal(result.label, "high");
  assert.match(result.explanation, /Judge alignment metrics are attached/);
  assert.equal(result.facts.judge_improvement_alignment.metrics.row_count, 4);
});

test("judge alignment facts include agreement metrics by function and label_source strata", () => {
  const result = deriveEvidenceQualityLabel({
    gate: highGateWithAlignment(eligibleRows()),
  });
  assert.equal(result.label, "high");
  assert.match(result.explanation, /Judge alignment metrics are attached/);
  assert.deepEqual(
    result.facts.judge_improvement_alignment.metrics.strata.map((entry) => [
      entry.workflow_type,
      entry.label_source,
    ]),
    [
      ["decomposition", "ambiguous"],
      ["decomposition", "explicit_human"],
    ],
  );
});
