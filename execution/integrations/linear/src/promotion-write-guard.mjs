import {
  classifyMetaAuthorityChange,
  META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
  normalizeClassifierPath,
} from "./meta-change-classifier.mjs";
import {
  adopterSelfImprovementPersonaBinding,
  isAgentBehaviorPromptTarget,
  isAgentBehaviorRuntimeDefaultsTarget,
} from "./promotion/agent-behavior-scope.mjs";
import {
  resolveFactoryChangeDisposition,
  withFactoryChangeDisposition,
} from "./promotion/factory-change-disposition.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "./workflows/decomposition/eval-paths.mjs";

export const PROMOTION_WRITE_GUARD_ACTIVATION_ENV =
  "TEAMI_PROMOTION_WRITE_GUARD";
export const PROMOTION_WRITE_GUARD_REPORT_ONLY = "report_only";
export const PROMOTION_WRITE_GUARD_FAIL_CLOSED = "fail_closed";

export const PROMOTION_WRITE_GUARD_OWNER_COPY = Object.freeze({
  unattended_pre_activation_report_only: Object.freeze({
    waiting: "Proposal writing is waiting for fail-closed guard activation.",
    why_it_matters:
      "This matters because unattended runs must prove they are proposing only adopter-owned agent behavior before they can open review proposals.",
    next_safe_action:
      "Next safe action: review this candidate from a foreground owner session, or activate fail-closed enforcement after the guard checks pass.",
  }),
  factory_behavior_out_of_scope: Object.freeze({
    waiting: "This self-improvement candidate is out of scope.",
    why_it_matters:
      "This matters because adopter self-improvement may tune manifest-declared agent behavior, not factory behavior such as promotion policy, proposal creation, credentials, write authority, or maintainer-owned eval gates.",
    next_safe_action:
      "Next safe action: discard or investigate the candidate; factory behavior changes must go through normal maintainer-owned Teami development.",
  }),
  unknown_sensitive_blocked: Object.freeze({
    waiting: "This self-improvement candidate touched an unknown surface.",
    why_it_matters:
      "This matters because the loop is only allowed to author known manifest-declared agent-behavior targets.",
    next_safe_action:
      "Next safe action: investigate why the candidate escaped the allowed target set before asking the factory to open proposals again.",
  }),
  mixed_factory_behavior_blocked: Object.freeze({
    waiting: "This self-improvement candidate mixed agent behavior with factory behavior.",
    why_it_matters:
      "This matters because the loop may propose only adopter-owned agent behavior; factory behavior is maintainer-owned.",
    next_safe_action:
      "Next safe action: rerun or repair the candidate generation so only the allowed agent-behavior target is materialized.",
  }),
  write_allowed: Object.freeze({
    waiting: "No write-guard wait is active.",
    why_it_matters:
      "The classifier did not find a guard condition that blocks proposal writing in this activation state.",
    next_safe_action:
      "Next safe action: continue through the existing proposal review flow.",
  }),
});

const CLASS_PRIORITY = Object.freeze({
  ordinary_semantic: 0,
  meta_change: 1,
  authority_change: 2,
  unknown_sensitive: 3,
});
const KNOWN_CLASSES = new Set([
  "ordinary_semantic",
  "meta_change",
  "authority_change",
  "unknown_sensitive",
]);
const ORDINARY_MANIFEST_PIN_FIELDS = new Set([
  "accepted_prompt_version_id",
  "snapshot_sha256",
  "prompt_version",
]);

export function resolvePromotionWriteGuardActivationState({
  activationState = null,
  env = process.env,
} = {}) {
  if (activationState) return normalizeActivationState(activationState, "explicit");
  const raw = env?.[PROMOTION_WRITE_GUARD_ACTIVATION_ENV]
    ?? env?.TEAMI_CLASSIFIER_ENFORCEMENT
    ?? "";
  return normalizeActivationState(raw, raw ? "env" : "default_pre_activation");
}

export function resolvePromotionWriteGuard({
  invocation = {},
  classification = null,
  activationState = null,
} = {}) {
  const activation = normalizeActivationState(activationState, "explicit");
  const normalizedClassification = normalizeClassification(classification);
  const invocationKind = normalizeInvocation(invocation);
  // The demoted view: PATH-map + PROMPT-PROSE factory labels are advisory; a
  // factory class with a non-allowlisted (or no) backing reason still gates.
  const disposition = resolveFactoryChangeDisposition(normalizedClassification);
  const mixedOrdinaryGatingFactory = hasMixedOrdinaryGatingFactory(normalizedClassification, disposition);
  const className = normalizedClassification.class;

  if (activation.mode !== PROMOTION_WRITE_GUARD_FAIL_CLOSED && invocationKind.unattended) {
    return guardResult({
      allowed: false,
      mode: PROMOTION_WRITE_GUARD_REPORT_ONLY,
      reason: "promotion_write_guard_pre_activation_unattended_report_only",
      ownerCopyKey: "unattended_pre_activation_report_only",
      activation,
      classification: normalizedClassification,
      invocation: invocationKind,
      disposition,
    });
  }

  // unknown_sensitive ALWAYS gates (fail closed) — never demoted.
  if (className === "unknown_sensitive" || normalizedClassification.mixed_classes.includes("unknown_sensitive")) {
    return guardResult({
      allowed: false,
      mode: "blocked",
      reason: "promotion_write_guard_unknown_sensitive_blocked",
      ownerCopyKey: "unknown_sensitive_blocked",
      activation,
      classification: normalizedClassification,
      invocation: invocationKind,
      disposition,
    });
  }
  if (mixedOrdinaryGatingFactory) {
    return guardResult({
      allowed: false,
      mode: "blocked",
      reason: "promotion_write_guard_mixed_factory_behavior_blocked",
      ownerCopyKey: "mixed_factory_behavior_blocked",
      activation,
      classification: normalizedClassification,
      invocation: invocationKind,
      disposition,
    });
  }
  if (disposition.has_gating_factory_class) {
    const gatingClass = disposition.gating_classes[0];
    return guardResult({
      allowed: false,
      mode: "blocked",
      reason: `promotion_write_guard_${gatingClass}_factory_behavior_out_of_scope`,
      ownerCopyKey: "factory_behavior_out_of_scope",
      activation,
      classification: normalizedClassification,
      invocation: invocationKind,
      disposition,
    });
  }

  // Only advisory-only factory labels (path/prose) and/or ordinary remain — the
  // positive commit allowlist is the ownership gate, so this write proceeds and
  // the advisory is carried onto the guard output for the marker.
  return guardResult({
    allowed: true,
    mode: "write",
    reason: activation.mode === PROMOTION_WRITE_GUARD_FAIL_CLOSED
      ? "promotion_write_guard_fail_closed_ordinary_write_allowed"
      : "promotion_write_guard_pre_activation_foreground_write_allowed",
    ownerCopyKey: "write_allowed",
    activation,
    classification: normalizedClassification,
    invocation: invocationKind,
    disposition,
  });
}

export function ownerCopyForPromotionWriteGuard(guard) {
  const copy = PROMOTION_WRITE_GUARD_OWNER_COPY[guard?.owner_copy_key]
    || PROMOTION_WRITE_GUARD_OWNER_COPY.write_allowed;
  return `${copy.waiting} ${copy.why_it_matters} ${copy.next_safe_action}`;
}

export function classifyMaterializedPromotionFiles({
  files,
  beforeFiles = {},
  target = null,
} = {}) {
  const beforeMap = objectLikeToMap(beforeFiles);
  const results = fileEntries(files).map(([filePath, content]) => {
    const normalizedPath = normalizeClassifierPath(filePath);
    const before = beforeMap.get(normalizedPath);
    if (agentBehaviorPromptTargetFileChange({
      filePath: normalizedPath,
      before,
      after: content,
      target,
    })) {
      return ordinaryAgentBehaviorPromptClassification(normalizedPath, target);
    }
    const runtimeDefaultsClassification = classifyRuntimeDefaultsTargetFileChange({
      filePath: normalizedPath,
      before,
      after: content,
      target,
    });
    if (runtimeDefaultsClassification) {
      return runtimeDefaultsClassification;
    }
    const change = {
      path: normalizedPath,
      status: before === undefined ? "added" : "modified",
      generated: typeof content !== "string",
      hunks: [{
        header: "@@ materialized promotion diff @@",
        lines: changedHunkLines(before, content),
      }],
    };
    return classifyMetaAuthorityChange({ changes: [change] });
  });
  return combineClassificationResults(results);
}

function normalizeActivationState(value, source) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mode = normalizeActivationMode(
      value.mode
        ?? value.state
        ?? value.activation_state
        ?? (value.fail_closed === true || value.activated === true
          ? PROMOTION_WRITE_GUARD_FAIL_CLOSED
          : PROMOTION_WRITE_GUARD_REPORT_ONLY),
    );
    return {
      mode,
      source: value.source || source,
      raw: value.raw ?? value.mode ?? value.state ?? null,
    };
  }
  const mode = normalizeActivationMode(value);
  return { mode, source, raw: value == null ? null : String(value) };
}

function normalizeActivationMode(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if ([
    "fail_closed",
    "enforced",
    "active",
    "activated",
    "enabled",
    "enable",
    "true",
    "1",
    "yes",
    "y",
    "on",
  ].includes(normalized)) {
    return PROMOTION_WRITE_GUARD_FAIL_CLOSED;
  }
  return PROMOTION_WRITE_GUARD_REPORT_ONLY;
}

function normalizeClassification(classification) {
  const className = KNOWN_CLASSES.has(classification?.class)
    ? classification.class
    : "unknown_sensitive";
  return {
    class: className,
    reasons: Array.isArray(classification?.reasons) ? classification.reasons : [],
    protected_paths: Array.isArray(classification?.protected_paths) ? classification.protected_paths : [],
    affected_surfaces: Array.isArray(classification?.affected_surfaces) ? classification.affected_surfaces : [],
    mixed_classes: Array.isArray(classification?.mixed_classes)
      ? classification.mixed_classes.filter((entry) => KNOWN_CLASSES.has(entry))
      : [],
  };
}

function normalizeInvocation(invocation = {}) {
  const transport = invocation.transport
    ?? invocation.source
    ?? invocation.kind
    ?? invocation.mode
    ?? "";
  const normalized = String(transport).trim().toLowerCase();
  const unattended = typeof invocation.unattended === "boolean"
    ? invocation.unattended
    : ![
        "cli_local_session",
        "foreground_owner_session",
        "owner_foreground_session",
        "user_invoked",
      ].includes(normalized);
  return {
    transport: normalized || null,
    unattended,
  };
}

// Only a GATING factory class mixed with ordinary blocks; an advisory-only
// (path/prose) factory class alongside ordinary is now judgeable and passes.
function hasMixedOrdinaryGatingFactory(classification, disposition) {
  const classes = new Set(classification.mixed_classes);
  classes.add(classification.class);
  return classes.has("ordinary_semantic") && disposition.has_gating_factory_class;
}

function guardResult({
  allowed,
  mode,
  reason,
  ownerCopyKey,
  activation,
  classification,
  invocation,
  disposition = null,
}) {
  return {
    allowed,
    mode,
    reason,
    owner_copy_key: ownerCopyKey,
    activation_mode: activation.mode,
    activation_source: activation.source,
    classification_class: classification.class,
    mixed_classes: classification.mixed_classes,
    protected_paths: classification.protected_paths,
    invocation_transport: invocation.transport,
    // Demoted view threaded onto the guard output (the bare guardResult used to
    // drop reasons/detail). The advisory is recorded; it does not gate.
    advisory_only_classes: disposition?.advisory_only_classes ?? [],
    advisory_reasons: disposition?.advisory_reasons ?? [],
    gating_factory_classes: disposition?.gating_classes ?? [],
  };
}

function objectLikeToMap(value) {
  const entries = fileEntries(value);
  return new Map(entries.map(([filePath, content]) => [normalizeClassifierPath(filePath), content]));
}

function fileEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

function combineClassificationResults(results) {
  const classes = new Set();
  const reasons = [];
  const protectedPaths = new Set();
  const surfaces = new Set();
  for (const result of results) {
    if (KNOWN_CLASSES.has(result?.class)) classes.add(result.class);
    if (Array.isArray(result?.mixed_classes)) {
      for (const className of result.mixed_classes) {
        if (KNOWN_CLASSES.has(className)) classes.add(className);
      }
    }
    for (const reason of result?.reasons || []) reasons.push(reason);
    for (const protectedPath of result?.protected_paths || []) protectedPaths.add(protectedPath);
    for (const surface of result?.affected_surfaces || []) surfaces.add(surface);
  }
  if (classes.size === 0) classes.add("ordinary_semantic");
  const sortedClasses = [...classes].sort(classSort);
  const primaryClass = sortedClasses.at(-1);
  // Record the demoted view (advisory_reasons / advisories) on the
  // classification result. This is read-model metadata; the guards own gating.
  return withFactoryChangeDisposition({
    schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
    class: primaryClass,
    reasons,
    protected_paths: uniqueSorted([...protectedPaths]),
    affected_surfaces: uniqueSorted([...surfaces]),
    mixed_classes: sortedClasses.length > 1 ? sortedClasses : [],
    deterministic: true,
    fail_closed: primaryClass !== "ordinary_semantic" || classes.has("unknown_sensitive"),
    ignored_evidence_sources: [],
  });
}

function ordinaryAgentBehaviorPromptClassification(filePath, target) {
  return {
    schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
    class: "ordinary_semantic",
    reasons: [{
      id: "ordinary_agent_behavior_prompt_target",
      class: "ordinary_semantic",
      path: filePath,
      detail:
        "materialized diff changed only an allowed manifest-declared agent prompt target",
      surface: "agent_behavior_prompt",
      target_key: target?.target_key ?? null,
    }],
    protected_paths: [],
    affected_surfaces: ["agent_behavior_prompt"],
    mixed_classes: [],
    deterministic: true,
    fail_closed: false,
    ignored_evidence_sources: [],
  };
}

function ordinaryAgentBehaviorRuntimeDefaultsClassification(filePath, target) {
  return {
    schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
    class: "ordinary_semantic",
    reasons: [{
      id: "ordinary_agent_behavior_runtime_defaults_target",
      class: "ordinary_semantic",
      path: filePath,
      detail:
        "materialized diff changed only an allowed manifest-declared agent runtime defaults target",
      surface: "agent_behavior_runtime_defaults",
      target_key: target?.target_key ?? null,
    }],
    protected_paths: [],
    affected_surfaces: ["agent_behavior_runtime_defaults"],
    mixed_classes: [],
    deterministic: true,
    fail_closed: false,
    ignored_evidence_sources: [],
  };
}

function agentBehaviorPromptTargetFileChange({ filePath, before, after, target }) {
  if (!isAgentBehaviorPromptTarget({ candidateTargetKey: target?.target_key, target })) return false;
  const normalizedFilePath = normalizeClassifierPath(filePath);
  if (normalizedFilePath === normalizeClassifierPath(target.snapshot_path)) return true;
  if (normalizedFilePath !== DECOMPOSITION_EVAL_PATHS.manifest) return false;
  if (typeof before !== "string" || typeof after !== "string") return false;
  let beforeJson;
  let afterJson;
  try {
    beforeJson = JSON.parse(before);
    afterJson = JSON.parse(after);
  } catch {
    return false;
  }
  const targetKey = target?.target_key;
  const beforeIndex = Array.isArray(beforeJson.prompts)
    ? beforeJson.prompts.findIndex((entry) => entry?.target_key === targetKey)
    : -1;
  const afterIndex = Array.isArray(afterJson.prompts)
    ? afterJson.prompts.findIndex((entry) => entry?.target_key === targetKey)
    : -1;
  if (beforeIndex < 0 || beforeIndex !== afterIndex) return false;
  const changed = changedJsonFieldPaths(beforeJson, afterJson);
  return changed.length > 0
    && changed.every((fieldPath) => {
      const match = fieldPath.match(/^prompts\.(\d+)\.([^.[\]]+)$/);
      return Boolean(
        match
          && Number(match[1]) === beforeIndex
          && ORDINARY_MANIFEST_PIN_FIELDS.has(match[2]),
      );
    });
}

// Ordinary iff the manifest edit changes ONLY this runtime-defaults target's
// `rules[<index>].snapshot_sha256` — the atomic pin that accompanies the artifact
// write. Any other manifest field change falls through to the generic classifier.
function runtimeDefaultsManifestPinChangeIsOrdinary({ before, after, target }) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  let beforeJson;
  let afterJson;
  try {
    beforeJson = JSON.parse(before);
    afterJson = JSON.parse(after);
  } catch {
    return false;
  }
  const targetKey = target?.target_key;
  const beforeIndex = Array.isArray(beforeJson.rules)
    ? beforeJson.rules.findIndex((entry) => entry?.target_key === targetKey)
    : -1;
  const afterIndex = Array.isArray(afterJson.rules)
    ? afterJson.rules.findIndex((entry) => entry?.target_key === targetKey)
    : -1;
  if (beforeIndex < 0 || beforeIndex !== afterIndex) return false;
  const changed = changedJsonFieldPaths(beforeJson, afterJson);
  return changed.length > 0
    && changed.every((fieldPath) => {
      const match = fieldPath.match(/^rules\.(\d+)\.([^.[\]]+)$/);
      return Boolean(
        match
          && Number(match[1]) === beforeIndex
          && match[2] === "snapshot_sha256",
      );
    });
}

// Classify a materialized change to the runtime-role defaults artifact.
// Returns a classification object, or null to fall through to the generic
// classifier. The maintainer-owned judge is the reason this is field-aware: a
// judge runtime/model default change must be a meta change (blocked), not
// short-circuited ordinary. Detection is STRUCTURAL (parsed JSON field paths via
// the single self-improvement authority), so a multi-line value-only edit — where
// the "judge" key line is unchanged context a hunk scan would miss — is still
// caught. Only a change provably confined to non-judge role fields is ordinary.
function classifyRuntimeDefaultsTargetFileChange({ filePath, before, after, target }) {
  if (!isAgentBehaviorRuntimeDefaultsTarget({ candidateTargetKey: target?.target_key, target })) return null;
  const normalizedFilePath = normalizeClassifierPath(filePath);
  // The manifest pin edit that atomically accompanies a runtime-defaults change is
  // ordinary iff it changes ONLY this target's `rules[].snapshot_sha256` (mirror of
  // the accepted-prompt manifest-pin fast path). Otherwise fall through (fail closed).
  if (normalizedFilePath === DECOMPOSITION_EVAL_PATHS.manifest) {
    return runtimeDefaultsManifestPinChangeIsOrdinary({ before, after, target })
      ? ordinaryAgentBehaviorRuntimeDefaultsClassification(normalizedFilePath, target)
      : null;
  }
  if (normalizedFilePath !== normalizeClassifierPath(target.artifact_path)) return null;
  if (typeof before !== "string" || typeof after !== "string") return null;
  let beforeJson;
  let afterJson;
  try {
    beforeJson = JSON.parse(before);
    afterJson = JSON.parse(after);
  } catch {
    return null;
  }
  const changed = changedJsonFieldPaths(beforeJson, afterJson);
  if (changed.length === 0) return null;
  const changedRoles = changed.map((fieldPath) => {
    const match = fieldPath.match(/^roles\.([^.[\]]+)(?:\.|$)/);
    return match ? match[1] : null;
  });
  // A change we cannot tie to a known role field falls through to the generic
  // classifier (fail closed) rather than being declared ordinary here.
  if (changedRoles.some((role) => role === null)) return null;
  if (changedRoles.some((role) => !adopterSelfImprovementPersonaBinding({ ...target, role }))) {
    return judgeRuntimeDefaultsMetaClassification(filePath, target);
  }
  return ordinaryAgentBehaviorRuntimeDefaultsClassification(filePath, target);
}

function judgeRuntimeDefaultsMetaClassification(filePath, target) {
  return {
    schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
    class: "meta_change",
    reasons: [{
      id: "field_sensitive_runtime_defaults_judge_excluded",
      class: "meta_change",
      path: filePath,
      detail: "materialized diff changes the maintainer-owned judge runtime/model defaults",
      surface: "judge_runtime_defaults",
      target_key: target?.target_key ?? null,
    }],
    protected_paths: [filePath],
    affected_surfaces: ["judge_runtime_defaults"],
    mixed_classes: [],
    deterministic: true,
    fail_closed: true,
    ignored_evidence_sources: [],
  };
}

function changedJsonFieldPaths(before, after, prefix = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) return [prefix];
    const length = Math.max(before.length, after.length);
    const changed = [];
    for (let index = 0; index < length; index += 1) {
      const pathKey = prefix ? `${prefix}.${index}` : String(index);
      if (index >= before.length || index >= after.length) {
        changed.push(pathKey);
      } else {
        changed.push(...changedJsonFieldPaths(before[index], after[index], pathKey));
      }
    }
    return changed;
  }
  if (!isPlainObject(before) || !isPlainObject(after)) return [prefix];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = [];
  for (const key of keys) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
      changed.push(pathKey);
      continue;
    }
    changed.push(...changedJsonFieldPaths(before[key], after[key], pathKey));
  }
  return changed;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function classSort(left, right) {
  return CLASS_PRIORITY[left] - CLASS_PRIORITY[right];
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function changedHunkLines(before, after) {
  if (typeof after !== "string") return [];
  if (typeof before !== "string") {
    return after.split(/\r?\n/).map((line) => `+${line}`);
  }
  if (before === after) return [];
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines
    .slice(prefix, beforeLines.length - suffix)
    .map((line) => `-${line}`);
  const added = afterLines
    .slice(prefix, afterLines.length - suffix)
    .map((line) => `+${line}`);
  return [...removed, ...added];
}
