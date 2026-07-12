import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatCommand } from "../src/cli/operator-output.mjs";
import {
  createMockGitHubSetupTransport,
  githubConnectionDoctorChecks,
  readGitHubConnectionState,
  runGitHubInitPhase,
} from "../src/github-setup.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teami-github-nonrepo-"));
}

function plainWorkspace() {
  const root = tempRoot();
  const cwd = path.join(root, "plain-folder");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  return { root, cwd, home, statePath: path.join(home, "github-connection.json") };
}

function configWithBehaviorRepo() {
  return {
    github: {
      behavior_repo: { owner: "fixture-owner", name: "fixture-teami", visibility: "private" },
      starter_remote_urls: [],
    },
  };
}

function nonRepoRunGit() {
  return {
    ok: false,
    status: 128,
    stdout: "",
    stderr: "fatal: not a git repository",
  };
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr) {
  return { ok: false, status: 1, stdout: "", stderr };
}

function createCheckoutlessSeedRunGit({ cwd, calls, headSha = "seedabc123" }) {
  return (args, options = {}) => {
    calls.push({ args, cwd: options.cwd, env: options.env ?? null });
    if (options.cwd === cwd && args[0] === "remote" && args[1] === "-v") {
      return fail("fatal: not a git repository");
    }
    if (args[0] === "init") return ok("Initialized empty Git repository\n");
    if (args[0] === "add" && args[1] === "README.md") return ok();
    if (args[0] === "-c" && args.includes("commit")) return ok(`[main ${headSha}] Seed Teami behavior repo\n`);
    if (args[0] === "remote" && args[1] === "add" && args[2] === "origin") return ok();
    if (args[0] === "ls-files" && args[1] === "-z") return ok("README.md\0");
    if (args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${headSha}\n`);
    if (args[0] === "push" && args[1] === "origin" && args[2] === "HEAD:main") return ok();
    if (args[0] === "ls-remote" && args[1] === "--exit-code") return ok(`${headSha}\trefs/heads/main\n`);
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
}

test("dry-run GitHub init from a non-repo records intent and returns non-fatal", async () => {
  const root = tempRoot();
  const statePath = path.join(root, "home", "github-connection.json");
  const progress = [];

  const result = await runGitHubInitPhase({
    repoRoot: root,
    home: path.join(root, "home"),
    statePath,
    config: configWithBehaviorRepo(),
    runGit: nonRepoRunGit,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
    onProgress: (line) => progress.push(line),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.connection.connection_mode, "dry_run");
  assert.equal(result.connection.adoption_complete, false);
  assert.equal(result.connection.local_auth.git_write, "not_checked");
  assert.equal(result.connection.remotes.origin.applied, false);
  assert.equal(result.connection.repo.full_name, "fixture-owner/fixture-teami");
  assert.ok(result.repair.includes(formatCommand("github:init")));
  assert.doesNotMatch(result.repair, /npm run/);
  assert.match(progress.join("\n"), /recorded dry-run intent only/);

  const saved = readGitHubConnectionState({ statePath });
  assert.equal(saved.ok, true);
  assert.equal(saved.connection.connection_mode, "dry_run");
  assert.equal(saved.connection.adoption_complete, false);
});

test("real GitHub init from a non-repo creates and seeds the behavior repo from a temp clone", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const progress = [];
  const gitCalls = [];
  const transport = {
    ...createMockGitHubSetupTransport({ repositoryId: "repo-created-1" }),
    kind: "real",
  };
  const beforeCwdEntries = fs.readdirSync(cwd);

  const result = await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: gitCalls }),
    transport,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
    onProgress: (line) => progress.push(line),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.checkoutless, true);
  assert.equal(result.connection.connection_mode, "real");
  assert.equal(result.connection.adoption_complete, true);
  assert.equal(result.connection.local_checkout.mode, "none");
  assert.equal(result.connection.remotes.origin.applied, false);
  assert.equal(result.connection.remotes.origin.local_checkout, "none");
  assert.equal(result.connection.local_auth.git_write, "verified");
  assert.equal(result.connection.local_auth.real_push_enabled, true);
  assert.equal(result.connection.push_verification.pushed, true);
  assert.equal(result.connection.push_verification.branch, "main");
  assert.equal(result.connection.repo.full_name, "fixture-owner/fixture-teami");

  assert.deepEqual(transport.calls.map((call) => call.endpointId), ["get_repository", "create_repository"]);
  const tempCwds = new Set(gitCalls.map((call) => call.cwd).filter((callCwd) => callCwd && callCwd !== cwd));
  assert.equal(tempCwds.size, 1);
  const seedDir = [...tempCwds][0];
  assert.match(seedDir, /teami-behavior-seed-/);
  assert.equal(fs.existsSync(seedDir), false, "temporary seed clone must be cleaned up");
  assert.ok(gitCalls.some((call) => call.cwd === seedDir && call.args[0] === "init"));
  assert.ok(gitCalls.some((call) => call.cwd === seedDir && call.args.includes("commit")));
  const pushCall = gitCalls.find((call) => call.cwd === seedDir && call.args.join(" ") === "push origin HEAD:main");
  assert.ok(pushCall, `missing temp-clone push call: ${JSON.stringify(gitCalls)}`);
  assert.equal(pushCall.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(pushCall.env.GH_PROMPT_DISABLED, "1");
  assert.deepEqual(fs.readdirSync(cwd), beforeCwdEntries, "init must not write seed files to the plain cwd");
  assert.match(progress.join("\n"), /temporary local clone/);

  const saved = readGitHubConnectionState({ statePath });
  assert.equal(saved.ok, true);
  assert.equal(saved.connection.local_checkout.mode, "none");
});

test("real GitHub init from a non-repo seeds an existing empty behavior repo", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const gitCalls = [];
  const transport = {
    ...createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      existingRepoDetails: {
        "fixture-owner/fixture-teami": {
          id: "repo-empty-1",
          owner: "fixture-owner",
          name: "fixture-teami",
          full_name: "fixture-owner/fixture-teami",
          visibility: "private",
          default_branch: "main",
          empty: true,
          html_url: "https://github.com/fixture-owner/fixture-teami",
        },
      },
    }),
    kind: "real",
  };

  const result = await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: gitCalls }),
    transport,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.connection.repo.id, "repo-empty-1");
  assert.equal(result.connection.push_verification.pushed, true);
  assert.equal(result.connection.local_auth.git_write, "verified");
  assert.deepEqual(transport.calls.map((call) => call.endpointId), ["get_repository"]);
  assert.ok(gitCalls.some((call) => call.args.join(" ") === "push origin HEAD:main"));
});
test("real GitHub init from a non-repo re-run connects an existing non-empty repo without seeding", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const gitCalls = [];
  const transport = {
    ...createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      existingRepoDetails: {
        "fixture-owner/fixture-teami": {
          id: "repo-existing-1",
          owner: "fixture-owner",
          name: "fixture-teami",
          full_name: "fixture-owner/fixture-teami",
          visibility: "private",
          default_branch: "main",
          empty: false,
          html_url: "https://github.com/fixture-owner/fixture-teami",
        },
      },
    }),
    kind: "real",
  };

  const result = await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: gitCalls }),
    transport,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.connection.adoption_complete, true);
  assert.equal(result.connection.repo.id, "repo-existing-1");
  assert.equal(result.connection.default_branch, "main");
  assert.equal(result.connection.local_checkout.mode, "none");
  assert.equal(result.connection.local_auth.git_write, "not_required_existing_non_empty_repo");
  assert.equal(result.connection.push_verification.reason, "existing_non_empty_repo_no_initial_push_required");
  assert.deepEqual(transport.calls.map((call) => call.endpointId), ["get_repository"]);
  assert.equal(gitCalls.filter((call) => call.cwd !== cwd && call.args[0] === "init").length, 0);
  assert.equal(gitCalls.some((call) => call.args[0] === "push"), false);
});

test("doctor treats checkout-less real GitHub connection state as connected", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const setupTransport = {
    ...createMockGitHubSetupTransport({ repositoryId: "repo-created-1" }),
    kind: "real",
  };
  await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: [] }),
    transport: setupTransport,
    now: () => new Date("2026-06-10T05:00:00.000Z"),
  });

  const checks = await githubConnectionDoctorChecks({
    repoRoot: cwd,
    home,
    statePath,
    runGit() {
      throw new Error("doctor should not inspect local git for checkout-less connection state");
    },
    transport: createMockGitHubSetupTransport({ existingRepos: ["fixture-owner/fixture-teami"] }),
  });

  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub connection"].ok, true);
  assert.equal(byName["GitHub connection mode"].ok, true);
  assert.equal(byName["GitHub remote shape"].ok, true);
  assert.match(byName["GitHub remote shape"].message, /no local checkout/);
  assert.equal(byName["GitHub behavior repo reachable"].ok, true);
  assert.equal(byName["GitHub local write auth"].ok, true);
  assert.equal(checks.every((check) => check.ok), true);
});