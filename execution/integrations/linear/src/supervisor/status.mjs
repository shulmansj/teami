import {
  defaultPromotionCandidateLedgerDir,
  promotionScannerHealthPath,
} from "../promotion-candidate-scanner.mjs";

import { preflightLocalSupervisor } from "./preflight.mjs";
import {
  collectNextResumeReconciliation,
  formatNextResumeReconciliationReport,
  formatPmStateCounts,
} from "./reconciliation.mjs";
import {
  readLocalSupervisorDisable,
  readLocalSupervisorRegistration,
} from "./registration.mjs";
import {
  localSupervisorDisablePath,
  localSupervisorRegistrationPath,
  localSupervisorStatePath,
  readJsonIfExists,
  readSupervisorState,
} from "./state-store.mjs";

export async function localSupervisorDoctorChecks({
  repoRoot = process.cwd(),
  config,
  cachePath,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const status = await readLocalSupervisorStatus({
    repoRoot,
    config,
    cachePath,
    env,
    now,
  });
  const checks = [];
  checks.push({
    name: "local supervisor OS autostart",
    ok: false,
    message:
      "DRY-RUN only: no OS login/autostart item is registered; supervisor:run remains an operator command.",
  });
  checks.push({
    name: "local supervisor disabled flag",
    ok: !status.disable.disabled,
    message: status.disable.disabled ? `disabled (${status.disable.reason})` : "not disabled",
  });
  // Preflight checks already carry the "local supervisor" prefix; surface them as-is (no second
  // prefix) and let the preflight consent check be the single source of truth for consent.
  for (const check of status.preflight.checks) {
    checks.push({ name: check.name, ok: check.ok, message: check.message });
  }
  const blockedCount = status.reconciliation.summary.by_pm_state["Blocked but safe"] || 0;
  checks.push({
    name: "next-resume reconciliation",
    ok: blockedCount === 0,
    message: formatPmStateCounts(status.reconciliation.summary.by_pm_state),
  });
  return checks;
}

export async function readLocalSupervisorStatus({
  repoRoot = process.cwd(),
  config,
  cachePath,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const registration = readLocalSupervisorRegistration({ repoRoot });
  const disable = readLocalSupervisorDisable({ repoRoot, env });
  const state = readSupervisorState({ repoRoot });
  const scannerHealthPath = promotionScannerHealthPath(defaultPromotionCandidateLedgerDir(repoRoot));
  const scannerHealth = readJsonIfExists(scannerHealthPath);
  const preflight = await preflightLocalSupervisor({
    repoRoot,
    config,
    cachePath,
  });
  const reconciliation = await collectNextResumeReconciliation({
    repoRoot,
    now,
  });
  return {
    ok: preflight.ok && !disable.disabled,
    registration,
    disable,
    state,
    state_path: localSupervisorStatePath(repoRoot),
    registration_path: localSupervisorRegistrationPath(repoRoot),
    disable_path: localSupervisorDisablePath(repoRoot),
    scanner_health_path: scannerHealthPath,
    scanner_health: scannerHealth,
    preflight,
    reconciliation,
  };
}

export function formatLocalSupervisorRegistrationReport(result) {
  if (!result.ok) {
    return [`local supervisor registration BLOCKED: ${result.reason}`, `  ${result.detail}`];
  }
  return [
    "local supervisor registration DRY-RUN: consent recorded",
    `  registration: ${result.registration_path}`,
    "  OS autostart: not registered (stubbed_no_os_write)",
    "  command when real keep-alive is enabled: npm run supervisor:run",
  ];
}

export function formatLocalSupervisorDisableReport(result) {
  if (result.disabled) {
    return [
      "local supervisor disabled",
      `  disable flag: ${result.disable_path}`,
      `  reason: ${result.record.reason}`,
    ];
  }
  return [
    "local supervisor enabled",
    `  disable flag removed: ${result.removed ? "yes" : "already clean"}`,
  ];
}

export function formatLocalSupervisorCleanupReport(result) {
  const lines = [];
  for (const removed of result.removed) lines.push(`removed: ${removed.label}`);
  for (const clean of result.already_clean) lines.push(`already clean: ${clean.label}`);
  lines.push(result.todo);
  return lines;
}

export function formatLocalSupervisorRunReport(result) {
  const lines = [];
  lines.push(`local supervisor ${String(result.status || "unknown").toUpperCase()}: ${result.iterations.length} iteration(s)`);
  lines.push(`  state: ${result.state_path}`);
  for (const [index, iteration] of result.iterations.entries()) {
    lines.push(
      `  iteration ${index + 1}: ${iteration.status}${iteration.reason ? ` (${iteration.reason})` : ""}`,
    );
    if (iteration.next_allowed_start_at) {
      lines.push(`    next allowed start: ${iteration.next_allowed_start_at}`);
    }
    if (iteration.runner) {
      lines.push(`    runner: ${iteration.runner.status}${iteration.runner.reason ? ` (${iteration.runner.reason})` : ""}`);
    }
    if (iteration.scanner) {
      lines.push(`    scanner: ${iteration.scanner.status}${iteration.scanner.reason ? ` (${iteration.scanner.reason})` : ""}`);
    }
  }
  return lines;
}

export function formatLocalSupervisorStatusReport(status) {
  const lines = [];
  lines.push(`local supervisor registration: ${status.registration.ok ? status.registration.registration.status : "missing"}`);
  lines.push("OS autostart: not registered (dry-run stub)");
  lines.push(`disabled: ${status.disable.disabled ? `yes (${status.disable.reason})` : "no"}`);
  lines.push(`state: ${status.state.ok ? status.state.state.status : "missing"} (${status.state_path})`);
  if (status.state.ok && status.state.state.crash_loop?.next_allowed_start_at) {
    lines.push(`crash backoff until: ${status.state.state.crash_loop.next_allowed_start_at}`);
  }
  lines.push(`scanner health: ${status.scanner_health ? status.scanner_health.status : "missing"} (${status.scanner_health_path})`);
  for (const check of status.preflight.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`);
  }
  if (status.reconciliation) {
    lines.push(...formatNextResumeReconciliationReport(status.reconciliation));
  }
  return lines;
}
