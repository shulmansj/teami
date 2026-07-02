import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../../../engine/run-store.mjs";

export const PROMOTION_REGISTRY_SCHEMA_VERSION =
  "teami-promotion-candidate-registry/v1";

export const PROMOTION_REGISTRY_STAGES = Object.freeze([
  "validated", "gate_evaluated", "improvement_opportunity", "drafted", "committed", "pr_created", "blocked",
  "phoenix_outcome_recorded",
]);

export function readJsonTolerant(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalized envelope idempotency (CONSTRAINTS #11): sha256 over candidate
// target, candidate version, accepted baseline, decision policy hash, sorted
// Phoenix evidence IDs, requested action, and Phoenix scope. No caller retry
// tokens. The annotation-id set is part of the envelope on purpose: new
// annotations are materially new evidence and produce a NEW envelope.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function computeNormalizedEnvelope({
  candidateTargetKey,
  candidateVersionId,
  acceptedBaselineId,
  policyHash,
  evidenceIds,
  requestedAction,
  phoenixScope,
} = {}) {
  const envelope = {
    candidate_target_key: candidateTargetKey,
    candidate_version_id: candidateVersionId,
    accepted_baseline_id: acceptedBaselineId,
    policy_hash: policyHash,
    evidence_ids: {
      experiments: [...(evidenceIds?.experiments || [])].sort(),
      datasets: [...(evidenceIds?.datasets || [])]
        .map((entry) => ({
          dataset_id: entry.dataset_id,
          dataset_version_id: entry.dataset_version_id,
        }))
        .sort((a, b) => String(a.dataset_id).localeCompare(String(b.dataset_id))),
      annotations: [...(evidenceIds?.annotations || [])].sort(),
      prompt_versions: [...(evidenceIds?.prompt_versions || [])].sort(),
    },
    requested_action: requestedAction,
    phoenix_scope: {
      origin: phoenixScope?.origin ?? null,
      project_name: phoenixScope?.project_name ?? null,
    },
  };
  const hash = createHash("sha256").update(canonicalJson(envelope)).digest("hex");
  return { envelope, hash };
}

// ---------------------------------------------------------------------------
// Durable local registry (.teami/promotion-candidates/
// <envelope-hash>.json): atomic writes, append-only events, one row per
// normalized envelope. The registry is recovery state and a budget CACHE —
// budgets/dedupe truth stays with repo-visible PR markers (CONSTRAINTS #10).
// ---------------------------------------------------------------------------

export function defaultPromotionRegistryDir(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, ".teami", "promotion-candidates");
}

export function promotionRegistryPath({ registryDir, envelopeHash }) {
  return path.join(registryDir, `${envelopeHash}.json`);
}

export function writeRegistryFile(filePath, record) {
  const normalized = JSON.parse(JSON.stringify(record));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(tempPath, "utf8"));
  renameWithRetry(tempPath, filePath);
  return filePath;
}

export function readPromotionRegistryRecord({ registryDir, envelopeHash }) {
  const filePath = promotionRegistryPath({ registryDir, envelopeHash });
  if (!fs.existsSync(filePath)) return { exists: false, path: filePath, record: null };
  const record = readJsonTolerant(filePath);
  if (!record) return { exists: true, path: filePath, record: null, unreadable: true };
  return { exists: true, path: filePath, record };
}

function assertAppendOnlyRegistryUpdate(before, after) {
  for (const key of ["schema_version", "normalized_envelope_hash", "proposal_instance_id", "candidate_target_key"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`promotion registry fact "${key}" is immutable`);
    }
  }
  const beforeEvents = before.events || [];
  const afterEvents = after.events || [];
  if (afterEvents.length < beforeEvents.length) {
    throw new Error("promotion registry events may only be appended to");
  }
  for (let index = 0; index < beforeEvents.length; index += 1) {
    if (JSON.stringify(beforeEvents[index]) !== JSON.stringify(afterEvents[index])) {
      throw new Error(`promotion registry events[${index}] was rewritten (append-only)`);
    }
  }
}

export function appendRegistryStage({ registryDir, envelopeHash, stage, detail = {}, patch = {}, now }) {
  const current = readPromotionRegistryRecord({ registryDir, envelopeHash });
  if (!current.exists || !current.record) {
    throw new Error(`promotion registry row missing for envelope ${envelopeHash}`);
  }
  const before = current.record;
  const after = JSON.parse(JSON.stringify(before));
  Object.assign(after, JSON.parse(JSON.stringify(patch)));
  after.last_stage = stage;
  after.events = [...(after.events || []), { stage, at: now().toISOString(), ...detail }];
  assertAppendOnlyRegistryUpdate(before, after);
  writeRegistryFile(current.path, after);
  return after;
}
