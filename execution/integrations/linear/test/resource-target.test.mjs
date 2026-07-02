import assert from "node:assert/strict";
import test from "node:test";

import {
  RESOURCE_TARGET_INFO_STRING,
  parseResourceTargetFromDescription,
  renderResourceTargetBlock,
} from "../src/resource-target.mjs";

test("resource target block renders and parses with repo_scope", () => {
  const target = { kind: "git_repo", id: "repo-main", repo_scope: "apps/web" };
  const block = renderResourceTargetBlock(target);

  assert.match(block, new RegExp(`^\`\`\`${RESOURCE_TARGET_INFO_STRING} \\{`));
  assert.deepEqual(
    parseResourceTargetFromDescription(`Issue body.\n\n${block}`),
    target,
  );
});

test("resource target block omits absent repo_scope", () => {
  const target = { kind: "git_repo", id: "repo-main" };
  const parsed = parseResourceTargetFromDescription(renderResourceTargetBlock(target));

  assert.deepEqual(parsed, target);
  assert.equal(Object.hasOwn(parsed, "repo_scope"), false);
});

test("resource target parser returns null when absent or malformed", () => {
  assert.equal(parseResourceTargetFromDescription("Issue body only."), null);
  assert.equal(
    parseResourceTargetFromDescription("```af-resource-target {not-json}\n```\n"),
    null,
  );
  assert.equal(
    parseResourceTargetFromDescription("```af-resource-target {\"kind\":\"git_repo\"}\n```\n"),
    null,
  );
});
