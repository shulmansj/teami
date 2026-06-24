import assert from "node:assert/strict";
import test from "node:test";

import { createProductionGitHubPromotionTransport } from "../src/github-production-transport.mjs";

test("production GitHub transport stays dry-run unless the connection state is real", () => {
  const selection = createProductionGitHubPromotionTransport({
    repoIdentity: { connection_mode: "dry_run" },
  });
  assert.equal(selection.mode, "dry_run");
  assert.equal(selection.transport.kind, "dry_run");
  assert.equal(selection.brokerClient, null);
});

test("production GitHub transport uses the hosted broker for verified real connections", () => {
  const selection = createProductionGitHubPromotionTransport({
    repoIdentity: { connection_mode: "real" },
    config: {
      github: {
        token_broker: {
          base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
          token: "broker_token",
        },
      },
    },
  });
  assert.equal(selection.mode, "real_broker");
  assert.equal(selection.transport.kind, "real_broker");
  assert.equal(selection.brokerClient.baseUrl, "https://broker.test/functions/v1/agentic-factory-github-broker");
});

test("verified real connections fail closed without broker credentials", () => {
  assert.throws(
    () => createProductionGitHubPromotionTransport({
      repoIdentity: { connection_mode: "real" },
      config: { github: { token_broker: {} } },
    }),
    /github_token_broker_not_configured/,
  );
});
