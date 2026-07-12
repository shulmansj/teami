import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyEnvAugment,
  perRunTempEnvSubset,
  resolveRuntimeSpawnCommand,
  runRuntimeCommand,
  sanitizeRuntimeDiagnostic,
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "../src/runtime-command.mjs";

const EXPLICIT_WRITE_CREDENTIALS = [
  "TEAMI_GITHUB_INSTALLATION_TOKEN",
  "TEAMI_INBOX_SETUP_GRANT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_ACCESS_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
];

test("scrubChildEnv strips write credentials and preserves runtime essentials", () => {
  const env = {
    PATH: "path-value",
    HOME: "home-value",
    USERPROFILE: "userprofile-value",
    TEMP: "temp-value",
    TMP: "tmp-value",
    APPDATA: "appdata-value",
    SystemRoot: "systemroot-value",
    windir: "windir-value",
    CODEX_API_KEY: "codex-runtime-auth",
    CODEX_HOME: "codex-home",
    CLAUDE_API_KEY: "claude-runtime-auth",
    CLAUDE_CONFIG_DIR: "claude-config",
    ANTHROPIC_API_KEY: "anthropic-runtime-auth",
    TEAMI_GITHUB_INSTALLATION_TOKEN: "github-installation-token",
    TEAMI_INBOX_SETUP_GRANT: "setup-grant",
    GH_TOKEN: "gh-token",
    GITHUB_TOKEN: "github-token",
    GH_ENTERPRISE_TOKEN: "gh-enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "github-enterprise-token",
    GITHUB_ACCESS_TOKEN: "github-access-token",
    GITHUB_PAT: "github-pat",
    GIT_ASKPASS: "askpass-helper",
    GIT_SSH: "ssh-helper",
    GIT_SSH_COMMAND: "ssh-command",
    SSH_ASKPASS: "ssh-askpass-helper",
    SSH_AUTH_SOCK: "ssh-agent-sock",
    AF_LINEAR_ACCESS_TOKEN: "linear-access-token",
    AF_LINEAR_CREDENTIAL_TARGET: "linear-credential-target",
    LINEAR_API_KEY: "linear-api-key",
    LINEAR_ACCESS_TOKEN: "linear-access-token",
    LINEAR_CREDENTIAL: "linear-credential",
    linear_refresh_token: "lowercase-linear-token",
    LINEAR_TEAM_ID: "team-id",
    NPM_TOKEN: "npm-token",
    AWS_SECRET_ACCESS_KEY: "aws-secret-access-key",
    UNRELATED_VALUE: "keep-me",
  };
  const original = { ...env };

  const scrubbed = scrubChildEnv(env);

  assert.notEqual(scrubbed, env);
  assert.deepEqual(env, original);
  for (const name of [
    ...EXPLICIT_WRITE_CREDENTIALS,
    "AF_LINEAR_ACCESS_TOKEN",
    "AF_LINEAR_CREDENTIAL_TARGET",
    "LINEAR_API_KEY",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_CREDENTIAL",
    "linear_refresh_token",
    "NPM_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    assert.equal(Object.hasOwn(scrubbed, name), false, `${name} should be scrubbed`);
  }
  for (const [name, value] of Object.entries({
    PATH: "path-value",
    HOME: "home-value",
    USERPROFILE: "userprofile-value",
    TEMP: "temp-value",
    TMP: "tmp-value",
    APPDATA: "appdata-value",
    SystemRoot: "systemroot-value",
    windir: "windir-value",
    CODEX_API_KEY: "codex-runtime-auth",
    CODEX_HOME: "codex-home",
    CLAUDE_API_KEY: "claude-runtime-auth",
    CLAUDE_CONFIG_DIR: "claude-config",
    ANTHROPIC_API_KEY: "anthropic-runtime-auth",
    LINEAR_TEAM_ID: "team-id",
    UNRELATED_VALUE: "keep-me",
  })) {
    assert.equal(scrubbed[name], value, `${name} should be preserved`);
  }
  assert.deepEqual(runtimeCommandEnvironmentProof(scrubbed), {
    agent_write_credentials_present: false,
  });
  assert.deepEqual(runtimeCommandEnvironmentProof(env), {
    agent_write_credentials_present: true,
  });
});

test("scrubChildEnv does not mutate process.env", () => {
  const names = [
    "TEAMI_GITHUB_INSTALLATION_TOKEN",
    "AF_LINEAR_ENV_U1_TEST_TOKEN",
    "LINEAR_ENV_U1_TEST_TOKEN",
    "CODEX_ENV_U1_TEST_TOKEN",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TEAMI_GITHUB_INSTALLATION_TOKEN = "env-u1-github-token";
    process.env.AF_LINEAR_ENV_U1_TEST_TOKEN = "env-u1-af-linear-token";
    process.env.LINEAR_ENV_U1_TEST_TOKEN = "env-u1-linear-token";
    process.env.CODEX_ENV_U1_TEST_TOKEN = "env-u1-codex-token";

    const scrubbed = scrubChildEnv(process.env);

    assert.equal(process.env.TEAMI_GITHUB_INSTALLATION_TOKEN, "env-u1-github-token");
    assert.equal(process.env.AF_LINEAR_ENV_U1_TEST_TOKEN, "env-u1-af-linear-token");
    assert.equal(process.env.LINEAR_ENV_U1_TEST_TOKEN, "env-u1-linear-token");
    assert.equal(process.env.CODEX_ENV_U1_TEST_TOKEN, "env-u1-codex-token");
    assert.equal(Object.hasOwn(scrubbed, "TEAMI_GITHUB_INSTALLATION_TOKEN"), false);
    assert.equal(Object.hasOwn(scrubbed, "AF_LINEAR_ENV_U1_TEST_TOKEN"), false);
    assert.equal(Object.hasOwn(scrubbed, "LINEAR_ENV_U1_TEST_TOKEN"), false);
    assert.equal(scrubbed.CODEX_ENV_U1_TEST_TOKEN, "env-u1-codex-token");
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("applyEnvAugment evicts case-variant host names on win32 and leaves posix names alone", () => {
  const base = { Temp: "host-temp-case-variant", TMP: "host-tmp", PATH: "keep-me" };
  const augment = { TEMP: "engine-run-temp", TMP: "engine-run-temp" };

  const win32 = applyEnvAugment(base, augment, { platform: "win32" });
  assert.equal(win32.TEMP, "engine-run-temp");
  assert.equal(win32.TMP, "engine-run-temp");
  assert.equal(Object.hasOwn(win32, "Temp"), false);
  assert.equal(win32.PATH, "keep-me");

  const posix = applyEnvAugment(base, augment, { platform: "linux" });
  assert.equal(posix.Temp, "host-temp-case-variant");
  assert.equal(posix.TEMP, "engine-run-temp");
  assert.equal(posix.TMP, "engine-run-temp");
});

test("perRunTempEnvSubset picks only the per-run temp names off a worker env augment", () => {
  assert.deepEqual(
    perRunTempEnvSubset({
      HOME: "/contained/home",
      TMPDIR: "/run/tmp",
      TMP: "/run/tmp",
      TEMP: "/run/tmp",
    }),
    { TMPDIR: "/run/tmp", TMP: "/run/tmp", TEMP: "/run/tmp" },
  );
  assert.deepEqual(perRunTempEnvSubset({ HOME: "/contained/home" }), {});
  assert.deepEqual(perRunTempEnvSubset(), {});
});

test("runRuntimeCommand spawns with the scrubbed child environment and proof signal", async () => {
  const env = spawnBaseEnv({
    APPDATA: path.join(os.tmpdir(), "env-u1-appdata"),
    TEAMI_GITHUB_INSTALLATION_TOKEN: "github-installation-token",
    GITHUB_TOKEN: "github-token",
    SSH_ASKPASS: "ssh-askpass-helper",
    SSH_AUTH_SOCK: "ssh-agent-sock",
    AF_LINEAR_ACCESS_TOKEN: "linear-access-token",
    LINEAR_ACCESS_TOKEN: "linear-access-token",
    NPM_TOKEN: "npm-token",
    CODEX_ENV_U1_TEST_TOKEN: "codex-runtime-auth",
    CLAUDE_ENV_U1_TEST_TOKEN: "claude-runtime-auth",
    ANTHROPIC_ENV_U1_TEST_TOKEN: "anthropic-runtime-auth",
  });
  const original = { ...env };

  const result = await runRuntimeCommand(
    {
      command: "runtime-env-check",
      args: ["--print-env"],
    },
    {
      env,
      includeEnvironmentProof: true,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        stdout: ({ options }) => {
          const names = [
            "APPDATA",
            "TEAMI_GITHUB_INSTALLATION_TOKEN",
            "GITHUB_TOKEN",
            "SSH_ASKPASS",
            "SSH_AUTH_SOCK",
            "AF_LINEAR_ACCESS_TOKEN",
            "LINEAR_ACCESS_TOKEN",
            "NPM_TOKEN",
            "CODEX_ENV_U1_TEST_TOKEN",
            "CLAUDE_ENV_U1_TEST_TOKEN",
            "ANTHROPIC_ENV_U1_TEST_TOKEN",
          ];
          const seen = {};
          for (const name of names) seen[name] = options.env[name] ?? null;
          return JSON.stringify(seen);
        },
      }),
    },
  );

  assert.deepEqual(env, original);
  assert.deepEqual(result.environment, {
    agent_write_credentials_present: false,
  });
  assert.deepEqual(JSON.parse(result.output), {
    APPDATA: env.APPDATA,
    TEAMI_GITHUB_INSTALLATION_TOKEN: null,
    GITHUB_TOKEN: null,
    SSH_ASKPASS: null,
    SSH_AUTH_SOCK: null,
    AF_LINEAR_ACCESS_TOKEN: null,
    LINEAR_ACCESS_TOKEN: null,
    NPM_TOKEN: null,
    CODEX_ENV_U1_TEST_TOKEN: "codex-runtime-auth",
    CLAUDE_ENV_U1_TEST_TOKEN: "claude-runtime-auth",
    ANTHROPIC_ENV_U1_TEST_TOKEN: "anthropic-runtime-auth",
  });
});

test("runRuntimeCommand passes cwd through while preserving child env scrubbing", async () => {
  const env = spawnBaseEnv({
    TEAMI_GITHUB_INSTALLATION_TOKEN: "github-installation-token",
    GITHUB_TOKEN: "github-token",
    CODEX_ENV_U1_TEST_TOKEN: "codex-runtime-auth",
  });
  const boundCwd = path.join(os.tmpdir(), "bound-product-repo");
  const parentCwd = process.cwd();
  let spawnCall = null;

  const output = await runRuntimeCommand(
    {
      command: "runtime-cwd-check",
      args: ["--cwd"],
    },
    {
      env,
      cwd: boundCwd,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
        stdout: ({ options }) =>
          JSON.stringify({
            cwd: options.cwd ?? null,
            githubInstallationToken: options.env.TEAMI_GITHUB_INSTALLATION_TOKEN ?? null,
            githubToken: options.env.GITHUB_TOKEN ?? null,
            codexRuntimeToken: options.env.CODEX_ENV_U1_TEST_TOKEN ?? null,
          }),
      }),
    },
  );

  assert.equal(process.cwd(), parentCwd);
  assert.equal(spawnCall.options.cwd, boundCwd);
  assert.deepEqual(JSON.parse(output), {
    cwd: boundCwd,
    githubInstallationToken: null,
    githubToken: null,
    codexRuntimeToken: "codex-runtime-auth",
  });

  let inheritedSpawnCall = null;
  await runRuntimeCommand(
    {
      command: "runtime-inherit-cwd-check",
      args: [],
    },
    {
      env,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          inheritedSpawnCall = call;
        },
      }),
    },
  );

  assert.equal(inheritedSpawnCall.options.cwd, undefined);
});

test("runRuntimeCommand writes stdinInput and cleans generated prompt temp paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-runtime-prompt-"));
  fs.writeFileSync(path.join(tempDir, "prompt.md"), "prompt on disk", "utf8");
  let spawnCall = null;

  const output = await runRuntimeCommand(
    {
      command: "runtime-stdin-check",
      args: ["exec", "--output-schema", "schema.json"],
      stdinInput: "large runtime prompt",
      cleanup_paths: [tempDir],
    },
    {
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
        stdout: (call) => JSON.stringify({
          stdin: call.stdin,
          stdinEnded: call.stdinEnded === true,
        }),
      }),
    },
  );

  assert.deepEqual(JSON.parse(output), {
    stdin: "large runtime prompt",
    stdinEnded: true,
  });
  assert.deepEqual(spawnCall.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawnCall.args.includes("large runtime prompt"), false);
  assert.equal(fs.existsSync(tempDir), false);
});

test("runRuntimeCommand preserves APPDATA for simulated win32 Codex shim resolution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-codex-shim-"));
  const codexBin = path.join(tempDir, "npm", "node_modules", "@openai", "codex", "bin");
  fs.mkdirSync(codexBin, { recursive: true });
  const codexJs = path.join(codexBin, "codex.js");
  fs.writeFileSync(
    codexJs,
    "process.stdout.write(JSON.stringify({ appdata: process.env.APPDATA || null, askpass: process.env.GIT_ASKPASS || null }));\n",
    "utf8",
  );
  const env = spawnBaseEnv({
    APPDATA: tempDir,
    GIT_ASKPASS: "askpass-helper",
    AF_LINEAR_ACCESS_TOKEN: "linear-access-token",
  });

  const resolved = resolveRuntimeSpawnCommand("codex", ["exec", "prompt"], {
    platform: "win32",
    env: scrubChildEnv(env),
    nodePath: process.execPath,
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [codexJs, "exec", "prompt"]);

  let spawnCall = null;
  const result = await runRuntimeCommand(
    { command: "codex", args: ["exec", "prompt"] },
    {
      env,
      platform: "win32",
      nodePath: process.execPath,
      includeEnvironmentProof: true,
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
        stdout: ({ options }) =>
          JSON.stringify({
            appdata: options.env.APPDATA || null,
            askpass: options.env.GIT_ASKPASS || null,
          }),
      }),
    },
  );

  assert.equal(spawnCall.command, process.execPath);
  assert.deepEqual(spawnCall.args, [codexJs, "exec", "prompt"]);
  assert.deepEqual(result.environment, {
    agent_write_credentials_present: false,
  });
  assert.deepEqual(JSON.parse(result.output), {
    appdata: tempDir,
    askpass: null,
  });
});

test("runRuntimeCommand resolves the codex shim from the host APPDATA while the child sees the redirected per-run roots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-codex-shim-redirect-"));
  const codexBin = path.join(tempDir, "npm", "node_modules", "@openai", "codex", "bin");
  fs.mkdirSync(codexBin, { recursive: true });
  const codexJs = path.join(codexBin, "codex.js");
  fs.writeFileSync(codexJs, "", "utf8");
  const env = spawnBaseEnv({ APPDATA: tempDir });
  const redirectedRoaming = path.join(tempDir, "per-run-profile", "AppData", "Roaming");
  const redirectedLocal = path.join(tempDir, "per-run-profile", "AppData", "Local");

  let spawnCall = null;
  const output = await runRuntimeCommand(
    { command: "codex", args: ["exec", "prompt"] },
    {
      env,
      platform: "win32",
      nodePath: process.execPath,
      envAugment: { APPDATA: redirectedRoaming, LOCALAPPDATA: redirectedLocal },
      timeoutMs: 5_000,
      spawnImpl: fakeSpawn({
        onSpawn: (call) => {
          spawnCall = call;
        },
        stdout: ({ options }) =>
          JSON.stringify({
            appdata: options.env.APPDATA || null,
            localAppdata: options.env.LOCALAPPDATA || null,
          }),
      }),
    },
  );

  assert.equal(spawnCall.command, process.execPath, "the host's codex install stays resolvable under a redirected child APPDATA");
  assert.deepEqual(spawnCall.args, [codexJs, "exec", "prompt"]);
  assert.deepEqual(JSON.parse(output), {
    appdata: redirectedRoaming,
    localAppdata: redirectedLocal,
  });
});

test("resolveRuntimeSpawnCommand resolves npm to node + npm-cli.js on win32 (spawn cannot exec .cmd shims)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-npm-shim-"));
  const fakeNodePath = path.join(tempDir, "node.exe");
  fs.writeFileSync(fakeNodePath, "", "utf8");
  const npmBin = path.join(tempDir, "node_modules", "npm", "bin");
  fs.mkdirSync(npmBin, { recursive: true });
  const npmCliJs = path.join(npmBin, "npm-cli.js");
  fs.writeFileSync(npmCliJs, "", "utf8");

  const resolved = resolveRuntimeSpawnCommand("npm", ["install"], {
    platform: "win32",
    env: {},
    nodePath: fakeNodePath,
  });
  assert.equal(resolved.command, fakeNodePath);
  assert.deepEqual(resolved.args, [npmCliJs, "install"]);

  // Non-win32 (or npm-cli.js absent) stays untouched.
  const untouched = resolveRuntimeSpawnCommand("npm", ["install"], {
    platform: "linux",
    env: {},
    nodePath: fakeNodePath,
  });
  assert.deepEqual(untouched, { command: "npm", args: ["install"] });
});

test("runRuntimeCommand returns clean stdout by default and exposes both streams via includeStreams", async () => {
  const sessionId = "019f2fa3-9a55-70c3-adda-01cfe085f2bb";
  const spawnImpl = () => fakeSpawn({
    stdout: JSON.stringify({ ok: true }),
    stderr: `OpenAI Codex v0.141.0\nsession id: ${sessionId}`,
  });

  const plain = await runRuntimeCommand(
    { command: "runtime-success", args: [] },
    { timeoutMs: 5_000, spawnImpl: spawnImpl() },
  );
  assert.equal(plain, "{\"ok\":true}", "default output stays CLEAN stdout (strict turn validation parses it)");

  const withStreams = await runRuntimeCommand(
    { command: "runtime-success", args: [] },
    { timeoutMs: 5_000, includeStreams: true, spawnImpl: spawnImpl() },
  );
  assert.equal(withStreams.output, "{\"ok\":true}", "output stays clean with includeStreams too");
  assert.match(
    withStreams.stderr,
    new RegExp(`session id: ${sessionId}`),
    "the codex >=0.141.0 stderr banner (session id) is available to callers",
  );
});

test("runtime command failures redact token-shaped stderr before surfacing errors", async () => {
  const openAiToken = ["sk", "-", "testsecret123456789"].join("");
  const githubToken = ["gh", "p_", "secret123456789"].join("");
  const diagnostic = sanitizeRuntimeDiagnostic(
    `OPENAI_API_KEY=${openAiToken} GITHUB_TOKEN=${githubToken} token: linear-secret`,
  );
  assert.equal(
    diagnostic,
    "OPENAI_API_KEY=[redacted] GITHUB_TOKEN=[redacted] token: [redacted]",
  );

  await assert.rejects(
    () =>
      runRuntimeCommand(
        {
          command: "runtime-failure",
          args: [],
        },
        {
          timeoutMs: 5_000,
          spawnImpl: fakeSpawn({
            stderr: `OPENAI_API_KEY=${openAiToken}`,
            code: 7,
          }),
        },
      ),
    (error) => {
      assert.match(error.message, /Runtime command failed/);
      assert.match(error.message, /OPENAI_API_KEY=\[redacted\]/);
      assert.equal(error.message.includes(openAiToken), false);
      assert.equal(error.failure_code, "process_failed");
      assert.equal(error.exit, 7);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, `OPENAI_API_KEY=${openAiToken}`);
      return true;
    },
  );
});

test("runRuntimeCommand enriches timeout, max-output, and start failures", async () => {
  await assert.rejects(
    () =>
      runRuntimeCommand(
        {
          command: "runtime-timeout",
          args: [],
        },
        {
          timeoutMs: 1,
          spawnImpl: fakeSpawn({ stayOpen: true }),
        },
      ),
    (error) => {
      assert.match(error.message, /Runtime command timed out/);
      assert.equal(error.failure_code, "timed_out");
      assert.equal(error.exit, null);
      assert.equal(error.signal, null);
      assert.equal(typeof error.stdout, "string");
      assert.equal(typeof error.stderr, "string");
      return true;
    },
  );

  await assert.rejects(
    () =>
      runRuntimeCommand(
        {
          command: "runtime-max-output",
          args: [],
        },
        {
          timeoutMs: 5_000,
          maxOutputBytes: 3,
          spawnImpl: fakeSpawn({ stdout: "abcdef" }),
        },
      ),
    (error) => {
      assert.match(error.message, /Runtime command exceeded 3 output bytes/);
      assert.equal(error.failure_code, "process_failed");
      assert.equal(error.exit, null);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "abcdef");
      assert.equal(error.stderr, "");
      return true;
    },
  );

  await assert.rejects(
    () =>
      runRuntimeCommand(
        { command: "definitely-not-a-runtime-command-for-teami", args: [] },
        {
          timeoutMs: 5_000,
          spawnImpl: fakeSpawn({ error: new Error("not found") }),
        },
      ),
    (error) => {
      assert.match(error.message, /Runtime command could not start/);
      assert.equal(error.failure_code, "could_not_start");
      assert.equal(error.exit, null);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    },
  );

  await assert.rejects(
    () =>
      runRuntimeCommand(
        { command: "sync-start-failure", args: [] },
        {
          timeoutMs: 5_000,
          spawnImpl: () => {
            throw new Error("spawn EPERM");
          },
        },
      ),
    (error) => {
      assert.match(error.message, /Runtime command could not start sync-start-failure: spawn EPERM/);
      assert.equal(error.failure_code, "could_not_start");
      assert.equal(error.exit, null);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    },
  );
});

function fakeSpawn({
  stdout = "",
  stderr = "",
  code = 0,
  signal = null,
  error = null,
  stayOpen = false,
  onSpawn = () => {},
} = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { command, args, options, stdin: "", stdinEnded: false };
    child.stdin = new EventEmitter();
    child.stdin.write = (chunk) => {
      call.stdin += chunk.toString("utf8");
    };
    child.stdin.end = () => {
      call.stdinEnded = true;
    };
    child.kill = () => {
      child.killed = true;
    };

    onSpawn(call);
    setImmediate(() => {
      const stdoutText = typeof stdout === "function" ? stdout(call) : stdout;
      const stderrText = typeof stderr === "function" ? stderr(call) : stderr;
      if (stdoutText) child.stdout.emit("data", Buffer.from(stdoutText, "utf8"));
      if (stderrText) child.stderr.emit("data", Buffer.from(stderrText, "utf8"));
      if (error) {
        child.emit("error", error);
        return;
      }
      if (!stayOpen) child.emit("close", code, signal);
    });
    return child;
  };
}

function spawnBaseEnv(overrides = {}) {
  const base = {
    HOME: os.tmpdir(),
    USERPROFILE: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  for (const name of ["PATH", "Path", "SystemRoot", "windir"]) {
    if (process.env[name]) base[name] = process.env[name];
  }
  return { ...base, ...overrides };
}
