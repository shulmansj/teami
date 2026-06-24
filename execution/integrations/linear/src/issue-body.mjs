export const DECOMPOSITION_KEY_PREFIX = "Decomposition key:";

export function renderAuthoredIssueBody({ decompositionKey, issueBodyMarkdown }) {
  return normalize(`- ${DECOMPOSITION_KEY_PREFIX} ${decompositionKey}

${issueBodyMarkdown || ""}`);
}

export function extractDecompositionKey(description) {
  const escaped = DECOMPOSITION_KEY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*[-*]\\s*${escaped}\\s*(.+?)\\s*$`, "m").exec(description || "");
  return match ? match[1].trim() : null;
}

function normalize(markdown) {
  return `${markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
}
