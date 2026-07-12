import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ESLint } from "eslint";

import { STATIC_QUALITY_CONFIG } from "../eslint.config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("static quality catches unresolved paths, named-export drift, accidental globals, and unused values", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, ".static-quality-proof-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixtureRoot, "exports.mjs"), "export const present = true;\n", "utf8");
  const consumerPath = path.join(fixtureRoot, "consumer.mjs");
  fs.writeFileSync(consumerPath, [
    'import { missing } from "./exports.mjs";',
    'import "./absent.mjs";',
    "const unused = 1;",
    "accidentalGlobal = missing;",
    "",
  ].join("\n"), "utf8");

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: STATIC_QUALITY_CONFIG.slice(1),
  });
  const [result] = await eslint.lintFiles([consumerPath]);
  const ruleIds = new Set(result.messages.map((message) => message.ruleId));

  for (const ruleId of ["import/no-unresolved", "import/named", "no-undef", "no-unused-vars"]) {
    assert.ok(ruleIds.has(ruleId), `${ruleId} must remain active; got ${JSON.stringify([...ruleIds])}`);
  }
});

test("static quality accepts a valid local ESM reference", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, ".static-quality-clean-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixtureRoot, "exports.mjs"), "export const present = true;\n", "utf8");
  const consumerPath = path.join(fixtureRoot, "consumer.mjs");
  fs.writeFileSync(consumerPath, [
    'import { present } from "./exports.mjs";',
    "export const answer = present ? 42 : 0;",
    "",
  ].join("\n"), "utf8");

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: STATIC_QUALITY_CONFIG.slice(1),
  });
  const [result] = await eslint.lintFiles([consumerPath]);
  assert.deepEqual(result.messages, []);
});
