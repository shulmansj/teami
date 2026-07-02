import { createHash } from "node:crypto";
import path from "node:path";

import {
  ENGINE_VERSION,
} from "./engine-contract-constants.mjs";
import {
  PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
} from "./engine-markdown.mjs";
import {
  ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
  validateOrchestratorOutput,
} from "./orchestrator-output.mjs";
import { loadAcceptedPromptSnapshot } from "./accepted-prompt-snapshot.mjs";
import {
  REPAIR_RETRY_TIMEOUT_MS,
  runtimeCommandEnvironmentProof,
  scrubChildEnv,
} from "./runtime-environment.mjs";
import {
  handleInvokeLibrary,
} from "./engine-orchestrator-contract.mjs";
import { extractRuntimeJsonCandidates } from "./engine-runtime-json.mjs";
import { buildLibraryRolePurposeTask } from "./subagent-invocation-envelope.mjs";
import {
  createRunRecorder,
} from "./run-accepted-refs.mjs";
import {
  normalizeArtifactSetLineage,
} from "./produced-identities.mjs";
import {
  digestTraceField,
  enforceTraceContentPolicy,
  findRichContentKeys,
  findSecretContentKeys,
} from "./trace-contract.mjs";

export const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
// No hard run-length ceiling for now: the free orchestrator loop is effectively
// unbounded. The bounds counters + the
// failed_closed/bounds_breach path stay wired (the runaway/verifiability
// backstop); fixtures inject maxRounds low to exercise the breach path.
const DEFAULT_ORCHESTRATOR_MAX_ROUNDS = 1000;
const RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON = "runtime_tool_event_channel_unavailable";
const REDACTED_TOKEN_VALUE = "[redacted token material]";
const SUBAGENT_TURN_INVALID_OUTCOME = "subagent_turn_invalid";
const REPAIR_RAW_OUTPUT_EXCERPT_MAX_CHARS = 2048;
const MAX_CONSUMED_INPUT_REFS = 256;
const MAX_ARTIFACT_SET_LINEAGE_TURN_IDS = 256;
const LINEAGE_CONSUMED_REFS_SCOPE = "lineage.consumed_refs";
const LINEAGE_CONSUMED_REFS_TOO_MANY_REASON = "too_many_lineage_consumed_refs";
const DEFAULT_SUBAGENT_INSTANCE_KEY = "default";

export function resolveSubagentInstanceId({ role, instanceKey = null, instanceId = null } = {}) {
  const runtimeRole = stringOrNull(role);
  if (!runtimeRole) throw new Error("subagent_instance_role_required");
  const explicitInstanceId = stringOrNull(instanceId);
  if (explicitInstanceId) {
    const rolePrefix = `${runtimeRole}#`;
    if (explicitInstanceId.includes("#")) {
      if (!explicitInstanceId.startsWith(rolePrefix) || explicitInstanceId.length === rolePrefix.length) {
        throw new Error("subagent_instance_id_role_mismatch");
      }
      return explicitInstanceId;
    }
    return `${runtimeRole}#${explicitInstanceId}`;
  }
  const key = stringOrNull(instanceKey) || DEFAULT_SUBAGENT_INSTANCE_KEY;
  return `${runtimeRole}#${key}`;
}

export function subagentSessionHandleForInstance(sessionHandles, instanceId) {
  const entry = isRecord(sessionHandles?.[instanceId]) ? sessionHandles[instanceId] : null;
  return entry?.sessionHandle || null;
}

export function rememberSubagentSessionHandle(sessionHandles, { role, instanceId, sessionHandle } = {}) {
  if (!isRecord(sessionHandles) || !sessionHandle) return null;
  const runtimeRole = stringOrNull(role);
  if (!runtimeRole) throw new Error("subagent_instance_role_required");
  const resolvedInstanceId = resolveSubagentInstanceId({ role: runtimeRole, instanceId });
  const entry = {
    role: runtimeRole,
    instanceId: resolvedInstanceId,
    sessionHandle,
  };
  sessionHandles[resolvedInstanceId] = entry;
  return entry;
}

function resolveControlActionSubagentInstanceId({ role, controlAction = null } = {}) {
  try {
    return {
      ok: true,
      instanceId: resolveSubagentInstanceId({
        role,
        instanceId: controlAction?.instance_id,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "subagent_instance_id_invalid",
    };
  }
}

// The free orchestrator-agent loop (replaces the deterministic phase router).
// Each iteration is ONE orchestrator decision turn: the orchestrator emits a
// control action (Seam 1) and the harness routes it — run a library subagent,
// run an improvised one-off, or terminate. The harness owns exactly the two
// enforcement points (the contained env here via scrubChildEnv + the single
// validated commit downstream); everything between is the orchestrator's free,
// trusted work. `orchestratorTurnExecutor` and `runtimeExecutor` are injected
// (the fixtures script control actions + subagent turns through them); the live
// runner uses the real defaults.
export async function runOrchestratorLoop({
  runId,
  wake,
  event,
  project,
  config,
  // Seam 1: the runtime + orchestrator-turn executors and the roster are
  // CALLER-SUPPLIED (no in-signature default), the same way runtimeExecutor has
  // always been taken into this loop. The production callers
  // (runTriggeredDecomposition, runDecompositionEvalMode) default them to the
  // real executors; tests inject deterministic fakes so the loop never spawns a
  // real CLI. Keeping the default OUT of the loop is what makes the injection
  // seam honest (a test that forgets to inject cannot silently hit the real
  // runtime).
  runtimeExecutor,
  orchestratorTurnExecutor,
  roster,
  definition,
  commitPayload,
  renew = async () => {},
  maxRounds = null,
  repoRoot = MODULE_REPO_ROOT,
  cwd = undefined,
  envAugment = {},
  firstTurnWarmStart = null,
  resumeFrom = null,
  allowedRepoPacket = [],
  // Seam 8: optional observability sink. Null preserves the deterministic
  // no-observability path used by eval and validation runs.
  spanSink = null,
} = {}) {
  const recorder = createRunRecorder({ config });
  const runtimeEvidence = {};
  const sessionHandles = {};
  const normalizedAllowedRepoPacket = normalizeAllowedRepoPacket(allowedRepoPacket);
  const perspectivesRun = [];
  const normalizedResumeFrom = normalizeResumeFrom(resumeFrom);
  const priorTurns = initialPriorTurnsForResume(normalizedResumeFrom);
  const lineageSidecar = [];
  const lineageConsumedState = { cursor: 0 };
  const environment = runtimeCommandEnvironmentProof({ ...scrubChildEnv(), ...envAugment });
  const resolvedMaxRounds = resolveOrchestratorMaxRounds({ maxRounds });
  const startedAt = Date.now();
  let roundsUsed = 0;
  let invocations = 0;
  let orchestratorSessionHandle = null;
  let pendingFirstTurnWarmStart =
    firstTurnWarmStartForResume(normalizedResumeFrom) || normalizeFirstTurnWarmStart(firstTurnWarmStart);
  // The latest turn that carried authored output; `terminate` assembles the
  // terminal output from it (the terminating turn's producedContent, or the most
  // recent prior turn that authored something — Seam 1 latitude).
  let lastProducedContent = null;
  let lastProducedContentTurnId = null;
  let lastProducedContentSourceRefs = [];

  // Run-start: load the orchestrator's governing prompt THROUGH the recorder so
  // its consumed accepted-version is captured (undo-safety, Seam 3 — REC-1), and
  // record the orchestrator's own executed runtime role. The body is threaded to
  // every turn as the orchestrator's system persona.
  const governingTargetKey = definition.driver_governing_target_key;
  const governingSnapshot = loadAcceptedPromptSnapshot({
    repoRoot,
    definition,
    targetKey: governingTargetKey,
  });
  const governingAcceptedVersion = recorder.recordGoverningLoad({
    target_key: governingTargetKey,
    snapshot: governingSnapshot,
  });
  recorder.recordExecutedRuntimeRole(definition.driver);
  const governingBody = governingSnapshot.contentBytes;
  let runConfigProjectionEmitted = false;
  const firstRunConfigProjection = () => {
    if (runConfigProjectionEmitted) return null;
    runConfigProjectionEmitted = true;
    return buildRunConfigProjection({
      config,
      definition,
      governingAcceptedVersion,
      maxRounds: resolvedMaxRounds,
    });
  };

  const boundsSnapshot = () => ({
    rounds_used: roundsUsed,
    max_rounds: resolvedMaxRounds,
    wall_ms: Date.now() - startedAt,
    invocations,
  });

  const invokeAndRecordSubagentTurn = async ({
    role,
    instanceId,
    input,
    controlAction,
    parentTurnId,
    spawnReason,
    oneOffReference = null,
  }) => {
    let childTurnCounter = 0;
    const nextSubagentTurnId = () => `${parentTurnId}.${++childTurnCounter}`;
    const spawn = await runtimeExecutor.executeSubagent(input);
    invocations += 1;

    if (isSuccessfulSubagentSpawn(spawn)) {
      recordSubagentTurn({
        role,
        instanceId,
        spawn,
        runId,
        runtimeEvidence,
        sessionHandles,
        perspectivesRun,
        priorTurns,
        controlAction,
        agentTurnId: nextSubagentTurnId(),
        parentTurnId,
        spawnReason,
        lineageSidecar,
        lineageConsumedState,
        oneOffReference,
        spanSink,
      });
      return null;
    }

    if (spawn?.ok === false && spawn.failure_kind === "parse") {
      recordSubagentTurn({
        role,
        instanceId,
        spawn,
        runId,
        runtimeEvidence,
        sessionHandles,
        perspectivesRun,
        priorTurns,
        controlAction,
        agentTurnId: nextSubagentTurnId(),
        parentTurnId,
        spawnReason,
        lineageSidecar,
        lineageConsumedState,
        oneOffReference,
        spanSink,
      });

      await renew();
      const retrySpawn = await runtimeExecutor.executeSubagent({
        ...input,
        envelopeOverride: buildSubagentRepairEnvelopeOverride(spawn),
        timeoutMs: REPAIR_RETRY_TIMEOUT_MS,
      });
      invocations += 1;

      recordSubagentTurn({
        role,
        instanceId,
        spawn: retrySpawn,
        runId,
        runtimeEvidence,
        sessionHandles,
        perspectivesRun,
        priorTurns,
        controlAction,
        agentTurnId: nextSubagentTurnId(),
        parentTurnId,
        spawnReason,
        lineageSidecar,
        lineageConsumedState,
        oneOffReference,
        spanSink,
      });

      if (isSuccessfulSubagentSpawn(retrySpawn)) return null;

      return finishOrchestratorRun({
        runId,
        wake,
        project,
        terminalDecision: {
          outcome: "failed_closed",
          reason: "subagent_turn_validation_failed",
          producedContent: null,
        },
        perspectivesRun,
        environment,
        runtimeEvidence,
        sessionHandles,
        bounds: boundsSnapshot(),
        recorder,
        lineageSidecar,
        config,
        commitPayload,
        orchestratorSessionHandle,
      });
    }

    recordSubagentTurn({
      role,
      instanceId,
      spawn,
      runId,
      runtimeEvidence,
      sessionHandles,
      perspectivesRun,
      priorTurns,
      controlAction,
      agentTurnId: nextSubagentTurnId(),
      parentTurnId,
      spawnReason,
      lineageSidecar,
      lineageConsumedState,
      oneOffReference,
      spanSink,
    });
    return null;
  };

  while (true) {
    // Bound check BEFORE executing a turn, so rounds_used reflects ACTUAL
    // decision turns executed (no phantom round on breach): if we have already
    // executed the allowed number of turns, stop closed without running another.
    if (roundsUsed >= resolvedMaxRounds) {
      recordOrchestratorTurn({
        spanSink,
        roundIndex: roundsUsed + 1,
        action: "bounds_breach",
        outcome: "failed_closed",
        reason: "bounds_breach",
        bounds: boundsSnapshot,
        turnExecuted: false,
        agentTurnId: roundsUsed + 1,
        parentTurnId: null,
        spawnReason: spawnReasonForControlAction(null, {
          action: "bounds_breach",
          reason: "bounds_breach",
        }),
        lineageSidecar,
        lineageConsumedState,
        runConfigProjection: firstRunConfigProjection,
      });
      return finishOrchestratorRun({
        runId,
        wake,
        project,
        terminalDecision: { outcome: "failed_closed", reason: "bounds_breach", producedContent: null },
        perspectivesRun,
        environment,
        runtimeEvidence,
        sessionHandles,
        bounds: boundsSnapshot(),
        recorder,
        lineageSidecar,
        config,
        commitPayload,
        orchestratorSessionHandle,
      });
    }

    await renew();
    const turnWarmStart = pendingFirstTurnWarmStart;
    pendingFirstTurnWarmStart = null;
    const orchestratorTurnInput = {
      runId,
      project,
      roster,
      priorTurns,
      bounds: boundsSnapshot(),
      sessionHandle: orchestratorSessionHandle,
      config,
      repoRoot,
      definition,
      governingBody,
      allowedRepoPacket: normalizedAllowedRepoPacket,
      cwd,
      envAugment,
      firstTurnWarmStart: turnWarmStart,
    };
    let turn;
    try {
      turn = await orchestratorTurnExecutor(orchestratorTurnInput);
    } catch (error) {
      if (isWarmContinuationUnavailableError(error)) {
        recordOrchestratorTurn({
          spanSink,
          roundIndex: roundsUsed + 1,
          action: "warm_continuation_unavailable",
          outcome: "failed_closed",
          reason: "warm_continuation_unavailable",
          bounds: boundsSnapshot,
          turnExecuted: false,
          agentTurnId: roundsUsed + 1,
          parentTurnId: null,
          spawnReason: {
            action: "warm_continuation_unavailable",
            reason: "warm_continuation_unavailable",
          },
          lineageSidecar,
          lineageConsumedState,
          runConfigProjection: firstRunConfigProjection,
          metrics: { warm_continuation_unavailable: 1 },
        });
        return finishOrchestratorRun({
          runId,
          wake,
          project,
          terminalDecision: {
            outcome: "failed_closed",
            reason: "warm_continuation_unavailable",
            producedContent: null,
          },
          perspectivesRun,
          environment,
          runtimeEvidence,
          sessionHandles,
          bounds: boundsSnapshot(),
          recorder,
          lineageSidecar,
          config,
          commitPayload,
          orchestratorSessionHandle,
        });
      }
      // No-abort recovery for the ORCHESTRATOR's OWN turn (parallel to the subagent
      // recovery): a malformed/failed orchestrator turn must not abort the run. ONE
      // deterministic repair retry re-prompts for a clean control action; on
      // exhaustion the HARNESS finishes failed_closed instead of throwing uncaught.
      await renew();
      try {
        turn = await orchestratorTurnExecutor({
          ...orchestratorTurnInput,
          bounds: boundsSnapshot(),
          firstTurnWarmStart: null,
          repairHint: `Your previous orchestrator turn was rejected (${error.message}). Reply with ONLY one raw JSON object {"control_action": {...}, "produced_content": {...}} matching the schema — no prose, no markdown code fences.`,
        });
      } catch {
        roundsUsed += 1;
        recordOrchestratorTurn({
          spanSink,
          roundIndex: roundsUsed,
          action: "orchestrator_repair_exhausted",
          outcome: "failed_closed",
          reason: "orchestrator_turn_validation_failed",
          bounds: boundsSnapshot,
          agentTurnId: roundsUsed,
          parentTurnId: null,
          spawnReason: spawnReasonForControlAction(null, {
            action: "orchestrator_repair_exhausted",
            reason: "orchestrator_turn_validation_failed",
          }),
          lineageSidecar,
          lineageConsumedState,
          runConfigProjection: firstRunConfigProjection,
        });
        return finishOrchestratorRun({
          runId,
          wake,
          project,
          terminalDecision: {
            outcome: "failed_closed",
            reason: "orchestrator_turn_validation_failed",
            producedContent: null,
          },
          perspectivesRun,
          environment,
          runtimeEvidence,
          sessionHandles,
          bounds: boundsSnapshot(),
          recorder,
          lineageSidecar,
          config,
          commitPayload,
          orchestratorSessionHandle,
        });
      }
    }
    // Count the turn we just executed (the terminate turn is counted before the
    // terminate branch returns, so a committing run reports the decision turns
    // that actually ran).
    roundsUsed += 1;
    orchestratorSessionHandle = turn.sessionHandle ?? orchestratorSessionHandle;
    const controlAction = turn.controlAction;
    recordOrchestratorTurn({
      spanSink,
      roundIndex: roundsUsed,
      action: controlAction.action,
      outcome: controlAction.action === "terminate" ? controlAction.outcome : "continue",
      reason: controlAction.reason,
      bounds: boundsSnapshot,
      controlAction,
      turn,
      agentTurnId: roundsUsed,
      parentTurnId: null,
      spawnReason: spawnReasonForControlAction(controlAction, { action: controlAction.action, reason: controlAction.reason }),
      lineageSidecar,
      lineageConsumedState,
      runConfigProjection: firstRunConfigProjection,
      allowedRepoPacket: normalizedAllowedRepoPacket,
    });
    if (turn.producedContent !== undefined && turn.producedContent !== null) {
      lastProducedContent = turn.producedContent;
      lastProducedContentTurnId = roundsUsed;
      lastProducedContentSourceRefs = sourceRefsFromProducedContent(turn.producedContent);
    }

    if (controlAction.action === "terminate") {
      return finishOrchestratorRun({
        runId,
        wake,
        project,
        terminalDecision: {
          outcome: controlAction.outcome,
          reason: controlAction.reason,
          producedContent: lastProducedContent,
        },
        perspectivesRun,
        environment,
        runtimeEvidence,
        sessionHandles,
        bounds: boundsSnapshot(),
        recorder,
        lineageSidecar,
        producedContentTurnId: lastProducedContentTurnId,
        commitDecisionTurnId: roundsUsed,
        producedContentSourceRefs: lastProducedContentSourceRefs,
        config,
        commitPayload,
        orchestratorSessionHandle,
      });
    }

    if (controlAction.action === "invoke_library") {
      const resolved = handleInvokeLibrary({ controlAction, roster, recorder });
      if (!resolved.ok) {
        // Evidence gap, not a crash: the orchestrator named an unresolvable
        // library target. Record the gap on perspectives_run + priorTurns and
        // let the orchestrator decide what to do next turn.
        perspectivesRun.push({ role: controlAction.target_key || "library", outcome: `unresolved:${resolved.reason}` });
        priorTurns.push({ controlAction, outcome: `unresolved:${resolved.reason}` });
        continue;
      }
      const targetLabel = stringOrNull(resolved.snapshot?.entry?.human_name) || resolved.target_key;
      const instanceResolution = resolveControlActionSubagentInstanceId({
        role: resolved.runtime_role,
        controlAction,
      });
      if (!instanceResolution.ok) {
        perspectivesRun.push({
          role: resolved.runtime_role,
          outcome: `unresolved:${instanceResolution.reason}`,
          ...(stringOrNull(controlAction.instance_id) ? { instance_id: controlAction.instance_id } : {}),
        });
        priorTurns.push({
          controlAction,
          outcome: `unresolved:${instanceResolution.reason}`,
          role: resolved.runtime_role,
          ...(stringOrNull(controlAction.instance_id) ? { instance_id: controlAction.instance_id } : {}),
        });
        continue;
      }
      const instanceId = instanceResolution.instanceId;
      const terminalResult = await invokeAndRecordSubagentTurn({
        role: resolved.runtime_role,
        instanceId,
        input: {
          runtime_role: resolved.runtime_role,
          prompt: resolved.body,
          runId,
          wake,
          event,
          project,
          allowedRepoPacket: normalizedAllowedRepoPacket,
          task: buildLibraryRolePurposeTask({
            humanName: resolved.snapshot?.entry?.human_name,
            targetKey: resolved.target_key,
            objective: project?.content ?? project?.description ?? null,
          }),
          priorDigest: priorTurns,
          sessionHandle: subagentSessionHandleForInstance(sessionHandles, instanceId),
          config,
          definition,
          repoRoot,
          cwd,
          envAugment,
        },
        controlAction,
        parentTurnId: roundsUsed,
        spawnReason: librarySubagentSpawnReason({
          controlAction,
          targetKey: resolved.target_key,
          targetLabel,
          instanceId: stringOrNull(controlAction.instance_id) ? instanceId : null,
        }),
      });
      if (terminalResult) return terminalResult;
      continue;
    }

    // invoke_one_off: an improvised subagent on a whitelisted runtime role.
    const oneOffRole = controlAction.runtime_role;
    const instanceId = resolveSubagentInstanceId({
      role: oneOffRole,
      instanceId: controlAction.instance_id,
    });
    const terminalResult = await invokeAndRecordSubagentTurn({
      role: oneOffRole,
      instanceId,
      input: {
        runtime_role: oneOffRole,
        prompt: controlAction.prompt,
        runId,
        wake,
        event,
        project,
        allowedRepoPacket: normalizedAllowedRepoPacket,
        task: controlAction.task,
        priorDigest: priorTurns,
        sessionHandle: subagentSessionHandleForInstance(sessionHandles, instanceId),
        config,
        definition,
        repoRoot,
        cwd,
        envAugment,
      },
      controlAction,
      parentTurnId: roundsUsed,
      spawnReason: oneOffSpawnReason({
        ...controlAction,
        instance_id: stringOrNull(controlAction.instance_id) ? instanceId : null,
      }),
      // One-off EVIDENCE enrichment (Seam 4, I-4): the sanitized invocation
      // reference rides on THIS spawn's perspectives_run entry.
      oneOffReference: buildOneOffEvidenceReference(controlAction),
    });
    recorder.recordExecutedRuntimeRole(oneOffRole);
    if (terminalResult) return terminalResult;
  }
}

// Build the sanitized one-off invocation reference that rides on the spawn's
// perspectives_run entry (Seam 4 — I-4). The reference is sufficient for a human
// to hand-author a PROMOTION SNAPSHOT PR (promoting a successful one-off into the
// library) WITHOUT reconstructing the invocation: it carries the one-off's
// accountability label, its task, and the runtime role it ran on, plus the
// prompt BODY itself when the body is safe to persist. When the body trips the
// content-policy sanitizer (secret-bearing or oversized), the raw body is NOT
// persisted anywhere in the evidence — only a redaction marker + a sha256 DIGEST
// (so a human who holds the body can verify it matches what ran).
function buildOneOffEvidenceReference(controlAction) {
  // EVERY free-text field the orchestrator authored is sanitized -- not just the
  // prompt body. A crafted one-off could carry token material in role_label or
  // task; validatePerspectivesRun does not gate those fields, so a raw secret
  // would otherwise survive in evidence.perspectives_run. runtime_role is
  // whitelist-validated (pm|sr_eng|judge|drafter) and carries no secret.
  return {
    runtime_role: controlAction.runtime_role,
    ...sanitizedOneOffField("role_label", controlAction.role_label),
    ...sanitizedOneOffField("task", controlAction.task),
    ...sanitizedOneOffField("prompt_body", controlAction.prompt),
  };
}

// Carry an authored one-off field onto the evidence reference. CLEAN -> persist
// verbatim so a human can lift it into a promotion PR. SECRET-BEARING (or
// oversized) -> persist a sha256 digest + a redaction marker ONLY, so the raw
// secret never lands in the evidence while a human holding the value can verify
// the match by hashing it. The value is probed under a NEUTRAL key (not "prompt",
// a rich-content key) so the only trips are token material / oversize.
function sanitizedOneOffField(outputKey, value) {
  const text = typeof value === "string" ? value : "";
  const probe = { one_off_field: text };
  const policy = enforceTraceContentPolicy(probe);
  const hasSecret = findSecretContentKeys(probe).length > 0;
  if (policy.ok && !hasSecret) {
    return { [outputKey]: text };
  }
  return {
    [`${outputKey}_redacted`]: true,
    [`${outputKey}_redaction_reason`]: policy.ok ? "trace_payload_contains_token_material" : policy.reason,
    [`${outputKey}_digest`]: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  };
}

function isSuccessfulSubagentSpawn(spawn) {
  if (spawn?.ok === true) return true;
  return spawn?.ok !== false && isRecord(spawn?.packet);
}

function buildSubagentRepairEnvelopeOverride(spawn) {
  const preservedEnvelope = typeof spawn?.envelope === "string" ? spawn.envelope : "";
  return `${preservedEnvelope}\n\n${buildSubagentRepairInstruction(spawn)}`;
}

function buildSubagentRepairInstruction(spawn) {
  return [
    "Subagent turn validation repair retry.",
    `failure_code: ${spawn?.failure_code || "invalid_packet"}`,
    `diagnostic: ${classifySubagentParseFailure(spawn)}`,
    "raw_output_excerpt:",
    boundedRepairRawOutputExcerpt(spawn?.raw_output_excerpt),
    "Your previous output was not a single clean JSON packet. Emit ONLY the JSON packet matching the schema - no prose, no code fences.",
  ].join("\n");
}

function classifySubagentParseFailure(spawn) {
  if (spawn?.clean_parse === false) {
    try {
      return extractRuntimeJsonCandidates(spawn?.raw_output_excerpt || "").length > 0
        ? "prose_wrapped_json_packet"
        : "no_json_packet";
    } catch {
      return "no_json_packet";
    }
  }
  return "clean_json_not_matching_subagent_turn_schema";
}

function boundedRepairRawOutputExcerpt(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const bounded = text.length > REPAIR_RAW_OUTPUT_EXCERPT_MAX_CHARS
    ? text.slice(0, REPAIR_RAW_OUTPUT_EXCERPT_MAX_CHARS)
    : text;
  return bounded || "[empty]";
}

function subagentTurnOutcome({ packet, spawn = null, subagentEvidence = null } = {}) {
  if (
    spawn?.ok === false ||
    subagentEvidence?.parse_status === "invalid" ||
    spawn?.parse_status === "invalid" ||
    typeof subagentEvidence?.failure_code === "string" ||
    typeof spawn?.failure_code === "string"
  ) {
    return SUBAGENT_TURN_INVALID_OUTCOME;
  }
  return packet?.reason || packet?.status || "unknown";
}

// Fold one subagent spawn's turn into the run accumulators: validated packet
// (already parsed by executeSubagent), role-keyed runtime evidence carrying a
// `turns[]` entry (so the terminal artifact's runtime metadata can group by
// role), instance-keyed session handles for warm resume, the thin
// perspectives_run entry, and the prior-turn digest the next orchestrator turn
// sees.
function recordSubagentTurn({
  role,
  instanceId = null,
  spawn,
  runId,
  runtimeEvidence,
  sessionHandles,
  perspectivesRun,
  priorTurns,
  controlAction,
  agentTurnId = null,
  parentTurnId = null,
  spawnReason = null,
  lineageSidecar = null,
  lineageConsumedState = null,
  // The sanitized one-off invocation reference (Seam 4 — I-4), supplied ONLY by
  // the invoke_one_off branch. When present it enriches THIS entry; library and
  // governing spawns pass nothing, so their entries stay the thin shape.
  oneOffReference = null,
  spanSink = null,
}) {
  void runId;
  const packet = spawn.packet;
  const subagentEvidence = {
    role,
    ...(stringOrNull(instanceId) ? { instance_id: stringOrNull(instanceId) } : {}),
    runtime: spawn.runtime,
    parse_status: spawn.parse_status,
    clean_parse: spawn.clean_parse,
    raw_output_excerpt: spawn.raw_output_excerpt,
    ...(spawn.failure_code ? { failure_code: spawn.failure_code } : {}),
  };
  const outcome = subagentTurnOutcome({ packet, spawn, subagentEvidence });
  const tracePolicyOptions = traceContentPolicyOptionsForSink(spanSink);
  const evidence = normalizeRuntimeExecutionEvidence({
    role,
    instanceId,
    packet,
    evidence: spawn.evidence,
    subagentEvidence,
    tracePolicyOptions,
  });
  if (spawn.sessionHandle) {
    rememberSubagentSessionHandle(sessionHandles, {
      role,
      instanceId,
      sessionHandle: spawn.sessionHandle,
    });
  }
  runtimeEvidence[role] = mergeRuntimeEvidence(runtimeEvidence[role], evidence);
  const entry = thinPerspectiveRunEntry({ role, instanceId, packet, evidence, spawn });
  const sourceRefs = sourceRefsFromPacket(packet);
  const consumedInputRefs = consumeLineageInputRefs({
    lineageSidecar,
    lineageConsumedState,
    sourceRefs,
  });
  appendLineageSidecarTurn(lineageSidecar, {
    agentTurnId,
    parentTurnId,
    role,
    spawnReason,
    sourceRefs,
    consumedInputRefs,
  });
  recordSpanBestEffort(
    spanSink,
    "recordSubagentTurn",
    () => subagentTurnSpan({
      role,
      instanceId,
      outcome,
      subagentEvidence,
      entry,
      spawn,
      evidence,
      controlAction,
      agentTurnId,
      parentTurnId,
      spawnReason,
      consumedInputRefs,
    }),
  );
  if (isRecord(oneOffReference)) entry.one_off = oneOffReference;
  perspectivesRun.push(entry);
  priorTurns.push({
    controlAction,
    outcome,
    role,
    ...(stringOrNull(instanceId) ? { instance_id: stringOrNull(instanceId) } : {}),
    status: spawn.packet?.status ?? null,
    reason: spawn.packet?.reason ?? null,
    failure_kind: spawn.failure_kind ?? null,
    failure_code: spawn.failure_code ?? null,
    context_digest: spawn.packet?.context_digest ?? null,
    source_refs: Array.isArray(spawn.packet?.source_refs) ? [...spawn.packet.source_refs] : [],
  });
}

function subagentTurnSpan({
  role,
  instanceId = null,
  outcome,
  subagentEvidence,
  entry,
  spawn = null,
  evidence = null,
  controlAction = null,
  agentTurnId = null,
  parentTurnId = null,
  spawnReason = null,
  consumedInputRefs = [],
}) {
  const span = {
    role,
    ...(stringOrNull(instanceId) ? { instance_id: stringOrNull(instanceId) } : {}),
    outcome,
    prompt: transcriptTextOrNull(spawn?.prompt),
    raw_output: transcriptTextOrNull(spawn?.raw_output),
    control_action: controlActionProjection(controlAction),
    produced_content: producedContentProjection(spawn?.packet),
    agent_turn_id: agentTurnId,
    parent_turn_id: parentTurnId ?? null,
    spawn_reason: spawnReasonProjection(spawnReason),
  };
  if (typeof subagentEvidence?.parse_status === "string") {
    span.parse_status = subagentEvidence.parse_status;
  }
  if (typeof subagentEvidence?.clean_parse === "boolean") {
    span.clean_parse = subagentEvidence.clean_parse;
  }
  if (typeof entry?.evidence_ref === "string" && entry.evidence_ref.trim() !== "") {
    span.evidence_ref = entry.evidence_ref;
  }
  if (typeof subagentEvidence?.failure_code === "string" && subagentEvidence.failure_code.trim() !== "") {
    span.failure_code = subagentEvidence.failure_code;
  }
  if (Array.isArray(evidence?.tool_events) && evidence.tool_events.length > 0) {
    span.tool_events = safeTraceProjection(evidence.tool_events);
  }
  if (Array.isArray(evidence?.evidence_unavailable) && evidence.evidence_unavailable.length > 0) {
    span.evidence_unavailable = safeTraceProjection(evidence.evidence_unavailable);
  }
  applyConsumedInputRefs(span, consumedInputRefs);
  return span;
}

function recordOrchestratorTurn({
  spanSink,
  roundIndex,
  action,
  outcome,
  reason = null,
  bounds,
  controlAction = null,
  turn = null,
  turnExecuted = true,
  agentTurnId = roundIndex,
  parentTurnId = null,
  spawnReason = null,
  lineageSidecar = null,
  lineageConsumedState = null,
  runConfigProjection = null,
  metrics = null,
  allowedRepoPacket = [],
}) {
  const normalizedSpawnReason = spawnReasonProjection(
    spawnReason || spawnReasonForControlAction(controlAction, { action, reason }),
  );
  const sourceRefs = sourceRefsFromProducedContent(turn?.producedContent);
  const consumedInputRefs = consumeLineageInputRefs({
    lineageSidecar,
    lineageConsumedState,
    sourceRefs,
  });
  appendLineageSidecarTurn(lineageSidecar, {
    agentTurnId,
    parentTurnId,
    role: "orchestrator",
    spawnReason: normalizedSpawnReason,
    sourceRefs,
    consumedInputRefs,
  });
  recordSpanBestEffort(
    spanSink,
    "recordOrchestratorTurn",
    () => orchestratorTurnSpan({
      roundIndex,
      action,
      outcome,
      reason,
      bounds: typeof bounds === "function" ? bounds() : bounds,
      controlAction,
      turn,
      turnExecuted,
      agentTurnId,
      parentTurnId,
      spawnReason: normalizedSpawnReason,
      runConfigProjection,
      consumedInputRefs,
      metrics,
      allowedRepoPacket,
    }),
  );
}

function orchestratorTurnSpan({
  roundIndex,
  action,
  outcome,
  reason = null,
  bounds,
  controlAction = null,
  turn = null,
  turnExecuted = true,
  agentTurnId = roundIndex,
  parentTurnId = null,
  spawnReason = null,
  runConfigProjection = null,
  consumedInputRefs = [],
  metrics = null,
  allowedRepoPacket = [],
}) {
  const span = {
    round_index: roundIndex,
    action,
    outcome,
    bounds: { ...(bounds || {}) },
    prompt: transcriptTextOrNull(turn?.prompt),
    raw_output: transcriptTextOrNull(turn?.raw_output),
    control_action: controlActionProjection(controlAction),
    produced_content: producedContentProjection(turn?.producedContent),
    agent_turn_id: agentTurnId,
    parent_turn_id: parentTurnId ?? null,
    spawn_reason: spawnReasonProjection(spawnReason),
    evidence_unavailable: [runtimeToolEventsUnavailable({ role: "orchestrator" })],
  };
  applyConsumedInputRefs(span, consumedInputRefs);
  if (typeof reason === "string" && reason.trim() !== "") {
    span.reason = reason;
  }
  if (turnExecuted === false) {
    span.turn_executed = false;
  }
  if (isRecord(metrics)) {
    span.metrics = safeTraceProjection(metrics);
  }
  const resourceRouting = resourceRoutingProjection({
    allowedRepoPacket,
    controlAction,
    producedContent: turn?.producedContent,
  });
  if (resourceRouting) {
    span.resource_routing = resourceRouting;
  }
  if (controlAction?.action === "invoke_library" && typeof controlAction.target_key === "string") {
    span.target_key = controlAction.target_key;
  }
  if (controlAction?.action === "invoke_one_off" && typeof controlAction.runtime_role === "string") {
    span.runtime_role = controlAction.runtime_role;
  }
  const projection = resolveRunConfigProjection(runConfigProjection);
  if (projection) {
    span.run_config = projection;
  }
  return span;
}

function controlActionProjection(controlAction) {
  if (!isRecord(controlAction)) return null;
  const projection = {};
  for (const key of ["action", "target_key", "runtime_role", "role_label", "task", "instance_id", "outcome", "reason"]) {
    if (!Object.hasOwn(controlAction, key)) continue;
    const value = controlAction[key];
    if (value === null || value === undefined) continue;
    projection[key] = typeof value === "string" ? value : String(value);
  }
  return Object.keys(projection).length > 0 ? projection : null;
}

function producedContentProjection(producedContent) {
  return isRecord(producedContent) ? safeTraceProjection(producedContent) : null;
}

function resourceRoutingProjection({
  allowedRepoPacket = [],
  controlAction = null,
  producedContent = null,
} = {}) {
  const allowedRepos = normalizeAllowedRepoPacket(allowedRepoPacket);
  if (allowedRepos.length === 0) return null;

  const allowedResourceIds = uniqueStrings(allowedRepos.map((repo) => repo.resource_id));
  const allowedSet = new Set(allowedResourceIds);
  const issues = Array.isArray(producedContent?.final_issues) ? producedContent.final_issues : [];
  const selectedByIssue = [];
  const selectedResourceIds = [];
  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const resourceTarget = isRecord(issue.resource_target) ? issue.resource_target : null;
    const selectedId = stringOrNull(resourceTarget?.id);
    if (selectedId) selectedResourceIds.push(selectedId);
    selectedByIssue.push(compactRecord({
      decomposition_key: stringOrNull(issue.decomposition_key),
      work_type: stringOrNull(issue.work_type),
      resource_target_kind: stringOrNull(resourceTarget?.kind),
      resource_target_id: selectedId,
      repo_scope: stringOrNull(resourceTarget?.repo_scope),
    }));
  }

  const uniqueSelectedResourceIds = uniqueStrings(selectedResourceIds);
  const projection = {
    allowed_resource_ids: allowedResourceIds,
    allowed_repos: allowedRepos,
    selected_resource_ids: uniqueSelectedResourceIds,
  };
  const compactSelectedByIssue = selectedByIssue.filter((entry) => isRecord(entry));
  if (compactSelectedByIssue.length > 0) {
    projection.selected_by_issue = compactSelectedByIssue;
  }
  const invalidResourceIds = uniqueSelectedResourceIds.filter((id) => !allowedSet.has(id));
  if (invalidResourceIds.length > 0) {
    projection.invalid_resource_ids = invalidResourceIds;
  }
  if (controlAction?.action === "terminate") {
    projection.terminal_outcome = stringOrNull(controlAction.outcome);
    projection.terminal_reason = stringOrNull(controlAction.reason);
    if (controlAction.outcome === "pause" && controlAction.reason === "product_questions") {
      projection.selection_outcome = "pause_product_questions";
    } else if (controlAction.outcome === "commit") {
      projection.selection_outcome = uniqueSelectedResourceIds.length > 0 ? "selected" : "no_selection_authored";
    }
  }
  return safeTraceProjection(projection);
}

function normalizeAllowedRepoPacket(allowedRepoPacket) {
  if (!Array.isArray(allowedRepoPacket)) return [];
  return allowedRepoPacket
    .map((repo) => compactRecord({
      resource_id: stringOrNull(repo?.resource_id),
      owner: stringOrNull(repo?.owner),
      repo: stringOrNull(repo?.repo),
      default_branch: stringOrNull(repo?.default_branch),
      repo_scope: stringOrNull(repo?.repo_scope),
    }))
    .filter((repo) => isRecord(repo) && typeof repo.resource_id === "string");
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function transcriptTextOrNull(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function spawnReasonForControlAction(controlAction, { action = null, reason = null } = {}) {
  const actionName = stringOrNull(controlAction?.action) || stringOrNull(action);
  if (actionName === "invoke_library") {
    return compactRecord({
      action: actionName,
      target_key: stringOrNull(controlAction?.target_key),
      instance_id: stringOrNull(controlAction?.instance_id),
    });
  }
  if (actionName === "invoke_one_off") {
    return oneOffSpawnReason(controlAction);
  }
  if (actionName === "terminate") {
    return compactRecord({
      action: actionName,
      outcome: stringOrNull(controlAction?.outcome),
      reason: stringOrNull(controlAction?.reason) || stringOrNull(reason),
    });
  }
  return compactRecord({
    action: actionName,
    reason: stringOrNull(reason),
  });
}

function librarySubagentSpawnReason({ controlAction = null, targetKey = null, targetLabel = null, instanceId = null } = {}) {
  return compactRecord({
    action: "invoke_library",
    target_key: stringOrNull(targetKey) || stringOrNull(controlAction?.target_key),
    target_label: stringOrNull(targetLabel) || stringOrNull(targetKey) || stringOrNull(controlAction?.target_key),
    instance_id: stringOrNull(instanceId) || stringOrNull(controlAction?.instance_id),
  });
}

function oneOffSpawnReason(controlAction) {
  return compactRecord({
    action: "invoke_one_off",
    runtime_role: stringOrNull(controlAction?.runtime_role),
    role_label: stringOrNull(controlAction?.role_label),
    task: stringOrNull(controlAction?.task),
    instance_id: stringOrNull(controlAction?.instance_id),
  });
}

function spawnReasonProjection(spawnReason) {
  if (isRecord(spawnReason)) return safeTraceProjection(spawnReason);
  if (typeof spawnReason === "string" && spawnReason.trim() !== "") return { reason: spawnReason };
  return null;
}

function appendLineageSidecarTurn(lineageSidecar, {
  agentTurnId = null,
  parentTurnId = null,
  role = null,
  spawnReason = null,
  sourceRefs = [],
  consumedInputRefs = [],
} = {}) {
  if (!Array.isArray(lineageSidecar)) return;
  try {
    const normalizedConsumedInputRefs = normalizeConsumedInputRefs(consumedInputRefs);
    lineageSidecar.push({
      agent_turn_id: agentTurnId,
      parent_turn_id: parentTurnId ?? null,
      role: stringOrNull(role),
      spawn_reason: spawnReasonProjection(spawnReason),
      source_refs: Array.isArray(sourceRefs) ? safeTraceProjection(sourceRefs) : [],
      ...(normalizedConsumedInputRefs.length > 0 ? { consumed_input_refs: normalizedConsumedInputRefs } : {}),
    });
  } catch {
    // Lineage is observability-only; it must never affect the run.
  }
}

function normalizeConsumedInputRefs(values) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  const seen = new Set();
  for (const value of values.slice(0, MAX_CONSUMED_INPUT_REFS)) {
    const id = consumedInputRefId(value);
    if (id === null) continue;
    const key = lineageIdKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(id);
  }
  return normalized;
}

function consumeLineageInputRefs({
  lineageSidecar = null,
  lineageConsumedState = null,
  sourceRefs = [],
} = {}) {
  try {
    const consumed = [];
    if (!Array.isArray(lineageSidecar) || !isRecord(lineageConsumedState)) {
      appendConsumedSourceRefs(consumed, sourceRefs);
      return consumed;
    }
    const start = normalizedLineageCursor(lineageConsumedState.cursor, lineageSidecar.length);
    const end = lineageSidecar.length;
    for (let index = start; index < end; index += 1) {
      const id = consumedInputRefId(lineageSidecar[index]?.agent_turn_id);
      appendConsumedInputRef(consumed, id);
    }
    lineageConsumedState.cursor = end;
    appendConsumedSourceRefs(consumed, sourceRefs);
    return consumed;
  } catch {
    return [];
  }
}

function normalizedLineageCursor(cursor, length) {
  if (!Number.isInteger(cursor) || cursor < 0) return 0;
  return Math.min(cursor, length);
}

function applyConsumedInputRefs(span, consumedInputRefs) {
  try {
    const normalized = Array.isArray(consumedInputRefs)
      ? consumedInputRefs.map(consumedInputRefId).filter((id) => id !== null)
      : [];
    if (normalized.length > MAX_CONSUMED_INPUT_REFS) {
      mergeEvidenceUnavailable(span, lineageConsumedRefsUnavailable());
      return;
    }
    span.consumed_input_refs = safeTraceProjection(normalized);
  } catch {
    // Observability-only: lineage fields must never affect the run.
  }
}

function lineageConsumedRefsUnavailable() {
  return {
    scope: LINEAGE_CONSUMED_REFS_SCOPE,
    reason: LINEAGE_CONSUMED_REFS_TOO_MANY_REASON,
  };
}

function mergeEvidenceUnavailable(span, marker) {
  if (!isRecord(span) || !isRecord(marker)) return;
  const existing = Array.isArray(span.evidence_unavailable) ? span.evidence_unavailable : [];
  const projectedMarker = safeTraceProjection(marker);
  span.evidence_unavailable = [
    ...existing,
    ...(!existing.some((entry) =>
      entry?.scope === projectedMarker.scope && entry?.reason === projectedMarker.reason
    ) ? [projectedMarker] : []),
  ];
}

function appendConsumedSourceRefs(consumed, sourceRefs) {
  if (!Array.isArray(sourceRefs)) return [];
  for (const sourceRef of sourceRefs) {
    const id = consumedSourceRefId(sourceRef);
    appendConsumedInputRef(consumed, id);
    if (consumed.length > MAX_CONSUMED_INPUT_REFS) break;
  }
  return consumed;
}

function appendConsumedInputRef(consumed, id) {
  if (!Array.isArray(consumed) || id === null) return;
  if (consumed.length > MAX_CONSUMED_INPUT_REFS) return;
  consumed.push(id);
}

// consumed_input_refs is a scalar ID list; source_ref records are projected to
// stable source IDs before they ride alongside prior agent_turn_id values.
function consumedSourceRefId(sourceRef) {
  if (!isRecord(sourceRef)) return consumedInputRefId(sourceRef);
  const kind = consumedInputRefId(sourceRef.kind);
  const id =
    consumedInputRefId(sourceRef.id)
    ?? consumedInputRefId(sourceRef.object_id)
    ?? consumedInputRefId(sourceRef.objectId)
    ?? consumedInputRefId(sourceRef.target_key)
    ?? consumedInputRefId(sourceRef.key)
    ?? consumedInputRefId(sourceRef.accepted_baseline_id)
    ?? consumedInputRefId(sourceRef.snapshot_sha256);
  if (kind !== null && id !== null) return `${kind}:${id}`;
  return id;
}

function consumedInputRefId(value) {
  const projected = safeTraceProjection(value);
  if (typeof projected === "string") {
    const trimmed = projected.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof projected === "number" && Number.isFinite(projected)) return projected;
  return null;
}

function lineageIdsEqual(left, right) {
  const leftId = consumedInputRefId(left);
  const rightId = consumedInputRefId(right);
  return leftId !== null && rightId !== null && lineageIdKey(leftId) === lineageIdKey(rightId);
}

function lineageIdKey(value) {
  return `${typeof value}:${value}`;
}

function sourceRefsFromProducedContent(producedContent) {
  try {
    return Array.isArray(producedContent?.source_refs) ? producedContent.source_refs : [];
  } catch {
    return [];
  }
}

function sourceRefsFromPacket(packet) {
  try {
    return Array.isArray(packet?.source_refs) ? packet.source_refs : [];
  } catch {
    return [];
  }
}

function compactRecord(record) {
  const compacted = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value === null || value === undefined || value === "") continue;
    compacted[key] = value;
  }
  return Object.keys(compacted).length > 0 ? compacted : null;
}

function safeTraceProjection(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => {
    const projected = safeTraceProjection(item);
    return projected === undefined ? null : projected;
  });
  if (!isRecord(value)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    return String(value ?? "");
  }
  const projected = {};
  for (const [key, nested] of Object.entries(value)) {
    const projectedValue = safeTraceProjection(nested);
    if (projectedValue !== undefined) projected[key] = projectedValue;
  }
  return projected;
}

function resolveRunConfigProjection(runConfigProjection) {
  try {
    const projection = typeof runConfigProjection === "function"
      ? runConfigProjection()
      : runConfigProjection;
    return isRecord(projection) ? projection : null;
  } catch {
    return null;
  }
}

function buildRunConfigProjection({
  config,
  definition,
  governingAcceptedVersion,
  maxRounds,
} = {}) {
  try {
    const workflowType = typeof definition?.workflow_type === "string"
      && definition.workflow_type.trim() !== ""
      ? definition.workflow_type
      : null;
    const workflow = workflowType ? config?.workflows?.[workflowType] : null;
    const configuredRoles = isRecord(workflow?.roles) ? workflow.roles : {};
    const roleNames = Array.isArray(definition?.runtime_assignment_roles)
      ? definition.runtime_assignment_roles
      : Object.keys(configuredRoles);
    const roles = {};
    for (const role of roleNames) {
      if (typeof role !== "string" || role.trim() === "") continue;
      roles[role] = runConfigRoleProjection({
        roleConfig: configuredRoles?.[role],
        fieldSources: workflow?.role_field_sources?.[role],
        unpinnedRuntime: workflow?.unpinned_runtime?.[role],
      });
    }
    return {
      orchestrator_persona_accepted_version: acceptedVersionProjection(governingAcceptedVersion),
      roles,
      accepted_runtime_defaults_ref: acceptedVersionProjection(workflow?.accepted_runtime_defaults_ref),
      max_rounds: Number.isFinite(maxRounds) ? Math.floor(maxRounds) : null,
    };
  } catch {
    return null;
  }
}

function runConfigRoleProjection({ roleConfig, fieldSources, unpinnedRuntime } = {}) {
  const role = isRecord(roleConfig) ? roleConfig : {};
  const sources = isRecord(fieldSources) ? fieldSources : {};
  const projection = {
    runtime: stringOrNull(role.runtime),
    model: stringOrNull(role.model),
    provenance: {
      runtime: stringOrNull(sources.runtime),
      model: stringOrNull(sources.model),
    },
  };
  const unpinned = unpinnedRuntimeProjection(unpinnedRuntime);
  if (unpinned) projection.unpinned = unpinned;
  return projection;
}

function unpinnedRuntimeProjection(unpinnedRuntime) {
  if (!isRecord(unpinnedRuntime)) return null;
  const projection = {};
  if (unpinnedRuntime.runtime === true) projection.runtime = true;
  if (unpinnedRuntime.model === true) projection.model = true;
  return Object.keys(projection).length > 0 ? projection : null;
}

function acceptedVersionProjection(ref) {
  if (!isRecord(ref)) return null;
  return {
    target_key: stringOrNull(ref.target_key),
    accepted_baseline_id: stringOrNull(ref.accepted_baseline_id),
    snapshot_sha256: stringOrNull(ref.snapshot_sha256),
  };
}

function recordSpanBestEffort(spanSink, method, span) {
  try {
    const recorder = spanSink?.[method];
    if (typeof recorder !== "function") return;
    const resolvedSpan = typeof span === "function" ? span() : span;
    const tracePolicyOptions = traceContentPolicyOptionsForSink(spanSink);
    const result = recorder.call(spanSink, scrubSpanFieldsForEmission(resolvedSpan, tracePolicyOptions));
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Observability must never change orchestrator safety behavior.
  }
}

function scrubSpanFieldsForEmission(span, tracePolicyOptions = {}) {
  if (!isRecord(span)) return sanitizeTraceValue(span, tracePolicyOptions);
  const scrubbed = {};
  for (const [key, value] of Object.entries(span)) {
    scrubbed[key] = scrubSpanFieldForEmission(key, value, tracePolicyOptions);
  }
  return scrubbed;
}

function scrubSpanFieldForEmission(key, value, tracePolicyOptions = {}) {
  let sanitized;
  try {
    sanitized = sanitizeTraceValue(value, tracePolicyOptions);
  } catch {
    return digestTraceField(value);
  }
  const rawProbe = spanFieldPolicyProbe(key, value);
  const sanitizedProbe = spanFieldPolicyProbe(key, sanitized);
  if (spanFieldTripsPolicy(rawProbe, tracePolicyOptions) || spanFieldTripsPolicy(sanitizedProbe, tracePolicyOptions)) {
    return digestTraceField(value);
  }
  return sanitized;
}

function spanFieldTripsPolicy(probe, tracePolicyOptions = {}) {
  try {
    return !enforceTraceContentPolicy(probe, tracePolicyOptions).ok || findSecretContentKeys(probe).length > 0;
  } catch {
    return true;
  }
}

function spanFieldPolicyProbe(key, value) {
  return {
    spans: [{ name: "orchestrator_loop_span_field", attributes: { [key]: value } }],
  };
}

function finishOrchestratorRun({
  runId,
  wake,
  project,
  terminalDecision,
  perspectivesRun,
  environment,
  runtimeEvidence,
  sessionHandles,
  bounds,
  recorder,
  lineageSidecar = [],
  producedContentTurnId = null,
  commitDecisionTurnId = null,
  producedContentSourceRefs = [],
  config = null,
  commitPayload,
  orchestratorSessionHandle = null,
}) {
  const output = assembleOrchestratorRunResult({
    runId,
    wake,
    project,
    terminalDecision,
    perspectivesRun,
    runtimeEvidence,
    bounds,
    lineageSidecar,
    producedContentTurnId,
    commitDecisionTurnId,
    producedContentSourceRefs,
    commitPayload,
  });
  const validation = validateOrchestratorOutput(output, commitPayload);
  if (!validation.ok) {
    throw new Error(`Orchestrator output failed validation: ${validation.failureReasons.join(", ")}`);
  }
  // Accepted refs come from the run recorder (the #50 re-key, Seam 3): the
  // library/governing loads captured AT LOAD + the runtime-defaults rule ref
  // when an EXECUTED role consumed accepted defaults.
  const acceptedRefs = recorder.collectRefs({ config });
  const agentTurnLineage = Array.isArray(lineageSidecar)
    ? lineageSidecar.map((entry) => safeTraceProjection(entry))
    : [];
  return {
    output,
    environment,
    runtimeEvidence,
    sessionHandles,
    orchestratorSessionHandle,
    acceptedRefs,
    agentTurnLineage,
    ...(output.artifact_set_lineage ? { artifact_set_lineage: output.artifact_set_lineage } : {}),
  };
}

// Assemble the terminal output from the terminating turn's PRODUCED CONTENT
// (Seam 1 — the orchestrator's authored draft rode the turn result as
// `producedContent`, NOT a control field), instead of the retired
// terminalDecision.packet. The harness validates this assembly (the single
// commit floor) and gates with canApplyTerminal downstream.
function assembleOrchestratorRunResult({
  runId,
  wake,
  project,
  terminalDecision,
  perspectivesRun,
  runtimeEvidence,
  bounds,
  lineageSidecar = [],
  producedContentTurnId = null,
  commitDecisionTurnId = null,
  producedContentSourceRefs = [],
  commitPayload,
}) {
  const produced = isRecord(terminalDecision.producedContent) ? terminalDecision.producedContent : {};
  const terminalOutput = {
    schema_version: ORCHESTRATOR_OUTPUT_SCHEMA_VERSION,
    run_id: runId,
    // Engine stamp on every per-turn output (validated in orchestrator-output.mjs);
    // distinct from the artifact's function-owned function_version.
    workflow_version: ENGINE_VERSION,
    outcome: terminalDecision.outcome,
    reason: terminalDecision.reason,
    context_digest: contextDigestForTerminal({ produced, terminalDecision }),
    source_refs: producedArray(produced, "source_refs", fallbackSourceRefs({ wake, project })),
    assumptions: producedArray(produced, "assumptions"),
    constraints: producedArray(produced, "constraints"),
    risks: producedArray(produced, "risks"),
  };

  if (terminalDecision.outcome === "commit") {
    const {
      project_update_fallback_body: projectUpdateFallbackBodyFromPayload,
      ...commitTerminalOutput
    } = assembleInjectedCommitPayload(commitPayload, produced, {
      projectUpdateFallbackBody,
    });
    terminalOutput.project_update_markdown = markdownWithRunId({
      markdown: produced.project_update_markdown,
      runId,
      fallbackBody: projectUpdateFallbackBodyFromPayload,
    });
    Object.assign(terminalOutput, commitTerminalOutput);
  } else if (terminalDecision.outcome === "pause") {
    terminalOutput.project_update_markdown = markdownWithRunId({
      markdown: produced.project_update_markdown,
      runId,
      fallbackBody: pauseProjectUpdateBody(terminalDecision.reason, produced),
    });
    terminalOutput.open_questions_markdown = openQuestionsForPause(terminalDecision.reason, produced);
    if (Array.isArray(produced.discovery_issues) && produced.discovery_issues.length > 0) {
      terminalOutput.discovery_issues = produced.discovery_issues;
    }
  } else if (terminalDecision.outcome === "failed_closed") {
    terminalOutput.project_update_markdown = markdownWithRunId({
      runId,
      fallbackBody: projectUpdateFallbackBody(failedClosedProjectUpdateBody({
        reason: terminalDecision.reason,
        bounds,
      })),
    });
    terminalOutput.open_questions_markdown = failedClosedOpenQuestions(terminalDecision.reason);
  }

  const runResult = {
    terminal_output: terminalOutput,
    evidence: buildOrchestratorEvidence({ perspectivesRun, runtimeEvidence }),
    bounds,
  };
  const artifactSetLineage = buildArtifactSetLineage({
    lineageSidecar,
    producedContentTurnId,
    commitDecisionTurnId,
    producedContentSourceRefs,
  });
  if (artifactSetLineage) runResult.artifact_set_lineage = artifactSetLineage;
  return runResult;
}

function buildArtifactSetLineage({
  lineageSidecar = [],
  producedContentTurnId = null,
  commitDecisionTurnId = null,
  producedContentSourceRefs = [],
} = {}) {
  try {
    const producedByTurnId = consumedInputRefId(producedContentTurnId);
    const commitTurnId = consumedInputRefId(commitDecisionTurnId);
    if (producedByTurnId === null || commitTurnId === null) return null;
    const sidecar = Array.isArray(lineageSidecar) ? lineageSidecar : [];
    const producingEntry = sidecar.find((entry) =>
      lineageIdsEqual(entry?.agent_turn_id, producedByTurnId)
    );
    const knownTurnIds = new Map();
    for (const entry of sidecar.slice(0, MAX_ARTIFACT_SET_LINEAGE_TURN_IDS)) {
      const id = consumedInputRefId(entry?.agent_turn_id);
      if (id !== null) knownTurnIds.set(lineageIdKey(id), id);
    }
    const informedByTurnIds = [];
    const seenInformed = new Set();
    const consumedRefs = Array.isArray(producingEntry?.consumed_input_refs)
      ? producingEntry.consumed_input_refs
      : [];
    for (const ref of consumedRefs.slice(0, MAX_CONSUMED_INPUT_REFS)) {
      const refId = consumedInputRefId(ref);
      if (refId === null) continue;
      const key = lineageIdKey(refId);
      if (!knownTurnIds.has(key) || lineageIdsEqual(refId, producedByTurnId) || seenInformed.has(key)) continue;
      seenInformed.add(key);
      informedByTurnIds.push(knownTurnIds.get(key));
      if (informedByTurnIds.length >= MAX_ARTIFACT_SET_LINEAGE_TURN_IDS) break;
    }
    return normalizeArtifactSetLineage({
      lineage_scope: "artifact_set",
      produced_by_turn_id: producedByTurnId,
      commit_decision_turn_id: commitTurnId,
      informed_by_turn_ids: informedByTurnIds,
      source_refs: Array.isArray(producingEntry?.source_refs)
        ? producingEntry.source_refs
        : producedContentSourceRefs,
    });
  } catch {
    return null;
  }
}

// Read an array field from the terminating turn's produced content, falling back
// to a default when absent/empty.
function producedArray(produced, field, fallback = []) {
  const value = produced?.[field];
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function assembleInjectedCommitPayload(commitPayload, produced, ctx) {
  if (typeof commitPayload?.assembleCommitPayload !== "function") {
    throw new Error("commit_payload_assembler_required");
  }
  const assembled = commitPayload.assembleCommitPayload(produced, ctx);
  if (!isRecord(assembled)) {
    throw new Error("commit_payload_assembler_invalid_result");
  }
  return assembled;
}

function failedClosedProjectUpdateBody({ reason, bounds }) {
  if (reason === "bounds_breach") {
    return `Decomposition stopped after ${bounds.max_rounds} allowed rounds before a safe terminal result was ready.`;
  }
  if (reason === "warm_continuation_unavailable") {
    return "Execution stopped because the required warm-resume runtime path is not available for this orchestrator session.";
  }
  if (reason === "subagent_turn_validation_failed") {
    return "Decomposition stopped: a subagent turn failed validation after a repair retry.";
  }
  if (reason === "orchestrator_turn_validation_failed") {
    return "Decomposition stopped: the orchestrator could not produce a valid control action after a repair retry.";
  }
  return "Decomposition stopped before a safe terminal result was ready because the runtime environment failed a safety check.";
}

function failedClosedOpenQuestions(reason) {
  if (reason === "bounds_breach") {
    return "- Should this project be narrowed, or should the orchestrator round limit be raised before retrying decomposition?";
  }
  if (reason === "warm_continuation_unavailable") {
    return "- Should runtime smoke be repaired before retrying this resumed execution?";
  }
  if (reason === "subagent_turn_validation_failed") {
    return "- Should the subagent runtime output be inspected before retrying decomposition?";
  }
  if (reason === "orchestrator_turn_validation_failed") {
    return "- Should the orchestrator runtime output be inspected before retrying decomposition?";
  }
  return "- Should the runtime environment be repaired before retrying decomposition?";
}

function resolveOrchestratorMaxRounds({ maxRounds } = {}) {
  const configured = maxRounds ?? DEFAULT_ORCHESTRATOR_MAX_ROUNDS;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ORCHESTRATOR_MAX_ROUNDS;
  return Math.floor(parsed);
}

function normalizeFirstTurnWarmStart(firstTurnWarmStart) {
  if (!isRecord(firstTurnWarmStart)) return null;
  const sessionHandle = isRecord(firstTurnWarmStart.sessionHandle)
    ? { ...firstTurnWarmStart.sessionHandle }
    : null;
  return {
    sessionHandle,
    priorRunId: stringOrNull(firstTurnWarmStart.priorRunId),
    smokeTests: isRecord(firstTurnWarmStart.smokeTests) ? firstTurnWarmStart.smokeTests : {},
    runtimeVersion: stringOrNull(firstTurnWarmStart.runtimeVersion),
  };
}

function normalizeResumeFrom(resumeFrom) {
  if (!isRecord(resumeFrom)) return null;
  const sessionHandle = isRecord(resumeFrom.sessionHandle)
    ? { ...resumeFrom.sessionHandle }
    : null;
  const priorRunId = stringOrNull(resumeFrom.priorRunId);
  const coldReconstruct = resumeFrom.coldReconstruct === true || resumeFrom.mode === "cold_reconstruct";
  if ((!sessionHandle || !priorRunId) && !coldReconstruct) return null;
  if (!priorRunId) return null;
  return {
    sessionHandle,
    priorRunId,
    ...(coldReconstruct ? { coldReconstruct: true } : {}),
    reviewerNotes: typeof resumeFrom.reviewerNotes === "string" ? resumeFrom.reviewerNotes : "",
    smokeTests: isRecord(resumeFrom.smokeTests) ? resumeFrom.smokeTests : {},
    runtimeVersion: stringOrNull(resumeFrom.runtimeVersion),
    headSha: stringOrNull(resumeFrom.head_sha || resumeFrom.headSha),
  };
}

function firstTurnWarmStartForResume(resumeFrom) {
  if (!resumeFrom?.sessionHandle) return null;
  return normalizeFirstTurnWarmStart({
    sessionHandle: resumeFrom.sessionHandle,
    priorRunId: resumeFrom.priorRunId,
    smokeTests: resumeFrom.smokeTests,
    runtimeVersion: resumeFrom.runtimeVersion,
  });
}

function initialPriorTurnsForResume(resumeFrom) {
  if (!resumeFrom || typeof resumeFrom.reviewerNotes !== "string" || resumeFrom.reviewerNotes === "") {
    return [];
  }
  return [{
    action: "review_notes",
    outcome: "warm_resume_review_notes",
    status: "request_changes",
    reason: "af_review_failure_marker",
    context_digest: resumeFrom.reviewerNotes,
    reviewer_notes: resumeFrom.reviewerNotes,
    source_refs: [{
      kind: "github_pull_request_review_marker",
      id: resumeFrom.headSha || "af-review",
    }],
  }];
}

function isWarmContinuationUnavailableError(error) {
  return error?.code === "warm_continuation_unavailable";
}

function buildOrchestratorEvidence({ perspectivesRun, runtimeEvidence = {} }) {
  const evidence = {
    perspectives_run: perspectivesRun.map((entry) => ({ ...entry })),
  };
  const toolEvents = runtimeEvidenceEntries(runtimeEvidence)
    .flatMap((entry) => Array.isArray(entry?.tool_events) ? entry.tool_events : []);
  if (toolEvents.length > 0) evidence.tool_events = toolEvents;
  const evidenceUnavailable = runtimeEvidenceEntries(runtimeEvidence)
    .flatMap((entry) => Array.isArray(entry?.evidence_unavailable) ? entry.evidence_unavailable : []);
  if (evidenceUnavailable.length > 0) evidence.evidence_unavailable = evidenceUnavailable;
  return evidence;
}

function thinPerspectiveRunEntry({ role, instanceId = null, packet, evidence, spawn = null }) {
  const entry = { role, outcome: subagentTurnOutcome({ packet, spawn }) };
  if (stringOrNull(instanceId)) entry.instance_id = stringOrNull(instanceId);
  if (typeof spawn?.failure_code === "string" && spawn.failure_code.trim() !== "") {
    entry.failure_code = spawn.failure_code;
  }
  if (typeof evidence?.evidence_ref === "string" && evidence.evidence_ref.trim() !== "") {
    entry.evidence_ref = evidence.evidence_ref;
  }
  return entry;
}

function normalizeRuntimeExecutionEvidence({ role, instanceId = null, packet, evidence, subagentEvidence, tracePolicyOptions = {} }) {
  const raw = isRecord(evidence) ? evidence : {};
  const scope = runtimeToolEventsScope({ role });
  const { toolEvents, unavailable: policyUnavailable } = sanitizeToolEvents(raw.tool_events, {
    scope,
    tracePolicyOptions,
  });
  const explicitUnavailable = normalizeEvidenceUnavailable(raw.evidence_unavailable);
  const evidenceUnavailable =
    toolEvents.length > 0
      ? [...explicitUnavailable, ...policyUnavailable]
      : [
          ...explicitUnavailable,
          ...policyUnavailable,
          ...(explicitUnavailable.length === 0 && policyUnavailable.length === 0
            ? [runtimeToolEventsUnavailable({ role })]
            : []),
        ];
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "tool_events" || key === "evidence_unavailable" || key === "turns") continue;
    normalized[key] = key === "evidence_ref" ? sanitizeTraceValue(value, tracePolicyOptions) : value;
  }
  if (toolEvents.length > 0) normalized.tool_events = toolEvents;
  if (evidenceUnavailable.length > 0) normalized.evidence_unavailable = evidenceUnavailable;
  // The turn carries the INVOKED ROLE (not a phase): the terminal artifact's
  // runtime metadata groups runtime evidence by this role directly.
  const outcome = subagentTurnOutcome({ packet, subagentEvidence });
  normalized.turns = [{
    role,
    ...(stringOrNull(instanceId) ? { instance_id: stringOrNull(instanceId) } : {}),
    outcome,
    ...(packet?.run_id ? { run_id: packet.run_id } : {}),
    ...(typeof subagentEvidence?.failure_code === "string"
      ? { failure_code: subagentEvidence.failure_code }
      : {}),
    ...(typeof normalized.evidence_ref === "string" && normalized.evidence_ref.trim() !== ""
      ? { evidence_ref: normalized.evidence_ref }
      : {}),
    subagent_evidence: subagentEvidence,
    ...(toolEvents.length > 0 ? { tool_events: toolEvents } : {}),
    ...(evidenceUnavailable.length > 0 ? { evidence_unavailable: evidenceUnavailable } : {}),
  }];
  return normalized;
}

function mergeRuntimeEvidence(existing, next) {
  if (!existing) return next;
  const merged = { ...existing, ...next };
  merged.tool_events = [
    ...(Array.isArray(existing.tool_events) ? existing.tool_events : []),
    ...(Array.isArray(next.tool_events) ? next.tool_events : []),
  ];
  if (merged.tool_events.length === 0) delete merged.tool_events;
  merged.evidence_unavailable = [
    ...(Array.isArray(existing.evidence_unavailable) ? existing.evidence_unavailable : []),
    ...(Array.isArray(next.evidence_unavailable) ? next.evidence_unavailable : []),
  ];
  if (merged.evidence_unavailable.length === 0) delete merged.evidence_unavailable;
  merged.turns = [
    ...(Array.isArray(existing.turns) ? existing.turns : []),
    ...(Array.isArray(next.turns) ? next.turns : []),
  ];
  if (merged.turns.length === 0) delete merged.turns;
  return merged;
}

function sanitizeToolEvents(toolEvents, { scope, tracePolicyOptions = {} }) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
    return { toolEvents: [], unavailable: [] };
  }
  const sanitized = toolEvents.map((event) => sanitizeTraceValue(event, tracePolicyOptions));
  const policy = enforceTraceContentPolicy({
    spans: [{ name: "runtime_tool_events", attributes: { tool_events: sanitized } }],
  }, tracePolicyOptions);
  if (!policy.ok) {
    return {
      toolEvents: [],
      unavailable: [{ scope, reason: policy.reason }],
    };
  }
  return { toolEvents: sanitized, unavailable: [] };
}

function sanitizeTraceValue(value, tracePolicyOptions = {}) {
  if (typeof value === "string") {
    return findSecretContentKeys({ value }).length > 0 ? REDACTED_TOKEN_VALUE : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, tracePolicyOptions));
  if (!isRecord(value)) return String(value ?? "");

  const sanitized = {};
  const redactedFields = [];
  const allowRichTraceContent = tracePolicyAllowsRichContent(tracePolicyOptions);
  for (const [key, nested] of Object.entries(value)) {
    if (isTraceSecretKey(key) || (!allowRichTraceContent && isTraceRichContentKey(key))) {
      redactedFields.push(key);
      continue;
    }
    sanitized[key] = sanitizeTraceValue(nested, tracePolicyOptions);
  }
  if (redactedFields.length > 0) {
    sanitized.redacted_fields = [
      ...(Array.isArray(sanitized.redacted_fields) ? sanitized.redacted_fields : []),
      ...redactedFields,
    ];
  }
  return sanitized;
}

function isTraceSecretKey(key) {
  return findSecretContentKeys({ [key]: "redacted" }).length > 0;
}

function isTraceRichContentKey(key) {
  return findRichContentKeys({ [key]: "redacted" }).length > 0;
}

function traceContentPolicyOptionsForSink(spanSink) {
  try {
    return isRecord(spanSink?.traceContentPolicy) ? spanSink.traceContentPolicy : {};
  } catch {
    return {};
  }
}

function tracePolicyAllowsRichContent(tracePolicyOptions = {}) {
  return tracePolicyOptions?.allowRichTraceContent === true
    || tracePolicyOptions?.policy?.rich_traces_enabled === true;
}

function normalizeEvidenceUnavailable(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isRecord(item))
    .map((item) => ({
      scope: stringOrFallback(sanitizeTraceValue(item.scope), "runtime.tool_events"),
      reason: stringOrFallback(sanitizeTraceValue(item.reason), RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON),
    }));
}

export function runtimeEvidenceEntries(runtimeEvidence) {
  return Object.values(runtimeEvidence || {}).filter((entry) => isRecord(entry));
}

function runtimeToolEventsUnavailable({ role }) {
  return {
    scope: runtimeToolEventsScope({ role }),
    reason: RUNTIME_TOOL_EVENTS_UNAVAILABLE_REASON,
  };
}

function runtimeToolEventsScope({ role }) {
  return `${role || "runtime"}.turn.tool_events`;
}

function contextDigestForTerminal({ produced, terminalDecision }) {
  if (typeof produced?.context_digest === "string" && produced.context_digest.trim() !== "") {
    return produced.context_digest;
  }
  if (terminalDecision.reason === "bounds_breach") {
    return "The orchestrator stopped before a terminal sub-agent packet because the round bound was exceeded.";
  }
  if (terminalDecision.reason === "subagent_turn_validation_failed") {
    return "The orchestrator stopped because a subagent turn failed validation after a repair retry.";
  }
  if (terminalDecision.reason === "orchestrator_turn_validation_failed") {
    return "The orchestrator stopped because it could not produce a valid control action after a repair retry.";
  }
  return "The orchestrator reached a terminal control outcome.";
}

function fallbackSourceRefs({ wake, project }) {
  const projectId = project?.id || wake?.object_id || wake?.objectId || null;
  return projectId ? [{ kind: "linear_project", id: projectId }] : [];
}

function markdownWithRunId({ markdown = null, runId, fallbackBody }) {
  if (
    typeof markdown === "string" &&
    new RegExp(`^run_id:[ \\t]*${escapeRegex(runId)}[ \\t]*$`, "m").test(markdown)
  ) {
    return markdown;
  }
  return `run_id: ${runId}\n\n${fallbackBody}`;
}

// Fallback pause body when the orchestrator's produced content lacked an
// authored project_update_markdown. Keyed by the terminal pause REASON the
// orchestrator chose (the control action's reason), not a per-phase packet.
function pauseProjectUpdateBody(reason, produced) {
  if (reason === "discovery_needed") {
    return projectUpdateFallbackBody(
      "Decomposition paused because technical discovery is needed before safe issue creation.",
    );
  }
  if (reason === "needs_pm_review") {
    return projectUpdateFallbackBody([
      "Decomposition paused because a technical constraint affects product scope.",
      produced?.technical_explanation_markdown || "",
    ].filter(Boolean).join("\n\n"));
  }
  return projectUpdateFallbackBody("Decomposition paused for product questions before issue creation.");
}

function projectUpdateFallbackBody(summary) {
  return [
    summary,
    "",
    PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
    "- The run stopped before a fully authored project-section accounting was available.",
    "- Review the open questions, risks, and source refs before retrying decomposition.",
  ].join("\n");
}

function openQuestionsForPause(reason, produced) {
  if (typeof produced?.open_questions_markdown === "string" && produced.open_questions_markdown.trim() !== "") {
    return produced.open_questions_markdown;
  }
  if (reason === "needs_pm_review") {
    return "- Should the product scope change to account for this technical constraint, or should decomposition continue within the current constraints?";
  }
  return "- What product decision should be resolved before decomposition continues?";
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
