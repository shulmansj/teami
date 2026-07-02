import test from "node:test";
import assert from "node:assert/strict";

import { formatCommand, humanizeInterval } from "../src/cli/operator-output.mjs";
import { factoryLauncherCommand } from "../src/cli/linear-setup-command.mjs";

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("formatCommand renders the POSIX launcher form on non-Windows", () => {
  withPlatform("darwin", () => {
    assert.equal(formatCommand(), "./teami");
    assert.equal(formatCommand("gateway start"), "./teami gateway start");
    assert.equal(formatCommand("doctor"), "./teami doctor");
  });
  withPlatform("linux", () => {
    assert.equal(formatCommand("init"), "./teami init");
  });
});

test("formatCommand renders the Windows launcher form on win32", () => {
  withPlatform("win32", () => {
    assert.equal(formatCommand(), ".\\teami.cmd");
    assert.equal(formatCommand("gateway start"), ".\\teami.cmd gateway start");
    assert.equal(formatCommand("doctor"), ".\\teami.cmd doctor");
  });
});

test("humanizeInterval renders the configured interval in plain English", () => {
  assert.equal(humanizeInterval(10_000), "10 seconds");
  assert.equal(humanizeInterval(1_000), "1 second");
  assert.equal(humanizeInterval(30_000), "30 seconds");
  assert.equal(humanizeInterval(90_000), "2 minutes");
  assert.equal(humanizeInterval(60_000), "1 minute");
});

test("factoryLauncherCommand is a back-compat alias for formatCommand", () => {
  assert.equal(factoryLauncherCommand, formatCommand);
  withPlatform("win32", () => {
    assert.equal(factoryLauncherCommand("gateway start"), ".\\teami.cmd gateway start");
  });
  withPlatform("darwin", () => {
    assert.equal(factoryLauncherCommand("gateway start"), "./teami gateway start");
  });
});
