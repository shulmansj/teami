#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  runBoundedGit,
  runBoundedSubprocess,
} from "../execution/integrations/git/bounded-subprocess.mjs";
import { loadLinearConfig } from "../execution/integrations/linear/src/config.mjs";
import { buildDomainContext } from "../execution/integrations/linear/src/domain-resolver.mjs";
import { readDomainRegistry } from "../execution/integrations/linear/src/domain-registry.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../execution/integrations/linear/src/linear-credential-store.mjs";
import {
  createLinearSetupGraphqlClient,
  revokeLinearOAuthTokenSet,
} from "../execution/integrations/linear/src/linear-setup-auth.mjs";
import {
  assertDisposableCanaryHome,
  classifyExactGitHubRepoLookupFailure,
  exactGitHubRepoLookup,
  readCanaryCleanupReceipt,
  verifyAndFinalizeCanaryCleanup,
  writeCanaryCleanupReceipt,
} from "./canary-cleanup-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const options = parseArgs(process.argv.slice(2));
assertDisposableHome(options.home);
if (options.verifyCleanup) {
  const cleanup = await runCleanupVerification(options);
  emit({ canary: "mcp_linear_setup_contract", ...cleanup });
  process.exit(cleanup.ok ? 0 : 2);
}
fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });
if (!options.setupId && fs.readdirSync(options.home).length > 0) {
  throw new Error("linear_canary_home_must_start_empty");
}
writeCanaryCleanupReceipt({
  home: options.home,
  domainName: options.domain,
  githubRepo: `${options.githubOwner}/${options.githubRepo}`,
});
assertResumableSession(options);
const canaryWorkspace = await ensureDisposableBehaviorWorkspace(options);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "execution", "integrations", "linear", "mcp-server.mjs")],
  cwd: canaryWorkspace,
  env: {
    ...process.env,
    TEAMI_HOME: options.home,
    CLAUDE_CONFIG_DIR: path.join(options.home, "claude-config"),
    GIT_TERMINAL_PROMPT: "0",
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "teami-live-setup-canary", version: "1.0.0" },
  { capabilities: {} },
);
let stderrBytes = 0;
transport.stderr?.on("data", (chunk) => {
  stderrBytes += Buffer.byteLength(chunk);
});

await client.connect(transport);
try {
  let result;
  if (options.setupId) {
    emit({ event: "resuming_setup", setup_id: options.setupId });
    result = content(await callInit({ setup_id: options.setupId }));
  } else {
    const needs = content(await callInit({}));
    const disclosure = needs.disclosure;
    if (needs.status !== "consent_required" || !disclosure?.version || !disclosure?.hash) {
      throw new Error("linear_canary_disclosure_contract_mismatch");
    }
    emit({
      event: "disclosure_verified",
      disclosure_version: disclosure.version,
      effect_ids: disclosure.effects?.map((effect) => effect.id) || [],
    });

    const setupArgs = {
      domain: options.domain,
      repo_intent: { mode: "non_code" },
      confirm: true,
      disclosure_version: disclosure.version,
      disclosure_hash: disclosure.hash,
      github_owner: options.githubOwner,
      github_repo: options.githubRepo,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    };
    result = content(await callInit(setupArgs));
  }
  let adminConfirmed = false;
  let lastAuthorizationFingerprint = null;
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    if (result.status === "awaiting_authorization") {
      const authorizationFingerprint = JSON.stringify([
        result.authorization?.kind || "linear_app",
        result.authorization_url || null,
        result.authorization?.expires_at || null,
      ]);
      if (authorizationFingerprint !== lastAuthorizationFingerprint) {
        emit({
          event: "awaiting_authorization",
          kind: result.authorization?.kind || "linear_app",
          setup_id: result.setup_id,
          authorization_url: result.authorization_url,
          expires_at: result.authorization?.expires_at || null,
          browser_opened: result.authorization?.browser_opened ?? null,
          recovery: result.recovery || null,
        });
        lastAuthorizationFingerprint = authorizationFingerprint;
      }
      await waitForNextPoll(deadline);
      result = content(await callInit({ setup_id: result.setup_id }));
      continue;
    }

    if (result.status === "admin_consent_required" && !adminConfirmed) {
      if (!options.confirmOneShotAdmin) {
        throw new Error("linear_canary_admin_confirmation_flag_required");
      }
      emit({
        event: "one_shot_admin_confirmation_applied",
        setup_id: result.setup_id,
        disclosure: result.disclosure || null,
      });
      adminConfirmed = true;
      result = content(await callInit({ setup_id: result.setup_id, admin_confirm: true }));
      continue;
    }

    if (result.ok === true && result.status === "complete") {
      const cleanup = recordCleanupRequired({ options, setupId: result.setup_id });
      emit({
        ok: false,
        canary: "mcp_linear_setup_contract",
        status: "cleanup_required",
        setup_verified: true,
        setup_id: result.setup_id,
        health: sanitizedHealthSummary(result.health),
        cleanup,
        isolated_claude_config: true,
        stderr_bytes_discarded: stderrBytes,
      });
      process.exitCode = 2;
      break;
    }

    const cleanup = recordCleanupRequired({ options, setupId: result.setup_id });
    emit({
      ok: false,
      canary: "mcp_linear_setup_contract",
      status: result.status || "unknown",
      reason: result.reason || result.error?.code || "setup_not_complete",
      repair: result.repair || result.next_steps || null,
      setup_id: result.setup_id || null,
      stderr_bytes_discarded: stderrBytes,
      ...(cleanup ? { cleanup } : {}),
    });
    process.exitCode = 1;
    break;
  }
} finally {
  await client.close();
}

async function callInit(args) {
  return withTimeout(
    client.callTool({ name: "init_onboarding", arguments: args }),
    options.callTimeoutMs,
    "mcp_init_onboarding_timeout",
  );
}

function content(result) {
  if (!result?.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error("linear_canary_mcp_structured_content_missing");
  }
  return result.structuredContent;
}

function sanitizedHealthSummary(health) {
  return {
    status: health?.status || "unknown",
    reason: health?.reason || null,
    steps: Array.isArray(health?.steps) ? health.steps.map((step) => ({
      phase: step.phase,
      status: step.status,
      source: step.source,
      observed_at: step.observed_at,
      reason: step.reason || null,
      repair: step.repair || null,
    })) : [],
  };
}

async function waitForNextPoll(deadline) {
  if (Date.now() >= deadline) throw new Error("linear_canary_overall_timeout");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

function withTimeout(promise, timeoutMs, reason) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseArgs(argv) {
  const parsed = {
    domain: null,
    workspace: null,
    githubOwner: null,
    githubRepo: null,
    home: null,
    setupId: null,
    confirmDisposable: false,
    confirmOneShotAdmin: false,
    verifyCleanup: false,
    timeoutMs: 15 * 60 * 1_000,
    callTimeoutMs: 5 * 60 * 1_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--domain") parsed.domain = requireValue(argv, ++index, arg);
    else if (arg === "--workspace") parsed.workspace = requireValue(argv, ++index, arg);
    else if (arg === "--github-owner") parsed.githubOwner = requireValue(argv, ++index, arg);
    else if (arg === "--github-repo") parsed.githubRepo = requireValue(argv, ++index, arg);
    else if (arg === "--home") parsed.home = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === "--setup-id") parsed.setupId = requireValue(argv, ++index, arg);
    else if (arg === "--confirm-disposable-linear") parsed.confirmDisposable = true;
    else if (arg === "--confirm-one-shot-admin") parsed.confirmOneShotAdmin = true;
    else if (arg === "--verify-cleanup") parsed.verifyCleanup = true;
    else throw new Error(`unknown_linear_canary_flag:${arg}`);
  }
  if (!parsed.confirmDisposable) throw new Error("linear_canary_requires_confirm_disposable_linear");
  if (parsed.verifyCleanup) {
    if (!parsed.home) throw new Error("linear_canary_requires_home");
    return parsed;
  }
  for (const [name, value] of [
    ["domain", parsed.domain],
    ["github-owner", parsed.githubOwner],
    ["github-repo", parsed.githubRepo],
    ["home", parsed.home],
  ]) {
    if (!value) throw new Error(`linear_canary_requires_${name}`);
  }
  return parsed;
}

function recordCleanupRequired({ options, setupId } = {}) {
  const registry = readDomainRegistry({ home: options.home });
  const domain = registry?.domains?.find((candidate) =>
    candidate.id === options.domain || candidate.adopter_provided_name === options.domain);
  if (!domain?.linear?.team_id || !setupId) return null;
  return writeCanaryCleanupReceipt({
    home: options.home,
    setupId,
    domainId: domain.id,
    domainName: options.domain,
    linearTeam: {
      id: domain.linear.team_id,
      key: domain.linear.team_key,
      name: domain.linear.team_name,
    },
    githubRepo: `${options.githubOwner}/${options.githubRepo}`,
  });
}

async function runCleanupVerification({ home } = {}) {
  let receipt = readCanaryCleanupReceipt(home);
  const config = loadLinearConfig({ repoRoot });
  const registry = readDomainRegistry({ home });
  const domain = registry?.domains?.find((candidate) =>
    candidate.id === receipt.domain_id || candidate.adopter_provided_name === receipt.domain_name);
  if (domain?.linear?.team_id && !receipt.linear_team?.id) {
    receipt = writeCanaryCleanupReceipt({
      home,
      setupId: receipt.setup_id,
      domainId: domain.id,
      domainName: receipt.domain_name,
      linearTeam: {
        id: domain.linear.team_id,
        key: domain.linear.team_key,
        name: domain.linear.team_name,
      },
      githubRepo: receipt.github_repo,
    });
  }
  const credentialStore = domain
    ? createLinearCredentialStore({
        config,
        repoRoot,
        domainContext: buildDomainContext({ domain, config, repoRoot, home }),
      })
    : createLinearCredentialStore({
        config,
        repoRoot,
        target: legacyCredentialTargetForConfig(config),
      });
  const setupAuth = createLinearSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  });
  return verifyAndFinalizeCanaryCleanup({
    receipt,
    listLinearTeams: () => setupAuth.client.listTeams(),
    listGitHubRepos: async () => {
      const auth = await runBoundedSubprocess({
        command: "gh",
        args: ["auth", "status", "--json", "hosts"],
        operation: "gh_auth_read",
        cwd: repoRoot,
      });
      if (!auth.ok) throw new Error(`linear_canary_cleanup_github_auth_failed:${auth.outcome}`);
      let activeAuth;
      try {
        const hosts = JSON.parse(auth.stdout)?.hosts?.["github.com"] || [];
        activeAuth = hosts.find((entry) => entry?.active === true && entry?.state === "success");
      } catch {
        activeAuth = null;
      }
      if (!activeAuth?.login) throw new Error("linear_canary_cleanup_github_active_auth_unverified");
      const exact = await runBoundedSubprocess({
        command: "gh",
        args: ["repo", "view", receipt.github_repo, "--json", "nameWithOwner"],
        operation: "gh_api_read",
        cwd: repoRoot,
        classifyFailure: classifyExactGitHubRepoLookupFailure,
      });
      return exactGitHubRepoLookup(exact, receipt.github_repo, {
        authenticatedLogin: activeAuth.login,
        authenticatedScopes: String(activeAuth.scopes || "").split(","),
      });
    },
    recordRemoteAbsence: async ({ linearAbsent, githubAbsent }) => {
      const verifiedAt = new Date().toISOString();
      receipt = writeCanaryCleanupReceipt({
        home,
        setupId: receipt.setup_id,
        domainId: receipt.domain_id,
        domainName: receipt.domain_name,
        linearTeam: receipt.linear_team,
        githubRepo: receipt.github_repo,
        linearAbsenceVerifiedAt: linearAbsent ? verifiedAt : null,
        githubAbsenceVerifiedAt: githubAbsent ? verifiedAt : null,
      });
    },
    recordOAuthRevocation: async () => {
      receipt = writeCanaryCleanupReceipt({
        home,
        setupId: receipt.setup_id,
        domainId: receipt.domain_id,
        domainName: receipt.domain_name,
        linearTeam: receipt.linear_team,
        githubRepo: receipt.github_repo,
        oauthRevocationVerifiedAt: new Date().toISOString(),
      });
    },
    revokeLocalCredential: async () => {
      const tokenSet = await credentialStore.readTokenSet();
      return tokenSet ? revokeLinearOAuthTokenSet({ tokenSet }) : { revokeVerified: false };
    },
    deleteLocalCredential: () => credentialStore.deleteTokenSet(),
    removeCanaryHome: async () => {
      assertDisposableHome(home);
      fs.rmSync(home, { recursive: true, force: true });
    },
  });
}

function assertDisposableHome(home) {
  return assertDisposableCanaryHome(home);
}

function assertResumableSession({ home, setupId }) {
  if (!setupId) return;
  if (!/^[0-9a-f-]{36}$/i.test(setupId)) throw new Error("linear_canary_setup_id_invalid");
  const sessionPath = path.join(home, "setup", "sessions", `${setupId}.json`);
  if (!fs.existsSync(sessionPath)) throw new Error("linear_canary_resume_session_missing");
}

async function ensureDisposableBehaviorWorkspace({ home, githubOwner, githubRepo }) {
  const workspace = path.join(home, "behavior-workspace");
  const gitDir = path.join(workspace, ".git");
  if (fs.existsSync(gitDir)) return workspace;
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) {
    throw new Error("linear_canary_behavior_workspace_not_empty");
  }
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    [
      "# Disposable Teami setup canary",
      "",
      `Target: ${githubOwner}/${githubRepo}`,
      "",
      "This private repository is created only for the live setup contract canary and must be deleted after verification.",
      "",
    ].join("\n"),
    "utf8",
  );
  await requireGit(["init", "--initial-branch=main"], workspace, "linear_canary_git_init_failed");
  await requireGit(["add", "--", "README.md"], workspace, "linear_canary_git_add_failed");
  await requireGit([
    "-c", "user.name=Teami Setup Canary",
    "-c", "user.email=teami-canary@example.invalid",
    "commit", "-m", "Initialize disposable Teami setup canary",
  ], workspace, "linear_canary_git_commit_failed");
  return workspace;
}

async function requireGit(args, cwd, reason) {
  const result = await runBoundedGit(args, { cwd });
  if (!result.ok) throw new Error(`${reason}:${result.outcome}`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`missing_value:${flag}`);
  return value;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
