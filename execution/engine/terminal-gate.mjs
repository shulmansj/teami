import { ORCHESTRATOR_OUTCOMES } from "./orchestrator-output.mjs";

const COMMIT_OUTCOME = "commit";
const NON_COMMIT_TERMINAL_OUTCOMES = new Set(
  ORCHESTRATOR_OUTCOMES.filter((outcome) => outcome !== COMMIT_OUTCOME),
);

const BLOCKED = Object.freeze({
  structuralOutputContract: "structural_output_contract_failed",
  bounds: "round_bounds_exceeded",
  agentWriteCredentials: "agent_write_credentials_present",
  durableRecordWritten: "durable_record_not_written",
  terminalArtifactSchema: "terminal_artifact_schema_invalid",
  unsupportedTerminalOutcome: "unsupported_terminal_outcome",
});

export function canApplyTerminal({
  terminal_output,
  bounds,
  environment,
  durable_record,
  commitPayload = null,
} = {}) {
  if (terminal_output?.outcome === COMMIT_OUTCOME) {
    // This is the single pre-effect commit gate: one structural check, one
    // bounds check, one contained-environment credential proof, and one durable
    // intent proof before the ordered provider effect list runs.
    if (!structuralOutputContractPasses(terminal_output, commitPayload)) {
      return blocked(BLOCKED.structuralOutputContract);
    }
    if (!withinBounds(bounds)) return blocked(BLOCKED.bounds);
    if (environment?.agent_write_credentials_present !== false) {
      return blocked(BLOCKED.agentWriteCredentials);
    }
    if (durable_record?.written !== true) return blocked(BLOCKED.durableRecordWritten);
    return { ok: true };
  }

  if (NON_COMMIT_TERMINAL_OUTCOMES.has(terminal_output?.outcome)) {
    if (durable_record?.written !== true) return blocked(BLOCKED.durableRecordWritten);
    if (durable_record?.terminal_artifact_schema_valid !== true) {
      return blocked(BLOCKED.terminalArtifactSchema);
    }
    return { ok: true };
  }

  return blocked(BLOCKED.unsupportedTerminalOutcome);
}

function structuralOutputContractPasses(terminalOutput, commitPayload) {
  if (typeof commitPayload?.qualityGateInput !== "function") return false;
  const verdict = commitPayload.qualityGateInput(terminalOutput);
  if (verdict === null) return true;
  return verdict?.label === "pass";
}

function withinBounds(bounds) {
  return (
    Number.isFinite(bounds?.rounds_used) &&
    Number.isFinite(bounds?.max_rounds) &&
    bounds.rounds_used <= bounds.max_rounds
  );
}

function blocked(blocked_reason) {
  return { ok: false, blocked_reason };
}
