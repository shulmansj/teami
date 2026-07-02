import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PHOENIX_APP_URL,
  DEFAULT_PHOENIX_PACKAGE,
  DEFAULT_PHOENIX_PROJECT,
} from "../src/local-phoenix-manager.mjs";
import {
  ANNOTATOR_KINDS,
  BANNED_WORKFLOW_STATE_METADATA_KEYS,
  CANONICAL_ANNOTATION_NAMES,
  DEFAULT_ANNOTATION_NAME,
  DETERMINISTIC_CHECK_ANNOTATION_NAMES,
  FAILURE_TAXONOMY_VERSION as CONTRACT_FAILURE_TAXONOMY_VERSION,
  QUALITY_DIMENSION_NAMES,
  QUALITY_LABELS,
  RUBRIC_VERSION,
  resolveEvalContract,
  scoreFromLabelBand,
} from "../src/eval-annotation-contract.mjs";
import { schemaErrors } from "../src/eval-structural-validator.mjs";
import {
  FAILURE_TAXONOMY_VERSION,
  STRUCTURAL_FAILURE_MODES,
  evaluateAcceptedPacketSufficiencyOffline,
  evaluateDecompositionQualityOffline,
  evaluatePauseState,
  normalizeFailureMode,
} from "../src/quality.mjs";
import { deriveCandidateTargetKey } from "../src/phoenix-experiment.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import { reviewDefinition } from "../src/workflows/review/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const evalsDir = path.join(repoRoot, "execution", "evals", "decomposition");
const reviewEvalsDir = path.join(repoRoot, "execution", "evals", "review");
const fixturesDir = path.join(import.meta.dirname, "fixtures", "eval-contracts");

const exampleSchema = readJson(path.join(evalsDir, "example.schema.json"));
const annotationSchema = readJson(path.join(evalsDir, "annotation.schema.json"));
const failureTaxonomy = readJson(path.join(evalsDir, "failure-taxonomy.json"));
const phoenixAssets = readJson(path.join(evalsDir, "phoenix-assets.json"));
const reviewExampleSchema = readJson(path.join(reviewEvalsDir, "example.schema.json"));
const reviewAnnotationSchema = readJson(path.join(reviewEvalsDir, "annotation.schema.json"));
const reviewFailureTaxonomy = readJson(path.join(reviewEvalsDir, "failure-taxonomy.json"));
const reviewPhoenixAssets = readJson(path.join(reviewEvalsDir, "phoenix-assets.json"));
const validExample = readJson(path.join(fixturesDir, "decomposition-example.valid.json"));

// Shared with runtime code via src/eval-annotation-contract.mjs (single source
// of truth derived from the schema artifacts; nothing is duplicated here).
const BANNED_WORKFLOW_STATE_KEYS = BANNED_WORKFLOW_STATE_METADATA_KEYS;
const QUALITY_DIMENSIONS = QUALITY_DIMENSION_NAMES;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listJsonFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listJsonFiles(fullPath));
    else if (entry.name.endsWith(".json")) found.push(fullPath);
  }
  return found;
}

// The minimal structural JSON Schema checker lives in
// src/eval-structural-validator.mjs since step 4: rich dataset promotion
// validates every assembled example against example.schema.json with the SAME
// checks before any Phoenix upload, so the tests and the runtime fail-closed
// path share one source of truth.
function assertValid(schema, value, message) {
  assert.deepEqual(schemaErrors(schema, value, schema), [], message);
}

function assertInvalid(schema, value, expectedFragment) {
  const errors = schemaErrors(schema, value, schema);
  assert.ok(errors.length > 0, `expected validation errors mentioning "${expectedFragment}"`);
  assert.ok(
    errors.some((error) => error.includes(expectedFragment)),
    `expected an error mentioning "${expectedFragment}", got: ${errors.join(" | ")}`,
  );
}

test("every decomposition eval contract JSON artifact parses", () => {
  const files = listJsonFiles(evalsDir);
  assert.ok(files.length >= 4, `expected at least 4 JSON artifacts, found ${files.length}`);
  for (const file of files) {
    assert.doesNotThrow(() => readJson(file), `unparseable JSON artifact: ${file}`);
  }
});

test("eval schemas are draft 2020-12 with versioned ids", () => {
  for (const schema of [exampleSchema, annotationSchema]) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /\/v\d+$/);
  }
  assert.equal(exampleSchema.$id, "decomposition-eval-example/v1");
  assert.equal(annotationSchema.$id, "decomposition-eval-annotation/v1");
});

test("example schema encodes the dataset example contract enums exactly", () => {
  assert.deepEqual(exampleSchema.required, ["input", "output", "reference", "metadata"]);
  assert.deepEqual(exampleSchema.properties.output.properties.terminal_status.enum, [
    "completed",
    "paused",
    "failed_closed",
    "ineligible",
  ]);
  const metadata = exampleSchema.properties.metadata.properties;
  assert.deepEqual(metadata.workspace_maturity.enum, ["new", "calibrating", "stable"]);
  assert.deepEqual(metadata.project_category.enum, ["code", "docs", "marketing", "ops", "mixed"]);
  assert.deepEqual(metadata.project_impact_level.enum, ["low", "medium", "high"]);
  assert.deepEqual(metadata.lifecycle_state.enum, ["active", "deprecated"]);
  assert.deepEqual(metadata.dataset_split.enum, ["train", "test", "calibration", "regression"]);
  assert.deepEqual(metadata.content_retention.enum, ["bounded", "rich_local", "sanitized_fixture"]);
  const input = exampleSchema.properties.input.properties;
  assert.deepEqual(exampleSchema.properties.input.required, [
    "gradeability",
    "judge_fixture_input",
    "maintainer_supplied_context",
    "source_type",
    "project",
    "run_envelope",
    "source_refs",
  ]);
  assert.deepEqual(input.gradeability.enum, ["full_input", "detection_only"]);
  assert.equal(input.source_type.const, "linear_project_snapshot");
  assert.deepEqual(input.project.required, [
    "id",
    "name",
    "content",
    "status",
    "labels",
    "existing_issues",
  ]);
  assert.deepEqual(input.run_envelope.properties.runtime_assignments.required, ["pm", "sr_eng"]);
  assert.deepEqual(exampleSchema.$defs.judge_fixture_input.required, [
    "project_intent",
    "terminal_status",
    "terminal_reason",
    "final_issues",
    "discovery_issues",
    "dependency_relations",
    "project_update_markdown",
    "open_questions_markdown",
    "phase_packet_summaries",
  ]);
  assert.deepEqual(exampleSchema.$defs.maintainer_supplied_context.required, [
    "rubric_version",
    "failure_taxonomy_version",
    "allowed_failure_modes",
  ]);
  const reference = exampleSchema.properties.reference.properties;
  assert.equal(reference.expected_label.$ref, "#/$defs/quality_label");
  assert.equal(reference.expected_score.minimum, 0);
  assert.equal(reference.expected_score.maximum, 1);
  assert.deepEqual(reference.provenance.required, ["label_source", "label_status", "labeled_at"]);
  assert.deepEqual(reference.provenance.properties.label_source.enum, ["explicit_human", "ambiguous"]);
  assert.deepEqual(reference.provenance.properties.label_status.enum, ["GOLD", "excluded"]);
  assert.equal(metadata.source_target_ids.items.type, "string");
  assert.equal(metadata.produced_identity_refs.items.$ref, "#/$defs/produced_identity_ref");
  assert.deepEqual(exampleSchema.$defs.produced_identity_ref.required, [
    "effect_id",
    "provider",
    "resource_kind",
    "target_ids",
  ]);
});

test("shared eval contract constants module mirrors the canonical schema artifacts exactly", () => {
  // The module derives its constants from the schema, so these LITERAL pins
  // are what keep the canonical sets from drifting (the schema and the module
  // must both change together, through a process-change proposal).
  assert.deepEqual([...QUALITY_LABELS], ["pass", "needs_revision", "blocking_failure"]);
  assert.deepEqual([...ANNOTATOR_KINDS], ["HUMAN", "LLM", "CODE"]);
  assert.deepEqual([...QUALITY_DIMENSION_NAMES], [
    "quality",
    "project_intent_preservation",
    "issue_executability",
    "dependency_structure",
    "acceptance_criteria_quality",
    "escalation_judgment",
    "discovery_judgment",
    "human_decision_load",
  ]);
  assert.deepEqual([...DETERMINISTIC_CHECK_ANNOTATION_NAMES], [
    "accepted_packet_sufficiency",
    "pause_state_correctness",
  ]);
  assert.deepEqual(
    [...CANONICAL_ANNOTATION_NAMES],
    [...QUALITY_DIMENSION_NAMES, ...DETERMINISTIC_CHECK_ANNOTATION_NAMES],
  );
  assert.equal(DEFAULT_ANNOTATION_NAME, "quality");
  assert.deepEqual([...BANNED_WORKFLOW_STATE_METADATA_KEYS], [
    "needs_relabel",
    "pending_promotion",
    "accepted_by_factory",
    "propose_repo_change",
    "proposal_state",
    "queue_state",
    "workflow_status",
    "assigned",
    "resolved",
  ]);
  // Denylist derivation: every banned key maps to the `false` schema in the
  // canonical no_workflow_state_keys $def, and nothing else does.
  assert.deepEqual(
    [...BANNED_WORKFLOW_STATE_METADATA_KEYS],
    Object.entries(annotationSchema.$defs.no_workflow_state_keys.properties)
      .filter(([, propertySchema]) => propertySchema === false)
      .map(([key]) => key),
  );
  assert.equal(RUBRIC_VERSION, phoenixAssets.prompts[0].rubric_version);
  assert.equal(CONTRACT_FAILURE_TAXONOMY_VERSION, failureTaxonomy.failure_taxonomy_version);
});

test("resolveEvalContract returns the full decomposition quality contract", () => {
  const contract = resolveEvalContract(decompositionDefinition, repoRoot);
  assert.equal(contract.eval_configured, true);
  assert.equal(contract.reason, null);
  assert.equal(contract.workflow_type, "decomposition");
  assert.equal(contract.eval_namespace, "execution/evals/decomposition");
  assert.equal(contract.paths.manifest, "execution/evals/decomposition/phoenix-assets.json");
  assert.equal(contract.paths.annotation_schema, "execution/evals/decomposition/annotation.schema.json");
  assert.equal(contract.paths.example_schema, "execution/evals/decomposition/example.schema.json");
  assert.equal(
    contract.absolute_paths.annotation_schema,
    path.join(evalsDir, "annotation.schema.json"),
  );
  assert.deepEqual([...contract.quality_labels], [...QUALITY_LABELS]);
  assert.deepEqual([...contract.annotator_kinds], [...ANNOTATOR_KINDS]);
  assert.deepEqual([...contract.canonical_annotation_names], [...CANONICAL_ANNOTATION_NAMES]);
  assert.deepEqual(
    [...contract.deterministic_check_annotation_names],
    [...DETERMINISTIC_CHECK_ANNOTATION_NAMES],
  );
  assert.deepEqual([...contract.quality_dimension_names], [...QUALITY_DIMENSION_NAMES]);
  assert.equal(contract.roll_up_annotation_name, DEFAULT_ANNOTATION_NAME);
  assert.equal(contract.rubric_version, RUBRIC_VERSION);
  assert.equal(contract.failure_taxonomy_version, failureTaxonomy.failure_taxonomy_version);
  assert.equal(contract.failure_taxonomy_workflow_key, "roadmap_decomposition");
  assert.ok(contract.allowed_failure_modes.includes("missing_acceptance_criteria"));
  assert.equal(contract.rich_example_dataset_name, phoenixAssets.datasets[0].name);
  assert.deepEqual(contract.judge_input_contract.judge_fixture_input_fields, [
    "project_intent",
    "terminal_status",
    "terminal_reason",
    "final_issues",
    "discovery_issues",
    "dependency_relations",
    "project_update_markdown",
    "open_questions_markdown",
    "phase_packet_summaries",
  ]);
  assert.deepEqual(contract.judge_input_contract.maintainer_supplied_context_fields, [
    "rubric_version",
    "failure_taxonomy_version",
    "allowed_failure_modes",
  ]);
  assert.deepEqual(contract.judge_input_contract.required_fields, [
    ...contract.judge_input_contract.judge_fixture_input_fields,
    ...contract.judge_input_contract.maintainer_supplied_context_fields,
  ]);
  assert.equal(contract.judge_prompt.role, "decomposition_quality_judge");
  assert.equal(
    contract.judge_prompt.target_key,
    "prompt/decomposition/decomposition_quality_judge",
  );
  assert.equal(contract.judge_prompt.rubric_version, phoenixAssets.prompts[0].rubric_version);
  assert.equal(contract.judge_prompt.evaluator_entry.id, "decomposition_quality_judge_v1");
  assert.deepEqual(
    contract.findBannedWorkflowStateMetadataKeys({ queue_state: "pending", allowed: true }),
    ["queue_state"],
  );
  assert.equal(contract.scoreWithinLabelBand("pass", 0.9), true);
  assert.equal(contract.scoreWithinLabelBand("pass", 0.7), false);
  assert.equal(contract.scoreAtBandBoundary(0.8), true);
  assert.equal(contract.scoreFromLabelBand("pass"), 0.9);
  assert.equal(contract.scoreFromLabelBand("needs_revision"), 0.6);
  assert.equal(contract.scoreFromLabelBand("blocking_failure"), 0.2);
  assert.equal(scoreFromLabelBand("pass"), 0.9);
});

test("resolveEvalContract returns the configured Reviewer quality contract", () => {
  const contract = resolveEvalContract(reviewDefinition, repoRoot);
  assert.equal(contract.eval_configured, true);
  assert.equal(contract.reason, null);
  assert.equal(contract.workflow_type, "review");
  assert.equal(contract.eval_namespace, "execution/evals/review");
  assert.equal(contract.paths.annotation_schema, "execution/evals/review/annotation.schema.json");
  assert.equal(contract.paths.example_schema, "execution/evals/review/example.schema.json");
  assert.equal(contract.failure_taxonomy_workflow_key, "review");
  assert.deepEqual([...contract.quality_labels], ["pass", "needs_revision", "blocking_failure"]);
  assert.deepEqual([...contract.quality_dimension_names], [
    "quality",
    "verdict_correctness",
    "real_issue_detection",
    "false_positive_avoidance",
    "reasoning_soundness",
    "actionability",
    "severity_calibration",
    "scope_discipline",
    "user_risk_explanation",
  ]);
  assert.equal(contract.roll_up_annotation_name, "quality");
  assert.equal(contract.rubric_version, "1.0.0");
  assert.equal(contract.failure_taxonomy_version, reviewFailureTaxonomy.failure_taxonomy_version);
  assert.equal(contract.rich_example_dataset_name, "teami-review-examples");
  assert.equal(contract.judge_prompt.role, "review_quality_judge");
  assert.equal(contract.judge_prompt.target_key, "prompt/review/review_quality_judge");
  assert.equal(contract.judge_prompt.rubric_version, reviewPhoenixAssets.prompts[0].rubric_version);
  assert.equal(contract.judge_prompt.evaluator_entry.id, "review_quality_judge_v1");
  assert.deepEqual(contract.judge_input_contract.judge_fixture_input_fields, [
    "reviewed_pr",
    "reviewer_review",
    "review_correctness_signal",
  ]);
  assert.deepEqual(contract.judge_input_contract.maintainer_supplied_context_fields, [
    "rubric_version",
    "failure_taxonomy_version",
    "allowed_failure_modes",
  ]);
  assert.deepEqual(reviewExampleSchema.$defs.judge_fixture_input.required, [
    "reviewed_pr",
    "reviewer_review",
    "review_correctness_signal",
  ]);
  assert.deepEqual(reviewExampleSchema.$defs.review_verdict.enum, [
    "approve",
    "request-changes",
    "escalate",
  ]);
  assert.deepEqual(reviewAnnotationSchema.$defs.quality_label.enum, [
    "pass",
    "needs_revision",
    "blocking_failure",
  ]);
  for (const seededFailureMode of [
    "review_missed_regression",
    "review_missed_scope_change",
    "review_missed_missing_tests",
    "review_overfocused_on_style",
    "review_failed_to_explain_user_risk",
  ]) {
    assert.ok(
      contract.allowed_failure_modes.includes(seededFailureMode),
      `review taxonomy is missing seeded failure mode "${seededFailureMode}"`,
    );
  }
});

test("annotation schema pins the label set, annotator kinds, roll-up name, and score bands", () => {
  // Constraint: the default-judge label set and the quality
  // annotation name must not drift.
  assert.deepEqual(annotationSchema.$defs.quality_label.enum, QUALITY_LABELS);
  assert.deepEqual(annotationSchema.$defs.annotator_kind.enum, ANNOTATOR_KINDS);
  for (const dimension of QUALITY_DIMENSIONS) {
    assert.ok(
      annotationSchema.$defs.annotation_name.enum.includes(dimension),
      `annotation_name enum is missing dimension "${dimension}"`,
    );
  }
  assert.equal(annotationSchema.$defs.quality_score.minimum, 0);
  assert.equal(annotationSchema.$defs.quality_score.maximum, 1);
  assert.deepEqual(
    { min: annotationSchema.$defs.pass_band.minimum, max: annotationSchema.$defs.pass_band.maximum },
    { min: 0.8, max: 1 },
  );
  assert.deepEqual(
    {
      min: annotationSchema.$defs.needs_revision_band.minimum,
      below: annotationSchema.$defs.needs_revision_band.exclusiveMaximum,
    },
    { min: 0.4, below: 0.8 },
  );
  assert.deepEqual(
    {
      min: annotationSchema.$defs.blocking_failure_band.minimum,
      below: annotationSchema.$defs.blocking_failure_band.exclusiveMaximum,
    },
    { min: 0, below: 0.4 },
  );
  // The example schema must agree with the annotation schema on names/labels.
  assert.deepEqual(exampleSchema.$defs.quality_label.enum, QUALITY_LABELS);
  assert.deepEqual(
    exampleSchema.$defs.annotation_name.enum,
    annotationSchema.$defs.annotation_name.enum,
  );
});

test("golden example fixture validates against the example schema", () => {
  assertValid(exampleSchema, validExample);
});

test("example schema accepts D-capture frozen human labels and produced identity refs", () => {
  const enriched = structuredClone(validExample);
  enriched.reference.human_annotation_ids = ["anno-human-1"];
  enriched.reference.expected_label = "pass";
  enriched.reference.expected_score = 0.9;
  enriched.reference.provenance = {
    label_source: "explicit_human",
    label_status: "GOLD",
    labeled_at: "2026-06-10T00:05:00.000Z",
    annotator_id: "adopter-fixture-owner",
  };
  enriched.metadata.source_target_ids = ["issue-1", "issue-2"];
  enriched.metadata.produced_identity_refs = [{
    effect_id: "linear_issues",
    provider: "linear",
    resource_kind: "linear_issue",
    target_ids: ["issue-1", "issue-2"],
  }];
  assertValid(exampleSchema, enriched);
});

test("invalid example fixtures are rejected for the expected reasons", () => {
  const mutate = (apply) => {
    const clone = structuredClone(validExample);
    apply(clone);
    return clone;
  };

  assertInvalid(
    exampleSchema,
    mutate((example) => delete example.input.project.content),
    'missing required property "content"',
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.input.source_type = "github_repo_snapshot";
    }),
    "expected const",
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.output.terminal_status = "succeeded";
    }),
    "not in enum",
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.output.terminal_status = "paused";
      delete example.output.open_questions_markdown;
    }),
    'missing required property "open_questions_markdown"',
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.metadata.dataset_split = "validation";
    }),
    "not in enum",
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => delete example.metadata.failure_taxonomy_version),
    'missing required property "failure_taxonomy_version"',
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.reference.human_annotations[0].label = "fail";
    }),
    "not in enum",
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.reference.human_annotations[0].score = 1.5;
    }),
    "above maximum",
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => delete example.input.run_envelope.runtime_assignments.sr_eng),
    'missing required property "sr_eng"',
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => delete example.input.judge_fixture_input.terminal_reason),
    'missing required property "terminal_reason"',
  );
  assertInvalid(
    exampleSchema,
    mutate((example) => {
      example.input.gradeability = "thin_capture";
    }),
    "not in enum",
  );
});

// Invalid fixtures on disk. Every *.invalid* fixture must declare which schema
// rejects it and why, so a stray fixture can never silently pass.
const INVALID_FIXTURE_EXPECTATIONS = {
  "decomposition-example.invalid-terminal-status.json": {
    schema: () => exampleSchema,
    expectedFragment: "not in enum",
  },
  "decomposition-example.invalid-missing-rubric-version.json": {
    schema: () => exampleSchema,
    expectedFragment: 'missing required property "rubric_version"',
  },
  "decomposition-example.invalid-banned-workflow-state-metadata.json": {
    schema: () => exampleSchema,
    expectedFragment: "schema is false",
  },
  "annotation.invalid-human-missing-rubric-version.json": {
    schema: () => annotationSchema,
    expectedFragment: "oneOf",
  },
  "annotation.invalid-missing-identifier.json": {
    schema: () => annotationSchema,
    expectedFragment: "oneOf",
  },
  "annotation.invalid-empty-identifier.json": {
    schema: () => annotationSchema,
    expectedFragment: "oneOf",
  },
  "annotation.invalid-banned-workflow-state-metadata.json": {
    schema: () => annotationSchema,
    expectedFragment: "oneOf",
  },
};

test("invalid fixtures on disk are rejected by the structural checks", () => {
  const invalidFiles = listJsonFiles(fixturesDir).filter((file) =>
    path.basename(file).includes(".invalid"),
  );
  assert.ok(
    invalidFiles.length >= 2,
    `expected at least 2 invalid fixtures, found ${invalidFiles.length}`,
  );
  for (const file of invalidFiles) {
    const expectation = INVALID_FIXTURE_EXPECTATIONS[path.basename(file)];
    assert.ok(
      expectation,
      `invalid fixture has no declared expectation: ${path.basename(file)}`,
    );
    assertInvalid(expectation.schema(), readJson(file), expectation.expectedFragment);
  }
  for (const fixtureName of Object.keys(INVALID_FIXTURE_EXPECTATIONS)) {
    assert.ok(
      invalidFiles.some((file) => path.basename(file) === fixtureName),
      `declared invalid fixture is missing on disk: ${fixtureName}`,
    );
  }
});

test("valid logical and Phoenix wire annotations validate; malformed ones fail", () => {
  const logicalHuman = {
    name: "quality",
    annotator_kind: "HUMAN",
    label: "pass",
    score: 0.92,
    explanation: "Issues are executable and dependencies are native relations.",
    metadata: {
      failure_modes: [],
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
      workspace_maturity: "new",
    },
    identifier: "workspace-owner",
  };
  assertValid(annotationSchema, logicalHuman);

  const wireLlm = {
    name: "quality",
    annotator_kind: "LLM",
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    result: {
      label: "needs_revision",
      score: 0.55,
      explanation: "One dependency is prose-only.",
    },
    metadata: {
      failure_modes: ["prose_dependency_instead_of_relation"],
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
    },
    identifier: "decomposition_quality_judge_v1",
  };
  assertValid(annotationSchema, wireLlm);

  // CODE deterministic checks may use binary scores outside the default
  // label bands; the schema documents bands but does not hard-enforce them.
  // Wire quality results still require score AND explanation alongside label.
  const wireCodeBinary = {
    name: "accepted_packet_sufficiency",
    annotator_kind: "CODE",
    span_id: "b7ad6b7169203331",
    result: {
      label: "needs_revision",
      score: 0,
      explanation: "The orchestrator terminal output is missing entirely.",
    },
    metadata: { failure_modes: ["missing_terminal_output"] },
    identifier: "accepted_packet_sufficiency_offline_v1",
  };
  assertValid(annotationSchema, wireCodeBinary);

  // A label/score band mismatch is deliberately NOT a schema rejection: bands
  // are documented defaults and a mismatch is a low-confidence worklist flag.
  assertValid(
    annotationSchema,
    { ...logicalHuman, label: "pass", score: 0.5 },
    "band mismatch must stay schema-valid (worklist flag, not rejection)",
  );

  // HUMAN/LLM quality annotations must carry rubric + taxonomy versions.
  assertInvalid(
    annotationSchema,
    { ...logicalHuman, metadata: { failure_modes: [] } },
    "oneOf",
  );
  // Wire annotations need a trace or span target.
  const { trace_id: _unusedTraceId, ...wireWithoutTarget } = wireLlm;
  assertInvalid(annotationSchema, wireWithoutTarget, "oneOf");
  assertInvalid(annotationSchema, { ...logicalHuman, label: "fail" }, "oneOf");
  assertInvalid(annotationSchema, { ...logicalHuman, annotator_kind: "MODEL" }, "oneOf");
  assertInvalid(annotationSchema, { ...logicalHuman, score: 1.2 }, "oneOf");

  // Identifier is required and non-empty on BOTH shapes: Phoenix upserts by
  // (name, target, identifier) and defaults it to "", so omitted/empty
  // identifiers collapse human/model/code judgments onto one row.
  const { identifier: _unusedLogicalId, ...logicalWithoutIdentifier } = logicalHuman;
  assertInvalid(annotationSchema, logicalWithoutIdentifier, "oneOf");
  assertInvalid(annotationSchema, { ...logicalHuman, identifier: "" }, "oneOf");
  const { identifier: _unusedWireId, ...wireWithoutIdentifier } = wireLlm;
  assertInvalid(annotationSchema, wireWithoutIdentifier, "oneOf");
  assertInvalid(annotationSchema, { ...wireLlm, identifier: "" }, "oneOf");

  // Wire quality results must carry label, score, AND explanation.
  const { score: _unusedScore, ...resultWithoutScore } = wireLlm.result;
  assertInvalid(annotationSchema, { ...wireLlm, result: resultWithoutScore }, "oneOf");
  const { explanation: _unusedExplanation, ...resultWithoutExplanation } = wireLlm.result;
  assertInvalid(annotationSchema, { ...wireLlm, result: resultWithoutExplanation }, "oneOf");

  // Phoenix-bound metadata rejects known workflow-state keys (wipe test) on
  // both shapes while other extensibility stays open.
  for (const bannedKey of BANNED_WORKFLOW_STATE_KEYS) {
    assertInvalid(
      annotationSchema,
      { ...logicalHuman, metadata: { ...logicalHuman.metadata, [bannedKey]: true } },
      "oneOf",
    );
  }
  assertInvalid(
    annotationSchema,
    { ...wireLlm, metadata: { ...wireLlm.metadata, needs_relabel: true } },
    "oneOf",
  );
  assertValid(
    annotationSchema,
    { ...logicalHuman, metadata: { ...logicalHuman.metadata, benign_metric_count: 3 } },
    "non-banned metadata keys must stay allowed",
  );
});

test("promotion outcome annotations use the separate minimal label-only contract", () => {
  const outcomeSchema = annotationSchema.$defs.promotion_outcome_annotation;
  assert.ok(outcomeSchema, "annotation schema must define $defs.promotion_outcome_annotation");
  assert.deepEqual(outcomeSchema.properties.result.properties.label.enum, [
    "route_to_hitl",
    "blocked",
    "superseded",
  ]);
  const errorsFor = (value) => schemaErrors(outcomeSchema, value, annotationSchema);

  const validOutcome = {
    name: "teami_promotion_outcome",
    annotator_kind: "CODE",
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    result: { label: "route_to_hitl" },
    metadata: {
      proposal_instance_id: "proposal-0001",
      candidate_target_key: "prompt/decomposition/decomposition_quality_judge",
      repo_review_url: "https://github.com/example/behavior-repo/pull/1",
      normalized_envelope_hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      repair_state: "none",
    },
    identifier: "teami_promotion_controller_v1",
  };
  assert.deepEqual(errorsFor(validOutcome), []);

  // Blocked outcomes have no repo review artifact: repo_review_url is nullable.
  assert.deepEqual(
    errorsFor({
      ...validOutcome,
      result: { label: "blocked" },
      metadata: { ...validOutcome.metadata, repo_review_url: null },
    }),
    [],
  );
  // Recorded repair state survives Phoenix-write failures.
  assert.deepEqual(
    errorsFor({
      ...validOutcome,
      metadata: { ...validOutcome.metadata, repair_state: "phoenix_audit_retry_needed" },
    }),
    [],
  );

  // Outcome labels are actual controller outcomes only - never queue states,
  // never quality labels, never caller-granted authority.
  assert.ok(errorsFor({ ...validOutcome, result: { label: "merged" } }).length > 0);
  assert.ok(errorsFor({ ...validOutcome, result: { label: "pass" } }).length > 0);
  assert.ok(errorsFor({ ...validOutcome, result: { label: "pending_promotion" } }).length > 0);
  // Outcome annotations are CODE-stored controller facts, never HUMAN/LLM.
  assert.ok(errorsFor({ ...validOutcome, annotator_kind: "HUMAN" }).length > 0);
  // Required provenance metadata cannot be dropped.
  for (const requiredKey of [
    "proposal_instance_id",
    "candidate_target_key",
    "repo_review_url",
    "normalized_envelope_hash",
    "repair_state",
  ]) {
    const metadata = { ...validOutcome.metadata };
    delete metadata[requiredKey];
    assert.ok(
      errorsFor({ ...validOutcome, metadata }).length > 0,
      `outcome annotation without metadata.${requiredKey} must be rejected`,
    );
  }
  // The workflow-state denylist applies to outcome metadata too.
  assert.ok(
    errorsFor({
      ...validOutcome,
      metadata: { ...validOutcome.metadata, queue_state: "pending" },
    }).length > 0,
  );
  // Identifier stays required and non-empty.
  assert.ok(errorsFor({ ...validOutcome, identifier: "" }).length > 0);

  // The outcome shape is deliberately NOT a quality annotation: the root
  // oneOf (quality contract) must reject it rather than absorb it.
  assertInvalid(annotationSchema, validOutcome, "oneOf");
});

test("deterministic CODE evaluators emit annotations compatible with the shared contract", () => {
  const passingQuality = evaluateDecompositionQualityOffline({
    issues: [
      {
        assignment: "Do the work",
        output: "The result",
        acceptanceCriteria: ["Observable check"],
        decompositionKey: "fixture/one",
      },
    ],
    dependencies: [],
    assumptions: [],
  });
  const failingQuality = evaluateDecompositionQualityOffline({ issues: [], dependencies: [] });
  const failingSufficiency = evaluateAcceptedPacketSufficiencyOffline({ terminalOutput: null });
  const pauseState = evaluatePauseState({
    project: {
      labels: [{ id: "label-open-questions" }],
      status: { id: "status-backlog", type: "backlog" },
      content: "## Open Questions\n- Which provider tier?",
    },
    hasOpenQuestionsLabelId: "label-open-questions",
    backlogStatusId: "status-backlog",
  });

  // Parameterized diagnostics normalize to taxonomy base ids; the raw
  // parameterized detail moves to metadata.failure_mode_details.
  const parameterizedSufficiency = evaluateAcceptedPacketSufficiencyOffline({
    phasePackets: [
      {
        phase: "pm_product_sufficiency",
        status: "continue",
        context_digest: "",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      },
    ],
  });
  assert.deepEqual(parameterizedSufficiency.metadata.failure_modes, ["missing_context_digest"]);
  assert.deepEqual(parameterizedSufficiency.metadata.failure_mode_details, [
    "missing_context_digest:pm_product_sufficiency",
  ]);
  assert.equal(normalizeFailureMode("missing_context_digest:pm_product_sufficiency"), "missing_context_digest");

  const terminalOutputSufficiency = evaluateAcceptedPacketSufficiencyOffline({
    terminalOutput: {
      outcome: "pause",
      reason: "discovery_needed",
      context_digest: "",
      source_refs: null,
      assumptions: [],
      constraints: [],
      risks: [],
      discovery_issues: [{ title: "Find source" }],
    },
  });
  assert.deepEqual(terminalOutputSufficiency.metadata.failure_modes, [
    "missing_context_digest",
    "missing_source_refs",
    "missing_pause_open_questions",
    "missing_project_update",
    "missing_discovery_issue_body",
  ]);
  assert.deepEqual(terminalOutputSufficiency.metadata.failure_mode_details, [
    "missing_context_digest:orchestrator_output",
    "missing_source_refs:orchestrator_output",
    "missing_pause_open_questions:orchestrator_output",
    "missing_project_update:orchestrator_output",
    "missing_discovery_issue_body:orchestrator_output",
  ]);
  assert.equal(
    normalizeFailureMode("missing_context_digest:orchestrator_output"),
    "missing_context_digest",
  );

  const evaluatorAnnotations = [
    passingQuality,
    failingQuality,
    failingSufficiency,
    parameterizedSufficiency,
    terminalOutputSufficiency,
    pauseState,
  ];
  for (const annotation of evaluatorAnnotations) {
    assertValid(
      annotationSchema,
      annotation,
      `evaluator output for "${annotation.name}" should satisfy the logical annotation shape`,
    );
    // Identifier is required: Phoenix upserts by (name, target, identifier).
    assert.match(annotation.identifier, /^[a-z0-9_]+$/);
    assert.equal(annotation.metadata.failure_taxonomy_version, FAILURE_TAXONOMY_VERSION);
    // Every emitted failure mode must be a canonical structural taxonomy id.
    for (const mode of annotation.metadata.failure_modes) {
      assert.ok(
        failureTaxonomy.structural.failure_modes.includes(mode),
        `CODE evaluator "${annotation.name}" emitted "${mode}", which is missing from failure-taxonomy.json structural.failure_modes`,
      );
    }
  }
  assert.deepEqual(
    [...new Set(evaluatorAnnotations.map((annotation) => annotation.identifier))],
    [
      "decomposition_quality_offline_v1",
      "accepted_packet_sufficiency_offline_v1",
      "pause_state_correctness_offline_v1",
    ],
    "each CODE evaluator keeps a distinct, stable identifier",
  );
  assert.equal(failingSufficiency.score, 0, "binary CODE score must stay schema-valid");
});

test("failure taxonomy is versioned and seeded from the documented taxonomy", () => {
  assert.equal(failureTaxonomy.schema_version, "teami-failure-taxonomy/v1");
  assert.equal(failureTaxonomy.failure_taxonomy_version, "1.0.0");
  assert.deepEqual(failureTaxonomy.workflows.roadmap_decomposition.failure_modes, [
    "duplicated_project_truth",
    "missing_acceptance_criteria",
    "prose_dependency_instead_of_relation",
    "wrong_agent_routing",
    "issue_not_independently_executable",
    "product_question_not_escalated",
    "architecture_constraint_missed",
    "missing_exact_project_update_markdown",
    "missing_exact_open_questions_markdown",
    "warm_continuation_missing",
  ]);
  assert.equal(failureTaxonomy.workflows.code_review.failure_modes.length, 5);
  assert.equal(failureTaxonomy.workflows.documentation.failure_modes.length, 3);
  const sections = [...Object.values(failureTaxonomy.workflows), failureTaxonomy.structural];
  for (const section of sections) {
    const modes = section.failure_modes;
    assert.equal(new Set(modes).size, modes.length, "failure mode ids must be unique");
    for (const mode of modes) assert.match(mode, /^[a-z0-9_]+$/);
  }
});

test("structural taxonomy section mirrors quality.mjs CODE emissions exactly", () => {
  // The structural section must contain exactly the base ids quality.mjs can
  // emit. STRUCTURAL_FAILURE_MODES is exported by quality.mjs next to the
  // emission sites, so a new emission fails this test until the taxonomy is
  // updated alongside it (and vice versa for taxonomy-only entries).
  assert.deepEqual(
    failureTaxonomy.structural.failure_modes,
    [...STRUCTURAL_FAILURE_MODES],
    "failure-taxonomy.json structural.failure_modes must equal quality.mjs STRUCTURAL_FAILURE_MODES (same ids, same order)",
  );
  // Version stamp on CODE emissions cannot drift from the taxonomy file.
  assert.equal(
    FAILURE_TAXONOMY_VERSION,
    failureTaxonomy.failure_taxonomy_version,
    "quality.mjs FAILURE_TAXONOMY_VERSION must match failure-taxonomy.json",
  );
  // Normalization contract: parameterized emissions strip to taxonomy base ids.
  assert.equal(normalizeFailureMode("missing_context_digest:pm_synthesis"), "missing_context_digest");
  assert.equal(
    normalizeFailureMode("missing_terminal_output:orchestrator_output"),
    "missing_terminal_output",
  );
  // Structural ids are base ids only - parameters never become taxonomy entries.
  for (const mode of STRUCTURAL_FAILURE_MODES) {
    assert.equal(normalizeFailureMode(mode), mode, `structural taxonomy id "${mode}" must be a base id`);
  }
});

test("phoenix asset manifest pins origin, package, project, and the single candidate tag", () => {
  assert.equal(phoenixAssets.schema_version, 1);
  assert.equal(phoenixAssets.phoenix.expected_origin, DEFAULT_PHOENIX_APP_URL);
  assert.equal(phoenixAssets.phoenix.server_package_pin, DEFAULT_PHOENIX_PACKAGE);
  assert.equal(phoenixAssets.phoenix.project_name, DEFAULT_PHOENIX_PROJECT);

  assert.deepEqual(phoenixAssets.prompts.map((prompt) => prompt.target_key), [
    "prompt/decomposition/decomposition_quality_judge",
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/sr_eng_grounding_pass",
    "prompt/decomposition/pm_synthesis",
    "prompt/decomposition/sr_eng_blocker_check",
    // The orchestrator governing prompt: an adopter-tunable persona prompt (the
    // same primitive as pm/sr_eng), seeded by I-2a. It carries a candidate_tag
    // like the other adopter-owned prompts; it is roster-excluded by identity
    // (it is the driver, not a subagent), not by any manifest flag.
    "prompt/decomposition/orchestrator_governing",
  ]);
  const judgePrompt = phoenixAssets.prompts.find(
    (prompt) => prompt.target_key === "prompt/decomposition/decomposition_quality_judge",
  );
  assert.equal(judgePrompt.role, "decomposition_quality_judge");
  // The judge is the maintainer-owned evaluator: it carries NO promotion-candidate
  // tag (belt-and-suspenders alongside the isAdopterSelfImprovementTarget exclusion),
  // while every adopter-owned prompt has exactly one candidate tag, no colon-delimited names.
  assert.equal(judgePrompt.candidate_tag, undefined);
  for (const prompt of phoenixAssets.prompts) {
    if (prompt.target_key === "prompt/decomposition/decomposition_quality_judge") continue;
    assert.equal(prompt.candidate_tag, "teami_promotion_candidate");
  }
  // Updated by the human-merged sandbox PR #3 (first accepted behavior-diff
  // promotion): the judge prompt is now pinned to its Phoenix version.
  assert.equal(judgePrompt.prompt_version, "UHJvbXB0VmVyc2lvbjox");
  assert.equal(judgePrompt.accepted_prompt_version_id, "UHJvbXB0VmVyc2lvbjox");
  assert.equal(judgePrompt.rubric_version, "1.0.0");
  assert.equal(judgePrompt.failure_taxonomy_version, failureTaxonomy.failure_taxonomy_version);
  assert.ok(
    fs.existsSync(path.join(repoRoot, judgePrompt.snapshot_path)),
    `snapshot_path does not exist: ${judgePrompt.snapshot_path}`,
  );
  assert.match(
    judgePrompt.snapshot_sha256 ?? "",
    /^[0-9a-f]{64}$/,
    "snapshot_sha256 must content-address the accepted prompt snapshot even before a Phoenix version pin exists",
  );

  const codeEvaluator = phoenixAssets.evaluators.find((evaluator) => evaluator.kind === "code");
  assert.ok(codeEvaluator, "manifest must pin the accepted code evaluator");
  const codeFile = codeEvaluator.code_path.split("#")[0];
  assert.ok(fs.existsSync(path.join(repoRoot, codeFile)), `code_path does not exist: ${codeFile}`);
  const llmEvaluator = phoenixAssets.evaluators.find((evaluator) => evaluator.kind === "llm");
  assert.equal(llmEvaluator.id, "decomposition_quality_judge_v1");
  assert.equal(llmEvaluator.prompt_version_id, null);

  const dataset = phoenixAssets.datasets[0];
  assert.equal(dataset.name, "teami-decomposition-examples");
  assert.match(dataset.dataset_id ?? "", /^[A-Za-z0-9+/=]+$/);
  assert.match(dataset.accepted_dataset_version_id ?? "", /^[A-Za-z0-9+/=]+$/);
  assert.equal(dataset.split_representation, "native");
  assert.equal(phoenixAssets.experiments.length, 2);
  const baselineExperiment = phoenixAssets.experiments.find(
    (entry) => entry.purpose === "baseline" && !entry.candidate_target_key,
  );
  assert.ok(baselineExperiment, "legacy (judge-target) baseline experiment entry exists");
  assert.match(baselineExperiment.experiment_id ?? "", /^[A-Za-z0-9+/=]+$/);
  assert.equal(baselineExperiment.dataset_id, dataset.dataset_id);
  assert.equal(baselineExperiment.dataset_version_id, dataset.accepted_dataset_version_id);
  assert.match(
    baselineExperiment.project_name ?? "",
    /^Experiment-[0-9a-f]{24}$/i,
    "baseline experiment project_name records Phoenix's generated experiment-run project, not the source trace project",
  );
  const srEngBaseline = phoenixAssets.experiments.find(
    (entry) => entry.candidate_target_key === "prompt/decomposition/sr_eng_grounding_pass",
  );
  assert.ok(srEngBaseline, "per-target sr_eng grounding baseline entry exists");
  assert.equal(srEngBaseline.purpose, "baseline");
  assert.match(srEngBaseline.experiment_id ?? "", /^[A-Za-z0-9+/=]+$/);
  assert.equal(srEngBaseline.dataset_id, dataset.dataset_id);
  assert.equal(srEngBaseline.dataset_version_id, dataset.accepted_dataset_version_id);
  const srEngPrompt = phoenixAssets.prompts.find(
    (entry) => entry.target_key === "prompt/decomposition/sr_eng_grounding_pass",
  );
  assert.equal(
    srEngBaseline.accepted_artifact_hash_vector.snapshot_sha256,
    srEngPrompt.snapshot_sha256,
    "per-target baseline hash vector pins the CURRENT accepted snapshot",
  );
  assert.equal(srEngBaseline.accepted_artifact_hash_vector.accepted_prompt_version_id, null);
  const runtimeRoleRule = phoenixAssets.rules.find(
    (entry) => entry.target_key === deriveCandidateTargetKey({ role_overrides: { pm: { model: "candidate" } } }),
  );
  assert.ok(runtimeRoleRule, "runtime-role rule entry exists");
  assert.equal(runtimeRoleRule.target_key, "rule/decomposition/runtime_role_assignments");
  assert.equal(runtimeRoleRule.artifact_kind, "runtime_role_defaults");
  assert.equal(
    runtimeRoleRule.artifact_path,
    "execution/evals/decomposition/accepted-runtime-roles.json",
  );
  assert.match(
    runtimeRoleRule.snapshot_sha256 ?? "",
    /^[0-9a-f]{64}$/,
    "runtime-role rule snapshot_sha256 must content-address the accepted rule artifact",
  );
  assert.deepEqual(Object.keys(phoenixAssets.evidence), [
    "annotation_ids",
    "receipt_run_ids",
    "pr_urls",
  ]);
  assert.ok(phoenixAssets.evidence.annotation_ids.length >= 1);
  assert.ok(phoenixAssets.evidence.receipt_run_ids.length >= 1);
});

test("accepted judge prompt snapshot hash matches the file bytes (drift fails CI)", () => {
  const judgePrompt = phoenixAssets.prompts[0];
  const snapshotBytes = fs.readFileSync(path.join(repoRoot, judgePrompt.snapshot_path));
  const actualSha256 = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
  assert.equal(
    judgePrompt.snapshot_sha256,
    actualSha256,
    [
      `phoenix-assets.json snapshot_sha256 is stale for ${judgePrompt.snapshot_path}.`,
      `Stored: ${judgePrompt.snapshot_sha256}; actual file content: ${actualSha256}.`,
      "Editing the accepted judge prompt is a PROCESS CHANGE: ship it through",
      "templates/process-change-proposal.md and update snapshot_sha256 to the new",
      "hash in the same change. Until a Phoenix prompt version pin exists, this",
      "hash IS the accepted baseline identity (accepted_baseline_id =",
      "sha256:<snapshot_sha256>), so silent drift would silently change accepted behavior.",
    ].join(" "),
  );
});

test("accepted runtime-role rule artifact hash matches the file bytes (drift fails CI)", () => {
  const runtimeRoleRule = phoenixAssets.rules.find(
    (entry) => entry.target_key === "rule/decomposition/runtime_role_assignments",
  );
  assert.ok(runtimeRoleRule, "runtime-role rule entry exists");
  const artifactBytes = fs.readFileSync(path.join(repoRoot, runtimeRoleRule.artifact_path));
  const actualSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  assert.equal(
    runtimeRoleRule.snapshot_sha256,
    actualSha256,
    [
      `phoenix-assets.json snapshot_sha256 is stale for ${runtimeRoleRule.artifact_path}.`,
      `Stored: ${runtimeRoleRule.snapshot_sha256}; actual file content: ${actualSha256}.`,
      "Editing the accepted runtime role defaults is a PROCESS CHANGE: ship it",
      "through templates/process-change-proposal.md and update snapshot_sha256",
      "to the new hash in the same change.",
    ].join(" "),
  );
});

test("rubric, judge prompt, and proposal template carry versions and required sections", () => {
  const rubric = fs.readFileSync(path.join(evalsDir, "rubrics", "decomposition-quality.md"), "utf8");
  assert.ok(rubric.includes("rubric_version: 1.0.0"));
  for (const dimension of QUALITY_DIMENSIONS) {
    assert.ok(rubric.includes(`\`${dimension}\``), `rubric is missing dimension "${dimension}"`);
  }
  for (const label of QUALITY_LABELS) {
    assert.ok(rubric.includes(`\`${label}\``), `rubric is missing label "${label}"`);
  }
  assert.ok(rubric.includes("0.80"), "rubric must document the score bands");

  const judgePrompt = fs.readFileSync(
    path.join(evalsDir, "accepted-prompts", "decomposition-quality-judge.md"),
    "utf8",
  );
  assert.ok(judgePrompt.includes("prompt_version: unpinned-initial"));
  for (const requiredInput of [
    "project intent",
    "terminal status",
    "Open Questions",
    "phase-packet",
    "rubric_version",
    "failure_taxonomy_version",
  ]) {
    assert.ok(
      judgePrompt.toLowerCase().includes(requiredInput.toLowerCase()),
      `judge prompt must state required input "${requiredInput}"`,
    );
  }
  for (const outputField of ['"label"', '"score"', '"explanation"', '"failure_modes"']) {
    assert.ok(judgePrompt.includes(outputField), `judge prompt must require output ${outputField}`);
  }

  const template = fs.readFileSync(
    path.join(evalsDir, "templates", "process-change-proposal.md"),
    "utf8",
  );
  for (const requiredSection of [
    "teami_promotion",
    "evidence_counts",
    "human_label_authenticity",
    "evidence_quality",
    "promotion_risk",
    "trigger_authenticity",
    "content_trust",
    "normalized_envelope_hash",
    "policy_hash",
    "proposal_state",
    "superseded_by",
    "requested_action",
    "phoenix_scope",
  ]) {
    assert.ok(template.includes(requiredSection), `proposal template is missing "${requiredSection}"`);
  }
  // The candidate_target_key grammar is canonical: dedupe/supersede/rejection
  // memory key on it, so the template must define it and ban free-form keys.
  assert.ok(
    template.includes("`<candidate_kind>/<scope>/<artifact_slot>`"),
    "proposal template must define the canonical candidate_target_key grammar",
  );
  assert.ok(
    template.includes("Free-form keys are invalid"),
    "proposal template must state that free-form candidate_target_keys are invalid",
  );
  const markerMatch = /```json\n([\s\S]*?)```/.exec(template);
  assert.ok(markerMatch, "proposal template must contain fenced JSON blocks");
  const fencedBlocks = [...template.matchAll(/```json\n([\s\S]*?)```/g)];
  const markerBlock = fencedBlocks.find((block) => block[1].includes("teami_promotion"));
  assert.ok(markerBlock, "proposal template must contain the machine-readable marker block");
  const marker = JSON.parse(markerBlock[1]);
  assert.equal(marker.teami_promotion.schema_version, 1);
  // The marker carries every normalized-envelope component the controller
  // cannot re-derive after the fact: requested action and Phoenix scope.
  assert.equal(marker.teami_promotion.requested_action, "propose_repo_change");
  assert.deepEqual(Object.keys(marker.teami_promotion.phoenix_scope), [
    "origin",
    "project_name",
  ]);
  // Evidence ids are structured and unambiguous: dataset evidence pins both
  // the dataset id and the exact dataset version id.
  const evidenceIds = marker.teami_promotion.evidence_ids;
  assert.deepEqual(Object.keys(evidenceIds), ["experiments", "datasets", "annotations"]);
  assert.ok(Array.isArray(evidenceIds.experiments));
  assert.ok(Array.isArray(evidenceIds.annotations));
  assert.ok(evidenceIds.experiments.every((entry) => typeof entry === "string"));
  assert.ok(evidenceIds.annotations.every((entry) => typeof entry === "string"));
  assert.ok(Array.isArray(evidenceIds.datasets) && evidenceIds.datasets.length > 0);
  for (const datasetEvidence of evidenceIds.datasets) {
    assert.deepEqual(Object.keys(datasetEvidence), ["dataset_id", "dataset_version_id"]);
  }
});
