import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
  acceptedRefFromLoadedSnapshot,
  createRunRecorder,
} from "../../../engine/run-accepted-refs.mjs";
import { loadAcceptedPromptSnapshot } from "../../../engine/accepted-prompt-snapshot.mjs";
import { createOrchestratorRoster, ORCHESTRATOR_GOVERNING_TARGET_KEY } from "../src/orchestrator-roster.mjs";
import { adopterSelfImprovementPersonaBinding } from "../src/promotion/agent-behavior-scope.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const PM_SYNTHESIS_KEY = "prompt/decomposition/pm_synthesis";
const SR_ENG_GROUNDING_KEY = "prompt/decomposition/sr_eng_grounding_pass";

function loadSnapshot(targetKey) {
  return loadAcceptedPromptSnapshot({ targetKey });
}

test("acceptedRefFromLoadedSnapshot builds the normalized ref from a loaded snapshot (moved + exported)", () => {
  const snapshot = loadSnapshot(PM_SYNTHESIS_KEY);
  const ref = acceptedRefFromLoadedSnapshot(PM_SYNTHESIS_KEY, snapshot);
  assert.equal(ref.target_key, PM_SYNTHESIS_KEY);
  assert.equal(ref.snapshot_sha256, snapshot.snapshotSha256);
  // unpinned-initial entries have null accepted_prompt_version_id ⇒ sha256: form.
  assert.equal(ref.accepted_baseline_id, `sha256:${snapshot.snapshotSha256}`);
  // A snapshot with no sha ⇒ null (degrade, do not throw).
  assert.equal(acceptedRefFromLoadedSnapshot(PM_SYNTHESIS_KEY, {}), null);
});

test("recordLibraryLoad captures a ref from a real loaded snapshot and dedups by target_key (first-captured wins)", () => {
  const recorder = createRunRecorder({});
  const first = loadSnapshot(PM_SYNTHESIS_KEY);
  recorder.recordLibraryLoad({ target_key: PM_SYNTHESIS_KEY, snapshot: first });
  // A second load of the SAME target must not overwrite the first capture.
  recorder.recordLibraryLoad({ target_key: PM_SYNTHESIS_KEY, snapshot: first });
  recorder.recordLibraryLoad({ target_key: SR_ENG_GROUNDING_KEY, snapshot: loadSnapshot(SR_ENG_GROUNDING_KEY) });

  const refs = recorder.collectRefs();
  assert.deepEqual(refs.map((r) => r.target_key), [PM_SYNTHESIS_KEY, SR_ENG_GROUNDING_KEY]);
  assert.equal(refs[0].snapshot_sha256, first.snapshotSha256);
});

test("recordExecutedRuntimeRole accumulates executed roles for the runtime-defaults rule", () => {
  const config = {
    workflows: { decomposition: { role_field_sources: { pm: { runtime: "accepted_defaults" } } } },
  };
  const recorder = createRunRecorder({ config });
  // No executed roles yet ⇒ the runtime-defaults rule is NOT recorded.
  assert.deepEqual(recorder.collectRefs(), []);

  recorder.recordExecutedRuntimeRole("pm");
  const refs = recorder.collectRefs();
  // An executed role consumed accepted defaults ⇒ the rule ref is appended.
  assert.deepEqual(refs.map((r) => r.target_key), [RUNTIME_ROLE_DEFAULTS_TARGET_KEY]);
});

test("recordExecutedRuntimeRole records the orchestrator's own role (a tunable role like pm/sr_eng)", () => {
  // The orchestrator runtime is now a tunable role; its default-consumption is
  // captured exactly like pm/sr_eng's. A run where the 'orchestrator' role
  // resolved from accepted defaults records the runtime-defaults rule.
  const config = {
    workflows: { decomposition: { role_field_sources: { orchestrator: { model: "accepted_defaults" } } } },
  };
  const recorder = createRunRecorder({ config });
  recorder.recordExecutedRuntimeRole("orchestrator");
  assert.deepEqual(
    recorder.collectRefs().map((r) => r.target_key),
    [RUNTIME_ROLE_DEFAULTS_TARGET_KEY],
  );
});

test("driver prompt and runtime refs stay physically separate but share the driver persona binding", () => {
  const recorder = createRunRecorder({
    config: {
      workflows: {
        decomposition: {
          role_field_sources: { orchestrator: { model: "accepted_defaults" } },
        },
      },
    },
  });
  recorder.recordGoverningLoad({
    target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
    snapshot: loadSnapshot(ORCHESTRATOR_GOVERNING_TARGET_KEY),
  });
  recorder.recordExecutedRuntimeRole(decompositionDefinition.driver);

  const refs = recorder.collectRefs();
  assert.deepEqual(refs.map((ref) => ref.target_key), [
    ORCHESTRATOR_GOVERNING_TARGET_KEY,
    RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
  ]);

  const promptBinding = adopterSelfImprovementPersonaBinding({
    role: decompositionDefinition.driver,
    target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
    artifact_kind: "accepted_prompt",
    materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    snapshot_path: "execution/evals/decomposition/accepted-prompts/orchestrator-governing.md",
  });
  const runtimeBinding = adopterSelfImprovementPersonaBinding({
    role: decompositionDefinition.driver,
    target_key: RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
    artifact_kind: "runtime_role_defaults",
    materializer: "eval_variant_to_runtime_role_defaults",
    artifact_path: "execution/evals/decomposition/accepted-runtime-roles.json",
  });
  assert.equal(promptBinding.persona_kind, "driver");
  assert.equal(runtimeBinding.persona_kind, "driver");
  assert.equal(promptBinding.persona_role, runtimeBinding.persona_role);
});

test("recordGoverningLoad captures the governing prompt ref for undo-safety", () => {
  const recorder = createRunRecorder({});
  const snapshot = loadSnapshot(ORCHESTRATOR_GOVERNING_TARGET_KEY);
  recorder.recordGoverningLoad({ target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY, snapshot });

  const refs = recorder.collectRefs();
  assert.deepEqual(refs.map((r) => r.target_key), [ORCHESTRATOR_GOVERNING_TARGET_KEY]);
  assert.equal(refs[0].snapshot_sha256, snapshot.snapshotSha256);
});

test("recordGoverningLoad is captured even on a one-off-only run (no library loads)", () => {
  // The governing prompt must be in the ledger regardless of which subagents
  // ran — it is loaded through the recorder at run-start.
  const recorder = createRunRecorder({});
  recorder.recordGoverningLoad({
    target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
    snapshot: loadSnapshot(ORCHESTRATOR_GOVERNING_TARGET_KEY),
  });
  recorder.recordExecutedRuntimeRole("pm"); // a one-off ran on the pm runtime
  const refs = recorder.collectRefs();
  assert.ok(refs.some((r) => r.target_key === ORCHESTRATOR_GOVERNING_TARGET_KEY));
});

test("recordJudgeRef (wired-or-stub for I-3) joins the captured set, deduped by target_key", () => {
  const recorder = createRunRecorder({});
  const judgeKey = "prompt/decomposition/decomposition_quality_judge";
  recorder.recordJudgeRef({ target_key: judgeKey, snapshotSha256: "abc123" });
  // Missing/empty inputs are no-ops (degrade, do not throw).
  recorder.recordJudgeRef({});
  recorder.recordJudgeRef({ target_key: judgeKey, snapshotSha256: "" });

  const refs = recorder.collectRefs();
  assert.deepEqual(refs.map((r) => r.target_key), [judgeKey]);
  assert.equal(refs[0].snapshot_sha256, "abc123");
  assert.equal(refs[0].accepted_baseline_id, "sha256:abc123");
});

test("collectRefs combines library, governing, runtime-defaults, and accepts a per-call config override", () => {
  const recorder = createRunRecorder({});
  recorder.recordGoverningLoad({
    target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
    snapshot: loadSnapshot(ORCHESTRATOR_GOVERNING_TARGET_KEY),
  });
  recorder.recordLibraryLoad({ target_key: PM_SYNTHESIS_KEY, snapshot: loadSnapshot(PM_SYNTHESIS_KEY) });
  recorder.recordExecutedRuntimeRole("sr_eng");

  // Config supplied at collectRefs() time (the per-call override wins).
  const refs = recorder.collectRefs({
    config: {
      workflows: { decomposition: { role_field_sources: { sr_eng: { model: "accepted_defaults" } } } },
    },
  });
  const keys = refs.map((r) => r.target_key);
  assert.ok(keys.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY));
  assert.ok(keys.includes(PM_SYNTHESIS_KEY));
  assert.ok(keys.includes(RUNTIME_ROLE_DEFAULTS_TARGET_KEY));
});

test("createRunRecorder is reusable: a wired roster load feeds recordLibraryLoad from one snapshot load", () => {
  // Mirrors the I-2b loop join: resolve via the roster, load once, record once.
  const roster = createOrchestratorRoster();
  const recorder = createRunRecorder({});
  const resolved = roster.resolve(PM_SYNTHESIS_KEY);
  const snapshot = resolved.loadSnapshot();
  recorder.recordLibraryLoad({ target_key: PM_SYNTHESIS_KEY, snapshot });
  recorder.recordExecutedRuntimeRole(resolved.runtime_role);
  assert.deepEqual(recorder.collectRefs().map((r) => r.target_key), [PM_SYNTHESIS_KEY]);
});
