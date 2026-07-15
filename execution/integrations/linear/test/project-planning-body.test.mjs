import test from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_PLANNING_SLOTS,
  renderConfirmation,
  renderPlanningBody,
} from "../src/project-planning-body.mjs";

const COMPLETE_SLOTS = Object.freeze({
  problem: "Activation stalls because founders cannot translate intent into decomposition-ready work.",
  audience: "Non-technical founders using Teami with a connected Linear domain.",
  desired_outcome: "A clear project body that a human can review before committing the factory.",
  acceptance: "Every planning slot is visible in Linear and can be traced back to the confirmation receipt.",
  scope: "Include upstream planning intent; exclude downstream issue decomposition.",
  constraints: "Local-first, zero-hosted, and no privileged action without human confirmation.",
  sources: "Founder brief plus named gaps around launch timing.",
  human_decisions: "Founder chooses when to move the project to Planned.",
});

test("project planning slots expose the canonical ordered body surface", () => {
  assert.deepEqual(
    PROJECT_PLANNING_SLOTS.map(({ key, heading, required }) => ({ key, heading, required })),
    [
      { key: "problem", heading: "Problem Or Opportunity", required: true },
      { key: "audience", heading: "Audience / Who It's For", required: true },
      { key: "desired_outcome", heading: "Desired Outcome", required: true },
      { key: "acceptance", heading: "Acceptance Evidence", required: true },
      { key: "scope", heading: "Scope Boundaries", required: true },
      { key: "constraints", heading: "Constraints And Decisions", required: true },
      { key: "sources", heading: "Sources & Context Gaps", required: true },
      { key: "human_decisions", heading: "Human-Only Decisions", required: true },
    ],
  );
});

test("renderPlanningBody emits canonical sections and no Open Questions section", () => {
  assert.equal(renderPlanningBody(COMPLETE_SLOTS), `## Problem Or Opportunity

Activation stalls because founders cannot translate intent into decomposition-ready work.

## Audience / Who It's For

Non-technical founders using Teami with a connected Linear domain.

## Desired Outcome

A clear project body that a human can review before committing the factory.

## Acceptance Evidence

Every planning slot is visible in Linear and can be traced back to the confirmation receipt.

## Scope Boundaries

Include upstream planning intent; exclude downstream issue decomposition.

## Constraints And Decisions

Local-first, zero-hosted, and no privileged action without human confirmation.

## Sources & Context Gaps

Founder brief plus named gaps around launch timing.

## Human-Only Decisions

Founder chooses when to move the project to Planned.
`);
  assert.doesNotMatch(renderPlanningBody(COMPLETE_SLOTS), /^## Open Questions\b/m);
});

test("renderPlanningBody keeps empty sections for missing slots", () => {
  const body = renderPlanningBody({ problem: "Only one slot is populated." });

  assert.match(body, /^## Audience \/ Who It's For\n\n## Desired Outcome/m);
  assert.doesNotMatch(body, /undefined|null/);
});

test("renderConfirmation derives from the same slots and ends with the commit cue", () => {
  const slots = {
    ...COMPLETE_SLOTS,
    acceptance: "The receipt and Linear body both show this changed acceptance evidence.",
  };

  const body = renderPlanningBody(slots);
  const confirmation = renderConfirmation(slots);

  assert.match(body, /both show this changed acceptance evidence/);
  assert.match(confirmation, /both show this changed acceptance evidence/);
  assert.doesNotMatch(body, /Every planning slot is visible/);
  assert.doesNotMatch(confirmation, /Every planning slot is visible/);
  assert.ok(confirmation.trimEnd().endsWith(
    "Moving to Planned queues the project. If the listener is running, Teami picks it up automatically on the next poll; otherwise it waits safely until the listener starts.",
  ));
  assert.match(confirmation, /npx @shulmansj\/teami gateway start/);
});
