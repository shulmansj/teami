import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  gitRepoResourceId,
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";
import {
  runSetupGitHubRepoDiscoveryStep,
} from "../src/cli/linear-setup-command.mjs";

test("explicit repo grant helper persists confirmed coordinates-only resources", async (t) => {
      const { repoRoot } = setupDomainRegistry(t);
      const output = captureOutput();
      const prompts = [];
      const { runCommand, calls } = fakeGhRunner({
        repos: [
          ghRepo("Acme/app", "main"),
          ghRepo("Acme/api", "trunk"),
        ],
        packageJsonByRepo: {
          "Acme/app": { scripts: { test: "node --test" } },
          "Acme/api": { scripts: { setup: "node scripts/setup.mjs", test: "vitest" } },
        },
      });

      const result = await runSetupGitHubRepoDiscoveryStep({
        repoRoot,
        domainId: "main",
        command: "domain:grant",
        output,
        runCommand,
        prompt: promptAnswers(["1,2"], prompts),
        isTTY: true,
      });

      const resources = readDomainRegistry({ repoRoot }).domains[0].resources;
      assert.equal(result.persisted, true);
      assert.deepEqual(
        resources.map((resource) => resource.binding),
        [
          { owner: "Acme", repo: "app", default_branch: "main" },
          { owner: "Acme", repo: "api", default_branch: "trunk" },
        ],
      );
      for (const resource of resources) {
        assert.equal(resource.id, gitRepoResourceId(resource.binding));
        assert.equal(resource.kind, "git_repo");
        assert.equal(resource.role, "primary");
        assert.equal(Object.hasOwn(resource.binding, "local_checkout_path"), false);
      }
      assert.deepEqual(repoListCall(calls).args, [
        "repo",
        "list",
        "--limit",
        "50",
        "--json",
        "nameWithOwner,defaultBranchRef",
      ]);
      assert.equal(prompts.some((message) => /provider|model/i.test(message)), false);
      assert.match(output.text(), /Build\/test auto-detected for Acme\/app: npm install -> npm test/);
      assert.match(output.text(), /Build\/test auto-detected for Acme\/api: npm run setup -> npm test/);
});

test("NONE selection is a first-class non-code team outcome and clears repo resources", async (t) => {
  const existing = gitRepoResource({
    owner: "Acme",
    repo: "old",
    default_branch: "main",
    local_checkout_path: "placeholder-legacy-checkout",
  });
  const { repoRoot } = setupDomainRegistry(t, { resources: [existing] });
  const output = captureOutput();
  const prompts = [];
  const { runCommand } = fakeGhRunner({
    repos: [ghRepo("Acme/app", "main")],
  });

  const result = await runSetupGitHubRepoDiscoveryStep({
    repoRoot,
    domainId: "main",
    output,
    runCommand,
    prompt: promptAnswers(["n"], prompts),
    isTTY: true,
  });

  assert.equal(result.persisted, true);
  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, []);
  assert.equal(prompts.some((message) => /provider|model/i.test(message)), false);
  assert.match(output.text(), /non-code team/);
});

test("idempotent re-run does not duplicate confirmed repo resources", async (t) => {
  const { repoRoot } = setupDomainRegistry(t);
  const firstOutput = captureOutput();
  const secondOutput = captureOutput();
  const firstGh = fakeGhRunner({
    repos: [ghRepo("Acme/app", "main")],
    packageJsonByRepo: {
      "Acme/app": { scripts: { test: "node --test" } },
    },
  });
  const secondGh = fakeGhRunner({
    repos: [ghRepo("Acme/app", "main")],
    packageJsonByRepo: {
      "Acme/app": { scripts: { test: "node --test" } },
    },
  });

  await runSetupGitHubRepoDiscoveryStep({
    repoRoot,
    domainId: "main",
    output: firstOutput,
    runCommand: firstGh.runCommand,
    prompt: promptAnswers([""]),
    isTTY: true,
  });
  await runSetupGitHubRepoDiscoveryStep({
    repoRoot,
    domainId: "main",
    output: secondOutput,
    runCommand: secondGh.runCommand,
    prompt: promptAnswers([""]),
    isTTY: true,
  });

  const resources = readDomainRegistry({ repoRoot }).domains[0].resources;
  assert.equal(resources.length, 1);
  assert.deepEqual(resources[0], {
    id: "git_repo:acme/app",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "Acme",
      repo: "app",
      default_branch: "main",
    },
  });
});

test("gh unavailable path is actionable and does not wipe an existing allowlist", async (t) => {
  const existing = gitRepoResource({
    owner: "Acme",
    repo: "app",
    default_branch: "main",
  });
  const { repoRoot } = setupDomainRegistry(t, { resources: [existing] });
  const output = captureOutput();
  const { runCommand } = fakeGhRunner({
    authOk: false,
    authError: "gh auth status failed; run gh auth login",
  });

  const result = await runSetupGitHubRepoDiscoveryStep({
    repoRoot,
    domainId: "main",
    output,
    runCommand,
    prompt: promptAnswers([""]),
    isTTY: true,
  });

  assert.equal(result.persisted, false);
  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, [existing]);
  assert.match(output.text(), /GitHub repo discovery skipped/);
  assert.match(output.text(), /gh auth login --hostname github\.com/);
});

function setupDomainRegistry(t, { resources = [] } = {}) {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-setup-repos-"));
  // Engine state (domain registry) now lives under the per-user home; isolate it here.
  process.env.TEAMI_HOME = repoRoot;
  const registry = upsertDomainRecord(
    emptyDomainRegistry(),
    makeDomainRecord({
      domainId: "main",
      status: "active",
      workspaceId: "workspace-1",
      workspaceName: "Example Workspace",
      teamId: "team-1",
      teamKey: "AF",
      teamName: "Teami",
      resources,
    }),
  );
  writeDomainRegistry({ repoRoot }, registry);
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  return { repoRoot };
}

function fakeGhRunner({
  repos = [],
  packageJsonByRepo = {},
  authOk = true,
  authError = "not logged in",
} = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "gh") return fail(`unexpected command: ${command}`);
    if (args.join(" ") === "auth status --hostname github.com") {
      return authOk ? ok() : fail(authError);
    }
    if (args.join(" ") === "repo list --limit 50 --json nameWithOwner,defaultBranchRef") {
      return ok(JSON.stringify(repos));
    }
    if (args[0] === "api") {
      const match = String(args[1] || "").match(/^repos\/([^/]+)\/([^/]+)\/contents\/package\.json\?/);
      if (!match) return fail(`unexpected gh api endpoint: ${args[1]}`);
      const key = `${match[1]}/${match[2]}`;
      if (!Object.hasOwn(packageJsonByRepo, key)) return fail("HTTP 404: Not Found");
      return ok(JSON.stringify({
        encoding: "base64",
        content: Buffer.from(JSON.stringify(packageJsonByRepo[key]), "utf8").toString("base64"),
      }));
    }
    return fail(`unexpected gh command: ${args.join(" ")}`);
  };
  return { runCommand, calls };
}

function repoListCall(calls) {
  return calls.find((call) => call.command === "gh" && call.args[0] === "repo" && call.args[1] === "list");
}

function ghRepo(nameWithOwner, defaultBranch) {
  return {
    nameWithOwner,
    defaultBranchRef: { name: defaultBranch },
  };
}

function gitRepoResource(binding) {
  const normalized = {
    owner: binding.owner,
    repo: binding.repo,
    default_branch: binding.default_branch,
    ...(binding.local_checkout_path ? { local_checkout_path: binding.local_checkout_path } : {}),
  };
  return {
    id: gitRepoResourceId(normalized),
    kind: "git_repo",
    role: "primary",
    binding: normalized,
  };
}

function promptAnswers(answers, prompts = []) {
  const remaining = [...answers];
  return async (message) => {
    prompts.push(message);
    return remaining.length > 0 ? remaining.shift() : "";
  };
}

function captureOutput() {
  const lines = [];
  const push = (kind, text) => {
    lines.push(`${kind}: ${String(text)}`);
  };
  return {
    symbols: {
      separator: "-",
      ellipsis: "...",
    },
    style: {
      dim: (value) => String(value),
    },
    section: (text) => push("section", text),
    info: (text) => push("info", text),
    warn: (text) => push("warn", text),
    success: (text) => push("success", text),
    detail: (text) => push("detail", text),
    text: () => lines.join("\n"),
  };
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "") {
  return { ok: false, status: 1, stdout: "", stderr };
}
