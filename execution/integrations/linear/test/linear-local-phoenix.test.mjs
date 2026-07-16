import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import zlib from "node:zlib";

import { teamiHomePaths } from "../src/app-home.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  ensurePhoenixReady,
  normalizeLocalPhoenixAppUrl,
  phoenixCollectorUrl,
  phoenixPaths,
  probePhoenixIdentity,
  readServiceMetadata,
  recoverStaleServiceMetadata,
  resolvePhoenixConfig,
  runtimeFetchDegradationNotice,
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
  CANONICAL_TEAM_TRACE_ATTRIBUTES,
  boundedRunReceiptProjection,
  enforceTraceContentPolicy,
  findSecretContentKeys,
  LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
  newTraceId,
} from "../../../engine/trace-contract.mjs";
import { PRODUCED_IDENTITIES_TRACE_ATTRIBUTE } from "../../../engine/produced-identities.mjs";
import {
  buildDatasetUploadPayloadFromTraceReceipt,
  buildTraceAnnotationPayload,
  createPhoenixTraceAnnotation,
  promoteTraceReceiptToPhoenixDataset,
} from "../src/phoenix-self-improvement.mjs";
import { runDecompositionEvalMode } from "../src/trigger-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

// Every test here creates its own temp `repoRoot` and drives phoenix state through it
// (phoenixPaths(repoRoot), ensurePhoenixReady({repoRoot})). That relies on the phoenix
// home shim mapping an explicit repoRoot -> repoRoot when TEAMI_HOME is unset. The suite
// preload sets ONE TEAMI_HOME per process, which would divert every test to a single shared
// home (cross-test pollution). Clear it before each test so each test is isolated via its own
// repoRoot; the one test that needs a distinct home sets TEAMI_HOME itself, after this hook.
beforeEach(() => {
  delete process.env.TEAMI_HOME;
});

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";
const LOCAL_TOOL_EVENT_DIFF = [
  "diff --git a/project.md b/project.md",
  "+keep the local evidence diff in Phoenix",
].join("\n");

test("Phoenix endpoint normalization is loopback-only and derives the OTLP collector", () => {
  assert.equal(normalizeLocalPhoenixAppUrl("http://127.0.0.1:6006/"), "http://127.0.0.1:6006");
  assert.equal(phoenixCollectorUrl("http://127.0.0.1:6006"), "http://127.0.0.1:6006/v1/traces");
  assert.throws(() => normalizeLocalPhoenixAppUrl("http://0.0.0.0:6006"), /loopback/);
  assert.throws(() => normalizeLocalPhoenixAppUrl("http://192.168.1.5:6006"), /loopback/);
});

test("Phoenix data and trace telemetry land under the Teami home", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-checkout-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-home-"));
  const homePaths = teamiHomePaths({ home });
  const oldAgentShell = path.join(repoRoot, ".agent-shell");
  const expectedPhoenixKeys = ["root", "venvDir", "dataDir", "logsDir", "serviceFile", "telemetryDir"];
  const expectedTelemetryKeys = ["telemetryDir", "healthFile", "runsDir", "outboxFile"];

  const paths = phoenixPaths(home);
  assert.deepEqual(Object.keys(paths), expectedPhoenixKeys);
  assert.equal(paths.root, homePaths.phoenixDataDir);
  assert.equal(paths.dataDir, homePaths.phoenixDataDir);
  assert.equal(paths.venvDir, path.join(homePaths.phoenixDataDir, "phoenix-venv"));
  assert.equal(paths.logsDir, path.join(homePaths.phoenixDataDir, "logs"));
  assert.equal(paths.serviceFile, path.join(homePaths.phoenixDataDir, "phoenix-service.json"));
  assert.equal(paths.telemetryDir, path.join(homePaths.phoenixDataDir, "telemetry"));

  const config = resolvePhoenixConfig({
    repoRoot,
    env: { ...process.env, TEAMI_HOME: home },
  });
  assert.deepEqual(Object.keys(pickPhoenixPathShape(config)), expectedPhoenixKeys);
  assert.equal(config.serviceFile, paths.serviceFile);
  assert.equal(config.telemetryDir, paths.telemetryDir);
  assert.equal(config.serviceFile.startsWith(oldAgentShell), false);

  const result = await ensurePhoenixReady({
    repoRoot,
    env: { ...process.env, TEAMI_HOME: home },
    fetchImpl: async () => new Response("ok", { status: 200 }),
    runCommand: async () => {
      throw new Error("home-anchored reuse should not install Phoenix");
    },
    spawnImpl: () => {
      throw new Error("home-anchored reuse should not spawn Phoenix");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(readServiceMetadata(paths.serviceFile).managed, false);
  assert.equal(fs.existsSync(path.join(oldAgentShell, "phoenix-service.json")), false);

  const previousTeamiHome = process.env.TEAMI_HOME;
  process.env.TEAMI_HOME = home;
  try {
    const telemetry = traceTelemetryPaths(repoRoot);
    assert.deepEqual(Object.keys(telemetry), expectedTelemetryKeys);
    assert.equal(telemetry.telemetryDir, paths.telemetryDir);
    assert.equal(telemetry.healthFile, path.join(paths.telemetryDir, "trace-health.json"));
    assert.equal(telemetry.runsDir, path.join(paths.telemetryDir, "runs"));
    assert.equal(telemetry.outboxFile, path.join(paths.telemetryDir, "phoenix-outbox.jsonl"));

    recordTraceStatus({
      repoRoot,
      runId: "run-home",
      teamRef: "support-ops",
      workspaceId: "workspace-1",
      teamId: "team-1",
      traceId: "55555555555555555555555555555555",
      status: "trace_unavailable",
      reason: "phoenix_down",
    });
    appendAuditOnlyTraceOutbox({
      repoRoot,
      record: { run_id: "run-home", trace_id: "55555555555555555555555555555555", reason: "phoenix_down" },
    });
  } finally {
    if (previousTeamiHome === undefined) {
      delete process.env.TEAMI_HOME;
    } else {
      process.env.TEAMI_HOME = previousTeamiHome;
    }
  }

  assert.equal(fs.existsSync(path.join(paths.telemetryDir, "runs", "run-home.json")), true);
  assert.match(fs.readFileSync(path.join(paths.telemetryDir, "phoenix-outbox.jsonl"), "utf8"), /audit_only/);
  assert.equal(fs.existsSync(path.join(oldAgentShell, "telemetry", "runs", "run-home.json")), false);
  assert.equal(fs.existsSync(path.join(oldAgentShell, "telemetry", "phoenix-outbox.jsonl")), false);
});

test("managed Phoenix reuses an existing Phoenix service without taking ownership", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-reuse-"));
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-managed-preserve-"));
  const paths = phoenixPaths(repoRoot);
  writeServiceMetadata(paths.serviceFile, {
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-cold-start-"));
  let probes = 0;
  let installCommands = 0;
  let starts = 0;

  const result = await ensurePhoenixReady({
    repoRoot,
    env: { ...process.env, TEAMI_PHOENIX_SKIP_INSTALL: "1" },
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
  assert.equal(installCommands, 0);
});

test("managed Phoenix fetches the carried runtime without system Python, venv, pip, or PATH mutation", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-fetch-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-home-"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-manifest-"));
  const platformKey = "fixture-x64";
  const archive = buildRuntimeFixtureArchive({
    "bin/python": "fixture python",
    "bin/phoenix": "fixture phoenix",
    "Scripts/python.exe": "fixture python exe",
    "Scripts/phoenix.exe": "fixture phoenix exe",
  });
  const { manifestPath, manifestEntry } = writeRuntimeFixtureManifest({ tempDir, archive, platformKey });
  const env = {
    ...process.env,
    TEAMI_HOME: home,
    PATH: "fixture-path",
    Path: "fixture-path-win",
  };
  const originalPath = process.env.PATH;
  const originalWindowsPath = process.env.Path;
  const expectedHomePaths = teamiHomePaths({ home });
  const events = [];
  const commands = [];
  const spawns = [];
  let probes = 0;

  const result = await ensurePhoenixReady({
    repoRoot,
    env,
    runtimeManifestPath: manifestPath,
    platformKey,
    fetchImpl: async (url) => {
      events.push("fetch");
      assert.equal(String(url), manifestEntry.asset_url);
      return new Response(archive, { status: 200 });
    },
    probeIdentity: async () => {
      events.push("probe");
      probes += 1;
      return probes === 1
        ? { ok: false, reason: "unreachable" }
        : { ok: true, appUrl: "http://127.0.0.1:6006" };
    },
    runCommand: async (command, args, options = {}) => {
      events.push("run");
      commands.push({ command, args, options });
    },
    spawnImpl: (command, args, options = {}) => {
      events.push("spawn");
      spawns.push({ command, args, options });
      return { pid: process.pid, unref() {} };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.root, expectedHomePaths.phoenixDataDir);
  assert.equal(result.dataDir, expectedHomePaths.phoenixDataDir);
  assert.equal(result.runtimeDir, expectedHomePaths.runtimeDir);
  assert.equal(result.serviceFile.startsWith(home), true);
  assert.equal(result.serviceFile.startsWith(repoRoot), false);
  assert.equal(fs.existsSync(path.join(expectedHomePaths.runtimeDir, "current")), true);
  assert.deepEqual(
    events.filter((event) => ["fetch", "run", "spawn"].includes(event)),
    ["fetch", "run", "spawn"],
  );

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command.startsWith(path.join(expectedHomePaths.runtimeDir, "current")), true);
  assert.equal(commands[0].command.includes("phoenix-venv"), false);
  assert.notEqual(commands[0].command, "python");
  assert.notEqual(commands[0].command, "python3");
  assert.deepEqual(commands[0].args, [
    "-c",
    "import importlib.metadata as m; import phoenix; assert m.version('arize-phoenix') == '14.13.0'",
  ]);
  assert.equal(commands[0].args.some((arg) => /venv|pip/i.test(arg)), false);
  assert.equal(commands[0].options.env.PATH, "fixture-path");
  assert.equal(commands[0].options.env.Path, "fixture-path-win");

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command.startsWith(path.join(expectedHomePaths.runtimeDir, "current")), true);
  assert.equal(spawns[0].command.includes("phoenix-venv"), false);
  assert.notEqual(spawns[0].command, "phoenix");
  assert.deepEqual(spawns[0].args, [
    "-m",
    "phoenix.server.main",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "6006",
  ]);
  assert.equal(spawns[0].args.some((arg) => /venv|pip/i.test(arg)), false);
  assert.equal(spawns[0].options.cwd, expectedHomePaths.phoenixDataDir);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.env.PHOENIX_WORKING_DIR, expectedHomePaths.phoenixDataDir);
  assert.equal(spawns[0].options.env.PATH, "fixture-path");
  assert.equal(spawns[0].options.env.Path, "fixture-path-win");
  assert.notEqual(spawns[0].options.shell, true);
  assert.equal(process.env.PATH, originalPath);
  assert.equal(process.env.Path, originalWindowsPath);
});

test("runtime fetch failure degrades Phoenix readiness without throwing", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-degrade-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-degrade-home-"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-degrade-manifest-"));
  const platformKey = "fixture-x64";
  const archive = buildRuntimeFixtureArchive({ "bin/python": "not downloaded" });
  const { manifestPath } = writeRuntimeFixtureManifest({ tempDir, archive, platformKey });
  const env = { ...process.env, TEAMI_HOME: home };
  let result;

  await assert.doesNotReject(async () => {
    result = await ensurePhoenixReady({
      repoRoot,
      env,
      runtimeManifestPath: manifestPath,
      platformKey,
      fetchImpl: async () => {
        throw new Error("offline fixture");
      },
      probeIdentity: async () => ({ ok: false, reason: "unreachable" }),
      runCommand: async () => {
        throw new Error("runtime fetch failure must not run Phoenix import checks");
      },
      spawnImpl: () => {
        throw new Error("runtime fetch failure must not spawn Phoenix");
      },
    });
  });

  const metadata = readServiceMetadata(phoenixPaths(home).serviceFile);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "runtime_fetch_failed");
  assert.equal(result.repairHint, metadata.repair_hint);
  assert.match(result.repairHint, /Retry the Teami runtime download/);
  assert.equal(metadata.status, "runtime_fetch_failed");
  assert.equal(metadata.managed, false);
  assert.equal(metadata.pid, null);
  assert.equal(metadata.last_error_reason, "runtime_fetch_failed");
  assert.match(runtimeFetchDegradationNotice(), /product work can continue without Phoenix traces/);
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-stale-"));
  const paths = phoenixPaths(repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.serviceFile, JSON.stringify({
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-stop-"));
  const paths = phoenixPaths(repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.serviceFile, JSON.stringify({
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-stop-wait-"));
  const paths = phoenixPaths(repoRoot);
  writeServiceMetadata(paths.serviceFile, {
    schema_version: 1,
    app_url: "http://127.0.0.1:6006",
    collector_url: "http://127.0.0.1:6006/v1/traces",
    project_name: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-trace-health-"));
  recordTraceStatus({
    repoRoot,
    runId: "run-1",
    teamRef: "support-ops",
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
  assert.equal(receipt.team_ref, "support-ops");
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
    teamRef: "support-ops",
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
  assert.deepEqual(
    findSecretContentKeys({
      message: ["Basic ", Buffer.from("x-access-token:fake-token-value", "utf8").toString("base64")].join(""),
    }),
    ["message"],
  );
  assert.equal(enforceTraceContentPolicy({ spans: [{ attributes: { token: "secret" } }] }).ok, false);
  assert.equal(
    enforceTraceContentPolicy({ spans: [{ attributes: { prompt: "full local prompt" } }] }).reason,
    "rich_trace_content_not_allowed",
  );
  assert.equal(
    enforceTraceContentPolicy(
      { spans: [{ attributes: { prompt: "full local prompt" } }] },
      LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
    ).ok,
    true,
  );
});

test("local trace receipt includes team_ref, workspace_id, and team_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-trace-team-receipt-"));
  recordTraceStatus({
    repoRoot,
    runId: "run-team",
    teamRef: "team-a",
    workspaceId: "workspace-a",
    teamId: "team-a",
    traceId: "33333333333333333333333333333333",
    status: "trace_exported",
  });
  const receipt = readTraceReceipt({ repoRoot, runId: "run-team" });
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.team_ref, "team-a");
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
        run: { run_id: "run-missing-workspace", team_ref: "team-a", team_id: "team-a" },
        traceStatus: "trace_exported",
      }),
    /workspace_id is required/,
  );
  assert.throws(
    () =>
      boundedRunReceiptProjection({
        run: { run_id: "run-missing-team", team_ref: "team-a", workspace_id: "workspace-a" },
        traceStatus: "trace_exported",
      }),
    /team_id is required/,
  );
});

test("v1-shaped trace receipts return a typed legacy result instead of throwing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-trace-legacy-receipt-"));
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
  assert.match(receipt.detail, /missing_team_ref/);
});

test("canonical trace contract does not require teami.team_name", () => {
  assert.equal(CANONICAL_TEAM_TRACE_ATTRIBUTES.includes("teami.team_ref"), true);
  assert.equal(CANONICAL_TEAM_TRACE_ATTRIBUTES.includes("teami.team_name"), false);
});

test("OTLP export uses existing trace spans and exporter shuts down only when asked", async () => {
  const calls = [];
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami",
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
    ["teami.workflow_run", "load_project_context"],
  );
  assert.deepEqual(
    calls[1].body.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name),
    ["teami.workflow_run", "post_project_update"],
  );
  assert.equal(calls[1].body.resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
  assert.equal(exporter.shutdownCalled, false);
  await exporter.shutdown();
  assert.equal(exporter.shutdownCalled, true);
  await assert.rejects(() => exporter.forceFlush({ trace }), /shut down/);
});

test("local Phoenix exporter accepts rich trace content but still blocks token material", async () => {
  const calls = [];
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    },
  });
  const prompt = [
    "Draft decomposition issues from the local project evidence.",
    "Include exact quoted constraints and rationale.",
  ].join("\n");
  const shellOutput = [
    "diff --git a/src/task.js b/src/task.js",
    "+export const localEvidence = true;",
  ].join("\n");
  const trace = {
    attributes: { run_id: "run-rich-local" },
    annotations: [],
    spans: [{
      name: "runtime_tool_events",
      attributes: {
        prompt,
        tool_events: [{
          name: "shell",
          output: { shell_output: shellOutput },
        }],
      },
      startedAt: "2026-06-09T00:00:00.000Z",
      endedAt: "2026-06-09T00:00:00.001Z",
    }],
  };

  const result = await exporter.forceFlush({
    trace,
    run: { run_id: "run-rich-local", status: "running" },
  });

  assert.equal(result.ok, true);
  const exportedSpan = calls[0].body.resourceSpans[0].scopeSpans[0].spans
    .find((span) => span.name === "runtime_tool_events");
  assert.equal(otlpAttributeValue(exportedSpan.attributes, "prompt"), prompt);
  assert.deepEqual(
    otlpAttributeValue(exportedSpan.attributes, "tool_events").map((entry) => JSON.parse(entry)),
    [{ name: "shell", output: { shell_output: shellOutput } }],
  );

  await assert.rejects(
    () => exporter.forceFlush({
      trace: {
        attributes: { run_id: "run-secret-local" },
        annotations: [],
        spans: [{
          name: "runtime_tool_events",
          attributes: {
            prompt: ["Bearer ", "abcdefghijklmnop"].join(""),
            tool_events: [{ output: { shell_output: shellOutput } }],
          },
        }],
      },
      run: { run_id: "run-secret-local", status: "running" },
    }),
    /trace_payload_contains_token_material/,
  );
});

test("runtime tool-event evidence is redacted and exported with outcome and perspectives", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_evid_tool_events";
  const result = await runDecompositionEvalMode({
    linearClient: new PhoenixLinearClient(),
    config,
    cache: {
      teamRef: "team-a",
      workspaceId: "workspace-1",
      teamId: "team-1",
      issueLabels: {
        Discovery: "ilabel-discovery",
        "Needs Principal": "ilabel-needs-principal",
        "human-review": "ilabel-human-review",
      },
      issueStatuses: {
        backlog: "state-backlog",
        todo: "state-todo",
        in_progress: "state-in-progress",
        in_review: "state-in-review",
        human_review: "state-human-review",
        needs_principal: "state-needs-principal",
        done: "state-done",
      },
    },
    projectId: "project-1",
    runId,
    repoRoot,
    runStoreDir: fs.mkdtempSync(path.join(os.tmpdir(), "teami-evid-runs-")),
    runtimeExecutor: phoenixToolEventRuntimeExecutor(runId),
    orchestratorTurnExecutor: phoenixToolEventOrchestrator(runId),
    roster: phoenixToolEventRoster(),
    teamContext: testTeamContext(),
  });

  const evidenceSpan = result.trace.spans.find((span) => span.name === "runtime_tool_events");
  assert.ok(evidenceSpan, "expected runtime_tool_events span");
  assert.equal(evidenceSpan.attributes.outcome, "product_context_sufficient");
  assert.ok(Array.isArray(evidenceSpan.attributes.perspectives_run));
  assert.ok(Array.isArray(evidenceSpan.attributes.tool_events));
  assert.equal(evidenceSpan.attributes.tool_events[0].output.shell_output, LOCAL_TOOL_EVENT_DIFF);
  assert.equal(findSecretContentKeys(evidenceSpan).length, 0);
  assert.doesNotMatch(JSON.stringify(evidenceSpan), /Bearer|ghp_|secret-key-value/);

  const payload = buildPhoenixOtlpTraceExport({
    projectName: "teami",
    run: { run_id: runId, status: "evaluated" },
    trace: result.trace,
    traceId: "11111111111111111111111111111111",
    observedAt: "2026-06-09T00:00:01.000Z",
  });
  const exportedEvidenceSpan = payload.resourceSpans[0].scopeSpans[0].spans
    .find((span) => span.name === "runtime_tool_events");
  assert.equal(otlpAttributeValue(exportedEvidenceSpan.attributes, "outcome"), "product_context_sufficient");
  assert.equal(
    otlpAttributeValue(exportedEvidenceSpan.attributes, "teami.outcome"),
    "product_context_sufficient",
  );
  assert.ok(Array.isArray(otlpAttributeValue(exportedEvidenceSpan.attributes, "perspectives_run")));
  assert.ok(Array.isArray(otlpAttributeValue(exportedEvidenceSpan.attributes, "teami.perspectives_run")));
  assert.equal(
    JSON.parse(otlpAttributeValue(exportedEvidenceSpan.attributes, "tool_events")[0]).output.shell_output,
    LOCAL_TOOL_EVENT_DIFF,
  );
  assert.equal(findSecretContentKeys(payload).length, 0);
  assert.doesNotMatch(JSON.stringify(payload), /Bearer|ghp_|secret-key-value/);
});

test("Phoenix REST span payload preserves trace ids, parent ids, and attributes", () => {
  const payload = buildPhoenixRestSpanUpload({
    projectName: "teami",
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
    projectName: "teami",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/v1/traces")) return new Response("unsupported", { status: 415 });
      if (String(url).includes("/v1/projects?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (String(url).endsWith("/v1/projects")) return new Response(JSON.stringify({ data: { id: "project-1" } }), { status: 200 });
      if (String(url).includes("/v1/projects/teami/spans")) {
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
  assert.match(calls[1].url, /\/v1\/projects\?name=teami&limit=10$/);
  assert.equal(calls[2].url, "http://127.0.0.1:6006/v1/projects");
  assert.match(calls[3].url, /\/v1\/projects\/teami\/spans$/);
  assert.equal(calls[3].body.data[1].name, "load_project_context");
  assert.match(calls[4].url, /\/v1\/projects\/teami\/spans$/);
  assert.equal(calls[4].body.data.at(-1).name, "post_project_update");
});

test("Phoenix REST spans treats an all-duplicate 400 as successful idempotent re-delivery", async () => {
  // When a run is replayed or a paused project is re-processed, the SAME trace is re-sent and
  // Phoenix 400s it — every span is a duplicate it already holds, none invalid. The spans are
  // safely in Phoenix, so the export is a successful no-op, not a delivery failure. (Grounded
  // live 2026-07-07 against Phoenix 14.13.0, which is why trace-health looked red on replays.)
  const calls = [];
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      if (String(url).endsWith("/v1/traces")) return new Response("unsupported", { status: 415 });
      if (String(url).includes("/v1/projects?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (String(url).endsWith("/v1/projects")) return new Response(JSON.stringify({ data: { id: "project-1" } }), { status: 200 });
      if (String(url).includes("/v1/projects/teami/spans")) {
        return new Response(
          JSON.stringify({
            error: "Failed to insert 1 spans: 1 duplicate spans",
            total_received: 1,
            total_duplicates: 1,
            total_invalid: 0,
          }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const result = await exporter.forceFlush({
    trace: { attributes: { run_id: "run-1" }, annotations: [], spans: [{ name: "load_project_context", attributes: { ok: true } }] },
    run: { run_id: "run-1", status: "completed" },
    stage: "final",
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport, "phoenix_rest_spans");
  assert.match(calls.at(-1).url, /\/v1\/projects\/teami\/spans$/);
});

test("Phoenix REST spans still fails when a 400 reports genuinely invalid spans", async () => {
  // A 400 is only benign when it is a CLEAN re-delivery. If Phoenix rejects any span as invalid
  // (schema/shape error), the trace did NOT fully land — that must still surface as a failure.
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami",
    traceId: "11111111111111111111111111111111",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/v1/traces")) return new Response("unsupported", { status: 415 });
      if (String(url).includes("/v1/projects?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (String(url).endsWith("/v1/projects")) return new Response(JSON.stringify({ data: { id: "project-1" } }), { status: 200 });
      if (String(url).includes("/v1/projects/teami/spans")) {
        return new Response(
          JSON.stringify({ error: "invalid spans", total_received: 2, total_duplicates: 1, total_invalid: 1 }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(
    () => exporter.forceFlush({
      trace: { attributes: { run_id: "run-1" }, annotations: [], spans: [{ name: "load_project_context" }] },
      run: { run_id: "run-1", status: "completed" },
      stage: "final",
    }),
    /phoenix_rest_spans_http_400/,
  );
});

test("trace fetch timeouts fail fast instead of hanging mutation", async () => {
  const exporter = createLocalPhoenixTraceExporter({
    collectorUrl: "http://127.0.0.1:6006/v1/traces",
    appUrl: "http://127.0.0.1:6006",
    projectName: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-policy-"));
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    idFactory: () => "11111111111111111111111111111111",
  });
  const session = await sink.startRun({
    runId: "run-policy",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    teamContext: testTeamContext(),
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

test("oversized non-rich trace exports a digest span with a root evidence-unavailable marker", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-oversized-"));
  const traceId = "11111111111111111111111111111111";
  const exportedSpans = [];
  let rootEvidenceUnavailable = null;
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        const spans = body.resourceSpans[0].scopeSpans[0].spans;
        exportedSpans.push(...spans);
        const root = spans.find((span) => span.name === "teami.workflow_run");
        if (root) rootEvidenceUnavailable = otlpAttributeValue(root.attributes, "teami.evidence_unavailable");
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: traceId,
          spans: exportedSpans.map((span) => ({ name: span.name })),
        }],
      }), { status: 200 });
    },
    idFactory: () => traceId,
  });
  const session = await sink.startRun({
    runId: "run-oversized",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    teamContext: testTeamContext(),
  });
  const trace = {
    attributes: { run_id: "run-oversized" },
    annotations: [],
    spans: Array.from({ length: 230 }, (_, index) => ({
      name: `oversized_span_${index}`,
      attributes: {
        detail: `plain local evidence ${index} ${"x".repeat(420)}`,
        ordinal: index,
      },
      startedAt: "2026-06-09T00:00:00.000Z",
      endedAt: "2026-06-09T00:00:00.001Z",
    })),
  };

  const result = await sink.finishRun({ session, result: { status: "completed", trace } });

  assert.equal(result.status, "trace_exported");
  assert.ok(exportedSpans.some((span) => span.name === "teami.trace_digest"));
  assert.ok(rootEvidenceUnavailable, "expected root evidence_unavailable marker");
  const markers = rootEvidenceUnavailable.map((entry) => JSON.parse(entry));
  assert.ok(markers.some((entry) => entry.scope === "trace.spans" && entry.reason === "too_many_trace_spans"));
  assert.ok(markers.some((entry) => entry.scope === "trace.payload" && entry.reason === "trace_payload_too_large"));
  const health = readTraceHealth({ repoRoot });
  assert.equal(health.latest_status, "trace_exported");
  assert.equal(health.consecutive_failure_count, 0);
  assert.equal(health.recent_failure_count, 0);
});

test("multi-flush trace verification uses cumulative exported names instead of cumulative payload size", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-multiflush-"));
  const traceId = "11111111111111111111111111111111";
  const exportedSpans = [];
  const rootMarkers = [];
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        const spans = body.resourceSpans[0].scopeSpans[0].spans;
        exportedSpans.push(...spans);
        const root = spans.find((span) => span.name === "teami.workflow_run");
        if (root) rootMarkers.push(otlpAttributeValue(root.attributes, "teami.evidence_unavailable"));
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: traceId,
          spans: exportedSpans.map((span) => ({ name: span.name })),
        }],
      }), { status: 200 });
    },
    idFactory: () => traceId,
  });
  const session = await sink.startRun({
    runId: "run-multiflush",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    teamContext: testTeamContext(),
  });
  const trace = { attributes: { run_id: "run-multiflush" }, annotations: [], spans: [] };
  const appendSpans = (offset) => {
    trace.spans.push(...Array.from({ length: 20 }, (_, index) => ({
      name: `batch_span_${offset + index}`,
      attributes: {
        detail: `plain batch evidence ${offset + index} ${"y".repeat(1200)}`,
      },
      startedAt: "2026-06-09T00:00:00.000Z",
      endedAt: "2026-06-09T00:00:00.001Z",
    })));
  };

  appendSpans(0);
  await sink.forceFlush({ session, trace, result: { status: "running" }, stage: "checkpoint" });
  appendSpans(20);
  await sink.forceFlush({ session, trace, result: { status: "running" }, stage: "checkpoint" });
  appendSpans(40);
  assert.equal(enforceTraceContentPolicy(trace, LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS).ok, false);
  const result = await sink.finishRun({ session, result: { status: "completed", trace } });

  assert.equal(result.status, "trace_exported");
  assert.equal(exportedSpans.some((span) => span.name === "teami.trace_digest"), false);
  for (let index = 0; index < 60; index += 1) {
    assert.ok(exportedSpans.some((span) => span.name === `batch_span_${index}`), `missing batch_span_${index}`);
  }
  assert.deepEqual(rootMarkers, [null, null]);
  const health = readTraceHealth({ repoRoot });
  assert.equal(health.latest_status, "trace_exported");
  assert.equal(health.consecutive_failure_count, 0);
  assert.equal(health.recent_failure_count, 0);
});

test("trace sink adopts a healthy collector after readiness startup failure instead of reporting phoenix_start_failed", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-adopt-after-failure-"));
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
        projectName: "teami",
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
    teamContext: testTeamContext(),
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-double-failure-"));
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
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
    teamContext: testTeamContext(),
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
    projectName: "teami",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-preflight-"));
  let exportedTraceId = null;
  let exportedSpanNames = [];
  const result = await runLocalPhoenixTracePreflight({
    repoRoot,
    idFactory: () => "11111111111111111111111111111111",
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    teamContext: testTeamContext(),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
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
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
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
  assert.equal(receipt.team_ref, "team-a");
  assert.equal(receipt.workspace_id, "workspace-1");
  assert.equal(receipt.team_id, "team-1");
});

test("OTLP payload carries Phoenix project and Teami attributes", () => {
  const payload = buildPhoenixOtlpTraceExport({
    projectName: "teami",
    run: {
      run_id: "run-1",
      team_ref: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
      wake_id: "wake-1",
      status: "completed",
    },
    trace: {
      attributes: {
        work_type: "code",
        selected_resource_id: "repo-2",
        resource_id: "repo-2",
        "resource.id": "repo-2",
      },
      annotations: [],
      spans: [],
    },
    traceId: "11111111111111111111111111111111",
  });
  const attrs = payload.resourceSpans[0].resource.attributes;
  const rootAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.ok(attrs.some((attr) => attr.key === "openinference.project.name"));
  assert.ok(rootAttrs.some((attr) => attr.key === "teami.run_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "teami.team_ref"));
  assert.ok(rootAttrs.some((attr) => attr.key === "linear.workspace_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "linear.team_id"));
  assert.ok(rootAttrs.some((attr) => attr.key === "teami.behavior_repo_id"));
  assert.equal(otlpAttributeValue(rootAttrs, "teami.work_type"), "code");
  assert.equal(otlpAttributeValue(rootAttrs, "teami.selected_resource_id"), "repo-2");
  assert.equal(otlpAttributeValue(rootAttrs, "selected_resource_id"), "repo-2");
  assert.equal(otlpAttributeValue(rootAttrs, "resource_id"), "repo-2");
  assert.equal(rootAttrs.some((attr) => attr.key === "teami.team_name"), false);
});

test("OTLP root span exports produced identities as a JSON carrier", () => {
  const producedIdentities = [{
    effect_id: "linear_issues",
    provider: "linear",
    resource_kind: "linear_issue",
    target_ids: ["issue-1", "issue-2"],
    identity: {
      issue_ids: ["issue-1", "issue-2"],
      dependency_relation_ids: ["relation-1"],
      project_update_id: "project-update-1",
    },
  }];
  const payload = buildPhoenixOtlpTraceExport({
    projectName: "teami",
    run: {
      run_id: "run-produced",
      team_ref: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
      status: "completed",
    },
    trace: {
      attributes: {
        [PRODUCED_IDENTITIES_TRACE_ATTRIBUTE]: producedIdentities,
      },
      annotations: [],
      spans: [],
    },
    traceId: "11111111111111111111111111111111",
  });
  const rootAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.deepEqual(
    JSON.parse(otlpAttributeValue(rootAttrs, PRODUCED_IDENTITIES_TRACE_ATTRIBUTE)),
    producedIdentities,
  );
});

test("OTLP root span exports the unpinned runtime marker when present", () => {
  const payload = buildPhoenixOtlpTraceExport({
    projectName: "teami",
    run: {
      run_id: "run-unpinned",
      team_ref: "support-ops",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
      status: "completed",
    },
    trace: {
      attributes: {
        "teami.unpinned_runtime": { pm: { model: true } },
      },
      annotations: [],
      spans: [],
    },
    traceId: "11111111111111111111111111111111",
  });
  const rootAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.deepEqual(
    JSON.parse(otlpAttributeValue(rootAttrs, "teami.unpinned_runtime")),
    { pm: { model: true } },
  );
});

test("trace sink receipt provider_update_ids include reused Linear issue ids", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-sink-provider-updates-"));
  const traceId = "11111111111111111111111111111111";
  const exportedSpans = [];
  const sink = createLocalPhoenixTraceSink({
    repoRoot,
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        exportedSpans.push(...body.resourceSpans[0].scopeSpans[0].spans);
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: traceId,
          spans: exportedSpans.map((span) => ({ name: span.name })),
        }],
      }), { status: 200 });
    },
    idFactory: () => traceId,
  });
  const session = await sink.startRun({
    runId: "run-provider-updates",
    wake: { id: "wake-1", object_id: "project-1", attempt_count: 1 },
    workspaceId: "workspace-1",
    teamContext: testTeamContext(),
  });
  const trace = {
    attributes: { run_id: "run-provider-updates" },
    annotations: [],
    spans: [{ name: "load_project_context" }],
  };
  const producedIdentities = [{
    effect_id: "linear_issues",
    provider: "linear",
    resource_kind: "linear_issue",
    target_ids: ["issue-1", "issue-2"],
    identity: {
      issue_ids: ["issue-1", "issue-2"],
      dependency_relation_ids: [],
      project_update_id: "project-update-1",
    },
  }];

  const result = await sink.finishRun({
    session,
    result: {
      status: "completed",
      trace,
      produced_identities: producedIdentities,
    },
  });

  assert.equal(result.status, "trace_exported");
  assert.deepEqual(result.receipt.provider_update_ids, ["project-update-1", "issue-1", "issue-2"]);
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
  assert.equal(payload.data[0].name, "quality");
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
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-annotation-")),
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
  assert.equal(posted.data[0].metadata.workflow_type, "decomposition");
  assert.equal(posted.data[0].metadata.eval_namespace, "execution/evals/decomposition");
  assert.deepEqual(result.annotationIds, ["anno-1"]);
});

test("Phoenix dataset promotion uses bounded local receipts and auto create or append", async () => {
  const receipt = {
    schema_version: 2,
    run_id: "run-1",
    team_ref: "support-ops",
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
    datasetName: "teami-test",
    action: "create",
  });
  assert.equal(payload.inputs[0].run_id, "run-1");
  assert.equal(payload.inputs[0].team_ref, "support-ops");
  assert.equal(payload.inputs[0].trace_id, "11111111111111111111111111111111");
  assert.equal(payload.outputs[0].status, "completed");
  assert.equal(payload.example_ids[0], "teami:run-1");
  assert.doesNotMatch(JSON.stringify(payload), /prompt|phase_packet|repo_snippet|shell_output/);
  assert.throws(
    () => buildDatasetUploadPayloadFromTraceReceipt({
      receipt: { ...receipt, reason: ["Bearer ", "abcdefghijklmnop"].join("") },
    }),
    /token_material/,
  );

  const calls = [];
  const result = await promoteTraceReceiptToPhoenixDataset({
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-dataset-")),
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
    datasetName: "teami-test",
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
                  shell_output: LOCAL_TOOL_EVENT_DIFF,
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

function writeRuntimeFixtureManifest({ tempDir, archive, platformKey }) {
  const manifestEntry = {
    asset_url: "https://github.com/shulmansj/teami/releases/download/test-runtime/fixture-runtime.tar.gz",
    size_bytes: archive.length,
    sha256: sha256Buffer(archive),
    source_commit: "fixture",
  };
  const manifest = {
    schema_version: 1,
    phoenix_package: "arize-phoenix==14.13.0",
    python_tag: "cpython-3.12.13+20260623",
    platforms: {
      [platformKey]: manifestEntry,
    },
  };
  const manifestPath = path.join(tempDir, "runtime-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifestEntry };
}

function buildRuntimeFixtureArchive(entries) {
  const chunks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(runtimeTarHeader({ name, size: body.length }));
    chunks.push(body);
    chunks.push(Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function runtimeTarHeader({ name, size }) {
  const header = Buffer.alloc(512, 0);
  writeRuntimeTarString(header, name, 0, 100);
  writeRuntimeTarString(header, "0000777", 100, 8);
  writeRuntimeTarString(header, "0000000", 108, 8);
  writeRuntimeTarString(header, "0000000", 116, 8);
  writeRuntimeTarString(header, size.toString(8).padStart(11, "0"), 124, 12);
  writeRuntimeTarString(header, "00000000000", 136, 12);
  header.fill(0x20, 148, 156);
  writeRuntimeTarString(header, "0", 156, 1);
  writeRuntimeTarString(header, "ustar", 257, 6);
  writeRuntimeTarString(header, "00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeRuntimeTarString(header, checksum.toString(8).padStart(6, "0"), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeRuntimeTarString(header, value, offset, length) {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(header, offset, 0, Math.min(bytes.length, length));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function pickPhoenixPathShape(config) {
  return {
    root: config.root,
    venvDir: config.venvDir,
    dataDir: config.dataDir,
    logsDir: config.logsDir,
    serviceFile: config.serviceFile,
    telemetryDir: config.telemetryDir,
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
    this.cache = {
      teamRef: "team-a",
      workspaceId: "workspace-1",
      teamId: "team-1",
      issueLabels: {
        Discovery: "ilabel-discovery",
        "Needs Principal": "ilabel-needs-principal",
        "human-review": "ilabel-human-review",
      },
      issueStatuses: {
        backlog: "state-backlog",
        todo: "state-todo",
        in_progress: "state-in-progress",
        in_review: "state-in-review",
        human_review: "state-human-review",
        needs_principal: "state-needs-principal",
        done: "state-done",
      },
    };
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
    return [{ id: "team-1", key: "DA", name: "Team A" }];
  }

  async listProjectStatuses() {
    return [
      { id: "status-backlog", name: "Backlog", type: "backlog" },
      { id: "status-planned", name: "Planned", type: "planned" },
      { id: "status-principal-escalation", name: "Principal Escalation", type: "planned" },
      { id: "status-started", name: "In Progress", type: "started" },
      { id: "status-completed", name: "Completed", type: "completed" },
    ];
  }

  async listWorkflowStates() {
    return [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-todo", name: "Todo", type: "unstarted" },
      { id: "state-in-progress", name: "In Progress", type: "started" },
      { id: "state-in-review", name: "In Review", type: "started" },
      { id: "state-human-review", name: "Principal Review", type: "started" },
      { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];
  }

  async findProjectLabelsByName(name) {
    return name === "Has Open Questions" ? [{ id: "plabel-open", name }] : [];
  }

  async findIssueLabelsByName(name, teamId) {
    if (teamId !== "team-1") return [];
    const labels = [
      { id: "ilabel-discovery", name: "Discovery", teamId },
      { id: "ilabel-needs-principal", name: "Needs Principal", teamId },
      { id: "ilabel-human-review", name: "human-review", teamId },
    ];
    return name ? labels.filter((label) => label.name === name) : labels;
  }

  async findTemplatesByName(name, type, teamId) {
    return name === "Teami Roadmap Item" && type === "project" && teamId === "team-1"
      ? [{ id: "template-1", name, type, teamId }]
      : [];
  }

  async getProjectContext() {
    return { ...this.project, issues: [] };
  }
}

function testTeamContext() {
  return Object.freeze({
    teamRef: "team-a",
    status: "active",
    linear: Object.freeze({
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "DA",
      teamName: "Team A",
      webhookId: "webhook-1",
      cachePath: "unused",
    }),
    credentialTargets: Object.freeze({
      linearOAuth: "oauth-target",
      runnerInbox: "runner-target",
    }),
    trace: Object.freeze({
      team_ref: "team-a",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test-behavior",
    }),
  });
}
