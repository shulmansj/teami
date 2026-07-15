# Authority And Custody Defaults

Status: current
Current product path: yes
Date: 2026-07-11

This contract defines who can authorize Teami's current local-first effects and
where resulting data may live. It refines the
[`Teami Product Trust Record`](teami-product-trust-record.md).

## Authority Defaults

| Surface | Authority | Allowed effect | Custody | Revoke or stop |
| --- | --- | --- | --- | --- |
| Linear ordinary operation | Adopter's browser-approved OAuth grant | Read the selected workspace and perform policy-bound writes in the resolved Teami domain | OS credential storage on the adopter machine | Revoke the Linear app grant and re-run setup when wanted |
| Linear status repair | Separate adopter/admin browser approval | Create the single missing `Principal Escalation` project status | In memory only; never persisted as runtime authority | Teami discards the grant after the attempt and best-effort revokes it |
| Product repositories during setup | No product-repository authority requested | Fresh setup records no product-repository access. Repair may preserve connections the adopter approved previously, but setup neither uses nor expands them. | Local domain registry | Connect or disconnect a product repository later through a separate explicit domain action |
| Product-repository grant after setup | Adopter's separate explicit domain action | Record the selected `owner/repo` and default-branch identity; this does not activate write-capable execution | Local domain registry | Remove it through the separate domain-revoke action |
| Private Teami workspace repository | Adopter's ambient local git/`gh` session | Create or reconnect the private repository Teami uses for configuration and reviewable improvement proposals | Git credential custody remains outside Teami | Revoke or repair local git/`gh` access |
| Claude plugin | Adopter's explicit setup confirmation | Register/update the Teami marketplace and install the Teami plugin in user scope | Claude's local plugin configuration | Claude plugin uninstall/marketplace removal |
| Gateway and runner | Adopter starts the foreground command | Poll Linear, record/claim local wakes, and apply gated domain-confined Linear effects | Local Teami state | Stop the command |
| Phoenix | Adopter's local Teami process | Store local trace/eval evidence and health receipts | Local Phoenix and Teami state | Stop/delete only through an explicit local cleanup path |

Teami has no hosted inbox, GitHub App, token broker, always-on supervisor,
maintainer-operated adopter authority, or hidden machine-off execution path.

## Setup Consent

The MCP and CLI renderers may phrase progress differently, but both must use one
setup contract. Before the first mutation they must disclose the complete
effect set in plain language and require explicit confirmation. Consent must
not be inferred from merely supplying a domain name, repo name, or workspace.

The disclosure must say:

- workspace-wide Linear read/write covers the entire selected workspace;
- the admin exception is possible, one-purpose, one-time, and non-retained;
- product repositories remain disconnected during setup; repair may preserve
  previously approved connections, but setup neither uses nor expands them;
- the private Teami workspace repository uses the adopter's existing local
  GitHub authority and is not product-repository access;
- Claude plugin configuration will change; and
- local Teami, runtime, and Phoenix state will be created or updated.

The browser is the human authority gate for Linear. Setup must surface its URL
and useful recovery while waiting. An agent conducts the flow but cannot
approve it, capture credentials, or substitute narration for consent.

## Domain And Mutation Boundary

Every planning write binds the target object to a resolved active domain:

1. resolve the requested or sole active domain;
2. read the live Linear object before mutation;
3. prove its team membership is confined to that domain's configured team;
4. reject foreign-team, missing-team, and ambiguous multi-team targets; and
5. mutate only after the proof succeeds.

A target spanning teams from two active domains fails closed regardless of
which trigger produced the wake. No wake may run while domain identity is
unresolved: exactly one active domain and live team membership must be proven
before any external mutation.

A rejected target performs no GraphQL mutation and returns a product-readable
repair or selection request. Cached IDs or a caller-supplied project ID are not
domain proof.

## Credential And Content Custody

Never capture or persist:

- OAuth authorization codes, access tokens, refresh tokens, PKCE verifiers, or
  browser callback query values;
- GitHub credentials, session material, private keys, or repository secrets;
- model-provider credentials;
- customer/private repository content in fixtures, traces, errors, PR bodies,
  or review artifacts; or
- `.env` contents, raw prompts, or unredacted shell output.

Linear runtime credentials use OS credential storage by default. An explicit
file fallback is testing-only. The one-shot admin grant is memory-only. Local
wake/run records contain coordination facts and bounded evidence, never
credentials.

Local Phoenix is adopter custody. Teami does not automatically synchronize it
or make it support-accessible. Export or sharing is a separate adopter action.

## Git And Process Boundary

Supported Git and `gh` operations require finite deadlines, bounded output, and
actionable failure states. A stuck child process must be terminated with its
process tree where the platform requires it. The gateway must remain able to
report status and recover unrelated leases after a Git failure.

Product-repo write-capable execution stays fail-closed and unshipped. Before
any activation, enforceable evidence must cover runtime-credential containment,
agent/tool environment isolation, OS/process isolation, bounded and recoverable
Git effects, domain confinement, a staged secret/content scanner, and no push
after a safety failure. A scanner alone is defense in depth, not proof of
isolation.

## Teami Workspace-Repository Proposal Authority

Process-change proposals use only the configured private Teami workspace repository and the
adopter's ambient local git/`gh` authority. Pushes are confined to
`refs/heads/teami/promotion/*`; default branches, protected branches, tags,
workflow refs, arbitrary refs, and any repo other than the configured Teami workspace
repo are rejected. Staged content must pass the protected-path and packet
guards before push, and a failed safety gate means no push.

Every agent-authored proposal branch is untrusted. Its CI runs with no secrets,
no write token, no privileged workflow trigger, no status override, and no
artifact or log exfiltration route. A candidate branch cannot approve or weaken
its own classifier, gate, credential surface, workflow authority, proposal
machinery, acceptance policy, or protected-path map.

The proposal client may inspect PR state, create a reviewable PR, and update its
body. It has no merge, apply, mark-ready, review-submission, approval, status
override, branch-protection bypass, workflow-edit, administration, or arbitrary
GitHub request path. Teami automation cannot merge or approve its own proposal.

Maintainer CI is a separate repository-maintenance surface, not adopter runtime.
The scheduled OpenWiki workflow uses no adopter credential or customer content,
may propose changes only under `openwiki/**`, and cannot merge them. Its
GitHub-hosted schedule does not mean an adopter factory keeps working while the
adopter's machine is off.

## Crash And Retention Boundary

Mutation intent remains durable until durable state proves that reconciliation
superseded it. Every persistence boundary around an external effect requires a
fault-injection test. Recovery must distinguish:

- no external mutation occurred;
- the mutation occurred and still needs reconciliation; or
- reconciliation completed and is durably recorded.

Gateway status and iteration histories must be bounded in ordinary operation.
Tests and explicit debug runs may request their own smaller bounds, but must not
silently remove production retention limits.

## Verification Boundary

Credential-free deterministic tests cover local state machines, validation,
redaction, and failure semantics. They do not prove vendor behavior. Separate
canaries cover the real Claude CLI marketplace/plugin contract, disposable
Linear OAuth/setup, real MCP in-flight communication, and GraphQL
shape/status/comment behavior. Each canary is independently gated, bounded,
sanitized, and cleaned up.
