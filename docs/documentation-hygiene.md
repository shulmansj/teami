# Documentation Hygiene

Documentation quality is part of the product. Teami asks adopters to
trust an agent workflow, so confusing docs create product risk, not just repo
mess.

Use this guide whenever a human or agent changes docs.

## Principles

1. One topic has one owner document.
2. Link to owner documents instead of copying their rules.
3. Planning notes expire after their accepted decisions are extracted.
4. Public docs must not require access to private planning or review evidence.
5. Docs should describe the current product contract, not every path we once
   considered.
6. Agent instructions should reduce human decision load, not ask the human to
   choose file names, headings, or mechanical structure.
7. A doc change is incomplete until contradictory copies have been found and
   reconciled.

## Documentation Walk

Before editing docs:

1. Start at [docs/README.md](README.md), the committed documentation map.
2. Identify the owner doc for the topic.
3. Read [README.md](../README.md) only when the task changes product shape,
   repo map, onboarding flow, or when you lack enough product context.
4. Search current docs and owner surfaces for duplicate or contradictory
   language before editing:

```powershell
rg -n "term-or-decision" README.md docs execution examples
```

5. Patch the owner doc first.
6. Replace duplicates with links to the owner doc.
7. If another doc disagrees with the owner doc, reconcile the conflict in the
   same change. Do not leave both versions with a note to revisit later.
8. Retire stale planning notes after their useful decisions are extracted; do
   not link to them from public docs.
9. Run a stale-language scan before finishing.

## Owner Documents

| Topic | Owner |
| --- | --- |
| Product overview and repo map | [../README.md](../README.md) |
| Roles, workflow, state, escalation, trigger, and Workflow Runner strategy | [operating-model.md](operating-model.md) |
| Linear setup, OAuth, GraphQL, and decomposition service rules | [../execution/integrations/linear/README.md](../execution/integrations/linear/README.md) |
| Adoption, sandbox, pilot permissions | [adoption.md](adoption.md) |
| Phoenix telemetry, traces, evals, and self-improvement | [self-improvement.md](self-improvement.md) |
| Documentation structure and cleanup rules | This file |

If a new topic does not fit an owner doc, create a new owner doc and link it
from [docs/README.md](README.md). Do not add a free-floating planning file.

## Proper Home Rule

When adding information, first decide what kind of information it is:

- Product promise, role, state, or escalation rule: update
  [operating-model.md](operating-model.md).
- Workflow interface strategy, trigger policy, or Workflow Runner behavior:
  update [operating-model.md](operating-model.md).
- Linear setup, schema, OAuth, GraphQL behavior, or reset behavior: update
  [../execution/integrations/linear/README.md](../execution/integrations/linear/README.md).
- Adoption, permissions, pilot sequencing, or rollout risk: update
  [adoption.md](adoption.md).
- Phoenix telemetry, trace, eval, snapshot, failure taxonomy, or learning-loop
  behavior: update [self-improvement.md](self-improvement.md).
- Documentation structure or authoring behavior: update this file and
  [README.md](../README.md) if the rule affects all contributors.

If information seems to belong in multiple places, choose the owner doc for the
full rule and link to it from secondary locations. Do not maintain parallel
copies.

Integration owner docs intentionally live next to the integration they document,
such as
[../execution/integrations/linear/README.md](../execution/integrations/linear/README.md).
Do not move or duplicate integration setup rules into `docs/`; link to the
integration README.

## Code/Docs Mismatch Rule

Current known deferred mismatches: none.

If code, config, and owner docs disagree, treat that as a defect. Do not change
canonical docs back to historical behavior just because an old plan, review, or
example says something different. First determine whether the owner doc is
describing the accepted product contract or whether the code has become the
actual shipped contract.

If a mismatch is intentionally deferred, record it in this section before
finishing the change. A deferred mismatch entry must include:

- the owner doc that defines the accepted contract
- the affected code or config paths
- the expected resolution
- the stale language that must not be reintroduced
- the reason it is not being fixed in the current change

If no entry exists, agents should either reconcile the docs and implementation
or report the mismatch explicitly. They should not leave parallel explanations
in place.

## File Placement

Use these locations:

- `README.md`: product entrypoint and high-level repo map.
- `docs/`: durable documentation for adopters, contributors, and agents.
- `execution/`: runnable templates, schemas, workflows, and integration docs.
- `examples/`: fictional or disposable examples.

Private maintainer plans, review artifacts, launch records, manifests, and
approval packets are not public owner docs. If a maintainer note becomes
durable, move the accepted content into `docs/` or the relevant `execution/`
README and retire the stale note.

## How To Handle Planning Notes

Planning notes are allowed while a decision is forming. They should not survive
as second manuals.

When a plan is accepted:

1. Extract product decisions into the owner doc.
2. Extract implementation contracts into the relevant integration/workflow doc.
3. Extract eval or trace requirements into [self-improvement.md](self-improvement.md).
4. Keep any outside-review disposition in private maintainer evidence when
   useful.
5. Retire the planning note.

Keep review artifacts as evidence, not canonical instructions. Owner docs are
truth.

## Stale Language Checklist

Before finishing a doc change, search current documentation surfaces for old
concepts that commonly reappear. This includes Markdown under `execution/`
because integration and template docs live there, but it intentionally excludes
runtime code where legacy cleanup constants or security-taxonomy terms may be
valid implementation details:

```powershell
rg -n "<deprecated-term-a>|<deprecated-term-b>" README.md docs execution examples -g "*.md"
```

When a match is intentionally historical or a rejection of a path, make that
clear in the surrounding sentence.

Also search for the specific concept you changed. For example, if you changed
Linear OAuth behavior, search for `OAuth`, `actor`, `app user`, `API key`,
`GraphQL`, and `Linear setup`. If you changed roadmap behavior, search for
`roadmap`, `source of truth`, and `Linear project`.

Treat contradictions as defects. Fix the owner doc, then either delete the stale
copy or replace it with a short link to the owner doc.

Deferred mismatches are the exception only when they are explicitly recorded in
[Code/Docs Mismatch Rule](#codedocs-mismatch-rule). Report them, leave the
owner doc as the accepted product contract, and fix the implementation in a
code-alignment task.

## Linking Rules

- Link to the owner doc the first time a topic is mentioned.
- Keep relative links valid from the file being edited.
- Do not link to deleted planning notes.
- Do not use review artifacts as canonical docs.
- If a doc says "see X," make sure X actually owns the topic.

## Agent Rules

When an agent edits docs:

1. Preserve product meaning before improving prose.
2. Ask the human only when the documentation change affects product promise,
   trust posture, supported setup path, scope, or adoption strategy.
3. Make mechanical organization choices directly.
4. Prefer consolidation over adding another document.
5. Delete obsolete docs after extracting useful content.
6. Update [docs/README.md](README.md) when adding, deleting, or changing a
   canonical doc.
7. Search for conflicting copies of any changed concept and reconcile them.
8. Run `git diff --check` on touched docs.
9. Report any code/docs mismatch explicitly in the final response.

When an agent is asked to "walk the docs" or perform a hygiene pass:

1. Start at [docs/README.md](README.md), not in private maintainer notes.
2. Build a short list of owner docs that govern the requested topic.
3. Read private historical plans and reviews only when they are available and
   needed to recover accepted decisions that were never extracted.
4. Prefer deleting stale duplicate guidance over adding caveats.
5. Keep examples clearly marked as fictional or historical.
6. Do not add committed `AGENTS.md` or `CLAUDE.md` files unless the repo
   intentionally changes its local-session policy.

## Review Artifacts

When using an outside review:

- Send a focused packet with the objective, constraints, changed docs, and
  review questions.
- Keep the review in private maintainer evidence, not as a public canonical doc.
- Classify findings as objective fix, technical tension, product/taste
  decision, deferred, or rejected.
- Patch objective fixes directly.
- Ask the human about product/taste decisions rather than hiding them in prose.
