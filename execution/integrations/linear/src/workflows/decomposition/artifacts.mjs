import { recordSpan } from "../../trace.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../../../engine/engine-contract-constants.mjs";
import {
  normalizeArtifactSetLineage,
} from "../../../../../engine/produced-identities.mjs";
import {
  DECOMPOSITION_FUNCTION_VERSION,
  DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
  validateResumePacketContract,
} from "../../phase-contract.mjs";
import { captureProjectSnapshot } from "../../project-snapshot-store.mjs";
import { writeRunArtifact } from "../../../../../engine/run-store.mjs";
import { buildRuntimeMetadata } from "../../runtime-adapters.mjs";
import { matchesStatus } from "../../linear/matching-utils.mjs";
import { projectBodyUpdateFromAuthoredOutput } from "./commit-payload.mjs";

// Captures the project context the decomposition run actually saw into the
// local snapshot store (sibling of the run artifact, gitignored). The future
// rich-promotion command consumes this capture and must never pull live Linear
// state at promotion time; docs/operating-model.md#state-model owns that state
// authority. In eval mode the supplied memory snapshot IS the capture
// (capture_source records that honestly).
// Capture happens only for fresh decomposition evaluations: the replay path
// (retryCommit) returns earlier and never overwrites the original capture.
// Capture failures are recorded on the trace but never alter the run outcome,
// so the live decision path is unchanged; a missing snapshot simply makes
// rich promotion fail closed later.
export function captureRunProjectSnapshot({ runId, project, shape, evalMode, repoRoot, home, teamRef, runStoreDir, trace }) {
  if (!runId) {
    recordSpan(trace, "capture_project_snapshot", { ok: false, reason: "missing_run_id_for_snapshot" });
    return null;
  }
  try {
    const { snapshot, path: snapshotPath } = captureProjectSnapshot({
      runId,
      project,
      semanticStatus: semanticProjectStatus(project, shape),
      captureSource: evalMode ? "eval_mode_memory_snapshot" : "linear_run_context",
      repoRoot,
      home,
      teamRef,
      runStoreDir,
    });
    recordSpan(trace, "capture_project_snapshot", {
      ok: true,
      run_id: runId,
      capture_source: snapshot.capture_source,
      snapshot_hash: snapshot.snapshot_hash,
      snapshot_path: snapshotPath,
    });
    return snapshot;
  } catch (error) {
    recordSpan(trace, "capture_project_snapshot", {
      ok: false,
      run_id: runId,
      reason: error.message,
    });
    return null;
  }
}

export function semanticProjectStatus(project, shape) {
  for (const [semanticName, status] of Object.entries(shape?.projectStatuses || {})) {
    if (matchesStatus(project?.status, status)) return semanticName;
  }
  return project?.status?.name || project?.status?.type || null;
}

export function persistRunArtifact({
  artifact,
  repoRoot,
  home,
  runStoreDir,
  trace,
  returnDurabilityResult = false,
  payloadValidator = null,
  functionVersion = DECOMPOSITION_FUNCTION_VERSION,
}) {
  const writeResult = writeRunArtifact(
    {
      runId: artifact.run_id,
      repoRoot,
      home,
      teamRef: artifact.team_ref,
      runStoreDir,
      returnDurabilityResult,
      payloadValidator,
      functionVersion,
      requireTerminalAudit: payloadValidator !== null,
    },
    artifact,
  );
  const artifactPath = returnDurabilityResult ? writeResult.artifact_path : writeResult;
  recordSpan(trace, "persist_run_artifact", {
    run_id: artifact.run_id,
    artifact_kind: artifact.kind,
    artifact_path: artifactPath,
  });
  return writeResult;
}

export function terminalArtifact({
  runId,
  projectId,
  teamTrace,
  runResult,
  runtimeAssignments,
  runtimeEvidence,
  environment,
  acceptedRefs = null,
  executionMode = null,
  completedAt = null,
}) {
  const terminalOutput = runResult?.terminal_output || {};
  const terminalRunId = runId || terminalOutput.run_id;
  const kind = terminalOutput.outcome === "commit" ? "commit" : "pause";
  const runtimeEvidencePackets = packetsFromRuntimeEvidence(runtimeEvidence);
  const artifactSetLineage = normalizeArtifactSetLineage(runResult?.artifact_set_lineage);
  const auditedTerminalOutput = terminalOutputAudit(terminalOutput);
  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: DECOMPOSITION_FUNCTION_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind,
    run_id: terminalRunId,
    team_ref: teamTrace?.team_ref || null,
    workspace_id: teamTrace?.workspace_id || null,
    team_id: teamTrace?.team_id || null,
    linear_project_id: projectId || null,
    terminal_output: auditedTerminalOutput,
    evidence: terminalEvidence(runResult?.evidence),
    bounds: runResult?.bounds || {},
    environment: environment || {},
    runtime_assignments: runtimeAssignments,
    runtime_metadata: buildRuntimeMetadata({
      acceptedPackets: runtimeEvidencePackets,
      runtimeAssignments,
      runtimeEvidence,
    }),
    payload_schema_id: DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: auditedTerminalOutput,
    },
    // The run-version record (B-REFS / S-REFS): forward-only, optional, and
    // backward-compatible. `accepted_refs` names the accepted-behavior
    // version(s) this run consumed; `completed_at` is a durable terminal
    // timestamp B-READ uses for the post-merge boundary; `execution_mode`
    // (live vs eval) lets a read-only eval run be excluded from consumption.
    ...(Array.isArray(acceptedRefs) && acceptedRefs.length > 0 ? { accepted_refs: acceptedRefs } : {}),
    ...(artifactSetLineage ? { artifact_set_lineage: artifactSetLineage } : {}),
    completed_at: completedAt || new Date().toISOString(),
    ...(typeof executionMode === "string" && executionMode !== "" ? { execution_mode: executionMode } : {}),
  };

  if (terminalOutput.outcome === "commit") {
    const projectBodyUpdate = projectBodyUpdateFromAuthoredOutput(terminalOutput);
    artifact.final_issues = terminalOutput.final_issues;
    artifact.project_update_markdown = terminalOutput.project_update_markdown;
    artifact.payload.final_issues = terminalOutput.final_issues;
    artifact.payload.project_update_markdown = terminalOutput.project_update_markdown;
    if (projectBodyUpdate) {
      artifact.project_body_update = projectBodyUpdate;
      artifact.payload.project_body_update = projectBodyUpdate;
    }
  } else {
    artifact.source =
      terminalOutput.outcome === "failed_closed" ? "failed_closed" : "orchestrator_terminal";
    artifact.pause_packet = pausePacketFromTerminalOutput(terminalOutput);
    artifact.payload.pause_packet = artifact.pause_packet;
  }

  return artifact;
}

function terminalOutputAudit(terminalOutput = {}) {
  return {
    schema_version: terminalOutput.schema_version,
    run_id: terminalOutput.run_id,
    workflow_version: terminalOutput.workflow_version,
    outcome: terminalOutput.outcome,
    reason: terminalOutput.reason,
    context_digest: terminalOutput.context_digest,
    source_refs: Array.isArray(terminalOutput.source_refs) ? terminalOutput.source_refs : [],
    assumptions: Array.isArray(terminalOutput.assumptions) ? terminalOutput.assumptions : [],
    constraints: Array.isArray(terminalOutput.constraints) ? terminalOutput.constraints : [],
    risks: Array.isArray(terminalOutput.risks) ? terminalOutput.risks : [],
  };
}

function terminalEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { perspectives_run: [] };
  }
  return {
    perspectives_run: Array.isArray(evidence.perspectives_run)
      ? evidence.perspectives_run.map((entry) => ({ ...entry }))
      : [],
    ...(Array.isArray(evidence.tool_events) ? { tool_events: evidence.tool_events } : {}),
    ...(Array.isArray(evidence.evidence_unavailable)
      ? { evidence_unavailable: evidence.evidence_unavailable }
      : {}),
  };
}

function pausePacketFromTerminalOutput(terminalOutput = {}) {
  const packet = {
    schema_version: terminalOutput.schema_version,
    run_id: terminalOutput.run_id,
    phase: "orchestrator_terminal",
    status: "pause",
    reason: terminalOutput.reason,
    context_digest: terminalOutput.context_digest,
    source_refs: Array.isArray(terminalOutput.source_refs) ? terminalOutput.source_refs : [],
    assumptions: Array.isArray(terminalOutput.assumptions) ? terminalOutput.assumptions : [],
    constraints: Array.isArray(terminalOutput.constraints) ? terminalOutput.constraints : [],
    risks: Array.isArray(terminalOutput.risks) ? terminalOutput.risks : [],
    open_questions_markdown: terminalOutput.open_questions_markdown,
  };
  if (terminalOutput.outcome === "failed_closed") {
    packet.project_update_markdown = terminalOutput.project_update_markdown;
  }
  return packet;
}

function packetsFromRuntimeEvidence(runtimeEvidence = {}) {
  return Object.values(runtimeEvidence || {}).flatMap((entry) => {
    if (!Array.isArray(entry?.turns)) return [];
    return entry.turns
      .filter((turn) => typeof turn?.role === "string" && turn.role.trim() !== "")
      .map((turn) => ({
        role: turn.role,
        run_id: turn.run_id || entry.session_handle?.run_id || null,
      }));
  });
}

export function validateResumePacket(packet) {
  const contract = validateResumePacketContract(packet);
  const failureReasons = contract.ok ? [] : [...contract.failureReasons];
  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}

export function failClosed(trace, failureReasons) {
  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "fail_closed",
    failure_reasons: [...new Set(failureReasons)],
  });
  return { status: "failed_closed", failureReasons: [...new Set(failureReasons)], trace };
}
