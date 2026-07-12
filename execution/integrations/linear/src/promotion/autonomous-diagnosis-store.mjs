import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  defaultPromotionRegistryDir,
  readJsonTolerant,
  writeRegistryFile,
} from "./registry-store.mjs";
import { resolveTeamiHome } from "../app-home.mjs";

export const AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION =
  "teami-autonomous-diagnosis/v1";

const SAFE_HASH_PATTERN = /^[a-f0-9]{64}$/i;

export function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function autonomousDiagnosisRecordPath({ registryDir, opportunityHash } = {}) {
  if (!SAFE_HASH_PATTERN.test(String(opportunityHash ?? ""))) {
    throw new Error(`invalid_opportunity_hash:${String(opportunityHash ?? "")}`);
  }
  return path.join(registryDir, `${opportunityHash}.json`);
}

export function buildAutonomousDiagnosisRecord({
  workflowType,
  evalNamespace,
  policy,
  evidenceQuery,
  evidenceWindow,
  targetSelection,
  scannerTrigger = {},
  improvementOpportunity,
} = {}) {
  const targetKey = nonEmptyString(targetSelection?.target_key)
    || nonEmptyString(improvementOpportunity?.target)
    || nonEmptyString(improvementOpportunity?.target_key);
  if (!targetKey) throw new Error("autonomous_diagnosis_target_key_required");
  const normalizedOpportunity = {
    status: "improvement_opportunity",
    ...plainObject(improvementOpportunity),
    target: targetKey,
    failure_mode_ids: arrayStrings(improvementOpportunity?.failure_mode_ids),
  };
  const normalizedPolicy = {
    version: nonEmptyString(policy?.version) || nonEmptyString(policy?.policy_version) || null,
    hash: nonEmptyString(policy?.hash) || nonEmptyString(policy?.policy_hash) || null,
    read_path: nonEmptyString(policy?.read_path) || null,
  };
  const normalizedEvidenceQuery = plainObject(evidenceQuery);
  const evidenceQueryHash = sha256CanonicalJson(normalizedEvidenceQuery);
  const normalizedEvidenceWindow = {
    started_at: nonEmptyString(evidenceWindow?.started_at) || null,
    ended_at: nonEmptyString(evidenceWindow?.ended_at) || null,
    freshness_window_days: Number.isInteger(evidenceWindow?.freshness_window_days)
      ? evidenceWindow.freshness_window_days
      : null,
  };
  const normalizedTargetSelection = {
    target_key: targetKey,
    selection_source: nonEmptyString(targetSelection?.selection_source) || "eval_namespace_manifest",
    manifest_path: nonEmptyString(targetSelection?.manifest_path) || null,
    selection_rule: nonEmptyString(targetSelection?.selection_rule) || null,
  };
  const dedupePayload = {
    workflow_type: nonEmptyString(workflowType) || "decomposition",
    target_key: targetKey,
    failure_mode_ids: normalizedOpportunity.failure_mode_ids,
    evidence_refs: plainObject(normalizedOpportunity.evidence_refs),
    evidence_query_hash: evidenceQueryHash,
    evidence_window: normalizedEvidenceWindow,
    policy_hash: normalizedPolicy.hash,
  };
  const dedupeHash = sha256CanonicalJson(dedupePayload);
  const opportunityHash = dedupeHash;
  return {
    schema_version: AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION,
    opportunity_hash: opportunityHash,
    source: "autonomous_diagnosis",
    workflow_type: nonEmptyString(workflowType) || "decomposition",
    eval_namespace: nonEmptyString(evalNamespace) || "execution/evals/decomposition",
    policy: normalizedPolicy,
    dedupe_key: {
      sha256: dedupeHash,
      fields: dedupePayload,
    },
    evidence_query: {
      provider: nonEmptyString(normalizedEvidenceQuery.provider) || "phoenix",
      project: nonEmptyString(normalizedEvidenceQuery.project) || null,
      datasets: Array.isArray(normalizedEvidenceQuery.datasets) ? normalizedEvidenceQuery.datasets : [],
      splits: Array.isArray(normalizedEvidenceQuery.splits) ? normalizedEvidenceQuery.splits : [],
      filters: plainObject(normalizedEvidenceQuery.filters),
      hash: evidenceQueryHash,
    },
    evidence_window: normalizedEvidenceWindow,
    target_selection: normalizedTargetSelection,
    scanner_trigger: {
      after_chain_state: nonEmptyString(scannerTrigger.after_chain_state) || "tagged",
      command: nonEmptyString(scannerTrigger.command) || "promotion:scan",
    },
    improvement_opportunity: normalizedOpportunity,
    events: [],
  };
}

export function writeAutonomousDiagnosisRecord({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registryDir = defaultPromotionRegistryDir(home),
  record,
} = {}) {
  void repoRoot;
  if (!record || record.schema_version !== AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION) {
    throw new Error("invalid_autonomous_diagnosis_record");
  }
  const filePath = autonomousDiagnosisRecordPath({
    registryDir,
    opportunityHash: record.opportunity_hash,
  });
  writeRegistryFile(filePath, record);
  return {
    ok: true,
    opportunity_hash: record.opportunity_hash,
    path: filePath,
    record,
  };
}

export function readAutonomousDiagnosisRecord({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registryDir = defaultPromotionRegistryDir(home),
  opportunityHash,
} = {}) {
  void repoRoot;
  const filePath = autonomousDiagnosisRecordPath({ registryDir, opportunityHash });
  if (!fs.existsSync(filePath)) return { ok: false, exists: false, path: filePath, reason: "autonomous_diagnosis_not_found" };
  const record = readJsonTolerant(filePath);
  if (!record) return { ok: false, exists: true, path: filePath, reason: "autonomous_diagnosis_unreadable" };
  if (record.schema_version !== AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION || record.source !== "autonomous_diagnosis") {
    return { ok: false, exists: true, path: filePath, reason: "autonomous_diagnosis_invalid" };
  }
  return { ok: true, exists: true, path: filePath, record };
}

export function appendAutonomousDiagnosisEvent({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registryDir = defaultPromotionRegistryDir(home),
  opportunityHash,
  event,
  now = () => new Date(),
} = {}) {
  const read = readAutonomousDiagnosisRecord({ repoRoot, home, registryDir, opportunityHash });
  if (!read.ok) return read;
  const before = read.record;
  const after = JSON.parse(JSON.stringify(before));
  after.events = [
    ...(after.events || []),
    {
      at: now().toISOString(),
      ...plainObject(event),
    },
  ];
  writeRegistryFile(read.path, after);
  return { ok: true, path: read.path, record: after };
}

export function listPendingAutonomousDiagnosisRecords({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registryDir = defaultPromotionRegistryDir(home),
} = {}) {
  void repoRoot;
  if (!fs.existsSync(registryDir)) return { ok: true, records: [] };
  const records = [];
  for (const name of fs.readdirSync(registryDir).sort()) {
    if (!/^[a-f0-9]{64}\.json$/i.test(name)) continue;
    const filePath = path.join(registryDir, name);
    const record = readJsonTolerant(filePath);
    if (record?.schema_version !== AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION) continue;
    if (record.source !== "autonomous_diagnosis") continue;
    if (autonomousDiagnosisRecordTerminal(record)) continue;
    records.push({
      opportunity_hash: record.opportunity_hash,
      path: filePath,
      record,
    });
  }
  return { ok: true, records };
}

export function autonomousDiagnosisRecordTerminal(record) {
  return (record?.events || []).some((event) =>
    [
      "autonomous_chain_completed",
      "autonomous_chain_failed",
      "autonomous_chain_skipped",
    ].includes(event?.action));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function arrayStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}
