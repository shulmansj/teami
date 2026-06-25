import { createInterface } from "node:readline/promises";

import { writeLinearCache } from "../cache.mjs";
import {
  emptyDomainRegistry,
  readDomainRegistry,
  writeDomainRegistry,
} from "../domain-registry.mjs";
import {
  readGitHubConnectionState,
  runGitHubInitPhase,
} from "../github-setup.mjs";
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import {
  declaredWorkspaceFromResumeDomain,
  isWorkspaceMismatchError,
  knownRegistryWorkspaces,
  resolveLinearSetupWorkspace,
  setupIncompleteDomainForName,
  setupLinearDomain,
  verifyDeclaredWorkspace,
  workspaceLabel,
} from "../linear-service.mjs";
import {
  ensurePhoenixReady,
} from "../local-phoenix-manager.mjs";
import {
  runLocalPhoenixTracePreflight,
} from "../local-phoenix-trace-sink.mjs";
import {
  formatLocalSupervisorRegistrationReport,
  LOCAL_SUPERVISOR_CONSENT_FLAG,
  registerLocalSupervisorStub,
} from "../local-supervisor.mjs";
import { runRuntimeSmokeChecks } from "../runtime-smoke.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { doctorGraphqlLinear } from "./doctor-command.mjs";
import { hasCliFlag, parseCliFlags } from "./flags.mjs";
import {
  configWithGithubFlags,
  githubFailureTitle,
  githubSetupTransportFromFlags,
} from "./github-command-options.mjs";
import {
  createBootstrapLinearCredentialStore,
  promoteSetupCredentialToDomain,
} from "./local-setup-cleanup.mjs";

const LINEAR_SETUP_COMMAND_OPTIONS = Object.freeze({
  "domain:add": {
    intro: "Agentic Factory will add a domain to the same factory and learning loop, then ask Linear for read/write browser authorization for that domain's workspace.",
    prompt: "Domain name to add to this factory and learning loop: ",
    readyLabel: "Domain",
    runGithubPhase: false,
  },
  init: {
    intro: "Agentic Factory will ask Linear for read/write browser authorization to verify setup and post project updates. No API key is required.",
    prompt: "First domain name: ",
    readyLabel: "First domain",
    runGithubPhase: true,
  },
});

export async function runLinearSetupCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, output = createCliOutput() } = context;
    const commandOptions = LINEAR_SETUP_COMMAND_OPTIONS[command] || LINEAR_SETUP_COMMAND_OPTIONS.init;
    const initArgs = args;
    const { flags: initFlags } = parseCliFlags(initArgs);
    const registry = readDomainRegistry({ repoRoot }) || emptyDomainRegistry();
    const domainNameResolution = resolveSetupCommandDomainNameHint(initArgs, registry);
    const domainNameHint = domainNameResolution.domainNameHint;
    const githubResumeDomain = commandOptions.runGithubPhase
      ? resolveGitHubPhaseResumeDomain({ args: initArgs, registry, repoRoot })
      : null;
    const credentialStore = createBootstrapLinearCredentialStore({ config, repoRoot });
    const totalSteps = commandOptions.runGithubPhase ? 2 : 1;
    output.heading(`Agentic Factory ${output.symbols.separator} setup`);
    output.detail(commandOptions.intro);
    if (githubResumeDomain) {
      output.step(1, totalSteps, "Connect Linear");
      output.info(
        `Linear already connected for domain "${domainNameForResumeDomain(githubResumeDomain)}" in workspace ${workspaceLabel(githubResumeDomain.linear)}.`,
      );
      output.success(`Workspace: ${workspaceLabel(githubResumeDomain.linear)}`);
      output.success(`Team "${githubResumeDomain.linear?.team_name || domainNameForResumeDomain(githubResumeDomain)}" already connected`);
      output.info("Linear connected.");
      const githubOk = await runGitHubInitStep({
        repoRoot,
        config,
        initFlags,
        output,
        totalSteps,
      });
      if (!githubOk) return;
      await finishSetupOutput({
        output,
        commandOptions,
        phoenixAppUrl: null,
        config,
        repoRoot,
        cachePath,
        domainId: githubResumeDomain.id,
      });
      return;
    }
    output.step(1, totalSteps, commandOptions.runGithubPhase ? "Connect Linear" : "Connect Linear domain");
    if (credentialStore.warning) output.warn(credentialStore.warning);
    if (domainNameResolution.resumeDomain) {
      output.info(
        `Resuming incomplete setup for domain "${domainNameHint}" in Linear workspace ${workspaceLabel(domainNameResolution.resumeDomain.linear)}.`,
      );
      if (domainNameResolution.resumeDomain.setup_incomplete_cause) {
        output.info(`Previous setup stopped at: ${domainNameResolution.resumeDomain.setup_incomplete_cause}`);
      }
    }
    explicitWorkspaceExpectation(initFlags, process.env);
    const domainName = domainNameHint || await resolveInitDomainName(initArgs, { command });
    const linearProgress = createLinearSetupProgress(output);
    const workspaceAuthorization = await authorizeLinearSetupWorkspace({
      config,
      repoRoot,
      credentialStore,
      registry,
      flags: initFlags,
      env: process.env,
      domainNameHint,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      log: linearProgress,
    });
    output.success(`Workspace: ${workspaceLabel(workspaceAuthorization.workspace)}`);
    output.detail(`workspace_id=${workspaceAuthorization.workspace.id}`);
    output.detail("Linear setup authorization verified.");

    const result = await setupLinearDomain({
      client: workspaceAuthorization.setupAuth.client,
      config,
      registry,
      repoRoot,
      domainName,
      workspace: workspaceAuthorization.workspace,
      declaredWorkspace: workspaceAuthorization.declaredWorkspace,
      writeCache: (nextCache, context) => {
        writeLinearCache(context.linear.cachePath, nextCache);
      },
      writeRegistry: (nextRegistry) => {
        writeDomainRegistry({ repoRoot }, nextRegistry);
      },
      promoteCredential: ({ context }) =>
        promoteSetupCredentialToDomain({
          setupCredentialStore: credentialStore,
          config,
          repoRoot,
          domainContext: context,
        }),
      onPreview: (line) => output.detail(line),
    });
    printSummary(result.summary, output);
    output.success(`Team "${result.domain.linear?.team_name || domainName}" created (project template + labels ready)`);
    output.success("Local gateway ready for Planned projects");
    output.info("Linear connected.");
    let phoenixAppUrl = null;
    const phoenix = await ensurePhoenixReady({
      repoRoot,
      onProgress: (line) => output.detail(line),
    }).catch((error) => ({ ok: false, reason: error.message }));
    if (phoenix.ok) {
      phoenixAppUrl = phoenix.appUrl;
      output.detail(`Local Phoenix UI: ${phoenix.appUrl}`);
      output.detail(`Local Phoenix collector: ${phoenix.collectorUrl}`);
      const preflight = await runLocalPhoenixTracePreflight({
        repoRoot,
        ensureReady: async () => phoenix,
        domainContext: result.context,
      }).catch((error) => ({ ok: false, status: "trace_delivery_failed", reason: error.message }));
      if (preflight.ok) {
        output.detail(`Local Phoenix preflight trace: ${preflight.traceId}`);
      } else {
        output.warn(`Local Phoenix trace preflight failed: ${preflight.reason || preflight.status || "unknown"}`);
        if (preflight.repairHint) output.detail(`Repair: ${preflight.repairHint}`);
      }
    } else {
      output.warn(`Local Phoenix is degraded: ${phoenix.reason || "unavailable"}`);
      if (phoenix.repairHint) output.detail(`Repair: ${phoenix.repairHint}`);
    }
    output.detail(`${commandOptions.readyLabel} connected: ${result.domain.id}`);
    if (commandOptions.runGithubPhase) {
      const githubOk = await runGitHubInitStep({
        repoRoot,
        config,
        initFlags,
        output,
        totalSteps,
      });
      if (!githubOk) return;
    }
    await finishSetupOutput({
      output,
      commandOptions,
      phoenixAppUrl,
      config,
      repoRoot,
      cachePath,
      domainId: result.domain.id,
    });
    if (!result.ok) process.exitCode = 1;
}

async function runGitHubInitStep({
  repoRoot,
  config,
  initFlags = {},
  output,
  totalSteps,
} = {}) {
  // Step 11: GitHub behavior-repo creation/connection. Successful adopter
  // init REQUIRES the GitHub connection because the MVP product promise
  // includes generating promotion PRs — a missing GitHub capability fails
  // init with a connect-GitHub repair path instead of silently completing
  // an eval-only adoption (plan ~424-434). The default setup transport uses
  // the adopter's local git/gh auth; pass --github-dry-run for a recorded
  // rehearsal that is not adoption-complete.
  const githubConfig = configWithGithubFlags(config, initFlags);
  output.step(2, totalSteps, "Connect GitHub");
  const githubProgress = createGitHubSetupProgress(output);
  const githubPhase = await runGitHubInitPhase({
    repoRoot,
    config: githubConfig,
    transport: await githubInitTransportFromFlags({
      config: githubConfig,
      flags: initFlags,
      repoRoot,
      onProgress: githubProgress.log,
    }),
    requestedOwner: initFlags["github-owner"] || null,
    requestedRepoName: initFlags["github-repo"] || null,
    requestedVisibility: initFlags["github-visibility"] || null,
    onProgress: githubProgress.log,
  });
  if (!githubPhase.ok) {
    output.detail(`reason: ${githubPhase.reason}`);
    if (githubPhase.detail) output.detail(githubPhase.detail);
    output.error({
      what: githubFailureTitle(githubPhase.reason),
      why: "Setup needs a verified GitHub connection before promotion PRs can work.",
      fix: githubPhase.repair || "repair the GitHub connection and rerun npm run init",
    });
    process.exitCode = 1;
    return false;
  }
  if (!githubProgress.state.repoPrinted) {
    output.success(`Repo connected: ${githubPhase.connection.repo.full_name}`);
  }
  if (!githubProgress.state.authPrinted) {
    output.success("Local GitHub auth verified");
  }
  if (githubPhase.connection.connection_mode === "dry_run") {
    output.warn("Dry-run recorded; setup is not complete until GitHub is connected for real.");
  }
  output.detail(`connection_mode=${githubPhase.connection.connection_mode}`);
  output.info("GitHub connected.");
  if (hasCliFlag(initFlags, LOCAL_SUPERVISOR_CONSENT_FLAG)) {
    const supervisor = registerLocalSupervisorStub({
      repoRoot,
      explicitConsent: true,
      trigger: "init",
    });
    for (const line of formatLocalSupervisorRegistrationReport(supervisor)) output.detail(line);
  }
  return true;
}

async function runFinalGate({
  config,
  repoRoot,
  cachePath,
  domainId,
  output,
  runSmoke = runRuntimeSmokeChecks,
  runDoctor = doctorGraphqlLinear,
} = {}) {
  output.section("Verifying setup");
  output.info(`Running your claude/codex once to verify it works${output.symbols.ellipsis} this can take a minute the first time.`);
  let smoke;
  try {
    smoke = await runSmoke({ config, repoRoot });
  } catch (error) {
    smoke = { ok: false, results: [], error: error.message };
  }
  if (smoke.ok) {
    output.success("Runtime check passed");
  } else {
    output.warn("Runtime check did not pass; setup will still complete.");
    output.info("run npm run runtime-smoke");
  }

  let checks = [];
  try {
    checks = await runDoctor({
      config,
      repoRoot,
      cachePath,
      domainId,
      includeRuntimeSmoke: false,
      includePhoenix: false,
      includeLocalSupervisor: false,
    });
  } catch (error) {
    checks = [{ name: "health check", ok: false, message: error.message }];
  }

  for (const check of checks) {
    if (check.ok) {
      output.success(check.name);
    } else {
      output.error({ what: check.name });
      if (check.message) output.detail(`${check.name}: ${check.message}`);
    }
  }
  const doctorGreen = checks.length > 0 && checks.every((check) => check.ok);
  if (doctorGreen) {
    output.success("Setup verified.");
  } else {
    output.error({
      what: "Some setup checks need attention",
      fix: "fix the checks above, then re-run npm run init (setup is resumable).",
    });
  }
  return { ok: doctorGreen, smokeOk: Boolean(smoke.ok), doctorOk: doctorGreen };
}

async function finishSetupOutput({
  output,
  commandOptions,
  phoenixAppUrl = null,
  config,
  repoRoot,
  cachePath,
  domainId,
  finalGate = runFinalGate,
  runSmoke,
  runDoctor,
}) {
  const gate = await finalGate({
    config,
    repoRoot,
    cachePath,
    domainId,
    output,
    runSmoke,
    runDoctor,
  });
  if (!gate.ok) {
    output.warn("Setup is resumable — fix the checks above and re-run npm run init.");
    process.exitCode = 1;
    return gate;
  }
  output.done(commandOptions.runGithubPhase ? "Setup complete." : `${commandOptions.readyLabel} connected.`);
  output.nextSteps([
    'Move a Linear project to "Planned" to start your first run',
    { text: "factory gateway start", hint: "open your factory for business (polls Linear; Ctrl-C to stop)" },
    { text: "factory doctor", hint: "re-check everything's healthy" },
    { text: "Local Phoenix (traces)", hint: phoenixAppUrl || "run npm run phoenix:start" },
  ]);
  if (!output.verbose) {
    output.raw(`\n  ${output.style.dim("(Run with --verbose for full detail.)")}\n`);
  }
  process.exitCode = 0;
  return gate;
}

async function githubInitTransportFromFlags({
  config,
  flags = {},
  repoRoot,
  onProgress = () => {},
} = {}) {
  return githubSetupTransportFromFlags({ config, flags, repoRoot, onProgress });
}

async function authorizeLinearSetupWorkspace({
  config,
  repoRoot,
  credentialStore,
  registry = emptyDomainRegistry(),
  flags = {},
  env = process.env,
  domainNameHint = null,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = (line) => console.log(line),
  createSetupAuth = createLinearSetupGraphqlClient,
  promptWorkspace = promptLinearWorkspacePicker,
  promptReauthorize = promptLinearReauthorization,
  maxAuthorizationAttempts = 3,
} = {}) {
  const selection = await resolveLinearWorkspaceSelection({
    registry,
    flags,
    env,
    domainNameHint,
    isTTY,
    log,
    promptWorkspace,
  });
  const declaredWorkspace = selection.declaredWorkspace;
  let trustLinePrinted = false;

  for (let attempt = 1; attempt <= maxAuthorizationAttempts; attempt += 1) {
    if (!trustLinePrinted) {
      log("Authorizing grants Agentic Factory read/write access to the entire selected Linear workspace; Linear has no narrower scope.");
      trustLinePrinted = true;
    }
    for (const line of workspaceAuthorizationInstructions(selection)) log(line);

    let setupAuth = createSetupAuth({
      config,
      repoRoot,
      credentialStore,
      allowBrowserAuth: true,
      allowRefresh: true,
      deferTokenPersistence: true,
      onProgress: (line) => log(line),
    });
    const guard = await verifyWorkspaceGrantForSelection({
      setupAuth,
      selection,
      declaredWorkspace,
      registry,
      isTTY,
      attempt,
      maxAuthorizationAttempts,
      promptReauthorize,
      log,
      allowRetry: true,
    });
    if (guard.retry) continue;

    await persistVerifiedSetupAuthToken(setupAuth);
    return {
      setupAuth,
      workspace: guard.workspace,
      declaredWorkspace,
      selection,
    };
  }

  throw new Error("workspace_authorization_retries_exhausted");
}

async function verifyWorkspaceGrantForSelection({
  setupAuth,
  selection,
  declaredWorkspace,
  registry,
  isTTY,
  attempt,
  maxAuthorizationAttempts,
  promptReauthorize,
  log,
  allowRetry = true,
} = {}) {
  const workspace = await resolveLinearSetupWorkspace({ client: setupAuth.client });

  if (selection.mode === "another") {
    log(`Authorized workspace: ${workspaceLabel(workspace)}`);
    if (isTTY && allowRetry) {
      const label = workspaceLabel(workspace);
      const answer = await promptReauthorize({
        message:
          `Authorized Linear workspace: ${label}. Press Enter to continue, or type R then Enter to reopen Linear's consent screen and use the workspace dropdown. Nothing has been created yet: `,
      });
      if (String(answer || "").trim().toLocaleLowerCase() === "r") {
        await setupAuth.tokenProvider?.clear?.();
        return { retry: true };
      }
    }
    try {
      verifyDeclaredWorkspace({
        registry,
        declaredWorkspace,
        grantedWorkspace: workspace,
      });
    } catch (error) {
      if (!isWorkspaceMismatchError(error)) throw error;
      if (allowRetry && workspaceMismatchCameFromStoredCredential(setupAuth)) {
        log("Stored Linear setup authorization points at the wrong workspace. Reauthorizing in the browser...");
        await setupAuth.tokenProvider?.clear?.();
        return { retry: true };
      }
      await setupAuth.tokenProvider?.discardPendingTokenSet?.();
      throw new Error(`${error.message}. Pick this workspace from the known workspace list instead.`);
    }
    return { workspace };
  }

  try {
    verifyDeclaredWorkspace({
      registry,
      declaredWorkspace,
      grantedWorkspace: workspace,
    });
    return { workspace };
  } catch (error) {
    if (!isWorkspaceMismatchError(error)) throw error;
    if (allowRetry && workspaceMismatchCameFromStoredCredential(setupAuth)) {
      log("Stored Linear setup authorization points at the wrong workspace. Reauthorizing in the browser...");
      await setupAuth.tokenProvider?.clear?.();
      return { retry: true };
    }
    await setupAuth.tokenProvider?.discardPendingTokenSet?.();
    throw error;
  }
}

async function persistVerifiedSetupAuthToken(setupAuth) {
  await setupAuth?.tokenProvider?.persistPendingTokenSet?.();
}

function workspaceMismatchCameFromStoredCredential(setupAuth) {
  return ["stored", "refresh"].includes(setupAuth?.tokenProvider?.lastTokenSource);
}

async function resolveLinearWorkspaceSelection({
  registry = emptyDomainRegistry(),
  flags = {},
  env = process.env,
  domainNameHint = null,
  isTTY = false,
  log = (line) => console.log(line),
  promptWorkspace = promptLinearWorkspacePicker,
} = {}) {
  const knownWorkspaces = knownRegistryWorkspaces(registry);
  const resumeDomain =
    setupIncompleteDomainForName(registry, domainNameHint) ||
    (!domainNameHint ? singleSetupIncompleteDomain(registry) : null);
  const resumeDeclaredWorkspace = declaredWorkspaceFromResumeDomain(resumeDomain);
  if (resumeDeclaredWorkspace) {
    return {
      mode: "known",
      source: "resume",
      knownWorkspaces,
      declaredWorkspace: resumeDeclaredWorkspace,
      label: workspaceLabel(resumeDeclaredWorkspace),
    };
  }

  const explicitWorkspace = explicitWorkspaceExpectation(flags, env);
  if (explicitWorkspace) {
    const known = knownWorkspaces.find((workspace) => workspaceMatchesExpectation(workspace, explicitWorkspace));
    if (known) {
      return {
        mode: "known",
        source: "explicit_known",
        knownWorkspaces,
        declaredWorkspace: known,
        label: workspaceLabel(known),
      };
    }
    return {
      mode: "expected",
      source: "explicit_expected",
      knownWorkspaces,
      declaredWorkspace: { mode: "expected", value: explicitWorkspace },
      label: explicitWorkspace,
    };
  }

  if (knownWorkspaces.length === 0 || !isTTY) {
    return {
      mode: "another",
      source: knownWorkspaces.length === 0 ? "empty_registry" : "non_interactive_default",
      knownWorkspaces,
      declaredWorkspace: { mode: "different" },
      label: "another workspace",
    };
  }

  const picked = await promptWorkspace({ knownWorkspaces, log });
  if (picked === "another" || picked?.mode === "another") {
    return {
      mode: "another",
      source: "picker",
      knownWorkspaces,
      declaredWorkspace: { mode: "different" },
      label: "another workspace",
    };
  }
  const known = knownWorkspaces.find((workspace) =>
    workspace.workspaceId === picked?.workspaceId ||
    workspaceMatchesExpectation(workspace, picked?.workspaceName || picked?.name || ""),
  );
  if (!known) throw new Error("workspace_picker_selection_invalid");
  return {
    mode: "known",
    source: "picker",
    knownWorkspaces,
    declaredWorkspace: known,
    label: workspaceLabel(known),
  };
}

function workspaceAuthorizationInstructions(selection) {
  if (selection.mode === "another") {
    return ["On Linear's page, choose the workspace in Linear's workspace dropdown."];
  }
  return [`On Linear's page, make sure the workspace dropdown shows '${selection.label}'.`];
}

async function promptLinearWorkspacePicker({
  knownWorkspaces,
  log = (line) => console.log(line),
  prompt = promptLine,
} = {}) {
  log("Select Linear workspace:");
  knownWorkspaces.forEach((workspace, index) => {
    log(`${index + 1}. ${workspace.workspaceName || workspace.workspaceId}`);
  });
  log(`${knownWorkspaces.length + 1}. another workspace (Linear will show you your workspaces)`);
  const answer = await prompt(`Choose workspace number (1-${knownWorkspaces.length + 1}): `);
  const index = Number.parseInt(String(answer).trim(), 10);
  if (Number.isInteger(index) && index >= 1 && index <= knownWorkspaces.length) {
    return knownWorkspaces[index - 1];
  }
  if (Number.isInteger(index) && index === knownWorkspaces.length + 1) return "another";
  throw new Error("workspace_picker_selection_invalid");
}

async function promptLinearReauthorization({ message } = {}) {
  return promptLine(message || "press R then Enter to re-authorize: ");
}

async function promptLine(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

function explicitWorkspaceExpectation(flags = {}, env = process.env) {
  if (Object.prototype.hasOwnProperty.call(flags, "workspace")) {
    if (typeof flags.workspace !== "string" || !flags.workspace.trim()) {
      throw new Error("Usage: --workspace requires a workspace name or id.");
    }
    return flags.workspace.trim();
  }
  const value = env.AGENTIC_FACTORY_EXPECTED_WORKSPACE;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workspaceMatchesExpectation(workspace, expected) {
  const value = String(expected || "").trim();
  if (!value) return false;
  if (workspace.workspaceId && workspace.workspaceId === value) return true;
  return Boolean(workspace.workspaceName && normalizeWorkspaceText(workspace.workspaceName) === normalizeWorkspaceText(value));
}

function normalizeWorkspaceText(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function printSummary(summary, output = null) {
  for (const item of summary.found || []) emitSummaryDetail(output, `found: ${item}`);
  for (const item of summary.created || []) emitSummaryDetail(output, `created: ${item}`);
  for (const item of summary.updated || []) emitSummaryDetail(output, `updated: ${item}`);
  for (const item of summary.failed || []) emitSummaryDetail(output, `failed: ${item}`);
}

function emitSummaryDetail(output, line) {
  if (output) {
    output.detail(line);
    return;
  }
  console.log(line);
}

function createLinearSetupProgress(output) {
  let browserLinePrinted = false;
  return (line) => {
    const text = String(line || "");
    if (/Opening Linear authorization/i.test(text)) {
      if (!browserLinePrinted) {
        output.info(`Opening your browser to authorize Linear${output.symbols.ellipsis}`);
        browserLinePrinted = true;
      }
      return;
    }
    output.detail(text);
  };
}

function createGitHubSetupProgress(output) {
  const state = {
    authPrinted: false,
    repoPrinted: false,
  };

  const log = (line) => {
    const text = String(line || "");
    const visibleProgress = text.match(/^GitHub progress:\s*(.+)$/);
    if (visibleProgress) {
      output.info(visibleProgress[1]);
      return;
    }
    const createdRepo = text.match(/^(recorded \(dry-run\)|created): behavior repo (.+) \(visibility (.+)\)$/);
    if (createdRepo) {
      const [, action, repo, visibility] = createdRepo;
      output.success(`Repo ${action === "created" ? "created" : "recorded"}: ${repo} (${visibility})`);
      state.repoPrinted = true;
      return;
    }
    const foundRepo = text.match(/^found: behavior repo (.+?) already /);
    if (foundRepo) {
      output.success(`Repo found: ${foundRepo[1]}`);
      state.repoPrinted = true;
      output.detail(text);
      return;
    }
    if (/^(verified|recorded \(dry-run\)): behavior repo will use local ambient git\/gh auth/i.test(text)) {
      if (!state.authPrinted) {
        output.success("Local GitHub auth verified");
        state.authPrinted = true;
      }
      output.detail(text);
      return;
    }
    if (/^GitHub connection recorded in DRY-RUN mode/i.test(text)) {
      // The single adopter-facing dry-run warning is emitted by the main flow
      // (based on connection_mode); keep the raw transport line verbose-only
      // here so the warning is never doubled.
      output.detail(text);
      return;
    }
    const repoTarget = text.match(/^GitHub repo target: (.+)$/);
    if (repoTarget) {
      output.info(`GitHub repo target: ${repoTarget[1]}`);
      return;
    }
    if (/^WARNING\b/i.test(text)) {
      output.warn(text.replace(/^WARNING\s*/i, ""));
      return;
    }
    if (/^(FAIL GitHub setup:|Repair:)/i.test(text)) {
      return;
    }
    output.detail(text);
  };

  return { log, state };
}

async function resolveInitDomainName(args = [], { command = "init" } = {}) {
  const explicit = explicitInitDomainName(args);
  if (explicit) return explicit;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = (LINEAR_SETUP_COMMAND_OPTIONS[command] || LINEAR_SETUP_COMMAND_OPTIONS.init).prompt;
    const answer = await promptLine(prompt);
    if (answer.trim()) return answer.trim();
  }
  throw new Error("An explicit domain name is required. Rerun with --domain \"Your Domain Name\".");
}

function explicitInitDomainName(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  const explicit = [
    flags.domain,
    flags["domain-name"],
    ...positionals,
    process.env.AGENTIC_FACTORY_DOMAIN_NAME,
  ].find((value) => typeof value === "string" && value.trim());
  if (explicit) return explicit.trim();
  return null;
}

function resolveSetupCommandDomainNameHint(args = [], registry = emptyDomainRegistry()) {
  const explicit = explicitInitDomainName(args);
  if (explicit) {
    return {
      domainNameHint: explicit,
      resumeDomain: setupIncompleteDomainForName(registry, explicit),
      source: "explicit",
    };
  }

  const resumeDomain = singleSetupIncompleteDomain(registry);
  const domainNameHint = domainNameForResumeDomain(resumeDomain);
  return {
    domainNameHint,
    resumeDomain: domainNameHint ? resumeDomain : null,
    source: domainNameHint ? "single_setup_incomplete" : "none",
  };
}

function resolveGitHubPhaseResumeDomain({
  args = [],
  registry = emptyDomainRegistry(),
  repoRoot = process.cwd(),
  readConnectionState = readGitHubConnectionState,
} = {}) {
  if (explicitInitDomainName(args)) return null;
  if (singleSetupIncompleteDomain(registry)) return null;
  const domains = (registry?.domains || []).filter((domain) => domain.status === "active");
  if (domains.length !== 1) return null;
  return githubConnectionNeedsInit({ repoRoot, readConnectionState }) ? domains[0] : null;
}

function githubConnectionNeedsInit({
  repoRoot = process.cwd(),
  readConnectionState = readGitHubConnectionState,
} = {}) {
  const read = readConnectionState({ repoRoot });
  if (!read.ok) return true;
  const connection = read.connection || {};
  return connection.connection_mode !== "real" ||
    connection.status !== "verified" ||
    connection.adoption_complete !== true;
}

function singleSetupIncompleteDomain(registry = emptyDomainRegistry()) {
  const domains = (registry?.domains || []).filter((domain) => domain.status === "setup_incomplete");
  return domains.length === 1 ? domains[0] : null;
}

function domainNameForResumeDomain(domain = null) {
  if (!domain) return null;
  return domain.adopter_provided_name || domain.id || null;
}

export {
  authorizeLinearSetupWorkspace,
  explicitInitDomainName,
  finishSetupOutput,
  githubInitTransportFromFlags,
  promptLinearWorkspacePicker,
  resolveInitDomainName,
  resolveGitHubPhaseResumeDomain,
  resolveLinearWorkspaceSelection,
  resolveSetupCommandDomainNameHint,
  runFinalGate,
};
