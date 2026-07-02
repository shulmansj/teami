# Wake Domain Identity Contract (T2.0)

Status: FROZEN once Track 2A and Track 2B begin. Changing anything here requires
pausing both tracks, editing this doc, and reconciling both worktrees before
resuming. Track 2B implements the hosted side (migration + edge function) and
the executable mirror (`MemoryInboxStore`, hosted client). Track 2A consumes
the shapes for display and repair. Phase 3 consumes the claim/release/requeue
semantics.

Companion: `docs/contracts/domain-context.md` (DomainContext shape,
resolver ladder, selector/reason/candidate shapes). This doc never redefines
those shapes; it only names where they flow.

## Custody Split (decided; do not relitigate)

- The hosted inbox stores **identity facts only**: which webhook matched, which
  team ids the payload claims, what the runner reported. It never reads the
  domain registry, never resolves a domain, never mutates Linear, and never
  learns "domain" as a concept beyond storing an opaque `domain_id` string the
  runner writes back.
- The **local resolver** (`domain-resolver.mjs`) maps facts -> `domain_id`.
- The **runner** (Phase 3) writes the resolved `domain_id` and any
  `routing_error` transition back to the hosted inbox.
- Deploy discipline (live finding 2026-06-11): the deployed edge function must
  always equal the committed source on `main`. Deploying uncommitted function
  code is what produced the `enrollmentId` drift; do not repeat it. The PR that
  changes `index.ts` documents the deploy commands; the maintainer deploys
  after merge.

## Column Additions (Track 2B migration)

`webhook_deliveries`:

| column | type | set when |
| --- | --- | --- |
| `webhook_id` | text NOT NULL | at signature verification (`verifyStoredLinearSignature` already identifies the matched secret) |
| `webhook_secret_id` | text NOT NULL | same moment, from the matched secret row |

`trigger_events`:

| column | type | set when |
| --- | --- | --- |
| `webhook_id` | text NOT NULL | propagated from the delivery |
| `team_ids` | jsonb NOT NULL DEFAULT '[]' | extracted from the event payload's project context (project `teamIds`; empty array when the payload carries none) |

`wakeups`:

| column | type | set when |
| --- | --- | --- |
| `webhook_ids` | jsonb NOT NULL DEFAULT '[]' | accumulated set of every webhook id that delivered this wake's event (see Dedupe) |
| `team_ids` | jsonb NOT NULL DEFAULT '[]' | accumulated union of payload team ids across deliveries |
| `domain_id` | text NULL | written by the runner after successful resolution (never by the inbox itself) |
| `routing_error_reason` | text NULL | written on transition to `routing_error`; values come from the resolver reason enum in domain-context.md |
| `routing_candidates` | jsonb NULL | written on transition to `routing_error`; array of candidate objects exactly as domain-context.md defines them: `[{ "domainId": "...", "status": "...", "teamId": "..." }]` |

Accumulated arrays are sorted, deduplicated, JSON arrays of strings.

## Wake Status Machine

- `routing_error` joins the status CHECK constraint:
  `queued | leased | running | paused | completed | rejected | dead_letter | routing_error`.
- `routing_error` IS a member of ACTIVE_STATUSES for the partial unique index
  on `(workspace_id, wake_key)` (decided: a quarantined object must not spawn a
  duplicate active wake).
- Allowed transitions added: `leased -> routing_error` (runner could not
  resolve), `routing_error -> queued` (requeue after repair), and
  `leased -> queued` (release; see below). No other path may enter or leave
  `routing_error`.

## Dedupe Rule (decided)

One wake per workspace/object/event ACROSS webhooks. `wake_key` derivation is
unchanged. Delivery-level dedupe still keys on `delivery_id` (which differs per
webhook for the same Linear event) and therefore does NOT collapse cross-webhook
duplicates; wake-level dedupe does. When an insert hits an existing ACTIVE wake
with the same `(workspace_id, wake_key)`:

- `webhook_ids` ∪= the new delivery's `webhook_id`
- `team_ids` ∪= the new event's `team_ids`
- nothing else on the wake changes (no attempt-count, no lease, no status
  side effects)

Resolution (Phase 3) uses the ACCUMULATED `team_ids` intersection and the
ACCUMULATED `webhook_ids` — never a single webhook id alone, because
first-writer-wins provenance is explicitly rejected.

## API Surface (Track 2B implements hosted + mirror + client)

All request/response shapes below are exact. Auth: `runner` means
`requireRunnerCredential` (body carries `credentialId` + `token` as today);
`admin` means the setup admin token header.

### `POST /v1/wakeups/claim` (runner) — extended

Request gains one optional field:

```json
{ "...existing fields...": "...", "webhookIds": ["whk_a", "whk_b"] }
```

When `webhookIds` is present and non-empty, only wakes whose accumulated
`webhook_ids` intersect it are claimable. Omitted/empty = today's behavior.
The filter applies at query level across the ENTIRE queued set — a
page-then-filter implementation that can starve matching wakes behind
non-matching ones is non-conformant.
Response unchanged, except the wake object now carries `webhook_ids`,
`team_ids`, `domain_id`, `routing_error_reason`, `routing_candidates`.

### `POST /v1/wakeups/release` (runner) — new

Lease surrender for wrong-domain claims (resolved fine, but this runner serves
a different `--domain`). NOT an error path.

```json
// request
{ "credentialId": "...", "token": "...", "wakeId": "...", "leaseToken": "...", "reason": "domain_not_served" }
// response
{ "ok": true, "wakeId": "...", "status": "queued", "attemptCount": 3 }
```

Semantics: `leased -> queued`, lease cleared, `attempt_count` increment stands
(no other side effects). Invalid lease -> HTTP 409.

### `POST /v1/wakeups/routing-error` (runner) — new

```json
// request
{ "credentialId": "...", "token": "...", "wakeId": "...", "leaseToken": "...",
  "reason": "<resolver reason enum value>",
  "candidates": [{ "domainId": "...", "status": "...", "teamId": "..." }] }
// response
{ "ok": true, "wakeId": "...", "status": "routing_error" }
```

Semantics: `leased -> routing_error`; persists `routing_error_reason` and
`routing_candidates`; clears the lease ENTIRELY (lease token, runner id,
lease expiry, AND claimed_at — a quarantined wake must not look claimed in
any view). The wake stays active for dedupe.
Malformed `candidates` (non-array input, or entries missing/non-string
`domainId`/`status`, or `teamId` that is neither string nor null) are
REJECTED — HTTP 400 hosted, `{ ok: false, reason: "invalid_candidates" }`
mirror — never coerced or defaulted. Quarantine data is repair-critical.

### `POST /v1/wakeups/requeue` (runner) — new

Repair path after registry fix or Linear team reassignment; no new Linear
webhook delivery required.

```json
// request
{ "credentialId": "...", "token": "...", "wakeId": "..." }
// response
{ "ok": true, "wakeId": "...", "status": "queued" }
```

Semantics: `routing_error -> queued` only; clears `routing_error_reason`,
`routing_candidates`, and `domain_id`; resets nothing else. Any other current
status -> HTTP 409.

### `POST /v1/wakeups/mark-running` (runner) — extended

Request gains REQUIRED field `domainId` (non-empty string; the inbox stores it
opaquely and remains domain-ignorant). Both surfaces reject mark-running
without it. Amended 2026-06-11 post-Phase-3 review: requiring the opaque field
at the transition API makes "no wake runs unresolved" structural on both
sides instead of a single-call-site convention in the runner; the runner
additionally enforces resolution-before-mark-running by construction
(run path takes a resolved DomainContext as a required argument).

### Webhook ingestion (no route change)

`verifyStoredLinearSignature` already returns the matched `secretId`; thread
the matched `webhook_id` + `webhook_secret_id` into the delivery row, the
event row, and wake accumulation per the Dedupe rule.

## Migration Backfill and Error Parity

- Pre-migration rows are backfilled with EMPTY fact arrays (`'[]'`) — honest
  absence, never sentinel values (`legacy_unknown` or similar). Legacy wakes
  resolve through the normal ladder; in a single-domain workspace the
  workspace rung resolves them correctly.
- The wake-queue-store interface is the parity boundary: the hosted client
  normalizes structured HTTP 4xx error responses into the same
  `{ ok: false, reason }` objects `MemoryInboxStore` returns, so consumers
  cannot tell the two stores apart behaviorally.
- Dedupe accumulation on an existing wake must be guarded by active status at
  update time; if the existing wake reached a terminal status between
  conflict detection and update, insert a fresh wake instead of mutating the
  terminal row (the partial unique index only covers active statuses).
- Requeue addresses a wake by `(workspace_id, wakeId)` on both surfaces.

## MemoryInboxStore Mirror (Track 2B, same PR)

`MemoryInboxStore` and `hosted-inbox-client.mjs` implement the identical state
machine and shapes; `linear-trigger-inbox.test.mjs` is where the executable
truth lives, including at minimum:

- signature verification records matched `webhook_id`/`webhook_secret_id`;
- delivery/event/wake rows persist the new identity facts;
- same workspace + two webhooks -> facts distinguish them;
- same Linear event via two webhooks -> exactly one active wake with
  accumulated provenance;
- `routing_error` transition, requeue, claim filter, and release all behave
  exactly per this doc;
- multi-team project facts (two governed teams / zero governed teams) are
  representable for Phase 3 quarantine tests.

## What Track 2A May Assume

- Wake view rows returned by `/v1/wakeups/views` carry `webhook_ids`,
  `team_ids`, `domain_id`, `routing_error_reason`, `routing_candidates` —
  enough for display-side resolution via the local resolver in one hosted
  call. 2A renders; it never writes wake state.
