import { createHash, randomUUID } from "node:crypto";
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
import { createTrace, recordSpan } from "./trace.mjs";
import {
  createLocalTriggerStore,
  resolveDriverSessionHandle,
  runIsResumable,
} from "./local-trigger-store.mjs";
import { collectNextResumeReconciliation } from "./local-supervisor.mjs";
import {
  resolveInReviewIssueStatus,
  resolveIssueStatuses,
} from "./linear/shape-resolver.mjs";
import { issueNeedsPrincipalEscalationEffect } from "./linear/issue-needs-principal-effect.mjs";
import { knownTraceAttributes } from "./linear/matching-utils.mjs";
import {
  readRuntimeSmokeCache,
  runtimeVersionsFromRuntimeSmokeCache,
  runtimeSmokeCachePath,
  smokeTestsFromRuntimeSmokeCache,
} from "./runtime-smoke.mjs";
import {
  createProcessRuntimeExecutor,
  runTriggeredDecomposition,
  runTriggeredExecution,
  runTriggeredReview,
} from "./trigger-runner.mjs";
import {
  ARTIFACT_DOMAIN_MISMATCH_REASON,
  ARTIFACT_PROJECT_MISMATCH_REASON,
  runDecomposition,
} from "./linear-service.mjs";
import * as triggerIdempotency from "./trigger-idempotency.mjs";
import { materializeDomainResources } from "../../../engine/materialize.mjs";
import {
  defaultRunGit,
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";
import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import { DECOMPOSITION_REQUIRED_CAPABILITIES } from "./workflows/decomposition/definition.mjs";
import { readRunArtifact } from "../../../engine/run-store.mjs";
import {
  executionDefinition,
  EXECUTION_REQUIRED_CAPABILITIES,
  EXECUTION_WORKFLOW_TYPE,
} from "./workflows/execution/definition.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "./workflows/execution/effect-ids.mjs";
import { isReadyIssueEligible } from "./workflows/execution/eligibility.mjs";
import {
  hydrateReviewState,
  locatePullRequestForProducedIdentity,
  locatePullRequestForIssue,
  resourcesToRepoIdentity,
} from "./review-pr-discovery.mjs";
import { parseResourceTargetFromDescription } from "./resource-target.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  createDefaultExecutionPullRequestAdapter,
  lookupAfReviewCommentByMarker,
  parseAfReviewCommentMarker,
} from "./execution-pr-adapter.mjs";
import {
  REVIEW_REQUIRED_CAPABILITIES,
  REVIEW_WORKFLOW_TYPE,
} from "./workflows/review/definition.mjs";

export const GATEWAY_LOCK_RELATIVE_PATH = path.join(".teami", "gateway.lock");
export const DEFAULT_GATEWAY_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const RESUME_CRASH_SAFETY_FOLLOW_UP =
  "Verify resume crash-safety in the poll model, or extend the replay gate to resume.";

const DEFAULT_CANDIDATE_PAGE_SIZE = 25;
const TERMINAL_REPLAY_STATUSES = new Set(["completed", "paused"]);
const EXECUTION_READY_TRIGGER_TYPE = "linear.issue.ready";
const REVIEW_IN_REVIEW_TRIGGER_TYPE = "linear.issue.in_review";
const REVIEW_PR_CREATION_GRACE_MS = 5 * 60 * 1000;
const READY_FIX_REVIEW_DISPOSITION = "request-changes";
export const DEFAULT_READY_FIX_MAX_AUTONOMOUS_ROUNDS = 99;
const READY_FIX_FAILURE_REVIEW_DISPOSITIONS = new Set(["request-changes", "escalate"]);
export const READY_ISSUE_SUPPRESSIBLE_REASONS = Object.freeze(new Set([
  "git_repo_empty_diff",
  "git_repo_diff_over_budget_changed_files",
  "git_repo_diff_over_budget_total_bytes",
  "git_repo_diff_over_budget_deletion_ratio",
]));
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

const pollTargetRegistry = [];

export function registerPollTarget(descriptor) {
  assertPollTargetDescriptor(descriptor);
  pollTargetRegistry.push(descriptor);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const index = pollTargetRegistry.indexOf(descriptor);
    if (index !== -1) pollTargetRegistry.splice(index, 1);
  };
}

export function gatewayPollTargets() {
  return [...pollTargetRegistry];
}

export function replaceGatewayPollTargetsForTest(descriptors) {
  const previous = gatewayPollTargets();
  pollTargetRegistry.splice(0, pollTargetRegistry.length);
  for (const descriptor of descriptors) registerPollTarget(descriptor);
  return () => {
    pollTargetRegistry.splice(0, pollTargetRegistry.length);
    for (const descriptor of previous) registerPollTarget(descriptor);
  };
}

const PLANNED_PROJECT_POLL_TARGET = {
  input_status: "Planned",
  listCandidates: listPlannedProjectCandidates,
  process: processPlannedProjectCandidate,
  inFlightKey: plannedProjectInFlightKey,
  order: preserveCandidateOrder,
};

registerPollTarget(PLANNED_PROJECT_POLL_TARGET);

const ISSUE_REPLAY_MARKER_SWEEP_TARGET = {
  input_status: "Execution Marker Sweep",
  listCandidates: listIssueReplayMarkers,
  process: processIssueReplayMarker,
  inFlightKey: issueReplayMarkerInFlightKey,
  order: preserveCandidateOrder,
};

registerPollTarget(ISSUE_REPLAY_MARKER_SWEEP_TARGET);

const READY_ISSUE_POLL_TARGET = {
  input_status: "Ready",
  listCandidates: listReadyIssueCandidates,
  process: processReadyIssueCandidate,
  inFlightKey: readyIssueInFlightKey,
  order: oldestReadyIssueFirst,
};

registerPollTarget(READY_ISSUE_POLL_TARGET);

const IN_PROGRESS_ISSUE_POLL_TARGET = {
  input_status: "In Progress",
  listCandidates: listInProgressIssueCandidates,
  process: processInProgressIssueCandidate,
  inFlightKey: readyIssueInFlightKey,
  order: oldestReadyIssueFirst,
};

registerPollTarget(IN_PROGRESS_ISSUE_POLL_TARGET);

const IN_REVIEW_ISSUE_POLL_TARGET = {
  input_status: "In Review",
  listCandidates: listInReviewIssueCandidates,
  process: processInReviewIssueCandidate,
  inFlightKey: inReviewIssueInFlightKey,
  order: oldestInReviewIssueFirst,
};

registerPollTarget(IN_REVIEW_ISSUE_POLL_TARGET);

export function gatewayLockPath(repoRoot = process.cwd()) {
  return path.join(repoRoot, GATEWAY_LOCK_RELATIVE_PATH);
}

// Read-only gateway-lock liveness for the home screen / `gateway status` surfaces. It NEVER
// acquires, writes, or breaks the lock — it only reports whether a live gateway currently holds
// `.teami/gateway.lock`. A lock is "live" when it parses, names a valid pid +
// created_at, and that pid is still alive (gatewayLockBreakReason === null); a missing, malformed,
// or stale lock reports live:false. This is the reader S4 keys "listening" off of.
export function readGatewayLockLiveness({
  repoRoot = process.cwd(),
  lockPath = gatewayLockPath(repoRoot),
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  const lock = readGatewayLock(lockPath);
  if (!lock) return { present: false, live: false, breakReason: "missing_lock_file", lock: null };
  const breakReason = gatewayLockBreakReason({ lock, isProcessAlive });
  return { present: true, live: breakReason === null, breakReason, lock };
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
  const cache = readLinearCache(domainContext.linear.cachePath);
  const client = await createLinearClient({ config, repoRoot, domain, domainContext });
  const processed = [];
  const domainCtx = {
    ...options,
    repoRoot,
    config,
    registry,
    domain,
    domainContext,
    cache,
    client,
    emitStatus,
    state,
  };
  try {
    for (const descriptor of gatewayPollTargets()) {
      let after = null;
      do {
        const page = await descriptor.listCandidates(domainCtx, { first, after });
        for (const candidate of orderPollCandidates(page.candidates || [], descriptor.order)) {
          const result = await descriptor.process(candidate, domainCtx);
          const processedResult = withProcessedCandidateProjectId(result, candidate, domainCtx.pollScope);
          processed.push(processedResult);
          if (processedResult?.status === "rate_limited") {
            return {
              domainId: domain.id,
              status: "rate_limited",
              nextAttemptAt: processedResult.nextAttemptAt,
              processed,
            };
          }
        }
        after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
    }
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

export async function listPlannedProjectCandidates(domainCtx, page = {}) {
  const {
    domain,
    client,
    cache,
  } = domainCtx;
  const {
    first = DEFAULT_CANDIDATE_PAGE_SIZE,
    after = null,
  } = page;
  assertValidPollScope(domainCtx.pollScope);
  const plannedStateId = cache?.projectStatuses?.planned || null;
  const candidatePage = await client.listPlannedProjectCandidates(domain.linear.team_id, {
    ...(plannedStateId ? { plannedStateId } : {}),
    first,
    after,
  });
  return applyPollScopeToPage(candidatePage, domainCtx.pollScope, (candidate) => candidate?.id);
}

function processPlannedProjectCandidate(candidate, domainCtx) {
  const {
    repoRoot,
    config,
    registry,
    domain,
    domainContext,
    client,
    emitStatus,
    state,
  } = domainCtx;
  return processPlannedProject({
    ...domainCtx,
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
}

function plannedProjectInFlightKey(candidate) {
  return candidate?.id || null;
}

function preserveCandidateOrder() {
  return 0;
}

export async function listIssueReplayMarkers(domainCtx, _page = {}) {
  const {
    domain,
    repoRoot = process.cwd(),
    runStoreDir = null,
    idempotency = triggerIdempotency,
  } = domainCtx;
  if (typeof idempotency.listGitReplayPending !== "function") {
    return {
      candidates: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  return {
    candidates: await idempotency.listGitReplayPending({
      domainId: domain.id,
      repoRoot,
      runStoreDir,
    }),
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

async function processIssueReplayMarker(marker, domainCtx) {
  return sweepIssueReplayMarker({
    ...domainCtx,
    marker,
  });
}

function issueReplayMarkerInFlightKey(marker) {
  return marker?.objectId || null;
}

export async function sweepIssueReplayMarker(options = {}) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    domain,
    client,
    marker,
    idempotency = triggerIdempotency,
  } = options;
  const issueId = marker?.objectId;
  if (!issueId) return { action: "marker_sweep", status: "skipped", reason: "issue_id_missing", marker };

  const issue = await client.getIssueContext(issueId);
  if (issue?.state?.type !== "completed") {
    return {
      action: "marker_sweep",
      status: "retained",
      issueId,
      runId: marker.runId,
      stateType: issue?.state?.type || null,
    };
  }

  const cleared = await idempotency.clearMutationIntent({
    domainId: domain.id,
    objectType: "issue",
    objectId: issueId,
    runId: marker.runId,
    repoRoot,
    runStoreDir,
  });
  return {
    action: "marker_sweep",
    status: cleared?.cleared ? "cleared" : "already_clear",
    issueId,
    runId: marker.runId,
    cleared,
  };
}

export async function listReadyIssueCandidates(domainCtx, page = {}) {
  const {
    domain,
    client,
  } = domainCtx;
  const {
    first = DEFAULT_CANDIDATE_PAGE_SIZE,
    after = null,
  } = page;
  assertValidPollScope(domainCtx.pollScope);
  const readyStateId = await issueStatusIdForPollRole(domainCtx, "todo");
  if (!readyStateId) {
    return applyPollScopeToPage(
      {
        candidates: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      domainCtx.pollScope,
      candidateProjectId,
    );
  }
  const candidatePage = await client.listReadyIssueCandidates(domain.linear.team_id, { readyStateId, first, after });
  return applyPollScopeToPage(candidatePage, domainCtx.pollScope, candidateProjectId);
}

function processReadyIssueCandidate(candidate, domainCtx) {
  const {
    repoRoot,
    config,
    registry,
    domain,
    domainContext,
    client,
    emitStatus,
    state,
  } = domainCtx;
  return processReadyIssue({
    ...domainCtx,
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
}

function readyIssueInFlightKey(candidate) {
  return candidate?.id || null;
}

export function oldestReadyIssueFirst(a, b) {
  return (
    compareCreatedAt(a?.createdAt, b?.createdAt) ||
    String(a?.id || "").localeCompare(String(b?.id || ""))
  );
}

async function processInProgressIssueCandidate(candidate, domainCtx) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    config = null,
    registry,
    domain,
    domainContext,
    cache,
    client,
    emitStatus = createStatusEmitter(),
    state = gatewayState(domainCtx),
    runDeps = null,
    store = null,
  } = domainCtx;
  const issueId = candidate?.id;
  if (!issueId) return { action: "skipped", reason: "issue_id_missing" };
  if (state.inFlight.has(issueId)) {
    return {
      action: "skipped",
      reason: "issue_in_flight",
      issueId,
    };
  }

  const readyStore = store || runDeps?.store || createLocalTriggerStore({ repoRoot });
  const priorRun = latestExecutionRunForReadyFix({ store: readyStore, issueId });
  if (await latestExecutionWakeLeaseIsLive({
    store: readyStore,
    run: priorRun,
    now: domainCtx.now,
  })) {
    return {
      action: "skipped",
      reason: "execution_wake_live",
      issueId,
      priorRunId: stringOrNull(priorRun?.run_id || priorRun?.runId),
      wakeId: stringOrNull(priorRun?.wake_id || priorRun?.wakeId),
    };
  }

  const duplicateInFlight = state.inFlight.has(issueId);
  if (!tryEnterInFlight(state, issueId)) {
    return {
      action: "skipped",
      reason: duplicateInFlight ? "issue_in_flight" : "max_in_flight",
      issueId,
    };
  }

  let dispatchLaunched = false;
  try {
    const issueContext = candidate?.identifier && candidate?.state
      ? candidate
      : await client.getIssueContext(issueId);
    const decision = await decideReadyIssueFixMode({
      issueId,
      issueContext,
      domainContext,
      config,
      repoRoot,
      runStoreDir,
      store: readyStore,
      prAdapter: runDeps?.prAdapter || null,
      createPrAdapter: runDeps?.createPrAdapter || null,
      resolveSessionHandle: domainCtx.resolveSessionHandle,
      isRunResumable: domainCtx.isRunResumable,
      maxAutonomousFixRounds: domainCtx.maxAutonomousFixRounds,
      allowColdReconstruct: true,
    }) || readyFixEscalationDecision({
      reason: "ready_fix_prior_run_missing",
      priorRun,
      priorRunId: stringOrNull(priorRun?.run_id || priorRun?.runId),
    });

    if (decision.action === "warm_resume") {
      dispatchLaunched = true;
      return processWarmResumeIssueDecision({
        ...domainCtx,
        repoRoot,
        runStoreDir,
        registry,
        domain,
        domainContext,
        client,
        issueId,
        issueContext,
        decision,
        runWarmResumeIssue: domainCtx.runWarmResumeIssue || runWarmResumeIssueSyntheticWake,
        emitStatus,
        state,
        store: readyStore,
      });
    }

    const escalation = await applyReadyIssueNeedsPrincipalEscalation({
      client,
      config,
      cache,
      issueId,
      issueContext,
      domainContext,
      decision,
    });
    emitStatus({
      domainId: domain.id,
      issueId,
      state: "resume_attention",
      reason: decision.reason,
      note: { decision, escalation },
    });
    return {
      action: "escalate",
      reason: decision.reason,
      issueId,
      decision,
      escalation,
    };
  } catch (error) {
    if (isRateLimitedError(domainCtx, error)) {
      return handleRateLimitedDomain({
        ...domainCtx,
        domainId: domain.id,
        projectId: null,
        error,
        emitStatus,
        state,
      });
    }
    throw error;
  } finally {
    if (!dispatchLaunched) state.inFlight.delete(issueId);
  }
}

export async function listInReviewIssueCandidates(domainCtx, page = {}) {
  const {
    config,
    domain,
    client,
    cache,
  } = domainCtx;
  const {
    first = DEFAULT_CANDIDATE_PAGE_SIZE,
    after = null,
  } = page;
  assertValidPollScope(domainCtx.pollScope);
  if (!config?.linear?.issue?.statuses?.in_review?.name) {
    return applyPollScopeToPage(
      {
        candidates: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      domainCtx.pollScope,
      candidateProjectId,
    );
  }
  const inReviewStatus = cache?.issueStatuses?.in_review
    ? { id: cache.issueStatuses.in_review, targetType: "status" }
    : await resolveInReviewIssueStatus(client, config, domain.linear.team_id, cache);
  const inReviewStateId = inReviewStatus?.targetType === "status" ? inReviewStatus.id : null;
  if (!inReviewStateId) {
    return applyPollScopeToPage(
      {
        candidates: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      domainCtx.pollScope,
      candidateProjectId,
    );
  }
  const candidatePage = await client.listReadyIssueCandidates(domain.linear.team_id, {
    readyStateId: inReviewStateId,
    first,
    after,
  });
  return applyPollScopeToPage(candidatePage, domainCtx.pollScope, candidateProjectId);
}

export async function listInProgressIssueCandidates(domainCtx, page = {}) {
  const {
    domain,
    client,
    cache,
  } = domainCtx;
  const {
    first = DEFAULT_CANDIDATE_PAGE_SIZE,
    after = null,
  } = page;
  assertValidPollScope(domainCtx.pollScope);
  const inProgressStateId = cache?.issueStatuses?.in_progress || null;
  if (!inProgressStateId) {
    return applyPollScopeToPage(
      {
        candidates: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      domainCtx.pollScope,
      candidateProjectId,
    );
  }
  const candidatePage = await client.listReadyIssueCandidates(domain.linear.team_id, {
    readyStateId: inProgressStateId,
    first,
    after,
  });
  return applyPollScopeToPage(candidatePage, domainCtx.pollScope, candidateProjectId);
}

async function issueStatusIdForPollRole(domainCtx, role) {
  const {
    config,
    domain,
    client,
    cache,
  } = domainCtx;
  const cachedId = cache?.issueStatuses?.[role] || null;
  if (cachedId) return cachedId;
  const issueStatuses = await resolveIssueStatuses(client, config, domain.linear.team_id, cache);
  return issueStatuses[role]?.id || null;
}

function processInReviewIssueCandidate(candidate, domainCtx) {
  const {
    repoRoot,
    config,
    registry,
    domain,
    domainContext,
    client,
    emitStatus,
    state,
  } = domainCtx;
  return processReviewIssue({
    ...domainCtx,
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
}

function inReviewIssueInFlightKey(candidate) {
  return candidate?.id || null;
}

export function oldestInReviewIssueFirst(a, b) {
  return oldestReadyIssueFirst(a, b);
}

function orderPollCandidates(candidates, order) {
  return [...candidates].sort(order);
}

function applyPollScopeToPage(page, pollScope, getProjectId) {
  const candidates = page?.candidates || [];
  const scopedCandidates = applyPollScope(candidates, pollScope, getProjectId);
  if (scopedCandidates === candidates) return page;
  return {
    ...page,
    candidates: scopedCandidates,
  };
}

function applyPollScope(candidates, pollScope, getProjectId) {
  const projectIds = normalizePollScopeProjectIds(pollScope);
  if (projectIds === null) return candidates;
  if (projectIds.length === 0) return [];
  const allowedProjectIds = new Set(projectIds);
  return candidates.filter((candidate) => allowedProjectIds.has(getProjectId(candidate)));
}

function assertValidPollScope(pollScope) {
  normalizePollScopeProjectIds(pollScope);
}

function normalizePollScopeProjectIds(pollScope) {
  if (pollScope === null || pollScope === undefined) return null;
  if (typeof pollScope !== "object" || Array.isArray(pollScope)) {
    throw new Error("invalid_poll_scope: pollScope must be an object with projectIds.");
  }
  const { projectIds } = pollScope;
  if (projectIds === null) return null;
  if (!Array.isArray(projectIds) || projectIds.some((projectId) => typeof projectId !== "string")) {
    throw new Error("invalid_poll_scope: pollScope.projectIds must be an array of strings or null.");
  }
  return projectIds;
}

function withProcessedCandidateProjectId(result, candidate, pollScope) {
  // Only annotate the scope id when a poll scope is ACTIVE. Unscoped runs keep their exact
  // processed shape (backward-compatible with existing callers/tests); E4 always scopes, so it
  // gets the projectId its scope verification reads. Under an active scope every processed
  // candidate has already passed the descriptor filter, so its scope id is meaningful.
  if (normalizePollScopeProjectIds(pollScope) === null) return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (typeof result.projectId === "string") return result;
  // Issue candidates expose the parent project via .projectId; Planned-project candidates ARE
  // the project, so fall back to .id — keeps processed[].projectId uniformly populated for E4.
  const projectId = candidateProjectId(candidate) ?? (typeof candidate?.id === "string" ? candidate.id : null);
  if (!projectId) return result;
  return {
    ...result,
    projectId,
  };
}

function candidateProjectId(candidate) {
  if (typeof candidate?.projectId === "string") return candidate.projectId;
  return null;
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
  if (!tryEnterInFlight(state, projectId)) {
    return { action: "skipped", reason: "project_in_flight", projectId };
  }

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

export async function processReadyIssue(options = {}) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    config = null,
    cache = null,
    domain,
    domainContext,
    client,
    candidate,
    issue = null,
    idempotency = triggerIdempotency,
    runReplayIssue = replayPendingExecutionIssue,
    runFreshIssue = runFreshIssueSyntheticWake,
    runWarmResumeIssue = runWarmResumeIssueSyntheticWake,
    computeFingerprint = computeIssueTriggerFingerprint,
    emitStatus = createStatusEmitter(),
    state = gatewayState(options),
    runDeps = null,
    store = null,
    createTraceSink = createLocalPhoenixTraceSink,
    traceSink = null,
  } = options;
  const issueId = candidate?.id || issue?.id;
  if (!issueId) throw new Error("gateway_issue_id_required");
  const duplicateInFlight = state.inFlight.has(issueId);
  if (!tryEnterInFlight(state, issueId)) {
    return {
      action: "skipped",
      reason: duplicateInFlight ? "issue_in_flight" : "max_in_flight",
      issueId,
    };
  }

  let dispatchLaunched = false;
  let readyEligibilityTraceSink = null;
  let shouldShutdownReadyEligibilityTraceSink = false;
  try {
    const issueContext = issue || await client.getIssueContext(issueId);
    const fingerprint = computeFingerprint(issueContext);
    const readyStore = store || runDeps?.store || createLocalTriggerStore({ repoRoot });
    readyEligibilityTraceSink = traceSink || createReadyEligibilityTraceSink({ createTraceSink, repoRoot });
    shouldShutdownReadyEligibilityTraceSink = !traceSink && Boolean(readyEligibilityTraceSink);
    const decision = await decideReadyIssue({
      domainId: domain.id,
      issueId,
      issueContext,
      domainContext,
      config,
      cache,
      fingerprint,
      repoRoot,
      runStoreDir,
      idempotency,
      store: readyStore,
      prAdapter: runDeps?.prAdapter || null,
      createPrAdapter: runDeps?.createPrAdapter || null,
      resolveSessionHandle: options.resolveSessionHandle,
      traceSink: readyEligibilityTraceSink,
    });

    if (decision.action === "replay") {
      dispatchLaunched = true;
      return processReplayIssueDecision({
        ...options,
        repoRoot,
        runStoreDir,
        domain,
        domainContext,
        client,
        issueId,
        issueContext,
        pending: decision.replay,
        runReplayIssue,
        emitStatus,
        state,
      });
    }

    if (decision.action === "warm_resume") {
      dispatchLaunched = true;
      return processWarmResumeIssueDecision({
        ...options,
        repoRoot,
        runStoreDir,
        domain,
        domainContext,
        client,
        issueId,
        issueContext,
        decision,
        runWarmResumeIssue,
        emitStatus,
        state,
      });
    }

    if (decision.action === "suppress") {
      emitStatus({
        domainId: domain.id,
        issueId,
        state: "suppressed",
        reason: decision.suppression.reason,
        note: decision.suppression,
      });
      return {
        action: "suppress",
        issueId,
        fingerprint,
        suppression: decision.suppression,
      };
    }

    if (decision.action === "escalate") {
      const escalation = await applyReadyIssueNeedsPrincipalEscalation({
        client,
        config,
        cache,
        issueId,
        issueContext,
        domainContext,
        decision,
      });
      emitStatus({
        domainId: domain.id,
        issueId,
        state: "resume_attention",
        reason: decision.reason,
        note: { decision, escalation },
      });
      return {
        action: "escalate",
        reason: decision.reason,
        issueId,
        fingerprint,
        decision,
        escalation,
      };
    }

    if (decision.action === "dependency_blocked") {
      return {
        action: "skipped",
        reason: "dependency_blocked",
        issueId,
        fingerprint,
        blockingIssueIds: decision.blockingIssueIds,
        eligibility: decision.eligibility,
      };
    }

    if (decision.action === "skip") {
      return {
        action: "skipped",
        reason: decision.reason,
        issueId,
        fingerprint,
        eligibility: decision.eligibility,
      };
    }

    dispatchLaunched = true;
    return processFreshIssueDecision({
      ...options,
      repoRoot,
      runStoreDir,
      domain,
      domainContext,
      client,
      issueId,
      issueContext,
      fingerprint,
      runFreshIssue,
      idempotency,
      emitStatus,
      state,
    });
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
  } finally {
    if (shouldShutdownReadyEligibilityTraceSink) await readyEligibilityTraceSink.shutdown?.();
    if (!dispatchLaunched) state.inFlight.delete(issueId);
  }
}

export async function processReviewIssue(options = {}) {
  const {
    repoRoot = process.cwd(),
    runStoreDir = null,
    domain,
    domainContext,
    client,
    candidate,
    issue = null,
    runFreshReview = runFreshReviewSyntheticWake,
    emitStatus = createStatusEmitter(),
    state = gatewayState(options),
    runDeps = null,
    store = null,
  } = options;
  const issueId = candidate?.id || issue?.id;
  if (!issueId) throw new Error("gateway_issue_id_required");
  const duplicateInFlight = state.inFlight.has(issueId);
  if (!tryEnterInFlight(state, issueId)) {
    return {
      action: "skipped",
      reason: duplicateInFlight ? "issue_in_flight" : "max_in_flight",
      issueId,
    };
  }

  let dispatchLaunched = false;
  try {
    const issueContext = issue || await client.getIssueContext(issueId);
    const reviewStore = store || runDeps?.store || createLocalTriggerStore({ repoRoot });
    const decision = await decideReviewIssue({
      domainId: domain.id,
      issueId,
      issueContext,
      domainContext,
      repoRoot,
      runStoreDir,
      store: reviewStore,
      prAdapter: runDeps?.prAdapter || null,
      createPrAdapter: runDeps?.createPrAdapter || null,
      now: options.now,
    });

    if (decision.action === "skip" || decision.action === "wait") {
      return {
        action: "skipped",
        reason: decision.reason,
        issueId,
        decision,
      };
    }

    dispatchLaunched = true;
    return processReviewDecision({
      ...options,
      repoRoot,
      runStoreDir,
      domain,
      domainContext,
      client,
      issueId,
      issueContext,
      decision,
      runFreshReview,
      emitStatus,
      state,
      store: reviewStore,
    });
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
  } finally {
    if (!dispatchLaunched) state.inFlight.delete(issueId);
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

export async function decideReadyIssue({
  domainId,
  issueId,
  issueContext,
  domainContext = null,
  config = null,
  cache = null,
  fingerprint,
  repoRoot = process.cwd(),
  runStoreDir = null,
  idempotency = triggerIdempotency,
  store = null,
  repoIdentity = null,
  prAdapter = null,
  createPrAdapter = null,
  locatePr = locatePullRequestForIssue,
  resolveSessionHandle = resolveDriverSessionHandle,
  isRunResumable = runIsResumable,
  maxAutonomousFixRounds = null,
  traceSink = null,
} = {}) {
  const fixMode = await decideReadyIssueFixMode({
    issueId,
    issueContext,
    domainContext,
    config,
    repoIdentity,
    repoRoot,
    runStoreDir,
    store,
    prAdapter,
    createPrAdapter,
    locatePr,
    resolveSessionHandle,
    isRunResumable,
    maxAutonomousFixRounds,
  });
  if (fixMode) return fixMode;

  const replay = typeof idempotency.readGitReplayPending === "function"
    ? await idempotency.readGitReplayPending({
        domainId,
        objectId: issueId,
        repoRoot,
        runStoreDir,
      })
    : null;
  if (replay) {
    return {
      action: "replay",
      replay,
    };
  }

  const eligibilityOptions = readyIssueEligibilityOptions({
    config,
    cache,
    allowedRepoPacket: domainContext?.allowedRepoPacket,
  });
  const eligibility = isReadyIssueEligible(issueContext, eligibilityOptions);
  await emitReadyIssueEligibilityTrace({
    traceSink,
    domainId,
    issueId,
    domainContext,
    eligibility,
  }).catch(() => null);
  if (!eligibility.eligible) {
    if (eligibility.ineligibleReason) {
      return {
        action: "skip",
        reason: eligibility.ineligibleReason,
        eligibility,
      };
    }
    if (eligibility.blockingIssueIds.length > 0) {
      return {
        action: "dependency_blocked",
        reason: "dependency_blocked",
        blockingIssueIds: eligibility.blockingIssueIds,
        eligibility,
      };
    }
    return {
      action: "skip",
      reason: issueContext?.state?.id === eligibilityOptions.todoStateId
        ? "issue_not_eligible"
        : "issue_not_ready",
      eligibility,
    };
  }

  const suppression = typeof idempotency.readSuppression === "function"
    ? await idempotency.readSuppression({
        objectType: "issue",
        objectId: issueId,
        fingerprint,
        repoRoot,
        runStoreDir,
      })
    : null;
  if (suppression) {
    return {
      action: "suppress",
      suppression,
    };
  }

  return { action: "fresh", eligibility };
}

async function emitReadyIssueEligibilityTrace({
  traceSink = null,
  domainId = null,
  issueId = null,
  domainContext = null,
  eligibility = null,
} = {}) {
  const routing = eligibility?.resourceRouting;
  if (!traceSink || !routing) return null;

  const observedAt = new Date().toISOString();
  const attributes = knownTraceAttributes({
    issue_id: issueId,
    work_type: routing.work_type,
    chosen_resource_id: routing.chosen_resource_id,
    allowed_resource_ids: routing.allowed_resource_ids,
    reason: routing.reason,
    "workflow.name": "ready_issue_eligibility",
    "teami.domain_id": domainContext?.trace?.domain_id || domainId,
    "teami.behavior_repo_id": domainContext?.trace?.behavior_repo_id,
    "linear.workspace_id": domainContext?.trace?.workspace_id || domainContext?.linear?.workspaceId,
    "linear.team_id": domainContext?.trace?.team_id || domainContext?.linear?.teamId,
    "linear.issue_id": issueId,
  });
  const trace = createTrace("ready_issue_eligibility", attributes);
  recordSpan(trace, "ready_issue_eligibility", attributes);
  trace.spans[0].startedAt = observedAt;
  trace.spans[0].endedAt = observedAt;

  const wake = {
    id: `ready-issue-eligibility:${issueId || "unknown"}`,
    domain_id: domainContext?.trace?.domain_id || domainId || null,
    workspace_id: domainContext?.trace?.workspace_id || domainContext?.linear?.workspaceId || null,
    team_id: domainContext?.trace?.team_id || domainContext?.linear?.teamId || null,
    object_id: issueId,
    workflow_type: "gateway",
    trigger_type: EXECUTION_READY_TRIGGER_TYPE,
    attempt_count: null,
  };
  const session = await traceSink.startRun?.({
    wake,
    sourceEvent: {
      id: `ready_issue_eligibility:${issueId || "unknown"}`,
      provider: "linear",
      event_id: `ready_issue_eligibility:${issueId || "unknown"}`,
    },
    runId: `ready-issue-eligibility-${issueId || "unknown"}-${Date.now()}`,
    workspaceId: wake.workspace_id,
    domainContext,
  });
  return traceSink.finishRun?.({
    session,
    result: {
      status: routing.reason ? "rejected" : "completed",
      reason: routing.reason,
      trace,
    },
    wake,
  });
}

function createReadyEligibilityTraceSink({ createTraceSink = null, repoRoot = process.cwd() } = {}) {
  if (typeof createTraceSink !== "function") return null;
  try {
    return createTraceSink({ repoRoot });
  } catch {
    return null;
  }
}

async function decideReadyIssueFixMode({
  issueId,
  issueContext,
  domainContext = null,
  config = null,
  repoIdentity = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  store = null,
  prAdapter = null,
  createPrAdapter = null,
  locatePr = locatePullRequestForIssue,
  resolveSessionHandle = resolveDriverSessionHandle,
  isRunResumable = runIsResumable,
  maxAutonomousFixRounds = null,
  allowColdReconstruct = false,
} = {}) {
  const priorRun = latestExecutionRunForReadyFix({ store, issueId });
  if (!priorRun && !allowColdReconstruct) return null;

  const roundLimit = readyFixMaxAutonomousRounds({
    config,
    maxAutonomousFixRounds,
  });
  if (!roundLimit.ok) {
    return readyFixEscalationDecision({
      reason: roundLimit.reason,
      priorRunId: stringOrNull(priorRun?.run_id || priorRun?.runId),
      priorRun,
      roundState: roundLimit,
    });
  }

  let priorRunId = null;
  let coldReconstructReason = null;
  if (priorRun) {
    priorRunId = stringOrNull(priorRun.run_id || priorRun.runId);
    if (!priorRunId) {
      if (!allowColdReconstruct) {
        return readyFixEscalationDecision({
          reason: "ready_fix_prior_run_id_missing",
          priorRun,
        });
      }
      coldReconstructReason = "ready_fix_prior_run_id_missing";
    }

    const resumeRecord = readyFixResumeRecordForRun({
      run: priorRun,
      repoRoot,
      runStoreDir,
    });
    if (resumeRecord?.resume_status === "paused") {
      return readyFixEscalationDecision({
        reason: "ready_fix_resume_paused",
        priorRunId,
        priorRun,
        resumeRecord,
      });
    }

    if (typeof isRunResumable === "function" && !isRunResumable(priorRun)) {
      if (!allowColdReconstruct) {
        return readyFixEscalationDecision({
          reason: "ready_fix_prior_run_not_resumable",
          priorRunId,
          priorRun,
        });
      }
      coldReconstructReason ||= "ready_fix_prior_run_not_resumable";
    }

    if (typeof resolveSessionHandle === "function" && !coldReconstructReason) {
      let sessionHandle;
      try {
        sessionHandle = await resolveSessionHandle(priorRun, { repoRoot, runStoreDir });
      } catch (error) {
        if (!allowColdReconstruct) {
          return readyFixEscalationDecision({
            reason: "ready_fix_prior_run_session_unresolved",
            priorRunId,
            priorRun,
            error,
          });
        }
        coldReconstructReason = "ready_fix_prior_run_session_unresolved";
      }
      if (!sessionHandle && !coldReconstructReason) {
        if (!allowColdReconstruct) {
          return readyFixEscalationDecision({
            reason: "ready_fix_prior_run_session_unresolved",
            priorRunId,
            priorRun,
          });
        }
        coldReconstructReason = "ready_fix_prior_run_session_unresolved";
      }
    }
  } else {
    coldReconstructReason = "ready_fix_prior_run_missing";
  }

  let resolvedRepoIdentity;
  let adapter;
  try {
    const priorProducedIdentity = producedPrIdentityForRun({
      run: priorRun,
      repoRoot,
      runStoreDir,
    });
    const selectedResourceId = selectedReviewResourceId({
      issueContext,
      producedIdentity: priorProducedIdentity,
      domainContext,
      repoIdentity,
    });
    resolvedRepoIdentity = repoIdentity || resourcesToRepoIdentity(domainContext, {
      resourceId: selectedResourceId,
    });
    adapter = await resolveReadyFixPrAdapter({
      repoIdentity: resolvedRepoIdentity,
      prAdapter,
      createPrAdapter,
    });
  } catch (error) {
    return readyFixEscalationDecision({
      reason: "ready_fix_pr_probe_unavailable",
      priorRunId,
      repoIdentity: resolvedRepoIdentity || null,
      priorRun,
      error,
    });
  }

  let location;
  try {
    location = await locatePr({
      issueContext,
      repoIdentity: resolvedRepoIdentity,
      prAdapter: adapter,
      createPrAdapter,
    });
  } catch (error) {
    return readyFixEscalationDecision({
      reason: "ready_fix_pr_probe_failed",
      priorRunId,
      repoIdentity: resolvedRepoIdentity,
      priorRun,
      error,
    });
  }

  if (location?.status !== "found") {
    return readyFixEscalationDecision({
      reason: readyFixPrLocationReason(location),
      priorRunId,
      location,
      repoIdentity: resolvedRepoIdentity,
      priorRun,
      hasPr: false,
    });
  }

  let reviewState;
  try {
    reviewState = await inspectReadyFixReviewState({
      adapter,
      pr: location.pr,
      maxAutonomousFixRounds: roundLimit.value,
    });
  } catch (error) {
    return readyFixEscalationDecision({
      reason: "ready_fix_review_state_probe_failed",
      priorRunId,
      location,
      repoIdentity: resolvedRepoIdentity,
      priorRun,
      hasPr: true,
      error,
    });
  }

  if (reviewState.status === "not_failure") return null;
  if (reviewState.status !== "found") {
    return readyFixEscalationDecision({
      reason: readyFixReviewStateReason(reviewState),
      priorRunId,
      location,
      repoIdentity: resolvedRepoIdentity,
      priorRun,
      reviewState,
      hasPr: true,
    });
  }
  if (reviewState.roundState?.status === "over_bound") {
    return readyFixEscalationDecision({
      reason: "ready_fix_review_round_bound_exceeded",
      priorRunId,
      location,
      repoIdentity: resolvedRepoIdentity,
      priorRun,
      reviewState,
      roundState: reviewState.roundState,
      hasPr: true,
    });
  }

  const decision = {
    action: "warm_resume",
    prNumber: location.pr.number,
    head_sha: location.pr.head_sha,
    priorRunId: priorRunId || coldResumeSyntheticPriorRunId({
      prNumber: location.pr.number,
      headSha: location.pr.head_sha,
    }),
  };
  if (!coldReconstructReason) return decision;
  return {
    ...decision,
    branch: location.branch,
    durableIdentity: readyFixDurableIdentity({
      priorRun,
      repoRoot,
      runStoreDir,
      issueContext,
      domainContext,
      repoIdentity: resolvedRepoIdentity,
      location,
    }),
    resumeMode: "cold_reconstruct",
    coldReconstructReason,
  };
}

export async function decideReviewIssue({
  domainId,
  issueId,
  issueContext,
  domainContext,
  repoRoot = process.cwd(),
  runStoreDir = null,
  repoIdentity = null,
  prAdapter = null,
  createPrAdapter = null,
  locatePr = locatePullRequestForIssue,
  locateProducedPr = locatePullRequestForProducedIdentity,
  hydrateState = hydrateReviewState,
  store = null,
  now = () => new Date(),
  recentExecutionGraceMs = REVIEW_PR_CREATION_GRACE_MS,
} = {}) {
  void domainId;
  const recentExecutionRun = latestExecutionRunForReview({ store, issueId });
  const producedIdentity = producedPrIdentityForRun({
    run: recentExecutionRun,
    repoRoot,
    runStoreDir,
  });
  const selectedResourceId = selectedReviewResourceId({
    issueContext,
    producedIdentity,
    domainContext,
    repoIdentity,
  });
  const resolvedRepoIdentity = repoIdentity || resourcesToRepoIdentity(domainContext, {
    resourceId: selectedResourceId,
  });
  const producedLocation = shouldLocateProducedReviewPr(producedIdentity)
    ? await locateProducedPr({
        producedIdentity,
        repoIdentity: resolvedRepoIdentity,
        prAdapter,
        createPrAdapter,
      })
    : null;
  const location = shouldUseProducedReviewLocation(producedLocation)
    ? producedLocation
    : await locatePr({
        issueContext,
        repoIdentity: resolvedRepoIdentity,
        prAdapter,
        createPrAdapter,
      });
  const status = location?.status;

  if (status === "found") {
    let reviewState;
    try {
      reviewState = await hydrateState(location.pr, { prAdapter, createPrAdapter });
    } catch (error) {
      return reviewEscalationDecision({
        reason: "review_state_hydration_failed",
        location,
        repoIdentity: resolvedRepoIdentity,
        hasPr: true,
        error,
      });
    }
    if (reviewAlreadyAppliedAtHead(reviewState)) {
      return {
        action: "skip",
        reason: "review_already_applied_at_head",
        location,
        repoIdentity: resolvedRepoIdentity,
        reviewState,
      };
    }
    return {
      action: "review",
      reason: "review_pr_found",
      location,
      pr: location.pr,
      repoIdentity: resolvedRepoIdentity,
      reviewState,
    };
  }

  if (status === "closed" || status === "multiple" || status === "wrong_base") {
    return reviewEscalationDecision({
      reason: `review_pr_${status}`,
      location,
      repoIdentity: resolvedRepoIdentity,
      hasPr: false,
    });
  }

  if (status === "none") {
    if (isExecutionRunInFlightOrRecent(recentExecutionRun, { now, recentExecutionGraceMs })) {
      return {
        action: "wait",
        reason: "review_pr_pending_execution",
        location,
        repoIdentity: resolvedRepoIdentity,
        recentExecutionRun,
      };
    }
    return reviewEscalationDecision({
      reason: location?.reason || "review_pr_missing",
      location,
      repoIdentity: resolvedRepoIdentity,
      hasPr: false,
    });
  }

  return reviewEscalationDecision({
    reason: `review_pr_status_unhandled:${status || "missing"}`,
    location,
    repoIdentity: resolvedRepoIdentity,
    hasPr: false,
  });
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

export async function replayPendingExecutionIssue(options = {}) {
  const {
    client,
    config,
    issueId,
    issueContext = null,
    pending,
    domainContext,
    repoRoot = process.cwd(),
    runStoreDir = null,
    runDeps = {},
    idempotency = triggerIdempotency,
  } = options;
  const target = pending || await idempotency.readGitReplayPending?.({
    domainId: domainContext?.domainId,
    objectId: issueId,
    repoRoot,
    runStoreDir,
  });
  if (!target) {
    return { action: "replay", status: "no_pending", cleared: false };
  }
  const artifact = readRunArtifact({
    runId: target.runId,
    repoRoot,
    runStoreDir,
  });
  if (!artifact) {
    return {
      action: "replay",
      status: "degraded",
      cleared: false,
      reason: "execution_replay_run_artifact_missing",
      pending: target,
    };
  }

  const issue = issueContext || await client.getIssueContext(issueId || target.objectId);
  const gitRemoteResolution = gitRemoteResolutionOptions(options);
  const runContext = executionReplayRunContext({
    domainContext,
    pending: target,
    runGit: runDeps.runGit || defaultRunGit,
    ...gitRemoteResolution,
  });
  const trace = {
    name: "execution_replay",
    attributes: {
      domain_id: domainContext?.domainId || target.domainId,
      source_object_id: issueId || target.objectId,
      run_id: target.runId,
      trigger_type: EXECUTION_READY_TRIGGER_TYPE,
    },
    spans: [],
  };
  const ctx = {
    client,
    config,
    issue,
    issueId: issueId || target.objectId,
    domainContext,
    runContext,
    resources: runContext.resources,
    resourceManifest: runContext.resourceManifest,
    artifact,
    payload: artifact.payload,
    trace,
    runId: target.runId,
    repoRoot,
    runStoreDir,
    retry: true,
    pending: target,
    pendingGitIntent: target,
    runDeps,
    runGit: runDeps.runGit || defaultRunGit,
    prAdapter: runDeps.prAdapter || null,
    wake: {
      id: `replay_${target.runId}`,
      domain_id: domainContext?.domainId || target.domainId,
      object_type: "issue",
      object_id: issueId || target.objectId,
      workflow_type: EXECUTION_WORKFLOW_TYPE,
      trigger_type: EXECUTION_READY_TRIGGER_TYPE,
    },
    artifactSetLineage: artifact.artifact_set_lineage,
  };
  const applyResult = await applyCommitEffects({
    effects: executionReplayCommitEffects(runDeps),
    ctx,
    trace,
  });
  if (applyResult.outcome === "ok") {
    return {
      action: "replay",
      status: "completed",
      cleared: false,
      pending: target,
      applied: applyResult.applied,
      produced_identities: applyResult.produced_identities,
      trace,
    };
  }
  return {
    action: "replay",
    status: applyResult.outcome,
    cleared: false,
    pending: target,
    pending_effect_id: applyResult.pending_effect_id,
    reason: applyResult.reason || applyResult.outcome,
    trace,
  };
}

export async function runFreshIssueSyntheticWake({
  config,
  repoRoot = process.cwd(),
  runStoreDir = null,
  registry,
  domain,
  domainContext = buildDomainContext({ domain, config, repoRoot }),
  issueId,
  retry = false,
  killPoint = null,
  createStore = createLocalTriggerStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  createRuntimeExecutor = createProcessRuntimeExecutor,
  runTriggeredExecutionFn = runTriggeredExecution,
  runDeps = null,
  runGit = defaultRunGit,
  idGenerator = undefined,
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
} = {}) {
  registerGitRepoResourceKind();
  const domainConfig = configWithDomainLinearTeam(config, domainContext);
  const cache = readLinearCache(domainContext.linear.cachePath);
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  const runnerId = `local-runner:${domainContext.domainId}`;
  const store = createStore({ repoRoot });
  const claim = await store.claimSyntheticIssueWake({
    domainId: domainContext.domainId,
    workspaceId: domainContext.linear.workspaceId,
    teamId: domainContext.linear.teamId,
    objectId: issueId,
    workflowType: EXECUTION_WORKFLOW_TYPE,
    triggerType: EXECUTION_READY_TRIGGER_TYPE,
    objectType: "issue",
  });
  if (!claim.ok) {
    return {
      status: "failed_closed",
      reason: claim.reason || "synthetic_issue_wake_claim_failed",
      claim,
    };
  }

  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const runtimeExecutor = createRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache),
    repoRoot,
  });
  const traceSink = createTraceSink({ repoRoot });
  const gitRemoteResolution = gitRemoteResolutionOptions({
    gitRemoteUrlOverride,
    gitRemoteUrlOverrides,
    resolveGitRemoteUrl,
    runDeps,
  });
  const executionRunDeps = {
    materialize: materializeDomainResources,
    runGit,
    ...(runDeps || {}),
    ...gitRemoteResolution,
    store,
  };
  try {
    return await runTriggeredExecutionFn({
      issueId,
      retry,
      killPoint,
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
      runStoreDir,
      leaseDurationMs: config?.runner?.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: config?.runner?.required_capabilities || EXECUTION_REQUIRED_CAPABILITIES,
      traceSink,
      domainContext,
      registry,
      claim,
      runDeps: executionRunDeps,
      ...gitRemoteResolution,
      ...(typeof idGenerator === "function" ? { idGenerator } : {}),
    });
  } finally {
    await traceSink.shutdown?.();
  }
}

export async function runWarmResumeIssueSyntheticWake({
  config,
  repoRoot = process.cwd(),
  runStoreDir = null,
  registry,
  domain,
  domainContext = buildDomainContext({ domain, config, repoRoot }),
  issueId,
  issueContext = null,
  priorRunId = null,
  prNumber,
  head_sha,
  warmResumeDecision = null,
  createStore = createLocalTriggerStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  createRuntimeExecutor = createProcessRuntimeExecutor,
  runTriggeredExecutionFn = runTriggeredExecution,
  runDeps = null,
  runGit = defaultRunGit,
  idGenerator = undefined,
  emitStatus = createStatusEmitter(),
  store: providedStore = null,
  resolveSessionHandle = resolveDriverSessionHandle,
  isRunResumable = runIsResumable,
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
} = {}) {
  registerGitRepoResourceKind();
  const effectiveIssueId = stringOrNull(issueId);
  const effectiveHeadSha = stringOrNull(head_sha);
  const effectivePrNumber = prNumber ?? warmResumeDecision?.prNumber ?? warmResumeDecision?.pr_number ?? null;
  const emitResumeStatus = (record, reason = null) => {
    emitStatus({
      domainId: domain?.id || domainContext?.domainId || null,
      issueId: effectiveIssueId,
      state: record.resume_status === "escalated_unresumable" ? "resume_attention" : "resume_working",
      reason: reason || record.resume_status,
      runId: priorRunId,
      prNumber: effectivePrNumber,
      headSha: effectiveHeadSha,
      note: record,
    });
  };
  const escalate = (reason, details = {}) => {
    const record = warmResumeRecord({
      resume_status: "escalated_unresumable",
      terminal_outcome: null,
      head_sha: effectiveHeadSha,
      prior_run_id: stringOrNull(details.priorRunId) || stringOrNull(priorRunId),
    });
    emitResumeStatus(record, reason);
    return {
      status: "failed_closed",
      reason,
      ...record,
      ...details,
    };
  };

  if (!effectiveIssueId) return escalate("warm_resume_issue_id_required");
  if (!effectiveHeadSha) return escalate("warm_resume_head_sha_required");

  const store = providedStore || runDeps?.store || createStore({ repoRoot });
  const priorRun = latestExecutionRunForReadyFix({ store, issueId: effectiveIssueId });
  const durableIdentity = readyFixDurableIdentity({
    priorRun,
    repoRoot,
    runStoreDir,
    issueContext,
    domainContext,
    prNumber: effectivePrNumber,
    headSha: effectiveHeadSha,
    warmResumeDecision,
  });
  const coldAnchor = coldResumeAnchorFromDurableIdentity({
    identity: durableIdentity,
    domainContext,
    issueContext,
    prNumber: effectivePrNumber,
    headSha: effectiveHeadSha,
    priorRunId,
  });
  if (!priorRun && !coldAnchor.ok) {
    return escalate("warm_resume_prior_run_missing", {
      coldReconstruct: coldAnchor,
    });
  }

  const resolvedPriorRunId =
    stringOrNull(priorRun?.run_id || priorRun?.runId) ||
    stringOrNull(priorRunId) ||
    coldAnchor.priorRunId;
  if (!resolvedPriorRunId) return escalate("warm_resume_prior_run_id_missing", { priorRun });
  if (priorRun && stringOrNull(priorRunId) && stringOrNull(priorRunId) !== resolvedPriorRunId) {
    return escalate("warm_resume_prior_run_mismatch", {
      priorRunId: resolvedPriorRunId,
      expectedPriorRunId: stringOrNull(priorRunId),
      priorRun,
    });
  }

  let coldReconstructReason = priorRun ? null : "warm_resume_prior_run_missing";
  if (priorRun && typeof isRunResumable === "function" && !isRunResumable(priorRun)) {
    if (!coldAnchor.ok) {
      return escalate("warm_resume_prior_run_not_resumable", {
        priorRunId: resolvedPriorRunId,
        priorRun,
        coldReconstruct: coldAnchor,
      });
    }
    coldReconstructReason = "warm_resume_prior_run_not_resumable";
  }

  let sessionHandle;
  if (priorRun && !coldReconstructReason) {
    try {
      sessionHandle = typeof resolveSessionHandle === "function"
        ? await resolveSessionHandle(priorRun, { repoRoot, runStoreDir })
        : null;
    } catch (error) {
      if (!coldAnchor.ok) {
        return escalate("warm_resume_prior_run_session_unresolved", {
          priorRunId: resolvedPriorRunId,
          priorRun,
          error,
          coldReconstruct: coldAnchor,
        });
      }
      coldReconstructReason = "warm_resume_prior_run_session_unresolved";
    }
    if (!sessionHandle && !coldReconstructReason) {
      if (!coldAnchor.ok) {
        return escalate("warm_resume_prior_run_session_unresolved", {
          priorRunId: resolvedPriorRunId,
          priorRun,
          coldReconstruct: coldAnchor,
        });
      }
      coldReconstructReason = "warm_resume_prior_run_session_unresolved";
    }
    if (
      sessionHandle &&
      (
        sessionHandle.role !== "orchestrator" ||
        sessionHandle.run_id !== resolvedPriorRunId ||
        !sessionHandle.id
      )
    ) {
      return escalate("warm_resume_prior_run_session_mismatch", {
        priorRunId: resolvedPriorRunId,
        priorRun,
        sessionHandle,
      });
    }
  }

  if (coldReconstructReason && !coldAnchor.ok) {
    return escalate("warm_resume_cold_reconstruct_identity_incomplete", {
      priorRunId: resolvedPriorRunId,
      priorRun,
      coldReconstruct: coldAnchor,
    });
  }

  let reviewerNotes;
  try {
    reviewerNotes = await fetchWarmResumeReviewerNotes({
      domainContext,
      runDeps,
      prNumber: effectivePrNumber,
      headSha: effectiveHeadSha,
      resourceId: durableIdentity.resource_id,
    });
  } catch (error) {
    return escalate("warm_resume_review_notes_unresolved", {
      priorRunId: resolvedPriorRunId,
      priorRun,
      error,
    });
  }
  if (typeof reviewerNotes !== "string" || reviewerNotes === "") {
    return escalate("warm_resume_review_notes_missing", {
      priorRunId: resolvedPriorRunId,
      priorRun,
    });
  }

  const domainConfig = configWithDomainLinearTeam(config, domainContext);
  const cache = readLinearCache(domainContext.linear.cachePath);
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  const runnerId = `local-runner:${domainContext.domainId}`;
  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const smokeTests = smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache);
  const runtimeVersions = runtimeVersionsFromRuntimeSmokeCache(runtimeSmokeCache);
  const runtimeExecutor = createRuntimeExecutor({
    smokeTests,
    repoRoot,
  });
  const traceSink = createTraceSink({ repoRoot });
  const gitRemoteResolution = gitRemoteResolutionOptions({
    gitRemoteUrlOverride,
    gitRemoteUrlOverrides,
    resolveGitRemoteUrl,
    runDeps,
  });
  const executionRunDeps = {
    materialize: materializeDomainResources,
    runGit,
    ...(runDeps || {}),
    ...gitRemoteResolution,
    store,
    ...(coldReconstructReason ? { coldResumeGitIntent: coldAnchor.pendingGitIntent } : {}),
  };

  try {
    const result = await runTriggeredExecutionFn({
      issueId: effectiveIssueId,
      retry: true,
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
      runStoreDir,
      leaseDurationMs: config?.runner?.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: config?.runner?.required_capabilities || EXECUTION_REQUIRED_CAPABILITIES,
      traceSink,
      domainContext,
      registry,
      runDeps: executionRunDeps,
      ...gitRemoteResolution,
      resumeFrom: {
        ...(sessionHandle ? { sessionHandle } : {}),
        reviewerNotes,
        priorRunId: resolvedPriorRunId,
        smokeTests,
        runtimeVersion: sessionHandle ? runtimeVersions?.[sessionHandle.runtime] || null : null,
        head_sha: effectiveHeadSha,
        ...(coldReconstructReason ? {
          coldReconstruct: true,
          mode: "cold_reconstruct",
          coldReconstructReason,
          durableIdentity,
        } : {}),
      },
      ...(typeof idGenerator === "function" ? { idGenerator } : {}),
    });
    const record = warmResumeRecordFromRunnerResult({
      result,
      headSha: effectiveHeadSha,
      priorRunId: resolvedPriorRunId,
    });
    emitResumeStatus(record, record.resume_status);
    return {
      ...result,
      ...record,
    };
  } finally {
    await traceSink.shutdown?.();
  }
}

export const runWarmResumeIssueNotImplemented = runWarmResumeIssueSyntheticWake;

export async function runFreshReviewSyntheticWake({
  config,
  repoRoot = process.cwd(),
  runStoreDir = null,
  registry,
  domain,
  domainContext = buildDomainContext({ domain, config, repoRoot }),
  issueId,
  reviewDecision = null,
  createStore = createLocalTriggerStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  createRuntimeExecutor = createProcessRuntimeExecutor,
  runTriggeredReviewFn = runTriggeredReview,
  runDeps = null,
  idGenerator = undefined,
} = {}) {
  const domainConfig = configWithDomainLinearTeam(config, domainContext);
  const cache = readLinearCache(domainContext.linear.cachePath);
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext,
  });
  const runnerId = `local-runner:${domainContext.domainId}`;
  const store = runDeps?.store || createStore({ repoRoot });
  const claim = await store.claimSyntheticIssueWake({
    domainId: domainContext.domainId,
    workspaceId: domainContext.linear.workspaceId,
    teamId: domainContext.linear.teamId,
    objectId: issueId,
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

  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const runtimeExecutor = createRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache),
    repoRoot,
  });
  const traceSink = createTraceSink({ repoRoot });
  const reviewRunDeps = {
    ...(runDeps || {}),
    store,
  };
  try {
    return await runTriggeredReviewFn({
      issueId,
      reviewDecision,
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
      runStoreDir,
      leaseDurationMs: config?.runner?.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: config?.runner?.required_capabilities || REVIEW_REQUIRED_CAPABILITIES,
      traceSink,
      domainContext,
      registry,
      claim,
      runDeps: reviewRunDeps,
      ...(typeof idGenerator === "function" ? { idGenerator } : {}),
    });
  } finally {
    await traceSink.shutdown?.();
  }
}

function executionReplayRunContext({
  domainContext,
  pending,
  runGit = defaultRunGit,
  gitRemoteUrlOverride = null,
  gitRemoteUrlOverrides = null,
  resolveGitRemoteUrl = null,
} = {}) {
  const resources = {};
  const resourceManifest = [];
  const selected = gitResourceById(domainContext, pending?.git?.resource_id) || singleGitResource(domainContext);
  let selectedResource = null;
  let selectedResourceId = null;
  if (selected) {
    const binding = selected.binding || {};
    selectedResource = {
      id: selected.id,
      kind: "git_repo",
      role: selected.role,
      handle: {
        owner: pending?.git?.owner || binding.owner,
        repo: pending?.git?.repo || binding.repo,
        default_branch: binding.default_branch,
        baseSha: pending?.git?.base_sha,
      },
    };
    selectedResourceId = selected.id;
    resources[selected.id] = selectedResource;
    resourceManifest.push({
      kind: "git_repo",
      id: selected.id,
      role: selected.role,
      label: binding.owner && binding.repo ? `${binding.owner}/${binding.repo}` : selected.id,
    });
  }
  return {
    runId: pending?.runId || null,
    resources,
    selectedResourceId,
    selectedResource,
    resourceManifest,
    runGit,
    ...gitRemoteRunContextFields({
      gitRemoteUrlOverride,
      gitRemoteUrlOverrides,
      resolveGitRemoteUrl,
    }),
  };
}

function gitRemoteResolutionOptions(options = {}) {
  const runDeps = isRecordLike(options.runDeps) ? options.runDeps : {};
  return gitRemoteRunContextFields({
    gitRemoteUrlOverride: stringOrNull(options.gitRemoteUrlOverride) || stringOrNull(runDeps.gitRemoteUrlOverride),
    gitRemoteUrlOverrides: isRecordLike(options.gitRemoteUrlOverrides)
      ? options.gitRemoteUrlOverrides
      : isRecordLike(runDeps.gitRemoteUrlOverrides)
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
    ...(isRecordLike(gitRemoteUrlOverrides) ? { gitRemoteUrlOverrides } : {}),
    ...(typeof resolveGitRemoteUrl === "function" ? { resolveGitRemoteUrl } : {}),
  };
}

function executionReplayCommitEffects(runDeps = {}) {
  const overlays = new Map();
  for (const candidate of [
    runDeps.gitEffect,
    runDeps.issueMoveEffect,
    runDeps.linearIssueEffect,
    runDeps.effects,
    runDeps.commitEffects,
  ]) {
    for (const effect of replayEffectEntries(candidate)) {
      if (!effect?.id) continue;
      overlays.set(effect.id, { ...(overlays.get(effect.id) || {}), ...effect });
    }
  }
  return executionDefinition.commit_effects.map((effect) => ({
    ...effect,
    ...(overlays.get(effect.id) || {}),
  }));
}

function replayEffectEntries(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate.filter(isRecordLike);
  if (Array.isArray(candidate.effects)) return candidate.effects.filter(isRecordLike);
  if (Array.isArray(candidate.commitEffects)) return candidate.commitEffects.filter(isRecordLike);
  if (isRecordLike(candidate.byId)) {
    return Object.entries(candidate.byId).map(([id, effect]) => ({ id, ...(isRecordLike(effect) ? effect : {}) }));
  }
  const entries = [];
  for (const id of [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID]) {
    if (isRecordLike(candidate[id])) entries.push({ id, ...candidate[id] });
  }
  if (["probe", "apply", "verify"].some((step) => typeof candidate?.[step] === "function")) {
    entries.push({ id: candidate.id || GIT_REPO_COMMIT_EFFECT_ID, ...candidate });
  }
  return entries;
}

function reviewEscalationDecision({
  reason,
  location = null,
  repoIdentity = null,
  hasPr = false,
  error = null,
} = {}) {
  return {
    action: "escalate",
    reason: reason || "review_escalation_required",
    location,
    repoIdentity,
    hasPr: hasPr === true,
    ...(error ? { error } : {}),
  };
}

function readyFixEscalationDecision({
  reason,
  priorRunId = null,
  priorRun = null,
  location = null,
  repoIdentity = null,
  reviewState = null,
  roundState = null,
  resumeRecord = null,
  hasPr = false,
  error = null,
} = {}) {
  return {
    action: "escalate",
    reason: reason || "ready_fix_escalation_required",
    priorRunId,
    priorRun,
    location,
    repoIdentity,
    reviewState,
    ...(roundState ? { roundState } : {}),
    ...(resumeRecord ? { resumeRecord } : {}),
    hasPr: hasPr === true,
    ...(error ? { error } : {}),
  };
}

function latestExecutionRunForReadyFix({ store, issueId } = {}) {
  if (typeof store?.findLatestRunForObject !== "function") return null;
  try {
    return store.findLatestRunForObject(issueId);
  } catch {
    return null;
  }
}

async function latestExecutionWakeLeaseIsLive({ store, run, now = () => new Date() } = {}) {
  const wakeId = stringOrNull(run?.wake_id || run?.wakeId);
  if (!wakeId || typeof store?.getWake !== "function") return false;
  const wake = await store.getWake(wakeId);
  return wakeLeaseIsLive(wake, { now });
}

function wakeLeaseIsLive(wake, { now = () => new Date() } = {}) {
  if (!stringOrNull(wake?.lease_token)) return false;
  const expiresAt = Date.parse(wake?.lease_expires_at || "");
  return Number.isFinite(expiresAt) && expiresAt > timeMs(now);
}

function readyIssueEligibilityOptions({ config = null, cache = null, allowedRepoPacket = null } = {}) {
  const todoStateId = stringOrNull(cache?.issueStatuses?.todo);
  if (!todoStateId) {
    throw new Error("Cached Linear issue status id missing for todo.");
  }
  const discoveryLabelName = stringOrNull(config?.linear?.issue?.labels?.discovery);
  const discoveryLabelId = discoveryLabelName
    ? stringOrNull(cache?.issueLabels?.[discoveryLabelName])
    : null;
  if (!discoveryLabelName || !discoveryLabelId) {
    throw new Error(`Cached Linear issue label id missing for ${discoveryLabelName || "Discovery"}.`);
  }
  const workTypeCodeLabelId = optionalCachedIssueLabelId({ config, cache, semanticName: "work_type_code" });
  const workTypeNonCodeLabelId = optionalCachedIssueLabelId({ config, cache, semanticName: "work_type_non_code" });
  return {
    todoStateId,
    discoveryLabelId,
    allowedRepoPacket: Array.isArray(allowedRepoPacket) ? allowedRepoPacket : null,
    workTypeCodeLabelId,
    workTypeNonCodeLabelId,
  };
}

function optionalCachedIssueLabelId({ config = null, cache = null, semanticName } = {}) {
  const labelName = stringOrNull(config?.linear?.issue?.labels?.[semanticName]);
  return labelName ? stringOrNull(cache?.issueLabels?.[labelName]) : null;
}

function readyIssueSuppressionStateIds(cache = null) {
  return [
    stringOrNull(cache?.issueStatuses?.todo),
    stringOrNull(cache?.issueStatuses?.in_progress),
  ].filter(Boolean);
}

function readyIssueSuppressionFingerprintMatches({
  current,
  issueContext,
  fingerprint,
  computeFingerprint,
  cache,
} = {}) {
  if (computeFingerprint(current) === fingerprint) return true;
  const todoStateId = stringOrNull(cache?.issueStatuses?.todo);
  const inProgressStateId = stringOrNull(cache?.issueStatuses?.in_progress);
  if (
    !issueContext ||
    current?.state?.id !== inProgressStateId ||
    issueContext?.state?.id !== todoStateId
  ) {
    return false;
  }
  return computeFingerprint({
    ...current,
    state: issueContext.state,
  }) === fingerprint;
}

function readyFixMaxAutonomousRounds({
  config = null,
  maxAutonomousFixRounds = null,
} = {}) {
  const configured = maxAutonomousFixRounds ?? config?.workflows?.review?.max_autonomous_fix_rounds;
  if (configured === null || configured === undefined) {
    return {
      ok: true,
      value: DEFAULT_READY_FIX_MAX_AUTONOMOUS_ROUNDS,
      source: "default",
    };
  }
  if (!Number.isInteger(configured) || configured < 0) {
    return {
      ok: false,
      reason: "ready_fix_review_round_limit_invalid",
      value: configured,
    };
  }
  return {
    ok: true,
    value: configured,
    source: maxAutonomousFixRounds !== null && maxAutonomousFixRounds !== undefined
      ? "option"
      : "config",
  };
}

function readyFixResumeRecordForRun({
  run,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const inlineRecord =
    warmResumeRecord(run?.resume) ||
    warmResumeRecord(run?.artifact?.resume) ||
    warmResumeRecord(run?.artifact?.payload?.resume) ||
    warmResumeRecord(run?.result?.artifact?.resume) ||
    warmResumeRecord(run?.result?.artifact?.payload?.resume);
  if (inlineRecord) return inlineRecord;

  const artifact = readReadyFixRunArtifact({ run, repoRoot, runStoreDir });
  return warmResumeRecord(artifact?.resume) || warmResumeRecord(artifact?.payload?.resume);
}

function readReadyFixRunArtifact({
  run,
  repoRoot = process.cwd(),
  runStoreDir = null,
} = {}) {
  const runId = stringOrNull(run?.run_id || run?.runId);
  if (!runId) return null;

  try {
    const artifact = readRunArtifact({
      runId,
      repoRoot,
      ...(runStoreDir ? { runStoreDir } : {}),
    });
    if (artifact) return artifact;
  } catch {
    // Fall through to the persisted artifact pointer when the default store misses.
  }

  const artifactPath = stringOrNull(run?.artifact_pointer?.artifact_path || run?.artifactPointer?.artifact_path);
  if (!artifactPath) return null;
  try {
    const resolvedArtifactPath = path.resolve(repoRoot || process.cwd(), artifactPath);
    return readRunArtifact({
      runId,
      repoRoot,
      runStoreDir: path.dirname(resolvedArtifactPath),
    });
  } catch {
    return null;
  }
}

function producedPrIdentityForRun({ run, repoRoot = process.cwd(), runStoreDir = null } = {}) {
  const inline = producedPrIdentityFromArtifact(run?.artifact) ||
    producedPrIdentityFromArtifact(run?.result?.artifact);
  if (inline) return inline;
  return producedPrIdentityFromArtifact(readReadyFixRunArtifact({ run, repoRoot, runStoreDir }));
}

function readyFixDurableIdentity({
  priorRun = null,
  repoRoot = process.cwd(),
  runStoreDir = null,
  issueContext = null,
  domainContext = null,
  repoIdentity = null,
  location = null,
  prNumber = null,
  headSha = null,
  warmResumeDecision = null,
} = {}) {
  const produced = readyFixProducedPrIdentityForRun({ run: priorRun, repoRoot, runStoreDir });
  const decisionIdentity =
    warmResumeDecision?.durableIdentity ||
    warmResumeDecision?.producedIdentity ||
    warmResumeDecision?.identity ||
    null;
  const resourceId = firstReadyFixString(
    decisionIdentity?.resource_id,
    produced?.resource_id,
    warmResumeDecision?.resource_id,
    resourceIdFromIssueContext(issueContext),
    gitResourceForRepo({ domainContext, repoIdentity, produced, decisionIdentity })?.id,
    singleGitResource(domainContext)?.id,
  );
  const resource = gitResourceById(domainContext, resourceId);
  const binding = resource?.binding || {};
  const pullRequest = location?.pr || location?.pull_request || {};
  const branch = firstReadyFixString(
    decisionIdentity?.branch,
    produced?.branch,
    warmResumeDecision?.branch,
    location?.branch,
  );
  const normalizedPrNumber = firstReadyFixString(
    decisionIdentity?.pull_request_number,
    decisionIdentity?.pr_number,
    produced?.pull_request_number,
    produced?.pr_number,
    warmResumeDecision?.prNumber,
    warmResumeDecision?.pr_number,
    prNumber,
    pullRequest.number,
  );
  const normalizedHeadSha = firstReadyFixString(
    decisionIdentity?.head_sha,
    decisionIdentity?.headSha,
    produced?.head_sha,
    produced?.headSha,
    warmResumeDecision?.head_sha,
    warmResumeDecision?.headSha,
    headSha,
    pullRequest.head_sha,
  );
  return readyFixCompactRecord({
    resource_id: resourceId,
    owner: firstReadyFixString(decisionIdentity?.owner, produced?.owner, repoIdentity?.owner, binding.owner),
    repo: firstReadyFixString(decisionIdentity?.repo, produced?.repo, repoIdentity?.repo, binding.repo),
    branch,
    head_sha: normalizedHeadSha,
    base_sha: firstReadyFixString(decisionIdentity?.base_sha, produced?.base_sha),
    pull_request_number: normalizedPrNumber,
    pull_request_id: firstReadyFixString(decisionIdentity?.pull_request_id, produced?.pull_request_id),
    pull_request_url: firstReadyFixString(decisionIdentity?.pull_request_url, produced?.pull_request_url),
  });
}

function readyFixProducedPrIdentityForRun({ run, repoRoot = process.cwd(), runStoreDir = null } = {}) {
  return producedPrIdentityForRun({ run, repoRoot, runStoreDir });
}

function producedPrIdentityFromArtifact(artifact) {
  const identities = Array.isArray(artifact?.produced_identities) ? artifact.produced_identities : [];
  const entry = identities.find((candidate) =>
    candidate?.resource_kind === "github_pull_request" &&
    candidate?.identity &&
    typeof candidate.identity === "object" &&
    !Array.isArray(candidate.identity)
  );
  return entry?.identity || null;
}

function coldResumeAnchorFromDurableIdentity({
  identity,
  domainContext = null,
  prNumber = null,
  headSha = null,
  priorRunId = null,
} = {}) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return { ok: false, reason: "cold_resume_identity_missing" };
  }
  const resourceId = firstReadyFixString(identity.resource_id);
  const resource = gitResourceById(domainContext, resourceId);
  if (!resource) {
    return {
      ok: false,
      reason: resourceId ? "cold_resume_resource_not_configured" : "cold_resume_resource_id_missing",
      resource_id: resourceId || null,
    };
  }
  const binding = resource.binding || {};
  const branch = firstReadyFixString(identity.branch);
  const normalizedHeadSha = firstReadyFixString(identity.head_sha, headSha);
  const normalizedPrNumber = firstReadyFixString(identity.pull_request_number, identity.pr_number, prNumber);
  const owner = firstReadyFixString(identity.owner, binding.owner);
  const repo = firstReadyFixString(identity.repo, binding.repo);
  const missing = [];
  if (!resourceId) missing.push("resource_id");
  if (!owner) missing.push("owner");
  if (!repo) missing.push("repo");
  if (!branch) missing.push("branch");
  if (!normalizedHeadSha) missing.push("head_sha");
  if (!normalizedPrNumber) missing.push("pull_request_number");
  if (missing.length > 0) {
    return { ok: false, reason: "cold_resume_identity_incomplete", missing };
  }
  const resolvedPriorRunId = firstReadyFixString(priorRunId) || coldResumeSyntheticPriorRunId({
    prNumber: normalizedPrNumber,
    headSha: normalizedHeadSha,
  });
  return {
    ok: true,
    priorRunId: resolvedPriorRunId,
    identity: {
      ...identity,
      resource_id: resourceId,
      owner,
      repo,
      branch,
      head_sha: normalizedHeadSha,
      pull_request_number: normalizedPrNumber,
    },
    pendingGitIntent: {
      objectType: "issue",
      runId: resolvedPriorRunId,
      artifactKind: "commit",
      git: readyFixCompactRecord({
        resource_id: resourceId,
        owner,
        repo,
        branch,
        base_sha: firstReadyFixString(identity.base_sha),
        head_sha: normalizedHeadSha,
      }),
    },
  };
}

function coldResumeSyntheticPriorRunId({ prNumber = null, headSha = null } = {}) {
  const number = firstReadyFixString(prNumber) || "unknown";
  const head = (firstReadyFixString(headSha) || "unknown").slice(0, 12);
  return `cold_resume_pr_${number}_${head}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function resourceIdFromIssueContext(issueContext = null) {
  const direct = isRecordLike(issueContext?.resource_target) ? issueContext.resource_target : null;
  const target = direct || parseResourceTargetFromDescription(issueContext?.description);
  return target?.kind === "git_repo" ? target.id : null;
}

function gitResourceForRepo({ domainContext = null, repoIdentity = null, produced = null, decisionIdentity = null } = {}) {
  const owner = firstReadyFixString(decisionIdentity?.owner, produced?.owner, repoIdentity?.owner);
  const repo = firstReadyFixString(decisionIdentity?.repo, produced?.repo, repoIdentity?.repo);
  if (!owner || !repo) return null;
  return gitResources(domainContext).find((resource) =>
    resource?.binding?.owner === owner &&
    resource?.binding?.repo === repo
  ) || null;
}

function gitResourceById(domainContext = null, resourceId = null) {
  const normalized = firstReadyFixString(resourceId);
  if (!normalized) return null;
  return gitResources(domainContext).find((resource) => resource.id === normalized) || null;
}

function singleGitResource(domainContext = null) {
  const resources = gitResources(domainContext);
  return resources.length === 1 ? resources[0] : null;
}

function gitResources(domainContext = null) {
  return (Array.isArray(domainContext?.resources) ? domainContext.resources : [])
    .filter((resource) => resource?.kind === "git_repo" && resource?.binding);
}

function firstReadyFixString(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function readyFixCompactRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

async function resolveReadyFixPrAdapter({ repoIdentity, prAdapter, createPrAdapter } = {}) {
  if (typeof prAdapter === "function") return prAdapter({ repoIdentity });
  if (prAdapter && typeof prAdapter === "object") return prAdapter;
  if (typeof createPrAdapter === "function") return createPrAdapter({ repoIdentity });
  return createDefaultExecutionPullRequestAdapter({ repoIdentity });
}

async function inspectReadyFixReviewState({
  adapter,
  pr,
  maxAutonomousFixRounds = DEFAULT_READY_FIX_MAX_AUTONOMOUS_ROUNDS,
} = {}) {
  requireReadyFixAdapterMethod(adapter, "getCommitStatuses");
  const statuses = await adapter.getCommitStatuses(pr?.head_sha);
  const teamiReviewStatus = latestReadyFixAfReviewStatus(statuses);
  if (teamiReviewStatus?.state !== "failure") {
    return {
      status: "not_failure",
      af_review_status: teamiReviewStatus || null,
    };
  }

  requireReadyFixAdapterMethod(adapter, "listPullRequestComments");
  const comments = await adapter.listPullRequestComments(pr?.number);
  const markerLookup = lookupReadyFixReviewMarker({ comments, pr });
  if (markerLookup.status !== "found") {
    return {
      status: `marker_${markerLookup.status || "lookup_failed"}`,
      af_review_status: teamiReviewStatus,
      markerLookup,
    };
  }
  const roundState = await inspectReadyFixReviewRounds({
    adapter,
    comments,
    currentHeadSha: pr?.head_sha,
    currentHeadStatuses: statuses,
    maxAutonomousFixRounds,
  });
  return {
    status: "found",
    af_review_status: teamiReviewStatus,
    markerLookup,
    roundState,
  };
}

function lookupReadyFixReviewMarker({ comments, pr } = {}) {
  return lookupAfReviewCommentByMarker(comments, {
    context: AF_REVIEW_STATUS_CONTEXT,
    head_sha: pr?.head_sha,
    disposition: READY_FIX_REVIEW_DISPOSITION,
  });
}

async function inspectReadyFixReviewRounds({
  adapter,
  comments = [],
  currentHeadSha = null,
  currentHeadStatuses = null,
  maxAutonomousFixRounds = DEFAULT_READY_FIX_MAX_AUTONOMOUS_ROUNDS,
} = {}) {
  const candidateHeadShas = readyFixFailureMarkerHeadShas(comments);
  const verifiedHeadShas = [];
  const skippedHeadShas = [];
  for (const headSha of candidateHeadShas) {
    const statuses = headSha === currentHeadSha ? currentHeadStatuses : await adapter.getCommitStatuses(headSha);
    const teamiReviewStatus = latestReadyFixAfReviewStatus(statuses);
    if (teamiReviewStatus?.state === "failure") {
      verifiedHeadShas.push(headSha);
    } else {
      skippedHeadShas.push(headSha);
    }
  }
  const count = verifiedHeadShas.length;
  return {
    status: count > maxAutonomousFixRounds ? "over_bound" : "within_bound",
    count,
    max: maxAutonomousFixRounds,
    head_shas: verifiedHeadShas,
    skipped_head_shas: skippedHeadShas,
  };
}

function readyFixFailureMarkerHeadShas(comments = []) {
  const headShas = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!isBotAuthoredAfReviewComment(comment)) continue;
    const parsed = parseAfReviewCommentMarker(comment?.body);
    if (!parsed.ok) continue;
    if (parsed.marker.context !== AF_REVIEW_STATUS_CONTEXT) continue;
    if (!READY_FIX_FAILURE_REVIEW_DISPOSITIONS.has(parsed.marker.disposition)) continue;
    const headSha = stringOrNull(parsed.marker.head_sha);
    if (headSha) headShas.add(headSha);
  }
  return [...headShas];
}

function isBotAuthoredAfReviewComment(comment) {
  const authorType = stringOrNull(
    comment?.user?.type ||
    comment?.author?.type ||
    comment?.author?.__typename ||
    comment?.actor?.type,
  );
  if (!authorType) return true;
  return authorType.toLowerCase() === "bot";
}

async function fetchWarmResumeReviewerNotes({
  domainContext = null,
  runDeps = null,
  prNumber,
  headSha,
  resourceId = null,
} = {}) {
  const repoIdentity = resourcesToRepoIdentity(domainContext, { resourceId });
  const adapter = await resolveReadyFixPrAdapter({
    repoIdentity,
    prAdapter: runDeps?.prAdapter || null,
    createPrAdapter: runDeps?.createPrAdapter || null,
  });
  requireReadyFixAdapterMethod(adapter, "listPullRequestComments");
  const comments = await adapter.listPullRequestComments(prNumber);
  const lookup = lookupAfReviewCommentByMarker(comments, {
    context: AF_REVIEW_STATUS_CONTEXT,
    head_sha: headSha,
    disposition: READY_FIX_REVIEW_DISPOSITION,
  });
  const match = latestReadyFixReviewMarkerMatch(lookup);
  if (!match?.comment?.body) {
    throw new Error(`warm_resume_review_marker_${lookup?.status || "missing"}`);
  }
  return match.comment.body;
}

function latestReadyFixReviewMarkerMatch(lookup) {
  if (lookup?.status === "found") return lookup;
  if (lookup?.status !== "multiple") return null;
  const matches = Array.isArray(lookup.matches) ? lookup.matches : [];
  if (matches.length === 0) return null;
  return [...matches].sort(compareReviewMarkerMatchesLatestFirst)[0] || null;
}

function compareReviewMarkerMatchesLatestFirst(left, right) {
  const leftTime = Date.parse(left?.comment?.created_at || left?.comment?.createdAt || "");
  const rightTime = Date.parse(right?.comment?.created_at || right?.comment?.createdAt || "");
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  if (normalizedLeft !== normalizedRight) return normalizedRight - normalizedLeft;
  return String(right?.comment?.comment_id || right?.comment?.id || "")
    .localeCompare(String(left?.comment?.comment_id || left?.comment?.id || ""));
}

function warmResumeRecordFromRunnerResult({ result = null, headSha = null, priorRunId = null } = {}) {
  const artifactRecord = warmResumeRecord(result?.result?.artifact?.resume);
  if (artifactRecord) return artifactRecord;
  const terminalOutcome = stringOrNull(result?.result?.artifact?.terminal_output?.outcome);
  return warmResumeRecord({
    resume_status: resumeStatusFromTerminalOutcome(terminalOutcome),
    terminal_outcome: terminalOutcome,
    head_sha: headSha,
    prior_run_id: priorRunId,
  });
}

function warmResumeRecord(record = {}) {
  if (!isRecordLike(record)) return null;
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

function resumeStatusFromTerminalOutcome(terminalOutcome) {
  if (terminalOutcome === "commit") return "committed";
  if (terminalOutcome === "pause") return "paused";
  return "escalated_unresumable";
}

function latestReadyFixAfReviewStatus(statuses) {
  if (!Array.isArray(statuses)) return null;
  let latest = null;
  statuses.forEach((status, index) => {
    if (!isRecordLike(status) || status.context !== AF_REVIEW_STATUS_CONTEXT || !status.state) return;
    const candidate = {
      item: status,
      index,
      time: Date.parse(status.created_at || ""),
    };
    if (!Number.isFinite(candidate.time)) candidate.time = Number.NEGATIVE_INFINITY;
    if (
      !latest ||
      candidate.time > latest.time ||
      (candidate.time === latest.time && candidate.index > latest.index)
    ) {
      latest = candidate;
    }
  });
  return latest?.item || null;
}

function readyFixPrLocationReason(location) {
  const status = stringOrNull(location?.status);
  if (status === "none") return "ready_fix_pr_missing";
  if (status === "closed") return "ready_fix_pr_closed";
  if (status === "multiple") return "ready_fix_pr_multiple";
  if (status === "wrong_base") return "ready_fix_pr_wrong_base";
  return `ready_fix_pr_${status || "unresolved"}`;
}

function readyFixReviewStateReason(reviewState) {
  if (reviewState?.status === "marker_missing") return "ready_fix_review_marker_missing";
  if (reviewState?.status === "marker_multiple") return "ready_fix_review_marker_multiple";
  if (reviewState?.status === "marker_malformed") return "ready_fix_review_marker_malformed";
  return `ready_fix_review_${stringOrNull(reviewState?.status) || "unresolved"}`;
}

function requireReadyFixAdapterMethod(adapter, method) {
  if (typeof adapter?.[method] !== "function") {
    throw new Error(`ready_fix_pr_adapter_${method}_missing`);
  }
}

function reviewAlreadyAppliedAtHead(reviewState) {
  return Boolean(
    reviewState?.af_review_state &&
    reviewState?.latest_marker_comment_at_head?.marker?.head_sha,
  );
}

function selectedReviewResourceId({
  issueContext = null,
  producedIdentity = null,
  domainContext = null,
  repoIdentity = null,
} = {}) {
  return firstReadyFixString(
    resourceIdFromIssueContext(issueContext),
    producedIdentity?.resource_id,
    gitResourceForRepo({ domainContext, repoIdentity, produced: producedIdentity })?.id,
    singleGitResource(domainContext)?.id,
  );
}

function shouldLocateProducedReviewPr(producedIdentity = null) {
  return Boolean(firstReadyFixString(
    producedIdentity?.pull_request_number,
    producedIdentity?.pr_number,
    producedIdentity?.number,
  ));
}

function shouldUseProducedReviewLocation(location = null) {
  return ["found", "closed", "wrong_base", "multiple"].includes(stringOrNull(location?.status));
}

function latestExecutionRunForReview({ store, issueId } = {}) {
  if (typeof store?.findLatestRunForObject !== "function") return null;
  try {
    return store.findLatestRunForObject(issueId);
  } catch {
    return null;
  }
}

function isExecutionRunInFlightOrRecent(run, {
  now = () => new Date(),
  recentExecutionGraceMs = REVIEW_PR_CREATION_GRACE_MS,
} = {}) {
  if (!run || typeof run !== "object") return false;
  const status = String(run.status || "").trim();
  if (["leased", "running", "queued"].includes(status)) return true;
  const referenceTime = Date.parse(
    run.terminal_at ||
    run.completed_at ||
    run.updated_at ||
    run.started_at ||
    "",
  );
  if (!Number.isFinite(referenceTime)) return false;
  const ageMs = timeMs(now) - referenceTime;
  return ageMs >= 0 && ageMs <= recentExecutionGraceMs;
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

export function gatewayState({ inFlight = null, domainBackoff = null, maxInFlight = 1 } = {}) {
  return {
    inFlight: inFlight || new Set(),
    domainBackoff: domainBackoff || new Map(),
    maxInFlight,
  };
}

export function tryEnterInFlight(state, key) {
  if (state.inFlight.has(key)) return false;        // 1. duplicate-key skip
  if (state.inFlight.size >= state.maxInFlight) return false;  // 2. capacity
  state.inFlight.add(key);                          // 3. add
  return true;
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

function processReplayIssueDecision(options = {}) {
  const {
    domain,
    issueId,
    pending,
    runReplayIssue,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    issueId,
    state: "replaying",
    reason: "git_mutation_intent_pending",
    runId: pending.runId,
    artifactKind: pending.artifactKind,
  });
  launchIssueDispatch({
    ...options,
    issueId,
    state,
    dispatchLabel: "replay",
    run: async () => {
      const replay = await runReplayIssue({
        ...options,
        issueId,
        pending,
        retry: true,
      });
      return {
        action: "replay",
        issueId,
        pending,
        replay,
      };
    },
  });
  return {
    action: "replay",
    status: "started",
    issueId,
    pending,
  };
}

function processWarmResumeIssueDecision(options = {}) {
  const {
    domain,
    issueId,
    decision,
    runWarmResumeIssue,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    issueId,
    state: "resume_working",
    reason: "warm_resume_selected",
    runId: decision.priorRunId,
    prNumber: decision.prNumber,
    headSha: decision.head_sha,
  });
  launchIssueDispatch({
    ...options,
    issueId,
    state,
    dispatchLabel: "warm_resume",
    run: async () => {
      const warmResume = await runWarmResumeIssue({
        ...options,
        issueId,
        priorRunId: decision.priorRunId,
        prNumber: decision.prNumber,
        head_sha: decision.head_sha,
        warmResumeDecision: decision,
      });
      if (isRateLimitedError(options, warmResume?.error)) throw warmResume.error;
      return {
        action: "warm_resume",
        issueId,
        decision,
        result: warmResume,
      };
    },
  });
  return {
    action: "warm_resume",
    status: "started",
    issueId,
    decision,
  };
}

async function applyReadyIssueNeedsPrincipalEscalation({
  client,
  config = null,
  cache = null,
  issueId,
  issueContext = null,
  domainContext = null,
  decision = null,
} = {}) {
  return applyCommitEffects({
    effects: [issueNeedsPrincipalEscalationEffect],
    ctx: {
      client,
      config,
      cache,
      issue: issueContext,
      issueId,
      linearIssueId: issueId,
      domainContext,
      teamId: issueContext?.team?.id || domainContext?.linear?.teamId || null,
      trace: {
        name: "ready_fix_escalation",
        attributes: {
          source_object_id: issueId,
          reason: decision?.reason || null,
        },
        spans: [],
      },
    },
  });
}

function processFreshIssueDecision(options = {}) {
  const {
    domain,
    domainContext,
    issueId,
    fingerprint,
    runFreshIssue,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    issueId,
    state: "working",
    reason: "fresh_execution_selected",
  });
  launchIssueDispatch({
    ...options,
    issueId,
    state,
    dispatchLabel: "fresh",
    run: async () => {
      const fresh = await runFreshIssue({
        ...options,
        issueId,
      });
      if (isRateLimitedError(options, fresh?.error)) throw fresh.error;
      await maybeWriteReadyIssueFreshSuppression({
        ...options,
        domainId: domain.id,
        issueId,
        fingerprint,
        fresh,
        allowedRepoPacket: domainContext?.allowedRepoPacket,
      });
      return {
        action: "fresh",
        issueId,
        fingerprint,
        result: fresh,
      };
    },
  });
  return {
    action: "fresh",
    status: "started",
    issueId,
    fingerprint,
  };
}

function processReviewDecision(options = {}) {
  const {
    domain,
    issueId,
    decision,
    runFreshReview,
    emitStatus,
    state,
  } = options;
  emitStatus({
    domainId: domain.id,
    issueId,
    state: "working",
    reason: decision.action === "review" ? "fresh_review_selected" : "review_escalation_selected",
  });
  launchIssueDispatch({
    ...options,
    issueId,
    state,
    dispatchLabel: decision.action === "review" ? "review" : "review_escalation",
    run: async () => {
      const review = await runFreshReview({
        ...options,
        issueId,
        reviewDecision: decision,
      });
      if (isRateLimitedError(options, review?.error)) throw review.error;
      return {
        action: decision.action,
        issueId,
        decision,
        result: review,
      };
    },
  });
  return {
    action: decision.action,
    status: "started",
    issueId,
    decision,
  };
}

function launchIssueDispatch(options = {}) {
  const {
    domain,
    issueId,
    state,
    emitStatus,
    dispatchLabel,
    run,
  } = options;
  runWithWedgedBackstop({
    ...options,
    domainId: domain.id,
    issueId,
    projectId: null,
    emitStatus,
    run,
  }).catch((error) => {
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
    emitStatus({
      domainId: domain.id,
      issueId,
      state: "degraded",
      reason: error?.message || `${dispatchLabel || "issue"}_dispatch_failed`,
    });
    return {
      action: dispatchLabel || "issue",
      status: "degraded",
      issueId,
      error,
    };
  }).finally(() => {
    state.inFlight.delete(issueId);
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

async function maybeWriteReadyIssueFreshSuppression(options = {}) {
  const {
    domainId,
    issueId,
    fingerprint,
    fresh,
    client,
    config = null,
    cache = null,
    domainContext = null,
    allowedRepoPacket = domainContext?.allowedRepoPacket,
    issueContext = null,
    idempotency = triggerIdempotency,
    computeFingerprint = computeIssueTriggerFingerprint,
    repoRoot = process.cwd(),
    runStoreDir = null,
    now = () => new Date(),
  } = options;
  if (!shouldWriteSuppressionForReadyIssueResult(fresh)) return null;
  let current;
  try {
    current = await client.getIssueContext(issueId);
  } catch (error) {
    if (isRateLimitedError(options, error)) throw error;
    return null;
  }
  const readyStateIds = readyIssueSuppressionStateIds(cache);
  const currentEligibility = isReadyIssueEligible(current, {
    ...readyIssueEligibilityOptions({ config, cache, allowedRepoPacket }),
    readyStateIds,
  });
  if (!currentEligibility.eligible) return null;
  if (!readyStateIds.includes(current?.state?.id)) return null;
  if (!readyIssueSuppressionFingerprintMatches({
    current,
    issueContext,
    fingerprint,
    computeFingerprint,
    cache,
  })) {
    return null;
  }
  return idempotency.writeSuppression({
    domainId,
    objectType: "issue",
    objectId: issueId,
    fingerprint,
    runId: runIdForFreshResult(fresh),
    terminalStatus: fresh.status || fresh.result?.status || "rejected",
    reason: readyIssueResultReason(fresh),
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
    if (!tryEnterInFlight(state, item.projectId)) {
      results.push({ action: "skipped", reason: "project_in_flight", pending: item });
      continue;
    }
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
  issueId = null,
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
        issueId,
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

function assertPollTargetDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error("invalid_poll_target_descriptor: descriptor must be an object");
  }
  for (const field of ["listCandidates", "process", "inFlightKey", "order"]) {
    if (typeof descriptor[field] !== "function") {
      throw new Error(`invalid_poll_target_descriptor: ${field} must be a function`);
    }
  }
  if (typeof descriptor.input_status !== "string" || descriptor.input_status.length === 0) {
    throw new Error("invalid_poll_target_descriptor: input_status must be a non-empty string");
  }
}

export function computeIssueTriggerFingerprint(issueContext) {
  return createHash("sha256")
    .update(canonicalJson(issueTriggerFingerprintProjection(issueContext)))
    .digest("hex");
}

function issueTriggerFingerprintProjection(issue = {}) {
  return {
    id: stringOrNull(issue.id),
    identifier: stringOrNull(issue.identifier),
    title: stringOrNull(issue.title),
    description: stringOrNull(issue.description),
    url: stringOrNull(issue.url),
    state: compactObject({
      id: stringOrNull(issue.state?.id),
      name: stringOrNull(issue.state?.name),
      type: stringOrNull(issue.state?.type),
    }),
    team: compactObject({
      id: stringOrNull(issue.team?.id),
      key: stringOrNull(issue.team?.key),
      name: stringOrNull(issue.team?.name),
    }),
    project: compactObject({
      id: stringOrNull(issue.project?.id),
      name: stringOrNull(issue.project?.name),
      url: stringOrNull(issue.project?.url),
    }),
    assignee: compactObject({
      id: stringOrNull(issue.assignee?.id),
      name: stringOrNull(issue.assignee?.name),
    }),
    labels: (issue.labels || [])
      .map((label) => compactObject({
        id: stringOrNull(label?.id),
        name: stringOrNull(label?.name),
      }))
      .sort(compareCanonicalObjects),
    relations: (issue.relations || [])
      .map((relation) => compactObject({
        id: stringOrNull(relation?.id),
        type: stringOrNull(relation?.type),
        issue: relatedIssueFingerprintProjection(relation?.issue),
        relatedIssue: relatedIssueFingerprintProjection(relation?.relatedIssue),
      }))
      .sort(compareCanonicalObjects),
  };
}

function relatedIssueFingerprintProjection(issue = {}) {
  return compactObject({
    id: stringOrNull(issue?.id),
    identifier: stringOrNull(issue?.identifier),
    title: stringOrNull(issue?.title),
    state: compactObject({
      id: stringOrNull(issue?.state?.id),
      name: stringOrNull(issue?.state?.name),
      type: stringOrNull(issue?.state?.type),
    }),
  });
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function shouldWriteSuppressionForReadyIssueResult(result) {
  if (isDependencyBlockedRunnerResult(result)) return false;
  const reason = readyIssueResultReason(result);
  return READY_ISSUE_SUPPRESSIBLE_REASONS.has(reason);
}

function readyIssueResultReason(result) {
  const candidates = [
    result?.reason,
    result?.result?.reason,
    ...(Array.isArray(result?.failureReasons) ? result.failureReasons : []),
    ...(Array.isArray(result?.result?.failureReasons) ? result.result.failureReasons : []),
  ];
  for (const candidate of candidates) {
    const reason = String(candidate || "").trim();
    if (reason) return reason;
  }
  return "rejected";
}

function shouldWriteSuppressionForFreshResult(result) {
  if (isDependencyBlockedRunnerResult(result)) return false;
  if (result?.status !== "rejected") return false;
  const reason = String(result.reason || result.result?.reason || "");
  if (reason.startsWith("runner_failed_closed:")) return false;
  if (reason.startsWith("runner_failed_after_linear_mutation_started:")) return false;
  if (result.error && !result.eligibility && result.result?.status !== "ineligible") return false;
  return true;
}

function isDependencyBlockedRunnerResult(result) {
  return [result, result?.result].some((entry) => {
    const reason = String(entry?.reason || "");
    if (reason === "dependency_blocked" || reason.startsWith("dependency_blocked:")) return true;
    if (entry?.status === "ineligible" && (reason === "blocked" || reason.startsWith("blocked:"))) {
      return true;
    }
    const eligibility = entry?.eligibility;
    if (Array.isArray(eligibility?.blockingIssueIds) && eligibility.blockingIssueIds.length > 0) {
      return true;
    }
    return Array.isArray(eligibility?.blockingConditions)
      && eligibility.blockingConditions.some((condition) => String(condition).startsWith("dependency_blocked"));
  });
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

function compareCreatedAt(a, b) {
  const aTime = Date.parse(a || "");
  const bTime = Date.parse(b || "");
  const aSort = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
  const bSort = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
  return aSort - bSort;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCanonicalObjects(a, b) {
  return canonicalJson(a).localeCompare(canonicalJson(b));
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => {
      if (entry === null || entry === undefined) return false;
      if (Array.isArray(entry)) return entry.length > 0;
      if (typeof entry === "object") return Object.keys(entry).length > 0;
      return true;
    }),
  );
}

function isRecordLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
