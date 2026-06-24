export const LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON =
  "hosted_wake_claims_disabled_by_default";

async function runSupervisorRunnerStep({
  allowHostedWakeClaims,
  runRunnerOnce,
  disable,
  onProgress,
}) {
  if (disable.runner_disabled) {
    return { ok: true, status: "skipped", reason: "runner_disabled" };
  }
  if (allowHostedWakeClaims !== true) {
    return {
      ok: true,
      status: "skipped",
      reason: LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON,
      detail:
        "Hosted wake claims are disabled by default; supervisor default never claims hosted wakes without explicit enablement.",
    };
  }
  if (typeof runRunnerOnce !== "function") {
    return { ok: false, status: "blocked", reason: "foreground_runner_not_wired" };
  }
  onProgress("local supervisor: running foreground runner codepath");
  const result = await runRunnerOnce();
  return {
    ok: ["completed", "paused", "rejected", "idle"].includes(result.status),
    status: result.status,
    reason: result.reason || null,
    trace_status: result.traceDelivery?.status || null,
  };
}

async function runSupervisorScannerStep({
  scanPromotionCandidatesFn,
  repoRoot,
  disable,
  onProgress,
}) {
  if (disable.scanner_disabled) {
    return { ok: true, status: "skipped", reason: "scanner_disabled" };
  }
  onProgress("local supervisor: running promotion scanner through Step 12 lock");
  const result = await scanPromotionCandidatesFn({ repoRoot, onProgress });
  return {
    ok: result.ok !== false,
    status: result.status || (result.ok === false ? "failed" : "ok"),
    reason: result.reason || null,
    scan_id: result.scan_id || null,
    candidate_count: Array.isArray(result.candidates) ? result.candidates.length : null,
    ledger_path: result.ledger_path || null,
    health_path: result.health_path || null,
  };
}

export {
  runSupervisorRunnerStep,
  runSupervisorScannerStep,
};
