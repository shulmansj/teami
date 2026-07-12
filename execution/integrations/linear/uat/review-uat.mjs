import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "../../../engine/orchestrator-turn-contract.mjs";
import { defaultRunStoreDir, writeRunArtifact } from "../../../engine/run-store.mjs";
import { branchNameForIssue } from "../../git/git-branch-names.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import { runBoundedGit, runBoundedSubprocess } from "../../git/bounded-subprocess.mjs";
import { readLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readDomainRegistry } from "../src/domain-registry.mjs";
import { buildDomainContext } from "../src/domain-resolver.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  createDefaultExecutionPullRequestAdapter,
  parseAfReviewCommentMarker,
} from "../src/execution-pr-adapter.mjs";
import {
  computeIssueTriggerFingerprint,
  decideReadyIssue,
  listInReviewIssueCandidates,
  runFreshReviewSyntheticWake,
  runWarmResumeIssueSyntheticWake,
} from "../src/gateway-loop.mjs";
import {
  assertNoGitHubCredentialLeaks,
  scanGitHubCredentialLeaks,
} from "./github-local-uat.mjs";
import { redactGitHubSecrets } from "../src/github-secret-hygiene.mjs";
import { parseGitHubRemoteUrl } from "../src/github-setup.mjs";
import {
  createLinearCredentialStore,
} from "../src/linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../src/linear-setup-auth.mjs";
import {
  issueMatchesInReviewTarget,
} from "../src/linear/issue-in-review-effect.mjs";
import {
  resolveInReviewIssueStatus,
  resolveIssueStatuses,
  resolveNeedsPrincipalIssueStatus,
} from "../src/linear/shape-resolver.mjs";
import {
  createLocalTriggerStore,
  localTriggerStorePath,
  readLocalTriggerState,
  resolveDriverSessionHandle,
  runIsResumable,
} from "../src/local-trigger-store.mjs";
import {
  hydrateReviewState,
  locatePullRequestForIssue,
  resourcesToRepoIdentity,
} from "../src/review-pr-discovery.mjs";
import {
  runTriggeredExecution,
  runTriggeredReview,
} from "../src/trigger-runner.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
} from "../src/workflows/review/effect-ids.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const HARNESS_PATH = path.join(MODULE_DIR, "review-uat.mjs");

export const DEFAULT_REVIEW_UAT_PREFIX = "AF-EXEC-UAT";
export const DEFAULT_REVIEW_UAT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_REVIEW_UAT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_REVIEW_UAT_REQUIRED_PRS = 2;
export const DEFAULT_CHILD_CRASH_TIMEOUT_MS = 5 * 60 * 1000;
export const CHILD_EVENT_TYPE = "teami_review_uat";

export const REVIEW_CRASH_SCENARIOS = Object.freeze({
  after_review_comment_before_status: Object.freeze({
    killPoint: "after_review_comment_before_status",
    description: "kill between af-review comment and commit status",
  }),
});

class ReviewUatUserError extends Error {
  constructor(message, code = "uat_user_error") {
    super(message);
    this.name = "ReviewUatUserError";
    this.code = code;
  }
}

export function parseReviewUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(
      env.TEAMI_REVIEW_UAT_REPO_ROOT ||
      env.TEAMI_UAT_REPO_ROOT ||
      REPO_ROOT,
    ),
    domainId: env.TEAMI_REVIEW_UAT_DOMAIN || env.TEAMI_UAT_DOMAIN || null,
    prefix: env.TEAMI_REVIEW_UAT_PREFIX || DEFAULT_REVIEW_UAT_PREFIX,
    issueIds: parseCsv(env.TEAMI_REVIEW_UAT_ISSUE_IDS),
    requiredPrs: parsePositiveInteger(
      env.TEAMI_REVIEW_UAT_REQUIRED_PRS,
      DEFAULT_REVIEW_UAT_REQUIRED_PRS,
    ),
    pollIntervalMs: parsePositiveInteger(
      env.TEAMI_REVIEW_UAT_POLL_INTERVAL_MS,
      DEFAULT_REVIEW_UAT_POLL_INTERVAL_MS,
    ),
    timeoutMs: parsePositiveInteger(
      env.TEAMI_REVIEW_UAT_TIMEOUT_MS,
      DEFAULT_REVIEW_UAT_TIMEOUT_MS,
    ),
    keepArtifacts: truthy(env.TEAMI_REVIEW_UAT_KEEP_ARTIFACTS || env.TEAMI_UAT_KEEP_ARTIFACTS),
    expectedRepoName: env.TEAMI_REVIEW_UAT_REPO_NAME || undefined,
    resourceId: null,
    childCrash: null,
    childDisposition: "request-changes",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--domain") {
      options.domainId = requireNext(argv, ++index, arg);
    } else if (arg === "--resource-id") {
      options.resourceId = requireNext(argv, ++index, arg);
    } else if (arg === "--prefix") {
      options.prefix = requireNext(argv, ++index, arg);
    } else if (arg === "--issue-id") {
      options.issueIds.push(requireNext(argv, ++index, arg));
    } else if (arg === "--required-prs") {
      options.requiredPrs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_REVIEW_UAT_REQUIRED_PRS);
    } else if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_REVIEW_UAT_POLL_INTERVAL_MS);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_REVIEW_UAT_TIMEOUT_MS);
    } else if (arg === "--keep-artifacts") {
      options.keepArtifacts = true;
    } else if (arg === "--expected-repo-name") {
      options.expectedRepoName = requireNext(argv, ++index, arg);
    } else if (arg === "--child-crash") {
      options.childCrash = requireNext(argv, ++index, arg);
    } else if (arg === "--disposition") {
      options.childDisposition = requireNext(argv, ++index, arg);
    } else {
      throw new ReviewUatUserError(`unknown uat:review flag: ${arg}`, "usage");
    }
  }

  if (options.requiredPrs < 1) {
    throw new ReviewUatUserError("--required-prs must be at least 1", "usage");
  }
  if (options.childCrash && !REVIEW_CRASH_SCENARIOS[options.childCrash]) {
    throw new ReviewUatUserError(`unknown review crash scenario: ${options.childCrash}`, "usage");
  }
  if (options.childCrash && options.issueIds.length !== 1) {
    throw new ReviewUatUserError("--issue-id is required exactly once with --child-crash", "usage");
  }
  if (options.childCrash && !["request-changes", "approve", "escalate"].includes(options.childDisposition)) {
    throw new ReviewUatUserError("--disposition must be approve, request-changes, or escalate", "usage");
  }
  return options;
}

export function buildReviewUatUsage() {
  return [
    "Usage: npm run uat:review -- --repo-root <path-to-your-bound-checkout> [--domain <id>] [--resource-id <git_repo_resource_id>] [--issue-id <linear_issue_id> ...] [--keep-artifacts]",
    "",
    "Live prerequisites:",
    "- Run uat:execution first with kept artifacts so at least two clean AF-EXEC-UAT In Review issues have open execution PRs.",
    "- The repo root must be the checkout bound to your domain's git_repo resource; use --resource-id when the domain binds multiple git_repo resources.",
    "- The selected Linear domain must be active and have OAuth read/write credentials.",
    "- The domain must bind a git_repo resource whose owner/repo matches the repo root's origin.",
    "- GitHub auth must be available through `gh auth token`; the harness uses that ambient token for REST checks.",
    "",
    "Environment equivalents:",
    "- TEAMI_REVIEW_UAT_DOMAIN selects the disposable Linear domain/team.",
    "- TEAMI_REVIEW_UAT_PREFIX controls which execution-UAT Linear issues are selected.",
    "- TEAMI_REVIEW_UAT_ISSUE_IDS can pin one or more issue ids, comma-separated.",
    "- TEAMI_REVIEW_UAT_KEEP_ARTIFACTS=1 keeps PRs, branches, and Linear issue states.",
    "- TEAMI_REVIEW_UAT_REPO_NAME enables an optional explicit repo-name guard.",
    "",
    "The reviewer disposition is scripted by the harness. GitHub comments/statuses, Linear moves, and the warm-resume git/PR effects use live adapters.",
  ].join("\n");
}

export async function runReviewUat(options = parseReviewUatArgs()) {
  registerGitRepoResourceKind();
  const context = await prepareLiveReviewUatContext(options);
  const report = {
    ok: false,
    runId: `review-uat-${uatStamp()}-${randomBytes(3).toString("hex")}`,
    repoRoot: context.repoRoot,
    domainId: context.domain.id,
    prefix: context.prefix,
    scenarios: [],
    selectedIssues: context.reviewTargets.map((target) => reviewTargetSummary(target)),
    createdIssues: context.createdIssues,
    touchedIssues: context.touchedIssues,
    touchedPullRequests: context.touchedPullRequests,
    cleanup: null,
    evidencePath: null,
  };

  try {
    const mainTarget = context.reviewTargets[0];
    const diffTarget = context.reviewTargets[1] || context.reviewTargets[0];

    report.scenarios.push(await runRequestChangesCrashReplayScenario(context, mainTarget));
    report.scenarios.push(await runIdempotencyScenario(context, mainTarget));
    const warmResume = await runWarmResumeScenario(context, mainTarget);
    report.scenarios.push(warmResume);
    const refreshedMain = await refreshReviewTarget(context, mainTarget.issue.id);
    report.scenarios.push(await runApproveScenario(context, refreshedMain, warmResume));
    if (diffTarget.issue.id === refreshedMain.issue.id) {
      throw new ReviewUatUserError(
        "Review UAT needs a second clean execution PR for diff_incomplete so it does not conflict with the request-change/approve gate at the main PR head. Run uat:execution with --consecutive 2 --keep-artifacts.",
        "not_enough_clean_review_prs",
      );
    }
    report.scenarios.push(await runDiffIncompleteScenario(context, diffTarget));
    report.scenarios.push(await runNoPrEscalationScenario(context));

    assertNoGitHubCredentialLeaks(scanGitHubCredentialLeaks({
      scenarios: report.scenarios,
      logs: context.logs,
    }));

    report.ok = report.scenarios.every((scenario) => scenario.ok);
    report.evidencePath = writeRunArtifact({ repoRoot: context.repoRoot, runId: report.runId }, {
      kind: "commit",
      run_id: report.runId,
      domain_id: context.domain.id,
      workspace_id: context.domainContext.linear.workspaceId,
      team_id: context.domainContext.linear.teamId,
      function_version: "review-uat/v1",
      workflow_version: "review-uat/v1",
      runtime_assignments: { uat: { runtime: "node" } },
      runtime_metadata: { uat: { runtime_name: "review-uat" } },
      terminal_output: {
        run_id: report.runId,
        outcome: "commit",
        reason: "review_uat_passed",
        context_digest: "Review UAT drove live af-review comments/statuses, request-change warm resume, approval, escalation, diff-incomplete failure, and replay idempotency.",
        source_refs: report.scenarios.flatMap((scenario) => scenario.sourceRefs || []),
        assumptions: [],
        constraints: ["live_linear", "live_github", "ambient_gh_auth", "scripted_reviewer_disposition"],
        risks: ["Disposable live artifacts are cleaned up unless --keep-artifacts is set."],
      },
      evidence: {
        perspectives_run: [],
        tool_events: [],
        evidence_unavailable: [],
      },
      bounds: { rounds_used: report.scenarios.length, max_rounds: report.scenarios.length },
      payload_schema_id: "teami-review-uat/v1",
      payload: report,
      accepted_refs: [],
      completed_at: new Date().toISOString(),
      execution_mode: "live",
      started_at: context.startedAt,
    });
    context.log(`Wrote review UAT evidence ${report.evidencePath}`);
    return report;
  } finally {
    report.cleanup = await cleanupReviewUatArtifacts(context);
  }
}

async function prepareLiveReviewUatContext(options) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const startedAt = new Date().toISOString();
  const logs = [];
  const log = (line) => {
    const safe = redactGitHubSecrets(line);
    logs.push(safe);
    options.onLog?.(safe);
  };

  if (!fs.existsSync(repoRoot)) {
    throw new ReviewUatUserError(`repo root does not exist: ${repoRoot}`, "repo_root");
  }

  const config = loadLinearConfig({ repoRoot });
  const registry = readDomainRegistry({ repoRoot });
  const domain = selectUatDomain({ registry, domainId: options.domainId });
  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const credentialStore = createLinearCredentialStore({ config, repoRoot, domainContext });
  const tokenSet = await readLinearTokenSet(credentialStore);
  if (!tokenSet?.refreshToken && !tokenSet?.accessToken) {
    throw new ReviewUatUserError("no Linear OAuth credentials found for the selected domain", "no_linear_credential");
  }

  const client = createLinearSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  }).client;
  await client.verifyAuth();
  const cache = readLinearCache(domainContext.linear.cachePath);

  const issueStatuses = await resolveIssueStatuses(client, config, domain.linear.team_id);
  if (!issueStatuses.ready?.id) {
    throw new ReviewUatUserError("Review UAT requires a resolvable Ready issue status.", "ready_status_missing");
  }
  if (!issueStatuses.backlog?.id) {
    throw new ReviewUatUserError("Review UAT requires a resolvable Backlog issue status for cleanup.", "backlog_status_missing");
  }
  const inReviewTarget = await resolveInReviewIssueStatus(client, config, domain.linear.team_id);
  if (!inReviewTarget?.id) {
    throw new ReviewUatUserError("Review UAT requires a resolvable In Review issue status.", "in_review_status_missing");
  }
  const needsPrincipalTarget = await resolveNeedsPrincipalIssueStatus(client, config, domain.linear.team_id, cache);
  if (!needsPrincipalTarget?.id) {
    throw new ReviewUatUserError("Review UAT requires a resolvable Needs Principal issue status.", "needs_principal_missing");
  }

  const repoIdentity = resourcesToRepoIdentity(domainContext, { resourceId: options.resourceId });
  await assertUatRepoBinding({
    repoRoot,
    repoIdentity,
    expectedRepoName: options.expectedRepoName,
  });
  await assertGhAuthStatus({ repoRoot });
  const githubToken = await resolveGhToken({ repoRoot });
  const prAdapter = createPrAdapter({ repoIdentity, githubToken });
  const store = createLocalTriggerStore({ repoRoot });

  const context = {
    ...options,
    repoRoot,
    startedAt,
    config,
    registry,
    domain,
    domainContext,
    cache,
    client,
    issueStatuses,
    inReviewTarget,
    needsPrincipalTarget,
    repoIdentity,
    githubToken,
    prAdapter,
    store,
    logs,
    log,
    createdIssues: [],
    touchedIssues: [],
    touchedPullRequests: [],
    touchedBranches: [],
    warmResumeProofs: new Map(),
  };
  context.reviewTargets = await selectReviewTargets(context);
  log(`Review UAT using ${repoIdentity.owner}/${repoIdentity.repo}; selected ${context.reviewTargets.length} execution PR(s)`);
  return context;
}

async function selectReviewTargets(context) {
  const pinned = context.issueIds || [];
  const candidates = [];

  if (pinned.length > 0) {
    for (const issueId of pinned) {
      candidates.push({ id: issueId });
    }
  } else {
    const page = await listInReviewIssueCandidates({
      config: context.config,
      domain: context.domain,
      client: context.client,
    }, { first: 100 });
    candidates.push(...(page.candidates || []));
  }

  const targets = [];
  for (const candidate of candidates) {
    if (targets.length >= context.requiredPrs) break;
    const issue = await context.client.getIssueContext(candidate.id);
    if (!pinned.length && !String(issue?.title || "").startsWith(context.prefix)) continue;
    if (!issueMatchesInReviewTarget(issue, context.inReviewTarget)) continue;
    const location = await locatePullRequestForIssue({
      issueContext: issue,
      repoIdentity: context.repoIdentity,
      prAdapter: context.prAdapter,
    });
    if (location?.status !== "found") continue;
    const reviewState = await hydrateReviewState(location.pr, { prAdapter: context.prAdapter });
    if (reviewState.af_review_state || reviewState.latest_marker_comment_at_head) continue;
    const branch = location.branch || branchNameForIssue(issue.identifier);
    const target = {
      issue,
      pr: location.pr,
      branch,
      reviewState,
      location,
    };
    rememberTouchedIssue(context, issue.id);
    rememberTouchedPr(context, { pr: location.pr, branch });
    targets.push(target);
  }

  if (targets.length < context.requiredPrs) {
    throw new ReviewUatUserError(
      `Review UAT requires ${context.requiredPrs} clean In Review ${context.prefix} issue(s) with open execution PRs; found ${targets.length}. Run npm run uat:execution -- --repo-root ${context.repoRoot} --consecutive ${context.requiredPrs} --keep-artifacts first.`,
      "not_enough_clean_review_prs",
    );
  }
  return targets;
}

async function runRequestChangesCrashReplayScenario(context, target) {
  const headSha = target.pr.head_sha;
  const crash = await spawnCrashChild(context, {
    crashMode: "after_review_comment_before_status",
    issueId: target.issue.id,
  });
  assertCondition(crash.event.headSha === headSha, "crash child reviewed an unexpected head sha");

  const afterCrash = await waitForReviewGate(context, target, {
    headSha,
    disposition: "request-changes",
    expectedState: null,
    expectedCommentCount: 1,
    expectedStatusCount: 0,
    label: "request-changes crash partial gate",
  });

  const replay = await runReviewOnce(context, target, {
    disposition: "request-changes",
    body: "Request changes: add the UAT reviewer-note proof and preserve the same PR.",
    scenario: "request-changes-replay",
  });
  assertCondition(replay.status === "completed", "request-changes replay did not complete");
  const gate = await waitForReviewGate(context, target, {
    headSha,
    disposition: "request-changes",
    expectedState: "failure",
    expectedCommentCount: 1,
    expectedStatusCount: 1,
    label: "request-changes replay completed gate",
  });
  const issue = await waitForIssueTarget(context, target.issue.id, context.issueStatuses.ready, "Ready after request-changes");

  context.log(`Request-changes replay set failure at ${headSha} with one marked comment`);
  return {
    ok: true,
    name: "request-changes-crash-replay",
    issueId: target.issue.id,
    issueKey: issue.identifier,
    pr: prSummary(target.pr),
    head_sha: headSha,
    crash,
    afterCrash: reviewGateSummary(afterCrash),
    gate: reviewGateSummary(gate),
    reviewRunId: replay.result?.run?.run_id || replay.result?.artifact?.run_id || replay.result?.run_id || null,
    sourceRefs: sourceRefsForTarget(target),
  };
}

async function runIdempotencyScenario(context, target) {
  const before = await reviewGateSnapshot(context, target, {
    headSha: target.pr.head_sha,
    disposition: "request-changes",
  });
  const result = await runReviewOnce(context, target, {
    disposition: "request-changes",
    body: "Request changes: idempotency replay should reuse the existing af-review marker and status.",
    scenario: "request-changes-idempotent",
  });
  assertCondition(result.status === "completed", "idempotency review did not complete");
  const after = await waitForReviewGate(context, target, {
    headSha: target.pr.head_sha,
    disposition: "request-changes",
    expectedState: "failure",
    expectedCommentCount: before.commentCount,
    expectedStatusCount: before.statusCount,
    label: "request-changes idempotency",
  });
  context.log(`Idempotency replay kept one request-changes comment/status at ${target.pr.head_sha}`);
  return {
    ok: true,
    name: "idempotent-at-same-head",
    issueId: target.issue.id,
    pr: prSummary(target.pr),
    head_sha: target.pr.head_sha,
    before,
    after: reviewGateSummary(after),
    sourceRefs: sourceRefsForTarget(target),
  };
}

async function runWarmResumeScenario(context, target) {
  const issue = await context.client.getIssueContext(target.issue.id);
  const fingerprint = computeIssueTriggerFingerprint(issue);
  const priorRun = latestRunForIssueWorkflow(context, target.issue.id, "execution");
  assertCondition(priorRun?.run_id, "warm resume requires a prior execution run for the issue");
  const decision = await decideReadyIssue({
    domainId: context.domain.id,
    issueId: target.issue.id,
    issueContext: issue,
    domainContext: context.domainContext,
    config: context.config,
    fingerprint,
    repoRoot: context.repoRoot,
    store: context.store,
    prAdapter: context.prAdapter,
  });
  assertCondition(decision.action === "warm_resume", `Ready decision did not select warm_resume: ${decision.reason || decision.action}`);
  assertCondition(decision.prNumber === target.pr.number, "warm resume selected a different PR number");
  assertCondition(decision.head_sha === target.pr.head_sha, "warm resume selected a different review head");

  const resumeHarness = createDeterministicWarmResumeHarness(context, {
    issueId: target.issue.id,
    priorRun,
    priorHeadSha: target.pr.head_sha,
  });
  const result = await runWarmResumeIssueSyntheticWake({
    config: context.config,
    repoRoot: context.repoRoot,
    registry: context.registry,
    domain: context.domain,
    domainContext: context.domainContext,
    issueId: target.issue.id,
    priorRunId: decision.priorRunId,
    prNumber: decision.prNumber,
    head_sha: decision.head_sha,
    store: context.store,
    runDeps: {
      store: context.store,
      createPrAdapter: ({ repoIdentity }) => createPrAdapter({ repoIdentity, githubToken: context.githubToken }),
      prAdapter: context.prAdapter,
    },
    createTraceSink: createNoopTraceSink,
    createRuntimeExecutor: resumeHarness.createRuntimeExecutor,
    runTriggeredExecutionFn: resumeHarness.runTriggeredExecutionFn,
    resolveSessionHandle: resumeHarness.resolveSessionHandle,
    isRunResumable: resumeHarness.isRunResumable,
  });
  assertCondition(result.resume_status === "committed", `warm resume did not commit: ${result.resume_status || result.status}`);
  assertCondition(result.prior_run_id === priorRun.run_id || result.result?.artifact?.resume?.prior_run_id === priorRun.run_id, "warm resume did not carry the original run_id");

  const refreshed = await refreshReviewTarget(context, target.issue.id);
  assertCondition(refreshed.pr.number === target.pr.number, "warm resume created or selected a different PR");
  assertCondition(refreshed.pr.head_sha !== target.pr.head_sha, "warm resume did not push a new PR head");
  const openPrs = await listOpenPullRequestsForBranch(context, refreshed.branch);
  assertCondition(openPrs.length === 1 && openPrs[0].number === target.pr.number, "warm resume produced more than one open PR");
  const inReviewIssue = await waitForIssueTarget(context, target.issue.id, context.inReviewTarget, "In Review after warm resume");

  context.log(`Warm resume committed to existing PR #${target.pr.number}: ${target.pr.head_sha} -> ${refreshed.pr.head_sha}`);
  return {
    ok: true,
    name: "request-changes-warm-resume-same-pr",
    issueId: target.issue.id,
    issueKey: inReviewIssue.identifier,
    pr: prSummary(refreshed.pr),
    priorHeadSha: target.pr.head_sha,
    newHeadSha: refreshed.pr.head_sha,
    priorRunId: priorRun.run_id,
    resume_status: result.resume_status,
    resume: result.result?.artifact?.resume || result.resume || null,
    resumeSessionHandleSource: resumeHarness.sessionHandleSource,
    warmStartObserved: resumeHarness.warmStartObserved,
    workerProof: resumeHarness.workerProof(),
    sourceRefs: sourceRefsForTarget(refreshed),
  };
}

async function runApproveScenario(context, target, warmResumeScenario) {
  const result = await runReviewOnce(context, target, {
    disposition: "approve",
    body: "Approved. The request-change fix landed on the same PR and the gate can go green.",
    scenario: "approve-after-warm-resume",
  });
  assertCondition(result.status === "completed", "approve review did not complete");
  const gate = await waitForReviewGate(context, target, {
    headSha: target.pr.head_sha,
    disposition: "approve",
    expectedState: "success",
    expectedCommentCount: 1,
    expectedStatusCount: 1,
    label: "approve gate",
  });
  const pr = await context.prAdapter.getPullRequest(target.pr.number);
  assertCondition(pr.state === "open", "review must not close or merge the PR");
  assertCondition(pr.merged !== true, "review must not merge the PR");
  assertCondition(warmResumeScenario.newHeadSha === target.pr.head_sha, "approve did not review the warm-resume head");

  context.log(`Approve review set success at ${target.pr.head_sha}; PR #${target.pr.number} remains open`);
  return {
    ok: true,
    name: "approve-success-no-merge",
    issueId: target.issue.id,
    pr: prSummary(target.pr),
    head_sha: target.pr.head_sha,
    gate: reviewGateSummary(gate),
    prState: pr.state,
    merged: pr.merged === true,
    sourceRefs: sourceRefsForTarget(target),
  };
}

async function runDiffIncompleteScenario(context, target) {
  const result = await runReviewOnce(context, target, {
    disposition: "approve",
    body: "This body must not be used because the diff is incomplete.",
    scenario: "diff-incomplete",
    diffIncomplete: true,
  });
  assertCondition(result.status === "completed", "diff_incomplete review did not complete");
  const gate = await waitForReviewGate(context, target, {
    headSha: target.pr.head_sha,
    disposition: "escalate",
    expectedState: "failure",
    expectedCommentCount: 1,
    expectedStatusCount: 1,
    label: "diff_incomplete failure gate",
  });
  const issue = await waitForIssueTarget(context, target.issue.id, context.needsPrincipalTarget, "Needs Principal after diff_incomplete");
  assertCondition(gate.latestStatus.state !== "success", "diff_incomplete must never set a green af-review gate");

  context.log(`Diff-incomplete review failed closed and escalated ${issue.identifier}`);
  return {
    ok: true,
    name: "diff-incomplete-failure-escalates",
    issueId: target.issue.id,
    issueKey: issue.identifier,
    pr: prSummary(target.pr),
    head_sha: target.pr.head_sha,
    gate: reviewGateSummary(gate),
    issueState: issue.state?.name || null,
    sourceRefs: sourceRefsForTarget(target),
  };
}

async function runNoPrEscalationScenario(context) {
  const issue = await createDisposableIssue(context, {
    slug: "review-no-pr-escalation",
    stateId: context.inReviewTarget.id,
    summary: "Review UAT no-PR escalation fixture. No execution branch or PR is created for this issue.",
  });
  const result = await runFreshReviewSyntheticWake({
    config: context.config,
    repoRoot: context.repoRoot,
    registry: context.registry,
    domain: context.domain,
    domainContext: context.domainContext,
    issueId: issue.id,
    reviewDecision: {
      action: "escalate",
      reason: "review_pr_missing",
      location: { status: "none", reason: "review_pr_missing" },
      repoIdentity: context.repoIdentity,
      hasPr: false,
    },
    runDeps: { store: context.store, prAdapter: context.prAdapter },
    createTraceSink: createNoopTraceSink,
    runTriggeredReviewFn: (options) => runTriggeredReview({
      ...options,
      orchestratorTurnExecutor: async () => {
        throw new Error("no-PR escalation should not invoke the reviewer");
      },
    }),
  });
  assertCondition(result.status === "completed", "no-PR escalation did not complete");
  const escalated = await waitForIssueTarget(context, issue.id, context.needsPrincipalTarget, "Needs Principal after no-PR escalation");
  const branch = branchNameForIssue(escalated.identifier);
  const openPrs = await listOpenPullRequestsForBranch(context, branch);
  assertCondition(openPrs.length === 0, "no-PR escalation unexpectedly found or created a PR");

  context.log(`No-PR escalation moved ${escalated.identifier} to Needs Principal without a PR comment`);
  return {
    ok: true,
    name: "no-pr-escalates-needs-principal",
    issueId: issue.id,
    issueKey: escalated.identifier,
    issueState: escalated.state?.name || null,
    openPrCount: openPrs.length,
    applied: result.result?.applied || [],
    sourceRefs: [{ kind: "linear_issue", id: issue.id, url: issue.url || null }],
  };
}

async function runReviewOnce(context, target, {
  disposition,
  body,
  scenario,
  diffIncomplete = false,
  effects = [],
} = {}) {
  const prAdapter = diffIncomplete
    ? diffIncompletePrAdapter(context, { reason: "review_uat_forced_diff_incomplete" })
    : context.prAdapter;
  const reviewDecision = {
    action: "review",
    reason: "review_pr_found",
    pr: target.pr,
    repoIdentity: context.repoIdentity,
    hasPr: true,
  };
  const orchestratorTurnExecutor = scriptedReviewTurnExecutor({
    disposition,
    body,
    headSha: target.pr.head_sha,
    pr: target.pr,
    scenario,
  });
  const result = await runFreshReviewSyntheticWake({
    config: context.config,
    repoRoot: context.repoRoot,
    registry: context.registry,
    domain: context.domain,
    domainContext: context.domainContext,
    issueId: target.issue.id,
    reviewDecision,
    runDeps: {
      store: context.store,
      prAdapter,
      effects,
    },
    createTraceSink: createNoopTraceSink,
    runTriggeredReviewFn: (options) => runTriggeredReview({
      ...options,
      orchestratorTurnExecutor: diffIncomplete
        ? async () => {
            throw new Error("diff_incomplete review should not invoke the scripted reviewer");
          }
        : orchestratorTurnExecutor,
      runtimeExecutor: {
        async executeSubagent() {
          throw new Error("review UAT scripted reviewer should not invoke subagents");
        },
      },
    }),
  });
  return result;
}

function scriptedReviewTurnExecutor({ disposition, body, headSha, pr, scenario }) {
  return async (input = {}) => ({
    controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
    producedContent: {
      disposition,
      body,
      reviewed_head_sha: headSha,
      context_digest: `Review UAT ${scenario || disposition} completed for PR #${pr.number}.`,
      source_refs: [{ kind: "github_pull_request", id: `${pr.owner}/${pr.repo}#${pr.number}` }],
      assumptions: [],
      constraints: ["review_uat_scripted_disposition"],
      risks: ["Disposable live UAT review."],
    },
    evidence: null,
    sessionHandle: {
      id: `review-uat-${scenario || disposition}-${input.runId}`,
      role: "orchestrator",
      run_id: input.runId,
      runtime: "review-uat",
    },
  });
}

function createDeterministicWarmResumeHarness(context, { issueId, priorRun, priorHeadSha }) {
  let turn = 0;
  let warmStartObserved = null;
  let proof = null;
  const priorRunId = priorRun.run_id;
  const resolved = resolveDriverSessionHandle(priorRun, { repoRoot: context.repoRoot });
  const sessionHandle = resolved || {
    id: `review-uat-synthetic-session-${priorRunId}`,
    role: "orchestrator",
    run_id: priorRunId,
    runtime: "review-uat",
  };
  const sessionHandleSource = resolved ? "run_artifact.runtime_metadata" : "review_uat_synthetic_prior_session";

  return {
    get warmStartObserved() {
      return warmStartObserved;
    },
    sessionHandleSource,
    resolveSessionHandle(run) {
      if (run?.run_id !== priorRunId) return null;
      return sessionHandle;
    },
    isRunResumable(run) {
      return run?.run_id === priorRunId ? true : runIsResumable(run);
    },
    createRuntimeExecutor() {
      return {
        async executeSubagent(input = {}) {
          proof = writeWarmResumeWorkerChange(input, { priorHeadSha });
          const packet = {
            schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
            run_id: input.runId,
            status: "continue",
            reason: "review_feedback_addressed",
            context_digest: "Review UAT worker wrote a scoped warm-resume proof file.",
            source_refs: [{ kind: "linear_issue", id: issueId }],
            assumptions: [],
            constraints: ["review_uat_deterministic_warm_resume_worker"],
            risks: ["Disposable UAT proof file only."],
          };
          const output = JSON.stringify(packet);
          return {
            ok: true,
            packet,
            output,
            role: input.runtime_role,
            runtime: "review-uat",
            parse_status: "valid",
            clean_parse: true,
            raw_output_excerpt: output,
            envelope: "review uat deterministic warm-resume worker",
            sessionHandle: null,
            evidence: {
              evidence_unavailable: [
                { scope: `${input.runtime_role}.turn.tool_events`, reason: "review_uat_deterministic_runtime" },
              ],
            },
          };
        },
      };
    },
    runTriggeredExecutionFn(options = {}) {
      return runTriggeredExecution({
        ...options,
        roster: fakeExecutionRoster(),
        orchestratorTurnExecutor: async (input = {}) => {
          turn += 1;
          if (input.firstTurnWarmStart && !warmStartObserved) {
            warmStartObserved = {
              priorRunId: input.firstTurnWarmStart.priorRunId,
              sessionHandle: input.firstTurnWarmStart.sessionHandle,
              reviewerNotesPresent: typeof input.firstTurnWarmStart.reviewerNotes === "string" && input.firstTurnWarmStart.reviewerNotes.includes("af-review"),
              head_sha: input.firstTurnWarmStart.head_sha,
            };
          }
          if (turn === 1) {
            return {
              controlAction: {
                action: "invoke_library",
                target_key: "prompt/execution/code_worker",
              },
              evidence: null,
              sessionHandle,
            };
          }
          return {
            controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
            producedContent: {
              pr_title: `Review UAT warm resume ${issueId}`,
              pr_body: [
                "## Review UAT Warm Resume",
                "",
                `Prior execution run: ${priorRunId}`,
                `Reviewed head: ${priorHeadSha}`,
                "",
                "This deterministic warm-resume commit proves the request-change loop updates the same PR.",
              ].join("\n"),
              linear_issue_id: issueId,
              context_digest: "Review UAT warm resume committed a deterministic fix to the existing execution PR.",
              source_refs: [{ kind: "linear_issue", id: issueId }],
              assumptions: [],
              constraints: ["review_uat_deterministic_warm_resume"],
              risks: ["Disposable live UAT PR."],
            },
            evidence: null,
            sessionHandle: {
              id: `review-uat-warm-session-${input.runId}`,
              role: "orchestrator",
              run_id: input.runId,
              runtime: "review-uat",
            },
          };
        },
      });
    },
    workerProof() {
      return proof;
    },
  };
}

function fakeExecutionRoster() {
  return {
    selectableTargets: ["prompt/execution/code_worker"],
    resolve(targetKey) {
      if (targetKey !== "prompt/execution/code_worker") {
        return { ok: false, reason: "review_uat_target_not_selectable" };
      }
      return {
        ok: true,
        runtime_role: "worker",
        loadSnapshot: () => ({
          entry: {
            target_key: targetKey,
            human_name: "Review UAT Warm Resume Worker",
          },
          contentBytes: "Review UAT deterministic warm-resume worker prompt.",
          snapshotSha256: "review-uat-warm-resume-worker",
        }),
      };
    },
  };
}

function writeWarmResumeWorkerChange(input = {}, { priorHeadSha }) {
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error("review_uat_worker_cwd_missing");
  }
  const relativeFile = path.join("execution", "integrations", "linear", "uat", "live-review-warm-resume", `${safePathSegment(input.runId)}.md`);
  const absoluteFile = path.join(cwd, relativeFile);
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.writeFileSync(absoluteFile, [
    "# Review UAT Warm Resume Proof",
    "",
    `Run: ${input.runId}`,
    `Issue: ${input.project?.identifier || input.project?.id || "unknown"}`,
    `Prior reviewed head: ${priorHeadSha}`,
    "",
    "The deterministic Review UAT worker wrote this file inside the contained clone.",
    "",
  ].join("\n"), "utf8");
  return {
    runId: input.runId,
    issueId: input.project?.id || null,
    relativeFile: relativeFile.split(path.sep).join("/"),
  };
}

async function spawnCrashChild(context, { crashMode, issueId }) {
  const args = [
    HARNESS_PATH,
    "--child-crash",
    crashMode,
    "--issue-id",
    issueId,
    "--disposition",
    "request-changes",
    "--repo-root",
    context.repoRoot,
    "--domain",
    context.domain.id,
    "--required-prs",
    "1",
  ];
  if (context.expectedRepoName) args.push("--expected-repo-name", context.expectedRepoName);
  if (context.resourceId) args.push("--resource-id", context.resourceId);
  const child = spawn(process.execPath, args, {
    cwd: context.repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let crashEvent = null;
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const drained = drainJsonLines(stdoutBuffer);
    stdoutBuffer = drained.remainder;
    for (const item of drained.items) {
      if (item.type === CHILD_EVENT_TYPE && item.event === "kill_point") {
        crashEvent = item;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
  });

  const event = await waitForValue(
    () => crashEvent,
    {
      timeoutMs: DEFAULT_CHILD_CRASH_TIMEOUT_MS,
      intervalMs: 250,
      label: REVIEW_CRASH_SCENARIOS[crashMode].description,
    },
  );
  killChild(child);
  await waitForChildClose(child, { timeoutMs: 5_000 });
  return {
    event,
    stderr: redactGitHubSecrets(stderrBuffer).slice(0, 500),
  };
}

async function runChildCrashReview(options) {
  const context = await prepareLiveReviewUatContext({
    ...options,
    requiredPrs: 1,
    keepArtifacts: true,
    onLog: () => {},
  });
  const target = context.reviewTargets[0];
  const effect = {
    id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
    async apply(ctx = {}) {
      emitChildEvent({
        event: "kill_point",
        crashMode: options.childCrash,
        issueId: target.issue.id,
        runId: ctx.runId || ctx.artifact?.run_id || null,
        headSha: ctx.review?.head_sha || target.pr.head_sha,
        disposition: ctx.review?.disposition || options.childDisposition,
      });
      return new Promise(() => {});
    },
  };
  await runReviewOnce(context, target, {
    disposition: options.childDisposition,
    body: "Request changes: crash child stops after comment before status.",
    scenario: "child-crash-after-comment-before-status",
    effects: [effect],
  });
  return new Promise(() => {});
}

async function refreshReviewTarget(context, issueId) {
  const issue = await context.client.getIssueContext(issueId);
  const location = await locatePullRequestForIssue({
    issueContext: issue,
    repoIdentity: context.repoIdentity,
    prAdapter: context.prAdapter,
  });
  if (location?.status !== "found") {
    throw new Error(`review_target_refresh_failed:${location?.status || "missing"}:${location?.reason || ""}`);
  }
  const branch = location.branch || branchNameForIssue(issue.identifier);
  rememberTouchedIssue(context, issue.id);
  rememberTouchedPr(context, { pr: location.pr, branch });
  return {
    issue,
    pr: location.pr,
    branch,
    location,
  };
}

async function waitForReviewGate(context, target, {
  headSha,
  disposition,
  expectedState,
  expectedCommentCount,
  expectedStatusCount,
  label,
}) {
  return waitForValue(async () => {
    const snapshot = await reviewGateSnapshot(context, target, { headSha, disposition });
    if (snapshot.commentCount !== expectedCommentCount) return null;
    if (snapshot.statusCount !== expectedStatusCount) return null;
    if (expectedState && snapshot.latestStatus?.state !== expectedState) return null;
    if (!expectedState && snapshot.latestStatus) return null;
    return snapshot;
  }, {
    timeoutMs: context.timeoutMs,
    intervalMs: context.pollIntervalMs,
    label,
  });
}

async function reviewGateSnapshot(context, target, { headSha, disposition }) {
  const [comments, statuses] = await Promise.all([
    context.prAdapter.listPullRequestComments(target.pr.number),
    context.prAdapter.getCommitStatuses(headSha),
  ]);
  const markerComments = comments.filter((comment) => {
    const parsed = parseAfReviewCommentMarker(comment?.body);
    return parsed.ok &&
      parsed.marker.context === AF_REVIEW_STATUS_CONTEXT &&
      parsed.marker.head_sha === headSha &&
      parsed.marker.disposition === disposition;
  });
  const afStatuses = statuses.filter((status) =>
    status?.context === AF_REVIEW_STATUS_CONTEXT);
  return {
    headSha,
    disposition,
    commentCount: markerComments.length,
    statusCount: afStatuses.length,
    latestStatus: latestStatus(afStatuses),
    commentIds: markerComments.map((comment) => String(comment.comment_id || comment.id)),
  };
}

async function waitForIssueTarget(context, issueId, target, label) {
  return waitForValue(async () => {
    const issue = await context.client.getIssueContext(issueId);
    if (target?.id && issue.state?.id === target.id) return issue;
    if (target?.name && issue.state?.name === target.name) return issue;
    return null;
  }, {
    timeoutMs: context.timeoutMs,
    intervalMs: context.pollIntervalMs,
    label,
  });
}

async function createDisposableIssue(context, { slug, stateId, summary }) {
  const stamp = uatStamp();
  const title = `${context.prefix} ${stamp} ${slug}`;
  const issue = await context.client.createIssue({
    title,
    description: [
      "## Review UAT Fixture",
      "",
      summary,
      "",
      "This issue was created by the live review UAT harness and is disposable.",
    ].join("\n"),
    teamId: context.domain.linear.team_id,
    stateId,
  });
  context.createdIssues.push(issue.id);
  rememberTouchedIssue(context, issue.id);
  return context.client.getIssueContext(issue.id);
}

async function cleanupReviewUatArtifacts(context) {
  if (context.keepArtifacts) {
    return {
      skipped: true,
      reason: "keep_artifacts",
      issues: [...new Set(context.touchedIssues)],
      pullRequests: context.touchedPullRequests.map((entry) => entry.number),
      branches: [...new Set(context.touchedBranches)],
    };
  }

  const results = [];
  for (const pr of uniqueBy(context.touchedPullRequests, (entry) => String(entry.number))) {
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

  for (const branch of [...new Set(context.touchedBranches)]) {
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

  for (const issueId of [...new Set(context.touchedIssues)]) {
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

function diffIncompletePrAdapter(context, { reason }) {
  return {
    ...context.prAdapter,
    async getPullRequestFiles() {
      return {
        files: [],
        diff_incomplete: true,
        reason,
      };
    },
  };
}

function createPrAdapter({ repoIdentity, githubToken }) {
  return createDefaultExecutionPullRequestAdapter({
    repoIdentity,
    token: () => githubToken,
  });
}

async function listOpenPullRequestsForBranch(context, branch) {
  const query = new URLSearchParams({
    state: "open",
    head: `${context.repoIdentity.owner}:${branch}`,
    base: context.repoIdentity.default_branch,
    per_page: "100",
  });
  return githubApi(context, `/repos/${encodePathSegment(context.repoIdentity.owner)}/${encodePathSegment(context.repoIdentity.repo)}/pulls?${query.toString()}`);
}

async function githubApi(context, apiPath, { method = "GET", body = null, allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.githubToken}`,
      "User-Agent": "teami-review-uat",
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

async function assertUatRepoBinding({ repoRoot, repoIdentity, expectedRepoName }) {
  const expectedName = String(expectedRepoName || "").trim();
  if (expectedName && repoIdentity.repo !== expectedName) {
    throw new ReviewUatUserError(
      `Review UAT expected repo name ${expectedName}; selected git_repo binding is ${repoIdentity.owner}/${repoIdentity.repo}.`,
      "wrong_repo",
    );
  }
  if (!repoIdentity.default_branch) {
    throw new ReviewUatUserError("Review UAT requires git_repo.default_branch.", "git_repo_binding");
  }
  const remote = await runGit(["remote", "get-url", "origin"], {
    cwd: repoRoot,
    operation: "git_read",
  });
  if (!remote.ok || !remote.stdout.trim()) {
    throw new ReviewUatUserError("Review UAT requires an origin remote in the bound checkout.", "origin_missing");
  }
  const parsed = parseGitHubRemoteUrl(remote.stdout.trim());
  if (!parsed || parsed.owner !== repoIdentity.owner || parsed.repo !== repoIdentity.repo) {
    throw new ReviewUatUserError(
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
    throw new ReviewUatUserError(
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
    throw new ReviewUatUserError(
      result.timedOut
        ? "GitHub CLI token lookup timed out. Retry after confirming gh auth status in another terminal."
        : "GitHub CLI token is unavailable. Run gh auth login and retry.",
      "github_auth_token_failed",
    );
  }
  return token;
}

function selectUatDomain({ registry, domainId = null } = {}) {
  const domains = Array.isArray(registry?.domains) ? registry.domains : [];
  const active = domains.filter((domain) => domain.status === "active");
  if (active.length === 0) {
    throw new ReviewUatUserError("no active Linear domain configured; run init against a disposable test team", "no_linear_domain");
  }
  if (domainId) {
    const selected = active.find((domain) => domain.id === domainId);
    if (!selected) throw new ReviewUatUserError(`domain not active or not found for review UAT: ${domainId}`, "domain");
    return selected;
  }
  if (active.length > 1) {
    throw new ReviewUatUserError(
      `multiple Linear domains configured (${active.map((domain) => domain.id).join(", ")}) - pass --domain <domain_id>`,
      "domain",
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

function latestRunForIssueWorkflow(context, issueId, workflowType) {
  const state = readLocalTriggerState(localTriggerStorePath());
  return state.runs
    .filter((run) => run.object_id === issueId && run.workflow_type === workflowType)
    .sort((a, b) => String(a.started_at || "").localeCompare(String(b.started_at || "")))
    .at(-1) || null;
}

function latestStatus(statuses) {
  let latest = null;
  statuses.forEach((status, index) => {
    const candidate = {
      status,
      index,
      time: Date.parse(status?.created_at || ""),
    };
    if (!latest) {
      latest = candidate;
      return;
    }
    const leftHasTime = Number.isFinite(candidate.time);
    const rightHasTime = Number.isFinite(latest.time);
    if (leftHasTime && rightHasTime && candidate.time !== latest.time) {
      if (candidate.time > latest.time) latest = candidate;
      return;
    }
    if (leftHasTime !== rightHasTime) {
      if (leftHasTime) latest = candidate;
      return;
    }
    if (candidate.index < latest.index) latest = candidate;
  });
  return latest?.status || null;
}

function rememberTouchedIssue(context, issueId) {
  if (issueId && !context.touchedIssues.includes(issueId)) context.touchedIssues.push(issueId);
}

function rememberTouchedPr(context, { pr, branch }) {
  if (pr?.number && !context.touchedPullRequests.some((entry) => entry.number === pr.number)) {
    context.touchedPullRequests.push({
      number: pr.number,
      branch,
    });
  }
  if (branch && !context.touchedBranches.includes(branch)) context.touchedBranches.push(branch);
}

function reviewTargetSummary(target) {
  return {
    issueId: target.issue.id,
    issueKey: target.issue.identifier,
    branch: target.branch,
    pr: prSummary(target.pr),
  };
}

function prSummary(pr) {
  if (!pr) return null;
  return {
    owner: pr.owner || null,
    repo: pr.repo || null,
    number: pr.number,
    head_sha: pr.head_sha || pr.head?.sha || null,
  };
}

function reviewGateSummary(gate) {
  return {
    headSha: gate.headSha,
    disposition: gate.disposition,
    commentCount: gate.commentCount,
    statusCount: gate.statusCount,
    latestState: gate.latestStatus?.state || null,
    commentIds: gate.commentIds,
  };
}

function sourceRefsForTarget(target) {
  return [
    { kind: "linear_issue", id: target.issue.id, url: target.issue.url || null },
    { kind: "github_pull_request", id: String(target.pr?.number || ""), url: target.pr?.html_url || target.pr?.url || null },
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
    env,
    exactEnv,
    ...(operation ? { operation } : {}),
  });
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
    throw new ReviewUatUserError(`expected a positive integer, got ${value}`, "usage");
  }
  return parsed;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new ReviewUatUserError(`${flag} requires a value`, "usage");
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
    options = parseReviewUatArgs(argv);
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildReviewUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    if (options.childCrash) {
      await runChildCrashReview(options);
      exit(1);
      return { ok: false, stage: "child_completed_without_crash" };
    }

    const report = await runReviewUat({ ...options, onLog: stdout });
    for (const scenario of report.scenarios) {
      stdout(`PASS ${scenario.name}`);
    }
    stdout(`Review UAT touched ${report.touchedIssues.length} Linear issue(s).`);
    if (report.cleanup?.skipped) {
      stdout(`Cleanup skipped: ${report.cleanup.reason}.`);
    } else if (report.cleanup?.ok === false) {
      stderr(`Cleanup had failures: ${JSON.stringify(report.cleanup.results)}`);
      exit(1);
      return { ok: false, stage: "cleanup", report };
    }
    stdout("REVIEW UAT PASS");
    exit(0);
    return { ok: true, report };
  } catch (error) {
    const message = error instanceof ReviewUatUserError
      ? error.message
      : `REVIEW UAT FAIL: ${error?.message || String(error)}`;
    stderr(redactGitHubSecrets(message));
    if (!(error instanceof ReviewUatUserError)) {
      stderr(`Run store: ${defaultRunStoreDir(options.repoRoot)}`);
    }
    exit(error instanceof ReviewUatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "run", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(redactGitHubSecrets(`REVIEW UAT FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
