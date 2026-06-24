# Agentic Factory

Self-improving control plane for agents.

Agentic Factory turns product intent in Linear into agent-ready execution work,
reviewable process improvements, and local eval evidence. It is for founders,
product and engineering leaders, and agent teams evaluating how agent workflows
can coordinate Linear, GitHub, local runners, and Phoenix without making the
human become the technical coordinator.

Current status: source-visible portfolio preview and command-driven technical
preview. Implemented behavior includes Linear OAuth setup, GraphQL-backed
workspace provisioning, planned-project webhook wake-ups, local runner
decomposition, local Phoenix traces/evals, the behavior-repo GitHub proposal
path, deterministic tests, and local domain `git_repo` binding for one existing
checkout per domain.

Primary trust boundary: hosted Agentic Factory services coordinate Linear
webhook wake-ups and behavior-repo GitHub token minting; the local runner holds
adopter-side Linear OAuth, product checkout paths, agent runtime execution, and
Phoenix traces. The hosted inbox never receives Linear OAuth tokens, repo
contents, Phoenix traces, or Linear write authority.

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
  `git_repo` binding seam without exposing a private checkout or claiming hosted
  code execution.

## Quickstart

Use this path for a local technical evaluation after the public hosted setup
endpoint is enabled for the artifact you are running. The checked-in public
config intentionally uses a reserved `.invalid` hosted host until launch
configuration is applied, so the portfolio demo is the runnable path before
that gate closes.

```bash
npm install
npm run init
npm run domain:bind-repo -- --domain main --path ../product-app
npm run doctor
npm run runtime-smoke
```

`npm run init` opens the Linear browser authorization flow, provisions the
Agentic Factory Linear team/template/labels/status mapping through GraphQL,
registers the hosted webhook inbox, mints a scoped runner credential, prepares
local Phoenix, and can connect the dedicated Agentic Factory behavior repo for
reviewable process-change proposals.

`domain:bind-repo` is separate. It binds one existing local product checkout to
one domain as a local `git_repo` resource. It does not grant hosted access to
the product repo and it does not use the behavior-repo GitHub broker.

To exercise the current sandbox workflow:

```bash
npm run runner
npm run trigger-status
```

If setup still fails closed on the reserved `.invalid` host, treat that as a
launch/configuration gate, not as a reason to paste private credentials into the
public setup path.

## Tests

Core deterministic checks:

```bash
npm test
npm run security:secrets
npm run edge:check
npm run edge:audit
```

Runtime and local observability checks:

```bash
npm run runtime-smoke
npm run phoenix:status
npm run preflight:phoenix
```

`npm test` is credential-free and covers the Linear workflow contracts,
resource-binding behavior, hosted inbox/broker contracts, eval helpers, and
fail-closed paths. Live Linear or hosted setup checks should use disposable
workspaces/projects and the documented cleanup path.

## Architecture

```text
Human product intent
  -> Linear project moved to Planned
  -> hosted inbox verifies webhook, dedupes it, and queues a wake-up
  -> local Workflow Runner leases the wake-up
  -> local runner re-reads Linear through OAuth + GraphQL
  -> local runner persists run evidence before any Linear mutation
  -> Linear project updates and execution issues are written after gates pass
  -> local Phoenix receives trace/eval evidence for review and improvement
```

Behavior changes use a separate GitHub path:

```text
Agentic Factory behavior repo
  <- hosted GitHub broker mints short-lived selected-repo tokens
  <- GitHub App limited to metadata, contents, and pull request permissions
  <- local proposal controller packages eval evidence for human-reviewed PRs
```

Product repo access stays local:

```text
domain.resources[]
  -> git_repo resource
  -> one existing local checkout per domain
  -> local cwd/worktree selection for domain-scoped work
```

The hosted inbox/broker coordinates wake-ups and behavior-repo proposal
transport. It is not a cloud runner, product-repo checkout service, hosted
Phoenix store, or all-repositories GitHub grant.

## Security/Permissions

- Linear setup uses browser OAuth and GraphQL. Admin scope is requested because
  Linear requires it for webhook setup; Linear writes are performed by the
  local runner after deterministic gates pass.
- The hosted inbox stores webhook signing material and runner credential hashes.
  It consumes Linear webhook bodies in memory, persists hashes/routing facts
  instead of product content, and has no Linear write path.
- The GitHub broker is scoped to the Agentic Factory behavior repo for
  proposal branches and PRs. It is distinct from product-repo binding and does
  not request all-repositories access.
- Local Phoenix is local custody. Traces, annotations, datasets, and eval
  evidence stay on the adopter machine unless the adopter chooses otherwise.
- Security reports should use GitHub private vulnerability reporting when the
  public repository enables it. Do not post credentials, tenant data, webhook
  payloads, repo contents, or local paths in public issues.

## Current Limits

- Source-visible/no reuse license: the code is public for evaluation and
  review, but no license grants copying, modification, distribution, or reuse.
- Hosted setup is best-effort public beta infrastructure, not an enterprise
  support promise.
- No public SLA, durable monitoring/audit claim, gateway/IP limit claim,
  automated sweep claim, or service-key rotation claim is made for the hosted
  service.
- No npm release is available; this repo is not a package distribution channel.
- External PRs are not supported yet. Feedback through issues is welcome after
  launch, but maintainers may apply changes privately.
- Product-repo binding supports one existing local checkout per domain.
- There is no multi-repo selector, no cloud resource kind, and no greenfield
  checkout bootstrap.
- There is no OS/container isolation boundary for local agent execution.
- Product-repo write-capable execution and PR effects are not shipped unless a
  later capability is landed, verified, and documented. Behavior-repo proposal
  PRs remain human-reviewed process-change proposals.
- Background supervisor and OS autostart are not the current launch path; use
  foreground `npm run runner` for sandbox evaluation.

## Reuse/License

Agentic Factory is source-visible for evaluation, review, and portfolio
visibility. Package metadata is `UNLICENSED` and `private: true`; there is no
reuse grant in this repository.

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
  integrations/linear/   Linear OAuth, GraphQL setup, runner, GitHub broker client
  evals/decomposition/   schemas, rubrics, datasets, judge prompts
  templates/             Linear issue, roadmap, review, and PR templates
examples/
  portfolio-demo/        synthetic walkthrough and public-safe evidence
supabase/
  functions/             hosted inbox and GitHub broker source
  migrations/            hosted queue/credential schema
```

When present, `maintainers/` contains product/process memory for maintainers.
It is not adopter-facing runtime state.
