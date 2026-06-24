import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";
import {
  bindRepoResourceToDomain,
  deriveGitRepoBindingFromCheckout,
} from "../src/cli/domain-bind-repo-command.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

test("domain:bind-repo writes one git_repo resource from an ssh origin", async (t) => {
  const { repoRoot, checkoutPath } = setupDomainRegistry(t);
  const { runGit, calls } = fakeRunGit({
    remoteUrl: "git@github.com:acme/app.git",
    branch: "trunk",
  });

  const result = await bindRepoResourceToDomain({
    repoRoot,
    domainId: "main",
    checkoutPath,
    runGit,
  });

  const stored = readDomainRegistry({ repoRoot }).domains[0].resources[0];
  assert.deepEqual(stored, {
    id: "git_repo",
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: "acme",
      repo: "app",
      default_branch: "trunk",
      local_checkout_path: path.resolve(checkoutPath),
    },
  });
  assert.deepEqual(result.resource, stored);
  assert.deepEqual(commandCalls(calls), [
    { args: ["remote", "get-url", "origin"], cwd: path.resolve(checkoutPath) },
    { args: ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd: path.resolve(checkoutPath) },
  ]);
});

test("domain:bind-repo parses https origins to owner/repo", (t) => {
  const { checkoutPath } = setupDomainRegistry(t);
  const { runGit } = fakeRunGit({
    remoteUrl: "https://github.com/acme/app",
    branch: "main",
  });

  const binding = deriveGitRepoBindingFromCheckout({
    checkoutPath,
    runGit,
  });

  assert.equal(binding.owner, "acme");
  assert.equal(binding.repo, "app");
  assert.equal(binding.default_branch, "main");
  assert.equal(binding.local_checkout_path, path.resolve(checkoutPath));
});

test("domain:bind-repo rejects a second git_repo without changing the registry", async (t) => {
  const { repoRoot, checkoutPath } = setupDomainRegistry(t);
  const firstGit = fakeRunGit({ remoteUrl: "git@github.com:acme/app.git", branch: "main" });
  await bindRepoResourceToDomain({
    repoRoot,
    domainId: "main",
    checkoutPath,
    runGit: firstGit.runGit,
  });
  const before = readDomainRegistry({ repoRoot });

  const secondCheckoutPath = path.join(repoRoot, "second-product");
  fs.mkdirSync(secondCheckoutPath, { recursive: true });
  await assert.rejects(
    () =>
      bindRepoResourceToDomain({
        repoRoot,
        domainId: "main",
        checkoutPath: secondCheckoutPath,
        runGit: fakeRunGit({ remoteUrl: "https://github.com/acme/other", branch: "main" }).runGit,
      }),
    { message: "domain_bind_repo_existing_git_repo:git_repo" },
  );

  assert.deepEqual(readDomainRegistry({ repoRoot }), before);
});

test("domain:bind-repo fails cleanly when origin is missing", async (t) => {
  const { repoRoot, checkoutPath } = setupDomainRegistry(t);

  await assert.rejects(
    () =>
      bindRepoResourceToDomain({
        repoRoot,
        domainId: "main",
        checkoutPath,
        runGit: fakeRunGit({ remoteOk: false }).runGit,
      }),
    { message: "domain_bind_repo_origin_missing" },
  );

  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, []);
});

test("domain:bind-repo fails cleanly when default branch is ambiguous", async (t) => {
  const { repoRoot, checkoutPath } = setupDomainRegistry(t);

  await assert.rejects(
    () =>
      bindRepoResourceToDomain({
        repoRoot,
        domainId: "main",
        checkoutPath,
        runGit: fakeRunGit({
          remoteUrl: "https://github.com/acme/app.git",
          symbolicOk: false,
          revParseOutput: "origin/HEAD\n",
        }).runGit,
      }),
    { message: "domain_bind_repo_default_branch_ambiguous" },
  );

  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, []);
});

test("domain:bind-repo rejects a bad checkout path without writing", async (t) => {
  const { repoRoot } = setupDomainRegistry(t);
  const missingPath = path.join(repoRoot, "missing-product");

  await assert.rejects(
    () =>
      bindRepoResourceToDomain({
        repoRoot,
        domainId: "main",
        checkoutPath: missingPath,
        runGit: fakeRunGit().runGit,
      }),
    { message: `domain_bind_repo_path_not_directory:${path.resolve(missingPath)}` },
  );

  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, []);
});

test("domain:bind-repo rejects an unknown domain without writing", async (t) => {
  const { repoRoot, checkoutPath } = setupDomainRegistry(t);

  await assert.rejects(
    () =>
      bindRepoResourceToDomain({
        repoRoot,
        domainId: "missing",
        checkoutPath,
        runGit: fakeRunGit().runGit,
      }),
    { message: "domain_bind_repo_unknown_domain:missing" },
  );

  assert.deepEqual(readDomainRegistry({ repoRoot }).domains[0].resources, []);
});

function setupDomainRegistry(t, { domainId = "main" } = {}) {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-domain-bind-repo-"));
  const checkoutPath = path.join(repoRoot, "product");
  fs.mkdirSync(checkoutPath, { recursive: true });
  const registry = upsertDomainRecord(
    emptyDomainRegistry(),
    makeDomainRecord({ domainId }),
  );
  writeDomainRegistry({ repoRoot }, registry);
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  return { repoRoot, checkoutPath };
}

function fakeRunGit({
  remoteUrl = "git@github.com:acme/app.git",
  remoteOk = true,
  branch = "main",
  symbolicOk = true,
  symbolicOutput = null,
  revParseOk = true,
  revParseOutput = null,
} = {}) {
  const calls = [];
  const runGit = (args, { cwd } = {}) => {
    calls.push({ args: [...args], cwd });
    const command = args.join(" ");
    if (command === "remote get-url origin") {
      return remoteOk ? ok(`${remoteUrl}\n`) : fail("No such remote: origin");
    }
    if (command === "symbolic-ref refs/remotes/origin/HEAD") {
      return symbolicOk
        ? ok(symbolicOutput ?? `refs/remotes/origin/${branch}\n`)
        : fail("refs/remotes/origin/HEAD is not a symbolic ref");
    }
    if (command === "rev-parse --abbrev-ref origin/HEAD") {
      return revParseOk
        ? ok(revParseOutput ?? `origin/${branch}\n`)
        : fail("origin/HEAD is ambiguous");
    }
    return fail(`unexpected git command: ${command}`);
  };
  return { calls, runGit };
}

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "") {
  return { ok: false, status: 1, stdout: "", stderr };
}

function commandCalls(calls) {
  return calls.map((call) => ({
    args: call.args,
    cwd: call.cwd,
  }));
}
