// Complete list of structural failure-mode BASE ids this module can emit.
// The canonical taxonomy (execution/evals/decomposition/failure-taxonomy.json,
// structural.failure_modes) must contain exactly these ids;
// eval-contracts.test.mjs enforces the equivalence in both directions, so a
// new emission here fails CI until the taxonomy is updated alongside it.
// Parameterized diagnostics (for example `missing_context_digest:<phase>`)
// are normalized to their BASE id in metadata.failure_modes; the raw
// parameterized strings are preserved in metadata.failure_mode_details.
export const STRUCTURAL_FAILURE_MODES = Object.freeze([
  // evaluateDecompositionQualityOffline
  "missing_agent_ready_issues",
  "issue_not_independently_executable",
  "missing_acceptance_criteria",
  "missing_decomposition_key",
  "prose_dependency_instead_of_relation",
  "product_question_not_escalated",
  // evaluateAcceptedPacketSufficiencyOffline
  "missing_terminal_output",
  "missing_context_digest",
  "missing_source_refs",
  "missing_assumptions",
  "missing_constraints",
  "missing_risks",
  "missing_pause_open_questions",
  "missing_project_update",
  // evaluatePauseState
  "missing_pause_comment_content",
  "pause_project_not_attention_status",
]);

// The failure-taxonomy.json version these emissions are aligned with.
// eval-contracts.test.mjs asserts this matches the taxonomy file so the two
// cannot drift silently.
export const FAILURE_TAXONOMY_VERSION = "1.0.0";

// Label reconciliation with the canonical set (CONSTRAINTS #36, plan Track
// D2): the canonical quality label set is pass|needs_revision|blocking_failure,
// and these deterministic CODE evaluators emit only the pass|needs_revision
// subset. `blocking_failure` is deliberately NOT a code-emitted label in MVP:
// it is a trust judgment ("do not use this run as a regression example or
// process-change win without repair") that belongs to HUMAN/LLM quality
// annotations, while CODE checks report structural facts with binary or
// step-scaled scores. Deterministic check results are stored with
// annotator_kind CODE only — a storage format, never a third peer judge, and
// never spoofed as HUMAN or LLM (CONSTRAINTS #30). Tests pin this subset; a
// new code-emitted label is a process change to accepted behavior.
export const CODE_EMITTED_LABELS = Object.freeze(["pass", "needs_revision"]);

// Normalization contract: CODE evaluators may emit parameterized diagnostics
// of the form `<base_id>:<param>` (the param is a phase id today). The
// taxonomy stores only base ids; this helper maps any emission to its
// taxonomy id. Parameter detail belongs in annotation metadata
// (failure_mode_details), never in new taxonomy entries.
export function normalizeFailureMode(mode) {
  return String(mode).split(":")[0];
}

export function evaluateDecompositionQualityOffline({ issues, dependencies, assumptions = [] }) {
  const failureModes = [];

  if (!issues || issues.length === 0) {
    failureModes.push("missing_agent_ready_issues");
  }

  for (const issue of issues || []) {
    if (!nonEmptyString(issue.assignment) || !nonEmptyString(issue.output)) {
      failureModes.push("issue_not_independently_executable");
    }
    if (
      !Array.isArray(issue.acceptanceCriteria) ||
      issue.acceptanceCriteria.length === 0 ||
      !issue.acceptanceCriteria.every(nonEmptyString)
    ) {
      failureModes.push("missing_acceptance_criteria");
    }
    if (!nonEmptyString(issue.decompositionKey)) failureModes.push("missing_decomposition_key");
  }

  const proseDependencies = (issues || []).filter((issue) => issue.dependencyNote && !issue.dependsOn);
  if (proseDependencies.length > 0) {
    failureModes.push("prose_dependency_instead_of_relation");
  }

  if (assumptions.some((assumption) => assumption.kind === "product" && !assumption.escalated)) {
    failureModes.push("product_question_not_escalated");
  }

  const uniqueFailureModes = [...new Set(failureModes)];
  const score = Math.max(0, 1 - uniqueFailureModes.length * 0.2);

  return {
    name: "quality",
    annotator_kind: "CODE",
    identifier: "decomposition_quality_offline_v1",
    label: uniqueFailureModes.length === 0 ? "pass" : "needs_revision",
    score,
    explanation:
      uniqueFailureModes.length === 0
        ? "Issues preserve the required executable handoff shape."
        : `Detected decomposition quality gaps: ${uniqueFailureModes.join(", ")}`,
    metadata: {
      failure_modes: uniqueFailureModes,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
      issue_count: issues?.length || 0,
      dependency_count: dependencies?.length || 0,
    },
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function evaluateAcceptedPacketSufficiencyOffline({
  phasePackets = [],
  terminalOutput = undefined,
} = {}) {
  const failureModes = [];

  if (terminalOutput !== undefined) {
    collectTerminalOutputSufficiencyFailures(terminalOutput, failureModes);
  } else {
    collectPhasePacketSufficiencyFailures(phasePackets, failureModes);
  }

  const packetCount = Array.isArray(phasePackets) ? phasePackets.length : 0;
  const terminalOutputCount =
    terminalOutput !== undefined && isRecord(terminalOutput) ? 1 : 0;
  const uniqueFailureModeDetails = [...new Set(failureModes)];
  const normalizedFailureModes = [...new Set(uniqueFailureModeDetails.map(normalizeFailureMode))];
  return {
    name: "accepted_packet_sufficiency",
    annotator_kind: "CODE",
    identifier: "accepted_packet_sufficiency_offline_v1",
    label: uniqueFailureModeDetails.length === 0 ? "pass" : "needs_revision",
    score: uniqueFailureModeDetails.length === 0 ? 1 : 0,
    explanation:
      uniqueFailureModeDetails.length === 0
        ? "Accepted packets contain the serialized context needed for audit and commit retry."
        : `Accepted packet gaps: ${uniqueFailureModeDetails.join(", ")}`,
    metadata: {
      failure_modes: normalizedFailureModes,
      failure_mode_details: uniqueFailureModeDetails,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
      packet_count: packetCount,
      ...(terminalOutput !== undefined ? { terminal_output_count: terminalOutputCount } : {}),
    },
  };
}

function collectPhasePacketSufficiencyFailures(phasePackets, failureModes) {
  for (const packet of phasePackets || []) {
    if (!packet.context_digest) failureModes.push(`missing_context_digest:${packet.phase}`);
    for (const field of ["source_refs", "assumptions", "constraints", "risks"]) {
      if (!Array.isArray(packet[field])) failureModes.push(`missing_${field}:${packet.phase}`);
    }
    if (packet.status === "pause" && !packet.open_questions_markdown) {
      failureModes.push(`missing_pause_open_questions:${packet.phase}`);
    }
    if (
      packet.phase === "pm_synthesis" &&
      !packet.project_update_markdown
    ) {
      failureModes.push(`missing_project_update:${packet.phase}`);
    }
  }
}

function collectTerminalOutputSufficiencyFailures(terminalOutput, failureModes) {
  const detailSuffix = "orchestrator_output";
  if (!isRecord(terminalOutput)) {
    failureModes.push(`missing_terminal_output:${detailSuffix}`);
    return;
  }

  if (!terminalOutput.context_digest) {
    failureModes.push(`missing_context_digest:${detailSuffix}`);
  }
  for (const field of ["source_refs", "assumptions", "constraints", "risks"]) {
    if (!Array.isArray(terminalOutput[field])) {
      failureModes.push(`missing_${field}:${detailSuffix}`);
    }
  }

  if (
    (terminalOutput.outcome === "pause" || terminalOutput.outcome === "failed_closed") &&
    !terminalOutput.open_questions_markdown
  ) {
    failureModes.push(`missing_pause_open_questions:${detailSuffix}`);
  }
  if (
    ["commit", "failed_closed"].includes(terminalOutput.outcome) &&
    !terminalOutput.project_update_markdown
  ) {
    failureModes.push(`missing_project_update:${detailSuffix}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evaluatePauseState({ project, attentionStatusId, appIdentityId }) {
  const failureModes = [];
  const comment = latestAppAuthoredProjectComment(project?.comments, appIdentityId);
  const hasPauseCommentContent = typeof comment?.body === "string" && comment.body.trim() !== "";

  if (!hasPauseCommentContent) failureModes.push("missing_pause_comment_content");
  if (project?.status?.id !== attentionStatusId) failureModes.push("pause_project_not_attention_status");

  return {
    name: "pause_state_correctness",
    annotator_kind: "CODE",
    identifier: "pause_state_correctness_offline_v1",
    label: failureModes.length === 0 ? "pass" : "needs_revision",
    score: failureModes.length === 0 ? 1 : 0,
    explanation:
      failureModes.length === 0
        ? "Paused project has Principal Escalation status and an app-authored question comment."
        : `Pause state is incomplete: ${failureModes.join(", ")}`,
    metadata: {
      failure_modes: failureModes,
      failure_taxonomy_version: FAILURE_TAXONOMY_VERSION,
    },
  };
}

function latestAppAuthoredProjectComment(comments, appIdentityId) {
  if (!Array.isArray(comments) || typeof appIdentityId !== "string" || appIdentityId.trim() === "") {
    return null;
  }
  const authored = comments.filter((comment) => comment?.author_id === appIdentityId);
  return authored.length > 0 ? authored.at(-1) : null;
}
