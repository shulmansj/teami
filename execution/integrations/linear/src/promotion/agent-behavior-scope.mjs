import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../promotion-target-keys.mjs";
import { decompositionDefinition } from "../workflows/decomposition/definition.mjs";
import { RUNTIME_ROLE_DEFAULTS_TARGET_KEY } from "../../../../engine/run-accepted-refs.mjs";

export const AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION =
  "agentic-factory-agent-behavior-scope/v1";

export const AGENT_BEHAVIOR_PROPOSAL_LABELS = Object.freeze([
  "behavior-proposal",
  "impact:prompt",
]);
export const AGENT_BEHAVIOR_RUNTIME_DEFAULTS_LABELS = Object.freeze([
  "behavior-proposal",
  "impact:runtime-defaults",
]);

// The decomposition quality judge is the maintainer-owned evaluator. The
// adopter USES it but must never TUNE it through the self-improvement loop.
// Both spellings of its role appear in the codebase: the manifest prompt entry
// declares role "decomposition_quality_judge"; the runtime-role layer names the
// aggregate role "judge". Exclude both.
export const JUDGE_ROLE_NAMES = Object.freeze(["judge", "decomposition_quality_judge"]);

function isPlainTarget(target) {
  return Boolean(target && typeof target === "object" && !Array.isArray(target));
}

// Private base shape checks. These describe a manifest-declared adopter
// prompt / runtime-defaults target by structure ONLY — they intentionally do
// NOT apply the judge exclusion. isAdopterSelfImprovementTarget() is the single
// authority that layers the judge exclusion on top of these shapes, so the
// exclusion lives in exactly one place.
function hasAgentBehaviorPromptShape(target, targetKey) {
  return Boolean(
    isPlainTarget(target)
      && target.target_key === targetKey
      && targetKey.startsWith("prompt/")
      && target.artifact_kind === "accepted_prompt"
      && target.materializer === "phoenix_prompt_version_to_accepted_prompt_snapshot"
      && typeof target.snapshot_path === "string"
      && target.snapshot_path.trim() !== "",
  );
}

function hasAgentBehaviorRuntimeDefaultsShape(target, targetKey) {
  return Boolean(
    isPlainTarget(target)
      && target.target_key === targetKey
      && targetKey.startsWith("rule/")
      && target.artifact_kind === "runtime_role_defaults"
      && target.materializer === "eval_variant_to_runtime_role_defaults"
      && typeof target.artifact_path === "string"
      && target.artifact_path.trim() !== "",
  );
}

function normalizedRole(target) {
  return typeof target?.role === "string" ? target.role.trim() : "";
}

function driverRole() {
  return typeof decompositionDefinition.driver === "string"
    ? decompositionDefinition.driver
    : "";
}

function driverGoverningTargetKey() {
  return typeof decompositionDefinition.driver_governing_target_key === "string"
    ? decompositionDefinition.driver_governing_target_key
    : "";
}

function driverGoverningPromptRoleIsBound(target, targetKey) {
  if (targetKey !== driverGoverningTargetKey()) return true;
  return normalizedRole(target) === driverRole();
}

export function isExcludedJudgeTarget(target) {
  if (!isPlainTarget(target)) return false;
  if (target.target_key === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY) return true;
  const role = normalizedRole(target);
  return JUDGE_ROLE_NAMES.includes(role);
}

// THE single source of truth: is this an adopter self-improvement target?
// One authority, one judge exclusion. Interface is `target -> bool` so callers
// that hold an aggregate target (e.g. runtime-role defaults) can spread a
// concrete `role` in and ask about that role specifically:
//   isAdopterSelfImprovementTarget({ ...target, role })
export function isAdopterSelfImprovementTarget(target) {
  if (!isPlainTarget(target)) return false;
  const targetKey = typeof target.target_key === "string" ? target.target_key.trim() : "";
  if (!targetKey) return false;
  if (isExcludedJudgeTarget(target)) return false;
  if (!driverGoverningPromptRoleIsBound(target, targetKey)) return false;
  return (
    hasAgentBehaviorPromptShape(target, targetKey)
    || hasAgentBehaviorRuntimeDefaultsShape(target, targetKey)
  );
}

export function adopterSelfImprovementPersonaBinding(target) {
  if (!isAdopterSelfImprovementTarget(target)) return null;
  const targetKey = typeof target.target_key === "string" ? target.target_key.trim() : "";
  const role = normalizedRole(target);
  if (!role) return null;

  const promptFacet = hasAgentBehaviorPromptShape(target, targetKey);
  const runtimeDefaultsFacet = hasAgentBehaviorRuntimeDefaultsShape(target, targetKey);
  const driver = driverRole();
  const isDriver = role === driver;
  const facet = promptFacet ? "prompt" : runtimeDefaultsFacet ? "runtime-defaults" : null;
  if (!facet) return null;
  if (isDriver && facet === "prompt" && targetKey !== driverGoverningTargetKey()) return null;

  return {
    persona_role: role,
    persona_kind: isDriver ? "driver" : "role",
    driver_role: isDriver ? driver : null,
    facet,
    target_key: targetKey,
    governing_target_key: isDriver ? driverGoverningTargetKey() : null,
    runtime_defaults_target_key: isDriver ? RUNTIME_ROLE_DEFAULTS_TARGET_KEY : null,
  };
}

export function isDriverSelfImprovementTarget(target) {
  return adopterSelfImprovementPersonaBinding(target)?.persona_kind === "driver";
}

export function classifyAgentBehaviorProposalScope({ candidateTargetKey, target = null } = {}) {
  const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
  if (isAgentBehaviorPromptTarget({ candidateTargetKey: targetKey, target })) {
    return {
      schema_version: AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION,
      ok: true,
      reason: "agent_behavior_target_allowed",
      target_key: targetKey,
      ownership: "adopter_agent_behavior",
      impact: "prompt",
      agent_role: target?.role ?? null,
      human_name: target?.human_name ?? null,
      proposal_labels: [...AGENT_BEHAVIOR_PROPOSAL_LABELS],
    };
  }
  if (isAgentBehaviorRuntimeDefaultsTarget({ candidateTargetKey: targetKey, target })) {
    return {
      schema_version: AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION,
      ok: true,
      reason: "agent_behavior_target_allowed",
      target_key: targetKey,
      ownership: "adopter_agent_behavior",
      impact: "runtime-defaults",
      agent_role: null,
      human_name: target?.human_name ?? null,
      proposal_labels: [...AGENT_BEHAVIOR_RUNTIME_DEFAULTS_LABELS],
    };
  }

  return {
    schema_version: AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION,
    ok: false,
    reason: "candidate_target_out_of_scope",
    target_key: targetKey || null,
    ownership: "factory_behavior",
    surface: outOfScopeSurfaceForTarget(targetKey, target),
    proposal_labels: [],
  };
}

export function isAgentBehaviorPromptTarget({ candidateTargetKey, target = null } = {}) {
  const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
  if (!hasAgentBehaviorPromptShape(target, targetKey)) return false;
  return isAdopterSelfImprovementTarget(target);
}

export function isAgentBehaviorRuntimeDefaultsTarget({ candidateTargetKey, target = null } = {}) {
  const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
  if (!hasAgentBehaviorRuntimeDefaultsShape(target, targetKey)) return false;
  return isAdopterSelfImprovementTarget(target);
}

export function agentBehaviorPromptTargetsFromManifest(manifest = {}) {
  return (Array.isArray(manifest?.prompts) ? manifest.prompts : [])
    .filter((target) =>
      isAgentBehaviorPromptTarget({
        candidateTargetKey: target?.target_key,
        target,
      }));
}

export function agentBehaviorRuntimeDefaultsTargetsFromManifest(manifest = {}) {
  return (Array.isArray(manifest?.rules) ? manifest.rules : [])
    .filter((target) =>
      isAgentBehaviorRuntimeDefaultsTarget({
        candidateTargetKey: target?.target_key,
        target,
      }));
}

export function agentBehaviorTargetsFromManifest(manifest = {}) {
  return [
    ...agentBehaviorPromptTargetsFromManifest(manifest),
    ...agentBehaviorRuntimeDefaultsTargetsFromManifest(manifest),
  ];
}

export function agentBehaviorPromptTargetForKey({ manifest = {}, candidateTargetKey } = {}) {
  const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
  return agentBehaviorPromptTargetsFromManifest(manifest)
    .find((target) => target.target_key === targetKey) || null;
}

export function agentBehaviorTargetForKey({ manifest = {}, candidateTargetKey } = {}) {
  const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
  return agentBehaviorTargetsFromManifest(manifest)
    .find((target) => target.target_key === targetKey) || null;
}

export function ownerCopyForAgentBehaviorScope(scope = {}) {
  if (scope.ok) {
    return "This candidate targets adopter-owned agent behavior and may continue through the behavior proposal flow.";
  }
  const target = scope.target_key ? ` (${scope.target_key})` : "";
  return [
    `The self-improvement loop cannot propose this change${target}.`,
    "It is outside the adopter-owned agent-behavior scope.",
    "Factory behavior is maintainer-owned and must change through normal Agentic Factory development, not through an adopter self-improvement proposal.",
  ].join(" ");
}

function outOfScopeSurfaceForTarget(targetKey, target) {
  if (!targetKey) return "unknown_target";
  if (targetKey === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY || isExcludedJudgeTarget(target)) {
    return "evaluation_judging_rules";
  }
  if (targetKey.startsWith("policy/")) {
    return "approval_or_promotion_policy";
  }
  if (targetKey.startsWith("rule/")) {
    return target ? "non_agent_behavior_rule_target" : "runtime_or_factory_rules";
  }
  if (targetKey.startsWith("schema/")) {
    return "schema_or_contract";
  }
  if (targetKey.startsWith("code_evaluator/") || targetKey.startsWith("evaluator_prompt/")) {
    return "evaluation_judging_rules";
  }
  if (targetKey.startsWith("prompt/")) {
    return target ? "non_agent_prompt_target" : "unknown_prompt_target";
  }
  return "unknown_target";
}
