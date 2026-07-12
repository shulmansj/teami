import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createOrchestratorRoster,
  ORCHESTRATOR_GOVERNING_TARGET_KEY,
} from "../src/orchestrator-roster.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { resolveInvocableRuntimeRoles } from "../src/runtime-adapters.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..", "..");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "execution",
  "evals",
  "decomposition",
  "phoenix-assets.json",
);
const DEFINITION_PATH = path.join(
  REPO_ROOT,
  "execution",
  "integrations",
  "linear",
  "src",
  "workflows",
  "decomposition",
  "definition.mjs",
);

const JUDGE_TARGET_KEY = "prompt/decomposition/decomposition_quality_judge";
const EXPECTED_SELECTABLE_TARGET_KEYS = Object.freeze([
  "prompt/decomposition/pm_product_sufficiency_pass",
  "prompt/decomposition/sr_eng_grounding_pass",
  "prompt/decomposition/pm_synthesis",
  "prompt/decomposition/sr_eng_blocker_check",
]);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function sorted(values) {
  return [...values].sort();
}

function manifestPromptTargetKeys(manifest) {
  return manifest.prompts.map((entry) => entry.target_key);
}

function promptEntryFor(manifest, targetKey) {
  const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
  assert.ok(entry, `missing manifest prompt fixture: ${targetKey}`);
  return entry;
}

test("decomposition roster stays prompt target_key-derived, not runtime-role-derived", () => {
  const manifest = readManifest();
  const roster = createOrchestratorRoster({ manifest });
  const selectableTargets = [...roster.selectableTargets];

  assert.deepEqual(
    sorted(selectableTargets),
    sorted(EXPECTED_SELECTABLE_TARGET_KEYS),
    "decomposition has exactly the four selectable pm/sr_eng library prompt target_keys",
  );

  const selectableEntries = EXPECTED_SELECTABLE_TARGET_KEYS.map((targetKey) =>
    promptEntryFor(manifest, targetKey));
  const selectableRoles = selectableEntries.map((entry) => entry.role);

  assert.deepEqual(sorted(selectableRoles), ["pm", "pm", "sr_eng", "sr_eng"]);
  assert.deepEqual(sorted(new Set(selectableRoles)), ["pm", "sr_eng"]);
  assert.equal(
    new Set(selectableRoles).size < selectableTargets.length,
    true,
    "multiple selectable prompt target_keys intentionally share the same role",
  );
  assert.equal(
    selectableEntries.some((entry) => entry.role === "drafter"),
    false,
    "decomposition has no drafter library prompt",
  );

  const invocableRoles = resolveInvocableRuntimeRoles(
    loadLinearConfig({ repoRoot: REPO_ROOT }),
    decompositionDefinition,
  );
  assert.deepEqual(
    sorted(invocableRoles),
    ["drafter", "judge", "pm", "sr_eng"],
    "the runtime-role axis remains the config-derived invocable one-off role set",
  );
  assert.notDeepEqual(
    sorted(selectableTargets),
    sorted(invocableRoles),
    "selectable library targets are prompt target_keys, not invocable runtime roles",
  );
  assert.equal(
    invocableRoles.includes("drafter"),
    true,
    "a role-derived roster would incorrectly invent a drafter selectable target",
  );
  assert.equal(
    selectableTargets.some((targetKey) => targetKey.includes("drafter")),
    false,
    "the manifest-derived roster does not invent drafter target_keys",
  );
});

test("driver and judge prompt identities stay out of the selectable roster", () => {
  const manifest = readManifest();
  const roster = createOrchestratorRoster({ manifest });
  const promptTargetKeys = manifestPromptTargetKeys(manifest);

  assert.equal(
    promptTargetKeys.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY),
    true,
    "the driver governing prompt is present in manifest.prompts[]",
  );
  assert.equal(
    promptTargetKeys.includes(JUDGE_TARGET_KEY),
    true,
    "the judge prompt is present in manifest.prompts[]",
  );
  assert.equal(
    roster.selectableTargets.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY),
    false,
    "the driver prompt is excluded by target identity",
  );
  assert.equal(
    roster.selectableTargets.includes(JUDGE_TARGET_KEY),
    false,
    "the judge prompt is excluded by target identity",
  );
});

test("decomposition definition keeps the deferred capability seam comment", () => {
  const definitionSource = fs.readFileSync(DEFINITION_PATH, "utf8");

  assert.equal(
    Object.hasOwn(decompositionDefinition, "role_capabilities"),
    true,
    "decompositionDefinition exposes the deferred role_capabilities/tool_policy seam",
  );
  assert.equal(decompositionDefinition.role_capabilities, null);
  assert.match(
    definitionSource,
    /\/\/ Placed role_capabilities\/tool_policy seam: agent write credentials stay\r?\n\s*\/\/ absent from contained environments; the engine owns the single validated commit\.\r?\n\s*role_capabilities: null,/,
    "the seam comment must preserve the invariant: no agent write credentials; engine owns the single commit",
  );
});
