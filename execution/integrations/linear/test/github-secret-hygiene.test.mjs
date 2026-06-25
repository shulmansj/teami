import assert from "node:assert/strict";
import test from "node:test";

import {
  redactGitHubSecrets,
  scrubGitHubAuthEnv,
} from "../src/github-secret-hygiene.mjs";

test("redactGitHubSecrets redacts GitHub token values, bearer values, and auth env assignments", () => {
  const pat = "github_pat_" + "a".repeat(24);
  const classic = "ghp_" + "b".repeat(16);
  const oauthToken = "gho_" + "e".repeat(16);
  const userToken = "ghu_" + "f".repeat(16);
  const appToken = "ghs_" + "c".repeat(16);
  const bearer = "Bearer " + "d".repeat(24);
  const diagnostic = [
    `token=${pat}`,
    `classic ${classic}`,
    `oauth ${oauthToken}`,
    `user ${userToken}`,
    `app ${appToken}`,
    `authorization: ${bearer}`,
    `GH_TOKEN=${classic}`,
    `GITHUB_TOKEN="${pat}"`,
    "GIT_ASKPASS=/tmp/agentic-factory-askpass.sh",
  ].join("\n");

  const redacted = redactGitHubSecrets(diagnostic);

  assert.equal(redacted.includes(pat), false);
  assert.equal(redacted.includes(classic), false);
  assert.equal(redacted.includes(oauthToken), false);
  assert.equal(redacted.includes(userToken), false);
  assert.equal(redacted.includes(appToken), false);
  assert.equal(redacted.includes("d".repeat(24)), false);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /GH_TOKEN=\[redacted\]/);
  assert.match(redacted, /GITHUB_TOKEN="\[redacted\]"/);
  assert.match(redacted, /GIT_ASKPASS=\[redacted\]/);
});

test("scrubGitHubAuthEnv strips GitHub auth env without mutating the caller env", () => {
  const env = {
    PATH: "path-value",
    HOME: "home-value",
    GH_TOKEN: "gh-token",
    GITHUB_TOKEN: "github-token",
    GH_ENTERPRISE_TOKEN: "gh-enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "github-enterprise-token",
    AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN: "installation-token",
    GITHUB_ACCESS_TOKEN: "github-access-token",
    GITHUB_PAT: "github-pat",
    GIT_ASKPASS: "askpass-helper",
    SSH_AUTH_SOCK: "ssh-agent-sock",
  };
  const original = { ...env };

  const scrubbed = scrubGitHubAuthEnv(env);

  assert.deepEqual(env, original);
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN",
    "GITHUB_ACCESS_TOKEN",
    "GITHUB_PAT",
    "GIT_ASKPASS",
  ]) {
    assert.equal(Object.hasOwn(scrubbed, name), false, `${name} should be scrubbed`);
  }
  assert.equal(scrubbed.PATH, "path-value");
  assert.equal(scrubbed.HOME, "home-value");
  assert.equal(scrubbed.SSH_AUTH_SOCK, "ssh-agent-sock");
});

test("scrubGitHubAuthEnv preserves SSH_AUTH_SOCK for SSH push mode and scrubs it for HTTPS mode", () => {
  const env = {
    SSH_AUTH_SOCK: "ssh-agent-sock",
    GITHUB_TOKEN: "github-token",
  };

  const ssh = scrubGitHubAuthEnv(env, { pushAuth: "ssh" });
  const https = scrubGitHubAuthEnv(env, { pushAuth: "https" });

  assert.equal(ssh.SSH_AUTH_SOCK, "ssh-agent-sock");
  assert.equal(Object.hasOwn(ssh, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(https, "SSH_AUTH_SOCK"), false);
  assert.equal(Object.hasOwn(https, "GITHUB_TOKEN"), false);
});
