import fs from "node:fs";
import path from "node:path";

import { resolveDefaultBranchRef } from "../promotion-policy.mjs";
import { defaultRunGit } from "../promotion-workspace.mjs";
import { gitShowText } from "./baseline-resolver.mjs";
import {
  normalizeRepoRelativePath,
  readJsonTolerant,
  setCandidateStatus,
} from "./ledger-store.mjs";

export const REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION =
  "teami-repo-candidate-artifact-stub/v1";

async function readTrustedRepoArtifactJson({ internalCloneDir, ref, relativePath }) {
  const read = await gitShowText({ internalCloneDir, ref, relativePath });
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail };
  try {
    return { ok: true, artifact: JSON.parse(read.text) };
  } catch (error) {
    return { ok: false, reason: "repo_candidate_artifact_stub_unreadable", detail: error.message };
  }
}

async function listTrustedRepoArtifactPaths({ internalCloneDir, ref, directory, extension }) {
  const result = await defaultRunGit(["ls-tree", "-r", "--name-only", ref, "--", directory], {
    cwd: internalCloneDir,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: "repo_candidate_artifact_directory_unreadable",
      detail: result.stderr.trim() || result.stdout.trim(),
      paths: [],
    };
  }
  return {
    ok: true,
    paths: result.stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(extension))
      .sort(),
  };
}

export async function scanRepoCandidateArtifactStubs({ repoRoot, policy, trustedClone = null }) {
  const stubs = policy.scanner_routing.repo_candidate_artifact_stubs || [];
  const candidates = [];
  const root = path.resolve(repoRoot);
  let trustedRef = null;
  if (trustedClone) {
    const head = await resolveDefaultBranchRef({ internalCloneDir: trustedClone.internalCloneDir });
    if (!head.ok) {
      candidates.push(setCandidateStatus({
        candidate_key: "repo-artifact-trusted-ref",
        source: "repo_candidate_artifact_stub",
        evidence: { repo_candidate_artifact_stub: true },
      }, "needs_reconciliation", head.reason, head.detail ?? null));
      return candidates;
    }
    trustedRef = head.ref;
  }
  for (const descriptor of stubs) {
    const relativeDir = normalizeRepoRelativePath(descriptor.directory);
    if (!relativeDir) {
      candidates.push(setCandidateStatus({
        candidate_key: `repo-artifact-descriptor:${descriptor.directory}`,
        source: "repo_candidate_artifact_stub",
        evidence: { repo_candidate_artifact_stub: true },
      }, "needs_reconciliation", "repo_candidate_artifact_path_outside_repo", descriptor.directory));
      continue;
    }
    const extension = descriptor.file_extension || ".candidate.json";
    let entries;
    if (trustedClone) {
      const listed = await listTrustedRepoArtifactPaths({
        internalCloneDir: trustedClone.internalCloneDir,
        ref: trustedRef,
        directory: relativeDir,
        extension,
      });
      if (!listed.ok) {
        candidates.push(setCandidateStatus({
          candidate_key: `repo-artifact-descriptor:${relativeDir}`,
          source: "repo_candidate_artifact_stub",
          evidence: { repo_candidate_artifact_stub: true },
        }, "needs_reconciliation", listed.reason, listed.detail ?? null));
        continue;
      }
      entries = [];
      for (const relativePath of listed.paths) {
        const read = await readTrustedRepoArtifactJson({
          internalCloneDir: trustedClone.internalCloneDir,
          ref: trustedRef,
          relativePath,
        });
        entries.push({
          relativePath,
          filePath: `${trustedRef}:${relativePath}`,
          artifact: read.ok ? read.artifact : null,
          readReason: read.ok ? null : read.reason,
          readDetail: read.ok ? null : read.detail,
        });
      }
    } else {
      const directory = path.resolve(repoRoot, relativeDir);
      if (!directory.startsWith(`${root}${path.sep}`) && directory !== root) {
        candidates.push(setCandidateStatus({
          candidate_key: `repo-artifact-descriptor:${descriptor.directory}`,
          source: "repo_candidate_artifact_stub",
          evidence: { repo_candidate_artifact_stub: true },
        }, "needs_reconciliation", "repo_candidate_artifact_path_outside_repo", descriptor.directory));
        continue;
      }
      if (!fs.existsSync(directory)) continue;
      entries = fs.readdirSync(directory)
        .filter((name) => name.endsWith(extension))
        .sort()
        .map((name) => {
          const filePath = path.join(directory, name);
          return {
            relativePath: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
            filePath,
            artifact: readJsonTolerant(filePath),
            readReason: null,
            readDetail: null,
          };
        });
    }
    for (const entry of entries) {
      const artifact = entry.artifact;
      const base = {
        candidate_key: `repo-artifact:${entry.relativePath}`,
        source: "repo_candidate_artifact_stub",
        artifact_path: entry.filePath,
        evidence: { repo_candidate_artifact_stub: true },
      };
      if (!artifact || artifact.schema_version !== REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION) {
        candidates.push(setCandidateStatus(
          base,
          "needs_reconciliation",
          entry.readReason || "repo_candidate_artifact_stub_unreadable",
          entry.readDetail || entry.filePath,
        ));
        continue;
      }
      Object.assign(base, {
        candidate_target_key: artifact.candidate_target_key ?? null,
        candidate_version_id: artifact.candidate_version_id ?? null,
        experiment_id: artifact.experiment_id ?? null,
        dataset_version_id: artifact.dataset_version_id ?? null,
      });
      if (artifact.intent !== policy.scanner_routing.explicit_intent_signals.repo_candidate_artifact_intent) {
        candidates.push(setCandidateStatus(base, "discovered_evidence_without_intent", "repo_candidate_artifact_intent_not_promotion_candidate", artifact.intent ?? null));
        continue;
      }
      candidates.push(setCandidateStatus(
        base,
        "needs_reconciliation",
        "repo_candidate_artifact_requires_managed_receipt_in_mvp",
        "repo-owned artifact stubs are detected only when policy describes them; the current controller still requires a managed receipt experiment join before auto-proposal",
      ));
    }
  }
  return candidates;
}
