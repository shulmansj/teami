import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "./orchestrator-turn-contract.mjs";

const PROJECT_BLOCK_MAX_BYTES = 64 * 1024;
const ENVELOPE_HARD_MAX_BYTES = 120 * 1024;
const TRUNCATION_MARKER = "[...truncated...]";
const DISCIPLINE_LINE =
  "Use ONLY the inlined project context and prior-turn digest; emit EXACTLY one JSON object matching the schema and nothing else — no prose; do not call tools.";

export function buildSubagentInvocationEnvelope({
  body,
  runId,
  role,
  task,
  project,
  allowedRepoPacket = [],
  priorDigest,
  allowedOutcomes,
} = {}) {
  const roleLine = valueText(role).trim();
  const projectBlock = truncateUtf8Text(
    JSON.stringify(orchestratorProjectSummary(project), null, 2),
    PROJECT_BLOCK_MAX_BYTES,
  );
  const allowedRepoPacketBlock = allowedRepoPacketText(allowedRepoPacket);
  const priorDigestBlock = digestText(priorDigest);
  const parts = [
    valueText(body).trim(),
    "",
    `run_id: ${valueText(runId).trim()}`,
    ...(roleLine ? [`role: ${roleLine}`] : []),
    "",
    "Task:",
    valueText(task).trim(),
    "",
    "Project context JSON (length-capped):",
    projectBlock,
    ...(allowedRepoPacketBlock
      ? [
          "",
          "Allowed repo packet (JSON):",
          allowedRepoPacketBlock,
        ]
      : []),
    ...(priorDigestBlock
      ? [
          "",
          "Prior accepted-turns digest:",
          priorDigestBlock,
        ]
      : []),
    "",
    "Allowed (status, reason) outcomes:",
    formatAllowedOutcomes(allowedOutcomes),
    "",
    "Required output — emit EXACTLY one raw JSON object (no markdown code fences) with these top-level fields:",
    `  schema_version: ${JSON.stringify(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION)}`,
    `  run_id: ${JSON.stringify(valueText(runId).trim())}`,
    "  status: one of the allowed statuses above",
    "  reason: the allowed reason that matches that status",
    "  context_digest: a concise paragraph summarizing what you assessed or produced",
    "  source_refs: array of strings (may be empty)",
    "  assumptions: array of strings (may be empty)",
    "  constraints: array of strings (may be empty)",
    "  risks: array of strings (may be empty)",
    "Include any role-specific fields your guidance calls for (e.g. final_issues, discovery_issues); do not add unrelated top-level fields.",
    "",
    DISCIPLINE_LINE,
  ];

  const envelope = parts.join("\n");
  const envelopeBytes = Buffer.byteLength(envelope, "utf8");
  if (envelopeBytes > ENVELOPE_HARD_MAX_BYTES) {
    throw new Error(
      `project envelope too large: ${envelopeBytes} bytes exceeds ${ENVELOPE_HARD_MAX_BYTES} byte argv ceiling after project block cap`,
    );
  }
  return envelope;
}

export function buildLibraryRolePurposeTask({ humanName, targetKey, objective } = {}) {
  const resolvedHumanName = valueText(humanName).trim() || "library subagent";
  const resolvedTargetKey = valueText(targetKey).trim() || "unknown_target";
  const resolvedObjective = valueText(objective).trim() || "No run objective was provided.";
  return `Run the ${resolvedHumanName} library role (${resolvedTargetKey}) for this decomposition objective: ${resolvedObjective}`;
}

function orchestratorProjectSummary(project) {
  const issues = Array.isArray(project?.issues)
    ? project.issues
    : Array.isArray(project?.existing_issues)
      ? project.existing_issues
      : [];
  return {
    id: project?.id ?? null,
    name: project?.name ?? null,
    description: project?.description ?? null,
    content: project?.content ?? null,
    status: project?.status ?? null,
    labels: (project?.labels || []).map((label) => ({
      id: label?.id ?? null,
      name: label?.name ?? null,
    })),
    issues: issues.map((issue) => ({
      id: issue?.id ?? null,
      identifier: issue?.identifier ?? null,
      title: issue?.title ?? null,
      state: issue?.state ?? null,
    })),
  };
}

function formatAllowedOutcomes(allowedOutcomes) {
  const tuples = allowedOutcomeTuples(allowedOutcomes);
  if (tuples.length === 0) return "- none provided";
  return tuples.map(({ status, reason }) => `- ${status} / ${reason}`).join("\n");
}

function allowedOutcomeTuples(allowedOutcomes) {
  if (Array.isArray(allowedOutcomes)) {
    return allowedOutcomes
      .map((outcome) => ({
        status: valueText(outcome?.status).trim(),
        reason: valueText(outcome?.reason).trim(),
      }))
      .filter((outcome) => outcome.status && outcome.reason);
  }
  if (!allowedOutcomes || typeof allowedOutcomes !== "object") return [];

  return Object.entries(allowedOutcomes).flatMap(([status, reasons]) => {
    if (!Array.isArray(reasons)) return [];
    return reasons
      .map((reason) => ({
        status: valueText(status).trim(),
        reason: valueText(reason).trim(),
      }))
      .filter((outcome) => outcome.status && outcome.reason);
  });
}

function digestText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return "";
  return valueText(value).trim();
}

function allowedRepoPacketText(allowedRepoPacket) {
  const packet = Array.isArray(allowedRepoPacket) ? allowedRepoPacket : [];
  if (packet.length === 0) return "";
  return JSON.stringify(packet, null, 2);
}

function valueText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return json === undefined ? String(value) : json;
}

function truncateUtf8Text(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const suffix = `\n${TRUNCATION_MARKER}`;
  const targetBytes = maxBytes - Buffer.byteLength(suffix, "utf8");
  let candidate = text.slice(0, Math.max(0, targetBytes));
  while (Buffer.byteLength(candidate, "utf8") > targetBytes) {
    candidate = candidate.slice(0, -1);
  }
  return `${candidate.trimEnd()}${suffix}`;
}
