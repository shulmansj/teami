# Promotion Acceptance Policy

This document owns the acceptance posture for repo promotions: what happens
after the promotion controller has packaged evidence and drafted a
process-change proposal, who decides whether the change becomes accepted
behavior, and what would have to exist before any of that decision could ever
be automated.

Acceptance policy is deliberately separate from the two labels the
controller assigns, which are RUBRIC-DERIVED ADVISORIES: deterministic rubrics
over process-change-gate facts (no model judgment, prose never read), advisory
for the human reviewer and never able to waive a mechanical gate. `evidence_quality: high | medium | low` describes how well
grounded the eval evidence is. `promotion_risk: low_risk | high_risk`
describes the blast radius of the proposed change. Neither label mechanically
determines the other, and neither label decides acceptance. Acceptance is a
policy boundary of its own.

The mechanical knobs that exist today live in the repo-owned policy artifact
[`execution/evals/decomposition/promotion-policy.json`](../execution/evals/decomposition/promotion-policy.json)
(disable flag, lookback window, proposal budgets, eligible experiment launch
sources, required evidence ID kinds, and risk defaults). That file
intentionally contains **no auto-acceptance configuration**: there is nothing
to switch on. The controller contract itself is documented in
[`execution/evals/decomposition/README.md`](../execution/evals/decomposition/README.md).

Proposal labels should be first-order facts a human can understand and future
policy can consume. Today, agent-behavior proposals use `behavior-proposal`
plus an impact label such as `impact:prompt` or
`impact:runtime-defaults`. Do not add second-order labels such as "automation
posture" or "proposal class"; future auto-acceptance rules should key off the
existing facts and explicit adopter configuration.

## MVP posture: every repo promotion is a human-reviewed PR

In MVP, every repo promotion routes to a human-in-the-loop PR. The terminal
automated outcome for any repo-changing promotion is `route_to_hitl`: an
evidence-backed pull request that a human merges or declines. This applies to
both risk classes — `low_risk` and `high_risk` promotions both land in human
review after the controller drafts the change.

The writer/drafter is an author of candidates, never an acceptor. It may
produce candidate prompt bytes and provenance, but drafted candidates still
flow through the same scanner, gate, controller, and HITL PR path. The writer
cannot open PRs, move trust machinery, merge, mark ready, review, or accept
anything. HITL PR merge remains the only acceptance act. There is no
auto-draft toggle: unattended auto-drafting is not built, and adding it would be
a separate explicit product decision.

The no-merge promise is **structural, not configuration**:

- The promotion controller has no merge, auto-apply, mark-ready, or
  auto-accept codepath at all. There is no flag, policy field, or environment
  variable that enables one.
- The controller's GitHub client enforces an explicit endpoint allowlist with
  no merge endpoint, no mark-ready endpoint, and no review-submission
  endpoint, and exposes no merge-shaped method. Tests pin both properties.
- This is enforced in code rather than in GitHub permissions because the
  `contents` permission the controller needs for proposal commits could, by
  itself, be sufficient to merge a PR. Permissions alone cannot carry the
  promise.

Human review happens at the policy boundary, not as clerical approval for
every artifact write. The loop still does the intellectual and mechanical
work: discover the improvement, gather evidence, pin exact Phoenix asset
versions, materialize a behavior diff when a drafted change exists, open the
PR, and record the audit trail. The remaining human action is the
product/governance decision to merge, apply, or decline the proposed change.

The controller supports these outcomes:

- `route_to_hitl` — create the branch, behavior patch, and PR for a repo
  promotion; in MVP this is the terminal automated outcome for repo-changing
  promotions.
- `blocked` — record why the promotion failed or why evidence stopped short
  of a drafted change.
- `auto_accept_v2` — a future-only path that does not exist in MVP, described
  below.

## Behavior-diff custody and opportunity outcomes

New-style promotion PRs carry concrete behavior diffs, not committed proposal
documents. For prompt promotions, the branch changes the accepted prompt
snapshot and the `phoenix-assets.json` manifest pin together. The PR body is
the durable human review surface: it carries the proposed-change summary, the
standalone evidence custody that survives Phoenix loss, and exactly one
machine-readable promotion marker. Old-style branches with committed proposal
files remain readable only as migration artifacts.

New-style promotion commits also carry the immutable envelope anchors as
commit trailers: `Agentic-Factory-Promotion-Envelope`,
`Agentic-Factory-Promotion-Instance`, and
`Agentic-Factory-Promotion-Target`. Resume and orphan-branch recovery verify
those trailers against the current controller envelope before trusting an
existing branch.

Valid evidence without a drafted behavior change is an improvement
opportunity, not a PR. The controller returns `blocked` with reason
`improvement_opportunity_no_proposed_change`, records a structured local
registry/scanner status with Phoenix deep links for investigation, opens no
GitHub PR, creates no branch, and writes no Phoenix outcome annotation or
span. The opportunity is local-only: the string `improvement_opportunity` is
never sent in a Phoenix request payload.

Opportunity reuse is conditional. Re-running the same envelope reuses the
same local opportunity record while the target still has no materializer; if
a later repo version adds materializer metadata for that target, the
controller continues the same envelope toward a behavior-diff PR instead of
leaving the candidate stuck as an opportunity.

## Future v2 auto-acceptance: required preconditions

Future auto-acceptance — for either risk class — is allowed only when **all**
of the following exist. Neither risk label is permanently excluded from
auto-acceptance, but none of these requirements can be waived:

1. **Explicit adopter configuration by risk class.** An adopter must opt in
   per class (`low_risk`, `high_risk`, both, or neither). Nothing
   auto-accepts by default.
2. **The shared code-review and acceptance system.** Auto-acceptance rides on
   the general review system for all agent-authored repo changes, not a
   special promotion-only path.
3. **When auto-merge is enabled: GitHub merge authority plus branch
   protection/ruleset preflight plus required-check and review-rule
   compliance.** PR-generation readiness is not auto-merge readiness; merge
   capability gets its own capability preflight against the adopter repo's
   branch protection, rulesets, required checks, review rules, and merge
   method.

And all of these invariants:

- Signed trigger or authenticated local invocation.
- Replay protection and idempotency by Phoenix asset/version IDs.
- ID provenance verification for every Phoenix object used as evidence.
- Dirty-worktree and branch safety checks.
- Kill switch, rate cap, and rollback path.
- The human-labeled test set is human-append-only or otherwise protected from
  autonomous rewrite.
- Loop-generated examples are quarantined before becoming evidence for later
  auto-promotion.
- Human-led experimentation over test examples is disclosed in HITL evidence
  summaries and defaults the candidate to `high_risk`.
- The controller cannot auto-edit its own risk classes, acceptance policy,
  gates, CI, credentials, or permissions.
- The controller cannot bypass GitHub branch protection or rulesets in order
  to make a future auto-merge succeed.
- LLM-authored code, prompt, or policy content is never auto-accepted without
  deterministic validation and an explicitly pre-authorized class.

## Auto-merge is one route, not the definition of maturity

Auto-merge is one future acceptance route, not the maturity bar. A workspace
may configure low-risk prompt changes to auto-merge while keeping high-risk
changes human-reviewed, require human review for every class, or use
generated PRs without auto-merge at all. The product must continue to support
evidence-backed human PR review even after auto-merge exists. A workspace
that never enables auto-acceptance is a fully supported steady state, not a
transitional one.

## Phoenix handoff

This section records a deliberate decision: **no Phoenix-side handoff adapter
is built for the pinned Phoenix version.** The plan allows a Phoenix/PXI
handoff adapter "only if Phoenix exposes a supported action or tool-calling
surface; otherwise keep the agent-command entry point." A live capability
preflight against the pinned `arize-phoenix==14.13.0` found no supported
custom action surface: no webhooks, no outbound custom actions, no PXI/plugin
hooks, and no inbound user-defined tools. The agent-command entry point
therefore remains the supported handoff. Re-run that capability check against
any future Phoenix pin before revisiting this decision; key off the live
server, never off documentation snapshots.

### Current entry points

- **Agent-session command**: `npm run promote-candidate -- --input
  <request.json>` with explicit Phoenix IDs (experiment, dataset, dataset
  version, prompt version) or a validated Phoenix deep link. This is the one
  promotion controller every surface calls.
- **Deterministic candidate-intent scanner**: the planned routine path. Once
  explicit candidate intent exists (a Phoenix prompt-version candidate tag, a
  managed `promotion_candidate` receipt, a repo-owned candidate artifact, or
  an authenticated registration) and deterministic evidence/provenance can be
  packaged, the scanner calls the same controller automatically — no human
  needs to leave Phoenix just to trigger the obvious proposal.

### The deep-link / command-copy pattern

The supported "from Phoenix into the controller" flow is documented deep
links: the user copies a Phoenix experiment, dataset, or prompt URL from the
Phoenix UI and hands it to the controller (or an agent session does so on
their behalf). Phoenix UI URLs carry the same IDs the REST resolvers accept,
so no extension surface is needed.

The controller treats the link as untrusted input:

- The link's origin must equal the locally configured Phoenix origin.
  Caller-supplied origins are rejected; the controller never derives the
  Phoenix origin from the request.
- The path must match a strict, path-only allowlist of known Phoenix UI
  shapes (dataset, dataset experiment, prompt). Queries and fragments are
  rejected outright.
- IDs are extracted only after validation, and all evidence is then
  re-resolved through the verified local Phoenix REST resolver. A deep link
  supplies context, never authority. If both a deep link and explicit IDs are
  supplied, mismatches are rejected.

### Future adapter contract

If a future Phoenix version exposes a supported custom action, webhook, or
tool-calling surface, an adapter may be added without redesign as long as it
honors the handoff contract:

- Pass IDs and context, not authority.
- Never mutate the repo from Phoenix itself.
- Never mark accepted behavior through Phoenix metadata or tags alone.
- Label the affordance as a proposal or draft action, never "make this live".
- Show the controller result back in Phoenix as an audit observation when
  useful.

Phoenix initiates; the controller decides. The adapter would be a launch
point that hands candidate and evidence context to the same promotion
controller, which still applies policy, re-resolves evidence through the
verified resolver, pins exact Phoenix versions, and drafts the repo proposal.

### Future MCP wrapper

A separate MCP wrapper (for example, in the style of Arize's
`@arizeai/phoenix-mcp`, which wraps the same Phoenix REST API) could later
give agent runtimes a convenient way to invoke the promotion command. Such a
wrapper would be a **non-trusted convenience caller** of the same CLI
contract: it may carry IDs and context into the controller, but it is never a
trusted resolver path and never gains authority the CLI caller does not have.
The controller's trust boundary — verified local REST resolution, derived
trigger authenticity, policy gates — stays in the controller.

## Related documents

- [`execution/evals/decomposition/promotion-policy.json`](../execution/evals/decomposition/promotion-policy.json)
  — the repo-owned policy knobs the controller enforces today.
- [`execution/evals/decomposition/README.md`](../execution/evals/decomposition/README.md)
  — the promotion controller contract, process-change gate, and eval
  contracts.
- [`self-improvement.md`](self-improvement.md) — the trace/eval architecture
  and the learning loop this policy governs.
