import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ORCHESTRATOR_OUTCOMES,
  ORCHESTRATOR_OUTCOME_REASONS,
  ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
  validateOrchestratorOutput,
} from "../../../engine/orchestrator-output.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import { ENGINE_VERSION } from "../../../engine/engine-contract-constants.mjs";
import "../src/workflows/decomposition/definition.mjs";

const RUN_ID = "run-orch-u1";
const COMMIT_PAYLOAD = getWorkflowDefinition("decomposition").commitPayload;

function validate(runResult) {
  return validateOrchestratorOutput(runResult, COMMIT_PAYLOAD);
}

test("valid commit orchestrator output passes", () => {
  assert.deepEqual(ORCHESTRATOR_OUTCOMES, ["commit", "pause", "failed_closed"]);
  assert.deepEqual(ORCHESTRATOR_OUTCOME_REASONS.commit, ["synthesis_complete"]);
  assert.equal(ORCHESTRATOR_OUTPUT_SCHEMA_VERSION, "teami-orchestrator-turn-output/v1");

  const result = validate(validCommitRunResult());

  assert.deepEqual(result, { ok: true, failureReasons: [] });
});

test("turn-output generation schema id matches the runtime output schema version", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../schemas/orchestrator-turn-output.schema.json", import.meta.url),
    "utf8",
  ));

  assert.equal(schema.$id, ORCHESTRATOR_OUTPUT_SCHEMA_VERSION);
});

test("commit output missing structured fields fails", () => {
  const emptyFinalIssues = validCommitRunResult();
  emptyFinalIssues.terminal_output.final_issues = [];

  assert.deepEqual(validate(emptyFinalIssues), {
    ok: false,
    failureReasons: ["empty_final_issues"],
  });

  const missingStructuredFields = validCommitRunResult();
  const [issue] = missingStructuredFields.terminal_output.final_issues;
  delete issue.decomposition_key;
  delete issue.title;
  delete issue.issue_body_markdown;
  delete issue.depends_on;
  delete issue.assignment;
  delete issue.output;
  delete issue.acceptance_criteria;

  const result = validate(missingStructuredFields);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, [
    "missing_final_issue_decomposition_key",
    "missing_final_issue_title",
    "missing_final_issue_issue_body_markdown",
    "missing_final_issue_depends_on",
    "missing_final_issue_assignment",
    "missing_final_issue_output",
    "missing_final_issue_acceptance_criteria",
  ]);
});

test("commit output rejects non-string agent-ready fields", () => {
  const runResult = validCommitRunResult();
  const [issue] = runResult.terminal_output.final_issues;
  issue.assignment = {};
  issue.output = [];
  issue.acceptance_criteria = [{}];

  assert.deepEqual(validate(runResult), {
    ok: false,
    failureReasons: [
      "missing_final_issue_assignment",
      "missing_final_issue_output",
      "missing_final_issue_acceptance_criteria",
    ],
  });
});

test("commit output rejects duplicate, invalid, dangling, self, and cyclic final issue keys", () => {
  const duplicate = validCommitRunResult();
  duplicate.terminal_output.final_issues = [
    validFinalIssue({ decomposition_key: "project-plan", depends_on: [] }),
    validFinalIssue({ decomposition_key: "project-plan", title: "Duplicate plan", depends_on: [] }),
  ];
  assert.deepEqual(validate(duplicate), {
    ok: false,
    failureReasons: ["duplicate_decomposition_key"],
  });

  const invalid = validCommitRunResult();
  invalid.terminal_output.final_issues = [
    validFinalIssue({ decomposition_key: "project plan", depends_on: [] }),
  ];
  assert.deepEqual(validate(invalid), {
    ok: false,
    failureReasons: ["invalid_decomposition_key"],
  });

  const dangling = validCommitRunResult();
  dangling.terminal_output.final_issues = [
    validFinalIssue({ decomposition_key: "project-build", depends_on: ["project-plan"] }),
  ];
  assert.deepEqual(validate(dangling), {
    ok: false,
    failureReasons: ["unknown_dependency_key"],
  });

  const selfDependency = validCommitRunResult();
  selfDependency.terminal_output.final_issues = [
    validFinalIssue({ decomposition_key: "project-plan", depends_on: ["project-plan"] }),
  ];
  assert.deepEqual(validate(selfDependency), {
    ok: false,
    failureReasons: ["self_dependency_key", "cyclic_dependency_key"],
  });

  const cyclic = validCommitRunResult();
  cyclic.terminal_output.final_issues = [
    validFinalIssue({ decomposition_key: "project-plan", depends_on: ["project-build"] }),
    validFinalIssue({ decomposition_key: "project-build", title: "Build", depends_on: ["project-plan"] }),
  ];
  assert.deepEqual(validate(cyclic), {
    ok: false,
    failureReasons: ["cyclic_dependency_key"],
  });
});

test("commit output missing project update run_id line fails", () => {
  const runResult = validCommitRunResult();
  runResult.terminal_output.project_update_markdown = [
    "Completed without an audit id.",
    "",
    "## What I did with each part of your project",
    "- The update has accountability prose but no run id.",
  ].join("\n");

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["project_update_markdown_missing_run_id"]);
});

test("project update must include the accountability section", () => {
  const runResult = validCommitRunResult();
  runResult.terminal_output.project_update_markdown =
    `run_id: ${RUN_ID}\n\nCompleted without section-level accounting.`;

  assert.deepEqual(validate(runResult), {
    ok: false,
    failureReasons: ["project_update_markdown_missing_accountability_section"],
  });
});

test("pause output missing open questions fails", () => {
  const runResult = validPauseRunResult();
  delete runResult.terminal_output.open_questions_markdown;

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["missing_open_questions_markdown"]);
});

test("pause output does not require a project update", () => {
  const runResult = validPauseRunResult();
  delete runResult.terminal_output.project_update_markdown;

  assert.deepEqual(validate(runResult), { ok: true, failureReasons: [] });
});

test("failed_closed output missing note and questions fails", () => {
  const runResult = validFailedClosedRunResult();
  delete runResult.terminal_output.project_update_markdown;
  delete runResult.terminal_output.open_questions_markdown;

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, [
    "missing_project_update_markdown",
    "missing_open_questions_markdown",
  ]);
});

test("valid failed_closed output passes without commit-only final issues", () => {
  const runResult = validFailedClosedRunResult();

  const result = validate(runResult);

  assert.equal(runResult.terminal_output.final_issues, undefined);
  assert.deepEqual(result, { ok: true, failureReasons: [] });
});

test("subagent validation failure is an allowed harness failed_closed reason", () => {
  const runResult = validFailedClosedRunResult({
    reason: "subagent_turn_validation_failed",
    body: "A subagent turn failed validation after one repair retry.",
    questions: "- Should the failed subagent output be inspected before retry?",
  });

  assert.ok(ORCHESTRATOR_OUTCOME_REASONS.failed_closed.includes("subagent_turn_validation_failed"));
  assert.deepEqual(validate(runResult), { ok: true, failureReasons: [] });
});

test("reason must belong to the selected outcome", () => {
  const runResult = validCommitRunResult();
  runResult.terminal_output.reason = "product_questions";

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["invalid_outcome_reason:commit:product_questions"]);
});

test("empty reason fails", () => {
  const runResult = validCommitRunResult();
  runResult.terminal_output.reason = "";

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["missing_reason"]);
});

test("run_id must use the safe run id pattern", () => {
  const runResult = validCommitRunResult();
  runResult.terminal_output.run_id = "run id with spaces";
  runResult.terminal_output.project_update_markdown = [
    "run_id: run id with spaces",
    "",
    "Completed.",
    "",
    "## What I did with each part of your project",
    "- The project sections were accounted for.",
  ].join("\n");

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["invalid_run_id"]);
});

test("bounds require rounds_used and max_rounds", () => {
  const runResult = validCommitRunResult();
  runResult.bounds = { rounds_used: 1 };

  const result = validate(runResult);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["missing_bounds_max_rounds"]);
});

test("evidence is optional and does not rescue invalid terminal output", () => {
  const validWithoutEvidence = validCommitRunResult();
  delete validWithoutEvidence.evidence;

  assert.deepEqual(validate(validWithoutEvidence), {
    ok: true,
    failureReasons: [],
  });

  const invalidWithEvidence = validCommitRunResult({
    evidence: {
      perspectives_run: [
        { role: "pm", outcome: "continue", evidence_ref: "span-pm" },
        { role: "sr_eng", outcome: "continue", evidence_ref: "span-sr-eng" },
      ],
      tool_events: [{ kind: "read", path: "execution/linear-project.md" }],
      evidence_unavailable: [{ scope: "codex", reason: "runtime_did_not_emit_tool_events" }],
    },
  });
  invalidWithEvidence.terminal_output.context_digest = "";

  const result = validate(invalidWithEvidence);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failureReasons, ["missing_context_digest"]);
});

function validCommitRunResult(overrides = {}) {
  return {
    terminal_output: {
      ...baseTerminalOutput(),
      outcome: "commit",
      reason: "synthesis_complete",
      project_update_markdown: projectUpdateMarkdown(),
      final_issues: [validFinalIssue()],
    },
    bounds: { rounds_used: 3, max_rounds: 5 },
    ...overrides,
  };
}

function validPauseRunResult() {
  return {
    terminal_output: {
      ...baseTerminalOutput(),
      outcome: "pause",
      reason: "product_questions",
      open_questions_markdown: "- Which launch segment should this prioritize?",
    },
    bounds: { rounds_used: 2, max_rounds: 5 },
  };
}

function validFailedClosedRunResult({
  reason = "bounds_breach",
  body = "The run hit its round bound before a safe commit artifact was ready.",
  questions = "- Should the project be narrowed before retrying decomposition?",
} = {}) {
  return {
    terminal_output: {
      ...baseTerminalOutput(),
      outcome: "failed_closed",
      reason,
      project_update_markdown: projectUpdateMarkdown(body),
      open_questions_markdown: questions,
    },
    bounds: { rounds_used: 6, max_rounds: 5 },
  };
}

function baseTerminalOutput() {
  return {
    schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
    run_id: RUN_ID,
    workflow_version: ENGINE_VERSION,
    context_digest: "Project intent and constraints reviewed for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

function validFinalIssue(overrides = {}) {
  return {
    decomposition_key: "project-plan",
    title: "Prepare execution setup",
    issue_body_markdown: [
      "## Assignment",
      "",
      "Create the minimal execution setup needed for the Linear project.",
      "",
      "## Acceptance Criteria",
      "",
      "- Setup artifact exists.",
    ].join("\n"),
    depends_on: [],
    assignment: "Create the minimal execution setup needed for the Linear project.",
    output: "A checked-in setup artifact ready for implementation work.",
    acceptance_criteria: ["Setup artifact exists."],
    ...overrides,
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
