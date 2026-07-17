import { createInterface } from "node:readline/promises";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

import { readLinearCache, writeLinearCache } from "../cache.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import {
  ensureTrustedClaudeMarketplace,
  readClaudePluginHealth,
} from "../claude-plugin-health.mjs";
import { normalizeDoctorChecks } from "../doctor-check.mjs";
import { buildTeamContext } from "../team-resolver.mjs";
import {
  createAtomicTeamRegistryWriter,
  emptyTeamRegistry,
  readTeamRegistry,
  upsertTeamRecord,
  updateTeamRegistry,
  writeTeamRegistry,
} from "../team-registry.mjs";
import {
  defaultRunCommand,
  ghJsonWithAmbientAuth,
  readGitHubConnectionState,
  runGitHubInitPhase,
} from "../github-setup.mjs";
import {
  authorizeOneShotLinearAdmin,
  createLinearSetupGraphqlClient,
} from "../linear-setup-auth.mjs";
import {
  declaredWorkspaceFromResumeTeam,
  isWorkspaceMismatchError,
  knownRegistryWorkspaces,
  resolveLinearSetupWorkspace,
  setupCompleteTeamForName,
  setupIncompleteTeamForName,
  setupLinearTeam,
  verifyDeclaredWorkspace,
  workspaceLabel,
} from "../linear-service.mjs";
import { createLinearCredentialStore } from "../linear-credential-store.mjs";
import {
  ensurePhoenixReady,
} from "../local-phoenix-manager.mjs";
import {
  runLocalPhoenixTracePreflight,
} from "../local-phoenix-trace-sink.mjs";
import { isLinearOAuthWaitEscapedError } from "../linear-oauth.mjs";
export {
  OAUTH_CALLBACK_LISTENER,
  oauthFirewallHint,
} from "../linear-oauth.mjs";
import { runRuntimeSmokeChecks } from "../runtime-smoke.mjs";
import {
  DEFAULT_SETUP_TEAM_NAME,
  SETUP_DISCLOSURE_HASH,
  SETUP_DISCLOSURE_VERSION,
  createSetupStateStore,
  isSetupOwnerAlive,
  runSetupCompletionContract,
  setupEffectsDisclosure,
  verifySetupConsent,
} from "../setup-orchestrator.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { doctorGraphqlLinear } from "./doctor-command.mjs";
import { renderFirstRunUx } from "./first-run-ux.mjs";
import { renderDoctorCheckLine } from "./doctor-report.mjs";
import { parseCliFlags } from "./flags.mjs";
import {
  configWithGithubFlags,
  githubFailureTitle,
  githubSetupTransportFromFlags,
} from "./github-command-options.mjs";
import { homeStateProbe } from "./home-state.mjs";
import {
  createBootstrapLinearCredentialStore,
  promoteSetupCredentialToTeam,
} from "./local-setup-cleanup.mjs";
import {
  completeTeamTeamMissingRecoveryFromError,
  formatCommand,
} from "./operator-output.mjs";
import {
  gitRepoResourceId,
  registerGitRepoResourceKind,
} from "../../../git/git-repo-materializer.mjs";

const GITHUB_REPO_DISCOVERY_LIMIT = 50;
const PACKAGED_CLAUDE_PLUGIN_MANIFEST_PATH = path.resolve(
  import.meta.dirname,
  "../../../../../.claude-plugin/plugin.json",
);
const PROJECT_NEEDS_PRINCIPAL_STATUS_NAME = "Principal Escalation";
const PROJECT_NEEDS_PRINCIPAL_STATUS_TYPE = "planned";
const PROJECT_NEEDS_PRINCIPAL_STATUS_COLOR = "#F2994A";
const PROJECT_PLANNED_STATUS_NAME = "Planned";
const PROJECT_STATUS_POSITION_INCREMENT = 0.01;
const PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR_CODE = "PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR";
const CLAUDE_PLUGIN_NAME = "teami";
const CLAUDE_PLUGIN_MARKETPLACE = "teami";
const CLAUDE_PLUGIN_SCOPE = "user";
const PUBLISHED_CLAUDE_PLUGIN_MARKETPLACE_SOURCE = "https://github.com/shulmansj/teami";
const ADMIN_REVOCATION_REPAIR = "open Linear Settings -> Applications and revoke Teami access. Linear cannot prove revocation of a lost token through a fresh token, so Teami will not clear this marker automatically. After external revocation, uninstall the blocked local state and start setup again.";

const LINEAR_SETUP_COMMAND_OPTIONS = Object.freeze({
  "team:add": {
    intro: "Teami will add a team to the same factory and learning loop, then ask Linear for read/write browser authorization for that team's workspace. If Principal Escalation is missing, setup asks once for admin approval to create that one project status.",
    prompt: "Linear team name: ",
    readyLabel: "Team",
    runGithubPhase: false,
  },
  init: {
    intro: "Teami will ask Linear for read/write browser authorization to verify setup and post project updates. If Principal Escalation is missing, setup asks once for admin approval to create that one project status. No API key is required.",
    prompt: "Linear team name: ",
    readyLabel: "First team",
    runGithubPhase: true,
  },
});

export async function runLinearSetupCommand({ context, command, args }) {
  const output = context?.output || createCliOutput();
  const home = context?.home || resolveTeamiHome();
  // Reject malformed flags before asking for authority; validation itself has no effects.
  const { flags: setupFlags } = parseCliFlags(args || []);
  explicitWorkspaceExpectation(setupFlags, process.env);
  const consent = await confirmCliSetupEffects({ context, output });
  if (!consent.ok) {
    process.exitCode = 1;
    return consent;
  }
  const setupStore = context?.setupStateStore || createSetupStateStore({ home });
  let existingAdminMarker = setupStore.readAdminRevocationRequirement?.() ||
    setupStore.readGlobalAdminRevocationRequired?.();
  if (existingAdminMarker && setupFlags["repair-admin-revocation"] === true) {
    output.error({
      what: "The prior Linear admin token cannot be verified from Teami",
      why: "Revoking a fresh token would revoke only that token, not prove the interrupted token is gone.",
      fix: ADMIN_REVOCATION_REPAIR,
    });
    process.exitCode = 1;
    return { ok: false, status: "blocked", reason: "prior_admin_revocation_not_verifiable" };
  }
  if (existingAdminMarker) {
    output.error({
      what: "One-time Linear admin revocation is unverified",
      why: "Teami will not start or claim setup complete while a prior admin grant may still be active.",
      fix: ADMIN_REVOCATION_REPAIR,
    });
    process.exitCode = 1;
    return { ok: false, status: "blocked", reason: "admin_revocation_required" };
  }
  if (["init", "team:add"].includes(command)) {
    return runCliSharedOnboarding({
      context: { ...(context || {}), output, home, setupStateStore: setupStore },
      command,
      args,
      output,
      consent,
    });
  }
  const setupLock = setupStore.acquire({ purpose: "setup" });
  if (!setupLock.ok) {
    output.error({
      what: "Another Teami setup is already in progress",
      why: "CLI and conversational setup share one exclusive setup writer.",
      fix: "wait for the other setup to finish, then retry this command.",
    });
    process.exitCode = 1;
    return { ok: false, status: "blocked", reason: "setup_lock_held", lock_reason: setupLock.reason || null };
  }
  try {
    const activeSetup = setupStore.findActive?.();
    if (activeSetup) {
      output.error({
        what: "A conversational setup is waiting for authorization",
        why: "Teami keeps one setup owner at a time so CLI and conversational setup cannot interleave effects.",
        fix: `resume setup ${activeSetup.setup_id} in the agent, or wait for that authorization session to expire.`,
      });
      process.exitCode = 1;
      return {
        ok: false,
        status: "blocked",
        reason: "setup_session_active",
        setup_id: activeSetup.setup_id,
      };
    }
    const result = await runLinearSetupCommandImpl({
      context: { ...(context || {}), output, home, setupStateStore: setupStore },
      command,
      args,
    });
    if (setupStore.readGlobalAdminRevocationRequired?.()) {
      output.error({
        what: "One-time Linear admin revocation could not be verified",
        why: "The admin token was discarded, but Teami did not receive proof that remote revocation succeeded.",
        fix: ADMIN_REVOCATION_REPAIR,
      });
      process.exitCode = 1;
      return { ok: false, status: "blocked", reason: "admin_revocation_required" };
    }
    return result;
  } catch (error) {
    const recovery = completeTeamTeamMissingRecoveryFromError(error);
    if (!recovery) throw error;
    output.error({
      what: recovery.what,
      why: recovery.why,
      fix: recovery.fix,
    });
    process.exitCode = 1;
    return { ok: false, status: "blocked", reason: recovery.code || "linear_setup_failed" };
  } finally {
    setupLock.release();
  }
}

async function runCliSharedOnboarding({ context, command = "init", args, output, consent } = {}) {
  const { config, repoRoot, home, setupStateStore } = context;
  const active = setupStateStore.findActive?.();
  if (active && isSetupOwnerAlive(active) !== false) {
    output.error({
      what: "A conversational setup is waiting for authorization",
      why: "Teami keeps one setup owner at a time so CLI and conversational setup cannot interleave effects.",
      fix: `resume setup ${active.setup_id} in the agent, or wait for that authorization session to expire.`,
    });
    process.exitCode = 1;
    return { ok: false, status: "blocked", reason: "setup_session_active", setup_id: active.setup_id };
  }
  const { flags } = parseCliFlags(args || []);
  const registry = readTeamRegistry({ home }) || emptyTeamRegistry();
  const resolution = resolveSetupCommandTeamNameHint(args || [], registry);
  const initOnlyResumeTeam = command === "init"
    ? resolveGitHubPhaseResumeTeam({ args: args || [], registry, repoRoot, home }) ||
      resolveClaudePluginPhaseResumeTeam({ args: args || [], registry, repoRoot, home }) || null
    : null;
  const implicitResumeTeam = resolution.completeResumeTeam || resolution.resumeTeam || initOnlyResumeTeam;
  const teamName = resolution.teamNameHint ||
    (implicitResumeTeam ? teamNameForResumeTeam(implicitResumeTeam) : null) ||
    await resolveInitTeamName(args || [], {
      command,
      registry,
      isTTY: "isTTY" in context
        ? Boolean(context.isTTY)
        : Boolean(process.stdin.isTTY && process.stdout.isTTY),
      prompt: context.promptTeamName || promptLine,
    });
  const promptedResolution = implicitResumeTeam
    ? null
    : resolveSetupCommandTeamNameHint([
        "--team",
        teamName,
        ...(flags.workspace ? ["--workspace", flags.workspace] : []),
      ], registry);
  const resumeTeam = implicitResumeTeam || promptedResolution?.resumeTeam ||
    promptedResolution?.completeResumeTeam || null;
  const workspaceHint = flags.workspace || resumeTeam?.linear?.workspace_id ||
    null;
  // Onboarding never adds product-repository access. The shared setup service preserves
  // resources already recorded on a complete-team repair without accepting a new allowlist.
  const repoIntent = { mode: "non_code" };

  const {
    createProjectMcpToolActions: defaultCreateProjectMcpToolActions,
    ProjectMcpToolError,
  } = await import("../project-mcp-tools.mjs");
  const createProjectMcpToolActions = context.createProjectMcpToolActions ||
    defaultCreateProjectMcpToolActions;
  const actionOptions = {
    repoRoot,
    config,
    home,
    setupStateStore,
    setupSurface: "cli",
    ...(context.createLinearSetupAuth ? { createLinearSetupAuth: context.createLinearSetupAuth } : {}),
    ...(context.startLinearBrowserAuthorization
      ? { startLinearBrowserAuthorization: context.startLinearBrowserAuthorization }
      : {}),
    ...(context.authorizeOneShotLinearAdmin
      ? {
          authorizeOneShotAdmin: async () => {
            throw new ProjectMcpToolError(
              "admin_consent_required",
              "Explicit just-in-time confirmation is required before one-shot Linear admin authorization.",
            );
          },
        }
      : {}),
    ...(context.startOneShotLinearAdminAuthorization
      ? { startOneShotAdminAuthorization: context.startOneShotLinearAdminAuthorization }
      : context.authorizeOneShotLinearAdmin
        ? {
            startOneShotAdminAuthorization: async (options) => ({
              authorizationUrl: "https://linear.app/settings/api/applications",
              expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
              browser: { opened: true, reason: null },
              waitForGrant: () => context.authorizeOneShotLinearAdmin(options),
              close() {},
            }),
          }
        : {}),
    ...(context.openBrowser ? { openBrowser: context.openBrowser } : {}),
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.runGitHubInitPhase ? { runGitHubPhase: context.runGitHubInitPhase } : {}),
    ...(context.githubInitTransportFromFlags
      ? { githubInitTransportFromFlags: context.githubInitTransportFromFlags }
      : {}),
    ...(context.githubSetupTransport ? { githubSetupTransport: context.githubSetupTransport } : {}),
    githubDiscoveryRunCommand: context.githubDiscoveryRunCommand || context.runCommand || null,
    ...(context.runGit ? { runGit: context.runGit } : {}),
    ...(context.runClaudePluginRegistrationStep
      ? { runClaudePluginRegistration: context.runClaudePluginRegistrationStep }
      : {}),
    ...(context.claudePluginRunCommand ? { claudePluginRunCommand: context.claudePluginRunCommand } : {}),
    claudePluginMarketplaceSource: context.claudePluginMarketplaceSource ||
      PUBLISHED_CLAUDE_PLUGIN_MARKETPLACE_SOURCE,
    ...(context.ensurePhoenixReady ? { ensurePhoenix: context.ensurePhoenixReady } : {}),
    ...(context.runLocalPhoenixTracePreflight
      ? { runPhoenixPreflight: context.runLocalPhoenixTracePreflight }
      : {}),
  };
  if (context.finalGate && !context.runSmoke && !context.runDoctor) {
    let gatePromise = null;
    const gate = () => {
      gatePromise ||= context.finalGate({ config, repoRoot, home });
      return gatePromise;
    };
    actionOptions.runRuntimeSmoke = async () => {
      const result = await gate();
      return { ok: result?.smokeOk ?? result?.ok ?? false, results: [] };
    };
    actionOptions.runSetupDoctor = async () => {
      const result = await gate();
      return [{
        name: "injected final gate",
        ok: result?.doctorOk ?? result?.ok ?? false,
        message: result?.ok ? "verified" : "failed",
      }];
    };
    actionOptions.ensurePhoenix = async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      collectorUrl: "http://127.0.0.1:6006/v1/traces",
    });
    actionOptions.runPhoenixPreflight = async () => ({ ok: true, traceId: "injected-final-gate" });
  } else {
    if (context.runSmoke) actionOptions.runRuntimeSmoke = context.runSmoke;
    if (context.runDoctor) actionOptions.runSetupDoctor = context.runDoctor;
  }
  let waitProgress = null;
  let finishProgress = null;
  actionOptions.onSetupProgress = ({ message } = {}) => {
    waitProgress?.stop?.();
    waitProgress = null;
    finishProgress ||= output.progress(message || "Authorization approved; finishing setup");
  };
  const actions = createProjectMcpToolActions(actionOptions);
  // Each provider/subprocess operation owns a bounded timeout. Do not race the
  // shared setup action with an uncancellable timer: that could tell the adopter
  // setup stopped while the same action continued making approved changes.
  const callOnboarding = (input) => actions.init_onboarding(input);
  let result = await callOnboarding({
    team: teamName,
    ...(workspaceHint ? { workspace: workspaceHint } : {}),
    repo_intent: repoIntent,
    ...(flags["github-owner"] ? { github_owner: flags["github-owner"] } : {}),
    ...(flags["github-repo"] ? { github_repo: flags["github-repo"] } : {}),
    ...(flags["github-dry-run"] === true ? { github_dry_run: true } : {}),
    confirm: true,
    disclosure_version: consent.version,
    disclosure_hash: consent.hash,
  });
  const shownUrls = new Set();
  const shownRecoveries = new Set();
  const authorizationWaitStartedAt = Date.now();
  const installedAppRecoveryDelayMs = context.installedAppRecoveryDelayMs ?? 15_000;
  const pollDeadline = Date.now() + (context.authorizationPollTimeoutMs || 15 * 60 * 1000);
  while (["awaiting_authorization", "admin_consent_required", "team_selection_required"].includes(result?.status)) {
    if (Date.now() >= pollDeadline) {
      const timedOutSetupId = result?.setup_id || null;
      if (timedOutSetupId) {
        try {
          setupStateStore.recordPhase(timedOutSetupId, "linear", {
            status: "blocked",
            reason: "cli_authorization_poll_timeout",
            setupStatus: "blocked",
          });
        } catch {
          // The blocked result below remains truthful even if local persistence failed.
        }
      }
      result = {
        ok: false,
        status: "blocked",
        setup_id: timedOutSetupId,
        reason: `cli_authorization_poll_timeout:${result?.authorization?.kind || result?.status || "unknown"}`,
        repair: `Re-run ${formatCommand(command === "team:add" ? "team add" : "init")} for a fresh authorization session.`,
      };
      break;
    }
    if (result.authorization_url && !shownUrls.has(result.authorization_url)) {
      shownUrls.add(result.authorization_url);
      output.info(`Linear authorization: ${result.authorization_url}`);
    }
    const installedAppRecovery = result?.recovery?.installed_app;
    if (installedAppRecovery && Date.now() - authorizationWaitStartedAt >= installedAppRecoveryDelayMs &&
        !shownRecoveries.has(installedAppRecovery)) {
      shownRecoveries.add(installedAppRecovery);
      output.warn(installedAppRecovery);
    }
    if (result.status === "team_selection_required") {
      waitProgress?.stop?.();
      waitProgress = null;
      finishProgress?.stop?.();
      finishProgress = null;
      const team = await promptCliLinearTeamSelection({
        result,
        output,
        isTTY: "isTTY" in context
          ? Boolean(context.isTTY)
          : Boolean(process.stdin.isTTY && process.stdout.isTTY),
        prompt: context.promptLinearTeamSelection || promptLine,
      });
      if (!team) break;
      result = await callOnboarding({
        setup_id: result.setup_id,
        linear_team_id: team.id,
        linear_team_confirm: true,
      });
      continue;
    }
    if (result.status === "admin_consent_required") {
      waitProgress?.stop?.();
      waitProgress = null;
      finishProgress?.stop?.();
      finishProgress = null;
      const answer = await (context.promptAdminProvisioning || promptLine)(
        "Type YES to approve the one-time Linear admin grant now: ",
      );
      if (String(answer || "").trim() !== "YES") {
        setupStateStore.recordPhase(result.setup_id, "linear", {
          status: "blocked",
          reason: "one_shot_admin_consent_declined",
          setupStatus: "blocked",
        });
        process.exitCode = 1;
        return { ...result, ok: false, status: "blocked", reason: "one_shot_admin_consent_declined" };
      }
      result = await callOnboarding({ setup_id: result.setup_id, admin_confirm: true });
      continue;
    }
    waitProgress ||= output.progress("Waiting for browser approval; setup will continue automatically");
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await callOnboarding({ setup_id: result.setup_id });
  }
  waitProgress?.stop?.();
  finishProgress?.stop?.();
  for (const line of result?.progress || []) output.detail(line);
  renderCliSetupResult({ result, output });
  if (result?.ok) {
    output.done("Teami is ready.");
    output.nextSteps([
      { text: "Open a new Claude Code session", hint: "then run /teami:plan" },
    ]);
    process.exitCode = 0;
  } else {
    const diagnosis = cliSetupFailureDiagnosis(result);
    output.error({
      what: "Setup remains incomplete",
      why: diagnosis.why,
      fix: diagnosis.fix,
    });
    process.exitCode = 1;
  }
  return result;
}

async function promptCliLinearTeamSelection({ result, output, isTTY, prompt } = {}) {
  const teams = Array.isArray(result?.teams) ? result.teams : [];
  output.warn("Linear can't create another team on this workspace plan.");
  output.info("Teami can use one existing team instead. It will add or reconcile Teami labels and workflow statuses in that team; it will not delete existing issues or projects.");
  output.info("Choose a dedicated or unused team if possible. Selecting a number approves these changes for that team.");
  teams.forEach((team, index) => output.info(`${index + 1}. ${team.name}${team.key ? ` (${team.key})` : ""}`));
  output.info("0. Stop setup");
  if (!isTTY || teams.length === 0) {
    output.info(`Run ${formatCommand("init")} in an interactive terminal to return to this choice.`);
    return null;
  }
  for (;;) {
    const answer = String(await prompt(`Choose a team for Teami (0-${teams.length}): `) || "").trim();
    if (answer === "0" || answer === "") {
      output.info(`Setup is still resumable. Run ${formatCommand("init")} to return to this choice.`);
      return null;
    }
    if (/^\d+$/.test(answer)) {
      const index = Number(answer) - 1;
      if (index >= 0 && index < teams.length) return teams[index];
    }
    output.warn(`Enter a number from 0 to ${teams.length}.`);
  }
}

export function renderCliSetupResult({ result, output } = {}) {
  const steps = result?.steps;
  if (!steps || typeof steps !== "object") return;

  if (steps.linear?.ok) {
    const workspace = steps.linear.workspace?.name || steps.linear.workspace?.id;
    output.success(`Linear connected${workspace ? `: ${workspace}` : ""}`);
  }

  if (steps.product_repos?.ok) {
    const repos = Array.isArray(steps.product_repos.repos) ? steps.product_repos.repos : [];
    output.success(repos.length === 0
      ? "Product repositories: none"
      : `Product repositories retained: ${repos.map((repo) => `${repo.owner}/${repo.repo}`).join(", ")}`);
  }

  if (steps.github?.ok) {
    const repo = steps.github.repo?.full_name;
    output.success(`Private GitHub workspace ready${repo ? `: ${repo}` : ""}`);
  }
  if (steps.plugin?.ok) output.success("Claude Code integration installed");
  else if (steps.plugin) {
    output.warn(`Claude Code integration: ${steps.plugin.detail || steps.plugin.reason || "not ready"}`);
    if (steps.plugin.repair) output.info(steps.plugin.repair);
  }
  if (steps.phoenix?.ok) {
    output.success("Local traces ready");
    if (steps.phoenix.app_url) output.detail(`Local trace viewer: ${steps.phoenix.app_url}`);
  }
  else if (steps.phoenix) output.warn(`Local traces: ${steps.phoenix.repair || steps.phoenix.reason || "not ready"}`);
  if (steps.runtime?.ok) output.success("Agent runtimes ready");
  else if (steps.runtime) {
    output.warn(`Agent runtimes: ${steps.runtime.detail || steps.runtime.reason || "not ready"}`);
    if (steps.runtime.repair) output.info(steps.runtime.repair);
  }
  if (steps.doctor) {
    const doctorWarnings = (steps.doctor.checks || []).filter((check) => check.state !== "ok");
    for (const check of doctorWarnings) {
      output.warn(`${check.name}: ${check.message || check.repair || check.state || "failed"}`);
      if (check.repair && check.repair !== check.message) output.info(check.repair);
    }
    if (!steps.doctor.ok && doctorWarnings.length === 0) {
      output.warn(`Final health: ${steps.doctor.detail || steps.doctor.reason || "not ready"}`);
      if (steps.doctor.repair) output.info(steps.doctor.repair);
    }
    if (steps.doctor.ok && result?.ok) {
      output.success(doctorWarnings.length > 0
        ? "Final health check passed with warnings"
        : "Final health check passed");
    } else if (steps.doctor.ok) {
      output.detail("Other health checks passed; setup still has an incomplete step above.");
    }
  }
}

export function cliSetupFailureDiagnosis(result = {}) {
  const steps = result.steps || {};
  const failedDoctorChecks = (steps.doctor?.checks || []).filter((check) => check.state === "fail");
  const phaseFailure = [
    ["GitHub", steps.github],
    ["Claude Code integration", steps.plugin],
    ["Local traces", steps.phoenix],
    ["Agent runtimes", steps.runtime],
    ["Final health", steps.doctor],
  ].find(([, step]) => step && step.ok !== true);
  const fallbackFix = `Fix the named step above, then rerun ${formatCommand("init")}; completed steps are preserved.`;
  if (failedDoctorChecks.length > 0) {
    return {
      why: `Health checks failed: ${failedDoctorChecks.map((check) =>
        `${check.name}${check.message ? ` (${check.message})` : ""}`).join(", ")}`,
      fix: failedDoctorChecks.find((check) => check.repair)?.repair || fallbackFix,
    };
  }
  if (phaseFailure) {
    const [name, step] = phaseFailure;
    return {
      why: `${name}: ${step.detail || step.message || step.reason || step.status || "not ready"}`,
      fix: step.repair || fallbackFix,
    };
  }
  return {
    why: result?.error?.message || result?.reason || result?.status || "setup_failed",
    fix: result?.error?.repair || result?.repair || fallbackFix,
  };
}

export async function confirmCliSetupEffects({ context = {}, output = createCliOutput() } = {}) {
  const disclosure = setupEffectsDisclosure();
  (output.heading || output.section).call(output, "Welcome to Teami");
  output.info("Teami runs on this computer. Before setup starts, here is what it will change:");
  output.info("- Connect your Linear workspace with read/write access and create the Teami planning workflow.");
  output.info("- If your plan cannot add the dedicated Teami team, stop and ask before configuring an existing team you select.");
  output.info("- If one required Linear status is missing, ask separately for one-time admin approval; Teami never stores that access and blocks if revocation cannot be verified.");
  output.info("- Create or connect a private GitHub repository for Teami's own configuration and improvement proposals, using your signed-in GitHub account.");
  output.info("- Install the Claude Code integration and keep setup and trace data on this computer.");
  output.info("- Add no product-repository access. A repair preserves connections you approved previously, but setup will not use or expand them.");
  output.detail(`Disclosure ${disclosure.version} (${disclosure.hash})`);
  for (const effect of disclosure.effects) {
    output.detail(effect.title);
    output.detail(`Change: ${effect.detail}`);
    output.detail(`Approval: ${effect.authority}`);
    output.detail(`Kept after setup: ${effect.retention}`);
  }

  let confirmed = false;
  if (typeof context.confirmSetupEffects === "function") {
    confirmed = await context.confirmSetupEffects(disclosure) === true;
  } else {
    const isTTY = "isTTY" in context
      ? Boolean(context.isTTY)
      : Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (isTTY) {
      const answer = await (context.promptSetupEffects || promptLine)(
        "Continue? [y/N]: ",
      );
      confirmed = ["y", "yes"].includes(String(answer || "").trim().toLowerCase());
    }
  }

  const consent = verifySetupConsent({
    confirm: confirmed,
    disclosureVersion: SETUP_DISCLOSURE_VERSION,
    disclosureHash: SETUP_DISCLOSURE_HASH,
  });
  if (!consent.ok) {
    output.error({
      what: "Setup effects were not confirmed",
      why: "Teami changes Linear, GitHub, Claude plugin, and local runtime state only after explicit disclosure-bound consent.",
      fix: "run setup from an interactive terminal and answer yes after reviewing the changes.",
    });
  }
  return consent;
}

async function runLinearSetupCommandImpl({ context, command, args }) {
  const { config, repoRoot, home = resolveTeamiHome(), cachePath, output = createCliOutput() } = context;
    const commandOptions = LINEAR_SETUP_COMMAND_OPTIONS[command] || LINEAR_SETUP_COMMAND_OPTIONS.init;
    const initArgs = args;
    const { flags: initFlags } = parseCliFlags(initArgs);
    const registry = readTeamRegistry({ home }) || emptyTeamRegistry();
    const teamNameResolution = resolveSetupCommandTeamNameHint(initArgs, registry);
    const teamNameHint = teamNameResolution.teamNameHint;
    const completeResumeTeam = teamNameResolution.completeResumeTeam || null;
    const incompleteResumeTeam = teamNameResolution.resumeTeam || null;
    const resumeCredentialTeam = completeResumeTeam ||
      (teamHasLinearCredentialIdentity(incompleteResumeTeam) ? incompleteResumeTeam : null);
    const resumeContext = resumeCredentialTeam
      ? buildTeamContext({ team: resumeCredentialTeam, config, repoRoot, home })
      : null;
    const githubResumeTeam = commandOptions.runGithubPhase
      ? resolveGitHubPhaseResumeTeam({ args: initArgs, registry, repoRoot, home })
      : null;
    const claudePluginResumeTeam = commandOptions.runGithubPhase && !githubResumeTeam
      ? resolveClaudePluginPhaseResumeTeam({ args: initArgs, registry, repoRoot, home })
      : null;
    const credentialStore = resumeContext
      ? createLinearCredentialStore({ config, repoRoot, home, teamContext: resumeContext })
      : createBootstrapLinearCredentialStore({ config, repoRoot, home });
    const obsoleteBootstrapStore = !completeResumeTeam && resumeContext
      ? createBootstrapLinearCredentialStore({ config, repoRoot, home })
      : null;
    const obsoleteBootstrapToken = obsoleteBootstrapStore
      ? await obsoleteBootstrapStore.readTokenSet()
      : null;
    const totalSteps = commandOptions.runGithubPhase ? 3 : 1;
    const authorizeOneShotAdmin = createCliOneShotAdminAuthorization({ context });
    output.heading(`Teami ${output.symbols.separator} setup`);
    output.detail(commandOptions.intro);
    if (githubResumeTeam) {
      output.step(1, totalSteps, "Connect Linear");
      output.info(
        `Linear already connected for team "${teamNameForResumeTeam(githubResumeTeam)}" in workspace ${workspaceLabel(githubResumeTeam.linear)}.`,
      );
      output.success(`Workspace: ${workspaceLabel(githubResumeTeam.linear)}`);
      output.success(`Team "${githubResumeTeam.linear?.team_name || teamNameForResumeTeam(githubResumeTeam)}" already connected`);
      output.info("Linear connected.");
      const githubOk = await runGitHubInitStep({
        repoRoot,
        home,
        config,
        initFlags,
        output,
        totalSteps,
      });
      if (!githubOk) return;
      const claudePluginOk = await runClaudePluginInitStep({ context, repoRoot, output, totalSteps });
      if (!claudePluginOk) return;
      const phoenix = await runCliPhoenixSetupPhase({
        context,
        repoRoot,
        output,
        teamContext: buildTeamContext({ team: githubResumeTeam, config, repoRoot, home }),
      });
      await finishSetupOutput({
        output,
        commandOptions,
        phoenixAppUrl: phoenix.appUrl,
        phoenixOk: phoenix.ok,
        config,
        repoRoot,
        home,
        cachePath,
        teamRef: githubResumeTeam.id,
        finalGate: context.finalGate,
        runSmoke: context.runSmoke,
        runDoctor: context.runDoctor,
      });
      return;
    }
    if (claudePluginResumeTeam) {
      output.step(1, totalSteps, "Connect Linear");
      output.info(
        `Linear already connected for team "${teamNameForResumeTeam(claudePluginResumeTeam)}" in workspace ${workspaceLabel(claudePluginResumeTeam.linear)}.`,
      );
      output.success(`Workspace: ${workspaceLabel(claudePluginResumeTeam.linear)}`);
      output.success(`Team "${claudePluginResumeTeam.linear?.team_name || teamNameForResumeTeam(claudePluginResumeTeam)}" already connected`);
      output.info("Linear connected.");
      output.step(2, totalSteps, "Connect GitHub");
      output.info("GitHub already connected.");
      output.info("GitHub connected.");
      const claudePluginOk = await runClaudePluginInitStep({ context, repoRoot, output, totalSteps });
      if (!claudePluginOk) return;
      const phoenix = await runCliPhoenixSetupPhase({
        context,
        repoRoot,
        output,
        teamContext: buildTeamContext({ team: claudePluginResumeTeam, config, repoRoot, home }),
      });
      await finishSetupOutput({
        output,
        commandOptions,
        phoenixAppUrl: phoenix.appUrl,
        phoenixOk: phoenix.ok,
        config,
        repoRoot,
        home,
        cachePath,
        teamRef: claudePluginResumeTeam.id,
        finalGate: context.finalGate,
        runSmoke: context.runSmoke,
        runDoctor: context.runDoctor,
      });
      return;
    }
    output.step(1, totalSteps, commandOptions.runGithubPhase ? "Connect Linear" : "Connect Linear team");
    if (credentialStore.warning) output.warn(credentialStore.warning);
    if (teamNameResolution.resumeTeam) {
      output.info(
        `Resuming incomplete setup for team "${teamNameHint}" in Linear workspace ${workspaceLabel(teamNameResolution.resumeTeam.linear)}.`,
      );
      if (teamNameResolution.resumeTeam.setup_incomplete_cause) {
        output.info(`Previous setup stopped at: ${teamNameResolution.resumeTeam.setup_incomplete_cause}`);
      }
    } else if (completeResumeTeam) {
      output.info(
        `Refreshing existing team "${teamNameForResumeTeam(completeResumeTeam)}" in Linear workspace ${workspaceLabel(completeResumeTeam.linear)}.`,
      );
    }
    explicitWorkspaceExpectation(initFlags, process.env);
    const teamName = teamNameHint || await resolveInitTeamName(initArgs, { command });
    const authorizationRegistry = registryWithoutRemovedTeamsForName(registry, teamName);
    const linearProgress = createLinearSetupProgress(output);
    const isTTY = "isTTY" in context
      ? Boolean(context.isTTY)
      : Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const workspaceAuthorization = await authorizeLinearSetupWorkspace({
      config,
      repoRoot,
      credentialStore,
      registry: authorizationRegistry,
      flags: initFlags,
      env: process.env,
      teamNameHint,
      resumeTeam: teamNameResolution.resumeTeam || completeResumeTeam,
      isTTY,
      log: linearProgress,
      createSetupAuth: context.createLinearSetupAuth || createLinearSetupGraphqlClient,
      authorizeOneShotAdmin,
      promptAdminProvisioning: context.promptAdminProvisioning || promptLine,
      promptReauthorize: context.promptReauthorize || promptLinearReauthorization,
    });
    output.success(`Workspace: ${workspaceLabel(workspaceAuthorization.workspace)}`);
    output.detail(`workspace_id=${workspaceAuthorization.workspace.id}`);
    output.detail("Linear setup authorization verified.");

    const repoAllowlistSelection = completeResumeTeam
      ? {
          confirmed: false,
          selectedRepos: [],
          discoveredRepos: [],
          reason: "complete_resume_repo_allowlist_skipped",
        }
      : await discoverAndConfirmTeamGitHubRepos({
          command,
          output,
          runCommand: context.githubDiscoveryRunCommand || context.runCommand || defaultRunCommand,
          prompt: context.githubRepoAllowlistPrompt || promptLine,
          isTTY,
        });

    const setupCache = setupCacheWithNeedsPrincipalStatus({
      cache: resumeContext ? readLinearCache(resumeContext.linear.cachePath) : null,
      status: workspaceAuthorization.needsPrincipalProjectStatus,
    });

    const result = await setupLinearTeam({
      client: workspaceAuthorization.setupAuth.client,
      config,
      registry,
      repoRoot,
      home,
      teamName,
      cache: setupCache,
      resumeTeam: completeResumeTeam || teamNameResolution.resumeTeam || null,
      workspace: workspaceAuthorization.workspace,
      declaredWorkspace: workspaceAuthorization.declaredWorkspace,
      ensureNeedsPrincipalProjectStatus: () => ensureNeedsPrincipalProjectStatus({
        appClient: workspaceAuthorization.setupAuth.client,
        adminAuth: () => authorizeOneShotAdmin({
          config,
          onProgress: (line) => linearProgress(line),
        }),
        log: linearProgress,
        interactive: isTTY,
        prompt: context.promptAdminProvisioning || promptLine,
      }),
      writeCache: (nextCache, context) => {
        writeLinearCache(context.linear.cachePath, nextCache);
      },
      writeRegistry: createAtomicTeamRegistryWriter({ home, initialRegistry: registry }),
      promoteCredential: resumeContext
        ? async () => {
            if (obsoleteBootstrapToken) {
              await obsoleteBootstrapStore.deleteTokenSetIfEqual(obsoleteBootstrapToken);
            }
          }
        : ({ context }) =>
            promoteSetupCredentialToTeam({
              setupCredentialStore: credentialStore,
              config,
              repoRoot,
              home,
              teamContext: context,
            }),
      onPreview: (line) => output.detail(line),
    });
    printSummary(result.summary, output);
    if (repoAllowlistSelection.confirmed) {
      const repoAllowlistUpdate = await persistTeamGitHubRepoAllowlist({
        repoRoot,
        home,
        teamRef: result.team.id,
        repos: repoAllowlistSelection.selectedRepos,
      });
      result.team = repoAllowlistUpdate.team;
      result.registry = repoAllowlistUpdate.registry;
      result.context = buildTeamContext({
        team: result.team,
        config,
        repoRoot,
        home,
        behaviorRepoId: result.context?.trace?.behavior_repo_id,
      });
      if (repoAllowlistUpdate.resources.length === 0) {
        output.success("Repo allowlist: none (non-code team)");
      } else {
        output.success(`Repo allowlist: ${repoAllowlistUpdate.resources.map((resource) => repoLabel(resource.binding)).join(", ")}`);
      }
    } else if (completeResumeTeam) {
      output.detail("Repo allowlist unchanged; manage repo grants with team grant.");
    } else {
      output.detail("Repo allowlist unchanged; GitHub repo discovery was not confirmed.");
    }
    output.success(
      `Team "${result.team.linear?.team_name || teamName}" ${completeResumeTeam ? "ready" : "created"} (labels and statuses ready)`,
    );
    output.success("Local gateway ready for Planned projects");
    output.info("Linear connected.");
    output.detail(`${commandOptions.readyLabel} connected: ${result.team.id}`);
    if (commandOptions.runGithubPhase) {
      const githubOk = await runGitHubInitStep({
        repoRoot,
        home,
        config,
        initFlags,
        output,
        totalSteps,
        runGitHubPhase: context.runGitHubInitPhase,
        resolveTransport: context.githubInitTransportFromFlags,
      });
      if (!githubOk) return;
      const claudePluginOk = await runClaudePluginInitStep({ context, repoRoot, output, totalSteps });
      if (!claudePluginOk) return;
    }
    const phoenix = await runCliPhoenixSetupPhase({ context, repoRoot, output, teamContext: result.context });
    await finishSetupOutput({
      output,
      commandOptions,
      phoenixAppUrl: phoenix.appUrl,
      phoenixOk: phoenix.ok,
      config,
      repoRoot,
      home,
      cachePath,
      teamRef: result.team.id,
      finalGate: context.finalGate,
      runSmoke: context.runSmoke,
      runDoctor: context.runDoctor,
    });
    if (!result.ok) process.exitCode = 1;
}

async function runCliPhoenixSetupPhase({ context, repoRoot, output, teamContext } = {}) {
  const ready = await (context.ensurePhoenixReady || ensurePhoenixReady)({
    repoRoot,
    onProgress: (line) => output.detail(line),
  }).catch((error) => ({ ok: false, reason: error.message }));
  if (!ready.ok) {
    output.warn(`Local Phoenix is degraded: ${ready.reason || "unavailable"}`);
    if (ready.repairHint) output.detail(`Repair: ${ready.repairHint}`);
    return { ok: false, appUrl: null, reason: ready.reason || "phoenix_unavailable" };
  }

  output.detail(`Local Phoenix UI: ${ready.appUrl}`);
  output.detail(`Local Phoenix collector: ${ready.collectorUrl}`);
  const preflight = await (context.runLocalPhoenixTracePreflight || runLocalPhoenixTracePreflight)({
    repoRoot,
    ensureReady: async () => ready,
    teamContext,
  }).catch((error) => ({ ok: false, status: "trace_delivery_failed", reason: error.message }));
  if (!preflight.ok) {
    output.warn(`Local Phoenix trace preflight failed: ${preflight.reason || preflight.status || "unknown"}`);
    if (preflight.repairHint) output.detail(`Repair: ${preflight.repairHint}`);
    return {
      ok: false,
      appUrl: ready.appUrl || null,
      reason: preflight.reason || preflight.status || "phoenix_trace_preflight_failed",
    };
  }
  output.detail(`Local Phoenix preflight trace: ${preflight.traceId}`);
  return { ok: true, appUrl: ready.appUrl || null, reason: null };
}

function createCliOneShotAdminAuthorization({ context } = {}) {
  const authorize = context.authorizeOneShotLinearAdmin || authorizeOneShotLinearAdmin;
  const store = context.setupStateStore;
  return async (options = {}) => {
    if (!store?.markGlobalAdminRevocationRequired) throw new Error("setup_admin_marker_store_required");
    store.markGlobalAdminRevocationRequired({ surface: "cli" });
    const grant = await authorize(options);
    return {
      ...grant,
      async teardown() {
        const result = await grant.teardown?.();
        if (result?.revokeVerified === true) {
          store.clearGlobalAdminRevocationRequired({ revokeVerified: true });
        }
        return result;
      },
    };
  };
}

export async function runSetupGitHubRepoDiscoveryStep({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef,
  command = "init",
  output = createCliOutput(),
  runCommand = defaultRunCommand,
  prompt = promptLine,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  registry = null,
  writeRegistry = null,
} = {}) {
  const selection = await discoverAndConfirmTeamGitHubRepos({
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
  const persisted = await persistTeamGitHubRepoAllowlist({
    repoRoot,
    home,
    teamRef,
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

export async function discoverAndConfirmTeamGitHubRepos({
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
    discoveredRepos = await discoverGitHubRepos({ runCommand, limit });
  } catch (error) {
    output.warn(`GitHub repo discovery skipped: ${error.message}`);
    output.info(
      `Fix GitHub CLI auth with gh auth login --hostname github.com, then re-run ${formatCommand(command === "team:add" ? "team add" : "init")}.`,
    );
    return {
      confirmed: false,
      selectedRepos: [],
      discoveredRepos: [],
      reason: "github_repo_discovery_failed",
    };
  }

  if (discoveredRepos.length === 0) {
    output.info("No GitHub repos were found for this account. This team will start as a non-code team.");
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
    output.info("No repo selected. This team will start as a non-code team.");
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

export async function discoverGitHubRepos({
  runCommand = defaultRunCommand,
  limit = GITHUB_REPO_DISCOVERY_LIMIT,
} = {}) {
  const data = await ghJsonWithAmbientAuth({
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

export async function persistTeamGitHubRepoAllowlist({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef,
  repos = [],
  registry = null,
  writeRegistry = null,
} = {}) {
  if (!nonEmptyString(teamRef)) throw new Error("github_repo_allowlist_missing_team");
  registerGitRepoResourceKind();
  const resources = uniqueGitRepoResources(
    repos.map((repo) => gitRepoResourceFromBinding(gitHubRepoBinding(repo))),
  );
  if (registry === null && typeof writeRegistry !== "function") {
    const outcome = updateTeamRegistry({ home }, (currentRegistry) =>
      repoAllowlistRegistryUpdate(currentRegistry, { teamRef, resources }));
    return repoAllowlistUpdateResult(outcome);
  }
  const currentRegistry = registry || readTeamRegistry({ home });
  if (!currentRegistry) throw new Error("github_repo_allowlist_registry_missing");
  const outcome = repoAllowlistRegistryUpdate(currentRegistry, { teamRef, resources });
  const registryPath = await (writeRegistry || ((nextRegistry) =>
    writeTeamRegistry({ home }, nextRegistry)))(outcome.registry, currentRegistry);
  return repoAllowlistUpdateResult({ ...outcome, registryPath });
}

function repoAllowlistRegistryUpdate(currentRegistry, { teamRef, resources }) {
  const team = currentRegistry?.teams?.find((candidate) => candidate.id === teamRef);
  if (!currentRegistry) throw new Error("github_repo_allowlist_registry_missing");
  if (!team) throw new Error(`github_repo_allowlist_unknown_team:${teamRef}`);
  if (team.status === "removed") throw new Error(`github_repo_allowlist_team_removed:${teamRef}`);
  const updatedTeam = {
    ...structuredClone(team),
    resources: [
      ...(team.resources || []).filter((resource) => resource.kind !== "git_repo"),
      ...resources,
    ],
  };
  return {
    registry: upsertTeamRecord(currentRegistry, updatedTeam),
    resources,
    teamRef,
  };
}

function repoAllowlistUpdateResult(outcome) {
  return {
    team: outcome.registry.teams.find((candidate) => candidate.id === outcome.teamRef),
    registry: outcome.registry,
    registryPath: outcome.registryPath,
    resources: outcome.resources,
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
    const plan = await detectGitHubRepoBuildTestPlan({ repo, runCommand });
    if (plan.detected) {
      output.success(`Build/test auto-detected for ${repoLabel(repo)}: ${plan.setup_command} -> ${plan.test_command}`);
    } else {
      output.info(
        `Build/test not auto-detected for ${repoLabel(repo)}; the first code run will perform a readiness check before editing.`,
      );
    }
  }
}

export async function detectGitHubRepoBuildTestPlan({
  repo,
  runCommand = defaultRunCommand,
} = {}) {
  let packageJson = null;
  try {
    packageJson = await fetchGitHubPackageJson({ repo, runCommand });
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

async function fetchGitHubPackageJson({ repo, runCommand }) {
  const binding = gitHubRepoBinding(repo);
  const data = await ghJsonWithAmbientAuth({
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
  home = resolveTeamiHome(),
  config,
  initFlags = {},
  output,
  totalSteps,
  runGitHubPhase = null,
  resolveTransport = null,
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
  const transport = resolveTransport
    ? await resolveTransport({
        config: githubConfig,
        flags: initFlags,
        repoRoot,
        onProgress: githubProgress.log,
      })
    : await githubInitTransportFromFlags({
        config: githubConfig,
        flags: initFlags,
        repoRoot,
        onProgress: githubProgress.log,
      });
  const phaseInput = {
    repoRoot,
    home,
    config: githubConfig,
    transport,
    requestedOwner: initFlags["github-owner"] || null,
    requestedRepoName: initFlags["github-repo"] || null,
    requestedVisibility: initFlags["github-visibility"] || null,
    replacementExplicit: Boolean(initFlags["github-owner"] && initFlags["github-repo"]),
    onProgress: githubProgress.log,
  };
  const githubPhase = runGitHubPhase
    ? await runGitHubPhase(phaseInput)
    : await runGitHubInitPhase(phaseInput);
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
  return true;
}

async function runClaudePluginInitStep({
  context = {},
  repoRoot,
  output,
  totalSteps,
} = {}) {
  const registerPlugin = context.runClaudePluginRegistrationStep || runClaudePluginRegistrationStep;
  const result = await registerPlugin({
    repoRoot,
    output,
    totalSteps,
    runCommand: context.claudePluginRunCommand || defaultRunCommand,
    marketplaceSource: context.claudePluginMarketplaceSource || PUBLISHED_CLAUDE_PLUGIN_MARKETPLACE_SOURCE,
  });
  return result?.ok === true;
}

export async function runClaudePluginRegistrationStep({
  repoRoot = process.cwd(),
  output = createCliOutput(),
  totalSteps = 3,
  stepNumber = 3,
  runCommand = defaultRunCommand,
  pluginName = CLAUDE_PLUGIN_NAME,
  marketplaceName = CLAUDE_PLUGIN_MARKETPLACE,
  marketplaceSource = repoRoot,
  scope = CLAUDE_PLUGIN_SCOPE,
  pluginManifestPath = PACKAGED_CLAUDE_PLUGIN_MANIFEST_PATH,
} = {}) {
  output.step(stepNumber, totalSteps, "Install Claude plugin");
  let expectedVersion;
  try {
    expectedVersion = JSON.parse(
      fs.readFileSync(pluginManifestPath, "utf8"),
    ).version;
  } catch (error) {
    return failClaudePluginRegistration({
      output,
      reason: "claude_plugin_expected_version_unavailable",
      detail: error.message,
    });
  }
  if (typeof expectedVersion !== "string" || !expectedVersion.trim() || expectedVersion.includes("__")) {
    return failClaudePluginRegistration({
      output,
      reason: "claude_plugin_expected_version_invalid",
      detail: "packaged Claude plugin manifest must contain a concrete version",
    });
  }
  expectedVersion = expectedVersion.trim();
  const current = await readClaudePluginHealth({
    repoRoot,
    runCommand,
    pluginName,
    marketplaceName,
    marketplaceSource,
    scope,
  });
  if (current.ok && current.version === expectedVersion) {
    output.success(`Claude plugin already installed: ${pluginName}`);
    output.info(`Claude command available: /${pluginName}:plan`);
    return { ok: true, status: "already_installed", version: current.version, pluginName };
  }
  const needsUpdate = (current.ok && current.version !== expectedVersion) ||
    current.reason === "claude_plugin_launch_contract_mismatch";
  if (!needsUpdate && !["claude_plugin_missing", "claude_plugin_marketplace_missing"].includes(current.reason)) {
    return failClaudePluginRegistration({ output, reason: current.reason, detail: current.detail });
  }

  const marketplace = await ensureTrustedClaudeMarketplace({
    repoRoot,
    runCommand,
    marketplaceName,
    marketplaceSource,
    scope,
  });
  if (!marketplace.ok) {
    return failClaudePluginRegistration({ output, reason: marketplace.reason, detail: marketplace.detail });
  }
  output.detail(`Claude plugin marketplace verified: ${marketplaceName}`);

  const installRef = `${pluginName}@${marketplaceName}`;
  const installResult = await runClaudePluginCommand({
    runCommand,
    repoRoot,
    args: ["plugin", needsUpdate ? "update" : "install", installRef, "--scope", scope],
  });
  if (!installResult.ok) {
    return failClaudePluginRegistration({
      output,
      reason: needsUpdate ? "claude_plugin_update_failed" : "claude_plugin_install_failed",
      result: installResult,
    });
  }

  const readBack = await readClaudePluginHealth({
    repoRoot,
    runCommand,
    pluginName,
    marketplaceName,
    marketplaceSource,
    scope,
  });
  if (!readBack.ok) {
    return failClaudePluginRegistration({ output, reason: readBack.reason, detail: readBack.detail });
  }
  if (readBack.version !== expectedVersion) {
    return failClaudePluginRegistration({
      output,
      reason: "claude_plugin_version_mismatch",
      detail: `Claude reported ${readBack.version || "no version"}; expected ${expectedVersion}`,
    });
  }

  output.success(`Claude plugin ${needsUpdate ? "updated" : "installed"}: ${pluginName}`);
  output.info(`Claude command available: /${pluginName}:plan`);
  return {
    ok: true,
    status: needsUpdate ? "updated" : "installed",
    version: expectedVersion,
    pluginName,
    marketplaceName,
    marketplace: marketplace.status,
  };
}

async function runClaudePluginCommand({
  runCommand,
  repoRoot,
  args,
} = {}) {
  let result;
  try {
    result = await runCommand("claude", args, { cwd: repoRoot });
  } catch (error) {
    return {
      ok: false,
      status: 1,
      stdout: "",
      stderr: error.message,
      args,
    };
  }
  const status = Number.isInteger(result?.status) ? result.status : result?.ok === true ? 0 : 1;
  return {
    ok: result?.ok === true || status === 0,
    status,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    args,
  };
}


function failClaudePluginRegistration({
  output,
  reason,
  result = null,
  detail = null,
} = {}) {
  output.detail(`reason: ${reason}`);
  const safeDetail = detail || safeClaudeCliDetail(result);
  if (safeDetail) output.detail(`detail: ${safeDetail}`);
  output.error({
    what: "Claude plugin registration failed",
    why: "Teami needs the Claude plugin before /teami:plan is available in Claude Code.",
    fix: `repair Claude Code plugin access, then re-run ${formatCommand("init")} (setup is resumable).`,
  });
  process.exitCode = 1;
  return { ok: false, reason, ...(safeDetail ? { detail: safeDetail } : {}) };
}

function safeClaudeCliDetail(result = null) {
  const text = String(result?.stderr || result?.stdout || "").trim();
  if (!text) return "";
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|secret|authorization)=\S+/gi, (match) => `${match.split("=")[0]}=[redacted]`)
    .slice(0, 500);
}

async function runFinalGate({
  config,
  repoRoot,
  home = resolveTeamiHome(),
  cachePath,
  teamRef,
  output,
  phoenixOk = null,
  runSmoke = runRuntimeSmokeChecks,
  runDoctor = doctorGraphqlLinear,
} = {}) {
  output.section("Verifying setup");
  let smoke = { ok: false, results: [], error: "runtime_smoke_not_run" };
  let checks = [];
  let doctorGreen = false;
  let livePhoenixOk = phoenixOk === true;
  const health = await runSetupCompletionContract({
    startAt: "consent",
    continueAfterBlocked: true,
    phaseAdapters: {
      consent: async () => ({ status: "healthy", reason: "cli_disclosure_confirmed" }),
      linear: async () => ({ status: "healthy", reason: "cli_linear_setup_verified" }),
      product_repos: async () => ({ status: "healthy", reason: "cli_repo_intent_verified" }),
      github: async () => ({ status: "healthy", reason: "cli_github_phase_verified" }),
      plugin: async () => ({ status: "healthy", reason: "cli_plugin_phase_verified" }),
      phoenix: async () => ({
        status: livePhoenixOk ? "healthy" : "degraded",
        reason: livePhoenixOk ? "phoenix_trace_verified" : "phoenix_unavailable_or_unverified",
      }),
      runtime: async () => {
        output.info(`Running your claude/codex once to verify it works${output.symbols.ellipsis} this can take a minute the first time.`);
        const smokeProgress = output.progress("Running the runtime check");
        try {
          smoke = await runSmoke({ config, repoRoot, home });
        } catch (error) {
          smoke = { ok: false, results: [], error: error.message };
        } finally {
          smokeProgress.stop();
        }
        if (smoke.ok) {
          output.success("Runtime check passed");
        } else {
          output.warn("Runtime check did not pass; setup cannot be marked complete.");
          output.info(`You can re-run the check any time with ${formatCommand("runtime-smoke")}.`);
        }
        return { status: smoke.ok ? "healthy" : "blocked", reason: smoke.ok ? null : "runtime_smoke_failed" };
      },
      doctor: async () => {
        try {
          checks = await runDoctor({
            config,
            repoRoot,
            home,
            cachePath,
            teamRef,
            includeRuntimeSmoke: false,
            includePhoenix: true,
            includeLocalSupervisor: false,
          });
        } catch (error) {
          checks = [{ name: "health check", ok: false, message: error.message }];
        }
        checks = normalizeDoctorChecks(checks);
        for (const check of checks) renderDoctorCheckLine(check, output);
        doctorGreen = checks.length > 0 && checks.every((check) => check.state !== "fail");
        const phoenixChecks = checks.filter((check) => /phoenix/i.test(check.name || ""));
        livePhoenixOk = phoenixOk === true || (
          phoenixOk === null &&
          phoenixChecks.length > 0 &&
          phoenixChecks.every((check) => check.state === "pass")
        );
        return { status: doctorGreen ? "healthy" : "blocked", reason: doctorGreen ? null : "doctor_failed" };
      },
    },
  });
  if (health.ok) {
    output.success("Setup verified.");
  } else if (health.status === "degraded") {
    output.warn("Setup health is degraded; local Phoenix must pass before setup is complete.");
  } else {
    output.error({
      what: "Some setup checks need attention",
      fix: `fix the checks above, then re-run ${formatCommand("init")} (setup is resumable).`,
    });
  }
  return {
    ok: health.ok,
    status: health.status,
    reason: health.reason,
    health: health.steps,
    smokeOk: Boolean(smoke.ok),
    phoenixOk: livePhoenixOk,
    doctorOk: doctorGreen,
  };
}

// Back-compat alias for the shared launcher-form helper (now `formatCommand` in
// operator-output.mjs). Re-exported under the original name so existing call sites and the
// source-pinning tests stay green; new code should import `formatCommand` directly.
export const factoryLauncherCommand = formatCommand;

async function finishSetupOutput({
  output,
  commandOptions,
  phoenixAppUrl = null,
  phoenixOk = null,
  config,
  repoRoot,
  home = resolveTeamiHome(),
  cachePath,
  teamRef,
  finalGate = runFinalGate,
  runSmoke,
  runDoctor,
}) {
  const gate = await finalGate({
    config,
    repoRoot,
    home,
    cachePath,
    teamRef,
    output,
    phoenixOk,
    runSmoke,
    runDoctor,
  });
  if (!gate.ok) {
    output.warn(`Setup is resumable — fix the checks above and re-run ${formatCommand("init")}.`);
    process.exitCode = 1;
    return gate;
  }
  const firstRunProbe = config ? homeStateProbe({ repoRoot, home, config }) : null;
  output.done(commandOptions.runGithubPhase ? "Teami is ready." : `${commandOptions.readyLabel} connected.`);
  renderFirstRunUx({
    output,
    probe: firstRunProbe,
    phoenixAppUrl,
    gate,
    commands: {
      init: factoryLauncherCommand("init"),
      doctor: factoryLauncherCommand("doctor"),
      gatewayStart: factoryLauncherCommand("gateway start"),
      gatewayStatus: factoryLauncherCommand("gateway status"),
      phoenixStart: formatCommand("phoenix:start"),
    },
    plannedProjectText: "Run /teami:plan in a new Claude Code session to shape your first project",
  });
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
  registry = emptyTeamRegistry(),
  flags = {},
  env = process.env,
  teamNameHint = null,
  resumeTeam = null,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = (line) => console.log(line),
  createSetupAuth = createLinearSetupGraphqlClient,
  authorizeOneShotAdmin = authorizeOneShotLinearAdmin,
  promptAdminProvisioning = promptLine,
  promptWorkspace = promptLinearWorkspacePicker,
  promptReauthorize = promptLinearReauthorization,
  maxAuthorizationAttempts = 3,
} = {}) {
  const selection = await resolveLinearWorkspaceSelection({
    registry,
    flags,
    env,
    teamNameHint,
    resumeTeam,
    isTTY,
    log,
    promptWorkspace,
  });
  const declaredWorkspace = selection.declaredWorkspace;
  const completeResume = isCompleteResumeSelection(selection);
  let trustLinePrinted = false;
  let forceBrowserAuthorization = false;
  // Browser authorization does not force Linear's consent screen by default. The explicit
  // workspace-picker paths below still request prompt=consent, but actor=app installations can
  // show Linear's non-redirecting "already installed" page either way. The shared onboarding
  // result carries the recovery branch so CLI and MCP render that live platform behavior honestly.
  let forceConsentAuthorization = false;

  for (let attempt = 1; attempt <= maxAuthorizationAttempts; attempt += 1) {
    const allowBrowserAuth = !completeResume || forceBrowserAuthorization;
    if (completeResume && !allowBrowserAuth && !trustLinePrinted) {
      log(`Using existing Linear authorization for team "${teamNameForResumeTeam(selection.resumeTeam)}".`);
      trustLinePrinted = true;
    } else if (allowBrowserAuth && !trustLinePrinted) {
      log("Authorizing grants Teami read/write access to the entire selected Linear workspace; Linear has no narrower scope. Setup may ask once for admin approval only to create Principal Escalation if it is missing.");
      trustLinePrinted = true;
    }
    if (allowBrowserAuth) {
      for (const line of workspaceAuthorizationInstructions(selection)) log(line);
    }

    const appSetupAuth = createSetupAuth({
      config,
      repoRoot,
      credentialStore,
      allowBrowserAuth,
      allowRefresh: true,
      deferTokenPersistence: allowBrowserAuth,
      prompt: forceConsentAuthorization ? "consent" : null,
      waitEscape: allowBrowserAuth && isTTY
        ? () => createLinearOAuthWaitEscape({ promptReauthorize })
        : null,
      onProgress: (line) => log(line),
    });
    let guard;
    try {
      guard = await verifyWorkspaceGrantForSelection({
        setupAuth: appSetupAuth,
        selection,
        declaredWorkspace,
        registry,
        isTTY,
        attempt,
        maxAuthorizationAttempts,
        promptReauthorize,
        log,
        allowRetry: allowBrowserAuth,
      });
    } catch (error) {
      if (isLinearOAuthWaitEscapedError(error) && attempt < maxAuthorizationAttempts) {
        log("Reopening Linear authorization...");
        forceBrowserAuthorization = true;
        continue;
      }
      if (
        shouldRetryLinearSetupAuthorization({ error, setupAuth: appSetupAuth }) &&
        attempt < maxAuthorizationAttempts
      ) {
        await requestLinearSetupReauthorization({
          setupAuth: appSetupAuth,
          selection,
          isTTY,
          promptReauthorize,
          log,
        });
        forceBrowserAuthorization = true;
        continue;
      }
      if (completeResume) throw completeResumeCredentialError(selection.resumeTeam, error);
      throw error;
    }
    if (guard.retry) {
      if (guard.forceConsent) forceConsentAuthorization = true;
      continue;
    }

    const needsPrincipalProjectStatus = completeResume
      ? null
      : await ensureNeedsPrincipalProjectStatus({
          appClient: appSetupAuth.client,
          adminAuth: () => authorizeOneShotAdmin({
            config,
            onProgress: (line) => log(line),
          }),
          log,
          interactive: allowBrowserAuth && isTTY,
          prompt: promptAdminProvisioning,
        });

    await persistVerifiedSetupAuthToken(appSetupAuth);
    return {
      setupAuth: appSetupAuth,
      workspace: guard.workspace,
      declaredWorkspace,
      selection,
      needsPrincipalProjectStatus,
    };
  }

  throw new Error("workspace_authorization_retries_exhausted");
}

async function ensureNeedsPrincipalProjectStatus({
  appClient,
  adminAuth,
  log = () => {},
  interactive = false,
  prompt = promptLine,
} = {}) {
  const statuses = await listProjectStatusesForNeedsPrincipal(appClient);
  const existing = resolveExactNeedsPrincipalProjectStatus(statuses);
  if (existing) return existing;

  if (!interactive) {
    throw needsPrincipalProjectStatusRepairError(
      "Principal Escalation project status is missing; re-run `init` from a desktop session with a browser to recreate it (one approval).",
    );
  }
  if (typeof adminAuth !== "function") {
    throw new Error("Linear setup cannot provision Principal Escalation: admin authorization is unavailable.");
  }

  await confirmNeedsPrincipalProjectStatusProvisioning({ log, prompt });
  let adminProvisioner = null;
  try {
    adminProvisioner = await adminAuth();
    const position = positionAfterPlannedProjectStatus(statuses);
    await adminProvisioner.adminClient.createProjectStatus({
      name: PROJECT_NEEDS_PRINCIPAL_STATUS_NAME,
      color: PROJECT_NEEDS_PRINCIPAL_STATUS_COLOR,
      position,
      type: PROJECT_NEEDS_PRINCIPAL_STATUS_TYPE,
    });
  } finally {
    await adminProvisioner?.teardown?.();
  }

  const verified = resolveExactNeedsPrincipalProjectStatus(
    await listProjectStatusesForNeedsPrincipal(appClient),
  );
  if (!verified) {
    throw needsPrincipalProjectStatusRepairError(
      `Principal Escalation project status was created but could not be verified as a planned project status.`,
    );
  }
  log("Principal Escalation project status is ready. The one-time admin approval was used once and was not stored.");
  return verified;
}

async function listProjectStatusesForNeedsPrincipal(appClient) {
  if (typeof appClient?.listProjectStatuses !== "function") {
    throw new Error("Linear setup cannot resolve project statuses: client cannot list project statuses.");
  }
  return await appClient.listProjectStatuses();
}

function resolveExactNeedsPrincipalProjectStatus(statuses = []) {
  const nameMatches = statuses.filter(
    (status) => status?.name === PROJECT_NEEDS_PRINCIPAL_STATUS_NAME && !isArchivedLinearEntity(status),
  );
  const exactMatches = nameMatches.filter((status) => status.type === PROJECT_NEEDS_PRINCIPAL_STATUS_TYPE);
  if (exactMatches.length === 1) return exactMatches[0];
  if (nameMatches.length > 0 || exactMatches.length > 1) {
    throw needsPrincipalProjectStatusRepairError(
      `Cannot resolve project status mapping 'needs_principal' by configured name '${PROJECT_NEEDS_PRINCIPAL_STATUS_NAME}': found ${exactMatches.length} planned matches.`,
    );
  }
  return null;
}

function positionAfterPlannedProjectStatus(statuses = []) {
  const planned = statuses.find((status) => status?.name === PROJECT_PLANNED_STATUS_NAME);
  const position = Number(planned?.position);
  if (!Number.isFinite(position)) {
    throw new Error("Linear setup cannot provision Principal Escalation: Planned project status position is unavailable.");
  }
  return position + PROJECT_STATUS_POSITION_INCREMENT;
}

function isArchivedLinearEntity(entity) {
  return entity?.archived === true || entity?.archivedAt;
}

async function confirmNeedsPrincipalProjectStatusProvisioning({ log, prompt }) {
  log("Teami needs one-time administrative approval from Linear.");
  log("It will be used for exactly one thing: creating the single Principal Escalation project status your board needs.");
  log("The approval is used once, is not stored, and day-to-day runs continue with read/write access only.");
  await prompt("Press Enter to approve on the next screen: ");
}

function needsPrincipalProjectStatusRepairError(message) {
  const error = new Error(message);
  error.code = PROJECT_NEEDS_PRINCIPAL_STATUS_REPAIR_CODE;
  return error;
}

function setupCacheWithNeedsPrincipalStatus({ cache = null, status = null } = {}) {
  if (!status?.id) return cache;
  return {
    ...(cache || {}),
    projectStatuses: {
      ...(cache?.projectStatuses || {}),
      needs_principal: status.id,
    },
    projectStatusTypes: {
      ...(cache?.projectStatusTypes || {}),
      needs_principal: status.type,
    },
  };
}

async function requestLinearSetupReauthorization({
  setupAuth,
  selection,
  isTTY = false,
  promptReauthorize = promptLinearReauthorization,
  log = () => {},
} = {}) {
  const label = selection?.label || workspaceLabel(selection?.declaredWorkspace || {});
  log("Stored Linear authorization is missing or no longer valid. Reauthorizing in the browser...");
  if (isTTY || promptReauthorize !== promptLinearReauthorization) {
    await promptReauthorize({
      message: `Linear authorization for workspace ${label} needs to be refreshed. Press Enter to reopen Linear's consent screen: `,
    });
  }
  await setupAuth?.tokenProvider?.clear?.();
}

function shouldRetryLinearSetupAuthorization({ error, setupAuth } = {}) {
  if (!isLinearAuthorizationFailure(error)) return false;
  const source = setupAuth?.tokenProvider?.lastTokenSource;
  return source === null || source === undefined || source === "stored" || source === "refresh";
}

function isLinearAuthorizationFailure(error) {
  const messages = [
    error?.message,
    error?.cause?.message,
    ...(Array.isArray(error?.errors) ? error.errors.map((entry) => entry?.message) : []),
  ].filter(Boolean).join("\n");
  return error?.httpStatus === 401 ||
    /\bHTTP 401\b/i.test(messages) ||
    /Authentication required|not authenticated|authorization is missing|OAuth token is missing|access token is expired or unavailable/i.test(messages);
}
function completeResumeCredentialError(team, originalError) {
  const teamName = teamNameForResumeTeam(team) || "unknown";
  const error = new Error(
    `Linear authorization for saved Team "${teamName}" points at the wrong workspace or could not be verified. Teami left the saved Team unchanged.`,
  );
  error.code = isWorkspaceMismatchError(originalError)
    ? "workspace_mismatch"
    : "linear_authorization_failed";
  error.savedTeam = {
    ref: team?.id || teamName,
    name: teamName,
    workspace_id: team?.linear?.workspace_id || null,
    workspace_name: team?.linear?.workspace_name || null,
  };
  error.grantedWorkspace = originalError?.granted || null;
  error.cause = originalError;
  return error;
}

function isCompleteResumeSelection(selection) {
  return selection?.source === "complete_resume";
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
        // The user asked for the workspace dropdown, so request the consent screen on reopen.
        return { retry: true, forceConsent: true };
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
        // Wrong-workspace recovery needs the picker too — force consent on the reopen.
        return { retry: true, forceConsent: true };
      }
      await setupAuth.tokenProvider?.discardPendingTokenSet?.();
      const mismatch = new Error(`${error.message}. Pick this workspace from the known workspace list instead.`);
      mismatch.code = "workspace_mismatch";
      mismatch.cause = error;
      throw mismatch;
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
  registry = emptyTeamRegistry(),
  flags = {},
  env = process.env,
  teamNameHint = null,
  resumeTeam = null,
  isTTY = false,
  log = (line) => console.log(line),
  promptWorkspace = promptLinearWorkspacePicker,
} = {}) {
  const knownWorkspaces = knownRegistryWorkspaces(registry);
  const matchedResumeTeam =
    resumeTeam ||
    setupIncompleteTeamForName(registry, teamNameHint) ||
    (!teamNameHint ? singleSetupIncompleteTeam(registry) : null);
  const resumeDeclaredWorkspace = declaredWorkspaceFromResumeTeam(matchedResumeTeam);
  if (resumeDeclaredWorkspace) {
    return {
      mode: "known",
      source: matchedResumeTeam?.status === "setup_incomplete" ? "resume" : "complete_resume",
      knownWorkspaces,
      declaredWorkspace: resumeDeclaredWorkspace,
      label: workspaceLabel(resumeDeclaredWorkspace),
      resumeTeam: matchedResumeTeam,
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

async function promptLinearReauthorization({ message, signal } = {}) {
  return promptLine(message || "press R then Enter to re-authorize: ", { signal });
}

function createLinearOAuthWaitEscape({ promptReauthorize = promptLinearReauthorization } = {}) {
  const controller = new AbortController();
  let settled = false;
  const promise = Promise.resolve(
    promptReauthorize({
      message: "After revoking Teami in Linear Settings -> Applications, press Enter here to reopen the sign-in: ",
      signal: controller.signal,
    }),
  ).finally(() => {
    settled = true;
  });
  return {
    promise,
    cancel() {
      if (settled || controller.signal.aborted) return;
      controller.abort();
    },
  };
}

async function promptLine(message, { signal } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message, signal ? { signal } : undefined);
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
  for (const item of summary.notes || []) emitSummaryDetail(output, `note: ${item}`);
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

async function resolveInitTeamName(args = [], {
  command = "init",
  registry = emptyTeamRegistry(),
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt = promptLine,
} = {}) {
  const explicit = explicitInitTeamName(args);
  if (explicit) return explicit;
  const teams = (registry?.teams || []).filter((team) => team?.status !== "removed");
  if (command === "init" && teams.length === 0) return DEFAULT_SETUP_TEAM_NAME;
  if (command === "init" && teams.length === 1) return teamNameForResumeTeam(teams[0]);
  if (isTTY) {
    const promptText = (LINEAR_SETUP_COMMAND_OPTIONS[command] || LINEAR_SETUP_COMMAND_OPTIONS.init).prompt;
    const answer = await prompt(promptText);
    if (String(answer || "").trim()) return String(answer).trim();
  }
  throw new Error("A Linear team name is required in non-interactive setup. Rerun with --team \"Your Team Name\".");
}

function explicitInitTeamName(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  const explicit = [
    flags.team,
    flags["team-name"],
    ...positionals,
    process.env.TEAMI_TEAM_NAME,
  ].find((value) => typeof value === "string" && value.trim());
  if (explicit) return explicit.trim();
  return null;
}

function registryWithoutRemovedTeams(registry = emptyTeamRegistry()) {
  const teams = (registry?.teams || []).filter((team) => team.status !== "removed");
  if (teams.length === (registry?.teams || []).length) return registry;
  return { ...(registry || emptyTeamRegistry()), teams };
}

export function registryWithoutRemovedTeamsForName(registry = emptyTeamRegistry(), teamName = "") {
  void teamName;
  return registryWithoutRemovedTeams(registry);
}
function resolveSetupCommandTeamNameHint(args = [], registry = emptyTeamRegistry()) {
  const resumableRegistry = registryWithoutRemovedTeams(registry);
  const explicit = explicitInitTeamName(args);
  if (explicit) {
    const { flags } = parseCliFlags(args);
    const workspace = typeof flags.workspace === "string" ? flags.workspace.trim() : null;
    const resumeTeam = setupIncompleteTeamForName(resumableRegistry, explicit, workspace);
    return {
      teamNameHint: explicit,
      resumeTeam,
      completeResumeTeam: resumeTeam
        ? null
        : setupCompleteTeamForName(resumableRegistry, explicit, workspace),
      source: "explicit",
    };
  }

  const resumeTeam = singleSetupIncompleteTeam(resumableRegistry);
  const teamNameHint = teamNameForResumeTeam(resumeTeam);
  return {
    teamNameHint,
    resumeTeam: teamNameHint ? resumeTeam : null,
    completeResumeTeam: null,
    source: teamNameHint ? "single_setup_incomplete" : "none",
  };
}

function resolveGitHubPhaseResumeTeam({
  args = [],
  registry = emptyTeamRegistry(),
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  readConnectionState = readGitHubConnectionState,
} = {}) {
  if (explicitInitTeamName(args)) return null;
  if (singleSetupIncompleteTeam(registry)) return null;
  const teams = (registry?.teams || []).filter((team) => team.status === "active");
  if (teams.length !== 1) return null;
  return githubConnectionNeedsInit({ repoRoot, home, readConnectionState }) ? teams[0] : null;
}

function resolveClaudePluginPhaseResumeTeam({
  args = [],
  registry = emptyTeamRegistry(),
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  readConnectionState = readGitHubConnectionState,
} = {}) {
  if (explicitInitTeamName(args)) return null;
  if (singleSetupIncompleteTeam(registry)) return null;
  const teams = (registry?.teams || []).filter((team) => team.status === "active");
  if (teams.length !== 1) return null;
  return githubConnectionNeedsInit({ repoRoot, home, readConnectionState }) ? null : teams[0];
}

function githubConnectionNeedsInit({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  readConnectionState = readGitHubConnectionState,
} = {}) {
  const read = readConnectionState({ repoRoot, home });
  if (!read.ok) return true;
  const connection = read.connection || {};
  return connection.connection_mode !== "real" ||
    connection.status !== "verified" ||
    connection.adoption_complete !== true;
}

function singleSetupIncompleteTeam(registry = emptyTeamRegistry()) {
  const teams = (registry?.teams || []).filter((team) => team.status === "setup_incomplete");
  return teams.length === 1 ? teams[0] : null;
}

function teamNameForResumeTeam(team = null) {
  if (!team) return null;
  return team.adopter_provided_name || team.id || null;
}

function teamHasLinearCredentialIdentity(team) {
  return Boolean(team?.id && team?.linear?.workspace_id && team?.linear?.team_id);
}

export {
  authorizeLinearSetupWorkspace,
  ensureNeedsPrincipalProjectStatus,
  explicitInitTeamName,
  finishSetupOutput,
  githubInitTransportFromFlags,
  promptLinearWorkspacePicker,
  resolveClaudePluginPhaseResumeTeam,
  resolveInitTeamName,
  resolveGitHubPhaseResumeTeam,
  resolveLinearWorkspaceSelection,
  resolveSetupCommandTeamNameHint,
  runFinalGate,
};
