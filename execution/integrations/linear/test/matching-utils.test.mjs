import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesStatus,
  resolveLabelByNameOrId,
} from "../src/linear/matching-utils.mjs";

test("matchesStatus rejects same-type statuses when expected has a different id", () => {
  assert.equal(
    matchesStatus(
      { id: "status-actual", name: "In Progress", type: "started" },
      { id: "status-expected", name: "Blocked", type: "started" },
    ),
    false,
  );
});

test("matchesStatus keeps type-only matching only when expected id is absent", () => {
  assert.equal(
    matchesStatus(
      { id: "status-actual", name: "In Progress", type: "started" },
      { name: "Any started state", type: "started" },
    ),
    true,
  );
});

test("resolveLabelByNameOrId fails when cached id is absent even if name matches", async () => {
  await assert.rejects(
    () => resolveLabelByNameOrId({
      list: [{ id: "label-current", name: "Discovery" }],
      id: "label-cached",
      label: "Discovery",
    }),
    /Expected exactly one Discovery, found 0/,
  );
});
