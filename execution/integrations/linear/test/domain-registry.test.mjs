import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  registerResourceKind,
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  domainCacheRelativePath,
  domainRegistryPath,
  emptyDomainRegistry,
  makeDomainRecord,
  mintDomainId,
  readDomainRegistry,
  removeDomainRegistryState,
  updateDomainLinearLabels,
  upsertDomainRecord,
  validateDomainRegistry,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("Minting requires an explicit name; ids are path-safe, immutable, collision-suffixed", () => {
  assert.throws(() => mintDomainId(""), /explicit domain name/i);
  assert.throws(() => mintDomainId("!!!"), /at least one ASCII letter or digit/i);
  assert.equal(mintDomainId("Customer Success Pilot"), "customer-success-pilot");
  assert.equal(mintDomainId("Customer Success Pilot", ["customer-success-pilot"]), "customer-success-pilot-2");
  assert.equal(
    mintDomainId("Customer Success Pilot", ["customer-success-pilot", "customer-success-pilot-2"]),
    "customer-success-pilot-3",
  );
  assert.match(mintDomainId("A/B: East_2026"), /^[a-z0-9-]+$/);

  const domain = makeDomainRecord({
    domainId: "customer-success-pilot",
    status: "active",
    workspaceId: "workspace-1",
    teamId: "team-1",
    teamKey: "CSP",
    teamName: "Customer Success Pilot",
    webhookId: "webhook-1",
  });
  const renamed = updateDomainLinearLabels(
    { schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] },
    "customer-success-pilot",
    { teamName: "Customer Success", teamKey: "CS", seenAt: "2026-06-11T00:00:00.000Z" },
  ).domains[0];

  assert.equal(renamed.id, "customer-success-pilot");
  assert.equal(renamed.linear.cache_path, ".agentic-factory/domains/customer-success-pilot/linear.json");
});

test("Default records carry an empty resources list without requiring registered resource kinds", () => {
  resetResourceRegistry();
  const domain = makeDomainRecord({ domainId: "main" });

  assert.deepEqual(domain.resources, []);
  validateDomainRegistry({ schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] });
});

test("Resources validate by dispatching to the registered resource-kind definition", () => {
  resetResourceRegistry();
  try {
    registerGitRepoStubResourceKind();
    const resource = gitRepoResource({ id: "primary-repo" });
    const domain = makeDomainRecord({
      domainId: "support-ops",
      status: "active",
      workspaceId: "workspace-1",
      teamId: "team-1",
      teamKey: "SO",
      teamName: "Support Ops",
      webhookId: "webhook-1",
      resources: [resource],
    });

    assert.deepEqual(domain.resources, [resource]);
    validateDomainRegistry({ schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] });
  } finally {
    resetResourceRegistry();
  }
});

test("Resources reject unknown kinds, invalid bindings, duplicate ids, and duplicate kinds", () => {
  resetResourceRegistry();
  try {
    assert.throws(
      () =>
        validateDomainRegistry({
          schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
          domains: [{ ...activeDomain("main"), resources: [gitRepoResource({ kind: "missing_kind" })] }],
        }),
      /unknown_resource_kind:missing_kind/,
    );

    registerGitRepoStubResourceKind();
    assert.throws(
      () =>
        validateDomainRegistry({
          schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
          domains: [
            {
              ...activeDomain("main"),
              resources: [gitRepoResource({ binding: { owner: "acme", repo: "app", default_branch: "main" } })],
            },
          ],
        }),
      /git_repo_binding_missing_local_checkout_path/,
    );
    assert.throws(
      () =>
        validateDomainRegistry({
          schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
          domains: [
            {
              ...activeDomain("main"),
              resources: [
                gitRepoResource({ id: "repo-a" }),
                gitRepoResource({ id: "repo-a", role: "secondary" }),
              ],
            },
          ],
        }),
      /resources_duplicate_id:repo-a/,
    );
    assert.throws(
      () =>
        validateDomainRegistry({
          schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
          domains: [
            {
              ...activeDomain("main"),
              resources: [
                gitRepoResource({ id: "repo-a" }),
                gitRepoResource({ id: "repo-b", role: "secondary" }),
              ],
            },
          ],
        }),
      /resources_duplicate_kind:git_repo/,
    );
  } finally {
    resetResourceRegistry();
  }
});

test("A document containing default_domain_id fails validation", () => {
  const registry = emptyDomainRegistry();
  registry.default_domain_id = "main";
  assert.throws(() => validateDomainRegistry(registry), /unknown_key:registry\.default_domain_id/);
});

test("Unknown keys, invalid status, or non-path-safe id fail validation", () => {
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        domains: [
          {
            ...activeDomain("main"),
            behavior_rules: { hidden: true },
          },
        ],
      }),
    /unknown_key:domains\[0\]\.behavior_rules/,
  );
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        domains: [{ ...activeDomain("main"), status: "enabled" }],
      }),
    /invalid_status:main/,
  );
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        domains: [{ ...activeDomain("main"), id: "../main" }],
      }),
    /invalid_domain_id/,
  );
});

test("Cached team_name/team_key can change without changing domain_id or cache path", () => {
  const registry = {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [activeDomain("main")],
  };
  const next = updateDomainLinearLabels(registry, "main", {
    teamName: "Renamed Domain",
    teamKey: "RND",
    seenAt: "2026-06-11T12:00:00.000Z",
  });

  assert.equal(next.domains[0].id, "main");
  assert.equal(next.domains[0].linear.team_name, "Renamed Domain");
  assert.equal(next.domains[0].linear.team_key, "RND");
  assert.equal(next.domains[0].linear.cache_path, domainCacheRelativePath("main"));
  validateDomainRegistry(next);
});

test("Registry stores the original adopter-provided domain name for setup resume", () => {
  const domain = makeDomainRecord({
    domainId: "support-ops-2",
    status: "setup_incomplete",
    adopterProvidedName: "Support Ops",
    workspaceId: "workspace-1",
    workspaceName: "Example Workspace",
  });
  assert.equal(domain.adopter_provided_name, "Support Ops");
  validateDomainRegistry({ schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION, domains: [domain] });

  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        domains: [{ ...domain, adopter_provided_name: "" }],
      }),
    /invalid_adopter_provided_name:support-ops-2/,
  );
});

test("Registry path is ignored-local and writes are atomic with read-back validation", () => {
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.agentic-factory\/$/m);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-domain-registry-"));
  const registry = upsertDomainRecord(emptyDomainRegistry(), activeDomain("main"));
  const filePath = writeDomainRegistry({ repoRoot: tempRoot }, registry);

  assert.equal(filePath, domainRegistryPath(tempRoot));
  assert.deepEqual(readDomainRegistry({ repoRoot: tempRoot }), registry);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((file) => file.endsWith(".tmp")),
    [],
  );
});

test("Registry schema does not allow Phoenix project fields", () => {
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        phoenix: { project_name: "agentic-factory" },
        domains: [],
      }),
    /unknown_key:registry\.phoenix/,
  );
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
        domains: [
          {
            ...activeDomain("main"),
            phoenix: { project_name: "domain-project" },
          },
        ],
      }),
    /unknown_key:domains\[0\]\.phoenix/,
  );
});

test("reset removes registry and per-domain cache dirs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-domain-reset-"));
  const registry = upsertDomainRecord(emptyDomainRegistry(), activeDomain("support-ops"));
  writeDomainRegistry({ repoRoot: tempRoot }, registry);
  const cacheDir = path.join(tempRoot, ".agentic-factory", "domains", "support-ops");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "linear.json"), JSON.stringify({ domainId: "support-ops" }));

  const removed = removeDomainRegistryState({ repoRoot: tempRoot });

  assert.equal(removed.registryRemoved, true);
  assert.equal(removed.domainsDirRemoved, true);
  assert.equal(fs.existsSync(domainRegistryPath(tempRoot)), false);
  assert.equal(fs.existsSync(path.join(tempRoot, ".agentic-factory", "domains")), false);
});

function activeDomain(id, overrides = {}) {
  return makeDomainRecord({
    domainId: id,
    status: "active",
    workspaceId: `workspace-${id}`,
    workspaceName: "Example Workspace",
    teamId: `team-${id}`,
    teamKey: "AF",
    teamName: "Agentic Factory",
    teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    webhookId: `webhook-${id}`,
    ...overrides,
  });
}

function registerGitRepoStubResourceKind() {
  registerResourceKind({
    kind: "git_repo",
    validateBinding(binding) {
      for (const field of ["owner", "repo", "default_branch", "local_checkout_path"]) {
        if (typeof binding?.[field] !== "string" || binding[field].trim() === "") {
          throw new Error(`git_repo_binding_missing_${field}`);
        }
      }
    },
    materialize: async () => ({ kind: "git_repo", handle: {}, teardown() {} }),
    manifestEntry: (resource) => ({
      kind: "git_repo",
      id: resource.id,
      role: resource.role,
      label: `${resource.binding.owner}/${resource.binding.repo}`,
    }),
  });
}

function gitRepoResource({
  id = "repo",
  kind = "git_repo",
  role = "primary",
  binding = {
    owner: "acme",
    repo: "app",
    default_branch: "main",
    local_checkout_path: "<local-checkout-path>",
  },
} = {}) {
  return {
    id,
    kind,
    role,
    binding,
  };
}
