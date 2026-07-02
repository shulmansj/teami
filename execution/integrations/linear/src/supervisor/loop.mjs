import { scanPromotionCandidates } from "../promotion-candidate-scanner.mjs";

import {
  runSupervisorAutonomousDiagnosisScanStep,
  runSupervisorExportStep,
  runSupervisorRunnerStep,
  runSupervisorScannerStep,
} from "./jobs.mjs";
import { preflightLocalSupervisor } from "./preflight.mjs";
import { readLocalSupervisorDisable } from "./registration.mjs";
import {
  localSupervisorStatePath,
  readSupervisorState,
  writeSupervisorState,
} from "./state-store.mjs";

const DEFAULT_CRASH_BACKOFF_BASE_MS = 30_000;
const DEFAULT_CRASH_BACKOFF_MAX_MS = 15 * 60_000;
const DEFAULT_LOOP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ITERATIONS = 1;

export async function runLocalSupervisorLoop({
  repoRoot = process.cwd(),
  config,
  cachePath,
  runRunnerOnce = null,
  scanPromotionCandidatesFn = scanPromotionCandidates,
  allowGatewayWakeClaims = false,
  env = process.env,
  now = () => new Date(),
  sleep = defaultSleep,
  maxIterations = null,
  intervalMs = null,
  onProgress = () => {},
} = {}) {
  const settings = resolveLocalSupervisorSettings({ config, env, maxIterations, intervalMs });
  const iterations = [];
  for (let index = 0; index < settings.max_iterations; index += 1) {
    const iteration = await runLocalSupervisorIteration({
      repoRoot,
      config,
      cachePath,
      runRunnerOnce,
      scanPromotionCandidatesFn,
      allowGatewayWakeClaims,
      env,
      now,
      onProgress,
      settings,
    });
    iterations.push(iteration);
    if (iteration.status === "disabled" || iteration.status === "blocked" || iteration.status === "backoff") {
      break;
    }
    if (index < settings.max_iterations - 1) {
      await sleep(settings.interval_ms);
    }
  }
  const last = iterations.at(-1) || { ok: true, status: "idle" };
  return {
    ok: iterations.every((iteration) => iteration.ok !== false),
    status: last.status,
    iterations,
    state_path: localSupervisorStatePath(repoRoot),
  };
}

export async function runLocalSupervisorIteration({
  repoRoot = process.cwd(),
  config,
  cachePath,
  runRunnerOnce = null,
  scanPromotionCandidatesFn = scanPromotionCandidates,
  allowGatewayWakeClaims = false,
  env = process.env,
  now = () => new Date(),
  onProgress = () => {},
  settings = resolveLocalSupervisorSettings({ config, env }),
} = {}) {
  const started = now();
  const startedAt = started.toISOString();
  const disable = readLocalSupervisorDisable({ repoRoot, env });
  if (disable.disabled) {
    const iteration = {
      ok: true,
      status: "disabled",
      reason: disable.reason,
      started_at: startedAt,
      finished_at: startedAt,
      disabled: disable,
    };
    writeSupervisorState({ repoRoot, now, patch: { status: "disabled", last_iteration: iteration } });
    return iteration;
  }

  const backoff = currentCrashBackoff({ repoRoot, now });
  if (backoff.active) {
    const iteration = {
      ok: false,
      status: "backoff",
      reason: "crash_loop_backoff_active",
      started_at: startedAt,
      finished_at: startedAt,
      next_allowed_start_at: backoff.next_allowed_start_at,
      consecutive_failure_count: backoff.consecutive_failure_count,
    };
    writeSupervisorState({ repoRoot, now, patch: { status: "backoff", last_iteration: iteration } });
    return iteration;
  }

  const preflight = await preflightLocalSupervisor({
    repoRoot,
    config,
    cachePath,
  });
  if (!preflight.ok) {
    const finishedAt = now().toISOString();
    const iteration = {
      ok: false,
      status: "blocked",
      reason: "supervisor_preflight_failed",
      started_at: startedAt,
      finished_at: finishedAt,
      checks: preflight.checks,
    };
    writeSupervisorState({
      repoRoot,
      now,
      patch: {
        status: "blocked",
        last_iteration: iteration,
        last_preflight: preflight.checks,
      },
    });
    return iteration;
  }

  try {
    onProgress("local supervisor: preflight passed");
    const runner = await runSupervisorRunnerStep({
      allowGatewayWakeClaims,
      runRunnerOnce,
      disable,
      onProgress,
    });
    const scanner = await runSupervisorScannerStep({
      scanPromotionCandidatesFn,
      repoRoot,
      disable,
      onProgress,
    });
    const exportJob = await runSupervisorExportStep({
      repoRoot,
      disable,
      onProgress,
    });
    const autonomousDiagnosisScan = await runSupervisorAutonomousDiagnosisScanStep({
      repoRoot,
      disable,
      onProgress,
    });
    const finishedAt = now().toISOString();
    const degraded =
      scanner.ok === false ||
      runner.ok === false ||
      exportJob.ok === false ||
      autonomousDiagnosisScan.ok === false;
    const iteration = {
      ok: !degraded,
      status: degraded ? "degraded" : "ok",
      started_at: startedAt,
      finished_at: finishedAt,
      runner,
      scanner,
      export: exportJob,
      autonomous_diagnosis_scan: autonomousDiagnosisScan,
      checks: preflight.checks,
    };
    writeSupervisorState({
      repoRoot,
      now,
      patch: {
        status: iteration.status,
        last_iteration: iteration,
        last_preflight: preflight.checks,
        crash_loop: {
          consecutive_failure_count: 0,
          next_allowed_start_at: null,
          last_error: null,
        },
      },
    });
    return iteration;
  } catch (error) {
    return recordSupervisorCrash({ repoRoot, now, startedAt, error, settings });
  }
}

function resolveLocalSupervisorSettings({
  config,
  env = process.env,
  maxIterations = null,
  intervalMs = null,
} = {}) {
  const configured = config?.local_supervisor || config?.supervisor || {};
  return {
    max_iterations: positiveInteger(
      maxIterations,
      positiveInteger(configured.max_iterations, DEFAULT_MAX_ITERATIONS),
    ),
    interval_ms: nonNegativeInteger(
      intervalMs,
      nonNegativeInteger(configured.interval_ms, DEFAULT_LOOP_INTERVAL_MS),
    ),
    crash_backoff_base_ms: positiveInteger(
      env.TEAMI_SUPERVISOR_CRASH_BACKOFF_BASE_MS,
      positiveInteger(configured.crash_backoff_base_ms, DEFAULT_CRASH_BACKOFF_BASE_MS),
    ),
    crash_backoff_max_ms: positiveInteger(
      env.TEAMI_SUPERVISOR_CRASH_BACKOFF_MAX_MS,
      positiveInteger(configured.crash_backoff_max_ms, DEFAULT_CRASH_BACKOFF_MAX_MS),
    ),
  };
}

function currentCrashBackoff({ repoRoot = process.cwd(), now = () => new Date() } = {}) {
  const state = readSupervisorState({ repoRoot });
  const crashLoop = state.ok ? state.state.crash_loop || {} : {};
  const next = crashLoop.next_allowed_start_at || null;
  if (!next) {
    return { active: false, consecutive_failure_count: crashLoop.consecutive_failure_count || 0 };
  }
  const nextMs = Date.parse(next);
  const nowMs = now().getTime();
  return {
    active: Number.isFinite(nextMs) && nextMs > nowMs,
    next_allowed_start_at: next,
    consecutive_failure_count: crashLoop.consecutive_failure_count || 0,
  };
}

function recordSupervisorCrash({ repoRoot, now, startedAt, error, settings }) {
  const observed = now();
  const prior = readSupervisorState({ repoRoot });
  const priorCount = prior.ok ? prior.state.crash_loop?.consecutive_failure_count || 0 : 0;
  const consecutive = priorCount + 1;
  const delayMs = Math.min(
    settings.crash_backoff_max_ms,
    settings.crash_backoff_base_ms * (2 ** Math.max(0, consecutive - 1)),
  );
  const nextAllowed = new Date(observed.getTime() + delayMs).toISOString();
  const iteration = {
    ok: false,
    status: "failed",
    reason: "supervisor_iteration_crashed",
    detail: error?.message || String(error),
    started_at: startedAt,
    finished_at: observed.toISOString(),
    next_allowed_start_at: nextAllowed,
    consecutive_failure_count: consecutive,
  };
  writeSupervisorState({
    repoRoot,
    now,
    patch: {
      status: "backoff",
      last_iteration: iteration,
      crash_loop: {
        consecutive_failure_count: consecutive,
        next_allowed_start_at: nextAllowed,
        last_error: iteration.detail,
      },
    },
  });
  return iteration;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
