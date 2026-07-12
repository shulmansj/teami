# Phase 2 Worklist Event Read Model

Status: Distribution-pivot Phase 2A contract
Date: 2026-06-17

This contract defines the Phase 2 proposal/worklist state source map. It is a
read-model contract only: it does not implement packet guards, PR rendering,
GitHub routing, scanner behavior, a durable ledger, recovery workflows, or a
new product dashboard.

The worklist is a derived answer to "what needs my judgment or repair right
now?" It must be recomputed from existing facts: PR markers, local promotion
registry rows, scanner health, and read-time GitHub/Phoenix facts. It must not
introduce a second queue, second approval store, or second place for an owner
to wonder whether behavior work is waiting.

Primary sources:
[`teami-product-trust-record.md`](teami-product-trust-record.md),
[`authority-custody-defaults.md`](authority-custody-defaults.md),
[`meta-change-classifier-contract.md`](meta-change-classifier-contract.md),
the Phase 2 state ownership table in the distribution-pivot breakdown, and the
current promotion scanner, registry, marker, disagreement, and CLI worklist
code. This contract copies that state ownership into a committed source for
downstream WL/PKT/PROOF work; future verification should use this file rather
than relying on the external breakdown artifact being present.

## Owner Loop Boundary

The only normal recurring owner loops in this slice remain:

1. Move Linear product work to `Planned`.
2. Approve or decline Teami behavior-change PRs in GitHub.

Worklist states for evidence, GitHub connection, packet repair, scanner health,
or local runtime health may appear only when they block one of those loops.
They are not a third recurring owner judgment loop, maintenance feed, or PM
dashboard.

Primary owner-facing copy stays product-language:

| Copy class | Owner-facing shape | When used |
| --- | --- | --- |
| `decision_ready` | "Ready for you: review this behavior change." | A proposal packet is complete enough for approve/decline. |
| `review_carefully` | "High risk - review carefully." | The deterministic risk/classifier facts say the owner should inspect the consequence and safe default closely. |
| `blocked_for_repair` | "Work is paused until this can be repaired." | A proposal or source fact is not judgeable or not safe to route. |
| `fyi_receipt` | "Recorded; no decision is needed." | Something was observed, suppressed, closed, superseded, or received without asking for judgment. |
| `internal_only` | No owner-facing row by itself. | Raw candidate/status facts that do not yet block Linear work or behavior PR review. |

Primary copy must not require Git, npm, Node, token, raw diff, branch name,
check-log, Phoenix ID, endpoint, credential internals, or stack-trace interpretation. Those
details may appear only as optional technical depth.

FYI receipts reach the owner only when they are tied to a behavior PR decision
or a repair blocker.
Raw candidate discovery is operator/internal status until it becomes a
decision-ready PR or blocks one of the two owner loops.

## Source Surfaces

| Source surface | Durable? | One writer | Read-model use | Authority rule |
| --- | --- | --- | --- | --- |
| PR marker in GitHub PR body | Yes, repo-visible | Promotion controller marker writer through the allowlisted GitHub PR body path; packet guard supplies fields through that writer | Proposal identity, packet state, risk, repair, supersede/block state, evidence handles | Owns owner-review proposal facts. A readable marker is required for proposal worklist states. |
| GitHub PR state | Yes, in GitHub | GitHub plus owner action; Teami may only create PRs or update PR bodies through the allowlisted client | Open/closed/merged state, current PR URL, branch/merge status when available | GitHub owns acceptance/decline surface. Local cache cannot override it. |
| Local promotion registry row | Yes, local recovery/cache | Promotion controller creates rows via `writeRegistryFile` and appends events via `appendRegistryStage` | Envelope recovery, retryable block facts, pre-PR failures, PR reuse facts, local receipt joins | Recovery/cache only. It does not own acceptance, rejection memory, budgets, or owner decisions. |
| Scanner ledger and health | Yes, local cache/status | Promotion scanner via `writeLedgerAndHealth` | Candidate signals, scan health, evidence repair summaries, repo-marker access health | Cache/status only. It can surface blockers but cannot create acceptance authority. |
| Read-time Phoenix/evidence facts | Not durable in the worklist | Phoenix/eval/evidence flows own their records | Evidence reachability, annotation/disagreement availability, degraded evidence checks | Phoenix is optional evidence depth; the PR packet must stand alone. |
| Derived worklist output | No | No durable writer; WL-02 recomputes it | Owner-facing summary across the surfaces above | Transient output only. It must never be treated as queue state. |

Each durable fact has one writer. WL-02 is the single derived worklist consumer
for Phase 2; PKT-02 may also consume the same facts for the packet guard. No
consumer may write a parallel state row to make worklist rendering easier.
The registry files and scanner ledger/health currently share
`.teami/promotion-candidates/`, but filename co-location is not
ownership co-location: scanner files are scanner-owned, registry rows are
controller-owned.

## State Source Map

| State | Source fact or field | Lives in | Durable or read-time derived | One durable writer | Derived consumer | Copy class | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `candidate-created` | Scanner ledger entry with `candidate_key`, `source`, `candidate_target_key`, evidence ids, and candidate status; explicit manual promotion may also create the registry `validated` event for the same normalized envelope | Scanner ledger; local registry when the controller is invoked directly | Durable local cache/recovery | Scanner writes scanner entries; promotion controller writes registry rows | WL-02 | `internal_only` unless it becomes decision-ready or blocked | Candidate creation is not owner approval and does not create an owner worklist row by itself. WL-02 dedupes scanner+registry views by PR number or `proposal_instance_id` when present, then by `normalized_envelope_hash` where both sides carry it, then by `candidate_target_key` + `candidate_version_id` + request/evidence hash. |
| `PR opened/updated` | Readable PR marker plus GitHub PR state `open`; registry `pr` field is only recovery/reuse support | PR marker; GitHub PR state; local registry cache | Durable in GitHub/marker; registry cache | Promotion controller PR create/update-body path | WL-02, PKT-02 | `decision_ready` when packet is complete | The PR marker and GitHub PR state are the owner-visible source. Registry-only PR facts must be refetched or treated as cache. Packet guard fields enter the marker through the same serialized marker writer. |
| `packet-complete` | Structured packet guard result, including packet schema version, required product summary, before/after example, risk label/reason, evidence summary, undo bounds, and guard status | PR marker / structured packet object; registry only for pre-PR guard failures | Durable once PKT-02 writes it; read-time until then | PKT-02 packet guard through the promotion controller marker writer | WL-02, PKT-02, PROOF-01 | `decision_ready` | Current marker/schema cannot prove this from Markdown alone. PKT-01/PKT-02 must add a structured fact; WL-02 must not infer completeness from prose. |
| `high-risk-review-carefully` | Deterministic risk/classifier fact such as `promotion_risk: high_risk`, `meta_change`, `authority_change`, `unknown_sensitive`, concrete risk reason, and safe default | Structured packet/PR marker; current local registry `labels.promotion_risk` may support local recovery | Durable once rendered into the packet/marker | GOV-02 classifier/risk derivation consumed by PKT-01/PKT-02 rendering | WL-02, PKT-02, VAL-01 | `review_carefully` | LLM prose, PR body claims, annotations, or project text cannot lower the risk. The safe default is to decline or wait when unsure. |
| `failed check` | Deterministic gate or packet-prerequisite failure: registry `gate.verdict`, `failed_condition_ids`, `outcome.reason`, packet guard failures, or scanner display class `evidence_needs_repair` | Local registry; scanner ledger/health; future packet guard fact | Durable local cache/recovery | Deterministic gate or PKT-02 packet guard writes the registry/guard fact; scanner writes scanner display rows | WL-02, PKT-02 | `blocked_for_repair` | GitHub Checks/status/ruleset facts are not assumed in Phase 2 unless a later issue explicitly adds and tests them. |
| `branch conflict` | Read-time GitHub PR merge/branch conflict fact when available, or controller validation reason such as `branch_envelope_mismatch`, `orphan_promotion_branch_requires_repair`, `registry_pr_branch_mismatch`, `registry_pr_not_namespaced`, or `registry_pr_marker_envelope_mismatch` | Read-time GitHub fact; local registry retryable/blocked event | Read-time for PR mergeability; durable local recovery for controller validation failures | GitHub owns live PR branch facts; promotion controller writes registry validation failures | WL-02, PKT-02 | `blocked_for_repair` | Owner copy says the proposal cannot be checked safely until repaired. Branch names stay optional technical depth. |
| `evidence degraded` | Scanner health `phoenix_scan.ok: false`, trace/evidence health, disagreement report `checked: false`, human annotation read failures, PR marker or registry `repair_state: phoenix_audit_retry_needed`, or packet guard evidence-access failure | Scanner health; read-time Phoenix/evidence facts; PR marker/local registry repair state | Mixed: durable local status plus read-time Phoenix checks | Scanner writes scanner health; promotion controller writes PR marker/registry repair state; evidence flows write their own evidence records | WL-02, PKT-02 | `blocked_for_repair` when required evidence is missing; otherwise `review_carefully` or `fyi_receipt` with a plain evidence-quality note | Optional Phoenix depth may degrade without blocking if the packet remains judgeable. Required evidence degradation blocks owner approval until repair. |
| `rejection memory` | Closed, unmerged GitHub PR with a readable same-target marker inside the policy lookback, excluding markers with `proposal_state` `superseded` or `blocked`; materially new evidence comes from an append-only receipt amendment when available | Read-time GitHub closed PR state plus PR marker | Durable in GitHub/marker, derived at read time | Owner/GitHub writes close state; promotion controller wrote the original marker | WL-02, PROOF-01 | `fyi_receipt` | Local registry cannot override rejection memory. The product says the same idea will not keep returning unless materially new evidence exists. |
| `undo/close` | GitHub PR closed/unmerged state, merged state when available, marker `proposal_state` (`proposed`, `superseded`, `blocked`), packet undo bounds, and existing registry/scanner receipt ids when already present | GitHub PR state; PR marker; existing local registry/receipt cache for Phase 2 proof | Durable in GitHub/marker; existing local receipts are cache until Phase 3 ledger | Owner/GitHub writes close/merge state; promotion controller writes marker supersede/block and existing registry receipt facts | WL-02, VAL-01 | `fyi_receipt` or `blocked_for_repair` | Pre-merge close means "nothing changed" unless the packet states otherwise. Do not seed future-ledger identity fields in Phase 2; full post-merge rollback/recovery remains later Phase 4/ledger work. |
| `blocked-for-repair` | PR marker `proposal_state: blocked` plus `repair_state`; for pre-PR blocks, local registry `outcome: blocked`, `retryable`, `repair_state`, and scanner health `status: blocked/degraded` | PR marker when a PR exists; local registry/scanner health before PR or for connection blockers | Durable in marker/registry/health | PKT-02 packet guard and promotion controller write marker/registry repair facts; scanner writes scanner health | WL-02, PROOF-01, VAL-01 | `blocked_for_repair` | Current marker only accepts `none` and `phoenix_audit_retry_needed`. Registry `supersede_retry_needed` is usable today through the merge order below; packet, branch, and connection repair meanings need approved marker/registry support before WL-02 can claim them. |
| `FYI receipt` | Registry/scanner receipt facts such as withdrawn/no-action, evidence found without requested change, improvement opportunity without proposed change, superseded PR marker, or closed-unmerged PR; engine updates arrive as occasional version-bump PRs the owner merges, not as recurring FYI receipts in this slice | Local registry/scanner health; PR marker/GitHub state; Phase 7 engine update PR channel later | Durable where the underlying receipt/fact lives; worklist row is derived | Promotion controller/scanner writes Phase 2 receipts; Phase 7 will own engine version-bump PR channel receipts | WL-02, PROOF-01 | `fyi_receipt` | FYI receipts are not a recurring decision loop or raw candidate feed. Engine updates are occasional version-bump PRs (merge to take; deferred beyond this Phase 2 contract); they do not appear as recurring FYI receipts in this slice. |

## Approved Repair State Vocabulary

The Phase 2 worklist may derive `blocked-for-repair` only from one of the
approved source facts above. Future PKT/WL implementation may extend marker or
registry enums with these repair meanings, but must not create a new queue:

| Repair meaning | Preferred durable source | Owner copy |
| --- | --- | --- |
| `packet_completeness_repair_needed` | PR marker when a PR exists; local registry before PR creation | "The proposal is missing information needed for a fair decision." |
| `evidence_repair_needed` | Packet guard fact, scanner health, or registry block | "Evidence is incomplete; repair it before deciding." |
| `phoenix_audit_retry_needed` | Current PR marker/local registry repair state | "The proposal exists, but the evidence record needs repair." |
| `supersede_retry_needed` | Local registry today; PR marker only after enum support exists | "An older proposal could not be marked as replaced yet." |
| `branch_repair_needed` | Read-time GitHub fact or registry branch validation reason | "The proposal cannot be checked safely until repaired." |
| `github_connection_repair_needed` | Scanner health or registry GitHub access/listing/marker-read failure | "The connection to the behavior rules needs repair before proposals can be checked." |

If a needed owner-visible state cannot be derived from these facts, WL-02 or
PKT-02 must mark it as not representable and block or omit the state. It must
not invent a queue row, durable worklist item, or PM-facing status store.

## Read Merge Order

WL-02 must merge overlapping facts by source authority, not by newest timestamp
or easiest file read:

1. GitHub PR state is authoritative for whether an owner-review PR is open,
   closed, merged, or missing. A stale registry `pr` row cannot keep a closed
   PR decision-ready.
2. A readable PR marker is authoritative for the marker fields it can carry:
   proposal identity, `proposal_state`, marker-supported `repair_state`, and
   future packet/risk fields once added. An unreadable marker on a controller
   namespace PR blocks the proposal worklist state instead of being ignored.
3. The local registry overlays only cache/recovery facts and marker-unsupported
   repair states, including current `supersede_retry_needed`, `null`/in-flight
   registry repair, pre-PR packet failures, branch validation failures, and
   retryable controller blocks. The registry cannot clear a marker repair
   state, reopen a closed PR, or override rejection memory.
4. Scanner ledger/health supplies candidate signals and scan/connection/evidence
   health before or around controller invocation. It cannot override GitHub PR
   state, readable PR markers, or registry recovery facts for an existing
   envelope.
5. Read-time Phoenix/evidence checks may degrade or block packet judgment when
   required evidence is inaccessible. They cannot make an incomplete packet
   complete or make optional Phoenix depth required when the packet is otherwise
   judgeable.

When multiple derived states apply to the same proposal, WL-02 uses the most
owner-protective copy class in this order: `blocked_for_repair`,
`review_carefully`, `decision_ready`, `fyi_receipt`, then `internal_only`.

## Current Representability Gaps

The existing code does not yet fully represent every Phase 2 state:

- `packet-complete` is not derivable from the current PR marker or Markdown PR
  body. PKT-01/PKT-02 must add a structured packet/guard fact before WL-02 can
  show this as decision-ready.
- `blocked-for-repair` for packet completeness, branch repair, and GitHub
  connection repair is not fully representable in the current PR marker enum.
  Supersede repair is represented in the registry today, not the marker. WL-02
  must apply the read merge order above and must not claim the PR marker carries
  marker-unsupported repair meanings.
- `branch conflict` is not a standalone durable proposal state today. It is
  either a read-time GitHub PR fact or a controller validation failure recorded
  in the registry.
- `FYI receipt` for engine version-bump PRs is Phase 7 work. Phase 2 can only
  render FYI rows from proposal, scanner, PR, and proof receipts that already
  exist.

These gaps are reasons to block or defer implementation states, not reasons to
introduce another store.

## Structured Review Checklist

Use this checklist for WL-02, PKT-01, PKT-02, PROOF-01, and persona validation:

- S1 preserved: the worklist surfaces only Linear `Planned` work and
  behavior-PR decisions as recurring owner loops.
- Connection/setup/evidence/repair states appear only when blocking one of
  those two loops.
- S5 preserved: source remains PR markers, local registry, scanner health, and
  read-time GitHub/Phoenix facts.
- No second queue, durable worklist database, PM dashboard, or hidden approval
  store is introduced.
- Each durable fact has exactly one writer, and WL-02 is the derived consumer.
- Candidate-created, PR opened/updated, packet-complete,
  high-risk-review-carefully, failed check, branch conflict, evidence degraded,
  rejection memory, undo/close, blocked-for-repair, and FYI receipt are all
  covered by this source map.
- Owner-facing copy says what is waiting, why it matters, what is blocked, and
  where to decide without making the owner interpret Git, npm, Node, token,
  raw diff, branch, check-log, Phoenix ID, endpoint, credential internals, or stack-trace
  mechanics.
- If a later implementation cannot derive a state from this map, it blocks or
  flags the gap instead of adding a second queue/store.
