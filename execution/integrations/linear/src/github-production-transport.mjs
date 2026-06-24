import { loadLinearConfig } from "./config.mjs";
import {
  createBrokerGitHubTransport,
  createDryRunGitHubTransport,
} from "./github-promotion-client.mjs";
import { createGitHubTokenBrokerClient } from "./github-token-broker-client.mjs";

export function createProductionGitHubPromotionTransport({
  repoRoot = process.cwd(),
  repoIdentity = null,
  config = null,
  now = () => new Date(),
} = {}) {
  if (repoIdentity?.connection_mode === "real") {
    const resolvedConfig = config || loadLinearConfig({ repoRoot });
    const brokerClient = createGitHubTokenBrokerClient({ config: resolvedConfig, repoRoot });
    return {
      transport: createBrokerGitHubTransport({ brokerClient, now }),
      brokerClient,
      mode: "real_broker",
    };
  }
  return {
    transport: createDryRunGitHubTransport({ now }),
    brokerClient: null,
    mode: "dry_run",
  };
}
