export const RESOURCE_TARGET_INFO_STRING = "af-resource-target";

export function renderResourceTargetBlock(resourceTarget) {
  const normalized = normalizeResourceTarget(resourceTarget);
  if (!normalized) return "";
  return `\`\`\`${RESOURCE_TARGET_INFO_STRING} ${JSON.stringify(normalized)}\n\`\`\`\n`;
}

export function parseResourceTargetFromDescription(description) {
  if (typeof description !== "string" || description.trim() === "") return null;

  const fencePattern = /(?:^|\n)```af-resource-target[ \t]+(?<json>[^\n]+)\n[\s\S]*?```/g;
  for (const match of description.matchAll(fencePattern)) {
    try {
      const parsed = JSON.parse(match.groups.json.trim());
      const normalized = normalizeResourceTarget(parsed);
      if (normalized) return normalized;
    } catch {
      // Malformed AF-owned blocks are treated as absent so readers stay tolerant.
    }
  }
  return null;
}

function normalizeResourceTarget(resourceTarget) {
  if (!resourceTarget || typeof resourceTarget !== "object" || Array.isArray(resourceTarget)) return null;
  const kind = nonEmptyString(resourceTarget.kind);
  const id = nonEmptyString(resourceTarget.id);
  if (!kind || !id) return null;

  const normalized = { kind, id };
  if (Object.hasOwn(resourceTarget, "repo_scope")) {
    const repoScope = nonEmptyString(resourceTarget.repo_scope);
    if (!repoScope) return null;
    normalized.repo_scope = repoScope;
  }
  return normalized;
}

function nonEmptyString(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}
