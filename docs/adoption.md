# Adoption

Do not ask an adopting company to trust full automation first.

Start in shadow mode, then move to a low-risk pilot, then expand permissions
only after the workflow proves that it improves clarity and reduces coordination
load.

Shadow mode and dry-run are rollout tools, not the intended steady-state
product UX. In the roadmap decomposition workflow, the human approval moment is
moving a Linear project to `Planned`. Teami should then decompose the project
non-interactively or record a visible paused, rejected, or repair-needed state
before unsafe mutation; it should not add a routine human approval screen for
the generated decomposition.

## Phase 1: Shadow Mode

Teami observes an existing project from roadmap to release. No generated
artifact becomes official unless the team chooses to use it.

Success means the team says, "This would have saved us time or improved
clarity."

## Phase 2: Sandbox Pilot

Use a low-risk project with disposable or internal resources.

Connect:

- Test Linear workspace or low-risk Linear project.
- Teami plugin installation in the adopter's coding tool.
- Teami browser authorization, using the adopter's own Linear OAuth grant.
- MCP planning tools for project creation, body writing, and moving to Planned.
- Local gateway polling for projects in the trigger state; Linear is the queue.
- A private Teami workspace repository for process-change proposals.
- The adopter's own git/`gh` auth for workspace-repository proposal branches and PRs.
- Local agent runtimes for PM, Sr Eng, and execution agents.
- Local Phoenix for trace inspection and self-improvement evidence.

Avoid:

- Production deployment automation.
- Broad organization-wide permissions.
- Background merge actions.
- API keys or adopter-created Linear OAuth apps.

The pilot boundary is local-first. The external authorities are the adopter's
Linear OAuth grant and the adopter's GitHub session. Evaluation should use
disposable or low-risk resources with clear revocation and cleanup steps.
There is no hosted inbox, GitHub App, token broker, retained admin authority, or
always-running service in the supported path.

## Phase 3: Controlled Production Pilot

Use one real project and one workflow lane.

Recommended lane:

- Linear project decomposition.
- Agent-ready Linear issue creation.
- Pull request draft generation when the product-repo capability is enabled.
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

Teami is installed as a Claude Code plugin. The plugin launches Teami's stdio
MCP server with an exact `npx -y @shulmansj/teami@<version> mcp` command, and
Teami keeps local state under
the adopter's per-user Teami home.

The preview has three adopter-facing surfaces:

- Setup and repair: `init_onboarding` through MCP as the primary conversational
  path, or `npx @shulmansj/teami init` /
  `npx @shulmansj/teami doctor` through the thin CLI fallback.
- Planning: MCP tools `resolve_team`, `project_create`,
  `project_write_body`, and `project_move_status`.
- Running: `npx @shulmansj/teami gateway start` to poll Linear for
  Planned projects, and `npx @shulmansj/teami gateway status` for a
  one-pass snapshot.

`npx @shulmansj/teami init` authorizes Linear in the browser and uses
Linear GraphQL to set up
the Teami team, labels, project status mappings, project template, generated
cache, local gateway state, local Phoenix, and local OAuth credential. No API
key is required. If the Principal Escalation project status is missing, setup
asks once for Linear admin approval to create that one status, then discards the
admin token and verifies remote revocation. If revocation cannot be verified,
Teami leaves a durable repair marker and will not claim setup complete.

CLI and MCP setup share one effects disclosure, one exclusive local setup
writer, and one live-health contract. The MCP flow returns the authorization
URL before the callback completes and resumes by `setup_id`; OAuth codes, PKCE
material, and tokens are never written to setup state. Product repositories
remain disconnected during setup. Connecting one later is a separate, explicit
advanced action.

MCP and CLI setup must disclose the same complete effect set and require
explicit consent before mutation: workspace-wide Linear read/write access; the
possible one-time, non-retained admin approval; no product-repository access;
private Teami workspace-repo creation
or connection through ambient git/`gh`; Claude plugin
registration; and local Teami, runtime, and Phoenix state. A successful setup
result is valid only when the shared final health contract says every required
phase is healthy; non-blocking degradation must be named with a repair action.

Setup also runs a GitHub connection phase for the private Teami workspace
repository. It creates or verifies that dedicated repository, keeps starter/template remotes
only as template state, verifies local git/`gh` access, and checks whether
process-change PR generation can work. The workspace-repository path is for
reviewable process-change proposals; it is distinct from product-repo grants
and must not be treated as product-repo access. Grant product repos to a team
with `npx @shulmansj/teami team grant <id> --repo <owner/name>`.
The grant records the product repo's `owner/repo` and default branch. No local
checkout path is recorded, and product-repo execution is not shipped.

Linear setup uses the adopter's read/write OAuth grant locally through GraphQL.
The local gateway polls current project state and records local wake state
before the Workflow Runner re-reads Linear and applies mutation gates. Teami
does not store GitHub secrets; workspace-repository writes use the adopter's existing
git/`gh` authority.

Local Phoenix is managed from the adopter machine. Setup installs or reuses the
carried runtime/Phoenix path, starts Phoenix when needed, records service
metadata under local Teami state, and prints the Phoenix UI URL. If Phoenix is
degraded, Linear onboarding can still finish, but trace health is recorded
locally and repair commands are printed.

Service-specific package commands exist for repair, testing, and maintainer
rehearsal:

- `npx @shulmansj/teami init`
- `npx @shulmansj/teami doctor`
- `npx @shulmansj/teami team show <id>`
- `npx @shulmansj/teami team grant <id> --repo <owner/name>`
- `npx @shulmansj/teami team revoke <id> --repo <owner/name>`
- `npx @shulmansj/teami phoenix:doctor`
- `npx @shulmansj/teami phoenix:start`
- `npx @shulmansj/teami phoenix:stop`
- `npx @shulmansj/teami phoenix status`
- `npx @shulmansj/teami phoenix:preflight`
- `npx @shulmansj/teami phoenix:annotate-trace`
- `npx @shulmansj/teami phoenix:promote-run`

The adopter-facing cleanup command is
`npx @shulmansj/teami uninstall`.
`npx @shulmansj/teami reset` is maintainer-only clean-slate
rehearsal for local onboarding tests. It should not become the adopter exit
path.

## Product-Repo Binding

Product-repo grants are local and explicit.
`npx @shulmansj/teami team grant` adds a GitHub repo identity to a
team as a `git_repo` resource, and
`npx @shulmansj/teami team revoke` removes it. Each grant records
`owner/repo` and default branch only.

The trust boundary is narrow: product-repo binding is repo-selection scoping
for one selected GitHub repo, plus the foundation for sanitized per-run
clone/cwd selection in team-scoped execution work. It is not OS isolation,
container isolation, Teami workspace-repository proposal authority, or an all-repositories
GitHub grant. Local run state stays on the adopter's machine and must not
appear in public examples, prompts, logs, traces, or export artifacts.

### Execution Readiness Boundary (Not Shipped)

Product-repo write-capable execution is not shipped. The repository contains a
prototype materializer and execution workflow code, but those modules are not
a supported permission to edit, commit, push, or open product-repo PRs. Any
future activation must first prove a fresh per-run clone, bounded Git effects,
credential and tool isolation, team confinement, staged-content guards, and
no push when a safety gate fails.

Known limits:

- Network egress is not locked by the prototype containment layer. A future
  worker should not receive git push credentials, but this is not a firewall or
  container sandbox.
- A future worker could still produce a large local diff inside the clone. The
  later git effect must enforce runaway-diff bounds before any push.
- If the selected GitHub remote cannot be cloned with local ambient auth,
  future materialization must fail before the worker starts.

## Suggested Sandbox Run

Use this path to verify the current Linear slice. Or ask the companion to walk
you through it.

1. Run `npx @shulmansj/teami init`. Accept the package download if npm asks,
   review the changes, and approve Linear in the browser. Setup uses the safe
   default Linear team name `Teami` and installs the Claude Code plugin; there
   is no separate install step. If the workspace plan cannot add another team,
   choose one existing team after setup explains that it will add or reconcile
   Teami's labels and workflow statuses there. No existing team is selected
   automatically.
2. When setup says `Teami is ready`, open a new Claude Code session and run
   `/teami:plan`.
3. Shape one disposable project with the companion. When the plan is ready,
   start the local listener with `npx @shulmansj/teami gateway start`, then give
   the explicit go to move the project to Planned. The listener runs until
   Ctrl-C.
4. Ask the companion to check progress, or use
   `npx @shulmansj/teami gateway status`. Internal failure states are translated
   to repair-needed product copy before they reach adopter-primary surfaces.
5. Move or delete test artifacts after the check.

At this point, Teami has proven GraphQL-backed Linear setup, local gateway
polling, local wake lease/replay behavior, exact project update posting,
project-comment pause questions, issue creation, deterministic idempotency
behavior, and fail-closed terminal handling for unsafe partial mutation states.
Local Phoenix trace export should be verified separately on the adopter
machine.

## Permission Model

Start with the narrowest useful permissions.

Linear:

- Authorize the Teami Linear app through browser OAuth.
- Request read/write scope for setup and workflow mutations.
- Restrict workflow instructions and config to the Teami team.
- Read Teami project and issue data through the GraphQL client.
- Create and update issues, project statuses, labels, and project updates only
  through the Workflow Runner service.

GitHub:

- Create or verify a private Teami workspace repository during setup using the
  adopter's local git/`gh` auth.
- Grant product repos separately per team with
  `npx @shulmansj/teami team grant`; keep that separate from
  workspace-repository setup, and do not treat workspace-repository authority as
  product-repo authority.
- Keep proposal automation scoped to the configured Teami workspace-repository remote.
- Read repo metadata.
- Create branches and push proposal commits.
- Open pull requests and update controller-owned PR bodies/state.
- Read open and closed pull request metadata for candidate dedupe and rejection
  memory. Future automated acceptance remains a separate product/trust
  decision.
- Avoid retained repository-administration authority and avoid PR comment
  permissions in MVP unless the product intentionally adds them later.

Local:

- Keep Teami state local to the adopter's machine.
- Use project test commands.

Do not grant organization-wide write permissions during the first pilot.

## Supported Platform Checklist

Before claiming a platform is supported for a pilot, verify:

- The platform can install the Teami plugin and complete browser OAuth.
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
| Local auth scope feels surprising | The adopter may distrust onboarding. | Explain that Linear uses read/write OAuth locally, workspace-repository writes use the adopter's own git/`gh` auth, and Teami stores no GitHub secret. |
| Workflow changes are not traceable | The system cannot learn from successes or failures. | Persist run artifacts and trace links before treating a run as successful. |
| Onboarding becomes a pile of commands | The adopter loses trust before seeing value. | Keep one setup path and leave service-specific commands for repair and testing. |
| Local Phoenix is down | Self-improvement evidence is missing for a run. | Continue real work, record local trace failure receipts and health counters, and repair with Phoenix commands. |

## Adoption Pitch

Teami is not asking an adopting company to replace its workflow.

It is offering a controlled way to make the existing Linear and GitHub workflow
clearer, more consistent, and less dependent on humans translating between
product intent and engineering execution.
