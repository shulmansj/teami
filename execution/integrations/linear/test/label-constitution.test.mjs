import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "src");
const LABEL_WORD = "label";
const LABEL_IDS_FIELD = "label" + "Ids";

test("post-creation Linear business updates never write labels", () => {
  const violations = [];
  for (const filePath of sourceFiles(SRC_ROOT)) {
    const relativePath = path.relative(SRC_ROOT, filePath).replaceAll(path.sep, "/");
    if (relativePath === "linear-graphql-client.mjs") continue;

    const source = fs.readFileSync(filePath, "utf8");
    const updateCalls = source.matchAll(/\b(?:ctx\.client|client)\.update(?:Issue|Project)\s*\([\s\S]*?\);/g);
    for (const match of updateCalls) {
      if (!match[0].includes(LABEL_IDS_FIELD)) continue;
      violations.push(`${relativePath}:${lineNumber(source, match.index)}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("issue move effects expose only status targets", () => {
  const moveModules = [
    "linear/issue-move-effect-factory.mjs",
    "linear/issue-in-review-effect.mjs",
  ];
  const forbiddenFragments = [
    LABEL_IDS_FIELD,
    `targetType === "${LABEL_WORD}"`,
    `target_type === "${LABEL_WORD}"`,
    `${LABEL_WORD}-target`,
    "issueHasLabel",
    `${LABEL_WORD}_id:`,
  ];

  const violations = [];
  for (const relativePath of moveModules) {
    const source = fs.readFileSync(path.join(SRC_ROOT, ...relativePath.split("/")), "utf8");
    for (const fragment of forbiddenFragments) {
      if (source.includes(fragment)) violations.push(`${relativePath}: ${fragment}`);
    }
  }

  assert.deepEqual(violations, []);
});

function sourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith(".mjs") ? [entryPath] : [];
  });
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}
