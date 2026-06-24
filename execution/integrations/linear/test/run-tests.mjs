#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => path.join(testDir, name));

if (testFiles.length === 0) {
  console.error(`No test files found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
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
