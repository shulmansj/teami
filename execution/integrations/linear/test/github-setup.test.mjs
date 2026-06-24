import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { createGitHubInstallationTokenAskPass } from "../src/github-askpass.mjs";
import * as githubSetupModule from "../src/github-setup.mjs";

const {
  createDryRunGitHubSetupTransport,
  createMockGitHubSetupTransport,
  createRealGitHubSetupTransport,
  DEFAULT_BEHAVIOR_REPO_NAME,
  DRY_RUN_OWNER_PLACEHOLDER,
  DRY_RUN_GITHUB_SETUP_BANNER,
  GITHUB_CONNECTION_SCHEMA_VERSION,
  GITHUB_SETUP_ENDPOINT_ALLOWLIST,
  applyRemotePlan,
  githubConnectionDoctorChecks,
  githubConnectionStatePath,
  normalizeGitRemoteUrl,
  planRemoteLayout,
  readGitHubConnectionState,
  resolveBehaviorRepoIdentity,
  resolveGitHubSetupSettings,
  runGitHubInitPhase,
  scanTrackedTreeForSecrets,
  STEADY_STATE_APP_PERMISSIONS,
  verifyAppPermissionSnapshot,
} = githubSetupModule;

const STARTER_URL = "https://github.com/agentic-factory/agentic-factory-starter";
const SHIPPED_SOURCE_URL = "https://github.com/shulmansj/agentic-factory";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-github-setup-"));
}

function runGitOrThrow(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function runGitResult(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function listRemotes(root) {
  const result = runGitOrThrow(["remote", "-v"], root);
  const remotes = {};
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/);
    if (match && !(match[1] in remotes)) remotes[match[1]] = match[2];
  }
  return remotes;
}

function createInMemoryRunGit({ remotes = {} } = {}) {
  const remoteMap = new Map(Object.entries(remotes));
  const formatRemotes = () => [...remoteMap.entries()]
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");
  const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ ok: false, status: 1, stdout: "", stderr });
  return (args) => {
    const [command, subcommand, name, value] = args;
    if (command === "remote" && subcommand === "-v") return ok(formatRemotes());
    if (command === "remote" && subcommand === "add") {
      remoteMap.set(name, value);
      return ok();
    }
    if (command === "remote" && subcommand === "set-url") {
      if (!remoteMap.has(name)) return fail(`remote ${name} missing`);
      remoteMap.set(name, value);
      return ok();
    }
    if (command === "remote" && subcommand === "rename") {
      if (!remoteMap.has(name)) return fail(`remote ${name} missing`);
      const existing = remoteMap.get(name);
      remoteMap.delete(name);
      remoteMap.set(value, existing);
      return ok();
    }
    if (command === "remote" && subcommand === "remove") {
      remoteMap.delete(name);
      return ok();
    }
    if (command === "ls-files" && subcommand === "-z") return ok("");
    if (command === "symbolic-ref") return ok("main\n");
    if (command === "rev-parse") return ok("abc123\n");
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
}

function askpassOutput(askpass, prompt) {
  const result = spawnSync(askpass.askpassPath, [prompt], {
    encoding: "utf8",
    env: { ...process.env, ...askpass.env },
    shell: process.platform === "win32",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initGitRepo(root, { remotes = {} } = {}) {
  runGitOrThrow(["init", "--initial-branch=main"], root);
  fs.writeFileSync(path.join(root, "README.md"), "fixture repo\n");
  runGitOrThrow(["add", "README.md"], root);
  runGitOrThrow(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@test.invalid", "commit", "-m", "init"],
    root,
  );
  for (const [name, url] of Object.entries(remotes)) {
    runGitOrThrow(["remote", "add", name, url], root);
  }
  return root;
}

function configWithStarter(overrides = {}) {
  return {
    github: {
      behavior_repo: { owner: null, name: DEFAULT_BEHAVIOR_REPO_NAME, visibility: "private" },
      starter_remote_urls: [STARTER_URL],
      app_slug: "agentic-factory",
      app_id: "123456",
      ...overrides,
    },
  };
}

async function runPhase({ root, config = configWithStarter(), transport, ...options } = {}) {
  const progress = [];
  const result = await runGitHubInitPhase({
    repoRoot: root,
    config,
    transport,
    onProgress: (line) => progress.push(line),
    ...options,
  });
  return { result, progress };
}

function verifiedRealStateFixture({
  owner = "real-owner",
  name = "real-behavior-repo",
  repoId = "repo-real-1",
  originApplied = true,
  upstreamUrl = STARTER_URL,
  permissions = { ...STEADY_STATE_APP_PERMISSIONS },
  repositorySelection = "selected",
  selectedRepositoryIds = [repoId],
  selectedRepositoryFullNames = null,
  revoked = true,
  setupGrant = null,
} = {}) {
  return {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "real",
    status: "verified",
    adoption_complete: true,
    repo: {
      id: repoId,
      owner,
      name,
      full_name: `${owner}/${name}`,
      visibility: "private",
      url: `https://github.com/${owner}/${name}`,
    },
    default_branch: "main",
    remotes: {
      origin: { url: `https://github.com/${owner}/${name}`, planned: true, applied: originApplied },
      upstream: upstreamUrl
        ? { url: upstreamUrl, preserved_from: "origin", planned: true, applied: originApplied }
        : null,
      planned_actions: [],
    },
    app_installation: {
      installation_id: "inst-1",
      app_slug: "agentic-factory",
      permission_snapshot: permissions,
      repository_selection: repositorySelection,
      selected_repository_ids: selectedRepositoryIds,
      selected_repository_full_names: selectedRepositoryFullNames || [`${owner}/${name}`],
      verified_exact: true,
    },
    push_verification: { recorded: true, pushed: true, branch: "main", head_sha: "abc", verified: true },
    pre_push_sanitizer: { scanned_count: 1, skipped_binary_count: 0, tracked_count: 1, findings: [] },
    pr_generation: { verified: true, probes: {} },
    setup_grant: setupGrant ?? { revoked, confirmed: revoked, revoked_at: revoked ? "2026-06-10T03:00:00.000Z" : null },
    failures: [],
    verified_at: "2026-06-10T03:00:00.000Z",
  };
}

function writeStateFixture(root, state) {
  const file = githubConnectionStatePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// Transports: broker-backed real path + credential-path separation.
// ---------------------------------------------------------------------------

test("the real GitHub setup transport fails closed without the hosted broker client", () => {
  assert.throws(() => createRealGitHubSetupTransport(), /github_setup_not_configured/);
});

test("real GitHub init requires adopter-owned GitHub App identity", async () => {
  const root = tempRoot();
  const mock = createMockGitHubSetupTransport();
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({
    root,
    transport,
    config: {
      github: {
        behavior_repo: { owner: "acme", name: DEFAULT_BEHAVIOR_REPO_NAME, visibility: "private" },
        starter_remote_urls: [],
        app_slug: "<your-github-app-slug>",
        app_id: "<your-github-app-id>",
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "github_app_identity_not_configured");
  assert.match(result.repair, /github\.app_slug/);
  assert.match(result.repair, /github\.app_id/);
  assert.equal(mock.calls.length, 0);
});

test("real setup resolves missing behavior repo owner from gh login, prompting in TTY and defaulting non-TTY", async () => {
  const nonTty = await resolveGitHubSetupSettings({
    config: configWithStarter(),
    connectionMode: "real",
    isTTY: false,
    resolveAuthenticatedGitHubLogin: async () => "octocat",
  });
  assert.equal(nonTty.ok, true);
  assert.equal(nonTty.owner, "octocat");
  assert.equal(nonTty.ownerSource, "gh_login");

  const prompts = [];
  const ttyDefault = await resolveGitHubSetupSettings({
    config: configWithStarter(),
    connectionMode: "real",
    isTTY: true,
    resolveAuthenticatedGitHubLogin: async () => "octocat",
    promptGitHubOwner: async (prompt) => {
      prompts.push(prompt);
      return "";
    },
  });
  assert.equal(ttyDefault.ok, true);
  assert.equal(ttyDefault.owner, "octocat");
  assert.equal(ttyDefault.ownerSource, "gh_login");
  assert.deepEqual(prompts, [{
    defaultOwner: "octocat",
    message: [
      "  Agentic Factory needs a private GitHub repo named \"agentic-factory\" where generated PRs will live.",
      "  Press Enter to create it under octocat (your signed-in GitHub CLI account), or type a different GitHub user/org.",
      "  Create repo under [octocat]: ",
    ].join("\n"),
  }]);

  const ttyOverride = await resolveGitHubSetupSettings({
    config: configWithStarter(),
    connectionMode: "real",
    isTTY: true,
    resolveAuthenticatedGitHubLogin: async () => "octocat",
    promptGitHubOwner: async () => "acme-org",
  });
  assert.equal(ttyOverride.ok, true);
  assert.equal(ttyOverride.owner, "acme-org");
  assert.equal(ttyOverride.ownerSource, "prompt");
});

test("real init emits visible progress immediately after GitHub owner selection", async () => {
  const root = tempRoot();
  const events = [];
  const transport = {
    kind: "real",
    async request({ endpointId }) {
      events.push(`transport:${endpointId}`);
      if (endpointId === "get_repository") {
        return { exists: true, repo: { visibility: "private" } };
      }
      throw new Error(`unexpected endpoint: ${endpointId}`);
    },
  };

  const result = await runGitHubInitPhase({
    repoRoot: root,
    config: configWithStarter(),
    transport,
    runGit: createInMemoryRunGit({ remotes: { upstream: STARTER_URL } }),
    isTTY: true,
    resolveAuthenticatedGitHubLogin: async () => "octocat",
    promptGitHubOwner: async () => "",
    onProgress: (line) => events.push(`progress:${line}`),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "behavior_repo_name_collision");
  const targetIndex = events.indexOf("progress:GitHub repo target: octocat/agentic-factory (private)");
  const localRemotesIndex = events.indexOf("progress:GitHub progress: Checking local Git remotes...");
  const repoCheckIndex = events.indexOf("progress:GitHub progress: Checking whether octocat/agentic-factory is available on GitHub...");
  const transportIndex = events.indexOf("transport:get_repository");
  assert.ok(targetIndex >= 0, `missing target progress: ${events.join("\n")}`);
  assert.ok(localRemotesIndex > targetIndex, `missing local-remotes progress: ${events.join("\n")}`);
  assert.ok(repoCheckIndex > localRemotesIndex, `missing repo-check progress: ${events.join("\n")}`);
  assert.ok(repoCheckIndex < transportIndex, `repo-check progress must print before network lookup: ${events.join("\n")}`);
});

test("explicit blank github owner (flag or config) fails closed, never defaults to gh login", async () => {
  for (const requestedOwner of ["", "   "]) {
    const blank = await resolveGitHubSetupSettings({
      config: configWithStarter(),
      requestedOwner,
      connectionMode: "real",
      isTTY: false,
      resolveAuthenticatedGitHubLogin: async () => "octocat",
    });
    assert.equal(blank.ok, false, `requestedOwner ${JSON.stringify(requestedOwner)} must fail closed`);
    assert.equal(blank.reason, "github_owner_blank");
  }
  const blankConfig = await resolveGitHubSetupSettings({
    config: configWithStarter({
      behavior_repo: { owner: "  ", name: "agentic-factory", visibility: "private" },
    }),
    connectionMode: "real",
    isTTY: false,
    resolveAuthenticatedGitHubLogin: async () => "octocat",
  });
  assert.equal(blankConfig.ok, false);
  assert.equal(blankConfig.reason, "github_owner_blank");
});

test("behavior repo owner flag and config override gh login resolution", async () => {
  let resolverCalls = 0;
  const configOwner = await resolveGitHubSetupSettings({
    config: configWithStarter({
      behavior_repo: { owner: "configured-org", name: "agentic-factory", visibility: "private" },
    }),
    requestedOwner: "flag-owner",
    connectionMode: "real",
    isTTY: false,
    resolveAuthenticatedGitHubLogin: async () => {
      resolverCalls += 1;
      return "octocat";
    },
  });
  assert.equal(configOwner.ok, true);
  assert.equal(configOwner.owner, "flag-owner");
  assert.equal(configOwner.ownerSource, "flag");

  const configOnly = await resolveGitHubSetupSettings({
    config: configWithStarter({
      behavior_repo: { owner: "configured-org", name: "agentic-factory", visibility: "private" },
    }),
    connectionMode: "real",
    isTTY: false,
    resolveAuthenticatedGitHubLogin: async () => {
      resolverCalls += 1;
      return "octocat";
    },
  });
  assert.equal(configOnly.ok, true);
  assert.equal(configOnly.owner, "configured-org");
  assert.equal(configOnly.ownerSource, "config");
  assert.equal(resolverCalls, 0);
});

test("real setup without flag, config owner, or gh login fails with a gh auth repair", async () => {
  const settings = await resolveGitHubSetupSettings({
    config: configWithStarter(),
    connectionMode: "real",
    isTTY: false,
    resolveAuthenticatedGitHubLogin: async () => null,
  });
  assert.equal(settings.ok, false);
  assert.equal(settings.reason, "github_owner_not_selected");
  assert.match(settings.detail, /gh auth login/);
  assert.match(settings.detail, /--github-owner/);
});

test("the real GitHub setup transport ignores renamed-repo redirects during availability checks", async () => {
  const transport = createRealGitHubSetupTransport({
    brokerClient: {
      async verifyInstallation() {
        throw new Error("unexpected install verification");
      },
      async mintInstallationToken() {
        throw new Error("unexpected token mint");
      },
    },
    runCommand: (command, args) => {
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({
            nameWithOwner: "shulmansj/agentic-factory-prevalidation-20260614",
            visibility: "PRIVATE",
            url: "https://github.com/shulmansj/agentic-factory-prevalidation-20260614",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      return { ok: false, status: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
    },
  });

  const result = await transport.request({
    endpointId: "get_repository",
    owner: "shulmansj",
    repo: "agentic-factory",
  });

  assert.equal(result.exists, false);
  assert.equal(result.redirected_repo, "shulmansj/agentic-factory-prevalidation-20260614");
});

test("the real GitHub setup transport uses gh for repo setup and broker tokens for steady-state push/probes", async () => {
  const root = tempRoot();
  const commandCalls = [];
  const brokerCalls = [];
  const transport = createRealGitHubSetupTransport({
    repoRoot: root,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
    brokerClient: {
      async verifyInstallation(input) {
        brokerCalls.push({ op: "verify", input });
        return {
          installation: {
            id: 123,
            app_slug: "agentic-factory-app",
            permissions: { ...STEADY_STATE_APP_PERMISSIONS },
          },
        };
      },
      async mintInstallationToken(input) {
        brokerCalls.push({ op: "mint", input });
        return { token: `ghs_setup_${brokerCalls.length}` };
      },
    },
    runCommand: (command, args, options = {}) => {
      commandCalls.push({ command, args, options });
      if (command === "gh" && args[0] === "repo" && args[1] === "create") {
        return { ok: true, status: 0, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({
            nameWithOwner: "shulmansj/agentic-factory",
            visibility: "PRIVATE",
            url: "https://github.com/shulmansj/agentic-factory",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      if (command === "git" && args[0] === "push") {
        return { ok: true, status: 0, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "api") {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ name: "main", commit: { sha: "abc123" } }),
          stderr: "",
        };
      }
      return { ok: false, status: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
    },
  });

  const created = await transport.request({
    endpointId: "create_repository",
    owner: "shulmansj",
    repo: "agentic-factory",
    params: { visibility: "private" },
  });
  const installation = await transport.request({
    endpointId: "get_app_installation",
    owner: "shulmansj",
    repo: "agentic-factory",
    params: { app_slug: "agentic-factory-app", app_id: "123456" },
  });
  const pushed = await transport.request({
    endpointId: "push_initial_branch",
    owner: "shulmansj",
    repo: "agentic-factory",
    params: { branch: "main", head_sha: "abc123" },
  });
  await transport.request({
    endpointId: "verify_default_branch",
    owner: "shulmansj",
    repo: "agentic-factory",
    params: { branch: "main" },
  });
  await transport.request({
    endpointId: "probe_pr_create_capability",
    owner: "shulmansj",
    repo: "agentic-factory",
  });
  const setupGrant = await transport.request({
    endpointId: "revoke_setup_grant",
    owner: "shulmansj",
    repo: "agentic-factory",
  });

  assert.equal(created.created, true);
  assert.equal(installation.installation.id, 123);
  assert.equal(pushed.pushed, true);
  assert.equal(setupGrant.revoked, false);
  assert.equal(setupGrant.confirmed, true);
  assert.equal(setupGrant.revocation_method, "not_applicable_existing_gh_operator_session");
  assert.equal(setupGrant.grant_retained, false);
  assert.ok(commandCalls.some((call) =>
    call.command === "gh"
    && call.args.join(" ") === "repo create shulmansj/agentic-factory --private --disable-issues --disable-wiki",
  ));
  const gitPush = commandCalls.find((call) => call.command === "git" && call.args[0] === "push");
  assert.equal(gitPush.options.cwd, root);
  assert.match(gitPush.options.env.GIT_ASKPASS, /askpass/);
  assert.equal(gitPush.options.env.AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN, "ghs_setup_2");
  assert.ok(!JSON.stringify(gitPush.args).includes("ghs_setup"));
  assert.deepEqual(brokerCalls.map((call) => call.op), ["verify", "mint", "mint", "mint"]);
  assert.deepEqual(brokerCalls[1].input.permissions, { contents: "write" });
  assert.deepEqual(brokerCalls[2].input.permissions, { contents: "read" });
  assert.deepEqual(brokerCalls[3].input.permissions, { pull_requests: "write" });
});

test("GitHub installation-token askpass script emits username/password without embedding the token", () => {
  const token = ["gh", "s_", "runtime_token_for_askpass_test"].join("");
  const askpass = createGitHubInstallationTokenAskPass({ token, tempRoot: tempRoot() });
  try {
    const script = fs.readFileSync(askpass.askpassPath, "utf8");
    assert.ok(!script.includes(token));
    assert.equal(askpassOutput(askpass, "Username for 'https://github.com': "), "x-access-token");
    assert.equal(askpassOutput(askpass, "Password for 'https://x-access-token@github.com': "), token);
  } finally {
    const dir = askpass.tempDir;
    askpass.cleanup();
    assert.equal(fs.existsSync(dir), false);
  }
});

test("setup endpoint allowlist separates setup-grant and steady-state credential paths and has no merge/admin surface", () => {
  for (const endpoint of GITHUB_SETUP_ENDPOINT_ALLOWLIST) {
    assert.ok(
      ["setup_grant", "steady_state_app"].includes(endpoint.credential_path),
      `endpoint ${endpoint.id} must declare a credential path`,
    );
    assert.ok(!/merge|ready|approve|review/i.test(endpoint.id), `merge-shaped setup endpoint: ${endpoint.id}`);
  }
  const byId = Object.fromEntries(GITHUB_SETUP_ENDPOINT_ALLOWLIST.map((entry) => [entry.id, entry]));
  // Repo creation and grant revocation ride the one-time setup grant; the
  // push/branch/PR capability surface rides the steady-state App.
  assert.equal(byId.create_repository.credential_path, "setup_grant");
  assert.equal(byId.revoke_setup_grant.credential_path, "setup_grant");
  assert.equal(byId.push_initial_branch.credential_path, "steady_state_app");
  assert.equal(byId.probe_branch_create_capability.credential_path, "steady_state_app");
  assert.equal(byId.probe_pr_create_capability.credential_path, "steady_state_app");
});

test("both setup transports refuse endpoint ids outside the allowlist", async () => {
  for (const transport of [createDryRunGitHubSetupTransport(), createMockGitHubSetupTransport()]) {
    await assert.rejects(
      transport.request({ endpointId: "add_repo_admin_permission", owner: "o", repo: "r" }),
      /github_setup_endpoint_not_allowlisted:add_repo_admin_permission/,
    );
    await assert.rejects(
      transport.request({ endpointId: "merge_pull_request", owner: "o", repo: "r" }),
      /github_setup_endpoint_not_allowlisted/,
    );
  }
});

test("dry-run setup transport records calls and marks every shape dry_run: true", async () => {
  const transport = createDryRunGitHubSetupTransport({ now: () => new Date("2026-06-10T05:00:00.000Z") });
  const created = await transport.request({
    endpointId: "create_repository",
    owner: "o",
    repo: "r",
    params: { visibility: "private" },
  });
  assert.equal(created.dry_run, true);
  assert.equal(created.repo.visibility, "private");
  const revoked = await transport.request({ endpointId: "revoke_setup_grant", owner: "o", repo: "r" });
  assert.equal(revoked.dry_run, true);
  assert.equal(revoked.revoked, true);
  assert.deepEqual(
    transport.calls.map((call) => call.endpointId),
    ["create_repository", "revoke_setup_grant"],
  );
});

// ---------------------------------------------------------------------------
// Remote detection / planning (plan ~414-422, error rows ~1895-1896).
// ---------------------------------------------------------------------------

test("starter-remote-only checkout: starter origin is preserved as upstream and a new origin is planned", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { origin: `${STARTER_URL}.git` } });
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  const actions = result.connection.remotes.planned_actions.map((action) => action.action);
  assert.deepEqual(actions, ["rename_remote", "set_origin"]);
  assert.equal(result.connection.remotes.upstream.url, `${STARTER_URL}.git`);
  assert.equal(result.connection.remotes.upstream.preserved_from, "origin");
  assert.match(result.connection.remotes.origin.url, /your-github-owner\/agentic-factory$/);
  // Dry-run mode applies nothing to the checkout: the starter remote is still
  // literally `origin` on disk.
  assert.equal(result.connection.remotes.origin.applied, false);
});

test("plain clone from the shipped source repo is treated as a starter checkout", async () => {
  const configExample = loadLinearConfig({ repoRoot: REPO_ROOT });
  assert.ok(
    configExample.github.starter_remote_urls.includes(SHIPPED_SOURCE_URL),
    "config.example must recognize the public source repo as a starter remote",
  );

  const root = initGitRepo(tempRoot(), { remotes: { origin: `${SHIPPED_SOURCE_URL}.git` } });
  const { result } = await runPhase({ root, config: configExample, transport: createMockGitHubSetupTransport() });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.connection.remotes.planned_actions.map((action) => action.action),
    ["rename_remote", "set_origin"],
  );
  assert.equal(result.connection.remotes.upstream.url, `${SHIPPED_SOURCE_URL}.git`);
  assert.equal(result.connection.remotes.upstream.preserved_from, "origin");
});

test("a remote already named upstream is preserved and only a new origin is planned", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { upstream: "https://github.com/somebody/some-template" } });
  const { result } = await runPhase({ root, transport: createMockGitHubSetupTransport() });
  assert.equal(result.ok, true);
  const actions = result.connection.remotes.planned_actions.map((action) => action.action);
  assert.deepEqual(actions, ["set_origin"]);
  assert.equal(result.connection.remotes.upstream.preserved_from, "upstream");
});

test("pre-existing adopter-owned remote is a setup conflict with a repair path, never adopted", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/some-adopter/their-own-repo.git" },
  });
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.status, "setup_conflict");
  assert.equal(result.reason, "github_remote_setup_conflict");
  assert.match(result.repair, /never adopts a pre-existing adopter-owned remote/);
  assert.match(result.detail, /some-adopter\/their-own-repo/);
  // The conflict is decided BEFORE any GitHub call: no repo lookup/creation.
  assert.equal(transport.calls.length, 0);
  // No partial adoption: the recorded state is not a verified connection.
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
});

test("ssh and https starter remote spellings normalize to the same identity", () => {
  assert.equal(
    normalizeGitRemoteUrl("git@github.com:agentic-factory/agentic-factory-starter.git"),
    normalizeGitRemoteUrl(`${STARTER_URL}/`),
  );
  const plan = planRemoteLayout({
    remotes: [{ name: "origin", url: "git@github.com:agentic-factory/agentic-factory-starter.git" }],
    starterRemoteUrls: [STARTER_URL],
    behaviorRepoUrl: "https://github.com/o/behavior",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.upstream.preserved_from, "origin");
});

test("real remote application rolls back if the final origin/upstream shape is not exact", () => {
  const root = initGitRepo(tempRoot(), { remotes: { upstream: STARTER_URL } });
  const planned = planRemoteLayout({
    remotes: [{ name: "upstream", url: STARTER_URL }],
    starterRemoteUrls: [STARTER_URL],
    behaviorRepoUrl: "https://github.com/o/behavior",
  });
  assert.equal(planned.ok, true);
  const runGit = (args, options = {}) => {
    if (args[0] === "remote" && args[1] === "add" && args[2] === "origin") {
      return runGitResult(["remote", "add", "origin", "https://github.com/o/wrong"], options.cwd);
    }
    return runGitResult(args, options.cwd);
  };
  const result = applyRemotePlan({
    repoRoot: root,
    runGit,
    remotePlan: planned,
    behaviorRepoUrl: "https://github.com/o/behavior",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "git_remote_apply_verification_failed");
  assert.equal(result.rollback.ok, true);
  const remotes = listRemotes(root);
  assert.deepEqual(remotes, { upstream: STARTER_URL });
});

// ---------------------------------------------------------------------------
// Name collision + creation outcomes (error rows ~1897-1898).
// ---------------------------------------------------------------------------

test("behavior repo name collision refuses to attach and suggests a safe suffix", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({
    existingRepos: [`${DRY_RUN_OWNER_PLACEHOLDER}/${DEFAULT_BEHAVIOR_REPO_NAME}`],
  });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "behavior_repo_name_collision");
  assert.match(result.repair, /never attaches to an existing repo/);
  assert.match(result.repair, new RegExp(`${DEFAULT_BEHAVIOR_REPO_NAME}-2`));
  assert.ok(!transport.calls.some((call) => call.endpointId === "create_repository"));
});

test("real init resumes a repo created by a prior pending App-approval run", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { origin: `${STARTER_URL}.git` } });
  writeStateFixture(root, {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "real",
    status: "pending_app_approval",
    adoption_complete: false,
    repo: {
      owner: "shulmansj",
      owner_source: "flag",
      name: "agentic-factory",
      full_name: "shulmansj/agentic-factory",
      visibility: "private",
      url: "https://github.com/shulmansj/agentic-factory",
    },
    default_branch: null,
    remotes: null,
    app_installation: null,
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    setup_grant: {
      revoked: true,
      confirmed: true,
      revoked_at: "2026-06-10T20:34:25.963Z",
    },
    failures: [
      {
        reason: "github_app_installation_pending_approval",
        repair: "install app",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
    appInstalled: true,
  });
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({
    root,
    transport,
    config: configWithStarter({
      behavior_repo: { owner: "shulmansj", name: "agentic-factory", visibility: "private" },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.connection.connection_mode, "real");
  assert.equal(result.connection.adoption_complete, true);
  assert.equal(result.connection.setup_grant.revoked, true);
  assert.ok(!mock.calls.some((call) => call.endpointId === "create_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "push_initial_branch"));
  assert.deepEqual(listRemotes(root), {
    origin: "https://github.com/shulmansj/agentic-factory",
    upstream: `${STARTER_URL}.git`,
  });
});

test("real init resumes a repo created before a failed hosted install intent", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { origin: `${STARTER_URL}.git` } });
  writeStateFixture(root, {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "real",
    status: "failed",
    adoption_complete: false,
    repo: {
      owner: "shulmansj",
      owner_source: "gh_login",
      name: "agentic-factory",
      full_name: "shulmansj/agentic-factory",
      visibility: "private",
      url: "https://github.com/shulmansj/agentic-factory",
    },
    default_branch: null,
    remotes: null,
    app_installation: null,
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    setup_grant: {
      revoked: false,
      confirmed: true,
      revoked_at: null,
      revocation_method: "not_applicable_existing_gh_operator_session",
      grant_retained: false,
      operator_gh_session_not_retained: true,
    },
    failures: [
      {
        reason: "github_app_install_intent_failed",
        repair: "retry GitHub setup",
        detail: "setup grant mutation window expired",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
    appInstalled: true,
  });
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({
    root,
    transport,
    config: configWithStarter({
      behavior_repo: { owner: "shulmansj", name: "agentic-factory", visibility: "private" },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.connection.adoption_complete, true);
  assert.ok(!mock.calls.some((call) => call.endpointId === "create_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "get_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "push_initial_branch"));
});

test("real init resumes an empty repo after a prior collision state overwrote creation evidence", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { origin: `${STARTER_URL}.git` } });
  writeStateFixture(root, {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "real",
    status: "failed",
    adoption_complete: false,
    repo: {
      owner: "shulmansj",
      owner_source: "gh_login",
      name: "agentic-factory",
      full_name: "shulmansj/agentic-factory",
      visibility: "private",
      url: null,
    },
    default_branch: null,
    remotes: null,
    app_installation: null,
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    setup_grant: {
      revoked: false,
      confirmed: true,
      revoked_at: null,
      revocation_method: "not_applicable_existing_gh_operator_session",
      grant_retained: false,
      operator_gh_session_not_retained: true,
    },
    failures: [
      {
        reason: "behavior_repo_name_collision",
        repair: "repo name collides",
        detail: "a repository named shulmansj/agentic-factory already exists",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
    existingRepoDetails: {
      "shulmansj/agentic-factory": { empty: true, visibility: "private" },
    },
    appInstalled: true,
  });
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({
    root,
    transport,
    config: configWithStarter({
      behavior_repo: { owner: "shulmansj", name: "agentic-factory", visibility: "private" },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.connection.adoption_complete, true);
  assert.ok(!mock.calls.some((call) => call.endpointId === "create_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "push_initial_branch"));
});

test("new behavior repos default to private visibility", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  const createCall = transport.calls.find((call) => call.endpointId === "create_repository");
  assert.equal(createCall.params.visibility, "private");
  assert.equal(result.connection.repo.visibility, "private");
});

test("org-approval-required repo creation stops in a repairable pending state with no partial adoption", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({ creationOutcome: "org_approval_required" });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.status, "pending_org_approval");
  assert.equal(result.reason, "behavior_repo_creation_pending_org_approval");
  assert.match(result.repair, /owner to approve/);
  assert.match(result.repair, /rather than silently completing a partial, eval-only adoption/);
  // The pending state is durable for doctor, but never a verified connection.
  const stored = readGitHubConnectionState({ repoRoot: root });
  assert.equal(stored.ok, true);
  assert.equal(stored.connection.status, "pending_org_approval");
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
  // Fail-safe: the exercised setup grant is still revoked on the way out.
  assert.ok(transport.calls.some((call) => call.endpointId === "revoke_setup_grant"));
});

test("real GitHub phase binds the hosted install before issuing the broker credential", async () => {
  const root = tempRoot();
  const calls = [];
  let statusCalls = 0;
  const behaviorUrl = "https://github.com/acme/agentic-factory";
  const runGit = (args) => {
    calls.push({ type: "git", args });
    if (args.join(" ") === "remote -v") {
      return {
        ok: true,
        stdout: `origin\t${behaviorUrl}.git (fetch)\norigin\t${behaviorUrl}.git (push)\n`,
        stderr: "",
      };
    }
    if (args.join(" ") === "ls-files -z") return { ok: true, stdout: "", stderr: "" };
    if (args.join(" ") === "symbolic-ref --short HEAD") return { ok: true, stdout: "main\n", stderr: "" };
    if (args.join(" ") === "rev-parse HEAD") return { ok: true, stdout: "abc123\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const transport = {
    kind: "real",
    async request({ endpointId, owner, repo, params = {} }) {
      calls.push({ type: "transport", endpointId, owner, repo, params });
      switch (endpointId) {
        case "get_repository":
          return {
            exists: true,
            repo: {
              id: "repo-acme-agentic-factory",
              owner,
              name: repo,
              full_name: `${owner}/${repo}`,
              visibility: "private",
              url: behaviorUrl,
            },
          };
        case "get_app_installation":
          return {
            installed: true,
            installation: {
              id: "installation-bound",
              app_slug: "agentic-factory-app",
              permissions: { ...STEADY_STATE_APP_PERMISSIONS },
              repository_selection: "selected",
              selected_repository_ids: ["repo-acme-agentic-factory"],
              selected_repository_full_names: ["acme/agentic-factory"],
            },
          };
        case "push_initial_branch":
          return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha };
        case "verify_default_branch":
          return { verified: true, default_branch: params.branch, head_sha: params.head_sha };
        case "revoke_setup_grant":
          return { revoked: true, confirmed: true };
        case "probe_branch_create_capability":
          return { capable: true, derived_from: "test" };
        case "probe_pr_create_capability":
          return { capable: true, derived_from: "test" };
        default:
          throw new Error(`unexpected_endpoint:${endpointId}`);
      }
    },
  };

  const { result } = await runPhase({
    root,
    config: configWithStarter({
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      app_slug: "agentic-factory-app",
      app_id: "123456",
    }),
    transport,
    runGit,
    githubInstallStatus: async () => {
      statusCalls += 1;
      calls.push({ type: "status", statusCalls });
      return statusCalls === 1
        ? { ok: true, grant: { githubInstallationId: null } }
        : { ok: true, grant: { githubInstallationId: "installation-bound" } };
    },
    githubInstallIntent: async (input) => {
      calls.push({ type: "intent", input });
      return { ok: true, installUrl: "https://github.test/install" };
    },
    issueGitHubBrokerCredential: async (input) => {
      calls.push({ type: "issue", input });
      return { ok: true };
    },
    openBrowser: async (url) => {
      calls.push({ type: "open", url });
    },
    sleep: async () => {
      calls.push({ type: "sleep" });
    },
    installPollIntervalMs: 1,
    installPollTimeoutMs: 2,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.type === "issue").input, {
    owner: "acme",
    repo: "agentic-factory",
    installationId: "installation-bound",
  });
  const order = calls.map((call) => call.type === "transport" ? `transport:${call.endpointId}` : call.type);
  assert.ok(order.indexOf("status") < order.indexOf("intent"));
  assert.ok(order.indexOf("intent") < order.indexOf("issue"));
  assert.ok(order.indexOf("issue") < order.indexOf("transport:get_app_installation"));
  assert.ok(!order.includes("sleep"), "second status poll should observe the bound installation immediately");
});

// ---------------------------------------------------------------------------
// Setup grant revocation (error row ~1899).
// ---------------------------------------------------------------------------

test("the setup grant is revoked after creation and push, before init reports success", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  const order = transport.calls.map((call) => call.endpointId);
  const revokeIndex = order.indexOf("revoke_setup_grant");
  assert.ok(revokeIndex > order.indexOf("create_repository"), "revoke must follow creation");
  assert.ok(revokeIndex > order.indexOf("push_initial_branch"), "revoke must follow the initial push");
  assert.equal(result.connection.setup_grant.revoked, true);
  assert.equal(result.connection.setup_grant.confirmed, true);
});

test("an unconfirmable setup-grant revocation fails init safe with an exact cleanup repair", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({ revoke: { revoked: false, confirmed: false } });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed_revocation_unconfirmed");
  assert.equal(result.reason, "setup_grant_revocation_unconfirmed");
  assert.match(result.repair, /revoke it manually NOW/);
  assert.match(result.repair, /never merely forgotten/);
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
});

// ---------------------------------------------------------------------------
// App installation permission exactness (CONSTRAINTS #23, error row ~1901).
// ---------------------------------------------------------------------------

test("an EXTRA app permission fails verification (steady-state app holds nothing beyond the exact set)", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({
    appPermissions: { ...STEADY_STATE_APP_PERMISSIONS, issues: "write" },
  });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "github_app_permissions_not_exact");
  assert.match(result.detail, /EXTRA/);
  assert.match(result.detail, /issues/);
  assert.match(result.repair, /never repo-administration/);
});

test("a MISSING or wrong-level app permission fails verification", async () => {
  for (const permissions of [
    { metadata: "read", contents: "write" }, // pull_requests missing
    { metadata: "read", contents: "read", pull_requests: "write" }, // contents wrong level
  ]) {
    const root = initGitRepo(tempRoot());
    const { result } = await runPhase({
      root,
      transport: createMockGitHubSetupTransport({ appPermissions: permissions }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "github_app_permissions_not_exact");
  }
  const verification = verifyAppPermissionSnapshot({ metadata: "read", contents: "write" });
  assert.deepEqual(verification.missing, ["pull_requests"]);
  assert.equal(verification.ok, false);
});

test("selected behavior repo proof records stable repo id and selected repo scope", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({
    repositoryId: "repo-selected-123",
    selectedRepositoryIds: ["repo-selected-123"],
    selectedRepositoryFullNames: [`${DRY_RUN_OWNER_PLACEHOLDER}/${DEFAULT_BEHAVIOR_REPO_NAME}`],
  });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  assert.equal(result.connection.repo.id, "repo-selected-123");
  assert.equal(result.connection.app_installation.repository_selection, "selected");
  assert.deepEqual(result.connection.app_installation.selected_repository_ids, ["repo-selected-123"]);
  assert.deepEqual(
    result.connection.app_installation.selected_repository_full_names,
    [`${DRY_RUN_OWNER_PLACEHOLDER}/${DEFAULT_BEHAVIOR_REPO_NAME}`],
  );
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.equal(identity.repo_id, "repo-selected-123");
});

test("selected behavior repo proof fails on all-repo, repo-id, and repo-name drift before push", async () => {
  const cases = [
    {
      name: "missing selected-repo signal",
      transport: createMockGitHubSetupTransport({
        repositorySelection: null,
        selectedRepositoryIds: [],
        selectedRepositoryFullNames: [],
      }),
      reason: "github_app_installation_not_selected_repo",
      detail: /repository_selection=missing/,
    },
    {
      name: "all repos",
      transport: createMockGitHubSetupTransport({ repositorySelection: "all" }),
      reason: "github_app_installation_not_selected_repo",
      detail: /repository_selection=all/,
    },
    {
      name: "repo id mismatch",
      transport: createMockGitHubSetupTransport({
        repositoryId: "repo-selected-123",
        selectedRepositoryIds: ["repo-other-999"],
      }),
      reason: "github_app_installation_repo_id_mismatch",
      detail: /repo-selected-123/,
    },
    {
      name: "repo name mismatch",
      transport: createMockGitHubSetupTransport({
        repositoryId: "repo-selected-123",
        selectedRepositoryIds: ["repo-selected-123"],
        selectedRepositoryFullNames: ["somebody/product-repo"],
      }),
      reason: "github_app_installation_repo_name_mismatch",
      detail: /behavior repo/,
    },
  ];
  for (const fixture of cases) {
    const root = initGitRepo(tempRoot());
    const { result } = await runPhase({ root, transport: fixture.transport });
    assert.equal(result.ok, false, fixture.name);
    assert.equal(result.reason, fixture.reason, fixture.name);
    assert.match(result.detail, fixture.detail, fixture.name);
    assert.ok(!fixture.transport.calls.some((call) => call.endpointId === "push_initial_branch"));
    assert.ok(!fixture.transport.calls.some((call) => call.endpointId === "probe_pr_create_capability"));
    assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
  }
});

// ---------------------------------------------------------------------------
// Pre-push sanitizer (error row ~1900): the step 4 content-gate secret scan
// over the would-be-pushed tree.
// ---------------------------------------------------------------------------

test("token-shaped tracked content blocks the initial push with a sanitizer report and repair hint", async () => {
  const root = initGitRepo(tempRoot());
  // Built at runtime so this TEST file never contains a token-shaped literal.
  const tokenShaped = ["gh", "p_", "a".repeat(24)].join("");
  fs.writeFileSync(path.join(root, "notes.txt"), `deploy notes\n${tokenShaped}\n`);
  runGitOrThrow(["add", "notes.txt"], root);
  runGitOrThrow(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@test.invalid", "commit", "-m", "notes"],
    root,
  );
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "initial_push_blocked_token_shaped_content");
  assert.match(result.detail, /notes\.txt/);
  assert.match(result.repair, /blocked before any byte leaves the machine/);
  assert.match(result.repair, /Secrets are never sanitized through/);
  // The push intent is never even recorded.
  assert.ok(!transport.calls.some((call) => call.endpointId === "push_initial_branch"));
  // Fail-safe revocation still runs.
  assert.ok(transport.calls.some((call) => call.endpointId === "revoke_setup_grant"));
});

test("security scan seed fixture source does not trip the pre-push sanitizer", () => {
  const root = initGitRepo(tempRoot());
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "security-scan.mjs"),
    path.join(root, "scripts", "security-scan.mjs"),
  );
  runGitOrThrow(["add", "scripts/security-scan.mjs"], root);
  const scan = scanTrackedTreeForSecrets({ repoRoot: root });
  assert.equal(
    scan.ok,
    true,
    `security scan seed source must not block initial push; findings: ${JSON.stringify(scan.report?.findings)}`,
  );
});

test("secret-shaped tracked file NAMES are flagged by the pre-push scan", () => {
  const root = initGitRepo(tempRoot());
  fs.writeFileSync(path.join(root, "client_secret.json"), "{}\n");
  runGitOrThrow(["add", "client_secret.json"], root);
  const scan = scanTrackedTreeForSecrets({ repoRoot: root });
  assert.equal(scan.ok, false);
  assert.deepEqual(scan.report.findings, [{ path: "client_secret.json", rule: "secret_shaped_path" }]);
});

test("binary tracked files are skipped and disclosed in the sanitizer report", () => {
  const root = initGitRepo(tempRoot());
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  runGitOrThrow(["add", "blob.bin"], root);
  const scan = scanTrackedTreeForSecrets({ repoRoot: root });
  assert.equal(scan.ok, true);
  assert.equal(scan.report.skipped_binary_count, 1);
});

test("the repo's own tracked tree passes the pre-push secret scan (adopters' initial push stays unblocked)", () => {
  // init pushes the whole tracked tree to the new behavior repo; if the shipped
  // repo itself trips the scanner, EVERY adopter is blocked at the final step.
  // Intentional secret-shaped test vectors must avoid appearing as literal
  // secrets in source (e.g. via string concatenation).
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
  const scan = scanTrackedTreeForSecrets({ repoRoot });
  assert.equal(
    scan.ok,
    true,
    `pre-push scan must pass on the shipped repo; findings: ${JSON.stringify(scan.report?.findings)}`,
  );
});

// ---------------------------------------------------------------------------
// All-phases-required success contract (plan ~424-434, error row ~1894).
// ---------------------------------------------------------------------------

test("init succeeds ONLY when creation, origin plan, push verify, app verify, and PR-generation verify all pass", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  const connection = result.connection;
  assert.equal(connection.schema_version, GITHUB_CONNECTION_SCHEMA_VERSION);
  assert.equal(connection.status, "verified");
  assert.equal(connection.connection_mode, "dry_run");
  assert.equal(connection.adoption_complete, false);
  assert.equal(connection.default_branch, "main");
  assert.equal(connection.app_installation.verified_exact, true);
  assert.deepEqual(connection.app_installation.permission_snapshot, STEADY_STATE_APP_PERMISSIONS);
  assert.equal(connection.push_verification.verified, true);
  assert.equal(connection.pr_generation.verified, true);
  assert.equal(connection.setup_grant.revoked, true);
  assert.ok(connection.verified_at);
  // The durable state file round-trips and resolves a behavior-repo identity.
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.deepEqual(identity.repo, {
    owner: DRY_RUN_OWNER_PLACEHOLDER,
    repo: DEFAULT_BEHAVIOR_REPO_NAME,
  });
  assert.equal(identity.connection_mode, "dry_run");
});

test("real init mode does not emit the dry-run banner or dry-run connection mode", async () => {
  const root = tempRoot();
  const transport = { ...createMockGitHubSetupTransport(), kind: "real" };
  const { result, progress } = await runPhase({
    root,
    config: configWithStarter({
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
    }),
    transport,
    runGit: createInMemoryRunGit(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.transport_kind, "real");
  assert.equal(result.connection.connection_mode, "real");
  assert.equal(result.connection.adoption_complete, true);
  const output = progress.join("\n");
  assert.match(output, /GitHub repo target: acme\/agentic-factory \(private\)/);
  assert.doesNotMatch(output, /DRY-RUN GITHUB SETUP/);
  assert.doesNotMatch(output, /connection_mode=dry_run/);
});

test("a failing PR-generation probe fails init with a connect-GitHub repair path (no silent eval-only completion)", async () => {
  const root = initGitRepo(tempRoot());
  const { result } = await runPhase({
    root,
    transport: createMockGitHubSetupTransport({ prCreateCapable: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "pr_generation_unverified");
  assert.match(result.repair, /connect GitHub to complete adoption/);
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
});

test("a transport failure during capability probing fails init with a connect-GitHub repair path", async () => {
  const root = initGitRepo(tempRoot());
  const { result } = await runPhase({
    root,
    transport: createMockGitHubSetupTransport({
      failures: { probe_pr_create_capability: { error: new Error("github api unreachable") } },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "pr_generation_verification_failed");
  assert.match(result.detail, /github api unreachable/);
  assert.match(result.repair, /connect GitHub to complete adoption/);
});

test("an unverified initial-branch push fails init", async () => {
  const root = initGitRepo(tempRoot());
  const { result } = await runPhase({
    root,
    transport: createMockGitHubSetupTransport({ pushVerified: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "initial_branch_push_unverified");
  assert.match(result.repair, /connect GitHub to complete adoption/);
});

test("dry-run mode is loudly disclosed: banner, incomplete adoption, and connection_mode dry_run", async () => {
  const root = initGitRepo(tempRoot());
  const { result, progress } = await runPhase({ root }); // default transport = dry-run
  assert.equal(result.ok, true);
  assert.equal(result.transport_kind, "dry_run");
  assert.equal(result.connection.connection_mode, "dry_run");
  const output = progress.join("\n");
  assert.match(output, /DRY-RUN GITHUB SETUP/);
  assert.match(output, /broker-backed GitHub setup transport/);
  assert.match(output, /NOT a/);
  assert.match(output, /adoption is NOT complete/);
  for (const line of DRY_RUN_GITHUB_SETUP_BANNER) {
    assert.ok(progress.includes(line), `banner line missing from init output: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Behavior-repo identity resolution (read by the step 10 controller; the
// step 12 scanner and step 13 supervisor read the same state file).
// ---------------------------------------------------------------------------

test("resolveBehaviorRepoIdentity fails typed on missing, invalid, and unverified state", () => {
  const root = tempRoot();
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).reason, "missing_github_connection_state");
  writeStateFixture(root, { schema_version: "something-else/v9" });
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).reason, "invalid_github_connection_state");
  writeStateFixture(root, { ...verifiedRealStateFixture(), status: "pending_org_approval" });
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).reason, "github_connection_not_verified");
});

test("resolveBehaviorRepoIdentity returns the verified repo identity and connection mode", () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({ owner: "acme", name: "acme-behavior" }));
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.deepEqual(identity.repo, { owner: "acme", repo: "acme-behavior" });
  assert.equal(identity.repo_id, "repo-real-1");
  assert.equal(identity.connection_mode, "real");
  assert.equal(identity.source, "github_connection_state");
});

test("resolveBehaviorRepoIdentity fails typed when stored selected-repo proof drifts", () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({
    repoId: "repo-selected-123",
    selectedRepositoryIds: ["repo-other-999"],
  }));
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "github_app_installation_repo_id_mismatch");
});

// ---------------------------------------------------------------------------
// Doctor drift reporting (error rows ~1894-1901).
// ---------------------------------------------------------------------------

test("doctor with no connection state reports the connect-GitHub repair path", async () => {
  const root = tempRoot();
  const checks = await githubConnectionDoctorChecks({ repoRoot: root });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].message, /run npm run init/);
  assert.match(checks[0].message, /connect-GitHub repair path/);
});

test("doctor loudly flags a dry-run connection as not adoption-complete", async () => {
  const root = initGitRepo(tempRoot());
  await runPhase({ root }); // writes a verified dry-run connection
  const checks = await githubConnectionDoctorChecks({ repoRoot: root });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub connection"].ok, true);
  assert.equal(byName["GitHub connection mode"].ok, false);
  assert.match(byName["GitHub connection mode"].message, /DRY-RUN/);
  assert.match(byName["GitHub connection mode"].message, /NOT complete/);
  assert.match(byName["GitHub connection mode"].message, /github:init without --github-dry-run/);
  // Remote plan is recorded but not applied in dry-run: named as such.
  assert.equal(byName["GitHub remote shape"].ok, false);
  assert.match(byName["GitHub remote shape"].message, /not applied \(dry-run planned only/);
  // Setup grant + permissions + PR capability report from the recorded state
  // and the (dry-run) lookup.
  assert.equal(byName["GitHub setup grant"].ok, true);
  assert.equal(byName["GitHub App permissions"].ok, true);
  assert.equal(byName["GitHub PR generation"].ok, true);
});

test("doctor reports remote drift against a real verified connection with an exact repair", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/somebody/wrong-repo" },
  });
  writeStateFixture(root, verifiedRealStateFixture({ owner: "acme", name: "acme-behavior" }));
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    transport: createMockGitHubSetupTransport({
      appPermissions: { ...STEADY_STATE_APP_PERMISSIONS },
      installationId: "inst-1",
    }),
  });
  const remoteCheck = checks.find((check) => check.name === "GitHub remote shape");
  assert.equal(remoteCheck.ok, false);
  assert.match(remoteCheck.message, /remote drift/);
  assert.match(remoteCheck.message, /git remote set-url origin https:\/\/github\.com\/acme\/acme-behavior/);
  assert.match(remoteCheck.message, /upstream is missing/);
});

test("doctor reports app permission drift (extra permission) and missing PR capability with named repairs", async () => {
  const root = initGitRepo(tempRoot());
  writeStateFixture(root, verifiedRealStateFixture());
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    transport: createMockGitHubSetupTransport({
      appPermissions: { ...STEADY_STATE_APP_PERMISSIONS, issues: "write" },
      prCreateCapable: false,
    }),
  });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub App permissions"].ok, false);
  assert.match(byName["GitHub App permissions"].message, /EXTRA/);
  assert.match(byName["GitHub App permissions"].message, /issues/);
  assert.match(byName["GitHub App permissions"].message, /no issues\/comments/);
  assert.equal(byName["GitHub PR generation"].ok, false);
  assert.match(byName["GitHub PR generation"].message, /pr_create=false/);
});

test("doctor for a real connection fails closed when no live setup transport is provided", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/real-owner/real-behavior-repo", upstream: STARTER_URL },
  });
  writeStateFixture(root, verifiedRealStateFixture());
  const checks = await githubConnectionDoctorChecks({ repoRoot: root });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub App permissions"].ok, false);
  assert.match(byName["GitHub App permissions"].message, /live GitHub permission lookup was not run/);
  assert.equal(byName["GitHub PR generation"].ok, false);
  assert.match(byName["GitHub PR generation"].message, /live PR-generation capability probes were not run/);
  assert.doesNotMatch(byName["GitHub App permissions"].message, /dry-run lookup/);
});

test("doctor reports operator gh-session setup as not applicable instead of revoked", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/real-owner/real-behavior-repo", upstream: STARTER_URL },
  });
  writeStateFixture(root, verifiedRealStateFixture({
    setupGrant: {
      revoked: false,
      confirmed: true,
      revoked_at: null,
      revocation_method: "not_applicable_existing_gh_operator_session",
      grant_retained: false,
      operator_gh_session_not_retained: true,
    },
  }));
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    transport: createMockGitHubSetupTransport(),
  });
  const grantCheck = checks.find((check) => check.name === "GitHub setup grant");
  assert.equal(grantCheck.ok, true);
  assert.match(grantCheck.message, /not applicable/);
  assert.match(grantCheck.message, /no Agentic Factory setup grant was minted or retained/);
  assert.doesNotMatch(grantCheck.message, /revoked at/);
});

test("doctor reports an unrevoked setup grant with the manual cleanup repair", async () => {
  const root = initGitRepo(tempRoot());
  writeStateFixture(root, verifiedRealStateFixture({ revoked: false }));
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    transport: createMockGitHubSetupTransport(),
  });
  const grantCheck = checks.find((check) => check.name === "GitHub setup grant");
  assert.equal(grantCheck.ok, false);
  assert.match(grantCheck.message, /revoke it manually/i);
});

test("doctor reports pending/failed connection states with their recorded repair", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({ creationOutcome: "org_approval_required" });
  await runPhase({ root, transport });
  const checks = await githubConnectionDoctorChecks({ repoRoot: root });
  const connectionCheck = checks.find((check) => check.name === "GitHub connection");
  assert.equal(connectionCheck.ok, false);
  assert.match(connectionCheck.message, /status=pending_org_approval/);
  assert.match(connectionCheck.message, /owner to approve/);
});

// ---------------------------------------------------------------------------
// CLI wiring pins (source-pinned like the other steps' cli tests).
// ---------------------------------------------------------------------------

test("cli init runs the GitHub phase and fails init (no silent eval-only completion); doctor includes the GitHub checks", () => {
  // Post-split, the init flow lives in src/cli/linear-setup-command.mjs and the
  // doctor assembly in src/cli/doctor-command.mjs; the pins follow the wiring.
  const setupSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "linear-setup-command.mjs"),
    "utf8",
  );
  assert.ok(setupSource.includes("runGitHubInitPhase("), "init must run the GitHub phase");
  assert.ok(
    setupSource.includes("if (!githubPhase.ok)") && setupSource.includes("process.exitCode = 1"),
    "init must refuse to complete silently without GitHub (a failed GitHub phase fails init)",
  );
  const doctorSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "doctor-command.mjs"),
    "utf8",
  );
  const dispatchSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "cli", "dispatch.mjs"),
    "utf8",
  );
  assert.ok(doctorSource.includes("githubConnectionDoctorChecks"), "doctor must include the GitHub checks");
  assert.ok(
    dispatchSource.includes("createHostedInboxClient({ config, repoRoot })"),
    "CLI context must make the hosted inbox client read the same repo root where init persists grant files",
  );
  assert.ok(
    setupSource.includes("githubInitTransportFromFlags") &&
      setupSource.includes("issueInstallationBoundGitHubBrokerCredential") &&
      setupSource.includes("githubLiveRequested"),
    "full init must expose the shared GitHub live setup helpers",
  );
  assert.ok(
    setupSource.includes("return githubSetupTransportFromFlags({ config, flags, repoRoot, inboxClient, onProgress })"),
    "explicit dry-run GitHub setup transport fallback must stay unchanged",
  );
  assert.ok(
    dispatchSource.includes("githubInitTransportFromFlags") &&
      dispatchSource.includes("githubLiveRequested") &&
      dispatchSource.includes("issueInstallationBoundGitHubBrokerCredential"),
    "standalone github:init must reuse the full-init GitHub live setup helpers",
  );
  assert.ok(
    dispatchSource.includes("const githubLive = githubLiveRequested(flags)") &&
      dispatchSource.includes("transport: await githubInitTransportFromFlags({"),
    "standalone github:init must choose the shared init transport before running the phase",
  );
  assert.ok(
    dispatchSource.includes("githubInstallIntent: (input) => inboxClient.githubInstallIntent(input)") &&
      dispatchSource.includes("githubInstallStatus: (input) => inboxClient.githubInstallStatus(input)") &&
      dispatchSource.includes("issueGitHubBrokerCredential: (input) => issueInstallationBoundGitHubBrokerCredential({"),
    "standalone github:init live path must pass install-binding callbacks and defer broker issuance",
  );
  assert.doesNotMatch(
    dispatchSource,
    /githubSetupTransportFromFlags/,
    "standalone github:init must not use the eager broker credential transport",
  );
  const initIndex = setupSource.indexOf("runGitHubInitPhase(");
  const pendingIndex = setupSource.indexOf('Move a Linear project to "Planned" to start your first run');
  assert.ok(initIndex >= 0 && initIndex < pendingIndex, "GitHub phase must gate the pending init completion");
  assert.ok(
    setupSource.includes('Move a Linear project to "Planned" to start your first run') &&
      setupSource.includes("npm run doctor") &&
      setupSource.includes("Setup complete."),
    "init must end with the locked pending-state next steps and the repo's actual status command",
  );
  assert.doesNotMatch(setupSource, /running/);
  assert.ok(
    setupSource.includes("let requested = await inboxClient.requestSetupGrant({") &&
      setupSource.includes("workspaceId,") &&
      setupSource.includes("teamId,") &&
      setupSource.includes("domainId,") &&
      setupSource.includes("bypassActiveConflict ? { bypassActiveConflict: true } : {}") &&
      setupSource.includes("setupGrantInactiveReason(requested?.reason)") &&
      setupSource.includes("requested = await inboxClient.requestSetupGrant({ workspaceId, teamId, domainId })"),
    "init must request a setup grant for the selected team, support authenticated refresh on GitHub resume, and fall back to a fresh issue when the local grant is inactive",
  );
  assert.ok(setupSource.includes("writeInboxSetupGrant"), "init must persist the setup grant before hosted setup mutations");
  assert.ok(setupSource.includes("setup_grant_conflict"), "init must handle setup grant conflict/resume explicitly");
  assert.ok(setupSource.includes('output.info("GitHub connected.")'), "init should surface the GitHub connected state");
  assert.doesNotMatch(setupSource, /Linear workspace setup is ready|First domain is ready/);
  assert.doesNotMatch(setupSource, /ensureWebhookAdminAuthorization/);
});
