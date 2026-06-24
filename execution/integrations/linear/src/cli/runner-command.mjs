import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readLinearCache } from "../cache.mjs";
import {
  configWithDomainLinearTeam,
  listWakeViewsForDomains,
} from "../domain-command-context.mjs";
import {
  emptyDomainRegistry,
  readDomainRegistry,
} from "../domain-registry.mjs";
import { buildDomainContext, resolveWakeDomainContext } from "../domain-resolver.mjs";
import {
  emitDeterministicChecksBestEffort,
} from "../deterministic-check-emission.mjs";
import { createHostedWakeQueueStore } from "../hosted-wake-queue-store.mjs";
import { createLinearCredentialStore } from "../linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import { createLocalPhoenixTraceSink } from "../local-phoenix-trace-sink.mjs";
import {
  collectNextResumeReconciliation,
} from "../local-supervisor.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { createRunnerInboxCredentialStore } from "../runner-inbox-credential.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  runRuntimeSmokeChecks,
  smokeTestsFromRuntimeSmokeCache,
} from "../runtime-smoke.mjs";
import { readTraceReceipt } from "../trace-status-store.mjs";
import { createProcessRuntimeExecutor, runTriggeredDecomposition } from "../trigger-runner.mjs";
import { flagValue } from "./flags.mjs";
import {
  agenticFactoryHeading,
  compactPairs,
  humanizeToken,
  printVerboseHint,
  yesNo,
} from "./operator-output.mjs";

const DEFAULT_DOMAIN_RUNNER_LOCK_STALE_MS = 30 * 60 * 1000;
async function runOneTriggerWake({
  config,
  repoRoot,
  inboxClient,
  cachePath,
  domainId = null,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
}) {
  const registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry();
  const domains = selectRunnerDomains({ registry, domainId });
  if (domains.length === 0) throw new Error("no_active_domains: no active domains are configured. Run npm run init.");
  const messages = [];
  let lastIdle = null;
  for (const domain of domains) {
    const lock = acquireDomainRunnerLock({
      repoRoot,
      domainId: domain.id,
      log: (line) => messages.push(line),
    });
    if (!lock.ok) {
      messages.push(lock.message || `already running for domain ${domain.id}`);
      lastIdle = { status: "idle", reason: "already_running_for_domain", domainId: domain.id };
      continue;
    }
    try {
      const result = await runOneDomainTriggerWake({
        config,
        repoRoot,
        inboxClient,
        registry,
        domain,
        createSetupGraphqlClient,
      });
      result.messages = [...messages, ...(result.messages || [])];
      result.domainId = domain.id;
      if (result.status !== "idle") return result;
      lastIdle = result;
    } finally {
      lock.release();
    }
  }
  return {
    status: "idle",
    reason: lastIdle?.reason || (messages.length > 0 ? "already_running_for_domain" : "no_queued_wake"),
    messages,
  };
}

async function runOneDomainTriggerWake({
  config,
  repoRoot,
  inboxClient,
  registry,
  domain,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
}) {
  const context = buildDomainContext({ domain, config, repoRoot });
  const cache = readLinearCache(context.linear.cachePath);
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    domainContext: context,
  });
  const runnerCredentialStore = createRunnerInboxCredentialStore({
    config,
    repoRoot,
    domainContext: context,
  });
  const runnerCredential = await runnerCredentialStore.readCredential();
  if (!runnerCredential) {
    throw new Error(`Runner inbox credential is missing for domain ${context.domainId}; run npm run init.`);
  }
  const store = createHostedWakeQueueStore({ inboxClient, credential: runnerCredential });
  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const runtimeExecutor = createProcessRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache),
    repoRoot,
  });
  const traceSink = createLocalPhoenixTraceSink({ repoRoot });
  try {
    return await runTriggeredDecomposition({
      store,
      runnerId: runnerCredential.credentialId,
      workspaceId: context.linear.workspaceId,
      linearClientFactory: async () => createSetupGraphqlClient({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      }).client,
      config: configWithDomainLinearTeam(config, context),
      cache,
      runtimeExecutor,
      repoRoot,
      leaseDurationMs: config.inbox.runner.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: runnerCredential.capabilities || config.inbox.runner.required_capabilities,
      traceSink,
      domainContext: context,
      registry,
    });
  } finally {
    await traceSink.shutdown();
  }
}

function selectRunnerDomains({ registry, domainId = null } = {}) {
  const domains = registry?.domains || [];
  if (!domainId) return domains.filter((domain) => domain.status === "active");
  const domain = domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`domain_not_found: ${domainId}`);
  if (domain.status !== "active") {
    throw new Error(`domain_not_active: ${domainId} status=${domain.status || "unknown"}`);
  }
  return [domain];
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
  const lockPath = path.join(repoRoot, ".agentic-factory", "domains", domainId, ".lock");
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

async function inspectTriggerStatus({
  config,
  repoRoot,
  inboxClient,
  cachePath,
  domainId = null,
}) {
  const registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry();
  const selectedDomains = selectRunnerDomains({ registry, domainId });
  if (selectedDomains.length === 0) {
    throw new Error("no_active_domains: no active domains are configured. Run npm run init.");
  }

  return listWakeViewsForDomains({
    registry,
    domains: selectedDomains,
    config,
    repoRoot,
    inboxClient,
    domainId,
  });
}

async function requeueTriggerWake({
  config,
  repoRoot,
  inboxClient,
  domainId = null,
  wakeId,
  createCredentialStore = createRunnerInboxCredentialStore,
} = {}) {
  if (!wakeId) throw new Error("wake_id_required: pass --requeue <wakeId>.");
  const registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry();
  const selectedDomains = selectRunnerDomains({ registry, domainId });
  if (selectedDomains.length === 0) {
    throw new Error("no_active_domains: no active domains are configured. Run npm run init.");
  }
  const views = await listWakeViewsForDomains({
    registry,
    domains: selectedDomains,
    config,
    repoRoot,
    inboxClient,
    domainId,
    createCredentialStore,
  });
  const wake = views.find((candidate) => candidate.id === wakeId || candidate.wake_id === wakeId);
  if (!wake) throw new Error(`wake_not_found: ${wakeId}`);
  const workspaceId = wake.workspace_id || wake.workspaceId;
  const requeueDomainId = domainId || resolvedDomainIdForWake({ wake, registry, config, repoRoot });
  if (!requeueDomainId) {
    throw new Error(`domain_required_for_requeue: wake ${wakeId} is ambiguous; pass --domain <domain_id>.`);
  }
  const domain = selectedDomains.find((candidate) => candidate.id === requeueDomainId);
  if (!domain) throw new Error(`domain_not_found_for_requeue: ${requeueDomainId}`);
  const context = buildDomainContext({ domain, config, repoRoot });
  const credentialStore = createCredentialStore({ config, repoRoot, domainContext: context });
  const credential = await credentialStore.readCredential();
  if (!credential) {
    throw new Error(`Runner inbox credential is missing for domain ${context.domainId}; run npm run init.`);
  }
  const result = await inboxClient.requeueWake({
    workspaceId,
    credentialId: credential.credentialId,
    token: credential.token,
    wakeId,
  });
  if (result?.ok === false) throw new Error(`requeue_failed:${result.reason}`);
  return result;
}

function resolvedDomainIdForWake({ wake, registry, config, repoRoot } = {}) {
  const explicit =
    nonEmptyString(wake?.domain_id) ||
    nonEmptyString(wake?.domainId) ||
    nonEmptyString(wake?.resolvedDomainId) ||
    nonEmptyString(wake?.resolved_domain_id);
  if (explicit) return explicit;
  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: wake?.workspace_id || wake?.workspaceId || wake?.organization_id || null,
      webhookId: wake?.webhook_ids || wake?.webhookIds || wake?.webhook_id || null,
      projectTeamIds: wake?.team_ids || wake?.teamIds || wake?.project_team_ids || wake?.projectTeamIds || null,
    },
  });
  return resolved.ok ? resolved.context.domainId : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function formatTriggerWakeStatusLine({ wake, repoRoot } = {}) {
  const receipt = wake.run_id ? readTraceReceipt({ repoRoot, runId: wake.run_id }) : null;
  const traceStatus = receipt?.trace_status ? `trace=${receipt.trace_status}` : "";
  const candidates = routingCandidatesText(wake.routingCandidates || wake.routing_candidates || []);
  return [
    wake.domainLabel,
    wake.derived_status || wake.status,
    wake.trigger_type || wake.workflow_type,
    wake.object_id || wake.objectId || "",
    wake.displayReason || "",
    candidates,
    traceStatus,
  ].filter(Boolean).join(" ").trim();
}

function routingCandidatesText(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const rendered = candidates.map((candidate) => (
    `${candidate.domainId}(${candidate.status}${candidate.teamId ? `,team=${candidate.teamId}` : ""})`
  ));
  return `candidates=${rendered.join(",")}`;
}

export async function runRunnerCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output } = context;
    agenticFactoryHeading(output, "runner");
    let result;
    try {
      result = await runOneTriggerWake({
        config,
        repoRoot,
        inboxClient,
        cachePath,
        domainId: flagValue(args, "--domain"),
      });
    } catch (error) {
      output.error({
        what: "Runner could not start",
        why: redactOAuthSecrets(error.message),
        fix: "run npm run init or pass --domain for an active domain, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    for (const message of result.messages || []) output.detail(redactOAuthSecrets(message));
    renderRunnerResult(result, output);
    process.exitCode = ["completed", "paused", "rejected", "idle"].includes(result.status) ? 0 : 1;
    // Post-terminal, best-effort deterministic check emission (CONSTRAINTS
    // #27/#30). The wake is already completed inside runTriggeredDecomposition
    // and the exit code above is already fixed from the run outcome, so a
    // failure here can only print a notice; it can never alter the run
    // outcome or add a blocking call to the live mutation path. The wrapper
    // never throws and uses a non-starting Phoenix probe (Phoenix is never
    // booted just for emission; the explicit eval:emit-checks command is the
    // primary, retryable path).
    if (result.status === "completed" || result.status === "paused") {
      const terminalRunId = result.traceDelivery?.receipt?.run_id || result.wake?.run_id || null;
      try {
        const emission = await emitDeterministicChecksBestEffort({ repoRoot, runId: terminalRunId });
        if (emission.ok) {
          output.success(`Deterministic checks emitted for run ${terminalRunId}`);
          output.detail(`emitted_count=${emission.emitted_count}`);
        } else {
          output.warn(`Deterministic checks were not emitted: ${emission.reason || emission.storage}`);
          output.nextSteps([{
            text: "Retry checks",
            hint: `npm run eval:emit-checks -- ${terminalRunId || "<run_id>"}`,
          }]);
        }
      } catch (error) {
        output.warn("Deterministic checks were not emitted.");
        output.detail(redactOAuthSecrets(error.message));
      }
    }
    if (process.exitCode === 0) printVerboseHint(output);
}
export async function runRuntimeSmokeCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output } = context;
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
export async function runTriggerStatusCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, inboxClient, credentialStore, runnerCredentialStore, output } = context;
    agenticFactoryHeading(output, "trigger status");
    const domainId = flagValue(args, "--domain");
    const requeueWakeId = flagValue(args, "--requeue");
    try {
      if (requeueWakeId) {
        const requeued = await requeueTriggerWake({
          config,
          repoRoot,
          inboxClient,
          domainId,
          wakeId: requeueWakeId,
        });
        output.success(`Trigger requeued: ${requeued.wakeId || requeueWakeId}`);
        output.keyValues(compactPairs([
          ["Wake", requeued.wakeId || requeueWakeId],
          ["Status", requeued.status],
          ["Domain", domainId],
        ]), { heading: "Requeue" });
        printVerboseHint(output);
        process.exitCode = 0;
        return;
      }
      const views = await inspectTriggerStatus({
        config,
        repoRoot,
        inboxClient,
        cachePath,
        domainId,
      });
      renderTriggerStatusViews(views, output, { repoRoot });
      const reconciliation = await collectNextResumeReconciliation({ repoRoot, hostedWakeViews: views });
      renderNextResumeReconciliationReport(reconciliation, output);
      printVerboseHint(output);
      process.exitCode = 0;
    } catch (error) {
      output.error({
        what: "Trigger status could not be read",
        why: redactOAuthSecrets(error.message),
        fix: "run npm run init or pass --domain for a configured active domain, then retry.",
      });
      process.exitCode = 1;
    }
}

function renderRunnerResult(result, output) {
  if (["completed", "idle"].includes(result.status)) output.success(runnerHeadline(result));
  else if (["paused", "rejected"].includes(result.status)) output.warn(runnerHeadline(result));
  else {
    output.error({
      what: "Runner did not complete",
      why: result.reason || result.status || "unknown",
      fix: "inspect the wake state and runner logs, then retry.",
    });
  }
  output.keyValues(compactPairs([
    ["Domain", result.domainId],
    ["Wake", result.wake?.id || result.wake?.wake_id],
    ["Reason", result.reason],
    ["Run", result.traceDelivery?.receipt?.run_id || result.wake?.run_id],
  ]), { heading: "Runner" });
  if (result.traceDelivery) renderTraceDelivery(result.traceDelivery, output);
  output.detail(`status=${result.status || "unknown"}`);
  output.detail(`messages=${redactOAuthSecrets(JSON.stringify(result.messages || []))}`);
}

function runnerHeadline(result) {
  if (result.status === "completed") return "Runner completed a trigger wake.";
  if (result.status === "paused") return "Runner paused for operator input.";
  if (result.status === "rejected") return "Runner rejected the trigger wake.";
  if (result.status === "idle") return `Runner is idle${result.reason ? `: ${result.reason}` : ""}`;
  return `Runner status: ${result.status || "unknown"}`;
}

function renderTraceDelivery(traceDelivery, output) {
  const text = `Trace delivery: ${traceDelivery.status || "unknown"}`;
  if (traceDelivery.status === "trace_exported" || traceDelivery.ok === true) output.success(text);
  else output.warn(text);
  output.keyValues(compactPairs([
    ["Open Phoenix", traceDelivery.phoenixAppUrl],
    ["Reason", traceDelivery.reason ? redactOAuthSecrets(traceDelivery.reason) : null],
    ["Run", traceDelivery.receipt?.run_id],
    ["Trace", traceDelivery.receipt?.trace_id],
  ]), { heading: "Trace" });
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
      ["Cached", yesNo(item.cached)],
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

function renderTriggerStatusViews(views, output, { repoRoot } = {}) {
  output.section("Trigger wake-ups");
  if (views.length === 0) {
    output.success("No trigger wake-ups found.");
    return;
  }
  for (const wake of views) {
    if (triggerWakeNeedsAttention(wake)) output.warn(triggerWakeHeadline(wake));
    else output.success(triggerWakeHeadline(wake));
    output.keyValues(compactPairs([
      ["Wake", wake.id || wake.wake_id],
      ["Domain", wake.domainLabel || wake.domain_id || wake.domainId],
      ["Status", wake.derived_status || wake.status],
      ["Trigger", wake.trigger_type || wake.workflow_type],
      ["Object", wake.object_id || wake.objectId],
      ["Reason", wake.displayReason || wake.reason],
      ["Candidates", routingCandidatesText(wake.routingCandidates || wake.routing_candidates || [])],
      ["Trace", triggerWakeTraceStatus(wake, repoRoot)],
    ]));
    output.detail(`wake=${redactOAuthSecrets(JSON.stringify(wake))}`);
  }
}

function triggerWakeNeedsAttention(wake) {
  const status = String(wake.derived_status || wake.status || "");
  return /dead|error|failed|routing|expired|lost/i.test(status) || Boolean(wake.displayReason);
}

function triggerWakeHeadline(wake) {
  const status = wake.derived_status || wake.status || "unknown";
  const objectId = wake.object_id || wake.objectId || wake.id || wake.wake_id || "wake";
  return `${objectId}: ${humanizeToken(status)}`;
}

function triggerWakeTraceStatus(wake, repoRoot) {
  const receipt = wake.run_id ? readTraceReceipt({ repoRoot, runId: wake.run_id }) : null;
  return receipt?.trace_status || null;
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
  output.detail("external_actions=no hosted wakes claimed, no Linear writes, no GitHub writes");
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
