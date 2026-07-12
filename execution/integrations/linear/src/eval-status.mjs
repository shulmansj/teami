import fs from "node:fs";
import path from "node:path";

import {
  CANONICAL_ANNOTATION_NAMES,
} from "./eval-annotation-contract.mjs";
import { detectLowConfidenceReasons as detectLowConfidenceReasonsCore } from "../../../engine/eval-low-confidence.mjs";
import { resolvePhoenixConfig } from "./local-phoenix-manager.mjs";
import { normalizeFailureMode } from "./quality.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import { traceTelemetryPaths } from "./trace-status-store.mjs";

// Derived eval status + agent-session judgment worklist.
//
// The statuses computed here (needs_human | has_human | disagreement_open) are
// a DERIVED, read-time view (CONSTRAINTS #3, #33): they are recomputed on
// every invocation from local trace receipts (.agent-shell/telemetry/runs/),
// local run artifacts (.teami/runs/), Phoenix annotations read via
// the verified REST GET paths, and local dataset-membership receipts when
// present. Nothing here is ever persisted: no Phoenix writes, no Linear
// access, no local queue/worklist files. This module is read-only by
// construction — it issues only HTTP GETs and only reads local files.
// It also never calls ensurePhoenixReady: Phoenix stays lazy and is never
// started just to answer a status question; an unreachable Phoenix degrades
// the report with an explicit notice instead.

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const ANNOTATION_PAGE_LIMIT = 1_000;
const MAX_ANNOTATION_PAGES = 10;

// Plan-pinned priority order (plan "Agent-Session Judgment Worklist"):
// 1. runs in areas with low relevant human grounding
// 2. high-risk runs (product promise, trust, scope, workflow-policy changes)
// 3. model/human or code/human disagreements
// 4. low-confidence, malformed, or missing judge output
// 5. new project categories / novel decomposition patterns
// 6. passing examples needed to show the judge what good looks like
export const EVAL_WORKLIST_PRIORITY_ORDER = Object.freeze([
  "low_human_grounding",
  "high_risk",
  "disagreement_open",
  "judge_attention",
  "new_category",
  "calibration_pass_example",
  "other_needs_judgment",
]);

export function isHighRiskRunArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  // Paused runs surfaced product/taste/scope questions for a human; treat the
  // run as high-risk for judgment purposes.
  if (artifact.kind === "pause") return true;
  const packets = Array.isArray(artifact.phase_packets) ? artifact.phase_packets : [];
  return packets.some((packet) =>
    packet?.status === "pause"
    || (typeof packet?.open_questions_markdown === "string"
      && packet.open_questions_markdown.trim() !== ""));
}

// Reads the local, gitignored run evidence (receipts + artifacts + sibling
// snapshot/promotion files). Tolerant of unparseable files: a corrupt local
// file is skipped, never fatal for a status report.
export function readLocalEvalInputs({ repoRoot = process.cwd(), home = resolveTeamiHome(), runStoreDir = null } = {}) {
  const receiptsDir = traceTelemetryPaths(repoRoot).runsDir;
  const artifactsDirs = runStoreDir ? [runStoreDir] : domainRunStoreDirs(home);
  const artifactsDir = artifactsDirs[0] || null;
  const runs = new Map();
  const ensureRun = (runId) => {
    if (!runs.has(runId)) {
      runs.set(runId, {
        run_id: runId,
        trace_id: null,
        project_id: null,
        observed_at: null,
        trace_status: null,
        artifact_kind: null,
        high_risk: false,
        snapshot_present: false,
        promoted_to_dataset: false,
        promoted_datasets: [],
        judge_attempt: null,
      });
    }
    return runs.get(runId);
  };

  for (const file of listJsonFilesShallow(receiptsDir)) {
    const receipt = readJsonTolerant(file);
    if (!receipt?.run_id) continue;
    // Preflight receipts are synthetic connectivity probes, not judgment targets.
    if (String(receipt.run_id).startsWith("phoenix-preflight")) continue;
    const run = ensureRun(String(receipt.run_id));
    run.trace_id = receipt.trace_id || null;
    run.project_id = receipt.project_id || run.project_id;
    run.observed_at = receipt.observed_at || null;
    run.trace_status = receipt.trace_status || null;
  }

  for (const currentArtifactsDir of artifactsDirs) {
    for (const file of listJsonFilesShallow(currentArtifactsDir)) {
      const base = path.basename(file);
      // Sibling local files share the run store directory but are not run artifacts.
      if (base.endsWith(".snapshot.json") || base.endsWith(".promotion.json") || base.endsWith(".judge.json")) continue;
      const artifact = readJsonTolerant(file);
      if (!artifact?.run_id) continue;
      const run = ensureRun(String(artifact.run_id));
      run.artifact_kind = artifact.kind || null;
      run.high_risk = isHighRiskRunArtifact(artifact);
      if (!run.project_id) run.project_id = artifact.project_id || artifact.object_id || null;
    }
  }

  for (const run of runs.values()) {
    run.snapshot_present = artifactsDirs.some((dir) =>
      fs.existsSync(path.join(dir, `${run.run_id}.snapshot.json`)));
    // Local dataset-membership receipt (written by promotion steps when they
    // exist; read-only here). Tolerated shape: { datasets: [{ name, ... }] }.
    const membership = readRunSidecarJson(artifactsDirs, run.run_id, ".promotion.json");
    const datasets = Array.isArray(membership?.datasets) ? membership.datasets : [];
    run.promoted_to_dataset = datasets.length > 0;
    run.promoted_datasets = datasets.map((dataset) => dataset?.name).filter(Boolean);
    // Local judge-attempt receipt (written by the judge wrapper; read-only
    // here). The latest attempt makes judge_missing / judge_invalid visible
    // to the derived worklist even when no annotation could be written —
    // still a read-time view, never Phoenix state.
    const judgeReceipt = readRunSidecarJson(artifactsDirs, run.run_id, ".judge.json");
    const attempts = Array.isArray(judgeReceipt?.attempts) ? judgeReceipt.attempts : [];
    const latestAttempt = attempts.at(-1) || null;
    run.judge_attempt = latestAttempt
      ? {
          judge_state: latestAttempt.judge_state ?? null,
          identifier: latestAttempt.identifier ?? null,
          attempted_at: latestAttempt.attempted_at ?? null,
          reason: latestAttempt.reason ?? null,
          low_confidence_reasons: Array.isArray(latestAttempt.low_confidence_reasons)
            ? latestAttempt.low_confidence_reasons
            : [],
        }
      : null;
  }

  return {
    receiptsDir,
    artifactsDir,
    artifactsDirs,
    runs: [...runs.values()].sort((a, b) => a.run_id.localeCompare(b.run_id)),
  };
}

function domainRunStoreDirs(home) {
  const domainsDir = path.join(teamiHomePaths({ home }).home, "domains");
  if (!fs.existsSync(domainsDir)) return [];
  try {
    return fs.readdirSync(domainsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(domainsDir, entry.name, "runs"));
  } catch {
    return [];
  }
}

function readRunSidecarJson(dirs, runId, suffix) {
  for (const dir of dirs) {
    const parsed = readJsonTolerant(path.join(dir, `${runId}${suffix}`));
    if (parsed) return parsed;
  }
  return null;
}

// Verified REST GET path (PHOENIX-CAPABILITIES annotations CRUD):
// GET /v1/projects/{project}/trace_annotations?trace_ids=...&limit=... with
// cursor pagination. Read-only by construction (no method/body is ever set).
export async function fetchPhoenixTraceAnnotations({
  appUrl,
  projectName,
  traceId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const annotations = [];
  let cursor = null;
  for (let page = 0; page < MAX_ANNOTATION_PAGES; page += 1) {
    const url = new URL(`/v1/projects/${encodeURIComponent(projectName)}/trace_annotations`, appUrl);
    url.searchParams.set("trace_ids", traceId);
    url.searchParams.set("limit", String(ANNOTATION_PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchWithTimeout(url, { fetchImpl, timeoutMs });
    if (response.status === 404) return annotations;
    if (!response.ok) throw new Error(`phoenix_http_${response.status}`);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    annotations.push(...(body.data || []));
    cursor = body.next_cursor || null;
    if (!cursor) break;
  }
  return annotations;
}

export function normalizePhoenixAnnotation(entry = {}) {
  return {
    name: entry.name ?? null,
    annotator_kind: entry.annotator_kind ?? null,
    identifier: entry.identifier ?? "",
    label: entry.result?.label ?? null,
    score: entry.result?.score ?? null,
    explanation: entry.result?.explanation ?? "",
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
  };
}

export const detectLowConfidenceReasons = detectLowConfidenceReasonsCore;

// The ONE canonical disagreement detector (CONSTRAINTS #33: derived views
// only). Step 3's worklist, the step 9 disagreement report, and the step 9
// process-change gate all call THIS function so they can never drift apart.
// Human-vs-LLM compares quality labels (taste dimensions); CODE-vs-HUMAN
// compares primarily on failure modes — deterministic checks are never forced
// onto the taste-score scale.
export function detectAnnotationDisagreements({ humans = [], llms = [], codes = [] } = {}) {
  const disagreements = [];
  for (const human of humans) {
    for (const llm of llms) {
      if (llm.name === human.name && llm.label && human.label && llm.label !== human.label) {
        disagreements.push({
          kind: "human_llm_label_conflict",
          name: human.name,
          human_identifier: human.identifier,
          llm_identifier: llm.identifier,
          human_label: human.label,
          llm_label: llm.label,
        });
      }
    }
    const humanModes = new Set(
      (Array.isArray(human.metadata?.failure_modes) ? human.metadata.failure_modes : [])
        .map(normalizeFailureMode),
    );
    for (const code of codes) {
      const codeModes = [...new Set(
        (Array.isArray(code.metadata?.failure_modes) ? code.metadata.failure_modes : [])
          .map(normalizeFailureMode),
      )];
      if (codeModes.length === 0) continue;
      const overlap = codeModes.some((mode) => humanModes.has(mode));
      if (human.label === "pass" && !overlap) {
        disagreements.push({
          kind: "code_human_failure_mode_conflict",
          name: code.name,
          code_identifier: code.identifier,
          human_identifier: human.identifier,
          code_failure_modes: codeModes,
        });
      }
    }
  }
  return disagreements;
}

// Derives needs_human | has_human | disagreement_open from raw annotation
// records. Disagreement state is computed, never stored: there is no separate
// disagreement-resolution primitive (CONSTRAINTS #33).
// CODE-vs-HUMAN comparison is primarily on failure modes (the plan forbids
// forcing deterministic checks onto the taste-score scale).
export function deriveRunEvalStatus({ annotations = [] } = {}) {
  const canonical = annotations.filter((annotation) =>
    CANONICAL_ANNOTATION_NAMES.includes(annotation.name));
  const humans = canonical.filter((annotation) => annotation.annotator_kind === "HUMAN");
  const llms = canonical.filter((annotation) => annotation.annotator_kind === "LLM");
  const codes = canonical.filter((annotation) => annotation.annotator_kind === "CODE");

  const disagreements = detectAnnotationDisagreements({ humans, llms, codes });

  const judgeFlags = llms.flatMap((llm) =>
    detectLowConfidenceReasons({
      annotation: llm,
      codeAnnotations: codes,
      humanAnnotations: humans,
    }).map((reason) => ({ identifier: llm.identifier, reason })));
  // "Missing judge output" means the deterministic eval pipeline ran (CODE
  // results exist) but no model-judge annotation landed. Runs with no
  // annotations at all are simply needs_human, and human-only runs are not
  // penalized for a judge that was never invoked.
  const judgeMissing = llms.length === 0 && codes.length > 0;
  const hasHuman = humans.length > 0;
  const disagreementOpen = disagreements.length > 0;

  return {
    derived_status: disagreementOpen ? "disagreement_open" : hasHuman ? "has_human" : "needs_human",
    has_human: hasHuman,
    has_llm: llms.length > 0,
    has_code: codes.length > 0,
    disagreements,
    judge_flags: judgeFlags,
    judge_missing: judgeMissing,
    all_signals_pass: canonical.length > 0
      && canonical.every((annotation) => annotation.label === "pass"),
  };
}

function degradedRunEvalStatus() {
  return {
    derived_status: "needs_human",
    has_human: null,
    has_llm: null,
    has_code: null,
    disagreements: [],
    judge_flags: [],
    judge_missing: false,
    all_signals_pass: false,
  };
}

export async function resolveProjectGlobalId({ appUrl, projectName, fetchImpl, timeoutMs } = {}) {
  const url = new URL("/v1/projects", appUrl);
  url.searchParams.set("name", projectName);
  url.searchParams.set("limit", "50");
  const response = await fetchWithTimeout(url, { fetchImpl, timeoutMs });
  if (!response.ok) throw new Error(`phoenix_http_${response.status}`);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  const project = (body.data || []).find((entry) => entry?.name === projectName);
  return project?.id ?? null;
}

// Collects per-run derived eval status. Deep-link origin comes from local
// Phoenix config (resolvePhoenixConfig), never from caller input.
export async function collectEvalStatuses({
  repoRoot = process.cwd(),
  runStoreDir = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const phoenixConfig = resolvePhoenixConfig({ repoRoot, env });
  const local = readLocalEvalInputs({ repoRoot, runStoreDir });
  const phoenix = {
    ok: false,
    appUrl: phoenixConfig.appUrl,
    projectName: phoenixConfig.projectName,
    projectGlobalId: null,
    notice: null,
  };
  const annotationsByTrace = new Map();
  try {
    phoenix.projectGlobalId = await resolveProjectGlobalId({
      appUrl: phoenixConfig.appUrl,
      projectName: phoenixConfig.projectName,
      fetchImpl,
    });
    for (const run of local.runs) {
      if (!run.trace_id) continue;
      const raw = await fetchPhoenixTraceAnnotations({
        appUrl: phoenixConfig.appUrl,
        projectName: phoenixConfig.projectName,
        traceId: run.trace_id,
        fetchImpl,
      });
      annotationsByTrace.set(run.trace_id, raw.map(normalizePhoenixAnnotation));
    }
    phoenix.ok = true;
  } catch (error) {
    phoenix.ok = false;
    annotationsByTrace.clear();
    phoenix.notice = `Phoenix is unreachable at ${phoenixConfig.appUrl} (${error.message}). `
      + "Annotation-derived statuses are unknown; reporting local receipt/artifact state only. "
      + "Start it with npm run phoenix:start and rerun.";
  }

  const runs = local.runs.map((run) => {
    const annotations = annotationsByTrace.get(run.trace_id) || [];
    const status = phoenix.ok ? deriveRunEvalStatus({ annotations }) : degradedRunEvalStatus();
    return {
      ...run,
      ...status,
      annotation_visibility: phoenix.ok ? "phoenix" : "unknown_phoenix_unreachable",
      phoenix_url: phoenixDeepLink({ phoenix, traceId: run.trace_id }),
    };
  });

  return { phoenix, runs, receiptsDir: local.receiptsDir, artifactsDir: local.artifactsDir };
}

export function phoenixDeepLink({ phoenix, traceId }) {
  if (phoenix?.projectGlobalId && traceId) {
    return `${phoenix.appUrl}/projects/${phoenix.projectGlobalId}/traces/${traceId}`;
  }
  return `${phoenix?.appUrl || ""}/projects`;
}

// A judge attempt that produced no usable judgment (timeout/provider failure
// or malformed output) needs attention even when Phoenix has no LLM
// annotation to derive flags from.
function judgeAttemptNeedsAttention(run) {
  return run.judge_attempt?.judge_state === "judge_invalid"
    || run.judge_attempt?.judge_state === "judge_missing";
}

function isWorklistMember(run) {
  return run.derived_status === "needs_human"
    || run.derived_status === "disagreement_open"
    || run.judge_flags.length > 0
    || run.judge_missing
    || judgeAttemptNeedsAttention(run);
}

// Assigns the highest-priority (lowest-numbered) matching class per the
// plan's priority order. "Area" is the run's Linear project: a repeated area
// with zero human-labeled runs is low grounding; a first-of-its-kind area is
// a new category.
export function classifyWorklistPriority({ run, runs }) {
  const sameArea = runs.filter((other) =>
    other.project_id && run.project_id && other.project_id === run.project_id);
  const areaHasOtherRuns = sameArea.some((other) => other.run_id !== run.run_id);
  const areaHasHumanGrounding = sameArea.some((other) => other.has_human === true);

  if (run.derived_status === "needs_human" && areaHasOtherRuns && !areaHasHumanGrounding) {
    return "low_human_grounding";
  }
  if (run.high_risk) return "high_risk";
  if (run.disagreements.length > 0) return "disagreement_open";
  if (run.judge_flags.length > 0 || run.judge_missing || judgeAttemptNeedsAttention(run)) {
    return "judge_attention";
  }
  if (!areaHasOtherRuns) return "new_category";
  if (run.derived_status === "needs_human" && run.all_signals_pass) {
    return "calibration_pass_example";
  }
  return "other_needs_judgment";
}

export function rankEvalWorklist(report) {
  const items = [];
  for (const run of report.runs) {
    if (!isWorklistMember(run)) continue;
    const priorityId = classifyWorklistPriority({ run, runs: report.runs });
    items.push({
      ...run,
      priority_id: priorityId,
      priority_class: EVAL_WORKLIST_PRIORITY_ORDER.indexOf(priorityId) + 1,
    });
  }
  items.sort((a, b) =>
    a.priority_class - b.priority_class
    || (Date.parse(b.observed_at || 0) || 0) - (Date.parse(a.observed_at || 0) || 0)
    || a.run_id.localeCompare(b.run_id));
  return items;
}

function yesNo(value) {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}

function runReasons(run) {
  const reasons = [];
  if (run.high_risk) reasons.push("paused with open product/scope questions");
  for (const disagreement of run.disagreements) {
    reasons.push(disagreement.kind === "human_llm_label_conflict"
      ? `${disagreement.name}: human=${disagreement.human_label} vs model=${disagreement.llm_label}`
      : `${disagreement.name}: code flagged ${disagreement.code_failure_modes.join(",")} but human passed`);
  }
  for (const flag of run.judge_flags) reasons.push(`judge ${flag.identifier || "?"}: ${flag.reason}`);
  if (run.judge_missing) reasons.push("no model-judge annotation yet");
  if (run.judge_attempt?.judge_state === "judge_invalid") {
    reasons.push(`judge output invalid${run.judge_attempt.reason ? ` (${run.judge_attempt.reason})` : ""}`);
  }
  if (run.judge_attempt?.judge_state === "judge_missing") {
    reasons.push(`judge run produced no judgment${run.judge_attempt.reason ? ` (${run.judge_attempt.reason})` : ""}`);
  }
  if (run.derived_status === "needs_human" && reasons.length === 0) {
    reasons.push(run.all_signals_pass
      ? "passing example; human label would calibrate the judge"
      : "no human annotation yet");
  }
  return reasons;
}

// Transient stdout report only: nothing about the worklist is persisted
// anywhere (no Phoenix writes, no queue files); rerun to recompute.
export function formatWorklistReport({ report, items }) {
  const lines = [];
  lines.push(`local Phoenix: ${report.phoenix.ok ? `running ${report.phoenix.appUrl}` : `unreachable ${report.phoenix.appUrl}`} (project ${report.phoenix.projectName})`);
  if (report.phoenix.notice) lines.push(`NOTICE ${report.phoenix.notice}`);
  lines.push(`What needs my judgment? ${items.length} item(s) — derived view, recomputed each run, never persisted.`);
  if (items.length === 0) {
    lines.push("Nothing needs your judgment right now.");
    return lines;
  }
  items.forEach((run, index) => {
    const kind = run.artifact_kind ? ` (${run.artifact_kind})` : "";
    lines.push(`${index + 1}. [P${run.priority_class} ${run.priority_id}] run ${run.run_id}${kind} trace=${run.trace_id || "none"} project=${run.project_id || "unknown"}`);
    lines.push(`   human=${yesNo(run.has_human)} model=${yesNo(run.has_llm)} code=${yesNo(run.has_code)} disagreement=${yesNo(run.disagreements.length > 0)} promoted=${yesNo(run.promoted_to_dataset)}`);
    const reasons = runReasons(run);
    if (reasons.length > 0) lines.push(`   why: ${reasons.join("; ")}`);
    lines.push(`   phoenix: ${run.phoenix_url}`);
  });
  lines.push("annotate: npm run phoenix:annotate-trace -- <trace_id> <label> <score> <explanation> [--name <dimension>] [--identifier <id>]");
  return lines;
}

export function formatEvalStatusReport(report) {
  const lines = [];
  lines.push("eval status (derived at read time; never persisted to Phoenix):");
  if (report.phoenix.notice) lines.push(`NOTICE ${report.phoenix.notice}`);
  if (report.runs.length === 0) {
    lines.push("  no local runs found");
    return lines;
  }
  for (const run of report.runs) {
    lines.push(`  ${run.run_id} status=${run.derived_status} human=${yesNo(run.has_human)} model=${yesNo(run.has_llm)} code=${yesNo(run.has_code)} disagreement=${yesNo(run.disagreements.length > 0)} promoted=${yesNo(run.promoted_to_dataset)} trace=${run.trace_status || "none"}`);
  }
  return lines;
}

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

async function fetchWithTimeout(url, { fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS }) {
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
    // Read-only by construction: no method or body is ever supplied, so every
    // request this module makes is an HTTP GET.
    return await Promise.race([fetchImpl(url, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
