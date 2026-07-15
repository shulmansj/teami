#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareTestHomeEnvironment } from "./test-home-isolation.mjs";
import { runBoundedGit } from "../../git/bounded-subprocess.mjs";

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

async function discoverViaGit() {
  const result = await runBoundedGit(["-C", repoRoot, "ls-files", "-z", "*.test.mjs"], {
    operation: "git_read",
    cwd: repoRoot,
  });
  if (!result.ok || result.outputTruncated || typeof result.stdout !== "string") return null;
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
      // Dot-directories hold untracked local state (archived checkouts,
      // tool worktrees) whose suites must never run; node --test's own
      // discovery skips them too.
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      found.push(...discoverViaWalk(full));
    } else if (name.endsWith(".test.mjs")) {
      found.push(full);
    }
  }
  return found;
}

let discovered = await discoverViaGit();
if (discovered === null) {
  console.error(
    "run-tests: git ls-files discovery failed; falling back to a filesystem walk (untracked *.test.mjs may be included)",
  );
  discovered = discoverViaWalk(repoRoot);
}
const testFiles = [...new Set(discovered)].sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error(`No test files found under ${repoRoot}`);
  process.exit(1);
}

// The source checkout keeps an identity-bearing development fixture at
// config.example.json. The published showroom deliberately omits that file and
// carries only the identity-clean package default. Tests still need a concrete
// fixture path, so create a short-lived compatibility copy when the suite runs
// from the transformed public artifact. It is removed before the security scan.
const linearRoot = path.join(repoRoot, "execution", "integrations", "linear");
const devConfigPath = path.join(linearRoot, "config.example.json");
const packagedConfigPath = path.join(linearRoot, "config.package-default.json");
const createdPublicConfigFixture = !existsSync(devConfigPath) && existsSync(packagedConfigPath);
if (createdPublicConfigFixture) writePublicDevConfigFixture();

function writePublicDevConfigFixture() {
  const config = JSON.parse(readFileSync(packagedConfigPath, "utf8"));
  config.linear.team.key = "AF";
  config.github = {
    behavior_repo: { owner: null, name: null, visibility: "private" },
    starter_remote_urls: ["https://github.com/shulmansj/teami"],
  };
  for (const workflow of Object.values(config.workflows)) {
    for (const role of Object.values(workflow.roles)) {
      delete role.runtime;
      delete role.model;
    }
  }
  for (const workflowType of ["execution", "review"]) {
    config.workflows[workflowType].roles.orchestrator.warm_continuation = {
      enabled: true,
      required: true,
    };
  }
  writeFileSync(devConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// Every state store now resolves under the per-user home (F2b relocation off repoRoot).
// node --test runs each file in its own child process, so preload a per-process TEAMI_HOME
// (see _teami-home-isolation.mjs) into every child — each file gets an isolated home instead
// of racing on (and polluting) the developer's real home. --import propagates to the children.
const homeIsolationPreload = pathToFileURL(
  path.join(testDir, "_teami-home-isolation.mjs"),
).href;
const testHome = prepareTestHomeEnvironment();
let result;
try {
  result = spawnSync(
    process.execPath,
    ["--import", homeIsolationPreload, "--test", ...testFiles],
    {
      cwd: repoRoot,
      env: testHome.childEnv,
      stdio: "inherit",
    },
  );
} finally {
  testHome.cleanup();
  if (createdPublicConfigFixture && existsSync(devConfigPath)) unlinkSync(devConfigPath);
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error(`Test runner terminated by signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
