import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { COMMAND_REGISTRY } from "../src/cli/dispatch.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const cliPath = path.join(repoRoot, "execution", "integrations", "linear", "cli.mjs");

function runCli(tokens, { root }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...tokens], {
        cwd: root,
        env: {
          ...process.env,
          FACTORY_REPO_ROOT: root,
          TEAMI_LINEAR_CONFIG: path.join(root, "missing-config.json"),
          NO_COLOR: "1",
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ stdout: "", stderr: "", code: null, spawnError: error });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, spawnError: error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, spawnError: null });
    });
  });
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).map(String).sort();
  } catch {
    return [];
  }
}

test("teami with no args shows a side-effect-free home screen and exits 0", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-home-"));
  const before = listFiles(root);
  const result = await runCli([], { root });
  try {
    if (result.spawnError?.code === "EPERM") {
      t.skip(`subprocess spawn blocked: ${result.spawnError.message}`);
      return;
    }
    assert.ifError(result.spawnError);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, out);
    assert.match(out, /not set up yet/);
    assert.match(out, /teami(?:\.cmd)? init/);
    assert.doesNotMatch(out, /Linear config not found/, "home screen loads no config");
    assert.deepEqual(listFiles(root), before, "home screen makes no filesystem writes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown command still exits 2 with a concise pointer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-unknown-"));
  const result = await runCli(["definitely-not-a-command"], { root });
  try {
    if (result.spawnError?.code === "EPERM") {
      t.skip(`subprocess spawn blocked: ${result.spawnError.message}`);
      return;
    }
    assert.ifError(result.spawnError);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 2, out);
    assert.match(out, /unknown command/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default help is curated: grouped, with zero eval/internal tokens", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-help-"));
  const result = await runCli(["--help"], { root });
  try {
    if (result.spawnError?.code === "EPERM") {
      t.skip(`subprocess spawn blocked: ${result.spawnError.message}`);
      return;
    }
    assert.ifError(result.spawnError);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, out);
    assert.match(out, /Setup[\s\S]*Run[\s\S]*Manage/);
    assert.doesNotMatch(out, /eval:|supervisor:|promotion:|draft-improvement|phoenix:/, "no operator/internal tokens in default help");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("help --all adds the operator & maintenance section", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-help-all-"));
  const result = await runCli(["help", "--all"], { root });
  try {
    if (result.spawnError?.code === "EPERM") {
      t.skip(`subprocess spawn blocked: ${result.spawnError.message}`);
      return;
    }
    assert.ifError(result.spawnError);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, out);
    assert.match(out, /Operator & maintenance/);
    assert.match(out, /eval:judge|supervisor:status/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the curated adopter set is registry-derived", () => {
  const adopter = COMMAND_REGISTRY.filter((descriptor) => descriptor.tier === "adopter");
  assert.equal(adopter.length, 11);
  for (const descriptor of adopter) {
    assert.ok(["Setup", "Run", "Manage"].includes(descriptor.helpGroup));
    assert.ok(typeof descriptor.summary === "string" && descriptor.summary.length > 0);
  }
  const forms = adopter.map((descriptor) => [descriptor.noun, descriptor.verb].filter(Boolean).join(" ")).sort();
  assert.deepEqual(forms, [
    "doctor",
    "domain add",
    "domain grant",
    "domain revoke",
    "domain show",
    "gateway start",
    "gateway status",
    "init",
    "phoenix open",
    "phoenix status",
    "uninstall",
  ]);
});
