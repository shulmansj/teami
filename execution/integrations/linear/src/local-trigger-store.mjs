import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../../../engine/atomic-file.mjs";
import { readRunArtifact } from "../../../engine/run-store.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import {
  findMutationReconciliation,
  planMutationRecovery,
  readMutationReconciliationJournal,
} from "./mutation-reconciliation-journal.mjs";
import {
  clearMutationIntent as clearDurableMutationIntent,
  mutationIntentDigest,
  readMutationIntent,
} from "./trigger-idempotency.mjs";
import {
  DECOMPOSITION_REQUIRED_CAPABILITIES,
  DECOMPOSITION_WORKFLOW_TYPE,
} from "./workflows/decomposition/definition.mjs";

export const LOCAL_TRIGGER_STORE_SCHEMA_VERSION = "teami-local-trigger-store/v1";

const LINEAR_PROJECT_PLANNED_TRIGGER = "linear.project.planned";
const PROJECT_OBJECT_TYPE = "project";
const TERMINAL_WAKE_STATUSES = new Set(["completed", "paused", "rejected", "dead_letter"]);
const ROUTING_ERROR_REASONS = new Set([
  "domain_context_required",
  "domain_registry_required",
  "domain_not_found",
  "domain_not_active",
  "domain_required",
  "missing_workspace_id",
  "no_active_domains",
  "no_active_domain_for_workspace",
  "ambiguous_webhook_id",
  "webhook_id_mismatch",
  "ambiguous_team_id",
  "no_domain_project_team_intersection",
  "ambiguous_domain_project_team_intersection",
  "cross_domain_team_conflict",
  "insufficient_wake_identity",
  "team_id_mismatch",
  "workspace_id_mismatch",
  "unknown_workflow_type",
]);
const SESSION_HANDLE_POINTER_SOURCE = "run_artifact.runtime_metadata";

export function localTriggerStorePath(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, "local-trigger-store.json");
}

export function deriveSessionHandlePointerFromRuntimeMetadata(runtimeMetadata) {
  if (!runtimeMetadata || typeof runtimeMetadata !== "object" || Array.isArray(runtimeMetadata)) {
    return null;
  }
  const runtimeMetadataPaths = Object.entries(runtimeMetadata)
    .filter(([role, metadata]) => isNonEmptyString(role) && hasSessionHandle(metadata?.session_handle))
    .map(([role]) => ["runtime_metadata", role, "session_handle"]);
  if (runtimeMetadataPaths.length === 0) return null;
  return {
    source: SESSION_HANDLE_POINTER_SOURCE,
    runtime_metadata_paths: runtimeMetadataPaths,
  };
}

// NS-9 exposes only the stored handle location. Future resume work belongs in a
// separate path: on resume, re-clone the resource from the pushed REMOTE branch.
export function runIsResumable(runRecord) {
  return hasSessionHandlePointer(runRecord?.session_handle_pointer);
}

export function resolveDriverSessionHandle(runRecord, { repoRoot = process.cwd(), runStoreDir = null } = {}) {
  const pointer = normalizeSessionHandlePointer(runRecord?.session_handle_pointer);
  if (!pointer || !isNonEmptyString(runRecord?.run_id)) return null;
  const artifact = readRunArtifactForRecord(runRecord, { repoRoot, runStoreDir });
  if (!artifact) return null;
  for (const runtimeMetadataPath of pointer.runtime_metadata_paths) {
    const candidate = valueAtPath(artifact, runtimeMetadataPath);
    const handle = normalizeDriverSessionHandle(candidate);
    if (handle) return handle;
  }
  return null;
}

export function createLocalTriggerStore({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  statePath = localTriggerStorePath(home),
  runStoreDir = null,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
  writeMutationIntent = null,
  clearMutationIntent = null,
  writeReconciliationReceipt = null,
  writeState = writeLocalTriggerState,
} = {}) {
  const state = readLocalTriggerState(statePath);
  let triggerIdempotencyImport = null;

  const isoNow = () => toIsoString(now());
  const persist = () => writeState(statePath, state);
  const resolveWriteMutationIntent = async () => {
    if (typeof writeMutationIntent === "function") return writeMutationIntent;
    const module = await loadTriggerIdempotency();
    if (typeof module.writeMutationIntent !== "function") {
      throw new Error("trigger_idempotency_write_mutation_intent_missing");
    }
    return module.writeMutationIntent;
  };
  const resolveClearMutationIntent = async () => {
    if (typeof clearMutationIntent === "function") return clearMutationIntent;
    const module = await loadTriggerIdempotency();
    if (typeof module.clearMutationIntent !== "function") {
      throw new Error("trigger_idempotency_clear_mutation_intent_missing");
    }
    return module.clearMutationIntent;
  };
  const resolveWriteReconciliationReceipt = async () => {
    if (typeof writeReconciliationReceipt === "function") return writeReconciliationReceipt;
    const module = await import("./mutation-reconciliation-journal.mjs");
    if (typeof module.appendMutationReconciliation !== "function") {
      throw new Error("mutation_reconciliation_writer_missing");
    }
    return module.appendMutationReconciliation;
  };
  const loadTriggerIdempotency = async () => {
    triggerIdempotencyImport ||= import("./trigger-idempotency.mjs");
    return triggerIdempotencyImport;
  };

  const store = {
    triggerEvents: state.events,

    async heartbeat(input = {}) {
      const at = input.at || isoNow();
      return {
        ok: true,
        runner_id: input.runnerId || null,
        workspace_id: input.workspaceId || null,
        last_seen_at: at,
      };
    },

    async claimSyntheticWake({ domainId, workspaceId, teamId, projectId } = {}) {
      requireString(domainId, "domainId");
      requireString(workspaceId, "workspaceId");
      requireString(teamId, "teamId");
      requireString(projectId, "projectId");
      const createdAt = isoNow();
      const event = {
        id: idGenerator("event"),
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: LINEAR_PROJECT_PLANNED_TRIGGER,
        workflow_type: DECOMPOSITION_WORKFLOW_TYPE,
        object_type: PROJECT_OBJECT_TYPE,
        object_id: projectId,
        team_ids: [teamId],
        created_at: createdAt,
      };
      const leaseToken = idGenerator("lease");
      const wake = {
        id: idGenerator("wake"),
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: LINEAR_PROJECT_PLANNED_TRIGGER,
        workflow_type: DECOMPOSITION_WORKFLOW_TYPE,
        object_type: PROJECT_OBJECT_TYPE,
        object_id: projectId,
        team_ids: [teamId],
        created_at: createdAt,
        attempt_count: 0,
        source_event_id: event.id,
        status: "leased",
        claimed_at: createdAt,
        runner_id: null,
        lease_token: leaseToken,
        lease_expires_at: null,
        started_at: null,
        mutation_started_at: null,
        mutation_artifact_kind: null,
        terminal_at: null,
        run_id: null,
        reason: null,
        routing_error_reason: null,
        routing_candidates: [],
      };
      state.events.push(event);
      state.wakes.push(wake);
      persist();
      return { ok: true, wake: clone(wake), leaseToken, event: clone(event) };
    },

    async claimSyntheticIssueWake({
      domainId,
      workspaceId,
      teamId,
      objectId,
      workflowType,
      triggerType,
      objectType = "issue",
    } = {}) {
      requireString(domainId, "domainId");
      requireString(workspaceId, "workspaceId");
      requireString(teamId, "teamId");
      requireString(objectId, "objectId");
      requireString(workflowType, "workflowType");
      requireString(triggerType, "triggerType");
      const createdAt = isoNow();
      const event = {
        id: idGenerator("event"),
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: triggerType,
        workflow_type: workflowType,
        object_type: objectType,
        object_id: objectId,
        team_ids: [teamId],
        created_at: createdAt,
      };
      const leaseToken = idGenerator("lease");
      const wake = {
        id: idGenerator("wake"),
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: triggerType,
        workflow_type: workflowType,
        object_type: objectType,
        object_id: objectId,
        team_ids: [teamId],
        created_at: createdAt,
        attempt_count: 0,
        source_event_id: event.id,
        status: "leased",
        claimed_at: createdAt,
        runner_id: null,
        lease_token: leaseToken,
        lease_expires_at: null,
        started_at: null,
        mutation_started_at: null,
        mutation_artifact_kind: null,
        terminal_at: null,
        run_id: null,
        reason: null,
        routing_error_reason: null,
        routing_candidates: [],
      };
      state.events.push(event);
      state.wakes.push(wake);
      persist();
      return { ok: true, wake: clone(wake), leaseToken, event: clone(event) };
    },

    async claimNextWake(input = {}) {
      const {
        workspaceId,
        runnerId,
        capabilities = [],
        leaseDurationMs = null,
        at = isoNow(),
      } = input;
      requireString(workspaceId, "workspaceId");
      requireString(runnerId, "runnerId");
      const wake = state.wakes.find(
        (candidate) => candidate.workspace_id === workspaceId && candidate.status === "queued",
      );
      if (!wake) return { ok: false, reason: "no_queued_wake" };
      const missing = missingCapabilities(wake.workflow_type, capabilities);
      if (missing.length > 0) {
        wake.last_claim_rejection_reason = `missing_capabilities:${missing.join(",")}`;
        persist();
        return { ok: false, reason: "capability_mismatch", wake: clone(wake), missingCapabilities: missing };
      }
      return store.claimWake({
        wakeId: wake.id,
        workspaceId,
        runnerId,
        capabilities,
        leaseDurationMs,
        at,
      });
    },

    async claimWake(input = {}) {
      const {
        wakeId,
        workspaceId,
        runnerId,
        capabilities = [],
        leaseDurationMs = null,
        at = isoNow(),
      } = input;
      requireString(wakeId, "wakeId");
      requireString(workspaceId, "workspaceId");
      requireString(runnerId, "runnerId");
      const wake = getRawWake(wakeId);
      if (!wake || wake.workspace_id !== workspaceId) return { ok: false, reason: "wake_not_found" };
      if (wake.status !== "queued") return { ok: false, reason: `wake_not_queued:${wake.status}`, wake: clone(wake) };
      const missing = missingCapabilities(wake.workflow_type, capabilities);
      if (missing.length > 0) {
        wake.last_claim_rejection_reason = `missing_capabilities:${missing.join(",")}`;
        persist();
        return { ok: false, reason: "capability_mismatch", wake: clone(wake), missingCapabilities: missing };
      }
      const leaseToken = idGenerator("lease");
      Object.assign(wake, {
        status: "leased",
        claimed_at: at,
        runner_id: runnerId,
        lease_token: leaseToken,
        lease_expires_at: leaseDurationMs ? plusMsIso(at, leaseDurationMs) : null,
        attempt_count: (wake.attempt_count || 0) + 1,
        last_claim_rejection_reason: null,
      });
      persist();
      return { ok: true, wake: clone(wake), leaseToken, event: eventForWake(wake) };
    },

    async renewLease(input = {}) {
      const wake = getRawWake(input.wakeId);
      const token = assertLeaseToken(wake, input.runnerId, input.leaseToken);
      if (!token.ok) return token;
      if (!["leased", "running"].includes(wake.status)) {
        return { ok: false, reason: `wake_not_renewable:${wake.status}`, wake: clone(wake) };
      }
      const at = input.at || isoNow();
      wake.lease_expires_at = input.leaseDurationMs ? plusMsIso(at, input.leaseDurationMs) : wake.lease_expires_at;
      persist();
      return { ok: true, wake: clone(wake) };
    },

    async markWakeRunning(input = {}) {
      const {
        wakeId,
        runnerId,
        leaseToken,
        runId,
        domainId,
        at = isoNow(),
        artifactPointer = null,
        runtimeMetadata = null,
        runtime_metadata = null,
        sessionHandlePointer = null,
        session_handle_pointer = null,
      } = input;
      requireString(runId, "runId");
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake: clone(wake) };
      if (!isNonEmptyString(domainId)) return { ok: false, reason: "missing_domain_id", wake: clone(wake) };
      wake.status = "running";
      wake.started_at = at;
      wake.runner_id = runnerId;
      wake.run_id = runId;
      wake.domain_id = domainId;
      const metadataForPointer = runtimeMetadata ?? runtime_metadata;
      const explicitSessionHandlePointer = sessionHandlePointer ?? session_handle_pointer;
      const runRecord = {
        run_id: runId,
        workspace_id: wake.workspace_id,
        domain_id: domainId,
        workflow_type: wake.workflow_type,
        wake_id: wake.id,
        object_id: wake.object_id,
        status: "running",
        started_at: at,
        terminal_at: null,
        terminal_reason: null,
        artifact_pointer: artifactPointer,
        provider_update_ids: [],
      };
      if (metadataForPointer != null) runRecord.runtime_metadata = metadataForPointer;
      if (explicitSessionHandlePointer != null) {
        runRecord.session_handle_pointer = explicitSessionHandlePointer;
      }
      upsertRun(runRecord);
      persist();
      return { ok: true, wake: clone(wake) };
    },

    async markMutationStarted(input = {}) {
      const {
        wakeId,
        runnerId,
        leaseToken,
        runId,
        artifactKind,
        git = null,
        at = isoNow(),
      } = input;
      requireString(runId, "runId");
      requireString(artifactKind, "artifactKind");
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      if (!isNonEmptyString(wake.domain_id)) return { ok: false, reason: "missing_domain_id", wake: clone(wake) };
      const write = await resolveWriteMutationIntent();
      const objectType = wake.object_type || PROJECT_OBJECT_TYPE;
      if (objectType === "issue") {
        if (!git || typeof git !== "object" || Array.isArray(git)) {
          throw new Error("git_identity_required_for_issue_mutation");
        }
        await write({
          domainId: wake.domain_id,
          objectType: "issue",
          objectId: wake.object_id,
          runId,
          artifactKind,
          wakeId: wake.id,
          startedAt: at,
          workflowType: wake.workflow_type,
          triggerType: wake.trigger_type,
          git,
          repoRoot,
          home,
          runStoreDir,
        });
      } else {
        const intentInput = {
          domainId: wake.domain_id,
          projectId: wake.object_id,
          runId,
          artifactKind,
          wakeId: wake.id,
          startedAt: at,
          repoRoot,
          home,
          runStoreDir,
        };
        const writtenIntent = await write(intentInput);
        wake.mutation_intent_digest = writtenIntent
          ? mutationIntentDigest(writtenIntent)
          : createHash("sha256").update(JSON.stringify(intentInput)).digest("hex");
      }
      wake.mutation_started_at = at;
      wake.mutation_artifact_kind = artifactKind;
      wake.run_id ||= runId;
      persist();
      return { ok: true, wake: clone(wake) };
    },

    async completeWake(input = {}) {
      const {
        wakeId,
        runnerId,
        leaseToken,
        status,
        reason = null,
        providerUpdateIds = [],
        at = isoNow(),
        artifact = null,
        artifactPointer = undefined,
        runtimeMetadata = null,
        runtime_metadata = null,
        sessionHandlePointer = null,
        session_handle_pointer = null,
        reconciliationVerified = false,
        reconciliationEvidenceDigest = null,
      } = input;
      if (!TERMINAL_WAKE_STATUSES.has(status)) throw new Error(`Invalid terminal wake status: ${status}`);
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      const runId = wake.run_id;
      const objectType = wake.object_type || PROJECT_OBJECT_TYPE;
      const shouldReconcileAtTerminal = reconciliationVerified === true &&
        objectType !== "issue" &&
        isNonEmptyString(wake.mutation_started_at) &&
        isSha256(wake.mutation_intent_digest) &&
        isSha256(reconciliationEvidenceDigest) &&
        Array.isArray(providerUpdateIds) && providerUpdateIds.length > 0 &&
        isNonEmptyString(wake.domain_id) &&
        isNonEmptyString(wake.object_id) &&
        isNonEmptyString(runId);
      let reconciliation = null;
      if (shouldReconcileAtTerminal) {
        const writeReceipt = await resolveWriteReconciliationReceipt();
        reconciliation = await writeReceipt({
          home,
          domainId: wake.domain_id,
          objectType,
          objectId: wake.object_id,
          runId,
          wakeId: wake.id,
          status,
          reason,
          intentDigest: wake.mutation_intent_digest,
          artifactKind: wake.mutation_artifact_kind,
          effectEvidenceDigest: reconciliationEvidenceDigest,
          providerUpdateIds,
          reconciledAt: at,
        });
      }
      wake.status = status;
      wake.reason = reason;
      wake.terminal_at = at;
      wake.lease_expires_at = null;
      wake.lease_token = null;
      if (reconciliation) {
        wake.mutation_reconciliation = {
          receipt_id: reconciliation.record_id,
          receipt_hash: reconciliation.record_hash,
          reconciled_at: reconciliation.reconciled_at,
        };
        wake.mutation_intent_clear_pending = true;
        wake.mutation_reconciliation_required = false;
      } else if (isNonEmptyString(wake.mutation_started_at) && objectType !== "issue") {
        wake.mutation_reconciliation_required = true;
      }
      const run = runForWake(wake);
      if (run) {
        const metadataForPointer = runtimeMetadata ?? runtime_metadata ?? artifact?.runtime_metadata;
        const explicitSessionHandlePointer = sessionHandlePointer ?? session_handle_pointer;
        const runUpdate = {
          status,
          terminal_at: at,
          terminal_reason: reason,
          provider_update_ids: providerUpdateIds,
        };
        if (metadataForPointer != null) runUpdate.runtime_metadata = metadataForPointer;
        if (explicitSessionHandlePointer != null) {
          runUpdate.session_handle_pointer = explicitSessionHandlePointer;
        }
        if (artifactPointer !== undefined) runUpdate.artifact_pointer = artifactPointer;
        updateRunRecord(run, runUpdate);
      }
      persist();
      if (reconciliation) {
        try {
          const clear = await resolveClearMutationIntent();
          await clear({
            domainId: wake.domain_id,
            projectId: wake.object_id,
            runId,
            repoRoot,
            home,
            runStoreDir,
          });
          wake.mutation_intent_clear_pending = false;
          wake.mutation_intent_cleared_at = at;
          persist();
        } catch {
          // Redundant intent + durable terminal receipt is the recoverable state.
          // Cleanup is retried by reconciliation; never roll terminal truth back.
        }
      }
      return { ok: true, wake: clone(wake), run: clone(run) };
    },

    async deadLetterWake(input = {}) {
      const {
        wakeId,
        runnerId = null,
        leaseToken = null,
        reason,
        at = isoNow(),
      } = input;
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      wake.status = "dead_letter";
      wake.reason = reason || "dead_letter";
      wake.terminal_at = at;
      wake.lease_expires_at = null;
      wake.lease_token = null;
      state.dead_letters.push({ wake_id: wake.id, reason: wake.reason, created_at: at });
      const run = runForWake(wake);
      if (run) {
        updateRunRecord(run, {
          status: "dead_letter",
          terminal_at: at,
          terminal_reason: wake.reason,
        });
      }
      persist();
      return { ok: true, wake: clone(wake), run: clone(run) };
    },

    async releaseWake(input = {}) {
      const {
        wakeId,
        runnerId,
        leaseToken,
        reason = "domain_not_served",
      } = input;
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake: clone(wake) };
      if (reason !== "domain_not_served") return { ok: false, reason: `invalid_release_reason:${reason}`, wake: clone(wake) };
      Object.assign(wake, {
        status: "queued",
        claimed_at: null,
        runner_id: null,
        lease_token: null,
        lease_expires_at: null,
        started_at: null,
        run_id: null,
      });
      persist();
      return { ok: true, wakeId: wake.id, status: "queued", attemptCount: wake.attempt_count, wake: clone(wake) };
    },

    async markWakeRoutingError(input = {}) {
      const {
        wakeId,
        runnerId,
        leaseToken,
        reason,
        candidates = [],
      } = input;
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake: clone(wake) };
      if (!ROUTING_ERROR_REASONS.has(reason)) {
        return { ok: false, reason: `invalid_routing_error_reason:${reason}`, wake: clone(wake) };
      }
      wake.status = "routing_error";
      wake.routing_error_reason = reason;
      wake.routing_candidates = Array.isArray(candidates) ? clone(candidates) : [];
      wake.claimed_at = null;
      wake.runner_id = null;
      wake.lease_token = null;
      wake.lease_expires_at = null;
      persist();
      return { ok: true, wakeId: wake.id, status: "routing_error", wake: clone(wake) };
    },

    async requeueWake(input = {}) {
      const wake = getRawWake(input.wakeId);
      if (!wake) return { ok: false, reason: "wake_not_found" };
      if (wake.status !== "routing_error") {
        return { ok: false, reason: `wake_not_routing_error:${wake.status}`, wake: clone(wake) };
      }
      wake.status = "queued";
      wake.routing_error_reason = null;
      wake.routing_candidates = [];
      persist();
      return { ok: true, wakeId: wake.id, status: "queued", wake: clone(wake) };
    },

    async getWake(wakeIdOrInput) {
      const wakeId = typeof wakeIdOrInput === "string" ? wakeIdOrInput : wakeIdOrInput?.wakeId;
      const wake = getRawWake(wakeId);
      return wake ? clone(wake) : null;
    },

    async listWakeViews(input = {}) {
      const { workspaceId = null } = input;
      return state.wakes
        .filter((wake) => !workspaceId || wake.workspace_id === workspaceId)
        .map((wake) => clone(wake));
    },

    findLatestRunForObject(objectId) {
      if (!isNonEmptyString(objectId)) return null;
      const candidates = state.runs
        .map((run) => normalizeRunRecord(run))
        .filter((run) =>
          run.object_id === objectId &&
          run.workflow_type === "execution" &&
          Number.isFinite(Date.parse(run.started_at)));
      candidates.sort(compareRunsLatestFirst);
      return candidates[0] ? clone(candidates[0]) : null;
    },

    findRunsForObject(objectId) {
      if (!isNonEmptyString(objectId)) return [];
      const candidates = state.runs
        .map((run) => normalizeRunRecord(run))
        .filter((run) =>
          run.object_id === objectId &&
          run.workflow_type === "execution" &&
          Number.isFinite(Date.parse(run.started_at)));
      candidates.sort(compareRunsLatestFirst);
      return candidates.map((run) => clone(run));
    },

    upsertParkRecord(record) {
      const normalized = normalizeParkRecord(record);
      const existing = state.park_records.find((candidate) => candidate.issue_id === normalized.issue_id);
      if (existing) {
        if (!sameParkHead(existing, normalized)) {
          replaceParkRecord(existing, normalized);
          persist();
        }
        return clone(existing);
      } else {
        state.park_records.push(normalized);
        persist();
      }
      return clone(normalized);
    },

    parkRecords(input = {}) {
      if (input && typeof input === "object" && Object.hasOwn(input, "issueId")) {
        if (!isNonEmptyString(input.issueId)) return null;
        const record = state.park_records.find((candidate) => candidate.issue_id === input.issueId);
        return record ? clone(record) : null;
      }
      return state.park_records.map((record) => clone(record));
    },

    deleteParkRecord(issueId) {
      requireString(issueId, "issueId");
      const index = state.park_records.findIndex((record) => record.issue_id === issueId);
      if (index >= 0) {
        state.park_records.splice(index, 1);
        persist();
      }
      return { ok: true };
    },

    upsertBriefingRecord(record) {
      const normalized = normalizeBriefingRecord(record);
      const existing = state.briefing_records.find((candidate) => candidate.issue_id === normalized.issue_id);
      if (existing) {
        if (!sameBriefingRecord(existing, normalized)) {
          replaceBriefingRecord(existing, normalized);
          persist();
        }
        return clone(existing);
      }
      state.briefing_records.push(normalized);
      persist();
      return clone(normalized);
    },

    briefingRecords(input = {}) {
      if (input && typeof input === "object" && Object.hasOwn(input, "issueId")) {
        if (!isNonEmptyString(input.issueId)) return null;
        const record = state.briefing_records.find((candidate) => candidate.issue_id === input.issueId);
        return record ? clone(record) : null;
      }
      return state.briefing_records.map((record) => clone(record));
    },

    recordMergeOutcome({ wakeId, runId, merge_outcome } = {}) {
      requireString(wakeId, "wakeId");
      requireString(runId, "runId");
      const wake = getRawWake(wakeId);
      if (!wake) return { ok: false, reason: "wake_not_found" };
      if (wake.run_id !== runId) return { ok: false, reason: "run_not_found" };
      const run = runForWake(wake);
      if (!run) return { ok: false, reason: "run_not_found" };
      updateRunRecord(run, {
        merge_outcome: normalizeMergeOutcome(merge_outcome),
      });
      persist();
      return { ok: true, run: clone(run) };
    },

    findLatestMergeRunForIssuePrHead({ issueId, prNumber, headSha } = {}) {
      requireString(issueId, "issueId");
      requireString(headSha, "headSha");
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error("prNumber must be a positive integer.");
      }
      const candidates = state.runs
        .map((run) => normalizeRunRecord(run))
        .filter((run) =>
          run.workflow_type === "merge" &&
          run.merge_outcome?.issue_id === issueId &&
          run.merge_outcome?.pr_number === prNumber &&
          run.merge_outcome?.head_sha === headSha);
      candidates.sort(compareMergeRunsLatestFirst);
      return candidates[0] ? clone(candidates[0]) : null;
    },
  };

  function getRawWake(wakeId) {
    return state.wakes.find((wake) => wake.id === wakeId) || null;
  }

  function eventForWake(wake) {
    const event = state.events.find((candidate) => candidate.id === wake?.source_event_id);
    return event ? clone(event) : null;
  }

  function runForWake(wake) {
    return state.runs.find((run) => run.wake_id === wake?.id && run.run_id === wake?.run_id) || null;
  }

  function upsertRun(run) {
    const normalized = normalizeRunRecord(run);
    const existing = state.runs.find(
      (candidate) => candidate.wake_id === normalized.wake_id && candidate.run_id === normalized.run_id,
    );
    if (existing) replaceRunRecord(existing, { ...existing, ...normalized });
    else state.runs.push(normalized);
  }

  return store;
}

export function recoverLocalMutationReconciliation({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  statePath = localTriggerStorePath(home),
  runStoreDir = null,
  readIntent = readMutationIntent,
  clearIntent = clearDurableMutationIntent,
  readJournal = readMutationReconciliationJournal,
  writeState = writeLocalTriggerState,
} = {}) {
  const state = readLocalTriggerState(statePath);
  const records = readJournal({ home });
  const actions = [];
  const persist = () => writeState(statePath, state);

  for (const wake of state.wakes) {
    if (
      (wake.object_type || PROJECT_OBJECT_TYPE) !== PROJECT_OBJECT_TYPE ||
      !isNonEmptyString(wake.domain_id) ||
      !isNonEmptyString(wake.object_id) ||
      !isNonEmptyString(wake.run_id)
    ) continue;

    const intent = readIntent({
      domainId: wake.domain_id,
      runId: wake.run_id,
      repoRoot,
      home,
      runStoreDir,
    });
    const candidateReceipt = findMutationReconciliation({
      records,
      domainId: wake.domain_id,
      objectType: PROJECT_OBJECT_TYPE,
      objectId: wake.object_id,
      runId: wake.run_id,
    });
    const receipt = candidateReceipt?.wake_id === wake.id ? candidateReceipt : null;

    if (intent && receipt && mutationIntentDigest(intent) !== receipt.intent_digest) {
      wake.mutation_reconciliation_required = true;
      wake.mutation_reconciliation_reason = "intent_receipt_digest_mismatch";
      persist();
      actions.push({ wake_id: wake.id, action: "fail_closed_digest_mismatch" });
      continue;
    }

    const plan = planMutationRecovery({
      intent,
      receipt,
      terminalWake: wake,
    });
    if (plan.action === "none") continue;
    if (plan.action === "done") {
      if (!intent && wake.mutation_intent_clear_pending === true) {
        wake.mutation_intent_clear_pending = false;
        wake.mutation_intent_cleared_at ||= receipt.reconciled_at;
        persist();
        actions.push({ wake_id: wake.id, action: "cleanup_state_finalized" });
      }
      continue;
    }

    if (plan.action === "reconcile_external_effect") {
      restoreWakeMutationIntentFields(wake, intent);
      wake.mutation_reconciliation_required = true;
      persist();
      actions.push({ wake_id: wake.id, action: plan.action });
      continue;
    }

    if (
      plan.action === "persist_terminal_then_clear_intent" ||
      plan.action === "reconstruct_terminal_from_receipt"
    ) {
      applyReconciliationReceiptToState({ state, wake, receipt, hasIntent: Boolean(intent) });
      persist();
      actions.push({ wake_id: wake.id, action: "terminal_reconstructed" });
    }

    if (plan.action === "clear_redundant_intent" || plan.action === "persist_terminal_then_clear_intent") {
      try {
        clearIntent({
          domainId: wake.domain_id,
          projectId: wake.object_id,
          runId: wake.run_id,
          repoRoot,
          home,
          runStoreDir,
        });
        wake.mutation_intent_clear_pending = false;
        wake.mutation_intent_cleared_at = receipt.reconciled_at;
        persist();
        actions.push({ wake_id: wake.id, action: "redundant_intent_cleared" });
      } catch {
        wake.mutation_intent_clear_pending = true;
        persist();
        actions.push({ wake_id: wake.id, action: "redundant_intent_clear_pending" });
      }
    } else if (plan.action === "reconstruct_terminal_from_receipt") {
      wake.mutation_intent_clear_pending = false;
      persist();
    }
  }

  return { ok: true, actions };
}

function restoreWakeMutationIntentFields(wake, intent) {
  wake.mutation_started_at ||= intent.started_at;
  wake.mutation_artifact_kind ||= intent.artifact_kind;
  wake.mutation_intent_digest ||= mutationIntentDigest(intent);
}

function applyReconciliationReceiptToState({ state, wake, receipt, hasIntent }) {
  if (!TERMINAL_WAKE_STATUSES.has(receipt?.status)) {
    throw new Error(`mutation_reconciliation_receipt_status_invalid:${receipt?.status || "missing"}`);
  }
  wake.status = receipt.status;
  wake.reason = receipt.reason;
  wake.terminal_at = receipt.reconciled_at;
  wake.lease_expires_at = null;
  wake.lease_token = null;
  wake.mutation_started_at ||= receipt.reconciled_at;
  wake.mutation_artifact_kind = receipt.artifact_kind;
  wake.mutation_intent_digest = receipt.intent_digest;
  wake.mutation_reconciliation = {
    receipt_id: receipt.record_id,
    receipt_hash: receipt.record_hash,
    reconciled_at: receipt.reconciled_at,
  };
  wake.mutation_intent_clear_pending = hasIntent;
  wake.mutation_reconciliation_required = false;
  delete wake.mutation_reconciliation_reason;
  const run = state.runs.find((candidate) =>
    candidate.wake_id === wake.id && candidate.run_id === wake.run_id
  );
  if (run) {
    updateRunRecord(run, {
      status: receipt.status,
      terminal_at: receipt.reconciled_at,
      terminal_reason: receipt.reason,
      provider_update_ids: receipt.provider_update_ids,
    });
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function readLocalTriggerState(statePath = localTriggerStorePath()) {
  if (!statePath || !fs.existsSync(statePath)) return emptyLocalTriggerState();
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return normalizeLocalTriggerState(parsed);
}

export function writeLocalTriggerState(
  statePath = localTriggerStorePath(),
  state = emptyLocalTriggerState(),
  { onBoundary = () => {} } = {},
) {
  if (!statePath) return;
  const normalized = normalizeLocalTriggerState(state);
  writeAtomicJson({
    filePath: statePath,
    value: normalized,
    validate: normalizeLocalTriggerState,
    onBoundary,
  });
}

function emptyLocalTriggerState() {
  return {
    schema_version: LOCAL_TRIGGER_STORE_SCHEMA_VERSION,
    wakes: [],
    events: [],
    runs: [],
    park_records: [],
    briefing_records: [],
    dead_letters: [],
  };
}

function normalizeLocalTriggerState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Invalid local trigger store state: state_not_object");
  }
  return {
    schema_version: state.schema_version || LOCAL_TRIGGER_STORE_SCHEMA_VERSION,
    wakes: Array.isArray(state.wakes) ? state.wakes : [],
    events: Array.isArray(state.events) ? state.events : [],
    runs: Array.isArray(state.runs) ? state.runs : [],
    park_records: Array.isArray(state.park_records) ? state.park_records.map(normalizeParkRecord) : [],
    briefing_records: Array.isArray(state.briefing_records) ? state.briefing_records.map(normalizeBriefingRecord) : [],
    dead_letters: Array.isArray(state.dead_letters) ? state.dead_letters : [],
  };
}

function updateRunRecord(run, update) {
  replaceRunRecord(run, { ...run, ...update });
}

function replaceRunRecord(target, value) {
  const normalized = normalizeRunRecord(value);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, normalized);
}

function normalizeRunRecord(run) {
  const normalized = { ...(run || {}) };
  const hasRuntimeMetadata = Object.hasOwn(normalized, "runtime_metadata");
  const sessionHandlePointer = hasRuntimeMetadata
    ? deriveSessionHandlePointerFromRuntimeMetadata(normalized.runtime_metadata)
    : normalizeSessionHandlePointer(normalized.session_handle_pointer);
  delete normalized.runtime_metadata;
  delete normalized.resumable;
  delete normalized.resume_from;
  if (sessionHandlePointer) normalized.session_handle_pointer = sessionHandlePointer;
  else delete normalized.session_handle_pointer;
  return normalized;
}

function normalizeParkRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid park record: record_not_object");
  }
  requireString(record.issue_id, "issue_id");
  requireString(record.parked_head_sha, "parked_head_sha");
  requireString(record.parked_at, "parked_at");
  if (!Number.isInteger(record.pr_number) || record.pr_number <= 0) {
    throw new Error("pr_number must be a positive integer.");
  }
  return {
    issue_id: record.issue_id,
    pr_number: record.pr_number,
    parked_head_sha: record.parked_head_sha,
    parked_at: record.parked_at,
  };
}

function normalizeMergeOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("Invalid merge outcome: outcome_not_object");
  }
  requireString(outcome.issue_id, "issue_id");
  requireString(outcome.head_sha, "head_sha");
  requireString(outcome.outcome, "outcome");
  requireString(outcome.reason, "reason");
  requireString(outcome.observed_at, "observed_at");
  if (!Number.isInteger(outcome.pr_number) || outcome.pr_number <= 0) {
    throw new Error("pr_number must be a positive integer.");
  }
  return {
    issue_id: outcome.issue_id,
    pr_number: outcome.pr_number,
    head_sha: outcome.head_sha,
    outcome: outcome.outcome,
    reason: outcome.reason,
    observed_at: outcome.observed_at,
  };
}

function replaceParkRecord(target, value) {
  const normalized = normalizeParkRecord(value);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, normalized);
}

function sameParkHead(left, right) {
  return left.pr_number === right.pr_number && left.parked_head_sha === right.parked_head_sha;
}

// The briefing record is the machine-readable side of the human review
// briefing: the comment the human reads stays pure prose, and this row is
// what the review effects and the gate status view consult to know that a
// briefing exists for a given parked head. One per issue, upsert by issue
// id, same as the park record it accompanies; a row for a superseded head
// is inert because every consumer matches on head_sha.
function normalizeBriefingRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid briefing record: record_not_object");
  }
  requireString(record.issue_id, "issue_id");
  requireString(record.head_sha, "head_sha");
  requireString(record.run_id, "run_id");
  requireString(record.comment_id, "comment_id");
  requireString(record.posted_at, "posted_at");
  return {
    issue_id: record.issue_id,
    head_sha: record.head_sha,
    run_id: record.run_id,
    comment_id: record.comment_id,
    posted_at: record.posted_at,
  };
}

function replaceBriefingRecord(target, value) {
  const normalized = normalizeBriefingRecord(value);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, normalized);
}

function sameBriefingRecord(left, right) {
  return (
    left.head_sha === right.head_sha &&
    left.run_id === right.run_id &&
    left.comment_id === right.comment_id &&
    left.posted_at === right.posted_at
  );
}

function normalizeSessionHandlePointer(pointer) {
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return null;
  const runtimeMetadataPaths = Array.isArray(pointer.runtime_metadata_paths)
    ? pointer.runtime_metadata_paths
      .filter((entry) => Array.isArray(entry) && entry.every(isNonEmptyString))
      .map((entry) => [...entry])
    : [];
  if (runtimeMetadataPaths.length === 0) return null;
  return {
    source: isNonEmptyString(pointer.source) ? pointer.source : SESSION_HANDLE_POINTER_SOURCE,
    runtime_metadata_paths: runtimeMetadataPaths,
  };
}

function hasSessionHandlePointer(pointer) {
  return normalizeSessionHandlePointer(pointer) !== null;
}

function hasSessionHandle(handle) {
  return Boolean(handle && typeof handle === "object" && !Array.isArray(handle) && isNonEmptyString(handle.id));
}

function normalizeDriverSessionHandle(handle) {
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) return null;
  if (
    !isNonEmptyString(handle.id) ||
    handle.role !== "orchestrator" ||
    !isNonEmptyString(handle.run_id) ||
    !isNonEmptyString(handle.runtime)
  ) {
    return null;
  }
  return {
    id: handle.id,
    role: handle.role,
    run_id: handle.run_id,
    runtime: handle.runtime,
  };
}

function readRunArtifactForRecord(runRecord, { repoRoot, runStoreDir } = {}) {
  const options = { runId: runRecord.run_id, repoRoot, domainId: runRecord.domain_id || null };
  if (runStoreDir) options.runStoreDir = runStoreDir;
  try {
    const artifact = readRunArtifact(options);
    if (artifact) return artifact;
  } catch {
    // Fall through to the artifact pointer path when available.
  }

  const artifactPath = runRecord?.artifact_pointer?.artifact_path;
  if (!isNonEmptyString(artifactPath)) return null;
  try {
    const resolvedArtifactPath = path.resolve(repoRoot || process.cwd(), artifactPath);
    return readRunArtifact({
      runId: runRecord.run_id,
      repoRoot,
      runStoreDir: path.dirname(resolvedArtifactPath),
    });
  } catch {
    return null;
  }
}

function valueAtPath(value, pathParts) {
  let current = value;
  for (const part of pathParts || []) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function compareRunsLatestFirst(left, right) {
  const startedDiff = Date.parse(right.started_at) - Date.parse(left.started_at);
  if (startedDiff !== 0) return startedDiff;
  const terminalDiff = parseOptionalDateDesc(right.terminal_at) - parseOptionalDateDesc(left.terminal_at);
  if (terminalDiff !== 0) return terminalDiff;
  return String(right.run_id || "").localeCompare(String(left.run_id || ""));
}

function compareMergeRunsLatestFirst(left, right) {
  const leftObserved = parseOptionalDateDesc(left.merge_outcome?.observed_at);
  const rightObserved = parseOptionalDateDesc(right.merge_outcome?.observed_at);
  if (leftObserved !== rightObserved) return rightObserved - leftObserved;
  return compareRunsLatestFirst(left, right);
}

function parseOptionalDateDesc(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function assertLeaseToken(wake, runnerId, leaseToken) {
  if (!wake) return { ok: false, reason: "wake_not_found" };
  if (wake.runner_id && runnerId !== undefined && runnerId !== null && wake.runner_id !== runnerId) {
    return { ok: false, reason: "runner_mismatch", wake: clone(wake) };
  }
  if (!leaseToken || wake.lease_token !== leaseToken) {
    return { ok: false, reason: "lease_token_mismatch", wake: clone(wake) };
  }
  return { ok: true, wake };
}

function missingCapabilities(workflowType, capabilities = []) {
  if (workflowType !== DECOMPOSITION_WORKFLOW_TYPE) return [];
  const runnerCapabilities = new Set(capabilities || []);
  return DECOMPOSITION_REQUIRED_CAPABILITIES.filter((capability) => !runnerCapabilities.has(capability));
}

function requireString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} is required.`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function plusMsIso(at, ms) {
  return new Date(Date.parse(at) + ms).toISOString();
}

function defaultIdGenerator(prefix = "id") {
  return `${prefix}_${randomUUID()}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
