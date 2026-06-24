import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
  collectRunAcceptedRefs,
  consumedAcceptedRoleDefaults,
  normalizeAcceptedRef,
  resolveAcceptedRefForTarget,
  unjoinableCoverageMarker,
} from "../../../engine/run-accepted-refs.mjs";
import { resolveAcceptedBaseline } from "../src/promotion-scanner/accepted-baseline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("normalizeAcceptedRef adapts a prompt resolution into the S-REFS entry shape", () => {
  const ref = normalizeAcceptedRef("prompt/decomposition/pm_synthesis", {
    ok: true,
    accepted_baseline_id: "sha256:deadbeef",
    accepted_artifact_hash_vector: { snapshot_sha256: "deadbeef" },
  });
  assert.deepEqual(ref, {
    target_key: "prompt/decomposition/pm_synthesis",
    accepted_baseline_id: "sha256:deadbeef",
    snapshot_sha256: "deadbeef",
  });
});

test("normalizeAcceptedRef returns null for a failed resolution", () => {
  assert.equal(normalizeAcceptedRef("prompt/x", { ok: false, reason: "nope" }), null);
  assert.equal(normalizeAcceptedRef("prompt/x", null), null);
});

test("normalizeAcceptedRef defaults missing hash-vector fields to null", () => {
  const ref = normalizeAcceptedRef("rule/decomposition/runtime_role_assignments", {
    ok: true,
    accepted_baseline_id: "sha256:abc",
    // no accepted_artifact_hash_vector
  });
  assert.deepEqual(ref, {
    target_key: "rule/decomposition/runtime_role_assignments",
    accepted_baseline_id: "sha256:abc",
    snapshot_sha256: null,
  });
});

test("resolveAcceptedRefForTarget resolves a real pinned prompt target against phoenix-assets", () => {
  const ref = resolveAcceptedRefForTarget({
    targetKey: "prompt/decomposition/pm_synthesis",
    repoRoot,
    resolveAcceptedBaseline,
  });
  assert.equal(ref.target_key, "prompt/decomposition/pm_synthesis");
  assert.equal(typeof ref.accepted_baseline_id, "string");
  assert.equal(typeof ref.snapshot_sha256, "string");
});

test("resolveAcceptedRefForTarget resolves the runtime-defaults rule target", () => {
  const ref = resolveAcceptedRefForTarget({
    targetKey: RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
    repoRoot,
    resolveAcceptedBaseline,
  });
  assert.equal(ref.target_key, RUNTIME_ROLE_DEFAULTS_TARGET_KEY);
  assert.match(ref.accepted_baseline_id, /^sha256:/);
});

test("resolveAcceptedRefForTarget returns null for an unavailable target", () => {
  assert.equal(
    resolveAcceptedRefForTarget({
      targetKey: "prompt/decomposition/does_not_exist",
      repoRoot,
      resolveAcceptedBaseline,
    }),
    null,
  );
  assert.equal(resolveAcceptedRefForTarget({ targetKey: "", repoRoot, resolveAcceptedBaseline }), null);
});

test("consumedAcceptedRoleDefaults is true only when a role field came from accepted defaults", () => {
  assert.equal(consumedAcceptedRoleDefaults(null), false);
  assert.equal(
    consumedAcceptedRoleDefaults({
      workflows: { decomposition: { role_field_sources: { pm: { runtime: "adopter_config", model: "adopter_config" } } } },
    }),
    false,
  );
  assert.equal(
    consumedAcceptedRoleDefaults({
      workflows: { decomposition: { role_field_sources: { pm: { runtime: "accepted_defaults", model: "adopter_config" } } } },
    }),
    true,
  );
});

test("consumedAcceptedRoleDefaults gates on EXECUTED roles: an unexecuted role's defaults are NOT counted", () => {
  // Only `drafter` (never run by the decomposition phase loop) resolved from
  // accepted defaults; the executed pm/sr_eng roles came from adopter config.
  const config = {
    workflows: {
      decomposition: {
        role_field_sources: {
          pm: { runtime: "adopter_config", model: "adopter_config" },
          sr_eng: { runtime: "adopter_config", model: "adopter_config" },
          drafter: { runtime: "accepted_defaults", model: "adopter_config" },
        },
      },
    },
  };
  // Gated on the roles that actually ran ⇒ the drafter default is not consumed.
  assert.equal(consumedAcceptedRoleDefaults(config, ["pm", "sr_eng"]), false);
  assert.equal(consumedAcceptedRoleDefaults(config, new Set(["pm", "sr_eng"])), false);
  // An EXECUTED role on accepted defaults IS counted.
  assert.equal(consumedAcceptedRoleDefaults(config, ["pm", "sr_eng", "drafter"]), true);
  // No executed roles ⇒ conservative: nothing consumed.
  assert.equal(consumedAcceptedRoleDefaults(config, []), false);
  // Legacy callers (no executedRoles arg) scan all roles ⇒ drafter counts.
  assert.equal(consumedAcceptedRoleDefaults(config), true);
});

test("collectRunAcceptedRefs dedupes captured phase refs and omits the rule when no defaults were consumed", () => {
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [
      { target_key: "prompt/decomposition/pm_product_sufficiency_pass", accepted_baseline_id: "PV-a", snapshot_sha256: "aaa" },
      { target_key: "prompt/decomposition/pm_product_sufficiency_pass", accepted_baseline_id: "PV-a", snapshot_sha256: "aaa" },
      { target_key: "prompt/decomposition/pm_synthesis", accepted_baseline_id: "PV-b", snapshot_sha256: "bbb" },
    ],
    config: { workflows: { decomposition: { role_field_sources: { pm: { runtime: "adopter_config" } } } } },
    executedRoles: ["pm", "sr_eng"],
  });
  assert.deepEqual(refs.map((ref) => ref.target_key), [
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/pm_synthesis",
  ]);
  // The captured refs are recorded VERBATIM (capture-at-load), not re-derived.
  assert.equal(refs[0].accepted_baseline_id, "PV-a");
  assert.equal(refs[0].snapshot_sha256, "aaa");
});

test("collectRunAcceptedRefs appends the CAPTURED-AT-LOAD runtime-defaults ref from the config stash", () => {
  // config.mjs stashes `accepted_runtime_defaults_ref` at config load — the
  // version the run actually read — so collectRunAcceptedRefs records THAT, not
  // a finalize-time re-resolve against a possibly-newer manifest.
  const stashed = {
    target_key: RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
    accepted_baseline_id: "sha256:loadtime",
    snapshot_sha256: "loadtime",
  };
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [
      { target_key: "prompt/decomposition/pm_synthesis", accepted_baseline_id: "PV-b", snapshot_sha256: "bbb" },
    ],
    config: {
      workflows: {
        decomposition: {
          role_field_sources: { sr_eng: { model: "accepted_defaults" } },
          accepted_runtime_defaults_ref: stashed,
        },
      },
    },
    executedRoles: ["pm", "sr_eng"],
  });
  assert.deepEqual(refs.map((ref) => ref.target_key), [
    "prompt/decomposition/pm_synthesis",
    RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
  ]);
  // The stashed, load-time ref is recorded verbatim — joinable, not a marker.
  assert.deepEqual(refs[1], stashed);
});

test("collectRunAcceptedRefs records an UNJOINABLE coverage marker when defaults were consumed but no load-time ref was captured", () => {
  // An EXECUTED role used accepted defaults but the config carries no captured
  // ref (resolution failed at load). The run still records it TOUCHED the
  // runtime-defaults target — at an unknown version — so B-READ degrades to
  // `unknown` rather than dropping the signal (a possible false not_used) or
  // guessing the current version (the mid-run-merge race).
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [
      { target_key: "prompt/decomposition/pm_synthesis", accepted_baseline_id: "PV-b", snapshot_sha256: "bbb" },
    ],
    config: { workflows: { decomposition: { role_field_sources: { sr_eng: { model: "accepted_defaults" } } } } },
    executedRoles: ["pm", "sr_eng"],
  });
  assert.deepEqual(refs.map((ref) => ref.target_key), [
    "prompt/decomposition/pm_synthesis",
    RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
  ]);
  // The marker is unjoinable: target present, both version identifiers null.
  assert.deepEqual(refs[1], unjoinableCoverageMarker(RUNTIME_ROLE_DEFAULTS_TARGET_KEY));
  assert.equal(refs[1].accepted_baseline_id, null);
  assert.equal(refs[1].snapshot_sha256, null);
});

test("collectRunAcceptedRefs ignores a stash for the wrong target and records the marker", () => {
  // A stash that is not a joinable ref FOR the runtime-defaults target must not
  // be trusted; the run falls back to the unjoinable marker.
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [],
    config: {
      workflows: {
        decomposition: {
          role_field_sources: { sr_eng: { model: "accepted_defaults" } },
          accepted_runtime_defaults_ref: {
            target_key: "rule/decomposition/something_else",
            accepted_baseline_id: "x",
            snapshot_sha256: "y",
          },
        },
      },
    },
    executedRoles: ["sr_eng"],
  });
  assert.deepEqual(refs, [unjoinableCoverageMarker(RUNTIME_ROLE_DEFAULTS_TARGET_KEY)]);
});

test("collectRunAcceptedRefs does NOT append the runtime-defaults rule for an unexecuted role's defaults", () => {
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [
      { target_key: "prompt/decomposition/pm_synthesis", accepted_baseline_id: "PV-b", snapshot_sha256: "bbb" },
    ],
    // Only the never-run `drafter` role resolved from accepted defaults.
    config: { workflows: { decomposition: { role_field_sources: { drafter: { model: "accepted_defaults" } } } } },
    executedRoles: ["pm", "sr_eng"],
  });
  assert.deepEqual(refs.map((ref) => ref.target_key), ["prompt/decomposition/pm_synthesis"]);
});

test("collectRunAcceptedRefs skips malformed captured refs", () => {
  const refs = collectRunAcceptedRefs({
    capturedPhaseRefs: [
      null,
      { target_key: "" },
      { target_key: "prompt/decomposition/pm_synthesis", accepted_baseline_id: "PV-b", snapshot_sha256: "bbb" },
    ],
    config: null,
    executedRoles: ["pm"],
  });
  assert.deepEqual(refs.map((ref) => ref.target_key), ["prompt/decomposition/pm_synthesis"]);
});
