# Teami

Self-improving control plane for agents.

Teami turns product intent in Linear into agent-ready execution work,
reviewable process improvements, and local eval evidence. It is for founders,
product and engineering leaders, and agent teams evaluating how agent workflows
can coordinate Linear, GitHub, local runners, and Phoenix without making the
human become the technical coordinator.

Current status: source-visible technical preview packaged for install as a
Claude Code plugin. Implemented behavior includes Linear OAuth setup,
GraphQL-backed workspace provisioning, MCP project tools, local gateway polling
for planned projects, local runner decomposition, local Phoenix traces/evals,
the Teami workspace-repository proposal path through the adopter's own git/`gh` auth,
deterministic tests, and local team `git_repo` binding.

Primary trust boundary: Teami is local-first and zero-hosted. Live paths run
from the adopter's machine; there is no hosted inbox, credential service,
GitHub App, or token broker. The plugin launches Teami's stdio MCP server
through `npx`, Teami state lives under the adopter's per-user Teami home, and
the foreground gateway polls Linear with the adopter's OAuth grant only while
the adopter is running it. Workspace-repository proposal writes use the adopter's
ambient git/`gh` auth. Teami stores no GitHub secret; run evidence and PR bodies
carry provenance for review.

- See It Work: [portfolio demo](examples/portfolio-demo/README.md)
- Run Setup: [quickstart](#quickstart)

## See It Work

Start with the portfolio demo before connecting an account:

- [Renewal Risk Triage](examples/portfolio-demo/README.md) walks through a
  fictional Linear roadmap item, the agent-ready execution issues it becomes, a
  decomposition project update, and an eval-backed process-improvement
  proposal.
- The demo is synthetic and public-safe. Its artifacts are labeled as
  illustrative, hand-curated from current output, or hand-curated from current
  implementation.
- The resource-binding evidence in the demo explains the landed local
  `git_repo` binding without exposing a private checkout or claiming cloud code
  execution.

## Quickstart

Run one command:

```bash
npx @shulmansj/teami init
```

The first `npx` run may ask permission to download the package. Setup then shows
one plain-language summary of the changes and asks whether to continue. After
you agree, it uses the safe default Linear team name `Teami` and opens Linear
in your browser for approval. If the workspace plan cannot add another team,
Teami shows the existing teams and explains the workflow changes; it configures
one only after you select it. It uses
your signed-in GitHub account to create a private Teami workspace repository;
it does not connect any product repository.

Setup installs the Claude Code plugin, prepares local traces and runtimes, and
runs its own health check. When it says `Teami is ready`, open a new Claude Code
session and run:

```text
/teami:plan
```

That is the normal onboarding path. You do not need to supply a release tag,
GitHub repository name, workspace ID, product-repository list, or a separate
doctor command. Re-run `npx @shulmansj/teami init` if setup is interrupted.

The plugin itself launches Teami's MCP server with an exact immutable
`npx -y @shulmansj/teami@<version> mcp` command. That pin is managed by Teami;
adopters do not type it.

Before changing anything, setup explains and receives explicit consent for the
complete effect set: workspace-wide Linear read/write access; a possible
one-time, non-retained admin approval used only to create Principal Escalation
when missing; no product-repository access; private Teami workspace-repository
creation or connection through ambient git/`gh` authority; Claude plugin
registration; and local Teami, runtime, and Phoenix state creation. Browser
approval remains the Linear authority gate. Teami never asks the adopter to
paste credentials.

Both setup surfaces show the same versioned effects disclosure before making
changes. Conversational setup returns `awaiting_authorization` immediately with
the live Linear URL and a `setup_id`; call `init_onboarding` again with that id
after the browser redirects. A process restart intentionally requires a fresh
URL. Setup is complete only when plugin, Phoenix, runtime, and doctor checks are
live and healthy; receipts and dry runs are never treated as health evidence.

After onboarding, Teami has three surfaces:

- Setup/repair: `init_onboarding`,
  `npx @shulmansj/teami init`, and `npx @shulmansj/teami doctor`.
- Planning: MCP tools `check_team_context`, `project_create`,
  `project_write_body`, and `project_move_status`.
- Running: `npx @shulmansj/teami gateway start` to poll Linear for Planned
  projects, with `npx @shulmansj/teami gateway status` as a
  read-only snapshot.

`check_team_context` only reads local Teami setup. Claude may ask before using
it: **Allow once** is enough for the current session; **Always allow** skips
future prompts for this specific read-only check and does not approve Teami's
project-changing tools.

Moving a project to `Planned` is the approval moment. The running gateway picks
it up on its next poll, records a local wake, and hands it to the local runner.
If the gateway is not running, the project waits safely in Planned.

### The companion

After setup you don't need to memorize command details. Open an agent session
with the Teami plugin installed and say what you want to do. The companion uses
MCP for setup and project creation/body/status work, with the thin CLI as the
fallback setup, health, and foreground-gateway surface. You approve Linear in
your browser; GitHub effects use your existing local git/`gh` session. The
companion holds no credential and cannot broaden either authority.

### Repair / re-run

Every setup step is resumable:

- `npx @shulmansj/teami doctor` - health check; it names the exact
  repair command for any red check.
- `npx @shulmansj/teami init` - reconnect Linear or finish
  interrupted setup.
- `npx @shulmansj/teami runtime-smoke` - re-verify your
  claude/codex runtime.
- `npx @shulmansj/teami team add --team "<name>" --workspace
  "<ws>"` - connect another Linear workspace as a team.

Granting a product repo
(`npx @shulmansj/teami team grant main --repo owner/product-app`)
is separate from Teami workspace-repository setup and grants Teami no new GitHub secret. It
records scope only; product-repo execution is not shipped.

If setup reports a Linear OAuth, local git, or `gh` authorization error, repair
that local authority directly. Do not paste private credentials into public
issues or generated artifacts.

## Tests

Core deterministic checks:

```bash
npm run verify
```

The full verification path runs these lanes in order:

```bash
npm run quality:static
npm test
npm run security:secrets
```

Runtime and local observability checks:

```bash
npx @shulmansj/teami runtime-smoke
npx @shulmansj/teami phoenix status
npx @shulmansj/teami phoenix:preflight
```

`npm run quality:static` parses every current JavaScript module and rejects
undeclared globals, unused values, unresolved imports, and invalid named
imports, including code outside the runtime paths exercised by tests.

`npm test` is credential-free and covers the Linear workflow contracts,
resource-binding behavior, local gateway contracts, eval helpers, and
fail-closed paths. Live Linear or local GitHub checks should use disposable
workspaces/projects/repositories and the documented cleanup path.

External contracts are separate, explicit canaries. `npm run
canary:claude-plugin` validates and installs the plugin with a disposable Claude
configuration. `npm run canary:mcp-linear-setup -- ...` drives the real MCP
stdio setup flow against an explicitly confirmed disposable Linear workspace
and a uniquely named disposable private Teami workspace repository; it requires an empty
`teami-linear-canary-*` home and never joins the credential-free suite.

The test runner never uses an inherited `TEAMI_HOME`. It gives each test-file
process a fresh disposable home and safely removes runner-owned test state when
the suite exits. A harness that needs a specific disposable parent directory
may set the absolute `TEAMI_TEST_HOME`; the runner preserves that caller-owned
directory while still isolating and cleaning each child test home.

## Architecture

```text
Human product intent
  -> Teami MCP tools create/write/prepare a Linear project
  -> project moved to Planned after explicit human go
  -> local gateway polls Linear and records a wake-up
  -> local Workflow Runner leases the local wake-up
  -> local runner re-reads Linear through OAuth + GraphQL
  -> local runner persists run evidence before any Linear mutation
  -> Linear project updates and execution issues are written after gates pass
  -> local Phoenix receives trace/eval evidence for review and improvement
```

Behavior changes use a separate GitHub path:

```text
Teami workspace repo
  <- adopter's local git/gh auth pushes proposal branches
  <- local proposal controller packages eval evidence for human-reviewed PRs
  <- run evidence and PR body record provenance for review
```

Product repo access stays local:

```text
team.resources[]
  -> git_repo resource
  -> one selected GitHub repo identity per team
  -> fresh per-run clone for team-scoped work
```

The local gateway and runner coordinate wake-ups and Linear mutations from the
adopter machine. Product-repo clone authority and workspace-repo proposal access
both use the adopter's local ambient GitHub authority and stay explicit.

## Security/Permissions

- Linear setup uses browser OAuth and GraphQL. The checked-in OAuth scope is
  read/write; if the Principal Escalation project status is missing, setup asks
  once for admin approval to create that one status and does not store the admin
  grant. Linear writes are performed by the local runner after deterministic
  gates pass.
- Teami records trigger fingerprints, wake leases, mutation intent,
  suppression records, and replay records under local Teami state. Linear
  remains the live queue because the gateway polls current project state before
  starting work.
- Teami workspace-repository proposal writes use the adopter's own git/`gh` auth for
  proposal branches and PRs. They are distinct from product-repo binding, and
  Teami stores no GitHub secret.
- Local Phoenix is local custody. Traces, annotations, datasets, and eval
  evidence stay on the adopter machine unless the adopter chooses otherwise.
- Security reports should use GitHub private vulnerability reporting when the
  public repository enables it. Do not post credentials, tenant data, Linear
  project data, repo contents, or local paths in public issues.

## Current Limits

- Source-visible/no reuse license: the code is public for evaluation and
  review, but no license grants copying, modification, distribution, or reuse.
- External PRs are not supported yet. Feedback through issues is welcome after
  launch, but maintainers may apply changes privately.
- Product-repo binding supports one selected GitHub repo per team.
- There is no multi-repo selector, no cloud resource kind, and no greenfield
  checkout bootstrap.
- There is no OS/container isolation boundary for local agent execution.
- Product-repo write-capable execution and PR effects are not shipped unless a
  later capability is landed, verified, and documented. Workspace-repository proposal
  PRs remain human-reviewed process-change proposals.
- Start `npx @shulmansj/teami gateway start` when you want the local
  factory listening.
- When that foreground command is stopped or the machine is off, Teami does no
  work and makes no external change. Eligible Linear work remains queued until
  the next local poll.

## Reuse/License

Teami is source-visible for evaluation, review, and portfolio visibility.
Package metadata is `UNLICENSED`; there is no reuse grant in this repository.

Read [SOURCE-VISIBLE.md](SOURCE-VISIBLE.md) before copying or building on the
code. Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening public feedback.

Start with the [docs map](docs/README.md) for durable operating, adoption, and
self-improvement docs.

## Repository Map

```text
docs/
  README.md
  adoption.md
  documentation-hygiene.md
  operating-model.md
  promotion-acceptance-policy.md
  self-improvement.md
execution/
  integrations/linear/   Linear OAuth, GraphQL setup, local gateway, runner, GitHub path
  evals/decomposition/   schemas, rubrics, datasets, judge prompts
  templates/             Linear issue, roadmap, review, and PR templates
examples/
  portfolio-demo/        synthetic walkthrough and public-safe evidence
```

When present, `maintainers/` contains product/process memory for maintainers.
It is not adopter-facing runtime state.
