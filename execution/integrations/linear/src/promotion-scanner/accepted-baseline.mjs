import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../promotion-target-keys.mjs";
import { canonicalJson } from "../promotion/registry-store.mjs";
import {
  normalizeRepoRelativePath,
  sha256,
} from "./ledger-store.mjs";

function acceptedDatasetVersionIds(manifest) {
  return Object.fromEntries(
    (manifest.datasets || []).map((dataset) => [dataset.name, dataset.accepted_dataset_version_id ?? null]),
  );
}

function bytesForHash(readResult) {
  if (Object.hasOwn(readResult, "bytes")) return readResult.bytes;
  if (Object.hasOwn(readResult, "text")) return readResult.text;
  return "";
}

function manifestPromptEntryForTarget(manifest, candidateTargetKey) {
  return (manifest.prompts || []).find((prompt) =>
    prompt?.target_key === candidateTargetKey
      || (candidateTargetKey === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY
        && prompt?.role === "decomposition_quality_judge"))
    || null;
}

function manifestRuleEntryForTarget(manifest, candidateTargetKey) {
  return (manifest.rules || []).find((rule) => rule?.target_key === candidateTargetKey) || null;
}

export function acceptedStateHash(manifest = {}) {
  const manifestMinusRunHistory = { ...(manifest || {}) };
  delete manifestMinusRunHistory.experiments;
  delete manifestMinusRunHistory.evidence;
  return sha256(canonicalJson(manifestMinusRunHistory));
}

export function resolveAcceptedBaseline({
  manifest,
  candidateTargetKey,
  readArtifactBytes,
} = {}) {
  const targetKey = candidateTargetKey || DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY;
  const datasetVersionIds = acceptedDatasetVersionIds(manifest || {});

  if (typeof targetKey === "string" && targetKey.startsWith("prompt/")) {
    const entry = manifestPromptEntryForTarget(manifest, targetKey);
    if (!entry) {
      return {
        ok: false,
        reason: "accepted_prompt_target_unavailable",
        detail: targetKey,
      };
    }
    const snapshotPath = normalizeRepoRelativePath(entry.snapshot_path);
    if (!snapshotPath) {
      return {
        ok: false,
        reason: "accepted_prompt_snapshot_path_invalid",
        detail: String(entry.snapshot_path ?? ""),
      };
    }
    const snapshotRead = readArtifactBytes(snapshotPath);
    if (!snapshotRead.ok) return snapshotRead;
    const snapshotSha256 = sha256(bytesForHash(snapshotRead));
    if (snapshotSha256 !== entry.snapshot_sha256) {
      return {
        ok: false,
        reason: "accepted_prompt_snapshot_drift",
        detail: `snapshot ${snapshotPath} hashes to ${snapshotSha256} but phoenix-assets.json pins ${entry.snapshot_sha256}.`,
      };
    }
    return {
      ok: true,
      accepted_baseline_id: entry.accepted_prompt_version_id || `sha256:${snapshotSha256}`,
      artifact_kind: "accepted_prompt",
      snapshot_path: snapshotPath,
      prompt_role: entry.role,
      accepted_artifact_hash_vector: {
        snapshot_sha256: snapshotSha256,
        accepted_prompt_version_id: entry.accepted_prompt_version_id ?? null,
      },
      accepted_dataset_version_ids: datasetVersionIds,
    };
  }

  if (typeof targetKey === "string" && targetKey.startsWith("rule/")) {
    const entry = manifestRuleEntryForTarget(manifest, targetKey);
    if (!entry) {
      return {
        ok: false,
        reason: "accepted_artifact_target_unavailable",
        detail: targetKey,
      };
    }
    const artifactPath = normalizeRepoRelativePath(entry.artifact_path);
    if (!artifactPath) {
      return {
        ok: false,
        reason: "accepted_rule_artifact_path_invalid",
        detail: String(entry.artifact_path ?? ""),
      };
    }
    const artifactRead = readArtifactBytes(artifactPath);
    if (!artifactRead.ok) return artifactRead;
    const artifactSha256 = sha256(bytesForHash(artifactRead));
    if (artifactSha256 !== entry.snapshot_sha256) {
      return {
        ok: false,
        reason: "accepted_rule_snapshot_drift",
        detail: `artifact ${artifactPath} hashes to ${artifactSha256} but phoenix-assets.json pins ${entry.snapshot_sha256}.`,
      };
    }
    return {
      ok: true,
      accepted_baseline_id: `sha256:${artifactSha256}`,
      artifact_kind: entry.artifact_kind,
      artifact_path: artifactPath,
      accepted_artifact_hash_vector: {
        snapshot_sha256: artifactSha256,
      },
      accepted_dataset_version_ids: datasetVersionIds,
    };
  }

  if (targetKey === "policy/decomposition/accepted_baseline") {
    const acceptedStateSha256 = acceptedStateHash(manifest);
    return {
      ok: true,
      accepted_baseline_id: `sha256:${acceptedStateSha256}`,
      artifact_kind: "accepted_baseline_manifest",
      accepted_artifact_hash_vector: {
        accepted_state_sha256: acceptedStateSha256,
      },
      accepted_dataset_version_ids: datasetVersionIds,
    };
  }

  return {
    ok: false,
    reason: "accepted_artifact_target_unavailable",
    detail: String(targetKey ?? ""),
  };
}
