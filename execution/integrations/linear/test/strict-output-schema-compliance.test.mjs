import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const codexEnforcedSchemaPaths = Object.freeze([
  path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "subagent-turn.strict-generation.schema.json",
  ),
  path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "orchestrator-turn-output.schema.json",
  ),
]);

test("codex-enforced output schemas require every object property", () => {
  const violations = [];
  for (const schemaPath of codexEnforcedSchemaPaths) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    collectRequiredPropertyViolations(schema, "$", violations, {
      schemaName: path.relative(repoRoot, schemaPath).replaceAll("\\", "/"),
    });
  }

  assert.deepEqual(violations, []);
});

function collectRequiredPropertyViolations(node, location, violations, { schemaName }) {
  if (!node || typeof node !== "object") return;

  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    const propertyKeys = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : null;
    const missing = required ? propertyKeys.filter((key) => !required.includes(key)) : propertyKeys;
    const extra = required ? required.filter((key) => !propertyKeys.includes(key)) : [];
    if (!required || missing.length > 0 || extra.length > 0) {
      violations.push({
        schema: schemaName,
        location,
        missing,
        extra,
        required: required || null,
      });
    }
    // OpenAI strict mode also demands additionalProperties: false on EVERY object.
    if (node.additionalProperties !== false) {
      violations.push({
        schema: schemaName,
        location,
        additional_properties: node.additionalProperties === undefined ? "missing" : node.additionalProperties,
      });
    }
  }

  // Strict mode forbids OPEN objects entirely: any node typed (or union-typed)
  // "object" must carry properties + additionalProperties: false, even when it
  // declares no properties at all (a bare { "type": "object" } is rejected).
  const nodeTypes = Array.isArray(node.type) ? node.type : [node.type];
  if (nodeTypes.includes("object") && !(node.properties && typeof node.properties === "object")) {
    violations.push({
      schema: schemaName,
      location,
      open_object: true,
    });
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [propertyKey, propertyValue] of Object.entries(value)) {
        collectRequiredPropertyViolations(propertyValue, `${location}.properties.${propertyKey}`, violations, {
          schemaName,
        });
      }
      continue;
    }
    if (key === "items") {
      collectRequiredPropertyViolations(value, `${location}.items`, violations, { schemaName });
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectRequiredPropertyViolations(item, `${location}.${key}[${index}]`, violations, {
          schemaName,
        });
      });
      continue;
    }
    collectRequiredPropertyViolations(value, `${location}.${key}`, violations, { schemaName });
  }
}
