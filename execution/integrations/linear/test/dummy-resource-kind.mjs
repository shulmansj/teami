import { registerResourceKind } from "../../../engine/resource-registry.mjs";

export const DUMMY_VALUE = "dummy-handle-value";

export const dummyResourceKind = {
  kind: "dummy",
  validateBinding() {},
  async materialize(resource, runContext = {}) {
    const binding = resource?.binding && typeof resource.binding === "object"
      ? resource.binding
      : {};
    const workingDir = stringOrNull(binding.workingDir);
    const publishedPath = stringOrNull(binding.publishedPath);
    const envAugment =
      binding.envAugment &&
      typeof binding.envAugment === "object" &&
      !Array.isArray(binding.envAugment)
        ? { ...binding.envAugment }
        : {};
    if (workingDir) runContext.cwd = workingDir;
    if (Object.keys(envAugment).length > 0) {
      runContext.envAugment = { ...(runContext.envAugment || {}), ...envAugment };
    }
    return {
      kind: "dummy",
      handle: {
        read: () => DUMMY_VALUE,
        workingDir,
        publishedPath,
        envAugment,
      },
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

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}
