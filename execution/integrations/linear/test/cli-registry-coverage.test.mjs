import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateCommandDescriptor } from "../src/cli/command-registry.mjs";
import { COMMAND_REGISTRY } from "../src/cli/dispatch.mjs";

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "legacy-command-matrix.json"), "utf8"),
);

const tokenHandlers = new Map();
for (const descriptor of COMMAND_REGISTRY) {
  for (const token of [descriptor.invokeCommand, ...descriptor.aliases]) {
    if (!tokenHandlers.has(token)) tokenHandlers.set(token, new Set());
    tokenHandlers.get(token).add(descriptor.handler);
  }
}

test("every legacy command/alias is still routable with its original handler", () => {
  for (const { token, handler } of fixture.commandTable) {
    assert.ok(tokenHandlers.has(token), `legacy token ${token} must still route`);
    const handlers = tokenHandlers.get(token);
    assert.equal(handlers.size, 1, `${token} must map to exactly one handler`);
    assert.equal([...handlers][0].name, handler, `${token} must keep handler ${handler}`);
  }
});

test("registry descriptors validate and each token has one handler", () => {
  for (const descriptor of COMMAND_REGISTRY) validateCommandDescriptor(descriptor);
  for (const [token, handlers] of tokenHandlers) {
    assert.equal(handlers.size, 1, `token ${token} maps to ${handlers.size} handlers`);
  }
});
