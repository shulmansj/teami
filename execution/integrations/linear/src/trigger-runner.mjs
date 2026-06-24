import { randomUUID } from "node:crypto";

import { evaluateDecompositionEligibility, runDecomposition } from "./linear-service.mjs";
import { createTrace } from "./trace.mjs";
import { createOrchestratorTurnTraceSink } from "./orchestrator-turn-trace-sink.mjs";
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
import { commitPayload as decompositionCommitPayload } from "./workflows/decomposition/commit-payload.mjs";
import {
  DECOMPOSITION_REQUIRED_CAPABILITIES,
  DECOMPOSITION_WORKFLOW_TYPE,
} from "./workflows/decomposition/definition.mjs";
import { resolveWakeDomainContext } from "./domain-resolver.mjs";
import { assertRunStoreWritable } from "../../../engine/run-store.mjs";
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
    roster = createOrchestratorRoster(),
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

  // The hosted claim response carries the source event directly; the
  // store-array lookup remains as the in-memory store fallback so the wake
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
    const eligibilityTrace = createTrace("decomposition_run", knownTraceAttributes({
      "workflow.name": "project_decomposition",
      "agentic_factory.domain_id": domainTrace.domain_id,
      "agentic_factory.behavior_repo_id": domainTrace.behavior_repo_id,
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
      onBeforeLinearMutation: async ({ trace }) => {
        await traceSink?.forceFlush?.({
          session: traceSession,
          trace,
          result: { status: "running" },
          stage: "pre_mutation",
        }).catch(() => {});
        const mutation = await store.markMutationStarted({ wakeId: wake.id, runnerId, leaseToken });
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

async function resolveClaimedWorkflowDefinition({ store, runnerId, claim }) {
  const { wake, leaseToken } = claim;
  try {
    await import("./workflows/decomposition/definition.mjs");
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

export async function finishWakeFromRunnerResult({ store, wake, runnerId, leaseToken, result, traceDelivery = null }) {
  const mapping = mapRunnerOutcomeToWake(result);
  const completed = await store.completeWake({
    wakeId: wake.id,
    runnerId,
    leaseToken,
    status: mapping.status,
    reason: mapping.reason,
    providerUpdateIds: providerUpdateIdsForResult(result),
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

// CONSTRAINTS #27: eval-mode NEVER mutates Linear and NEVER claims hosted
// wakes. Eval mode is made structurally incapable of mutation regardless of
// the client a caller supplies: every Linear client used by eval mode is
// wrapped in this read-only guard, which passes through only the known read
// methods the eval path needs and replaces every other function-valued
// member with a thrower. The eval CLI task additionally constructs a
// snapshot-backed client that has NO mutation methods at all
// (createSnapshotEvalLinearClient in decomposition-eval-cli.mjs), so this
// guard is the second wall, not the only one. Hosted wakes are structurally
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
  roster = createOrchestratorRoster(),
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
  return [result?.projectUpdate?.id, ...(result?.created || []).map((issue) => issue.id)].filter(Boolean);
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

function knownTraceAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function defaultRunId({ wake }) {
  return `run_${(wake?.id || randomUUID()).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function getDecompositionDefinition() {
  return getWorkflowDefinition(DECOMPOSITION_WORKFLOW_TYPE);
}
