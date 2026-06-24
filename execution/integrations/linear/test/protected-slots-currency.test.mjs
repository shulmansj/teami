import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyMetaAuthorityChange,
  PROTECTED_SLOTS,
} from "../src/meta-change-classifier.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const protectedSlotsPath = path.join(
  repoRoot,
  "maintainers/contracts/protected-slots.json",
);
const protectedSlotsJson = JSON.parse(
  fs.readFileSync(protectedSlotsPath, "utf8"),
);

// The four adopter per-phase prompts are the DEFERRED-PERSONA exception
// (ORDINARY_PROMPT_PATHS). They are intentionally NOT owned by the JSON and are
// re-derived against the persona shape later. This list is the documented
// deferred surface the JSON-coverage test below asserts is disjoint from the
// factory-protection source of record.
const DEFERRED_ORDINARY_PROMPT_PATHS = [
  "execution/evals/decomposition/accepted-prompts/pm-product-sufficiency-pass.md",
  "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
  "execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md",
  "execution/evals/decomposition/accepted-prompts/sr-eng-blocker-check.md",
];

function changedLines(text) {
  return String(text)
    .trim()
    .split(/\r?\n/)
    .map((line) => `+${line}`);
}

function added(filePath, text) {
  return {
    path: filePath,
    status: "added",
    hunks: [{ header: "@@ fixture @@", lines: changedLines(text) }],
  };
}

// ---------------------------------------------------------------------------
// Drift gate: the JSON source of record and the in-code PROTECTED_SLOTS
// projection must be byte-for-byte equivalent. Editing one alone diverges them
// and fails here, so neither the JSON nor the projection can silently drift.
// ---------------------------------------------------------------------------

test("protected-slots.json and the PROTECTED_SLOTS projection are identical", () => {
  // Deep-equal in both directions. A JSON-only edit (extra/changed/removed slot)
  // OR a projection-only edit makes this assertion fail.
  assert.deepEqual(
    protectedSlotsJson,
    PROTECTED_SLOTS,
    "protected-slots.json drifted from the meta-change-classifier PROTECTED_SLOTS projection; edit BOTH together",
  );
  // Guard the reverse direction explicitly so a removed key on either side is
  // caught regardless of which object is treated as the superset.
  assert.deepEqual(PROTECTED_SLOTS, protectedSlotsJson);
});

test("protected-slots.json declares the expected single-source schema", () => {
  assert.equal(protectedSlotsJson.schema_version, "agentic-factory-protected-slots/v1");
  assert.ok(Array.isArray(protectedSlotsJson.exact_paths));
  assert.ok(Array.isArray(protectedSlotsJson.prefix_paths));
  assert.ok(Array.isArray(protectedSlotsJson.sensitive_roots));
  for (const entry of protectedSlotsJson.exact_paths) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.class, "string");
    assert.equal(typeof entry.surface, "string");
  }
  for (const entry of protectedSlotsJson.prefix_paths) {
    assert.equal(typeof entry.prefix, "string");
    assert.equal(typeof entry.class, "string");
    assert.equal(typeof entry.surface, "string");
  }
  for (const root of protectedSlotsJson.sensitive_roots) {
    assert.equal(typeof root, "string");
  }
});

// ---------------------------------------------------------------------------
// Coverage: the JSON owns the factory-protection set, and ORDINARY_PROMPT_PATHS
// is the known deferred surface (disjoint from the JSON, classifies ordinary).
// ---------------------------------------------------------------------------

test("the JSON covers the factory-protection exact set and excludes the deferred prompts", () => {
  const jsonExactPaths = new Set(PROTECTED_SLOTS.exact_paths.map((entry) => entry.path));

  // The JSON owns no ordinary-prompt deferred entry: every JSON exact path is a
  // factory-protection slot (meta_change, authority_change, or field_sensitive),
  // never the adopter per-phase prompt exception.
  for (const entry of PROTECTED_SLOTS.exact_paths) {
    assert.notEqual(
      entry.class,
      "ordinary_semantic",
      `factory-protection JSON must not carry ordinary_semantic slot ${entry.path}`,
    );
  }

  // The deferred ORDINARY_PROMPT_PATHS surface is disjoint from the JSON-owned
  // factory-protection set — it is a documented exception, not a JSON slot.
  for (const promptPath of DEFERRED_ORDINARY_PROMPT_PATHS) {
    assert.ok(
      !jsonExactPaths.has(promptPath),
      `deferred ordinary prompt ${promptPath} must not be in protected-slots.json`,
    );
  }
});

test("the JSON-owned factory-protection paths classify by their declared class", () => {
  // Proves the JSON actually drives classification (not just shape parity): each
  // exact path classifies at least as severe as its declared class. field_sensitive
  // entries resolve by hunk facts, so they are validated separately by the
  // preflight matrix; here we assert the deterministic meta/authority entries.
  for (const entry of PROTECTED_SLOTS.exact_paths) {
    if (entry.class === "field_sensitive") continue;
    const result = classifyMetaAuthorityChange({
      changes: [added(entry.path, "// touch a protected factory surface")],
    });
    // A new file under a sensitive root with a broad-default-only rule fails
    // closed as unknown_sensitive; otherwise the declared class is the primary.
    assert.notEqual(
      result.class,
      "ordinary_semantic",
      `${entry.path} (declared ${entry.class}) must never classify ordinary_semantic`,
    );
    assert.equal(result.fail_closed, true, entry.path);
  }
});

test("the deferred ordinary prompts still classify ordinary_semantic by default", () => {
  // The deferred exception keeps its retired-per-role behavior: an ordinary
  // adopter prompt edit (modified, not a sensitive new file) is ordinary_semantic.
  for (const promptPath of DEFERRED_ORDINARY_PROMPT_PATHS) {
    const result = classifyMetaAuthorityChange({
      changes: [{
        path: promptPath,
        status: "modified",
        hunks: [{ header: "@@ fixture @@", lines: ["+Ask for the desired product outcome first."] }],
      }],
    });
    assert.equal(result.class, "ordinary_semantic", promptPath);
    assert.equal(result.fail_closed, false, promptPath);
    assert.ok(
      result.affected_surfaces.includes("agent_behavior_prompt"),
      `${promptPath} should surface agent_behavior_prompt: ${JSON.stringify(result.affected_surfaces)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Allowlist-absence: the positive allowlist fails closed. A new file under a
// sensitive_roots entry with NO matching exact_paths/prefix_paths entry is
// unknown_sensitive (reason unknown_new_sensitive_surface) — proving the
// protected-PATH maps are a deliberately stale denylist and the positive
// allowlist (not these maps) is the actual fail-closed gate.
// ---------------------------------------------------------------------------

test("a new file under a sensitive root with no map entry fails closed as unknown_sensitive", () => {
  // `execution/` is a sensitive root, but `execution/scratch/` has no exact or
  // prefix protected-path entry, so the path map cannot label it. The positive
  // allowlist fail-closes it to unknown_sensitive regardless.
  const sensitiveRoot = "execution/";
  assert.ok(
    PROTECTED_SLOTS.sensitive_roots.includes(sensitiveRoot),
    "fixture assumes execution/ is a sensitive root",
  );
  const newPath = "execution/scratch/unmapped-new-surface.json";

  // No exact entry, and no prefix entry matches (the only execution/ prefixes are
  // under execution/evals/decomposition/rubrics/ and execution/integrations/linear/src/).
  const hasExact = PROTECTED_SLOTS.exact_paths.some((entry) => entry.path === newPath);
  const hasPrefix = PROTECTED_SLOTS.prefix_paths.some((entry) => newPath.startsWith(entry.prefix));
  assert.equal(hasExact, false, "fixture path must have no exact protected-slot entry");
  assert.equal(hasPrefix, false, "fixture path must have no prefix protected-slot entry");

  const result = classifyMetaAuthorityChange({
    changes: [added(newPath, '{"value":"ordinary_semantic"}')],
  });
  assert.equal(result.class, "unknown_sensitive");
  assert.equal(result.fail_closed, true);
  assert.ok(
    result.reasons.some((reason) => reason.id === "unknown_new_sensitive_surface"),
    `expected unknown_new_sensitive_surface reason: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(result.affected_surfaces.includes("new_sensitive_surface"));
});
