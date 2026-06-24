import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Deliverable C (Seam 1 test-injection): prove the ADDITIVE optional
// orchestrator-turn executor param was added to the decomposition phase loop
// the SAME way `runtimeExecutor` is (caller-supplied, no in-signature default),
// WITHOUT changing the live router. This file is source-pinned and token-free on
// purpose: it asserts the destructure carries the new param by reading the
// source, so it does not reference any retirement-surface router token (RET-CHECK
// set-a/b/c) from a new file. The behavioral proof that the live router is
// unchanged is the EXISTING phase-loop tests (linear-workflow, runtime-role-
// defaults), which stay green.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRIGGER_RUNNER_SOURCE = fs.readFileSync(
  path.resolve(TEST_DIR, "..", "..", "..", "engine", "orchestrator-loop.mjs"),
  "utf8",
);

test("runDecompositionOrchestrator takes orchestratorTurnExecutor and definition caller-supplied (no in-signature defaults in the loop)", () => {
  // Scope the assertion to the runDecompositionOrchestrator destructure block. Seam 1:
  // the LOOP imposes no in-signature default for the orchestrator-turn / runtime
  // executors, while the production CALLERS (runTriggeredDecomposition,
  // runDecompositionEvalMode) DO default them to the real executors. Keeping the
  // default out of the loop is what makes the injection honest — a test that
  // forgets to inject cannot silently fall through to the real runtime. (The
  // earlier whole-file check wrongly forbade the legitimate caller defaults.)
  const loopMatch = TRIGGER_RUNNER_SOURCE.match(
    /export async function runOrchestratorLoop\(\{([\s\S]*?)\}\s*=\s*\{\}\)\s*\{/,
  );
  assert.ok(loopMatch, "the runDecompositionOrchestrator destructure block must be found");
  const loopParams = loopMatch[1];

  assert.match(
    loopParams,
    /\borchestratorTurnExecutor\b/,
    "the orchestratorTurnExecutor param must be in the runDecompositionOrchestrator destructure",
  );
  assert.match(
    loopParams,
    /\bdefinition\b/,
    "the definition param must be in the runDecompositionOrchestrator destructure",
  );
  assert.match(
    loopParams,
    /\bspanSink\s*=\s*null\b/,
    "spanSink must be an optional null-default observability sink in the loop",
  );
  assert.doesNotMatch(
    loopParams,
    /orchestratorTurnExecutor\s*=/,
    "orchestratorTurnExecutor must be caller-supplied in the loop (no in-signature default)",
  );
  assert.doesNotMatch(
    loopParams,
    /definition\s*=/,
    "definition must be caller-supplied in the loop (no in-signature default)",
  );
  // It mirrors runtimeExecutor, which is likewise caller-supplied in the loop.
  assert.doesNotMatch(
    loopParams,
    /runtimeExecutor\s*=/,
    "runtimeExecutor must be caller-supplied in the loop, like orchestratorTurnExecutor",
  );
});
