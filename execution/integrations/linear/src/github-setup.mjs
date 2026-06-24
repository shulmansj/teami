import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { findTokenShapedContent } from "./eval-content-gate.mjs";
import { createGitHubInstallationTokenAskPass } from "./github-askpass.mjs";
import { browserOpenInvocation } from "./linear-oauth.mjs";
import { defaultRunGit } from "./promotion-workspace.mjs";

// GitHub repo creation/connection for `npm run init` + `doctor` (step 11).
// The CLI defaults to the real setup transport. Dry-run remains available as an
// explicit rehearsal path and records intents only. The real setup transport
// separates credentials: repo creation uses the operator setup path, while
// push/verification use broker-minted GitHub App installation tokens.
//
// SETUP CREDENTIAL CUSTODY DESIGN (documented for the real transport;
// CONSTRAINTS #22/#23, plan ~449-468, PHOENIX-CAPABILITIES Q10):
// - ONE-TIME SETUP GRANT (repo creation + App install): a SEPARATE,
//   higher-privilege credential path from the steady-state App. The real
//   transport acquires it interactively at init time — GitHub device flow
//   (preferred) or a short-lived PAT pasted by the operator — and holds it
//   ONLY in process memory or OS-native custody (Windows Credential Manager
//   via the linear-credential-store.mjs CredRead/CredWrite P/Invoke pattern,
//   target name hashed from app identity + repoRoot) for the duration of
//   setup. After use the grant is REVOKED through the transport
//   (revoke_setup_grant -> DELETE /applications/{client_id}/grant or PAT
//   deletion) and the revocation must be CONFIRMED: "forgetting" the token
//   locally is not revocation, and an unconfirmed revocation fails init SAFE
//   with an exact cleanup repair (plan error row ~1899).
// - STEADY-STATE: the hosted Agentic Factory token broker owns the GitHub App
//   private key and mints short-lived installation tokens scoped to the
//   selected behavior repo with EXACTLY metadata:read, contents:read/write,
//   pull_requests:read/write — no issues/comments, no workflows, and NEVER
//   repo-administration (CONSTRAINTS #23). Tokens live only in local
//   credential custody while active and are never committed, traced, logged,
//   or exposed to the hosted inbox, Linear, Phoenix, model providers, or
//   proposal evidence (findSecretContentKeys/redactOAuthSecrets at every
//   boundary). Broker unavailable -> GitHub work fails closed and stays
//   pending (CONSTRAINTS #22/#26).
// - The setup transport here is deliberately SEPARATE from the steady-state
//   promotion transport in github-promotion-client.mjs: different credential
//   paths, different endpoint allowlists, different lifetimes. Endpoints
//   below carry an explicit credential_path marker so the separation stays
//   reviewable.

export const GITHUB_CONNECTION_SCHEMA_VERSION = "agentic-factory-github-connection/v1";

export const DEFAULT_BEHAVIOR_REPO_NAME = "agentic-factory";
export const DRY_RUN_OWNER_PLACEHOLDER = "your-github-owner";
export const GITHUB_APP_SLUG_PLACEHOLDER = "your-github-app-slug";
export const GITHUB_APP_ID_PLACEHOLDER = "your-github-app-id";

// Steady-state GitHub App permission contract (CONSTRAINTS #23): exactly
// metadata:read, contents:read/write, pull_requests:read/write. GitHub
// represents read/write as "write" (write implies read). Anything missing,
// at the wrong level, or EXTRA (issues, administration, workflows, ...)
// fails verification.
export const STEADY_STATE_APP_PERMISSIONS = Object.freeze({
  metadata: "read",
  contents: "write",
  pull_requests: "write",
});

const SECRET_FILE_NAME_PATTERN =
  /(^\.env(?:\.|$)|(^|[_\-.])(token|secret|api[_\-.]?key|authorization|password|passwd|credential|private[_\-.]?key|oauth|client[_\-.]?secret|cookie|session[_\-.]?key)(?:$|\.(?:env|json|ya?ml|toml|ini|conf|cfg|pem|key|p12|pfx|crt|txt)$))/i;

export const GITHUB_CONNECTION_STATUSES = Object.freeze([
  "verified",
  "setup_conflict",
  "pending_org_approval",
  "pending_app_approval",
  "failed",
  "failed_revocation_unconfirmed",
]);

export const DRY_RUN_GITHUB_SETUP_BANNER = Object.freeze([
  "============================================================",
  "DRY-RUN GITHUB SETUP — no real GitHub I/O",
  "No repository is created, no GitHub App is installed, no token",
  "is minted or stored, and no `git push` happens. Every GitHub",
  "side effect below is a RECORDED INTENT only, and the connection",
  "is written with connection_mode=dry_run — this is NOT a",
  "completed adoption. Configure the broker-backed GitHub setup transport",
  "(repo creation grant + App + token broker) and re-run without",
  "`--github-dry-run` to complete adoption.",
  "============================================================",
]);

const GITHUB_VISIBLE_PROGRESS_PREFIX = "GitHub progress:";

// Endpoint allowlist for the SETUP transport. credential_path documents which
// credential each call rides on: the one-time setup grant or the steady-state
// App installation (via broker-minted tokens). push_initial_branch is the
// push_initial_branch is the initial behavior-repo push. Dry-run transports
// record the intent; real transports push with a broker-minted App token.
export const GITHUB_SETUP_ENDPOINT_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "get_repository",
    method: "GET",
    path: "/repos/{owner}/{repo}",
    credential_path: "setup_grant",
  }),
  Object.freeze({
    id: "create_repository",
    method: "POST",
    path: "/orgs/{owner}/repos | /user/repos",
    credential_path: "setup_grant",
  }),
  Object.freeze({
    id: "get_app_installation",
    method: "GET",
    path: "/repos/{owner}/{repo}/installation",
    credential_path: "setup_grant",
  }),
  Object.freeze({
    id: "install_app",
    method: "POST",
    path: "app installation flow for the selected repo only",
    credential_path: "setup_grant",
  }),
  Object.freeze({
    id: "push_initial_branch",
    method: "RECORDED_PUSH",
    path: "git push origin <default_branch>",
    credential_path: "steady_state_app",
  }),
  Object.freeze({
    id: "verify_default_branch",
    method: "GET",
    path: "/repos/{owner}/{repo}/branches/{branch}",
    credential_path: "steady_state_app",
  }),
  Object.freeze({
    id: "probe_branch_create_capability",
    method: "GET",
    path: "/repos/{owner}/{repo}/installation (permissions.contents lookup)",
    credential_path: "steady_state_app",
  }),
  Object.freeze({
    id: "probe_pr_create_capability",
    method: "GET",
    path: "/repos/{owner}/{repo}/installation (permissions.pull_requests lookup)",
    credential_path: "steady_state_app",
  }),
  Object.freeze({
    id: "revoke_setup_grant",
    method: "DELETE",
    path: "/applications/{client_id}/grant (or setup PAT deletion)",
    credential_path: "setup_grant",
  }),
]);

const CREATED_REPO_RESUMABLE_FAILURE_REASONS = new Set([
  "github_app_install_intent_failed",
  "github_app_installation_callback_timeout",
  "github_install_status_failed",
  "github_broker_credential_issue_failed",
  "github_app_installation_lookup_failed",
  "github_app_installation_pending_approval",
  "github_app_not_installed",
  "github_app_permissions_not_exact",
  "git_remote_apply_failed",
  "git_remote_apply_verification_failed",
  "initial_push_blocked_token_shaped_content",
  "token_or_secret_like",
  "git_ls_files_failed",
  "default_branch_unresolvable",
  "initial_branch_push_failed",
  "initial_branch_push_unverified",
  "setup_grant_revocation_unconfirmed",
  "pr_generation_verification_failed",
  "pr_generation_unverified",
  "github_connection_state_write_failed",
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
        case "get_app_installation":
          return {
            dry_run: true,
            installed: true,
            installation: {
              id: "dry-run-installation-1",
              app_slug: params.app_slug || GITHUB_APP_SLUG_PLACEHOLDER,
              permissions: { ...STEADY_STATE_APP_PERMISSIONS },
              repository_selection: "selected",
              selected_repository_ids: [`dry-run:${owner}/${repo}`],
              selected_repository_full_names: [`${owner}/${repo}`],
            },
          };
        case "install_app":
          return {
            dry_run: true,
            installed: true,
            installation: {
              id: "dry-run-installation-1",
              app_slug: params.app_slug || GITHUB_APP_SLUG_PLACEHOLDER,
              permissions: { ...STEADY_STATE_APP_PERMISSIONS },
              repository_selection: "selected",
              selected_repository_ids: [`dry-run:${owner}/${repo}`],
              selected_repository_full_names: [`${owner}/${repo}`],
            },
          };
        case "push_initial_branch":
          return {
            dry_run: true,
            pushed: false,
            recorded: true,
            branch: params.branch,
            head_sha: params.head_sha ?? null,
            todo: "Dry-run GitHub setup: re-run without --github-dry-run after the broker-backed App installation is configured.",
          };
        case "verify_default_branch":
          return {
            dry_run: true,
            verified: true,
            default_branch: params.branch,
            head_sha: params.head_sha ?? null,
          };
        case "probe_branch_create_capability":
          return { dry_run: true, capable: true, derived_from: "app_permission_lookup:contents" };
        case "probe_pr_create_capability":
          return { dry_run: true, capable: true, derived_from: "app_permission_lookup:pull_requests" };
        case "revoke_setup_grant":
          return { dry_run: true, revoked: true, confirmed: true, revoked_at: now().toISOString() };
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
  repositorySelection = "selected",
  selectedRepositoryIds = null,
  selectedRepositoryFullNames = null,
  creationOutcome = "created", // created | org_approval_required | blocked
  appInstalled = true,
  appPermissions = { ...STEADY_STATE_APP_PERMISSIONS },
  installOutcome = "installed", // installed | approval_required
  installationId = "mock-installation-77",
  appSlug = GITHUB_APP_SLUG_PLACEHOLDER,
  pushVerified = true,
  branchCreateCapable = true,
  prCreateCapable = true,
  revoke = { revoked: true, confirmed: true },
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
  const selectedIds = selectedRepositoryIds || [repositoryId];
  const installation = {
    id: installationId,
    app_slug: appSlug,
    permissions: appPermissions,
    repository_selection: repositorySelection,
    selected_repository_ids: selectedIds,
  };
  const installationFor = (owner, repo) => ({
    ...installation,
    selected_repository_full_names: selectedRepositoryFullNames || [`${owner}/${repo}`],
  });
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
        case "get_app_installation":
          return appInstalled
            ? { installed: true, installation: installationFor(owner, repo) }
            : { installed: false, installation: null };
        case "install_app":
          if (installOutcome === "approval_required") {
            return {
              installed: false,
              pending: "approval_required",
              detail: `organization ${owner} requires owner approval to install the ${appSlug} GitHub App`,
            };
          }
          return { installed: true, installation: installationFor(owner, repo) };
        case "push_initial_branch":
          return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha ?? null };
        case "verify_default_branch":
          return {
            verified: pushVerified,
            default_branch: params.branch,
            head_sha: params.head_sha ?? null,
            ...(pushVerified ? {} : { detail: "default branch not found on the remote" }),
          };
        case "probe_branch_create_capability":
          return { capable: branchCreateCapable, derived_from: "app_permission_lookup:contents" };
        case "probe_pr_create_capability":
          return { capable: prCreateCapable, derived_from: "app_permission_lookup:pull_requests" };
        case "revoke_setup_grant":
          return { ...revoke, revoked_at: revoke.revoked ? now().toISOString() : null };
        default:
          throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
      }
    },
  };
}

export function defaultRunCommand(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
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

// Real setup transport. It deliberately separates credentials:
// - repo creation uses the operator's GitHub CLI setup session (never stored by
//   Agentic Factory and never used for steady-state promotion work);
// - App verification, branch push, and PR capability probes use only
//   broker-minted short-lived GitHub App installation tokens.
export function createRealGitHubSetupTransport({
  brokerClient = null,
  runCommand = defaultRunCommand,
  repoRoot = process.cwd(),
  now = () => new Date(),
} = {}) {
  if (!brokerClient || typeof brokerClient.verifyInstallation !== "function" || typeof brokerClient.mintInstallationToken !== "function") {
    throw new Error("github_setup_not_configured: configure the hosted GitHub token broker client before using real GitHub setup");
  }
  const calls = [];
  const ghJson = (args, { missingOk = false } = {}) => {
    const result = runCommand("gh", args);
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (missingOk && /not found|could not resolve|HTTP 404/i.test(detail)) return null;
      throw new Error(detail || `gh ${args.join(" ")} failed`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  return {
    kind: "real",
    calls,
    async request({ endpointId, owner, repo, params = {} }) {
      assertSetupEndpointAllowlisted(endpointId);
      calls.push({ endpointId, owner, repo, params: safeSetupParams(params), at: now().toISOString() });
      switch (endpointId) {
        case "get_repository": {
          const data = ghJson(["repo", "view", `${owner}/${repo}`, "--json", "id,nameWithOwner,visibility,url,defaultBranchRef"], { missingOk: true });
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
          ]);
          if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || "gh repo create failed");
          const data = ghJson(["repo", "view", `${owner}/${repo}`, "--json", "id,nameWithOwner,visibility,url,defaultBranchRef"]);
          return { created: true, repo: normalizeGhRepo(data, owner, repo) };
        }
        case "get_app_installation": {
          try {
            const verified = await brokerClient.verifyInstallation({
              owner,
              repo,
              appSlug: params.app_slug,
              appId: params.app_id,
            });
            return {
              installed: true,
              installation: {
                id: verified.installation.id,
                app_slug: verified.installation.app_slug || params.app_slug,
                permissions: verified.installation.permissions,
                repository_selection: verified.installation.repository_selection ?? verified.repository_selection ?? null,
                selected_repository_ids: verified.installation.selected_repository_ids ?? verified.selected_repository_ids ?? null,
                selected_repository_full_names:
                  verified.installation.selected_repository_full_names ?? verified.selected_repository_full_names ?? null,
              },
            };
          } catch (error) {
            if (/404|not found|installation/i.test(error.message)) return { installed: false, installation: null };
            throw error;
          }
        }
        case "install_app":
          if (!params.app_slug) {
            throw new Error("github_app_identity_not_configured: set github.app_slug and github.app_id before installing the Agentic Factory GitHub App");
          }
          return {
            installed: false,
            pending: "approval_required",
            detail: `Install the GitHub App ${params.app_slug} on ${owner}/${repo}, selected repository only.`,
            install_url: `https://github.com/apps/${params.app_slug}/installations/new`,
          };
        case "push_initial_branch": {
          const token = await brokerClient.mintInstallationToken({
            owner,
            repo,
            permissions: { contents: "write" },
          });
          const push = runGitWithInstallationToken({
            runCommand,
            token: token.token,
            owner,
            repo,
            branch: params.branch,
            cwd: repoRoot,
          });
          if (!push.ok) throw new Error(push.stderr.trim() || push.stdout.trim() || "git push failed");
          return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha ?? null };
        }
        case "verify_default_branch": {
          const token = await brokerClient.mintInstallationToken({
            owner,
            repo,
            permissions: { contents: "read" },
          });
          const data = await githubApiWithInstallationToken({
            runCommand,
            token: token.token,
            path: `/repos/${owner}/${repo}/branches/${params.branch}`,
          });
          return {
            verified: Boolean(data?.name),
            default_branch: data?.name ?? params.branch,
            head_sha: data?.commit?.sha ?? params.head_sha ?? null,
          };
        }
        case "probe_branch_create_capability":
          await brokerClient.mintInstallationToken({ owner, repo, permissions: { contents: "write" } });
          return { capable: true, derived_from: "broker_permission_mint:contents" };
        case "probe_pr_create_capability":
          await brokerClient.mintInstallationToken({ owner, repo, permissions: { pull_requests: "write" } });
          return { capable: true, derived_from: "broker_permission_mint:pull_requests" };
        case "revoke_setup_grant":
          return {
            revoked: false,
            confirmed: true,
            revoked_at: null,
            revocation_method: "not_applicable_existing_gh_operator_session",
            grant_retained: false,
            operator_gh_session_not_retained: true,
          };
        default:
          throw new Error(`github_setup_endpoint_not_allowlisted:${endpointId}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Local connection state (.agentic-factory/github-connection.json).
//
// This file is the LOCAL system of record for "which behavior repo this
// workspace is connected to": selected repo, owner, default branch, App
// installation id, permission snapshot, connection_mode (dry_run|real), and
// verified_at. The step 10 promotion controller resolves the behavior-repo
// identity from here (resolveBehaviorRepoIdentity); the step 12 scanner and
// step 13 supervisor read the same file.
// ---------------------------------------------------------------------------

export function githubConnectionStatePath(repoRoot = process.cwd()) {
  return path.join(repoRoot, ".agentic-factory", "github-connection.json");
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
  const selectedRepoVerification = verifySelectedRepoInstallation({
    installation: connection.app_installation,
    repo: connection.repo,
  });
  if (!selectedRepoVerification.ok) {
    return {
      ok: false,
      reason: selectedRepoVerification.reason,
      detail: selectedRepoVerification.detail ?? null,
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
  };
}

// ---------------------------------------------------------------------------
// Settings + remote detection.
// ---------------------------------------------------------------------------

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const GITHUB_APP_ID_PATTERN = /^[0-9]+$/;

function configString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPlaceholderConfigValue(value, placeholder) {
  const normalized = configString(value).toLowerCase();
  return normalized === ""
    || normalized === placeholder
    || normalized === `<${placeholder}>`;
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
  const appSlug = configString(github.app_slug);
  const appId = configString(github.app_id);
  if (connectionMode === "real") {
    const missingAppSlug = isPlaceholderConfigValue(appSlug, GITHUB_APP_SLUG_PLACEHOLDER);
    const missingAppId = isPlaceholderConfigValue(appId, GITHUB_APP_ID_PLACEHOLDER)
      || !GITHUB_APP_ID_PATTERN.test(appId);
    if (missingAppSlug || missingAppId) {
      return {
        ok: false,
        reason: "github_app_identity_not_configured",
        detail: "set github.app_slug and numeric github.app_id for the Agentic Factory GitHub App",
      };
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
    appSlug: appSlug || GITHUB_APP_SLUG_PLACEHOLDER,
    appId: appId || GITHUB_APP_ID_PLACEHOLDER,
    starterRemoteUrls,
  };
}

function formatGitHubOwnerPrompt({ defaultOwner, repoName, visibility }) {
  return [
    `  Agentic Factory needs a ${visibility} GitHub repo named "${repoName}" where generated PRs will live.`,
    `  Press Enter to create it under ${defaultOwner} (your signed-in GitHub CLI account), or type a different GitHub user/org.`,
    `  Create repo under [${defaultOwner}]: `,
  ].join("\n");
}

export function defaultResolveAuthenticatedGitHubLogin({ runCommand = defaultRunCommand } = {}) {
  let result;
  try {
    result = runCommand("gh", ["api", "user", "--jq", ".login"]);
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

// ---------------------------------------------------------------------------
// App permission verification (exact match).
// ---------------------------------------------------------------------------

export function verifyAppPermissionSnapshot(permissions = {}) {
  const missing = [];
  const wrong = [];
  for (const [key, level] of Object.entries(STEADY_STATE_APP_PERMISSIONS)) {
    if (!(key in permissions)) missing.push(key);
    else if (permissions[key] !== level) wrong.push(`${key}=${permissions[key]} (expected ${level})`);
  }
  const extra = Object.keys(permissions).filter(
    (key) => !(key in STEADY_STATE_APP_PERMISSIONS),
  );
  return {
    ok: missing.length === 0 && wrong.length === 0 && extra.length === 0,
    missing,
    wrong,
    extra,
  };
}

function describePermissionVerification(verification) {
  const parts = [];
  if (verification.missing.length > 0) parts.push(`missing: ${verification.missing.join(", ")}`);
  if (verification.wrong.length > 0) parts.push(`wrong level: ${verification.wrong.join(", ")}`);
  if (verification.extra.length > 0) {
    parts.push(
      `EXTRA (must be removed — steady-state app holds nothing beyond metadata/contents/pull_requests): ${verification.extra.join(", ")}`,
    );
  }
  return parts.join("; ");
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
    : [];
}

function verifySelectedRepoInstallation({ installation, repo }) {
  const repositorySelection = installation?.repository_selection ?? null;
  if (repositorySelection !== "selected") {
    return {
      ok: false,
      reason: "github_app_installation_not_selected_repo",
      detail: `repository_selection=${repositorySelection ?? "missing"}`,
    };
  }
  const selectedRepositoryIds = arrayOfStrings(installation?.selected_repository_ids);
  const expectedRepoId = repo?.id == null ? null : String(repo.id);
  if (expectedRepoId && selectedRepositoryIds.length > 0 && !selectedRepositoryIds.includes(expectedRepoId)) {
    return {
      ok: false,
      reason: "github_app_installation_repo_id_mismatch",
      detail: `selected repository ids do not include behavior repo id ${expectedRepoId}`,
    };
  }
  const selectedRepositoryFullNames = arrayOfStrings(installation?.selected_repository_full_names);
  const expectedFullName = repo?.full_name || (repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : null);
  if (
    expectedFullName
    && selectedRepositoryFullNames.length > 0
    && !selectedRepositoryFullNames.map((entry) => entry.toLowerCase()).includes(expectedFullName.toLowerCase())
  ) {
    return {
      ok: false,
      reason: "github_app_installation_repo_name_mismatch",
      detail: `selected repositories do not include behavior repo ${expectedFullName}`,
    };
  }
  return {
    ok: true,
    repository_selection: repositorySelection,
    selected_repository_ids: selectedRepositoryIds,
    selected_repository_full_names: selectedRepositoryFullNames,
  };
}

function describeSelectedRepoVerification(verification) {
  return verification.detail || verification.reason || "GitHub App installation is not bound to the selected behavior repo";
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

function canResumeCreatedRepoFromPreviousState({
  connectionMode,
  previousConnection,
  previousMatchesRequestedRepo,
  expectedUrl,
} = {}) {
  if (connectionMode !== "real" || !previousMatchesRequestedRepo) return false;
  if (previousConnection?.repo?.url !== expectedUrl) return false;
  if (previousConnection?.status === "pending_app_approval") return true;
  if (previousConnection?.status !== "failed") return false;
  const reasons = Array.isArray(previousConnection.failures)
    ? previousConnection.failures.map((failure) => failure?.reason).filter(Boolean)
    : [];
  return reasons.some((reason) => CREATED_REPO_RESUMABLE_FAILURE_REASONS.has(reason));
}

function canResumeEmptyRepoAfterPriorCollision({
  connectionMode,
  previousConnection,
  previousMatchesRequestedRepo,
  requestedVisibility,
  existsResponse,
} = {}) {
  if (connectionMode !== "real" || !previousMatchesRequestedRepo) return false;
  if (previousConnection?.status !== "failed") return false;
  if (existsResponse?.repo?.empty !== true) return false;
  if (existsResponse?.repo?.visibility && existsResponse.repo.visibility !== requestedVisibility) return false;
  const reasons = Array.isArray(previousConnection.failures)
    ? previousConnection.failures.map((failure) => failure?.reason).filter(Boolean)
    : [];
  return reasons.includes("behavior_repo_name_collision");
}

function safeSetupParams(params = {}) {
  const copy = { ...params };
  if (copy.token) copy.token = "[redacted]";
  return copy;
}

function runGitWithInstallationToken({ runCommand, token, owner, repo, branch, cwd = process.cwd() }) {
  const askpass = createGitHubInstallationTokenAskPass({
    token,
    tempRoot: path.join(cwd, ".agentic-factory"),
    prefix: "tmp-git-askpass-",
  });
  try {
    return runCommand("git", [
      "push",
      `https://github.com/${owner}/${repo}.git`,
      `HEAD:${branch}`,
    ], {
      cwd,
      env: {
        ...askpass.env,
      },
    });
  } finally {
    askpass.cleanup();
  }
}

async function githubApiWithInstallationToken({ runCommand, token, path: apiPath }) {
  const result = runCommand("gh", [
    "api",
    apiPath,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
  ], {
    env: { GH_TOKEN: token },
  });
  if (!result.ok) throw new Error(result.stderr.trim() || result.stdout.trim() || `gh api ${apiPath} failed`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const APP_PERMISSION_REPAIR =
  "fix the Agentic Factory GitHub App installation on the selected behavior repo to EXACTLY metadata:read, contents:read/write, pull_requests:read/write (no issues/comments, no workflows, never repo-administration), then re-run npm run init or npm run doctor";
const GITHUB_INSTALL_POLL_INTERVAL_MS = 2 * 1000;
const GITHUB_INSTALL_POLL_TIMEOUT_MS = 5 * 60 * 1000;

const CONNECT_GITHUB_REPAIR_PREFIX =
  "connect GitHub to complete adoption: ";

const REVOCATION_CLEANUP_REPAIR =
  "the one-time setup grant could NOT be confirmed revoked — revoke it manually NOW (GitHub -> Settings -> Applications -> Authorized OAuth/GitHub Apps, or delete the setup PAT under Developer settings -> Personal access tokens), then re-run npm run doctor to confirm. The setup grant must be revoked, never merely forgotten.";

function setupGrantNotApplicable(grant) {
  return grant?.revocation_method === "not_applicable_existing_gh_operator_session"
    && grant?.grant_retained === false
    && grant?.confirmed === true;
}

function setupGrantSatisfied(grant) {
  return (grant?.revoked === true && grant?.confirmed === true) || setupGrantNotApplicable(grant);
}

function formatSetupGrantCompletion(grant) {
  if (setupGrantNotApplicable(grant)) {
    return "confirmed: no Agentic Factory setup grant was minted or retained; setup used the operator's existing gh session";
  }
  return `${grant?.dry_run ? "recorded (dry-run)" : "confirmed"}: one-time setup grant revoked (never merely forgotten)`;
}

async function ensureGitHubInstallationBoundForGrant({
  settings,
  githubInstallIntent,
  githubInstallStatus,
  openBrowser,
  sleep,
  pollIntervalMs,
  pollTimeoutMs,
  onProgress,
} = {}) {
  const initialStatus = await githubInstallStatus({});
  const existingInstallationId = githubInstallationIdFromStatus(initialStatus);
  if (existingInstallationId) {
    onProgress(`found: GitHub App installation ${existingInstallationId} already bound to this setup grant`);
    return { ok: true, githubInstallationId: existingInstallationId, status: initialStatus };
  }

  const intent = await githubInstallIntent({ appSlug: settings.appSlug, owner: settings.owner, repo: settings.name });
  if (intent?.ok === false || !intent?.installUrl) {
    return {
      ok: false,
      status: "failed",
      reason: "github_app_install_intent_failed",
      detail: intent?.reason || intent?.error || "install intent did not return an install URL",
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}retry GitHub setup with a fresh self-serve setup authorization; if this persists, create a diagnostic export for support`,
    };
  }

  if (intent.flow === "authorize_existing_installation") {
    onProgress(`Authorize Agentic Factory for ${settings.fullName} in the browser. We'll detect the existing App installation automatically.`);
    onProgress(`If the browser does not open, paste this GitHub authorization URL: ${intent.installUrl}`);
  } else {
    onProgress(`Install and authorize the Agentic Factory GitHub App for ${settings.fullName} in the browser, selected repository only.`);
    onProgress(`If the browser does not open, paste this GitHub App install URL: ${intent.installUrl}`);
  }
  try {
    await openBrowser(intent.installUrl);
  } catch (error) {
    onProgress(`WARNING could not open the GitHub App install URL automatically: ${error.message}`);
  }
  onProgress("Waiting for GitHub authorization to finish...");

  const polled = await pollGitHubInstallBinding({
    githubInstallStatus,
    sleep,
    pollIntervalMs,
    pollTimeoutMs,
    onProgress,
  });
  if (polled.ok) {
    onProgress(`verified: GitHub App installation ${polled.githubInstallationId} bound to this setup grant`);
    return polled;
  }
  if (polled.reason && polled.reason !== "github_app_installation_callback_timeout") {
    return {
      ok: false,
      status: "failed",
      reason: polled.reason,
      detail: "GitHub App install status polling failed",
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}retry GitHub setup with a fresh self-serve setup authorization; if this persists, create a diagnostic export for support`,
    };
  }
  return {
    ok: false,
    status: "pending_app_approval",
    reason: "github_app_installation_callback_timeout",
    detail: `GitHub authorization did not finish for ${settings.fullName} before the timeout`,
    repair:
      `Finish the GitHub browser authorization for ${settings.fullName}, then re-run npm run init to resume.`,
  };
}

async function pollGitHubInstallBinding({
  githubInstallStatus,
  sleep,
  pollIntervalMs,
  pollTimeoutMs,
  onProgress = () => {},
} = {}) {
  const interval = Math.max(1, Number(pollIntervalMs) || GITHUB_INSTALL_POLL_INTERVAL_MS);
  const attempts = Math.max(1, Math.ceil((Number(pollTimeoutMs) || GITHUB_INSTALL_POLL_TIMEOUT_MS) / interval));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && attempt % 5 === 0) {
      const secondsRemaining = Math.ceil(((attempts - attempt) * interval) / 1000);
      onProgress(
        `${GITHUB_VISIBLE_PROGRESS_PREFIX} Still waiting for GitHub authorization (${secondsRemaining}s before setup times out). Complete the browser step, or press Ctrl+C to stop and re-run npm run init later.`,
      );
    }
    const status = await githubInstallStatus({});
    if (status?.ok === false) {
      return { ok: false, reason: status.reason || status.error || "github_install_status_failed" };
    }
    const githubInstallationId = githubInstallationIdFromStatus(status);
    if (githubInstallationId) return { ok: true, githubInstallationId, status };
    if (attempt < attempts - 1) await sleep(interval);
  }
  return { ok: false, reason: "github_app_installation_callback_timeout" };
}

function githubInstallationIdFromStatus(status = {}) {
  return optionalNonEmptyString(
    status.githubInstallationId ??
      status.github_installation_id ??
      status.grant?.githubInstallationId ??
      status.grant?.github_installation_id,
  );
}

function optionalNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function openGitHubInstallBrowser(url) {
  const invocation = browserOpenInvocation(url);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    env: invocation.env,
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`Could not open the GitHub App install URL automatically: ${error.message}. Paste this URL in your browser: ${url}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  githubInstallIntent = null,
  githubInstallStatus = null,
  issueGitHubBrokerCredential = null,
  openBrowser = openGitHubInstallBrowser,
  sleep = delay,
  installPollIntervalMs = GITHUB_INSTALL_POLL_INTERVAL_MS,
  installPollTimeoutMs = GITHUB_INSTALL_POLL_TIMEOUT_MS,
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

  const configuredOwner = configString(config?.github?.behavior_repo?.owner);
  if (connectionMode === "real" && !requestedOwner && !configuredOwner) {
    onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking the signed-in GitHub account...`);
  }
  const settings = await resolveGitHubSetupSettings({
    config,
    requestedOwner,
    requestedRepoName,
    requestedVisibility,
    connectionMode,
    isTTY,
    promptGitHubOwner,
    resolveAuthenticatedGitHubLogin,
  });
  if (!settings.ok) {
    let repair = `fix the requested behavior repo settings (${settings.detail}) and re-run npm run init`;
    if (settings.reason === "github_owner_not_selected") {
      repair = "authenticate the GitHub CLI (gh auth login) or re-run npm run init -- --github-owner <owner-or-org> (or set github.behavior_repo.owner in the config) to choose where the dedicated behavior repo is created";
    } else if (settings.reason === "github_app_identity_not_configured") {
      repair = "set github.app_slug and numeric github.app_id for the Agentic Factory GitHub App, then re-run npm run init";
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
  onProgress(`GitHub repo target: ${settings.fullName} (${settings.visibility})`);
  onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking local Git remotes...`);
  const previousConnectionRead = readGitHubConnectionState({ repoRoot, statePath: resolvedStatePath });
  const previousConnection = previousConnectionRead.ok ? previousConnectionRead.connection : null;
  const previousMatchesRequestedRepo =
    previousConnection?.connection_mode === connectionMode
    && previousConnection?.repo?.owner === settings.owner
    && previousConnection?.repo?.name === settings.name;
  const canResumeExistingCreatedRepo = canResumeCreatedRepoFromPreviousState({
    connectionMode,
    previousConnection,
    previousMatchesRequestedRepo,
    expectedUrl: settings.url,
  });
  let canResumeExistingEmptyCollisionRepo = false;

  const state = {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: connectionMode,
    status: "failed",
    adoption_complete: false,
    repo: {
      id: null,
      owner: settings.owner,
      owner_source: settings.ownerSource,
      name: settings.name,
      full_name: settings.fullName,
      visibility: settings.visibility,
      url: null,
    },
    default_branch: null,
    remotes: null,
    app_installation: null,
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    setup_grant: previousMatchesRequestedRepo ? (previousConnection?.setup_grant ?? null) : null,
    failures: [],
    verified_at: null,
    ...(connectionMode === "dry_run"
      ? {
        todo: "Dry-run GitHub connection — recorded intents only; re-run npm run github:init without --github-dry-run to complete adoption.",
      }
      : {}),
  };

  let setupGrantExercised = false;
  let revocation = null;

  const callTransport = async (endpointId, params = {}) => {
    const endpoint = GITHUB_SETUP_ENDPOINT_ALLOWLIST.find((entry) => entry.id === endpointId);
    if (endpoint?.credential_path === "setup_grant") setupGrantExercised = true;
    return effectiveTransport.request({
      endpointId,
      owner: settings.owner,
      repo: settings.name,
      params,
    });
  };

  const attemptRevocation = async () => {
    if (revocation) return revocation;
    if (!setupGrantExercised) return null;
    try {
      revocation = await callTransport("revoke_setup_grant");
    } catch (error) {
      revocation = { revoked: false, confirmed: false, error: error.message };
    }
    state.setup_grant = {
      revoked: revocation.revoked === true,
      confirmed: revocation.confirmed === true,
      revoked_at: revocation.revoked_at ?? null,
      ...(revocation.revocation_method ? { revocation_method: revocation.revocation_method } : {}),
      ...(typeof revocation.grant_retained === "boolean" ? { grant_retained: revocation.grant_retained } : {}),
      ...(typeof revocation.operator_gh_session_not_retained === "boolean"
        ? { operator_gh_session_not_retained: revocation.operator_gh_session_not_retained }
        : {}),
      ...(revocation.error ? { error: revocation.error } : {}),
      ...(revocation.dry_run ? { dry_run: true } : {}),
    };
    return revocation;
  };

  const finishFailure = async ({ status, reason, repair, detail = null, extra = {} }) => {
    // Fail-safe posture: once the setup credential has been exercised, every
    // exit path attempts to revoke the grant — a failed init must never leave
    // the higher-privilege grant behind (plan ~449-459).
    const revoked = await attemptRevocation();
    state.status = status;
    state.failures = [{ reason, repair, ...(detail ? { detail } : {}) }];
    if (revoked && !setupGrantSatisfied(revoked) && reason !== "setup_grant_revocation_unconfirmed") {
      state.failures.push({
        reason: "setup_grant_revocation_unconfirmed",
        repair: REVOCATION_CLEANUP_REPAIR,
      });
    }
    try {
      writeGitHubConnectionState({ statePath: resolvedStatePath, connection: state });
    } catch (writeError) {
      onProgress(`WARNING could not record the GitHub connection state: ${writeError.message}`);
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
  const remoteListing = listGitRemotes({ repoRoot, runGit });
  if (!remoteListing.ok) {
    return finishFailure({
      status: "failed",
      reason: remoteListing.reason,
      detail: remoteListing.detail,
      repair: "run npm run init from the root of the adopter checkout (a git repository)",
    });
  }
  const remotePlan = planRemoteLayout({
    remotes: remoteListing.remotes,
    starterRemoteUrls: settings.starterRemoteUrls,
    behaviorRepoUrl: settings.url,
  });
  if (!remotePlan.ok) {
    return finishFailure({
      status: "setup_conflict",
      reason: remotePlan.reason,
      detail: remotePlan.detail,
      repair:
        "init creates a NEW dedicated behavior repo and never adopts a pre-existing adopter-owned remote. Either remove/rename the conflicting remote (git remote rename <name> <other>) so only the starter remote remains, or run init from a fresh starter checkout; then re-run npm run init.",
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

  // ---- b. Name collision + repo creation (setup credential path) ----------
  let existsResponse;
  try {
    onProgress(`${GITHUB_VISIBLE_PROGRESS_PREFIX} Checking whether ${settings.fullName} is available on GitHub...`);
    existsResponse = await callTransport("get_repository");
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "github_repo_lookup_failed",
      detail: error.message,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify the setup credential and GitHub availability, then re-run npm run init`,
    });
  }
  canResumeExistingEmptyCollisionRepo = canResumeEmptyRepoAfterPriorCollision({
    connectionMode,
    previousConnection,
    previousMatchesRequestedRepo,
    requestedVisibility: settings.visibility,
    existsResponse,
  });
  const canResumeExistingRepo = canResumeExistingCreatedRepo || canResumeExistingEmptyCollisionRepo;
  if (existsResponse.exists === true && !remotePlan.originAlreadyBehaviorRepo && !canResumeExistingRepo) {
    return finishFailure({
      status: "failed",
      reason: "behavior_repo_name_collision",
      detail: `a repository named ${settings.fullName} already exists`,
      repair:
        `the requested behavior repo name collides with an existing GitHub repo; init never attaches to an existing repo. Re-run npm run init -- --github-repo <different-name> (suggested safe suffix: ${settings.name}-2).`,
    });
  }

  let creation = null;
  if (!(existsResponse.exists === true && (remotePlan.originAlreadyBehaviorRepo || canResumeExistingRepo))) {
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
        repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify the one-time setup credential can create repositories under ${settings.owner}, then re-run npm run init`,
      });
    }
    if (creation.pending === "org_approval_required") {
      return finishFailure({
        status: "pending_org_approval",
        reason: "behavior_repo_creation_pending_org_approval",
        detail: creation.detail ?? null,
        repair:
          `organization policy requires owner approval before the behavior repo can be created: ask the ${settings.owner} org owner to approve repository creation (or choose a different owner with --github-owner), then re-run npm run init. Init stops here rather than silently completing a partial, eval-only adoption.`,
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
    onProgress(`found: behavior repo ${settings.fullName} already ${remotePlan.originAlreadyBehaviorRepo ? "connected as origin" : "created by prior init"} (re-verifying)`);
    state.repo.id = existsResponse.repo?.id ?? previousConnection?.repo?.id ?? state.repo.id ?? null;
    state.repo.url = settings.url;
    state.repo.visibility = existsResponse.repo?.visibility ?? state.repo.visibility;
  }

  // ---- c. Steady-state App install/verify on the selected repo ONLY -------
  let installationResponse;
  const useBoundInstallFlow = connectionMode === "real" &&
    typeof githubInstallIntent === "function" &&
    typeof githubInstallStatus === "function" &&
    typeof issueGitHubBrokerCredential === "function";
  if (useBoundInstallFlow) {
    const binding = await ensureGitHubInstallationBoundForGrant({
      settings,
      githubInstallIntent,
      githubInstallStatus,
      openBrowser,
      sleep,
      pollIntervalMs: installPollIntervalMs,
      pollTimeoutMs: installPollTimeoutMs,
      onProgress,
    });
    if (!binding.ok) {
      return finishFailure({
        status: binding.status || "pending_app_approval",
        reason: binding.reason,
        detail: binding.detail ?? null,
        repair: binding.repair,
      });
    }
    try {
      await issueGitHubBrokerCredential({
        owner: settings.owner,
        repo: settings.name,
        installationId: binding.githubInstallationId,
      });
    } catch (error) {
      return finishFailure({
        status: "failed",
        reason: "github_broker_credential_issue_failed",
        detail: error.message,
        repair: `${CONNECT_GITHUB_REPAIR_PREFIX}complete the GitHub App install callback for ${settings.fullName}, then re-run npm run init`,
      });
    }
    try {
      installationResponse = await callTransport("get_app_installation", { app_slug: settings.appSlug, app_id: settings.appId });
    } catch (error) {
      return finishFailure({
        status: "failed",
        reason: "github_app_installation_lookup_failed",
        detail: error.message,
        repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify the Agentic Factory GitHub App is installed on ${settings.fullName}, then re-run npm run init`,
      });
    }
  } else {
    try {
      installationResponse = await callTransport("get_app_installation", { app_slug: settings.appSlug, app_id: settings.appId });
      if (installationResponse.installed !== true) {
        installationResponse = await callTransport("install_app", { app_slug: settings.appSlug, app_id: settings.appId });
      }
    } catch (error) {
      return finishFailure({
        status: "failed",
        reason: "github_app_installation_lookup_failed",
        detail: error.message,
        repair: `${CONNECT_GITHUB_REPAIR_PREFIX}install the Agentic Factory GitHub App on ${settings.fullName} and re-run npm run init`,
      });
    }
  }
  if (installationResponse.pending === "approval_required") {
    return finishFailure({
      status: "pending_app_approval",
      reason: "github_app_installation_pending_approval",
      detail: installationResponse.detail ?? null,
      repair:
        `organization policy requires owner approval to install the Agentic Factory GitHub App on ${settings.fullName}: ask the org owner to approve the installation, then re-run npm run init.`,
    });
  }
  if (installationResponse.installed !== true || !installationResponse.installation) {
    return finishFailure({
      status: "failed",
      reason: "github_app_not_installed",
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}install the Agentic Factory GitHub App on ${settings.fullName} (repo-scoped, not all-repos), then re-run npm run init`,
    });
  }
  const installation = installationResponse.installation;
  const permissionVerification = verifyAppPermissionSnapshot(installation.permissions || {});
  if (!permissionVerification.ok) {
    return finishFailure({
      status: "failed",
      reason: "github_app_permissions_not_exact",
      detail: describePermissionVerification(permissionVerification),
      repair: APP_PERMISSION_REPAIR,
      extra: { permission_verification: permissionVerification },
    });
  }
  const selectedRepoVerification = verifySelectedRepoInstallation({
    installation,
    repo: state.repo,
  });
  if (!selectedRepoVerification.ok) {
    return finishFailure({
      status: "failed",
      reason: selectedRepoVerification.reason,
      detail: describeSelectedRepoVerification(selectedRepoVerification),
      repair:
        `${CONNECT_GITHUB_REPAIR_PREFIX}install the Agentic Factory GitHub App on ${settings.fullName} as selected-repository access only, then re-run npm run init`,
      extra: { selected_repo_verification: selectedRepoVerification },
    });
  }
  state.app_installation = {
    installation_id: installation.id,
    app_slug: installation.app_slug ?? settings.appSlug,
    permission_snapshot: { ...installation.permissions },
    repository_selection: selectedRepoVerification.repository_selection,
    selected_repository_ids: selectedRepoVerification.selected_repository_ids,
    selected_repository_full_names: selectedRepoVerification.selected_repository_full_names,
    verified_exact: true,
    ...(installationResponse.dry_run ? { dry_run: true } : {}),
  };
  onProgress(
    `${installationResponse.dry_run ? "recorded (dry-run)" : "verified"}: GitHub App installation ${installation.id} with exact steady-state permissions (metadata:read, contents:read/write, pull_requests:read/write)`,
  );

  // ---- d. Set origin + pre-push sanitizer + push verify -------------------
  const remoteApply = connectionMode === "real"
    ? applyRemotePlan({ repoRoot, runGit, remotePlan, behaviorRepoUrl: settings.url })
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
  state.remotes = {
    origin: {
      url: settings.url,
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
  const defaultBranch = branchResult.stdout.trim();
  const headResult = runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  const headSha = headResult.ok ? headResult.stdout.trim() : null;

  let pushResponse;
  let branchVerification;
  try {
    pushResponse = await callTransport("push_initial_branch", {
      branch: defaultBranch,
      head_sha: headSha,
    });
    branchVerification = await callTransport("verify_default_branch", {
      branch: defaultBranch,
      head_sha: headSha,
    });
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "initial_branch_push_failed",
      detail: error.message,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify steady-state contents access to ${settings.fullName} and re-run npm run init`,
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
    ...(pushResponse.dry_run ? { dry_run: true } : {}),
  };
  onProgress(
    `${pushResponse.dry_run ? "recorded (dry-run) push intent" : "pushed"}: ${defaultBranch} @ ${headSha ?? "unknown"} (verified on remote: ${branchVerification.dry_run ? "dry-run" : "yes"})`,
  );

  // ---- b(cont). Revoke the one-time setup grant (never merely forgotten) --
  const revoked = await attemptRevocation();
  if (!setupGrantSatisfied(revoked)) {
    return finishFailure({
      status: "failed_revocation_unconfirmed",
      reason: "setup_grant_revocation_unconfirmed",
      detail: revoked?.error ?? "the transport did not confirm the revocation",
      repair: REVOCATION_CLEANUP_REPAIR,
    });
  }
  onProgress(formatSetupGrantCompletion(revoked));

  // ---- e. PR-generation verification (steady-state App lookups) -----------
  let branchProbe;
  let prProbe;
  try {
    branchProbe = await callTransport("probe_branch_create_capability");
    prProbe = await callTransport("probe_pr_create_capability");
  } catch (error) {
    return finishFailure({
      status: "failed",
      reason: "pr_generation_verification_failed",
      detail: error.message,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}verify the GitHub App installation on ${settings.fullName} grants contents:write and pull_requests:write, then re-run npm run init or npm run doctor`,
    });
  }
  if (branchProbe.capable !== true || prProbe.capable !== true) {
    return finishFailure({
      status: "failed",
      reason: "pr_generation_unverified",
      detail: `branch_create=${branchProbe.capable === true}, pr_create=${prProbe.capable === true}`,
      repair: `${CONNECT_GITHUB_REPAIR_PREFIX}the controller could not verify the required PR-generation App permissions on ${settings.fullName}; ${APP_PERMISSION_REPAIR}`,
    });
  }
  state.pr_generation = {
    verified: true,
    probes: {
      branch_create: { capable: true, derived_from: branchProbe.derived_from ?? null },
      pr_create: { capable: true, derived_from: prProbe.derived_from ?? null },
    },
    ...(branchProbe.dry_run || prProbe.dry_run ? { dry_run: true } : {}),
  };
  onProgress(
    `${state.pr_generation.dry_run ? "recorded (dry-run)" : "verified"}: PR-generation permission probe (branch create + PR create via App permission lookups/broker mint checks)`,
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
      repair: "fix the .agentic-factory/ write failure and re-run npm run init",
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
// Doctor checks (plan error rows ~1894-1901): remote shape, App permission
// exactness, PR-generation capability, connection mode, setup-grant
// revocation status — each failure names a repair action.
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
    checks.push({ name: "GitHub connection mode", ok: true, message: "real GitHub connection" });
  } else {
    checks.push({
      name: "GitHub connection mode",
      ok: false,
      message:
        "DRY-RUN GitHub connection — recorded intents only, adoption is NOT complete. Re-run npm run github:init without --github-dry-run.",
    });
  }

  checks.push(evaluateRemoteShapeCheck({ repoRoot, runGit, connection }));

  const realConnectionNeedsLiveTransport = connection.connection_mode === "real" && !transport;
  const effectiveTransport = transport || (realConnectionNeedsLiveTransport ? null : createDryRunGitHubSetupTransport());
  const owner = connection.repo?.owner;
  const repoName = connection.repo?.name;
  const dryNote = effectiveTransport?.kind === "real" ? "" : " (dry-run lookup)";
  if (!effectiveTransport) {
    checks.push({
      name: "GitHub App permissions",
      ok: false,
      message:
        "live GitHub permission lookup was not run for this real connection; configure the hosted GitHub token broker and re-run npm run doctor",
    });
    checks.push({
      name: "GitHub PR generation",
      ok: false,
      message:
        "live PR-generation capability probes were not run for this real connection; configure the hosted GitHub token broker and re-run npm run doctor",
    });
  } else {
    try {
      let installationResponse = await effectiveTransport.request({
        endpointId: "get_app_installation",
        owner,
        repo: repoName,
        params: { app_slug: connection.app_installation?.app_slug },
      });
      if (installationResponse.installed !== true || !installationResponse.installation) {
        checks.push({
          name: "GitHub App permissions",
          ok: false,
          message: `the Agentic Factory GitHub App is not installed on ${owner}/${repoName}; install it (repo-scoped) and re-run npm run doctor`,
        });
      } else {
        const verification = verifyAppPermissionSnapshot(installationResponse.installation.permissions || {});
        if (!verification.ok) {
          checks.push({
            name: "GitHub App permissions",
            ok: false,
            message: `${describePermissionVerification(verification)}; ${APP_PERMISSION_REPAIR}`,
          });
        } else {
          const snapshotDrift = JSON.stringify(connection.app_installation?.permission_snapshot ?? null)
            !== JSON.stringify(installationResponse.installation.permissions);
          checks.push({
            name: "GitHub App permissions",
            ok: !snapshotDrift,
            message: snapshotDrift
              ? `live permissions differ from the recorded snapshot; re-run npm run init to refresh the connection state${dryNote}`
              : `exact steady-state permission set verified (metadata:read, contents:read/write, pull_requests:read/write; nothing extra)${dryNote}`,
          });
        }
      }
    } catch (error) {
      checks.push({
        name: "GitHub App permissions",
        ok: false,
        message: `permission lookup failed: ${error.message}; verify the GitHub App installation on ${owner}/${repoName} and re-run npm run doctor`,
      });
    }

    try {
      const branchProbe = await effectiveTransport.request({
        endpointId: "probe_branch_create_capability",
        owner,
        repo: repoName,
        params: {},
      });
      const prProbe = await effectiveTransport.request({
        endpointId: "probe_pr_create_capability",
        owner,
        repo: repoName,
        params: {},
      });
      const capable = branchProbe.capable === true && prProbe.capable === true;
      checks.push({
        name: "GitHub PR generation",
        ok: capable,
        message: capable
          ? `controller can open promotion PRs (branch create + PR create probes)${dryNote}`
          : `PR-generation capability missing (branch_create=${branchProbe.capable === true}, pr_create=${prProbe.capable === true}); ${APP_PERMISSION_REPAIR}`,
      });
    } catch (error) {
      checks.push({
        name: "GitHub PR generation",
        ok: false,
        message: `capability probe failed: ${error.message}; verify the GitHub App installation and re-run npm run doctor`,
      });
    }
  }

  const grant = connection.setup_grant;
  if (setupGrantNotApplicable(grant)) {
    checks.push({
      name: "GitHub setup grant",
      ok: true,
      message: "not applicable: no Agentic Factory setup grant was minted or retained; setup used the operator's existing gh session",
    });
  } else if (grant?.revoked === true && grant?.confirmed === true) {
    checks.push({
      name: "GitHub setup grant",
      ok: true,
      message: `one-time setup grant revoked${grant.revoked_at ? ` at ${grant.revoked_at}` : ""}${grant.dry_run ? " (dry-run)" : ""}`,
    });
  } else {
    checks.push({
      name: "GitHub setup grant",
      ok: false,
      message: REVOCATION_CLEANUP_REPAIR,
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
