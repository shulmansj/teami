import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const retiredName = "super" + "visor";
const retiredCommandPrefix = `${retiredName}:`;

const ADOPTER_DOCS = Object.freeze([
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "docs/adoption.md",
]);

const PUBLISHED_ADOPTER_DOCS = Object.freeze([
  "README.md",
  "docs/adoption.md",
]);

const PUBLIC_ONBOARDING_TRUST_DOCS = Object.freeze([
  "README.md",
  "docs/adoption.md",
  "execution/integrations/linear/README.md",
  "docs/contracts/authority-custody-defaults.md",
  "docs/contracts/teami-product-trust-record.md",
]);

const ALL_RECONCILED_DOCS = Object.freeze([
  ...ADOPTER_DOCS,
  "docs/self-improvement.md",
]);

test("D1 reconciles adopter docs to installed MCP plus manual gateway surfaces", () => {
  const docs = Object.fromEntries(
    ALL_RECONCILED_DOCS.map((relPath) => [relPath, readText(relPath)]),
  );

  for (const [relPath, content] of Object.entries(docs)) {
    assert.doesNotMatch(content, new RegExp(retiredName, "i"), `${relPath} mentions retired local process`);
    assert.doesNotMatch(content, /factory folder/i, `${relPath} mentions the old folder model`);
    assert.doesNotMatch(content, /factory checkout/i, `${relPath} mentions the old checkout model`);
    assert.doesNotMatch(content, /\.\/teami\b/, `${relPath} uses the old repo-local launcher form`);
  }

  for (const relPath of ADOPTER_DOCS) {
    const content = docs[relPath];
    assert.match(content, /\bMCP\b/, `${relPath} describes the MCP surface`);
    assert.match(content, /project_create/, `${relPath} names the project creation tool`);
    assert.match(content, /project_write_body/, `${relPath} names the body-writing tool`);
    assert.match(content, /project_move_status/, `${relPath} names the planned-status tool`);
    assert.match(content, /gateway start/, `${relPath} keeps the manual gateway surface`);
  }

  for (const relPath of PUBLISHED_ADOPTER_DOCS) {
    const content = docs[relPath];
    assert.match(
      content,
      /npx @shulmansj\/teami gateway start/,
      `${relPath} gives no-checkout adopters a runnable gateway command`,
    );
    assert.doesNotMatch(
      content,
      /`teami gateway (?:start|status)`/,
      `${relPath} must not send no-checkout adopters to an unavailable bare command`,
    );
  }

  assert.match(docs["README.md"], /npx @shulmansj\/teami init/);
  assert.match(docs["README.md"], /You do not need to supply a release tag/);
  assert.match(docs["docs/adoption.md"], /The preview has three adopter-facing surfaces/);
  assert.doesNotMatch(docs["docs/self-improvement.md"], /always-on/i);
});

test("D1 retires the local process CLI scripts, dispatch, and modules", () => {
  const packageJson = JSON.parse(readText("package.json"));
  for (const scriptName of Object.keys(packageJson.scripts || {})) {
    assert.notEqual(scriptName, retiredName);
    assert.equal(scriptName.startsWith(retiredCommandPrefix), false, `retired script remains: ${scriptName}`);
  }

  const dispatchSource = readText("execution/integrations/linear/src/cli/dispatch.mjs");
  assert.doesNotMatch(dispatchSource, new RegExp(`${retiredName}(?::|")`, "i"));
  assert.doesNotMatch(dispatchSource, new RegExp(`${retiredName}-command\\.mjs`, "i"));

  for (const relPath of [
    `execution/integrations/linear/src/cli/${retiredName}-command.mjs`,
    `execution/integrations/linear/src/local-${retiredName}.mjs`,
    `execution/integrations/linear/src/${retiredName}/state-store.mjs`,
    `execution/integrations/linear/test/local-${retiredName}.test.mjs`,
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relPath)), false, `${relPath} should be deleted`);
  }
});

test("current public trust docs keep product repositories disconnected from onboarding", () => {
  const docs = Object.fromEntries(
    PUBLIC_ONBOARDING_TRUST_DOCS.map((relPath) => [
      relPath,
      readText(relPath).replace(/\s+/g, " "),
    ]),
  );
  const joined = Object.values(docs).join("\n");
  assert.doesNotMatch(
    joined,
    /selected product-repository allowlist|only the confirmed product repos will be allowlisted|product-repo allowlisting|setup can discover the initial allowlist|product-repository intent defaults to none|no product-repository access by default/i,
  );
  assert.match(docs["README.md"], /does not connect any product repository/i);
  assert.match(docs["docs/adoption.md"], /product repositories remain disconnected during setup/i);
  assert.match(docs["execution/integrations/linear/README.md"], /setup never discovers or records an initial product-repository allowlist/i);
  assert.match(docs["docs/contracts/authority-custody-defaults.md"], /product repositories remain disconnected during setup/i);
  assert.match(docs["docs/contracts/authority-custody-defaults.md"], /repair may preserve[\s\S]*previously approved[\s\S]*neither uses nor expands/i);
  assert.match(docs["docs/contracts/teami-product-trust-record.md"], /no product-repository access/i);
  assert.match(docs["docs/contracts/teami-product-trust-record.md"], /separate post-setup product-repository grant/i);
  assert.match(joined, /private Teami workspace repository/i);
});

test("published plugin and runtime repair guidance never requires a bare Teami command", () => {
  const planSkill = readText("skills/plan/SKILL.md");
  const planningMutations = readText("execution/integrations/linear/src/team-confined-planning-mutations.mjs");
  const setupCommand = readText("execution/integrations/linear/src/cli/linear-setup-command.mjs");

  assert.match(planSkill, /npx @shulmansj\/teami init/);
  assert.doesNotMatch(planSkill, /`teami init`/);
  assert.doesNotMatch(planningMutations, /Run teami doctor/);
  assert.match(planningMutations, /formatCommand\("doctor"\)/);
  assert.doesNotMatch(setupCommand, /rerun teami init/);
  assert.match(setupCommand, /rerun \$\{formatCommand\("init"\)\}/);
});

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}
