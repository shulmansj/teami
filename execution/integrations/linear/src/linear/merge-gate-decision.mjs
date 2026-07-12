const SEND_BACK_STATUS_ROLES = new Set(["todo", "in_progress", "needs_principal"]);
const VALID_CHECK_STATES = new Set(["green", "red", "absent"]);
const VALID_PR_STATES = new Set(["open", "merged", "closed"]);

export function decideMergeGateAction(input = {}) {
  if (!isValidInputShape(input)) return surfaceUnrecognized(input);

  const status = input.issueStatusRole;
  const labelPresent = input.gateLabelPresent;
  const hasParkRecord = input.parkRecord !== null;
  const parkedHeadSha = hasParkRecord ? input.parkRecord.parked_head_sha : null;
  const headMatchesParked = hasParkRecord && parkedHeadSha === input.currentHeadSha;
  const greenAtCurrent = greenAt(input, input.currentHeadSha);
  const greenAtParked = hasParkRecord && greenAt(input, parkedHeadSha);

  if (status === "in_review") {
    if (hasParkRecord && input.prState === "closed") {
      return {
        action: "none",
        reason: "parked PR was closed without merging; delete the dead park record so the live PR is judged fresh",
        deleteParkRecord: true,
      };
    }
    if (greenAtCurrent && !labelPresent) {
      return {
        action: "merge",
        reason: "review passed at the current head and no human-review label is present",
      };
    }
    if (greenAtCurrent && labelPresent) {
      return {
        action: "park",
        reason: "review passed at the current head and the human-review label is present",
      };
    }
    if (input.checkState === "red" || input.checkState === "absent") {
      return {
        action: "none",
        reason: "review is not green at the current head; leave the review loop in control",
      };
    }
    return surfaceUnrecognized(input);
  }

  if (status === "human_review") {
    if (!hasParkRecord) {
      return {
        action: "surface",
        reason: "out of order: issue is in Principal Review but the factory did not park this head",
      };
    }
    if (input.prState === "closed") {
      return {
        action: "invalidate",
        reason: "parked PR was closed without merging while parked; move back to In Review",
      };
    }
    if (headMatchesParked && greenAtParked && labelPresent) {
      return {
        action: "none",
        reason: "parked head is still green and labeled; wait for human acceptance",
      };
    }
    if (headMatchesParked && greenAtParked && !labelPresent) {
      return {
        action: "merge",
        reason: "deliberate un-gate: human-review label was removed while parked",
      };
    }
    if (!headMatchesParked || input.checkState === "absent") {
      return {
        action: "invalidate",
        reason: "parked review is stale or missing; move back to In Review",
      };
    }
    return surfaceUnrecognized(input);
  }

  if (status === "done") {
    if (hasParkRecord) {
      if (input.prState === "merged") {
        if (headMatchesParked) {
          return {
            action: "none",
            reason: "parked head already landed; finish park-record cleanup",
            deleteParkRecord: true,
          };
        }
        if (labelPresent) {
          return {
            action: "surface",
            reason: "shipped outside the gate at a different head; keep surfacing until acknowledged",
          };
        }
        return {
          action: "none",
          reason: "different head already merged and the human-review label is absent; acknowledge and cleanup",
          deleteParkRecord: true,
        };
      }

      if (input.prState === "closed") {
        return {
          action: "bounce",
          bounceTo: "todo",
          reason: "PR was closed without merging after Done; move back to Todo",
        };
      }

      if (input.prState === "open") {
        if (headMatchesParked && greenAtParked) {
          return {
            action: "merge",
            reason: "human accepted the parked green head",
          };
        }
        if (!headMatchesParked || input.checkState === "absent") {
          return {
            action: "bounce",
            bounceTo: "in_review",
            reason: "parked head changed or review evidence is absent after Done; move back to In Review",
          };
        }
      }
    }
    return surfaceUnrecognized(input);
  }

  if (SEND_BACK_STATUS_ROLES.has(status) && hasParkRecord) {
    if (input.prState === "closed") {
      return {
        action: "none",
        reason: "parked PR was closed without merging during send-back; delete the dead park record",
        deleteParkRecord: true,
      };
    }
    return {
      action: "none",
      reason: "park record follows an in-flight send-back; leave it in place",
    };
  }

  return surfaceUnrecognized(input);
}

function isValidInputShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.gateLabelPresent !== true && input.gateLabelPresent !== false) return false;
  if (!VALID_CHECK_STATES.has(input.checkState)) return false;
  if (!VALID_PR_STATES.has(input.prState)) return false;
  if (input.parkRecord === null) return true;
  if (!input.parkRecord || typeof input.parkRecord !== "object" || Array.isArray(input.parkRecord)) return false;
  return isNonEmptyString(input.parkRecord.parked_head_sha) && Number.isInteger(input.parkRecord.pr_number);
}

function greenAt(input, headSha) {
  return input.checkState === "green" && isNonEmptyString(headSha) && input.checkHeadSha === headSha;
}

function surfaceUnrecognized(input) {
  return {
    action: "surface",
    reason: `unrecognized merge gate combination: ${describeCombination(input)}`,
  };
}

function describeCombination(input) {
  const parkRecord = input?.parkRecord;
  const parkedHeadSha = parkRecord && typeof parkRecord === "object" && !Array.isArray(parkRecord)
    ? parkRecord.parked_head_sha
    : null;
  return [
    `status=${formatValue(input?.issueStatusRole)}`,
    `label=${formatValue(input?.gateLabelPresent)}`,
    `record=${parkRecord === null ? "absent" : parkRecord ? "present" : formatValue(parkRecord)}`,
    `parked_head=${formatValue(parkedHeadSha)}`,
    `current_head=${formatValue(input?.currentHeadSha)}`,
    `check=${formatValue(input?.checkState)}@${formatValue(input?.checkHeadSha)}`,
    `pr=${formatValue(input?.prState)}`,
  ].join(", ");
}

function formatValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
