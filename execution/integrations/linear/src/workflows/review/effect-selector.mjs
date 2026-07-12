import {
  githubAfReviewStatusEffectDescriptor,
  githubPrReviewCommentEffectDescriptor,
  linearHumanReviewBriefingEffectDescriptor,
} from "../../review/teami-review-effects.mjs";
import { issueReadyEffectDescriptor } from "../../linear/issue-ready-effect.mjs";
import {
  GITHUB_AF_REVIEW_STATUS_EFFECT_ID,
  GITHUB_PR_REVIEW_COMMENT_EFFECT_ID,
  LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
} from "./effect-ids.mjs";

export const REVIEW_DISPOSITIONS = Object.freeze([
  "approve",
  "request-changes",
  "escalate",
]);

const GITHUB_REVIEW_EFFECTS = Object.freeze([
  githubPrReviewCommentEffectDescriptor({ id: GITHUB_PR_REVIEW_COMMENT_EFFECT_ID }),
  githubAfReviewStatusEffectDescriptor({ id: GITHUB_AF_REVIEW_STATUS_EFFECT_ID }),
]);
const HUMAN_REVIEW_BRIEFING_EFFECT = linearHumanReviewBriefingEffectDescriptor({
  id: LINEAR_HUMAN_REVIEW_BRIEFING_EFFECT_ID,
});
const ISSUE_READY_EFFECT = issueReadyEffectDescriptor();

export function selectEffectsForDisposition(disposition, hasPr = true, gateLabelFresh = false) {
  const route = reviewDispositionRoute(disposition);
  const githubEffects = githubReviewEffectsForRoute({ disposition, route });
  if (route === "approve") {
    return Object.freeze([
      ...githubEffects,
      ...(gateLabelFresh === true ? [HUMAN_REVIEW_BRIEFING_EFFECT] : []),
    ]);
  }
  if (route === "request-changes") {
    return Object.freeze([...githubEffects, ISSUE_READY_EFFECT]);
  }
  if (hasPr === false) {
    return Object.freeze([]);
  }
  return Object.freeze([...githubEffects]);
}

export function reviewDispositionRoute(disposition) {
  const value = String(disposition || "").trim();
  if (value === "diff_incomplete") return "escalate";
  if (REVIEW_DISPOSITIONS.includes(value)) return value;
  throw new Error(`review_disposition_invalid:${value || "missing"}`);
}

function githubReviewEffectsForRoute({ disposition, route }) {
  const value = String(disposition || "").trim();
  if (value !== "diff_incomplete") return GITHUB_REVIEW_EFFECTS;
  return GITHUB_REVIEW_EFFECTS.map((effect) => effectWithReviewDisposition(effect, route));
}

function effectWithReviewDisposition(effect, disposition) {
  return Object.freeze({
    ...effect,
    ...(typeof effect.probe === "function"
      ? { probe: (ctx) => effect.probe(ctxWithReviewDisposition(ctx, disposition)) }
      : {}),
    ...(typeof effect.apply === "function"
      ? { apply: (ctx) => effect.apply(ctxWithReviewDisposition(ctx, disposition)) }
      : {}),
    ...(typeof effect.verify === "function"
      ? { verify: (ctx) => effect.verify(ctxWithReviewDisposition(ctx, disposition)) }
      : {}),
  });
}

function ctxWithReviewDisposition(ctx = {}, disposition) {
  return {
    ...ctx,
    review: {
      ...ctx.review,
      disposition,
    },
  };
}
