import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { resolveForegroundDomainCache } from "../src/domain-command-context.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  makeDomainRecord,
} from "../src/domain-registry.mjs";
import {
  allowedRepoPacketFromDomainResources,
  behaviorRepoIdForRepoRoot,
  buildDomainContext,
  resolveForegroundDomainContext,
  resolveWakeDomainContext,
} from "../src/domain-resolver.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Exactly-one-intersection resolves; zero returns no context; two-plus active teams fail as cross-domain conflict", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
    domain("domain-c", { workspaceId: "workspace-2", teamId: "team-c", webhookId: "webhook-c" }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["team-a", "external-team"] },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.domainId, "domain-a");
  assert.equal(resolved.context.linear.cachePath, path.join(repoRoot, ".teami", "domains", "domain-a", "linear.json"));
  assert.equal(Object.isFrozen(resolved.context), true);
  assert.equal(Object.isFrozen(resolved.context.linear), true);

  const zero = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["external-team"] },
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, "no_domain_project_team_intersection");
  assert.deepEqual(zero.candidates, []);
  assert.equal(zero.context, undefined);

  const ambiguous = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", projectTeamIds: ["team-a", "team-b"] },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "cross_domain_team_conflict");
  assert.deepEqual(ambiguous.candidates[0], { domainId: "domain-a", status: "active", teamId: "team-a" });
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.domainId), ["domain-a", "domain-b"]);
  assert.equal(ambiguous.context, undefined);
});

test("Webhook match fails closed when project teamIds intersect two active governed domains", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "team-b"],
    },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "cross_domain_team_conflict");
  assert.deepEqual(resolved.candidates, [
    { domainId: "domain-a", status: "active", teamId: "team-a" },
    { domainId: "domain-b", status: "active", teamId: "team-b" },
  ]);
  assert.equal(resolved.context, undefined);
});

test("Webhook match resolves when project teamIds intersect only that active governed domain", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", { workspaceId: "workspace-1", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "external-team"],
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.domainId, "domain-a");
});

test("Project teamIds intersecting one active and one non-active domain resolve to the active domain", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", {
      workspaceId: "workspace-1",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      webhookId: "webhook-a",
      projectTeamIds: ["team-a", "team-b"],
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.domainId, "domain-a");
});

test("Workspace-only selector fails when one active and one paused domain share a workspace", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", {
      workspaceId: "workspace-1",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1" },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "insufficient_wake_identity");
  assert.deepEqual(resolved.candidates, [
    { domainId: "domain-a", status: "active", teamId: "team-a" },
    { domainId: "domain-b", status: "paused", teamId: "team-b" },
  ]);
});

test("Team rename/key change does not affect resolution (ids only)", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamKey: "NEW",
      teamName: "Renamed In Linear",
      webhookId: "webhook-a",
    }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamName: "Old Name That Must Not Route",
    },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.context.domainId, "domain-a");
  assert.equal(resolved.context.linear.teamName, "Renamed In Linear");
  assert.equal(resolved.context.linear.teamKey, "NEW");
});

test("Team id mismatch fails closed even when the name matches", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", {
      workspaceId: "workspace-1",
      teamId: "team-a",
      teamName: "Matching Name",
      webhookId: "webhook-a",
    }),
  ]);

  const resolved = resolveWakeDomainContext({
    registry,
    config,
    repoRoot,
    selector: { workspaceId: "workspace-1", teamId: "team-wrong", teamName: "Matching Name" },
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "team_id_mismatch");
  assert.equal(resolved.context, undefined);
});

test("Multi-domain registry plus no --domain returns an explicit foreground command error", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", { workspaceId: "workspace-2", teamId: "team-b", webhookId: "webhook-b" }),
  ]);

  const resolved = resolveForegroundDomainContext({ registry, config, repoRoot });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "domain_required");
  assert.match(resolved.message, /--domain <domain_id>/);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.domainId), ["domain-a", "domain-b"]);
});

test("doctor and gateway foreground startup read per-domain cache, not legacy cache", () => {
  const config = loadLinearConfig({ repoRoot });
  const tempRoot = path.join(repoRoot, ".tmp-domain-command-test");
  const registry = registryWithDomains([
    domain("support-ops", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
  ]);
  const seen = [];

  for (const commandName of ["doctor", "gateway", "gateway status"]) {
    const resolved = resolveForegroundDomainCache({
      registry,
      config,
      repoRoot: tempRoot,
      readCache: (cachePath) => {
        seen.push({ commandName, cachePath });
        return { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-a" };
      },
    });
    assert.equal(resolved.context.domainId, "support-ops");
  }

  assert.deepEqual(
    seen.map((item) => [item.commandName, item.cachePath.replace(/\\/g, "/")]),
    [
      ["doctor", `${tempRoot.replace(/\\/g, "/")}/.teami/domains/support-ops/linear.json`],
      ["gateway", `${tempRoot.replace(/\\/g, "/")}/.teami/domains/support-ops/linear.json`],
      ["gateway status", `${tempRoot.replace(/\\/g, "/")}/.teami/domains/support-ops/linear.json`],
    ],
  );
});

test("Single active foreground domain resolves implicitly but wake routing never uses foreground fallback", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    domain("domain-b", {
      workspaceId: "workspace-2",
      teamId: "team-b",
      webhookId: "webhook-b",
      status: "paused",
    }),
  ]);

  const foreground = resolveForegroundDomainContext({ registry, config, repoRoot });
  assert.equal(foreground.ok, true);
  assert.equal(foreground.context.domainId, "domain-a");

  const wake = resolveWakeDomainContext({ registry, config, repoRoot, selector: {} });
  assert.equal(wake.ok, false);
  assert.equal(wake.reason, "missing_workspace_id");
});

test("DomainContext trace contains stable IDs and no domain name", () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = registryWithDomains([
    domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
  ]);

  const resolved = resolveForegroundDomainContext({ registry, config, repoRoot });

  assert.equal(resolved.ok, true);
  assert.deepEqual(Object.keys(resolved.context.trace).sort(), [
    "behavior_repo_id",
    "domain_id",
    "team_id",
    "workspace_id",
  ]);
  assert.equal(resolved.context.trace.domain_id, "domain-a");
  assert.equal(resolved.context.trace.workspace_id, "workspace-1");
  assert.equal(resolved.context.trace.team_id, "team-a");
  assert.equal(resolved.context.trace.behavior_repo_id, behaviorRepoIdForRepoRoot(repoRoot));
  assert.equal(Object.hasOwn(resolved.context.trace, "domain_name"), false);
});

test("allowed repo packet exposes the S1 wire shape from domain resources", () => {
  const resources = [
    {
      id: "git_repo:acme/portal",
      kind: "git_repo",
      role: "primary",
      binding: {
        owner: "Acme",
        repo: "Portal",
        default_branch: "main",
      },
    },
    {
      id: "git_repo:acme/api",
      kind: "git_repo",
      role: "secondary",
      binding: {
        owner: "Acme",
        repo: "Api",
        default_branch: "trunk",
        repo_scope: "automation",
      },
    },
    {
      id: "linear_project",
      kind: "linear_project",
      role: "context",
      binding: {
        owner: "ignored",
        repo: "ignored",
        default_branch: "ignored",
      },
    },
  ];
  const expected = [
    {
      resource_id: "git_repo:acme/portal",
      owner: "Acme",
      repo: "Portal",
      default_branch: "main",
    },
    {
      resource_id: "git_repo:acme/api",
      owner: "Acme",
      repo: "Api",
      default_branch: "trunk",
      repo_scope: "automation",
    },
  ];

  assert.deepEqual(allowedRepoPacketFromDomainResources(resources), expected);

  const domainRecord = {
    ...domain("domain-a", { workspaceId: "workspace-1", teamId: "team-a", webhookId: "webhook-a" }),
    resources,
  };
  const context = buildDomainContext({ domain: domainRecord, config: null, repoRoot });
  assert.deepEqual(context.allowedRepoPacket, allowedRepoPacketFromDomainResources(domainRecord.resources));
  assert.deepEqual(context.allowedRepoPacket, expected);
});

function registryWithDomains(domains) {
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains,
  };
}

function domain(id, {
  workspaceId,
  teamId,
  teamKey = "AF",
  teamName = "Teami",
  webhookId,
  status = "active",
} = {}) {
  return makeDomainRecord({
    domainId: id,
    status,
    workspaceId,
    workspaceName: "Example Workspace",
    teamId,
    teamKey,
    teamName,
    teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    webhookId,
  });
}
