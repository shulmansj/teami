import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { doctorGraphqlLinear } from "../src/cli/doctor-command.mjs";
import { createSetupStateStore } from "../src/setup-orchestrator.mjs";

test("doctor stays red until interrupted admin authority is explicitly reconciled", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-doctor-admin-revoke-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createSetupStateStore({ home });
  store.markGlobalAdminRevocationRequired({ surface: "cli" });

  const blocked = await doctorGraphqlLinear({
    config: {},
    repoRoot: home,
    home,
    cachePath: path.join(home, "linear.json"),
  });
  const blockedCheck = blocked.find((check) => check.name === "one-time Linear admin revocation");
  assert.equal(blockedCheck.ok, false);
  assert.match(blockedCheck.message, /Settings -> Applications/);
  assert.match(blockedCheck.message, /fresh token cannot prove the lost token/i);

  assert.equal(store.clearGlobalAdminRevocationRequired({ revokeVerified: true }), true);
  const healthy = await doctorGraphqlLinear({
    config: {},
    repoRoot: home,
    home,
    cachePath: path.join(home, "linear.json"),
  });
  assert.equal(healthy.find((check) => check.name === "one-time Linear admin revocation").ok, true);
});

test("doctor uses the same exact Claude plugin identity and launch contract as setup", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-doctor-plugin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const healthyRunner = async (_command, args) => {
    if (args.join(" ") === "plugin marketplace list --json") {
      return { ok: true, status: 0, stdout: JSON.stringify([{
        name: "teami", source: "github", repo: "shulmansj/teami",
      }]), stderr: "" };
    }
    return { ok: true, status: 0, stdout: JSON.stringify({ plugins: [{
      id: "teami@teami",
      version: "0.3.20",
      scope: "user",
      enabled: true,
      mcpServers: { teami: { command: "npx", args: ["-y", "@shulmansj/teami@0.3.20", "mcp"] } },
    }] }), stderr: "" };
  };
  const healthy = await doctorGraphqlLinear({
    config: {}, repoRoot: home, home, cachePath: path.join(home, "linear.json"),
    claudePluginRunCommand: healthyRunner,
  });
  assert.equal(healthy.find((check) => check.name === "Claude plugin launch contract").ok, true);

  const collision = await doctorGraphqlLinear({
    config: {}, repoRoot: home, home, cachePath: path.join(home, "linear.json"),
    claudePluginRunCommand: async (_command, args) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return { ok: true, status: 0, stdout: JSON.stringify([{
          name: "teami", source: "github", repo: "attacker/teami",
        }]), stderr: "" };
      }
      throw new Error("plugin list must not run after a marketplace collision");
    },
  });
  const failed = collision.find((check) => check.name === "Claude plugin launch contract");
  assert.equal(failed.ok, false);
  assert.match(failed.message, /marketplace_source_mismatch/);
});
