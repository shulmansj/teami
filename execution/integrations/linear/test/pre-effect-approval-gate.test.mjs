import assert from "node:assert/strict";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";

test("applyCommitEffects fails closed before applying an effect that requires pre-effect approval", async () => {
  let applyCalled = false;
  const result = await applyCommitEffects({
    ctx: { runId: "run-pre-effect-gate" },
    effects: [
      fakeEffect("gated", {
        requires_pre_effect_approval: true,
        apply: () => {
          applyCalled = true;
          return { ok: true, identity: "created" };
        },
      }),
    ],
  });

  assert.deepEqual(result, {
    outcome: "failed_closed",
    pending_effect_id: "gated",
    reason: "unsupported_pre_commit_gate",
  });
  assert.equal(applyCalled, false);
});

test("applyCommitEffects leaves effects without pre-effect approval unchanged", async () => {
  const events = [];
  const ctx = Object.freeze({ runId: "run-no-pre-effect-gate" });
  const result = await applyCommitEffects({
    ctx,
    effects: [
      fakeEffect("plain", {
        probe: (receivedCtx) => {
          events.push(["probe", "plain", receivedCtx]);
          return { satisfied: false };
        },
        apply: (receivedCtx) => {
          events.push(["apply", "plain", receivedCtx]);
          return { ok: true, identity: "created" };
        },
        verify: (receivedCtx) => {
          events.push(["verify", "plain", receivedCtx]);
          return { ok: true };
        },
      }),
    ],
  });

  assert.deepEqual(result, {
    outcome: "ok",
    applied: [{ id: "plain", identity: "created" }],
    produced_identities: [],
  });
  assert.deepEqual(events, [
    ["probe", "plain", ctx],
    ["apply", "plain", ctx],
    ["verify", "plain", ctx],
  ]);
});

function fakeEffect(id, overrides = {}) {
  return {
    id,
    provider: "fake",
    op: "test",
    probe: () => ({ satisfied: false }),
    apply: () => ({ ok: true, identity: id }),
    verify: () => ({ ok: true }),
    ...overrides,
  };
}
