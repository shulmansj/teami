import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("active product and agent surfaces use Team terminology exclusively", () => {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-i",
      "-E",
      "\\bdomain(s)?\\b|domain_id|domainId",
      "--",
      ".",
      ":(exclude)private/docs/reviews/**",
      ":(exclude)execution/integrations/linear/src/legacy-team-state-migration.mjs",
      ":(exclude)execution/engine/legacy-team-state-compat.mjs",
      ":(exclude)execution/integrations/linear/test/linear-credential-store.test.mjs",
      ":(exclude)execution/integrations/linear/test/team-registry-migration.test.mjs",
      ":(exclude)execution/integrations/linear/test/team-state-backward-compat.test.mjs",
      ":(exclude)execution/integrations/linear/test/team-terminology.test.mjs",
    ],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );

  assert.ok([0, 1].includes(result.status), result.stderr || "git grep failed");
  assert.equal(
    result.status,
    1,
    `Retired terminology escaped the isolated upgrade bridge:\n${result.stdout}`,
  );
});

test("upgrade bridges never surface retired terminology in their thrown errors", () => {
  const files = [
    "execution/integrations/linear/src/legacy-team-state-migration.mjs",
    "execution/engine/legacy-team-state-compat.mjs",
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    const errorLines = source
      .split(/\r?\n/)
      .filter((line) => /throw new Error|message\s*:/.test(line))
      .join("\n");
    assert.doesNotMatch(errorLines, /\bdomain(s)?\b|domain_id|domainId/i, relativePath);
  }
});
