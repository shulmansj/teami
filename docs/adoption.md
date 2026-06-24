# Adoption

Do not ask an adopting company to trust full automation first.

Start in shadow mode, then move to a low-risk pilot, then expand permissions
only after the workflow proves that it improves clarity and reduces coordination
load.

Shadow mode and dry-run are rollout tools, not the intended steady-state product
UX. In the real roadmap decomposition workflow, the human approval moment is
moving a Linear project to `Planned`. Agentic Factory should then decompose the
project non-interactively or record a visible paused, rejected, or repair-needed
state before unsafe mutation; it should not add a routine human approval screen
for the generated decomposition.

## Phase 1: Shadow Mode

Agentic Factory observes an existing project from roadmap to release. No
generated artifact becomes official unless the team chooses to use it.

Success means the team says, "This would have saved us time or improved
clarity."

## Phase 2: Sandbox Pilot

Use a low-risk project in a disposable or internal repo.

Connect:

- Test Linear workspace or low-risk Linear project.
- Agentic Factory browser authorization through the launch-gated hosted setup
  path.
- The Agentic Factory-operated hosted inbox and broker after public endpoint,
  key, settings, and live handoff proof, with the adopter's own Linear workspace
  authorization and selected GitHub App installation context.
- A dedicated Agentic Factory behavior repo for process-change proposals.
- Local agent runtimes for PM, Sr Eng, and execution agents.
- Managed or reused local Phoenix for trace inspection and self-improvement.

Avoid:

- Production deployment automation.
- Broad organization-wide permissions.
- Background merge actions.
- API keys or adopter-created Linear OAuth apps.

The hosted setup path is launch-gated until public endpoint, key, settings, and
live handoff proof are recorded. Once enabled, it is a best-effort public beta
boundary, not an enterprise support promise. It should be used for evaluation
and controlled pilots with clear revocation and cleanup steps. The hosted inbox
and broker are operated by Agentic Factory maintainers; they are not a
maintainer support backdoor into the adopter's Linear workspace, local Phoenix,
or product repository.

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

The current runnable setup path is command-driven technical preview, not the
future raw-command-free public setup claim:

```bash
npm install
npm run init
```

The target audience remains a product-manager persona, not an infra operator,
but the current preview has not yet earned a raw-command-free setup promise. The
detailed self-improvement interaction model, including local-supervisor consent,
PM-facing status routing, machine-off limits, and no-third-eval-UI boundaries,
is owned in [self-improvement.md](self-improvement.md).

`npm run init` authorizes Linear in the browser and uses Linear GraphQL to set
up the Agentic Factory team, labels, project status mappings, project template,
hosted webhook inbox registration, generated cache, scoped runner-to-inbox
credential, managed or reused local Phoenix, and local OAuth credential. No API
key is required.
Setup can also run a GitHub connection phase for the Agentic Factory behavior
repo. It creates or verifies a dedicated behavior repo, keeps starter/template
remotes only as template state, verifies selected-repo access, and checks
whether behavior-change PR generation can work. The behavior-repo broker path is
for reviewable process-change proposals; it is distinct from product-repo
checkout binding and must not be treated as product-repo access. Bind one
existing product checkout to a domain with
`npm run domain:bind-repo -- --domain <id> --path <path>`; for example,
`npm run domain:bind-repo -- --domain main --path ../product-app`. The binding
records the product repo's local checkout path, `owner/repo`, and default
branch; local checkout paths stay on the adopter machine. `npm run github:init`
repairs only the behavior-repo GitHub phase when a prior init was interrupted.

Linear requires admin permission to create and read webhook registrations. That
permission belongs to the local setup path; the hosted inbox receives only the
webhook signing secret needed to verify deliveries and the separate runner
credential needed to lease wake-ups. It never receives Linear OAuth tokens and
does not mutate Linear.
The runner credential is scoped to one workspace and carries only the wake/run
capabilities needed to lease and complete hosted inbox work. It is not a
Phoenix credential.
The current sandbox hosted inbox is a Supabase Edge Function. Hosted-service
operator credentials are deployment detail, not adopter-facing credentials and
not maintainer support access.

Local Phoenix is managed from the adopter machine. `npm run init` installs or
reuses Phoenix on a loopback endpoint, starts it when needed, records service
metadata under `.agent-shell/phoenix-service.json`, and prints the Phoenix UI
URL. When Phoenix is available, init also emits and verifies a synthetic
preflight trace. If Phoenix setup is degraded, Linear onboarding can still
finish, but trace health is recorded locally and repair commands are printed.

A local supervisor exists behind one explicit init-time consent; OS
login/autostart registration is not yet live, so `npm run runner` remains the
required manual sandbox/operator command for claiming queued decomposition
work. It is not the target adopter UX.

Service-specific commands exist for repair, testing, and maintainer rehearsal:

- `init:linear`
- `doctor:linear`
- `uninstall:linear`
- `reset:linear`
- `domain:bind-repo`
- `phoenix:doctor`
- `phoenix:start`
- `phoenix:stop`
- `phoenix:status`
- `preflight:phoenix`
- `phoenix:annotate-trace`
- `phoenix:promote-run`

The adopter-facing cleanup command is:

```bash
npm run uninstall
```

`npm run reset` is maintainer-only clean-slate rehearsal for local onboarding
tests. It should not become the adopter exit path.

## Product-Repo Binding

Product-repo binding is local and explicit. `domain:bind-repo` binds one
existing local checkout per domain as that domain's `git_repo` resource. The
binding records the local checkout path, `owner/repo`, and default branch.

The trust boundary is narrow: product-repo binding is repo-selection scoping
for one local checkout, plus the foundation for local worktree/cwd selection in
domain-scoped work. It is not hosted code execution, OS isolation, container
isolation, behavior-repo broker access, or an all-repositories GitHub grant.
Local checkout paths and local run state stay on the adopter's machine and must
not appear in public examples, prompts, logs, traces, or export artifacts.

## Suggested Sandbox Run

Use this path to verify the current Linear slice:

1. Run `npm install`.
2. Run `npm run init`.
3. Run `npm run doctor`.
4. Run `npm run runtime-smoke` so the configured runtimes prove schema-valid
   subagent-turn output through tool-less `session_start` invocations for their
   installed versions.
5. Create one disposable Linear project in the Agentic Factory team with a
   non-empty body. The repo template at
   [../execution/templates/linear-roadmap-project-body.md](../execution/templates/linear-roadmap-project-body.md)
   is an optional drafting aid, not a validation contract.
6. Move the Linear project to `Planned` when the human owner approves
   non-interactive decomposition.
7. Start the Workflow Runner with `npm run runner` so it can heartbeat to the
   hosted inbox and claim queued wake-ups. This is the current sandbox path; the
   target adopter path is that the local supervisor, when explicitly enabled
   through init or automation upgrade, keeps the runner and scanner alive after
   login.
8. For the current sandbox, use `npm run trigger-status` as the local/operator
   view of wake state. Internal states such as `dead_letter` must be translated
   to repair-needed product copy before they reach adopter-primary surfaces.
   The target PM path is existing surfaces after the local supervisor resumes:
   Linear updates where safe, Phoenix evidence links, GitHub/PR proposal
   summaries, and agent/doctor detail on request.
9. Open the local Phoenix UI URL printed by init/status to inspect the run
   trace and phase spans.
10. Move or delete test artifacts after the check.

At this point, Agentic Factory has proven GraphQL-backed Linear setup, webhook
registration, the runner-to-inbox protocol contract, exact project update
posting, project-body Open Questions replacement, issue creation,
deterministic idempotency behavior, and fail-closed terminal handling for
unsafe partial mutation states. A deployed hosted inbox must pass a live queue
handoff smoke before claiming readiness for an adopter workspace. Local Phoenix trace
export should be verified separately on the adopter machine. It has not
proven pull request generation, dev-agent dispatch, review automation, release
automation, or hosted agent execution.

## Permission Model

Start with the narrowest useful permissions.

The Linear credential contract is owned by
[../execution/integrations/linear/README.md](../execution/integrations/linear/README.md).
This section applies that contract to pilot rollout.

Linear:

- Authorize the Agentic Factory Linear app through browser OAuth.
- Request read/write/admin scope for setup because Linear requires admin scope
  to create and read webhooks.
- Restrict workflow instructions and config to the Agentic Factory team.
- Read Agentic Factory project and issue data through the GraphQL client.
- Create and update issues, project statuses, labels, and project updates only
  through the Workflow Runner service.

GitHub:

- Create or verify a dedicated Agentic Factory behavior repo during setup. Any
  stronger one-time setup grant must be explicit, time-boxed, and revoked or
  verified absent after setup.
- Bind product repos separately per domain with `domain:bind-repo`; keep that
  separate from behavior-repo setup, do not attach product repositories through
  the behavior-repo broker, and do not request all-repo access in normal v1
  setup.
- Keep steady-state automation on a selected-repo GitHub App installation.
- Read repo metadata.
- Create branches and push proposal commits.
- Open pull requests and update controller-owned PR bodies/state.
- Read open and closed pull request metadata for candidate dedupe, rejection
  memory. Future automated acceptance remains a separate product/trust decision.
- Avoid retained repository-administration authority and avoid PR comment
  permissions in MVP unless the product intentionally adds them later.

Local:

- Run in a dedicated workspace.
- Write ignored run artifacts under `.agentic-factory/`.
- Use project test commands.

Do not grant organization-wide write permissions during the first pilot.

## Supported Platform Checklist

Before claiming a platform is supported for a pilot, verify:

- The platform can run the Agentic Factory repo and complete browser OAuth.
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
| Setup admin scope feels surprising | The adopter may distrust onboarding. | Explain that Linear requires admin for webhooks and that the hosted inbox never receives the OAuth token. |
| Workflow changes are not traceable | The system cannot learn from successes or failures. | Persist run artifacts and trace links before treating a run as successful. |
| Onboarding becomes a pile of commands | The adopter loses trust before seeing value. | Keep one top-level init as the golden path and leave service-specific commands for repair and testing. |
| Local Phoenix is down | Self-improvement evidence is missing for a run. | Continue real work, record local trace failure receipts and health counters, and repair with Phoenix commands. |

## Adoption Pitch

Agentic Factory is not asking an adopting company to replace its workflow.

It is offering a controlled way to make the existing Linear and GitHub workflow
clearer, more consistent, and less dependent on humans translating between
product intent and engineering execution.
