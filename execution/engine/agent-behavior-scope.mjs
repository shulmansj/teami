export const AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION =
  "teami-agent-behavior-scope/v1";

export const AGENT_BEHAVIOR_PROPOSAL_LABELS = Object.freeze([
  "behavior-proposal",
  "impact:prompt",
]);
export const AGENT_BEHAVIOR_RUNTIME_DEFAULTS_LABELS = Object.freeze([
  "behavior-proposal",
  "impact:runtime-defaults",
]);

function isPlainTarget(target) {
  return Boolean(target && typeof target === "object" && !Array.isArray(target));
}

function stringSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean),
  );
}

function runtimeDefaultsTargetKeyForDefinition(definition) {
  const workflowType = typeof definition?.workflow_type === "string"
    ? definition.workflow_type.trim()
    : "";
  return workflowType ? `rule/${workflowType}/runtime_role_assignments` : null;
}

function normalizeScopeConfig({
  definition = null,
  driverRole = definition?.driver,
  driverGoverningTargetKey = definition?.driver_governing_target_key,
  excludedTargetKeys = [],
  engineOwnedEvaluatorRoles = definition?.engine_owned_evaluator_roles,
  runtimeDefaultsTargetKey = runtimeDefaultsTargetKeyForDefinition(definition),
} = {}) {
  return {
    driverRole: typeof driverRole === "string" ? driverRole.trim() : "",
    driverGoverningTargetKey: typeof driverGoverningTargetKey === "string"
      ? driverGoverningTargetKey.trim()
      : "",
    excludedTargetKeys: stringSet(excludedTargetKeys),
    engineOwnedEvaluatorRoles: stringSet(engineOwnedEvaluatorRoles),
    runtimeDefaultsTargetKey: typeof runtimeDefaultsTargetKey === "string"
      ? runtimeDefaultsTargetKey.trim()
      : null,
  };
}

// Private base shape checks. These describe a manifest-declared adopter
// prompt / runtime-defaults target by structure ONLY; they intentionally do
// NOT apply the engine-owned evaluator exclusion.
// isAdopterSelfImprovementTarget() is the single authority that layers that
// exclusion on top of these shapes, so it lives in exactly one place.
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

export function createAgentBehaviorScope(config = {}) {
  const {
    definition: legacyDefaultDefinition = null,
    defaultDefinition = legacyDefaultDefinition,
    driverRole,
    driverGoverningTargetKey,
    excludedTargetKeys = [],
    engineOwnedEvaluatorRoles,
    runtimeDefaultsTargetKey,
  } = config;

  function scopeConfigFor(definition = null) {
    return normalizeScopeConfig({
      definition: definition ?? defaultDefinition,
      driverRole,
      driverGoverningTargetKey,
      excludedTargetKeys,
      engineOwnedEvaluatorRoles,
      runtimeDefaultsTargetKey,
    });
  }

  function targetPredicateArgs(targetOrOptions, options = {}) {
    if (
      isPlainTarget(targetOrOptions)
      && Object.hasOwn(targetOrOptions, "target")
      && (
        Object.hasOwn(targetOrOptions, "definition")
        || Object.keys(targetOrOptions).every((key) => ["definition", "target"].includes(key))
      )
    ) {
      return {
        definition: targetOrOptions.definition ?? options.definition ?? null,
        target: targetOrOptions.target,
      };
    }
    return {
      definition: options.definition ?? null,
      target: targetOrOptions,
    };
  }

  function manifestArgs(manifestOrOptions = {}, options = {}) {
    if (
      isPlainTarget(manifestOrOptions)
      && (
        Object.hasOwn(manifestOrOptions, "manifest")
        || Object.hasOwn(manifestOrOptions, "definition")
      )
    ) {
      return {
        definition: manifestOrOptions.definition ?? options.definition ?? null,
        manifest: manifestOrOptions.manifest ?? {},
      };
    }
    return {
      definition: options.definition ?? null,
      manifest: manifestOrOptions ?? {},
    };
  }

  function driverGoverningPromptRoleIsBound(scopeConfig, target, targetKey) {
    if (!scopeConfig.driverGoverningTargetKey) return true;
    if (targetKey !== scopeConfig.driverGoverningTargetKey) return true;
    return normalizedRole(target) === scopeConfig.driverRole;
  }

  function isEngineOwnedEvaluatorTarget(target, scopeConfig) {
    if (!isPlainTarget(target)) return false;
    if (scopeConfig.excludedTargetKeys.has(target.target_key)) return true;
    const role = normalizedRole(target);
    return scopeConfig.engineOwnedEvaluatorRoles.has(role);
  }

  // THE single source of truth: is this an adopter self-improvement target?
  // One authority, one engine-owned evaluator exclusion. Interface accepts a
  // concrete target plus an optional owning workflow definition so callers that
  // hold an aggregate target (e.g. runtime-role defaults) can spread a concrete
  // `role` in and ask about that role specifically:
  //   isAdopterSelfImprovementTarget({ ...target, role }, { definition })
  function isAdopterSelfImprovementTarget(targetOrOptions, options = {}) {
    const { definition, target } = targetPredicateArgs(targetOrOptions, options);
    const scopeConfig = scopeConfigFor(definition);
    if (!isPlainTarget(target)) return false;
    const targetKey = typeof target.target_key === "string" ? target.target_key.trim() : "";
    if (!targetKey) return false;
    if (isEngineOwnedEvaluatorTarget(target, scopeConfig)) return false;
    if (!driverGoverningPromptRoleIsBound(scopeConfig, target, targetKey)) return false;
    return (
      hasAgentBehaviorPromptShape(target, targetKey)
      || hasAgentBehaviorRuntimeDefaultsShape(target, targetKey)
    );
  }

  function adopterSelfImprovementPersonaBinding(targetOrOptions, options = {}) {
    const { definition, target } = targetPredicateArgs(targetOrOptions, options);
    const scopeConfig = scopeConfigFor(definition);
    if (!isAdopterSelfImprovementTarget(target, { definition })) return null;
    const targetKey = typeof target.target_key === "string" ? target.target_key.trim() : "";
    const role = normalizedRole(target);
    if (!role) return null;

    const promptFacet = hasAgentBehaviorPromptShape(target, targetKey);
    const runtimeDefaultsFacet = hasAgentBehaviorRuntimeDefaultsShape(target, targetKey);
    const isDriver = Boolean(scopeConfig.driverRole) && role === scopeConfig.driverRole;
    const facet = promptFacet ? "prompt" : runtimeDefaultsFacet ? "runtime-defaults" : null;
    if (!facet) return null;
    if (isDriver && facet === "prompt" && targetKey !== scopeConfig.driverGoverningTargetKey) {
      return null;
    }

    return {
      persona_role: role,
      persona_kind: isDriver ? "driver" : "role",
      driver_role: isDriver ? scopeConfig.driverRole : null,
      facet,
      target_key: targetKey,
      governing_target_key: isDriver ? scopeConfig.driverGoverningTargetKey : null,
      runtime_defaults_target_key: isDriver ? scopeConfig.runtimeDefaultsTargetKey : null,
    };
  }

  function isDriverSelfImprovementTarget(targetOrOptions, options = {}) {
    return adopterSelfImprovementPersonaBinding(targetOrOptions, options)?.persona_kind === "driver";
  }

  function classifyAgentBehaviorProposalScope({ definition = null, candidateTargetKey, target = null } = {}) {
    const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
    if (isAgentBehaviorPromptTarget({ definition, candidateTargetKey: targetKey, target })) {
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
    if (isAgentBehaviorRuntimeDefaultsTarget({ definition, candidateTargetKey: targetKey, target })) {
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
      surface: outOfScopeSurfaceForTarget(targetKey, target, scopeConfigFor(definition)),
      proposal_labels: [],
    };
  }

  function isAgentBehaviorPromptTarget({ definition = null, candidateTargetKey, target = null } = {}) {
    const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
    if (!hasAgentBehaviorPromptShape(target, targetKey)) return false;
    return isAdopterSelfImprovementTarget(target, { definition });
  }

  function isAgentBehaviorRuntimeDefaultsTarget({ definition = null, candidateTargetKey, target = null } = {}) {
    const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
    if (!hasAgentBehaviorRuntimeDefaultsShape(target, targetKey)) return false;
    return isAdopterSelfImprovementTarget(target, { definition });
  }

  function agentBehaviorPromptTargetsFromManifest(manifestOrOptions = {}, options = {}) {
    const { definition, manifest } = manifestArgs(manifestOrOptions, options);
    return (Array.isArray(manifest?.prompts) ? manifest.prompts : [])
      .filter((target) =>
        isAgentBehaviorPromptTarget({
          definition,
          candidateTargetKey: target?.target_key,
          target,
        }));
  }

  function agentBehaviorRuntimeDefaultsTargetsFromManifest(manifestOrOptions = {}, options = {}) {
    const { definition, manifest } = manifestArgs(manifestOrOptions, options);
    return (Array.isArray(manifest?.rules) ? manifest.rules : [])
      .filter((target) =>
        isAgentBehaviorRuntimeDefaultsTarget({
          definition,
          candidateTargetKey: target?.target_key,
          target,
        }));
  }

  function agentBehaviorTargetsFromManifest(manifestOrOptions = {}, options = {}) {
    const { definition, manifest } = manifestArgs(manifestOrOptions, options);
    return [
      ...agentBehaviorPromptTargetsFromManifest(manifest, { definition }),
      ...agentBehaviorRuntimeDefaultsTargetsFromManifest(manifest, { definition }),
    ];
  }

  function agentBehaviorPromptTargetForKey({ definition = null, manifest = {}, candidateTargetKey } = {}) {
    const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
    return agentBehaviorPromptTargetsFromManifest(manifest, { definition })
      .find((target) => target.target_key === targetKey) || null;
  }

  function agentBehaviorTargetForKey({ definition = null, manifest = {}, candidateTargetKey } = {}) {
    const targetKey = typeof candidateTargetKey === "string" ? candidateTargetKey.trim() : "";
    return agentBehaviorTargetsFromManifest(manifest, { definition })
      .find((target) => target.target_key === targetKey) || null;
  }

  function ownerCopyForAgentBehaviorScope(scope = {}) {
    if (scope.ok) {
      return "This candidate targets adopter-owned agent behavior and may continue through the behavior proposal flow.";
    }
    const target = scope.target_key ? ` (${scope.target_key})` : "";
    return [
      `The self-improvement loop cannot propose this change${target}.`,
      "It is outside the adopter-owned agent-behavior scope.",
      "Factory behavior is maintainer-owned and must change through normal Teami development, not through an adopter self-improvement proposal.",
    ].join(" ");
  }

  function outOfScopeSurfaceForTarget(targetKey, target, scopeConfig) {
    if (!targetKey) return "unknown_target";
    if (scopeConfig.excludedTargetKeys.has(targetKey) || isEngineOwnedEvaluatorTarget(target, scopeConfig)) {
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

  return Object.freeze({
    adopterSelfImprovementPersonaBinding,
    agentBehaviorPromptTargetForKey,
    agentBehaviorPromptTargetsFromManifest,
    agentBehaviorRuntimeDefaultsTargetsFromManifest,
    agentBehaviorTargetForKey,
    agentBehaviorTargetsFromManifest,
    classifyAgentBehaviorProposalScope,
    isAdopterSelfImprovementTarget,
    isAgentBehaviorPromptTarget,
    isAgentBehaviorRuntimeDefaultsTarget,
    isDriverSelfImprovementTarget,
    isEngineOwnedEvaluatorTarget: (targetOrOptions, options = {}) => {
      const { definition, target } = targetPredicateArgs(targetOrOptions, options);
      return isEngineOwnedEvaluatorTarget(target, scopeConfigFor(definition));
    },
    isExcludedJudgeTarget: (targetOrOptions, options = {}) => {
      const { definition, target } = targetPredicateArgs(targetOrOptions, options);
      return isEngineOwnedEvaluatorTarget(target, scopeConfigFor(definition));
    },
    ownerCopyForAgentBehaviorScope,
  });
}
