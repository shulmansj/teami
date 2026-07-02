import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  decompositionEvalNamespacePath,
  resolveDecompositionEvalPath,
} from "./workflows/decomposition/eval-paths.mjs";

// Repo-owned workspace eval policy (execution/evals/decomposition/
// workspace-eval-policy.json). Every value is HUMAN-SET: there is no automatic
// maturity/category/impact transition logic anywhere in MVP (plan ~1107-1117).
// Rich promotion loads this policy at promotion time for example metadata and
// deterministic train/test split assignment; validation is strict and derives
// its enums from the canonical schema artifacts so the policy can never drift
// from example.schema.json.

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

export const WORKSPACE_EVAL_POLICY_PATH = resolveDecompositionEvalPath(
  MODULE_REPO_ROOT,
  decompositionEvalNamespacePath("workspace-eval-policy.json"),
);
export const WORKSPACE_EVAL_POLICY_SCHEMA_VERSION = "teami-workspace-eval-policy/v1";

const exampleSchema = JSON.parse(
  fs.readFileSync(
    resolveDecompositionEvalPath(MODULE_REPO_ROOT, decompositionEvalNamespacePath("example.schema.json")),
    "utf8",
  ),
);
const exampleMetadataProperties = exampleSchema.properties.metadata.properties;

export const WORKSPACE_MATURITY_VALUES = Object.freeze([
  ...exampleMetadataProperties.workspace_maturity.enum,
]);
export const PROJECT_CATEGORY_VALUES = Object.freeze([
  ...exampleMetadataProperties.project_category.enum,
]);
export const PROJECT_IMPACT_LEVEL_VALUES = Object.freeze([
  ...exampleMetadataProperties.project_impact_level.enum,
]);
export const DATASET_SPLIT_VALUES = Object.freeze([
  ...exampleMetadataProperties.dataset_split.enum,
]);
// Splits that may ONLY be assigned by an explicit flag at promotion time,
// never by the deterministic hash.
export const FLAG_ONLY_SPLITS = Object.freeze(
  DATASET_SPLIT_VALUES.filter((split) => split !== "train" && split !== "test"),
);

export function workspaceEvalPolicyValidationFailures(policy) {
  const failures = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["policy_not_object"];
  }
  if (policy.schema_version !== WORKSPACE_EVAL_POLICY_SCHEMA_VERSION) {
    failures.push("unsupported_workspace_eval_policy_schema_version");
  }
  if (!WORKSPACE_MATURITY_VALUES.includes(policy.workspace_maturity)) {
    failures.push("invalid_workspace_maturity");
  }
  failures.push(...validateValueWithOverrides(
    policy.project_category,
    PROJECT_CATEGORY_VALUES,
    "project_category",
  ));
  failures.push(...validateValueWithOverrides(
    policy.project_impact_level,
    PROJECT_IMPACT_LEVEL_VALUES,
    "project_impact_level",
  ));
  const split = policy.split_assignment;
  if (!split || typeof split !== "object" || Array.isArray(split)) {
    failures.push("missing_split_assignment");
  } else {
    if (split.method !== "sha256_of_example_id_mod_total_buckets") {
      failures.push("unsupported_split_assignment_method");
    }
    if (!Number.isInteger(split.test_buckets) || split.test_buckets < 1) {
      failures.push("invalid_split_test_buckets");
    }
    if (!Number.isInteger(split.total_buckets) || split.total_buckets < 2) {
      failures.push("invalid_split_total_buckets");
    }
    if (
      Number.isInteger(split.test_buckets)
      && Number.isInteger(split.total_buckets)
      && split.test_buckets >= split.total_buckets
    ) {
      failures.push("split_test_buckets_must_be_less_than_total_buckets");
    }
    if (
      !Array.isArray(split.flag_only_splits)
      || split.flag_only_splits.length !== FLAG_ONLY_SPLITS.length
      || !FLAG_ONLY_SPLITS.every((name) => split.flag_only_splits.includes(name))
    ) {
      failures.push("invalid_flag_only_splits");
    }
  }
  return [...new Set(failures)];
}

function validateValueWithOverrides(section, allowedValues, label) {
  const failures = [];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return [`missing_${label}`];
  }
  if (!allowedValues.includes(section.default)) failures.push(`invalid_${label}_default`);
  const overrides = section.overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    failures.push(`invalid_${label}_overrides`);
  } else {
    for (const value of Object.values(overrides)) {
      if (!allowedValues.includes(value)) failures.push(`invalid_${label}_override_value`);
    }
  }
  return failures;
}

export function loadWorkspaceEvalPolicy({ policyPath = WORKSPACE_EVAL_POLICY_PATH } = {}) {
  if (!fs.existsSync(policyPath)) {
    throw new Error(`workspace eval policy not found: ${policyPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`workspace eval policy is not valid JSON (${policyPath}): ${error.message}`);
  }
  const failures = workspaceEvalPolicyValidationFailures(parsed);
  if (failures.length > 0) {
    throw new Error(`Invalid workspace eval policy (${policyPath}): ${failures.join(", ")}`);
  }
  return parsed;
}

// Overrides are keyed by Linear project id (preferred, stable) or exact
// project name; the human-set default applies otherwise.
export function resolveProjectCategory(policy, { projectId = null, projectName = null } = {}) {
  return resolveWithOverrides(policy.project_category, { projectId, projectName });
}

export function resolveProjectImpactLevel(policy, { projectId = null, projectName = null } = {}) {
  return resolveWithOverrides(policy.project_impact_level, { projectId, projectName });
}

function resolveWithOverrides(section, { projectId, projectName }) {
  const overrides = section.overrides || {};
  if (projectId && Object.hasOwn(overrides, projectId)) {
    return { value: overrides[projectId], source: "project_id_override" };
  }
  if (projectName && Object.hasOwn(overrides, projectName)) {
    return { value: overrides[projectName], source: "project_name_override" };
  }
  return { value: section.default, source: "policy_default" };
}

// Deterministic train/test assignment at promotion time: bucket = first 8
// bytes of sha256(example_id) as an unsigned integer, modulo total_buckets;
// bucket < test_buckets => test, else train. The same example id always lands
// in the same split on any machine with no stored counter. calibration and
// regression are NEVER hash-assigned: they require the explicit flag.
export function assignDatasetSplit(policy, { exampleId, explicitSplit = null } = {}) {
  if (!exampleId || typeof exampleId !== "string") {
    throw new Error("assignDatasetSplit requires a non-empty example id.");
  }
  const rules = policy.split_assignment;
  if (explicitSplit !== null && explicitSplit !== undefined) {
    if (!rules.flag_only_splits.includes(explicitSplit)) {
      throw new Error(
        `explicit split "${explicitSplit}" is not allowed: only ${rules.flag_only_splits.join("|")} may be assigned by flag; train/test membership is always deterministic from the policy hash rule.`,
      );
    }
    return {
      split: explicitSplit,
      method: "explicit_flag",
      example_id: exampleId,
    };
  }
  const digest = createHash("sha256").update(exampleId, "utf8").digest();
  const bucket = Number(digest.readBigUInt64BE(0) % BigInt(rules.total_buckets));
  return {
    split: bucket < rules.test_buckets ? "test" : "train",
    method: rules.method,
    bucket,
    test_buckets: rules.test_buckets,
    total_buckets: rules.total_buckets,
    example_id: exampleId,
  };
}
