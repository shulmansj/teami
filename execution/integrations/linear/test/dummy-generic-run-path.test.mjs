import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyCommitEffects,
  deliverableProducesIdentity,
} from "../../../engine/commit-effects.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { materializeRunContext } from "../../../engine/materialize.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { resetResourceRegistry } from "../../../engine/resource-registry.mjs";
import {
  readRunArtifact,
  writeRunArtifact,
} from "../../../engine/run-store.mjs";
import { canApplyTerminal } from "../../../engine/terminal-gate.mjs";
import {
  getWorkflowDefinition,
  registerWorkflow,
  registeredWorkflowTypes,
  resetRegistry,
} from "../../../engine/workflow-registry.mjs";
import { createOrchestratorRoster } from "../src/orchestrator-roster.mjs";
import { resolveMaterializerTarget } from "../src/promotion-materializer.mjs";
import { isAdopterSelfImprovementTarget } from "../src/promotion/agent-behavior-scope.mjs";
import {
  DUMMY_VALUE,
  registerDummyResourceKind,
} from "./dummy-resource-kind.mjs";

const DUMMY_WORKFLOW_TYPE = "dummy_no_identity";
const DUMMY_NAMESPACE = "execution/evals/dummy-no-identity";
const DUMMY_GOVERNING_TARGET = "prompt/dummy_no_identity/orchestrator_governing";
const DUMMY_WORKER_TARGET = "prompt/dummy_no_identity/worker";
const DUMMY_EFFECT_ID = "dummy_publish";
const DUMMY_FUNCTION_VERSION = "dummy-no-identity/v1";
const DUMMY_PAYLOAD_SCHEMA_ID = "dummy-no-identity-run-payload/v1";
const DUMMY_RUN_ID = "dummy_run_no_identity";
const DUMMY_RESOURCE_ID = "dummy-resource";

test("dummy no-identity deliverable flows materialize, cwd loop, resource ctx, and non-promotable target", async () => {
  const registrySnapshot = snapshotWorkflowRegistry();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-dummy-run-"));
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-dummy-cwd-"));
  const publishedPath = path.join(workingDir, "published.txt");
  const runStoreDir = path.join(repoRoot, ".teami", "runs");
  const effectCalls = [];
  let materialized = null;

  try {
    resetResourceRegistry();
    registerDummyResourceKind();
    const definition = dummyDefinition();
    registerWorkflow(definition);
    const manifest = writeDummyAcceptedPromptFixture({ repoRoot, definition });

    materialized = await materializeRunContext({
      domainContext: {
        resources: [dummyResource({ workingDir, publishedPath })],
      },
      runId: DUMMY_RUN_ID,
      engineRepoRoot: repoRoot,
    });
    const { runContext } = materialized;
    const dummyHandle = runContext.selectedResource.handle;
    assert.equal(materialized.materialized, true);
    assert.equal(runContext.selectedResourceId, DUMMY_RESOURCE_ID);
    assert.equal(runContext.selectedResource, runContext.resources[DUMMY_RESOURCE_ID]);
    assert.equal(dummyHandle.read(), DUMMY_VALUE);
    assert.equal(dummyHandle.workingDir, workingDir);
    assert.equal(dummyHandle.publishedPath, publishedPath);
    assert.deepEqual(dummyHandle.envAugment, { DUMMY_ENV: "bound-to-dummy-resource" });
    assert.equal(runContext.cwd, workingDir);
    assert.deepEqual(runContext.envAugment, { DUMMY_ENV: "bound-to-dummy-resource" });
    assert.deepEqual(runContext.resourceManifest, [{
      kind: "dummy",
      id: DUMMY_RESOURCE_ID,
      role: "primary",
      label: "dummy-fixture",
    }]);

    const roster = createOrchestratorRoster({
      workflowType: DUMMY_WORKFLOW_TYPE,
      repoRoot,
    });
    assert.deepEqual(roster.selectableTargets, [DUMMY_WORKER_TARGET]);
    assert.equal(roster.resolve(DUMMY_GOVERNING_TARGET).reason, "orchestrator_roster_target_not_selectable");
    assert.equal(roster.promotable, false);
    assert.equal(roster.evalAssets.reason, "eval_assets_absent");
    assert.deepEqual(
      roster.evalAssets.missing.map(({ asset, repo_relative_path }) => ({ asset, repo_relative_path })),
      [{ asset: "variants", repo_relative_path: `${DUMMY_NAMESPACE}/variants.json` }],
    );
    assert.equal(Object.hasOwn(roster.evalAssets, "eval_status"), false);

    const targetResolution = resolveMaterializerTarget({
      manifest,
      candidateTargetKey: DUMMY_WORKER_TARGET,
    });
    assert.equal(targetResolution.ok, true);
    assert.equal(targetResolution.target.target_key, DUMMY_WORKER_TARGET);
    assert.equal(targetResolution.target.manifest_path, `${DUMMY_NAMESPACE}/phoenix-assets.json`);
    assert.equal(isAdopterSelfImprovementTarget(targetResolution.target), true);

    const runtimeExecutor = recordingRuntimeExecutor({ workingDir });
    const orchestratorTurns = [];
    const loopResult = await runOrchestratorLoop({
      runId: DUMMY_RUN_ID,
      wake: { id: "wake-dummy", object_id: DUMMY_RESOURCE_ID },
      event: { id: "event-dummy", provider: "dummy" },
      project: {
        id: DUMMY_RESOURCE_ID,
        name: "Dummy no-identity publish",
        content: "Publish a dummy payload without producing a resource identity.",
      },
      config: dummyConfig(),
      runtimeExecutor,
      orchestratorTurnExecutor: dummyOrchestratorTurnExecutor({ orchestratorTurns }),
      roster,
      definition,
      commitPayload: definition.commitPayload,
      repoRoot,
      cwd: dummyHandle.workingDir,
      envAugment: dummyHandle.envAugment,
    });

    assert.equal(orchestratorTurns.length, 2);
    assert.ok(orchestratorTurns[0].governingBody.includes("Dummy no-identity governing prompt"));
    assert.equal(orchestratorTurns[0].cwd, workingDir);
    assert.deepEqual(orchestratorTurns[0].envAugment, { DUMMY_ENV: "bound-to-dummy-resource" });
    assert.equal(runtimeExecutor.calls.length, 1);
    assert.equal(runtimeExecutor.calls[0].cwd, workingDir);
    assert.deepEqual(runtimeExecutor.calls[0].envAugment, { DUMMY_ENV: "bound-to-dummy-resource" });
    assert.deepEqual(loopResult.environment, { agent_write_credentials_present: false });
    assert.deepEqual(
      validateOrchestratorOutput(loopResult.output, definition.commitPayload),
      { ok: true, failureReasons: [] },
    );
    assert.equal(loopResult.output.terminal_output.outcome, "commit");
    assert.equal(loopResult.output.terminal_output.published_body, "dummy payload from the real loop");
    assert.deepEqual(loopResult.acceptedRefs.map((ref) => ref.target_key), [DUMMY_GOVERNING_TARGET]);
    assert.deepEqual(loopResult.output.artifact_set_lineage.source_refs, [{
      kind: "dummy",
      id: DUMMY_RESOURCE_ID,
    }]);

    const artifact = dummyCommitArtifact({
      runResult: loopResult.output,
      environment: loopResult.environment,
      acceptedRefs: loopResult.acceptedRefs,
      runContext,
    });
    const durableRecord = writeRunArtifact(
      {
        runId: DUMMY_RUN_ID,
        runStoreDir,
        returnDurabilityResult: true,
        functionVersion: DUMMY_FUNCTION_VERSION,
        payloadSchemaId: DUMMY_PAYLOAD_SCHEMA_ID,
        payloadValidator: definition.commitPayload,
        requireTerminalAudit: true,
      },
      artifact,
    );
    const persisted = readRunArtifact({
      runId: DUMMY_RUN_ID,
      runStoreDir,
      functionVersion: DUMMY_FUNCTION_VERSION,
      payloadSchemaId: DUMMY_PAYLOAD_SCHEMA_ID,
      payloadValidator: definition.commitPayload,
      requireTerminalAudit: true,
    });
    assert.equal(persisted.payload.published_body, "dummy payload from the real loop");
    assert.deepEqual(
      canApplyTerminal({
        terminal_output: persisted.terminal_output,
        bounds: persisted.bounds,
        environment: persisted.environment,
        durable_record: durableRecord,
        commitPayload: definition.commitPayload,
      }),
      { ok: true },
    );

    const trace = { name: "dummy_no_identity_run", attributes: {}, spans: [], annotations: [] };
    const applyResult = await applyCommitEffects({
      effects: [dummyPublishEffect({ effectCalls })],
      ctx: {
        runId: DUMMY_RUN_ID,
        artifact: persisted,
        payload: persisted.payload,
        runContext,
        resources: runContext.resources,
        resourceManifest: runContext.resourceManifest,
        artifactSetLineage: persisted.artifact_set_lineage,
      },
      trace,
    });

    assert.equal(applyResult.outcome, "ok");
    assert.deepEqual(effectCalls.map((call) => call.stage), ["probe", "apply", "verify"]);
    assert.deepEqual(applyResult.produced_identities, []);
    assert.equal(deliverableProducesIdentity(applyResult.applied), false);
    assert.equal(applyResult.applied[0].id, DUMMY_EFFECT_ID);
    assert.equal(applyResult.applied[0].identity, undefined);
    assert.equal(fs.readFileSync(publishedPath, "utf8"), "dummy payload from the real loop");
    assert.deepEqual(
      trace.spans.map((span) => ({ name: span.name, effect_id: span.attributes.effect_id, outcome: span.attributes.outcome })),
      [
        { name: "commit_effect_probe", effect_id: DUMMY_EFFECT_ID, outcome: "not_satisfied" },
        { name: "commit_effect_apply", effect_id: DUMMY_EFFECT_ID, outcome: "ok" },
        { name: "commit_effect_verify", effect_id: DUMMY_EFFECT_ID, outcome: "ok" },
      ],
    );
    assert.equal(Object.hasOwn(trace.attributes, "teami.produced_identities"), false);
  } finally {
    await materialized?.teardownAll?.();
    resetResourceRegistry();
    restoreWorkflowRegistry(registrySnapshot);
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

function dummyDefinition() {
  const commitPayload = {
    assembleCommitPayload(produced, ctx = {}) {
      return {
        project_update_fallback_body: ctx.projectUpdateFallbackBody("Dummy publish completed."),
        published_body: stringOrFallback(produced?.published_body, "dummy payload from the real loop"),
      };
    },
    validateCommitPayload(candidate) {
      const failureReasons = [];
      if (typeof candidate?.published_body !== "string" || candidate.published_body.trim() === "") {
        failureReasons.push("missing_published_body");
      }
      return { ok: failureReasons.length === 0, failureReasons };
    },
    qualityGateInput() {
      return null;
    },
  };

  return {
    workflow_type: DUMMY_WORKFLOW_TYPE,
    trace_descriptor: {
      trace_name: "dummy_no_identity_run",
      attribute_keys: [
        "workflow.name",
        "workflow.version",
        "resource.kind",
        "resource.id",
        "resource.label",
        "run_id",
      ],
    },
    run: async () => ({ status: "noop" }),
    triggers: [],
    roles: ["worker", "orchestrator"],
    invocable_runtime_roles: ["worker"],
    runtime_assignment_roles: ["worker", "orchestrator"],
    engine_owned_evaluator_roles: [],
    driver: "orchestrator",
    driver_governing_target_key: DUMMY_GOVERNING_TARGET,
    eval_namespace: DUMMY_NAMESPACE,
    commit_effects: [{
      id: DUMMY_EFFECT_ID,
      provider: "dummy",
      op: "publish_text",
    }],
    outcome_observations: [],
    commitPayload,
    artifact_schema: {
      schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      function_version: DUMMY_FUNCTION_VERSION,
      workflow_version: DUMMY_FUNCTION_VERSION,
      payload_schema_id: DUMMY_PAYLOAD_SCHEMA_ID,
      kinds: ["commit"],
    },
  };
}

function dummyResource({ workingDir, publishedPath }) {
  return {
    id: DUMMY_RESOURCE_ID,
    kind: "dummy",
    role: "primary",
    binding: {
      fixture: "no-identity-generic-run",
      workingDir,
      publishedPath,
      envAugment: {
        DUMMY_ENV: "bound-to-dummy-resource",
      },
    },
  };
}

function writeDummyAcceptedPromptFixture({ repoRoot, definition }) {
  const namespacePaths = evalNamespacePaths(definition);
  const manifestPath = path.join(repoRoot, ...namespacePaths.manifest.split("/"));
  const promptDir = path.join(repoRoot, ...DUMMY_NAMESPACE.split("/"), "accepted-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const governingSnapshotPath = path.join(promptDir, "orchestrator-governing.md");
  const governingSnapshot = [
    "# Dummy No-Identity Orchestrator",
    "",
    "```yaml",
    "prompt_version: dummy-test",
    "phoenix_prompt_role: orchestrator",
    `target_key: ${DUMMY_GOVERNING_TARGET}`,
    "```",
    "",
    "## Instructions",
    "",
    "Dummy no-identity governing prompt. Invoke the worker once, then commit the dummy payload.",
    "",
  ].join("\n");
  fs.writeFileSync(governingSnapshotPath, governingSnapshot, "utf8");
  const governingSha256 = createHash("sha256").update(governingSnapshot).digest("hex");
  const manifest = {
    schema_version: 1,
    prompts: [
      {
        role: "orchestrator",
        target_key: DUMMY_GOVERNING_TARGET,
        human_name: "Dummy no-identity governing prompt",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        snapshot_path: `${DUMMY_NAMESPACE}/accepted-prompts/orchestrator-governing.md`,
        snapshot_sha256: governingSha256,
        prompt_version: "dummy-test",
        manifest_path: namespacePaths.manifest,
      },
      {
        role: "worker",
        target_key: DUMMY_WORKER_TARGET,
        human_name: "Dummy worker prompt",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        candidate_tag: "teami_promotion_candidate",
        snapshot_path: `${DUMMY_NAMESPACE}/accepted-prompts/worker.md`,
        snapshot_sha256: "0".repeat(64),
        prompt_version: "dummy-test",
        manifest_path: namespacePaths.manifest,
      },
    ],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function dummyConfig() {
  return {
    workflows: {
      [DUMMY_WORKFLOW_TYPE]: {
        roles: {
          worker: { runtime: "fake", model: "dummy-worker-model" },
          orchestrator: { runtime: "fake", model: "dummy-orchestrator-model" },
        },
      },
    },
  };
}

function recordingRuntimeExecutor({ workingDir }) {
  const calls = [];
  return {
    calls,
    async executeSubagent(input) {
      calls.push({
        cwd: input.cwd,
        envAugment: input.envAugment,
        runtime_role: input.runtime_role,
      });
      assert.equal(input.cwd, workingDir);
      const packet = {
        schema_version: "dummy-subagent-turn/v1",
        run_id: input.runId,
        status: "continue",
        reason: "dummy_worker_checked",
        context_digest: "The dummy worker checked the materialized resource.",
        source_refs: [{ kind: "dummy", id: DUMMY_RESOURCE_ID }],
        assumptions: [],
        constraints: [],
        risks: [],
      };
      const raw = JSON.stringify(packet);
      return {
        ok: true,
        packet,
        runtime: "fake",
        parse_status: "valid",
        clean_parse: true,
        prompt: input.prompt,
        raw_output: raw,
        raw_output_excerpt: raw,
        evidence: {
          tool_events: [{
            tool: "dummy_worker",
            event: "checked",
            target: DUMMY_RESOURCE_ID,
          }],
        },
      };
    },
  };
}

function dummyOrchestratorTurnExecutor({ orchestratorTurns }) {
  let turn = 0;
  return async (input) => {
    turn += 1;
    orchestratorTurns.push({
      cwd: input.cwd,
      envAugment: input.envAugment,
      governingBody: input.governingBody,
    });
    if (turn === 1) {
      const controlAction = {
        action: "invoke_one_off",
        role_label: "dummy-worker",
        task: "Check the dummy materialized resource.",
        prompt: "Read the dummy resource and report that it is available.",
        runtime_role: "worker",
      };
      return {
        prompt: "Dummy orchestrator turn 1",
        raw_output: JSON.stringify({ control_action: controlAction }),
        controlAction,
        producedContent: {
          context_digest: "The dummy worker was invoked to prove the cwd seam.",
          source_refs: [{ kind: "dummy", id: DUMMY_RESOURCE_ID }],
          assumptions: [],
          constraints: [],
          risks: [],
        },
      };
    }

    const controlAction = {
      action: "terminate",
      outcome: "commit",
      reason: "synthesis_complete",
    };
    return {
      prompt: "Dummy orchestrator turn 2",
      raw_output: JSON.stringify({ control_action: controlAction }),
      controlAction,
      producedContent: {
        context_digest: "The dummy publish payload is ready.",
        source_refs: [{ kind: "dummy", id: DUMMY_RESOURCE_ID }],
        assumptions: [],
        constraints: [],
        risks: [],
        published_body: "dummy payload from the real loop",
      },
    };
  };
}

function dummyCommitArtifact({
  runResult,
  environment,
  acceptedRefs,
  runContext,
}) {
  const terminalOutput = runResult.terminal_output;
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: DUMMY_FUNCTION_VERSION,
    workflow_version: DUMMY_FUNCTION_VERSION,
    kind: "commit",
    run_id: DUMMY_RUN_ID,
    domain_id: "dummy-domain",
    workspace_id: "workspace-1",
    team_id: "team-1",
    terminal_output: terminalOutput,
    evidence: runResult.evidence,
    bounds: runResult.bounds,
    environment,
    runtime_assignments: {},
    runtime_metadata: {},
    payload_schema_id: DUMMY_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: terminalOutput,
      published_body: terminalOutput.published_body,
      resource_manifest: runContext.resourceManifest,
    },
    resource_manifest: runContext.resourceManifest,
    accepted_refs: acceptedRefs,
    artifact_set_lineage: runResult.artifact_set_lineage,
    completed_at: "2026-06-26T00:00:00.000Z",
    execution_mode: "eval",
  };
}

function dummyPublishEffect({ effectCalls }) {
  return {
    id: DUMMY_EFFECT_ID,
    provider: "dummy",
    op: "publish_text",
    probe(ctx) {
      effectCalls.push({ stage: "probe", resourceId: ctx.runContext?.selectedResource?.id || null });
      return { satisfied: false };
    },
    apply(ctx) {
      const bound = ctx.runContext?.selectedResource;
      const handle = bound?.handle;
      effectCalls.push({ stage: "apply", resourceId: bound?.id || null });
      assert.equal(bound?.id, DUMMY_RESOURCE_ID);
      assert.equal(handle?.read(), DUMMY_VALUE);
      assert.equal(ctx.resourceManifest[0].label, "dummy-fixture");
      fs.writeFileSync(handle.publishedPath, ctx.payload.published_body, "utf8");
      return { ok: true };
    },
    verify(ctx) {
      effectCalls.push({ stage: "verify", resourceId: ctx.runContext?.selectedResource?.id || null });
      const published = fs.readFileSync(ctx.runContext.selectedResource.handle.publishedPath, "utf8");
      return { ok: published === ctx.payload.published_body };
    },
  };
}

function snapshotWorkflowRegistry() {
  return registeredWorkflowTypes().map((workflowType) => getWorkflowDefinition(workflowType));
}

function restoreWorkflowRegistry(definitions) {
  resetRegistry();
  for (const definition of definitions) registerWorkflow(definition);
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}
