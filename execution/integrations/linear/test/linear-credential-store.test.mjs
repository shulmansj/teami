import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  createLinearCredentialStore,
  createFileCredentialStore,
  createOsCredentialStore,
  credentialTargetForConfig,
  isLegacyCredentialTargetForConfig,
  legacyCredentialTargetForConfig,
  parseTokenSecret,
  serializeTokenSet,
} from "../src/linear-credential-store.mjs";
import { legacyTeamCredentialTargetsForConfig } from "../src/legacy-team-state-migration.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Two teams in different workspaces produce different Linear OAuth credential targets", () => {
  const config = loadLinearConfig({ repoRoot });
  const teamA = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const teamB = { teamRef: "sales-ops", workspaceId: "workspace-b" };

  assert.notEqual(
    credentialTargetForConfig(config, teamA),
    credentialTargetForConfig(config, teamB),
  );
});

test("One Team ref in different workspaces produces different Linear OAuth credential targets", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.notEqual(
    credentialTargetForConfig(config, { teamRef: "main", workspaceId: "workspace-a" }),
    credentialTargetForConfig(config, { teamRef: "main", workspaceId: "workspace-b" }),
  );
});

test("Same team credential targets are stable across calls", () => {
  const config = loadLinearConfig({ repoRoot });
  const team = {
    teamRef: "support-ops",
    workspaceId: "workspace-a",
  };

  assert.equal(
    credentialTargetForConfig(config, team),
    credentialTargetForConfig(config, team),
  );
  assert.equal(
    credentialTargetForConfig(config, "fixture-repo-a", team),
    credentialTargetForConfig(config, "fixture-repo-b", team),
  );
});

test("Legacy-format detection fires on a synthesized old target", () => {
  const config = loadLinearConfig({ repoRoot });
  const oldOAuthTarget = legacyCredentialTargetForConfig(config, "fixture-repo-a");

  assert.equal(isLegacyCredentialTargetForConfig(oldOAuthTarget, config, "fixture-repo-a"), true);
  assert.equal(
    isLegacyCredentialTargetForConfig(
      credentialTargetForConfig(config, {
        teamRef: "support-ops",
        workspaceId: "workspace-a",
      }),
      config,
      "fixture-repo-a",
    ),
    false,
  );
});

test("New-format credential target builders throw when team or workspace ids are missing", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.throws(
    () => credentialTargetForConfig(config),
    /requires workspace_id and team_ref/,
  );
  assert.throws(
    () => credentialTargetForConfig(config, { teamRef: "support-ops" }),
    /requires workspace_id/,
  );
  assert.throws(
    () => createLinearCredentialStore({ config, repoRoot: "fixture-repo-a" }),
    /requires workspace_id and team_ref/,
  );
});

test("file credential store is explicit, ignored-local, and round-trips token sets", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-"));
  const filePath = path.join(tempDir, ".teami", "linear-oauth-token.json");
  const store = createFileCredentialStore({ filePath, target: "target-1" });

  assert.equal(store.kind, "file");
  assert.match(store.warning, /local testing/);
  assert.equal(await store.readTokenSet(), null);

  await store.writeTokenSet({
    accessToken: "access-file",
    refreshToken: "refresh-file",
    expiresAt: "2026-06-07T21:00:00.000Z",
    scope: "read write",
  });
  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /refresh-file/);
  assert.deepEqual(await store.readTokenSet(), {
    accessToken: "access-file",
    refreshToken: "refresh-file",
    expiresAt: "2026-06-07T21:00:00.000Z",
    scope: "read write",
  });
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  await store.deleteTokenSet();
  assert.equal(fs.existsSync(filePath), false);
});

test("Linear file credential fallback lives under the Teami home credentials directory", async () => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.linear.oauth.credential_storage = "file";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-home-"));
  const store = createLinearCredentialStore({
    config,
    home,
    repoRoot: path.join(home, "checkout"),
    teamRef: "support-ops",
    workspaceId: "workspace-a",
  });
  const expectedPath = path.join(
    home,
    "credentials",
    "teams",
    "support-ops",
    "linear-oauth-token.json",
  );

  await store.writeTokenSet({ refreshToken: "refresh-home-file" });

  assert.equal(fs.existsSync(expectedPath), true);
  assert.match(fs.readFileSync(expectedPath, "utf8"), /refresh-home-file/);
  assert.equal(
    fs.existsSync(path.join(home, "checkout", ".teami", "teams", "support-ops", "linear-oauth-token.json")),
    false,
  );
});

test("Linear file credential fallback promotes the released per-team path on first read", async () => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.linear.oauth.credential_storage = "file";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-home-migration-"));
  try {
    const oldPath = path.join(
      home,
      "credentials",
      "domains",
      "support-ops",
      "linear-oauth-token.json",
    );
    const newPath = path.join(
      home,
      "credentials",
      "teams",
      "support-ops",
      "linear-oauth-token.json",
    );
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, serializeTokenSet({ refreshToken: "refresh-path-migration" }), "utf8");
    const store = createLinearCredentialStore({
      config,
      home,
      repoRoot: path.join(home, "checkout"),
      teamRef: "support-ops",
      workspaceId: "workspace-a",
    });

    assert.equal((await store.readTokenSet()).refreshToken, "refresh-path-migration");
    assert.equal(fs.existsSync(newPath), true);
    assert.equal(fs.existsSync(oldPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Linear file credential promotion refuses linked legacy files without leaking paths", async (t) => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.linear.oauth.credential_storage = "file";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-link-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-external-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const oldPath = path.join(
    home,
    "credentials",
    "domains",
    "support-ops",
    "linear-oauth-token.json",
  );
  const externalPath = path.join(external, "outside-token.json");
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(
    externalPath,
    serializeTokenSet({ refreshToken: "external-refresh-must-remain" }),
    "utf8",
  );
  try {
    fs.symlinkSync(externalPath, oldPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`file links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const store = createLinearCredentialStore({
    config,
    home,
    repoRoot: path.join(home, "checkout"),
    teamRef: "support-ops",
    workspaceId: "workspace-a",
  });

  await assert.rejects(
    () => store.readTokenSet(),
    (error) => {
      assert.match(error.message, /not a supported regular file/);
      assert.doesNotMatch(error.message, /domains|credential-link|outside-token/);
      return true;
    },
  );
  assert.match(fs.readFileSync(externalPath, "utf8"), /external-refresh-must-remain/);
  assert.equal(
    fs.existsSync(path.join(home, "credentials", "teams", "support-ops", "linear-oauth-token.json")),
    false,
  );
});

test("Windows Credential Manager store uses PasswordVault without runtime C# compilation", async () => {
  const calls = [];
  const store = createOsCredentialStore({
    platform: "win32",
    target: "target-win",
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: calls.length === 1 ? "" : '{"refreshToken":"refresh-win"}\n' };
    },
  });

  assert.equal(store.kind, "windows-credential-manager");
  await store.writeTokenSet({ refreshToken: "refresh-win" });
  assert.deepEqual(await store.readTokenSet(), { refreshToken: "refresh-win" });
  await store.deleteTokenSet();

  assert.equal(calls[0].command, "powershell.exe");
  const commandForm = calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
  assert.doesNotMatch(commandForm, /Add-Type/);
  assert.doesNotMatch(commandForm, /DllImport|public class|CredRead|CredWrite|Runtime\.InteropServices/);
  assert.match(commandForm, /PasswordVault/);
  assert.match(commandForm, /PasswordCredential/);
  assert.equal(calls[0].args.includes("refresh-win"), false);
  assert.match(calls[0].options.input, /refresh-win/);
  assert.equal(calls[0].options.env.AF_LINEAR_CREDENTIAL_TARGET, "target-win");
  assert.equal(calls[1].options.env.AF_LINEAR_CREDENTIAL_ACTION, "read");
  assert.equal(calls[2].options.env.AF_LINEAR_CREDENTIAL_ACTION, "delete");
});

test("Linux Secret Service store passes secrets through stdin and treats missing secrets as empty", async () => {
  const calls = [];
  const store = createOsCredentialStore({
    platform: "linux",
    target: "target-linux",
    run: (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "lookup") return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(store.kind, "linux-secret-service");
  assert.equal(await store.readTokenSet(), null);
  await store.writeTokenSet({ refreshToken: "refresh-linux" });
  await store.deleteTokenSet();

  assert.equal(calls[0].command, "secret-tool");
  assert.deepEqual(calls[0].args, ["lookup", "service", "target-linux", "account", "refresh_token"]);
  assert.equal(calls[1].args.includes("refresh-linux"), false);
  assert.match(calls[1].options.input, /refresh-linux/);
});

test("OS credential store lazily migrates the released per-team target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, team);
  const legacyTarget = releasedTeamCredentialTargetForConfig(config, team);
  const secrets = new Map([
    [
      legacyTarget,
      serializeTokenSet({
        accessToken: "access-legacy-team",
        refreshToken: "refresh-legacy-team",
      }),
    ],
  ]);
  const calls = [];
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets, calls }),
  });

  assert.deepEqual(await store.readTokenSet(), {
    accessToken: "access-legacy-team",
    refreshToken: "refresh-legacy-team",
  });
  assert.equal(secrets.has(legacyTarget), false);
  assert.match(secrets.get(newTarget), /refresh-legacy-team/);

  const callCountAfterMigration = calls.length;
  assert.equal((await store.readTokenSet()).refreshToken, "refresh-legacy-team");
  assert.deepEqual(
    calls.slice(callCountAfterMigration).map((call) => `${call.action}:${call.target}`),
    [`lookup:${newTarget}`],
  );
});

test("read-only credential access never promotes a predecessor Team grant", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-credential-read-only-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const currentTarget = credentialTargetForConfig(config, team);
  const predecessorTarget = releasedTeamCredentialTargetForConfig(config, team);
  const secrets = new Map([[predecessorTarget, serializeTokenSet({ refreshToken: "refresh-predecessor" })]]);
  const store = createLinearCredentialStore({
    config,
    repoRoot: home,
    home,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
    promoteLegacyOnRead: false,
  });

  assert.equal(await store.readTokenSet(), null);
  assert.equal(secrets.has(currentTarget), false);
  assert.equal(secrets.has(predecessorTarget), true);
});

test("canonical-only credential promotion never imports legacy grants during workspace replacement", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-credential-workspace-replacement-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const oldTeam = { teamRef: "main", workspaceId: "workspace-a" };
  const newTeam = { teamRef: "main", workspaceId: "workspace-b" };
  const oldTarget = credentialTargetForConfig(config, oldTeam);
  const newTarget = credentialTargetForConfig(config, newTeam);
  const predecessorTarget = releasedTeamCredentialTargetForConfig(config, newTeam);
  const sharedBootstrapTarget = legacyCredentialTargetForConfig(config, home);
  const secrets = new Map([
    [oldTarget, serializeTokenSet({ refreshToken: "refresh-old-workspace" })],
    [predecessorTarget, serializeTokenSet({ refreshToken: "refresh-predecessor" })],
    [sharedBootstrapTarget, serializeTokenSet({ refreshToken: "refresh-shared-bootstrap" })],
  ]);
  const store = createLinearCredentialStore({
    config,
    repoRoot: home,
    home,
    teamContext: newTeam,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
    promoteLegacyOnRead: false,
  });

  assert.equal(await store.readTokenSet(), null);
  assert.deepEqual(
    await store.writeTokenSetIfAbsentOrEqual({ refreshToken: "refresh-browser-approved" }),
    { ok: true, status: "written" },
  );
  assert.equal(parseTokenSecret(secrets.get(newTarget)).refreshToken, "refresh-browser-approved");
  assert.equal(parseTokenSecret(secrets.get(oldTarget)).refreshToken, "refresh-old-workspace");
  assert.equal(parseTokenSecret(secrets.get(predecessorTarget)).refreshToken, "refresh-predecessor");
  assert.equal(parseTokenSecret(secrets.get(sharedBootstrapTarget)).refreshToken, "refresh-shared-bootstrap");
});

test("Team credential teardown removes predecessors but preserves the shared bootstrap grant", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-credential-teardown-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const currentTarget = credentialTargetForConfig(config, team);
  const predecessorTargets = legacyTeamCredentialTargetsForConfig(config, {
    repoRoot: home,
    teamRef: team.teamRef,
    workspaceId: team.workspaceId,
  });
  const sharedBootstrapTarget = legacyCredentialTargetForConfig(config, home);
  const secrets = new Map([
    [currentTarget, serializeTokenSet({ refreshToken: "refresh-current" })],
    ...predecessorTargets.map((target) => [target, serializeTokenSet({ refreshToken: `refresh-${target}` })]),
    [sharedBootstrapTarget, serializeTokenSet({ refreshToken: "refresh-shared-bootstrap" })],
  ]);
  const store = createLinearCredentialStore({
    config,
    repoRoot: home,
    home,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
  });

  await store.deleteTokenSet();

  assert.equal(secrets.has(currentTarget), false);
  for (const target of predecessorTargets) assert.equal(secrets.has(target), false);
  assert.equal(secrets.has(sharedBootstrapTarget), true);
});

test("credential promotion excludes a concurrent fresh write to the same Team target", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-lock-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const currentTarget = credentialTargetForConfig(config, team);
  const legacyTarget = releasedTeamCredentialTargetForConfig(config, team);
  const secrets = new Map([
    [legacyTarget, serializeTokenSet({ refreshToken: "refresh-from-legacy" })],
  ]);
  const run = createLinuxSecretToolMemoryRun({ secrets });
  const promotingStore = createLinearCredentialStore({
    config,
    home,
    repoRoot: "fixture-repo-lock",
    teamContext: team,
    platform: "linux",
    run,
  });
  const writerStore = createLinearCredentialStore({
    config,
    home,
    repoRoot: "fixture-repo-lock",
    teamContext: team,
    platform: "linux",
    run,
  });

  const promotion = promotingStore.readTokenSet();
  await assert.rejects(
    () => writerStore.writeTokenSet({ refreshToken: "refresh-newer" }),
    /credential is being updated/,
  );
  assert.equal((await promotion).refreshToken, "refresh-from-legacy");

  await writerStore.writeTokenSet({ refreshToken: "refresh-newer" });
  assert.equal(parseTokenSecret(secrets.get(currentTarget)).refreshToken, "refresh-newer");
});

test("credential compare-delete preserves a bootstrap grant changed after observation", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-bootstrap-compare-delete-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createLinearCredentialStore({
    config: { ...config, linear: { ...config.linear, oauth: { ...config.linear.oauth, credential_storage: "file" } } },
    home,
    repoRoot: home,
    target: legacyCredentialTargetForConfig(config),
  });
  await store.writeTokenSet({ refreshToken: "refresh-observed" });
  const observed = await store.readTokenSet();
  await store.writeTokenSet({ refreshToken: "refresh-newer" });

  assert.deepEqual(
    await store.deleteTokenSetIfEqual(observed),
    { ok: false, status: "conflict" },
  );
  assert.equal((await store.readTokenSet()).refreshToken, "refresh-newer");
});

test("credential compare-replace cannot restore a grant deleted after observation", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-credential-compare-replace-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createLinearCredentialStore({
    config: { ...config, linear: { ...config.linear, oauth: { ...config.linear.oauth, credential_storage: "file" } } },
    home,
    repoRoot: home,
    teamContext: { teamRef: "support-ops", workspaceId: "workspace-1" },
  });
  await store.writeTokenSet({ refreshToken: "refresh-observed" });
  const observed = await store.readTokenSet();
  await store.deleteTokenSet();

  assert.deepEqual(
    await store.replaceTokenSetIfEqual(observed, { refreshToken: "refresh-rotated" }),
    { ok: false, status: "conflict" },
  );
  assert.equal(await store.readTokenSet(), null);
});

test("credential compare-replace preserves a grant changed after observation", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-credential-compare-replace-race-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createLinearCredentialStore({
    config: { ...config, linear: { ...config.linear, oauth: { ...config.linear.oauth, credential_storage: "file" } } },
    home,
    repoRoot: home,
    teamContext: { teamRef: "support-ops", workspaceId: "workspace-1" },
    promoteLegacyOnRead: false,
  });
  await store.writeTokenSet({ refreshToken: "refresh-observed" });
  const observed = await store.readTokenSet();
  await store.writeTokenSet({ refreshToken: "refresh-concurrent" });

  assert.deepEqual(
    await store.replaceTokenSetIfEqual(observed, { refreshToken: "refresh-browser-approved" }),
    { ok: false, status: "conflict" },
  );
  assert.equal((await store.readTokenSet()).refreshToken, "refresh-concurrent");
});

test("explicit promotion preserves a differing Team credential in a supported predecessor target", async (t) => {
  const config = loadLinearConfig({ repoRoot });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-credential-predecessor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const currentTarget = credentialTargetForConfig(config, team);
  const legacyTarget = releasedTeamCredentialTargetForConfig(config, team);
  const secrets = new Map([
    [legacyTarget, serializeTokenSet({ refreshToken: "refresh-newer-legacy-team" })],
  ]);
  const store = createLinearCredentialStore({
    config,
    home,
    repoRoot: "fixture-repo-promotion",
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
  });

  const promotion = await store.writeTokenSetIfAbsentOrEqual({
    refreshToken: "refresh-bootstrap-old",
  });

  assert.deepEqual(promotion, { ok: false, status: "conflict" });
  assert.equal(parseTokenSecret(secrets.get(currentTarget)).refreshToken, "refresh-newer-legacy-team");
  assert.equal(secrets.has(legacyTarget), false);
});

test("OS credential store lazily migrates the older repo-root plus team identity target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, team);
  const legacyTarget = olderRepoTeamCredentialTargetForConfig(config, legacyRepoRoot, team);
  const secrets = new Map([[legacyTarget, serializeTokenSet({ refreshToken: "refresh-older-team" })]]);
  const calls = [];
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets, calls }),
  });

  assert.equal((await store.readTokenSet()).refreshToken, "refresh-older-team");
  assert.equal(secrets.has(legacyTarget), false);
  assert.match(secrets.get(newTarget), /refresh-older-team/);
  assert.deepEqual(
    calls.map((call) => `${call.action}:${call.target}`),
    [
      `lookup:${newTarget}`,
      `lookup:${releasedTeamCredentialTargetForConfig(config, team)}`,
      `lookup:${legacyTarget}`,
      `store:${newTarget}`,
      `lookup:${newTarget}`,
      `clear:${legacyTarget}`,
      `lookup:${legacyCredentialTargetForConfig(config, legacyRepoRoot)}`,
    ],
  );
});

test("OS credential store promotes but retains the shared repo-root-only legacy target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, team);
  const legacyTarget = legacyCredentialTargetForConfig(config, legacyRepoRoot);
  const secrets = new Map([
    [
      legacyTarget,
      serializeTokenSet({
        accessToken: "access-legacy-bootstrap",
        refreshToken: "refresh-legacy-bootstrap",
      }),
    ],
  ]);
  const calls = [];
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets, calls }),
  });

  assert.deepEqual(await store.readTokenSet(), {
    accessToken: "access-legacy-bootstrap",
    refreshToken: "refresh-legacy-bootstrap",
  });
  assert.equal(secrets.has(legacyTarget), true);
  assert.match(secrets.get(newTarget), /refresh-legacy-bootstrap/);
  assert.deepEqual(
    calls.map((call) => `${call.action}:${call.target}`),
    [
      `lookup:${newTarget}`,
      `lookup:${releasedTeamCredentialTargetForConfig(config, team)}`,
      `lookup:${olderRepoTeamCredentialTargetForConfig(config, legacyRepoRoot, team)}`,
      `lookup:${legacyTarget}`,
      `store:${newTarget}`,
      `lookup:${newTarget}`,
      `lookup:${legacyTarget}`,
    ],
  );
});

test("two Teams independently promote before the shared repo-root-only credential is cleaned up", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-shared";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-shared-credential-cleanup-"));
  const sharedTarget = legacyCredentialTargetForConfig(config, legacyRepoRoot);
  const secrets = new Map([
    [sharedTarget, serializeTokenSet({ refreshToken: "refresh-shared-bootstrap" })],
  ]);

  const teams = [
    { teamRef: "support-ops", workspaceId: "workspace-a" },
    { teamRef: "product-ops", workspaceId: "workspace-b" },
  ];
  writeJson(path.join(home, "teams.json"), currentRegistryForCredentials(teams));

  try {
    for (const [index, team] of teams.entries()) {
      const store = createLinearCredentialStore({
        config,
        home,
        repoRoot: legacyRepoRoot,
        teamContext: team,
        platform: "linux",
        run: createLinuxSecretToolMemoryRun({ secrets }),
      });
      assert.equal((await store.readTokenSet()).refreshToken, "refresh-shared-bootstrap");
      assert.match(secrets.get(credentialTargetForConfig(config, team)), /refresh-shared-bootstrap/);
      assert.equal(secrets.has(sharedTarget), index === 0);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("credential promotion verifies the new target before deleting a Team-scoped predecessor", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-verification";
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, team);
  const legacyTarget = releasedTeamCredentialTargetForConfig(config, team);
  const secrets = new Map([
    [legacyTarget, serializeTokenSet({ refreshToken: "refresh-safe-source" })],
  ]);
  const baseRun = createLinuxSecretToolMemoryRun({ secrets });
  const run = (command, args, options) => {
    const result = baseRun(command, args, options);
    if (args[0] === "store" && targetFromLinuxSecretToolArgs(args) === newTarget) {
      secrets.set(newTarget, serializeTokenSet({ refreshToken: "refresh-corrupt-copy" }));
    }
    return result;
  };
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    teamContext: team,
    platform: "linux",
    run,
  });

  await assert.rejects(
    () => store.readTokenSet(),
    (error) => {
      assert.match(error.message, /read-back validation failed/);
      assert.doesNotMatch(error.message, /refresh-safe-source|refresh-corrupt-copy/);
      return true;
    },
  );
  assert.equal(secrets.has(legacyTarget), true);
});

test("fresh OS credential writes only the de-keyed target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const team = { teamRef: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, team);
  const secrets = new Map();
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    teamContext: team,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
  });

  await store.writeTokenSet({ refreshToken: "refresh-new" });

  assert.deepEqual([...secrets.keys()], [newTarget]);
  assert.equal(
    secrets.has(releasedTeamCredentialTargetForConfig(config, team)),
    false,
  );
  assert.equal(secrets.has(olderRepoTeamCredentialTargetForConfig(config, legacyRepoRoot, team)), false);
  assert.equal(secrets.has(legacyCredentialTargetForConfig(config, legacyRepoRoot)), false);
});

test("macOS Keychain store passes secrets through stdin, not argv, and round-trips", async () => {
  const secrets = new Map();
  const calls = [];
  const store = createOsCredentialStore({
    platform: "darwin",
    target: "target-mac",
    run: createMacosSecurityMemoryRun({ secrets, calls }),
  });
  const tokenSet = {
    accessToken: "access-mac",
    refreshToken: "refresh-mac",
    scope: "read write",
  };
  const serializedSecret = serializeTokenSet(tokenSet);

  assert.equal(store.kind, "macos-keychain");
  assert.equal(await store.readTokenSet(), null);
  await store.writeTokenSet(tokenSet);
  assert.deepEqual(await store.readTokenSet(), tokenSet);
  await store.deleteTokenSet();
  assert.equal(await store.readTokenSet(), null);

  for (const call of calls) {
    assert.equal(call.command, "security");
    assert.equal(call.args.includes(serializedSecret), false);
    for (const arg of call.args) {
      assert.equal(arg.includes("refresh-mac"), false);
      assert.equal(arg.includes("access-mac"), false);
    }
  }

  const writeCall = calls.find((call) => call.action === "add-generic-password");
  assert.ok(writeCall);
  assert.deepEqual(writeCall.args, [
    "add-generic-password",
    "-a",
    "refresh_token",
    "-s",
    "target-mac",
    "-U",
    "-w",
  ]);
  assert.equal(writeCall.options.input, serializedSecret);
});

test("token secret serialization supports current and legacy refresh-token shapes", () => {
  assert.deepEqual(parseTokenSecret("legacy-refresh-token\n"), {
    refreshToken: "legacy-refresh-token",
  });
  assert.deepEqual(parseTokenSecret('{"access_token":"access","refresh_token":"refresh"}'), {
    accessToken: "access",
    refreshToken: "refresh",
  });
  assert.match(serializeTokenSet({ refreshToken: "refresh" }), /"refreshToken":"refresh"/);
  assert.throws(() => serializeTokenSet({ accessToken: "access" }), /refresh token is required/);
});

function releasedTeamCredentialTargetForConfig(config, teamIdentity) {
  const oauth = config?.linear?.oauth || {};
  const identity = [
    oauth.client_id || "",
    oauth.redirect_uri || "",
    `workspace_id:${teamIdentity.workspaceId}`,
    `domain_id:${teamIdentity.teamRef}`,
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryLinearOAuth:${digest}`;
}

function olderRepoTeamCredentialTargetForConfig(config, previousRepoRoot, teamIdentity) {
  const oauth = config?.linear?.oauth || {};
  const identity = [
    "teami-linear-oauth",
    oauth.client_id || "",
    oauth.redirect_uri || "",
    path.resolve(previousRepoRoot),
    `workspace_id:${teamIdentity.workspaceId}`,
    `domain_id:${teamIdentity.teamRef}`,
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryLinearOAuth:${digest}`;
}

function createLinuxSecretToolMemoryRun({ secrets, calls = [] }) {
  return (command, args, options = {}) => {
    assert.equal(command, "secret-tool");
    const action = args[0];
    const target = targetFromLinuxSecretToolArgs(args);
    calls.push({ action, target, args, options });
    if (action === "lookup") {
      return secrets.has(target)
        ? { status: 0, stdout: secrets.get(target) }
        : { status: 1, stdout: "" };
    }
    if (action === "store") {
      secrets.set(target, options.input);
      return { status: 0, stdout: "" };
    }
    if (action === "clear") {
      secrets.delete(target);
      return { status: 0, stdout: "" };
    }
    return { status: 2, stderr: `unsupported action ${action}` };
  };
}

function currentRegistryForCredentials(teams) {
  return {
    schema_version: "teami-team-registry/v1",
    teams: teams.map((team) => ({
      id: team.teamRef,
      status: "active",
      linear: {
        workspace_id: team.workspaceId,
        workspace_name: "Example Workspace",
        team_id: `linear-${team.teamRef}`,
        team_key: team.teamRef === "support-ops" ? "SUP" : "PRO",
        team_name: team.teamRef === "support-ops" ? "Support Ops" : "Product Ops",
        team_name_last_seen_at: "2026-07-15T12:00:00.000Z",
        provisioned_by_teami: true,
        webhook_id: null,
        cache_path: `teams/${team.teamRef}/linear.json`,
      },
      resources: [],
      policy_profile: "default",
      policy_overlay_ref: null,
    })),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createMacosSecurityMemoryRun({ secrets, calls = [] }) {
  return (command, args, options = {}) => {
    assert.equal(command, "security");
    const action = args[0];
    const target = targetFromMacosSecurityArgs(args);
    calls.push({ command, action, target, args, options });
    if (action === "find-generic-password") {
      return secrets.has(target)
        ? { status: 0, stdout: secrets.get(target) }
        : {
            status: 44,
            stdout: "",
            stderr: "The specified item could not be found in the keychain.",
          };
    }
    if (action === "add-generic-password") {
      secrets.set(target, options.input);
      return { status: 0, stdout: "" };
    }
    if (action === "delete-generic-password") {
      secrets.delete(target);
      return { status: 0, stdout: "" };
    }
    return { status: 2, stderr: `unsupported action ${action}` };
  };
}

function targetFromLinuxSecretToolArgs(args) {
  const serviceIndex = args.indexOf("service");
  assert.notEqual(serviceIndex, -1);
  return args[serviceIndex + 1];
}

function targetFromMacosSecurityArgs(args) {
  const serviceIndex = args.indexOf("-s");
  assert.notEqual(serviceIndex, -1);
  return args[serviceIndex + 1];
}
