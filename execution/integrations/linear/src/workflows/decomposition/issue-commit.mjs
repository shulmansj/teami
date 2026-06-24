import { extractDecompositionKey, renderAuthoredIssueBody } from "../../issue-body.mjs";
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
  const issueStatuses = shape.issueStatuses || (await resolveIssueStatuses(client, config, shape.team.id));
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
      description: renderAuthoredIssueBody({
        decompositionKey,
        issueBodyMarkdown: issueBodyMarkdown(issue),
      }),
      teamId: shape.team.id,
      projectId: project.id,
      stateId: stateIdForNewExecutionIssue(issue, issueStatuses),
      labelIds: [],
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
