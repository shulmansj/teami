import { createHash } from "node:crypto";

export const REMEDIATION_MARKER_INFO_STRING = "af-remediation";
export const READINESS_REPAIR_REMEDIATION_KIND = "readiness_repair";

export function renderRemediationMarker(input = {}) {
  const marker = normalizeRemediationMarker(input);
  if (!marker) throw new Error("invalid_remediation_marker");
  return `\`\`\`${REMEDIATION_MARKER_INFO_STRING}\n${JSON.stringify(marker)}\n\`\`\`\n`;
}

export function parseRemediationMarker(description) {
  if (typeof description !== "string" || !description.includes(REMEDIATION_MARKER_INFO_STRING)) return null;

  const fencePattern = /(?:^|\n)```af-remediation[^\n]*\n(?<json>[\s\S]*?)\n```/g;
  for (const match of description.matchAll(fencePattern)) {
    try {
      const parsed = JSON.parse(String(match.groups?.json || "").trim());
      const normalized = normalizeRemediationMarker(parsed);
      if (normalized) return normalized;
    } catch {
      // AF-owned marker reads are tolerant: malformed blocks are treated as absent.
    }
  }
  return null;
}

export function remediationFailureSignature(seed = {}) {
  const normalized = {
    reason_codes: uniqueSorted(seed.reason_codes || seed.reasonCodes || seed.failure_reasons),
    missing: uniqueSorted(seed.missing),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")}`;
}

function normalizeRemediationMarker(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input.v;
  const kind = nonEmptyString(input.kind);
  const resourceId = nonEmptyString(input.resource_id || input.resourceId);
  const failureSignature = nonEmptyString(input.failure_signature || input.failureSignature);
  if (v !== 1 || kind !== READINESS_REPAIR_REMEDIATION_KIND || !resourceId || !failureSignature) {
    return null;
  }
  return {
    v: 1,
    kind,
    resource_id: resourceId,
    failure_signature: failureSignature,
  };
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
