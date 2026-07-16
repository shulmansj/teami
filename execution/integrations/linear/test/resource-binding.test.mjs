import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  materializeTeamResources,
} from "../../../engine/materialize.mjs";
import {
  resetResourceRegistry,
} from "../../../engine/resource-registry.mjs";
import {
  TEAM_REGISTRY_SCHEMA_VERSION,
  makeTeamRecord,
  validateTeamRegistry,
} from "../src/team-registry.mjs";
import {
  DUMMY_VALUE,
  registerDummyResourceKind,
} from "./dummy-resource-kind.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

test("a test-only dummy resource kind declares through team validation and materializes through the engine seam", async () => {
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
    const team = makeTeamRecord({
      teamRef: "dummy-team",
      resources: [resource],
    });
    const registry = {
      schema_version: TEAM_REGISTRY_SCHEMA_VERSION,
      teams: [team],
    };

    assert.equal(validateTeamRegistry(registry), true);

    const materialized = await materializeTeamResources({
      teamResources: team.resources,
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
