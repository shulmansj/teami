# Adoption

Do not ask an adopting company to trust full automation first.

Start in shadow mode, then move to a low-risk pilot, then expand permissions
only after the workflow proves that it improves clarity and reduces coordination
load.

Shadow mode and dry-run are rollout tools, not the intended steady-state product
UX. In the real roadmap decomposition workflow, the human approval moment is
moving a Linear project to `Planned`. Teami should then decompose the
project non-interactively or record a visible paused, rejected, or repair-needed
state before unsafe mutation; it should not add a routine human approval screen
for the generated decomposition.

## Phase 1: Shadow Mode

Teami observes an existing project from roadmap to release. No
generated artifact becomes official unless the team chooses to use it.

Success means the team says, "This would have saved us time or improved
clarity."

## Phase 2: Sandbox Pilot

Use a low-risk project in a disposable or internal repo.

Connect:

- Test Linear workspace or low-risk Linear project.
- Teami browser authorization through `teami init`, using the
  adopter's own Linear OAuth grant.
- Local gateway polling for projects in the trigger state; Linear is the queue.
- A dedicated Teami behavior repo for process-change proposals.
- The adopter's own git/`gh` auth for behavior-repo proposal branches and PRs.
- Local agent runtimes for PM, Sr Eng, and execution agents.
- Managed or reused local Phoenix for trace inspection and self-improvement.

Avoid:

- Production deployment automation.
- Broad organization-wide permissions.
- Background merge actions.
- API keys or adopter-created Linear OAuth apps.

The pilot boundary is local-first. The external authorities are the adopter's
Linear OAuth grant and the adopter's GitHub session. Evaluation should use
disposable or low-risk resources with clear revocation and cleanup steps.

## Phase 3: Controlled Production Pilot

Use one real project and one workflow lane.

Recommended lane:

- Linear project decomposition.
- Agent-ready Linear issue creation.
- Pull request draft generation.
- Review report.
- Release note draft.
- Local Phoenix trace and snapshot capture for each agent-driven Linear change.

Still avoid automated merge and deploy until trust is earned.

## Phase 4: Deeper Automation

Only after repeated successful loops:

- Add more trigger families beyond the first `linear.project.planned`
  decomposition wake-up.
- Auto-create GitHub branches and pull requests.
- Auto-dispatch local agents.
- Auto-open documentation patch pull requests.
- Recommend release bundles.

Merges and deploys should remain gated until the adopting company explicitly
decides otherwise.

## Current Technical Preview Shape

The current runnable setup is two commands:

```bash
npm install
./teami init
```

`teami` is a repo-local launcher (macOS/Linux `./teami <cmd>`, Windows
cmd.exe `teami <cmd>`, PowerShell `.\teami.cmd <cmd>`); the `npm run
<script>` forms remain as a fallback. `teami init` folds in the runtime check
and a final health gate and ends on a green summary, then points at `teami
gateway start`. After setup, the committed `AGENTS.md`/`CLAUDE.md` companion is
the post-setup surface: open a claude/codex session in the folder and it adds
domains, repairs red checks, and starts the gateway by running these same
deterministic commands.

The target audience is a product-manager persona, not an infra operator. The
detailed self-improvement interaction model, including local-supervisor consent,
PM-facing status routing, machine-off limits, and no-third-eval-UI boundaries,
is owned in [self-improvement.md](self-improvement.md).

`teami init` authorizes Linear in the browser and uses Linear GraphQL to set
up the Teami team, labels, project status mappings, project template,
generated cache, local gateway state, managed or reused local Phoenix, and local
OAuth credential. No API key or Linear admin scope is required.
Setup can also run a GitHub connection phase for the Teami behavior
repo. It creates or verifies a dedicated behavior repo, keeps starter/template
remotes only as template state, verifies local git/`gh` access, and checks
whether behavior-change PR generation can work. The behavior-repo path is for
reviewable process-change proposals; it is distinct from product-repo grants
and must not be treated as product-repo access. Grant product repos to a domain
with `teami domain grant <id> --repo <owner/name>`; for example,
`teami domain grant main --repo owner/product-app`. The grant records the
product repo's `owner/repo` and default branch. No local checkout path is
recorded.
`teami github:init` repairs only the behavior-repo GitHub phase when a prior
init was interrupted.

Linear setup uses the adopter's read/write OAuth grant locally through GraphQL.
The local gateway polls current project state and records local wake state
before the Workflow Runner re-reads Linear and applies mutation gates. Agentic
Factory does not store GitHub secrets; behavior-repo writes use the adopter's
existing git/`gh` authority.

Local Phoenix is managed from the adopter machine. `teami init` installs or
reuses Phoenix on a loopback endpoint, starts it when needed, records service
metadata under `.agent-shell/phoenix-service.json`, and prints the Phoenix UI
URL. When Phoenix is available, init also emits and verifies a synthetic
preflight trace. If Phoenix setup is degraded, Linear onboarding can still
finish, but trace health is recorded locally and repair commands are printed.

A local supervisor exists behind one explicit init-time consent; OS
login/autostart registration is not yet live, so `teami runner` remains the
required manual sandbox/operator command for claiming queued decomposition
work. It is not the target adopter UX.

Service-specific commands exist for repair, testing, and maintainer rehearsal:

- `init:linear`
- `doctor:linear`
- `uninstall:linear`
- `reset:linear`
- `teami domain show <id>`
- `teami domain grant <id> --repo <owner/name>`
- `teami domain revoke <id> --repo <owner/name>`
- `phoenix:doctor`
- `phoenix:start`
- `phoenix:stop`
- `phoenix:status`
- `preflight:phoenix`
- `phoenix:annotate-trace`
- `phoenix:promote-run`

The adopter-facing cleanup command is:

```bash
./teami uninstall
```

`teami reset` is maintainer-only clean-slate rehearsal for local onboarding
tests. It should not become the adopter exit path.

## Product-Repo Binding

Product-repo grants are local and explicit. `teami domain grant` adds a
GitHub repo identity to a domain as a `git_repo` resource, and `teami domain
revoke` removes it. Each grant records `owner/repo` and default branch only.

The trust boundary is narrow: product-repo binding is repo-selection scoping
for one selected GitHub repo, plus the foundation for sanitized per-run
clone/cwd selection in domain-scoped execution work. It is not OS isolation,
container isolation, behavior-repo proposal authority, or an all-repositories
GitHub grant.
Local run state stays on the adopter's machine and must not appear in public
examples, prompts, logs, traces, or export artifacts.

### Execution Clone Containment Known Limits

Execution materializes the code worker's copy as a fresh per-run shallow clone
of the selected repo's GitHub remote. The initial clone/fetch uses the
adopter's ambient local GitHub authority non-interactively. Before the worker
uses the directory, the clone has isolated `HOME`/`USERPROFILE`, an empty
global git config and template directory, `GIT_CONFIG_NOSYSTEM=1`, no remotes,
neutralized repo-local credential and hook config, `GIT_TERMINAL_PROMPT=0`, and
no askpass or SSH agent socket in the runtime environment. The engine-side git
effect is responsible for the later authenticated push/PR step.

Known limits:

- Network egress is not locked by this containment layer. The worker should not
  receive git push credentials, but this is not a firewall or container sandbox.
- The worker can still produce a large local diff inside the clone. The later
  git effect must enforce runaway-diff bounds before any push.
- If the selected GitHub remote cannot be cloned with local ambient auth,
  materialization fails before the worker starts.

## Suggested Sandbox Run

Use this path to verify the current Linear slice. Or skip the command list: open
a claude/codex session in the factory folder and the committed
`AGENTS.md`/`CLAUDE.md` companion walks you through the same steps, running the
commands for you.

1. Run `npm install`.
2. Run `./teami init` (Windows: `teami init` / `.\teami.cmd init`). It
   authorizes Linear and GitHub in your browser, folds in the runtime check and a
   final health gate, and ends on a green summary — no separate `doctor` or
   `runtime-smoke` step. Re-run it to repair; it is idempotent and resumable.
3. Create one disposable Linear project in the Teami team with a
   non-empty body. The repo template at
   [../execution/templates/linear-roadmap-project-body.md](../execution/templates/linear-roadmap-project-body.md)
   is an optional drafting aid, not a validation contract.
4. Run `./teami gateway start` so it polls Linear, creates local wake-ups, and
   runs the Workflow Runner against eligible projects. It runs until Ctrl-C; keep
   the terminal open while you want the factory listening. (Always-on autostart
   after login is a later capability.)
5. Move the Linear project to `Planned` when the human owner approves
   non-interactive decomposition. The running gateway picks it up.
6. Check progress with `./teami gateway status` (a one-pass wake/run view), and
   open the local Phoenix UI URL printed by init/status to inspect the run trace
   and phase spans. Internal states such as `dead_letter` are translated to
   repair-needed product copy before they reach adopter-primary surfaces.
7. Move or delete test artifacts after the check.

At this point, Teami has proven GraphQL-backed Linear setup, local
gateway polling, local wake lease/replay behavior, exact project update
posting, project-body Open Questions replacement, issue creation,
deterministic idempotency behavior, and fail-closed terminal handling for
unsafe partial mutation states. Local Phoenix trace export should be verified
separately on the adopter machine. It has not proven pull request generation,
dev-agent dispatch, review automation, release automation, or cloud agent
execution.

## Permission Model

Start with the narrowest useful permissions.

The Linear credential contract is owned by
[../execution/integrations/linear/README.md](../execution/integrations/linear/README.md).
This section applies that contract to pilot rollout.

Linear:

- Authorize the Teami Linear app through browser OAuth.
- Request read/write scope for setup and workflow mutations.
- Restrict workflow instructions and config to the Teami team.
- Read Teami project and issue data through the GraphQL client.
- Create and update issues, project statuses, labels, and project updates only
  through the Workflow Runner service.

GitHub:

- Create or verify a dedicated Teami behavior repo during setup using
  the adopter's local git/`gh` auth.
- Grant product repos separately per domain with `teami domain grant`; keep
  that separate from behavior-repo setup, and do not treat behavior-repo
  authority as product-repo authority.
- Keep proposal automation scoped to the configured behavior repo remote.
- Read repo metadata.
- Create branches and push proposal commits.
- Open pull requests and update controller-owned PR bodies/state.
- Read open and closed pull request metadata for candidate dedupe, rejection
  memory. Future automated acceptance remains a separate product/trust decision.
- Avoid retained repository-administration authority and avoid PR comment
  permissions in MVP unless the product intentionally adds them later.

Local:

- Run in a dedicated workspace.
- Write ignored run artifacts under `.teami/`.
- Use project test commands.

Do not grant organization-wide write permissions during the first pilot.

## Supported Platform Checklist

Before claiming a platform is supported for a pilot, verify:

- The platform can run the Teami repo and complete browser OAuth.
- The GraphQL client can read the source Linear project.
- The GraphQL client can post a project update with exact authored Markdown.
- The workflow can capture and persist the accepted run artifact before Linear
  mutation.
- The workflow can create or reuse issues by stable decomposition key.
- The workflow can fail closed without creating partial execution work.

Until those checks pass, the platform is not in the supported path.

## What To Measure

- Number of times the human is asked a technical question.
- Number of product assumptions made by agents.
- Whether review catches meaningful risk.
- Whether generated issues are clear enough for a different agent to execute.
- Whether the release notes match the actual change.
- Whether the workflow feels trustworthy enough to repeat.

## Risks To Discuss Up Front

| Risk | Product impact | Mitigation |
| --- | --- | --- |
| Agent changes scope silently | User gets a different product than intended. | Require project update traceability and review against acceptance evidence. |
| Review is too shallow | Low-quality work ships faster. | Use explicit review template and verification notes. |
| Humans are asked too many technical questions | Product owner becomes de facto engineering coordinator. | Escalation rule limits human questions to product impact. |
| Automation moves too fast | The adopting team loses trust. | Low-risk projects first; `Planned` is the explicit handoff and every trigger outcome is visible. |
| Permissions are too broad | Security and trust risk. | Narrow pilot permissions. |
| Local auth scope feels surprising | The adopter may distrust onboarding. | Explain that Linear uses read/write OAuth locally, behavior-repo writes use the adopter's own git/`gh` auth, and Teami stores no GitHub secret. |
| Workflow changes are not traceable | The system cannot learn from successes or failures. | Persist run artifacts and trace links before treating a run as successful. |
| Onboarding becomes a pile of commands | The adopter loses trust before seeing value. | Keep one top-level init as the golden path and leave service-specific commands for repair and testing. |
| Local Phoenix is down | Self-improvement evidence is missing for a run. | Continue real work, record local trace failure receipts and health counters, and repair with Phoenix commands. |

## Adoption Pitch

Teami is not asking an adopting company to replace its workflow.

It is offering a controlled way to make the existing Linear and GitHub workflow
clearer, more consistent, and less dependent on humans translating between
product intent and engineering execution.
