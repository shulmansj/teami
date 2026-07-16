import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_ANNOTATION_NAME,
  QUALITY_LABELS,
  scoreWithinLabelBand,
} from "./eval-annotation-contract.mjs";
import {
  deriveRunEvalStatus,
  fetchPhoenixTraceAnnotations,
  normalizePhoenixAnnotation,
  phoenixDeepLink,
  resolveProjectGlobalId,
} from "./eval-status.mjs";
import { ensurePhoenixReady, resolvePhoenixConfig } from "./local-phoenix-manager.mjs";
import {
  detectSignalDisagreements,
  readExperimentReceipt,
  deriveExperimentReceiptState,
  selectDatasetExamples,
} from "./phoenix-experiment.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import {
  isInvalidTraceReceiptResult,
  readTraceReceipt,
} from "./trace-status-store.mjs";

// Step 9 (Track G): the disagreement report.
//
// Compares HUMAN annotations, LLM judge results, and deterministic CODE check
// results over the same run or the same experiment's examples while
// PRESERVING the raw records (labels, scores, rationales, failure modes, and
// Phoenix links). Disagreement state is a DERIVED, read-time view
// (CONSTRAINTS #3/#33): this module issues only HTTP GETs, writes nothing to
// Phoenix, writes nothing locally, and persists no queue state — rerun to
// recompute. There is deliberately no disagreement-resolution annotation
// primitive: the raw annotations/evaluations stay the primary evidence, and a
// downstream consumer (worklist, gate report, PR summary) records its own
// rationale where it uses the disagreement.
//
// ONE SOURCE OF TRUTH: the per-comparison logic is eval-status.mjs's
// deriveRunEvalStatus / detectAnnotationDisagreements — the exact functions
// the step 3 worklist derives from — so the worklist and this report can
// never disagree about what counts as a disagreement. Experiment mode
// additionally reuses step 8's detectSignalDisagreements for the
// label-signal summary so the experiment wrapper's summary stays consistent
// with this report. Human-vs-LLM compares labels and scores on the taste
// dimensions; CODE compares primarily on FAILURE MODES and is never forced
// onto the taste-score scale (binary CODE scores are excluded from the band
// checks below by design).

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const SAFE_RECEIPT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Quality label ordering for degradation checks: lower rank = worse outcome.
const LABEL_RANK = Object.fromEntries(
  [...QUALITY_LABELS].reverse().map((label, index) => [label, index]),
);

export function qualityLabelRank(label) {
  return LABEL_RANK[label] ?? null;
}

// ---------------------------------------------------------------------------
// Band-mismatch low-confidence check (Track A outside review obligation T2:
// score bands are documented, not schema-enforced, so the explicit
// band-mismatch check MUST run before any gate consumes HUMAN/LLM
// annotations). Band-mismatched annotations remain VALID evidence — they are
// flagged, never dropped. CODE deterministic checks are excluded on purpose:
// binary 0/1 structural scores are not on the taste-score scale.
// ---------------------------------------------------------------------------

export function detectBandMismatchedAnnotations(annotations = []) {
  const mismatches = [];
  for (const annotation of annotations) {
    if (annotation?.annotator_kind !== "HUMAN" && annotation?.annotator_kind !== "LLM") continue;
    if (!QUALITY_LABELS.includes(annotation.label)) continue;
    if (!Number.isFinite(annotation.score)) continue;
    if (scoreWithinLabelBand(annotation.label, annotation.score)) continue;
    mismatches.push({
      reason: "label_score_band_mismatch",
      name: annotation.name ?? null,
      annotator_kind: annotation.annotator_kind,
      identifier: annotation.identifier ?? "",
      label: annotation.label,
      score: annotation.score,
      still_valid_evidence: true,
    });
  }
  return mismatches;
}

// Human-labeled label degradation per D5 (workspace-eval-policy
// human_label_regression): the candidate's judge label ranks below ANY human
// label on the roll-up dimension for the same example.
export function detectHumanLabelDegradations(perExample = []) {
  const degradations = [];
  for (const entry of perExample) {
    const judgeLabel = entry.judge_label ?? null;
    if (!judgeLabel || qualityLabelRank(judgeLabel) === null) continue;
    for (const human of entry.human_labels || []) {
      if (qualityLabelRank(human.label) === null) continue;
      if (qualityLabelRank(judgeLabel) < qualityLabelRank(human.label)) {
        degradations.push({
          example_id: entry.example_id ?? entry.run_id ?? null,
          human_identifier: human.identifier ?? "",
          human_label: human.label,
          judge_label: judgeLabel,
        });
      }
    }
  }
  return degradations;
}

// ---------------------------------------------------------------------------
// GET-only fetch helper (read-only by construction: no method or body is ever
// supplied). Errors carry the HTTP status for callers that branch on 404.
// ---------------------------------------------------------------------------

async function phoenixGetJson({
  appUrl,
  pathname,
  searchParams = {},
  fetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
  const url = new URL(pathname, appUrl);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`phoenix_fetch_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([fetchImpl(url, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// Normalizes one experiment evaluation row (GET /v1/experiments/{id}/json
// annotations entry) into the SAME normalized annotation shape the
// trace-annotation paths use, so detectAnnotationDisagreements /
// deriveRunEvalStatus apply unchanged. The raw row is preserved by the
// caller alongside the normalized view.
export function normalizeExperimentEvaluation(row = {}) {
  return {
    name: row.name ?? null,
    annotator_kind: row.annotator_kind ?? null,
    identifier: row.metadata?.identifier ?? "",
    label: row.label ?? null,
    score: typeof row.score === "number" ? row.score : null,
    explanation: row.explanation ?? "",
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    error: row.error ?? null,
  };
}

function normalizeAffectedTeam(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return { key: value.trim(), name: value.trim() };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = value.key ?? value.team_key ?? value.id ?? value.name ?? null;
  const name = value.name ?? value.team_name ?? value.key ?? value.id ?? null;
  if (!key && !name) return null;
  return {
    ...(key ? { key: String(key).trim() } : {}),
    ...(name ? { name: String(name).trim() } : {}),
  };
}

function affectedTeamsForDatasetExample(datasetExample = {}) {
  const metadata = datasetExample?.metadata || {};
  const input = datasetExample?.input || {};
  const candidates = [];
  if (Array.isArray(metadata.affected_teams)) candidates.push(...metadata.affected_teams);
  if (Array.isArray(metadata.affected_team_keys)) candidates.push(...metadata.affected_team_keys);
  if (metadata.team_key || metadata.team_name) {
    candidates.push({ key: metadata.team_key, name: metadata.team_name });
  }
  if (input.project?.team) candidates.push(input.project.team);
  if (input.project?.team_key || input.project?.team_name) {
    candidates.push({ key: input.project.team_key, name: input.project.team_name });
  }
  const seen = new Set();
  const teams = [];
  for (const candidate of candidates) {
    const normalized = normalizeAffectedTeam(candidate);
    if (!normalized) continue;
    const key = `${normalized.key ?? ""}:${normalized.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    teams.push(normalized);
  }
  return teams;
}

function parseJudgeErrorState(error) {
  if (typeof error !== "string" || error === "") return null;
  if (error.startsWith("judge_missing")) return "judge_missing";
  if (error.startsWith("judge_invalid")) return "judge_invalid";
  return "evaluation_error";
}

function readJsonTolerant(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function judgeReceiptReadPath({ home, runId, runStoreDir = null }) {
  if (runStoreDir) return path.join(runStoreDir, `${runId}.judge.json`);
  const homeRoot = teamiHomePaths({ home }).home;
  const direct = path.join(homeRoot, "runs", `${runId}.judge.json`);
  if (fs.existsSync(direct)) return direct;
  const teamsDir = path.join(homeRoot, "teams");
  if (fs.existsSync(path.join(homeRoot, "teams.json.migration.lock")) || !fs.existsSync(teamsDir)) return direct;
  for (const teamRef of fs.readdirSync(teamsDir)) {
    const candidate = path.join(teamsDir, teamRef, "runs", `${runId}.judge.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return direct;
}

// ---------------------------------------------------------------------------
// Experiment evidence assembly (verified REST GET paths only). Shared by the
// disagreement report's experiment mode and the step 9 process-change gate so
// both read identical evidence.
// ---------------------------------------------------------------------------

export async function collectExperimentEvidence({
  appUrl,
  projectName,
  experimentId,
  datasetVersionId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (!experimentId) return { ok: false, reason: "missing_experiment_id" };

  // 1. Experiment identity (the resolver path; CONSTRAINTS #12).
  let experiment;
  try {
    const body = await phoenixGetJson({
      appUrl,
      pathname: `/v1/experiments/${encodeURIComponent(experimentId)}`,
      fetchImpl,
      timeoutMs,
    });
    experiment = body?.data || null;
  } catch (error) {
    return { ok: false, reason: "experiment_unresolvable", detail: error.message, experiment_id: experimentId };
  }
  if (!experiment?.id) return { ok: false, reason: "experiment_unresolvable", experiment_id: experimentId };

  // 2. Experiment run rows + evaluations (raw records preserved).
  let runRows;
  try {
    const body = await phoenixGetJson({
      appUrl,
      pathname: `/v1/experiments/${encodeURIComponent(experimentId)}/json`,
      fetchImpl,
      timeoutMs,
    });
    runRows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  } catch (error) {
    return { ok: false, reason: "experiment_runs_unresolvable", detail: error.message, experiment_id: experimentId };
  }

  // 3. Dataset example metadata for the experiment's dataset version
  // (split mirror, lifecycle, contract versions, source trace/run ids).
  let examplesById = new Map();
  let exampleFetchFailure = null;
  try {
    const selected = await selectDatasetExamples({
      appUrl,
      datasetId: experiment.dataset_id,
      datasetVersionId: datasetVersionId ?? experiment.dataset_version_id ?? null,
      split: null,
      fetchImpl,
    });
    if (selected.ok) {
      examplesById = new Map(selected.records.map((record) => [record?.id, record]));
    } else {
      exampleFetchFailure = selected.reason;
    }
  } catch (error) {
    exampleFetchFailure = error.message;
  }

  // 4. Optional project global id for deep links (tolerant: links degrade,
  // evidence does not).
  let projectGlobalId = null;
  try {
    projectGlobalId = await resolveProjectGlobalId({ appUrl, projectName, fetchImpl, timeoutMs });
  } catch {
    projectGlobalId = null;
  }
  const phoenix = { appUrl, projectName, projectGlobalId };

  // 5. Per-example assembly: candidate evaluations from the experiment rows,
  // HUMAN (and original-run LLM/CODE) annotations from the example's source
  // trace. Human reads that fail are DISCLOSED, never invented — the gate
  // treats them as "disagreements not actually checked".
  const perExample = [];
  const humanAnnotationFailures = [];
  for (const row of runRows) {
    const exampleId = row?.example_id ?? null;
    const datasetExample = examplesById.get(exampleId) || null;
    const metadata = datasetExample?.metadata || {};
    const evaluationsRaw = Array.isArray(row?.annotations) ? row.annotations : [];
    const evaluations = evaluationsRaw.map((entry) => normalizeExperimentEvaluation(entry));
    const llms = evaluations.filter(
      (entry) => entry.annotator_kind === "LLM" && entry.label !== null,
    );
    const codes = evaluations.filter(
      (entry) => entry.annotator_kind === "CODE" && entry.label !== null,
    );
    const judgeErrors = evaluations
      .filter((entry) => entry.annotator_kind === "LLM" && entry.error)
      .map((entry) => ({
        state: parseJudgeErrorState(entry.error),
        detail: entry.error,
        name: entry.name,
        identifier: entry.identifier,
      }));

    let humansRaw = [];
    let humanFetchFailed = false;
    const sourceTraceId = metadata.source_trace_id ?? null;
    const referencedHumanAnnotationIds = Array.isArray(metadata.reference?.human_annotation_ids)
      ? metadata.reference.human_annotation_ids.filter(Boolean)
      : [];
    if (sourceTraceId) {
      try {
        humansRaw = await fetchPhoenixTraceAnnotations({
          appUrl,
          projectName,
          traceId: sourceTraceId,
          fetchImpl,
        });
      } catch (error) {
        humanFetchFailed = true;
        humanAnnotationFailures.push({
          example_id: exampleId,
          source_trace_id: sourceTraceId,
          reason: "source_trace_annotations_unreadable",
          missing_annotation_ids: referencedHumanAnnotationIds,
          detail: error.message,
        });
        humansRaw = [];
      }
    }
    const sourceAnnotations = humansRaw.map((entry) => ({
      annotation_id: entry?.id ?? null,
      ...normalizePhoenixAnnotation(entry),
    }));
    const humans = sourceAnnotations.filter((entry) => entry.annotator_kind === "HUMAN");
    // Outside-review FIX 6: referenced-but-unresolved human annotation IDs are
    // FAILURES, never silent evidence. metadata.reference.human_annotation_ids
    // is an asserted pointer; only an actually-fetched HUMAN annotation counts.
    if (!humanFetchFailed && referencedHumanAnnotationIds.length > 0) {
      const resolvedHumanIds = new Set(
        humans.map((entry) => entry.annotation_id).filter(Boolean),
      );
      const unresolved = referencedHumanAnnotationIds.filter((id) => !resolvedHumanIds.has(id));
      if (unresolved.length > 0) {
        humanAnnotationFailures.push({
          example_id: exampleId,
          source_trace_id: sourceTraceId,
          reason: sourceTraceId
            ? "referenced_human_annotation_ids_unresolved"
            : "referenced_human_annotation_ids_without_source_trace",
          missing_annotation_ids: unresolved,
          detail: `metadata references human annotation id(s) ${unresolved.join(", ")} but no matching HUMAN annotation could be read${sourceTraceId ? ` from source trace ${sourceTraceId}` : " (no source_trace_id exists to read them from)"}.`,
        });
      }
    }

    // The SAME derivation the worklist uses (one source of truth): humans
    // from the source trace vs the candidate's LLM/CODE evaluations.
    const status = deriveRunEvalStatus({ annotations: [...humans, ...llms, ...codes] });
    const bandMismatches = detectBandMismatchedAnnotations([...humans, ...llms]);

    perExample.push({
      example_id: exampleId,
      example_resolved: datasetExample !== null,
      split: metadata.dataset_split ?? null,
      split_basis: "metadata_dataset_split_mirror",
      lifecycle_state: metadata.lifecycle_state ?? null,
      versions: {
        process_version: metadata.process_version ?? null,
        rubric_version: metadata.rubric_version ?? null,
        failure_taxonomy_version: metadata.failure_taxonomy_version ?? null,
      },
      project_category: metadata.project_category ?? null,
      affected_teams: affectedTeamsForDatasetExample(datasetExample),
      source_trace_id: sourceTraceId,
      source_run_id: metadata.source_run_id ?? null,
      // Human-labeled ONLY when at least one HUMAN annotation was actually
      // resolved (outside-review FIX 6): referenced-but-unread IDs are
      // human_annotation_failures, never phantom human evidence.
      human_labeled: humans.length > 0,
      referenced_human_annotation_ids: referencedHumanAnnotationIds,
      run_error: row?.error ?? null,
      eval_trace_id: row?.trace_id ?? null,
      // Raw records preserved (scores, rationales, failure modes).
      evaluations_raw: evaluationsRaw,
      source_annotations: sourceAnnotations,
      // Normalized comparison sets.
      humans,
      llms,
      codes,
      judge_label: llms.find((entry) => entry.name === DEFAULT_ANNOTATION_NAME)?.label ?? null,
      judge_score: llms.find((entry) => entry.name === DEFAULT_ANNOTATION_NAME)?.score ?? null,
      human_labels: humans
        .filter((entry) => entry.name === DEFAULT_ANNOTATION_NAME)
        .map((entry) => ({ identifier: entry.identifier, label: entry.label, score: entry.score })),
      judge_errors: judgeErrors,
      disagreements: status.disagreements,
      judge_flags: status.judge_flags,
      derived_status: status.derived_status,
      band_mismatches: bandMismatches,
      deep_links: {
        source_trace: sourceTraceId ? phoenixDeepLink({ phoenix: { appUrl, projectGlobalId }, traceId: sourceTraceId }) : null,
        eval_trace: row?.trace_id ? phoenixDeepLink({ phoenix: { appUrl, projectGlobalId }, traceId: row.trace_id }) : null,
      },
    });
  }

  return {
    ok: true,
    experiment: {
      id: experiment.id,
      dataset_id: experiment.dataset_id ?? null,
      dataset_version_id: experiment.dataset_version_id ?? null,
      project_name: experiment.project_name ?? null,
      metadata: experiment.metadata ?? {},
    },
    per_example: perExample,
    human_annotation_failures: humanAnnotationFailures,
    example_fetch_failure: exampleFetchFailure,
    phoenix: {
      ...phoenix,
      deep_links: {
        experiment: `${appUrl}/datasets/${experiment.dataset_id}/experiments/${experiment.id}`,
        dataset: `${appUrl}/datasets/${experiment.dataset_id}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// PR-summary-bound disagreement disclosure (shape only — the step 10
// controller consumes/extends it). Mirrors the proposal template's
// "Disagreement disclosure" section: raw records stay referenced, "none
// observed" is stated only after actually checking, and a proposal that
// proceeds despite material disagreement REQUIRES a controller rationale.
// ---------------------------------------------------------------------------

export const PR_DISAGREEMENT_DISCLOSURE_SCHEMA_VERSION =
  "teami-pr-disagreement-disclosure/v1";

export function buildPrDisagreementDisclosure({
  items = [],
  judgeAttention = [],
  bandMismatches = [],
  checked = true,
  checkedExampleCount = 0,
} = {}) {
  const materialCount = items.length + judgeAttention.length;
  return {
    schema_version: PR_DISAGREEMENT_DISCLOSURE_SCHEMA_VERSION,
    checked,
    checked_example_count: checkedExampleCount,
    disagreement_count: items.length,
    judge_attention_count: judgeAttention.length,
    band_mismatch_count: bandMismatches.length,
    items,
    judge_attention: judgeAttention,
    band_mismatches: bandMismatches,
    proceeds_despite_disagreement_requires_rationale: materialCount > 0,
    // Step 10 fills this when the controller proceeds despite disagreement;
    // the gate/report never invents a rationale.
    controller_rationale: null,
    none_observed_statement:
      checked && materialCount === 0 && bandMismatches.length === 0
        ? `none observed (checked ${checkedExampleCount} item(s) for human/model/code conflicts, judge failures, and band mismatches)`
        : null,
  };
}

// ---------------------------------------------------------------------------
// The disagreement report.
// ---------------------------------------------------------------------------

function worklistItemsFromStatus({ refId, status, judgeErrors = [], judgeAttempt = null }) {
  const items = [];
  for (const disagreement of status.disagreements || []) {
    items.push({ priority_id: "disagreement_open", ref: refId, ...disagreement });
  }
  for (const flag of status.judge_flags || []) {
    items.push({ priority_id: "judge_attention", ref: refId, kind: "low_confidence_judge_output", ...flag });
  }
  if (status.judge_missing) {
    items.push({ priority_id: "judge_attention", ref: refId, kind: "judge_missing", reason: "code results exist without a model-judge annotation" });
  }
  for (const error of judgeErrors) {
    items.push({ priority_id: "judge_attention", ref: refId, kind: error.state, reason: error.detail });
  }
  if (judgeAttempt && (judgeAttempt.judge_state === "judge_invalid" || judgeAttempt.judge_state === "judge_missing")) {
    items.push({
      priority_id: "judge_attention",
      ref: refId,
      kind: judgeAttempt.judge_state,
      reason: judgeAttempt.reason || `judge attempt ended ${judgeAttempt.judge_state}`,
    });
  }
  return items;
}

// Compares HUMAN, LLM, and CODE results for one run (trace annotations +
// local judge receipt) or one experiment (managed receipt or Phoenix
// experiment id). Derived states only; nothing is written anywhere.
export async function collectDisagreementReport({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  runId = null,
  experimentRef = null,
  receiptDir = null,
  runStoreDir = null,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  if ((runId && experimentRef) || (!runId && !experimentRef)) {
    return { ok: false, status: "not_run", reason: "invalid_input_selection" };
  }

  let ready;
  try {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  } catch (error) {
    return { ok: false, status: "not_run", reason: "local_phoenix_unavailable", detail: error.message };
  }
  if (!ready?.ok) {
    return { ok: false, status: "not_run", reason: "local_phoenix_unavailable", detail: ready?.reason || null };
  }
  const appUrl = ready.appUrl;
  const projectName = ready.projectName || resolvePhoenixConfig({ repoRoot }).projectName;

  if (runId) {
    const receipt = readTraceReceipt({ repoRoot, runId });
    if (isInvalidTraceReceiptResult(receipt)) {
      return {
        ok: false,
        status: "not_run",
        reason: receipt.reason,
        detail: `${receipt.detail}; re-run the source workflow to write a current team-identity trace receipt.`,
        run_id: runId,
        repairable: true,
        trace_receipt_path: receipt.path,
      };
    }
    if (!receipt?.trace_id) {
      return { ok: false, status: "not_run", reason: "missing_trace_receipt", run_id: runId };
    }
    let raw;
    try {
      raw = await fetchPhoenixTraceAnnotations({
        appUrl,
        projectName,
        traceId: receipt.trace_id,
        fetchImpl,
      });
    } catch (error) {
      return { ok: false, status: "not_run", reason: "annotations_unreadable", detail: error.message, run_id: runId };
    }
    const annotations = raw.map((entry) => ({
      annotation_id: entry?.id ?? null,
      ...normalizePhoenixAnnotation(entry),
    }));
    const status = deriveRunEvalStatus({ annotations });
    const bandMismatches = detectBandMismatchedAnnotations(annotations);
    const judgeReceipt = readJsonTolerant(judgeReceiptReadPath({ home, runId, runStoreDir }));
    const judgeAttempt = Array.isArray(judgeReceipt?.attempts) ? judgeReceipt.attempts.at(-1) : null;
    const worklist = worklistItemsFromStatus({ refId: runId, status, judgeAttempt });
    let projectGlobalId = null;
    try {
      projectGlobalId = await resolveProjectGlobalId({ appUrl, projectName, fetchImpl });
    } catch {
      projectGlobalId = null;
    }
    const prDisclosure = buildPrDisagreementDisclosure({
      items: status.disagreements.map((disagreement) => ({ ref: runId, ...disagreement })),
      judgeAttention: worklist.filter((item) => item.priority_id === "judge_attention"),
      bandMismatches,
      checked: true,
      checkedExampleCount: 1,
    });
    return {
      ok: true,
      mode: "run",
      run_id: runId,
      trace_id: receipt.trace_id,
      derived_status: status.derived_status,
      disagreements: status.disagreements,
      judge_flags: status.judge_flags,
      judge_missing: status.judge_missing,
      judge_attempt: judgeAttempt,
      band_mismatches: bandMismatches,
      worklist_items: worklist,
      // Raw records preserved: every annotation with label, score,
      // explanation, failure modes, and its Phoenix id.
      annotations,
      annotations_raw: raw,
      pr_disclosure: prDisclosure,
      phoenix: {
        appUrl,
        projectName,
        deep_link: phoenixDeepLink({ phoenix: { appUrl, projectGlobalId }, traceId: receipt.trace_id }),
      },
    };
  }

  // Experiment mode: resolve a managed receipt first (the primary join);
  // otherwise treat the ref as a Phoenix experiment id (discovered evidence —
  // still reportable, never auto-promoted).
  let receipt = null;
  let receiptState = null;
  let experimentId = experimentRef;
  if (SAFE_RECEIPT_ID_PATTERN.test(experimentRef)) {
    const read = readExperimentReceipt({ receiptId: experimentRef, repoRoot, home, receiptDir });
    if (!read.ok) return { ok: false, status: "not_run", reason: read.reason, path: read.path };
    if (read.exists) {
      receipt = read.receipt;
      receiptState = deriveExperimentReceiptState(receipt);
      experimentId = receiptState.phoenix_experiment_id;
      if (!experimentId) {
        return {
          ok: false,
          status: "not_run",
          reason: "receipt_has_no_phoenix_experiment",
          receipt_id: experimentRef,
        };
      }
    }
  }

  const evidence = await collectExperimentEvidence({
    appUrl,
    projectName,
    experimentId,
    datasetVersionId: receipt?.launch?.dataset?.dataset_version_id ?? null,
    fetchImpl,
  });
  if (!evidence.ok) return { ok: false, status: "not_run", ...evidence };

  const perExample = evidence.per_example;
  const disagreements = perExample.flatMap((entry) =>
    entry.disagreements.map((disagreement) => ({ example_id: entry.example_id, ...disagreement })));
  const judgeAttention = perExample.flatMap((entry) =>
    worklistItemsFromStatus({
      refId: entry.example_id,
      status: { disagreements: [], judge_flags: entry.judge_flags, judge_missing: false },
      judgeErrors: entry.judge_errors,
    }));
  const bandMismatches = perExample.flatMap((entry) =>
    entry.band_mismatches.map((mismatch) => ({ example_id: entry.example_id, ...mismatch })));
  const worklist = [
    ...disagreements.map((disagreement) => ({ priority_id: "disagreement_open", ref: disagreement.example_id, ...disagreement })),
    ...judgeAttention,
  ];
  // Step 8 summary parity: the experiment wrapper's label-signal view is the
  // same function, applied to the same labels.
  const signalSummary = detectSignalDisagreements(perExample.map((entry) => ({
    example_id: entry.example_id,
    human_label: entry.human_labels[0]?.label ?? null,
    judge: entry.judge_label ? { label: entry.judge_label } : null,
    code_label: entry.codes.some((code) => code.label && code.label !== "pass")
      ? "needs_revision"
      : entry.codes.length > 0
        ? "pass"
        : null,
  })));
  const checked = evidence.human_annotation_failures.length === 0;
  const prDisclosure = buildPrDisagreementDisclosure({
    items: disagreements,
    judgeAttention,
    bandMismatches,
    checked,
    checkedExampleCount: perExample.length,
  });

  return {
    ok: true,
    mode: "experiment",
    receipt_id: receipt ? receipt.receipt_id : null,
    receipt_state: receiptState,
    phoenix_experiment_id: evidence.experiment.id,
    dataset: {
      dataset_id: evidence.experiment.dataset_id,
      dataset_version_id: evidence.experiment.dataset_version_id,
      ...(receipt?.launch?.dataset?.name ? { name: receipt.launch.dataset.name } : {}),
    },
    per_example: perExample,
    disagreements,
    signal_summary: signalSummary,
    judge_attention: judgeAttention,
    band_mismatches: bandMismatches,
    worklist_items: worklist,
    human_annotation_failures: evidence.human_annotation_failures,
    example_fetch_failure: evidence.example_fetch_failure,
    checked,
    pr_disclosure: prDisclosure,
    phoenix: evidence.phoenix,
  };
}

// ---------------------------------------------------------------------------
// Report rendering (transient stdout only; nothing persisted anywhere).
// ---------------------------------------------------------------------------

function describeAnnotation(annotation) {
  const modes = Array.isArray(annotation.metadata?.failure_modes)
    ? annotation.metadata.failure_modes
    : [];
  const score = Number.isFinite(annotation.score) ? ` score=${annotation.score}` : "";
  const modeText = modes.length > 0 ? ` failure_modes=${modes.join(",")}` : "";
  const why = annotation.explanation ? ` — ${annotation.explanation}` : "";
  return `${annotation.annotator_kind} ${annotation.identifier || "?"}: ${annotation.label}${score}${modeText}${why}`;
}

export function formatDisagreementReport(report) {
  const lines = [];
  if (!report.ok) {
    lines.push(`FAIL disagreement report: ${report.reason}${report.detail ? ` (${report.detail})` : ""}`);
    return lines;
  }
  lines.push(
    "disagreement report (derived at read time from raw annotations/evaluations; never persisted, no Phoenix writes):",
  );
  if (report.mode === "run") {
    lines.push(`run ${report.run_id} trace ${report.trace_id} -> ${report.derived_status}`);
    lines.push(`  phoenix: ${report.phoenix.deep_link}`);
    for (const annotation of report.annotations) {
      lines.push(`  raw ${describeAnnotation(annotation)}${annotation.annotation_id ? ` [${annotation.annotation_id}]` : ""}`);
    }
    if (report.judge_attempt) {
      lines.push(`  judge attempt: ${report.judge_attempt.judge_state}${report.judge_attempt.reason ? ` (${report.judge_attempt.reason})` : ""}`);
    }
  } else {
    lines.push(
      `experiment ${report.phoenix_experiment_id}${report.receipt_id ? ` (receipt ${report.receipt_id})` : " (no managed receipt — discovered evidence, reported only)"}`,
    );
    lines.push(`  phoenix: ${report.phoenix.deep_links.experiment}`);
    for (const entry of report.per_example) {
      lines.push(`  example ${entry.example_id} [split=${entry.split || "?"}] -> ${entry.derived_status}`);
      for (const annotation of [...entry.humans, ...entry.llms, ...entry.codes]) {
        lines.push(`    raw ${describeAnnotation(annotation)}`);
      }
      for (const error of entry.judge_errors) {
        lines.push(`    judge error: ${error.state} (${error.detail})`);
      }
    }
    if (report.human_annotation_failures.length > 0) {
      lines.push(
        `  WARNING human annotations unreadable for ${report.human_annotation_failures.length} example(s); disagreements were NOT fully checked.`,
      );
    }
  }
  if (report.disagreements.length === 0) {
    lines.push(`  disagreements: ${report.pr_disclosure.none_observed_statement || "none detected among available signals"}`);
  } else {
    for (const disagreement of report.disagreements) {
      lines.push(
        disagreement.kind === "human_llm_label_conflict"
          ? `  DISAGREEMENT ${disagreement.example_id || report.run_id} ${disagreement.name}: human(${disagreement.human_identifier})=${disagreement.human_label} vs model(${disagreement.llm_identifier})=${disagreement.llm_label}`
          : `  DISAGREEMENT ${disagreement.example_id || report.run_id} ${disagreement.name}: code(${disagreement.code_identifier}) flagged ${disagreement.code_failure_modes.join(",")} but human(${disagreement.human_identifier}) passed`,
      );
    }
  }
  for (const mismatch of report.band_mismatches) {
    lines.push(
      `  BAND MISMATCH ${mismatch.example_id || report.run_id || ""} ${mismatch.annotator_kind} ${mismatch.identifier}: label ${mismatch.label} with score ${mismatch.score} is outside the documented band (still valid evidence; counted as low-confidence)`,
    );
  }
  const judgeItems = report.worklist_items.filter((item) => item.priority_id === "judge_attention");
  for (const item of judgeItems) {
    lines.push(`  JUDGE ATTENTION ${item.ref}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`);
  }
  lines.push(
    `  worklist items (derived only, recomputed each run): ${report.worklist_items.length}`,
  );
  lines.push(
    `  PR disclosure shape ready: rationale required if proceeding despite disagreement = ${report.pr_disclosure.proceeds_despite_disagreement_requires_rationale}`,
  );
  return lines;
}
