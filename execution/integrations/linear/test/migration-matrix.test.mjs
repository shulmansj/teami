import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMMAND_INDEX, normalizeCommandInvocation } from "../src/cli/dispatch.mjs";

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "legacy-command-matrix.json"), "utf8"),
);

const S_INVOKE_HANDLERS = new Set([
  "runLocalSetupCleanupCommand",
  "runLinearSetupCommand",
  "runGatewayCommand",
  "runEvalRegisterPromptCommand",
]);

test("every legacy COMMAND_TABLE key resolves to the same handler (and same token for S-INVOKE)", () => {
  for (const { token, handler } of fixture.commandTable) {
    const d = COMMAND_INDEX.get(token);
    assert.ok(d, `legacy token "${token}" must still resolve`);
    assert.equal(d.handler.name, handler, `"${token}" must keep handler ${handler}`);
    if (S_INVOKE_HANDLERS.has(handler)) {
      assert.equal(d.invokeCommand, token, `S-INVOKE "${token}" must keep its exact invokeCommand token`);
    }
  }
});

test("both legacy normalizations preserve invokeCommand, verb-consumption, and handler", () => {
  for (const [noun, verbs] of Object.entries(fixture.nounVerb)) {
    for (const [verb, expected] of Object.entries(verbs)) {
      const norm = normalizeCommandInvocation({ command: noun, args: [verb] });
      assert.equal(norm.command, expected.invokeCommand, `"${noun} ${verb}" invokeCommand`);
      assert.deepEqual(norm.args, expected.consumeVerb ? [] : [verb], `"${noun} ${verb}" verb consumption`);

      const d = COMMAND_INDEX.get(norm.command);
      assert.ok(d, `"${noun} ${verb}" must resolve`);
      assert.equal(d.handler.name, expected.handler, `"${noun} ${verb}" handler ${expected.handler}`);
    }
  }
});

test("bare-noun default actions resolve to the same handler", () => {
  for (const [token, handler] of Object.entries(fixture.bareNounActions)) {
    const d = COMMAND_INDEX.get(token);
    assert.ok(d, `bare "${token}" must resolve`);
    assert.equal(d.handler.name, handler, `bare "${token}" handler ${handler}`);
  }
});
