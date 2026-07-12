import { runBoundedSubprocess } from "./bounded-subprocess.mjs";

// Engine-side GitHub push authority. The per-run clone is deliberately
// credential-free (see git-repo-materializer neutralizeRepoLocalConfig), so
// remote-facing git commands the ENGINE runs — push, ls-remote, fetch probes —
// carry their authorization as an in-memory `http.extraHeader` injected via
// GIT_CONFIG_* environment variables. The token never reaches the clone's
// config, the remote URL, or a command line, and it is the same gh identity
// the GitHub API leg (PR creation, gh api) already acts as.
//
// Both the real mediated push (git-repo-commit-effect) and the execution
// profile preflight's push-authority probe MUST build their env through this
// module so the probe can never drift from what the push actually does.
// The GitHub REST leg (execution-pr-adapter) resolves its token through this
// module too — same env names, same gh CLI fallback — so the branch a run
// just pushed and the PR it opens for that branch always act as one identity.

export const GITHUB_TOKEN_ENV_NAMES = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ACCESS_TOKEN",
  "GITHUB_PAT",
]);

export function looksLikeGitHubRemote(remoteUrl) {
  const value = String(remoteUrl || "");
  return /^https:\/\/github\.com\//i.test(value) || /^git@github\.com:/i.test(value);
}

export function resolveAmbientGitHubToken(env = process.env) {
  for (const name of GITHUB_TOKEN_ENV_NAMES) {
    const value = nonEmptyString(env?.[name]);
    if (value) return value;
  }
  return null;
}

export async function resolveGhAuthToken(remoteUrl) {
  if (!looksLikeGitHubRemote(remoteUrl)) return null;
  return resolveGhCliToken();
}

export async function resolveGhCliToken({ runSubprocess = runBoundedSubprocess } = {}) {
  const result = await runSubprocess({
    command: "gh",
    args: ["auth", "token"],
    operation: "gh_auth_read",
  });
  if (!result.ok) return null;
  return nonEmptyString(result.stdout);
}

// GitHub's git smart-HTTP endpoint rejects `Authorization: Bearer` for the
// OAuth tokens `gh auth token` returns (gho_…); Basic with the
// x-access-token username is the form GitHub accepts for every token flavor
// it issues. Live-verified against github.com 2026-07-04.
export function githubGitAuthorizationHeader(token) {
  const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return `Authorization: Basic ${encoded}`;
}

export function gitRemoteAuthEnv({
  baseEnv = {},
  remoteUrl,
  token = null,
  processEnv = process.env,
  resolveGhToken = null,
} = {}) {
  const base = normalizeEnv(baseEnv);
  const resolved =
    nonEmptyString(token) ||
    resolveAmbientGitHubToken(processEnv) ||
    nonEmptyString(typeof resolveGhToken === "function" ? resolveGhToken(remoteUrl) : null);
  if (!resolved || !looksLikeGitHubRemote(remoteUrl)) return base;
  const count = Number.parseInt(base.GIT_CONFIG_COUNT || processEnv.GIT_CONFIG_COUNT || "0", 10);
  const next = Number.isFinite(count) && count >= 0 ? count : 0;
  return {
    ...base,
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${next}`]: githubGitAuthorizationHeader(resolved),
  };
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
