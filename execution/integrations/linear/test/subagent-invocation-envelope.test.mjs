import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
  SUBAGENT_TURN_OUTCOMES,
} from "../../../engine/orchestrator-turn-contract.mjs";
import {
  buildLibraryRolePurposeTask,
  buildSubagentInvocationEnvelope,
} from "../../../engine/subagent-invocation-envelope.mjs";

const DISCIPLINE_LINE =
  "Use ONLY the inlined project context and prior-turn digest; emit EXACTLY one JSON object matching the schema and nothing else — no prose; do not call tools.";

const PROJECT = {
  id: "project-1",
  name: "Onboarding cleanup",
  description: "Make setup completion unambiguous.",
  content: "## Goal\nShip onboarding clarity.\n\n## Open Questions\n",
  status: { id: "status-1", name: "planned", type: "planned" },
  labels: [{ id: "label-1", name: "decomposition-ready" }],
  issues: [{
    id: "issue-1",
    identifier: "FAC-1",
    title: "Existing discovery note",
    state: "Todo",
  }],
};

test("buildSubagentInvocationEnvelope includes persona, run, task, project, prior digest, outcomes, and discipline", () => {
  const envelope = buildSubagentInvocationEnvelope({
    body: "You are the product manager persona.",
    runId: "run-env-1",
    role: "pm",
    task: "Decide whether the product context is sufficient for decomposition.",
    project: PROJECT,
    priorDigest: "accepted turn: sr_eng found no technical blockers",
    allowedOutcomes: SUBAGENT_TURN_OUTCOMES,
  });

  assert.ok(envelope.includes("You are the product manager persona."));
  assert.ok(envelope.includes("run_id: run-env-1"));
  assert.ok(envelope.includes("role: pm"));
  assert.ok(envelope.includes("Decide whether the product context is sufficient for decomposition."));
  assert.ok(envelope.includes("Ship onboarding clarity."));
  assert.ok(envelope.includes("decomposition-ready"));
  assert.ok(envelope.includes("Existing discovery note"));
  assert.ok(envelope.includes("accepted turn: sr_eng found no technical blockers"));
  assert.ok(envelope.includes("- continue / product_context_sufficient"));
  assert.ok(envelope.includes("- blocked / needs_discovery"));
  assert.ok(envelope.includes("- blocked / needs_constraint_decision"));
  assert.ok(envelope.includes(DISCIPLINE_LINE));
  // Required-output contract: the persona prompts no longer carry the field list and claude's
  // --json-schema is advisory, so the envelope must enumerate the contract fields explicitly.
  assert.ok(envelope.includes("Required output"));
  assert.ok(envelope.includes(`schema_version: ${JSON.stringify(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION)}`));
  assert.ok(envelope.includes("context_digest:"));
  assert.ok(envelope.includes("source_refs: array of strings"));
});

test("buildSubagentInvocationEnvelope accepts array-form allowed outcomes and omits empty prior digest", () => {
  const envelope = buildSubagentInvocationEnvelope({
    body: "You are the senior engineer persona.",
    runId: "run-env-2",
    role: "sr_eng",
    task: "Ground the decomposition in implementation constraints.",
    project: PROJECT,
    priorDigest: "",
    allowedOutcomes: [
      { status: "continue", reason: "technical_context_grounded" },
      { status: "blocked", reason: "needs_discovery" },
    ],
  });

  assert.ok(envelope.includes("- continue / technical_context_grounded"));
  assert.ok(envelope.includes("- blocked / needs_discovery"));
  assert.doesNotMatch(envelope, /Prior accepted-turns digest:/);
});

test("buildSubagentInvocationEnvelope caps oversized project context and fails closed past hard argv ceiling", () => {
  const oversizedProject = {
    ...PROJECT,
    content: `## Goal\n${"project-context ".repeat(8000)}`,
  };
  const capped = buildSubagentInvocationEnvelope({
    body: "Persona body.",
    runId: "run-env-3",
    role: "pm",
    task: "Review the oversized project.",
    project: oversizedProject,
    allowedOutcomes: SUBAGENT_TURN_OUTCOMES,
  });

  assert.ok(capped.includes("[...truncated...]"));
  assert.ok(Buffer.byteLength(capped, "utf8") < 120 * 1024);

  assert.throws(
    () => buildSubagentInvocationEnvelope({
      body: "pathological persona body ".repeat(6000),
      runId: "run-env-4",
      role: "pm",
      task: "Review the oversized project.",
      project: oversizedProject,
      allowedOutcomes: SUBAGENT_TURN_OUTCOMES,
    }),
    /project envelope too large/,
  );
});

test("buildLibraryRolePurposeTask includes human name, target key, and run objective", () => {
  const task = buildLibraryRolePurposeTask({
    humanName: "Senior Engineer",
    targetKey: "prompt/decomposition/sr_eng",
    objective: "Split onboarding setup into agent-ready implementation work.",
  });

  assert.ok(task.includes("Senior Engineer"));
  assert.ok(task.includes("prompt/decomposition/sr_eng"));
  assert.ok(task.includes("Split onboarding setup into agent-ready implementation work."));
});
