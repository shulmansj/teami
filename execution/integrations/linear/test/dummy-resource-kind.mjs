import { registerResourceKind } from "../../../engine/resource-registry.mjs";

export const DUMMY_VALUE = "dummy-handle-value";

export const dummyResourceKind = {
  kind: "dummy",
  validateBinding() {},
  async materialize() {
    return {
      kind: "dummy",
      handle: { read: () => DUMMY_VALUE },
      teardown() {},
    };
  },
  manifestEntry(resource) {
    return {
      kind: "dummy",
      id: resource.id,
      role: resource.role,
      label: "dummy-fixture",
    };
  },
};

export function registerDummyResourceKind() {
  registerResourceKind(dummyResourceKind);
}
