# GitHub Local Ambient UAT

Run: github-local-uat-20260625T045721-8d4eda
Branch: agentic-factory/promotion/af-uat-github-local/20260625T045721

This disposable proposal proves the behavior repo GitHub write path uses local ambient git/gh auth.

## Consequence

GitHub local ambient write path would change accepted factory behavior; review the evidence and safe default carefully before approval.

## What changes

- Accepted behavior for GitHub local ambient write path changes only if this proposal is approved.
- Adds reviewer-visible guidance: GitHub local ambient UAT.

## Why suggested

- Deterministic evaluation found enough supporting evidence to ask for owner review.
- Run github-local-uat-20260625T045721-8d4eda pushed agentic-factory/promotion/af-uat-github-local/20260625T045721.
- GitHub selection mode local_ambient with brokerClient null.

## Before and after examples

- GitHub write custody: Before: A broker-backed GitHub write path could create ambiguity about whose credential opened the PR. After: This disposable PR is created with the adopter's local git and gh auth; no broker client is selected.

## Evidence cohort summary

- Cohort: training examples=0; held-out test examples=1; human label authenticity=local_uat.
- Run github-local-uat-20260625T045721-8d4eda pushed agentic-factory/promotion/af-uat-github-local/20260625T045721.
- GitHub selection mode local_ambient with brokerClient null.
- Run window: 2026-06-25T04:57:21.839Z to 2026-06-25T04:57:21.839Z (github_local_uat_harness).
- Run-set digest: sha256:9cbd3f46f99a9dd0d83865204789527463d145bed5cb7192ad2ea53081a8ecfc.
- Affected teams: not recorded.
- Safe Phoenix evidence handles: experiment github-local-uat-20260625T045721-8d4eda; dataset github-local-uat version 2026-06-25T04:57:21.839Z.

## Risk and safe default

- Deterministic risk floor: High risk - review carefully
- Evidence quality: medium (deterministic advisory).
- Concrete risk reason: This is a live GitHub side-effect proof; the harness closes the disposable PR and deletes the test branch by default.
- Safe default: Decline or wait when unsure; nothing changes unless you approve.
- Machine-drafted candidate (agentic_factory_github_local_uat)

## Authority and custody access

- Access or custody change: yes, review the before/after plainly.
- Before: The harness starts from the local GitHub connection state.
- After: The PR branch agentic-factory/promotion/af-uat-github-local/20260625T045721 is pushed with local ambient https auth and opened through gh api.
- Safe default: Close the disposable PR; accepted factory behavior does not change.

## Undo and decline

- Before approval: Closing or declining the PR changes nothing in accepted factory behavior.
- After approval: Undo requires a follow-up owner-reviewed proposal or a manual revert of accepted behavior; this packet does not claim full rollback automation.
- Cannot undo automatically: Evidence and proposal history already recorded for review remain as history.
- Cannot undo automatically: If future runs consume an approved behavior before undo, those downstream effects need separate review.
- Decline path: Close or decline the proposal PR. The accepted factory behavior does not change.
- Repeat policy: The same idea should return only if materially new evidence appears.

## Provenance

- Source run: github-local-uat-20260625T045721-8d4eda.
- Experiment receipt: github-local-uat:github-local-uat-20260625T045721-8d4eda.
- Phoenix experiment: github-local-uat-20260625T045721-8d4eda.
- Promotion identity: proposal prop-8f05d21939a6; envelope 9cbd3f46f99a9dd0d83865204789527463d145bed5cb7192ad2ea53081a8ecfc.
- GitHub write custody: GitHub mode local_ambient; push auth https.

## Machine-readable marker

<!-- agentic_factory_promotion:begin -->
```json
{
  "agentic_factory_promotion": {
    "schema_version": 1,
    "proposal_instance_id": "prop-8f05d21939a6",
    "requested_action": "propose_repo_change",
    "candidate_target_key": "prompt/decomposition/sr_eng_grounding_pass",
    "candidate_kind": "prompt",
    "candidate_version_id": "github-local-uat-332b4645ad1c",
    "accepted_baseline_id": "github-local-uat-baseline",
    "normalized_envelope_hash": "9cbd3f46f99a9dd0d83865204789527463d145bed5cb7192ad2ea53081a8ecfc",
    "policy_hash": "328cf1bde6a8e3ca20c67f32fca2d27e6cfd1c3f9f43cf315446e86d513e21be",
    "phoenix_scope": {
      "origin": "http://127.0.0.1:6006",
      "project_name": "agentic-factory"
    },
    "evidence_ids": {
      "experiments": [
        "github-local-uat-20260625T045721-8d4eda"
      ],
      "datasets": [
        {
          "dataset_id": "github-local-uat",
          "dataset_version_id": "2026-06-25T04:57:21.839Z"
        }
      ],
      "annotations": []
    },
    "accept_cross_version_comparison": false,
    "proposal_state": "proposed",
    "superseded_by": null,
    "repair_state": "none",
    "packet": {
      "schema_version": "agentic-factory-proposal-packet/v1",
      "source": "structured_packet",
      "guard_status": "not_evaluated",
      "copy_class": "review_carefully",
      "deterministic_risk_floor": "high_risk",
      "risk_reason_present": true,
      "evidence_cohort_summary_present": true,
      "before_after_examples_present": true,
      "undo_bounds_present": false,
      "authority_custody_access_present": true
    }
  }
}
```
<!-- agentic_factory_promotion:end -->


<details><summary>Optional technical change detail</summary>

- Raw file diff is optional technical depth in the PR files view; it is not required to understand the packet.

</details>

<details><summary>Audit details</summary>

Sanitizer report:

- content_gate_version: github-local-uat/v1
- removed_count: 0
- transformed_count: 0

</details>
