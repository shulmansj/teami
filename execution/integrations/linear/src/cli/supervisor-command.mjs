import fs from "node:fs";

import { resolveForegroundDomainCache } from "../domain-command-context.mjs";
import { domainRegistryPath } from "../domain-registry.mjs";
import {
  cleanupLocalSupervisorLocalState,
  collectNextResumeReconciliation,
  LOCAL_SUPERVISOR_CONSENT_FLAG,
  readLocalSupervisorStatus,
  registerLocalSupervisorStub,
  runLocalSupervisorLoop,
  setLocalSupervisorDisabled,
} from "../local-supervisor.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { hasCliFlag, parseCliFlags } from "./flags.mjs";
import {
  agenticFactoryHeading,
  compactPairs,
  humanizeToken,
  printVerboseHint,
} from "./operator-output.mjs";
import {
  renderNextResumeReconciliationReport,
} from "./runner-command.mjs";
function resolveSupervisorCommandContext({
  config,
  repoRoot,
  cachePath,
  domainId = null,
}) {
  if (!fs.existsSync(domainRegistryPath(repoRoot))) {
    return {
      config,
      cachePath,
      domainId: null,
    };
  }
  const foreground = resolveForegroundDomainCache({ config, repoRoot, domainId });
  return {
    config: foreground.config,
    cachePath: foreground.cachePath,
    domainId: foreground.context.domainId,
  };
}

export async function runSupervisorRegisterCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor register");
    let result;
    try {
    const { flags } = parseCliFlags(args);
    result = registerLocalSupervisorStub({
      repoRoot,
      explicitConsent: hasCliFlag(flags, LOCAL_SUPERVISOR_CONSENT_FLAG),
      trigger: "manual",
    });
    } catch (error) {
      output.error({
        what: "Supervisor registration could not run",
        why: redactOAuthSecrets(error.message),
        fix: "check local supervisor state paths and retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorRegistrationResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runSupervisorRunCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor run");
    let result;
    try {
    const { flags } = parseCliFlags(args);
    const maxIterations = flags["max-iterations"] === undefined ? null : Number(flags["max-iterations"]);
    const intervalMs = flags["interval-ms"] === undefined ? null : Number(flags["interval-ms"]);
    const supervisorContext = resolveSupervisorCommandContext({
      config,
      repoRoot,
      cachePath,
      domainId: flags.domain || null,
    });
    result = await runLocalSupervisorLoop({
      repoRoot,
      config: supervisorContext.config,
      cachePath: supervisorContext.cachePath,
      maxIterations,
      intervalMs,
      onProgress: (line) => output.detail(line),
    });
    } catch (error) {
      output.error({
        what: "Supervisor run could not start",
        why: redactOAuthSecrets(error.message),
        fix: "repair supervisor registration, active domain selection, or runner credentials, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorRunResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runSupervisorStatusCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor status");
    let status;
    try {
    const { flags } = parseCliFlags(args);
    const supervisorContext = resolveSupervisorCommandContext({
      config,
      repoRoot,
      cachePath,
      domainId: flags.domain || null,
    });
    status = await readLocalSupervisorStatus({
      repoRoot,
      config: supervisorContext.config,
      cachePath: supervisorContext.cachePath,
    });
    } catch (error) {
      output.error({
        what: "Supervisor status could not be read",
        why: redactOAuthSecrets(error.message),
        fix: "run npm run init or pass --domain for an active configured domain, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorStatus(status, output);
    if (status.ok) printVerboseHint(output);
    process.exitCode = status.ok ? 0 : 1;
}
export async function runSupervisorReconcileCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor reconcile");
    let report;
    try {
    const { flags } = parseCliFlags(args);
    const supervisorContext = resolveSupervisorCommandContext({
      config,
      repoRoot,
      cachePath,
      domainId: flags.domain || null,
    });
    report = await collectNextResumeReconciliation({
      repoRoot,
    });
    } catch (error) {
      output.error({
        what: "Supervisor reconciliation could not run",
        why: redactOAuthSecrets(error.message),
        fix: "repair domain registry or local run evidence access, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    if (!report.ok) {
      output.error({
        what: "Next-resume reconciliation needs operator attention",
        why: "One or more resume targets are in a safe-stop state.",
        fix: "review the resume targets below and resume or repair the affected work item.",
      });
    }
    renderNextResumeReconciliationReport(report, output);
    if (report.ok) printVerboseHint(output);
    process.exitCode = report.ok ? 0 : 1;
}
export async function runSupervisorDisableCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor disable");
    let result;
    try {
    const { positionals, flags } = parseCliFlags(args);
    result = setLocalSupervisorDisabled({
      repoRoot,
      disabled: true,
      reason: flags.reason || positionals.join(" ") || "operator_disabled",
    });
    } catch (error) {
      output.error({
        what: "Supervisor could not be disabled",
        why: redactOAuthSecrets(error.message),
        fix: "check write access to local supervisor state and retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorDisableResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runSupervisorEnableCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor enable");
    let result;
    try {
      result = setLocalSupervisorDisabled({ repoRoot, disabled: false });
    } catch (error) {
      output.error({
        what: "Supervisor could not be enabled",
        why: redactOAuthSecrets(error.message),
        fix: "check write access to local supervisor state and retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorDisableResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runSupervisorUnregisterCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "supervisor unregister");
    let result;
    try {
      result = cleanupLocalSupervisorLocalState({ repoRoot });
    } catch (error) {
      output.error({
        what: "Supervisor registration could not be removed",
        why: redactOAuthSecrets(error.message),
        fix: "check local supervisor state paths and retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderLocalSupervisorCleanupResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}

function renderLocalSupervisorRegistrationResult(result, output) {
  if (!result.ok) {
    output.error({
      what: "Supervisor registration requires explicit consent",
      why: result.detail || result.reason,
      fix: `npm run supervisor:register -- --${LOCAL_SUPERVISOR_CONSENT_FLAG}`,
    });
    output.detail(`reason=${result.reason || "unknown"}`);
    return;
  }
  output.success("Supervisor registration recorded.");
  output.keyValues(compactPairs([
    ["Registration", result.registration_path],
    ["Status", humanizeToken(result.registration?.status)],
    ["OS autostart", result.registration?.os_registration?.will_write_os ? "will write" : "not registered"],
    ["Run command", result.registration?.os_registration?.command || "npm run supervisor:run"],
  ]), { heading: "Registration" });
  output.warn(result.registration?.os_registration?.todo || "OS autostart is not registered by this dry-run stub.");
  output.detail(`authorized_capabilities=${(result.registration?.authorized_capabilities || []).join(",")}`);
  output.detail(`forbidden_capabilities=${(result.registration?.forbidden_capabilities || []).join(",")}`);
}

function renderLocalSupervisorRunResult(result, output) {
  if (result.ok) output.success(`Supervisor run completed: ${result.iterations.length} iteration(s)`);
  else {
    output.error({
      what: "Supervisor run needs attention",
      why: supervisorRunWhy(result),
      fix: "inspect the iteration details below, repair the reported cause, then rerun supervisor:run.",
    });
  }
  output.keyValues(compactPairs([
    ["State", result.state_path],
    ["Iterations", result.iterations.length],
  ]), { heading: "Run" });
  output.section("Iterations");
  if (result.iterations.length === 0) {
    output.success("No iterations were needed.");
    return;
  }
  result.iterations.forEach((iteration, index) => {
    const headline = `Iteration ${index + 1}: ${operatorSupervisorStatusLabel(iteration.status)}`;
    if (iteration.ok === false) output.warn(headline);
    else output.success(headline);
    output.keyValues(compactPairs([
      ["Reason", iteration.reason],
      ["Next start", iteration.next_allowed_start_at],
      ["Runner", supervisorStepSummary(iteration.runner)],
      ["Scanner", supervisorStepSummary(iteration.scanner)],
      ["Export", supervisorStepSummary(iteration.export)],
    ]));
    output.detail(`iteration=${redactOAuthSecrets(JSON.stringify(iteration))}`);
  });
}

function supervisorRunWhy(result) {
  if (result.status === "blocked") return "preflight checks need attention";
  if (result.status === "backoff") return "crash-loop backoff is active";
  if (result.status === "failed") return "the supervisor iteration crashed";
  return result.status ? operatorSupervisorStatusLabel(result.status) : "supervisor run did not complete cleanly";
}

function operatorSupervisorStatusLabel(status) {
  if (status === "blocked") return "needs attention";
  if (status === "backoff") return "waiting for crash backoff";
  return humanizeToken(status);
}

function renderLocalSupervisorStatus(status, output) {
  if (status.ok) output.success("Supervisor is ready.");
  else {
    output.error({
      what: "Supervisor status needs attention",
      why: supervisorStatusWhy(status),
      fix: "register or enable the supervisor, repair failing preflight checks, then rerun supervisor:status.",
    });
  }
  output.keyValues(compactPairs([
    ["Registration", status.registration.ok ? humanizeToken(status.registration.registration.status) : "missing"],
    ["Registration path", status.registration_path],
    ["OS autostart", "not registered (dry-run stub)"],
    ["Disabled", status.disable.disabled ? `yes (${status.disable.reason})` : "no"],
    ["State", status.state.ok ? humanizeToken(status.state.state.status) : "missing"],
    ["State path", status.state_path],
    ["Scanner health", status.scanner_health ? humanizeToken(status.scanner_health.status) : "missing"],
    ["Scanner health path", status.scanner_health_path],
  ]), { heading: "Status" });
  if (status.state.ok && status.state.state.crash_loop?.next_allowed_start_at) {
    output.warn(`Crash backoff until ${status.state.state.crash_loop.next_allowed_start_at}`);
  }
  output.section("Preflight");
  for (const check of status.preflight.checks) {
    if (check.ok) output.success(`${check.name}: ${check.message}`);
    else output.warn(`${check.name}: ${check.message}`);
  }
  if (status.reconciliation) renderNextResumeReconciliationReport(status.reconciliation, output);
  output.detail(`registration=${redactOAuthSecrets(JSON.stringify(status.registration))}`);
  output.detail(`disable=${redactOAuthSecrets(JSON.stringify(status.disable))}`);
  output.detail(`state=${redactOAuthSecrets(JSON.stringify(status.state))}`);
}

function supervisorStatusWhy(status) {
  const failures = [];
  if (!status.registration.ok) failures.push(status.registration.reason || "registration missing");
  if (status.disable.disabled) failures.push(`disabled: ${status.disable.reason}`);
  for (const check of status.preflight.checks || []) {
    if (!check.ok) failures.push(`${check.name}: ${check.message}`);
  }
  if (status.reconciliation && !status.reconciliation.ok) failures.push("next-resume work needs attention");
  return failures.join("\n") || "Supervisor status is not ready.";
}

function renderLocalSupervisorDisableResult(result, output) {
  if (result.disabled) {
    output.success("Supervisor disabled.");
    output.keyValues(compactPairs([
      ["Disable flag", result.disable_path],
      ["Reason", result.record?.reason],
    ]), { heading: "Disable" });
    return;
  }
  output.success("Supervisor enabled.");
  output.keyValues([
    ["Disable flag removed", result.removed ? "yes" : "already clean"],
    ["Disable flag", result.disable_path],
  ], { heading: "Enable" });
}

function renderLocalSupervisorCleanupResult(result, output) {
  output.success("Supervisor local state cleaned up.");
  output.keyValues([
    ["Removed", result.removed.length],
    ["Already clean", result.already_clean.length],
  ], { heading: "Cleanup" });
  for (const removed of result.removed) output.success(`Removed ${removed.label}`);
  for (const clean of result.already_clean) output.success(`Already clean: ${clean.label}`);
  if (result.todo) output.warn(result.todo);
  output.detail(`removed=${redactOAuthSecrets(JSON.stringify(result.removed))}`);
  output.detail(`already_clean=${redactOAuthSecrets(JSON.stringify(result.already_clean))}`);
}

function supervisorStepSummary(step) {
  if (!step) return null;
  return `${humanizeToken(step.status)}${step.reason ? ` (${step.reason})` : ""}`;
}
export {
  resolveSupervisorCommandContext,
};
