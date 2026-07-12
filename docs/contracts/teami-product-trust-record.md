# Teami Product Trust Record

Status: current
Current product path: yes
Date: 2026-07-11

This contract records the current adopter-visible product and trust promise.
Changing it requires an explicit product decision. Implementation details live
in the owner docs linked from [`docs/README.md`](../README.md); those docs must
not contradict this record.

## Product Promise

Teami is power, not a place: a local companion that turns Linear product intent
into agent-ready work without making the adopter the technical coordinator.
The adopter makes product, taste, scope, trust, and business decisions. Teami
conducts deterministic setup and workflow surfaces but holds no authority of
its own.

## Current Trust Boundary

- Teami is local-first and zero-hosted. There is no hosted inbox, hosted
  credential custody, GitHub App, token broker, cloud synchronization, or
  maintainer-operated adopter path.
- Linear authority is the adopter's browser-approved OAuth grant. Ordinary
  operation uses workspace-wide read/write access because Linear offers no
  narrower useful app scope.
- If `Principal Escalation` is missing, setup may ask separately for a one-time
  admin grant used only to create that status. The grant is held in memory,
  discarded after the attempt, best-effort revoked, never persisted, and never
  used by ordinary operation.
- GitHub effects use the adopter's ambient local git/`gh` authority. Teami does
  not store a GitHub secret or silently broaden repository access.
- Teami state, wake/run coordination, and Phoenix evidence remain on the
  adopter's machine unless the adopter deliberately exports something.
- The foreground gateway runs only when the adopter starts it. When it is
  stopped or the machine is off, Teami performs no work and makes no external
  change. Linear remains the queue until the next local poll.

## One Setup Product

Conversational MCP setup is the primary experience. The CLI is the fallback
and operator surface. Both must call one shared setup orchestration contract and
must agree on phases, persistence, recovery, degradation, and final health.

Before any setup mutation, the surface must disclose and receive explicit
confirmation for:

1. workspace-wide Linear read/write access;
2. the possible one-time, non-retained admin grant described above;
3. the selected product-repository allowlist, including an explicit non-code
   choice;
4. behavior-repository creation or connection through ambient git/`gh`;
5. Claude plugin marketplace registration and installation; and
6. local Teami, runtime, and Phoenix state creation.

Browser approval remains the real Linear authority gate. The authorization URL
and recovery guidance must reach the user while authorization is pending. A
client that cannot surface in-flight communication must receive a resumable
state, never a silent wait or a success claim after a dead end.

Required setup phases are Linear authorization/domain setup, product-repo
allowlisting, behavior-repo setup, Claude plugin registration, Phoenix
preparation and trace preflight, runtime readiness, and final doctor
verification. `ok: true` or `setup complete` is valid only when every required
phase is healthy. An allowed non-blocking failure must be an explicit degraded
step with accurate repair guidance.

## Runtime And Workflow Truth

- Moving a Linear project to `Planned` is the human approval moment for
  decomposition.
- The local gateway polls current Linear state, records local wake state, and
  hands claimed work to the local runner. It does not imply a background
  service or machine-off behavior.
- Linear writes occur only after domain resolution, eligibility checks, durable
  local intent/run evidence, and the relevant deterministic gates.
- Project-body and Planned-status mutations must resolve to exactly one Teami
  domain/team. Foreign-team and ambiguous multi-team targets fail closed before
  mutation. A wake cannot run while its domain is unresolved, including when a
  project spans teams belonging to two active domains.
- Behavior-repo process-change proposals remain human-reviewed.

Product-repo write-capable execution and PR effects are not shipped. Repository
binding records scope; dormant materializer or workflow modules are not
activation. A future activation requires explicit product approval plus
credible isolation, domain confinement, bounded Git behavior, staged-content
guards, and no push after a failed safety gate.

## Custody And Recovery

- Linear credentials use OS credential storage by default. A plaintext file
  fallback is testing-only and must be explicitly selected.
- Credentials, OAuth codes, token values, private repo content, customer data,
  raw prompts, and shell output must not enter logs, traces, fixtures, PRs,
  diagnostics, or committed state.
- Git and `gh` operations must have deadlines and actionable recovery. A hung
  clone, fetch, checkout, discovery, pull, push, or config operation must not
  freeze the gateway indefinitely.
- Wake reconciliation must preserve durable uncertainty: an external-mutation
  intent cannot disappear until durable state proves reconciliation superseded
  it.
- Uninstall removes generated Teami state and the local Linear credential but
  must state what remote Linear/GitHub objects and local Phoenix history it
  preserves.

## Public Truth And Verification

Current-facing docs and generated OpenWiki must agree with this record.
Historical designs may remain only with the machine-checkable header
`Status: superseded` and `Current product path: no`, and they must not be linked
as current guidance.

The deterministic suite remains credential-free. Real Claude CLI, disposable
Linear setup, real MCP timing/in-flight communication, and relevant GraphQL
shape/status/comment contracts run as separate, independently gated canaries.
No deterministic mock may be presented as proof of an external contract.
