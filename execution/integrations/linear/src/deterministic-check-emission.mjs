import { ensurePhoenixReady, phoenixStatus } from "./local-phoenix-manager.mjs";
import { createPhoenixTraceAnnotation } from "./phoenix-self-improvement.mjs";
import {
  evaluateAcceptedPacketSufficiencyOffline,
  evaluateDecompositionQualityOffline,
  evaluatePauseState,
} from "./quality.mjs";
import { readRunArtifact } from "../../../engine/run-store.mjs";
import {
  isInvalidTraceReceiptResult,
  readTraceReceipt,
} from "./trace-status-store.mjs";
import { loadWorkspaceEvalPolicy } from "./workspace-eval-policy.mjs";

// Track D2: deterministic check result emission, strictly OUTSIDE the live
// mutation path (CONSTRAINTS #27: deterministic checks never run in the live
// mutation DECISION path; this module is post-run / on-demand / eval-mode
// only and is never imported by trigger-runner.mjs or linear-service.mjs —
// a test pins that).
//
// Storage contract (CONSTRAINTS #30): deterministic check results are stored
// as Phoenix annotations with annotator_kind CODE. CODE is a storage format,
// not a third peer judge. The pinned local Phoenix is PREFLIGHTED for CODE
// storage on every emission (openapi shape probe, so version drift fails
// closed); when CODE storage is unavailable the results are recorded in the
// experiment/report output (the structured result object below) instead, and
// any workflow that requires Phoenix-native check storage FAILS CLOSED.
// Results are NEVER spoofed as HUMAN or LLM: the annotator kind is hardcoded
// to CODE at the single write site and no caller-supplied flag can change it.

export const PHOENIX_CODE_CHECK_STORAGE_CAPABILITY = "phoenix_code_check_annotation_storage";

const TRACE_ANNOTATIONS_PATH = "/v1/trace_annotations";
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_SCHEMA_RESOLUTION_DEPTH = 12;

// Capability preflight (reusable; CONSTRAINTS #12 style: per capability, fail
// closed). Verifies the CONFIGURED local Phoenix can store code-emitted check
// results with the required identifier/kind metadata by probing the documented
// endpoint shape in /openapi.json:
//   POST /v1/trace_annotations -> requestBody.data[] items must accept
//   annotator_kind CODE, a non-empty identifier, and a result object.
// arize-phoenix 14.13.0 supports this (PHOENIX-CAPABILITIES "Annotations
// CRUD"), but the probe checks the LIVE server so silent version drift fails
// closed instead of spoofing storage kinds.
export async function preflightPhoenixCodeCheckStorage({
  repoRoot = process.cwd(),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const capability = PHOENIX_CODE_CHECK_STORAGE_CAPABILITY;
  let ready;
  try {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  } catch (error) {
    return { ok: false, capability, reason: "local_phoenix_unavailable", detail: error.message };
  }
  if (!ready?.ok) {
    return {
      ok: false,
      capability,
      reason: "local_phoenix_unavailable",
      detail: ready?.reason || null,
    };
  }

  let spec;
  try {
    const response = await fetchWithTimeout(new URL("/openapi.json", ready.appUrl), {
      fetchImpl,
      timeoutMs,
    });
    if (!response.ok) {
      return {
        ok: false,
        capability,
        appUrl: ready.appUrl,
        reason: "openapi_unavailable",
        detail: `phoenix_http_${response.status}`,
      };
    }
    spec = JSON.parse(await response.text());
  } catch (error) {
    return {
      ok: false,
      capability,
      appUrl: ready.appUrl,
      reason: "openapi_unavailable",
      detail: error.message,
    };
  }

  const failClosed = (reason, detail = null) => ({
    ok: false,
    capability,
    appUrl: ready.appUrl,
    reason,
    detail,
  });
  const post = spec?.paths?.[TRACE_ANNOTATIONS_PATH]?.post;
  if (!post) return failClosed("trace_annotation_endpoint_missing", TRACE_ANNOTATIONS_PATH);
  const requestSchema = resolveSchemaRef(
    post.requestBody?.content?.["application/json"]?.schema,
    spec,
  );
  const itemSchema = resolveSchemaRef(requestSchema?.properties?.data?.items, spec);
  if (!itemSchema?.properties) {
    return failClosed("annotation_payload_shape_unrecognized");
  }
  const annotatorKinds = collectEnumValues(itemSchema.properties.annotator_kind, spec);
  if (!annotatorKinds.includes("CODE")) {
    return failClosed(
      "code_annotator_kind_unsupported",
      `annotator_kind values: ${annotatorKinds.join("|") || "none"}`,
    );
  }
  if (!itemSchema.properties.identifier) {
    return failClosed("annotation_identifier_unsupported");
  }
  if (!itemSchema.properties.result) {
    return failClosed("annotation_result_unsupported");
  }
  return {
    ok: true,
    capability,
    appUrl: ready.appUrl,
    ready,
    checkedPath: TRACE_ANNOTATIONS_PATH,
    annotatorKinds,
  };
}

// Pure deterministic check runner over a run artifact (plus optional
// caller-supplied evaluator inputs for checks whose inputs are not recorded
// in run artifacts). Reuses the quality.mjs evaluators so deterministic
// checks stay on the documented taxonomy contract.
//
// Skip semantics follow the plan's Error/Rescue row ("Deterministic check |
// required artifact missing | check skipped with failure mode"): a check
// whose required inputs are missing is reported as skipped with a named
// machine-readable reason — never silently dropped, never guessed.
export function runDeterministicChecksForArtifact({ artifact = null, checkInputs = {} } = {}) {
  const checks = [];
  const evaluated = (annotation) => {
    assertCodeCheckResult(annotation);
    return {
      status: "evaluated",
      name: annotation.name,
      identifier: annotation.identifier,
      annotation,
    };
  };
  const skipped = (name, identifier, skipReason, missingInputs = []) => ({
    status: "skipped",
    name,
    identifier,
    skip_reason: skipReason,
    missing_inputs: missingInputs,
  });

  if (!artifact || typeof artifact !== "object") {
    return [
      skipped("decomposition_quality", "decomposition_quality_offline_v1", "missing_run_artifact", ["run_artifact"]),
      skipped("accepted_packet_sufficiency", "accepted_packet_sufficiency_offline_v1", "missing_run_artifact", ["run_artifact"]),
      skipped("pause_state_correctness", "pause_state_correctness_offline_v1", "missing_run_artifact", ["run_artifact"]),
    ];
  }

  // decomposition_quality: evaluateDecompositionQualityOffline inspects
  // structured issue fields (assignment / output / acceptanceCriteria) that
  // run artifacts do NOT record — final_issues carry only the Linear handoff
  // shape (decomposition_key, title, issue_body_markdown, depends_on, ...).
  // Deriving those fields from free-form markdown would silently change the
  // accepted evaluator's semantics, and running on partial inputs would emit
  // FALSE failure modes for every run. So artifact-driven emission skips this
  // check with a named reason unless the caller (eval-mode / the step-8
  // experiment wrapper, which owns evaluator-input mapping per Track E)
  // supplies structured inputs explicitly.
  if (checkInputs.decomposition_quality) {
    checks.push(evaluated(evaluateDecompositionQualityOffline(checkInputs.decomposition_quality)));
  } else {
    checks.push(skipped(
      "decomposition_quality",
      "decomposition_quality_offline_v1",
      "structured_issue_inputs_not_recorded_in_run_artifact",
      ["issues[].assignment", "issues[].output", "issues[].acceptanceCriteria"],
    ));
  }

  if (checkInputs.accepted_packet_sufficiency) {
    checks.push(evaluated(
      evaluateAcceptedPacketSufficiencyOffline(checkInputs.accepted_packet_sufficiency),
    ));
  } else {
    const acceptedPacketSufficiencyInput = acceptedPacketSufficiencyInputFromArtifact(artifact);
    if (acceptedPacketSufficiencyInput) {
      checks.push(evaluated(
        evaluateAcceptedPacketSufficiencyOffline(acceptedPacketSufficiencyInput),
      ));
    } else {
      // Resume artifacts carry a single resume packet, not the orchestrator's
      // terminal output, so the sufficiency check has no usable input.
      checks.push(skipped(
        "accepted_packet_sufficiency",
        "accepted_packet_sufficiency_offline_v1",
        "missing_terminal_output",
        ["terminal_output"],
      ));
    }
  }

  // pause_state_correctness: evaluatePauseState inspects the POST-mutation
  // verified Linear project view, which is neither recorded in the run
  // artifact nor in the captured (pre-run) project snapshot. The live path
  // already records this result as a trace span event at pause time; the
  // Phoenix CODE annotation can only be emitted when a caller supplies the
  // project view explicitly (eval-mode / experiments).
  if (checkInputs.pause_state_correctness) {
    checks.push(evaluated(evaluatePauseState(checkInputs.pause_state_correctness)));
  } else if (artifact.kind === "pause") {
    checks.push(skipped(
      "pause_state_correctness",
      "pause_state_correctness_offline_v1",
      "post_mutation_project_state_not_recorded_in_run_artifact",
      ["project", "hasOpenQuestionsLabelId", "backlogStatusId"],
    ));
  } else {
    checks.push(skipped(
      "pause_state_correctness",
      "pause_state_correctness_offline_v1",
      "not_applicable_run_not_paused",
      [],
    ));
  }

  return checks;
}

export function acceptedPacketSufficiencyInputFromArtifact(artifact) {
  if (isRecord(artifact?.terminal_output)) {
    return { terminalOutput: terminalOutputSufficiencyView(artifact) };
  }
  if (!["commit", "pause"].includes(artifact?.kind) && Array.isArray(artifact?.phase_packets)) {
    return { phasePackets: artifact.phase_packets };
  }
  return null;
}

function terminalOutputSufficiencyView(artifact) {
  const terminalOutput = artifact.terminal_output;
  const pausePacket = isRecord(artifact.pause_packet) ? artifact.pause_packet : {};
  return {
    ...terminalOutput,
    project_update_markdown:
      artifact.project_update_markdown ?? pausePacket.project_update_markdown,
    open_questions_markdown: pausePacket.open_questions_markdown,
    discovery_issues:
      artifact.discovery_issues ?? pausePacket.discovery_issues ?? terminalOutput.discovery_issues,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// CONSTRAINTS #30 guard: every result this module stores MUST already be a
// CODE-kind evaluator output. There is no parameter anywhere in this module
// that can change the stored annotator kind.
export function assertCodeCheckResult(annotation) {
  if (annotation?.annotator_kind !== "CODE") {
    throw new Error(
      `deterministic_check_result_must_be_code:${annotation?.name || "unknown"} `
      + "(deterministic checks are stored as annotator_kind CODE only and are never "
      + "spoofed as HUMAN or LLM judgments)",
    );
  }
  return annotation;
}

// Post-run / eval-mode emission of deterministic check results.
//
// Accepts EITHER a run id (loads the local run artifact from
// .agentic-factory/runs/ and the trace receipt from
// .agent-shell/telemetry/runs/) OR in-memory artifacts (eval-mode parity: the
// step-8 experiment wrapper passes `artifact` + `traceId` + `checkInputs`
// directly). Evaluated results are written as Phoenix trace annotations with
// annotator_kind CODE through the SAME shared write path/validation as every
// other annotation (createPhoenixTraceAnnotation -> buildTraceAnnotationPayload),
// attached to the run's actual trace id from the trace receipt.
//
// Returns a structured result that doubles as the experiment/report output
// record when Phoenix-native CODE storage is unavailable:
//   { ok, storage: "phoenix_native"|"report_only", failed_closed, reason?,
//     run_id, trace_id, trace_status, capability_preflight,
//     checks: [{ status, name, identifier, annotation?|skip_reason?,
//                annotation_ids?, error? }],
//     annotation_ids, emitted_count, skipped_count }
//
// `ok` is true only when Phoenix-native storage succeeded for every evaluated
// check (named skips do not fail the emission). Callers whose workflow
// REQUIRES Phoenix-native check storage pass requirePhoenixNative: true and
// must treat ok:false as fail-closed (failed_closed is set for them).
export async function emitDeterministicCheckResults({
  repoRoot = process.cwd(),
  runId = null,
  artifact = null,
  receipt = null,
  traceId = null,
  checkInputs = {},
  runStoreDir = null,
  requirePhoenixNative = false,
  workspaceMaturity = null,
  policyPath = undefined,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  // 1. Resolve the run artifact (in-memory wins; otherwise local store).
  let resolvedArtifact = artifact;
  let artifactFailure = null;
  if (!resolvedArtifact && runId) {
    try {
      resolvedArtifact = readRunArtifact({ runId, repoRoot, runStoreDir });
      if (!resolvedArtifact) artifactFailure = "missing_run_artifact";
    } catch (error) {
      artifactFailure = "invalid_run_artifact";
      onProgress(`WARNING run artifact for ${runId} is invalid: ${error.message}`);
    }
  } else if (!resolvedArtifact) {
    artifactFailure = "missing_run_artifact";
  }
  const effectiveRunId = resolvedArtifact?.run_id || runId || null;

  // 2. Resolve the trace target from the trace receipt (or explicit ids for
  // in-memory eval-mode use).
  const resolvedReceipt = receipt
    || (effectiveRunId ? readTraceReceipt({ repoRoot, runId: effectiveRunId }) : null);
  const invalidTraceReceipt = isInvalidTraceReceiptResult(resolvedReceipt) ? resolvedReceipt : null;
  const traceTarget = invalidTraceReceipt ? null : traceId || resolvedReceipt?.trace_id || null;
  const traceStatus = invalidTraceReceipt ? null : resolvedReceipt?.trace_status || null;
  const validTraceTarget = typeof traceTarget === "string" && TRACE_ID_PATTERN.test(traceTarget);

  // 3. Run the deterministic checks (pure, offline).
  const checks = artifactFailure
    ? runDeterministicChecksForArtifact({ artifact: null }).map((check) => ({
        ...check,
        skip_reason: artifactFailure,
      }))
    : runDeterministicChecksForArtifact({ artifact: resolvedArtifact, checkInputs });
  const evaluatedChecks = checks.filter((check) => check.status === "evaluated");

  const base = {
    run_id: effectiveRunId,
    trace_id: validTraceTarget ? traceTarget : null,
    trace_status: traceStatus,
    checks,
    emitted_count: 0,
    skipped_count: checks.filter((check) => check.status === "skipped").length,
    annotation_ids: [],
  };

  if (artifactFailure) {
    return {
      ok: false,
      storage: "report_only",
      failed_closed: Boolean(requirePhoenixNative),
      reason: artifactFailure,
      capability_preflight: null,
      ...base,
    };
  }

  if (invalidTraceReceipt) {
    return {
      ok: false,
      storage: "report_only",
      failed_closed: Boolean(requirePhoenixNative),
      reason: invalidTraceReceipt.reason,
      detail: `${invalidTraceReceipt.detail}; re-run the source workflow to write a current domain-identity trace receipt.`,
      repairable: true,
      capability_preflight: null,
      trace_receipt_path: invalidTraceReceipt.path,
      ...base,
    };
  }

  if (!validTraceTarget) {
    // Without a trace target there is nothing to attach Phoenix-native
    // results to; the structured result above IS the report-output record.
    return {
      ok: false,
      storage: "report_only",
      failed_closed: Boolean(requirePhoenixNative),
      reason: traceTarget ? "invalid_trace_target" : "missing_trace_target",
      capability_preflight: null,
      ...base,
    };
  }

  // 4. Preflight Phoenix-native CODE storage; fall back to report output and
  // fail closed (for native-requiring workflows) when unavailable. NEVER
  // write CODE results under another annotator kind.
  const preflight = await preflightPhoenixCodeCheckStorage({
    repoRoot,
    ensureReady,
    fetchImpl,
    onProgress,
  });
  if (!preflight.ok) {
    return {
      ok: false,
      storage: "report_only",
      failed_closed: Boolean(requirePhoenixNative),
      reason: preflight.reason,
      capability_preflight: preflight,
      ...base,
    };
  }

  // 5. Write each evaluated check through the shared annotation write path.
  // The annotator kind is the literal "CODE" at this single write site.
  let maturity = workspaceMaturity;
  if (!maturity && evaluatedChecks.length > 0) {
    maturity = loadWorkspaceEvalPolicy(policyPath ? { policyPath } : {}).workspace_maturity;
  }
  const readyForWrites = async () => preflight.ready;
  const annotationIds = [];
  let writeFailures = 0;
  for (const check of evaluatedChecks) {
    assertCodeCheckResult(check.annotation);
    try {
      const written = await createPhoenixTraceAnnotation({
        repoRoot,
        ensureReady: readyForWrites,
        fetchImpl,
        onProgress,
        traceId: traceTarget,
        name: check.annotation.name,
        label: check.annotation.label,
        score: check.annotation.score,
        explanation: check.annotation.explanation,
        annotatorKind: "CODE",
        identifier: check.annotation.identifier,
        metadata: {
          ...check.annotation.metadata,
          source_run_id: effectiveRunId,
        },
        workspaceMaturity: maturity,
      });
      check.annotation_ids = written.annotationIds;
      annotationIds.push(...written.annotationIds);
    } catch (error) {
      writeFailures += 1;
      check.error = error.message;
    }
  }

  const ok = writeFailures === 0;
  return {
    ok,
    storage: "phoenix_native",
    failed_closed: !ok && Boolean(requirePhoenixNative),
    ...(ok ? {} : { reason: "annotation_write_failed" }),
    capability_preflight: preflight,
    ...base,
    emitted_count: evaluatedChecks.length - writeFailures,
    annotation_ids: annotationIds,
  };
}

// Non-starting Phoenix readiness probe for best-effort post-terminal use:
// Phoenix stays lazy (CONSTRAINTS #40) — the hook never boots or installs
// Phoenix just to emit check results; it reuses Phoenix only when it is
// already running (the trace sink usually started it during the run).
export function nonStartingPhoenixReadyProbe({
  repoRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
} = {}) {
  return async () => {
    const status = await phoenixStatus({ repoRoot, fetchImpl });
    return status.ok
      ? {
          ok: true,
          appUrl: status.appUrl,
          collectorUrl: status.collectorUrl,
          projectName: status.projectName,
        }
      : { ok: false, reason: status.status || "phoenix_not_running", repairHint: status.repairHint };
  };
}

// Best-effort post-terminal emission for the runner CLI. NEVER throws and is
// called only AFTER the wake is completed and the run outcome (status + exit
// code) is fixed, so a failure here can only produce a notice line — it can
// never alter the run outcome or add a blocking call to the live mutation
// path (CONSTRAINTS #27). The explicit `npm run eval:emit-checks -- <run_id>`
// command remains the primary, retryable emission path.
export async function emitDeterministicChecksBestEffort(options = {}) {
  try {
    if (!options.runId && !options.artifact) {
      return { attempted: false, ok: false, storage: "report_only", reason: "run_id_unresolved" };
    }
    const ensureReady = options.ensureReady
      || nonStartingPhoenixReadyProbe({ repoRoot: options.repoRoot, fetchImpl: options.fetchImpl });
    const result = await emitDeterministicCheckResults({
      ...options,
      ensureReady,
      requirePhoenixNative: false,
    });
    return { attempted: true, ...result };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      storage: "report_only",
      reason: `emission_failed:${error?.message ?? error}`,
    };
  }
}

// Human-readable report lines (also the fallback "record in report output"
// rendering reused by the CLI and the step-8 experiment wrapper).
export function formatDeterministicCheckReport(result) {
  const lines = [];
  lines.push(
    `deterministic checks for run ${result.run_id || "unknown"} (trace ${result.trace_id || "none"}${result.trace_status ? `, ${result.trace_status}` : ""}):`,
  );
  for (const check of result.checks || []) {
    if (check.status === "skipped") {
      const missing = check.missing_inputs?.length ? ` (missing: ${check.missing_inputs.join(", ")})` : "";
      lines.push(`  ${check.name} [skipped] ${check.skip_reason}${missing}`);
      continue;
    }
    const annotation = check.annotation;
    const modes = annotation.metadata?.failure_modes?.length
      ? ` failure_modes=${annotation.metadata.failure_modes.join(",")}`
      : "";
    const ids = check.annotation_ids?.length ? ` annotation_ids=${check.annotation_ids.join(",")}` : "";
    const error = check.error ? ` write_error=${check.error}` : "";
    lines.push(
      `  ${check.name} [${annotation.label} score=${annotation.score}] identifier=${annotation.identifier}${modes}${ids}${error}`,
    );
  }
  if (result.storage === "report_only") {
    lines.push(
      `storage: report_only (${result.reason || "phoenix_native_code_storage_unavailable"}) — results are recorded here only; Phoenix-native CODE storage did not happen and deterministic checks are never stored as HUMAN or LLM.`,
    );
  } else {
    lines.push(`storage: phoenix_native (${result.emitted_count} CODE annotation(s))`);
  }
  return lines;
}

// Shared openapi-shape helpers (also used by the step-8 experiment wrapper's
// experiments-REST capability preflight).
export function resolveSchemaRef(schema, spec, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > MAX_SCHEMA_RESOLUTION_DEPTH) return schema ?? null;
  if (typeof schema.$ref === "string") {
    const resolved = lookupRef(schema.$ref, spec);
    return resolveSchemaRef(resolved, spec, depth + 1);
  }
  return schema;
}

function lookupRef(ref, spec) {
  if (!ref.startsWith("#/")) return null;
  let cursor = spec;
  for (const part of ref.slice(2).split("/")) {
    cursor = cursor?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (cursor === undefined) return null;
  }
  return cursor;
}

export function collectEnumValues(schema, spec, depth = 0) {
  const resolved = resolveSchemaRef(schema, spec, depth);
  if (!resolved || typeof resolved !== "object" || depth > MAX_SCHEMA_RESOLUTION_DEPTH) return [];
  const values = [];
  if (Array.isArray(resolved.enum)) values.push(...resolved.enum);
  if (resolved.const !== undefined) values.push(resolved.const);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const child of resolved[key] || []) {
      values.push(...collectEnumValues(child, spec, depth + 1));
    }
  }
  return [...new Set(values)];
}

async function fetchWithTimeout(url, { fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...init }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
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
