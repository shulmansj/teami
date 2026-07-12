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

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Two domains in different workspaces produce different Linear OAuth credential targets", () => {
  const config = loadLinearConfig({ repoRoot });
  const domainA = { domainId: "support-ops", workspaceId: "workspace-a" };
  const domainB = { domainId: "sales-ops", workspaceId: "workspace-b" };

  assert.notEqual(
    credentialTargetForConfig(config, domainA),
    credentialTargetForConfig(config, domainB),
  );
});

test("Same domain credential targets are stable across calls", () => {
  const config = loadLinearConfig({ repoRoot });
  const domain = {
    domainId: "support-ops",
    workspaceId: "workspace-a",
  };

  assert.equal(
    credentialTargetForConfig(config, domain),
    credentialTargetForConfig(config, domain),
  );
  assert.equal(
    credentialTargetForConfig(config, "fixture-repo-a", domain),
    credentialTargetForConfig(config, "fixture-repo-b", domain),
  );
});

test("Legacy-format detection fires on a synthesized old target", () => {
  const config = loadLinearConfig({ repoRoot });
  const oldOAuthTarget = legacyCredentialTargetForConfig(config, "fixture-repo-a");

  assert.equal(isLegacyCredentialTargetForConfig(oldOAuthTarget, config, "fixture-repo-a"), true);
  assert.equal(
    isLegacyCredentialTargetForConfig(
      credentialTargetForConfig(config, {
        domainId: "support-ops",
        workspaceId: "workspace-a",
      }),
      config,
      "fixture-repo-a",
    ),
    false,
  );
});

test("New-format credential target builders throw when domain or workspace ids are missing", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.throws(
    () => credentialTargetForConfig(config),
    /requires workspace_id and domain_id/,
  );
  assert.throws(
    () => credentialTargetForConfig(config, { domainId: "support-ops" }),
    /requires workspace_id/,
  );
  assert.throws(
    () => createLinearCredentialStore({ config, repoRoot: "fixture-repo-a" }),
    /requires workspace_id and domain_id/,
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
    domainId: "support-ops",
    workspaceId: "workspace-a",
  });
  const expectedPath = path.join(
    home,
    "credentials",
    "domains",
    "support-ops",
    "linear-oauth-token.json",
  );

  await store.writeTokenSet({ refreshToken: "refresh-home-file" });

  assert.equal(fs.existsSync(expectedPath), true);
  assert.match(fs.readFileSync(expectedPath, "utf8"), /refresh-home-file/);
  assert.equal(
    fs.existsSync(path.join(home, "checkout", ".teami", "domains", "support-ops", "linear-oauth-token.json")),
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

test("OS credential store lazily migrates the prior repo-root plus domain identity target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const domain = { domainId: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, domain);
  const legacyTarget = previousDomainCredentialTargetForConfig(config, legacyRepoRoot, domain);
  const secrets = new Map([
    [
      legacyTarget,
      serializeTokenSet({
        accessToken: "access-legacy-domain",
        refreshToken: "refresh-legacy-domain",
      }),
    ],
  ]);
  const calls = [];
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    domainContext: domain,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets, calls }),
  });

  assert.deepEqual(await store.readTokenSet(), {
    accessToken: "access-legacy-domain",
    refreshToken: "refresh-legacy-domain",
  });
  assert.equal(secrets.has(legacyTarget), false);
  assert.match(secrets.get(newTarget), /refresh-legacy-domain/);

  const callCountAfterMigration = calls.length;
  assert.equal((await store.readTokenSet()).refreshToken, "refresh-legacy-domain");
  assert.deepEqual(
    calls.slice(callCountAfterMigration).map((call) => `${call.action}:${call.target}`),
    [`lookup:${newTarget}`],
  );
});

test("OS credential store lazily migrates the older repo-root-only legacy target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const domain = { domainId: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, domain);
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
    domainContext: domain,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets, calls }),
  });

  assert.deepEqual(await store.readTokenSet(), {
    accessToken: "access-legacy-bootstrap",
    refreshToken: "refresh-legacy-bootstrap",
  });
  assert.equal(secrets.has(legacyTarget), false);
  assert.match(secrets.get(newTarget), /refresh-legacy-bootstrap/);
  assert.deepEqual(
    calls.map((call) => `${call.action}:${call.target}`),
    [
      `lookup:${newTarget}`,
      `lookup:${previousDomainCredentialTargetForConfig(config, legacyRepoRoot, domain)}`,
      `lookup:${legacyTarget}`,
      `store:${newTarget}`,
      `clear:${legacyTarget}`,
    ],
  );
});

test("fresh OS credential writes only the de-keyed target", async () => {
  const config = loadLinearConfig({ repoRoot });
  const legacyRepoRoot = "fixture-repo-a";
  const domain = { domainId: "support-ops", workspaceId: "workspace-a" };
  const newTarget = credentialTargetForConfig(config, domain);
  const secrets = new Map();
  const store = createLinearCredentialStore({
    config,
    repoRoot: legacyRepoRoot,
    domainContext: domain,
    platform: "linux",
    run: createLinuxSecretToolMemoryRun({ secrets }),
  });

  await store.writeTokenSet({ refreshToken: "refresh-new" });

  assert.deepEqual([...secrets.keys()], [newTarget]);
  assert.equal(
    secrets.has(previousDomainCredentialTargetForConfig(config, legacyRepoRoot, domain)),
    false,
  );
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

function previousDomainCredentialTargetForConfig(config, previousRepoRoot, domainIdentity) {
  const oauth = config?.linear?.oauth || {};
  const identity = [
    "teami-linear-oauth",
    oauth.client_id || "",
    oauth.redirect_uri || "",
    path.resolve(previousRepoRoot),
    `workspace_id:${domainIdentity.workspaceId}`,
    `domain_id:${domainIdentity.domainId}`,
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
