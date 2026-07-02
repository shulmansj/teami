#!/usr/bin/env node
import path from "node:path";

import { redactOAuthSecrets, runCliCommand } from "./src/cli/dispatch.mjs";

// Bind the repo root from the launcher's own location (cli.mjs lives at
// <repo>/execution/integrations/linear/cli.mjs, so the root is three directories up) rather than
// from process.cwd(), so `factory` resolves config/registry/locks correctly even when invoked
// from another directory. FACTORY_REPO_ROOT is a test/override hook so a spawned cli.mjs can be
// pointed at a scratch directory without depending on the process working directory.
export function resolveCliRepoRoot() {
  const override = process.env.FACTORY_REPO_ROOT;
  if (override && override.trim()) return path.resolve(override);
  return path.resolve(import.meta.dirname, "..", "..", "..");
}

const repoRoot = resolveCliRepoRoot();
const command = process.argv[2];

async function main() {
  await runCliCommand({ repoRoot, command, args: process.argv.slice(3) });
}

export {
  authorizeLinearSetupWorkspace,
  explicitInitDomainName,
  promptLinearWorkspacePicker,
  resolveInitDomainName,
  resolveGitHubPhaseResumeDomain,
  resolveLinearWorkspaceSelection,
  resolveSetupCommandDomainNameHint,
} from "./src/cli/linear-setup-command.mjs";
export {
  createBootstrapLinearCredentialStore,
  legacyCredentialStores,
  promoteSetupCredentialToDomain,
  removeLocalLinearSetup,
  removeOneDomainSetup,
} from "./src/cli/local-setup-cleanup.mjs";
export {
  acquireDomainRunnerLock,
  formatTriggerWakeStatusLine,
  inspectTriggerStatus,
  requeueTriggerWake,
  runOneTriggerWake,
  selectRunnerDomains,
} from "./src/cli/runner-command.mjs";
export {
  resolveSupervisorCommandContext,
} from "./src/cli/supervisor-command.mjs";

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/execution/integrations/linear/cli.mjs")) {
  main().catch((error) => {
    console.error(redactOAuthSecrets(error.message));
    process.exitCode = 1;
  });
}
