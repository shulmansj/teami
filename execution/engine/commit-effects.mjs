import {
  hasProducedIdentityProjector,
  projectAndAttachProducedIdentities,
} from "./produced-identities.mjs";

export async function applyCommitEffects({ effects, ctx, trace } = {}) {
  if (!Array.isArray(effects)) {
    throw new Error("commit_effects_must_be_array");
  }

  const applied = [];
  for (const effect of effects) {
    const effectId = effect?.id;
    if (typeof effectId !== "string" || effectId.trim() === "") {
      throw new Error("commit_effect_id_required");
    }
    if (effect?.requires_pre_effect_approval === true) {
      return failedClosedEffect(effectId, "unsupported_pre_commit_gate");
    }
    try {
      const probe = await callEffectStep(effect, "probe", ctx);
      if (probe.called) {
        recordCommitEffectSpan(trace, "commit_effect_probe", {
          effect,
          ctx,
          outcome: probe.result?.satisfied === true ? "satisfied" : "not_satisfied",
        });
      }
      if (probe.result?.satisfied === true) {
        applied.push({ id: effectId, identity: probe.result.identity });
        continue;
      }

      const appliedEffect = await callEffectStep(effect, "apply", ctx);
      if (appliedEffect.called) {
        recordCommitEffectSpan(trace, "commit_effect_apply", {
          effect,
          ctx,
          outcome: resultOutcome(appliedEffect.result),
        });
      }
      if (appliedEffect.result?.ok !== true) {
        if (isExplicitTerminalFailure(appliedEffect.result)) {
          return failedClosedEffect(effectId, appliedEffect.result?.reason || "effect_apply_failed");
        }
        return pendingEffect(effectId, appliedEffect.result?.reason || "effect_apply_failed");
      }

      const verified = await callEffectStep(effect, "verify", ctx);
      if (verified.called) {
        recordCommitEffectSpan(trace, "commit_effect_verify", {
          effect,
          ctx,
          outcome: resultOutcome(verified.result),
        });
      }
      if (verified.result?.ok !== true) {
        if (isExplicitTerminalFailure(verified.result)) {
          return failedClosedEffect(effectId, verified.result?.reason || "effect_verify_failed");
        }
        return pendingEffect(effectId, verified.result?.reason || "effect_verify_failed");
      }
      applied.push({ id: effectId, identity: appliedEffect.result.identity });
    } catch (error) {
      if (error?.step === "probe") {
        recordCommitEffectSpan(trace, "commit_effect_probe", {
          effect,
          ctx,
          outcome: "pending",
        });
      } else if (error?.step === "apply") {
        recordCommitEffectSpan(trace, "commit_effect_apply", {
          effect,
          ctx,
          outcome: "pending",
        });
      } else if (error?.step === "verify") {
        recordCommitEffectSpan(trace, "commit_effect_verify", {
          effect,
          ctx,
          outcome: "pending",
        });
      }
      return pendingEffect(effectId, error?.message || "effect_failed");
    }
  }

  const produced_identities = projectAndAttachProducedIdentities({
    trace,
    effects,
    applied,
    artifactSetLineage: ctx?.artifactSetLineage,
  });
  return { outcome: "ok", applied, produced_identities };
}

export function deliverableProducesIdentity(applied) {
  return Array.isArray(applied) && applied.some((entry) => entry?.identity !== null && entry?.identity !== undefined);
}

function pendingEffect(pending_effect_id, reason) {
  return { outcome: "pending", pending_effect_id, reason };
}

function failedClosedEffect(pending_effect_id, reason) {
  return { outcome: "failed_closed", pending_effect_id, reason };
}

function resultOutcome(result) {
  if (result?.ok === true) return "ok";
  if (isExplicitTerminalFailure(result)) return "failed_closed";
  return "pending";
}

function isExplicitTerminalFailure(result) {
  return result?.ok === false && result?.terminal === true;
}

async function callEffectStep(effect, step, ctx) {
  if (typeof effect?.[step] !== "function") return { called: false, result: undefined };
  try {
    return { called: true, result: await effect[step](ctx) };
  } catch (error) {
    throw annotateStepError(error, step);
  }
}

function annotateStepError(error, step) {
  if (error && typeof error === "object") {
    try {
      error.step = step;
      return error;
    } catch {
      return { message: error.message, step };
    }
  }
  return { message: String(error || "effect_failed"), step };
}

function recordCommitEffectSpan(trace, name, { effect, ctx, outcome }) {
  try {
    if (!trace || !Array.isArray(trace.spans)) return null;
    const span = {
      name,
      attributes: {
        effect_id: effect?.id,
        op: effect?.op,
        outcome,
        run_id: ctx?.runId ?? ctx?.artifact?.run_id ?? null,
      },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    trace.spans.push(span);
    return span;
  } catch {
    return null;
  }
}
