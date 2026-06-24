import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { parseControlAction } from "../../../engine/orchestrator-control-action.mjs";
import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import {
  readRunArtifact,
  validateRunArtifact,
  writeRunArtifact,
} from "../../../engine/run-store.mjs";
import { canApplyTerminal } from "../../../engine/terminal-gate.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";
import {
  extractImportSpecifiers,
  isBareModuleSpecifier,
  isBuiltinSpecifier,
  isPathInside,
  resolveLocalSpecifier,
} from "./import-graph-helper.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const IMPORT_GRAPH_HELPER_FILE = path.resolve(import.meta.dirname, "import-graph-helper.mjs");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ENGINE_DIR = path.join(REPO_ROOT, "execution", "engine");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "execution", "integrations");
const PROBE_NAMESPACE = "test/fixtures/probe";
const PROBE_FUNCTION_VERSION = "0.0.1";
const PROBE_PAYLOAD_SCHEMA_ID = "probe-run-payload/v1";
const PROBE_RUN_ID = "probe-1";
const GIT_PROVIDER_PATTERN = /git|github|simple-git|nodegit/i;

test("synthetic second function flows through generic engine seams without Linear/git imports", async (t) => {
  const previousDefinitions = registeredWorkflowTypes()
    .map((workflowType) => getWorkflowDefinition(workflowType));
  const effectCalls = [];
  const synthetic = buildSyntheticDefinition({ effectCalls });
  const tempRepoRoot = path.join(
    os.tmpdir(),
    `agentic-factory-s9-repo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const runStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-s9-runs-"));
  const restorePromptFixture = installSyntheticAcceptedPromptFixture({
    repoRoot: tempRepoRoot,
    definition: synthetic,
  });
  t.after(() => {
    restorePromptFixture();
    restoreRegistry(previousDefinitions);
    fs.rmSync(tempRepoRoot, { recursive: true, force: true });
    fs.rmSync(runStoreDir, { recursive: true, force: true });
  });

  resetRegistry();
  registerWorkflow(synthetic);
  assert.equal(getWorkflowDefinition("probe"), synthetic);
  assert.deepEqual(registeredWorkflowTypes(), ["probe"]);

  const namespacePaths = evalNamespacePaths(synthetic);
  assert.deepEqual(namespacePaths, {
    manifest: "test/fixtures/probe/phoenix-assets.json",
    accepted_runtime: "test/fixtures/probe/accepted-runtime-roles.json",
    proposals: "test/fixtures/probe/proposals",
    policy: "test/fixtures/probe/promotion-policy.json",
    variants: "test/fixtures/probe/variants.json",
    taxonomy: "test/fixtures/probe/failure-taxonomy.json",
  });

  assert.deepEqual(synthetic.invocable_runtime_roles, ["worker", "probe_judge"]);
  assert.deepEqual(synthetic.runtime_assignment_roles, ["worker", "probe_judge", "orchestrator"]);
  assert.deepEqual(synthetic.engine_owned_evaluator_roles, ["probe_judge"]);
  assert.equal(
    parseControlAction(validOneOffAction("worker"), {
      invocableRoles: synthetic.invocable_runtime_roles,
    }).ok,
    true,
  );
  assert.deepEqual(
    parseControlAction(validOneOffAction("pm"), {
      invocableRoles: synthetic.invocable_runtime_roles,
    }).reasons,
    ["invoke_one_off_invalid_runtime_role:pm"],
  );

  const roster = inMemoryRoster();
  const runtimeExecutor = fakeRuntimeExecutor();
  const spanSink = captureSpanSink();
  let orchestratorTurns = 0;
  const orchestratorTurnExecutor = async (input) => {
    orchestratorTurns += 1;
    assert.equal(input.definition, synthetic);
    assert.equal(input.roster, roster);
    assert.match(input.governingBody, /Synthetic probe governing body/);
    return {
      controlAction: {
        action: "terminate",
        outcome: "commit",
        reason: "synthesis_complete",
      },
      producedContent: {
        probe_result: "ok",
        context_digest: "The probe function reached a terminal commit outcome.",
        source_refs: [{ kind: "probe_project", id: "project-probe" }],
        assumptions: [],
        constraints: [],
        risks: [],
        project_update_markdown: [
          `run_id: ${PROBE_RUN_ID}`,
          "",
          "Synthetic probe completed.",
        ].join("\n"),
      },
    };
  };

  const result = await runOrchestratorLoop({
    runId: PROBE_RUN_ID,
    wake: { id: "wake-probe", object_id: "project-probe" },
    event: { id: "event-probe" },
    project: { id: "project-probe", name: "Synthetic probe", content: "Probe the generic engine." },
    config: syntheticConfig(),
    repoRoot: tempRepoRoot,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    definition: synthetic,
    commitPayload: synthetic.commitPayload,
    spanSink,
  });

  assert.equal(orchestratorTurns, 1);
  assert.equal(runtimeExecutor.calls.length, 0);
  assert.equal(roster.resolveCalls.length, 0);
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");
  assert.equal(result.output.terminal_output.probe_result, "ok");
  assert.equal(Object.hasOwn(result.output.terminal_output, "final_issues"), false);
  assert.deepEqual(
    validateOrchestratorOutput(result.output, synthetic.commitPayload),
    { ok: true, failureReasons: [] },
  );

  assert.deepEqual(spanSink.subagentTurns, []);
  assert.equal(spanSink.orchestratorTurns.length, 1);
  assert.deepEqual(
    {
      round_index: spanSink.orchestratorTurns[0].round_index,
      action: spanSink.orchestratorTurns[0].action,
      outcome: spanSink.orchestratorTurns[0].outcome,
      reason: spanSink.orchestratorTurns[0].reason,
    },
    {
      round_index: 1,
      action: "terminate",
      outcome: "commit",
      reason: "synthesis_complete",
    },
  );
  assert.deepEqual(
    Object.keys(spanSink.orchestratorTurns[0].run_config.roles).sort(),
    ["orchestrator", "probe_judge", "worker"],
  );
  assert.equal(spanSink.orchestratorTurns[0].run_config.roles.pm, undefined);
  assert.equal(spanSink.orchestratorTurns[0].run_config.roles.sr_eng, undefined);

  assert.deepEqual(result.acceptedRefs.map((ref) => ref.target_key), [
    "prompt/probe/orchestrator_governing",
  ]);
  assert.equal(
    fs.existsSync(path.join(tempRepoRoot, "execution", "evals", "decomposition", "phoenix-assets.json")),
    false,
  );

  const artifact = probeCommitArtifact(result.output);
  assert.equal(Object.hasOwn(artifact, "final_issues"), false);
  assert.equal(Object.hasOwn(artifact.payload, "final_issues"), false);
  assert.equal(
    validateRunArtifact(artifact, {
      functionVersion: PROBE_FUNCTION_VERSION,
      payloadValidator: synthetic.commitPayload,
    }),
    true,
  );
  const durableRecord = writeRunArtifact(
    {
      runId: PROBE_RUN_ID,
      runStoreDir,
      returnDurabilityResult: true,
      functionVersion: PROBE_FUNCTION_VERSION,
      payloadValidator: synthetic.commitPayload,
    },
    artifact,
  );
  const persisted = readRunArtifact({
    runId: PROBE_RUN_ID,
    runStoreDir,
    functionVersion: PROBE_FUNCTION_VERSION,
    payloadValidator: synthetic.commitPayload,
  });
  assert.equal(persisted.payload.probe_result, "ok");
  assert.equal(Object.hasOwn(persisted, "final_issues"), false);
  assert.equal(Object.hasOwn(persisted.payload, "final_issues"), false);

  assert.deepEqual(
    canApplyTerminal({
      terminal_output: result.output.terminal_output,
      bounds: result.output.bounds,
      environment: { agent_write_credentials_present: false },
      durable_record: durableRecord,
      commitPayload: synthetic.commitPayload,
    }),
    { ok: true },
  );
  assert.deepEqual(
    await applyCommitEffects({
      effects: synthetic.commit_effects,
      ctx: {
        runId: PROBE_RUN_ID,
        artifact: persisted,
        durable_record: durableRecord,
      },
    }),
    { ok: true, applied: [{ id: "noop", identity: "x" }] },
  );
  assert.deepEqual(effectCalls.map((call) => call.stage), ["probe", "apply", "verify"]);
});

test("synthetic fixture local import graph is engine-only and provider-free", () => {
  const graph = collectLocalImportGraph(THIS_FILE);
  const violations = graph.edges.flatMap((edge) => classifyGraphEdgeViolation(edge));
  assert.deepEqual(violations, [], formatGraphViolations(violations));

  const localModules = [...graph.modules]
    .filter((modulePath) => modulePath !== THIS_FILE)
    .map((modulePath) => toRepoRelativePath(modulePath))
    .sort();
  assert.ok(localModules.length > 0, "expected the synthetic fixture to import engine modules");
  assert.ok(
    localModules.every((modulePath) =>
      modulePath.startsWith("execution/engine/") ||
      modulePath === "execution/integrations/linear/test/import-graph-helper.mjs"
    ),
    localModules.join("\n"),
  );
});

function buildSyntheticDefinition({ effectCalls }) {
  const commitPayload = {
    assembleCommitPayload(produced) {
      return {
        probe_result: produced?.probe_result ?? "ok",
        project_update_fallback_body: "Synthetic probe completed.",
      };
    },
    validateCommitPayload(candidate) {
      const failureReasons = [];
      if (candidate?.probe_result !== "ok") failureReasons.push("missing_probe_result");
      if (candidate?.final_issues !== undefined) failureReasons.push("unexpected_final_issues");
      return { ok: failureReasons.length === 0, failureReasons };
    },
    qualityGateInput() {
      return null;
    },
  };

  return {
    workflow_type: "probe",
    run: async () => ({ status: "noop" }),
    triggers: [],
    required_capabilities: [],
    roles: ["worker", "probe_judge", "orchestrator"],
    eligibility: async () => ({ eligible: true, project: { id: "project-probe" } }),
    artifact_schema: {
      schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      function_version: PROBE_FUNCTION_VERSION,
      workflow_version: PROBE_FUNCTION_VERSION,
      payload_schema_id: PROBE_PAYLOAD_SCHEMA_ID,
      kinds: ["commit"],
    },
    eval_namespace: PROBE_NAMESPACE,
    driver: "orchestrator",
    driver_governing_target_key: "prompt/probe/orchestrator_governing",
    invocable_runtime_roles: ["worker", "probe_judge"],
    runtime_assignment_roles: ["worker", "probe_judge", "orchestrator"],
    engine_owned_evaluator_roles: ["probe_judge"],
    commit_effects: [
      {
        id: "noop",
        provider: "fake",
        probe(ctx) {
          effectCalls.push({ stage: "probe", ctx });
          return { satisfied: false };
        },
        apply(ctx) {
          effectCalls.push({ stage: "apply", ctx });
          return { ok: true, identity: "x" };
        },
        verify(ctx) {
          effectCalls.push({ stage: "verify", ctx });
          return { ok: true };
        },
      },
    ],
    commitPayload,
  };
}

function validOneOffAction(runtimeRole) {
  return {
    action: "invoke_one_off",
    role_label: "probe-role",
    task: "Probe the role facet.",
    prompt: "Run the synthetic probe.",
    runtime_role: runtimeRole,
  };
}

function inMemoryRoster() {
  const resolveCalls = [];
  return {
    selectableTargets: [],
    resolve(key) {
      resolveCalls.push(key);
      return {
        ok: true,
        runtime_role: "worker",
        loadSnapshot: () => ({ contentBytes: "in-memory probe prompt", snapshotSha256: null }),
      };
    },
    resolveCalls,
  };
}

function fakeRuntimeExecutor() {
  const calls = [];
  return {
    calls,
    async executeSubagent(input) {
      calls.push(input);
      const packet = {
        schema_version: "probe-subagent-turn/v1",
        run_id: input.runId,
        status: "continue",
        reason: "probe_turn_complete",
        context_digest: "Synthetic subagent turn completed.",
        source_refs: [],
        assumptions: [],
        constraints: [],
        risks: [],
      };
      return {
        ok: true,
        packet,
        runtime: "fake",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: JSON.stringify(packet),
        evidence: {},
      };
    },
  };
}

function captureSpanSink() {
  const orchestratorTurns = [];
  const subagentTurns = [];
  return {
    orchestratorTurns,
    subagentTurns,
    recordOrchestratorTurn(span) {
      orchestratorTurns.push(JSON.parse(JSON.stringify(span)));
    },
    recordSubagentTurn(span) {
      subagentTurns.push(JSON.parse(JSON.stringify(span)));
    },
  };
}

function syntheticConfig() {
  return {
    workflows: {
      probe: {
        roles: {
          worker: { runtime: "fake", model: "worker-model" },
          probe_judge: { runtime: "fake", model: "judge-model" },
          orchestrator: { runtime: "fake", model: "driver-model" },
        },
        role_field_sources: {
          worker: { runtime: "accepted_defaults", model: "accepted_defaults" },
          probe_judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
          orchestrator: { runtime: "accepted_defaults", model: "accepted_defaults" },
        },
        accepted_runtime_defaults_ref: {
          target_key: "rule/probe/runtime_role_assignments",
          accepted_baseline_id: "sha256:probe-runtime",
          snapshot_sha256: "probe-runtime",
        },
      },
    },
  };
}

function installSyntheticAcceptedPromptFixture({ repoRoot, definition }) {
  const paths = evalNamespacePaths(definition);
  const promptRelativePath = `${PROBE_NAMESPACE}/accepted-prompts/orchestrator-governing.md`;
  const snapshotText = [
    "# Accepted Probe Orchestrator Governing Prompt",
    "",
    "```yaml",
    "prompt_version: synthetic",
    "phoenix_prompt_role: orchestrator",
    "target_key: prompt/probe/orchestrator_governing",
    "```",
    "",
    "## Instructions",
    "",
    "Synthetic probe governing body.",
    "",
  ].join("\n");
  const snapshotSha256 = createHash("sha256").update(snapshotText).digest("hex");
  const manifest = {
    schema_version: 1,
    prompts: [
      {
        role: "orchestrator",
        target_key: definition.driver_governing_target_key,
        human_name: "Probe orchestrator governing prompt",
        artifact_kind: "accepted_prompt",
        materializer: "synthetic_test_fixture",
        accepted_prompt_version_id: null,
        snapshot_path: promptRelativePath,
        snapshot_sha256: snapshotSha256,
        prompt_version: "synthetic",
      },
    ],
  };
  const manifestPath = path.resolve(repoRoot, paths.manifest);
  const snapshotPath = path.resolve(repoRoot, promptRelativePath);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const originalReadFileSync = fs.readFileSync;

  fs.readFileSync = (target, ...args) => {
    const targetPath = path.resolve(String(target));
    if (targetPath === manifestPath) {
      return typeof args[0] === "string" ? manifestText : Buffer.from(manifestText, "utf8");
    }
    if (targetPath === snapshotPath) {
      return typeof args[0] === "string" ? snapshotText : Buffer.from(snapshotText, "utf8");
    }
    return originalReadFileSync(target, ...args);
  };

  return () => {
    fs.readFileSync = originalReadFileSync;
  };
}

function probeCommitArtifact(runResult) {
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: PROBE_FUNCTION_VERSION,
    run_id: PROBE_RUN_ID,
    domain_id: "d",
    workspace_id: "w",
    team_id: "t",
    kind: "commit",
    runtime_assignments: {},
    runtime_metadata: {},
    bounds: runResult.bounds,
    evidence: runResult.evidence,
    payload_schema_id: PROBE_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: runResult.terminal_output,
      probe_result: runResult.terminal_output.probe_result,
    },
  };
}

function restoreRegistry(definitions) {
  resetRegistry();
  for (const definition of definitions) registerWorkflow(definition);
}

function collectLocalImportGraph(rootFile) {
  const modules = new Set();
  const edges = [];
  const queue = [path.resolve(rootFile)];
  for (let index = 0; index < queue.length; index += 1) {
    const modulePath = queue[index];
    if (modules.has(modulePath)) continue;
    modules.add(modulePath);
    const source = fs.readFileSync(modulePath, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      const edge = {
        from: modulePath,
        line: specifier.line,
        kind: specifier.kind,
        specifier: specifier.specifier,
        resolved: null,
      };
      const resolved = resolveLocalSpecifier({
        specifier: specifier.specifier,
        modulePath,
      });
      if (resolved) {
        edge.resolved = resolved;
        if (fs.existsSync(resolved) && isPathInside(resolved, ENGINE_DIR)) {
          queue.push(resolved);
        }
      }
      edges.push(edge);
    }
  }
  return { modules, edges };
}

function classifyGraphEdgeViolation(edge) {
  if (edge.specifier === "node:child_process" || edge.specifier === "child_process") {
    return [{ ...edge, reason: "child_process_import" }];
  }

  if (edge.resolved) {
    if (edge.resolved === IMPORT_GRAPH_HELPER_FILE) return [];
    if (isPathInside(edge.resolved, INTEGRATIONS_DIR)) {
      return [{ ...edge, reason: "provider_tree_import" }];
    }
    if (!isPathInside(edge.resolved, ENGINE_DIR)) {
      return [{ ...edge, reason: "local_import_outside_engine" }];
    }
    return [];
  }

  if (isBuiltinSpecifier(edge.specifier)) return [];
  if (isBareModuleSpecifier(edge.specifier) && GIT_PROVIDER_PATTERN.test(edge.specifier)) {
    return [{ ...edge, reason: "git_provider_import" }];
  }
  if (isBareModuleSpecifier(edge.specifier)) {
    return [{ ...edge, reason: "external_module_import" }];
  }
  return [];
}

function formatGraphViolations(violations) {
  if (violations.length === 0) return "expected no synthetic import graph violations";
  return violations
    .map((violation) => {
      const resolved = violation.resolved ? ` -> ${toRepoRelativePath(violation.resolved)}` : "";
      return `${toRepoRelativePath(violation.from)}:${violation.line} imports ${violation.specifier}${resolved} (${violation.reason})`;
    })
    .join("\n");
}

function toRepoRelativePath(targetPath) {
  return path.relative(REPO_ROOT, targetPath).replace(/\\/g, "/");
}
