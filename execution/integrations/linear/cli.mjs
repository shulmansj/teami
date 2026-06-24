#!/usr/bin/env node
import { redactOAuthSecrets, runCliCommand } from "./src/cli/dispatch.mjs";

const repoRoot = process.cwd();
const command = process.argv[2];
const DEFAULT_DOMAIN_RUNNER_LOCK_STALE_MS = 30 * 60 * 1000;

async function main() {
  const args = process.argv.slice(3);
  if (command === "uninstall" || command === "reset") {
    await runCliCommand({ repoRoot, command, args });
    return;
  }

  if (command === "init" || command === "domain:add") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "domain:bind-repo") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "github:init") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "doctor") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "doctor:linear") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:start") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:doctor") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:status") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:preflight") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:annotate-trace") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "worklist") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:promote-run") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:promote-decomposition") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:emit-checks") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:judge") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:decomposition") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:experiment-decomposition") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:experiment-amend") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:disagreements") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:gate") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "draft-improvement") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "promote-candidate") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "promotion:scan") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:register") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:run" || command === "supervisor") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:status") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:reconcile") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:disable") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:enable") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "supervisor:unregister") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "eval:register-prompt" || command === "eval:register-judge-prompt") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "phoenix:stop") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "runner") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "runtime-smoke") {
    await runCliCommand({ repoRoot, command, args });
  } else if (command === "trigger-status") {
    await runCliCommand({ repoRoot, command, args });
  } else {
    await runCliCommand({ repoRoot, command, args });
  }
}

export {
  authorizeLinearSetupWorkspace,
  explicitInitDomainName,
  promptLinearWorkspacePicker,
  refreshGitHubResumeSetupGrant,
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
