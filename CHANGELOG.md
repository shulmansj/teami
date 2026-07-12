# Changelog

All notable changes to teami are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) flavored; versions are
the `version` field in `package.json`.

Historical entries: released-version sections preserve what shipped at that
time and are not current product guidance. Retired hosted, GitHub App, broker,
or supervisor designs mentioned there are superseded. Use
[`README.md`](README.md) and the current trust contracts for today's supported
local-first product path.

## [Unreleased]

### Changed

- Teami's supported path is local-first and zero-hosted: foreground Linear
  polling, the adopter's OAuth grant, ambient local git/`gh` authority, and
  local Phoenix.
- Conversational MCP setup is the primary experience, with the CLI retained as
  a fallback and operator surface.
- Product-repo write-capable execution remains unshipped and fail-closed.

### Fixed

- CLI help flags return usage before setup configuration, credential, OAuth, or
  external mutation work.
- Reset cleanup removes local setup-incomplete state left by an interrupted or
  failed setup attempt.
- Deterministic tests now isolate every test process from the adopter's real
  `TEAMI_HOME`, safely clean runner-owned state, and support an explicit
  disposable `TEAMI_TEST_HOME` parent.
- The verification path now includes static checks for undeclared globals,
  unused values, unresolved imports, and named-export drift across current
  JavaScript modules, including live acceptance and publication tooling outside normal test
  imports.
- Setup recovery no longer depends on remote callbacks or remote wake state.
- Current trust docs no longer present retired infrastructure as supported or
  planned behavior.
- The lockfile includes the root `UNLICENSED` metadata that npm writes during a
  fresh install.
- The public showroom test runner now uses its sanitized package-default fixture,
  validates the release-stamped plugin target, and keeps source-only publication
  checks out of the transformed artifact path without weakening the source gate.

## [0.3.20] - 2026-06-17

GitHub App install/configure callbacks no longer hang setup when the App is
already installed on the account but not yet granted access to the new behavior
repo.

### Fixed

- The hosted GitHub callback now accepts app install/configure callbacks without
  an OAuth code only for setup grants that initiated the `install_app` flow, then
  verifies the grant-bound repo installation server-side before binding it.
- GitHub setup now shows clearer normal-mode progress while the browser
  permission step is open, including periodic waiting feedback.

## [0.3.19] - 2026-06-17

Linear decomposition now produces a direct, pick-up-able operating plan instead
of a proposal-shaped handoff.

### Added

- Project decomposition now assembles a single terminal orchestrator output for
  commit, pause, or failed-closed outcomes, with durable local artifacts before
  any Linear mutation.
- Completed decomposition runs now create execution issues directly in Ready,
  leave them unassigned, preserve dependency relations, and post a project
  update explaining what happened to each part of the project.
- Runtime evidence, environment-scrub proof, advisory quality verdicts, and a
  vertical first-successful-session acceptance test now cover the live
  decomposition path.

### Changed

- Runtime smoke now checks agent-driven turn output and warm continuation
  without depending on a fixed four-phase smoke itinerary.
- Accepted decomposition prompts now ask for structured assignment, output, and
  acceptance criteria instead of agent-supplied assignee or label selectors.

### Fixed

- Malformed final issue keys, duplicate decomposition keys, and dangling
  dependencies now fail closed before any Linear issue is created.
- Runtime child processes now scrub common GitHub, Linear, SSH-agent, and
  generic token environment variables while preserving model runtime auth.

## [0.3.18] - 2026-06-15

Fresh clones from the shipped source repo are now recognized as starter
checkouts.

### Fixed

- `config.example.json` now includes `https://github.com/shulmansj/teami` as
  a starter remote URL, so a plain fresh clone from the source repo can preserve
  that remote as `upstream` and create the dedicated behavior repo at `origin`.

## [0.3.17] - 2026-06-14

GitHub setup now handles already-installed App connections.

### Fixed

- GitHub setup detects when the Teami GitHub App already covers the
  selected behavior repo, then runs a normal GitHub authorization step instead
  of sending adopters back through the install settings page.
- The hosted callback now binds the GitHub installation discovered by the
  server for the grant-bound repo, rather than trusting an `installation_id`
  query parameter from the browser redirect.
- The GitHub setup prompt now says what the adopter is actually waiting for:
  browser authorization to finish.

## [0.3.16] - 2026-06-14

Hosted setup-grant refresh is now authenticated for GitHub resume.

### Fixed

- GitHub setup resume now sends the existing local setup grant to the hosted
  inbox, and the hosted `/v1/setup-grants` route reopens that same grant's
  mutation window after authenticating it for the same workspace/team.

## [0.3.15] - 2026-06-14

GitHub setup resume now forces a fresh mutation-capable setup grant.

### Fixed

- The GitHub resume refresh now bypasses active setup-grant conflicts, so it
  mints a new grant instead of reusing an old provisional grant whose mutation
  window has expired.

## [0.3.14] - 2026-06-14

GitHub setup can recover an empty repo left behind by older failed init reruns.

### Fixed

- If an older init rerun overwrote the useful GitHub setup state with a
  repo-name collision, a later no-flags rerun can now continue when the target
  repo is still empty. Non-empty existing repos remain a hard collision.

## [0.3.13] - 2026-06-14

GitHub setup resume now refreshes hosted setup authorization before retrying.

### Fixed

- When Linear setup is already complete and `npm run init` resumes the GitHub
  step, setup now requests a fresh inbox setup grant for the saved Linear team
  before starting the GitHub App install flow. This prevents expired setup
  grants from turning a no-flags rerun into a maintainer-only recovery path.

## [0.3.12] - 2026-06-14

GitHub setup reruns now resume repos created by a prior failed install step.

### Fixed

- If init created `teami` but failed while starting the hosted GitHub
  App install flow, a plain `npm run init` rerun now treats that repo as its
  own prior work and continues verification instead of reporting a repo-name
  collision.

## [0.3.11] - 2026-06-14

GitHub setup now handles renamed-repository redirects during repo availability
checks.

### Fixed

- If a prior dummy behavior repo was renamed away from `teami`, `gh
  repo view` may still follow GitHub's redirect from the old name. Init now
  treats that redirected repo as not occupying the requested default name, so
  the no-flags adopter setup can create a fresh `teami` repo.

## [0.3.10] - 2026-06-14

Setup reruns now resume the GitHub step when Linear setup already completed.

### Fixed

- Bare `npm run init` now detects the common interrupted state where exactly
  one Linear domain is active but the GitHub connection is missing, failed, or
  incomplete, then skips Linear setup and resumes `Connect GitHub`.
- Rerunning after a GitHub repo-name collision no longer asks for another
  domain name or creates another Linear team.

## [0.3.9] - 2026-06-14

GitHub setup now shows visible progress immediately after the repo-owner
prompt is answered.

### Changed

- The GitHub setup phase now prints loading-state progress while it checks the
  signed-in GitHub account, local remotes, and GitHub repo availability.
- Progress output now appears before the GitHub repo availability network call,
  so pressing Enter at the owner prompt does not look like the CLI froze.

## [0.3.8] - 2026-06-14

GitHub setup now explains the repo-owner decision in user terms before asking
for input.

### Changed

- The interactive GitHub setup prompt now says that Teami needs a
  GitHub repo for generated PRs, explains that Enter accepts the signed-in
  GitHub CLI account, and allows typing a different user or org.
- The GitHub setup phase now prints the selected repo target before creating or
  verifying the behavior repo.

## [0.3.7] - 2026-06-14

Linear setup error copy now reads cleanly when Linear already includes
punctuation in its own message.

### Fixed

- `teamCreate` setup failures no longer print double punctuation between
  Linear's user-facing error and Teami's repair guidance.

## [0.3.6] - 2026-06-14

Setup reruns after an incomplete Linear attempt now resume the incomplete domain
instead of asking an unexplained workspace question.

### Fixed

- Bare `npm run init` now detects a single `setup_incomplete` domain and resumes
  it automatically, printing the domain, Linear workspace, and previous stop
  reason before authorizing.
- The fallback known-workspace picker now asks for a numbered choice
  (`Choose workspace number...`) instead of the ambiguous `Workspace:` prompt.

## [0.3.5] - 2026-06-14

Linear setup now explains team creation failures instead of hiding them behind
an unknown error.

### Fixed

- `npm run init` now preserves Linear's structured GraphQL `teamCreate` errors,
  including `userPresentableMessage`, so plan/team-limit failures classify as
  `linear_team_limit_reached` instead of `linear_team_create_unknown_error`.
- Setup errors now include Linear's safe user-facing detail before the repair
  path, so adopters can tell whether to remove a team, upgrade, or ask an admin.

## [0.3.4] - 2026-06-14

Linear OAuth reauthorization now forces the chooser.

### Fixed

- `npm run init` now adds Linear's `prompt=consent` parameter to browser
  authorization URLs, so pressing `R` at the workspace confirmation prompt
  reopens Linear's consent/workspace screen instead of silently reusing the
  previously approved workspace.
- The workspace confirmation prompt now says that `R` reopens Linear's consent
  screen and tells adopters to use Linear's workspace dropdown there.

## [0.3.3] - 2026-06-14

Setup confirmation clarity for Linear OAuth.

### Fixed

- `npm run init` now shows the authorized Linear workspace before continuing, so
  adopters can confirm or re-authorize the right workspace before Agentic
  Factory creates anything.
- The browser callback now explains that authorization was received and points
  adopters back to their terminal for workspace confirmation, instead of
  showing a blank page with only "You can close this tab."

## [0.3.2] - 2026-06-13

Post-Milestone-C onboarding accuracy. Both changes were codex-reviewed (SHIP/SHIP) before merge.

### Changed

- **Zero-config `init` against the standard hosted tier (C7)**: the shipped default
  config points `init` at the hosted inbox and GitHub broker instead of a
  `your-project-ref` placeholder, so adopters no longer hand-edit URLs to connect.
  Self-hosting your own infra stays a `base_url` override, and the fail-closed
  placeholder guard still rejects an unconfigured endpoint.

### Fixed

- **Setup-handoff docs match the shipped grant model**: the adopter quickstart, the
  Linear setup contract, and the config template no longer describe a
  maintainer-supplied setup token. `init` registers the Linear webhook secret and
  mints the runner credential with the self-issued setup grant;
  `TEAMI_INBOX_ADMIN_TOKEN` is break-glass only and never required for
  adopter setup. Removed the misleading `setup_token_file` from the adopter config
  template.

## [0.3.1] - 2026-06-13

Milestone C — hosted-tier multi-tenant hardening, so two users in one Linear workspace can run
totally independent factories (one team each). The Linear side landed via PR #13; this release
adds the GitHub side (C8) and stamps the milestone. Two adversarial review passes (combined
credential+grant, then a full-surface pass) plus a /ship review were reconciled.

### Added

- **Team-scoped setup grants + deferred confirmation (C1)**: per-team grants replace the
  all-tenant admin token (no pasted secret, no throwaway project); the first real signed Linear
  delivery for the team's webhook confirms the connection and is the first wake. Admin token is
  break-glass only.
- **Installation-bound GitHub broker (C8)**: broker credentials bind to the GitHub App
  installation the adopter authorizes themselves (browser "install & authorize", verified by an
  OAuth `code` exchange + per-repo write permission). The broker mints only within the bound
  installation, so cross-tenant GitHub write is structurally impossible. Credentials are
  short-lived (1h) and re-minted autonomously from the confirmed grant; revoking the grant stops
  re-mint. CLI `init` drives the browser install and polls until it binds.
- **Retention + maintenance (C5)**: per-table retention and a break-glass maintenance sweep
  (expire due grants/leases, prune past-retention rows; active rows never pruned).

### Changed

- **Server-enforced runner-credential scope (C3)**: credentials carry team/webhook/domain;
  claim/get/views/lease/mark-running enforce the stored scope (presented filters narrow, never
  widen) — two teams in one workspace cannot touch each other's wakes.
- **Routing trusts the grant-bound team (G2)**: wake routing/dedup uses the webhook's stored
  team, not attacker-controlled payload `teamIds`; deliveries that spoof a team are rejected.
- **CLI init wired to grants** with an honest deferred-confirmation pending state; `doctor`
  reports pending vs active connection.

### Security

- Webhook abuse controls (C4): body-size cap, fail-fast header prechecks, per-workspace + global
  issuance caps.
- Reconciled adversarial-review findings: bound-grant lifetime bug, cross-team webhook-secret
  clobber, domain enforcement, a production-vs-test gap, lease-sweep race, secret-file perms,
  issuance-cap lockout, broker repo-write proof, and a re-mint audit + throttle.
- Accepted, documented residuals (never described as cryptographic): setup-ownership is
  first-connected-wins with maintainer recovery; GitHub setup proof is socially delegable but
  bounded by GitHub consent + short TTL + revocation. The setup grant is a durable, revocable
  renewal authority (refresh-token-like), not 1-hour access.

## [0.3.0] - 2026-06-13

Milestone A of the architecture execution plan: decomposition becomes the first
**registered workflow**, so a future dev/review/merge agent is a data addition rather
than a cross-cutting rewrite. Behavior-preserving for decomposition except four
deliberate, reviewed changes. Includes a breaking config reshape (clean break — no
backward compatibility, pre-launch).

### Changed

- **WorkflowDefinition registry**: `workflow-registry.mjs` + `workflows/decomposition/
  definition.mjs`. `trigger-runner` dispatches by `wake.workflow_type` through the
  registry; unknown types quarantine as `routing_error` (parity in both stores).
- **Config reshape (BREAKING, clean break)**: shared top-level `runtime` (adapters,
  written once) + `workflows.<type>.roles`. Role names derive from the workflow
  definition, not a hard-coded enum. An old-shape `decomposition.runtime` config fails
  closed with a targeted rename error. No compatibility layer.
- **`linear-service.mjs` split** into `linear/` + `workflows/decomposition/` modules
  behind a façade (mechanical, façade-preserving).
- **Phase-prompt projection**: the LLM phase prompt receives a strict allowlist of
  wake/event fields; lease tokens, runner identity, and raw payloads can never reach a
  model.
- **First-class accepted baselines for every promotion target kind**: prompt → accepted
  prompt snapshot; rule → content-addressed accepted role-defaults; the zero-override
  baseline → the accepted-state hash (manifest minus run history). Non-prompt targets no
  longer borrow the decomposition-judge prompt's baseline; an unanchorable target fails
  closed, and a rule target with no accepted baseline experiment fails with an actionable
  bootstrap message.
- Promotion `policy_version` 3.0.0 → 4.0.0 (blocker-check promotable, dead
  `drafting.auto_draft_enabled` removed), with a 3.0.0→4.0.0 envelope re-key test.

### Added

- `sr_eng_blocker_check` extracted as the fourth sha-pinned, draftable accepted phase
  prompt — the system can now draft improvements to every decomposition phase.
- Workflow-definition contract and three outside-review records under `maintainers/`.

## [0.2.3] - 2026-06-12

Milestone B of the architecture execution plan: the four giant files are
split into focused modules behind façades, with zero behavior change.

### Changed

- `promote-candidate.mjs` (4,362 → 58), `cli.mjs` (2,603 → 118),
  `promotion-candidate-scanner.mjs` (1,912 → 369), and
  `local-supervisor.mjs` (1,482 → 48) are now façades/thin bin over 33
  focused modules under `src/promotion/`, `src/cli/`,
  `src/promotion-scanner/`, and `src/supervisor/`. Every prior import path
  and export survives; the CLI keeps its literal command dispatch chain and
  entrypoint ordering. Promotion envelope hashing, marker grammar, and all
  schema constants are byte-identical.
- Nine CLI production-wiring source-pin tests now read the module where the
  pinned wiring lives; assertion content is unchanged and the three
  test-harness-ban negatives now scan the whole CLI surface instead of
  `cli.mjs` alone.

### Added

- Outside-review record for the split (zero accepted findings) under
  `maintainers/reviews/`.

## [0.2.2] - 2026-06-12

Architecture re-review: the hosted multi-tenant boundary is hardened, the
structural debt map is current, and the decided forward milestones are
documented as an execution plan.

### Fixed

- **Hosted lease authority**: lease tokens are redacted from every read,
  view, and claim-rejection response (only the claimant's claim/renew success
  returns one); dead-letter requires lease ownership; expired leases are
  rejected; terminal transitions retire the lease token, so a runner that
  lost its lease after a Linear mutation can never rewrite a terminal wake;
  lazy lease expiry is scoped to the caller's workspace.
- **Capability authority**: claims and heartbeats are authorized by the
  stored runner credential's capabilities (presented sets may narrow, never
  widen), so neither claim eligibility nor the derived readiness signal can
  be inflated by self-attestation.
- **GitHub broker identity**: expected App id/slug come only from hosted
  environment configuration — caller-supplied identity is rejected,
  unconfigured identity fails closed, and an unverifiable slug is an error.
  The broker's error handler now type-checks under `deno check`.
- **Legacy wake repair**: a migration recovers routing identity for
  pre-domain-identity queued wakes where the linked trigger event preserved
  it, and terminally dead-letters the rest with a clear reason instead of
  leaving them silently invisible to domain-scoped claims.
- Placeholder Supabase endpoints fail closed at client construction with a
  targeted setup/self-host message instead of surfacing as network noise.

### Changed

- Wildcard CORS removed from both hosted Edge Functions.
- Wrong-direction imports fixed: the Linear GraphQL transport no longer
  imports workflow semantics (`findIssueByDecompositionKey` lives in
  `linear-service`); `runRuntimeCommand` moved to `runtime-command.mjs`; the
  judge target key and policy-edit disclosure are single-sourced.
- Invariant sharpened: Linear is the sole **authority** where humans author
  and read product intent; local artifacts are derived copies and evidence
  (README, orchestration-flow).
- The dead `inbox.raw_payload_retention_days` config key is removed
  (validated but never wired); real retention config arrives with the
  hosted-tier hardening milestone.
- Operator docs now document the `routing_error` quarantine state and its
  requeue repair path; the Supabase rollout doc gives explicit ordered steps
  instead of centering bare `db push`.

### Added

- Source-contract test pinning both deployed Edge Functions from the Node
  suite (routing-reason parity, data-minimization markers, lease redaction,
  broker fail-closed shape, no wildcard CORS, legacy-repair semantics).
- 2026-06-12 architecture re-review report (decisions P1–P8 resolved and
  recorded) with the four gated session audits as appendices, and the
  execution plan for the decided milestones under `maintainers/plans/`.

## [0.2.1] - 2026-06-12

Architecture-review follow-through: the hosted inbox keeps no product
content, and the 2026-06-11 architecture/tech-debt review is reconciled
and recorded.

### Changed

- **Hosted inbox data minimization**: webhook bodies are verified and
  normalized in memory; only a body hash, an allowlisted header subset, and
  derived routing facts persist. A two-phase migration scrubs previously
  stored content — scoped to pre-minimization rows, safely re-runnable, with
  the legacy routing fact backfilled (mirroring the function's truthiness
  semantics) before payloads are nulled — and the deploy ordering is
  documented in `supabase/README.md`.
- Kernel seam cleanups; promotion constants are single-sourced.
- Adopter docs aligned with the shipped 0.2.0 surface.

### Fixed

- Reconciled the architecture review branch against the Codex outside
  review, including ship-gate fixes to the scrub migration's scope,
  backfill, and rollout choreography.

### Added

- 2026-06-11 architecture/tech-debt review report recorded under
  `maintainers/`.

## [0.2.0] - 2026-06-11

The self-improving decomposition loop, end to end: the system can now capture
evidence, evaluate candidate changes against real baselines, draft its own
improvements, and open behavior-diff PRs for them — with a human merge as the
only acceptance act at every step.

### Added

- **Decomposition eval loop**: canonical eval contracts, run-time project
  snapshots, rich dataset promotion with field-level content gates,
  deterministic checks emitted as Phoenix CODE annotations, and the first
  `decomposition_quality` LLM judge with a Phoenix-managed prompt.
- **Promotion pipeline**: deterministic promotion-candidate scanner,
  `promote-candidate` controller with a fail-closed process-change gate,
  disagreement reporting, and Phoenix experiment receipts.
- **Behavior-diff promotion PRs**: promotion PRs now carry concrete behavior
  diffs to repo-owned artifacts (accepted prompt snapshots, runtime-role
  defaults, allowlisted policy fields) rendered by materializers; evidence
  without a drafted change surfaces as an "Improvement opportunity" and opens
  no PR. Human-first PR bodies, commit trailers as the envelope anchor, and
  sentinel-bounded markers with explicit trust states.
- **Self-drafting improvement loop**: the writer drafts candidate prompt
  changes through preflights (eligibility, rejection memory, quota, dedupe),
  composability validation, byte-exact registration, derived-variant
  experiments with `drafted_by` provenance, and occupancy-guarded candidate
  tags. Completed chains never block fresh drafts.
- **Accepted prompt snapshots**: decomposition phase prompts extracted
  byte-identical into sha-pinned, repo-owned snapshots with a fail-closed
  loader (drift, sentinel, and path-traversal rejection).
- **Runtime role defaults**: repo-owned accepted runtime-role defaults with
  per-field adopter precedence, doctor visibility, and a role-assignment
  drafter.
- **Advisory policy gate** for policy-edit candidates: fail-closed conditions
  with trust-affecting fields permanently excluded from the allowlist.
- **GitHub live setup**: hosted Supabase GitHub App token broker,
  broker-backed promotion transport, `github:init`, and live sandbox proof
  (PR #2 superseded-then-closed, PR #3 human-merged).
- **Operator surfaces**: local supervisor worklist, scanner ledger v2 with
  plain-English outcome statuses, hosted Linear webhook inbox trigger runner.

### Changed

- Promotion policy raised to `policy_version` 3.0.0 across two deliberate
  envelope migrations (2.0.0 behavior-diff custody, 3.0.0 drafting +
  policy-editing blocks).
- Eval variants schema v2: target-keyed prompt overrides and per-target
  accepted baselines with artifact hash vectors; baselines re-pinned to the
  first real evaluation run.

### Fixed

Ship-review hardening (five independent Codex GPT-5.5 reviews, reconciled):

- Promotion markers are authoritative only with valid field shapes AND a
  controller-namespace head branch; markers on other PRs are never consumed
  or mutated.
- Registry PR reuse re-validates live PR state (open, branch, marker) before
  reporting a proposal as ready.
- Supersede failures now return a typed repair outcome that retries on the
  next run instead of silently reporting success.
- Promotion controller takes a mutation lock; concurrent runs get a clean
  "promotion in progress" result instead of racing the registry/workspace.
- Draft file paths are containment-checked before any workspace write.
- GitHub PR listings paginate fully and fail closed on truncation.
- Broker URLs are validated (https, no userinfo; localhost dev exception);
  broker token files must resolve inside the repo.
- Supervisor worklist recognizes scanner ledger v2 statuses, so
  proposal-ready and improvement-opportunity items surface again.
- Live writer-chain fixes from the tier-1 rejection ladder: envelope-aware
  draft extraction, delimited output contract, full-artifact drafter input,
  resume re-validation, 404-tolerant tag reads.
- Round-2 delta-review hardening: unreadable-marker blocks are retryable
  (human repair unblocks the next run), stale-lock recovery is atomic,
  draft containment rejects symlink ancestors, the controller-namespace
  rule now also covers the writer's rejection memory and registry PR
  validation, real mode no longer reuses dry-run PR records, transport
  failures during PR re-validation fail closed, and legacy v1 trace
  receipts surface as honest re-run states instead of crashing.

## [0.1.0] - 2026-06-09

Baseline: Linear decomposition workflow, gate-first onboarding, local Phoenix
as the trace surface, and the planning corpus under `maintainers/plans/`.
