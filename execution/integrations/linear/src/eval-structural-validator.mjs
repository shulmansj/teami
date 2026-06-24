// Minimal structural JSON Schema checker shared by the eval contract tests and
// the runtime promotion paths (rich dataset promotion validates every example
// against execution/evals/decomposition/example.schema.json with these exact
// checks before any Phoenix upload, and fails closed on mismatch).
//
// It is deliberately minimal: the repo stays zero-dependency and does not ship
// a general-purpose validator. Supported keywords cover exactly what the eval
// contract schemas use: $ref (local), type, const, enum, required, properties,
// additionalProperties (schema form), items, allOf, anyOf, oneOf, if/then/else,
// minimum/maximum/exclusiveMinimum/exclusiveMaximum, minLength, pattern.

function resolveLocalRef(ref, rootSchema) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node = rootSchema;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = decodeURIComponent(rawPart).replaceAll("~1", "/").replaceAll("~0", "~");
    node = node?.[part];
  }
  if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  return node;
}

function typeMatches(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function schemaErrors(schema, value, rootSchema = schema, where = "$") {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${where}: schema is false`];
  const errors = [];

  if (schema.$ref) {
    errors.push(...schemaErrors(resolveLocalRef(schema.$ref, rootSchema), value, rootSchema, where));
  }
  for (const sub of schema.allOf || []) {
    errors.push(...schemaErrors(sub, value, rootSchema, where));
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some(
      (sub) => schemaErrors(sub, value, rootSchema, where).length === 0,
    );
    if (!matched) errors.push(`${where}: matched no anyOf branch`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (sub) => schemaErrors(sub, value, rootSchema, where).length === 0,
    ).length;
    if (matches !== 1) errors.push(`${where}: matched ${matches} oneOf branches, expected exactly 1`);
  }
  if (schema.if) {
    const conditionHolds = schemaErrors(schema.if, value, rootSchema, where).length === 0;
    if (conditionHolds && schema.then) {
      errors.push(...schemaErrors(schema.then, value, rootSchema, where));
    }
    if (!conditionHolds && schema.else) {
      errors.push(...schemaErrors(schema.else, value, rootSchema, where));
    }
  }
  if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value)) {
    errors.push(`${where}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((option) => jsonEqual(option, value))) {
    errors.push(`${where}: ${JSON.stringify(value)} is not in enum`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${where}: expected type ${types.join("|")}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${where}: ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${where}: ${value} is above maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${where}: ${value} is not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${where}: ${value} is not below exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${where}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${where}: string does not match pattern ${schema.pattern}`);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      errors.push(...schemaErrors(schema.items, item, rootSchema, `${where}[${index}]`));
    });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required || []) {
      if (!Object.hasOwn(value, requiredKey)) {
        errors.push(`${where}: missing required property "${requiredKey}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...schemaErrors(subSchema, value[key], rootSchema, `${where}.${key}`));
      }
    }
    if (typeof schema.additionalProperties === "object") {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties || {}, key)) {
          errors.push(
            ...schemaErrors(schema.additionalProperties, propertyValue, rootSchema, `${where}.${key}`),
          );
        }
      }
    }
  }
  return errors;
}
