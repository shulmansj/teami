#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
// repoRoot = .../execution/integrations/linear/test -> up four levels.
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");

// The suite spans more than this folder: the staged-build gate ships its own
// self-tests next to the gate modules (test/publication and test/fixtures).
// Discover every tracked *.test.mjs so the standing gate actually enforces
// those checks. `git ls-files` is used so the set auto-adapts as the migration
// relocates files; a recursive filesystem walk is the fallback for non-git
// checkouts.
const SKIP_DIRS = new Set([".git", "node_modules", "coverage", "dist", "tmp"]);

function discoverViaGit() {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "*.test.mjs"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const rel = result.stdout.split("\0").filter(Boolean);
  if (rel.length === 0) return null;
  return rel.map((relative) => path.join(repoRoot, relative));
}

function discoverViaWalk(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      found.push(...discoverViaWalk(full));
    } else if (name.endsWith(".test.mjs")) {
      found.push(full);
    }
  }
  return found;
}

const discovered = discoverViaGit() ?? discoverViaWalk(repoRoot);
const testFiles = [...new Set(discovered)].sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error(`No test files found under ${repoRoot}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error(`Test runner terminated by signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
