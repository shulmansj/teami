import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  FAILURE_TAXONOMY_VERSION,
  findBannedWorkflowStateMetadataKeys,
  RICH_EXAMPLE_DATASET_NAME,
  resolveEvalContract,
  RUBRIC_VERSION,
} from "./eval-annotation-contract.mjs";
import {
  fetchPhoenixTraceAnnotations,
  normalizePhoenixAnnotation,
} from "./eval-status.mjs";
import {
  buildJudgeFixtureInput,
  buildJudgeInputs,
  judgeAllowedFailureModes,
} from "./decomposition-quality-judge.mjs";
import {
  findTokenShapedContent,
  RICH_EXAMPLE_CONTENT_POLICY,
  sanitizeAndClassifyContent,
} from "./eval-content-gate.mjs";
import { schemaErrors } from "./eval-structural-validator.mjs";
import {
  DEFAULT_PHOENIX_PROJECT,
  ensurePhoenixReady,
} from "./local-phoenix-manager.mjs";
import {
  canonicalJsonStringify,
  loadCapturedProjectSnapshot,
} from "./project-snapshot-store.mjs";
import { defaultRunStoreDir, readRunArtifact, renameWithRetry } from "../../../engine/run-store.mjs";
import {
  isInvalidTraceReceiptResult,
  readTraceReceipt,
} from "./trace-status-store.mjs";
import {
  assignDatasetSplit,
  loadWorkspaceEvalPolicy,
  resolveProjectCategory,
  resolveProjectImpactLevel,
} from "./workspace-eval-policy.mjs";
import {
  decompositionEvalNamespacePath,
  resolveDecompositionEvalPath,
} from "./workflows/decomposition/eval-paths.mjs";
import { decompositionDefinition } from "./workflows/decomposition/definition.mjs";

// Rich decomposition example promotion (Track B), behind the explicit
// `npm run phoenix:promote-decomposition` command. Pipeline per the plan's
// Rich Promotion State diagram:
//
//   candidate_run -> load_receipt -> load_run_artifact
//     -> load_captured_project_snapshot   (NEVER live Linear; CONSTRAINTS #28)
//     -> sanitize_and_classify_content    (field-level allowlist/denylist gate)
//          rejected_unsanitized -> needs_sanitization
//          missing inputs / token_or_secret_like -> cannot_promote
//          accepted -> upload_dataset_example (native splits at upload)
//     -> record_dataset_receipt           (local; idempotency lives here)
//
// The pinned Phoenix server IGNORES example_ids on /v1/datasets/upload
// (PHOENIX-CAPABILITIES RISK 2), so re-uploading the same run would append a
// duplicate example. Idempotency is therefore CLIENT-SIDE: the local promotion
// receipt records the example content hash per dataset; an unchanged re-run is
// reported as idempotent reuse without any upload, and changed content
// requires an explicit --force-new-version.

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const exampleSchema = JSON.parse(
  fs.readFileSync(
    resolveDecompositionEvalPath(MODULE_REPO_ROOT, decompositionEvalNamespacePath("example.schema.json")),
    "utf8",
  ),
);

export const EXAMPLE_SCHEMA_ID = exampleSchema.$id;
export const PROMOTION_RECEIPT_SCHEMA_VERSION = "linear-decomposition-promotion-receipt/v1";
export const DEFAULT_RICH_DATASET_NAME = RICH_EXAMPLE_DATASET_NAME;

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function richExampleId(runId) {
  return `teami:${runId}`;
}

export function promotionReceiptPath({ runId, repoRoot = process.cwd(), runStoreDir = null } = {}) {
  if (!runId || typeof runId !== "string" || !SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run_id for local promotion receipt store: ${runId}`);
  }
  return path.join(runStoreDir || defaultRunStoreDir(repoRoot), `${runId}.promotion.json`);
}

// Tolerant-shape promotion receipt (the worklist already reads
// `{ datasets: [{ name, ... }] }`); promotion events are APPEND-ONLY
// (CONSTRAINTS #21: never rewrite prior receipt facts).
export function readPromotionReceipt({ runId, repoRoot = process.cwd(), runStoreDir = null } = {}) {
  const filePath = promotionReceiptPath({ runId, repoRoot, runStoreDir });
  if (!fs.existsSync(filePath)) return { ok: true, exists: false, path: filePath, receipt: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, exists: true, path: filePath, receipt: parsed };
  } catch (error) {
    // An unreadable receipt means prior promotion facts are unknown; fail
    // closed instead of risking a duplicate upload.
    return { ok: false, exists: true, path: filePath, reason: "promotion_receipt_unreadable", error: error.message };
  }
}

export function validateExampleAgainstSchema(example) {
  return schemaErrors(exampleSchema, example, exampleSchema);
}

export function computeExampleContentHash(example) {
  return createHash("sha256").update(canonicalJsonStringify(example), "utf8").digest("hex");
}

function runtimeRoleIdentity(assignment) {
  if (typeof assignment === "string") return assignment;
  if (assignment && typeof assignment === "object" && assignment.runtime && assignment.model) {
    return `${assignment.runtime}/${assignment.model}`;
  }
  return null;
}

function dependencyRelationsFromIssues(issues) {
  const relations = [];
  for (const issue of issues || []) {
    const blocked = issue?.decomposition_key || issue?.decompositionKey || null;
    const dependsOn = issue?.depends_on || issue?.dependsOn || [];
    if (!blocked || !Array.isArray(dependsOn)) continue;
    for (const blocking of dependsOn) {
      if (typeof blocking === "string" && blocking) relations.push({ blocking, blocked });
    }
  }
  return relations;
}

function terminalStateFromArtifact(artifact) {
  if (!isRecord(artifact)) return { ok: false, cause: "missing_artifact" };
  const terminalOutput = isRecord(artifact?.terminal_output) ? artifact.terminal_output : null;
  if (artifact.kind === "commit") {
    if (!terminalOutput) return { ok: false, cause: "missing_terminal_output" };
    return {
      ok: true,
      terminal_status: "completed",
      terminal_reason: terminalOutput.reason || "synthesis_complete",
      project_update_markdown: artifact.project_update_markdown,
      open_questions_markdown: null,
      final_issues: artifact.final_issues || [],
      discovery_issues: artifact.discovery_issues || [],
    };
  }
  if (artifact.kind === "pause") {
    if (!terminalOutput) return { ok: false, cause: "missing_terminal_output" };
    const pausePacket = artifact.pause_packet;
    if (!pausePacket?.reason) {
      return { ok: false, cause: "missing_pause_packet" };
    }
    return {
      ok: true,
      terminal_status: terminalOutput.outcome === "failed_closed" ? "failed_closed" : "paused",
      terminal_reason: terminalOutput.reason || pausePacket.reason,
      project_update_markdown: pausePacket.project_update_markdown ?? null,
      open_questions_markdown: pausePacket.open_questions_markdown ?? null,
      final_issues: [],
      discovery_issues: artifact.discovery_issues || [],
    };
  }
  // checkpoint/resume artifacts are not terminal run records; rich examples
  // promote only terminal outcomes.
  return { ok: false, cause: "run_not_terminal", kind: artifact.kind };
}

function terminalOutputSummary(artifact, terminal) {
  const terminalOutput = artifact.terminal_output;
  return {
    schema_version: terminalOutput.schema_version,
    run_id: terminalOutput.run_id || artifact.run_id,
    phase: "orchestrator_output",
    status: terminalOutput.outcome,
    reason: terminalOutput.reason,
    context_digest: terminalOutput.context_digest,
    source_refs: Array.isArray(terminalOutput.source_refs) ? terminalOutput.source_refs : [],
    assumptions: Array.isArray(terminalOutput.assumptions) ? terminalOutput.assumptions : [],
    constraints: Array.isArray(terminalOutput.constraints) ? terminalOutput.constraints : [],
    risks: Array.isArray(terminalOutput.risks) ? terminalOutput.risks : [],
    ...(terminal.project_update_markdown !== null && terminal.project_update_markdown !== undefined
      ? { project_update_markdown: terminal.project_update_markdown }
      : {}),
    ...(terminal.open_questions_markdown !== null && terminal.open_questions_markdown !== undefined
      ? { open_questions_markdown: terminal.open_questions_markdown }
      : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decompositionEvalContract(repoRoot = MODULE_REPO_ROOT) {
  const contract = resolveEvalContract(decompositionDefinition, repoRoot);
  if (contract.eval_configured === true || path.resolve(repoRoot) === MODULE_REPO_ROOT) return contract;
  return resolveEvalContract(decompositionDefinition, MODULE_REPO_ROOT);
}

function labelAliasToNamespaceLabel(label, contract) {
  const raw = String(label ?? "").trim();
  if (!raw) throw new Error("human_fixture_label_required");
  if (contract.quality_labels.includes(raw)) return raw;
  const normalized = raw.toLowerCase();
  if (normalized === "good" && contract.quality_labels.includes("pass")) return "pass";
  if (normalized === "bad") {
    const negativeLabels = contract.quality_labels.filter((candidate) => candidate !== "pass");
    if (negativeLabels.length === 1) return negativeLabels[0];
    throw new Error("human_fixture_label_ambiguous:bad");
  }
  throw new Error(`human_fixture_label_outside_namespace:${raw}`);
}

export function freezeHumanFixtureLabel({
  label,
  score = null,
  annotatorId = null,
  labeledAt = null,
  evalContract = decompositionEvalContract(),
} = {}) {
  if (!evalContract || evalContract.eval_configured !== true) {
    throw new Error(evalContract?.reason || "workflow_eval_not_configured");
  }
  const expectedLabel = labelAliasToNamespaceLabel(label, evalContract);
  const frozen = {
    expected_label: expectedLabel,
    provenance: {
      label_source: "explicit_human",
      label_status: "GOLD",
      labeled_at: normalizeIsoTimestamp(labeledAt, "labeled_at"),
      ...(textOrNull(annotatorId) ? { annotator_id: textOrNull(annotatorId) } : {}),
    },
  };
  if (score !== null && score !== undefined) {
    const numericScore = Number(score);
    if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 1) {
      throw new Error("expected_score_must_be_number_in_0_1");
    }
    frozen.expected_score = numericScore;
  }
  return frozen;
}

function freezeHumanFixtureLabelResult(options = {}) {
  try {
    return { ok: true, frozen: freezeHumanFixtureLabel(options) };
  } catch (error) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: error.message || "human_fixture_label_invalid",
    };
  }
}

async function resolveFrozenHumanFixtureLabelFromPhoenix({
  annotationIds = [],
  traceId,
  appUrl,
  projectName,
  fetchImpl,
  evalContract,
  now,
} = {}) {
  const requestedIds = [...new Set(annotationIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (requestedIds.length === 0) return { ok: true, frozen: null };
  if (!traceId) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "human_fixture_label_source_trace_missing",
      detail: "Annotation ids were supplied, but the run has no source trace id to resolve and freeze the HUMAN label.",
    };
  }
  let rawAnnotations;
  try {
    rawAnnotations = await fetchPhoenixTraceAnnotations({
      appUrl,
      projectName,
      traceId,
      fetchImpl,
    });
  } catch (error) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "human_fixture_annotations_unreadable",
      detail: error.message,
    };
  }
  const requested = new Set(requestedIds);
  const selected = rawAnnotations
    .filter((entry) => requested.has(String(entry?.id ?? "")))
    .map((entry) => ({
      raw: entry,
      normalized: normalizePhoenixAnnotation(entry),
    }));
  const resolvedIds = new Set(selected.map((entry) => String(entry.raw?.id ?? "")));
  const unresolved = requestedIds.filter((id) => !resolvedIds.has(id));
  if (unresolved.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "human_fixture_annotation_ids_unresolved",
      missing_annotation_ids: unresolved,
    };
  }
  const nonHuman = selected.filter((entry) => entry.normalized.annotator_kind !== "HUMAN");
  if (nonHuman.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "human_fixture_label_requires_human_annotation",
      annotation_ids: nonHuman.map((entry) => entry.raw?.id).filter(Boolean),
    };
  }
  const rollUpName = evalContract.roll_up_annotation_name;
  const rollUps = selected.filter((entry) => entry.normalized.name === rollUpName);
  if (rollUps.length !== 1) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: rollUps.length === 0
        ? "human_fixture_rollup_annotation_missing"
        : "human_fixture_rollup_annotation_ambiguous",
      annotation_name: rollUpName,
    };
  }
  const annotation = rollUps[0];
  return freezeHumanFixtureLabelResult({
    label: annotation.normalized.label,
    score: annotation.normalized.score,
    annotatorId: annotation.normalized.identifier,
    labeledAt: annotationTimestamp(annotation.raw) || now(),
    evalContract,
  });
}

function annotationTimestamp(raw = {}) {
  const candidates = [
    raw?.metadata?.labeled_at,
    raw?.created_at,
    raw?.updated_at,
    raw?.inserted_at,
  ];
  return candidates.find((candidate) =>
    typeof candidate === "string" && candidate.trim() !== "" && !Number.isNaN(Date.parse(candidate))) || null;
}

function normalizeIsoTimestamp(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text || Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName}_invalid`);
  }
  return new Date(text).toISOString();
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function producedIdentityRefsFromArtifact(artifact = {}) {
  if (!Array.isArray(artifact?.produced_identities)) return [];
  const refs = [];
  for (const entry of artifact.produced_identities) {
    if (!isRecord(entry)) continue;
    const effectId = textOrNull(entry.effect_id);
    const provider = textOrNull(entry.provider);
    const resourceKind = textOrNull(entry.resource_kind);
    const targetIds = Array.isArray(entry.target_ids)
      ? [...new Set(entry.target_ids.map(textOrNull).filter(Boolean))]
      : [];
    if (!effectId || !provider || !resourceKind) continue;
    refs.push({
      effect_id: effectId,
      provider,
      resource_kind: resourceKind,
      target_ids: targetIds,
    });
  }
  return refs;
}

function sourceTargetIdsFromProducedRefs(producedIdentityRefs = []) {
  return [
    ...new Set(
      producedIdentityRefs
        .flatMap((entry) => Array.isArray(entry.target_ids) ? entry.target_ids : [])
        .map(textOrNull)
        .filter(Boolean),
    ),
  ];
}

// Assembles, gates, and validates one rich decomposition example. Pure with
// respect to Phoenix: no network access here. This is the D-capture projection
// for decomposition fixtures: it projects the captured run through
// resolveEvalContract(...).judge_input_contract via buildJudgeInputs, and a
// short Judge input is quarantined as cannot_promote rather than uploaded.
// Returns fail-closed result objects (never partially assembled examples).
export function buildRichDecompositionExample({
  receipt,
  artifact,
  snapshot,
  policy,
  explicitSplit = null,
  annotationIds = [],
  humanFixtureLabel = null,
  additionalMetadata = {},
  evalContract = decompositionEvalContract(),
} = {}) {
  const terminal = terminalStateFromArtifact(artifact);
  if (!terminal.ok) {
    return { ok: false, state: "cannot_promote", reason: terminal.cause, run_id: artifact?.run_id };
  }

  const exampleId = richExampleId(artifact.run_id);
  let splitAssignment;
  try {
    splitAssignment = assignDatasetSplit(policy, { exampleId, explicitSplit });
  } catch (error) {
    return { ok: false, state: "cannot_promote", reason: "invalid_split_request", error: error.message };
  }

  const category = resolveProjectCategory(policy, {
    projectId: snapshot.project?.id,
    projectName: snapshot.project?.name,
  });
  const impact = resolveProjectImpactLevel(policy, {
    projectId: snapshot.project?.id,
    projectName: snapshot.project?.name,
  });
  const builtJudgeInput = buildJudgeInputs({
    artifact,
    snapshot,
    allowedFailureModes: judgeAllowedFailureModes(),
  });
  if (!builtJudgeInput.ok) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: builtJudgeInput.reason,
      run_id: artifact.run_id,
      failures: builtJudgeInput.failures || [],
    };
  }
  const fixtureInput = buildJudgeFixtureInput({ judgeInputs: builtJudgeInput.inputs });
  if (!fixtureInput.ok) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: fixtureInput.reason,
      run_id: artifact.run_id,
      failures: fixtureInput.failures || [],
    };
  }

  const producedIdentityRefs = producedIdentityRefsFromArtifact(artifact);
  const metadata = {
    workspace_maturity: policy.workspace_maturity,
    project_category: category.value,
    project_impact_level: impact.value,
    lifecycle_state: "active",
    dataset_split: splitAssignment.split,
    process_version: artifact.workflow_version,
    rubric_version: RUBRIC_VERSION,
    failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    source_trace_id: receipt.trace_id || null,
    source_run_id: artifact.run_id,
    content_retention: "rich_local",
    ...additionalMetadata,
    source_target_ids: sourceTargetIdsFromProducedRefs(producedIdentityRefs),
    produced_identity_refs: producedIdentityRefs,
  };
  const bannedKeys = findBannedWorkflowStateMetadataKeys(metadata);
  if (bannedKeys.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: `workflow_state_keys_banned_in_phoenix_metadata:${bannedKeys.join(",")}`,
    };
  }

  // Raw assembly copies source records WHOLE; the content gate owns every
  // removal/transform so nothing is dropped silently and unknown fields
  // reject into needs_sanitization.
  let frozenHumanLabel = null;
  if (humanFixtureLabel) {
    const freeze = freezeHumanFixtureLabelResult({
      label: humanFixtureLabel.expected_label ?? humanFixtureLabel.label,
      score: humanFixtureLabel.expected_score ?? humanFixtureLabel.score ?? null,
      annotatorId: humanFixtureLabel.provenance?.annotator_id ?? humanFixtureLabel.annotator_id ?? humanFixtureLabel.annotatorId ?? null,
      labeledAt: humanFixtureLabel.provenance?.labeled_at ?? humanFixtureLabel.labeled_at ?? humanFixtureLabel.labeledAt ?? null,
      evalContract,
    });
    if (!freeze.ok) return freeze;
    frozenHumanLabel = freeze.frozen;
  }

  const rawExample = {
    schema_version: EXAMPLE_SCHEMA_ID,
    input: {
      gradeability: fixtureInput.gradeability,
      judge_fixture_input: fixtureInput.judge_fixture_input,
      maintainer_supplied_context: fixtureInput.maintainer_supplied_context,
      source_type: "linear_project_snapshot",
      project: snapshot.project,
      run_envelope: {
        workflow_version: artifact.workflow_version,
        allowed_source_boundaries: artifact.allowed_source_boundaries || [],
        runtime_assignments: {
          pm: runtimeRoleIdentity(artifact.runtime_assignments?.pm),
          sr_eng: runtimeRoleIdentity(artifact.runtime_assignments?.sr_eng),
        },
      },
      source_refs: [],
    },
    output: {
      terminal_status: terminal.terminal_status,
      terminal_reason: terminal.terminal_reason,
      phase_packets: [terminalOutputSummary(artifact, terminal)],
      final_issues: terminal.final_issues,
      discovery_issues: terminal.discovery_issues,
      dependency_relations: dependencyRelationsFromIssues(terminal.final_issues),
      ...(terminal.project_update_markdown !== null && terminal.project_update_markdown !== undefined
        ? { project_update_markdown: terminal.project_update_markdown }
        : {}),
      ...(terminal.open_questions_markdown !== null && terminal.open_questions_markdown !== undefined
        ? { open_questions_markdown: terminal.open_questions_markdown }
        : {}),
    },
    reference: {
      // Human judgments live in Phoenix annotations; in MVP the example
      // carries asserted annotation IDs when explicitly supplied.
      human_annotations: [],
      ...(annotationIds.length > 0 ? { human_annotation_ids: [...annotationIds] } : {}),
      ...(frozenHumanLabel || {}),
    },
    metadata,
  };

  const gate = sanitizeAndClassifyContent({
    value: rawExample,
    policy: RICH_EXAMPLE_CONTENT_POLICY,
    label: "rich_decomposition_example",
  });
  if (!gate.ok) return gate;

  const example = gate.value;
  const validationErrors = validateExampleAgainstSchema(example);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "example_schema_mismatch",
      schema_errors: validationErrors,
      report: gate.report,
    };
  }

  return {
    ok: true,
    example,
    example_id: exampleId,
    content_hash: computeExampleContentHash(example),
    split_assignment: splitAssignment,
    project_category: category,
    project_impact_level: impact,
    sanitizer_report: gate.report,
  };
}

export function buildRichDatasetUploadPayload({
  example,
  exampleId,
  datasetName = DEFAULT_RICH_DATASET_NAME,
  action = "append",
  includeSplits = true,
} = {}) {
  const payload = {
    name: datasetName,
    action,
    description: "Teami curated decomposition examples (rich, policy-gated, local custody).",
    inputs: [example.input],
    outputs: [example.output],
    metadata: [{
      ...example.metadata,
      schema_version: example.schema_version,
      reference: example.reference,
    }],
    span_ids: [null],
    // The pinned server ignores example_ids (known bug); sent for forward
    // compatibility only — idempotency stays client-side in the local receipt.
    example_ids: [exampleId],
  };
  if (includeSplits) payload.splits = [example.metadata.dataset_split];
  const secretPaths = findTokenShapedContent(payload);
  if (secretPaths.length > 0) {
    throw new Error(`rich_promotion_payload_contains_token_material:${secretPaths.join(",")}`);
  }
  return payload;
}

export async function promoteRichDecompositionExample({
  repoRoot = process.cwd(),
  runId,
  datasetName = DEFAULT_RICH_DATASET_NAME,
  annotationIds = [],
  explicitSplit = null,
  forceNewVersion = false,
  additionalMetadata = {},
  runStoreDir = null,
  policyPath = undefined,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!runId || typeof runId !== "string" || !SAFE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, state: "cannot_promote", reason: "invalid_run_id", run_id: runId ?? null };
  }

  // 1. Local trace receipt (.agent-shell/telemetry/runs/<run_id>.json).
  const receipt = readTraceReceipt({ repoRoot, runId });
  if (isInvalidTraceReceiptResult(receipt)) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: receipt.reason,
      run_id: runId,
      detail: `${receipt.detail}; re-run the source workflow to write a current domain-identity trace receipt.`,
      repairable: true,
      trace_receipt_path: receipt.path,
    };
  }
  if (!receipt) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "missing_trace_receipt",
      run_id: runId,
      detail: `No local trace receipt found for run ${runId} under .agent-shell/telemetry/runs/.`,
    };
  }

  // 2. Local run artifact (.teami/runs/<run_id>.json).
  let artifact;
  try {
    artifact = readRunArtifact({ runId, repoRoot, runStoreDir });
  } catch (error) {
    return { ok: false, state: "cannot_promote", reason: "invalid_run_artifact", run_id: runId, detail: error.message };
  }
  if (!artifact) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "missing_run_artifact",
      run_id: runId,
      detail: `No local run artifact found for run ${runId} under .teami/runs/.`,
    };
  }

  // 3. Captured project snapshot. Fail closed when absent: rich promotion has
  // NO live-Linear fallback by design (CONSTRAINTS #28).
  const snapshotResult = loadCapturedProjectSnapshot(runId, { repoRoot, runStoreDir });
  if (!snapshotResult.ok) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: snapshotResult.reason,
      run_id: runId,
      detail: `Rich promotion requires the captured-at-run project snapshot (${snapshotResult.path || "no path"}); live Linear state is never used at promotion time.`,
      failures: snapshotResult.failures,
    };
  }

  // 4. Repo-owned workspace eval policy (human-set values + split rule).
  const policy = loadWorkspaceEvalPolicy(policyPath ? { policyPath } : {});

  const evalContract = decompositionEvalContract(repoRoot);
  let ready = null;
  let humanFixtureLabel = null;
  if (annotationIds.length > 0) {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
    if (!ready.ok) {
      return { ok: false, state: "cannot_promote", reason: ready.reason || "local_phoenix_unavailable", run_id: runId };
    }
    const freeze = await resolveFrozenHumanFixtureLabelFromPhoenix({
      annotationIds,
      traceId: receipt.trace_id || null,
      appUrl: ready.appUrl,
      projectName: ready.projectName || DEFAULT_PHOENIX_PROJECT,
      fetchImpl,
      evalContract,
      now,
    });
    if (!freeze.ok) return { run_id: runId, ...freeze };
    humanFixtureLabel = freeze.frozen;
  }

  // 5. Assemble + gate + validate.
  const build = buildRichDecompositionExample({
    receipt,
    artifact,
    snapshot: snapshotResult.snapshot,
    policy,
    explicitSplit,
    annotationIds,
    humanFixtureLabel,
    additionalMetadata,
    evalContract,
  });
  if (!build.ok) return { run_id: runId, ...build };

  // 6. Client-side idempotency via the local promotion receipt.
  const existing = readPromotionReceipt({ runId, repoRoot, runStoreDir });
  if (!existing.ok) {
    return { ok: false, state: "cannot_promote", reason: existing.reason, run_id: runId, path: existing.path };
  }
  const datasets = Array.isArray(existing.receipt?.datasets) ? existing.receipt.datasets : [];
  const datasetEntry = datasets.find((entry) => entry?.name === datasetName) || null;
  const priorPromotions = Array.isArray(datasetEntry?.promotions) ? datasetEntry.promotions : [];
  const latest = priorPromotions.at(-1) || null;
  if (latest) {
    if (latest.example_content_hash === build.content_hash) {
      return {
        ok: true,
        idempotent: true,
        uploaded: false,
        run_id: runId,
        datasetName,
        dataset_id: datasetEntry.dataset_id ?? latest.dataset_id ?? null,
        dataset_version_id: latest.dataset_version_id ?? null,
        split: latest.split ?? build.split_assignment.split,
        split_assignment: latest.split_assignment ?? null,
        example_id: build.example_id,
        example_content_hash: build.content_hash,
        detail: `Run ${runId} was already promoted to dataset "${datasetName}" with identical content; reusing the recorded promotion (no re-upload).`,
        receipt_path: existing.path,
      };
    }
    if (!forceNewVersion) {
      return {
        ok: false,
        state: "duplicate_changed_content",
        reason: "already_promoted_with_different_content",
        run_id: runId,
        datasetName,
        previous_content_hash: latest.example_content_hash ?? null,
        new_content_hash: build.content_hash,
        detail: `Run ${runId} was already promoted to dataset "${datasetName}" but the assembled example content has changed. Re-promoting would append a NEW example (the pinned Phoenix ignores example_ids). Pass --force-new-version to promote the changed content as a new example version.`,
        receipt_path: existing.path,
      };
    }
  }

  // 7. Upload to local Phoenix with native split assignment.
  ready = ready || await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) {
    return { ok: false, state: "cannot_promote", reason: ready.reason || "local_phoenix_unavailable", run_id: runId };
  }
  const action = await resolveDatasetAction({ appUrl: ready.appUrl, datasetName, fetchImpl });

  let uploadBody;
  let splitWritePath = "native";
  let splitNote = null;
  try {
    uploadBody = await phoenixFetchJson({
      appUrl: ready.appUrl,
      pathname: "/v1/datasets/upload",
      searchParams: { sync: "true" },
      method: "POST",
      fetchImpl,
      payload: buildRichDatasetUploadPayload({
        example: build.example,
        exampleId: build.example_id,
        datasetName,
        action,
        includeSplits: true,
      }),
    });
  } catch (error) {
    if (!/split/i.test(error.message)) throw error;
    // Native split write path unavailable: fall back to the metadata mirror
    // and DISCLOSE it — never claim native split evidence (CONSTRAINTS #31).
    splitWritePath = "metadata_fallback";
    splitNote =
      "Native Phoenix split write failed at upload; split recorded as metadata.dataset_split only. "
      + "Assign the native split in the Phoenix dataset UI to restore full evidence quality; "
      + "native split membership wins over metadata when both exist.";
    onProgress(`WARNING ${splitNote}`);
    uploadBody = await phoenixFetchJson({
      appUrl: ready.appUrl,
      pathname: "/v1/datasets/upload",
      searchParams: { sync: "true" },
      method: "POST",
      fetchImpl,
      payload: buildRichDatasetUploadPayload({
        example: build.example,
        exampleId: build.example_id,
        datasetName,
        action,
        includeSplits: false,
      }),
    });
  }
  const dataset = uploadBody?.data || {};

  // 8. Record the local dataset receipt (append-only promotion events). The
  // sanitizer report lives HERE and in command output — never in Phoenix.
  const promotionEvent = {
    promoted_at: now(),
    action,
    dataset_id: dataset.dataset_id ?? null,
    dataset_version_id: dataset.version_id ?? null,
    example_id: build.example_id,
    example_content_hash: build.content_hash,
    split: build.split_assignment.split,
    split_method: build.split_assignment.method,
    split_assignment: splitWritePath,
    split_assignment_note: splitNote,
    annotation_ids: [...annotationIds],
    content_retention: "rich_local",
    forced_new_version: Boolean(latest),
    sanitizer_report: build.sanitizer_report,
  };
  const receiptPath = writePromotionReceipt({
    runId,
    repoRoot,
    runStoreDir,
    existingReceipt: existing.receipt,
    datasetName,
    promotionEvent,
  });

  return {
    ok: true,
    idempotent: false,
    uploaded: true,
    run_id: runId,
    appUrl: ready.appUrl,
    datasetName,
    action,
    dataset_id: promotionEvent.dataset_id,
    dataset_version_id: promotionEvent.dataset_version_id,
    example_id: build.example_id,
    example_content_hash: build.content_hash,
    split: promotionEvent.split,
    split_assignment: splitWritePath,
    split_assignment_note: splitNote,
    annotation_ids: promotionEvent.annotation_ids,
    sanitizer_report: build.sanitizer_report,
    receipt_path: receiptPath,
  };
}

function writePromotionReceipt({
  runId,
  repoRoot,
  runStoreDir,
  existingReceipt,
  datasetName,
  promotionEvent,
}) {
  const filePath = promotionReceiptPath({ runId, repoRoot, runStoreDir });
  const datasets = Array.isArray(existingReceipt?.datasets)
    ? existingReceipt.datasets.map((entry) => ({ ...entry }))
    : [];
  let entry = datasets.find((candidate) => candidate?.name === datasetName);
  if (!entry) {
    entry = { name: datasetName, dataset_id: promotionEvent.dataset_id, promotions: [] };
    datasets.push(entry);
  }
  entry.dataset_id = promotionEvent.dataset_id ?? entry.dataset_id ?? null;
  entry.promotions = [...(entry.promotions || []), promotionEvent];

  const receipt = {
    schema_version: PROMOTION_RECEIPT_SCHEMA_VERSION,
    run_id: runId,
    updated_at: promotionEvent.promoted_at,
    datasets,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  renameWithRetry(tempPath, filePath);
  return filePath;
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

async function phoenixFetchJson({
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
    response = await Promise.race([
      fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: payload ? { "content-type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
  }
  return body;
}
