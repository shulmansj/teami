import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import { createAgentBehaviorScope } from "../../../engine/agent-behavior-scope.mjs";
import {
  ENGINE_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { resolveEvalContract } from "../../../engine/eval-annotation-contract.mjs";
import { evalNamespacePaths } from "../../../engine/eval-namespace.mjs";
import { parseControlAction } from "../../../engine/orchestrator-control-action.mjs";
import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import {
  PRODUCED_IDENTITIES_TRACE_ATTRIBUTE,
  projectAndAttachProducedIdentities,
} from "../../../engine/produced-identities.mjs";
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
const APP_HOME_FILE = path.join(INTEGRATIONS_DIR, "linear", "src", "app-home.mjs");
const LINEAR_SRC_DIR = path.resolve(import.meta.dirname, "..", "src");
const PROBE_NAMESPACE = "test/fixtures/probe";
const PROBE_FUNCTION_VERSION = "0.0.1";
const PROBE_PAYLOAD_SCHEMA_ID = "probe-run-payload/v1";
const PROBE_RUN_ID = "probe-1";
const PROBE_TRACE_ID = "11111111111111111111111111111111";
const PROBE_OBSERVED_AT = "2026-06-26T12:00:00.000Z";
const PROBE_WORKER_TARGET_KEY = "prompt/probe/worker";
const PROBE_JUDGE_TARGET_KEY = "prompt/probe/probe_judge";
const PROBE_DATASET_NAME = "teami-probe-examples";
const PROBE_CANDIDATE_PROMPT_VERSION_ID = "PV-PROBE-DRAFT";
const PROBE_CANDIDATE_PROMPT_ID = "P-PROBE-WORKER";
const GIT_PROVIDER_PATTERN = /git|github|simple-git|nodegit/i;

function runtimePromptFromCommand(command) {
  if (typeof command.stdinInput === "string") return command.stdinInput;
  const index = command.args.indexOf("-p");
  if (index >= 0) {
    const promptArg = command.args[index + 1];
    if (typeof promptArg === "string" && promptArg.startsWith("@")) {
      return fs.readFileSync(promptArg.slice(1), "utf8");
    }
    return promptArg;
  }
  return command.args.at(-1);
}

test("synthetic second function inherits in-loop tracing, lineage, produced identities, and outcomes by declaration", async (t) => {
  const previousDefinitions = registeredWorkflowTypes()
    .map((workflowType) => getWorkflowDefinition(workflowType));
  const effectCalls = [];
  const synthetic = buildSyntheticDefinition({ effectCalls });
  const {
    createOrchestratorTurnTraceSink,
  } = await importLinearSrcModule("orchestrator-turn-trace-sink.mjs");
  const {
    buildPhoenixOtlpTraceExport,
  } = await importLinearSrcModule("local-phoenix-trace-sink.mjs");
  const {
    buildOutcomeObservationPayload,
    OUTCOME_OBSERVATION_ANNOTATION_NAME,
  } = await importLinearSrcModule("outcome-observation.mjs");
  const tempRepoRoot = path.join(
    os.tmpdir(),
    `teami-s9-repo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const runStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-s9-runs-"));
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
  assert.deepEqual(synthetic.trace_descriptor, {
    trace_name: "probe_run",
    attribute_keys: [
      "workflow.name",
      "workflow.version",
      "teami.domain_id",
      "resource.kind",
      "resource.id",
      "resource.label",
      "run_id",
    ],
  });
  assert.deepEqual(synthetic.outcome_observations, [{
    id: "probe_outcome",
    produced_identity_effect_id: "noop",
    label: "probe_settled",
  }]);

  const namespacePaths = evalNamespacePaths(synthetic);
  assert.deepEqual(namespacePaths, {
    manifest: "test/fixtures/probe/phoenix-assets.json",
    annotation_schema: "test/fixtures/probe/annotation.schema.json",
    example_schema: "test/fixtures/probe/example.schema.json",
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
  const spanSink = createOrchestratorTurnTraceSink({
    now: () => new Date(PROBE_OBSERVED_AT),
  });
  const trace = buildSyntheticTrace({ definition: synthetic });
  let orchestratorTurns = 0;
  const orchestratorTurnExecutor = async (input) => {
    orchestratorTurns += 1;
    assert.equal(input.definition, synthetic);
    assert.equal(input.roster, roster);
    assert.match(input.governingBody, /Synthetic probe governing body/);
    if (orchestratorTurns === 1) {
      const controlAction = validOneOffAction("worker");
      return {
        prompt: "Synthetic probe orchestrator prompt: ask worker for probe evidence.",
        raw_output: JSON.stringify({ control_action: controlAction }),
        controlAction,
        producedContent: {
          context_digest: "The probe orchestrator requested worker evidence.",
          source_refs: [{ kind: "probe_project", id: "project-probe" }],
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
      prompt: "Synthetic probe orchestrator prompt: commit the synthesized probe result.",
      raw_output: JSON.stringify({ control_action: controlAction, probe_result: "ok" }),
      controlAction,
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

  assert.equal(orchestratorTurns, 2);
  assert.equal(runtimeExecutor.calls.length, 1);
  assert.equal(roster.resolveCalls.length, 0);
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");
  assert.equal(result.output.terminal_output.probe_result, "ok");
  assert.equal(Object.hasOwn(result.output.terminal_output, "final_issues"), false);
  assert.deepEqual(
    validateOrchestratorOutput(result.output, synthetic.commitPayload),
    { ok: true, failureReasons: [] },
  );

  assert.equal(spanSink.spans.length, 3);
  assert.deepEqual(
    spanSink.spans.map((span) => span.name),
    ["orchestrator_turn.1", "subagent_turn.worker", "orchestrator_turn.2"],
  );
  const [invokeSpan, subagentSpan, terminateSpan] = spanSink.spans.map((span) => span.attributes);
  assert.deepEqual(
    pick(invokeSpan, ["round_index", "action", "outcome", "agent_turn_id", "parent_turn_id"]),
    { round_index: 1, action: "invoke_one_off", outcome: "continue", agent_turn_id: 1, parent_turn_id: null },
  );
  assert.equal(invokeSpan.prompt, "Synthetic probe orchestrator prompt: ask worker for probe evidence.");
  assert.match(invokeSpan.raw_output, /invoke_one_off/);
  assert.equal(invokeSpan.control_action.action, "invoke_one_off");
  assert.equal(invokeSpan.produced_content.context_digest, "The probe orchestrator requested worker evidence.");
  assert.deepEqual(invokeSpan.spawn_reason, {
    action: "invoke_one_off",
    runtime_role: "worker",
    role_label: "probe-role",
    task: "Probe the role facet.",
  });

  assert.deepEqual(
    pick(subagentSpan, ["role", "outcome", "agent_turn_id", "parent_turn_id"]),
    { role: "worker", outcome: "probe_turn_complete", agent_turn_id: "1.1", parent_turn_id: 1 },
  );
  assert.equal(subagentSpan.prompt, "Run the synthetic probe.");
  assert.match(subagentSpan.raw_output, /probe_turn_complete/);
  assert.equal(subagentSpan.control_action.action, "invoke_one_off");
  assert.equal(subagentSpan.produced_content.context_digest, "Synthetic subagent turn completed.");
  assert.deepEqual(subagentSpan.spawn_reason, {
    action: "invoke_one_off",
    runtime_role: "worker",
    role_label: "probe-role",
    task: "Probe the role facet.",
  });
  assert.deepEqual(subagentSpan.tool_events, [{
    tool: "synthetic_probe",
    event: "completed",
    target: "probe-artifact-1",
  }]);

  assert.deepEqual(
    pick(terminateSpan, ["round_index", "action", "outcome", "reason", "agent_turn_id", "parent_turn_id"]),
    {
      round_index: 2,
      action: "terminate",
      outcome: "commit",
      reason: "synthesis_complete",
      agent_turn_id: 2,
      parent_turn_id: null,
    },
  );
  assert.equal(terminateSpan.prompt, "Synthetic probe orchestrator prompt: commit the synthesized probe result.");
  assert.match(terminateSpan.raw_output, /synthesis_complete/);
  assert.equal(terminateSpan.control_action.action, "terminate");
  assert.equal(terminateSpan.produced_content.probe_result, "ok");
  assert.deepEqual(terminateSpan.spawn_reason, {
    action: "terminate",
    outcome: "commit",
    reason: "synthesis_complete",
  });
  assert.deepEqual(terminateSpan.consumed_input_refs, ["1.1", "probe_project:project-probe"]);

  assert.deepEqual(result.output.artifact_set_lineage, {
    lineage_scope: "artifact_set",
    produced_by_turn_id: 2,
    commit_decision_turn_id: 2,
    informed_by_turn_ids: ["1.1"],
    source_refs: [{ kind: "probe_project", id: "project-probe" }],
  });
  assert.deepEqual(result.agentTurnLineage.map((entry) => pick(entry, [
    "agent_turn_id",
    "parent_turn_id",
    "role",
    "spawn_reason",
  ])), [
    {
      agent_turn_id: 1,
      parent_turn_id: null,
      role: "orchestrator",
      spawn_reason: {
        action: "invoke_one_off",
        runtime_role: "worker",
        role_label: "probe-role",
        task: "Probe the role facet.",
      },
    },
    {
      agent_turn_id: "1.1",
      parent_turn_id: 1,
      role: "worker",
      spawn_reason: {
        action: "invoke_one_off",
        runtime_role: "worker",
        role_label: "probe-role",
        task: "Probe the role facet.",
      },
    },
    {
      agent_turn_id: 2,
      parent_turn_id: null,
      role: "orchestrator",
      spawn_reason: {
        action: "terminate",
        outcome: "commit",
        reason: "synthesis_complete",
      },
    },
  ]);

  assert.deepEqual(
    Object.keys(invokeSpan.run_config.roles).sort(),
    ["orchestrator", "probe_judge", "worker"],
  );
  assert.equal(invokeSpan.run_config.roles.pm, undefined);
  assert.equal(invokeSpan.run_config.roles.sr_eng, undefined);

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
    await (async () => {
      const applied = await applyCommitEffects({
        effects: synthetic.commit_effects,
        ctx: {
          runId: PROBE_RUN_ID,
          artifact: persisted,
          durable_record: durableRecord,
          artifactSetLineage: result.output.artifact_set_lineage,
        },
      });
      const producedIdentities = applied.produced_identities;
      assert.deepEqual(projectAndAttachProducedIdentities({
        trace,
        effects: synthetic.commit_effects,
        applied: applied.applied,
        artifactSetLineage: result.output.artifact_set_lineage,
      }), producedIdentities);
      assert.deepEqual(producedIdentities, [{
        effect_id: "noop",
        provider: "fake",
        resource_kind: "probe_artifact",
        target_ids: ["probe-artifact-1"],
        identity: {
          artifact_ids: ["probe-artifact-1"],
          artifact_set_id: "probe-set-1",
          status: "settled",
        },
        artifact_set_lineage: result.output.artifact_set_lineage,
      }]);
      const declaredObservation = synthetic.outcome_observations[0];
      const outcomePayload = buildOutcomeObservationPayload({
        traceId: PROBE_TRACE_ID,
        runId: PROBE_RUN_ID,
        producedIdentities,
        observation: {
          observation_id: declaredObservation.id,
          target_id: producedIdentities[0].target_ids[0],
          observer: { kind: "synthetic_general_proof", id: "probe-observer" },
          observed_at: PROBE_OBSERVED_AT,
          label: declaredObservation.label,
          payload: {
            produced_identity_effect_id: declaredObservation.produced_identity_effect_id,
            observed: true,
          },
        },
      });
      const outcomeAnnotation = outcomePayload.data[0];
      trace.annotations.push({
        name: OUTCOME_OBSERVATION_ANNOTATION_NAME,
        createdAt: PROBE_OBSERVED_AT,
        attributes: {
          ...outcomeAnnotation.metadata,
          label: outcomeAnnotation.result.label,
        },
      });
      spanSink.drainInto(trace);

      assert.equal(trace.name, "probe_run");
      assert.deepEqual(
        trace.attributes[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE],
        producedIdentities,
      );
      assert.equal(trace.spans.length, 3);
      assert.equal(spanSink.spans.length, 0, "draining clears the shared turn sink");

      const exportPayload = buildPhoenixOtlpTraceExport({
        projectName: "teami",
        run: {
          run_id: PROBE_RUN_ID,
          domain_id: "probe-domain",
          workflow_type: synthetic.trace_descriptor.trace_name,
          resource: {
            kind: "probe_resource",
            id: "project-probe",
            label: "Synthetic probe",
          },
          status: "completed",
          terminal_reason: "synthesis_complete",
          started_at: PROBE_OBSERVED_AT,
        },
        trace,
        traceId: PROBE_TRACE_ID,
        observedAt: PROBE_OBSERVED_AT,
        includeRoot: true,
        stage: "final",
      });
      const exportedSpans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
      assert.deepEqual(
        exportedSpans.map((span) => span.name),
        [
          "teami.workflow_run",
          "orchestrator_turn.1",
          "subagent_turn.worker",
          "orchestrator_turn.2",
        ],
      );
      const exportedRoot = exportedSpans[0];
      assert.equal(
        otlpAttributeValue(exportedRoot.attributes, "teami.workflow_type"),
        "probe_run",
      );
      assert.equal(
        JSON.stringify(exportedRoot).includes("decomposition_run"),
        false,
      );
      const exportedProducedIdentities = JSON.parse(
        otlpAttributeValue(exportedRoot.attributes, PRODUCED_IDENTITIES_TRACE_ATTRIBUTE),
      );
      assert.deepEqual(exportedProducedIdentities, producedIdentities);
      assert.equal(otlpAttributeValue(exportedRoot.attributes, "resource.kind"), "probe_resource");
      assert.equal(otlpAttributeValue(exportedRoot.attributes, "resource.id"), "project-probe");
      assert.equal(otlpAttributeValue(exportedRoot.attributes, "linear.project_id"), null);
      const outcomeEvent = exportedRoot.events.find((event) => event.name === OUTCOME_OBSERVATION_ANNOTATION_NAME);
      assert.equal(otlpAttributeValue(outcomeEvent.attributes, "observation_id"), "probe_outcome");
      assert.equal(otlpAttributeValue(outcomeEvent.attributes, "target_id"), "probe-artifact-1");
      assert.equal(otlpAttributeValue(outcomeEvent.attributes, "label"), "probe_settled");

      const exportedSubagent = exportedSpans.find((span) => span.name === "subagent_turn.worker");
      assert.equal(otlpAttributeValue(exportedSubagent.attributes, "agent_turn_id"), "1.1");
      assert.equal(otlpAttributeValue(exportedSubagent.attributes, "parent_turn_id"), 1);
      assert.equal(JSON.parse(otlpAttributeValue(exportedSubagent.attributes, "control_action")).action, "invoke_one_off");
      assert.equal(
        JSON.parse(otlpAttributeValue(exportedSubagent.attributes, "produced_content")).context_digest,
        "Synthetic subagent turn completed.",
      );
      return applied;
    })(),
    {
      outcome: "ok",
      applied: [{
        id: "noop",
        identity: {
          artifact_ids: ["probe-artifact-1"],
          artifact_set_id: "probe-set-1",
          status: "settled",
        },
      }],
      produced_identities: [{
        effect_id: "noop",
        provider: "fake",
        resource_kind: "probe_artifact",
        target_ids: ["probe-artifact-1"],
        identity: {
          artifact_ids: ["probe-artifact-1"],
          artifact_set_id: "probe-set-1",
          status: "settled",
        },
        artifact_set_lineage: result.output.artifact_set_lineage,
      }],
    },
  );
  assert.deepEqual(effectCalls.map((call) => call.stage), ["probe", "apply", "verify"]);
});

test("standalone A2 agent trace exports a non-decomposition non-Linear resource trace", async (t) => {
  const { startAgentTrace } = await importLinearSrcModule("agent-trace.mjs");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-probe-standalone-"));
  process.env.TEAMI_HOME = repoRoot;
  t.after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const traceId = "22222222222222222222222222222222";
  let exportPayload = null;
  let exportedSpanNames = [];
  const agentTrace = await startAgentTrace({
    agent_role: "probe_agent",
    run_id: "probe-standalone-1",
    resource: { kind: "probe_resource", id: "probe-1", label: "Probe" },
    domain_id: "probe-domain",
    workflow_type: "probe_standalone",
    repoRoot,
    idFactory: () => traceId,
    now: () => new Date(PROBE_OBSERVED_AT),
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") {
        exportPayload = JSON.parse(init.body);
        const spans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
        exportedSpanNames = spans.map((span) => span.name);
        return new Response("{}", { status: 200 });
      }
      assert.match(String(url), /\/v1\/projects\/teami\/traces/);
      return new Response(JSON.stringify({
        data: [{
          trace_id: traceId,
          spans: exportedSpanNames.map((name) => ({ name })),
        }],
      }), { status: 200 });
    },
  });

  assert.equal(agentTrace.trace.name, "probe_standalone");
  assert.equal(agentTrace.trace.attributes["resource.kind"], "probe_resource");
  assert.equal(agentTrace.trace.attributes["github.behavior_repo_id"], undefined);
  agentTrace.spanSink.recordSpan("probe_agent.turn", {
    prompt: "Inspect the standalone probe resource.",
    raw_output: JSON.stringify({ status: "completed", target: "probe-1" }),
    control_action: { action: "standalone_probe" },
    produced_content: { status: "completed", target_id: "probe-1" },
    agent_turn_id: "standalone-1",
    parent_turn_id: null,
    spawn_reason: { action: "startAgentTrace", agent_role: "probe_agent" },
    tool_events: [{ tool: "probe_agent", event: "inspected", target: "probe-1" }],
  });

  const result = await agentTrace.finish({ status: "completed", reason: "probe_complete" });
  assert.equal(result.status, "trace_exported");
  assert.equal(result.receipt.resource.kind, "probe_resource");
  assert.equal(result.receipt.workspace_id, null);
  assert.equal(result.receipt.team_id, null);

  const exportedSpans = exportPayload.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(
    exportedSpans.map((span) => span.name),
    ["teami.workflow_run", "probe_agent.turn"],
  );
  const exportedRoot = exportedSpans[0];
  assert.equal(
    otlpAttributeValue(exportedRoot.attributes, "teami.workflow_type"),
    "probe_standalone",
  );
  assert.equal(otlpAttributeValue(exportedRoot.attributes, "resource.kind"), "probe_resource");
  assert.equal(otlpAttributeValue(exportedRoot.attributes, "resource.id"), "probe-1");
  assert.equal(otlpAttributeValue(exportedRoot.attributes, "resource.label"), "Probe");
  assert.equal(otlpAttributeValue(exportedRoot.attributes, "linear.workspace_id"), null);
  assert.equal(otlpAttributeValue(exportedRoot.attributes, "linear.team_id"), null);
  assert.equal(JSON.stringify(exportedRoot).includes("decomposition_run"), false);

  const exportedTurn = exportedSpans[1];
  assert.equal(otlpAttributeValue(exportedTurn.attributes, "prompt"), "Inspect the standalone probe resource.");
  assert.equal(JSON.parse(otlpAttributeValue(exportedTurn.attributes, "control_action")).action, "standalone_probe");
  assert.equal(JSON.parse(otlpAttributeValue(exportedTurn.attributes, "produced_content")).target_id, "probe-1");
  assert.equal(otlpAttributeValue(exportedTurn.attributes, "agent_turn_id"), "standalone-1");
});

test("synthetic probe namespace fixtures resolve a configured Judge eval contract", () => {
  const synthetic = buildSyntheticDefinition({ effectCalls: [] });
  const contract = resolveEvalContract(synthetic, REPO_ROOT);
  const promptSnapshotPath = path.join(
    REPO_ROOT,
    "test",
    "fixtures",
    "probe",
    "accepted-prompts",
    "probe-judge.md",
  );
  const snapshotSha256 = createHash("sha256")
    .update(fs.readFileSync(promptSnapshotPath))
    .digest("hex");

  assert.equal(contract.eval_configured, true);
  assert.equal(contract.reason, null);
  assert.equal(contract.workflow_type, "probe");
  assert.equal(contract.eval_namespace, PROBE_NAMESPACE);
  assert.equal(contract.paths.manifest, `${PROBE_NAMESPACE}/phoenix-assets.json`);
  assert.equal(contract.paths.annotation_schema, `${PROBE_NAMESPACE}/annotation.schema.json`);
  assert.equal(contract.paths.example_schema, `${PROBE_NAMESPACE}/example.schema.json`);
  assert.equal(contract.paths.taxonomy, `${PROBE_NAMESPACE}/failure-taxonomy.json`);
  assert.equal(contract.paths.policy, `${PROBE_NAMESPACE}/promotion-policy.json`);
  assert.equal(
    contract.absolute_paths.manifest,
    path.join(REPO_ROOT, "test", "fixtures", "probe", "phoenix-assets.json"),
  );
  assert.deepEqual([...contract.quality_labels], ["pass", "needs_revision", "blocking_failure"]);
  assert.deepEqual([...contract.annotator_kinds], ["HUMAN", "LLM", "CODE"]);
  assert.deepEqual([...contract.canonical_annotation_names], [
    "quality",
    "probe_artifact_quality",
    "accepted_packet_sufficiency",
    "pause_state_correctness",
  ]);
  assert.deepEqual([...contract.quality_dimension_names], ["quality", "probe_artifact_quality"]);
  assert.deepEqual([...contract.deterministic_check_annotation_names], [
    "accepted_packet_sufficiency",
    "pause_state_correctness",
  ]);
  assert.equal(contract.roll_up_annotation_name, "quality");
  assert.equal(contract.rubric_version, "probe-rubric-v1");
  assert.equal(contract.failure_taxonomy_version, "probe-taxonomy-v1");
  assert.equal(contract.rich_example_dataset_name, "teami-probe-examples");
  assert.equal(contract.scoreWithinLabelBand("pass", 0.9), true);
  assert.equal(contract.scoreWithinLabelBand("needs_revision", 0.5), true);
  assert.equal(contract.scoreWithinLabelBand("blocking_failure", 0.2), true);
  assert.equal(contract.scoreWithinLabelBand("pass", 0.7), false);
  assert.equal(contract.scoreAtBandBoundary(0.8), true);
  assert.equal(contract.scoreFromLabelBand("pass"), 0.9);
  assert.equal(contract.scoreFromLabelBand("needs_revision"), 0.6);
  assert.equal(contract.scoreFromLabelBand("blocking_failure"), 0.2);
  assert.deepEqual(
    contract.findBannedWorkflowStateMetadataKeys({ queue_state: "queued", benign_probe_metric: 1 }),
    ["queue_state"],
  );
  assert.deepEqual(contract.failure_taxonomy.workflows.probe.failure_modes, [
    "probe_missing_artifact",
    "probe_unsettled_identity",
  ]);
  assert.equal(contract.failure_taxonomy_workflow_key, "probe");
  assert.deepEqual([...contract.allowed_failure_modes], [
    "probe_missing_trace",
    "probe_missing_terminal_output",
    "probe_missing_artifact",
    "probe_unsettled_identity",
  ]);
  assert.deepEqual(contract.manifest.evaluators.map((entry) => entry.kind), ["llm", "code"]);
  assert.equal(contract.manifest.datasets[0].dataset_id, "ProbeDataset1");
  assert.equal(contract.manifest.datasets[0].accepted_dataset_version_id, "ProbeDatasetVersion1");
  assert.equal(contract.judge_prompt.role, "probe_judge");
  assert.equal(contract.judge_prompt.target_key, "prompt/probe/probe_judge");
  assert.equal(contract.judge_prompt.snapshot_path, `${PROBE_NAMESPACE}/accepted-prompts/probe-judge.md`);
  assert.equal(contract.judge_prompt.snapshot_sha256, snapshotSha256);
  assert.equal(contract.judge_prompt.prompt_version, "probe-accepted-v1");
  assert.equal(contract.judge_prompt.rubric_version, "probe-rubric-v1");
  assert.equal(contract.judge_prompt.failure_taxonomy_version, "probe-taxonomy-v1");
  assert.equal(contract.judge_prompt.evaluator_entry.id, "probe_quality_judge_v1");
});

test("synthetic probe Judge prompt, runtime, and annotation write are definition-threaded", async () => {
  const synthetic = buildSyntheticDefinition({ effectCalls: [] });
  const contract = resolveEvalContract(synthetic, REPO_ROOT);
  const {
    loadJudgePromptContract,
    runDecompositionQualityJudge,
  } = await importLinearSrcModule("decomposition-quality-judge.mjs");
  const {
    resolveJudgeRuntimeAssignment,
  } = await importLinearSrcModule("runtime-adapters.mjs");

  const promptContract = loadJudgePromptContract({
    definition: synthetic,
    repoRoot: REPO_ROOT,
    evalContract: contract,
  });
  assert.equal(promptContract.targetKey, "prompt/probe/probe_judge");
  assert.equal(promptContract.entry.role, "probe_judge");
  assert.equal(promptContract.evaluatorEntry.id, "probe_quality_judge_v1");
  assert.equal(promptContract.evalContract.workflow_type, "probe");
  assert.match(promptContract.snapshotText, /Accepted Probe Judge Prompt/);

  const assignment = resolveJudgeRuntimeAssignment(syntheticConfig(), synthetic);
  assert.equal(assignment.role, "probe_judge");
  assert.equal(assignment.runtime, "fake");
  assert.equal(assignment.model, "judge-model");
  assert.deepEqual(assignment.warm_continuation, { enabled: false, required: false });

  const posts = [];
  const invocations = [];
  const result = await runDecompositionQualityJudge({
    repoRoot: REPO_ROOT,
    evalRepoRoot: REPO_ROOT,
    definition: synthetic,
    evalContract: contract,
    artifact: probeJudgeArtifact(PROBE_RUN_ID),
    snapshot: probeJudgeSnapshot(),
    traceId: PROBE_TRACE_ID,
    config: syntheticJudgeConfig(),
    recordReceipt: false,
    workspaceMaturity: "new",
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    runCommand: async (...args) => {
      invocations.push(args);
      return JSON.stringify({
        label: "needs_revision",
        score: 0.55,
        explanation: "Probe artifact was produced, but the outcome identity needs revision.",
        failure_modes: ["probe_unsettled_identity"],
      });
    },
    fetchImpl: async (url, init = {}) => {
      assert.match(String(url), /\/v1\/trace_annotations\?sync=true$/);
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ id: "probe-anno-1" }] }), { status: 200 });
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.judge_state, "judged");
  assert.equal(result.storage, "phoenix_native");
  assert.deepEqual(result.annotation_ids, ["probe-anno-1"]);
  assert.equal(result.workflow_type, "probe");
  assert.equal(result.eval_namespace, PROBE_NAMESPACE);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0].runtime, "codex");
  assert.ok(runtimePromptFromCommand(invocations[0][0]).includes("Accepted Probe Judge Prompt"));
  assert.equal(posts.length, 1);
  const wire = posts[0].data[0];
  assert.equal(wire.name, "quality");
  assert.equal(wire.name, contract.roll_up_annotation_name);
  assert.equal(wire.annotator_kind, "LLM");
  assert.equal(wire.identifier, "probe_quality_judge_v1:judge-model");
  assert.equal(wire.trace_id, PROBE_TRACE_ID);
  assert.equal(wire.result.label, "needs_revision");
  assert.equal(wire.result.score, 0.6);
  assert.equal(wire.metadata.workflow_type, "probe");
  assert.equal(wire.metadata.eval_namespace, PROBE_NAMESPACE);
  assert.equal(wire.metadata.rubric_version, "probe-rubric-v1");
  assert.equal(wire.metadata.failure_taxonomy_version, "probe-taxonomy-v1");
  assert.equal(wire.metadata.judge_evaluator_id, "probe_quality_judge_v1");
  assert.equal(wire.metadata.judge_model, "judge-model");
  assert.equal(wire.metadata.judge_runtime, "codex");
  assert.equal(wire.metadata.judge_prompt_source, "repo_accepted_snapshot");
  assert.equal(wire.metadata.judge_prompt_version, `sha256:${contract.judge_prompt.snapshot_sha256}`);
  assert.equal(wire.metadata.source_run_id, PROBE_RUN_ID);
  assert.deepEqual(wire.metadata.failure_modes, ["probe_unsettled_identity"]);
});

test("synthetic probe drafter runs one definition-threaded candidate experiment hermetically", async (t) => {
  const previousDefinitions = registeredWorkflowTypes()
    .map((workflowType) => getWorkflowDefinition(workflowType));
  const synthetic = buildSyntheticDefinition({ effectCalls: [] });
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-probe-loop-"));
  process.env.TEAMI_HOME = repoRoot;
  const draftDir = path.join(repoRoot, "drafts");
  const registryDir = path.join(repoRoot, "promotion-candidates");
  t.after(() => {
    restoreRegistry(previousDefinitions);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  resetRegistry();
  registerWorkflow(synthetic);
  writeProbeEvalNamespaceFixture(repoRoot);

  const {
    createImprovementDrafterTestHarness,
    IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
    readImprovementDraftReceipt,
  } = await importLinearSrcModule("improvement-drafter.mjs");
  const {
    readExperimentReceipt,
    runWorkflowExperiment,
  } = await importLinearSrcModule("phoenix-experiment.mjs");

  const phoenix = createProbePhoenixFixture();
  const registerCalls = [];
  const drafterCommands = [];
  const experimentDefinitions = [];
  const evalTaskCalls = [];
  const draftedContent = probeWorkerSnapshotContent("Candidate worker prompt generated by the synthetic drafter.");
  const harness = createImprovementDrafterTestHarness({
    repoRoot,
    config: syntheticDrafterConfig(),
    policyPath: path.join(repoRoot, PROBE_NAMESPACE, "promotion-policy.json"),
    draftDir,
    registryDir,
    githubTransport: fakeEmptyGitHubTransport(),
    resolveRepoIdentity: () => ({
      ok: true,
      connection_mode: "dry_run",
      repo_id: "probe-behavior-repo",
      repo: { owner: "fixture-owner", repo: "probe-behavior" },
    }),
    runCommand: async (command) => {
      drafterCommands.push(command);
      const prompt = runtimePromptFromCommand(command);
      assert.match(prompt, new RegExp(PROBE_WORKER_TARGET_KEY.replaceAll("/", "\\/")));
      assert.match(prompt, /probe_missing_artifact/);
      return JSON.stringify({
        schema_version: IMPROVEMENT_DRAFT_OUTPUT_SCHEMA_VERSION,
        target_key: PROBE_WORKER_TARGET_KEY,
        draft_content: draftedContent,
        change_summary: "Tighten the synthetic probe worker prompt.",
      });
    },
    registerPromptInPhoenixImpl: async (options) => {
      registerCalls.push(options);
      assert.equal(options.definition, synthetic);
      assert.equal(options.targetKey, PROBE_WORKER_TARGET_KEY);
      assert.equal(options.contentText, draftedContent);
      return {
        ok: true,
        appUrl: "http://127.0.0.1:6006",
        target_key: PROBE_WORKER_TARGET_KEY,
        role: "worker",
        human_name: "Probe worker prompt",
        prompt_name: "probe_worker",
        prompt_id: PROBE_CANDIDATE_PROMPT_ID,
        prompt_version_id: PROBE_CANDIDATE_PROMPT_VERSION_ID,
        receipt_path: path.join(repoRoot, "phoenix-prompt-registrations.json"),
        manifest_mutated: false,
      };
    },
    runWorkflowExperimentImpl: async (definition, options) => {
      experimentDefinitions.push(definition);
      return runWorkflowExperiment(definition, {
        ...options,
        runEvalTaskFn: async (taskOptions) => {
          evalTaskCalls.push(taskOptions);
          assert.equal(taskOptions.definition, synthetic);
          assert.equal(taskOptions.datasetName, PROBE_DATASET_NAME);
          assert.equal(
            taskOptions.derivedVariant.prompt_overrides[PROBE_WORKER_TARGET_KEY].candidate_prompt_version_id,
            PROBE_CANDIDATE_PROMPT_VERSION_ID,
          );
          return probeEvalTaskResult({
            evalRunId: `probe-eval-${evalTaskCalls.length}`,
            traceId: "33333333333333333333333333333333",
            variantId: taskOptions.variantId,
          });
        },
        baselineExperimentOverride: null,
      });
    },
    ensureReady: phoenix.ensureReady,
    fetchImpl: phoenix.fetchImpl,
    now: () => new Date(PROBE_OBSERVED_AT),
    randomHex: () => "abc123",
    env: { TEAMI_PHOENIX_URL: "http://127.0.0.1:6006" },
  });

  const result = await harness.runImprovementDrafter({
    repoRoot,
    targetKey: PROBE_WORKER_TARGET_KEY,
    failureModeIds: ["probe_missing_artifact"],
    datasetName: PROBE_DATASET_NAME,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chain_state, "tagged");
  assert.equal(result.target_key, PROBE_WORKER_TARGET_KEY);
  assert.equal(result.phoenix_prompt_version_id, PROBE_CANDIDATE_PROMPT_VERSION_ID);
  assert.equal(drafterCommands.length, 1);
  assert.equal(registerCalls.length, 1);
  assert.deepEqual(experimentDefinitions, [synthetic]);
  assert.equal(evalTaskCalls.length, 1);
  assert.equal(phoenix.state.writes.experiments.length, 1);
  assert.equal(phoenix.state.writes.experimentRuns.length, 1);
  assert.deepEqual(
    phoenix.state.writes.promptTags.map((entry) => entry.body.name),
    ["teami_promotion_candidate"],
  );

  const draftReceipt = readImprovementDraftReceipt({ draftDir, draftId: result.draft_id });
  assert.equal(draftReceipt.exists, true);
  assert.equal(draftReceipt.receipt.chain_state, "tagged");
  assert.deepEqual(draftReceipt.receipt.derived_variant, {
    id: `drafted:${result.draft_id}`,
    prompt_overrides: {
      [PROBE_WORKER_TARGET_KEY]: {
        candidate_prompt_version_id: PROBE_CANDIDATE_PROMPT_VERSION_ID,
      },
    },
  });

  const experimentReceipt = readExperimentReceipt({
    repoRoot,
    receiptId: result.experiment_receipt_id,
  });
  assert.equal(experimentReceipt.exists, true);
  assert.equal(experimentReceipt.receipt.launch.intent, "promotion_candidate");
  assert.equal(experimentReceipt.receipt.launch.drafted_by, "teami_drafter_v1:drafter-model");
  assert.equal(experimentReceipt.receipt.launch.candidate_target_key, PROBE_WORKER_TARGET_KEY);
  assert.equal(
    experimentReceipt.receipt.launch.candidate.prompt_overrides[PROBE_WORKER_TARGET_KEY].candidate_prompt_version_id,
    PROBE_CANDIDATE_PROMPT_VERSION_ID,
  );
  assert.equal(experimentReceipt.receipt.launch.evaluators.judge.evaluator_id, "probe_quality_judge_v1");
  assert.equal(experimentReceipt.receipt.launch.dataset.name, PROBE_DATASET_NAME);
});

test("synthetic probe scope classification admits only the probe persona and excludes the Judge", () => {
  const synthetic = buildSyntheticDefinition({ effectCalls: [] });
  const scope = createAgentBehaviorScope();
  const manifest = probeBehaviorManifest();
  const targets = scope.agentBehaviorTargetsFromManifest({ definition: synthetic, manifest });

  assert.deepEqual(targets.map((target) => target.role), ["worker"]);
  assert.deepEqual(targets.map((target) => target.target_key), ["prompt/probe/worker"]);

  const [persona] = targets.map((target) =>
    scope.adopterSelfImprovementPersonaBinding(target, { definition: synthetic }));
  assert.deepEqual(persona, {
    persona_role: "worker",
    persona_kind: "role",
    driver_role: null,
    facet: "prompt",
    target_key: "prompt/probe/worker",
    governing_target_key: null,
    runtime_defaults_target_key: null,
  });

  const judgeTarget = manifest.prompts.find((target) => target.role === "probe_judge");
  assert.equal(scope.isAdopterSelfImprovementTarget(judgeTarget, { definition: synthetic }), false);
  assert.deepEqual(
    scope.classifyAgentBehaviorProposalScope({
      definition: synthetic,
      candidateTargetKey: judgeTarget.target_key,
      target: judgeTarget,
    }),
    {
      schema_version: "teami-agent-behavior-scope/v1",
      ok: false,
      reason: "candidate_target_out_of_scope",
      target_key: "prompt/probe/probe_judge",
      ownership: "factory_behavior",
      surface: "evaluation_judging_rules",
      proposal_labels: [],
    },
  );
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
    trace_descriptor: {
      trace_name: "probe_run",
      attribute_keys: [
        "workflow.name",
        "workflow.version",
        "teami.domain_id",
        "resource.kind",
        "resource.id",
        "resource.label",
        "run_id",
      ],
    },
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
        producedIdentity: {
          resource_kind: "probe_artifact",
          target_ids: (identity) => identity.artifact_ids,
          identity: (identity) => ({
            artifact_ids: identity.artifact_ids,
            artifact_set_id: identity.artifact_set_id,
            status: identity.status,
          }),
        },
        probe(ctx) {
          effectCalls.push({ stage: "probe", ctx });
          return { satisfied: false };
        },
        apply(ctx) {
          effectCalls.push({ stage: "apply", ctx });
          return {
            ok: true,
            identity: {
              artifact_ids: ["probe-artifact-1"],
              artifact_set_id: "probe-set-1",
              status: "settled",
            },
          };
        },
        verify(ctx) {
          effectCalls.push({ stage: "verify", ctx });
          return {
            ok: true,
            identity: {
              artifact_ids: ["probe-artifact-1"],
              artifact_set_id: "probe-set-1",
              status: "settled",
            },
          };
        },
      },
    ],
    outcome_observations: [
      {
        id: "probe_outcome",
        produced_identity_effect_id: "noop",
        label: "probe_settled",
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
        source_refs: [{ kind: "probe_artifact", id: "probe-artifact-1" }],
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
        prompt: input.prompt,
        raw_output: JSON.stringify(packet),
        raw_output_excerpt: JSON.stringify(packet),
        evidence: {
          tool_events: [{
            tool: "synthetic_probe",
            event: "completed",
            target: "probe-artifact-1",
          }],
        },
      };
    },
  };
}

function writeProbeEvalNamespaceFixture(repoRoot) {
  for (const fileName of [
    "annotation.schema.json",
    "example.schema.json",
    "failure-taxonomy.json",
    "promotion-policy.json",
    "accepted-runtime-roles.json",
    "variants.json",
  ]) {
    copyProbeFixtureFile({ repoRoot, relativePath: fileName });
  }
  copyProbeFixtureFile({ repoRoot, relativePath: "accepted-prompts/probe-judge.md" });

  const workerSnapshotPath = `${PROBE_NAMESPACE}/accepted-prompts/worker.md`;
  const workerSnapshot = probeWorkerSnapshotContent("Accepted worker prompt for the synthetic probe.");
  writeFixtureTextFile(path.join(repoRoot, workerSnapshotPath), workerSnapshot);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, PROBE_NAMESPACE, "phoenix-assets.json"), "utf8"),
  );
  const judgeEntry = manifest.prompts.find((entry) => entry.target_key === PROBE_JUDGE_TARGET_KEY);
  manifest.prompts = [
    {
      role: "worker",
      target_key: PROBE_WORKER_TARGET_KEY,
      human_name: "Probe worker prompt",
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      prompt_name: "probe_worker",
      prompt_id: null,
      accepted_prompt_version_id: "PV-PROBE-WORKER-ACCEPTED",
      accepted_tag: "teami_accepted",
      snapshot_path: workerSnapshotPath,
      snapshot_sha256: sha256Text(workerSnapshot),
      prompt_version: "probe-worker-accepted-v1",
    },
    {
      ...judgeEntry,
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    },
  ];
  manifest.experiments = [];
  writeFixtureTextFile(
    path.join(repoRoot, PROBE_NAMESPACE, "phoenix-assets.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function copyProbeFixtureFile({ repoRoot, relativePath }) {
  const source = path.join(REPO_ROOT, PROBE_NAMESPACE, relativePath);
  const destination = path.join(repoRoot, PROBE_NAMESPACE, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function writeFixtureTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function probeWorkerSnapshotContent(body) {
  return [
    "# Accepted Probe Worker Prompt",
    "",
    "```yaml",
    "prompt_version: probe-worker-v1",
    "phoenix_prompt_role: worker",
    `target_key: ${PROBE_WORKER_TARGET_KEY}`,
    "```",
    "",
    "## Instructions",
    "",
    body,
    "",
  ].join("\n");
}

function createProbePhoenixFixture() {
  const appUrl = "http://127.0.0.1:6006";
  const datasetId = "ProbeDataset1";
  const datasetVersionId = "ProbeDatasetVersion1";
  const state = {
    calls: [],
    promptTagVersionId: null,
    writes: {
      experiments: [],
      experimentRuns: [],
      experimentEvaluations: [],
      promptTags: [],
    },
  };
  const datasetExample = {
    id: "probe-example-1",
    input: {
      run_id: PROBE_RUN_ID,
      artifact: probeJudgeArtifact(PROBE_RUN_ID),
      snapshot: probeJudgeSnapshot(),
    },
    output: { expected_label: "pass" },
    metadata: {
      dataset_split: "test",
      eval_namespace: PROBE_NAMESPACE,
      workflow_type: "probe",
    },
  };

  return {
    state,
    ensureReady: async () => ({
      ok: true,
      appUrl,
      projectName: "teami",
      managed: true,
    }),
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = (init.method || "GET").toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      state.calls.push({ method, pathname: parsed.pathname, search: parsed.search, body });

      if (method === "GET" && parsed.pathname === "/openapi.json") {
        return probeJsonResponse(probeExperimentOpenApi());
      }
      if (method === "GET" && parsed.pathname === "/v1/datasets") {
        return probeJsonResponse({ data: [{ id: datasetId, name: PROBE_DATASET_NAME }] });
      }
      if (method === "GET" && parsed.pathname === `/v1/datasets/${datasetId}/versions`) {
        return probeJsonResponse({ data: [{ version_id: datasetVersionId }], next_cursor: null });
      }
      if (method === "GET" && parsed.pathname === `/v1/datasets/${datasetId}/examples`) {
        return probeJsonResponse({
          data: {
            dataset_id: datasetId,
            version_id: datasetVersionId,
            examples: [datasetExample],
          },
        });
      }
      if (method === "POST" && parsed.pathname === `/v1/datasets/${datasetId}/experiments`) {
        const experiment = {
          id: "EXP-PROBE-DRAFT",
          dataset_id: datasetId,
          dataset_version_id: datasetVersionId,
          project_name: "teami",
          metadata: body.metadata || {},
        };
        state.writes.experiments.push({ body, experiment });
        return probeJsonResponse({ data: experiment });
      }
      if (method === "POST" && parsed.pathname === "/v1/experiments/EXP-PROBE-DRAFT/runs") {
        const run = { id: `EXPRUN-PROBE-${state.writes.experimentRuns.length + 1}`, ...body };
        state.writes.experimentRuns.push({ body, run });
        return probeJsonResponse({ data: { id: run.id } });
      }
      if (method === "POST" && parsed.pathname === "/v1/experiment_evaluations") {
        const evaluation = {
          id: `EXPEVAL-PROBE-${state.writes.experimentEvaluations.length + 1}`,
          ...body,
        };
        state.writes.experimentEvaluations.push({ body, evaluation });
        return probeJsonResponse({ data: { id: evaluation.id } });
      }
      if (
        method === "GET"
        && parsed.pathname === `/v1/prompts/${PROBE_CANDIDATE_PROMPT_ID}/tags/teami_promotion_candidate`
      ) {
        if (!state.promptTagVersionId) return probeJsonResponse({ detail: "not found" }, 404);
        return probeJsonResponse({ data: { id: state.promptTagVersionId } });
      }
      if (method === "POST" && parsed.pathname === `/v1/prompt_versions/${PROBE_CANDIDATE_PROMPT_VERSION_ID}/tags`) {
        state.promptTagVersionId = PROBE_CANDIDATE_PROMPT_VERSION_ID;
        state.writes.promptTags.push({ body });
        return probeJsonResponse({}, 204);
      }
      throw new Error(`unexpected probe Phoenix request: ${method} ${parsed.pathname}`);
    },
  };
}

function probeExperimentOpenApi() {
  return {
    paths: {
      "/v1/datasets/{dataset_id}/experiments": { post: {} },
      "/v1/experiments/{experiment_id}/runs": { post: {} },
      "/v1/experiment_evaluations": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpsertExperimentEvaluationRequestBody" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        UpsertExperimentEvaluationRequestBody: {
          properties: {
            annotator_kind: { enum: ["HUMAN", "LLM", "CODE"] },
            result: { type: "object" },
            error: { type: "string" },
          },
        },
      },
    },
  };
}

function probeJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return status === 204 ? "" : JSON.stringify(body);
    },
  };
}

function probeEvalTaskResult({ evalRunId, traceId, variantId }) {
  return {
    ok: true,
    status: "evaluated",
    eval_run_id: evalRunId,
    variant_id: variantId,
    inputs_hash: "probe-inputs-hash",
    terminal: { outcome: "commit", reason: "probe_complete" },
    subagent_invocations: [{ role: "worker", outcome: "probe_turn_complete" }],
    trace: { trace_id: traceId },
    checks: {
      checks: [{
        status: "evaluated",
        annotation: {
          name: "accepted_packet_sufficiency",
          label: "pass",
          score: 1,
          explanation: "The synthetic probe packet is sufficient.",
          identifier: "probe_packet_shape_v1",
          metadata: { failure_modes: [] },
        },
      }],
    },
    judge: {
      judge_state: "judged",
      identifier: "probe_quality_judge_v1:judge-model",
      model: "judge-model",
      prompt_source: "repo_accepted_snapshot",
      prompt_version: "probe-accepted-v1",
      judge: {
        label: "pass",
        score: 0.95,
        explanation: "The synthetic probe candidate preserves the worker contract.",
        failure_modes: [],
      },
    },
  };
}

function syntheticDrafterConfig() {
  return {
    runtime: {
      adapters: {
        claude: { command: "claude", tool_policy: { linear_write: false } },
        fake: { command: "fake-runtime", tool_policy: { linear_write: false } },
      },
    },
    workflows: {
      decomposition: {
        roles: {
          drafter: { runtime: "claude", model: "drafter-model" },
        },
      },
      probe: {
        roles: {
          worker: { runtime: "fake", model: "worker-model" },
          probe_judge: { runtime: "fake", model: "judge-model" },
        },
        role_field_sources: {
          probe_judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
        },
      },
    },
  };
}

function fakeEmptyGitHubTransport() {
  return {
    async request({ endpointId }) {
      if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
        return { data: [] };
      }
      throw new Error(`unexpected GitHub request: ${endpointId}`);
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

function syntheticJudgeConfig() {
  return {
    runtime: {
      adapters: {
        codex: { command: "codex", tool_policy: { linear_write: false } },
      },
    },
    workflows: {
      probe: {
        roles: {
          probe_judge: { runtime: "codex", model: "judge-model" },
        },
        role_field_sources: {
          probe_judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
        },
      },
    },
  };
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function probeJudgeArtifact(runId) {
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: PROBE_FUNCTION_VERSION,
    workflow_version: PROBE_FUNCTION_VERSION,
    run_id: runId,
    domain_id: "probe-domain",
    workspace_id: "probe-workspace",
    team_id: "probe-team",
    kind: "commit",
    terminal_output: {
      run_id: runId,
      outcome: "commit",
      reason: "synthesis_complete",
      probe_result: "ok",
      context_digest: "The probe function reached a terminal commit outcome.",
      source_refs: [{ kind: "probe_project", id: "project-probe" }],
      assumptions: [],
      constraints: [],
      risks: [],
    },
    evidence: {
      perspectives_run: [{ role: "worker", outcome: "probe_turn_complete" }],
    },
    bounds: { rounds_used: 2, max_rounds: 2 },
    runtime_assignments: {
      worker: { runtime: "fake", model: "worker-model" },
    },
    runtime_metadata: {},
    final_issues: [],
    discovery_issues: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Synthetic probe completed.",
    ].join("\n"),
  };
}

function probeJudgeSnapshot() {
  return {
    project: {
      id: "project-probe",
      name: "Synthetic probe",
      content: "Probe the generic engine.",
      status: "completed",
      labels: [],
      existing_issues: [],
    },
    capture_source: "synthetic_probe_harness",
    snapshot_hash: "sha256:synthetic-probe",
  };
}

function probeBehaviorManifest() {
  return {
    schema_version: 1,
    prompts: [
      {
        role: "worker",
        target_key: "prompt/probe/worker",
        human_name: "Probe persona",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        snapshot_path: "test/fixtures/probe/accepted-prompts/worker.md",
      },
      {
        role: "probe_judge",
        target_key: "prompt/probe/probe_judge",
        human_name: "Probe quality Judge",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        snapshot_path: "test/fixtures/probe/accepted-prompts/probe-judge.md",
      },
    ],
    rules: [],
  };
}

function buildSyntheticTrace({ definition }) {
  return {
    name: definition.trace_descriptor.trace_name,
    attributes: {
      "workflow.name": definition.trace_descriptor.trace_name,
      "workflow.version": PROBE_FUNCTION_VERSION,
      "teami.domain_id": "probe-domain",
      "resource.kind": "probe_resource",
      "resource.id": "project-probe",
      "resource.label": "Synthetic probe",
      run_id: PROBE_RUN_ID,
    },
    spans: [],
    annotations: [],
  };
}

async function importLinearSrcModule(fileName) {
  const moduleUrl = pathToFileURL(path.join(LINEAR_SRC_DIR, fileName)).href;
  return import(moduleUrl);
}

function pick(record, keys) {
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function otlpAttributeValue(attributes = [], key) {
  const attribute = attributes.find((candidate) => candidate.key === key);
  return attribute ? otlpValueToJs(attribute.value) : null;
}

function otlpValueToJs(value = {}) {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(otlpValueToJs);
  return null;
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
    artifact_set_lineage: runResult.artifact_set_lineage,
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
    if (edge.resolved === APP_HOME_FILE) return [];
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
