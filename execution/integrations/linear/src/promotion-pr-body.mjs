import {
  buildPromotionProposalPacket,
  renderPromotionProposalPacketMarkdown,
} from "./promotion/proposal-packet.mjs";

export {
  buildPromotionProposalPacket,
  renderPromotionProposalPacketMarkdown,
};
export {
  PACKET_COMPLETENESS_GUARD_REASON,
  PACKET_COMPLETENESS_REPAIR_STATE,
  applyPromotionPacketGuardStatus,
  blockedPacketMarkerPatch,
  markPromotionPrBodyBlockedForRepair,
  ownerCopyForPacketCompletenessRepair,
  promotionMarkerPacketGuardPassed,
  promotionPacketGuardRegistryRecord,
  validatePromotionPacketCompleteness,
} from "./promotion/packet-completeness-guard.mjs";

export function buildPromotionPrTitle({ target, validatedFailureModeIds } = {}) {
  const ids = Array.isArray(validatedFailureModeIds)
    ? validatedFailureModeIds.map((id) => String(id)).filter((id) => id.length > 0)
    : [];
  return `Update ${String(target?.human_name ?? "Unknown target")}${ids.length > 0 ? ` to address ${ids.join(", ")}` : ""}`;
}

export function buildPromotionPrBody(options = {}) {
  const packet = options.proposalPacket ?? buildPromotionProposalPacket(options);
  return renderPromotionProposalPacketMarkdown(packet);
}
