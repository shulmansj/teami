import {
  AGENT_BEHAVIOR_PROPOSAL_LABELS,
  AGENT_BEHAVIOR_RUNTIME_DEFAULTS_LABELS,
  AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION,
  createAgentBehaviorScope,
} from "../../../../engine/agent-behavior-scope.mjs";

export {
  AGENT_BEHAVIOR_PROPOSAL_LABELS,
  AGENT_BEHAVIOR_RUNTIME_DEFAULTS_LABELS,
  AGENT_BEHAVIOR_SCOPE_SCHEMA_VERSION,
  createAgentBehaviorScope,
};

const DEFAULT_DECOMPOSITION_SCOPE_DEFINITION = Object.freeze({
  workflow_type: "decomposition",
  driver: "orchestrator",
  driver_governing_target_key: "prompt/decomposition/orchestrator_governing",
  engine_owned_evaluator_roles: Object.freeze(["judge", "decomposition_quality_judge"]),
});

const DEFAULT_SCOPE = createAgentBehaviorScope({
  defaultDefinition: DEFAULT_DECOMPOSITION_SCOPE_DEFINITION,
});

export const adopterSelfImprovementPersonaBinding =
  DEFAULT_SCOPE.adopterSelfImprovementPersonaBinding;
export const agentBehaviorPromptTargetForKey =
  DEFAULT_SCOPE.agentBehaviorPromptTargetForKey;
export const agentBehaviorPromptTargetsFromManifest =
  DEFAULT_SCOPE.agentBehaviorPromptTargetsFromManifest;
export const agentBehaviorRuntimeDefaultsTargetsFromManifest =
  DEFAULT_SCOPE.agentBehaviorRuntimeDefaultsTargetsFromManifest;
export const agentBehaviorTargetForKey = DEFAULT_SCOPE.agentBehaviorTargetForKey;
export const agentBehaviorTargetsFromManifest =
  DEFAULT_SCOPE.agentBehaviorTargetsFromManifest;
export const classifyAgentBehaviorProposalScope =
  DEFAULT_SCOPE.classifyAgentBehaviorProposalScope;
export const isAdopterSelfImprovementTarget =
  DEFAULT_SCOPE.isAdopterSelfImprovementTarget;
export const isAgentBehaviorPromptTarget = DEFAULT_SCOPE.isAgentBehaviorPromptTarget;
export const isAgentBehaviorRuntimeDefaultsTarget =
  DEFAULT_SCOPE.isAgentBehaviorRuntimeDefaultsTarget;
export const isDriverSelfImprovementTarget =
  DEFAULT_SCOPE.isDriverSelfImprovementTarget;
export const isEngineOwnedEvaluatorTarget =
  DEFAULT_SCOPE.isEngineOwnedEvaluatorTarget;
export const isExcludedJudgeTarget = DEFAULT_SCOPE.isExcludedJudgeTarget;
export const ownerCopyForAgentBehaviorScope =
  DEFAULT_SCOPE.ownerCopyForAgentBehaviorScope;
