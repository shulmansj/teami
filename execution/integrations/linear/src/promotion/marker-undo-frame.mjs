import { CANDIDATE_KINDS } from "./request-contract.mjs";

// ---------------------------------------------------------------------------
// S-UNDO: the static, proposal-time-knowable undo facts recorded on the PR
// marker, plus the post-merge accepted-version reference the read-time undo
// answer (B-READ) joins against.
//
// What is and is NOT here:
//   - HERE (static, knowable at proposal time): `undo_bounds`
//     (`what_undo_changes` + `external_side_effects`) and `merged_accepted_ref`
//     (the version the candidate BECOMES when merged).
//   - NOT here: `consumed_downstream` / `reversible`. Those are read-time facts
//     bounded by the PR's merge time and live-vs-eval run mode — persisting them
//     at proposal time would make them permanently false, so B-READ computes
//     them against the run-version records.
// ---------------------------------------------------------------------------

export const MARKER_UNDO_BOUNDS_SCHEMA_VERSION =
  "teami-marker-undo-bounds/v1";

// The candidate kinds the engine knows how to undo today: every CANDIDATE_KIND
// is a git-revertible committed-file edit, and the engine's only mutation is the
// single audited commit (no external system is touched). An UNKNOWN/future kind
// is fail-closed (treated as having external side effects) so the marker never
// claims a future kind is cleanly reversible without proof.
const KNOWN_NO_EXTERNAL_SIDE_EFFECT_KINDS = new Set(CANDIDATE_KINDS);

export function undoHasExternalSideEffects(candidateKind) {
  return !KNOWN_NO_EXTERNAL_SIDE_EFFECT_KINDS.has(candidateKind);
}

// A plain-English description of what undoing this change restores, branching by
// the materializer's human summary kind:
//   - runtime_role_defaults: describe the role/field reversions from
//     `humanSummary.changes[]` (promotion-materializer.mjs).
//   - prompt summaries: describe the accepted-version reversion from the
//     version fields (`old_pinned_version_id` / `old_snapshot_sha256_12`).
export function describeWhatUndoChanges(humanSummary = {}) {
  if (humanSummary?.kind === "runtime_role_defaults") {
    const changes = (Array.isArray(humanSummary.changes) ? humanSummary.changes : [])
      .filter((change) =>
        change
        && typeof change === "object"
        && typeof change.role === "string"
        && typeof change.field === "string")
      .map((change) => `${change.role}.${change.field}`);
    if (changes.length === 0) {
      return "Undo reverts the accepted default role assignments to the previously accepted values.";
    }
    return `Undo reverts the accepted default role assignments for: ${changes.join(", ")} (each back to its previously accepted value).`;
  }
  const oldVersion = firstNonEmptyString(
    humanSummary?.old_pinned_version_id,
    humanSummary?.old_snapshot_sha256_12,
  );
  if (oldVersion) {
    return `Undo restores the accepted behavior to the previously accepted version ${oldVersion}.`;
  }
  return "Undo restores the previously accepted behavior for this target.";
}

// Build the static marker undo-bounds frame (proposal-time facts only).
export function buildMarkerUndoBounds({ humanSummary, candidateKind } = {}) {
  return {
    schema_version: MARKER_UNDO_BOUNDS_SCHEMA_VERSION,
    what_undo_changes: describeWhatUndoChanges(humanSummary),
    external_side_effects: undoHasExternalSideEffects(candidateKind),
  };
}

// Build `marker.merged_accepted_ref`: the version the candidate BECOMES the
// accepted baseline when this PR merges, in the SAME normalized shape as a
// B-REFS `accepted_refs` entry (`normalizeAcceptedRef` in run-accepted-refs.mjs)
// — { target_key, accepted_baseline_id, snapshot_sha256 } — so B-READ joins
// like-for-like against the run-version records.
//
// Sourced from materializer output (the NEW snapshot/version the candidate
// produced), NOT the OLD `accepted_baseline_id` the marker already stores:
//   - runtime_role_defaults (rule): accepted_baseline_id = `sha256:<new_sha256>`,
//     snapshot_sha256 = `<new_sha256>` (mirrors resolveAcceptedBaseline's rule
//     branch: `sha256:<artifactSha256>` + the bare sha).
//   - prompt: accepted_baseline_id = the new pinned version id (falling back to
//     `sha256:<new_sha256>` when no version id, mirroring the resolver's
//     `entry.accepted_prompt_version_id || sha256:<snapshot>`),
//     snapshot_sha256 = the new full snapshot sha.
// Returns null when the post-merge snapshot is not derivable (the field is then
// omitted; B-READ treats a missing join key as `unknown`).
export function buildMergedAcceptedRef({
  candidateTargetKey,
  humanSummary,
  changedArtifacts,
} = {}) {
  if (!nonEmptyString(candidateTargetKey)) return null;
  const isRuntimeDefaults = humanSummary?.kind === "runtime_role_defaults";
  const artifactKind = isRuntimeDefaults ? "runtime_role_defaults" : "accepted_prompt";
  const newSha256 = newSnapshotShaForKind(changedArtifacts, artifactKind);
  if (!nonEmptyString(newSha256)) return null;

  if (isRuntimeDefaults) {
    return {
      target_key: candidateTargetKey,
      accepted_baseline_id: `sha256:${newSha256}`,
      snapshot_sha256: newSha256,
    };
  }
  return {
    target_key: candidateTargetKey,
    accepted_baseline_id: firstNonEmptyString(
      humanSummary?.new_pinned_version_id,
      `sha256:${newSha256}`,
    ),
    snapshot_sha256: newSha256,
  };
}

function newSnapshotShaForKind(changedArtifacts, artifactKind) {
  if (!Array.isArray(changedArtifacts)) return null;
  const entry = changedArtifacts.find(
    (artifact) => artifact && typeof artifact === "object" && artifact.kind === artifactKind,
  );
  return nonEmptyString(entry?.new_sha256) ? entry.new_sha256 : null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
