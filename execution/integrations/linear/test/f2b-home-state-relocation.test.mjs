import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRunStoreWritable,
  defaultRunStoreDir,
  runArtifactPath,
} from "../../../engine/run-store.mjs";
import {
  resolvePackagedDefault,
  teamiHomePaths,
} from "../src/app-home.mjs";
import {
  DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH,
  DEFAULT_CONFIG_PATH,
  cachePathForConfig,
} from "../src/config.mjs";
import {
  teamCachePath,
  teamCacheRelativePath,
  teamRegistryPath,
  emptyTeamRegistry,
  makeTeamRecord,
  readTeamRegistry,
  writeTeamRegistry,
} from "../src/team-registry.mjs";
import {
  acquireGatewayLock,
  gatewayLockPath,
} from "../src/gateway-loop.mjs";
import {
  githubConnectionStatePath,
} from "../src/github-setup.mjs";
import {
  createLocalTriggerStore,
  localTriggerStorePath,
  readLocalTriggerState,
} from "../src/local-trigger-store.mjs";
import {
  defaultEvalRunStoreDir,
} from "../src/decomposition-eval-cli.mjs";
import {
  defaultExperimentReceiptDir,
} from "../src/phoenix-experiment.mjs";
import {
  defaultFixtureExportDir,
  fixtureExportGrantPath,
  fixtureExportLogPath,
} from "../src/fixture-dataset-exporter.mjs";
import {
  defaultGateReportDir,
} from "../src/process-change-gate.mjs";
import {
  defaultImprovementDraftDir,
} from "../src/improvement-drafter.mjs";
import {
  defaultPromotionCandidateLedgerDir,
  promotionScannerHealthPath,
  promotionScannerLedgerPath,
} from "../src/promotion-scanner/ledger-store.mjs";
import {
  defaultPromotionWorkspaceDir,
} from "../src/promotion-workspace.mjs";
import {
  defaultPromotionRegistryDir,
} from "../src/promotion/registry-store.mjs";
import {
  runtimeSmokeCachePath,
  writeRuntimeSmokeCache,
  readRuntimeSmokeCache,
} from "../src/runtime-smoke.mjs";

test("F2b runtime state defaults resolve under Teami home, never repoRoot .teami", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-f2b-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-f2b-home-"));
  const teamRef = "support-ops";
  const legacyRepoState = path.join(repoRoot, ".teami");

  const paths = [
    teamiHomePaths({ home }).registryPath,
    teamRegistryPath(home),
    teamCachePath({ home, teamRef }),
    cachePathForConfig({ linear: { cache_path: ".teami/linear.json" } }, home),
    gatewayLockPath(home),
    githubConnectionStatePath(home),
    defaultRunStoreDir({ home, teamRef }),
    runArtifactPath({ runId: "run-home", home, teamRef }),
    defaultPromotionRegistryDir(home),
    defaultPromotionCandidateLedgerDir(home),
    promotionScannerLedgerPath(defaultPromotionCandidateLedgerDir(home)),
    promotionScannerHealthPath(defaultPromotionCandidateLedgerDir(home)),
    defaultGateReportDir(home),
    defaultEvalRunStoreDir(home),
    defaultImprovementDraftDir(home),
    defaultExperimentReceiptDir(home),
    defaultFixtureExportDir(home),
    fixtureExportGrantPath(home),
    fixtureExportLogPath(home),
    localTriggerStorePath(home),
    runtimeSmokeCachePath({ runtime: { smoke_cache_path: ".teami/runtime-smoke.json" } }, home),
    defaultPromotionWorkspaceDir(home),
  ];

  for (const candidate of paths) assertHomeStatePath({ candidate, home, legacyRepoState });

  assert.equal(
    path.isAbsolute(DEFAULT_CONFIG_PATH),
    true,
  );
  assert.equal(
    resolvePackagedDefault(DEFAULT_CONFIG_PACKAGE_RELATIVE_PATH).endsWith("config.package-default.json"),
    true,
  );
  assert.match(DEFAULT_CONFIG_PATH, /config\.(example|package-default)\.json$/);
  assert.equal(teamCacheRelativePath(teamRef), "teams/support-ops/linear.json");

  const registry = emptyTeamRegistry();
  registry.teams.push(makeTeamRecord({
    teamRef,
    status: "active",
    workspaceId: "workspace-1",
    workspaceName: "Support Ops",
    teamId: "team-1",
    teamKey: "OPS",
    teamName: "Support Ops",
    teamNameLastSeenAt: "2026-07-08T00:00:00.000Z",
  }));
  writeTeamRegistry({ home }, registry);
  assert.equal(readTeamRegistry({ home }).teams[0].id, teamRef);

  assert.deepEqual(assertRunStoreWritable({ home, teamRef }), {
    ok: true,
    run_store_dir: defaultRunStoreDir({ home, teamRef }),
  });

  const lock = acquireGatewayLock({
    home,
    idGenerator: () => "f2b-lock-token",
    installHandlers: false,
  });
  assert.equal(lock.ok, true);
  assert.equal(lock.lockPath, gatewayLockPath(home));
  lock.release();

  const store = createLocalTriggerStore({
    repoRoot,
    home,
    idGenerator: () => "wake-f2b",
  });
  await store.claimSyntheticWake({
    teamRef,
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectId: "project-1",
  });
  assert.equal(readLocalTriggerState(localTriggerStorePath(home)).events.length, 1);

  const smokePath = runtimeSmokeCachePath({}, home);
  writeRuntimeSmokeCache(smokePath, { ok: true, results: [] });
  assert.deepEqual(readRuntimeSmokeCache(smokePath), { ok: true, results: [] });

  assert.equal(fs.existsSync(legacyRepoState), false);
});

function assertHomeStatePath({ candidate, home, legacyRepoState }) {
  assert.ok(
    path.resolve(candidate).startsWith(path.resolve(home)),
    `${candidate} should be under home ${home}`,
  );
  assert.ok(
    !path.resolve(candidate).startsWith(path.resolve(legacyRepoState)),
    `${candidate} should not be under legacy repo state ${legacyRepoState}`,
  );
}
