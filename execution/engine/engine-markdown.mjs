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
  if (field === "open_questions_markdown" && /^##[ \t]+/m.test(object[field])) {
    failureReasons.push("open_questions_markdown_contains_section_heading");
  }
  if (runId && !hasRunIdLine(object[field], runId)) {
    failureReasons.push(`${field}_missing_run_id`);
  }
}

export function hasRunIdLine(markdown, runId) {
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^run_id:[ \\t]*${escapedRunId}[ \\t]*$`, "m").test(markdown || "");
}
