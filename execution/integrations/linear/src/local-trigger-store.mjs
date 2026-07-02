import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readRunArtifact, renameWithRetry } from "../../../engine/run-store.mjs";
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

export function localTriggerStorePath(repoRoot = process.cwd()) {
  return path.join(repoRoot, ".teami", "local-trigger-store.json");
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
  statePath = localTriggerStorePath(repoRoot),
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
  writeMutationIntent = null,
  clearMutationIntent = null,
} = {}) {
  const state = readLocalTriggerState(statePath);
  let triggerIdempotencyImport = null;

  const isoNow = () => toIsoString(now());
  const persist = () => writeLocalTriggerState(statePath, state);
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
        });
      } else {
        await write({
          domainId: wake.domain_id,
          projectId: wake.object_id,
          runId,
          artifactKind,
          wakeId: wake.id,
          startedAt: at,
        });
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
      } = input;
      if (!TERMINAL_WAKE_STATUSES.has(status)) throw new Error(`Invalid terminal wake status: ${status}`);
      const wake = getRawWake(wakeId);
      const token = assertLeaseToken(wake, runnerId, leaseToken);
      if (!token.ok) return token;
      const runId = wake.run_id;
      const objectType = wake.object_type || PROJECT_OBJECT_TYPE;
      const shouldClearAtTerminal = objectType !== "issue";
      if (
        shouldClearAtTerminal &&
        (wake.mutation_started_at || typeof clearMutationIntent === "function") &&
        isNonEmptyString(wake.domain_id) &&
        isNonEmptyString(wake.object_id) &&
        isNonEmptyString(runId)
      ) {
        const clear = await resolveClearMutationIntent();
        await clear({
          domainId: wake.domain_id,
          projectId: wake.object_id,
          runId,
        });
      }
      wake.status = status;
      wake.reason = reason;
      wake.terminal_at = at;
      wake.lease_expires_at = null;
      wake.lease_token = null;
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

export function readLocalTriggerState(statePath = localTriggerStorePath()) {
  if (!statePath || !fs.existsSync(statePath)) return emptyLocalTriggerState();
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return normalizeLocalTriggerState(parsed);
}

export function writeLocalTriggerState(statePath = localTriggerStorePath(), state = emptyLocalTriggerState()) {
  if (!statePath) return;
  const normalized = normalizeLocalTriggerState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    normalizeLocalTriggerState(JSON.parse(fs.readFileSync(tempPath, "utf8")));
    renameWithRetry(tempPath, statePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function emptyLocalTriggerState() {
  return {
    schema_version: LOCAL_TRIGGER_STORE_SCHEMA_VERSION,
    wakes: [],
    events: [],
    runs: [],
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
  const options = { runId: runRecord.run_id, repoRoot };
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
