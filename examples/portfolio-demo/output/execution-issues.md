# Execution Issues: Renewal Risk Triage Workspace

Provenance: hand-curated from current output.

This issue bundle is manually curated to match the current Agentic Factory
issue body contract. It represents the shape of a successful decomposition, not
a live Linear mutation from this demo package.

Source project: [Renewal Risk Triage Workspace](../input/linear-project.md)

## Native Linear Relations

Agentic Factory would encode these as Linear blocking relations, not only as
issue-body prose:

| Relation | Meaning |
| --- | --- |
| `RISK-1` blocks `RISK-2` | The data contract must exist before aggregation work starts. |
| `RISK-1` blocks `RISK-3` | The review UI needs the same account-summary contract. |
| `RISK-2` blocks `RISK-3` | The view depends on read-only account summaries. |
| `RISK-3` blocks `RISK-4` | Instrumentation should measure the completed review flow. |

## RISK-1: Define the renewal-risk signal contract

## Assignment

Define the account-risk signal contract for the renewal-risk triage workspace,
including required fields, source labels, freshness expectations, and review
states.

## Inputs

- Linear project: `DEMO-RENEWAL-RISK` synthetic fixture.
- Decomposition key: `renewal-risk/signal-contract`.
- Source context: [input/linear-project.md](../input/linear-project.md).
- Relevant prior decision: the first version is review-only and must not write
  to CRM, support, billing, or customer communication systems.

## Output

Approved contract documentation and fixture schema for renewal-risk account
summaries.

## Acceptance Criteria

- Contract includes renewal date, account owner, product commitment, source
  signal, risk reason, current review state, and next action.
- Contract names freshness expectations for each source signal.
- Contract distinguishes missing data from low-risk status.
- Fixture schema validates at least five synthetic account examples.
- Review-only boundary is explicit in the contract.

## Non-Goals

- Building the aggregation code.
- Changing source systems.
- Creating product prioritization policy.

## Escalate If

- The contract requires a product decision about which customer segment or
  revenue band should be prioritized.

## RISK-2: Build the read-only account summary aggregation path

## Assignment

Build a read-only aggregation path that turns sanitized demo account records
into renewal-risk summaries using the approved signal contract.

## Inputs

- Linear project: `DEMO-RENEWAL-RISK` synthetic fixture.
- Decomposition key: `renewal-risk/read-only-aggregation`.
- Source context: `RISK-1` contract output.
- Relevant prior decision: no source-system writes in the first version.

## Output

Read-only summary generator plus deterministic fixture coverage.

## Acceptance Criteria

- Generator accepts the fixture schema from `RISK-1`.
- Output contains one normalized account summary per input account.
- Missing account owner, stale source signal, and no next action each produce
  visible review states.
- Tests cover at least one high-risk, one watch-list, one missing-data, and one
  low-risk account.
- No code path writes to external systems.

## Non-Goals

- Live CRM, support, billing, or contract-system integration.
- Revenue forecasting.
- Customer-facing notifications.

## Escalate If

- The implementation cannot preserve the review-only boundary without changing
  the user workflow.

## RISK-3: Add the renewal-risk review workspace

## Assignment

Add the operations workspace view that lets product operations and customer
success review account risk, inspect source signals, and assign a next product
action.

## Inputs

- Linear project: `DEMO-RENEWAL-RISK` synthetic fixture.
- Decomposition key: `renewal-risk/review-workspace`.
- Source context: `RISK-1` contract and `RISK-2` summary generator.
- Relevant prior decision: use the existing operations workspace instead of a
  new dashboard surface.

## Output

Review workspace UI and state handling for renewal-risk summaries.

## Acceptance Criteria

- A reviewer can scan the top 20 account summaries without opening a separate
  spreadsheet.
- Each account row shows owner, renewal date, risk reason, source signal, and
  next action.
- Reviewer can mark a summary as reviewed, needs follow-up, or missing data.
- Empty, loading, and fixture-error states are visible and non-destructive.
- View copy does not imply automated customer outreach or revenue forecasting.

## Non-Goals

- Net-new dashboard navigation.
- Account scoring model design.
- Customer-facing workflow changes.

## Escalate If

- The review states need a product decision about who owns account-risk
  prioritization after the meeting.

## RISK-4: Instrument the triage workflow and decomposition quality

## Assignment

Instrument the renewal-risk triage workflow so the team can tell whether the
workspace helped the meeting and whether Agentic Factory produced executable
issues from the roadmap item.

## Inputs

- Linear project: `DEMO-RENEWAL-RISK` synthetic fixture.
- Decomposition key: `renewal-risk/workflow-instrumentation`.
- Source context: `RISK-3` review workspace.
- Relevant prior decision: measure user decision quality, not only page usage.

## Output

Instrumentation plan, trace fields, and a decomposition-quality annotation
fixture for the demo run.

## Acceptance Criteria

- Instrumentation records review completion, missing-data count, follow-up
  count, and time-to-first-next-action.
- Decomposition-quality fixture records label, score, failure modes, and
  explanation using the current rubric vocabulary.
- Metrics can show whether the meeting produced Linear follow-up work without
  a separate spreadsheet.
- Instrumentation avoids storing customer content in eval evidence.
- Reviewers can inspect the evidence without reading private planning history.

## Non-Goals

- Building a custom eval dashboard.
- Automatically accepting process changes.
- Capturing full customer records in traces.

## Escalate If

- The desired instrumentation would expose sensitive customer content or make a
  product promise about revenue outcomes.
