# Linear Project: Renewal Risk Triage Workspace

Provenance: illustrative future artifact.

Synthetic Linear fields:

- Team: Teami
- Status: Planned
- Labels: none
- Lead: Maya Patel, Product Operations
- Project key: DEMO-RENEWAL-RISK

# Problem Or Opportunity

Customer success managers at the fictional company LumaDesk review enterprise
renewal risk every Wednesday. The account signals they need are spread across
support escalations, usage-change notes, contract dates, and roadmap promises.
Product managers join the meeting with partial context, so the group spends
most of the hour reconciling facts instead of deciding which product work
would reduce renewal risk.

In this demo fixture, the last four renewal-review meetings each produced a
manual spreadsheet. Two spreadsheets disagreed on account owner, and three
high-risk accounts had product commitments with no clear owner or next action.

# Strategic Rationale

Renewal risk is where product-ops work becomes visible to revenue and customer
trust. A focused triage workspace would help the team decide which product
commitments matter now, without turning Teami into a CRM, support
tool, or revenue dashboard.

# Desired Outcome

Create a renewal-risk triage workspace that lets product operations and
customer success review the highest-risk accounts, see the source signals
behind each risk, assign a next product action, and leave the meeting with
Linear issues that are ready for execution or accountable follow-up.

# Acceptance Evidence

- A product-ops lead can review the top 20 renewal-risk accounts in 15 minutes
  using one workspace view.
- Each listed account shows renewal date, account owner, product commitment,
  source signal, current risk reason, and next action.
- At least one meeting produces Linear follow-up work without a separate
  spreadsheet.
- The workflow records which issue or owner is accountable for each next
  action.
- No workflow writes back to CRM, support, billing, or customer communication
  systems.

# Scope Boundaries

## Likely in scope

- Define the renewal-risk signal contract and account-summary fields.
- Build a read-only aggregation path using sanitized demo data.
- Add an operations workspace view for reviewing account risk and next action.
- Create agent-ready Linear issues for implementation, review, instrumentation,
  and rollout.
- Instrument decomposition quality so the team can evaluate whether created
  issues are executable and bounded.

## Non-goals

- Automated customer messaging.
- CRM, support, billing, or contract-system writes.
- Revenue forecasting or pricing recommendations.
- Replacing customer success ownership.
- Creating a new dashboard outside the existing operations workspace.

# Open Questions


# Underlying Assumptions

- The first demo can use sanitized account fixtures before any production data
  connection exists.
- Customer success already owns the account-risk decision; this project only
  makes the source signals and product follow-up work clearer.
- Product managers prefer fewer, better Linear issues over a large backlog of
  vague account requests.

# History

- 2026-06-18: Maya Patel created draft item from renewal-review notes.
- 2026-06-20: Maya Patel removed CRM writes from scope to keep the first
  version review-only.
- 2026-06-23: Status changed to Planned for decomposition.
