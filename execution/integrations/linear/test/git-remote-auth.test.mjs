import assert from "node:assert/strict";
import test from "node:test";

import {
  githubGitAuthorizationHeader,
  gitRemoteAuthEnv,
  looksLikeGitHubRemote,
  resolveAmbientGitHubToken,
  resolveGhCliToken,
} from "../../git/git-remote-auth.mjs";

const GITHUB_REMOTE = "https://github.com/acme/product.git";
const noGhToken = () => null;

test("githubGitAuthorizationHeader is Basic with the x-access-token username (never Bearer)", () => {
  const header = githubGitAuthorizationHeader("tok-123");
  assert.match(header, /^Authorization: Basic /);
  const encoded = header.slice("Authorization: Basic ".length);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "x-access-token:tok-123");
});

test("gitRemoteAuthEnv injects the header via GIT_CONFIG_* env and preserves the base env", () => {
  const env = gitRemoteAuthEnv({
    baseEnv: { GIT_TERMINAL_PROMPT: "0" },
    remoteUrl: GITHUB_REMOTE,
    token: "explicit-token",
    processEnv: {},
    resolveGhToken: noGhToken,
  });
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_0, githubGitAuthorizationHeader("explicit-token"));
});

test("gitRemoteAuthEnv resolution order: explicit token, then ambient env, then gh", () => {
  const ambient = { GH_TOKEN: "ambient-token" };
  const explicit = gitRemoteAuthEnv({
    remoteUrl: GITHUB_REMOTE,
    token: "explicit-token",
    processEnv: ambient,
    resolveGhToken: () => "gh-token",
  });
  assert.equal(explicit.GIT_CONFIG_VALUE_0, githubGitAuthorizationHeader("explicit-token"));

  const fromAmbient = gitRemoteAuthEnv({
    remoteUrl: GITHUB_REMOTE,
    processEnv: ambient,
    resolveGhToken: () => "gh-token",
  });
  assert.equal(fromAmbient.GIT_CONFIG_VALUE_0, githubGitAuthorizationHeader("ambient-token"));

  const fromGh = gitRemoteAuthEnv({
    remoteUrl: GITHUB_REMOTE,
    processEnv: {},
    resolveGhToken: () => "gh-token",
  });
  assert.equal(fromGh.GIT_CONFIG_VALUE_0, githubGitAuthorizationHeader("gh-token"));
});

test("gitRemoteAuthEnv leaves non-GitHub remotes untouched even when a token is available", () => {
  const env = gitRemoteAuthEnv({
    baseEnv: { GIT_TERMINAL_PROMPT: "0" },
    remoteUrl: "file:///tmp/offline-fixture.git",
    token: "explicit-token",
    processEnv: { GH_TOKEN: "ambient-token" },
    resolveGhToken: () => "gh-token",
  });
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: "0" });
});

test("gitRemoteAuthEnv without any resolvable token returns the base env unchanged", () => {
  const env = gitRemoteAuthEnv({
    baseEnv: { GIT_TERMINAL_PROMPT: "0" },
    remoteUrl: GITHUB_REMOTE,
    processEnv: {},
    resolveGhToken: noGhToken,
  });
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: "0" });
});

test("gitRemoteAuthEnv appends after existing GIT_CONFIG_* entries instead of clobbering them", () => {
  const env = gitRemoteAuthEnv({
    baseEnv: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "fixture",
    },
    remoteUrl: GITHUB_REMOTE,
    token: "explicit-token",
    processEnv: {},
    resolveGhToken: noGhToken,
  });
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(env.GIT_CONFIG_KEY_1, "http.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_1, githubGitAuthorizationHeader("explicit-token"));
});

test("looksLikeGitHubRemote accepts https and ssh github.com remotes only", () => {
  assert.equal(looksLikeGitHubRemote("https://github.com/acme/product.git"), true);
  assert.equal(looksLikeGitHubRemote("git@github.com:acme/product.git"), true);
  assert.equal(looksLikeGitHubRemote("https://gitlab.com/acme/product.git"), false);
  assert.equal(looksLikeGitHubRemote("file:///tmp/offline-fixture.git"), false);
  assert.equal(looksLikeGitHubRemote(null), false);
});

test("resolveAmbientGitHubToken honors the documented env-name order", () => {
  assert.equal(
    resolveAmbientGitHubToken({ GITHUB_TOKEN: "second", GH_TOKEN: "first" }),
    "first",
  );
  assert.equal(resolveAmbientGitHubToken({ GITHUB_PAT: "fallback" }), "fallback");
  assert.equal(resolveAmbientGitHubToken({}), null);
});

test("resolveGhCliToken uses the bounded auth-read operation and returns no failure output", async () => {
  const calls = [];
  assert.equal(await resolveGhCliToken({
    runSubprocess: async (input) => {
      calls.push(input);
      return { ok: true, stdout: "gho_token\n" };
    },
  }), "gho_token");
  assert.equal(calls[0].operation, "gh_auth_read");

  assert.equal(await resolveGhCliToken({
    runSubprocess: async () => ({
      ok: false,
      stdout: "",
      stderr: "[captured failure output redacted]",
    }),
  }), null);
});

test("sync git auth env never serializes an async token promise into credentials", () => {
  const env = gitRemoteAuthEnv({
    baseEnv: { GIT_TERMINAL_PROMPT: "0" },
    remoteUrl: "https://github.com/acme/repo.git",
    processEnv: {},
    resolveGhToken: async () => "gho_async",
  });
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: "0" });
  assert.equal(JSON.stringify(env).includes("Promise"), false);
});
