import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractImportSpecifiers,
  isBareModuleSpecifier,
  isPathInside,
  resolveLocalSpecifier,
} from "./import-graph-helper.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "../../../..");
const ENGINE_DIR = path.join(REPO_ROOT, "execution", "engine");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "execution", "integrations");
const GIT_PROVIDER_PATTERN = /git|github|simple-git|nodegit/i;

test("engine modules do not import providers, git providers, or child_process", () => {
  const engineModules = enumerateMjsFiles(ENGINE_DIR);
  assert.ok(engineModules.length > 0, "expected execution/engine modules to be present");

  const violations = engineModules.flatMap((modulePath) =>
    detectImportDirectionViolations({
      source: fs.readFileSync(modulePath, "utf8"),
      modulePath,
      repoRoot: REPO_ROOT,
    })
  );

  assert.deepEqual(violations, [], formatViolations(violations));
});

test("import-direction detector flags seeded provider, child_process, and git-provider violations", () => {
  const syntheticModulePath = path.join(ENGINE_DIR, "synthetic-fixture.mjs");
  const syntheticSource = [
    'import linear from "../integrations/linear/src/linear-service.mjs";',
    'import { spawn } from "node:child_process";',
    'const git = await import("simple-git");',
  ].join("\n");

  const violations = detectImportDirectionViolations({
    source: syntheticSource,
    modulePath: syntheticModulePath,
    repoRoot: REPO_ROOT,
  });

  assert.deepEqual(
    violations.map(({ specifier, reason }) => ({ specifier, reason })),
    [
      {
        specifier: "../integrations/linear/src/linear-service.mjs",
        reason: "engine_imports_provider_tree",
      },
      { specifier: "node:child_process", reason: "child_process_import" },
      { specifier: "simple-git", reason: "git_provider_import" },
    ],
  );
});

function enumerateMjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return enumerateMjsFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".mjs")) return [entryPath];
      return [];
    })
    .sort();
}

function detectImportDirectionViolations({ source, modulePath, repoRoot }) {
  return extractImportSpecifiers(source).flatMap(({ kind, specifier, line }) => {
    const violation = classifyImportViolation({ specifier, modulePath });
    if (!violation) return [];
    return [{
      module: toRepoRelativePath(modulePath, repoRoot),
      line,
      kind,
      specifier,
      reason: violation.reason,
      resolved: violation.resolved ? toRepoRelativePath(violation.resolved, repoRoot) : null,
    }];
  });
}

function classifyImportViolation({ specifier, modulePath }) {
  if (specifier === "node:child_process" || specifier === "child_process") {
    return { reason: "child_process_import", resolved: null };
  }

  const resolved = resolveLocalSpecifier({ specifier, modulePath });
  if (resolved && isPathInside(resolved, INTEGRATIONS_DIR)) {
    return { reason: "engine_imports_provider_tree", resolved };
  }

  if (isBareModuleSpecifier(specifier) && GIT_PROVIDER_PATTERN.test(specifier)) {
    return { reason: "git_provider_import", resolved: null };
  }

  return null;
}

function toRepoRelativePath(targetPath, repoRoot) {
  return path.relative(repoRoot, targetPath).replace(/\\/g, "/");
}

function formatViolations(violations) {
  if (violations.length === 0) return "expected no import-direction violations";
  return violations
    .map((violation) => {
      const resolved = violation.resolved ? ` -> ${violation.resolved}` : "";
      return `${violation.module}:${violation.line} imports ${violation.specifier}${resolved} (${violation.reason})`;
    })
    .join("\n");
}
