const SECTION_PATTERN = /^##[ \t]+(.+?)[ \t]*(?:\r?\n|$)/gm;

export function buildLinearProjectBody(project = {}) {
  return normalizeMarkdown(`
Linear project: ${project.name || ""}

This Linear project is the source of truth for product intent.
Execution issues in this project are downstream work items.

## Open Questions
`);
}

export function buildProjectTemplateBody() {
  return normalizeMarkdown(`
Linear project: {project_name}

This Linear project is the source of truth for product intent.
Execution issues in this project are downstream work items.

## Problem Or Opportunity

## Desired Outcome

## Acceptance Evidence

## Scope Boundaries

## Constraints And Decisions

## Open Questions
`);
}

export function ensureOpenQuestionsSection(markdown) {
  if (getSections(markdown, "Open Questions").length > 0) {
    return markdown;
  }
  return normalizeMarkdown(`${markdown.trimEnd()}\n\n## Open Questions\n`);
}

export function setOpenQuestionsMarkdown(markdown, openQuestionsMarkdown) {
  return replaceSectionContent(markdown, "Open Questions", openQuestionsMarkdown || "");
}

export function openQuestionsSectionMarkdown(markdown) {
  return sectionInnerMarkdown(getRequiredUniqueSection(markdown, "Open Questions").content);
}

export function getSection(markdown, heading) {
  const sections = findSections(markdown || "");
  return sections.find((section) => section.heading === heading) || null;
}

export function replaceSectionContent(markdown, heading, content) {
  const body = normalizeLineEndings(markdown || "");
  const section = getRequiredUniqueSection(body, heading);
  const before = ensureTrailingLineBreak(body.slice(0, section.contentStart));
  const after = body.slice(section.contentEnd);
  const normalizedContent = sectionContent(content || "", after);
  return `${before}${normalizedContent}${after}`;
}

export function normalizeMarkdown(markdown) {
  return `${normalizeLineEndings(markdown).trimEnd()}\n`;
}

export function getSections(markdown, heading) {
  return findSections(markdown || "").filter((section) => section.heading === heading);
}

function findSections(markdown) {
  const matches = [];
  SECTION_PATTERN.lastIndex = 0;
  let match = SECTION_PATTERN.exec(markdown);
  while (match) {
    matches.push({
      heading: match[1].trim(),
      headingStart: match.index,
      headingEnd: SECTION_PATTERN.lastIndex,
    });
    match = SECTION_PATTERN.exec(markdown);
  }

  return matches.map((current, index) => {
    const next = matches[index + 1];
    return {
      ...current,
      contentStart: current.headingEnd,
      contentEnd: next ? next.headingStart : markdown.length,
      content: markdown.slice(current.headingEnd, next ? next.headingStart : markdown.length),
    };
  });
}

function getRequiredUniqueSection(markdown, heading) {
  const matches = getSections(markdown, heading);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${heading} section, found ${matches.length}.`);
  }
  return matches[0];
}

function sectionContent(content, after) {
  const normalized = normalizeLineEndings(content);
  if (normalized === "") return "";
  if (after && !normalized.endsWith("\n")) return `${normalized}\n`;
  return normalized;
}

function sectionInnerMarkdown(content) {
  return content || "";
}

function ensureTrailingLineBreak(markdown) {
  if (markdown === "" || markdown.endsWith("\n")) return markdown;
  return `${markdown}\n`;
}

function normalizeLineEndings(markdown) {
  return markdown.replace(/\r\n/g, "\n");
}
