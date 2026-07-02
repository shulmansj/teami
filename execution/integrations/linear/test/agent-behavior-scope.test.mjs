import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  adopterSelfImprovementPersonaBinding,
  agentBehaviorTargetsFromManifest,
  classifyAgentBehaviorProposalScope,
  createAgentBehaviorScope,
  isAdopterSelfImprovementTarget,
  isAgentBehaviorPromptTarget,
  isAgentBehaviorRuntimeDefaultsTarget,
} from "../src/promotion/agent-behavior-scope.mjs";
import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../src/promotion-target-keys.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";
import { reviewDefinition } from "../src/workflows/review/definition.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

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

test("decomposition definition owns evaluator roles used by the scope exclusion", () => {
  assert.deepEqual(decompositionDefinition.engine_owned_evaluator_roles, [
    "judge",
    "decomposition_quality_judge",
  ]);
});

test("the single source admits adopter prompt and runtime-default targets", () => {
  assert.equal(isAdopterSelfImprovementTarget(ADOPTER_PROMPT_TARGET, {
    definition: decompositionDefinition,
  }), true);
  assert.equal(isAdopterSelfImprovementTarget(ADOPTER_RUNTIME_DEFAULTS_TARGET, {
    definition: decompositionDefinition,
  }), true);
  assert.equal(isAgentBehaviorPromptTarget({
    definition: decompositionDefinition,
    candidateTargetKey: ADOPTER_PROMPT_TARGET.target_key,
    target: ADOPTER_PROMPT_TARGET,
  }), true);
  assert.equal(isAgentBehaviorRuntimeDefaultsTarget({
    definition: decompositionDefinition,
    candidateTargetKey: ADOPTER_RUNTIME_DEFAULTS_TARGET.target_key,
    target: ADOPTER_RUNTIME_DEFAULTS_TARGET,
  }), true);
});

test("the single source rejects an evaluator role even when the prompt shape matches", () => {
  // The Judge prompt entry satisfies every base shape check; only the
  // definition-owned evaluator exclusion keeps it out.
  assert.equal(isAdopterSelfImprovementTarget(JUDGE_PROMPT_TARGET, {
    definition: decompositionDefinition,
  }), false);
  assert.equal(isAgentBehaviorPromptTarget({
    definition: decompositionDefinition,
    candidateTargetKey: JUDGE_PROMPT_TARGET.target_key,
    target: JUDGE_PROMPT_TARGET,
  }), false);

  const scope = classifyAgentBehaviorProposalScope({
    definition: decompositionDefinition,
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
    isAdopterSelfImprovementTarget(
      { ...ADOPTER_RUNTIME_DEFAULTS_TARGET, role: "judge" },
      { definition: decompositionDefinition },
    ),
    false,
  );
  // A non-judge role on the same aggregate target stays admitted.
  assert.equal(
    isAdopterSelfImprovementTarget(
      { ...ADOPTER_RUNTIME_DEFAULTS_TARGET, role: "pm" },
      { definition: decompositionDefinition },
    ),
    true,
  );
});

test("the driver governing prompt and runtime-defaults row bind to one driver persona identity", () => {
  const promptBinding = adopterSelfImprovementPersonaBinding(DRIVER_GOVERNING_PROMPT_TARGET, {
    definition: decompositionDefinition,
  });
  const runtimeBinding = adopterSelfImprovementPersonaBinding({
    ...ADOPTER_RUNTIME_DEFAULTS_TARGET,
    role: decompositionDefinition.driver,
  }, {
    definition: decompositionDefinition,
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
    isAdopterSelfImprovementTarget(
      { ...DRIVER_GOVERNING_PROMPT_TARGET, role: "pm" },
      { definition: decompositionDefinition },
    ),
    false,
    "the governing target key is admitted only when it is bound to the definition driver role",
  );
  assert.equal(
    adopterSelfImprovementPersonaBinding(ADOPTER_RUNTIME_DEFAULTS_TARGET, {
      definition: decompositionDefinition,
    }),
    null,
    "the aggregate runtime rule is allowed, but a concrete role row is required for persona binding",
  );
});

test("scope factory excludes evaluator roles from the owning definition, not hardcoded decomposition names", () => {
  const scope = createAgentBehaviorScope();
  const definition = {
    workflow_type: "custom_scope",
    driver: "conductor",
    driver_governing_target_key: "prompt/custom_scope/conductor_governing",
    engine_owned_evaluator_roles: ["critic"],
  };
  const evaluatorTarget = promptTarget({
    role: "critic",
    target_key: "prompt/custom_scope/critic",
    snapshot_path: "execution/evals/custom-scope/accepted-prompts/critic.md",
  });
  const workerTarget = promptTarget({
    role: "worker",
    target_key: "prompt/custom_scope/worker",
    snapshot_path: "execution/evals/custom-scope/accepted-prompts/worker.md",
  });

  assert.equal(scope.isAdopterSelfImprovementTarget(evaluatorTarget, { definition }), false);
  assert.equal(scope.isAdopterSelfImprovementTarget(workerTarget, { definition }), true);
});

test("definition-threaded classifier yields exactly adopter personas for each workflow manifest", () => {
  assert.deepEqual(
    personaRolesFor({
      definition: decompositionDefinition,
      manifest: readManifest("execution/evals/decomposition/phoenix-assets.json"),
    }),
    ["orchestrator", "pm", "sr_eng"],
  );
  assert.deepEqual(
    personaRolesFor({
      definition: executionDefinition,
      manifest: readManifest("execution/evals/execution/phoenix-assets.json"),
    }),
    ["orchestrator", "worker"],
  );
  assert.deepEqual(
    personaRolesFor({
      definition: reviewDefinition,
      manifest: readManifest("execution/evals/review/phoenix-assets.json"),
    }),
    ["orchestrator", "reviewer"],
  );
  assert.deepEqual(
    personaRolesFor({
      definition: PROBE_SCOPE_DEFINITION,
      manifest: probeManifest(),
    }),
    ["orchestrator", "worker"],
  );
});

const PROBE_SCOPE_DEFINITION = Object.freeze({
  workflow_type: "probe",
  driver: "orchestrator",
  driver_governing_target_key: "prompt/probe/orchestrator_governing",
  engine_owned_evaluator_roles: Object.freeze(["probe_judge"]),
});

function readManifest(repoRelativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...repoRelativePath.split("/")), "utf8"));
}

function personaRolesFor({ definition, manifest }) {
  const roles = new Set();
  for (const target of agentBehaviorTargetsFromManifest({ definition, manifest })) {
    const binding = adopterSelfImprovementPersonaBinding(target, { definition });
    if (binding) roles.add(binding.persona_role);
  }
  const sortedRoles = [...roles].sort();
  assert.equal(sortedRoles.includes("judge"), false);
  assert.equal(sortedRoles.includes("decomposition_quality_judge"), false);
  assert.equal(sortedRoles.includes("probe_judge"), false);
  assert.equal(sortedRoles.includes("drafter"), false);
  return sortedRoles;
}

function promptTarget({
  role,
  target_key,
  snapshot_path,
  human_name = role,
}) {
  return {
    role,
    target_key,
    human_name,
    artifact_kind: "accepted_prompt",
    materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    snapshot_path,
  };
}

function probeManifest() {
  return {
    schema_version: 1,
    prompts: [
      promptTarget({
        role: "probe_judge",
        target_key: "prompt/probe/probe_judge",
        snapshot_path: "test/fixtures/probe/accepted-prompts/probe-judge.md",
      }),
      promptTarget({
        role: "worker",
        target_key: "prompt/probe/worker",
        snapshot_path: "test/fixtures/probe/accepted-prompts/worker.md",
      }),
      promptTarget({
        role: "orchestrator",
        target_key: "prompt/probe/orchestrator_governing",
        snapshot_path: "test/fixtures/probe/accepted-prompts/orchestrator-governing.md",
      }),
    ],
    rules: [{
      target_key: "rule/probe/runtime_role_assignments",
      human_name: "Probe runtime role assignments",
      artifact_kind: "runtime_role_defaults",
      materializer: "eval_variant_to_runtime_role_defaults",
      artifact_path: "test/fixtures/probe/accepted-runtime-roles.json",
    }],
  };
}
