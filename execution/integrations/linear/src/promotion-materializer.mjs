import { createHash } from "node:crypto";
import path from "node:path";

import { validateAcceptedRuntimeRoleDefaults } from "./config.mjs";
import { findTokenShapedContent } from "./eval-content-gate.mjs";
import {
  parseAcceptedPromptSnapshotSections,
} from "../../../engine/accepted-prompt-snapshot.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import "./trigger-registry.mjs";
import { adopterSelfImprovementPersonaBinding } from "./promotion/agent-behavior-scope.mjs";

const RUNTIME_ROLE_FIELDS = Object.freeze(["runtime", "model"]);
const RUNTIME_ROLE_DEFAULTS_DISCLOSURE =
  "Adopters without explicit role overrides change behavior when this merges.";

function workflowTypeFromTargetKey(targetKey) {
  const segments = String(targetKey ?? "").split("/");
  return segments.length >= 3 && segments[1] ? segments[1] : "decomposition";
}

function workflowDefinitionForTarget(target = {}) {
  const workflowType = workflowTypeFromTargetKey(target?.target_key);
  try {
    return getWorkflowDefinition(workflowType);
  } catch {
    return {
      workflow_type: workflowType,
      roles: [],
      eval_namespace: `execution/evals/${workflowType}`,
      engine_owned_evaluator_roles: [],
    };
  }
}

function evalPathsForTarget(target = {}) {
  return evalNamespacePaths(workflowDefinitionForTarget(target));
}

function manifestPathForTarget(target = {}) {
  return target.manifest_path || evalPathsForTarget(target).manifest;
}

function proposalsPathForTarget(target = {}) {
  return evalPathsForTarget(target).proposals;
}

const MATERIALIZER_REGISTRY = new Map([
  [
    "phoenix_prompt_version_to_accepted_prompt_snapshot",
    materializePhoenixPromptVersionToAcceptedPromptSnapshot,
  ],
  [
    "eval_variant_to_runtime_role_defaults",
    materializeEvalVariantToRuntimeRoleDefaults,
  ],
]);

export function resolveMaterializerTarget({ manifest, candidateTargetKey } = {}) {
  const target = findManifestTargetByKey({ manifest, candidateTargetKey });
  if (!target?.materializer) {
    return { ok: false, reason: "no_materializer_for_target" };
  }
  return { ok: true, target: enrichTarget(target) };
}

export async function materializePromotionCandidate({
  candidateTargetKey,
  candidateKind,
  candidateVersionId,
  acceptedBaselineId,
  resolvedCandidate,
  resolvedBaseline,
  currentAcceptedSnapshotContent,
  manifestContent,
  gateReport,
  policy,
  manifest,
  fetchImpl,
  resolvedReceipt,
} = {}) {
  const resolvedTarget = resolveMaterializerTarget({ manifest, candidateTargetKey });
  if (!resolvedTarget.ok) {
    const target = enrichTarget(
      findManifestTargetByKey({ manifest, candidateTargetKey }) || {
        human_name: "Unknown target",
        target_key: candidateTargetKey,
      },
    );
    const taxonomy = extractTaxonomy({ policy, manifest });
    const failureModeIds = extractFailureModeIds(gateReport);
    const validatedFailureModeIds = validateFailureModeIds({ failureModeIds, taxonomy });
    return {
      kind: "improvement_opportunity",
      summary: buildOpportunitySummary({ target, failureModeIds: validatedFailureModeIds }),
      reason: "no_materializer_for_target",
      nextAction: "draft_proposed_change",
      evidenceRefs: extractEvidenceRefs(gateReport),
      suggestedDraftPrompt: buildSuggestedDraftPrompt({
        target,
        failureModeIds,
        taxonomy,
      }),
    };
  }

  const { target } = resolvedTarget;
  const materializer = MATERIALIZER_REGISTRY.get(target.materializer);
  if (!materializer) {
    return {
      kind: "blocked",
      reason: "unknown_materializer",
      detail: `No promotion materializer is registered for ${target.materializer}.`,
      blockClass: "terminal",
    };
  }

  const result = await materializer({
    target,
    candidateTargetKey,
    candidateKind,
    candidateVersionId,
    acceptedBaselineId,
    resolvedCandidate,
    resolvedBaseline,
    currentAcceptedSnapshotContent,
    manifestContent,
    gateReport,
    policy,
    manifest,
    fetchImpl,
    resolvedReceipt,
  });

  if (result?.kind !== "behavior_diff") return result;

  const validation = validateBehaviorDiff({ files: result.files, target });
  if (!validation.ok) {
    return {
      kind: "blocked",
      reason: validation.reason,
      detail: `Materializer ${target.materializer} produced an invalid behavior diff.`,
      blockClass: validation.reason === "cannot_promote_secret_content" ? "evidence_repair" : "terminal",
    };
  }
  return result;
}

async function materializeEvalVariantToRuntimeRoleDefaults({
  target,
  resolvedReceipt,
  currentAcceptedSnapshotContent,
  manifestContent,
  resolvedBaseline,
} = {}) {
  if (typeof target?.artifact_path !== "string" || target.artifact_path.trim() === "") {
    return {
      kind: "blocked",
      reason: "runtime_role_defaults_artifact_path_unavailable",
      blockClass: "terminal",
    };
  }

  const overrideResolution = extractRuntimeRoleOverrides(resolvedReceipt, target);
  if (!overrideResolution.ok) {
    return {
      kind: "blocked",
      reason: overrideResolution.reason,
      blockClass: overrideResolution.blockClass || "evidence_repair",
      ...(overrideResolution.scope ? { scope: overrideResolution.scope } : {}),
    };
  }
  if (typeof currentAcceptedSnapshotContent !== "string") {
    return {
      kind: "blocked",
      reason: "accepted_runtime_role_defaults_unavailable",
      blockClass: "evidence_repair",
    };
  }

  const current = parseAcceptedRuntimeRoleDefaults(currentAcceptedSnapshotContent, target);
  if (!current.ok) {
    return {
      kind: "blocked",
      reason: current.reason,
      detail: current.detail,
      blockClass: "terminal",
    };
  }

  const next = structuredClone(current.defaults);
  const changes = [];
  for (const override of overrideResolution.overrides) {
    const roleDefaults = next.roles?.[override.role];
    if (!isPlainObject(roleDefaults)) {
      return {
        kind: "blocked",
        reason: `accepted_runtime_role_defaults_missing_role:${override.role}`,
        blockClass: "terminal",
      };
    }
    if (!Object.hasOwn(roleDefaults, override.field)) {
      return {
        kind: "blocked",
        reason: `accepted_runtime_role_defaults_missing_field:${override.role}.${override.field}`,
        blockClass: "terminal",
      };
    }
    const oldValue = roleDefaults[override.field];
    if (oldValue === override.value) continue;
    roleDefaults[override.field] = override.value;
    changes.push({
      role: override.role,
      field: override.field,
      old: oldValue,
      new: override.value,
    });
  }

  if (changes.length === 0) {
    return {
      kind: "blocked",
      reason: "materializer_produced_no_diff",
      blockClass: "terminal",
    };
  }

  const newDefaultsBytes = serializeAcceptedRuntimeRoleDefaults(next, target);
  const newDefaultsSha256 = sha256Hex(newDefaultsBytes);

  // Atomically update the manifest's runtime-defaults rule pin so the accepted
  // artifact and its phoenix-assets.json `snapshot_sha256` never drift. Mirrors
  // the accepted-prompt materializer's two-file write (snapshot + manifest pin).
  const manifestPath = manifestPathForTarget(target);
  const oldManifestBytes = resolveCurrentManifestContent({
    manifestPath,
    resolvedBaseline,
    manifestContent,
  });
  if (typeof oldManifestBytes !== "string") {
    return {
      kind: "blocked",
      reason: "manifest_content_unavailable",
      blockClass: "terminal",
    };
  }
  const manifestUpdate = updateManifestRuleEntry({
    manifestContent: oldManifestBytes,
    target,
    snapshotSha256: newDefaultsSha256,
  });
  if (!manifestUpdate.ok) {
    return {
      kind: "blocked",
      reason: manifestUpdate.reason,
      blockClass: "terminal",
    };
  }
  const newManifestBytes = manifestUpdate.content;

  return {
    kind: "behavior_diff",
    files: {
      [target.artifact_path]: newDefaultsBytes,
      [manifestPath]: newManifestBytes,
    },
    humanSummary: {
      kind: "runtime_role_defaults",
      changes,
      disclosure: RUNTIME_ROLE_DEFAULTS_DISCLOSURE,
    },
    changedArtifacts: [
      {
        path: target.artifact_path,
        kind: "runtime_role_defaults",
        old_sha256: sha256Hex(currentAcceptedSnapshotContent),
        new_sha256: newDefaultsSha256,
      },
      {
        path: manifestPath,
        kind: "manifest_pin",
        old_sha256: sha256Hex(oldManifestBytes),
        new_sha256: sha256Hex(newManifestBytes),
      },
    ],
  };
}

function extractRuntimeRoleOverrides(resolvedReceipt, target = null) {
  const overrides = resolvedReceipt?.launch?.candidate?.role_overrides;
  if (!isPlainObject(overrides) || Object.keys(overrides).length === 0) {
    return { ok: false, reason: "candidate_role_overrides_unavailable" };
  }
  const runtimeRoleNames = runtimeRoleNamesForWorkflow(target);

  for (const role of Object.keys(overrides)) {
    if (!runtimeRoleNames.includes(role)) {
      return { ok: false, reason: `candidate_role_overrides_invalid:${role}` };
    }
    // Runtime-defaults is an aggregate target; consult the single adopter
    // self-improvement authority per role. The maintainer-owned judge role is
    // excluded there, so a judge runtime/model override is a terminal,
    // factory-behavior block (NOT an evidence_repair retry).
    if (target && !adopterSelfImprovementPersonaBinding({ ...target, role })) {
      return {
        ok: false,
        reason: "runtime_default_judge_excluded",
        blockClass: "terminal",
        scope: "factory_behavior",
      };
    }
    if (!isPlainObject(overrides[role])) {
      return { ok: false, reason: `candidate_role_overrides_invalid:${role}` };
    }
    for (const field of Object.keys(overrides[role])) {
      if (!RUNTIME_ROLE_FIELDS.includes(field)) {
        return { ok: false, reason: `candidate_role_overrides_invalid:${role}.${field}` };
      }
    }
  }

  const normalized = [];
  for (const role of runtimeRoleNames) {
    const roleOverrides = overrides[role];
    if (!roleOverrides) continue;
    for (const field of RUNTIME_ROLE_FIELDS) {
      if (!Object.hasOwn(roleOverrides, field)) continue;
      const value = roleOverrides[field];
      if (typeof value !== "string" || value.trim() === "") {
        return { ok: false, reason: `candidate_role_overrides_invalid:${role}.${field}` };
      }
      normalized.push({ role, field, value });
    }
  }

  if (normalized.length === 0) {
    return { ok: false, reason: "candidate_role_overrides_unavailable" };
  }
  return { ok: true, overrides: normalized };
}

function parseAcceptedRuntimeRoleDefaults(content, target = {}) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      reason: "accepted_runtime_role_defaults_json_unparseable",
      detail: error.message,
    };
  }
  try {
    const workflowType = workflowTypeFromTargetKey(target?.target_key);
    validateAcceptedRuntimeRoleDefaults(parsed, target?.artifact_path, { workflowType });
  } catch (error) {
    return {
      ok: false,
      reason: "accepted_runtime_role_defaults_invalid",
      detail: error.message,
    };
  }
  return { ok: true, defaults: parsed };
}

function serializeAcceptedRuntimeRoleDefaults(defaults, target = {}) {
  const normalized = {
    schema_version: defaults.schema_version,
    _note: defaults._note,
    roles: {},
  };
  for (const role of runtimeRoleNamesForWorkflow(target)) {
    normalized.roles[role] = {};
    for (const field of RUNTIME_ROLE_FIELDS) {
      normalized.roles[role][field] = defaults.roles[role][field];
    }
  }
  const workflowType = workflowTypeFromTargetKey(target?.target_key);
  validateAcceptedRuntimeRoleDefaults(normalized, target?.artifact_path, { workflowType });
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function runtimeRoleNamesForWorkflow(target = {}) {
  const definition = workflowDefinitionForTarget(target);
  const workflowRoles = Array.isArray(definition.roles) ? definition.roles : [];
  const evaluatorRoles = Array.isArray(definition.engine_owned_evaluator_roles)
    ? definition.engine_owned_evaluator_roles
    : [];
  const hasEvaluatorRuntimeRole = evaluatorRoles.some((role) => workflowRoles.includes(role));
  return [
    ...new Set([
      ...workflowRoles,
      ...(!hasEvaluatorRuntimeRole && evaluatorRoles[0] ? [evaluatorRoles[0]] : []),
    ]),
  ];
}

async function materializePhoenixPromptVersionToAcceptedPromptSnapshot({
  target,
  candidateVersionId,
  resolvedCandidate,
  resolvedBaseline,
  currentAcceptedSnapshotContent,
  manifestContent,
} = {}) {
  const candidate = extractCandidatePromptVersionContent(resolvedCandidate);
  if (!candidate.ok) return candidateContentUnavailable();
  if (isRuntimePhasePromptTarget(target)) {
    const composability = validateRuntimePhasePromptComposability(candidate.content);
    if (!composability.ok) {
      return {
        kind: "blocked",
        reason: "candidate_prompt_not_composable",
        detail: composability.detail,
        blockClass: "terminal",
      };
    }
  }

  const oldSnapshotBytes = resolveCurrentSnapshotContent({
    target,
    resolvedBaseline,
    currentAcceptedSnapshotContent,
  });
  if (typeof oldSnapshotBytes !== "string") {
    return {
      kind: "blocked",
      reason: "accepted_snapshot_content_unavailable",
      blockClass: "evidence_repair",
    };
  }

  const newSnapshotBytes = normalizeCandidateSnapshotBytes({
    candidateContent: candidate.content,
    currentSnapshotContent: oldSnapshotBytes,
  });
  if (newSnapshotBytes === oldSnapshotBytes) {
    return {
      kind: "blocked",
      reason: "materializer_produced_no_diff",
      blockClass: "terminal",
    };
  }

  const candidatePromptVersionId = extractPromptVersionId(candidate.version, candidateVersionId);
  if (!candidatePromptVersionId) return candidateContentUnavailable();

  const snapshotSha256 = sha256Hex(newSnapshotBytes);
  const oldSnapshotSha256 = sha256Hex(oldSnapshotBytes);
  const manifestPath = manifestPathForTarget(target);
  const oldManifestBytes = resolveCurrentManifestContent({
    manifestPath,
    resolvedBaseline,
    manifestContent,
  });
  if (typeof oldManifestBytes !== "string") {
    return {
      kind: "blocked",
      reason: "manifest_content_unavailable",
      blockClass: "terminal",
    };
  }

  const manifestUpdate = updateManifestPromptEntry({
    manifestContent: oldManifestBytes,
    target,
    acceptedPromptVersionId: candidatePromptVersionId,
    promptVersion: candidatePromptVersionId,
    snapshotSha256,
  });
  if (!manifestUpdate.ok) {
    return {
      kind: "blocked",
      reason: manifestUpdate.reason,
      blockClass: "terminal",
    };
  }

  const newManifestBytes = manifestUpdate.content;
  return {
    kind: "behavior_diff",
    files: {
      [target.snapshot_path]: newSnapshotBytes,
      [manifestPath]: newManifestBytes,
    },
    humanSummary: buildPromptMaterializerSummary({
      oldSnapshotBytes,
      newSnapshotBytes,
      oldPinnedVersionId: target?.accepted_prompt_version_id || target?.prompt_version || null,
      newPinnedVersionId: candidatePromptVersionId,
      oldSnapshotSha256,
      newSnapshotSha256: snapshotSha256,
    }),
    changedArtifacts: [
      {
        path: target.snapshot_path,
        kind: "accepted_prompt",
        old_sha256: oldSnapshotSha256,
        new_sha256: snapshotSha256,
      },
      {
        path: manifestPath,
        kind: "manifest_pin",
        old_sha256: sha256Hex(oldManifestBytes),
        new_sha256: sha256Hex(newManifestBytes),
      },
    ],
  };
}

function candidateContentUnavailable() {
  return {
    kind: "blocked",
    reason: "candidate_prompt_content_unavailable",
    blockClass: "evidence_repair",
  };
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

function extractPromptVersionId(version, fallback) {
  for (const value of [version?.id, version?.prompt_version_id, version?.version_id, fallback]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function normalizeCandidateSnapshotBytes({ candidateContent, currentSnapshotContent }) {
  const normalized = candidateContent.replace(/\r\n?/g, "\n");
  if (currentSnapshotContent.endsWith("\n")) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }
  return normalized.replace(/\n+$/g, "");
}

function validateRuntimePhasePromptComposability(content) {
  const header = acceptedPromptSnapshotHeaderCheck(content);
  if (!header.ok) return header;
  let parsed;
  try {
    parsed = parseAcceptedPromptSnapshotSections(content);
  } catch (error) {
    return {
      ok: false,
      detail: `accepted prompt snapshot parse failed: ${error.message}`,
    };
  }
  if (parsed?.ok === false) {
    return {
      ok: false,
      detail: `accepted prompt snapshot parse failed: ${parsed.reason || parsed.detail || "unknown_error"}`,
    };
  }
  const sectionNames = collectAcceptedPromptSectionNames(parsed);
  const missing = requiredRuntimePhasePromptSections().filter(
    (section) => !sectionNames.has(normalizeSectionName(section)),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `accepted prompt snapshot is missing required section(s): ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

function isRuntimePhasePromptTarget(target = {}) {
  return target?.artifact_kind === "accepted_prompt"
    // Intentional strict-generation pm/sr_eng subset; not a runtime-role facet site.
    && ["pm", "sr_eng"].includes(target?.role);
}

function acceptedPromptSnapshotHeaderCheck(content) {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (!lines[0]?.startsWith("# ")) {
    return { ok: false, detail: "accepted prompt snapshot must start with a leading markdown heading." };
  }
  const fenceStart = lines.findIndex((line, index) => index > 0 && line.trim() === "```yaml");
  if (fenceStart === -1) {
    return { ok: false, detail: "accepted prompt snapshot yaml header fence is missing." };
  }
  const fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trim() === "```");
  if (fenceEnd === -1) {
    return { ok: false, detail: "accepted prompt snapshot yaml header fence is unterminated." };
  }
  const header = lines.slice(fenceStart + 1, fenceEnd).join("\n");
  if (header.trim() === "") {
    return {
      ok: false,
      detail: "accepted prompt snapshot yaml header is empty.",
    };
  }
  return { ok: true };
}

function requiredRuntimePhasePromptSections() {
  // The phase-runtime-prompt section contract is retired with the phase router:
  // accepted prompts are free-form persona bodies with no required-section
  // structure. No sections are required. (Broader promotion-surface cleanup is
  // deferred to I-5b.)
  return [];
}

function collectAcceptedPromptSectionNames(value, names = new Set()) {
  if (!value) return names;
  if (value instanceof Map) {
    for (const [key, nested] of value.entries()) {
      addAcceptedPromptSectionName(names, key);
      collectAcceptedPromptSectionNames(nested, names);
    }
    return names;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAcceptedPromptSectionNames(entry, names);
    return names;
  }
  if (typeof value === "string") {
    addAcceptedPromptSectionName(names, value);
    return names;
  }
  if (typeof value !== "object") return names;

  for (const key of ["heading", "title", "name", "id", "section", "section_heading"]) {
    addAcceptedPromptSectionName(names, value[key]);
  }
  for (const key of ["sections", "contentSections", "content_sections", "sectionMap"]) {
    collectAcceptedPromptSectionNames(value[key], names);
  }
  if (!Array.isArray(value) && !(value instanceof Map)) {
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "string" || nested instanceof Map || Array.isArray(nested) || nested?.heading || nested?.title) {
        addAcceptedPromptSectionName(names, key);
      }
      collectAcceptedPromptSectionNames(nested, names);
    }
  }
  return names;
}

function addAcceptedPromptSectionName(names, value) {
  const normalized = normalizeSectionName(value);
  if (normalized) names.add(normalized);
}

function normalizeSectionName(value) {
  return typeof value === "string"
    ? value.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ")
    : "";
}

function resolveCurrentSnapshotContent({
  target,
  resolvedBaseline,
  currentAcceptedSnapshotContent,
} = {}) {
  return singleStringCandidate([
    currentAcceptedSnapshotContent,
    resolvedBaseline,
    resolvedBaseline?.currentAcceptedSnapshotContent,
    resolvedBaseline?.acceptedSnapshotContent,
    resolvedBaseline?.snapshotContent,
    resolvedBaseline?.snapshotText,
    resolvedBaseline?.snapshot_bytes,
    resolvedBaseline?.content,
    valueAtPathMap(resolvedBaseline?.files, target?.snapshot_path),
    valueAtPathMap(resolvedBaseline?.snapshots, target?.snapshot_path),
  ]);
}

function resolveCurrentManifestContent({ manifestPath, resolvedBaseline, manifestContent } = {}) {
  return singleStringCandidate([
    manifestContent,
    resolvedBaseline?.manifestContent,
    resolvedBaseline?.currentManifestContent,
    resolvedBaseline?.manifestText,
    resolvedBaseline?.manifest,
    valueAtPathMap(resolvedBaseline?.files, manifestPath),
    valueAtPathMap(resolvedBaseline?.manifests, manifestPath),
  ]);
}

function valueAtPathMap(mapLike, filePath) {
  if (!mapLike || typeof mapLike !== "object" || !filePath) return undefined;
  if (mapLike instanceof Map) return mapLike.get(filePath);
  return mapLike[filePath];
}

function singleStringCandidate(candidates) {
  const values = candidates.filter((value) => typeof value === "string");
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function updateManifestPromptEntry({
  manifestContent,
  target,
  acceptedPromptVersionId,
  promptVersion,
  snapshotSha256,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    return { ok: false, reason: "manifest_json_unparseable" };
  }
  const promptEntry = (parsed.prompts || []).find((entry) => manifestEntryMatchesTarget(entry, target));
  if (!promptEntry) return { ok: false, reason: "manifest_target_unavailable" };

  const arraySpan = findJsonArrayPropertySpan(manifestContent, "prompts");
  if (!arraySpan) return { ok: false, reason: "manifest_prompt_array_unavailable" };
  const entrySpans = findTopLevelJsonObjectSpans(manifestContent, arraySpan.start + 1, arraySpan.end - 1);
  for (const span of entrySpans) {
    const entryText = manifestContent.slice(span.start, span.end);
    let entry;
    try {
      entry = JSON.parse(entryText);
    } catch {
      continue;
    }
    if (!manifestEntryMatchesTarget(entry, target)) continue;
    let updatedEntryText = entryText;
    for (const [key, value] of [
      ["accepted_prompt_version_id", acceptedPromptVersionId],
      ["snapshot_sha256", snapshotSha256],
      ["prompt_version", promptVersion],
    ]) {
      const replaced = replaceJsonPropertyValue(updatedEntryText, key, value);
      if (!replaced.ok) return { ok: false, reason: `manifest_field_unavailable:${key}` };
      updatedEntryText = replaced.content;
    }
    const content = `${manifestContent.slice(0, span.start)}${updatedEntryText}${manifestContent.slice(span.end)}`;
    try {
      const reparsed = JSON.parse(content);
      const updatedPromptEntry = (reparsed.prompts || []).find(
        (entryCandidate) => manifestEntryMatchesTarget(entryCandidate, target),
      );
      if (
        updatedPromptEntry?.accepted_prompt_version_id !== acceptedPromptVersionId
        || updatedPromptEntry?.snapshot_sha256 !== snapshotSha256
        || updatedPromptEntry?.prompt_version !== promptVersion
      ) {
        return { ok: false, reason: "manifest_update_verification_failed" };
      }
    } catch {
      return { ok: false, reason: "manifest_update_verification_failed" };
    }
    return { ok: true, content };
  }
  return { ok: false, reason: "manifest_target_unavailable" };
}

// Byte-preserving manifest pin update for a `rules[]` entry (the runtime-defaults
// rule). Mirrors updateManifestPromptEntry but over the `rules` array and only the
// `snapshot_sha256` field — the runtime-defaults rule carries no version-id pins.
function updateManifestRuleEntry({ manifestContent, target, snapshotSha256 } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    return { ok: false, reason: "manifest_json_unparseable" };
  }
  const matchingRules = (parsed.rules || []).filter((entry) => manifestEntryMatchesTarget(entry, target));
  if (matchingRules.length === 0) return { ok: false, reason: "manifest_target_unavailable" };
  // Fail closed on an ambiguous manifest (duplicate target_key) rather than silently
  // updating only the first and leaving the duplicate's pin stale (capstone P-PIN-001).
  if (matchingRules.length > 1) return { ok: false, reason: "manifest_rule_target_not_unique" };

  const arraySpan = findJsonArrayPropertySpan(manifestContent, "rules");
  if (!arraySpan) return { ok: false, reason: "manifest_rule_array_unavailable" };
  const entrySpans = findTopLevelJsonObjectSpans(manifestContent, arraySpan.start + 1, arraySpan.end - 1);
  for (const span of entrySpans) {
    const entryText = manifestContent.slice(span.start, span.end);
    let entry;
    try {
      entry = JSON.parse(entryText);
    } catch {
      continue;
    }
    if (!manifestEntryMatchesTarget(entry, target)) continue;
    const replaced = replaceJsonPropertyValue(entryText, "snapshot_sha256", snapshotSha256);
    if (!replaced.ok) return { ok: false, reason: "manifest_field_unavailable:snapshot_sha256" };
    const content = `${manifestContent.slice(0, span.start)}${replaced.content}${manifestContent.slice(span.end)}`;
    try {
      const reparsed = JSON.parse(content);
      const updatedRuleEntry = (reparsed.rules || []).find(
        (entryCandidate) => manifestEntryMatchesTarget(entryCandidate, target),
      );
      if (updatedRuleEntry?.snapshot_sha256 !== snapshotSha256) {
        return { ok: false, reason: "manifest_update_verification_failed" };
      }
    } catch {
      return { ok: false, reason: "manifest_update_verification_failed" };
    }
    return { ok: true, content };
  }
  return { ok: false, reason: "manifest_target_unavailable" };
}

function manifestEntryMatchesTarget(entry, target) {
  // Strict target_key identity only. Role/snapshot-path fallbacks were
  // removed after Step 13 proved them wrong: two PM prompts share
  // role "pm", and a role fallback updated the wrong manifest entry.
  return Boolean(
    entry
      && typeof entry === "object"
      && typeof target?.target_key === "string"
      && target.target_key !== ""
      && entry.target_key === target.target_key,
  );
}

function findJsonArrayPropertySpan(text, propertyName) {
  const propertyPattern = new RegExp(`"${escapeRegExp(propertyName)}"\\s*:\\s*\\[`, "g");
  let match;
  while ((match = propertyPattern.exec(text)) !== null) {
    if (isInsideJsonString(text, match.index)) continue;
    const openIndex = text.indexOf("[", match.index);
    const closeIndex = findMatchingJsonDelimiter(text, openIndex, "[", "]");
    if (closeIndex !== -1) return { start: openIndex, end: closeIndex + 1 };
  }
  return null;
}

function findMatchingJsonDelimiter(text, openIndex, openChar, closeChar) {
  if (openIndex < 0 || text[openIndex] !== openChar) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findTopLevelJsonObjectSpans(text, start, end) {
  const spans = [];
  let index = start;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  let depth = 0;
  while (index <= end) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        spans.push({ start: objectStart, end: index + 1 });
        objectStart = -1;
      }
    }
    index += 1;
  }
  return spans;
}

function replaceJsonPropertyValue(text, key, value) {
  const valuePattern = "\"(?:\\\\.|[^\"\\\\])*\"|null|true|false|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";
  const pattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)(${valuePattern})`);
  const match = text.match(pattern);
  if (!match) return { ok: false };
  return {
    ok: true,
    content: text.replace(pattern, (_full, prefix) => `${prefix}${JSON.stringify(value)}`),
  };
}

function isInsideJsonString(text, position) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < position; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") inString = true;
  }
  return inString;
}

function buildPromptMaterializerSummary({
  oldSnapshotBytes,
  newSnapshotBytes,
  oldPinnedVersionId,
  newPinnedVersionId,
  oldSnapshotSha256,
  newSnapshotSha256,
}) {
  const oldHeadings = markdownHeadings(oldSnapshotBytes);
  const newHeadings = markdownHeadings(newSnapshotBytes);
  return {
    old_pinned_version_id: oldPinnedVersionId,
    new_pinned_version_id: newPinnedVersionId,
    old_snapshot_sha256_12: oldSnapshotSha256.slice(0, 12),
    new_snapshot_sha256_12: newSnapshotSha256.slice(0, 12),
    old_line_count: lineCount(oldSnapshotBytes),
    new_line_count: lineCount(newSnapshotBytes),
    old_byte_size: byteSize(oldSnapshotBytes),
    new_byte_size: byteSize(newSnapshotBytes),
    added_markdown_section_headings: setDifference(newHeadings, oldHeadings),
    removed_markdown_section_headings: setDifference(oldHeadings, newHeadings),
    header_block_present: {
      old: headerBlockPresent(oldSnapshotBytes),
      new: headerBlockPresent(newSnapshotBytes),
    },
  };
}

function markdownHeadings(text) {
  const seen = new Set();
  const headings = [];
  for (const line of normalizeLineEndings(text).split("\n")) {
    if (!line.startsWith("#")) continue;
    const escaped = escapeSummaryHeading(line);
    if (!seen.has(escaped)) {
      seen.add(escaped);
      headings.push(escaped);
    }
  }
  return headings;
}

function escapeSummaryHeading(line) {
  return line
    .replace(/[<>`]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function headerBlockPresent(text) {
  const lines = normalizeLineEndings(text).split("\n");
  if (!lines[0]?.startsWith("#")) return false;
  const fenceStart = lines.findIndex((line, index) => index > 0 && line.trim() === "```yaml");
  if (fenceStart === -1) return false;
  const fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trim() === "```");
  if (fenceEnd === -1) return false;
  const header = lines.slice(fenceStart + 1, fenceEnd).join("\n");
  return [
    "prompt_version:",
    "rubric_version:",
    "failure_taxonomy_version:",
    "phoenix_prompt_role:",
  ].every((field) => header.includes(field));
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split("\n").length;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

function byteSize(text) {
  return Buffer.byteLength(text, "utf8");
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateBehaviorDiff({ files, target } = {}) {
  const entries = fileEntries(files);
  if (entries.length === 0) {
    return { ok: false, reason: "empty_file_set" };
  }

  const mappedArtifactPaths = mappedArtifactPathSet(target);
  let touchesMappedArtifact = false;

  for (const [filePath, content] of entries) {
    const normalizedPath = normalizePathForCompare(filePath);
    if (isBannedProposalPath(normalizedPath, target)) {
      return { ok: false, reason: "proposals_path_banned" };
    }
    if (mappedArtifactPaths.has(normalizedPath)) {
      touchesMappedArtifact = true;
    }
    if (typeof content !== "string") {
      return { ok: false, reason: "materialized_file_content_not_string" };
    }
    if (findTokenShapedContent(content).length > 0) {
      return { ok: false, reason: "cannot_promote_secret_content" };
    }
  }

  if (!touchesMappedArtifact) {
    return { ok: false, reason: "no_mapped_artifact_path" };
  }

  // Runtime-defaults integrity floor: a runtime-role-defaults change MUST carry the
  // atomic manifest pin update. The manifest rule pin must equal sha256(the new
  // accepted-runtime-roles.json bytes) — catches a materializer (or a diff) that
  // changed the artifact without re-pinning, which would otherwise leave the pin stale.
  if (target?.materializer === "eval_variant_to_runtime_role_defaults") {
    const artifactPath = normalizePathForCompare(target.artifact_path);
    const manifestPath = normalizePathForCompare(manifestPathForTarget(target));
    const byPath = new Map(entries.map(([p, c]) => [normalizePathForCompare(p), c]));
    const newArtifactBytes = byPath.get(artifactPath);
    const newManifestBytes = byPath.get(manifestPath);
    if (typeof newArtifactBytes !== "string" || typeof newManifestBytes !== "string") {
      return { ok: false, reason: "runtime_defaults_manifest_pin_missing" };
    }
    let manifestJson;
    try {
      manifestJson = JSON.parse(newManifestBytes);
    } catch {
      return { ok: false, reason: "runtime_defaults_manifest_pin_missing" };
    }
    const matchingRules = Array.isArray(manifestJson.rules)
      ? manifestJson.rules.filter((entry) => entry?.target_key === target.target_key)
      : [];
    // Exactly one rule must carry the target_key — a duplicate is ambiguous and fails
    // closed (it could leave a second stale pin) rather than verifying only the first
    // (capstone P-PIN-001).
    if (matchingRules.length !== 1 || typeof matchingRules[0].snapshot_sha256 !== "string") {
      return { ok: false, reason: "runtime_defaults_manifest_pin_missing" };
    }
    if (matchingRules[0].snapshot_sha256 !== sha256Hex(newArtifactBytes)) {
      return { ok: false, reason: "runtime_defaults_manifest_pin_mismatch" };
    }
  }

  return { ok: true };
}

export function buildSuggestedDraftPrompt({ target, failureModeIds, taxonomy } = {}) {
  const humanName = targetHumanName(target);
  const validatedFailureModeIds = validateFailureModeIds({ failureModeIds, taxonomy });
  const failureModeClause = validatedFailureModeIds.length > 0
    ? ` that addresses ${validatedFailureModeIds.join(", ")}`
    : " that addresses the validated promotion evidence";
  return `Draft a concrete before/after change to ${humanName}${failureModeClause}.`;
}

function findManifestTargetByKey({ manifest, candidateTargetKey } = {}) {
  const sections = manifestTargets(manifest);
  return sections.find((entry) => entry?.target_key === candidateTargetKey) || null;
}

function manifestTargets(manifest) {
  return [
    ...(Array.isArray(manifest?.prompts) ? manifest.prompts : []),
    ...(Array.isArray(manifest?.evaluators) ? manifest.evaluators : []),
    ...(Array.isArray(manifest?.rules) ? manifest.rules : []),
  ];
}

function enrichTarget(target) {
  const enriched = {
    ...target,
    manifest_path: manifestPathForTarget(target),
  };
  return {
    ...enriched,
    mapped_artifact_paths: [...mappedArtifactPathSet(enriched)],
  };
}

function mappedArtifactPathSet(target = {}) {
  return new Set(
    [
      target.snapshot_path,
      target.artifact_path,
      ...(Array.isArray(target.mapped_artifact_paths) ? target.mapped_artifact_paths : []),
      manifestPathForTarget(target),
    ]
      .filter((entry) => typeof entry === "string" && entry.length > 0)
      .map(normalizePathForCompare),
  );
}

// The POSITIVE path allowlist for a target's promotion commit: the target's own
// artifact/snapshot path(s) plus the manifest path. Exported so the commit-time
// guard (commitPromotionDraft) enforces the SAME set the materializer validates
// against in validateBehaviorDiff — one source of truth, so the staged-diff
// allowlist and the materialized-diff validation can never drift. Returns
// repo-relative paths (NOT normalized for compare) so callers can render them.
export function allowedPromotionArtifactPaths(target = {}) {
  return [
    ...new Set(
      [
        target.snapshot_path,
        target.artifact_path,
        ...(Array.isArray(target.mapped_artifact_paths) ? target.mapped_artifact_paths : []),
        manifestPathForTarget(target),
      ].filter((entry) => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function fileEntries(files) {
  if (files instanceof Map) return [...files.entries()];
  if (!files || typeof files !== "object" || Array.isArray(files)) return [];
  return Object.entries(files);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePathForCompare(filePath) {
  const slashed = String(filePath ?? "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashed);
  const withoutLeadingCurrent = normalized.replace(/^(\.\/)+/, "");
  const withoutLeadingSlash = withoutLeadingCurrent.replace(/^\/+/, "");
  return withoutLeadingSlash === "." ? "" : withoutLeadingSlash.toLowerCase();
}

function isBannedProposalPath(normalizedPath, target = {}) {
  const banned = normalizePathForCompare(proposalsPathForTarget(target));
  return normalizedPath === banned
    || normalizedPath.startsWith(`${banned}/`)
    || normalizedPath.endsWith(`/${banned}`)
    || normalizedPath.includes(`/${banned}/`);
}

function extractTaxonomy({ policy, manifest } = {}) {
  return policy?.failure_taxonomy
    || policy?.failureTaxonomy
    || policy?.taxonomy
    || manifest?.failure_taxonomy
    || manifest?.failureTaxonomy
    || manifest?.taxonomy
    || null;
}

function extractFailureModeIds(gateReport) {
  const ids = [];
  collectFailureModeIds(gateReport, ids);
  return ids;
}

function collectFailureModeIds(value, ids) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectFailureModeIds(item, ids);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isFailureModeKey(key) && Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === "string") ids.push(item);
      }
      continue;
    }
    collectFailureModeIds(nested, ids);
  }
}

function isFailureModeKey(key) {
  return key === "failure_modes"
    || key === "failureModeIds"
    || key === "failure_mode_ids"
    || key === "code_failure_modes";
}

function validateFailureModeIds({ failureModeIds, taxonomy } = {}) {
  const order = taxonomyFailureModeOrder(taxonomy);
  if (order.size === 0 || !Array.isArray(failureModeIds)) return [];
  const seen = new Set();
  const valid = [];
  for (const id of failureModeIds) {
    if (typeof id !== "string" || !order.has(id) || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  return valid.sort((a, b) => order.get(a) - order.get(b));
}

function taxonomyFailureModeOrder(taxonomy) {
  const ids = [];
  appendFailureModes(ids, taxonomy?.structural?.failure_modes);
  for (const workflow of Object.values(taxonomy?.workflows || {})) {
    appendFailureModes(ids, workflow?.failure_modes);
  }
  return new Map(ids.map((id, index) => [id, index]));
}

function appendFailureModes(ids, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === "string" && !ids.includes(value)) ids.push(value);
  }
}

function buildOpportunitySummary({ target, failureModeIds } = {}) {
  const humanName = targetHumanName(target);
  if (failureModeIds?.length > 0) {
    return `Evidence suggests ${humanName} could improve on ${failureModeIds.join(", ")}.`;
  }
  return `Evidence suggests ${humanName} could improve, but no taxonomy failure modes were validated.`;
}

function targetHumanName(target) {
  return typeof target?.human_name === "string" && target.human_name.length > 0
    ? target.human_name
    : "Unknown target";
}

function extractEvidenceRefs(gateReport = {}) {
  const source = gateReport?.evidenceRefs || gateReport?.evidence_refs || gateReport;
  return {
    experiment_ids: stringArray(source?.experiment_ids || source?.experimentIds),
    dataset_version_ids: stringArray(source?.dataset_version_ids || source?.datasetVersionIds),
    annotation_ids: stringArray(source?.annotation_ids || source?.annotationIds),
    phoenix_deep_links: stringArray(source?.phoenix_deep_links || source?.phoenixDeepLinks),
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
