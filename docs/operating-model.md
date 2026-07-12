# Operating Model

Teami is a source-visible control plane for turning product intent
into reviewed, shipped work without making the human become the technical
coordinator.

The shell should feel like an operating system for judgment, not a dashboard of
automation buttons. Trust comes from clear handoffs, explicit state, good
defaults, and visible review points.

## Core Job

When a team has product direction, Teami helps turn that direction
into shipped, reviewed code while keeping humans focused on product decisions:
scope, user experience, trust, priority, release timing, and business risk.

## Sources Of Truth

| Domain | Source of truth |
| --- | --- |
| Roadmap item content | Linear projects inside the `Teami` team |
| Execution work | Linear issues inside the source roadmap project |
| Code state | GitHub branches, commits, pull requests, checks, and merge state |
| Process definitions | This repo: docs, templates, schemas, prompts, workflows, and eval contracts |
| Learning state | Local Phoenix-backed eval/observability store: snapshots, traces, annotations, datasets, and score history |

Do not duplicate roadmap truth into repo files after a Linear project exists.
Repo templates are starting shapes and process contracts, not parallel roadmap
instances.

## Public Trust Boundaries

Teami keeps live authority local.

There is no hosted inbox, hosted credential custody, GitHub App, token broker,
or always-on supervisor in the supported product. The adopter starts the
foreground gateway when they want Teami listening. When it is stopped or the
machine is off, Teami makes no external change; Linear remains the queue and
the next foreground poll reconciles eligible work.

The local gateway polls Linear's current state with the adopter's OAuth grant
for projects in the trigger state. Linear is the queue: moving a project to
`Planned` is the human handoff, and the gateway records local wake state,
trigger fingerprints, leases, mutation intent, suppression records, and replay
records in the adopter checkout.

The local runner owns adopter-side authority. It reads Linear through OAuth and
GraphQL, persists run evidence before mutation, writes Linear only after
deterministic gates pass, emits trace/eval evidence to local Phoenix, and runs
repo or agent commands from the adopter's machine.

The behavior-repo GitHub path uses the adopter's own git/`gh` auth for
reviewable proposal branches and pull requests for process changes. Teami
stores no GitHub secret. PR provenance is visible in local run evidence
and the PR body.

Product-repo grants are local and explicit. `teami domain grant` records
selected GitHub repo coordinates as a domain `git_repo` resource. The grant
records `owner/repo` and default branch only. Product-repo write-capable
execution is not shipped: the presence of materializer and workflow modules is
not permission to edit, commit, push, or open a product-repo PR. Any future
activation must prove credential and process isolation, domain confinement,
bounded Git behavior, staged-content guards, and no push after a failed safety
gate.

## Roles

### Human

The human owns product judgment.

Responsibilities:

- Set roadmap direction.
- Approve roadmap sequencing and priority.
- Decide user-facing scope.
- Perform user acceptance testing when needed.
- Approve release timing when there is customer or business risk.

The human should receive tradeoffs in product terms, not raw technical
preference.

### PM Agent

The PM agent turns product intent into structured work.

Responsibilities:

- Turn roadmap projects into product-ready Linear issues.
- Preserve acceptance evidence and scope boundaries.
- Identify open product questions.
- Draft release notes.
- Draft documentation patch requests.

The PM agent should not invent strategy. It can recommend, but it must flag
assumptions.

### Sr Eng Agent

The Sr Eng agent protects implementation quality and system coherence.

Responsibilities:

- Convert product issues into technical plans.
- Create technical issues when needed.
- Identify architectural risk.
- Review pull requests.
- Decide whether technical work is merge-ready.
- Explain technical tradeoffs as user, quality, speed, or risk implications.

The Sr Eng agent should not silently change product scope.

### Dev Agent

The Dev agent executes implementation work.

Responsibilities:

- Read assigned issues and source context.
- Implement scoped code changes.
- Add or update tests.
- Write technical docs near source code when useful.
- Produce a pull request draft with verification notes.

The Dev agent should stop and escalate when product intent becomes ambiguous.

### Release Role

The release role may be handled by the PM agent and Sr Eng agent together in the
MVP.

Responsibilities:

- Decide which merged pull requests belong in a release.
- Draft release notes.
- Confirm documentation patches.
- Recommend deploy timing.

Release approval belongs to the human when timing, customer communication, or
business risk matters.

## Workflow

### 1. Roadmap Creation

Owner: Human.

Input:

- Product direction.
- Customer or workflow pain.
- Priority.
- Desired outcome.

Output:

- Linear project in the `Teami` team.
- Non-empty roadmap project body. The repo template is an optional drafting
  aid, not the automation gate.

Human judgment required:

- Why this matters.
- What good looks like.
- What should not be built yet.

### 2. Product Issue Creation

Owner: PM agent.

Input:

- Linear roadmap project.
- Approved project body and existing issue context.
- Stable project snapshot.

Output:

- Linear product issue draft.
- Acceptance criteria.
- Open product questions.
- Suggested grouping or ordering.

Human judgment required when:

- The agent changes the user promise.
- Scope is ambiguous.
- The issue depends on business strategy or taste.

### 3. Sr Eng Decomposition And Technical Planning

Owner: Sr Eng agent.

Input:

- Roadmap project snapshot.
- Product issue.
- Codebase context.
- Architecture docs.

Output:

- Sr Eng decomposition artifact.
- Linear-ready issue breakdown with developer-agent guidance.
- Technical plan.
- Technical Linear issue, if needed.
- Risk notes.
- Test strategy.

Human judgment required when:

- A technical shortcut would affect user trust.
- The implementation changes intended product behavior.
- The tradeoff is speed versus quality.

Roadmap projects should not contain issue decomposition. The Sr Eng agent owns
turning mature roadmap intent into actionable issues.

### 4. Execution

Owner: Dev agent.

Input:

- Technical issue.
- Product issue.
- Relevant docs and codebase context.

Output:

- Local code changes.
- Tests.
- Technical docs near source code when useful.
- Pull request draft.

Human judgment required when:

- The implementation reveals a product ambiguity.
- The easiest implementation weakens the user experience.
- The agent discovers a larger opportunity or risk.

### 5. Review

Owner: Sr Eng agent.

Input:

- Pull request.
- Diff.
- Product issue.
- Technical issue.

Output:

- Review report.
- Requested changes or merge recommendation.
- Product-risk summary.

Human judgment required when:

- The pull request changes scope.
- The pull request has user-visible compromises.
- User acceptance testing is needed.

### 6. User Acceptance Testing

Owner: Human.

Input:

- Deployed preview or local demo.
- Product issue.
- Review summary.

Output:

- Accept.
- Request changes.
- Defer.

Human judgment required:

- Whether the experience feels right.
- Whether the issue solves the intended problem.
- Whether the release should ship now.

### 7. Release

Owner: PM agent and Sr Eng agent.

Input:

- Merged pull requests.
- Release scope.
- Product issue history.

Output:

- Release note draft.
- Documentation patch request.
- Merge and deploy recommendation.

Human judgment required when:

- Release timing matters.
- The release has customer communication risk.
- The release changes positioning or user expectations.

## Execution Interface Strategy

Teami has one Workflow Runner that owns Linear reads and mutations
through the GraphQL-backed Linear service.

The Workflow Runner owns the product contract: how Linear projects are selected,
when snapshots are captured, how traces are emitted, which Linear issues are
created, which exact authored prose is committed, and when humans are asked for
judgment.

Agents can query Linear issue and project context through mediated GraphQL read
methods exposed by the runtime adapter. They do not receive raw tokens and do
not mutate Linear directly. Linear writes happen when the Workflow Runner
commits a validated terminal orchestrator output or a persisted artifact.

The trigger is intentionally boring: when a human finishes documenting scope
and moves a project to the configured `Planned` status, the local gateway sees
that current Linear state on its next poll and creates a local workflow wake-up.
The gateway does not decide whether the project is good, summarize the project,
generate prose, or mutate Linear.

The Workflow Runner claims a wake-up before any mutation-capable decomposition
run. It re-reads Linear through OAuth and GraphQL, applies deterministic gates,
persists accepted artifacts to the local run store, and only then mutates
Linear. If the runner cannot validate eligibility or commit safely, the wake-up
records a visible terminal state that product copy translates as rejected,
paused, completed, or repair-needed.
Queued wake-ups with no fresh compatible runner heartbeat are displayed as
`waiting_for_runner`; that state is derived, not stored as another state
machine.

The local gateway has a narrower authority boundary than the runner. It records
poll observations and wake lifecycle state, while Linear writes remain inside
the Workflow Runner after eligibility and durability gates pass. Owner-facing
state should return through Linear, GitHub PRs, Phoenix evidence, and guided
agent or doctor summaries when those surfaces are available.

## State Model

Linear owns live work state. Agents may recommend state changes, but Linear
remains the operational state machine.

Roadmap project statuses:

| Status | Meaning |
| --- | --- |
| `Backlog` | Stub roadmap item that still needs product shaping and taste before decomposition. |
| `Planned` | Accountable human approval that the item is roadmap truth and ready for non-interactive decomposition. |
| `In Progress` | Teami has decomposed the roadmap item into execution issues. |
| `Completed` | The underlying execution work has landed. |
| `Canceled` | Accountable human closure without deployment. |

Use Linear's native project status categories instead of Teami-specific
`AF` status names. The statuses are the human-visible lifecycle state:
`Planned` is the approval boundary for decomposition, and `In Progress` is the
visible signal that decomposition has completed. Before decomposition has
created issues, the local wake state is the active-run coordination authority.
After mutation begins, local run artifacts plus Linear-visible generated issue
markers are the retry authority; another runner must not silently continue a
partial post-mutation run from a different machine.

Execution issue states should follow the adopter's normal Linear workflow until
Teami has enough real decomposition runs to justify its own issue
workflow.

For decomposition-created execution issues, Ready means the work is structured
enough to claim: the issue body contains assignment, output, and acceptance
criteria, dependency relations are native Linear relations, and the Linear
assignee is blank until a human or later dispatch workflow claims ownership.

GitHub states:

| State | Meaning |
| --- | --- |
| No Branch | Planning has not produced implementation work. |
| Branch Created | Dev agent has begun execution. |
| Draft PR | Work exists but is not review-ready. |
| Review Ready | Dev agent believes the work is complete. |
| Changes Requested | Sr Eng agent found required fixes. |
| Approved | Sr Eng agent recommends merge. |
| Merged | Code is in the target branch. |
| Deployed | Release target has been updated. |

Local execution states:

| State | Meaning |
| --- | --- |
| Idle | No agent is working on the issue. |
| Context Gathering | Agent is reading source, docs, issues, or PRs. |
| Artifact Drafting | Agent is producing a plan, issue, report, or template output. |
| Editing | Agent is changing local files. |
| Verifying | Agent is running tests, checks, or browser QA. |
| Awaiting Human | Agent needs product, taste, roadmap ordering, or release judgment. |
| Blocked | Agent cannot proceed without an external change. |
| Done | Agent finished its assigned task. |

## Transition Rules

- A product issue should not enter execution without acceptance criteria.
- A pull request should not enter review without a link back to the product
  issue.
- A user-facing pull request should not enter merge-approved state if user
  acceptance testing is required and incomplete.
- A release should not be considered complete until docs, release notes, and
  Linear state are reconciled.
- Every agent-driven Linear mutation that matters to decomposition quality
  should attempt local Phoenix tracing as described in
  [self-improvement.md](self-improvement.md). Trace delivery failure is local,
  visible, counted, and repairable; it does not change local wake/run state or
  block the user's real Linear/GitHub work.

## Human Checkpoints

Humans should be asked for:

- Product priority or roadmap sequencing.
- User-facing tradeoffs.
- Taste and experience quality.
- Release timing.
- Business risk.
- Trust or safety implications.

Humans should not be asked for:

- File names.
- Implementation library choices unless they affect product behavior.
- Mechanical refactors.
- Formatting decisions.
- Routine test commands.

## Escalation Rule

Agents should escalate when the next step would change what the user
experiences, what the product promises, or how much trust the company is asking
customers to place in the system.
