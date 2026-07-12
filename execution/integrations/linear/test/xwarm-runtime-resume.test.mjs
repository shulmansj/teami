import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_VERSION, RUN_ARTIFACT_SCHEMA_VERSION } from "../../../engine/engine-contract-constants.mjs";
import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "../../../engine/orchestrator-turn-contract.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  WARM_CONTINUATION_UNAVAILABLE_CODE,
  defaultOrchestratorRuntime,
} from "../src/orchestrator-turn.mjs";
import {
  buildRuntimeMetadata,
  resolveRoleRuntimeAssignments,
  runtimeAssignmentConfigKey,
  runtimeAssignmentSmokeKey,
} from "../src/runtime-adapters.mjs";
import {
  createLocalTriggerStore,
  localTriggerStorePath,
  readLocalTriggerState,
  resolveDriverSessionHandle,
  runIsResumable,
} from "../src/local-trigger-store.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";
import { registerExecutionWorkflowForTest } from "../src/trigger-runner.mjs";

registerExecutionWorkflowForTest();

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("runOrchestratorLoop passes firstTurnWarmStart once and returns the driver session handle", async () => {
  const warmStart = {
    sessionHandle: {
      id: "prior-driver-session",
      role: "orchestrator",
      run_id: "run-prior",
      runtime: "codex",
    },
    priorRunId: "run-prior",
    smokeTests: {},
    runtimeVersion: "0.130.0",
  };
  const seenWarmStarts = [];
  const seenSessionHandles = [];
  let turn = 0;

  const result = await runOrchestratorLoop({
    runId: "run-fresh",
    wake: { id: "wake-1", object_id: "issue-1", workflow_type: "execution" },
    event: { id: "event-1" },
    project: { id: "issue-1", title: "Fix the bug" },
    config: loadLinearConfig({ repoRoot }),
    runtimeExecutor: fakeRuntimeExecutor(),
    orchestratorTurnExecutor: async (input) => {
      turn += 1;
      seenWarmStarts.push(input.firstTurnWarmStart);
      seenSessionHandles.push(input.sessionHandle);
      if (turn === 1) {
        return {
          controlAction: {
            action: "invoke_one_off",
            role_label: "Worker",
            task: "Inspect the issue",
            prompt: "Inspect the issue.",
            runtime_role: "worker",
          },
          sessionHandle: warmStart.sessionHandle,
        };
      }
      return {
        controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
        sessionHandle: {
          id: "fresh-driver-session",
          role: "orchestrator",
          run_id: "run-fresh",
          runtime: "codex",
        },
      };
    },
    roster: { selectableTargets: [], resolve: () => ({ ok: false, reason: "not_selectable" }) },
    definition: executionDefinition,
    commitPayload: null,
    repoRoot,
    firstTurnWarmStart: warmStart,
  });

  assert.equal(seenWarmStarts.length, 2);
  assert.deepEqual(seenWarmStarts[0], warmStart);
  assert.equal(seenWarmStarts[1], null);
  assert.equal(seenSessionHandles[0], null);
  assert.deepEqual(seenSessionHandles[1], warmStart.sessionHandle);
  assert.deepEqual(result.orchestratorSessionHandle, {
    id: "fresh-driver-session",
    role: "orchestrator",
    run_id: "run-fresh",
    runtime: "codex",
  });
});

test("default orchestrator runtime uses warm_required only for firstTurnWarmStart", async () => {
  const config = loadLinearConfig({ repoRoot });
  const assignment = resolveRoleRuntimeAssignments(config, "execution").orchestrator;
  assert.deepEqual(assignment.warm_continuation, { enabled: true, required: true });
  const runtimeVersion = "0.130.0";
  const smokeTests = {
    [runtimeAssignmentSmokeKey(assignment, runtimeVersion)]: {
      session_start: true,
      warm_continuation: true,
      schema_output: true,
      explicit_handle: true,
      runtime_version: runtimeVersion,
      assignment_key: runtimeAssignmentConfigKey(assignment),
    },
  };
  const commands = [];
  const runCommand = async (command) => {
    commands.push(command);
    return JSON.stringify({
      session_id: command.mode === "warm_required" ? "warm-driver-session" : "fresh-driver-session",
      control_action: { action: "terminate", outcome: "pause", reason: "product_questions" },
    });
  };

  const warmTurn = await defaultOrchestratorRuntime({
    runId: "run-fresh",
    project: { id: "issue-1", title: "Fix the bug" },
    selectableTargets: [],
    priorTurns: [],
    bounds: { rounds_used: 0, max_rounds: 10 },
    sessionHandle: null,
    config,
    assignment,
    invocableRuntimeRoles: ["worker"],
    firstTurnWarmStart: {
      sessionHandle: {
        id: "prior-driver-session",
        role: "orchestrator",
        run_id: "run-prior",
        runtime: "codex",
      },
      priorRunId: "run-prior",
      smokeTests,
      runtimeVersion,
    },
    runCommand,
    repoRoot,
  });

  assert.equal(commands[0].mode, "warm_required");
  assert.ok(commands[0].args.includes("prior-driver-session"));
  assert.deepEqual(warmTurn.sessionHandle, {
    id: "warm-driver-session",
    role: "orchestrator",
    run_id: "run-prior",
    runtime: "codex",
  });

  const normalTurn = await defaultOrchestratorRuntime({
    runId: "run-fresh",
    project: { id: "issue-1", title: "Fix the bug" },
    selectableTargets: [],
    priorTurns: [],
    bounds: { rounds_used: 1, max_rounds: 10 },
    sessionHandle: warmTurn.sessionHandle,
    config,
    assignment,
    invocableRuntimeRoles: ["worker"],
    runCommand,
    repoRoot,
  });

  assert.equal(commands[1].mode, "session_start");
  assert.deepEqual(normalTurn.sessionHandle, {
    id: "fresh-driver-session",
    role: "orchestrator",
    run_id: "run-fresh",
    runtime: "codex",
  });
});

test("warm guard failures return the typed warm_continuation_unavailable escalation", async () => {
  const config = loadLinearConfig({ repoRoot });
  const assignment = {
    ...resolveRoleRuntimeAssignments(config, "execution").orchestrator,
    warm_continuation: { enabled: false, required: false },
  };

  await assert.rejects(
    () =>
      defaultOrchestratorRuntime({
        runId: "run-fresh",
        project: { id: "issue-1" },
        selectableTargets: [],
        priorTurns: [],
        bounds: { rounds_used: 0, max_rounds: 10 },
        assignment,
        invocableRuntimeRoles: ["worker"],
        firstTurnWarmStart: {
          sessionHandle: {
            id: "prior-driver-session",
            role: "orchestrator",
            run_id: "run-prior",
            runtime: "codex",
          },
          priorRunId: "run-prior",
          smokeTests: {},
          runtimeVersion: "0.130.0",
        },
        runCommand: async () => {
          throw new Error("runCommand should not be reached");
        },
        repoRoot,
      }),
    (error) => {
      assert.equal(error.code, WARM_CONTINUATION_UNAVAILABLE_CODE);
      assert.match(error.message, /warm_continuation_unavailable/);
      return true;
    },
  );
});

test("runOrchestratorLoop converts warm_continuation_unavailable into failed_closed with a metric", async () => {
  const spanSink = {
    orchestratorTurns: [],
    recordOrchestratorTurn(span) {
      this.orchestratorTurns.push(structuredClone(span));
    },
  };
  const error = new Error("warm resume unsupported");
  error.code = WARM_CONTINUATION_UNAVAILABLE_CODE;

  const result = await runOrchestratorLoop({
    runId: "run-fresh",
    wake: { id: "wake-1", object_id: "issue-1", workflow_type: "execution" },
    event: { id: "event-1" },
    project: { id: "issue-1", title: "Fix the bug" },
    config: loadLinearConfig({ repoRoot }),
    runtimeExecutor: fakeRuntimeExecutor(),
    orchestratorTurnExecutor: async () => {
      throw error;
    },
    roster: { selectableTargets: [], resolve: () => ({ ok: false, reason: "not_selectable" }) },
    definition: executionDefinition,
    commitPayload: null,
    repoRoot,
    firstTurnWarmStart: {
      sessionHandle: {
        id: "prior-driver-session",
        role: "orchestrator",
        run_id: "run-prior",
        runtime: "codex",
      },
      priorRunId: "run-prior",
      smokeTests: {},
      runtimeVersion: "0.130.0",
    },
    spanSink,
  });

  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "warm_continuation_unavailable");
  assert.equal(spanSink.orchestratorTurns.length, 1);
  assert.equal(spanSink.orchestratorTurns[0].metrics.warm_continuation_unavailable, 1);
});

test("driver handle metadata persists through run records and resolves from the artifact pointer", async () => {
  const temp = tempRepo();
  const runStoreDir = path.join(temp, "domains", "support-ops", "runs");
  const store = createLocalTriggerStore({
    repoRoot: temp,
    home: temp,
    idGenerator: sequenceIds(),
    now: () => new Date("2026-06-28T10:00:00.000Z"),
    writeMutationIntent: async () => {},
    clearMutationIntent: async () => {},
  });
  const runtimeAssignments = {
    orchestrator: resolveRoleRuntimeAssignments(loadLinearConfig({ repoRoot }), "execution").orchestrator,
  };
  const driverSessionHandle = {
    id: "driver-session-latest",
    role: "orchestrator",
    run_id: "run-latest",
    runtime: "codex",
  };
  const metadata = buildRuntimeMetadata({
    runtimeAssignments,
    driverSessionHandle,
  });
  assert.deepEqual(metadata.orchestrator.session_handle, driverSessionHandle);

  await completeIssueRun({
    store,
    objectId: "issue-1",
    runId: "run-old",
    startedAt: "2026-06-28T09:00:00.000Z",
    terminalAt: "2026-06-28T09:05:00.000Z",
  });
  await completeProjectRunIgnoredByLatestLookup({
    store,
    objectId: "issue-1",
    runId: "run-decomposition",
    startedAt: "2026-06-28T11:00:00.000Z",
    terminalAt: "2026-06-28T11:05:00.000Z",
  });
  const artifact = checkpointArtifact({
    runId: "run-latest",
    runtimeAssignments,
    runtimeMetadata: metadata,
  });
  const artifactPath = writeRunArtifact({ runId: "run-latest", runStoreDir }, artifact);
  await completeIssueRun({
    store,
    objectId: "issue-1",
    runId: "run-latest",
    startedAt: "2026-06-28T10:00:00.000Z",
    terminalAt: "2026-06-28T10:05:00.000Z",
    artifact,
    artifactPointer: { artifact_path: artifactPath },
  });

  const latest = store.findLatestRunForObject("issue-1");
  assert.equal(latest.run_id, "run-latest");
  assert.equal(runIsResumable(latest), true);
  assert.deepEqual(latest.session_handle_pointer, {
    source: "run_artifact.runtime_metadata",
    runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
  });
  assert.deepEqual(resolveDriverSessionHandle(latest, { repoRoot: temp, runStoreDir }), driverSessionHandle);

  latest.run_id = "mutated";
  assert.equal(store.findLatestRunForObject("issue-1").run_id, "run-latest");
  assert.equal(store.findLatestRunForObject("missing-issue"), null);

  const reloaded = readLocalTriggerState(localTriggerStorePath(temp));
  const persisted = reloaded.runs.find((run) => run.run_id === "run-latest");
  assert.equal(Object.hasOwn(persisted, "runtime_metadata"), false);
  assert.equal(runIsResumable(persisted), true);
});

function fakeRuntimeExecutor() {
  return {
    async executeSubagent({ runId, runtime_role }) {
      const packet = {
        schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
        run_id: runId,
        status: "continue",
        reason: "product_context_sufficient",
        context_digest: "worker inspected the issue",
        source_refs: [{ kind: "linear_issue", id: "issue-1" }],
        assumptions: [],
        constraints: [],
        risks: [],
      };
      const output = JSON.stringify(packet);
      return {
        ok: true,
        packet,
        output,
        role: runtime_role,
        runtime: "codex",
        parse_status: "valid",
        clean_parse: true,
        prompt: "worker prompt",
        raw_output: output,
        raw_output_excerpt: output,
        envelope: "worker prompt",
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
}

async function completeIssueRun({
  store,
  objectId,
  runId,
  startedAt,
  terminalAt,
  artifact = null,
  artifactPointer = undefined,
}) {
  const claim = await store.claimSyntheticIssueWake({
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    objectId,
    workflowType: "execution",
    triggerType: "linear.issue.ready",
  });
  await store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId,
    domainId: "support-ops",
    at: startedAt,
  });
  await store.completeWake({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    status: "completed",
    at: terminalAt,
    artifact,
    artifactPointer,
  });
}

async function completeProjectRunIgnoredByLatestLookup({ store, objectId, runId, startedAt, terminalAt }) {
  const claim = await store.claimSyntheticWake({
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: objectId,
  });
  await store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId,
    domainId: "support-ops",
    at: startedAt,
  });
  await store.completeWake({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    status: "completed",
    at: terminalAt,
  });
}

function checkpointArtifact({ runId, runtimeAssignments, runtimeMetadata }) {
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: "execution-test/v1",
    workflow_version: "execution-test/v1",
    kind: "checkpoint",
    run_id: runId,
    domain_id: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    runtime_assignments: runtimeAssignments,
    runtime_metadata: runtimeMetadata,
  };
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-xwarm-"));
  process.env.TEAMI_HOME = root;
  return root;
}

function sequenceIds() {
  const counts = new Map();
  return (prefix = "id") => {
    const next = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
}
