# Resource-Binding Proof

Provenance: hand-curated from current implementation.

This is a public-safe proof packet for the local domain `git_repo` binding
behavior landed in commit `4a7d5c77ab6c32bce4f34c5864ec1f110219abfb`.

The demo remains fictional. The resource labels below are publishable example
labels, not private repo names, local paths, credentials, or source contents.

## Proof Summary

Agentic Factory now has landed, tested behavior for binding one domain to one
existing local product checkout through a `git_repo` resource. The binding is
separate from the Agentic Factory behavior-repo GitHub path used for process
change proposals.

The proof is source-and-test based. It does not require exposing a real checkout
path or running against a private product repository.

## Public-Safe Demo Packet

| Field | Public-safe value |
| --- | --- |
| Source commit | `4a7d5c77ab6c32bce4f34c5864ec1f110219abfb` |
| Demo domain label | `renewal-risk-demo` |
| Resource kind | `git_repo` |
| Resource id | `git_repo` |
| Resource role | `primary` |
| Example bound repo label | `example-org/renewal-risk-product` |
| Behavior-repo label | `example-org/agentic-factory-behavior` |
| Local checkout disclosure | Redacted; public artifacts contain no local path value. |

## Evidence From Landed Source And Tests

| Claim | Public-safe evidence |
| --- | --- |
| Setup exposes the binding command. | `package.json` includes `domain:bind-repo`, routed to the Linear CLI. |
| A domain records one product repo binding. | `domain-bind-repo.test.mjs` proves `domain:bind-repo` writes one primary `git_repo` resource and rejects a second `git_repo` without changing the registry. |
| The binding is derived from the selected local checkout, not typed into the demo. | `domain-bind-repo-command.mjs` derives owner, repo, default branch, and the local checkout path from the checkout's GitHub origin and default branch. The public proof redacts the path value. |
| Invalid binding inputs fail closed. | `domain-bind-repo.test.mjs` covers missing origin, ambiguous default branch, missing checkout directory, and unknown domain without writing a resource. |
| Resource materialization is a typed engine seam. | `resource-binding.test.mjs` proves domain resources validate and materialize through `materializeDomainResources`; `materialize.mjs` fills `runContext.resources` and `runContext.resourceManifest`. |
| Runtime work happens in a detached worktree from the bound repo. | `git-repo-materializer.test.mjs` proves `git_repo` materialization checks a clean source, creates a detached worktree, records a base commit, and keeps the worktree outside the source checkout. |
| Dirty source repos fail closed. | `git-repo-materializer.test.mjs` proves a dirty source stops before creating a worktree. |
| Failed materialization cleans up. | `git-repo-materializer.test.mjs` covers cleanup after base commit failure and worktree-add failure, plus idempotent teardown. |
| Runtime command cwd is bound to the materialized worktree. | `git-cwd-binding.test.mjs` proves a runtime command writes into the materialized worktree, not the original checkout or the engine runtime path. |
| Manifest facts are public-safe. | `git-repo-materializer.test.mjs` proves the `git_repo` manifest entry contains kind, id, role, and label, and omits base commit and live handles. |
| Resource fences scope target selection to the bound resource. | `resource-binding-fence.test.mjs` proves each run context exposes only the selected domain resource and commit effects derive targets from the bound resource record instead of agent-authored output. |

## What Is Proven

- The local binding model supports one primary `git_repo` resource per domain.
- The binding command is present and writes through the domain registry.
- The landed seam materializes the selected local checkout into a run-scoped
  detached worktree for resource-scoped work.
- Runtime commands can be bound to that materialized worktree.
- The public resource manifest can show labels without exposing local path
  values, repo contents, credentials, or live handles.
- Repo selection is scoped at the resource boundary: run contexts and commit
  effects use the selected bound resource, not an agent-requested target.

## Outside Scope

- Account-connected setup proof.
- Live local gateway handoff.
- Live Linear workspace mutation from this demo package.
- Local Phoenix trace delivery from this demo package.
- Live product-repo agent execution or product-repo commits from this demo
  package.
- Behavior-repo proposal creation, merge, or accepted process change.
- OS isolation, container isolation, cloud execution, or a multi-repo selector.
- Disclosure of real checkout paths, source contents, credentials, or private
  repository names.
