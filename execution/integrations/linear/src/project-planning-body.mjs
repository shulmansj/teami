import { normalizeMarkdown } from "./project-body.mjs";

export const PROJECT_PLANNING_SLOTS = Object.freeze([
  Object.freeze({ key: "problem", heading: "Problem Or Opportunity", required: true }),
  Object.freeze({ key: "audience", heading: "Audience / Who It's For", required: true }),
  Object.freeze({ key: "desired_outcome", heading: "Desired Outcome", required: true }),
  Object.freeze({ key: "acceptance", heading: "Acceptance Evidence", required: true }),
  Object.freeze({ key: "scope", heading: "Scope Boundaries", required: true }),
  Object.freeze({ key: "constraints", heading: "Constraints And Decisions", required: true }),
  Object.freeze({ key: "sources", heading: "Sources & Context Gaps", required: true }),
  Object.freeze({ key: "human_decisions", heading: "Human-Only Decisions", required: true }),
]);

export function renderPlanningBody(slots = {}) {
  return normalizeMarkdown(
    PROJECT_PLANNING_SLOTS.map((slot) => renderSlotSection(slot, slots)).join("\n\n"),
  );
}

export function renderConfirmation(slots = {}) {
  return normalizeMarkdown([
    "Planning body ready:",
    "",
    ...PROJECT_PLANNING_SLOTS.flatMap((slot) => [
      `${slot.heading}:`,
      slotMarkdown(slots[slot.key]),
      "",
    ]),
    "Local listener: `npx @shulmansj/teami gateway start` (keep it open while you want Teami to work).",
    "Moving to Planned queues the project. If the listener is running, Teami picks it up automatically on the next poll; otherwise it waits safely until the listener starts.",
  ].join("\n"));
}

function renderSlotSection(slot, slots) {
  const content = slotMarkdown(slots[slot.key]);
  if (!content) return `## ${slot.heading}`;
  return `## ${slot.heading}\n\n${content}`;
}

function slotMarkdown(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return String(value ?? "").trim();
}
