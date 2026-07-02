# Linear Project Contract

This document defines how agents should draft and reason over Linear projects.

Linear projects own product intent. Issues are downstream execution units. The
project should be rich enough for PM/Sr Eng decomposition without forcing the
execution agent to rediscover product meaning, but it should not contain issue
splits or implementation plans.

## Native Linear Fields

Use native Linear fields for workflow state.

| Field | Meaning |
| --- | --- |
| Name | Human-readable product outcome or initiative name. Prefer the actual customer/user outcome over an internal task phrase. |
| Team | The dedicated `Teami` Linear team. Projects inside this team are eligible for product manipulation when state gates pass. |
| Status | Decomposition gate. `Planned` means eligible for decomposition; `Backlog` means not eligible; started-type status means execution work exists or is underway. |
| Labels | `Has Open Questions` means unresolved blockers prevent decomposition. Do not require a general managed-by-this-workflow label in the default path. |
| Members/lead | Accountable human or owner for product judgment and pilot validation routing. |

`Backlog` plus `Has Open Questions` means decomposition is paused because Open
Questions must be answered before the project can return to `Planned`.

Automation must use resolved Linear status IDs or native status types, not
display-name matching.

When trigger execution is connected, moving a project to `Planned` is the
automation handoff. The local gateway may only record a candidate wake-up; the
Workflow Runner must claim that wake-up, re-read the project through Linear
GraphQL, and then apply the readiness gates below before mutating Linear.

## Project Body

Use these sections in the Linear project description. The product-intent
sections are the approved intent record, not the generated decomposition audit
artifact. `Open Questions` is the workflow-owned section for current blockers.

Decomposition should read the project description, but it should not rewrite
approved product intent by default. If decomposition reveals that the body may
need to change and that change blocks decomposition, route it as a human-facing
Open Question. If it does not block decomposition, record it only as
non-blocking context in the internal agent packet or trace.

Do not create a `Recommendation` section, label, field, or artifact. Map
decomposition output to existing surfaces: `Open Questions`, `Discovery` issues,
project updates, project resources, execution issues, or internal trace.

### Problem Or Opportunity

State the customer, user, stakeholder, workflow, trust, quality, or business
problem this project addresses. Include evidence when it exists. Do not invent
evidence.

Good content answers:

- Who has the problem?
- What is painful, risky, slow, confusing, or strategically important?
- Why does it matter now?

### Desired Outcome

Describe the target future state in plain language. This is the core intent the
PM agent must preserve during decomposition.

Good content answers:

- What should be true when this project succeeds?
- What user or business behavior should change?
- What should not change?

### Acceptance Evidence

List observable evidence that proves the desired outcome exists. Evidence should
be checkable by a human, an agent, or a system.

Good content answers:

- What would convince us this worked?
- What demo, metric, review, artifact, or user behavior proves success?
- What minimum evidence is enough for initial decomposition?

### Scope Boundaries

Separate likely in-scope work from non-goals. Non-goals are hard boundaries for
agents unless the human explicitly changes them.

Good content answers:

- What belongs in this project?
- What is intentionally out of scope?
- What tempting expansion should agents avoid?

### Constraints And Decisions

Record approved product, quality, trust, operational, or technical constraints
that affect decomposition. Keep this to decisions agents must honor.

Good content answers:

- What quality bar, trust posture, or business constraint matters?
- What prior decision should not be reopened silently?
- What technical constraint changes issue boundaries or sequencing?

### Open Questions

Include unresolved blockers that prevent decomposition or execution.

When no questions are outstanding, leave this section blank. Do not write
`None.` or another placeholder.

Each question should explain:

- the question
- why it blocks decomposition
- what changes depending on the answer
- owner, if known

This is a workflow-owned section, not a new planning primitive. Decomposition
agents should not edit it directly. PM and Sr Eng return typed blockers, human
questions, discovery requests, and exact authored `open_questions_markdown`;
the Workflow Runner commits only that current blocker list into this section by
replacing the whole section verbatim. It must not derive prose from typed
blocker objects or rewrite surviving questions during resume.

The authored project update should name the pause reason and next action.
Fuller source and reasoning detail belongs in internal agent packets and trace,
not another generated Linear document.

Do not create a project-body `Discovery Findings` section in v1. Discovery
findings produced by the workflow belong on the Discovery issue and in an
agent-authored project update. If a human accepts a discovery finding as
approved product or technical context, promote it into the relevant existing
human-owned section instead of adding a generated section.

## Project Updates And Resources

Use project-adjacent Linear surfaces for generated decomposition context.

### Project Updates

Use project updates for visible run-level summaries: decomposition completed,
paused, resumed after discovery, or changed project health. A project update is
the only generated narrative artifact on the project in v1. It should name the
outcome, link to created issues or Discovery issues, and name the next action.
Completion and pause updates should include a section headed exactly
`## What I did with each part of your project` so the human can see which
project sections became issues, which parts are blocked, and which risks or
source references remain.
PM or Sr Eng authors the update body; the Workflow Runner may commit it
verbatim but must not compose, summarize, dedupe, paraphrase, or improve the
prose.

### Project Resources And External Links

Use project resources or external links for trace dashboards, eval reports,
research docs, designs, repo docs, or other source artifacts that should remain
attached to the project. Do not use resources as a second generated narrative
surface for decomposition.

### Milestones

Do not use milestones for decomposition state or decomposition artifacts.
Milestones are reserved for adopter-owned planning concepts such as release
phases, target dates, or broader delivery grouping.

## Decomposition Readiness

A project is eligible for decomposition only when all of these are true:

- project status is the configured planned-type status
- project belongs to the configured `Teami` team
- `Has Open Questions` label is absent
- no open `Discovery` issue exists in the project
- no non-discovery execution issue already exists from a prior run

If any state is missing, duplicated, ambiguous, or contradictory, fail closed.
Do not infer readiness from prose in the project body.

A paused project returns to decomposition eligibility only after every blocking
Open Question has an accepted answer recorded in the supported Linear surface,
all related Discovery issues are closed, `Has Open Questions` is removed, and
the project is moved back to the configured planned-type status.

Resume packets must include authored remaining `open_questions_markdown`. The
Workflow Runner replaces the whole `Open Questions` section with that markdown
and clears `Has Open Questions` only when the section is blank and all related
Discovery issues are closed.

## How Agents Should Reason

PM agent:

- preserve Desired Outcome and Scope Boundaries
- research approved business, user, strategy, support, and evidence sources
  linked from the project or allowed by the run envelope
- report `status: blocked` with `reason: needs_product_input` when product
  intent is too thin, contradictory, or missing business/user context needed
  for responsible decomposition; the orchestrator decides whether that becomes
  terminal `pause/product_questions`
- convert Acceptance Evidence into observable issue acceptance criteria
- surface product assumptions instead of silently resolving them
- keep issues outcome-oriented
- record material assumptions and source notes in agent packets, issue bodies,
  Open Questions, project updates, or trace depending on whether they are
  actionable or only audit context

Sr Eng agent:

- test whether the project can be split into independently executable issues
- research repo, architecture, integration, and operational context needed to
  judge executability
- research technical unknowns in-session when feasible
- identify dependency order and verification constraints
- report `status: blocked` with `reason: needs_discovery` only for technical
  evidence that cannot be responsibly obtained during decomposition
- report `status: blocked` with `reason: needs_constraint_decision` when a
  technical constraint may change product scope, trust, quality bar, or
  user-facing behavior
- give any discovery issue a stable key for the specific technical question
- record material constraints and source notes in agent packets, Discovery
  issues, project updates, or trace depending on whether they are actionable or
  only audit context

Workflow Runner:

- treat status, labels, and existing issues as deterministic gates
- create the run envelope; do not decide what business or repo context is
  semantically relevant
- validate accepted subagent turn packets using `continue/<finding>` or
  `blocked/<need>`, then assemble one terminal orchestrator output with
  `commit`, `pause`, or `failed_closed` before mutating Linear
- treat subagent turns as independent `session_start` invocations, while
  relying on accepted turn packets and terminal output for audit and Linear
  commit retry
- support per-role runtime/model configuration, including PM and Sr Eng running
  on different runtimes in the same decomposition run
- if future warm continuation is enabled, use explicit role/run session handles;
  never use "most recent session" shortcuts as an automated handoff between
  turns
- when the terminal orchestrator output returns `pause`, pause the project
  without creating partial execution work
- commit the agent-authored current blockers to the project `Open Questions`
  section when decomposition pauses
- move paused projects to `Backlog` and apply `Has Open Questions`
- post agent-authored project updates for decomposition completion, pause, and
  resume
- create issues only after the terminal orchestrator output passes structural
  quality, dependency, bounds, credential-scrub, and durability gates
- treat final issue `assignment`, `output`, and `acceptance_criteria` as issue
  body content, not Linear assignee or label selectors
- create committed execution issues in the configured Ready status when
  available, leave them unassigned, and preserve dependency relations
- pause the project instead of creating partial execution work when blockers
  remain
- find-or-create execution and discovery issues by their stable keys
- persist the accepted terminal artifact before mutating Linear and replay that
  artifact on commit retries rather than re-invoking agents
- reject packets that need a Linear project update or `Open Questions` mutation
  but omit the exact authored markdown for that surface
- claim a local wake-up before mutation-capable triggered decomposition runs
  and carry `event_id`, `wake_id`, and `run_id` through traces and run state
- treat a paused wake as terminal; a later human move back to `Planned` creates
  a fresh `linear.project.planned` wake-up
