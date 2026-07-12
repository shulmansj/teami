import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runExecutionProfilePreflight,
} from "../src/execution-profile-preflight.mjs";

test("execution profile preflight is green when deps install and a runnable test command exists", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "node --test",
      },
    },
  });
  const commands = [];

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: commandRecorder(commands),
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resource_id, "repo-1");
  assert.equal(result.strict_baseline_green, false);
  assert.equal(result.setup_command, "npm install");
  assert.equal(result.test_command, "npm test");
  assert.deepEqual(commands, ["npm install"]);
});

test("execution profile preflight threads envAugment into the readiness commands", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "node --test",
      },
    },
  });
  const calls = [];
  const envAugment = { TMPDIR: "/run/tmp", TMP: "/run/tmp", TEMP: "/run/tmp" };

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    strictBaselineGreen: true,
    envAugment,
    runCommand: async (command, options = {}) => {
      calls.push({
        label: [command.command, ...(command.args || [])].join(" "),
        envAugment: options.envAugment,
      });
      return "";
    },
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.label), ["npm install", "npm test"]);
  for (const call of calls) {
    assert.deepEqual(call.envAugment, envAugment);
  }
});

test("execution profile preflight red verdict is stable when dependency install fails", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "node --test",
      },
    },
  });

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: async (command) => {
      if (command.command === "npm" && command.args?.[0] === "install") {
        throw new Error("network noise must not leak into verdict");
      }
      return "";
    },
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["deps_install_failed"],
      missing: ["npm install"],
    },
    failure_reasons: ["deps_install_failed"],
  });
});

test("execution profile preflight red verdict reports no runnable test command", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "echo \"Error: no test specified\" && exit 1",
      },
    },
  });

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: async () => "",
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["no_runnable_test_command"],
      missing: ["package.json:scripts.test"],
    },
    failure_reasons: ["no_runnable_test_command"],
  });
});

test("execution profile preflight red verdict reports missing package as no runnable test command", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-preflight-no-package-"));

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: async () => "",
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["no_runnable_test_command"],
      missing: ["package.json"],
    },
    failure_reasons: ["no_runnable_test_command"],
  });
});

test("strict baseline-green is unset by default and only gates when enabled", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "node --test",
      },
    },
  });
  const looseCommands = [];
  const loose = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: commandRecorder(looseCommands, { failTest: true }),
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.equal(loose.ok, true);
  assert.deepEqual(looseCommands, ["npm install"]);

  const strictCommands = [];
  const strict = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    strictBaselineGreen: true,
    runCommand: commandRecorder(strictCommands, { failTest: true }),
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.deepEqual(strict, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["baseline_tests_failed"],
      missing: ["npm test"],
    },
    failure_reasons: ["baseline_tests_failed"],
  });
  assert.deepEqual(strictCommands, ["npm install", "npm test"]);
});

test("execution profile preflight keeps git push and GitHub API authority failures distinct", async () => {
  const repoDir = fixtureRepo({
    packageJson: {
      scripts: {
        test: "node --test",
      },
    },
  });

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: async () => "",
    gitPushAuthorityProbe: async () => ({ ok: false, missing: "git push --dry-run" }),
    githubApiAuthorityProbe: async () => ({ ok: false, missing: "gh api" }),
  });

  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: [
        "git_push_authority_missing",
        "github_api_authority_missing",
      ],
      missing: [
        "gh api",
        "git push --dry-run",
      ],
    },
    failure_reasons: [
      "git_push_authority_missing",
      "github_api_authority_missing",
    ],
  });
});

test("execution profile preflight reports a broken clone as clone_unusable", async () => {
  const repoDir = path.join(os.tmpdir(), "teami-preflight-missing-dir");

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    runCommand: async () => "",
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });

  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["clone_unusable"],
      missing: ["repoDir"],
    },
    failure_reasons: ["clone_unusable"],
  });
});

test("readiness repair bypass skips setup and test readiness but keeps authority checks", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-preflight-repair-"));
  const commands = [];
  const probes = [];

  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    strictBaselineGreen: true,
    skipReadiness: true,
    runCommand: commandRecorder(commands, { failTest: true }),
    gitPushAuthorityProbe: async () => {
      probes.push("git-push");
      return { ok: true };
    },
    githubApiAuthorityProbe: async () => {
      probes.push("github-api");
      return { ok: false, missing: "gh api" };
    },
  });

  assert.deepEqual(commands, []);
  assert.deepEqual(probes, ["git-push", "github-api"]);
  assert.deepEqual(result, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["github_api_authority_missing"],
      missing: ["gh api"],
    },
    failure_reasons: ["github_api_authority_missing"],
  });

  const missingRepo = await runExecutionProfilePreflight({
    repoDir: path.join(os.tmpdir(), "teami-preflight-repair-missing"),
    resourceId: "repo-1",
    skipReadiness: true,
    runCommand: commandRecorder([]),
    gitPushAuthorityProbe: passProbe,
    githubApiAuthorityProbe: passProbe,
  });
  assert.deepEqual(missingRepo, {
    ok: false,
    resource_id: "repo-1",
    failure_signature_seed: {
      reason_codes: ["clone_unusable"],
      missing: ["repoDir"],
    },
    failure_reasons: ["clone_unusable"],
  });
});

test("default git push authority probe mirrors the mediated push: dry-run with in-memory Basic auth injection", async () => {
  const repoDir = fixtureRepo({ packageJson: {} });
  const gitCalls = [];
  const runGit = (args, opts = {}) => {
    gitCalls.push({ args, opts });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
  const priorGhToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "preflight-fixture-token";
  try {
    const result = await runExecutionProfilePreflight({
      repoDir,
      resourceId: "repo-1",
      skipReadiness: true,
      runCommand: commandRecorder([]),
      runGit,
      githubApiAuthorityProbe: passProbe,
      remoteUrl: "https://github.com/acme/product.git",
    });
    assert.equal(result.ok, true);
  } finally {
    if (priorGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorGhToken;
  }

  const push = gitCalls.find((call) => call.args[0] === "push");
  assert.ok(push, "default probe must run git push --dry-run");
  assert.deepEqual(push.args, [
    "push",
    "--dry-run",
    "https://github.com/acme/product.git",
    "HEAD:refs/heads/af-preflight-readiness",
  ]);
  assert.equal(push.opts.cwd, repoDir);
  assert.equal(push.opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(push.opts.env.GIT_CONFIG_COUNT, "1");
  assert.equal(push.opts.env.GIT_CONFIG_KEY_0, "http.extraHeader");
  const expectedBasic = Buffer.from("x-access-token:preflight-fixture-token", "utf8").toString("base64");
  assert.equal(push.opts.env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${expectedBasic}`);
});

test("git push probe timeout is surfaced as reconciliation-required", async () => {
  const repoDir = fixtureRepo({ packageJson: {} });
  const result = await runExecutionProfilePreflight({
    repoDir,
    resourceId: "repo-1",
    skipReadiness: true,
    runCommand: commandRecorder([]),
    runGit: async () => ({
      ok: false,
      outcome: "reconciliation_required",
      reconciliationRequired: true,
    }),
    githubApiAuthorityProbe: passProbe,
    remoteUrl: "https://github.com/acme/product.git",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure_reasons.includes("git_push_authority_missing"), true);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.reconciliation_required, true);
});

function fixtureRepo({ packageJson }) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-preflight-"));
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  return repoDir;
}

function commandRecorder(commands, { failTest = false } = {}) {
  return async (command) => {
    const label = [command.command, ...(command.args || [])].join(" ");
    commands.push(label);
    if (failTest && label === "npm test") {
      throw new Error("test failure must only matter in strict mode");
    }
    return "";
  };
}

async function passProbe() {
  return { ok: true };
}
