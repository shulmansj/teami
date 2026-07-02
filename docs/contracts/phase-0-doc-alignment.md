# Phase 0 Doc Alignment

Status: Distribution-pivot Phase 0C inventory
Date: 2026-06-17

This inventory aligns supporting docs with the owner-sovereign Teami
loop model recorded in
[`teami-product-trust-record.md`](teami-product-trust-record.md)
and
[`authority-custody-defaults.md`](authority-custody-defaults.md).

It does not create new product behavior. If a doc needs a decision not settled
by those contracts, the change is deferred to the owning phase instead of being
decided here.

Phase numbers in this file refer to the distribution-pivot breakdown. "Phase 8"
means the deferred public rollout and bridge-retirement gate. Public adopter
copy should prefer plain language such as "later public rollout" unless the
section is explicitly technical or maintainer-facing.

## Alignment Rules

- Teami is the adopter-facing product name; The predecessor codename remains private.
- The owner has two recurring judgment loops in this slice: move Linear work to
  `Planned`, and approve or decline behavior-change PRs.
- The behavior repo is the Teami behavior repo. Product repos are not
  selected or touched in normal v1 setup.
- Public/adopter docs may describe the current technical preview, but they must
  not claim Phase 8 public setup, raw-command-free setup, or broad Option A
  readiness.
- Hosted status is diagnostic/operator health, not a PM dashboard.
- Maintainers have no adopter support access path: no token minting, Linear
  mutation, repo writes, PR creation, behavior acceptance, or break-glass
  recovery for real external adopters.
- Broker-backed proposal writing is a maintainer sandbox bridge unless a later
  product/trust decision promotes hosted broker custody into the normal path.
- Primary adopter copy avoids Git, npm, Node, token, raw diff, Phoenix ID,
  endpoint, and broker mechanics unless the surrounding section is explicitly
  technical or operator detail.

## Audience And Owner Inventory

| Doc | Audience | Owner concept | Required change | Acceptance check | Deferred follow-up |
| --- | --- | --- | --- | --- | --- |
| `README.md` | Public evaluator and technical pilot operator | Product overview, current runnable slice, repo map | Reframe Quickstart as technical preview, remove extra-team/domain command from primary path, remove break-glass setup/support wording, and stop describing the broker as maintainer-operated default | README does not claim Phase 8/Option A setup; uses Teami behavior repo terminology; hosted/broker mechanics are technical detail only | Phase 8 public setup rewrite after guided setup, bridge retirement/replacement, runtime presence, and validation proof |
| `docs/adoption.md` | Adopting team evaluating pilot rollout | Adoption stages, pilot permissions, risk controls | Replace command-first adopter framing with technical-preview framing; remove broker-backed setup as adopter-normal; mark internal wake/dead-letter names as operator detail; tighten GitHub scope to behavior repo only | Adoption doc says pilots expand permissions only deliberately, with no product repo/all-repo path and no maintainer support access | Phase 6 validation harness and Phase 8 public rollout docs |
| `docs/self-improvement.md` | Maintainer/contributor and technical operator | Trace/eval learning loop and behavior-change PR flow | Mark behavior repo setup and broker-backed writes as target/deferred or maintainer sandbox bridge, not broad adopter-normal setup | Self-improvement doc keeps the owner approval loop, no third dashboard, and no hosted/maintainer authority drift | Phase 3 ledger, Phase 4 repair routing, Phase 7 update channel, Phase 8 rollout |
| `docs/operating-model.md` | Public evaluator and contributor | Roles, workflow, sources of truth, human checkpoints | Remove hosted dashboard as primary PM trigger-state surface; translate raw terminal failure state into owner-facing repair language | Operating model preserves Linear/GitHub/Phoenix/guided-agent surfaces and no third recurring owner loop | Phase 4 read-model and repair matrix |
| `docs/promotion-acceptance-policy.md` | Contributor and technical reviewer | Repo promotion acceptance posture | No patch required in Phase 0C; it already owns HITL-only behavior PR acceptance and future auto-accept preconditions | It does not grant auto-merge, maintainer acceptance, or Phoenix-side authority | PKT/GOV issues may refine packet fields without changing acceptance posture |
| `execution/integrations/linear/README.md` | Technical operator and implementation agent | Linear OAuth/GraphQL setup, runner behavior, hosted inbox protocol | Reframe command list as technical preview, stop claiming full adopter onboarding, remove break-glass support wording, and remove maintainer recovery from dead-letter handling | Technical detail remains available, but adopter-normal claims stay below CON-01/CON-02 and Phase 8 boundaries | Phase 6 guided setup and Phase 4 self-serve repair docs |
| `supabase/README.md` | Hosted service operator and implementation agent | Hosted inbox, broker bridge, deployment/secrets | Mark broker and break-glass paths as maintainer sandbox/operator-only; do not describe broker as steady-state external adopter credential boundary | Supabase doc cannot be read as maintainer support access, PM dashboard, or broad adopter-normal hosted broker claim | CON-03/CON-04 proof fixtures, bridge retirement/replacement decision, Phase 7 release channel |

## Deferred Decisions

- Final setup/runtime packaging and any raw-command-free public setup promise.
- Whether a permanent hosted broker becomes a named trust dependency, versus
  local/adopter-side GitHub write authority.
- Full self-serve recovery matrix and diagnostic export product copy.
- Maintainer update cadence and release-channel behavior after Phase 7 proof.
- Any product-repo connection or broader workspace/domain expansion beyond the
  owner-deliberate Teami behavior repo and initial Linear team.
