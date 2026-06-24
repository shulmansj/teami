import assert from "node:assert/strict";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";

test("applyCommitEffects probes, skips satisfied effects, applies and verifies pending effects in order", async () => {
  const events = [];
  const ctx = Object.freeze({ runId: "run-fake" });
  const result = await applyCommitEffects({
    ctx,
    effects: [
      fakeEffect("already-done", {
        probe: async (receivedCtx) => {
          events.push(["probe", "already-done", receivedCtx]);
          return { satisfied: true, identity: "existing" };
        },
        apply: async () => {
          events.push(["apply", "already-done"]);
          return { ok: true, identity: "should-not-run" };
        },
      }),
      fakeEffect("needs-apply", {
        probe: async (receivedCtx) => {
          events.push(["probe", "needs-apply", receivedCtx]);
          return { satisfied: false };
        },
        apply: async (receivedCtx) => {
          events.push(["apply", "needs-apply", receivedCtx]);
          return { ok: true, identity: "created" };
        },
        verify: async (receivedCtx) => {
          events.push(["verify", "needs-apply", receivedCtx]);
          return { ok: true };
        },
      }),
    ],
  });

  assert.deepEqual(result, {
    ok: true,
    applied: [
      { id: "already-done", identity: "existing" },
      { id: "needs-apply", identity: "created" },
    ],
  });
  assert.deepEqual(events, [
    ["probe", "already-done", ctx],
    ["probe", "needs-apply", ctx],
    ["apply", "needs-apply", ctx],
    ["verify", "needs-apply", ctx],
  ]);
});

test("applyCommitEffects returns pending_effect_id and stops at the first failed effect", async () => {
  const events = [];
  const result = await applyCommitEffects({
    ctx: { runId: "run-fake" },
    effects: [
      fakeEffect("first", {
        probe: async () => {
          events.push(["probe", "first"]);
          return { satisfied: false };
        },
        apply: async () => {
          events.push(["apply", "first"]);
          return { ok: false, reason: "simulated_partial_failure" };
        },
      }),
      fakeEffect("second", {
        probe: async () => {
          events.push(["probe", "second"]);
          return { satisfied: false };
        },
      }),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    pending_effect_id: "first",
    reason: "simulated_partial_failure",
  });
  assert.deepEqual(events, [
    ["probe", "first"],
    ["apply", "first"],
  ]);
});

function fakeEffect(id, overrides = {}) {
  return {
    id,
    provider: "fake",
    op: "test",
    async probe() {
      return { satisfied: false };
    },
    async apply() {
      return { ok: true, identity: id };
    },
    async verify() {
      return { ok: true };
    },
    ...overrides,
  };
}
