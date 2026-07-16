# Demo Architecture And Trust Boundaries

Provenance: hand-curated from current output.

This demo explains the product shape behind the renewal-risk walkthrough. It is
not account-connected setup proof and not proof that a private product
repository was used during this package build.

## Components

| Component | Demo role | Trust boundary |
| --- | --- | --- |
| Linear | Holds the roadmap project, generated execution issues, dependency relations, and project update a human would read. | Linear is the live work-state surface and trigger queue. The local gateway reads current state through the adopter's OAuth grant. |
| Local gateway | Polls Linear for projects in the trigger state, records local wake state, and leases work to a compatible local runner. | Local coordination. Trigger fingerprints, leases, replay intent, and suppression records stay in the adopter checkout. |
| Local runner | Runs on the adopter machine, re-reads Linear through OAuth and GraphQL, persists local run evidence, performs deterministic gates, and commits allowed Linear mutations. | Local authority. Credentials, local run state, and product checkout access stay on the adopter machine. |
| Local Phoenix and evals | Stores traces, annotations, datasets, experiments, scores, and process-improvement evidence for the decomposition workflow. | Local custody. Phoenix evidence is linked from proposals or summaries. |
| Behavior-repo GitHub path | The adopter-selected repository for Teami process changes, for example `example-org/teami-behavior`. | Reviewable process changes only. It uses the adopter's own git/`gh` auth and is separate from any product source repository. |
| Local team `git_repo` binding | The landed local binding behavior between one team and one existing local product checkout. | The public proof uses labels, source names, and test outcomes only. Public examples must not expose local paths, repo contents, credentials, or private repository names. |

## Flow In This Demo

1. A human documents product intent in a Linear project and moves it to the
   configured ready-for-decomposition status.
2. The local gateway polls Linear, sees the project in the trigger state, and
   records a local wake-up.
3. The local runner claims the wake-up; the gateway does not perform the
   decomposition itself.
4. The local runner reads Linear context, produces the decomposition packet,
   persists local evidence, and only then commits the allowed Linear updates.
5. The runner emits trace and eval evidence to local Phoenix when available.
6. If eval evidence suggests a process improvement, the behavior-repo path can
   carry a reviewable proposal for a human to approve.

The demo artifacts are hand-curated to show this shape. They do not prove that
steps 2 through 6 ran against a live workspace for this package.

## Resource-Binding Seam

The local team `git_repo` binding is the seam that keeps behavior-repo
proposals separate from product-repo binding. The behavior repo is where
Teami process changes are proposed. The product repo binding is where
a team points to one existing local checkout for future product work.

The landed resource-binding behavior proves:

- `team:bind-repo` records one primary `git_repo` resource for a team.
- The resource manifest exposes serializable label facts rather than checkout
  paths or live handles.
- Runtime commands can be bound to the detached worktree created from the
  selected resource.
- Commit effects derive write targets from the bound resource record, not from
  agent-authored target strings.
- Dirty sources, missing origins, ambiguous default branches, missing paths, and
  duplicate repo resources fail closed.

Live product-repo agent execution, product-repo commits, and account-connected
setup proof remain outside this demo package.
