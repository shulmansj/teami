import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadLinearConfig } from "../src/config.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  readTeamRegistry,
  upsertTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";
import {
  createLinearCredentialStore,
  legacyCredentialTargetForConfig,
} from "../src/linear-credential-store.mjs";
import {
  createMockGitHubSetupTransport,
  githubConnectionStatePath,
} from "../src/github-setup.mjs";
import { createTeamiProjectMcpServer } from "../src/project-mcp-server.mjs";
import {
  TEAMI_PROJECT_MCP_TOOL_NAMES,
  createProjectMcpToolActions,
} from "../src/project-mcp-tools.mjs";
import {
  SETUP_DISCLOSURE_HASH,
  SETUP_DISCLOSURE_VERSION,
  createSetupStateStore,
} from "../src/setup-orchestrator.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const PACKAGED_PLUGIN_VERSION = JSON.parse(fs.readFileSync(
  path.join(repoRoot, ".claude-plugin", "plugin.json"),
  "utf8",
)).version;

test("init_onboarding bare MCP call returns setup needs without minting an auth URL", async (t) => {
  const home = tempHome(t, "teami-mcp-init-needs-");
  const server = await createTeamiProjectMcpServer({
    config: testConfig(),
    home,
    repoRoot,
  });
  const transports = linkedMcpTransports();
  await server.connect(transports.server);
  const client = new Client(
    { name: "teami-project-init-onboarding-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transports.client);

  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...TEAMI_PROJECT_MCP_TOOL_NAMES].sort(),
    );
    assert.equal(listed.tools.length, 5);
    const initTool = listed.tools.find((tool) => tool.name === "init_onboarding");
    assert.match(initTool.description, /full Teami setup/i);

    const result = await client.callTool({
      name: "init_onboarding",
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent;
    assert.equal(structured.ok, false);
    assert.equal(structured.status, "consent_required");
    assert.deepEqual(structured.needs.map((need) => need.field), ["confirm"]);
    assert.equal(structured.needs[0].required, true);
    assert.deepEqual(structured.defaults, {
      team: "Teami",
      product_repositories: "none",
    });
    assert.match(structured.next_steps.join("\n"), /product repositories stay disconnected/i);
    assert.equal(structured.disclosure.version, SETUP_DISCLOSURE_VERSION);
    assert.equal(structured.disclosure.hash, SETUP_DISCLOSURE_HASH);
    assert.equal(Object.hasOwn(structured, "authorization_url"), false);
    assert.match(result.content[0].text, /call init_onboarding/i);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});

test("init_onboarding mutates nothing before exact disclosure-bound consent", async (t) => {
  const harness = createProgrammaticHarness(t);
  const result = await harness.actions.init_onboarding({
    team: "Support Ops",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(result.status, "consent_required");
  assert.equal(readTeamRegistry({ home: harness.home }), null);
  assert.equal(fs.existsSync(path.join(harness.home, "setup")), false);
  assert.equal(harness.githubTransport.calls.length, 0);
  assert.deepEqual(harness.fakeClaude.calls, []);
});

test("init_onboarding rejects product-repository access before browser authorization", async (t) => {
  const harness = createProgrammaticHarness(t);
  const result = await startOnboarding(harness, {
    team: "Support Ops",
    repo_intent: { mode: "allowlist", repos: ["Acme/app"] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "product_repo_access_not_supported_during_setup");
  assert.match(result.repair, /separate explicit action/i);
  assert.equal(harness.authorize.calls.length, 0);
  assert.equal(readTeamRegistry({ home: harness.home }), null);
  assert.equal(harness.githubTransport.calls.length, 0);
});

test("fresh onboarding rejects an existing-team choice until Teami offers the live safe choices", async (t) => {
  const harness = createProgrammaticHarness(t, {
    existingTeams: [{ id: "team-existing", key: "EX", name: "Existing Team" }],
  });
  const result = await startOnboarding(harness, {
    team: "Teami",
    repo_intent: { mode: "non_code" },
    linear_team_id: "team-existing",
    linear_team_confirm: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "linear_team_selection_not_requested");
  assert.equal(harness.authorize.calls.length, 0);
  assert.equal(readTeamRegistry({ home: harness.home }), null);
  assert.equal(harness.client.projectLabels.length, 0);
});

test("team-limit recovery stays on the same setup and configures an existing team only after explicit choice", async (t) => {
  const harness = createProgrammaticHarness(t, {
    existingTeams: [
      { id: "team-agent-platform", key: "AP", name: "Agent Platform" },
      { id: "team-research", key: "RES", name: "Research" },
    ],
    teamCreateError: {
      errors: [{
        message: "You have reached the limit of teams allowed in your current plan.",
        path: ["teamCreate"],
      }],
    },
  });
  const awaiting = await startOnboarding(harness, {
    team: "Teami",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-team-limit",
  });
  assert.equal(awaiting.status, "awaiting_authorization");
  await new Promise((resolve) => setImmediate(resolve));

  const choice = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(choice.status, "team_selection_required");
  assert.equal(choice.setup_id, awaiting.setup_id);
  assert.deepEqual(choice.teams, [
    { id: "team-agent-platform", key: "AP", name: "Agent Platform" },
    { id: "team-research", key: "RES", name: "Research" },
  ]);
  assert.match(choice.effects.join("\n"), /labels and workflow statuses/i);
  assert.equal(harness.githubTransport.calls.length, 0);
  assert.equal(harness.fakeClaude.calls.length, 0);

  const polled = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(polled.status, "team_selection_required");
  assert.deepEqual(polled.teams, choice.teams);
  const invalid = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    linear_team_id: "team-not-offered",
    linear_team_confirm: true,
  });
  assert.equal(invalid.status, "team_selection_required");
  assert.equal(invalid.reason, "linear_team_selection_invalid");
  assert.equal(harness.client.projectLabels.length, 0);

  const result = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    linear_team_id: "team-agent-platform",
    linear_team_confirm: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(harness.authorize.calls.length, 1, "the saved ordinary Linear grant must be reused");
  const team = readTeamRegistry({ home: harness.home }).teams.find((candidate) => candidate.id === "teami");
  assert.equal(team.linear.team_id, "team-agent-platform");
  assert.equal(team.linear.provisioned_by_teami, false);
  const stateText = fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${awaiting.setup_id}.json`),
    "utf8",
  );
  assert.doesNotMatch(stateText, /access-test|refresh-test|oauth_code|pkce|code_verifier/i);
});

test("team-limit recovery rehydrates the saved Linear grant after a process restart", async (t) => {
  const teamCreateError = {
    errors: [{
      message: "You have reached the limit of teams allowed in your current plan.",
      path: ["teamCreate"],
    }],
  };
  const harness = createProgrammaticHarness(t, {
    existingTeams: [{ id: "team-existing", key: "EX", name: "Existing Team" }],
    teamCreateError,
  });
  const awaiting = await startOnboarding(harness, { team: "Teami", repo_intent: { mode: "non_code" } });
  await new Promise((resolve) => setImmediate(resolve));
  const choice = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(choice.status, "team_selection_required");

  let browserStarts = 0;
  const restartedActions = createProjectMcpToolActions({
    repoRoot: harness.home,
    home: harness.home,
    config: testConfig(),
    createLinearSetupAuth: createAuthorizingSetupAuthFactory(harness.client),
    startLinearBrowserAuthorization: async () => {
      browserStarts += 1;
      throw new Error("saved setup authorization should be reused before opening a browser");
    },
    githubSetupTransport: harness.githubTransport,
    runGit: createInMemoryRunGit(),
    claudePluginRunCommand: harness.fakeClaude.runCommand,
    ensurePhoenix: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    runPhoenixPreflight: async () => ({ ok: true, traceId: "trace-test" }),
    runRuntimeSmoke: async () => ({ ok: true, results: [{ ok: true }] }),
    runSetupDoctor: async () => [{ name: "fixture health", ok: true }],
    isSetupOwnerProcessAlive: () => false,
  });
  const restarted = await startOnboarding({ actions: restartedActions }, {
    team: "Teami",
    repo_intent: { mode: "non_code" },
  });

  assert.equal(restarted.status, "team_selection_required", JSON.stringify(restarted));
  assert.notEqual(restarted.setup_id, awaiting.setup_id);
  assert.equal(browserStarts, 0);
  assert.deepEqual(restarted.teams, [{ id: "team-existing", key: "EX", name: "Existing Team" }]);
});

test("interrupted admin authorization cannot be cleared by revoking a fresh token", async (t) => {
  const harness = createProgrammaticHarness(t, {
    authorizeOneShotAdmin: async () => ({
      adminClient: {},
      teardown: async () => ({ revokeVerified: true }),
    }),
  });
  const store = createSetupStateStore({ home: harness.home });
  const started = store.start({
    input: { team: "Interrupted Admin", repo_intent: { mode: "non_code" } },
    consent: {
      confirmed: true,
      version: SETUP_DISCLOSURE_VERSION,
      hash: SETUP_DISCLOSURE_HASH,
    },
  });
  store.markAdminRevocationRequired(started.setup_id);
  store.markGlobalAdminRevocationRequired({ surface: "mcp" });

  const blocked = await harness.actions.init_onboarding({ setup_id: started.setup_id });
  assert.equal(blocked.reason, "admin_authorization_process_restarted");
  assert.match(blocked.repair, /Settings -> Applications/i);

  const cleanup = await harness.actions.init_onboarding({
    setup_id: started.setup_id,
    repair_admin_revocation: true,
  });
  assert.equal(cleanup.status, "blocked");
  assert.equal(cleanup.reason, "prior_admin_revocation_not_verifiable");
  assert.match(cleanup.repair, /fresh token cannot prove the lost token/i);
  assert.notEqual(store.readAdminRevocationRequirement(), null);
  assert.equal(store.read(started.setup_id).admin_revocation_confirmation, undefined);
});

test("conversational setup refuses to race the shared CLI setup writer", async (t) => {
  const harness = createProgrammaticHarness(t);
  const store = createSetupStateStore({ home: harness.home });
  const cliLock = store.acquire({ purpose: "cli-setup-test" });
  assert.equal(cliLock.ok, true);
  try {
    const result = await startOnboarding(harness, {
      team: "Concurrent Setup",
      repo_intent: { mode: "non_code" },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "setup_lock_held");
    assert.equal(fs.existsSync(path.join(harness.home, "setup", "sessions")), false);
  } finally {
    cliLock.release();
  }
});

test("a pending conversational setup reserves setup ownership until it is resumed", async (t) => {
  const harness = createProgrammaticHarness(t);
  const first = await startOnboarding(harness, {
    team: "First Pending",
    repo_intent: { mode: "non_code" },
  });
  const second = await startOnboarding(harness, {
    team: "Second Pending",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(second.status, "blocked");
  assert.equal(second.reason, "setup_session_active");
  assert.equal(second.setup_id, first.setup_id);
  assert.match(second.repair, /Resume the active setup/i);
});

test("callback-listener start failure is typed and does not strand the next setup", async (t) => {
  const authorize = createSuccessfulAuthorize();
  const healthyStarter = createFakeAuthorizationSessionStarter(authorize);
  let starts = 0;
  const harness = createProgrammaticHarness(t, {
    startLinearBrowserAuthorization: async (options) => {
      starts += 1;
      if (starts === 1) throw new Error("Every local callback port is already in use");
      return healthyStarter(options);
    },
  });

  const failed = await startOnboarding(harness, {
    team: "Listener Recovery",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.reason, "linear_authorization_start_failed");
  assert.match(failed.repair, /callback ports/i);
  const store = createSetupStateStore({ home: harness.home });
  assert.equal(store.findActive(), null);
  assert.equal(store.read(failed.setup_id).phases.linear.status, "blocked");

  const retry = await startOnboarding(harness, {
    team: "Listener Recovery",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(retry.status, "awaiting_authorization");
  assert.notEqual(retry.setup_id, failed.setup_id);
  assert.equal(starts, 2);
});

test("init_onboarding returns the live URL over stdio while the OAuth callback is still pending", async (t) => {
  const home = tempHome(t, "teami-mcp-init-stdio-");
  const serverModule = pathToFileURL(path.join(repoRoot, "execution/integrations/linear/src/project-mcp-server.mjs")).href;
  const childScript = `
    import { runTeamiProjectMcpStdioServer } from ${JSON.stringify(serverModule)};
    await runTeamiProjectMcpStdioServer({
      repoRoot: ${JSON.stringify(repoRoot)},
      home: ${JSON.stringify(home)},
      startLinearBrowserAuthorization: async () => ({
        authorizationUrl: "https://linear.test/oauth/authorize?stdio=pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
        browser: { opened: true, reason: null },
        waitForToken: () => new Promise(() => {}),
        close: async () => true,
      }),
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", childScript],
    cwd: repoRoot,
    env: { TEAMI_HOME: home },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "teami-project-stdio-timing-test", version: "0.0.0" },
    { capabilities: {} },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);
  try {
    const startedAt = Date.now();
    const result = await Promise.race([
      client.callTool({
        name: "init_onboarding",
        arguments: {
          team: "Stdio Pending",
          repo_intent: { mode: "non_code" },
          confirm: true,
          disclosure_version: SETUP_DISCLOSURE_VERSION,
          disclosure_hash: SETUP_DISCLOSURE_HASH,
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`stdio init_onboarding did not return before OAuth callback; stderr=${stderr}`)), 2_000)),
    ]);
    assert.equal(result.structuredContent.status, "awaiting_authorization");
    assert.equal(result.structuredContent.authorization_url, "https://linear.test/oauth/authorize?stdio=pending");
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    await client.close();
  }
});

test("admin authorization returns its live URL over stdio while the elevated callback is pending", async (t) => {
  const home = tempHome(t, "teami-mcp-admin-stdio-");
  const serverModule = pathToFileURL(path.join(repoRoot, "execution/integrations/linear/src/project-mcp-server.mjs")).href;
  const toolsModule = pathToFileURL(path.join(repoRoot, "execution/integrations/linear/src/project-mcp-tools.mjs")).href;
  const childScript = `
    import { runTeamiProjectMcpStdioServer } from ${JSON.stringify(serverModule)};
    import { ProjectMcpToolError } from ${JSON.stringify(toolsModule)};
    await runTeamiProjectMcpStdioServer({
      repoRoot: ${JSON.stringify(repoRoot)},
      home: ${JSON.stringify(home)},
      startLinearBrowserAuthorization: async () => ({
        authorizationUrl: "https://linear.test/oauth/authorize?app=ready",
        expiresAt: "2099-01-01T00:00:00.000Z",
        browser: { opened: true, reason: null },
        waitForToken: async () => ({ accessToken: "memory-only-app" }),
        close: async () => true,
      }),
      startOneShotAdminAuthorization: async () => ({
        authorizationUrl: "https://linear.test/oauth/authorize?admin=stdio-pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
        browser: { opened: true, reason: null },
        waitForGrant: () => new Promise(() => {}),
        close: async () => true,
      }),
      runInitOnboardingSetupImpl: async ({ adminConfirm }) => {
        if (!adminConfirm) {
          throw new ProjectMcpToolError("admin_consent_required", "fixture requires one-shot admin consent");
        }
        throw new Error("admin setup fixture must not run before callback");
      },
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", childScript],
    cwd: repoRoot,
    env: { TEAMI_HOME: home },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "teami-project-admin-stdio-timing-test", version: "0.0.0" },
    { capabilities: {} },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);
  try {
    const started = await client.callTool({
      name: "init_onboarding",
      arguments: {
        team: "Admin Stdio",
        repo_intent: { mode: "non_code" },
        confirm: true,
        disclosure_version: SETUP_DISCLOSURE_VERSION,
        disclosure_hash: SETUP_DISCLOSURE_HASH,
      },
    });
    let consentNeeded = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      consentNeeded = await client.callTool({
        name: "init_onboarding",
        arguments: { setup_id: started.structuredContent.setup_id },
      });
      if (consentNeeded.structuredContent.status === "admin_consent_required") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(consentNeeded.structuredContent.status, "admin_consent_required");
    const adminAwaiting = await Promise.race([
      client.callTool({
        name: "init_onboarding",
        arguments: { setup_id: started.structuredContent.setup_id, admin_confirm: true },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`stdio admin URL waited for callback; stderr=${stderr}`)), 2_000)),
    ]);
    assert.equal(adminAwaiting.structuredContent.status, "awaiting_authorization");
    assert.equal(adminAwaiting.structuredContent.authorization.kind, "linear_admin");
    assert.equal(
      adminAwaiting.structuredContent.authorization_url,
      "https://linear.test/oauth/authorize?admin=stdio-pending",
    );
  } finally {
    await client.close();
  }
});

test("init_onboarding keeps manual recovery live when automatic browser launch fails", async (t) => {
  const harness = createProgrammaticHarness(t, {
    authorizationBrowser: { opened: false, reason: "browser fixture failed" },
  });
  const awaiting = await startOnboarding(harness, {
    team: "Manual Browser",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(awaiting.status, "awaiting_authorization");
  assert.equal(awaiting.authorization_url, harness.authorize.url);
  assert.equal(awaiting.authorization.browser_opened, false);
  assert.equal(awaiting.authorization.browser_error, "browser fixture failed");
  assert.match(awaiting.recovery.browser_not_opened, /manually/i);
});

test("init_onboarding reports a process restart without pretending the old callback listener survived", async (t) => {
  const harness = createProgrammaticHarness(t);
  const awaiting = await startOnboarding(harness, {
    team: "Restarted Setup",
    repo_intent: { mode: "non_code" },
  });
  const restartedActions = createProjectMcpToolActions({
    repoRoot: harness.home,
    home: harness.home,
    config: testConfig(),
  });
  const result = await restartedActions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "authorization_process_restarted");
  assert.match(result.repair, /fresh URL/i);
  assert.match(result.repair, /no OAuth secret was persisted/i);
});

test("a fresh start after process restart retires the orphaned callback and issues a new URL", async (t) => {
  const harness = createProgrammaticHarness(t);
  const orphaned = await startOnboarding(harness, {
    team: "Orphaned Setup",
    repo_intent: { mode: "non_code" },
  });
  const restartedActions = createProjectMcpToolActions({
    repoRoot: harness.home,
    home: harness.home,
    config: testConfig(),
    startLinearBrowserAuthorization: createFakeAuthorizationSessionStarter(harness.authorize),
    isSetupOwnerProcessAlive: () => false,
  });
  const fresh = await restartedActions.init_onboarding({
    team: "Fresh Setup",
    repo_intent: { mode: "non_code" },
    confirm: true,
    disclosure_version: SETUP_DISCLOSURE_VERSION,
    disclosure_hash: SETUP_DISCLOSURE_HASH,
  });
  assert.equal(fresh.status, "awaiting_authorization");
  assert.notEqual(fresh.setup_id, orphaned.setup_id);
  const store = createSetupStateStore({ home: harness.home });
  assert.equal(store.read(orphaned.setup_id).status, "blocked");
  assert.equal(store.read(orphaned.setup_id).phases.linear.reason, "authorization_process_restarted");
});

test("init_onboarding asks just in time before admin OAuth and leaves a durable block when revocation is unverified", async (t) => {
  const adminCalls = [];
  let harness;
  const statuses = [
    { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "status-planned", name: "Planned", type: "planned", position: 20 },
    { id: "status-started", name: "In Progress", type: "started", position: 30 },
    { id: "status-completed", name: "Completed", type: "completed", position: 40 },
  ];
  harness = createProgrammaticHarness(t, {
    statuses,
    authorizeOneShotAdmin: async () => {
      adminCalls.push("authorized");
      return {
        adminClient: harness.client,
        teardown: async () => { adminCalls.push("teardown_attempted"); },
      };
    },
  });
  const awaiting = await startOnboarding(harness, {
    team: "Admin Boundary",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-admin-boundary",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const consentNeeded = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(consentNeeded.status, "admin_consent_required");
  assert.deepEqual(adminCalls, [], "admin OAuth must not start before just-in-time confirmation");

  const blocked = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    admin_confirm: true,
  });
  assert.equal(blocked.status, "awaiting_authorization");
  assert.equal(blocked.authorization.kind, "linear_admin");
  assert.match(blocked.authorization_url, /admin=true/);
  await new Promise((resolve) => setImmediate(resolve));
  const afterAdmin = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(afterAdmin.status, "blocked");
  assert.equal(afterAdmin.reason, "admin_revocation_required");
  assert.deepEqual(adminCalls, ["authorized", "teardown_attempted"]);

  const stateText = fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${awaiting.setup_id}.json`),
    "utf8",
  );
  const state = JSON.parse(stateText);
  assert.equal(state.admin_revocation_required.status, "required");
  assert.equal(state.admin_revocation_required.reason, "one_shot_admin_oauth_started");
  assert.doesNotMatch(stateText, /access[_-]?token|refresh[_-]?token|refresh-test|access-test/i);
  assert.equal(
    createSetupStateStore({ home: harness.home }).readGlobalAdminRevocationRequired().surface,
    "mcp",
  );
});

test("init_onboarding clears the admin marker only when remote revocation is verified", async (t) => {
  let harness;
  const statuses = [
    { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "status-planned", name: "Planned", type: "planned", position: 20 },
    { id: "status-started", name: "In Progress", type: "started", position: 30 },
    { id: "status-completed", name: "Completed", type: "completed", position: 40 },
  ];
  harness = createProgrammaticHarness(t, {
    statuses,
    authorizeOneShotAdmin: async () => ({
      adminClient: harness.client,
      teardown: async () => ({ revokeVerified: true }),
    }),
  });
  const awaiting = await startOnboarding(harness, {
    team: "Verified Admin",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-verified-admin",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const consentNeeded = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(consentNeeded.status, "admin_consent_required");
  const adminAwaiting = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    admin_confirm: true,
  });
  assert.equal(adminAwaiting.status, "awaiting_authorization");
  assert.equal(adminAwaiting.authorization.kind, "linear_admin");
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(completed.status, "complete");
  const state = JSON.parse(fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${awaiting.setup_id}.json`),
    "utf8",
  ));
  assert.equal(state.admin_revocation_required, null);
  assert.equal(createSetupStateStore({ home: harness.home }).readGlobalAdminRevocationRequired(), null);
});

test("admin authorization returns its live URL before the callback and preserves manual browser recovery", async (t) => {
  const pendingGrant = deferredPromise();
  let harness;
  harness = createProgrammaticHarness(t, {
    statuses: projectStatusesWithoutAdminException(),
    startOneShotAdminAuthorization: async () => ({
      authorizationUrl: "https://linear.test/oauth/authorize?admin=pending",
      expiresAt: "2099-01-01T00:00:00.000Z",
      browser: { opened: false, reason: "admin browser fixture failed" },
      waitForGrant: () => pendingGrant.promise,
      close: async () => true,
    }),
  });
  const appAwaiting = await startOnboarding(harness, {
    team: "Pending Admin",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-pending-admin",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const consentNeeded = await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  assert.equal(consentNeeded.status, "admin_consent_required");

  const adminAwaiting = await Promise.race([
    harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id, admin_confirm: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("admin URL waited for callback")), 500)),
  ]);
  assert.equal(adminAwaiting.status, "awaiting_authorization");
  assert.equal(adminAwaiting.authorization.kind, "linear_admin");
  assert.equal(adminAwaiting.authorization_url, "https://linear.test/oauth/authorize?admin=pending");
  assert.equal(adminAwaiting.authorization.browser_opened, false);
  assert.equal(adminAwaiting.authorization.browser_error, "admin browser fixture failed");
  assert.match(adminAwaiting.recovery.browser_not_opened, /manually/i);

  const stateText = fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${appAwaiting.setup_id}.json`),
    "utf8",
  );
  assert.doesNotMatch(stateText, /access[_-]?token|refresh[_-]?token|oauth_code|pkce|code_verifier/i);

  pendingGrant.resolve({
    adminClient: harness.client,
    teardown: async () => ({ revokeVerified: true }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  assert.equal(completed.status, "complete");
});

test("admin authorization process restart is typed and persists no elevated credential", async (t) => {
  const pendingGrant = deferredPromise();
  const harness = createProgrammaticHarness(t, {
    statuses: projectStatusesWithoutAdminException(),
    startOneShotAdminAuthorization: async () => ({
      authorizationUrl: "https://linear.test/oauth/authorize?admin=restart",
      expiresAt: "2099-01-01T00:00:00.000Z",
      browser: { opened: true, reason: null },
      waitForGrant: () => pendingGrant.promise,
      close: async () => true,
    }),
  });
  const appAwaiting = await startOnboarding(harness, {
    team: "Restart Admin",
    repo_intent: { mode: "non_code" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  const adminAwaiting = await harness.actions.init_onboarding({
    setup_id: appAwaiting.setup_id,
    admin_confirm: true,
  });
  assert.equal(adminAwaiting.authorization.kind, "linear_admin");

  const restarted = createProjectMcpToolActions({
    repoRoot: harness.home,
    home: harness.home,
    config: testConfig(),
  });
  const blocked = await restarted.init_onboarding({ setup_id: appAwaiting.setup_id });
  assert.equal(blocked.reason, "admin_authorization_process_restarted");
  assert.match(blocked.repair, /no admin token, OAuth code, or PKCE material was persisted/i);
});

test("expired admin authorization is typed and requires revocation review", async (t) => {
  const harness = createProgrammaticHarness(t, {
    statuses: projectStatusesWithoutAdminException(),
    startOneShotAdminAuthorization: async () => {
      const grantPromise = Promise.reject(new Error("Timed out waiting for Linear OAuth authorization callback."));
      grantPromise.catch(() => {});
      return {
        authorizationUrl: "https://linear.test/oauth/authorize?admin=expired",
        expiresAt: "2026-07-11T13:01:00.000Z",
        browser: { opened: true, reason: null },
        waitForGrant: () => grantPromise,
        close: async () => true,
      };
    },
  });
  const appAwaiting = await startOnboarding(harness, {
    team: "Expired Admin",
    repo_intent: { mode: "non_code" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  const adminAwaiting = await harness.actions.init_onboarding({
    setup_id: appAwaiting.setup_id,
    admin_confirm: true,
  });
  assert.equal(adminAwaiting.status, "awaiting_authorization");
  await new Promise((resolve) => setImmediate(resolve));
  const blocked = await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  assert.equal(blocked.reason, "linear_admin_authorization_expired");
  assert.match(blocked.repair, /revoke Teami admin access/i);
});

test("unused in-memory admin grant is automatically revoked within a bounded window", async (t) => {
  let harness;
  harness = createProgrammaticHarness(t, {
    statuses: projectStatusesWithoutAdminException(),
    adminGrantUseWindowMs: 5,
    authorizeOneShotAdmin: async () => ({
      adminClient: harness.client,
      teardown: async () => ({ revokeVerified: true }),
    }),
  });
  const appAwaiting = await startOnboarding(harness, {
    team: "Bounded Admin",
    repo_intent: { mode: "non_code" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  const adminAwaiting = await harness.actions.init_onboarding({
    setup_id: appAwaiting.setup_id,
    admin_confirm: true,
  });
  assert.equal(adminAwaiting.status, "awaiting_authorization");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const blocked = await harness.actions.init_onboarding({ setup_id: appAwaiting.setup_id });
  assert.equal(blocked.reason, "linear_admin_grant_use_window_expired");
  assert.match(blocked.repair, /automatically revoked/i);
  assert.equal(createSetupStateStore({ home: harness.home }).readGlobalAdminRevocationRequired(), null);
});

test("init_onboarding returns awaiting authorization before completing full setup on resume", async (t) => {
  const setupProgress = [];
  const harness = createProgrammaticHarness(t, {
    onSetupProgress: (event) => setupProgress.push(event),
  });

  const { awaiting, result } = await startAndResume(harness, {
    team: "Support Ops",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-behavior",
  });

  assert.equal(awaiting.ok, false);
  assert.equal(awaiting.status, "awaiting_authorization");
  assert.equal(awaiting.authorization_url, harness.authorize.url);
  assert.equal(result.ok, true);
  assert.equal(result.status, "complete");
  assert.deepEqual(setupProgress, [{
    phase: "post_authorization",
    message: "Authorization approved; finishing setup",
  }]);
  assert.deepEqual(result.steps.linear, {
    ok: true,
    team: { id: "support-ops", status: "active" },
    workspace: { id: "workspace-1", name: "Example Workspace" },
    team: { id: "team-1", key: "SO", name: "Support Ops" },
    repos: [],
  });
  assert.equal(result.steps.github.ok, true);
  assert.equal(result.steps.github.mode, "real");
  assert.equal(result.steps.github.connected, true);
  assert.equal(result.steps.github.created, true);
  assert.equal(result.steps.github.repo.full_name, "Acme/teami-behavior");
  assert.equal(result.steps.github.repo.url, "mock://github/Acme/teami-behavior");
  assert.equal(result.steps.plugin.status, "installed");
  assert.equal(result.steps.plugin.installed, true);
  assert.equal(result.steps.plugin.already_installed, false);
  assert.match(result.next_steps.join("\n"), /gateway start/);

  const registry = readTeamRegistry({ home: harness.home });
  const team = registry.teams.find((candidate) => candidate.id === "support-ops");
  assert.equal(team.status, "active");
  assert.deepEqual(team.resources, []);

  const cache = JSON.parse(
    fs.readFileSync(path.resolve(harness.home, team.linear.cache_path), "utf8"),
  );
  assert.equal(cache.teamRef, "support-ops");
  assert.equal(cache.workspaceId, "workspace-1");
  assert.equal(cache.teamId, "team-1");

  const credentialPath = path.join(
    harness.home,
    "credentials",
    "teams",
    "support-ops",
    "linear-oauth-token.json",
  );
  assert.match(fs.readFileSync(credentialPath, "utf8"), /refresh-test/);
  assert.deepEqual(harness.authorize.calls.map((call) => call.prompt), [null]);
  assert.deepEqual(
    harness.githubTransport.calls.map((call) => call.endpointId),
    ["get_repository", "create_repository", "push_initial_branch", "verify_default_branch"],
  );
  assert.deepEqual(
    harness.fakeClaude.calls.map((call) => call.args.slice(0, 3)),
    [
      ["plugin", "marketplace", "list"],
      ["plugin", "marketplace", "list"],
      ["plugin", "marketplace", "add"],
      ["plugin", "marketplace", "list"],
      ["plugin", "install", "teami@teami"],
      ["plugin", "marketplace", "list"],
      ["plugin", "list", "--json"],
    ],
  );
  const setupState = JSON.parse(fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${awaiting.setup_id}.json`),
    "utf8",
  ));
  assert.equal(setupState.status, "complete");
  assert.deepEqual(
    Object.fromEntries(Object.entries(setupState.phases).map(([phase, receipt]) => [phase, receipt.status])),
    {
      consent: "healthy",
      linear: "healthy",
      product_repos: "healthy",
      github: "healthy",
      plugin: "healthy",
      phoenix: "healthy",
      runtime: "healthy",
      doctor: "healthy",
    },
  );
});

test("init_onboarding treats an already-installed Claude plugin as a successful no-op", async (t) => {
  const harness = createProgrammaticHarness(t, {
    pluginAlreadyInstalled: true,
  });

  const { result } = await startAndResume(harness, {
    team: "Customer Ops",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-customer",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "complete");
  assert.equal(result.steps.plugin.ok, true);
  assert.equal(result.steps.plugin.status, "already_installed");
  assert.equal(result.steps.plugin.installed, false);
  assert.equal(result.steps.plugin.already_installed, true);
  assert.equal(result.steps.plugin.version, PACKAGED_PLUGIN_VERSION);
  assert.deepEqual(
    harness.fakeClaude.calls.map((call) => call.args),
    [
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "list", "--json"],
    ],
  );
});

test("init_onboarding reuses the exact plugin proof instead of repeating a flaky Claude read", async (t) => {
  let doctorOptions = null;
  const harness = createProgrammaticHarness(t, {
    runSetupDoctor: async (options) => {
      doctorOptions = options;
      return options.includeClaudePlugin === false
        ? [{ name: "fixture health", ok: true }]
        : [{
            name: "Claude plugin launch contract",
            ok: false,
            message: "claude_plugin_marketplace_list_failed",
          }];
    },
  });

  const { result } = await startAndResume(harness, {
    team: "Plugin Proof",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-plugin-proof",
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(doctorOptions.includeClaudePlugin, false);
  assert.equal(result.steps.plugin.version, PACKAGED_PLUGIN_VERSION);
  assert.deepEqual(
    result.steps.doctor.checks.find((check) => check.name === "Claude plugin launch contract"),
    {
      name: "Claude plugin launch contract",
      state: "ok",
      message: `verified during this setup run at ${PACKAGED_PLUGIN_VERSION}`,
    },
  );
});

test("init_onboarding keeps the final Claude doctor check when plugin proof has no concrete version", async (t) => {
  let doctorOptions = null;
  const harness = createProgrammaticHarness(t, {
    runClaudePluginRegistration: async () => ({
      ok: true,
      status: "already_installed",
      pluginName: "teami",
    }),
    runSetupDoctor: async (options) => {
      doctorOptions = options;
      return [{ name: "fixture health", ok: options.includeClaudePlugin === true }];
    },
  });

  const { result } = await startAndResume(harness, {
    team: "Unproven Plugin",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-unproven-plugin",
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(doctorOptions.includeClaudePlugin, true);
  assert.equal(Object.hasOwn(result.steps.plugin, "version"), false);
  assert.equal(
    result.steps.doctor.checks.some((check) => check.name === "Claude plugin launch contract"),
    false,
  );
});

test("revoked complete-team authorization starts a fresh resumable browser session", async (t) => {
  const credentialControl = { revoked: false };
  const authorize = createSuccessfulAuthorize("https://linear.test/oauth/authorize?fresh=1");
  const harness = createProgrammaticHarness(t, { authorize, credentialControl });
  const { result: first } = await startAndResume(harness, {
    team: "Revoked Grant",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-revoked-grant",
  });
  assert.equal(first.status, "complete", JSON.stringify(first));

  credentialControl.revoked = true;
  const retry = await startOnboarding(harness, {
    team: "Revoked Grant",
    repo_intent: { mode: "non_code" },
  });
  assert.equal(retry.status, "awaiting_authorization", JSON.stringify(retry));
  assert.equal(retry.authorization_url, authorize.url);
  assert.match(retry.recovery.resume, /setup_id/i);
});

test("failed credential validation preserves a concurrently refreshed Team grant", async (t) => {
  const credentialControl = { revoked: false, replaceBeforeDelete: false };
  const createCredentialStore = (options) => {
    const store = createLinearCredentialStore(options);
    return {
      ...store,
      async deleteTokenSetIfEqual(expected) {
        if (credentialControl.replaceBeforeDelete) {
          credentialControl.replaceBeforeDelete = false;
          await store.writeTokenSet({
            accessToken: "access-refreshed-concurrently",
            refreshToken: "refresh-refreshed-concurrently",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }
        return store.deleteTokenSetIfEqual(expected);
      },
    };
  };
  const harness = createProgrammaticHarness(t, { credentialControl, createCredentialStore });
  const { result: first } = await startAndResume(harness, {
    team: "Concurrent Refresh",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-concurrent-refresh",
  });
  assert.equal(first.status, "complete", JSON.stringify(first));

  credentialControl.revoked = true;
  credentialControl.replaceBeforeDelete = true;
  const retry = await startOnboarding(harness, {
    team: "Concurrent Refresh",
    repo_intent: { mode: "non_code" },
  });

  assert.equal(retry.status, "blocked");
  assert.equal(retry.reason, "linear_authorization_changed_during_validation");
  assert.equal(harness.authorize.calls.length, 1, "a credential race must not open a replacement OAuth session");
  const preserved = await createLinearCredentialStore({
    config: testConfig(),
    home: harness.home,
    repoRoot: harness.home,
    teamRef: "concurrent-refresh",
    workspaceId: "workspace-1",
  }).readTokenSet();
  assert.equal(preserved.refreshToken, "refresh-refreshed-concurrently");
});

test("setup_incomplete retry uses the canonical Team credential and cleans only the observed bootstrap", async (t) => {
  const harness = createProgrammaticHarness(t, {
    existingTeams: [{ id: "team-retry", key: "RTY", name: "Credential Retry" }],
  });
  const config = testConfig();
  writeTeamRegistry(
    { home: harness.home },
    upsertTeamRecord(
      emptyTeamRegistry(),
      makeTeamRecord({
        teamRef: "credential-retry",
        status: "setup_incomplete",
        adopterProvidedName: "Credential Retry",
        workspaceId: "workspace-1",
        workspaceName: "Example Workspace",
        teamId: "team-retry",
        teamKey: "RTY",
        teamName: "Credential Retry",
      }),
    ),
  );
  const canonicalStore = createLinearCredentialStore({
    config,
    home: harness.home,
    repoRoot: harness.home,
    teamRef: "credential-retry",
    workspaceId: "workspace-1",
  });
  const bootstrapStore = createLinearCredentialStore({
    config,
    home: harness.home,
    repoRoot: harness.home,
    target: legacyCredentialTargetForConfig(config),
  });
  await canonicalStore.writeTokenSet({ refreshToken: "refresh-canonical" });
  await bootstrapStore.writeTokenSet({ refreshToken: "refresh-obsolete-bootstrap" });

  const result = await startOnboarding(harness, {
    team: "credential-retry",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-credential-retry",
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(harness.authorize.calls.length, 0, "retry must not reopen OAuth when the Team grant is valid");
  assert.equal(readTeamRegistry({ home: harness.home }).teams[0].status, "active");
  assert.equal((await canonicalStore.readTokenSet()).refreshToken, "refresh-canonical");
  assert.equal(await bootstrapStore.readTokenSet(), null);
});

test("setup retry preserves a bootstrap authorization replaced during cleanup", async (t) => {
  let replaceBeforeCleanup = false;
  const createBootstrapCredentialStore = ({ config, repoRoot, home }) => {
    const store = createLinearCredentialStore({
      config,
      repoRoot,
      home,
      target: legacyCredentialTargetForConfig(config),
    });
    return {
      ...store,
      async deleteTokenSetIfEqual(expected) {
        if (replaceBeforeCleanup) {
          replaceBeforeCleanup = false;
          await store.writeTokenSet({ refreshToken: "refresh-new-bootstrap-authorization" });
        }
        return store.deleteTokenSetIfEqual(expected);
      },
    };
  };
  const harness = createProgrammaticHarness(t, {
    existingTeams: [{ id: "team-bootstrap-race", key: "BRA", name: "Bootstrap Race" }],
    createBootstrapCredentialStore,
  });
  const config = testConfig();
  writeTeamRegistry(
    { home: harness.home },
    upsertTeamRecord(
      emptyTeamRegistry(),
      makeTeamRecord({
        teamRef: "bootstrap-race",
        status: "setup_incomplete",
        workspaceId: "workspace-1",
        workspaceName: "Example Workspace",
        teamId: "team-bootstrap-race",
        teamKey: "BRA",
        teamName: "Bootstrap Race",
      }),
    ),
  );
  await createLinearCredentialStore({
    config,
    home: harness.home,
    repoRoot: harness.home,
    teamRef: "bootstrap-race",
    workspaceId: "workspace-1",
  }).writeTokenSet({ refreshToken: "refresh-canonical" });
  const bootstrapStore = createLinearCredentialStore({
    config,
    home: harness.home,
    repoRoot: harness.home,
    target: legacyCredentialTargetForConfig(config),
  });
  await bootstrapStore.writeTokenSet({ refreshToken: "refresh-observed-bootstrap" });
  replaceBeforeCleanup = true;

  const result = await startOnboarding(harness, {
    team: "bootstrap-race",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-bootstrap-race",
  });

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal((await bootstrapStore.readTokenSet()).refreshToken, "refresh-new-bootstrap-authorization");
});

test("replaying a completed setup id is idempotent and preserves terminal state", async (t) => {
  const harness = createProgrammaticHarness(t);
  const { result: completed } = await startAndResume(harness, {
    team: "Completed Replay",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-completed-replay",
  });
  assert.equal(completed.status, "complete", JSON.stringify(completed));

  const replay = await harness.actions.init_onboarding({ setup_id: completed.setup_id });

  assert.equal(replay.ok, true);
  assert.equal(replay.status, "complete");
  assert.equal(replay.setup_id, completed.setup_id);
  assert.equal(createSetupStateStore({ home: harness.home }).read(completed.setup_id).status, "complete");
});

test("init_onboarding auth failure is typed and persists no credential or team mutation", async (t) => {
  const authorizationError = new Error("Timed out waiting for Linear OAuth authorization callback.");
  const harness = createProgrammaticHarness(t, {
    authorize: createRejectingAuthorize(authorizationError),
  });

  const awaiting = await startOnboarding(harness, {
    team: "Support Ops",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-behavior",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const structured = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });

  assert.equal(structured.ok, false);
  assert.equal(structured.status, "blocked");
  assert.equal(structured.reason, "linear_authorization_expired");
  assert.match(structured.repair, /fresh authorization URL/);
  assert.equal(readTeamRegistry({ home: harness.home }), null);
  assert.equal(fs.existsSync(path.join(harness.home, "credentials")), false, "no OAuth token is persisted");
  assert.equal(harness.githubTransport.calls.length, 0);
  assert.deepEqual(harness.fakeClaude.calls, []);
});

test("init_onboarding gives installed-app recovery instead of dead air", async (t) => {
  const harness = createProgrammaticHarness(t, {
    authorize: createRejectingAuthorize(new Error("Teami is already installed but Linear did not redirect to the callback.")),
  });
  const awaiting = await startOnboarding(harness, {
    team: "Installed App",
    repo_intent: { mode: "non_code" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const blocked = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "linear_app_already_installed_no_callback");
  assert.match(blocked.repair, /Settings -> Applications/i);
  assert.match(blocked.repair, /fresh URL/i);
});

test("init_onboarding wrong-workspace recovery is typed, mutation-free, and requires a fresh URL", async (t) => {
  const harness = createProgrammaticHarness(t);
  const awaiting = await startOnboarding(harness, {
    team: "Wrong Workspace",
    workspace: "A Different Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-wrong-workspace",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const blocked = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "workspace_mismatch");
  assert.equal(blocked.error.code, "workspace_mismatch");
  assert.match(blocked.error.repair, /fresh Linear authorization URL/i);
  assert.equal(readTeamRegistry({ home: harness.home }), null);
  assert.equal(fs.existsSync(path.join(harness.home, "credentials")), false);
  assert.equal(harness.githubTransport.calls.length, 0);
  assert.deepEqual(harness.fakeClaude.calls, []);

  const staleResume = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(staleResume.reason, "authorization_process_restarted");
  assert.match(staleResume.repair, /fresh URL/i);
});

test("init_onboarding resumes a repaired post-Linear phase without retaining the OAuth session", async (t) => {
  const harness = createProgrammaticHarness(t, { pluginFails: true });
  const { awaiting, result: pluginBlocked } = await startAndResume(harness, {
    team: "Resume Plugin",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-resume-plugin",
  });
  assert.equal(pluginBlocked.status, "blocked");
  assert.equal(pluginBlocked.steps.plugin.ok, false);

  harness.fakeClaude.setInstallFails(false);
  const resumed = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(resumed.status, "complete", JSON.stringify(resumed));
  assert.equal(resumed.ok, true);
  assert.equal(harness.authorize.calls.length, 1, "repair resume must use the promoted ordinary credential, not reopen OAuth");
});

test("init_onboarding preserves durable Linear progress across a recoverable GitHub auth failure", async (t) => {
  const githubTransport = {
    ...createMockGitHubSetupTransport({
      failures: {
        get_repository: { times: 1, error: new Error("gh auth fixture expired") },
      },
    }),
    kind: "real",
  };
  const harness = createProgrammaticHarness(t, { githubSetupTransport: githubTransport });
  const { awaiting, result: githubBlocked } = await startAndResume(harness, {
    team: "Resume GitHub",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-resume-github",
  });
  assert.equal(githubBlocked.status, "blocked");
  assert.match(githubBlocked.error.repair, /(?:GitHub|gh) auth/i);
  const stateAfterFailure = JSON.parse(fs.readFileSync(
    path.join(harness.home, "setup", "sessions", `${awaiting.setup_id}.json`),
    "utf8",
  ));
  assert.equal(stateAfterFailure.phases.linear.status, "healthy");
  assert.equal(stateAfterFailure.phases.github.status, "blocked");

  const resumed = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(resumed.status, "complete", JSON.stringify(resumed));
  assert.equal(resumed.ok, true);
  assert.equal(harness.authorize.calls.length, 1, "GitHub repair resume must not reopen Linear OAuth");
});

test("implicit repair blocks a changed GitHub identity until exact replacement coordinates are approved", async (t) => {
  const baseTransport = createMockGitHubSetupTransport();
  let sameNameWasReplaced = false;
  const githubTransport = {
    kind: "real",
    calls: baseTransport.calls,
    request: async (request) => {
      if (sameNameWasReplaced && request.endpointId === "get_repository" &&
          request.owner === "Acme" && request.repo === "teami-identity") {
        return {
          exists: true,
          repo: {
            id: "replacement-repo-99",
            owner: "Acme",
            name: "teami-identity",
            full_name: "Acme/teami-identity",
            visibility: "private",
            private: true,
            default_branch: "main",
            empty: false,
          },
        };
      }
      return baseTransport.request(request);
    },
  };
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: githubTransport,
    pluginFails: true,
    runGit: createCheckoutlessRunGit(),
  });
  const { awaiting, result: blocked } = await startAndResume(harness, {
    team: "GitHub Identity",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-identity",
  });
  assert.equal(blocked.status, "blocked");

  sameNameWasReplaced = true;
  harness.fakeClaude.setInstallFails(false);
  const resumed = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(resumed.status, "blocked", JSON.stringify(resumed));
  assert.equal(resumed.reason, "github_workspace_repo_identity_reapproval_required");
  assert.match(resumed.error.repair, /both --github-owner and --github-repo/i);
  const unchanged = JSON.parse(fs.readFileSync(githubConnectionStatePath(harness.home), "utf8"));
  assert.equal(unchanged.repo.full_name, "Acme/teami-identity");

  const approved = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    github_owner: "Acme",
    github_repo: "teami-identity-2",
  });
  assert.equal(approved.status, "complete", JSON.stringify(approved));
  assert.equal(approved.steps.github.repo.full_name, "Acme/teami-identity-2");
  assert.ok(githubTransport.calls.some((call) =>
    call.endpointId === "create_repository" && call.repo === "teami-identity-2"));
});

test("an adopter can explicitly replace a missing GitHub workspace repository with different coordinates", async (t) => {
  const baseTransport = createMockGitHubSetupTransport();
  const githubTransport = { ...baseTransport, kind: "real" };
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: githubTransport,
    pluginFails: true,
  });
  const { result: blocked } = await startAndResume(harness, {
    team: "GitHub Replacement",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-old",
  });
  assert.equal(blocked.status, "blocked");

  harness.fakeClaude.setInstallFails(false);
  const resumed = await startOnboarding(harness, {
    team: "GitHub Replacement",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-new",
  });
  assert.equal(resumed.status, "complete", JSON.stringify(resumed));
  assert.equal(resumed.steps.github.repo.full_name, "Acme/teami-new");
  assert.ok(githubTransport.calls.some((call) =>
    call.endpointId === "create_repository" && call.repo === "teami-new"));
});

test("a legacy GitHub record without an immutable repository ID requires explicit replacement approval", async (t) => {
  const githubTransport = { ...createMockGitHubSetupTransport(), kind: "real" };
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: githubTransport,
    pluginFails: true,
    runGit: createCheckoutlessRunGit(),
  });
  const { awaiting, result: blocked } = await startAndResume(harness, {
    team: "Legacy GitHub Identity",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-legacy",
  });
  assert.equal(blocked.status, "blocked");
  const statePath = githubConnectionStatePath(harness.home);
  const connection = JSON.parse(fs.readFileSync(statePath, "utf8"));
  delete connection.repo.id;
  fs.writeFileSync(statePath, `${JSON.stringify(connection, null, 2)}\n`, "utf8");

  harness.fakeClaude.setInstallFails(false);
  const resumed = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(resumed.status, "blocked", JSON.stringify(resumed));
  assert.equal(resumed.reason, "github_workspace_repo_identity_reapproval_required");
  const stillLegacy = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stillLegacy.repo.full_name, "Acme/teami-legacy");
  assert.equal(stillLegacy.repo.id, undefined);

  const approved = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    github_owner: "Acme",
    github_repo: "teami-legacy-replacement",
  });
  assert.equal(approved.status, "complete", JSON.stringify(approved));
  assert.equal(approved.steps.github.repo.full_name, "Acme/teami-legacy-replacement");
});

test("checkout-based repair rechecks current GitHub write authority and recovers after auth is restored", async (t) => {
  const baseTransport = createMockGitHubSetupTransport();
  let writeDenied = false;
  const githubTransport = {
    kind: "real",
    calls: baseTransport.calls,
    request: async (request) => {
      if (writeDenied && request.endpointId === "push_initial_branch") {
        throw new Error("write permission denied by GitHub");
      }
      return baseTransport.request(request);
    },
  };
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: githubTransport,
    pluginFails: true,
  });
  const { awaiting, result: pluginBlocked } = await startAndResume(harness, {
    team: "Checkout Write Recheck",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-checkout-write",
  });
  assert.equal(pluginBlocked.status, "blocked");

  harness.fakeClaude.setInstallFails(false);
  writeDenied = true;
  const denied = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(denied.status, "blocked");
  assert.equal(denied.reason, "initial_branch_push_failed");
  assert.match(denied.error.repair, /GitHub|push access/i);

  writeDenied = false;
  const repaired = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(repaired.status, "complete", JSON.stringify(repaired));
});

test("checkoutless repair performs a fresh dry-run push and recovers after auth is restored", async (t) => {
  const writeControl = { denied: false };
  const githubTransport = { ...createMockGitHubSetupTransport(), kind: "real" };
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: githubTransport,
    pluginFails: true,
    runGit: createCheckoutlessRunGit({ writeControl }),
  });
  const { awaiting, result: pluginBlocked } = await startAndResume(harness, {
    team: "Checkoutless Write Recheck",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-checkoutless-write",
  });
  assert.equal(pluginBlocked.status, "blocked");

  harness.fakeClaude.setInstallFails(false);
  writeControl.denied = true;
  const denied = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(denied.status, "blocked");
  assert.equal(denied.reason, "behavior_repo_write_verification_failed");
  assert.match(denied.error.repair, /GitHub|write access/i);

  writeControl.denied = false;
  const repaired = await harness.actions.init_onboarding({ setup_id: awaiting.setup_id });
  assert.equal(repaired.status, "complete", JSON.stringify(repaired));
});

test("init_onboarding honors github_dry_run with the shared GitHub dry-run transport", async (t) => {
  const harness = createProgrammaticHarness(t, {
    githubSetupTransport: null,
  });

  const { result } = await startAndResume(harness, {
    team: "Research Ops",
    workspace: "Example Workspace",
    repo_intent: { mode: "non_code" },
    github_owner: "Acme",
    github_repo: "teami-research",
    github_dry_run: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "github_dry_run_not_complete");
  assert.equal(result.steps.github.mode, "dry_run");
  assert.equal(result.steps.github.transport_kind, "dry_run");
  assert.equal(result.steps.github.connected, true);
  assert.equal(result.steps.github.created, true);
  assert.equal(result.steps.github.repo.full_name, "Acme/teami-research");
  assert.match(result.next_steps.join("\n"), /dry run/i);

  const registry = readTeamRegistry({ home: harness.home });
  const team = registry.teams.find((candidate) => candidate.id === "research-ops");
  assert.equal(team.status, "active");
  assert.deepEqual(team.resources, []);
});

for (const fixture of [
  { label: "plugin failure", options: { pluginFails: true }, expected: "blocked", phase: "plugin" },
  { label: "Phoenix failure", options: { phoenixOk: false }, expected: "degraded", phase: "phoenix" },
  { label: "runtime failure", options: { runtimeOk: false }, expected: "blocked", phase: "runtime" },
  { label: "doctor failure", options: { doctorOk: false }, expected: "blocked", phase: "doctor" },
]) {
  test(`init_onboarding live health makes ${fixture.label} non-complete`, async (t) => {
    const harness = createProgrammaticHarness(t, fixture.options);
    const { result } = await startAndResume(harness, {
      team: `Health ${fixture.phase}`,
      workspace: "Example Workspace",
      repo_intent: { mode: "non_code" },
      github_owner: "Acme",
      github_repo: `teami-${fixture.phase}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, fixture.expected);
    assert.notEqual(result.steps[fixture.phase].ok, true);
    assert.doesNotMatch(result.next_steps.join("\n"), /Open a new Claude Code session|gateway start/i);
    if (fixture.phase === "runtime") {
      assert.match(result.steps.runtime.detail, /runtime fixture failed/i);
      assert.match(result.steps.runtime.repair, /runtime-smoke/i);
      assert.match(result.next_steps.join("\n"), /runtime-smoke/i);
    }
  });
}

function createProgrammaticHarness(
  t,
  {
    authorize = createSuccessfulAuthorize(),
    pluginAlreadyInstalled = false,
    pluginFails = false,
    phoenixOk = true,
    runtimeOk = true,
    doctorOk = true,
    authorizationBrowser = { opened: true, reason: null },
    adminAuthorizationBrowser = { opened: true, reason: null },
    statuses = undefined,
    authorizeOneShotAdmin = undefined,
    startOneShotAdminAuthorization = undefined,
    startLinearBrowserAuthorization = undefined,
    adminGrantUseWindowMs = undefined,
    githubDiscoveryRepos = [],
    githubSetupTransport = { ...createMockGitHubSetupTransport(), kind: "real" },
    runGit = createInMemoryRunGit(),
    onSetupProgress = null,
    credentialControl = null,
    createCredentialStore = null,
    createBootstrapCredentialStore = null,
    existingTeams = [],
    teamCreateError = null,
    runSetupDoctor = null,
    runClaudePluginRegistration = null,
  } = {},
) {
  const home = tempHome(t, "teami-mcp-init-full-");
  const client = new MemoryLinearClient({
    workspaceId: "workspace-1",
    workspaceName: "Example Workspace",
    statuses,
  });
  client.teams = existingTeams.map((team) => ({ ...team }));
  client.teamCreateError = teamCreateError;
  const fakeClaude = createFakeClaudeRunCommand({
    alreadyInstalled: pluginAlreadyInstalled,
    installFails: pluginFails,
    marketplaceSource: home,
  });
  const actions = createProjectMcpToolActions({
    repoRoot: home,
    home,
    config: testConfig(),
    ...(createCredentialStore ? { createCredentialStore } : {}),
    ...(createBootstrapCredentialStore ? { createBootstrapCredentialStore } : {}),
    createLinearSetupAuth: createAuthorizingSetupAuthFactory(client, credentialControl),
    startLinearBrowserAuthorization: startLinearBrowserAuthorization ||
      createFakeAuthorizationSessionStarter(authorize, authorizationBrowser),
    startOneShotAdminAuthorization: startOneShotAdminAuthorization ||
      createFakeAdminAuthorizationSessionStarter(authorizeOneShotAdmin, adminAuthorizationBrowser),
    ...(adminGrantUseWindowMs === undefined ? {} : { adminGrantUseWindowMs }),
    ...(authorizeOneShotAdmin ? { authorizeOneShotAdmin } : {}),
    githubDiscoveryRunCommand: fakeGithubDiscoveryRunCommand({ repos: githubDiscoveryRepos }),
    ...(githubSetupTransport === null ? {} : { githubSetupTransport }),
    runGit,
    ...(runClaudePluginRegistration ? { runClaudePluginRegistration } : {}),
    claudePluginRunCommand: fakeClaude.runCommand,
    ensurePhoenix: async () => phoenixOk
      ? ({ ok: true, appUrl: "http://127.0.0.1:6006" })
      : ({ ok: false, reason: "phoenix fixture unavailable" }),
    runPhoenixPreflight: async () => ({ ok: true, traceId: "trace-test" }),
    runRuntimeSmoke: async () => runtimeOk
      ? ({ ok: true, results: [{ ok: true }] })
      : ({ ok: false, results: [], error: "runtime fixture failed" }),
    runSetupDoctor: runSetupDoctor || (async () => [{ name: "fixture health", ok: doctorOk }]),
    ...(onSetupProgress ? { onSetupProgress } : {}),
  });
  return {
    home,
    client,
    actions,
    authorize,
    fakeClaude,
    githubTransport: githubSetupTransport || { calls: [] },
  };
}

async function startOnboarding(harness, args) {
  return harness.actions.init_onboarding({
    ...args,
    confirm: true,
    disclosure_version: SETUP_DISCLOSURE_VERSION,
    disclosure_hash: SETUP_DISCLOSURE_HASH,
  });
}

async function startAndResume(harness, args, resumeArgs = {}) {
  const awaiting = await startOnboarding(harness, args);
  assert.equal(awaiting.status, "awaiting_authorization");
  await new Promise((resolve) => setImmediate(resolve));
  const result = await harness.actions.init_onboarding({
    setup_id: awaiting.setup_id,
    ...resumeArgs,
  });
  return { awaiting, result };
}

function createFakeAuthorizationSessionStarter(authorize, browser = { opened: true, reason: null }) {
  return async (options = {}) => {
    const tokenPromise = Promise.resolve().then(() => authorize({ prompt: null, ...options }));
    tokenPromise.catch(() => {});
    return {
      authorizationUrl: authorize.url,
      expiresAt: "2026-07-11T14:00:00.000Z",
      browser,
      waitForToken: () => tokenPromise,
      close: async () => true,
    };
  };
}

function createFakeAdminAuthorizationSessionStarter(
  authorizeAdmin,
  browser = { opened: true, reason: null },
  url = "https://linear.test/oauth/authorize?admin=true",
) {
  return async (options = {}) => {
    const grantPromise = Promise.resolve().then(() => {
      if (typeof authorizeAdmin !== "function") throw new Error("admin authorization fixture missing");
      return authorizeAdmin(options);
    });
    grantPromise.catch(() => {});
    return {
      authorizationUrl: url,
      expiresAt: "2026-07-11T14:00:00.000Z",
      browser,
      waitForGrant: () => grantPromise,
      close: async () => true,
    };
  };
}

function createAuthorizingSetupAuthFactory(client, credentialControl = null) {
  return ({
    credentialStore,
    allowBrowserAuth,
    authorize,
    onAuthorizationUrl,
    onProgress,
    prompt,
    waitEscape,
    config,
    fetchImpl,
    openBrowser,
  } = {}) => {
    if (allowBrowserAuth === false && credentialControl?.revoked === true) {
      const error = new Error("Linear GraphQL request failed with HTTP 401");
      error.httpStatus = 401;
      return {
        client: {
          async verifyAuth() {
            throw error;
          },
        },
        credentialStore,
        tokenProvider: {
          lastTokenSource: "stored",
          clear: async () => credentialStore.deleteTokenSet?.(),
        },
      };
    }
    let pendingTokenSet = null;
    const tokenProvider = {
      lastTokenSource: null,
      clear: async () => {
        pendingTokenSet = null;
        tokenProvider.lastTokenSource = null;
        await credentialStore.deleteTokenSet?.();
      },
      discardPendingTokenSet: async () => {
        pendingTokenSet = null;
      },
      persistPendingTokenSet: async () => {
        if (!pendingTokenSet) return false;
        await credentialStore.writeTokenSet(pendingTokenSet);
        pendingTokenSet = null;
        return true;
      },
    };
    const ensureAuthorized = async () => {
      if (tokenProvider.lastTokenSource) return;
      if (allowBrowserAuth) {
        pendingTokenSet = await authorize({
          config,
          fetchImpl,
          openBrowser,
          onAuthorizationUrl,
          onProgress,
          prompt,
          waitEscape,
        });
        tokenProvider.lastTokenSource = "browser";
        return;
      }
      const stored = await credentialStore.readTokenSet?.();
      if (!stored) throw new Error("Linear OAuth authorization is missing.");
      tokenProvider.lastTokenSource = "stored";
    };
    const authorizedClient = new Proxy(client, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return async (...args) => {
          await ensureAuthorized();
          return value.apply(target, args);
        };
      },
    });
    return {
      client: authorizedClient,
      credentialStore,
      tokenProvider,
    };
  };
}

function createSuccessfulAuthorize(url = "https://linear.test/oauth/authorize?client_id=linear-client-test") {
  const calls = [];
  const authorize = async ({ onAuthorizationUrl, prompt } = {}) => {
    calls.push({ prompt });
    onAuthorizationUrl?.(url);
    return {
      access_token: "access-test",
      refresh_token: "refresh-test",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "read write",
    };
  };
  authorize.url = url;
  authorize.calls = calls;
  return authorize;
}

function createRejectingAuthorize(error) {
  const calls = [];
  const authorize = async ({ onAuthorizationUrl, prompt } = {}) => {
    calls.push({ prompt });
    onAuthorizationUrl?.("https://linear.test/oauth/authorize?client_id=linear-client-test");
    throw error;
  };
  authorize.url = "https://linear.test/oauth/authorize?client_id=linear-client-test";
  authorize.calls = calls;
  return authorize;
}

function createFakeClaudeRunCommand({
  alreadyInstalled = false,
  installFails = false,
  marketplaceSource = null,
} = {}) {
  const calls = [];
  let shouldFailInstall = installFails;
  let installed = alreadyInstalled;
  let marketplaceReady = alreadyInstalled;
  let trustedSource = marketplaceSource;
  const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
  return {
    calls,
    setInstallFails(value) {
      shouldFailInstall = value === true;
    },
    async runCommand(command, args) {
      assert.equal(command, "claude");
      calls.push({ command, args: [...args] });
      if (args.join(" ") === "plugin marketplace list --json") {
        return ok(JSON.stringify(marketplaceReady ? [{
          name: "teami",
          source: "directory",
          path: trustedSource,
          installLocation: trustedSource,
        }] : []));
      }
      if (args.join(" ") === "plugin list --json") {
        return ok(installed ? JSON.stringify([{
          id: "teami@teami",
          name: "teami",
          version: PACKAGED_PLUGIN_VERSION,
          scope: "user",
          enabled: true,
          mcpServers: {
            teami: { command: "npx", args: ["-y", `@shulmansj/teami@${PACKAGED_PLUGIN_VERSION}`, "mcp"] },
          },
        }]) : "[]");
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        marketplaceReady = true;
        trustedSource = args[3];
        return ok();
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "update") {
        return ok();
      }
      if (args[0] === "plugin" && args[1] === "install") {
        if (shouldFailInstall) {
          return { ok: false, status: 1, stdout: "", stderr: "plugin fixture failed" };
        }
        installed = true;
        return ok();
      }
      return { ok: false, status: 1, stdout: "", stderr: `unexpected claude ${args.join(" ")}` };
    },
  };
}

function fakeGithubDiscoveryRunCommand({ repos = [] } = {}) {
  return (command, args) => {
    assert.equal(command, "gh");
    if (args[0] === "repo" && args[1] === "list") {
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify(repos.map((repo) => ({
          nameWithOwner: `${repo.owner}/${repo.repo}`,
          defaultBranchRef: { name: repo.default_branch },
        }))),
        stderr: "",
      };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
}

function testConfig() {
  const config = fileCredentialConfig(loadLinearConfig({ repoRoot, behaviorConfig: false }));
  config.github = {
    ...(config.github || {}),
    starter_remote_urls: [],
  };
  return config;
}

function fileCredentialConfig(config) {
  const next = structuredClone(config);
  next.linear.oauth.credential_storage = "file";
  return next;
}

function tempHome(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env.TEAMI_HOME;
  process.env.TEAMI_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.TEAMI_HOME;
    else process.env.TEAMI_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function createInMemoryRunGit({ remotes = {} } = {}) {
  const remoteMap = new Map(Object.entries(remotes));
  const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ ok: false, status: 1, stdout: "", stderr });
  const formatRemotes = () => [...remoteMap.entries()]
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");
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

function createCheckoutlessRunGit({ writeControl = { denied: false } } = {}) {
  const ok = (stdout = "") => ({ ok: true, status: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ ok: false, status: 128, stdout: "", stderr });
  return (args) => {
    if (args[0] === "remote" && args[1] === "-v") {
      return fail("fatal: not a git repository");
    }
    if (args[0] === "rev-parse") return ok("abc123\n");
    if (args[0] === "ls-files" && args[1] === "-z") return ok("");
    if (args[0] === "push" && args.includes("--dry-run") && writeControl.denied) {
      return fail("write permission denied by GitHub");
    }
    if (["init", "add", "commit", "clone", "push", "ls-remote"].includes(args[0]) || args.includes("commit")) return ok();
    if (args[0] === "remote" && args[1] === "add") return ok();
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
}

function defaultWorkflowStates() {
  return [
    { id: "state-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "state-todo", name: "Todo", type: "unstarted", position: 20 },
    { id: "state-in-progress", name: "In Progress", type: "started", position: 30 },
    { id: "state-in-review", name: "In Review", type: "started", position: 40 },
    { id: "state-human-review", name: "Principal Review", type: "started", position: 50 },
    { id: "state-needs-principal", name: "Principal Escalation", type: "started", position: 60 },
    { id: "state-done", name: "Done", type: "completed", position: 70 },
  ];
}

function projectStatusesWithoutAdminException() {
  return [
    { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
    { id: "status-planned", name: "Planned", type: "planned", position: 20 },
    { id: "status-started", name: "In Progress", type: "started", position: 30 },
    { id: "status-completed", name: "Completed", type: "completed", position: 40 },
  ];
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryLinearClient {
  constructor({
    statuses,
    workflowStates,
    workspaceId = "workspace-1",
    workspaceName = "Example Workspace",
    viewerId = "app-viewer-1",
    viewerName = "Teami App",
    teamCreateError = null,
  } = {}) {
    this.teams = [];
    this.projectLabels = [];
    this.projectLabelUpdates = [];
    this.issueLabels = [];
    this.issueLabelUpdates = [];
    this.issueLabelArchives = [];
    this.workflowStates = (workflowStates || defaultWorkflowStates()).map((state) => ({ ...state }));
    this.workflowStateUpdates = [];
    this.workflowStateArchives = [];
    this.projectStatuses = statuses || [
      { id: "status-backlog", name: "Backlog", type: "backlog", position: 10 },
      { id: "status-planned", name: "Planned", type: "planned", position: 20 },
      { id: "status-started", name: "In Progress", type: "started", position: 30 },
      { id: "status-completed", name: "Completed", type: "completed", position: 40 },
      { id: "status-principal-escalation", name: "Principal Escalation", type: "planned", position: 20.01 },
    ];
    this.issues = [];
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
    this.viewerId = viewerId;
    this.viewerName = viewerName;
    this.teamCreateError = teamCreateError;
  }

  async verifyAuth() {
    return { ok: true, viewerId: this.viewerId, viewerName: this.viewerName };
  }

  async getOrganization() {
    return { id: this.workspaceId, name: this.workspaceName };
  }

  async listTeams() {
    return this.teams;
  }

  async createTeam(input) {
    if (this.teamCreateError) throw this.teamCreateError;
    const team = {
      id: `team-${this.teams.length + 1}`,
      ...input,
      key: input.key || generatedTeamKey(input.name, this.teams.length + 1),
    };
    this.teams.push(team);
    return team;
  }

  async findProjectLabelsByName(name) {
    return this.projectLabels.filter((label) => !name || label.name === name);
  }

  async createProjectLabel(input) {
    const label = { id: `plabel-${this.projectLabels.length + 1}`, ...input };
    this.projectLabels.push(label);
    return label;
  }

  async updateProjectLabel(id, input) {
    const label = this.projectLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear project label ${id} not found.`);
    Object.assign(label, input);
    this.projectLabelUpdates.push({ id, input });
    return label;
  }

  async findIssueLabelsByName(name, teamId) {
    return this.issueLabels.filter(
      (label) => !label.archived && (!name || label.name === name) && (!teamId || label.teamId === teamId),
    );
  }

  async createIssueLabel(input) {
    const label = { id: `ilabel-${slugFor(input.name) || this.issueLabels.length + 1}`, ...input };
    this.issueLabels.push(label);
    return label;
  }

  async updateIssueLabel(id, input) {
    const label = this.issueLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear issue label ${id} not found.`);
    Object.assign(label, input);
    this.issueLabelUpdates.push({ id, input });
    return label;
  }

  async archiveIssueLabel(id) {
    const label = this.issueLabels.find((candidate) => candidate.id === id);
    if (!label) throw new Error(`Linear issue label ${id} not found.`);
    label.archived = true;
    this.issueLabelArchives.push(id);
    return { ok: true };
  }

  async listProjectStatuses() {
    return this.projectStatuses;
  }

  async createProjectStatus(input) {
    const status = { id: `status-${slugFor(input.name) || this.projectStatuses.length + 1}`, ...input };
    this.projectStatuses.push(status);
    return status;
  }

  async listWorkflowStates() {
    return this.workflowStates.filter((state) => !state.archived);
  }

  async createWorkflowState(input) {
    const state = {
      id: `state-${slugFor(input.name) || this.workflowStates.length + 1}`,
      name: input.name,
      type: input.type,
      teamId: input.teamId || null,
      ...("description" in input ? { description: input.description ?? null } : {}),
      ...("color" in input ? { color: input.color ?? null } : {}),
      ...("position" in input ? { position: input.position } : {}),
    };
    this.workflowStates.push(state);
    return state;
  }

  async updateWorkflowState(id, input) {
    const state = this.workflowStates.find((candidate) => candidate.id === id);
    if (!state) throw new Error(`Linear workflow state ${id} not found.`);
    Object.assign(state, input);
    this.workflowStateUpdates.push({ id, input });
    return state;
  }

  async archiveWorkflowState(id) {
    const state = this.workflowStates.find((candidate) => candidate.id === id);
    if (!state) throw new Error(`Linear workflow state ${id} not found.`);
    state.archived = true;
    this.workflowStateArchives.push(id);
    return { ok: true };
  }

  async listIssues({ teamId = null, stateId = null, labelId = null } = {}) {
    return this.issues.filter((issue) => {
      if (teamId && issue.teamId !== teamId && issue.team?.id !== teamId) return false;
      if (stateId && issue.stateId !== stateId && issue.state?.id !== stateId) return false;
      if (labelId && !issue.labelIds?.includes(labelId)) return false;
      return true;
    });
  }
}

function generatedTeamKey(name, fallbackNumber) {
  const letters = String(name || "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 4);
  return letters || `T${fallbackNumber}`;
}

function slugFor(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function linkedMcpTransports() {
  const client = new InProcessMcpTransport();
  const server = new InProcessMcpTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class InProcessMcpTransport {
  constructor() {
    this.peer = null;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
    this.sessionId = undefined;
  }

  async start() {}

  async send(message) {
    queueMicrotask(() => {
      this.peer?.onmessage?.(message);
    });
  }

  async close() {
    this.onclose?.();
  }
}
