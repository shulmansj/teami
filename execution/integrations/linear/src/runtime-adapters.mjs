import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
  validateSubagentTurnContract,
} from "../../../engine/orchestrator-turn-contract.mjs";
import { getWorkflowDefinition } from "../../../engine/workflow-registry.mjs";
import {
  loadAcceptedRuntimeRoleDefaults,
} from "./config.mjs";
import { resolveWorkflowRuntime } from "./workflow-runtime-config.mjs";
import "./workflows/decomposition/definition.mjs";

export { extractRuntimeJsonCandidates } from "../../../engine/engine-runtime-json.mjs";

const DEFAULT_SCHEMA_PATH = path.join(
  "execution",
  "integrations",
  "linear",
  "schemas",
  "phase-packet.schema.json",
);
export const DEFAULT_SUBAGENT_SCHEMA_PATH = path.join(
  "execution",
  "integrations",
  "linear",
  "schemas",
  "subagent-turn.schema.json",
);

// Repo root for resolving the repo-relative default schema path off-cwd
// (this module lives at execution/integrations/linear/src/).
const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

// Judge output generation schema (absolute: the schema is repo-owned content
// that ships next to this module, so command builders resolve it correctly
// even when process.cwd()/repoRoot is an adopter checkout or a test temp dir).
export const JUDGE_OUTPUT_SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "schemas",
  "decomposition-quality-judge-output.schema.json",
);

const FORBIDDEN_AUTOMATION_FLAGS = new Set(["--last", "--continue"]);

// The runtime roles the orchestrator can resolve a runtime for come from the
// decomposition workflow definition: the invocable subagent roles plus the
// driver role. All roles resolve through the SAME per-role config conventions +
// adapter layer (workflows.decomposition.roles.<role> + runtime.adapters), via
// the shared normalizeRoleAssignment. The orchestrator is a normal tunable
// persona, not a bespoke engine slot.
export function deriveResolvableRuntimeRoles(definition = getWorkflowDefinition("decomposition")) {
  return Object.freeze([...definition.runtime_assignment_roles]);
}

export const RESOLVABLE_RUNTIME_ROLES = deriveResolvableRuntimeRoles();

export function resolveRoleRuntimeAssignments(config, workflowType) {
  if (typeof workflowType !== "string" || workflowType.trim() === "") {
    throw new Error("resolveRoleRuntimeAssignments_workflow_type_required");
  }
  const definition = getWorkflowDefinition(workflowType);
  const runtimeConfig = resolveWorkflowRuntime(config, workflowType);
  const roles = runtimeConfig.roles || {};
  const adapters = runtimeConfig.adapters || {};
  const defaultRuntime = runtimeConfig.default_runtime || "codex";
  const engineOwnedEvaluatorRoles = engineOwnedEvaluatorRoleSet(definition);
  const resolvableRoles = deriveResolvableRuntimeRoles(definition);

  const assignments = {};
  for (const role of resolvableRoles) {
    const roleConfig = engineOwnedEvaluatorRoles.has(role)
      ? factoryOwnedRoleConfig({ config, workflowType, role, roleConfig: roles[role] })
      : roles[role];
    assignments[role] = normalizeRoleAssignment({
      role,
      roleConfig,
      adapters,
      defaultRuntime,
    });
  }
  return assignments;
}

// Judge runtime assignment: the quality model judge reuses the
// SAME per-role runtime config conventions and adapter layer as the pm/sr_eng
// roles (workflows.decomposition.roles.judge + runtime.adapters), but is a
// single one-shot session_start call: warm continuation never applies, and
// the generation schema defaults to the judge output schema instead of the
// subagent-turn schema. The normalized tool policy hardcodes
// linear_write:false like every other role; the judge module additionally
// never constructs a Linear client at all (CONSTRAINTS #27).
export function resolveJudgeRuntimeAssignment(config, definition = getWorkflowDefinition("decomposition")) {
  const workflowType = definition?.workflow_type || "decomposition";
  const role = engineOwnedEvaluatorRuntimeRole(definition);
  const runtimeConfig = resolveWorkflowRuntime(config, workflowType);
  const roleConfig = factoryOwnedRoleConfig({
    config,
    workflowType,
    role,
    roleConfig: runtimeConfig.roles?.[role],
  });
  const assignment = normalizeRoleAssignment({
    role,
    roleConfig,
    adapters: runtimeConfig.adapters || {},
    defaultRuntime: runtimeConfig.default_runtime || "codex",
  });
  return {
    ...assignment,
    // Judge output schema, not the subagent-turn schema the adapters default to.
    schema_path: roleConfig.schema_path || JUDGE_OUTPUT_SCHEMA_PATH,
    generation_schema_path:
      roleConfig.generation_schema_path || roleConfig.schema_path || JUDGE_OUTPUT_SCHEMA_PATH,
    // One-shot judgment call: warm continuation is structurally not used.
    warm_continuation: { enabled: false, required: false },
  };
}

// Build per-role runtime metadata for the run artifact. The orchestrator model
// carries the invoked role on each subagent turn directly (the input entries are
// `{ role, run_id }`), so metadata is grouped BY THAT ROLE — not by a positional
// role lookup. Only roles that actually produced a turn get a metadata entry, so
// resolving the full role roster (pm|sr_eng|judge|drafter|orchestrator) never
// pollutes the artifact with metadata for roles the run did not invoke.
//
// The orchestrator model is INDEPENDENT session_start subagent invocations — NO
// warm continuation. The orchestrator legitimately invokes the same role more
// than once (e.g. pm for sufficiency then synthesis), and each invocation is its
// own session_start (executeSubagent runs session_start per call, emitting only
// evidence_unavailable). So a repeat same-role call is NOT a warm-continuation
// requirement and must NOT throw at artifact assembly: this records HONEST
// session_start metadata. (session_handle / handle_acquisition_mode are still
// recorded when the evidence happens to carry them, but are never required. The
// recorded schema_version is the subagent turn's wire-format version constant; it
// is a kept survivor of the retirement, not dead phase vocabulary.)
export function buildRuntimeMetadata({
  acceptedPackets,
  runtimeAssignments,
  runtimeEvidence = {},
  driverSessionHandle = null,
} = {}) {
  const metadata = {};
  const packetsByRole = new Map();
  for (const packet of acceptedPackets || []) {
    const role = typeof packet?.role === "string" ? packet.role : null;
    if (!role) continue;
    if (!packetsByRole.has(role)) packetsByRole.set(role, []);
    packetsByRole.get(role).push(packet);
  }

  for (const [role, rolePackets] of packetsByRole) {
    const assignment = runtimeAssignments?.[role];
    if (!assignment) continue;
    const evidence = rolePackets.length > 0 ? runtimeEvidence?.[role] || {} : {};

    const sessionHandle = evidence.session_handle || null;
    const handleAcquisitionMode = evidence.handle_acquisition_mode || null;

    metadata[role] = {
      role,
      runtime_name: assignment.runtime,
      model: assignment.model,
      continuation_requirement: "independent_session_start",
      continuation_capability_flags: {
        warm_continuation_required: false,
        warm_continuation_ready: false,
        persisted_session_handles: Boolean(assignment.capabilities.persisted_session_handles),
        structured_output_mode: true,
        tool_policy_controls: true,
      },
      session_handle: sessionHandle,
      last_accepted_role: role,
      structured_output_validation: "local_canonical",
      schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
      handle_acquisition_mode: handleAcquisitionMode,
      invocation_mode: "session_start",
      observed_warm_continuation: false,
      tool_policy: assignment.tool_policy,
    };
  }
  const driverHandle = normalizeRuntimeSessionHandle(driverSessionHandle);
  if (driverHandle) {
    const role = driverHandle.role;
    const assignment = runtimeAssignments?.[role] || null;
    metadata[role] = {
      role,
      runtime_name: assignment?.runtime || driverHandle.runtime,
      model: assignment?.model || null,
      continuation_requirement: "driver_session_handle",
      continuation_capability_flags: {
        warm_continuation_required: assignment?.warm_continuation?.required === true,
        warm_continuation_ready: false,
        persisted_session_handles: Boolean(assignment?.capabilities?.persisted_session_handles),
        structured_output_mode: true,
        tool_policy_controls: true,
      },
      session_handle: driverHandle,
      last_accepted_role: role,
      structured_output_validation: "local_canonical",
      schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
      handle_acquisition_mode: "runtime_session_handle",
      invocation_mode: "session_start",
      observed_warm_continuation: false,
      tool_policy: assignment?.tool_policy || {},
    };
  }
  return metadata;
}

export function buildSessionStartRuntimeCommand({
  assignment,
  prompt,
  promptPath,
  schemaPath,
  repoRoot = process.cwd(),
} = {}) {
  if (!assignment) throw new Error("runtime assignment is required.");
  assertRuntimeCommandPrompt(prompt, promptPath);
  assertRunnerOnlyToolPolicy(assignment);
  if (assignment.runtime === "codex") {
    return buildCodexSessionStartCommand({ assignment, prompt, promptPath, schemaPath, repoRoot });
  }
  if (assignment.runtime === "claude") {
    return buildClaudeSessionStartCommand({ assignment, prompt, promptPath, schemaPath, repoRoot });
  }
  throw new Error(`Unsupported decomposition runtime: ${assignment.runtime}`);
}

export function buildCodexSessionStartCommand({
  assignment,
  prompt,
  promptPath,
  schemaPath,
  repoRoot = process.cwd(),
} = {}) {
  assertRunnerOnlyToolPolicy(assignment);
  if (promptPath) {
    throw new Error("Codex exec prompt files are not supported by the installed CLI; pass prompt text or stdin.");
  }
  const canonicalSchemaPath = assignment.schema_path || DEFAULT_SCHEMA_PATH;
  const generationSchemaPath =
    schemaPath || assignment.generation_schema_path || canonicalSchemaPath;
  const generationSchemaCliPath = resolveCliFilePath(generationSchemaPath, repoRoot);
  const args = [...cliPrefixArgs(assignment), "exec"];
  args.push(...toolPolicyToFlags({
    runtime: "codex",
    toolPolicy: assignment.tool_policy,
    capability: assignment.capability,
  }));
  if (assignment.model) args.push("--model", assignment.model);
  args.push("--output-schema", generationSchemaCliPath);
  args.push("--", prompt);

  assertNoForbiddenAutomationShortcut(args);
  return {
    runtime: "codex",
    mode: "session_start",
    command: assignment.command || "codex",
    args,
    schema_path: canonicalSchemaPath,
    generation_schema_path: generationSchemaPath,
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    validation_method: "runtime_structured_output_plus_local_canonical",
    tool_policy: assignment.tool_policy,
  };
}

export function buildClaudeSessionStartCommand({
  assignment,
  prompt,
  promptPath,
  schemaPath,
  repoRoot = process.cwd(),
} = {}) {
  assertRunnerOnlyToolPolicy(assignment);
  const canonicalSchemaPath = assignment.schema_path || DEFAULT_SCHEMA_PATH;
  const generationSchemaPath =
    schemaPath || assignment.generation_schema_path || canonicalSchemaPath;
  const args = [
    ...cliPrefixArgs(assignment),
    ...toolPolicyToFlags({
      runtime: "claude",
      toolPolicy: assignment.tool_policy,
      capability: assignment.capability,
    }),
    "-p",
  ];
  if (promptPath) args.push(`@${promptPath}`);
  else args.push(prompt);
  if (assignment.model) args.push("--model", assignment.model);
  args.push("--output-format", "json", "--json-schema", readJsonSchemaForCli(generationSchemaPath, repoRoot));

  assertNoForbiddenAutomationShortcut(args);
  return {
    runtime: "claude",
    mode: "session_start",
    command: assignment.command || "claude",
    args,
    schema_path: canonicalSchemaPath,
    generation_schema_path: generationSchemaPath,
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    validation_method: "runtime_structured_output_plus_local_canonical",
    tool_policy: assignment.tool_policy,
  };
}

export function warmContinuationReady({ assignment, smokeTests = {}, runtimeVersion = null } = {}) {
  if (!assignment?.warm_continuation?.enabled || !assignment?.warm_continuation?.required) {
    return false;
  }
  if (!runtimeVersion) return false;
  const smokeKey = runtimeAssignmentSmokeKey(assignment, runtimeVersion);
  const result = smokeTests?.[smokeKey];
  return Boolean(
    result?.warm_continuation === true &&
      result?.schema_output === true &&
      result?.explicit_handle === true &&
      result?.runtime_version === runtimeVersion &&
      result?.assignment_key === runtimeAssignmentConfigKey(assignment),
  );
}

export function buildWarmRuntimeCommand({
  assignment,
  role,
  runId,
  sessionHandle,
  prompt,
  promptPath,
  schemaPath,
  smokeTests,
  runtimeVersion,
  repoRoot = process.cwd(),
} = {}) {
  if (!assignment) throw new Error("runtime assignment is required.");
  assertRunnerOnlyToolPolicy(assignment);
  assertRuntimeCommandPrompt(prompt, promptPath);
  if (!assignment.warm_continuation?.enabled || !assignment.warm_continuation?.required) {
    throw new Error("Warm continuation is required for live decomposition runs; config disabled it.");
  }
  if (!warmContinuationReady({ assignment, smokeTests, runtimeVersion })) {
    throw new Error("Warm continuation is required but has not passed assignment/version-keyed smoke tests.");
  }
  if (!sessionHandle?.id) {
    throw new Error("Warm continuation handle id is required.");
  }
  if (
    sessionHandle.role !== role ||
    sessionHandle.run_id !== runId ||
    sessionHandle.runtime !== assignment.runtime
  ) {
    throw new Error("Warm continuation handle must match the requested role, run_id, and runtime.");
  }
  const canonicalSchemaPath = assignment.schema_path || DEFAULT_SCHEMA_PATH;
  const generationSchemaPath =
    schemaPath || assignment.generation_schema_path || canonicalSchemaPath;
  const args = warmArgsForRuntime({
    assignment,
    sessionId: sessionHandle.id,
    prompt,
    promptPath,
    schemaPath: generationSchemaPath,
    repoRoot,
  });
  assertNoForbiddenAutomationShortcut(args);
  return {
    runtime: assignment.runtime,
    mode: "warm_required",
    command: assignment.command || assignment.runtime,
    args,
    schema_path: canonicalSchemaPath,
    generation_schema_path: generationSchemaPath,
    schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    validation_method:
      assignment.runtime === "codex"
        ? "required_resume_plus_local_canonical"
        : "runtime_structured_output_plus_local_canonical",
    tool_policy: assignment.tool_policy,
  };
}

export function buildRuntimeVersionCommand(assignment) {
  if (!assignment?.runtime) throw new Error("runtime assignment is required.");
  return {
    runtime: assignment.runtime,
    mode: "version",
    command: assignment.command || assignment.runtime,
    args: ["--version"],
  };
}

export function parseRuntimeVersionOutput(output, { runtime = "runtime" } = {}) {
  const text = String(output || "").trim();
  const semantic = text.match(/\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?)\b/);
  if (!semantic?.[1]) {
    throw new Error(`Could not detect semantic version from ${runtime} --version output.`);
  }
  return semantic[1];
}

export function runtimeAssignmentSmokeKey(assignment, runtimeVersion) {
  if (!runtimeVersion) throw new Error("runtime version is required for smoke keying.");
  return `runtime-smoke:${hashJson(runtimeAssignmentSmokeIdentity(assignment, runtimeVersion))}`;
}

export function runtimeAssignmentConfigKey(assignment) {
  return hashJson(runtimeAssignmentSmokeIdentity(assignment, null));
}

export function runtimeAssignmentSmokeIdentity(assignment, runtimeVersion = null) {
  if (!assignment?.runtime) throw new Error("runtime assignment is required.");
  return {
    runtime: assignment.runtime,
    command: assignment.command || assignment.runtime,
    model: assignment.model || null,
    cli_args_prefix: cliPrefixArgs(assignment),
    schema_path: assignment.schema_path || DEFAULT_SUBAGENT_SCHEMA_PATH,
    generation_schema_path:
      assignment.generation_schema_path || assignment.schema_path || DEFAULT_SUBAGENT_SCHEMA_PATH,
    subagent_turn_schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    capabilities: {
      persisted_session_handles: assignment.capabilities?.persisted_session_handles === true,
    },
    tool_policy: stableJsonValue(assignment.tool_policy || {}),
    runtime_version: runtimeVersion,
  };
}

function warmArgsForRuntime({ assignment, sessionId, prompt, promptPath, schemaPath, repoRoot }) {
  if (assignment.runtime === "codex") {
    if (promptPath) {
      throw new Error("Codex resume prompt files are not supported by the installed CLI; pass prompt text or stdin.");
    }
    const args = [...cliPrefixArgs(assignment), "exec", "resume"];
    if (assignment.model) args.push("--model", assignment.model);
    args.push("--", sessionId, prompt);
    return args;
  }

  if (assignment.runtime === "claude") {
    const args = [...cliPrefixArgs(assignment), "--resume", sessionId, "-p"];
    if (promptPath) args.push(`@${promptPath}`);
    else args.push(prompt);
    if (assignment.model) args.push("--model", assignment.model);
    args.push("--output-format", "json", "--json-schema", readJsonSchemaForCli(schemaPath, repoRoot));
    return args;
  }

  throw new Error(`Unsupported decomposition runtime: ${assignment.runtime}`);
}

function assertRunnerOnlyToolPolicy(assignment) {
  if (assignment.tool_policy?.linear_write !== false) {
    throw new Error("runtime adapters must not grant Linear write access to decomposition agents.");
  }
}

export function toolPolicyToFlags({ runtime, toolPolicy, capability } = {}) {
  void toolPolicy;
  if (capability) return [];
  if (runtime === "claude") return ["--allowedTools", ""];
  if (runtime === "codex") return ["-s", "read-only"];
  throw new Error(`Unsupported decomposition runtime: ${runtime}`);
}

export function assertNoForbiddenAutomationShortcut(args) {
  for (const arg of args || []) {
    if ([...FORBIDDEN_AUTOMATION_FLAGS].some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`))) {
      throw new Error(`Forbidden runtime automation shortcut: ${arg}`);
    }
  }
  return true;
}

// The canonical runtime structured-output schema is the repo-owned legacy packet
// schema, kept for non-subagent readers during retirement. Read it from disk
// rather than reconstructing it in code.
export function canonicalRuntimeSchema() {
  const schemaPath = resolveCliFilePath(DEFAULT_SCHEMA_PATH, MODULE_REPO_ROOT);
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

// Parse + validate a subagent turn. Role-agnostic: the orchestrator invokes
// subagents by role/prompt (no ordered position), so the turn is judged by the
// role-agnostic subagent-turn contract (Seam 2), not the retired
// position-coupled contract.
export function parseAndValidateRuntimePacketOutput(output, { runId } = {}) {
  const candidates = runtimePacketCandidates(output);
  if (candidates.length === 0) {
    throw new Error("Runtime packet failed local validation: invalid JSON output.");
  }
  let firstFailure = null;
  const validPackets = [];
  for (const candidate of candidates) {
    const packet = unwrapRuntimePacketCandidate(candidate);
    const validation = validateSubagentTurnContract(packet, { runId });
    if (validation.ok) {
      validPackets.push(packet);
      continue;
    }
    firstFailure ||= validation.failureReasons;
  }
  if (validPackets.length === 0) {
    throw new Error(`Runtime packet failed local validation: ${(firstFailure || ["no_valid_subagent_turn"]).join(", ")}`);
  }
  const uniquePackets = new Map(validPackets.map((packet) => [hashJson(packet), packet]));
  if (uniquePackets.size > 1) {
    throw new Error("Runtime packet failed local validation: ambiguous_runtime_packet_output.");
  }
  return uniquePackets.values().next().value;
}

export function strictParseSubagentTurn(output, { runId } = {}) {
  let candidate;
  try {
    candidate = JSON.parse(output);
  } catch {
    return {
      ok: false,
      clean_parse: false,
      failureReasons: ["unclean_runtime_output"],
    };
  }

  // STRICT unwrap (no fence-salvage on the subagent path: clean means a
  // DIRECT parse, never a downstream-laundered fenced/prose result). A claude wrapper's
  // `.result` must itself be a RAW JSON object; a markdown-fenced or prose-wrapped
  // `.result` is NOT clean and triggers the upstream repair. (The shared lenient
  // runtime parser keeps fence-stripping for its other callers.)
  let packet;
  if (candidate?.structured_output) {
    packet = candidate.structured_output;
  } else if (typeof candidate?.result === "string") {
    try {
      packet = JSON.parse(candidate.result.trim());
    } catch {
      return { ok: false, clean_parse: false, failureReasons: ["fenced_or_prose_result"] };
    }
  } else {
    packet = candidate;
  }
  const validation = validateSubagentTurnContract(packet, { runId });
  if (!validation.ok) {
    return {
      ok: false,
      clean_parse: true,
      failureReasons: validation.failureReasons,
    };
  }
  return {
    ok: true,
    packet,
    clean_parse: true,
  };
}

// Generic structured-output candidate extraction, shared with the judge
// wrapper: the same unwrapping rules phase-packet parsing uses (raw JSON,
// structured_output envelopes, result strings with optional code fences,
// embedded JSON objects inside mixed runtime logs) without the
// packet-specific contract validation.
function runtimePacketCandidates(output) {
  if (typeof output !== "string") return [output];
  try {
    return [JSON.parse(output)];
  } catch {
    return extractJsonObjects(output);
  }
}

function unwrapRuntimePacketCandidate(candidate) {
  if (candidate?.structured_output) return candidate.structured_output;
  if (typeof candidate?.result === "string") return parseRuntimeResultText(candidate.result);
  return candidate;
}

function parseRuntimeResultText(result) {
  const trimmed = result.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

export function extractRuntimeSessionHandle(output, { role, runId, runtime } = {}) {
  const id = runtimeSessionId(output);
  if (!id || !role || !runId || !runtime) return null;
  return { id, role, run_id: runId, runtime };
}

function normalizeRuntimeSessionHandle(handle) {
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) return null;
  const id = stringOrNull(handle.id);
  const role = stringOrNull(handle.role);
  const runId = stringOrNull(handle.run_id);
  const runtime = stringOrNull(handle.runtime);
  if (!id || !role || !runId || !runtime) return null;
  return { id, role, run_id: runId, runtime };
}

function runtimeSessionId(output) {
  for (const candidate of runtimePacketCandidates(output)) {
    const id =
      candidate?.session_id ||
      candidate?.sessionId ||
      candidate?.conversation_id ||
      candidate?.conversationId ||
      candidate?.thread_id ||
      candidate?.threadId;
    if (typeof id === "string" && id.trim() !== "") return id.trim();
  }
  if (typeof output !== "string") return null;
  const match =
    output.match(/\bsession id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12,})\b/i) ||
    output.match(/\bsession[_ -]?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12,})\b/i);
  return match?.[1] || null;
}

function extractJsonObjects(text) {
  const objects = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = findJsonObjectEnd(text, start);
    if (end < 0) continue;
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // Keep scanning; runtime logs may include brace-like text before the packet.
    }
  }
  return objects;
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeRoleAssignment({ role, roleConfig = {}, adapters, defaultRuntime }) {
  const runtime = roleConfig.runtime || defaultRuntime;
  const adapter = adapters[runtime] || {};
  return {
    role,
    runtime,
    model: roleConfig.model || adapter.model || null,
    command: roleConfig.command || adapter.command || runtime,
    cli_args_prefix: roleConfig.cli_args_prefix || adapter.cli_args_prefix || [],
    schema_path: roleConfig.schema_path || adapter.schema_path || DEFAULT_SUBAGENT_SCHEMA_PATH,
    generation_schema_path:
      roleConfig.generation_schema_path || adapter.generation_schema_path || roleConfig.schema_path || adapter.schema_path || DEFAULT_SUBAGENT_SCHEMA_PATH,
    local_schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
    warm_continuation: {
      enabled: roleConfig.warm_continuation?.enabled === true,
      required: roleConfig.warm_continuation?.required === true,
    },
    capabilities: {
      persisted_session_handles: roleConfig.capabilities?.persisted_session_handles === true,
    },
    version: roleConfig.version || adapter.version || null,
    tool_policy: {
      ...(roleConfig.tool_policy || {}),
      ...(adapter.tool_policy || {}),
      linear_write: false,
      project_mutation: "runner_only",
      issue_mutation: "runner_only",
    },
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function engineOwnedEvaluatorRoleSet(definition = getWorkflowDefinition("decomposition")) {
  return new Set(
    (definition.engine_owned_evaluator_roles || [])
      .filter((role) => typeof role === "string" && role.trim() !== ""),
  );
}

function engineOwnedEvaluatorRuntimeRole(definition = getWorkflowDefinition("decomposition")) {
  const [role] = engineOwnedEvaluatorRoleSet(definition);
  if (!role) throw new Error(`engine_owned_evaluator_runtime_role_missing:${definition?.workflow_type || "unknown"}`);
  return role;
}

function factoryOwnedRoleConfig({ config, workflowType = "decomposition", role, roleConfig = {} } = {}) {
  if (roleFieldsResolvedFromAcceptedDefaults(config, workflowType, role)) return roleConfig || {};
  const accepted = loadAcceptedRuntimeRoleDefaults({ workflowType }).defaults?.roles?.[role];
  if (!accepted) throw new Error(`accepted_runtime_role_missing:${role}`);
  return {
    ...(roleConfig || {}),
    runtime: accepted.runtime,
    model: accepted.model,
  };
}

function roleFieldsResolvedFromAcceptedDefaults(config, workflowType, role) {
  const sources = config?.workflows?.[workflowType]?.role_field_sources?.[role];
  return sources?.runtime === "accepted_defaults" && sources?.model === "accepted_defaults";
}

function cliPrefixArgs(assignment) {
  if (!Array.isArray(assignment?.cli_args_prefix)) return [];
  return assignment.cli_args_prefix.filter((arg) => typeof arg === "string");
}

function readJsonSchemaForCli(schemaPathOrJson, repoRoot = process.cwd()) {
  if (typeof schemaPathOrJson !== "string") return schemaPathOrJson;
  const trimmed = schemaPathOrJson.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const resolvedPath = resolveCliFilePath(schemaPathOrJson, repoRoot);
  return fs.readFileSync(resolvedPath, "utf8");
}

function resolveCliFilePath(filePath, repoRoot = process.cwd()) {
  if (typeof filePath !== "string") return filePath;
  const trimmed = filePath.trim();
  if (trimmed.startsWith("{") || path.isAbsolute(filePath)) return filePath;
  return path.resolve(repoRoot, filePath);
}

function assertRuntimeCommandPrompt(prompt, promptPath) {
  if (promptPath) return;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("runtime command prompt is required.");
  }
}

function hashJson(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJsonValue(value)))
    .digest("hex");
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}
