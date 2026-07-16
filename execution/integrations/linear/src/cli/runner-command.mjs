import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { emptyTeamRegistry, readTeamRegistry } from "../team-registry.mjs";
import { readLocalEvalInputs } from "../eval-status.mjs";
import {
  runGatewayLoop,
  runGatewayOnce,
  selectGatewayTeams,
} from "../gateway-loop.mjs";
import { collectHumanReviewGateStatusReport } from "../linear/human-review-gate-status.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { normalizeLocalPhoenixAppUrl } from "../local-phoenix-manager.mjs";
import {
  runRuntimeSmokeChecks,
} from "../runtime-smoke.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
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

const DEFAULT_TEAM_RUNNER_LOCK_STALE_MS = 30 * 60 * 1000;
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
      what: `Usage: ${formatCommand("gateway [status] [--team <id>]")}`,
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
  const { config, repoRoot, home, output } = context;
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
      home,
      config,
      teamRef: flags.team || null,
    });
    const intervalMs = config.poll?.interval_ms || 10_000;
    output.info(`Watching Linear for Planned projects. Polling every ${humanizeInterval(intervalMs)}; stop with Ctrl-C.`);
    heartbeat = output.progress(gatewayWatchLine());
    ticker = setInterval(() => heartbeat?.update(gatewayWatchLine()), intervalMs);
    if (typeof ticker.unref === "function") ticker.unref();
    result = await loop({
      repoRoot,
      home,
      config,
      registry: selection.registry,
      teams: selection.teams,
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
      fix: `run ${formatCommand("init")} or pass --team for an active team, then retry.`,
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
  const { config, repoRoot, home, output } = context;
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
      home,
      config,
      teamRef: flags.team || null,
    });
    result = await runGatewayOnce({
      repoRoot,
      home,
      config,
      registry: selection.registry,
      teams: selection.teams,
    });
  } catch (error) {
    output.error({
      what: "Gateway status could not be read",
      why: redactOAuthSecrets(error.message),
      fix: `run ${formatCommand("init")} or pass --team for a configured active team, then retry.`,
    });
    process.exitCode = 1;
    return;
  }

  renderGatewayStatusResult(result, output, { repoRoot, home });
  printVerboseHint(output);
  process.exitCode = gatewayExitCode(result);
}

// The adopter "is it on?" surface. Strictly read-only: it renders the side-effect-free
// homeStateProbe (config + registry + the live gateway lock) plus local run evidence. It NEVER
// polls Linear, drains replay, or starts a decomposition — that active one-pass lives behind
// `trigger-status`. Always exits 0; it is a status report, not a health gate (that is `doctor`).
async function runGatewayStatusReadOnly({ context }) {
  const { config, repoRoot, home, output } = context;
  agenticFactoryHeading(output, "gateway status");
  const probe = homeStateProbe({ repoRoot, home, config });

  if (probe.state === "uninitialized") {
    output.warn("Not set up yet — this checkout has no active factory team.");
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
    ["Team", probe.evidence.activeTeamRef],
    ["Poll", `every ${humanizeInterval(config.poll?.interval_ms ?? 10_000)}`],
    ["Dashboard", normalizeLocalPhoenixAppUrl(process.env.TEAMI_PHOENIX_URL)],
  ]));
  if (running) {
    output.info("Stop: Ctrl-C in the terminal running the gateway.");
  } else {
    output.nextSteps([{ text: formatCommand("gateway start"), hint: "open your factory for business" }]);
  }
  renderLatestRunEvidence({ repoRoot, home, output });
  await renderHumanReviewGateStatus({ repoRoot, home, config, output });
  printVerboseHint(output);
  process.exitCode = 0;
}

function resolveGatewaySelection({ repoRoot, home = resolveTeamiHome(), config, teamRef = null } = {}) {
  const registry = readTeamRegistry({ home }) || emptyTeamRegistry();
  const teams = selectGatewayTeams({ registry, teamRef });
  if (teams.length === 0) {
    throw new Error(`no_active_teams: no active teams are configured. Run ${formatCommand("init")}.`);
  }
  return { registry, teams, config };
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
    ["Iterations", gatewayRetentionCount(result, "iterations")],
    ["Events", gatewayRetentionCount(result, "statuses")],
  ]), { heading: "Gateway" });
}

function gatewayRetentionCount(result, kind) {
  const records = kind === "iterations" ? result?.iterations : result?.statuses;
  if (!Array.isArray(records)) return null;
  const counts = result?.retention?.[kind];
  const total = Number.isInteger(counts?.total) ? counts.total : records.length;
  const retained = Number.isInteger(counts?.retained) ? counts.retained : records.length;
  const dropped = Number.isInteger(counts?.dropped) ? counts.dropped : Math.max(0, total - retained);
  if (dropped > 0) return `${total} total; ${retained} recent retained; ${dropped} older dropped`;
  return `${total} total; all retained`;
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
    const headline = `${row.projectId || row.teamRef}: ${humanizeToken(row.action || row.status || "observed")}`;
    if (["replay_degraded", "replay_dead_letter", "rate_limited"].includes(row.action || row.status)) {
      output.warn(headline);
    } else {
      output.success(headline);
    }
    output.keyValues(compactPairs([
      ["Team", row.teamRef],
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
  const teams = result.poll?.teams || [];
  const rows = [];
  for (const team of teams) {
    if (team.status && team.status !== "ok") {
      rows.push({
        teamRef: team.teamRef,
        status: team.status,
        reason: team.reason || null,
      });
    }
    for (const entry of team.processed || []) {
      rows.push(plannedProjectRow(team, entry));
    }
  }
  for (const entry of result.startup?.replay || []) {
    rows.push(plannedProjectRow({ teamRef: entry.pending?.teamRef }, entry));
  }
  return rows;
}

function plannedProjectRow(team, entry = {}) {
  const pending = entry.pending || entry.replay?.pending || {};
  const runId =
    pending.runId ||
    entry.result?.wake?.run_id ||
    entry.result?.traceDelivery?.receipt?.run_id ||
    entry.result?.artifact?.run_id ||
    null;
  return {
    teamRef: team.teamRef || pending.teamRef || null,
    projectId: entry.projectId || pending.projectId || null,
    action: entry.action || null,
    status: entry.result?.status || entry.replay?.status || entry.status || null,
    runId,
    artifactKind: pending.artifactKind || entry.result?.artifact?.kind || null,
    reason: entry.result?.reason || entry.replay?.reason || entry.reason || null,
  };
}

function renderLatestRunEvidence({ repoRoot, home = resolveTeamiHome(), output, limit = 5 } = {}) {
  output.section("Latest run evidence");
  let local;
  try {
    local = readLocalEvalInputs({ repoRoot, home });
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

async function renderHumanReviewGateStatus({ repoRoot, home = resolveTeamiHome(), config, output } = {}) {
  output.section("Human review gate");
  let report;
  try {
    report = await collectHumanReviewGateStatusReport({ repoRoot, home, config });
  } catch (error) {
    output.warn(`Human review gate status could not be read: ${redactOAuthSecrets(error.message)}`);
    return;
  }

  for (const warning of report.warnings || []) {
    output.warn(`Human review gate read warning: ${redactOAuthSecrets(warning.reason || "unknown")}`);
  }

  if (
    (report.queue || []).length === 0 &&
    (report.reconciliation || []).length === 0 &&
    (report.verdicts || []).length === 0
  ) {
    output.success("No human-review gate work found.");
    return;
  }

  if ((report.queue || []).length > 0) {
    output.info("Queue");
    for (const row of report.queue) {
      output.info(`${gateIssueLabel(row)}: ${row.reason}`);
      output.keyValues(compactPairs([
        ["Team", row.team_ref],
        ["PR", row.pr_number ? `#${row.pr_number}` : null],
        ["Parked", row.parked_at],
        ["Age", humanizeGateAge(row.age_ms)],
        ["Head", shortSha(row.parked_head_sha)],
      ]));
    }
  }

  if ((report.reconciliation || []).length > 0) {
    output.info("Reconciliation");
    for (const row of report.reconciliation) {
      const line = `${gateIssueLabel(row)}: ${humanizeToken(row.category)} - ${row.reason}`;
      if (row.severity === "success") output.success(line);
      else if (row.severity === "info") output.info(line);
      else output.warn(line);
      output.keyValues(compactPairs([
        ["Team", row.team_ref],
        ["Status", row.issue_status_role],
        ["PR", row.pr_number ? `#${row.pr_number}` : null],
        ["PR state", row.pr_state],
        ["Parked head", shortSha(row.parked_head_sha)],
        ["Current head", shortSha(row.current_head_sha)],
        ["Observed", row.observed_at],
      ]));
    }
  }

  if ((report.verdicts || []).length > 0) {
    output.info("Verdicts");
    for (const row of report.verdicts) {
      const line = `${row.issue_id}: ${humanizeToken(row.verdict)} - ${row.reason}`;
      if (row.verdict === "accepted") output.success(line);
      else if (row.verdict === "sent_back") output.info(line);
      else output.warn(line);
      output.keyValues(compactPairs([
        ["Run", row.run_id],
        ["PR", row.pr_number ? `#${row.pr_number}` : null],
        ["Head", shortSha(row.head_sha)],
        ["Observed", row.observed_at],
      ]));
    }
  }
}

function gateIssueLabel(row = {}) {
  const issue = row.identifier || row.issue_id || "issue";
  return row.title ? `${issue} ${row.title}` : issue;
}

function shortSha(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 12) : null;
}

function humanizeGateAge(ms) {
  if (!Number.isFinite(ms)) return null;
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
  const days = Math.round(totalHours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function gatewayExitCode(result) {
  if (result.reason === "gateway_already_running") return 0;
  if (result.ok && GATEWAY_SUCCESS_STATUSES.has(result.status)) return 0;
  return result.ok ? 0 : 1;
}

export async function runRuntimeSmokeCommand({ context, command, args }) {
  const { config, repoRoot, home, output } = context;
    agenticFactoryHeading(output, "runtime smoke");
    let result;
    try {
      result = await runRuntimeSmokeChecks({
        config,
        repoRoot,
        home,
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
      fix: `repair the failing runtime command, model, or adapter config, then rerun ${formatCommand("runtime-smoke --force")}.`,
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
  teamRef = null,
}) {
  const selection = resolveGatewaySelection({ repoRoot, config, teamRef });
  return runGatewayOnce({
    repoRoot,
    config,
    registry: selection.registry,
    teams: selection.teams,
  });
}

async function requeueTriggerWake() {
  throw new Error(`wake_requeue_retired: use run_id replay through ${formatCommand("gateway status")}.`);
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

function selectRunnerTeams({ registry, teamRef = null } = {}) {
  return selectGatewayTeams({ registry, teamRef });
}

async function runOneTriggerWake({
  config,
  repoRoot,
  teamRef = null,
} = {}) {
  const selection = resolveGatewaySelection({ repoRoot, config, teamRef });
  const result = await runGatewayOnce({
    repoRoot,
    config,
    registry: selection.registry,
    teams: selection.teams,
  });
  return {
    status: result.ok ? "completed" : result.status,
    reason: result.reason || null,
    messages: [],
    gateway: result,
    teamRef: selection.teams[0]?.id || null,
  };
}

function acquireTeamRunnerLock({
  repoRoot,
  teamRef,
  staleMs = DEFAULT_TEAM_RUNNER_LOCK_STALE_MS,
  now = () => new Date(),
  log = () => {},
  isProcessAlive = defaultIsProcessAlive,
  installHandlers = true,
} = {}) {
  const lockPath = path.join(repoRoot, ".teami", "teams", teamRef, ".lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const createdAt = toDate(now()).toISOString();
  const token = randomUUID();

  const created = tryCreateTeamRunnerLock({ lockPath, token, createdAt });
  if (created.ok) {
    return teamRunnerLockHandle({ lockPath, token, installHandlers });
  }
  if (created.error?.code !== "EEXIST") throw created.error;

  const existing = readTeamRunnerLock(lockPath);
  const staleReason = teamRunnerLockBreakReason({ lock: existing, staleMs, now: toDate(now()), isProcessAlive });
  if (staleReason) {
    log(`warning: breaking stale runner lock for team ${teamRef} (${staleReason})`);
    if (removeTeamRunnerLockIfTokenMatches({ lockPath, token: existing?.token })) {
      const retry = tryCreateTeamRunnerLock({ lockPath, token, createdAt });
      if (retry.ok) return teamRunnerLockHandle({ lockPath, token, installHandlers });
      if (retry.error?.code !== "EEXIST") throw retry.error;
    }
  }

  return {
    ok: false,
    reason: "already_running_for_team",
    lockPath,
    message: `already running for team ${teamRef}`,
  };
}

function tryCreateTeamRunnerLock({ lockPath, token, createdAt }) {
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

function teamRunnerLockHandle({ lockPath, token, installHandlers }) {
  const handlers = [];
  let released = false;

  const release = ({ removeHandlers = true } = {}) => {
    if (released) return;
    released = true;
    removeTeamRunnerLockIfTokenMatches({ lockPath, token });
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

function readTeamRunnerLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function teamRunnerLockBreakReason({ lock, staleMs, now, isProcessAlive }) {
  if (!lock || typeof lock !== "object") return "invalid_lock_file";
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "invalid_pid";
  if (!isProcessAlive(pid)) return `dead_pid:${pid}`;
  const createdAt = Date.parse(lock.created_at);
  if (!Number.isFinite(createdAt)) return "invalid_created_at";
  if (now.getTime() - createdAt > staleMs) return "stale";
  return null;
}

function removeTeamRunnerLockIfTokenMatches({ lockPath, token }) {
  const current = readTeamRunnerLock(lockPath);
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

export {
  acquireTeamRunnerLock,
  formatTriggerWakeStatusLine,
  inspectTriggerStatus,
  requeueTriggerWake,
  runOneTriggerWake,
  selectRunnerTeams,
};
