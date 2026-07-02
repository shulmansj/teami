import fs from "node:fs";
import path from "node:path";

import { defaultRunGit } from "../../git/git-repo-materializer.mjs";
import { runRuntimeCommand } from "./runtime-command.mjs";

export const EXECUTION_PROFILE_PREFLIGHT_REASON_CODES = Object.freeze({
  CLONE_UNUSABLE: "clone_unusable",
  DEPS_INSTALL_FAILED: "deps_install_failed",
  NO_RUNNABLE_TEST_COMMAND: "no_runnable_test_command",
  BASELINE_TESTS_FAILED: "baseline_tests_failed",
  GIT_PUSH_AUTHORITY_MISSING: "git_push_authority_missing",
  GITHUB_API_AUTHORITY_MISSING: "github_api_authority_missing",
});

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NODE_TEST_FILE_PATTERN = /(?:^|[./\\])(?:test|tests)[/\\].+\.(?:cjs|mjs|js|ts|tsx|jsx)$|(?:^|[./\\]).+\.(?:test|spec)\.(?:cjs|mjs|js|ts|tsx|jsx)$/;

export async function runExecutionProfilePreflight({
  repoDir,
  resourceId,
  runCommand = runRuntimeCommand,
  runGit = defaultRunGit,
  strictBaselineGreen,
  skipReadiness = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  gitPushAuthorityProbe = defaultGitPushAuthorityProbe,
  githubApiAuthorityProbe = defaultGithubApiAuthorityProbe,
  remoteUrl = null,
  owner = null,
  repo = null,
} = {}) {
  const resource_id = nonEmptyString(resourceId) || null;
  const failures = [];
  const missing = [];
  const checks = [];
  const strict = strictBaselineGreen === true;
  const readinessSkipped = skipReadiness === true;
  const normalizedRepoDir = nonEmptyString(repoDir);

  if (!normalizedRepoDir || !directoryExists(normalizedRepoDir)) {
    addFailure(failures, missing, EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.CLONE_UNUSABLE, "repoDir");
    return redVerdict({ resource_id, failures, missing });
  }

  const packageRead = readinessSkipped ? null : readPackageJson(normalizedRepoDir);
  if (packageRead && !packageRead.ok) {
    const reason = packageRead.reason === "package_json_missing"
      ? EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.NO_RUNNABLE_TEST_COMMAND
      : EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.CLONE_UNUSABLE;
    addFailure(failures, missing, reason, packageRead.missing);
  }

  const plan = packageRead?.ok
    ? detectJavascriptPreflightPlan({ repoDir: normalizedRepoDir, packageJson: packageRead.packageJson })
    : null;

  if (!readinessSkipped && plan && !plan.testCommand) {
    addFailure(
      failures,
      missing,
      EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.NO_RUNNABLE_TEST_COMMAND,
      "package.json:scripts.test",
    );
  }

  const authority = await runAuthorityChecks({
    repoDir: normalizedRepoDir,
    resourceId: resource_id,
    runCommand,
    runGit,
    timeoutMs,
    gitPushAuthorityProbe,
    githubApiAuthorityProbe,
    remoteUrl,
    owner,
    repo,
  });
  checks.push(...authority.checks);
  for (const failure of authority.failures) {
    addFailure(failures, missing, failure.reason, failure.missing);
  }

  if (!readinessSkipped && plan?.setupCommand) {
    const setup = await runPreflightCommand({
      runCommand,
      command: plan.setupCommand,
      cwd: normalizedRepoDir,
      timeoutMs,
    });
    checks.push({
      name: "execution profile deps install",
      ok: setup.ok,
      message: setup.ok ? commandLabel(plan.setupCommand) : "dependency setup command failed",
      fix: setup.ok ? null : commandLabel(plan.setupCommand),
    });
    if (!setup.ok) {
      addFailure(
        failures,
        missing,
        EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.DEPS_INSTALL_FAILED,
        commandLabel(plan.setupCommand),
      );
    }
  }

  if (!readinessSkipped && strict && plan?.testCommand && failures.length === 0) {
    const testResult = await runPreflightCommand({
      runCommand,
      command: plan.testCommand,
      cwd: normalizedRepoDir,
      timeoutMs,
    });
    checks.push({
      name: "execution profile baseline tests",
      ok: testResult.ok,
      message: testResult.ok ? commandLabel(plan.testCommand) : "baseline test command failed",
      fix: testResult.ok ? null : commandLabel(plan.testCommand),
    });
    if (!testResult.ok) {
      addFailure(
        failures,
        missing,
        EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.BASELINE_TESTS_FAILED,
        commandLabel(plan.testCommand),
      );
    }
  }

  if (failures.length > 0) return redVerdict({ resource_id, failures, missing });
  return {
    ok: true,
    resource_id,
    strict_baseline_green: strict,
    ...(readinessSkipped ? { readiness_skipped: true } : {}),
    setup_command: plan?.setupCommand ? commandLabel(plan.setupCommand) : null,
    test_command: plan?.testCommand ? commandLabel(plan.testCommand) : null,
    checks,
  };
}

function readPackageJson(repoDir) {
  const packagePath = path.join(repoDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return {
      ok: false,
      reason: "package_json_missing",
      missing: "package.json",
    };
  }
  try {
    return {
      ok: true,
      packageJson: JSON.parse(fs.readFileSync(packagePath, "utf8")),
    };
  } catch {
    return {
      ok: false,
      reason: "package_json_unreadable",
      missing: "package.json",
    };
  }
}

function detectJavascriptPreflightPlan({ repoDir, packageJson }) {
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const setupScript = nonEmptyString(scripts.setup);
  const testScript = nonEmptyString(scripts.test);
  return {
    setupCommand: setupScript
      ? { command: "npm", args: ["run", "setup"] }
      : defaultInstallCommand(repoDir),
    testCommand: runnableTestCommand({ repoDir, testScript }),
  };
}

function defaultInstallCommand(repoDir) {
  return fs.existsSync(path.join(repoDir, "package-lock.json"))
    ? { command: "npm", args: ["ci"] }
    : { command: "npm", args: ["install"] };
}

function runnableTestCommand({ repoDir, testScript }) {
  if (testScript && !isNpmInitPlaceholderTest(testScript)) {
    return { command: "npm", args: ["test"] };
  }
  if (hasNodeTestFiles(repoDir)) {
    return { command: "node", args: ["--test"] };
  }
  return null;
}

function isNpmInitPlaceholderTest(script) {
  return /^echo\s+["']?Error:\s+no\s+test\s+specified["']?\s*(?:&&|;)\s*exit\s+1$/i.test(script.trim());
}

function hasNodeTestFiles(repoDir) {
  const stack = [repoDir];
  let visited = 0;
  while (stack.length > 0 && visited < 500) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(repoDir, fullPath);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (NODE_TEST_FILE_PATTERN.test(relativePath.replace(/\\/g, "/"))) {
        return true;
      }
    }
  }
  return false;
}

async function runAuthorityChecks({
  repoDir,
  resourceId,
  runCommand,
  runGit,
  timeoutMs,
  gitPushAuthorityProbe,
  githubApiAuthorityProbe,
  remoteUrl,
  owner,
  repo,
}) {
  const checks = [];
  const failures = [];
  const gitPush = await runProbe(() => gitPushAuthorityProbe({
    repoDir,
    resourceId,
    runGit,
    remoteUrl,
    timeoutMs,
  }));
  checks.push({
    name: "git-push-authority",
    ok: gitPush.ok,
    message: gitPush.ok ? "git push authority available" : "git push authority unavailable",
    fix: gitPush.ok ? null : "restore git credential helper authority for this repo",
  });
  if (!gitPush.ok) {
    failures.push({
      reason: EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.GIT_PUSH_AUTHORITY_MISSING,
      missing: gitPush.missing || "git push --dry-run",
    });
  }

  const githubApi = await runProbe(() => githubApiAuthorityProbe({
    repoDir,
    resourceId,
    runCommand,
    timeoutMs,
    owner,
    repo,
    remoteUrl,
  }));
  checks.push({
    name: "GitHub-API-authority",
    ok: githubApi.ok,
    message: githubApi.ok ? "GitHub API authority available" : "GitHub API authority unavailable",
    fix: githubApi.ok ? null : "restore gh authentication/API scope for this repo",
  });
  if (!githubApi.ok) {
    failures.push({
      reason: EXECUTION_PROFILE_PREFLIGHT_REASON_CODES.GITHUB_API_AUTHORITY_MISSING,
      missing: githubApi.missing || "gh api",
    });
  }
  return { checks, failures };
}

async function defaultGitPushAuthorityProbe({ repoDir, runGit, remoteUrl }) {
  const targetRemote = nonEmptyString(remoteUrl) || gitRemoteFromOrigin({ repoDir, runGit });
  if (!targetRemote) return { ok: false, missing: "git remote" };
  const result = runGit([
    "push",
    "--dry-run",
    targetRemote,
    "HEAD:refs/heads/af-preflight-readiness",
  ], {
    cwd: repoDir,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result?.ok === true, missing: "git push --dry-run" };
}

async function defaultGithubApiAuthorityProbe({
  repoDir,
  runCommand,
  timeoutMs,
  owner,
  repo,
  remoteUrl,
}) {
  const identity = repoIdentity({ owner, repo, remoteUrl });
  const args = identity
    ? ["api", `repos/${identity.owner}/${identity.repo}`]
    : ["auth", "status"];
  const result = await runPreflightCommand({
    runCommand,
    command: { command: "gh", args },
    cwd: repoDir,
    timeoutMs,
  });
  return { ok: result.ok, missing: identity ? "gh api repos/{owner}/{repo}" : "gh auth status" };
}

function gitRemoteFromOrigin({ repoDir, runGit }) {
  const result = runGit(["remote", "get-url", "origin"], { cwd: repoDir });
  if (!result?.ok) return null;
  return nonEmptyString(result.stdout);
}

async function runProbe(probe) {
  try {
    const result = await probe();
    if (result === true) return { ok: true };
    if (result === false || result === null || result === undefined) return { ok: false };
    return {
      ok: result.ok === true,
      missing: nonEmptyString(result.missing) || null,
    };
  } catch (error) {
    return {
      ok: false,
      missing: nonEmptyString(error?.missing) || null,
    };
  }
}

async function runPreflightCommand({ runCommand, command, cwd, timeoutMs }) {
  try {
    await runCommand(command, { cwd, timeoutMs });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function redVerdict({ resource_id, failures, missing }) {
  const failure_reasons = uniqueSorted(failures);
  return {
    ok: false,
    resource_id,
    failure_signature_seed: {
      reason_codes: failure_reasons,
      missing: uniqueSorted(missing),
    },
    failure_reasons,
  };
}

function addFailure(failures, missing, reason, missingValue) {
  failures.push(reason);
  if (Array.isArray(missingValue)) {
    missing.push(...missingValue.map((value) => String(value || "").trim()).filter(Boolean));
  } else if (missingValue) {
    missing.push(String(missingValue).trim());
  }
}

function commandLabel(command) {
  return [command.command, ...(command.args || [])].join(" ");
}

function repoIdentity({ owner, repo, remoteUrl }) {
  const explicitOwner = nonEmptyString(owner);
  const explicitRepo = nonEmptyString(repo);
  if (explicitOwner && explicitRepo) return { owner: explicitOwner, repo: explicitRepo };
  const parsed = parseGithubRemoteUrl(remoteUrl);
  return parsed;
}

function parseGithubRemoteUrl(remoteUrl) {
  const text = nonEmptyString(remoteUrl);
  if (!text) return null;
  const match = text.match(/github\.com[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
  };
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
