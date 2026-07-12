import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXECUTION_READINESS_EVIDENCE_KEYS,
  evaluateRunningExecutionReadiness,
  evaluateExecutionReadinessManifest,
  readShippedExecutionReadinessManifest,
  shippedExecutionReadiness,
} from "../src/execution-readiness-gate.mjs";
import { TRIGGER_REGISTRY } from "../src/trigger-registry.mjs";
import { runTriggeredExecution } from "../src/trigger-runner.mjs";
import { executionDefinition } from "../src/workflows/execution/definition.mjs";
import { applyGitRepoCommitEffect } from "../../git/git-repo-commit-effect.mjs";

test("shipped product-repository execution is disabled with no environment or config override", async () => {
  const previous = process.env.TEAMI_ENABLE_PRODUCT_EXECUTION;
  process.env.TEAMI_ENABLE_PRODUCT_EXECUTION = "1";
  try {
    assert.equal(readShippedExecutionReadinessManifest().enabled, false);
    assert.equal(shippedExecutionReadiness().ok, false);
    assert.deepEqual(executionDefinition.triggers, []);
    assert.equal(TRIGGER_REGISTRY.some((trigger) => trigger.workflow_type === "execution"), false);

    let sideEffects = 0;
    const result = await runTriggeredExecution({
      config: { execution: { enabled: true } },
      runDeps: {
        get store() {
          sideEffects += 1;
          throw new Error("store_must_not_be_read");
        },
        materialize() {
          sideEffects += 1;
        },
      },
    });
    assert.deepEqual(result, {
      status: "failed_closed",
      reason: "product_repo_execution_not_released",
    });
    assert.equal(sideEffects, 0);

    const commitResult = await applyGitRepoCommitEffect({
      get pendingGitIntentStore() {
        sideEffects += 1;
        throw new Error("intent_store_must_not_be_read");
      },
    });
    assert.deepEqual(commitResult, {
      ok: false,
      terminal: true,
      reason: "product_repo_execution_not_released",
    });
    assert.equal(sideEffects, 0);
  } finally {
    if (previous === undefined) delete process.env.TEAMI_ENABLE_PRODUCT_EXECUTION;
    else process.env.TEAMI_ENABLE_PRODUCT_EXECUTION = previous;
  }
});

test("readiness evidence is commit-bound, hashed, local, dated, and test-backed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-readiness-evidence-"));
  try {
    const evidencePath = path.join(root, "proof.json");
    fs.writeFileSync(evidencePath, '{"verified":true}\n');
    const sha256 = createHash("sha256").update(fs.readFileSync(evidencePath)).digest("hex");
    const commit = "a".repeat(40);
    const evidence = Object.fromEntries(EXECUTION_READINESS_EVIDENCE_KEYS.map((key) => [key, {
      status: "verified",
      artifacts: [{
        path: "proof.json",
        sha256,
        commit,
        verified_at: "2026-07-11T12:00:00.000Z",
        tests: [`${key}.test`],
      }],
    }]));
    const manifest = {
      schema_version: "teami-product-execution-readiness/v1",
      enabled: true,
      release_commit: commit,
      evidence,
    };
    assert.deepEqual(evaluateExecutionReadinessManifest(manifest, {
      artifactRoot: root,
      expectedCommit: commit,
    }), {
      ok: true,
      enabled: true,
      failures: [],
      release_commit: commit,
    });

    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      version: `0.3.20-sha${"b".repeat(40)}`,
    }));
    const wrongBuild = evaluateRunningExecutionReadiness(manifest, { artifactRoot: root });
    assert.equal(wrongBuild.ok, false);
    assert.ok(wrongBuild.failures.includes("release_commit_mismatch"));

    evidence.runtime_credential_containment.artifacts[0].sha256 = "b".repeat(64);
    const rejected = evaluateExecutionReadinessManifest(manifest, { artifactRoot: root });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.failures.includes("runtime_credential_containment:artifact_hash_mismatch"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
