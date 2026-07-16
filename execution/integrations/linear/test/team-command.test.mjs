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
  grantTeamGitRepoResource,
  readTeamGrantSet,
  revokeTeamGitRepoResource,
  runTeamCommand,
} from "../src/cli/team-command.mjs";
import {
  emptyTeamRegistry,
  makeTeamRecord,
  readTeamRegistry,
  upsertTeamRecord,
  writeTeamRegistry,
} from "../src/team-registry.mjs";

test("team grant/show/revoke are non-interactive and idempotent", async (t) => {
  const { repoRoot } = setupTeamRegistry(t);
  const output = captureOutput();
  const { runCommand, calls } = fakeGhRunner({
    repos: {
      "Acme/app": ghRepo("Acme/app", "trunk"),
    },
  });
  withCleanExitCode(t);

  await runTeamCommand({
    context: { repoRoot, output, runCommand },
    command: "team:grant",
    args: ["main", "--repo", "Acme/app"],
  });
  await runTeamCommand({
    context: { repoRoot, output, runCommand },
    command: "team:grant",
    args: ["main", "--repo", "Acme/app"],
  });
  await runTeamCommand({
    context: { repoRoot, output, runCommand },
    command: "team:show",
    args: ["main"],
  });

  const resources = readTeamRegistry({ repoRoot }).teams[0].resources;
  assert.equal(process.exitCode, 0);
  assert.equal(resources.length, 1);
  assert.deepEqual(resources[0], {
    id: "git_repo:acme/app",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "Acme",
      repo: "app",
      default_branch: "trunk",
    },
  });
  assert.equal(Object.hasOwn(resources[0].binding, "local_checkout_path"), false);
  assert.equal(repoViewCalls(calls).length, 1, "second grant should not re-query GitHub");
  assert.match(output.text(), /Repo granted: Acme\/app/);
  assert.match(output.text(), /Repo already granted: Acme\/app/);
  assert.match(output.text(), /Resource[\s\S]*git_repo:acme\/app/);
  assert.match(output.text(), /Default branch[\s\S]*trunk/);

  await runTeamCommand({
    context: { repoRoot, output, runCommand },
    command: "team:revoke",
    args: ["main", "--repo", "Acme/app"],
  });
  await runTeamCommand({
    context: { repoRoot, output, runCommand },
    command: "team:revoke",
    args: ["main", "--repo", "Acme/app"],
  });

  assert.equal(process.exitCode, 0);
  assert.deepEqual(readTeamRegistry({ repoRoot }).teams[0].resources, []);
  assert.match(output.text(), /Repo revoked: Acme\/app/);
  assert.match(output.text(), /Repo was not granted: Acme\/app/);
});

test("team grant writes coordinates only and preserves other resources", async (t) => {
  const existingOther = gitRepoResource({
    owner: "Acme",
    repo: "api",
    default_branch: "main",
  });
  const { repoRoot } = setupTeamRegistry(t, { resources: [existingOther] });
  const { runCommand } = fakeGhRunner({
    repos: {
      "Acme/app": ghRepo("Acme/app", "trunk"),
    },
  });

  const result = await grantTeamGitRepoResource({
    repoRoot,
    teamRef: "main",
    repoSlug: "Acme/app",
    runCommand,
  });

  assert.equal(result.action, "added");
  assert.deepEqual(
    readTeamRegistry({ repoRoot }).teams[0].resources.map((resource) => resource.binding),
    [
      { owner: "Acme", repo: "api", default_branch: "main" },
      { owner: "Acme", repo: "app", default_branch: "trunk" },
    ],
  );
  for (const resource of readTeamRegistry({ repoRoot }).teams[0].resources) {
    assert.equal(resource.id, gitRepoResourceId(resource.binding));
    assert.equal(Object.hasOwn(resource.binding, "local_checkout_path"), false);
  }
});

test("team grant preserves a concurrent registry update made during GitHub lookup", async (t) => {
  const { repoRoot } = setupTeamRegistry(t);
  const concurrent = gitRepoResource({
    owner: "Acme",
    repo: "api",
    default_branch: "main",
  });
  const fake = fakeGhRunner({
    repos: {
      "Acme/app": ghRepo("Acme/app", "trunk"),
    },
  });
  let concurrentWriteMade = false;
  const runCommand = (command, args) => {
    if (!concurrentWriteMade && command === "gh" && args[0] === "repo" && args[1] === "view") {
      concurrentWriteMade = true;
      const current = readTeamRegistry({ repoRoot });
      const team = current.teams[0];
      writeTeamRegistry(
        { home: repoRoot },
        upsertTeamRecord(current, {
          ...team,
          resources: [...team.resources, concurrent],
        }),
      );
    }
    return fake.runCommand(command, args);
  };

  const result = await grantTeamGitRepoResource({
    repoRoot,
    teamRef: "main",
    repoSlug: "Acme/app",
    runCommand,
  });

  assert.equal(result.action, "added");
  assert.equal(concurrentWriteMade, true);
  assert.deepEqual(
    readTeamRegistry({ repoRoot }).teams[0].resources.map((resource) => resource.binding),
    [
      { owner: "Acme", repo: "api", default_branch: "main" },
      { owner: "Acme", repo: "app", default_branch: "trunk" },
    ],
  );
});

test("team grant canonicalizes a legacy local path resource without duplicating", async (t) => {
  const legacy = gitRepoResource({
    owner: "Acme",
    repo: "app",
    default_branch: "main",
    local_checkout_path: "placeholder-legacy-checkout",
  });
  const { repoRoot } = setupTeamRegistry(t, { resources: [legacy] });

  const result = await grantTeamGitRepoResource({
    repoRoot,
    teamRef: "main",
    repoSlug: "Acme/app",
    runCommand: () => {
      throw new Error("existing grants should not need gh");
    },
  });

  const resources = readTeamRegistry({ repoRoot }).teams[0].resources;
  assert.equal(result.action, "canonicalized");
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

test("team revoke absent is a clean no-op", (t) => {
  const existing = gitRepoResource({
    owner: "Acme",
    repo: "api",
    default_branch: "main",
  });
  const { repoRoot } = setupTeamRegistry(t, { resources: [existing] });

  const result = revokeTeamGitRepoResource({
    repoRoot,
    teamRef: "main",
    repoSlug: "Acme/app",
  });

  assert.equal(result.action, "unchanged");
  assert.equal(result.changed, false);
  assert.deepEqual(readTeamRegistry({ repoRoot }).teams[0].resources, [existing]);
});

test("team show reads the grant set without writing", (t) => {
  const existing = gitRepoResource({
    owner: "Acme",
    repo: "app",
    default_branch: "main",
  });
  const { repoRoot } = setupTeamRegistry(t, { resources: [existing] });
  const before = readTeamRegistry({ repoRoot });

  const result = readTeamGrantSet({ repoRoot, teamRef: "main" });

  assert.deepEqual(result.resources, [existing]);
  assert.deepEqual(readTeamRegistry({ repoRoot }), before);
});

test("removed Teams reject resource grants and revocations before mutation", async (t) => {
  const { repoRoot } = setupTeamRegistry(t, { status: "removed" });
  let githubCalls = 0;

  await assert.rejects(
    () => grantTeamGitRepoResource({
      repoRoot,
      teamRef: "main",
      repoSlug: "Acme/app",
      runCommand: () => {
        githubCalls += 1;
        return ok(JSON.stringify(ghRepo("Acme/app", "main")));
      },
    }),
    /team_removed:main/,
  );
  assert.throws(
    () => revokeTeamGitRepoResource({ repoRoot, teamRef: "main", repoSlug: "Acme/app" }),
    /team_removed:main/,
  );
  assert.equal(githubCalls, 0);
  assert.equal(readTeamRegistry({ repoRoot }).teams[0].status, "removed");
});

function setupTeamRegistry(t, { teamRef = "main", resources = [], status = "active" } = {}) {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-team-command-"));
  // Engine state (team registry) now lives under the per-user home; isolate to this temp dir.
  process.env.TEAMI_HOME = repoRoot;
  const registry = upsertTeamRecord(
    emptyTeamRegistry(),
    makeTeamRecord({
      teamRef,
      status,
      workspaceId: "workspace-1",
      workspaceName: "Example Workspace",
      teamId: "team-1",
      teamKey: "AF",
      teamName: "Teami",
      resources,
    }),
  );
  writeTeamRegistry({ repoRoot }, registry);
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  return { repoRoot };
}

function fakeGhRunner({ repos = {}, authOk = true, authError = "not logged in" } = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "gh") return fail(`unexpected command: ${command}`);
    if (args.join(" ") === "auth status --hostname github.com") {
      return authOk ? ok() : fail(authError);
    }
    if (args[0] === "repo" && args[1] === "view") {
      const repo = repos[args[2]];
      return repo ? ok(JSON.stringify(repo)) : fail("HTTP 404: Not Found");
    }
    return fail(`unexpected gh command: ${args.join(" ")}`);
  };
  return { runCommand, calls };
}

function repoViewCalls(calls) {
  return calls.filter((call) => call.command === "gh" && call.args[0] === "repo" && call.args[1] === "view");
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

function captureOutput() {
  const lines = [];
  const push = (kind, text) => {
    lines.push(`${kind}: ${String(text)}`);
  };
  return {
    verbose: false,
    symbols: {
      separator: "-",
    },
    style: {
      dim: (value) => String(value),
    },
    heading: (text) => push("heading", text),
    info: (text) => push("info", text),
    success: (text) => push("success", text),
    error: ({ what, why = null, fix = null } = {}) => push("error", [what, why, fix].filter(Boolean).join(" ")),
    keyValues: (pairs, { heading = null } = {}) => {
      if (heading) push("section", heading);
      for (const [label, value] of pairs) push("kv", `${label}: ${value}`);
    },
    raw: (text) => push("raw", text),
    text: () => lines.join("\n"),
  };
}

function withCleanExitCode(t) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = previous;
  });
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "") {
  return { ok: false, status: 1, stdout: "", stderr };
}
