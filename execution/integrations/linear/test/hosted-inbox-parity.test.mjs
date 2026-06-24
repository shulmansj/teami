import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import {
  candidateTriggersForEvent,
  requiredCapabilitiesForWorkflow,
  TRIGGER_REGISTRY,
  wakeKeyForTrigger,
} from "../src/trigger-registry.mjs";
import {
  buildDecompositionWakeKey,
  decompositionDefinition,
  DECOMPOSITION_WAKE_KEY_TEMPLATE,
} from "../src/workflows/decomposition/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const hostedInboxSource = fs.readFileSync(
  path.join(repoRoot, "supabase/functions/agentic-factory-inbox/index.ts"),
  "utf8",
);
const triggerRegistrySource = fs.readFileSync(
  path.join(repoRoot, "execution/integrations/linear/src/trigger-registry.mjs"),
  "utf8",
);

test("hosted decomposition mirror stays in parity with the registered definition", () => {
  const hostedCapabilities = extractConstStringArray(hostedInboxSource, "REQUIRED_CAPABILITIES");
  assert.deepEqual(hostedCapabilities, [...decompositionDefinition.required_capabilities]);

  const routeTriggerEvent = extractFunctionBody(hostedInboxSource, "routeTriggerEvent");
  assert.equal(extractObjectStringProperty(routeTriggerEvent, "workflow_type"), decompositionDefinition.workflow_type);
  assert.equal(extractHostedWakeKeyTemplate(routeTriggerEvent), DECOMPOSITION_WAKE_KEY_TEMPLATE);

  const missingCapabilities = extractFunctionBody(hostedInboxSource, "missingCapabilities");
  assert.match(
    missingCapabilities,
    new RegExp(`workflowType !== "${escapeRegExp(decompositionDefinition.workflow_type)}"`),
  );
  assert.match(
    missingCapabilities,
    /return REQUIRED_CAPABILITIES\.filter\(\(capability\) => !runnerCapabilities\.has\(capability\)\)/,
  );

  const derivedWakeStatus = extractFunctionBody(hostedInboxSource, "derivedWakeStatus");
  assert.match(
    derivedWakeStatus,
    /return REQUIRED_CAPABILITIES\.every\(\(capability\) => capabilities\.has\(capability\)\)/,
  );

  const event = { object: { id: "project-123" } };
  assert.equal(
    extractHostedWakeKeyTemplate(routeTriggerEvent).replace("{project_id}", event.object.id),
    buildDecompositionWakeKey(event),
  );
});

test("trigger-registry adapter resolves decomposition routing through the workflow registry", () => {
  assert.match(triggerRegistrySource, /registeredWorkflowTypes\(\)\.flatMap/);
  assert.match(triggerRegistrySource, /getWorkflowDefinition\(workflowType\)/);
  assert.match(triggerRegistrySource, /normalizeTriggerDefinition\(definition, trigger\)/);
  assert.doesNotMatch(triggerRegistrySource, /linear\.project\.planned/);
  assert.doesNotMatch(triggerRegistrySource, /linear:project:\{project_id\}:decomposition/);

  assert.equal(getWorkflowDefinition(decompositionDefinition.workflow_type), decompositionDefinition);
  assert.deepEqual(
    requiredCapabilitiesForWorkflow(decompositionDefinition.workflow_type),
    [...decompositionDefinition.required_capabilities],
  );

  const event = {
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-456" },
  };
  const candidates = candidateTriggersForEvent(event);
  assert.equal(candidates.length, 1);

  const [trigger] = candidates;
  assert.equal(TRIGGER_REGISTRY.includes(trigger), true);
  assert.equal(trigger.workflow_type, decompositionDefinition.workflow_type);
  assert.equal(trigger.candidate_workflow, decompositionDefinition.workflow_type);
  assert.deepEqual(trigger.required_capabilities, [...decompositionDefinition.required_capabilities]);
  assert.equal(trigger.wake_key_template, DECOMPOSITION_WAKE_KEY_TEMPLATE);
  assert.equal(wakeKeyForTrigger(trigger, event), buildDecompositionWakeKey(event));
});

function extractConstStringArray(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `missing ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractObjectStringProperty(source, property) {
  const match = source.match(new RegExp(`${property}:\\s*"([^"]+)"`));
  assert.ok(match, `missing ${property}`);
  return match[1];
}

function extractHostedWakeKeyTemplate(routeTriggerEvent) {
  const match = routeTriggerEvent.match(
    /wake_key:\s*scopedWakeKeyForTrustedTeam\(`linear:project:\$\{object\.id\}:([^`]+)`,\s*trustedTeamId\)/,
  );
  assert.ok(match, "missing hosted decomposition wake_key");
  return `linear:project:{project_id}:${match[1]}`;
}

function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parenOpen = source.indexOf("(", start);
  assert.notEqual(parenOpen, -1, `missing parameter list for ${name}`);
  let depth = 0;
  let index = parenOpen;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return extractBodyFromOpenBrace(source, source.indexOf("{", index));
}

function extractBodyFromOpenBrace(source, openBrace) {
  assert.notEqual(openBrace, -1, "missing opening brace");
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  throw new Error("missing closing brace");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
