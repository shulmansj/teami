import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolvePackagedDefault,
  resolveTeamiHome,
  teamiHomePaths,
} from "../src/app-home.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

test("resolveTeamiHome honors absolute TEAMI_HOME and ignores a relative override", () => {
  assert.equal(
    resolveTeamiHome({
      env: { TEAMI_HOME: "/opt/teami", XDG_STATE_HOME: "/state" },
      platform: "linux",
      homedir: () => "/home/example",
    }),
    "/opt/teami",
  );

  assert.equal(
    resolveTeamiHome({
      env: { TEAMI_HOME: "~/custom-teami", XDG_STATE_HOME: "/state" },
      platform: "linux",
      homedir: () => "/home/example",
    }),
    "/home/example/custom-teami",
  );

  assert.equal(
    resolveTeamiHome({
      env: { TEAMI_HOME: "relative-teami", XDG_STATE_HOME: "/state" },
      platform: "linux",
      homedir: () => "/home/example",
    }),
    "/state/teami",
  );
});

test("resolveTeamiHome honors per-platform default precedence with platform-specific joins", () => {
  assert.equal(
    resolveTeamiHome({
      env: {},
      platform: "darwin",
      homedir: () => "/Users/example",
    }),
    path.posix.join("/Users/example", "Library", "Application Support", "teami"),
  );

  assert.equal(
    resolveTeamiHome({
      env: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
      },
      platform: "win32",
      homedir: () => "C:\\Users\\Ada",
    }),
    path.win32.join("C:\\Users\\Ada\\AppData\\Local", "teami"),
  );

  assert.equal(
    resolveTeamiHome({
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      platform: "win32",
      homedir: () => "C:\\Users\\Ada",
    }),
    path.win32.join("C:\\Users\\Ada\\AppData\\Roaming", "teami"),
  );

  assert.equal(
    resolveTeamiHome({
      env: {},
      platform: "win32",
      homedir: () => "C:\\Users\\Ada",
    }),
    path.win32.join("C:\\Users\\Ada", ".teami"),
  );

  assert.equal(
    resolveTeamiHome({
      env: { XDG_STATE_HOME: "/var/lib/teami-state" },
      platform: "linux",
      homedir: () => "/home/example",
    }),
    path.posix.join("/var/lib/teami-state", "teami"),
  );

  assert.equal(
    resolveTeamiHome({
      env: {},
      platform: "linux",
      homedir: () => "/home/example",
    }),
    path.posix.join("/home/example", ".local", "state", "teami"),
  );
});

test("teamiHomePaths composes root and per-domain layout and rejects invalid domain ids", () => {
  const home = "/home/example/.local/state/teami";

  assert.deepEqual(teamiHomePaths({ home }), {
    home,
    registryPath: path.posix.join(home, "domains.json"),
    gatewayLockPath: path.posix.join(home, "gateway.lock"),
    githubConnectionPath: path.posix.join(home, "github-connection.json"),
    behaviorMirrorDir: path.posix.join(home, "behavior-mirror"),
    runtimeDir: path.posix.join(home, "runtime"),
    phoenixDataDir: path.posix.join(home, "phoenix-data"),
    domainDir: null,
    domainCachePath: null,
  });

  assert.deepEqual(teamiHomePaths({ home, domainId: "support-ops" }), {
    home,
    registryPath: path.posix.join(home, "domains.json"),
    gatewayLockPath: path.posix.join(home, "gateway.lock"),
    githubConnectionPath: path.posix.join(home, "github-connection.json"),
    behaviorMirrorDir: path.posix.join(home, "behavior-mirror"),
    runtimeDir: path.posix.join(home, "runtime"),
    phoenixDataDir: path.posix.join(home, "phoenix-data"),
    domainDir: path.posix.join(home, "domains", "support-ops"),
    domainCachePath: path.posix.join(home, "domains", "support-ops", "linear.json"),
  });

  const winHome = path.win32.join("C:\\Users\\Ada\\AppData\\Local", "teami");
  assert.equal(
    teamiHomePaths({ home: winHome, domainId: "support-ops" }).domainCachePath,
    path.win32.join(winHome, "domains", "support-ops", "linear.json"),
  );

  assert.throws(
    () => teamiHomePaths({ home, domainId: "../support-ops" }),
    /invalid_domain_id:\.\.\/support-ops/,
  );
});

test("resolvePackagedDefault rejects absolute or traversing paths and resolves from the package root", () => {
  assert.equal(
    resolvePackagedDefault("execution/integrations/linear/config.package-default.json"),
    path.resolve(packageRoot, "execution/integrations/linear/config.package-default.json"),
  );

  assert.throws(
    () => resolvePackagedDefault(path.resolve(packageRoot, "package.json")),
    /packaged_default_path_must_be_relative/,
  );
  assert.throws(() => resolvePackagedDefault("../package.json"), /packaged_default_path_traversal/);
  assert.throws(() => resolvePackagedDefault("docs/../package.json"), /packaged_default_path_traversal/);
});

test("home and packaged-default resolution are independent of process.cwd()", () => {
  const originalCwd = process.cwd();
  const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), "teami-home-cwd-a-"));
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), "teami-home-cwd-b-"));

  function snapshot() {
    const home = resolveTeamiHome({
      env: { XDG_STATE_HOME: "/var/lib/teami-state" },
      platform: "linux",
      homedir: () => "/home/example",
    });
    return {
      home,
      paths: teamiHomePaths({ home, domainId: "support-ops" }),
      packagedDefault: resolvePackagedDefault("execution/integrations/linear/config.package-default.json"),
    };
  }

  try {
    process.chdir(firstCwd);
    const first = snapshot();
    process.chdir(secondCwd);
    assert.deepEqual(snapshot(), first);
  } finally {
    process.chdir(originalCwd);
  }
});
