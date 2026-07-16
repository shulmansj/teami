import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "../../../engine/orchestrator-turn-contract.mjs";
import { defaultRunStoreDir, writeRunArtifact } from "../../../engine/run-store.mjs";
import {
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../../../engine/runtime-environment.mjs";
import {
  branchNameForIssue,
} from "../../git/git-repo-commit-effect.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import { runBoundedGit, runBoundedSubprocess } from "../../git/bounded-subprocess.mjs";
import { readLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readTeamRegistry } from "../src/team-registry.mjs";
import { buildTeamContext } from "../src/team-resolver.mjs";
import { createDefaultExecutionPullRequestAdapter } from "../src/execution-pr-adapter.mjs";
import {
  computeIssueTriggerFingerprint,
  runFreshIssueSyntheticWake,
  runGatewayOnce,
} from "../src/gateway-loop.mjs";
import {
  assertNoGitHubCredentialLeaks,
  scanGitHubCredentialLeaks,
} from "./github-local-uat.mjs";
import {
  GITHUB_AUTH_ENV_NAMES,
  redactGitHubSecrets,
} from "../src/github-secret-hygiene.mjs";
import { parseGitHubRemoteUrl } from "../src/github-setup.mjs";
import { createLinearCredentialStore } from "../src/linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../src/linear-setup-auth.mjs";
import { issueMatchesInReviewTarget } from "../src/linear/issue-in-review-effect.mjs";
import {
  resolveInReviewIssueStatus,
  resolveIssueStatuses,
} from "../src/linear/shape-resolver.mjs";
import { createLocalTriggerStore, localTriggerStorePath, readLocalTriggerState } from "../src/local-trigger-store.mjs";
import { resourcesToRepoIdentity } from "../src/review-pr-discovery.mjs";
import {
  clearMutationIntent,
  readGitReplayPending,
  readSuppression,
} from "../src/trigger-idempotency.mjs";
import { runTriggeredExecution } from "../src/trigger-runner.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const HARNESS_PATH = path.join(MODULE_DIR, "execution-uat.mjs");

export const DEFAULT_EXECUTION_UAT_PREFIX = "AF-EXEC-UAT";
export const DEFAULT_EXECUTION_UAT_CONSECUTIVE = 2;
export const DEFAULT_EXECUTION_UAT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_EXECUTION_UAT_POLL_GRACE_MS = 5_000;
export const DEFAULT_CHILD_CRASH_TIMEOUT_MS = 5 * 60 * 1000;
export const CHILD_EVENT_TYPE = "teami_execution_uat";

export const CRASH_SCENARIOS = Object.freeze({
  after_git_push_before_pr: Object.freeze({
    killPoint: "after_git_push_before_pr",
    description: "kill between git push and PR open",
  }),
});

class ExecutionUatUserError extends Error {
  constructor(message, code = "uat_user_error") {
    super(message);
    this.name = "ExecutionUatUserError";
    this.code = code;
  }
}

export function parseExecutionUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(
      env.TEAMI_EXECUTION_UAT_REPO_ROOT ||
      env.TEAMI_UAT_REPO_ROOT ||
      REPO_ROOT,
    ),
    teamRef: env.TEAMI_EXECUTION_UAT_TEAM || env.TEAMI_UAT_TEAM || null,
    prefix: env.TEAMI_EXECUTION_UAT_PREFIX || DEFAULT_EXECUTION_UAT_PREFIX,
    consecutive: parsePositiveInteger(
      env.TEAMI_EXECUTION_UAT_CONSECUTIVE,
      DEFAULT_EXECUTION_UAT_CONSECUTIVE,
    ),
    pollIntervalMs: parsePositiveInteger(env.TEAMI_EXECUTION_UAT_POLL_INTERVAL_MS, null),
    pollGraceMs: parsePositiveInteger(
      env.TEAMI_EXECUTION_UAT_POLL_GRACE_MS,
      DEFAULT_EXECUTION_UAT_POLL_GRACE_MS,
    ),
    timeoutMs: parsePositiveInteger(env.TEAMI_EXECUTION_UAT_TIMEOUT_MS, DEFAULT_EXECUTION_UAT_TIMEOUT_MS),
    keepArtifacts: truthy(env.TEAMI_EXECUTION_UAT_KEEP_ARTIFACTS || env.TEAMI_UAT_KEEP_ARTIFACTS),
    expectedRepoName: env.TEAMI_EXECUTION_UAT_REPO_NAME || undefined,
    resourceId: null,
    childCrash: null,
    childIssueId: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--team") {
      options.teamRef = requireNext(argv, ++index, arg);
    } else if (arg === "--resource-id") {
      options.resourceId = requireNext(argv, ++index, arg);
    } else if (arg === "--prefix") {
      options.prefix = requireNext(argv, ++index, arg);
    } else if (arg === "--consecutive") {
      options.consecutive = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_EXECUTION_UAT_CONSECUTIVE);
    } else if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = parsePositiveInteger(requireNext(argv, ++index, arg), null);
    } else if (arg === "--poll-grace-ms") {
      options.pollGraceMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_EXECUTION_UAT_POLL_GRACE_MS);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_EXECUTION_UAT_TIMEOUT_MS);
    } else if (arg === "--keep-artifacts") {
      options.keepArtifacts = true;
    } else if (arg === "--expected-repo-name") {
      options.expectedRepoName = requireNext(argv, ++index, arg);
    } else if (arg === "--child-crash") {
      options.childCrash = requireNext(argv, ++index, arg);
    } else if (arg === "--issue-id") {
      options.childIssueId = requireNext(argv, ++index, arg);
    } else {
      throw new ExecutionUatUserError(`unknown uat:execution flag: ${arg}`, "usage");
    }
  }

  if (options.consecutive < 2) {
    throw new ExecutionUatUserError("--consecutive must be at least 2 for the execution UAT acceptance bar", "usage");
  }
  if (options.childCrash && !CRASH_SCENARIOS[options.childCrash]) {
    throw new ExecutionUatUserError(`unknown crash scenario: ${options.childCrash}`, "usage");
  }
  if (options.childCrash && !options.childIssueId) {
    throw new ExecutionUatUserError("--issue-id is required with --child-crash", "usage");
  }
  return options;
}

export function buildExecutionUatUsage() {
  return [
    "Usage: npm run uat:execution -- --repo-root <path-to-your-bound-checkout> [--team <id>] [--resource-id <git_repo_resource_id>] [--consecutive 2] [--keep-artifacts]",
    "",
    "Live prerequisites:",
    "- The repo root must be the checkout bound to your team's git_repo resource; use --resource-id when the team binds multiple git_repo resources.",
    "- The selected Linear team must be active and have OAuth read/write credentials.",
    "- The team must bind a git_repo resource whose owner/repo matches the repo root's origin.",
    "- The issue statuses Ready, In Review, and Backlog cleanup status must be configured/resolvable.",
    "- `gh auth status --hostname github.com` and `gh auth token` must work; the harness uses that ambient token for PRs.",
    "",
    "Environment equivalents:",
    "- TEAMI_EXECUTION_UAT_TEAM selects the disposable Linear team/team.",
    "- TEAMI_EXECUTION_UAT_PREFIX controls disposable Linear issue title prefixes.",
    "- TEAMI_EXECUTION_UAT_KEEP_ARTIFACTS=1 keeps PRs, branches, and Linear issue states.",
    "- TEAMI_EXECUTION_UAT_REPO_NAME enables an optional explicit repo-name guard.",
  ].join("\n");
}

export async function runExecutionUat(options = parseExecutionUatArgs()) {
  registerGitRepoResourceKind();
  const context = await prepareLiveExecutionUatContext(options);
  const report = {
    ok: false,
    runId: `execution-uat-${uatStamp()}-${randomBytes(3).toString("hex")}`,
    repoRoot: context.repoRoot,
    teamRef: context.team.id,
    prefix: context.prefix,
    scenarios: [],
    createdIssues: context.createdIssues,
    createdPullRequests: context.createdPullRequests,
    createdBranches: context.createdBranches,
    workerProofs: [],
    cleanup: null,
    evidencePath: null,
  };

  try {
    for (let index = 0; index < context.consecutive; index += 1) {
      report.scenarios.push(await runFreshExecutionScenario(context, { index: index + 1 }));
    }
    report.scenarios.push(await runBlockedDependentScenario(context));
    report.scenarios.push(await runOpenPrReplayScenario(context));
    report.scenarios.push(await runCrashReplayScenario(context));

    report.workerProofs = [...context.workerProofs.values()];
    assertWorkerContainmentProofs(report.workerProofs);
    assertNoGitHubCredentialLeaks(scanGitHubCredentialLeaks({
      scenarios: report.scenarios,
      workerProofs: report.workerProofs,
      logs: context.logs,
    }));

    report.ok = report.scenarios.every((scenario) => scenario.ok);
    report.evidencePath = writeRunArtifact({ repoRoot: context.repoRoot, runId: report.runId }, {
      kind: "commit",
      run_id: report.runId,
      team_ref: context.team.id,
      workspace_id: context.teamContext.linear.workspaceId,
      team_id: context.teamContext.linear.teamId,
      function_version: "execution-uat/v1",
      workflow_version: "execution-uat/v1",
      runtime_assignments: { uat: { runtime: "node" } },
      runtime_metadata: { uat: { runtime_name: "execution-uat" } },
      terminal_output: {
        run_id: report.runId,
        outcome: "commit",
        reason: "execution_uat_passed",
        context_digest: "Execution UAT drove live Linear Ready issue polling, git push, PR open, replay, and containment checks.",
        source_refs: report.scenarios.flatMap((scenario) => scenario.sourceRefs || []),
        assumptions: [],
        constraints: ["live_linear", "live_github", "ambient_gh_auth", "worker_write_creds_absent"],
        risks: ["Disposable live artifacts are cleaned up unless --keep-artifacts is set."],
      },
      evidence: {
        perspectives_run: [],
        tool_events: [],
        evidence_unavailable: [],
      },
      bounds: { rounds_used: report.scenarios.length, max_rounds: report.scenarios.length },
      payload_schema_id: "teami-execution-uat/v1",
      payload: report,
      accepted_refs: [],
      completed_at: new Date().toISOString(),
      execution_mode: "live",
      started_at: context.startedAt,
    });
    context.log(`Wrote execution UAT evidence ${report.evidencePath}`);
    return report;
  } finally {
    report.cleanup = await cleanupExecutionUatArtifacts(context);
  }
}

async function prepareLiveExecutionUatContext(options) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const startedAt = new Date().toISOString();
  const logs = [];
  const log = (line) => {
    const safe = redactGitHubSecrets(line);
    logs.push(safe);
    options.onLog?.(safe);
  };

  if (!fs.existsSync(repoRoot)) {
    throw new ExecutionUatUserError(`repo root does not exist: ${repoRoot}`, "repo_root");
  }

  const config = loadLinearConfig({ repoRoot });
  const registry = readTeamRegistry({ repoRoot });
  const team = selectUatTeam({ registry, teamRef: options.teamRef });
  const teamContext = buildTeamContext({ team, config, repoRoot });
  const credentialStore = createLinearCredentialStore({ config, repoRoot, teamContext });
  const tokenSet = await readLinearTokenSet(credentialStore);
  if (!tokenSet?.refreshToken && !tokenSet?.accessToken) {
    throw new ExecutionUatUserError("no Linear OAuth credentials found for the selected team", "no_linear_credential");
  }

  const client = createLinearSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  }).client;
  await client.verifyAuth();

  const cache = readLinearCache(teamContext.linear.cachePath);
  const issueStatuses = await resolveIssueStatuses(client, config, team.linear.team_id);
  if (!issueStatuses.ready?.id) {
    throw new ExecutionUatUserError(
      "Execution UAT requires config.linear.issue.statuses.ready.name to resolve a Ready workflow state.",
      "ready_status_missing",
    );
  }
  if (!issueStatuses.backlog?.id) {
    throw new ExecutionUatUserError(
      "Execution UAT requires config.linear.issue.statuses.backlog.name for cleanup.",
      "backlog_status_missing",
    );
  }
  const inReviewTarget = await resolveInReviewIssueStatus(client, config, team.linear.team_id);
  if (!inReviewTarget?.id) {
    throw new ExecutionUatUserError(
      "Execution UAT requires config.linear.issue.statuses.in_review.name to resolve.",
      "in_review_status_missing",
    );
  }
  const completedStatus = await resolveCompletedIssueStatus(client, team.linear.team_id);

  const repoIdentity = resourcesToRepoIdentity(teamContext, { resourceId: options.resourceId });
  await assertUatRepoBinding({
    repoRoot,
    repoIdentity,
    expectedRepoName: options.expectedRepoName,
  });

  await assertGhAuthStatus({ repoRoot });
  const githubToken = await resolveGhToken({ repoRoot });
  log(`Execution UAT using ${repoIdentity.owner}/${repoIdentity.repo} with ambient gh auth`);

  const pollIntervalMs = options.pollIntervalMs || config.poll?.interval_ms || 10_000;
  const liveConfig = structuredClone(config);
  liveConfig.poll ||= {};
  liveConfig.poll.interval_ms = pollIntervalMs;

  return {
    ...options,
    repoRoot,
    startedAt,
    config: liveConfig,
    registry,
    team,
    teamContext,
    cache,
    client,
    issueStatuses,
    inReviewTarget,
    completedStatus,
    repoIdentity,
    githubToken,
    pollIntervalMs,
    pollGraceMs: options.pollGraceMs || DEFAULT_EXECUTION_UAT_POLL_GRACE_MS,
    timeoutMs: options.timeoutMs || DEFAULT_EXECUTION_UAT_TIMEOUT_MS,
    consecutive: options.consecutive || DEFAULT_EXECUTION_UAT_CONSECUTIVE,
    prefix: options.prefix || DEFAULT_EXECUTION_UAT_PREFIX,
    createdIssues: [],
    createdPullRequests: [],
    createdBranches: [],
    workerProofs: new Map(),
    logs,
    log,
  };
}

async function runFreshExecutionScenario(context, { index }) {
  const issue = await createDisposableReadyIssue(context, {
    slug: `fresh-${index}`,
    summary: "Fresh execution UAT issue. The gateway should open one real PR and move this issue to In Review.",
  });
  const pass = await runSingleGatewayPass(context, { label: `fresh-${index}` });
  assertCondition(
    pass.events.some((event) => event.issueId === issue.id && event.state === "working"),
    `fresh scenario ${index} did not emit a working status for ${issue.id}`,
  );

  const observed = await waitForIssueExecutionResult(context, issue.id, {
    expectedOpenPrCount: 1,
    requireWorkerProof: true,
  });
  context.log(`Fresh execution ${index} opened PR #${observed.pr.number} on ${observed.branch}`);
  return {
    ok: true,
    name: `fresh-execution-${index}`,
    issueId: issue.id,
    issueKey: observed.issue.identifier,
    runId: observed.runId,
    branch: observed.branch,
    pr: prSummary(observed.pr),
    issueState: observed.issue.state?.name || null,
    workerProof: workerProofSummary(observed.workerProof),
    sourceRefs: sourceRefsForObserved(observed),
  };
}

async function runBlockedDependentScenario(context) {
  const blocker = await createDisposableIssue(context, {
    slug: "dependency-blocker",
    stateId: context.issueStatuses.backlog.id,
    summary: "Execution UAT blocker issue. The harness moves this to completed to simulate merge-to-Done automation.",
  });
  const dependent = await createDisposableReadyIssue(context, {
    slug: "dependency-dependent",
    summary: "Execution UAT dependent issue. It must not be suppression-stranded while its blocker is incomplete.",
  });
  await context.client.findOrCreateIssueRelation({
    type: "blocks",
    issueId: blocker.id,
    relatedIssueId: dependent.id,
  });

  const blockedPass = await runSingleGatewayPass(context, { label: "dependency-blocked" });
  const blockedResult = findProcessedIssueResult(blockedPass.result, dependent.id);
  assertCondition(blockedResult?.reason === "dependency_blocked", "dependent issue was not reported dependency_blocked");

  const blockedContext = await context.client.getIssueContext(dependent.id);
  const blockedFingerprint = computeIssueTriggerFingerprint(blockedContext);
  const suppression = readSuppression({
    objectType: "issue",
    objectId: dependent.id,
    fingerprint: blockedFingerprint,
    repoRoot: context.repoRoot,
  });
  assertCondition(!suppression, "dependency-blocked issue wrote a suppression record");

  await context.client.updateIssue(blocker.id, { stateId: context.completedStatus.id });
  const unblockedPass = await runSingleGatewayPass(context, { label: "dependency-unblocked" });
  assertCondition(
    unblockedPass.events.some((event) => event.issueId === dependent.id && event.state === "working"),
    "dependent issue did not run after blocker reached completed",
  );
  const observed = await waitForIssueExecutionResult(context, dependent.id, {
    expectedOpenPrCount: 1,
    requireWorkerProof: true,
  });
  context.log(`Blocked dependent ran after blocker Done and opened PR #${observed.pr.number}`);
  return {
    ok: true,
    name: "blocked-dependent-after-done",
    blockerIssueId: blocker.id,
    dependentIssueId: dependent.id,
    runId: observed.runId,
    branch: observed.branch,
    pr: prSummary(observed.pr),
    firstCycleReason: blockedResult.reason,
    blockerState: context.completedStatus.name || context.completedStatus.type,
    sourceRefs: sourceRefsForObserved(observed),
  };
}

async function runOpenPrReplayScenario(context) {
  const issue = await createDisposableReadyIssue(context, {
    slug: "open-pr-replay",
    summary: "Execution UAT replay issue. After the first PR opens, the harness moves this issue back to Ready.",
  });
  await runSingleGatewayPass(context, { label: "open-pr-initial" });
  const initial = await waitForIssueExecutionResult(context, issue.id, {
    expectedOpenPrCount: 1,
    requireWorkerProof: true,
  });

  await context.client.updateIssue(issue.id, { stateId: context.issueStatuses.ready.id });
  const replayPass = await runSingleGatewayPass(context, { label: "open-pr-replay" });
  assertCondition(
    replayPass.events.some((event) => event.issueId === issue.id && event.state === "replaying"),
    "Ready issue with an open PR did not replay",
  );
  const replayed = await waitForIssueExecutionResult(context, issue.id, {
    expectedRunId: initial.runId,
    expectedOpenPrCount: 1,
    requireWorkerProof: false,
  });
  assertCondition(replayed.openPrs.length === 1, "open-PR replay produced more than one open PR");
  assertCondition(replayed.pr.number === initial.pr.number, "open-PR replay changed PR identity");
  context.log(`Open PR replay kept exactly one PR #${replayed.pr.number}`);
  return {
    ok: true,
    name: "open-pr-replay-no-duplicate",
    issueId: issue.id,
    runId: initial.runId,
    branch: initial.branch,
    pr: prSummary(replayed.pr),
    openPrCount: replayed.openPrs.length,
    sourceRefs: sourceRefsForObserved(replayed),
  };
}

async function runCrashReplayScenario(context) {
  const issue = await createDisposableReadyIssue(context, {
    slug: "crash-replay",
    summary: "Execution UAT crash fixture. The child process is killed after push and before PR open.",
  });

  const crash = await spawnCrashChild(context, {
    crashMode: "after_git_push_before_pr",
    issueId: issue.id,
  });
  const pendingBefore = readGitReplayPending({
    teamRef: context.team.id,
    objectId: issue.id,
    repoRoot: context.repoRoot,
  });
  assertCondition(pendingBefore, "crash did not leave a git replay marker");
  assertCondition(pendingBefore.runId === crash.event.runId, "crash replay marker run_id mismatch");
  assertCondition(!pendingBefore.git?.head_sha && !pendingBefore.git?.tree_sha, "crash marker unexpectedly had observed head/tree before replay");
  const branch = pendingBefore.git.branch;
  const remoteBranch = await getGitHubBranch(context, branch);
  assertCondition(remoteBranch?.object?.sha, "remote branch was absent after push-before-PR crash");
  const preReplayPrs = await listOpenPullRequests(context, { branch });
  assertCondition(preReplayPrs.length === 0, "crash opened a PR before the replay pass");

  assertCondition(crash.event.workingDir, "crash event did not report worker workingDir");
  fs.rmSync(crash.event.workingDir, { recursive: true, force: true });
  assertCondition(!fs.existsSync(crash.event.workingDir), "worker workingDir still existed before replay");

  const replayPass = await runSingleGatewayPass(context, { label: "crash-replay" });
  assertCondition(
    replayPass.events.some((event) => event.issueId === issue.id && event.state === "replaying"),
    "crash recovery did not emit a replaying status",
  );
  const observed = await waitForIssueExecutionResult(context, issue.id, {
    expectedRunId: pendingBefore.runId,
    expectedOpenPrCount: 1,
    requireWorkerProof: false,
  });
  assertCondition(observed.openPrs.length === 1, "crash replay did not converge to exactly one open PR");
  context.log(`Crash replay opened exactly one PR #${observed.pr.number} from absent worktree`);
  return {
    ok: true,
    name: "push-before-pr-crash-replays-once",
    issueId: issue.id,
    runId: pendingBefore.runId,
    branch,
    pr: prSummary(observed.pr),
    worktreeRemovedBeforeReplay: true,
    preReplayOpenPrCount: preReplayPrs.length,
    postReplayOpenPrCount: observed.openPrs.length,
    sourceRefs: sourceRefsForObserved(observed),
  };
}

async function runSingleGatewayPass(context, { label }) {
  const events = [];
  const inFlight = new Set();
  const result = await runGatewayOnce({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    teams: [context.team],
    pollIntervalMs: context.pollIntervalMs,
    runTimeoutMs: context.timeoutMs,
    inFlight,
    maxInFlight: 1,
    onStatus: (event) => events.push({ ...event, observedAtMs: Date.now() }),
    runDeps: executionRunDeps(context),
    runFreshIssue: deterministicRunFreshIssue(context),
  });
  assertCondition(result.ok, `gateway pass ${label} failed: ${result.reason || result.status}`);
  return { result, events, inFlight };
}

function deterministicRunFreshIssue(context, { crashMode = null, crashIssueId = null, notifyCrash = null } = {}) {
  return async function runDeterministicFreshIssue(input = {}) {
    const crashController = crashMode
      ? createCrashController({ crashMode, issueId: crashIssueId || input.issueId, notifyCrash })
      : null;
    return runFreshIssueSyntheticWake({
      ...input,
      createTraceSink: createNoopTraceSink,
      createStore: createLocalTriggerStore,
      createRuntimeExecutor: () => deterministicWorkerRuntimeExecutor(context),
      runDeps: {
        ...executionRunDeps(context),
        ...(crashController ? { killPoint: crashController.killPoint } : {}),
      },
      runTriggeredExecutionFn: async (runnerInput) => runTriggeredExecution({
        ...runnerInput,
        ...deterministicExecutionOrchestrator(context),
      }),
    });
  };
}

function deterministicExecutionOrchestrator(context) {
  const roster = fakeExecutionRoster();
  let turn = 0;
  return {
    roster,
    orchestratorTurnExecutor: async (input = {}) => {
      turn += 1;
      if (turn === 1) {
        return {
          controlAction: {
            action: "invoke_library",
            target_key: "prompt/execution/code_worker",
          },
          evidence: null,
          sessionHandle: null,
        };
      }
      const proof = context.workerProofs.get(input.runId);
      const issue = input.project || {};
      return {
        controlAction: {
          action: "terminate",
          outcome: "commit",
          reason: "synthesis_complete",
        },
        producedContent: {
          pr_title: `Execution UAT ${issue.identifier || issue.id || input.runId}`,
          pr_body: buildExecutionUatPrBody({
            runId: input.runId,
            issue,
            proof,
          }),
          linear_issue_id: issue.id,
          project_update_markdown: [
            `run_id: ${input.runId}`,
            "",
            "Execution UAT deterministic worker changed the contained checkout and proved write credentials were absent.",
          ].join("\n"),
          context_digest: "Execution UAT deterministic worker completed a contained repository change.",
          source_refs: [{ kind: "linear_issue", id: issue.id || "unknown", url: issue.url || null }],
          assumptions: [],
          constraints: [
            "execution_uat_deterministic_worker",
            "worker_env_write_credentials_absent",
            "worker_git_push_incapable",
          ],
          risks: ["This is a disposable live UAT PR."],
        },
        evidence: null,
        sessionHandle: null,
      };
    },
  };
}

function deterministicWorkerRuntimeExecutor(context) {
  return {
    async executeSubagent(input = {}) {
      const proof = await writeWorkerChangeAndContainmentProof(input);
      context.workerProofs.set(input.runId, proof);
      const packet = {
        schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
        run_id: input.runId,
        status: "continue",
        reason: "synthesis_complete",
        context_digest: "Execution UAT worker wrote a scoped file in the contained clone.",
        source_refs: [{ kind: "linear_issue", id: input.project?.id || "unknown", url: input.project?.url || null }],
        assumptions: [],
        constraints: ["worker_env_write_credentials_absent", "worker_git_push_incapable"],
        risks: ["Disposable UAT proof file only."],
      };
      const output = JSON.stringify(packet);
      return {
        ok: true,
        packet,
        output,
        role: input.runtime_role,
        runtime: "execution-uat",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: output,
        envelope: "execution uat deterministic worker",
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${input.runtime_role}.turn.tool_events`, reason: "execution_uat_deterministic_runtime" },
          ],
        },
      };
    },
  };
}

async function writeWorkerChangeAndContainmentProof(input = {}) {
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error("execution_uat_worker_cwd_missing");
  }
  const workerEnv = { ...scrubChildEnv(process.env), ...(input.envAugment || {}) };
  const environment = runtimeCommandEnvironmentProof(workerEnv);
  const authEnvNamesPresent = Object.keys(workerEnv)
    .filter((name) => isCredentialEnvNameForWorkerProof(name))
    .sort();
  if (environment.agent_write_credentials_present || authEnvNamesPresent.length > 0) {
    throw new Error(`execution_uat_worker_credentials_present:${authEnvNamesPresent.join(",") || "agent_write_credential"}`);
  }

  const remotes = await runGit(["remote"], {
    cwd,
    env: workerEnv,
    exactEnv: true,
    operation: "git_read",
  });
  if (!remotes.ok) throw new Error(`execution_uat_worker_git_remote_failed:${safeCommandDetail(remotes)}`);
  const remoteNames = remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (remoteNames.length !== 0) {
    throw new Error(`execution_uat_worker_remote_present:${remoteNames.join(",")}`);
  }
  const push = await runGit(["push", "--dry-run", "origin", "HEAD"], {
    cwd,
    env: workerEnv,
    exactEnv: true,
  });
  if (push.ok) throw new Error("execution_uat_worker_push_unexpectedly_succeeded");
  if (push.reconciliationRequired) {
    throw new Error("execution_uat_worker_push_result_ambiguous");
  }

  const relativeFile = path.join("execution", "integrations", "linear", "uat", "live-execution-runs", `${safePathSegment(input.runId)}.md`);
  const absoluteFile = path.join(cwd, relativeFile);
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.writeFileSync(absoluteFile, [
    "# Execution UAT Worker Proof",
    "",
    `Run: ${input.runId}`,
    `Issue: ${input.project?.identifier || input.project?.id || "unknown"}`,
    "",
    "The deterministic UAT worker wrote this file inside the contained clone.",
    "",
    `agent_write_credentials_present: ${environment.agent_write_credentials_present}`,
    `auth_env_names_present: ${authEnvNamesPresent.join(",") || "none"}`,
    `worker_remote_count: ${remoteNames.length}`,
    `worker_push_dry_run_exit: ${push.status}`,
    "",
  ].join("\n"), "utf8");

  return {
    runId: input.runId,
    issueId: input.project?.id || null,
    cwd,
    relativeFile: relativeFile.split(path.sep).join("/"),
    environment,
    authEnvNamesPresent,
    workerRemoteCount: remoteNames.length,
    workerPushDryRunSucceeded: push.ok,
    workerPushDryRunStatus: push.status,
    workerPushDryRunError: redactGitHubSecrets((push.stderr || push.stdout || "").trim()).slice(0, 300),
    provenCredsAbsent: environment.agent_write_credentials_present === false && authEnvNamesPresent.length === 0,
    provenPushIncapable: push.ok === false,
  };
}

function fakeExecutionRoster() {
  return {
    selectableTargets: ["prompt/execution/code_worker"],
    resolve(targetKey) {
      if (targetKey !== "prompt/execution/code_worker") {
        return { ok: false, reason: "execution_uat_target_not_selectable" };
      }
      return {
        ok: true,
        runtime_role: "worker",
        loadSnapshot: () => ({
          entry: {
            target_key: targetKey,
            human_name: "Execution UAT Code Worker",
          },
          contentBytes: "Execution UAT deterministic worker prompt.",
          snapshotSha256: "execution-uat-code-worker",
        }),
      };
    },
  };
}

function executionRunDeps(context) {
  return {
    createPrAdapter: ({ repoIdentity }) => createDefaultExecutionPullRequestAdapter({
      repoIdentity,
      token: () => context.githubToken,
    }),
  };
}

async function createDisposableReadyIssue(context, input = {}) {
  return createDisposableIssue(context, {
    ...input,
    stateId: context.issueStatuses.ready.id,
  });
}

async function createDisposableIssue(context, { slug, stateId, summary }) {
  const stamp = uatStamp();
  const title = `${context.prefix} ${stamp} ${slug}`;
  const issue = await context.client.createIssue({
    title,
    description: [
      "## Execution UAT Fixture",
      "",
      summary,
      "",
      "This issue was created by the live execution UAT harness and is disposable.",
    ].join("\n"),
    teamId: context.team.linear.team_id,
    stateId,
  });
  context.createdIssues.push(issue.id);
  return context.client.getIssueContext(issue.id);
}

async function waitForIssueExecutionResult(context, issueId, {
  expectedRunId = null,
  expectedOpenPrCount = 1,
  requireWorkerProof = false,
} = {}) {
  return waitForValue(async () => {
    const run = expectedRunId
      ? executionRunsForIssue(context, issueId).find((candidate) => candidate.run_id === expectedRunId)
      : latestExecutionRunForIssue(context, issueId);
    if (!run?.run_id) return null;
    const issue = await context.client.getIssueContext(issueId);
    const branch = branchNameForIssue(issue.identifier);
    const openPrs = await listOpenPullRequests(context, { branch });
    const workerProof = context.workerProofs.get(run.run_id) || null;
    if (openPrs.length !== expectedOpenPrCount) return null;
    if (!issueMatchesInReviewTarget(issue, context.inReviewTarget)) return null;
    if (requireWorkerProof && !workerProof) return null;
    const pr = openPrs[0] || null;
    if (pr) rememberPrArtifact(context, { pr, branch });
    rememberBranch(context, branch);
    return {
      runId: run.run_id,
      run,
      branch,
      openPrs,
      pr,
      issue,
      workerProof,
    };
  }, {
    timeoutMs: context.timeoutMs,
    intervalMs: 1_000,
    label: `execution result for issue ${issueId}`,
  });
}

function latestExecutionRunForIssue(context, issueId) {
  const runs = executionRunsForIssue(context, issueId);
  return runs[runs.length - 1] || null;
}

function executionRunsForIssue(context, issueId) {
  const state = readLocalTriggerState(localTriggerStorePath());
  return state.runs
    .filter((run) => run.object_id === issueId && run.workflow_type === "execution")
    .sort((a, b) => String(a.started_at || "").localeCompare(String(b.started_at || "")));
}

async function spawnCrashChild(context, { crashMode, issueId }) {
  const args = [
    HARNESS_PATH,
    "--child-crash",
    crashMode,
    "--issue-id",
    issueId,
    "--team",
    context.team.id,
    "--repo-root",
    context.repoRoot,
    "--timeout-ms",
    String(context.timeoutMs),
  ];
  if (context.expectedRepoName) args.push("--expected-repo-name", context.expectedRepoName);
  if (context.resourceId) args.push("--resource-id", context.resourceId);
  if (context.pollIntervalMs) args.push("--poll-interval-ms", String(context.pollIntervalMs));

  const child = spawn(process.execPath, args, {
    cwd: context.repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const event = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      reject(new Error(`execution crash child timed out waiting for ${crashMode}. stdout=${stdout} stderr=${stderr}`));
    }, DEFAULT_CHILD_CRASH_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const parsed = drainJsonLines(stdout);
      stdout = parsed.remainder;
      for (const item of parsed.items) {
        if (item.type !== CHILD_EVENT_TYPE) continue;
        if (item.event === "crash_point_reached") {
          settled = true;
          clearTimeout(timer);
          resolve(item);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += redactGitHubSecrets(chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`execution crash child exited before crash point code=${code} signal=${signal || "none"} stdout=${stdout} stderr=${stderr}`));
    });
  });

  killChild(child);
  await waitForChildClose(child, { timeoutMs: 5_000 });
  return { event, stdout, stderr };
}

async function runChildCrashExecution(options) {
  const context = await prepareLiveExecutionUatContext({
    ...options,
    onLog: () => {},
  });
  const spec = CRASH_SCENARIOS[options.childCrash];
  let crashEvent = null;
  const runFreshIssue = deterministicRunFreshIssue(context, {
    crashMode: options.childCrash,
    crashIssueId: options.childIssueId,
    notifyCrash: (payload) => {
      crashEvent = payload;
      emitChildEvent({
        event: "crash_point_reached",
        crashMode: options.childCrash,
        ...payload,
      });
    },
  });
  await runGatewayOnce({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    teams: [context.team],
    pollIntervalMs: context.pollIntervalMs,
    runTimeoutMs: context.timeoutMs,
    inFlight: new Set(),
    maxInFlight: 1,
    onStatus: (event) => emitChildEvent({ event: "status", status: event }),
    runDeps: executionRunDeps(context),
    runFreshIssue,
  });
  await waitForValue(
    () => crashEvent,
    { timeoutMs: DEFAULT_CHILD_CRASH_TIMEOUT_MS, intervalMs: 250, label: spec.description },
  );
  return new Promise(() => {});
}

function createCrashController({ crashMode, issueId, notifyCrash }) {
  let crashed = false;
  let keepAlive = null;
  return {
    async killPoint(point, ctx = {}) {
      const spec = CRASH_SCENARIOS[crashMode];
      if (!spec || point !== spec.killPoint) return;
      if (ctx.issueId !== issueId) return;
      if (crashed) return new Promise(() => {});
      crashed = true;
      keepAlive = setInterval(() => {}, 60_000);
      notifyCrash?.({
        issueId,
        runId: ctx.runId || ctx.artifact?.run_id || null,
        branch: ctx.pendingGitIntent?.git?.branch || branchNameForIssue(ctx.issue?.identifier),
        workingDir: ctx.runContext?.selectedResource?.handle?.workingDir || null,
        artifactPath: ctx.durable_record?.artifact_path || null,
        crashPoint: point,
      });
      void keepAlive;
      return new Promise(() => {});
    },
  };
}

async function cleanupExecutionUatArtifacts(context) {
  if (context.keepArtifacts) {
    return {
      skipped: true,
      reason: "keep_artifacts",
      issues: [...context.createdIssues],
      pullRequests: context.createdPullRequests.map((entry) => entry.number),
      branches: [...context.createdBranches],
    };
  }

  const results = [];
  for (const pr of uniqueBy(context.createdPullRequests, (entry) => String(entry.number))) {
    try {
      await githubApi(context, `/repos/${encodePathSegment(context.repoIdentity.owner)}/${encodePathSegment(context.repoIdentity.repo)}/pulls/${encodePathSegment(pr.number)}`, {
        method: "PATCH",
        body: { state: "closed" },
      });
      results.push({ kind: "pull_request", number: pr.number, ok: true, action: "closed" });
    } catch (error) {
      results.push({ kind: "pull_request", number: pr.number, ok: false, error: redactGitHubSecrets(error.message) });
    }
  }

  for (const branch of [...new Set(context.createdBranches)]) {
    try {
      await githubApi(context, `/repos/${encodePathSegment(context.repoIdentity.owner)}/${encodePathSegment(context.repoIdentity.repo)}/git/refs/heads/${encodeBranchPath(branch)}`, {
        method: "DELETE",
        allowNotFound: true,
      });
      results.push({ kind: "branch", branch, ok: true, action: "deleted" });
    } catch (error) {
      results.push({ kind: "branch", branch, ok: false, error: redactGitHubSecrets(error.message) });
    }
  }

  for (const issueId of [...new Set(context.createdIssues)]) {
    for (const run of executionRunsForIssue(context, issueId)) {
      try {
        const cleared = clearMutationIntent({
          teamRef: context.team.id,
          objectType: "issue",
          objectId: issueId,
          runId: run.run_id,
          repoRoot: context.repoRoot,
        });
        results.push({ kind: "mutation_intent", issueId, runId: run.run_id, ok: true, action: cleared.cleared ? "cleared" : "already_clear" });
      } catch (error) {
        results.push({ kind: "mutation_intent", issueId, runId: run.run_id, ok: false, error: error.message });
      }
    }
    try {
      await context.client.updateIssue(issueId, { stateId: context.issueStatuses.backlog.id });
      results.push({ kind: "linear_issue", issueId, ok: true, action: "moved_to_backlog" });
    } catch (error) {
      results.push({ kind: "linear_issue", issueId, ok: false, error: error.message });
    }
  }

  return {
    skipped: false,
    ok: results.every((result) => result.ok),
    results,
  };
}

async function listOpenPullRequests(context, { branch }) {
  const query = new URLSearchParams({
    state: "open",
    head: `${context.repoIdentity.owner}:${branch}`,
    base: context.repoIdentity.default_branch,
    per_page: "100",
  });
  return githubApi(context, `/repos/${encodePathSegment(context.repoIdentity.owner)}/${encodePathSegment(context.repoIdentity.repo)}/pulls?${query.toString()}`);
}

async function getGitHubBranch(context, branch) {
  return githubApi(context, `/repos/${encodePathSegment(context.repoIdentity.owner)}/${encodePathSegment(context.repoIdentity.repo)}/git/ref/heads/${encodeBranchPath(branch)}`, {
    allowNotFound: true,
  });
}

async function githubApi(context, apiPath, { method = "GET", body = null, allowNotFound = false } = {}) {
  const url = `https://api.github.com${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.githubToken}`,
      "User-Agent": "teami-execution-uat",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (allowNotFound && response.status === 404) return null;
  let payload = null;
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`github_api_malformed_json:${method}:${apiPath}`);
    }
  }
  if (!response.ok) {
    throw new Error(redactGitHubSecrets(`github_api_failed:${method}:${apiPath}:status_${response.status}:${payload?.message || text}`));
  }
  return payload;
}

function selectUatTeam({ registry, teamRef = null } = {}) {
  const teams = Array.isArray(registry?.teams) ? registry.teams : [];
  const active = teams.filter((team) => team.status === "active");
  if (active.length === 0) {
    throw new ExecutionUatUserError("no active Linear team configured; run init against a disposable test team", "no_linear_team");
  }
  if (teamRef) {
    const selected = active.find((team) => team.id === teamRef);
    if (!selected) throw new ExecutionUatUserError(`team not active or not found for execution UAT: ${teamRef}`, "team");
    return selected;
  }
  if (active.length > 1) {
    throw new ExecutionUatUserError(
      `multiple Linear teams configured (${active.map((team) => team.id).join(", ")}) - pass --team <team_ref>`,
      "team",
    );
  }
  return active[0];
}

async function readLinearTokenSet(credentialStore) {
  try {
    return await credentialStore.readTokenSet();
  } catch {
    return null;
  }
}

async function resolveCompletedIssueStatus(client, teamId) {
  const states = await client.listWorkflowStates(teamId);
  const completed = (states || []).filter((state) => state.type === "completed");
  if (completed.length === 0) {
    throw new ExecutionUatUserError("Execution UAT requires at least one completed Linear workflow state.", "completed_status_missing");
  }
  return completed.find((state) => /^done$/i.test(state.name || "")) || completed[0];
}

async function assertUatRepoBinding({ repoRoot, repoIdentity, expectedRepoName }) {
  const expectedName = String(expectedRepoName || "").trim();
  if (expectedName && repoIdentity.repo !== expectedName) {
    throw new ExecutionUatUserError(
      `Execution UAT expected repo name ${expectedName}; selected git_repo binding is ${repoIdentity.owner}/${repoIdentity.repo}.`,
      "wrong_repo",
    );
  }
  if (!repoIdentity.default_branch) {
    throw new ExecutionUatUserError("Execution UAT requires git_repo.default_branch.", "git_repo_binding");
  }

  const remote = await runGit(["remote", "get-url", "origin"], {
    cwd: repoRoot,
    operation: "git_read",
  });
  if (!remote.ok || !remote.stdout.trim()) {
    throw new ExecutionUatUserError("Execution UAT requires an origin remote in the bound checkout.", "origin_missing");
  }
  const parsed = parseGitHubRemoteUrl(remote.stdout.trim());
  if (!parsed || parsed.owner !== repoIdentity.owner || parsed.repo !== repoIdentity.repo) {
    throw new ExecutionUatUserError(
      `origin remote drift: expected ${repoIdentity.owner}/${repoIdentity.repo}, got ${parsed?.owner || "unknown"}/${parsed?.repo || "unknown"}.`,
      "origin_remote_drift",
    );
  }
}

async function assertGhAuthStatus({ repoRoot }) {
  const result = await runBoundedSubprocess({
    command: "gh",
    args: ["auth", "status", "--hostname", "github.com"],
    operation: "gh_auth_read",
    cwd: repoRoot,
  });
  if (!result.ok) {
    throw new ExecutionUatUserError(
      result.timedOut
        ? "GitHub CLI login verification timed out. Retry after confirming gh auth status in another terminal."
        : "GitHub CLI is not logged in for github.com. Run gh auth login and retry.",
      "github_auth_status_failed",
    );
  }
}

async function resolveGhToken({ repoRoot }) {
  const result = await runBoundedSubprocess({
    command: "gh",
    args: ["auth", "token"],
    operation: "gh_auth_read",
    cwd: repoRoot,
  });
  const token = result.stdout?.trim();
  if (!result.ok || !token) {
    throw new ExecutionUatUserError(
      result.timedOut
        ? "GitHub CLI token lookup timed out. Retry after confirming gh auth status in another terminal."
        : "GitHub CLI token is unavailable. Run gh auth login and retry.",
      "github_auth_token_failed",
    );
  }
  return token;
}

function assertWorkerContainmentProofs(proofs) {
  if (!Array.isArray(proofs) || proofs.length === 0) {
    throw new Error("execution_uat_worker_proof_missing");
  }
  for (const proof of proofs) {
    assertCondition(proof.provenCredsAbsent === true, `worker credentials were present for ${proof.runId}`);
    assertCondition(proof.provenPushIncapable === true, `worker git push was capable for ${proof.runId}`);
  }
}

function buildExecutionUatPrBody({ runId, issue, proof }) {
  return [
    "## Execution UAT",
    "",
    `Source run: ${runId}`,
    `Linear issue: ${issue.identifier || issue.id}`,
    "",
    "## Change",
    "",
    "The deterministic execution UAT worker wrote a scoped proof file in the contained clone.",
    "",
    "## Validation",
    "",
    "- Worker write credentials absent: pass",
    "- Worker git push from contained clone: failed as expected",
    `- Worker proof file: ${proof?.relativeFile || "recorded after worker turn"}`,
    "",
    "## Residual Risk",
    "",
    "Disposable live UAT artifact. Close this PR after verification unless --keep-artifacts was used intentionally.",
  ].join("\n");
}

function findProcessedIssueResult(gatewayResult, issueId) {
  const teams = gatewayResult?.poll?.teams || [];
  for (const team of teams) {
    for (const result of team.processed || []) {
      if (result?.issueId === issueId) return result;
    }
  }
  return null;
}

function rememberPrArtifact(context, { pr, branch }) {
  if (!pr?.number) return;
  const entry = {
    number: pr.number,
    url: pr.html_url || pr.url || null,
    branch,
  };
  if (!context.createdPullRequests.some((candidate) => candidate.number === entry.number)) {
    context.createdPullRequests.push(entry);
  }
}

function rememberBranch(context, branch) {
  if (branch && !context.createdBranches.includes(branch)) context.createdBranches.push(branch);
}

function prSummary(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.html_url || pr.url || null,
    state: pr.state || null,
    head: pr.head?.ref || null,
    base: pr.base?.ref || null,
  };
}

function workerProofSummary(proof) {
  if (!proof) return null;
  return {
    runId: proof.runId,
    relativeFile: proof.relativeFile,
    provenCredsAbsent: proof.provenCredsAbsent,
    provenPushIncapable: proof.provenPushIncapable,
    workerRemoteCount: proof.workerRemoteCount,
    workerPushDryRunStatus: proof.workerPushDryRunStatus,
  };
}

function sourceRefsForObserved(observed) {
  return [
    { kind: "linear_issue", id: observed.issue.id, url: observed.issue.url || null },
    { kind: "github_pull_request", id: String(observed.pr?.number || ""), url: observed.pr?.html_url || observed.pr?.url || null },
  ].filter((ref) => ref.id);
}

function createNoopTraceSink() {
  return {
    async startRun() {
      return { ok: true, traceId: null, status: "noop" };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun() {
      return { status: "noop" };
    },
    async shutdown() {},
  };
}

async function waitForValue(fn, { timeoutMs, intervalMs = 250, label }) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runGit(args, { cwd, env, exactEnv = false, operation = null } = {}) {
  return runBoundedGit(args, {
    cwd,
    env: env ? normalizeEnv(env) : undefined,
    exactEnv,
    ...(operation ? { operation } : {}),
  });
}

function isCredentialEnvNameForWorkerProof(name) {
  const normalized = String(name || "").toUpperCase();
  if (GITHUB_AUTH_ENV_NAMES.includes(normalized)) return true;
  if (normalized.startsWith("AF_LINEAR_")) return true;
  if (normalized.startsWith("LINEAR_")) {
    return /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/.test(normalized);
  }
  return false;
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function safeCommandDetail(result) {
  return redactGitHubSecrets((result?.stderr || result?.stdout || "").trim()).slice(0, 300);
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 2_000).unref?.();
}

function waitForChildClose(child, { timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function drainJsonLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || "";
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON child output.
    }
  }
  return { items, remainder };
}

function emitChildEvent(payload) {
  process.stdout.write(`${JSON.stringify({ type: CHILD_EVENT_TYPE, ...payload })}\n`);
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function encodeBranchPath(branch) {
  return String(branch || "").split("/").map(encodePathSegment).join("/");
}

function safePathSegment(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uatStamp() {
  return new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15);
}

function parsePositiveInteger(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ExecutionUatUserError(`expected a positive integer, got ${value}`, "usage");
  }
  return parsed;
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new ExecutionUatUserError(`${flag} requires a value`, "usage");
  return value;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  exit = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let options;
  try {
    options = parseExecutionUatArgs(argv, { ...process.env, onLog: stdout });
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildExecutionUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    if (options.childCrash) {
      await runChildCrashExecution(options);
      exit(1);
      return { ok: false, stage: "child_completed_without_crash" };
    }

    const report = await runExecutionUat({ ...options, onLog: stdout });
    for (const scenario of report.scenarios) {
      stdout(`PASS ${scenario.name}`);
    }
    stdout(`Execution UAT created ${report.createdIssues.length} disposable Linear issue(s).`);
    if (report.cleanup?.skipped) {
      stdout(`Cleanup skipped: ${report.cleanup.reason}.`);
    } else if (report.cleanup?.ok === false) {
      stderr(`Cleanup had failures: ${JSON.stringify(report.cleanup.results)}`);
      exit(1);
      return { ok: false, stage: "cleanup", report };
    }
    stdout("EXECUTION UAT PASS");
    exit(0);
    return { ok: true, report };
  } catch (error) {
    const message = error instanceof ExecutionUatUserError
      ? error.message
      : `EXECUTION UAT FAIL: ${error?.message || String(error)}`;
    stderr(redactGitHubSecrets(message));
    if (!(error instanceof ExecutionUatUserError)) {
      stderr(`Run store: ${defaultRunStoreDir(options.repoRoot)}`);
    }
    exit(error instanceof ExecutionUatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "run", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(redactGitHubSecrets(`EXECUTION UAT FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
