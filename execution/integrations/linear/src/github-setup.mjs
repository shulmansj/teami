import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { findTokenShapedContent } from "./eval-content-gate.mjs";
import {
  redactGitHubSecrets,
  scrubGitHubAuthEnv,
} from "./github-secret-hygiene.mjs";
import { defaultRunGit } from "./promotion-workspace.mjs";

// GitHub repo connection for `npm run init` + `doctor` (step 11).
// The CLI defaults to the adopter's ambient local git/gh auth. Dry-run remains
// available as an explicit rehearsal path and records intents only.
// Setup uses only the adopter's local git/gh auth. No GitHub secret is stored
// by Teami; dry-run remains available as an explicit rehearsal path.

export const GITHUB_CONNECTION_SCHEMA_VERSION = "teami-github-connection/v1";

export const DEFAULT_BEHAVIOR_REPO_NAME = "teami";
export const DRY_RUN_OWNER_PLACEHOLDER = "your-github-owner";
const SECRET_FILE_NAME_PATTERN =
  /(^\.env(?:\.|$)|(^|[_\-.])(token|secret|api[_\-.]?key|authorization|password|passwd|credential|private[_\-.]?key|oauth|client[_\-.]?secret|cookie|session[_\-.]?key)(?:$|\.(?:env|json|ya?ml|toml|ini|conf|cfg|pem|key|p12|pfx|crt|txt)$))/i;

// Frozen synthetic gate/scanner fixtures are intentionally secret-shaped — fake
// tokens plus descriptive paths like "planted-secret/" — so downstream gate
// modules can prove they fire. They carry no live secret and are already
// allowlisted in .gitleaks.toml for the same reason; exempt them here too so the
// repo's own tracked tree stays pushable.
const SECRET_FIXTURE_ALLOWLIST_PREFIXES = [
  "test/fixtures/staged-build/",
  "test/fixtures/security-scan-dir/",
];

export const GITHUB_CONNECTION_STATUSES = Object.freeze([
  "verified",
  "setup_conflict",
  "pending_org_approval",
  "failed",
]);

export const DRY_RUN_GITHUB_SETUP_BANNER = Object.freeze([
  "============================================================",
  "DRY-RUN GITHUB SETUP — no real GitHub I/O",
  "No repository is created, no token is stored, and no `git push`",
  "happens. Every GitHub",
  "side effect below is a RECORDED INTENT only, and the connection",
  "is written with connection_mode=dry_run — this is NOT a",
  "completed adoption. Configure local git/gh auth for the behavior repo",
  "and re-run without",
  "`--github-dry-run` to complete adoption.",
  "============================================================",
]);

const GITHUB_VISIBLE_PROGRESS_PREFIX = "GitHub progress:";
const SCRUBBED_GITHUB_ENV = Symbol("scrubbed_github_env");
const CONNECT_GITHUB_REPAIR_PREFIX =
  "connect GitHub to complete adoption: ";

// Endpoint allowlist for the SETUP transport. Production calls ride on the
// adopter's local gh and git auth; dry-run transports record the same intent
// without side effects.
export const GITHUB_SETUP_ENDPOINT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "get_repository",
    method: "GET",
    path: "/repos/{owner}/{repo}",
    credential_path: "local_gh_auth",
  }),
  Object.freeze({
    id: "create_repository",
    method: "POST",
    path: "/orgs/{owner}/repos | /user/repos",
    credential_path: "local_gh_auth",
  }),
  Object.freeze({
    id: "push_initial_branch",
    method: "RECORDED_PUSH",
    path: "git push origin <default_branch>",
    credential_path: "local_git_auth",
  }),
  Object.freeze({
    id: "verify_default_branch",
    method: "GET",
    path: "/repos/{owner}/{repo}/branches/{branch}",
    credential_path: "local_git_auth",
  }),
]);

const SETUP_ENDPOINT_IDS = new Set(GITHUB_SETUP_ENDPOINT_ALLOWLIST.map((entry) => entry.id));

function assertSetupEndpointAllowlisted(endpointId) {
  if (!SETUP_ENDPOINT_IDS.has(endpointId)) {
    throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
  }
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

// Dry-run setup transport: records every call, returns
// canned success shapes, marks everything dry_run: true. No network, no
// credentials, no git side effects.
export function createDryRunGitHubSetupTransport({ now = () => new Date() } = {}) {
  const calls = [];
  return {
    kind: "dry_run",
    calls,
    async request({ endpointId, owner, repo, params = {} }) {
      assertSetupEndpointAllowlisted(endpointId);
      calls.push({ endpointId, owner, repo, params, at: now().toISOString() });
      switch (endpointId) {
        case "get_repository":
          // Canned: the requested name is available (no collision).
          return { dry_run: true, exists: false };
        case "create_repository":
          return {
            dry_run: true,
            created: true,
            repo: {
              id: `dry-run:${owner}/${repo}`,
              owner,
              name: repo,
              full_name: `${owner}/${repo}`,
              visibility: params.visibility || "private",
              private: (params.visibility || "private") !== "public",
              default_branch: params.default_branch || "main",
              html_url: `dry-run://github/${owner}/${repo}`,
            },
          };
        case "push_initial_branch":
          return {
            dry_run: true,
            pushed: false,
            recorded: true,
            branch: params.branch,
            head_sha: params.head_sha ?? null,
            todo: "Dry-run GitHub setup: re-run without --github-dry-run after local git/gh auth is configured.",
          };
        case "verify_default_branch":
          return {
            dry_run: true,
            verified: true,
            default_branch: params.branch,
            head_sha: params.head_sha ?? null,
          };
        default:
          throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
      }
    },
  };
}

// Mock setup transport for tests: fixture-backed outcomes plus injectable
// per-endpoint failures.
export function createMockGitHubSetupTransport({
  existingRepos = [],
  existingRepoDetails = {},
  repositoryId = "mock-repo-77",
  creationOutcome = "created", // created | org_approval_required | blocked
  pushVerified = true,
  failures = {},
  now = () => new Date("2026-06-10T03:00:00.000Z"),
} = {}) {
  const calls = [];
  const failureCounters = new Map();
  const existing = new Set(existingRepos.map((fullName) => fullName.toLowerCase()));
  const existingDetails = new Map(
    Object.entries(existingRepoDetails).map(([fullName, details]) => [fullName.toLowerCase(), details || {}]),
  );
  const created = new Set();
  const maybeFail = (endpointId) => {
    const failure = failures[endpointId];
    if (!failure) return;
    const used = failureCounters.get(endpointId) || 0;
    const times = typeof failure.times === "number" ? failure.times : Infinity;
    if (used >= times) return;
    failureCounters.set(endpointId, used + 1);
    throw failure.error instanceof Error
      ? failure.error
      : new Error(String(failure.error || `mock_${endpointId}_failure`));
  };
  return {
    kind: "mock",
    calls,
    async request({ endpointId, owner, repo, params = {} }) {
      assertSetupEndpointAllowlisted(endpointId);
      calls.push({ endpointId, owner, repo, params, at: now().toISOString() });
      maybeFail(endpointId);
      const fullName = `${owner}/${repo}`.toLowerCase();
      switch (endpointId) {
        case "get_repository":
          return {
            exists: existing.has(fullName) || created.has(fullName),
            repo: existingDetails.get(fullName) || null,
          };
        case "create_repository": {
          if (creationOutcome === "org_approval_required") {
            return {
              created: false,
              pending: "org_approval_required",
              detail: `organization ${owner} requires owner approval for repository creation`,
            };
          }
          if (creationOutcome === "blocked") {
            return {
              created: false,
              blocked: true,
              detail: `organization ${owner} policy blocks repository creation`,
            };
          }
          created.add(fullName);
          return {
            created: true,
            repo: {
              id: repositoryId,
              owner,
              name: repo,
              full_name: `${owner}/${repo}`,
              visibility: params.visibility || "private",
              private: (params.visibility || "private") !== "public",
              default_branch: params.default_branch || "main",
              html_url: `mock://github/${owner}/${repo}`,
            },
          };
        }
        case "push_initial_branch":
          return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha ?? null };
        case "verify_default_branch":
          return {
            verified: pushVerified,
            default_branch: params.branch,
            head_sha: params.head_sha ?? null,
            ...(pushVerified ? {} : { detail: "default branch not found on the remote" }),
          };
        default:
          throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
      }
    },
  };
}

export function defaultRunCommand(command, args, { cwd, env } = {}) {
  const childEnv = env?.[SCRUBBED_GITHUB_ENV]
    ? { ...env }
    : {
      ...scrubGitHubAuthEnv(process.env),
      ...(env || {}),
    };
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function promptDisabledEnv(extra = {}, { pushAuth } = {}) {
  const env = {
    ...scrubGitHubAuthEnv(process.env, { pushAuth }),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  Object.defineProperty(env, SCRUBBED_GITHUB_ENV, { value: true });
  return env;
}

function safeBranchName(branch) {
  const value = String(branch || "").trim();
  return value.length > 0 && value === branch && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("-")
    ? value
    : null;
}

export function ghJsonWithAmbientAuth({ runCommand, args, missingOk = false }) {
  const auth = runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
    env: promptDisabledEnv(),
  });
  if (!auth.ok) {
    throw new Error(redactGitHubSecrets(
      auth.stderr.trim() || auth.stdout.trim() || "gh auth status failed; run gh auth login",
    ));
  }
  const result = runCommand("gh", args, { env: promptDisabledEnv() });
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (missingOk && /not found|could not resolve|HTTP 404/i.test(detail)) return null;
    throw new Error(redactGitHubSecrets(detail || `gh ${args.join(" ")} failed`));
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export function createLocalAmbientGitHubSetupTransport({
  runCommand = defaultRunCommand,
  repoRoot = process.cwd(),
  now = () => new Date(),
} = {}) {
  const calls = [];
  return {
    kind: "real",
    mode: "local_ambient",
    calls,
    async request({ endpointId, owner, repo, params = {} }) {
      assertSetupEndpointAllowlisted(endpointId);
      calls.push({ endpointId, owner, repo, params: safeSetupParams(params), at: now().toISOString() });
      switch (endpointId) {
        case "get_repository": {
          const data = ghJsonWithAmbientAuth({
            runCommand,
            args: ["repo", "view", `${owner}/${repo}`, "--json", "id,nameWithOwner,visibility,url,defaultBranchRef"],
            missingOk: true,
          });
          if (!data) return { exists: false };
          const normalized = normalizeGhRepo(data, owner, repo);
          if (!repoIdentityMatchesRequest(normalized, owner, repo)) {
            return { exists: false, redirected_repo: normalized.full_name };
          }
          return { exists: true, repo: normalized };
        }
        case "create_repository": {
          const visibilityFlag = (params.visibility || "private") === "public" ? "--public" : "--private";
          const result = runCommand("gh", [
            "repo", "create", `${owner}/${repo}`,
            visibilityFlag,
            "--disable-issues",
            "--disable-wiki",
          ], { env: promptDisabledEnv() });
          if (!result.ok) {
            throw new Error(redactGitHubSecrets(result.stderr.trim() || result.stdout.trim() || "gh repo create failed"));
          }
          const data = ghJsonWithAmbientAuth({
            runCommand,
            args: ["repo", "view", `${owner}/${repo}`, "--json", "id,nameWithOwner,visibility,url,defaultBranchRef"],
          });
          return { created: true, repo: normalizeGhRepo(data, owner, repo) };
        }
        case "push_initial_branch": {
          const branch = safeBranchName(params.branch);
          if (!branch) throw new Error("default_branch_unresolvable");
          const result = runCommand("git", ["push", "origin", `HEAD:${branch}`], {
            cwd: repoRoot,
            env: promptDisabledEnv({}, { pushAuth: params.push_auth }),
          });
          if (!result.ok) throw new Error(redactGitHubSecrets(result.stderr.trim() || result.stdout.trim() || "git push failed"));
          return { pushed: true, recorded: true, branch, head_sha: params.head_sha ?? null };
        }
        case "verify_default_branch": {
          const branch = safeBranchName(params.branch);
          if (!branch) throw new Error("default_branch_unresolvable");
          const result = runCommand("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], {
            cwd: repoRoot,
            env: promptDisabledEnv({}, { pushAuth: params.push_auth }),
          });
          return {
            verified: result.ok,
            default_branch: branch,
            head_sha: params.head_sha ?? null,
            ...(result.ok ? {} : { detail: redactGitHubSecrets(result.stderr.trim() || result.stdout.trim() || "default branch not found on origin") }),
          };
        }
        default:
          throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Local connection state (.teami/github-connection.json).
//
// This file is the LOCAL system of record for "which behavior repo this
// workspace is connected to": selected repo, owner, default branch, App
// installation id, permission snapshot, connection_mode (dry_run|real), and
// verified_at. The step 10 promotion controller resolves the behavior-repo
// identity from here (resolveBehaviorRepoIdentity); the step 12 scanner and
// step 13 supervisor read the same file.
// ---------------------------------------------------------------------------

export function githubConnectionStatePath(repoRoot = process.cwd()) {
  return path.join(repoRoot, ".teami", "github-connection.json");
}

export function readGitHubConnectionState({ repoRoot = process.cwd(), statePath = null } = {}) {
  const file = statePath || githubConnectionStatePath(repoRoot);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: "missing_github_connection_state", statePath: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_github_connection_state",
      detail: error.message,
      statePath: file,
    };
  }
  if (parsed?.schema_version !== GITHUB_CONNECTION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "invalid_github_connection_state",
      detail: `unsupported schema_version ${parsed?.schema_version ?? "missing"}`,
      statePath: file,
    };
  }
  return { ok: true, connection: parsed, statePath: file };
}

function writeGitHubConnectionState({ statePath, connection }) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const serialized = `${JSON.stringify(connection, null, 2)}\n`;
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, serialized, "utf8");
  fs.renameSync(tempPath, statePath);
  // Read-back validation mirrors run-store conventions.
  JSON.parse(fs.readFileSync(statePath, "utf8"));
  return statePath;
}

// Production behavior-repo identity resolution for the promotion controller:
// reads the connection state written by `npm run init`. Only a VERIFIED
// connection supplies an identity; everything else fails typed so the caller
// can fall back to the dry-run placeholder or repair.
export function resolveBehaviorRepoIdentity({ repoRoot = process.cwd(), statePath = null } = {}) {
  const read = readGitHubConnectionState({ repoRoot, statePath });
  if (!read.ok) return { ok: false, reason: read.reason };
  const connection = read.connection;
  if (connection.status !== "verified" || !connection.repo?.owner || !connection.repo?.name) {
    return {
      ok: false,
      reason: "github_connection_not_verified",
      status: connection.status ?? null,
    };
  }
  return {
    ok: true,
    source: "github_connection_state",
    connection_mode: connection.connection_mode,
    repo: { owner: connection.repo.owner, repo: connection.repo.name },
    repo_id: connection.repo.id ?? null,
    default_branch: connection.default_branch ?? null,
    push_auth: connection.push_auth ?? connection.remotes?.origin?.push_auth ?? "https",
    real_push_enabled: connection.local_auth?.real_push_enabled === true,
  };
}

// ---------------------------------------------------------------------------
// Settings + remote detection.
// ---------------------------------------------------------------------------

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function configString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export async function resolveGitHubSetupSettings({
  config = null,
  requestedOwner = null,
  requestedRepoName = null,
  requestedVisibility = null,
  connectionMode = "dry_run",
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  promptGitHubOwner = defaultPromptGitHubOwner,
  resolveAuthenticatedGitHubLogin = defaultResolveAuthenticatedGitHubLogin,
} = {}) {
  const github = config?.github || {};
  const behavior = github.behavior_repo || {};
  const name = String(requestedRepoName || behavior.name || DEFAULT_BEHAVIOR_REPO_NAME).trim();
  if (!REPO_NAME_PATTERN.test(name)) {
    return { ok: false, reason: "invalid_behavior_repo_name", detail: name };
  }
  const visibility = String(requestedVisibility || behavior.visibility || "private").toLowerCase();
  if (!["private", "public"].includes(visibility)) {
    return { ok: false, reason: "invalid_behavior_repo_visibility", detail: visibility };
  }
  // An explicitly provided but blank owner (flag or config) is a mistake, not a
  // request for the gh-login default — fail closed instead of guessing an account.
  for (const [value, label] of [
    [requestedOwner, "--github-owner"],
    [behavior.owner, "github.behavior_repo.owner"],
  ]) {
    if (value != null && String(value).trim() === "") {
      return {
        ok: false,
        reason: "github_owner_blank",
        detail: `${label} was provided empty; pass a real owner/org or omit it to default to your gh login`,
      };
    }
  }
  let owner = String(requestedOwner || behavior.owner || "").trim();
  let ownerSource = requestedOwner ? "flag" : behavior.owner ? "config" : "unset";
  if (!owner) {
    if (connectionMode === "real") {
      const login = configString(await resolveAuthenticatedGitHubLogin());
      if (!login) {
        return {
          ok: false,
          reason: "github_owner_not_selected",
          detail: "authenticate the GitHub CLI (gh auth login) or pass --github-owner / set github.behavior_repo.owner",
        };
      }
      if (isTTY) {
        const message = formatGitHubOwnerPrompt({
          defaultOwner: login,
          repoName: name,
          visibility,
        });
        const answer = configString(await promptGitHubOwner({ defaultOwner: login, message }));
        owner = answer || login;
        ownerSource = answer ? "prompt" : "gh_login";
      } else {
        owner = login;
        ownerSource = "gh_login";
      }
    } else {
      owner = DRY_RUN_OWNER_PLACEHOLDER;
      ownerSource = "dry_run_placeholder";
    }
  }
  // Starter URLs identify source/template remotes that init may preserve as
  // upstream while it creates the adopter-owned behavior repo as origin.
  const starterRemoteUrls = Array.isArray(github.starter_remote_urls)
    ? github.starter_remote_urls.filter((url) => typeof url === "string" && url.trim())
    : [];
  return {
    ok: true,
    owner,
    ownerSource,
    name,
    visibility,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
    starterRemoteUrls,
  };
}

function formatGitHubOwnerPrompt({ defaultOwner, repoName, visibility }) {
  return [
    `  Teami needs a ${visibility} GitHub repo named "${repoName}" where generated PRs will live.`,
    `  Press Enter to create it under ${defaultOwner} (your signed-in GitHub CLI account), or type a different GitHub user/org.`,
    `  Create repo under [${defaultOwner}]: `,
  ].join("\n");
}

export function defaultResolveAuthenticatedGitHubLogin({ runCommand = defaultRunCommand } = {}) {
  let result;
  try {
    result = runCommand("gh", ["api", "user", "--jq", ".login"], { env: promptDisabledEnv() });
  } catch {
    return null;
  }
  if (!result.ok) return null;
  return configString(result.stdout);
}

async function defaultPromptGitHubOwner({ defaultOwner, message = null } = {}) {
  const prompt = message || `GitHub owner/org [${defaultOwner}]: `;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function normalizeGitRemoteUrl(url) {
  let normalized = String(url || "").trim();
  const sshMatch = normalized.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i);
  if (sshMatch) normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  return normalized.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

export function parseGitHubRemoteUrl(url) {
  const value = String(url || "").trim();
  let match = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (match) return normalizeGitHubRemoteParts(match[1], match[2]);
  match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/i);
  if (match) return normalizeGitHubRemoteParts(match[1], match[2]);
  match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (match) return normalizeGitHubRemoteParts(match[1], match[2]);
  return null;
}

export function pushAuthForRemoteUrl(url) {
  const value = String(url || "").trim();
  return /^(?:ssh:\/\/)?git@github\.com[:/]/i.test(value) ? "ssh" : "https";
}

function normalizeGitHubRemoteParts(owner, repoWithSuffix) {
  const repo = String(repoWithSuffix || "").replace(/\.git$/i, "");
  if (!owner || !repo || repo.includes("/") || owner.includes("/")) return null;
  return { owner, repo };
}

export function listGitRemotes({ repoRoot = process.cwd(), runGit = defaultRunGit } = {}) {
  const result = runGit(["remote", "-v"], { cwd: repoRoot });
  if (!result.ok) {
    return {
      ok: false,
      reason: "git_remote_listing_failed",
      detail: result.stderr.trim() || result.stdout.trim(),
    };
  }
  const remotes = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/);
    if (match && !remotes.has(match[1])) remotes.set(match[1], match[2]);
  }
  return { ok: true, remotes: [...remotes.entries()].map(([name, url]) => ({ name, url })) };
}

function getGitRemoteUrl({ repoRoot = process.cwd(), runGit = defaultRunGit, remote = "origin", push = false } = {}) {
  const args = push
    ? ["remote", "get-url", "--push", remote]
    : ["remote", "get-url", remote];
  const result = runGit(args, { cwd: repoRoot });
  if (!result.ok || !result.stdout.trim()) {
    return {
      ok: false,
      reason: "git_remote_url_read_failed",
      detail: result.stderr.trim() || result.stdout.trim(),
    };
  }
  return { ok: true, url: result.stdout.trim() };
}

function resolveExistingBehaviorOrigin({ remotes = [], starterRemoteUrls = [] } = {}) {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) return null;
  const normalized = normalizeGitRemoteUrl(origin.url);
  const starterSet = new Set(starterRemoteUrls.map(normalizeGitRemoteUrl).filter(Boolean));
  if (starterSet.has(normalized)) return null;
  const parsed = parseGitHubRemoteUrl(origin.url);
  if (!parsed) {
    return {
      ok: false,
      reason: "github_origin_remote_unparseable",
      detail: `origin is not a GitHub SSH or HTTPS remote: ${origin.url}`,
    };
  }
  return {
    ok: true,
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
    url: origin.url,
    normalized,
  };
}

// Classifies the checkout's remotes and plans the target layout (plan
// ~414-422): starter/upstream-only remotes are preserved as `upstream`;
// `origin` becomes the NEW dedicated behavior repo; any pre-existing
// adopter-owned remote is a SETUP CONFLICT with a repair path — init never
// adopts it (dedicated-Linear-team posture).
export function planRemoteLayout({ remotes = [], starterRemoteUrls = [], behaviorRepoUrl } = {}) {
  const starterSet = new Set(starterRemoteUrls.map(normalizeGitRemoteUrl).filter(Boolean));
  const behaviorNormalized = normalizeGitRemoteUrl(behaviorRepoUrl);
  const classified = remotes.map((remote) => {
    const normalized = normalizeGitRemoteUrl(remote.url);
    let kind;
    if (behaviorNormalized && normalized === behaviorNormalized) kind = "behavior_repo";
    else if (starterSet.has(normalized)) kind = "starter";
    else if (remote.name === "upstream") kind = "starter_assumed_by_upstream_name";
    else kind = "adopter_owned";
    return { ...remote, normalized, kind };
  });
  const conflicts = classified.filter((remote) => remote.kind === "adopter_owned");
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "github_remote_setup_conflict",
      conflicts,
      detail:
        `pre-existing adopter-owned remote(s): ${conflicts
          .map((remote) => `${remote.name} -> ${remote.url}`)
          .join(", ")}. Init never attaches the workspace to a pre-existing adopter GitHub repo (dedicated behavior-repo posture, matching the dedicated Linear team).`,
    };
  }
  const upstreamRemote = classified.find((remote) => remote.name === "upstream") || null;
  const originRemote = classified.find((remote) => remote.name === "origin") || null;
  const plannedActions = [];
  let upstream = null;
  if (originRemote && (originRemote.kind === "starter" || originRemote.kind === "starter_assumed_by_upstream_name")) {
    if (upstreamRemote) {
      plannedActions.push({
        action: "remove_duplicate_starter_origin",
        name: "origin",
        url: originRemote.url,
        note: "the starter/template remote is already preserved as upstream",
      });
      upstream = { url: upstreamRemote.url, preserved_from: "upstream" };
    } else {
      plannedActions.push({
        action: "rename_remote",
        from: "origin",
        to: "upstream",
        url: originRemote.url,
        note: "starter remote preserved as upstream for template updates",
      });
      upstream = { url: originRemote.url, preserved_from: "origin" };
    }
  } else if (upstreamRemote) {
    upstream = { url: upstreamRemote.url, preserved_from: "upstream" };
  }
  if (!originRemote || originRemote.kind !== "behavior_repo") {
    plannedActions.push({ action: "set_origin", url: behaviorRepoUrl });
  }
  return { ok: true, classified, plannedActions, upstream, originAlreadyBehaviorRepo: originRemote?.kind === "behavior_repo" };
}

export function applyRemotePlan({
  repoRoot = process.cwd(),
  runGit = defaultRunGit,
  remotePlan,
  behaviorRepoUrl,
} = {}) {
  const initial = listGitRemotes({ repoRoot, runGit });
  if (!initial.ok) return initial;
  const restore = (failure) => ({
    ...failure,
    rollback: restoreRemoteSnapshot({ repoRoot, runGit, remotes: initial.remotes }),
  });
  for (const action of remotePlan?.plannedActions || []) {
    let result = null;
    if (action.action === "rename_remote") {
      result = runGit(["remote", "rename", action.from, action.to], { cwd: repoRoot });
    } else if (action.action === "remove_duplicate_starter_origin") {
      result = runGit(["remote", "remove", action.name], { cwd: repoRoot });
    } else if (action.action === "set_origin") {
      const listing = listGitRemotes({ repoRoot, runGit });
      if (!listing.ok) return listing;
      const hasOrigin = listing.remotes.some((remote) => remote.name === "origin");
      result = hasOrigin
        ? runGit(["remote", "set-url", "origin", behaviorRepoUrl], { cwd: repoRoot })
        : runGit(["remote", "add", "origin", behaviorRepoUrl], { cwd: repoRoot });
    }
    if (result && !result.ok) {
      return restore({
        ok: false,
        reason: "git_remote_apply_failed",
        detail: result.stderr.trim() || result.stdout.trim(),
      });
    }
  }
  const after = listGitRemotes({ repoRoot, runGit });
  if (!after.ok) return restore(after);
  const verify = planRemoteLayout({
    remotes: after.remotes,
    starterRemoteUrls: [remotePlan?.upstream?.url].filter(Boolean),
    behaviorRepoUrl,
  });
  const origin = after.remotes.find((remote) => remote.name === "origin") || null;
  const upstream = after.remotes.find((remote) => remote.name === "upstream") || null;
  const expectedUpstreamUrl = remotePlan?.upstream?.url || null;
  const exact =
    verify.ok
    && verify.plannedActions.length === 0
    && origin
    && normalizeGitRemoteUrl(origin.url) === normalizeGitRemoteUrl(behaviorRepoUrl)
    && (!expectedUpstreamUrl || (upstream && normalizeGitRemoteUrl(upstream.url) === normalizeGitRemoteUrl(expectedUpstreamUrl)));
  if (!exact) {
    return restore({
      ok: false,
      reason: "git_remote_apply_verification_failed",
      detail: verify.ok
        ? "remote application did not produce the exact origin/upstream layout"
        : verify.detail,
      observed_remotes: after.remotes,
      pending_actions: verify.ok ? verify.plannedActions : [],
    });
  }
  return { ok: true, applied: true };
}

function restoreRemoteSnapshot({ repoRoot = process.cwd(), runGit = defaultRunGit, remotes = [] } = {}) {
  const desired = new Map(remotes.map((remote) => [remote.name, remote.url]));
  const current = listGitRemotes({ repoRoot, runGit });
  if (!current.ok) return { ok: false, reason: "git_remote_rollback_listing_failed", detail: current.detail };
  const failures = [];
  for (const remote of current.remotes) {
    if (!desired.has(remote.name)) {
      const remove = runGit(["remote", "remove", remote.name], { cwd: repoRoot });
      if (!remove.ok) failures.push({ action: "remove", name: remote.name, detail: remove.stderr.trim() || remove.stdout.trim() });
    }
  }
  const refreshed = listGitRemotes({ repoRoot, runGit });
  if (!refreshed.ok) return { ok: false, reason: "git_remote_rollback_refresh_failed", detail: refreshed.detail, failures };
  const present = new Set(refreshed.remotes.map((remote) => remote.name));
  for (const [name, url] of desired.entries()) {
    const result = present.has(name)
      ? runGit(["remote", "set-url", name, url], { cwd: repoRoot })
      : runGit(["remote", "add", name, url], { cwd: repoRoot });
    if (!result.ok) {
      failures.push({
        action: present.has(name) ? "set-url" : "add",
        name,
        detail: result.stderr.trim() || result.stdout.trim(),
      });
    }
  }
  return failures.length === 0
    ? { ok: true, restored_remotes: remotes }
    : { ok: false, reason: "git_remote_rollback_failed", failures };
}

// ---------------------------------------------------------------------------
// Pre-push sanitizer: the step 4 content-gate secret scan over the
// would-be-pushed tree (plan error row ~1900). Token-shaped content blocks
// the push (even the recorded dry-run intent) with a sanitizer report and a
// repair hint. Scans every git-TRACKED text file plus secret-shaped tracked
// file NAMES; binary files are skipped and disclosed in the report.
// ---------------------------------------------------------------------------

export function scanTrackedTreeForSecrets({ repoRoot = process.cwd(), runGit = defaultRunGit } = {}) {
  const listed = runGit(["ls-files", "-z"], { cwd: repoRoot });
  if (!listed.ok) {
    return {
      ok: false,
      reason: "git_ls_files_failed",
      detail: listed.stderr.trim() || listed.stdout.trim(),
    };
  }
  const files = listed.stdout.split("\0").filter(Boolean);
  const findings = [];
  let scannedCount = 0;
  let skippedBinaryCount = 0;
  for (const relative of files) {
    if (SECRET_FIXTURE_ALLOWLIST_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    for (const segment of relative.split("/")) {
      if (SECRET_FILE_NAME_PATTERN.test(segment)) {
        findings.push({ path: relative, rule: "secret_shaped_path" });
        break;
      }
    }
    const absolute = path.join(repoRoot, relative);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue; // tracked but deleted from the working tree
    }
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(absolute);
    if (content.subarray(0, 8192).includes(0)) {
      skippedBinaryCount += 1;
      continue;
    }
    scannedCount += 1;
    if (findTokenShapedContent(content.toString("utf8")).length > 0) {
      findings.push({ path: relative, rule: "token_shaped_value" });
    }
  }
  return {
    ok: findings.length === 0,
    ...(findings.length > 0 ? { reason: "token_or_secret_like" } : {}),
    report: {
      scanned_count: scannedCount,
      skipped_binary_count: skippedBinaryCount,
      tracked_count: files.length,
      findings,
    },
  };
}

function normalizeGhRepo(data, owner, repo) {
  const [resolvedOwner, resolvedRepo] = String(data?.nameWithOwner || `${owner}/${repo}`).split("/");
  const visibility = String(data?.visibility || "PRIVATE").toLowerCase();
  return {
    id: data?.id ?? null,
    owner: resolvedOwner || owner,
    name: resolvedRepo || repo,
    full_name: data?.nameWithOwner || `${owner}/${repo}`,
    visibility: visibility === "public" ? "public" : "private",
    private: visibility !== "public",
    default_branch: data?.defaultBranchRef?.name || "main",
    empty: data?.defaultBranchRef && !data.defaultBranchRef.name,
    html_url: data?.url || `https://github.com/${owner}/${repo}`,
  };
}

function repoIdentityMatchesRequest(normalized, owner, repo) {
  return String(normalized?.owner || "").toLowerCase() === String(owner || "").toLowerCase() &&
    String(normalized?.name || "").toLowerCase() === String(repo || "").toLowerCase();
}

function safeSetupParams(params = {}) {
  const copy = { ...params };
  if (copy.token) copy.token = "[redacted]";
  return copy;
}

// ---------------------------------------------------------------------------
// The init GitHub phase (plan ~414-468 state machine; step 11).
// ---------------------------------------------------------------------------

export async function runGitHubInitPhase({
  repoRoot = process.cwd(),
  config = null,
  transport = null,
  runGit = defaultRunGit,
  statePath = null,
  requestedOwner = null,
  requestedRepoName = null,
  requestedVisibility = null,
  now = () => new Date(),
  onProgress = () => {},
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  promptGitHubOwner = defaultPromptGitHubOwner,
  resolveAuthenticatedGitHubLogin = defaultResolveAuthenticatedGitHubLogin,
} = {}) {
  const effectiveTransport = transport || createDryRunGitHubSetupTransport({ now });
  // connection_mode is derived from the transport, never caller-asserted:
  // anything that is not the real transport records dry_run.
  const connectionMode = effectiveTransport.kind === "real" ? "real" : "dry_run";
  const resolvedStatePath = statePath || githubConnectionStatePath(repoRoot);

  if (connectionMode === "dry_run") {
    for (const line of DRY_RUN_GITHUB_SETUP_BANNER) onProgress(line);
  }

  onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking local Git remotes...`);
  const remoteListing = listGitRemotes({ repoRoot, runGit });
  if (!remoteListing.ok) {
    return {
      ok: false,
      status: "failed",
      reason: remoteListing.reason,
      detail: remoteListing.detail,
      repair: "run npm run init from the root of the adopter checkout (a git repository)",
      failures: [{ reason: remoteListing.reason, repair: "see above", ...(remoteListing.detail ? { detail: remoteListing.detail } : {}) }],
      state_path: resolvedStatePath,
    };
  }
  const originBinding = resolveExistingBehaviorOrigin({
    remotes: remoteListing.remotes,
    starterRemoteUrls: config?.github?.starter_remote_urls || [],
  });
  if (originBinding?.ok === false) {
    return {
      ok: false,
      status: "failed",
      reason: originBinding.reason,
      detail: originBinding.detail,
      repair: "set origin to the adopter-owned GitHub behavior repo, or remove origin so init can create and bind one with local gh auth",
      failures: [{ reason: originBinding.reason, repair: "see above", detail: originBinding.detail }],
      state_path: resolvedStatePath,
    };
  }

  const configuredOwner = configString(config?.github?.behavior_repo?.owner);
  const ownerForSettings = requestedOwner || originBinding?.owner || null;
  const repoForSettings = requestedRepoName || originBinding?.repo || null;
  if (connectionMode === "real" && !ownerForSettings && !configuredOwner) {
    onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking the signed-in GitHub account...`);
  }
  const settings = await resolveGitHubSetupSettings({
    config,
    requestedOwner: ownerForSettings,
    requestedRepoName: repoForSettings,
    requestedVisibility,
    connectionMode,
    isTTY,
    promptGitHubOwner,
    resolveAuthenticatedGitHubLogin,
  });
  if (!settings.ok) {
    let repair = `fix the requested behavior repo settings (${settings.detail}) and re-run npm run init`;
    if (settings.reason === "github_owner_not_selected") {
      repair = "authenticate the GitHub CLI (gh auth login), set origin to the adopter-owned behavior repo, or re-run npm run init -- --github-owner <owner-or-org>";
    }
    return {
      ok: false,
      status: "failed",
      reason: settings.reason,
      repair,
      failures: [{ reason: settings.reason, repair: "see above" }],
      state_path: resolvedStatePath,
    };
  }
  if (originBinding && requestedOwner && requestedOwner.toLowerCase() !== originBinding.owner.toLowerCase()) {
    return {
      ok: false,
      status: "failed",
      reason: "github_origin_remote_target_mismatch",
      detail: `origin points to ${originBinding.owner}/${originBinding.repo}, but --github-owner requested ${requestedOwner}`,
      repair: "change origin to the behavior repo you want to bind, or remove the conflicting --github-owner flag",
      failures: [{ reason: "github_origin_remote_target_mismatch", repair: "see above" }],
      state_path: resolvedStatePath,
    };
  }
  if (originBinding && requestedRepoName && requestedRepoName.toLowerCase() !== originBinding.repo.toLowerCase()) {
    return {
      ok: false,
      status: "failed",
      reason: "github_origin_remote_target_mismatch",
      detail: `origin points to ${originBinding.owner}/${originBinding.repo}, but --github-repo requested ${requestedRepoName}`,
      repair: "change origin to the behavior repo you want to bind, or remove the conflicting --github-repo flag",
      failures: [{ reason: "github_origin_remote_target_mismatch", repair: "see above" }],
      state_path: resolvedStatePath,
    };
  }
  onProgress(`GitHub repo target: ${settings.fullName} (${settings.visibility})`);
  const previousConnectionRead = readGitHubConnectionState({ repoRoot, statePath: resolvedStatePath });
  const previousConnection = previousConnectionRead.ok ? previousConnectionRead.connection : null;
  const state = {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: connectionMode,
    status: "failed",
    adoption_complete: false,
    repo: {
      id: null,
      owner: settings.owner,
      owner_source: originBinding ? "origin_remote" : settings.ownerSource,
      name: settings.name,
      full_name: settings.fullName,
      visibility: settings.visibility,
      url: null,
    },
    default_branch: null,
    push_auth: "https",
    local_auth: null,
    remotes: null,
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    failures: [],
    verified_at: null,
    ...(connectionMode === "dry_run"
      ? {
        todo: "Dry-run GitHub connection — recorded intents only; re-run npm run github:init without --github-dry-run to complete adoption.",
      }
      : {}),
  };

  const callTransport = async (endpointId, params = {}) => {
    return effectiveTransport.request({
      endpointId,
      owner: settings.owner,
      repo: settings.name,
      params,
    });
  };

  const finishFailure = async ({ status, reason, repair, detail = null, extra = {} }) => {
    const safeDetail = detail ? redactGitHubSecrets(detail) : null;
    detail = safeDetail;
    // Preserve the local state of the attempted binding so doctor can give a
    // concrete repair instead of leaving setup failures opaque.
    state.status = status;
    state.failures = [{ reason, repair, ...(safeDetail ? { detail: safeDetail } : {}) }];
    try {
      writeGitHubConnectionState({ statePath: resolvedStatePath, connection: state });
    } catch (writeError) {
      onProgress(`WARNING could not record the GitHub connection state: ${redactGitHubSecrets(writeError.message)}`);
    }
    onProgress(`FAIL GitHub setup: ${reason}${detail ? ` — ${detail}` : ""}`);
    onProgress(`Repair: ${repair}`);
    return {
      ok: false,
      status,
      reason,
      repair,
      ...(detail ? { detail } : {}),
      failures: state.failures,
      state_path: resolvedStatePath,
      connection: state,
      ...extra,
    };
  };

  // ---- a. Remote state detection ------------------------------------------
  const behaviorRepoRemoteUrl = originBinding?.url || settings.url;
  const remotePlan = planRemoteLayout({
    remotes: remoteListing.remotes,
    starterRemoteUrls: settings.starterRemoteUrls,
    behaviorRepoUrl: behaviorRepoRemoteUrl,
  });
  if (!remotePlan.ok) {
    return finishFailure({
      status: "setup_conflict",
      reason: remotePlan.reason,
      detail: remotePlan.detail,
      repair:
        "keep origin pointed at the adopter-owned behavior repo, and remove or rename any other non-starter GitHub remotes that make the behavior repo binding ambiguous; then re-run npm run init.",
      extra: { conflicts: remotePlan.conflicts },
    });
  }
  onProgress(
    `GitHub remote plan: ${remotePlan.plannedActions.length === 0
      ? "remotes already match the dedicated behavior-repo layout"
      : remotePlan.plannedActions.map((action) => action.action === "set_origin"
        ? `set origin -> ${action.url}`
        : action.action === "rename_remote"
          ? `preserve starter remote as upstream (rename ${action.from} -> ${action.to})`
          : `${action.action} (${action.name ?? ""})`).join("; ")}`,
  );

  // ---- b. Repo reachability + optional creation through local gh auth ------
  let existsResponse;
  try {
    onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking whether ${settings.fullName} is available on GitHub...`);
    existsResponse = await callTransport("get_repository");
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "github_repo_lookup_failed",
      detail: error.message,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify local gh auth and GitHub availability, then re-run npm run init`,
    });
  }
  if (originBinding && existsResponse.exists !== true) {
    return finishFailure({
      status: "failed",
      reason: "behavior_repo_unreachable",
      detail: `origin points to ${settings.fullName}, but gh could not reach that repository`,
      repair:
        "verify origin points to the adopter-owned GitHub behavior repo and that `gh auth status --hostname github.com` can see it, then re-run npm run init",
    });
  }

  let creation = null;
  if (existsResponse.exists !== true) {
    try {
      onProgress(
        `${GITHUB_VISIBLE_PROGRESS_PREFIX} ${connectionMode === "dry_run" ? "Recording GitHub repo creation for" : "Creating GitHub repo"} ${settings.fullName}...`,
      );
      creation = await callTransport("create_repository", {
        visibility: settings.visibility,
        default_branch: "main",
      });
    } catch (error) {
      return finishFailure({
        status: "failed",
        reason: "behavior_repo_creation_failed",
        detail: error.message,
        repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify local gh auth can create repositories under ${settings.owner}, then re-run npm run init`,
      });
    }
    if (creation.pending === "org_approval_required") {
      return finishFailure({
        status: "pending_org_approval",
        reason: "behavior_repo_creation_pending_org_approval",
        detail: creation.detail ?? null,
        repair:
          `organization policy requires owner approval before the behavior repo can be created: ask the ${settings.owner} org owner to approve repository creation (or choose a different owner with --github-owner), then re-run npm run init. Init stops here rather than silently completing a partial adoption.`,
      });
    }
    if (creation.created !== true) {
      return finishFailure({
        status: "failed",
        reason: "behavior_repo_creation_blocked",
        detail: creation.detail ?? null,
        repair:
          `${CONNECT_GITHUB_REPAIR_PREFIX}repository creation is blocked for ${settings.owner} (org policy or insufficient setup permission); resolve the block or choose a different owner, then re-run npm run init`,
      });
    }
    state.repo.id = creation.repo?.id ?? state.repo.id ?? null;
    state.repo.url = creation.repo?.html_url ?? null;
    state.repo.visibility = creation.repo?.visibility ?? settings.visibility;
    onProgress(
      `${creation.dry_run ? "recorded (dry-run)" : "created"}: behavior repo ${settings.fullName} (visibility ${state.repo.visibility})`,
    );
  } else {
    onProgress(`found: behavior repo ${settings.fullName} already ${remotePlan.originAlreadyBehaviorRepo ? "connected as origin" : "available on GitHub"} (verifying local auth)`);
    state.repo.id = existsResponse.repo?.id ?? previousConnection?.repo?.id ?? state.repo.id ?? null;
    state.repo.url = settings.url;
    state.repo.visibility = existsResponse.repo?.visibility ?? state.repo.visibility;
  }

  // ---- c. Local ambient auth is the steady-state GitHub connection ---------
  onProgress(
    `${connectionMode === "dry_run" ? "recorded (dry-run)" : "verified"}: behavior repo will use local ambient git/gh auth; no GitHub secret is stored`,
  );

  // ---- d. Set origin + pre-push sanitizer + push verify -------------------
  const remoteApply = connectionMode === "real"
    ? applyRemotePlan({ repoRoot, runGit, remotePlan, behaviorRepoUrl: behaviorRepoRemoteUrl })
    : { ok: true, applied: false };
  if (!remoteApply.ok) {
    return finishFailure({
      status: "failed",
      reason: remoteApply.reason,
      detail: remoteApply.detail,
      repair: "fix the local git remote layout and re-run npm run init",
    });
  }
  const remotesApplied = remoteApply.applied === true;
  const originPushUrl = getGitRemoteUrl({ repoRoot, runGit, remote: "origin", push: true });
  const recordedPushUrl = originPushUrl.ok ? originPushUrl.url : behaviorRepoRemoteUrl;
  state.push_auth = pushAuthForRemoteUrl(recordedPushUrl);
  state.remotes = {
    origin: {
      url: behaviorRepoRemoteUrl,
      push_url: recordedPushUrl,
      push_auth: state.push_auth,
      planned: true,
      applied: remotesApplied,
    },
    upstream: remotePlan.upstream
      ? { url: remotePlan.upstream.url, preserved_from: remotePlan.upstream.preserved_from, planned: true, applied: remotesApplied }
      : null,
    planned_actions: remotePlan.plannedActions,
  };

  const sanitizer = scanTrackedTreeForSecrets({ repoRoot, runGit });
  state.pre_push_sanitizer = sanitizer.report ?? null;
  if (!sanitizer.ok) {
    if (sanitizer.reason === "token_or_secret_like") {
      return finishFailure({
        status: "failed",
        reason: "initial_push_blocked_token_shaped_content",
        detail: `sanitizer report: ${JSON.stringify(sanitizer.report)}`,
        repair:
          `the initial push would publish token/secret-shaped content from the local repo — the push is blocked before any byte leaves the machine. Remove or replace the flagged content (${sanitizer.report.findings
            .map((finding) => `${finding.path} [${finding.rule}]`)
            .join(", ")}), commit the cleanup, then re-run npm run init. Secrets are never sanitized through.`,
      });
    }
    return finishFailure({
      status: "failed",
      reason: sanitizer.reason,
      detail: sanitizer.detail ?? null,
      repair: "fix the git working tree listing failure and re-run npm run init",
    });
  }
  onProgress(
    `pre-push sanitizer: clean (${sanitizer.report.scanned_count} text file(s) scanned, ${sanitizer.report.skipped_binary_count} binary file(s) skipped)`,
  );

  const branchResult = runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot });
  if (!branchResult.ok || !branchResult.stdout.trim()) {
    return finishFailure({
      status: "failed",
      reason: "default_branch_unresolvable",
      detail: branchResult.stderr.trim() || "detached HEAD",
      repair: "check out the branch that should become the behavior repo's default branch, then re-run npm run init",
    });
  }
  const currentBranch = branchResult.stdout.trim();
  const defaultBranch = existsResponse.repo?.default_branch || creation?.repo?.default_branch || currentBranch;
  const headResult = runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  const headSha = headResult.ok ? headResult.stdout.trim() : null;

  let pushResponse;
  let branchVerification;
  try {
    pushResponse = await callTransport("push_initial_branch", {
      branch: defaultBranch,
      head_sha: headSha,
      push_auth: state.push_auth,
    });
    branchVerification = await callTransport("verify_default_branch", {
      branch: defaultBranch,
      head_sha: headSha,
      push_auth: state.push_auth,
    });
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "initial_branch_push_failed",
      detail: error.message,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify local git push access to ${settings.fullName} and re-run npm run init`,
    });
  }
  if (branchVerification.verified !== true) {
    return finishFailure({
      status: "failed",
      reason: "initial_branch_push_unverified",
      detail: branchVerification.detail ?? `default branch ${defaultBranch} not verified on ${settings.fullName}`,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}push the initial ${defaultBranch} branch to ${settings.fullName} and re-run npm run init`,
    });
  }
  state.default_branch = defaultBranch;
  state.push_verification = {
    recorded: pushResponse.recorded === true,
    pushed: pushResponse.pushed === true,
    branch: defaultBranch,
    head_sha: headSha,
    verified: true,
    push_auth: state.push_auth,
    ...(pushResponse.dry_run ? { dry_run: true } : {}),
  };
  state.local_auth = {
    mode: "local_ambient",
    gh_auth: connectionMode === "real" ? "verified" : "dry_run",
    git_write: pushResponse.pushed === true ? "verified" : "dry_run",
    real_push_enabled: connectionMode === "real" && pushResponse.pushed === true && branchVerification.verified === true,
    push_auth: state.push_auth,
    checked_at: now().toISOString(),
  };
  onProgress(
    `${pushResponse.dry_run ? "recorded (dry-run) push intent" : "pushed"}: ${defaultBranch} @ ${headSha ?? "unknown"} (verified on remote: ${branchVerification.dry_run ? "dry-run" : "yes"})`,
  );

  state.pr_generation = {
    verified: true,
    derived_from: "local_ambient_git_gh_auth",
    mode: "local_ambient",
    ...(connectionMode === "dry_run" ? { dry_run: true } : {}),
  };
  onProgress(
    `${state.pr_generation.dry_run ? "recorded (dry-run)" : "verified"}: local GitHub auth can reach the behavior repo and write branches`,
  );

  // ---- Success: ALL phases verified ----------------------------------------
  state.status = "verified";
  state.adoption_complete = connectionMode === "real";
  state.verified_at = now().toISOString();
  state.failures = [];
  try {
    writeGitHubConnectionState({ statePath: resolvedStatePath, connection: state });
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "github_connection_state_write_failed",
      detail: error.message,
      repair: "fix the .teami/ write failure and re-run npm run init",
    });
  }
  if (connectionMode === "dry_run") {
    onProgress(
      "GitHub connection recorded in DRY-RUN mode — adoption is NOT complete. Re-run npm run github:init without --github-dry-run.",
    );
  }
  return {
    ok: true,
    status: "verified",
    connection: state,
    state_path: resolvedStatePath,
    transport_kind: effectiveTransport.kind,
  };
}

// ---------------------------------------------------------------------------
// Doctor checks: remote shape, repo reachability, local write capability, and
// connection mode. Each failure names a repair action.
// ---------------------------------------------------------------------------

export async function githubConnectionDoctorChecks({
  repoRoot = process.cwd(),
  config = null,
  transport = null,
  runGit = defaultRunGit,
  statePath = null,
} = {}) {
  const checks = [];
  const read = readGitHubConnectionState({ repoRoot, statePath });
  if (!read.ok) {
    checks.push({
      name: "GitHub connection",
      ok: false,
      message: read.reason === "missing_github_connection_state"
        ? "no GitHub connection state; run npm run init to create and connect the dedicated behavior repo (connect-GitHub repair path)"
        : `${read.reason}${read.detail ? ` (${read.detail})` : ""}; re-run npm run init to rewrite the GitHub connection state`,
      fix: "npm run init",
    });
    return checks;
  }
  const connection = read.connection;

  if (connection.status === "verified") {
    checks.push({
      name: "GitHub connection",
      ok: true,
      message: `behavior repo ${connection.repo?.full_name ?? "unknown"} (verified_at ${connection.verified_at ?? "unknown"})`,
    });
  } else {
    const recordedRepair = connection.failures?.[0]?.repair;
    checks.push({
      name: "GitHub connection",
      ok: false,
      message: `status=${connection.status}; ${recordedRepair || "re-run npm run init (connect-GitHub repair path)"}`,
    });
  }

  if (connection.connection_mode === "real") {
    checks.push({ name: "GitHub connection mode", ok: true, message: "local ambient GitHub connection" });
  } else {
    checks.push({
      name: "GitHub connection mode",
      ok: false,
      message:
        "DRY-RUN GitHub connection — recorded intents only, adoption is NOT complete. Re-run npm run github:init without --github-dry-run.",
    });
  }

  const remoteShape = evaluateRemoteShapeCheck({ repoRoot, runGit, connection });
  checks.push(remoteShape);

  const owner = connection.repo?.owner;
  const repoName = connection.repo?.name;

  if (connection.connection_mode === "real" && remoteShape.ok) {
    const effectiveTransport = transport || createLocalAmbientGitHubSetupTransport({ repoRoot, now: () => new Date() });
    try {
      const repoLookup = await effectiveTransport.request({
        endpointId: "get_repository",
        owner,
        repo: repoName,
        params: {},
      });
      checks.push({
        name: "GitHub behavior repo reachable",
        ok: repoLookup.exists === true,
        message: repoLookup.exists === true
          ? `${owner}/${repoName} reachable with local gh auth`
          : `${owner}/${repoName} was not reachable with local gh auth; run gh auth login or fix origin`,
      });
    } catch (error) {
      checks.push({
        name: "GitHub behavior repo reachable",
        ok: false,
        message: `${error.message}; run gh auth login or fix the behavior repo access`,
      });
    }
    checks.push(evaluateLocalGitWriteCheck({ repoRoot, runGit, connection }));
  } else if (connection.connection_mode === "real") {
    checks.push({
      name: "GitHub behavior repo reachable",
      ok: false,
      message: "skipped until the local origin matches the recorded behavior repo",
    });
    checks.push({
      name: "GitHub local write auth",
      ok: false,
      message: "skipped until the local origin matches the recorded behavior repo",
    });
  }

  return checks;
}

function evaluateRemoteShapeCheck({ repoRoot, runGit, connection }) {
  const name = "GitHub remote shape";
  const expectedOrigin = connection.remotes?.origin?.url ?? null;
  const expectedUpstream = connection.remotes?.upstream?.url ?? null;
  if (!expectedOrigin) {
    return {
      name,
      ok: false,
      message: "no origin recorded in the GitHub connection state; re-run npm run init",
    };
  }
  if (connection.remotes?.origin?.applied === false) {
    return {
      name,
      ok: false,
      message: `origin not applied (dry-run planned only: origin -> ${expectedOrigin}${expectedUpstream ? `, upstream -> ${expectedUpstream}` : ""}); re-run npm run github:init without --github-dry-run to set remotes`,
    };
  }
  const listing = listGitRemotes({ repoRoot, runGit });
  if (!listing.ok) {
    return { name, ok: false, message: `${listing.reason}; run doctor from the adopter checkout root` };
  }
  const actualOrigin = listing.remotes.find((remote) => remote.name === "origin")?.url ?? null;
  const actualUpstream = listing.remotes.find((remote) => remote.name === "upstream")?.url ?? null;
  const originOk = actualOrigin && normalizeGitRemoteUrl(actualOrigin) === normalizeGitRemoteUrl(expectedOrigin);
  const upstreamOk = !expectedUpstream
    || (actualUpstream && normalizeGitRemoteUrl(actualUpstream) === normalizeGitRemoteUrl(expectedUpstream));
  if (originOk && upstreamOk) {
    return {
      name,
      ok: true,
      message: `origin -> ${actualOrigin}${expectedUpstream ? `, upstream -> ${actualUpstream}` : " (no starter upstream)"}`,
    };
  }
  const problems = [];
  if (!originOk) {
    problems.push(
      `origin is ${actualOrigin ?? "missing"}, expected the behavior repo ${expectedOrigin}; repair: git remote ${actualOrigin ? "set-url" : "add"} origin ${expectedOrigin}`,
    );
  }
  if (!upstreamOk) {
    problems.push(
      `upstream is ${actualUpstream ?? "missing"}, expected the preserved starter remote ${expectedUpstream}; repair: git remote ${actualUpstream ? "set-url" : "add"} upstream ${expectedUpstream}`,
    );
  }
  return { name, ok: false, message: `remote drift: ${problems.join("; ")} (or re-run npm run init)` };
}

function evaluateLocalGitWriteCheck({ repoRoot, runGit, connection }) {
  const branch = "refs/heads/teami/doctor-write-check";
  const result = runGit(["push", "--dry-run", "origin", `HEAD:${branch}`], {
    cwd: repoRoot,
    env: promptDisabledEnv({}, { pushAuth: connection.push_auth }),
  });
  if (result.ok) {
    return {
      name: "GitHub local write auth",
      ok: true,
      message: `git push --dry-run can create a behavior branch via ${connection.push_auth || "https"} auth`,
    };
  }
  return {
    name: "GitHub local write auth",
    ok: false,
    message: `${result.stderr.trim() || result.stdout.trim() || "git push --dry-run failed"}; fix local git credentials for origin and re-run npm run doctor`,
  };
}
