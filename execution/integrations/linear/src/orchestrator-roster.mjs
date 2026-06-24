import fs from "node:fs";
import path from "node:path";

import { loadAcceptedPromptSnapshot } from "../../../engine/accepted-prompt-snapshot.mjs";
import {
  ORCHESTRATOR_GOVERNING_TARGET_KEY,
} from "../../../engine/engine-orchestrator-contract.mjs";
import {
  isDriverSelfImprovementTarget,
  isExcludedJudgeTarget,
} from "./promotion/agent-behavior-scope.mjs";
import { decompositionDefinition } from "./workflows/decomposition/definition.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "./workflows/decomposition/eval-paths.mjs";

export { ORCHESTRATOR_GOVERNING_TARGET_KEY } from "../../../engine/engine-orchestrator-contract.mjs";

// Repo root, derived the same way trigger-runner.mjs derives MODULE_REPO_ROOT:
// this module lives at execution/integrations/linear/src/, so four levels up is
// the repo root that owns execution/evals/decomposition/phoenix-assets.json.
const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

// The orchestrator's own governing system prompt is a NORMAL adopter-tunable
// accepted_prompt manifest entry (the same persona primitive as pm/sr_eng), but
// it is the DRIVER of the run, not a subagent the orchestrator invokes. So it is
// excluded from the subagent roster by IDENTITY on this constant — there is no
// `selectable` manifest field. Selectability is derived; tunability is NOT
// touched (the governing prompt stays adopter-tunable via
// isAdopterSelfImprovementTarget, which keys off shape and excludes only the
// judge). I-2a imports this constant from here to seed the manifest entry.
// Outcome of resolve(): either a resolution carrying the runtime_role + a lazy
// snapshot loader, or a rejection carrying a reason. `ok` distinguishes them.
// The loader yields the FULL verified snapshot (not just the body) because the
// invoke_library handler (Seam 1) needs both the body (`snapshot.contentBytes`,
// for the subagent prompt) AND the snapshot itself (for the run-scoped
// recorder's `recordLibraryLoad({ target_key, snapshot })`, Seam 3) from ONE
// load. (Seam 4 illustrated this as `loadBody()`; the recorder seam proves the
// snapshot — a superset of the body — is what the single load must return.)
function resolution(runtime_role, loadSnapshot) {
  return { ok: true, runtime_role, loadSnapshot };
}

function rejection(reason) {
  return { ok: false, reason };
}

function readDecompositionManifest(repoRoot) {
  const manifestPath = path.resolve(repoRoot, DECOMPOSITION_EVAL_PATHS.manifest);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

// A manifest entry is a selectable library subagent iff it is a materializer-
// backed accepted_prompt `prompt/...` entry that is NEITHER the judge (the
// engine-owned evaluator) NOR the orchestrator's own governing prompt (the
// driver). This is the Seam-4 derivation: two non-selectable entries, both
// identifiable through the self-improvement scope authority, no new flag.
function isSelectableTarget(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const targetKey =
    typeof entry.target_key === "string" ? entry.target_key.trim() : "";
  if (!targetKey.startsWith("prompt/")) return false;
  if (entry.artifact_kind !== "accepted_prompt") return false;
  if (
    entry.materializer
    !== "phoenix_prompt_version_to_accepted_prompt_snapshot"
  ) {
    return false;
  }
  if (typeof entry.snapshot_path !== "string" || entry.snapshot_path.trim() === "") {
    return false;
  }
  if (isExcludedJudgeTarget(entry)) return false;
  if (isDriverSelfImprovementTarget(entry)) return false;
  if (targetKey === ORCHESTRATOR_GOVERNING_TARGET_KEY) return false;
  return true;
}

// Build the Seam-4 roster resolver from phoenix-assets.json.prompts[].
//
//   createOrchestratorRoster({ manifest?, repoRoot? }) -> {
//     selectableTargets: string[],          // manifest-derived, judge + governing excluded
//     resolve(target_key) -> { ok: true,  runtime_role, loadSnapshot() }
//                          | { ok: false, reason }
//   }
//
// The manifest may be injected (for tests / a synthetic fixture); when omitted
// it is read from the real repo manifest at `repoRoot` (default: this repo).
// loadSnapshot() reuses loadAcceptedPromptSnapshot — the same verified-snapshot
// mechanism the live runtime uses to load accepted prompt bodies — and returns
// the FULL verified snapshot (the prompt body is `snapshot.contentBytes`). It
// loads lazily so resolving a target does not pay snapshot I/O until the body is
// actually needed, and it surfaces drift/unsafe-content errors at use time.
// `acceptedPromptOverrides` (eval-only): a map of target_key -> { contentBytes }.
// When a target is overridden, resolve().loadSnapshot() returns a SYNTHETIC
// snapshot whose body is the override content and whose snapshotSha256 is null
// (an override is not the accepted baseline, so the run recorder mints no
// accepted ref for it — acceptedRefFromLoadedSnapshot returns null on a null
// sha). This is how the eval CLI's candidate-prompt overrides reach the loop's
// library subagent invocations without phase-prompt machinery.
export function createOrchestratorRoster({
  manifest = null,
  repoRoot = MODULE_REPO_ROOT,
  acceptedPromptOverrides = null,
} = {}) {
  const resolvedManifest = manifest ?? readDecompositionManifest(repoRoot);
  const prompts = Array.isArray(resolvedManifest?.prompts)
    ? resolvedManifest.prompts
    : [];
  const overrides =
    acceptedPromptOverrides && typeof acceptedPromptOverrides === "object"
      ? acceptedPromptOverrides
      : {};

  // Index selectable entries by target_key so resolve() is O(1) and rejects
  // anything not in the derived selectable set (judge, governing, unknown).
  const selectableByKey = new Map();
  for (const entry of prompts) {
    if (isSelectableTarget(entry)) {
      selectableByKey.set(entry.target_key, entry);
    }
  }

  const selectableTargets = [...selectableByKey.keys()];

  function resolve(target_key) {
    const key = typeof target_key === "string" ? target_key.trim() : "";
    if (!key) {
      return rejection("orchestrator_roster_target_key_missing");
    }
    const entry = selectableByKey.get(key);
    if (!entry) {
      return rejection("orchestrator_roster_target_not_selectable");
    }
    const runtime_role =
      typeof entry.role === "string" && entry.role.trim() !== ""
        ? entry.role.trim()
        : null;
    if (!runtime_role) {
      return rejection("orchestrator_roster_target_role_missing");
    }
    const override = overrides[key];
    const loadSnapshot = override
      ? () => syntheticOverrideSnapshot(key, override)
      : () => loadAcceptedPromptSnapshot({ repoRoot, definition: decompositionDefinition, targetKey: key });
    return resolution(runtime_role, loadSnapshot);
  }

  return { selectableTargets, resolve };
}

// A synthetic snapshot for an eval candidate-prompt override: the body is the
// override content; snapshotSha256 is null so no accepted ref is recorded (an
// override is an experiment identity, not accepted behavior).
function syntheticOverrideSnapshot(targetKey, override) {
  const contentBytes =
    typeof override?.contentBytes === "string" ? override.contentBytes : "";
  return {
    entry: { target_key: targetKey },
    contentBytes,
    sections: {},
    snapshotSha256: null,
    expectedSha256: null,
    drift: false,
  };
}
