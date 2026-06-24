// Control-action envelope (Seam 1 of the agent-driven-orchestrator breakdown).
//
// The free orchestrator agent drives the decomposition by emitting EXACTLY ONE
// control action per turn. This module defines that wire schema and the
// harness-side parser/validator. The harness validates ONLY this control
// envelope -- never a per-turn PAYLOAD schema (rev-14 trust-the-model): the
// orchestrator's authored output rides on the turn RESULT as `producedContent`,
// a sibling of the control action, and is gated only at the single commit.
//
// There are exactly THREE actions:
//   - invoke_library({ target_key })
//   - invoke_one_off({ role_label, task, prompt, runtime_role })
//   - terminate({ outcome, reason })
//
// This module is deliberately ROLE-AGNOSTIC about the run's flow: it knows
// nothing about an ordered sequence of steps. It carries no router vocabulary.

import {
  AGENT_CHOOSABLE_OUTCOME_REASONS,
} from "./orchestrator-terminal-vocabulary.mjs";

export const CONTROL_ACTION_SCHEMA_VERSION =
  "agentic-factory-orchestrator-control-action/v1";

// The three action kinds, frozen so callers can switch on a stable set.
export const CONTROL_ACTION_KINDS = Object.freeze([
  "invoke_library",
  "invoke_one_off",
  "terminate",
]);

// Fallback whitelist for callers that do not have a workflow definition in
// scope. The production loop threads definition.invocable_runtime_roles into
// parseControlAction so the run path is definition-derived without importing a
// provider registry into this engine module.
export const ONE_OFF_RUNTIME_ROLES = Object.freeze([
  "pm",
  "sr_eng",
  "judge",
  "drafter",
]);

// The terminal outcomes the ORCHESTRATOR itself may emit. `failed_closed` is
// NOT here: the harness emits it on a bounds/environment breach, never the
// orchestrator. The allowed (outcome -> reasons) pairs mirror the authored
// terminal contract (orchestrator-output.mjs ORCHESTRATOR_OUTCOME_REASONS) for
// the outcomes the agent is allowed to choose.
export const TERMINATE_OUTCOME_REASONS = AGENT_CHOOSABLE_OUTCOME_REASONS;

export const TERMINATE_OUTCOMES = Object.freeze(Object.keys(TERMINATE_OUTCOME_REASONS));

// invoke_one_off requires exactly these string fields (all non-empty); a fourth
// field, runtime_role, is constrained to the injected invocable runtime roles
// (falling back to ONE_OFF_RUNTIME_ROLES for legacy/direct callers). No other
// fields are required, and the parser tolerates additional descriptive fields on
// a one-off (the orchestrator may attach its own latitude metadata) -- the
// harness sanitizes/persists the one-off reference downstream (Seam 4, I-4).
const ONE_OFF_REQUIRED_STRING_FIELDS = Object.freeze([
  "role_label",
  "task",
  "prompt",
]);

// terminate is EXACTLY { outcome, reason } -- no extra fields. The parser
// REJECTS any additional key so a malformed terminate cannot smuggle a
// terminal-source control field (the breakdown cut `terminal_source_turn_id`:
// the terminating turn's producedContent is the terminal source, not a control
// field).
const TERMINATE_ALLOWED_KEYS = Object.freeze(["action", "outcome", "reason"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function reject(reasons) {
  return { ok: false, reasons: [...new Set(reasons)] };
}

function accept(action) {
  return { ok: true, action };
}

// Parse + validate a candidate control action. Returns a DISCRIMINATED result:
//   { ok: true,  action }              -- a normalized control action
//   { ok: false, reasons: string[] }   -- one or more rejection reasons
//
// The normalized action preserves the parsed fields plus its `action` kind, so
// the loop (I-2b) can switch on `action.action` and read the validated fields
// directly. Unknown/missing kinds and per-kind field violations reject.
export function parseControlAction(candidate, { invocableRoles = ONE_OFF_RUNTIME_ROLES } = {}) {
  if (!isRecord(candidate)) {
    return reject(["control_action_not_object"]);
  }

  const kind = candidate.action;
  if (!isNonEmptyString(kind)) {
    return reject(["control_action_missing_action"]);
  }
  if (!CONTROL_ACTION_KINDS.includes(kind)) {
    return reject([`control_action_unknown_action:${kind}`]);
  }

  if (kind === "invoke_library") return parseInvokeLibrary(candidate);
  if (kind === "invoke_one_off") return parseInvokeOneOff(candidate, { invocableRoles });
  return parseTerminate(candidate);
}

function parseInvokeLibrary(candidate) {
  const reasons = [];
  if (!isNonEmptyString(candidate.target_key)) {
    reasons.push("invoke_library_missing_target_key");
  }
  if (reasons.length > 0) return reject(reasons);
  return accept({
    action: "invoke_library",
    target_key: candidate.target_key.trim(),
  });
}

function parseInvokeOneOff(candidate, { invocableRoles = ONE_OFF_RUNTIME_ROLES } = {}) {
  const allowedRuntimeRoles = Array.isArray(invocableRoles)
    ? invocableRoles
    : ONE_OFF_RUNTIME_ROLES;
  const reasons = [];
  for (const field of ONE_OFF_REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(candidate[field])) {
      reasons.push(`invoke_one_off_missing_${field}`);
    }
  }
  if (!isNonEmptyString(candidate.runtime_role)) {
    reasons.push("invoke_one_off_missing_runtime_role");
  } else if (!allowedRuntimeRoles.includes(candidate.runtime_role.trim())) {
    reasons.push(`invoke_one_off_invalid_runtime_role:${candidate.runtime_role}`);
  }
  if (reasons.length > 0) return reject(reasons);
  return accept({
    action: "invoke_one_off",
    role_label: candidate.role_label.trim(),
    task: candidate.task,
    prompt: candidate.prompt,
    runtime_role: candidate.runtime_role.trim(),
  });
}

function parseTerminate(candidate) {
  const reasons = [];

  // terminate is EXACTLY { outcome, reason } (no extra fields). Reject any key
  // beyond the action discriminator + outcome + reason.
  for (const key of Object.keys(candidate)) {
    if (!TERMINATE_ALLOWED_KEYS.includes(key)) {
      reasons.push(`terminate_unexpected_field:${key}`);
    }
  }

  const outcomeIsString = isNonEmptyString(candidate.outcome);
  if (!outcomeIsString) {
    reasons.push("terminate_missing_outcome");
  } else if (!TERMINATE_OUTCOMES.includes(candidate.outcome.trim())) {
    reasons.push(`terminate_invalid_outcome:${candidate.outcome}`);
  }

  if (!isNonEmptyString(candidate.reason)) {
    reasons.push("terminate_missing_reason");
  } else if (outcomeIsString && TERMINATE_OUTCOMES.includes(candidate.outcome.trim())) {
    const allowed = TERMINATE_OUTCOME_REASONS[candidate.outcome.trim()];
    if (!allowed.includes(candidate.reason.trim())) {
      reasons.push(
        `terminate_invalid_reason:${candidate.outcome.trim()}:${candidate.reason.trim()}`,
      );
    }
  }

  if (reasons.length > 0) return reject(reasons);
  return accept({
    action: "terminate",
    outcome: candidate.outcome.trim(),
    reason: candidate.reason.trim(),
  });
}
