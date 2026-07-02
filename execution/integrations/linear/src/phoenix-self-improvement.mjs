import os from "node:os";

import {
  ANNOTATOR_KINDS,
  CANONICAL_ANNOTATION_NAMES,
  DEFAULT_ANNOTATION_NAME,
  FAILURE_TAXONOMY_VERSION,
  findBannedWorkflowStateMetadataKeys,
  QUALITY_DIMENSION_NAMES,
  QUALITY_LABELS,
  resolveEvalContract,
  RUBRIC_VERSION,
  WORKSPACE_MATURITY_LEVELS,
} from "./eval-annotation-contract.mjs";
import { ensurePhoenixReady } from "./local-phoenix-manager.mjs";
import { findSecretContentKeys } from "../../../engine/trace-contract.mjs";

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_DATASET_NAME = "teami-decomposition-runs";
const DEFAULT_WORKFLOW_TYPE = "decomposition";
const DEFAULT_EVAL_NAMESPACE = "execution/evals/decomposition";

function nonEmptyArray(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function annotationContract({
  evalContract = null,
  definition = null,
  repoRoot = process.cwd(),
} = {}) {
  const contract = evalContract || (definition ? resolveEvalContract(definition, repoRoot) : null);
  if (contract && contract.eval_configured !== true) {
    throw new Error(contract.reason || `workflow_eval_not_configured:${contract.workflow_type || "unknown"}`);
  }
  return {
    annotatorKinds: nonEmptyArray(contract?.annotator_kinds, ANNOTATOR_KINDS),
    qualityDimensionNames: nonEmptyArray(contract?.quality_dimension_names, QUALITY_DIMENSION_NAMES),
    canonicalAnnotationNames: nonEmptyArray(contract?.canonical_annotation_names, CANONICAL_ANNOTATION_NAMES),
    qualityLabels: nonEmptyArray(contract?.quality_labels, QUALITY_LABELS),
    workspaceMaturityLevels: nonEmptyArray(contract?.workspace_maturity_levels, WORKSPACE_MATURITY_LEVELS),
    defaultName: contract?.roll_up_annotation_name || DEFAULT_ANNOTATION_NAME,
    defaultRubricVersion: contract?.rubric_version || RUBRIC_VERSION,
    defaultFailureTaxonomyVersion: contract?.failure_taxonomy_version || FAILURE_TAXONOMY_VERSION,
    workflowType: contract?.workflow_type || DEFAULT_WORKFLOW_TYPE,
    evalNamespace: contract?.eval_namespace || DEFAULT_EVAL_NAMESPACE,
    findBannedMetadataKeys: contract?.findBannedWorkflowStateMetadataKeys || findBannedWorkflowStateMetadataKeys,
  };
}

// Resolves the required annotation identifier. Phoenix upserts annotations by
// (name, target, identifier) and defaults the identifier to "", so every
// write MUST carry a non-empty identifier or human/model/code judgments that
// share a name and target silently overwrite each other.
// - HUMAN: explicit flag wins, then local config (evals.human_annotator_identifier),
//   then the OS username. MVP identifiers are asserted, not authenticated.
// - LLM/CODE: the judge id / evaluator id must be explicit; there is no safe default.
export function resolveAnnotationIdentifier({
  annotatorKind = "HUMAN",
  identifier = null,
  config = null,
  osUserName = defaultOsUserName,
} = {}) {
  const explicit = String(identifier ?? "").trim();
  if (explicit) return { identifier: explicit, source: "explicit" };
  if (annotatorKind === "HUMAN") {
    const configured = String(config?.evals?.human_annotator_identifier ?? "").trim();
    if (configured) return { identifier: configured, source: "local_config" };
    const fromOs = String(osUserName() ?? "").trim();
    if (fromOs) return { identifier: fromOs, source: "os_username" };
    throw new Error(
      "Could not resolve a HUMAN annotator identifier from local config (evals.human_annotator_identifier) or the OS username; pass --identifier <id>.",
    );
  }
  throw new Error(
    `${annotatorKind} annotations require an explicit identifier (judge id for LLM, evaluator id for CODE); pass --identifier <id>.`,
  );
}

function defaultOsUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || "";
  }
}

export function buildTraceAnnotationPayload({
  repoRoot = process.cwd(),
  definition = null,
  evalContract = null,
  traceId,
  name = null,
  label,
  score = null,
  explanation = "",
  annotatorKind = "HUMAN",
  identifier,
  metadata = {},
  rubricVersion = null,
  failureTaxonomyVersion = null,
  workspaceMaturity = "new",
} = {}) {
  const contract = annotationContract({ evalContract, definition, repoRoot });
  const annotationName = name ?? contract.defaultName;
  if (!/^[0-9a-f]{32}$/i.test(String(traceId || ""))) {
    throw new Error("traceId must be a 32-character hex Phoenix trace id.");
  }
  if (!contract.annotatorKinds.includes(annotatorKind)) {
    throw new Error(`annotator_kind must be one of ${contract.annotatorKinds.join("|")} (got "${annotatorKind}").`);
  }
  // HUMAN and LLM quality judgments use the 8 rubric dimension names; the two
  // deterministic-check names are CODE storage only.
  const allowedNames = annotatorKind === "CODE" ? contract.canonicalAnnotationNames : contract.qualityDimensionNames;
  if (!allowedNames.includes(annotationName)) {
    throw new Error(
      `annotation name "${annotationName}" is not canonical for annotator_kind ${annotatorKind}; allowed: ${allowedNames.join(", ")}.`,
    );
  }
  if (!contract.qualityLabels.includes(label)) {
    throw new Error(
      `annotation label must be one of ${contract.qualityLabels.join("|")} (got "${label ?? ""}"); the canonical label set must not drift.`,
    );
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("annotation score is required and must be a number in [0, 1].");
  }
  const explanationText = String(explanation ?? "").trim();
  if (!explanationText) {
    throw new Error("annotation explanation is required: record why this judgment was made.");
  }
  const identifierText = String(identifier ?? "").trim();
  if (!identifierText) {
    throw new Error(
      "annotation identifier is required and must be non-empty: Phoenix upserts by (name, target, identifier) and defaults the identifier to \"\", so an empty identifier can overwrite or merge human/model/code judgments.",
    );
  }
  if (!contract.workspaceMaturityLevels.includes(workspaceMaturity)) {
    throw new Error(`workspace_maturity must be one of ${contract.workspaceMaturityLevels.join("|")} (got "${workspaceMaturity}").`);
  }
  const resolvedRubricVersion = String(rubricVersion ?? contract.defaultRubricVersion ?? "").trim();
  const resolvedFailureTaxonomyVersion = String(
    failureTaxonomyVersion ?? contract.defaultFailureTaxonomyVersion ?? "",
  ).trim();
  if (!resolvedRubricVersion || !resolvedFailureTaxonomyVersion) {
    throw new Error("rubric_version and failure_taxonomy_version are required annotation metadata.");
  }
  const bannedKeys = contract.findBannedMetadataKeys(metadata);
  if (bannedKeys.length > 0) {
    throw new Error(
      `phoenix_annotation_metadata_contains_workflow_state_keys:${bannedKeys.join(",")} (Phoenix annotations are judgments, never task flags; workflow/queue state must not be written to Phoenix)`,
    );
  }
  if (metadata.failure_modes !== undefined && !Array.isArray(metadata.failure_modes)) {
    throw new Error("metadata.failure_modes must be an array of failure mode ids.");
  }
  const annotation = {
    name: annotationName,
    annotator_kind: annotatorKind,
    trace_id: traceId,
    result: {
      label: String(label),
      score,
      explanation: explanationText,
    },
    metadata: {
      source: "teami_local_phoenix",
      failure_modes: [],
      ...metadata,
      workflow_type: contract.workflowType,
      eval_namespace: contract.evalNamespace,
      rubric_version: resolvedRubricVersion,
      failure_taxonomy_version: resolvedFailureTaxonomyVersion,
      workspace_maturity: workspaceMaturity,
    },
    identifier: identifierText,
  };
  assertNoSecretContent(annotation);
  return { data: [annotation] };
}

export async function createPhoenixTraceAnnotation({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  ...annotation
} = {}) {
  const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) throw new Error(ready.reason || "local Phoenix is unavailable");
  const payload = buildTraceAnnotationPayload({ ...annotation, repoRoot });
  const body = await phoenixFetchJson({
    appUrl: ready.appUrl,
    pathname: "/v1/trace_annotations",
    searchParams: { sync: "true" },
    method: "POST",
    fetchImpl,
    payload,
  });
  return {
    ok: true,
    appUrl: ready.appUrl,
    traceId: annotation.traceId,
    annotationIds: (body.data || []).map((item) => item.id).filter(Boolean),
    response: body,
  };
}

export function buildDatasetUploadPayloadFromTraceReceipt({
  receipt,
  datasetName = DEFAULT_DATASET_NAME,
  action = "append",
  description = "Teami promoted local trace receipts for Phoenix-native evaluation.",
  split = "self_improvement",
  metadata = {},
} = {}) {
  if (!receipt?.run_id) throw new Error("trace receipt with run_id is required.");
  const input = {
    run_id: receipt.run_id,
    domain_id: receipt.domain_id || null,
    workflow_type: receipt.workflow_type || null,
    wake_id: receipt.wake_id || null,
    object_id: receipt.object_id || receipt.project_id || null,
    trace_id: receipt.trace_id || null,
    trace_status: receipt.trace_status || null,
  };
  const output = {
    status: receipt.status || null,
    reason: receipt.reason || receipt.terminal_reason || null,
  };
  const payload = {
    name: datasetName,
    action,
    description,
    inputs: [input],
    outputs: [output],
    metadata: [{
      source: "teami_local_trace_receipt",
      phoenix_app_url: receipt.phoenix_app_url || null,
      observed_at: receipt.observed_at || null,
      ...metadata,
    }],
    splits: [split],
    span_ids: [null],
    example_ids: [`teami:${receipt.run_id}`],
  };
  assertNoSecretContent(payload);
  return payload;
}

export async function promoteTraceReceiptToPhoenixDataset({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  receipt,
  datasetName = DEFAULT_DATASET_NAME,
  action = "auto",
  description,
  split,
  metadata,
} = {}) {
  const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) throw new Error(ready.reason || "local Phoenix is unavailable");
  const resolvedAction = action === "auto"
    ? await resolveDatasetAction({ appUrl: ready.appUrl, datasetName, fetchImpl })
    : action;
  const payload = buildDatasetUploadPayloadFromTraceReceipt({
    receipt,
    datasetName,
    action: resolvedAction,
    description,
    split,
    metadata,
  });
  const body = await phoenixFetchJson({
    appUrl: ready.appUrl,
    pathname: "/v1/datasets/upload",
    searchParams: { sync: "true" },
    method: "POST",
    fetchImpl,
    payload,
  });
  return {
    ok: true,
    appUrl: ready.appUrl,
    action: resolvedAction,
    datasetName,
    dataset: body.data || null,
    response: body,
  };
}

async function resolveDatasetAction({ appUrl, datasetName, fetchImpl }) {
  const body = await phoenixFetchJson({
    appUrl,
    pathname: "/v1/datasets",
    searchParams: { name: datasetName, limit: "1" },
    fetchImpl,
  });
  return (body.data || []).some((dataset) => dataset.name === datasetName) ? "append" : "create";
}

export async function phoenixFetchJson({
  appUrl,
  pathname,
  searchParams = {},
  method = "GET",
  fetchImpl,
  payload = null,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  const url = new URL(pathname, appUrl);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetchWithTimeout(url, {
    fetchImpl,
    timeoutMs,
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
  }
  return body;
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs, ...init }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`phoenix_fetch_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function assertNoSecretContent(payload) {
  const secretKeys = findSecretContentKeys(payload);
  if (secretKeys.length > 0) {
    throw new Error(`phoenix_self_improvement_payload_contains_token_material:${secretKeys.join(",")}`);
  }
}
