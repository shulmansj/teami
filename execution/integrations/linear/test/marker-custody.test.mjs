import assert from "node:assert/strict";
import test from "node:test";

import { buildPromotionMarker } from "../src/promote-candidate.mjs";
import {
  buildMarkerUndoBounds,
  buildMergedAcceptedRef,
} from "../src/promotion/marker-undo-frame.mjs";
import { markerAdvisoriesFor } from "../src/promotion/factory-change-disposition.mjs";
import {
  CUSTODY_CLASSES,
  MARKER_FIELD_CUSTODY,
  REPO_COMMITTABLE_CLASSES,
  classifyCommittedMarker,
  collectCommittedMarkerFieldPaths,
} from "../src/promotion/marker-custody-map.mjs";

// ---------------------------------------------------------------------------
// B-CUSTODY: the custody fixture.
//
// The PR marker (`agentic_factory_promotion`) is COMMITTED into the repo (the PR
// body). The 0B custody contract
// (`maintainers/contracts/authority-custody-defaults.md`) says only redacted,
// repo-recordable facts may be committed. This fixture READS the machine-readable
// field->class map (`marker-custody-map.mjs`, the single source) rather than
// re-deciding per field, and asserts every field a built marker commits is
// repo-recordable (or the more-permissive exportable). A NEW committed field
// added later without a class entry fails the exhaustiveness assertion; a field
// classified as never-capture/local-only/inference-transient fails the leak
// assertion.
// ---------------------------------------------------------------------------

// Build a FULL marker that exercises every committed field — top-level + the
// nested `phoenix_scope`, `evidence_ids`, `packet`, plus the conditional
// `undo_bounds`, `merged_accepted_ref`, and `advisories` — so the fixture covers
// the whole marker shape, not just the always-present fields.
function fullCommittedMarker() {
  const humanSummary = {
    kind: "prompt",
    old_pinned_version_id: "pv-old",
    new_pinned_version_id: "pv-new",
    old_snapshot_sha256_12: "111111111111",
    new_snapshot_sha256_12: "222222222222",
  };
  const changedArtifacts = [{ kind: "accepted_prompt", new_sha256: "c".repeat(64) }];
  const wrapped = buildPromotionMarker({
    proposalInstanceId: "prop-custody0001",
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
    candidateKind: "prompt",
    candidateVersionId: "pv-new",
    acceptedBaselineId: "pv-old",
    normalizedEnvelopeHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    phoenixScope: {
      origin: "http://127.0.0.1:6006",
      project_name: "agentic-factory",
    },
    evidenceIds: {
      experiments: ["EXP1"],
      datasets: [{ dataset_id: "DS1", dataset_version_id: "DSV1" }],
      annotations: ["anno-1"],
    },
    acceptCrossVersionComparison: true,
    proposalState: "proposed",
    supersededBy: "prop-prior0001",
    repairState: "none",
    undoBounds: buildMarkerUndoBounds({ humanSummary, candidateKind: "prompt" }),
    mergedAcceptedRef: buildMergedAcceptedRef({
      candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
      humanSummary,
      changedArtifacts,
    }),
    // A demoted-view advisory (records when a factory class was demoted): a real
    // committed-marker shape produced via the same helper the run path uses. A
    // `meta_change` class whose only backing reason is in the advisory-only
    // allowlist demotes to an advisory (vs. gating).
    advisories: markerAdvisoriesFor({
      class: "meta_change",
      reasons: [{
        id: "protected_path_meta_change",
        class: "meta_change",
        path: "maintainers/contracts/meta-change-classifier-contract.md",
        surface: "protected_path_map",
      }],
    }),
  });
  return wrapped;
}

test("B-CUSTODY: the field->class map is exhaustive over every committed marker field", () => {
  const marker = fullCommittedMarker();
  const { unmapped } = classifyCommittedMarker(marker);
  assert.deepEqual(
    unmapped,
    [],
    `every committed marker field must have a custody class in marker-custody-map.mjs. `
    + `Unmapped (a NEW committed field with no custody class — classify it before it ships): `
    + `${unmapped.join(", ")}`,
  );
});

test("B-CUSTODY: every map entry has a known custody class", () => {
  const known = new Set(Object.values(CUSTODY_CLASSES));
  for (const [path, entry] of Object.entries(MARKER_FIELD_CUSTODY)) {
    assert.ok(
      known.has(entry.class),
      `field ${path} has unknown custody class ${entry.class}`,
    );
    assert.ok(
      typeof entry.why === "string" && entry.why.length > 0,
      `field ${path} must record WHY it has its custody class`,
    );
  }
});

// The CORE custody assertion. Reads the map (does not re-decide) and asserts no
// committed marker field carries a non-repo-committable class
// (never-capture/local-only/inference-transient/phoenix-recordable/
// broker-audit-recordable). A red here is a real custody finding to surface, NOT
// a test to force green.
test("B-CUSTODY: no committed marker field leaks a non-repo-recordable handle", () => {
  const marker = fullCommittedMarker();
  const { leaks } = classifyCommittedMarker(marker);
  assert.deepEqual(
    leaks,
    [],
    `the committed PR marker must carry only repo-recordable facts. Leaked field(s) whose `
    + `custody class is more restrictive than repo-recordable (a leak to fix or a class to ratify): `
    + `${leaks.map((l) => `${l.path} [${l.class}] — ${l.why}`).join(" | ")}`,
  );
});

// Mechanism proof (the fixture catches a leak). A committed field the map
// classifies as local-only must be caught by the leak check — so a future field
// added as a raw local handle cannot pass silently. Uses a SYNTHETIC probe map +
// field so the proof stays valid independent of any real field's classification.
test("B-CUSTODY: the leak check catches a non-repo-recordable field (mechanism proof)", () => {
  const probeMap = {
    synthetic_local_handle: { class: CUSTODY_CLASSES.LOCAL_ONLY, why: "synthetic local handle for the mechanism proof" },
  };
  const probe = classifyCommittedMarker(
    { agentic_factory_promotion: { schema_version: 1, synthetic_local_handle: "x" } },
    probeMap,
  );
  const leak = probe.leaks.find((l) => l.path === "synthetic_local_handle");
  assert.ok(
    leak && leak.class === CUSTODY_CLASSES.LOCAL_ONLY,
    "the leak check must flag a local-only committed field via the map",
  );
});

// Mechanism proof (the fixture catches a new, unclassified committed field). A
// marker carrying a field with NO map entry must register as unmapped — so a new
// committed field can never ship without an explicit custody class.
test("B-CUSTODY: the exhaustiveness check catches a new unmapped committed field (mechanism proof)", () => {
  const probe = classifyCommittedMarker({
    agentic_factory_promotion: {
      schema_version: 1,
      brand_new_committed_field: "anything",
    },
  });
  assert.ok(
    probe.unmapped.includes("brand_new_committed_field"),
    "a committed field with no custody class must surface as unmapped",
  );
});

// Deep-walk negative fixture (the FIXTURE-NESTED-ESCAPE finding). A raw local
// handle nested on an `evidence_ids.datasets[]` element (the marker shallow-copies
// dataset element objects and the validator permits extra keys, so this is a real
// escape vector) must be caught as a LEAK against a map that classifies the nested
// leaf as local-only. Before the deep walk, the walker stopped at the
// `evidence_ids.datasets` carrier and this handle rode along invisibly.
test("B-CUSTODY: a nested local-only handle on a datasets[] element is caught as a leak", () => {
  const probeMap = {
    "evidence_ids.datasets[].dataset_id": { class: CUSTODY_CLASSES.REPO_RECORDABLE, why: "id" },
    "evidence_ids.datasets[].local_path": {
      class: CUSTODY_CLASSES.LOCAL_ONLY,
      why: "synthetic raw local path smuggled onto a dataset element for the deep-walk proof",
    },
  };
  const probe = classifyCommittedMarker(
    {
      agentic_factory_promotion: {
        schema_version: 1,
        evidence_ids: {
          datasets: [{ dataset_id: "DS1", local_path: "<local-trace-path>" }],
        },
      },
    },
    probeMap,
  );
  const leak = probe.leaks.find((l) => l.path === "evidence_ids.datasets[].local_path");
  assert.ok(
    leak && leak.class === CUSTODY_CLASSES.LOCAL_ONLY,
    "a local-only handle nested on a datasets[] element must surface as a leak via the deep walk",
  );
});

// Deep-walk negative fixture: a NEW field nested anywhere (here on a `datasets[]`
// element, but equally `advisories.raw_handle`) that has NO map entry must surface
// as unmapped — so a future nested committed field cannot ship without an explicit
// custody class, no matter how deep it is buried.
test("B-CUSTODY: a new unmapped nested field is caught as unmapped (deep walk)", () => {
  const probe = classifyCommittedMarker({
    agentic_factory_promotion: {
      schema_version: 1,
      evidence_ids: {
        datasets: [{ dataset_id: "DS1", brand_new_nested_field: "anything" }],
      },
      advisories: { raw_handle: "anything" },
    },
  });
  assert.ok(
    probe.unmapped.includes("evidence_ids.datasets[].brand_new_nested_field"),
    "a new committed field nested on a datasets[] element must surface as unmapped",
  );
  assert.ok(
    probe.unmapped.includes("advisories.raw_handle"),
    "a new committed field nested in advisories must surface as unmapped",
  );
});

// Negative custody fixture (required by the 0B "Redaction Before Storage" rule):
// token-shaped / secret-looking values must never reach the committed marker. The
// real build path never puts these on the marker; this guards against a
// regression that does.
test("B-CUSTODY: no never-capture token-shaped value appears in the committed marker", () => {
  const serialized = JSON.stringify(fullCommittedMarker());
  const forbidden = [
    ["lin_oauth_", "abcdefghijkl"].join(""),
    ["ghs_", "abcdefghijklmnop"].join(""),
    ["af_broker_", "credential_value"].join(""),
    ["sk-", "abcdefghijklmnop"].join(""),
    ["https://token:", "secret-value@", "example.invalid/path"].join(""),
    "Ignore previous instructions",
  ];
  for (const value of forbidden) {
    assert.equal(
      serialized.includes(value),
      false,
      `never-capture value must not appear in the committed marker: ${value}`,
    );
  }
});

// Sanity: the walker DEEP-WALKS to leaves — nested objects descend, arrays of
// scalars report at their field, and arrays of objects descend per element under
// a `[]` wildcard (so a handle on a `datasets[]` / `advisory_reasons[]` element
// surfaces on its own and must be classified).
test("B-CUSTODY: the field-path walker reports committed leaves at the map's granularity", () => {
  const paths = collectCommittedMarkerFieldPaths(fullCommittedMarker());
  for (const expected of [
    "schema_version",
    "candidate_target_key",
    "phoenix_scope.origin",
    "phoenix_scope.project_name",
    // arrays of scalars: reported at the array field (elements share one class)
    "evidence_ids.experiments",
    "evidence_ids.annotations",
    // array of objects: descended per element to the element's scalar leaves
    "evidence_ids.datasets[].dataset_id",
    "evidence_ids.datasets[].dataset_version_id",
    "packet.deterministic_risk_floor",
    "undo_bounds.what_undo_changes",
    "merged_accepted_ref.snapshot_sha256",
    // advisories is now DEEP-WALKED to its leaves, not classified as a whole
    "advisories.schema_version",
    "advisories.advisory_only_classes",
    "advisories.advisory_reasons[].id",
    "advisories.advisory_reasons[].surface",
  ]) {
    assert.ok(paths.includes(expected), `walker must report committed leaf: ${expected}`);
  }
  // The walker must NOT stop at the nested-object/array carrier — the whole point
  // of the deep walk is that no committed leaf hides under a parent. A bare
  // `evidence_ids.datasets` / `advisories` carrier would mean a nested handle
  // could ride along unclassified.
  assert.equal(
    paths.includes("evidence_ids.datasets"),
    false,
    "datasets is an array of objects; the walker must descend to its element leaves, not stop at the carrier",
  );
  assert.equal(
    paths.includes("advisories"),
    false,
    "advisories is deep-walked; the walker must descend to its leaves, not stop at the whole object",
  );
  // REPO_COMMITTABLE_CLASSES is the committable set the leak check uses.
  assert.ok(REPO_COMMITTABLE_CLASSES.has(CUSTODY_CLASSES.REPO_RECORDABLE));
  assert.ok(REPO_COMMITTABLE_CLASSES.has(CUSTODY_CLASSES.EXPORTABLE));
});
