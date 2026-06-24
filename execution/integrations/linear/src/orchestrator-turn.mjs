// The engine-owned orchestrator turn (Seam 1 of the agent-driven-orchestrator
// breakdown) + the invoke_library handler (Seam 1/3/4 join).
//
// `executeOrchestratorTurn` is ONE decision turn of the free orchestrator agent:
// it runs the orchestrator on its normal decomposition runtime role, reads the
// raw control action the LLM emitted, validates it against the control envelope
// (Seam 1), and returns the turn result. The orchestrator's authored output for
// the turn rides back as `producedContent` -- a SIBLING of `evidence`, NOT a
// control-action field -- so the harness still validates only the control
// envelope, never a per-turn payload. A later `terminate` assembles the commit
// from the terminating turn's producedContent.
//
// I-2b WIRES the real runtime + the generalized subagent spawn (the production
// path): the orchestrator runs on the now-live "orchestrator" runtime role, and
// `executeSubagent` runs a library/one-off subagent on its resolved runtime
// role from a free-form prompt (no phase-coupled prompt builder). The fixtures
// inject fakes for both, so the deterministic tests never spawn a real CLI.

import path from "node:path";

import {
  ONE_OFF_RUNTIME_ROLES,
  parseControlAction,
} from "../../../engine/orchestrator-control-action.mjs";
import {
  ORCHESTRATOR_RUNTIME_ROLE,
} from "../../../engine/engine-orchestrator-contract.mjs";
export {
  ORCHESTRATOR_RUNTIME_ROLE,
  handleInvokeLibrary,
} from "../../../engine/engine-orchestrator-contract.mjs";
import {
  buildSessionStartRuntimeCommand,
  extractRuntimeJsonCandidates,
  extractRuntimeSessionHandle,
  resolveRoleRuntimeAssignments,
  strictParseSubagentTurn,
} from "./runtime-adapters.mjs";
import { SUBAGENT_TURN_OUTCOMES } from "../../../engine/orchestrator-turn-contract.mjs";
import {
  DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  runRuntimeCommand,
  scrubChildEnv,
} from "./runtime-command.mjs";
import { buildSubagentInvocationEnvelope } from "../../../engine/subagent-invocation-envelope.mjs";

// Repo root for resolving the repo-relative control-action generation schema
// off-cwd (this module lives at execution/integrations/linear/src/).
const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

// The structured-output generation schema the orchestrator's runtime turn emits
// its OUTPUT ENVELOPE against (Seam 1): a top-level { control_action,
// produced_content? } object. control_action is the same shape the
// control-action schema defines; produced_content is the SIBLING authored draft
// the terminating turn's commit is assembled from. Repo-owned, resolved
// absolutely so command builders find it regardless of cwd.
const TURN_OUTPUT_SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "schemas",
  "orchestrator-turn-output.schema.json",
);
const RAW_OUTPUT_EXCERPT_MAX_CHARS = 4096;
const PROCESS_FAILURE_CODES = new Set(["process_failed", "timed_out", "could_not_start", "envelope_too_large"]);
const DEFAULT_ONE_OFF_RUNTIME_ROLE_PROSE = ONE_OFF_RUNTIME_ROLES.join("|");
const DEFAULT_ORCHESTRATOR_GOVERNING_BODY =
  "You are the Agentic Factory decomposition orchestrator. Decide which subagents to run and when to terminate.";

// Resolve the orchestrator's runtime assignment via the SAME mechanism as the
// other personas. In I-2a the "orchestrator" key is not yet in the assignments
// map (added in I-2b); resolving returns undefined and we surface a clear
// scaffolding error if a caller reaches here without injecting a runtime. The
// unit test always injects `orchestratorRuntime`, so this path is exercised by
// I-2b's wiring, not by the I-2a tests.
function resolveOrchestratorRuntimeAssignment(config) {
  const assignment = resolveRoleRuntimeAssignments(config)?.[ORCHESTRATOR_RUNTIME_ROLE];
  return assignment ?? null;
}

// Execute one orchestrator decision turn.
//
//   executeOrchestratorTurn({
//     runId, project, roster, priorTurns, bounds, sessionHandle, config, repoRoot,
//     orchestratorRuntime?,   // TEST/loop injection: the thing that calls the LLM
//   }) -> {
//     controlAction,          // a VALIDATED, normalized control action (Seam 1)
//     evidence,               // the thin per-turn evidence envelope
//     producedContent?,       // SIBLING of evidence: the turn's authored output
//     sessionHandle,          // warm-continuation handle for the next turn
//   }
//
// `orchestratorRuntime` is an async function
//   ({ runId, project, selectableTargets, priorTurns, bounds, sessionHandle,
//      config, repoRoot, assignment, invocableRuntimeRoles }) ->
//   { controlAction (raw), evidence?, producedContent?, sessionHandle? }
// When omitted, the real runtime is resolved via the normal role mechanism
// (scaffolded; wired in I-2b). The roster's `selectableTargets` is passed in so
// the runtime can tell the orchestrator which library subagents exist.
export async function executeOrchestratorTurn({
  runId,
  project,
  roster,
  priorTurns = [],
  bounds,
  sessionHandle = null,
  config = null,
  repoRoot = undefined,
  definition = null,
  // The orchestrator governing-prompt BODY, loaded through the run recorder at
  // run-start and threaded in so the real runtime can use it as the system
  // persona (the loop owns the single recorder-routed load — Seam 3).
  governingBody = null,
  // No-abort recovery (parallel to subagent recovery): when the loop retries a
  // malformed/failed orchestrator turn, it passes a repair hint that is surfaced
  // in the prompt so the model re-emits a clean control action.
  repairHint = null,
  orchestratorRuntime = null,
} = {}) {
  const selectableTargets = Array.isArray(roster?.selectableTargets)
    ? [...roster.selectableTargets]
    : [];

  const runtime = orchestratorRuntime ?? defaultOrchestratorRuntime;
  const assignment = orchestratorRuntime ? null : resolveOrchestratorRuntimeAssignment(config);
  const invocableRuntimeRoles = Array.isArray(definition?.invocable_runtime_roles)
    ? definition.invocable_runtime_roles
    : undefined;

  const turn = await runtime({
    runId,
    project,
    selectableTargets,
    priorTurns,
    bounds,
    sessionHandle,
    config,
    repoRoot,
    assignment,
    invocableRuntimeRoles,
    governingBody,
    repairHint,
  });

  if (!turn || typeof turn !== "object") {
    throw new Error("orchestrator_turn_runtime_returned_no_turn");
  }

  const parsed = parseControlAction(turn.controlAction, {
    invocableRoles: invocableRuntimeRoles,
  });
  if (!parsed.ok) {
    throw new Error(
      `orchestrator_turn_invalid_control_action: ${parsed.reasons.join(", ")}`,
    );
  }

  return {
    controlAction: parsed.action,
    evidence: turn.evidence ?? null,
    // producedContent rides on the turn RESULT as a sibling of evidence. It is
    // omitted (undefined) when the turn authored nothing this turn.
    ...(turn.producedContent === undefined
      ? {}
      : { producedContent: turn.producedContent }),
    sessionHandle: turn.sessionHandle ?? sessionHandle ?? null,
  };
}

// The real orchestrator runtime (the production path). It builds the
// orchestrator's prompt from the governing-prompt BODY (loaded through the run
// recorder at run-start and threaded in as `governingBody`), the roster's
// `selectableTargets`, and a digest of `priorTurns`, then runs the orchestrator
// on its own "orchestrator" runtime role and parses the emitted control action.
// Latitude (Seam 1): the prompt wording + how the LLM is asked to emit a control
// action. The harness validates ONLY the control envelope (parseControlAction in
// executeOrchestratorTurn) — never a per-turn payload.
export async function defaultOrchestratorRuntime({
  runId,
  project,
  selectableTargets,
  priorTurns,
  bounds,
  sessionHandle,
  config,
  repoRoot = MODULE_REPO_ROOT,
  assignment,
  invocableRuntimeRoles = null,
  governingBody = null,
  repairHint = null,
  runCommand = runRuntimeCommand,
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
} = {}) {
  if (!assignment) {
    throw new Error(
      "orchestrator_runtime_assignment_missing: no runtime assignment resolved for the orchestrator role.",
    );
  }
  const prompt = buildOrchestratorPrompt({
    runId,
    project,
    selectableTargets,
    priorTurns,
    bounds,
    invocableRuntimeRoles,
    governingBody,
    repairHint,
  });
  const command = buildSessionStartRuntimeCommand({
    assignment,
    prompt,
    schemaPath: TURN_OUTPUT_SCHEMA_PATH,
    repoRoot,
  });
  const output = await runCommand(command, {
    timeoutMs,
    maxOutputBytes,
    env: scrubChildEnv(),
  });
  // The runtime emits the turn-output ENVELOPE { control_action, produced_content? }.
  // Pull the control action out of the envelope (tolerating a bare control-action
  // object too); produced_content rides back as the turn's authored draft so a
  // later terminate(commit) assembles the commit from it.
  const { controlAction, producedContent } = firstTurnOutputCandidate(output);
  const nextHandle =
    extractRuntimeSessionHandle(output, {
      role: "orchestrator",
      runId,
      runtime: assignment.runtime,
    }) || sessionHandle || null;
  return {
    controlAction,
    evidence: { evidence_unavailable: [{ scope: "orchestrator.turn.tool_events", reason: RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON }] },
    ...(producedContent === undefined ? {} : { producedContent }),
    sessionHandle: nextHandle,
  };
}

const RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON = "runtime_tool_event_channel_unavailable";

// Build the orchestrator's per-turn prompt. The governing prompt BODY is the
// orchestrator's adopter-tunable system persona (loaded through the recorder at
// run-start). The factory contract below is code-owned: the output shape,
// allowed actions, and terminal requirements must hold regardless of adopter
// tuning. The roster names the library subagents it may pick; the prior-turn
// digest is the run's accumulated context.
export function buildOrchestratorPrompt({
  runId,
  project,
  selectableTargets,
  priorTurns,
  bounds,
  invocableRuntimeRoles,
  governingBody,
  repairHint = null,
}) {
  const projectSummary = orchestratorProjectSummary(project);
  const oneOffRuntimeRoleProse = formatOneOffRuntimeRoleProse(invocableRuntimeRoles);
  const factoryContract = buildOrchestratorFactoryContract({ oneOffRuntimeRoleProse });
  const priorTurnDigest = (priorTurns || []).map((turn) => ({
    action: turn?.controlAction?.action ?? turn?.action ?? null,
    target_key: turn?.controlAction?.target_key ?? null,
    runtime_role: turn?.controlAction?.runtime_role ?? turn?.runtime_role ?? turn?.role ?? null,
    role_label: turn?.controlAction?.role_label ?? turn?.role_label ?? null,
    outcome: turn?.outcome ?? turn?.evidence?.outcome ?? null,
    status: turn?.status ?? null,
    reason: turn?.reason ?? null,
    context_digest: turn?.context_digest ?? null,
    source_refs: Array.isArray(turn?.source_refs) ? turn.source_refs : [],
  }));
  return [
    governingBody && governingBody.trim() !== ""
      ? governingBody
      : DEFAULT_ORCHESTRATOR_GOVERNING_BODY,
    "",
    `run_id: ${runId}`,
    ...(repairHint
      ? ["", `REPAIR NOTICE — your previous turn was rejected; fix it now: ${repairHint}`, ""]
      : []),
    factoryContract,
    "",
    "Available library subagents (target_key):",
    JSON.stringify(selectableTargets || [], null, 2),
    "",
    "Bounds for this run:",
    JSON.stringify(bounds || {}, null, 2),
    "",
    "Project context JSON:",
    JSON.stringify(projectSummary, null, 2),
    "",
    "Decisions so far this run:",
    JSON.stringify(priorTurnDigest, null, 2),
  ].join("\n");
}

function buildOrchestratorFactoryContract({ oneOffRuntimeRoleProse }) {
  return [
    "Reply with EXACTLY ONE JSON object that satisfies the provided schema. It has two top-level keys:",
    "  { \"control_action\": { ... }, \"produced_content\": { ... } }",
    "control_action is REQUIRED and is exactly ONE of:",
    "- invoke_library({ action: \"invoke_library\", target_key }) to run a named library subagent;",
    `- invoke_one_off({ action: "invoke_one_off", role_label, task, prompt, runtime_role }) to run an improvised subagent (runtime_role is one of ${oneOffRuntimeRoleProse});`,
    "- terminate({ action: \"terminate\", outcome, reason }) to end the run (outcome commit -> reason synthesis_complete; outcome pause -> reason product_questions|discovery_needed|needs_pm_review).",
    "produced_content is a SIBLING of control_action (NOT a field inside it). Keep the terminate control_action exactly { action, outcome, reason } with no extra keys.",
    "On a non-terminating turn you may omit produced_content or include partial drafting context.",
    "When you terminate with outcome commit, produced_content MUST include:",
    "- final_issues: an array of agent-ready issues, each { decomposition_key, title, issue_body_markdown, depends_on, assignment, output, acceptance_criteria };",
    "- project_update_markdown: a project update that includes the line `run_id: <run_id>` and a `## What I did with each part of your project` section.",
    "Author every issue field yourself; the harness rejects the commit if a required field is missing or empty (it never fills them in for you).",
  ].join("\n");
}

function formatOneOffRuntimeRoleProse(invocableRuntimeRoles) {
  return Array.isArray(invocableRuntimeRoles) && invocableRuntimeRoles.length > 0
    ? invocableRuntimeRoles.join("|")
    : DEFAULT_ONE_OFF_RUNTIME_ROLE_PROSE;
}

function orchestratorProjectSummary(project) {
  return {
    id: project?.id ?? null,
    name: project?.name ?? null,
    description: project?.description ?? null,
    content: project?.content ?? null,
    status: project?.status ?? null,
    labels: (project?.labels || []).map((label) => ({ id: label?.id ?? null, name: label?.name ?? null })),
    issues: (project?.issues || []).map((issue) => ({
      id: issue?.id ?? null,
      identifier: issue?.identifier ?? null,
      title: issue?.title ?? null,
      state: issue?.state ?? null,
    })),
  };
}

// Pull the turn-output ENVELOPE out of the runtime output (raw JSON,
// structured_output envelope, or embedded in mixed logs) and split it into
// { controlAction, producedContent }. The orchestrator emits
// { control_action, produced_content? }; control_action is what
// parseControlAction validates in the caller, produced_content is the SIBLING
// authored draft. We tolerate a BARE control-action object (one carrying a
// top-level `action`) for robustness, in which case there is no produced_content.
function firstTurnOutputCandidate(output) {
  const candidates = extractRuntimeJsonCandidates(output);
  // Preferred: an envelope carrying a control_action object.
  for (const candidate of candidates) {
    if (candidate && typeof candidate.control_action === "object" && candidate.control_action !== null) {
      const producedContent =
        candidate.produced_content && typeof candidate.produced_content === "object" && !Array.isArray(candidate.produced_content)
          ? candidate.produced_content
          : undefined;
      return { controlAction: candidate.control_action, producedContent };
    }
  }
  // Tolerated: a bare control-action object (no envelope, no produced_content).
  for (const candidate of candidates) {
    if (candidate && typeof candidate.action === "string") {
      return { controlAction: candidate, producedContent: undefined };
    }
  }
  // Neither shape: surface the first object (or null) so the caller's
  // parseControlAction rejects with a clear reason rather than this throwing.
  return { controlAction: candidates[0] ?? null, producedContent: undefined };
}

// The generalized subagent spawn (Seam 1/2). REPLACES the phase-coupled
// executePhase: the orchestrator invokes a subagent by ROLE + a free-form PROMPT
// (the library body for invoke_library, the control action's prompt for
// invoke_one_off) — there is no ordered phase and no phase-prompt builder. It
// resolves the runtime for `runtime_role`, runs a session_start command with the
// given prompt, and parses the returned turn packet against the role-agnostic
// subagent-turn contract (Seam 2).
//
//   executeSubagent({ runtime_role, prompt, envelopeOverride?, runId, task,
//                     project, priorDigest, sessionHandle, config, repoRoot,
//                     runCommand? })
//   -> { ok:true, packet, output, command, sessionHandle, evidence,
//        role: runtime_role, runtime, parse_status, clean_parse,
//        raw_output_excerpt, envelope }
//      OR { ok:false, runtime, parse_status, clean_parse, raw_output_excerpt,
//           failure_kind, failure_code, envelope, role, process? }
export async function executeSubagent({
  runtime_role,
  prompt,
  envelopeOverride = null,
  runId,
  task = null,
  project,
  priorDigest = null,
  sessionHandle = null,
  config,
  repoRoot = MODULE_REPO_ROOT,
  runCommand = runRuntimeCommand,
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_RUNTIME_OUTPUT_BYTES,
} = {}) {
  const assignment = resolveRoleRuntimeAssignments(config)?.[runtime_role];
  if (!assignment) {
    throw new Error(`No runtime assignment is configured for ${runtime_role}.`);
  }
  const hasEnvelopeOverride =
    typeof envelopeOverride === "string" && envelopeOverride.trim() !== "";
  if (!hasEnvelopeOverride && (typeof prompt !== "string" || prompt.trim() === "")) {
    throw new Error(`Subagent prompt is required for ${runtime_role}.`);
  }
  let envelope;
  try {
    envelope = hasEnvelopeOverride
      ? envelopeOverride
      : buildSubagentInvocationEnvelope({
          body: prompt,
          runId,
          role: runtime_role,
          task,
          project,
          priorDigest,
          allowedOutcomes: SUBAGENT_TURN_OUTCOMES,
        });
  } catch (error) {
    return {
      ok: false,
      runtime: assignment.runtime,
      parse_status: "invalid",
      clean_parse: false,
      raw_output_excerpt: rawOutputExcerpt(error?.message || "subagent invocation envelope could not be built"),
      failure_kind: "process",
      failure_code: "envelope_too_large",
      process: {
        exit: null,
        signal: null,
        timed_out: false,
      },
      envelope: null,
      role: runtime_role,
    };
  }
  const command = buildSessionStartRuntimeCommand({
    assignment,
    prompt: envelope,
    repoRoot,
  });
  let commandResult;
  try {
    commandResult = await runCommand(command, {
      timeoutMs,
      maxOutputBytes,
      env: scrubChildEnv(),
    });
  } catch (error) {
    const failureCode = PROCESS_FAILURE_CODES.has(error?.failure_code)
      ? error.failure_code
      : "process_failed";
    return {
      ok: false,
      runtime: assignment.runtime,
      parse_status: "invalid",
      clean_parse: false,
      raw_output_excerpt: rawOutputExcerpt(error?.stdout || error?.stderr || error?.message || ""),
      failure_kind: "process",
      failure_code: failureCode,
      process: {
        exit: error?.exit ?? null,
        signal: error?.signal ?? null,
        timed_out: failureCode === "timed_out",
      },
      envelope,
      role: runtime_role,
    };
  }
  const output = runtimeCommandOutput(commandResult);
  const parsed = strictParseSubagentTurn(output, { runId });
  if (!parsed.ok) {
    return {
      ok: false,
      runtime: assignment.runtime,
      parse_status: "invalid",
      clean_parse: parsed.clean_parse,
      raw_output_excerpt: rawOutputExcerpt(output),
      failure_kind: "parse",
      failure_code: "invalid_packet",
      envelope,
      role: runtime_role,
    };
  }
  const packet = parsed.packet;
  const nextHandle =
    extractRuntimeSessionHandle(output, {
      role: runtime_role,
      runId,
      runtime: assignment.runtime,
    }) || sessionHandle || null;
  return {
    ok: true,
    packet,
    output,
    command,
    role: runtime_role,
    runtime: assignment.runtime,
    parse_status: "valid",
    clean_parse: true,
    raw_output_excerpt: rawOutputExcerpt(output),
    envelope,
    sessionHandle: nextHandle,
    evidence: {
      evidence_unavailable: [
        { scope: `${runtime_role}.turn.tool_events`, reason: RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON },
      ],
    },
  };
}

function runtimeCommandOutput(commandResult) {
  if (typeof commandResult === "string") return commandResult;
  if (typeof commandResult?.output === "string") return commandResult.output;
  if (commandResult?.output !== undefined && commandResult?.output !== null) {
    return String(commandResult.output);
  }
  if (commandResult === undefined || commandResult === null) return "";
  return String(commandResult);
}

function rawOutputExcerpt(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > RAW_OUTPUT_EXCERPT_MAX_CHARS
    ? text.slice(0, RAW_OUTPUT_EXCERPT_MAX_CHARS)
    : text;
}
