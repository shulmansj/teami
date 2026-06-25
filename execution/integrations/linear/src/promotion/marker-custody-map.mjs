// ---------------------------------------------------------------------------
// B-CUSTODY: the machine-readable field -> custody-class map for the PR
// promotion marker (`agentic_factory_promotion`, built by
// `pr-marker.mjs buildPromotionMarker`).
//
// The marker is COMMITTED into the repo: it is rendered into the PR body. The
// 0B custody contract (`maintainers/contracts/authority-custody-defaults.md`,
// "Capture-Time Field Classes") says only redacted, repo-recordable facts may
// be committed. This module is the single source that classifies every field
// the marker commits by its capture-time custody class, so the custody fixture
// (`marker-custody.test.mjs`) READS this map rather than re-deciding per field.
//
// Decided 2026-06-19: this is a LOCAL field->class map (this module), NOT a
// `protected-slots.json` `ledger_fields` section. `protected-slots.json` is the
// single source for factory-protection *paths* (a different concern); ledger
// custody classes are their own concern and single-source cleanest here.
//
// EXHAUSTIVENESS CONTRACT: this map must classify every leaf field the marker
// emits. The fixture DEEP-WALKS a real built marker — descending through nested
// objects AND arrays-of-objects down to their scalar leaves — and asserts every
// present leaf path has an entry here, so a NEW committed field added to the
// marker later (even one nested inside `evidence_ids.datasets[]` or `advisories`)
// without a class entry FAILS the fixture (the map is exhaustive over every
// committed leaf, and a leak cannot slip in silently at any depth).
// ---------------------------------------------------------------------------

// The capture-time custody classes, verbatim from the 0B contract's
// "Capture-Time Field Classes" table. A field is committable to the repo/PR body
// only when its most-restrictive class is `repo-recordable` or the more-
// permissive `exportable`.
export const CUSTODY_CLASSES = Object.freeze({
  NEVER_CAPTURE: "never-capture",
  LOCAL_ONLY: "local-only",
  INFERENCE_TRANSIENT: "inference-transient",
  REPO_RECORDABLE: "repo-recordable",
  PHOENIX_RECORDABLE: "phoenix-recordable",
  EXTERNAL_AUDIT_RECORDABLE: "external-audit-recordable",
  EXPORTABLE: "exportable",
});

// The classes the contract permits to be committed to the repo / PR body.
// "When data fits multiple classes, the most restrictive class wins" — so the
// fixture treats any field NOT in this set as a leak to surface.
export const REPO_COMMITTABLE_CLASSES = Object.freeze(
  new Set([CUSTODY_CLASSES.REPO_RECORDABLE, CUSTODY_CLASSES.EXPORTABLE]),
);

// field path -> { class, why }. Paths use dotted notation rooted at the marker
// object (the value under the `agentic_factory_promotion` key). The walker
// DEEP-WALKS to leaves:
//   - Nested objects descend by `path.subkey` to their scalar leaves.
//   - Arrays OF SCALARS are classified at the array field itself (every element
//     value shares that class, e.g. the experiment ids under
//     `evidence_ids.experiments`).
//   - Arrays OF OBJECTS descend per element under a `[]` wildcard segment to the
//     element's scalar leaves (e.g. `evidence_ids.datasets[].dataset_id`), so a
//     nested handle smuggled onto an element object (e.g. a future
//     `evidence_ids.datasets[].local_path`) surfaces as its own leaf path and
//     must be classified — it cannot ride along unclassified.
//
// Honest classification against the 0B contract follows. Where a field is more
// restrictive than repo-recordable, it is recorded AS such here (not relabeled
// to make the fixture pass) so the fixture surfaces it — see the FINDING note on
// `phoenix_scope.origin`.
export const MARKER_FIELD_CUSTODY = Object.freeze({
  // -- Marker envelope / decision facts. Schema/version/action/state labels and
  // the proposal id are non-secret structural facts: repo-recordable
  // ("proposal summaries", structural decision record).
  schema_version: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Non-secret schema version of the marker; structural decision record.",
  },
  proposal_instance_id: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Engine-minted proposal id; a non-secret correlation id for the decision record.",
  },
  requested_action: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Constant action label (propose_repo_change); structural decision fact.",
  },
  candidate_target_key: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Behavior target key (e.g. prompt/decomposition/...); a behavior-repo artifact path / pin.",
  },
  candidate_kind: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Candidate kind enum; non-secret structural fact.",
  },
  candidate_version_id: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Accepted/candidate prompt version id; a prompt pin (repo-recordable example in the contract).",
  },
  accepted_baseline_id: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "The accepted baseline the candidate is pinned to; a prompt/version pin.",
  },
  normalized_envelope_hash: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "sha256 dedupe hash; a hash (repo-recordable example) with no secret content.",
  },
  policy_hash: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "sha256 of the policy in effect; a hash with no secret content.",
  },
  accept_cross_version_comparison: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Reviewer-visible boolean disclosure; structural decision fact.",
  },
  proposal_state: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Proposal state enum (proposed/superseded/blocked); structural decision fact.",
  },
  superseded_by: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Proposal id of a superseding proposal, or null; a non-secret correlation id.",
  },
  repair_state: {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Repair-state enum; structural decision fact.",
  },

  // -- phoenix_scope: the adopter's local Phoenix scope, committed verbatim.
  "phoenix_scope.origin": {
    // The custody fixture surfaced this (the contract's "Safe Phoenix Evidence
    // Links" rule bars "loopback-port mechanics" in PRs). It remains
    // repo-recordable on three grounds: (1) that rule targets
    // clickable EVIDENCE LINKS a reader might follow — this is a scope IDENTIFIER
    // (data), not a link; (2) it is LOAD-BEARING — the proposal scope-match guard
    // compares it (process-change-gate.mjs:615-621) and the marker validator
    // requires it, so redacting would weaken a real check; (3) under the settled
    // single-tenant / no-adversary threat model a loopback label committed to the
    // adopter's OWN repo reveals nothing exploitable. (A pre-existing field the
    // new fixture caught — not 3B-introduced.)
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Adopter's local Phoenix origin: a non-secret scope IDENTIFIER (not a clickable evidence link), load-bearing for the proposal scope-match guard; harmless in the adopter's own repo under the no-adversary model.",
  },
  "phoenix_scope.project_name": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Coarse Phoenix project/scope name (not a URL, not a fetchable handle); a non-secret scope label.",
  },

  // -- evidence_ids: adopter-scoped Phoenix evidence handles (ids, NOT URLs, NOT
  // raw trace ids, NOT bearer links). The contract's "Safe Phoenix Evidence
  // Links" rule explicitly permits "adopter-scoped non-secret evidence handles"
  // in PRs / proposal packets, and the existing design carries them as optional
  // id carriers validated against the local origin. Repo-recordable.
  "evidence_ids.experiments": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Phoenix experiment ids: adopter-scoped non-secret evidence handles the contract allows in PRs.",
  },
  // `datasets` is an array of `{ dataset_id, dataset_version_id }` objects
  // (pr-marker.mjs buildPromotionMarker shallow-copies the element objects, and
  // the marker validator requires both keys as non-empty strings). The walker
  // descends into the element under `evidence_ids.datasets[]`, so each committed
  // element leaf is classified individually — a future raw handle added to a
  // dataset element (e.g. `local_path`) would surface as unmapped, not ride along.
  "evidence_ids.datasets[].dataset_id": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Phoenix dataset id: an adopter-scoped non-secret evidence handle allowed in PRs.",
  },
  "evidence_ids.datasets[].dataset_version_id": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Phoenix dataset version id: an adopter-scoped non-secret evidence handle allowed in PRs.",
  },
  "evidence_ids.annotations": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Phoenix annotation ids: adopter-scoped non-secret evidence handles allowed in PRs.",
  },

  // -- packet: the structured proposal-packet FACTS (enum labels + booleans);
  // no raw content. These are the proposal-summary / risk-label structural facts
  // the contract lists as repo-recordable.
  "packet.schema_version": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Packet schema version; structural fact.",
  },
  "packet.source": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Packet source enum; structural fact.",
  },
  "packet.guard_status": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Packet guard-status enum; structural fact.",
  },
  "packet.copy_class": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Renderer copy-class enum; structural fact.",
  },
  "packet.deterministic_risk_floor": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Risk-floor enum (a risk label); repo-recordable example in the contract.",
  },
  "packet.risk_reason_present": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Presence boolean; no raw content.",
  },
  "packet.evidence_cohort_summary_present": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Presence boolean; no raw content.",
  },
  "packet.before_after_examples_present": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Presence boolean; no raw content.",
  },
  "packet.undo_bounds_present": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Presence boolean; no raw content.",
  },
  "packet.authority_custody_access_present": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Presence boolean; no raw content.",
  },

  // -- advisories (B / A-CONTENT-DEMOTE): accountability metadata recorded on the
  // marker only when a factory class was demoted. Non-secret factory labels
  // (path-map / prompt-prose classifications); structural accountability facts.
  // DEEP-WALKED to leaves (its shape is `advisorySchemaFor` in
  // factory-change-disposition.mjs): a `schema_version` string, an
  // `advisory_only_classes` string array (a scalar-array carrier), and an
  // `advisory_reasons` array of `{ id, class, path?, surface? }` objects descended
  // per element under `advisories.advisory_reasons[]`. Classifying each leaf
  // individually means a future raw handle added anywhere in the advisory record
  // (e.g. an `advisories.raw_handle` or a reason-level handle) surfaces and must
  // be classified, rather than being waved through as part of a whole-object pass.
  "advisories.schema_version": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Advisory schema version; structural fact.",
  },
  "advisories.advisory_only_classes": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Factory-behavior class labels (meta_change/authority_change) demoted to advisory; non-secret structural labels.",
  },
  "advisories.advisory_reasons[].id": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Advisory reason id (allowlisted diagnostic-surface id); non-secret structural label.",
  },
  "advisories.advisory_reasons[].class": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Factory-behavior class of the advisory reason; non-secret structural label.",
  },
  "advisories.advisory_reasons[].path": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Behavior-repo artifact path the factory label fired on; a repo path, not a secret handle.",
  },
  "advisories.advisory_reasons[].surface": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Diagnostic surface enum (protected_path_map / prose-scan); non-secret structural label.",
  },

  // -- undo_bounds (B-UNDO / S-UNDO): the static, proposal-time-knowable undo
  // facts. The contract lists "undo bounds" explicitly as a repo-recordable
  // example.
  "undo_bounds.schema_version": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Undo-bounds schema version; structural fact.",
  },
  "undo_bounds.what_undo_changes": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Plain-English undo description (versions/role-field names); a proposal summary / undo bound.",
  },
  "undo_bounds.external_side_effects": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Boolean undo fact; no raw content.",
  },

  // -- merged_accepted_ref (B-UNDO / S-UNDO): the post-merge accepted-version
  // reference, the same normalized shape as a run-version record entry. Version
  // pins + a hash; repo-recordable.
  "merged_accepted_ref.target_key": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Behavior target key; a behavior-repo artifact path / pin.",
  },
  "merged_accepted_ref.accepted_baseline_id": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Post-merge accepted version id (or sha256:<hash>); a version pin.",
  },
  "merged_accepted_ref.snapshot_sha256": {
    class: CUSTODY_CLASSES.REPO_RECORDABLE,
    why: "Snapshot sha256; a hash with no secret content.",
  },
});

// Walk a BUILT marker object (the value under the `agentic_factory_promotion`
// key, OR the full `{ agentic_factory_promotion: {...} }` wrapper) and return the
// committed leaf field paths, in dotted notation rooted at the marker object.
//
// DEEP-WALK to leaves (no per-field allowlist — the SHAPE decides the
// granularity, so a new nested object/array carries no escape hatch):
//   - A scalar (string/number/bool/null) is a LEAF — its path is reported.
//   - An object is DESCENDED into each key under `path.subkey`.
//   - An array of SCALARS is reported at the array field itself (its element
//     values share one class) — e.g. `evidence_ids.experiments`.
//   - An array containing OBJECTS is DESCENDED per element under a `[]` wildcard
//     segment — e.g. `evidence_ids.datasets[].dataset_id` — so a handle smuggled
//     onto an element object surfaces as its own leaf and must be classified.
//
// This is what makes the fixture catch a NEW committed field at ANY depth: every
// leaf the marker emits surfaces here, and the fixture asserts each has a class
// entry. An empty array contributes no leaf (it commits no handle).
const PROMOTION_MARKER_KEY = "agentic_factory_promotion";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayHasObjectElement(value) {
  return value.some((element) => isPlainObject(element) || Array.isArray(element));
}

// Recursively collect leaf paths from a value into `paths`, prefixing `path`.
function collectLeafPaths(value, path, paths) {
  if (Array.isArray(value)) {
    // A scalar-only (or empty) array is a single leaf carrier at `path`: every
    // element value shares one custody class. An object/array-bearing array is
    // descended per element under the `[]` wildcard so each element leaf is
    // classified on its own.
    if (value.length === 0) return;
    if (!arrayHasObjectElement(value)) {
      paths.push(path);
      return;
    }
    for (const element of value) {
      collectLeafPaths(element, `${path}[]`, paths);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      collectLeafPaths(value[key], path ? `${path}.${key}` : key, paths);
    }
    return;
  }
  // Scalar leaf (string / number / boolean / null / undefined).
  if (path) paths.push(path);
}

export function collectCommittedMarkerFieldPaths(marker) {
  const root = marker && typeof marker === "object" && marker[PROMOTION_MARKER_KEY]
    ? marker[PROMOTION_MARKER_KEY]
    : marker;
  if (!isPlainObject(root)) return [];
  const paths = [];
  collectLeafPaths(root, "", paths);
  return paths;
}

// Classify the committed field paths of a built marker against the map. Returns:
//   - classified: [{ path, class, why }]
//   - unmapped:   [path]                 (a committed field with NO map entry —
//                                          the map is not exhaustive; a leak slot)
//   - leaks:      [{ path, class, why }] (a committed field whose class is NOT
//                                          repo-committable — a custody leak)
// The fixture asserts unmapped == [] AND leaks == []. This function only READS
// the map; it never decides a class.
export function classifyCommittedMarker(marker, map = MARKER_FIELD_CUSTODY) {
  const paths = collectCommittedMarkerFieldPaths(marker);
  const classified = [];
  const unmapped = [];
  const leaks = [];
  for (const path of paths) {
    const entry = map[path];
    if (!entry) {
      unmapped.push(path);
      continue;
    }
    classified.push({ path, class: entry.class, why: entry.why });
    if (!REPO_COMMITTABLE_CLASSES.has(entry.class)) {
      leaks.push({ path, class: entry.class, why: entry.why });
    }
  }
  return { classified, unmapped, leaks };
}
