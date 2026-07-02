import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { boundedRunReceiptProjection, TRACE_RECEIPT_SCHEMA_VERSION } from "../../../engine/trace-contract.mjs";
import { startAgentTrace } from "../src/agent-trace.mjs";
import {
  readTraceReceipt,
  validateTraceReceipt,
} from "../src/trace-status-store.mjs";

test("startAgentTrace exports a github_behavior_repo trace without Linear workspace or team ids", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-agent-trace-"));
  const traceId = "11111111111111111111111111111111";
  const resource = {
    kind: "github_behavior_repo",
    id: "github:teami",
    label: "teami",
  };
  let exportPayload = null;
  let exportedSpanNames = [];

  const agentTrace = await startAgentTrace({
    agent_role: "self_improvement_drafter",
    run_id: "run-github-behavior-repo",
    resource,
    domain_id: "domain-a",
    workflow_type: "self_improvement_draft",
    repoRoot,
    idFactory: () => traceId,
    now: () => new Date("2026-06-25T00:00:00.000Z"),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        exportPayload = JSON.parse(init.body);
        const spans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
        exportedSpanNames = spans.map((span) => span.name);
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: traceId,
          spans: exportedSpanNames.map((name) => ({ name })),
        }],
      }), { status: 200 });
    },
  });

  assert.equal(agentTrace.trace.attributes["resource.kind"], "github_behavior_repo");
  assert.equal(agentTrace.trace.attributes["github.behavior_repo_id"], "github:teami");
  const span = agentTrace.spanSink.recordSpan("drafter.plan", () => ({
    asked: "draft an optimizer improvement",
    produced: "proposal patch plan",
    outcome: "ready_for_review",
  }));
  assert.equal(span.name, "drafter.plan");
  assert.doesNotThrow(() => agentTrace.spanSink.recordSpan("drafter.bad_attribute_thunk", () => {
    throw new Error("attribute collection failed");
  }));

  const result = await agentTrace.finish({ status: "completed", reason: "draft_ready" });
  assert.equal(result.status, "trace_exported");
  assert.equal(result.receipt.resource.kind, "github_behavior_repo");
  assert.equal(result.receipt.workspace_id, null);
  assert.equal(result.receipt.team_id, null);

  const rootSpan = exportPayload.resourceSpans[0].scopeSpans[0].spans
    .find((candidate) => candidate.name === "teami.workflow_run");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "resource.kind"), "github_behavior_repo");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "resource.id"), "github:teami");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "resource.label"), "teami");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "github.behavior_repo_id"), "github:teami");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "github.behavior_repo_label"), "teami");
  assert.equal(otlpAttributeValue(rootSpan.attributes, "linear.workspace_id"), null);
  assert.equal(otlpAttributeValue(rootSpan.attributes, "linear.team_id"), null);

  const receipt = readTraceReceipt({ repoRoot, runId: "run-github-behavior-repo" });
  validateTraceReceipt(receipt);
  assert.equal(receipt.schema_version, TRACE_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.domain_id, "domain-a");
  assert.equal(receipt.workspace_id, null);
  assert.equal(receipt.team_id, null);
  assert.deepEqual(receipt.resource, resource);
  assert.equal(receipt.github_behavior_repo_id, "github:teami");
  assert.equal(receipt.github_behavior_repo_label, "teami");
});

test("strict Linear receipts still reject missing workspace and team identity", () => {
  assert.throws(
    () => validateTraceReceipt({
      schema_version: TRACE_RECEIPT_SCHEMA_VERSION,
      run_id: "run-linear-missing-identity",
      domain_id: "domain-a",
      trace_status: "trace_exported",
    }),
    /missing_workspace_id/,
  );
  assert.throws(
    () => validateTraceReceipt({
      schema_version: TRACE_RECEIPT_SCHEMA_VERSION,
      run_id: "run-linear-explicit-kind",
      domain_id: "domain-a",
      resource: { kind: "linear", id: "project-1", label: "Project 1" },
      trace_status: "trace_exported",
    }),
    /missing_workspace_id/,
  );
  assert.throws(
    () => boundedRunReceiptProjection({
      run: {
        run_id: "run-linear-projection",
        domain_id: "domain-a",
        resource: { kind: "linear", id: "project-1", label: "Project 1" },
      },
      traceStatus: "trace_exported",
    }),
    /workspace_id is required/,
  );
});

test("startAgentTrace finish is non-throwing when the sink throws", async () => {
  const agentTrace = await startAgentTrace({
    agent_role: "self_improvement_drafter",
    run_id: "run-finish-non-throwing",
    resource: {
      kind: "github_behavior_repo",
      id: "github:teami",
      label: "teami",
    },
    domain_id: "domain-a",
    workflow_type: "self_improvement_draft",
    sinkFactory: () => ({
      async startAgentRun() {
        return { ok: true, traceId: "22222222222222222222222222222222", run: {}, exporter: {} };
      },
      async finishRun() {
        throw new Error("synthetic_finish_failure");
      },
      async shutdown() {
        throw new Error("synthetic_shutdown_failure");
      },
    }),
  });

  const result = await agentTrace.finish({ status: "failed", reason: "upstream_failed" });
  assert.equal(result.status, "trace_delivery_failed");
  assert.equal(result.reason, "synthetic_finish_failure");
});

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
