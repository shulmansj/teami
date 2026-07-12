import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXECUTION_READINESS_SCHEMA_VERSION = "teami-product-execution-readiness/v1";
export const EXECUTION_READINESS_EVIDENCE_KEYS = Object.freeze([
  "runtime_credential_containment",
  "agent_tool_environment_isolation",
  "os_process_isolation",
  "recoverable_git_effects",
  "domain_confinement",
  "no_push_on_safety_failure",
]);
export const PRODUCT_REPO_EXECUTION_DISABLED_REASON = "product_repo_execution_not_released";

const MANIFEST_URL = new URL("./execution-readiness-manifest.json", import.meta.url);

export function readShippedExecutionReadinessManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_URL, "utf8"));
}

export function evaluateExecutionReadinessManifest(
  manifest,
  { expectedCommit = null, artifactRoot = fileURLToPath(new URL("../../../..", import.meta.url)) } = {},
) {
  const failures = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, enabled: false, failures: ["manifest_not_object"] };
  }
  if (manifest.schema_version !== EXECUTION_READINESS_SCHEMA_VERSION) {
    failures.push("schema_version_invalid");
  }
  if (manifest.enabled !== true) failures.push("release_disabled");
  if (typeof manifest.release_commit !== "string" || !/^[0-9a-f]{40}$/i.test(manifest.release_commit)) {
    failures.push("release_commit_missing");
  } else if (expectedCommit && manifest.release_commit !== expectedCommit) {
    failures.push("release_commit_mismatch");
  }
  for (const key of EXECUTION_READINESS_EVIDENCE_KEYS) {
    const evidence = manifest.evidence?.[key];
    if (evidence?.status !== "verified") failures.push(`${key}:not_verified`);
    if (!Array.isArray(evidence?.artifacts) || evidence.artifacts.length === 0) {
      failures.push(`${key}:artifacts_missing`);
    } else {
      for (const artifact of evidence.artifacts) {
        const failure = validateEvidenceArtifact(artifact, { artifactRoot, expectedCommit: manifest.release_commit });
        if (failure) failures.push(`${key}:${failure}`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    enabled: manifest.enabled === true,
    failures: [...new Set(failures)],
    release_commit: manifest.release_commit || null,
  };
}

function validateEvidenceArtifact(artifact, { artifactRoot, expectedCommit }) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return "artifact_invalid";
  if (artifact.commit !== expectedCommit) return "artifact_commit_mismatch";
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256 || "")) return "artifact_sha256_invalid";
  if (!Array.isArray(artifact.tests) || artifact.tests.length === 0 || artifact.tests.some((value) =>
    typeof value !== "string" || value.trim() === ""
  )) return "artifact_tests_missing";
  if (!Number.isFinite(Date.parse(artifact.verified_at || ""))) return "artifact_verified_at_invalid";
  if (typeof artifact.path !== "string" || artifact.path.trim() === "" || path.isAbsolute(artifact.path)) {
    return "artifact_path_invalid";
  }
  const root = path.resolve(artifactRoot);
  const resolved = path.resolve(root, artifact.path);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return "artifact_path_escape";
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return "artifact_missing";
  const actual = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
  return actual === artifact.sha256.toLowerCase() ? null : "artifact_hash_mismatch";
}

export function evaluateRunningExecutionReadiness(
  manifest,
  { artifactRoot = fileURLToPath(new URL("../../../..", import.meta.url)) } = {},
) {
  const expectedCommit = readRunningReleaseCommit({ artifactRoot });
  const evaluated = evaluateExecutionReadinessManifest(manifest, { expectedCommit, artifactRoot });
  if (expectedCommit) return evaluated;
  return {
    ...evaluated,
    ok: false,
    failures: [...new Set([...evaluated.failures, "running_release_commit_unbound"])],
  };
}

export function readRunningReleaseCommit({ artifactRoot } = {}) {
  const root = path.resolve(artifactRoot || fileURLToPath(new URL("../../../..", import.meta.url)));
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const match = String(packageJson.version || "").match(/-sha([0-9a-f]{40})(?:\.|$)/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function shippedExecutionReadiness() {
  return evaluateRunningExecutionReadiness(readShippedExecutionReadinessManifest());
}

export function shippedExecutionTriggers(triggers = []) {
  return shippedExecutionReadiness().ok ? [...triggers] : [];
}
