import { spawnSync } from "node:child_process";

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
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function resolveTrustedPolicyRead({
  runGit = defaultRunGit,
  ...options
} = {}) {
  return resolveTrustedPolicyReadCore({ ...options, runGit });
}

export function resolveDefaultBranchRef({
  runGit = defaultRunGit,
  ...options
} = {}) {
  return resolveDefaultBranchRefCore({ ...options, runGit });
}
