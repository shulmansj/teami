import {
  hasRunIdLine,
  PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
  requireAuthoredMarkdown,
} from "../../../../../engine/engine-markdown.mjs";
import { STABLE_KEY_PATTERN } from "../../../../../engine/stable-key-pattern.mjs";
import { evaluateDecompositionQualityOffline } from "../../quality.mjs";
import { WORK_TYPES } from "../execution/work-type.mjs";

const COMMIT_PROJECT_UPDATE_SUMMARY =
  "Decomposition completed with a synthesis-ready issue set.";

const FINAL_ISSUE_REQUIRED_STRING_FIELDS = [
  "decomposition_key",
  "title",
  "issue_body_markdown",
];
const FINAL_ISSUE_REQUIRED_AGENT_READY_FIELDS = ["assignment", "output"];

export function assembleCommitPayload(produced, ctx = {}) {
  const authored = isRecord(produced) ? produced : {};
  return {
    project_update_fallback_body: commitProjectUpdateFallbackBody(ctx),
    final_issues: normalizeFinalIssuesForOrchestrator(authored.final_issues || []),
  };
}

export function validateCommitPayload(terminalOutput) {
  const output = isRecord(terminalOutput) ? terminalOutput : {};
  const failureReasons = [];

  validateFinalIssues(output.final_issues, failureReasons);
  requireProjectUpdateWithRunId(output, failureReasons);

  return { ok: failureReasons.length === 0, failureReasons: [...new Set(failureReasons)] };
}

export function qualityGateInput(terminalOutput) {
  const finalIssues = terminalOutput?.final_issues;
  const issues = Array.isArray(finalIssues) ? finalIssues.map(mapFinalIssueToQualityIssue) : [];
  return evaluateDecompositionQualityOffline({
    issues,
    dependencies: dependenciesFromFinalIssues(finalIssues),
  });
}

export const commitPayload = Object.freeze({
  assembleCommitPayload,
  validateCommitPayload,
  qualityGateInput,
});

function commitProjectUpdateFallbackBody(ctx) {
  if (typeof ctx?.projectUpdateFallbackBody === "function") {
    return ctx.projectUpdateFallbackBody(COMMIT_PROJECT_UPDATE_SUMMARY);
  }
  return [
    COMMIT_PROJECT_UPDATE_SUMMARY,
    "",
    PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
    "- The run stopped before a fully authored project-section accounting was available.",
    "- Review the open questions, risks, and source refs before retrying decomposition.",
  ].join("\n");
}

function requireProjectUpdateWithRunId(terminalOutput, failureReasons) {
  requireAuthoredMarkdown(terminalOutput, "project_update_markdown", failureReasons, {
    allowBlank: false,
  });
  if (
    typeof terminalOutput.project_update_markdown === "string" &&
    typeof terminalOutput.run_id === "string" &&
    !hasRunIdLine(terminalOutput.project_update_markdown, terminalOutput.run_id)
  ) {
    failureReasons.push("project_update_markdown_missing_run_id");
  }
  if (
    typeof terminalOutput.project_update_markdown === "string" &&
    !terminalOutput.project_update_markdown.includes(PROJECT_UPDATE_ACCOUNTABILITY_HEADING)
  ) {
    failureReasons.push("project_update_markdown_missing_accountability_section");
  }
}

export function validateFinalIssues(finalIssues, failureReasons) {
  if (!Array.isArray(finalIssues)) {
    failureReasons.push("missing_final_issues");
    return;
  }
  if (finalIssues.length === 0) {
    failureReasons.push("empty_final_issues");
    return;
  }

  const seenKeys = new Set();
  const duplicateKeys = new Set();

  for (const issue of finalIssues) {
    if (!isRecord(issue)) {
      failureReasons.push("invalid_final_issue");
      continue;
    }

    const key = issue.decomposition_key;
    if (typeof key === "string" && key.trim() !== "") {
      if (!STABLE_KEY_PATTERN.test(key)) failureReasons.push("invalid_decomposition_key");
      if (seenKeys.has(key)) duplicateKeys.add(key);
      seenKeys.add(key);
    }

    for (const field of FINAL_ISSUE_REQUIRED_STRING_FIELDS) {
      if (typeof issue[field] !== "string" || issue[field].trim() === "") {
        failureReasons.push(`missing_final_issue_${field}`);
      }
    }

    if (!Array.isArray(issue.depends_on)) {
      failureReasons.push("missing_final_issue_depends_on");
    }

    for (const field of FINAL_ISSUE_REQUIRED_AGENT_READY_FIELDS) {
      if (!nonEmptyString(issue[field])) failureReasons.push(`missing_final_issue_${field}`);
    }

    if (
      !Array.isArray(issue.acceptance_criteria) ||
      issue.acceptance_criteria.length === 0 ||
      !issue.acceptance_criteria.every(nonEmptyString)
    ) {
      failureReasons.push("missing_final_issue_acceptance_criteria");
    }

    if (Object.hasOwn(issue, "work_type") && !WORK_TYPES.includes(issue.work_type)) {
      failureReasons.push("invalid_final_issue_work_type");
    }

    if (Object.hasOwn(issue, "resource_target") && !validResourceTarget(issue.resource_target)) {
      failureReasons.push("invalid_final_issue_resource_target");
    }
  }

  if (duplicateKeys.size > 0) failureReasons.push("duplicate_decomposition_key");

  const dependencyGraph = new Map();
  for (const issue of finalIssues) {
    if (!isRecord(issue) || !Array.isArray(issue.depends_on)) continue;
    const key = issue.decomposition_key;
    if (!nonEmptyString(key)) continue;
    const dependencies = [];
    for (const dependencyKey of issue.depends_on) {
      if (typeof dependencyKey !== "string" || !seenKeys.has(dependencyKey)) {
        failureReasons.push("unknown_dependency_key");
        continue;
      }
      if (dependencyKey === key) failureReasons.push("self_dependency_key");
      dependencies.push(dependencyKey);
    }
    dependencyGraph.set(key, dependencies);
  }
  if (dependencyGraphHasCycle(dependencyGraph)) failureReasons.push("cyclic_dependency_key");
}

function mapFinalIssueToQualityIssue(finalIssue = {}) {
  const issue = isRecord(finalIssue) ? finalIssue : {};
  return {
    decompositionKey: issue.decomposition_key,
    assignment: issue.assignment,
    output: issue.output,
    acceptanceCriteria: issue.acceptance_criteria,
    dependsOn: issue.depends_on,
  };
}

function dependenciesFromFinalIssues(finalIssues) {
  if (!Array.isArray(finalIssues)) return [];

  return finalIssues.flatMap((issue) => {
    if (!issue?.decomposition_key || !Array.isArray(issue.depends_on)) return [];
    return issue.depends_on.map((dependsOn) => ({
      decompositionKey: issue.decomposition_key,
      dependsOn,
    }));
  });
}

// Normalize each authored final issue to the canonical snake_case Linear handoff
// shape. This is ALIAS-ONLY: it maps camelCase/alternate spellings onto the
// canonical keys. It NEVER synthesizes issue substance; missing authored values
// stay missing so the commit floor rejects them instead of inventing content.
export function normalizeFinalIssuesForOrchestrator(finalIssues) {
  if (!Array.isArray(finalIssues)) return [];
  return finalIssues.map((issue) => {
    const source = isRecord(issue) ? issue : {};
    const normalized = {};
    assignAuthoredField(normalized, "decomposition_key", source.decomposition_key ?? source.decompositionKey);
    assignAuthoredField(normalized, "title", source.title);
    assignAuthoredField(
      normalized,
      "issue_body_markdown",
      source.issue_body_markdown ?? source.body_markdown ?? source.description,
    );
    normalized.depends_on = Array.isArray(source.depends_on)
      ? source.depends_on
      : Array.isArray(source.dependsOn)
        ? source.dependsOn
        : [];
    assignAuthoredField(normalized, "assignment", source.assignment);
    assignAuthoredField(normalized, "output", source.output);
    const acceptanceCriteria = source.acceptance_criteria ?? source.acceptanceCriteria;
    if (acceptanceCriteria !== undefined) normalized.acceptance_criteria = acceptanceCriteria;
    if (Object.hasOwn(source, "work_type") || Object.hasOwn(source, "workType")) {
      normalized.work_type = source.work_type ?? source.workType;
    }
    if (Object.hasOwn(source, "resource_target") || Object.hasOwn(source, "resourceTarget")) {
      normalized.resource_target = normalizeResourceTargetForOrchestrator(
        source.resource_target ?? source.resourceTarget,
      );
    }
    return normalized;
  });
}

function normalizeResourceTargetForOrchestrator(resourceTarget) {
  if (!isRecord(resourceTarget)) return resourceTarget;
  const normalized = {};
  if (Object.hasOwn(resourceTarget, "kind")) normalized.kind = resourceTarget.kind;
  if (Object.hasOwn(resourceTarget, "id")) normalized.id = resourceTarget.id;
  if (Object.hasOwn(resourceTarget, "repo_scope")) normalized.repo_scope = resourceTarget.repo_scope;
  return normalized;
}

function assignAuthoredField(target, key, value) {
  if (typeof value === "string" && value.trim() !== "") {
    target[key] = value;
  }
}

function dependencyGraphHasCycle(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(key) {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependencyKey of graph.get(key) || []) {
      if (visit(dependencyKey)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  }

  for (const key of graph.keys()) {
    if (visit(key)) return true;
  }
  return false;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validResourceTarget(value) {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["kind", "id", "repo_scope"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!nonEmptyString(value.kind) || !nonEmptyString(value.id)) return false;
  if (Object.hasOwn(value, "repo_scope") && !nonEmptyString(value.repo_scope)) return false;
  return true;
}
