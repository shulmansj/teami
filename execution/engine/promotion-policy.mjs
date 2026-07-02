import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { evalNamespacePaths } from "./eval-namespace.mjs";

// Provider-free promotion policy core. Integrations inject git access with
// runGit; the engine never imports child_process or a git provider.

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_DECOMPOSITION_EVAL_DEFINITION = Object.freeze({
  workflow_type: "decomposition",
  eval_namespace: "execution/evals/decomposition",
});

export function resolvePromotionPolicyPath(
  definition = DEFAULT_DECOMPOSITION_EVAL_DEFINITION,
  repoRoot = MODULE_REPO_ROOT,
) {
  const relativePath = evalNamespacePaths(definition).policy;
  return Object.freeze({
    path: path.resolve(repoRoot, relativePath),
    relativePath,
  });
}

const DEFAULT_PROMOTION_POLICY_PATHS = resolvePromotionPolicyPath(
  DEFAULT_DECOMPOSITION_EVAL_DEFINITION,
  MODULE_REPO_ROOT,
);

export const PROMOTION_POLICY_PATH = DEFAULT_PROMOTION_POLICY_PATHS.path;
export const PROMOTION_POLICY_RELATIVE_PATH = DEFAULT_PROMOTION_POLICY_PATHS.relativePath;
export const PROMOTION_POLICY_SCHEMA_VERSION = "teami-promotion-policy/v1";
export const ELIGIBLE_LAUNCH_SOURCES = Object.freeze([
  "managed_manual",
  "managed_automated",
  "phoenix_native_registered",
]);
export const SCANNER_MANAGED_RECEIPT_INTENT = "promotion_candidate";
export const SCANNER_PROMPT_CANDIDATE_TAG = "teami_promotion_candidate";

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function promotionPolicyValidationFailures(policy) {
  const failures = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["policy_not_object"];
  }
  if (policy.schema_version !== PROMOTION_POLICY_SCHEMA_VERSION) {
    failures.push("unsupported_promotion_policy_schema_version");
  }
  if (!String(policy.policy_version ?? "").trim()) failures.push("missing_policy_version");
  if (typeof policy.disabled !== "boolean") failures.push("invalid_disabled_flag");
  if (!Number.isInteger(policy.lookback_days) || policy.lookback_days < 1) {
    failures.push("invalid_lookback_days");
  }
  if (!Number.isInteger(policy.max_open_proposals) || policy.max_open_proposals < 1) {
    failures.push("invalid_max_open_proposals");
  }
  const budget = policy.proposal_budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)
    || !Number.isInteger(budget.max_proposals) || budget.max_proposals < 1
    || !Number.isInteger(budget.period_days) || budget.period_days < 1) {
    failures.push("invalid_proposal_budget");
  }
  if (!Array.isArray(policy.eligible_launch_sources)
    || policy.eligible_launch_sources.length === 0
    || !policy.eligible_launch_sources.every((source) => ELIGIBLE_LAUNCH_SOURCES.includes(source))) {
    failures.push("invalid_eligible_launch_sources");
  }
  const drafting = policy.drafting;
  if (!plainObject(drafting)
    || !Number.isInteger(drafting.max_drafts_per_target_per_period)
    || drafting.max_drafts_per_target_per_period < 1
    || !Number.isInteger(drafting.period_days)
    || drafting.period_days < 1) {
    failures.push("invalid_drafting");
  }
  if (!Array.isArray(policy.required_evidence_id_kinds)
    || !policy.required_evidence_id_kinds.every((kind) => typeof kind === "string" && kind.trim())) {
    failures.push("invalid_required_evidence_id_kinds");
  }
  const scanner = policy.scanner_routing;
  if (!scanner || typeof scanner !== "object" || Array.isArray(scanner)) {
    failures.push("invalid_scanner_routing");
  } else {
    if (typeof scanner.enabled !== "boolean") failures.push("invalid_scanner_routing_enabled");
    if (!Number.isInteger(scanner.freshness_window_days) || scanner.freshness_window_days < 1) {
      failures.push("invalid_scanner_freshness_window_days");
    }
    const eligible = scanner.eligible_phoenix;
    if (!eligible || typeof eligible !== "object" || Array.isArray(eligible)
      || !stringArray(eligible.project_names)
      || !stringArray(eligible.dataset_names)
      || !stringArray(eligible.split_names)) {
      failures.push("invalid_scanner_eligible_phoenix");
    }
    const signals = scanner.explicit_intent_signals;
    if (!signals || typeof signals !== "object" || Array.isArray(signals)
      || signals.managed_experiment_receipt_intent !== SCANNER_MANAGED_RECEIPT_INTENT
      || signals.prompt_version_candidate_tag !== SCANNER_PROMPT_CANDIDATE_TAG
      || signals.repo_candidate_artifact_intent !== SCANNER_MANAGED_RECEIPT_INTENT
      || typeof signals.authenticated_registration !== "string") {
      failures.push("invalid_scanner_explicit_intent_signals");
    }
    if (!Array.isArray(scanner.repo_candidate_artifact_stubs)
      || !scanner.repo_candidate_artifact_stubs.every((stub) =>
        stub
        && typeof stub === "object"
        && !Array.isArray(stub)
        && typeof stub.directory === "string"
        && stub.directory.trim()
        && (stub.file_extension === undefined || typeof stub.file_extension === "string"))) {
      failures.push("invalid_scanner_repo_candidate_artifact_stubs");
    }
    if (scanner.phoenix_native_auto_proposal !== false) {
      failures.push("invalid_scanner_phoenix_native_auto_proposal");
    }
  }
  const risk = policy.risk_defaults;
  if (!risk || typeof risk !== "object" || Array.isArray(risk)
    || typeof risk.prior_test_split_exposure_defaults_high_risk !== "boolean") {
    failures.push("invalid_risk_defaults");
  }
  return [...new Set(failures)];
}

export function parsePromotionPolicy(bytes, { sourceLabel = "promotion policy" } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error.message}`);
  }
  const failures = promotionPolicyValidationFailures(parsed);
  if (failures.length > 0) {
    throw new Error(`Invalid ${sourceLabel}: ${failures.join(", ")}`);
  }
  return {
    policy: normalizePromotionPolicy(parsed),
    policyHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function normalizePromotionPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return policy;
  const rest = { ...policy };
  delete rest["autonomy" + "_maturity"];
  delete rest["objective" + "_auto_disable"];
  return rest;
}

function missingRunGitResult() {
  return {
    ok: false,
    reason: "trusted_policy_read_requires_git_provider",
    detail: "unattended promotion policy reads require an injected runGit provider.",
  };
}

export function resolveTrustedPolicyRead({
  mode,
  policyPath = PROMOTION_POLICY_PATH,
  policyRelativePath = PROMOTION_POLICY_RELATIVE_PATH,
  internalCloneDir = null,
  runGit = null,
} = {}) {
  if (mode === "user_invoked") {
    if (!fs.existsSync(policyPath)) {
      return { ok: false, reason: "promotion_policy_not_found", detail: policyPath };
    }
    const policyText = fs.readFileSync(policyPath, "utf8");
    let parsed;
    try {
      parsed = parsePromotionPolicy(Buffer.from(policyText, "utf8"), {
        sourceLabel: `promotion policy (${policyPath})`,
      });
    } catch (error) {
      return { ok: false, reason: "promotion_policy_invalid", detail: error.message };
    }
    return {
      ok: true,
      read_path: "user_invoked_active_checkout",
      policy: parsed.policy,
      policy_hash: parsed.policyHash,
      policy_text: policyText,
      source: policyPath,
    };
  }
  if (mode === "unattended") {
    if (!internalCloneDir || !fs.existsSync(path.join(internalCloneDir, ".git"))) {
      return {
        ok: false,
        reason: "trusted_policy_read_requires_internal_clone",
        detail:
          "unattended promotion work may not trust the active checkout as policy authority; the internal clone under .teami/promotion-workspace/ is missing (CONSTRAINTS #14).",
      };
    }
    if (typeof runGit !== "function") return missingRunGitResult();
    const head = resolveDefaultBranchRef({ internalCloneDir, runGit });
    if (!head.ok) return head;
    const show = runGit(["show", `${head.ref}:${policyRelativePath}`], {
      cwd: internalCloneDir,
    });
    if (!show.ok) {
      return {
        ok: false,
        reason: "promotion_policy_missing_at_default_branch_head",
        detail: `git show ${head.ref}:${policyRelativePath} failed: ${show.stderr.trim() || show.stdout.trim()}`,
      };
    }
    const policyText = show.stdout;
    let parsed;
    try {
      parsed = parsePromotionPolicy(Buffer.from(policyText, "utf8"), {
        sourceLabel: `promotion policy (${head.ref}:${policyRelativePath})`,
      });
    } catch (error) {
      return { ok: false, reason: "promotion_policy_invalid", detail: error.message };
    }
    return {
      ok: true,
      read_path: "unattended_internal_clone_default_branch_head",
      policy: parsed.policy,
      policy_hash: parsed.policyHash,
      policy_text: policyText,
      source: `${head.ref}:${policyRelativePath}`,
    };
  }
  return { ok: false, reason: "invalid_trusted_policy_read_mode", detail: String(mode) };
}

// The internal clone's remote default branch (origin/HEAD), never the
// adopter checkout's current branch.
export function resolveDefaultBranchRef({ internalCloneDir, runGit = null } = {}) {
  if (typeof runGit !== "function") return missingRunGitResult();
  const symbolic = runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd: internalCloneDir,
  });
  if (symbolic.ok && symbolic.stdout.trim()) {
    const full = symbolic.stdout.trim();
    return { ok: true, ref: full.replace("refs/remotes/", "") };
  }
  // Older clones may lack origin/HEAD; ask the local origin directly.
  const remoteHead = runGit(["ls-remote", "--symref", "origin", "HEAD"], { cwd: internalCloneDir });
  if (remoteHead.ok) {
    const match = remoteHead.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (match) return { ok: true, ref: `origin/${match[1]}` };
  }
  return {
    ok: false,
    reason: "default_branch_unresolvable",
    detail: "could not resolve origin's default branch for the internal promotion workspace.",
  };
}
