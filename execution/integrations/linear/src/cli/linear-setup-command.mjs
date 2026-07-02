import { createInterface } from "node:readline/promises";
import { Buffer } from "node:buffer";

import { writeLinearCache } from "../cache.mjs";
import { normalizeDoctorChecks } from "../doctor-check.mjs";
import { buildDomainContext } from "../domain-resolver.mjs";
import {
  emptyDomainRegistry,
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../domain-registry.mjs";
import {
  defaultRunCommand,
  ghJsonWithAmbientAuth,
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
import { renderDoctorCheckLine } from "./doctor-report.mjs";
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
import { formatCommand } from "./operator-output.mjs";
import {
  gitRepoResourceId,
  registerGitRepoResourceKind,
} from "../../../git/git-repo-materializer.mjs";

const GITHUB_REPO_DISCOVERY_LIMIT = 50;

const LINEAR_SETUP_COMMAND_OPTIONS = Object.freeze({
  "domain:add": {
    intro: "Teami will add a domain to the same factory and learning loop, then ask Linear for read/write browser authorization for that domain's workspace.",
    prompt: "Domain name to add to this factory and learning loop: ",
    readyLabel: "Domain",
    runGithubPhase: false,
  },
  init: {
    intro: "Teami will ask Linear for read/write browser authorization to verify setup and post project updates. No API key is required.",
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
    output.heading(`Teami ${output.symbols.separator} setup`);
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

    const repoAllowlistSelection = await discoverAndConfirmDomainGitHubRepos({
      command,
      output,
      runCommand: context.githubDiscoveryRunCommand || context.runCommand || defaultRunCommand,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });

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
    if (repoAllowlistSelection.confirmed) {
      const repoAllowlistUpdate = await persistDomainGitHubRepoAllowlist({
        repoRoot,
        domainId: result.domain.id,
        repos: repoAllowlistSelection.selectedRepos,
      });
      result.domain = repoAllowlistUpdate.domain;
      result.registry = repoAllowlistUpdate.registry;
      result.context = buildDomainContext({
        domain: result.domain,
        config,
        repoRoot,
        behaviorRepoId: result.context?.trace?.behavior_repo_id,
      });
      if (repoAllowlistUpdate.resources.length === 0) {
        output.success("Repo allowlist: none (non-code team)");
      } else {
        output.success(`Repo allowlist: ${repoAllowlistUpdate.resources.map((resource) => repoLabel(resource.binding)).join(", ")}`);
      }
    } else {
      output.detail("Repo allowlist unchanged; GitHub repo discovery was not confirmed.");
    }
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

export async function runSetupGitHubRepoDiscoveryStep({
  repoRoot = process.cwd(),
  domainId,
  command = "init",
  output = createCliOutput(),
  runCommand = defaultRunCommand,
  prompt = promptLine,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  registry = null,
  writeRegistry = (nextRegistry) => writeDomainRegistry({ repoRoot }, nextRegistry),
} = {}) {
  const selection = await discoverAndConfirmDomainGitHubRepos({
    command,
    output,
    runCommand,
    prompt,
    isTTY,
  });
  if (!selection.confirmed) {
    return {
      ...selection,
      persisted: false,
      resources: [],
    };
  }
  const persisted = await persistDomainGitHubRepoAllowlist({
    repoRoot,
    domainId,
    repos: selection.selectedRepos,
    registry,
    writeRegistry,
  });
  return {
    ...selection,
    ...persisted,
    persisted: true,
  };
}

export async function discoverAndConfirmDomainGitHubRepos({
  command = "init",
  output = createCliOutput(),
  runCommand = defaultRunCommand,
  prompt = promptLine,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  limit = GITHUB_REPO_DISCOVERY_LIMIT,
} = {}) {
  output.section("Repository access");
  let discoveredRepos = [];
  try {
    discoveredRepos = discoverGitHubRepos({ runCommand, limit });
  } catch (error) {
    output.warn(`GitHub repo discovery skipped: ${error.message}`);
    output.info(
      `Fix GitHub CLI auth with gh auth login --hostname github.com, then re-run ${formatCommand(command === "domain:add" ? "domain add" : "init")}.`,
    );
    return {
      confirmed: false,
      selectedRepos: [],
      discoveredRepos: [],
      reason: "github_repo_discovery_failed",
    };
  }

  if (discoveredRepos.length === 0) {
    output.info("No GitHub repos were found for this account. This domain will start as a non-code team.");
    return {
      confirmed: true,
      selectedRepos: [],
      discoveredRepos,
      reason: "github_repo_discovery_empty",
    };
  }

  if (!isTTY) {
    output.warn(
      "GitHub repos were found, but this terminal cannot confirm a repo allowlist. Re-run setup in an interactive terminal to allow code repos.",
    );
    return {
      confirmed: false,
      selectedRepos: [],
      discoveredRepos,
      reason: "github_repo_discovery_not_interactive",
    };
  }

  const selectedRepos = await promptGitHubRepoAllowlistSelection({
    repos: discoveredRepos,
    output,
    prompt,
  });
  if (selectedRepos.length === 0) {
    output.info("No repo selected. This domain will start as a non-code team.");
    return {
      confirmed: true,
      selectedRepos,
      discoveredRepos,
      reason: "github_repo_allowlist_empty",
    };
  }

  output.info(`Repo allowlist confirmed: ${selectedRepos.map(repoLabel).join(", ")}`);
  await printBuildTestDetectionLines({ repos: selectedRepos, output, runCommand });
  return {
    confirmed: true,
    selectedRepos,
    discoveredRepos,
    reason: "github_repo_allowlist_confirmed",
  };
}

export function discoverGitHubRepos({
  runCommand = defaultRunCommand,
  limit = GITHUB_REPO_DISCOVERY_LIMIT,
} = {}) {
  const data = ghJsonWithAmbientAuth({
    runCommand,
    args: [
      "repo",
      "list",
      "--limit",
      String(limit),
      "--json",
      "nameWithOwner,defaultBranchRef",
    ],
  });
  return normalizeGitHubRepoList(data);
}

export async function persistDomainGitHubRepoAllowlist({
  repoRoot = process.cwd(),
  domainId,
  repos = [],
  registry = null,
  writeRegistry = (nextRegistry) => writeDomainRegistry({ repoRoot }, nextRegistry),
} = {}) {
  if (!nonEmptyString(domainId)) throw new Error("github_repo_allowlist_missing_domain");
  registerGitRepoResourceKind();
  const currentRegistry = registry || readDomainRegistry({ repoRoot });
  if (!currentRegistry) throw new Error("github_repo_allowlist_registry_missing");
  const domain = currentRegistry.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`github_repo_allowlist_unknown_domain:${domainId}`);

  const resources = uniqueGitRepoResources(
    repos.map((repo) => gitRepoResourceFromBinding(gitHubRepoBinding(repo))),
  );
  const updatedDomain = {
    ...structuredClone(domain),
    resources: [
      ...(domain.resources || []).filter((resource) => resource.kind !== "git_repo"),
      ...resources,
    ],
  };
  const nextRegistry = upsertDomainRecord(currentRegistry, updatedDomain);
  const registryPath = await writeRegistry(nextRegistry);
  return {
    domain: nextRegistry.domains.find((candidate) => candidate.id === domainId),
    registry: nextRegistry,
    registryPath,
    resources,
  };
}

async function promptGitHubRepoAllowlistSelection({
  repos = [],
  output,
  prompt,
} = {}) {
  if (repos.length === 1) {
    const repo = repos[0];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await prompt(`Allow this team to work in ${repoLabel(repo)}? [Y/n]: `);
      const parsed = parseYesNo(answer, { defaultValue: true });
      if (parsed !== null) return parsed ? [repo] : [];
      output.warn("Answer y or n.");
    }
    return [];
  }

  output.info("Select GitHub repos this Linear team may work in:");
  repos.forEach((repo, index) => {
    output.info(`${index + 1}. ${repoLabel(repo)} (default branch ${repo.default_branch})`);
  });
  output.info("0. none (non-code team)");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompt("Choose repo number(s), comma-separated, or 0 for none: ");
    const parsed = parseRepoNumberSelection(answer, repos.length);
    if (parsed.ok) return parsed.indexes.map((index) => repos[index]);
    output.warn(`Enter one or more numbers from 1 to ${repos.length}, separated by commas, or 0 for none.`);
  }
  return [];
}

function parseYesNo(value, { defaultValue = null } = {}) {
  const normalized = String(value || "").trim().toLocaleLowerCase();
  if (!normalized && defaultValue !== null) return defaultValue;
  if (["y", "yes", "1", "true"].includes(normalized)) return true;
  if (["n", "no", "0", "none", "false"].includes(normalized)) return false;
  return null;
}

function parseRepoNumberSelection(value, repoCount) {
  const normalized = String(value || "").trim().toLocaleLowerCase();
  if (["0", "none", "no"].includes(normalized)) return { ok: true, indexes: [] };
  if (!normalized) return { ok: false, indexes: [] };
  const numbers = normalized
    .split(/[\s,]+/)
    .map((part) => Number.parseInt(part, 10));
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > repoCount)) {
    return { ok: false, indexes: [] };
  }
  const indexes = [...new Set(numbers.map((number) => number - 1))];
  return { ok: true, indexes };
}

async function printBuildTestDetectionLines({
  repos = [],
  output,
  runCommand,
} = {}) {
  for (const repo of repos) {
    const plan = detectGitHubRepoBuildTestPlan({ repo, runCommand });
    if (plan.detected) {
      output.success(`Build/test auto-detected for ${repoLabel(repo)}: ${plan.setup_command} -> ${plan.test_command}`);
    } else {
      output.info(
        `Build/test not auto-detected for ${repoLabel(repo)}; the first code run will perform a readiness check before editing.`,
      );
    }
  }
}

export function detectGitHubRepoBuildTestPlan({
  repo,
  runCommand = defaultRunCommand,
} = {}) {
  let packageJson = null;
  try {
    packageJson = fetchGitHubPackageJson({ repo, runCommand });
  } catch {
    return { detected: false, reason: "package_json_unreadable" };
  }
  if (!packageJson) return { detected: false, reason: "package_json_missing" };
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const testScript = nonEmptyString(scripts.test);
  if (!testScript || isNpmInitPlaceholderTest(testScript)) {
    return { detected: false, reason: "test_script_missing" };
  }
  return {
    detected: true,
    setup_command: nonEmptyString(scripts.setup) ? "npm run setup" : "npm install",
    test_command: "npm test",
  };
}

function fetchGitHubPackageJson({ repo, runCommand }) {
  const binding = gitHubRepoBinding(repo);
  const data = ghJsonWithAmbientAuth({
    runCommand,
    args: [
      "api",
      `repos/${binding.owner}/${binding.repo}/contents/package.json?ref=${encodeURIComponent(binding.default_branch)}`,
    ],
    missingOk: true,
  });
  if (!data || data.encoding !== "base64" || typeof data.content !== "string") return null;
  const text = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  return JSON.parse(text);
}

function normalizeGitHubRepoList(data) {
  const repos = [];
  const seen = new Set();
  for (const entry of Array.isArray(data) ? data : []) {
    const normalized = normalizeGitHubRepoListEntry(entry);
    if (!normalized) continue;
    const id = gitRepoResourceId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    repos.push(normalized);
  }
  return repos;
}

function normalizeGitHubRepoListEntry(entry) {
  const nameWithOwner = nonEmptyString(entry?.nameWithOwner);
  const defaultBranch = nonEmptyString(entry?.defaultBranchRef?.name);
  if (!nameWithOwner || !defaultBranch) return null;
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !nonEmptyString(parts[0]) || !nonEmptyString(parts[1])) return null;
  return {
    owner: parts[0].trim(),
    repo: parts[1].trim(),
    default_branch: defaultBranch,
  };
}

function gitHubRepoBinding(repo) {
  const binding = {
    owner: nonEmptyString(repo?.owner),
    repo: nonEmptyString(repo?.repo),
    default_branch: nonEmptyString(repo?.default_branch),
  };
  if (!binding.owner) throw new Error("github_repo_binding_missing_owner");
  if (!binding.repo) throw new Error("github_repo_binding_missing_repo");
  if (!binding.default_branch) throw new Error("github_repo_binding_missing_default_branch");
  return binding;
}

function gitRepoResourceFromBinding(binding) {
  return {
    id: gitRepoResourceId(binding),
    kind: "git_repo",
    role: "primary",
    binding,
  };
}

function uniqueGitRepoResources(resources = []) {
  const seen = new Set();
  const unique = [];
  for (const resource of resources) {
    if (seen.has(resource.id)) continue;
    seen.add(resource.id);
    unique.push(resource);
  }
  return unique;
}

function repoLabel(repo) {
  return `${repo.owner}/${repo.repo}`;
}

function isNpmInitPlaceholderTest(script) {
  return /^echo\s+["']?Error:\s+no\s+test\s+specified["']?\s*(?:&&|;)\s*exit\s+1$/i.test(String(script || "").trim());
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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
      fix: githubPhase.repair || `repair the GitHub connection and rerun ${formatCommand("init")}`,
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
  // Don't go silent during the smoke wait: an animated spinner on a TTY, a durable line when
  // piped/CI. Cleared in finally so it never leaks past the await on either the success or the
  // throw path (no smoke-runner API change).
  const smokeProgress = output.progress("Running the runtime check");
  let smoke;
  try {
    smoke = await runSmoke({ config, repoRoot });
  } catch (error) {
    smoke = { ok: false, results: [], error: error.message };
  } finally {
    smokeProgress.stop();
  }
  if (smoke.ok) {
    output.success("Runtime check passed");
  } else {
    output.warn("Runtime check did not pass; setup will still complete.");
    output.info(`You can re-run the check any time with ${formatCommand("runtime-smoke")}.`);
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
  checks = normalizeDoctorChecks(checks);

  for (const check of checks) renderDoctorCheckLine(check, output);
  // A warning must never fail onboarding: the gate keys off `state`, so only a `fail` blocks.
  const doctorGreen = checks.length > 0 && checks.every((check) => check.state !== "fail");
  if (doctorGreen) {
    output.success("Setup verified.");
  } else {
    output.error({
      what: "Some setup checks need attention",
      fix: `fix the checks above, then re-run ${formatCommand("init")} (setup is resumable).`,
    });
  }
  return { ok: doctorGreen, smokeOk: Boolean(smoke.ok), doctorOk: doctorGreen };
}

// Back-compat alias for the shared launcher-form helper (now `formatCommand` in
// operator-output.mjs). Re-exported under the original name so existing call sites and the
// source-pinning tests stay green; new code should import `formatCommand` directly.
export const factoryLauncherCommand = formatCommand;

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
    output.warn(`Setup is resumable — fix the checks above and re-run ${formatCommand("init")}.`);
    process.exitCode = 1;
    return gate;
  }
  output.done(commandOptions.runGithubPhase ? "Setup complete." : `${commandOptions.readyLabel} connected.`);
  output.nextSteps([
    'Move a Linear project to "Planned" to start your first run',
    { text: factoryLauncherCommand("gateway start"), hint: "open your factory for business (polls Linear; Ctrl-C to stop)" },
    { text: factoryLauncherCommand("doctor"), hint: "re-check everything's healthy" },
    { text: "Local Phoenix (traces)", hint: phoenixAppUrl || `run ${formatCommand("phoenix:start")}` },
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
      log("Authorizing grants Teami read/write access to the entire selected Linear workspace; Linear has no narrower scope.");
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
  const value = env.TEAMI_EXPECTED_WORKSPACE;
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
    process.env.TEAMI_DOMAIN_NAME,
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
