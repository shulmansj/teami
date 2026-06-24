import fs from "node:fs";
import path from "node:path";

import { evalNamespacePaths } from "./eval-namespace.mjs";

// The run-version record (S-REFS): each persisted decomposition run artifact
// records which accepted-behavior version(s) the run consumed, so a later read
// (B-READ) can answer "has a downstream run consumed this accepted-behavior
// change?". Forward-only foundational data; all fields stay optional and
// backward-compatible (old artifacts without them remain valid, Q7).
//
// The recorded refs are CAPTURED AS EACH PHASE LOADS its accepted prompt
// snapshot (trigger-runner.mjs `runDecompositionOrchestrator`), NOT re-derived from
// the current manifest at run finalization. Capturing as-loaded is what makes
// the answer correct when a competing behavior-change PR for the same target
// merges mid-run: finalize-time re-derivation would record the newer version,
// but the run only ever consumed the version pinned when it loaded.
//
// The shape is the normalized accepted-version reference:
//   { target_key, accepted_baseline_id, snapshot_sha256 }
// reusing the identifiers `resolveAcceptedBaseline` already mints — no new
// version vocabulary. `resolveAcceptedBaseline` does NOT return this shape
// directly (`target_key` is caller-supplied; `snapshot_sha256` is nested under
// `accepted_artifact_hash_vector`), so `normalizeAcceptedRef` adapts it. The
// capture-at-load path mints the identical shape directly from the loaded
// snapshot (trigger-runner.mjs `acceptedRefFromLoadedSnapshot`).

// The accepted runtime-role defaults consumed when a role's runtime/model is
// not pinned in adopter config but resolved from the accepted defaults file.
// Recorded only when the run actually consumed accepted defaults.
export const RUNTIME_ROLE_DEFAULTS_TARGET_KEY = "rule/decomposition/runtime_role_assignments";

const DEFAULT_EVAL_DEFINITION = Object.freeze({ eval_namespace: "execution/evals/decomposition" });

// Normalize one `resolveAcceptedBaseline` result into the S-REFS entry shape.
// Returns null when the resolution failed (a missing/unrecoverable version is
// simply not recorded; B-READ treats absence as `unknown`).
export function normalizeAcceptedRef(targetKey, resolution) {
  if (!resolution || resolution.ok !== true) return null;
  return {
    target_key: targetKey,
    accepted_baseline_id: resolution.accepted_baseline_id ?? null,
    snapshot_sha256: resolution.accepted_artifact_hash_vector?.snapshot_sha256 ?? null,
  };
}

function readPhoenixAssetsManifest(repoRoot, definition = DEFAULT_EVAL_DEFINITION) {
  const manifestPath = path.resolve(repoRoot, evalNamespacePaths(definition).manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestRepoRoot = path.resolve(manifestPath, "..", "..", "..", "..");
  return { manifest, manifestRepoRoot };
}

// Resolve + normalize the accepted-version reference for a single target key
// against the repo-pinned phoenix-assets manifest. Returns null when the target
// is unavailable or the snapshot cannot be read/verified.
export function resolveAcceptedRefForTarget({
  targetKey,
  repoRoot = process.cwd(),
  definition = DEFAULT_EVAL_DEFINITION,
  resolveAcceptedBaseline,
} = {}) {
  if (typeof targetKey !== "string" || targetKey === "") return null;
  let manifest;
  let manifestRepoRoot;
  try {
    ({ manifest, manifestRepoRoot } = readPhoenixAssetsManifest(repoRoot, definition));
  } catch {
    return null;
  }
  const resolution = resolveAcceptedBaseline({
    manifest,
    candidateTargetKey: targetKey,
    readArtifactBytes: (relativePath) => {
      try {
        return { ok: true, bytes: fs.readFileSync(path.join(manifestRepoRoot, relativePath)) };
      } catch (error) {
        return { ok: false, reason: "run_accepted_ref_artifact_unreadable", detail: error.message };
      }
    },
  });
  return normalizeAcceptedRef(targetKey, resolution);
}

// True when an EXECUTED decomposition role resolved its runtime/model from the
// accepted runtime-role defaults (vs. pinned in adopter config).
// `role_field_sources` is stamped onto the workflow by config validation
// (config.mjs) for EVERY configured role — including roles the decomposition
// phase loop never runs (e.g. `drafter`). Scanning all of them would record the
// runtime-defaults rule for a run that never used the changed default, so the
// answer is gated on the roles that actually executed. An empty/missing
// `executedRoles` is conservative: no executed role ⇒ nothing consumed.
export function consumedAcceptedRoleDefaults(config, executedRoles = null) {
  const sources = config?.workflows?.decomposition?.role_field_sources;
  if (!sources || typeof sources !== "object") return false;
  const executed = normalizeExecutedRoles(executedRoles);
  for (const [role, roleFields] of Object.entries(sources)) {
    if (executed && !executed.has(role)) continue;
    if (!roleFields || typeof roleFields !== "object") continue;
    for (const source of Object.values(roleFields)) {
      if (source === "accepted_defaults") return true;
    }
  }
  return false;
}

function normalizeExecutedRoles(executedRoles) {
  if (executedRoles == null) return null;
  if (executedRoles instanceof Set) return executedRoles;
  if (Array.isArray(executedRoles)) return new Set(executedRoles);
  return null;
}

// Build the run-version record's `accepted_refs[]` from the refs CAPTURED AT
// LOAD as each phase ran (B-REFS), deduped by target_key in first-captured
// order, plus the runtime-defaults rule ref when an EXECUTED role actually
// consumed accepted role defaults. The runtime-defaults ref is the one CAPTURED
// AT CONFIG LOAD (config.mjs stashes it the moment the run reads those defaults),
// NOT a finalize-time re-resolve against the current manifest — a competing
// mid-run merge to the defaults would otherwise be mis-recorded as the consumed
// version. Returns an empty array when nothing resolves (the field is then
// omitted by the caller to stay backward-compatible).
export function collectRunAcceptedRefs({
  capturedPhaseRefs = [],
  config = null,
  executedRoles = null,
} = {}) {
  const refs = [];
  const seen = new Set();
  for (const ref of capturedPhaseRefs) {
    if (!ref || typeof ref !== "object") continue;
    const targetKey = ref.target_key;
    if (typeof targetKey !== "string" || targetKey === "" || seen.has(targetKey)) continue;
    seen.add(targetKey);
    refs.push(ref);
  }
  if (consumedAcceptedRoleDefaults(config, executedRoles) && !seen.has(RUNTIME_ROLE_DEFAULTS_TARGET_KEY)) {
    // The runtime-defaults ref CAPTURED AT CONFIG LOAD (not re-resolved here at
    // finalize). When the load-time capture is unavailable, record an UNJOINABLE
    // coverage marker (target touched, version unknown) so B-READ degrades to
    // `unknown` rather than guessing a possibly-newer version.
    const capturedRef = capturedRuntimeDefaultsRef(config);
    refs.push(capturedRef || unjoinableCoverageMarker(RUNTIME_ROLE_DEFAULTS_TARGET_KEY));
  }
  return refs;
}

// The runtime-role-defaults accepted ref CAPTURED AT CONFIG LOAD: config.mjs
// resolves it the moment the run first resolves a role field from accepted
// defaults and stashes it on the workflow, so the recorded version is the one
// the run actually read. Returns the stashed ref only when it is a JOINABLE ref
// for the runtime-defaults target (a usable version identity); else null.
function capturedRuntimeDefaultsRef(config) {
  const ref = config?.workflows?.decomposition?.accepted_runtime_defaults_ref;
  if (!ref || typeof ref !== "object") return null;
  if (ref.target_key !== RUNTIME_ROLE_DEFAULTS_TARGET_KEY) return null;
  const joinable =
    (typeof ref.accepted_baseline_id === "string" && ref.accepted_baseline_id !== "")
    || (typeof ref.snapshot_sha256 === "string" && ref.snapshot_sha256 !== "");
  return joinable ? ref : null;
}

// An UNJOINABLE coverage marker: a ref entry that records the run TOUCHED the
// target but with no resolvable version (null identifiers — a shape the run-store
// validator tolerates). B-READ reads it as "consumed an unknown version of this
// target", which can neither be ruled in nor out, so it never licenses a
// confident not_used.
export function unjoinableCoverageMarker(targetKey) {
  return { target_key: targetKey, accepted_baseline_id: null, snapshot_sha256: null };
}

// Build the normalized accepted-version ref { target_key, accepted_baseline_id,
// snapshot_sha256 } from a LOADED prompt snapshot, in the IDENTICAL shape
// `normalizeAcceptedRef` mints for a prompt target (accepted_prompt_version_id
// || `sha256:<snapshot>`), so the B-READ join still matches like-for-like.
// MOVED here from trigger-runner.mjs (where it was private) and exported so the
// run-scoped recorder (Seam 3) can build a captured ref from the single snapshot
// load the orchestrator's invoke handler already performs. Pure helper over
// snapshot.snapshotSha256 + snapshot.entry.accepted_prompt_version_id — no I/O.
export function acceptedRefFromLoadedSnapshot(targetKey, snapshot) {
  const snapshotSha256 = snapshot?.snapshotSha256 ?? null;
  if (typeof snapshotSha256 !== "string" || snapshotSha256 === "") return null;
  const versionId = snapshot?.entry?.accepted_prompt_version_id;
  return {
    target_key: targetKey,
    accepted_baseline_id:
      typeof versionId === "string" && versionId !== "" ? versionId : `sha256:${snapshotSha256}`,
    snapshot_sha256: snapshotSha256,
  };
}

// The run-scoped recorder (Seam 3 — the #50 ledger re-key). One recorder per
// decomposition run accumulates every accepted-behavior version the run
// CONSUMES, captured AT LOAD (first-captured wins per target_key), so a later
// read can answer "has a downstream run consumed this accepted-behavior change?"
// correctly even when a competing same-target PR merges mid-run.
//
//   createRunRecorder({ config }) -> {
//     recordLibraryLoad({ target_key, snapshot }),   // LIVE
//     recordGoverningLoad({ target_key, snapshot }),  // LIVE
//     recordExecutedRuntimeRole(runtime_role),        // LIVE
//     recordJudgeRef({ target_key, snapshotSha256 }), // wired-or-stub (I-3 fills)
//     collectRefs({ config? }) -> accepted_refs[],
//   }
//
// `config` may be supplied at construction OR per collectRefs() call (the latter
// wins) so the factory can be built before config is resolved. It is used only
// for the runtime-defaults rule via consumedAcceptedRoleDefaults — the recorder
// reuses collectRunAcceptedRefs, minting no parallel structure.
export function createRunRecorder({ config = null } = {}) {
  // Captured accepted-version refs (library + governing + judge), deduped by
  // target_key, FIRST-CAPTURED wins — the same dedup the phase collector did.
  const capturedByTarget = new Map();
  // The runtime roles whose subagents (or the orchestrator itself) actually
  // executed, so the runtime-defaults rule ref is only recorded when an EXECUTED
  // role resolved a field from accepted defaults.
  const executedRoles = new Set();

  function captureRef(ref) {
    if (!ref || typeof ref !== "object") return null;
    const targetKey = ref.target_key;
    if (typeof targetKey !== "string" || targetKey === "") return null;
    if (capturedByTarget.has(targetKey)) return ref; // first-captured wins.
    capturedByTarget.set(targetKey, ref);
    return ref;
  }

  function recordLibraryLoad({ target_key, snapshot } = {}) {
    return captureRef(acceptedRefFromLoadedSnapshot(target_key, snapshot));
  }

  // The governing prompt is a tunable accepted-behavior (Seam 4); its
  // consumption MUST be recorded for undo-safety. Same capture as a library
  // load — it loads through the recorder at run-start, before the first turn.
  function recordGoverningLoad({ target_key, snapshot } = {}) {
    return captureRef(acceptedRefFromLoadedSnapshot(target_key, snapshot));
  }

  function recordExecutedRuntimeRole(runtime_role) {
    if (typeof runtime_role === "string" && runtime_role.trim() !== "") {
      executedRoles.add(runtime_role.trim());
    }
  }

  // The judge cross-path hook (Seam 3). I-3 implements the wiring in
  // appendQualityCheckAdvisory; here it is the minimal capture so a judge ref,
  // once built from the judge's own contract loader { targetKey, snapshotSha256 },
  // joins the same captured set, deduped by target_key.
  function recordJudgeRef({ target_key, snapshotSha256 } = {}) {
    if (typeof target_key !== "string" || target_key === "") return;
    if (typeof snapshotSha256 !== "string" || snapshotSha256 === "") return;
    captureRef({
      target_key,
      accepted_baseline_id: `sha256:${snapshotSha256}`,
      snapshot_sha256: snapshotSha256,
    });
  }

  // Reuse collectRunAcceptedRefs — no parallel structure. The runtime-defaults
  // rule ref is appended when an EXECUTED role consumed accepted defaults.
  function collectRefs({ config: collectConfig } = {}) {
    return collectRunAcceptedRefs({
      capturedPhaseRefs: [...capturedByTarget.values()],
      config: collectConfig ?? config,
      executedRoles: [...executedRoles],
    });
  }

  return {
    recordLibraryLoad,
    recordGoverningLoad,
    recordExecutedRuntimeRole,
    recordJudgeRef,
    collectRefs,
  };
}
