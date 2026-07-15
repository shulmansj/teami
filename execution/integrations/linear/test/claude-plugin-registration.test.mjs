import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cachePathForConfig, loadLinearConfig } from "../src/config.mjs";
import {
  resolveClaudePluginPhaseResumeDomain,
  resolveInitDomainName,
  runLinearSetupCommand,
  runClaudePluginRegistrationStep,
} from "../src/cli/linear-setup-command.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  emptyDomainRegistry,
  makeDomainRecord,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
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

test("Claude plugin registration upgrades a stale installed version and verifies exact read-back", async () => {
  const fakeClaude = createFakeClaudeRunner({ addMarketplaceOk: false, installedVersion: "0.3.19" });
  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    output: captureOutput(),
    runCommand: fakeClaude.runCommand,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "updated");
  assert.equal(result.version, "0.3.20");
  assert.ok(fakeClaude.calls.some((call) =>
    call.args.join(" ") === "plugin update teami@teami --scope user"));
});

test("Claude plugin registration repairs a stale launcher even when its display version matches", async () => {
  const fakeClaude = createFakeClaudeRunner({
    addMarketplaceOk: false,
    installedVersion: "0.3.20",
    installedPackageRef: "__TEAMI_VERSION__",
  });
  const result = await runClaudePluginRegistrationStep({
    repoRoot,
    output: captureOutput(),
    runCommand: fakeClaude.runCommand,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "updated");
  assert.ok(fakeClaude.calls.some((call) =>
    call.args.join(" ") === "plugin update teami@teami --scope user"));
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

test("bare CLI repair preserves a single existing team without asking the adopter to retype it", async () => {
  const result = await resolveInitDomainName([], {
    command: "init",
    registry: {
      schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
      domains: [{
        id: "support-ops",
        status: "active",
        adopter_provided_name: "Support Ops",
      }],
    },
    isTTY: true,
    prompt: async () => {
      throw new Error("single-team repair must not prompt for a name Teami already knows");
    },
  });

  assert.equal(result, "Support Ops");
});

test("bare CLI asks for a team name only when multiple existing teams are ambiguous", async () => {
  const prompts = [];
  const result = await resolveInitDomainName([], {
    command: "init",
    registry: {
      schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
      domains: [
        { id: "support-ops", status: "active", adopter_provided_name: "Support Ops" },
        { id: "growth", status: "active", adopter_provided_name: "Growth" },
      ],
    },
    isTTY: true,
    prompt: async (message) => {
      prompts.push(message);
      return "Growth";
    },
  });

  assert.equal(result, "Growth");
  assert.deepEqual(prompts, ["Linear team name: "]);
});

test("bare domain add asks for the new team even when one existing team is known", async () => {
  const prompts = [];
  const result = await resolveInitDomainName([], {
    command: "domain:add",
    registry: {
      schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
      domains: [{ id: "support-ops", status: "active", adopter_provided_name: "Support Ops" }],
    },
    isTTY: true,
    prompt: async (message) => {
      prompts.push(message);
      return "Sales Ops";
    },
  });

  assert.equal(result, "Sales Ops");
  assert.deepEqual(prompts, ["Linear team name: "]);
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

test("bare teami init defaults the visible team name, skips product-repo discovery, rechecks GitHub, and resumes plugin install", async (t) => {
  const home = tempHome(t, "teami-init-plugin-registration-");
  const config = fileCredentialConfig(loadLinearConfig({ repoRoot }));
  const output = captureOutput();
  const client = new SetupMemoryLinearClient({
    workspaceId: "workspace-1",
    workspaceName: "Workspace One",
  });
  const fakeClaude = createFakeClaudeRunner({ failInstallOnce: true });
  const phaseCalls = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
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
        isTTY: true,
        promptDomainName: async () => {
          throw new Error("fresh bare init must use the safe default without prompting");
        },
        // Auto-continue the "Authorized workspace … Press Enter to continue" confirmation so the
        // TTY init flow does not block on real stdin in the test.
        promptReauthorize: async () => "",
        startLinearBrowserAuthorization: instantBrowserAuthorization(),
        createLinearSetupAuth: ({ allowBrowserAuth, deferTokenPersistence }) => {
          assert.equal(allowBrowserAuth, true);
          assert.equal(deferTokenPersistence, true);
          return fakeSetupAuth(client, { tokenSource: "browser" });
        },
        githubDiscoveryRunCommand: () => {
          throw new Error("fresh onboarding must not inspect product repositories");
        },
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
    assert.match(output.text(), /Product repositories: none/);

    let registry = readDomainRegistry({ home });
    let domain = registry.domains.find((candidate) => candidate.id === "teami");
    assert.equal(domain.status, "active");
    assert.deepEqual(domain.resources, []);

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
        promptDomainName: async () => {
          throw new Error("plugin-phase resume must not ask for the team name again");
        },
        startLinearBrowserAuthorization: instantBrowserAuthorization(),
        createLinearSetupAuth: () => fakeSetupAuth(client, { tokenSource: "stored" }),
        githubDiscoveryRunCommand: () => {
          throw new Error("repo discovery must be skipped on plugin-phase resume");
        },
        githubInitTransportFromFlags: async () => ({ kind: "real" }),
        runGitHubInitPhase: async ({ home: phaseHome }) => {
          phaseCalls.push("github");
          const connection = writeVerifiedGitHubConnection(phaseHome);
          return { ok: true, status: "verified", connection };
        },
        claudePluginRunCommand: fakeClaude.runCommand,
        finalGate: async () => ({ ok: true, smokeOk: true, doctorOk: true }),
      },
    });

    assert.equal(process.exitCode, 0, output.text());
    assert.deepEqual(phaseCalls, ["github", "github"]);
    registry = readDomainRegistry({ home });
    domain = registry.domains.find((candidate) => candidate.id === "teami");
    assert.deepEqual(domain.resources, []);
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

test("domain add uses shared onboarding and never discovers or expands product-repository access", async (t) => {
  const home = tempHome(t, "teami-domain-add-shared-onboarding-");
  const config = fileCredentialConfig(loadLinearConfig({ repoRoot }));
  const output = captureOutput();
  writeDomainRegistry({ home }, upsertDomainRecord(
    emptyDomainRegistry(),
    makeDomainRecord({
      domainId: "support-ops",
      status: "active",
      adopterProvidedName: "Support Ops",
      workspaceId: "workspace-1",
      workspaceName: "Workspace One",
      teamId: "team-support",
      teamKey: "SUP",
      teamName: "Support Ops",
      resources: [],
    }),
  ));
  let discoveryCalls = 0;
  const onboardingCalls = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await runLinearSetupCommand({
      command: "domain:add",
      args: ["--domain", "Sales Ops"],
      context: {
        config,
        repoRoot: home,
        home,
        cachePath: cachePathForConfig(config, home),
        output,
        confirmSetupEffects: async () => true,
        isTTY: true,
        createProjectMcpToolActions: () => ({
          init_onboarding: async (input) => {
            onboardingCalls.push(input);
            return {
              ok: true,
              status: "complete",
              steps: {
                linear: { ok: true, workspace: { id: "workspace-2", name: "Workspace Two" } },
                product_repos: { ok: true, repos: [] },
                github: { ok: true },
                plugin: { ok: true },
                phoenix: { ok: true },
                runtime: { ok: true },
                doctor: { ok: true, checks: [] },
              },
            };
          },
        }),
        githubDiscoveryRunCommand: () => {
          discoveryCalls += 1;
          throw new Error("domain add must not inspect product repositories");
        },
      },
    });

    assert.equal(result.ok, true, output.text());
    assert.equal(process.exitCode, 0, output.text());
    assert.equal(discoveryCalls, 0);
    assert.equal(onboardingCalls.length, 1);
    assert.equal(onboardingCalls[0].domain, "Sales Ops");
    assert.deepEqual(onboardingCalls[0].repo_intent, { mode: "non_code" });
    const registry = readDomainRegistry({ home });
    const existing = registry.domains.find((domain) => domain.id === "support-ops");
    assert.deepEqual(existing.resources, []);
    assert.match(output.text(), /Product repositories: none/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("bare CLI renders the shared existing-team chooser and resumes with explicit selection", async (t) => {
  const home = tempHome(t, "teami-cli-team-limit-choice-");
  const config = fileCredentialConfig(loadLinearConfig({ repoRoot }));
  const output = captureOutput();
  const onboardingCalls = [];
  const promptAnswers = ["9", "1"];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await runLinearSetupCommand({
      command: "init",
      args: [],
      context: {
        config,
        repoRoot: home,
        home,
        output,
        confirmSetupEffects: async () => true,
        isTTY: true,
        promptLinearTeamSelection: async () => promptAnswers.shift(),
        createProjectMcpToolActions: () => ({
          init_onboarding: async (input) => {
            onboardingCalls.push(input);
            if (onboardingCalls.length === 1) {
              return {
                ok: false,
                status: "team_selection_required",
                setup_id: "11111111-1111-4111-8111-111111111111",
                reason: "linear_team_limit_reached",
                teams: [{ id: "team-agent-platform", key: "AP", name: "Agent Platform" }],
              };
            }
            return {
              ok: true,
              status: "complete",
              steps: {
                linear: { ok: true, workspace: { name: "Workspace One" } },
                product_repos: { ok: true, repos: [] },
                github: { ok: true },
                plugin: { ok: true },
                phoenix: { ok: true },
                runtime: { ok: true },
                doctor: { ok: true, checks: [] },
              },
            };
          },
        }),
      },
    });

    assert.equal(result.ok, true, output.text());
    assert.equal(process.exitCode, 0, output.text());
    assert.equal(onboardingCalls.length, 2);
    assert.deepEqual(onboardingCalls[1], {
      setup_id: "11111111-1111-4111-8111-111111111111",
      linear_team_id: "team-agent-platform",
      linear_team_confirm: true,
    });
    assert.match(output.text(), /Linear can't create another team/);
    assert.match(output.text(), /Agent Platform \(AP\)/);
    assert.match(output.text(), /Enter a number from 0 to 1/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

function createFakeClaudeRunner({
  addMarketplaceOk = true,
  failInstallOnce = false,
  installedVersion = null,
  installedPackageRef = null,
} = {}) {
  const state = {
    marketplaceReady: !addMarketplaceOk,
    marketplaceSource: !addMarketplaceOk ? repoRoot : null,
    installed: Boolean(installedVersion),
    installedVersion: installedVersion || "0.3.20",
    installedPackageRef: installedPackageRef || installedVersion || "0.3.20",
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
            version: state.installedVersion,
            scope: "user",
            enabled: true,
            mcpServers: {
              teami: { command: "npx", args: ["-y", `@shulmansj/teami@${state.installedPackageRef}`, "mcp"] },
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
        state.installedVersion = "0.3.20";
        state.installedPackageRef = "0.3.20";
        return ok("installed teami");
      case "plugin update teami@teami --scope user":
        assert.equal(state.marketplaceReady, true, "marketplace source must be refreshed before update");
        state.installed = true;
        state.installedVersion = "0.3.20";
        state.installedPackageRef = "0.3.20";
        return ok("updated teami");
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
