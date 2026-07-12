import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  BEHAVIOR_CONFIG_COMMIT_FIELD,
  BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH,
  DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH,
  LINEAR_OAUTH_CALLBACK,
  loadLinearConfig,
  loadLinearConfigAsync,
  mergeLinearConfigDefaults,
  validateBehaviorOverrides,
  validateLinearConfig,
} from "../src/config.mjs";
import { syncBehaviorConfigOverrides } from "../src/behavior-config-pull.mjs";
import { runDecomposition } from "../src/workflows/decomposition/run-service.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const configExamplePath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);

test("sync cold config uses packaged defaults when the optional behavior cache is absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-behavior-cache-cold-"));
  try {
    const config = loadLinearConfig({ repoRoot, home });
    assert.equal(config.linear.oauth.actor, "app");
    assert.throws(
      () => loadLinearConfig({ repoRoot, home, behaviorConfig: { required: true } }),
      /behavior_config_pull_failed:behavior_config_cache_missing/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
const packagedDefaultPath = path.join(repoRoot, ...DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH.split("/"));
const allowlistPath = path.join(repoRoot, "private", "publication", "public-identity-allowlist.txt");

test("behavior override merge leaves override cargo separate across engine default bumps", () => {
  const overrides = {
    workflows: {
      review: {
        roles: {
          reviewer: { runtime: "claude", model: "override-reviewer-model" },
        },
      },
    },
  };
  const originalOverrides = structuredClone(overrides);
  validateBehaviorOverrides(overrides, "fixture-overrides.json");

  const defaultsV1 = engineDefaultFixture("engine-1");
  const defaultsV2 = engineDefaultFixture("engine-2");
  const mergedV1 = mergeLinearConfigDefaults(defaultsV1, overrides);
  const mergedV2 = mergeLinearConfigDefaults(defaultsV2, overrides);

  assert.deepEqual(overrides, originalOverrides);
  assert.equal(Object.hasOwn(overrides, "runtime"), false);
  assert.equal(mergedV1.runtime.adapters.codex.version, "engine-1");
  assert.equal(mergedV2.runtime.adapters.codex.version, "engine-2");
  assert.equal(mergedV2.workflows.review.roles.reviewer.runtime, "claude");
  assert.equal(mergedV2.workflows.review.roles.reviewer.model, "override-reviewer-model");
  assert.deepEqual(
    mergeLinearConfigDefaults({ runtime: { adapters: { codex: { cli_args_prefix: ["old", "args"] } } } }, {
      runtime: { adapters: { codex: { cli_args_prefix: ["new"] } } },
    }).runtime.adapters.codex.cli_args_prefix,
    ["new"],
  );
  assert.throws(
    () => validateBehaviorOverrides({ runtime: { adapters: {} } }, "bad-overrides.json"),
    /behavior_config_overrides_invalid: bad-overrides\.json\.runtime/,
  );
});

test("behavior repo role override is pulled, merged, cache-overwritten, and traced by commit sha", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-behavior-config-"));
  const home = path.join(root, "home");
  const behaviorRepo = path.join(root, "behavior-repo");
  fs.mkdirSync(behaviorRepo, { recursive: true });

  const overrides = {
    workflows: {
      review: {
        roles: {
          reviewer: { runtime: "claude", model: "override-reviewer-model" },
        },
      },
    },
  };
  writeBehaviorOverrides(behaviorRepo, overrides);
  const fixture = initBehaviorRepoFixture(behaviorRepo, overrides);
  const commit = fixture.commit;
  const remoteUrl = pathToFileURL(behaviorRepo).href;

  const config = await loadLinearConfigAsync({
    repoRoot,
    home,
    configPath: configExamplePath,
    behaviorConfig: { remoteUrl, ref: "main", required: true, ...(fixture.runGit ? { runGit: fixture.runGit } : {}) },
    behaviorConfigPuller: syncBehaviorConfigOverrides,
  });
  assert.equal(config.workflows.review.roles.reviewer.runtime, "claude");
  assert.equal(config.workflows.review.roles.reviewer.model, "override-reviewer-model");
  assert.equal(config[BEHAVIOR_CONFIG_COMMIT_FIELD], commit);

  const cacheOverridePath = path.join(home, "behavior-mirror", ...BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH.split("/"));
  writeJson(cacheOverridePath, {
    workflows: {
      review: {
        roles: {
          reviewer: { runtime: "codex", model: "cache-edit-should-lose" },
        },
      },
    },
  });

  const nextConfig = await loadLinearConfigAsync({
    repoRoot,
    home,
    configPath: configExamplePath,
    behaviorConfig: { remoteUrl, ref: "main", required: true, ...(fixture.runGit ? { runGit: fixture.runGit } : {}) },
    behaviorConfigPuller: syncBehaviorConfigOverrides,
  });
  assert.equal(nextConfig.workflows.review.roles.reviewer.runtime, "claude");
  assert.equal(nextConfig.workflows.review.roles.reviewer.model, "override-reviewer-model");
  assert.equal(nextConfig[BEHAVIOR_CONFIG_COMMIT_FIELD], commit);

  const result = await runDecomposition({
    client: createIneligibleClient(nextConfig),
    config: nextConfig,
    cache: null,
    projectId: "project-1",
    repoRoot,
    home,
  });
  assert.equal(result.status, "ineligible");
  assert.equal(result.trace.attributes.behavior_config_commit, commit);
});

test("packaged defaults stay identity-clean and the allowlist covers only that filename", () => {
  const packaged = readJson(packagedDefaultPath);
  // Ships the Teami Linear app's public OAuth client_id (required for a fresh adopter to sign in via
  // init_onboarding; a client_id is a public identifier, not a secret). Personal/repo identity stays out.
  assert.equal(packaged.linear.oauth.client_id, "00117f8c7dba0a3adf8d2a7398f5f64f");
  assert.equal(Object.hasOwn(packaged, "github"), false);

  if (fs.existsSync(allowlistPath)) {
    const allowlist = fs.readFileSync(allowlistPath, "utf8");
    const row = allowlist
      .split(/\r?\n/)
      .find((line) => line.startsWith("PUB-LINEAR-CONFIGDEFAULT\t"));
    assert.ok(row, "packaged defaults allowlist row should exist");
    const [, pattern, allowed] = row.split("\t");
    assert.equal(pattern, "^execution/integrations/linear/config\\.package-default\\.json$");
    assert.ok(!/[0-9a-f]{32}/i.test(allowed), "allowlist must not permit client-id-shaped tokens");
  } else {
    assert.equal(
      fs.existsSync(path.join(repoRoot, "private")),
      false,
      "the public artifact must omit the complete private publication surface",
    );
  }

  const config = readJson(configExamplePath);
  config.linear.oauth.redirect_uri =
    `http://${LINEAR_OAUTH_CALLBACK.host}:${LINEAR_OAUTH_CALLBACK.portRange.start}${LINEAR_OAUTH_CALLBACK.pathname}`;
  assert.equal(validateLinearConfig(config, "loopback-port-fixture", { repoRoot }), true);
});

function engineDefaultFixture(version) {
  return {
    runtime: {
      adapters: {
        codex: {
          command: "codex",
          version,
          cli_args_prefix: ["-c", `engine_version=${version}`],
        },
      },
    },
    workflows: {
      review: {
        roles: {
          reviewer: { runtime: "codex", model: "gpt-5.5" },
        },
      },
    },
  };
}

function writeBehaviorOverrides(repoDir, overrides) {
  writeJson(path.join(repoDir, ...BEHAVIOR_CONFIG_OVERRIDES_RELATIVE_PATH.split("/")), overrides);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function initBehaviorRepoFixture(repoDir, overrides) {
  if (!canSpawnGit()) {
    const commit = crypto
      .createHash("sha1")
      .update(JSON.stringify(overrides))
      .digest("hex");
    return {
      commit,
      runGit: createFileRemoteRunGit({ sourceDir: repoDir, commit }),
    };
  }
  initAndCommitBehaviorRepo(repoDir);
  return {
    commit: git(["rev-parse", "HEAD"], repoDir).stdout.trim(),
    runGit: null,
  };
}

function initAndCommitBehaviorRepo(repoDir) {
  const init = spawnSync("git", ["init", "--initial-branch=main"], {
    cwd: repoDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) {
    git(["init"], repoDir);
    git(["checkout", "-B", "main"], repoDir);
  }
  git(["config", "user.email", "teami-test@example.invalid"], repoDir);
  git(["config", "user.name", "Teami Test"], repoDir);
  git(["add", "."], repoDir);
  git(["commit", "-m", "Add behavior config override"], repoDir);
}

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nerror:\n${result.error?.message || ""}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`,
  );
  return result;
}

function canSpawnGit() {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function createFileRemoteRunGit({ sourceDir, commit }) {
  return (args) => {
    if (args[0] === "clone") {
      const destination = args.at(-1);
      fs.cpSync(sourceDir, destination, { recursive: true });
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { ok: true, status: 0, stdout: `${commit}\n`, stderr: "" };
    }
    return {
      ok: false,
      status: 1,
      stdout: "",
      stderr: `unsupported fake git command: ${args.join(" ")}`,
    };
  };
}

function createIneligibleClient(config) {
  const team = { id: "team-1", key: config.linear.team.key, name: config.linear.team.name };
  const projectStatuses = Object.entries(config.linear.project.statuses).map(([role, status]) => ({
    id: `${role}-project-status`,
    name: status.name,
    type: status.type,
  }));
  const issueStates = Object.entries(config.linear.issue.statuses).map(([role, status]) => ({
    id: `${role}-issue-status`,
    name: status.name,
    type: status.type,
  }));
  return {
    async listTeams() {
      return [team];
    },
    async listProjectStatuses() {
      return projectStatuses;
    },
    async listWorkflowStates() {
      return issueStates;
    },
    async findIssueLabelsByName(name) {
      if (!name) return [];
      return [{ id: `label-${name}`, name }];
    },
    async getProjectContext(projectId) {
      return {
        id: projectId,
        teamId: team.id,
        status: { id: "completed-project-status", type: "completed", name: "Completed" },
        issues: [],
      };
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
