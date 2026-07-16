import { readLinearCache } from "./cache.mjs";
import { acquireGatewayLock } from "./gateway-loop.mjs";
import { createLinearSetupGraphqlClient } from "./linear-setup-auth.mjs";
import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import {
  createLocalTriggerStore,
  recoverLocalMutationReconciliation,
} from "./local-trigger-store.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  smokeTestsFromRuntimeSmokeCache,
} from "./runtime-smoke.mjs";
import { createProcessRuntimeExecutor, runTriggeredWorkflow } from "./trigger-runner.mjs";
import { DECOMPOSITION_REQUIRED_CAPABILITIES } from "./workflows/decomposition/definition.mjs";
import { resolveTeamiHome } from "./app-home.mjs";

const DEFAULT_LOCAL_LEASE_DURATION_MS = 5 * 60 * 1000;

export async function runForegroundTriggerRunnerOnce({
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  credentialStore,
  cachePath,
  teamContext = null,
  registry = null,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createTraceSink = createLocalPhoenixTraceSink,
  runTriggeredWorkflowFn = null,
  runTriggeredDecompositionFn = null,
  recoverMutationState = recoverLocalMutationReconciliation,
  acquireTeamAuthority = acquireGatewayLock,
} = {}) {
  const teamAuthority = acquireTeamAuthority({ home, installHandlers: false });
  if (!teamAuthority.ok) return { status: "refused", reason: "team_authority_busy" };
  try {
    const cache = readLinearCache(cachePath);
    recoverMutationState({ repoRoot, home });
    const store = createLocalTriggerStore({ repoRoot, home });
    const runtimeSmokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, home));
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
        runnerId: localRunnerId({ teamContext, workspaceId: cache?.workspaceId }),
        workspaceId: teamContext?.linear?.workspaceId || cache?.workspaceId,
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
        home,
        leaseDurationMs: config?.runner?.lease_duration_ms || DEFAULT_LOCAL_LEASE_DURATION_MS,
        runnerVersion: process.version,
        capabilities: config?.runner?.required_capabilities || DECOMPOSITION_REQUIRED_CAPABILITIES,
        traceSink,
        teamContext,
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
  } finally {
    teamAuthority.release();
  }
}

function localRunnerId({ teamContext = null, workspaceId = null } = {}) {
  return `local-runner:${teamContext?.teamRef || workspaceId || "default"}`;
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
