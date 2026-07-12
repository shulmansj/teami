# Linear Integration

This folder contains the GraphQL-backed Linear setup, local gateway trigger
contracts, behavior-repo GitHub path, and local decomposition workflow slice.

## Public Setup Status

The intended public setup entrypoint is:

```text
npm run init
teami domain grant main --repo owner/product-app
```

The grant records scope only; product-repo execution is not shipped.

`npm run init` authorizes Linear in the browser with the Teami OAuth
app, then uses Linear GraphQL to provision the workspace: browser
authorization, dedicated team, required labels, project status mappings,
project template, local gateway state, managed or reused local Phoenix, and
local cache. The public poll knob is `poll.interval_ms`. No Linear API key is
required. Teami does not require or retain Linear admin scope for ordinary
operation, which uses the adopter's read/write grant. If `Principal Escalation`
is missing, setup may request a
separate one-time admin approval to create only that status; the grant stays in
memory, is discarded after the attempt, and is never the runtime credential.

Report setup bugs through the public repository issue templates after launch,
without posting credentials, workspace data, repo contents, or local paths.
Security-sensitive reports should use the private vulnerability reporting path
once the public repository enables it.

## Responsibility Split

Teami deliberately keeps live authority local.

The local gateway polls Linear's current state with the adopter's OAuth grant,
computes trigger fingerprints, records local wake state, and leases work to a
compatible local runner. Linear is the queue: the source project remains the
work-state surface, and the gateway only starts work after seeing an eligible
project in the configured trigger state.

The local runner owns adopter-side authority. It reads Linear through the
browser OAuth credential and GraphQL, persists run artifacts locally, writes
Linear only after deterministic gates pass, invokes agent runtimes from the
adopter machine, and exports trace/eval evidence to local Phoenix.

The behavior-repo GitHub path uses the adopter's own git/`gh` auth for setup
transport and reviewable process-change proposal branches. It is distinct from
product-repo binding. Product-repo binding is a local domain `git_repo`
selection included by the landed domain resource-binding work. It binds one
selected GitHub repo identity per domain. Product-repo write-capable execution
is not shipped; source-visible execution or workflow modules must not be treated as
permission to edit, commit, push, or open product-repo PRs, and behavior-repo PR
access proves none of those effects.

If Linear OAuth, local git, or `gh` authority is unavailable, setup, doctor,
gateway, and proposal paths fail closed or report the local authorization
problem. `npm run trigger-status` is local/operator state, not a PM-facing
dashboard or support console.

Revocation is local. `npm run uninstall` removes local Linear OAuth
credentials and generated local setup state. GitHub behavior-repo access can be
stopped by revoking the adopter's local GitHub session or removing that
session's access to the configured behavior repo.

Local trigger state stores only coordination facts: trigger fingerprints,
project IDs, wake/run lifecycle state, leases, mutation intent, replay intent,
and suppression records. Product content is re-read directly from Linear by the
runner when work is claimed.

## Current Technical Commands

This is technical/operator detail for the local setup slice. It is not a
raw-command-free setup promise. Setup commands can create or update Linear
workspace objects and the dedicated Teami behavior repo connection.

Sandbox operation after setup, required when decomposition work is exercised:

```text
npm run runtime-smoke
npm run gateway
npm run trigger-status
npm run doctor
npm run phoenix:doctor
npm run phoenix:status
npm run phoenix:start
npm run phoenix:stop
npm run preflight:phoenix
npm run phoenix:annotate-trace -- <trace_id> <label> <score> <explanation> [--name <dimension>] [--kind HUMAN|LLM|CODE] [--identifier <id>] [--maturity new|calibrating|stable]
npm run phoenix:promote-run -- <run_id> [dataset_name]
teami domain show main
teami domain grant main --repo owner/product-app
teami domain revoke main --repo owner/product-app
npm run worklist
npm run uninstall
npm run doctor:linear
```

`npm run init` is the runnable setup path. The GitHub phase connects the Teami
behavior repo: create or verify the dedicated behavior repo, preserve
starter/upstream remotes only as template state, verify local git/`gh` access
to the configured repo, and check PR-generation readiness. Init does not grant
product repos through that behavior-repo connection.
Product repos are granted per domain as GitHub coordinates: `owner/repo` and
default branch, with no local checkout path. Setup can discover the initial
allowlist, and later scripted changes use `teami domain grant <id>
--repo <owner/name>` or `teami domain revoke <id> --repo <owner/name>`.
That product-repo grant set is distinct from the behavior-repo setup under
`config.github`. Behavior-repo proposal writing is not product-repo access and
does not prove local `git_repo` resource access.

The current runnable workflow still uses foreground commands for smoke testing,
repair, and manual runner operation. `npm run runner` is currently required
whenever the adopter wants queued decomposition work to be claimed and
processed. It is a foreground command, not an installed background service.
When the command is stopped or the machine is off, Teami makes no external
change; Linear remains the queue until the next local poll.

Setup uses the adopter's read/write OAuth grant locally through GraphQL. The
local gateway polls current project state and records local wake state; it does
not mutate Linear. The Workflow Runner performs Linear mutations only after it
claims a local wake, re-reads the project, validates eligibility, and persists
the terminal artifact.

`npm run doctor:linear` checks the same Linear substrate without mutating
workspace state. `npm run doctor` adds local gateway readiness, runtime smoke,
each domain's product-repo binding status, and read-only local Phoenix health.
`npm run phoenix:doctor` is also read-only; use `npm run phoenix:start` or
`npm run init` to install or start Phoenix.

`npm run preflight:phoenix` starts or reuses local Phoenix, emits one synthetic
trace through the local OTLP exporter, verifies the trace by id and span name in
Phoenix, records a local receipt, and exits non-zero when delivery cannot be
proved.

`npm run gateway` starts the local gateway path. It polls Linear for eligible
projects, records local wake-ups, claims one queued wake-up, renews the lease
while active, re-reads Linear through GraphQL, attempts local Phoenix trace
export, and then drives the trigger runner execution core. `npm run runner` is
an alias for this local gateway path.

`npm run runtime-smoke` verifies each configured role runtime can start a
tool-less `session_start` invocation and return a locally schema-valid
subagent-turn packet for the installed runtime version. The smoke no longer
depends on a fixed PM/Sr Eng phase itinerary. The runner reads
`.teami/runtime-smoke.json` and fails closed when the current runtime
version has not passed that session-start readiness gate. Warm-continuation
smoke, when explicitly enabled, is recorded as separate non-gating capability
evidence.

`npm run trigger-status` is the secondary local/operator inspection command for
queued and terminal wake-up state. When a local per-run trace receipt exists,
the command combines local wake state with the local receipt result in its
output. The foreground command and existing user surfaces are the operator
view; no always-on supervisor or hidden machine-off path is part of the product.
Phoenix is the trace and self-improvement UI.

`npm run uninstall` is the adopter cleanup path. It removes local gateway state,
stops any managed local Phoenix process, then removes generated local state and
the local Linear OAuth credential. It does not delete reusable Linear team,
label, status, template, project, or issue objects.
It does not silently delete local Phoenix trace history under
`.agent-shell/phoenix-data`.

## Maintainer Command

`npm run reset` is a maintainer clean-slate command for testing onboarding. It
stops any managed local Phoenix process, clears local setup state and the local
OAuth credential, and leaves Phoenix trace history under `.agent-shell` intact.
Remote destructive cleanup is not part of the default command.

## Required Linear State

Init creates or resolves:

- the configured team, defaulting to `Teami` with key `AF`
- issue labels `Discovery` and `Needs Principal`
- project status mappings for `backlog`, `planned`, `in_progress`, and `completed`
- project template `Teami Roadmap Item`

The config also defines issue status roles for `backlog`, `todo`,
`in_progress`, `in_review`, `blocked`, and `done`.

Decomposition creates committed execution issues in the configured `Todo`
issue status. Execution issues are created unassigned, and agent output cannot
bind Linear assignee or label selectors. The issue body carries assignment,
output, and acceptance criteria so a human or later dispatch workflow can claim
the work from Linear without hidden routing.

Generated Linear IDs are cached in `.teami/linear.json`, which is
ignored by git. The cache is a convenience; Linear remains the product-intent
and live work source of truth.

Accepted decomposition packets and commit artifacts are stored in
`.teami/runs/<run_id>.json`, also ignored by git. Run artifacts are
written atomically with schema/version validation and read-back verification
before Linear mutations begin.

OAuth credentials are stored through OS credential storage by default. If OS
credential storage is unavailable, setup fails loudly unless the user has
explicitly configured the local file fallback for testing.

Local wake state is separate from Linear OAuth. Missing OS credential support
for Linear OAuth fails loudly unless the explicit local testing fallback is
configured. Local wake/run state must never contain GitHub auth material,
Phoenix credentials, model-provider tokens, rich prompts, source snippets, or
shell output.

## Local Gateway And Wake State

The first trigger is `linear.project.planned`: a Linear project update where
the project status changed and may now be in the configured `Planned` state.
The local gateway treats an eligible project as a candidate wake-up only. It
polls current Linear state, computes a trigger fingerprint, suppresses already
handled terminal outcomes for the same fingerprint, and records a local
decomposition wake with `requires_runner_verification=true`.

The repository includes a deterministic local queue substrate for tests and the
local gateway path. It implements heartbeat, claim, renew, mutation-start,
complete, replay, suppression, and dead-letter behavior against local
Teami state.

The runner is the first component allowed to mutate Linear. It must claim a
local wake-up and receive a lease token before re-reading the project through
the GraphQL service. Every lease renewal and status transition includes that
lease token so stale runners cannot update a wake after another runner has
claimed it.

Wake statuses are:

- `queued`
- `leased`
- `running`
- `routing_error`
- `paused`
- `completed`
- `rejected`
- `dead_letter`

`routing_error` is an active, non-terminal quarantine state. It appears in
`npm run trigger-status` when a runner claimed the wake but could not resolve a
safe domain/project/team identity, such as a missing active domain, ambiguous
team/project match, or cross-domain team conflict. Fix the domain registry or
Linear project/team identity first, then requeue the wake so it can be claimed
again; do not dead-letter it as ordinary runner failure.

`waiting_for_runner` is derived from a queued wake-up with no fresh compatible
runner heartbeat. It is not stored as a wake status.

Terminal statuses are `paused`, `completed`, `rejected`, and `dead_letter`.
Only non-terminal wake-ups are unique by `(workspace_id, wake_key)`, so a later
human move back to `Planned` after a pause creates a fresh wake-up.

No mutation-capable decomposition run may bypass local wake claiming. Repair
tooling may inspect, enqueue, retry, or dead-letter wake-ups, but it must not
bypass wake claiming before Linear mutation.

## Local Phoenix Trace Collection

Local Phoenix on the adopter machine is the only supported trace/eval path for
now. The local gateway remains trace-agnostic and only coordinates Linear
polling, wake leases, and mutation safety.

`npm run init` and `npm run phoenix:start` manage a loopback Phoenix service at
`http://127.0.0.1:6006` by default. Managed Phoenix state is ignored local
state:

```text
.agent-shell/
  phoenix-venv/
  phoenix-data/
  logs/
  telemetry/
  phoenix-service.json
```

If a Phoenix service is already running on the loopback endpoint, Teami reuses
it and records `managed=false`; it will not stop that external
process. If the port is occupied by a non-Phoenix service, startup fails closed
with a collision message.

Trace statuses are local:

- `trace_exported`
- `trace_unavailable`
- `trace_delivery_failed`
- `trace_unknown`

Per-run receipts live under `.agent-shell/telemetry/runs/<run_id>.json`, and
aggregate health lives in `.agent-shell/telemetry/trace-health.json`. When
delivery fails, the runner appends audit-only failure evidence to
`.agent-shell/telemetry/phoenix-outbox.jsonl` and continues the real
Linear/GitHub work. The outbox is not a replay queue; failed runs' full span
payloads are not recoverable from it in this MVP.

The runner adapts existing `trace.mjs` spans to Phoenix. It first attempts OTLP
HTTP export and caches a REST-spans fallback when local Phoenix rejects OTLP
JSON. It uses a bounded flush before delivery proof and shuts the exporter down
only when the CLI process exits. Delivery proof queries Phoenix by trace id and
expected span names before reporting `trace_exported`.

Secret-bearing keys and common secret-looking values cause trace export to be
rejected and recorded as a local trace delivery failure; the runner does not
partially redact and export that trace. Local receipts and audit-only outbox
records scrub token-shaped failure text. Rich prompts, turn packets, terminal
outputs, repo
snippets, shell output, and source context are not stored in bounded receipts by
default.

Self-improvement actions should stay Phoenix-native. The MVP path is inspect a
trace, annotate it, and promote useful examples into Phoenix datasets. A
non-mutating eval-mode entrypoint exists so first-class Phoenix
experiments can be layered on without mutating Linear.
`npm run phoenix:annotate-trace` writes a native Phoenix trace annotation, and
`npm run phoenix:promote-run` promotes a bounded local trace receipt into a
Phoenix dataset example. Dataset promotion deliberately uses the bounded receipt
projection, not full prompts, turn packets, terminal outputs, source snippets,
or shell output.

Annotations follow the canonical contract in
`execution/evals/decomposition/annotation.schema.json`: the label set is
`pass | needs_revision | blocking_failure`, the annotation name defaults to
`quality` and must be one of the canonical rubric dimensions
(deterministic-check names are `CODE` storage only), and every annotation
carries `rubric_version`, `failure_taxonomy_version`, and
`workspace_maturity` metadata. Every annotation requires a non-empty
`identifier` because Phoenix upserts by `(name, target, identifier)`: for
HUMAN annotations it defaults from local config
(`evals.human_annotator_identifier`) or the OS username and can be overridden
with `--identifier`; LLM judge ids and CODE evaluator ids must be explicit.
Identifiers are asserted, not authenticated, because local Phoenix is
unauthenticated. Known workflow-state metadata keys (the schema denylist) are
rejected at the write path: Phoenix annotations are judgments, never task
flags.

`npm run worklist` is the "What needs my judgment or repair?" entrypoint. It
first separates behavior proposal decisions, proposal repair/setup blockers,
and no-decision receipts from the existing proposal facts: PR markers, local
promotion registry rows, scanner health, and read-time proposal state. It does
not create a queue or durable worklist item. Overlapping scanner, registry,
and PR facts are collapsed into one proposal row by existing proposal identity
facts. Packet readiness is shown only from structured packet facts; it is not
inferred from PR prose. Until the packet-readiness writer exists, proposals
that are not fair to decide are shown as "no owner action yet" rather than as
approval-ready work.

The same command then computes the derived local evidence statuses
`needs_human`, `has_human`, and `disagreement_open` from local trace receipts,
local run artifacts, Phoenix annotations (read-only REST GETs), and local
dataset-membership receipts when present. It prints a ranked list (low human
grounding first, then high-risk runs, disagreements,
low-confidence/malformed/missing judge output, new project areas, and passing
calibration examples) with Phoenix deep links and per-run flags. The worklist
is a transient stdout report recomputed on every invocation: it never mutates
Linear, never writes to Phoenix, and persists no queue state anywhere. When
Phoenix is unreachable it degrades with an explicit notice instead of hiding
proposal states; when proposal facts cannot be read, it still shows local
evidence status with a proposal diagnostic. `npm run phoenix:status` includes
the same per-run derived
eval status (human/model/code annotation presence, open disagreement, dataset
promotion), derived at read time and never persisted to Phoenix.

## Live Linear Verification

Use `npm run verify` for the complete local verification path. Its static lane
checks current JavaScript modules outside the tested import graph as well as
runtime-loaded code; `npm test` remains deterministic and credential-free.
When Linear behavior is part of the claim, use the Teami OAuth credential and
Linear GraphQL for live smoke checks against disposable projects or issues,
then move test artifacts to a terminal state when the check is complete.

The independently gated setup contract canary is:

```bash
npm run canary:mcp-linear-setup -- \
  --confirm-disposable-linear \
  --confirm-one-shot-admin \
  --home /absolute/temp/teami-linear-canary-<id> \
  --domain "Teami Canary" \
  --workspace "Disposable workspace" \
  --github-owner <owner> \
  --github-repo teami-contract-canary-<id>
```

It uses the real MCP stdio server, surfaces each standard or one-shot-admin
authorization URL while its callback is pending, and refuses a nonempty or
unprefixed home. The workspace and GitHub repo must be disposable, and the repo
must be owned by the currently authenticated GitHub user so cleanup can
distinguish verified absence from private-repository permission masking. The active
GitHub CLI credential must also report the classic `repo` scope; fine-grained or
reduced-scope credentials fail closed because their 404 responses are ambiguous. Once remote
objects exist, the canary writes an exact `cleanup_required` receipt and never
reports a pass yet. Run any follow-on status/comment UATs, manually delete the
exact Linear team and GitHub repo named in that receipt, then finish with:

```bash
npm run canary:mcp-linear-setup -- \
  --confirm-disposable-linear \
  --home /absolute/temp/teami-linear-canary-<id> \
  --verify-cleanup
```

That resumable terminal phase uses the still-local ordinary OAuth credential
and ambient `gh` auth to verify both remote identities are absent, then removes
the domain credential and the exact prefixed canary home. It reports success
only after all four cleanup facts are true. The canary never runs inside
`npm test` or `npm run verify`.

After setup, run `npm run canary:linear-graphql -- --domain <canary-domain>`
for live GraphQL auth, setup-shape, status-transition, and cleanup proof. Run
`npm run uat:gateway -- --domain <canary-domain>` separately for live project
update/comment shapes, foreground pickup, and replay. Neither command is part
of the credential-free deterministic lane.

Project updates are required for committed decomposition summaries and
`failed_closed` safety stops. The deterministic path is the Teami OAuth plus
GraphQL client, not API keys or documents. Live verification on 2026-06-07
confirmed that this path can create a Linear project update with exact authored
Markdown, find it by `run_id`, and archive the test update afterward. The same
live pass verified refresh-token exchange and GraphQL auth with the refreshed
token.

Use `npm run uat:gateway` for the live poll/replay proof against disposable
Linear artifacts when a change claims local gateway behavior. The harness moves
a disposable project through the trigger state, waits for the local gateway to
pick it up, and verifies replay can re-apply the persisted terminal mutation
idempotently.

## Implemented Service Semantics

- The init service creates or resolves the `Teami` team, `Has Open
  Questions` project label, `Discovery` issue label, agreed project status
  mappings, and Linear project template when backed by a client that exposes
  those setup operations.
- The doctor service validates the same substrate without mutating Linear.
- The decomposition service gates on planned project status, team membership,
  and prior execution issues
  before creating work.
- The Workflow Runner validates accepted turn packets and assembles one terminal
  orchestrator output with `commit`, `pause`, or `failed_closed` before Linear
  mutation.
- Runtime invocation is above the deterministic Linear service. Runtime
  adapters construct role `session_start` commands with runner-only tool
  policy, validate structured packets locally, and keep Linear mutation in the
  deterministic service.
- Decomposition subagents are independent `session_start` invocations. Warm
  continuation is parked as explicit, non-gating capability smoke for a future
  execution path; it is not a live decomposition precondition.
- PM and Sr Eng runtime/model assignment is role-specific, so one run can use
  different runtimes for product and engineering turns.
- When the terminal orchestrator output pauses for product questions, the
  project pauses without creating partial execution work.
- Completion, resume, and `failed_closed` project updates use exact authored
  `project_update_markdown` and are idempotent by `run_id`.
- Non-`failed_closed` pause posts one app-authored project comment from exact
  authored `open_questions_markdown` and moves the project to Principal
  Escalation; typed blocker objects are not rendered into project prose.
- Decomposition-created issues carry a stable decomposition key, and dependency
  relations are created idempotently.
- Malformed final issue keys, duplicate decomposition keys, and dangling
  dependencies fail closed before any Linear issue is created.
- Decomposition-created execution issues use the configured Todo issue status.
  They are created without assignees or agent-supplied labels.
- Technical evidence questions that block decomposition are asked through the
  same project-comment pause path as product questions.
- Accepted turn packets, terminal orchestrator output, runtime metadata,
  role/runtime assignment, and final commit or pause artifacts are persisted to
  the ignored run store before Linear mutations, and commit retry replays that
  artifact instead of reusing fresh agent output.
- Triggered decomposition keeps `event_id`, `wake_id`, and `run_id` separate
  and joins them in wake records, workflow-run records, local run artifacts, and
  trace attributes.
- If a runner dies before Linear mutation starts, the lease can expire and the
  wake returns to `queued`. If it dies after mutation starts, the wake moves to
  `dead_letter` as an internal fail-closed state until replay or a self-serve
  repair path can reconcile from the original local run artifact or explicitly
  clean up partial Linear state.
- `quality` is available as an offline scorer over trace and
  Linear state; it is not a live decomposition span or mutation gate.
- `accepted_packet_sufficiency` is available as an offline check that accepted
  packets contain enough serialized context for audit and commit retry. It is
  not a runtime fallback mechanism.
