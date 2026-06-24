import { hasRunIdLine } from "../../../../../engine/engine-markdown.mjs";
import { renderAuthoredIssueBody } from "../../issue-body.mjs";
import { openQuestionsSectionMarkdown } from "../../project-body.mjs";
import {
  discoveryIssueKey,
  matchesStatus,
} from "../../linear/matching-utils.mjs";
import { findIssueByDecompositionKey } from "./issue-commit.mjs";

export async function createOrReuseDiscoveryIssues({ client, project, shape, discoveryIssues }) {
  const issues = [];
  const created = [];
  const reused = [];

  for (const discoveryIssue of discoveryIssues || []) {
    const decompositionKey = discoveryIssueKey(discoveryIssue);
    const existing = await findIssueByDecompositionKey(client, project.id, decompositionKey);
    if (existing) {
      issues.push(existing);
      reused.push(existing);
      continue;
    }

    const issue = await client.createIssue({
      title: discoveryIssue.title,
      description: renderAuthoredIssueBody({
        decompositionKey,
        issueBodyMarkdown: discoveryIssue.body_markdown,
      }),
      teamId: shape.team.id,
      projectId: project.id,
      labelIds: [shape.issueLabels.discovery.id],
    });
    issues.push(issue);
    created.push(issue);
  }

  return { issues, created, reused };
}

export async function verifyOpenQuestionsAndPauseState({ client, projectId, shape, openQuestionsMarkdown }) {
  const verifiedProject = await client.getProjectContext(projectId);
  verifyOpenQuestionsMarkdown(verifiedProject, openQuestionsMarkdown);
  const hasLabel = verifiedProject.labels?.some(
    (label) => label.id === shape.projectLabels.hasOpenQuestions.id,
  );
  if (!hasLabel) throw new Error("Has Open Questions label write could not be verified.");
  if (!matchesStatus(verifiedProject.status, shape.projectStatuses.backlog)) {
    throw new Error("Backlog project status write could not be verified.");
  }
  return verifiedProject;
}

export function verifyOpenQuestionsMarkdown(project, expectedMarkdown) {
  const actual = linearCanonicalMarkdown(openQuestionsSectionMarkdown(project.content || ""));
  const expected = linearCanonicalMarkdown(expectedMarkdown);
  if (actual !== expected) {
    throw new Error("Open Questions write could not be verified.");
  }
}

export function linearCanonicalMarkdown(markdown = "") {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]*[*-][ \t]+/gm, "- ")
    .trim();
}

export async function postAuthoredProjectUpdate({ client, projectId, runId, projectUpdateMarkdown }) {
  if (typeof projectUpdateMarkdown !== "string" || projectUpdateMarkdown.trim() === "") {
    throw new Error("project_update_markdown is required for Linear project updates.");
  }
  if (!hasRunIdLine(projectUpdateMarkdown, runId)) {
    throw new Error("project_update_markdown must include the run_id for idempotency.");
  }

  const existing =
    (await client.findProjectUpdateByRunId?.(projectId, runId)) ||
    (await findProjectUpdateByBodyRunId(client, projectId, runId));
  if (existing) return { update: existing, created: false };

  const create = client.createProjectUpdate || client.postProjectUpdate;
  if (!create) throw new Error("Linear client cannot post project updates.");
  const update = await create.call(client, {
    projectId,
    body: projectUpdateMarkdown,
    runId,
  });
  return { update, created: true };
}

export async function findProjectUpdateByBodyRunId(client, projectId, runId) {
  const updates = await client.listProjectUpdates?.(projectId);
  if (!updates) return null;
  return (
    updates.find((update) => update.runId === runId || hasRunIdLine(update.body || "", runId)) ||
    null
  );
}
