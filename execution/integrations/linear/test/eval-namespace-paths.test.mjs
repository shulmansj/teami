import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import {
  ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
} from "../src/config.mjs";
import {
  ANNOTATION_SCHEMA_PATH,
  EXAMPLE_SCHEMA_PATH,
  FAILURE_TAXONOMY_PATH,
  PHOENIX_ASSETS_PATH,
} from "../src/eval-annotation-contract.mjs";
import {
  DEFAULT_EVAL_VARIANTS_PATH,
} from "../src/decomposition-eval-cli.mjs";
import {
  PROMOTION_POLICY_PATH,
  PROMOTION_POLICY_RELATIVE_PATH,
  resolvePromotionPolicyPath,
} from "../src/promotion-policy.mjs";
import {
  PROTECTED_SLOTS,
} from "../src/meta-change-classifier.mjs";
import {
  WORKSPACE_EVAL_POLICY_PATH,
} from "../src/workspace-eval-policy.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import {
  DECOMPOSITION_EVAL_NAMESPACE,
  DECOMPOSITION_EVAL_PATHS,
  decompositionEvalNamespacePath,
  resolveDecompositionEvalPath,
} from "../src/workflows/decomposition/eval-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

const legacyEvalPaths = Object.freeze({
  manifest: "execution/evals/decomposition/phoenix-assets.json",
  annotation_schema: "execution/evals/decomposition/annotation.schema.json",
  example_schema: "execution/evals/decomposition/example.schema.json",
  accepted_runtime: "execution/evals/decomposition/accepted-runtime-roles.json",
  proposals: "execution/evals/decomposition/proposals",
  policy: "execution/evals/decomposition/promotion-policy.json",
  variants: "execution/evals/decomposition/variants.json",
  taxonomy: "execution/evals/decomposition/failure-taxonomy.json",
});

const legacyNamespacePaths = Object.freeze({
  readme: "execution/evals/decomposition/readme.md",
  workspace_policy: "execution/evals/decomposition/workspace-eval-policy.json",
  example_schema: "execution/evals/decomposition/example.schema.json",
  annotation_schema: "execution/evals/decomposition/annotation.schema.json",
  proposal_template: "execution/evals/decomposition/templates/process-change-proposal.md",
  judge_prompt: "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md",
  rubrics_prefix: "execution/evals/decomposition/rubrics/",
  pm_product_sufficiency_prompt:
    "execution/evals/decomposition/accepted-prompts/pm-product-sufficiency-pass.md",
  pm_synthesis_prompt: "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
  sr_eng_grounding_prompt: "execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md",
  sr_eng_blocker_prompt: "execution/evals/decomposition/accepted-prompts/sr-eng-blocker-check.md",
});

test("evalNamespacePaths preserves legacy decomposition repo-relative literals", () => {
  assert.deepEqual(evalNamespacePaths(decompositionDefinition), legacyEvalPaths);
  assert.deepEqual(DECOMPOSITION_EVAL_PATHS, legacyEvalPaths);
  assert.equal(DECOMPOSITION_EVAL_NAMESPACE, "execution/evals/decomposition");
});

test("derived namespace siblings preserve legacy repo-relative literals", () => {
  assert.equal(decompositionEvalNamespacePath("readme.md"), legacyNamespacePaths.readme);
  assert.equal(
    decompositionEvalNamespacePath("workspace-eval-policy.json"),
    legacyNamespacePaths.workspace_policy,
  );
  assert.equal(decompositionEvalNamespacePath("example.schema.json"), legacyNamespacePaths.example_schema);
  assert.equal(decompositionEvalNamespacePath("annotation.schema.json"), legacyNamespacePaths.annotation_schema);
  assert.equal(
    decompositionEvalNamespacePath("templates/process-change-proposal.md"),
    legacyNamespacePaths.proposal_template,
  );
  assert.equal(
    decompositionEvalNamespacePath("accepted-prompts/decomposition-quality-judge.md"),
    legacyNamespacePaths.judge_prompt,
  );
  assert.equal(`${DECOMPOSITION_EVAL_NAMESPACE}/rubrics/`, legacyNamespacePaths.rubrics_prefix);
  assert.equal(
    decompositionEvalNamespacePath("accepted-prompts/pm-product-sufficiency-pass.md"),
    legacyNamespacePaths.pm_product_sufficiency_prompt,
  );
  assert.equal(
    decompositionEvalNamespacePath("accepted-prompts/pm-synthesis.md"),
    legacyNamespacePaths.pm_synthesis_prompt,
  );
  assert.equal(
    decompositionEvalNamespacePath("accepted-prompts/sr-eng-grounding-pass.md"),
    legacyNamespacePaths.sr_eng_grounding_prompt,
  );
  assert.equal(
    decompositionEvalNamespacePath("accepted-prompts/sr-eng-blocker-check.md"),
    legacyNamespacePaths.sr_eng_blocker_prompt,
  );
});

test("migrated public path exports preserve legacy absolute and relative paths", () => {
  assert.equal(ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH, legacyEvalPaths.accepted_runtime);
  assert.equal(PROMOTION_POLICY_RELATIVE_PATH, legacyEvalPaths.policy);

  assert.equal(PHOENIX_ASSETS_PATH, legacyAbsolute(legacyEvalPaths.manifest));
  assert.equal(FAILURE_TAXONOMY_PATH, legacyAbsolute(legacyEvalPaths.taxonomy));
  assert.equal(ANNOTATION_SCHEMA_PATH, legacyAbsolute(legacyEvalPaths.annotation_schema));
  assert.equal(EXAMPLE_SCHEMA_PATH, legacyAbsolute(legacyEvalPaths.example_schema));
  assert.equal(PROMOTION_POLICY_PATH, legacyAbsolute(legacyEvalPaths.policy));
  assert.equal(DEFAULT_EVAL_VARIANTS_PATH, legacyAbsolute(legacyEvalPaths.variants));
  assert.equal(WORKSPACE_EVAL_POLICY_PATH, legacyAbsolute(legacyNamespacePaths.workspace_policy));
  assert.equal(
    resolveDecompositionEvalPath(repoRoot, legacyEvalPaths.manifest),
    legacyAbsolute(legacyEvalPaths.manifest),
  );
});

test("classifier eval-path projection preserves legacy classifier paths", () => {
  const exactPaths = new Set(PROTECTED_SLOTS.exact_paths.map((entry) => entry.path));
  for (const legacyPath of [
    legacyNamespacePaths.readme,
    legacyEvalPaths.policy,
    legacyNamespacePaths.workspace_policy,
    legacyEvalPaths.variants,
    legacyEvalPaths.taxonomy,
    legacyEvalPaths.example_schema,
    legacyEvalPaths.annotation_schema,
    legacyNamespacePaths.proposal_template,
    legacyNamespacePaths.judge_prompt,
    legacyEvalPaths.accepted_runtime,
    legacyEvalPaths.manifest,
  ]) {
    assert.equal(exactPaths.has(legacyPath), true, legacyPath);
  }
  assert.equal(
    PROTECTED_SLOTS.prefix_paths.some((entry) => entry.prefix === legacyNamespacePaths.rubrics_prefix),
    true,
  );
});

test("promotion policy path resolver returns absolute and trusted relative forms", () => {
  assert.deepEqual(resolvePromotionPolicyPath(decompositionDefinition, repoRoot), {
    path: legacyAbsolute(legacyEvalPaths.policy),
    relativePath: legacyEvalPaths.policy,
  });
});

function legacyAbsolute(repoRelativePath) {
  return path.join(repoRoot, ...repoRelativePath.split("/"));
}
