import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeRunArtifact } from "../../../engine/run-store.mjs";
import { runBoundedGit, runBoundedSubprocess } from "../../git/bounded-subprocess.mjs";
import { createGitHubPromotionClient } from "../src/github-promotion-client.mjs";
import { createProductionGitHubPromotionTransport } from "../src/github-production-transport.mjs";
import {
  parseGitHubRemoteUrl,
  readGitHubConnectionState,
  resolveBehaviorRepoIdentity,
} from "../src/github-setup.mjs";
import {
  redactGitHubSecrets,
  scrubGitHubAuthEnv,
} from "../src/github-secret-hygiene.mjs";
import {
  PROMOTION_BRANCH_NAMESPACE,
  validatePromotionBranchRef,
} from "../src/promotion-workspace.mjs";
import {
  buildPromotionPrBody,
} from "../src/promotion-pr-body.mjs";
import {
  buildPromotionMarker,
  parsePromotionMarkers,
} from "../src/promote-candidate.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");

export const DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX = "af-uat-github-local";
export const GITHUB_LOCAL_UAT_RUN_PAYLOAD_SCHEMA_ID = "teami-github-local-uat-payload/v1";

const GH_API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2022-11-28",
]);

class GitHubLocalUatUserError extends Error {
  constructor(message, code = "uat_user_error") {
    super(message);
    this.name = "GitHubLocalUatUserError";
    this.code = code;
  }
}

export function parseGitHubLocalUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(env.TEAMI_GITHUB_LOCAL_UAT_REPO_ROOT || env.TEAMI_UAT_REPO_ROOT || REPO_ROOT),
    workspaceDir: env.TEAMI_GITHUB_LOCAL_UAT_WORKSPACE_DIR
      ? path.resolve(env.TEAMI_GITHUB_LOCAL_UAT_WORKSPACE_DIR)
      : null,
    branchPrefix: env.TEAMI_GITHUB_LOCAL_UAT_BRANCH_PREFIX || DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
    keepArtifacts: truthy(env.TEAMI_GITHUB_LOCAL_UAT_KEEP_ARTIFACTS || env.TEAMI_UAT_KEEP_ARTIFACTS),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--workspace-dir") {
      options.workspaceDir = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--branch-prefix") {
      options.branchPrefix = requireNext(argv, ++index, arg);
    } else if (arg === "--keep-artifacts") {
      options.keepArtifacts = true;
    } else {
      throw new GitHubLocalUatUserError(`unknown uat:github-local flag: ${arg}`, "usage");
    }
  }

  validateGitHubLocalUatBranchPrefix(options.branchPrefix);
  return options;
}

export function buildGitHubLocalUatUsage() {
  return [
    "Usage: npm run uat:github-local -- [--keep-artifacts] [--repo-root <path>] [--workspace-dir <path>] [--branch-prefix af-uat-github-local]",
    "",
    "Live prerequisites:",
    "- .teami/github-connection.json must be a verified real local_ambient connection to your bound behavior repo (your clone of the product).",
    "- `gh auth status --hostname github.com` must be logged in.",
    "- Local git auth must be able to push a branch to the behavior repo.",
    "",
    "Environment equivalents:",
    "- TEAMI_GITHUB_LOCAL_UAT_KEEP_ARTIFACTS=1 keeps the PR and branch.",
    "- TEAMI_GITHUB_LOCAL_UAT_WORKSPACE_DIR overrides the disposable internal clone directory.",
    "- TEAMI_GITHUB_LOCAL_UAT_BRANCH_PREFIX overrides the suffix under teami/promotion/.",
  ].join("\n");
}

export async function runGitHubLocalUat({
  repoRoot = REPO_ROOT,
  workspaceDir = null,
  branchPrefix = DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
  keepArtifacts = false,
  env = process.env,
  now = () => new Date(),
  runGit = runBoundedGit,
  runCommand = defaultRunCommand,
  onLog = () => {},
} = {}) {
  const logs = [];
  const log = (line) => {
    const safe = redactGitHubSecrets(line);
    logs.push(safe);
    onLog(safe);
  };
  const resolvedRepoRoot = path.resolve(repoRoot);
  const startedAt = now().toISOString();
  const stamp = uatStamp({ now });
  const runId = `github-local-uat-${stamp}-${randomBytes(3).toString("hex")}`;
  const branch = githubLocalUatBranchName({ branchPrefix, stamp });
  const commands = [];
  const runGitRecording = createRecordingRunGit({ runGit, records: commands });
  const runCommandRecording = createRecordingRunCommand({ runCommand, records: commands });
  let pr = null;
  let cleanup = null;
  let evidencePath = null;
  let cleanupContext = null;

  try {
  validateGitHubLocalUatBranchPrefix(branchPrefix);
  log(`GitHub local UAT run ${runId}`);

  const repoIdentity = assertGitHubLocalUatBinding(
    resolveBehaviorRepoIdentity({ repoRoot: resolvedRepoRoot }),
    { repoRoot: resolvedRepoRoot },
  );
  assertGhAuthStatusResult(await runCommandRecording("gh", ["auth", "status", "--hostname", "github.com"], {
    cwd: resolvedRepoRoot,
    env: ghCommandEnv({ env, pushAuth: repoIdentity.push_auth }),
  }));

  const selection = createProductionGitHubPromotionTransport({
    repoRoot: resolvedRepoRoot,
    repoIdentity,
    env,
  });
  assertLocalAmbientGitHubSelection({ selection, repoIdentity });
  cleanupContext = {
    owner: selection.owner,
    repo: selection.repo,
    branch,
    cwd: resolvedRepoRoot,
    env,
    pushAuth: selection.pushAuth,
    runCommand: runCommandRecording,
  };
  const github = createGitHubPromotionClient({
    transport: selection.transport,
    repo: selection,
  });
  log(`Using ${selection.owner}/${selection.repo} via ${selection.mode}; push auth ${selection.pushAuth}`);

  // Live reachability and auth check before creating any branch or PR.
  await github.listOpenPullRequests();

  const workspace = await ensureGitHubLocalUatWorkspace({
    repoRoot: resolvedRepoRoot,
    workspaceDir,
    selection,
    branch,
    runGit: runGitRecording,
  });
  const prProvenance = buildGitHubLocalUatPrProvenance({
    runId,
    branch,
    startedAt,
    selection,
  });
  const prBody = buildGitHubLocalUatPrBody({
    runId,
    branch,
    startedAt,
    selection,
    prProvenance,
  });
  assertGitHubLocalUatProvenance({ prBody, evidence: { pr_provenance: prProvenance }, runId });
  const preWriteLeakScan = scanGitHubCredentialLeaks({
    pr_body: prBody,
    logs,
    child_env: scrubGitHubAuthEnv(env, { pushAuth: selection.pushAuth }),
  });
  assertNoGitHubCredentialLeaks(preWriteLeakScan);

  const proposalPath = writeGitHubLocalUatProposal({
    cloneDir: workspace.cloneDir,
    runId,
    branch,
    prBody,
  });
  const commitSha = await commitGitHubLocalUatProposal({
    cloneDir: workspace.cloneDir,
    proposalPath,
    runId,
    runGit: runGitRecording,
  });
  log(`Committed disposable self-improvement proposal ${commitSha}`);

  const push = await pushGitHubLocalUatBranch({
    cloneDir: workspace.cloneDir,
    owner: selection.owner,
    repo: selection.repo,
    branch,
    checkoutPath: selection.checkoutPath,
    pushAuth: selection.pushAuth,
    env,
    runGit: runGitRecording,
  });
  if (!push.ok) {
    throw new Error(`github_local_uat_push_failed:${push.reason}${push.detail ? `:${push.detail}` : ""}`);
  }
  log(`Pushed ${branch}`);

  const created = await github.createPullRequest({
    title: `GitHub local ambient UAT ${stamp}`,
    head: branch,
    base: selection.defaultBranch,
    body: prBody,
    draft: false,
  });
  pr = created?.data || null;
  if (!pr?.number || !pr?.html_url) {
    throw new Error("github_local_uat_pr_create_returned_no_identity");
  }
  log(`Created PR #${pr.number}: ${pr.html_url}`);

  const evidence = buildGitHubLocalUatRunEvidence({
    runId,
    startedAt,
    completedAt: now().toISOString(),
    selection,
    repoIdentity,
    branch,
    commitSha,
    proposalPath,
    push,
    pr,
    prProvenance,
    commands,
    transportCalls: selection.transport.calls,
    logs,
  });
  const finalLeakScan = scanGitHubCredentialLeaks({
    pr_body: prBody,
    run_evidence: evidence,
    transport_calls: selection.transport.calls,
    command_summaries: commands,
    logs,
    child_env: scrubGitHubAuthEnv(env, { pushAuth: selection.pushAuth }),
  });
  assertNoGitHubCredentialLeaks(finalLeakScan);
  evidence.payload.leak_scan = finalLeakScan;
  evidence.terminal_output.context_digest =
    `GitHub local UAT opened PR #${pr.number} on ${selection.owner}/${selection.repo} with local ambient auth.`;
  evidencePath = writeRunArtifact({ repoRoot: resolvedRepoRoot, runId }, evidence);
  const writtenEvidence = fs.readFileSync(evidencePath, "utf8");
  assertNoGitHubCredentialLeaks(scanGitHubCredentialLeaks({ written_run_evidence: writtenEvidence }));
  assertGitHubLocalUatProvenance({ prBody, evidence: JSON.parse(writtenEvidence), runId });
  log(`Wrote run evidence ${evidencePath}`);

  try {
    cleanup = await cleanupGitHubLocalUatArtifacts({
      keepArtifacts,
      owner: cleanupContext.owner,
      repo: cleanupContext.repo,
      prNumber: pr.number,
      branch: cleanupContext.branch,
      cwd: cleanupContext.cwd,
      env: cleanupContext.env,
      pushAuth: cleanupContext.pushAuth,
      runCommand: cleanupContext.runCommand,
    });
  } catch (error) {
    cleanup = { ok: false, error: redactGitHubSecrets(error.message) };
    throw error;
  }

  return {
    ok: true,
    runId,
    branch,
    pr: { number: pr.number, url: pr.html_url },
    evidencePath,
    cleanup,
    logs,
  };
  } catch (error) {
    if (pr && cleanup === null && cleanupContext && !keepArtifacts) {
      try {
        cleanup = await cleanupGitHubLocalUatArtifacts({
          keepArtifacts: false,
          owner: cleanupContext.owner,
          repo: cleanupContext.repo,
          prNumber: pr.number,
          branch: cleanupContext.branch,
          cwd: cleanupContext.cwd,
          env: cleanupContext.env,
          pushAuth: cleanupContext.pushAuth,
          runCommand: cleanupContext.runCommand,
        });
        log(`Cleanup after failure closed PR #${pr.number} and deleted ${cleanupContext.branch}`);
      } catch (cleanupError) {
        error.cleanup_error = redactGitHubSecrets(cleanupError.message);
        log(`Cleanup after failure failed: ${error.cleanup_error}`);
      }
    }
    throw error;
  }
}

export function assertGitHubLocalUatBinding(result, { repoRoot = process.cwd() } = {}) {
  if (!result?.ok) {
    throw new GitHubLocalUatUserError(
      `GitHub behavior repo is not bound for local UAT (${result?.reason || "unknown"}). Run npm run github:init without --github-dry-run from ${repoRoot}.`,
      "github_connection_unbound",
    );
  }
  if (result.connection_mode !== "real") {
    throw new GitHubLocalUatUserError(
      `GitHub local UAT requires a real local_ambient connection, got connection_mode=${result.connection_mode || "unknown"}. Re-run npm run github:init without --github-dry-run.`,
      "github_connection_not_real",
    );
  }
  if (result.real_push_enabled !== true) {
    throw new GitHubLocalUatUserError(
      "GitHub local UAT requires verified local git write auth (real_push_enabled=true). Run npm run github:init after fixing git push auth.",
      "github_connection_push_not_verified",
    );
  }
  if (!result.default_branch) {
    throw new GitHubLocalUatUserError(
      "GitHub local UAT requires a default_branch in the GitHub connection state. Re-run npm run github:init.",
      "github_connection_default_branch_missing",
    );
  }
  return result;
}

export function assertLocalAmbientGitHubSelection({ selection, repoIdentity } = {}) {
  const failures = [];
  if (repoIdentity?.connection_mode !== "real") failures.push("connection_mode_not_real");
  if (selection?.mode !== "local_ambient") failures.push("selection_mode_not_local_ambient");
  if (selection?.transport?.kind !== "local_ambient") failures.push("transport_not_local_ambient");
  if (selection?.realPushEnabled !== true) failures.push("real_push_not_enabled");
  if (failures.length > 0) {
    throw new GitHubLocalUatUserError(`github_local_uat_selection_failed:${failures.join(",")}`, "github_selection");
  }
  return true;
}

export function assertGhAuthStatusResult(result = {}) {
  if (result.ok) return true;
  const detail = redactGitHubSecrets(result.stderr?.trim() || result.stdout?.trim() || "gh auth status failed");
  throw new GitHubLocalUatUserError(
    `GitHub CLI is not logged in for github.com: ${detail}. Run gh auth login --hostname github.com, then retry npm run uat:github-local.`,
    "github_auth_status_failed",
  );
}

export function scanGitHubCredentialLeaks(records = {}) {
  const findings = [];
  const visit = (value, trail) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      if (redactGitHubSecrets(text) !== text) {
        findings.push({ path: trail.join("."), excerpt: redactGitHubSecrets(text).slice(0, 200) });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...trail, String(index)]));
      return;
    }
    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, [...trail, key]);
    }
  };
  visit(records, ["records"]);
  return { ok: findings.length === 0, findings };
}

export function assertNoGitHubCredentialLeaks(scan) {
  if (scan?.ok) return true;
  const detail = (scan?.findings || [])
    .map((finding) => `${finding.path}: ${finding.excerpt}`)
    .join("; ");
  throw new Error(`github_local_uat_credential_leak:${detail || "unknown"}`);
}

export function assertGitHubLocalUatProvenance({ prBody, evidence, runId } = {}) {
  const body = String(prBody || "");
  if (!body.includes("## Provenance") || !body.includes(`Source run: ${runId}`)) {
    throw new Error("github_local_uat_pr_body_missing_run_provenance");
  }
  const serialized = JSON.stringify(evidence || {});
  if (!serialized.includes(runId) || !serialized.includes("teami-pr-provenance/v1")) {
    throw new Error("github_local_uat_evidence_missing_run_provenance");
  }
  return true;
}

export function githubLocalUatBranchName({ branchPrefix = DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX, stamp } = {}) {
  const branch = `${PROMOTION_BRANCH_NAMESPACE}/${branchPrefix}/${stamp || "manual"}`;
  const validation = validatePromotionBranchRef(branch);
  if (!validation.ok) {
    throw new GitHubLocalUatUserError(`invalid github local UAT branch prefix: ${branchPrefix}`, "usage");
  }
  return validation.branch;
}

export function buildGitHubLocalUatPrBody({
  runId,
  branch,
  startedAt,
  selection,
  prProvenance,
} = {}) {
  const envelopeHash = sha256Hex(`${runId}:${branch}`);
  const proposalInstanceId = `prop-${sha256Hex(runId).slice(0, 12)}`;
  const marker = buildPromotionMarker({
    proposalInstanceId,
    candidateTargetKey: "prompt/decomposition/sr_eng_grounding_pass",
    candidateKind: "prompt",
    candidateVersionId: `github-local-uat-${sha256Hex(branch).slice(0, 12)}`,
    acceptedBaselineId: "github-local-uat-baseline",
    normalizedEnvelopeHash: envelopeHash,
    policyHash: sha256Hex("github-local-uat-policy"),
    phoenixScope: {
      origin: "http://127.0.0.1:6006",
      project_name: "teami",
    },
    evidenceIds: {
      experiments: [runId],
      datasets: [{ dataset_id: "github-local-uat", dataset_version_id: startedAt }],
      annotations: [],
    },
  });
  const body = buildPromotionPrBody({
    target: {
      human_name: "GitHub local ambient write path",
      phoenix_origin: "http://127.0.0.1:6006",
    },
    marker,
    humanSummary: {
      before_after_examples: [{
        label: "GitHub write custody",
        before: "A remote GitHub write service could create ambiguity about whose credential opened the PR.",
        after: "This disposable PR is created with the adopter's local git and gh auth.",
      }],
      added_markdown_section_headings: ["GitHub local ambient UAT"],
      removed_markdown_section_headings: [],
      authority_custody_access: {
        applies: true,
        before: ["The harness starts from the local GitHub connection state."],
        after: [`The PR branch ${branch} is pushed with local ambient ${selection?.pushAuth || "https"} auth and opened through gh api.`],
        safe_default: "Close the disposable PR; accepted factory behavior does not change.",
      },
    },
    gateFacts: {
      verdict: "pass",
      evidence_counts: { train_examples: 0, test_examples: 1, human_label_authenticity: "local_uat" },
      evidence_lineage: {
        schema_version: "teami-evidence-lineage/v1",
        run_window: { from: startedAt, to: startedAt, basis: "github_local_uat_harness" },
        run_set_digest: `sha256:${envelopeHash}`,
        safe_phoenix_handles: { experiment_id: runId, dataset_id: "github-local-uat", dataset_version_id: startedAt },
      },
    },
    evidenceQualityLabel: "medium",
    promotionRiskLabel: {
      label: "high_risk",
      explanation: "This is a live GitHub side-effect proof; the harness closes the disposable PR and deletes the test branch by default.",
    },
    evidenceSummaryLines: [
      `Run ${runId} pushed ${branch}.`,
      `GitHub selection mode ${selection?.mode || "unknown"} with local ambient auth.`,
    ],
    sanitizerReport: {
      content_gate_version: "github-local-uat/v1",
      removed_count: 0,
      transformed_count: 0,
    },
    machineAuthorship: "teami_github_local_uat",
    prProvenance,
    allowedOriginPrefix: "http://127.0.0.1:6006",
  });
  if (parsePromotionMarkers(body).length !== 1) {
    throw new Error("github_local_uat_pr_body_marker_count");
  }
  return body;
}

async function ensureGitHubLocalUatWorkspace({
  repoRoot,
  workspaceDir,
  selection,
  branch,
  runGit,
} = {}) {
  const dir = path.resolve(workspaceDir || path.join(repoRoot, ".teami", "github-local-uat"));
  const cloneDir = path.join(dir, "repo");
  const cloneUrl = await resolveCloneUrl({ selection, runGit });
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(cloneDir, ".git"))) {
    const clone = await runGit(["clone", "--no-tags", cloneUrl, cloneDir], { cwd: dir });
    if (!clone.ok) {
      throw new Error(`github_local_uat_clone_failed:${redactGitHubSecrets(clone.stderr.trim() || clone.stdout.trim())}`);
    }
  }
  const fetch = await runGit(["fetch", "origin", "--prune"], { cwd: cloneDir });
  if (!fetch.ok) {
    throw new Error(`github_local_uat_fetch_failed:${redactGitHubSecrets(fetch.stderr.trim() || fetch.stdout.trim())}`);
  }
  const status = await runGit(["status", "--porcelain"], { cwd: cloneDir });
  if (!status.ok) {
    throw new Error(`github_local_uat_status_failed:${status.stderr.trim() || status.stdout.trim()}`);
  }
  if (status.stdout.trim()) {
    throw new Error(`github_local_uat_workspace_dirty:${cloneDir}`);
  }
  const base = `origin/${selection.defaultBranch}`;
  const checkout = await runGit(["checkout", "-B", branch, base], { cwd: cloneDir });
  if (!checkout.ok) {
    throw new Error(`github_local_uat_checkout_failed:${redactGitHubSecrets(checkout.stderr.trim() || checkout.stdout.trim())}`);
  }
  return { workspaceDir: dir, cloneDir, cloneUrl };
}

async function resolveCloneUrl({ selection, runGit } = {}) {
  if (selection.checkoutPath) {
    const remote = await runGit(["remote", "get-url", "origin"], {
      cwd: selection.checkoutPath,
      operation: "git_read",
    });
    const url = remote.ok ? remote.stdout.trim() : "";
    if (url) {
      const parsed = parseGitHubRemoteUrl(url);
      if (!parsed || parsed.owner !== selection.owner || parsed.repo !== selection.repo) {
        throw new GitHubLocalUatUserError(
          `GitHub local UAT origin remote drift: expected ${selection.owner}/${selection.repo}, got ${parsed?.owner || "unknown"}/${parsed?.repo || "unknown"}. Run npm run doctor and repair origin before UAT.`,
          "github_origin_remote_drift",
        );
      }
      return url;
    }
  }
  if (selection.pushAuth === "ssh") {
    throw new GitHubLocalUatUserError(
      "GitHub local UAT SSH mode requires an origin remote in the repo root.",
      "github_clone_url_required",
    );
  }
  return `https://github.com/${selection.owner}/${selection.repo}.git`;
}

function writeGitHubLocalUatProposal({ cloneDir, runId, branch, prBody }) {
  const relativePath = `execution/evals/decomposition/proposals/${runId}.md`;
  const absolutePath = path.join(cloneDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, [
    "# GitHub Local Ambient UAT",
    "",
    `Run: ${runId}`,
    `Branch: ${branch}`,
    "",
    "This disposable proposal proves the behavior repo GitHub write path uses local ambient git/gh auth.",
    "",
    prBody,
    "",
  ].join("\n"), "utf8");
  return relativePath;
}

async function commitGitHubLocalUatProposal({ cloneDir, proposalPath, runId, runGit }) {
  const add = await runGit(["add", "--", proposalPath], { cwd: cloneDir });
  if (!add.ok) throw new Error(`github_local_uat_git_add_failed:${add.stderr.trim() || add.stdout.trim()}`);
  const commit = await runGit(
    [
      "-c",
      "user.name=teami[bot] (uat)",
      "-c",
      "user.email=teami-uat@placeholder.invalid",
      "commit",
      "-m",
      `GitHub local UAT ${runId}`,
    ],
    { cwd: cloneDir },
  );
  if (!commit.ok) throw new Error(`github_local_uat_git_commit_failed:${commit.stderr.trim() || commit.stdout.trim()}`);
  const sha = await runGit(["rev-parse", "HEAD"], { cwd: cloneDir });
  if (!sha.ok || !sha.stdout.trim()) throw new Error("github_local_uat_commit_sha_missing");
  return sha.stdout.trim();
}

async function pushGitHubLocalUatBranch({
  cloneDir,
  owner,
  repo,
  branch,
  checkoutPath = null,
  pushAuth = "https",
  env = process.env,
  runGit,
} = {}) {
  if (!cloneDir) return { ok: false, reason: "promotion_workspace_required" };
  const ref = validatePromotionBranchRef(branch);
  if (!ref.ok) return { ok: false, reason: ref.reason };

  const normalizedPushAuth = pushAuth === "ssh" ? "ssh" : "https";
  let pushUrl = null;
  let remoteSource = null;
  if (checkoutPath) {
    const remote = await runGit(["remote", "get-url", "--push", "origin"], {
      cwd: checkoutPath,
      operation: "git_read",
    });
    pushUrl = remote.ok ? remote.stdout.trim() : null;
    if (pushUrl) remoteSource = "origin_push_remote";
  }
  if (!pushUrl && normalizedPushAuth === "ssh") {
    return {
      ok: false,
      reason: "github_push_url_required",
      detail: "SSH push mode requires a configured origin push remote in the adopter checkout.",
    };
  }
  if (!pushUrl) {
    if (!owner || !repo) return { ok: false, reason: "github_push_identity_required" };
    pushUrl = `https://github.com/${owner}/${repo}.git`;
    remoteSource = "github_https_fallback";
  }

  const result = await runGit(
    ["push", pushUrl, `${ref.full_ref}:${ref.full_ref}`],
    {
      cwd: cloneDir,
      env: scrubGitHubAuthEnv(env, { pushAuth: normalizedPushAuth }),
      exactEnv: true,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reconciliationRequired
        ? "github_promotion_branch_push_reconciliation_required"
        : "github_promotion_branch_push_failed",
      detail: result.stderr.trim() || "Git push failed; captured output was redacted.",
      reconciliation_required: result.reconciliationRequired === true,
    };
  }
  return {
    ok: true,
    pushed: true,
    dry_run: false,
    branch,
    ref: ref.full_ref,
    remote: pushUrl,
    remote_source: remoteSource,
    push_auth: normalizedPushAuth,
  };
}

async function cleanupGitHubLocalUatArtifacts({
  keepArtifacts,
  owner,
  repo,
  prNumber,
  branch,
  cwd,
  env,
  pushAuth,
  runCommand,
} = {}) {
  if (keepArtifacts) {
    return { skipped: true, reason: "keep_artifacts", prNumber, branch };
  }
  const closed = await runGhApi({
    cwd,
    env,
    pushAuth,
    runCommand,
    args: [
      "--method",
      "PATCH",
      `repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${encodePathSegment(prNumber)}`,
      "--input",
      "-",
    ],
    input: JSON.stringify({ state: "closed" }),
    parseJson: true,
  });
  const deleted = await runGhApi({
    cwd,
    env,
    pushAuth,
    runCommand,
    args: [
      "--method",
      "DELETE",
      `repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/git/refs/heads/${branch}`,
    ],
    parseJson: false,
  });
  return {
    skipped: false,
    ok: closed.ok && deleted.ok,
    closed_pr: closed.ok,
    deleted_branch: deleted.ok,
    prNumber,
    branch,
  };
}

async function runGhApi({
  cwd,
  env,
  pushAuth,
  runCommand,
  args,
  input = null,
  parseJson = true,
} = {}) {
  const result = await runCommand("gh", [
    "api",
    "--hostname",
    "github.com",
    ...GH_API_HEADERS,
    ...args,
  ], {
    cwd,
    env: ghCommandEnv({ env, pushAuth }),
    input,
  });
  if (!result.ok) {
    const error = new Error(
      result.reconciliationRequired
        ? "github_local_uat_mutation_reconciliation_required"
        : redactGitHubSecrets(result.stderr.trim() || result.stdout.trim() || "GitHub API command failed"),
    );
    error.outcome = result.outcome || "failed";
    error.reconciliation_required = result.reconciliationRequired === true;
    throw error;
  }
  return {
    ok: true,
    data: parseJson && result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function buildGitHubLocalUatRunEvidence({
  runId,
  startedAt,
  completedAt,
  selection,
  repoIdentity,
  branch,
  commitSha,
  proposalPath,
  push,
  pr,
  prProvenance,
  commands,
  transportCalls = [],
  logs,
} = {}) {
  const terminalOutput = {
    run_id: runId,
    outcome: "commit",
    reason: "github_local_uat_pr_created",
    context_digest: "GitHub local UAT opened a disposable PR with local ambient auth.",
    source_refs: [{ kind: "github_pull_request", id: String(pr.number), url: pr.html_url }],
    assumptions: [],
    constraints: ["local_ambient_git_gh_auth", "github_secret_hygiene_scan_passed"],
    risks: ["Live GitHub side effects are disposable and cleaned up unless --keep-artifacts is set."],
  };
  return {
    kind: "commit",
    run_id: runId,
    domain_id: "github-local-uat",
    workspace_id: "github-local-uat",
    team_id: "behavior-repo",
    function_version: "github-local-uat/v1",
    workflow_version: "github-local-uat/v1",
    runtime_assignments: {
      uat: { runtime: "node" },
    },
    runtime_metadata: {
      uat: {
        runtime_name: "github-local-uat",
        github_mode: selection.mode,
        push_auth: selection.pushAuth,
      },
    },
    terminal_output: terminalOutput,
    evidence: {
      perspectives_run: [],
      tool_events: commands,
      evidence_unavailable: [],
    },
    bounds: { rounds_used: 1, max_rounds: 1 },
    payload_schema_id: GITHUB_LOCAL_UAT_RUN_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: terminalOutput,
      pr_provenance: prProvenance,
      github_selection: safeGitHubSelection(selection),
      repo_identity: {
        source: repoIdentity.source,
        connection_mode: repoIdentity.connection_mode,
        repo: repoIdentity.repo,
        default_branch: repoIdentity.default_branch,
        push_auth: repoIdentity.push_auth,
        real_push_enabled: repoIdentity.real_push_enabled,
      },
      branch,
      commit_sha: commitSha,
      proposal_path: proposalPath,
      push,
      pr: {
        number: pr.number,
        url: pr.html_url,
        title: pr.title ?? null,
        state: pr.state ?? null,
        head_ref: pr.head?.ref ?? pr.head_ref ?? null,
      },
      command_summaries: commands,
      transport_calls: transportCalls,
      logs,
      leak_scan: null,
    },
    accepted_refs: [],
    completed_at: completedAt,
    execution_mode: "live",
    started_at: startedAt,
  };
}

function buildGitHubLocalUatPrProvenance({
  runId,
  branch,
  startedAt,
  selection,
} = {}) {
  return {
    schema_version: "teami-pr-provenance/v1",
    source_run_id: runId,
    experiment_receipt_id: `github-local-uat:${runId}`,
    phoenix_experiment_id: runId,
    proposal_instance_id: `prop-${sha256Hex(runId).slice(0, 12)}`,
    normalized_envelope_hash: sha256Hex(`${runId}:${branch}`),
    candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
    produced_at: startedAt,
    github_auth_mode: selection.mode,
    github_owner: selection.owner,
    github_repo: selection.repo,
    default_branch: selection.defaultBranch,
    checkout_path: selection.checkoutPath,
    push_auth: selection.pushAuth,
    real_push_enabled: selection.realPushEnabled,
  };
}

function safeGitHubSelection(selection = {}) {
  return {
    mode: selection.mode,
    transport_kind: selection.transport?.kind ?? null,
    owner: selection.owner,
    repo: selection.repo,
    defaultBranch: selection.defaultBranch,
    checkoutPath: selection.checkoutPath,
    pushAuth: selection.pushAuth,
    realPushEnabled: selection.realPushEnabled,
  };
}

function createRecordingRunGit({ runGit, records }) {
  return async (args, options = {}) => {
    const result = await runGit(args, options);
    records.push({
      tool: "git",
      args: args.map(String),
      cwd: options.cwd ?? null,
      ok: result.ok,
      status: result.status ?? null,
      env: summarizeChildEnv(options.env),
      stderr: redactGitHubSecrets(result.stderr || ""),
      stdout: "",
    });
    return result;
  };
}

function createRecordingRunCommand({ runCommand, records }) {
  return async (command, args, options = {}) => {
    const result = await runCommand(command, args, options);
    records.push({
      tool: command,
      args: args.map(String),
      cwd: options.cwd ?? null,
      ok: result.ok,
      status: result.status ?? null,
      env: summarizeChildEnv(options.env),
      stderr: redactGitHubSecrets(result.stderr || ""),
      stdout: "",
    });
    return result;
  };
}

function summarizeChildEnv(env = null) {
  if (!env || typeof env !== "object") return null;
  const names = Object.keys(env).sort();
  const githubAuthNames = names.filter((name) =>
    /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|TEAMI_GITHUB_|GITHUB_ACCESS_TOKEN|GITHUB_PAT|GIT_ASKPASS)$/i.test(name));
  return {
    key_count: names.length,
    github_auth_env_names_present: githubAuthNames,
    gh_prompt_disabled: env.GH_PROMPT_DISABLED ?? null,
    git_terminal_prompt: env.GIT_TERMINAL_PROMPT ?? null,
    ssh_auth_sock_present: Object.hasOwn(env, "SSH_AUTH_SOCK"),
  };
}

function defaultRunCommand(command, args, { cwd, env, input = null } = {}) {
  if (command !== "gh") throw new Error(`github_local_uat_command_not_allowed:${command}`);
  return runBoundedSubprocess({
    command,
    args,
    operation: githubOperationForArgs(args),
    cwd,
    env,
    input,
  });
}

function githubOperationForArgs(args = []) {
  if (args[0] === "auth") return "gh_auth_read";
  const methodIndex = args.indexOf("--method");
  const method = methodIndex >= 0 ? String(args[methodIndex + 1] || "GET").toUpperCase() : "GET";
  return ["GET", "HEAD"].includes(method) ? "gh_api_read" : "gh_api_mutation";
}

function ghCommandEnv({ env = process.env, pushAuth } = {}) {
  return {
    ...scrubGitHubAuthEnv(env, { pushAuth }),
    GH_PROMPT_DISABLED: "1",
  };
}

function validateGitHubLocalUatBranchPrefix(prefix) {
  if (typeof prefix !== "string" || prefix.trim() !== prefix || prefix.length === 0) {
    throw new GitHubLocalUatUserError("invalid github local UAT branch prefix", "usage");
  }
  githubLocalUatBranchName({ branchPrefix: prefix, stamp: "validate" });
  return true;
}

function uatStamp({ now = () => new Date() } = {}) {
  return now().toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(String(bytes)).digest("hex");
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new GitHubLocalUatUserError(`${flag} requires a value`, "usage");
  return value;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
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
    options = parseGitHubLocalUatArgs(argv);
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildGitHubLocalUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    const report = await runGitHubLocalUat({ ...options, onLog: stdout });
    stdout(`GITHUB LOCAL UAT PASS PR #${report.pr.number}: ${report.pr.url}`);
    if (report.cleanup?.skipped) {
      stdout(`Cleanup skipped: ${report.cleanup.reason}.`);
    } else {
      stdout(`Cleanup closed PR and deleted branch ${report.branch}.`);
    }
    exit(0);
    return { ok: true, report };
  } catch (error) {
    const message = error instanceof GitHubLocalUatUserError
      ? error.message
      : `GITHUB LOCAL UAT FAIL: ${error?.message || String(error)}`;
    stderr(redactGitHubSecrets(message));
    const read = readGitHubConnectionState({ repoRoot: options.repoRoot });
    if (!read.ok) stderr(`GitHub connection state: ${read.reason}`);
    exit(error instanceof GitHubLocalUatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "run", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(redactGitHubSecrets(`GITHUB LOCAL UAT FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
