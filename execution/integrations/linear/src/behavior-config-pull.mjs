import fs from "node:fs";
import path from "node:path";

import { runBoundedGit } from "../../git/bounded-subprocess.mjs";
import {
  gitRemoteAuthEnv,
  resolveAmbientGitHubToken,
  resolveGhCliToken,
} from "../../git/git-remote-auth.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";
import { readGitHubConnectionState } from "./github-setup.mjs";

export const BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH = path.posix.join(
  "execution",
  "integrations",
  "linear",
  "src",
  "behavior-config.overrides.json",
);

export async function syncBehaviorConfigOverrides({
  home = resolveTeamiHome(),
  repoRoot = null,
  remoteUrl = null,
  ref = null,
  overridesRelativePath = BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
  runGit = runBoundedGit,
  readConnectionState = readGitHubConnectionState,
  processEnv = process.env,
  resolveGhToken = resolveGhCliToken,
} = {}) {
  const target = resolveBehaviorConfigRemote({
    home,
    repoRoot,
    remoteUrl,
    ref,
    readConnectionState,
  });
  if (!target.ok) return target;

  const paths = behaviorMirrorPaths({ home });
  fs.mkdirSync(paths.parentDir, { recursive: true, mode: 0o700 });
  fs.rmSync(paths.nextDir, { recursive: true, force: true });

  const ambientToken = resolveAmbientGitHubToken(processEnv);
  const ghToken = ambientToken || (typeof resolveGhToken === "function"
    ? await resolveGhToken({ cwd: repoRoot || paths.parentDir })
    : null);
  const env = gitRemoteAuthEnv({
    baseEnv: { GIT_TERMINAL_PROMPT: "0" },
    remoteUrl: target.remoteUrl,
    processEnv,
    token: ghToken,
  });

  try {
    const clone = await runGit([
      "clone",
      "--depth=1",
      "--branch",
      target.ref,
      "--single-branch",
      "--no-tags",
      target.remoteUrl,
      paths.nextDir,
    ], { cwd: paths.parentDir, env });
    if (!clone.ok) throw gitCommandError("behavior_config_clone_failed", clone);

    const head = await runGit(["rev-parse", "HEAD"], {
      cwd: paths.nextDir,
      env,
      operation: "git_read",
    });
    if (!head.ok) throw gitCommandError("behavior_config_head_failed", head);
    const commit = head.stdout.trim();

    const overridesPath = path.resolve(paths.nextDir, ...overridesRelativePath.split(/[\\/]+/));
    const overrides = fs.existsSync(overridesPath)
      ? readOverridesJson(overridesPath)
      : null;

    fs.rmSync(paths.mirrorDir, { recursive: true, force: true });
    fs.renameSync(paths.nextDir, paths.mirrorDir);

    return {
      ok: true,
      commit,
      mirrorDir: paths.mirrorDir,
      overridesPath: path.resolve(paths.mirrorDir, ...overridesRelativePath.split(/[\\/]+/)),
      overrides,
    };
  } catch (error) {
    try {
      fs.rmSync(paths.nextDir, { recursive: true, force: true });
    } catch {
      // Cleanup cannot hide the pull failure.
    }
    throw error;
  }
}

export function readCachedBehaviorConfigOverrides({
  home = resolveTeamiHome(),
  overridesRelativePath = BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
} = {}) {
  const paths = behaviorMirrorPaths({ home });
  if (!fs.existsSync(paths.mirrorDir)) return { ok: false, reason: "behavior_config_cache_missing" };
  const overridesPath = path.resolve(paths.mirrorDir, ...overridesRelativePath.split(/[\\/]+/));
  const overrides = fs.existsSync(overridesPath) ? readOverridesJson(overridesPath) : null;
  return {
    ok: true,
    commit: null,
    mirrorDir: paths.mirrorDir,
    overridesPath,
    overrides,
  };
}

function resolveBehaviorConfigRemote({
  home,
  repoRoot,
  remoteUrl,
  ref,
  readConnectionState,
}) {
  const explicitRemote = nonEmptyString(remoteUrl);
  if (explicitRemote) {
    return {
      ok: true,
      remoteUrl: explicitRemote,
      ref: nonEmptyString(ref) || "main",
    };
  }

  const read = readConnectionState({ home, repoRoot });
  if (!read.ok) return { ok: false, reason: read.reason };
  const connection = read.connection;
  if (connection.status !== "verified") {
    return { ok: false, reason: "github_connection_not_verified", status: connection.status || null };
  }
  if (connection.connection_mode && connection.connection_mode !== "real") {
    return { ok: false, reason: "github_connection_not_real", connection_mode: connection.connection_mode };
  }

  const resolvedRemote = behaviorRepoRemoteUrl(connection);
  if (!resolvedRemote) return { ok: false, reason: "github_connection_missing_remote" };
  return {
    ok: true,
    remoteUrl: resolvedRemote,
    ref: nonEmptyString(ref) || nonEmptyString(connection.default_branch) || "main",
  };
}

function behaviorMirrorPaths({ home }) {
  const mirrorDir = teamiHomePaths({ home }).behaviorMirrorDir;
  return {
    mirrorDir,
    parentDir: path.dirname(mirrorDir),
    nextDir: path.join(
      path.dirname(mirrorDir),
      `.behavior-mirror.next-${process.pid}-${Date.now()}`,
    ),
  };
}

function behaviorRepoRemoteUrl(connection) {
  return nonEmptyString(connection?.remotes?.origin?.url) ||
    nonEmptyString(connection?.repo?.clone_url) ||
    nonEmptyString(connection?.repo?.ssh_url) ||
    gitHubHttpsRemote(connection);
}

function gitHubHttpsRemote(connection) {
  const owner = nonEmptyString(connection?.repo?.owner);
  const repo = nonEmptyString(connection?.repo?.name);
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}.git`;
}

function readOverridesJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`behavior_config_overrides_json_unparseable:${filePath} - ${error.message}`);
  }
}

function gitCommandError(reason, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  return new Error(detail ? `${reason}:${detail}` : reason);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
