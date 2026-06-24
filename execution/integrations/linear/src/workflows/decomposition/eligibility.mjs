import { recordSpan } from "../../trace.mjs";
import {
  discoveryIssuesForProject,
  isIssueOpen,
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
  const hasOpenQuestionsLabel = project.labels?.some(
    (label) => label.id === shape.projectLabels.hasOpenQuestions.id,
  );
  const discoveryIssues = discoveryIssuesForProject(project, shape);
  const openDiscoveryIssueCount = discoveryIssues.filter(isIssueOpen).length;
  const nonDiscoveryIssueCount = (project.issues || []).filter(
    (issue) => !issueHasLabel(issue, shape.issueLabels.discovery.id),
  ).length;
  const discoveryRoundCount = discoveryIssues.length;
  const isPlanned = matchesStatus(projectStatus, shape.projectStatuses.planned);

  if (!belongsToConfiguredTeam) blockingConditions.push("project_wrong_team");
  if (!isPlanned) blockingConditions.push("project_not_planned");
  if (hasOpenQuestionsLabel) blockingConditions.push("has_open_questions");
  if (isPlanned && hasOpenQuestionsLabel) blockingConditions.push("status_label_mismatch");
  if (openDiscoveryIssueCount > 0) blockingConditions.push("open_discovery_issue");
  if (nonDiscoveryIssueCount > 0) blockingConditions.push("prior_execution_issues");

  const eligible = blockingConditions.length === 0;
  recordSpan(trace, "eligibility_gate", {
    eligible,
    blocking_condition: blockingConditions[0] || null,
    blocking_conditions: blockingConditions,
    "linear.project_status_id": projectStatus.id || null,
    "linear.project_status_type": projectStatus.type || null,
    "linear.belongs_to_configured_team": belongsToConfiguredTeam,
    "linear.has_open_questions_label": Boolean(hasOpenQuestionsLabel),
    "linear.open_discovery_issue_count": openDiscoveryIssueCount,
    "linear.non_discovery_issue_count": nonDiscoveryIssueCount,
    "decomposition.discovery_round_count": discoveryRoundCount,
  });

  return {
    eligible,
    blockingConditions,
    project,
    shape,
    metrics: {
      hasOpenQuestionsLabel: Boolean(hasOpenQuestionsLabel),
      belongsToConfiguredTeam,
      openDiscoveryIssueCount,
      nonDiscoveryIssueCount,
      discoveryRoundCount,
    },
  };
}

