import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";
import { writeAtomicFile } from "../../../engine/atomic-file.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import { normalizeLegacyMutationJournalForRead } from "../../../engine/legacy-team-state-compat.mjs";

export const MUTATION_RECONCILIATION_SCHEMA_VERSION =
  "teami-mutation-reconciliation/v1";

export function mutationReconciliationJournalPath(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, "reconciliation", "mutations.jsonl");
}

export function appendMutationReconciliation({
  home = resolveTeamiHome(),
  journalPath = mutationReconciliationJournalPath(home),
  teamRef,
  objectType,
  objectId,
  runId,
  wakeId,
  status,
  reason = null,
  intentDigest,
  artifactKind,
  effectEvidenceDigest,
  providerUpdateIds = [],
  reconciledAt = new Date().toISOString(),
  onBoundary = () => {},
} = {}) {
  const scope = requiredScope({ teamRef, objectType, objectId, runId, wakeId });
  const lock = acquireExclusiveFileLock({
    lockPath: `${journalPath}.lock`,
    purpose: "mutation_reconciliation_journal",
  });
  if (!lock.ok) throw new Error(`mutation_reconciliation_journal_${lock.reason}`);

  try {
    const records = readMutationReconciliationJournal({ journalPath });
    const priorHash = records.at(-1)?.record_hash || null;
    const unsigned = {
      schema_version: MUTATION_RECONCILIATION_SCHEMA_VERSION,
      record_id: randomUUID(),
      event: "external_mutation_reconciled",
      ...scope,
      status: requiredString(status, "status"),
      reason: optionalString(reason),
      intent_digest: requiredSha256(intentDigest, "intentDigest"),
      artifact_kind: requiredString(artifactKind, "artifactKind"),
      effect_evidence_digest: requiredSha256(effectEvidenceDigest, "effectEvidenceDigest"),
      provider_update_ids: normalizedOpaqueIds(providerUpdateIds),
      reconciled_at: requiredIso(reconciledAt, "reconciledAt"),
      prior_record_hash: priorHash,
    };
    const record = { ...unsigned, record_hash: hashRecord(unsigned) };
    const nextContents = `${records.map((entry) => JSON.stringify(entry)).join("\n")}${records.length > 0 ? "\n" : ""}${JSON.stringify(record)}\n`;
    writeAtomicFile({
      filePath: journalPath,
      contents: nextContents,
      validateTemp: (candidatePath) => readMutationReconciliationJournal({ journalPath: candidatePath }),
      validateCommitted: (candidatePath) => readMutationReconciliationJournal({ journalPath: candidatePath }),
      onBoundary,
    });
    return record;
  } finally {
    lock.release();
  }
}

export function readMutationReconciliationJournal({
  home = resolveTeamiHome(),
  journalPath = mutationReconciliationJournalPath(home),
} = {}) {
  if (!fs.existsSync(journalPath)) return [];
  const text = fs.readFileSync(journalPath, "utf8");
  if (text.trim() === "") return [];
  const parsedRecords = text.trimEnd().split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`mutation_reconciliation_journal_invalid_json:${index + 1}`);
    }
  });
  const records = normalizeLegacyMutationJournalForRead(parsedRecords);
  let priorHash = null;
  for (const [index, record] of records.entries()) {
    validateRecord(record, { index, priorHash });
    priorHash = record.record_hash;
  }
  return records;
}

export function findMutationReconciliation({
  records = [],
  teamRef,
  objectType,
  objectId,
  runId,
} = {}) {
  return [...records].reverse().find((record) =>
    record.team_ref === teamRef &&
    record.object_type === objectType &&
    record.object_id === objectId &&
    record.run_id === runId
  ) || null;
}

export function planMutationRecovery({ intent = null, receipt = null, terminalWake = null } = {}) {
  const hasIntent = Boolean(intent);
  const hasReceipt = Boolean(receipt);
  const terminalReferencesReceipt = Boolean(
    terminalWake && receipt &&
    terminalWake.mutation_reconciliation?.receipt_id === receipt.record_id &&
    terminalWake.mutation_reconciliation?.receipt_hash === receipt.record_hash,
  );

  if (!hasIntent && !hasReceipt) return { state: "none", action: "none" };
  if (hasIntent && !hasReceipt) return { state: "intent_only", action: "reconcile_external_effect" };
  if (hasIntent && hasReceipt) {
    return terminalReferencesReceipt
      ? { state: "intent_and_receipt", action: "clear_redundant_intent" }
      : { state: "intent_and_receipt", action: "persist_terminal_then_clear_intent" };
  }
  return terminalReferencesReceipt
    ? { state: "receipt_only", action: "done" }
    : { state: "receipt_only", action: "reconstruct_terminal_from_receipt" };
}

function validateRecord(record, { index, priorHash }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`mutation_reconciliation_journal_invalid_record:${index + 1}`);
  }
  if (record.schema_version !== MUTATION_RECONCILIATION_SCHEMA_VERSION) {
    throw new Error(`mutation_reconciliation_journal_schema_unsupported:${index + 1}`);
  }
  requiredScope({
    teamRef: record.team_ref,
    objectType: record.object_type,
    objectId: record.object_id,
    runId: record.run_id,
    wakeId: record.wake_id,
  });
  requiredString(record.record_id, "record_id");
  requiredString(record.status, "status");
  requiredSha256(record.intent_digest, "intent_digest");
  requiredString(record.artifact_kind, "artifact_kind");
  requiredSha256(record.effect_evidence_digest, "effect_evidence_digest");
  if (!Array.isArray(record.provider_update_ids) || record.provider_update_ids.length === 0) {
    throw new Error(`mutation_reconciliation_journal_provider_evidence_missing:${index + 1}`);
  }
  requiredIso(record.reconciled_at, "reconciled_at");
  if (record.prior_record_hash !== priorHash) {
    throw new Error(`mutation_reconciliation_journal_chain_mismatch:${index + 1}`);
  }
  const { record_hash: actualHash, ...unsigned } = record;
  if (actualHash !== hashRecord(unsigned)) {
    throw new Error(`mutation_reconciliation_journal_hash_mismatch:${index + 1}`);
  }
}

function requiredScope({ teamRef, objectType, objectId, runId, wakeId }) {
  return {
    team_ref: requiredString(teamRef, "teamRef"),
    object_type: requiredString(objectType, "objectType"),
    object_id: requiredString(objectId, "objectId"),
    run_id: requiredString(runId, "runId"),
    wake_id: requiredString(wakeId, "wakeId"),
  };
}

function normalizedOpaqueIds(values) {
  if (!Array.isArray(values)) throw new Error("providerUpdateIds_must_be_array");
  return [...new Set(values.map((value) => requiredString(value, "providerUpdateId")))];
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name}_required`);
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  return requiredString(value, "reason");
}

function requiredIso(value, name) {
  const normalized = requiredString(value, name);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${name}_invalid`);
  return normalized;
}

function requiredSha256(value, name) {
  const normalized = requiredString(value, name);
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error(`${name}_invalid`);
  return normalized.toLowerCase();
}

function hashRecord(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
