import assert from "node:assert/strict";
import test from "node:test";

import {
  WORK_TYPES,
  requiredResourceKindForWorkType,
} from "../src/workflows/execution/work-type.mjs";

test("work type map resolves required resource kind additively", () => {
  assert.deepEqual(WORK_TYPES, ["code", "non_code"]);
  assert.equal(requiredResourceKindForWorkType("code"), "git_repo");
  assert.equal(requiredResourceKindForWorkType("non_code"), null);
  assert.equal(requiredResourceKindForWorkType("unknown"), null);
  assert.equal(requiredResourceKindForWorkType(null), null);
});
