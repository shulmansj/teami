import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readLinearCache } from "./cache.mjs";
import { configWithDomainLinearTeam } from "./domain-command-context.mjs";
import { emptyDomainRegistry, readDomainRegistry } from "./domain-registry.mjs";
import { buildDomainContext } from "./domain-resolver.mjs";
import { createLinearCredentialStore } from "./linear-credential-store.mjs";
import { isLinearRateLimited } from "./linear-graphql-client.mjs";
import { createLinearSetupGraphqlClient } from "./linear-setup-auth.mjs";
import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import { createLocalTriggerStore } from "./local-trigger-store.mjs";
import { collectNextResumeReconciliation } from "./local-supervisor.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  smokeTestsFromRuntimeSmokeCache,
} from "./runtime-smoke.mjs";
import { createProcessRuntimeExecutor, runTriggeredDecomposition } from "./trigger-runner.mjs";
import {
  ARTIFACT_DOMAIN_MISMATCH_REASON,
  ARTIFACT_PROJECT_MISMATCH_REASON,
  runDecomposition,
} from "./linear-service.mjs";
import * as triggerIdempotency from "./trigger-idempotency.mjs";
import { DECOMPOSITION_REQUIRED_CAPABILITIES } from "./workflows/decomposition/definition.mjs";

export const GATEWAY_LOCK_RELATIVE_PATH = path.join(".agentic-factory", "gateway.lock");
export const DEFAULT_GATEWAY_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const RESUME_CRASH_SAFETY_FOLLOW_UP =
  "Verify resume crash-safety in the poll model, or extend the replay gate to resume.";

const DEFAULT_CANDIDATE_PAGE_SIZE = 25;
const TERMINAL_REPLAY_STATUSES = new Set(["completed", "paused"]);
const STATUS_STATES = new Set([
  "suppressed",
  "rate_limited",
  "wedged",
  "degraded",
  "replaying",
  "working",
  "resume_attention",
  "resume_working",
]);

export function gatewayLockPath(repoRoot = process.cwd()) {
  return path.join(repoRoot, GATEWAY_LOCK_RELATIVE_PATH);
}

export function acquireGatewayLock({
  repoRoot = process.cwd(),
  lockPath = gatewayLockPath(repoRoot),
  now = () => new Date(),
  isProcessAlive = defaultIsProcessAlive,
  installHandlers = true,
  idGenerator = randomUUID,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const createdAt = toDate(now()).toISOString();
  const token = idGenerator();
  const created = tryCreateGatewayLock({ lockPath, token, createdAt });
  if (created.ok) return gatewayLockHandle({ lockPath, token, installHandlers });
  if (created.error?.code !== "EEXIST") throw created.error;

  const existing = readGatewayLock(lockPath);
  const breakReason = gatewayLockBreakReason({
    lock: existing,
    isProcessAlive,
  });
  if (breakReason && removeGatewayLockIfTokenMatches({ lockPath, token: existing?.token })) {
    const retry = tryCreateGatewayLock({ lockPath, token, createdAt });
    if (retry.ok) return gatewayLockHandle({ lockPath, token, installHandlers });
    if (retry.error?.code !== "EEXIST") throw retry.error;
  }

  return {
    ok: false,
    reason: "gateway_already_running",
    lockPath,
    message: "gateway already running in this checkout",
  };
}

export async function runGatewayOnce(options = {}) {
  const {
    repoRoot = process.cwd(),
    acquireLock = acquireGatewayLock,
    onStatus = null,
  } = options;
  const statuses = [];
  const emitStatus = createStatusEmitter({
    onStatus: (event) => {
      statuses.push(event);
      onStatus?.(event);
    },
  });
  const lock = acquireLock({ repoRoot });
  if (!lock.ok) {
    return {
      ok: false,
      status: "refused",
      reason: lock.reason || "gateway_already_running",
      lock,
      statuses,
    };
  }

  const state = gatewayState(options);
  try {
    const startup = await runGatewayStartup({
      ...options,
      state,
      emitStatus,
    });
    const poll = await runGatewayPollIteration({
      ...options,
      state,
      emitStatus,
    });
    return {
      ok: true,
      status: "completed",
      startup,
      poll,
      statuses,
    };
  } finally {
    lock.release?.();
  }
}

export async function runGatewayLoop(options = {}) {
  const {
    repoRoot = process.cwd(),
    acquireLock = acquireGatewayLock,
    onStatus = null,
    signal = null,
    sleep = defaultSleep,
    maxIterations = null,
  } = options;
  const statuses = [];
  const emitStatus = createStatusEmitter({
    onStatus: (event) => {
      statuses.push(event);
      onStatus?.(event);
    },
  });
  const lock = acquireLock({ repoRoot });
  if (!lock.ok) {
    return {
      ok: false,
      status: "refused",
      reason: lock.reason || "gateway_already_running",
      lock,
      statuses,
    };
  }

  const state = gatewayState(options);
  const iterations = [];
  try {
    const startup = await runGatewayStartup({
      ...options,
      state,
      emitStatus,
    });
    let count = 0;
    while (!signal?.aborted) {
      iterations.push(await runGatewayPollIteration({
        ...options,
        state,
        emitStatus,
      }));
      count += 1;
      if (maxIterations !== null && count >= maxIterations) break;
      await sleep(pollIntervalMs(options), { signal });
    }
    return {
      ok: true,
      status: signal?.aborted ? "stopped" : "completed",
      startup,
      iterations,
      statuses,
    };
  } finally {
    lock.release?.();
  }
}

export async function runGatewayStartup(options = {}) {
  const {
    repoRoot = process.cwd(),
    config,
    registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry(),
    domains = selectGatewayDomains({ registry }),
    idempotency = triggerIdempotency,
    createLinearClient = createGatewayLinearClient,
    runReplayProject = replayPendingMutation,
    collectResumeReconciliation = collectNextResumeReconciliation,
    emitStatus = createStatusEmitter(),
    state = gatewayState(options),
  } = options;
  if (domains.length === 0) throw new Error("no_active_domains: no active domains are configured. Run npm run init.");

  const replay = [];
  for (const domain of domains) {
    replay.push(...await drainReplayPendingForDomain({
      ...options,
      repoRoot,
      config,
      registry,
      domain,
      idempotency,
      createLinearClient,
      runReplayProject,
      emitStatus,
      state,
    }));
  }

  const resumeReconciliation = await collectResumeReconciliation({ repoRoot });
  emitResumeReconciliationStatus({ report: resumeReconciliation, emitStatus });

  return {
    replay,
    resumeReconciliation,
    followUps: [RESUME_CRASH_SAFETY_FOLLOW_UP],
  };
}

export async function runGatewayPollIteration(options = {}) {
  const {
    repoRoot = process.cwd(),
    config,
    registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry(),
    domains = selectGatewayDomains({ registry }),
    state = gatewayState(options),
  } = options;
  if (domains.length === 0) throw new Error("no_active_domains: no active domains are configured. Run npm run init.");

  const results = [];
  for (const domain of domains) {
    results.push(await pollGatewayDomain({
      ...options,
      repoRoot,
      config,
      registry,
      domain,
      state,
    }));
  }
  return { domains: results };
}

export async function pollGatewayDomain(options = {}) {
  const {
    repoRoot = process.cwd(),
    config,
    registry,
    domain,
    createLinearClient = createGatewayLinearClient,
    emitStatus = createStatusEmitter(),
    state = gatewayState(options),
    first = DEFAULT_CANDIDATE_PAGE_SIZE,
  } = options;
  const nowMs = timeMs(options.now);
  const backoffUntil = state.domainBackoff.get(domain.id) || 0;
  if (backoffUntil > nowMs) {
    return {
      domainId: domain.id,
      status: "backing_off",
      nextAttemptAt: backoffUntil,
    };
  }

  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const client = await createLinearClient({ config, repoRoot, domain, domainContext });
  const processed = [];
  let after = null;
  try {
    do {
      const page = await client.listPlannedProjectCandidates(domain.linear.team_id, { first, after });
      for (const candidate of page.candidates || []) {
        const result = await processPlannedProject({
          ...options,
          repoRoot,
          config,
          registry,
          domain,
          domainContext,
          client,
          candidate,
          emitStatus,
          state,
        });
        processed.push(result);
        if (result?.status === "rate_limited") {
          return {
            domainId: domain.id,
            status: "rate_limited",
            nextAttemptAt: result.nextAttemptAt,
            processed,
          };
        }
      }
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return {
      domainId: domain.id,
      status: "ok",
      processed,
    };
  } catch (error) {
    if (isRateLimitedError(options, error)) {
      return handleRateLimitedDomain({
        ...options,
        domainId: domain.id,
        projectId: null,
        error,
        emitStatus,
        state,
      });
    }
    throw error;
  }
}

export async function processPlannedProject(options = {}) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    domain,
    domainContext,
    client,
    candidate,
    project = null,
    idempotency = triggerIdempotency,
    runReplayProject = replayPendingMutation,
    runFreshProject = runFreshSyntheticWake,
    computeFingerprint = idempotency.computeTriggerFingerprint,
    emitStatus = createStatusEmitter(),
    state = gatewayState(options),
    now = () => new Date(),
  } = options;
  const projectId = candidate?.id || project?.id;
  if (!projectId) throw new Error("gateway_project_id_required");
  if (state.inFlight.has(projectId)) {
    return { action: "skipped", reason: "project_in_flight", projectId };
  }
  state.inFlight.add(projectId);

  try {
    const snapshot = project || await client.getProjectSnapshotContext(projectId);
    const fingerprint = computeFingerprint(snapshot);
    const decision = await decidePlannedProject({
      domainId: domain.id,
      projectId,
      fingerprint,
      repoRoot,
      runStoreDir,
      idempotency,
    });

    if (decision.action === "replay") {
      return await processReplayDecision({
        ...options,
        repoRoot,
        runStoreDir,
        domain,
        domainContext,
        client,
        projectId,
        pending: decision.replay,
        runReplayProject,
        emitStatus,
        state,
      });
    }

    if (decision.action === "suppress") {
      emitStatus({
        domainId: domain.id,
        projectId,
        state: "suppressed",
        reason: decision.suppression.reason,
        note: decision.suppression,
      });
      return {
        action: "suppress",
        projectId,
        fingerprint,
        suppression: decision.suppression,
      };
    }

    return await processFreshDecision({
      ...options,
      repoRoot,
      runStoreDir,
      domain,
      domainContext,
      client,
      projectId,
      fingerprint,
      runFreshProject,
      idempotency,
      emitStatus,
      state,
      now,
    });
  } catch (error) {
    if (isRateLimitedError(options, error)) {
      return handleRateLimitedDomain({
        ...options,
        domainId: domain.id,
        projectId,
        error,
        emitStatus,
        state,
      });
    }
    throw error;
  } finally {
    state.inFlight.delete(projectId);
  }
}

export async function decidePlannedProject({
  domainId,
  projectId,
  fingerprint,
  repoRoot = process.cwd(),
  runStoreDir = null,
  idempotency = triggerIdempotency,
} = {}) {
  const replay = await idempotency.readReplayPending({
    domainId,
    projectId,
    repoRoot,
    runStoreDir,
  });
  if (replay) {
    return {
      action: "replay",
      replay,
    };
  }

  const suppression = await idempotency.readSuppression({
    projectId,
    fingerprint,
    repoRoot,
    runStoreDir,
  });
  if (suppression) {
    return {
      action: "suppress",
      suppression,
    };
  }

  return { action: "fresh" };
}

export async function replayPendingMutation({
  client,
  config,
  cache,
  projectId,
  pending,
  domainContext,
  repoRoot = process.cwd(),
  runStoreDir = null,
  runDecompositionFn = runDecomposition,
  clearMutationIntent = triggerIdempotency.clearMutationIntent,
} = {}) {
  try {
    const result = await runDecompositionFn({
      client,
      // Replay must resolve the same Linear team as the fresh path. The raw config
      // carries only a placeholder team, so resolveLinearShape would throw
      // "Expected exactly one team, found 0"; merge the domain's team in (mirrors
      // runFreshSyntheticWake's configWithDomainLinearTeam).
      config: configWithDomainLinearTeam(config, domainContext),
      cache,
      projectId,
      runId: pending.runId,
      repoRoot,
      runStoreDir,
      retryCommit: true,
      domainContext,
      traceContext: {
        domain_id: domainContext?.domainId || pending.domainId,
        source_object_id: projectId,
        trigger_type: "linear.project.planned",
      },
    });
    if (TERMINAL_REPLAY_STATUSES.has(result?.status)) {
      await clearMutationIntent({
        domainId: pending.domainId,
        projectId,
        runId: pending.runId,
        repoRoot,
        runStoreDir,
      });
      return {
        action: "replay",
        status: "verified",
        cleared: true,
        result,
      };
    }
    return {
      action: "replay",
      status: "degraded",
      cleared: false,
      reason: result?.reason || result?.status || "replay_not_verified",
      result,
    };
  } catch (error) {
    if (isReplayScopeMismatch(error)) {
      return {
        action: "replay",
        status: "dead_letter",
        cleared: false,
        reason: error.message,
        error,
      };
    }
    if (isLinearRateLimited(error)) throw error;
    return {
      action: "replay",
      status: "degraded",
      cleared: false,
      reason: error.message || "replay_transient_error",
      error,
    };
  }
}

export async function runFreshSyntheticWake({
  config,
  repoRoot = process.cwd(),
  registry,
  domain,
  domainContext = buildDomainContext({ domain, config, repoRoot }),
  projectId,
  createStore = createLocalTriggerStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  runTriggeredDecompositionFn = runTriggeredDecomposition,
  createRuntimeExecutor = createProcessRuntimeExecutor,
} = {}) {
  const domainConfig = configWithDomainLinearTeam(config, domainContext);
  const cache = readLinearCache(domainContext.linear.cachePath);
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  const runnerId = `local-runner:${domainContext.domainId}`;
  const store = createStore({ repoRoot });
  const claim = await store.claimSyntheticWake({
    domainId: domainContext.domainId,
    workspaceId: domainContext.linear.workspaceId,
    teamId: domainContext.linear.teamId,
    projectId,
  });
  if (!claim.ok) {
    return {
      status: "failed_closed",
      reason: claim.reason || "synthetic_wake_claim_failed",
      claim,
    };
  }

  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const runtimeExecutor = createRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache),
    repoRoot,
  });
  const traceSink = createTraceSink({ repoRoot });
  try {
    return await runTriggeredDecompositionFn({
      store,
      runnerId,
      workspaceId: domainContext.linear.workspaceId,
      linearClientFactory: async () => createSetupGraphqlClient({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      }).client,
      config: domainConfig,
      cache,
      runtimeExecutor,
      repoRoot,
      leaseDurationMs: config?.runner?.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: config?.runner?.required_capabilities || DECOMPOSITION_REQUIRED_CAPABILITIES,
      traceSink,
      domainContext,
      registry,
      claim,
    });
  } finally {
    await traceSink.shutdown?.();
  }
}

export async function createGatewayLinearClient({
  config,
  repoRoot = process.cwd(),
  domainContext,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
} = {}) {
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  return createSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  }).client;
}

export function selectGatewayDomains({ registry, domainId = null } = {}) {
  const domains = registry?.domains || [];
  if (!domainId) return domains.filter((domain) => domain.status === "active");
  const domain = domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`domain_not_found: ${domainId}`);
  if (domain.status !== "active") {
    throw new Error(`domain_not_active: ${domainId} status=${domain.status || "unknown"}`);
  }
  return [domain];
}

export function gatewayState({ inFlight = null, domainBackoff = null } = {}) {
  return {
    inFlight: inFlight || new Set(),
    domainBackoff: domainBackoff || new Map(),
  };
}

function processReplayDecision(options = {}) {
  const {
    domain,
    domainContext,
    client,
    projectId,
    pending,
    runReplayProject,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    projectId,
    state: "replaying",
    reason: "mutation_intent_pending",
    runId: pending.runId,
    artifactKind: pending.artifactKind,
  });
  return runWithWedgedBackstop({
    ...options,
    domainId: domain.id,
    projectId,
    runId: pending.runId,
    artifactKind: pending.artifactKind,
    emitStatus,
    run: async () => {
      const replay = await runReplayProject({
        ...options,
        client,
        projectId,
        pending,
        domainContext,
      });
      if (replay.status === "verified") {
        return {
          action: "replay",
          projectId,
          pending,
          replay,
        };
      }
      emitStatus({
        domainId: domain.id,
        projectId,
        state: "degraded",
        reason: replay.reason || replay.status || "replay_not_verified",
        runId: pending.runId,
        artifactKind: pending.artifactKind,
      });
      return {
        action: replay.status === "dead_letter" ? "replay_dead_letter" : "replay_degraded",
        projectId,
        pending,
        replay,
      };
    },
    state,
  });
}

function processFreshDecision(options = {}) {
  const {
    domain,
    client,
    projectId,
    fingerprint,
    runFreshProject,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    projectId,
    state: "working",
    reason: "fresh_decomposition_selected",
  });
  return runWithWedgedBackstop({
    ...options,
    domainId: domain.id,
    projectId,
    emitStatus,
    run: async () => {
      const fresh = await runFreshProject({
        ...options,
        projectId,
      });
      if (isRateLimitedError(options, fresh?.error)) throw fresh.error;
      await maybeWriteFreshSuppression({
        ...options,
        domainId: domain.id,
        client,
        projectId,
        fingerprint,
        fresh,
      });
      return {
        action: "fresh",
        projectId,
        fingerprint,
        result: fresh,
      };
    },
    state,
  });
}

async function maybeWriteFreshSuppression(options = {}) {
  const {
    domainId,
    projectId,
    fingerprint,
    fresh,
    client,
    idempotency = triggerIdempotency,
    computeFingerprint = idempotency.computeTriggerFingerprint,
    repoRoot = process.cwd(),
    runStoreDir = null,
    now = () => new Date(),
  } = options;
  if (!shouldWriteSuppressionForFreshResult(fresh)) return null;
  let current;
  try {
    current = await client.getProjectSnapshotContext(projectId);
  } catch (error) {
    if (isRateLimitedError(options, error)) throw error;
    return null;
  }
  const currentFingerprint = computeFingerprint(current);
  if (currentFingerprint !== fingerprint) return null;
  if (current?.status?.type !== "planned") return null;
  return idempotency.writeSuppression({
    domainId,
    projectId,
    fingerprint,
    runId: runIdForFreshResult(fresh),
    terminalStatus: fresh.status || fresh.result?.status || "rejected",
    reason: fresh.reason || fresh.result?.reason || "rejected",
    createdAt: toDate(now()).toISOString(),
    repoRoot,
    runStoreDir,
  });
}

async function drainReplayPendingForDomain(options = {}) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    config,
    domain,
    idempotency = triggerIdempotency,
    createLinearClient,
    runReplayProject,
    emitStatus,
    state,
  } = options;
  const pending = await idempotency.listReplayPending({
    domainId: domain.id,
    repoRoot,
    runStoreDir,
  });
  if (pending.length === 0) return [];

  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const client = await createLinearClient({ config, repoRoot, domain, domainContext });
  const results = [];
  for (const item of pending) {
    if (state.inFlight.has(item.projectId)) {
      results.push({ action: "skipped", reason: "project_in_flight", pending: item });
      continue;
    }
    state.inFlight.add(item.projectId);
    try {
      results.push(await processReplayDecision({
        ...options,
        repoRoot,
        domain,
        domainContext,
        client,
        projectId: item.projectId,
        pending: item,
        runReplayProject,
        emitStatus,
        state,
      }));
    } catch (error) {
      if (isRateLimitedError(options, error)) {
        results.push(handleRateLimitedDomain({
          ...options,
          domainId: domain.id,
          projectId: item.projectId,
          error,
          emitStatus,
          state,
        }));
        break;
      }
      throw error;
    } finally {
      state.inFlight.delete(item.projectId);
    }
  }
  return results;
}

async function runWithWedgedBackstop({
  domainId,
  projectId,
  runId = null,
  artifactKind = null,
  run,
  emitStatus,
  runTimeoutMs = DEFAULT_GATEWAY_RUN_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  let timer = null;
  if (Number.isFinite(runTimeoutMs) && runTimeoutMs > 0) {
    timer = setTimeout(() => {
      emitStatus({
        domainId,
        projectId,
        state: "wedged",
        reason: "run_wall_clock_timeout",
        runId,
        artifactKind,
        observedAt: toDate(now()).toISOString(),
      });
    }, runTimeoutMs);
    timer.unref?.();
  }
  try {
    return await run();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function handleRateLimitedDomain(options = {}) {
  const {
    domainId,
    projectId = null,
    error,
    emitStatus,
    state,
  } = options;
  const resetAt = rateLimitResetAt(options, error);
  state.domainBackoff.set(domainId, resetAt);
  emitStatus({
    domainId,
    projectId,
    state: "rate_limited",
    reason: "linear_rate_limited",
    nextAttemptAt: resetAt,
    rateLimit: error?.rateLimit || null,
  });
  return {
    domainId,
    projectId,
    status: "rate_limited",
    nextAttemptAt: resetAt,
    error,
  };
}

function emitResumeReconciliationStatus({ report, emitStatus }) {
  for (const item of report?.items || []) {
    emitStatus({
      domainId: null,
      projectId: null,
      state: item.pm_state === "Working" ? "resume_working" : "resume_attention",
      reason: item.reason,
      ref: item.ref,
      source: item.source,
      classification: item.classification,
      pmState: item.pm_state,
      detail: item.detail ?? null,
    });
  }
}

function createStatusEmitter({ onStatus = null } = {}) {
  return (event) => {
    const normalized = normalizeStatusEvent(event);
    onStatus?.(normalized);
    return normalized;
  };
}

function normalizeStatusEvent(event = {}) {
  const state = event.state;
  if (!STATUS_STATES.has(state)) throw new Error(`invalid_gateway_status_state:${state || "missing"}`);
  return {
    domainId: event.domainId ?? null,
    projectId: event.projectId ?? null,
    state,
    reason: event.reason || null,
    nextAttemptAt: event.nextAttemptAt ?? null,
    ...stripUndefined(event),
  };
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function shouldWriteSuppressionForFreshResult(result) {
  if (result?.status !== "rejected") return false;
  const reason = String(result.reason || result.result?.reason || "");
  if (reason.startsWith("runner_failed_closed:")) return false;
  if (reason.startsWith("runner_failed_after_linear_mutation_started:")) return false;
  if (result.error && !result.eligibility && result.result?.status !== "ineligible") return false;
  return true;
}

function runIdForFreshResult(result) {
  return (
    result?.wake?.run_id ||
    result?.run?.run_id ||
    result?.traceDelivery?.receipt?.run_id ||
    result?.result?.artifact?.run_id ||
    result?.result?.trace?.attributes?.run_id ||
    null
  );
}

function isReplayScopeMismatch(error) {
  const message = String(error?.message || "");
  return (
    message.includes(ARTIFACT_DOMAIN_MISMATCH_REASON) ||
    message.includes(ARTIFACT_PROJECT_MISMATCH_REASON)
  );
}

function isRateLimitedError(options = {}, error) {
  const checker = options.isRateLimited || isLinearRateLimited;
  return checker(error);
}

function rateLimitResetAt(options = {}, error) {
  const now = timeMs(options.now);
  const fallback = now + pollIntervalMs(options);
  const resetAt = Number(error?.rateLimit?.resetAt);
  if (!Number.isFinite(resetAt) || resetAt <= now) return fallback;
  return resetAt;
}

function pollIntervalMs({ config, pollIntervalMs: configured } = {}) {
  return Math.max(1, Number(configured || config?.poll?.interval_ms || 10_000));
}

function timeMs(now = () => new Date()) {
  return toDate(typeof now === "function" ? now() : now).getTime();
}

function tryCreateGatewayLock({ lockPath, token, createdAt }) {
  let fd = null;
  try {
    fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({
      pid: process.pid,
      token,
      created_at: createdAt,
    })}\n`, "utf8");
    fs.closeSync(fd);
    fd = null;
    return { ok: true };
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    return { ok: false, error };
  }
}

function gatewayLockHandle({ lockPath, token, installHandlers }) {
  const handlers = [];
  let released = false;
  const release = ({ removeHandlers = true } = {}) => {
    if (released) return;
    released = true;
    removeGatewayLockIfTokenMatches({ lockPath, token });
    if (removeHandlers) {
      for (const [event, handler] of handlers) process.off(event, handler);
    }
  };

  if (installHandlers) {
    const onExit = () => release({ removeHandlers: false });
    const onSigint = () => {
      release({ removeHandlers: false });
      process.exit(130);
    };
    const onSigterm = () => {
      release({ removeHandlers: false });
      process.exit(143);
    };
    process.once("exit", onExit);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    handlers.push(["exit", onExit], ["SIGINT", onSigint], ["SIGTERM", onSigterm]);
  }

  return {
    ok: true,
    lockPath,
    token,
    release,
  };
}

function readGatewayLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function gatewayLockBreakReason({ lock, isProcessAlive }) {
  if (!lock || typeof lock !== "object") return "invalid_lock_file";
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "invalid_pid";
  const createdAt = Date.parse(lock.created_at);
  if (!Number.isFinite(createdAt)) return "invalid_created_at";
  if (!isProcessAlive(pid)) return `dead_pid:${pid}`;
  return null;
}

function removeGatewayLockIfTokenMatches({ lockPath, token }) {
  const current = readGatewayLock(lockPath);
  if (token && current?.token !== token) return false;
  if (!token && current?.token) return false;
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return true;
  }
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function defaultSleep(ms, { signal = null } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
