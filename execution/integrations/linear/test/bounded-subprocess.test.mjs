import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  gitOperationForArgs,
  nonInteractiveEnv,
  resolveOperationPolicy,
  runBoundedSubprocess,
  terminateBoundedProcessTree,
} from "../../git/bounded-subprocess.mjs";

test("Git operation classification skips global option values", () => {
  assert.equal(gitOperationForArgs(["-C", "push", "status", "--short"]), "git_read");
  assert.equal(gitOperationForArgs(["-C", "checkout", "push", "origin", "HEAD"]), "git_push");
  assert.equal(gitOperationForArgs(["-c", "user.name=CI", "commit", "-m", "test"]), "git_local_mutation");
  assert.equal(gitOperationForArgs(["--git-dir", "repo.git", "ls-remote", "origin"]), "git_network_read");
});

test("callers may tighten but cannot expand operation bounds", () => {
  assert.equal(resolveOperationPolicy({ operation: "git_read", timeoutMs: 1 }).timeoutMs, 1);
  assert.equal(resolveOperationPolicy({ operation: "git_read", timeoutMs: 999_999 }).timeoutMs, 15_000);
  assert.equal(resolveOperationPolicy({ operation: "git_read", maxOutputBytes: 9_999_999 }).maxOutputBytes, 512 * 1024);
});

test("bounded subprocess forces non-interactive Git and GitHub environment", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", `process.stdout.write(JSON.stringify({
      git: process.env.GIT_TERMINAL_PROMPT,
      gh: process.env.GH_PROMPT_DISABLED,
      gcm: process.env.GCM_INTERACTIVE,
      pager: process.env.GIT_PAGER,
    }))`],
    operation: "git_read",
    env: { GIT_TERMINAL_PROMPT: "1", GH_PROMPT_DISABLED: "0" },
    exactEnv: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), {
    git: "0",
    gh: "1",
    gcm: "Never",
    pager: "cat",
  });
  assert.equal(nonInteractiveEnv({ env: { GH_PROMPT_DISABLED: "0" }, exactEnv: true }).GH_PROMPT_DISABLED, "1");
});

test("bounded subprocess redacts all captured failure output before returning", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('private-repo'); process.stderr.write('ghp_supersecret'); process.exit(2)"],
    operation: "gh_api_read",
    classifyFailure: ({ stderr }) => stderr.includes("ghp_supersecret") ? "auth_failed" : null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[captured failure output redacted/);
  assert.equal(JSON.stringify(result).includes("ghp_supersecret"), false);
  assert.equal(JSON.stringify(result).includes("private-repo"), false);
  assert.equal(result.failureCode, "auth_failed");
});

test("bounded subprocess continues draining after the total output cap", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2_000_000)); process.stderr.write('y'.repeat(2_000_000))"],
    operation: "git_read",
    maxOutputBytes: 4096,
    timeoutMs: 10_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outcome, "output_truncated");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[captured failure output redacted/);
});

test("mutation timeout returns a reconciliation-required contract", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    operation: "git_push",
    timeoutMs: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.classification, "mutation");
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.reconciliationRequired, true);
});

test("truncated mutation output fails closed as reconciliation-required", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('mutation-result-too-large')"],
    operation: "gh_api_mutation",
    maxOutputBytes: 4,
  });

  assert.equal(result.ok, false);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.reconciliationRequired, true);
});

test("read timeout is actionable without claiming an ambiguous mutation", async () => {
  const result = await runBoundedSubprocess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    operation: "git_network_read",
    timeoutMs: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.reconciliationRequired, false);
});

test("timeout returns even when process termination cannot be confirmed", async () => {
  const stream = () => {
    const value = new EventEmitter();
    value.resume = () => {};
    return value;
  };
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = { on() {}, end() {} };
  child.kill = () => false;

  const startedAt = Date.now();
  const result = await runBoundedSubprocess({
    command: "git",
    args: ["status"],
    operation: "git_read",
    timeoutMs: 20,
    spawnImpl: () => child,
    platform: "linux",
    killProcess: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, true);
  assert.equal(result.outcome, "timed_out");
  assert.ok(Date.now() - startedAt < 2500, "the caller must regain control after bounded termination attempts");
});

test("timeout terminates the spawned process tree before descendants can continue", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-bounded-tree-"));
  const marker = path.join(tempDir, "descendant-survived.txt");
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 900); setInterval(() => {}, 1000)`;
  const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  try {
    const result = await runBoundedSubprocess({
      command: process.execPath,
      args: ["-e", parent],
      operation: "git_clone",
      timeoutMs: 150,
    });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(marker), false, "a timed-out command must not leave a live descendant");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POSIX termination targets the detached process group", () => {
  const calls = [];
  terminateBoundedProcessTree({
    child: { pid: 4242, kill: () => calls.push(["root"]) },
    platform: "linux",
    spawnImpl: () => { throw new Error("must not spawn taskkill"); },
    killProcess: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[-4242, "SIGTERM"]]);
});

test("Windows termination invokes taskkill for the full descendant tree", () => {
  const calls = [];
  const killer = new EventEmitter();
  killer.unref = () => calls.push(["unref"]);
  terminateBoundedProcessTree({
    child: { pid: 31337, kill: () => calls.push(["root"]) },
    platform: "win32",
    spawnImpl: (command, args, options) => {
      calls.push([command, args, options]);
      return killer;
    },
    killProcess: () => { throw new Error("must not call process.kill on Windows"); },
  });

  assert.equal(calls[0][0], "taskkill.exe");
  assert.deepEqual(calls[0][1], ["/PID", "31337", "/T", "/F"]);
  assert.deepEqual(calls[1], ["unref"]);
});
