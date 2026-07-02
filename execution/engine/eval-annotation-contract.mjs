import fs from "node:fs";
import path from "node:path";

import { evalNamespacePaths } from "./eval-namespace.mjs";
import { deriveJudgeInputContract } from "./judge-input-contract.mjs";

// Shared constants for the canonical annotation contract.
//
// resolveEvalContract(definition, repoRoot) is the general spine: it resolves
// eval assets through the workflow definition's eval_namespace and returns a
// no-quality-contract result for namespaces that do not yet own judge assets.
// The legacy named exports at the bottom are intentionally thin decomposition
// defaults for module-load callers that do not have a definition in scope yet.

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_ROLL_UP_ANNOTATION_NAME = "quality";
const DECOMPOSITION_TAXONOMY_WORKFLOW_KEY = "roadmap_decomposition";
const DEFAULT_DECOMPOSITION_EVAL_DEFINITION = Object.freeze({
  workflow_type: "decomposition",
  eval_namespace: "execution/evals/decomposition",
  engine_owned_evaluator_roles: Object.freeze(["judge", "decomposition_quality_judge"]),
});

const contractMemo = new Map();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function absoluteEvalNamespacePaths(paths, repoRoot) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(paths).map(([key, repoRelativePath]) => [
        key,
        path.resolve(repoRoot, repoRelativePath),
      ]),
    ),
  );
}

function existingFiles(paths, keys) {
  return keys.filter((key) => fs.existsSync(paths[key]));
}

function frozenArray(value) {
  return Object.freeze(Array.isArray(value) ? [...value] : []);
}

function frozenScoreBands(annotationSchema, qualityLabels) {
  const entries = [];
  for (const label of qualityLabels) {
    const band = annotationSchema?.$defs?.[`${label}_band`];
    if (!band || typeof band !== "object" || Array.isArray(band)) continue;
    const normalized = {};
    if (Number.isFinite(band.minimum)) normalized.minimum = band.minimum;
    if (Number.isFinite(band.maximum)) normalized.maximum = band.maximum;
    if (Number.isFinite(band.exclusiveMaximum)) {
      normalized.exclusiveMaximum = band.exclusiveMaximum;
    }
    entries.push([label, Object.freeze(normalized)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function scoreBandEdges(scoreBands) {
  const edges = new Set();
  for (const band of Object.values(scoreBands || {})) {
    if (Number.isFinite(band.minimum) && band.minimum > 0) edges.add(band.minimum);
    if (Number.isFinite(band.maximum) && band.maximum < 1) edges.add(band.maximum);
    if (Number.isFinite(band.exclusiveMaximum) && band.exclusiveMaximum < 1) {
      edges.add(band.exclusiveMaximum);
    }
  }
  return Object.freeze([...edges].sort((left, right) => left - right));
}

function makeScoreWithinLabelBand(scoreBands) {
  return function scoreWithinLabelBandForContract(label, score) {
    if (!Number.isFinite(score)) return false;
    const band = scoreBands?.[label];
    if (!band) return false;
    if (Number.isFinite(band.minimum) && score < band.minimum) return false;
    if (Number.isFinite(band.maximum) && score > band.maximum) return false;
    if (Number.isFinite(band.exclusiveMaximum) && score >= band.exclusiveMaximum) return false;
    return true;
  };
}

function makeScoreAtBandBoundary(scoreBandEdges) {
  return function scoreAtBandBoundaryForContract(score, tolerance = 0.05) {
    if (!Number.isFinite(score)) return false;
    return scoreBandEdges.some((edge) => Math.abs(score - edge) <= tolerance);
  };
}

function makeScoreFromLabelBand(scoreBands) {
  return function scoreFromLabelBandForContract(label) {
    const band = scoreBands?.[label];
    if (!band) return null;
    const minimum = Number.isFinite(band.minimum) ? band.minimum : 0;
    const maximum = Number.isFinite(band.maximum)
      ? band.maximum
      : Number.isFinite(band.exclusiveMaximum)
        ? band.exclusiveMaximum
        : 1;
    if (maximum < minimum) return null;
    return Number((minimum + ((maximum - minimum) / 2)).toFixed(6));
  };
}

function taxonomyWorkflowKeyFor(definition, taxonomy) {
  if (definition?.workflow_type === "decomposition") return DECOMPOSITION_TAXONOMY_WORKFLOW_KEY;
  const workflowType = typeof definition?.workflow_type === "string" ? definition.workflow_type : null;
  if (workflowType && taxonomy?.workflows?.[workflowType]) return workflowType;
  return null;
}

function allowedFailureModesFor({ taxonomy, workflowKey }) {
  if (!taxonomy || !workflowKey) return Object.freeze([]);
  return Object.freeze([
    ...new Set([
      ...(taxonomy.structural?.failure_modes || []),
      ...(taxonomy.workflows?.[workflowKey]?.failure_modes || []),
    ]),
  ]);
}

function resolveJudgePrompt({ definition, manifest }) {
  const evaluatorRoles = Array.isArray(definition?.engine_owned_evaluator_roles)
    ? definition.engine_owned_evaluator_roles
    : [];
  const prompt = (manifest?.prompts || []).find((entry) => evaluatorRoles.includes(entry?.role));
  if (!prompt) return null;
  const evaluatorEntry = (manifest?.evaluators || []).find(
    (entry) => entry?.kind === "llm" && entry?.prompt_role === prompt.role,
  ) || null;
  if (!evaluatorEntry) return null;
  return Object.freeze({
    role: prompt.role,
    target_key: prompt.target_key,
    snapshot_path: prompt.snapshot_path,
    snapshot_sha256: prompt.snapshot_sha256,
    prompt_version: prompt.prompt_version,
    rubric_version: prompt.rubric_version,
    failure_taxonomy_version: prompt.failure_taxonomy_version,
    evaluator_entry: Object.freeze({ ...evaluatorEntry }),
  });
}

function noQualityContract({
  definition,
  paths,
  absolutePaths,
  manifest,
  reason = `workflow_eval_not_configured:${definition?.workflow_type || "unknown"}`,
}) {
  const scoreEdges = Object.freeze([]);
  return Object.freeze({
    definition,
    workflow_type: definition?.workflow_type ?? null,
    eval_namespace: definition?.eval_namespace ?? null,
    eval_configured: false,
    reason,
    paths,
    absolute_paths: absolutePaths,
    manifest,
    annotation_schema: null,
    example_schema: null,
    failure_taxonomy: null,
    quality_labels: Object.freeze([]),
    annotator_kinds: Object.freeze([]),
    canonical_annotation_names: Object.freeze([]),
    deterministic_check_annotation_names: Object.freeze([]),
    quality_dimension_names: Object.freeze([]),
    roll_up_annotation_name: DEFAULT_ROLL_UP_ANNOTATION_NAME,
    banned_workflow_state_metadata_keys: Object.freeze([]),
    findBannedWorkflowStateMetadataKeys: () => [],
    workspace_maturity_levels: Object.freeze([]),
    score_bands: null,
    score_band_edges: scoreEdges,
    scoreWithinLabelBand: makeScoreWithinLabelBand(null),
    scoreAtBandBoundary: makeScoreAtBandBoundary(scoreEdges),
    scoreFromLabelBand: makeScoreFromLabelBand(null),
    rubric_version: null,
    failure_taxonomy_version: null,
    failure_taxonomy_workflow_key: null,
    allowed_failure_modes: Object.freeze([]),
    judge_prompt: null,
    judge_input_contract: null,
    rich_example_dataset_name: null,
  });
}

export function resolveEvalContract(definition, repoRoot = MODULE_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const memoKey = `${resolvedRoot}\0${definition?.workflow_type || ""}\0${definition?.eval_namespace || ""}`;
  if (contractMemo.has(memoKey)) return contractMemo.get(memoKey);

  const paths = evalNamespacePaths(definition);
  const absolutePaths = absoluteEvalNamespacePaths(paths, resolvedRoot);
  const manifest = fs.existsSync(absolutePaths.manifest) ? readJson(absolutePaths.manifest) : null;
  const requiredQualityFiles = ["annotation_schema", "example_schema", "taxonomy", "policy"];
  const presentQualityFiles = existingFiles(absolutePaths, requiredQualityFiles);
  if (!manifest || presentQualityFiles.length !== requiredQualityFiles.length) {
    const contract = noQualityContract({
      definition,
      paths,
      absolutePaths,
      manifest,
    });
    contractMemo.set(memoKey, contract);
    return contract;
  }

  const annotationSchema = readJson(absolutePaths.annotation_schema);
  const exampleSchema = readJson(absolutePaths.example_schema);
  const failureTaxonomy = readJson(absolutePaths.taxonomy);
  const judgePrompt = resolveJudgePrompt({ definition, manifest });
  if (!judgePrompt) {
    const contract = noQualityContract({
      definition,
      paths,
      absolutePaths,
      manifest,
    });
    contractMemo.set(memoKey, contract);
    return contract;
  }

  const qualityLabels = frozenArray(annotationSchema.$defs?.quality_label?.enum);
  const annotatorKinds = frozenArray(annotationSchema.$defs?.annotator_kind?.enum);
  const canonicalAnnotationNames = frozenArray(annotationSchema.$defs?.annotation_name?.enum);
  const deterministicNames = Object.freeze([
    "accepted_packet_sufficiency",
    "pause_state_correctness",
  ]);
  for (const name of deterministicNames) {
    if (!canonicalAnnotationNames.includes(name)) {
      throw new Error(
        `annotation.schema.json annotation_name enum is missing deterministic check name "${name}"`,
      );
    }
  }
  const qualityDimensionNames = Object.freeze(
    canonicalAnnotationNames.filter((name) => !deterministicNames.includes(name)),
  );
  if (!qualityDimensionNames.includes(DEFAULT_ROLL_UP_ANNOTATION_NAME)) {
    throw new Error(
      `annotation.schema.json annotation_name enum is missing the roll-up name "${DEFAULT_ROLL_UP_ANNOTATION_NAME}"`,
    );
  }

  const bannedKeys = Object.freeze(
    Object.entries(annotationSchema.$defs?.no_workflow_state_keys?.properties || {})
      .filter(([, propertySchema]) => propertySchema === false)
      .map(([key]) => key),
  );
  const workspaceMaturity = frozenArray(
    annotationSchema.$defs?.annotation_metadata?.properties?.workspace_maturity?.enum,
  );
  const scoreBands = frozenScoreBands(annotationSchema, qualityLabels);
  const scoreEdges = scoreBandEdges(scoreBands);
  const workflowKey = taxonomyWorkflowKeyFor(definition, failureTaxonomy);
  const judgeInputContract = deriveJudgeInputContract({
    exampleSchema,
    judgePrompt,
  });
  const contract = Object.freeze({
    definition,
    workflow_type: definition.workflow_type,
    eval_namespace: definition.eval_namespace,
    eval_configured: true,
    reason: null,
    paths,
    absolute_paths: absolutePaths,
    manifest,
    annotation_schema: annotationSchema,
    example_schema: exampleSchema,
    failure_taxonomy: failureTaxonomy,
    quality_labels: qualityLabels,
    annotator_kinds: annotatorKinds,
    canonical_annotation_names: canonicalAnnotationNames,
    deterministic_check_annotation_names: deterministicNames,
    quality_dimension_names: qualityDimensionNames,
    roll_up_annotation_name: DEFAULT_ROLL_UP_ANNOTATION_NAME,
    banned_workflow_state_metadata_keys: bannedKeys,
    findBannedWorkflowStateMetadataKeys(metadata = {}) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
      return bannedKeys.filter((key) => Object.hasOwn(metadata, key));
    },
    workspace_maturity_levels: workspaceMaturity,
    score_bands: scoreBands,
    score_band_edges: scoreEdges,
    scoreWithinLabelBand: makeScoreWithinLabelBand(scoreBands),
    scoreAtBandBoundary: makeScoreAtBandBoundary(scoreEdges),
    scoreFromLabelBand: makeScoreFromLabelBand(scoreBands),
    rubric_version: judgePrompt.rubric_version,
    failure_taxonomy_version: failureTaxonomy.failure_taxonomy_version,
    failure_taxonomy_workflow_key: workflowKey,
    allowed_failure_modes: allowedFailureModesFor({ taxonomy: failureTaxonomy, workflowKey }),
    judge_prompt: judgePrompt,
    judge_input_contract: judgeInputContract,
    rich_example_dataset_name: manifest.datasets?.[0]?.name ?? null,
  });
  contractMemo.set(memoKey, contract);
  return contract;
}

const decompositionDefaultContract = resolveEvalContract(
  DEFAULT_DECOMPOSITION_EVAL_DEFINITION,
  MODULE_REPO_ROOT,
);

export const ANNOTATION_SCHEMA_PATH = decompositionDefaultContract.absolute_paths.annotation_schema;
export const EXAMPLE_SCHEMA_PATH = decompositionDefaultContract.absolute_paths.example_schema;
export const FAILURE_TAXONOMY_PATH = decompositionDefaultContract.absolute_paths.taxonomy;
export const PHOENIX_ASSETS_PATH = decompositionDefaultContract.absolute_paths.manifest;

// Default-judge label set: pass | needs_revision | blocking_failure. Must not drift.
export const QUALITY_LABELS = decompositionDefaultContract.quality_labels;

// HUMAN | LLM | CODE. CODE is deterministic-check storage, never a third peer judge.
export const ANNOTATOR_KINDS = decompositionDefaultContract.annotator_kinds;

// Every canonical annotation name (8 HUMAN/LLM dimensions + 2 deterministic-check names).
export const CANONICAL_ANNOTATION_NAMES = decompositionDefaultContract.canonical_annotation_names;

// Deterministic-check names stored with annotator_kind CODE only.
export const DETERMINISTIC_CHECK_ANNOTATION_NAMES =
  decompositionDefaultContract.deterministic_check_annotation_names;

// The 8 HUMAN/LLM dimensions, including the uniform roll-up.
export const QUALITY_DIMENSION_NAMES = decompositionDefaultContract.quality_dimension_names;

// The roll-up annotation name used for default gates. Must not drift.
export const DEFAULT_ANNOTATION_NAME = decompositionDefaultContract.roll_up_annotation_name;

// Phoenix-bound metadata denylist (wipe test): no Teami workflow/queue state
// may be stored in Phoenix.
export const BANNED_WORKFLOW_STATE_METADATA_KEYS =
  decompositionDefaultContract.banned_workflow_state_metadata_keys;

export const WORKSPACE_MATURITY_LEVELS = decompositionDefaultContract.workspace_maturity_levels;

// Documented default score bands. Fresh Judge output stores the band-derived
// midpoint; imported/HUMAN/legacy mismatches remain low-confidence flags, not
// schema rejections.
export const SCORE_BANDS = decompositionDefaultContract.score_bands;
export const SCORE_BAND_EDGES = decompositionDefaultContract.score_band_edges;

// Accepted contract versions annotations are judged against.
export const RUBRIC_VERSION = decompositionDefaultContract.rubric_version;
export const FAILURE_TAXONOMY_VERSION = decompositionDefaultContract.failure_taxonomy_version;

// Curated rich-example dataset name, pinned by the accepted asset manifest.
export const RICH_EXAMPLE_DATASET_NAME = decompositionDefaultContract.rich_example_dataset_name;

// Top-level scan, matching the schema's denylist scope (annotation_metadata
// applies no_workflow_state_keys to its own properties).
export function findBannedWorkflowStateMetadataKeys(metadata = {}) {
  return decompositionDefaultContract.findBannedWorkflowStateMetadataKeys(metadata);
}

export function scoreWithinLabelBand(label, score) {
  return decompositionDefaultContract.scoreWithinLabelBand(label, score);
}

export function scoreAtBandBoundary(score, tolerance = 0.05) {
  return decompositionDefaultContract.scoreAtBandBoundary(score, tolerance);
}

export function scoreFromLabelBand(label) {
  return decompositionDefaultContract.scoreFromLabelBand(label);
}
