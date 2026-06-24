import fs from "node:fs";
import path from "node:path";

import {
  DECOMPOSITION_EVAL_PATHS,
  decompositionEvalNamespacePath,
  resolveDecompositionEvalPath,
} from "./workflows/decomposition/eval-paths.mjs";

// Shared constants for the canonical decomposition annotation contract.
//
// The JSON artifacts under execution/evals/decomposition/ are the canonical,
// repo-owned contract (annotation.schema.json, failure-taxonomy.json,
// phoenix-assets.json). This module DERIVES runtime/test constants from those
// artifacts so write paths, the worklist, and the contract tests all read one
// source of truth instead of duplicating label sets or the workflow-state
// metadata denylist. Editing the schema is the only way to change these lists.

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

export const ANNOTATION_SCHEMA_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  decompositionEvalNamespacePath("annotation.schema.json"),
);
export const FAILURE_TAXONOMY_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  DECOMPOSITION_EVAL_PATHS.taxonomy,
);
export const PHOENIX_ASSETS_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  DECOMPOSITION_EVAL_PATHS.manifest,
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const annotationSchema = readJson(ANNOTATION_SCHEMA_PATH);
const failureTaxonomy = readJson(FAILURE_TAXONOMY_PATH);
const phoenixAssets = readJson(PHOENIX_ASSETS_PATH);

// Default-judge label set: pass | needs_revision | blocking_failure. Must not drift.
export const QUALITY_LABELS = Object.freeze([...annotationSchema.$defs.quality_label.enum]);

// HUMAN | LLM | CODE. CODE is deterministic-check storage, never a third peer judge.
export const ANNOTATOR_KINDS = Object.freeze([...annotationSchema.$defs.annotator_kind.enum]);

// Every canonical annotation name (8 quality dimensions + 2 deterministic-check names).
export const CANONICAL_ANNOTATION_NAMES = Object.freeze([
  ...annotationSchema.$defs.annotation_name.enum,
]);

// Deterministic-check names stored with annotator_kind CODE only.
const DETERMINISTIC_NAMES = ["accepted_packet_sufficiency", "pause_state_correctness"];
for (const name of DETERMINISTIC_NAMES) {
  if (!CANONICAL_ANNOTATION_NAMES.includes(name)) {
    throw new Error(
      `annotation.schema.json annotation_name enum is missing deterministic check name "${name}"`,
    );
  }
}
export const DETERMINISTIC_CHECK_ANNOTATION_NAMES = Object.freeze([...DETERMINISTIC_NAMES]);

// The 8 rubric quality dimensions shared by HUMAN and LLM judges.
export const QUALITY_DIMENSION_NAMES = Object.freeze(
  CANONICAL_ANNOTATION_NAMES.filter((name) => !DETERMINISTIC_NAMES.includes(name)),
);

// The roll-up annotation name used for default gates. Must not drift.
export const DEFAULT_ANNOTATION_NAME = "decomposition_quality";
if (!QUALITY_DIMENSION_NAMES.includes(DEFAULT_ANNOTATION_NAME)) {
  throw new Error(
    `annotation.schema.json annotation_name enum is missing the roll-up name "${DEFAULT_ANNOTATION_NAME}"`,
  );
}

// Phoenix-bound metadata denylist (wipe test): no Agentic Factory workflow/queue state
// may be stored in Phoenix. Derived from the schema's no_workflow_state_keys
// $def, where each banned key maps to the `false` schema.
export const BANNED_WORKFLOW_STATE_METADATA_KEYS = Object.freeze(
  Object.entries(annotationSchema.$defs.no_workflow_state_keys.properties)
    .filter(([, propertySchema]) => propertySchema === false)
    .map(([key]) => key),
);

export const WORKSPACE_MATURITY_LEVELS = Object.freeze([
  ...annotationSchema.$defs.annotation_metadata.properties.workspace_maturity.enum,
]);

// Documented default score bands (not hard validation): a label/score band
// mismatch is a low-confidence worklist flag, not a schema rejection.
export const SCORE_BANDS = Object.freeze({
  pass: Object.freeze({
    minimum: annotationSchema.$defs.pass_band.minimum,
    maximum: annotationSchema.$defs.pass_band.maximum,
  }),
  needs_revision: Object.freeze({
    minimum: annotationSchema.$defs.needs_revision_band.minimum,
    exclusiveMaximum: annotationSchema.$defs.needs_revision_band.exclusiveMaximum,
  }),
  blocking_failure: Object.freeze({
    minimum: annotationSchema.$defs.blocking_failure_band.minimum,
    exclusiveMaximum: annotationSchema.$defs.blocking_failure_band.exclusiveMaximum,
  }),
});

export const SCORE_BAND_EDGES = Object.freeze([
  SCORE_BANDS.needs_revision.minimum,
  SCORE_BANDS.pass.minimum,
]);

// Accepted contract versions annotations are judged against. rubric_version
// comes from the accepted judge prompt pin in phoenix-assets.json;
// failure_taxonomy_version comes from failure-taxonomy.json.
export const RUBRIC_VERSION = phoenixAssets.prompts[0].rubric_version;
export const FAILURE_TAXONOMY_VERSION = failureTaxonomy.failure_taxonomy_version;

// Curated rich-example dataset name, pinned by the accepted asset manifest
// (distinct from the bounded receipt dataset used by phoenix:promote-run).
export const RICH_EXAMPLE_DATASET_NAME = phoenixAssets.datasets[0].name;

// Top-level scan, matching the schema's denylist scope (annotation_metadata
// applies no_workflow_state_keys to its own properties).
export function findBannedWorkflowStateMetadataKeys(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return BANNED_WORKFLOW_STATE_METADATA_KEYS.filter((key) => Object.hasOwn(metadata, key));
}

export function scoreWithinLabelBand(label, score) {
  if (!Number.isFinite(score)) return false;
  if (label === "pass") {
    return score >= SCORE_BANDS.pass.minimum && score <= SCORE_BANDS.pass.maximum;
  }
  if (label === "needs_revision") {
    return score >= SCORE_BANDS.needs_revision.minimum
      && score < SCORE_BANDS.needs_revision.exclusiveMaximum;
  }
  if (label === "blocking_failure") {
    return score >= SCORE_BANDS.blocking_failure.minimum
      && score < SCORE_BANDS.blocking_failure.exclusiveMaximum;
  }
  return false;
}

export function scoreAtBandBoundary(score, tolerance = 0.05) {
  if (!Number.isFinite(score)) return false;
  return SCORE_BAND_EDGES.some((edge) => Math.abs(score - edge) <= tolerance);
}
