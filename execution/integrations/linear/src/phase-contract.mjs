import { requireAuthoredMarkdown } from "../../../engine/engine-markdown.mjs";

export const PHASE_PACKET_SCHEMA_VERSION = "linear-decomposition-phase-packet/v1";
export const DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID = "linear-decomposition-run-payload/v1";

// The decomposition function's own version, declared by the function (not sourced
// from an engine constant) — persisted as the run artifact's `function_version`.
// Homed here (a leaf contract module) so the definition can import it without
// pulling artifacts.mjs and closing a definition<->eval-paths import cycle. A
// second function declares its own; this is what lets the two versions diverge.
export const DECOMPOSITION_FUNCTION_VERSION = "0.2.0";

const COMMON_PACKET_ARRAY_FIELDS = ["source_refs", "assumptions", "constraints", "risks"];
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// The resume-after-questions packet contract. This is the LIVE resume workflow
// vocabulary (artifacts.mjs validateResumePacket -> resumeProjectAfterQuestions,
// run-service.mjs), NOT decomposition-phase-router vocabulary: a resume packet
// marks `phase: "resume"` only as a resume marker. It is intentionally kept when
// the phase router is retired.
export function validateResumePacketContract(packet) {
  const failureReasons = [];
  if (!packet) return { ok: false, failureReasons: ["missing_resume_packet"] };

  if (packet.phase !== "resume") failureReasons.push("expected_resume");
  validatePacketIdentity(packet, failureReasons);
  validateCommonPacketFields(packet, failureReasons);
  if (packet.status !== "continue") failureReasons.push("resume_must_continue");
  if (!packet.reason) failureReasons.push("missing_reason");
  requireAuthoredMarkdown(packet, "open_questions_markdown", failureReasons, {
    allowBlank: true,
  });
  requireAuthoredMarkdown(packet, "project_update_markdown", failureReasons, {
    allowBlank: false,
    runId: packet.run_id,
  });

  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}

// Identity + common-field checks shared by the resume packet contract. The
// schema-version check is local to this module's kept run-artifact schema
// version constant (its broader retirement is deferred to I-5b).
function validatePacketIdentity(packet, failureReasons, runId) {
  if (!packet.run_id) failureReasons.push("missing_run_id");
  else if (!SAFE_RUN_ID_PATTERN.test(packet.run_id)) failureReasons.push("invalid_run_id");
  if (runId && packet.run_id !== runId) failureReasons.push("run_id_mismatch");
  if (packet.schema_version !== PHASE_PACKET_SCHEMA_VERSION) {
    failureReasons.push("invalid_packet_schema_version");
  }
  if (!packet.status) failureReasons.push("missing_status");
  if (!packet.reason) failureReasons.push("missing_reason");
}

function validateCommonPacketFields(packet, failureReasons) {
  if (typeof packet.context_digest !== "string" || packet.context_digest.trim() === "") {
    failureReasons.push("missing_context_digest");
  }
  for (const field of COMMON_PACKET_ARRAY_FIELDS) {
    if (!Array.isArray(packet[field])) failureReasons.push(`missing_${field}`);
  }
}
