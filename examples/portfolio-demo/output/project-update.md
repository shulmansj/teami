# Project Update: Renewal Risk Triage Workspace

Provenance: hand-curated from current output.

This update is manually curated to match the current project-update contract.
It is the visible narrative a human project lead would read after a successful
decomposition commit.

Source project: [Renewal Risk Triage Workspace](../input/linear-project.md)

## Status

Decomposition completed. Four Ready issues were prepared from the project
intent, with dependency relations planned for Linear.

## What I did with each part of your project

Problem or opportunity:

I preserved the weekly renewal-review pain as the center of the work. The
created issues focus on reducing meeting reconciliation time and making product
follow-up accountable, not on building a general revenue dashboard.

Strategic rationale:

I treated renewal trust and customer-success coordination as the reason to keep
the first version narrow. That led to a review-only boundary and no writes to
CRM, support, billing, or customer communication systems.

Desired outcome:

I split the desired outcome into a signal contract, a read-only aggregation
path, a review workspace, and instrumentation that proves whether the meeting
produced useful follow-up work.

Acceptance evidence:

I converted the evidence into observable issue criteria: top-20 account review,
required account-summary fields, review states, follow-up accountability,
fixture coverage, and no source-system writes.

Scope boundaries:

I kept automated outreach, forecasting, pricing, and source-system mutation out
of the execution plan. If those become desired later, they should be approved
as separate product scope.

Open questions:

No blocking open questions were found in the synthetic project snapshot.

## Created Work

- `RISK-1`: Define the renewal-risk signal contract.
- `RISK-2`: Build the read-only account summary aggregation path.
- `RISK-3`: Add the renewal-risk review workspace.
- `RISK-4`: Instrument the triage workflow and decomposition quality.

## Next Action

Review the issue boundaries and then let agents or humans claim the Ready
issues in dependency order.

## Residual Risk

The decomposition assumes the first version can use sanitized fixture data. If
the team needs live source-system data in the first release, the trust and
integration scope changes and should be approved before execution starts.
