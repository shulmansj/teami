import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import * as githubSetupModule from "../src/github-setup.mjs";

const {
  createDryRunGitHubSetupTransport,
  createLocalAmbientGitHubSetupTransport,
  createMockGitHubSetupTransport,
  DEFAULT_BEHAVIOR_REPO_NAME,
  DRY_RUN_OWNER_PLACEHOLDER,
  DRY_RUN_GITHUB_SETUP_BANNER,
  GITHUB_CONNECTION_SCHEMA_VERSION,
  GITHUB_SETUP_ENDPOINT_ALLOWLIST,
  applyRemotePlan,
  githubConnectionDoctorChecks,
  githubConnectionStatePath,
  normalizeGitRemoteUrl,
  parseGitHubRemoteUrl,
  planRemoteLayout,
  pushAuthForRemoteUrl,
  readGitHubConnectionState,
  resolveBehaviorRepoIdentity,
  resolveGitHubSetupSettings,
  runGitHubInitPhase,
  scanTrackedTreeForSecrets,
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
    if (command === "remote" && subcommand === "get-url") {
      const remoteName = args[2] === "--push" ? args[3] : args[2];
      if (!remoteMap.has(remoteName)) return fail(`remote ${remoteName} missing`);
      return ok(`${remoteMap.get(remoteName)}\n`);
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
    if (command === "push" && subcommand === "--dry-run") return ok("dry-run ok\n");
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
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
  checkoutPath = null,
  pushAuth = "https",
  realPushEnabled = true,
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
    local_checkout_path: checkoutPath,
    push_auth: pushAuth,
    local_auth: {
      mode: "local_ambient",
      gh_auth: "verified",
      git_write: "verified",
      real_push_enabled: realPushEnabled,
      push_auth: pushAuth,
      checked_at: "2026-06-10T03:00:00.000Z",
    },
    remotes: {
      origin: {
        url: `https://github.com/${owner}/${name}`,
        push_url: pushAuth === "ssh" ? `git@github.com:${owner}/${name}.git` : `https://github.com/${owner}/${name}`,
        push_auth: pushAuth,
        planned: true,
        applied: originApplied,
      },
      upstream: upstreamUrl
        ? { url: upstreamUrl, preserved_from: "origin", planned: true, applied: originApplied }
        : null,
      planned_actions: [],
    },
    push_verification: { recorded: true, pushed: true, branch: "main", head_sha: "abc", verified: true, push_auth: pushAuth },
    pre_push_sanitizer: { scanned_count: 1, skipped_binary_count: 0, tracked_count: 1, findings: [] },
    pr_generation: { verified: true, derived_from: "local_ambient_git_gh_auth", mode: "local_ambient" },
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
// Transports: local ambient path plus dry-run rehearsal.
// ---------------------------------------------------------------------------

test("real GitHub init binds with local ambient auth without stored GitHub credentials", async () => {
  const root = tempRoot();
  const behaviorUrl = "https://github.com/acme/agentic-factory";
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["acme/agentic-factory"],
    existingRepoDetails: {
      "acme/agentic-factory": {
        id: "repo-acme-agentic-factory",
        owner: "acme",
        name: "agentic-factory",
        full_name: "acme/agentic-factory",
        visibility: "private",
        default_branch: "main",
      },
    },
  });
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({
    root,
    transport,
    runGit: createInMemoryRunGit({ remotes: { origin: `${behaviorUrl}.git` } }),
    config: {
      github: {
        behavior_repo: { owner: "acme", name: DEFAULT_BEHAVIOR_REPO_NAME, visibility: "private" },
        starter_remote_urls: [],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.connection.connection_mode, "real");
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(result.connection.local_auth.mode, "local_ambient");
  assert.equal(result.connection.local_auth.real_push_enabled, true);
  assert.equal(result.connection.remotes.origin.push_auth, "https");
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
    async request({ endpointId, owner, repo, params = {} }) {
      events.push(`transport:${endpointId}`);
      if (endpointId === "get_repository") {
        return {
          exists: true,
          repo: {
            id: "repo-octocat-agentic-factory",
            owner,
            name: repo,
            full_name: `${owner}/${repo}`,
            visibility: "private",
            default_branch: "main",
          },
        };
      }
      if (endpointId === "push_initial_branch") {
        return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha };
      }
      if (endpointId === "verify_default_branch") {
        return { verified: true, default_branch: params.branch, head_sha: params.head_sha };
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

  assert.equal(result.ok, true);
  const targetIndex = events.indexOf("progress:GitHub repo target: octocat/agentic-factory (private)");
  const localRemotesIndex = events.indexOf("progress:GitHub progress: Checking local Git remotes...");
  const repoCheckIndex = events.indexOf("progress:GitHub progress: Checking whether octocat/agentic-factory is available on GitHub...");
  const transportIndex = events.indexOf("transport:get_repository");
  assert.ok(targetIndex >= 0, `missing target progress: ${events.join("\n")}`);
  assert.ok(localRemotesIndex >= 0 && localRemotesIndex < targetIndex, `missing local-remotes progress: ${events.join("\n")}`);
  assert.ok(repoCheckIndex > targetIndex, `missing repo-check progress: ${events.join("\n")}`);
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

test("the local ambient GitHub setup transport ignores renamed-repo redirects during availability checks", async () => {
  const transport = createLocalAmbientGitHubSetupTransport({
    runCommand: (command, args) => {
      if (command === "gh" && args.join(" ") === "auth status --hostname github.com") {
        return { ok: true, status: 0, stdout: "", stderr: "" };
      }
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

test("the local ambient GitHub setup transport uses gh for repo setup and local git for push/probes", async () => {
  const root = tempRoot();
  const commandCalls = [];
  const transport = createLocalAmbientGitHubSetupTransport({
    repoRoot: root,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
    runCommand: (command, args, options = {}) => {
      commandCalls.push({ command, args, options });
      if (command === "gh" && args.join(" ") === "auth status --hostname github.com") {
        return { ok: true, status: 0, stdout: "", stderr: "" };
      }
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
      if (command === "git" && args[0] === "ls-remote") {
        return { ok: true, status: 0, stdout: "abc123\trefs/heads/main\n", stderr: "" };
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

  assert.equal(created.created, true);
  assert.equal(pushed.pushed, true);
  assert.ok(commandCalls.some((call) =>
    call.command === "gh"
    && call.args.join(" ") === "repo create shulmansj/agentic-factory --private --disable-issues --disable-wiki",
  ));
  const gitPush = commandCalls.find((call) => call.command === "git" && call.args[0] === "push");
  assert.equal(gitPush.options.cwd, root);
  assert.equal(gitPush.options.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(!("AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN" in gitPush.options.env));
  assert.ok(!JSON.stringify(commandCalls).includes("ghs_setup"));
});

test("setup endpoint allowlist names local ambient auth surfaces and has no merge/admin surface", () => {
  for (const endpoint of GITHUB_SETUP_ENDPOINT_ALLOWLIST) {
    assert.ok(
      ["local_gh_auth", "local_git_auth"].includes(endpoint.credential_path),
      `endpoint ${endpoint.id} must declare a credential path`,
    );
    assert.ok(!/merge|ready|approve|review/i.test(endpoint.id), `merge-shaped setup endpoint: ${endpoint.id}`);
  }
  const byId = Object.fromEntries(GITHUB_SETUP_ENDPOINT_ALLOWLIST.map((entry) => [entry.id, entry]));
  assert.equal(byId.create_repository.credential_path, "local_gh_auth");
  assert.equal(byId.push_initial_branch.credential_path, "local_git_auth");
  assert.deepEqual(Object.keys(byId).sort(), [
    "create_repository",
    "get_repository",
    "push_initial_branch",
    "verify_default_branch",
  ]);
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
  const pushed = await transport.request({
    endpointId: "push_initial_branch",
    owner: "o",
    repo: "r",
    params: { branch: "main" },
  });
  assert.equal(pushed.dry_run, true);
  assert.equal(pushed.recorded, true);
  assert.deepEqual(
    transport.calls.map((call) => call.endpointId),
    ["create_repository", "push_initial_branch"],
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

test("pre-existing adopter-owned GitHub origin is bound as the behavior repo with local auth", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/some-adopter/their-own-repo.git" },
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["some-adopter/their-own-repo"],
    existingRepoDetails: {
      "some-adopter/their-own-repo": {
        id: "repo-some-adopter-their-own-repo",
        owner: "some-adopter",
        name: "their-own-repo",
        full_name: "some-adopter/their-own-repo",
        visibility: "private",
        default_branch: "main",
      },
    },
  });
  const transport = { ...mock, kind: "real" };
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  assert.equal(result.connection.connection_mode, "real");
  assert.equal(result.connection.repo.owner, "some-adopter");
  assert.equal(result.connection.repo.name, "their-own-repo");
  assert.equal(result.connection.repo.owner_source, "origin_remote");
  assert.equal(result.connection.local_auth.mode, "local_ambient");
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.ok(!transport.calls.some((call) => call.endpointId === "create_repository"));
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.deepEqual(identity.repo, { owner: "some-adopter", repo: "their-own-repo" });
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

test("existing behavior repo is bound rather than treated as a name collision", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({
    existingRepos: [`${DRY_RUN_OWNER_PLACEHOLDER}/${DEFAULT_BEHAVIOR_REPO_NAME}`],
  });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  assert.equal(result.connection.repo.full_name, `${DRY_RUN_OWNER_PLACEHOLDER}/${DEFAULT_BEHAVIOR_REPO_NAME}`);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(result.connection.local_auth.mode, "local_ambient");
  assert.ok(!transport.calls.some((call) => call.endpointId === "create_repository"));
});

test("real init resumes a repo created by a prior pending local GitHub run", async () => {
  const root = initGitRepo(tempRoot(), { remotes: { origin: `${STARTER_URL}.git` } });
  writeStateFixture(root, {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "real",
    status: "pending_org_approval",
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
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    failures: [
      {
        reason: "behavior_repo_creation_pending_org_approval",
        repair: "approve repo creation",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
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
  assert.equal(Object.hasOwn(result.connection, "setup_grant"), false);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(result.connection.local_auth.real_push_enabled, true);
  assert.ok(!mock.calls.some((call) => call.endpointId === "create_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "push_initial_branch"));
  assert.deepEqual(listRemotes(root), {
    origin: "https://github.com/shulmansj/agentic-factory",
    upstream: `${STARTER_URL}.git`,
  });
});

test("real init resumes a repo created before a failed local auth verification", async () => {
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
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    failures: [
      {
        reason: "behavior_repo_unreachable",
        repair: "retry GitHub setup",
        detail: "local gh auth could not reach the repo",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
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
  assert.equal(Object.hasOwn(result.connection, "setup_grant"), false);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.ok(!mock.calls.some((call) => call.endpointId === "create_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "get_repository"));
  assert.ok(mock.calls.some((call) => call.endpointId === "push_initial_branch"));
});

test("real init resumes an empty repo after a prior failed state overwrote creation evidence", async () => {
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
    push_verification: null,
    pre_push_sanitizer: null,
    pr_generation: null,
    failures: [
      {
        reason: "behavior_repo_unreachable",
        repair: "repo was not reachable",
        detail: "gh could not reach shulmansj/agentic-factory",
      },
    ],
    verified_at: null,
  });
  const mock = createMockGitHubSetupTransport({
    existingRepos: ["shulmansj/agentic-factory"],
    existingRepoDetails: {
      "shulmansj/agentic-factory": { empty: true, visibility: "private" },
    },
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
  assert.equal(Object.hasOwn(result.connection, "setup_grant"), false);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
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
  assert.match(result.repair, /rather than silently completing a partial adoption/);
  // The pending state is durable for doctor, but never a verified connection.
  const stored = readGitHubConnectionState({ repoRoot: root });
  assert.equal(stored.ok, true);
  assert.equal(stored.connection.status, "pending_org_approval");
  assert.equal(resolveBehaviorRepoIdentity({ repoRoot: root }).ok, false);
  assert.ok(!transport.calls.some((call) => call.endpointId === "push_initial_branch"));
});

test("real GitHub phase records local ambient auth without install callbacks", async () => {
  const root = tempRoot();
  const calls = [];
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
              default_branch: "main",
            },
          };
        case "push_initial_branch":
          return { pushed: true, recorded: true, branch: params.branch, head_sha: params.head_sha };
        case "verify_default_branch":
          return { verified: true, default_branch: params.branch, head_sha: params.head_sha };
        default:
          throw new Error(`unexpected_endpoint:${endpointId}`);
      }
    },
  };

  const { result } = await runPhase({
    root,
    config: configWithStarter({
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
    }),
    transport,
    runGit,
  });

  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(Object.hasOwn(result.connection, "setup_grant"), false);
  assert.equal(result.connection.local_auth.mode, "local_ambient");
  assert.equal(result.connection.local_auth.real_push_enabled, true);
  assert.equal(result.connection.pr_generation.derived_from, "local_ambient_git_gh_auth");
  const order = calls.map((call) => call.type === "transport" ? `transport:${call.endpointId}` : call.type);
  assert.deepEqual(
    order.filter((entry) => entry.startsWith("transport:")),
    ["transport:get_repository", "transport:push_initial_branch", "transport:verify_default_branch"],
  );
});

// ---------------------------------------------------------------------------
// Local ambient auth replaces external setup credentials.
// ---------------------------------------------------------------------------

test("local ambient init stores only local auth proof for GitHub writes", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport();
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  const order = transport.calls.map((call) => call.endpointId);
  assert.ok(order.indexOf("create_repository") < order.indexOf("push_initial_branch"));
  assert.deepEqual(order, ["get_repository", "create_repository", "push_initial_branch", "verify_default_branch"]);
  assert.equal(Object.hasOwn(result.connection, "setup_grant"), false);
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(result.connection.local_auth.mode, "local_ambient");
});

test("local behavior repo proof records stable repo id and ambient auth state", async () => {
  const root = initGitRepo(tempRoot());
  const transport = createMockGitHubSetupTransport({
    repositoryId: "repo-selected-123",
  });
  const { result } = await runPhase({ root, transport });
  assert.equal(result.ok, true);
  assert.equal(result.connection.repo.id, "repo-selected-123");
  assert.equal(Object.hasOwn(result.connection, "app_installation"), false);
  assert.equal(result.connection.local_auth.mode, "local_ambient");
  assert.equal(result.connection.push_auth, "https");
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.equal(identity.repo_id, "repo-selected-123");
  assert.equal(identity.push_auth, "https");
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

test("init succeeds only when repo reachability, origin plan, push verify, and local auth recording pass", async () => {
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
  assert.equal(Object.hasOwn(connection, "app_installation"), false);
  assert.equal(connection.push_verification.verified, true);
  assert.equal(connection.push_verification.push_auth, "https");
  assert.equal(connection.local_auth.mode, "local_ambient");
  assert.equal(connection.local_auth.real_push_enabled, false);
  assert.equal(connection.pr_generation.verified, true);
  assert.equal(connection.pr_generation.derived_from, "local_ambient_git_gh_auth");
  assert.equal(Object.hasOwn(connection, "setup_grant"), false);
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

test("a transport failure during behavior repo lookup fails init with a local gh repair path", async () => {
  const root = initGitRepo(tempRoot());
  const { result } = await runPhase({
    root,
    transport: createMockGitHubSetupTransport({
      failures: { get_repository: { error: new Error("github api unreachable") } },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "github_repo_lookup_failed");
  assert.match(result.detail, /github api unreachable/);
  assert.match(result.repair, /verify local gh auth/);
});

test("an unverified initial-branch push fails init", async () => {
  const root = initGitRepo(tempRoot());
  const { result } = await runPhase({
    root,
    transport: createMockGitHubSetupTransport({ pushVerified: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "initial_branch_push_unverified");
  assert.match(result.repair, /push the initial main branch/);
});

test("dry-run mode is loudly disclosed: banner, incomplete adoption, and connection_mode dry_run", async () => {
  const root = initGitRepo(tempRoot());
  const { result, progress } = await runPhase({ root }); // default transport = dry-run
  assert.equal(result.ok, true);
  assert.equal(result.transport_kind, "dry_run");
  assert.equal(result.connection.connection_mode, "dry_run");
  const output = progress.join("\n");
  assert.match(output, /DRY-RUN GITHUB SETUP/);
  assert.match(output, /local git\/gh auth/);
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

test("resolveBehaviorRepoIdentity returns local ambient auth details", () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({ pushAuth: "ssh", checkoutPath: "C:/work/agentic-factory" }));
  const identity = resolveBehaviorRepoIdentity({ repoRoot: root });
  assert.equal(identity.ok, true);
  assert.equal(identity.push_auth, "ssh");
  assert.equal(identity.checkout_path, "C:/work/agentic-factory");
  assert.equal(identity.real_push_enabled, true);
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
  assert.equal(byName["GitHub behavior repo reachable"], undefined);
  assert.equal(byName["GitHub local write auth"], undefined);
});

test("doctor reports remote drift against a real verified connection with an exact repair", async () => {
  const root = initGitRepo(tempRoot(), {
    remotes: { origin: "https://github.com/somebody/wrong-repo" },
  });
  writeStateFixture(root, verifiedRealStateFixture({ owner: "acme", name: "acme-behavior" }));
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
  });
  const remoteCheck = checks.find((check) => check.name === "GitHub remote shape");
  assert.equal(remoteCheck.ok, false);
  assert.match(remoteCheck.message, /remote drift/);
  assert.match(remoteCheck.message, /git remote set-url origin https:\/\/github\.com\/acme\/acme-behavior/);
  assert.match(remoteCheck.message, /upstream is missing/);
});

test("doctor reports behavior repo reachability and local write auth", async () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({ checkoutPath: root }));
  const transport = createMockGitHubSetupTransport({
    existingRepos: ["real-owner/real-behavior-repo"],
  });
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    runGit: createInMemoryRunGit({
      remotes: {
        origin: "https://github.com/real-owner/real-behavior-repo",
        upstream: STARTER_URL,
      },
    }),
    transport,
  });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub remote shape"].ok, true);
  assert.equal(byName["GitHub behavior repo reachable"].ok, true);
  assert.match(byName["GitHub behavior repo reachable"].message, /reachable with local gh auth/);
  assert.equal(byName["GitHub local write auth"].ok, true);
  assert.match(byName["GitHub local write auth"].message, /git push --dry-run can create/);
});

test("doctor fails closed when the behavior repo is unreachable with local gh auth", async () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({ checkoutPath: root }));
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    runGit: createInMemoryRunGit({
      remotes: {
        origin: "https://github.com/real-owner/real-behavior-repo",
        upstream: STARTER_URL,
      },
    }),
    transport: createMockGitHubSetupTransport({ existingRepos: [] }),
  });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub behavior repo reachable"].ok, false);
  assert.match(byName["GitHub behavior repo reachable"].message, /not reachable with local gh auth/);
});

test("doctor fails closed when local git write auth cannot push a behavior branch", async () => {
  const root = tempRoot();
  writeStateFixture(root, verifiedRealStateFixture({ checkoutPath: root }));
  const runGit = (args, options = {}) => {
    if (args[0] === "push" && args[1] === "--dry-run") {
      return { ok: false, status: 1, stdout: "", stderr: "permission denied" };
    }
    return createInMemoryRunGit({
      remotes: {
        origin: "https://github.com/real-owner/real-behavior-repo",
        upstream: STARTER_URL,
      },
    })(args, options);
  };
  const checks = await githubConnectionDoctorChecks({
    repoRoot: root,
    runGit,
    transport: createMockGitHubSetupTransport({ existingRepos: ["real-owner/real-behavior-repo"] }),
  });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub behavior repo reachable"].ok, true);
  assert.equal(byName["GitHub local write auth"].ok, false);
  assert.match(byName["GitHub local write auth"].message, /permission denied/);
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
  assert.doesNotMatch(dispatchSource, /createHostedInboxClient/);
  assert.equal(dispatchSource.includes(["inbox", "Client"].join("")), false);
  assert.ok(
    setupSource.includes("githubInitTransportFromFlags") &&
      setupSource.includes("githubSetupTransportFromFlags"),
    "full init must resolve GitHub setup through the shared local-ambient transport helper",
  );
  assert.ok(
    setupSource.includes("return githubSetupTransportFromFlags({ config, flags, repoRoot, onProgress })"),
    "github init transport helper must delegate to the flag-based local/dry-run transport resolver",
  );
  assert.ok(
    dispatchSource.includes("githubInitTransportFromFlags"),
    "standalone github:init must reuse the full-init GitHub transport helper",
  );
  assert.ok(
    dispatchSource.includes("transport: await githubInitTransportFromFlags({"),
    "standalone github:init must choose the shared init transport before running the phase",
  );
  assert.doesNotMatch(dispatchSource, /githubLiveRequested|issueInstallationBoundGitHubBrokerCredential/);
  assert.doesNotMatch(dispatchSource, /githubInstallIntent|githubInstallStatus/);
  assert.doesNotMatch(setupSource, /githubInstallIntent: \(input\)|githubInstallStatus: \(input\)/);
  const initIndex = setupSource.indexOf("runGitHubInitPhase(");
  const pendingIndex = setupSource.indexOf('Move a Linear project to "Planned" to start your first run');
  assert.ok(initIndex >= 0 && initIndex < pendingIndex, "GitHub phase must gate the pending init completion");
  assert.ok(
    setupSource.includes('Move a Linear project to "Planned" to start your first run') &&
      setupSource.includes("factory gateway start") &&
      setupSource.includes("factory doctor") &&
      setupSource.includes("Setup complete."),
    "init must end with the factory gateway start next step and the factory doctor command",
  );
  assert.doesNotMatch(setupSource, /running/);
  assert.doesNotMatch(setupSource, /requestSetupGrant|writeInboxSetupGrant|setup_grant_conflict/);
  assert.ok(setupSource.includes('output.info("GitHub connected.")'), "init should surface the GitHub connected state");
  assert.doesNotMatch(setupSource, /Linear workspace setup is ready|First domain is ready/);
  assert.doesNotMatch(setupSource, /ensureWebhookAdminAuthorization/);
});
