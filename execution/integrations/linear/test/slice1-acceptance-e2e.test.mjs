import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeDomainResources } from "../../../engine/materialize.mjs";
import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  makeDomainRecord,
} from "../src/domain-registry.mjs";
import { buildDomainContext } from "../src/domain-resolver.mjs";
import { writeLinearCache } from "../src/cache.mjs";
import {
  gatewayState,
  processReadyIssue,
  processReviewIssue,
  runFreshIssueSyntheticWake,
  runFreshReviewSyntheticWake,
  runWarmResumeIssueSyntheticWake,
} from "../src/gateway-loop.mjs";
import * as triggerIdempotency from "../src/trigger-idempotency.mjs";
import {
  runTriggeredExecutionForTest as runTriggeredExecution,
  runTriggeredReview,
} from "../src/trigger-runner.mjs";
import { renderResourceTargetBlock } from "../src/resource-target.mjs";
import {
  parseRemediationMarker,
  renderRemediationMarker,
} from "../src/remediation-marker.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  formatAfReviewCommentBody,
} from "../src/execution-pr-adapter.mjs";
import { ISSUE_NEEDS_PRINCIPAL_EFFECT_ID } from "../src/linear/issue-needs-principal-effect.mjs";

test("Slice-1 rows 1, 5, 6: one-repo default backfills, runs from a fresh clone, scrubs write tokens, and reaches review", async (t) => {
  registerGitRepoResourceKind();
  const priorEnv = seedParentWriteCredentialEnv();
  t.after(() => restoreParentEnv(priorEnv));

  const issue = codeIssue({
    id: "issue-one-repo",
    identifier: "AF-101",
    title: "Implement one repo default",
  });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [issue],
  });
  const adopterCheckout = path.join(fixture.tempRoot, "adopter-checkout");
  fs.mkdirSync(adopterCheckout, { recursive: true });
  fs.writeFileSync(path.join(adopterCheckout, "README.md"), "This checkout must not be used.\n", "utf8");

  const execution = await fixture.runReadyIssue({
    issueId: issue.id,
    turn: ({ input }) => {
      assertNoWriteCredentialEnv(input.envAugment || {});
      assert.equal(fs.existsSync(input.cwd), true);
      assert.equal(pathStartsWith(input.cwd, adopterCheckout), false);
      return writeExecutionFixtureChange(input);
    },
  });

  assert.equal(execution.dispatch.action, "fresh");
  assert.equal(execution.completion.status, "completed", JSON.stringify(execution.completion, null, 2));
  assert.ok(execution.turns.length > 0, "execution should run at least one orchestrator turn");
  assert.equal(fixture.linearClient.issueStateName(issue.id), "In Review");
  assert.deepEqual(
    fixture.linearClient.updatesForIssue(issue.id).map((update) => update.stateId),
    ["state-in-progress", "state-in-review"],
  );

  const prIdentity = onlyGithubPrIdentity(execution.completion.artifact);
  assert.equal(prIdentity.identity.resource_id, "repo-a");
  assert.equal(prIdentity.identity.repo, "product");
  assert.equal(fixture.prHub.adapterForResourceId("repo-a").created.length, 1);
  assert.equal(
    remoteBranchExists(fixture.remoteForResourceId("repo-a"), prIdentity.identity.branch),
    true,
  );
  assert.equal(
    execution.turns.every((turn) => pathStartsWith(turn.cwd, path.join(os.tmpdir(), "teami", "resource-clones"))),
    true,
    "execution cwd should be the contained materialized clone, not an adopter checkout",
  );
  assert.equal(
    execution.turns.every((turn) => hasWriteCredentialEnv(turn.envAugment) === false),
    true,
  );
  assert.equal(execution.completion.artifact.environment.agent_write_credentials_present, false);
  assert.equal(process.env.GH_TOKEN, SEEDED_WRITE_CREDENTIAL_ENV.GH_TOKEN);

  const review = await fixture.runReviewIssue({
    issueId: issue.id,
    disposition: "approve",
  });
  assert.equal(review.dispatch.action, "review");
  assert.equal(review.completion.status, "completed");
  assert.equal(fixture.linearClient.issueStateName(issue.id), "In Review");
  assert.equal(fixture.prHub.adapterForResourceId("repo-a").statuses.at(-1).state, "success");
});

test("Slice-1 rows 2, 4: explicit repo-B target materializes and reviews the produced repo-B PR, never repo A", async () => {
  registerGitRepoResourceKind();
  const issue = codeIssue({
    id: "issue-repo-b",
    identifier: "AF-202",
    title: "Implement repo B",
    resourceTarget: { kind: "git_repo", id: "repo-b" },
  });
  const fixture = createAcceptanceFixture({
    resources: [
      gitRepoResource({ id: "repo-a", repo: "repo-a" }),
      gitRepoResource({ id: "repo-b", repo: "repo-b" }),
    ],
    issues: [issue],
  });

  const execution = await fixture.runReadyIssue({
    issueId: issue.id,
    turn: ({ input }) => writeExecutionFixtureChange(input),
  });
  const prIdentity = onlyGithubPrIdentity(execution.completion.artifact);
  const branch = branchNameForIssue(issue.identifier);

  assert.equal(execution.dispatch.action, "fresh");
  assert.ok(execution.turns.length > 0, "repo-B execution should run at least one orchestrator turn");
  assert.equal(prIdentity.identity.resource_id, "repo-b");
  assert.equal(prIdentity.identity.repo, "repo-b");
  assert.equal(fixture.prHub.adapterForResourceId("repo-b").created.length, 1);
  assert.equal(fixture.prHub.adapterForResourceId("repo-a").created.length, 0);
  assert.equal(remoteBranchExists(fixture.remoteForResourceId("repo-b"), branch), true);
  assert.equal(remoteBranchExists(fixture.remoteForResourceId("repo-a"), branch), false);

  const review = await fixture.runReviewIssue({ issueId: issue.id, disposition: "approve" });
  assert.equal(review.dispatch.action, "review");
  assert.equal(review.reviewPackets.length, 1);
  assert.equal(review.reviewPackets[0].pull_request.repo, "repo-b");
  const repoBReviewCalls = fixture.prHub.adapterForResourceId("repo-b").calls
    .filter((call) => ["getPullRequest", "getPullRequestFiles", "setCommitStatus"].includes(call.method));
  assert.ok(repoBReviewCalls.some((call) => call.method === "getPullRequest" && call.repo === "repo-b"));
  assert.ok(repoBReviewCalls.some((call) => call.method === "getPullRequestFiles" && call.repo === "repo-b"));
  assert.ok(repoBReviewCalls.some((call) => call.method === "setCommitStatus" && call.repo === "repo-b"));
  assert.deepEqual(
    fixture.prHub.adapterForResourceId("repo-a").calls
      .filter((call) => ["getPullRequest", "listPullRequestsForHead", "getPullRequestFiles", "setCommitStatus"].includes(call.method)),
    [],
  );
});

test("Slice-1 row 3: missing or disallowed multi-repo targets fail closed before materialization", async (t) => {
  registerGitRepoResourceKind();
  const resources = [
    gitRepoResource({ id: "repo-a", repo: "repo-a" }),
    gitRepoResource({ id: "repo-b", repo: "repo-b" }),
  ];
  const cases = [
    {
      name: "missing",
      issue: codeIssue({ id: "issue-missing-target", identifier: "AF-301" }),
      reason: "resource_target_missing",
    },
    {
      name: "not allowed",
      issue: codeIssue({
        id: "issue-bad-target",
        identifier: "AF-302",
        resourceTarget: { kind: "git_repo", id: "repo-c" },
      }),
      reason: "resource_target_not_allowed",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = createAcceptanceFixture({ resources, issues: [entry.issue] });
      let gatewayFreshCalls = 0;
      const gateway = await processReadyIssue({
        config: fixture.config,
        repoRoot: fixture.tempRoot,
        runStoreDir: fixture.runStoreDir,
        registry: fixture.registry,
        domain: fixture.domain,
        domainContext: fixture.domainContext,
        cache: fixture.cache,
        client: fixture.linearClient,
        candidate: { id: entry.issue.id },
        state: gatewayState({ maxInFlight: 1 }),
        idempotency: noReplayNoSuppressionIdempotency(),
        runFreshIssue: async () => {
          gatewayFreshCalls += 1;
          throw new Error("gateway must not dispatch ambiguous resource targets");
        },
        traceSink: createCapturingTraceSink([]),
      });
      assert.equal(gateway.action, "skipped");
      assert.equal(gateway.reason, entry.reason);
      assert.equal(gatewayFreshCalls, 0);

      const store = createMutableTriggerStore({
        repoRoot: fixture.tempRoot,
        runStoreDir: fixture.runStoreDir,
      });
      const runDeps = {
        materializeCalls: [],
        async materialize(input) {
          runDeps.materializeCalls.push(input);
          throw new Error("runner must reject resource target before materialization");
        },
        createPrAdapter: fixture.prHub.createPrAdapter,
        executionProfilePreflight: greenExecutionProfilePreflight,
      };
      const runner = await runTriggeredExecution(fixture.executionRunOptions({
        issueId: entry.issue.id,
        store,
        runDeps,
        orchestratorTurnExecutor: async () => {
          throw new Error("orchestrator must not run without a selected resource");
        },
      }));
      assert.equal(runner.status, "rejected");
      assert.equal(runner.reason, entry.reason);
      assert.equal(runDeps.materializeCalls.length, 0);
      assert.equal(
        Object.values(fixture.gitFixtures).every((gitFixture) =>
          remoteBranchExists(gitFixture.remote, branchNameForIssue(entry.issue.identifier)) === false
        ),
        true,
      );
    });
  }
});

test("Slice-1 row 7: deleting local run state still cold-reconstructs a revision onto the same PR branch", async () => {
  registerGitRepoResourceKind();
  const issue = codeIssue({
    id: "issue-cold-revision",
    identifier: "AF-407",
    title: "Revise after review",
  });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [issue],
  });

  const first = await fixture.runReadyIssue({
    issueId: issue.id,
    turn: ({ input }) => writeExecutionFixtureChange(input, { suffix: "initial" }),
  });
  const firstIdentity = onlyGithubPrIdentity(first.completion.artifact).identity;
  const adapter = fixture.prHub.adapterForResourceId("repo-a");
  adapter.recordRequestChanges({
    number: Number(firstIdentity.pull_request_number),
    headSha: firstIdentity.head_sha,
    body: "Please add the revision proof.",
    runId: "run-review-cold",
  });

  fs.rmSync(fixture.runStoreDir, { recursive: true, force: true });
  const coldStore = createMutableTriggerStore({
    repoRoot: fixture.tempRoot,
    runStoreDir: fixture.runStoreDir,
  });
  const coldTurns = [];
  const cold = await runWarmResumeIssueSyntheticWake({
    config: fixture.config,
    repoRoot: fixture.tempRoot,
    runStoreDir: fixture.runStoreDir,
    registry: fixture.registry,
    domain: fixture.domain,
    domainContext: fixture.domainContext,
    issueId: issue.id,
    prNumber: firstIdentity.pull_request_number,
    head_sha: firstIdentity.head_sha,
    warmResumeDecision: {
      action: "warm_resume",
      resumeMode: "cold_reconstruct",
      durableIdentity: {
        resource_id: "repo-a",
        owner: "acme",
        repo: "product",
        branch: firstIdentity.branch,
        head_sha: firstIdentity.head_sha,
        pull_request_number: firstIdentity.pull_request_number,
      },
    },
    store: coldStore,
    createSetupGraphqlClient: createFakeSetupGraphqlClient(fixture.linearClient),
    createTraceSink: () => createCapturingTraceSink(fixture.traces),
    createRuntimeExecutor: createNoopRuntimeExecutor,
    runDeps: fixture.executionRunDeps({
      store: coldStore,
      executionProfilePreflight: greenExecutionProfilePreflight,
    }),
    gitRemoteUrlOverrides: fixture.gitRemoteUrlOverrides,
    runTriggeredExecutionFn: (options) =>
      runTriggeredExecution({
        ...options,
        executionReadiness: () => ({ ok: true }),
        orchestratorTurnExecutor: async (input) => {
          coldTurns.push(input);
          return writeExecutionFixtureChange(input, { suffix: "revision" });
        },
      }),
  });

  assert.equal(cold.status, "completed");
  assert.equal(cold.resume_status, "committed");
  assert.equal(coldTurns.length, 1);
  assert.equal(coldTurns[0].firstTurnWarmStart, null);
  assert.equal(coldTurns[0].priorTurns[0].resume_context.text.includes("Please add the revision proof"), true);
  assert.equal(coldTurns[0].priorTurns[0].reason, "af_review_failure_marker");
  assert.equal(adapter.created.length, 1, "cold revision should reuse the existing PR");
  const secondIdentity = onlyGithubPrIdentity(cold.result.artifact).identity;
  assert.equal(secondIdentity.pull_request_number, firstIdentity.pull_request_number);
  assert.equal(secondIdentity.branch, firstIdentity.branch);
  assert.notEqual(secondIdentity.head_sha, firstIdentity.head_sha);
  assert.match(
    remoteFile(fixture.remoteForResourceId("repo-a"), firstIdentity.branch, `AF-407-${cold.result.artifact.run_id}-revision.txt`),
    /suffix: revision/,
  );
});

test("Slice-1 rows 8, 9, 12: remediation files a blocker, completed repair unblocks the original, and lifecycle traces stitch the episode", async () => {
  registerGitRepoResourceKind();
  const issue = codeIssue({
    id: "issue-remediation",
    identifier: "AF-508",
    title: "Run after readiness repair",
  });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [issue],
  });
  const red = redPreflightVerdict();
  const first = await fixture.runReadyIssue({
    issueId: issue.id,
    executionProfilePreflight: async () => red,
    turn: async () => {
      throw new Error("orchestrator should not run after a red preflight");
    },
  });

  assert.equal(first.dispatch.action, "fresh");
  assert.equal(first.completion.status, "completed");
  assert.equal(first.completion.reason, "dependency_blocked");
  assert.equal(first.completion.artifact, null);
  assert.equal(first.runner.result.status, "waiting");
  assert.equal(first.runner.result.reason, "dependency_blocked");
  assert.equal(fixture.linearClient.issueStateName(issue.id), "Todo");
  assert.equal(fixture.linearClient.issueUpdates.length, 0);
  assert.equal(fixture.linearClient.createdIssues.length, 1);
  const remediation = fixture.linearClient.createdIssues[0];
  assert.equal(remediation.stateId, "state-todo");
  assert.deepEqual(parseRemediationMarker(remediation.description), {
    v: 1,
    kind: "readiness_repair",
    resource_id: "repo-a",
    failure_signature: first.runner.result.remediation.marker.failure_signature,
  });
  assert.deepEqual(fixture.linearClient.relations.map((relation) => ({
    issueId: relation.issueId,
    relatedIssueId: relation.relatedIssueId,
    type: relation.type,
  })), [{
    issueId: remediation.id,
    relatedIssueId: issue.id,
    type: "blocks",
  }]);
  assert.deepEqual(lifecycleAttributes(first.runner.result.trace), {
    original_issue_id: issue.id,
    remediation_issue_id: remediation.id,
    resource_id: "repo-a",
    failure_signature: first.runner.result.remediation.marker.failure_signature,
    retry_cycle: 1,
    outcome: "filed",
  });

  fixture.linearClient.setIssueState(remediation.id, "state-done");
  const second = await fixture.runReadyIssue({
    issueId: issue.id,
    executionProfilePreflight: greenExecutionProfilePreflight,
    turn: ({ input }) => writeExecutionFixtureChange(input, { suffix: "after-repair" }),
  });

  assert.equal(second.dispatch.action, "fresh");
  assert.equal(second.completion.status, "completed");
  assert.equal(fixture.linearClient.issueStateName(issue.id), "In Review");
  const retryLifecycle = lifecycleAttributes(second.runner.result.trace);
  assert.deepEqual(retryLifecycle, {
    original_issue_id: issue.id,
    remediation_issue_id: remediation.id,
    resource_id: "repo-a",
    failure_signature: first.runner.result.remediation.marker.failure_signature,
    retry_cycle: 2,
    outcome: "passed",
  });
  assert.equal(retryLifecycle.original_issue_id, lifecycleAttributes(first.runner.result.trace).original_issue_id);
  assert.equal(retryLifecycle.resource_id, lifecycleAttributes(first.runner.result.trace).resource_id);

  const routingTrace = fixture.traces
    .map((event) => event.input?.result?.trace)
    .find((trace) => trace?.spans?.some((span) => span.name === "ready_issue_eligibility"));
  assert.ok(routingTrace, "ready issue eligibility trace should be emitted");
  const routingSpan = routingTrace.spans.find((span) => span.name === "ready_issue_eligibility");
  assert.equal(routingSpan.attributes.chosen_resource_id, "repo-a");
  assert.deepEqual(routingSpan.attributes.allowed_resource_ids, ["repo-a"]);
  assert.equal(routingSpan.attributes.reason ?? null, null);
});

test("Slice-1 row 10: a still-red retry after one remediation cycle escalates to Needs Principal without filing remediation #2", async () => {
  registerGitRepoResourceKind();
  const previousRepair = remediationIssueContext({
    id: "repair-previous",
    identifier: "AF-R1",
    marker: {
      v: 1,
      kind: "readiness_repair",
      resource_id: "repo-a",
      failure_signature: "sha256:previous",
    },
    state: { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
  });
  const issue = codeIssue({
    id: "issue-still-red",
    identifier: "AF-610",
    title: "Still red after repair",
    relations: [blocksRelation({ blocker: previousRepair, dependent: { id: "issue-still-red" } })],
  });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [issue, previousRepair],
  });

  const result = await runTriggeredExecution(fixture.executionRunOptions({
    issueId: issue.id,
    store: createMutableTriggerStore({
      repoRoot: fixture.tempRoot,
      runStoreDir: fixture.runStoreDir,
    }),
    runDeps: fixture.executionRunDeps({
      executionProfilePreflight: async () => redPreflightVerdict(),
    }),
    orchestratorTurnExecutor: async () => {
      throw new Error("orchestrator should not run after a capped red preflight");
    },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.reason, null);
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.reason, "remediation_retry_cap_exceeded");
  assert.deepEqual(result.result.applied.map((effect) => effect.id), [ISSUE_NEEDS_PRINCIPAL_EFFECT_ID]);
  assert.equal(fixture.linearClient.createdIssues.length, 0);
  assert.equal(fixture.linearClient.issueStateName(issue.id), "Principal Escalation");
  assert.equal(
    fixture.linearClient.labelsForIssue(issue.id).some((label) => label.name === "Needs Principal"),
    false,
  );
  assert.deepEqual(lifecycleAttributes(result.result.trace), {
    original_issue_id: issue.id,
    remediation_issue_id: previousRepair.id,
    resource_id: "repo-a",
    failure_signature: result.result.remediation.marker.failure_signature,
    retry_cycle: 2,
    outcome: "remediation_retry_cap_exceeded",
  });
});

test("Slice-1 row 10 regression: a canceled remediation unblocks polling and counts toward the retry cap", async () => {
  registerGitRepoResourceKind();
  const previousRepair = remediationIssueContext({
    id: "repair-canceled",
    identifier: "AF-RC",
    marker: {
      v: 1,
      kind: "readiness_repair",
      resource_id: "repo-a",
      failure_signature: "sha256:canceled-cycle",
    },
    state: { id: "state-canceled", name: "Canceled", type: "canceled", teamId: "team-1" },
  });
  const issue = codeIssue({
    id: "issue-red-after-cancel",
    identifier: "AF-611",
    title: "Still red after canceled repair",
    relations: [blocksRelation({ blocker: previousRepair, dependent: { id: "issue-red-after-cancel" } })],
  });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [issue, previousRepair],
    materializeGit: false,
  });

  const result = await fixture.runReadyIssue({
    issueId: issue.id,
    executionProfilePreflight: async () => redPreflightVerdict(),
    materialize: fakeMaterializeGitResource({ resourceId: "repo-a", repo: "product" }),
    turn: async () => {
      throw new Error("orchestrator should not run after a capped red preflight");
    },
  });

  assert.equal(result.dispatch.action, "fresh");
  assert.equal(result.runner.status, "completed");
  assert.equal(result.completion.status, "completed");
  assert.equal(result.runner.result.status, "completed");
  assert.equal(result.runner.result.reason, "remediation_retry_cap_exceeded");
  assert.deepEqual(result.runner.result.applied.map((effect) => effect.id), [ISSUE_NEEDS_PRINCIPAL_EFFECT_ID]);
  assert.equal(fixture.linearClient.createdIssues.length, 0);
  assert.equal(fixture.linearClient.issueStateName(issue.id), "Principal Escalation");
  assert.equal(
    fixture.linearClient.labelsForIssue(issue.id).some((label) => label.name === "Needs Principal"),
    false,
  );
  assert.deepEqual(lifecycleAttributes(result.runner.result.trace), {
    original_issue_id: issue.id,
    remediation_issue_id: previousRepair.id,
    resource_id: "repo-a",
    failure_signature: result.runner.result.remediation.marker.failure_signature,
    retry_cycle: 2,
    outcome: "remediation_retry_cap_exceeded",
  });
});

test("Slice-1 row 11: a second issue on the same broken repo dedups onto the existing open remediation", async () => {
  registerGitRepoResourceKind();
  const firstIssue = codeIssue({ id: "issue-dedup-1", identifier: "AF-711" });
  const secondIssue = codeIssue({ id: "issue-dedup-2", identifier: "AF-712" });
  const fixture = createAcceptanceFixture({
    resources: [gitRepoResource({ id: "repo-a", repo: "product" })],
    issues: [firstIssue, secondIssue],
  });
  const verdict = redPreflightVerdict();

  const first = await runTriggeredExecution(fixture.executionRunOptions({
    issueId: firstIssue.id,
    store: createMutableTriggerStore({
      repoRoot: fixture.tempRoot,
      runStoreDir: fixture.runStoreDir,
    }),
    runDeps: fixture.executionRunDeps({
      executionProfilePreflight: async () => verdict,
    }),
    orchestratorTurnExecutor: async () => {
      throw new Error("orchestrator should not run after first red preflight");
    },
  }));
  assert.equal(first.result.remediation.created, true);
  assert.equal(fixture.linearClient.createdIssues.length, 1);
  const remediation = fixture.linearClient.createdIssues[0];

  const second = await runTriggeredExecution(fixture.executionRunOptions({
    issueId: secondIssue.id,
    store: createMutableTriggerStore({
      repoRoot: fixture.tempRoot,
      runStoreDir: fixture.runStoreDir,
    }),
    runDeps: fixture.executionRunDeps({
      executionProfilePreflight: async () => verdict,
    }),
    orchestratorTurnExecutor: async () => {
      throw new Error("orchestrator should not run after second red preflight");
    },
  }));

  assert.equal(second.result.remediation.dedup_reused, true);
  assert.equal(second.result.remediation.issue.id, remediation.id);
  assert.equal(fixture.linearClient.createdIssues.length, 1);
  assert.deepEqual(fixture.linearClient.relations.at(-1), {
    issueId: remediation.id,
    relatedIssueId: secondIssue.id,
    type: "blocks",
  });
  assert.equal(lifecycleAttributes(second.result.trace).outcome, "reused_open_remediation");
});

test("Slice-1 row 12: routing observability records chosen resource and allowed set for explicit multi-repo routing", async () => {
  registerGitRepoResourceKind();
  const issue = codeIssue({
    id: "issue-routing-observed",
    identifier: "AF-812",
    resourceTarget: { kind: "git_repo", id: "repo-b" },
  });
  const fixture = createAcceptanceFixture({
    resources: [
      gitRepoResource({ id: "repo-a", repo: "repo-a" }),
      gitRepoResource({ id: "repo-b", repo: "repo-b" }),
    ],
    issues: [issue],
  });
  const traces = [];
  let freshCalls = 0;

  const result = await processReadyIssue({
    config: fixture.config,
    repoRoot: fixture.tempRoot,
    runStoreDir: fixture.runStoreDir,
    registry: fixture.registry,
    domain: fixture.domain,
    domainContext: fixture.domainContext,
    cache: fixture.cache,
    client: fixture.linearClient,
    candidate: { id: issue.id },
    state: gatewayState({ maxInFlight: 1 }),
    idempotency: noReplayNoSuppressionIdempotency(),
    traceSink: createCapturingTraceSink(traces),
    runFreshIssue: async () => {
      freshCalls += 1;
      return { status: "completed", result: { status: "completed" } };
    },
    runTimeoutMs: 0,
  });

  assert.equal(result.action, "fresh");
  await flushAsync();
  assert.equal(freshCalls, 1);
  const finishRun = traces.find((event) => event.type === "finishRun")?.input;
  assert.ok(finishRun, "routing trace should be finished");
  const span = finishRun.result.trace.spans.find((candidate) => candidate.name === "ready_issue_eligibility");
  assert.ok(span, "ready_issue_eligibility span should be emitted");
  assert.equal(span.attributes.issue_id, issue.id);
  assert.equal(span.attributes.work_type, "code");
  assert.equal(span.attributes.chosen_resource_id, "repo-b");
  assert.deepEqual(span.attributes.allowed_resource_ids, ["repo-a", "repo-b"]);
  assert.equal(span.attributes.reason ?? null, null);
});

function createAcceptanceFixture({ resources, issues, materializeGit = true }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-slice1-acceptance-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  writeReviewAcceptedPromptFixture(tempRoot);
  const gitFixtures = Object.fromEntries(
    resources.map((resource) => [
      resource.id,
      materializeGit ? createGitFixture(tempRoot, resource.id) : fakeGitFixture(resource.id),
    ]),
  );
  const gitRemoteUrlOverrides = Object.fromEntries(
    Object.entries(gitFixtures).map(([resourceId, fixture]) => [resourceId, fixture.remote]),
  );
  const config = acceptanceConfig();
  const domain = domainFixture({ resources });
  const registry = { schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] };
  const domainContext = buildDomainContext({
    domain,
    config,
    repoRoot: tempRoot,
    behaviorRepoId: "local:slice1-acceptance",
  });
  const cache = writeAcceptanceLinearCache(domainContext.linear.cachePath);
  const runStoreDir = path.join(tempRoot, ".teami", "runs");
  const linearClient = createMutableLinearClient(issues);
  const prHub = createPrHub({ resources, gitFixtures });
  const traces = [];

  const fixture = {
    tempRoot,
    runStoreDir,
    config,
    domain,
    registry,
    domainContext,
    cache,
    linearClient,
    prHub,
    gitFixtures,
    gitRemoteUrlOverrides,
    traces,
    remoteForResourceId(resourceId) {
      return gitFixtures[resourceId]?.remote;
    },
    executionRunDeps({ store, executionProfilePreflight = greenExecutionProfilePreflight, materialize = null } = {}) {
      return {
        store,
        createPrAdapter: prHub.createPrAdapter,
        executionProfilePreflight,
        gitRemoteUrlOverrides,
        materialize: materialize || ((input) => materializeDomainResources({
          ...input,
          gitRemoteUrlOverrides,
        })),
      };
    },
    executionRunOptions({
      issueId,
      store,
      runDeps,
      orchestratorTurnExecutor,
      retry = false,
      resumeFrom = null,
    }) {
      return {
        executionReadiness: () => ({ ok: true }),
        issueId,
        retry,
        store,
        runnerId: "runner-slice1",
        workspaceId: domainContext.linear.workspaceId,
        linearClient,
        config,
        cache,
        repoRoot: tempRoot,
        runStoreDir,
        runtimeExecutor: createNoopRuntimeExecutor(),
        orchestratorTurnExecutor,
        domainContext,
        registry,
        runDeps,
        gitRemoteUrlOverrides,
        ...(resumeFrom ? { resumeFrom } : {}),
      };
    },
    async runReadyIssue({
      issueId,
      executionProfilePreflight = greenExecutionProfilePreflight,
      materialize = null,
      turn,
    }) {
      const state = gatewayState({ maxInFlight: 1 });
      const store = createMutableTriggerStore({ repoRoot: tempRoot, runStoreDir });
      const turns = [];
      const runnerResults = [];
      const runFreshIssue = (input) =>
        runFreshIssueSyntheticWake({
          config,
          ...input,
          repoRoot: tempRoot,
          runStoreDir,
          registry,
          domain,
          domainContext,
          createStore: () => store,
          createSetupGraphqlClient: createFakeSetupGraphqlClient(linearClient),
          createTraceSink: () => createCapturingTraceSink(traces),
          createRuntimeExecutor: createNoopRuntimeExecutor,
          gitRemoteUrlOverrides,
          runDeps: fixture.executionRunDeps({ store, executionProfilePreflight, materialize }),
          runTriggeredExecutionFn: async (options) => {
            const result = await runTriggeredExecution({
              ...options,
              executionReadiness: () => ({ ok: true }),
              orchestratorTurnExecutor: async (input) => {
                turns.push({
                  runId: input.runId,
                  issueId: input.project.id,
                  cwd: input.cwd,
                  envAugment: { ...(input.envAugment || {}) },
                  firstTurnWarmStart: input.firstTurnWarmStart ?? null,
                  priorTurns: structuredClone(input.priorTurns || []),
                });
                return turn({ input });
              },
            });
            runnerResults.push(result);
            return result;
          },
        });

      const dispatch = await processReadyIssue({
        config,
        repoRoot: tempRoot,
        home: tempRoot,
        runStoreDir,
        registry,
        domain,
        domainContext,
        cache,
        client: linearClient,
        candidate: { id: issueId },
        idempotency: triggerIdempotency,
        runFreshIssue,
        state,
        traceSink: createCapturingTraceSink(traces),
        runTimeoutMs: 0,
      });
      await waitForIdle(state, issueId);
      const completion = store.completedForIssue(issueId).at(-1);
      assert.ok(completion, `expected completion for ${issueId}`);
      return {
        dispatch,
        completion,
        runner: runnerResults.at(-1),
        turns,
        store,
      };
    },
    async runReviewIssue({ issueId, disposition = "approve" }) {
      const state = gatewayState({ maxInFlight: 1 });
      const store = this.lastStore || createMutableTriggerStore({ repoRoot: tempRoot, runStoreDir });
      for (const run of fixture.linearClient.executionRunsForIssue(issueId)) {
        store.recordRun(run);
      }
      const reviewPackets = [];
      const runFreshReview = (input) =>
        runFreshReviewSyntheticWake({
          config,
          repoRoot: tempRoot,
          runStoreDir,
          registry,
          domain,
          domainContext,
          issueId: input.issueId,
          reviewDecision: input.reviewDecision,
          createStore: () => store,
          createSetupGraphqlClient: createFakeSetupGraphqlClient(linearClient),
          createTraceSink: () => createCapturingTraceSink(traces),
          createRuntimeExecutor: createNoopRuntimeExecutor,
          runDeps: {
            store,
            createPrAdapter: prHub.createPrAdapter,
          },
          runTriggeredReviewFn: (options) =>
            runTriggeredReview({
              ...options,
              orchestratorTurnExecutor: async (turnInput) => {
                const packet = JSON.parse(turnInput.project.content);
                reviewPackets.push(packet);
                return {
                  controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
                  producedContent: {
                    disposition,
                    body: disposition === "approve"
                      ? "Approved. The fixture diff is scoped correctly."
                      : "Please revise the fixture diff.",
                    reviewed_head_sha: packet.pull_request.head_sha,
                    source_refs: [{
                      kind: "github_pull_request",
                      id: `${packet.pull_request.owner}/${packet.pull_request.repo}#${packet.pull_request.number}`,
                    }],
                    assumptions: [],
                    constraints: ["fixture uses in-memory Linear and local git remotes"],
                    risks: [],
                  },
                  evidence: null,
                  sessionHandle: {
                    id: `review-session-${packet.pull_request.head_sha}`,
                    role: "orchestrator",
                    run_id: turnInput.runId,
                    runtime: "codex",
                  },
                };
              },
            }),
        });

      const dispatch = await processReviewIssue({
        config,
        repoRoot: tempRoot,
        home: tempRoot,
        runStoreDir,
        registry,
        domain,
        domainContext,
        client: linearClient,
        candidate: { id: issueId },
        state,
        store,
        runDeps: {
          store,
          createPrAdapter: prHub.createPrAdapter,
        },
        runFreshReview,
        runTimeoutMs: 0,
      });
      await waitForIdle(state, issueId);
      const completion = store.completedForIssue(issueId, { workflowType: "review" }).at(-1);
      assert.ok(completion, `expected review completion for ${issueId}`);
      return { dispatch, completion, reviewPackets, store };
    },
  };

  const originalRunReadyIssue = fixture.runReadyIssue.bind(fixture);
  fixture.runReadyIssue = async (...args) => {
    const result = await originalRunReadyIssue(...args);
    fixture.lastStore = result.store;
    for (const run of result.store.executionRuns) {
      linearClient.rememberExecutionRun(run);
    }
    return result;
  };

  return fixture;
}

function createMutableLinearClient(issueContexts) {
  const createdIssues = [];
  const relations = [];
  const issueUpdates = [];
  const issueComments = [];
  const executionRuns = [];
  const states = new Map(workflowStates().map((state) => [state.id, state]));
  const labels = new Map([
    ["label-code", { id: "label-code", name: "Code", teamId: "team-1" }],
    ["label-discovery", { id: "label-discovery", name: "Discovery", teamId: "team-1" }],
    ["label-needs-principal", { id: "label-needs-principal", name: "Needs Principal", teamId: "team-1" }],
  ]);
  const issues = new Map();
  const relationRecords = [];
  for (const context of issueContexts) addIssue(context);
  for (const context of issueContexts) {
    for (const relation of context?.relations || []) seedRelation(relation);
  }

  return {
    createdIssues,
    relations,
    issueUpdates,
    issueComments,
    async listIssueComments(issueId) {
      return issueComments
        .filter((comment) => comment.issueId === issueId)
        .map((comment) => ({ ...comment, user: { ...comment.user } }));
    },
    async createIssueComment(issueId, body) {
      const comment = {
        id: `linear-comment-${issueComments.length + 1}`,
        comment_id: `linear-comment-${issueComments.length + 1}`,
        issueId,
        body,
        user: { id: "app-viewer-1" },
      };
      issueComments.push(comment);
      return { ...comment, user: { ...comment.user } };
    },
    rememberExecutionRun(run) {
      if (!run || run.workflow_type !== "execution") return;
      const existing = executionRuns.find((candidate) => candidate.run_id === run.run_id);
      if (!existing) executionRuns.push(structuredClone(run));
    },
    executionRunsForIssue(issueId) {
      return executionRuns.filter((run) => run.object_id === issueId || run.issue_id === issueId);
    },
    async listWorkflowStates(teamId) {
      return [...states.values()].filter((state) => !teamId || state.teamId === teamId).map((state) => ({ ...state }));
    },
    async listReadyIssueCandidates(teamId, page = {}) {
      assert.equal(teamId, "team-1");
      return {
        candidates: [...issues.values()]
          .filter((issue) => issue.state?.id === page.readyStateId)
          .map((issue) => ({ id: issue.id, createdAt: issue.createdAt })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    },
    async getIssueContext(issueId) {
      return issueView(issueId);
    },
    async getIssue(issueId) {
      return issueView(issueId);
    },
    async updateIssue(issueId, input) {
      issueUpdates.push({ issueId, ...input });
      const issue = issues.get(issueId);
      if (!issue) throw new Error(`unknown issue: ${issueId}`);
      if (input.stateId) {
        issue.stateId = input.stateId;
        issue.state = states.get(input.stateId) || { id: input.stateId };
        issue.updates.push({ stateId: input.stateId });
      }
      if (Array.isArray(input.labelIds)) {
        issue.labels = input.labelIds.map((labelId) => labels.get(labelId) || { id: labelId, name: labelId });
      }
      return issueView(issueId);
    },
    async findIssueLabelsByName(name, teamId) {
      return [...labels.values()]
        .filter((label) => !teamId || label.teamId === teamId)
        .filter((label) => !name || label.name === name)
        .map((label) => ({ ...label }));
    },
    async listIssues({ teamId = null, projectId = null, query = null, stateId = null, labelId = null } = {}) {
      const search = String(query || "").toLowerCase();
      return [...issues.values()]
        .filter((issue) => !teamId || issue.teamId === teamId || issue.team?.id === teamId)
        .filter((issue) => !projectId || issue.projectId === projectId || issue.project?.id === projectId)
        .filter((issue) => !stateId || issue.state?.id === stateId)
        .filter((issue) => !labelId || issue.labels?.some((label) => label.id === labelId))
        .filter((issue) => !search || `${issue.title || ""}\n${issue.description || ""}`.toLowerCase().includes(search))
        .map((issue) => issueView(issue.id));
    },
    async searchIssues(options) {
      return this.listIssues(options);
    },
    async createIssue(input) {
      const issue = {
        id: `repair-${createdIssues.length + 1}`,
        identifier: `AF-R${createdIssues.length + 1}`,
        url: `https://linear.test/AF-R${createdIssues.length + 1}`,
        title: input.title,
        description: input.description,
        teamId: input.teamId,
        team: { id: input.teamId, key: "AF", name: "Teami" },
        projectId: input.projectId,
        project: { id: input.projectId, name: "Execution Project" },
        stateId: input.stateId,
        state: states.get(input.stateId) || states.get("state-todo"),
        labelIds: [...(input.labelIds || [])],
        labels: (input.labelIds || []).map((id) => labels.get(id) || { id, name: id }),
        createdAt: "2026-06-30T12:00:00.000Z",
        updates: [],
      };
      createdIssues.push({
        ...structuredClone(issue),
        stateId: issue.stateId,
        labelIds: [...issue.labelIds],
      });
      issues.set(issue.id, issue);
      return issueView(issue.id);
    },
    async findOrCreateIssueRelation(input) {
      const existing = relationRecords.find((relation) =>
        relation.issueId === input.issueId &&
        relation.relatedIssueId === input.relatedIssueId &&
        relation.type === input.type
      );
      relations.push({ ...input });
      if (existing) {
        return { created: false, relation: relationView(existing) };
      }
      const record = {
        id: `relation-${relationRecords.length + 1}`,
        ...input,
      };
      relationRecords.push(record);
      return { created: true, relation: relationView(record) };
    },
    async getTeamGitAutomationSettings(teamId) {
      assert.equal(teamId, "team-1");
      return {
        mergeWorkflowState: states.get("state-done"),
        gitAutomationStates: [],
      };
    },
    setIssueState(issueId, stateId) {
      const issue = issues.get(issueId);
      if (!issue) throw new Error(`unknown issue: ${issueId}`);
      issue.stateId = stateId;
      issue.state = states.get(stateId) || { id: stateId };
    },
    issueStateName(issueId) {
      return issues.get(issueId)?.state?.name || null;
    },
    updatesForIssue(issueId) {
      return [...(issues.get(issueId)?.updates || [])];
    },
    labelsForIssue(issueId) {
      return [...(issues.get(issueId)?.labels || [])];
    },
  };

  function addIssue(context = {}) {
    const state = context.state || states.get(context.stateId || "state-todo");
    const labelObjects = (context.labels || [{ id: "label-code", name: "Code", teamId: "team-1" }])
      .map((label) => labels.get(label.id) || label);
    issues.set(context.id, {
      teamId: "team-1",
      team: { id: "team-1", key: "AF", name: "Teami" },
      projectId: "project-1",
      project: { id: "project-1", name: "Execution Project", url: "https://linear.test/project-1" },
      url: `https://linear.test/${context.identifier || context.id}`,
      createdAt: "2026-06-30T10:00:00.000Z",
      updates: [],
      ...context,
      state,
      stateId: state.id,
      labels: labelObjects,
    });
  }

  function seedRelation(relation) {
    if (!relation?.issue?.id || !relation?.relatedIssue?.id) return;
    if (!issues.has(relation.issue.id)) addIssue(relation.issue);
    if (!issues.has(relation.relatedIssue.id)) addIssue(relation.relatedIssue);
    relationRecords.push({
      id: relation.id || `relation-${relationRecords.length + 1}`,
      type: relation.type || "blocks",
      issueId: relation.issue.id,
      relatedIssueId: relation.relatedIssue.id,
    });
  }

  function issueView(issueId) {
    const issue = issues.get(issueId);
    if (!issue) throw new Error(`unknown issue: ${issueId}`);
    return structuredClone({
      ...issue,
      relations: relationRecords
        .filter((relation) => relation.issueId === issueId || relation.relatedIssueId === issueId)
        .map(relationView),
    });
  }

  function relationView(relation) {
    return {
      id: relation.id,
      type: relation.type,
      issue: relationIssueView(relation.issueId),
      relatedIssue: relationIssueView(relation.relatedIssueId),
    };
  }

  function relationIssueView(issueId) {
    const issue = issues.get(issueId);
    if (!issue) return { id: issueId };
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: issue.state,
    };
  }
}

function createMutableTriggerStore({ repoRoot, runStoreDir }) {
  const wakes = new Map();
  const runs = new Map();
  const completed = [];
  const claims = [];
  const executionRuns = [];
  let sequence = 0;
  let mutationTick = 0;
  return {
    claims,
    completed,
    executionRuns,
    triggerEvents: [],
    recordRun(run) {
      if (!run?.run_id) return;
      runs.set(run.run_id, structuredClone(run));
      if (run.workflow_type === "execution") executionRuns.push(structuredClone(run));
    },
    findLatestRunForObject(objectId) {
      return [...executionRuns]
        .filter((run) => run.object_id === objectId || run.issue_id === objectId)
        .at(-1) || null;
    },
    async claimSyntheticIssueWake({
      domainId,
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
        id: `wake-${workflowType}-${safeRunIdSegment(objectId)}-${sequence}`,
        workspace_id: workspaceId,
        domain_id: domainId,
        trigger_type: triggerType,
        workflow_type: workflowType,
        object_type: objectType,
        object_id: objectId,
        team_ids: [teamId],
        created_at: new Date(Date.parse("2026-06-30T11:00:00.000Z") + sequence * 1000).toISOString(),
        attempt_count: 0,
        source_event_id: event.id,
        status: "leased",
        lease_token: `lease-${sequence}`,
      };
      wakes.set(wake.id, wake);
      this.triggerEvents.push(event);
      claims.push({ issueId: objectId, wakeId: wake.id, workflowType });
      return { ok: true, wake: structuredClone(wake), event, leaseToken: wake.lease_token };
    },
    async heartbeat() {
      return { ok: true };
    },
    async renewLease({ wakeId, leaseDurationMs = 60_000 }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      wake.lease_expires_at = new Date(Date.now() + leaseDurationMs).toISOString();
      return { ok: true, wake: structuredClone(wake) };
    },
    async markWakeRunning({ wakeId, runnerId, leaseToken, runId, domainId }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      Object.assign(wake, {
        status: "running",
        runner_id: runnerId,
        lease_token: leaseToken,
        run_id: runId,
        domain_id: domainId,
      });
      const run = {
        run_id: runId,
        wake_id: wakeId,
        object_id: wake.object_id,
        issue_id: wake.object_id,
        workflow_type: wake.workflow_type,
        status: "running",
        started_at: new Date().toISOString(),
      };
      runs.set(runId, run);
      if (wake.workflow_type === "execution") executionRuns.push(run);
      return { ok: true, wake: structuredClone(wake) };
    },
    async markMutationStarted({ wakeId, runnerId, leaseToken, runId, artifactKind, git }) {
      const wake = wakes.get(wakeId);
      if (!wake) return { ok: false, reason: "wake_missing" };
      mutationTick += 1;
      wake.runner_id = runnerId;
      wake.lease_token = leaseToken;
      wake.mutation_started_at = new Date(Date.parse("2026-06-30T12:00:00.000Z") + mutationTick * 1000).toISOString();
      triggerIdempotency.writeMutationIntent({
        domainId: wake.domain_id,
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
        object_id: wake.object_id,
        issue_id: wake.object_id,
        workflow_type: wake.workflow_type,
      };
      Object.assign(run, {
        status,
        terminal_reason: reason,
        provider_update_ids: providerUpdateIds,
        artifact_pointer: artifactPointer,
        artifact: structuredClone(artifact),
        produced_identities: structuredClone(artifact?.produced_identities || []),
        runtime_metadata: artifact?.runtime_metadata || {},
        terminal_at: new Date().toISOString(),
      });
      runs.set(run.run_id, run);
      if (run.workflow_type === "execution" && !executionRuns.some((candidate) => candidate.run_id === run.run_id)) {
        executionRuns.push(run);
      }
      const record = {
        issueId: wake.object_id,
        workflowType: wake.workflow_type,
        status,
        reason,
        wake: structuredClone(wake),
        run: structuredClone(run),
        artifact: structuredClone(artifact),
        runnerResult: null,
      };
      completed.push(record);
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
    completedForIssue(issueId, { workflowType = null } = {}) {
      return completed.filter((entry) =>
        entry.issueId === issueId &&
        (!workflowType || entry.workflowType === workflowType)
      );
    },
  };
}

function createPrHub({ resources, gitFixtures }) {
  const adapters = new Map();
  const resourceBySlug = new Map(resources.map((resource) => [
    `${resource.binding.owner}/${resource.binding.repo}`,
    resource,
  ]));
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const hub = {
    createPrAdapter: ({ repoIdentity }) => adapterForRepoIdentity(repoIdentity),
    adapterForResourceId(resourceId) {
      const resource = resourceById.get(resourceId);
      assert.ok(resource, `unknown resource: ${resourceId}`);
      return adapterForRepoIdentity(resource.binding);
    },
  };
  return hub;

  function adapterForRepoIdentity(repoIdentity) {
    const slug = `${repoIdentity.owner}/${repoIdentity.repo}`;
    const resource = resourceBySlug.get(slug);
    assert.ok(resource, `unknown repo adapter: ${slug}`);
    if (!adapters.has(slug)) {
      adapters.set(slug, createRepoPrAdapter({ resource, remote: gitFixtures[resource.id].remote }));
    }
    return adapters.get(slug);
  }
}

function createRepoPrAdapter({ resource, remote }) {
  const created = [];
  const comments = [];
  const statuses = [];
  const calls = [];
  let tick = 0;
  const repoIdentity = resource.binding;
  return {
    created,
    comments,
    statuses,
    calls,
    async probePullRequest({ head, base }) {
      calls.push({ method: "probePullRequest", repo: repoIdentity.repo, head, base });
      return created.find((pr) => pr.head.ref === head && pr.base.ref === base) || null;
    },
    async ensurePullRequest({ title, body, head, base }) {
      calls.push({ method: "ensurePullRequest", repo: repoIdentity.repo, head, base });
      const existing = await this.probePullRequest({ head, base });
      if (existing) return { created: false, pr: existing };
      const number = created.length + 1;
      const headSha = remoteBranchHead(remote, head);
      const pr = {
        id: `pr-${repoIdentity.repo}-${number}`,
        number,
        state: "open",
        title,
        body,
        head: {
          ref: head,
          sha: headSha,
          label: `${repoIdentity.owner}:${head}`,
          repo: { owner: { login: repoIdentity.owner }, name: repoIdentity.repo },
        },
        base: { ref: base },
        url: `https://github.example/${repoIdentity.owner}/${repoIdentity.repo}/pull/${number}`,
        html_url: `https://github.example/${repoIdentity.owner}/${repoIdentity.repo}/pull/${number}`,
      };
      created.push(pr);
      return { created: true, pr };
    },
    async listPullRequestsForHead(head, { state = "all" } = {}) {
      calls.push({ method: "listPullRequestsForHead", repo: repoIdentity.repo, head, state });
      return created
        .filter((pr) => pr.head.ref === head)
        .map((pr) => ({
          number: pr.number,
          state: pr.state,
          base: pr.base.ref,
          head_sha: pr.head.sha,
        }));
    },
    async getPullRequest(number) {
      calls.push({ method: "getPullRequest", repo: repoIdentity.repo, number });
      const pr = created.find((candidate) => candidate.number === Number(number));
      if (!pr) throw new Error(`missing_pr:${repoIdentity.repo}#${number}`);
      pr.head.sha = remoteBranchHead(remote, pr.head.ref);
      return structuredClone(pr);
    },
    async getPullRequestFiles(number) {
      calls.push({ method: "getPullRequestFiles", repo: repoIdentity.repo, number });
      const pr = created.find((candidate) => candidate.number === Number(number));
      assert.ok(pr, `missing PR files: ${number}`);
      return {
        diff_incomplete: false,
        files: [{
          filename: "fixture-change.txt",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -0,0 +1 @@\n+fixture change",
        }],
      };
    },
    async getCommitStatuses(headSha) {
      calls.push({ method: "getCommitStatuses", repo: repoIdentity.repo, headSha });
      return statuses.filter((status) => status.head_sha === headSha).map((status) => ({ ...status }));
    },
    async setCommitStatus(status) {
      tick += 1;
      calls.push({
        method: "setCommitStatus",
        repo: repoIdentity.repo,
        headSha: status.head_sha,
        state: status.state,
      });
      const record = {
        id: `status-${repoIdentity.repo}-${statuses.length + 1}`,
        ...status,
        created_at: isoAt(tick),
      };
      statuses.push(record);
      return { id: record.id };
    },
    async postPullRequestComment({ number, body, context, disposition, head_sha, run_id }) {
      tick += 1;
      calls.push({ method: "postPullRequestComment", repo: repoIdentity.repo, number, disposition, headSha: head_sha });
      const comment = {
        id: `comment-${repoIdentity.repo}-${comments.length + 1}`,
        comment_id: `comment-${repoIdentity.repo}-${comments.length + 1}`,
        body: formatAfReviewCommentBody({ body, context, disposition, head_sha, run_id }),
        created_at: isoAt(tick),
        user: { type: "Bot" },
      };
      comments.push(comment);
      return { comment_id: comment.id };
    },
    async listPullRequestComments(number) {
      calls.push({ method: "listPullRequestComments", repo: repoIdentity.repo, number });
      return comments.map((comment) => ({ ...comment }));
    },
    recordRequestChanges({ number, headSha, body, runId }) {
      comments.push({
        id: `comment-${repoIdentity.repo}-${comments.length + 1}`,
        comment_id: `comment-${repoIdentity.repo}-${comments.length + 1}`,
        body: formatAfReviewCommentBody({
          body,
          context: AF_REVIEW_STATUS_CONTEXT,
          disposition: "request-changes",
          head_sha: headSha,
          run_id: runId,
        }),
        created_at: isoAt(++tick),
        user: { type: "Bot" },
      });
      statuses.push({
        id: `status-${repoIdentity.repo}-${statuses.length + 1}`,
        context: AF_REVIEW_STATUS_CONTEXT,
        state: "failure",
        head_sha: headSha,
        target_url: null,
        description: "Review requested changes.",
        created_at: isoAt(++tick),
      });
      assert.ok(created.find((pr) => pr.number === Number(number)), "request-changes PR should exist");
    },
  };
}

function codeIssue({
  id,
  identifier,
  title = "Implement fixture issue",
  resourceTarget = null,
  relations = [],
  state = { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
} = {}) {
  const targetBlock = resourceTarget ? `\n\n${renderResourceTargetBlock(resourceTarget).trimEnd()}` : "";
  return {
    id,
    identifier,
    title,
    description: [
      `- Decomposition key: ${id}`,
      "",
      `Fixture body for ${identifier}.`,
    ].join("\n") + targetBlock,
    resource_target: resourceTarget,
    work_type: "code",
    state,
    relations,
    labels: [{ id: "label-code", name: "Code", teamId: "team-1" }],
  };
}

function remediationIssueContext({ id, identifier, marker, state }) {
  return {
    id,
    identifier,
    title: "Repair execution readiness",
    description: [
      "Repair readiness.",
      "",
      renderRemediationMarker(marker).trimEnd(),
    ].join("\n"),
    state,
    labels: [{ id: "label-code", name: "Code", teamId: "team-1" }],
  };
}

function blocksRelation({ blocker, dependent }) {
  return {
    id: `relation-${blocker.id}-${dependent.id}`,
    type: "blocks",
    issue: blocker,
    relatedIssue: {
      id: dependent.id,
      identifier: dependent.identifier || dependent.id,
      title: dependent.title || "Dependent",
      state: dependent.state || { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    },
  };
}

function writeExecutionFixtureChange(input, { suffix = "main" } = {}) {
  const fileName = `${safeFileSegment(input.project.identifier)}-${input.runId}-${suffix}.txt`;
  fs.writeFileSync(
    path.join(input.cwd, fileName),
    [
      `run_id: ${input.runId}`,
      `issue_id: ${input.project.id}`,
      `suffix: ${suffix}`,
      "",
    ].join("\n"),
    "utf8",
  );
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
    sessionHandle: {
      id: `session-${input.runId}`,
      role: "orchestrator",
      run_id: input.runId,
      runtime: "codex",
    },
  };
}

function domainFixture({ resources }) {
  return makeDomainRecord({
    domainId: "domain-1",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "AF",
    teamName: "Teami",
    teamNameLastSeenAt: "2026-06-30T00:00:00.000Z",
    webhookId: "webhook-1",
    resources,
  });
}

function gitRepoResource({
  id,
  owner = "acme",
  repo,
  defaultBranch = "main",
  role = "primary",
} = {}) {
  return {
    id,
    kind: "git_repo",
    role,
    binding: {
      owner,
      repo,
      default_branch: defaultBranch,
    },
  };
}

function acceptanceConfig() {
  return {
    runner: {
      lease_duration_ms: 60_000,
    },
    runtime: {
      adapters: {
        codex: {
          command: "codex",
          tool_policy: { linear_write: false },
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
      review: {
        roles: {
          reviewer: { runtime: "codex", model: "test-reviewer" },
          orchestrator: { runtime: "codex", model: "test-orchestrator" },
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
      team: { key: "AF", name: "Teami" },
      issue: {
        labels: {
          discovery: "Discovery",
          work_type_code: "Code",
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

function writeAcceptanceLinearCache(cachePath) {
  const cache = {
    teamId: "team-1",
    app_identity_id: "app-viewer-1",
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
      Code: "label-code",
      "Needs Principal": "label-needs-principal",
      needs_principal: "label-needs-principal",
      "human-review": "label-human-review",
    },
  };
  writeLinearCache(cachePath, cache);
  return cache;
}

function workflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
    { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
    { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
    { id: "state-human-review", name: "Principal Review", type: "started", teamId: "team-1" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
    { id: "state-canceled", name: "Canceled", type: "canceled", teamId: "team-1" },
  ];
}

function createGitFixture(root, name) {
  const remote = path.join(root, `${name}.git`);
  const source = path.join(root, `${name}-source`);
  fs.mkdirSync(source, { recursive: true });
  git(["init", "--bare", remote]);
  git(["init"], source);
  git(["config", "user.name", "Fixture Author"], source);
  git(["config", "user.email", "fixture@example.invalid"], source);
  fs.writeFileSync(path.join(source, "README.md"), `# ${name}\n`, "utf8");
  git(["add", "README.md"], source);
  git(["commit", "-m", "Initial commit"], source);
  git(["branch", "-M", "main"], source);
  git(["remote", "add", "origin", remote], source);
  git(["push", "-u", "origin", "main"], source);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { remote, source };
}

function fakeGitFixture(resourceId) {
  return {
    remote: `file:///virtual/${resourceId}.git`,
    source: null,
  };
}

function fakeMaterializeGitResource({
  resourceId,
  owner = "acme",
  repo = "product",
  defaultBranch = "main",
} = {}) {
  return async ({ runId, runGit }) => {
    const selectedResource = {
      id: resourceId,
      kind: "git_repo",
      role: "primary",
      handle: {
        owner,
        repo,
        default_branch: defaultBranch,
        baseSha: "a".repeat(40),
      },
    };
    return {
      runId,
      selectedResourceId: resourceId,
      selectedResource,
      resources: {
        [resourceId]: selectedResource,
      },
      resourceManifest: [{
        kind: "git_repo",
        id: resourceId,
        role: "primary",
        label: `${owner}/${repo}`,
      }],
      runGit,
      async teardownAll() {},
    };
  };
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

function remoteBranchExists(remote, branch) {
  const result = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function remoteBranchHead(remote, branch) {
  return git(["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).stdout.trim();
}

function remoteFile(remote, branch, filePath) {
  return git(["--git-dir", remote, "show", `${branch}:${filePath}`]).stdout;
}

function createFakeSetupGraphqlClient(client) {
  return (input = {}) => {
    assert.equal(input.allowBrowserAuth, false);
    return { client };
  };
}

function createNoopRuntimeExecutor() {
  return {
    async executeSubagent() {
      throw new Error("subagent executor should not be called by this fixture");
    },
  };
}

function createCapturingTraceSink(events) {
  return {
    async startRun(input) {
      events.push({ type: "startRun", input });
      return { ok: true, traceId: `trace-${events.length}` };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun(input) {
      events.push({ type: "finishRun", input });
      return { status: "stored" };
    },
    async shutdown() {},
  };
}

function noReplayNoSuppressionIdempotency() {
  return {
    async readGitReplayPending() {
      return null;
    },
    async readSuppression() {
      return null;
    },
  };
}

async function greenExecutionProfilePreflight({ resourceId }) {
  return {
    ok: true,
    resource_id: resourceId,
    strict_baseline_green: false,
  };
}

function redPreflightVerdict({
  resourceId = "repo-a",
  reasonCodes = ["no_runnable_test_command"],
  missing = ["package.json:scripts.test"],
} = {}) {
  return {
    ok: false,
    resource_id: resourceId,
    failure_signature_seed: {
      reason_codes: reasonCodes,
      missing,
    },
    failure_reasons: reasonCodes,
  };
}

function onlyGithubPrIdentity(artifact) {
  const identities = (artifact?.produced_identities || [])
    .filter((entry) => entry.resource_kind === "github_pull_request");
  assert.equal(identities.length, 1, JSON.stringify(artifact, null, 2));
  return identities[0];
}

function lifecycleAttributes(trace) {
  const span = trace?.spans?.find((candidate) => candidate.name === "execution_profile_remediation_lifecycle");
  assert.ok(span, "expected execution_profile_remediation_lifecycle span");
  return span.attributes;
}

async function waitForIdle(state, issueId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!state.inFlight.has(issueId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`issue remained in-flight: ${issueId}`);
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
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
  fs.writeFileSync(
    path.join(namespaceRoot, "phoenix-assets.json"),
    `${JSON.stringify({
      prompts: [{
        target_key: "prompt/execution/orchestrator_governing",
        artifact_kind: "accepted_prompt",
        materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
        role: "orchestrator",
        snapshot_path: "execution/evals/execution/accepted-prompts/orchestrator-governing.md",
        snapshot_sha256: sha256(snapshot),
      }],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeReviewAcceptedPromptFixture(repoRoot) {
  const namespaceRoot = path.join(repoRoot, "execution", "evals", "review");
  const promptDir = path.join(namespaceRoot, "accepted-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const governingPath = path.join(promptDir, "orchestrator-governing.md");
  const reviewerPath = path.join(promptDir, "reviewer.md");
  const governing = [
    "# Review Orchestrator",
    "",
    "```yaml",
    "target_key: prompt/review/orchestrator_governing",
    "```",
    "",
    "Run review and emit the S7 review payload.",
    "",
  ].join("\n");
  const reviewer = [
    "# Reviewer",
    "",
    "```yaml",
    "target_key: prompt/review/reviewer",
    "```",
    "",
    "Review the supplied issue and PR diff.",
    "",
  ].join("\n");
  fs.writeFileSync(governingPath, governing, "utf8");
  fs.writeFileSync(reviewerPath, reviewer, "utf8");
  fs.writeFileSync(
    path.join(namespaceRoot, "phoenix-assets.json"),
    `${JSON.stringify({
      prompts: [
        {
          target_key: "prompt/review/orchestrator_governing",
          artifact_kind: "accepted_prompt",
          materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
          role: "orchestrator",
          snapshot_path: "execution/evals/review/accepted-prompts/orchestrator-governing.md",
          snapshot_sha256: sha256(governing),
        },
        {
          target_key: "prompt/review/reviewer",
          artifact_kind: "accepted_prompt",
          materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
          role: "reviewer",
          snapshot_path: "execution/evals/review/accepted-prompts/reviewer.md",
          snapshot_sha256: sha256(reviewer),
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function sha256(value) {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function isoAt(offsetSeconds) {
  return new Date(Date.parse("2026-06-30T12:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function safeRunIdSegment(value) {
  return String(value || "issue").replace(/[^A-Za-z0-9_-]/g, "_");
}

function safeFileSegment(value) {
  return String(value || "issue").replace(/[^A-Za-z0-9._-]/g, "_");
}

function pathStartsWith(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
