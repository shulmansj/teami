# Teami

Self-improving control plane for agents.

Teami turns product intent in Linear into agent-ready execution work,
reviewable process improvements, and local eval evidence. It is for founders,
product and engineering leaders, and agent teams evaluating how agent workflows
can coordinate Linear, GitHub, local runners, and Phoenix without making the
human become the technical coordinator.

Current status: source-visible portfolio preview and command-driven technical
preview. Implemented behavior includes Linear OAuth setup, GraphQL-backed
workspace provisioning, local gateway polling for planned projects, local
runner decomposition, local Phoenix traces/evals, the behavior-repo GitHub
proposal path through the adopter's own git/`gh` auth, deterministic tests, and
local domain `git_repo` binding for one existing checkout per domain.

Primary trust boundary: live paths run from the adopter's checkout. The local
gateway polls Linear with the adopter's OAuth grant, records local wake state,
and hands work to the local runner. Behavior-repo proposal writes use the
adopter's ambient git/`gh` auth. Teami stores no GitHub secret; run
evidence and PR bodies carry provenance for review.

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
  `git_repo` binding seam without exposing a private checkout or claiming cloud
  code execution.

## Quickstart

Use this path for a technical evaluation. Use disposable evaluation Linear and
GitHub resources for a first run; setup creates or reuses Linear workspace
objects and connects a dedicated Teami behavior repo using your local
git/`gh` auth. The live external authorities are your Linear OAuth grant and
your own GitHub session.

Two commands:

```bash
npm install
./teami init
```

`teami` is a repo-local launcher (no global install). Run it per shell from
the repo directory:

- macOS/Linux: `./teami <command>`
- Windows cmd.exe: `teami <command>`
- Windows PowerShell: `.\teami.cmd <command>`

(The `npm run <script>` forms still work as a fallback.)

`teami init` opens the Linear browser authorization flow, provisions the
Teami Linear team/template/labels/status mapping through GraphQL,
prepares local gateway state and local Phoenix, and connects the dedicated
Teami behavior repo through your local git/`gh` auth. It then runs a
runtime check and a final health gate and ends on a green summary — no separate
`doctor` or `runtime-smoke` step. It is idempotent and resumable: re-run it to
repair.

Then open your factory for business:

```bash
./teami gateway start
```

`teami gateway start` polls Linear and runs a decomposition whenever you move
a project to `Planned`. It runs until you press Ctrl-C, so keep the terminal
open while you want the factory listening. Check state any time with
`teami gateway status`.

### The companion

After setup you don't need to memorize commands. Open a claude or codex session
in the factory folder and say hi — the committed `AGENTS.md`/`CLAUDE.md`
companion helps you add a domain, repair a red check, start the gateway, and run
your first decomposition, invoking the deterministic commands for you. You
approve every Linear/GitHub authorization in your own browser; the companion
holds no credential.

### Repair / re-run

Every step is a standalone command, so you can repair without starting over:

- `teami doctor` — health check; it names the exact repair command for any red
  check.
- `teami init` — reconnect Linear or finish an interrupted setup
  (idempotent/resumable).
- `teami runtime-smoke` — re-verify your claude/codex runtime.
- `teami domain add --domain "<name>" --workspace "<ws>"` — connect another
  Linear workspace as a new domain.

Granting a product code repo
(`teami domain grant main --repo owner/product-app`) is separate from the
behavior-repo setup and is prep for code-scoped work; today's decomposition
workflow does not require it, and it grants Teami no new GitHub
secret.

If setup reports a Linear OAuth, local git, or `gh` authorization error, repair
that local authority directly. Do not paste private credentials into public
issues or generated artifacts.

## Tests

Core deterministic checks:

```bash
npm test
npm run security:secrets
```

Runtime and local observability checks:

```bash
./teami runtime-smoke
./teami phoenix status
./teami phoenix:preflight
```

`npm test` is credential-free and covers the Linear workflow contracts,
resource-binding behavior, local gateway contracts, eval helpers, and
fail-closed paths. Live Linear or local GitHub checks should use disposable
workspaces/projects/repositories and the documented cleanup path.

## Architecture

```text
Human product intent
  -> Linear project moved to Planned
  -> local gateway polls Linear and records a wake-up
  -> local Workflow Runner leases the local wake-up
  -> local runner re-reads Linear through OAuth + GraphQL
  -> local runner persists run evidence before any Linear mutation
  -> Linear project updates and execution issues are written after gates pass
  -> local Phoenix receives trace/eval evidence for review and improvement
```

Behavior changes use a separate GitHub path:

```text
Teami behavior repo
  <- adopter's local git/gh auth pushes proposal branches
  <- local proposal controller packages eval evidence for human-reviewed PRs
  <- run evidence and PR body record provenance for review
```

Product repo access stays local:

```text
domain.resources[]
  -> git_repo resource
  -> one selected GitHub repo identity per domain
  -> fresh per-run clone for domain-scoped work
```

The local gateway and runner coordinate wake-ups and Linear mutations from the
adopter machine. Product-repo clone authority and behavior-repo proposal access
both use the adopter's local ambient GitHub authority and stay explicit.

## Security/Permissions

- Linear setup uses browser OAuth and GraphQL. The checked-in OAuth scope is
  read/write; Linear writes are performed by the local runner after
  deterministic gates pass.
- The local gateway records trigger fingerprints, wake leases, mutation intent,
  suppression records, and replay records under local Teami state.
  Linear remains the live queue because the gateway polls current project
  state before starting work.
- Behavior-repo proposal writes use the adopter's own git/`gh` auth for
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
- No npm release is available; this repo is not a package distribution channel.
- External PRs are not supported yet. Feedback through issues is welcome after
  launch, but maintainers may apply changes privately.
- Product-repo binding supports one selected GitHub repo per domain.
- There is no multi-repo selector, no cloud resource kind, and no greenfield
  checkout bootstrap.
- There is no OS/container isolation boundary for local agent execution.
- Product-repo write-capable execution and PR effects are not shipped unless a
  later capability is landed, verified, and documented. Behavior-repo proposal
  PRs remain human-reviewed process-change proposals.
- Background supervisor and OS autostart are not the current launch path; use
  foreground `teami gateway start` for sandbox evaluation.

## Reuse/License

Teami is source-visible for evaluation, review, and portfolio
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
  integrations/linear/   Linear OAuth, GraphQL setup, local gateway, runner, GitHub path
  evals/decomposition/   schemas, rubrics, datasets, judge prompts
  templates/             Linear issue, roadmap, review, and PR templates
examples/
  portfolio-demo/        synthetic walkthrough and public-safe evidence
```

When present, `maintainers/` contains product/process memory for maintainers.
It is not adopter-facing runtime state.
