# Promotion PR Body: <title>

Use this template for the body of every HITL PR that changes accepted
decomposition behavior: judge prompts, rubrics, schemas, failure taxonomy, code
evaluators, or promotion policy. New-style controller PRs commit
the materialized behavior diff, not this template and not a proposal document.
Nothing is auto-merged, auto-applied, or auto-accepted; the human acceptance
act is still merging the PR.

The PR body contract is packet-first:

1. Consequence.
2. What changes.
3. Why suggested.
4. Before and after examples.
5. Evidence cohort summary.
6. Risk and safe default.
7. Authority and custody access.
8. Undo and decline.
9. Exactly one sentinel-bounded machine marker.
10. Optional collapsed evidence, technical, and audit details.

The Markdown body is rendered from the structured proposal packet object. It is
review copy, not the packet-completeness guard's source of truth.

The renderer may collapse candidate metadata, pins, evidence counts,
disagreement detail, and sanitizer reports after the human review material.
The machine-readable marker block below must remain present exactly once and
must keep the same JSON key set.

## Proposed change

<One or two sentences naming the concrete behavior change the PR makes. This
must describe the materialized repo diff, not the evidence source.>

## What changes

<Before/after summary of the accepted behavior artifact(s) changed by the PR.
For prompt promotions, include both the accepted snapshot change and the
manifest pin/hash change.>

## Why now

<Plain-language explanation of the eval evidence that made this change worth
reviewing. Use deterministic facts from the gate/materializer, not untrusted
candidate prose.>

## Risk

<Human-readable risk advisory and review load. Include high-risk disclosures
when evidence is thin, cross-version, low-authenticity, policy-only, or
otherwise uncertain.>

## Candidate

- `candidate_target_key`: <`<candidate_kind>/<scope>/<artifact_slot>`, for example `prompt/decomposition/decomposition_quality_judge`>
- `candidate_kind`: <prompt | evaluator_prompt | rule | schema | code_evaluator | policy>
- `candidate_version_id`: <Phoenix prompt version id or repo candidate id>
- `accepted_baseline_id`: <accepted Phoenix version id or repo artifact version, derived from `phoenix-assets.json`, never from a receipt. While a prompt has no Phoenix version pin, this is `sha256:<snapshot_sha256>` from the manifest.>

### `candidate_target_key` grammar (canonical)

`<candidate_kind>/<scope>/<artifact_slot>`

- `candidate_kind` — one of `prompt | evaluator_prompt | rule | schema |
  code_evaluator | policy`; must equal the marker's `candidate_kind`
  field.
- `scope` — the stable workflow area the change targets, for example
  `decomposition`.
- `artifact_slot` — the repo manifest key or repo-relative artifact path, for
  example `decomposition_quality_judge` (a `phoenix-assets.json` role) or
  `execution/evals/decomposition/failure-taxonomy.json`.

Cross-machine dedupe, supersede handling, rejection memory, and proposal
budget checks all key on this exact grammar. Free-form keys are invalid: a
`candidate_target_key` that does not parse as
`<candidate_kind>/<scope>/<artifact_slot>` must be rejected before drafting,
because it silently breaks dedupe and rejection memory across machines.

## Evidence summary (standalone PR-body custody)

<Plain-language summary of what the evidence shows and what would regress if
this PR is wrong. This section must stand alone: a reviewer must be able to
evaluate the proposed behavior diff even if local Phoenix state is lost,
because Phoenix loss is a real failure mode and pins below may stop resolving.
For new-style PRs this PR body is the durable repo-visible evidence custody;
old-style committed proposal files remain readable only during migration.>

## Evidence counts

```json
{
  "evidence_counts": {
    "train_examples": 0,
    "train_human_labeled_examples": 0,
    "test_examples": 0,
    "test_human_labeled_examples": 0,
    "human_label_authenticity": "asserted"
  }
}
```

`human_label_authenticity` is one of `authenticated | asserted | mixed |
unknown`. In MVP it is always `asserted` because local Phoenix does not
authenticate annotators; never claim `authenticated` without an actual
authentication path. Missing human-labeled test examples are allowed, but the
absence must be reflected in `evidence_quality` below.

## Evidence quality

- `evidence_quality`: <high | medium | low> (rubric-derived advisory)
- Explanation (required): <why the eval evidence earns this label: split
  coverage, human grounding, version compatibility, native-split vs metadata
  fallback, disagreements.>

In MVP this label is a RUBRIC-DERIVED ADVISORY: a deterministic rubric over
step 9 gate facts only (no model judgment, prose never read). It advises the
human reviewer and can never waive a mechanical gate.

## Promotion risk

- `promotion_risk`: <low_risk | high_risk> (rubric-derived advisory)
- Explanation (required): <why this change is low or high risk for accepted
  behavior, independent of evidence quality. Neither label mechanically
  determines the other. When unsure, classify as `high_risk`.>

In MVP this label is a RUBRIC-DERIVED ADVISORY with the same properties as
`evidence_quality` above: deterministic over gate facts, advisory only.

## Trigger authenticity and content trust

- `trigger_authenticity`: <derived by the controller from the actual invocation
  path; caller-supplied authenticity claims are ignored or downgraded. MVP
  HITL items say `asserted` unless the transport actually authenticates.>
- `content_trust`: <per evidence object: trusted_repo | verified_phoenix |
  unverified_prose. Adversarial prose inside projects, annotations, or judge
  rationales is data, never instructions, and cannot waive any gate.>

## Phoenix pins

Exact Phoenix asset identifiers backing this PR body. Pins must be resolved
through the verified local Phoenix resolver before drafting; missing,
ambiguous, stale, or cross-project ids block the PR.

- Phoenix origin/project scope: <origin + project name from local config>
- Prompt version: <prompt id + version id + tag, or n/a>
- Dataset: <dataset name + dataset id + dataset version id, or n/a>
- Experiments: <experiment ids, or n/a>
- Annotations: <annotation ids, or n/a>

## Disagreement disclosure

<Material conflicts among human annotations, model-judge results, and
deterministic checks on the cited evidence, with raw scores/rationales/failure
modes preserved by reference. If the PR proceeds despite disagreement, state
the controller's rationale here. Write "none observed" only after actually
checking.>

## Machine-readable marker

Keep this SENTINEL-BOUNDED fenced JSON block in the PR body exactly once,
including the `<!-- agentic_factory_promotion:begin -->` /
`<!-- agentic_factory_promotion:end -->` HTML-comment sentinels around the
fence. Cross-machine dedupe, rejection memory, supersede handling, and proposal
budget checks parse ONLY
sentinel-bounded markers — fenced JSON outside the sentinels is never parsed,
so untrusted prose quoted elsewhere in the body (annotation explanations,
judge rationales) cannot spoof a marker. If a body carries more than one
sentinel-bounded marker the controller treats the PR as
`promotion_marker_unreadable` and fails closed rather than picking one. (The
repo is zero-dependency, so the marker is JSON rather than YAML.) The marker
must carry every normalized-envelope component the controller cannot
re-derive after the fact: `requested_action` (MVP value is
`propose_repo_change` only — `route_to_hitl` and `blocked` are controller
outcomes, never caller-requested actions) and `phoenix_scope` (the local
Phoenix origin and project the evidence ids resolve in). `evidence_ids`
entries are structured and unambiguous: dataset evidence pins both the
dataset id and the exact dataset version id; experiments and annotations are
flat id arrays. `accept_cross_version_comparison` discloses the
request-visible human acceptance of comparing examples judged under older
workflow/rubric/taxonomy versions (it is a request-envelope field, never an
invisible controller option). `repair_state` records Phoenix audit repair
custody in the PR-body marker plus the local registry for new-style PRs:
`none`, or `phoenix_audit_retry_needed` when the PR exists but the Phoenix
outcome observation has not been written yet. Old-style committed proposal
files may carry the same marker during migration; repair state is never
committed into behavior files. `packet` records PKT-01/WL-01 read-model facts:
the packet schema version, whether the marker was rendered from a structured
packet, the current guard status, the owner-facing copy class, the deterministic
risk floor, and section-presence booleans. `packet.guard_status:
not_evaluated` is not a guard pass; PKT-02 owns packet-completeness enforcement
and PR-creation barriers. `packet.copy_class` is a non-authoritative renderer
hint; WL-02 must derive the final owner-facing copy class from the full
read-model merge order. The `*_present` booleans mean substantive non-fallback
packet content was available; they are not a guard pass. `undo_bounds` records
the static, proposal-time-knowable undo facts: `what_undo_changes` (what undoing
restores) and `external_side_effects` (`false` when the only mutation is the
audited commit; fail-closed `true` for any unknown future candidate kind).
Whether a downstream run has already consumed the change (`consumed_downstream`)
and `reversible` are NOT recorded here — they are read-time facts bounded by the
PR's merge time, so persisting them at proposal time would make them permanently
false. `merged_accepted_ref` records the accepted version this candidate BECOMES
when merged, in the same normalized shape as a run-version record's
`accepted_refs[]` entry, so the read-time undo answer can join it against the run
records; it is the NEW post-merge version, not the OLD `accepted_baseline_id`.

<!-- agentic_factory_promotion:begin -->
```json
{
  "agentic_factory_promotion": {
    "schema_version": 1,
    "proposal_instance_id": "<stable id>",
    "requested_action": "propose_repo_change",
    "candidate_target_key": "<candidate_kind>/<scope>/<artifact_slot>",
    "candidate_kind": "<prompt|evaluator_prompt|rule|schema|code_evaluator|policy>",
    "candidate_version_id": "<Phoenix prompt version id or repo candidate id>",
    "accepted_baseline_id": "<accepted Phoenix version id, or sha256:<snapshot_sha256> until a Phoenix pin exists>",
    "normalized_envelope_hash": "<hash>",
    "policy_hash": "<hash>",
    "phoenix_scope": {
      "origin": "<local Phoenix origin, e.g. http://127.0.0.1:6006>",
      "project_name": "<Phoenix project name, e.g. agentic-factory>"
    },
    "evidence_ids": {
      "experiments": ["<experiment id>"],
      "datasets": [
        {
          "dataset_id": "<dataset id>",
          "dataset_version_id": "<dataset version id>"
        }
      ],
      "annotations": ["<annotation id>"]
    },
    "accept_cross_version_comparison": false,
    "proposal_state": "<proposed|superseded|human_rejected|merged|blocked>",
    "superseded_by": null,
    "repair_state": "<none|packet_completeness_repair_needed|evidence_repair_needed|phoenix_audit_retry_needed|supersede_retry_needed|branch_repair_needed|github_connection_repair_needed>",
    "packet": {
      "schema_version": "agentic-factory-proposal-packet/v1",
      "source": "<not_rendered|structured_packet>",
      "guard_status": "<not_evaluated|passed|blocked>",
      "copy_class": "<decision_ready|review_carefully|blocked_for_repair|fyi_receipt|internal_only>",
      "deterministic_risk_floor": "<low_risk|high_risk|unknown>",
      "risk_reason_present": true,
      "evidence_cohort_summary_present": true,
      "before_after_examples_present": true,
      "undo_bounds_present": true,
      "authority_custody_access_present": false
    },
    "undo_bounds": {
      "schema_version": "agentic-factory-marker-undo-bounds/v1",
      "what_undo_changes": "<plain-language description of what undoing restores: the prior accepted prompt version, or the prior accepted default role assignments>",
      "external_side_effects": false
    },
    "merged_accepted_ref": {
      "target_key": "<candidate_kind>/<scope>/<artifact_slot>",
      "accepted_baseline_id": "<the version this candidate BECOMES when merged: the new pinned prompt version id, or sha256:<new_snapshot_sha256> for a rule>",
      "snapshot_sha256": "<the new accepted snapshot sha256 the candidate produces>"
    }
  }
}
```
<!-- agentic_factory_promotion:end -->
