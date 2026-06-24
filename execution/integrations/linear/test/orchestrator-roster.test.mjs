import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createOrchestratorRoster,
  ORCHESTRATOR_GOVERNING_TARGET_KEY,
} from "../src/orchestrator-roster.mjs";
import {
  adopterSelfImprovementPersonaBinding,
  isAdopterSelfImprovementTarget,
  isDriverSelfImprovementTarget,
} from "../src/promotion/agent-behavior-scope.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..", "..");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "execution",
  "evals",
  "decomposition",
  "phoenix-assets.json",
);

const JUDGE_TARGET_KEY = "prompt/decomposition/decomposition_quality_judge";
const PM_TARGET_KEY = "prompt/decomposition/pm_product_sufficiency_pass";

function readRealManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

// A governing-shaped accepted_prompt entry, identical in SHAPE to a normal
// adopter-tunable prompt entry. The governing entry is NOT yet in the real
// manifest (I-2a adds it later), so the roster-exclusion + tunability tests use
// this synthetic fixture. snapshot_path points at an existing snapshot only so
// the shape predicates (which require a non-empty snapshot_path string) hold;
// the roster never loads it because it is roster-excluded.
function governingManifestEntry() {
  return {
    role: "orchestrator",
    target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
    human_name: "Orchestrator governing prompt",
    artifact_kind: "accepted_prompt",
    materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    accepted_tag: "agentic_factory_accepted",
    candidate_tag: "agentic_factory_promotion_candidate",
    snapshot_path:
      "execution/evals/decomposition/accepted-prompts/orchestrator-governing.md",
    snapshot_sha256: "0".repeat(64),
    prompt_version: "unpinned-initial",
  };
}

test("roster selectableTargets are manifest-derived (not a hardcoded list)", () => {
  const realManifest = readRealManifest();
  const realRoster = createOrchestratorRoster({ manifest: realManifest });

  // Derive the expectation FROM the manifest the same way the resolver must:
  // every prompt/... accepted_prompt entry, minus the judge AND minus the
  // orchestrator governing prompt. Both are non-selectable by identity. The
  // governing entry is not in today's real manifest but I-2a adds it; excluding
  // it here keeps this test correct across that change without a rewrite.
  const expectedSelectable = realManifest.prompts
    .filter(
      (entry) =>
        typeof entry.target_key === "string"
        && entry.target_key.startsWith("prompt/")
        && entry.artifact_kind === "accepted_prompt"
        && entry.materializer
          === "phoenix_prompt_version_to_accepted_prompt_snapshot"
        && entry.target_key !== JUDGE_TARGET_KEY
        && entry.target_key !== ORCHESTRATOR_GOVERNING_TARGET_KEY,
    )
    .map((entry) => entry.target_key);

  assert.deepEqual(
    [...realRoster.selectableTargets].sort(),
    [...expectedSelectable].sort(),
  );
  // The current manifest yields the 4 pm/sr_eng selectable prompts.
  assert.equal(realRoster.selectableTargets.length, 4);

  // Manifest-derived, not hardcoded: drop one prompt from an injected manifest
  // and the roster must shrink accordingly.
  const trimmedManifest = {
    ...realManifest,
    prompts: realManifest.prompts.filter(
      (entry) => entry.target_key !== PM_TARGET_KEY,
    ),
  };
  const trimmedRoster = createOrchestratorRoster({ manifest: trimmedManifest });
  assert.ok(!trimmedRoster.selectableTargets.includes(PM_TARGET_KEY));
  assert.equal(
    trimmedRoster.selectableTargets.length,
    realRoster.selectableTargets.length - 1,
  );
});

test("the judge target_key is excluded from selectableTargets", () => {
  const roster = createOrchestratorRoster({ manifest: readRealManifest() });
  assert.ok(!roster.selectableTargets.includes(JUDGE_TARGET_KEY));
  // Defense in depth: also excluded when matched by aggregate role name.
  const roleJudgeManifest = {
    prompts: [
      {
        role: "judge",
        target_key: "prompt/decomposition/some_other_judge",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        snapshot_path: "execution/evals/decomposition/accepted-prompts/x.md",
      },
    ],
  };
  const roleJudgeRoster = createOrchestratorRoster({ manifest: roleJudgeManifest });
  assert.deepEqual(roleJudgeRoster.selectableTargets, []);
});

test("the governing target_key is excluded from selectableTargets", () => {
  const realManifest = readRealManifest();
  const manifestWithGoverning = {
    ...realManifest,
    prompts: [...realManifest.prompts, governingManifestEntry()],
  };
  const roster = createOrchestratorRoster({ manifest: manifestWithGoverning });

  assert.ok(
    !roster.selectableTargets.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY),
    "governing prompt must be roster-excluded by identity",
  );
  // Adding the governing entry must NOT change the selectable set vs the real
  // manifest (4 pm/sr_eng), i.e. governing is excluded, judge stays excluded.
  assert.equal(roster.selectableTargets.length, 4);
});

test("the governing prompt is tunable-but-roster-excluded", () => {
  const governing = governingManifestEntry();

  // Tunable: isAdopterSelfImprovementTarget keys off shape and excludes only the
  // judge, so the governing prompt (a normal prompt/... entry) is adopter-tunable.
  assert.equal(
    isAdopterSelfImprovementTarget(governing),
    true,
    "governing prompt must be adopter-tunable",
  );
  assert.equal(isDriverSelfImprovementTarget(governing), true);
  assert.deepEqual(
    {
      persona_kind: adopterSelfImprovementPersonaBinding(governing).persona_kind,
      persona_role: adopterSelfImprovementPersonaBinding(governing).persona_role,
      facet: adopterSelfImprovementPersonaBinding(governing).facet,
    },
    { persona_kind: "driver", persona_role: "orchestrator", facet: "prompt" },
  );

  // Roster-excluded: absent from the subagent roster.
  const realManifest = readRealManifest();
  const roster = createOrchestratorRoster({
    manifest: {
      ...realManifest,
      prompts: [...realManifest.prompts, governing],
    },
  });
  assert.ok(
    !roster.selectableTargets.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY),
    "governing prompt must be roster-excluded while tunable",
  );
});

test("resolve() returns runtime_role + a working loadSnapshot() for a selectable target", () => {
  // Use the REAL manifest (no injection) so loadSnapshot() exercises the real
  // verified-snapshot load path end-to-end.
  const roster = createOrchestratorRoster();
  assert.ok(roster.selectableTargets.includes(PM_TARGET_KEY));

  const resolved = roster.resolve(PM_TARGET_KEY);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.runtime_role, "pm");
  assert.equal(typeof resolved.loadSnapshot, "function");

  // loadSnapshot() returns the FULL verified snapshot; the prompt body is its
  // contentBytes (a superset of the body, so the recorder can build its ref from
  // the same single load — see Seam 3).
  const snapshot = resolved.loadSnapshot();
  assert.equal(typeof snapshot, "object");
  assert.equal(typeof snapshot.contentBytes, "string");
  assert.ok(
    snapshot.contentBytes.length > 0,
    "loadSnapshot().contentBytes must return the prompt body text",
  );
});

test("resolve() rejects the judge and an unknown key", () => {
  const roster = createOrchestratorRoster();

  const judge = roster.resolve(JUDGE_TARGET_KEY);
  assert.equal(judge.ok, false);
  assert.equal(typeof judge.reason, "string");
  assert.ok(judge.reason.length > 0);

  const unknown = roster.resolve("prompt/decomposition/does_not_exist");
  assert.equal(unknown.ok, false);
  assert.equal(typeof unknown.reason, "string");

  // The governing prompt also rejects (roster-excluded) even when present.
  const realManifest = readRealManifest();
  const rosterWithGoverning = createOrchestratorRoster({
    manifest: {
      ...realManifest,
      prompts: [...realManifest.prompts, governingManifestEntry()],
    },
  });
  const governing = rosterWithGoverning.resolve(ORCHESTRATOR_GOVERNING_TARGET_KEY);
  assert.equal(governing.ok, false);
});
