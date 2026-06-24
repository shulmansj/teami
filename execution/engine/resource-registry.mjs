const RESOURCE_KIND_DEFINITIONS_BY_KIND = new Map();

const REQUIRED_RESOURCE_KIND_FUNCTIONS = Object.freeze(["validateBinding", "materialize", "manifestEntry"]);

export function validateResourceKind(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("resource_kind_definition_required");
  }
  const kind = definition.kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new Error("resource_kind_kind_required");
  }
  for (const fn of REQUIRED_RESOURCE_KIND_FUNCTIONS) {
    if (typeof definition[fn] !== "function") {
      throw new Error(`resource_kind_${fn}_required:${kind}`);
    }
  }
  return kind;
}

export function registerResourceKind(definition) {
  const kind = validateResourceKind(definition);
  RESOURCE_KIND_DEFINITIONS_BY_KIND.set(kind, definition);
}

export function resetResourceRegistry() {
  RESOURCE_KIND_DEFINITIONS_BY_KIND.clear();
}

export function registeredResourceKinds() {
  return [...RESOURCE_KIND_DEFINITIONS_BY_KIND.keys()];
}

export function getResourceKind(kind) {
  const definition = RESOURCE_KIND_DEFINITIONS_BY_KIND.get(kind);
  if (!definition) throw new Error(`unknown_resource_kind:${kind}`);
  return definition;
}
