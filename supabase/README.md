# Supabase Hosted Service Source

This folder contains the Supabase Edge Function source for the Agentic
Factory-operated hosted setup service: the Linear webhook inbox, wake queue,
GitHub App install callback, and behavior-repo token broker.

This is source and trust-boundary documentation. It is not adopter-primary setup copy
and does not create maintainer support authority. Public launch does not ask
evaluators to deploy their own Supabase project. The checked-in public config currently points at
`public-hosted-setup.agentic-factory.invalid`, so the hosted setup path is not a
working public endpoint until the launch gates close.

The hosted service is a best-effort public beta boundary, not an enterprise
support, uptime, or recovery promise. It coordinates webhooks and setup grants;
it is not a maintainer support backdoor into an adopter's Linear workspace,
local Phoenix instance, or product repository.

The public hosted gates that must close before runnable setup copy is final are
tracked outside the public artifact: public-launch key rotation, GitHub App
visible metadata/settings verification, deploy-side abuse and rate monitoring
evidence, and external setup proof.

The function is deployed with Supabase JWT verification disabled because Linear
webhooks cannot present Supabase JWTs. The function still performs custom
authentication:

- Linear deliveries are verified with the stored Linear HMAC signing secret.
- setup handoff endpoints (webhook secret, runner credential, broker credential)
  require the self-issued setup grant (`x-agentic-factory-setup-grant`); adopters
  paste no token.
- maintenance endpoints require `AGENTIC_FACTORY_INBOX_ADMIN_TOKEN`; this is a
  maintainer-only hosted operations credential, not an adopter support or recovery path.
- runner endpoints require the runner-to-inbox credential minted during
  `npm run init`.

The function is the hosted wake/run registry only. It verifies webhooks,
dedupes deliveries, leases wake-ups, records terminal wake/run state, and
coordinates mutation safety. It does not receive Phoenix trace payloads, does
not store trace status, and does not hold Phoenix credentials. Local Phoenix on
the runner machine owns trace and eval data for this MVP.

## Data Minimization Boundary

The hosted inbox stores no product content. Linear webhook bodies (which carry
project names and descriptions) are consumed in memory for HMAC verification
and event normalization, then discarded. What persists:

- delivery rows: a SHA-256 hash of the body, an allowlisted header subset
  (`linear-delivery`, `linear-signature`, `content-type`, `user-agent`),
  dedupe keys, and timestamps — pruned after the retention window.
- trigger events: IDs, event type, changed-field names, team IDs, and the
  derived `project_status_type` routing fact. Never the payload.
- wake-ups, runs, heartbeats: IDs and lifecycle state only.

The inbox never mutates Linear, never receives Linear OAuth tokens, and stores
only SHA-256 hashes of runner credentials. The runner re-reads all product
content directly from Linear through the adopter's own OAuth.

Maintainer rollout for data minimization is a three-step sequence, each step
safe with the deployed state on either side of it:

1. Apply `20260612090000_inbox_data_minimization.sql` (additive: new columns,
   relaxed constraint — both function versions keep working).
2. Deploy the minimized `agentic-factory-inbox` function.
3. Apply `20260612090001_inbox_data_minimization_scrub.sql` (idempotent scrub
   of previously stored content; nothing re-accumulates because the minimized
   function is already the only writer).

Exact hosted deployment, secret rotation, and migration commands are maintainer
launch operations. They are intentionally not part of the public setup path.

## GitHub App Token Broker

The GitHub broker mints short-lived installation tokens for the selected
Agentic Factory behavior repo after setup verifies the GitHub App installation.
That behavior repo is the process/proposal surface for reviewable Agentic
Factory changes. It is not product-repo access, it is not an all-repositories
grant, and it is distinct from local domain `git_repo` checkout binding.

The GitHub App private key belongs only in hosted Supabase secrets. Local code
never stores or reads the App private key after provisioning; broker calls send
a repo-scoped request plus the local broker credential and receive a
short-lived installation token for the selected behavior repo.

Required hosted secrets:

- `AGENTIC_FACTORY_GITHUB_APP_ID` — the shared GitHub App's id.
- `AGENTIC_FACTORY_GITHUB_APP_SLUG` — the App's slug (the `github.com/apps/<slug>`
  segment); the broker checks the installed app's slug against it.
- `AGENTIC_FACTORY_GITHUB_APP_PRIVATE_KEY` — the App private-key PEM. A single line
  with `\n` escapes or real newlines both work (the inbox and broker un-escape
  `\n`). The inbox uses this key to discover the repo installation before
  binding a setup grant; the broker uses it to mint short-lived installation
  tokens after setup is verified.
- `AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_ID` and
  `AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_SECRET` — the App's OAuth credentials; the
  inbox exchanges the install-time `code` with them to prove repo write access
  before binding an installation.
- `AGENTIC_FACTORY_BROKER_CREDENTIAL_SIGNING_KEY` — HMAC key the inbox signs
  installation-bound broker credentials with and the broker verifies; the same
  value serves both functions (project-level secrets cover both).
- `AGENTIC_FACTORY_GITHUB_BROKER_TOKEN` - legacy maintainer-only bearer fallback
  when no installation-bound credential is presented; not used by normal public
  setup and not an adopter support credential.
- `AGENTIC_FACTORY_INBOX_ADMIN_TOKEN` - maintainer admin token for hosted
  service maintenance; not used for normal setup handoff or adopter recovery,
  meaning it is never used for normal setup handoff or adopter recovery.

The local broker credential is stored in ignored local custody, normally
`.agentic-factory/github-broker-token.env`, or supplied through
`AGENTIC_FACTORY_GITHUB_BROKER_TOKEN`. Do not commit it. The App private-key PEM
is only a hosted secret provisioning input; once the hosted secret is set and
verified, deleting the local PEM does not remove the hosted secret.

The broker verifies the installed App identity and exact permission snapshot
before minting bridge tokens. Selected-repo permissions must remain exactly
`metadata:read`, `contents:write`, and `pull_requests:write`, with no
issues/comments/workflows/admin permissions.

The shared App must also have **"Request user authorization (OAuth) during
installation"** enabled, with its **Callback URL** and **Setup URL** both set to
the deployed inbox `.../v1/github/install-callback`. That is what makes the
post-install redirect carry the OAuth `code` the inbox exchanges to prove repo
write access; without it, installation binding cannot complete and the broker
cannot serve the bounded broker path. Legacy fallback credentials do not
create adopter support access.

Domain `git_repo` product checkout binding remains a separate local mechanism.
It binds one existing local checkout per domain through the landed
`domain:bind-repo` setup command. The hosted GitHub broker must not be
described as binding, reading, or executing inside product repos.

For hosted rollout, maintainers must not treat generic migration push behavior
as the production sequence when an existing inbox has traffic. Apply
`20260612090000_inbox_data_minimization.sql` first, deploy the minimized
`agentic-factory-inbox` function second, then apply
`20260612090001_inbox_data_minimization_scrub.sql` after the new function is
live. If the previous inbox function could have written deliveries during the
deploy window, re-run the scrub SQL once more after the function deploy. The
post-deploy scrub re-run is a required checklist item.

Keep local migration filenames aligned with `supabase_migrations` on the hosted
project before any maintainer deploy. The domain identity migration rebuilds
the active wake unique index and sets new columns `not null`; those operations
take brief table locks, so they belong in a quiet hosted maintenance window.

## Edge Function Dependency Checks

The Edge Functions import npm packages directly from Deno source, so the root
`package-lock.json` is not the runtime dependency graph for hosted functions.
The committed root `deno.lock` is the source of truth for the Supabase Edge
Function import graph.

Maintainers verify the Edge dependency posture with:

```bash
npm run edge:lock
npm run edge:check
npm run edge:audit
```

`edge:lock` regenerates `deno.lock` from every
`supabase/functions/*/index.ts` entrypoint. `edge:check` runs the same pinned
Deno checker with `--frozen=true`, so stale or missing lock state fails in the
local gate and will fail CI once CI-U1 wires this command. Both commands use
Deno `2.8.3` via the pinned npm package `deno@2.8.3`; the Supabase CLI is not
part of this dependency gate and deploy remains a separate maintainer-run
operation.

`edge:audit` rejects unclassified remote `http:`, `https:`, and `jsr:` imports,
requires direct `npm:` imports to use exact `x.y.z` versions, reads the
committed `deno.lock` npm graph, synthesizes a temporary npm project from those
locked exact package versions, runs `npm audit --audit-level=low`, and fails on
any installed package without an allowed license (`MIT`, `Apache-2.0`,
`BSD-2-Clause`, `BSD-3-Clause`, `ISC`, or `0BSD`). If the npm registry, pinned
Deno package, or audit data is unavailable, the command fails closed instead of
treating the Edge dependency posture as proven.
