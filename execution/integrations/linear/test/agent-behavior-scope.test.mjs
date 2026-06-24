import assert from "node:assert/strict";
import test from "node:test";

import {
  adopterSelfImprovementPersonaBinding,
  classifyAgentBehaviorProposalScope,
  isAdopterSelfImprovementTarget,
  isAgentBehaviorPromptTarget,
  isAgentBehaviorRuntimeDefaultsTarget,
  JUDGE_ROLE_NAMES,
} from "../src/promotion/agent-behavior-scope.mjs";
import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../src/promotion-target-keys.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

// Shared fixtures: the single adopter self-improvement authority excludes the
// maintainer-owned judge exactly once, and every shape-matching adopter target
// is admitted. Both judge-role spellings used in the codebase are excluded:
// the manifest prompt entry declares role "decomposition_quality_judge"; the
// runtime-role aggregate names the role "judge".
const ADOPTER_PROMPT_TARGET = Object.freeze({
  role: "sr_eng",
  target_key: "prompt/decomposition/sr_eng_grounding_pass",
  artifact_kind: "accepted_prompt",
  materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
  snapshot_path: "execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md",
});

const ADOPTER_RUNTIME_DEFAULTS_TARGET = Object.freeze({
  target_key: "rule/decomposition/runtime_role_assignments",
  artifact_kind: "runtime_role_defaults",
  materializer: "eval_variant_to_runtime_role_defaults",
  artifact_path: "execution/evals/decomposition/accepted-runtime-roles.json",
});

const DRIVER_GOVERNING_PROMPT_TARGET = Object.freeze({
  role: decompositionDefinition.driver,
  target_key: decompositionDefinition.driver_governing_target_key,
  artifact_kind: "accepted_prompt",
  materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
  snapshot_path: "execution/evals/decomposition/accepted-prompts/orchestrator-governing.md",
});

const JUDGE_PROMPT_TARGET = Object.freeze({
  role: "decomposition_quality_judge",
  target_key: DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
  artifact_kind: "accepted_prompt",
  materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
  snapshot_path: "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md",
});

test("decomposition definition evaluator roles use the judge exclusion authority", () => {
  assert.equal(decompositionDefinition.engine_owned_evaluator_roles, JUDGE_ROLE_NAMES);
  assert.deepEqual(decompositionDefinition.engine_owned_evaluator_roles, [
    "judge",
    "decomposition_quality_judge",
  ]);
});

test("the single source admits adopter prompt and runtime-default targets", () => {
  assert.equal(isAdopterSelfImprovementTarget(ADOPTER_PROMPT_TARGET), true);
  assert.equal(isAdopterSelfImprovementTarget(ADOPTER_RUNTIME_DEFAULTS_TARGET), true);
  assert.equal(isAgentBehaviorPromptTarget({
    candidateTargetKey: ADOPTER_PROMPT_TARGET.target_key,
    target: ADOPTER_PROMPT_TARGET,
  }), true);
  assert.equal(isAgentBehaviorRuntimeDefaultsTarget({
    candidateTargetKey: ADOPTER_RUNTIME_DEFAULTS_TARGET.target_key,
    target: ADOPTER_RUNTIME_DEFAULTS_TARGET,
  }), true);
});

test("the single source rejects the judge by target_key even when the prompt shape matches", () => {
  // The judge prompt entry satisfies every base shape check; only the judge
  // exclusion keeps it out. This is the root-cause guard the whole feature rests on.
  assert.equal(isAdopterSelfImprovementTarget(JUDGE_PROMPT_TARGET), false);
  assert.equal(isAgentBehaviorPromptTarget({
    candidateTargetKey: JUDGE_PROMPT_TARGET.target_key,
    target: JUDGE_PROMPT_TARGET,
  }), false);

  const scope = classifyAgentBehaviorProposalScope({
    candidateTargetKey: JUDGE_PROMPT_TARGET.target_key,
    target: JUDGE_PROMPT_TARGET,
  });
  assert.equal(scope.ok, false);
  assert.equal(scope.reason, "candidate_target_out_of_scope");
  assert.equal(scope.ownership, "factory_behavior");
  assert.deepEqual(scope.proposal_labels, []);
});

test("the single source rejects the judge runtime role on an otherwise-admitted aggregate target", () => {
  // Runtime-defaults is an aggregate target; callers spread a concrete role in.
  // The "judge" role spelling (runtime-role layer) is excluded.
  assert.equal(
    isAdopterSelfImprovementTarget({ ...ADOPTER_RUNTIME_DEFAULTS_TARGET, role: "judge" }),
    false,
  );
  // A non-judge role on the same aggregate target stays admitted.
  assert.equal(
    isAdopterSelfImprovementTarget({ ...ADOPTER_RUNTIME_DEFAULTS_TARGET, role: "pm" }),
    true,
  );
});

test("the driver governing prompt and runtime-defaults row bind to one driver persona identity", () => {
  const promptBinding = adopterSelfImprovementPersonaBinding(DRIVER_GOVERNING_PROMPT_TARGET);
  const runtimeBinding = adopterSelfImprovementPersonaBinding({
    ...ADOPTER_RUNTIME_DEFAULTS_TARGET,
    role: decompositionDefinition.driver,
  });

  assert.equal(promptBinding.persona_kind, "driver");
  assert.equal(runtimeBinding.persona_kind, "driver");
  assert.equal(promptBinding.persona_role, decompositionDefinition.driver);
  assert.equal(runtimeBinding.persona_role, decompositionDefinition.driver);
  assert.equal(promptBinding.governing_target_key, decompositionDefinition.driver_governing_target_key);
  assert.equal(runtimeBinding.governing_target_key, decompositionDefinition.driver_governing_target_key);
  assert.equal(promptBinding.runtime_defaults_target_key, ADOPTER_RUNTIME_DEFAULTS_TARGET.target_key);
  assert.equal(runtimeBinding.runtime_defaults_target_key, ADOPTER_RUNTIME_DEFAULTS_TARGET.target_key);
  assert.equal(promptBinding.facet, "prompt");
  assert.equal(runtimeBinding.facet, "runtime-defaults");

  assert.equal(
    isAdopterSelfImprovementTarget({ ...DRIVER_GOVERNING_PROMPT_TARGET, role: "pm" }),
    false,
    "the governing target key is admitted only when it is bound to the definition driver role",
  );
  assert.equal(
    adopterSelfImprovementPersonaBinding(ADOPTER_RUNTIME_DEFAULTS_TARGET),
    null,
    "the aggregate runtime rule is allowed, but a concrete role row is required for persona binding",
  );
});
