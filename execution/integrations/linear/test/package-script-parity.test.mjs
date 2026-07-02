import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COMMAND_INDEX, normalizeCommandInvocation } from "../src/cli/dispatch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

// Scripts that legitimately do NOT invoke the CLI (checked as "not a registry command").
const NON_CLI_SCRIPTS = new Set([
  "security:secrets",
  "security:secrets:history",
  "security:secrets:seed",
  "validation:decomposition",
  "uat:gateway",
  "uat:github-local",
  "uat:no-hosted",
  "uat:execution",
  "uat:review",
  "uat:e2e-sandbox",
  "test",
]);

test("every package.json cli.mjs script resolves to a registry command", () => {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    if (body.includes("integrations/linear/cli.mjs")) {
      const tail = body.split(/cli\.mjs\s+/)[1] || "";
      const tokens = tail.trim().split(/\s+/).filter(Boolean);
      const command = tokens[0];
      const args = tokens.slice(1);
      const normalized = normalizeCommandInvocation({ command, args });
      assert.ok(
        COMMAND_INDEX.has(normalized.command),
        `npm script "${name}" (${body}) must resolve to a registry command; got "${normalized.command}"`,
      );
    } else {
      assert.ok(
        NON_CLI_SCRIPTS.has(name),
        `non-cli npm script "${name}" must be accounted for in NON_CLI_SCRIPTS`,
      );
    }
  }
});

test("the accounted-for non-cli scripts all still exist", () => {
  for (const name of NON_CLI_SCRIPTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(pkg.scripts, name),
      `non-cli script "${name}" is missing from package.json`,
    );
  }
});
