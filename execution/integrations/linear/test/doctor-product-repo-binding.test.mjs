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
  doctorProductRepoBindingChecks,
} from "../src/cli/doctor-command.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

test("doctor product-repo readout includes bound repo facts and unbound domains", (t) => {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-doctor-product-repo-"));
  process.env.TEAMI_HOME = repoRoot;
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const registry = [
    activeDomain("main", {
      adopterProvidedName: "Main Product",
      teamKey: "MAIN",
      teamName: "Main Team",
      resources: [{
        id: "git_repo",
        kind: "git_repo",
        role: "primary",
        binding: {
          owner: "acme",
          repo: "app",
          default_branch: "trunk",
        },
      }],
    }),
    activeDomain("support", {
      adopterProvidedName: "Support Ops",
      teamKey: "SUP",
      teamName: "Support Team",
    }),
  ].reduce(
    (next, domain) => upsertDomainRecord(next, domain),
    emptyDomainRegistry(),
  );
  writeDomainRegistry({ repoRoot }, registry);
  const before = readDomainRegistry({ repoRoot });

  const checks = doctorProductRepoBindingChecks({ repoRoot });

  assert.deepEqual(readDomainRegistry({ repoRoot }), before, "doctor readout must not mutate the registry");
  assert.equal(checks.length, 2);

  const bound = checks.find((check) => check.name === "domain main product repo binding");
  assert.ok(bound, "bound domain product-repo check should be present");
  assert.equal(bound.ok, true);
  assert.equal(bound.state, "ok");
  assert.equal(bound.showMessage, true);
  assert.ok(bound.message.includes("domain=Main Product (main)"));
  assert.ok(bound.message.includes("linear_team=MAIN Main Team (team-main)"));
  assert.ok(bound.message.includes("product repo remote=acme/app"));
  assert.ok(bound.message.includes("default_branch=trunk"));
  assert.ok(bound.message.includes("materialization=fresh_remote_clone"));
  assert.ok(bound.message.includes("granted_by=domain:grant"));
  assert.ok(bound.message.includes("behavior repo GitHub setup remains separate config.github"));
  assert.ok(bound.message.includes("fresh remote clone ready for execution"));

  const unbound = checks.find((check) => check.name === "domain support product repo binding");
  assert.ok(unbound, "unbound domain product-repo check should be present");
  assert.equal(unbound.ok, true);
  assert.equal(unbound.showMessage, true);
  assert.ok(unbound.message.includes("domain=Support Ops (support)"));
  assert.ok(unbound.message.includes("linear_team=SUP Support Team (team-support)"));
  assert.ok(unbound.message.includes("no product repo granted"));
  assert.ok(unbound.message.includes("domain grant authorizes product repos"));
  assert.ok(unbound.message.includes("behavior repo GitHub setup remains separate config.github"));
});

test("doctor product-repo readout does not inspect local git state", (t) => {
  resetResourceRegistry();
  registerGitRepoResourceKind();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-doctor-product-repo-no-git-"));
  process.env.TEAMI_HOME = repoRoot;
  t.after(() => {
    resetResourceRegistry();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const registry = upsertDomainRecord(
    emptyDomainRegistry(),
    activeDomain("main", {
      resources: [{
        id: "git_repo",
        kind: "git_repo",
        role: "primary",
        binding: {
          owner: "acme",
          repo: "app",
          default_branch: "main",
        },
      }],
    }),
  );
  writeDomainRegistry({ repoRoot }, registry);

  const checks = doctorProductRepoBindingChecks({
    repoRoot,
    runGit: () => {
      throw new Error("doctor should not run git for product repo binding posture");
    },
  });

  const bound = checks.find((check) => check.name === "domain main product repo binding");
  assert.ok(bound, "bound domain product-repo check should be present");
  assert.equal(bound.state, "ok");
  assert.equal(bound.ok, true);
  assert.match(bound.message, /fresh remote clone ready for execution/);
  assert.equal(bound.fix, undefined);
});

function activeDomain(domainId, overrides = {}) {
  return makeDomainRecord({
    domainId,
    status: "active",
    workspaceId: `workspace-${domainId}`,
    workspaceName: "Example Workspace",
    teamId: `team-${domainId}`,
    teamKey: "AF",
    teamName: "Teami",
    teamNameLastSeenAt: "2026-06-23T00:00:00.000Z",
    webhookId: `webhook-${domainId}`,
    ...overrides,
  });
}
