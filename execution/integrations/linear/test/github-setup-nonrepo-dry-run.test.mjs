import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatCommand } from "../src/cli/operator-output.mjs";
import {
  createMockGitHubSetupTransport,
  githubConnectionDoctorChecks,
  listGitRemotes,
  readGitHubConnectionState,
  runGitHubInitPhase,
  TEAMI_WORKSPACE_REPO_MARKER_PATH,
  TEAMI_WORKSPACE_REPO_MARKER_SCHEMA_VERSION,
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

test("bounded Git preserves the non-repository classification without exposing failure output", async (t) => {
  const { root, cwd } = plainWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await listGitRemotes({ repoRoot: cwd });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "git_remote_listing_failed");
  assert.equal(result.failure_code, "not_repository");
  assert.match(result.detail, /^\[captured failure output redacted/);
});

test("an unrelated redacted Git failure never enters checkoutless setup", async (t) => {
  const { root, cwd, home, statePath } = plainWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transport = {
    ...createMockGitHubSetupTransport(),
    kind: "real",
  };

  const result = await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    transport,
    runGit: async () => ({
      ok: false,
      status: 1,
      stdout: "",
      stderr: "[captured failure output redacted]",
      failureCode: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "git_remote_listing_failed");
  assert.equal(transport.calls.length, 0);
});

function createCheckoutlessSeedRunGit({ cwd, calls, headSha = "seedabc123" }) {
  return (args, options = {}) => {
    calls.push({ args, cwd: options.cwd, env: options.env ?? null });
    if (options.cwd === cwd && args[0] === "remote" && args[1] === "-v") {
      return {
        ...fail("[captured failure output redacted]"),
        failureCode: "not_repository",
      };
    }
    if (args[0] === "init") return ok("Initialized empty Git repository\n");
    if (args[0] === "add" && args[1] === "README.md") {
      assert.equal(args[2], TEAMI_WORKSPACE_REPO_MARKER_PATH);
      const marker = JSON.parse(fs.readFileSync(path.join(options.cwd, ...TEAMI_WORKSPACE_REPO_MARKER_PATH.split("/")), "utf8"));
      assert.equal(marker.schema_version, TEAMI_WORKSPACE_REPO_MARKER_SCHEMA_VERSION);
      assert.ok(marker.repo_id);
      assert.ok(marker.full_name);
      return ok();
    }
    if (args[0] === "-c" && args.includes("commit")) return ok(`[main ${headSha}] Seed Teami behavior repo\n`);
    if (args[0] === "remote" && args[1] === "add" && args[2] === "origin") return ok();
    if (args[0] === "ls-files" && args[1] === "-z") return ok(`README.md\0${TEAMI_WORKSPACE_REPO_MARKER_PATH}\0`);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${headSha}\n`);
    if (args[0] === "push" && args[1] === "origin" && args[2] === "HEAD:main") return ok();
    if (args[0] === "clone" && args[1] === "--depth") return ok();
    if (args[0] === "push" && args[1] === "--dry-run") return ok();
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

test("real GitHub init fails closed if GitHub reports the workspace repository as public", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const transport = {
    ...createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      existingRepoDetails: {
        "fixture-owner/fixture-teami": {
          id: "repo-public-1",
          owner: "fixture-owner",
          name: "fixture-teami",
          full_name: "fixture-owner/fixture-teami",
          visibility: "public",
          private: false,
          default_branch: "main",
          empty: false,
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
    transport,
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: [] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "behavior_repo_not_private");
  assert.match(result.repair, /make .* private/);
});

test("real GitHub init from a non-repo re-run verifies write access to an existing non-empty repo", async () => {
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
  assert.equal(result.connection.local_auth.git_write, "verified");
  assert.equal(result.connection.push_verification.verified, true);
  assert.equal(result.connection.push_verification.mode, "dry_run");
  assert.equal(result.connection.push_verification.reason, "existing_non_empty_repo_write_access_verified");
  assert.deepEqual(transport.calls.map((call) => call.endpointId), ["get_repository"]);
  assert.equal(gitCalls.filter((call) => call.cwd !== cwd && call.args[0] === "init").length, 0);
  assert.equal(gitCalls.some((call) => call.args.join(" ") === "push --dry-run origin HEAD:refs/heads/teami/setup-write-check"), true);
});

test("checkout-less setup fails closed when write access to an existing repo cannot be verified", async () => {
  const { cwd, home, statePath } = plainWorkspace();
  const transport = {
    ...createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      existingRepoDetails: {
        "fixture-owner/fixture-teami": {
          id: "repo-read-only-1",
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
  const runGit = createCheckoutlessSeedRunGit({ cwd, calls: [] });
  const result = await runGitHubInitPhase({
    repoRoot: cwd,
    home,
    statePath,
    config: configWithBehaviorRepo(),
    transport,
    runGit: async (args, options) => args[0] === "push" && args[1] === "--dry-run"
      ? fail("permission denied: read-only repository")
      : runGit(args, options),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "behavior_repo_write_verification_failed");
  assert.match(result.detail, /permission denied/);
  assert.equal(result.connection.adoption_complete, false);
  assert.equal(result.connection.status, "failed");
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

  const doctorGitCalls = [];
  const checks = await githubConnectionDoctorChecks({
    repoRoot: cwd,
    home,
    statePath,
    runGit: createCheckoutlessSeedRunGit({ cwd, calls: doctorGitCalls }),
    transport: createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      repositoryId: "repo-created-1",
    }),
  });

  const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
  assert.equal(byName["GitHub connection"].ok, true);
  assert.equal(byName["GitHub connection mode"].ok, true);
  assert.equal(byName["GitHub remote shape"].ok, true);
  assert.match(byName["GitHub remote shape"].message, /no local checkout/);
  assert.equal(byName["GitHub behavior repo reachable"].ok, true);
  assert.equal(byName["GitHub local write auth"].ok, true);
  assert.ok(doctorGitCalls.some((call) => call.args[0] === "clone"));
  assert.ok(doctorGitCalls.some((call) => call.args[0] === "push" && call.args[1] === "--dry-run"));
  assert.equal(checks.every((check) => check.ok), true);
});

test("checkout-less doctor detects write authority revoked after setup", async () => {
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
  });
  const healthyGit = createCheckoutlessSeedRunGit({ cwd, calls: [] });
  const checks = await githubConnectionDoctorChecks({
    repoRoot: cwd,
    home,
    statePath,
    runGit: async (args, options) => args[0] === "push" && args[1] === "--dry-run"
      ? fail("permission denied: repository is now read-only")
      : healthyGit(args, options),
    transport: createMockGitHubSetupTransport({
      existingRepos: ["fixture-owner/fixture-teami"],
      repositoryId: "repo-created-1",
    }),
  });
  const write = checks.find((check) => check.name === "GitHub local write auth");
  assert.equal(write.ok, false);
  assert.match(write.message, /permission denied|write access/i);
});
