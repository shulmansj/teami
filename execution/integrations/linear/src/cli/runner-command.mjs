import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { emptyDomainRegistry, readDomainRegistry } from "../domain-registry.mjs";
import { readLocalEvalInputs } from "../eval-status.mjs";
import {
  runGatewayLoop,
  runGatewayOnce,
  selectGatewayDomains,
} from "../gateway-loop.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { normalizeLocalPhoenixAppUrl } from "../local-phoenix-manager.mjs";
import {
  runRuntimeSmokeChecks,
} from "../runtime-smoke.mjs";
import { flagValue, parseCliFlags } from "./flags.mjs";
import { homeStateProbe } from "./home-state.mjs";
import {
  agenticFactoryHeading,
  compactPairs,
  formatCommand,
  humanizeInterval,
  humanizeToken,
  printVerboseHint,
} from "./operator-output.mjs";

const DEFAULT_DOMAIN_RUNNER_LOCK_STALE_MS = 30 * 60 * 1000;
const GATEWAY_SUCCESS_STATUSES = new Set(["completed", "stopped"]);
const ATTENTION_STATES = new Set(["rate_limited", "wedged", "degraded", "resume_attention"]);
const ACTIVE_STATES = new Set(["replaying", "working", "resume_working"]);

export async function runGatewayCommand(input) {
  const { context, command, args } = input;
  const { output } = context;
  const [subcommand, ...rest] = args;
  if (command === "trigger-status") {
    // Operator one-pass: actively drains replay + polls Linear "Planned" (can start work).
    return runGatewayStatusCommand({ context, command, args });
  }
  if (subcommand === "status") {
    // Adopter "is it on?" surface — strictly read-only: no poll, replay, or decomposition.
    return runGatewayStatusReadOnly({ context, args: rest });
  }
  if (subcommand && !subcommand.startsWith("--")) {
    output.error({
      what: "Usage: npm run gateway -- [status] [--domain <id>]",
      why: `Unknown gateway subcommand: ${subcommand}`,
    });
    process.exitCode = 2;
    return;
  }
  return runGatewayLoopCommand(input);
}

export async function runRunnerCommand(input) {
  return runGatewayCommand(input);
}

export async function runTriggerStatusCommand(input) {
  return runGatewayStatusCommand(input);
}

function gatewayWatchLine() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `still watching (${hh}:${mm}) - nothing Planned yet`;
}

async function runGatewayLoopCommand({ context, args, loop = runGatewayLoop }) {
  const { config, repoRoot, output } = context;
  agenticFactoryHeading(output, "gateway");
  let selection;
  let result;
  const { flags } = parseCliFlags(args);
  const maxIterations = flags["max-iterations"] === undefined ? null : Number(flags["max-iterations"]);
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  const onSigterm = () => controller.abort();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  // Live "still watching" heartbeat for the long wait: an animated spinner on a TTY, durable
  // per-tick lines when piped/CI. Self-ticking (the loop emits no idle-poll event); cleaned up in
  // finally. The heartbeat installs no signal handler and never changes the exit code, so the
  // loop's existing Ctrl-C handling is untouched.
  let heartbeat = null;
  let ticker = null;
  try {
    selection = resolveGatewaySelection({
      repoRoot,
      config,
      domainId: flags.domain || null,
    });
    const intervalMs = config.poll?.interval_ms || 10_000;
    output.info(`Watching Linear for Planned projects. Polling every ${humanizeInterval(intervalMs)}; stop with Ctrl-C.`);
    heartbeat = output.progress(gatewayWatchLine());
    ticker = setInterval(() => heartbeat?.update(gatewayWatchLine()), intervalMs);
    if (typeof ticker.unref === "function") ticker.unref();
    result = await loop({
      repoRoot,
      config,
      registry: selection.registry,
      domains: selection.domains,
      signal: controller.signal,
      maxIterations,
      onStatus: (event) => {
        // Clear the live heartbeat, print the activity durably, then resume watching.
        heartbeat?.stop();
        renderGatewayStatusEvent(event, output);
        heartbeat = output.progress(gatewayWatchLine());
      },
    });
  } catch (error) {
    output.error({
      what: "Gateway could not start",
      why: redactOAuthSecrets(error.message),
      fix: "run npm run init or pass --domain for an active domain, then retry.",
    });
    process.exitCode = 1;
    return;
  } finally {
    if (ticker) clearInterval(ticker);
    heartbeat?.stop();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  renderGatewayCompletion(result, output);
  if (result.ok) printVerboseHint(output);
  process.exitCode = gatewayExitCode(result);
}

async function runGatewayStatusCommand({ context, args }) {
  const { config, repoRoot, output } = context;
  agenticFactoryHeading(output, "gateway status");
  const { flags } = parseCliFlags(args);
  if (flags.requeue || flagValue(args, "--requeue")) {
    output.error({
      what: "Hosted wake requeue is retired",
      why: "The local gateway repairs persisted runs by run_id; remote requeue is no longer available.",
      fix: "Repair by run_id: inspect the run below, then rerun the gateway so pending commit/pause intents replay idempotently.",
    });
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    const selection = resolveGatewaySelection({
      repoRoot,
      config,
      domainId: flags.domain || null,
    });
    result = await runGatewayOnce({
      repoRoot,
      config,
      registry: selection.registry,
      domains: selection.domains,
    });
  } catch (error) {
    output.error({
      what: "Gateway status could not be read",
      why: redactOAuthSecrets(error.message),
      fix: "run npm run init or pass --domain for a configured active domain, then retry.",
    });
    process.exitCode = 1;
    return;
  }

  renderGatewayStatusResult(result, output, { repoRoot });
  printVerboseHint(output);
  process.exitCode = gatewayExitCode(result);
}

// The adopter "is it on?" surface. Strictly read-only: it renders the side-effect-free
// homeStateProbe (config + registry + the live gateway lock) plus local run evidence. It NEVER
// polls Linear, drains replay, or starts a decomposition — that active one-pass lives behind
// `trigger-status`. Always exits 0; it is a status report, not a health gate (that is `doctor`).
async function runGatewayStatusReadOnly({ context }) {
  const { config, repoRoot, output } = context;
  agenticFactoryHeading(output, "gateway status");
  const probe = homeStateProbe({ repoRoot });

  if (probe.state === "uninitialized") {
    output.warn("Not set up yet — this checkout has no active factory domain.");
    output.nextSteps([{ text: formatCommand("init"), hint: "set up your factory" }]);
    process.exitCode = 0;
    return;
  }
  if (probe.state === "degraded") {
    output.warn("Local factory state could not be read cleanly.");
    output.nextSteps([{ text: formatCommand("doctor"), hint: "diagnose and repair" }]);
    process.exitCode = 0;
    return;
  }

  const running = probe.state === "listening";
  const mark = running
    ? output.style.green(output.symbols.running)
    : output.style.dim(output.symbols.stopped);
  output.raw(`\n  ${mark} ${running ? "Running" : "Stopped"}\n`);
  output.keyValues(compactPairs([
    ["Domain", probe.evidence.activeDomainId],
    ["Poll", `every ${humanizeInterval(config.poll?.interval_ms ?? 10_000)}`],
    ["Dashboard", normalizeLocalPhoenixAppUrl(process.env.TEAMI_PHOENIX_URL)],
  ]));
  if (running) {
    output.info("Stop: Ctrl-C in the terminal running the gateway.");
  } else {
    output.nextSteps([{ text: formatCommand("gateway start"), hint: "open your factory for business" }]);
  }
  renderLatestRunEvidence({ repoRoot, output });
  printVerboseHint(output);
  process.exitCode = 0;
}

function resolveGatewaySelection({ repoRoot, config, domainId = null } = {}) {
  const registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry();
  const domains = selectGatewayDomains({ registry, domainId });
  if (domains.length === 0) {
    throw new Error("no_active_domains: no active domains are configured. Run npm run init.");
  }
  return { registry, domains, config };
}

function renderGatewayCompletion(result, output) {
  if (result.ok) {
    output.success(`Gateway ${humanizeToken(result.status)}.`);
  } else if (result.reason === "gateway_already_running") {
    output.warn("Gateway already running in this checkout.");
  } else {
    output.error({
      what: "Gateway did not start",
      why: result.reason || result.status || "unknown",
      fix: "inspect gateway status and local run evidence, then retry.",
    });
  }
  output.keyValues(compactPairs([
    ["Status", result.status],
    ["Reason", result.reason],
    ["Iterations", Array.isArray(result.iterations) ? result.iterations.length : null],
    ["Events", Array.isArray(result.statuses) ? result.statuses.length : null],
  ]), { heading: "Gateway" });
}

function renderGatewayStatusResult(result, output, { repoRoot } = {}) {
  if (result.ok) output.success("Gateway status pass completed.");
  else if (result.reason === "gateway_already_running") output.warn("Gateway already running in this checkout.");
  else {
    output.error({
      what: "Gateway status pass did not complete",
      why: result.reason || result.status || "unknown",
      fix: "repair the reported gateway condition, then retry.",
    });
  }
  renderGatewayEvents(result.statuses || [], output);
  renderPlannedProjectSummary(result, output);
  renderLatestRunEvidence({ repoRoot, output });
  const reconciliation = result.startup?.resumeReconciliation;
  if (reconciliation) renderNextResumeReconciliationReport(reconciliation, output);
}

function renderGatewayEvents(events, output) {
  output.section("Gateway events");
  if (events.length === 0) {
    output.success("No active local run or replay events.");
    return;
  }
  for (const event of events) renderGatewayStatusEvent(event, output);
}

function renderGatewayStatusEvent(event, output) {
  const line = gatewayStatusEventLine(event);
  if (ATTENTION_STATES.has(event.state)) output.warn(line);
  else if (ACTIVE_STATES.has(event.state)) output.info(line);
  else output.success(line);
  output.detail(`gateway_event=${redactOAuthSecrets(JSON.stringify(event))}`);
}

function gatewayStatusEventLine(event = {}) {
  const ref = event.projectId || event.ref || "gateway";
  const suffix = [
    event.reason,
    event.runId ? `run=${event.runId}` : null,
    event.artifactKind ? `artifact=${event.artifactKind}` : null,
    event.nextAttemptAt ? `next=${new Date(event.nextAttemptAt).toISOString()}` : null,
  ].filter(Boolean).join(" ");
  return `${ref}: ${humanizeToken(event.state)}${suffix ? ` (${suffix})` : ""}`;
}

function renderPlannedProjectSummary(result, output) {
  output.section("Planned projects");
  const rows = plannedProjectRows(result);
  if (rows.length === 0) {
    output.success("No Planned projects selected by this pass.");
    return;
  }
  for (const row of rows) {
    const headline = `${row.projectId || row.domainId}: ${humanizeToken(row.action || row.status || "observed")}`;
    if (["replay_degraded", "replay_dead_letter", "rate_limited"].includes(row.action || row.status)) {
      output.warn(headline);
    } else {
      output.success(headline);
    }
    output.keyValues(compactPairs([
      ["Domain", row.domainId],
      ["Project", row.projectId],
      ["Action", row.action],
      ["Status", row.status],
      ["Run", row.runId],
      ["Artifact", row.artifactKind],
      ["Reason", row.reason],
    ]));
  }
}

function plannedProjectRows(result) {
  const domains = result.poll?.domains || [];
  const rows = [];
  for (const domain of domains) {
    if (domain.status && domain.status !== "ok") {
      rows.push({
        domainId: domain.domainId,
        status: domain.status,
        reason: domain.reason || null,
      });
    }
    for (const entry of domain.processed || []) {
      rows.push(plannedProjectRow(domain, entry));
    }
  }
  for (const entry of result.startup?.replay || []) {
    rows.push(plannedProjectRow({ domainId: entry.pending?.domainId }, entry));
  }
  return rows;
}

function plannedProjectRow(domain, entry = {}) {
  const pending = entry.pending || entry.replay?.pending || {};
  const runId =
    pending.runId ||
    entry.result?.wake?.run_id ||
    entry.result?.traceDelivery?.receipt?.run_id ||
    entry.result?.artifact?.run_id ||
    null;
  return {
    domainId: domain.domainId || pending.domainId || null,
    projectId: entry.projectId || pending.projectId || null,
    action: entry.action || null,
    status: entry.result?.status || entry.replay?.status || entry.status || null,
    runId,
    artifactKind: pending.artifactKind || entry.result?.artifact?.kind || null,
    reason: entry.result?.reason || entry.replay?.reason || entry.reason || null,
  };
}

function renderLatestRunEvidence({ repoRoot, output, limit = 5 } = {}) {
  output.section("Latest run evidence");
  let local;
  try {
    local = readLocalEvalInputs({ repoRoot });
  } catch (error) {
    output.warn(`Local run evidence could not be read: ${redactOAuthSecrets(error.message)}`);
    return;
  }
  const runs = [...(local.runs || [])]
    .sort((left, right) => String(right.observed_at || "").localeCompare(String(left.observed_at || "")))
    .slice(0, limit);
  if (runs.length === 0) {
    output.success("No local runs found.");
    return;
  }
  for (const run of runs) {
    const status = run.trace_status || "local_artifact";
    output.info(`${run.run_id}: ${humanizeToken(run.artifact_kind || status)}`);
    output.keyValues(compactPairs([
      ["Run", run.run_id],
      ["Project", run.project_id],
      ["Artifact", run.artifact_kind],
      ["Trace", run.trace_status],
      ["Snapshot", run.snapshot_present ? "present" : "missing"],
      ["Observed", run.observed_at],
    ]));
  }
}

function gatewayExitCode(result) {
  if (result.reason === "gateway_already_running") return 0;
  if (result.ok && GATEWAY_SUCCESS_STATUSES.has(result.status)) return 0;
  return result.ok ? 0 : 1;
}

export async function runRuntimeSmokeCommand({ context, command, args }) {
  const { config, repoRoot, output } = context;
    agenticFactoryHeading(output, "runtime smoke");
    let result;
    try {
      result = await runRuntimeSmokeChecks({
        config,
        repoRoot,
        force: args.includes("--force"),
      });
    } catch (error) {
      output.error({
        what: "Runtime smoke could not run",
        why: redactOAuthSecrets(error.message),
        fix: "repair the configured runtime command or adapter assignment, then rerun runtime-smoke.",
      });
      process.exitCode = 1;
      return;
    }
    renderRuntimeSmokeResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}

function renderRuntimeSmokeResult(result, output) {
  if (result.ok) output.success("Runtime smoke checks completed.");
  else {
    output.error({
      what: "Runtime smoke found runtime checks that need repair",
      why: runtimeSmokeFailureSummary(result),
      fix: "repair the failing runtime command, model, or adapter config, then rerun npm run runtime-smoke -- --force.",
    });
  }
  output.keyValues([
    ["Cache", result.cachePath],
    ["Checks", result.results.length],
  ], { heading: "Smoke cache" });
  output.section("Runtime checks");
  for (const item of result.results) {
    const label = `${item.runtime} ${item.version} ${item.role}${item.cached ? " (cached)" : ""}`;
    if (item.ok) output.success(label);
    else output.warn(label);
    output.keyValues(compactPairs([
      ["Runtime", item.runtime],
      ["Role", item.role],
      ["Version", item.version],
      ["Cached", item.cached ? "yes" : "no"],
      ["Error", item.error ? redactOAuthSecrets(item.error) : null],
    ]));
  }
  output.detail(`cache=${JSON.stringify(result.cache || null)}`);
}

function runtimeSmokeFailureSummary(result) {
  return result.results
    .filter((item) => !item.ok)
    .map((item) => `${item.runtime}/${item.role}: ${redactOAuthSecrets(item.error || "runtime check failed")}`)
    .join("\n") || "At least one runtime check failed.";
}

async function inspectTriggerStatus({
  config,
  repoRoot,
  domainId = null,
}) {
  const selection = resolveGatewaySelection({ repoRoot, config, domainId });
  return runGatewayOnce({
    repoRoot,
    config,
    registry: selection.registry,
    domains: selection.domains,
  });
}

async function requeueTriggerWake() {
  throw new Error("wake_requeue_retired: use run_id replay through npm run gateway -- status.");
}

function formatTriggerWakeStatusLine({ wake } = {}) {
  if (!wake) return "";
  return gatewayStatusEventLine({
    projectId: wake.projectId || wake.object_id || wake.objectId || null,
    state: wake.state || wake.derived_status || wake.status || "unknown",
    reason: wake.reason || wake.displayReason || null,
    runId: wake.run_id || wake.runId || null,
    artifactKind: wake.artifact_kind || wake.artifactKind || null,
  });
}

function selectRunnerDomains({ registry, domainId = null } = {}) {
  return selectGatewayDomains({ registry, domainId });
}

async function runOneTriggerWake({
  config,
  repoRoot,
  domainId = null,
} = {}) {
  const selection = resolveGatewaySelection({ repoRoot, config, domainId });
  const result = await runGatewayOnce({
    repoRoot,
    config,
    registry: selection.registry,
    domains: selection.domains,
  });
  return {
    status: result.ok ? "completed" : result.status,
    reason: result.reason || null,
    messages: [],
    gateway: result,
    domainId: selection.domains[0]?.id || null,
  };
}

function acquireDomainRunnerLock({
  repoRoot,
  domainId,
  staleMs = DEFAULT_DOMAIN_RUNNER_LOCK_STALE_MS,
  now = () => new Date(),
  log = () => {},
  isProcessAlive = defaultIsProcessAlive,
  installHandlers = true,
} = {}) {
  const lockPath = path.join(repoRoot, ".teami", "domains", domainId, ".lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const createdAt = toDate(now()).toISOString();
  const token = randomUUID();

  const created = tryCreateDomainRunnerLock({ lockPath, token, createdAt });
  if (created.ok) {
    return domainRunnerLockHandle({ lockPath, token, installHandlers });
  }
  if (created.error?.code !== "EEXIST") throw created.error;

  const existing = readDomainRunnerLock(lockPath);
  const staleReason = domainRunnerLockBreakReason({ lock: existing, staleMs, now: toDate(now()), isProcessAlive });
  if (staleReason) {
    log(`warning: breaking stale runner lock for domain ${domainId} (${staleReason})`);
    if (removeDomainRunnerLockIfTokenMatches({ lockPath, token: existing?.token })) {
      const retry = tryCreateDomainRunnerLock({ lockPath, token, createdAt });
      if (retry.ok) return domainRunnerLockHandle({ lockPath, token, installHandlers });
      if (retry.error?.code !== "EEXIST") throw retry.error;
    }
  }

  return {
    ok: false,
    reason: "already_running_for_domain",
    lockPath,
    message: `already running for domain ${domainId}`,
  };
}

function tryCreateDomainRunnerLock({ lockPath, token, createdAt }) {
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

function domainRunnerLockHandle({ lockPath, token, installHandlers }) {
  const handlers = [];
  let released = false;

  const release = ({ removeHandlers = true } = {}) => {
    if (released) return;
    released = true;
    removeDomainRunnerLockIfTokenMatches({ lockPath, token });
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

function readDomainRunnerLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function domainRunnerLockBreakReason({ lock, staleMs, now, isProcessAlive }) {
  if (!lock || typeof lock !== "object") return "invalid_lock_file";
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "invalid_pid";
  if (!isProcessAlive(pid)) return `dead_pid:${pid}`;
  const createdAt = Date.parse(lock.created_at);
  if (!Number.isFinite(createdAt)) return "invalid_created_at";
  if (now.getTime() - createdAt > staleMs) return "stale";
  return null;
}

function removeDomainRunnerLockIfTokenMatches({ lockPath, token }) {
  const current = readDomainRunnerLock(lockPath);
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

function renderNextResumeReconciliationReport(report, output) {
  output.section("Next resume");
  if (report.ok) output.success("No stalled resume work needs intervention.");
  else output.warn("Resume work needs operator attention.");
  output.keyValues([
    ["Items", report.summary.item_count],
    ["PM states", formatOperatorPmStateCounts(report.summary.by_pm_state)],
    ["Generated", report.generated_at],
  ]);
  const unavailableSources = report.sources
    .filter((source) => source.status === "unavailable" || source.status === "unreadable")
    .map((source) => `${source.id}=${source.reason || source.status}`);
  if (unavailableSources.length > 0) output.warn(`Degraded sources: ${unavailableSources.join(", ")}`);
  if (report.summary.item_count === 0) {
    output.success("No aged, expired, dead-lettered, resumed, proposal, or attention work found.");
  } else {
    output.section("Resume targets");
    for (const item of report.items) {
      const headline = `${operatorPmStateLabel(item.pm_state)}: ${item.ref}`;
      if (item.pm_state === "Working") output.success(headline);
      else output.warn(headline);
      output.keyValues(compactPairs([
        ["Classification", item.classification],
        ["Source", item.source],
        ["Reason", item.reason],
        ["Detail", item.detail],
        ["Surface", item.next_surface],
      ]));
      output.detail(`pm_state=${item.pm_state}`);
      output.detail(`item_id=${item.id}`);
    }
  }
  output.detail(report._note || "");
  output.detail("external_actions=no gateway work claimed, no Linear writes, no GitHub writes");
  output.detail(`sources=${redactOAuthSecrets(JSON.stringify(report.sources || []))}`);
}

function formatOperatorPmStateCounts(counts = {}) {
  return [
    "Working",
    "Needs your decision",
    "Safe stop",
    "Proposal ready",
  ].map((label) => `${label}=${counts[rawPmStateLabel(label)] || 0}`).join(", ");
}

function operatorPmStateLabel(state) {
  if (state === "Blocked but safe") return "Safe stop";
  return state || "Unknown";
}

function rawPmStateLabel(label) {
  if (label === "Safe stop") return "Blocked but safe";
  return label;
}

export {
  acquireDomainRunnerLock,
  formatTriggerWakeStatusLine,
  inspectTriggerStatus,
  renderNextResumeReconciliationReport,
  requeueTriggerWake,
  runOneTriggerWake,
  selectRunnerDomains,
};
