import { createHash } from "node:crypto";

import { ensurePhoenixReady, phoenixStatus } from "./local-phoenix-manager.mjs";
import {
  appendAuditOnlyTraceOutbox,
  recordTraceStatus,
} from "./trace-status-store.mjs";
import {
  boundedRunReceiptProjection,
  DEFAULT_LOCAL_TRACE_POLICY,
  digestTraceField,
  enforceTraceContentPolicy,
  findSecretContentKeys,
  LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
  newTraceId,
} from "../../../engine/trace-contract.mjs";
import {
  PRODUCED_IDENTITIES_TRACE_ATTRIBUTE,
} from "../../../engine/produced-identities.mjs";
import { behaviorRepoIdForRepoRoot } from "./team-resolver.mjs";

const SERVICE_NAME = "teami-local-runner";
const PROJECT_ATTRIBUTE = "openinference.project.name";
const VERIFY_ATTEMPTS = 20;
const VERIFY_DELAY_MS = 500;
const TRACE_FETCH_TIMEOUT_MS = 5_000;
const RUNNER_READY_TIMEOUT_MS = 10_000;
const EVIDENCE_UNAVAILABLE_ATTRIBUTE = "teami.evidence_unavailable";
const TRACE_DIGEST_SPAN_NAME = "teami.trace_digest";
const TRACE_PAYLOAD_SCOPE = "trace.payload";
const TRACE_SPANS_SCOPE = "trace.spans";
const ROOT_COMPACT_ATTRIBUTE_KEYS = new Set([
  "run_id",
  "workflow.name",
  "wake_id",
  "linear_project_id",
  "workspace_id",
  "team_id",
  "team_ref",
  "behavior_repo_id",
  "teami.team_ref",
  "teami.behavior_repo_id",
  "teami.trace_id",
  PRODUCED_IDENTITIES_TRACE_ATTRIBUTE,
  "linear.workspace_id",
  "linear.team_id",
  "linear.project_id",
  "resource.kind",
  "resource.id",
  "resource.label",
  "work_type",
  "selected_resource_id",
  "resource_id",
  "github.behavior_repo_id",
  "github.behavior_repo_label",
]);

export function createLocalPhoenixTraceSink({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  statusProbe = phoenixStatus,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  idFactory = newTraceId,
  onProgress = () => {},
  runnerReadyTimeoutMs = RUNNER_READY_TIMEOUT_MS,
} = {}) {
  const exporters = new Set();

  return {
    async startRun({
      wake,
      sourceEvent = null,
      runId,
      workspaceId,
      runnerId,
      runnerVersion,
      teamContext = null,
    } = {}) {
      const traceId = idFactory();
      const run = runRecordFromWake({ wake, sourceEvent, runId, workspaceId, teamContext, repoRoot });
      let ready;
      try {
        ready = await withTimeout(
          ensureReady({ repoRoot, fetchImpl, now, onProgress, startTimeoutMs: runnerReadyTimeoutMs }),
          runnerReadyTimeoutMs,
          "phoenix_readiness_timeout",
        );
      } catch (error) {
        ready = await adoptHealthyPhoenixAfterReadinessFailure({
          repoRoot,
          fetchImpl,
          statusProbe,
        }).catch(() => null);
        ready ||= { ok: false, reason: "phoenix_start_failed", repairHint: error.message };
      }
      if (!ready.ok) {
        const repairHint = ready.repairHint || "Run npm run phoenix:doctor for local Phoenix repair guidance.";
        recordTraceStatus({
          repoRoot,
          runId,
          teamRef: run.team_ref,
          workspaceId: run.workspace_id,
          teamId: run.team_id,
          wakeId: wake?.id || null,
          projectId: wake?.object_id || null,
          attempt: wake?.attempt_count || null,
          workflowType: run.workflow_type,
          traceId,
          phoenixAppUrl: ready.appUrl || null,
          status: "trace_unavailable",
          reason: ready.reason || "phoenix_unavailable",
          repairHint,
          observedAt: now().toISOString(),
        });
        appendAuditOnlyTraceOutbox({
          repoRoot,
          observedAt: now().toISOString(),
          record: {
            run_id: runId,
            team_ref: run.team_ref,
            wake_id: wake?.id || null,
            trace_id: traceId,
            reason: ready.reason || "phoenix_unavailable",
            repair_hint: repairHint,
          },
        });
        return {
          ok: false,
          traceId,
          run,
          status: "trace_unavailable",
          reason: ready.reason || "phoenix_unavailable",
          repairHint,
          phoenixAppUrl: ready.appUrl || null,
          traceFailureRecorded: true,
        };
      }
      const exporter = createLocalPhoenixTraceExporter({
        collectorUrl: ready.collectorUrl,
        appUrl: ready.appUrl,
        projectName: ready.projectName,
        traceId,
        fetchImpl,
      });
      exporters.add(exporter);
      return {
        ok: true,
        traceId,
        run,
        exporter,
        status: "trace_unknown",
        phoenixAppUrl: ready.appUrl,
        collectorUrl: ready.collectorUrl,
        projectName: ready.projectName,
        managed: ready.managed,
        started: ready.started === true,
        reused: ready.reused === true,
        adoptedAfterReadinessFailure: ready.adoptedAfterReadinessFailure === true,
        traceFailureRecorded: false,
      };
    },

    async startAgentRun({
      runId,
      teamRef,
      workflowType,
      agentRole,
      resource,
      githubBehaviorRepoId = null,
      githubBehaviorRepoLabel = null,
    } = {}) {
      const traceId = idFactory();
      const run = runRecordFromAgent({
        runId,
        teamRef,
        workflowType,
        agentRole,
        resource,
        githubBehaviorRepoId,
        githubBehaviorRepoLabel,
        repoRoot,
      });
      let ready;
      try {
        ready = await withTimeout(
          ensureReady({ repoRoot, fetchImpl, now, onProgress, startTimeoutMs: runnerReadyTimeoutMs }),
          runnerReadyTimeoutMs,
          "phoenix_readiness_timeout",
        );
      } catch (error) {
        ready = await adoptHealthyPhoenixAfterReadinessFailure({
          repoRoot,
          fetchImpl,
          statusProbe,
        }).catch(() => null);
        ready ||= { ok: false, reason: "phoenix_start_failed", repairHint: error.message };
      }
      if (!ready.ok) {
        const repairHint = ready.repairHint || "Run npm run phoenix:doctor for local Phoenix repair guidance.";
        recordTraceStatus({
          repoRoot,
          runId,
          teamRef: run.team_ref,
          workspaceId: run.workspace_id,
          teamId: run.team_id,
          workflowType: run.workflow_type,
          resource: run.resource,
          githubBehaviorRepoId: run.github_behavior_repo_id,
          githubBehaviorRepoLabel: run.github_behavior_repo_label,
          traceId,
          phoenixAppUrl: ready.appUrl || null,
          status: "trace_unavailable",
          reason: ready.reason || "phoenix_unavailable",
          repairHint,
          observedAt: now().toISOString(),
        });
        appendAuditOnlyTraceOutbox({
          repoRoot,
          observedAt: now().toISOString(),
          record: {
            run_id: runId,
            team_ref: run.team_ref,
            resource: run.resource,
            github_behavior_repo_id: run.github_behavior_repo_id,
            github_behavior_repo_label: run.github_behavior_repo_label,
            trace_id: traceId,
            reason: ready.reason || "phoenix_unavailable",
            repair_hint: repairHint,
          },
        });
        return {
          ok: false,
          traceId,
          run,
          status: "trace_unavailable",
          reason: ready.reason || "phoenix_unavailable",
          repairHint,
          phoenixAppUrl: ready.appUrl || null,
          traceFailureRecorded: true,
        };
      }
      const exporter = createLocalPhoenixTraceExporter({
        collectorUrl: ready.collectorUrl,
        appUrl: ready.appUrl,
        projectName: ready.projectName,
        traceId,
        fetchImpl,
      });
      exporters.add(exporter);
      return {
        ok: true,
        traceId,
        run,
        exporter,
        status: "trace_unknown",
        phoenixAppUrl: ready.appUrl,
        collectorUrl: ready.collectorUrl,
        projectName: ready.projectName,
        managed: ready.managed,
        started: ready.started === true,
        reused: ready.reused === true,
        adoptedAfterReadinessFailure: ready.adoptedAfterReadinessFailure === true,
        traceFailureRecorded: false,
      };
    },

    async forceFlush({ session, trace, result = null, stage = "checkpoint" } = {}) {
      if (!session?.exporter || !trace) return { ok: false, status: "trace_unavailable", reason: "phoenix_unavailable" };
      try {
        return await session.exporter.forceFlush({
          trace,
          run: {
            ...session.run,
            status: result?.status || session.run?.status || "running",
            terminal_reason: result?.reason || result?.failureReasons?.join?.(",") || null,
          },
          observedAt: new Date().toISOString(),
          stage,
        });
      } catch (error) {
        recordTraceFailure({ repoRoot, session, status: "trace_delivery_failed", reason: error.message, now });
        return { ok: false, status: "trace_delivery_failed", reason: error.message };
      }
    },

    async finishRun({ session, result, wake = null } = {}) {
      if (!session) return null;
      const trace = result?.trace;
      if (!session.exporter || !trace) {
        recordTraceFailure({
          repoRoot,
          session,
          status: session.status === "trace_unavailable" ? "trace_unavailable" : "trace_unknown",
          reason: session.reason || "trace_not_available",
          now,
        });
        return { status: session.status || "trace_unknown", reason: session.reason || "trace_not_available" };
      }
      const flushed = await this.forceFlush({ session, trace, result, stage: "final" });
      if (!flushed.ok) return flushed;
      const requiredSpanNames = Array.isArray(flushed.exportedSpanNames)
        ? flushed.exportedSpanNames
        : trace.spans?.map((span) => span.name).filter(Boolean) || [];
      const verified = await verifyTraceDelivery({
        appUrl: session.phoenixAppUrl,
        projectName: session.projectName,
        traceId: session.traceId,
        requiredSpanNames,
        fetchImpl,
      });
      if (!verified.ok) {
        recordTraceFailure({
          repoRoot,
          session,
          status: "trace_delivery_failed",
          reason: verified.reason,
          now,
          wake,
        });
        return { status: "trace_delivery_failed", reason: verified.reason };
      }
      const run = {
        ...session.run,
        status: result?.status || wake?.status || null,
        terminal_reason: result?.reason || result?.failureReasons?.join?.(",") || null,
        provider_update_ids: providerUpdateIdsForResult(result),
      };
      const receipt = boundedRunReceiptProjection({
        run,
        trace,
        traceStatus: "trace_exported",
        traceId: session.traceId,
        phoenixAppUrl: session.phoenixAppUrl,
        providerUpdateIds: run.provider_update_ids,
      });
      recordTraceStatus({
        repoRoot,
        runId: run.run_id,
        teamRef: run.team_ref,
        workspaceId: run.workspace_id,
        teamId: run.team_id,
        wakeId: run.wake_id,
        projectId: run.object_id,
        attempt: run.current_attempt,
        workflowType: run.workflow_type,
        resource: run.resource,
        githubBehaviorRepoId: run.github_behavior_repo_id,
        githubBehaviorRepoLabel: run.github_behavior_repo_label,
        traceId: session.traceId,
        phoenixAppUrl: session.phoenixAppUrl,
        status: "trace_exported",
        reason: null,
        repairHint: null,
        observedAt: now().toISOString(),
      });
      return { status: "trace_exported", traceId: session.traceId, phoenixAppUrl: session.phoenixAppUrl, receipt };
    },

    async shutdown() {
      const results = [];
      for (const exporter of exporters) {
        results.push(await exporter.shutdown());
      }
      exporters.clear();
      return results;
    },
  };
}

async function adoptHealthyPhoenixAfterReadinessFailure({ repoRoot, fetchImpl, statusProbe }) {
  if (typeof statusProbe !== "function") return null;
  const status = await statusProbe({ repoRoot, fetchImpl });
  if (!status?.ok) return null;
  return {
    ok: true,
    appUrl: status.appUrl,
    collectorUrl: status.collectorUrl,
    projectName: status.projectName,
    managed: false,
    reused: true,
    started: false,
    metadata: status.metadata || null,
    adoptedAfterReadinessFailure: true,
  };
}

export function createLocalPhoenixTraceExporter({
  collectorUrl,
  appUrl,
  projectName,
  traceId,
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = TRACE_FETCH_TIMEOUT_MS,
} = {}) {
  const sentSpanIds = new Set();
  const exportedSpanNames = new Set();
  let shutdownCalled = false;
  let rootSent = false;
  let transport = "otlp_json";
  let projectEnsured = false;
  return {
    get shutdownCalled() {
      return shutdownCalled;
    },
    async forceFlush({ trace, run = {}, observedAt = new Date().toISOString(), stage = "checkpoint" } = {}) {
      if (shutdownCalled) throw new Error("local Phoenix exporter is shut down");
      const requestedIncludeRoot = stage === "final" || !rootSent;
      const accountedSpanIds = unsentTraceSpanIds({ trace, traceId, sentSpanIds });
      const preparedTrace = prepareTraceForExport(trace, {
        policy: LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
        sentSpanIds,
        includeRoot: requestedIncludeRoot,
        traceId,
      });
      const includeRoot = requestedIncludeRoot || evidenceUnavailableMarkerCreated(trace, preparedTrace);
      const policy = enforceTraceContentPolicy(preparedTrace, LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS);
      if (!policy.ok) throw new Error(policy.reason);
      const exportPayload = buildPhoenixOtlpTraceExport({
        projectName,
        run,
        trace: preparedTrace,
        traceId,
        observedAt,
        includeRoot,
        sentSpanIds,
        stage,
      });
      const spans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
      if (spans.length === 0) return { ok: true, skipped: true, exportedSpanNames: [...exportedSpanNames] };
      const markExported = () => {
        rootSent ||= spans.some((span) => span.name === "teami.workflow_run");
        return markExportedSpans({
          spans,
          accountedSpanIds,
          sentSpanIds,
          exportedSpanNames,
        });
      };
      if (transport === "phoenix_rest_spans") {
        return await exportRestSpans({
          appUrl,
          projectName,
          fetchImpl,
          fetchTimeoutMs,
          exportPayload,
          spans,
          ensureProject: async () => {
            if (projectEnsured) return;
            await ensurePhoenixProjectExists({ appUrl, projectName, fetchImpl, fetchTimeoutMs });
            projectEnsured = true;
          },
          markExported,
          traceId,
        });
      }
      const response = await fetchWithTimeout(collectorUrl, {
        fetchImpl,
        timeoutMs: fetchTimeoutMs,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-project-name": projectName,
        },
        body: JSON.stringify(exportPayload),
      });
      if (response.status === 415) {
        transport = "phoenix_rest_spans";
        return await exportRestSpans({
          appUrl,
          projectName,
          fetchImpl,
          fetchTimeoutMs,
          exportPayload,
          spans,
          ensureProject: async () => {
            if (projectEnsured) return;
            await ensurePhoenixProjectExists({ appUrl, projectName, fetchImpl, fetchTimeoutMs });
            projectEnsured = true;
          },
          markExported,
          traceId,
        });
      }
      if (!response.ok) throw new Error(`phoenix_otlp_http_${response.status}`);
      rootSent ||= spans.some((span) => span.name === "teami.workflow_run");
      const cumulativeExportedSpanNames = markExported();
      return { ok: true, exportedSpanCount: spans.length, appUrl, traceId, exportedSpanNames: cumulativeExportedSpanNames };
    },
    async shutdown() {
      shutdownCalled = true;
      return { ok: true };
    },
  };
}

export function prepareTraceForExport(trace, {
  policy = DEFAULT_LOCAL_TRACE_POLICY,
  sentSpanIds = new Set(),
  includeRoot = true,
  traceId = "",
} = {}) {
  if (!isRecord(trace)) return { attributes: {}, annotations: [], spans: [] };
  if (findSecretContentKeys(trace).length > 0) return trace;

  const normalizedPolicy = normalizeTracePolicy(policy);
  const pending = pendingTraceSpanEntries({ trace, traceId, sentSpanIds });
  const baseTrace = buildPreparedTrace({
    trace,
    entries: pending,
    includeRoot,
  });
  if (traceFitsExportPolicy(baseTrace, normalizedPolicy)) return baseTrace;

  const reasons = evidenceUnavailableReasonsForTrace(baseTrace, pending, normalizedPolicy);
  const digestSlots = Math.max(normalizedPolicy.max_spans_per_export - 1, 0);
  let kept = pending.slice(0, digestSlots);
  let folded = pending.slice(digestSlots);
  let rootCompacted = false;
  if (folded.length > 0) {
    addEvidenceUnavailableReason(reasons, TRACE_SPANS_SCOPE, "too_many_trace_spans");
  }

  let candidate = buildReducedTrace({
    trace,
    kept,
    folded,
    reasons,
    traceId,
    sentSpanIds,
    rootCompacted,
  });
  while (!traceFitsExportPolicy(candidate, normalizedPolicy) && kept.length > 0) {
    folded = [kept.at(-1), ...folded];
    kept = kept.slice(0, -1);
    addEvidenceUnavailableReason(reasons, TRACE_PAYLOAD_SCOPE, "trace_payload_too_large");
    candidate = buildReducedTrace({
      trace,
      kept,
      folded,
      reasons,
      traceId,
      sentSpanIds,
      rootCompacted,
    });
  }

  if (!traceFitsExportPolicy(candidate, normalizedPolicy)) {
    rootCompacted = true;
    addEvidenceUnavailableReason(reasons, TRACE_PAYLOAD_SCOPE, "trace_payload_too_large");
    candidate = buildReducedTrace({
      trace,
      kept,
      folded,
      reasons,
      traceId,
      sentSpanIds,
      rootCompacted,
    });
  }
  while (!traceFitsExportPolicy(candidate, normalizedPolicy) && kept.length > 0) {
    folded = [kept.at(-1), ...folded];
    kept = kept.slice(0, -1);
    candidate = buildReducedTrace({
      trace,
      kept,
      folded,
      reasons,
      traceId,
      sentSpanIds,
      rootCompacted,
    });
  }

  return candidate;
}

export async function runLocalPhoenixTracePreflight({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  idFactory = newTraceId,
  onProgress = () => {},
  teamContext = null,
} = {}) {
  if (
    !teamContext?.trace?.team_ref ||
    !teamContext?.trace?.workspace_id ||
    !teamContext?.trace?.team_id
  ) {
    throw new Error("Local Phoenix preflight requires a resolved TeamContext. Run npm run init or pass --team after setup.");
  }
  const observedAt = now().toISOString();
  const runId = `phoenix-preflight-${observedAt.replace(/[^0-9TZ]/g, "")}`;
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady,
    fetchImpl,
    now,
    idFactory,
    onProgress,
  });
  const session = await sink.startRun({
    runId,
    workspaceId: teamContext.trace.workspace_id,
    sourceEvent: { id: "local-phoenix-preflight" },
    teamContext,
  });
  try {
    const trace = {
      attributes: {
        "workflow.name": "phoenix_preflight",
        run_id: runId,
      },
      annotations: [{
        name: "phoenix_preflight",
        createdAt: observedAt,
        attributes: {
          "teami.preflight": true,
        },
      }],
      spans: [{
        name: "phoenix_preflight",
        kind: "TOOL",
        status: "completed",
        startedAt: observedAt,
        endedAt: now().toISOString(),
        attributes: {
          "teami.preflight": true,
          "teami.trace_id": session.traceId,
        },
      }],
    };
    const delivery = await sink.finishRun({
      session,
      result: {
        status: session.ok ? "completed" : "failed",
        reason: session.reason || null,
        trace,
      },
    });
    return {
      ok: delivery?.status === "trace_exported",
      runId,
      traceId: session.traceId,
      appUrl: session.phoenixAppUrl || delivery?.phoenixAppUrl || null,
      collectorUrl: session.collectorUrl || null,
      projectName: session.projectName || null,
      status: delivery?.status || session.status || "trace_unknown",
      reason: delivery?.reason || session.reason || null,
      repairHint: session.repairHint || (delivery?.status === "trace_exported" ? null : "Run npm run phoenix:doctor for local Phoenix repair guidance."),
      receipt: delivery?.receipt || null,
    };
  } finally {
    await sink.shutdown();
  }
}

export function buildPhoenixOtlpTraceExport({
  projectName,
  run,
  trace,
  traceId,
  observedAt = new Date().toISOString(),
  includeRoot = true,
  sentSpanIds = new Set(),
  stage = "final",
} = {}) {
  assertOtlpTraceId(traceId);
  const startedAt = trace?.spans?.[0]?.startedAt || run?.started_at || observedAt;
  const endedAt = observedAt;
  const rootSpanId = stableSpanId(`${traceId}:root`);
  const root = includeRoot
    ? [{
        traceId,
        spanId: rootSpanId,
        name: "teami.workflow_run",
        kind: 1,
        startTimeUnixNano: timeUnixNano(startedAt),
        endTimeUnixNano: timeUnixNano(endedAt),
        attributes: otlpAttributes({
          "openinference.span.kind": "CHAIN",
          "teami.run_id": run?.run_id || trace?.attributes?.run_id,
          "teami.team_ref":
            run?.team_ref ||
            trace?.attributes?.["teami.team_ref"] ||
            trace?.attributes?.team_ref,
          "teami.behavior_repo_id":
            run?.behavior_repo_id ||
            trace?.attributes?.["teami.behavior_repo_id"] ||
            trace?.attributes?.behavior_repo_id,
          "teami.wake_id": run?.wake_id || trace?.attributes?.wake_id,
          "teami.workflow_type": run?.workflow_type || trace?.attributes?.["workflow.name"],
          "teami.object_id": run?.object_id || trace?.attributes?.linear_project_id,
          "teami.trace_id": traceId,
          "teami.flush_stage": stage,
          "teami.unpinned_runtime": trace?.attributes?.["teami.unpinned_runtime"],
          "teami.work_type": trace?.attributes?.work_type,
          "teami.selected_resource_id":
            trace?.attributes?.selected_resource_id ||
            trace?.attributes?.resource_id ||
            trace?.attributes?.["resource.id"],
          [PRODUCED_IDENTITIES_TRACE_ATTRIBUTE]: producedIdentitiesTraceCarrier(
            trace?.attributes?.[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE],
          ),
          [EVIDENCE_UNAVAILABLE_ATTRIBUTE]: trace?.attributes?.[EVIDENCE_UNAVAILABLE_ATTRIBUTE],
          "resource.kind":
            run?.resource?.kind ||
            trace?.attributes?.["resource.kind"] ||
            trace?.attributes?.resource_kind,
          "resource.id":
            run?.resource?.id ||
            trace?.attributes?.["resource.id"] ||
            trace?.attributes?.resource_id,
          "resource.label":
            run?.resource?.label ||
            trace?.attributes?.["resource.label"] ||
            trace?.attributes?.resource_label,
          work_type: trace?.attributes?.work_type,
          selected_resource_id:
            trace?.attributes?.selected_resource_id ||
            trace?.attributes?.resource_id ||
            trace?.attributes?.["resource.id"],
          resource_id:
            trace?.attributes?.resource_id ||
            trace?.attributes?.["resource.id"],
          "github.behavior_repo_id":
            run?.github_behavior_repo_id ||
            trace?.attributes?.["github.behavior_repo_id"] ||
            trace?.attributes?.github_behavior_repo_id,
          "github.behavior_repo_label":
            run?.github_behavior_repo_label ||
            trace?.attributes?.["github.behavior_repo_label"] ||
            trace?.attributes?.github_behavior_repo_label,
          "linear.workspace_id":
            run?.workspace_id ||
            trace?.attributes?.["linear.workspace_id"] ||
            trace?.attributes?.workspace_id,
          "linear.team_id":
            run?.team_id ||
            trace?.attributes?.["linear.team_id"] ||
            trace?.attributes?.team_id,
          "linear.project_id":
            trace?.attributes?.["linear.project_id"] ||
            run?.object_id ||
            trace?.attributes?.linear_project_id,
        }),
        events: (trace?.annotations || []).map((annotation, index) => ({
          name: safeName(annotation?.name || annotation?.type || `annotation.${index + 1}`),
          timeUnixNano: timeUnixNano(annotation?.createdAt || observedAt),
          attributes: otlpAttributes(annotation?.attributes || annotation),
        })),
        status: { code: statusCodeForRun(run?.status), message: run?.terminal_reason || "" },
      }]
    : [];
  const childSpans = (trace?.spans || []).map((span, index) => {
    const spanId = validSpanId(span?.spanId)
      ? span.spanId.toLowerCase()
      : stableSpanId(`${traceId}:span:${index}:${span?.name || ""}`);
    if (sentSpanIds.has(spanId)) return null;
    return {
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: safeName(span?.name || `teami.span.${index + 1}`),
      kind: 1,
      startTimeUnixNano: timeUnixNano(span?.startedAt || startedAt),
      endTimeUnixNano: timeUnixNano(span?.endedAt || endedAt),
      attributes: otlpAttributes({
        "openinference.span.kind": span?.kind || span?.spanKind || "UNKNOWN",
        ...(span?.attributes || {}),
        ...evidenceSpanAttributes(span?.attributes || {}),
      }),
      events: Array.isArray(span?.events)
        ? span.events.map((event, eventIndex) => ({
            name: safeName(event?.name || `event.${eventIndex + 1}`),
            timeUnixNano: timeUnixNano(event?.timestamp || event?.createdAt || observedAt),
            attributes: otlpAttributes(event?.attributes || event),
          }))
        : [],
      status: { code: statusCodeForRun(span?.status), message: span?.statusMessage || "" },
    };
  }).filter(Boolean);
  return {
    resourceSpans: [{
      resource: {
        attributes: otlpAttributes({
          "service.name": SERVICE_NAME,
          [PROJECT_ATTRIBUTE]: projectName,
        }),
      },
      scopeSpans: [{
        scope: {
          name: "teami.local-phoenix",
          version: "1",
        },
        spans: [...root, ...childSpans],
      }],
    }],
  };
}

function evidenceSpanAttributes(attributes = {}) {
  const mirrored = {};
  if (
    Object.hasOwn(attributes, "outcome") &&
    !Object.hasOwn(attributes, "teami.outcome")
  ) {
    mirrored["teami.outcome"] = attributes.outcome;
  }
  if (
    Object.hasOwn(attributes, "perspectives_run") &&
    !Object.hasOwn(attributes, "teami.perspectives_run")
  ) {
    mirrored["teami.perspectives_run"] = attributes.perspectives_run;
  }
  return mirrored;
}

export function buildPhoenixRestSpanUpload({
  projectName,
  run,
  trace,
  traceId,
  observedAt = new Date().toISOString(),
  includeRoot = true,
  sentSpanIds = new Set(),
  stage = "final",
} = {}) {
  const otlp = buildPhoenixOtlpTraceExport({
    projectName,
    run,
    trace,
    traceId,
    observedAt,
    includeRoot,
    sentSpanIds,
    stage,
  });
  return buildPhoenixRestSpanUploadFromOtlp(otlp);
}

function buildPhoenixRestSpanUploadFromOtlp(otlp) {
  return {
    data: otlp.resourceSpans[0].scopeSpans[0].spans.map((span) => {
      const restSpan = {
        name: span.name,
        context: {
          trace_id: span.traceId,
          span_id: span.spanId,
        },
        span_kind: attributeValue(span.attributes, "openinference.span.kind") || "UNKNOWN",
        start_time: isoFromUnixNano(span.startTimeUnixNano),
        end_time: isoFromUnixNano(span.endTimeUnixNano),
        status_code: restStatusCode(span.status?.code),
        status_message: span.status?.message || "",
        attributes: attributesToObject(span.attributes),
        events: (span.events || []).map((event) => ({
          name: event.name,
          timestamp: isoFromUnixNano(event.timeUnixNano),
          attributes: attributesToObject(event.attributes),
        })),
      };
      if (span.parentSpanId) restSpan.parent_id = span.parentSpanId;
      return restSpan;
    }),
  };
}

function normalizeTracePolicy(policy) {
  const explicitPolicy = isRecord(policy?.policy) ? policy.policy : policy;
  return { ...DEFAULT_LOCAL_TRACE_POLICY, ...(isRecord(explicitPolicy) ? explicitPolicy : {}) };
}

function traceFitsExportPolicy(trace, policy) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  return spans.length <= policy.max_spans_per_export
    && tracePayloadBytes(trace) <= policy.max_trace_payload_bytes;
}

function tracePayloadBytes(trace) {
  try {
    const serialized = JSON.stringify(trace);
    return Buffer.byteLength(serialized || "null", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function evidenceUnavailableReasonsForTrace(trace, pending, policy) {
  const reasons = [];
  if (pending.length > policy.max_spans_per_export) {
    addEvidenceUnavailableReason(reasons, TRACE_SPANS_SCOPE, "too_many_trace_spans");
  }
  if (tracePayloadBytes(trace) > policy.max_trace_payload_bytes) {
    addEvidenceUnavailableReason(reasons, TRACE_PAYLOAD_SCOPE, "trace_payload_too_large");
  }
  if (reasons.length === 0) {
    addEvidenceUnavailableReason(reasons, TRACE_PAYLOAD_SCOPE, "trace_payload_too_large");
  }
  return reasons;
}

function addEvidenceUnavailableReason(reasons, scope, reason) {
  if (!reasons.some((entry) => entry.scope === scope && entry.reason === reason)) {
    reasons.push({ scope, reason });
  }
}

function buildPreparedTrace({ trace, entries, includeRoot }) {
  return {
    attributes: includeRoot ? rootAttributesForPreparedTrace(trace) : {},
    annotations: includeRoot && Array.isArray(trace?.annotations) ? trace.annotations : [],
    spans: entries.map(cloneTraceSpanEntry),
  };
}

function buildReducedTrace({
  trace,
  kept,
  folded,
  reasons,
  traceId,
  sentSpanIds,
  rootCompacted,
}) {
  const spans = kept.map(cloneTraceSpanEntry);
  if (reasons.length > 0 || folded.length > 0 || rootCompacted) {
    spans.push(buildTraceDigestSpan({
      trace,
      kept,
      folded,
      reasons,
      traceId,
      sentSpanIds,
      rootCompacted,
    }));
  }
  return {
    attributes: rootAttributesForPreparedTrace(trace, { markers: reasons, compact: rootCompacted }),
    annotations: !rootCompacted && Array.isArray(trace?.annotations) ? trace.annotations : [],
    spans,
  };
}

function rootAttributesForPreparedTrace(trace, { markers = [], compact = false } = {}) {
  const source = isRecord(trace?.attributes) ? trace.attributes : {};
  const attributes = compact ? compactRootAttributes(source) : { ...source };
  if (markers.length > 0) {
    attributes[EVIDENCE_UNAVAILABLE_ATTRIBUTE] = mergeEvidenceUnavailableMarkers(
      source[EVIDENCE_UNAVAILABLE_ATTRIBUTE],
      markers,
    );
  }
  return attributes;
}

function compactRootAttributes(attributes) {
  const compacted = {};
  for (const key of ROOT_COMPACT_ATTRIBUTE_KEYS) {
    if (
      Object.hasOwn(attributes, key) &&
      (isJsonSafeScalar(attributes[key]) ||
        (key === PRODUCED_IDENTITIES_TRACE_ATTRIBUTE && producedIdentitiesTraceCarrier(attributes[key])))
    ) {
      compacted[key] = attributes[key];
    }
  }
  return compacted;
}

function buildTraceDigestSpan({
  trace,
  kept,
  folded,
  reasons,
  traceId,
  sentSpanIds,
  rootCompacted,
}) {
  const foldedSpanRefs = folded.map((entry) => ({
    index: entry.index,
    span_id: entry.spanId,
    name: spanName(entry.span, entry.index),
  }));
  const digestPayload = {
    reasons,
    folded_spans: folded.map((entry) => ({
      index: entry.index,
      span_id: entry.spanId,
      name: spanName(entry.span, entry.index),
      span: entry.span,
    })),
    ...(rootCompacted
      ? {
          trace_attributes: isRecord(trace?.attributes) ? trace.attributes : {},
          trace_annotations: Array.isArray(trace?.annotations) ? trace.annotations : [],
        }
      : {}),
  };
  const digest = digestTraceField(digestPayload);
  const spanId = digestSpanId({
    traceId,
    digest,
    kept,
    folded,
    sentSpanIds,
    rootCompacted,
  });
  const firstFolded = folded[0]?.span;
  const lastFolded = folded.at(-1)?.span;
  return {
    name: TRACE_DIGEST_SPAN_NAME,
    spanId,
    kind: "INTERNAL",
    status: "completed",
    ...(firstFolded?.startedAt ? { startedAt: firstFolded.startedAt } : {}),
    ...(lastFolded?.endedAt ? { endedAt: lastFolded.endedAt } : {}),
    attributes: {
      "teami.digest": digest,
      "teami.digest_scope": [...new Set(reasons.map((entry) => entry.scope))],
      "teami.folded_span_count": folded.length,
      "teami.folded_span_first_index": folded[0]?.index ?? null,
      "teami.folded_span_last_index": folded.at(-1)?.index ?? null,
      "teami.folded_span_first_name": foldedSpanRefs[0]?.name ?? null,
      "teami.folded_span_last_name": foldedSpanRefs.at(-1)?.name ?? null,
      "teami.root_compacted": rootCompacted,
      [EVIDENCE_UNAVAILABLE_ATTRIBUTE]: reasons,
    },
  };
}

function digestSpanId({ traceId, digest, kept, folded, sentSpanIds, rootCompacted }) {
  const reservedSpanIds = new Set([
    stableSpanId(`${traceId}:root`),
    ...[...sentSpanIds].map((spanId) => String(spanId).toLowerCase()),
    ...kept.map((entry) => entry.spanId),
    ...folded.map((entry) => entry.spanId),
  ]);
  const foldedRange = `${folded[0]?.index ?? "none"}:${folded.at(-1)?.index ?? "none"}:${folded.length}`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `:${attempt}`;
    const spanId = stableSpanId(`${traceId}:span:digest:${foldedRange}:${rootCompacted}:${digest}${suffix}`);
    if (!reservedSpanIds.has(spanId)) return spanId;
  }
  return stableSpanId(`${traceId}:span:digest:fallback:${digest}`);
}

function evidenceUnavailableMarkerCreated(originalTrace, preparedTrace) {
  const before = evidenceUnavailableMarkerKeys(originalTrace?.attributes?.[EVIDENCE_UNAVAILABLE_ATTRIBUTE]);
  const after = evidenceUnavailableMarkerKeys(preparedTrace?.attributes?.[EVIDENCE_UNAVAILABLE_ATTRIBUTE]);
  return [...after].some((key) => !before.has(key));
}

function evidenceUnavailableMarkerKeys(value) {
  return new Set(normalizeEvidenceUnavailableMarkers(value).map((entry) => `${entry.scope}\u0000${entry.reason}`));
}

function mergeEvidenceUnavailableMarkers(existing, additions) {
  const merged = normalizeEvidenceUnavailableMarkers(existing);
  for (const marker of normalizeEvidenceUnavailableMarkers(additions)) {
    if (!merged.some((entry) => entry.scope === marker.scope && entry.reason === marker.reason)) {
      merged.push(marker);
    }
  }
  return merged;
}

function normalizeEvidenceUnavailableMarkers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry?.scope === "string" && typeof entry?.reason === "string")
    .map((entry) => ({ scope: entry.scope, reason: entry.reason }));
}

function unsentTraceSpanIds({ trace, traceId, sentSpanIds }) {
  return pendingTraceSpanEntries({ trace, traceId, sentSpanIds }).map((entry) => entry.spanId);
}

function pendingTraceSpanEntries({ trace, traceId, sentSpanIds }) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  return spans
    .map((span, index) => ({
      span,
      index,
      spanId: spanIdForTraceSpan({ traceId, span, index }),
    }))
    .filter((entry) => !sentSpanIds.has(entry.spanId));
}

function spanIdForTraceSpan({ traceId, span, index }) {
  return validSpanId(span?.spanId)
    ? span.spanId.toLowerCase()
    : stableSpanId(`${traceId}:span:${index}:${span?.name || ""}`);
}

function cloneTraceSpanEntry(entry) {
  const source = isRecord(entry.span) ? entry.span : {};
  return { ...source, name: spanName(entry.span, entry.index), spanId: entry.spanId };
}

function spanName(span, index) {
  return span?.name || `teami.span.${index + 1}`;
}

function markExportedSpans({ spans, accountedSpanIds, sentSpanIds, exportedSpanNames }) {
  for (const spanId of accountedSpanIds) sentSpanIds.add(String(spanId).toLowerCase());
  for (const span of spans) {
    if (span?.spanId) sentSpanIds.add(String(span.spanId).toLowerCase());
    if (span?.name) exportedSpanNames.add(span.name);
  }
  return [...exportedSpanNames];
}

function isJsonSafeScalar(value) {
  return typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function verifyTraceDelivery({
  appUrl,
  projectName,
  traceId,
  requiredSpanNames = [],
  fetchImpl = globalThis.fetch,
  attempts = VERIFY_ATTEMPTS,
  delayMs = VERIFY_DELAY_MS,
  fetchTimeoutMs = TRACE_FETCH_TIMEOUT_MS,
} = {}) {
  if (!appUrl || !projectName || !traceId) return { ok: false, reason: "missing_trace_verification_context" };
  const url = new URL(`/v1/projects/${encodeURIComponent(projectName)}/traces`, appUrl);
  url.searchParams.set("include_spans", "true");
  url.searchParams.set("limit", "100");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { fetchImpl, timeoutMs: fetchTimeoutMs });
      if (response.ok) {
        const body = await response.json();
        const trace = (body.data || []).find((candidate) => candidate.trace_id === traceId);
        if (trace) {
          const names = new Set((trace.spans || []).map((span) => span.name));
          const missing = requiredSpanNames.filter((name) => !names.has(name));
          if (missing.length === 0) return { ok: true, trace };
          return { ok: false, reason: `missing_exported_spans:${missing.join(",")}` };
        }
      }
    } catch (error) {
      if (attempt === attempts - 1) return { ok: false, reason: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, reason: "trace_not_found_in_phoenix" };
}

function recordTraceFailure({ repoRoot, session, status, reason, now, wake = null }) {
  if (session.traceFailureRecorded) return;
  session.traceFailureRecorded = true;
  const repairHint = "Run npm run phoenix:doctor for local Phoenix repair guidance.";
  recordTraceStatus({
    repoRoot,
    runId: session.run?.run_id,
    teamRef: session.run?.team_ref,
    workspaceId: session.run?.workspace_id,
    teamId: session.run?.team_id,
    wakeId: session.run?.wake_id || wake?.id || null,
    projectId: session.run?.object_id || wake?.object_id || null,
    attempt: session.run?.current_attempt || wake?.attempt_count || null,
    workflowType: session.run?.workflow_type || null,
    resource: session.run?.resource || null,
    githubBehaviorRepoId: session.run?.github_behavior_repo_id || null,
    githubBehaviorRepoLabel: session.run?.github_behavior_repo_label || null,
    traceId: session.traceId,
    phoenixAppUrl: session.phoenixAppUrl || null,
    status,
    reason,
    repairHint,
    observedAt: now().toISOString(),
  });
  appendAuditOnlyTraceOutbox({
    repoRoot,
    observedAt: now().toISOString(),
    record: {
      run_id: session.run?.run_id,
      team_ref: session.run?.team_ref,
      wake_id: session.run?.wake_id || wake?.id || null,
      resource: session.run?.resource || null,
      github_behavior_repo_id: session.run?.github_behavior_repo_id || null,
      github_behavior_repo_label: session.run?.github_behavior_repo_label || null,
      trace_id: session.traceId,
      reason,
      repair_hint: repairHint,
    },
  });
}

async function ensurePhoenixProjectExists({ appUrl, projectName, fetchImpl, fetchTimeoutMs }) {
  const listUrl = new URL("/v1/projects", appUrl);
  listUrl.searchParams.set("name", projectName);
  listUrl.searchParams.set("limit", "10");
  const listResponse = await fetchWithTimeout(listUrl, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
  });
  if (listResponse.ok) {
    const body = await listResponse.json();
    if ((body.data || []).some((project) => project.name === projectName)) return;
  }
  const url = new URL("/v1/projects", appUrl);
  const response = await fetchWithTimeout(url, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      description: "Teami local traces",
    }),
  });
  if (response.ok || response.status === 409 || response.status === 422) return;
  throw new Error(`phoenix_project_http_${response.status}`);
}

async function exportRestSpans({
  appUrl,
  projectName,
  fetchImpl,
  fetchTimeoutMs,
  exportPayload,
  spans,
  ensureProject,
  markExported,
  traceId,
}) {
  await ensureProject();
  const restUrl = new URL(`/v1/projects/${encodeURIComponent(projectName)}/spans`, appUrl);
  const restResponse = await fetchWithTimeout(restUrl, {
    fetchImpl,
    timeoutMs: fetchTimeoutMs,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildPhoenixRestSpanUploadFromOtlp(exportPayload)),
  });
  if (!restResponse.ok) {
    // Phoenix 400s a request whose spans it has already ingested (idempotent re-delivery —
    // e.g. a replayed run or a re-processed paused project re-sends the same trace). An
    // all-duplicates response with zero INVALID spans means the spans are safely in Phoenix,
    // so the trace IS delivered — treat it as success, not a failure. Grounded live 2026-07-07
    // against Phoenix 14.13.0 (`{"error":"...duplicate spans","total_duplicates":N,"total_invalid":0}`).
    let report = null;
    try { report = JSON.parse(await restResponse.text()); } catch { /* non-JSON error body */ }
    const received = Number(report?.total_received || 0);
    const invalid = Number(report?.total_invalid || 0);
    const accountedFor = Number(report?.total_queued || 0) + Number(report?.total_duplicates || 0);
    const alreadyDelivered = received > 0 && invalid === 0 && accountedFor >= received;
    if (!alreadyDelivered) {
      throw new Error(`phoenix_rest_spans_http_${restResponse.status}`);
    }
  }
  const exportedSpanNames = markExported();
  return {
    ok: true,
    exportedSpanCount: spans.length,
    appUrl,
    traceId,
    transport: "phoenix_rest_spans",
    exportedSpanNames,
  };
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs, ...init }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`trace_fetch_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, reason) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runRecordFromWake({ wake, sourceEvent, runId, workspaceId, teamContext = null, repoRoot = process.cwd() }) {
  const teamTrace = teamContext?.trace || {};
  return {
    run_id: runId,
    team_ref: teamTrace.team_ref || wake?.team_ref || null,
    workspace_id: teamTrace.workspace_id || wake?.workspace_id || workspaceId || null,
    team_id: teamTrace.team_id || wake?.team_id || null,
    behavior_repo_id: teamTrace.behavior_repo_id || behaviorRepoIdForRepoRoot(repoRoot),
    workflow_type: wake?.workflow_type || "decomposition",
    wake_id: wake?.id || null,
    object_id: wake?.object_id || null,
    source_event_id: sourceEvent?.id || wake?.source_event_id || null,
    current_attempt: wake?.attempt_count || null,
    status: "running",
    started_at: new Date().toISOString(),
  };
}

function runRecordFromAgent({
  runId,
  teamRef,
  workflowType,
  agentRole,
  resource,
  githubBehaviorRepoId = null,
  githubBehaviorRepoLabel = null,
  repoRoot = process.cwd(),
}) {
  const normalizedResource = normalizeRunResource(resource);
  const githubIdentity = githubIdentityForResource({
    resource: normalizedResource,
    githubBehaviorRepoId,
    githubBehaviorRepoLabel,
  });
  return {
    run_id: runId,
    team_ref: teamRef || null,
    workspace_id: null,
    team_id: null,
    behavior_repo_id: behaviorRepoIdForRepoRoot(repoRoot),
    github_behavior_repo_id: githubIdentity.id,
    github_behavior_repo_label: githubIdentity.label,
    workflow_type: workflowType || null,
    agent_role: agentRole || null,
    resource: normalizedResource,
    wake_id: null,
    object_id: null,
    source_event_id: null,
    current_attempt: null,
    status: "running",
    started_at: new Date().toISOString(),
  };
}

function providerUpdateIdsForResult(result) {
  const projectedIds = providerUpdateIdsFromProducedIdentities(result?.produced_identities);
  if (projectedIds.length > 0) return projectedIds;
  return uniqueStrings([
    result?.projectUpdate?.id,
    ...(result?.created || []).map(providerObjectId),
    ...(result?.reused || []).map(providerObjectId),
  ]);
}

function providerUpdateIdsFromProducedIdentities(producedIdentities) {
  if (!Array.isArray(producedIdentities)) return [];
  const ids = [];
  for (const entry of producedIdentities) {
    if (entry?.provider !== "linear" || entry?.resource_kind !== "linear_issue") continue;
    ids.push(entry.identity?.project_update_id);
    ids.push(...(Array.isArray(entry.target_ids) ? entry.target_ids : []));
  }
  return uniqueStrings(ids);
}

function providerObjectId(value) {
  if (typeof value === "string") return value;
  return value?.id || null;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "")).filter(Boolean))];
}

function producedIdentitiesTraceCarrier(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeRunResource(resource) {
  const kind = firstPresent(resource?.kind);
  const id = firstPresent(resource?.id);
  const label = firstPresent(resource?.label);
  if (!kind && !id && !label) return null;
  return {
    kind: kind || null,
    id: id || null,
    label: label || null,
  };
}

function githubIdentityForResource({
  resource,
  githubBehaviorRepoId = null,
  githubBehaviorRepoLabel = null,
} = {}) {
  const isGithubBehaviorRepo = String(resource?.kind || "").toLowerCase() === "github_behavior_repo";
  return {
    id: firstPresent(githubBehaviorRepoId, isGithubBehaviorRepo ? resource?.id : null),
    label: firstPresent(githubBehaviorRepoLabel, isGithubBehaviorRepo ? resource?.label : null),
  };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function assertOtlpTraceId(value) {
  if (!/^[0-9a-f]{32}$/i.test(String(value || "")) || /^0{32}$/.test(String(value || ""))) {
    throw new Error("trace_id_must_be_32_hex");
  }
}

function otlpAttributes(input) {
  const attributes = [];
  for (const [key, value] of Object.entries(input || {})) {
    if (value === null || value === undefined) continue;
    attributes.push({ key, value: otlpAnyValue(value) });
  }
  return attributes;
}

function otlpAnyValue(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpAnyValue) } };
  return { stringValue: JSON.stringify(value) };
}

function attributesToObject(attributes = []) {
  return Object.fromEntries((attributes || []).map((attribute) => [
    attribute.key,
    otlpValueToJs(attribute.value),
  ]));
}

function attributeValue(attributes = [], key) {
  const attribute = (attributes || []).find((candidate) => candidate.key === key);
  return attribute ? otlpValueToJs(attribute.value) : null;
}

function otlpValueToJs(value = {}) {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(otlpValueToJs);
  return null;
}

function timeUnixNano(value) {
  const ms = Date.parse(value);
  const resolved = Number.isFinite(ms) ? ms : Date.now();
  return String(BigInt(resolved) * 1000000n);
}

function isoFromUnixNano(value) {
  const ms = Number(BigInt(value || "0") / 1000000n);
  return new Date(ms || Date.now()).toISOString();
}

function statusCodeForRun(status) {
  if (!status) return 0;
  return ["rejected", "dead_letter", "failed", "failed_closed"].includes(String(status)) ? 2 : 1;
}

function restStatusCode(code) {
  if (code === 1) return "OK";
  if (code === 2) return "ERROR";
  return "UNSET";
}

function validSpanId(value) {
  return /^[0-9a-f]{16}$/i.test(String(value || "")) && !/^0{16}$/.test(String(value || ""));
}

function stableSpanId(input) {
  const hex = createHash("sha256").update(String(input)).digest("hex").slice(0, 16);
  return /^0{16}$/.test(hex) ? "0000000000000001" : hex;
}

function safeName(value) {
  const name = String(value || "").trim();
  return name || "teami.span";
}
