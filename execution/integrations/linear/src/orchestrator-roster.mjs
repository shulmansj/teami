import fs from "node:fs";
import path from "node:path";

import { loadAcceptedPromptSnapshot } from "../../../engine/accepted-prompt-snapshot.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import "./workflows/decomposition/definition.mjs";

export { ORCHESTRATOR_GOVERNING_TARGET_KEY } from "../../../engine/engine-orchestrator-contract.mjs";

// Repo root, derived the same way trigger-runner.mjs derives MODULE_REPO_ROOT:
// this module lives at execution/integrations/linear/src/, so four levels up is
// the repo root that owns the workflow eval assets.
const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

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

function readWorkflowManifest(repoRoot, namespacePaths) {
  const manifestPath = path.resolve(repoRoot, namespacePaths.manifest);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function resolveWorkflowDefinition(workflowType) {
  const normalized = typeof workflowType === "string" ? workflowType.trim() : "";
  if (!normalized) {
    throw new Error("createOrchestratorRoster_workflow_type_required");
  }
  return getWorkflowDefinition(normalized);
}

function evalAssetAvailability({ repoRoot, namespacePaths }) {
  const requiredAssets = [
    ["manifest", namespacePaths.manifest],
    ["variants", namespacePaths.variants],
  ];
  const assets = Object.fromEntries(
    requiredAssets.map(([name, repoRelativePath]) => {
      const absolutePath = path.resolve(repoRoot, repoRelativePath);
      return [
        name,
        {
          repo_relative_path: repoRelativePath,
          path: absolutePath,
          exists: fs.existsSync(absolutePath),
        },
      ];
    }),
  );
  const missing = Object.entries(assets)
    .filter(([, asset]) => !asset.exists)
    .map(([name, asset]) => ({
      asset: name,
      repo_relative_path: asset.repo_relative_path,
      path: asset.path,
    }));
  return Object.freeze({
    promotable: missing.length === 0,
    reason: missing.length === 0 ? null : "eval_assets_absent",
    missing,
    assets,
  });
}

function evaluatorRoleSet(definition) {
  return new Set(
    (Array.isArray(definition?.engine_owned_evaluator_roles)
      ? definition.engine_owned_evaluator_roles
      : []
    )
      .map((role) => typeof role === "string" ? role.trim() : "")
      .filter(Boolean),
  );
}

function normalizedRole(entry) {
  return typeof entry?.role === "string" ? entry.role.trim() : "";
}

function driverGoverningTargetKey(definition) {
  return typeof definition?.driver_governing_target_key === "string"
    ? definition.driver_governing_target_key.trim()
    : "";
}

// A manifest entry is a selectable library subagent iff it is a materializer-
// backed accepted_prompt `prompt/...` entry that is NEITHER a workflow-owned
// evaluator prompt NOR the workflow driver's own governing prompt. There is no
// selectable manifest field; selectability is derived from the workflow
// definition plus manifest shape.
function isSelectableTarget(entry, { evaluatorRoles, driverGoverningKey }) {
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
  if (evaluatorRoles.has(normalizedRole(entry))) return false;
  if (targetKey === driverGoverningKey) return false;
  return true;
}

// Build the roster resolver from the workflow's phoenix-assets.json.prompts[].
//
//   createOrchestratorRoster({ workflowType?, manifest?, repoRoot? }) -> {
//     selectableTargets: string[],          // manifest-derived, evaluator + governing excluded
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
  workflowType = "decomposition",
  manifest = null,
  repoRoot = MODULE_REPO_ROOT,
  acceptedPromptOverrides = null,
} = {}) {
  const definition = resolveWorkflowDefinition(workflowType);
  const namespacePaths = evalNamespacePaths(definition);
  const evalAssets = evalAssetAvailability({ repoRoot, namespacePaths });
  const resolvedManifest = manifest ?? readWorkflowManifest(repoRoot, namespacePaths);
  const selectableContext = {
    evaluatorRoles: evaluatorRoleSet(definition),
    driverGoverningKey: driverGoverningTargetKey(definition),
  };
  const prompts = Array.isArray(resolvedManifest?.prompts)
    ? resolvedManifest.prompts
    : [];
  const overrides =
    acceptedPromptOverrides && typeof acceptedPromptOverrides === "object"
      ? acceptedPromptOverrides
      : {};

  // Index selectable entries by target_key so resolve() is O(1) and rejects
  // anything not in the derived selectable set (evaluator, governing, unknown).
  const selectableByKey = new Map();
  for (const entry of prompts) {
    if (isSelectableTarget(entry, selectableContext)) {
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
      : () => loadAcceptedPromptSnapshot({ repoRoot, definition, targetKey: key });
    return resolution(runtime_role, loadSnapshot);
  }

  return {
    selectableTargets,
    resolve,
    promotable: evalAssets.promotable,
    evalAssets,
  };
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
