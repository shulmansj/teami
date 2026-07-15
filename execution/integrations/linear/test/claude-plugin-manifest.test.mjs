import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const manifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");

test("Claude plugin manifest declares Teami metadata and stdio MCP server", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.name, "teami");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.author?.name, "Teami");

  assert.ok(manifest.mcpServers);
  assert.equal(typeof manifest.mcpServers, "object");

  const server = manifest.mcpServers.teami;
  assert.ok(server);
  assert.equal(server.command, "npx");
  assert.equal(server.args.length, 3);
  assert.equal(server.args[0], "-y");
  assert.equal(server.args[2], "mcp");
  if (fs.existsSync(path.join(repoRoot, "private", "publication"))) {
    assert.equal(
      server.args[1],
      "@shulmansj/teami@__TEAMI_VERSION__",
      "source manifest must keep the literal publish-time version token",
    );
  } else {
    assert.match(
      server.args[1],
      /^@shulmansj\/teami@\d+\.\d+\.\d+-sha[0-9a-f]{40}$/,
      "public manifest must pin the immutable package produced from its source commit",
    );
  }
  assert.equal(server.args.some((arg) => String(arg).includes("latest")), false);
  assert.equal(
    server.args.some((arg) => String(arg).includes("execution/integrations/linear/mcp-server.mjs")),
    false,
  );
  assert.equal(server.args.some((arg) => path.isAbsolute(String(arg))), false);
});

test("Claude plugin bundles the existing plan skill as /teami:plan", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const skillPath = path.join(repoRoot, "skills", "plan", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");

  assert.equal(manifest.name, "teami");
  assert.match(skill, /^name:\s*plan$/m);
  assert.match(skill, /^description:\s*Guide a Teami adopter through a \/plan session/m);
  assert.match(skill, /npx @shulmansj\/teami init/);
  assert.doesNotMatch(skill, /`teami init`/);
});
