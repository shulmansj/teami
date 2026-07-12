import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliOutput } from "../src/cli/cli-output.mjs";
import { runLocalSetupCleanupCommand } from "../src/cli/local-setup-cleanup.mjs";
import { cachePathForConfig, loadLinearConfig } from "../src/config.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";
import { setupStatePathForCache } from "../src/local-state.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleConfigPath = path.join(
  repoRoot,
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);

function fileCredentialConfig() {
  const config = loadLinearConfig({ repoRoot, configPath: exampleConfigPath, behaviorConfig: false });
  const next = structuredClone(config);
  next.linear.oauth.credential_storage = "file";
  return next;
}

function cleanupFixture(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(tempRoot, "teami-home");
  fs.mkdirSync(home, { recursive: true });
  const config = fileCredentialConfig();
  const cachePath = cachePathForConfig(config, home);
  return {
    tempRoot,
    home,
    repoRoot: tempRoot,
    config,
    cachePath,
    setupStatePath: setupStatePathForCache(cachePath),
  };
}

function registryWithDomains(domains) {
  return domains.reduce(
    (registry, domain) => upsertDomainRecord(registry, makeDomainRecord(domain)),
    emptyDomainRegistry(),
  );
}

function activeDomain(domainId, workspaceId, teamId, teamKey, teamName) {
  return {
    domainId,
    status: "active",
    workspaceId,
    workspaceName: `${teamName} Workspace`,
    teamId,
    teamKey,
    teamName,
    webhookId: `webhook-${domainId}`,
  };
}

function captureOutput() {
  const writes = [];
  const stream = {
    isTTY: false,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
  return {
    output: createCliOutput({ color: false, unicode: false, stream, errStream: stream }),
    text: () => writes.join(""),
  };
}

async function runUninstallCommand(fixture, args = []) {
  const captured = captureOutput();
  const previousHome = process.env.TEAMI_HOME;
  const previousExitCode = process.exitCode;
  process.env.TEAMI_HOME = fixture.home;
  process.exitCode = undefined;
  try {
    await runLocalSetupCleanupCommand({
      command: "uninstall",
      args,
      context: {
        config: fixture.config,
        repoRoot: fixture.repoRoot,
        home: fixture.home,
        cachePath: fixture.cachePath,
        setupStatePath: fixture.setupStatePath,
        output: captured.output,
      },
    });
    return { exitCode: process.exitCode, output: captured.text() };
  } finally {
    if (previousHome === undefined) delete process.env.TEAMI_HOME;
    else process.env.TEAMI_HOME = previousHome;
    process.exitCode = previousExitCode;
  }
}

test("uninstall with multiple domains and no domain exits non-zero without success banner", async (t) => {
  const fixture = cleanupFixture("teami-uninstall-ambiguous-");
  t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
  writeDomainRegistry(
    { home: fixture.home },
    registryWithDomains([
      activeDomain("support-ops", "workspace-1", "team-support", "SUP", "Support Ops"),
      activeDomain("sales-ops", "workspace-2", "team-sales", "SAL", "Sales Ops"),
    ]),
  );

  const result = await runUninstallCommand(fixture);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /could not resolve a single domain to uninstall; pass --domain <domain_id>\./);
  assert.doesNotMatch(result.output, /Uninstall complete\./);
  assert.doesNotMatch(result.output, /Revoke the Linear browser grant/);
});

test("uninstall with explicit domain still prints success banner and exits zero", async (t) => {
  const fixture = cleanupFixture("teami-uninstall-domain-");
  t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }));
  writeDomainRegistry(
    { home: fixture.home },
    registryWithDomains([
      activeDomain("support-ops", "workspace-1", "team-support", "SUP", "Support Ops"),
      activeDomain("sales-ops", "workspace-2", "team-sales", "SAL", "Sales Ops"),
    ]),
  );

  const result = await runUninstallCommand(fixture, ["--domain", "support-ops"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Uninstall complete\./);
  assert.match(result.output, /Revoke the Linear browser grant/);
  const registry = readDomainRegistry({ home: fixture.home });
  assert.equal(registry.domains.find((domain) => domain.id === "support-ops")?.status, "removed");
  assert.equal(registry.domains.find((domain) => domain.id === "sales-ops")?.status, "active");
});