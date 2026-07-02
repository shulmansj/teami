import { createHash, randomUUID } from "node:crypto";

import { evaluateDecompositionEligibility, runDecomposition } from "./linear-service.mjs";
import { createTrace, recordSpan } from "./trace.mjs";
import { createOrchestratorTurnTraceSink } from "./orchestrator-turn-trace-sink.mjs";
import {
  parseResourceTargetFromDescription,
  renderResourceTargetBlock,
} from "./resource-target.mjs";
import {
  DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  runRuntimeCommand,
} from "./runtime-command.mjs";
import {
  executeOrchestratorTurn,
  executeSubagent,
} from "./orchestrator-turn.mjs";
import { createOrchestratorRoster } from "./orchestrator-roster.mjs";
import {
  buildRuntimeMetadata,
  resolveRoleRuntimeAssignments,
} from "./runtime-adapters.mjs";
import { commitPayload as decompositionCommitPayload } from "./workflows/decomposition/commit-payload.mjs";
import {
  DECOMPOSITION_REQUIRED_CAPABILITIES,
  DECOMPOSITION_WORKFLOW_TYPE,
  decompositionDefinition,
} from "./workflows/decomposition/definition.mjs";
import { commitPayload as executionCommitPayload } from "./workflows/execution/commit-payload.mjs";
import {
  EXECUTION_REQUIRED_CAPABILITIES,
  EXECUTION_WORKFLOW_TYPE,
} from "./workflows/execution/definition.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "./workflows/execution/effect-ids.mjs";
import {
  EXECUTION_FUNCTION_VERSION,
  EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
} from "./workflows/execution/phase-contract.mjs";
import {
  createDefaultExecutionPullRequestAdapter,
} from "./execution-pr-adapter.mjs";
import {
  runExecutionProfilePreflight,
} from "./execution-profile-preflight.mjs";
import {
  parseRemediationMarker,
  READINESS_REPAIR_REMEDIATION_KIND,
  remediationFailureSignature,
  renderRemediationMarker,
} from "./remediation-marker.mjs";
import { doctorMergeDoneAutomationCheck } from "./linear/doctor-service.mjs";
import { isIssueClosed } from "./linear/matching-utils.mjs";
import { issueNeedsPrincipalEscalationEffectDescriptor } from "./linear/issue-needs-principal-effect.mjs";
import {
  locatePullRequestForIssue,
  resourcesToRepoIdentity,
} from "./review-pr-discovery.mjs";
import { commitPayload as reviewCommitPayload } from "./workflows/review/commit-payload.mjs";
import {
  REVIEW_REQUIRED_CAPABILITIES,
  REVIEW_WORKFLOW_TYPE,
} from "./workflows/review/definition.mjs";
import {
  REVIEW_FUNCTION_VERSION,
  REVIEW_RUN_PAYLOAD_SCHEMA_ID,
} from "./workflows/review/phase-contract.mjs";
import {
  selectEffectsForDisposition,
} from "./workflows/review/effect-selector.mjs";
import { resolveWakeDomainContext } from "./domain-resolver.mjs";
import { defaultRunGit } from "../../git/git-repo-materializer.mjs";
import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import {
  ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
  validateOrchestratorOutput,
} from "../../../engine/orchestrator-output.mjs";
import { normalizeArtifactSetLineage } from "../../../engine/produced-identities.mjs";
import * as triggerIdempotency from "./trigger-idempotency.mjs";
import {
  assertRunStoreWritable,
  readRunArtifact,
  writeRunArtifact,
} from "../../../engine/run-store.mjs";
import { canApplyTerminal } from "../../../engine/terminal-gate.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import {
  isRecord,
  MODULE_REPO_ROOT,
  runOrchestratorLoop,
  runtimeEvidenceEntries,
} from "../../../engine/orchestrator-loop.mjs";
export { runRuntimeCommand, resolveRuntimeSpawnCommand } from "./runtime-command.mjs";
export { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
export { DECOMPOSITION_REQUIRED_CAPABILITIES } from "./workflows/decomposition/definition.mjs";

export async function runDecompositionOrchestrator(options = {}) {
  const {
    commitPayload = decompositionCommitPayload,
    definition = getDecompositionDefinition(),
    ...rest
  } = options;
  return runOrchestratorLoop({ ...rest, definition, commitPayload });
}

const REQUIRED_CAPABILITIES = DECOMPOSITION_REQUIRED_CAPABILITIES;

export const PRE_DOMAIN_CACHE_REPAIR_REASON = "pre_domain_cache_requires_reinit";
export const PRE_DOMAIN_CACHE_REPAIR_HINT = "Run npm run init or npm run reset to write a per-domain Linear cache.";
export const DOMAIN_CONTEXT_REQUIRED_REASON = "domain_context_required";
export const DOMAIN_REGISTRY_REQUIRED_REASON = "domain_registry_required";
export const EXECUTION_RUN_DEPS_REQUIRED_REASON = "execution_run_deps_required";
export const REVIEW_RUN_DEPS_REQUIRED_REASON = "review_run_deps_required";
export const RESOURCE_TARGET_MISSING_REASON = "resource_target_missing";
export const RESOURCE_TARGET_NOT_ALLOWED_REASON = "resource_target_not_allowed";

const REVIEW_IN_REVIEW_TRIGGER_TYPE = "linear.issue.in_review";
const NO_REVIEW_HEAD_SHA = "0000000000000000000000000000000000000000";
const REMEDIATION_RETRY_CAP = 1;
const EXECUTION_PREFLIGHT_REMEDIATION_EFFECT_ID = "linear_execution_preflight_remediation";

export async function runTriggeredWorkflow(options = {}) {
  return runTriggeredDecomposition(options);
}

export async function runTriggeredDecomposition(options = {}) {
  const {
    store,
    runnerId,
    workspaceId,
    linearClient = null,
    linearClientFactory = null,
    config,
    cache,
    // The production caller defaults the runtime + orchestrator-turn executors
    // and the roster to the REAL executors (the live runner). The loop itself
    // carries no in-signature default (Seam 1), so a test drives a deterministic
    // orchestrator by passing fakes here; the live runner uses these defaults.
    runtimeExecutor = createProcessRuntimeExecutor(),
    orchestratorTurnExecutor = executeOrchestratorTurn,
    roster = createOrchestratorRoster({ workflowType: DECOMPOSITION_WORKFLOW_TYPE }),
    repoRoot = process.cwd(),
    runStoreDir = null,
    leaseDurationMs,
    runnerVersion = "local",
    capabilities = REQUIRED_CAPABILITIES,
    idGenerator = defaultRunId,
    traceSink = null,
    spanSink = null,
    domainContext,
    registry,
    claimWebhookIds = null,
    claim: claimedWake = null,
    // The advisory quality judge runs the real judge CLI by default (production).
    // Tests that drive the full runner with a deterministic orchestrator pass a
    // fake judge function here so the run never spawns the real judge process;
    // the default preserves production behavior exactly (advisory, non-gating).
    qualityJudge = true,
  } = options;
  if (!store) throw new Error("wake queue store is required.");
  const servedDomainContext = requireDomainContext(domainContext);
  if (!registry) throw new Error(`${DOMAIN_REGISTRY_REQUIRED_REASON}: trigger runner requires the domain registry.`);

  if (!claimedWake) {
    const webhookFilter = claimWebhookIds === null
      ? [servedDomainContext.linear.webhookId].filter(Boolean)
      : claimWebhookIds;
    await store.heartbeat?.({
      runnerId,
      workspaceId,
      version: runnerVersion,
      capabilities,
    });
    const claim = await store.claimNextWake({
      workspaceId,
      runnerId,
      version: runnerVersion,
      capabilities,
      webhookIds: webhookFilter,
      leaseDurationMs,
    });
    if (!claim.ok) return { status: "idle", reason: claim.reason, claim };
    const dispatch = await resolveClaimedWorkflowDefinition({ store, runnerId, claim });
    if (!dispatch.ok) return dispatch.result;
    return dispatch.definition.run({ ...options, claim });
  }

  const claim = claimedWake;
  const { wake, leaseToken } = claim;
  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: wakeDomainSelector({ wake, workspaceId }),
  });
  if (!resolved.ok) {
    const quarantined = await store.markWakeRoutingError({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: resolved.reason,
      candidates: resolved.candidates || [],
    });
    if (!quarantined.ok) {
      return { status: "failed_closed", reason: quarantined.reason, wake };
    }
    return {
      status: "routing_error",
      reason: resolved.reason,
      candidates: resolved.candidates || [],
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  const resolvedDomainContext = resolved.context;
  if (resolvedDomainContext.domainId !== servedDomainContext.domainId) {
    const released = await store.releaseWake({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: "domain_not_served",
    });
    if (!released.ok) return { status: "failed_closed", reason: released.reason, wake };
    return {
      status: "released",
      reason: "domain_not_served",
      resolvedDomainId: resolvedDomainContext.domainId,
      servedDomainId: servedDomainContext.domainId,
      release: released,
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  // The local claim response carries the source event directly; the store-array
  // lookup remains as the in-memory store fallback so the wake
  // queue contract does not need to expose internal storage.
  const sourceEvent =
    claim.event ||
    store.triggerEvents?.find((event) => event.id === wake.source_event_id) ||
    null;
  const runId = idGenerator({ wake, sourceEvent });
  const domainTrace = resolvedDomainContext.trace;
  const running = await store.markWakeRunning({
    wakeId: wake.id,
    runnerId,
    leaseToken,
    runId,
    domainId: resolvedDomainContext.domainId,
  });
  if (!running.ok) return { status: "failed_closed", reason: running.reason, wake };
  const renewal = startLeaseRenewal({
    store,
    wakeId: wake.id,
    runnerId,
    workspaceId,
    runnerVersion,
    capabilities,
    leaseToken,
    leaseDurationMs,
  });
  let traceSession = null;

  try {
    assertRunStoreWritable({ repoRoot, runStoreDir });
    await renewal.renewNow();
    traceSession = traceSink
      ? await traceSink.startRun?.({
          wake,
          sourceEvent,
          runId,
          workspaceId,
          runnerId,
          runnerVersion,
          domainContext: resolvedDomainContext,
        }).catch((error) => ({
          ok: false,
          traceId: null,
          status: "trace_unavailable",
          reason: error.message,
        }))
      : null;
    const runLinearClient = linearClient || await linearClientFactory?.();
    if (!runLinearClient) throw new Error("linear_client_required_after_domain_resolution");
    const eligibilityTrace = createTrace(decompositionDefinition.trace_descriptor.trace_name, knownTraceAttributes({
      "workflow.name": "project_decomposition",
      "teami.domain_id": domainTrace.domain_id,
      "teami.behavior_repo_id": domainTrace.behavior_repo_id,
      "linear.workspace_id": domainTrace.workspace_id,
      "linear.team_id": domainTrace.team_id,
      "linear.project_id": wake.object_id,
      linear_project_id: wake.object_id,
      run_id: runId,
      event_id: sourceEvent?.event_id || null,
      wake_id: wake.id,
      trace_id: traceSession?.traceId || null,
      attempt: wake.attempt_count || null,
      workspace_id: domainTrace.workspace_id,
      domain_id: domainTrace.domain_id,
      team_id: domainTrace.team_id,
      behavior_repo_id: domainTrace.behavior_repo_id,
      source_provider: sourceEvent?.provider || "linear",
      source_object_id: wake.object_id,
      trigger_type: wake.trigger_type || null,
      runner_id: runnerId,
      runner_version: runnerVersion,
    }));
    const eligibility = await evaluateDecompositionEligibility({
      client: runLinearClient,
      config,
      cache,
      projectId: wake.object_id,
      trace: eligibilityTrace,
    });
    if (!eligibility.eligible) {
      const rejected = await store.completeWake({
        wakeId: wake.id,
        runnerId,
        leaseToken,
        status: "rejected",
        reason: eligibility.blockingConditions.join(",") || "ineligible",
      });
      const traceDelivery = await traceSink?.finishRun?.({
        session: traceSession,
        result: {
          status: "ineligible",
          reason: rejected.wake.reason,
          trace: eligibilityTrace,
        },
        wake: rejected.wake,
      }).catch((error) => ({ status: "trace_delivery_failed", reason: error.message }));
      return {
        status: "rejected",
        reason: rejected.wake.reason,
        wake: rejected.wake,
        eligibility,
        traceDelivery,
      };
    }

    const definition = getDecompositionDefinition();
    // Default per-turn observability: when no sink is injected, collect turn spans
    // and drain them into the run trace so operators see them in Phoenix by default.
    const ownTurnSpanSink = spanSink ? null : createOrchestratorTurnTraceSink();
    const {
      output,
      environment,
      runtimeEvidence,
      acceptedRefs,
    } = await runOrchestratorLoop({
      runId,
      wake,
      event: sourceEvent,
      project: eligibility.project,
      config,
      runtimeExecutor,
      orchestratorTurnExecutor,
      roster,
      definition,
      commitPayload: decompositionCommitPayload,
      renew: () => renewal.renewNow(),
      repoRoot: MODULE_REPO_ROOT,
      allowedRepoPacket: resolvedDomainContext?.allowedRepoPacket ?? [],
      spanSink: spanSink || ownTurnSpanSink,
    });

    await renewal.renewNow();
    const result = await runDecomposition({
      client: runLinearClient,
      config,
      cache,
      projectId: wake.object_id,
      runResult: output,
      environment,
      runId,
      repoRoot,
      runStoreDir,
      runtimeEvidence,
      acceptedRefs,
      traceContext: {
        event_id: sourceEvent?.event_id || null,
        wake_id: wake.id,
        run_id: runId,
        trace_id: traceSession?.traceId || null,
        attempt: wake.attempt_count || null,
        workspace_id: domainTrace.workspace_id,
        domain_id: domainTrace.domain_id,
        team_id: domainTrace.team_id,
        behavior_repo_id: domainTrace.behavior_repo_id,
        source_provider: sourceEvent?.provider || "linear",
        source_object_id: wake.object_id,
        trigger_type: wake.trigger_type || null,
        runner_id: runnerId,
        runner_version: runnerVersion,
      },
      domainContext: resolvedDomainContext,
      qualityJudge,
      onBeforeLinearMutation: async ({ artifactKind, runId: artifactRunId, trace }) => {
        await traceSink?.forceFlush?.({
          session: traceSession,
          trace,
          result: { status: "running" },
          stage: "pre_mutation",
        }).catch(() => {});
        const mutation = await store.markMutationStarted({
          wakeId: wake.id,
          runnerId,
          leaseToken,
          runId: artifactRunId || runId,
          artifactKind,
        });
        if (!mutation.ok) throw new Error(`Could not mark wake mutation start: ${mutation.reason}`);
      },
    });
    ownTurnSpanSink?.drainInto(result?.trace);
    const traceDelivery = await traceSink?.finishRun?.({ session: traceSession, result, wake })
      .catch((error) => ({ status: "trace_delivery_failed", reason: error.message }));
    return await finishWakeFromRunnerResult({ store, wake, runnerId, leaseToken, result, traceDelivery });
  } catch (error) {
    const current = await store.getWake(wake.id);
    const reason = current?.mutation_started_at
      ? `runner_failed_after_linear_mutation_started:${error.message}`
      : `runner_failed_closed:${error.message}`;
    if (current?.mutation_started_at) {
      const dead = await store.deadLetterWake({ wakeId: wake.id, runnerId, leaseToken, reason });
      const traceDelivery = await traceSink?.finishRun?.({
        session: traceSession,
        result: { status: "dead_letter", reason, trace: null },
        wake: dead.wake,
      }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
      return { status: "dead_letter", reason, wake: dead.wake, error, traceDelivery };
    }
    const rejected = await store.completeWake({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      status: "rejected",
      reason,
    });
    const traceDelivery = await traceSink?.finishRun?.({
      session: traceSession,
      result: { status: "failed_closed", reason, trace: null },
      wake: rejected.wake,
    }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
    return { status: "rejected", reason, wake: rejected.wake, error, traceDelivery };
  } finally {
    renewal.stop();
  }
}

export async function runTriggeredExecution(options = {}) {
  const {
    store: topLevelStore = null,
    runnerId,
    workspaceId,
    linearClient = null,
    linearClientFactory = null,
    config,
    cache,
    runtimeExecutor = createProcessRuntimeExecutor(),
    orchestratorTurnExecutor = executeOrchestratorTurn,
    roster = null,
    repoRoot = process.cwd(),
    runStoreDir = null,
    leaseDurationMs,
    runnerVersion = "local",
    capabilities = EXECUTION_REQUIRED_CAPABILITIES,
    idGenerator = defaultRunId,
    traceSink = null,
    spanSink = null,
    domainContext,
    registry,
    claim: claimedWake = null,
    issueId = null,
    retry = false,
    firstTurnWarmStart = null,
    resumeFrom = null,
    killPoint = null,
    runDeps = {},
    gitRemoteUrlOverride = null,
    gitRemoteUrlOverrides = null,
    resolveGitRemoteUrl = null,
  } = options;
  const store = topLevelStore || runDeps.store;
  if (!store) throw new Error(`${EXECUTION_RUN_DEPS_REQUIRED_REASON}: runDeps.store is required.`);
  if (typeof runDeps.materialize !== "function") {
    throw new Error(`${EXECUTION_RUN_DEPS_REQUIRED_REASON}: runDeps.materialize is required.`);
  }
  const servedDomainContext = requireDomainContext(domainContext);
  if (!registry) throw new Error(`${DOMAIN_REGISTRY_REQUIRED_REASON}: execution trigger runner requires the domain registry.`);

  let claim = claimedWake;
  if (!claim) {
    const syntheticIssueId = stringOrNull(issueId);
    if (!syntheticIssueId) throw new Error("execution_issue_id_required");
    if (typeof store.claimSyntheticIssueWake !== "function") {
      throw new Error(`${EXECUTION_RUN_DEPS_REQUIRED_REASON}: store.claimSyntheticIssueWake is required for direct issue execution.`);
    }
    claim = await store.claimSyntheticIssueWake({
      domainId: servedDomainContext.domainId,
      workspaceId: servedDomainContext.linear.workspaceId,
      teamId: servedDomainContext.linear.teamId,
      objectId: syntheticIssueId,
      workflowType: EXECUTION_WORKFLOW_TYPE,
      triggerType: "linear.issue.ready",
      objectType: "issue",
    });
    if (!claim.ok) {
      return {
        status: "failed_closed",
        reason: claim.reason || "synthetic_issue_wake_claim_failed",
        claim,
      };
    }
  }

  const { wake, leaseToken } = claim;
  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: wakeDomainSelector({ wake, workspaceId }),
  });
  if (!resolved.ok) {
    const quarantined = await store.markWakeRoutingError?.({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: resolved.reason,
      candidates: resolved.candidates || [],
    });
    if (quarantined && !quarantined.ok) {
      return { status: "failed_closed", reason: quarantined.reason, wake };
    }
    return {
      status: "routing_error",
      reason: resolved.reason,
      candidates: resolved.candidates || [],
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  const resolvedDomainContext = resolved.context;
  if (resolvedDomainContext.domainId !== servedDomainContext.domainId) {
    const released = await store.releaseWake?.({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: "domain_not_served",
    });
    if (released && !released.ok) return { status: "failed_closed", reason: released.reason, wake };
    return {
      status: "released",
      reason: "domain_not_served",
      resolvedDomainId: resolvedDomainContext.domainId,
      servedDomainId: servedDomainContext.domainId,
      release: released,
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  const sourceEvent =
    claim.event ||
    store.triggerEvents?.find((event) => event.id === wake.source_event_id) ||
    null;
  const runId = idGenerator({ wake, sourceEvent });
  const effectiveIssueId = stringOrNull(issueId) || stringOrNull(wake.object_id);
  if (!effectiveIssueId) throw new Error("execution_issue_id_required");
  const running = await store.markWakeRunning({
    wakeId: wake.id,
    runnerId,
    leaseToken,
    runId,
    domainId: resolvedDomainContext.domainId,
  });
  if (!running.ok) return { status: "failed_closed", reason: running.reason, wake };

  const renewal = startLeaseRenewal({
    store,
    wakeId: wake.id,
    runnerId,
    workspaceId,
    runnerVersion,
    capabilities,
    leaseToken,
    leaseDurationMs,
  });
  let traceSession = null;

  try {
    assertRunStoreWritable({ repoRoot, runStoreDir });
    await renewal.renewNow();
    traceSession = traceSink
      ? await traceSink.startRun?.({
          wake,
          sourceEvent,
          runId,
          workspaceId,
          runnerId,
          runnerVersion,
          domainContext: resolvedDomainContext,
        }).catch((error) => ({
          ok: false,
          traceId: null,
          status: "trace_unavailable",
          reason: error.message,
        }))
      : null;
    const runLinearClient = linearClient || await linearClientFactory?.();
    if (!runLinearClient) throw new Error("linear_client_required_after_domain_resolution");

    const definition = getExecutionDefinition();
    let issue = await loadExecutionIssueContext({ client: runLinearClient, issueId: effectiveIssueId });
    const issueIdentifier = stringOrNull(issue?.identifier);
    if (!issueIdentifier) throw new Error("git_repo_issue_identifier_required");
    const pendingGitIntent = await triggerIdempotency.readGitReplayPending({
      domainId: resolvedDomainContext.domainId,
      objectId: effectiveIssueId,
      repoRoot,
      runStoreDir,
    }) || coldResumeGitIntentFromRunDeps(runDeps, {
      domainId: resolvedDomainContext.domainId,
      objectId: effectiveIssueId,
    });
    const domainResources = domainResourcesForExecution({
      domainContext: resolvedDomainContext,
      registry,
      issue,
    });
    const gitRemoteResolution = gitRemoteResolutionOptions({
      gitRemoteUrlOverride,
      gitRemoteUrlOverrides,
      resolveGitRemoteUrl,
      runDeps,
    });
    const materialized = await runDeps.materialize({
      domainResources,
      runId,
      engineRepoRoot: MODULE_REPO_ROOT,
      repoRoot,
      domainContext: resolvedDomainContext,
      registry,
      issueId: effectiveIssueId,
      issue,
      issueIdentifier,
      pendingGitIntent,
      runGit: runDeps.runGit || defaultRunGit,
      ...gitRemoteResolution,
    });
    const runContext = normalizeMaterializedRunContext(materialized, gitRemoteResolution);
    const runtimeOptions = runtimeOptionsFromRunContext(runContext);
    const ownTurnSpanSink = spanSink ? null : createOrchestratorTurnTraceSink();
    const normalizedResumeFrom = normalizeExecutionResumeFrom(resumeFrom);
    let result = null;
    try {
      const profilePreflight = await runExecutionPreflightForRun({
        runDeps,
        issue,
        runContext,
        runtimeOptions,
        config,
      });
      runContext.executionProfilePreflight = profilePreflight;
      if (!profilePreflight.ok) {
        result = await executionPreflightRemediationBlocked({
          client: runLinearClient,
          config,
          cache,
          definition,
          domainContext: resolvedDomainContext,
          issue,
          issueId: effectiveIssueId,
          runId,
          traceContext: {
            event_id: sourceEvent?.event_id || null,
            wake_id: wake.id,
            trace_id: traceSession?.traceId || null,
            attempt: wake.attempt_count || null,
            source_provider: sourceEvent?.provider || "linear",
            source_object_id: effectiveIssueId,
            trigger_type: wake.trigger_type || null,
            runner_id: runnerId,
            runner_version: runnerVersion,
          },
          runContext,
          preflight: profilePreflight,
        });
      } else {
        runContext.executionPreflightRemediationRetryOutcome = await executionPreflightRemediationRetryOutcome({
          client: runLinearClient,
          issue,
          issueId: effectiveIssueId,
          runContext,
          preflight: profilePreflight,
        });
        issue = await claimExecutionIssueInProgress({
          client: runLinearClient,
          issue,
          issueId: effectiveIssueId,
          cache,
        });
        const {
          output,
          environment,
          runtimeEvidence,
          acceptedRefs,
          orchestratorSessionHandle,
        } = await runOrchestratorLoop({
          runId,
          wake,
          event: sourceEvent,
          project: issue,
          config,
          runtimeExecutor,
          orchestratorTurnExecutor,
          roster: roster || createOrchestratorRoster({ workflowType: EXECUTION_WORKFLOW_TYPE, repoRoot }),
          definition,
          commitPayload: executionCommitPayload,
          renew: () => renewal.renewNow(),
          repoRoot,
          cwd: runtimeOptions.cwd,
          envAugment: runtimeOptions.envAugment,
          firstTurnWarmStart,
          resumeFrom: normalizedResumeFrom,
          spanSink: spanSink || ownTurnSpanSink,
        });

        await renewal.renewNow();
        const resumeRecord = resumeRecordFromTerminalOutput({
          terminalOutput: output?.terminal_output,
          resumeFrom: normalizedResumeFrom,
        });
        result = await runExecutionTerminalCommit({
          client: runLinearClient,
          config,
          cache,
          issue,
          issueId: effectiveIssueId,
          runResult: output,
          environment,
          runId,
          repoRoot,
          runStoreDir,
          runtimeEvidence,
          acceptedRefs,
          driverSessionHandle: orchestratorSessionHandle,
          traceContext: {
            event_id: sourceEvent?.event_id || null,
            wake_id: wake.id,
            run_id: runId,
            trace_id: traceSession?.traceId || null,
            attempt: wake.attempt_count || null,
            workspace_id: resolvedDomainContext.trace.workspace_id,
            domain_id: resolvedDomainContext.trace.domain_id,
            team_id: resolvedDomainContext.trace.team_id,
            behavior_repo_id: resolvedDomainContext.trace.behavior_repo_id,
            source_provider: sourceEvent?.provider || "linear",
            source_object_id: effectiveIssueId,
            trigger_type: wake.trigger_type || null,
            runner_id: runnerId,
            runner_version: runnerVersion,
          },
          domainContext: resolvedDomainContext,
          runContext,
          runtimeAssignments: resolveRoleRuntimeAssignments(config, EXECUTION_WORKFLOW_TYPE),
          definition,
          runDeps,
          store,
          wake,
          leaseToken,
          runnerId,
          retry,
          killPoint,
          resumeRecord,
        });
        ownTurnSpanSink?.drainInto(result?.trace);
      }
    } finally {
      await materialized?.teardownAll?.();
    }
    const traceDelivery = await traceSink?.finishRun?.({ session: traceSession, result, wake })
      .catch((error) => ({ status: "trace_delivery_failed", reason: error.message }));
    return await finishWakeFromRunnerResult({ store, wake, runnerId, leaseToken, result, traceDelivery });
  } catch (error) {
    const current = await store.getWake?.(wake.id);
    const reason = isResourceTargetSelectionError(error)
      ? error.message
      : current?.mutation_started_at
      ? `runner_failed_after_execution_mutation_started:${error.message}`
      : `runner_failed_closed:${error.message}`;
    if (current?.mutation_started_at) {
      const dead = await store.deadLetterWake({ wakeId: wake.id, runnerId, leaseToken, reason });
      const traceDelivery = await traceSink?.finishRun?.({
        session: traceSession,
        result: { status: "dead_letter", reason, trace: null },
        wake: dead.wake,
      }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
      return { status: "dead_letter", reason, wake: dead.wake, error, traceDelivery };
    }
    const rejected = await store.completeWake({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      status: "rejected",
      reason,
    });
    const traceDelivery = await traceSink?.finishRun?.({
      session: traceSession,
      result: { status: "failed_closed", reason, trace: null },
      wake: rejected.wake,
    }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
    return { status: "rejected", reason, wake: rejected.wake, error, traceDelivery };
  } finally {
    renewal.stop();
  }
}

export async function runTriggeredReview(options = {}) {
  const {
    store: topLevelStore = null,
    runnerId,
    workspaceId,
    linearClient = null,
    linearClientFactory = null,
    config,
    cache,
    runtimeExecutor = createProcessRuntimeExecutor(),
    orchestratorTurnExecutor = executeOrchestratorTurn,
    roster = null,
    repoRoot = process.cwd(),
    runStoreDir = null,
    leaseDurationMs,
    runnerVersion = "local",
    capabilities = REVIEW_REQUIRED_CAPABILITIES,
    idGenerator = defaultRunId,
    traceSink = null,
    spanSink = null,
    domainContext,
    registry,
    claim: claimedWake = null,
    issueId = null,
    reviewDecision = null,
    firstTurnWarmStart = null,
    runDeps = {},
  } = options;
  const store = topLevelStore || runDeps.store;
  if (!store) throw new Error(`${REVIEW_RUN_DEPS_REQUIRED_REASON}: runDeps.store is required.`);
  const servedDomainContext = requireDomainContext(domainContext);
  if (!registry) throw new Error(`${DOMAIN_REGISTRY_REQUIRED_REASON}: review trigger runner requires the domain registry.`);

  let claim = claimedWake;
  if (!claim) {
    const syntheticIssueId = stringOrNull(issueId);
    if (!syntheticIssueId) throw new Error("review_issue_id_required");
    if (typeof store.claimSyntheticIssueWake !== "function") {
      throw new Error(`${REVIEW_RUN_DEPS_REQUIRED_REASON}: store.claimSyntheticIssueWake is required for direct issue review.`);
    }
    claim = await store.claimSyntheticIssueWake({
      domainId: servedDomainContext.domainId,
      workspaceId: servedDomainContext.linear.workspaceId,
      teamId: servedDomainContext.linear.teamId,
      objectId: syntheticIssueId,
      workflowType: REVIEW_WORKFLOW_TYPE,
      triggerType: REVIEW_IN_REVIEW_TRIGGER_TYPE,
      objectType: "issue",
    });
    if (!claim.ok) {
      return {
        status: "failed_closed",
        reason: claim.reason || "synthetic_review_wake_claim_failed",
        claim,
      };
    }
  }

  const { wake, leaseToken } = claim;
  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: wakeDomainSelector({ wake, workspaceId }),
  });
  if (!resolved.ok) {
    const quarantined = await store.markWakeRoutingError?.({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: resolved.reason,
      candidates: resolved.candidates || [],
    });
    if (quarantined && !quarantined.ok) {
      return { status: "failed_closed", reason: quarantined.reason, wake };
    }
    return {
      status: "routing_error",
      reason: resolved.reason,
      candidates: resolved.candidates || [],
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  const resolvedDomainContext = resolved.context;
  if (resolvedDomainContext.domainId !== servedDomainContext.domainId) {
    const released = await store.releaseWake?.({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: "domain_not_served",
    });
    if (released && !released.ok) return { status: "failed_closed", reason: released.reason, wake };
    return {
      status: "released",
      reason: "domain_not_served",
      resolvedDomainId: resolvedDomainContext.domainId,
      servedDomainId: servedDomainContext.domainId,
      release: released,
      wake: (await store.getWake?.(wake.id)) || wake,
    };
  }

  const sourceEvent =
    claim.event ||
    store.triggerEvents?.find((event) => event.id === wake.source_event_id) ||
    null;
  const runId = idGenerator({ wake, sourceEvent });
  const effectiveIssueId = stringOrNull(issueId) || stringOrNull(wake.object_id);
  if (!effectiveIssueId) throw new Error("review_issue_id_required");
  const running = await store.markWakeRunning({
    wakeId: wake.id,
    runnerId,
    leaseToken,
    runId,
    domainId: resolvedDomainContext.domainId,
  });
  if (!running.ok) return { status: "failed_closed", reason: running.reason, wake };

  const renewal = startLeaseRenewal({
    store,
    wakeId: wake.id,
    runnerId,
    workspaceId,
    runnerVersion,
    capabilities,
    leaseToken,
    leaseDurationMs,
  });
  let traceSession = null;

  try {
    assertRunStoreWritable({ repoRoot, runStoreDir });
    await renewal.renewNow();
    traceSession = traceSink
      ? await traceSink.startRun?.({
          wake,
          sourceEvent,
          runId,
          workspaceId,
          runnerId,
          runnerVersion,
          domainContext: resolvedDomainContext,
        }).catch((error) => ({
          ok: false,
          traceId: null,
          status: "trace_unavailable",
          reason: error.message,
        }))
      : null;
    const runLinearClient = linearClient || await linearClientFactory?.();
    if (!runLinearClient) throw new Error("linear_client_required_after_domain_resolution");

    const definition = getReviewDefinition();
    const issue = await loadExecutionIssueContext({ client: runLinearClient, issueId: effectiveIssueId });
    const reviewResourceTarget = resourceTargetForIssue(issue);
    const repoIdentity = reviewDecision?.repoIdentity || resourcesToRepoIdentity(resolvedDomainContext, {
      resourceId: stringOrNull(
        reviewDecision?.resource_id ||
        reviewDecision?.producedIdentity?.resource_id ||
        reviewDecision?.identity?.resource_id ||
        reviewResourceTarget?.id,
      ),
    });
    const prAdapter = await resolveReviewPrAdapter({ repoIdentity, runDeps });
    const plan = await resolveReviewPlan({
      reviewDecision,
      issue,
      repoIdentity,
      prAdapter,
      locatePr: runDeps.locatePullRequestForIssue || locatePullRequestForIssue,
    });

    let runResult;
    let environment = { agent_write_credentials_present: false };
    let runtimeEvidence = {};
    let acceptedRefs = null;
    let driverSessionHandle = null;
    let reviewInput = null;
    const ownTurnSpanSink = spanSink ? null : createOrchestratorTurnTraceSink();

    if (plan.mode === "review") {
      reviewInput = await assembleReviewRuntimeInput({
        issue,
        pr: plan.pr,
        repoIdentity,
        prAdapter,
      });
      if (reviewInput.diff_incomplete) {
        runResult = synthesizeReviewEscalationRunResult({
          runId,
          headSha: plan.pr.head_sha,
          reason: "diff_incomplete",
          body: reviewEscalationBody({
            reason: "diff_incomplete",
            detail: reviewInput.diff_incomplete_reason,
          }),
        });
      } else {
        try {
          const loopResult = await runOrchestratorLoop({
            runId,
            wake,
            event: sourceEvent,
            project: reviewInput.project,
            config,
            runtimeExecutor,
            orchestratorTurnExecutor,
            roster: roster || createOrchestratorRoster({ workflowType: REVIEW_WORKFLOW_TYPE, repoRoot }),
            definition,
            commitPayload: reviewCommitPayload,
            renew: () => renewal.renewNow(),
            repoRoot,
            firstTurnWarmStart,
            spanSink: spanSink || ownTurnSpanSink,
          });
          runResult = loopResult.output;
          environment = loopResult.environment;
          runtimeEvidence = loopResult.runtimeEvidence;
          acceptedRefs = loopResult.acceptedRefs;
          driverSessionHandle = loopResult.orchestratorSessionHandle;
        } catch (error) {
          if (!isOrchestratorOutputValidationError(error)) throw error;
          runResult = synthesizeReviewEscalationRunResult({
            runId,
            headSha: plan.pr.head_sha,
            reason: "review_payload_invalid",
            body: reviewEscalationBody({
              reason: "review_payload_invalid",
              detail: reviewValidationDetailFromError(error),
            }),
          });
        }
      }
    } else {
      runResult = synthesizeReviewEscalationRunResult({
        runId,
        headSha: plan.headSha || NO_REVIEW_HEAD_SHA,
        reason: plan.reason,
        body: reviewEscalationBody({
          reason: plan.reason,
          detail: plan.location?.reason,
          noPr: plan.hasPr !== true,
        }),
      });
    }

    await renewal.renewNow();
    const result = await runReviewTerminalCommit({
      client: runLinearClient,
      config,
      cache,
      issue,
      issueId: effectiveIssueId,
      runResult,
      environment,
      runId,
      repoRoot,
      runStoreDir,
      runtimeEvidence,
      acceptedRefs,
      driverSessionHandle,
      traceContext: {
        event_id: sourceEvent?.event_id || sourceEvent?.id || null,
        wake_id: wake.id,
        run_id: runId,
        trace_id: traceSession?.traceId || null,
        attempt: wake.attempt_count || null,
        workspace_id: resolvedDomainContext.trace.workspace_id,
        domain_id: resolvedDomainContext.trace.domain_id,
        team_id: resolvedDomainContext.trace.team_id,
        behavior_repo_id: resolvedDomainContext.trace.behavior_repo_id,
        source_provider: sourceEvent?.provider || "linear",
        source_object_id: effectiveIssueId,
        trigger_type: wake.trigger_type || null,
        runner_id: runnerId,
        runner_version: runnerVersion,
      },
      domainContext: resolvedDomainContext,
      runtimeAssignments: resolveRoleRuntimeAssignments(config, REVIEW_WORKFLOW_TYPE),
      definition,
      runDeps,
      store,
      wake,
      leaseToken,
      runnerId,
      prAdapter,
      repoIdentity,
      pr: plan.pr || null,
      hasPr: plan.hasPr === true,
      reviewInput,
      plan,
    });
    ownTurnSpanSink?.drainInto(result?.trace);
    const traceDelivery = await traceSink?.finishRun?.({ session: traceSession, result, wake })
      .catch((error) => ({ status: "trace_delivery_failed", reason: error.message }));
    return await finishWakeFromRunnerResult({ store, wake, runnerId, leaseToken, result, traceDelivery });
  } catch (error) {
    const current = await store.getWake?.(wake.id);
    const reason = current?.mutation_started_at
      ? `runner_failed_after_review_mutation_started:${error.message}`
      : `runner_failed_closed:${error.message}`;
    if (current?.mutation_started_at) {
      const dead = await store.deadLetterWake({ wakeId: wake.id, runnerId, leaseToken, reason });
      const traceDelivery = await traceSink?.finishRun?.({
        session: traceSession,
        result: { status: "dead_letter", reason, trace: null },
        wake: dead.wake,
      }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
      return { status: "dead_letter", reason, wake: dead.wake, error, traceDelivery };
    }
    const rejected = await store.completeWake({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      status: "rejected",
      reason,
    });
    const traceDelivery = await traceSink?.finishRun?.({
      session: traceSession,
      result: { status: "failed_closed", reason, trace: null },
      wake: rejected.wake,
    }).catch((traceError) => ({ status: "trace_delivery_failed", reason: traceError.message }));
    return { status: "rejected", reason, wake: rejected.wake, error, traceDelivery };
  } finally {
    renewal.stop();
  }
}

async function resolveClaimedWorkflowDefinition({ store, runnerId, claim }) {
  const { wake, leaseToken } = claim;
  try {
    await importWorkflowDefinitionForType(wake.workflow_type);
    const definition = getWorkflowDefinition(wake.workflow_type);
    if (typeof definition.run !== "function") {
      throw new Error(`workflow_definition_run_missing:${wake.workflow_type}`);
    }
    return { ok: true, definition };
  } catch (error) {
    if (!String(error?.message || "").startsWith("unknown_workflow_type:")) throw error;
    const quarantined = await store.markWakeRoutingError({
      wakeId: wake.id,
      runnerId,
      leaseToken,
      reason: "unknown_workflow_type",
      candidates: [],
    });
    if (!quarantined.ok) return { ok: false, result: { status: "failed_closed", reason: quarantined.reason, wake } };
    return {
      ok: false,
      result: {
        status: "routing_error",
        reason: "unknown_workflow_type",
        candidates: [],
        wake: (await store.getWake?.(wake.id)) || wake,
      },
    };
  }
}

async function importWorkflowDefinitionForType(workflowType) {
  if (workflowType === "execution") {
    await import("./workflows/execution/definition.mjs");
    return;
  }
  if (workflowType === "review") {
    await import("./workflows/review/definition.mjs");
    return;
  }
  await import("./workflows/decomposition/definition.mjs");
}

async function runExecutionTerminalCommit({
  client,
  config,
  cache,
  issue,
  issueId,
  runResult = null,
  environment = null,
  runId = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  runtimeEvidence = {},
  acceptedRefs = null,
  driverSessionHandle = null,
  traceContext = {},
  domainContext = null,
  runContext = null,
  runtimeAssignments = null,
  definition = getExecutionDefinition(),
  runDeps = {},
  store,
  wake,
  leaseToken,
  runnerId,
  retry = false,
  killPoint = null,
  resumeRecord = null,
} = {}) {
  const domainTrace = domainContext?.trace || {};
  const resource = primaryResource(runContext);
  const selectedResourceId = stringOrNull(runContext?.selectedResourceId) || resource?.id || null;
  const trace = createTrace(definition.trace_descriptor.trace_name, knownTraceAttributes({
    "workflow.name": "issue_execution",
    "workflow.version": EXECUTION_FUNCTION_VERSION,
    "teami.domain_id": domainTrace.domain_id,
    "teami.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.issue_id": issueId,
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
    source_object_id: traceContext.source_object_id || issueId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    work_type: executionWorkTypeForTrace({ issue, resource }),
    selected_resource_id: selectedResourceId,
    resource_id: selectedResourceId,
    "resource.kind": resource?.kind || null,
    "resource.id": resource?.id || null,
    "resource.label": resource?.label || null,
  }));

  const profilePreflight = runContext?.executionProfilePreflight;
  if (profilePreflight) {
    recordSpan(trace, "execution_profile_preflight", executionProfilePreflightSpanAttributes(profilePreflight));
  }
  if (runContext?.executionPreflightRemediationRetryOutcome) {
    recordExecutionPreflightRemediationLifecycleSpan(
      trace,
      runContext.executionPreflightRemediationRetryOutcome,
    );
  }

  recordSpan(trace, "load_issue_context", {
    linear_issue_id: issue?.id || issueId,
    issue_identifier: issue?.identifier || null,
    issue_state: issue?.state?.name || null,
  });

  const validation = validateOrchestratorOutput(runResult, executionCommitPayload);
  if (!validation.ok) return executionFailClosed(trace, validation.failureReasons);

  const terminalOutput = runResult.terminal_output;
  const artifact = executionTerminalArtifact({
    runId: runId || terminalOutput.run_id,
    domainTrace,
    issueId,
    issue,
    runResult,
    runtimeAssignments,
    runtimeEvidence,
    driverSessionHandle,
    environment,
    acceptedRefs,
    runContext,
    executionMode: "live",
    resumeRecord,
  });
  const durability = writeRunArtifact(
    {
      runId: artifact.run_id,
      repoRoot,
      runStoreDir,
      returnDurabilityResult: true,
      payloadValidator: executionCommitPayload,
      functionVersion: EXECUTION_FUNCTION_VERSION,
      payloadSchemaId: EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
      requireTerminalAudit: true,
    },
    artifact,
  );
  recordSpan(trace, "persist_run_artifact", {
    run_id: artifact.run_id,
    artifact_kind: artifact.kind,
    artifact_path: durability.artifact_path,
  });
  const persistedArtifact = readRunArtifact({
    runId: artifact.run_id,
    repoRoot,
    runStoreDir,
    payloadValidator: executionCommitPayload,
    functionVersion: EXECUTION_FUNCTION_VERSION,
    payloadSchemaId: EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
    requireTerminalAudit: true,
  });
  const durableRecord = {
    written: durability.written === true,
    terminal_artifact_schema_valid: durability.terminal_artifact_schema_valid === true,
    artifact_path: durability.artifact_path,
  };
  const gate = canApplyTerminal({
    terminal_output: terminalOutput,
    bounds: runResult.bounds,
    environment,
    durable_record: durableRecord,
    commitPayload: executionCommitPayload,
  });
  recordSpan(trace, "terminal_apply_gate", {
    ok: gate.ok,
    outcome: terminalOutput.outcome,
    reason: terminalOutput.reason,
    blocked_reason: gate.blocked_reason || null,
    artifact_path: durableRecord.artifact_path,
  });
  if (!gate.ok) {
    return {
      status: "failed_closed",
      failureReasons: [gate.blocked_reason],
      trace,
      durableRecord,
      artifact: persistedArtifact,
    };
  }
  if (terminalOutput.outcome !== "commit") {
    return {
      status: terminalOutput.outcome === "pause" ? "paused" : "failed_closed",
      reason: terminalOutput.reason,
      failureReasons: terminalOutput.outcome === "failed_closed" ? [terminalOutput.reason] : undefined,
      trace,
      durableRecord,
      artifact: persistedArtifact,
    };
  }

  const commitEffects = executionCommitEffects({ definition, runDeps });
  const ctx = {
    client,
    config,
    cache,
    issue,
    issueId,
    domainContext,
    runContext,
    pendingGitIntent: runContext?.pendingGitIntent || null,
    resources: runContext?.resources || {},
    resourceManifest: runContext?.resourceManifest || [],
    artifact: persistedArtifact,
    payload: persistedArtifact.payload,
    trace,
    runId: persistedArtifact.run_id,
    repoRoot,
    runStoreDir,
    environment,
    durable_record: durableRecord,
    retry: retry === true,
    killPoint,
    runDeps,
    runGit: runContext?.runGit || runDeps.runGit || defaultRunGit,
    store,
    wake,
    leaseToken,
    runnerId,
    prAdapter: runDeps.prAdapter || null,
    artifactSetLineage: persistedArtifact.artifact_set_lineage,
  };
  await maybeRunKillPoint(runDeps, "before_commit_effects", ctx);
  const applyResult = await applyCommitEffects({ effects: commitEffects, ctx, trace });
  if (applyResult.outcome !== "ok") {
    recordSpan(trace, "commit_effect_pending", {
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      run_id: persistedArtifact.run_id,
      atomicity: "durable_commit_intent_not_provider_transaction",
    });
    if (applyResult.outcome === "failed_closed") {
      return {
        status: "failed_closed",
        failureReasons: [applyResult.reason || "commit_effect_failed_closed"],
        pending_effect_id: applyResult.pending_effect_id,
        reason: applyResult.reason,
        trace,
        durableRecord,
        artifact: persistedArtifact,
      };
    }
    return {
      status: "pending",
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      trace,
      durableRecord,
      artifact: persistedArtifact,
    };
  }

  const artifactWithProducedIdentities = {
    ...persistedArtifact,
    produced_identities: applyResult.produced_identities,
  };
  writeRunArtifact(
    {
      runId: artifactWithProducedIdentities.run_id,
      repoRoot,
      runStoreDir,
      payloadValidator: executionCommitPayload,
      functionVersion: EXECUTION_FUNCTION_VERSION,
      payloadSchemaId: EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
      requireTerminalAudit: true,
    },
    artifactWithProducedIdentities,
  );
  return {
    status: "completed",
    applied: applyResult.applied,
    produced_identities: applyResult.produced_identities,
    trace,
    durableRecord,
    artifact: artifactWithProducedIdentities,
  };
}

function executionFailClosed(trace, failureReasons) {
  recordSpan(trace, "execution_run_failed_closed", {
    failure_reasons: [...new Set(failureReasons || ["failed_closed"])],
  });
  return { status: "failed_closed", failureReasons: [...new Set(failureReasons || ["failed_closed"])], trace };
}

async function runExecutionPreflightForRun({
  runDeps = {},
  issue = null,
  runContext = {},
  runtimeOptions = {},
  config = {},
} = {}) {
  const selectedResource = isRecord(runContext.selectedResource) ? runContext.selectedResource : null;
  const handle = isRecord(selectedResource?.handle) ? selectedResource.handle : {};
  const resourceId = stringOrNull(runContext.selectedResourceId) || stringOrNull(selectedResource?.id);
  const preflight = typeof runDeps.executionProfilePreflight === "function"
    ? runDeps.executionProfilePreflight
    : runExecutionProfilePreflight;
  const remediationMarker = parseRemediationMarker(issue?.description);
  const preflightProfile = remediationMarker?.kind === READINESS_REPAIR_REMEDIATION_KIND
    ? "readiness_repair"
    : "default";
  const verdict = await preflight({
    repoDir: runtimeOptions.cwd,
    resourceId,
    preflightProfile,
    skipReadiness: preflightProfile === "readiness_repair",
    runCommand: runDeps.runCommand || runRuntimeCommand,
    runGit: runContext.runGit || runDeps.runGit || defaultRunGit,
    strictBaselineGreen: strictBaselineGreenForExecutionPreflight({ config, runDeps }),
    remoteUrl: stringOrNull(handle.remoteUrl),
    owner: stringOrNull(handle.owner),
    repo: stringOrNull(handle.repo),
  });
  return normalizeExecutionProfilePreflightVerdict({ ...verdict, preflight_profile: preflightProfile }, resourceId);
}

function strictBaselineGreenForExecutionPreflight({ config = {}, runDeps = {} } = {}) {
  if (Object.hasOwn(runDeps, "strictBaselineGreen")) return runDeps.strictBaselineGreen;
  const profileConfig =
    config?.workflows?.execution?.profile_preflight ||
    config?.workflows?.execution?.execution_profile_preflight ||
    null;
  if (!isRecord(profileConfig)) return undefined;
  if (Object.hasOwn(profileConfig, "strict_baseline_green")) {
    return profileConfig.strict_baseline_green === true;
  }
  if (Object.hasOwn(profileConfig, "strictBaselineGreen")) {
    return profileConfig.strictBaselineGreen === true;
  }
  return undefined;
}

function normalizeExecutionProfilePreflightVerdict(verdict, resourceId) {
  if (!isRecord(verdict) || typeof verdict.ok !== "boolean") {
    throw new Error("execution_profile_preflight_invalid_verdict");
  }
  if (stringOrNull(verdict.resource_id)) return verdict;
  return { ...verdict, resource_id: stringOrNull(resourceId) };
}

function executionPreflightFailClosed({
  definition,
  domainContext = null,
  issue = null,
  issueId = null,
  runId = null,
  traceContext = {},
  runContext = null,
  preflight,
} = {}) {
  const domainTrace = domainContext?.trace || {};
  const resource = primaryResource(runContext);
  const selectedResourceId = stringOrNull(runContext?.selectedResourceId) || resource?.id || null;
  const failureReasons = [...new Set(preflight?.failure_reasons || ["execution_profile_preflight_failed"])];
  const trace = createTrace(definition.trace_descriptor.trace_name, knownTraceAttributes({
    "workflow.name": "issue_execution",
    "workflow.version": EXECUTION_FUNCTION_VERSION,
    "teami.domain_id": domainTrace.domain_id,
    "teami.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.issue_id": issueId,
    run_id: runId,
    event_id: traceContext.event_id || null,
    wake_id: traceContext.wake_id || null,
    trace_id: traceContext.trace_id || null,
    attempt: traceContext.attempt || null,
    workspace_id: domainTrace.workspace_id,
    domain_id: domainTrace.domain_id,
    team_id: domainTrace.team_id,
    behavior_repo_id: domainTrace.behavior_repo_id,
    source_provider: traceContext.source_provider || "linear",
    source_object_id: traceContext.source_object_id || issueId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    work_type: executionWorkTypeForTrace({ issue, resource }),
    selected_resource_id: selectedResourceId,
    resource_id: selectedResourceId,
    "resource.kind": resource?.kind || null,
    "resource.id": resource?.id || null,
    "resource.label": resource?.label || null,
  }));
  recordSpan(trace, "execution_profile_preflight", executionProfilePreflightSpanAttributes(preflight));
  recordSpan(trace, "execution_run_failed_closed", {
    failure_reasons: failureReasons,
  });
  return {
    status: "failed_closed",
    reason: "execution_profile_preflight_failed",
    failureReasons,
    execution_profile_preflight: preflight,
    readinessVerdict: preflight,
    trace,
  };
}

async function executionPreflightRemediationBlocked({
  client,
  config = {},
  cache = null,
  definition,
  domainContext = null,
  issue = null,
  issueId = null,
  runId = null,
  traceContext = {},
  runContext = null,
  preflight,
} = {}) {
  const domainTrace = domainContext?.trace || {};
  const resource = primaryResource(runContext);
  const selectedResourceId = stringOrNull(runContext?.selectedResourceId) || resource?.id || null;
  const failureReasons = [...new Set(preflight?.failure_reasons || ["execution_profile_preflight_failed"])];
  const trace = createTrace(definition.trace_descriptor.trace_name, knownTraceAttributes({
    "workflow.name": "issue_execution",
    "workflow.version": EXECUTION_FUNCTION_VERSION,
    "teami.domain_id": domainTrace.domain_id,
    "teami.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.issue_id": issueId,
    run_id: runId,
    event_id: traceContext.event_id || null,
    wake_id: traceContext.wake_id || null,
    trace_id: traceContext.trace_id || null,
    attempt: traceContext.attempt || null,
    workspace_id: domainTrace.workspace_id,
    domain_id: domainTrace.domain_id,
    team_id: domainTrace.team_id,
    behavior_repo_id: domainTrace.behavior_repo_id,
    source_provider: traceContext.source_provider || "linear",
    source_object_id: traceContext.source_object_id || issueId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    work_type: executionWorkTypeForTrace({ issue, resource }),
    selected_resource_id: selectedResourceId,
    resource_id: selectedResourceId,
    "resource.kind": resource?.kind || null,
    "resource.id": resource?.id || null,
    "resource.label": resource?.label || null,
  }));
  recordSpan(trace, "execution_profile_preflight", executionProfilePreflightSpanAttributes(preflight));

  const plan = await planExecutionPreflightRemediation({
    client,
    config,
    cache,
    issue,
    issueId,
    runContext,
    preflight,
    domainContext,
  });
  if (plan.action === "escalate") {
    return executionPreflightNeedsPrincipalEscalated({
      client,
      config,
      cache,
      domainContext,
      issue,
      issueId,
      runId,
      trace,
      failureReasons,
      preflight,
      plan,
    });
  }

  const effect = executionPreflightRemediationEffectDescriptor(plan);
  const ctx = {
    client,
    config,
    cache,
    issue,
    issueId,
    domainContext,
    runContext,
    trace,
    runId,
  };
  const applyResult = await applyCommitEffects({ effects: [effect], ctx, trace });
  if (applyResult.outcome !== "ok") {
    recordSpan(trace, "commit_effect_pending", {
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      run_id: runId,
      atomicity: "durable_commit_intent_not_provider_transaction",
    });
    return {
      status: applyResult.outcome === "failed_closed" ? "failed_closed" : "pending",
      reason: applyResult.reason,
      failureReasons: [applyResult.reason || "remediation_commit_effect_failed"],
      pending_effect_id: applyResult.pending_effect_id,
      trace,
    };
  }

  const remediation = ctx.executionPreflightRemediation;
  const lifecycle = remediationLifecycleTraceAttributes({
    originalIssueId: issueId,
    remediationIssueId: remediation?.issue?.id,
    marker: remediation?.marker || plan.marker,
    retryCycle: plan.retry_cycle,
    outcome: plan.existingIssue ? "reused_open_remediation" : "filed",
  });
  recordExecutionPreflightRemediationLifecycleSpan(trace, lifecycle);
  recordSpan(trace, "execution_profile_remediation_blocker_filed", knownTraceAttributes({
    original_issue_id: issueId,
    remediation_issue_id: remediation?.issue?.id,
    remediation_issue_identifier: remediation?.issue?.identifier,
    relation_id: remediation?.relation?.id,
    relation_created: remediation?.relation_created === true,
    relation_type: "blocks",
    resource_id: remediation?.marker?.resource_id,
    failure_signature: remediation?.marker?.failure_signature,
    retry_cycle: plan.retry_cycle,
    outcome: lifecycle.outcome,
  }));
  return {
    status: "waiting",
    reason: "dependency_blocked",
    failureReasons,
    execution_profile_preflight: preflight,
    readinessVerdict: preflight,
    remediation,
    applied: applyResult.applied,
    produced_identities: applyResult.produced_identities,
    created: remediation?.created === true && remediation.issue ? [remediation.issue] : [],
    trace,
  };
}

async function planExecutionPreflightRemediation({
  client,
  config = {},
  cache = null,
  issue = null,
  issueId = null,
  runContext = null,
  domainContext = null,
  preflight = {},
} = {}) {
  if (typeof client?.findOrCreateIssueRelation !== "function") {
    throw new Error("linear_remediation_issue_relation_unavailable");
  }

  const resourceId = stringOrNull(preflight.resource_id) ||
    stringOrNull(runContext?.selectedResourceId) ||
    stringOrNull(primaryResource(runContext)?.id);
  if (!resourceId) throw new Error("linear_remediation_resource_id_missing");

  const marker = {
    v: 1,
    kind: READINESS_REPAIR_REMEDIATION_KIND,
    resource_id: resourceId,
    failure_signature: remediationFailureSignature(preflight.failure_signature_seed || {
      reason_codes: preflight.failure_reasons,
      missing: [],
    }),
  };
  const cycles = await executionPreflightRemediationCycles({
    client,
    issue,
    issueId,
    resourceId,
  });
  const retryCycle = cycles.closed.length + 1;
  if (retryCycle >= REMEDIATION_RETRY_CAP + 1) {
    const remediationIssue = cycles.closed.at(-1)?.issue || null;
    return {
      action: "escalate",
      reason: "remediation_retry_cap_exceeded",
      marker,
      retry_cycle: retryCycle,
      remediation_issue_id: remediationIssue?.id || null,
      remediation_issue: remediationIssue,
    };
  }

  const teamId = stringOrNull(issue?.teamId) ||
    stringOrNull(issue?.team?.id) ||
    stringOrNull(domainContext?.linear?.teamId) ||
    stringOrNull(cache?.teamId);
  if (!teamId) throw new Error("linear_remediation_team_id_missing");
  const projectId = stringOrNull(issue?.projectId) || stringOrNull(issue?.project?.id);
  const existingIssue = await findOpenExecutionPreflightRemediation({
    client,
    marker,
    teamId,
  });
  if (existingIssue) {
    return {
      action: "block",
      existingIssue,
      marker,
      retry_cycle: retryCycle,
    };
  }

  const mergeDoneCheck = await doctorMergeDoneAutomationCheck({
    client,
    team: issue?.team || {
      id: teamId,
      key: config?.linear?.team?.key || domainContext?.linear?.teamKey || null,
      name: config?.linear?.team?.name || domainContext?.linear?.teamName || null,
    },
  });
  if (mergeDoneCheck?.ok !== true) {
    return {
      action: "escalate",
      reason: "merge_done_automation_missing",
      marker,
      retry_cycle: retryCycle,
      remediation_issue_id: null,
      remediation_issue: null,
      doctor_check: mergeDoneCheck,
    };
  }

  if (typeof client?.createIssue !== "function") {
    throw new Error("linear_remediation_issue_create_unavailable");
  }
  const labelIds = await remediationIssueLabelIds({ client, config, cache, teamId, issue });
  const stateId = remediationIssueStateId({ cache, issue });
  const description = renderExecutionPreflightRemediationBody({
    issue,
    issueId,
    preflight,
    marker,
    resourceTarget: remediationResourceTarget({ issue, resourceId }),
  });
  return {
    action: "block",
    existingIssue: null,
    marker,
    retry_cycle: retryCycle,
    issue_input: compactRecord({
      title: remediationIssueTitle(issue),
      description,
      teamId,
      projectId,
      stateId,
      labelIds,
    }),
  };
}

function executionPreflightRemediationEffectDescriptor(plan = {}) {
  return Object.freeze({
    id: EXECUTION_PREFLIGHT_REMEDIATION_EFFECT_ID,
    provider: "linear",
    op: plan.existingIssue ? "link_remediation_issue" : "create_remediation_issue",
    terminal: true,
    producedIdentity: Object.freeze({
      resource_kind: "linear_remediation",
      target_ids: remediationProducedIdentityTargetIds,
      identity: remediationProducedIdentity,
    }),
    async apply(ctx = {}) {
      const remediationIssue = plan.existingIssue || await ctx.client.createIssue(plan.issue_input);
      const relationResult = await ctx.client.findOrCreateIssueRelation({
        issueId: remediationIssue.id,
        relatedIssueId: ctx.issueId,
        type: "blocks",
      });
      const remediation = {
        issue: remediationIssue,
        relation: relationResult?.relation || relationResult || null,
        relation_created: relationResult?.created === true,
        marker: plan.marker,
        retry_cycle: plan.retry_cycle,
        created: !plan.existingIssue,
        dedup_reused: Boolean(plan.existingIssue),
      };
      const identity = {
        original_issue_id: ctx.issueId,
        remediation_issue_id: remediationIssue.id,
        remediation_issue_identifier: remediationIssue.identifier || null,
        relation_id: remediation.relation?.id || null,
        relation_type: "blocks",
        resource_id: plan.marker?.resource_id || null,
        failure_signature: plan.marker?.failure_signature || null,
        retry_cycle: plan.retry_cycle,
        outcome: plan.existingIssue ? "reused_open_remediation" : "filed",
      };
      ctx.executionPreflightRemediation = remediation;
      ctx.executionPreflightRemediationIdentity = identity;
      return { ok: true, identity };
    },
    async verify(ctx = {}) {
      if (!ctx.executionPreflightRemediationIdentity) {
        return { ok: false, reason: "linear_remediation_issue_identity_missing" };
      }
      return { ok: true, identity: ctx.executionPreflightRemediationIdentity };
    },
  });
}

async function executionPreflightNeedsPrincipalEscalated({
  client,
  config = {},
  cache = null,
  domainContext = null,
  issue = null,
  issueId = null,
  runId = null,
  trace,
  failureReasons = [],
  preflight = {},
  plan = {},
} = {}) {
  const reason = plan.reason || "remediation_escalated";
  const effects = [issueNeedsPrincipalEscalationEffectDescriptor()];
  const ctx = {
    client,
    config,
    cache,
    issue,
    issueId,
    domainContext,
    trace,
    runId,
    teamId: issue?.teamId || issue?.team?.id || domainContext?.linear?.teamId || cache?.teamId || null,
    shape: needsPrincipalShapeFromCache({ cache, config }),
  };
  const applyResult = await applyCommitEffects({ effects, ctx, trace });
  if (applyResult.outcome !== "ok") {
    recordSpan(trace, "commit_effect_pending", {
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      run_id: runId,
      atomicity: "durable_commit_intent_not_provider_transaction",
    });
    return {
      status: applyResult.outcome === "failed_closed" ? "failed_closed" : "pending",
      reason: applyResult.reason,
      failureReasons: [applyResult.reason || reason],
      execution_profile_preflight: preflight,
      readinessVerdict: preflight,
      pending_effect_id: applyResult.pending_effect_id,
      trace,
    };
  }

  recordExecutionPreflightRemediationLifecycleSpan(trace, remediationLifecycleTraceAttributes({
    originalIssueId: issueId,
    remediationIssueId: plan.remediation_issue_id,
    marker: plan.marker,
    retryCycle: plan.retry_cycle,
    outcome: reason,
  }));
  recordSpan(trace, "execution_profile_remediation_escalated", knownTraceAttributes({
    reason,
    original_issue_id: issueId,
    remediation_issue_id: plan.remediation_issue_id,
    resource_id: plan.marker?.resource_id,
    failure_signature: plan.marker?.failure_signature,
    retry_cycle: plan.retry_cycle,
    doctor_check_ok: plan.doctor_check?.ok,
    doctor_check_message: plan.doctor_check?.message,
  }));
  return {
    status: "completed",
    reason,
    failureReasons: uniqueStrings([...failureReasons, reason]),
    execution_profile_preflight: preflight,
    readinessVerdict: preflight,
    remediation: {
      marker: plan.marker,
      retry_cycle: plan.retry_cycle,
      escalation_reason: reason,
      issue: plan.remediation_issue || null,
    },
    applied: applyResult.applied,
    produced_identities: applyResult.produced_identities,
    trace,
  };
}

async function executionPreflightRemediationRetryOutcome({
  client,
  issue = null,
  issueId = null,
  runContext = null,
  preflight = {},
} = {}) {
  const resourceId = stringOrNull(preflight.resource_id) ||
    stringOrNull(runContext?.selectedResourceId) ||
    stringOrNull(primaryResource(runContext)?.id);
  if (!resourceId) return null;
  const cycles = await executionPreflightRemediationCycles({
    client,
    issue,
    issueId,
    resourceId,
  });
  if (cycles.closed.length === 0) return null;
  const cycle = cycles.closed.at(-1);
  return remediationLifecycleTraceAttributes({
    originalIssueId: issueId,
    remediationIssueId: cycle.issue?.id,
    marker: cycle.marker,
    retryCycle: cycles.closed.length + 1,
    outcome: "passed",
  });
}

async function executionPreflightRemediationCycles({
  client,
  issue = null,
  issueId = null,
  resourceId = null,
} = {}) {
  const selfId = stringOrNull(issueId) || stringOrNull(issue?.id);
  const closed = [];
  for (const relation of issue?.relations || []) {
    if (relation?.type !== "blocks") continue;
    if (stringOrNull(relation.relatedIssue?.id) !== selfId) continue;
    const remediationIssue = await hydrateRelationIssue({ client, issue: relation.issue });
    const marker = parseRemediationMarker(remediationIssue?.description || relation.issue?.description);
    if (!remediationMarkerMatchesResource(marker, resourceId)) continue;
    if (isClosedRemediationIssue(remediationIssue || relation.issue)) {
      closed.push({ relation, issue: remediationIssue || relation.issue, marker });
    }
  }
  return { closed };
}

async function hydrateRelationIssue({ client, issue = null } = {}) {
  const issueId = stringOrNull(issue?.id);
  if (!issueId) return issue || null;
  if (typeof issue?.description === "string" && issue.state?.type) return issue;
  if (typeof client?.getIssueContext === "function") {
    try {
      return await client.getIssueContext(issueId);
    } catch {
      // Fall through to getIssue; relation hydration is best-effort.
    }
  }
  if (typeof client?.getIssue === "function") {
    try {
      return await client.getIssue(issueId);
    } catch {
      // Best-effort; the relation reference may still carry enough fields.
    }
  }
  return issue || null;
}

async function findOpenExecutionPreflightRemediation({
  client,
  marker,
  teamId = null,
} = {}) {
  const listIssues = typeof client?.listIssues === "function"
    ? client.listIssues
    : typeof client?.searchIssues === "function"
      ? client.searchIssues
      : null;
  if (!listIssues) throw new Error("linear_remediation_issue_query_unavailable");
  const issues = await listIssues.call(client, {
    teamId,
    includeArchived: false,
    query: "af-remediation",
  });
  return (issues || []).find((candidate) =>
    remediationMarkerMatches(parseRemediationMarker(candidate?.description), marker) &&
    !isClosedRemediationIssue(candidate)
  ) || null;
}

function remediationProducedIdentityTargetIds(identity = {}) {
  return uniqueStrings([
    identity.original_issue_id,
    identity.remediation_issue_id,
    identity.relation_id,
  ]);
}

function remediationProducedIdentity(identity = {}) {
  return {
    original_issue_id: stringOrNull(identity.original_issue_id),
    remediation_issue_id: stringOrNull(identity.remediation_issue_id),
    remediation_issue_identifier: stringOrNull(identity.remediation_issue_identifier),
    relation_id: stringOrNull(identity.relation_id),
    relation_type: stringOrNull(identity.relation_type),
    resource_id: stringOrNull(identity.resource_id),
    failure_signature: stringOrNull(identity.failure_signature),
    retry_cycle: Number.isFinite(identity.retry_cycle) ? identity.retry_cycle : null,
    outcome: stringOrNull(identity.outcome),
  };
}

function remediationLifecycleTraceAttributes({
  originalIssueId = null,
  remediationIssueId = null,
  marker = {},
  retryCycle = null,
  outcome = null,
} = {}) {
  return {
    original_issue_id: stringOrNull(originalIssueId),
    remediation_issue_id: stringOrNull(remediationIssueId),
    resource_id: stringOrNull(marker?.resource_id),
    failure_signature: stringOrNull(marker?.failure_signature),
    retry_cycle: retryCycle,
    outcome: stringOrNull(outcome),
  };
}

function recordExecutionPreflightRemediationLifecycleSpan(trace, attributes) {
  recordSpan(trace, "execution_profile_remediation_lifecycle", attributes);
}

function needsPrincipalShapeFromCache({ cache = null, config = {} } = {}) {
  const blocked = issueStatusShapeFromCache(cache?.issueStatuses?.blocked, {
    name: config?.linear?.issue?.statuses?.blocked?.name || "Blocked",
    type: config?.linear?.issue?.statuses?.blocked?.type || "started",
  });
  const labelName = stringOrNull(config?.linear?.issue?.labels?.needs_principal) || "Needs Principal";
  const label = issueLabelShapeFromCache(
    cache?.issueLabels?.needs_principal ||
    cache?.issueLabels?.[labelName],
    labelName,
  );
  return {
    team: { id: cache?.teamId || null },
    issueStatuses: { ...(blocked ? { blocked } : {}) },
    issueLabels: { ...(label ? { needs_principal: label } : {}) },
  };
}

function issueStatusShapeFromCache(value, fallback = {}) {
  if (!value) return null;
  if (typeof value === "string") return { id: value, name: fallback.name || null, type: fallback.type || null };
  return value?.id ? value : null;
}

function issueLabelShapeFromCache(value, name = null) {
  if (!value) return null;
  if (typeof value === "string") return { id: value, name };
  return value?.id ? value : null;
}

function remediationMarkerMatches(left, right) {
  return Boolean(
    left &&
    right &&
    left.kind === READINESS_REPAIR_REMEDIATION_KIND &&
    right.kind === READINESS_REPAIR_REMEDIATION_KIND &&
    left.resource_id === right.resource_id &&
    left.failure_signature === right.failure_signature,
  );
}

function remediationMarkerMatchesResource(marker, resourceId) {
  return Boolean(
    marker?.kind === READINESS_REPAIR_REMEDIATION_KIND &&
    stringOrNull(marker.resource_id) === stringOrNull(resourceId),
  );
}

function isClosedRemediationIssue(issue = null) {
  return isIssueClosed(issue);
}

function remediationIssueTitle(issue = null) {
  const identifier = stringOrNull(issue?.identifier);
  if (identifier) return `Repair execution readiness for ${identifier}`;
  const title = stringOrNull(issue?.title);
  return title ? `Repair execution readiness: ${title}` : "Repair execution readiness";
}

function renderExecutionPreflightRemediationBody({
  issue = null,
  issueId = null,
  preflight = {},
  marker,
  resourceTarget,
} = {}) {
  const original = stringOrNull(issue?.identifier) || stringOrNull(issueId) || "the original execution issue";
  const failureReasons = uniqueStrings(preflight.failure_reasons || []);
  const missing = uniqueStrings(preflight.failure_signature_seed?.missing || []);
  const lines = [
    `Repair the repository readiness check so ${original} can run.`,
    "",
    "The original issue remains Ready/Todo and is blocked by this issue through a Linear relation.",
  ];
  if (failureReasons.length > 0) {
    lines.push("", "Failure reasons:");
    lines.push(...failureReasons.map((reason) => `- ${reason}`));
  }
  if (missing.length > 0) {
    lines.push("", "Missing or failing command/tool:");
    lines.push(...missing.map((entry) => `- ${entry}`));
  }
  lines.push("", renderRemediationMarker(marker).trimEnd());
  const resourceTargetBlock = renderResourceTargetBlock(resourceTarget).trimEnd();
  if (resourceTargetBlock) lines.push("", resourceTargetBlock);
  return `${lines.join("\n").trimEnd()}\n`;
}

function remediationResourceTarget({ issue = null, resourceId = null } = {}) {
  const direct = isRecord(issue?.resource_target) ? issue.resource_target : parseResourceTargetFromDescription(issue?.description);
  if (
    direct?.kind === "git_repo" &&
    stringOrNull(direct.id) === stringOrNull(resourceId)
  ) {
    return direct;
  }
  return { kind: "git_repo", id: resourceId };
}

async function remediationIssueLabelIds({ client, config = {}, cache = null, teamId = null, issue = null } = {}) {
  const labelId = await resolveConfiguredIssueLabelId({
    client,
    cache,
    teamId,
    issue,
    configuredName: config?.linear?.issue?.labels?.work_type_code,
    cacheKey: "work_type_code",
  });
  return uniqueStrings([labelId]);
}

async function resolveConfiguredIssueLabelId({
  client,
  cache = null,
  teamId = null,
  issue = null,
  configuredName = null,
  cacheKey = null,
} = {}) {
  const labelName = stringOrNull(configuredName);
  if (!labelName) return null;
  const cached = stringOrNull(cache?.issueLabels?.[labelName]) ||
    stringOrNull(cacheKey ? cache?.issueLabels?.[cacheKey] : null);
  if (cached) return cached;
  const issueLabel = (issue?.labels || []).find((label) =>
    stringOrNull(label?.id) === labelName || stringOrNull(label?.name) === labelName
  );
  if (issueLabel?.id) return issueLabel.id;
  if (typeof client?.findIssueLabelsByName !== "function") return null;
  const matches = await client.findIssueLabelsByName(labelName, teamId);
  const exact = (matches || []).find((label) =>
    stringOrNull(label?.name) === labelName &&
    (!teamId || !label?.teamId || label.teamId === teamId)
  );
  return stringOrNull(exact?.id);
}

function remediationIssueStateId({ cache = null, issue = null } = {}) {
  const cachedTodo = stateIdValue(cache?.issueStatuses?.todo);
  if (cachedTodo) return cachedTodo;
  if (issue?.state?.type === "unstarted") return stringOrNull(issue.state.id);
  return null;
}

function stateIdValue(value) {
  if (typeof value === "string") return stringOrNull(value);
  return stringOrNull(value?.id);
}

function executionProfilePreflightSpanAttributes(preflight = {}) {
  return knownTraceAttributes({
    ok: preflight.ok === true,
    resource_id: stringOrNull(preflight.resource_id),
    preflight_profile: stringOrNull(preflight.preflight_profile),
    readiness_skipped: preflight.readiness_skipped === true,
    strict_baseline_green: preflight.strict_baseline_green === true,
    setup_command: stringOrNull(preflight.setup_command),
    test_command: stringOrNull(preflight.test_command),
    failure_reasons: Array.isArray(preflight.failure_reasons) ? preflight.failure_reasons : null,
    failure_signature_seed: preflight.failure_signature_seed
      ? JSON.stringify(preflight.failure_signature_seed)
      : null,
  });
}

async function runReviewTerminalCommit({
  client,
  config,
  cache,
  issue,
  issueId,
  runResult = null,
  environment = null,
  runId = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  runtimeEvidence = {},
  acceptedRefs = null,
  driverSessionHandle = null,
  traceContext = {},
  domainContext = null,
  runtimeAssignments = null,
  definition = getReviewDefinition(),
  runDeps = {},
  store,
  wake,
  leaseToken,
  runnerId,
  prAdapter,
  repoIdentity,
  pr = null,
  hasPr = false,
  reviewInput = null,
  plan = null,
} = {}) {
  void cache;
  void store;
  void wake;
  void leaseToken;
  void runnerId;
  const domainTrace = domainContext?.trace || {};
  const trace = createTrace(definition.trace_descriptor.trace_name, knownTraceAttributes({
    "workflow.name": "review",
    "workflow.version": REVIEW_FUNCTION_VERSION,
    "teami.domain_id": domainTrace.domain_id,
    "teami.behavior_repo_id": domainTrace.behavior_repo_id,
    "linear.workspace_id": domainTrace.workspace_id,
    "linear.team_id": domainTrace.team_id,
    "linear.issue_id": issueId,
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
    source_object_id: traceContext.source_object_id || issueId,
    trigger_type: traceContext.trigger_type || null,
    runner_id: traceContext.runner_id || null,
    runner_version: traceContext.runner_version || null,
    "resource.kind": "git_repo",
    "resource.id": reviewInput?.resource?.id || null,
    "resource.label": repoIdentity?.owner && repoIdentity?.repo ? `${repoIdentity.owner}/${repoIdentity.repo}` : null,
    "github.owner": pr?.owner || repoIdentity?.owner || null,
    "github.repo": pr?.repo || repoIdentity?.repo || null,
    "github.pull_request_number": pr?.number || null,
    "github.head_sha": pr?.head_sha || null,
  }));

  recordSpan(trace, "load_review_issue_context", {
    linear_issue_id: issue?.id || issueId,
    issue_identifier: issue?.identifier || null,
    issue_state: issue?.state?.name || null,
  });

  let effectiveRunResult = runResult;
  let validation = validateOrchestratorOutput(effectiveRunResult, reviewCommitPayload);
  if (
    !validation.ok ||
    effectiveRunResult?.terminal_output?.outcome !== "commit" ||
    (hasPr && pr?.head_sha && effectiveRunResult?.terminal_output?.reviewed_head_sha !== pr.head_sha)
  ) {
    const failureReasons = validation.ok
      ? ["reviewed_head_sha_mismatch"]
      : validation.failureReasons;
    recordSpan(trace, "review_payload_escalated", {
      failure_reasons: [...new Set(failureReasons || ["review_payload_invalid"])],
    });
    effectiveRunResult = synthesizeReviewEscalationRunResult({
      runId,
      headSha: pr?.head_sha || effectiveRunResult?.terminal_output?.reviewed_head_sha || NO_REVIEW_HEAD_SHA,
      reason: "review_payload_invalid",
      body: reviewEscalationBody({
        reason: "review_payload_invalid",
        detail: [...new Set(failureReasons || ["review_payload_invalid"])].join(","),
      }),
      bounds: effectiveRunResult?.bounds,
    });
    validation = validateOrchestratorOutput(effectiveRunResult, reviewCommitPayload);
  }
  if (!validation.ok) return reviewFailClosed(trace, validation.failureReasons);

  const terminalOutput = effectiveRunResult.terminal_output;
  const verdictPayload = reviewVerdictPayloadSpanAttributes({
    terminalOutput,
    pr,
    repoIdentity,
  });
  if (verdictPayload.disposition) {
    trace.attributes["review.disposition"] = verdictPayload.disposition;
  }
  recordSpan(trace, "review_verdict_payload", verdictPayload);
  const artifact = reviewTerminalArtifact({
    runId: runId || terminalOutput.run_id,
    domainTrace,
    issueId,
    issue,
    runResult: effectiveRunResult,
    runtimeAssignments,
    runtimeEvidence,
    driverSessionHandle,
    environment: reviewEnvironment(environment),
    acceptedRefs,
    repoIdentity,
    pr,
    reviewInput,
    completedAt: null,
  });
  const durability = writeRunArtifact(
    {
      runId: artifact.run_id,
      repoRoot,
      runStoreDir,
      returnDurabilityResult: true,
      payloadValidator: reviewCommitPayload,
      functionVersion: REVIEW_FUNCTION_VERSION,
      payloadSchemaId: REVIEW_RUN_PAYLOAD_SCHEMA_ID,
      requireTerminalAudit: true,
    },
    artifact,
  );
  recordSpan(trace, "persist_review_run_artifact", {
    run_id: artifact.run_id,
    artifact_kind: artifact.kind,
    artifact_path: durability.artifact_path,
  });
  const persistedArtifact = readRunArtifact({
    runId: artifact.run_id,
    repoRoot,
    runStoreDir,
    payloadValidator: reviewCommitPayload,
    functionVersion: REVIEW_FUNCTION_VERSION,
    payloadSchemaId: REVIEW_RUN_PAYLOAD_SCHEMA_ID,
    requireTerminalAudit: true,
  });
  const durableRecord = {
    written: durability.written === true,
    terminal_artifact_schema_valid: durability.terminal_artifact_schema_valid === true,
    artifact_path: durability.artifact_path,
  };
  const gate = canApplyTerminal({
    terminal_output: terminalOutput,
    bounds: effectiveRunResult.bounds,
    environment: reviewEnvironment(environment),
    durable_record: durableRecord,
    commitPayload: reviewCommitPayload,
  });
  recordSpan(trace, "review_terminal_apply_gate", {
    ok: gate.ok,
    outcome: terminalOutput.outcome,
    reason: terminalOutput.reason,
    blocked_reason: gate.blocked_reason || null,
    artifact_path: durableRecord.artifact_path,
  });
  if (!gate.ok) {
    return {
      status: "failed_closed",
      failureReasons: [gate.blocked_reason],
      trace,
      durableRecord,
      artifact: persistedArtifact,
    };
  }

  const disposition = terminalOutput.disposition;
  const review = {
    owner: pr?.owner || repoIdentity?.owner || "unknown",
    repo: pr?.repo || repoIdentity?.repo || "unknown",
    number: pr?.number || 1,
    head_sha: terminalOutput.reviewed_head_sha,
    disposition,
    body: terminalOutput.body,
    comments: Array.isArray(terminalOutput.comments) ? terminalOutput.comments : [],
    run_id: persistedArtifact.run_id,
  };
  const commitEffects = reviewCommitEffects({ disposition, hasPr, runDeps });
  const ctx = {
    client,
    config,
    cache,
    issue,
    issueId,
    domainContext,
    artifact: persistedArtifact,
    payload: persistedArtifact.payload,
    trace,
    runId: persistedArtifact.run_id,
    repoRoot,
    runStoreDir,
    environment: reviewEnvironment(environment),
    durable_record: durableRecord,
    runDeps,
    store,
    wake,
    leaseToken,
    runnerId,
    prAdapter,
    review,
    teamId: domainContext?.linear?.teamId || issue?.team?.id || null,
    artifactSetLineage: persistedArtifact.artifact_set_lineage,
    plan,
  };
  const applyResult = await applyCommitEffects({ effects: commitEffects, ctx, trace });
  if (applyResult.outcome !== "ok") {
    recordSpan(trace, "review_commit_effect_pending", {
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      run_id: persistedArtifact.run_id,
    });
    if (applyResult.outcome === "failed_closed") {
      return {
        status: "failed_closed",
        failureReasons: [applyResult.reason || "review_commit_effect_failed_closed"],
        pending_effect_id: applyResult.pending_effect_id,
        reason: applyResult.reason,
        trace,
        durableRecord,
        artifact: persistedArtifact,
      };
    }
    return {
      status: "pending",
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      trace,
      durableRecord,
      artifact: persistedArtifact,
    };
  }

  const artifactWithProducedIdentities = {
    ...persistedArtifact,
    produced_identities: applyResult.produced_identities,
  };
  return {
    status: "completed",
    applied: applyResult.applied,
    produced_identities: applyResult.produced_identities,
    trace,
    durableRecord,
    artifact: artifactWithProducedIdentities,
  };
}

function reviewFailClosed(trace, failureReasons) {
  recordSpan(trace, "review_run_failed_closed", {
    failure_reasons: [...new Set(failureReasons || ["failed_closed"])],
  });
  return { status: "failed_closed", failureReasons: [...new Set(failureReasons || ["failed_closed"])], trace };
}

function executionTerminalArtifact({
  runId,
  domainTrace,
  issueId,
  issue,
  runResult,
  runtimeAssignments,
  runtimeEvidence,
  driverSessionHandle = null,
  environment,
  acceptedRefs = null,
  runContext = null,
  executionMode = null,
  resumeRecord = null,
  completedAt = null,
}) {
  const terminalOutput = runResult?.terminal_output || {};
  const terminalRunId = runId || terminalOutput.run_id;
  const kind = terminalOutput.outcome === "commit" ? "commit" : "pause";
  const runtimeEvidencePackets = packetsFromRuntimeEvidence(runtimeEvidence);
  const artifactSetLineage = normalizeArtifactSetLineage(runResult?.artifact_set_lineage);
  const normalizedResumeRecord = normalizeResumeRecord(resumeRecord);
  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: EXECUTION_FUNCTION_VERSION,
    workflow_version: EXECUTION_FUNCTION_VERSION,
    kind,
    run_id: terminalRunId,
    domain_id: domainTrace?.domain_id || null,
    workspace_id: domainTrace?.workspace_id || null,
    team_id: domainTrace?.team_id || null,
    linear_issue_id: issueId || issue?.id || null,
    terminal_output: terminalOutputAudit(terminalOutput),
    evidence: terminalEvidence(runResult?.evidence),
    bounds: runResult?.bounds || {},
    environment: environment || {},
    runtime_assignments: runtimeAssignments || {},
    runtime_metadata: buildRuntimeMetadata({
      acceptedPackets: runtimeEvidencePackets,
      runtimeAssignments,
      runtimeEvidence,
      driverSessionHandle,
    }),
    payload_schema_id: EXECUTION_RUN_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: terminalOutputAudit(terminalOutput),
      pr_title: terminalOutput.pr_title,
      pr_body: terminalOutput.pr_body,
      linear_issue_id: terminalOutput.linear_issue_id || issueId || issue?.id || null,
      resource_manifest: Array.isArray(runContext?.resourceManifest) ? runContext.resourceManifest : [],
      ...(normalizedResumeRecord ? { resume: normalizedResumeRecord } : {}),
    },
    resource_manifest: Array.isArray(runContext?.resourceManifest) ? runContext.resourceManifest : [],
    ...(normalizedResumeRecord ? { resume: normalizedResumeRecord } : {}),
    ...(Array.isArray(acceptedRefs) && acceptedRefs.length > 0 ? { accepted_refs: acceptedRefs } : {}),
    ...(artifactSetLineage ? { artifact_set_lineage: artifactSetLineage } : {}),
    completed_at: completedAt || new Date().toISOString(),
    ...(typeof executionMode === "string" && executionMode !== "" ? { execution_mode: executionMode } : {}),
  };
  if (kind === "pause") {
    artifact.source = terminalOutput.outcome === "failed_closed" ? "failed_closed" : "orchestrator_terminal";
    artifact.pause_packet = pausePacketFromTerminalOutput(terminalOutput);
    artifact.payload.pause_packet = artifact.pause_packet;
  }
  return artifact;
}

async function resolveReviewPrAdapter({ repoIdentity, runDeps = {} } = {}) {
  if (typeof runDeps.prAdapter === "function") return runDeps.prAdapter({ repoIdentity });
  if (runDeps.prAdapter && typeof runDeps.prAdapter === "object") return runDeps.prAdapter;
  if (typeof runDeps.createPrAdapter === "function") return runDeps.createPrAdapter({ repoIdentity });
  return createDefaultExecutionPullRequestAdapter({ repoIdentity });
}

async function resolveReviewPlan({
  reviewDecision = null,
  issue,
  repoIdentity,
  prAdapter,
  locatePr = locatePullRequestForIssue,
} = {}) {
  if (reviewDecision?.action === "escalate") {
    const decisionPr = reviewDecision.pr || reviewDecision.location?.pr || null;
    return {
      mode: "preflight_escalate",
      reason: reviewDecision.reason || "review_escalation_required",
      location: reviewDecision.location || null,
      pr: decisionPr,
      hasPr: reviewDecision.hasPr === true && Boolean(decisionPr),
      headSha: decisionPr?.head_sha || headShaFromReviewLocation(reviewDecision.location),
    };
  }
  if (reviewDecision?.pr) {
    return {
      mode: "review",
      reason: reviewDecision.reason || "review_pr_found",
      location: reviewDecision.location || null,
      pr: reviewDecision.pr,
      hasPr: true,
    };
  }

  const location = await locatePr({ issueContext: issue, repoIdentity, prAdapter });
  if (location?.status === "found") {
    return {
      mode: "review",
      reason: "review_pr_found",
      location,
      pr: location.pr,
      hasPr: true,
    };
  }
  return {
    mode: "preflight_escalate",
    reason: location?.reason || `review_pr_${location?.status || "missing"}`,
    location,
    pr: null,
    hasPr: false,
    headSha: headShaFromReviewLocation(location),
  };
}

async function assembleReviewRuntimeInput({ issue, pr, repoIdentity, prAdapter } = {}) {
  if (typeof prAdapter?.getPullRequestFiles !== "function") {
    throw new Error("review_pr_adapter_getPullRequestFiles_missing");
  }
  const diff = await prAdapter.getPullRequestFiles(pr.number);
  const files = Array.isArray(diff?.files) ? diff.files.map(reviewDiffFileProjection) : [];
  const packet = {
    schema_version: "teami-review-input/v1",
    issue: reviewIssueProjection(issue),
    pull_request: {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      head_sha: pr.head_sha,
      default_branch: repoIdentity?.default_branch || null,
    },
    diff: {
      diff_incomplete: Boolean(diff?.diff_incomplete),
      reason: diff?.reason || null,
      files,
    },
  };
  return {
    diff_incomplete: packet.diff.diff_incomplete,
    diff_incomplete_reason: packet.diff.reason,
    packet,
    project: {
      id: issue?.id || null,
      name: issue?.title || issue?.identifier || "Review issue",
      description: issue?.description || "",
      content: JSON.stringify(packet, null, 2),
      status: issue?.state || null,
      labels: Array.isArray(issue?.labels) ? issue.labels : [],
      issues: [{
        id: issue?.id || null,
        identifier: issue?.identifier || null,
        title: issue?.title || null,
        state: issue?.state || null,
      }],
    },
    resource: {
      id: `${pr.owner}/${pr.repo}`,
      kind: "git_repo",
      label: `${pr.owner}/${pr.repo}`,
    },
  };
}

function reviewTerminalArtifact({
  runId,
  domainTrace,
  issueId,
  issue,
  runResult,
  runtimeAssignments,
  runtimeEvidence,
  driverSessionHandle = null,
  environment,
  acceptedRefs = null,
  repoIdentity = null,
  pr = null,
  reviewInput = null,
  completedAt = null,
}) {
  const terminalOutput = runResult?.terminal_output || {};
  const terminalRunId = runId || terminalOutput.run_id;
  const runtimeEvidencePackets = packetsFromRuntimeEvidence(runtimeEvidence);
  const artifactSetLineage = normalizeArtifactSetLineage(runResult?.artifact_set_lineage);
  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: REVIEW_FUNCTION_VERSION,
    workflow_version: REVIEW_FUNCTION_VERSION,
    kind: "commit",
    run_id: terminalRunId,
    domain_id: domainTrace?.domain_id || null,
    workspace_id: domainTrace?.workspace_id || null,
    team_id: domainTrace?.team_id || null,
    linear_issue_id: issueId || issue?.id || null,
    terminal_output: terminalOutputAudit(terminalOutput),
    evidence: terminalEvidence(runResult?.evidence),
    bounds: runResult?.bounds || {},
    environment: environment || {},
    runtime_assignments: runtimeAssignments || {},
    runtime_metadata: buildRuntimeMetadata({
      acceptedPackets: runtimeEvidencePackets,
      runtimeAssignments,
      runtimeEvidence,
      driverSessionHandle,
    }),
    payload_schema_id: REVIEW_RUN_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: terminalOutputAudit(terminalOutput),
      disposition: terminalOutput.disposition,
      body: terminalOutput.body,
      reviewed_head_sha: terminalOutput.reviewed_head_sha,
      ...(Array.isArray(terminalOutput.comments) ? { comments: terminalOutput.comments } : {}),
      linear_issue_id: issueId || issue?.id || null,
      github_pull_request: pr ? {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        head_sha: pr.head_sha,
      } : null,
      repo_identity: repoIdentity ? {
        owner: repoIdentity.owner,
        repo: repoIdentity.repo,
        default_branch: repoIdentity.default_branch || null,
      } : null,
      review_input_schema_version: reviewInput?.packet?.schema_version || null,
    },
    resource_manifest: repoIdentity ? [{
      kind: "git_repo",
      id: `${repoIdentity.owner}/${repoIdentity.repo}`,
      role: "primary",
      label: `${repoIdentity.owner}/${repoIdentity.repo}`,
    }] : [],
    ...(Array.isArray(acceptedRefs) && acceptedRefs.length > 0 ? { accepted_refs: acceptedRefs } : {}),
    ...(artifactSetLineage ? { artifact_set_lineage: artifactSetLineage } : {}),
    completed_at: completedAt || new Date().toISOString(),
    execution_mode: "live",
  };
  return artifact;
}

function terminalOutputAudit(terminalOutput = {}) {
  return {
    ...terminalOutput,
    source_refs: Array.isArray(terminalOutput.source_refs) ? terminalOutput.source_refs : [],
    assumptions: Array.isArray(terminalOutput.assumptions) ? terminalOutput.assumptions : [],
    constraints: Array.isArray(terminalOutput.constraints) ? terminalOutput.constraints : [],
    risks: Array.isArray(terminalOutput.risks) ? terminalOutput.risks : [],
  };
}

function terminalEvidence(evidence) {
  if (!isRecord(evidence)) return { perspectives_run: [] };
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

function synthesizeReviewEscalationRunResult({
  runId,
  headSha = NO_REVIEW_HEAD_SHA,
  reason = "review_escalation_required",
  body = null,
  bounds = null,
} = {}) {
  return {
    terminal_output: {
      schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
      run_id: runId,
      workflow_version: ENGINE_VERSION,
      outcome: "commit",
      reason: "synthesis_complete",
      context_digest: `Review escalated: ${reason || "review_escalation_required"}`,
      source_refs: [],
      assumptions: [],
      constraints: [],
      risks: [reason || "review_escalation_required"],
      disposition: "escalate",
      body: body || reviewEscalationBody({ reason }),
      reviewed_head_sha: headSha || NO_REVIEW_HEAD_SHA,
    },
    evidence: { perspectives_run: [] },
    bounds: normalizeReviewBounds(bounds),
  };
}

function reviewEscalationBody({ reason, detail = null, noPr = false } = {}) {
  const lines = [
    "Teami review escalated.",
    "",
    `Reason: ${reason || "review_escalation_required"}.`,
  ];
  if (detail) lines.push(`Detail: ${detail}.`);
  if (noPr) {
    lines.push("No reviewable open PR was available, so only the Linear escalation route was applied.");
  }
  return lines.join("\n");
}

function isOrchestratorOutputValidationError(error) {
  return String(error?.message || "").startsWith("Orchestrator output failed validation:");
}

function reviewValidationDetailFromError(error) {
  return String(error?.message || "")
    .replace(/^Orchestrator output failed validation:\s*/u, "")
    .trim() || null;
}

function normalizeReviewBounds(bounds) {
  if (isRecord(bounds)) {
    return {
      rounds_used: Number.isFinite(bounds.rounds_used) ? bounds.rounds_used : 0,
      max_rounds: Number.isFinite(bounds.max_rounds) ? bounds.max_rounds : 1,
      ...(Number.isFinite(bounds.wall_ms) ? { wall_ms: bounds.wall_ms } : {}),
      ...(Number.isFinite(bounds.invocations) ? { invocations: bounds.invocations } : {}),
    };
  }
  return { rounds_used: 0, max_rounds: 1, wall_ms: 0, invocations: 0 };
}

function reviewEnvironment(environment) {
  if (isRecord(environment) && Object.hasOwn(environment, "agent_write_credentials_present")) {
    return { ...environment };
  }
  return {
    ...(isRecord(environment) ? environment : {}),
    agent_write_credentials_present: false,
  };
}

function reviewIssueProjection(issue = {}) {
  return {
    id: issue?.id || null,
    identifier: issue?.identifier || null,
    title: issue?.title || null,
    description: issue?.description || null,
    url: issue?.url || null,
    state: issue?.state || null,
    labels: Array.isArray(issue?.labels)
      ? issue.labels.map((label) => ({ id: label?.id || null, name: label?.name || null }))
      : [],
    project: issue?.project ? {
      id: issue.project.id || null,
      name: issue.project.name || null,
      url: issue.project.url || null,
    } : null,
  };
}

function reviewDiffFileProjection(file = {}) {
  return {
    filename: stringOrNull(file.filename) || stringOrNull(file.path) || null,
    status: stringOrNull(file.status) || null,
    previous_filename: stringOrNull(file.previous_filename) || null,
    additions: finiteNumberOrNull(file.additions),
    deletions: finiteNumberOrNull(file.deletions),
    changes: finiteNumberOrNull(file.changes),
    patch: typeof file.patch === "string" ? file.patch : null,
    blob_url: stringOrNull(file.blob_url),
    raw_url: stringOrNull(file.raw_url),
  };
}

function headShaFromReviewLocation(location = {}) {
  return stringOrNull(location?.pr?.head_sha) ||
    stringOrNull(location?.pull_request?.head_sha) ||
    (Array.isArray(location?.pull_requests)
      ? stringOrNull(location.pull_requests.find((pullRequest) => pullRequest?.head_sha)?.head_sha)
      : null);
}

function finiteNumberOrNull(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function pausePacketFromTerminalOutput(terminalOutput = {}) {
  return {
    schema_version: terminalOutput.schema_version,
    run_id: terminalOutput.run_id,
    phase: "orchestrator_terminal",
    status: terminalOutput.outcome === "failed_closed" ? "failed_closed" : "pause",
    reason: terminalOutput.reason,
    context_digest: terminalOutput.context_digest,
    source_refs: Array.isArray(terminalOutput.source_refs) ? terminalOutput.source_refs : [],
    assumptions: Array.isArray(terminalOutput.assumptions) ? terminalOutput.assumptions : [],
    constraints: Array.isArray(terminalOutput.constraints) ? terminalOutput.constraints : [],
    risks: Array.isArray(terminalOutput.risks) ? terminalOutput.risks : [],
    open_questions_markdown: terminalOutput.open_questions_markdown,
    project_update_markdown: terminalOutput.project_update_markdown,
  };
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

function executionCommitEffects({ definition, runDeps }) {
  const overlays = effectImplementationOverlays(runDeps);
  return definition.commit_effects.map((effect) => ({
    ...effect,
    ...(overlays.get(effect.id) || {}),
  }));
}

function reviewCommitEffects({ disposition, hasPr, runDeps }) {
  const overlays = effectImplementationOverlays(runDeps);
  return selectEffectsForDisposition(disposition, hasPr).map((effect) => ({
    ...effect,
    ...(overlays.get(effect.id) || {}),
  }));
}

function effectImplementationOverlays(runDeps = {}) {
  const overlays = new Map();
  for (const candidate of [
    runDeps.gitEffect,
    runDeps.issueMoveEffect,
    runDeps.linearIssueEffect,
    runDeps.effects,
    runDeps.commitEffects,
  ]) {
    for (const effect of injectedEffectEntries(candidate)) {
      if (!effect?.id) continue;
      overlays.set(effect.id, { ...(overlays.get(effect.id) || {}), ...effect });
    }
  }
  return overlays;
}

function injectedEffectEntries(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate.filter(isRecord);
  if (Array.isArray(candidate.effects)) return candidate.effects.filter(isRecord);
  if (Array.isArray(candidate.commitEffects)) return candidate.commitEffects.filter(isRecord);
  if (isRecord(candidate.byId)) {
    return Object.entries(candidate.byId).map(([id, effect]) => ({ id, ...(isRecord(effect) ? effect : {}) }));
  }
  const entries = [];
  for (const id of [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID]) {
    if (isRecord(candidate[id])) entries.push({ id, ...candidate[id] });
  }
  if (hasEffectStep(candidate)) {
    entries.push({ id: candidate.id || GIT_REPO_COMMIT_EFFECT_ID, ...candidate });
  }
  return entries;
}

function hasEffectStep(candidate) {
  return ["probe", "apply", "verify"].some((step) => typeof candidate?.[step] === "function");
}

async function maybeRunKillPoint(runDeps, point, ctx) {
  if (!ctx.killPoint || ctx.killPoint !== point) return;
  if (typeof runDeps.killPoint === "function") {
    await runDeps.killPoint(point, ctx);
  }
}

async function loadExecutionIssueContext({ client, issueId }) {
  if (typeof client?.getIssueContext === "function") return client.getIssueContext(issueId);
  if (typeof client?.getIssue === "function") return client.getIssue(issueId);
  return {
    id: issueId,
    identifier: issueId,
    title: "",
    description: "",
    state: null,
    relations: [],
  };
}

async function claimExecutionIssueInProgress({ client, issue, issueId, cache = null } = {}) {
  const inProgressStateId = stringOrNull(cache?.issueStatuses?.in_progress);
  if (!inProgressStateId || issue?.state?.id === inProgressStateId) return issue;
  if (typeof client?.updateIssue !== "function") {
    throw new Error("linear_issue_in_progress_claim_update_unavailable");
  }
  const updated = await client.updateIssue(issueId, { stateId: inProgressStateId });
  return {
    ...issue,
    state: updated?.state || {
      ...issue?.state,
      id: inProgressStateId,
    },
  };
}

function normalizeMaterializedRunContext(materialized, gitRemoteResolution = {}) {
  if (isRecord(materialized?.runContext)) {
    return runContextWithGitRemoteResolution(materialized.runContext, gitRemoteResolution);
  }
  if (isRecord(materialized)) {
    return runContextWithGitRemoteResolution({
      runId: materialized.runId || null,
      engineRepoRoot: materialized.engineRepoRoot || MODULE_REPO_ROOT,
      resources: isRecord(materialized.resources) ? materialized.resources : {},
      selectedResourceId: stringOrNull(materialized.selectedResourceId),
      selectedResource: isRecord(materialized.selectedResource) ? materialized.selectedResource : null,
      resourceManifest: Array.isArray(materialized.resourceManifest) ? materialized.resourceManifest : [],
      runGit: materialized.runGit || null,
    }, gitRemoteResolution);
  }
  return runContextWithGitRemoteResolution(
    { resources: {}, selectedResourceId: null, selectedResource: null, resourceManifest: [] },
    gitRemoteResolution,
  );
}

function runContextWithGitRemoteResolution(runContext = {}, gitRemoteResolution = {}) {
  return {
    ...runContext,
    ...gitRemoteRunContextFields({
      gitRemoteUrlOverride: stringOrNull(runContext.gitRemoteUrlOverride) ||
        stringOrNull(gitRemoteResolution.gitRemoteUrlOverride),
      gitRemoteUrlOverrides: isRecord(runContext.gitRemoteUrlOverrides)
        ? runContext.gitRemoteUrlOverrides
        : gitRemoteResolution.gitRemoteUrlOverrides,
      resolveGitRemoteUrl: typeof runContext.resolveGitRemoteUrl === "function"
        ? runContext.resolveGitRemoteUrl
        : gitRemoteResolution.resolveGitRemoteUrl,
    }),
  };
}

function gitRemoteResolutionOptions(options = {}) {
  const runDeps = isRecord(options.runDeps) ? options.runDeps : {};
  return gitRemoteRunContextFields({
    gitRemoteUrlOverride: stringOrNull(options.gitRemoteUrlOverride) || stringOrNull(runDeps.gitRemoteUrlOverride),
    gitRemoteUrlOverrides: isRecord(options.gitRemoteUrlOverrides)
      ? options.gitRemoteUrlOverrides
      : isRecord(runDeps.gitRemoteUrlOverrides)
        ? runDeps.gitRemoteUrlOverrides
        : null,
    resolveGitRemoteUrl: typeof options.resolveGitRemoteUrl === "function"
      ? options.resolveGitRemoteUrl
      : typeof runDeps.resolveGitRemoteUrl === "function"
        ? runDeps.resolveGitRemoteUrl
        : null,
  });
}

function gitRemoteRunContextFields({
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
} = {}) {
  const normalizedOverride = stringOrNull(gitRemoteUrlOverride);
  return {
    ...(normalizedOverride ? { gitRemoteUrlOverride: normalizedOverride } : {}),
    ...(isRecord(gitRemoteUrlOverrides) ? { gitRemoteUrlOverrides } : {}),
    ...(typeof resolveGitRemoteUrl === "function" ? { resolveGitRemoteUrl } : {}),
  };
}

function runtimeOptionsFromRunContext(runContext = {}) {
  const gitHandle = runContext.selectedResource?.handle || null;
  return {
    cwd: gitHandle?.workingDir || runContext.cwd,
    envAugment: {
      ...(isRecord(runContext.envAugment) ? runContext.envAugment : {}),
      ...(isRecord(gitHandle?.envAugment) ? gitHandle.envAugment : {}),
    },
  };
}

function normalizeExecutionResumeFrom(resumeFrom) {
  if (!isRecord(resumeFrom)) return null;
  const sessionHandle = isRecord(resumeFrom.sessionHandle)
    ? { ...resumeFrom.sessionHandle }
    : null;
  const priorRunId = stringOrNull(resumeFrom.priorRunId);
  const coldReconstruct = resumeFrom.coldReconstruct === true || resumeFrom.mode === "cold_reconstruct";
  if ((!sessionHandle || !priorRunId) && !coldReconstruct) return null;
  if (!priorRunId) return null;
  return {
    sessionHandle,
    priorRunId,
    ...(coldReconstruct ? { coldReconstruct: true } : {}),
    reviewerNotes: typeof resumeFrom.reviewerNotes === "string" ? resumeFrom.reviewerNotes : "",
    smokeTests: isRecord(resumeFrom.smokeTests) ? resumeFrom.smokeTests : {},
    runtimeVersion: stringOrNull(resumeFrom.runtimeVersion),
    head_sha: stringOrNull(resumeFrom.head_sha || resumeFrom.headSha),
  };
}

function resumeRecordFromTerminalOutput({ terminalOutput = null, resumeFrom = null } = {}) {
  if (!resumeFrom) return null;
  const terminalOutcome = stringOrNull(terminalOutput?.outcome);
  return normalizeResumeRecord({
    resume_status: resumeStatusForTerminalOutcome(terminalOutcome),
    terminal_outcome: terminalOutcome,
    head_sha: resumeFrom.head_sha,
    prior_run_id: resumeFrom.priorRunId,
  });
}

function resumeStatusForTerminalOutcome(terminalOutcome) {
  if (terminalOutcome === "commit") return "committed";
  if (terminalOutcome === "pause") return "paused";
  return "escalated_unresumable";
}

function normalizeResumeRecord(record) {
  if (!isRecord(record)) return null;
  const resumeStatus = stringOrNull(record.resume_status);
  if (!["committed", "paused", "escalated_unresumable"].includes(resumeStatus)) return null;
  const priorRunId = stringOrNull(record.prior_run_id);
  return {
    resume_status: resumeStatus,
    terminal_outcome: stringOrNull(record.terminal_outcome),
    head_sha: stringOrNull(record.head_sha),
    ...(priorRunId ? { prior_run_id: priorRunId } : {}),
  };
}

function domainResourcesForExecution({ domainContext, registry, issue = null } = {}) {
  const resources = domainResourceRecordsForExecution({ domainContext, registry });
  const target = resourceTargetForIssue(issue);
  const gitResources = resources.filter((resource) => resource?.kind === "git_repo");
  if (target) {
    if (target.kind !== "git_repo") {
      throw resourceTargetSelectionError(RESOURCE_TARGET_NOT_ALLOWED_REASON);
    }
    const selected = gitResources.find((resource) => resource.id === target.id);
    if (!selected) {
      throw resourceTargetSelectionError(RESOURCE_TARGET_NOT_ALLOWED_REASON);
    }
    return [selected];
  }
  if (gitResources.length === 1) return [gitResources[0]];
  throw resourceTargetSelectionError(RESOURCE_TARGET_MISSING_REASON);
}

function domainResourceRecordsForExecution({ domainContext, registry } = {}) {
  if (Array.isArray(domainContext?.resources)) return domainContext.resources;
  const domain = registry?.domains?.find((candidate) => candidate.id === domainContext?.domainId);
  return Array.isArray(domain?.resources) ? domain.resources : [];
}

function resourceTargetForIssue(issue = null) {
  const direct = isRecord(issue?.resource_target) ? issue.resource_target : null;
  const parsed = direct || parseResourceTargetFromDescription(issue?.description);
  if (!isRecord(parsed)) return null;
  const kind = stringOrNull(parsed.kind);
  const id = stringOrNull(parsed.id);
  if (!kind || !id) return null;
  return { kind, id };
}

function resourceTargetSelectionError(reason) {
  const error = new Error(reason);
  error.code = reason;
  error.resourceTargetSelection = true;
  return error;
}

function isResourceTargetSelectionError(error) {
  return error?.resourceTargetSelection === true &&
    [RESOURCE_TARGET_MISSING_REASON, RESOURCE_TARGET_NOT_ALLOWED_REASON].includes(error.message);
}

function coldResumeGitIntentFromRunDeps(runDeps = {}, { domainId = null, objectId = null } = {}) {
  const intent = runDeps?.coldResumeGitIntent || runDeps?.resumeGitIntent || null;
  if (!isRecord(intent?.git)) return null;
  const git = compactRecord({
    owner: stringOrNull(intent.git.owner),
    repo: stringOrNull(intent.git.repo),
    branch: stringOrNull(intent.git.branch),
    base_sha: stringOrNull(intent.git.base_sha),
    head_sha: stringOrNull(intent.git.head_sha),
    tree_sha: stringOrNull(intent.git.tree_sha),
    resource_id: stringOrNull(intent.git.resource_id),
  });
  if (!git.owner || !git.repo || !git.branch || !git.head_sha) return null;
  return {
    objectType: "issue",
    domainId: stringOrNull(intent.domainId) || domainId,
    objectId: stringOrNull(intent.objectId) || objectId,
    runId: stringOrNull(intent.runId) || "cold_resume",
    artifactKind: stringOrNull(intent.artifactKind) || "commit",
    git,
    ...(stringOrNull(intent.startedAt) ? { startedAt: stringOrNull(intent.startedAt) } : {}),
  };
}

function primaryResource(runContext = {}) {
  const resource = isRecord(runContext.selectedResource) ? runContext.selectedResource : null;
  if (!resource) return null;
  const manifest = (runContext.resourceManifest || []).find((entry) => entry?.id === resource.id);
  return {
    id: resource.id,
    kind: resource.kind,
    label: manifest?.label || resource.id,
  };
}

function executionWorkTypeForTrace({ issue = null, resource = null } = {}) {
  const explicit = stringOrNull(issue?.work_type || issue?.workType);
  if (explicit) return explicit;
  if (resource?.kind === "git_repo") return "code";
  return null;
}

export async function finishWakeFromRunnerResult({ store, wake, runnerId, leaseToken, result, traceDelivery = null }) {
  const mapping = mapRunnerOutcomeToWake(result);
  const completed = await store.completeWake({
    wakeId: wake.id,
    runnerId,
    leaseToken,
    status: mapping.status,
    reason: mapping.reason,
    providerUpdateIds: providerUpdateIdsForResult(result),
    artifact: result?.artifact || null,
    artifactPointer: result?.durableRecord?.artifact_path
      ? { artifact_path: result.durableRecord.artifact_path }
      : undefined,
  });
  return {
    status: mapping.status,
    reason: mapping.reason,
    wake: completed.wake,
    run: completed.run,
    result,
    traceDelivery,
  };
}

// CONSTRAINTS #27: eval-mode NEVER mutates Linear and NEVER claims gateway
// wakes. Eval mode is made structurally incapable of mutation regardless of
// the client a caller supplies: every Linear client used by eval mode is
// wrapped in this read-only guard, which passes through only the known read
// methods the eval path needs and replaces every other function-valued
// member with a thrower. The eval CLI task additionally constructs a
// snapshot-backed client that has NO mutation methods at all
// (createSnapshotEvalLinearClient in decomposition-eval-cli.mjs), so this
// guard is the second wall, not the only one. Gateway wakes are structurally
// out of reach too: eval mode takes no wake-queue store parameter and the
// only "wake" it knows is the local `eval_<run_id>` pseudo-wake below.
const EVAL_MODE_ALLOWED_LINEAR_READS = new Set([
  "listTeams",
  "listProjectStatuses",
  "listWorkflowStates",
  "findProjectLabelsByName",
  "findIssueLabelsByName",
  "findTemplatesByName",
  "getProjectContext",
]);

export function createEvalModeReadOnlyLinearClient(client) {
  if (!client || typeof client !== "object") {
    throw new Error("eval mode requires a Linear read client.");
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && EVAL_MODE_ALLOWED_LINEAR_READS.has(prop)) return value;
      return function evalModeForbiddenLinearClientMethod() {
        throw new Error(`eval_mode_forbidden_linear_client_method:${String(prop)}`);
      };
    },
  });
}

function flattenRuntimeSubagentEvidence(runtimeEvidence = {}) {
  return runtimeEvidenceEntries(runtimeEvidence)
    .flatMap((entry) => Array.isArray(entry?.turns) ? entry.turns : [])
    .map((turn) => turn?.subagent_evidence)
    .filter(isRecord)
    .map((record) => ({ ...record }));
}

export async function runDecompositionEvalMode({
  linearClient,
  config,
  cache,
  projectId,
  // Same as runTriggeredDecomposition: the eval caller defaults the executors +
  // roster to the real implementations; tests inject fakes (Seam 1).
  runtimeExecutor = createProcessRuntimeExecutor(),
  orchestratorTurnExecutor = executeOrchestratorTurn,
  roster = createOrchestratorRoster({ workflowType: DECOMPOSITION_WORKFLOW_TYPE }),
  runId = defaultRunId({ wake: { id: "eval" } }),
  repoRoot = process.cwd(),
  runStoreDir = null,
  traceId = null,
  domainContext = null,
  spanSink = null,
} = {}) {
  const evalDomainContext = requireDomainContext(domainContext);
  // Constructor-injected non-mutation guarantee: even a live GraphQL client
  // becomes read-only inside eval mode (CONSTRAINTS #27).
  const client = createEvalModeReadOnlyLinearClient(linearClient);
  const project = await client.getProjectContext(projectId);
  const wake = {
    id: `eval_${runId}`,
    object_id: projectId,
    workflow_type: "decomposition",
    trigger_type: "eval.local",
  };
  const definition = getDecompositionDefinition();
  // Default per-turn observability (eval path): collect turn spans and drain them
  // into the eval run trace when no sink is injected, so the eval harness's trace
  // carries turn-level spans too.
  const ownTurnSpanSink = spanSink ? null : createOrchestratorTurnTraceSink();
  const {
    output,
    environment,
    runtimeEvidence,
    acceptedRefs,
  } = await runOrchestratorLoop({
    runId,
    wake,
    event: null,
    project,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    definition,
    commitPayload: decompositionCommitPayload,
    repoRoot,
    allowedRepoPacket: evalDomainContext?.allowedRepoPacket ?? [],
    spanSink: spanSink || ownTurnSpanSink,
  });
  const result = await runDecomposition({
    client,
    config,
    cache,
    projectId,
    runResult: output,
    environment,
    runId,
    repoRoot,
    runStoreDir,
    runtimeEvidence,
    acceptedRefs,
    evalMode: true,
    domainContext: evalDomainContext,
    traceContext: {
      wake_id: wake.id,
      trace_id: traceId,
      trigger_type: "eval.local",
      source_provider: "local_eval",
      source_object_id: projectId,
      domain_id: evalDomainContext.trace.domain_id,
      team_id: evalDomainContext.trace.team_id,
      behavior_repo_id: evalDomainContext.trace.behavior_repo_id,
      workspace_id: evalDomainContext.trace.workspace_id,
    },
  });
  ownTurnSpanSink?.drainInto(result?.trace);
  // The orchestrator run output carries the run's perspectives_run (one entry
  // per subagent invocation) so eval wrappers can report what the run did even
  // when no terminal artifact was produced. (The retired per-phase packet array
  // no longer exists — the run is a free orchestrator loop, not a phase list.)
  return {
    ...result,
    orchestratorOutput: output,
    environment,
    runtimeEvidence,
    subagent_evidence: flattenRuntimeSubagentEvidence(runtimeEvidence),
  };
}

export function mapRunnerOutcomeToWake(result) {
  if (result?.status === "completed") return { status: "completed", reason: null };
  if (result?.status === "waiting") return { status: "completed", reason: result.reason || "dependency_blocked" };
  if (result?.status === "paused") return { status: "paused", reason: result.reason || "paused" };
  if (result?.status === "ineligible") {
    return {
      status: "rejected",
      reason: result.eligibility?.blockingConditions?.join(",") || "ineligible",
    };
  }
  if (result?.status === "failed_closed") {
    return {
      status: "rejected",
      reason: result.failureReasons?.join(",") || "failed_closed",
    };
  }
  if (result?.status === "pending") {
    return {
      status: "dead_letter",
      reason: result.reason || `commit_effect_pending:${result.pending_effect_id || "unknown"}`,
    };
  }
  return { status: "dead_letter", reason: `unknown_runner_result:${result?.status || "missing"}` };
}

// The default process runtime executor for the orchestrator loop. It exposes the
// generalized ROLE/PROMPT-based subagent spawn (Seam 1/2) — there is no
// phase-coupled prompt builder. The loop calls `executeSubagent` for both
// invoke_library (prompt = the library body) and invoke_one_off (prompt = the
// control action's prompt). It delegates to the shared executeSubagent in
// orchestrator-turn.mjs, threading the configured runtime-command knobs.
export function createProcessRuntimeExecutor({
  runCommand = runRuntimeCommand,
  repoRoot = process.cwd(),
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
} = {}) {
  return {
    async executeSubagent(input) {
      return executeSubagent({
        ...input,
        repoRoot: input.repoRoot ?? repoRoot,
        runCommand,
        timeoutMs: input.timeoutMs ?? timeoutMs,
        maxOutputBytes: input.maxOutputBytes ?? maxOutputBytes,
      });
    },
  };
}

function providerUpdateIdsForResult(result) {
  const projectedIds = providerUpdateIdsFromProducedIdentities(result?.produced_identities);
  if (projectedIds.length > 0) return projectedIds;
  return uniqueStrings([
    result?.projectUpdate?.id,
    ...(result?.created || []).map(providerObjectId),
    ...(result?.reused || []).map(providerObjectId),
  ]);
}

function providerUpdateIdsFromProducedIdentities(producedIdentities) {
  if (!Array.isArray(producedIdentities)) return [];
  const ids = [];
  for (const entry of producedIdentities) {
    if (entry?.provider !== "linear" || entry?.resource_kind !== "linear_issue") continue;
    ids.push(entry.identity?.project_update_id);
    ids.push(...(Array.isArray(entry.target_ids) ? entry.target_ids : []));
  }
  return uniqueStrings(ids);
}

function providerObjectId(value) {
  if (typeof value === "string") return value;
  return value?.id || null;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "")).filter(Boolean))];
}

function startLeaseRenewal({
  store,
  wakeId,
  runnerId,
  workspaceId,
  runnerVersion,
  capabilities,
  leaseToken,
  leaseDurationMs,
}) {
  const duration = leaseDurationMs || 5 * 60 * 1000;
  const intervalMs = Math.max(1000, Math.floor(duration / 3));
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    Promise.all([
      store.renewLease({
          wakeId,
          runnerId,
          leaseToken,
          leaseDurationMs: duration,
        }),
      store.heartbeat?.({
        runnerId,
        workspaceId,
        version: runnerVersion,
        capabilities,
        currentWakeId: wakeId,
      }),
    ]).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return {
    async renewNow() {
      const result = await store.renewLease({
        wakeId,
        runnerId,
        leaseToken,
        leaseDurationMs: duration,
      });
      if (!result.ok) throw new Error(`Could not renew wake lease: ${result.reason}`);
      await store.heartbeat?.({
        runnerId,
        workspaceId,
        version: runnerVersion,
        capabilities,
        currentWakeId: wakeId,
      });
      return result;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function requireDomainContext(domainContext) {
  const missingFields = [];
  if (!domainContext?.domainId) missingFields.push("domainId");
  if (!domainContext?.linear?.workspaceId) missingFields.push("linear.workspaceId");
  if (!domainContext?.linear?.teamId) missingFields.push("linear.teamId");
  if (!domainContext?.trace?.domain_id) missingFields.push("trace.domain_id");
  if (!domainContext?.trace?.workspace_id) missingFields.push("trace.workspace_id");
  if (!domainContext?.trace?.team_id) missingFields.push("trace.team_id");
  if (missingFields.length > 0) {
    throw new Error(`${DOMAIN_CONTEXT_REQUIRED_REASON}: trigger runner requires a resolved DomainContext (${missingFields.join(", ")}).`);
  }
  return domainContext;
}

function wakeDomainSelector({ wake, workspaceId = null } = {}) {
  return {
    workspaceId: wake?.workspace_id || wake?.workspaceId || workspaceId || null,
    webhookId: wakeFactArray(wake?.webhook_ids || wake?.webhookIds || wake?.webhook_id),
    projectTeamIds: wakeFactArray(
      wake?.team_ids ||
      wake?.teamIds ||
      wake?.project_team_ids ||
      wake?.projectTeamIds,
    ),
  };
}

function wakeFactArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record || {}).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

function reviewVerdictPayloadSpanAttributes({
  terminalOutput = {},
  pr = null,
  repoIdentity = null,
} = {}) {
  const body = typeof terminalOutput.body === "string" ? terminalOutput.body : "";
  return knownTraceAttributes({
    disposition: stringOrNull(terminalOutput.disposition),
    reviewed_head_sha: stringOrNull(terminalOutput.reviewed_head_sha),
    github_owner: stringOrNull(pr?.owner || repoIdentity?.owner),
    github_repo: stringOrNull(pr?.repo || repoIdentity?.repo),
    github_pull_request_number: finiteNumberOrNull(pr?.number),
    body_digest_kind: "sha256",
    body_sha256: sha256Text(body),
    body_byte_length: Buffer.byteLength(body, "utf8"),
  });
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function knownTraceAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function defaultRunId({ wake }) {
  return `run_${(wake?.id || randomUUID()).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function getExecutionDefinition() {
  return getWorkflowDefinition(EXECUTION_WORKFLOW_TYPE);
}

function getDecompositionDefinition() {
  return getWorkflowDefinition(DECOMPOSITION_WORKFLOW_TYPE);
}

function getReviewDefinition() {
  return getWorkflowDefinition(REVIEW_WORKFLOW_TYPE);
}
