import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertRunnableHostedSetupConfig, loadLinearConfig } from "../src/config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const configExamplePath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
const publicHostedSetupProjectRef = ["ayhmwtwj", "thnjziwybtsu"].join("");
const publicHostedSetupHost = [publicHostedSetupProjectRef, "supabase", "co"].join(".");
const reservedHostedSetupHost = "public-hosted-setup.agentic-factory.invalid";
const privateProductHandle = ["zan", "zibar"].join("");
const privateRepoDefault = ["shulmansj", privateProductHandle].join("/");
const privateRepoUrlDefault = `https://github.com/${privateRepoDefault}`;
const sandboxLabel = ["internal", ["U", "A", "T"].join("")].join("/");
const sandboxHost = ["https://", "u", "a", "t", ".agentic-factory.invalid"].join("");
const maintainerLocalPath = ["C:", "Users", "Example"].join("\\");

const publicConfigSurfaces = Object.freeze([
  Object.freeze({
    label: "execution/integrations/linear/config.example.json",
    path: configExamplePath,
  }),
]);

const forbiddenPublicConfigPatterns = Object.freeze([
  Object.freeze({
    id: "private_repo_default",
    pattern: new RegExp(escapeRegExp(privateRepoDefault), "i"),
  }),
  Object.freeze({
    id: "private_repo_url_default",
    pattern: new RegExp(escapeRegExp(privateRepoUrlDefault), "i"),
  }),
  Object.freeze({
    id: "private_product_handle",
    pattern: new RegExp(`\\b${escapeRegExp(privateProductHandle)}\\b`, "i"),
  }),
  Object.freeze({
    id: "private_sandbox_label",
    pattern: new RegExp(`${escapeRegExp(sandboxLabel)}|\\b${["u", "a", "t"].join("")}\\b`, "i"),
  }),
  Object.freeze({
    id: "maintainer_local_path",
    pattern: new RegExp(escapeRegExp(maintainerLocalPath), "i"),
  }),
]);

test("public config surfaces do not include private repo defaults", () => {
  for (const surface of publicConfigSurfaces) {
    const text = fs.readFileSync(surface.path, "utf8");
    assertPublicConfigTextIsClean(surface.label, text);
  }
});

test("public config leak gate rejects known private repo and local handles", () => {
  for (const [label, value] of [
    ["private repo shorthand", privateRepoDefault],
    ["private repo URL", privateRepoUrlDefault],
    ["private product handle", privateProductHandle],
    ["private sandbox label", sandboxLabel],
    ["private sandbox URL", `${sandboxHost}/functions/v1/agentic-factory-inbox`],
    ["maintainer local path", maintainerLocalPath],
  ]) {
    assert.throws(
      () => assertPublicConfigTextIsClean(label, JSON.stringify({ value })),
      /public_config_forbidden_handle/,
      `${label} should be rejected`,
    );
  }
});

test("public config uses the live hosted setup public beta endpoint", () => {
  const config = loadLinearConfig({ repoRoot });

  assertHostedUrl(config.inbox.base_url, "/functions/v1/agentic-factory-inbox");
  assertHostedUrl(config.inbox.webhook_url, "/functions/v1/agentic-factory-inbox/v1/webhooks/linear");
  assertHostedUrl(config.inbox.dashboard_url, "/functions/v1/agentic-factory-inbox/status");
  assertHostedUrl(config.github.token_broker.base_url, "/functions/v1/agentic-factory-github-broker");
});

test("public hosted setup preflight accepts the checked-in live endpoint", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.equal(assertRunnableHostedSetupConfig(config, "public config"), true);
});

test("reserved hosted URLs are rejected before setup side effects", () => {
  const config = loadLinearConfig({ repoRoot });
  const reserved = JSON.parse(JSON.stringify(config));
  reserved.inbox.base_url = `https://${reservedHostedSetupHost}/functions/v1/agentic-factory-inbox`;
  reserved.inbox.webhook_url =
    `https://${reservedHostedSetupHost}/functions/v1/agentic-factory-inbox/v1/webhooks/linear`;
  reserved.inbox.dashboard_url = `https://${reservedHostedSetupHost}/functions/v1/agentic-factory-inbox/status`;
  reserved.github.token_broker.base_url =
    `https://${reservedHostedSetupHost}/functions/v1/agentic-factory-github-broker`;

  assert.throws(
    () => assertRunnableHostedSetupConfig(reserved, "reserved config"),
    /hosted_setup_url_not_runnable: reserved config uses reserved \.invalid hosted setup URL/,
  );
});

test("runnable hosted setup preflight accepts real HTTPS hosts", () => {
  const config = loadLinearConfig({ repoRoot });
  const runnable = JSON.parse(JSON.stringify(config));
  runnable.inbox.base_url = "https://setup.agentic-factory.example/functions/v1/agentic-factory-inbox";
  runnable.inbox.webhook_url =
    "https://setup.agentic-factory.example/functions/v1/agentic-factory-inbox/v1/webhooks/linear";
  runnable.inbox.dashboard_url =
    "https://setup.agentic-factory.example/functions/v1/agentic-factory-inbox/status";
  runnable.github.token_broker.base_url =
    "https://setup.agentic-factory.example/functions/v1/agentic-factory-github-broker";

  assert.equal(assertRunnableHostedSetupConfig(runnable, "runnable config"), true);
});

test("public config separates behavior-repo GitHub setup from domain git repo binding", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.equal(Object.hasOwn(config.github, "behavior_repo"), true);
  assert.equal(config.github.behavior_repo.owner, null);
  assert.equal(config.github.behavior_repo.name, "agentic-factory");
  assert.equal(config.github.behavior_repo.visibility, "private");
  assert.equal(Object.hasOwn(config.github, "token_broker"), true);
  assert.equal(Object.hasOwn(config.github, "git_repo"), false);
  assert.equal(Object.hasOwn(config, "git_repo"), false);
  assert.deepEqual(config.github.starter_remote_urls, ["https://github.com/shulmansj/agentic-factory"]);
  assert.equal(config.github.starter_remote_urls.includes(privateRepoUrlDefault), false);
});

function assertPublicConfigTextIsClean(label, text) {
  const hits = publicConfigForbiddenHits(text);
  if (hits.length > 0) {
    throw new Error(`public_config_forbidden_handle:${label}:${hits.map((hit) => hit.id).join(",")}`);
  }
}

function publicConfigForbiddenHits(text) {
  const normalizedText = text.replaceAll("\\\\", "\\");
  return forbiddenPublicConfigPatterns
    .filter(({ pattern }) => pattern.test(text) || pattern.test(normalizedText))
    .map(({ id }) => ({ id }));
}

function assertHostedUrl(value, expectedPath) {
  const parsed = new URL(value);
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, publicHostedSetupHost);
  assert.equal(parsed.pathname, expectedPath);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
