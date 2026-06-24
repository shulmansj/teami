import { readLinearCache } from "./cache.mjs";
import { createHostedWakeQueueStore } from "./hosted-wake-queue-store.mjs";
import { createLinearSetupGraphqlClient } from "./linear-setup-auth.mjs";
import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  smokeTestsFromRuntimeSmokeCache,
} from "./runtime-smoke.mjs";
import { createProcessRuntimeExecutor, runTriggeredWorkflow } from "./trigger-runner.mjs";

export async function runForegroundTriggerRunnerOnce({
  config,
  repoRoot = process.cwd(),
  credentialStore,
  runnerCredentialStore,
  inboxClient,
  cachePath,
  domainContext = null,
  registry = null,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  runTriggeredWorkflowFn = null,
  runTriggeredDecompositionFn = null,
} = {}) {
  const cache = readLinearCache(cachePath);
  const runnerCredential = await runnerCredentialStore?.readCredential?.();
  if (!runnerCredential) {
    throw new Error("Runner inbox credential is missing; run npm run init.");
  }
  const store = createHostedWakeQueueStore({ inboxClient, credential: runnerCredential });
  const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, repoRoot));
  const runtimeExecutor = createProcessRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(runtimeSmokeCache),
    repoRoot,
  });
  const traceSink = createTraceSink({ repoRoot });
  const runWorkflow = runTriggeredWorkflowFn || runTriggeredDecompositionFn || runTriggeredWorkflow;
  let result;
  try {
    result = await runWorkflow({
      store,
      runnerId: runnerCredential.credentialId,
      workspaceId: cache?.workspaceId || runnerCredential.workspaceId,
      linearClientFactory: async () => createSetupGraphqlClient({
        config,
        repoRoot,
        credentialStore,
        allowBrowserAuth: false,
        allowRefresh: true,
      }).client,
      config,
      cache,
      runtimeExecutor,
      repoRoot,
      leaseDurationMs: config.inbox.runner.lease_duration_ms,
      runnerVersion: process.version,
      capabilities: runnerCredential.capabilities || config.inbox.runner.required_capabilities,
      traceSink,
      domainContext,
      registry,
    });
  } finally {
    await traceSink.shutdown();
  }

  return {
    ...result,
    foreground_runner: {
      phoenix_lifecycle: "trace_sink_adopt_or_start",
    },
  };
}

export function formatForegroundRunnerReport(result) {
  const lines = [];
  if (result.foreground_runner?.phoenix_lifecycle === "trace_sink_adopt_or_start") {
    lines.push("local Phoenix: trace sink will adopt or start as needed");
  } else if (result.foreground_runner?.phoenix_reason) {
    lines.push(`local Phoenix: ${result.foreground_runner?.phoenix_reason || "not stopped"}`);
  }
  lines.push(`runner: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  if (result.traceDelivery) {
    lines.push(
      `trace: ${result.traceDelivery.status}${result.traceDelivery.phoenixAppUrl ? ` ${result.traceDelivery.phoenixAppUrl}` : ""}${result.traceDelivery.reason ? ` (${result.traceDelivery.reason})` : ""}`,
    );
  }
  if (result.deterministic_checks) {
    const terminalRunId = result.traceDelivery?.receipt?.run_id || result.wake?.run_id || null;
    if (result.deterministic_checks.ok) {
      lines.push(
        `deterministic checks: emitted ${result.deterministic_checks.emitted_count} CODE annotation(s) for run ${terminalRunId}`,
      );
    } else {
      lines.push(
        `deterministic checks: not emitted (${result.deterministic_checks.reason || result.deterministic_checks.storage}); run npm run eval:emit-checks -- ${terminalRunId || "<run_id>"}`,
      );
    }
  }
  return lines;
}
