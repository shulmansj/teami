import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  buildSessionStartRuntimeCommand,
  resolveRoleRuntimeAssignments,
} from "../src/runtime-adapters.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const SHELL_GRANT_TOKEN = /bash|powershell|pwsh|\bsh\b|--dangerously|shell/i;

function assertFlagValue(args, flag, expectedValue) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `${flag} must be present`);
  assert.equal(args[index + 1], expectedValue, `${flag} must be followed by ${JSON.stringify(expectedValue)}`);
}

function assertNoShellGrantTokens(command) {
  for (const arg of command.args) {
    assert.doesNotMatch(String(arg), SHELL_GRANT_TOKEN, `${command.runtime} arg must not grant shell tools: ${arg}`);
  }
}

test("tool-less command contract golden keeps pm Claude and sr_eng Codex session_start commands locked down", () => {
  const config = loadLinearConfig({ repoRoot });
  const assignments = resolveRoleRuntimeAssignments(config, "decomposition");
  const pmCommand = buildSessionStartRuntimeCommand({
    assignment: assignments.pm,
    prompt: "Return a PM subagent turn.",
    repoRoot,
  });
  const srEngCommand = buildSessionStartRuntimeCommand({
    assignment: assignments.sr_eng,
    prompt: "Return a Sr Eng subagent turn.",
    repoRoot,
  });

  assert.equal(pmCommand.command, "claude");
  assert.equal(pmCommand.mode, "session_start");
  assertFlagValue(pmCommand.args, "--allowedTools", "");
  assert.equal(path.basename(pmCommand.generation_schema_path), "subagent-turn.schema.json");
  assertNoShellGrantTokens(pmCommand);

  assert.equal(srEngCommand.command, "codex");
  assert.equal(srEngCommand.mode, "session_start");
  assertFlagValue(srEngCommand.args, "-s", "read-only");
  assert.equal(path.basename(srEngCommand.generation_schema_path), "subagent-turn.strict-generation.schema.json");
  assertNoShellGrantTokens(srEngCommand);
});
