import assert from "node:assert/strict";
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
    credentialTargetForConfig(config, "fixture-repo-a", domainA),
    credentialTargetForConfig(config, "fixture-repo-a", domainB),
  );
});

test("Same domain credential targets are stable across calls", () => {
  const config = loadLinearConfig({ repoRoot });
  const domain = {
    domainId: "support-ops",
    workspaceId: "workspace-a",
  };

  assert.equal(
    credentialTargetForConfig(config, "fixture-repo-a", domain),
    credentialTargetForConfig(config, "fixture-repo-a", domain),
  );
  assert.notEqual(
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
      credentialTargetForConfig(config, "fixture-repo-a", {
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
    () => credentialTargetForConfig(config, "fixture-repo-a"),
    /requires workspace_id and domain_id/,
  );
  assert.throws(
    () => credentialTargetForConfig(config, "fixture-repo-a", { domainId: "support-ops" }),
    /requires workspace_id/,
  );
  assert.throws(
    () => createLinearCredentialStore({ config, repoRoot: "fixture-repo-a" }),
    /requires workspace_id and domain_id/,
  );
});

test("file credential store is explicit, ignored-local, and round-trips token sets", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-linear-credential-"));
  const filePath = path.join(tempDir, ".agentic-factory", "linear-oauth-token.json");
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

test("Windows Credential Manager store passes secrets through stdin, not argv", async () => {
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
  await store.readTokenSet();
  await store.deleteTokenSet();

  assert.equal(calls[0].command, "powershell.exe");
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

test("macOS credential storage fails loudly until tokens can stay off argv", () => {
  assert.throws(
    () =>
      createOsCredentialStore({
        platform: "darwin",
        target: "target-mac",
        run: () => ({ status: 0, stdout: "" }),
      }),
    /without passing them on process argv/,
  );
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
