import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildCommandIndex,
  validateCommandDescriptor,
} from "../src/cli/command-registry.mjs";
import { COMMAND_REGISTRY } from "../src/cli/dispatch.mjs";

function noopHandler() {}
function otherHandler() {}

test("valid command descriptors pass validation", () => {
  const adopterDescriptor = adopterCommandDescriptor();
  assert.equal(validateCommandDescriptor(adopterDescriptor), adopterDescriptor);

  const operatorDescriptor = {
    noun: "runtime-smoke",
    verb: null,
    acceptNounVerb: false,
    defaultForBareNoun: false,
    invokeCommand: "runtime-smoke",
    handler: noopHandler,
    tier: "operator",
    summary: "run the runtime smoke test",
    usageTail: "[--domain <id>]",
    aliases: [],
  };
  assert.equal(validateCommandDescriptor(operatorDescriptor), operatorDescriptor);
});

test("invalid command descriptors throw clear field errors", () => {
  assertInvalidDescriptor({ invokeCommand: undefined }, /invokeCommand/);
  assertInvalidDescriptor({ handler: undefined }, /handler/);
  assertInvalidDescriptor({ tier: "internal" }, /tier/);
  assertInvalidDescriptor({ helpGroup: undefined }, /helpGroup/);
  assertInvalidDescriptor({ helpOrder: undefined }, /helpOrder/);
  assertInvalidDescriptor({ consumeVerb: undefined }, /consumeVerb/);
});

test("buildCommandIndex rejects token collisions with different handlers", () => {
  assert.throws(() => buildCommandIndex([
    adopterCommandDescriptor({ invokeCommand: "gateway", handler: noopHandler }),
    adopterCommandDescriptor({ verb: "status", invokeCommand: "gateway", handler: otherHandler }),
  ]), /command registry token collision.*"gateway"/);
});

test("buildCommandIndex allows intentional duplicate tokens with the same handler", () => {
  const index = buildCommandIndex([
    adopterCommandDescriptor({ invokeCommand: "gateway", handler: noopHandler }),
    adopterCommandDescriptor({ verb: "status", invokeCommand: "gateway", handler: noopHandler }),
  ]);

  assert.equal(index.size, 1);
  assert.equal(index.get("gateway").handler, noopHandler);
});

test("buildCommandIndex builds the real registry index", () => {
  const index = buildCommandIndex(COMMAND_REGISTRY);

  assert.equal(index.size, 46);
  assert.equal(index.has("gateway:start"), false);
  assert.equal(index.has("gateway:status"), false);
});

test("frozen legacy command matrix fixture loads", () => {
  const fixturePath = path.join(import.meta.dirname, "fixtures", "legacy-command-matrix.json");
  const matrix = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(matrix.commandTable.length, 43);
  assert.ok(Object.keys(matrix.nounVerb).length > 0);
  assert.ok(Object.keys(matrix.bareNounActions).length > 0);
});

function adopterCommandDescriptor(overrides = {}) {
  return {
    noun: "gateway",
    verb: "start",
    acceptNounVerb: true,
    defaultForBareNoun: false,
    consumeVerb: true,
    invokeCommand: "gateway",
    handler: noopHandler,
    tier: "adopter",
    summary: "turn the factory on",
    usageTail: "",
    helpGroup: "Run",
    helpOrder: 1,
    aliases: [],
    ...overrides,
  };
}

function assertInvalidDescriptor(overrides, errorPattern) {
  assert.throws(() => {
    validateCommandDescriptor(adopterCommandDescriptor(overrides));
  }, errorPattern);
}
