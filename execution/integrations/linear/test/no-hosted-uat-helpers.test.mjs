import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import {
  assertNoHostedPreconditions,
  buildNoHostedUatUsage,
  parseNoHostedUatArgs,
} from "../uat/no-hosted-uat.mjs";
import {
  assertHostedSurfaceFilesRemoved,
  assertNoHostedConfiguration,
  findHostedConfigurationFindings,
  findHostedSurfaceFiles,
  scanHostedEndpointReferences,
} from "../uat/no-hosted-assertions.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test("no-hosted UAT args accept the gateway and GitHub local selectors", () => {
  const parsed = parseNoHostedUatArgs([
    "--repo-root",
    "relative-root",
    "--team",
    "uat-team",
    "--prefix",
    "AF-ZERO-HOSTED",
    "--consecutive",
    "3",
    "--poll-interval-ms",
    "2500",
    "--poll-grace-ms",
    "1000",
    "--timeout-ms",
    "10000",
    "--workspace-dir",
    "relative-workspace",
    "--branch-prefix",
    "af-uat-github-local/no-hosted",
    "--keep-artifacts",
  ], {});

  assert.equal(parsed.repoRoot, path.resolve("relative-root"));
  assert.equal(parsed.teamRef, "uat-team");
  assert.equal(parsed.prefix, "AF-ZERO-HOSTED");
  assert.equal(parsed.consecutive, 3);
  assert.equal(parsed.pollIntervalMs, 2500);
  assert.equal(parsed.pollGraceMs, 1000);
  assert.equal(parsed.timeoutMs, 10000);
  assert.equal(parsed.workspaceDir, path.resolve("relative-workspace"));
  assert.equal(parsed.branchPrefix, "af-uat-github-local/no-hosted");
  assert.equal(parsed.keepArtifacts, true);

  const fromEnv = parseNoHostedUatArgs([], {
    TEAMI_NO_HOSTED_UAT_TEAM: "env-team",
    TEAMI_NO_HOSTED_UAT_BRANCH_PREFIX: "env-no-hosted",
    TEAMI_NO_HOSTED_UAT_KEEP_ARTIFACTS: "yes",
  });
  assert.equal(fromEnv.teamRef, "env-team");
  assert.equal(fromEnv.branchPrefix, "env-no-hosted");
  assert.equal(fromEnv.keepArtifacts, true);
});

test("no-hosted UAT usage documents the combined live preconditions", () => {
  const usage = buildNoHostedUatUsage();

  assert.match(usage, /npm run uat:no-hosted/);
  assert.match(usage, /--team <id>/);
  assert.match(usage, /--workspace-dir <path>/);
  assert.match(usage, /local_ambient GitHub connection/);
});

test("no-hosted config assertion accepts the current local-only public config", () => {
  const config = loadLinearConfig({ repoRoot });

  assert.equal(assertNoHostedConfiguration({ config, teamRegistry: null, githubConnection: null }), true);
  assert.equal(assertNoHostedPreconditions({ repoRoot }).ok, true);
});

test("no-hosted config assertion rejects hosted inbox, webhook, broker, and GitHub App state", () => {
  const hostedUrl = "https://abc123.supabase.co/functions/v1/teami-inbox/status";
  const findings = findHostedConfigurationFindings({
    config: {
      inbox: { url: hostedUrl },
      github: { token_broker: { url: "https://example.invalid/teami-github-broker" } },
    },
    teamRegistry: {
      teams: [{ id: "support", linear: { webhook_id: "wh_123" } }],
    },
    githubConnection: {
      github_app: { app_id: "123", installation_id: "456" },
    },
  });

  assert.equal(findings.some((finding) => finding.id === "hosted_inbox_config_key"), true);
  assert.equal(findings.some((finding) => finding.id === "hosted_linear_webhook_id"), true);
  assert.equal(findings.some((finding) => finding.id === "github_broker_or_app_config_key"), true);
  assert.equal(findings.some((finding) => finding.id === "supabase_functions_url"), true);
  assert.throws(
    () => assertNoHostedConfiguration({
      config: { github: { app_slug: "teami" } },
    }),
    /hosted_configuration_detected/,
  );
});

test("hosted endpoint scanner rejects AF-hosted URLs and allows local/GitHub URLs", () => {
  const clean = scanHostedEndpointReferences({
    github: "https://github.com/shulmansj/teami",
    oauth: "http://127.0.0.1:8723/linear/oauth/callback",
    branch: "teami/promotion/af-uat-github-local/20260625",
  });
  assert.equal(clean.ok, true);

  const leaked = scanHostedEndpointReferences({
    inbox: "https://abc123.supabase.co/functions/v1/teami-inbox/status",
    broker: "POST /functions/v1/teami-github-broker/token",
    client: "hosted-inbox-client.mjs",
  });
  assert.equal(leaked.ok, false);
  const ids = new Set(leaked.findings.map((finding) => finding.id));
  for (const id of [
    "supabase_functions_url",
    "teami_hosted_endpoint_url",
    "hosted_inbox_endpoint",
    "supabase_functions_endpoint_path",
    "github_broker_endpoint",
    "hosted_inbox_client_reference",
  ]) {
    assert.equal(ids.has(id), true, `${id} should be detected`);
  }
});

test("hosted surface file assertion catches deleted executable modules and edge functions", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-no-hosted-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  assert.deepEqual(findHostedSurfaceFiles({ repoRoot: tempRoot }), []);
  fs.mkdirSync(path.join(tempRoot, "supabase", "functions"), { recursive: true });
  assert.deepEqual(findHostedSurfaceFiles({ repoRoot: tempRoot }), []);

  const hostedClient = path.join(
    tempRoot,
    "execution",
    "integrations",
    "linear",
    "src",
    "hosted-inbox-client.mjs",
  );
  fs.mkdirSync(path.dirname(hostedClient), { recursive: true });
  fs.writeFileSync(hostedClient, "export {};\n", "utf8");
  fs.mkdirSync(path.join(tempRoot, "supabase", "functions", "teami-inbox"), { recursive: true });

  const findings = findHostedSurfaceFiles({ repoRoot: tempRoot });
  assert.equal(findings.some((finding) => finding.id === "hosted_inbox_client"), true);
  assert.equal(findings.some((finding) => finding.id === "hosted_inbox_edge_function"), true);
  assert.equal(findings.some((finding) => finding.id === "supabase_edge_functions"), true);
  assert.throws(
    () => assertHostedSurfaceFilesRemoved({ repoRoot: tempRoot }),
    /hosted_surface_files_present/,
  );
});

test("no-hosted UAT rejects unsafe GitHub branch prefixes before live work", () => {
  assert.throws(
    () => parseNoHostedUatArgs(["--branch-prefix", "bad:prefix"], {}),
    /invalid github local UAT branch prefix/,
  );
});
