import { createHash } from "node:crypto";

import { ensurePhoenixReady, phoenixStatus } from "./local-phoenix-manager.mjs";
import {
  appendAuditOnlyTraceOutbox,
  recordTraceStatus,
} from "./trace-status-store.mjs";
import {
  boundedRunReceiptProjection,
  enforceTraceContentPolicy,
  newTraceId,
} from "../../../engine/trace-contract.mjs";
import { behaviorRepoIdForRepoRoot } from "./domain-resolver.mjs";

const SERVICE_NAME = "agentic-factory-local-runner";
const PROJECT_ATTRIBUTE = "openinference.project.name";
const VERIFY_ATTEMPTS = 20;
const VERIFY_DELAY_MS = 500;
const TRACE_FETCH_TIMEOUT_MS = 5_000;
const RUNNER_READY_TIMEOUT_MS = 10_000;

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
      domainContext = null,
    } = {}) {
      const traceId = idFactory();
      const run = runRecordFromWake({ wake, sourceEvent, runId, workspaceId, domainContext, repoRoot });
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
          domainId: run.domain_id,
          workspaceId: run.workspace_id,
          teamId: run.team_id,
          wakeId: wake?.id || null,
          projectId: wake?.object_id || null,
          attempt: wake?.attempt_count || null,
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
            domain_id: run.domain_id,
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
      const requiredSpanNames = trace.spans?.map((span) => span.name).filter(Boolean) || [];
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
        domainId: run.domain_id,
        workspaceId: run.workspace_id,
        teamId: run.team_id,
        wakeId: run.wake_id,
        projectId: run.object_id,
        attempt: run.current_attempt,
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
      const policy = enforceTraceContentPolicy(trace);
      if (!policy.ok) throw new Error(policy.reason);
      const exportPayload = buildPhoenixOtlpTraceExport({
        projectName,
        run,
        trace,
        traceId,
        observedAt,
        includeRoot: stage === "final" || !rootSent,
        sentSpanIds,
        stage,
      });
      const spans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
      if (spans.length === 0) return { ok: true, skipped: true };
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
          markExported: () => {
            rootSent ||= spans.some((span) => span.name === "agentic_factory.workflow_run");
            for (const span of spans) sentSpanIds.add(span.spanId);
          },
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
          markExported: () => {
            rootSent ||= spans.some((span) => span.name === "agentic_factory.workflow_run");
            for (const span of spans) sentSpanIds.add(span.spanId);
          },
          traceId,
        });
      }
      if (!response.ok) throw new Error(`phoenix_otlp_http_${response.status}`);
      rootSent ||= spans.some((span) => span.name === "agentic_factory.workflow_run");
      for (const span of spans) sentSpanIds.add(span.spanId);
      return { ok: true, exportedSpanCount: spans.length, appUrl, traceId };
    },
    async shutdown() {
      shutdownCalled = true;
      return { ok: true };
    },
  };
}

export async function runLocalPhoenixTracePreflight({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  idFactory = newTraceId,
  onProgress = () => {},
  domainContext = null,
} = {}) {
  if (
    !domainContext?.trace?.domain_id ||
    !domainContext?.trace?.workspace_id ||
    !domainContext?.trace?.team_id
  ) {
    throw new Error("Local Phoenix preflight requires a resolved DomainContext. Run npm run init or pass --domain after setup.");
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
    workspaceId: domainContext.trace.workspace_id,
    sourceEvent: { id: "local-phoenix-preflight" },
    domainContext,
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
          "agentic_factory.preflight": true,
        },
      }],
      spans: [{
        name: "phoenix_preflight",
        kind: "TOOL",
        status: "completed",
        startedAt: observedAt,
        endedAt: now().toISOString(),
        attributes: {
          "agentic_factory.preflight": true,
          "agentic_factory.trace_id": session.traceId,
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
        name: "agentic_factory.workflow_run",
        kind: 1,
        startTimeUnixNano: timeUnixNano(startedAt),
        endTimeUnixNano: timeUnixNano(endedAt),
        attributes: otlpAttributes({
          "openinference.span.kind": "CHAIN",
          "agentic_factory.run_id": run?.run_id || trace?.attributes?.run_id,
          "agentic_factory.domain_id":
            run?.domain_id ||
            trace?.attributes?.["agentic_factory.domain_id"] ||
            trace?.attributes?.domain_id,
          "agentic_factory.behavior_repo_id":
            run?.behavior_repo_id ||
            trace?.attributes?.["agentic_factory.behavior_repo_id"] ||
            trace?.attributes?.behavior_repo_id,
          "agentic_factory.wake_id": run?.wake_id || trace?.attributes?.wake_id,
          "agentic_factory.workflow_type": run?.workflow_type || trace?.attributes?.["workflow.name"],
          "agentic_factory.object_id": run?.object_id || trace?.attributes?.linear_project_id,
          "agentic_factory.trace_id": traceId,
          "agentic_factory.flush_stage": stage,
          "agentic_factory.unpinned_runtime": trace?.attributes?.["agentic_factory.unpinned_runtime"],
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
      name: safeName(span?.name || `agentic_factory.span.${index + 1}`),
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
          name: "agentic-factory.local-phoenix",
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
    !Object.hasOwn(attributes, "agentic_factory.outcome")
  ) {
    mirrored["agentic_factory.outcome"] = attributes.outcome;
  }
  if (
    Object.hasOwn(attributes, "perspectives_run") &&
    !Object.hasOwn(attributes, "agentic_factory.perspectives_run")
  ) {
    mirrored["agentic_factory.perspectives_run"] = attributes.perspectives_run;
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
    domainId: session.run?.domain_id,
    workspaceId: session.run?.workspace_id,
    teamId: session.run?.team_id,
    wakeId: session.run?.wake_id || wake?.id || null,
    projectId: session.run?.object_id || wake?.object_id || null,
    attempt: session.run?.current_attempt || wake?.attempt_count || null,
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
      domain_id: session.run?.domain_id,
      wake_id: session.run?.wake_id || wake?.id || null,
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
      description: "Agentic Factory local traces",
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
  if (!restResponse.ok) throw new Error(`phoenix_rest_spans_http_${restResponse.status}`);
  markExported();
  return { ok: true, exportedSpanCount: spans.length, appUrl, traceId, transport: "phoenix_rest_spans" };
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

function runRecordFromWake({ wake, sourceEvent, runId, workspaceId, domainContext = null, repoRoot = process.cwd() }) {
  const domainTrace = domainContext?.trace || {};
  return {
    run_id: runId,
    domain_id: domainTrace.domain_id || wake?.domain_id || null,
    workspace_id: domainTrace.workspace_id || wake?.workspace_id || workspaceId || null,
    team_id: domainTrace.team_id || wake?.team_id || null,
    behavior_repo_id: domainTrace.behavior_repo_id || behaviorRepoIdForRepoRoot(repoRoot),
    workflow_type: wake?.workflow_type || "decomposition",
    wake_id: wake?.id || null,
    object_id: wake?.object_id || null,
    source_event_id: sourceEvent?.id || wake?.source_event_id || null,
    current_attempt: wake?.attempt_count || null,
    status: "running",
    started_at: new Date().toISOString(),
  };
}

function providerUpdateIdsForResult(result) {
  return [result?.projectUpdate?.id, ...(result?.created || []).map((issue) => issue.id)].filter(Boolean);
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
  return name || "agentic_factory.span";
}
