import fs from "node:fs";
import path from "node:path";

import {
  SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
  SUBAGENT_TURN_OUTCOMES,
} from "../../../engine/orchestrator-turn-contract.mjs";
import {
  buildSessionStartRuntimeCommand,
  buildRuntimeVersionCommand,
  buildWarmRuntimeCommand,
  extractRuntimeSessionHandle,
  parseRuntimeVersionOutput,
  runtimeAssignmentConfigKey,
  runtimeAssignmentSmokeIdentity,
  runtimeAssignmentSmokeKey,
  resolveRoleRuntimeAssignments,
  strictParseSubagentTurn,
} from "./runtime-adapters.mjs";
import { runRuntimeCommand } from "./runtime-command.mjs";

export const RUNTIME_SMOKE_SCHEMA_VERSION = 4;
const DEFAULT_RUNTIME_SMOKE_PATH = path.join(".agentic-factory", "runtime-smoke.json");
const DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;

export function runtimeSmokeCachePath(config, repoRoot = process.cwd()) {
  return path.resolve(
    repoRoot,
    config?.runtime?.smoke_cache_path || DEFAULT_RUNTIME_SMOKE_PATH,
  );
}

export function readRuntimeSmokeCache(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeRuntimeSmokeCache(filePath, cache) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function smokeTestsFromRuntimeSmokeCache(cache) {
  return cache?.schema_version === RUNTIME_SMOKE_SCHEMA_VERSION ? cache.smokeTests || {} : {};
}

export function runtimeVersionsFromRuntimeSmokeCache(cache) {
  return cache?.schema_version === RUNTIME_SMOKE_SCHEMA_VERSION ? cache.runtimeVersions || {} : {};
}

export async function runRuntimeSmokeChecks({
  config,
  repoRoot = process.cwd(),
  runCommand = runRuntimeCommand,
  cachePath = runtimeSmokeCachePath(config, repoRoot),
  force = false,
  now = () => new Date(),
  timeoutMs = DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS,
} = {}) {
  const assignments = resolveRoleRuntimeAssignments(config);
  const existing = force ? null : readRuntimeSmokeCache(cachePath);
  const smokeTests = structuredClone(smokeTestsFromRuntimeSmokeCache(existing));
  const runtimeVersions = structuredClone(runtimeVersionsFromRuntimeSmokeCache(existing));
  const results = [];
  const unique = uniqueRuntimeAssignments(assignments);

  for (const { role, assignment } of unique) {
    let version;
    try {
      version = await detectRuntimeVersion({ assignment, runCommand, timeoutMs });
    } catch (error) {
      results.push(smokeFailure({ assignment, role, version: "undetected" }, error.message));
      continue;
    }
    runtimeVersions[assignment.runtime] = version;
    const smokeKey = runtimeAssignmentSmokeKey(assignment, version);
    const cached = smokeTests?.[smokeKey];
    if (
      !force &&
      cached?.session_start === true &&
      cached?.schema_output === true &&
      cached?.runtime_version === version &&
      cached?.assignment_key === runtimeAssignmentConfigKey(assignment)
    ) {
      results.push({
        runtime: assignment.runtime,
        role,
        version,
        ok: true,
        cached: true,
        session_start: true,
        schema_output: true,
        warm_continuation: cached?.warm_continuation === true,
        explicit_handle: cached?.explicit_handle === true,
      });
      continue;
    }

    const result = await runRuntimeSmokeCheck({
      assignment,
      role,
      version,
      runCommand,
      timeoutMs,
      repoRoot,
    });
    smokeTests[smokeKey] = {
      session_start: result.session_start,
      warm_continuation: result.warm_continuation,
      schema_output: result.schema_output,
      explicit_handle: result.explicit_handle,
      checked_at: now().toISOString(),
      model: assignment.model || null,
      command: assignment.command || assignment.runtime,
      assignment_key: runtimeAssignmentConfigKey(assignment),
      assignment_identity: runtimeAssignmentSmokeIdentity(assignment, version),
      runtime_version: version,
      error: result.ok ? null : result.error,
      warm_error: result.warm_error || null,
    };
    results.push(result);
  }

  const cache = {
    schema_version: RUNTIME_SMOKE_SCHEMA_VERSION,
    updated_at: now().toISOString(),
    runtimeVersions,
    smokeTests,
  };
  writeRuntimeSmokeCache(cachePath, cache);
  return {
    ok: results.every((result) => result.ok),
    cachePath,
    cache,
    results,
  };
}

export async function detectRuntimeVersion({
  assignment,
  runCommand = runRuntimeCommand,
  timeoutMs = 30_000,
} = {}) {
  const output = await runCommand(buildRuntimeVersionCommand(assignment), { timeoutMs });
  return parseRuntimeVersionOutput(output, { runtime: assignment.runtime });
}

export async function runRuntimeSmokeCheck({
  assignment,
  role,
  version,
  runCommand = runRuntimeCommand,
  timeoutMs = DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS,
  repoRoot = process.cwd(),
} = {}) {
  const runId = `run_smoke_${assignment.runtime}_${role}_${Date.now()}`;
  try {
    const startCommand = buildSessionStartRuntimeCommand({
      assignment,
      prompt: smokePrompt({ runId, role, turn: "start" }),
      repoRoot,
    });
    const startOutput = await runCommand(startCommand, { timeoutMs });
    parseAndValidateRuntimeSmokeTurnOutput(startOutput, { runId });
    const warm = await runOptionalWarmContinuationSmoke({
      assignment,
      role,
      version,
      runId,
      startOutput,
      runCommand,
      timeoutMs,
      repoRoot,
    });

    return {
      runtime: assignment.runtime,
      role,
      version,
      model: assignment.model || null,
      ok: true,
      cached: false,
      session_start: true,
      schema_output: true,
      warm_continuation: warm.warm_continuation,
      explicit_handle: warm.explicit_handle,
      warm_error: warm.warm_error,
    };
  } catch (error) {
    return smokeFailure({ assignment, role, version }, error.message);
  }
}

async function runOptionalWarmContinuationSmoke({
  assignment,
  role,
  version,
  runId,
  startOutput,
  runCommand,
  timeoutMs,
  repoRoot,
} = {}) {
  if (!assignment.warm_continuation?.enabled || !assignment.warm_continuation?.required) {
    return { warm_continuation: false, explicit_handle: false, warm_error: null };
  }
  try {
    const handle = extractRuntimeSessionHandle(startOutput, {
      role,
      runId,
      runtime: assignment.runtime,
    });
    if (!handle?.id) {
      return {
        warm_continuation: false,
        explicit_handle: false,
        warm_error: "session_handle_not_observed",
      };
    }

    const smokeTests = {
      [runtimeAssignmentSmokeKey(assignment, version)]: {
        session_start: true,
        warm_continuation: true,
        schema_output: true,
        explicit_handle: true,
        assignment_key: runtimeAssignmentConfigKey(assignment),
        runtime_version: version,
      },
    };
    const warmCommand = buildWarmRuntimeCommand({
      assignment: { ...assignment, version },
      role,
      runId,
      sessionHandle: handle,
      prompt: smokePrompt({ runId, role, turn: "warm" }),
      smokeTests,
      runtimeVersion: version,
      repoRoot,
    });
    const warmOutput = await runCommand(warmCommand, { timeoutMs });
    parseAndValidateRuntimeSmokeTurnOutput(warmOutput, { runId });
    return { warm_continuation: true, explicit_handle: true, warm_error: null };
  } catch (error) {
    return {
      warm_continuation: false,
      explicit_handle: false,
      warm_error: error.message,
    };
  }
}

export async function runtimeSmokeDoctorChecks({
  config,
  cache,
  runCommand = runRuntimeCommand,
  timeoutMs = 30_000,
} = {}) {
  const assignments = resolveRoleRuntimeAssignments(config);
  const smokeTests = smokeTestsFromRuntimeSmokeCache(cache);
  const checks = [];
  for (const [role, assignment] of Object.entries(assignments)) {
    let version;
    try {
      version = await detectRuntimeVersion({ assignment, runCommand, timeoutMs });
    } catch (error) {
      checks.push({
        name: `runtime smoke ${role} (${assignment.runtime})`,
        ok: false,
        message: error.message,
      });
      continue;
    }
    const result = smokeTests?.[runtimeAssignmentSmokeKey(assignment, version)];
    const ok =
      result?.session_start === true &&
      result?.schema_output === true &&
      result?.runtime_version === version &&
      result?.assignment_key === runtimeAssignmentConfigKey(assignment);
    const warmMessage = result?.warm_continuation === true
      ? "; warm continuation smoke also passed"
      : "";
    checks.push({
      name: `runtime smoke ${role} (${assignment.runtime})`,
      ok,
      message: ok
        ? `version ${version} passed session_start schema-valid subagent-turn readiness${warmMessage}`
        : "missing or failed; run npm run runtime-smoke",
    });
  }
  return checks;
}

function uniqueRuntimeAssignments(assignments) {
  const seen = new Set();
  const unique = [];
  for (const [role, assignment] of Object.entries(assignments)) {
    const key = runtimeAssignmentConfigKey(assignment);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ role, assignment });
  }
  return unique;
}

// Validate the runtime's smoke output as a structured subagent turn — the SAME
// way the live decomposition path validates a real subagent turn
// (orchestrator-turn.mjs `executeSubagent` calls
// `strictParseSubagentTurn`). The smoke proves the runtime can emit
// a clean, valid role-agnostic subagent turn from session_start; it is
// role-agnostic, so there is no `phase` to observe and no `expectedPhase` to
// pass — the (status, reason) tuple is judged by the role-agnostic subagent-turn
// contract (Seam 2). Exported for fixture-level tests that exercise the
// validator without spawning a real CLI.
export function parseAndValidateRuntimeSmokeTurnOutput(output, { runId } = {}) {
  const parsed = strictParseSubagentTurn(output, { runId });
  if (!parsed.ok || parsed.clean_parse !== true) {
    const reasons = Array.isArray(parsed.failureReasons) && parsed.failureReasons.length > 0
      ? parsed.failureReasons
      : ["invalid_subagent_turn"];
    throw new Error(`Runtime smoke subagent turn failed strict validation: ${reasons.join(", ")}`);
  }
  return parsed.packet;
}

function smokePrompt({
  runId,
  role,
  turn,
} = {}) {
  const projectUpdateMarkdown = [
    `run_id: ${runId}`,
    "",
    "Runtime smoke validates schema-valid session_start turn output.",
  ].join("\n");
  const lines = [
    "Return exactly one raw JSON object for a runtime smoke test. Do not use tools and do not mutate Linear.",
    "The first character of your final result must be { and the last character must be }.",
    "Do not wrap the object in markdown code fences. Do not prepend or append prose. Do not return a JSON string containing an object.",
    "Act as the decomposition orchestrator asking one agent-driven runtime turn to report back.",
    "This validates tool-less subagent packet compatibility: clean raw JSON only, then local subagent-turn contract validation.",
    `Runtime context, not output fields: role=${role}; turn_kind=${turn}.`,
    `Allowed (status -> reasons): ${describeAllowedOutcomes()}.`,
    "Use the neutral resume turn: status continue with reason no_blockers.",
    "Required top-level fields and values:",
    `schema_version: ${JSON.stringify(SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION)}`,
    `run_id: ${JSON.stringify(runId)}`,
    "status: \"continue\"",
    "reason: \"no_blockers\"",
    "context_digest: \"Runtime smoke validates schema-valid session_start turn output.\"",
    "source_refs: [\"runtime_smoke\"]",
    "assumptions: []",
    "constraints: []",
    "risks: []",
    "open_questions_markdown: null",
    `project_update_markdown: ${JSON.stringify(projectUpdateMarkdown)}`,
    "technical_explanation_markdown: null",
    "discovery_issues: null",
    "final_issues: null",
    "discovery_issue_updates: null",
    "draft_issues: null",
    "product_source_count: null",
    "unresolved_product_question_count: null",
    "technical_source_count: null",
    "technical_source_categories: null",
    "runtime_session_handle: null",
  ];
  if (turn === "warm") {
    lines.push("This is the warm continuation call; keep the same run_id and return another schema-valid turn packet.");
  }
  return lines.join("\n");
}

// Render the role-agnostic allowed (status -> reasons) outcomes for the smoke
// prompt, sourced from the single contract definition so the prompt and the
// validator can never drift.
function describeAllowedOutcomes() {
  return Object.entries(SUBAGENT_TURN_OUTCOMES)
    .map(([status, reasons]) => `${status} (${reasons.join(", ")})`)
    .join("; ");
}

function smokeFailure({ assignment, role, version, schema_output = false }, error) {
  return {
    runtime: assignment.runtime,
    role,
    version,
    model: assignment.model || null,
    ok: false,
    cached: false,
    session_start: false,
    warm_continuation: false,
    schema_output,
    explicit_handle: false,
    warm_error: null,
    error,
  };
}
