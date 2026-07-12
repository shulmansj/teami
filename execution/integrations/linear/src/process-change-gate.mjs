import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultEvalRunStoreDir, EVAL_RUN_RECORD_SCHEMA_VERSION } from "./decomposition-eval-cli.mjs";
import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "./promotion-target-keys.mjs";
import {
  buildPrDisagreementDisclosure,
  collectExperimentEvidence,
  detectHumanLabelDegradations,
} from "./disagreement-report.mjs";
import {
  DEFAULT_ANNOTATION_NAME,
  FAILURE_TAXONOMY_VERSION,
  PHOENIX_ASSETS_PATH,
  RUBRIC_VERSION,
} from "./eval-annotation-contract.mjs";
import { ensurePhoenixReady, resolvePhoenixConfig } from "./local-phoenix-manager.mjs";
import { PROCESS_VERSION } from "../../../engine/engine-contract-constants.mjs";
import {
  compareExperimentScoreMeans,
  computeEvaluationScoreMeans,
  computeEvidenceCounts,
  defaultExperimentReceiptDir,
  deriveExperimentReceiptState,
  readExperimentReceipt,
} from "./phoenix-experiment.mjs";
import { resolveAcceptedBaseline } from "./promotion-scanner/accepted-baseline.mjs";
import { renameWithRetry } from "../../../engine/run-store.mjs";
import {
  loadWorkspaceEvalPolicy,
  WORKSPACE_EVAL_POLICY_PATH,
} from "./workspace-eval-policy.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "./workflows/decomposition/eval-paths.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";

// Step 9 (Track G): the process-change gate.
//
// PURE EVALUATION LOGIC: this module evaluates whether a candidate change
// clears the gate and reports the result in product terms. It never mutates
// the repo, never creates branches or PRs, never writes to Phoenix, and never
// assigns the advisory `evidence_quality` / `promotion_risk` labels — those
// belong to the step 10 promotion controller (CONSTRAINTS #17/#18: the gate
// computes deterministic FACTS; scanner/gate plumbing is never the judge).
//
// Inputs: the managed experiment receipt (local custody), Phoenix experiment
// evidence resolved through verified REST GETs, the repo-owned workspace eval
// policy (D5 `human_label_regression` thresholds live there as data), and the
// repo-owned phoenix-assets manifest (baseline identity derives from the
// manifest, never from the receipt or caller input — CONSTRAINTS #35).
//
// FAIL-CLOSED rules (CONSTRAINTS #34): no evidence -> fail; no regression
// example or human-labeled subset for a reusable failure -> fail;
// human-labeled regression -> fail/pause with product-risk framing; missing
// test-split support -> fail closed AND reported as lowered evidence-quality
// context; missing Phoenix pins -> fail; cross-version comparison without
// explicit acceptance -> fail. Adversarial prose in annotations or rationales
// is DATA: no label, explanation, or judgment can waive a mechanical
// condition below.
//
// The gate report goes to stdout plus a local record under
// .teami/gate-reports/<id>.json (gitignored via .teami/,
// atomic write). It is NEVER written to Phoenix (CONSTRAINTS #3): the wipe
// test says gate outcomes are workflow state, and Phoenix loss must never
// lose them.

export const GATE_REPORT_SCHEMA_VERSION = "teami-process-change-gate-report/v1";

// Named gate conditions, in evaluation order (plan ~1683-1695: a process
// change should land only when all of these hold).
export const GATE_CONDITION_IDS = Object.freeze([
  "version_compatibility",
  "evidence_present",
  "tied_to_annotation_or_failure_mode",
  "reusable_failure_dataset_example",
  "human_labeled_subset_present",
  "test_split_evidence",
  "improves_target_scores",
  "no_human_labeled_regression",
  "disagreements_surfaced",
  "phoenix_pins_exact",
  "baseline_identity_current",
  "standalone_evidence_summary",
]);

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Local gate-report record store (.teami/gate-reports/; gitignored
// local custody; atomic temp+rename+read-back like the sibling stores).
// ---------------------------------------------------------------------------

export function defaultGateReportDir(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, "gate-reports");
}

function writeGateRecord(filePath, record) {
  const normalized = JSON.parse(JSON.stringify(record));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(tempPath, "utf8"));
  renameWithRetry(tempPath, filePath);
  return filePath;
}

function generateGateReportId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  return `gate-${stamp}-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// D5 regression thresholds: policy DATA from workspace-eval-policy.json, so
// the workspace owner changes them by editing the policy, not gate code.
// Missing/invalid thresholds fail closed — the gate never invents a default.
// ---------------------------------------------------------------------------

export function resolveHumanLabelRegressionPolicy(policy) {
  const section = policy?.human_label_regression;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, reason: "human_label_regression_policy_missing" };
  }
  if (typeof section.any_label_degradation_blocks !== "boolean") {
    return { ok: false, reason: "human_label_regression_policy_invalid", detail: "any_label_degradation_blocks must be a boolean" };
  }
  if (!Number.isFinite(section.max_mean_test_score_drop) || section.max_mean_test_score_drop < 0) {
    return { ok: false, reason: "human_label_regression_policy_invalid", detail: "max_mean_test_score_drop must be a non-negative number" };
  }
  return {
    ok: true,
    anyLabelDegradationBlocks: section.any_label_degradation_blocks,
    maxMeanTestScoreDrop: section.max_mean_test_score_drop,
  };
}

// ---------------------------------------------------------------------------
// Machine-local best-effort test-split exposure/selection history for a
// candidate target lineage. Derived ONLY from local receipts and eval-run
// records, so it is disclosed as `machine_local_best_effort` and never
// claimed complete (a second machine has its own ledger; local Phoenix loss
// erodes it). Prior exposure on the same target defaults the candidate to
// high_risk downstream (CONSTRAINTS #17) — recorded here as context for the
// step 10 controller, never as a label.
// ---------------------------------------------------------------------------

function listJsonFilesShallow(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function readJsonTolerant(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function computeTestSplitExposureHistory({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  candidateTargetKey,
  candidate = null,
  currentReceiptId = null,
  receiptDir = null,
  evalRunStoreDir = null,
} = {}) {
  const records = [];
  void repoRoot;
  const receiptsDir = receiptDir || defaultExperimentReceiptDir(home);
  for (const file of listJsonFilesShallow(receiptsDir)) {
    const receipt = readJsonTolerant(file);
    if (!receipt?.launch || receipt.launch.candidate_target_key !== candidateTargetKey) continue;
    const requested = receipt.launch.split?.requested ?? null;
    records.push({
      source: "experiment_receipt",
      receipt_id: receipt.receipt_id ?? path.basename(file, ".json"),
      launched_at: receipt.launch.launched_at ?? null,
      split_requested: requested,
      selection: receipt.launch.split?.selection ?? null,
      // Anything that is not an explicit train-only selection could have
      // exposed test-split examples (a null request runs all examples).
      test_split_exposed: requested !== "train",
    });
  }
  const evalRunsDir = evalRunStoreDir || defaultEvalRunStoreDir(home);
  for (const file of listJsonFilesShallow(evalRunsDir)) {
    const record = readJsonTolerant(file);
    if (record?.schema_version !== EVAL_RUN_RECORD_SCHEMA_VERSION) continue;
    if (record?.source?.mode !== "dataset") continue;
    const variant = record.variant || {};
    const matchesCandidate = candidate
      && (variant.id === candidate.variant_id
        || (candidate.judge_candidate_prompt_version_id
          && variant.judge_candidate_prompt_version_id
            === candidate.judge_candidate_prompt_version_id));
    if (!matchesCandidate) continue;
    records.push({
      source: "eval_run_record",
      eval_run_id: record.eval_run_id ?? path.basename(file, ".json"),
      created_at: record.created_at ?? null,
      dataset_name: record.source.dataset_name ?? null,
      example_id: record.source.example_id ?? null,
      // The local record does not know the example's split: possible
      // exposure, and "when unsure -> high_risk" (CONSTRAINTS #17).
      split_known: false,
    });
  }
  const definite = records.some(
    (record) => record.source === "experiment_receipt"
      && record.test_split_exposed
      && record.receipt_id !== currentReceiptId,
  );
  const possible = records.some((record) => record.source === "eval_run_record");
  return {
    disclosure: "machine_local_best_effort",
    history_complete: false,
    candidate_target_key: candidateTargetKey,
    current_receipt_id: currentReceiptId,
    records,
    prior_test_split_exposure: definite ? "definite" : possible ? "possible" : "none",
  };
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

function condition(id, status, detail, evidence = {}) {
  return { id, status, detail, evidence };
}

function entryVersionMismatches(entry) {
  const mismatches = [];
  if (entry.versions.process_version !== PROCESS_VERSION) {
    mismatches.push(`process_version ${entry.versions.process_version} != ${PROCESS_VERSION}`);
  }
  if (entry.versions.rubric_version !== RUBRIC_VERSION) {
    mismatches.push(`rubric_version ${entry.versions.rubric_version} != ${RUBRIC_VERSION}`);
  }
  if (entry.versions.failure_taxonomy_version !== FAILURE_TAXONOMY_VERSION) {
    mismatches.push(`failure_taxonomy_version ${entry.versions.failure_taxonomy_version} != ${FAILURE_TAXONOMY_VERSION}`);
  }
  return mismatches;
}

// Score means with the taste/structural separation intact: deterministic
// CODE checks are never folded into the taste roll-up mean (a CODE row named
// quality is excluded from that mean by annotator kind).
function meansEntries(entries) {
  return entries.map((entry) => ({
    evaluations: [...entry.llms, ...entry.codes]
      .filter((evaluation) =>
        !(evaluation.annotator_kind === "CODE" && evaluation.name === DEFAULT_ANNOTATION_NAME))
      .map((evaluation) => ({ name: evaluation.name, score: evaluation.score })),
  }));
}

function baselineMeansEntries(rows, includedIds) {
  const wanted = new Set(includedIds);
  return rows
    .filter((row) => wanted.has(row?.example_id))
    .map((row) => ({
      evaluations: (Array.isArray(row?.annotations) ? row.annotations : [])
        .filter((annotation) =>
          !(annotation?.annotator_kind === "CODE" && annotation?.name === DEFAULT_ANNOTATION_NAME))
        .map((annotation) => ({ name: annotation?.name, score: annotation?.score })),
    }));
}

function meanJudgeScore(entries) {
  const scores = entries
    .map((entry) => entry.judge_score)
    .filter((score) => Number.isFinite(score));
  if (scores.length === 0) return null;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function baselineMeanJudgeScore(rows, exampleIds) {
  const wanted = new Set(exampleIds);
  const scores = [];
  for (const row of rows) {
    if (!wanted.has(row?.example_id)) continue;
    for (const annotation of Array.isArray(row?.annotations) ? row.annotations : []) {
      if (annotation?.name !== DEFAULT_ANNOTATION_NAME) continue;
      if (annotation?.annotator_kind !== "LLM") continue;
      if (!Number.isFinite(annotation?.score)) continue;
      scores.push(annotation.score);
    }
  }
  if (scores.length === 0) return null;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function normalizeOrigin(origin) {
  return typeof origin === "string" ? origin.replace(/\/+$/, "") : origin;
}

function readPhoenixAssetsManifestForGate(repoRoot = process.cwd()) {
  const candidatePath = path.resolve(repoRoot, DECOMPOSITION_EVAL_PATHS.manifest);
  const manifestPath = fs.existsSync(candidatePath) ? candidatePath : PHOENIX_ASSETS_PATH;
  const bytes = fs.readFileSync(manifestPath);
  return {
    manifest: JSON.parse(bytes.toString("utf8")),
    manifestPath,
    manifestBytes: bytes,
  };
}

function deriveAcceptedArtifactBaselineFromManifest({ repoRoot = process.cwd(), candidateTargetKey } = {}) {
  if (!candidateTargetKey) {
    return { ok: false, reason: "candidate_target_key_missing" };
  }
  let manifestRead;
  try {
    manifestRead = readPhoenixAssetsManifestForGate(repoRoot);
  } catch (error) {
    return { ok: false, reason: "phoenix_assets_manifest_unavailable", detail: error.message };
  }
  const { manifest, manifestPath, manifestBytes } = manifestRead;
  const manifestRepoRoot = path.resolve(manifestPath, "..", "..", "..", "..");
  const resolution = resolveAcceptedBaseline({
    manifest,
    manifestBytes,
    candidateTargetKey,
    readArtifactBytes: (relativePath) => {
      try {
        return { ok: true, bytes: fs.readFileSync(path.join(manifestRepoRoot, relativePath)) };
      } catch (error) {
        const isPrompt = typeof candidateTargetKey === "string" && candidateTargetKey.startsWith("prompt/");
        return {
          ok: false,
          reason: isPrompt ? "accepted_prompt_snapshot_unreadable" : "accepted_artifact_unreadable",
          detail: error.message,
        };
      }
    },
  });
  if (resolution.reason === "accepted_prompt_target_unavailable") {
    return {
      ok: false,
      reason: "accepted_artifact_target_unavailable",
      detail: `phoenix-assets.json has no prompt artifact for ${candidateTargetKey}.`,
    };
  }
  if (!resolution.ok) return resolution;
  return {
    ok: true,
    manifest,
    accepted_artifact_hash_vector: resolution.accepted_artifact_hash_vector,
    accepted_artifact_kind: resolution.artifact_kind,
    accepted_artifact_path: resolution.snapshot_path ?? resolution.artifact_path ?? null,
    baseline: {
      derived_from: "phoenix_assets_manifest",
      manifest_path: path.relative(manifestRepoRoot, manifestPath).replaceAll("\\", "/"),
      manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      candidate_target_key: candidateTargetKey,
      ...(resolution.prompt_role ? { prompt_role: resolution.prompt_role } : {}),
      ...(resolution.prompt_role ? {} : { artifact_kind: resolution.artifact_kind }),
      accepted_baseline_id: resolution.accepted_baseline_id,
      accepted_dataset_version_ids: resolution.accepted_dataset_version_ids,
    },
  };
}

function baselineEntryMatchesDataset(entry, dataset = {}) {
  if (!entry) return false;
  if (entry.dataset_id && dataset.dataset_id && entry.dataset_id !== dataset.dataset_id) return false;
  if (entry.dataset_version_id && dataset.dataset_version_id && entry.dataset_version_id !== dataset.dataset_version_id) return false;
  if (entry.dataset_name && dataset.name && entry.dataset_name !== dataset.name) return false;
  return true;
}

function sameAcceptedArtifactHashVector(left, right) {
  if (!left || !right) return false;
  if (Object.hasOwn(left, "snapshot_sha256") || Object.hasOwn(right, "snapshot_sha256")) {
    return left.snapshot_sha256 === right.snapshot_sha256
      && (left.accepted_prompt_version_id ?? null) === (right.accepted_prompt_version_id ?? null);
  }
  if (Object.hasOwn(left, "accepted_state_sha256") || Object.hasOwn(right, "accepted_state_sha256")) {
    return left.accepted_state_sha256 === right.accepted_state_sha256;
  }
  if (Object.hasOwn(left, "manifest_sha256") || Object.hasOwn(right, "manifest_sha256")) {
    return left.manifest_sha256 === right.manifest_sha256;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function acceptedBaselineExperimentMissingDetail(candidateTargetKey) {
  return `no accepted baseline experiment is pinned for ${candidateTargetKey}; run a baseline experiment for this target and accept it into phoenix-assets.json experiments before promoting against it.`;
}

function hasTargetKeyedBaselineExperiment(manifest, candidateTargetKey) {
  return (manifest.experiments || []).some((entry) =>
    entry?.purpose === "baseline" && entry.candidate_target_key === candidateTargetKey);
}

function resolveBaselineExperimentForTarget({
  manifest,
  candidateTargetKey,
  dataset,
  currentHashVector,
  baselineExperimentOverride,
  acceptCrossVersion = false,
} = {}) {
  const usingOverride = baselineExperimentOverride !== undefined;
  const entry = usingOverride
    ? baselineExperimentOverride
    : (manifest.experiments || []).find((candidate) => {
        if (candidate?.purpose !== "baseline") return false;
        if (!baselineEntryMatchesDataset(candidate, dataset)) return false;
        if (candidate.candidate_target_key) return candidate.candidate_target_key === candidateTargetKey;
        return candidateTargetKey === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY;
      }) || null;
  if (!entry?.experiment_id) {
    if (!usingOverride
      && candidateTargetKey !== DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY
      && !hasTargetKeyedBaselineExperiment(manifest, candidateTargetKey)) {
      return {
        ok: false,
        reason: "accepted_baseline_experiment_missing",
        detail: acceptedBaselineExperimentMissingDetail(candidateTargetKey),
      };
    }
    return { ok: false, reason: "no_accepted_baseline_experiment_pinned" };
  }

  const legacyUntargeted = !entry.candidate_target_key;
  const hasVector = Boolean(entry.accepted_artifact_hash_vector);

  // Existing tests and harnesses may inject a bare baseline experiment object.
  // Production CLI/controller paths never expose this override.
  if (usingOverride && legacyUntargeted && !hasVector) {
    return { ok: true, entry, source: "override", baseline_hash_vector_unverified: false };
  }

  if (legacyUntargeted && candidateTargetKey !== DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY) {
    return { ok: false, reason: "no_accepted_baseline_experiment_pinned" };
  }

  if (!hasVector) {
    if (legacyUntargeted && candidateTargetKey === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY) {
      return { ok: true, entry, source: usingOverride ? "override" : "manifest", baseline_hash_vector_unverified: true };
    }
    return {
      ok: false,
      reason: "baseline_stale_for_accepted_artifact",
      detail: "baseline entry is missing accepted_artifact_hash_vector.",
    };
  }

  if (!sameAcceptedArtifactHashVector(entry.accepted_artifact_hash_vector, currentHashVector)) {
    if (!acceptCrossVersion) {
      return {
        ok: false,
        reason: "baseline_stale_for_accepted_artifact",
        detail: "baseline accepted_artifact_hash_vector does not match the current manifest entry.",
        baseline_hash_vector: entry.accepted_artifact_hash_vector,
        current_hash_vector: currentHashVector,
      };
    }
    return {
      ok: true,
      entry,
      source: usingOverride ? "override" : "manifest",
      baseline_cross_version_accepted: true,
      baseline_hash_vector: entry.accepted_artifact_hash_vector,
      current_hash_vector: currentHashVector,
    };
  }

  return {
    ok: true,
    entry,
    source: usingOverride ? "override" : "manifest",
    baseline_hash_vector: entry.accepted_artifact_hash_vector,
    current_hash_vector: currentHashVector,
  };
}

async function phoenixGetJson({ appUrl, pathname, fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS }) {
  const url = new URL(pathname, appUrl);
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

// Evaluates whether the candidate behind a managed experiment receipt clears
// the process-change gate. Read-only against Phoenix (REST GETs); the only
// write is the local gate-report record.
export async function evaluateProcessChangeGate({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  receiptId,
  receiptDir = null,
  evalRunStoreDir = null,
  gateReportDir = null,
  policyPath = undefined,
  acceptCrossVersion = false,
  baselineExperimentOverride = undefined,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  const gateReportId = generateGateReportId(now());
  const recordPathFor = () =>
    path.join(gateReportDir || defaultGateReportDir(home), `${gateReportId}.json`);

  const failClosed = (reason, extra = {}) => {
    const result = {
      ok: false,
      verdict: "fail",
      status: "failed_closed",
      reason,
      gate_report_id: gateReportId,
      receipt_id: receiptId ?? null,
      generated_at: now().toISOString(),
      fail_closed: true,
      ...extra,
    };
    try {
      result.record_path = writeGateRecord(recordPathFor(), {
        schema_version: GATE_REPORT_SCHEMA_VERSION,
        ...result,
      });
    } catch {
      result.record_path = null;
    }
    return result;
  };

  if (!receiptId || typeof receiptId !== "string") {
    return failClosed("missing_receipt_id", { detail: "--experiment <receipt_id> is required." });
  }

  // 1. Managed receipt (local custody). No receipt -> no evidence -> fail.
  let read;
  try {
    read = readExperimentReceipt({ receiptId, repoRoot, receiptDir });
  } catch (error) {
    return failClosed("invalid_receipt_id", { detail: error.message });
  }
  if (!read.ok) return failClosed(read.reason, { detail: read.path });
  if (!read.exists) {
    return failClosed("experiment_receipt_not_found", {
      detail: `${read.path} — no evidence exists for this candidate (fail closed, CONSTRAINTS #34).`,
    });
  }
  const receipt = read.receipt;
  const state = deriveExperimentReceiptState(receipt);
  if (state.state === "withdrawn") {
    return failClosed("receipt_withdrawn", {
      detail: "a withdrawn candidate cannot clear the gate; launch a new experiment for materially new evidence.",
    });
  }
  if (!state.phoenix_experiment_id) {
    return failClosed("missing_phoenix_experiment_pin", {
      detail: "the receipt pins no Phoenix experiment id; exact asset pins are required for any Phoenix evidence (CONSTRAINTS #34).",
    });
  }

  // 2. Repo-owned policy: D5 regression thresholds are policy data.
  let policy;
  try {
    policy = loadWorkspaceEvalPolicy(policyPath ? { policyPath } : {});
  } catch (error) {
    return failClosed("workspace_eval_policy_unavailable", { detail: error.message });
  }
  const regressionPolicy = resolveHumanLabelRegressionPolicy(policy);
  if (!regressionPolicy.ok) return failClosed(regressionPolicy.reason, { detail: regressionPolicy.detail });

  const candidateTargetKey = receipt.launch?.candidate_target_key ?? null;

  // 3. Baseline identity from the repo-owned manifest (CONSTRAINTS #35) —
  // now resolved per candidate target. Drift in the target's accepted artifact
  // fails closed before any Phoenix read.
  const baselineResolution = deriveAcceptedArtifactBaselineFromManifest({ repoRoot, candidateTargetKey });
  if (!baselineResolution.ok) return failClosed(baselineResolution.reason, { detail: baselineResolution.detail });
  const manifestBaseline = baselineResolution.baseline;
  const manifest = baselineResolution.manifest;
  const acceptedArtifactHashVector = baselineResolution.accepted_artifact_hash_vector;

  // 4. Phoenix readiness; origin/project come from local config, never from
  // the caller. The receipt's launch scope must match the local scope —
  // cross-scope evidence is refused (CONSTRAINTS #6/#12).
  let ready;
  try {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  } catch (error) {
    return failClosed("local_phoenix_unavailable", { detail: error.message });
  }
  if (!ready?.ok) return failClosed("local_phoenix_unavailable", { detail: ready?.reason || null });
  const appUrl = ready.appUrl;
  const projectName = ready.projectName || resolvePhoenixConfig({ repoRoot }).projectName;
  const launchScope = receipt.launch.phoenix_scope || {};
  if (
    normalizeOrigin(launchScope.origin) !== normalizeOrigin(appUrl)
    || (launchScope.project_name && launchScope.project_name !== projectName)
  ) {
    return failClosed("phoenix_scope_mismatch", {
      detail: `receipt scope ${launchScope.origin}/${launchScope.project_name} does not match the locally configured Phoenix ${appUrl}/${projectName}.`,
    });
  }

  // 5. Experiment evidence through the verified REST GET resolver path.
  const evidence = await collectExperimentEvidence({
    appUrl,
    projectName,
    experimentId: state.phoenix_experiment_id,
    datasetVersionId: receipt.launch.dataset?.dataset_version_id ?? null,
    fetchImpl,
  });
  if (!evidence.ok) return failClosed(evidence.reason, { detail: evidence.detail ?? null });
  if (evidence.experiment.dataset_id !== receipt.launch.dataset?.dataset_id) {
    return failClosed("receipt_phoenix_dataset_mismatch", {
      detail: `experiment ${evidence.experiment.id} belongs to dataset ${evidence.experiment.dataset_id}, not the receipt's ${receipt.launch.dataset?.dataset_id}.`,
    });
  }
  // Outside-review FIX 6: referenced human annotations that could not actually
  // be read are NEVER counted as human evidence — the gate fails closed with a
  // named reason instead of evaluating conditions over phantom labels
  // (CONSTRAINTS #34: absence/unreadability is never proof).
  if (evidence.human_annotation_failures.length > 0) {
    return failClosed("human_annotations_unresolvable", {
      detail: `${evidence.human_annotation_failures.length} example(s) reference human annotations that could not be read; the gate cannot verify the human-labeled subset or check disagreements, so it fails closed.`,
      human_annotation_failures: evidence.human_annotation_failures,
    });
  }

  // 6. Example partitioning: deprecated examples are excluded from default
  // gates (lifecycle rule); version-incompatible examples are excluded unless
  // the cross-version comparison is explicitly accepted, and their
  // relabel-needed state is DERIVED here at read time, never persisted.
  const allEntries = evidence.per_example;
  const deprecated = allEntries.filter((entry) => entry.lifecycle_state === "deprecated");
  const candidates = allEntries.filter((entry) => entry.lifecycle_state !== "deprecated");
  const incompatible = [];
  const included = [];
  for (const entry of candidates) {
    const mismatches = entry.example_resolved ? entryVersionMismatches(entry) : ["example_unresolvable"];
    if (mismatches.length > 0 && entry.example_resolved && acceptCrossVersion) {
      included.push({ ...entry, cross_version_accepted: true, version_mismatches: mismatches });
    } else if (mismatches.length > 0) {
      incompatible.push({
        example_id: entry.example_id,
        example_resolved: entry.example_resolved,
        version_mismatches: mismatches,
        relabel_needed: true,
        note: "derived at read time; never persisted (no needs_relabel flag exists anywhere)",
      });
    } else {
      included.push(entry);
    }
  }
  const includedIds = included.map((entry) => entry.example_id);
  const testEntries = included.filter((entry) => entry.split === "test");

  const conditions = [];

  // (version) compare examples only across compatible versions, or with an
  // explicitly accepted cross-version comparison.
  const versionIncompatibleUnresolved = incompatible.filter((entry) => entry.example_resolved !== false);
  if (versionIncompatibleUnresolved.length > 0 && included.length === 0 && !acceptCrossVersion) {
    conditions.push(condition(
      "version_compatibility",
      "fail",
      "cross_version_comparison_requires_explicit_acceptance: every example was judged against a different workflow/rubric/taxonomy version; comparing them requires explicit acceptance (--accept-cross-version) or relabeling.",
      { excluded: incompatible },
    ));
  } else {
    conditions.push(condition(
      "version_compatibility",
      "pass",
      acceptCrossVersion && included.some((entry) => entry.cross_version_accepted)
        ? "cross-version comparison explicitly accepted by the caller; mismatched examples are included and labeled."
        : versionIncompatibleUnresolved.length > 0
          ? `compared on the version-compatible subset only; ${versionIncompatibleUnresolved.length} example(s) excluded (cross_version_comparison_requires_explicit_acceptance to include them).`
          : "all compared examples carry the current workflow/rubric/taxonomy versions.",
      { excluded: incompatible, cross_version_accepted: acceptCrossVersion },
    ));
  }

  // (no evidence -> fail)
  const annotationCount = included.reduce(
    (total, entry) => total + entry.humans.length + entry.llms.length + entry.codes.length,
    0,
  );
  conditions.push(condition(
    "evidence_present",
    included.length > 0 && annotationCount > 0 ? "pass" : "fail",
    included.length === 0
      ? "no comparable examples remain after lifecycle/version exclusions — no evidence, fail closed."
      : annotationCount === 0
        ? "the experiment produced no annotations or evaluations on any comparable example — no evidence, fail closed."
        : `${included.length} comparable example(s) with ${annotationCount} raw annotation/evaluation record(s).`,
    { included_examples: includedIds, annotation_count: annotationCount },
  ));

  // (a) tied to at least one annotation or failure mode.
  const failureModes = new Set();
  for (const entry of included) {
    for (const record of [...entry.humans, ...entry.llms, ...entry.codes, ...entry.source_annotations]) {
      for (const mode of Array.isArray(record.metadata?.failure_modes) ? record.metadata.failure_modes : []) {
        failureModes.add(mode);
      }
    }
  }
  const tied = included.some((entry) => entry.humans.length > 0 || entry.llms.length > 0)
    || failureModes.size > 0;
  conditions.push(condition(
    "tied_to_annotation_or_failure_mode",
    tied ? "pass" : "fail",
    tied
      ? `tied to ${failureModes.size} distinct failure mode(s) and human/model annotations on the cited evidence.`
      : "the candidate is tied to no annotation and no failure mode — a process change needs a reason rooted in observed behavior.",
    { failure_modes: [...failureModes].sort() },
  ));

  // (b) at least one reusable failure became a dataset example.
  const failureExamples = included.filter((entry) =>
    entry.split === "regression"
    || entry.source_annotations.some((annotation) =>
      (annotation.label && annotation.label !== "pass")
      || (Array.isArray(annotation.metadata?.failure_modes) && annotation.metadata.failure_modes.length > 0)));
  conditions.push(condition(
    "reusable_failure_dataset_example",
    failureExamples.length > 0 ? "pass" : "fail",
    failureExamples.length > 0
      ? `${failureExamples.length} example(s) capture a reusable failure (regression split or recorded failure judgment).`
      : "no regression example exists for a reusable failure: nothing in the dataset captures the failure this change claims to fix (fail closed; promote a failing run first).",
    { failure_example_ids: failureExamples.map((entry) => entry.example_id) },
  ));

  // (no human-labeled subset -> fail)
  const humanLabeled = included.filter((entry) => entry.human_labeled);
  conditions.push(condition(
    "human_labeled_subset_present",
    humanLabeled.length > 0 ? "pass" : "fail",
    humanLabeled.length > 0
      ? `${humanLabeled.length} comparable example(s) carry human labels (asserted, MVP).`
      : "no human-labeled subset exists for this evidence: the gate cannot check local taste regression — annotate at least one example or defer the proposal (fail closed).",
    { human_labeled_example_ids: humanLabeled.map((entry) => entry.example_id) },
  ));

  // (missing test-split evidence -> fail closed + lowered evidence-quality
  // context, never proof)
  conditions.push(condition(
    "test_split_evidence",
    testEntries.length > 0 ? "pass" : "fail",
    testEntries.length > 0
      ? `${testEntries.length} held-out test example(s) support the generalization claim (split source: ${receipt.launch.split?.selection || "unknown"}; membership read from the metadata mirror).`
      : "no held-out test-split examples back this candidate; absence of test evidence is reported as lowered evidence-quality context and the gate fails closed rather than treating it as proof.",
    {
      test_example_ids: testEntries.map((entry) => entry.example_id),
      split_evidence_basis: receipt.launch.split?.selection ?? null,
      native_split_membership_verified: false,
    },
  ));

  // (c) the candidate improves target scores on relevant examples, and the
  // baseline identity is the repo-pinned baseline experiment.
  const baselineSelection = resolveBaselineExperimentForTarget({
    manifest,
    candidateTargetKey,
    dataset: receipt.launch.dataset,
    currentHashVector: acceptedArtifactHashVector,
    baselineExperimentOverride,
    acceptCrossVersion,
  });
  const baselineEntry = baselineSelection.ok ? baselineSelection.entry : null;
  let baselineRows = null;
  let scoreComparison = null;
  if (!baselineSelection.ok) {
    const baselineFailureDetail = baselineSelection.reason === "baseline_stale_for_accepted_artifact"
      ? `baseline_stale_for_accepted_artifact: ${baselineSelection.detail || "the pinned baseline was not run against the current accepted artifact"}; improvement cannot be trusted without rerunning or explicitly accepting cross-version comparison.`
      : baselineSelection.detail
        || `no accepted baseline experiment is pinned in phoenix-assets.json for target ${candidateTargetKey}; improvement cannot be demonstrated against an accepted baseline (fail closed).`;
    conditions.push(condition(
      "improves_target_scores",
      "fail",
      baselineFailureDetail,
      {
        reason: baselineSelection.reason,
        candidate_target_key: candidateTargetKey,
        ...(baselineSelection.detail ? { detail: baselineSelection.detail } : {}),
        ...(baselineSelection.baseline_hash_vector ? { baseline_hash_vector: baselineSelection.baseline_hash_vector } : {}),
        ...(baselineSelection.current_hash_vector ? { current_hash_vector: baselineSelection.current_hash_vector } : {}),
      },
    ));
  } else {
    try {
      const body = await phoenixGetJson({
        appUrl,
        pathname: `/v1/experiments/${encodeURIComponent(baselineEntry.experiment_id)}/json`,
        fetchImpl,
      });
      baselineRows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    } catch (error) {
      conditions.push(condition(
        "improves_target_scores",
        "fail",
        `baseline experiment ${baselineEntry.experiment_id} is unresolvable (${error.message}); fail closed.`,
        { baseline_experiment_id: baselineEntry.experiment_id },
      ));
    }
    if (baselineRows) {
      const currentMeans = computeEvaluationScoreMeans(meansEntries(included));
      const baselineMeans = computeEvaluationScoreMeans(
        baselineMeansEntries(baselineRows, includedIds),
      );
      scoreComparison = compareExperimentScoreMeans({ currentMeans, baselineMeans });
      const target = scoreComparison.deltas[DEFAULT_ANNOTATION_NAME];
      conditions.push(condition(
        "improves_target_scores",
        target && target.delta > 0 ? "pass" : "fail",
        target
          ? target.delta > 0
            ? `${DEFAULT_ANNOTATION_NAME} mean improved ${target.baseline.toFixed(3)} -> ${target.current.toFixed(3)} (+${target.delta.toFixed(3)}) on ${included.length} relevant example(s) vs baseline experiment ${baselineEntry.experiment_id}.`
            : `${DEFAULT_ANNOTATION_NAME} mean did not improve (${target.baseline.toFixed(3)} -> ${target.current.toFixed(3)}); a process change must demonstrate improvement on relevant examples.`
          : `the target score (${DEFAULT_ANNOTATION_NAME}) is not comparable against baseline experiment ${baselineEntry.experiment_id} on the included examples (fail closed).`,
        {
          baseline_experiment_id: baselineEntry.experiment_id,
          candidate_target_key: candidateTargetKey,
          baseline_hash_vector_unverified: Boolean(baselineSelection.baseline_hash_vector_unverified),
          baseline_cross_version_accepted: Boolean(baselineSelection.baseline_cross_version_accepted),
          deltas: scoreComparison.deltas,
          regressions: scoreComparison.regressions,
        },
      ));
    }
  }

  // (d) human-labeled examples do not regress beyond the accepted threshold
  // (D5, thresholds from the repo-owned policy).
  const degradations = detectHumanLabelDegradations(included);
  const currentTestMean = meanJudgeScore(testEntries);
  const baselineTestMean = baselineRows
    ? baselineMeanJudgeScore(baselineRows, testEntries.map((entry) => entry.example_id))
    : null;
  const meanDrop = currentTestMean !== null && baselineTestMean !== null
    ? baselineTestMean - currentTestMean
    : null;
  const labelClauseBlocks = regressionPolicy.anyLabelDegradationBlocks && degradations.length > 0;
  const meanClauseComputable = meanDrop !== null;
  const meanClauseBlocks = meanClauseComputable && meanDrop > regressionPolicy.maxMeanTestScoreDrop;
  let regressionStatus;
  let regressionDetail;
  if (labelClauseBlocks) {
    regressionStatus = "fail";
    regressionDetail =
      `human-labeled taste evidence REGRESSES: ${degradations.length} human-labeled example(s) degrade under the candidate (${degradations
        .map((item) => `${item.example_id}: human ${item.human_label} -> judge ${item.judge_label}`)
        .join("; ")}). Accepting this change would trade away judgments a human already made about this workspace's taste — reject or pause for human review with the regressing examples listed (product risk, fail closed).`;
  } else if (meanClauseBlocks) {
    regressionStatus = "fail";
    regressionDetail =
      `held-out test-split quality dropped ${meanDrop.toFixed(3)} (baseline ${baselineTestMean.toFixed(3)} -> candidate ${currentTestMean.toFixed(3)}), beyond the accepted threshold ${regressionPolicy.maxMeanTestScoreDrop} from workspace-eval-policy.json. The candidate looks better on tuning examples but worse where it must generalize — product risk, reject or pause for human review.`;
  } else if (!meanClauseComputable) {
    regressionStatus = "fail";
    regressionDetail =
      "the test-split mean comparison is not computable (missing test-split judge scores or missing baseline test evidence); the gate cannot prove non-regression and fails closed rather than treating absence as proof.";
  } else {
    regressionStatus = "pass";
    regressionDetail =
      `no human-labeled label degradation; test-split mean moved ${(-meanDrop).toFixed(3) >= 0 ? "+" : ""}${(-meanDrop).toFixed(3)} (threshold: drop <= ${regressionPolicy.maxMeanTestScoreDrop}).`;
  }
  conditions.push(condition("no_human_labeled_regression", regressionStatus, regressionDetail, {
    label_degradations: degradations,
    any_label_degradation_blocks: regressionPolicy.anyLabelDegradationBlocks,
    max_mean_test_score_drop: regressionPolicy.maxMeanTestScoreDrop,
    current_test_mean: currentTestMean,
    baseline_test_mean: baselineTestMean,
    mean_drop: meanDrop,
  }));

  // (e) material disagreements surfaced in the evidence summary. "None
  // observed" may only be stated after actually checking; unreadable human
  // annotations mean the check did NOT happen.
  const disagreements = included.flatMap((entry) =>
    entry.disagreements.map((disagreement) => ({ example_id: entry.example_id, ...disagreement })));
  const judgeAttention = included.flatMap((entry) => [
    ...entry.judge_flags.map((flag) => ({ example_id: entry.example_id, kind: "low_confidence_judge_output", ...flag })),
    ...entry.judge_errors.map((error) => ({ example_id: entry.example_id, kind: error.state, reason: error.detail })),
  ]);
  const bandMismatches = included.flatMap((entry) =>
    entry.band_mismatches.map((mismatch) => ({ example_id: entry.example_id, ...mismatch })));
  const disagreementsChecked = evidence.human_annotation_failures.length === 0;
  conditions.push(condition(
    "disagreements_surfaced",
    disagreementsChecked ? "pass" : "fail",
    disagreementsChecked
      ? `${disagreements.length} disagreement(s), ${judgeAttention.length} judge-attention item(s), and ${bandMismatches.length} band-mismatch flag(s) are surfaced in this evidence summary with raw records preserved.`
      : `human annotations were unreadable for ${evidence.human_annotation_failures.length} example(s); disagreements were NOT actually checked, so the gate fails closed instead of claiming "none observed".`,
    {
      disagreements,
      judge_attention: judgeAttention,
      band_mismatches: bandMismatches,
      human_annotation_failures: evidence.human_annotation_failures,
    },
  ));

  // (f) exact Phoenix asset IDs/versions pinned and resolvable for ALL
  // evidence used in the decision.
  const pinFailures = [];
  if (!receipt.launch.dataset?.dataset_id) pinFailures.push("dataset_id_unpinned");
  if (!receipt.launch.dataset?.dataset_version_id) pinFailures.push("dataset_version_id_unpinned");
  const unresolvableExamples = allEntries.filter((entry) => !entry.example_resolved);
  if (unresolvableExamples.length > 0) {
    pinFailures.push(
      `examples_unresolvable:${unresolvableExamples.map((entry) => entry.example_id).join(",")}`,
    );
  }
  if (evidence.example_fetch_failure) pinFailures.push(`example_fetch_failed:${evidence.example_fetch_failure}`);
  const candidatePromptVersionIds = [
    receipt.launch.candidate?.judge_candidate_prompt_version_id,
    ...Object.values(receipt.launch.candidate?.prompt_overrides || {})
      .map((override) => override?.candidate_prompt_version_id),
  ].filter((value, index, values) =>
    typeof value === "string" && value.trim() !== "" && values.indexOf(value) === index);
  for (const candidatePromptVersionId of candidatePromptVersionIds) {
    try {
      await phoenixGetJson({
        appUrl,
        pathname: `/v1/prompt_versions/${encodeURIComponent(candidatePromptVersionId)}`,
        fetchImpl,
      });
    } catch (error) {
      pinFailures.push(`candidate_prompt_version_unresolvable:${error.message}`);
    }
  }
  conditions.push(condition(
    "phoenix_pins_exact",
    pinFailures.length === 0 ? "pass" : "fail",
    pinFailures.length === 0
      ? "experiment, dataset, dataset version, examples, and candidate prompt version all carry exact, resolvable Phoenix pins."
      : `missing or unresolvable Phoenix pins: ${pinFailures.join("; ")} (fail closed).`,
    {
      experiment_id: evidence.experiment.id,
      dataset_id: receipt.launch.dataset?.dataset_id ?? null,
      dataset_version_id: receipt.launch.dataset?.dataset_version_id ?? null,
      candidate_prompt_version_id: candidatePromptVersionIds[0] ?? null,
      candidate_prompt_version_ids: candidatePromptVersionIds,
      failures: pinFailures,
    },
  ));

  // (baseline identity) the receipt's launch baseline must still be the
  // manifest-accepted baseline (stale receipt baselines block; CONSTRAINTS #35).
  const receiptBaselineId = receipt.launch.launch_baseline?.accepted_baseline_id ?? null;
  const baselineCurrent = receiptBaselineId === manifestBaseline.accepted_baseline_id;
  conditions.push(condition(
    "baseline_identity_current",
    baselineCurrent ? "pass" : "fail",
    baselineCurrent
      ? `launch baseline ${receiptBaselineId} matches the repo-owned manifest's accepted baseline for ${candidateTargetKey}.`
      : `STALE baseline: the receipt launched against ${receiptBaselineId} but the manifest now accepts ${manifestBaseline.accepted_baseline_id} for ${candidateTargetKey}; re-run the experiment against the current accepted baseline.`,
    {
      receipt_baseline_id: receiptBaselineId,
      manifest_baseline_id: manifestBaseline.accepted_baseline_id,
      candidate_target_key: candidateTargetKey,
      current_hash_vector: acceptedArtifactHashVector,
      baseline_hash_vector_unverified: Boolean(baselineSelection.baseline_hash_vector_unverified),
    },
  ));

  // 7. Evidence counts (contract block) + band-mismatch low-confidence count
  // (Track A review obligation), exposure history, and the product-terms
  // report. These are deterministic facts; evidence_quality / promotion_risk
  // labels are assigned by the step 10 controller, never here.
  const evidenceCounts = {
    ...computeEvidenceCounts(included.map((entry) => ({
      split: entry.split,
      human_labeled: entry.human_labeled,
    }))),
    annotations_low_confidence: bandMismatches.length,
  };
  const exposure = computeTestSplitExposureHistory({
    repoRoot,
    home,
    candidateTargetKey: receipt.launch.candidate_target_key,
    candidate: receipt.launch.candidate,
    currentReceiptId: receiptId,
    receiptDir,
    evalRunStoreDir,
  });
  const defaultsHighRisk = exposure.prior_test_split_exposure !== "none";

  const evidenceQualityContext = {
    note: "deterministic facts only; the promotion controller (step 10) assigns the evidence_quality and promotion_risk labels (CONSTRAINTS #17/#18)",
    human_labeled_test_examples: evidenceCounts.test_human_labeled_examples,
    human_labeled_train_examples: evidenceCounts.train_human_labeled_examples,
    annotations_low_confidence: bandMismatches.length,
    missing_test_split_evidence: testEntries.length === 0,
    split_evidence_basis: receipt.launch.split?.selection ?? null,
    split_disclosure: receipt.launch.split?.disclosure ?? null,
    native_split_membership_verified: false,
    version_incompatible_examples: incompatible.length,
    deprecated_examples_excluded: deprecated.length,
    human_annotation_read_failures: evidence.human_annotation_failures.length,
    test_split_exposure_history_complete: false,
    workspace_eval_policy_hash_matches_launch: (() => {
      try {
        const resolvedPolicyPath = policyPath || WORKSPACE_EVAL_POLICY_PATH;
        const currentHash = sha256OfFile(resolvedPolicyPath);
        return receipt.launch.workspace_eval_policy?.sha256 === currentHash;
      } catch {
        return null;
      }
    })(),
  };

  const improvedCondition = conditions.find((entry) => entry.id === "improves_target_scores");
  const productReport = {
    behavior_improved: improvedCondition?.status === "pass"
      ? [improvedCondition.detail]
      : ["no demonstrated improvement on the target quality dimension (see improves_target_scores)"],
    product_risk_remaining: [
      ...(degradations.length > 0
        ? [`human-labeled taste regressions on ${degradations.length} example(s)`] : []),
      ...(disagreements.length > 0
        ? [`${disagreements.length} open human/model/code disagreement(s) on the cited evidence`] : []),
      ...(judgeAttention.length > 0
        ? [`${judgeAttention.length} judge result(s) need attention (low confidence, invalid, or missing)`] : []),
      ...(bandMismatches.length > 0
        ? [`${bandMismatches.length} annotation(s) carry a label/score band mismatch (low-confidence evidence, still valid)`] : []),
      ...(testEntries.length === 0 ? ["no held-out test evidence: generalization is unproven"] : []),
      ...(evidenceCounts.test_human_labeled_examples === 0
        ? ["no human-labeled test examples: the proposal leans on model-judge judgment more than local human taste"] : []),
      ...(incompatible.length > 0
        ? [`${incompatible.length} example(s) excluded as version-incompatible (relabel before they count again)`] : []),
      ...(defaultsHighRisk
        ? ["prior test-split exposure on this candidate target lineage (defaults the candidate to high_risk downstream)"] : []),
    ],
    human_decision_load: {
      open_disagreements: disagreements.length,
      judge_attention_items: judgeAttention.length,
      band_mismatch_flags: bandMismatches.length,
      items_requiring_human_judgment:
        disagreements.length + judgeAttention.length + bandMismatches.length,
    },
    categories_tested: [...new Set(included.map((entry) => entry.project_category).filter(Boolean))].sort(),
    phoenix_assets_evidence: {
      experiment_id: evidence.experiment.id,
      baseline_experiment_id: baselineEntry?.experiment_id ?? null,
      baseline_hash_vector_unverified: Boolean(baselineSelection.baseline_hash_vector_unverified),
      baseline_cross_version_accepted: Boolean(baselineSelection.baseline_cross_version_accepted),
      dataset: {
        name: receipt.launch.dataset?.name ?? null,
        dataset_id: receipt.launch.dataset?.dataset_id ?? null,
        dataset_version_id: receipt.launch.dataset?.dataset_version_id ?? null,
      },
      candidate_prompt_version_id: candidatePromptVersionIds[0] ?? null,
      candidate_prompt_version_ids: candidatePromptVersionIds,
      annotation_ids: included.flatMap((entry) =>
        entry.source_annotations.map((annotation) => annotation.annotation_id).filter(Boolean)),
    },
    repo_artifacts_owning_accepted_behavior: {
      phoenix_assets_manifest: manifestBaseline.manifest_path,
      accepted_baseline_id: manifestBaseline.accepted_baseline_id,
      candidate_target_key: candidateTargetKey,
      accepted_artifact_hash_vector: acceptedArtifactHashVector,
      baseline_hash_vector_unverified: Boolean(baselineSelection.baseline_hash_vector_unverified),
      accepted_prompt_snapshot:
        baselineResolution.accepted_artifact_kind === "accepted_prompt"
          ? baselineResolution.accepted_artifact_path
          : null,
      workspace_eval_policy: path.basename(policyPath || WORKSPACE_EVAL_POLICY_PATH),
      rubric_version: RUBRIC_VERSION,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
      workflow_version: PROCESS_VERSION,
    },
  };

  const prDisclosure = buildPrDisagreementDisclosure({
    items: disagreements,
    judgeAttention,
    bandMismatches,
    checked: disagreementsChecked,
    checkedExampleCount: included.length,
  });
  const generatedAt = now().toISOString();
  const evidenceLineage = buildEvidenceLineage({
    receipt,
    generatedAt,
    included,
    deprecated,
    incompatible,
    evidence,
    baselineEntry,
    scoreComparison,
    degradations,
    currentTestMean,
    baselineTestMean,
    meanDrop,
  });

  // (g) the evidence summary must stand alone if Phoenix links die later.
  const standalone = Boolean(
    productReport.behavior_improved.length > 0
    && evidenceCounts
    && prDisclosure
    && productReport.repo_artifacts_owning_accepted_behavior.accepted_baseline_id,
  );
  conditions.push(condition(
    "standalone_evidence_summary",
    standalone ? "pass" : "fail",
    standalone
      ? "the gate report carries a standalone evidence summary (behavior, risk, decision load, counts, disagreement disclosure) that survives Phoenix loss."
      : "the evidence summary could not be fully assembled; a proposal must carry a standalone summary (fail closed).",
    {},
  ));

  const failedConditions = conditions.filter((entry) => entry.status === "fail");
  const verdict = failedConditions.length === 0 ? "pass" : "fail";

  const result = {
    ok: true,
    verdict,
    status: verdict === "pass" ? "gate_passed" : "gate_failed",
    gate_report_id: gateReportId,
    generated_at: generatedAt,
    receipt_id: receiptId,
    phoenix_experiment_id: evidence.experiment.id,
    candidate_target_key: receipt.launch.candidate_target_key,
    candidate_version_id: receipt.launch.candidate?.candidate_version_id ?? null,
    intent: state.intent,
    intent_source: state.intent_source,
    conditions,
    failed_condition_ids: failedConditions.map((entry) => entry.id),
    evidence_counts: evidenceCounts,
    band_mismatches: bandMismatches,
    disagreements,
    judge_attention: judgeAttention,
    excluded_examples: {
      deprecated: deprecated.map((entry) => entry.example_id),
      version_incompatible: incompatible,
    },
    score_comparison: scoreComparison,
    baseline_context: {
      accepted_baseline_id: manifestBaseline.accepted_baseline_id,
      accepted_artifact_hash_vector: acceptedArtifactHashVector,
      baseline_experiment_id: baselineEntry?.experiment_id ?? null,
      baseline_hash_vector_unverified: Boolean(baselineSelection.baseline_hash_vector_unverified),
      baseline_cross_version_accepted: Boolean(baselineSelection.baseline_cross_version_accepted),
    },
    test_split_exposure: exposure,
    defaults_high_risk: defaultsHighRisk,
    evidence_quality_context: evidenceQualityContext,
    evidence_lineage: evidenceLineage,
    product_report: productReport,
    pr_disclosure: prDisclosure,
    phoenix: evidence.phoenix,
  };
  try {
    result.record_path = writeGateRecord(recordPathFor(), {
      schema_version: GATE_REPORT_SCHEMA_VERSION,
      ...result,
    });
  } catch (error) {
    result.record_path = null;
    result.record_write_error = error.message;
  }
  return result;
}

function sha256OfFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildEvidenceLineage({
  receipt,
  generatedAt,
  included = [],
  deprecated = [],
  incompatible = [],
  evidence,
  baselineEntry,
  scoreComparison,
  degradations = [],
  currentTestMean = null,
  baselineTestMean = null,
  meanDrop = null,
} = {}) {
  const humanAnnotationIds = uniqueStrings(included.flatMap((entry) =>
    entry.source_annotations.map((annotation) => annotation.annotation_id).filter(Boolean)));
  const annotatorIdentifiers = uniqueStrings(included.flatMap((entry) =>
    [...entry.humans, ...entry.llms, ...entry.codes]
      .map((annotation) => annotation.identifier)
      .filter(Boolean)));
  const affectedTeams = uniqueTeams(included.flatMap((entry) => entry.affected_teams || []));
  const runSet = included.map((entry) => ({
    example_id: entry.example_id,
    split: entry.split,
    source_run_id: entry.source_run_id,
    source_trace_id: entry.source_trace_id,
    eval_trace_id: entry.eval_trace_id,
    human_annotation_ids: entry.source_annotations
      .map((annotation) => annotation.annotation_id)
      .filter(Boolean)
      .sort(),
    llm_labels: entry.llms.map((annotation) => annotation.label).filter(Boolean).sort(),
    code_labels: entry.codes.map((annotation) => annotation.label).filter(Boolean).sort(),
  }));
  return {
    schema_version: "teami-evidence-lineage/v1",
    run_window: {
      from: receipt?.launch?.launched_at ?? receipt?.created_at ?? null,
      to: generatedAt ?? null,
      basis: "experiment_receipt_launch_to_gate_generation",
    },
    run_set_digest: `sha256:${sha256StableJson({
      receipt_id: receipt?.receipt_id ?? null,
      phoenix_experiment_id: evidence?.experiment?.id ?? null,
      included: runSet,
    })}`,
    selection_rule: {
      split_requested: receipt?.launch?.split?.requested ?? null,
      split_selection: receipt?.launch?.split?.selection ?? null,
      inclusion: "non-deprecated, version-compatible examples unless cross-version comparison was explicitly accepted",
      included_example_ids: included.map((entry) => entry.example_id),
      excluded_deprecated_example_ids: deprecated.map((entry) => entry.example_id),
      excluded_version_incompatible_example_ids: incompatible.map((entry) => entry.example_id),
    },
    representative_traces: included.slice(0, 3).map((entry) => ({
      example_id: entry.example_id,
      split: entry.split,
      source_run_id: entry.source_run_id,
      source_trace_id: entry.source_trace_id,
      eval_trace_id: entry.eval_trace_id,
      phoenix_links: {
        source_trace: entry.deep_links?.source_trace ?? null,
        eval_trace: entry.deep_links?.eval_trace ?? null,
      },
    })),
    counterexamples_non_regressions: {
      human_label_degradations: degradations,
      score_regressions: scoreComparison?.regressions || [],
      baseline_test_mean: baselineTestMean,
      current_test_mean: currentTestMean,
      mean_drop: meanDrop,
      summary: degradations.length === 0 && (!scoreComparison?.regressions || scoreComparison.regressions.length === 0)
        ? "No human-labeled regression or score regression was detected in the included run set."
        : "Counterexamples or regressions are listed for owner review.",
    },
    annotation_provenance: {
      human_annotation_ids: humanAnnotationIds,
      llm_evaluation_count: included.reduce((total, entry) => total + entry.llms.length, 0),
      code_evaluation_count: included.reduce((total, entry) => total + entry.codes.length, 0),
      annotator_identifiers: annotatorIdentifiers,
    },
    affected_teams: affectedTeams,
    safe_phoenix_handles: {
      experiment_id: evidence?.experiment?.id ?? null,
      dataset_id: evidence?.experiment?.dataset_id ?? null,
      dataset_version_id: evidence?.experiment?.dataset_version_id ?? null,
      baseline_experiment_id: baselineEntry?.experiment_id ?? null,
    },
  };
}

function sha256StableJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function uniqueTeams(teams) {
  const seen = new Set();
  const normalized = [];
  for (const team of Array.isArray(teams) ? teams : []) {
    if (!team || typeof team !== "object" || Array.isArray(team)) continue;
    const key = String(team.key ?? team.id ?? team.name ?? "").trim();
    const name = String(team.name ?? team.key ?? team.id ?? "").trim();
    if (!key && !name) continue;
    const identity = `${key}:${name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
    });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Report rendering (product terms; stdout + the local record only).
// ---------------------------------------------------------------------------

export function formatProcessChangeGateReport(result) {
  const lines = [];
  if (!result.ok) {
    lines.push(`GATE FAIL (closed): ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    if (result.record_path) lines.push(`  record: ${result.record_path}`);
    lines.push("  the process-change gate fails closed: no evidence is treated as no, never as yes.");
    return lines;
  }
  lines.push(
    `process-change gate: ${result.verdict.toUpperCase()} for candidate ${result.candidate_target_key} (receipt ${result.receipt_id}, experiment ${result.phoenix_experiment_id})`,
  );
  lines.push(`  intent: ${result.intent} (${result.intent_source})`);
  for (const conditionEntry of result.conditions) {
    lines.push(`  [${conditionEntry.status === "pass" ? "PASS" : "FAIL"}] ${conditionEntry.id}: ${conditionEntry.detail}`);
  }
  const counts = result.evidence_counts;
  lines.push(
    `  evidence_counts: train ${counts.train_examples} (${counts.train_human_labeled_examples} human-labeled), test ${counts.test_examples} (${counts.test_human_labeled_examples} human-labeled), human_label_authenticity ${counts.human_label_authenticity}, annotations_low_confidence ${counts.annotations_low_confidence}`,
  );
  lines.push("  product report:");
  lines.push(`    behavior improved: ${result.product_report.behavior_improved.join("; ")}`);
  lines.push(
    `    product risk remaining: ${result.product_report.product_risk_remaining.length > 0 ? result.product_report.product_risk_remaining.join("; ") : "none surfaced by the deterministic checks"}`,
  );
  lines.push(
    `    human decision load: ${result.product_report.human_decision_load.items_requiring_human_judgment} item(s) need human judgment (${result.product_report.human_decision_load.open_disagreements} disagreement(s), ${result.product_report.human_decision_load.judge_attention_items} judge-attention, ${result.product_report.human_decision_load.band_mismatch_flags} band-mismatch)`,
  );
  lines.push(
    `    categories tested: ${result.product_report.categories_tested.join(", ") || "unknown"}`,
  );
  lines.push(
    `    Phoenix evidence: experiment ${result.product_report.phoenix_assets_evidence.experiment_id}, dataset ${result.product_report.phoenix_assets_evidence.dataset.dataset_id} v${result.product_report.phoenix_assets_evidence.dataset.dataset_version_id}${result.product_report.phoenix_assets_evidence.baseline_experiment_id ? `, baseline ${result.product_report.phoenix_assets_evidence.baseline_experiment_id}` : ""}`,
  );
  lines.push(
    `    accepted behavior owned by repo artifacts: ${result.product_report.repo_artifacts_owning_accepted_behavior.phoenix_assets_manifest} (baseline ${result.product_report.repo_artifacts_owning_accepted_behavior.accepted_baseline_id})`,
  );
  for (const mismatch of result.band_mismatches) {
    lines.push(
      `  BAND MISMATCH ${mismatch.example_id} ${mismatch.annotator_kind} ${mismatch.identifier}: ${mismatch.label} at score ${mismatch.score} (still valid evidence; counted in annotations_low_confidence)`,
    );
  }
  if (result.test_split_exposure.records.length > 0 || result.defaults_high_risk) {
    lines.push(
      `  test-split exposure (${result.test_split_exposure.disclosure}, history incomplete by design): prior exposure = ${result.test_split_exposure.prior_test_split_exposure}${result.defaults_high_risk ? " -> defaults_high_risk for step 10" : ""}`,
    );
  }
  lines.push(
    "  evidence_quality/promotion_risk labels are NOT assigned here: the gate reports deterministic facts; the promotion controller assigns the advisory labels.",
  );
  lines.push(`  record: ${result.record_path} (local only; never written to Phoenix)`);
  return lines;
}
