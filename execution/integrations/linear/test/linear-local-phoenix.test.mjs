import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  ensurePhoenixReady,
  normalizeLocalPhoenixAppUrl,
  phoenixCollectorUrl,
  phoenixPaths,
  probePhoenixIdentity,
  readServiceMetadata,
  recoverStaleServiceMetadata,
  stopPhoenix,
  writeServiceMetadata,
} from "../src/local-phoenix-manager.mjs";
import {
  buildPhoenixOtlpTraceExport,
  buildPhoenixRestSpanUpload,
  createLocalPhoenixTraceSink,
  createLocalPhoenixTraceExporter,
  runLocalPhoenixTracePreflight,
  verifyTraceDelivery,
} from "../src/local-phoenix-trace-sink.mjs";
import {
  appendAuditOnlyTraceOutbox,
  isInvalidTraceReceiptResult,
  readTraceHealth,
  readTraceReceipt,
  recordTraceStatus,
  traceTelemetryPaths,
  validateTraceReceipt,
} from "../src/trace-status-store.mjs";
import {
  BASE_RUNNER_CAPABILITIES,
  CANONICAL_DOMAIN_TRACE_ATTRIBUTES,
  boundedRunReceiptProjection,
  enforceTraceContentPolicy,
  findSecretContentKeys,
  newTraceId,
} from "../../../engine/trace-contract.mjs";
import {
  buildDatasetUploadPayloadFromTraceReceipt,
  buildTraceAnnotationPayload,
  createPhoenixTraceAnnotation,
  promoteTraceReceiptToPhoenixDataset,
} from "../src/phoenix-self-improvement.mjs";
import { runDecompositionEvalMode } from "../src/trigger-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

test("Phoenix endpoint normalization is loopback-only and derives the OTLP collector", () => {
  assert.equal(normalizeLocalPhoenixAppUrl("http://127.0.0.1:6006/"), "http://127.0.0.1:6006");
  assert.equal(phoenixCollectorUrl("http://127.0.0.1:6006"), "http://127.0.0.1:6006/v1/traces");
  assert.throws(() => normalizeLocalPhoenixAppUrl("http://0.0.0.0:6006"), /loopback/);
  assert.throws(() => normalizeLocalPhoenixAppUrl("http://192.168.1.5:6006"), /loopback/);
});

test("managed Phoenix reuses an existing Phoenix service without taking ownership", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-reuse-"));
  let installed = false;
  let spawned = false;
  const result = await ensurePhoenixReady({
    repoRoot,
    fetchImpl: async (url) => {
      assert.match(String(url), /healthz/);
      return new Response("ok", { status: 200 });
    },
    runCommand: async () => {
      installed = true;
    },
    spawnImpl: () => {
      spawned = true;
      return { pid: 123, unref() {} };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.managed, false);
  assert.equal(result.started, false);
  assert.equal(installed, false);
  assert.equal(spawned, false);
  assert.equal(readServiceMetadata(phoenixPaths(repoRoot).serviceFile).managed, false);
});

test("managed Phoenix preserves ownership metadata when its recorded process is still alive", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-managed-preserve-"));
  const paths = phoenixPaths(repoRoot);
  writeServiceMetadata(paths.serviceFile, {
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "agentic-factory",
    port: 6006,
    managed: true,
    pid: process.pid,
    status: "running",
  });

  const result = await ensurePhoenixReady({
    repoRoot,
    fetchImpl: async () => new Response("ok", { status: 200 }),
    runCommand: async () => {
      throw new Error("should not reinstall existing managed Phoenix");
    },
    spawnImpl: () => {
      throw new Error("should not respawn existing managed Phoenix");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.managed, true);
  assert.equal(result.reused, false);
  assert.equal(result.started, false);
  assert.equal(readServiceMetadata(paths.serviceFile).pid, process.pid);
});

test("managed Phoenix cold start is the only readiness path marked as started by this call", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-cold-start-"));
  let probes = 0;
  let installCommands = 0;
  let starts = 0;

  const result = await ensurePhoenixReady({
    repoRoot,
    probeIdentity: async () => {
      probes += 1;
      return probes === 1
        ? { ok: false, reason: "unreachable" }
        : { ok: true, appUrl: "http://127.0.0.1:6006" };
    },
    runCommand: async () => {
      installCommands += 1;
    },
    startProcess: () => {
      starts += 1;
      return { pid: process.pid, unref() {} };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.managed, true);
  assert.equal(result.reused, false);
  assert.equal(result.started, true);
  assert.equal(starts, 1);
  assert.ok(installCommands > 0);
});

test("Phoenix identity probe distinguishes a non-Phoenix port collision", async () => {
  let calls = 0;
  const result = await probePhoenixIdentity({
    appUrl: "http://127.0.0.1:6006",
    fetchImpl: async (url) => {
      calls += 1;
      return String(url).endsWith("/healthz")
        ? new Response("not found", { status: 404 })
        : new Response("plain local service", { status: 200 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "port_collision");
});

test("stale managed Phoenix pid metadata is recovered before restart", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-stale-"));
  const paths = phoenixPaths(repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.serviceFile, JSON.stringify({
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "agentic-factory",
    managed: true,
    pid: 99999999,
    status: "running",
  }));

  assert.equal(recoverStaleServiceMetadata({ ...paths, appUrl: "http://127.0.0.1:6006" }), true);
  const metadata = readServiceMetadata(paths.serviceFile);
  assert.equal(metadata.status, "stale_pid_recovered");
  assert.equal(metadata.pid, null);
});

test("safe stop refuses to stop reused external Phoenix", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-stop-"));
  const paths = phoenixPaths(repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.serviceFile, JSON.stringify({
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "agentic-factory",
    managed: false,
    pid: 99999999,
    status: "running",
  }));

  const result = await stopPhoenix({
    repoRoot,
    killProcess: () => {
      throw new Error("must not stop external Phoenix");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "external_phoenix_not_stopped");
});

test("managed Phoenix stop waits until the loopback service is gone", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-stop-wait-"));
  const paths = phoenixPaths(repoRoot);
  writeServiceMetadata(paths.serviceFile, {
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "agentic-factory",
    managed: true,
    pid: process.pid,
    status: "running",
  });
  let killed = false;
  let probes = 0;

  const result = await stopPhoenix({
    repoRoot,
    killProcess: () => {
      killed = true;
    },
    fetchImpl: async () => {
      probes += 1;
      if (probes === 1) return new Response("ok", { status: 200 });
      throw new Error("fetch failed");
    },
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.equal(readServiceMetadata(paths.serviceFile).status, "stopped");
});

test("trace status writes per-run receipts, health counters, and audit-only dead letters", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-trace-health-"));
  recordTraceStatus({
    repoRoot,
    runId: "run-1",
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    wakeId: "wake-1",
    projectId: "project-1",
    traceId: "11111111111111111111111111111111",
    status: "trace_unavailable",
    reason: "phoenix_down",
    repairHint: "start Phoenix",
  });
  const receipt = readTraceReceipt({ repoRoot, runId: "run-1" });
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.domain_id, "support-ops");
  assert.equal(receipt.workspace_id, "workspace-1");
  assert.equal(receipt.team_id, "team-1");
  assert.equal(receipt.trace_status, "trace_unavailable");
  assert.equal(readTraceHealth({ repoRoot }).consecutive_failure_count, 1);

  appendAuditOnlyTraceOutbox({
    repoRoot,
    record: { run_id: "run-1", trace_id: "11111111111111111111111111111111", reason: "phoenix_down" },
  });
  const outbox = fs.readFileSync(traceTelemetryPaths(repoRoot).outboxFile, "utf8");
  assert.match(outbox, /audit_only/);
  assert.doesNotMatch(outbox, /queued|replayable/);
  assert.equal(readTraceHealth({ repoRoot }).outbox_record_count, 1);

  recordTraceStatus({
    repoRoot,
    runId: "run-secret",
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    traceId: "22222222222222222222222222222222",
    status: "trace_delivery_failed",
    reason: ["Bearer ", "abcdefghijklmnop"].join(""),
  });
  assert.equal(readTraceReceipt({ repoRoot, runId: "run-secret" }).reason, "[redacted token material]");
  appendAuditOnlyTraceOutbox({
    repoRoot,
    record: { run_id: "run-secret", reason: ["sk", "-", "abcdefghijklmnop"].join("") },
  });
  assert.match(fs.readFileSync(traceTelemetryPaths(repoRoot).outboxFile, "utf8"), /redacted token material/);
});

test("local trace contract keeps base capabilities and excludes secret material", () => {
  assert.deepEqual(BASE_RUNNER_CAPABILITIES, ["linear.project.planned", "decomposition.trigger_runner.v1"]);
  assert.match(newTraceId(() => new Uint8Array(16).fill(1)), /^[0-9a-f]{32}$/);
  assert.deepEqual(findSecretContentKeys({ nested: { api_key: "secret" } }), ["nested.api_key"]);
  assert.deepEqual(findSecretContentKeys({ message: ["Bearer ", "abcdefghijklmnop"].join("") }), ["message"]);
  assert.equal(enforceTraceContentPolicy({ spans: [{ attributes: { token: "secret" } }] }).ok, false);
});

test("local trace receipt includes domain_id, workspace_id, and team_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-trace-domain-receipt-"));
  recordTraceStatus({
    repoRoot,
    runId: "run-domain",
    domainId: "domain-a",
    workspaceId: "workspace-a",
    teamId: "team-a",
    traceId: "33333333333333333333333333333333",
    status: "trace_exported",
  });
  const receipt = readTraceReceipt({ repoRoot, runId: "run-domain" });
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.domain_id, "domain-a");
  assert.equal(receipt.workspace_id, "workspace-a");
  assert.equal(receipt.team_id, "team-a");
  assert.throws(
    () => validateTraceReceipt({ ...receipt, workspace_id: undefined }),
    /missing_workspace_id/,
  );
  assert.throws(
    () => validateTraceReceipt({ ...receipt, team_id: undefined }),
    /missing_team_id/,
  );
  assert.throws(
    () =>
      boundedRunReceiptProjection({
        run: { run_id: "run-missing-workspace", domain_id: "domain-a", team_id: "team-a" },
        traceStatus: "trace_exported",
      }),
    /workspace_id is required/,
  );
  assert.throws(
    () =>
      boundedRunReceiptProjection({
        run: { run_id: "run-missing-team", domain_id: "domain-a", workspace_id: "workspace-a" },
        traceStatus: "trace_exported",
      }),
    /team_id is required/,
  );
});

test("v1-shaped trace receipts return a typed legacy result instead of throwing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-trace-legacy-receipt-"));
  const paths = traceTelemetryPaths(repoRoot);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.runsDir, "run-legacy.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: "run-legacy",
      trace_id: "44444444444444444444444444444444",
      trace_status: "trace_exported",
    }, null, 2)}\n`,
  );

  const receipt = readTraceReceipt({ repoRoot, runId: "run-legacy" });
  assert.equal(isInvalidTraceReceiptResult(receipt), true);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, "trace_receipt_schema_legacy");
  assert.match(receipt.detail, /missing_domain_id/);
});

test("canonical trace contract does not require agentic_factory.domain_name", () => {
  assert.equal(CANONICAL_DOMAIN_TRACE_ATTRIBUTES.includes("agentic_factory.domain_id"), true);
  assert.equal(CANONICAL_DOMAIN_TRACE_ATTRIBUTES.includes("agentic_factory.domain_name"), false);
});

test("OTLP export uses existing trace spans and exporter shuts down only when asked", async () => {
  const calls = [];
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "agentic-factory",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    },
  });
  const trace = {
    attributes: { run_id: "run-1" },
    annotations: [],
    spans: [{ name: "load_project_context", attributes: { ok: true }, startedAt: "2026-06-09T00:00:00.000Z", endedAt: "2026-06-09T00:00:00.001Z" }],
  };

  await exporter.forceFlush({ trace, run: { run_id: "run-1", status: "running" } });
  trace.spans.push({ name: "post_project_update", attributes: { ok: true }, startedAt: "2026-06-09T00:00:01.000Z", endedAt: "2026-06-09T00:00:01.001Z" });
  await exporter.forceFlush({ trace, run: { run_id: "run-1", status: "completed" }, stage: "final" });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].body.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name),
    ["agentic_factory.workflow_run", "load_project_context"],
  );
  assert.deepEqual(
    calls[1].body.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name),
    ["agentic_factory.workflow_run", "post_project_update"],
  );
  assert.equal(calls[1].body.resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
  assert.equal(exporter.shutdownCalled, false);
  await exporter.shutdown();
  assert.equal(exporter.shutdownCalled, true);
  await assert.rejects(() => exporter.forceFlush({ trace }), /shut down/);
});

test("runtime tool-event evidence is redacted and exported with outcome and perspectives", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_evid_tool_events";
  const result = await runDecompositionEvalMode({
    linearClient: new PhoenixLinearClient(),
    config,
    cache: { domainId: "domain-a", workspaceId: "workspace-1", teamId: "team-1" },
    projectId: "project-1",
    runId,
    repoRoot,
    runStoreDir: fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-evid-runs-")),
    runtimeExecutor: phoenixToolEventRuntimeExecutor(runId),
    orchestratorTurnExecutor: phoenixToolEventOrchestrator(runId),
    roster: phoenixToolEventRoster(),
    domainContext: testDomainContext(),
  });

  const evidenceSpan = result.trace.spans.find((span) => span.name === "runtime_tool_events");
  assert.ok(evidenceSpan, "expected runtime_tool_events span");
  assert.equal(evidenceSpan.attributes.outcome, "product_context_sufficient");
  assert.ok(Array.isArray(evidenceSpan.attributes.perspectives_run));
  assert.ok(Array.isArray(evidenceSpan.attributes.tool_events));
  assert.equal(findSecretContentKeys(evidenceSpan).length, 0);
  assert.doesNotMatch(JSON.stringify(evidenceSpan), /Bearer|ghp_|secret-key-value/);

  const payload = buildPhoenixOtlpTraceExport({
    projectName: "agentic-factory",
    run: { run_id: runId, status: "evaluated" },
    trace: result.trace,
    traceId: "11111111111111111111111111111111",
    observedAt: "2026-06-09T00:00:01.000Z",
  });
  const exportedEvidenceSpan = payload.resourceSpans[0].scopeSpans[0].spans
    .find((span) => span.name === "runtime_tool_events");
  assert.equal(otlpAttributeValue(exportedEvidenceSpan.attributes, "outcome"), "product_context_sufficient");
  assert.equal(
    otlpAttributeValue(exportedEvidenceSpan.attributes, "agentic_factory.outcome"),
    "product_context_sufficient",
  );
  assert.ok(Array.isArray(otlpAttributeValue(exportedEvidenceSpan.attributes, "perspectives_run")));
  assert.ok(Array.isArray(otlpAttributeValue(exportedEvidenceSpan.attributes, "agentic_factory.perspectives_run")));
  assert.equal(findSecretContentKeys(payload).length, 0);
  assert.doesNotMatch(JSON.stringify(payload), /Bearer|ghp_|secret-key-value/);
});

test("Phoenix REST span payload preserves trace ids, parent ids, and attributes", () => {
  const payload = buildPhoenixRestSpanUpload({
    projectName: "agentic-factory",
    run: { run_id: "run-1", status: "completed" },
    trace: {
      attributes: { run_id: "run-1" },
      annotations: [],
      spans: [{
        name: "load_project_context",
        kind: "TOOL",
        attributes: { ok: true },
        startedAt: "2026-06-09T00:00:00.000Z",
        endedAt: "2026-06-09T00:00:00.001Z",
      }],
    },
    traceId: "11111111111111111111111111111111",
    observedAt: "2026-06-09T00:00:01.000Z",
  });

  assert.equal(payload.data[0].context.trace_id, "11111111111111111111111111111111");
  assert.equal(payload.data[0].span_kind, "CHAIN");
  assert.equal(payload.data[1].parent_id, payload.data[0].context.span_id);
  assert.equal(payload.data[1].attributes.ok, true);
});

test("exporter falls back to Phoenix REST spans when OTLP JSON is unsupported", async () => {
  const calls = [];
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "agentic-factory",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/v1/traces")) return new Response("unsupported", { status: 415 });
      if (String(url).includes("/v1/projects?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (String(url).endsWith("/v1/projects")) return new Response(JSON.stringify({ data: { id: "project-1" } }), { status: 200 });
      if (String(url).includes("/v1/projects/agentic-factory/spans")) {
        return new Response(JSON.stringify({ total_received: 2, total_queued: 2 }), { status: 202 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const trace = {
    attributes: { run_id: "run-1" },
    annotations: [],
    spans: [{ name: "load_project_context", attributes: { ok: true } }],
  };
  const result = await exporter.forceFlush({
    trace,
    run: { run_id: "run-1", status: "completed" },
    stage: "final",
  });
  trace.spans.push({ name: "post_project_update", attributes: { ok: true } });
  await exporter.forceFlush({
    trace,
    run: { run_id: "run-1", status: "completed" },
    stage: "final",
  });

  assert.equal(result.transport, "phoenix_rest_spans");
  assert.equal(calls[0].url, "http://127.0.0.1:6006/v1/traces");
  assert.match(calls[1].url, /\/v1\/projects\?name=agentic-factory&limit=10$/);
  assert.equal(calls[2].url, "http://127.0.0.1:6006/v1/projects");
  assert.match(calls[3].url, /\/v1\/projects\/agentic-factory\/spans$/);
  assert.equal(calls[3].body.data[1].name, "load_project_context");
  assert.match(calls[4].url, /\/v1\/projects\/agentic-factory\/spans$/);
  assert.equal(calls[4].body.data.at(-1).name, "post_project_update");
});

test("trace fetch timeouts fail fast instead of hanging mutation", async () => {
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "agentic-factory",
    traceId: "11111111111111111111111111111111",
    fetchTimeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });

  await assert.rejects(
    () => exporter.forceFlush({
      trace: { attributes: {}, annotations: [], spans: [{ name: "load_project_context" }] },
      run: { run_id: "run-1" },
    }),
    /abort|timeout/i,
  );
});

test("content policy rejection through the local sink records one failed run", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-sink-policy-"));
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "agentic-factory",
      managed: true,
    }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    idFactory: () => "11111111111111111111111111111111",
  });
  const session = await sink.startRun({
    runId: "run-policy",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    domainContext: testDomainContext(),
  });
  const result = await sink.finishRun({
    session,
    result: {
      status: "completed",
      trace: {
        attributes: {},
        annotations: [],
        spans: [{ name: "load_project_context", attributes: { token: "secret" } }],
      },
    },
  });

  assert.equal(result.status, "trace_delivery_failed");
  const health = readTraceHealth({ repoRoot });
  assert.equal(health.consecutive_failure_count, 1);
  assert.equal(health.recent_failure_count, 1);
});

test("trace sink adopts a healthy collector after readiness startup failure instead of reporting phoenix_start_failed", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-sink-adopt-after-failure-"));
  let statusCalls = 0;
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => {
      throw new Error("spawn EPERM");
    },
    statusProbe: async () => {
      statusCalls += 1;
      return {
        ok: true,
        appUrl: "http://127.0.0.1:6006",
        collectorUrl: "http://127.0.0.1:6006/v1/traces",
        projectName: "agentic-factory",
      };
    },
    fetchImpl: async () => {
      throw new Error("no export in this test");
    },
    idFactory: () => "11111111111111111111111111111111",
  });

  const session = await sink.startRun({
    runId: "run-adopt-after-failure",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    domainContext: testDomainContext(),
  });

  assert.equal(session.ok, true);
  assert.equal(session.status, "trace_unknown");
  assert.equal(session.phoenixAppUrl, "http://127.0.0.1:6006");
  assert.equal(session.managed, false);
  assert.equal(session.started, false);
  assert.equal(session.reused, true);
  assert.equal(session.adoptedAfterReadinessFailure, true);
  assert.equal(statusCalls, 1);
});

test("multiple trace failures in one run count as one local health failure", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-sink-double-failure-"));
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "agentic-factory",
      managed: true,
    }),
    fetchImpl: async () => {
      throw new Error("hung collector");
    },
    idFactory: () => "11111111111111111111111111111111",
  });
  const session = await sink.startRun({
    runId: "run-double-failure",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    domainContext: testDomainContext(),
  });
  const trace = { attributes: {}, annotations: [], spans: [{ name: "load_project_context" }] };

  await sink.forceFlush({ session, trace, result: { status: "running" }, stage: "pre_mutation" });
  await sink.finishRun({ session, result: { status: "completed", trace } });

  const health = readTraceHealth({ repoRoot });
  assert.equal(health.consecutive_failure_count, 1);
  assert.equal(health.outbox_record_count, 1);
});

test("delivery proof queries Phoenix by trace id and required span names", async () => {
  const result = await verifyTraceDelivery({
    appUrl: "http://127.0.0.1:6006",
    projectName: "agentic-factory",
    traceId: "11111111111111111111111111111111",
    requiredSpanNames: ["load_project_context"],
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        trace_id: "11111111111111111111111111111111",
        spans: [{ name: "load_project_context" }],
      }],
    }), { status: 200 }),
    attempts: 1,
  });

  assert.equal(result.ok, true);
});

test("Phoenix preflight emits and proves a synthetic trace through local OTLP", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-preflight-"));
  let exportedTraceId = null;
  let exportedSpanNames = [];
  const result = await runLocalPhoenixTracePreflight({
    repoRoot,
    idFactory: () => "11111111111111111111111111111111",
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    domainContext: testDomainContext(),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "agentic-factory",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        const spans = body.resourceSpans[0].scopeSpans[0].spans;
        exportedTraceId = spans[0].traceId;
        exportedSpanNames = spans.map((span) => span.name);
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/agentic-factory\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: exportedTraceId,
          spans: exportedSpanNames.map((name) => ({ name })),
        }],
      }), { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "trace_exported");
  assert.equal(result.traceId, "11111111111111111111111111111111");
  assert.ok(exportedSpanNames.includes("phoenix_preflight"));
  const receipt = readTraceReceipt({ repoRoot, runId: result.runId });
  assert.equal(receipt.trace_status, "trace_exported");
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.domain_id, "domain-a");
  assert.equal(receipt.workspace_id, "workspace-1");
  assert.equal(receipt.team_id, "team-1");
});

test("OTLP payload carries Phoenix project and Agentic Factory attributes", () => {
  const payload = buildPhoenixOtlpTraceExport({
    projectName: "agentic-factory",
    run: {
      run_id: "run-1",
      domain_id: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
      wake_id: "wake-1",
      status: "completed",
    },
    trace: { attributes: {}, annotations: [], spans: [] },
    traceId: "11111111111111111111111111111111",
  });
  const attrs = payload.resourceSpans[0].resource.attributes;
  const rootAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.ok(attrs.some((attr) => attr.key === "openinference.project.name"));
  assert.ok(rootAttrs.some((attr) => attr.key === "agentic_factory.run_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "agentic_factory.domain_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "linear.workspace_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "linear.team_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "agentic_factory.behavior_repo_id"));
  assert.equal(rootAttrs.some((attr) => attr.key === "agentic_factory.domain_name"), false);
});

test("OTLP root span exports the unpinned runtime marker when present", () => {
  const payload = buildPhoenixOtlpTraceExport({
    projectName: "agentic-factory",
    run: {
      run_id: "run-unpinned",
      domain_id: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
      status: "completed",
    },
    trace: {
      attributes: {
        "agentic_factory.unpinned_runtime": { pm: { model: true } },
      },
      annotations: [],
      spans: [],
    },
    traceId: "11111111111111111111111111111111",
  });
  const rootAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.deepEqual(
    JSON.parse(otlpAttributeValue(rootAttrs, "agentic_factory.unpinned_runtime")),
    { pm: { model: true } },
  );
});

test("Phoenix trace annotation helper posts native annotations and blocks secrets", async () => {
  const payload = buildTraceAnnotationPayload({
    traceId: "11111111111111111111111111111111",
    label: "pass",
    score: 0.95,
    explanation: "good issue breakdown",
    identifier: "maintainer",
    metadata: { reviewer: "maintainer" },
  });
  assert.equal(payload.data[0].annotator_kind, "HUMAN");
  assert.equal(payload.data[0].name, "decomposition_quality");
  assert.equal(payload.data[0].result.label, "pass");
  assert.equal(payload.data[0].identifier, "maintainer");
  assert.throws(
    () => buildTraceAnnotationPayload({
      traceId: "11111111111111111111111111111111",
      label: "needs_revision",
      score: 0.5,
      explanation: "leaked",
      identifier: "maintainer",
      metadata: { token: "secret" },
    }),
    /token_material/,
  );

  let posted;
  const result = await createPhoenixTraceAnnotation({
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-annotation-")),
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: async (url, init = {}) => {
      assert.match(String(url), /\/v1\/trace_annotations\?sync=true$/);
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ id: "anno-1" }] }), { status: 200 });
    },
    traceId: "11111111111111111111111111111111",
    label: "pass",
    score: 0.9,
    explanation: "issues are executable",
    identifier: "maintainer",
  });

  assert.equal(posted.data[0].trace_id, "11111111111111111111111111111111");
  assert.equal(posted.data[0].identifier, "maintainer");
  assert.equal(posted.data[0].metadata.rubric_version, "1.0.0");
  assert.equal(posted.data[0].metadata.failure_taxonomy_version, "1.0.0");
  assert.equal(posted.data[0].metadata.workspace_maturity, "new");
  assert.deepEqual(result.annotationIds, ["anno-1"]);
});

test("Phoenix dataset promotion uses bounded local receipts and auto create or append", async () => {
  const receipt = {
    schema_version: 2,
    run_id: "run-1",
    domain_id: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    wake_id: "wake-1",
    project_id: "project-1",
    trace_id: "11111111111111111111111111111111",
    trace_status: "trace_exported",
    status: "completed",
    phoenix_app_url: "http://127.0.0.1:6006",
    observed_at: "2026-06-09T00:00:00.000Z",
  };
  const payload = buildDatasetUploadPayloadFromTraceReceipt({
    receipt,
    datasetName: "agentic-factory-test",
    action: "create",
  });
  assert.equal(payload.inputs[0].run_id, "run-1");
  assert.equal(payload.inputs[0].domain_id, "support-ops");
  assert.equal(payload.inputs[0].trace_id, "11111111111111111111111111111111");
  assert.equal(payload.outputs[0].status, "completed");
  assert.equal(payload.example_ids[0], "agentic_factory:run-1");
  assert.doesNotMatch(JSON.stringify(payload), /prompt|phase_packet|repo_snippet|shell_output/);
  assert.throws(
    () => buildDatasetUploadPayloadFromTraceReceipt({
      receipt: { ...receipt, reason: ["Bearer ", "abcdefghijklmnop"].join("") },
    }),
    /token_material/,
  );

  const calls = [];
  const result = await promoteTraceReceiptToPhoenixDataset({
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-phoenix-dataset-")),
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/v1/datasets?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      assert.match(String(url), /\/v1\/datasets\/upload\?sync=true$/);
      return new Response(JSON.stringify({
        data: { dataset_id: "dataset-1", version_id: "version-1", num_created_examples: 1 },
      }), { status: 200 });
    },
    receipt,
    datasetName: "agentic-factory-test",
  });

  assert.equal(result.action, "create");
  assert.equal(result.dataset.dataset_id, "dataset-1");
  assert.equal(calls[1].body.action, "create");
});

// The orchestrator invokes the pm library target (so its tool_events flow), then
// terminates with a commit. The pm subagent turn carries the runtime tool_events
// (with secret material) the redaction/export assertions exercise.
const PHOENIX_LIBRARY_BY_KEY = {
  "prompt/decomposition/pm_product_sufficiency_pass": "pm",
  "prompt/decomposition/sr_eng_grounding_pass": "sr_eng",
};

function phoenixToolEventRoster() {
  return {
    selectableTargets: Object.keys(PHOENIX_LIBRARY_BY_KEY),
    resolve(targetKey) {
      const role = PHOENIX_LIBRARY_BY_KEY[targetKey];
      if (!role) return { ok: false, reason: "orchestrator_roster_target_not_selectable" };
      return {
        ok: true,
        runtime_role: role,
        loadSnapshot: () => ({
          entry: { target_key: targetKey },
          contentBytes: `BODY for ${targetKey}`,
          snapshotSha256: `sha-${targetKey}`,
        }),
      };
    },
  };
}

// One invoke_library(pm) turn then terminate(commit). The orchestrator decision
// loop is deterministic; the real CLI is never spawned.
function phoenixToolEventOrchestrator(runId) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: phoenixCommitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };
}

function phoenixCommitProducedContent(runId) {
  return {
    context_digest: "Reviewed project intent and grounded constraints for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Decomposition completed.",
      "",
      "## What I did with each part of your project",
      "- The relevant project sections were accounted for in this decomposition result.",
    ].join("\n"),
    final_issues: [{
      decomposition_key: "project-plan",
      title: "Prepare execution setup",
      issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
      depends_on: [],
      assignment: "Plan the setup.",
      output: "A documented execution setup plan.",
      acceptance_criteria: ["Plan exists."],
    }],
  };
}

// The subagent executor for the orchestrator loop (executeSubagent — NOT the
// retired executePhase). The pm turn carries the runtime tool_events (with secret
// material) so the redaction + export assertions still hold; its packet reason is
// product_context_sufficient (the span outcome the test asserts).
function phoenixToolEventRuntimeExecutor(runId) {
  return {
    async executeSubagent({ runtime_role }) {
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      const evidence = {
        evidence_ref: `phoenix:${runId}:${runtime_role}`,
        ...(runtime_role === "pm"
          ? {
              tool_events: [{
                type: "tool_call",
                name: "repo_lookup",
                input: {
                  query: "read safe project context",
                  authorization: `${"Bearer"} abcdefghijklmnop`,
                  secret_key: `secret-${"key"}-value`,
                },
                output: {
                  status: "ok",
                  summary: "looked up local files",
                  note: `token ${"ghp_"}abcdefghijklmnop must not leave sanitization`,
                },
              }],
            }
          : {}),
      };
      return {
        packet: phoenixSubagentTurn(runId, { reason }),
        role: runtime_role,
        sessionHandle: null,
        evidence,
      };
    },
  };
}

function phoenixSubagentTurn(runId, { status = "continue", reason }) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status,
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

function otlpAttributeValue(attributes = [], key) {
  const attribute = attributes.find((candidate) => candidate.key === key);
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

class PhoenixLinearClient {
  constructor() {
    this.cache = { domainId: "domain-a", workspaceId: "workspace-1", teamId: "team-1" };
    this.project = {
      id: "project-1",
      name: "Phoenix evidence project",
      content: "Project body",
      status: { id: "status-planned", name: "Planned", type: "planned" },
      teamIds: ["team-1"],
      labels: [],
      issues: [],
    };
  }

  async listTeams() {
    return [{ id: "team-1", key: "DA", name: "Domain A" }];
  }

  async listProjectStatuses() {
    return [
      { id: "status-backlog", name: "Backlog", type: "backlog" },
      { id: "status-planned", name: "Planned", type: "planned" },
      { id: "status-started", name: "In Progress", type: "started" },
    ];
  }

  async listWorkflowStates() {
    return [{ id: "state-backlog", name: "Backlog", type: "unstarted" }];
  }

  async findProjectLabelsByName(name) {
    return name === "Has Open Questions" ? [{ id: "plabel-open", name }] : [];
  }

  async findIssueLabelsByName(name, teamId) {
    return name === "Discovery" && teamId === "team-1" ? [{ id: "ilabel-discovery", name, teamId }] : [];
  }

  async findTemplatesByName(name, type, teamId) {
    return name === "Agentic Factory Roadmap Item" && type === "project" && teamId === "team-1"
      ? [{ id: "template-1", name, type, teamId }]
      : [];
  }

  async getProjectContext() {
    return { ...this.project, issues: [] };
  }
}

function testDomainContext() {
  return Object.freeze({
    domainId: "domain-a",
    status: "active",
    linear: Object.freeze({
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "DA",
      teamName: "Domain A",
      webhookId: "webhook-1",
      cachePath: "unused",
    }),
    credentialTargets: Object.freeze({
      linearOAuth: "oauth-target",
      runnerInbox: "runner-target",
    }),
    trace: Object.freeze({
      domain_id: "domain-a",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test-behavior",
    }),
  });
}
