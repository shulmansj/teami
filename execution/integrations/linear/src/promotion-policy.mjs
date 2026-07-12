import { runBoundedGit } from "../../git/bounded-subprocess.mjs";

import {
  resolveDefaultBranchRef as resolveDefaultBranchRefCore,
  resolveTrustedPolicyRead as resolveTrustedPolicyReadCore,
} from "../../../engine/promotion-policy.mjs";

export {
  ELIGIBLE_LAUNCH_SOURCES,
  normalizePromotionPolicy,
  parsePromotionPolicy,
  PROMOTION_POLICY_PATH,
  PROMOTION_POLICY_RELATIVE_PATH,
  PROMOTION_POLICY_SCHEMA_VERSION,
  promotionPolicyValidationFailures,
  resolvePromotionPolicyPath,
  SCANNER_MANAGED_RECEIPT_INTENT,
  SCANNER_PROMPT_CANDIDATE_TAG,
} from "../../../engine/promotion-policy.mjs";

export function defaultRunGit(args, { cwd } = {}) {
  return runBoundedGit(args, { cwd });
}

export async function resolveTrustedPolicyRead({
  runGit = defaultRunGit,
  ...options
} = {}) {
  return resolveTrustedPolicyReadCore({ ...options, runGit });
}

export async function resolveDefaultBranchRef({
  runGit = defaultRunGit,
  ...options
} = {}) {
  return resolveDefaultBranchRefCore({ ...options, runGit });
}
