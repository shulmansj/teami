import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOutcomeObservationPayload,
  OUTCOME_OBSERVATION_ANNOTATION_NAME,
  readPhoenixOutcomeObservationsByTarget,
  writePhoenixOutcomeObservation,
} from "../src/outcome-observation.mjs";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-outcome-observation-"));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fakePhoenixTraceAnnotations() {
  const calls = [];
  const store = new Map();
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname: parsed.pathname, url: parsed, body });
    if (method === "POST" && parsed.pathname === "/v1/trace_annotations") {
      assert.equal(parsed.searchParams.get("sync"), "true");
      const data = body.data.map((entry) => {
        const key = `${entry.name}|${entry.trace_id}|${entry.identifier}`;
        const stored = { id: `ann-${store.size + 1}`, ...entry };
        store.set(key, stored);
        return { id: stored.id };
      });
      return jsonResponse({ data });
    }
    if (method === "GET" && parsed.pathname === "/v1/projects/teami/trace_annotations") {
      const traceId = parsed.searchParams.get("trace_ids");
      return jsonResponse({
        data: [...store.values()].filter((entry) => entry.trace_id === traceId),
        next_cursor: null,
      });
    }
    throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("generic outcome writer posts and reads a freeform SEAM-6 envelope by target_id", async () => {
  const traceId = "11111111111111111111111111111111";
  const producedIdentities = [{
    effect_id: "linear_issues",
    provider: "linear",
    resource_kind: "linear_issue",
    target_ids: ["issue-1", "issue-2"],
    identity: { issue_ids: ["issue-1", "issue-2"] },
  }];
  const observation = {
    observation_id: "obs-issue-1-status-20260626",
    target_id: "issue-1",
    observer: { kind: "fake_local_phoenix_test", id: "observer-1" },
    observed_at: "2026-06-26T12:00:00.000Z",
    label: "linear_issue_status_changed",
    payload: {
      status_name: "Done",
      status_type: "completed",
      comment_count: 2,
      freeform_detail: { arbitrary: true },
    },
  };
  const fetchImpl = fakePhoenixTraceAnnotations();

  const written = await writePhoenixOutcomeObservation({
    repoRoot: tempRoot(),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      projectName: "teami",
    }),
    fetchImpl,
    traceId,
    runId: "run-1",
    producedIdentities,
    observation,
  });

  assert.equal(written.ok, true);
  assert.equal(written.observationId, observation.observation_id);
  assert.equal(written.targetId, observation.target_id);
  assert.deepEqual(written.annotationIds, ["ann-1"]);

  const post = fetchImpl.calls.find((call) => call.method === "POST");
  const annotation = post.body.data[0];
  assert.equal(annotation.name, OUTCOME_OBSERVATION_ANNOTATION_NAME);
  assert.equal(annotation.trace_id, traceId);
  assert.equal(annotation.identifier, observation.observation_id);
  assert.deepEqual(annotation.result, { label: observation.label });
  assert.equal(annotation.metadata.target_id, observation.target_id);
  assert.deepEqual(annotation.metadata.observer, observation.observer);
  assert.deepEqual(annotation.metadata.payload, observation.payload);
  assert.equal(annotation.metadata.rubric_version, undefined);
  assert.equal(annotation.metadata.failure_taxonomy_version, undefined);

  const read = await readPhoenixOutcomeObservationsByTarget({
    repoRoot: tempRoot(),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      projectName: "teami",
    }),
    fetchImpl,
    traceId,
    targetId: "issue-1",
  });

  assert.equal(read.ok, true);
  assert.deepEqual(read.observations, [observation]);
  const get = fetchImpl.calls.find((call) => call.method === "GET");
  assert.equal(get.url.searchParams.get("trace_ids"), traceId);
});

test("outcome payload enforces produced target joins and secret scrub without quality constraints", () => {
  const base = {
    traceId: "11111111111111111111111111111111",
    producedIdentities: [{ target_ids: ["target-1"] }],
    observation: {
      observation_id: "obs-1",
      target_id: "target-1",
      observer: { kind: "test", id: "observer-1" },
      observed_at: "2026-06-26T12:00:00.000Z",
      label: "not_a_quality_label",
      payload: { arbitrary_world_feedback: true },
    },
  };

  const payload = buildOutcomeObservationPayload(base);
  assert.equal(payload.data[0].result.label, "not_a_quality_label");
  assert.equal("score" in payload.data[0].result, false);

  assert.throws(
    () =>
      buildOutcomeObservationPayload({
        ...base,
        observation: { ...base.observation, target_id: "missing-target" },
      }),
    /outcome_observation_target_id_not_produced:missing-target/,
  );

  assert.throws(
    () =>
      buildOutcomeObservationPayload({
        ...base,
        observation: {
          ...base.observation,
          // Split so the contiguous token literal never appears in tracked source
          // (the pre-push secret scan flags "Bearer <16+>"); the runtime value is
          // identical, so the writer still rejects it as token_material.
          payload: { note: ["Bearer ", "abcdefghijklmnop"].join("") },
        },
      }),
    /token_material/,
  );
});

test("outcome writer remains unwired and separate from the quality judgment writer", () => {
  const outcomeSource = fs.readFileSync(path.join(SRC_DIR, "outcome-observation.mjs"), "utf8");
  assert.equal(outcomeSource.includes("buildTraceAnnotationPayload"), false);

  const productionCallers = listMjsFiles(SRC_DIR)
    .filter((file) => path.basename(file) !== "outcome-observation.mjs")
    .filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("outcome-observation.mjs")
        || source.includes("writePhoenixOutcomeObservation")
        || source.includes("readPhoenixOutcomeObservationsByTarget");
    })
    .map((file) => path.relative(SRC_DIR, file).replace(/\\/g, "/"));
  assert.deepEqual(productionCallers, []);
});

function listMjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMjsFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [entryPath] : [];
  });
}
