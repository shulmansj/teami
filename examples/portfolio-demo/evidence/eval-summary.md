# Eval Summary

Provenance: hand-curated from current output.

This summary uses synthetic renewal-risk evidence to show how Agentic Factory
would connect decomposition quality to a reviewable process-improvement
proposal. It is not a live Phoenix export and it is not an accepted behavior
change.

## Evaluation Contract

| Field | Value |
| --- | --- |
| Workflow | `roadmap_decomposition` |
| Demo case | `renewal-risk-triage` |
| Evaluator | `decomposition_quality` |
| Evidence quality | `medium` |
| Promotion risk | `low_risk` |

Medium evidence quality means the example follows the current rubric and has a
clear comparison, but the dataset is synthetic and the held-out example is not
human-labeled inside this package.

Low promotion risk means the proposed process change tightens acceptance
criteria discipline. It does not add permissions, broaden automation, merge a
change, or alter any source of truth.

## Result Summary

| Candidate | Label | Score | Failure modes |
| --- | --- | ---: | --- |
| Baseline decomposition guidance | `needs_revision` | 0.68 | `missing_acceptance_criteria`, `product_question_not_escalated` |
| Evidence-linked acceptance guidance | `pass` | 0.86 | none observed |

The candidate scored higher because it tied issue acceptance criteria to
observable project evidence: top-20 account review, next-action accountability,
fixture coverage, and no source-system writes.

## Human Judgment Needed

A human should approve the process change only if the extra evidence-linking
step makes review clearer without making generated issues too noisy. If product
leads prefer shorter issue bodies, the improvement should move more of the
evidence mapping into the project update instead of each execution issue.

## Boundaries

- The scores are synthetic demo data.
- No live Phoenix experiment is claimed.
- No repository proposal was opened from this package.
- No accepted Agentic Factory behavior changed.
- Linear remains the live work-state surface; Phoenix remains the local eval
  evidence surface.

