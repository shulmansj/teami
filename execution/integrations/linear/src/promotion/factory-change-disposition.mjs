// ---------------------------------------------------------------------------
// Factory-change disposition (A-CONTENT-DEMOTE): the demoted view
// ---------------------------------------------------------------------------
//
// The meta-change classifier's PATH-map labels and PROMPT-PROSE-scan labels are
// DIAGNOSTIC (advisory), NOT the ownership gate. The positive commit allowlist
// (`commitPromotionDraft`) is the ownership gate. This module computes the
// DEMOTED VIEW of a classification: it splits each factory-behavior class
// (`meta_change` / `authority_change`) into ADVISORY-ONLY vs GATING, so the
// write-guard and the packet-completeness guard can treat the path/prose
// surfaces as a non-gating advisory while keeping every other surface gating.
//
// DISCRIMINATION RULE — an allowlist keyed on reason `id`:
//   A factory-behavior class is ADVISORY-ONLY iff there is at least one reason
//   carrying that class AND EVERY reason carrying that class has an `id` in
//   ADVISORY_ONLY_REASON_IDS. If ANY reason carrying a factory class is OUTSIDE
//   the allowlist (e.g. `field_sensitive_meta_slot`, a raw `authority_*` id from
//   the field-sensitive branch, `field_sensitive_runtime_defaults_judge_excluded`,
//   anything else), the class GATES. A factory class with NO reason carrying it
//   (e.g. the bare `meta_change` the field-sensitive authority branch adds to the
//   class set without a backing reason) is NOT demoted — fail closed, it GATES.
//   `unknown_sensitive` is never a factory-behavior class here and never demotes.
//
// This module lives OUTSIDE meta-change-classifier.mjs on purpose: the
// classifier's classify logic, `classifyFieldSensitiveChange` (surface 2 — STAYS
// a gate), the short-circuit fast-paths, and the parseability invariant are not
// touched. The demotion is a downstream READ over the classifier's `reasons[]`.

export const FACTORY_BEHAVIOR_CLASSES = Object.freeze([
  "meta_change",
  "authority_change",
]);

// The 6 reason ids that are PATH-map or PROMPT-PROSE diagnostic surfaces only.
// These are the labels demoted from a hard block to a non-gating advisory.
export const ADVISORY_ONLY_REASON_IDS = Object.freeze(new Set([
  "ordinary_prompt_meta_escalation",
  "authority_hunk_escalation",
  "meta_hunk_unmapped_path",
  "authority_hunk_unmapped_path",
  "protected_path_meta_change",
  "protected_path_authority_change",
]));

const FACTORY_BEHAVIOR_CLASS_SET = new Set(FACTORY_BEHAVIOR_CLASSES);

function reasonArray(classification) {
  return Array.isArray(classification?.reasons) ? classification.reasons : [];
}

function factoryClassesPresent(classification) {
  const present = new Set();
  if (FACTORY_BEHAVIOR_CLASS_SET.has(classification?.class)) present.add(classification.class);
  const mixed = Array.isArray(classification?.mixed_classes) ? classification.mixed_classes : [];
  for (const className of mixed) {
    if (FACTORY_BEHAVIOR_CLASS_SET.has(className)) present.add(className);
  }
  for (const reason of reasonArray(classification)) {
    if (FACTORY_BEHAVIOR_CLASS_SET.has(reason?.class)) present.add(reason.class);
  }
  return present;
}

// Compute the demoted view of a classification.
//
// Returns:
//   advisory_only_classes — factory classes demoted to advisory (every backing
//                           reason is in the allowlist, and at least one exists)
//   gating_classes        — factory classes that still gate
//   advisory_reasons      — the reasons[] entries (path/prose surfaces) backing
//                           the advisory-only classes; recorded for the marker
//   has_gating_factory_class — true iff any factory class still gates
export function resolveFactoryChangeDisposition(classification = {}) {
  const present = factoryClassesPresent(classification);
  const reasons = reasonArray(classification);
  const advisoryOnlyClasses = [];
  const gatingClasses = [];
  const advisoryReasons = [];

  for (const factoryClass of FACTORY_BEHAVIOR_CLASSES) {
    if (!present.has(factoryClass)) continue;
    const reasonsForClass = reasons.filter((reason) => reason?.class === factoryClass);
    const everyReasonAdvisory = reasonsForClass.length > 0
      && reasonsForClass.every((reason) => ADVISORY_ONLY_REASON_IDS.has(reason?.id));
    if (everyReasonAdvisory) {
      advisoryOnlyClasses.push(factoryClass);
      for (const reason of reasonsForClass) advisoryReasons.push(reason);
    } else {
      // No backing reason (fail closed) OR a reason outside the allowlist.
      gatingClasses.push(factoryClass);
    }
  }

  return {
    advisory_only_classes: advisoryOnlyClasses,
    gating_classes: gatingClasses,
    advisory_reasons: advisoryReasons,
    has_gating_factory_class: gatingClasses.length > 0,
  };
}

// The advisory schema recorded on the classification result and the promotion
// marker (`marker.advisories`). Path/prose surfaces only — the gating disposition
// is NOT carried here (the guards own that). Shape is deliberately small and
// JSON-stable so the marker validator accepts it unchanged.
export function advisorySchemaFor(classification = {}) {
  const disposition = resolveFactoryChangeDisposition(classification);
  return {
    schema_version: FACTORY_CHANGE_ADVISORY_SCHEMA_VERSION,
    advisory_only_classes: [...disposition.advisory_only_classes],
    advisory_reasons: disposition.advisory_reasons.map((reason) => ({
      id: reason.id,
      class: reason.class,
      ...(reason.path ? { path: reason.path } : {}),
      ...(reason.surface ? { surface: reason.surface } : {}),
    })),
  };
}

export const FACTORY_CHANGE_ADVISORY_SCHEMA_VERSION =
  "agentic-factory-factory-change-advisory/v1";

// The marker-facing advisory: the demoted-view schema when at least one factory
// class was demoted to advisory, else null (a purely ordinary change records no
// advisory on the marker, keeping it lean and the template marker grammar
// unchanged). The advisory is accountability metadata, never a gate.
export function markerAdvisoriesFor(classification = {}) {
  const advisory = advisorySchemaFor(classification);
  return advisory.advisory_only_classes.length > 0 ? advisory : null;
}

// Annotate a classification result in place-by-copy with the demoted view, so a
// single classification object carries both the gating set the guards consume
// and the advisory labels the marker records. Existing fields are preserved.
export function withFactoryChangeDisposition(classification = {}) {
  const disposition = resolveFactoryChangeDisposition(classification);
  return {
    ...classification,
    advisory_reasons: disposition.advisory_reasons,
    advisory_only_classes: disposition.advisory_only_classes,
    gating_factory_classes: disposition.gating_classes,
    advisories: advisorySchemaFor(classification),
  };
}
