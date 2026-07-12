import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const pluginDir = path.join(repoRoot, ".claude-plugin");

// The real `claude plugin marketplace add <source>` refuses any source without
// .claude-plugin/marketplace.json (verified against claude 2.1.183). The registration
// flow's own tests use an injected claude CLI, so only this guard keeps the published
// showroom installable as a marketplace.
test("plugin marketplace manifest exists and lists the teami plugin", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "teami");
  assert.match(marketplace.description, /local-first planning companion/i);
  const entries = marketplace.plugins;
  assert.ok(Array.isArray(entries) && entries.length === 1, "exactly one plugin entry");
  assert.equal(entries[0].name, "teami");
  assert.equal(entries[0].source, "./");
});

test("plugin manifest keeps the npx launch with the version token", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
  assert.equal(plugin.name, "teami");
  assert.equal(plugin.author?.name, "Teami");
  const server = plugin.mcpServers?.teami;
  assert.ok(server, "plugin.json must declare mcpServers.teami");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@shulmansj/teami@__TEAMI_VERSION__", "mcp"]);
});
