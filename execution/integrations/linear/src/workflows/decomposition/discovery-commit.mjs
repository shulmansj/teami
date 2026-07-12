import { hasRunIdLine } from "../../../../../engine/engine-markdown.mjs";

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
