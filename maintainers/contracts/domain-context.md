# Domain Context Contract

Status: frozen for Phase 1 handoff
Date: 2026-06-11

This file is the inter-phase contract for domain identity. Later phases should
read this file instead of re-reading the planning packet.

## Registry

The local registry is `.agentic-factory/domains.json`.

Schema version:

```text
agentic-factory-domain-registry/v1
```

The registry is a closed schema. Unknown keys are invalid. In particular:

- no `default_domain_id`
- no top-level or per-domain Phoenix project field
- no embedded behavior rules or policy text

Per-domain Linear cache path:

```text
.agentic-factory/domains/<domain_id>/linear.json
```

`domain_id` is minted once from the adopter-provided domain name, is path-safe
`[a-z0-9-]`, and is never re-derived from Linear Team name/key changes.

Lifecycle states:

```text
setup_incomplete | active | paused | removed
```

## DomainContext Shape

All downstream code receives a resolved and frozen `DomainContext` object. Do
not thread optional bare `domainId` parameters through workflow functions.

Exact Phase 1 shape:

```js
{
  domainId: "support-ops",
  status: "active",
  linear: {
    workspaceId: "lin_org_...",
    teamId: "team_...",
    teamKey: "AF",
    teamName: "Agentic Factory",
    webhookId: "webhook_...",
    cachePath: "C:/abs/repo/.agentic-factory/domains/support-ops/linear.json"
  },
  credentialTargets: {
    linearOAuth: "AgenticFactoryLinearOAuth:<digest>",
    runnerInbox: "AgenticFactoryInboxRunner:<digest>"
  },
  trace: {
    domain_id: "support-ops",
    workspace_id: "lin_org_...",
    team_id: "team_...",
    behavior_repo_id: "local:<digest>"
  }
}
```

`linear.cachePath` is absolute for direct `readLinearCache` and
`writeLinearCache` use. The registry stores the relative path.

In Phase 1, credential target values are the current config-derived targets.
T2A.1 changes their derivation to include domain/workspace identity without
changing this object shape.

`behavior_repo_id` is a local stable id when no GitHub behavior repo id is
available:

```text
local:<sha256(repoRoot) first 16 hex chars>
```

## Resolution Ladder

Wake-shaped selectors use `resolveWakeDomainContext`. They must not use the
foreground command shortcut.

Exact selector input keys:

```js
{ workspaceId, webhookId, teamId, projectTeamIds }
```

Failure candidates have this exact shape:

```js
[{ domainId, status, teamId }]
```

Failure `reason` values:

```text
missing_workspace_id
no_active_domain_for_workspace
webhook_id_mismatch
ambiguous_webhook_id
team_id_mismatch
ambiguous_team_id
no_domain_project_team_intersection
ambiguous_domain_project_team_intersection
cross_domain_team_conflict
insufficient_wake_identity
domain_not_found
domain_not_active
no_active_domains
domain_required
```

The ladder is:

1. Require `workspaceId` and find all domains in that Linear workspace.
2. If `webhookId` is present, it must match exactly one active domain in that
   workspace.
3. Else if `teamId` is present, it must match exactly one active domain in
   that workspace.
4. Else if `projectTeamIds` are present, intersect them with active governed
   `team_id`s in that workspace. Exactly one match resolves. Zero or more than
   one match fails closed with candidates.
5. Else, workspace-only resolves only when the workspace contains exactly one
   domain of any status and that domain is `active`. If any second domain exists
   in the workspace, including `paused` or `setup_incomplete`, fail closed with
   `{ ok: false, reason, candidates }` where candidates list all workspace
   domains of any status.

Stable IDs route. Cached labels (`teamName`, `teamKey`) are display-only and
may refresh without changing `domainId` or paths.

Exclusivity guard (amended 2026-06-11 after live G3 evidence): whenever the
selector carries project `teamIds`, any resolution - including a clean webhook
match - is valid ONLY if those team ids intersect at most ONE active governed
domain. A project spanning two active domains' teams fails closed with both as
candidates (reason `cross_domain_team_conflict`) regardless of which webhook
delivered it. Rationale: Linear delivers a shared project's event through one
webhook (observed live), so webhook facts alone can look unambiguous while the
team facts prove a cross-domain governance conflict; routing it would let one
domain's run mutate another domain's surface.

Foreground commands use `resolveForegroundDomainContext`:

- with `--domain`, resolve that active domain id;
- without `--domain`, resolve implicitly only when exactly one active domain
  exists;
- with multiple active domains, return `domain_required` and list domains.

## Setup Service Signature

T1.3 extracts one shared setup function that first-domain init and future
`domain:add` call:

```js
setupLinearDomain({
  client,
  config,
  registry,
  repoRoot,
  behaviorRepoId,
  domainName,
  cache,
  writeCache,
  writeRegistry,
  registerWebhook,
  ensureRunnerCredential,
  workspace,
  onPreview
})
```

It returns:

```js
{
  ok: true,
  summary,
  cache,
  registry,
  domain,
  context,
  webhookRegistration,
  runnerCredential
}
```

The service writes a `setup_incomplete` registry entry as soon as the domain is
named and before the first external mutation. It flips the domain to `active`
only after team creation, webhook registration, runner authority, cache write,
and final registry write have all verified. Failures return or throw with
`setup_incomplete_cause` set to one of:

```text
linear_team_create_restricted
linear_team_limit_reached
linear_team_create_unknown_error
linear_webhook_registration_failed
runner_authority_failed
cache_write_failed
registry_write_failed
```

Registry domain records may include `adopter_provided_name`, the exact
human-entered domain/team name used during setup. The setup flow uses it to
resume collision-suffixed `setup_incomplete` records such as `support-ops-2`
without minting a fresh suffix for the same requested name.

The service never adopts an existing Linear Team.

## Canonical Trace Attributes

Existing workflow fields stay as `workflow.name` and `workflow.version`; do not
duplicate them. Phase 1 adds these canonical domain and routing attributes:

```text
agentic_factory.behavior_repo_id
agentic_factory.domain_id
linear.workspace_id
linear.team_id
linear.project_id
resource.kind
resource.id
resource.label
github.behavior_repo_id
github.behavior_repo_label
```

Only fields with known values are emitted. `agentic_factory.domain_name` is not
a canonical trace attribute. Display names are resolved from stable IDs at
render time.

Trace receipts and run artifacts use schema v2. Every v2 receipt and artifact
must carry all three stable identity fields:

```text
domain_id
workspace_id
team_id
```

Writers must source these fields from a resolved `DomainContext` or an
init-seeded per-domain cache. Pre-domain legacy caches are a clean break:
foreground runners fail closed with `pre_domain_cache_requires_reinit` and a
repair path pointing to `npm run init` / `npm run reset`. No writer may invent a
fallback domain id.
