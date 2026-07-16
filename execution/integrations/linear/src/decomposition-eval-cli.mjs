import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildJudgeInputs,
  formatJudgeReport,
  judgeAllowedFailureModes,
  runDecompositionQualityJudge,
  runStoredDecompositionFixtureJudge,
} from "./decomposition-quality-judge.mjs";
import {
  acceptedPacketSufficiencyInputFromArtifact,
  emitDeterministicCheckResults,
  formatDeterministicCheckReport,
  nonStartingPhoenixReadyProbe,
} from "./deterministic-check-emission.mjs";
import { schemaErrors } from "./eval-structural-validator.mjs";
import { phoenixStatus } from "./local-phoenix-manager.mjs";
import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "./phase-contract.mjs";
import {
  buildProjectSnapshot,
  canonicalJsonStringify,
  loadCapturedProjectSnapshot,
} from "./project-snapshot-store.mjs";
import { renameWithRetry, runArtifactPath } from "../../../engine/run-store.mjs";
import {
  resolveJudgeRuntimeAssignment,
  resolveRoleRuntimeAssignments,
} from "./runtime-adapters.mjs";
import {
  readRuntimeSmokeCache,
  runtimeSmokeCachePath,
  smokeTestsFromRuntimeSmokeCache,
} from "./runtime-smoke.mjs";
import { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";
import {
  parseAcceptedPromptSnapshotSections,
} from "../../../engine/accepted-prompt-snapshot.mjs";
import {
  createProcessRuntimeExecutor,
  runDecompositionEvalMode,
} from "./trigger-runner.mjs";
import { createOrchestratorRoster } from "./orchestrator-roster.mjs";
import {
  DECOMPOSITION_EVAL_PATHS,
  decompositionEvalNamespacePath,
  resolveDecompositionEvalPath,
} from "./workflows/decomposition/eval-paths.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";

// Track E: the non-mutating decomposition eval-mode CLI task
// (`npm run eval:decomposition`). It WRAPS the existing
// runDecompositionEvalMode (plan ~1977: never a second eval task) so eval
// runs use the SAME phase loop and packet validation as live decomposition.
//
// Non-mutation guarantees (CONSTRAINTS #27), in structural layers:
//   1. The task never constructs a live Linear client. It builds a
//      snapshot-backed in-memory read client (createSnapshotEvalLinearClient)
//      that has NO mutation methods at all.
//   2. runDecompositionEvalMode additionally wraps whatever client it is
//      given in a read-only guard (createEvalModeReadOnlyLinearClient) that
//      throws on any non-read method, so even a misuse with a live client
//      cannot mutate.
//   3. Gateway wakes are structurally out of reach: this module never imports
//      the local trigger store and eval mode takes no wake store;
//      the only wake-shaped object is the local `eval_<run_id>` pseudo-wake.
//
// Phoenix stays lazy (CONSTRAINTS #40): traces are exported through the
// existing local trace sink with a NON-STARTING readiness probe, so eval runs
// emit Phoenix traces when Phoenix is already up and degrade to local
// receipts when it is not. --emit-checks / --judge chain the step-5/step-6
// exports over the in-memory outputs and are equally offline-tolerant
// (report-only when Phoenix is down).

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const exampleSchema = JSON.parse(
  fs.readFileSync(
    resolveDecompositionEvalPath(MODULE_REPO_ROOT, decompositionEvalNamespacePath("example.schema.json")),
    "utf8",
  ),
);

export const EVAL_RUN_RECORD_SCHEMA_VERSION = "linear-decomposition-eval-run/v1";
export const EVAL_VARIANTS_SCHEMA_VERSION_V1 = "decomposition-eval-variants/v1";
export const EVAL_VARIANTS_SCHEMA_VERSION = "decomposition-eval-variants/v2";
export const DEFAULT_EVAL_VARIANTS_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  DECOMPOSITION_EVAL_PATHS.variants,
);
export const ACCEPTED_BASELINE_VARIANT_ID = "accepted_baseline";

const PHOENIX_ASSETS_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  DECOMPOSITION_EVAL_PATHS.manifest,
);
const SUPPORTED_EVAL_VARIANTS_SCHEMA_VERSIONS = new Set([
  EVAL_VARIANTS_SCHEMA_VERSION_V1,
  EVAL_VARIANTS_SCHEMA_VERSION,
]);
const VARIANT_ROLES = new Set(["pm", "sr_eng", "judge"]);
const VARIANT_ENTRY_KEYS = new Set([
  "description",
  "role_overrides",
  "judge_candidate_prompt_version_id",
  "_note",
]);
const VARIANT_ENTRY_KEYS_V2 = new Set([...VARIANT_ENTRY_KEYS, "prompt_overrides"]);
const ROLE_OVERRIDE_KEYS = new Set(["runtime", "model"]);
const PROMPT_OVERRIDE_KEYS = new Set(["candidate_prompt_version_id"]);
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Local eval-run record store (.teami/eval-runs/, gitignored via
// the existing .teami/ ignore; same atomic write conventions as the
// run store). Phase artifacts/checkpoints/snapshots for eval runs live in the
// `runs/` subdirectory of this store so eval custody never mixes with live
// wake-run custody under .teami/runs/.
// ---------------------------------------------------------------------------

export function defaultEvalRunStoreDir(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, "eval-runs");
}

export function evalRunRecordPath({ evalRunId, repoRoot = null, home = resolveTeamiHome(), evalRunStoreDir = null } = {}) {
  void repoRoot;
  if (!evalRunId || typeof evalRunId !== "string" || !SAFE_RUN_ID_PATTERN.test(evalRunId)) {
    throw new Error(`Invalid eval_run_id for the local eval-run record store: ${evalRunId}`);
  }
  return path.join(evalRunStoreDir || defaultEvalRunStoreDir(home), `${evalRunId}.json`);
}

export function writeEvalRunRecord({ evalRunId, repoRoot = null, home = resolveTeamiHome(), evalRunStoreDir = null } = {}, record) {
  const filePath = evalRunRecordPath({ evalRunId, repoRoot, home, evalRunStoreDir });
  if (record?.schema_version !== EVAL_RUN_RECORD_SCHEMA_VERSION) {
    throw new Error("eval-run record must carry the eval-run record schema version.");
  }
  // JSON-normalize first so the read-back comparison is exact.
  const normalized = JSON.parse(JSON.stringify(record));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(tempPath, "utf8"));
  renameWithRetry(tempPath, filePath);
  const readBack = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (JSON.stringify(readBack) !== JSON.stringify(normalized)) {
    throw new Error("Eval-run record read-back validation failed.");
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Candidate variants (repo-owned execution/evals/decomposition/variants.json).
// A variant is an EXPERIMENT identity only: selecting one never changes
// accepted behavior (CONSTRAINTS #19/#20). The default is the no-override
// accepted baseline. Strict loading fails closed on unknown variant ids,
// unknown keys, unknown roles, and malformed overrides.
// ---------------------------------------------------------------------------

export function evalVariantValidationFailures(parsed, { repoRoot = process.cwd() } = {}) {
  const failures = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["variants_not_object"];
  if (!SUPPORTED_EVAL_VARIANTS_SCHEMA_VERSIONS.has(parsed.schema_version)) {
    failures.push("unsupported_variants_schema_version");
  }
  if (!parsed.variants || typeof parsed.variants !== "object" || Array.isArray(parsed.variants)) {
    failures.push("missing_variants_map");
    return failures;
  }
  if (typeof parsed.default_variant !== "string" || !Object.hasOwn(parsed.variants, parsed.default_variant)) {
    failures.push("default_variant_not_defined");
  }
  let promptTargetKeys = null;
  const ensurePromptTargetKeys = () => {
    if (promptTargetKeys) return promptTargetKeys;
    try {
      promptTargetKeys = new Set(
        (readPhoenixAssetsManifestForVariants(repoRoot).prompts || [])
          .map((prompt) => prompt?.target_key)
          .filter((value) => typeof value === "string" && value.trim() !== ""),
      );
    } catch (error) {
      failures.push(`prompt_override_manifest_unavailable:${error.message}`);
      promptTargetKeys = new Set();
    }
    return promptTargetKeys;
  };

  for (const [id, entry] of Object.entries(parsed.variants)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failures.push(`invalid_variant_entry:${id}`);
      continue;
    }
    const variantEntryKeys = parsed.schema_version === EVAL_VARIANTS_SCHEMA_VERSION
      ? VARIANT_ENTRY_KEYS_V2
      : VARIANT_ENTRY_KEYS;
    for (const key of Object.keys(entry)) {
      if (!variantEntryKeys.has(key)) failures.push(`unknown_variant_key:${id}:${key}`);
    }
    const overrides = entry.role_overrides ?? {};
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      failures.push(`invalid_role_overrides:${id}`);
      continue;
    }
    for (const [role, override] of Object.entries(overrides)) {
      if (!VARIANT_ROLES.has(role)) {
        failures.push(`unknown_variant_role:${id}:${role}`);
        continue;
      }
      if (!override || typeof override !== "object" || Array.isArray(override)) {
        failures.push(`invalid_role_override:${id}:${role}`);
        continue;
      }
      for (const [key, value] of Object.entries(override)) {
        if (!ROLE_OVERRIDE_KEYS.has(key)) failures.push(`unknown_role_override_key:${id}:${role}:${key}`);
        else if (typeof value !== "string" || value.trim() === "") {
          failures.push(`invalid_role_override_value:${id}:${role}:${key}`);
        }
      }
    }
    if (
      entry.judge_candidate_prompt_version_id !== undefined
      && entry.judge_candidate_prompt_version_id !== null
      && (typeof entry.judge_candidate_prompt_version_id !== "string"
        || entry.judge_candidate_prompt_version_id.trim() === "")
    ) {
      failures.push(`invalid_judge_candidate_prompt_version_id:${id}`);
    }
    const promptOverrides = parsed.schema_version === EVAL_VARIANTS_SCHEMA_VERSION
      ? entry.prompt_overrides ?? {}
      : {};
    if (typeof promptOverrides !== "object" || Array.isArray(promptOverrides)) {
      failures.push(`invalid_prompt_overrides:${id}`);
      continue;
    }
    if (Object.keys(promptOverrides).length > 0) {
      const targetKeys = ensurePromptTargetKeys();
      for (const [targetKey, override] of Object.entries(promptOverrides)) {
        if (!targetKeys.has(targetKey)) {
          failures.push(`unknown_prompt_override_target:${id}:${targetKey}`);
          continue;
        }
        if (!override || typeof override !== "object" || Array.isArray(override)) {
          failures.push(`invalid_prompt_override:${id}:${targetKey}`);
          continue;
        }
        for (const [key, value] of Object.entries(override)) {
          if (!PROMPT_OVERRIDE_KEYS.has(key)) {
            failures.push(`unknown_prompt_override_key:${id}:${targetKey}:${key}`);
          } else if (typeof value !== "string" || value.trim() === "") {
            failures.push(`invalid_prompt_override_value:${id}:${targetKey}:${key}`);
          }
        }
      }
    }
  }
  return [...new Set(failures)];
}

export function resolveEvalVariant({ variantId = null, variantsPath = DEFAULT_EVAL_VARIANTS_PATH, repoRoot = process.cwd() } = {}) {
  if (!fs.existsSync(variantsPath)) {
    if (variantId) {
      return { ok: false, reason: "variants_config_missing", variant_id: variantId, path: variantsPath };
    }
    // No variants config and no requested variant: the built-in default IS
    // the current accepted behavior (zero overrides).
    return {
      ok: true,
      variant: {
        id: ACCEPTED_BASELINE_VARIANT_ID,
        role_overrides: {},
        judge_candidate_prompt_version_id: null,
        prompt_overrides: {},
        source: "builtin_default",
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(variantsPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: "variants_config_unreadable", path: variantsPath, detail: error.message };
  }
  const failures = evalVariantValidationFailures(parsed, { repoRoot });
  if (failures.length > 0) {
    return { ok: false, reason: "invalid_variants_config", path: variantsPath, failures };
  }
  const resolvedId = variantId || parsed.default_variant;
  const entry = parsed.variants[resolvedId];
  if (!entry) {
    return {
      ok: false,
      reason: "unknown_variant",
      variant_id: resolvedId,
      available: Object.keys(parsed.variants),
      path: variantsPath,
    };
  }
  return {
    ok: true,
    variant: {
      id: resolvedId,
      description: entry.description ?? null,
      role_overrides: structuredClone(entry.role_overrides ?? {}),
      judge_candidate_prompt_version_id: entry.judge_candidate_prompt_version_id ?? null,
      prompt_overrides: structuredClone(entry.prompt_overrides ?? {}),
      source: variantId ? "variants_config" : "variants_config_default",
    },
  };
}

// Variant overrides resolve into a DERIVED config: the committed config is
// never mutated, and only role runtime/model fields can change.
export function applyVariantToConfig(config, variant) {
  const derived = structuredClone(config);
  const overrides = variant?.role_overrides ?? {};
  if (Object.keys(overrides).length === 0) return derived;
  derived.workflows ??= {};
  derived.workflows.decomposition ??= {};
  derived.workflows.decomposition.roles ??= {};
  const roles = resolveWorkflowRuntime(derived, "decomposition").roles;
  for (const [role, override] of Object.entries(overrides)) {
    roles[role] = {
      ...(roles[role] || {}),
      ...override,
    };
  }
  return derived;
}

function readPhoenixAssetsManifestForVariants(repoRoot = process.cwd()) {
  const candidatePath = path.resolve(repoRoot, DECOMPOSITION_EVAL_PATHS.manifest);
  const manifestPath = fs.existsSync(candidatePath) ? candidatePath : PHOENIX_ASSETS_PATH;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export async function resolveEvalPromptOverrides({
  variant,
  repoRoot = process.cwd(),
  ensureReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  const overrides = variant?.prompt_overrides ?? {};
  if (Object.keys(overrides).length === 0) {
    return { ok: true, acceptedPromptOverrides: null, metadata: {} };
  }
  let ready;
  try {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  } catch (error) {
    return { ok: false, reason: "local_phoenix_unavailable", detail: error.message };
  }
  if (!ready?.ok) {
    return { ok: false, reason: "local_phoenix_unavailable", detail: ready?.reason || null };
  }

  const acceptedPromptOverrides = {};
  const metadata = {};
  for (const [targetKey, override] of Object.entries(overrides)) {
    const candidatePromptVersionId = override.candidate_prompt_version_id;
    let body;
    try {
      body = await phoenixFetchJson({
        appUrl: ready.appUrl,
        pathname: `/v1/prompt_versions/${encodeURIComponent(candidatePromptVersionId)}`,
        fetchImpl,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "candidate_prompt_version_unresolvable",
        target_key: targetKey,
        candidate_prompt_version_id: candidatePromptVersionId,
        detail: error.message,
      };
    }
    const extracted = extractCandidatePromptVersionContent(body);
    if (!extracted.ok) {
      return {
        ok: false,
        reason: "candidate_prompt_content_unavailable",
        target_key: targetKey,
        candidate_prompt_version_id: candidatePromptVersionId,
      };
    }
    // Orchestrator eval semantics: a candidate prompt is a FULL accepted-prompt
    // body for a library subagent target (no fixed phase sections to require —
    // the phase machinery is retired). It must still parse as a well-formed
    // accepted-prompt snapshot body (header/sentinel/placeholder safety).
    try {
      parseAcceptedPromptSnapshotSections(extracted.content);
    } catch (error) {
      return {
        ok: false,
        reason: error?.reason || "candidate_prompt_sections_invalid",
        target_key: targetKey,
        candidate_prompt_version_id: candidatePromptVersionId,
        detail: error.message,
      };
    }
    const candidatePromptSha256 = createHash("sha256")
      .update(Buffer.from(extracted.content, "utf8"))
      .digest("hex");
    // The override body is the candidate prompt content; the roster uses it as
    // the library subagent body for this target when the loop invokes it.
    acceptedPromptOverrides[targetKey] = { contentBytes: extracted.content };
    metadata[targetKey] = {
      candidate_prompt_version_id: candidatePromptVersionId,
      candidate_prompt_sha256: candidatePromptSha256,
      prompt_source: "phoenix_candidate_version",
    };
  }

  return { ok: true, acceptedPromptOverrides, metadata };
}

function extractCandidatePromptVersionContent(resolvedCandidate) {
  const version = unwrapPromptVersionResponse(resolvedCandidate);
  if (!version || typeof version !== "object" || Array.isArray(version)) return { ok: false };
  if (normalizePhoenixEnum(version.template_format ?? version.templateFormat) !== "NONE") {
    return { ok: false };
  }
  if (normalizePhoenixEnum(version.template_type ?? version.templateType) !== "CHAT") {
    return { ok: false };
  }
  const template = version.template;
  if (!template || typeof template !== "object" || Array.isArray(template)) return { ok: false };
  if (normalizePhoenixEnum(template.type) !== "CHAT") return { ok: false };
  if (!Array.isArray(template.messages)) return { ok: false };
  const systemMessages = template.messages.filter(
    (message) => normalizePhoenixEnum(message?.role) === "SYSTEM",
  );
  if (systemMessages.length !== 1) return { ok: false };
  const { content } = systemMessages[0];
  if (typeof content !== "string" || content.trim() === "") return { ok: false };
  return { ok: true, content, version };
}

function unwrapPromptVersionResponse(resolvedCandidate) {
  if (!resolvedCandidate || typeof resolvedCandidate !== "object" || Array.isArray(resolvedCandidate)) {
    return null;
  }
  const rawLooksLikeVersion = looksLikePromptVersion(resolvedCandidate);
  const data = resolvedCandidate.data;
  const dataLooksLikeVersion = looksLikePromptVersion(data);
  if (rawLooksLikeVersion && dataLooksLikeVersion) return null;
  if (dataLooksLikeVersion) return data;
  if (rawLooksLikeVersion) return resolvedCandidate;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return null;
}

function looksLikePromptVersion(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && (
        value.template
        || value.template_type
        || value.templateType
        || value.template_format
        || value.templateFormat
      ),
  );
}

function normalizePhoenixEnum(value) {
  return typeof value === "string" ? value.trim().replace(/-/g, "_").toUpperCase() : "";
}

// ---------------------------------------------------------------------------
// Input resolution: --run | --example | --dataset+--example-id all normalize
// to the same in-memory project-snapshot input shape (example.schema.json
// input.project) plus the source run envelope when the source recorded one.
// ---------------------------------------------------------------------------

function normalizeExampleProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: typeof project.description === "string" ? project.description : null,
    comments: agentVisibleProjectComments(project.comments),
    content: project.content,
    status: project.status,
    labels: Array.isArray(project.labels) ? project.labels : [],
    existing_issues: Array.isArray(project.existing_issues) ? project.existing_issues : [],
  };
}

function agentVisibleProjectComments(comments) {
  return (Array.isArray(comments) ? comments : []).map((comment) => ({
    author_id: comment?.author_id ?? comment?.user?.id ?? null,
    body: typeof comment?.body === "string" ? comment.body : "",
    created_at: comment?.created_at ?? comment?.createdAt ?? null,
  }));
}

function reconstructExampleFromDatasetRecord(record) {
  const metadata = record?.metadata && typeof record.metadata === "object" ? { ...record.metadata } : {};
  const reference = metadata.reference && typeof metadata.reference === "object" ? metadata.reference : {};
  const schemaVersion = metadata.schema_version;
  delete metadata.reference;
  delete metadata.schema_version;
  return {
    ...(schemaVersion !== undefined ? { schema_version: schemaVersion } : {}),
    input: record?.input,
    output: record?.output,
    reference,
    metadata,
  };
}

export async function resolveDecompositionEvalInput({
  repoRoot = process.cwd(),
  runId = null,
  examplePath = null,
  datasetName = null,
  datasetExampleId = null,
  liveRunStoreDir = null,
  phoenixProbe = phoenixStatus,
  fetchImpl = globalThis.fetch,
} = {}) {
  const modes = [
    runId ? "run" : null,
    examplePath ? "example" : null,
    datasetName || datasetExampleId ? "dataset" : null,
  ].filter(Boolean);
  if (modes.length !== 1 || (modes[0] === "dataset" && (!datasetName || !datasetExampleId))) {
    return {
      ok: false,
      reason: "invalid_input_selection",
      detail: "Provide exactly one input: --run <run_id> | --example <path> | --dataset <name> --example-id <id>.",
    };
  }

  if (modes[0] === "run") {
    // Captured-at-run snapshot only; fails closed on missing/tampered
    // snapshot with the loader's typed result (no live Linear fallback).
    const loaded = loadCapturedProjectSnapshot(runId, { repoRoot, runStoreDir: liveRunStoreDir });
    if (!loaded.ok) return { ok: false, ...loaded };
    return {
      ok: true,
      mode: "run",
      project: normalizeExampleProject(loaded.snapshot.project),
      source: {
        mode: "run",
        run_id: runId,
        snapshot_path: loaded.path,
        snapshot_hash: loaded.snapshot.snapshot_hash,
        capture_source: loaded.snapshot.capture_source,
      },
      source_run_envelope: null,
    };
  }

  if (modes[0] === "example") {
    const resolvedPath = path.resolve(repoRoot, examplePath);
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, reason: "missing_example_file", path: resolvedPath };
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (error) {
      return { ok: false, reason: "invalid_example_json", path: resolvedPath, detail: error.message };
    }
    // Shared structural validator over the canonical example contract; any
    // mismatch fails closed before execution.
    const errors = schemaErrors(exampleSchema, parsed, exampleSchema);
    if (errors.length > 0) {
      return { ok: false, reason: "example_schema_mismatch", path: resolvedPath, schema_errors: errors };
    }
    return {
      ok: true,
      mode: "example",
      project: normalizeExampleProject(parsed.input.project),
      source: { mode: "example", example_path: resolvedPath },
      source_run_envelope: parsed.input.run_envelope ?? null,
      example: parsed,
    };
  }

  // Dataset mode: verified Phoenix REST GET path only (GET /v1/datasets?name=
  // then GET /v1/datasets/{id}/examples). Phoenix stays lazy: a non-starting
  // probe is used, and an unreachable Phoenix degrades to a typed failure.
  let status;
  try {
    status = await phoenixProbe({ repoRoot, fetchImpl });
  } catch (error) {
    return { ok: false, reason: "local_phoenix_unavailable", detail: error.message };
  }
  if (!status?.ok) {
    return {
      ok: false,
      reason: "local_phoenix_unavailable",
      detail: status?.status || "phoenix_not_running",
      repairHint: status?.repairHint || "Run npm run phoenix:start, then retry.",
    };
  }
  let datasetId;
  let record;
  try {
    const datasets = await phoenixFetchJson({
      appUrl: status.appUrl,
      pathname: "/v1/datasets",
      searchParams: { name: datasetName },
      fetchImpl,
    });
    const dataset = (datasets?.data || []).find((candidate) => candidate?.name === datasetName) || null;
    if (!dataset?.id) {
      return { ok: false, reason: "dataset_not_found", dataset_name: datasetName, appUrl: status.appUrl };
    }
    datasetId = dataset.id;
    const body = await phoenixFetchJson({
      appUrl: status.appUrl,
      pathname: `/v1/datasets/${encodeURIComponent(datasetId)}/examples`,
      fetchImpl,
    });
    const examples = body?.data?.examples || (Array.isArray(body?.data) ? body.data : []);
    record = examples.find(
      (candidate) =>
        candidate?.id === datasetExampleId
        || candidate?.metadata?.source_run_id === datasetExampleId,
    ) || null;
  } catch (error) {
    return { ok: false, reason: "phoenix_request_failed", detail: error.message, appUrl: status.appUrl };
  }
  if (!record) {
    return {
      ok: false,
      reason: "dataset_example_not_found",
      dataset_name: datasetName,
      dataset_id: datasetId,
      example_id: datasetExampleId,
    };
  }
  const example = reconstructExampleFromDatasetRecord(record);
  const errors = schemaErrors(exampleSchema, example, exampleSchema);
  if (errors.length > 0) {
    return {
      ok: false,
      reason: "example_schema_mismatch",
      dataset_name: datasetName,
      dataset_id: datasetId,
      example_id: datasetExampleId,
      schema_errors: errors,
    };
  }
  return {
    ok: true,
    mode: "dataset",
    project: normalizeExampleProject(example.input.project),
    source: {
      mode: "dataset",
      dataset_name: datasetName,
      dataset_id: datasetId,
      example_id: record.id ?? datasetExampleId,
    },
    source_run_envelope: example.input.run_envelope ?? null,
    example,
  };
}

// ---------------------------------------------------------------------------
// Snapshot-backed read-only Linear client: the ONLY client the eval task ever
// constructs. It answers exactly the read surface eval-mode decomposition
// needs (shape resolution + project context) from the in-memory snapshot and
// has NO mutation methods at all — there is nothing to call even if a future
// code path tried (CONSTRAINTS #27).
// ---------------------------------------------------------------------------

export function createSnapshotEvalLinearClient({ config, project } = {}) {
  if (!project?.id || typeof project.id !== "string") {
    throw new Error("eval snapshot project requires a stable project id.");
  }
  if (typeof project.content !== "string" || !project.status) {
    throw new Error("eval snapshot project requires content and a semantic status.");
  }
  const teamId = "eval-team-1";
  const team = { id: teamId, key: config.linear.team.key, name: config.linear.team.name };
  const statuses = Object.entries(config.linear.project.statuses).map(([semantic, status]) => ({
    id: `eval-status-${semantic}`,
    role: semantic,
    name: status.name,
    type: status.type,
  }));
  const issueStatuses = Object.entries(config.linear.issue.statuses)
    .filter(([semantic]) =>
      ["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"].includes(semantic)
    )
    .map(([semantic, status]) => ({
      id: `eval-issue-status-${semantic}`,
      role: semantic,
      name: status.name,
      type: status.type,
      teamId,
    }));
  const statusFor = (semantic) => {
    const normalized = String(semantic || "").trim().toLowerCase().replace(/\s+/g, "_");
    return statuses.find((status) => status.role === normalized)
      || statuses.find((status) => status.type === normalized)
      || statuses.find((status) => status.name.trim().toLowerCase().replace(/\s+/g, "_") === normalized)
      || { id: "eval-status-unmapped", name: String(semantic), type: String(semantic) };
  };

  const discoveryLabelName = config.linear.issue.labels.discovery;
  let discoveryLabelId = null;
  for (const issue of project.existing_issues || []) {
    const match = (issue?.labels || []).find((label) => label?.name === discoveryLabelName);
    if (match?.id) {
      discoveryLabelId = match.id;
      break;
    }
  }
  const discoveryLabel = {
    id: discoveryLabelId || "eval-ilabel-discovery",
    name: discoveryLabelName,
    teamId,
  };
  const humanReviewLabelName = config.linear.issue.labels.human_review;
  const humanReviewLabel = {
    id: "eval-ilabel-human-review",
    name: humanReviewLabelName,
    teamId,
  };
  const template = {
    id: "eval-template-1",
    name: config.linear.project.template_name,
    type: "project",
    teamId,
  };

  const projectContext = {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    comments: agentVisibleProjectComments(project.comments),
    content: project.content,
    teamIds: [teamId],
    status: statusFor(project.status),
    labels: (project.labels || []).map((label) => ({
      id: label?.id ?? null,
      name: label?.name ?? null,
    })),
  };
  const issues = (project.existing_issues || []).map((issue) => ({
    id: issue?.id ?? null,
    identifier: issue?.identifier ?? null,
    title: issue?.title ?? null,
    state: issue?.state ?? null,
    labels: (issue?.labels || []).map((label) => ({
      id: label?.id ?? null,
      name: label?.name ?? null,
    })),
    projectId: project.id,
  }));

  const client = Object.freeze({
    async listTeams() {
      return [team];
    },
    async listProjectStatuses() {
      return statuses;
    },
    async listWorkflowStates() {
      return issueStatuses;
    },
    async findProjectLabelsByName(name) {
      return (project.labels || []).filter((label) => !name || label?.name === name);
    },
    async findIssueLabelsByName(name, forTeamId) {
      return [discoveryLabel, humanReviewLabel]
        .filter((label) => label.name === name && forTeamId === teamId);
    },
    async findTemplatesByName(name, type, forTeamId) {
      return name === template.name && type === template.type && forTeamId === teamId
        ? [template]
        : [];
    },
    async getProjectContext(id) {
      if (id !== project.id) {
        throw new Error(`eval_snapshot_unknown_project:${String(id)}`);
      }
      return { ...projectContext, issues };
    },
  });

  const cache = {
    teamId,
    projectTemplateId: template.id,
    projectStatuses: Object.fromEntries(statuses.map((status) => [status.role, status.id])),
    projectStatusTypes: Object.fromEntries(statuses.map((status) => [status.role, status.type])),
    issueStatuses: Object.fromEntries(issueStatuses.map((status) => [status.role, status.id])),
    issueLabels: {
      [discoveryLabel.name]: discoveryLabel.id,
      [humanReviewLabel.name]: humanReviewLabel.id,
    },
  };

  return {
    client,
    cache,
    shape: {
      teamId,
      discoveryLabelId: discoveryLabel.id,
      statusIds: cache.projectStatuses,
      attentionStatusId: cache.projectStatuses.needs_principal,
      projectContext: { ...projectContext, issues },
    },
  };
}

// ---------------------------------------------------------------------------
// Eval-run identity and inputs hash.
// ---------------------------------------------------------------------------

export function buildEvalRunEnvelope({ config } = {}) {
  const assignments = resolveRoleRuntimeAssignments(config, "decomposition");
  const judgeAssignment = resolveJudgeRuntimeAssignment(config);
  return {
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    allowed_source_boundaries: ["from_configured_run_envelope"],
    runtime_assignments: {
      pm: `${assignments.pm.runtime}/${assignments.pm.model}`,
      sr_eng: `${assignments.sr_eng.runtime}/${assignments.sr_eng.model}`,
      ...(judgeAssignment.model
        ? { judge: `${judgeAssignment.runtime}/${judgeAssignment.model}` }
        : {}),
    },
  };
}

export function computeEvalInputsHash({ project, runEnvelope, variant } = {}) {
  return createHash("sha256")
    .update(
      canonicalJsonStringify({
        source_type: "linear_project_snapshot",
        project: normalizeExampleProject(project || {}),
        run_envelope: runEnvelope ?? null,
        variant: {
          id: variant?.id ?? null,
          role_overrides: variant?.role_overrides ?? {},
          judge_candidate_prompt_version_id: variant?.judge_candidate_prompt_version_id ?? null,
          prompt_overrides: variant?.prompt_overrides ?? {},
          resolved_prompt_overrides: variant?.resolved_prompt_overrides ?? {},
        },
      }),
      "utf8",
    )
    .digest("hex");
}

function generateEvalRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  return `eval-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function createDefaultEvalRuntimeExecutor({ config, repoRoot = process.cwd(), home = resolveTeamiHome() } = {}) {
  const smokeCache = readRuntimeSmokeCache(runtimeSmokeCachePath(config, home));
  return createProcessRuntimeExecutor({
    smokeTests: smokeTestsFromRuntimeSmokeCache(smokeCache),
    repoRoot,
  });
}

// ---------------------------------------------------------------------------
// The eval task.
//
// Returns (and records under .teami/eval-runs/<eval_run_id>.json):
//   { ok, status: "evaluated"|"ineligible"|"failed_closed"|"not_run", reason?,
//     eval_run_id, variant_id, inputs_hash, non_mutating: true,
//     mutation_skipped, subagent_invocations, artifact, artifact_path, terminal,
//     trace: {trace_id, trace_status, phoenix_app_url},
//     evaluator_inputs: {check_inputs, judge_inputs}, checks, judge,
//     record_path, source }
// ---------------------------------------------------------------------------

export async function runDecompositionEvalTask({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  config,
  runId = null,
  examplePath = null,
  datasetName = null,
  datasetExampleId = null,
  variantId = null,
  emitChecks = false,
  judge = false,
  teamContext = null,
  evalRunId = null,
  evalRunStoreDir = null,
  liveRunStoreDir = null,
  variantsPath = DEFAULT_EVAL_VARIANTS_PATH,
  runtimeExecutor = null,
  orchestratorTurnExecutor = null,
  traceSink = null,
  ensureReady = null,
  phoenixProbe = phoenixStatus,
  fetchImpl = globalThis.fetch,
  emitChecksFn = emitDeterministicCheckResults,
  runJudgeFn = runDecompositionQualityJudge,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  if (!config) {
    return { ok: false, status: "not_run", reason: "missing_config" };
  }

  // 1. Variant resolution (fail closed before any execution); default is the
  // current accepted behavior with zero overrides.
  const variantResolution = resolveEvalVariant({ variantId, variantsPath, repoRoot });
  if (!variantResolution.ok) {
    return { ok: false, status: "not_run", ...variantResolution };
  }
  const variant = variantResolution.variant;
  const evalConfig = applyVariantToConfig(config, variant);
  const readyProbe = ensureReady || nonStartingPhoenixReadyProbe({ repoRoot, fetchImpl });
  const promptOverridesResolution = await resolveEvalPromptOverrides({
    variant,
    repoRoot,
    ensureReady: readyProbe,
    fetchImpl,
    onProgress,
  });
  if (!promptOverridesResolution.ok) {
    return { ok: false, status: "not_run", variant_id: variant.id, ...promptOverridesResolution };
  }
  const variantWithResolvedPromptOverrides = {
    ...variant,
    resolved_prompt_overrides: promptOverridesResolution.metadata,
  };

  // 2. Input resolution: every path normalizes to the same in-memory project
  // snapshot + run-envelope input.
  const input = await resolveDecompositionEvalInput({
    repoRoot,
    runId,
    examplePath,
    datasetName,
    datasetExampleId,
    liveRunStoreDir,
    phoenixProbe,
    fetchImpl,
  });
  if (!input.ok) {
    return { ok: false, status: "not_run", variant_id: variant.id, ...input };
  }

  const resolvedEvalRunId = evalRunId || generateEvalRunId(now());
  if (!SAFE_RUN_ID_PATTERN.test(resolvedEvalRunId)) {
    return { ok: false, status: "not_run", reason: "invalid_eval_run_id", eval_run_id: resolvedEvalRunId };
  }
  const evalStoreDir = evalRunStoreDir || defaultEvalRunStoreDir(home);
  const evalArtifactDir = path.join(evalStoreDir, "runs");

  const runEnvelope = buildEvalRunEnvelope({ config: evalConfig });
  const inputsHash = computeEvalInputsHash({
    project: input.project,
    runEnvelope,
    variant: variantWithResolvedPromptOverrides,
  });

  // 3. Constructor-injected non-mutation: snapshot-backed read client with no
  // mutation surface; the eval-mode guard inside runDecompositionEvalMode is
  // the second wall.
  const snapshotClient = createSnapshotEvalLinearClient({ config: evalConfig, project: input.project });
  const executor = runtimeExecutor || createDefaultEvalRuntimeExecutor({ config: evalConfig, repoRoot, home });

  // 4. Trace export through the EXISTING trace sink, Phoenix kept lazy: the
  // default readiness probe never boots Phoenix; degraded mode records local
  // trace receipts exactly like the live runner does.
  const sink = traceSink || createLocalPhoenixTraceSink({ repoRoot, ensureReady: readyProbe, fetchImpl });
  const ownsSink = !traceSink;
  const pseudoWake = {
    id: `eval_${resolvedEvalRunId}`,
    object_id: input.project.id,
    workflow_type: "decomposition",
    trigger_type: "eval.local",
  };

  let session = null;
  let result;
  let traceDelivery = null;
  try {
    session = await Promise.resolve(
      sink.startRun?.({
        wake: pseudoWake,
        sourceEvent: null,
        runId: resolvedEvalRunId,
        workspaceId: teamContext?.linear?.workspaceId || null,
        runnerId: "local_eval_cli",
        runnerVersion: "eval",
        teamContext,
      }),
    ).catch((error) => ({ ok: false, traceId: null, status: "trace_unavailable", reason: error.message }));

    try {
      // Orchestrator eval semantics: candidate prompt overrides (if any) ride on
      // the roster so the loop's library invocations load the candidate body for
      // the overridden target instead of the manifest snapshot.
      const evalRoster = createOrchestratorRoster({
        workflowType: "decomposition",
        repoRoot,
        acceptedPromptOverrides: promptOverridesResolution.acceptedPromptOverrides,
      });
      result = await runDecompositionEvalMode({
        linearClient: snapshotClient.client,
        config: evalConfig,
        cache: snapshotClient.cache,
        projectId: input.project.id,
        runtimeExecutor: executor,
        ...(orchestratorTurnExecutor ? { orchestratorTurnExecutor } : {}),
        roster: evalRoster,
        runId: resolvedEvalRunId,
        repoRoot,
        home,
        runStoreDir: evalArtifactDir,
        traceId: session?.traceId || null,
        teamContext,
      });
    } catch (error) {
      result = {
        status: "failed_closed",
        failureReasons: [`eval_runtime_failed:${error.message}`],
        trace: null,
      };
    }
    traceDelivery = await Promise.resolve(sink.finishRun?.({ session, result, wake: pseudoWake }))
      .catch((error) => ({ status: "trace_delivery_failed", reason: error.message }));
  } finally {
    if (ownsSink) await Promise.resolve(sink.shutdown?.()).catch(() => {});
  }

  const traceId = session?.traceId || null;
  const traceStatus = traceDelivery?.status || session?.status || "trace_unknown";
  const phoenixAppUrl = traceDelivery?.phoenixAppUrl || session?.phoenixAppUrl || null;

  // 5. Outputs: the run's subagent invocations (the orchestrator's
  // perspectives_run, one entry per spawn — the free-loop analog of the retired
  // per-phase packet list), terminal artifact summary, evaluator inputs.
  const artifact = result.artifact || null;
  const subagentInvocations = Array.isArray(result.orchestratorOutput?.evidence?.perspectives_run)
    ? result.orchestratorOutput.evidence.perspectives_run
    : [];
  const artifactPath = artifact
    ? runArtifactPath({ runId: resolvedEvalRunId, repoRoot, home, runStoreDir: evalArtifactDir })
    : null;

  // The supplied memory snapshot IS the capture (capture_source records that
  // honestly); rebuilt in-memory so chaining never re-reads run stores.
  const snapshot = buildProjectSnapshot({
    runId: resolvedEvalRunId,
    project: snapshotClient.shape.projectContext,
    semanticStatus: input.project.status,
    captureSource: "eval_mode_memory_snapshot",
  });

  let terminal = null;
  if (artifact && (artifact.kind === "commit" || artifact.kind === "pause")) {
    const built = buildJudgeInputs({
      artifact,
      snapshot,
      allowedFailureModes: judgeAllowedFailureModes(),
    });
    if (built.ok) {
      terminal = {
        status: built.inputs.terminal_status,
        reason: built.inputs.terminal_reason,
        final_issues: built.inputs.final_issues,
        discovery_issues: built.inputs.discovery_issues,
        dependency_relations: built.inputs.dependency_relations,
        project_update_markdown: built.inputs.project_update_markdown,
        open_questions_markdown: built.inputs.open_questions_markdown,
      };
    }
  }

  // Honest evaluator-input mapping (D10): eval mode supplies
  // accepted_packet_sufficiency from the terminal artifact's v3 audit fields;
  // quality structured issue fields and the post-mutation
  // pause-state project view do NOT exist in a non-mutating eval run, so
  // those checks keep their named skips instead of being fed invented inputs.
  const acceptedPacketSufficiencyInput = acceptedPacketSufficiencyInputFromArtifact(artifact);
  const checkInputs = acceptedPacketSufficiencyInput
    ? { accepted_packet_sufficiency: acceptedPacketSufficiencyInput }
    : {};

  const receiptLike = traceId ? { trace_id: traceId, trace_status: traceStatus } : null;

  // 6. Optional chaining over the IN-MEMORY outputs (step 5 + step 6 exports;
  // offline-tolerant: report-only when Phoenix is down).
  let checksResult = null;
  if (emitChecks) {
    if (artifact) {
      checksResult = await emitChecksFn({
        repoRoot,
        artifact,
        receipt: receiptLike,
        traceId,
        checkInputs,
        requirePhoenixNative: false,
        ensureReady: readyProbe,
        fetchImpl,
        onProgress,
      });
    } else {
      checksResult = {
        ok: false,
        storage: "report_only",
        reason: "missing_terminal_artifact",
        run_id: resolvedEvalRunId,
        trace_id: traceId,
        checks: [],
        emitted_count: 0,
        skipped_count: 0,
        annotation_ids: [],
      };
    }
  }

  let judgeResult = null;
  if (judge) {
    if (artifact) {
      const judged = await runJudgeFn({
        repoRoot,
        artifact,
        snapshot,
        receipt: receiptLike,
        traceId,
        config: evalConfig,
        candidatePromptVersionId: variant.judge_candidate_prompt_version_id || null,
        recordReceipt: false,
        ensureReady: readyProbe,
        fetchImpl,
        onProgress,
      });
      judgeResult = { variant_id: variant.id, ...judged };
    } else {
      judgeResult = {
        ok: false,
        judge_state: "not_run",
        reason: "missing_terminal_artifact",
        variant_id: variant.id,
      };
    }
  }

  // 7. Local eval-run record for step-8 receipts (atomic write conventions;
  // gitignored .teami/ custody).
  const record = {
    schema_version: EVAL_RUN_RECORD_SCHEMA_VERSION,
    eval_run_id: resolvedEvalRunId,
    created_at: now().toISOString(),
    source: input.source,
    inputs_hash: inputsHash,
    snapshot_hash: snapshot.snapshot_hash,
    variant: {
      id: variant.id,
      source: variant.source,
      role_overrides: variant.role_overrides,
      judge_candidate_prompt_version_id: variant.judge_candidate_prompt_version_id ?? null,
      prompt_overrides: variant.prompt_overrides ?? {},
      resolved_prompt_overrides: promptOverridesResolution.metadata,
    },
    eval_run_envelope: runEnvelope,
    ...(input.source_run_envelope ? { source_run_envelope: input.source_run_envelope } : {}),
    status: result.status,
    non_mutating: true,
    mutation_skipped: result.mutationSkipped === true,
    ...(result.failureReasons ? { failure_reasons: result.failureReasons } : {}),
    ...(result.eligibility ? { blocking_conditions: result.eligibility.blockingConditions } : {}),
    artifact_kind: artifact?.kind ?? null,
    artifact_path: artifactPath,
    subagent_invocation_count: subagentInvocations.length,
    terminal,
    trace: { trace_id: traceId, trace_status: traceStatus, phoenix_app_url: phoenixAppUrl },
    checks: checksResult,
    judge: judgeResult,
  };
  const recordPath = writeEvalRunRecord(
    { evalRunId: resolvedEvalRunId, repoRoot, home, evalRunStoreDir: evalStoreDir },
    record,
  );

  return {
    ok: result.status === "evaluated",
    status: result.status,
    reason:
      result.reason
      || (result.failureReasons ? result.failureReasons.join(",") : null)
      || (result.eligibility ? result.eligibility.blockingConditions.join(",") : null),
    eval_run_id: resolvedEvalRunId,
    variant_id: variant.id,
    prompt_overrides: promptOverridesResolution.metadata,
    inputs_hash: inputsHash,
    non_mutating: true,
    mutation_skipped: result.mutationSkipped === true,
    subagent_invocations: subagentInvocations,
    artifact,
    artifact_path: artifactPath,
    terminal,
    trace: record.trace,
    evaluator_inputs: {
      check_inputs: checkInputs,
      judge_inputs: artifact
        ? {
            artifact,
            snapshot,
            trace_id: traceId,
            candidate_prompt_version_id: variant.judge_candidate_prompt_version_id ?? null,
          }
        : null,
      prompt_overrides: promptOverridesResolution.metadata,
    },
    checks: checksResult,
    judge: judgeResult,
    record_path: recordPath,
    source: input.source,
  };
}

export async function runDecompositionFixtureRegradeTask({
  repoRoot = process.cwd(),
  config,
  fixture = null,
  examplePath = null,
  runJudgeFn = runStoredDecompositionFixtureJudge,
  ensureReady = null,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  ...judgeOptions
} = {}) {
  let resolvedFixture = fixture;
  let resolvedPath = null;
  if (!resolvedFixture && examplePath) {
    resolvedPath = path.resolve(repoRoot, examplePath);
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, status: "not_run", reason: "missing_example_file", path: resolvedPath };
    }
    try {
      resolvedFixture = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (error) {
      return {
        ok: false,
        status: "not_run",
        reason: "invalid_example_json",
        path: resolvedPath,
        detail: error.message,
      };
    }
  }
  if (!resolvedFixture) {
    return { ok: false, status: "not_run", reason: "missing_stored_fixture" };
  }
  const errors = schemaErrors(exampleSchema, resolvedFixture, exampleSchema);
  if (errors.length > 0) {
    return {
      ok: false,
      status: "not_run",
      reason: "example_schema_mismatch",
      path: resolvedPath,
      schema_errors: errors,
      non_mutating: true,
      reran_workflow: false,
    };
  }
  const judged = await runJudgeFn({
    ...judgeOptions,
    repoRoot,
    fixture: resolvedFixture,
    config,
    ...(ensureReady ? { ensureReady } : {}),
    fetchImpl,
    onProgress,
  });
  return {
    ok: judged.ok,
    status: judged.judge_state === "judged" ? "regraded" : "not_run",
    reason: judged.reason ?? null,
    non_mutating: true,
    reran_workflow: false,
    source: {
      mode: "stored_fixture",
      ...(resolvedPath ? { example_path: resolvedPath } : {}),
      source_run_id: resolvedFixture.metadata?.source_run_id ?? null,
      source_trace_id: resolvedFixture.metadata?.source_trace_id ?? null,
    },
    evaluator_inputs: {
      judge_inputs: judged.judge_inputs ?? null,
    },
    judge: judged,
  };
}

// ---------------------------------------------------------------------------
// CLI report rendering (composes the step-5/step-6 report formatters when
// their results are present).
// ---------------------------------------------------------------------------

function describeSource(source) {
  if (!source) return "unknown";
  if (source.mode === "run") return `captured run snapshot ${source.run_id}`;
  if (source.mode === "example") return `local example ${source.example_path}`;
  if (source.mode === "dataset") return `Phoenix dataset ${source.dataset_name} example ${source.example_id}`;
  return JSON.stringify(source);
}

export function formatEvalRunReport(result) {
  const lines = [];
  if (result.status === "not_run") {
    lines.push(`FAIL eval decomposition: ${result.reason || "not_run"}`);
    if (result.detail) lines.push(`  ${result.detail}`);
    if (result.schema_errors) {
      for (const error of result.schema_errors) lines.push(`  schema: ${error}`);
    }
    if (result.failures) lines.push(`  failures: ${result.failures.join(", ")}`);
    if (result.available) lines.push(`  available variants: ${result.available.join(", ")}`);
    if (result.repairHint) lines.push(`  repair: ${result.repairHint}`);
    return lines;
  }
  lines.push(`eval decomposition run ${result.eval_run_id} (variant ${result.variant_id}):`);
  lines.push(`  source: ${describeSource(result.source)}`);
  lines.push(
    `  status: ${result.status}${result.reason ? ` (${result.reason})` : ""} — non-mutating by construction; no Linear writes, no gateway wake claims`,
  );
  for (const [targetKey, override] of Object.entries(result.prompt_overrides || {})) {
    lines.push(`  prompt override: ${targetKey} -> ${override.candidate_prompt_version_id} sha256:${override.candidate_prompt_sha256}`);
  }
  lines.push(`  inputs_hash: ${result.inputs_hash}`);
  lines.push(
    `  subagent invocations: ${result.subagent_invocations.length}${
      result.subagent_invocations.length > 0
        ? ` (${result.subagent_invocations.map((entry) => entry.role).join(" -> ")})`
        : ""
    }`,
  );
  if (result.terminal) {
    lines.push(
      `  terminal: ${result.terminal.status} (${result.terminal.reason}) final_issues=${result.terminal.final_issues.length} dependency_relations=${result.terminal.dependency_relations.length}`,
    );
    lines.push(
      `  authored: project_update=${result.terminal.project_update_markdown ? "present" : "absent"} open_questions=${result.terminal.open_questions_markdown ? "present" : "absent"}`,
    );
  } else if (result.artifact) {
    lines.push(`  artifact: ${result.artifact.kind} (non-terminal)`);
  }
  lines.push(
    `  trace: ${result.trace.trace_id || "none"} (${result.trace.trace_status}${result.trace.phoenix_app_url ? ` @ ${result.trace.phoenix_app_url}` : ""})`,
  );
  lines.push(
    `  evaluator inputs: check_inputs[${Object.keys(result.evaluator_inputs.check_inputs).join(",") || "none"}], judge_inputs ${result.evaluator_inputs.judge_inputs ? "ready" : "unavailable"}`,
  );
  if (result.artifact_path) lines.push(`  artifact path: ${result.artifact_path}`);
  lines.push(`  eval-run record: ${result.record_path}`);
  if (result.checks) {
    lines.push("  --emit-checks:");
    for (const line of formatDeterministicCheckReport(result.checks)) lines.push(`    ${line}`);
  }
  if (result.judge) {
    lines.push(`  --judge (variant ${result.judge.variant_id || result.variant_id}):`);
    if (result.judge.reason === "missing_terminal_artifact") {
      lines.push("    skipped: no terminal artifact to judge");
    } else {
      for (const line of formatJudgeReport(result.judge)) lines.push(`    ${line}`);
    }
  }
  return lines;
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
