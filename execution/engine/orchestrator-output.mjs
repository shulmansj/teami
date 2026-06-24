import {
  ENGINE_VERSION,
} from "./engine-contract-constants.mjs";
import {
  hasRunIdLine,
  PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
  requireAuthoredMarkdown,
} from "./engine-markdown.mjs";
import {
  GENERIC_CORE_OUTCOMES,
  GENERIC_CORE_OUTCOME_REASONS,
} from "./orchestrator-terminal-vocabulary.mjs";

export const ORCHESTRATOR_OUTPUT_SCHEMA_VERSION =
  "agentic-factory-orchestrator-turn-output/v1";

export const ORCHESTRATOR_OUTCOMES = GENERIC_CORE_OUTCOMES;
export const ORCHESTRATOR_OUTCOME_REASONS = GENERIC_CORE_OUTCOME_REASONS;

const COMMON_PACKET_ARRAY_FIELDS = ["source_refs", "assumptions", "constraints", "risks"];
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateOrchestratorOutput(runResult, commitPayload = null) {
  const failureReasons = [];

  if (!isRecord(runResult)) {
    return { ok: false, failureReasons: ["missing_orchestrator_run_result"] };
  }

  if (!isRecord(runResult.terminal_output)) {
    failureReasons.push("missing_terminal_output");
  } else {
    validateTerminalOutput(runResult.terminal_output, failureReasons, commitPayload);
  }

  validateBounds(runResult.bounds, failureReasons);
  validateEvidence(runResult, failureReasons);

  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}

function validateTerminalOutput(terminalOutput, failureReasons, commitPayload) {
  if (terminalOutput.schema_version !== ORCHESTRATOR_OUTPUT_SCHEMA_VERSION) {
    failureReasons.push("invalid_orchestrator_output_schema_version");
  }
  // The per-turn `workflow_version` wire field is the engine's stamp (the engine
  // produces and validates every turn) — distinct from a function's persisted
  // `function_version`. Versioned by the engine.
  if (terminalOutput.workflow_version !== ENGINE_VERSION) {
    failureReasons.push("invalid_workflow_version");
  }

  validateRunId(terminalOutput, failureReasons);
  validateOutcomeReason(terminalOutput, failureReasons);
  validateAuditFields(terminalOutput, failureReasons);
  validateOutcomeRequiredFields(terminalOutput, failureReasons, commitPayload);
}

function validateRunId(terminalOutput, failureReasons) {
  if (typeof terminalOutput.run_id !== "string" || terminalOutput.run_id.trim() === "") {
    failureReasons.push("missing_run_id");
    return;
  }
  if (!SAFE_RUN_ID_PATTERN.test(terminalOutput.run_id)) {
    failureReasons.push("invalid_run_id");
  }
}

function validateOutcomeReason(terminalOutput, failureReasons) {
  if (!ORCHESTRATOR_OUTCOMES.includes(terminalOutput.outcome)) {
    failureReasons.push("invalid_outcome");
  }

  if (typeof terminalOutput.reason !== "string" || terminalOutput.reason.trim() === "") {
    failureReasons.push("missing_reason");
    return;
  }

  const allowedReasons = ORCHESTRATOR_OUTCOME_REASONS[terminalOutput.outcome];
  if (allowedReasons && !allowedReasons.includes(terminalOutput.reason)) {
    failureReasons.push(
      `invalid_outcome_reason:${terminalOutput.outcome}:${terminalOutput.reason}`,
    );
  }
}

function validateAuditFields(terminalOutput, failureReasons) {
  if (
    typeof terminalOutput.context_digest !== "string" ||
    terminalOutput.context_digest.trim() === ""
  ) {
    failureReasons.push("missing_context_digest");
  }
  for (const field of COMMON_PACKET_ARRAY_FIELDS) {
    if (!Array.isArray(terminalOutput[field])) failureReasons.push(`missing_${field}`);
  }
}

function validateOutcomeRequiredFields(terminalOutput, failureReasons, commitPayload) {
  if (terminalOutput.outcome === "commit") {
    validateInjectedCommitPayload(terminalOutput, failureReasons, commitPayload);
  }

  if (terminalOutput.outcome === "pause" || terminalOutput.outcome === "failed_closed") {
    requireProjectUpdateWithRunId(terminalOutput, failureReasons, {
      requireAccountabilitySection: true,
    });
    requireAuthoredMarkdown(terminalOutput, "open_questions_markdown", failureReasons, {
      allowBlank: false,
    });
  }
}

function validateInjectedCommitPayload(terminalOutput, failureReasons, commitPayload) {
  if (commitPayload === null) return;
  if (typeof commitPayload?.validateCommitPayload !== "function") {
    failureReasons.push("missing_commit_payload_validator");
    return;
  }
  const validation = commitPayload.validateCommitPayload(terminalOutput);
  if (Array.isArray(validation?.failureReasons)) {
    failureReasons.push(...validation.failureReasons);
    return;
  }
  if (validation?.ok !== true) failureReasons.push("commit_payload_invalid");
}

function requireProjectUpdateWithRunId(
  terminalOutput,
  failureReasons,
  { requireAccountabilitySection = false } = {},
) {
  requireAuthoredMarkdown(terminalOutput, "project_update_markdown", failureReasons, {
    allowBlank: false,
  });
  if (
    typeof terminalOutput.project_update_markdown === "string" &&
    typeof terminalOutput.run_id === "string" &&
    !hasRunIdLine(terminalOutput.project_update_markdown, terminalOutput.run_id)
  ) {
    failureReasons.push("project_update_markdown_missing_run_id");
  }
  if (
    requireAccountabilitySection &&
    typeof terminalOutput.project_update_markdown === "string" &&
    !terminalOutput.project_update_markdown.includes(PROJECT_UPDATE_ACCOUNTABILITY_HEADING)
  ) {
    failureReasons.push("project_update_markdown_missing_accountability_section");
  }
}

function validateBounds(bounds, failureReasons) {
  if (!isRecord(bounds)) {
    failureReasons.push("missing_bounds");
    return;
  }

  validateNonNegativeNumber(bounds, "rounds_used", failureReasons);
  validateNonNegativeNumber(bounds, "max_rounds", failureReasons);
  validateOptionalNonNegativeNumber(bounds, "wall_ms", failureReasons);
  validateOptionalNonNegativeNumber(bounds, "invocations", failureReasons);
}

function validateNonNegativeNumber(object, field, failureReasons) {
  if (typeof object[field] !== "number" || !Number.isFinite(object[field])) {
    failureReasons.push(`missing_bounds_${field}`);
    return;
  }
  if (object[field] < 0) failureReasons.push(`invalid_bounds_${field}`);
}

function validateOptionalNonNegativeNumber(object, field, failureReasons) {
  if (!Object.hasOwn(object, field)) return;
  if (typeof object[field] !== "number" || !Number.isFinite(object[field]) || object[field] < 0) {
    failureReasons.push(`invalid_bounds_${field}`);
  }
}

function validateEvidence(runResult, failureReasons) {
  if (!Object.hasOwn(runResult, "evidence") || runResult.evidence === undefined) return;

  const evidence = runResult.evidence;
  if (!isRecord(evidence)) {
    failureReasons.push("invalid_evidence");
    return;
  }

  if (!Array.isArray(evidence.perspectives_run)) {
    failureReasons.push("missing_evidence_perspectives_run");
  } else {
    validatePerspectivesRun(evidence.perspectives_run, failureReasons);
  }

  if (Object.hasOwn(evidence, "tool_events") && !Array.isArray(evidence.tool_events)) {
    failureReasons.push("invalid_evidence_tool_events");
  }

  if (Object.hasOwn(evidence, "evidence_unavailable")) {
    validateEvidenceUnavailable(evidence.evidence_unavailable, failureReasons);
  }
}

function validatePerspectivesRun(perspectivesRun, failureReasons) {
  for (const perspective of perspectivesRun) {
    if (!isRecord(perspective)) {
      failureReasons.push("invalid_evidence_perspective");
      continue;
    }
    if (typeof perspective.role !== "string" || perspective.role.trim() === "") {
      failureReasons.push("missing_evidence_perspective_role");
    }
    if (typeof perspective.outcome !== "string" || perspective.outcome.trim() === "") {
      failureReasons.push("missing_evidence_perspective_outcome");
    }
    if (
      Object.hasOwn(perspective, "evidence_ref") &&
      (typeof perspective.evidence_ref !== "string" || perspective.evidence_ref.trim() === "")
    ) {
      failureReasons.push("invalid_evidence_perspective_ref");
    }
  }
}

function validateEvidenceUnavailable(evidenceUnavailable, failureReasons) {
  if (!Array.isArray(evidenceUnavailable)) {
    failureReasons.push("invalid_evidence_unavailable");
    return;
  }
  for (const unavailable of evidenceUnavailable) {
    if (!isRecord(unavailable)) {
      failureReasons.push("invalid_evidence_unavailable_item");
      continue;
    }
    if (typeof unavailable.scope !== "string" || unavailable.scope.trim() === "") {
      failureReasons.push("missing_evidence_unavailable_scope");
    }
    if (typeof unavailable.reason !== "string" || unavailable.reason.trim() === "") {
      failureReasons.push("missing_evidence_unavailable_reason");
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
