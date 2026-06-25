import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  loadLinearConfig,
  validateLinearConfig,
} from "../src/config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const configExamplePath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
const privateProductHandle = ["zan", "zibar"].join("");
const privateRepoDefault = ["shulmansj", privateProductHandle].join("/");
const privateRepoUrlDefault = `https://github.com/${privateRepoDefault}`;
const sandboxLabel = ["internal", ["U", "A", "T"].join("")].join("/");
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
    ["maintainer local path", maintainerLocalPath],
  ]) {
    assert.throws(
      () => assertPublicConfigTextIsClean(label, JSON.stringify({ value })),
      /public_config_forbidden_handle/,
      `${label} should be rejected`,
    );
  }
});

test("public config loads with local-only trigger and GitHub setup surfaces", () => {
  const loaded = loadLinearConfig({ repoRoot });

  assert.equal(Object.hasOwn(loaded, "inbox"), false);
  assert.equal(Object.hasOwn(loaded.github, "app_slug"), false);
  assert.equal(Object.hasOwn(loaded.github, "app_id"), false);
  assert.equal(Object.hasOwn(loaded.github, ["token", "broker"].join("_")), false);
  assert.equal(loaded.poll.interval_ms, DEFAULT_POLL_INTERVAL_MS);
});

test("poll interval config defaults and validates the single public knob", () => {
  const config = readJson(configExamplePath);
  assert.equal(config.poll.interval_ms, DEFAULT_POLL_INTERVAL_MS);

  const defaulted = readJson(configExamplePath);
  delete defaulted.poll;
  assert.equal(validateLinearConfig(defaulted, "test-config", { repoRoot }), true);
  assert.equal(defaulted.poll.interval_ms, DEFAULT_POLL_INTERVAL_MS);

  const tooFast = readJson(configExamplePath);
  tooFast.poll.interval_ms = MIN_POLL_INTERVAL_MS - 1;
  assert.throws(
    () => validateLinearConfig(tooFast, "test-config", { repoRoot }),
    /poll\.interval_ms must be at least/,
  );

  const nonInteger = readJson(configExamplePath);
  nonInteger.poll.interval_ms = "10000";
  assert.throws(
    () => validateLinearConfig(nonInteger, "test-config", { repoRoot }),
    /poll\.interval_ms must be an integer/,
  );

  const extraKnob = readJson(configExamplePath);
  extraKnob.poll.backoff_ms = 30_000;
  assert.throws(
    () => validateLinearConfig(extraKnob, "test-config", { repoRoot }),
    /unsupported poll config field\(s\): poll\.backoff_ms/,
  );
});

test("public config separates behavior-repo GitHub setup from domain git repo binding", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.equal(Object.hasOwn(config.github, "behavior_repo"), true);
  assert.equal(config.github.behavior_repo.owner, null);
  assert.equal(config.github.behavior_repo.name, "agentic-factory");
  assert.equal(config.github.behavior_repo.visibility, "private");
  assert.equal(Object.hasOwn(config.github, ["token", "broker"].join("_")), false);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
