import assert from "node:assert/strict";
import test from "node:test";

import { gatewayState, tryEnterInFlight } from "../src/gateway-loop.mjs";

test("tryEnterInFlight defaults to one in-flight project", () => {
  const state = gatewayState({ maxInFlight: 1 });

  assert.equal(tryEnterInFlight(state, "project-1"), true, "first distinct key is admitted");
  assert.equal(state.inFlight.has("project-1"), true, "admitted key is tracked");
  assert.equal(tryEnterInFlight(state, "project-2"), false, "second distinct key is refused at capacity");
  assert.equal(state.inFlight.has("project-2"), false, "refused distinct key is not tracked");
  assert.equal(state.inFlight.size, 1, "capacity refusal leaves size unchanged");
  assert.equal(tryEnterInFlight(state, "project-1"), false, "duplicate admitted key is refused");
  assert.equal(state.inFlight.size, 1, "duplicate refusal leaves size unchanged");
});

test("tryEnterInFlight admits up to maxInFlight distinct keys", () => {
  const state = gatewayState({ maxInFlight: 2 });

  assert.equal(tryEnterInFlight(state, "project-1"), true, "first distinct key is admitted");
  assert.equal(tryEnterInFlight(state, "project-2"), true, "second distinct key is admitted");
  assert.equal(state.inFlight.size, 2, "two admitted keys are tracked");
  assert.equal(tryEnterInFlight(state, "project-3"), false, "third distinct key is refused at capacity");
  assert.equal(state.inFlight.size, 2, "third-key refusal leaves size unchanged");
  assert.equal(tryEnterInFlight(state, "project-2"), false, "duplicate admitted key is refused");
  assert.equal(state.inFlight.size, 2, "duplicate refusal leaves size unchanged");
});

test("tryEnterInFlight checks duplicates before capacity", () => {
  const state = gatewayState({ inFlight: new Set(["project-1"]), maxInFlight: 1 });

  assert.equal(tryEnterInFlight(state, "project-1"), false, "duplicate at capacity is refused");
  assert.deepEqual([...state.inFlight], ["project-1"], "duplicate-at-capacity refusal leaves set unchanged");
});

test("gatewayState exposes maxInFlight default and override", () => {
  assert.equal(gatewayState().maxInFlight, 1, "default maxInFlight is 1");
  assert.equal(gatewayState({ maxInFlight: 3 }).maxInFlight, 3, "maxInFlight override is preserved");
});
