export const PROJECT_UPDATE_ACCOUNTABILITY_HEADING =
  "## What I did with each part of your project";

export function requireAuthoredMarkdown(object, field, failureReasons, { allowBlank, runId } = {}) {
  if (!Object.hasOwn(object, field) || typeof object[field] !== "string") {
    failureReasons.push(`missing_${field}`);
    return;
  }
  if (!allowBlank && object[field].trim() === "") {
    failureReasons.push(`blank_${field}`);
  }
  // (Removed a stale `open_questions_markdown` "no ## heading" check: it prevented a nested
  // section back when the questions were inserted UNDER a `## Open Questions` project-body
  // section. That body section is retired — `open_questions_markdown` is now free-form project
  // COMMENT content, where a heading is fine — and the check was failing-closed legitimate
  // pauses whose questions happened to contain a heading. Grounded live 2026-07-07.)
  if (runId && !hasRunIdLine(object[field], runId)) {
    failureReasons.push(`${field}_missing_run_id`);
  }
}

export function hasRunIdLine(markdown, runId) {
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^run_id:[ \\t]*${escapedRunId}[ \\t]*$`, "m").test(markdown || "");
}
