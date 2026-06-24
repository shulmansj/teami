# Execution Artifacts

This folder defines downstream execution contracts and templates.

The primitive is a native Linear issue, not a separate local issue object.
Linear owns assignment, status, priority, estimate, project grouping, labels,
parent/sub-issue structure, and blocking relations. This repo owns the issue
body contract and the agent process that creates good issues.

## Agent-Ready Issue

An agent-ready issue gives the claiming execution agent enough context to do
the work without re-reading the full Linear project or asking the human for
routine technical coordination.

Use native Linear fields for structured state:

- Project: the Linear project that owns the product intent.
- Assignee or delegate: optional claim ownership; decomposition-created issues
  may stay unassigned until a human or later dispatch workflow claims them.
- Labels/team/workflow policy: discipline and routing, where needed.
- Parent/sub-issue links: hierarchy.
- Blocking relations: dependencies.
- Priority and estimate: Linear-native planning fields.

Use the issue description for execution context:

- Assignment
- Inputs
- Output
- Acceptance Criteria
- Non-Goals
- Escalate If

Do not duplicate product intent inside issues. The Linear project is the
product-intent source of truth, and the issue should carry only the context
needed to execute its assignment.

## Linear Project Contract

- `linear-project.md`: contract for drafting and reasoning over Linear projects
  as the product-intent source.

## Templates

- `linear-agent-ready-issue.md`: body template for Linear issues created by the
  decomposition workflow.
- `github-pr.md`: pull request template for code changes tied to a Linear issue.
- `review-report.md`: review template for evaluating completed work.

## Integrations

- `integrations/linear/`: setup, doctor, and decomposition workflow helpers for
  Linear-backed execution state.

## Dependency Rule

Dependencies should be encoded as Linear issue relations, not prose in the issue
body. Add prose only when a dependency needs explanation that cannot be captured
by the relation itself.
