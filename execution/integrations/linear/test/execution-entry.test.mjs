import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import { runTriggeredExecution } from "../src/trigger-runner.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION } from "../src/domain-registry.mjs";
import {
  parseRemediationMarker,
  renderRemediationMarker,
} from "../src/remediation-marker.mjs";
import { ISSUE_NEEDS_PRINCIPAL_EFFECT_ID } from "../src/linear/issue-needs-principal-effect.mjs";
import {
  GIT_REPO_COMMIT_EFFECT_ID,
  LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
} from "../src/workflows/execution/effect-ids.mjs";

test("runTriggeredExecution materializes, runs the loop, and reaches the generic commit applier", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-entry-"));
  const promptRoot = writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  const result = await runTriggeredExecution(runOptions({ repoRoot: tempRoot, store, runDeps }));

  assert.equal(result.status, "completed");
  assert.equal(result.result.status, "completed");
  assert.deepEqual(
    result.result.applied.map((effect) => effect.id),
    [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID],
  );
  assert.deepEqual(
    result.result.produced_identities.map((entry) => entry.effect_id),
    [GIT_REPO_COMMIT_EFFECT_ID, LINEAR_ISSUE_IN_REVIEW_EFFECT_ID],
  );
  assert.equal(result.result.produced_identities[0].resource_kind, "github_pull_request");
  assert.equal(result.result.produced_identities[1].resource_kind, "linear_issue");
  assert.equal(runDeps.materializeCalls.length, 1);
  assert.equal(runDeps.teardownCalled, true);
  assert.equal(runDeps.gitEffectCalls.map((entry) => entry.effectId).join(","), [
    GIT_REPO_COMMIT_EFFECT_ID,
    LINEAR_ISSUE_IN_REVIEW_EFFECT_ID,
  ].join(","));
  assert.ok(
    result.result.trace.spans.some((span) =>
      span.name === "commit_effect_apply" &&
      span.attributes.effect_id === GIT_REPO_COMMIT_EFFECT_ID
    ),
    "generic applyCommitEffects should record the git effect apply span",
  );
  assert.equal(fs.existsSync(result.result.durableRecord.artifact_path), true);
  assert.equal(result.result.artifact.payload_schema_id, "linear-execution-run-payload/v1");
  assert.equal(result.result.artifact.resource_manifest[0].label, "acme/product");
  assert.equal(promptRoot.endsWith(path.join("execution", "evals", "execution")), true);
});

test("execution definition run late-binds to runTriggeredExecution", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-definition-run-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  const definition = getWorkflowDefinition("execution");

  const result = await definition.run(runOptions({ repoRoot: tempRoot, store, runDeps }));

  assert.equal(result.status, "completed");
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.applied[0].id, GIT_REPO_COMMIT_EFFECT_ID);
});

test("runTriggeredExecution materializes only the resource_target selected repo", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-selected-"));
  const repoOne = path.join(tempRoot, "repo-one");
  const repoTwo = path.join(tempRoot, "repo-two");
  fs.mkdirSync(repoOne, { recursive: true });
  fs.mkdirSync(repoTwo, { recursive: true });
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const runDeps = createRunDeps({
    tempRoot,
    store,
    workingDirsByResourceId: { "repo-2": repoTwo },
  });
  const resources = [
    gitRepoResource({ id: "repo-1" }),
    gitRepoResource({ id: "repo-2", repo: "api" }),
  ];
  const turns = [];

  const result = await runTriggeredExecution(runOptions({
    repoRoot: tempRoot,
    store,
    runDeps,
    registry: domainRegistry({ resources }),
    issueContext: defaultIssueContext({
      resource_target: { kind: "git_repo", id: "repo-2" },
      work_type: "code",
    }),
    orchestratorTurnExecutor: async (input) => {
      turns.push({ cwd: input.cwd, envAugment: input.envAugment });
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: {
          pr_title: "Implement selected repo",
          pr_body: "Adds the selected repo execution path.",
          linear_issue_id: "issue-1",
          source_refs: [{ kind: "linear_issue", id: "issue-1" }],
          assumptions: [],
          constraints: [],
          risks: [],
        },
        evidence: null,
        sessionHandle: null,
      };
    },
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(runDeps.materializeCalls[0].domainResources.map((resource) => resource.id), ["repo-2"]);
  assert.equal(turns[0].cwd, repoTwo);
  assert.equal(result.result.trace.attributes.selected_resource_id, "repo-2");
  assert.equal(result.result.trace.attributes["resource.id"], "repo-2");
  assert.equal(result.result.trace.attributes.work_type, "code");
});

test("runTriggeredExecution files a remediation blocker on a red execution profile preflight", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-preflight-red-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const originalIssue = defaultIssueContext({
    teamId: "team-1",
    team: { id: "team-1", key: "AF", name: "Teami" },
    projectId: "project-1",
    project: { id: "project-1", name: "Execution Project" },
    labels: [{ id: "label-code", name: "Code" }],
  });
  const linearClient = capturingExecutionLinearClient(originalIssue);
  const redVerdict = {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["no_runnable_test_command"],
      missing: ["package.json:scripts.test"],
    },
    failure_reasons: ["no_runnable_test_command"],
  };
  const runDeps = createRunDeps({ tempRoot, store });
  runDeps.executionProfilePreflight = async () => redVerdict;

  const result = await runTriggeredExecution(runOptions({
    repoRoot: tempRoot,
    store,
    runDeps,
    issueContext: originalIssue,
    linearClient,
    orchestratorTurnExecutor: async () => {
      throw new Error("orchestrator should not run after red readiness preflight");
    },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.reason, "dependency_blocked");
  assert.equal(result.result.status, "waiting");
  assert.equal(result.result.reason, "dependency_blocked");
  assert.deepEqual(result.result.execution_profile_preflight, { ...redVerdict, preflight_profile: "default" });
  assert.deepEqual(result.result.readinessVerdict, { ...redVerdict, preflight_profile: "default" });
  assert.deepEqual(result.result.applied.map((effect) => effect.id), ["linear_execution_preflight_remediation"]);
  assert.deepEqual(result.result.produced_identities.map((entry) => entry.resource_kind), ["linear_remediation"]);
  assert.equal(runDeps.teardownCalled, true);
  assert.equal(runDeps.gitEffectCalls.length, 0);
  assert.equal(linearClient.createdIssues.length, 1);
  assert.equal(linearClient.issueUpdates.length, 0);
  assert.equal(originalIssue.state.id, "state-ready");
  assert.notEqual(originalIssue.state.id, "state-blocked");

  const remediation = linearClient.createdIssues[0];
  assert.equal(remediation.teamId, "team-1");
  assert.equal(remediation.projectId, "project-1");
  assert.equal(remediation.stateId, "state-ready");
  assert.deepEqual(remediation.labelIds, ["label-code"]);
  assert.deepEqual(parseRemediationMarker(remediation.description), {
    v: 1,
    kind: "readiness_repair",
    resource_id: "repo-1",
    failure_signature: result.result.remediation.marker.failure_signature,
  });
  assert.deepEqual(linearClient.relations.map((relation) => ({
    issueId: relation.issueId,
    relatedIssueId: relation.relatedIssueId,
    type: relation.type,
  })), [{
    issueId: remediation.id,
    relatedIssueId: "issue-1",
    type: "blocks",
  }]);
  assert.ok(
    result.result.trace.spans.some((span) =>
      span.name === "execution_profile_preflight" &&
      span.attributes.ok === false &&
      span.attributes.resource_id === "repo-1"
    ),
    "red preflight should be visible on the execution trace",
  );
  assert.ok(
    result.result.trace.spans.some((span) =>
      span.name === "execution_profile_remediation_blocker_filed" &&
      span.attributes.remediation_issue_id === remediation.id &&
      span.attributes.relation_type === "blocks"
    ),
    "remediation filing should be visible on the execution trace",
  );
  assert.deepEqual(lifecycleAttributes(result.result.trace), {
    original_issue_id: "issue-1",
    remediation_issue_id: remediation.id,
    resource_id: "repo-1",
    failure_signature: result.result.remediation.marker.failure_signature,
    retry_cycle: 1,
    outcome: "filed",
  });
});

test("runTriggeredExecution dedups open remediation blockers by marker", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-remediation-dedup-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const linearClient = capturingExecutionLinearClient([
    defaultIssueContext({ id: "issue-1", identifier: "AF-1" }),
    defaultIssueContext({ id: "issue-2", identifier: "AF-2" }),
    defaultIssueContext({ id: "issue-3", identifier: "AF-3" }),
    defaultIssueContext({ id: "issue-4", identifier: "AF-4" }),
  ]);
  const baseRed = redPreflightVerdict({
    reasonCodes: ["no_runnable_test_command"],
    missing: ["package.json:scripts.test"],
  });
  const differentRed = redPreflightVerdict({
    reasonCodes: ["setup_command_failed"],
    missing: ["npm install"],
  });

  const first = await runRedPreflight({ tempRoot, linearClient, issueId: "issue-1", verdict: baseRed });
  assert.equal(first.result.remediation.created, true);
  assert.equal(linearClient.createdIssues.length, 1);
  const firstRemediation = linearClient.createdIssues[0];

  const second = await runRedPreflight({ tempRoot, linearClient, issueId: "issue-2", verdict: baseRed });
  assert.equal(second.result.remediation.dedup_reused, true);
  assert.equal(second.result.remediation.issue.id, firstRemediation.id);
  assert.equal(linearClient.createdIssues.length, 1, "same open marker must not create a duplicate remediation");
  assert.deepEqual(linearClient.relations.at(-1), {
    issueId: firstRemediation.id,
    relatedIssueId: "issue-2",
    type: "blocks",
  });
  assert.equal(lifecycleAttributes(second.result.trace).outcome, "reused_open_remediation");

  const third = await runRedPreflight({ tempRoot, linearClient, issueId: "issue-3", verdict: differentRed });
  assert.equal(third.result.remediation.created, true);
  assert.equal(linearClient.createdIssues.length, 2, "different signature files a new remediation");

  linearClient.setIssueState(firstRemediation.id, "state-done");
  const fourth = await runRedPreflight({ tempRoot, linearClient, issueId: "issue-4", verdict: baseRed });
  assert.equal(fourth.result.remediation.created, true);
  assert.equal(linearClient.createdIssues.length, 3, "completed old remediation does not dedup a new original");
});

test("runTriggeredExecution caps remediation retry from durable blocker relations", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-remediation-cap-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const previousMarker = {
    v: 1,
    kind: "readiness_repair",
    resource_id: "repo-1",
    failure_signature: "sha256:previous",
  };
  const previousRemediation = remediationIssueContext({
    id: "repair-previous",
    identifier: "AF-R1",
    marker: previousMarker,
    state: { id: "state-done", name: "Done", type: "completed" },
  });
  const originalIssue = defaultIssueContext({
    id: "issue-1",
    relations: [blocksRelation({ blocker: previousRemediation, dependent: { id: "issue-1" } })],
  });
  const linearClient = capturingExecutionLinearClient([originalIssue, previousRemediation]);

  const result = await runRedPreflight({
    tempRoot,
    linearClient,
    issueId: "issue-1",
    verdict: redPreflightVerdict(),
  });

  assert.equal(result.result.status, "completed");
  assert.equal(result.result.reason, "remediation_retry_cap_exceeded");
  assert.deepEqual(result.result.applied.map((effect) => effect.id), [ISSUE_NEEDS_PRINCIPAL_EFFECT_ID]);
  assert.equal(linearClient.createdIssues.length, 0);
  assert.equal(linearClient.issueUpdates.length, 1);
  assert.equal(linearClient.issueStateName("issue-1"), "Blocked");
  assert.deepEqual(lifecycleAttributes(result.result.trace), {
    original_issue_id: "issue-1",
    remediation_issue_id: "repair-previous",
    resource_id: "repo-1",
    failure_signature: result.result.remediation.marker.failure_signature,
    retry_cycle: 2,
    outcome: "remediation_retry_cap_exceeded",
  });
});

test("runTriggeredExecution counts cancelled remediation blockers toward the cap", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-remediation-cancelled-cap-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const cancelledRemediation = remediationIssueContext({
    id: "repair-cancelled",
    identifier: "AF-R2",
    marker: {
      v: 1,
      kind: "readiness_repair",
      resource_id: "repo-1",
      failure_signature: "sha256:cancelled",
    },
    state: { id: "state-canceled", name: "Won't Fix", type: "canceled" },
  });
  const originalIssue = defaultIssueContext({
    id: "issue-1",
    relations: [blocksRelation({ blocker: cancelledRemediation, dependent: { id: "issue-1" } })],
  });
  const linearClient = capturingExecutionLinearClient([originalIssue, cancelledRemediation]);

  const result = await runRedPreflight({
    tempRoot,
    linearClient,
    issueId: "issue-1",
    verdict: redPreflightVerdict(),
  });

  assert.equal(result.result.reason, "remediation_retry_cap_exceeded");
  assert.equal(linearClient.createdIssues.length, 0);
  assert.equal(linearClient.issueStateName("issue-1"), "Blocked");
  assert.equal(lifecycleAttributes(result.result.trace).retry_cycle, 2);
});

test("runTriggeredExecution escalates instead of filing when merge-to-Done automation is missing", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-remediation-merge-gate-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const linearClient = capturingExecutionLinearClient(defaultIssueContext(), {
    mergeDoneOk: false,
  });

  const result = await runRedPreflight({
    tempRoot,
    linearClient,
    issueId: "issue-1",
    verdict: redPreflightVerdict(),
  });

  assert.equal(result.result.status, "completed");
  assert.equal(result.result.reason, "merge_done_automation_missing");
  assert.deepEqual(result.result.applied.map((effect) => effect.id), [ISSUE_NEEDS_PRINCIPAL_EFFECT_ID]);
  assert.equal(linearClient.createdIssues.length, 0);
  assert.equal(linearClient.issueStateName("issue-1"), "Blocked");
  assert.deepEqual(lifecycleAttributes(result.result.trace), {
    original_issue_id: "issue-1",
    remediation_issue_id: null,
    resource_id: "repo-1",
    failure_signature: result.result.remediation.marker.failure_signature,
    retry_cycle: 1,
    outcome: "merge_done_automation_missing",
  });
});

test("runTriggeredExecution emits filing and retry outcome lifecycle trace attributes", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-remediation-trace-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const linearClient = capturingExecutionLinearClient(defaultIssueContext());
  const filing = await runRedPreflight({
    tempRoot,
    linearClient,
    issueId: "issue-1",
    verdict: redPreflightVerdict(),
  });
  const remediation = linearClient.createdIssues[0];
  const filingLifecycle = lifecycleAttributes(filing.result.trace);
  assert.deepEqual(Object.keys(filingLifecycle).sort(), remediationLifecycleKeys());
  assert.deepEqual(filingLifecycle, {
    original_issue_id: "issue-1",
    remediation_issue_id: remediation.id,
    resource_id: "repo-1",
    failure_signature: filing.result.remediation.marker.failure_signature,
    retry_cycle: 1,
    outcome: "filed",
  });

  linearClient.setIssueState(remediation.id, "state-done");
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  const retry = await runTriggeredExecution(runOptions({
    repoRoot: tempRoot,
    store,
    runDeps,
    issueId: "issue-1",
    linearClient,
  }));

  assert.equal(retry.result.status, "completed");
  const retryLifecycle = lifecycleAttributes(retry.result.trace);
  assert.deepEqual(Object.keys(retryLifecycle).sort(), remediationLifecycleKeys());
  assert.deepEqual(retryLifecycle, {
    original_issue_id: "issue-1",
    remediation_issue_id: remediation.id,
    resource_id: "repo-1",
    failure_signature: filingLifecycle.failure_signature,
    retry_cycle: 2,
    outcome: "passed",
  });
  assert.equal(filingLifecycle.original_issue_id, retryLifecycle.original_issue_id);
  assert.equal(filingLifecycle.resource_id, retryLifecycle.resource_id);
});

test("runTriggeredExecution uses readiness repair preflight profile for marker-bearing issues", async () => {
  registerGitRepoResourceKind();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-exec-repair-profile-"));
  writeExecutionAcceptedPromptFixture(tempRoot);
  const store = createFakeStore();
  const preflightCalls = [];
  const runDeps = createRunDeps({ tempRoot, store });
  runDeps.executionProfilePreflight = async (input) => {
    preflightCalls.push(input);
    return {
      ok: true,
      resource_id: input.resourceId,
      strict_baseline_green: false,
    };
  };
  const issueContext = defaultIssueContext({
    description: [
      "Repair readiness.",
      "",
      renderRemediationMarker({
        v: 1,
        kind: "readiness_repair",
        resource_id: "repo-1",
        failure_signature: "sha256:abc123",
      }).trimEnd(),
    ].join("\n"),
  });

  const result = await runTriggeredExecution(runOptions({
    repoRoot: tempRoot,
    store,
    runDeps,
    issueContext,
  }));

  assert.equal(result.status, "completed");
  assert.equal(preflightCalls.length, 1);
  assert.equal(preflightCalls[0].preflightProfile, "readiness_repair");
  assert.equal(preflightCalls[0].skipReadiness, true);
});

test("runTriggeredExecution rejects multi-repo missing or invalid resource_target before materialization", async () => {
  registerGitRepoResourceKind();
  const cases = [
    {
      name: "missing",
      issueContext: defaultIssueContext(),
      reason: "resource_target_missing",
    },
    {
      name: "invalid",
      issueContext: defaultIssueContext({ resource_target: { kind: "git_repo", id: "repo-missing" } }),
      reason: "resource_target_not_allowed",
    },
  ];

  for (const fixture of cases) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `teami-exec-${fixture.name}-target-`));
    writeExecutionAcceptedPromptFixture(tempRoot);
    const store = createFakeStore();
    const runDeps = createRunDeps({ tempRoot, store });
    const resources = [
      gitRepoResource({ id: "repo-1" }),
      gitRepoResource({ id: "repo-2", repo: "api" }),
    ];

    const result = await runTriggeredExecution(runOptions({
      repoRoot: tempRoot,
      store,
      runDeps,
      registry: domainRegistry({ resources }),
      issueContext: fixture.issueContext,
      orchestratorTurnExecutor: async () => {
        throw new Error("orchestrator should not run without a selected resource");
      },
    }));

    assert.equal(result.status, "rejected");
    assert.equal(result.reason, fixture.reason);
    assert.equal(runDeps.materializeCalls.length, 0);
  }
});

function runOptions({
  repoRoot,
  store,
  runDeps,
  issueId = "issue-1",
  domainContext: selectedDomainContext = domainContext(),
  registry = domainRegistry(),
  issueContext = defaultIssueContext(),
  linearClient = null,
  orchestratorTurnExecutor = null,
} = {}) {
  return {
    issueId,
    domainContext: selectedDomainContext,
    registry,
    claim: {
      ok: true,
      leaseToken: "lease-1",
      event: {
        id: "event-1",
        event_id: "evt-1",
        provider: "linear",
      },
      wake: {
        id: `wake-${issueId}`,
        workspace_id: "workspace-1",
        domain_id: "domain-1",
        trigger_type: "linear.issue.ready",
        workflow_type: "execution",
        object_type: "issue",
        object_id: issueId,
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
    linearClient: linearClient || {
      async getIssueContext(requestedIssueId) {
        return {
          ...issueContext,
          id: issueContext.id || requestedIssueId,
        };
      },
    },
    config: executionConfig(),
    cache: {
      workspaceId: "workspace-1",
      teamId: "team-1",
      issueStatuses: {
        blocked: "state-blocked",
        todo: "state-ready",
      },
      issueLabels: {
        Code: "label-code",
        work_type_code: "label-code",
        "Needs Principal": "label-needs-principal",
        needs_principal: "label-needs-principal",
      },
    },
    repoRoot,
    runStoreDir: path.join(repoRoot, ".teami", "runs"),
    runtimeExecutor: {
      async executeSubagent() {
        throw new Error("subagent executor should not be called by this one-turn fixture");
      },
    },
    orchestratorTurnExecutor: orchestratorTurnExecutor || (async () => ({
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: {
        pr_title: "Implement EXEC-ENTRY",
        pr_body: "Adds the execution entry path.",
        linear_issue_id: "issue-1",
        source_refs: [{ kind: "linear_issue", id: "issue-1" }],
        assumptions: [],
        constraints: [],
        risks: [],
      },
      evidence: null,
      sessionHandle: null,
    })),
    runDeps,
  };
}

function defaultIssueContext(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "AF-1",
    title: "Implement EXEC-ENTRY",
    description: "Wire execution entry.",
    state: { id: "state-ready", name: "Ready", type: "unstarted" },
    relations: [],
    ...overrides,
  };
}

async function runRedPreflight({ tempRoot, linearClient, issueId = "issue-1", verdict = redPreflightVerdict() }) {
  const store = createFakeStore();
  const runDeps = createRunDeps({ tempRoot, store });
  runDeps.executionProfilePreflight = async () => verdict;
  return runTriggeredExecution(runOptions({
    repoRoot: tempRoot,
    store,
    runDeps,
    issueId,
    linearClient,
    orchestratorTurnExecutor: async () => {
      throw new Error("orchestrator should not run after red readiness preflight");
    },
  }));
}

function redPreflightVerdict({
  resourceId = "repo-1",
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

function lifecycleAttributes(trace) {
  const span = trace?.spans?.find((candidate) => candidate.name === "execution_profile_remediation_lifecycle");
  assert.ok(span, "expected execution_profile_remediation_lifecycle span");
  return span.attributes;
}

function remediationLifecycleKeys() {
  return [
    "failure_signature",
    "original_issue_id",
    "outcome",
    "remediation_issue_id",
    "resource_id",
    "retry_cycle",
  ];
}

function remediationIssueContext({
  id,
  identifier,
  marker,
  state,
} = {}) {
  return defaultIssueContext({
    id,
    identifier,
    title: "Repair execution readiness",
    description: [
      "Repair readiness.",
      "",
      renderRemediationMarker(marker).trimEnd(),
    ].join("\n"),
    state,
  });
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
      state: dependent.state || { id: "state-ready", name: "Ready", type: "unstarted" },
    },
  };
}

function capturingExecutionLinearClient(issueContexts, { mergeDoneOk = true } = {}) {
  const createdIssues = [];
  const relations = [];
  const issueUpdates = [];
  const states = new Map([
    ["state-ready", { id: "state-ready", name: "Ready", type: "unstarted", teamId: "team-1" }],
    ["state-blocked", { id: "state-blocked", name: "Blocked", type: "started", teamId: "team-1" }],
    ["state-in-review", { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" }],
    ["state-done", { id: "state-done", name: "Done", type: "completed", teamId: "team-1" }],
    ["state-canceled", { id: "state-canceled", name: "Won't Fix", type: "canceled", teamId: "team-1" }],
  ]);
  const labels = new Map([
    ["label-code", { id: "label-code", name: "Code", teamId: "team-1" }],
    ["label-needs-principal", { id: "label-needs-principal", name: "Needs Principal", teamId: "team-1" }],
  ]);
  const issues = new Map();
  const relationRecords = [];
  for (const context of Array.isArray(issueContexts) ? issueContexts : [issueContexts]) {
    addIssue(context);
  }
  for (const context of Array.isArray(issueContexts) ? issueContexts : [issueContexts]) {
    for (const relation of context?.relations || []) seedRelation(relation);
  }

  return {
    createdIssues,
    relations,
    issueUpdates,
    async getIssueContext(issueId) {
      return issueView(issueId);
    },
    async getIssue(issueId) {
      return issueView(issueId);
    },
    async listIssues({ teamId = null, projectId = null, query = null, stateId = null, labelId = null } = {}) {
      const search = String(query || "").toLowerCase();
      return [...issues.values()]
        .filter((issue) => !teamId || issue.teamId === teamId || issue.team?.id === teamId)
        .filter((issue) => !projectId || issue.projectId === projectId || issue.project?.id === projectId)
        .filter((issue) => !stateId || issue.state?.id === stateId)
        .filter((issue) => !labelId || issue.labels?.some((label) => label.id === labelId))
        .filter((issue) => {
          if (!search) return true;
          return `${issue.title || ""}\n${issue.description || ""}`.toLowerCase().includes(search);
        })
        .map((issue) => issueView(issue.id));
    },
    async searchIssues(options) {
      return this.listIssues(options);
    },
    async createIssue(input) {
      const issue = {
        id: `repair-${createdIssues.length + 1}`,
        identifier: `AF-R${createdIssues.length + 1}`,
        url: `https://linear.test/${createdIssues.length + 1}`,
        ...input,
        state: states.get(input.stateId) || states.get("state-ready"),
        labels: (input.labelIds || []).map((id) => labels.get(id) || { id }),
      };
      createdIssues.push(issue);
      issues.set(issue.id, issue);
      return issue;
    },
    async findOrCreateIssueRelation(input) {
      const existing = relationRecords.find((relation) =>
        relation.issueId === input.issueId &&
        relation.relatedIssueId === input.relatedIssueId &&
        relation.type === input.type
      );
      if (existing) {
        relations.push(input);
        return {
          created: false,
          relation: relationView(existing),
        };
      }
      relations.push(input);
      const record = {
        id: `relation-${relationRecords.length + 1}`,
        ...input,
      };
      relationRecords.push(record);
      return {
        created: true,
        relation: relationView(record),
      };
    },
    async updateIssue(issueId, input) {
      issueUpdates.push({ issueId, input });
      const issue = issues.get(issueId);
      if (!issue) throw new Error(`unknown issue: ${issueId}`);
      if (input.stateId) issue.state = states.get(input.stateId) || { id: input.stateId };
      if (Array.isArray(input.labelIds)) {
        issue.labels = input.labelIds.map((labelId) => labels.get(labelId) || { id: labelId });
      }
      return issueView(issueId);
    },
    async findIssueLabelsByName(name, teamId) {
      return [...labels.values()]
        .filter((label) => !teamId || label.teamId === teamId)
        .filter((label) => !name || label.name === name);
    },
    async listWorkflowStates(teamId) {
      return [...states.values()].filter((state) => !teamId || state.teamId === teamId);
    },
    async getTeamGitAutomationSettings(teamId) {
      assert.equal(teamId, "team-1");
      return {
        mergeWorkflowState: mergeDoneOk ? states.get("state-done") : states.get("state-in-review"),
        gitAutomationStates: [],
      };
    },
    setIssueState(issueId, stateId) {
      const issue = issues.get(issueId);
      if (!issue) throw new Error(`unknown issue: ${issueId}`);
      issue.state = states.get(stateId) || { id: stateId };
      issue.stateId = stateId;
    },
    issueStateName(issueId) {
      return issues.get(issueId)?.state?.name || null;
    },
  };

  function addIssue(context = {}) {
    if (!context?.id) return null;
    const issue = {
      teamId: "team-1",
      team: { id: "team-1", key: "AF", name: "Teami" },
      projectId: "project-1",
      project: { id: "project-1", name: "Execution Project" },
      labels: [],
      ...context,
      state: context.state || states.get(context.stateId) || states.get("state-ready"),
    };
    delete issue.relations;
    issues.set(issue.id, issue);
    return issue;
  }

  function seedRelation(relation) {
    if (!relation?.issue?.id || !relation?.relatedIssue?.id) return;
    addIssue(relation.issue);
    addIssue(relation.relatedIssue);
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

function createRunDeps({ tempRoot, store, workingDirsByResourceId = {} }) {
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
      const workingDir = workingDirsByResourceId[selectedResourceId] || tempRoot;
      const selectedResource = {
        id: selectedResourceId,
        kind: selected?.kind || "git_repo",
        role: selected?.role || "primary",
        handle: {
          workingDir,
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
            label: `${selectedResource.handle.owner}/${selectedResource.handle.repo}`,
          }],
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

function domainContext({ resources = null } = {}) {
  const context = {
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
  };
  if (resources) context.resources = resources;
  return context;
}

function domainRegistry({ resources = [gitRepoResource()] } = {}) {
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
      resources,
      policy_profile: "default",
      policy_overlay_ref: null,
    }],
  };
}

function gitRepoResource({
  id = "repo-1",
  owner = "acme",
  repo = "product",
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
      issue: {
        statuses: {
          blocked: { name: "Blocked", type: "started" },
        },
        labels: {
          work_type_code: "Code",
          needs_principal: "Needs Principal",
        },
      },
    },
  };
}
