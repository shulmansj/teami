import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentBehaviorScope } from "../../../engine/agent-behavior-scope.mjs";
import { resolveEvalContract } from "../../../engine/eval-annotation-contract.mjs";
import { extractImportSpecifiers } from "./import-graph-helper.mjs";
import {
  resolvePromotionAcceptancePolicyDecision,
  PROMOTION_ACCEPTANCE_DECISIONS,
} from "../src/promotion/acceptance-policy-decision.mjs";
import * as githubClientModule from "../src/github-promotion-client.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";
import { reviewDefinition } from "../src/workflows/review/definition.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "../../../..");
const ENGINE_DIR = path.join(REPO_ROOT, "execution", "engine");
const LINEAR_SRC_DIR = path.join(REPO_ROOT, "execution", "integrations", "linear", "src");
const FORBIDDEN_PROMOTION_ACTION = /merge|ready|approve|review/i;

const REAL_FUNCTIONS = Object.freeze([
  Object.freeze({
    name: "decomposition",
    definition: decompositionDefinition,
    manifestPath: "execution/evals/decomposition/phoenix-assets.json",
    expectedJudgeRole: "decomposition_quality_judge",
    expectedPersonas: ["orchestrator", "pm", "sr_eng"],
  }),
  Object.freeze({
    name: "execution",
    definition: executionDefinition,
    manifestPath: "execution/evals/execution/phoenix-assets.json",
    expectedJudgeRole: "execution_quality_judge",
    expectedPersonas: ["orchestrator", "worker"],
  }),
  Object.freeze({
    name: "review",
    definition: reviewDefinition,
    manifestPath: "execution/evals/review/phoenix-assets.json",
    expectedJudgeRole: "review_quality_judge",
    expectedPersonas: ["orchestrator", "reviewer"],
  }),
]);

test("shared engine loop code has no decomposition implementation coupling", () => {
  const violations = [];
  for (const file of listMjsFiles(ENGINE_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of ["decompositionDefinition", "DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY"]) {
      if (source.includes(symbol)) {
        violations.push(`${toRepoRelativePath(file)} contains ${symbol}`);
      }
    }
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.specifier.includes("workflows/decomposition/definition")) {
        violations.push(
          `${toRepoRelativePath(file)}:${specifier.line} imports ${specifier.specifier}`,
        );
      }
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("one general eval contract resolves a Judge for all three real functions", () => {
  const contracts = REAL_FUNCTIONS.map(({ name, definition, expectedJudgeRole }) => {
    const contract = resolveEvalContract(definition, REPO_ROOT);
    assert.equal(contract.eval_configured, true, `${name} should be eval-configured`);
    assert.equal(contract.reason, null, `${name} should not be eval-deferred`);
    assert.ok(contract.judge_prompt, `${name} should resolve a Judge prompt`);
    assert.equal(contract.judge_prompt.role, expectedJudgeRole);
    assert.equal(
      definition.engine_owned_evaluator_roles.includes(contract.judge_prompt.role),
      true,
      `${name} Judge role must be engine-owned`,
    );
    assert.equal(contract.judge_prompt.evaluator_entry.kind, "llm");
    assert.ok(contract.rich_example_dataset_name, `${name} should declare a rich fixture dataset`);
    return contract;
  });

  assert.deepEqual(
    [...new Set(contracts.map((contract) => contract.roll_up_annotation_name))],
    ["quality"],
  );
  for (const contract of contracts) {
    assert.equal(contract.canonical_annotation_names.includes("quality"), true);
    assert.equal(
      contract.canonical_annotation_names.includes(`${contract.workflow_type}_quality`),
      false,
      `${contract.workflow_type} must not mint a per-function roll-up annotation name`,
    );
  }
});

test("scope classifier exposes exactly adopter personas for every configured function", () => {
  for (const entry of REAL_FUNCTIONS) {
    assert.deepEqual(
      personaRolesFor({
        definition: entry.definition,
        manifest: readJson(entry.manifestPath),
      }),
      entry.expectedPersonas,
      `${entry.name} persona scope drifted`,
    );
  }

  assert.deepEqual(
    personaRolesFor({
      definition: PROBE_SCOPE_DEFINITION,
      manifest: probeManifest(),
    }),
    ["orchestrator", "worker"],
  );
});

test("autonomous promotion acceptance remains HITL-only with no GitHub merge or review endpoint", () => {
  assert.deepEqual(PROMOTION_ACCEPTANCE_DECISIONS, ["route_to_hitl", "blocked"]);
  const decision = resolvePromotionAcceptancePolicyDecision({
    scope: { ok: true },
    packetGuard: { ok: true },
    policy: { policy_version: "acceptance-test" },
  });
  assert.equal(decision.decision, "route_to_hitl");
  assert.equal(decision.auto_acceptance_configured, false);
  assert.equal(decision.reason, "auto_acceptance_policy_not_configured");

  const client = githubClientModule.createGitHubPromotionClient({
    transport: githubClientModule.createDryRunGitHubTransport(),
    repo: { owner: "test-owner", repo: "test-repo" },
  });
  for (const key of Object.keys(client)) {
    assert.equal(
      FORBIDDEN_PROMOTION_ACTION.test(key),
      false,
      `merge/review-shaped client member exposed: ${key}`,
    );
  }

  for (const endpoint of githubClientModule.GITHUB_PROMOTION_ENDPOINT_ALLOWLIST) {
    assert.equal(
      FORBIDDEN_PROMOTION_ACTION.test(`${endpoint.id} ${endpoint.path}`),
      false,
      `merge/review-shaped endpoint allowlisted: ${endpoint.id} ${endpoint.path}`,
    );
    assert.notEqual(endpoint.method, "PUT", "GitHub PR merge endpoint uses PUT");
  }
  for (const exportName of Object.keys(githubClientModule)) {
    assert.equal(
      FORBIDDEN_PROMOTION_ACTION.test(exportName),
      false,
      `merge/review-shaped GitHub promotion export exposed: ${exportName}`,
    );
  }
});

test("reality-check auto-harvesting production arm remains deferred", () => {
  const productionCallers = listMjsFiles(LINEAR_SRC_DIR)
    .filter((file) => path.basename(file) !== "outcome-observation.mjs")
    .filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("outcome-observation.mjs")
        || source.includes("writePhoenixOutcomeObservation")
        || source.includes("readPhoenixOutcomeObservationsByTarget");
    })
    .map(toRepoRelativePath);

  assert.deepEqual(productionCallers, []);
});

function listMjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMjsFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [entryPath] : [];
  });
}

function readJson(repoRelativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...repoRelativePath.split("/")), "utf8"));
}

function personaRolesFor({ definition, manifest }) {
  const scope = createAgentBehaviorScope();
  const roles = new Set();
  const allTargets = [
    ...(Array.isArray(manifest.prompts) ? manifest.prompts : []),
    ...(Array.isArray(manifest.rules) ? manifest.rules : []),
  ];
  const scopedTargets = scope.agentBehaviorTargetsFromManifest({ definition, manifest });

  for (const target of scopedTargets) {
    const classification = scope.classifyAgentBehaviorProposalScope({
      definition,
      candidateTargetKey: target.target_key,
      target,
    });
    assert.equal(classification.ok, true, `${target.target_key} should be adopter-scoped`);
    const binding = scope.adopterSelfImprovementPersonaBinding(target, { definition });
    if (binding) roles.add(binding.persona_role);
  }

  for (const target of allTargets) {
    if (definition.engine_owned_evaluator_roles.includes(target.role)) {
      const classification = scope.classifyAgentBehaviorProposalScope({
        definition,
        candidateTargetKey: target.target_key,
        target,
      });
      assert.equal(classification.ok, false, `${target.role} Judge must not be adopter-tunable`);
      assert.equal(classification.surface, "evaluation_judging_rules");
    }
  }

  const sortedRoles = [...roles].sort();
  assert.equal(sortedRoles.some((role) => /judge|drafter/.test(role)), false);
  assert.equal(allTargets.some((target) => target.role === "drafter"), false);
  return sortedRoles;
}

function toRepoRelativePath(targetPath) {
  return path.relative(REPO_ROOT, targetPath).replace(/\\/g, "/");
}

const PROBE_SCOPE_DEFINITION = Object.freeze({
  workflow_type: "probe",
  driver: "orchestrator",
  driver_governing_target_key: "prompt/probe/orchestrator_governing",
  engine_owned_evaluator_roles: Object.freeze(["probe_judge"]),
});

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
