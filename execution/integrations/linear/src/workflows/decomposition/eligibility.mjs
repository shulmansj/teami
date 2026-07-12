import { recordSpan } from "../../trace.mjs";
import {
  issueHasLabel,
  matchesStatus,
  projectBelongsToTeam,
} from "../../linear/matching-utils.mjs";
import { resolveLinearShape } from "../../linear/shape-resolver.mjs";

export async function evaluateDecompositionEligibility({ client, config, cache, projectId, trace }) {
  const shape = await resolveLinearShape({ client, config, cache });
  const project = await client.getProjectContext(projectId);
  return evaluateEligibilityFromContext({ project, shape, trace });
}

export function evaluateEligibilityFromContext({ project, shape, trace }) {
  const blockingConditions = [];
  const projectStatus = project.status || {};
  const belongsToConfiguredTeam = projectBelongsToTeam(project, shape.team.id);
  const priorExecutionIssueCount = (project.issues || []).filter(
    (issue) => !issueHasLabel(issue, shape.issueLabels.discovery.id),
  ).length;
  const plannedStatus = shape.projectStatuses.planned;
  const isConfiguredPlanned = Boolean(plannedStatus?.id) && matchesStatus(projectStatus, plannedStatus);
  const sharesPlannedCategory = Boolean(
    projectStatus.type &&
    plannedStatus?.type &&
    projectStatus.type === plannedStatus.type,
  );

  if (!belongsToConfiguredTeam) blockingConditions.push("project_wrong_team");
  if (!isConfiguredPlanned) {
    blockingConditions.push(sharesPlannedCategory ? "project_not_configured_planned" : "project_not_planned");
  }
  if (priorExecutionIssueCount > 0) blockingConditions.push("prior_execution_issues");

  const eligible = blockingConditions.length === 0;
  recordSpan(trace, "eligibility_gate", {
    eligible,
    blocking_condition: blockingConditions[0] || null,
    blocking_conditions: blockingConditions,
    "linear.project_status_id": projectStatus.id || null,
    "linear.project_status_type": projectStatus.type || null,
    "linear.belongs_to_configured_team": belongsToConfiguredTeam,
    "linear.prior_execution_issue_count": priorExecutionIssueCount,
  });

  return {
    eligible,
    blockingConditions,
    project,
    shape,
    metrics: {
      belongsToConfiguredTeam,
      priorExecutionIssueCount,
    },
  };
}
