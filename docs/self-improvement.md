# Self-Improvement

Self-improvement is core to Teami, not an optional analytics layer.
This document owns the product and trust contract for the learning loop. Current
implemented commands remain listed in the README and Linear integration docs.

Every important agent workflow should become an evaluable process:

```text
workflow run -> instrumentation -> evaluation -> diagnosis -> process change -> regression test
```

This applies across Linear project decomposition, issue creation,
implementation handoff quality, code review, merge/release decisions,
documentation updates, user acceptance testing routing, release notes, and
post-release reconciliation.

## Core Principle

Operational truth, process truth, and learning truth belong in different places.

```text
Linear and GitHub own live work state.
The project repo owns process definitions and curated regression assets.
The eval store owns traces, annotations, datasets, scores, and learning history.
```

Do not force Linear or GitHub to become the eval memory. They should be linked
into traces by stable IDs. Do not force the repo to store every workflow run as
committed files. It should store the process artifacts that need human review
and version control.

## Evaluation Judgment Principle

Model-as-judge evaluation and human annotation are both first-class quality
signals.

Model judges provide coverage, consistency, regression checks, and experiment
throughput. Human annotation provides product taste, local workspace judgment,
calibration, and correction when an automated judge is wrong or incomplete.

New workspaces should expect meaningful human annotation as part of normal
operation, not as a special setup phase or fallback mode. As a workspace
matures, model judges may handle more volume, but the architecture should
continue to compare human judgment, model-judge results, and deterministic check
results against a shared failure taxonomy. Human and model judges share the
quality rubric; deterministic checks attach structural failure modes and should
not be forced to express taste as if it were a deterministic fact. If Phoenix
stores deterministic check results with `annotator_kind: CODE`, treat that as a
wire format detail, not as a third peer judge in the product model.

The canonical, versioned contracts behind these signals are repo-owned under
[`execution/evals/decomposition/`](../execution/evals/decomposition/README.md):
the dataset example schema
([`example.schema.json`](../execution/evals/decomposition/example.schema.json)),
the annotation contract in its logical and Phoenix wire shapes
([`annotation.schema.json`](../execution/evals/decomposition/annotation.schema.json)),
the shared quality rubric
([`rubrics/decomposition-quality.md`](../execution/evals/decomposition/rubrics/decomposition-quality.md)),
and the failure taxonomy
([`failure-taxonomy.json`](../execution/evals/decomposition/failure-taxonomy.json)).
This doc explains how the loop works; those files own the exact field
contracts, label set, score bands, and failure-mode ids.

Do not impose first-N annotation phases or sampling quotas. Humans can annotate
when they have useful judgment to add; if they do not, the judge may still run
but its evidence quality must be labeled honestly.

Eval evidence quality is a separate label from promotion risk:

```yaml
evidence_quality: high | medium | low
promotion_risk: low_risk | high_risk
```

The controller may reason over both labels, but one must not mechanically
determine the other. Every repo proposal should briefly explain why the eval
evidence is `high`, `medium`, or `low`, and separately why the proposed change
is `low_risk` or `high_risk`.

Acceptance policy is separate from both labels. MVP repo promotions always open
reviewable PRs. Later, after the shared code-review and
acceptance system exists, adopters may configure auto-acceptance for
`low_risk`, `high_risk`, both, or neither. Future automatic merging is one
configurable route, for example automatically merging low-risk prompt changes
while leaving high-risk changes in human PR review; generated PRs with human
merge must remain supported. The canonical acceptance posture -- why the MVP
controller structurally cannot merge, the full v2 auto-acceptance invariant
list, and the Phoenix handoff entry points -- is
[promotion-acceptance-policy.md](promotion-acceptance-policy.md).

Adopter-owned work-function prompts, annotations, and accepted process behavior
are workspace-local in MVP. The shared Judge rubric, evaluator, and calibration
are maintainer-owned system behavior that ships back through accepted product
updates. Network effects, shared rubric learning, and cross-workspace promotion
are future product posture, not MVP scope.

## Interaction Surface Principle

Do not build a third eval UI.

The self-improvement loop is for product operators, not technical operators.
Operational mechanics should "just work": local services should restart,
recover, retry, dedupe, and explain degraded state without asking the user to
understand Phoenix processes, runner leases, scanner schedules, or local
listeners. What should not be hidden are product and trust decisions: whether a
change is worth accepting, whether evidence is ambiguous, whether a permission
is being granted, whether local automation is being asked to change behavior,
or whether accepted behavior will change.

Phoenix is the visual eval workspace for traces, annotations, datasets,
prompts, experiments, and evaluator results. Phoenix-native agent surfaces such
as PXI should be used when available for inspecting evidence, iterating prompts,
running experiments, and recording annotations inside Phoenix. External agent
sessions remain an operational control surface for asking questions, running
Teami workflows, summarizing failures, debugging proposals, and
drafting process changes.

All agent, judge, and evaluator prompts should be authored and evaluated as
Phoenix-native prompt versions. Phoenix owns prompt versioning, tags,
experiments, and comparison evidence. The repo owns accepted prompt
pins/snapshots and the manifest catalog that says which agent behavior targets
the self-improvement loop may propose. That catalog includes accepted prompt
targets, judge-agent prompts, and runtime/model defaults when they are declared
with explicit materializers. Promotion policy, proposal
machinery, credentials, write authority, protected maps, and maintainer-owned
gates are factory behavior, not adopter self-improvement targets.

Teami should add Phoenix-native wrappers, deep links, schemas, and
agent-callable commands rather than a competing dashboard. It should not require
the user to switch from Phoenix to an external agent session just to trigger the
obvious promotion path after explicit candidate intent exists. Routine promotion
proposals should come from a deterministic scanner that detects intent signals,
such as Phoenix prompt-version candidate tags, managed `promotion_candidate`
receipts, repo-owned candidate artifacts, or authenticated registrations. The
scanner packages evidence and provenance; the promotion controller judges
evidence quality, promotion risk, and whether to draft a repo proposal. Humans
can direct experimentation before that point and review the proposed repo change
before it affects accepted behavior. Linear remains the live work-state surface,
and the repo remains the reviewable process-change record.

This requires a clear local process boundary. Phoenix can be restarted
opportunistically because Teami commands already probe and start the loopback
service when needed. The Workflow Runner does live Linear work only while the
local gateway is running, and self-improvement scanner/proposal commands run
when the adopter or agent invokes them. The product promise is explicit local
operation, not a hidden login service.

No hosted inbox, GitHub App, token broker, or retained administrator grant sits
behind this loop. Behavior-repo effects use the adopter's ambient local
git/`gh` authority, and Linear uses the adopter-approved local OAuth grant.

This is local-machine automation: it can recover and reconcile while the
explicitly started local listener runs, but it should not imply machine-off writes or
out-of-band notifications. While the machine is off, nothing local can notify
the user and nothing should update Linear. Linear still holds projects in the
trigger state, and the gateway reconciles them on the next local poll.

Local Phoenix is also local custody. If the adopter loses local Phoenix state,
the loop may lose human annotations, calibration examples, and test-split
exposure history. MVP should disclose that boundary and fail closed or lower
evidence quality until the workspace is re-annotated; backup/export/sync is
future scope, not an implicit promise.

No third eval UI also means no new PM dashboard or native desktop notification
channel in MVP. Use existing surfaces instead: Phoenix for eval evidence,
Linear for live work state once the foreground runner is available to write,
GitHub/PRs for repo proposals, and agent sessions or doctor commands for
on-demand repair detail. Local status commands remain operator surfaces unless
a later product decision deliberately adds a separate status UI.

The agent-session worklist should have one broad user-facing entrypoint:
"What needs my judgment?" It can use specialized internal queries for
annotations, disagreements, weak-evidence evals, promotion proposals, blocked
work, and repair details, but the user should not need to know those queue
names before asking.

Attention routing and exact status language are deferred until the first
"What needs my judgment?" worklist exists. Until then, use the following as
provisional routing vocabulary, not settled product copy:

| PM state | Landing surface | Source of truth |
| --- | --- | --- |
| Working | Linear project, Phoenix trace, or run summary | Local trigger/run state plus local runner receipts |
| Needs your decision | Phoenix annotation view, setup/reauth flow, PR evidence summary, or Linear project update | Phoenix annotations, local credentials, repo proposal, or Linear state |
| Blocked but safe | Linear project update when safe, agent/doctor detail on request, or PR body/status update when proposal-related | Local gateway state, local health, local ledger |
| Proposal ready | GitHub PR with product-readable evidence summary and Phoenix links | Repo/GitHub proposal artifact |

`Linear update when safe` means the foreground runner is online, Linear auth is
valid, the live project still matches the expected workspace/status, and the
update is idempotent and rate-limited. It does not mean machine-off writes.

The value receipt is an event in the proposal lifecycle, not a separate steady
state by default. In MVP, the PR should pre-stage the claimed target
improvement, regressions if any, and Phoenix/repo evidence links before merge.
Do not promise post-merge Linear or status updates until a merge/acceptance
observer is explicitly scoped.

Promotion readiness is anchored in a dedicated Teami behavior repo.
Behavior-changing proposals should route through owner-reviewed PRs in that
repo. Product repos are granted separately with `teami team grant` as local
`git_repo` resources for team-scoped work; that grant set is not behavior-repo
proposal authority and does not give proposal workflows product-repo access. If
the starter checkout already has an upstream/template remote, setup may preserve
that remote only as template state.

Target ongoing controller access is selected-repo access to the Teami
behavior repo, scoped to metadata, proposal branches/commits, PR creation/body
updates, and open/closed PR metadata for dedupe and rejection memory. If setup
cannot verify the behavior repo or selected-repo access, behavior-change PR
generation is blocked for repair rather than falling back to product-repo,
all-repo, or maintainer-operated access.

Repo creation is an init-only setup capability, not a standing runtime
permission. It may require the user's existing `gh` session to have repo
creation or administration capability during setup. Proposal writing uses the
adopter's local git/`gh` auth against the configured behavior repo, and Teami
stores no GitHub secret. It is not a normal product-repo access path or
all-repositories grant.

The controller should open regular PRs only after evidence is packaged and the
proposal is ready for human review. If the proposal is not review-ready, keep it
in controller/agent status instead of creating a GitHub PR. The no-merge promise
is enforced by Teami policy and GitHub client tests, not by GitHub
permissions alone, because the contents permission needed for proposal commits
can also be sufficient to merge a PR.

For MVP, the self-improvement loop stops at a reviewable repo proposal. The
system may detect explicit candidate intent, package evidence, label evidence
quality, classify risk, draft the repo change, pin Phoenix evidence, and open a
PR, but it must not merge, apply, or otherwise make the change live. A human owns
that final step until Teami has a general code-review and acceptance
system for all agent-authored repo changes. This is still a self-improving loop at MVP
maturity: it removes the clerical work from evidence-to-proposal. Later
maturity can close the final proposal-to-merge step for adopter-configured risk
classes through the shared review system, not a special promotion-only path.

Human-triggered prompt experiments enter the acceptance flow through the tested
prompt version, not by labeling the experiment itself. A managed Teami
experiment records whether the candidate is `promotion_candidate` or
`exploratory` and includes the target artifact, baseline, candidate, dataset,
evaluator, policy, actor, and Phoenix experiment identifiers needed for evidence
packaging. A Phoenix-native prompt version can be marked with a custom
Phoenix-valid candidate tag, such as `teami_promotion_candidate`,
when the user wants it considered for repo promotion. Phoenix-native
experiments without that prompt candidate tag are evidence only. Use one
promotion-candidate tag per Phoenix prompt; moving the tag supersedes the prior
candidate for that prompt target. Other non-prompt changes, such as schemas,
code evaluators, or phase behavior, are not inferred from policy fields or ad
hoc target strings. They can enter the self-improvement loop only after
maintainers model them as first-class manifest agent-behavior artifacts with
explicit materializers. Phoenix can hold their evidence, but the scanner/drafter
candidate universe comes from the manifest catalog.

## Storage Responsibilities

### Project Repo

The repo owns artifacts that must be reviewable, portable, and versioned with
the product's operating model:

- Workflow specs.
- Agent role contracts.
- Accepted prompt pins/snapshots and instruction contracts.
- Linear/GitHub setup contracts.
- Evaluator code and rubrics.
- Curated regression datasets.
- Failure taxonomy.
- Thresholds and CI gates.
- Accepted process-change proposals.

### Linear

Linear owns live execution state:

- Teams.
- Projects.
- Issues.
- Issue status.
- Assignment and delegated agents.
- Blockers and related issue relations.
- Estimates, priority, labels, and project grouping.
- Project updates for visible generated run-level narrative.

Linear should not own self-improvement memory. Store Linear IDs in traces and
annotations so evaluation can connect quality signals back to operational work.

### Local Run Store

Accepted turn packets, terminal orchestrator output, and final commit or pause
artifacts are persisted under `.teami/runs/<run_id>.json` before
Linear mutation. That ignored local store is the retry authority for a commit
attempt. It is not a durable eval backend and should not be committed.

### Local Phoenix Trace And Eval Store

Local Phoenix on the adopter machine is the supported Teami trace and
self-improvement path for this MVP. Local trigger/run state remains the
mutation-coordination store for Linear polling, wake leases, mutation intent,
and terminal wake state; it does not receive trace payloads and does not store
trace status.

The runner exports existing Teami `trace.mjs` spans to local Phoenix.
It first tries Phoenix's OTLP HTTP trace endpoint and falls back to Phoenix's
REST spans endpoint when the local Phoenix version rejects OTLP JSON. `teami
init` installs or reuses Phoenix, starts a managed loopback service when needed,
runs a synthetic trace preflight, and prints the Phoenix UI URL. If Phoenix is
unavailable, the runner records a local trace status and continues real
Linear/GitHub work.

Phoenix should not be treated as a daemon the user must babysit. Trace,
annotation, dataset, experiment, and promotion commands should call the same
local readiness path and either reuse a running loopback Phoenix or start the
managed service. Phoenix remains a lazy dependency of those actions.

Phoenix owns high-volume or time-series learning data:

- Workflow run traces.
- Spans for agent steps, tool calls, GraphQL calls, and review steps.
- Captured run inputs and outputs only when local content policy accepts them.
- Model/tool usage and cost.
- Human feedback.
- Automated eval annotations.
- Promoted dataset examples.
- Experiments and experiment runs.
- Score history over time.
- Prompt versions, evaluator prompt versions, and prompt-version tags used
  during a run or candidate experiment.

Use native Phoenix learning surfaces before adding Teami storage.
`npm run phoenix:annotate-trace -- <trace_id> <label> [score] [explanation]`
records a Phoenix trace annotation. `npm run phoenix:promote-run -- <run_id> [dataset_name]`
promotes a bounded local trace receipt into a Phoenix dataset example for later
experiments.

The local run store remains retry evidence only. Local trace receipts are
bounded support projections of run identity, local trace status, Phoenix URL,
repair guidance, and provider IDs; they must not contain full prompts, phase
packets, repo snippets, shell output, or source context by default.

Trace failure state lives under ignored local state:

```text
.agent-shell/telemetry/trace-health.json
.agent-shell/telemetry/runs/<run_id>.json
.agent-shell/telemetry/phoenix-outbox.jsonl
```

The JSONL outbox is audit-only failure evidence. It is not a replay queue
and should not be described as queued or replayable unless a future design can
preserve original trace IDs, span IDs, timestamps, and deduplication semantics.
When trace delivery fails, the failed run's full span payload is not recoverable
from the audit-only record; repair makes later runs traceable again.

Trace payloads containing token-shaped values are rejected and recorded as local
trace delivery failures rather than partially redacted and exported.

Deletion promises must include local Phoenix trace content and derived eval
artifacts or explicitly exclude them before users rely on the promise. Reset and
uninstall do not silently delete `.agent-shell/phoenix-data`.

## GraphQL Linear Integration

The supported Linear integration path is Teami OAuth plus Linear
GraphQL. Setup, reads, project updates, issue creation, issue relations, status
changes, and template updates use the same credential path. Agents can query
Linear through mediated GraphQL read methods, but Linear writes are committed by
the Workflow Runner from validated terminal output or persisted artifacts.

This matters for self-improvement because the runner can record one consistent
trace for the same decision path that mutates Linear. The product should not
spread runtime evidence across multiple Linear access mechanisms.

## Decomposition Trace Shape

Each decomposition run should emit one top-level trace named by the workflow
definition's `trace_descriptor.trace_name`.

Root trace attributes include `workspace_id`, `event_id`, `wake_id`, `run_id`,
`attempt`, `trace_id`, source provider/object IDs, runner identity, runtime
assignments, local trace status, mutation state, provider update IDs, terminal
outcome, and artifact pointer or hash. Unknown values should stay unknown; the
runner must not fake token counts, model IDs, continuation evidence, or Phoenix
delivery proof.

Current span names:

- `load_project_context`
- `eligibility_gate`
- `build_run_envelope`
- `pm_product_sufficiency_pass`
- `pm_product_sufficiency_outcome`
- `sr_eng_technical_context_discovery`
- `sr_eng_grounding_pass`
- `pm_synthesis`
- `sr_eng_blocker_check`
- `persist_run_artifact`
- `create_linear_issues_or_pause_project`
- `post_project_update`

Deprecated shared-input packet spans and live quality-eval spans should not
reappear in the live run path.

Minimum required fields:

```yaml
workflow:
  name: <definition trace_descriptor.trace_name>
  version: <workflow version>
run:
  id: <run_id>
  class: <production|test|synthetic|preflight>
source:
  linear_project_id: <id>
  linear_team_key: AF
  initial_linear_project_status: Planned
  final_linear_project_status: <started|backlog|planned|failed>
  snapshot_hash: <content hash for project meaning>
runtime:
  pm_runtime: <codex|claude>
  pm_model: <model>
  sr_eng_runtime: <codex|claude>
  sr_eng_model: <model>
artifacts:
  run_store_path: .teami/runs/<run_id>.json
  persisted_before_linear_mutation: true
actions:
  graphQL_reads: []
  graphQL_writes: []
outputs:
  project_update_ids: []
  project_comment_ids: []
  created_issue_ids: []
  reused_issue_ids: []
eval:
  annotations: []
  failure_tags: []
```

## Offline Evaluators

`quality` is an offline scorer over trace and resulting Linear
state. It is not a live decomposition span and it is not a mutation gate.

`accepted_packet_sufficiency` is an offline check that accepted turn packets or
terminal output contain enough serialized context for audit and commit retry. It
is not a fallback mechanism and should not excuse missing accepted-turn or
terminal-output context.

Deterministic check results follow the shared annotation contract in
[`annotation.schema.json`](../execution/evals/decomposition/annotation.schema.json).
A non-empty `identifier` is required (Phoenix upserts by name, target, and
identifier), and emissions record the failure-taxonomy version they were
checked against. Example deterministic check result:

```yaml
name: quality
annotator_kind: CODE
identifier: decomposition_quality_offline_v1
label: needs_revision
score: 0.62
explanation: Issues were executable but one dependency was described in prose
  instead of encoded as a Linear blocking relation.
metadata:
  failure_modes:
    - prose_dependency_instead_of_relation
  failure_taxonomy_version: 1.0.0
```

## Dataset And Experiment Shape

Curated regression data should live in the repo, then be uploaded or run through
the eval store.

Example dataset shape:

```yaml
dataset_name: roadmap_decomposition
description: Regression cases for turning Linear projects into agent-ready
  issues.
evaluators:
  - preserves_project_boundaries
  - issues_are_executable
  - dependencies_are_structured
examples:
  - id: marketing-non-code-roadmap
    splits: [regression]
    input:
      source_type: linear_project
      linear_project_snapshot: fixtures/linear-project-snapshots/marketing-non-code.json
    expected:
      linear:
        requires_project: true
        dependencies_as_relations: true
      issue_quality:
        acceptance_criteria_required: true
        project_content_not_duplicated: true
    metadata:
      category: non_engineering
      difficulty: moderate
```

An experiment compares a candidate process change against one or more datasets.
It should record:

- Process version.
- Prompt or role-contract version.
- Local agent runtime and model identity when the runtime exposes it.
- Dataset version.
- Evaluator versions.
- Score summary.
- Regressions.
- Train/test result counts, including how many train and test examples have
  human labels.
- Links to traces.

Use `train` for examples used during normal iteration and prompt tuning. Use
`test` for held-out examples reserved to check whether the candidate generalizes.
Human-labeled test counts are not a hard quota in MVP; they are evidence-quality
context. If `test_human_labeled_examples` is low or zero, the proposal should
say so because the evidence is more dependent on model-judge judgment and less
anchored to local human taste.

First-class Phoenix experiments require a non-mutating eval-mode entrypoint.
The runner exposes that extraction point so candidate phase output can be
produced from captured or synthetic project input without claiming a local wake
or mutating Linear. Until experiment wrappers are complete, annotation and
dataset promotion are the first self-improvement actions to make first-class.

## Failure Taxonomy

Use consistent failure tags so repeated problems can be aggregated.

The canonical, versioned taxonomy is repo-owned at
[`execution/evals/decomposition/failure-taxonomy.json`](../execution/evals/decomposition/failure-taxonomy.json).
It currently covers judgment failure modes for the `roadmap_decomposition`,
`code_review`, and `documentation` workflows, plus a `structural` section that
mirrors exactly the modes the deterministic CODE evaluators emit
(parameterized diagnostics such as `missing_context_digest:<phase>` normalize
to their base taxonomy id, with the phase detail kept in annotation metadata).
Expand it only when real traces reveal recurring gaps; adding or changing
failure modes bumps `failure_taxonomy_version` and is a process change.

## Process Change Loop

When a workflow scores poorly:

1. Inspect failed traces and annotations.
2. Identify failure modes.
3. Decide whether the cause is workflow spec, prompt, template, evaluator, or
   source-input quality.
4. Draft a process-change proposal.
5. Add or promote at least one regression example when the failure is reusable.
6. Run experiments against the relevant datasets.
7. Let the deterministic candidate-intent scanner ask the promotion controller
   to create a proposal when explicit candidate intent exists and required
   evidence/provenance can be packaged.
8. Open a product-readable PR or PR with the evidence needed for
   a human to decide whether the change should become live, including separate
   `evidence_quality` and `promotion_risk` explanations.
9. Keep merge/apply human-owned until the shared code-review and acceptance
   system exists.

This loop should be visible and reviewable. A process change is a product
change.

## Onboarding Metrics

Teami should measure onboarding as product quality once the workflow
has stable commands.

Initial metrics:

- Time To Workspace: install to verified `Teami` Linear team, statuses,
  labels, and project template.
- Time To First Roadmap Project: verified workspace setup to first disposable
  Linear project with a non-empty body.
- Time To First GraphQL-Created Issue: Teami OAuth authorization to
  first issue created from a Linear project with a captured trace summary.

These metrics are not fully instrumented in the current Linear setup slice.
Name them now so future trace and eval work measures the moments that actually
affect adopter trust.
