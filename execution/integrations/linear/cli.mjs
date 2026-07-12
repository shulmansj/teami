#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  ensureNeedsPrincipalProjectStatus,
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

// True when this module is the process entrypoint. The Windows npm bin runs `node cli.mjs`
// (argv[1] is the cli.mjs path), but the Linux/macOS npm bin is a SYMLINK (node_modules/.bin/teami
// -> cli.mjs), so argv[1] is the symlink — the plain suffix check misses it and the CLI would never
// run under `npx @shulmansj/teami@release …` on those platforms. Fall back to a realpath comparison for the symlink case.
function isCliEntrypoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  if (invoked.replace(/\\/g, "/").endsWith("/execution/integrations/linear/cli.mjs")) return true;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(redactOAuthSecrets(error.message));
    process.exitCode = 1;
  });
}
