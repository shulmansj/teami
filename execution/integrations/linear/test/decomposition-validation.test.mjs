import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidationResult,
  checkRuntimePreconditions,
} from "../src/decomposition-validation.mjs";
import { ORCHESTRATOR_OUTPUT_SCHEMA_VERSION } from "../../../engine/orchestrator-output.mjs";
import { ENGINE_VERSION } from "../../../engine/engine-contract-constants.mjs";

const RUN_ID = "run_validation_test";

test("validation precondition helper passes when required CLIs probe successfully", async () => {
  const probed = [];
  const result = await checkRuntimePreconditions({
    probeBinary: async (binary) => {
      probed.push(binary);
      return { ok: true, binary };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(probed, ["claude", "codex"]);
});

test("validation precondition helper fails clearly when a required CLI probe fails", async () => {
  const result = await checkRuntimePreconditions({
    probeBinary: async (binary) => (
      binary === "claude"
        ? { ok: false, binary, reason: "ENOENT", detail: "not found" }
        : { ok: true, binary }
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.message, /Validation precondition failed/);
  assert.match(result.message, /claude/);
  assert.match(result.message, /PATH and authenticated/);
});

test("validation assertion helper passes a clean commit and validates the whole orchestrator output", () => {
  const fakeResult = validValidationResult();
  let validatedValue = null;

  const result = assertValidationResult(fakeResult, {
    validateOutput: (value) => {
      validatedValue = value;
      return { ok: true, failureReasons: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(validatedValue, fakeResult.orchestratorOutput);
});

test("validation assertion helper fails invalid subagent evidence and non-commit terminal output", () => {
  const result = assertValidationResult(validValidationResult({
    subagent_evidence: [
      {
        role: "pm",
        runtime: "claude",
        parse_status: "invalid",
        clean_parse: false,
        raw_output_excerpt: "not a clean packet",
      },
    ],
    orchestratorOutput: validPauseOrchestratorOutput(),
  }));

  assert.equal(result.ok, false);
  const reasons = result.failureReasons.join("\n");
  assert.match(reasons, /pm\/claude/);
  assert.match(reasons, /missing subagent evidence for sr_eng\/codex/);
  assert.match(reasons, /expected terminal outcome commit, got pause/);
});

test("validation assertion helper fails when a family has a dirty repaired attempt before a clean retry", () => {
  const result = assertValidationResult(validValidationResult({
    subagent_evidence: [
      {
        role: "pm",
        runtime: "claude",
        parse_status: "invalid",
        clean_parse: false,
        failure_code: "invalid_packet",
        raw_output_excerpt: "diagnostic preamble before the repaired packet",
      },
      {
        role: "pm",
        runtime: "claude",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: '{"status":"continue"}',
      },
      {
        role: "sr_eng",
        runtime: "codex",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: '{"status":"continue"}',
      },
    ],
  }));

  assert.equal(result.ok, false);
  assert.match(
    result.failureReasons.join("\n"),
    /subagent evidence for pm\/claude attempt 1 was parse_status=invalid clean_parse=false/,
  );
});

test("validation assertion helper passes a structurally valid commit using the real validator", () => {
  const result = assertValidationResult(validValidationResult());

  assert.deepEqual(result, { ok: true, failureReasons: [] });
});

function validValidationResult(overrides = {}) {
  return {
    subagent_evidence: validSubagentEvidence(),
    orchestratorOutput: validCommitOrchestratorOutput(),
    ...overrides,
  };
}

function validSubagentEvidence() {
  return [
    {
      role: "pm",
      runtime: "claude",
      parse_status: "valid",
      clean_parse: true,
      raw_output_excerpt: '{"status":"ok"}',
    },
    {
      role: "sr_eng",
      runtime: "codex",
      parse_status: "valid",
      clean_parse: true,
      raw_output_excerpt: '{"status":"ok"}',
    },
  ];
}

function validCommitOrchestratorOutput() {
  return {
    terminal_output: {
      ...baseTerminalOutput(),
      outcome: "commit",
      reason: "synthesis_complete",
      project_update_markdown: projectUpdateMarkdown(),
      final_issues: [validFinalIssue()],
    },
    bounds: { rounds_used: 2, max_rounds: 5 },
  };
}

function validPauseOrchestratorOutput() {
  return {
    terminal_output: {
      ...baseTerminalOutput(),
      outcome: "pause",
      reason: "product_questions",
      project_update_markdown: projectUpdateMarkdown("Paused for product input."),
      open_questions_markdown: "- Which launch segment should this prioritize?",
    },
    bounds: { rounds_used: 1, max_rounds: 5 },
  };
}

function baseTerminalOutput() {
  return {
    schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
    run_id: RUN_ID,
    workflow_version: ENGINE_VERSION,
    context_digest: "Project intent and constraints reviewed for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-webhook-inbox" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

function validFinalIssue() {
  return {
    decomposition_key: "webhook-inbox-plan",
    title: "Prepare webhook inbox execution plan",
    issue_body_markdown: [
      "## Assignment",
      "",
      "Create the execution plan for the webhook inbox slice.",
      "",
      "## Acceptance Criteria",
      "",
      "- The execution plan is ready for implementation.",
    ].join("\n"),
    depends_on: [],
    assignment: "Create the execution plan for the webhook inbox slice.",
    output: "An implementation-ready execution plan.",
    acceptance_criteria: ["The execution plan is ready for implementation."],
  };
}

function projectUpdateMarkdown(body = "Decomposition completed with one issue.") {
  return [
    `run_id: ${RUN_ID}`,
    "",
    body,
    "",
    "## What I did with each part of your project",
    "- The project sections were accounted for in the final issue set.",
  ].join("\n");
}
