import assert from "node:assert/strict";
import test from "node:test";

import {
  canApplyTerminal,
} from "../../../engine/terminal-gate.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import "../src/workflows/decomposition/definition.mjs";

const COMMIT_PAYLOAD = getWorkflowDefinition("decomposition").commitPayload;

function canApplyDecompositionTerminal(input) {
  return canApplyTerminal({ commitPayload: COMMIT_PAYLOAD, ...input });
}

test("valid commit passes the terminal gate", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
    }),
    { ok: true },
  );
});

test("decomposition declares exactly one Linear issue commit effect", () => {
  const { commit_effects } = getWorkflowDefinition("decomposition");
  assert.equal(commit_effects.length, 1);
  assert.equal(commit_effects[0].id, "linear_issues");
  assert.equal(commit_effects[0].provider, "linear");
  assert.equal(commit_effects[0].op, "create_issues");
  assert.equal(typeof commit_effects[0].probe, "function");
  assert.equal(typeof commit_effects[0].apply, "function");
  assert.equal(typeof commit_effects[0].verify, "function");
});

test("commit structural quality gate skips when the payload verdict returns null", () => {
  assert.deepEqual(
    canApplyTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
      commitPayload: { qualityGateInput: () => null },
    }),
    { ok: true },
  );
});

test("commit blocks when the payload returns a failing quality verdict", () => {
  assert.deepEqual(
    canApplyTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
      commitPayload: { qualityGateInput: () => ({ label: "needs_revision" }) },
    }),
    { ok: false, blocked_reason: "structural_output_contract_failed" },
  );
});

test("commit blocks when the structural output contract quality check fails", () => {
  const terminal_output = commitTerminalOutput({
    final_issues: [{ ...validFinalIssue(), acceptance_criteria: [] }],
  });

  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output,
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
    }),
    { ok: false, blocked_reason: "structural_output_contract_failed" },
  );
});

test("commit blocks when rounds exceed max rounds", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: { rounds_used: 6, max_rounds: 5 },
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
    }),
    { ok: false, blocked_reason: "round_bounds_exceeded" },
  );
});

test("commit blocks when agent write credentials are present", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: withinBounds(),
      environment: { agent_write_credentials_present: true },
      durable_record: writtenDurableRecord(),
    }),
    { ok: false, blocked_reason: "agent_write_credentials_present" },
  );
});

test("commit blocks when the durable record has not been written", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: commitTerminalOutput(),
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: { written: false },
    }),
    { ok: false, blocked_reason: "durable_record_not_written" },
  );
});

test("commit requires explicit proof that write credentials are absent", () => {
  for (const environment of [
    {},
    { agent_write_credentials_present: undefined },
    { agent_write_credentials_present: true },
  ]) {
    assert.deepEqual(
      canApplyDecompositionTerminal({
        terminal_output: commitTerminalOutput(),
        bounds: withinBounds(),
        environment,
        durable_record: writtenDurableRecord(),
      }),
      { ok: false, blocked_reason: "agent_write_credentials_present" },
    );
  }
});

test("failed_closed for bounds breach can pass even when rounds exceed max rounds", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: failedClosedTerminalOutput(),
      bounds: { rounds_used: 6, max_rounds: 5 },
      environment: { agent_write_credentials_present: true },
      durable_record: validNonCommitDurableRecord(),
    }),
    { ok: true },
  );
});

test("pause with empty or missing final issues passes when durable record is valid", () => {
  for (const terminal_output of [
    pauseTerminalOutput({ final_issues: [] }),
    pauseTerminalOutput(),
  ]) {
    assert.deepEqual(
      canApplyDecompositionTerminal({
        terminal_output,
        bounds: { rounds_used: 99, max_rounds: 1 },
        environment: { agent_write_credentials_present: true },
        durable_record: validNonCommitDurableRecord(),
      }),
      { ok: true },
    );
  }
});

test("non-commit terminal outcomes require a written schema-valid durable record", () => {
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: pauseTerminalOutput(),
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: { written: true, terminal_artifact_schema_valid: false },
    }),
    { ok: false, blocked_reason: "terminal_artifact_schema_invalid" },
  );
});

test("evidence is not a commit gate predicate", () => {
  const outputWithoutEvidence = commitTerminalOutput();
  const outputWithEmptyEvidence = commitTerminalOutput({ evidence: undefined });

  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: outputWithoutEvidence,
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
    }),
    { ok: true },
  );
  assert.deepEqual(
    canApplyDecompositionTerminal({
      terminal_output: outputWithEmptyEvidence,
      bounds: withinBounds(),
      environment: scrubbedEnvironment(),
      durable_record: writtenDurableRecord(),
    }),
    { ok: true },
  );
});

test("commit payload returns an offline quality verdict from final issues", () => {
  const finalIssue = {
    ...validFinalIssue(),
    depends_on: ["setup/base"],
  };
  const verdict = COMMIT_PAYLOAD.qualityGateInput({ final_issues: [finalIssue] });

  assert.equal(verdict.label, "pass");
  assert.equal(verdict.identifier, "decomposition_quality_offline_v1");
  assert.equal(verdict.metadata.issue_count, 1);
  assert.equal(verdict.metadata.dependency_count, 1);
});

test("commit payload verdict preserves decomposition structural failures", () => {
  const verdict = COMMIT_PAYLOAD.qualityGateInput({
    final_issues: [{ ...validFinalIssue(), acceptance_criteria: [] }],
  });

  assert.equal(verdict.label, "needs_revision");
  assert.deepEqual(verdict.metadata.failure_modes, ["missing_acceptance_criteria"]);
});

function commitTerminalOutput(overrides = {}) {
  return {
    outcome: "commit",
    reason: "synthesis_complete",
    final_issues: [validFinalIssue()],
    ...overrides,
  };
}

function pauseTerminalOutput(overrides = {}) {
  return {
    outcome: "pause",
    reason: "product_questions",
    ...overrides,
  };
}

function failedClosedTerminalOutput(overrides = {}) {
  return {
    outcome: "failed_closed",
    reason: "bounds_breach",
    ...overrides,
  };
}

function validFinalIssue() {
  return {
    decomposition_key: "setup/api",
    title: "Build setup API",
    issue_body_markdown: "## Assignment\n\nBuild the setup API.",
    depends_on: [],
    assignment: "Build the setup API.",
    output: "A working setup API.",
    acceptance_criteria: ["Setup API responds."],
  };
}

function withinBounds() {
  return { rounds_used: 3, max_rounds: 5 };
}

function scrubbedEnvironment() {
  return { agent_write_credentials_present: false };
}

function writtenDurableRecord() {
  return { written: true };
}

function validNonCommitDurableRecord() {
  return { written: true, terminal_artifact_schema_valid: true };
}
