import assert from "node:assert/strict";
import test from "node:test";

import { toolPolicyToFlags } from "../src/runtime-adapters.mjs";

test("toolPolicyToFlags returns Claude no-tool flags for tool-less decomposition runs", () => {
  assert.deepEqual(
    toolPolicyToFlags({
      runtime: "claude",
      toolPolicy: { linear_write: false },
    }),
    ["--allowedTools", ""],
  );
});

test("toolPolicyToFlags returns Codex no-tool flags for tool-less decomposition runs", () => {
  assert.deepEqual(
    toolPolicyToFlags({
      runtime: "codex",
      toolPolicy: { linear_write: false },
    }),
    ["-s", "read-only"],
  );
});
