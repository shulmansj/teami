# Reviewer Quality Rubric

```yaml
rubric_version: 1.0.0
failure_taxonomy_version: 1.0.0
workflow_type: review
roll_up_annotation_name: quality
```

This rubric grades the Reviewer workflow's work product: a verdict on a pull
request. The Judge evaluates whether the verdict was correct and whether the
reasoning was sound. It does not re-run the product workflow, mutate GitHub, or
decide whether a PR is accepted.

## Inputs

The Judge receives a captured, verdict-shaped input:

1. The reviewed PR diff and bounded PR metadata.
2. The Reviewer verdict and reasoning, including any file-level comments.
3. The review-correctness signal available for the fixture.
4. The rubric version, failure taxonomy version, and allowed failure mode ids.

The input is a captured snapshot. Do not live-fetch PRs, statuses, issues, or
tests while grading.

## Labels

`pass`: the verdict was correct and the reasoning was sound. This includes a
good PR approved for the right reasons, or a problematic PR sent back with
correct, actionable reasons.

`needs_revision`: the verdict was defensible, but the review was materially
weak. Examples: it missed a secondary issue, overweighted a nit, gave thin
reasoning, or described the code imprecisely while still reaching the right
overall call.

`blocking_failure`: the verdict was wrong in a way that matters. Examples:
approving a PR with a real regression or security/correctness bug, blocking
good work entirely on false positives, or giving reasoning that is fabricated
or contradicts the diff.

## Score Bands

| Label | Default score band |
| --- | --- |
| `pass` | 0.80-1.00 |
| `needs_revision` | 0.40-0.79 |
| `blocking_failure` | 0.00-0.39 |

A wrong verdict that materially misleads should be `blocking_failure` even if
some secondary observations are useful.

## Dimensions

### `quality`

Roll-up judgment: would a competent maintainer trust this Reviewer's verdict on
this PR?

### `verdict_correctness`

The verdict matches the PR's actual merit. Approve genuinely-good work. Request
changes on a genuinely-problematic PR. A wrong approve is the most severe
failure because it can route bad work toward merge.

Typical failure modes: `review_wrong_approve_missed_bug`,
`review_wrong_approve_missed_regression`,
`review_wrong_block_good_work`.

### `real_issue_detection`

The review caught the real problems present in the diff, especially
regressions, missing tests, scope changes, and user-facing risk.

Typical failure modes: `review_missed_regression`,
`review_missed_missing_tests`, `review_missed_scope_change`.

### `false_positive_avoidance`

The review did not flag non-issues as blocking defects and did not block a
correct PR on taste, style, or unrelated preferences.

Typical failure modes: `review_false_positive_block`,
`review_nitpick_as_blocking`.

### `reasoning_soundness`

The stated reasons are correct, specific to the diff, and actually support the
verdict. They are not generic, fabricated, or contradictory.

Typical failure mode: `review_reasoning_unsound`.

### `actionability`

When the verdict requests changes, the requested fix is concrete enough that
the author can act without guessing.

Typical failure mode: `review_unactionable_request`.

### `severity_calibration`

The review distinguishes blocking defects from nits. It does not block on
style while ignoring a real bug, and it does not bury a critical issue among
trivia.

Typical failure modes: `review_severity_miscalibrated`,
`review_overfocused_on_style`.

### `scope_discipline`

The review judges the PR against the issue and the changed code. It does not
demand unrelated work or expand the product scope without cause.

Typical failure mode: `review_out_of_scope_demand`.

### `user_risk_explanation`

When the diff carries user-facing risk, the review names that risk so the human
merger understands the stakes.

Typical failure mode: `review_failed_to_explain_user_risk`.

## Critical Caps

Cap the roll-up at `blocking_failure` when any of these are true:

- The Reviewer approved a PR that contains a real regression or
  security/correctness bug.
- The Reviewer blocked genuinely-good work entirely on false positives or
  nits.
- The reasoning is fabricated, contradicts the diff, or materially misleads the
  maintainer.

## Output

The Judge writes the uniform `quality` annotation tagged by workflow metadata
for `review`. It may also emit dimension names from this rubric. Failure modes
must come from `failure-taxonomy.json`; recurring gaps outside the taxonomy
belong in the explanation, not as invented ids.
