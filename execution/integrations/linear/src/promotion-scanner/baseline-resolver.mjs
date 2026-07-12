import fs from "node:fs";
import path from "node:path";

import { deriveLaunchBaselineFromManifest } from "../phoenix-experiment.mjs";
import { resolveDefaultBranchRef } from "../promotion-policy.mjs";
import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../promotion-target-keys.mjs";
import { defaultRunGit } from "../promotion-workspace.mjs";
import { resolveAcceptedBaseline } from "./accepted-baseline.mjs";
import {
  sha256,
} from "./ledger-store.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "../workflows/decomposition/eval-paths.mjs";

export async function gitShowText({ internalCloneDir, ref, relativePath }) {
  const result = await defaultRunGit(["show", `${ref}:${relativePath}`], { cwd: internalCloneDir });
  if (!result.ok) {
    return {
      ok: false,
      reason: "trusted_repo_artifact_unreadable",
      detail: `git show ${ref}:${relativePath} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  return { ok: true, text: result.stdout };
}

function mapTrustedCloneResolutionFailure(resolution, candidateTargetKey, headRef) {
  if (resolution.reason === "accepted_prompt_target_unavailable") {
    return {
      ok: false,
      reason: "trusted_phoenix_assets_missing_prompt_target",
      detail: `phoenix-assets.json has no prompt entry for ${candidateTargetKey} at default-branch HEAD.`,
    };
  }
  if (resolution.reason === "accepted_prompt_snapshot_path_invalid") {
    return {
      ok: false,
      reason: "trusted_prompt_snapshot_path_invalid",
      detail: resolution.detail,
    };
  }
  if (resolution.reason === "accepted_prompt_snapshot_drift") {
    return {
      ok: false,
      reason: "accepted_prompt_snapshot_drift",
      detail: String(resolution.detail || "").replace("snapshot ", "trusted snapshot ")
        .replace("phoenix-assets.json pins", `phoenix-assets.json at ${headRef} pins`),
    };
  }
  return resolution;
}

function mapActiveManifestResolutionFailure(resolution, candidateTargetKey) {
  if (resolution.reason === "accepted_prompt_target_unavailable") {
    return {
      ok: false,
      reason: "trusted_phoenix_assets_missing_prompt_target",
      detail: `phoenix-assets.json has no prompt entry for ${candidateTargetKey}.`,
    };
  }
  if (resolution.reason === "accepted_prompt_snapshot_path_invalid") {
    return {
      ok: false,
      reason: "trusted_prompt_snapshot_path_invalid",
      detail: resolution.detail,
    };
  }
  return resolution;
}

function baselineFromResolution({
  resolution,
  derivedFrom,
  manifestPath,
  manifestSource,
  manifestSha256,
  candidateTargetKey,
}) {
  return {
    derived_from: derivedFrom,
    manifest_path: manifestPath,
    manifest_source: manifestSource,
    manifest_sha256: manifestSha256,
    candidate_target_key: candidateTargetKey,
    ...(resolution.prompt_role ? { prompt_role: resolution.prompt_role } : {}),
    ...(resolution.prompt_role ? {} : { artifact_kind: resolution.artifact_kind }),
    accepted_baseline_id: resolution.accepted_baseline_id,
    accepted_artifact_hash_vector: resolution.accepted_artifact_hash_vector,
    accepted_dataset_version_ids: resolution.accepted_dataset_version_ids,
  };
}

function parsePhoenixAssetsManifest({ text, source }) {
  try {
    return {
      ok: true,
      manifest: JSON.parse(text),
      manifestText: text,
      manifestSha256: sha256(text),
      manifestPath: DECOMPOSITION_EVAL_PATHS.manifest,
      manifestSource: source,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "trusted_phoenix_assets_invalid",
      detail: error.message,
    };
  }
}

export async function readPhoenixAssetsManifestFromTrustedClone({ internalCloneDir } = {}) {
  const head = await resolveDefaultBranchRef({ internalCloneDir });
  if (!head.ok) return head;
  const manifestRead = await gitShowText({
    internalCloneDir,
    ref: head.ref,
    relativePath: DECOMPOSITION_EVAL_PATHS.manifest,
  });
  if (!manifestRead.ok) return manifestRead;
  const parsed = parsePhoenixAssetsManifest({
    text: manifestRead.text,
    source: `${head.ref}:${DECOMPOSITION_EVAL_PATHS.manifest}`,
  });
  if (!parsed.ok) return parsed;
  return { ...parsed, headRef: head.ref };
}

export function readPhoenixAssetsManifestFromActiveCheckout({
  repoRoot = process.cwd(),
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const manifestPath = path.join(resolvedRoot, DECOMPOSITION_EVAL_PATHS.manifest);
  try {
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    return parsePhoenixAssetsManifest({
      text: manifestText,
      source: DECOMPOSITION_EVAL_PATHS.manifest,
    });
  } catch {
    const fallback = deriveLaunchBaselineFromManifest({ repoRoot });
    if (!fallback.ok) return mapActiveManifestResolutionFailure(fallback, DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY);
    return {
      ok: true,
      manifest: fallback.manifest,
      manifestText: null,
      manifestSha256: fallback.baseline?.manifest_sha256 ?? null,
      manifestPath: fallback.baseline?.manifest_path ?? DECOMPOSITION_EVAL_PATHS.manifest,
      manifestSource: fallback.baseline?.manifest_path ?? DECOMPOSITION_EVAL_PATHS.manifest,
    };
  }
}

export async function deriveLaunchBaselineFromTrustedClone({ internalCloneDir, candidateTargetKey = DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } = {}) {
  const manifestRead = await readPhoenixAssetsManifestFromTrustedClone({ internalCloneDir });
  if (!manifestRead.ok) return manifestRead;
  const referencedPath = trustedBaselineArtifactPath(manifestRead.manifest, candidateTargetKey);
  const artifactRead = referencedPath
    ? await gitShowText({ internalCloneDir, ref: manifestRead.headRef, relativePath: referencedPath })
    : null;
  const resolution = resolveAcceptedBaseline({
    manifest: manifestRead.manifest,
    manifestBytes: manifestRead.manifestText,
    candidateTargetKey,
    readArtifactBytes: (relativePath) => relativePath === referencedPath
      ? artifactRead
      : { ok: false, reason: "accepted_artifact_unavailable", detail: relativePath },
  });
  if (!resolution.ok) {
    return mapTrustedCloneResolutionFailure(resolution, candidateTargetKey, manifestRead.headRef);
  }
  return {
    ok: true,
    manifest: manifestRead.manifest,
    baseline: baselineFromResolution({
      resolution,
      derivedFrom: "trusted_internal_clone_phoenix_assets_manifest",
      manifestPath: manifestRead.manifestPath,
      manifestSource: manifestRead.manifestSource,
      manifestSha256: manifestRead.manifestSha256,
      candidateTargetKey,
    }),
  };
}

function trustedBaselineArtifactPath(manifest, candidateTargetKey) {
  const prompt = (manifest?.prompts || []).find((entry) =>
    entry?.target_key === candidateTargetKey
      || (candidateTargetKey === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY
        && entry?.role === "decomposition_quality_judge"));
  if (prompt?.snapshot_path) return String(prompt.snapshot_path).replaceAll("\\", "/");
  const rule = (manifest?.rules || []).find((entry) => entry?.target_key === candidateTargetKey);
  if (rule?.artifact_path) return String(rule.artifact_path).replaceAll("\\", "/");
  return null;
}

export function deriveLaunchBaselineFromActiveManifest({
  repoRoot = process.cwd(),
  candidateTargetKey = DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const manifestRead = readPhoenixAssetsManifestFromActiveCheckout({ repoRoot });
  if (!manifestRead.ok) return manifestRead;
  if (manifestRead.manifestText === null) {
    return deriveLaunchBaselineFromManifest({ candidateTargetKey, repoRoot });
  }
  const resolution = resolveAcceptedBaseline({
    manifest: manifestRead.manifest,
    manifestBytes: manifestRead.manifestText,
    candidateTargetKey,
    readArtifactBytes: (relativePath) => {
      try {
        return { ok: true, bytes: fs.readFileSync(path.join(resolvedRoot, relativePath)) };
      } catch (error) {
        return { ok: false, reason: "trusted_repo_artifact_unreadable", detail: error.message };
      }
    },
  });
  if (!resolution.ok) return mapActiveManifestResolutionFailure(resolution, candidateTargetKey);
  return {
    ok: true,
    manifest: manifestRead.manifest,
    baseline: baselineFromResolution({
      resolution,
      derivedFrom: "active_checkout_phoenix_assets_manifest",
      manifestPath: manifestRead.manifestPath,
      manifestSource: manifestRead.manifestSource,
      manifestSha256: manifestRead.manifestSha256,
      candidateTargetKey,
    }),
  };
}
