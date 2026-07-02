# Portfolio Demo: Renewal Risk Triage

Provenance: illustrative future artifact.

This demo is a synthetic, publishable walkthrough of Teami's core
story: a human writes product intent in Linear, the workflow decomposes it into
agent-ready issues, and eval evidence identifies a process improvement worth
human review.

The scenario is fictional. The companies, people, account names, metrics, issue
keys, run labels, and eval labels are demo data. This package is not the public
readiness project, and it is not account-connected setup proof.

## Scenario

A fictional B2B SaaS company, LumaDesk, sells workflow software to customer
operations teams. Its product-ops team wants a renewal-risk triage view so
customer success managers and product managers can review risky accounts from
one Linear-backed roadmap item instead of rebuilding spreadsheets every week.

The demo shows:

1. The roadmap item as a Linear project body.
2. The execution issues Teami would create from that project.
3. The project update a human would read after decomposition.
4. A local improvement proposal based on decomposition eval results.

## Artifacts

| Artifact | Purpose | Provenance label |
| --- | --- | --- |
| [input/linear-project.md](input/linear-project.md) | Synthetic Linear roadmap project body. | `illustrative future artifact` |
| [output/execution-issues.md](output/execution-issues.md) | Hand-curated agent-ready issue bundle matching the current issue template. | `hand-curated from current output` |
| [output/project-update.md](output/project-update.md) | Hand-curated decomposition completion update matching the current project-update contract. | `hand-curated from current output` |
| [output/proposal.md](output/proposal.md) | Local process-improvement proposal based on synthetic eval evidence. | `hand-curated from current output` |
| [architecture.md](architecture.md) | Demo architecture and trust-boundary explanation. | `hand-curated from current output` |
| [evidence/trace-summary.md](evidence/trace-summary.md) | Synthetic trace summary for the demo decomposition flow. | `hand-curated from current output` |
| [evidence/eval-summary.md](evidence/eval-summary.md) | Synthetic eval summary behind the local proposal. | `hand-curated from current output` |
| [evidence/resource-binding-proof.md](evidence/resource-binding-proof.md) | Public-safe proof packet for landed local domain `git_repo` binding behavior. | `hand-curated from current implementation` |

## Current Boundaries

The demo does not claim that a real Linear workspace was mutated during this
package build. It also does not claim branch creation, pull-request creation,
merge, accepted behavior change, or account-connected setup readiness. The resource-binding
proof covers landed local `git_repo` binding behavior from source and tests; it
does not expose or rely on a private product checkout.

Use this package as a first-reader walkthrough of the product shape: product
intent becomes executable work, and quality signals become reviewable process
improvements.
