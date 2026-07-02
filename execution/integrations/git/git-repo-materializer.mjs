import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerResourceKind } from "../../engine/resource-registry.mjs";
import { branchNameForIssue } from "./git-branch-names.mjs";

const REQUIRED_GIT_REPO_BINDING_FIELDS = Object.freeze([
  "owner",
  "repo",
  "default_branch",
]);

export function defaultRunGit(args, { cwd, env, exactEnv = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: env ? normalizeEnv(exactEnv ? env : { ...process.env, ...env }) : process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function validateGitRepoBinding(binding) {
  for (const field of REQUIRED_GIT_REPO_BINDING_FIELDS) {
    if (typeof binding?.[field] !== "string" || binding[field].trim() === "") {
      throw new Error(`git_repo_binding_missing_${field}`);
    }
  }
}

export function gitRepoResourceId(binding) {
  const owner = typeof binding?.owner === "string" ? binding.owner.trim() : "";
  const repo = typeof binding?.repo === "string" ? binding.repo.trim() : "";
  if (owner === "") throw new Error("git_repo_resource_id_missing_owner");
  if (repo === "") throw new Error("git_repo_resource_id_missing_repo");
  return `git_repo:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function gitRepoRemoteUrl(binding) {
  const owner = typeof binding?.owner === "string" ? binding.owner.trim() : "";
  const repo = typeof binding?.repo === "string" ? binding.repo.trim() : "";
  if (owner === "") throw new Error("git_repo_remote_url_missing_owner");
  if (repo === "") throw new Error("git_repo_remote_url_missing_repo");
  return `https://github.com/${owner}/${repo}.git`;
}

export function gitRepoDisplayLabel(resource) {
  return `${resource.binding.owner}/${resource.binding.repo}`;
}

export async function materializeGitRepo(resource, runContext = {}) {
  validateGitRepoBinding(resource?.binding);

  const runGit = runContext?.runGit ?? defaultRunGit;
  const repoIdentity = repoIdentityFromBinding(resource.binding);
  const remoteUrl = resolveGitRepoRemoteUrl({ resource, repoIdentity, runContext });
  const defaultBranch = repoIdentity.default_branch;
  const paths = gitRepoMaterializationPaths({ resource, runContext });
  const envAugment = gitRepoWorkerEnvAugment(paths);
  const containedGitEnv = sanitizedGitProcessEnv(process.env, envAugment);
  const gitOptions = (cwd) => ({ cwd, env: containedGitEnv, exactEnv: true });
  const ambientGitEnv = gitRepoAmbientAuthEnv(process.env);
  const ambientGitOptions = (cwd) => ({ cwd, env: ambientGitEnv, exactEnv: true });

  try {
    prepareGitContainmentPaths(paths);
    const resumeIntent = issueBranchResumeIntent(runContext, resource);

    const clone = runGit([
      "clone",
      "--depth=1",
      "--branch",
      defaultBranch,
      "--single-branch",
      "--no-tags",
      "--no-checkout",
      "--template",
      paths.templateDir,
      remoteUrl,
      paths.workingDir,
    ], ambientGitOptions(paths.runDir));
    if (!clone.ok) {
      throw gitCommandError("git_repo_clone_failed", clone);
    }

    const baseSha = resolveClonedDefaultBranchSha({
      defaultBranch,
      workingDir: paths.workingDir,
      runGit,
      gitOptions,
    });

    const resumeCheckout = resumeIntent
      ? fetchOwnedIssueBranchHead({
          intent: resumeIntent,
          remoteUrl,
          workingDir: paths.workingDir,
          runGit,
          gitOptions: ambientGitOptions,
        })
      : null;

    removeAllRemotes({ runGit, workingDir: paths.workingDir, gitOptions });
    neutralizeRepoLocalConfig({
      runGit,
      workingDir: paths.workingDir,
      hooksPath: paths.hooksPath,
      gitOptions,
    });

    const checkoutTarget = resumeCheckout?.headSha || baseSha;
    const checkout = resumeCheckout
      ? runGit(["checkout", "-B", resumeCheckout.branch, checkoutTarget], gitOptions(paths.workingDir))
      : runGit(["checkout", "--detach", checkoutTarget], gitOptions(paths.workingDir));
    if (!checkout.ok) {
      throw gitCommandError("git_repo_checkout_failed", checkout);
    }

    const head = runGit(["rev-parse", "HEAD"], gitOptions(paths.workingDir));
    if (!head.ok) {
      throw gitCommandError("git_repo_base_sha_failed", head);
    }
    const checkedOutSha = head.stdout.trim();
    if (checkedOutSha !== checkoutTarget) {
      throw new Error(resumeCheckout ? "git_repo_issue_branch_head_mismatch" : "git_repo_base_sha_mismatch");
    }

    let tornDown = false;
    return {
      kind: "git_repo",
      handle: {
        workingDir: paths.workingDir,
        baseSha,
        remoteUrl,
        envAugment,
        ...repoIdentity,
      },
      async teardown() {
        if (tornDown) return;
        fs.rmSync(paths.runDir, { recursive: true, force: true });
        removeEmptyRunIdDir(paths.runDir);
        tornDown = true;
      },
    };
  } catch (error) {
    try {
      fs.rmSync(paths.runDir, { recursive: true, force: true });
      removeEmptyRunIdDir(paths.runDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "git_repo_materialize_failed_with_cleanup_error",
      );
    }
    throw error;
  }
}

function repoIdentityFromBinding(binding) {
  return {
    owner: binding.owner.trim(),
    repo: binding.repo.trim(),
    default_branch: binding.default_branch.trim(),
  };
}

export function resolveGitRepoRemoteUrl({ resource, repoIdentity, runContext = {} } = {}) {
  if (typeof runContext.resolveGitRemoteUrl === "function") {
    const resolved = nonEmptyString(runContext.resolveGitRemoteUrl({
      resource,
      binding: resource?.binding,
      repoIdentity,
    }));
    if (resolved) return resolved;
  }

  const overrides = runContext.gitRemoteUrlOverrides;
  if (overrides && typeof overrides === "object") {
    const keys = [
      resource?.id,
      `${repoIdentity.owner}/${repoIdentity.repo}`,
      gitRepoResourceId(repoIdentity),
    ].filter(Boolean);
    for (const key of keys) {
      const resolved = nonEmptyString(overrides[key]);
      if (resolved) return resolved;
    }
  }

  return nonEmptyString(runContext.gitRemoteUrlOverride) || gitRepoRemoteUrl(repoIdentity);
}

function resolveClonedDefaultBranchSha({
  defaultBranch,
  workingDir,
  runGit,
  gitOptions,
}) {
  const probes = [
    `refs/heads/${defaultBranch}^{commit}`,
    `refs/remotes/origin/${defaultBranch}^{commit}`,
    `${defaultBranch}^{commit}`,
    "HEAD^{commit}",
  ];
  let lastResult = null;
  for (const ref of probes) {
    const result = runGit(["rev-parse", "--verify", ref], gitOptions(workingDir));
    if (result.ok && result.stdout.trim() !== "") return result.stdout.trim();
    lastResult = result;
  }
  throw gitCommandError("git_repo_base_sha_failed", lastResult || { stdout: "", stderr: "" });
}

function issueBranchResumeIntent(runContext = {}, resource = null) {
  const issueIdentifier = nonEmptyString(runContext.issueIdentifier) || nonEmptyString(runContext.issue?.identifier);
  if (!issueIdentifier) return null;
  const pending = runContext.pendingGitIntent || null;
  const git = pending?.git || null;
  if (!git) return null;
  const resourceId = nonEmptyString(git.resource_id);
  if (resourceId && resourceId !== resource?.id) return null;
  const branch = branchNameForIssue(issueIdentifier);
  if (git.branch !== branch) return null;
  const headSha = nonEmptyString(git.head_sha);
  const treeSha = nonEmptyString(git.tree_sha);
  if (!headSha) return null;
  return { branch, headSha, treeSha };
}

function fetchOwnedIssueBranchHead({
  intent,
  remoteUrl,
  workingDir,
  runGit,
  gitOptions,
}) {
  const fetch = runGit([
    "fetch",
    "--depth=1",
    "--no-tags",
    remoteUrl,
    `refs/heads/${intent.branch}`,
  ], gitOptions(workingDir));
  if (!fetch.ok) throw gitCommandError("git_repo_issue_branch_fetch_failed", fetch);

  const head = runGit(["rev-parse", "FETCH_HEAD^{commit}"], gitOptions(workingDir));
  if (!head.ok) throw gitCommandError("git_repo_issue_branch_head_probe_failed", head);
  const headSha = head.stdout.trim();
  const tree = runGit(["rev-parse", "FETCH_HEAD^{tree}"], gitOptions(workingDir));
  if (!tree.ok) throw gitCommandError("git_repo_issue_branch_tree_probe_failed", tree);
  const treeSha = tree.stdout.trim();
  if (headSha !== intent.headSha || (intent.treeSha && treeSha !== intent.treeSha)) {
    throw new Error("git_repo_remote_branch_not_owned");
  }
  return { branch: intent.branch, headSha, treeSha };
}

// Remove the now-empty per-run wrapper dir (workspaceRoot/<runId>) after a
// run's clone (workspaceRoot/<runId>/<leaf>) is torn down, so empty wrappers
// don't accumulate under a long-lived gateway. Only removes it when empty — a
// sibling resource clone under the same run keeps it alive (rmdir throws on
// non-empty, which we swallow).
function removeEmptyRunIdDir(runDir) {
  try {
    fs.rmdirSync(path.dirname(runDir));
  } catch {
    // non-empty (sibling resources) or already gone — leave it.
  }
}

export function manifestGitRepoEntry(resource) {
  return {
    kind: "git_repo",
    id: resource.id,
    role: resource.role,
    label: gitRepoDisplayLabel(resource),
  };
}

export const GIT_REPO_WORKER_ENV_DELETE_NAMES = Object.freeze([
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

export function gitRepoWorkerEnvAugment(paths = {}) {
  return {
    HOME: paths.homeDir,
    USERPROFILE: paths.homeDir,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.globalConfigPath,
    GIT_TEMPLATE_DIR: paths.templateDir,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function gitRepoAmbientAuthEnv(baseEnv = process.env) {
  return normalizeEnv({ ...(baseEnv || {}), GIT_TERMINAL_PROMPT: "0" });
}

export function sanitizedGitProcessEnv(baseEnv = process.env, envAugment = {}) {
  const env = normalizeEnv({ ...(baseEnv || {}), ...(envAugment || {}) });
  for (const key of Object.keys(env)) {
    if (GIT_REPO_WORKER_ENV_DELETE_NAMES.includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  return env;
}

export const gitRepoResourceKind = Object.freeze({
  kind: "git_repo",
  validateBinding: validateGitRepoBinding,
  materialize: materializeGitRepo,
  manifestEntry: manifestGitRepoEntry,
});

export function registerGitRepoResourceKind() {
  registerResourceKind(gitRepoResourceKind);
}

function gitRepoMaterializationPaths({ resource, runContext }) {
  const workspaceRoot = path.join(os.tmpdir(), "teami", "resource-clones");
  const leaf = `${safePathSegment(resource.id ?? resource.kind)}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(
    workspaceRoot,
    safePathSegment(runContext?.runId ?? "adhoc-run"),
    leaf,
  );
  const envDir = path.join(runDir, "git-env");
  return {
    runDir,
    workingDir: path.join(runDir, "checkout"),
    envDir,
    homeDir: path.join(envDir, "home"),
    xdgConfigHome: path.join(envDir, "xdg"),
    templateDir: path.join(envDir, "template"),
    hooksPath: path.join(envDir, "empty-hooks"),
    globalConfigPath: path.join(envDir, "gitconfig"),
  };
}

function safePathSegment(value) {
  const segment = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || "resource";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function prepareGitContainmentPaths(paths) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.mkdirSync(paths.homeDir, { recursive: true });
  fs.mkdirSync(paths.xdgConfigHome, { recursive: true });
  fs.mkdirSync(paths.templateDir, { recursive: true });
  fs.mkdirSync(paths.hooksPath, { recursive: true });
  fs.writeFileSync(paths.globalConfigPath, "", { encoding: "utf8" });
}

function removeAllRemotes({ runGit, workingDir, gitOptions }) {
  const remotes = runGit(["remote"], gitOptions(workingDir));
  if (!remotes.ok) {
    throw gitCommandError("git_repo_remote_list_failed", remotes);
  }
  for (const remote of remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const removed = runGit(["remote", "remove", remote], gitOptions(workingDir));
    if (!removed.ok) {
      throw gitCommandError("git_repo_remote_remove_failed", removed);
    }
  }
}

function neutralizeRepoLocalConfig({ runGit, workingDir, hooksPath, gitOptions }) {
  runGit(["config", "--local", "--unset-all", "credential.helper"], gitOptions(workingDir));
  const credentialReset = runGit(["config", "--local", "--replace-all", "credential.helper", ""], gitOptions(workingDir));
  if (!credentialReset.ok) {
    throw gitCommandError("git_repo_credential_helper_reset_failed", credentialReset);
  }

  runGit(["config", "--local", "--unset-all", "http.extraHeader"], gitOptions(workingDir));
  const insteadOfKeys = runGit(
    ["config", "--local", "--name-only", "--get-regexp", "^url\\..*\\.insteadOf$"],
    gitOptions(workingDir),
  );
  if (insteadOfKeys.ok) {
    for (const key of insteadOfKeys.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      runGit(["config", "--local", "--unset-all", key], gitOptions(workingDir));
    }
  }

  const hooksOff = runGit(["config", "--local", "--replace-all", "core.hooksPath", hooksPath], gitOptions(workingDir));
  if (!hooksOff.ok) {
    throw gitCommandError("git_repo_hooks_path_reset_failed", hooksOff);
  }
}

function gitCommandError(reason, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  return new Error(detail ? `${reason}:${detail}` : reason);
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}
