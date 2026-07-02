import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

test("execution clone containment known limits are documented", () => {
  const adoption = fs.readFileSync(path.join(REPO_ROOT, "docs", "adoption.md"), "utf8");

  assert.match(adoption, /Execution Clone Containment Known Limits/);
  assert.match(adoption, /Network egress is not locked/);
  assert.match(adoption, /runaway-diff bounds/);
  assert.match(adoption, /fresh per-run shallow clone/);
  assert.match(adoption, /local ambient auth/);
});
