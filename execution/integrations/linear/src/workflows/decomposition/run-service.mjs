import { createTrace, recordSpan } from "../../trace.mjs";
import {
  enforceTraceContentPolicy,
  LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
} from "../../../../../engine/trace-contract.mjs";
import { readRunArtifact, runArtifactPath } from "../../../../../engine/run-store.mjs";
import { validateOrchestratorOutput } from "../../../../../engine/orchestrator-output.mjs";
import { commitPayload as decompositionCommitPayload } from "./commit-payload.mjs";
import { decompositionDefinition } from "./definition.mjs";
import {
  acceptedRefFromLoadedSnapshot,
  unjoinableCoverageMarker,
} from "../../../../../engine/run-accepted-refs.mjs";
import { resolveRoleRuntimeAssignments } from "../../runtime-adapters.mjs";
import {
  knownTraceAttributes,
  resolveTeamTrace,
} from "../../linear/matching-utils.mjs";
import { resolveLinearShape } from "../../linear/shape-resolver.mjs";
import { evaluateEligibilityFromContext } from "./eligibility.mjs";
import {
  maybeApplyPersistedArtifact,
  validateReplayArtifactTeam,
  validateReplayArtifactProject,
} from "./artifact-apply.mjs";
import { canApplyTerminal } from "../../../../../engine/terminal-gate.mjs";
import { unpinnedRuntimeTraceAttributes } from "../../config.mjs";
import { resolveTeamiHome } from "../../app-home.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../../phase-contract.mjs";
import {
  captureRunProjectSnapshot,
  failClosed,
  persistRunArtifact,
  terminalArtifact,
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
  home = resolveTeamiHome(),
  runStoreDir = null,
  runtimeEvidence = {},
  retryCommit = false,
  traceContext = {},
  teamContext = null,
  evalMode = false,
  onBeforeLinearMutation = null,
  qualityJudge = false,
  acceptedRefs = null,
  loadJudgeContractFn = null,
} = {}) {
  const teamTrace = resolveTeamTrace({ teamContext, traceContext, cache, repoRoot });
  const trace = createTrace(decompositionDefinition.trace_descriptor.trace_name, knownTraceAttributes({
    "workflow.name": "project_decomposition",
    "workflow.version": DECOMPOSITION_FUNCTION_VERSION,
    "teami.team_ref": teamTrace.team_ref,
    "teami.behavior_repo_id": teamTrace.behavior_repo_id,
    behavior_config_commit: config?.behavior_config_commit || null,
    "linear.workspace_id": teamTrace.workspace_id,
    "linear.team_id": teamTrace.team_id,
    "linear.project_id": projectId,
    linear_project_id: projectId,
    run_id: runId || runResult?.terminal_output?.run_id || null,
    event_id: traceContext.event_id || null,
    wake_id: traceContext.wake_id || null,
    trace_id: traceContext.trace_id || null,
    attempt: traceContext.attempt || null,
    workspace_id: teamTrace.workspace_id,
    team_ref: teamTrace.team_ref,
    team_id: teamTrace.team_id,
    behavior_repo_id: teamTrace.behavior_repo_id,
    source_provider: traceContext.source_provider || "linear",
    source_object_id: traceContext.source_object_id || projectId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    ...unpinnedRuntimeTraceAttributes(config),
  }));

  const runtimeAssignments = resolveRoleRuntimeAssignments(config, "decomposition");
  if (retryCommit) {
    const persisted = readRunArtifact({
      runId,
      repoRoot,
      home,
      teamRef: teamContext?.teamRef || teamTrace.team_ref || null,
      runStoreDir,
    });
    if (!persisted) throw new Error(`No persisted run artifact found for ${runId}.`);
    validateReplayArtifactTeam({ artifact: persisted, teamContext, replayed: true });
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
      artifact_path: runArtifactPath({
        runId,
        repoRoot,
        home,
        teamRef: teamContext?.teamRef || teamTrace.team_ref || null,
        runStoreDir,
      }),
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
      cache,
      shape,
      project,
      artifact: persisted,
      payload: persisted.payload,
      trace,
      repoRoot,
      runStoreDir,
      replayed: true,
      teamContext,
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
    home,
    teamRef: teamContext?.teamRef || teamTrace.team_ref || null,
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
    teamTrace,
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
    home,
    runStoreDir,
    trace,
    returnDurabilityResult: true,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
  });
  const persistedArtifact = readRunArtifact({
    runId: artifact.run_id,
    repoRoot,
    home,
    teamRef: artifact.team_ref,
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
    cache,
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
  const appendToProjectUpdate = shouldAppendAdvisoryToProjectUpdate({ runResult, artifact });
  const projectUpdateMarkdown = appendToProjectUpdate
    ? appendAdvisoryQualityLine(
      runResult.terminal_output.project_update_markdown,
      advisory.result,
    )
    : null;
  recordQualityJudgeRunSpan(trace, advisory.result);
  safelyRecordSpan(trace, "quality_check_advisory", {
    judge_state: advisory.result?.judge_state || "judge_unavailable",
    judge_label: advisory.result?.judge?.label || null,
    reason: advisory.result?.reason || null,
    advisory_line: advisory.line,
    appended_to_project_update_markdown: appendToProjectUpdate,
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
    artifact: appendToProjectUpdate
      ? withArtifactProjectUpdateMarkdown(artifact, projectUpdateMarkdown)
      : artifact,
    // Default to the judge's OWN contract loader so the captured version
    // provably matches what the judge consumed; tests may inject a throwing
    // loader to exercise the unjoinable-marker degrade path.
    loadPromptRegistrationContract: loadJudgeContractFn || loadPromptRegistrationContract,
    targetKey: DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
  });
  if (!appendToProjectUpdate) {
    return {
      runResult,
      artifact: withJudgeRef,
    };
  }
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

function recordQualityJudgeRunSpan(trace, result) {
  try {
    const judge = isRecord(result?.judge) ? result.judge : null;
    const judgeState = typeof result?.judge_state === "string" && result.judge_state.trim()
      ? result.judge_state
      : "judge_unavailable";
    safelyRecordSpan(trace, "quality_judge_run", knownTraceAttributes({
      role: "judge",
      agent_role: "decomposition_quality_judge",
      judge_state: judgeState,
      judge_label: judge?.label || null,
      judge_score: typeof judge?.score === "number" ? judge.score : null,
      reason: result?.reason || null,
      run_id: result?.run_id || null,
      trace_id: result?.trace_id || null,
      asked: knownTraceAttributes({
        prompt: typeof result?.judge_prompt === "string" ? result.judge_prompt : null,
        inputs: isRecord(result?.judge_inputs) ? result.judge_inputs : null,
      }),
      did: knownTraceAttributes({
        raw_output: typeof result?.raw_output === "string" ? result.raw_output : null,
        raw_output_excerpt: typeof result?.raw_output_excerpt === "string" ? result.raw_output_excerpt : null,
        parsed_judge: judge,
        parse_failures: arrayAttribute(result?.parse_failures),
      }),
      outcome: knownTraceAttributes({
        judge_state: judgeState,
        label: judge?.label || null,
        score: typeof judge?.score === "number" ? judge.score : null,
        explanation: judge?.explanation || null,
        failure_modes: arrayAttribute(judge?.failure_modes),
        failure_mode_details: arrayAttribute(judge?.failure_mode_details),
        low_confidence_reasons: arrayAttribute(result?.low_confidence_reasons),
        storage: result?.storage || null,
        annotation_ids: arrayAttribute(result?.annotation_ids),
        reason: result?.reason || null,
      }),
      settings: knownTraceAttributes({
        evaluator_id: result?.evaluator_id || null,
        identifier: result?.identifier || null,
        model: result?.model || null,
        runtime: result?.runtime || null,
        prompt_source: result?.prompt_source || null,
        prompt_version: result?.prompt_version || null,
        rubric_version: result?.rubric_version || null,
        failure_taxonomy_version: result?.failure_taxonomy_version || null,
        trace_status: result?.trace_status || null,
      }),
      "teami.outcome": judgeState,
    }));
  } catch {
    // Observability cannot change the advisory or terminal run outcome.
  }
}

function safelyRecordSpan(trace, name, attributes = {}) {
  try {
    if (!trace) return null;
    return recordSpan(trace, name, attributes);
  } catch {
    return null;
  }
}

function arrayAttribute(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function shouldAppendAdvisoryToProjectUpdate({ runResult, artifact } = {}) {
  const outcome = runResult?.terminal_output?.outcome || artifact?.terminal_output?.outcome || null;
  if (outcome === "commit" || outcome === "failed_closed") return true;
  return artifact?.source === "failed_closed";
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
  if (artifact.source !== "failed_closed") return artifact;
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
    if (artifact.project_body_update) terminalOutput.project_body_update = artifact.project_body_update;
  } else if (artifact.kind === "pause") {
    terminalOutput.open_questions_markdown = artifact.pause_packet?.open_questions_markdown;
    if (artifact.source === "failed_closed" || terminalOutput.outcome === "failed_closed") {
      terminalOutput.project_update_markdown =
        artifact.pause_packet?.project_update_markdown ?? artifact.project_update_markdown;
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
  teamContext = null,
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
    teamContext,
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
      "teami.outcome": turn.outcome,
      "teami.perspectives_run": perspectivesRun,
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
  const policy = enforceTraceContentPolicy(
    { spans: [{ name, attributes }] },
    LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
  );
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
    "teami.outcome": attributes.outcome || null,
    "teami.perspectives_run": attributes.perspectives_run || [],
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
