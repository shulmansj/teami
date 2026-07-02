import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeRunContext,
} from "../../../engine/materialize.mjs";
import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  registerGitRepoResourceKind,
} from "../../git/git-repo-materializer.mjs";
import {
  makeDomainRecord,
} from "../src/domain-registry.mjs";
import {
  buildDomainContext,
} from "../src/domain-resolver.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("materializeRunContext materializes resources preserved by buildDomainContext", async (t) => {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const tempSource = fs.mkdtempSync(path.join(os.tmpdir(), "teami-live-materialize-"));
  let workingDir = null;
  let teardownAll = async () => {};

  t.after(() => {
    fs.rmSync(tempSource, { recursive: true, force: true });
    if (workingDir) fs.rmSync(workingDir, { recursive: true, force: true });
    resetResourceRegistry();
  });

  const resource = gitRepoResource();
  const domain = domainRecord({ resources: [resource] });
  const domainContext = buildDomainContext({ domain, config: null, repoRoot: REPO_ROOT });
  const remoteUrl = "https://github.com/acme/app.git";
  const { runGit, calls } = fakeRunGit({ source: tempSource, remoteUrl });

  assert.deepEqual(domainContext.resources, [resource]);
  assert.notEqual(domainContext.resources, domain.resources);
  assert.equal(Object.isFrozen(domainContext.resources), true);

  try {
    const materialized = await materializeRunContext({
      domainContext,
      runId: "execution-run-1",
      engineRepoRoot: REPO_ROOT,
      runGit,
      gitRemoteUrlOverride: remoteUrl,
    });
    teardownAll = materialized.teardownAll;

    assert.equal(materialized.materialized, true);
    assert.equal(typeof materialized.teardownAll, "function");
    const { runContext } = materialized;
    assert.equal(runContext.runId, "execution-run-1");
    assert.equal(runContext.engineRepoRoot, REPO_ROOT);
    assert.equal(runContext.runGit, runGit);
    assert.deepEqual(Object.keys(runContext.resources), [resource.id]);
    assert.equal(runContext.selectedResourceId, resource.id);
    assert.equal(runContext.selectedResource, runContext.resources[resource.id]);

    const bound = runContext.selectedResource;
    assert.equal(bound.id, resource.id);
    assert.equal(bound.kind, "git_repo");
    assert.equal(bound.role, "primary");
    assert.deepEqual(Object.keys(bound.handle).sort(), [
      "baseSha",
      "default_branch",
      "envAugment",
      "owner",
      "remoteUrl",
      "repo",
      "workingDir",
    ]);
    assert.equal(bound.handle.baseSha, BASE_SHA);
    assert.equal(bound.handle.remoteUrl, remoteUrl);
    assert.deepEqual(repoIdentity(bound.handle), resource.binding);
    workingDir = bound.handle.workingDir;
    assert.equal(fs.existsSync(workingDir), true);

    assert.deepEqual(runContext.resourceManifest, [{
      kind: "git_repo",
      id: "git_repo",
      role: "primary",
      label: "acme/app",
    }]);
    assert.equal(Object.hasOwn(runContext.resourceManifest[0], "handle"), false);
    assert.equal(Object.hasOwn(runContext.resourceManifest[0], "baseSha"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(runContext.resourceManifest)), runContext.resourceManifest);
  } finally {
    await teardownAll();
  }

  assert.equal(fs.existsSync(workingDir), false);
  assert.deepEqual(commandNames(calls), [
    "clone --depth=1",
    "rev-parse --verify",
    "remote",
    "remote remove",
    "config --local",
    "config --local",
    "config --local",
    "config --local",
    "config --local",
    "checkout --detach",
    "rev-parse HEAD",
  ]);
});

test("materializeRunContext skips empty-resource domains for decomposition-style runs", async () => {
  const domain = domainRecord({ resources: [] });
  const domainContext = buildDomainContext({ domain, config: null, repoRoot: REPO_ROOT });
  let called = false;

  const materialized = await materializeRunContext({
    domainContext,
    runId: "decomposition-run-1",
    engineRepoRoot: REPO_ROOT,
    materializeDomainResourcesFn: async () => {
      called = true;
      throw new Error("empty resources should not materialize");
    },
  });

  assert.equal(called, false);
  assert.equal(materialized.materialized, false);
  assert.deepEqual(domainContext.resources, []);
    assert.deepEqual(materialized.runContext, {
      runId: "decomposition-run-1",
      engineRepoRoot: REPO_ROOT,
      resources: {},
      selectedResourceId: null,
      selectedResource: null,
      resourceManifest: [],
      runGit: undefined,
    });
  assert.equal(typeof materialized.teardownAll, "function");
  await materialized.teardownAll();
});

function fakeRunGit({ source, remoteUrl }) {
  const calls = [];
  const runGit = (args, { cwd } = {}) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      assert.equal(args[2], "refs/heads/main^{commit}");
      return ok(`${BASE_SHA}\n`);
    }
    if (args[0] === "clone") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      assert.equal(args[9], remoteUrl);
      fs.mkdirSync(args[10], { recursive: true });
      return ok("");
    }
    if (args[0] === "remote" && args.length === 1) {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return ok("origin\n");
    }
    if (args[0] === "remote" && args[1] === "remove") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return ok("");
    }
    if (args[0] === "config" && args[3] === "--get-regexp") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return fail("no matching config");
    }
    if (args[0] === "config") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return ok("");
    }
    if (args[0] === "checkout" && args[1] === "--detach") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return ok("");
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      assert.notEqual(path.resolve(cwd), path.resolve(source));
      return ok(`${BASE_SHA}\n`);
    }
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
  return { runGit, calls };
}

function ok(stdout) {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr) {
  return { ok: false, status: 1, stdout: "", stderr };
}

function commandNames(calls) {
  return calls.map((call) => {
    if (call.args[0] === "clone") return "clone --depth=1";
    if (call.args[0] === "config") return "config --local";
    return call.args.slice(0, 2).join(" ");
  });
}

function repoIdentity(handle) {
  return {
    owner: handle.owner,
    repo: handle.repo,
    default_branch: handle.default_branch,
  };
}

function domainRecord({ resources }) {
  return makeDomainRecord({
    domainId: "support-ops",
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    teamId: "team-1",
    teamKey: "SUP",
    teamName: "Support Ops",
    webhookId: "webhook-1",
    resources,
  });
}

function gitRepoResource({
  id = "git_repo",
  role = "primary",
  owner = "acme",
  repo = "app",
  default_branch = "main",
} = {}) {
  return {
    id,
    kind: "git_repo",
    role,
    binding: {
      owner,
      repo,
      default_branch,
    },
  };
}
