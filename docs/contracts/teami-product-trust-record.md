# Teami Product Trust Record

Status: Distribution-pivot Phase 0A contract
Date: 2026-06-17

This is the product and trust record downstream distribution-pivot issues must
obey. It records the owner-visible contract, not setup UI, ledger schema,
package release channels, or implementation code. Changing the defaults below
requires a product decision, not a quiet implementation choice.

Primary in-repo sources: [product brief](../product-brief.md),
[state model](../state-model.md), [Linear project contract](../../execution/linear-project.md),
[operating model](../../docs/operating-model.md), and
[self-improvement](../../docs/self-improvement.md). This contract is the in-repo
summary of the distribution-pivot execution packet.

## Distribution-Pivot Scope

This record uses distribution-pivot ordering, not the adoption-stage phases in
`docs/adoption.md` and not the seven workflow steps in `docs/operating-model.md`.
The active slice is the trust and approval path: contracts, authority/custody
proofs, governance classification, worklist/read-model shape, proposal packets,
packet guards, one trace-driven proof, and persona validation.

Setup hardening, a durable ledger, migration compatibility, full recovery,
hosted or packaged runtime choices, maintainer-update delivery, and public
rollout remain later work. Later work may reuse this vocabulary, but it must
not claim these later capabilities are built just because this contract names
their required product shape.

## Product Promise

Teami helps a product-savvy, technical-adjacent founder, product
lead, PM, or engineering leader turn Linear-owned product intent into
accountable agent execution while keeping human judgment focused on product,
taste, scope, trust, quality, and business risk instead of routine technical
orchestration.

The product promise is not "automation everywhere." It is clear handoffs,
explicit state, evidence-backed review, and recoverable changes across the
systems the adopter already uses:

- Linear owns product intent and live work state.
- GitHub owns repo-changing proposals, checks, review, merge, and decline.
- Phoenix owns traces, annotations, datasets, experiments, evaluator results,
  and evidence inspection.
- Guided terminal agent sessions and doctor commands explain state, run
  workflows, guide repair, and produce receipts.
- Hosted inbox/status endpoints coordinate backend health; they are not a PM
  dashboard in v1.

Do not build a new PM dashboard, approval hierarchy, product repo picker, direct
product-work intake path outside Linear, or maintainer behavior channel for this
slice. Direct product-work intake outside Linear is out of scope unless a later
product decision adds it.

## Owner Loops

Within this distribution-pivot slice, the normal recurring owner judgment loops
are exactly:

1. Move Linear product work to `Planned`.
2. Approve or decline Teami behavior-change PRs in GitHub.

Setup, consent, health, drift, diagnostics, and repair are exceptional
connection states. They may appear in "what needs my
judgment?" only when they block one of the two loops above. They must not become
a third recurring owner judgment loop in this slice.

Execution-flow validation, release timing, customer communication, and user-visible
shipping tradeoffs remain human judgment surfaces owned by the operating model.
They are deliberately outside this approval-pivot contract, not forbidden.

The owner is the sole authority over their factory behavior. Behavior-changing
proposals, including high-risk, governance, meta, or authority-affecting
changes, require owner approval after the product presents the consequence,
old/new comparison, evidence, risk, and undo bounds clearly. V1 assumes the
humanized packet is sufficient for this technical-adjacent owner to approve or
decline; persona validation must prove that assumption before broad rollout.

Behavior-preserving maintainer updates are engine/tooling updates; they may not
alter adopter-owned prompts, policies, evals, thresholds, approval rules, or
self-improvement goals. If a maintainer-supplied baseline, migration, or asset
change alters behavior content, it is a behavior-change proposal through loop
2, or deferred until that proposal route exists. It is not a maintainer-update
receipt.

## Linear First Value

First visible value starts when the owner moves a sample or real Linear project
or work item to `Planned` in an Teami Linear team.

The first value wedge must produce a product-readable Linear artifact from that
intent: either a clearly labeled preview or actual Linear project update plus
at least one agent-ready Linear issue matching the issue contract, or an honest
pause/Open Questions outcome that explains what blocks decomposition and what
decision or discovery is needed next. A correct pause is first value when it
prevents unsafe or misleading execution.

When a bounded agent task runs, Teami reports what passed
verification, what stayed draft or preview, and what decision is next.

A reversible behavior-change proposal may be used after first value as an
optional trust rehearsal, or within maintainer validation only. The adopter can
reach first visible value and stop without making a behavior-change decision.

## Linear Team Model

Init asks the owner to choose a Linear workspace and name the initial Linear
team that will use Teami. Init creates or configures that team,
creates a private Teami behavior repo, starts Phoenix, and wires the
self-improvement loop. The current setup path is partially built; this contract
does not claim the later guided setup state machine, recovery matrix, or public
rollout is complete.

First-run copy must say that Teami does not touch product code unless
the owner later connects product repos on purpose.

After init, the owner may attach another Linear team through a deliberate owner
action. Attached Linear teams share the same Teami behavior repo and
accepted behavior. Projects, artifacts, product repos, and project history stay
independent. Adding teams must not surprise the owner with a permission
expansion or product repo picker.

## Loop Stack

The loop stack is product architecture, not five PM workflows.

| Loop | Product role | Primary trigger | Output | Human touchpoint | Proof boundary |
| --- | --- | --- | --- | --- | --- |
| Agent loop | Do bounded work with tools | Linear `Planned` work; guided request for judgment, setup, repair, diagnostics, or evidence-backed behavior-change drafting | Linear/GitHub artifact, preview, pause, or failure state | No routine judgment unless product direction is needed | This slice proves only the approval/worklist surfaces; broader setup/recovery stays later |
| Verification loop | Check quality and scope before trust | Agent result, PR update, or replayed run | Pass/fail feedback, evidence summary, or blocked-for-repair state | Owner sees consequence summary, not raw eval work | This slice proves packet/read-model guardrails |
| Event loop | Keep work moving without manual invocation | Linear, GitHub, runner, or supervisor event | Worklist/read-time state, receipt, or next action | Only the two recurring owner loops in this slice | This slice defines the read model; full production routing stays later |
| Learning loop | Improve adopter-owned behavior from traces | Repeated run evidence, failed verification pattern, or explicit owner request | Behavior-change PR in the behavior repo | Approve or decline behavior PR | This slice proves one trace-driven packet; durable ledger stays later |
| Maintainer update loop | Update engine/tooling without changing behavior | New engine version available | Version-bump PR the owner merges to take the update; pin previous to roll back | Owner merges or ignores the version-bump PR; no recurring cadence consent | Delivery channel stays later; behavior-changing baseline updates route through loop 2 |

Learning-loop PRs must cite concrete before/after examples from Linear work,
the evidence cohort or run set, and affected teams. Declined proposals create
rejection memory. A declined idea should not keep returning unless materially
new evidence exists.

## PM Surfaces And Evidence

The product uses existing surfaces and makes them coherent:

- Linear: product work, generated project updates, execution issues, blockers,
  and safe live work-state updates.
- GitHub PRs: the primary behavior-change decision packet and accept/decline
  action in MVP.
- Phoenix: evidence depth for traces, annotations, datasets, prompt versions,
  experiments, and evaluator results.
- Guided terminal agent/doctor: product-state summaries, links, repair,
  diagnostics, and receipts.
- Hosted status: diagnostic/operator health only unless a later product
  decision creates a PM-facing status product.

Phoenix is evidence, not the PM's required reading path. A behavior PR and
guided summary must explain what changes, why it matters, what can go wrong,
what evidence supports it, what approval means, and what decline or undo does
without requiring raw traces, Phoenix IDs, check logs, commits, branch names,
token mechanics, endpoint names, or broker design. Phoenix links are optional
depth for inspection and annotation.

## Terminal Concierge

Guided terminal sessions are a user experience surface. They may show product
states, decisions, links, receipts, and guided repair actions. Primary copy must
not expose raw stack traces, Git commands, npm or Node failures, token values,
remotes, branch names, Phoenix object IDs, runner/supervisor internals, broker
internals, or endpoint names unless the user explicitly asks for technical
detail.

When Teami cannot continue safely, the terminal concierge says what
is known, what is safe, what action is blocked, and which self-serve repair or
user-initiated diagnostic export path is next.

## Runtime Presence

Runtime presence is a product requirement. An adopter cannot be expected to
keep `npm run runner` alive by hand.

The v1 product default is a visible, consented runtime-presence path such as a
local supervisor, background service, or OS autostart. Machine-off work queues
or pauses and reconciles at next login; no hosted execution is implied. Runtime
liveness must be visible through the established Linear/GitHub/Phoenix/guided-agent
surfaces, not a separate PM dashboard.

## First-Run Requirements

This record names first-run state-machine requirements only. It does not claim
the later guided setup state machine is built.

The later guided setup state machine must include states equivalent to:

- `setup-not-started`
- `consent-pending`
- `workspace-and-team-confirmed`
- `behavior-repo-creating`
- `phoenix-starting`
- `self-improvement-wiring`
- `runtime-presence-configuring`
- `connected-healthy`
- `taking-longer-than-expected`
- `evidence-degraded`
- `repair-needed`
- `ready-for-first-value`

Slow-setup copy for `taking-longer-than-expected` must say what is still pending, whether
anything has changed, whether it is safe to close and return, and what
self-serve repair or user-initiated diagnostic export path is next.

Evidence-degraded copy for `evidence-degraded` must say what evidence is missing or incomplete,
whether product work can still proceed, whether a behavior decision is blocked,
how later evidence repair works, and where optional Phoenix evidence will
appear. It must not ask the user to interpret Phoenix IDs, loopback ports,
Python install mechanics, trace payloads, or evaluator internals.

## User Language Boundary

Primary PM-facing language must describe product consequence and safe next
action. Internal terms such as `route_to_hitl`, `promotion_candidate`,
envelope, commit trailer, endpoint allowlist, fail-closed, wake lease, broker,
and tier labels stay in maintainer docs, machine markers, or technical
appendices.

Allowed PM translations include "ready for you," "high risk - review
carefully," "not enough evidence," "safe to decline," "make this rule live,"
"work is paused," "nothing changed," and "undo available/not available."

## Attention Routing

This contract records the matrix shape and seed rows. Later recovery/setup work
must expand this to one row per known broken condition.

| Condition | PM landing surface | Product copy shape | Owner action | Notes |
| --- | --- | --- | --- | --- |
| Linear work moved to `Planned` and ready | Linear project/update; guided agent summary optional | What work is starting, what will be created, and where results will appear | None unless product questions arise | First recurring owner loop |
| Behavior-change PR ready | GitHub PR plus guided agent summary; Phoenix optional | What behavior changes, evidence, risk, approval meaning, decline path, undo bounds | Approve or decline PR | Second recurring owner loop |
| Evidence degraded | GitHub/worklist blocked state plus guided agent/doctor; Phoenix optional | What evidence is missing, what is still safe, and what repair will restore | Repair or wait; no approval asked if packet is not judgeable | Do not make raw Phoenix a required path |
| `runner-offline` | Guided agent/doctor; Linear update only if Linear can be updated honestly | Work is waiting because local automation is not present; say whether queued, paused, or stale | Start/repair runtime presence or let supervisor recover | Must not ask PM to babysit commands |
| `linear-cannot-update` | Guided agent/doctor; diagnostic-only hosted status if needed | Work could not be recorded in Linear; say whether anything changed elsewhere | Reauthorize, repair workspace/team/status, or export diagnostics | Do not claim Linear changed |
| Engine version-bump PR | Dependabot/Renovate-style version-bump PR in the behavior repo | Engine/tooling update available; merge to take, pin previous to roll back; behavior unchanged | Merge or ignore; no recurring judgment required | Delivery channel stays later; not a behavior-change loop |

## Repair Matrix Shape

Later recovery/setup work owns the full repair matrix. Each row must include:

| Field | Meaning |
| --- | --- |
| `condition` | Broken connection or failed invariant |
| `symptom` | What the PM notices |
| `broken_connection` | Linear, GitHub, Phoenix, runner, behavior repo, hosted inbox, broker, credential, engine, or schema |
| `safety_state` | Whether anything changed and whether continuing is safe |
| `work_state` | Queued, paused, stale, safe, potentially lost, or not started |
| `who_can_fix` | Adopter, Linear admin, GitHub/org admin, system repair, maintainer release, or no one without recreating state |
| `repair_route` | One-tap repair, guided multi-step repair, admin/out-of-band action, rollback, revoke/rekey, restore, or diagnostic export |
| `diagnostic_export` | Whether a redacted user-initiated bundle is available and what it excludes |
| `adopter_copy` | Primary product-language explanation |

Required seed rows:

| Condition | Symptom | Safety state | Work state | Who can fix | Repair route |
| --- | --- | --- | --- | --- | --- |
| `runner-offline` | "I moved work to `Planned` and nothing happened." | No unattended local mutation is happening | Queued or paused until runtime resumes | Adopter or system supervisor | Start or repair runtime presence; export diagnostics if repeated |
| `linear-cannot-update` | "The factory finished something but Linear did not change." | Do not mark work live unless Linear records it; retry from persisted artifact when available | Paused until Linear repair succeeds | Adopter, Linear admin, or system repair depending on cause | Reauthorize, repair workspace/team/status, retry commit, or export diagnostics |

Recovery categories later recovery work must preserve:

- pre-merge rejection
- post-merge asset revert
- consumed-change recovery
- engine rollback
- schema rollback
- Linear/GitHub repair
- meta-change rollback
- Phoenix loss/corruption
- local credential missing
- credential exposed/lost-device revoke

Every proposal must state whether it is reversible, what undo changes, what undo
cannot reverse, whether downstream runs have already consumed the change, and
whether external side effects exist.

## Consent Inventory

Future setup consent copy is product work. Each consent moment must use this
table shape:

| Consent moment | Requested access | Why needed | Repo/workspace scope | Created or changed | Product repos touched? | How to revoke | Scope class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub App installation for behavior repo | TBD by authority/custody contract | Create and verify the private behavior repo | System-created Teami behavior repo by repo id | Behavior repo access and verification | No in normal v1 setup | TBD by authority/custody contract | Fixed-scope v1 setup |
| GitHub user authorization | TBD by authority/custody contract | Let the owner review/decline/approve PR-based behavior changes | Owner account and behavior repo | Authorization record | No in normal v1 setup | TBD by authority/custody contract | Fixed-scope v1 setup |
| Linear OAuth authorization | Linear access through Teami OAuth and GraphQL | Read product intent and write validated Linear artifacts | Chosen Linear workspace/team | Reads, project updates, issues, issue relations, status changes as validated | No | Revoke Linear app authorization | Fixed-scope v1 setup |
| Linear workspace and initial team | Workspace choice and team name | Create/configure the product work container | Chosen Linear workspace and named team | Teami team/status/labels/template as needed | No | Remove/disconnect team through setup repair path | Fixed-scope v1 setup |
| Setup grant scope and lifetime | TBD by authority/custody contract | Complete setup without asking for repeated technical grants | Explicit setup scope only | Setup-time resources only | No unless later deliberate product-repo setup is added | TBD by authority/custody contract | Fixed-scope v1 setup |
| Runtime presence/local supervisor | Permission to keep local work moving after login through the selected local runner mode | Avoid manual runner babysitting | Local machine scope | Supervisor/runner registration and liveness reporting | No | Disable/unregister runtime presence | Fixed-scope v1 setup |
| Engine version-bump PR channel | Consent to receive engine version-bump PRs (Dependabot/Renovate-style) | Keep engine secure and compatible without changing behavior | Behavior repo; version-bump PR opened when a new engine version is available | Version-bump PR, rollback anchor, version record | No | Disable or ignore version-bump PRs; deferred | Deferred fixed-scope setup item |
| Data capture and telemetry disclosure | Local trace/eval capture and explicit diagnostic sharing | Support evidence, learning, repair, and user-initiated support | Local Phoenix/eval store and redacted diagnostic bundle | Traces, annotations, datasets, experiments, receipts | No by default | Delete/retain per data policy; choose whether to share diagnostics | Fixed-scope v1 setup |
| Deliberate new setup/configuration scope | Explicitly named new access | Only when a later product decision adds scope | Named repo/workspace/account | Named changes only | Must say yes or no plainly | Must provide revoke path before use | Deliberate new setup/configuration scope |

The table shape is mandatory even when a later contract fills details. The copy
must plainly say whether the consent is fixed-scope v1 setup or a deliberate
new setup/configuration scope.

## Success Receipt

Every first-value run and every behavior-change PR decision needs a
product-language receipt at the point Teami can honestly observe with
today's scoped machinery. Do not imply post-merge Linear/status updates until a
merge or acceptance observer is explicitly scoped.

The receipt must say:

- what was created or changed.
- where it lives.
- what is draft/preview versus live.
- whether Linear, Phoenix, GitHub, and the behavior repo were updated.
- what evidence quality is available and whether anything is degraded.
- what decision, if any, is next.
- what undo, restore, repair, or revoke path exists.
- what cannot be undone.

If nothing changed, the receipt says "nothing changed" and names the next safe
action. If a surface could not be updated, the receipt names that broken
connection in product terms and points to the repair route.
