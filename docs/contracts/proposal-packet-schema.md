# Proposal Packet Schema

Status: Distribution-pivot Phase 2B contract
Date: 2026-06-17

This contract defines the product-readable proposal packet for Teami
behavior-change PRs. It is the PKT-01 schema/content contract for the approval
loop. It does not implement the packet-completeness guard, PR-creation barrier,
classifier, worklist renderer, ledger, recovery workflow, or auto-acceptance.

Primary sources:
[`teami-product-trust-record.md`](teami-product-trust-record.md),
[`authority-custody-defaults.md`](authority-custody-defaults.md),
[`meta-change-classifier-contract.md`](meta-change-classifier-contract.md),
[`phase-2-worklist-event-read-model.md`](phase-2-worklist-event-read-model.md),
and the Phase 2 PKT-01 breakdown.

## Product Contract

The packet exists so a product-savvy, technical-adjacent owner can approve or
decline a behavior change by reading consequence, evidence, risk, authority,
undo, and decline information in product language. The owner should not need to
interpret Git mechanics, npm or Node failures, token lifetimes, branch names,
raw diffs, check logs, broker design, Phoenix object ids, or local endpoint
details in the primary path.

Markdown is review copy. The packet-completeness guard must read the structured
packet object, not infer completeness from Markdown prose. LLM-written prose is
narration only. It cannot decide or lower risk floor, reversibility, ownership,
authority/custody posture, evidence eligibility, packet completeness, or
approval eligibility.

Raw file diff and Phoenix evidence depth may be available as optional detail.
The top packet must stand alone if optional Phoenix depth is unavailable.

## Packet Object

Schema version:

```text
teami-proposal-packet/v1
```

Required top-level shape:

| Field | Meaning | Source rule |
| --- | --- | --- |
| `schema_version` | Packet object schema version. | Constant, currently `teami-proposal-packet/v1`. |
| `packet_use` | Whether this is a live render source or an illustrative mock. | Live code uses `live_candidate_render_source`; examples use `illustrative_mock`. |
| `source_of_truth.guard_reads` | Names the guard source. | Must be `structured_packet_object` for live packets. |
| `source_of_truth.markdown_role` | Names Markdown's role. | Must be `rendered_review_copy_only`; Markdown is never the guard source. |
| `source_of_truth.guard_status` | PKT-02 guard result when available. | PKT-01 renders `not_evaluated`; PKT-02 may write `passed` or `blocked`. |
| `proposal_identity` | Proposal id, candidate target key, and candidate kind. | Derived from the controller marker/envelope, not prose. |
| `consequence_headline` | One sentence naming what approval changes for the factory. | Product-language consequence, not branch/file mechanics. |
| `what_changes` | Bullet list of the behavior change. | Derived from materialized behavior summary and trusted target metadata. |
| `why_suggested` | Bullet list explaining why this is worth review now. | Derived from deterministic gate/evidence facts and sanitized standalone evidence summary. |
| `before_after_examples` | At least one concrete before/after example. | Derived from materialized behavior summary or explicit structured examples. |
| `evidence_cohort_summary` | Evidence quality, cohort counts, and standalone evidence summary lines. | Derived from deterministic gate facts and content-gated evidence summary. |
| `risk.deterministic_risk_floor` | Minimum risk label the UI must show. | Deterministic classifier/risk facts only; prose cannot lower it. |
| `risk.concrete_risk_reason` | Plain reason for the risk floor. | Deterministic risk explanation or safe fallback. |
| `risk.safe_default` | What the owner should do when unsure. | Always owner-protective; high risk defaults to decline or wait. |
| `authority_custody_access` | Access/custody before/after when applicable. | Explicit structured declaration. If not applicable, says no access or custody change is declared. |
| `undo_bounds` | What undo can and cannot reverse. | Structured copy; must name pre-approval and post-approval bounds. |
| `decline_path` | What declining does. | Must say the accepted behavior does not change and when the idea may return. |
| `marker` | Exactly one sentinel-bounded controller marker in rendered Markdown. | Machine-readable marker; not PM decision copy. |
| `optional_depth` | Optional Phoenix, technical change, and audit details. | Never required for the top decision path. |

Required `risk.deterministic_risk_floor` values:

```text
low_risk | high_risk | unknown
```

Live rendering treats missing or unknown risk facts as owner-protective review:
do not use absence of risk facts to make a proposal look safer.

## Marker Additions

Newly rendered proposal PR bodies carry a `packet` object inside the existing
`teami_promotion` marker:

```json
{
  "packet": {
    "schema_version": "teami-proposal-packet/v1",
    "source": "structured_packet",
    "guard_status": "not_evaluated",
    "copy_class": "review_carefully",
    "deterministic_risk_floor": "high_risk",
    "risk_reason_present": true,
    "evidence_cohort_summary_present": true,
    "before_after_examples_present": true,
    "undo_bounds_present": true,
    "authority_custody_access_present": false
  }
}
```

`packet.guard_status: not_evaluated` is not a packet-completeness pass. PKT-02
owns the guard and PR-creation barrier. PKT-01 only adds the structured marker
slot so WL-02 and PKT-02 can read packet/risk facts without scraping Markdown.
`packet.copy_class` is a renderer hint only; WL-02 must derive the final
owner-facing copy class from the full read-model merge order and must override
this hint whenever repair, GitHub state, evidence state, or rejection memory is
more owner-protective. The `*_present` booleans mean substantive, non-fallback
content was available to the packet builder; they are not a guard pass.

Old markers without `packet` remain readable for rejection memory and
migration compatibility. New renderer output must include `packet`.

PKT-01 also extends the marker repair-state enum to the WL-01 approved
vocabulary so later work can represent packet, evidence, branch, supersede, and
GitHub-connection repair without adding another queue:

```text
none
packet_completeness_repair_needed
evidence_repair_needed
phoenix_audit_retry_needed
supersede_retry_needed
branch_repair_needed
github_connection_repair_needed
```

This is schema support only. PKT-02 and WL-02 own writing and deriving those
states.

## Renderer Rules

The Markdown body renders from the structured packet in this order:

1. Consequence.
2. What changes.
3. Why suggested.
4. Before and after examples.
5. Evidence cohort summary.
6. Risk and safe default.
7. Authority and custody access.
8. Undo and decline.
9. Machine-readable marker.
10. Optional evidence, technical, and audit details.

The primary sections must use product-language copy. Optional details may carry
safe Phoenix links, technical version/hash/file-size data, sanitized candidate
excerpts, sanitizer reports, and disagreement disclosures. Optional details
must not contain credentials, token-shaped values, private bearer-style links,
or raw local internals barred by the custody contract.

## Guard Notes For PKT-02

PKT-02 should validate the structured object before live owner-review PR
creation. It should fail on missing consequence headline, missing before/after
example, missing evidence cohort summary, missing deterministic risk floor,
missing concrete risk reason, missing safe default, missing undo bounds,
missing decline path, incompatible bundled classes, self-approval attempts,
required evidence that is inaccessible, unsafe evidence links, and internal
deterministic gate or packet-prerequisite failures.

That guard checks judgeability and safety prerequisites. It does not decide
whether the owner should approve the product change.

## Illustrative Mock Packet: Ordinary Semantic

Non-authoritative mock for comprehension testing only. This is not live
evidence, not a guard pass, and cannot satisfy live acceptance.
`packet_use` is documentary; live enforcement comes from the real PR route,
valid marker shape, envelope facts, evidence ids, and PKT-02 guard result.

```json
{
  "schema_version": "teami-proposal-packet/v1",
  "packet_use": "illustrative_mock",
  "source_of_truth": {
    "guard_reads": "structured_packet_object",
    "markdown_role": "rendered_review_copy_only",
    "guard_status": "not_evaluated"
  },
  "proposal_identity": {
    "proposal_instance_id": "mock-ordinary-001",
    "candidate_target_key": "prompt/decomposition/pm_synthesis",
    "candidate_kind": "prompt"
  },
  "consequence_headline": "PM synthesis would ask for clearer user-facing acceptance criteria before agent work starts.",
  "what_changes": [
    "The PM synthesis role adds a stronger check for missing acceptance criteria.",
    "No access, repo authority, or custody behavior changes."
  ],
  "why_suggested": [
    "Recent decomposition evidence showed repeated tasks reaching execution without user-visible acceptance criteria.",
    "The proposed wording keeps work paused when the product decision is unclear instead of guessing."
  ],
  "before_after_examples": [
    {
      "label": "Ambiguous checkout request",
      "before": "The factory turns 'improve checkout' into implementation issues with no success definition.",
      "after": "The factory asks for the desired checkout outcome before writing agent-ready issues."
    }
  ],
  "evidence_cohort_summary": {
    "evidence_quality": "medium",
    "counts": [
      { "key": "train_examples", "label": "training examples", "value": 4 },
      { "key": "test_examples", "label": "held-out test examples", "value": 2 }
    ],
    "summary_lines": [
      "Examples with explicit acceptance criteria produced clearer execution issues.",
      "No human-labeled regression was observed in this mock packet."
    ]
  },
  "risk": {
    "deterministic_risk_floor": "low_risk",
    "concrete_risk_reason": "The change affects an accepted agent prompt and does not change gates, authority, custody, or approval rules.",
    "safe_default": "Decline if this would make early planning feel too slow; nothing changes unless approved."
  },
  "authority_custody_access": {
    "applies": false,
    "before": ["This packet did not declare a repo, Linear, credential, or evidence-custody access change."],
    "after": ["No after-state access or custody guarantee is made without an explicit declaration."],
    "safe_default": "Decline or wait if any access or custody effect is unclear."
  },
  "undo_bounds": {
    "before_approval": "Closing or declining the PR changes nothing.",
    "after_approval": "Undo requires a follow-up owner-reviewed proposal or manual revert.",
    "cannot_undo": ["Proposal history remains as review history."]
  },
  "decline_path": {
    "owner_action": "Close or decline the proposal PR.",
    "result": "The accepted factory behavior does not change.",
    "repeat_policy": "The same idea should return only if materially new evidence appears."
  },
  "marker": {
    "teami_promotion": {
      "schema_version": 1,
      "proposal_instance_id": "mock-ordinary-001",
      "requested_action": "propose_repo_change",
      "packet": {
        "schema_version": "teami-proposal-packet/v1",
        "source": "structured_packet",
        "guard_status": "not_evaluated",
        "copy_class": "decision_ready",
        "deterministic_risk_floor": "low_risk",
        "risk_reason_present": true,
        "evidence_cohort_summary_present": true,
        "before_after_examples_present": true,
        "undo_bounds_present": true,
        "authority_custody_access_present": false
      }
    }
  }
}
```

## Illustrative Mock Packet: Governance Meta

Non-authoritative mock for comprehension testing only. This is not live
evidence, not a guard pass, and cannot satisfy live acceptance.
`packet_use` is documentary; live enforcement comes from the real PR route,
valid marker shape, envelope facts, evidence ids, and PKT-02 guard result.

```json
{
  "schema_version": "teami-proposal-packet/v1",
  "packet_use": "illustrative_mock",
  "source_of_truth": {
    "guard_reads": "structured_packet_object",
    "markdown_role": "rendered_review_copy_only",
    "guard_status": "not_evaluated"
  },
  "proposal_identity": {
    "proposal_instance_id": "mock-meta-001",
    "candidate_target_key": "prompt/decomposition/decomposition_quality_judge",
    "candidate_kind": "prompt"
  },
  "consequence_headline": "The judge agent would apply stricter decomposition-quality guidance after approval.",
  "what_changes": [
    "The accepted judge-agent prompt changes its quality guidance.",
    "The proposal does not change promotion policy, proposal machinery, credentials, or write authority."
  ],
  "why_suggested": [
    "Recent decomposition examples show repeated weak acceptance criteria.",
    "The owner sees the same PR path with explicit target and evidence facts before any accepted behavior changes."
  ],
  "before_after_examples": [
    {
      "label": "Judge-agent prompt behavior",
      "before": "The judge agent scores vague acceptance criteria too generously.",
      "after": "The judge agent requires concrete observable outcomes before marking the decomposition strong."
    }
  ],
  "evidence_cohort_summary": {
    "evidence_quality": "medium",
    "counts": [
      { "key": "fixtures", "label": "deterministic governance fixtures", "value": 6 }
    ],
    "summary_lines": [
      "Fixtures cover accepted prompt edits and mixed ordinary plus governance bundles.",
      "This mock does not use live evidence and cannot pass acceptance."
    ]
  },
  "risk": {
    "deterministic_risk_floor": "high_risk",
    "concrete_risk_reason": "This changes judge-agent behavior used to evaluate future decomposition quality, so the reviewer should inspect the evidence carefully.",
    "safe_default": "Decline or wait unless the before/after judge behavior matches your intended quality bar."
  },
  "authority_custody_access": {
    "applies": false,
    "before": ["This packet did not declare a repo, Linear, credential, or evidence-custody access change."],
    "after": ["No after-state access or custody guarantee is made without an explicit declaration."],
    "safe_default": "Decline or wait if the governance change appears to expand access or leaves custody unclear."
  },
  "undo_bounds": {
    "before_approval": "Closing or declining the PR changes nothing.",
    "after_approval": "Undo requires a follow-up owner-reviewed governance proposal or manual revert.",
    "cannot_undo": [
      "Any future proposals evaluated while the approved governance rule was live may need separate review."
    ]
  },
  "decline_path": {
    "owner_action": "Close or decline the proposal PR.",
    "result": "The accepted governance behavior does not change.",
    "repeat_policy": "The same governance change should return only if materially new evidence appears."
  },
  "marker": {
    "teami_promotion": {
      "schema_version": 1,
      "proposal_instance_id": "mock-meta-001",
      "requested_action": "propose_repo_change",
      "packet": {
        "schema_version": "teami-proposal-packet/v1",
        "source": "structured_packet",
        "guard_status": "not_evaluated",
        "copy_class": "review_carefully",
        "deterministic_risk_floor": "high_risk",
        "risk_reason_present": true,
        "evidence_cohort_summary_present": true,
        "before_after_examples_present": true,
        "undo_bounds_present": true,
        "authority_custody_access_present": false
      }
    }
  }
}
```
