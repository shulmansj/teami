import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  materializeDomainResources,
} from "../../../engine/materialize.mjs";
import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  DOMAIN_REGISTRY_SCHEMA_VERSION,
  makeDomainRecord,
  validateDomainRegistry,
} from "../src/domain-registry.mjs";
import {
  DUMMY_VALUE,
  registerDummyResourceKind,
} from "./dummy-resource-kind.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

test("a test-only dummy resource kind declares through domain validation and materializes through the engine seam", async () => {
  resetResourceRegistry();
  let teardownAll = async () => {};

  try {
    registerDummyResourceKind();
    const resource = {
      id: "dummy-resource",
      kind: "dummy",
      role: "primary",
      binding: { fixture: "in-memory" },
    };
    const domain = makeDomainRecord({
      domainId: "dummy-domain",
      resources: [resource],
    });
    const registry = {
      schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
      domains: [domain],
    };

    assert.equal(validateDomainRegistry(registry), true);

    const materialized = await materializeDomainResources({
      domainResources: domain.resources,
      runId: "dummy-run",
      engineRepoRoot: REPO_ROOT,
    });
    teardownAll = materialized.teardownAll;

    assert.equal(materialized.runContext.selectedResourceId, "dummy-resource");
    assert.equal(materialized.runContext.selectedResource.handle.read(), DUMMY_VALUE);
    assert.deepEqual(materialized.runContext.resourceManifest, [{
      kind: "dummy",
      id: "dummy-resource",
      role: "primary",
      label: "dummy-fixture",
    }]);
  } finally {
    await teardownAll();
    resetResourceRegistry();
  }
});
