const DESCRIPTOR_TIERS = new Set(["adopter", "operator"]);

export function validateCommandDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("command descriptor must be an object");
  }

  requireNonEmptyString(descriptor.noun, "noun");

  if (!(descriptor.verb === null || isNonEmptyString(descriptor.verb))) {
    throw new Error("command descriptor verb must be a non-empty string or null");
  }

  requireBoolean(descriptor.acceptNounVerb, "acceptNounVerb");
  requireBoolean(descriptor.defaultForBareNoun, "defaultForBareNoun");

  if (descriptor.verb === null) {
    if (descriptor.consumeVerb !== undefined) {
      throw new Error("command descriptor consumeVerb must be absent when verb is null");
    }
  } else {
    requireBoolean(descriptor.consumeVerb, "consumeVerb");
  }

  requireNonEmptyString(descriptor.invokeCommand, "invokeCommand");

  if (typeof descriptor.handler !== "function") {
    throw new Error("command descriptor handler must be a function");
  }

  if (!DESCRIPTOR_TIERS.has(descriptor.tier)) {
    throw new Error("command descriptor tier must be one of adopter or operator");
  }

  if (typeof descriptor.summary !== "string") {
    throw new Error("command descriptor summary must be a string");
  }

  if (typeof descriptor.usageTail !== "string") {
    throw new Error("command descriptor usageTail must be a string");
  }

  if (!Array.isArray(descriptor.aliases) || !descriptor.aliases.every((alias) => typeof alias === "string")) {
    throw new Error("command descriptor aliases must be an array of strings");
  }

  if (descriptor.tier === "adopter") {
    requireNonEmptyString(descriptor.helpGroup, "helpGroup");
    requireNumber(descriptor.helpOrder, "helpOrder");
  } else {
    if (descriptor.helpGroup !== undefined && !isNonEmptyString(descriptor.helpGroup)) {
      throw new Error("command descriptor helpGroup must be a non-empty string when present");
    }
    if (descriptor.helpOrder !== undefined && !isNumber(descriptor.helpOrder)) {
      throw new Error("command descriptor helpOrder must be a number when present");
    }
  }

  return descriptor;
}

export function buildCommandIndex(registry) {
  const index = new Map();

  for (const descriptor of registry) {
    for (const token of [descriptor.invokeCommand, ...descriptor.aliases]) {
      const existing = index.get(token);
      if (!existing) {
        index.set(token, descriptor);
        continue;
      }
      if (existing.handler !== descriptor.handler) {
        throw new Error(
          `command registry token collision for ${JSON.stringify(token)}: ${existing.invokeCommand} and ${descriptor.invokeCommand} use different handlers`,
        );
      }
    }
  }

  return index;
}

function requireNonEmptyString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new Error(`command descriptor ${field} must be a non-empty string`);
  }
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`command descriptor ${field} must be a boolean`);
  }
}

function requireNumber(value, field) {
  if (!isNumber(value)) {
    throw new Error(`command descriptor ${field} must be a number`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
