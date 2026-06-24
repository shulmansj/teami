import { createTrace, recordSpan } from "../../trace.mjs";
import { enforceTraceContentPolicy } from "../../../../../engine/trace-contract.mjs";
import {
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../../../engine/engine-contract-constants.mjs";
import { readRunArtifact, runArtifactPath } from "../../../../../engine/run-store.mjs";
import { validateOrchestratorOutput } from "../../../../../engine/orchestrator-output.mjs";
import { commitPayload as decompositionCommitPayload } from "./commit-payload.mjs";
import {
  acceptedRefFromLoadedSnapshot,
  unjoinableCoverageMarker,
} from "../../../../../engine/run-accepted-refs.mjs";
import {
  buildRuntimeMetadata,
  resolveRoleRuntimeAssignments,
} from "../../runtime-adapters.mjs";
import {
  knownTraceAttributes,
  resolveDomainTrace,
} from "../../linear/matching-utils.mjs";
import { resolveLinearShape } from "../../linear/shape-resolver.mjs";
import { evaluateEligibilityFromContext } from "./eligibility.mjs";
import {
  applyPersistedArtifact,
  maybeApplyPersistedArtifact,
  validateReplayArtifactDomain,
  validateReplayArtifactProject,
} from "./artifact-apply.mjs";
import { canApplyTerminal } from "../../../../../engine/terminal-gate.mjs";
import { unpinnedRuntimeTraceAttributes } from "../../config.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../../phase-contract.mjs";
import {
  captureRunProjectSnapshot,
  failClosed,
  persistRunArtifact,
  terminalArtifact,
  validateResumePacket,
} from "./artifacts.mjs";

export async function runDecomposition({
  client,
  config,
  cache,
  projectId,
  runResult = null,
  environment = null,
  runId = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  runtimeEvidence = {},
  retryCommit = false,
  traceContext = {},
  domainContext = null,
  evalMode = false,
  onBeforeLinearMutation = null,
  qualityJudge = false,
  acceptedRefs = null,
  loadJudgeContractFn = null,
} = {}) {
  const domainTrace = resolveDomainTrace({ domainContext, traceContext, cache, repoRoot });
  const trace = createTrace("decomposition_run", knownTraceAttributes({
    "workflow.name": "project_decomposition",
    "workflow.version": DECOMPOSITION_FUNCTION_VERSION,
    "agentic_factory.domain_id": domainTrace.domain_id,
    "agentic_factory.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.project_id": projectId,
    linear_project_id: projectId,
    run_id: runId || runResult?.terminal_output?.run_id || null,
    event_id: traceContext.event_id || null,
    wake_id: traceContext.wake_id || null,
    trace_id: traceContext.trace_id || null,
    attempt: traceContext.attempt || null,
    workspace_id: domainTrace.workspace_id,
    domain_id: domainTrace.domain_id,
    team_id: domainTrace.team_id,
    behavior_repo_id: domainTrace.behavior_repo_id,
    source_provider: traceContext.source_provider || "linear",
    source_object_id: traceContext.source_object_id || projectId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    ...unpinnedRuntimeTraceAttributes(config),
  }));

  const runtimeAssignments = resolveRoleRuntimeAssignments(config);
  if (retryCommit) {
    const persisted = readRunArtifact({ runId, repoRoot, runStoreDir });
    if (!persisted) throw new Error(`No persisted run artifact found for ${runId}.`);
    validateReplayArtifactDomain({ artifact: persisted, domainContext, replayed: true });
    if (!["commit", "pause"].includes(persisted.kind)) {
      throw new Error(`Persisted ${persisted.kind} artifact has no terminal Linear mutation artifact to replay.`);
    }
    validateReplayArtifactProject({ artifact: persisted, projectId, replayed: true });
    const replayRunResult = runResultFromTerminalArtifact(persisted);
    const replayValidation = validateOrchestratorOutput(replayRunResult, decompositionCommitPayload);
    if (!replayValidation.ok) return failClosed(trace, replayValidation.failureReasons);
    const durableRecord = {
      written: true,
      terminal_artifact_schema_valid: ["commit", "pause"].includes(persisted.kind),
      artifact_path: runArtifactPath({ runId, repoRoot, runStoreDir }),
    };
    const replayGate = canApplyTerminal({
      terminal_output: replayRunResult.terminal_output,
      bounds: replayRunResult.bounds,
      environment: persisted.environment,
      durable_record: durableRecord,
      commitPayload: decompositionCommitPayload,
    });
    if (!replayGate.ok) {
      return blockedTerminalResult({
        trace,
        blockedReason: replayGate.blocked_reason,
        durableRecord,
        artifact: persisted,
      });
    }
    const shape = await resolveLinearShape({ client, config, cache });
    const project = await client.getProjectContext(projectId);
    recordSpan(trace, "load_project_context", {
      linear_project_id: project.id,
      issue_count: project.issues?.length || 0,
    });
    recordSpan(trace, "build_run_envelope", { replay: true });
    return maybeApplyPersistedArtifact({
      client,
      config,
      shape,
      project,
      artifact: persisted,
      payload: persisted.payload,
      trace,
      repoRoot,
      runStoreDir,
      replayed: true,
      domainContext,
      evalMode,
      onBeforeLinearMutation,
      runId: persisted.run_id,
      environment: persisted.environment,
      durable_record: durableRecord,
    });
  }

  const shape = await resolveLinearShape({ client, config, cache });
  const project = await client.getProjectContext(projectId);
  recordSpan(trace, "load_project_context", {
    linear_project_id: project.id,
    issue_count: project.issues?.length || 0,
  });

  const eligibility = evaluateEligibilityFromContext({ project, shape, trace });
  if (!eligibility.eligible) {
    return { status: "ineligible", eligibility, trace };
  }

  const projectSnapshot = captureRunProjectSnapshot({
    runId: runId || runResult?.terminal_output?.run_id || null,
    project,
    shape,
    evalMode,
    repoRoot,
    runStoreDir,
    trace,
  });

  recordSpan(trace, "build_run_envelope", {
    runner_role: "workflow_runner",
    allowed_source_boundaries: "from_configured_run_envelope",
  });
  recordRuntimeEvidenceSpans(trace, { runtimeEvidence, orchestratorOutput: runResult });

  const validation = validateOrchestratorOutput(runResult, decompositionCommitPayload);
  if (!validation.ok) return failClosed(trace, validation.failureReasons);

  let effectiveRunResult = runResult;
  let artifact = terminalArtifact({
    runId: runId || runResult.terminal_output.run_id,
    domainTrace,
    projectId,
    runResult: effectiveRunResult,
    runtimeAssignments,
    runtimeEvidence,
    environment,
    acceptedRefs,
    executionMode: evalMode ? "eval" : "live",
  });
  if (qualityJudge) {
    const qualityChecked = await appendQualityCheckAdvisory({
      runResult: effectiveRunResult,
      artifact,
      qualityJudge,
      repoRoot,
      runStoreDir,
      config,
      projectSnapshot,
      traceId: traceContext.trace_id || null,
      trace,
      loadJudgeContractFn,
    });
    effectiveRunResult = qualityChecked.runResult;
    artifact = qualityChecked.artifact;
  }
  const durability = persistRunArtifact({
    artifact,
    repoRoot,
    runStoreDir,
    trace,
    returnDurabilityResult: true,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
  });
  const persistedArtifact = readRunArtifact({
    runId: artifact.run_id,
    repoRoot,
    runStoreDir,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
    requireTerminalAudit: true,
  });
  const durableRecord = {
    written: durability.written === true,
    terminal_artifact_schema_valid: durability.terminal_artifact_schema_valid === true,
    artifact_path: durability.artifact_path,
  };
  const gate = canApplyTerminal({
    terminal_output: effectiveRunResult.terminal_output,
    bounds: effectiveRunResult.bounds,
    environment,
    durable_record: durableRecord,
    commitPayload: decompositionCommitPayload,
  });
  recordSpan(trace, "terminal_apply_gate", {
    ok: gate.ok,
    outcome: effectiveRunResult.terminal_output.outcome,
    reason: effectiveRunResult.terminal_output.reason,
    blocked_reason: gate.blocked_reason || null,
    artifact_path: durableRecord.artifact_path,
  });
  if (!gate.ok) {
    return blockedTerminalResult({
      trace,
      blockedReason: gate.blocked_reason,
      durableRecord,
      artifact: persistedArtifact,
    });
  }

  const result = await maybeApplyPersistedArtifact({
    client,
    config,
    shape,
    project,
    artifact: persistedArtifact,
    payload: persistedArtifact.payload,
    trace,
    repoRoot,
    runStoreDir,
    evalMode,
    onBeforeLinearMutation,
    runId: persistedArtifact.run_id,
    environment,
    durable_record: durableRecord,
  });
  return terminalApplyResult({
    result,
    terminalOutput: effectiveRunResult.terminal_output,
    durableRecord,
    artifact: persistedArtifact,
  });
}

async function appendQualityCheckAdvisory({
  runResult,
  artifact,
  qualityJudge,
  repoRoot,
  runStoreDir,
  config,
  projectSnapshot,
  traceId,
  trace,
  loadJudgeContractFn = null,
}) {
  const {
    appendAdvisoryQualityLine,
    runAdvisoryDecompositionQualityCheck,
    loadPromptRegistrationContract,
    DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
  } = await import("../../decomposition-quality-judge.mjs");
  const runJudgeFn = typeof qualityJudge === "function" ? qualityJudge : undefined;
  const advisory = await runAdvisoryDecompositionQualityCheck({
    runJudgeFn,
    repoRoot,
    runStoreDir,
    config,
    artifact,
    snapshot: projectSnapshot,
    traceId,
  });
  const projectUpdateMarkdown = appendAdvisoryQualityLine(
    runResult.terminal_output.project_update_markdown,
    advisory.result,
  );
  recordSpan(trace, "quality_check_advisory", {
    judge_state: advisory.result?.judge_state || "judge_unavailable",
    judge_label: advisory.result?.judge?.label || null,
    reason: advisory.result?.reason || null,
    appended_to_project_update_markdown: true,
  });
  // The judge is a maintainer-owned evaluator captured by the #50 ledger (Seam
  // 3 — the cross-path that the run recorder cannot see because the judge runs
  // HERE, after the harness froze the artifact's accepted_refs). It is not
  // orchestrator-selected, so its consumed accepted-version is recorded by
  // appending its ref to the ALREADY-ASSEMBLED artifact.accepted_refs,
  // post-assembly, deduped by target_key. The ref is built from the judge's OWN
  // contract loader's { targetKey, snapshotSha256, entry } in the IDENTICAL
  // shape acceptedRefFromLoadedSnapshot mints for every other captured ref
  // (accepted_baseline_id = accepted_prompt_version_id || `sha256:<sha>`).
  const withJudgeRef = appendJudgeAcceptedRef({
    artifact: withArtifactProjectUpdateMarkdown(artifact, projectUpdateMarkdown),
    // Default to the judge's OWN contract loader so the captured version
    // provably matches what the judge consumed; tests may inject a throwing
    // loader to exercise the unjoinable-marker degrade path.
    loadPromptRegistrationContract: loadJudgeContractFn || loadPromptRegistrationContract,
    targetKey: DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
  });
  return {
    runResult: withProjectUpdateMarkdown(runResult, projectUpdateMarkdown),
    artifact: withJudgeRef,
  };
}

// Append the judge's accepted-version ref to the already-assembled artifact's
// accepted_refs (Seam 3 — the judge cross-path). The judge ran (this is only
// reached inside the qualityJudge branch), so it consumed its accepted prompt
// snapshot; recording it keeps the #50 undo-ledger complete. Built from the
// judge's own contract loader { snapshotSha256, entry } via
// acceptedRefFromLoadedSnapshot so the shape matches the recorder-captured refs
// exactly; deduped by target_key (a judge ref already present is not
// duplicated).
//
// Because consumption is KNOWN here (the judge ran), a loader/resolution failure
// must NOT omit the judge — that would persist a false "judge version not
// consumed" and license a false safe-to-undo. Instead, record an UNJOINABLE
// coverage marker (target_key present, null identifiers): "judge consumed,
// version unknown", so B-READ degrades to `unknown` rather than `not_used`.
function appendJudgeAcceptedRef({ artifact, loadPromptRegistrationContract, targetKey }) {
  let judgeRef = null;
  try {
    const contract = loadPromptRegistrationContract({ targetKey });
    judgeRef = acceptedRefFromLoadedSnapshot(targetKey, {
      snapshotSha256: contract.snapshotSha256,
      entry: contract.entry,
    });
  } catch {
    judgeRef = null;
  }
  // The judge consumed its accepted prompt; if its version cannot be resolved,
  // fall back to the unjoinable marker rather than dropping the entry.
  if (!judgeRef) judgeRef = unjoinableCoverageMarker(targetKey);
  const existing = Array.isArray(artifact.accepted_refs) ? artifact.accepted_refs : [];
  if (existing.some((ref) => ref?.target_key === judgeRef.target_key)) {
    return artifact;
  }
  return { ...artifact, accepted_refs: [...existing, judgeRef] };
}

function withProjectUpdateMarkdown(runResult, projectUpdateMarkdown) {
  return {
    ...runResult,
    terminal_output: {
      ...runResult.terminal_output,
      project_update_markdown: projectUpdateMarkdown,
    },
  };
}

function withArtifactProjectUpdateMarkdown(artifact, projectUpdateMarkdown) {
  if (artifact.kind === "commit") {
    return {
      ...artifact,
      project_update_markdown: projectUpdateMarkdown,
      payload: {
        ...artifact.payload,
        project_update_markdown: projectUpdateMarkdown,
      },
    };
  }
  const pausePacket = {
    ...artifact.pause_packet,
    project_update_markdown: projectUpdateMarkdown,
  };
  return {
    ...artifact,
    pause_packet: pausePacket,
    payload: {
      ...artifact.payload,
      pause_packet: pausePacket,
    },
  };
}

function blockedTerminalResult({ trace, blockedReason, durableRecord, artifact }) {
  const failureReasons = ["blocked", blockedReason].filter(Boolean);
  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "fail_closed",
    reason: "blocked",
    blocked_reason: blockedReason || null,
    failure_reasons: failureReasons,
    artifact_path: durableRecord.artifact_path,
  });
  return {
    status: "failed_closed",
    reason: "blocked",
    failureReasons,
    blockedReason,
    durableRecord,
    artifact,
    trace,
  };
}

function terminalApplyResult({ result, terminalOutput, durableRecord, artifact }) {
  if (terminalOutput.outcome === "failed_closed" && result?.status === "paused") {
    return {
      ...result,
      status: "failed_closed",
      reason: terminalOutput.reason,
      failureReasons: [terminalOutput.reason],
      terminalOutcome: "failed_closed",
      durableRecord,
      artifact,
    };
  }
  return {
    ...result,
    durableRecord,
    artifact: result?.artifact || artifact,
  };
}

function runResultFromTerminalArtifact(artifact = {}) {
  const terminalOutput = { ...(artifact.terminal_output || {}) };
  if (artifact.kind === "commit") {
    terminalOutput.project_update_markdown = artifact.project_update_markdown;
    terminalOutput.final_issues = artifact.final_issues;
  } else if (artifact.kind === "pause") {
    terminalOutput.project_update_markdown =
      artifact.pause_packet?.project_update_markdown ?? artifact.project_update_markdown;
    terminalOutput.open_questions_markdown = artifact.pause_packet?.open_questions_markdown;
    if (Array.isArray(artifact.discovery_issues)) {
      terminalOutput.discovery_issues = artifact.discovery_issues;
    }
  }
  return {
    terminal_output: terminalOutput,
    evidence: artifact.evidence,
    bounds: artifact.bounds,
  };
}

export async function replayPersistedDecompositionRun({
  client,
  config,
  cache,
  projectId,
  runId,
  repoRoot = process.cwd(),
  runStoreDir = null,
  traceContext = {},
  domainContext = null,
} = {}) {
  return runDecomposition({
    client,
    config,
    cache,
    projectId,
    runId,
    repoRoot,
    runStoreDir,
    retryCommit: true,
    traceContext,
    domainContext,
  });
}

function recordRuntimeEvidenceSpans(trace, { runtimeEvidence = {}, orchestratorOutput = null } = {}) {
  const perspectivesRun = Array.isArray(orchestratorOutput?.evidence?.perspectives_run)
    ? orchestratorOutput.evidence.perspectives_run.map((entry) => ({ ...entry }))
    : [];
  for (const turn of runtimeEvidenceTurns(runtimeEvidence, perspectivesRun)) {
    const baseAttributes = knownTraceAttributes({
      role: turn.role,
      phase: turn.phase,
      outcome: turn.outcome,
      evidence_ref: turn.evidence_ref || null,
      perspectives_run: perspectivesRun,
      "agentic_factory.outcome": turn.outcome,
      "agentic_factory.perspectives_run": perspectivesRun,
    });
    if (Array.isArray(turn.tool_events) && turn.tool_events.length > 0) {
      recordPolicyCheckedEvidenceSpan(trace, "runtime_tool_events", {
        ...baseAttributes,
        tool_events: turn.tool_events,
      });
    }
    if (Array.isArray(turn.evidence_unavailable) && turn.evidence_unavailable.length > 0) {
      recordPolicyCheckedEvidenceSpan(trace, "runtime_evidence_unavailable", {
        ...baseAttributes,
        evidence_unavailable: turn.evidence_unavailable,
      });
    }
  }
}

function recordPolicyCheckedEvidenceSpan(trace, name, attributes) {
  const policy = enforceTraceContentPolicy({ spans: [{ name, attributes }] });
  if (policy.ok) {
    recordSpan(trace, name, attributes);
    return;
  }
  recordSpan(trace, "runtime_evidence_unavailable", knownTraceAttributes({
    role: attributes.role || null,
    phase: attributes.phase || null,
    outcome: attributes.outcome || null,
    scope: `${attributes.role || "runtime"}.${attributes.phase || "unknown"}.tool_events`,
    reason: policy.reason,
    perspectives_run: attributes.perspectives_run || [],
    "agentic_factory.outcome": attributes.outcome || null,
    "agentic_factory.perspectives_run": attributes.perspectives_run || [],
  }));
}

function runtimeEvidenceTurns(runtimeEvidence, perspectivesRun) {
  const turns = [];
  for (const [role, evidence] of Object.entries(runtimeEvidence || {})) {
    if (Array.isArray(evidence?.turns) && evidence.turns.length > 0) {
      turns.push(...evidence.turns.map((turn) => ({ role, ...turn })));
      continue;
    }
    if (!evidence || typeof evidence !== "object") continue;
    const perspective = perspectivesRun.find((entry) => entry.role === role);
    turns.push({
      role,
      outcome: perspective?.outcome || "unknown",
      evidence_ref: evidence.evidence_ref || perspective?.evidence_ref || null,
      tool_events: evidence.tool_events,
      evidence_unavailable: evidence.evidence_unavailable,
    });
  }
  return turns;
}

export async function resumeProjectAfterQuestions({
  client,
  config,
  cache,
  projectId,
  packet,
  repoRoot = process.cwd(),
  runStoreDir = null,
  traceContext = {},
  domainContext = null,
  onBeforeLinearMutation = null,
} = {}) {
  const domainTrace = resolveDomainTrace({ domainContext, traceContext, cache, repoRoot });
  const trace = createTrace("decomposition_run", knownTraceAttributes({
    "workflow.name": "project_decomposition_resume",
    "workflow.version": DECOMPOSITION_FUNCTION_VERSION,
    "agentic_factory.domain_id": domainTrace.domain_id,
    "agentic_factory.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.project_id": projectId,
    linear_project_id: projectId,
    run_id: packet?.run_id || null,
    event_id: traceContext.event_id || null,
    wake_id: traceContext.wake_id || null,
    trace_id: traceContext.trace_id || null,
    attempt: traceContext.attempt || null,
    workspace_id: domainTrace.workspace_id,
    domain_id: domainTrace.domain_id,
    team_id: domainTrace.team_id,
    behavior_repo_id: domainTrace.behavior_repo_id,
    source_provider: traceContext.source_provider || "linear",
    source_object_id: traceContext.source_object_id || projectId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    ...unpinnedRuntimeTraceAttributes(config),
  }));
  const runtimeAssignments = resolveRoleRuntimeAssignments(config);
  const shape = await resolveLinearShape({ client, config, cache });
  const project = await client.getProjectContext(projectId);
  recordSpan(trace, "load_project_context", {
    linear_project_id: project.id,
    issue_count: project.issues?.length || 0,
  });

  const validation = validateResumePacket(packet);
  if (!validation.ok) return failClosed(trace, validation.failureReasons);

  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "resume",
    run_id: packet.run_id,
    domain_id: domainTrace.domain_id,
    workspace_id: domainTrace.workspace_id,
    team_id: domainTrace.team_id,
    linear_project_id: project.id,
    runtime_assignments: runtimeAssignments,
    runtime_metadata: buildRuntimeMetadata({
      acceptedPackets: [packet],
      runtimeAssignments,
    }),
    packet,
  };
  persistRunArtifact({ artifact, repoRoot, runStoreDir, trace });
  return applyPersistedArtifact({
    client,
    config,
    shape,
    project,
    artifact,
    trace,
    repoRoot,
    runStoreDir,
    onBeforeLinearMutation,
  });
}

export async function encodeDiscoveryFindingsAndResume(options = {}) {
  return resumeProjectAfterQuestions(options);
}
