import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";
import {
  createOrchestratorRoster,
  ORCHESTRATOR_GOVERNING_TARGET_KEY,
} from "../src/orchestrator-roster.mjs";

const SYNTHETIC_WORKFLOW_TYPE = "selfimp_roster_synthetic";
const SYNTHETIC_NAMESPACE = "execution/evals/selfimp-roster-empty";
const SYNTHETIC_WORKER_TARGET = "prompt/selfimp_roster/worker";
const SYNTHETIC_GOVERNING_TARGET = "prompt/selfimp_roster/conductor_governing";
const SYNTHETIC_EVALUATOR_TARGET = "prompt/selfimp_roster/evaluator";

const DECOMPOSITION_SELECTABLE_TARGETS = Object.freeze([
  "prompt/decomposition/pm_product_sufficiency_pass",
  "prompt/decomposition/sr_eng_grounding_pass",
  "prompt/decomposition/pm_synthesis",
  "prompt/decomposition/sr_eng_blocker_check",
]);

test("synthetic workflow roster is definition-driven and non-promotable when eval assets are absent", () => {
  const registrySnapshot = registeredWorkflowTypes()
    .map((workflowType) => getWorkflowDefinition(workflowType));
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selfimp-roster-"));
  const manifestOnlyRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selfimp-roster-manifest-"));
  const synthetic = syntheticDefinition();
  const namespaceDir = path.join(tempRepoRoot, ...SYNTHETIC_NAMESPACE.split("/"));
  const manifestOnlyNamespaceDir = path.join(manifestOnlyRepoRoot, ...SYNTHETIC_NAMESPACE.split("/"));
  fs.mkdirSync(namespaceDir, { recursive: true });
  fs.mkdirSync(manifestOnlyNamespaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestOnlyNamespaceDir, "phoenix-assets.json"),
    `${JSON.stringify(syntheticManifest(), null, 2)}\n`,
    "utf8",
  );

  try {
    resetRegistry();
    registerWorkflow(synthetic);
    assert.equal(getWorkflowDefinition(SYNTHETIC_WORKFLOW_TYPE), synthetic);
    assert.deepEqual(evalNamespacePaths(synthetic), {
      manifest: `${SYNTHETIC_NAMESPACE}/phoenix-assets.json`,
      annotation_schema: `${SYNTHETIC_NAMESPACE}/annotation.schema.json`,
      example_schema: `${SYNTHETIC_NAMESPACE}/example.schema.json`,
      accepted_runtime: `${SYNTHETIC_NAMESPACE}/accepted-runtime-roles.json`,
      proposals: `${SYNTHETIC_NAMESPACE}/proposals`,
      policy: `${SYNTHETIC_NAMESPACE}/promotion-policy.json`,
      variants: `${SYNTHETIC_NAMESPACE}/variants.json`,
      taxonomy: `${SYNTHETIC_NAMESPACE}/failure-taxonomy.json`,
    });

    const fileBackedRoster = createOrchestratorRoster({
      workflowType: SYNTHETIC_WORKFLOW_TYPE,
      repoRoot: manifestOnlyRepoRoot,
    });
    assert.deepEqual(sorted(fileBackedRoster.selectableTargets), sorted([
      SYNTHETIC_WORKER_TARGET,
      ORCHESTRATOR_GOVERNING_TARGET_KEY,
    ]));
    assert.equal(fileBackedRoster.promotable, false);
    assert.deepEqual(
      fileBackedRoster.evalAssets.missing.map(({ asset, repo_relative_path }) => ({ asset, repo_relative_path })),
      [
        { asset: "variants", repo_relative_path: `${SYNTHETIC_NAMESPACE}/variants.json` },
      ],
      "file-backed roster reads the synthetic manifest path and remains non-promotable without variants",
    );

    const roster = createOrchestratorRoster({
      workflowType: SYNTHETIC_WORKFLOW_TYPE,
      repoRoot: tempRepoRoot,
      manifest: syntheticManifest(),
    });

    assert.deepEqual(sorted(roster.selectableTargets), sorted([
      SYNTHETIC_WORKER_TARGET,
      ORCHESTRATOR_GOVERNING_TARGET_KEY,
    ]));
    assert.equal(
      roster.resolve(SYNTHETIC_GOVERNING_TARGET).reason,
      "orchestrator_roster_target_not_selectable",
      "the synthetic workflow's own governing prompt is excluded by its definition-owned target key",
    );
    assert.equal(
      roster.resolve(SYNTHETIC_EVALUATOR_TARGET).reason,
      "orchestrator_roster_target_not_selectable",
      "the synthetic workflow's evaluator prompt is excluded by definition-owned evaluator roles",
    );

    const legacyDecompositionKey = roster.resolve(ORCHESTRATOR_GOVERNING_TARGET_KEY);
    assert.equal(legacyDecompositionKey.ok, true);
    assert.equal(legacyDecompositionKey.runtime_role, "worker");

    const worker = roster.resolve(SYNTHETIC_WORKER_TARGET);
    assert.equal(worker.ok, true);
    assert.equal(worker.runtime_role, "worker");
    assert.throws(
      () => worker.loadSnapshot(),
      (error) => {
        assert.equal(error.name, "AcceptedPromptSnapshotError");
        assert.equal(error.reason, "accepted_prompt_manifest_unreadable");
        assert.match(error.detail, /selfimp-roster-empty/);
        return true;
      },
      "loadSnapshot must use the synthetic workflow definition, not decompositionDefinition",
    );

    assert.equal(roster.promotable, false);
    assert.equal(roster.evalAssets.promotable, false);
    assert.equal(roster.evalAssets.reason, "eval_assets_absent");
    assert.deepEqual(
      roster.evalAssets.missing.map(({ asset, repo_relative_path }) => ({ asset, repo_relative_path })),
      [
        { asset: "manifest", repo_relative_path: `${SYNTHETIC_NAMESPACE}/phoenix-assets.json` },
        { asset: "variants", repo_relative_path: `${SYNTHETIC_NAMESPACE}/variants.json` },
      ],
    );
    assert.equal(Object.hasOwn(synthetic, "eval_status"), false);
    assert.equal(Object.hasOwn(roster, "eval_status"), false);
    assert.equal(Object.hasOwn(roster.evalAssets, "eval_status"), false);
  } finally {
    resetRegistry();
    for (const definition of registrySnapshot) registerWorkflow(definition);
    fs.rmSync(tempRepoRoot, { recursive: true, force: true });
    fs.rmSync(manifestOnlyRepoRoot, { recursive: true, force: true });
  }
});

test("decomposition default and explicit workflow roster resolution stay identical", () => {
  const defaultRoster = createOrchestratorRoster();
  const explicitRoster = createOrchestratorRoster({ workflowType: "decomposition" });

  assert.deepEqual(defaultRoster.selectableTargets, explicitRoster.selectableTargets);
  assert.deepEqual(sorted(defaultRoster.selectableTargets), sorted(DECOMPOSITION_SELECTABLE_TARGETS));
  assert.equal(defaultRoster.selectableTargets.includes(ORCHESTRATOR_GOVERNING_TARGET_KEY), false);
  assert.equal(defaultRoster.promotable, true);
  assert.equal(defaultRoster.evalAssets.reason, null);

  const pm = explicitRoster.resolve("prompt/decomposition/pm_product_sufficiency_pass");
  assert.equal(pm.ok, true);
  assert.equal(pm.runtime_role, "pm");
});

function syntheticDefinition() {
  return {
    workflow_type: SYNTHETIC_WORKFLOW_TYPE,
    run: async () => ({ status: "noop" }),
    triggers: [],
    roles: ["worker", "selfimp_roster_judge", "conductor"],
    invocable_runtime_roles: ["worker", "selfimp_roster_judge"],
    runtime_assignment_roles: ["worker", "selfimp_roster_judge", "conductor"],
    engine_owned_evaluator_roles: ["selfimp_roster_judge"],
    driver: "conductor",
    driver_governing_target_key: SYNTHETIC_GOVERNING_TARGET,
    eval_namespace: SYNTHETIC_NAMESPACE,
    commit_effects: [],
    commitPayload: {
      assembleCommitPayload: () => ({}),
      validateCommitPayload: () => ({ ok: true, failureReasons: [] }),
      qualityGateInput: () => null,
    },
    artifact_schema: {
      schema_version: "selfimp-roster-synthetic/v1",
    },
  };
}

function syntheticManifest() {
  return {
    schema_version: 1,
    prompts: [
      promptEntry({
        role: "worker",
        target_key: SYNTHETIC_WORKER_TARGET,
        human_name: "Synthetic worker prompt",
        snapshot_path: `${SYNTHETIC_NAMESPACE}/accepted-prompts/worker.md`,
      }),
      promptEntry({
        role: "conductor",
        target_key: SYNTHETIC_GOVERNING_TARGET,
        human_name: "Synthetic governing prompt",
        snapshot_path: `${SYNTHETIC_NAMESPACE}/accepted-prompts/conductor-governing.md`,
      }),
      promptEntry({
        role: "selfimp_roster_judge",
        target_key: SYNTHETIC_EVALUATOR_TARGET,
        human_name: "Synthetic evaluator prompt",
        snapshot_path: `${SYNTHETIC_NAMESPACE}/accepted-prompts/evaluator.md`,
      }),
      promptEntry({
        role: "worker",
        target_key: ORCHESTRATOR_GOVERNING_TARGET_KEY,
        human_name: "Legacy decomposition key inside synthetic manifest",
        snapshot_path: `${SYNTHETIC_NAMESPACE}/accepted-prompts/legacy-decomposition-key.md`,
      }),
    ],
  };
}

function promptEntry({
  role,
  target_key,
  human_name,
  snapshot_path,
}) {
  return {
    role,
    target_key,
    human_name,
    artifact_kind: "accepted_prompt",
    materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    accepted_tag: "teami_accepted",
    candidate_tag: "teami_promotion_candidate",
    snapshot_path,
    snapshot_sha256: "0".repeat(64),
    prompt_version: "synthetic",
  };
}

function sorted(values) {
  return [...values].sort();
}
