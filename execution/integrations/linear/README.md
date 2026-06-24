# Linear Integration

This folder contains the GraphQL-backed Linear setup, hosted inbox/broker
client contracts, and local decomposition workflow slice.

## Public Setup Status

The intended public setup entrypoint is:

```text
npm run init
npm run domain:bind-repo -- --domain main --path ../product-app
```

The hosted part of that path is launch-gated. The checked-in public config
currently points at the reserved host
`public-hosted-setup.agentic-factory.invalid`, so a public evaluator should not
treat the default config as a working hosted endpoint today. Hosted setup
becomes runnable only after the public hosted gates close: launch key rotation,
GitHub App metadata/settings verification, abuse and rate monitoring evidence,
and external setup proof.

When those gates close, `npm run init` authorizes Linear in the browser with
the Agentic Factory OAuth app, then uses Linear GraphQL to provision the
workspace: browser authorization, dedicated team, required labels, project
status mappings, project template, hosted webhook inbox registration,
runner-to-inbox credential, managed or reused local Phoenix, and local cache. No
Linear API key is required.

The setup path is a best-effort public beta boundary, not an enterprise support
or uptime promise. Report setup bugs through the public repository issue
templates after launch, without posting credentials, workspace data, webhook
payloads, repo contents, or local paths. Security-sensitive reports should use
the private vulnerability reporting path once the public repository enables it.

## Responsibility Split

Agentic Factory deliberately separates hosted coordination from local authority.

The hosted inbox verifies Linear webhooks, dedupes deliveries, records wake
state, and leases work to a compatible local runner. It receives the Linear
webhook signing secret and a separate runner credential. It never receives
Linear OAuth tokens, repo contents, Phoenix traces, model-provider tokens, or
Linear write authority.

The local runner owns adopter-side authority. It reads Linear through the
browser OAuth credential and GraphQL, persists run artifacts locally, writes
Linear only after deterministic gates pass, invokes agent runtimes from the
adopter machine, and exports trace/eval evidence to local Phoenix.

The hosted GitHub App/broker path is for the Agentic Factory behavior repo:
setup transport and reviewable process-change proposal branches. It is distinct
from product-repo binding. Product-repo binding is a local domain `git_repo`
checkout binding included by the landed domain resource-binding work. It binds
one existing local checkout per domain and must not be treated as proved by
GitHub App installation or broker token minting.

If the hosted inbox or broker is unavailable, setup, doctor, and runner paths
fail closed or report the hosted HTTP error. The configured hosted status URL is
diagnostic health and coordination state, not a PM-facing dashboard or support
console.

Revocation has separate local and hosted surfaces. `npm run uninstall` removes
the registered webhook connection when possible, revokes/removes the local
runner inbox credential, removes local Linear OAuth credentials, and clears
generated local setup state. GitHub behavior-repo access can be stopped by
uninstalling the GitHub App from the selected repo or revoking the setup grant;
already issued broker credentials expire quickly, while immediate hosted-wide
revocation requires maintainer key rotation.

The hosted inbox stores no product content. Linear webhook bodies are consumed
in memory, hashed for dedupe, and discarded. Persisted state is limited to body
hashes, allowlisted headers, routing facts, wake/run lifecycle state, and
credential hashes; retention details are owned in
[../../../supabase/README.md](../../../supabase/README.md).

## Current Technical Commands

This is technical/operator detail for the hosted setup slice. It is not a
raw-command-free setup promise, and the hosted path is not runnable against the
checked-in `.invalid` defaults.

Sandbox operation, required when decomposition work is exercised with a
launch-approved hosted config:

```text
npm run runtime-smoke
npm run runner
npm run trigger-status
npm run doctor
npm run phoenix:doctor
npm run phoenix:status
npm run phoenix:start
npm run phoenix:stop
npm run preflight:phoenix
npm run phoenix:annotate-trace -- <trace_id> <label> <score> <explanation> [--name <dimension>] [--kind HUMAN|LLM|CODE] [--identifier <id>] [--maturity new|calibrating|stable]
npm run phoenix:promote-run -- <run_id> [dataset_name]
npm run domain:bind-repo -- --domain main --path ../product-app
npm run worklist
npm run uninstall
npm run doctor:linear
```

With a launch-approved hosted config, `npm run init` is the runnable setup path.
The GitHub phase connects the Agentic Factory behavior repo: create or verify
the dedicated behavior repo, preserve starter/upstream remotes only as template
state, verify selected-repo access, and check PR-generation readiness. Init
does not bind product repos through that behavior-repo connection.
Product repos are bound explicitly per domain with
`npm run domain:bind-repo -- --domain <id> --path <path>`, which records the
one existing checkout path, `owner/repo`, and default branch for that domain.
That product-repo binding is distinct from the behavior-repo token-broker setup under
`config.github`. Broker-backed proposal writing is behavior-repo transport
only; it is not product-repo access and does not prove local `git_repo`
checkout binding.

The current runnable workflow still uses foreground commands for smoke testing,
repair, and manual runner operation. `npm run runner` is currently required
whenever the adopter wants queued decomposition work to be claimed and
processed. The mature local-supervisor target is owned in
[../../../docs/self-improvement.md](../../../docs/self-improvement.md).

Linear requires admin scope to create and inspect webhooks. Setup uses that
OAuth grant locally through GraphQL. The hosted inbox receives the Linear
webhook signing secret for verification and a separate runner credential for
wake leasing; it never receives Linear OAuth tokens and does not mutate Linear.
The setup handoff to the hosted inbox is authenticated with the scoped setup
grant that `init` self-issues during the browser flow, read from the environment
or from ignored local state at `.agentic-factory/inbox-setup-grant.env`;
adopters supply no token. Internal hosted-service operator credentials are not
the runner credential, are never required for normal adopter setup, and are not
sent to Linear.

`npm run doctor:linear` checks the same Linear substrate without mutating
workspace state. `npm run doctor` adds runner inbox credential, runtime smoke,
each domain's product-repo binding status, and read-only local Phoenix health.
`npm run phoenix:doctor` is also read-only; use `npm run phoenix:start` or
`npm run init` to install or start Phoenix.

`npm run preflight:phoenix` starts or reuses local Phoenix, emits one synthetic
trace through the local OTLP exporter, verifies the trace by id and span name in
Phoenix, records a local receipt, and exits non-zero when delivery cannot be
proved.

`npm run runner` starts one local Workflow Runner pass. It authenticates to the
hosted inbox with the runner credential, heartbeats, claims one queued wake-up,
renews the lease while active, re-reads Linear through GraphQL, attempts local
Phoenix trace export, and then drives the trigger runner execution core.

`npm run runtime-smoke` verifies each configured role runtime can start a
tool-less `session_start` invocation and return a locally schema-valid
subagent-turn packet for the installed runtime version. The smoke no longer
depends on a fixed PM/Sr Eng phase itinerary. The runner reads
`.agentic-factory/runtime-smoke.json` and fails closed when the current runtime
version has not passed that session-start readiness gate. Warm-continuation
smoke, when explicitly enabled, is recorded as separate non-gating capability
evidence.

`npm run trigger-status` is the secondary local/operator inspection command for
queued and terminal wake-up state. When a local per-run trace receipt exists,
the command combines hosted wake state with the local receipt result in its output.
The configured hosted status URL is a hosted inbox health/coordination
endpoint, not a PM-facing dashboard in MVP. The current foreground command
remains the operator view until the local supervisor can reconcile status back
through existing user surfaces. Phoenix is the trace and self-improvement UI.

`npm run uninstall` is the adopter cleanup path. It attempts to remove the registered
webhook inbox connection, stops any managed local Phoenix process,
revokes/removes the local runner inbox credential, then removes generated local
state and the local Linear OAuth credential. It does not delete reusable Linear
team, label, status, template, project, or issue objects.
It does not silently delete local Phoenix trace history under
`.agent-shell/phoenix-data`.

## Maintainer Command

`npm run reset` is a maintainer clean-slate command for testing onboarding. It
stops any managed local Phoenix process, clears local setup state and the local
OAuth credential, and leaves Phoenix trace history under `.agent-shell` intact.
Remote destructive cleanup is not part of the default command.

## Required Linear State

Init creates or resolves:

- the configured team, defaulting to `Agentic Factory` with key `AF`
- project label `Has Open Questions`
- issue label `Discovery`
- project status mappings for `backlog`, `planned`, and `started`
- project template `Agentic Factory Roadmap Item`

The config's `issue.statuses.unstarted` key names the fallback existing Linear
issue status for created execution issues. Adopters may also configure
`issue.statuses.ready` when their workflow already has a Ready state.
Decomposition uses the configured Ready state for committed execution issues
when available, and falls back to the configured unstarted state otherwise.
Execution issues are created unassigned, and agent output cannot bind Linear
assignee or label selectors. The issue body carries assignment, output, and
acceptance criteria so a human or later dispatch workflow can claim the work
from Linear without hidden routing.

Generated Linear IDs are cached in `.agentic-factory/linear.json`, which is
ignored by git. The cache is a convenience; Linear remains the product-intent
and live work source of truth.

Accepted decomposition packets and commit artifacts are stored in
`.agentic-factory/runs/<run_id>.json`, also ignored by git. Run artifacts are
written atomically with schema/version validation and read-back verification
before Linear mutations begin.

OAuth credentials are stored through OS credential storage by default. If OS
credential storage is unavailable, setup fails loudly unless the user has
explicitly configured the local file fallback for testing.

The runner-to-inbox credential uses a separate credential target and can be
revoked without invalidating Linear OAuth. Missing OS credential support fails
loudly unless the explicit local testing fallback is configured.

The runner credential carries wake/run capabilities only. It never contains
Linear OAuth, GitHub App user or installation tokens, Phoenix credentials, or
model-provider tokens, and those tokens must not be sent to hosted wake/run
services or local trace receipts.

## Trigger Inbox And Wake Queue

The first trigger is `linear.project.planned`: a Linear project update where
the project status changed and may now be in the configured `Planned` state.
The hosted inbox treats this as a candidate wake-up only. It verifies the
Linear HMAC signature and normalizes the event in memory, dedupes by
`Linear-Delivery`, and enqueues a decomposition wake with
`requires_runner_verification=true`. It persists no product content: only a
body hash, an allowlisted header subset, and derived routing facts are stored
(the data-minimization boundary is owned by `supabase/README.md`).

The repository includes a deterministic in-memory queue substrate for tests and
a hosted queue client contract for the runner. The current sandbox hosted
service is the Supabase Edge Function in `supabase/functions/agentic-factory-inbox`,
backed by the migration in `supabase/migrations`. It implements the same
heartbeat, claim, renew, mutation-start, complete, and dead-letter protocol as
the deterministic test substrate.

The runner is the first component allowed to mutate Linear. It must claim a
hosted wake-up and receive a lease token before re-reading the project through
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
webhook/team match, or cross-domain team conflict. Fix the domain registry or
hosted webhook identity first, then requeue the wake so it can be claimed again;
do not dead-letter it as ordinary runner failure.

`waiting_for_runner` is derived from a queued wake-up with no fresh compatible
runner heartbeat. It is not stored as a wake status.

Terminal statuses are `paused`, `completed`, `rejected`, and `dead_letter`.
Only non-terminal wake-ups are unique by `(workspace_id, wake_key)`, so a later
human move back to `Planned` after a pause creates a fresh wake-up.

No hidden Linear scan or reconciliation fallback may create mutation-capable
decomposition work. Repair tooling may inspect, enqueue, retry, or dead-letter
wake-ups, but it must not bypass wake claiming before Linear mutation.

## Local Phoenix Trace Collection

Local Phoenix on the adopter machine is the only supported trace/eval path for
now. The hosted inbox remains trace-agnostic and only coordinates webhook
ingestion, wake leases, and mutation safety.

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

If a Phoenix service is already running on the loopback endpoint, Agentic
Factory reuses it and records `managed=false`; it will not stop that external
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
`decomposition_quality` and must be one of the canonical rubric dimensions
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

The maintained hosted inbox runs as Supabase Edge Function
`agentic-factory-inbox` with JWT verification disabled. This is intentional for
Linear webhooks; the function performs custom Linear HMAC verification and
setup/runner credential checks.

Public setup docs do not include hosted deploy, secret rotation, or migration
commands. Those are maintainer launch operations, and runnable public setup
remains gated until the public hosted endpoint and launch proof are recorded.

Keep `npm test` deterministic and credential-free. When Linear behavior is part
of the claim, use the Agentic Factory OAuth credential and Linear GraphQL for
live smoke checks against disposable projects or issues, then move test
artifacts to a terminal state when the check is complete.

Project updates are required for decomposition. The deterministic path is the
Agentic Factory OAuth plus GraphQL client, not API keys and not substitute
project comments or documents. Live verification on 2026-06-07 confirmed that
this path can create a Linear project update with exact authored Markdown, find
it by `run_id`, and archive the test update afterward. The same live pass
verified refresh-token exchange and GraphQL auth with the refreshed token.

## Implemented Service Semantics

- The init service creates or resolves the `Agentic Factory` team, `Has Open
  Questions` project label, `Discovery` issue label, agreed project status
  mappings, and Linear project template when backed by a client that exposes
  those setup operations.
- The doctor service validates the same substrate without mutating Linear.
- The decomposition service gates on planned project status, open-question
  labels, team membership, open discovery issues, and prior execution issues
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
- Pause, completion, and resume project updates use exact authored
  `project_update_markdown` and are idempotent by `run_id`.
- Pause and resume replace the whole `Open Questions` section with exact
  authored `open_questions_markdown`; typed blocker objects are not rendered
  into project prose.
- Decomposition-created issues carry a stable decomposition key, and dependency
  relations are created idempotently.
- Malformed final issue keys, duplicate decomposition keys, and dangling
  dependencies fail closed before any Linear issue is created.
- Decomposition-created execution issues use the configured Ready issue status
  when available, otherwise the configured unstarted status. They are created
  without assignees or agent-supplied labels.
- Discovery issues carry a stable decomposition key so retry paths can
  find-or-create the same scoped discovery work.
- Discovery issue bodies are authored by Sr Eng and committed verbatim after a
  runner-owned decomposition key line. Discovery evidence stays on the
  Discovery issue and in an authored project update; the default flow does not
  write generated findings into the project body.
- Accepted turn packets, terminal orchestrator output, runtime metadata,
  role/runtime assignment, and final commit or pause artifacts are persisted to
  the ignored run store before Linear mutations, and commit retry replays that
  artifact instead of reusing fresh agent output.
- Triggered decomposition keeps `event_id`, `wake_id`, and `run_id` separate
  and joins them in wake records, workflow-run records, local run artifacts, and
  trace attributes.
- If a runner dies before Linear mutation starts, the lease can expire and the
  wake returns to `queued`. If it dies after mutation starts, the wake moves to
  `dead_letter` as an internal fail-closed state until a self-serve repair or
  future recovery path can reconcile from the original local run artifact or
  explicitly clean up partial Linear state.
- `decomposition_quality` is available as an offline scorer over trace and
  Linear state; it is not a live decomposition span or mutation gate.
- `accepted_packet_sufficiency` is available as an offline check that accepted
  packets contain enough serialized context for audit and commit retry. It is
  not a runtime fallback mechanism.
