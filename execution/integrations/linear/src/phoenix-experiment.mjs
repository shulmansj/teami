import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_EVAL_VARIANTS_PATH,
  resolveEvalVariant,
  runDecompositionEvalTask,
} from "./decomposition-eval-cli.mjs";
import {
  judgeAnnotationIdentifier,
  loadJudgePromptContract,
} from "./decomposition-quality-judge.mjs";
import {
  collectEnumValues,
  resolveSchemaRef,
} from "./deterministic-check-emission.mjs";
import {
  DEFAULT_ANNOTATION_NAME,
  PHOENIX_ASSETS_PATH,
  QUALITY_LABELS,
  resolveEvalContract,
} from "./eval-annotation-contract.mjs";
import {
  fetchPhoenixTraceAnnotations,
  normalizePhoenixAnnotation,
} from "./eval-status.mjs";
import { ensurePhoenixReady, resolvePhoenixConfig } from "./local-phoenix-manager.mjs";
import { resolveAcceptedBaseline } from "./promotion-scanner/accepted-baseline.mjs";
import { renameWithRetry } from "../../../engine/run-store.mjs";
import { resolveJudgeRuntimeAssignment } from "./runtime-adapters.mjs";
import { findSecretContentKeys } from "../../../engine/trace-contract.mjs";
import {
  loadWorkspaceEvalPolicy,
  WORKSPACE_EVAL_POLICY_PATH,
} from "./workspace-eval-policy.mjs";
import { decompositionDefinition } from "./workflows/decomposition/definition.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";

// Track F: the thin, agent-callable Phoenix experiment wrapper
// (`npm run phoenix:experiment-decomposition`) plus managed-experiment
// receipts (`npm run phoenix:experiment-amend`).
//
// Phoenix IS the experiment store (CONSTRAINTS #4: no custom experiment
// store). This module only:
//   1. selects dataset examples through the verified REST GET paths (native
//      split filter when available; disclosed metadata.dataset_split fallback
//      otherwise — CONSTRAINTS #31),
//   2. runs step 7's non-mutating eval task per example with the requested
//      variant (in-memory chaining of step 5 checks + step 6 judge),
//   3. records per-example task output + evaluator results to Phoenix through
//      the experiments REST path (POST /v1/datasets/{id}/experiments,
//      POST /v1/experiments/{id}/runs, POST /v1/experiment_evaluations) —
//      evaluators are run and passed EXPLICITLY, never assumed to auto-run,
//   4. writes the local managed-experiment receipt under
//      .teami/experiments/ (the receipt is provenance/intent
//      custody, not an experiment store: results live in Phoenix).
//
// Receipts are append-only (CONSTRAINTS #21): launch facts are immutable
// once written; the Phoenix experiment ID is written back exactly once
// (null -> value, the primary join for step 12); every later change is an
// appended event or amendment, never a rewrite of prior facts.
//
// Intent default rule (plan ~1556-1561): `promotion_candidate` would only be
// defaulted when a repo-owned automation policy explicitly marks the
// dataset/variant path as a self-improvement candidate. NO automation policy
// artifact exists yet in MVP, so the default is ALWAYS `exploratory`;
// `promotion_candidate` requires the explicit `--intent promotion_candidate`
// flag (CONSTRAINTS #19: experiments are evidence — explicit intent only).
//
// Baseline identity derives from the repo-owned phoenix-assets manifest, not
// from caller input and not from the receipt (CONSTRAINTS #35). If a receipt
// baseline later differs from the current accepted pin, that is the
// stale-baseline case owned by the step-12 scanner.

export const EXPERIMENT_RECEIPT_SCHEMA_VERSION = "teami-managed-experiment-receipt/v1";
export const EXPERIMENT_RECEIPT_SOURCE_MANAGED_MANUAL = "managed_manual";
export const EXPERIMENT_INTENTS = Object.freeze(["exploratory", "promotion_candidate"]);
export const EXPERIMENT_AMENDMENT_ACTIONS = Object.freeze(["register", "reclassify", "withdraw"]);
export const PHOENIX_EXPERIMENT_REST_CAPABILITY = "phoenix_experiment_rest_storage";
export const EXPERIMENT_SPLIT_CHOICES = Object.freeze(["train", "test"]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const LABEL_RANK = Object.fromEntries(
  [...QUALITY_LABELS].reverse().map((label, index) => [label, index]),
);

// ---------------------------------------------------------------------------
// Receipt store (.teami/experiments/<receipt_id>.json; gitignored
// local custody via the existing .teami/ ignore; atomic writes
// matching the run-store conventions).
// ---------------------------------------------------------------------------

export function defaultExperimentReceiptDir(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, ".teami", "experiments");
}

export function experimentReceiptPath({ receiptId, repoRoot = process.cwd(), receiptDir = null } = {}) {
  if (!receiptId || typeof receiptId !== "string" || !SAFE_ID_PATTERN.test(receiptId)) {
    throw new Error(`Invalid receipt_id for the managed-experiment receipt store: ${receiptId}`);
  }
  return path.join(receiptDir || defaultExperimentReceiptDir(repoRoot), `${receiptId}.json`);
}

export function readExperimentReceipt({ receiptId, repoRoot = process.cwd(), receiptDir = null } = {}) {
  const filePath = experimentReceiptPath({ receiptId, repoRoot, receiptDir });
  if (!fs.existsSync(filePath)) return { ok: true, exists: false, path: filePath, receipt: null };
  try {
    return { ok: true, exists: true, path: filePath, receipt: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, exists: true, path: filePath, reason: "experiment_receipt_unreadable", error: error.message };
  }
}

function writeReceiptFile(filePath, receipt) {
  const normalized = JSON.parse(JSON.stringify(receipt));
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

// Append-only update guard (CONSTRAINTS #21): re-reads the stored receipt,
// verifies launch facts and prior events/amendments are byte-identical, and
// allows only (a) appending events/amendments and (b) the one-time
// null -> value transition of phoenix_experiment_id.
function appendToReceipt({ receiptId, repoRoot, receiptDir }, mutate) {
  const current = readExperimentReceipt({ receiptId, repoRoot, receiptDir });
  if (!current.ok) throw new Error(`${current.reason}: ${current.path}`);
  if (!current.exists) throw new Error(`experiment receipt not found: ${current.path}`);
  const before = current.receipt;
  const after = JSON.parse(JSON.stringify(before));
  mutate(after);
  assertAppendOnlyReceiptUpdate(before, after);
  writeReceiptFile(current.path, after);
  return { path: current.path, receipt: after };
}

export function assertAppendOnlyReceiptUpdate(before, after) {
  for (const key of ["schema_version", "receipt_id", "source", "created_at"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`experiment receipt fact "${key}" is immutable (append-only receipts)`);
    }
  }
  if (JSON.stringify(before.launch) !== JSON.stringify(after.launch)) {
    throw new Error("experiment receipt launch facts are immutable (append-only receipts)");
  }
  if (before.phoenix_experiment_id !== null
    && before.phoenix_experiment_id !== after.phoenix_experiment_id) {
    throw new Error(
      "phoenix_experiment_id is write-once: it may only transition from null to a value",
    );
  }
  for (const listKey of ["events", "amendments"]) {
    const beforeList = before[listKey] || [];
    const afterList = after[listKey] || [];
    if (afterList.length < beforeList.length) {
      throw new Error(`experiment receipt ${listKey} may only be appended to`);
    }
    for (let index = 0; index < beforeList.length; index += 1) {
      if (JSON.stringify(beforeList[index]) !== JSON.stringify(afterList[index])) {
        throw new Error(`experiment receipt ${listKey}[${index}] was rewritten (append-only receipts)`);
      }
    }
  }
}

// Derived current view over launch facts + append-only events/amendments.
// This is the shape step 12 joins on: `phoenix_experiment_id` is the primary
// join (experiments cannot be enumerated by prompt version — capabilities Q8),
// `source` says managed, and `state`/`intent` reflect amendments without ever
// rewriting launch facts. One experiment id maps to at most one receipt value
// here, so a scanner can classify it managed XOR discovered, never both.
export function deriveExperimentReceiptState(receipt) {
  const amendments = receipt.amendments || [];
  let intent = receipt.launch.intent;
  let intentSource = receipt.launch.intent_source;
  let experimentId = receipt.phoenix_experiment_id ?? null;
  let withdrawn = false;
  let registeredDatasetVersionId = null;
  for (const amendment of amendments) {
    if (amendment.action === "reclassify") {
      intent = amendment.to_intent;
      intentSource = "amendment_reclassify";
    } else if (amendment.action === "register") {
      experimentId = amendment.experiment_id;
      registeredDatasetVersionId = amendment.verification?.experiment?.dataset_version_id ?? null;
    } else if (amendment.action === "withdraw") {
      withdrawn = true;
    }
  }
  return {
    receipt_id: receipt.receipt_id,
    source: receipt.source,
    state: withdrawn ? "withdrawn" : "active",
    intent,
    intent_source: intentSource,
    phoenix_experiment_id: experimentId,
    launch_intent: receipt.launch.intent,
    candidate_target_key: receipt.launch.candidate_target_key,
    candidate_version_id: receipt.launch.candidate.candidate_version_id,
    launch_baseline_id: receipt.launch.launch_baseline.accepted_baseline_id,
    dataset: receipt.launch.dataset,
    registered_dataset_version_id: registeredDatasetVersionId,
    teami_run_id: receipt.launch.teami_run_id,
    amendment_count: amendments.length,
  };
}

// ---------------------------------------------------------------------------
// Intent, candidate target, baseline, actor.
// ---------------------------------------------------------------------------

// MVP rule (documented above): no repo-owned automation policy artifact
// exists yet, so the default intent is ALWAYS exploratory. The only path to
// promotion_candidate is the explicit flag.
export function resolveExperimentIntent({ intentFlag = null } = {}) {
  if (intentFlag === null || intentFlag === undefined) {
    return { ok: true, intent: "exploratory", source: "default_exploratory_no_automation_policy" };
  }
  if (!EXPERIMENT_INTENTS.includes(intentFlag)) {
    return {
      ok: false,
      reason: "invalid_intent",
      detail: `--intent must be one of ${EXPERIMENT_INTENTS.join("|")}; got "${intentFlag}".`,
    };
  }
  return { ok: true, intent: intentFlag, source: "explicit_flag" };
}

function workflowScope(definition = decompositionDefinition) {
  const scope = typeof definition?.workflow_type === "string" ? definition.workflow_type.trim() : "";
  return scope || "decomposition";
}

function evaluatorPromptRoleForDefinition(definition = decompositionDefinition) {
  const roles = Array.isArray(definition?.engine_owned_evaluator_roles)
    ? definition.engine_owned_evaluator_roles
    : [];
  return roles.findLast((role) => typeof role === "string" && role.trim() && role.trim() !== "judge")
    || roles.find((role) => typeof role === "string" && role.trim())
    || "decomposition_quality_judge";
}

function judgeCandidateTargetKeyForDefinition(definition = decompositionDefinition) {
  const scope = workflowScope(definition);
  const role = evaluatorPromptRoleForDefinition(definition);
  return `prompt/${scope}/${role}`;
}

function runtimeRoleAssignmentsTargetKeyForDefinition(definition = decompositionDefinition) {
  return `rule/${workflowScope(definition)}/runtime_role_assignments`;
}

function acceptedBaselineTargetKeyForDefinition(definition = decompositionDefinition) {
  return `policy/${workflowScope(definition)}/accepted_baseline`;
}

// candidate_target_key per the canonical grammar
// <candidate_kind>/<scope>/<artifact_slot> (proposal template README). The
// variant is the experiment identity; the target key names the accepted
// artifact the experiment is about.
export function deriveCandidateTargetKey(variant, definition = decompositionDefinition) {
  const behaviorChange = resolveSingleAgentBehaviorChange(variant, definition);
  if (behaviorChange.ok) return behaviorChange.targetKey;
  // Zero-override baseline runs still need a stable, parseable target key for
  // receipts; multi-concern promotion candidates are rejected before launch.
  return acceptedBaselineTargetKeyForDefinition(definition);
}

function agentBehaviorChangeConcerns(variant, definition = decompositionDefinition) {
  const concerns = [];
  for (const [targetKey, override] of Object.entries(variant?.prompt_overrides || {})) {
    if (override?.candidate_prompt_version_id) {
      concerns.push({
        label: `prompt:${targetKey}`,
        targetKey,
        candidateVersionId: override.candidate_prompt_version_id,
      });
    }
  }
  if (variant?.judge_candidate_prompt_version_id) {
    const targetKey = judgeCandidateTargetKeyForDefinition(definition);
    concerns.push({
      label: `prompt:${targetKey}`,
      targetKey,
      candidateVersionId: variant.judge_candidate_prompt_version_id,
    });
  }
  if (variant?.role_overrides && Object.keys(variant.role_overrides).length > 0) {
    // Runtime/model role overrides target the accepted runtime role
    // assignment rules (accepting one is a config process change).
    const targetKey = runtimeRoleAssignmentsTargetKeyForDefinition(definition);
    concerns.push({
      label: "rule:runtime_role_assignments",
      targetKey,
      candidateVersionId: variant?.id,
    });
  }
  return concerns;
}

function resolveSingleAgentBehaviorChange(variant, definition = decompositionDefinition) {
  const concerns = agentBehaviorChangeConcerns(variant, definition);
  if (concerns.length === 0) {
    return {
      ok: false,
      reason: "promotion_candidate_requires_agent_behavior_change",
      detail:
        "promotion_candidate experiments must target a manifest-declared agent behavior change; zero-override accepted-baseline runs are exploratory evidence, not promotion candidates.",
    };
  }
  if (concerns.length > 1) {
    return {
      ok: false,
      reason: "promotion_candidate_requires_single_agent_behavior_change",
      detail:
        `promotion_candidate experiments must target exactly one agent behavior artifact; received ${concerns.map((concern) => concern.label).join(", ")}.`,
    };
  }
  return { ok: true, ...concerns[0] };
}

function validateSingleAgentBehaviorChange(variant, definition = decompositionDefinition) {
  return resolveSingleAgentBehaviorChange(variant, definition);
}

function singlePromptOverrideEntry(variant) {
  const entries = Object.entries(variant?.prompt_overrides || {});
  if (entries.length !== 1) return null;
  const [targetKey, override] = entries[0];
  if (!override?.candidate_prompt_version_id) return null;
  return { targetKey, candidatePromptVersionId: override.candidate_prompt_version_id };
}

function candidateVersionIdForVariant(variant, definition = decompositionDefinition) {
  const behaviorChange = resolveSingleAgentBehaviorChange(variant, definition);
  if (behaviorChange.ok && behaviorChange.candidateVersionId) {
    return behaviorChange.candidateVersionId;
  }
  return variant?.judge_candidate_prompt_version_id || variant?.id;
}

function normalizeDerivedVariant(derivedVariant) {
  if (derivedVariant === null || derivedVariant === undefined) return { ok: true, variant: null };
  if (!derivedVariant || typeof derivedVariant !== "object" || Array.isArray(derivedVariant)) {
    return { ok: false, reason: "invalid_derived_variant", detail: "derivedVariant must be an object." };
  }
  if (typeof derivedVariant.id !== "string" || derivedVariant.id.trim() === "") {
    return { ok: false, reason: "invalid_derived_variant", detail: "derivedVariant.id is required." };
  }
  const promptOverrides = derivedVariant.prompt_overrides;
  if (!promptOverrides || typeof promptOverrides !== "object" || Array.isArray(promptOverrides)) {
    return { ok: false, reason: "invalid_derived_variant", detail: "derivedVariant.prompt_overrides is required." };
  }
  if (singlePromptOverrideEntry(derivedVariant) === null) {
    return {
      ok: false,
      reason: "invalid_derived_variant",
      detail: "derivedVariant must contain exactly one prompt override with candidate_prompt_version_id.",
    };
  }
  return {
    ok: true,
    variant: {
      id: derivedVariant.id,
      role_overrides: structuredClone(derivedVariant.role_overrides || {}),
      judge_candidate_prompt_version_id: derivedVariant.judge_candidate_prompt_version_id ?? null,
      prompt_overrides: structuredClone(promptOverrides),
      source: "derived_variant",
      derived_variant: structuredClone(derivedVariant),
    },
  };
}

function writeDerivedVariantTempConfig({ variant, repoRoot }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-derived-variant-"));
  const variantsPath = path.join(tempDir, "variants.json");
  const config = {
    schema_version: "decomposition-eval-variants/v2",
    default_variant: variant.id,
    variants: {
      [variant.id]: {
        description: "Ephemeral derived variant supplied by runDecompositionExperiment.",
        role_overrides: structuredClone(variant.role_overrides || {}),
        judge_candidate_prompt_version_id: variant.judge_candidate_prompt_version_id ?? null,
        prompt_overrides: structuredClone(variant.prompt_overrides || {}),
      },
    },
  };
  fs.writeFileSync(variantsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    variantsPath,
    cleanup() {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the temp file contains only caller-supplied variant ids.
      }
    },
  };
}

function activePhoenixAssetsPath(repoRoot, definition = decompositionDefinition) {
  const namespacePaths = evalNamespacePaths(definition);
  const candidatePath = path.resolve(repoRoot, namespacePaths.manifest);
  if (fs.existsSync(candidatePath)) return candidatePath;
  if (workflowScope(definition) === "decomposition") return PHOENIX_ASSETS_PATH;
  return candidatePath;
}

function manifestRepoRootForPath(manifestPath) {
  return path.resolve(manifestPath, "..", "..", "..", "..");
}

function evalRepoRootForDefinition(repoRoot, definition = decompositionDefinition) {
  const manifestPath = activePhoenixAssetsPath(repoRoot, definition);
  if (workflowScope(definition) === "decomposition" && path.resolve(manifestPath) === path.resolve(PHOENIX_ASSETS_PATH)) {
    return MODULE_REPO_ROOT;
  }
  return manifestRepoRootForPath(manifestPath);
}

function mapLaunchBaselineResolutionFailure(resolution, candidateTargetKey) {
  if (resolution.reason === "accepted_prompt_target_unavailable") {
    return {
      ok: false,
      reason: "launch_target_unknown",
      detail: `phoenix-assets.json has no prompt entry for candidate_target_key ${candidateTargetKey}.`,
    };
  }
  if (resolution.reason === "accepted_prompt_snapshot_path_invalid") {
    return {
      ok: false,
      reason: "launch_target_baseline_unavailable",
      detail: `phoenix-assets.json prompt entry for ${candidateTargetKey} has no snapshot_path.`,
    };
  }
  if (resolution.reason === "accepted_prompt_snapshot_drift") {
    const detail = String(resolution.detail || "").replace(/\.$/, ";");
    return {
      ok: false,
      reason: "accepted_prompt_snapshot_drift",
      detail: `${detail} the accepted baseline identity is ambiguous.`,
    };
  }
  return resolution;
}

function launchBaselineFromResolution({
  resolution,
  manifestPath,
  manifestSha256,
  candidateTargetKey,
}) {
  const baseline = {
    derived_from: "phoenix_assets_manifest",
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    candidate_target_key: candidateTargetKey,
    ...(resolution.prompt_role ? { prompt_role: resolution.prompt_role } : {}),
    ...(resolution.prompt_role ? {} : { artifact_kind: resolution.artifact_kind }),
    accepted_baseline_id: resolution.accepted_baseline_id,
    accepted_artifact_hash_vector: resolution.accepted_artifact_hash_vector,
    accepted_dataset_version_ids: resolution.accepted_dataset_version_ids,
  };
  return baseline;
}

function baselineEntryMatchesDataset(entry, dataset = {}) {
  if (!entry) return false;
  if (entry.dataset_id && dataset.dataset_id && entry.dataset_id !== dataset.dataset_id) return false;
  if (entry.dataset_version_id && dataset.dataset_version_id && entry.dataset_version_id !== dataset.dataset_version_id) return false;
  if (entry.dataset_name && dataset.name && entry.dataset_name !== dataset.name) return false;
  return true;
}

function baselineEntryMatchesCandidateTarget(entry, candidateTargetKey, definition = decompositionDefinition) {
  if (entry?.candidate_target_key) return entry.candidate_target_key === candidateTargetKey;
  return candidateTargetKey === judgeCandidateTargetKeyForDefinition(definition);
}

function selectBaselineExperimentForSummary({
  manifest,
  candidateTargetKey,
  dataset,
  definition = decompositionDefinition,
} = {}) {
  return (manifest.experiments || []).find((entry) =>
    entry?.purpose === "baseline"
      && baselineEntryMatchesDataset(entry, dataset)
      && baselineEntryMatchesCandidateTarget(entry, candidateTargetKey, definition)) || null;
}

// Launch baseline identity: derived from the repo-owned phoenix-assets
// manifest ONLY (CONSTRAINTS #35) — there is deliberately no parameter
// through which a caller could supply a baseline. Reuses the step-6 contract
// loader so the judge prompt path keeps its pinned behavior.
export function deriveLaunchBaselineFromManifest({
  candidateTargetKey = null,
  repoRoot = process.cwd(),
  definition = decompositionDefinition,
} = {}) {
  let evalContract;
  let contract;
  try {
    let evalRepoRoot = evalRepoRootForDefinition(repoRoot, definition);
    evalContract = resolveEvalContract(definition, evalRepoRoot);
    if (
      !evalContract.eval_configured
      && workflowScope(definition) === "decomposition"
      && evalRepoRoot !== MODULE_REPO_ROOT
    ) {
      evalRepoRoot = MODULE_REPO_ROOT;
      evalContract = resolveEvalContract(definition, evalRepoRoot);
    }
    if (!evalContract.eval_configured || !evalContract.judge_prompt) {
      return {
        ok: false,
        reason: evalContract.reason || `workflow_eval_not_configured:${workflowScope(definition)}`,
        detail: `workflow ${workflowScope(definition)} has no configured Judge eval contract.`,
      };
    }
    contract = loadJudgePromptContract({ definition, repoRoot: evalRepoRoot, evalContract });
  } catch (error) {
    return {
      ok: false,
      reason: "judge_prompt_contract_unavailable",
      detail: error.message,
    };
  }
  if (contract.drift) {
    return {
      ok: false,
      reason: "accepted_prompt_snapshot_drift",
      detail: `snapshot ${contract.snapshotPath} hashes to ${contract.snapshotSha256} but phoenix-assets.json pins ${contract.expectedSha256}; the accepted baseline identity is ambiguous.`,
    };
  }

  const judgeTargetKey = contract.targetKey || judgeCandidateTargetKeyForDefinition(definition);
  if (!candidateTargetKey || candidateTargetKey === judgeTargetKey) {
    const manifestFilePath = contract.manifestPath || activePhoenixAssetsPath(repoRoot, definition);
    const manifestBytes = fs.readFileSync(manifestFilePath);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const datasetEntries = contract.manifest.datasets || [];
    const manifestPath = path.relative(manifestRepoRootForPath(manifestFilePath), manifestFilePath)
      .replaceAll("\\", "/");
    return {
      ok: true,
      manifest: contract.manifest,
      baseline: {
        derived_from: "phoenix_assets_manifest",
        manifest_path: manifestPath,
        manifest_sha256: manifestSha256,
        prompt_role: contract.entry.role,
        accepted_baseline_id:
          contract.entry.accepted_prompt_version_id || `sha256:${contract.snapshotSha256}`,
        accepted_dataset_version_ids: Object.fromEntries(
          datasetEntries.map((entry) => [entry.name, entry.accepted_dataset_version_id ?? null]),
        ),
      },
      contract,
    };
  }

  const resolvedManifestPath = activePhoenixAssetsPath(repoRoot, definition);
  const manifestBytes = fs.readFileSync(resolvedManifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestRepoRoot = manifestRepoRootForPath(resolvedManifestPath);
  const manifestPath = path.relative(manifestRepoRoot, resolvedManifestPath).replaceAll("\\", "/");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
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
          reason: isPrompt ? "launch_target_snapshot_unreadable" : "launch_target_artifact_unreadable",
          detail: error.message,
        };
      }
    },
  });
  if (!resolution.ok) {
    return mapLaunchBaselineResolutionFailure(resolution, candidateTargetKey);
  }
  return {
    ok: true,
    manifest,
    baseline: launchBaselineFromResolution({
      resolution,
      manifestPath,
      manifestSha256,
      candidateTargetKey,
    }),
    contract,
  };
}

function assertedActor() {
  let username = null;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME || process.env.USER || null;
  }
  // Local custody is unauthenticated (D4): the actor is asserted, never
  // claimed authenticated.
  return { os_username: username, authenticity: "asserted" };
}

function generateId(prefix, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  return `${prefix}-${stamp}-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Experiments REST capability preflight (CONSTRAINTS #12 posture: per
// capability, fail closed). Probes the LIVE /openapi.json for the three
// endpoints this wrapper writes through, and verifies experiment evaluations
// accept annotator_kind CODE so deterministic check results are never spoofed
// under another kind (CONSTRAINTS #30).
// ---------------------------------------------------------------------------

export async function preflightPhoenixExperimentRestCapability({
  appUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const capability = PHOENIX_EXPERIMENT_REST_CAPABILITY;
  let spec;
  try {
    const body = await phoenixFetchJson({ appUrl, pathname: "/openapi.json", fetchImpl, timeoutMs });
    spec = body;
  } catch (error) {
    return { ok: false, capability, reason: "openapi_unavailable", detail: error.message };
  }
  const requiredPosts = [
    "/v1/datasets/{dataset_id}/experiments",
    "/v1/experiments/{experiment_id}/runs",
    "/v1/experiment_evaluations",
  ];
  for (const pathName of requiredPosts) {
    if (!spec?.paths?.[pathName]?.post) {
      return { ok: false, capability, reason: "experiment_rest_endpoint_missing", detail: pathName };
    }
  }
  const evaluationSchema = resolveSchemaRef(
    spec.paths["/v1/experiment_evaluations"].post.requestBody?.content?.["application/json"]?.schema,
    spec,
  );
  const annotatorKinds = collectEnumValues(evaluationSchema?.properties?.annotator_kind, spec);
  if (!annotatorKinds.includes("CODE") || !annotatorKinds.includes("LLM")) {
    return {
      ok: false,
      capability,
      reason: "experiment_evaluation_annotator_kinds_unsupported",
      detail: `annotator_kind values: ${annotatorKinds.join("|") || "none"}`,
    };
  }
  return { ok: true, capability, annotatorKinds };
}

// ---------------------------------------------------------------------------
// Dataset + example selection (verified REST GET paths; native splits win).
// ---------------------------------------------------------------------------

async function resolveDatasetAndVersion({ appUrl, datasetName, fetchImpl }) {
  const datasets = await phoenixFetchJson({
    appUrl,
    pathname: "/v1/datasets",
    searchParams: { name: datasetName },
    fetchImpl,
  });
  const dataset = (datasets?.data || []).find((candidate) => candidate?.name === datasetName) || null;
  if (!dataset?.id) return { ok: false, reason: "dataset_not_found", dataset_name: datasetName };
  const versions = await phoenixFetchJson({
    appUrl,
    pathname: `/v1/datasets/${encodeURIComponent(dataset.id)}/versions`,
    searchParams: { limit: "1" },
    fetchImpl,
  });
  const versionId = versions?.data?.[0]?.version_id ?? null;
  if (!versionId) return { ok: false, reason: "dataset_version_unresolvable", dataset_name: datasetName };
  return { ok: true, datasetId: dataset.id, datasetVersionId: versionId };
}

function parseExamplesBody(body) {
  if (Array.isArray(body?.data?.examples)) return body.data.examples;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

// Native Phoenix split selection wins (CONSTRAINTS #31): the pinned server
// resolves ?split=<name> against NATIVE split objects and 404s when the split
// object does not exist. Only then do we fall back to client-side filtering
// on the metadata.dataset_split mirror — disclosed in the summary and the
// receipt, never claimed as native split evidence.
export async function selectDatasetExamples({
  appUrl,
  datasetId,
  datasetVersionId,
  split = null,
  exampleIds = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const examplesPath = `/v1/datasets/${encodeURIComponent(datasetId)}/examples`;
  let records;
  let selection;
  let disclosure = null;
  if (split) {
    try {
      const body = await phoenixFetchJson({
        appUrl,
        pathname: examplesPath,
        searchParams: { version_id: datasetVersionId, split },
        fetchImpl,
      });
      records = parseExamplesBody(body);
      selection = "native_split_filter";
    } catch (error) {
      if (error.status !== 404 || !/split/i.test(error.message)) throw error;
      const body = await phoenixFetchJson({
        appUrl,
        pathname: examplesPath,
        searchParams: { version_id: datasetVersionId },
        fetchImpl,
      });
      records = parseExamplesBody(body).filter(
        (record) => record?.metadata?.dataset_split === split,
      );
      selection = "metadata_fallback";
      disclosure =
        `Native Phoenix split "${split}" does not exist on this dataset; examples were filtered `
        + "client-side by metadata.dataset_split. This is a disclosed fallback, NOT native split "
        + "evidence — assign native splits in Phoenix to restore full evidence quality.";
    }
  } else {
    const body = await phoenixFetchJson({
      appUrl,
      pathname: examplesPath,
      searchParams: { version_id: datasetVersionId },
      fetchImpl,
    });
    records = parseExamplesBody(body);
    selection = "all_examples";
  }

  if (Array.isArray(exampleIds) && exampleIds.length > 0) {
    const wanted = new Set(exampleIds);
    const matched = records.filter(
      (record) => wanted.has(record?.id) || wanted.has(record?.metadata?.source_run_id),
    );
    const matchedKeys = new Set();
    for (const record of matched) {
      if (wanted.has(record?.id)) matchedKeys.add(record.id);
      if (wanted.has(record?.metadata?.source_run_id)) matchedKeys.add(record.metadata.source_run_id);
    }
    const missing = exampleIds.filter((id) => !matchedKeys.has(id));
    if (missing.length > 0) {
      return { ok: false, reason: "requested_examples_not_found", missing, selection, disclosure };
    }
    records = matched;
  }
  if (records.length === 0) {
    return { ok: false, reason: "no_examples_selected", selection, disclosure };
  }
  return { ok: true, records, selection, disclosure };
}

// ---------------------------------------------------------------------------
// Summary helpers.
// ---------------------------------------------------------------------------

function exampleSplitMembership(record, { split, selection }) {
  if (split && selection === "native_split_filter") return { split, basis: "native_split_filter" };
  const metadataSplit = record?.metadata?.dataset_split ?? null;
  return { split: split || metadataSplit, basis: "metadata_dataset_split_mirror" };
}

// evidence_counts contract (plan ~1119-1131): counts by split plus
// human-labeled counts; authenticity is always asserted in MVP (D4).
export function computeEvidenceCounts(perExample) {
  const counts = {
    train_examples: 0,
    train_human_labeled_examples: 0,
    test_examples: 0,
    test_human_labeled_examples: 0,
    human_label_authenticity: "asserted",
  };
  for (const entry of perExample) {
    if (entry.split === "train") {
      counts.train_examples += 1;
      if (entry.human_labeled) counts.train_human_labeled_examples += 1;
    } else if (entry.split === "test") {
      counts.test_examples += 1;
      if (entry.human_labeled) counts.test_human_labeled_examples += 1;
    }
  }
  return counts;
}

function codeSignalLabel(checks) {
  const evaluated = (checks?.checks || []).filter((check) => check.status === "evaluated");
  if (evaluated.length === 0) return null;
  return evaluated.some((check) => check.annotation.label !== "pass") ? "needs_revision" : "pass";
}

// Disagreements among available signals on the same example (human vs LLM vs
// CODE) — summary-level only; the full disagreement report/gate is step 9.
export function detectSignalDisagreements(perExample) {
  const disagreements = [];
  for (const entry of perExample) {
    const signals = {};
    if (entry.human_label) signals.human = entry.human_label;
    if (entry.judge?.label) signals.llm = entry.judge.label;
    if (entry.code_label) signals.code = entry.code_label;
    const labels = [...new Set(Object.values(signals))];
    if (Object.keys(signals).length >= 2 && labels.length > 1) {
      disagreements.push({ example_id: entry.example_id, signals });
    }
  }
  return disagreements;
}

export function computeEvaluationScoreMeans(perExample) {
  const sums = new Map();
  for (const entry of perExample) {
    for (const evaluation of entry.evaluations || []) {
      if (typeof evaluation.score !== "number" || !Number.isFinite(evaluation.score)) continue;
      const current = sums.get(evaluation.name) || { total: 0, count: 0 };
      current.total += evaluation.score;
      current.count += 1;
      sums.set(evaluation.name, current);
    }
  }
  return Object.fromEntries(
    [...sums.entries()].map(([name, { total, count }]) => [name, total / count]),
  );
}

export function compareExperimentScoreMeans({ currentMeans = {}, baselineMeans = {} } = {}) {
  const names = [...new Set([...Object.keys(currentMeans), ...Object.keys(baselineMeans)])].sort();
  const deltas = {};
  const regressions = [];
  for (const name of names) {
    const current = currentMeans[name];
    const baseline = baselineMeans[name];
    if (typeof current !== "number" || typeof baseline !== "number") continue;
    const delta = current - baseline;
    deltas[name] = { baseline, current, delta };
    if (delta < 0) regressions.push(name);
  }
  return { deltas, regressions };
}

function meansFromBaselineExperimentJson(records) {
  const perExample = (Array.isArray(records) ? records : []).map((record) => ({
    evaluations: (record?.annotations || []).map((annotation) => ({
      name: annotation?.name,
      score: annotation?.score,
    })),
  }));
  return computeEvaluationScoreMeans(perExample);
}

function humanLabelRegressions(perExample) {
  const regressions = [];
  for (const entry of perExample) {
    if (!entry.human_label || !entry.judge?.label) continue;
    if ((LABEL_RANK[entry.judge.label] ?? 0) < (LABEL_RANK[entry.human_label] ?? 0)) {
      regressions.push({
        example_id: entry.example_id,
        human_label: entry.human_label,
        judge_label: entry.judge.label,
      });
    }
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// The experiment wrapper.
// ---------------------------------------------------------------------------

export async function runDecompositionExperiment(options = {}) {
  return runWorkflowExperiment(decompositionDefinition, {
    variantsPath: DEFAULT_EVAL_VARIANTS_PATH,
    ...options,
  });
}

function experimentDescription({ definition = decompositionDefinition, variant, intent }) {
  const workflowType = workflowScope(definition);
  return `Teami managed ${workflowType} experiment (variant ${variant.id}, intent ${intent.intent}).`;
}

export async function runWorkflowExperiment(definition = decompositionDefinition, {
  repoRoot = process.cwd(),
  config,
  datasetName,
  variantId = null,
  derivedVariant = null,
  intentFlag = null,
  draftedBy = null,
  split = null,
  exampleIds = null,
  variantsPath = null,
  receiptDir = null,
  policyPath = undefined,
  runEvalTaskFn = runDecompositionEvalTask,
  runtimeExecutor = null,
  traceSink = null,
  emitChecksFn = undefined,
  runJudgeFn = undefined,
  baselineExperimentOverride = undefined,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  const resolvedDefinition = definition || decompositionDefinition;
  if (!config) return { ok: false, status: "not_run", reason: "missing_config" };
  if (!datasetName || typeof datasetName !== "string") {
    return { ok: false, status: "not_run", reason: "missing_dataset_name" };
  }
  if (split !== null && split !== undefined && !EXPERIMENT_SPLIT_CHOICES.includes(split)) {
    return {
      ok: false,
      status: "not_run",
      reason: "invalid_split",
      detail: `--split must be one of ${EXPERIMENT_SPLIT_CHOICES.join("|")}; got "${split}".`,
    };
  }

  // 1. Intent (default exploratory — see module header), variant, policy,
  // baseline: all fail closed before anything is written anywhere.
  const intent = resolveExperimentIntent({ intentFlag });
  if (!intent.ok) return { ok: false, status: "not_run", ...intent };

  if (variantId && derivedVariant) {
    return {
      ok: false,
      status: "not_run",
      reason: "variant_id_conflicts_with_derived_variant",
      detail: "supply either variantId or derivedVariant, not both.",
    };
  }
  const resolvedVariantsPath = variantsPath
    || path.resolve(repoRoot, evalNamespacePaths(resolvedDefinition).variants);
  const variantResolution = derivedVariant
    ? normalizeDerivedVariant(derivedVariant)
    : resolveEvalVariant({ variantId, variantsPath: resolvedVariantsPath, repoRoot });
  if (!variantResolution.ok) return { ok: false, status: "not_run", ...variantResolution };
  const variant = variantResolution.variant;

  let policy;
  let policyHash;
  const resolvedPolicyPath = policyPath || WORKSPACE_EVAL_POLICY_PATH;
  try {
    policy = loadWorkspaceEvalPolicy(policyPath ? { policyPath } : {});
    policyHash = createHash("sha256").update(fs.readFileSync(resolvedPolicyPath)).digest("hex");
  } catch (error) {
    return { ok: false, status: "not_run", reason: "workspace_eval_policy_unavailable", detail: error.message };
  }

  const candidateTargetKey = deriveCandidateTargetKey(variant, resolvedDefinition);
  if (intent.intent === "promotion_candidate") {
    const behaviorChange = validateSingleAgentBehaviorChange(variant, resolvedDefinition);
    if (!behaviorChange.ok) {
      return {
        ok: false,
        status: "not_run",
        reason: behaviorChange.reason,
        detail: behaviorChange.detail,
      };
    }
  }
  const baselineResolution = deriveLaunchBaselineFromManifest({
    candidateTargetKey,
    repoRoot,
    definition: resolvedDefinition,
  });
  if (!baselineResolution.ok) return { ok: false, status: "not_run", ...baselineResolution };
  const { baseline, manifest, contract } = baselineResolution;

  // Judge identity is a required receipt fact (evaluator versions), so a
  // missing judge model fails closed here rather than per example.
  const judgeAssignment = resolveJudgeRuntimeAssignment(config, resolvedDefinition);
  if (!judgeAssignment.model) {
    const workflowType = workflowScope(resolvedDefinition);
    const role = evaluatorPromptRoleForDefinition(resolvedDefinition);
    return {
      ok: false,
      status: "not_run",
      reason: "judge_model_not_configured",
      detail: `configure workflows.${workflowType}.roles.${role}.model before launching experiments.`,
    };
  }
  const codeEvaluatorIds = (manifest.evaluators || [])
    .filter((evaluator) => evaluator.kind === "code")
    .map((evaluator) => evaluator.id);
  const judgePromptVersion = variant.judge_candidate_prompt_version_id
    || contract.entry.accepted_prompt_version_id
    || `sha256:${contract.snapshotSha256}`;
  const candidatePromptOverride = singlePromptOverrideEntry(variant);
  const candidateVersionId = candidateVersionIdForVariant(variant, resolvedDefinition);
  const evaluators = {
    code: codeEvaluatorIds,
    judge: {
      evaluator_id: contract.evaluatorEntry.id,
      model: judgeAssignment.model,
      runtime: judgeAssignment.runtime,
      identifier: judgeAnnotationIdentifier({
        evaluatorId: contract.evaluatorEntry.id,
        model: judgeAssignment.model,
      }),
      prompt_source: variant.judge_candidate_prompt_version_id
        ? "phoenix_candidate_version"
        : "repo_accepted_snapshot",
      prompt_version: judgePromptVersion,
    },
  };

  // 2. Phoenix readiness + experiments-REST capability preflight (fail closed
  // per capability; nothing has been written yet).
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
  const phoenixConfig = resolvePhoenixConfig({ repoRoot });
  const projectName = ready.projectName || phoenixConfig.projectName;

  const capability = await preflightPhoenixExperimentRestCapability({ appUrl, fetchImpl });
  if (!capability.ok) {
    return { ok: false, status: "not_run", reason: capability.reason, detail: capability.detail, capability };
  }

  // 3. Dataset + version + example selection through verified REST GETs.
  let datasetResolution;
  try {
    datasetResolution = await resolveDatasetAndVersion({ appUrl, datasetName, fetchImpl });
  } catch (error) {
    return { ok: false, status: "not_run", reason: "phoenix_request_failed", detail: error.message };
  }
  if (!datasetResolution.ok) return { ok: false, status: "not_run", ...datasetResolution };
  const { datasetId, datasetVersionId } = datasetResolution;

  let selected;
  try {
    selected = await selectDatasetExamples({
      appUrl,
      datasetId,
      datasetVersionId,
      split: split || null,
      exampleIds,
      fetchImpl,
    });
  } catch (error) {
    return { ok: false, status: "not_run", reason: "phoenix_request_failed", detail: error.message };
  }
  if (!selected.ok) return { ok: false, status: "not_run", ...selected };
  if (selected.disclosure) onProgress(`WARNING ${selected.disclosure}`);

  // 4. Managed receipt, written BEFORE the Phoenix experiment exists so a
  // failed launch is still visible/registerable (plan ~1534-1549).
  const launchedAt = now().toISOString();
  const receiptId = generateId("expr", now());
  const agenticFactoryRunId = generateId("afexp", now());
  const actor = assertedActor();
  const receipt = {
    schema_version: EXPERIMENT_RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    source: EXPERIMENT_RECEIPT_SOURCE_MANAGED_MANUAL,
    created_at: launchedAt,
    launch: {
      intent: intent.intent,
      intent_source: intent.source,
      candidate_target_key: candidateTargetKey,
      launch_baseline: baseline,
      candidate: {
        variant_id: variant.id,
        variant_source: variant.source,
        candidate_version_id: candidateVersionId,
        role_overrides: variant.role_overrides || {},
        prompt_overrides: variant.prompt_overrides || {},
        ...(variant.derived_variant ? { derived_variant: structuredClone(variant.derived_variant) } : {}),
        judge_candidate_prompt_version_id:
          variant.judge_candidate_prompt_version_id
          ?? candidatePromptOverride?.candidatePromptVersionId
          ?? null,
      },
      dataset: { name: datasetName, dataset_id: datasetId, dataset_version_id: datasetVersionId },
      split: {
        requested: split || null,
        selection: selected.selection,
        disclosure: selected.disclosure,
        example_ids: selected.records.map((record) => record.id ?? null),
      },
      evaluators,
      promotion_policy: null,
      workspace_eval_policy: {
        schema_version: policy.schema_version,
        sha256: policyHash,
        path: path.basename(resolvedPolicyPath),
      },
      actor,
      launched_at: launchedAt,
      phoenix_scope: { origin: appUrl, project_name: projectName },
      teami_run_id: agenticFactoryRunId,
      ...(typeof draftedBy === "string" && draftedBy.trim() !== ""
        ? { drafted_by: draftedBy.trim() }
        : {}),
    },
    phoenix_experiment_id: null,
    events: [{ type: "launched", at: launchedAt, actor }],
    amendments: [],
  };
  const receiptPath = experimentReceiptPath({ receiptId, repoRoot, receiptDir });
  writeReceiptFile(receiptPath, receipt);

  // 5. Create the Phoenix experiment with the create-time metadata stamp
  // (receipt/run IDs; metadata is CREATE-TIME-ONLY on the pinned Phoenix —
  // capabilities Q5 — and the stamp is best-effort provenance, never
  // authority: the receipt-side experiment id remains the primary join).
  const metadataStamp = {
    teami_receipt_id: receiptId,
    teami_run_id: agenticFactoryRunId,
    teami_source: EXPERIMENT_RECEIPT_SOURCE_MANAGED_MANUAL,
    teami_variant_id: variant.id,
    teami_candidate_version_id: candidateVersionId,
  };
  const createPayloadBase = {
    name: receiptId,
    description: experimentDescription({ definition: resolvedDefinition, variant, intent }),
    version_id: datasetVersionId,
    repetitions: 1,
    ...(split && selected.selection === "native_split_filter" ? { splits: [split] } : {}),
  };
  let experiment = null;
  let metadataStampStatus = "stamped";
  try {
    const created = await phoenixFetchJson({
      appUrl,
      pathname: `/v1/datasets/${encodeURIComponent(datasetId)}/experiments`,
      method: "POST",
      fetchImpl,
      payload: { ...createPayloadBase, metadata: metadataStamp },
    });
    experiment = created?.data || null;
  } catch (error) {
    onProgress(`WARNING experiment create with metadata stamp failed (${error.message}); retrying without the stamp.`);
    try {
      const created = await phoenixFetchJson({
        appUrl,
        pathname: `/v1/datasets/${encodeURIComponent(datasetId)}/experiments`,
        method: "POST",
        fetchImpl,
        payload: createPayloadBase,
      });
      experiment = created?.data || null;
      metadataStampStatus = "rejected_create_succeeded_without_stamp";
    } catch (retryError) {
      appendToReceipt({ receiptId, repoRoot, receiptDir }, (current) => {
        current.events.push({
          type: "phoenix_experiment_create_failed",
          at: now().toISOString(),
          detail: retryError.message,
        });
      });
      return {
        ok: false,
        status: "failed",
        reason: "experiment_create_failed",
        detail: retryError.message,
        receipt_id: receiptId,
        receipt_path: receiptPath,
        repair_hint: `Create the experiment in Phoenix (or retry), then attach it with npm run phoenix:experiment-amend -- ${receiptId} --action register --experiment-id <id> --reason <text>.`,
      };
    }
  }
  if (!experiment?.id) {
    return {
      ok: false,
      status: "failed",
      reason: "experiment_id_missing_in_response",
      receipt_id: receiptId,
      receipt_path: receiptPath,
    };
  }

  // 6. Write the Phoenix experiment ID back into the receipt as soon as it is
  // known — the write-once primary join (experiments cannot be enumerated by
  // prompt version, so the receipt MUST carry the id; capabilities Q8).
  appendToReceipt({ receiptId, repoRoot, receiptDir }, (current) => {
    current.phoenix_experiment_id = experiment.id;
    current.events.push({
      type: "phoenix_experiment_created",
      at: now().toISOString(),
      phoenix_experiment_id: experiment.id,
      dataset_version_id: experiment.dataset_version_id ?? datasetVersionId,
      metadata_stamp: metadataStampStatus,
    });
  });

  // 7. Per-example execution: step 7's eval task with the variant (in-memory
  // chaining of step-5 checks + step-6 judge), then task output + evaluator
  // results recorded through the experiments REST path. Per-example failures
  // are recorded and the experiment CONTINUES (partial summary).
  const readyForChain = async () => ready;
  const probeForChain = async () => ({ ok: true, appUrl, projectName });
  const derivedVariantTaskConfig = variant.source === "derived_variant"
    ? writeDerivedVariantTempConfig({ variant, repoRoot })
    : null;
  const perExample = [];
  try {
    for (const record of selected.records) {
      const membership = exampleSplitMembership(record, { split, selection: selected.selection });
      const startedAt = now().toISOString();
      let taskResult;
      try {
        taskResult = await runEvalTaskFn({
          repoRoot,
          config,
          datasetName,
          datasetExampleId: record.id,
          variantId: derivedVariantTaskConfig ? variant.id : variantId,
          variantsPath: derivedVariantTaskConfig?.variantsPath || resolvedVariantsPath,
          definition: resolvedDefinition,
          ...(variant.source === "derived_variant" ? { derivedVariant: structuredClone(variant.derived_variant) } : {}),
          emitChecks: true,
          judge: true,
          ...(runtimeExecutor ? { runtimeExecutor } : {}),
          ...(traceSink ? { traceSink } : {}),
          ...(emitChecksFn ? { emitChecksFn } : {}),
          ...(runJudgeFn ? { runJudgeFn } : {}),
          ensureReady: readyForChain,
          phoenixProbe: probeForChain,
          fetchImpl,
          onProgress,
        });
      } catch (error) {
        taskResult = { ok: false, status: "failed_closed", reason: `eval_task_failed:${error.message}` };
      }
      const endedAt = now().toISOString();

      const entry = {
      example_id: record.id ?? null,
      split: membership.split,
      split_basis: membership.basis,
      eval_run_id: taskResult.eval_run_id ?? null,
      status: taskResult.status ?? "failed_closed",
      reason: taskResult.reason ?? null,
      trace_id: taskResult.trace?.trace_id ?? null,
      experiment_run_id: null,
      evaluations: [],
      failures: [],
      judge: taskResult.judge?.judge
        ? { label: taskResult.judge.judge.label, score: taskResult.judge.judge.score }
        : null,
      judge_state: taskResult.judge?.judge_state ?? null,
      code_label: codeSignalLabel(taskResult.checks),
      human_label: null,
      human_labeled: Array.isArray(record?.metadata?.reference?.human_annotation_ids)
        ? record.metadata.reference.human_annotation_ids.length > 0
        : false,
      source_trace_id: record?.metadata?.source_trace_id ?? null,
      };
      if (!taskResult.ok) {
        entry.failures.push(`eval_task:${taskResult.reason || taskResult.status || "failed"}`);
      }

    // 7a. Experiment run row (the Phoenix experiment store record). Failed
    // tasks are recorded with `error` so the experiment stays explainable.
    const output = taskResult.ok
      ? {
          eval_run_id: taskResult.eval_run_id,
          variant_id: taskResult.variant_id,
          inputs_hash: taskResult.inputs_hash,
          status: taskResult.status,
          terminal: taskResult.terminal,
          accepted_packet_count: taskResult.subagent_invocations?.length ?? 0,
        }
      : null;
    const secretPaths = output ? findSecretContentKeys(output) : [];
    const runPayload = {
      dataset_example_id: record.id,
      output: secretPaths.length > 0 ? null : output,
      repetition_number: 1,
      start_time: startedAt,
      end_time: endedAt,
      trace_id: entry.trace_id,
      error: !taskResult.ok
        ? String(taskResult.reason || taskResult.status || "eval_task_failed")
        : secretPaths.length > 0
          ? "task_output_contains_token_shaped_content"
          : null,
    };
    if (secretPaths.length > 0) {
      entry.failures.push(`task_output_secret_shaped_content:${secretPaths.join(",")}`);
    }
    try {
      const runResponse = await phoenixFetchJson({
        appUrl,
        pathname: `/v1/experiments/${encodeURIComponent(experiment.id)}/runs`,
        method: "POST",
        fetchImpl,
        payload: runPayload,
      });
      entry.experiment_run_id = runResponse?.data?.id ?? null;
    } catch (error) {
      entry.failures.push(`experiment_run_record_failed:${error.message}`);
    }

    // 7b. Evaluator results, passed EXPLICITLY through the experiments REST
    // path (never assumed to auto-run). Evaluated CODE checks and the judge
    // result each become one experiment evaluation; judge_missing /
    // judge_invalid are recorded as evaluation errors so the failure is
    // visible in the experiment. Named check skips are design-level
    // (non-mutating eval runs cannot supply those inputs) and are disclosed
    // in the summary instead of being written as errors for every example.
    if (entry.experiment_run_id) {
      const recordedNames = new Set();
      const postEvaluation = async ({ name, annotatorKind, result, error, metadata }) => {
        if (recordedNames.has(name)) {
          entry.failures.push(`evaluation_name_collision_not_overwritten:${name}`);
          return;
        }
        const payload = {
          experiment_run_id: entry.experiment_run_id,
          name,
          annotator_kind: annotatorKind,
          start_time: startedAt,
          end_time: endedAt,
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
          ...(metadata ? { metadata } : {}),
          ...(entry.trace_id ? { trace_id: entry.trace_id } : {}),
        };
        const payloadSecretPaths = findSecretContentKeys(payload);
        if (payloadSecretPaths.length > 0) {
          entry.failures.push(`evaluation_secret_shaped_content:${name}`);
          return;
        }
        try {
          const response = await phoenixFetchJson({
            appUrl,
            pathname: "/v1/experiment_evaluations",
            method: "POST",
            fetchImpl,
            payload,
          });
          recordedNames.add(name);
          entry.evaluations.push({
            name,
            annotator_kind: annotatorKind,
            label: result?.label ?? null,
            score: result?.score ?? null,
            error: error ?? null,
            evaluation_id: response?.data?.id ?? null,
          });
        } catch (postError) {
          entry.failures.push(`evaluation_record_failed:${name}:${postError.message}`);
        }
      };

      for (const check of taskResult.checks?.checks || []) {
        if (check.status !== "evaluated") continue;
        await postEvaluation({
          name: check.annotation.name,
          annotatorKind: "CODE",
          result: {
            label: check.annotation.label,
            score: check.annotation.score,
            explanation: check.annotation.explanation,
          },
          metadata: {
            identifier: check.annotation.identifier,
            failure_modes: check.annotation.metadata?.failure_modes ?? [],
            source_eval_run_id: entry.eval_run_id,
          },
        });
      }
      const judgeResult = taskResult.judge;
      if (judgeResult?.judge_state === "judged" && judgeResult.judge) {
        await postEvaluation({
          name: DEFAULT_ANNOTATION_NAME,
          annotatorKind: "LLM",
          result: {
            label: judgeResult.judge.label,
            score: judgeResult.judge.score,
            explanation: judgeResult.judge.explanation,
          },
          metadata: {
            identifier: judgeResult.identifier,
            judge_model: judgeResult.model,
            judge_prompt_source: judgeResult.prompt_source,
            judge_prompt_version: judgeResult.prompt_version,
            failure_modes: judgeResult.judge.failure_modes ?? [],
            source_eval_run_id: entry.eval_run_id,
          },
        });
      } else if (judgeResult
        && (judgeResult.judge_state === "judge_missing" || judgeResult.judge_state === "judge_invalid")) {
        await postEvaluation({
          name: DEFAULT_ANNOTATION_NAME,
          annotatorKind: "LLM",
          error: `${judgeResult.judge_state}:${judgeResult.reason || "unknown"}`,
          metadata: {
            identifier: judgeResult.identifier ?? evaluators.judge.identifier,
            source_eval_run_id: entry.eval_run_id,
          },
        });
        entry.failures.push(`judge:${judgeResult.judge_state}`);
      }
    }

    perExample.push(entry);
    onProgress(
      `example ${entry.example_id}: ${entry.status}${entry.failures.length > 0 ? ` (${entry.failures.join("; ")})` : ""}`,
    );
  }
  } finally {
    derivedVariantTaskConfig?.cleanup();
  }

  // 8. HUMAN annotations on the examples' source traces (when recorded), for
  // disagreement reporting and human-labeled evidence counts. Read-only GET;
  // unavailability is disclosed, never invented.
  let humanAnnotationNote = null;
  for (const entry of perExample) {
    if (!entry.source_trace_id) continue;
    try {
      const annotations = await fetchPhoenixTraceAnnotations({
        appUrl,
        projectName,
        traceId: entry.source_trace_id,
        fetchImpl,
      });
      const humans = annotations
        .map((annotation) => normalizePhoenixAnnotation(annotation))
        .filter(
          (annotation) =>
            annotation.annotator_kind === "HUMAN" && annotation.name === DEFAULT_ANNOTATION_NAME,
        );
      if (humans.length > 0) {
        entry.human_label = humans.at(-1).label;
        entry.human_labeled = true;
      }
    } catch (error) {
      humanAnnotationNote = `human annotations unreadable for some source traces (${error.message}); disagreement and human-labeled counts may undercount.`;
    }
  }

  // 9. Summary (stdout + local receipt event ONLY — never written into
  // Phoenix beyond the experiment runs/evaluations themselves).
  const failedExamples = perExample.filter((entry) => entry.failures.length > 0 || entry.status !== "evaluated");
  const evidenceCounts = computeEvidenceCounts(perExample);
  const disagreements = detectSignalDisagreements(perExample);
  const currentMeans = computeEvaluationScoreMeans(perExample);
  const judgeRegressions = humanLabelRegressions(perExample);

  // Baseline score comparison: computable only when the repo-owned manifest
  // pins a baseline experiment for this dataset (CONSTRAINTS #35: receipts
  // never define the baseline).
  let baselineComparison = { computable: false, reason: "no_accepted_baseline_experiment_pinned_in_manifest" };
  const baselineEntry = baselineExperimentOverride !== undefined
    ? baselineExperimentOverride
    : selectBaselineExperimentForSummary({
        manifest,
        candidateTargetKey,
        dataset: { dataset_id: datasetId, dataset_version_id: datasetVersionId, name: datasetName },
        definition: resolvedDefinition,
      });
  if (baselineEntry?.experiment_id) {
    try {
      const baselineRecords = await phoenixFetchJson({
        appUrl,
        pathname: `/v1/experiments/${encodeURIComponent(baselineEntry.experiment_id)}/json`,
        fetchImpl,
      });
      const baselineMeans = meansFromBaselineExperimentJson(baselineRecords);
      baselineComparison = {
        computable: true,
        baseline_experiment_id: baselineEntry.experiment_id,
        ...compareExperimentScoreMeans({ currentMeans, baselineMeans }),
      };
    } catch (error) {
      baselineComparison = {
        computable: false,
        reason: "baseline_experiment_unresolvable",
        detail: error.message,
        baseline_experiment_id: baselineEntry.experiment_id,
      };
    }
  }

  const status = failedExamples.length === 0 ? "completed" : "completed_with_failures";
  const summary = {
    status,
    example_count: perExample.length,
    failed_example_count: failedExamples.length,
    failed_examples: failedExamples.map((entry) => ({
      example_id: entry.example_id,
      failures: entry.failures,
      status: entry.status,
    })),
    evidence_counts: evidenceCounts,
    split_selection: selected.selection,
    split_disclosure: selected.disclosure,
    metadata_stamp: metadataStampStatus,
    disagreements,
    judge_vs_human_regressions: judgeRegressions,
    score_means: currentMeans,
    baseline_comparison: baselineComparison,
    ...(humanAnnotationNote ? { human_annotation_note: humanAnnotationNote } : {}),
    eval_run_ids: perExample.map((entry) => entry.eval_run_id).filter(Boolean),
    experiment_run_ids: perExample.map((entry) => entry.experiment_run_id).filter(Boolean),
  };
  appendToReceipt({ receiptId, repoRoot, receiptDir }, (current) => {
    current.events.push({ type: "completed", at: now().toISOString(), summary });
  });

  return {
    ok: true,
    status,
    receipt_id: receiptId,
    receipt_path: receiptPath,
    teami_run_id: agenticFactoryRunId,
    phoenix_experiment_id: experiment.id,
    intent: intent.intent,
    intent_source: intent.source,
    variant_id: variant.id,
    candidate_target_key: receipt.launch.candidate_target_key,
    launch_baseline: baseline,
    dataset: { name: datasetName, dataset_id: datasetId, dataset_version_id: datasetVersionId },
    split: receipt.launch.split,
    metadata_stamp: metadataStampStatus,
    per_example: perExample,
    summary,
    deep_links: {
      experiment: `${appUrl}/datasets/${datasetId}/experiments/${experiment.id}`,
      dataset: `${appUrl}/datasets/${datasetId}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Receipt amendments: retroactive registration, reclassification, withdrawal.
// Identity is verified through the local resolver (REST GET of the
// experiment / prompt version); every amendment is an APPENDED event with
// actor, timestamp, reason, and action — prior receipt facts are never
// rewritten (CONSTRAINTS #21).
// ---------------------------------------------------------------------------

export async function amendExperimentReceipt({
  repoRoot = process.cwd(),
  receiptId,
  action,
  reason,
  experimentId = null,
  newIntent = null,
  receiptDir = null,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  if (!receiptId) return { ok: false, reason: "missing_receipt_id" };
  if (!EXPERIMENT_AMENDMENT_ACTIONS.includes(action)) {
    return {
      ok: false,
      reason: "invalid_amendment_action",
      detail: `--action must be one of ${EXPERIMENT_AMENDMENT_ACTIONS.join("|")}.`,
    };
  }
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, reason: "missing_amendment_reason", detail: "--reason is required for every amendment." };
  }

  const current = readExperimentReceipt({ receiptId, repoRoot, receiptDir });
  if (!current.ok) return { ok: false, reason: current.reason, path: current.path };
  if (!current.exists) return { ok: false, reason: "experiment_receipt_not_found", path: current.path };
  const state = deriveExperimentReceiptState(current.receipt);
  if (state.state === "withdrawn") {
    if (action === "withdraw") return { ok: false, reason: "receipt_already_withdrawn", receipt_id: receiptId };
    return {
      ok: false,
      reason: "receipt_withdrawn",
      detail: "a withdrawn receipt cannot be registered or reclassified; launch a new experiment instead.",
      receipt_id: receiptId,
    };
  }

  // Resolver verification (one verified local REST path; CONSTRAINTS #12).
  const resolveExperiment = async (id) => {
    let ready;
    try {
      ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
    } catch (error) {
      return { ok: false, reason: "local_phoenix_unavailable", detail: error.message };
    }
    if (!ready?.ok) return { ok: false, reason: "local_phoenix_unavailable", detail: ready?.reason || null };
    let body;
    try {
      body = await phoenixFetchJson({
        appUrl: ready.appUrl,
        pathname: `/v1/experiments/${encodeURIComponent(id)}`,
        fetchImpl,
      });
    } catch (error) {
      return { ok: false, reason: "experiment_unresolvable", detail: error.message, experiment_id: id };
    }
    const experiment = body?.data || null;
    if (!experiment?.id) return { ok: false, reason: "experiment_unresolvable", experiment_id: id };
    return { ok: true, ready, experiment };
  };

  const actor = assertedActor();
  const amendmentBase = {
    action,
    reason: reason.trim(),
    actor,
    amended_at: now().toISOString(),
  };

  let amendment;
  if (action === "register") {
    if (!experimentId) {
      return { ok: false, reason: "missing_experiment_id", detail: "--experiment-id is required for register." };
    }
    if (state.phoenix_experiment_id === experimentId) {
      return { ok: false, reason: "experiment_already_registered", experiment_id: experimentId };
    }
    if (state.phoenix_experiment_id && state.phoenix_experiment_id !== experimentId) {
      return {
        ok: false,
        reason: "conflicting_experiment_registration",
        detail: `receipt ${receiptId} already joins experiment ${state.phoenix_experiment_id}; registering ${experimentId} would rewrite that fact.`,
      };
    }
    const resolved = await resolveExperiment(experimentId);
    if (!resolved.ok) return resolved;
    if (resolved.experiment.dataset_id !== current.receipt.launch.dataset.dataset_id) {
      return {
        ok: false,
        reason: "experiment_dataset_mismatch",
        detail: `experiment ${experimentId} belongs to dataset ${resolved.experiment.dataset_id}, not the receipt's dataset ${current.receipt.launch.dataset.dataset_id}.`,
      };
    }
    const verification = {
      resolver: "phoenix_rest_get_experiment",
      experiment: {
        id: resolved.experiment.id,
        dataset_id: resolved.experiment.dataset_id,
        dataset_version_id: resolved.experiment.dataset_version_id ?? null,
        project_name: resolved.experiment.project_name ?? null,
      },
      dataset_version_matches_launch:
        (resolved.experiment.dataset_version_id ?? null)
        === current.receipt.launch.dataset.dataset_version_id,
    };
    // Candidate prompt version (when the launch candidate was one) must also
    // still resolve before retroactive registration.
    const candidateVersionId = current.receipt.launch.candidate.judge_candidate_prompt_version_id;
    if (candidateVersionId) {
      try {
        await phoenixFetchJson({
          appUrl: resolved.ready.appUrl,
          pathname: `/v1/prompt_versions/${encodeURIComponent(candidateVersionId)}`,
          fetchImpl,
        });
        verification.candidate_prompt_version_resolved = true;
      } catch (error) {
        return {
          ok: false,
          reason: "candidate_prompt_version_unresolvable",
          detail: error.message,
          prompt_version_id: candidateVersionId,
        };
      }
    }
    amendment = { ...amendmentBase, experiment_id: experimentId, verification };
  } else if (action === "reclassify") {
    if (!EXPERIMENT_INTENTS.includes(newIntent)) {
      return {
        ok: false,
        reason: "invalid_reclassify_intent",
        detail: `--intent must be one of ${EXPERIMENT_INTENTS.join("|")} for reclassify.`,
      };
    }
    if (newIntent === state.intent) {
      return { ok: false, reason: "intent_unchanged", detail: `receipt intent is already ${state.intent}.` };
    }
    let verification = { resolver: "none_required", note: "no phoenix experiment recorded on this receipt" };
    if (state.phoenix_experiment_id) {
      const resolved = await resolveExperiment(state.phoenix_experiment_id);
      if (!resolved.ok) return resolved;
      verification = {
        resolver: "phoenix_rest_get_experiment",
        experiment: { id: resolved.experiment.id, dataset_id: resolved.experiment.dataset_id },
      };
    }
    amendment = { ...amendmentBase, from_intent: state.intent, to_intent: newIntent, verification };
  } else {
    // withdraw
    let verification = { resolver: "none_required", note: "no phoenix experiment recorded on this receipt" };
    if (state.phoenix_experiment_id) {
      const resolved = await resolveExperiment(state.phoenix_experiment_id);
      if (!resolved.ok) return resolved;
      verification = {
        resolver: "phoenix_rest_get_experiment",
        experiment: { id: resolved.experiment.id, dataset_id: resolved.experiment.dataset_id },
      };
    }
    amendment = { ...amendmentBase, verification };
  }

  const written = appendToReceipt({ receiptId, repoRoot, receiptDir }, (receipt) => {
    receipt.amendments.push(amendment);
    if (action === "register") receipt.phoenix_experiment_id = experimentId;
  });
  return {
    ok: true,
    action,
    receipt_id: receiptId,
    receipt_path: written.path,
    amendment,
    state: deriveExperimentReceiptState(written.receipt),
  };
}

// ---------------------------------------------------------------------------
// Report rendering (agent-session summary; stdout + local record only).
// ---------------------------------------------------------------------------

export function formatExperimentReport(result) {
  const lines = [];
  if (!result.ok && (result.status === "not_run" || !result.receipt_id)) {
    lines.push(`FAIL phoenix experiment: ${result.reason || "not_run"}`);
    if (result.detail) lines.push(`  ${result.detail}`);
    if (result.missing) lines.push(`  missing examples: ${result.missing.join(", ")}`);
    if (result.failures) lines.push(`  failures: ${result.failures.join(", ")}`);
    if (result.available) lines.push(`  available variants: ${result.available.join(", ")}`);
    return lines;
  }
  if (!result.ok) {
    lines.push(`FAIL phoenix experiment: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    lines.push(`  receipt: ${result.receipt_path} (launch facts recorded; experiment not created)`);
    if (result.repair_hint) lines.push(`  repair: ${result.repair_hint}`);
    return lines;
  }
  const summary = result.summary;
  lines.push(`phoenix experiment ${result.phoenix_experiment_id} (receipt ${result.receipt_id}):`);
  lines.push(
    `  intent: ${result.intent} (${result.intent_source === "explicit_flag" ? "explicit flag" : "default — no repo-owned automation policy exists yet, so experiments default to exploratory; promotion_candidate requires the explicit --intent flag"})`,
  );
  lines.push(`  variant: ${result.variant_id} -> candidate target ${result.candidate_target_key}`);
  lines.push(
    `  baseline: ${result.launch_baseline.accepted_baseline_id} (derived from the repo-owned phoenix-assets manifest, never from caller input or the receipt)`,
  );
  lines.push(
    `  dataset: ${result.dataset.name} (${result.dataset.dataset_id}) version ${result.dataset.dataset_version_id}`,
  );
  lines.push(
    `  split: ${result.split.requested || "all"} via ${result.split.selection}${result.split.selection === "metadata_fallback" ? " — DISCLOSED fallback, not native split evidence" : ""}`,
  );
  if (result.split.disclosure) lines.push(`    ${result.split.disclosure}`);
  lines.push(
    `  examples: ${summary.example_count} run, ${summary.failed_example_count} with failures (${summary.status})`,
  );
  for (const failed of summary.failed_examples) {
    lines.push(`    FAILED ${failed.example_id}: ${failed.failures.join("; ") || failed.status}`);
  }
  const counts = summary.evidence_counts;
  lines.push(
    `  evidence_counts: train ${counts.train_examples} (${counts.train_human_labeled_examples} human-labeled), test ${counts.test_examples} (${counts.test_human_labeled_examples} human-labeled), human_label_authenticity ${counts.human_label_authenticity}`,
  );
  if (summary.human_annotation_note) lines.push(`    note: ${summary.human_annotation_note}`);
  const meanNames = Object.keys(summary.score_means).sort();
  if (meanNames.length > 0) {
    lines.push(
      `  score means: ${meanNames.map((name) => `${name}=${summary.score_means[name].toFixed(3)}`).join(", ")}`,
    );
  }
  if (summary.baseline_comparison.computable) {
    const deltas = summary.baseline_comparison.deltas;
    for (const [name, entry] of Object.entries(deltas)) {
      lines.push(
        `  vs baseline ${summary.baseline_comparison.baseline_experiment_id}: ${name} ${entry.delta >= 0 ? "+" : ""}${entry.delta.toFixed(3)} (${entry.baseline.toFixed(3)} -> ${entry.current.toFixed(3)})`,
      );
    }
    if (summary.baseline_comparison.regressions.length > 0) {
      lines.push(`  REGRESSIONS vs baseline: ${summary.baseline_comparison.regressions.join(", ")}`);
    }
  } else {
    lines.push(
      `  baseline score comparison: not computable (${summary.baseline_comparison.reason})`,
    );
  }
  if (summary.judge_vs_human_regressions.length > 0) {
    for (const regression of summary.judge_vs_human_regressions) {
      lines.push(
        `  judge-vs-human regression on ${regression.example_id}: human ${regression.human_label} -> judge ${regression.judge_label}`,
      );
    }
  }
  if (summary.disagreements.length > 0) {
    for (const disagreement of summary.disagreements) {
      const parts = Object.entries(disagreement.signals)
        .map(([signal, label]) => `${signal}=${label}`)
        .join(" ");
      lines.push(`  disagreement on ${disagreement.example_id}: ${parts}`);
    }
  } else {
    lines.push("  disagreements: none detected among available human/LLM/CODE signals");
  }
  if (summary.metadata_stamp !== "stamped") {
    lines.push(
      `  metadata stamp: ${summary.metadata_stamp} (create-time stamp is best-effort provenance; the receipt remains the primary join)`,
    );
  }
  lines.push(`  Phoenix: ${result.deep_links.experiment}`);
  lines.push(`  dataset: ${result.deep_links.dataset}`);
  lines.push(`  receipt: ${result.receipt_path}`);
  lines.push(
    "  summary is stdout + local receipt only; no workflow state was written to Phoenix beyond the experiment runs/evaluations themselves.",
  );
  return lines;
}

export function formatExperimentAmendmentReport(result) {
  const lines = [];
  if (!result.ok) {
    lines.push(`FAIL experiment receipt amendment: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    return lines;
  }
  lines.push(`PASS experiment receipt amendment: ${result.action} on ${result.receipt_id}`);
  lines.push(`  reason: ${result.amendment.reason}`);
  lines.push(`  actor: ${result.amendment.actor.os_username} (${result.amendment.actor.authenticity})`);
  if (result.action === "register") {
    lines.push(`  registered experiment: ${result.amendment.experiment_id}`);
  }
  if (result.action === "reclassify") {
    lines.push(`  intent: ${result.amendment.from_intent} -> ${result.amendment.to_intent}`);
  }
  lines.push(`  derived state: ${result.state.state}, intent ${result.state.intent}, experiment ${result.state.phoenix_experiment_id || "none"}`);
  lines.push(`  receipt: ${result.receipt_path} (append-only; prior facts unchanged)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Fetch helper (same conventions as the sibling modules; errors carry the
// HTTP status so split-fallback detection can branch on 404).
// ---------------------------------------------------------------------------

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
    const error = new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
    error.status = response.status;
    throw error;
  }
  return body;
}
