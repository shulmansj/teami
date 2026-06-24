# Local Proposal: Tighten Evidence-Linked Acceptance Criteria

Provenance: hand-curated from current output.

This is a local review artifact based on synthetic demo eval evidence. It has
not been opened as a pull request, committed, merged, or applied to accepted
Agentic Factory behavior.

## Proposed Change

Update the decomposition guidance so each execution issue has at least one
acceptance criterion tied to observable project evidence, or explicitly names
the product assumption that still needs human review.

## What Changes

Before:

- Issues often had executable assignments, but some acceptance criteria were
  generic enough that a reviewer still had to infer what proof mattered.

After:

- The proposed PM synthesis step would check that acceptance criteria map back
  to the Linear project's Acceptance Evidence or to an explicit assumption.
- The decomposition-quality judge would be expected to flag generic criteria
  under `missing_acceptance_criteria` or `product_question_not_escalated` when
  the issue would otherwise hide a product decision.

## Why Suggested

The synthetic renewal-risk run produced useful issue boundaries, but the first
draft under-specified how a reviewer would know whether the workflow reduced
meeting reconciliation time. The revised issue bundle tied review quality to
top-20 account review, next-action accountability, fixture coverage, and no
source-system writes.

## Evidence Summary

Synthetic eval comparison:

| Run | Label | Score | Noted failure modes |
| --- | --- | ---: | --- |
| `demo-renewal-risk-baseline` | `needs_revision` | 0.68 | `missing_acceptance_criteria`, `product_question_not_escalated` |
| `demo-renewal-risk-candidate` | `pass` | 0.86 | none observed |

The candidate run improved because the issues named concrete review evidence
and surfaced the decision point around live source-system data instead of
quietly expanding scope.

## Evidence Counts

```json
{
  "evidence_counts": {
    "train_examples": 3,
    "train_human_labeled_examples": 1,
    "test_examples": 1,
    "test_human_labeled_examples": 0,
    "human_label_authenticity": "asserted"
  }
}
```

## Evidence Quality

- `evidence_quality`: `medium`
- Explanation: the example uses the current decomposition-quality rubric
  vocabulary and includes one asserted human label, but the held-out test
  example has no human label in this demo package.

## Promotion Risk

- `promotion_risk`: `low_risk`
- Explanation: the suggested change narrows review copy and acceptance
  criteria discipline. It does not add permissions, mutate external systems, or
  change the source of truth for product intent.

## Human Decision

Approve only if the extra evidence-linking step reduces reviewer ambiguity
without making issue bodies noisy. Reject or revise if product leads would
prefer shorter issue bodies and rely on the project update for evidence
mapping.

## Current Boundary

This artifact is a proposal-shaped demo output. It is not an accepted behavior
change, not a repository diff, and not proof that Agentic Factory created or
updated a remote review surface.
