import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReplayRecovery,
  DEFAULT_CONSECUTIVE_COMMITS,
  DEFAULT_UAT_PREFIX,
  NO_LINEAR_DOMAIN_MESSAGE,
  parseGatewayUatArgs,
  selectUatDomain,
} from "../uat/gateway-uat.mjs";

test("gateway UAT no-domain guard fails before any live Linear setup", () => {
  assert.throws(
    () => selectUatDomain({ registry: null }),
    (error) => error.message === NO_LINEAR_DOMAIN_MESSAGE && error.code === "no_linear_domain",
  );
  assert.throws(
    () => selectUatDomain({ registry: { domains: [{ id: "paused", status: "paused" }] } }),
    (error) => error.message === NO_LINEAR_DOMAIN_MESSAGE && error.code === "no_linear_domain",
  );
});

test("gateway UAT domain selection requires an explicit disposable domain when ambiguous", () => {
  const registry = {
    domains: [
      { id: "alpha", status: "active" },
      { id: "beta", status: "active" },
    ],
  };

  assert.equal(selectUatDomain({ registry, domainId: "beta" }).id, "beta");
  assert.throws(
    () => selectUatDomain({ registry }),
    /multiple Linear domains configured \(alpha, beta\) - pass --domain <domain_id>/,
  );
});

test("gateway UAT args accept flags and env for disposable team selection", () => {
  const parsed = parseGatewayUatArgs([
    "--domain",
    "uat-domain",
    "--prefix",
    "AF-LIVE-UAT",
    "--consecutive",
    "3",
    "--poll-interval-ms",
    "2500",
    "--timeout-ms",
    "10000",
    "--keep-artifacts",
  ], {});

  assert.equal(parsed.domainId, "uat-domain");
  assert.equal(parsed.prefix, "AF-LIVE-UAT");
  assert.equal(parsed.consecutive, 3);
  assert.equal(parsed.pollIntervalMs, 2500);
  assert.equal(parsed.timeoutMs, 10000);
  assert.equal(parsed.keepArtifacts, true);

  const fromEnv = parseGatewayUatArgs([], {
    AGENTIC_FACTORY_UAT_DOMAIN: "env-domain",
    AGENTIC_FACTORY_UAT_PREFIX: "ENV-UAT",
  });
  assert.equal(fromEnv.domainId, "env-domain");
  assert.equal(fromEnv.prefix, "ENV-UAT");
  assert.equal(fromEnv.consecutive, DEFAULT_CONSECUTIVE_COMMITS);
  assert.equal(parseGatewayUatArgs([], {}).prefix, DEFAULT_UAT_PREFIX);
});

test("gateway UAT replay classifier rejects fresh redecompose and uncleared intents", () => {
  const pending = {
    domainId: "support",
    projectId: "project-1",
    runId: "run-1",
    artifactKind: "commit",
  };
  assert.deepEqual(
    classifyReplayRecovery({
      projectId: "project-1",
      expectedRunId: "run-1",
      pendingBefore: pending,
      pendingAfter: null,
      statuses: [
        { projectId: "project-1", state: "replaying", runId: "run-1" },
      ],
    }).ok,
    true,
  );

  const failed = classifyReplayRecovery({
    projectId: "project-1",
    expectedRunId: "run-1",
    pendingBefore: pending,
    pendingAfter: pending,
    statuses: [
      { projectId: "project-1", state: "working" },
    ],
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.reasons, [
    "missing_replaying_status",
    "fresh_decompose_seen_during_replay",
    "pending_intent_not_cleared",
  ]);
});
