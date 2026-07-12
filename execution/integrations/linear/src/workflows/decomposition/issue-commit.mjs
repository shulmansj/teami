import { extractDecompositionKey, renderAuthoredIssueBody } from "../../issue-body.mjs";
import { renderResourceTargetBlock } from "../../resource-target.mjs";
import {
  issueBodyMarkdown,
  issueDependencies,
  issueKey,
} from "../../linear/matching-utils.mjs";
import {
  resolveIssueStatuses,
  stateIdForNewExecutionIssue,
} from "../../linear/shape-resolver.mjs";

export async function createOrReuseExecutionIssues({ client, config, project, shape, issues }) {
  const issueStatuses = shape.issueStatuses ||
    (await resolveIssueStatuses(client, config, shape.team.id, shape.cache, { failClosed: true }));
  const created = [];
  const reused = [];
  const issueByKey = new Map();

  for (const issue of issues) {
    const decompositionKey = issueKey(issue);
    const existing = await findIssueByDecompositionKey(client, project.id, decompositionKey);
    if (existing) {
      reused.push(existing);
      issueByKey.set(decompositionKey, existing);
      continue;
    }

    const createdIssue = await client.createIssue({
      title: issue.title,
      description: renderExecutionIssueBody({ decompositionKey, issue }),
      teamId: shape.team.id,
      projectId: project.id,
      stateId: stateIdForNewExecutionIssue(issue, issueStatuses),
      labelIds: workTypeLabelIds(issue, shape),
    });
    created.push(createdIssue);
    issueByKey.set(decompositionKey, createdIssue);
  }

  const relationsCreated = [];
  const relationsReused = [];
  for (const issue of issues) {
    const decompositionKey = issueKey(issue);
    const dependentIssue = issueByKey.get(decompositionKey);
    for (const dependencyKey of issueDependencies(issue)) {
      const blockingIssue = issueByKey.get(dependencyKey);
      if (!blockingIssue) {
        throw new Error(`Issue ${decompositionKey} depends on unknown decomposition key ${dependencyKey}`);
      }
      const relation = await client.findOrCreateIssueRelation({
        issueId: blockingIssue.id,
        relatedIssueId: dependentIssue.id,
        type: "blocks",
      });
      if (relation.created) relationsCreated.push(relation.relation);
      else relationsReused.push(relation.relation);
    }
  }

  return { created, reused, relationsCreated, relationsReused };
}

export function decompositionKeyForIssue(issue) {
  return extractDecompositionKey(issue.description);
}

export async function findIssueByDecompositionKey(client, projectId, decompositionKey) {
  if (typeof client.listProjectIssues === "function") {
    const issues = await client.listProjectIssues(projectId);
    return issues.find((issue) => extractDecompositionKey(issue.description) === decompositionKey) || null;
  }
  if (typeof client.findIssueByDecompositionKey === "function") {
    return client.findIssueByDecompositionKey(projectId, decompositionKey);
  }
  throw new Error("Linear client must provide listProjectIssues to find issues by decomposition key.");
}

function renderExecutionIssueBody({ decompositionKey, issue }) {
  const body = renderAuthoredIssueBody({
    decompositionKey,
    issueBodyMarkdown: issueBodyMarkdown(issue),
  });
  const resourceTargetBlock = issue?.resource_target
    ? renderResourceTargetBlock(issue.resource_target)
    : "";
  if (!resourceTargetBlock) return body;
  return `${body.trimEnd()}\n\n${resourceTargetBlock}`;
}

function workTypeLabelIds(issue, shape) {
  return [
    workTypeLabel(issue?.work_type, shape)?.id,
    issue?.requires_human_review === true ? shape?.issueLabels?.human_review?.id : null,
  ].filter(Boolean);
}

function workTypeLabel(workType, shape) {
  if (workType === "code") return shape?.issueLabels?.work_type_code || null;
  if (workType === "non_code") return shape?.issueLabels?.work_type_non_code || null;
  return null;
}
