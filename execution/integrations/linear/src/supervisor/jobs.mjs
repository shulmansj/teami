import { runAutonomousDiagnosisScan } from "../autonomous-diagnosis.mjs";
import { runFixtureDatasetExport } from "../fixture-dataset-exporter.mjs";

export const LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON =
  "gateway_autostart_deferred";

async function runSupervisorRunnerStep({
  allowGatewayWakeClaims,
  runRunnerOnce,
  disable,
  onProgress,
}) {
  if (disable.runner_disabled) {
    return { ok: true, status: "skipped", reason: "runner_disabled" };
  }
  if (allowGatewayWakeClaims !== true) {
    return {
      ok: true,
      status: "skipped",
      reason: LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON,
      detail:
        "Gateway autostart is deferred; run npm run gateway as the operator-controlled poll loop.",
    };
  }
  if (typeof runRunnerOnce !== "function") {
    return { ok: false, status: "blocked", reason: "foreground_runner_not_wired" };
  }
  onProgress("local supervisor: running local gateway codepath");
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

async function runSupervisorExportStep({
  repoRoot,
  disable = {},
  runFixtureDatasetExportFn = runFixtureDatasetExport,
  onProgress = () => {},
} = {}) {
  if (disable.export_disabled) {
    return { ok: true, status: "skipped", reason: "export_disabled" };
  }
  onProgress("local supervisor: running fixture dataset export");
  const result = await runFixtureDatasetExportFn({ repoRoot, onProgress });
  return {
    ok: result.ok !== false,
    status: result.status || (result.ok === false ? "blocked" : "completed"),
    reason: result.reason || null,
    export_id: result.export_id || null,
    manifest_path: result.manifest_path || null,
    jsonl_path: result.jsonl_path || null,
    log_path: result.log_path || null,
    row_count: result.row_count ?? null,
    re_prompt_required: result.re_prompt_required === true,
  };
}

async function runSupervisorAutonomousDiagnosisScanStep({
  repoRoot,
  disable = {},
  runAutonomousDiagnosisScanFn = runAutonomousDiagnosisScan,
  onProgress = () => {},
} = {}) {
  if (disable.autonomous_diagnosis_scan_disabled) {
    return { ok: true, status: "skipped", reason: "autonomous_diagnosis_scan_disabled" };
  }
  onProgress("local supervisor: running autonomous diagnosis scan");
  const result = await runAutonomousDiagnosisScanFn({ repoRoot, onProgress });
  return {
    ok: result.ok !== false,
    status: result.status || (result.ok === false ? "blocked" : "completed"),
    reason: result.reason || null,
    diagnosed_count: result.diagnosed_count ?? result.diagnosis_pass?.diagnosed_count ?? null,
    scanned_count: result.scanned_count ?? null,
    opened_pr_count: result.opened_pr_count ?? null,
    skipped_count: result.skipped_count ?? null,
    drafted_no_pr_count: result.drafted_no_pr_count ?? null,
  };
}

export {
  runSupervisorAutonomousDiagnosisScanStep,
  runSupervisorExportStep,
  runSupervisorRunnerStep,
  runSupervisorScannerStep,
};
