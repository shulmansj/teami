import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAcceptedPromptSnapshot } from "../../../engine/accepted-prompt-snapshot.mjs";
import { createOrchestratorRoster, ORCHESTRATOR_GOVERNING_TARGET_KEY } from "../src/orchestrator-roster.mjs";
import { isAdopterSelfImprovementTarget } from "../src/promotion/agent-behavior-scope.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "execution", "evals", "decomposition", "phoenix-assets.json");
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "execution",
  "evals",
  "decomposition",
  "accepted-prompts",
  "orchestrator-governing.md",
);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function governingEntry() {
  return readManifest().prompts.find((p) => p.target_key === ORCHESTRATOR_GOVERNING_TARGET_KEY);
}

test("the governing snapshot loads via loadAcceptedPromptSnapshot without drift or unsafe content", () => {
  const snapshot = loadAcceptedPromptSnapshot({ targetKey: ORCHESTRATOR_GOVERNING_TARGET_KEY });
  assert.equal(snapshot.drift, false);
  assert.match(snapshot.header, /^# Accepted Orchestrator Governing Prompt/);
  assert.match(snapshot.header, /phoenix_prompt_role: orchestrator/);
  assert.match(snapshot.header, /target_key: prompt\/decomposition\/orchestrator_governing/);
  // The body (sections) parsed; the yaml header is stripped from contentBytes.
  assert.ok(Object.keys(snapshot.sections).length > 0);
  assert.doesNotMatch(snapshot.contentBytes, /^# Accepted /m);
  assert.doesNotMatch(snapshot.contentBytes, /```yaml/);
});

test("the manifest sha256 matches the exact bytes of the snapshot file (no drift)", () => {
  const bytes = fs.readFileSync(SNAPSHOT_PATH);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(governingEntry().snapshot_sha256, sha);
});

test("the governing entry is a NORMAL prompt entry with no `selectable` field (roster-exclusion is by identity)", () => {
  const entry = governingEntry();
  assert.equal(entry.role, "orchestrator");
  assert.equal(entry.artifact_kind, "accepted_prompt");
  assert.equal(entry.materializer, "phoenix_prompt_version_to_accepted_prompt_snapshot");
  assert.ok(!Object.hasOwn(entry, "selectable"), "must NOT carry a `selectable` manifest field");
});

test("the governing prompt is roster-EXCLUDED (selectableTargets stays the 4 pm/sr_eng) yet adopter-TUNABLE", () => {
  const roster = createOrchestratorRoster();
  assert.equal(roster.selectableTargets.length, 4);
  assert.ok(!roster.selectableTargets.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY));
  // Tunable by shape (only the judge is tuning-excluded).
  assert.equal(isAdopterSelfImprovementTarget(governingEntry()), true);
});
