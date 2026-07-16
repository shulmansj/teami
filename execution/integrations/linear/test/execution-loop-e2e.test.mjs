import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeTeamResources } from "../../../engine/materialize.mjs";
import { branchNameForIssue } from "../../git/git-repo-commit-effect.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  makeTeamRecord,
} from "../src/team-registry.mjs";
import { buildTeamContext } from "../src/team-resolver.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import {
  gatewayState,
  processReadyIssue,
  runFreshIssueSyntheticWake,
} from "../src/gateway-loop.mjs";
import * as triggerIdempotency from "../src/trigger-idempotency.mjs";
import { runTriggeredExecutionForTest as runTriggeredExecution } from "../src/trigger-runner.mjs";
import { GIT_REPO_COMMIT_EFFECT_ID } from "../src/workflows/execution/effect-ids.mjs";

test("Ready issue execution poll composes decide, synthetic dispatch, run, effects, and replay over evolving state", async (t) => {
  registerGitRepoResourceKind();
  // Seed parent-process write credentials so the containment assertions below prove the
  // engine STRIPS a credential that is actually present (not merely that none happened to
  // be set). Restored in t.after so it never leaks into other suites in the same run.
  const priorWriteCredentialEnv = seedParentWriteCredentialEnv();
  t.after(() => restoreParentEnv(priorWriteCredentialEnv));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-loop-e2e-"));
  process.env.TEAMI_HOME = tempRoot;
  writeExecutionAcceptedPromptFixture(tempRoot);

  const gitFixture = createGitFixture(tempRoot);
  const runStoreDir = path.join(tempRoot, "teams", "team-1", "runs");
  const team = teamFixture();
  const registry = { schema_version: TEAM_REGISTRY_SCHEMA_VERSION, teams: [team] };
  const config = executionConfig();
  const teamContext = buildTeamContext({
    team,
    config,
    repoRoot: tempRoot,
    home: tempRoot,
    behaviorRepoId: "local:execution-loop-e2e",
  });
  const linearCache = writeExecutionLinearCache(teamContext.linear.cachePath);
  const linearClient = createMutableLinearClient();
  assert.deepEqual(Object.keys(linearCache.issueStatuses), [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "human_review",
    "needs_principal",
    "done",
  ]);
  assert.deepEqual(
    (await linearClient.listReadyIssueCandidates("team-1", {
      readyStateId: linearCache.issueStatuses.todo,
    })).candidates.map((candidate) => candidate.id),
    ["issue-1", "issue-dependent", "issue-kill-replay"],
  );
  const triggerStore = createMutableTriggerStore({ repoRoot: tempRoot, runStoreDir });
  const prAdapter = createFakePrAdapter();
  const runtimeExecutor = {
    async executeSubagent() {
      throw new Error("subagent executor should not be called by this one-turn fixture");
    },
  };
  const turnObservations = [];
  const turnCounts = new Map();
  const orchestratorTurnExecutor = async (input) => {
    const count = (turnCounts.get(input.runId) || 0) + 1;
    turnCounts.set(input.runId, count);
    assert.equal(count, 1, "fixture orchestrator should terminate in one turn");
    assert.ok(input.cwd, "materialized git checkout should be the run cwd");
    assert.equal(fs.existsSync(input.cwd), true, "materialized run cwd should exist during the turn");
    assertNoWriteCredentialEnv(input.envAugment || {});
    fs.writeFileSync(
      path.join(input.cwd, `${safeFileSegment(input.project.identifier)}-${input.runId}.txt`),
      [
        `run_id: ${input.runId}`,
        `issue_id: ${input.project.id}`,
        `title: ${input.project.title}`,
        "",
      ].join("\n"),
      "utf8",
    );
    turnObservations.push({
      runId: input.runId,
      issueId: input.project.id,
      cwd: input.cwd,
      cwdExisted: fs.existsSync(input.cwd),
      envAugment: { ...(input.envAugment || {}) },
    });
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: {
        pr_title: `Implement ${input.project.identifier}`,
        pr_body: `Adds the deterministic fixture change for ${input.project.identifier}.`,
        linear_issue_id: input.project.id,
        source_refs: [{ kind: "linear_issue", id: input.project.id }],
        assumptions: [],
        constraints: ["fixture must not use live GitHub or Linear"],
        risks: [],
      },
      evidence: null,
      sessionHandle: null,
    };
  };

  const baseRunDeps = {
    prAdapter,
    gitRemoteUrlOverride: gitFixture.remote,
    executionProfilePreflight: greenExecutionProfilePreflight,
    materialize: (input) => materializeTeamResources({
      ...input,
      gitRemoteUrlOverride: gitFixture.remote,
    }),
  };
  const state = gatewayState({ maxInFlight: 1 });
  const freshDispatches = [];
  const runFreshIssue = async (input) => {
    freshDispatches.push(input.issueId);
    return runFreshIssueSyntheticWake({
      config,
      ...input,
      repoRoot: tempRoot,
      home: tempRoot,
      runStoreDir,
      registry,
      team,
      teamContext,
      createStore: () => triggerStore,
      createSetupGraphqlClient: () => ({ client: linearClient }),
      createTraceSink: createNoopTraceSink,
      createRuntimeExecutor: () => runtimeExecutor,
      runDeps: { ...baseRunDeps, ...(input.runDeps || {}) },
      // Keep the real synthetic dispatch and real runner; this wrapper only
      // installs the one-turn orchestrator seam the production dispatch does
      // not expose directly.
      runTriggeredExecutionFn: (options) =>
        runTriggeredExecution({
          ...options,
          executionReadiness: () => ({ ok: true }),
          orchestratorTurnExecutor,
        }),
    });
  };
  const pollIssue = (issueId, extra = {}) =>
    processReadyIssue({
      config,
      repoRoot: tempRoot,
      home: tempRoot,
      runStoreDir,
      registry,
      team,
      teamContext,
      cache: linearCache,
      client: linearClient,
      candidate: { id: issueId },
      executionReadiness: () => ({ ok: true }),
      idempotency: triggerIdempotency,
      runFreshIssue,
      runDeps: { ...baseRunDeps, ...(extra.runDeps || {}) },
      state,
      runTimeoutMs: 0,
      ...withoutRunDeps(extra),
    });

  const first = await pollIssue("issue-1");
  assert.equal(first.action, "fresh");
  assert.equal(first.status, "started");
  await waitForIdle(state, "issue-1");

  const firstCompletion = triggerStore.completedForIssue("issue-1").at(-1);
  assert.equal(firstCompletion.status, "completed");
  assert.equal(linearClient.issueStateName("issue-1"), "In Review");
  const issueOneStateUpdates = linearClient.updatesForIssue("issue-1").map((update) => update.stateId);
  assert.equal(
    issueOneStateUpdates[0],
    "state-in-progress",
    "execution should claim the issue in In Progress before review",
  );
  assert.deepEqual(issueOneStateUpdates, [
    "state-in-progress",
    "state-in-review",
  ]);
  const firstPrIdentity = onlyGithubPrIdentity(firstCompletion.artifact);
  const issueOneBranch = branchNameForIssue("AF-1");
  assert.equal(firstPrIdentity.effect_id, GIT_REPO_COMMIT_EFFECT_ID);
  assert.equal(firstPrIdentity.identity.resource_id, "repo-1");
  assert.equal(firstPrIdentity.identity.branch, issueOneBranch);
  assert.match(firstPrIdentity.identity.branch, /^af\/execution\/AF-1-/);
  assert.equal(prAdapter.created.length, 1);
  assert.equal(prAdapter.created[0].head.ref, firstPrIdentity.identity.branch);

  const firstMarker = triggerIdempotency.readGitReplayPending({
    teamRef: "team-1",
    objectId: "issue-1",
    repoRoot: tempRoot,
    runStoreDir,
  });
  assert.equal(firstMarker.runId, firstCompletion.artifact.run_id);
  assert.equal(firstMarker.git.resource_id, "repo-1");
  assert.equal(firstMarker.git.branch, firstPrIdentity.identity.branch);
  assert.equal(firstMarker.git.head_sha, firstPrIdentity.identity.head_sha);
  assert.ok(firstMarker.git.tree_sha, "NS-3 git replay marker should include the observed tree");

  const secondFresh = await runFreshIssue({ issueId: "issue-1", retry: true });
  assert.equal(secondFresh.status, "completed");
  const secondCompletion = triggerStore.completedForIssue("issue-1").at(-1);
  assert.notEqual(secondCompletion.artifact.run_id, firstCompletion.artifact.run_id);
  const secondPrIdentity = onlyGithubPrIdentity(secondCompletion.artifact);
  assert.equal(secondPrIdentity.identity.branch, issueOneBranch);
  assert.notEqual(secondPrIdentity.identity.head_sha, firstPrIdentity.identity.head_sha);
  assert.equal(freshDispatches.filter((issueId) => issueId === "issue-1").length, 2);
  assert.equal(prAdapter.created.length, 1, "fresh fix attempt must reuse the issue PR");
  assert.match(
    remoteFile(gitFixture.remote, issueOneBranch, `AF-1-${secondCompletion.artifact.run_id}.txt`),
    new RegExp(`run_id: ${secondCompletion.artifact.run_id}`),
  );
  const secondMarker = triggerIdempotency.readGitReplayPending({
    teamRef: "team-1",
    objectId: "issue-1",
    repoRoot: tempRoot,
    runStoreDir,
  });
  assert.equal(secondMarker.runId, secondCompletion.artifact.run_id);
  assert.equal(secondMarker.git.branch, issueOneBranch);
  assert.equal(secondMarker.git.head_sha, secondPrIdentity.identity.head_sha);
  assert.notEqual(secondMarker.git.head_sha, firstMarker.git.head_sha);
  assert.deepEqual(
    triggerIdempotency.listGitReplayPending({ teamRef: "team-1", repoRoot: tempRoot, runStoreDir })
      .filter((marker) => marker.objectId === "issue-1")
      .map((marker) => marker.runId),
    [secondCompletion.artifact.run_id],
  );

  assert.equal(linearClient.issueStateName("issue-dependent"), "Todo");
  const blocked = await pollIssue("issue-dependent");
  assert.equal(blocked.action, "skipped");
  assert.equal(blocked.reason, "dependency_blocked");
  assert.deepEqual(blocked.blockingIssueIds, ["issue-blocker"]);
  assert.equal(state.inFlight.has("issue-dependent"), false);
  assert.equal(prAdapter.created.length, 1);

  linearClient.setIssueState("issue-blocker", "state-done");
  const unblocked = await pollIssue("issue-dependent");
  assert.equal(unblocked.action, "fresh");
  assert.equal(unblocked.status, "started");
  await waitForIdle(state, "issue-dependent");
  assert.equal(linearClient.issueStateName("issue-dependent"), "In Review");
  assert.equal(prAdapter.created.length, 2);
  const dependentCompletion = triggerStore.completedForIssue("issue-dependent").at(-1);
  assert.equal(onlyGithubPrIdentity(dependentCompletion.artifact).identity.branch, branchNameForIssue("AF-3"));

  const credentialProofs = turnObservations.map((entry) => {
    const completion = triggerStore.completedForIssue(entry.issueId).find(
      (candidate) => candidate.artifact?.run_id === entry.runId,
    );
    return {
      cwdExisted: entry.cwdExisted,
      hasCredentialEnvAugment: hasWriteCredentialEnv(entry.envAugment),
      agentWriteCredentialsPresent: completion?.artifact?.environment?.agent_write_credentials_present,
    };
  });
  assert.ok(credentialProofs.length >= 2);
  assert.ok(credentialProofs.every((entry) => entry.cwdExisted === true));
  assert.ok(credentialProofs.every((entry) => entry.hasCredentialEnvAugment === false));
  assert.ok(credentialProofs.every((entry) => entry.agentWriteCredentialsPresent === false));
  // The seeded credential was live in the parent process during every run above, so
  // "agentWriteCredentialsPresent === false" in each artifact proves the engine stripped a
  // credential that was actually PRESENT — not a coincidental absence.
  assert.equal(
    process.env.GH_TOKEN,
    SEEDED_WRITE_CREDENTIAL_ENV.GH_TOKEN,
    "parent process retained the seeded write credential across the runs",
  );

  let killCount = 0;
  const killedFresh = await pollIssue("issue-kill-replay", {
    killPoint: "after_git_push_before_pr",
    runDeps: {
      killPoint: async (point, ctx) => {
        assert.equal(point, "after_git_push_before_pr");
        assert.equal(ctx.issueId, "issue-kill-replay");
        killCount += 1;
        throw new Error("simulated_crash_after_push_before_pr");
      },
    },
  });
  assert.equal(killedFresh.action, "fresh");
  await waitForIdle(state, "issue-kill-replay");
  assert.equal(killCount, 1);
  assert.equal(linearClient.issueStateName("issue-kill-replay"), "In Progress");
  assert.equal(prAdapter.created.length, 2, "crash before PR-open must not create a PR");

  const killedMarker = triggerIdempotency.readGitReplayPending({
    teamRef: "team-1",
    objectId: "issue-kill-replay",
    repoRoot: tempRoot,
    runStoreDir,
  });
  assert.equal(killedMarker.git.branch, branchNameForIssue("AF-4"));
  assert.equal(Object.hasOwn(killedMarker.git, "head_sha"), false);
  assert.equal(Object.hasOwn(killedMarker.git, "tree_sha"), false);

  const killedReplay = await pollIssue("issue-kill-replay");
  assert.equal(killedReplay.action, "replay");
  await waitForIdle(state, "issue-kill-replay");
  assert.equal(linearClient.issueStateName("issue-kill-replay"), "In Review");
  assert.equal(
    prAdapter.created.filter((pr) => pr.head.ref === killedMarker.git.branch).length,
    1,
    "after-push replay should open exactly one PR for the pushed branch",
  );
  assert.equal(prAdapter.created.length, 3);
});

function withoutRunDeps(options) {
  const { runDeps, ...rest } = options;
  return rest;
}

function createMutableLinearClient() {
  const states = [
    { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
    { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
    { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
  ];
  const byStateId = new Map(states.map((state) => [state.id, state]));
  const issues = new Map([
    issueRecord({ id: "issue-1", identifier: "AF-1", title: "Implement loop execution" }),
    issueRecord({ id: "issue-blocker", identifier: "AF-2", title: "Complete prerequisite", stateId: "state-in-progress" }),
    issueRecord({
      id: "issue-dependent",
      identifier: "AF-3",
      title: "Run after prerequisite",
      blockedBy: ["issue-blocker"],
    }),
    issueRecord({ id: "issue-kill-replay", identifier: "AF-4", title: "Replay pushed branch" }),
  ].map((issue) => [issue.id, issue]));

  const client = {
    async listWorkflowStates(teamId) {
      assert.equal(teamId, "team-1");
      return states.map((state) => ({ ...state }));
    },
    async listPlannedProjectCandidates() {
      return { candidates: [], pageInfo: { hasNextPage: false, endCursor: null } };
    },
    async listReadyIssueCandidates(teamId, page = {}) {
      assert.equal(teamId, "team-1");
      assert.equal(page.readyStateId, "state-todo");
      return {
        candidates: [...issues.values()]
          .filter((issue) => issue.stateId === page.readyStateId)
          .map((issue) => ({ id: issue.id, createdAt: issue.createdAt })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async getIssueContext(id) {
      return issueView(id);
    },
    async getIssue(id) {
      return issueView(id);
    },
    async updateIssue(id, input) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`unknown issue: ${id}`);
      if (input.stateId) {
        if (!byStateId.has(input.stateId)) throw new Error(`unknown state: ${input.stateId}`);
        issue.stateId = input.stateId;
        issue.updates.push({ stateId: input.stateId });
      }
      if (Array.isArray(input.labelIds)) issue.labelIds = [...input.labelIds];
      return issueView(id);
    },
    async findIssueLabelsByName() {
      return [];
    },
    setIssueState(id, stateId) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`unknown issue: ${id}`);
      if (!byStateId.has(stateId)) throw new Error(`unknown state: ${stateId}`);
      issue.stateId = stateId;
    },
    issueStateName(id) {
      return issueState(issues.get(id)).name;
    },
    updatesForIssue(id) {
      return [...(issues.get(id)?.updates || [])];
    },
  };

  function issueView(id) {
    const issue = issues.get(id);
    if (!issue) throw new Error(`unknown issue: ${id}`);
    const state = issueState(issue);
    return structuredClone({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: `https://linear.test/${issue.identifier}`,
      createdAt: issue.createdAt,
      team: { id: "team-1", key: "AF", name: "Teami" },
      project: { id: "project-1", name: "Project", url: "https://linear.test/project-1" },
      assignee: null,
      labels: [],
      state,
      relations: issue.blockedBy.map((blockerId, index) => {
        const blocker = issues.get(blockerId);
        return {
          id: `relation-${issue.id}-${index}`,
          type: "blocks",
          issue: {
            id: blocker.id,
            identifier: blocker.identifier,
            title: blocker.title,
            state: issueState(blocker),
          },
          relatedIssue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            state,
          },
        };
      }),
    });
  }

  function issueState(issue) {
    return { ...byStateId.get(issue.stateId) };
  }

  return client;
}

function issueRecord({
  id,
  identifier,
  title,
  stateId = "state-todo",
  blockedBy = [],
  createdAt = "2026-06-25T10:00:00.000Z",
}) {
  return {
    id,
    identifier,
    title,
    stateId,
    blockedBy,
    createdAt,
    updates: [],
    description: `- Decomposition key: ${id}\n\nFixture body for ${identifier}.`,
  };
}

function createMutableTriggerStore({ repoRoot, runStoreDir }) {
  const wakes = new Map();
  const runs = new Map();
  const completed = [];
  const claims = [];
  let sequence = 0;
  let mutationTick = 0;
  return {
    claims,
    completed,
    triggerEvents: [],
    async claimSyntheticIssueWake({
      teamRef,
      workspaceId,
      teamId,
      objectId,
      workflowType,
      triggerType,
      objectType,
    }) {
      sequence += 1;
      const event = {
        id: `event-${sequence}`,
        event_id: `evt-${sequence}`,
        provider: "linear",
        object: { id: objectId },
      };
      const wake = {
        id: `wake-${safeRunIdSegment(objectId)}-${sequence}`,
        workspace_id: workspaceId,
        team_ref: teamRef,
        trigger_type: triggerType,
        workflow_type: workflowType,
        object_type: objectType,
        object_id: objectId,
        team_ids: [teamId],
        created_at: new Date(Date.parse("2026-06-26T00:00:00.000Z") + sequence * 1000).toISOString(),
        attempt_count: 0,
        source_event_id: event.id,
        status: "leased",
        lease_token: `lease-${sequence}`,
      };
      wakes.set(wake.id, wake);
      this.triggerEvents.push(event);
      claims.push({ issueId: objectId, wakeId: wake.id });
      return { ok: true, wake: structuredClone(wake), event, leaseToken: wake.lease_token };
    },
    async heartbeat() {
      return { ok: true };
    },
    async renewLease({ wakeId }) {
      return { ok: true, wake: structuredClone(wakes.get(wakeId)) };
    },
    async markWakeRunning({ wakeId, runnerId, leaseToken, runId, teamRef }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, {
        status: "running",
        runner_id: runnerId,
        lease_token: leaseToken,
        run_id: runId,
        team_ref: teamRef,
      });
      runs.set(runId, {
        run_id: runId,
        wake_id: wakeId,
        issue_id: wake.object_id,
        status: "running",
      });
      return { ok: true, wake: structuredClone(wake) };
    },
    async markMutationStarted({ wakeId, runnerId, leaseToken, runId, artifactKind, git }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      mutationTick += 1;
      wake.runner_id = runnerId;
      wake.lease_token = leaseToken;
      wake.mutation_started_at = new Date(Date.parse("2026-06-26T01:00:00.000Z") + mutationTick * 1000).toISOString();
      triggerIdempotency.writeMutationIntent({
        teamRef: wake.team_ref,
        objectType: "issue",
        objectId: wake.object_id,
        runId,
        artifactKind,
        wakeId,
        startedAt: wake.mutation_started_at,
        workflowType: wake.workflow_type,
        triggerType: wake.trigger_type,
        git,
        repoRoot,
        runStoreDir,
      });
      return { ok: true, wake: structuredClone(wake) };
    },
    async completeWake({ wakeId, status, reason, providerUpdateIds = [], artifactPointer = null, artifact = null }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, { status, reason, provider_update_ids: providerUpdateIds });
      const run = runs.get(wake.run_id) || {
        run_id: wake.run_id,
        wake_id: wakeId,
        issue_id: wake.object_id,
      };
      Object.assign(run, {
        status,
        terminal_reason: reason,
        provider_update_ids: providerUpdateIds,
        artifact_pointer: artifactPointer,
        runtime_metadata: artifact?.runtime_metadata || {},
      });
      runs.set(run.run_id, run);
      completed.push({
        issueId: wake.object_id,
        status,
        reason,
        wake: structuredClone(wake),
        run: structuredClone(run),
        artifact: structuredClone(artifact),
      });
      return { ok: true, wake: structuredClone(wake), run: structuredClone(run) };
    },
    async deadLetterWake({ wakeId, reason }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, { status: "dead_letter", reason });
      return { ok: true, wake: structuredClone(wake) };
    },
    async getWake(wakeId) {
      const wake = wakes.get(wakeId);
      return wake ? structuredClone(wake) : null;
    },
    completedForIssue(issueId) {
      return completed.filter((entry) => entry.issueId === issueId);
    },
  };
}

function createFakePrAdapter() {
  const created = [];
  return {
    created,
    async probePullRequest({ head, base }) {
      return created.find((pr) => pr.head.ref === head && pr.base.ref === base) || null;
    },
    async ensurePullRequest({ title, body, head, base }) {
      const existing = await this.probePullRequest({ head, base });
      if (existing) return { created: false, pr: existing };
      const pr = {
        id: `pr-${created.length + 1}`,
        number: created.length + 1,
        state: "open",
        title,
        body,
        head: { ref: head, label: `acme:${head}` },
        base: { ref: base },
        url: `https://github.example/acme/product/pull/${created.length + 1}`,
        html_url: `https://github.example/acme/product/pull/${created.length + 1}`,
      };
      created.push(pr);
      return { created: true, pr };
    },
  };
}

function createNoopTraceSink() {
  return {
    async startRun() {
      return { ok: true, traceId: "trace-execution-loop-e2e" };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun() {
      return { status: "stored" };
    },
    async shutdown() {},
  };
}

function writeExecutionLinearCache(cachePath) {
  const cache = {
    teamId: "team-1",
    issueStatuses: {
      backlog: "state-backlog",
      todo: "state-todo",
      in_progress: "state-in-progress",
      in_review: "state-in-review",
      human_review: "state-human-review",
      needs_principal: "state-needs-principal",
      done: "state-done",
    },
    projectStatuses: {
      planned: "status-planned",
      in_progress: "status-in-progress",
      completed: "status-completed",
    },
    issueLabels: {
      Discovery: "label-discovery",
      "Needs Principal": "label-needs-principal",
      "human-review": "label-human-review",
    },
  };
  writeLinearCache(cachePath, cache);
  return cache;
}

function onlyGithubPrIdentity(artifact) {
  const identities = (artifact?.produced_identities || [])
    .filter((entry) => entry.resource_kind === "github_pull_request");
  assert.equal(identities.length, 1);
  return identities[0];
}

async function greenExecutionProfilePreflight({ resourceId }) {
  return {
    ok: true,
    resource_id: resourceId,
    strict_baseline_green: false,
  };
}

async function waitForIdle(state, issueId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!state.inFlight.has(issueId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`issue remained in-flight: ${issueId}`);
}

function assertNoWriteCredentialEnv(env) {
  assert.equal(hasWriteCredentialEnv(env), false, `worker env included write credentials: ${Object.keys(env).join(", ")}`);
}

function hasWriteCredentialEnv(env) {
  return Object.keys(env || {}).some((key) =>
    [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ACCESS_TOKEN",
      "GITHUB_PAT",
      "GIT_ASKPASS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
    ].includes(key.toUpperCase())
  );
}

// Harmless non-token values (deliberately NOT token-shaped, so the source-mode secret scan
// stays quiet). scrubChildEnv strips by KEY name, so the value is irrelevant to the strip.
const SEEDED_WRITE_CREDENTIAL_ENV = Object.freeze({
  GH_TOKEN: "fixture-write-credential-must-be-stripped",
  GITHUB_TOKEN: "fixture-write-credential-must-be-stripped",
});

function seedParentWriteCredentialEnv() {
  const prior = {};
  for (const [key, value] of Object.entries(SEEDED_WRITE_CREDENTIAL_ENV)) {
    prior[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
    process.env[key] = value;
  }
  return prior;
}

function restoreParentEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createGitFixture(root) {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  git(["init", "--bare", remote]);
  git(["init"], source);
  git(["config", "user.name", "Fixture Author"], source);
  git(["config", "user.email", "fixture@example.invalid"], source);
  fs.writeFileSync(path.join(source, "README.md"), "# Product\n", "utf8");
  git(["add", "README.md"], source);
  git(["commit", "-m", "Initial commit"], source);
  git(["branch", "-M", "main"], source);
  git(["remote", "add", "origin", remote], source);
  git(["push", "-u", "origin", "main"], source);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { remote, source };
}

function git(args, cwd = undefined) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function remoteFile(remote, branch, filePath) {
  return git(["--git-dir", remote, "show", `${branch}:${filePath}`]).stdout;
}

function writeExecutionAcceptedPromptFixture(repoRoot) {
  const namespaceRoot = path.join(repoRoot, "execution", "evals", "execution");
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
  return namespaceRoot;
}

function teamFixture() {
  return makeTeamRecord({
    teamRef: "team-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
    teamNameLastSeenAt: "2026-06-26T00:00:00.000Z",
    webhookId: "webhook-1",
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
  });
}

function executionConfig() {
  return {
    runner: {
      lease_duration_ms: 60_000,
    },
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
        git: {
          author: {
            name: "AF Bot",
            email: "af@example.invalid",
          },
        },
      },
    },
    git: {
      execution_diff_budget: {
        maxChangedFiles: 20,
        maxTotalBytes: 50_000,
        maxDeletionRatio: 0.95,
        minDeletedLinesForRatio: 200,
      },
    },
    linear: {
      oauth: {
        credential_storage: "file",
        client_id: "client-id",
        redirect_uri: "http://localhost/callback",
      },
      team: {
        key: "AF",
        name: "Teami",
      },
      issue: {
        labels: {
          discovery: "Discovery",
          needs_principal: "Needs Principal",
          human_review: "human-review",
        },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          human_review: { name: "Principal Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
          done: { name: "Done", type: "completed" },
        },
      },
    },
  };
}

function safeRunIdSegment(value) {
  return String(value || "issue").replace(/[^A-Za-z0-9_-]/g, "_");
}

function safeFileSegment(value) {
  return String(value || "issue").replace(/[^A-Za-z0-9._-]/g, "_");
}
