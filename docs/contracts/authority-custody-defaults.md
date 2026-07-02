# Authority And Custody Defaults

Status: Distribution-pivot Phase 0B contract
Date: 2026-06-17

This record fills the authority and custody defaults left open by
[`teami-product-trust-record.md`](teami-product-trust-record.md).
It records the decision boundary for Phase 1 and Phase 2 work. It is not an
authority verifier, credential migration, hosted status product, broker
architecture, or public setup guide.

Changing these defaults requires an explicit product/trust decision. Do not let
implementation convenience decide who can write adopter resources, who can
recover a workspace, or what content may be captured.

## Source Commitments

The governing product commitments are:

- The owner is the sole authority for factory behavior changes.
- Linear owns product intent and live work state.
- GitHub owns behavior-changing proposals, checks, review, merge, and decline.
- Phoenix owns local trace/eval evidence, not the PM's required reading path.
- Maintainer updates are behavior-preserving engine/tooling updates; if they
  change adopter behavior, they must route as behavior-change proposals or wait.
- Hosted inbox/status endpoints coordinate backend health only. They do not
  mutate Linear, write repos, or become a PM dashboard in this slice.
- No human maintainer access path exists in v1. Maintainers cannot operate an
  adopter's factory, mint tokens by hand, write repos, mutate Linear, or make
  the acceptance decision. The current broker bridge is maintainer-operated
  infrastructure for maintainer sandbox proof only, not a support or adopter-normal
  access path.

Primary PM-facing copy must keep product consequences first. It must not expose
Git, package/runtime, raw diff, branch, token, endpoint, broker, Phoenix ID,
check-log, or repo-internal mechanics as the primary path unless the user asks
for technical detail.

Terminology used below:

- Maintainer sandbox bridge means maintainer-owned, sandbox, synthetic,
  or otherwise non-external-adopter targets. It is a proof vehicle.
- Real external validation means an adopter's real workspace, behavior repo, Linear
  content, GitHub account/org, or operating history. It is user trust data, even
  if the rollout is still invite-only.
- Broad adoption means public or repeatable adopter-normal setup.

## Authority Defaults

Write authority, setup authority, approval authority, and revoke authority are
different things. A component that can draft a proposal cannot accept it. A
component that can help create a behavior repo cannot keep admin authority. A
maintainer update channel cannot create adopter branches or PRs.

| Actor | Can propose | Can write proposal branch | Can merge/apply | Can change gates | Can mutate Linear | Can mint tokens | Can revoke |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PM/adopter | Yes | No direct GitHub work required | Yes, by merging or declining GitHub PRs in MVP; future apply paths require explicit policy | Yes, only through explicit owner-approved behavior-change PRs with risk label and old/new comparison | Yes, through authorized product actions | No | Yes |
| Foreground agent session | Yes | Yes, proposal branches only through the allowlisted client | No | No | Only through explicit workflow actions | No | No |
| Local runner/engine | Yes | Yes, limited by selected-repo installation and allowlisted client | No merge/apply path in MVP | No silent activation | Yes, through Linear OAuth and policy-bound idempotent actions | No | Local credentials only |
| Local supervisor after init trust grant | Yes | Yes, but unattended PR drafting stays report-only or disabled until the Phase 1 gate is fail-closed | No | No | Only while online, idempotent, rate-limited, and policy-bound | No | Deregister on uninstall |
| Existing-surface adapters | Render, link, summarize, and record | No independent authority | Route to accepted policy path only | No | No hidden direct mutation | No | No |
| GitHub App installation | No judgment | Selected behavior repo proposal branches only | No default-branch bypass | No | No | Installation tokens only through the approved authority path | Adopter/admin can uninstall |
| Linear OAuth grant | No | No | No | No | Scoped workspace/team actions | No | Adopter/admin can revoke |
| Hosted inbox/status | No | No | No | No | No | No | Adopter/admin cleanup |
| GitHub token broker for Phase 1/2 bridge | No judgment | Token issuance only; proposal writes only through selected-repo and ref-bound write path | No | No | No | Short-lived, tenant-bound, repo-bound installation tokens | Adopter/admin revoke plus broker-side tenant invalidation |
| GitHub repo-creation setup grant | No | One-time repo creation/admin setup only | No | No | No | Setup credential only; never retained at rest if admin-capable | Avoided or verified revoked immediately after setup |
| Hosted setup/renewal grant | No judgment | No repo writes by itself | No | No | No | Runner or broker credentials only within explicit TTL and use limits | Setup repair or uninstall revokes |
| Maintainer | No normal authority | No repo writes | Never merges, marks ready, reviews, applies, or accepts behavior | No | No | Cannot manually mint or use adopter repo tokens in v1 | No special access path |

### Owner Approval Posture

MVP repo-changing promotions always stop at an owner-reviewed PR. The proposal
writer, controller, runner, supervisor, broker, hosted inbox, and maintainer
update channel cannot merge, apply, mark ready, submit approving reviews,
override status, or accept behavior.

Governance, meta, authority, custody, credential, workflow/CI authority, and
unknown-sensitive changes are not adopter proposals and are not owner-approvable
through the adopter self-improvement lane. They are maintainer-owned, blocked
at the classifier, and fail-closed by default. If maintainers need to change
these surfaces, they do so through normal Teami development with explicit
old/new explanation, deterministic evidence, and no bundling with ordinary
behavior changes. The adopter cannot propose, route, or receive these changes
through the behavior-change PR path.

## GitHub Broker Posture

Current broker-backed proposal writes are allowed only as a maintainer sandbox bridge
for Phase 1 and Phase 2 on maintainer-owned, synthetic, or otherwise
non-external-adopter targets, and only after all required proof below exists:

- selected-repo enforcement by repo id, including mismatch failure.
- positive endpoint allowlist for every foreground, runner, supervisor, and
  broker path.
- token TTL and use-limit bounds.
- audit event emission for credential issuance and token minting.
- setup and renewal grant revocation proof.
- retirement or replacement criteria for the bridge.

This path is not adopter-normal. It must not be described in public or
PM-facing copy as the normal trust model for broad adoption. Real external
adopter data or a real external validation factory cannot use this broker bridge unless
a later explicit product decision promotes the hosted broker into a named trust
dependency with custody copy, support boundaries, and revoke/re-key behavior.

Target steady state is local/adopter-side GitHub write authority for proposal
branches. A permanent hosted broker may become the normal path only after a
later explicit product decision makes it a named trust dependency, adds custody
copy that says what the hosted service can and cannot see, and records the
mitigations for outage, compromise, revocation, tenant isolation, and support.

### Selected-Repo Boundary

Normal v1 setup must create or verify one private Teami behavior repo
under the adopter's GitHub account or organization, or another owner-approved
adopter-controlled location. For authority purposes, the behavior repo is an
adopter-owned resource even though Teami created it. A maintainer
project-owned sandbox repo may be used only for internal testing and is not a
real adopter factory.

The GitHub App installation must be scoped to the behavior repo and verified by
stable repo id. Product repos are not selected or touched in the normal setup
experience.

All-repo installation, public behavior repo exposure, product-repo access, repo
transfer, deleted repo, or repo-id mismatch are internal invariant failures:
setup or proposal writing stops, no product repo is touched, and product-facing
copy says the behavior repo could not be verified.

### GitHub Write Surface

GitHub writing has two surfaces, and both must be bounded before live use:

1. REST/PR operations, governed by the endpoint allowlist below.
2. The branch push that writes proposal commits to the selected behavior repo.

The push path is not covered by the REST endpoint allowlist. It must be bounded
separately:

- remote repo must equal the verified behavior repo id/name.
- pushed refs must be inside `refs/heads/teami/promotion/*`.
- default branch, protected branch, tag, workflow-authority, and arbitrary ref
  pushes are rejected.
- staged files must pass the protected-path and packet guards before push.
- the installation token used for push must be repo-bound, permission-bound,
  TTL-bound, and request-bound to that selected repo operation.

### Endpoint Allowlist

The Phase 1/2 proposal-write client may expose only:

- list open pull requests.
- list closed pull requests.
- get pull request.
- create pull request.
- update pull request body.

No client path may merge, apply, mark ready, submit review, approve, override
status, bypass branch protection, create or edit workflows, proxy arbitrary
GitHub requests, push outside the proposal namespace, or write outside the
selected behavior repo. Adding any such operation is a future product/trust
decision behind the shared acceptance system, not a convenience patch.

### Consent And Revocation Details

The GitHub App installation consent from CON-01 is filled as follows for the
behavior repo:

- Requested access: selected behavior repo only; metadata read,
  contents read/write for proposal branches and accepted behavior artifacts,
  pull requests read/write for PR creation/body updates/open/closed metadata.
- Excluded access: product repos, all-repo installation as a normal path,
  Actions/workflow write, checks/status override, issues, administration, and
  merge/review approval authority.
- Created or changed: behavior repo installation and verification record.
- Revoke method: uninstall the GitHub App or remove selected-repo access, then
  run setup repair/revocation check; future writes fail closed if minting or
  selected-repo verification no longer works.

GitHub user authorization is for identity, setup/account selection, and the
owner's ordinary GitHub review/merge experience. It is not retained as a hidden
repo-write credential unless a later local/adopter-side authority decision
explicitly chooses that path with custody copy. Revoke through GitHub
application settings and setup repair.

The setup grant consent is a one-time setup scope for creating or verifying
setup-time resources. If admin-capable repo creation authority is needed, it is
time-boxed, never retained at rest, and must have a revocation receipt before
the setup is considered complete.

### Token Lifetime And Use Limits

Broker-minted installation tokens for the Phase 1/2 bridge must be:

- tenant-bound.
- behavior-repo-bound by stable repo id.
- permission-bound to the requested allowlisted operation.
- short-lived, with an explicit maximum TTL recorded before live use.
- use-limited or operation-scoped where the platform allows it; otherwise every
  mint event must bind to one request id and one allowlisted operation.
- never logged, traced, committed, stored in Phoenix, included in diagnostics,
  sent to Linear, sent to model providers, or placed in proposal evidence.

Broker unavailable, expired token, repo mismatch, over-use, or revoked tenant
binding fails closed. GitHub work remains pending or blocked-for-repair; it
does not fall back to maintainer operation or broader credentials.

### Audit Event Shape

Every broker credential issuance, installation-token mint, setup grant, renewal
grant, and revocation check emits an audit event before Phase 1/2 writes use
the broker path.

Required event fields:

| Field | Meaning |
| --- | --- |
| `event_id` | Unique audit event id |
| `event_type` | `setup_grant_issued`, `setup_grant_revoked`, `renewal_grant_issued`, `renewal_grant_revoked`, `installation_token_minted`, `broker_request_denied`, or `revocation_checked` |
| `at` | Timestamp |
| `actor_or_grant` | Human actor id, local runner/supervisor identity, or grant id; never a secret |
| `tenant_id` | Teami tenant/workspace binding |
| `linear_workspace_id` | When relevant |
| `behavior_repo_id` | Stable GitHub repo id |
| `behavior_repo_name` | Owner/name display value |
| `installation_id` | GitHub App installation id when relevant |
| `requested_permissions` | Permission map requested for the allowlisted operation |
| `endpoint_id` | Allowlisted operation id, or `none` for setup/revocation |
| `request_id` | Correlation id for the operation |
| `expires_at` | Token or grant expiry |
| `use_limit` | Maximum uses, or `single_request` when represented by request binding |
| `uses_consumed` | Count observed by the issuer when applicable |
| `result` | `granted`, `denied`, `revoked`, `expired`, `failed`, or `verified_absent` |
| `revocation_state` | `active`, `revoked`, `expired`, `not_found`, or `unknown_fail_closed` |
| `failure_reason` | Machine reason when denied or failed |
| `credential_fingerprint` | Non-secret fingerprint only, if needed for dedupe |

Audit events must not contain tokens, private keys, OAuth refresh tokens,
proposal evidence, raw Linear content, raw GitHub content, PR bodies, model
provider credentials, or local absolute paths unless the path has been
classified as exportable diagnostic metadata.

### Setup And Renewal Grant Revocation Proof

Before Phase 1/2 broker-backed writes run against live targets, setup and
renewal grants need a recorded revocation proof:

- The setup grant scope is explicit, time-boxed, and limited to creating or
  verifying setup-time resources.
- Any admin-capable repo creation grant is avoided when possible; if used, it
  is never retained at rest and is verified revoked or absent immediately after
  setup.
- Hosted renewal grants have explicit TTL, use limits, storage class, and
  revoke route before use.
- Revocation proof records the grant id, scope, issued time, expiry, uses,
  revoke action, verifier, check time, result, and failure state.
- If revocation cannot be verified, future writes fail closed until the owner
  or an admin completes self-serve repair.

### Bridge Retirement Or Replacement Criteria

Phase 1/2 may use the current broker bridge only if the team has a recorded
answer for when it is retired or replaced. The bridge must be retired, replaced
by local/adopter-side authority, or converted into an explicit product trust
dependency before real external broad adoption if any of the following remain
true:

- proposal writes still require maintainer-operated infrastructure to mint
  adopter repo tokens.
- broker custody copy is not clear enough for a product-savvy nontechnical
  owner to understand.
- token TTL/use-limit, revocation, audit, selected-repo enforcement, or tenant
  isolation proof is missing.
- support would require maintainers to operate the user's factory.
- outage or compromise would leave no user-owned revoke and re-key path.

If the later product decision is to keep a permanent hosted broker, the public
trust story must say plainly that hosted infrastructure is part of the write
authority path, what it can see, what it cannot see, how to revoke it, and what
happens when it is unavailable.

## Untrusted Proposal Branch Rule

All agent-authored proposal branches are untrusted, including branches authored
by foreground agents, the runner, the supervisor, scanner jobs, and the
promotion controller.

Untrusted branches run with:

- no secrets.
- no write-token CI.
- no privileged workflow triggers.
- no status override.
- no artifact or log exfiltration route.
- no authority to evaluate or approve changes to their own gate, classifier,
  proposal machinery, credential surfaces, workflow/CI authority, or protected
  path map.

Changes to `.github/workflows/**`, CI/workflow authority, credentials,
permissions, risk gates, proposal controller machinery, acceptance policy,
meta-classifiers, or unknown sensitive paths fail closed or route as separate
governance/authority proposals. Candidate-produced evidence cannot satisfy the
candidate's own protection-rule change.

## Packet Guard Responsibility

The packet-completeness guard is responsible for blocking live owner-review PR
creation when the proposal packet is not judgeable. It checks prerequisites; it
does not decide product goodness.

Before `create pull request` or any equivalent live PR creation call, the guard
must reject missing product summary, missing before/after example, missing risk
label, missing concrete risk reason, missing required evidence, inaccessible
evidence, incompatible bundling, self-approval attempts, internal failed checks,
and unsafe evidence links.

If a PR already exists and later fails the guard, the PR marker, worklist, and
owner-facing copy mark it blocked-for-repair. It cannot satisfy live acceptance.
GitHub-enforced required checks or branch protection for already-open PRs are
future hardening unless the implementation explicitly adds and tests that path.

## Capture-Time Field Classes

Field classification happens before capture. Export-time redaction is not
enough for never-capture or local-only fields.

| Class | Capture rule | Examples | Allowed destinations |
| --- | --- | --- | --- |
| Never-capture | Reject before storage and record a local failure or redacted placeholder | OAuth tokens, refresh tokens, GitHub installation tokens, broker tokens, private keys, webhook secrets, model-provider keys, repo secrets, session cookies, bearer-style links, token-shaped values, prompt-injection requests to reveal secrets | Nowhere: not Phoenix, repo, PR bodies, logs, diagnostics, audit payloads, or exports |
| Local-only | May be used on the adopter machine, but not committed, sent to hosted services for storage, placed in PR bodies, or exported by default | Raw terminal output, raw run packets, raw Linear/GitHub payloads beyond the approved content inventory, local credential target names, machine-specific absolute paths, local supervisor internals | Ignored local state or OS credential/encrypted local store only; diagnostic export only if separately reclassified and previewed |
| Inference-transient | May leave the machine only as the current task's prompt/context sent to the owner-configured model provider or local model runtime; Teami must not store/export the full prompt unless another class permits it | Selected Linear/GitHub context snippets, role instructions, task prompts, tool context, redacted evidence context | Configured model provider or local model runtime for inference; no repo/Phoenix/diagnostic storage as full prompt by default |
| Repo-recordable | May be written to the behavior repo or PR body after redaction and product review | Accepted behavior snapshots, prompt pins, policy/rubric/evaluator artifacts, hashes, artifact paths, proposal summaries, before/after examples, risk labels, undo bounds, audit receipts without secrets | Behavior repo, PR body, local registry, exported repo history |
| Phoenix-recordable | May be stored in local Phoenix after capture policy and redaction | Trace/span metadata, redacted run inputs/outputs, local evidence handles, annotations, dataset examples, experiments, evaluator results, prompt versions, cost/usage metadata without secrets | Local Phoenix/eval store only; export/backup through custody baseline |
| Broker-audit-recordable | May leave the machine only as server-side records of the broker's own token/grant actions, with enumerated non-secret fields | Tenant id, behavior repo id/name, installation id, endpoint id, request id, expiry, result, revocation state, failure reason, non-secret credential fingerprint | Broker audit store; never PR bodies, Phoenix, model providers, or diagnostics unless redacted and manifest-previewed |
| Exportable | May leave the machine only after the adopter previews a manifest and initiates sharing | Redacted diagnostic summary, version info, health state, selected non-secret audit facts, redacted evidence report, failure reasons, non-secret IDs needed for support | User-chosen diagnostic bundle or backup/export path |

When data fits multiple classes, the most restrictive class wins. For example,
a token-shaped value inside a PR body is never-capture even if the surrounding
PR body is repo-recordable.

Model-provider inference is a custody egress, not a storage destination.
Before real external data, setup/data disclosure must say which model provider
or local runtime receives prompt/context payloads, what content classes may be
sent, and which classes are barred by never-capture or local-only rules.

Broker audit data is also an automatic custody egress when the broker bridge is
used. It is limited to the broker's own non-secret action records. It does not
make raw adopter content, proposal evidence, PR bodies, Linear content, GitHub
content, Phoenix data, or credentials visible to maintainers.

## Minimum Custody Baseline

This baseline is required before real external Phase 2 data or Phase 6 validation data
is used. Internal dry-runs and synthetic fixtures may precede it only if they
are clearly labeled and do not claim external-data readiness.

### Content Inventory

The product must inventory exactly what Linear and GitHub content is captured:

- Linear workspace, team, project, issue, status, label, update, and relation
  identifiers used for routing and receipts.
- Linear titles, descriptions, comments, project updates, issue bodies, labels,
  and generated output only when needed for decomposition, evidence, or repair.
- GitHub behavior repo id/name, PR number/state/body, proposal branch name,
  selected accepted behavior artifacts, changed artifact paths, commit trailers,
  and review/decline metadata needed for dedupe or rejection memory.
- No product repo content in normal v1 setup.
- No GitHub all-repo inventory in normal v1 setup.

Every captured field must name its field class and destination before capture.

### Redaction Before Storage

Redaction happens before trace, proposal, eval, log, audit, PR, or diagnostic
storage. Never-capture values are rejected rather than stored with later
redaction. Local-only values remain local and are not copied into Phoenix,
proposal evidence, PR bodies, diagnostics, or exported bundles unless a later
explicit product decision reclassifies them.

Negative custody fixtures must include fake OAuth tokens, GitHub installation
tokens, repo secrets, sensitive Linear/GitHub content, bearer-style URLs, raw
credential-looking strings, and prompt-injection exfiltration attempts. Tests
must fail if never-capture data appears in Phoenix, proposal evidence, PR
bodies, logs, diagnostics, or exports.

### Storage Locations

| Data | Default location | Notes |
| --- | --- | --- |
| Trace and span evidence | Local Phoenix | High-volume evidence store; not required PM reading |
| Run retry artifacts | Ignored local run store such as `.teami/runs/` | Retry authority before Linear mutation; not a durable eval backend |
| Trace health and delivery failures | Ignored local telemetry state | Audit-only; do not promise replay unless a later design proves it |
| Linear/GitHub snapshots | Redacted local run store and/or local Phoenix by class | Enough to evaluate and repair; no product repo capture by default |
| Human annotations | Local Phoenix | Export/back-up required before external data |
| Promoted examples and datasets | Local Phoenix; curated redacted regression assets may live in the repo | Loop-generated examples are quarantined until accepted |
| Proposal evidence | PR body plus local registry/receipt; optional Phoenix depth links | PR body must carry standalone product summary that survives Phoenix loss |
| Accepted behavior | Behavior repo | Versioned, reviewable, and owner-approved |
| Audit events | Local audit store or broker audit store by event type | No secrets or raw evidence in event payload; broker-side audit egress must be disclosed before broker use |
| Diagnostic bundle | User-chosen export path after manifest preview | User-initiated sharing only |

### Human-Labeled Tests, Annotations, And Backup

Before real external data, the owner must have a minimum viable export or
backup path for human-labeled test examples, annotations, calibration examples,
datasets, experiments, evaluator results, prompt versions, and proposal
evidence summaries. The default is a user-initiated local export to a
user-chosen destination. Automatic cloud backup is not implied.

If the export path does not exist or has not run, proposal packets must disclose
that local evidence durability is degraded, and evidence quality may need to
drop. Human-labeled test sets are human-append-only or otherwise protected from
autonomous rewrite before they can support future auto-acceptance.

### Local Phoenix Loss, Corruption, Or Move

Local Phoenix is local custody. If local Phoenix state is lost, corrupted, or
moved without an export/import path:

- Teami does not pretend raw evidence still exists.
- proposal history in GitHub and the behavior repo remains, but optional
  Phoenix depth may be unavailable.
- evidence quality for affected proposals is degraded or fail-closed until the
  workspace is re-annotated or restored.
- human annotations, calibration examples, test split exposure history, and
  promoted examples may be unrecoverable unless exported.
- moving to a new machine requires explicit restore/import or a re-baseline
  path; local paths and credential bindings are not portable evidence.

Reset and uninstall must not silently delete local Phoenix data. Deletion
promises must say whether they include local Phoenix traces and derived eval
artifacts.

### Credential Protection

Local credentials must use OS credential storage or an encrypted local store
before real external data. Plaintext credentials in the repo working tree,
Phoenix, PR bodies, logs, diagnostics, or exported bundles are prohibited.

At-rest protection covers Linear OAuth credentials, GitHub user/App grants,
broker tenant bindings, supervisor credentials, runner credentials, model
provider credentials, webhook secrets, and any setup/renewal grants. Credential
fingerprints may be used for diagnostics only when they cannot be used as
credentials.

### Lost Or Stolen Device Revoke-All

Before real external data, the product needs a user-reachable revoke-all and
re-key path covering:

- Linear OAuth revocation and reauthorization.
- GitHub App uninstall or selected-repo access removal, then reinstall.
- GitHub user authorization revocation.
- broker tenant binding invalidation.
- setup and renewal grant revocation.
- local supervisor deregistration.
- runner credential invalidation.
- webhook secret rotation where applicable.
- local credential store wipe or re-key.
- model provider credential rotation if Teami stored or mediated it.

Maintainers may explain this path from a diagnostic bundle. They do not perform
the revocation, hold recovery keys, mint replacement tokens, mutate Linear, or
write the adopter repo.

### Retention And Deletion

Retention and deletion behavior must be testable by field class. Minimum
requirements before real external data:

- owner-visible retention defaults for local runs, local telemetry, Phoenix
  traces, annotations, datasets, experiments, proposal evidence, audit events,
  and diagnostics.
- deletion commands or setup repair paths that state what they delete, what
  they preserve, and what cannot be recreated.
- no silent deletion of the behavior repo or its history on uninstall.
- no deletion promise that excludes Phoenix or derived eval artifacts unless
  the exclusion is explicit before the user relies on the promise.

### Tenant Isolation

Every captured record must preserve tenant/workspace/domain/repo identity
needed to prevent cross-workspace mixing. Broker tokens are tenant-bound and
repo-bound. Local run stores, Phoenix evidence, proposal receipts, and
diagnostic bundles preserve team/project/artifact namespaces when one behavior
repo serves multiple Linear teams.

Evidence from one team may support a shared behavior change only when the
packet states which teams supplied evidence, which teams the change affects,
and whether examples were redacted or generalized.

### External Egress Boundary

Before real external data, every automatic egress must be disclosed separately
from user-initiated diagnostic sharing:

- model-provider inference egress for task prompts/context.
- broker audit egress if the broker bridge is used.
- hosted inbox/status coordination facts, if any.
- package/update check metadata, if any.

Automatic egress is not support access and not delegated operation. It must
have a field class, destination, retention behavior, tenant isolation story,
and revoke/disable path before use.

### Diagnostic Export Boundary

Diagnostics leave the machine only when the adopter initiates sharing. Before
anything leaves the machine, Teami shows a previewable manifest.

Minimum manifest fields:

| Field | Meaning |
| --- | --- |
| `bundle_id` | Diagnostic export id |
| `created_at` | Timestamp |
| `reason` | User-selected or support-requested reason |
| `included_classes` | Field classes included |
| `excluded_classes` | Field classes excluded, always including never-capture |
| `files` | Relative bundle file names, sizes, and content hashes |
| `redaction_policy_version` | Redaction policy used |
| `linear_content_summary` | Counts and coarse object kinds, not raw content unless exportable |
| `github_content_summary` | Counts and coarse object kinds, not raw content unless exportable |
| `phoenix_content_summary` | Counts and evidence handle classes, not raw trace payloads unless exportable |
| `credential_scan_result` | Pass/fail plus non-secret reasons |
| `known_exclusions` | What support cannot see and may ask the user to inspect locally |

The diagnostic bundle is support evidence, not delegated operation. A support
person reading it cannot operate the factory, mint credentials, recover keys,
write repos, mutate Linear, or approve behavior.

### Safe Phoenix Evidence Links

PRs and proposal packets may include only adopter-scoped non-secret evidence
handles or redacted evidence reports. They must not include public Phoenix URLs,
bearer-style links, raw trace IDs as the primary path, loopback-port mechanics,
maintainer-resolvable evidence links, or anything that lets a maintainer or
outside reader fetch local evidence without the adopter's action.

The PR body must preserve enough standalone product evidence to understand why
a change was accepted even if Phoenix is later unavailable. Hashes alone are
not enough for the target persona.

## No-Maintainer-Access Boundary

V1 has no human maintainer-operated recovery access. Maintainers cannot:

- mint adopter GitHub tokens.
- hold or use adopter Linear OAuth credentials.
- mutate Linear.
- write behavior repos.
- create adopter branches or PRs.
- merge, apply, mark ready, review, or accept behavior.
- operate the runner, supervisor, Phoenix, or hosted inbox for the adopter.
- bypass branch protection, gates, packet guards, or owner approval.
- use break-glass credentials for real external validation.

Maintainers may publish signed engine recall or block metadata only for
behavior-preserving engine/tooling safety once the later release channel proves
integrity, recall, and last-good rollback. That power cannot change adopter
behavior rules, prompts, policies, evals, thresholds, approval rules, or
self-improvement goals; behavior-changing content routes through the owner's
behavior PR flow or is deferred. The release-channel machinery is later work,
not a capability this Phase 0B contract claims is built.

During validation, maintainers may receive only user-shared redacted diagnostics and
give guidance. Any helper intervention that cannot be expressed as guided
self-serve repair or user-initiated diagnostic export is product debt and is
not an adopter-normal capability.

## Break-Glass And Recovery Inventory

| Path | Phase 1/2 maintainer status | Real external validation status | Required replacement |
| --- | --- | --- | --- |
| Maintainer repo write access | Disabled except ordinary GitHub collaboration on project-owned repos, never adopter repos | Disabled | Owner-approved PR flow plus self-serve repair |
| Maintainer Linear mutation | Disabled | Disabled | Linear reauthorization and owner/admin repair |
| Maintainer token minting | Disabled | Disabled | User-owned revoke/re-key and selected-repo reauthorization |
| Broker private key/admin operation | Internal platform operation only; no manual adopter-token minting outside audited broker flow | Disabled as support/recovery path | Local/adopter-side authority or explicit hosted broker trust dependency |
| Broker-issued installation token | Maintainer-owned or synthetic validation bridge only after proof | Disabled unless later product decision makes broker normal with custody copy | Local/adopter-side proposal write authority |
| Setup org/admin repo-creation grant | One-time setup bridge; avoided or verified revoked | Self-serve only; no maintainer possession | User/admin consent flow plus revocation receipt |
| Hosted renewal grant | Internal bridge only with TTL/use limits | Disabled unless explicit external-data custody baseline permits it | User-triggered renewal or local authority |
| Hosted inbox admin edits | Internal diagnostics for service health only | No user-work recovery | Self-serve repair plus diagnostic export |
| Runner/supervisor credential reset | Local self-serve repair path | Self-serve only | Reauthorize and re-key locally |
| Phoenix loss/corruption repair | Local restore/re-baseline guidance | User-initiated restore/export only | Backup/export/import plus degraded-evidence handling |
| Engine recall/block | Maintainer may publish signed recall/block metadata | Allowed only as behavior-preserving engine/tooling safety receipt | Signed release channel, last-good rollback, behavior-preservation proof |
| Behavior-changing maintainer baseline | Not a maintainer update | Not a maintainer update | Owner-reviewed behavior PR or deferred |
| Diagnostic support | User-shared redacted bundle only | User-shared redacted bundle only | Manifest preview and user-initiated sharing |

## Narrow Live Proofs Before Phase 1/2 Writes

Before any Phase 1/2 live proposal writes use the broker-backed path on
internal/maintainer-owned or synthetic targets, the following proofs must exist.
These are narrow proofs, not a full authority verifier, and they do not
authorize broker-backed writes against real external adopter data.

1. Selected-repo proof: setup verifies stable behavior repo id, rejects
   mismatch, all-repo/product-repo/public-repo drift, and records the result.
2. Positive allowlist and ref-bound proof: foreground agent, runner,
   supervisor, and broker clients cannot merge, apply, mark ready, submit
   review, override status, bypass branch protection, edit workflows, push
   default/protected/arbitrary refs, or proxy arbitrary GitHub operations.
3. Token-boundary proof: broker tokens are tenant-bound, repo-bound,
   permission-bound, TTL-bound, use-limited or request-bound, never retained in
   repo/Phoenix/logs/diagnostics, and fail closed on expiry, mismatch, over-use,
   or broker unavailability.
4. Audit proof: broker credential issuance and installation-token minting emit
   the required audit event shape without secrets or raw evidence.
5. Revocation proof: setup grants, renewal grants, GitHub installation access,
   Linear OAuth, runner credentials, and broker tenant bindings have a recorded
   revoke/check route and fail closed when revoked.
6. Untrusted-branch proof: proposal branches run with no secrets, no
   privileged workflow triggers, no write-token CI, no status override, and no
   artifact/log exfiltration path.
7. Packet-guard proof: live PR creation is blocked when the structured packet
   lacks required product summary, before/after evidence, risk reason, evidence
   links, bundling safety, or self-approval protection.
8. Diagnostic/no-maintainer-access proof: a user-previewable diagnostic
   manifest exists, never-capture fields are excluded, and support cannot turn
   the bundle into repo, Linear, credential, or acceptance authority.
9. Custody fixture proof: fake tokens, repo secrets, sensitive Linear/GitHub
   content, and prompt-injection exfiltration attempts do not appear outside
   their allowed field class.

If any proof is absent, Phase 1/2 proposal writing stays dry-run,
report-only, read-only, or blocked-for-repair. The product must not ask the
owner to trust live writes on an unproven path.
