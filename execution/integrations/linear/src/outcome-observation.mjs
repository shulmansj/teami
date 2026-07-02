import {
  DEFAULT_PHOENIX_PROJECT,
  ensurePhoenixReady,
} from "./local-phoenix-manager.mjs";
import {
  assertNoSecretContent,
  phoenixFetchJson,
} from "./phoenix-self-improvement.mjs";

export const OUTCOME_OBSERVATION_ANNOTATION_NAME = "teami_outcome_observation";
export const OUTCOME_OBSERVATION_SCHEMA_VERSION = "teami-outcome-observation/v1";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const ANNOTATION_PAGE_LIMIT = 1_000;
const MAX_ANNOTATION_PAGES = 10;

export function buildOutcomeObservationPayload({
  traceId,
  runId = null,
  producedIdentities,
  observation,
  annotationName = OUTCOME_OBSERVATION_ANNOTATION_NAME,
} = {}) {
  const normalizedTraceId = normalizeTraceId(traceId);
  const envelope = normalizeOutcomeObservationEnvelope(observation);
  assertProducedTargetId({ targetId: envelope.target_id, producedIdentities });
  const annotation = {
    name: requiredText(annotationName, "annotation_name"),
    annotator_kind: "CODE",
    trace_id: normalizedTraceId,
    result: {
      label: envelope.label,
    },
    metadata: {
      source: "teami_outcome_observation",
      schema_version: OUTCOME_OBSERVATION_SCHEMA_VERSION,
      observation_id: envelope.observation_id,
      target_id: envelope.target_id,
      observer: envelope.observer,
      observed_at: envelope.observed_at,
      payload: envelope.payload,
      ...(stringOrNull(runId) ? { run_id: stringOrNull(runId) } : {}),
    },
    identifier: envelope.observation_id,
  };
  assertNoSecretContent(annotation);
  return { data: [annotation] };
}

export async function writePhoenixOutcomeObservation({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  traceId,
  runId = null,
  producedIdentities,
  observation,
  annotationName = OUTCOME_OBSERVATION_ANNOTATION_NAME,
} = {}) {
  const payload = buildOutcomeObservationPayload({
    traceId,
    runId,
    producedIdentities,
    observation,
    annotationName,
  });
  const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) throw new Error(ready.reason || "local Phoenix is unavailable");
  const body = await phoenixFetchJson({
    appUrl: ready.appUrl,
    pathname: "/v1/trace_annotations",
    searchParams: { sync: "true" },
    method: "POST",
    fetchImpl,
    payload,
  });
  const envelope = payloadToEnvelope(payload);
  return {
    ok: true,
    appUrl: ready.appUrl,
    traceId: payload.data[0].trace_id,
    runId: runId || null,
    targetId: envelope.target_id,
    observationId: envelope.observation_id,
    annotationIds: (body.data || []).map((item) => item.id).filter(Boolean),
    response: body,
  };
}

export async function readPhoenixOutcomeObservationsByTarget({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  traceId,
  targetId,
  projectName = null,
  annotationName = OUTCOME_OBSERVATION_ANNOTATION_NAME,
} = {}) {
  const normalizedTraceId = normalizeTraceId(traceId);
  const normalizedTargetId = requiredText(targetId, "target_id");
  const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) throw new Error(ready.reason || "local Phoenix is unavailable");
  const resolvedProjectName = requiredText(
    projectName || ready.projectName || DEFAULT_PHOENIX_PROJECT,
    "project_name",
  );
  const observations = [];
  let cursor = null;
  for (let page = 0; page < MAX_ANNOTATION_PAGES; page += 1) {
    const body = await phoenixFetchJson({
      appUrl: ready.appUrl,
      pathname: `/v1/projects/${encodeURIComponent(resolvedProjectName)}/trace_annotations`,
      searchParams: {
        trace_ids: normalizedTraceId,
        limit: String(ANNOTATION_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      },
      fetchImpl,
    });
    for (const entry of body.data || []) {
      if (entry?.name !== annotationName) continue;
      const envelope = outcomeEnvelopeFromAnnotation(entry);
      if (envelope?.target_id === normalizedTargetId) observations.push(envelope);
    }
    cursor = body.next_cursor || null;
    if (!cursor) break;
  }
  return {
    ok: true,
    appUrl: ready.appUrl,
    projectName: resolvedProjectName,
    traceId: normalizedTraceId,
    targetId: normalizedTargetId,
    observations,
  };
}

export function outcomeEnvelopeFromAnnotation(entry = {}) {
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  try {
    return normalizeOutcomeObservationEnvelope({
      observation_id: metadata.observation_id || entry.identifier,
      target_id: metadata.target_id,
      observer: metadata.observer,
      observed_at: metadata.observed_at,
      label: entry.result?.label ?? metadata.label,
      payload: metadata.payload,
    });
  } catch {
    return null;
  }
}

export function normalizeOutcomeObservationEnvelope(observation = {}) {
  if (!isRecord(observation)) {
    throw new Error("outcome_observation_envelope_required");
  }
  const observedAt = requiredText(observation.observed_at, "observed_at");
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error("outcome_observation_observed_at_invalid");
  }
  if (!isRecord(observation.observer)) {
    throw new Error("outcome_observation_observer_required");
  }
  if (!Object.hasOwn(observation, "payload")) {
    throw new Error("outcome_observation_payload_required");
  }
  const envelope = {
    observation_id: requiredText(observation.observation_id, "observation_id"),
    target_id: requiredText(observation.target_id, "target_id"),
    observer: {
      kind: requiredText(observation.observer.kind, "observer.kind"),
      id: requiredText(observation.observer.id, "observer.id"),
    },
    observed_at: observedAt,
    label: requiredText(observation.label, "label"),
    payload: jsonSafeClone(observation.payload),
  };
  if (envelope.payload === undefined) {
    throw new Error("outcome_observation_payload_must_be_json");
  }
  assertNoSecretContent(envelope);
  return envelope;
}

export function assertProducedTargetId({ targetId, producedIdentities } = {}) {
  const normalizedTargetId = requiredText(targetId, "target_id");
  if (!Array.isArray(producedIdentities)) {
    throw new Error("outcome_observation_produced_identities_required");
  }
  const found = producedIdentities.some((entry) =>
    Array.isArray(entry?.target_ids)
    && entry.target_ids.some((candidate) => String(candidate) === normalizedTargetId));
  if (!found) {
    throw new Error(`outcome_observation_target_id_not_produced:${normalizedTargetId}`);
  }
  return true;
}

function payloadToEnvelope(payload) {
  return outcomeEnvelopeFromAnnotation(payload?.data?.[0]);
}

function normalizeTraceId(traceId) {
  const text = requiredText(traceId, "trace_id");
  if (!TRACE_ID_PATTERN.test(text)) {
    throw new Error("outcome_observation_trace_id_invalid");
  }
  return text;
}

function requiredText(value, field) {
  const text = stringOrNull(value);
  if (!text) throw new Error(`outcome_observation_${field}_required`);
  return text;
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function jsonSafeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
