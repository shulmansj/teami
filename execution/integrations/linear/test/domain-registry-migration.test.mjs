import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  DOMAIN_REGISTRY_SCHEMA_VERSION_V1,
  domainCacheRelativePath,
  domainRegistryPath,
  migrateDomainRegistry,
  readDomainRegistry,
  validateDomainRegistry,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

test("readDomainRegistry migrates raw v1 JSON to v2 and round-trips as v2", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-domain-registry-migration-"));
  try {
    const registryPath = domainRegistryPath(tempRoot);
    const legacyRegistry = {
      schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION_V1,
      domains: [validDomain("support-ops")],
    };
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify(legacyRegistry, null, 2)}\n`, "utf8");

    const migrated = readDomainRegistry({ repoRoot: tempRoot });

    assert.equal(migrated.schema_version, DOMAIN_REGISTRY_SCHEMA_VERSION);
    assert.deepEqual(migrated.domains, legacyRegistry.domains);
    assert.equal(validateDomainRegistry(migrated), true);

    writeDomainRegistry({ repoRoot: tempRoot }, migrated);
    assert.deepEqual(readDomainRegistry({ repoRoot: tempRoot }), migrated);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("migrateDomainRegistry leaves current v2 registries unchanged", () => {
  const registry = {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains: [validDomain("sales-ops")],
  };

  assert.equal(migrateDomainRegistry(registry), registry);
  assert.equal(validateDomainRegistry(registry), true);
});

test("unsupported registry schema versions still fail validation loudly", () => {
  assert.throws(
    () =>
      validateDomainRegistry({
        schema_version: "teami-domain-registry/v999",
        domains: [],
      }),
    /unsupported_schema_version/,
  );
});

function validDomain(id) {
  return {
    id,
    status: "active",
    linear: {
      workspace_id: `workspace-${id}`,
      workspace_name: "Example Workspace",
      team_id: `team-${id}`,
      team_key: "AF",
      team_name: "Teami",
      team_name_last_seen_at: "2026-06-30T00:00:00.000Z",
      provisioned_by_teami: true,
      webhook_id: `webhook-${id}`,
      cache_path: domainCacheRelativePath(id),
    },
    resources: [],
    policy_profile: "default",
    policy_overlay_ref: null,
  };
}
