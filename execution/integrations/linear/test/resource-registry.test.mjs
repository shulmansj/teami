import assert from "node:assert/strict";
import test from "node:test";

import {
  getResourceKind,
  registerResourceKind,
  resetResourceRegistry,
  registeredResourceKinds,
  validateResourceKind,
} from "../../../engine/resource-registry.mjs";

function validDefinition(overrides = {}) {
  return {
    kind: "probe",
    validateBinding: () => {},
    materialize: async () => ({ kind: "probe", handle: {}, teardown: () => {} }),
    manifestEntry: () => ({ kind: "probe", id: "probe-resource", role: "primary", label: "Probe" }),
    ...overrides,
  };
}

function withoutField(field) {
  const definition = validDefinition();
  delete definition[field];
  return definition;
}

test("registerResourceKind indexes a complete definition by kind", () => {
  resetResourceRegistry();
  const definition = validDefinition();
  registerResourceKind(definition);
  assert.deepEqual(registeredResourceKinds(), ["probe"]);
  assert.equal(getResourceKind("probe"), definition);
  resetResourceRegistry();
});

test("validateResourceKind returns the kind for a valid definition", () => {
  assert.equal(validateResourceKind(validDefinition()), "probe");
});

test("getResourceKind throws for an unknown kind", () => {
  resetResourceRegistry();
  assert.throws(() => getResourceKind("missing"), { message: "unknown_resource_kind:missing" });
});

const FAILURE_CASES = [
  ["null definition", null, "resource_kind_definition_required"],
  ["non-object definition", 42, "resource_kind_definition_required"],
  ["missing kind", validDefinition({ kind: "" }), "resource_kind_kind_required"],
  ["blank kind", validDefinition({ kind: "  " }), "resource_kind_kind_required"],
  ["non-string kind", validDefinition({ kind: 7 }), "resource_kind_kind_required"],
  ["missing validateBinding", withoutField("validateBinding"), "resource_kind_validateBinding_required:probe"],
  ["non-function validateBinding", validDefinition({ validateBinding: "nope" }), "resource_kind_validateBinding_required:probe"],
  ["missing materialize", withoutField("materialize"), "resource_kind_materialize_required:probe"],
  ["non-function materialize", validDefinition({ materialize: null }), "resource_kind_materialize_required:probe"],
  ["missing manifestEntry", withoutField("manifestEntry"), "resource_kind_manifestEntry_required:probe"],
  ["non-function manifestEntry", validDefinition({ manifestEntry: {} }), "resource_kind_manifestEntry_required:probe"],
];

for (const [label, definition, expectedMessage] of FAILURE_CASES) {
  test(`registerResourceKind rejects ${label}`, () => {
    resetResourceRegistry();
    assert.throws(() => registerResourceKind(definition), { message: expectedMessage });
    assert.deepEqual(registeredResourceKinds(), [], "a rejected definition must not be indexed");
    resetResourceRegistry();
  });
}
