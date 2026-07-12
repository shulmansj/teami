import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cachePathForConfig, loadLinearConfig } from "../src/config.mjs";
import {
  resolveClaudePluginPhaseResumeDomain,
  runLinearSetupCommand,
  runClaudePluginRegistrationStep,
} from "../src/cli/linear-setup-command.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  readDomainRegistry,
} from "../src/domain-registry.mjs";
import {
  GITHUB_CONNECTION_SCHEMA_VERSION,
  githubConnectionStatePath,
} from "../src/github-setup.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const PUBLISHED_MARKETPLACE_SOURCE = "https://github.com/shulmansj/teami";

test("Claude plugin registration installs once and is a no-op on re-run", async () => {
  const output = captureOutput();
  const fakeClaude = createFakeClaudeRunner();

  const first = await runClaudePluginRegistrationStep({
    repoRoot,
    output,
    runCommand: fakeClaude.runCommand,
  });
  const second = await runClaudePluginRegistrationStep({
    repoRoot,
    output,
    runCommand: fakeClaude.runCommand,
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, "installed");
  assert.equal(second.ok, true);
  assert.equal(second.status, "already_installed");
  const commands = fakeClaude.calls.map((call) => call.args.join(" "));
  assert.ok(commands.includes(`plugin marketplace add ${repoRoot} --scope user`));
  assert.equal(commands.filter((command) => command === "plugin install teami@teami --scope user").length, 1);
  assert.ok(commands.filter((command) => command === "plugin marketplace list --json").length >= 3);
  assert.equal(commands.at(-1), "plugin list --json");
  assert.match(output.text(), /Claude command available: \/teami:plan/);
});

test("Claude plugin registration refreshes an existing marketplace source before install", async () => {
  const fakeClaude = createFakeClaudeRunner({ addMarketplaceOk: false });

  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    output: captureOutput(),
    runCommand: fakeClaude.runCommand,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "installed");
  const commands = fakeClaude.calls.map((call) => call.args.join(" "));
  assert.ok(commands.includes("plugin marketplace update teami"));
  assert.equal(commands.includes(`plugin marketplace add ${repoRoot} --scope user`), false);
  assert.ok(commands.includes("plugin install teami@teami --scope user"));
});

test("Claude plugin registration rejects an installed publication placeholder", async (t) => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    output: captureOutput(),
    runCommand: async (command, args) => {
      assert.equal(command, "claude");
      if (args.join(" ") === "plugin marketplace list --json") {
        return ok(JSON.stringify([{ name: "teami", source: "directory", path: repoRoot }]));
      }
      assert.deepEqual(args, ["plugin", "list", "--json"]);
      return ok(JSON.stringify({ plugins: [{
        id: "teami@teami",
        name: "teami",
        version: "0.3.20",
        scope: "user",
        enabled: true,
        mcpServers: {
          teami: { command: "npx", args: ["-y", "@shulmansj/teami@__TEAMI_VERSION__", "mcp"] },
        },
      }] }));
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "claude_plugin_launch_contract_mismatch");
  assert.match(result.detail, /no publication placeholder/);
  assert.equal(process.exitCode, 1);
});

test("Claude plugin registration rejects a same-name plugin from another marketplace", async (t) => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  t.after(() => { process.exitCode = previousExitCode; });
  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    output: captureOutput(),
    runCommand: async (_command, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return ok(JSON.stringify([{ name: "teami", source: "directory", path: repoRoot }]));
      }
      return ok(JSON.stringify({ plugins: [{
        id: "teami@evil-marketplace",
        name: "teami",
        version: "0.3.20",
        scope: "user",
        enabled: true,
        mcpServers: { teami: { command: "npx", args: ["-y", "@shulmansj/teami@0.3.20", "mcp"] } },
      }] }));
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "claude_plugin_identity_mismatch");
  assert.match(result.detail, /teami@evil-marketplace/);
});

test("Claude plugin registration rejects a marketplace-name collision before update or install", async (t) => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  t.after(() => { process.exitCode = previousExitCode; });
  const calls = [];
  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    marketplaceSource: PUBLISHED_MARKETPLACE_SOURCE,
    output: captureOutput(),
    runCommand: async (_command, args) => {
      calls.push(args.join(" "));
      return ok(JSON.stringify([{ name: "teami", source: "github", repo: "attacker/teami" }]));
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "claude_plugin_marketplace_source_mismatch");
  assert.deepEqual(calls, ["plugin marketplace list --json"]);
});

test("bare init can resume only the Claude plugin phase after Linear and GitHub are complete", () => {
  const registry = {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [
      {
        id: "turnip",
        status: "active",
        adopter_provided_name: "turnip",
        linear: {
          workspace_id: "workspace-1",
          workspace_name: "Workspace One",
          team_id: "team-turnip",
          team_name: "turnip",
        },
      },
    ],
  };
  const readVerifiedConnection = () => ({
    ok: true,
    connection: {
      connection_mode: "real",
      status: "verified",
      adoption_complete: true,
    },
  });

  assert.equal(
    resolveClaudePluginPhaseResumeDomain({
      args: [],
      registry,
      readConnectionState: readVerifiedConnection,
    })?.id,
    "turnip",
  );
  assert.equal(
    resolveClaudePluginPhaseResumeDomain({
      args: ["--domain", "turnip"],
      registry,
      readConnectionState: readVerifiedConnection,
    }),
    null,
  );
  assert.equal(
    resolveClaudePluginPhaseResumeDomain({
      args: [],
      registry,
      readConnectionState: () => ({ ok: false, reason: "missing_github_connection_state" }),
    }),
    null,
  );
});

test("published package exposes the scoped npx Teami init entrypoint", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const cliSource = fs.readFileSync(path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs"), "utf8");

  assert.equal(packageJson.private, false);
  assert.deepEqual(packageJson.bin, {
    teami: "execution/integrations/linear/cli.mjs",
  });
  assert.match(cliSource, /runCliCommand\(\{ repoRoot, command, args: process\.argv\.slice\(3\) \}\)/);
});

test("teami init uses the published marketplace, records git_repo, and resumes plugin install", async (t) => {
  const home = tempHome(t, "teami-init-plugin-registration-");
  const config = fileCredentialConfig(loadLinearConfig({ repoRoot }));
  const output = captureOutput();
  const client = new SetupMemoryLinearClient({
    workspaceId: "workspace-1",
    workspaceName: "Workspace One",
  });
  const fakeClaude = createFakeClaudeRunner({ failInstallOnce: true });
  const githubDiscovery = fakeGhRunner({
    repos: [ghRepo("Acme/app", "trunk")],
    packageJsonByRepo: {
      "Acme/app": { scripts: { setup: "npm ci", test: "npm test" } },
    },
  });
  const prompts = [];
  const phaseCalls = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runLinearSetupCommand({
      command: "init",
      args: ["--domain", "Product Ops"],
      context: {
        config,
        repoRoot: home,
        home,
        cachePath: cachePathForConfig(config, home),
        output,
        confirmSetupEffects: async () => true,
        isTTY: true,
        // Auto-continue the "Authorized workspace … Press Enter to continue" confirmation so the
        // TTY init flow does not block on real stdin in the test.
        promptReauthorize: async () => "",
        startLinearBrowserAuthorization: instantBrowserAuthorization(),
        createLinearSetupAuth: ({ allowBrowserAuth, deferTokenPersistence }) => {
          assert.equal(allowBrowserAuth, true);
          assert.equal(deferTokenPersistence, true);
          return fakeSetupAuth(client, { tokenSource: "browser" });
        },
        githubDiscoveryRunCommand: githubDiscovery.runCommand,
        githubRepoAllowlistPrompt: promptAnswers([""], prompts),
        ensurePhoenixReady: async () => ({ ok: false, reason: "phoenix skipped in test" }),
        githubInitTransportFromFlags: async () => ({}),
        runGitHubInitPhase: async ({ home: phaseHome }) => {
          phaseCalls.push("github");
          const connection = writeVerifiedGitHubConnection(phaseHome);
          return { ok: true, status: "verified", connection };
        },
        claudePluginRunCommand: fakeClaude.runCommand,
        finalGate: async () => ({ ok: true, smokeOk: true, doctorOk: true }),
      },
    });

    assert.equal(process.exitCode, 1);
    assert.deepEqual(phaseCalls, ["github"]);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Allow this team to work in Acme\/app/);
    assert.match(output.text(), /Build\/test auto-detected for Acme\/app: npm run setup -> npm test/);

    let registry = readDomainRegistry({ home });
    let domain = registry.domains.find((candidate) => candidate.id === "product-ops");
    assert.equal(domain.status, "active");
    assert.deepEqual(domain.resources, [
      {
        id: "git_repo:acme/app",
        kind: "git_repo",
        role: "primary",
        binding: {
          owner: "Acme",
          repo: "app",
          default_branch: "trunk",
        },
      },
    ]);
    assert.equal(Object.hasOwn(domain.resources[0].binding, "local_checkout_path"), false);

    process.exitCode = undefined;
    await runLinearSetupCommand({
      command: "init",
      args: [],
      context: {
        config,
        repoRoot: home,
        home,
        cachePath: cachePathForConfig(config, home),
        output,
        confirmSetupEffects: async () => true,
        isTTY: false,
        startLinearBrowserAuthorization: instantBrowserAuthorization(),
        createLinearSetupAuth: () => fakeSetupAuth(client, { tokenSource: "stored" }),
        githubDiscoveryRunCommand: () => {
          throw new Error("repo discovery must be skipped on plugin-phase resume");
        },
        githubInitTransportFromFlags: async () => {
          throw new Error("GitHub transport must be skipped on plugin-phase resume");
        },
        runGitHubInitPhase: async () => {
          throw new Error("GitHub phase must be skipped on plugin-phase resume");
        },
        claudePluginRunCommand: fakeClaude.runCommand,
        finalGate: async () => ({ ok: true, smokeOk: true, doctorOk: true }),
      },
    });

    assert.equal(process.exitCode, 0, output.text());
    registry = readDomainRegistry({ home });
    domain = registry.domains.find((candidate) => candidate.id === "product-ops");
    assert.deepEqual(domain.resources[0].binding, {
      owner: "Acme",
      repo: "app",
      default_branch: "trunk",
    });
    assert.deepEqual(
      fakeClaude.calls
        .filter((call) => call.args[0] === "plugin" && call.args[1] === "marketplace" && call.args[2] === "add")
        .map((call) => call.args[3]),
      [PUBLISHED_MARKETPLACE_SOURCE],
    );
    assert.equal(
      fakeClaude.calls.some((call) => call.args.includes(home) || call.args.includes(repoRoot)),
      false,
      "init must not install the plugin from a local checkout path",
    );
    assert.deepEqual(
      fakeClaude.calls.filter((call) => call.args[0] === "plugin" && call.args[1] === "install").map((call) => call.args),
      [
        ["plugin", "install", "teami@teami", "--scope", "user"],
        ["plugin", "install", "teami@teami", "--scope", "user"],
      ],
    );
  } finally {
    process.exitCode = previousExitCode;
  }
});

function createFakeClaudeRunner({
  addMarketplaceOk = true,
  failInstallOnce = false,
} = {}) {
  const state = {
    marketplaceReady: !addMarketplaceOk,
    marketplaceSource: !addMarketplaceOk ? repoRoot : null,
    installed: false,
    installFailed: false,
  };
  const calls = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, "claude");
    switch (args.join(" ")) {
      case "plugin marketplace list --json":
        return ok(JSON.stringify(state.marketplaceReady ? [
          String(state.marketplaceSource).startsWith("http")
            ? { name: "teami", source: "github", repo: "shulmansj/teami" }
            : {
                name: "teami",
                source: "directory",
                path: state.marketplaceSource,
                installLocation: state.marketplaceSource,
              },
        ] : []));
      case "plugin list --json":
        return ok(JSON.stringify({
          plugins: state.installed ? [{
            id: "teami@teami",
            name: "teami",
            version: "0.3.20",
            scope: "user",
            enabled: true,
            mcpServers: {
              teami: { command: "npx", args: ["-y", "@shulmansj/teami@0.3.20", "mcp"] },
            },
          }] : [],
        }));
      case "plugin marketplace add PLACEHOLDER --scope user":
        throw new Error("placeholder command should not be reached");
      case "plugin marketplace update teami":
        state.marketplaceReady = true;
        return ok("marketplace refreshed");
      case "plugin install teami@teami --scope user":
        assert.equal(state.marketplaceReady, true, "marketplace source must be ready before install");
        if (failInstallOnce && !state.installFailed) {
          state.installFailed = true;
          return fail("injected plugin install failure");
        }
        state.installed = true;
        return ok("installed teami");
      default:
        if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
          assert.equal(args[4], "--scope");
          assert.equal(args[5], "user");
          if (!addMarketplaceOk) return fail("marketplace already exists");
          state.marketplaceReady = true;
          state.marketplaceSource = args[3];
          return ok("marketplace added");
        }
        return fail(`unexpected claude command: ${args.join(" ")}`);
    }
  };
  return { calls, runCommand };
}

function captureOutput() {
  const lines = [];
  const push = (kind, text) => lines.push(`${kind}: ${String(text)}`);
  return {
    verbose: false,
    symbols: {
      separator: "-",
      ellipsis: "...",
    },
    style: new Proxy(
      {},
      { get: () => (value) => String(value) },
    ),
    heading: (text) => push("heading", text),
    section: (text) => push("section", text),
    step: (index, total, text) => push("step", `${index}/${total} ${text}`),
    detail: (text) => push("detail", text),
    success: (text) => push("success", text),
    info: (text) => push("info", text),
    warn: (text) => push("warn", text),
    error: (value) => push("error", JSON.stringify(value)),
    done: (text) => push("done", text),
    nextSteps: (items) => push("next", items.map((item) => item.text || item).join(" | ")),
    raw: (text) => push("raw", text),
    progress: (text) => {
      push("progress", text);
      return { stop: () => push("progress", "stop") };
    },
    text: () => lines.join("\n"),
  };
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "") {
  return { ok: false, status: 1, stdout: "", stderr };
}

function tempHome(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env.TEAMI_HOME;
  process.env.TEAMI_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.TEAMI_HOME;
    else process.env.TEAMI_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fileCredentialConfig(config) {
  const next = structuredClone(config);
  next.linear.oauth.credential_storage = "file";
  return next;
}

function fakeSetupAuth(client, { tokenSource = null } = {}) {
  return {
    client,
    tokenProvider: {
      lastTokenSource: tokenSource,
      clear: async () => {},
      persistPendingTokenSet: async () => true,
      discardPendingTokenSet: async () => {},
    },
  };
}

function instantBrowserAuthorization() {
  return async () => ({
    authorizationUrl: "https://linear.test/oauth/authorize",
    expiresAt: "2099-01-01T00:00:00.000Z",
    browser: { opened: true, reason: null },
    waitForToken: async () => ({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "Bearer",
      scope: "read write",
      expires_in: 3600,
    }),
    close() {},
  });
}

function writeVerifiedGitHubConnection(home) {
  const connection = {
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    status: "verified",
    connection_mode: "real",
    adoption_complete: true,
    verified_at: "2026-07-08T00:00:00.000Z",
    repo: {
      full_name: "Acme/behavior",
      owner: "Acme",
      name: "behavior",
      default_branch: "main",
    },
    permissions: {},
    failures: [],
  };
  const statePath = githubConnectionStatePath(home);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(connection, null, 2)}\n`, "utf8");
  return connection;
}

function fakeGhRunner({
  repos = [],
  packageJsonByRepo = {},
} = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "gh") return fail(`unexpected command: ${command}`);
    if (args.join(" ") === "auth status --hostname github.com") {
      return ok("github.com\n  ✓ Logged in to github.com");
    }
    if (args.join(" ") === "repo list --limit 50 --json nameWithOwner,defaultBranchRef") {
      return ok(JSON.stringify(repos));
    }
    if (args[0] === "api") {
      const match = String(args[1] || "").match(/^repos\/([^/]+)\/([^/]+)\/contents\/package\.json\?/);
      if (!match) return fail(`unexpected gh api endpoint: ${args[1]}`);
      const key = `${match[1]}/${match[2]}`;
      if (!Object.hasOwn(packageJsonByRepo, key)) return fail("HTTP 404: Not Found");
      return ok(JSON.stringify({
        encoding: "base64",
        content: Buffer.from(JSON.stringify(packageJsonByRepo[key]), "utf8").toString("base64"),
      }));
    }
    return fail(`unexpected gh command: ${args.join(" ")}`);
  };
  return { calls, runCommand };
}

function ghRepo(nameWithOwner, defaultBranch) {
  return {
    nameWithOwner,
    defaultBranchRef: { name: defaultBranch },
  };
}

function promptAnswers(answers, prompts = []) {
  const remaining = [...answers];
  return async (message) => {
    prompts.push(message);
    return remaining.length > 0 ? remaining.shift() : "";
  };
}

function generatedTeamKey(name, fallbackNumber) {
  const letters = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 3);
  return letters || `T${fallbackNumber}`;
}

function defaultWorkflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog" },
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-in-progress", name: "In Progress", type: "started" },
    { id: "state-in-review", name: "In Review", type: "started" },
    { id: "state-human-review", name: "Principal Review", type: "started" },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started" },
    { id: "state-done", name: "Done", type: "completed" },
  ];
}

class SetupMemoryLinearClient {
  constructor({
    workspaceId = "workspace-1",
    workspaceName = "Example Workspace",
  } = {}) {
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
    this.teams = [];
    this.projectLabels = [];
    this.issueLabels = [];
    this.templates = [];
    this.projectStatuses = [
      { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
      { id: "status-planned", name: "Planned", type: "planned", position: 20 },
      { id: "status-started", name: "In Progress", type: "started", position: 30 },
      { id: "status-completed", name: "Completed", type: "completed", position: 40 },
      { id: "status-principal-escalation", name: "Principal Escalation", type: "planned", position: 20.01 },
    ];
    this.workflowStates = defaultWorkflowStates();
  }

  async verifyAuth() {
    return { viewerId: "app-viewer-1", viewerName: "Teami App" };
  }

  async getOrganization() {
    return { id: this.workspaceId, name: this.workspaceName };
  }

  async listTeams() {
    return this.teams;
  }

  async createTeam(input) {
    const teamNumber = this.teams.length + 1;
    const team = {
      id: `team-${teamNumber}`,
      ...input,
      key: input.key || generatedTeamKey(input.name, teamNumber),
    };
    this.teams.push(team);
    return team;
  }

  async findProjectLabelsByName(name) {
    return this.projectLabels.filter((label) => !name || label.name === name);
  }

  async createProjectLabel(input) {
    const slug = slugify(input.name, this.projectLabels.length + 1);
    const label = { id: `plabel-${slug}`, ...input };
    this.projectLabels.push(label);
    return label;
  }

  async updateProjectLabel(id, input) {
    const label = this.projectLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear project label ${id} not found.`);
    Object.assign(label, input);
    return label;
  }

  async findIssueLabelsByName(name, teamId) {
    return this.issueLabels.filter(
      (label) => !label.archived && (!name || label.name === name) && (!teamId || label.teamId === teamId),
    );
  }

  async createIssueLabel(input) {
    const slug = slugify(input.name, this.issueLabels.length + 1);
    const label = { id: `ilabel-${slug}`, ...input };
    this.issueLabels.push(label);
    return label;
  }

  async updateIssueLabel(id, input) {
    const label = this.issueLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear issue label ${id} not found.`);
    Object.assign(label, input);
    return label;
  }

  async archiveIssueLabel(id) {
    const label = this.issueLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear issue label ${id} not found.`);
    label.archived = true;
    return { ok: true };
  }

  async listProjectStatuses() {
    return this.projectStatuses;
  }

  async listWorkflowStates() {
    return this.workflowStates.filter((state) => !state.archived);
  }

  async createWorkflowState(input) {
    const slug = slugify(input.name, this.workflowStates.length + 1);
    const state = { id: `state-${slug}`, ...input };
    this.workflowStates.push(state);
    return state;
  }

  async updateWorkflowState(id, input) {
    const state = this.workflowStates.find((candidate) => candidate.id === id);
    if (!state) throw new Error(`Linear workflow state ${id} not found.`);
    Object.assign(state, input);
    return state;
  }

  async archiveWorkflowState(id) {
    const state = this.workflowStates.find((candidate) => candidate.id === id);
    if (!state) throw new Error(`Linear workflow state ${id} not found.`);
    state.archived = true;
    return { ok: true };
  }

  async findTemplatesByName(name, type, teamId) {
    return this.templates.filter(
      (template) =>
        (!name || template.name === name) &&
        (!type || template.type === type) &&
        (!teamId || template.teamId === teamId),
    );
  }

  async createTemplate(input) {
    const template = { id: `template-${this.templates.length + 1}`, ...input };
    this.templates.push(template);
    return template;
  }

  async updateTemplate(id, input) {
    const template = this.templates.find((candidate) => candidate.id === id);
    if (!template) throw new Error(`Linear template ${id} not found.`);
    Object.assign(template, input);
    return template;
  }
}

function slugify(value, fallbackNumber) {
  return String(value || fallbackNumber)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || String(fallbackNumber);
}
