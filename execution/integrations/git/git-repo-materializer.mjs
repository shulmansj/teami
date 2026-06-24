import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerResourceKind } from "../../engine/resource-registry.mjs";

const REQUIRED_GIT_REPO_BINDING_FIELDS = Object.freeze([
  "owner",
  "repo",
  "default_branch",
  "local_checkout_path",
]);

export function defaultRunGit(args, { cwd, env } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
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

export async function materializeGitRepo(resource, runContext = {}) {
  validateGitRepoBinding(resource?.binding);

  const runGit = runContext?.runGit ?? defaultRunGit;
  const source = path.resolve(resource.binding.local_checkout_path);
  const defaultBranch = resource.binding.default_branch;
  const workingDir = gitRepoWorkingDir({ resource, runContext });

  const status = runGit(["status", "--porcelain"], { cwd: source });
  if (!status.ok) {
    throw gitCommandError("git_repo_source_status_failed", status);
  }
  if (status.stdout.trim() !== "") {
    throw new Error("git_repo_source_dirty");
  }

  let worktreeAdded = false;
  try {
    fs.mkdirSync(path.dirname(workingDir), { recursive: true });
    const add = runGit(["worktree", "add", "--detach", workingDir, defaultBranch], { cwd: source });
    worktreeAdded = add.ok;
    if (!add.ok) {
      throw gitCommandError("git_repo_worktree_add_failed", add);
    }

    const head = runGit(["rev-parse", "HEAD"], { cwd: workingDir });
    if (!head.ok) {
      throw gitCommandError("git_repo_base_sha_failed", head);
    }
    const baseSha = head.stdout.trim();
    if (baseSha === "") {
      throw new Error("git_repo_base_sha_missing");
    }

    let tornDown = false;
    return {
      kind: "git_repo",
      handle: {
        workingDir,
        baseSha,
      },
      async teardown() {
        if (tornDown) return;
        await cleanupWorktree({ runGit, source, workingDir });
        tornDown = true;
      },
    };
  } catch (error) {
    try {
      if (worktreeAdded || fs.existsSync(workingDir)) {
        await cleanupWorktree({ runGit, source, workingDir, requireGitWorktree: worktreeAdded });
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "git_repo_materialize_failed_with_cleanup_error",
      );
    }
    throw error;
  }
}

export function manifestGitRepoEntry(resource) {
  return {
    kind: "git_repo",
    id: resource.id,
    role: resource.role,
    label: `${resource.binding.owner}/${resource.binding.repo}`,
  };
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

function gitRepoWorkingDir({ resource, runContext }) {
  const workspaceRoot = path.join(os.tmpdir(), "agentic-factory", "resource-worktrees");
  const leaf = `${safePathSegment(resource.id ?? resource.kind)}-${randomBytes(4).toString("hex")}`;
  return path.join(
    workspaceRoot,
    safePathSegment(runContext?.runId ?? "adhoc-run"),
    leaf,
  );
}

function safePathSegment(value) {
  const segment = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || "resource";
}

async function cleanupWorktree({ runGit, source, workingDir, requireGitWorktree = true }) {
  const remove = runGit(["worktree", "remove", "--force", workingDir], { cwd: source });
  let rmError = null;
  try {
    fs.rmSync(workingDir, { recursive: true, force: true });
  } catch (error) {
    rmError = error;
  }

  if (!remove.ok && rmError) {
    throw new AggregateError(
      [gitCommandError("git_repo_worktree_remove_failed", remove), rmError],
      "git_repo_worktree_cleanup_failed",
    );
  }
  if (!remove.ok && requireGitWorktree) {
    throw gitCommandError("git_repo_worktree_remove_failed", remove);
  }
  if (rmError) throw rmError;
}

function gitCommandError(reason, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  return new Error(detail ? `${reason}:${detail}` : reason);
}
