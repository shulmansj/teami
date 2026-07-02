import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMMAND_REGISTRY } from "../src/cli/dispatch.mjs";

const here = import.meta.dirname;
const dispatchPath = path.resolve(here, "..", "src", "cli", "dispatch.mjs");
const cliPath = path.resolve(here, "..", "cli.mjs");
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "legacy-command-matrix.json"), "utf8"),
);

test("the five legacy command enumerations are retired (the registry is the sole source)", () => {
  const dispatchSrc = fs.readFileSync(dispatchPath, "utf8");
  for (const retired of ["COMMAND_TABLE", "NOUN_VERB_COMMANDS", "COMMAND_HELP", "ADOPTER_HELP_ITEMS"]) {
    assert.ok(!dispatchSrc.includes(retired), `legacy enumeration "${retired}" must be retired from dispatch.mjs`);
  }
  const cliSrc = fs.readFileSync(cliPath, "utf8");
  assert.ok(!cliSrc.includes("command ==="), "cli.mjs must be a dumb argv shim (no command=== whitelist)");
  assert.ok(dispatchSrc.includes("COMMAND_REGISTRY"), "COMMAND_REGISTRY must be the source of truth");
});

test("cli.mjs is a dumb argv shim that delegates to runCliCommand", () => {
  const cliSrc = fs.readFileSync(cliPath, "utf8");
  assert.match(cliSrc, /runCliCommand\(\{\s*repoRoot,\s*command,\s*args:\s*process\.argv\.slice\(3\)\s*\}\)/);
});

test("the command inventory covers every legacy command and alias", () => {
  const routable = new Set(COMMAND_REGISTRY.flatMap((d) => [d.invokeCommand, ...d.aliases]));
  const missing = fixture.commandTable.map((e) => e.token).filter((token) => !routable.has(token));
  assert.deepEqual(missing, [], `every legacy command/alias must be covered by the registry; missing: ${missing.join(", ")}`);
});
