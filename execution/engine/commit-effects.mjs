export async function applyCommitEffects({ effects, ctx } = {}) {
  if (!Array.isArray(effects)) {
    throw new Error("commit_effects_must_be_array");
  }

  const applied = [];
  for (const effect of effects) {
    const effectId = effect?.id;
    if (typeof effectId !== "string" || effectId.trim() === "") {
      throw new Error("commit_effect_id_required");
    }
    try {
      const probe = await effect.probe?.(ctx);
      if (probe?.satisfied === true) {
        applied.push({ id: effectId, identity: probe.identity });
        continue;
      }

      const appliedEffect = await effect.apply?.(ctx);
      if (appliedEffect?.ok !== true) {
        return pendingEffect(effectId, appliedEffect?.reason || "effect_apply_failed");
      }

      const verified = await effect.verify?.(ctx);
      if (verified?.ok !== true) {
        return pendingEffect(effectId, verified?.reason || "effect_verify_failed");
      }
      applied.push({ id: effectId, identity: appliedEffect.identity });
    } catch (error) {
      return pendingEffect(effectId, error?.message || "effect_failed");
    }
  }

  return { ok: true, applied };
}

function pendingEffect(pending_effect_id, reason) {
  return { ok: false, pending_effect_id, reason };
}
