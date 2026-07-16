# Trace Summary

Provenance: hand-curated from current output.

This is a synthetic trace summary for the renewal-risk demo. It shows the
evidence shape a successful decomposition run should leave behind, without
claiming that this package was generated from a live Linear workspace or a live
Phoenix trace.

## Scope

- Demo run label: `renewal-risk-decomposition`.
- Source input: [../input/linear-project.md](../input/linear-project.md).
- Expected visible outputs:
  [../output/execution-issues.md](../output/execution-issues.md) and
  [../output/project-update.md](../output/project-update.md).
- Evidence source: synthetic fixture plus hand-curated output matching the
  current decomposition contracts.

## Trace Shape

| Step | Expected signal | Demo evidence |
| --- | --- | --- |
| Load project context | Read the Linear project snapshot and preserve the product problem, desired outcome, acceptance evidence, and scope boundaries. | The generated issues keep renewal-review pain, top-20 review, next-action accountability, and no source-system writes. |
| Eligibility gate | Confirm the project is ready for non-interactive decomposition and reject unsafe partial mutation states. | The fixture is in the planned decomposition state; no partial live mutation is claimed. |
| PM synthesis | Convert product intent into issue boundaries and product-readable acceptance criteria. | `RISK-1` through `RISK-4` split contract, aggregation, review workspace, and instrumentation work. |
| Sr Eng grounding | Check that dependencies and implementation boundaries are explicit enough for later agents. | The issue bundle includes native dependency relations and escalation points. |
| Persist run artifact | Store accepted run evidence before any live mutation. | Not proven by this demo package. This summary only shows the expected evidence shape. |
| Commit Linear update | Create or reuse issues and post the project update after gates pass. | Not proven by this demo package. The output files are publishable examples, not live Linear records. |
| Emit Phoenix evidence | Attach trace and eval evidence to local Phoenix when available. | Not proven by this demo package. The eval summary is synthetic and hand-curated. |

## Product Reading

The useful proof point is not that an agent produced a lot of text. It is that
the decomposition preserved product intent, created bounded execution work, and
left enough evidence for a human to decide whether the process should improve.

This demo shows that reading path. It does not prove live queue handoff, live
Linear mutation, local Phoenix delivery, or behavior-repo proposal creation.
Local team `git_repo` binding behavior is proved separately in
[resource-binding-proof.md](resource-binding-proof.md).
