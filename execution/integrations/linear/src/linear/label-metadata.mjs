// Canonical metadata for the labels the factory provisions. Descriptions are
// machinery documentation — each states what the factory does with the label —
// so they are keyed by semantic ROLE and follow the label through adopter
// renames (label NAMES stay adopter-configurable in config.linear).
//
// Reconciliation contract (enforced by setup provisioning):
// - description: reconciled on every setup pass; it documents machinery
//   behavior, so drift from canonical is corrected.
// - group membership: reconciled; work-type exclusivity is a machinery
//   invariant, and the Linear label group makes the workspace enforce it
//   (an issue can carry at most one label from a group).
// - color: stamped at creation only, never reconciled; presentation belongs
//   to the adopter, so a recoloring sticks.
// - descriptions must stay ≤255 characters: Linear's API rejects longer ones
//   at write time, which fails the setup pass mid-cutover.
//
const ATTENTION_COLOR = "#F2994A"; // amber: everything waiting on the human
const WORK_TYPE_COLOR = "#5E6AD2"; // indigo: execution routing
const NON_CODE_COLOR = "#26B5CE";
const DISCOVERY_COLOR = "#BB87FC";

export const WORK_TYPE_LABEL_GROUP = Object.freeze({
  key: "work_type",
  name: "Work type",
  description:
    "Register: execution routing. The factory writes one work type when it creates an execution issue; removing it removes the routing declaration.",
  color: WORK_TYPE_COLOR,
});

const ISSUE_LABEL_METADATA = Object.freeze({
  discovery: Object.freeze({
    description:
      "Register: technical follow-up. The factory writes it when an issue captures bounded technical evidence; removing it means the issue is no longer classified as discovery work.",
    color: DISCOVERY_COLOR,
  }),
  human_review: Object.freeze({
    description:
      "A human must review and accept this issue's work before it merges. Set at triage or when the issue is created. Removing it releases the gate — a waiting pull request can then merge without review. Leave it on until you've reviewed.",
    color: ATTENTION_COLOR,
  }),
  work_type_code: Object.freeze({
    description:
      "Register: execution routing. The factory writes it when an execution issue changes a bound code repository; removing it makes the issue no longer routable as code work.",
    color: WORK_TYPE_COLOR,
    groupKey: WORK_TYPE_LABEL_GROUP.key,
  }),
  work_type_non_code: Object.freeze({
    description:
      "Register: execution routing. The factory writes it when an execution issue has no code repository change; removing it makes the issue no longer routable as non-code work.",
    color: NON_CODE_COLOR,
    groupKey: WORK_TYPE_LABEL_GROUP.key,
  }),
});

const PROJECT_LABEL_METADATA = Object.freeze({});

export function issueLabelMetadata(role) {
  return ISSUE_LABEL_METADATA[role] || null;
}

export function projectLabelMetadata(role) {
  return PROJECT_LABEL_METADATA[role] || null;
}
