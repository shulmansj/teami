import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOrchestratorLoop } from "../../../engine/orchestrator-loop.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import {
  runWarmResumeIssueSyntheticWake,
} from "../src/gateway-loop.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION } from "../src/domain-registry.mjs";
import {
  defaultOrchestratorRuntime,
} from "../src/orchestrator-turn.mjs";
import { runTriggeredExecution } from "../src/trigger-runner.mjs";
import { formatAfReviewCommentBody } from "../src/execution-pr-adapter.mjs";
import {
  resolveRoleRuntimeAssignments,
  runtimeAssignmentConfigKey,
  runtimeAssignmentSmokeKey,
} from "../src/runtime-adapters.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "../src/workflows/execution/effect-ids.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const HEAD_SHA = "b".repeat(40);
const REVIEWER_NOTES = formatAfReviewCommentBody({
  body: "Please preserve the OAuth browser flow and add a regression test.",
  disposition: "request-changes",
  head_sha: HEAD_SHA,
  run_id: "run-review",
});

test("resumeFrom drives the first orchestrator turn through a warm command with reviewer notes", async () => {
  const config = loadLinearConfig({ repoRoot });
  const assignment = resolveRoleRuntimeAssignments(config, "execution").orchestrator;
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

  const result = await runOrchestratorLoop({
    runId: "run-fresh",
    wake: { id: "wake-1", object_id: "issue-1", workflow_type: "execution" },
    event: { id: "event-1" },
    project: { id: "issue-1", title: "Fix review feedback", description: "Review requested changes." },
    config,
    runtimeExecutor: {
      async executeSubagent() {
        throw new Error("subagents should stay fresh and unused in this one-turn fixture");
      },
    },
    orchestratorTurnExecutor: (input) =>
      defaultOrchestratorRuntime({
        ...input,
        assignment,
        invocableRuntimeRoles: ["worker"],
        runCommand: async (command) => {
          commands.push(command);
          return JSON.stringify({
            session_id: "warm-driver-session",
            control_action: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
            produced_content: commitProducedContent(input.runId),
          });
        },
        repoRoot,
      }),
    roster: { selectableTargets: [], resolve: () => ({ ok: false, reason: "not_selectable" }) },
    definition: executionDefinition,
    commitPayload: executionDefinition.commitPayload,
    repoRoot,
    resumeFrom: {
      sessionHandle: {
        id: "prior-driver-session",
        role: "orchestrator",
        run_id: "run-prior",
        runtime: "codex",
      },
      priorRunId: "run-prior",
      reviewerNotes: REVIEWER_NOTES,
      smokeTests,
      runtimeVersion,
      head_sha: HEAD_SHA,
    },
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].mode, "warm_required");
  assert.ok(commands[0].args.includes("prior-driver-session"));
  assert.ok(
    commands[0].args.some((arg) =>
      typeof arg === "string" && arg.includes("Please preserve the OAuth browser flow")
    ),
    "the resumed first-turn prompt should contain the reviewer notes",
  );
  assert.equal(result.output.terminal_output.run_id, "run-fresh");
  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.deepEqual(result.orchestratorSessionHandle, {
    id: "warm-driver-session",
    role: "orchestrator",
    run_id: "run-prior",
    runtime: "codex",
  });
});

test("runTriggeredExecution records the warm resume outcome on the persisted artifact", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-warm-runner-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  const seenTurns = [];

  const result = await runTriggeredExecution({
    ...runOptions({ repoRoot: tempRoot, store, runDeps }),
    resumeFrom: {
      sessionHandle: {
        id: "prior-driver-session",
        role: "orchestrator",
        run_id: "run-prior",
        runtime: "codex",
      },
      priorRunId: "run-prior",
      reviewerNotes: REVIEWER_NOTES,
      smokeTests: {},
      runtimeVersion: "0.130.0",
      head_sha: HEAD_SHA,
    },
    orchestratorTurnExecutor: async (input) => {
      seenTurns.push({
        runId: input.runId,
        firstTurnWarmStart: input.firstTurnWarmStart,
        priorTurns: structuredClone(input.priorTurns),
      });
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: commitProducedContent(input.runId),
        evidence: null,
        sessionHandle: {
          id: "fresh-driver-session",
          role: "orchestrator",
          run_id: input.runId,
          runtime: "codex",
        },
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.result.status, "completed");
  assert.equal(seenTurns.length, 1);
  assert.notEqual(seenTurns[0].runId, "run-prior");
  assert.equal(seenTurns[0].firstTurnWarmStart.priorRunId, "run-prior");
  assert.equal(seenTurns[0].firstTurnWarmStart.sessionHandle.id, "prior-driver-session");
  assert.equal(seenTurns[0].priorTurns[0].reviewer_notes, REVIEWER_NOTES);
  assert.deepEqual(result.result.artifact.resume, {
    resume_status: "committed",
    terminal_outcome: "commit",
    head_sha: HEAD_SHA,
    prior_run_id: "run-prior",
  });
  assert.deepEqual(result.result.artifact.payload.resume, result.result.artifact.resume);
  const prIdentity = result.result.produced_identities.find((entry) => entry.resource_kind === "github_pull_request");
  assert.equal(prIdentity.identity.resource_id, "repo-1");
  const persisted = JSON.parse(fs.readFileSync(result.result.durableRecord.artifact_path, "utf8"));
  const persistedPrIdentity = persisted.produced_identities.find((entry) =>
    entry.resource_kind === "github_pull_request"
  );
  assert.equal(persistedPrIdentity.identity.resource_id, "repo-1");
});

test("runTriggeredExecution cold resume seeds reviewer notes without a warm session handle", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-cold-runner-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  const branch = "af/execution/AF-1-5215fde5";
  runDeps.coldResumeGitIntent = {
    runId: "cold_resume_pr_7_bbbbbbbbbbbb",
    artifactKind: "commit",
    git: {
      resource_id: "repo-1",
      owner: "acme",
      repo: "product",
      branch,
      head_sha: HEAD_SHA,
    },
  };
  const seenTurns = [];

  const result = await runTriggeredExecution({
    ...runOptions({ repoRoot: tempRoot, store, runDeps }),
    resumeFrom: {
      coldReconstruct: true,
      priorRunId: "cold_resume_pr_7_bbbbbbbbbbbb",
      reviewerNotes: REVIEWER_NOTES,
      smokeTests: {},
      runtimeVersion: null,
      head_sha: HEAD_SHA,
    },
    orchestratorTurnExecutor: async (input) => {
      seenTurns.push({
        firstTurnWarmStart: input.firstTurnWarmStart,
        priorTurns: structuredClone(input.priorTurns),
      });
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: commitProducedContent(input.runId),
        evidence: null,
        sessionHandle: {
          id: "fresh-cold-driver-session",
          role: "orchestrator",
          run_id: input.runId,
          runtime: "codex",
        },
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(seenTurns.length, 1);
  assert.equal(seenTurns[0].firstTurnWarmStart, null);
  assert.equal(seenTurns[0].priorTurns[0].reviewer_notes, REVIEWER_NOTES);
  assert.equal(runDeps.materializeCalls[0].pendingGitIntent.git.branch, branch);
  assert.equal(runDeps.materializeCalls[0].pendingGitIntent.git.resource_id, "repo-1");
  assert.deepEqual(
    runDeps.gitEffectCalls.find((call) => call.effectId === GIT_REPO_COMMIT_EFFECT_ID).pendingGitIntent.git,
    runDeps.materializeCalls[0].pendingGitIntent.git,
  );
  assert.deepEqual(result.result.artifact.resume, {
    resume_status: "committed",
    terminal_outcome: "commit",
    head_sha: HEAD_SHA,
    prior_run_id: "cold_resume_pr_7_bbbbbbbbbbbb",
  });
});

test("runWarmResumeIssueSyntheticWake refetches latest review notes and seeds resumeFrom", async () => {
  const statuses = [];
  const captured = [];
  const priorRun = {
    run_id: "run-prior",
    object_id: "issue-1",
    workflow_type: "execution",
    status: "completed",
    started_at: "2026-06-28T10:00:00.000Z",
    terminal_at: "2026-06-28T10:05:00.000Z",
    session_handle_pointer: {
      source: "run_artifact.runtime_metadata",
      runtime_metadata_paths: [["runtime_metadata", "orchestrator", "session_handle"]],
    },
  };
  const latestNotes = formatAfReviewCommentBody({
    body: "Latest reviewer note: keep setup OAuth-only.",
    disposition: "request-changes",
    head_sha: HEAD_SHA,
    run_id: "run-review-new",
  });

  const result = await runWarmResumeIssueSyntheticWake({
    config: loadLinearConfig({ repoRoot }),
    repoRoot,
    domain: { id: "domain-1" },
    domainContext: domainContext(),
    registry: domainRegistry(),
    issueId: "issue-1",
    priorRunId: "run-prior",
    prNumber: 7,
    head_sha: HEAD_SHA,
    store: {
      findLatestRunForObject(id) {
        assert.equal(id, "issue-1");
        return priorRun;
      },
    },
    runDeps: {
      prAdapter: {
        async listPullRequestComments(number) {
          assert.equal(number, 7);
          return [
            {
              id: "comment-old",
              body: formatAfReviewCommentBody({
                body: "Old reviewer note.",
                disposition: "request-changes",
                head_sha: HEAD_SHA,
                run_id: "run-review-old",
              }),
              created_at: "2026-06-28T10:10:00.000Z",
            },
            {
              id: "comment-new",
              body: latestNotes,
              created_at: "2026-06-28T10:12:00.000Z",
            },
          ];
        },
      },
    },
    resolveSessionHandle: () => ({
      id: "prior-driver-session",
      role: "orchestrator",
      run_id: "run-prior",
      runtime: "codex",
    }),
    isRunResumable: () => true,
    createTraceSink: () => ({ async shutdown() {} }),
    createRuntimeExecutor: () => ({}),
    runTriggeredExecutionFn: async (options) => {
      captured.push(options);
      return {
        status: "completed",
        result: {
          artifact: {
            resume: {
              resume_status: "committed",
              terminal_outcome: "commit",
              head_sha: HEAD_SHA,
              prior_run_id: "run-prior",
            },
          },
        },
      };
    },
    emitStatus: (event) => {
      statuses.push(event);
      return event;
    },
  });

  assert.equal(result.resume_status, "committed");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].retry, true);
  assert.equal(captured[0].resumeFrom.priorRunId, "run-prior");
  assert.equal(captured[0].resumeFrom.sessionHandle.id, "prior-driver-session");
  assert.equal(Object.hasOwn(captured[0].resumeFrom, "coldReconstruct"), false);
  assert.equal(Object.hasOwn(captured[0].runDeps, "coldResumeGitIntent"), false);
  assert.equal(captured[0].resumeFrom.reviewerNotes, latestNotes);
  assert.equal(captured[0].resumeFrom.head_sha, HEAD_SHA);
  assert.deepEqual(statuses.at(-1).note, {
    resume_status: "committed",
    terminal_outcome: "commit",
    head_sha: HEAD_SHA,
    prior_run_id: "run-prior",
  });
});

test("runWarmResumeIssueSyntheticWake cold-reconstructs from durable PR identity when local run state is gone", async () => {
  const captured = [];
  const branch = "af/execution/AF-1-5215fde5";
  const latestNotes = formatAfReviewCommentBody({
    body: "Cold reviewer note: continue on the existing PR.",
    disposition: "request-changes",
    head_sha: HEAD_SHA,
    run_id: "run-review-cold",
  });

  const result = await runWarmResumeIssueSyntheticWake({
    config: loadLinearConfig({ repoRoot }),
    repoRoot,
    domain: { id: "domain-1" },
    domainContext: domainContext(),
    registry: domainRegistry(),
    issueId: "issue-1",
    prNumber: 7,
    head_sha: HEAD_SHA,
    warmResumeDecision: {
      action: "warm_resume",
      resumeMode: "cold_reconstruct",
      durableIdentity: {
        resource_id: "repo-1",
        owner: "acme",
        repo: "product",
        branch,
        head_sha: HEAD_SHA,
        pull_request_number: "7",
      },
    },
    store: {
      findLatestRunForObject(id) {
        assert.equal(id, "issue-1");
        return null;
      },
    },
    runDeps: {
      prAdapter: {
        async listPullRequestComments(number) {
          assert.equal(number, 7);
          return [{
            id: "comment-cold",
            body: latestNotes,
            created_at: "2026-06-28T10:12:00.000Z",
          }];
        },
      },
    },
    createTraceSink: () => ({ async shutdown() {} }),
    createRuntimeExecutor: () => ({}),
    runTriggeredExecutionFn: async (options) => {
      captured.push(options);
      return {
        status: "completed",
        result: {
          artifact: {
            resume: {
              resume_status: "committed",
              terminal_outcome: "commit",
              head_sha: HEAD_SHA,
              prior_run_id: options.resumeFrom.priorRunId,
            },
          },
        },
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.resume_status, "committed");
  assert.equal(captured.length, 1);
  assert.equal(Object.hasOwn(captured[0].resumeFrom, "sessionHandle"), false);
  assert.equal(captured[0].resumeFrom.coldReconstruct, true);
  assert.equal(captured[0].resumeFrom.reviewerNotes, latestNotes);
  assert.equal(captured[0].resumeFrom.durableIdentity.resource_id, "repo-1");
  assert.equal(captured[0].resumeFrom.durableIdentity.pull_request_number, "7");
  assert.deepEqual(captured[0].runDeps.coldResumeGitIntent.git, {
    resource_id: "repo-1",
    owner: "acme",
    repo: "product",
    branch,
    head_sha: HEAD_SHA,
  });
  assert.equal(captured[0].resumeFrom.priorRunId, `cold_resume_pr_7_${HEAD_SHA.slice(0, 12)}`);
});

test("warm resume escalates without reconstruction when no prior run is resumable", async () => {
  const statuses = [];
  const result = await runWarmResumeIssueSyntheticWake({
    config: executionConfig(),
    repoRoot,
    domain: { id: "domain-1" },
    domainContext: domainContext(),
    issueId: "issue-1",
    priorRunId: "run-prior",
    prNumber: 7,
    head_sha: HEAD_SHA,
    store: {
      findLatestRunForObject() {
        return null;
      },
    },
    emitStatus: (event) => {
      statuses.push(event);
      return event;
    },
  });

  assert.equal(result.status, "failed_closed");
  assert.equal(result.reason, "warm_resume_prior_run_missing");
  assert.equal(result.resume_status, "escalated_unresumable");
  assert.deepEqual(statuses.at(-1).note, {
    resume_status: "escalated_unresumable",
    terminal_outcome: null,
    head_sha: HEAD_SHA,
    prior_run_id: "run-prior",
  });
});

function runOptions({ repoRoot, store, runDeps }) {
  return {
    issueId: "issue-1",
    domainContext: domainContext(),
    registry: domainRegistry(),
    claim: {
      ok: true,
      leaseToken: "lease-1",
      event: {
        id: "event-1",
        event_id: "evt-1",
        provider: "linear",
      },
      wake: {
        id: "wake-1",
        workspace_id: "workspace-1",
        domain_id: "domain-1",
        trigger_type: "linear.issue.ready",
        workflow_type: "execution",
        object_type: "issue",
        object_id: "issue-1",
        team_ids: ["team-1"],
        created_at: "2026-06-26T00:00:00.000Z",
        attempt_count: 0,
        source_event_id: "event-1",
        status: "leased",
        lease_token: "lease-1",
      },
    },
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: {
      async getIssueContext(issueId) {
        return {
          id: issueId,
          identifier: "AF-1",
          title: "Implement warm resume",
          description: "Fix review feedback.",
          state: { id: "state-ready", name: "Ready", type: "unstarted" },
          relations: [],
        };
      },
    },
    config: executionConfig(),
    cache: { workspaceId: "workspace-1", teamId: "team-1" },
    repoRoot,
    runStoreDir: path.join(repoRoot, ".teami", "runs"),
    runtimeExecutor: {
      async executeSubagent() {
        throw new Error("subagent executor should not be called by this one-turn fixture");
      },
    },
    runDeps,
  };
}

function commitProducedContent(runId) {
  return {
    pr_title: `Fix review feedback for ${runId}`,
    pr_body: "Addresses the reviewer feedback.",
    linear_issue_id: "issue-1",
    source_refs: [{ kind: "linear_issue", id: "issue-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

function createRunDeps({ tempRoot, store }) {
  const calls = [];
  const runDeps = {
    materializeCalls: [],
    teardownCalled: false,
    gitEffectCalls: calls,
    store,
    executionProfilePreflight: greenExecutionProfilePreflight,
    async materialize(input) {
      runDeps.materializeCalls.push(input);
      const selected = input.domainResources[0];
      const selectedResourceId = selected?.id || "repo-1";
      const selectedResource = {
        id: selectedResourceId,
        kind: selected?.kind || "git_repo",
        role: selected?.role || "primary",
        handle: {
          workingDir: tempRoot,
          baseSha: "base-sha",
          owner: selected?.binding?.owner || "acme",
          repo: selected?.binding?.repo || "product",
          default_branch: selected?.binding?.default_branch || "main",
        },
      };
      return {
        runContext: {
          runId: input.runId,
          engineRepoRoot: input.engineRepoRoot,
          resources: {
            [selectedResourceId]: selectedResource,
          },
          selectedResourceId,
          selectedResource,
          resourceManifest: [{
            kind: selectedResource.kind,
            id: selectedResourceId,
            role: selectedResource.role,
            label: "acme/product",
          }],
          ...(input.pendingGitIntent ? { pendingGitIntent: input.pendingGitIntent } : {}),
        },
        async teardownAll() {
          runDeps.teardownCalled = true;
        },
      };
    },
    prAdapter: {
      name: "fake-pr-adapter",
    },
    gitEffect: {
      effects: [
        fakeEffect(GIT_REPO_COMMIT_EFFECT_ID, calls, {
          owner: "acme",
          repo: "product",
          resource_id: "repo-1",
          branch: "af/execution/AF-1-5215fde5",
          head_sha: "abc123",
          base_sha: "base-sha",
          pull_request: {
            id: "pr-1",
            number: 7,
            url: "https://github.example/acme/product/pull/7",
          },
        }),
        fakeEffect(LINEAR_ISSUE_IN_REVIEW_EFFECT_ID, calls, {
          linear_issue_id: "issue-1",
          issue_key: "AF-1",
          status_id: "state-in-review",
          status: "In Review",
        }),
      ],
    },
  };
  return runDeps;
}

async function greenExecutionProfilePreflight({ resourceId }) {
  return {
    ok: true,
    resource_id: resourceId,
    strict_baseline_green: false,
  };
}

function fakeEffect(effectId, calls, identity) {
  return {
    id: effectId,
    async probe() {
      return { satisfied: false };
    },
    async apply(ctx) {
      calls.push({
        effectId,
        issueId: ctx.issueId,
        prAdapter: ctx.prAdapter?.name || null,
        hasSelectedResource: Boolean(ctx.runContext?.selectedResource),
        pendingGitIntent: ctx.pendingGitIntent ? structuredClone(ctx.pendingGitIntent) : null,
      });
      return { ok: true, identity };
    },
    async verify() {
      return { ok: true };
    },
  };
}

function createFakeStore() {
  const wakes = new Map();
  const runs = new Map();
  return {
    triggerEvents: [],
    async heartbeat() {
      return { ok: true };
    },
    async renewLease({ wakeId }) {
      return { ok: true, wake: wakes.get(wakeId) || null };
    },
    async markWakeRunning({ wakeId, runnerId, leaseToken, runId, domainId }) {
      const wake = wakes.get(wakeId) || {
        id: wakeId,
        workspace_id: "workspace-1",
        object_id: "issue-1",
        workflow_type: "execution",
        object_type: "issue",
      };
      Object.assign(wake, {
        status: "running",
        runner_id: runnerId,
        lease_token: leaseToken,
        run_id: runId,
        domain_id: domainId,
      });
      wakes.set(wakeId, wake);
      runs.set(runId, { run_id: runId, wake_id: wakeId, status: "running" });
      return { ok: true, wake };
    },
    async completeWake({ wakeId, status, reason, providerUpdateIds = [], artifactPointer = null, artifact = null }) {
      const wake = wakes.get(wakeId);
      Object.assign(wake, { status, reason, provider_update_ids: providerUpdateIds });
      const run = runs.get(wake.run_id);
      Object.assign(run, {
        status,
        terminal_reason: reason,
        provider_update_ids: providerUpdateIds,
        artifact_pointer: artifactPointer,
        runtime_metadata: artifact?.runtime_metadata || {},
      });
      return { ok: true, wake, run };
    },
    async getWake(wakeId) {
      return wakes.get(wakeId) || null;
    },
  };
}

function writeExecutionAcceptedPromptFixture(root) {
  const namespaceRoot = path.join(root, "execution", "evals", "execution");
  const promptDir = path.join(namespaceRoot, "accepted-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const snapshotPath = path.join(promptDir, "orchestrator-governing.md");
  const snapshot = [
    "# Execution Orchestrator",
    "",
    "```yaml",
    "target_key: prompt/execution/orchestrator_governing",
    "```",
    "",
    "## Role",
    "Coordinate execution work and terminate with a pull request payload.",
    "",
  ].join("\n");
  fs.writeFileSync(snapshotPath, snapshot, "utf8");
  const snapshotSha256 = createHash("sha256").update(Buffer.from(snapshot)).digest("hex");
  fs.writeFileSync(
    path.join(namespaceRoot, "phoenix-assets.json"),
    `${JSON.stringify({
      prompts: [{
        target_key: "prompt/execution/orchestrator_governing",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        role: "orchestrator",
        snapshot_path: "execution/evals/execution/accepted-prompts/orchestrator-governing.md",
        snapshot_sha256: snapshotSha256,
      }],
    }, null, 2)}\n`,
    "utf8",
  );
}

function domainContext() {
  return {
    domainId: "domain-1",
    status: "active",
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "AF",
      teamName: "Teami",
      webhookId: "webhook-1",
      cachePath: "unused-cache.json",
    },
    trace: {
      domain_id: "domain-1",
      workspace_id: "workspace-1",
      team_id: "team-1",
      behavior_repo_id: "local:test",
    },
    resources: [{
      id: "repo-1",
      kind: "git_repo",
      role: "primary",
      binding: {
        owner: "acme",
        repo: "product",
        default_branch: "main",
      },
    }],
  };
}

function domainRegistry() {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [{
      id: "domain-1",
      status: "active",
      linear: {
        workspace_id: "workspace-1",
        workspace_name: "Workspace",
        team_id: "team-1",
        team_key: "AF",
        team_name: "Teami",
        team_name_last_seen_at: "2026-06-26T00:00:00.000Z",
        provisioned_by_teami: true,
        webhook_id: "webhook-1",
        cache_path: ".teami/domains/domain-1/linear.json",
      },
      resources: domainContext().resources,
      policy_profile: "default",
      policy_overlay_ref: null,
    }],
  };
}

function executionConfig() {
  return {
    runtime: {
      adapters: {
        codex: {
          command: "codex",
          tool_policy: {
            linear_write: false,
          },
        },
      },
    },
    workflows: {
      execution: {
        roles: {
          worker: {},
          orchestrator: {},
        },
      },
    },
    linear: {
      team: {
        key: "AF",
        name: "Teami",
      },
    },
  };
}
