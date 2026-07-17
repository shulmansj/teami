import { createRequire } from "node:module";

import { readLinearCache, writeLinearCache } from "./cache.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import { loadLinearConfig } from "./config.mjs";
import { normalizeDoctorChecks } from "./doctor-check.mjs";
import { createTeamConfinedPlanningMutations } from "./team-confined-planning-mutations.mjs";
import { resolveForegroundTeamCache } from "./team-command-context.mjs";
import { buildTeamContext } from "./team-resolver.mjs";
import {
  createAtomicTeamRegistryWriter,
  emptyTeamRegistry,
  readTeamRegistry,
} from "./team-registry.mjs";
import {
  createBootstrapLinearCredentialStore,
  promoteSetupCredentialToTeam,
} from "./cli/local-setup-cleanup.mjs";
import {
  authorizeLinearSetupWorkspace,
  discoverGitHubRepos,
  ensureNeedsPrincipalProjectStatus,
  persistTeamGitHubRepoAllowlist,
  registryWithoutRemovedTeamsForName,
  resolveSetupCommandTeamNameHint,
  runClaudePluginRegistrationStep,
} from "./cli/linear-setup-command.mjs";
import {
  configWithGithubFlags,
  githubSetupTransportFromFlags,
} from "./cli/github-command-options.mjs";
import {
  completeTeamTeamMissingRecoveryFromError,
  formatCommand,
  formatCommandForContext,
} from "./cli/operator-output.mjs";
import { doctorGraphqlLinear } from "./cli/doctor-command.mjs";
import {
  readGitHubConnectionState,
  runGitHubInitPhase,
} from "./github-setup.mjs";
import { createLinearCredentialStore } from "./linear-credential-store.mjs";
import { ensurePhoenixReady } from "./local-phoenix-manager.mjs";
import { runLocalPhoenixTracePreflight } from "./local-phoenix-trace-sink.mjs";
import {
  authorizeOneShotLinearAdmin,
  createLinearSetupGraphqlClient,
  startOneShotLinearAdminAuthorizationSession,
} from "./linear-setup-auth.mjs";
import {
  authorizeWithBrowser,
  redactOAuthSecrets,
  startLinearBrowserAuthorizationSession,
} from "./linear-oauth.mjs";
import { knownTraceAttributes } from "./linear/matching-utils.mjs";
import { resolveLinearShape } from "./linear/shape-resolver.mjs";
import { setupLinearTeam } from "./linear-service.mjs";
import { renderPlanningBody } from "./project-planning-body.mjs";
import { createTrace, recordSpan } from "./trace.mjs";
import { runRuntimeSmokeChecks } from "./runtime-smoke.mjs";
import { acquireTeamOperationLock } from "./team-operation-lock.mjs";
import { selectGatewayTeams } from "./gateway-loop.mjs";
import {
  readBackgroundListenerStatus,
  startBackgroundListener,
  stopBackgroundListener,
} from "./background-listener.mjs";
import { HOME_STATE, homeStateProbe } from "./cli/home-state.mjs";
import {
  DEFAULT_SETUP_TEAM_NAME,
  SETUP_DISCLOSURE_HASH,
  SETUP_DISCLOSURE_VERSION,
  createSetupStateStore,
  isSetupOwnerAlive,
  normalizeSetupRepoIntent,
  runSetupCompletionContract,
  setupEffectsDisclosure,
  verifySetupConsent,
} from "./setup-orchestrator.mjs";
import {
  LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
  PLANNING_SESSION_TRACE_KIND,
  digestTraceField,
  enforceTraceContentPolicy,
} from "../../../engine/trace-contract.mjs";
export const TEAMI_PROJECT_MCP_TOOL_NAMES = Object.freeze([
  "init_onboarding",
  "check_team_context",
  "listener_status",
  "listener_start",
  "listener_stop",
  "project_create",
  "project_write_body",
  "project_move_status",
]);
const TEAMI_PACKAGE_VERSION = createRequire(import.meta.url)("../../../../package.json").version;
const ADMIN_GRANT_USE_WINDOW_MS = 5 * 60 * 1000;

export class ProjectMcpToolError extends Error {
  constructor(code, message, { repair = null, phase = null, durableLinear = false } = {}) {
    super(message);
    this.name = "ProjectMcpToolError";
    this.code = code;
    this.repair = repair;
    this.phase = phase;
    this.durableLinear = durableLinear === true;
  }
}

export function createProjectMcpToolActions({
  repoRoot = process.cwd(),
  config = null,
  registry = null,
  readCache = readLinearCache,
  loadConfig = loadLinearConfig,
  createCredentialStore = createLinearCredentialStore,
  createBootstrapCredentialStore = createBootstrapLinearCredentialStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  linearClient = null,
  linearClientFactory = null,
  resolveShape = resolveLinearShape,
  planningTraceSink = null,
  createPlanningTraceSink = null,
  awaitPlanningTraceEmission = false,
  packageVersion = TEAMI_PACKAGE_VERSION,
  home = resolveTeamiHome(),
  createLinearSetupAuth = null,
  authorizeLinearBrowser = authorizeWithBrowser,
  startLinearBrowserAuthorization = startLinearBrowserAuthorizationSession,
  authorizeOneShotAdmin = authorizeOneShotLinearAdmin,
  startOneShotAdminAuthorization = startOneShotLinearAdminAuthorizationSession,
  openBrowser = undefined,
  fetchImpl = globalThis.fetch,
  runGitHubPhase = runGitHubInitPhase,
  githubInitTransportFromFlags = githubSetupTransportFromFlags,
  githubSetupTransport = null,
  githubDiscoveryRunCommand = null,
  runGit = null,
  runClaudePluginRegistration = runClaudePluginRegistrationStep,
  claudePluginRunCommand = null,
  claudePluginMarketplaceSource = undefined,
  setupStateStore = null,
  ensurePhoenix = ensurePhoenixReady,
  runPhoenixPreflight = runLocalPhoenixTracePreflight,
  runRuntimeSmoke = runRuntimeSmokeChecks,
  runSetupDoctor = doctorGraphqlLinear,
  runInitOnboardingSetupImpl = runInitOnboardingSetup,
  adminGrantUseWindowMs = ADMIN_GRANT_USE_WINDOW_MS,
  promptLinearWorkspaceConfirmation = autoProceedReauthorizationPrompt,
  onSetupProgress = null,
  setupSurface = "mcp",
  setupOwnerPid = process.pid,
  isSetupOwnerProcessAlive = null,
  acquireTeamAuthority = acquireTeamOperationLock,
  probeListener = homeStateProbe,
  startListener = startBackgroundListener,
  stopListener = stopBackgroundListener,
  readListenerProcessStatus = readBackgroundListenerStatus,
} = {}) {
  const baseConfig = config || loadConfig({ repoRoot });
  const setupStore = setupStateStore || createSetupStateStore({ home });
  const authorizationSessions = new Map();
  setupStore.cleanupExpired?.();

  async function init_onboarding(args = {}) {
    const setupId = optionalString(args.setup_id || args.setupId);
    const adminRequirement = setupStore.readAdminRevocationRequirement?.() ||
      setupStore.readGlobalAdminRevocationRequired?.();
    if (adminRequirement && args.repair_admin_revocation === true) {
      return {
        ok: false,
        status: "blocked",
        ...(setupId ? { setup_id: setupId } : {}),
        reason: "prior_admin_revocation_not_verifiable",
        repair: adminRevocationRecoveryInstruction(),
      };
    }
    if (adminRequirement && setupId && !authorizationSessions.has(setupId) &&
        setupStore.read(setupId)?.admin_revocation_required) {
      return adminAuthorizationProcessRestartedResult(setupId);
    }
    if (adminRequirement && (!setupId || !authorizationSessions.has(setupId))) {
      return adminRevocationRequiredResult(setupId || null);
    }
    if (setupId) {
      return resumeInitOnboardingAuthorization({
        setupId,
        args,
        authorizationSessions,
        setupStore,
        config: baseConfig,
        openBrowser,
        fetchImpl,
        startAdminAuthorization: startOneShotAdminAuthorization,
        adminGrantUseWindowMs,
        runSetup: (setupArgs, tokenSet, adminAuthorization = null) => runInitOnboardingSetupImpl({
          args: setupArgs,
          config: baseConfig,
          repoRoot,
          home,
          registry,
          readCache,
          createCredentialStore,
          createBootstrapCredentialStore,
          createSetupGraphqlClient,
          createLinearSetupAuth,
          authorizeLinearBrowser: async () => tokenSet,
          authorizeOneShotAdmin: adminAuthorization
            ? async () => {
                adminAuthorization.grantConsumed = true;
                return adminAuthorization.adminGrant;
              }
            : authorizeOneShotAdmin,
          openBrowser,
          fetchImpl,
          runGitHubPhase,
          githubInitTransportFromFlags,
          githubSetupTransport,
          githubDiscoveryRunCommand,
          runGit,
          runClaudePluginRegistration,
          claudePluginRunCommand,
          claudePluginMarketplaceSource,
          setupStore,
          setupId,
          adminConfirm: args.admin_confirm === true || adminAuthorization !== null,
          ensurePhoenix,
          runPhoenixPreflight,
          runRuntimeSmoke,
          runSetupDoctor,
          promptLinearWorkspaceConfirmation,
          githubReplacementExplicit: setupStore.read(setupId)?.input?.github_replacement_explicit === true || Boolean(
            optionalString(args.github_owner) && optionalString(args.github_repo),
          ),
        }),
        onSetupProgress,
        packageVersion,
      });
    }
    const currentRegistry = readTeamRegistry({ home }) || emptyTeamRegistry();
    const teamName = optionalString(args.team) || inferredSetupTeamName(currentRegistry);
    if (!teamName || args.confirm !== true) {
      return initOnboardingNeedsResult({
        teamName,
        teamRequired: !teamName,
      });
    }
    let requestedRepoIntent;
    try {
      requestedRepoIntent = normalizeSetupRepoIntent(args.repo_intent || { mode: "non_code" });
    } catch (error) {
      return {
        ok: false,
        status: "blocked",
        reason: "product_repo_intent_invalid",
        repair: error.message,
      };
    }
    if (requestedRepoIntent.mode !== "non_code") {
      return {
        ok: false,
        status: "blocked",
        reason: "product_repo_access_not_supported_during_setup",
        repair: "Run setup without a product-repository allowlist. Connecting one later is a separate explicit action.",
      };
    }
    const setupArgs = {
      ...args,
      team: teamName,
      repo_intent: { mode: "non_code" },
    };
    const teamResolution = resolveSetupCommandTeamNameHint(
      ["--team", teamName],
      currentRegistry,
    );
    const completeTeam = teamResolution.completeResumeTeam || null;
    const incompleteTeam = teamResolution.resumeTeam || null;
    const credentialTeam = completeTeam ||
      (teamHasLinearCredentialIdentity(incompleteTeam) ? incompleteTeam : null);
    setupArgs.github_replacement_explicit = Boolean(
      completeTeam && optionalString(args.github_owner) && optionalString(args.github_repo),
    );
    let existingTokenSet = null;
    if (completeTeam || incompleteTeam) {
      const existingCredentialStore = credentialTeam
        ? createCredentialStore({
            config: baseConfig,
            repoRoot,
            home,
            teamContext: buildTeamContext({ team: credentialTeam, config: baseConfig, repoRoot, home }),
          })
        : createBootstrapCredentialStore({ config: baseConfig, repoRoot, home });
      existingTokenSet = await existingCredentialStore.readTokenSet();
      if (existingTokenSet) {
        const setupAuthFactory = createLinearSetupAuth ||
          ((options) => createSetupGraphqlClient(options));
        try {
          const existingAuth = setupAuthFactory({
            config: baseConfig,
            repoRoot,
            credentialStore: existingCredentialStore,
            allowBrowserAuth: false,
            allowRefresh: false,
            deferTokenPersistence: false,
            fetchImpl,
          });
          await existingAuth.client.verifyAuth();
          const expectedWorkspaceId = (completeTeam || incompleteTeam)?.linear?.workspace_id || null;
          if (expectedWorkspaceId && typeof existingAuth.client.getOrganization === "function") {
            const organization = await existingAuth.client.getOrganization();
            if (organization?.id !== expectedWorkspaceId) {
              const mismatch = new Error("Stored setup authorization belongs to a different Linear workspace.");
              mismatch.httpStatus = 401;
              throw mismatch;
            }
          }
        } catch (error) {
          if (!isReauthorizeError(error)) {
            return {
              ok: false,
              status: "blocked",
              reason: "linear_authorization_validation_failed",
              detail: redactOAuthSecrets(error?.message || String(error || "Linear authorization validation failed")),
              repair: "Check the network and Linear availability, then retry setup. Teami did not replace the existing grant.",
            };
          }
          const deletion = typeof existingCredentialStore.deleteTokenSetIfEqual === "function"
            ? await existingCredentialStore.deleteTokenSetIfEqual(existingTokenSet)
            : (await existingCredentialStore.deleteTokenSet?.(), { ok: true });
          if (deletion?.ok === false) {
            return {
              ok: false,
              status: "blocked",
              reason: "linear_authorization_changed_during_validation",
              repair: "The Linear credential was refreshed while setup was checking it. Retry setup; Teami preserved the newer credential.",
            };
          }
          existingTokenSet = null;
        }
      }
    }
    const started = await beginInitOnboardingAuthorization({
      args: setupArgs,
      config: baseConfig,
      openBrowser,
      fetchImpl,
      startAuthorization: startLinearBrowserAuthorization,
      setupStore,
      authorizationSessions,
      existingTokenSet,
      setupOwner: { surface: setupSurface, pid: setupOwnerPid },
      isSetupOwnerProcessAlive,
    });
    if (started?.status === "authorization_reused") {
      return init_onboarding({ setup_id: started.setup_id });
    }
    return started;
  }

  async function check_team_context(args = {}) {
    const { context, cache } = resolveTeamCache(args);
    const team = publicTeamContext(context);
    const approvedRepositories = structuredClone(context.allowedRepoPacket || []);
    return {
      ok: true,
      read_only: true,
      summary: resolvedTeamSummary(team, approvedRepositories),
      team,
      approved_repositories: approvedRepositories,
      cache: publicCacheSummary(cache),
      listener: listenerLaunchContract(packageVersion),
    };
  }

  async function listener_status() {
    const currentRegistry = listenerRegistry({ registry, home });
    const activeTeams = selectGatewayTeams({ registry: currentRegistry });
    const probe = probeListener({ repoRoot, home, config: baseConfig });
    const processStatus = readListenerProcessStatus({ home });
    const running = probe.state === HOME_STATE.LISTENING && processStatus.running;
    const effectiveState = probe.state === HOME_STATE.LISTENING && !running
      ? HOME_STATE.IDLE
      : probe.state;
    const contract = listenerLaunchContract(packageVersion);
    return {
      ok: true,
      read_only: true,
      status: listenerPublicStatus(effectiveState),
      running,
      scope: {
        mode: running && processStatus.mode === "foreground"
          ? "foreground_selection_unknown"
          : "all_active_teams",
        team_refs: running && processStatus.mode === "foreground"
          ? []
          : activeTeams.map((team) => team.id),
      },
      lifecycle: {
        mode: running ? processStatus.mode : "stopped",
        detail: processStatus.mode === "background"
          ? "This local listener keeps running after the agent session and terminal close. It runs until turned off, sign-out, restart, or a process failure."
          : processStatus.mode === "foreground"
            ? "This listener is not managed by Teami's background controller. Stop it with Ctrl-C in its terminal; if no such terminal exists, sign out or restart once."
            : "The listener is off. Planned projects wait safely in Linear.",
      },
      manual_start_command: contract.start_command,
      manual_stop_command: contract.stop_command,
      summary: listenerStatusSummary({ state: effectiveState, mode: processStatus.mode }),
    };
  }

  async function listener_start(args = {}) {
    if (args.confirm !== true) {
      throw new ProjectMcpToolError(
        "confirmation_required",
        "listener_start requires confirm: true after the adopter agrees to start the local listener.",
      );
    }

    const before = await listener_status();
    if (before.running) {
      return {
        ...before,
        read_only: false,
        status: "already_running",
        summary: "Teami is already listening on this computer.",
      };
    }
    if (before.status === "not_ready") {
      throw new ProjectMcpToolError(
        "listener_not_ready",
        "Teami setup is not complete, so the listener cannot start yet.",
        { repair: `Run ${formatCommandForContext("init", { packageVersion })}, then check listener_status again.` },
      );
    }
    if (before.status === "degraded") {
      throw new ProjectMcpToolError(
        "listener_state_degraded",
        "Teami could not read its local setup state cleanly, so the listener was not started.",
        { repair: `Run ${formatCommandForContext("doctor", { packageVersion })}, repair the red check, then try again.` },
      );
    }

    const currentRegistry = listenerRegistry({ registry, home });
    const teams = selectGatewayTeams({ registry: currentRegistry });
    if (teams.length === 0) {
      throw new ProjectMcpToolError(
        "no_active_teams",
        "No active Teami Team is configured, so the listener cannot start.",
        { repair: `Run ${formatCommandForContext("init", { packageVersion })}, then try again.` },
      );
    }

    let result;
    try {
      result = await startListener({ repoRoot, home });
    } catch (error) {
      throw listenerStartError(error, packageVersion);
    }
    if (!result?.ok) {
      throw new ProjectMcpToolError(
        "listener_start_failed",
        `Teami's local listener did not start: ${redactOAuthSecrets(result?.reason || result?.status || "unknown failure")}`,
        { repair: `Run ${formatCommandForContext("doctor", { packageVersion })}, repair any red check, then try again.` },
      );
    }

    return {
      ok: true,
      status: result.status === "already_running" ? "already_running" : "started",
      running: true,
      scope: {
        mode: "all_active_teams",
        team_refs: teams.map((team) => team.id),
      },
      lifecycle: {
        mode: result.mode || "background",
        detail: "This local listener keeps running after the agent session and terminal close. It runs until turned off, sign-out, restart, or a process failure.",
      },
      manual_start_command: listenerLaunchContract(packageVersion).start_command,
      manual_stop_command: listenerLaunchContract(packageVersion).stop_command,
      summary: result.status === "already_running"
        ? "Teami is already listening on this computer."
        : "Teami is now listening in the background for Planned projects in every active Team configured on this computer.",
    };
  }

  async function listener_stop(args = {}) {
    if (args.confirm !== true) {
      throw new ProjectMcpToolError(
        "confirmation_required",
        "listener_stop requires confirm: true after the adopter agrees to turn Teami off.",
      );
    }
    let result;
    try {
      result = await stopListener({ home });
    } catch (error) {
      throw new ProjectMcpToolError(
        "listener_stop_failed",
        `Teami did not stop cleanly: ${redactOAuthSecrets(error?.message || String(error || "unknown failure"))}`,
        { repair: `Run ${formatCommandForContext("gateway status", { packageVersion })}, then try again.` },
      );
    }
    if (!result?.ok) {
      if (result?.status === "foreground_owned") {
        throw new ProjectMcpToolError(
          "listener_foreground_owned",
          "Teami is running, but it is not managed by the background controller, so the agent did not terminate that process.",
          { repair: "If Teami is open in a terminal, press Ctrl-C there. If no such terminal exists, sign out or restart once. Future agent-started listeners can be turned off with listener_stop." },
        );
      }
      throw new ProjectMcpToolError(
        "listener_stop_failed",
        `Teami did not stop cleanly: ${redactOAuthSecrets(result?.reason || result?.status || "unknown failure")}`,
        { repair: `Run ${formatCommandForContext("gateway status", { packageVersion })}, then try again.` },
      );
    }
    const contract = listenerLaunchContract(packageVersion);
    if (result.status === "stopping") {
      return {
        ok: true,
        status: "stopping",
        running: true,
        manual_start_command: contract.start_command,
        summary: "Teami is finishing current work before it stops. Planned projects will wait safely after it exits.",
      };
    }
    return {
      ok: true,
      status: result.status,
      running: false,
      manual_start_command: contract.start_command,
      summary: result.status === "already_stopped"
        ? "Teami is already off."
        : "Teami is off. Planned projects will wait safely in Linear until it starts again.",
    };
  }

  async function project_create(args = {}) {
    const name = requiredString(args.name, "name");
    const description = optionalString(args.description);
    return withTeamAuthority(async () => {
      const prepared = await prepareLinear(args);
      const backlogStatusId = prepared.shape.projectStatuses?.backlog?.id;
      if (!backlogStatusId) {
        throw new ProjectMcpToolError("shape_unavailable", "Linear Backlog project status is not configured.");
      }

      const project = await prepared.mutations.createProject({
        name,
        ...(description ? { description } : {}),
        statusId: backlogStatusId,
      });
      await emitPlanningTrace({
        outcome: "created",
        project,
        context: prepared.context,
      });

      return {
        ok: true,
        project: publicProject(project),
        team: publicTeamContext(prepared.context),
        status: {
          role: "backlog",
          id: backlogStatusId,
        },
      };
    });
  }

  async function project_write_body(args = {}) {
    const projectId = requiredString(args.project_id || args.projectId, "project_id");
    const content = requiredProjectBodyContent(args);
    return withTeamAuthority(async () => {
      const prepared = await prepareLinear(args, { resolveShapeForStatus: false });
      const project = await prepared.mutations.updateProject(projectId, { content });

      return {
        ok: true,
        project: publicProject(project),
        team: publicTeamContext(prepared.context),
        content_length: content.length,
      };
    });
  }

  async function project_move_status(args = {}) {
    const projectId = requiredString(args.project_id || args.projectId, "project_id");
    if (args.confirm !== true) {
      throw new ProjectMcpToolError(
        "confirmation_required",
        "project_move_status requires confirm: true before moving a project to Planned.",
      );
    }

    return withTeamAuthority(async () => {
      const prepared = await prepareLinear(args);
      const plannedStatusId = prepared.shape.projectStatuses?.planned?.id;
      if (!plannedStatusId) {
        throw new ProjectMcpToolError("shape_unavailable", "Linear Planned project status is not configured.");
      }

      const project = await prepared.mutations.updateProject(projectId, { statusId: plannedStatusId });
      await emitPlanningTrace({
        outcome: "committed",
        project,
        context: prepared.context,
        planningTelemetry: normalizePlanningTelemetry(args.planning_telemetry),
      });
      return {
        ok: true,
        project: publicProject(project),
        team: publicTeamContext(prepared.context),
        status: {
          role: "planned",
          id: plannedStatusId,
        },
      };
    });
  }

  async function withTeamAuthority(operation) {
    const authority = acquireTeamAuthority({ home, installHandlers: false });
    if (!authority.ok) {
      throw new ProjectMcpToolError(
        "team_authority_busy",
        "Another Teami planning, review, setup, or gateway operation is active; wait for it to finish, then retry.",
        { repair: "Wait for the current Team operation to finish, then retry the planning action." },
      );
    }
    try {
      return await operation();
    } finally {
      authority.release();
    }
  }

  async function prepareLinear(args = {}, { resolveShapeForStatus = true } = {}) {
    const { context, cache, config: teamConfig } = resolveTeamCache(args);
    const client = await resolveClient({ context, config: teamConfig });
    const shape = resolveShapeForStatus
      ? await resolveShape({ client, config: teamConfig, cache })
      : null;
    const mutations = createTeamConfinedPlanningMutations({
      client,
      context,
      createError: (code, message, repair) => new ProjectMcpToolError(code, message, { repair }),
    });
    return { context, cache, config: teamConfig, client, mutations, shape };
  }

  function resolveTeamCache(args = {}) {
    return resolveForegroundTeamCache({
      config: baseConfig,
      repoRoot,
      registry,
      teamRef: optionalString(args.team || args.team_ref || args.teamRef),
      readCache,
    });
  }

  async function resolveClient({ context, config: teamConfig }) {
    if (linearClient) return linearClient;
    if (linearClientFactory) {
      return linearClientFactory({ context, config: teamConfig, repoRoot });
    }
    const credentialStore = createCredentialStore({
      config: teamConfig,
      teamContext: context,
      repoRoot,
    });
    const { client } = createSetupGraphqlClient({
      config: teamConfig,
      repoRoot,
      credentialStore,
      allowBrowserAuth: false,
      allowRefresh: false,
    });
    return client;
  }

  function emitPlanningTrace({ outcome, project, context, planningTelemetry = null } = {}) {
    const emission = Promise.resolve().then(() => emitPlanningSessionTrace({
      repoRoot,
      traceSink: planningTraceSink,
      createTraceSink: createPlanningTraceSink,
      context,
      project,
      outcome,
      planningTelemetry,
    }));
    if (awaitPlanningTraceEmission) return emission;
    void emission;
    return null;
  }

  return Object.freeze({
    init_onboarding,
    check_team_context,
    listener_status,
    listener_start,
    listener_stop,
    project_create,
    project_write_body,
    project_move_status,
  });
}

async function beginInitOnboardingAuthorization({
  args,
  config,
  openBrowser,
  fetchImpl,
  startAuthorization,
  setupStore,
  authorizationSessions,
  existingTokenSet = null,
  setupOwner,
  isSetupOwnerProcessAlive = null,
} = {}) {
  if (Object.hasOwn(args || {}, "linear_team_id") || Object.hasOwn(args || {}, "linear_team_confirm")) {
    return {
      ok: false,
      status: "blocked",
      reason: "linear_team_selection_not_requested",
      repair: "Start setup without a Linear team selection. Teami will offer the safe existing-team choices only if Linear refuses to create the dedicated team.",
    };
  }
  if (Object.hasOwn(args || {}, "linear_workspace_replace_confirm")) {
    return {
      ok: false,
      status: "blocked",
      reason: "linear_workspace_replacement_not_requested",
      repair: "Start setup normally. Teami will ask this question only after Linear authorizes a different workspace than the saved Team.",
    };
  }
  const input = normalizeInitOnboardingInput(args);
  const consent = verifySetupConsent({
    confirm: args.confirm,
    disclosureVersion: args.disclosure_version,
    disclosureHash: args.disclosure_hash,
  });
  if (!consent.ok) {
    return {
      ok: false,
      status: consent.status,
      reason: consent.reason,
      disclosure: consent.disclosure,
      next_steps: ["Show the disclosure to the adopter and call init_onboarding again only after explicit confirmation."],
    };
  }
  if (setupStore.readAdminRevocationRequirement?.() || setupStore.readGlobalAdminRevocationRequired?.()) {
    return {
      ok: false,
      status: "blocked",
      reason: "admin_revocation_required",
      repair: adminRevocationRecoveryInstruction(),
    };
  }

  const lock = setupStore.acquire({ purpose: "setup" });
  if (!lock.ok) return setupLockHeldResult(lock);
  try {
    const active = setupStore.findActive?.();
    const activeOwnerAlive = active
      ? isSetupOwnerAlive(active, {
          ...(isSetupOwnerProcessAlive ? { checkProcess: isSetupOwnerProcessAlive } : {}),
        })
      : null;
    if (active && !authorizationSessions.has(active.setup_id) && activeOwnerAlive === false &&
        !active.admin_revocation_required) {
      setupStore.recordPhase(active.setup_id, "linear", {
        status: "blocked",
        reason: "authorization_process_restarted",
        setupStatus: "blocked",
      });
    } else if (active) {
      return {
        ok: false,
        status: "blocked",
        reason: "setup_session_active",
        setup_id: active.setup_id,
        repair: "Resume the active setup with setup_id, or wait for its authorization URL to expire before starting another setup.",
      };
    }
    const state = setupStore.start({
      input: {
        ...input,
        repo_intent: input.repo_intent,
        github_replacement_explicit: input.github_replacement_explicit === true,
      },
      consent: {
        confirmed: true,
        version: consent.version,
        hash: consent.hash,
      },
      owner: setupOwner,
    });
    if (existingTokenSet) {
      authorizationSessions.set(state.setup_id, {
        kind: "app",
        session: null,
        status: "fulfilled",
        tokenSet: existingTokenSet,
        error: null,
      });
      setupStore.recordPhase(state.setup_id, "linear", {
        status: "healthy",
        reason: "existing_team_authorization_reused",
        setupStatus: "running",
      });
      return { ok: false, status: "authorization_reused", setup_id: state.setup_id };
    }
    const progress = [];
    let session;
    try {
      session = await startAuthorization({
        config,
        fetchImpl,
        ...(openBrowser ? { openBrowser } : {}),
        onProgress: (line) => progress.push(String(line || "")),
      });
    } catch (error) {
      setupStore.recordPhase(state.setup_id, "linear", {
        status: "blocked",
        reason: "linear_authorization_start_failed",
        setupStatus: "blocked",
      });
      return {
        ok: false,
        status: "blocked",
        setup_id: state.setup_id,
        reason: "linear_authorization_start_failed",
        detail: redactOAuthSecrets(error?.message || String(error || "authorization listener failed")),
        repair: "Close any process using Teami's local callback ports, then start setup again for a fresh authorization URL.",
      };
    }
    const tracked = {
      kind: "app",
      session,
      status: "pending",
      tokenSet: null,
      error: null,
    };
    authorizationSessions.set(state.setup_id, tracked);
    session.waitForToken().then((tokenSet) => {
      tracked.status = "fulfilled";
      tracked.tokenSet = tokenSet;
    }, (error) => {
      tracked.status = "rejected";
      tracked.error = error;
    });
    setupStore.recordPhase(state.setup_id, "linear", {
      status: "awaiting_authorization",
      reason: "linear_browser_callback_pending",
      setupStatus: "awaiting_authorization",
    });
    return authorizationAwaitingResult({ setupId: state.setup_id, session, progress });
  } finally {
    lock.release();
  }
}

async function resumeInitOnboardingAuthorization({
  setupId,
  args,
  authorizationSessions,
  setupStore,
  config,
  openBrowser,
  fetchImpl,
  startAdminAuthorization,
  adminGrantUseWindowMs,
  runSetup,
  onSetupProgress,
  packageVersion = TEAMI_PACKAGE_VERSION,
} = {}) {
  const state = setupStore.read(setupId);
  if (!state) {
    return {
      ok: false,
      status: "blocked",
      reason: "setup_id_not_found",
      repair: "Start setup again; Teami will create a fresh authorization URL.",
    };
  }
  if (state.status === "complete" && !state.admin_revocation_required) {
    return completedSetupStateResult(state);
  }
  if (state.consent?.version !== SETUP_DISCLOSURE_VERSION || state.consent?.hash !== SETUP_DISCLOSURE_HASH) {
    discardTrackedAuthorizationSession(authorizationSessions, setupId);
    setupStore.recordPhase(setupId, "linear", {
      status: "blocked",
      reason: "setup_disclosure_changed",
      setupStatus: "blocked",
    });
    return {
      ok: false,
      status: "blocked",
      setup_id: setupId,
      reason: "setup_disclosure_changed",
      repair: "Setup's effects changed since consent was recorded. Start setup again and review the current disclosure before continuing.",
    };
  }
  let tracked = authorizationSessions.get(setupId);
  if (state.admin_revocation_required && tracked?.kind !== "admin") {
    return tracked
      ? adminRevocationRequiredResult(setupId)
      : adminAuthorizationProcessRestartedResult(setupId);
  }
  if (Date.parse(state.expires_at) <= Date.now()) {
    if (tracked?.kind === "admin" && tracked.adminGrant) {
      await teardownTrackedAdminGrant({ tracked, setupStore, setupId });
    }
    discardTrackedAuthorizationSession(authorizationSessions, setupId);
    setupStore.recordPhase(setupId, "linear", {
      status: "blocked",
      reason: "setup_session_expired",
      setupStatus: "blocked",
    });
    return {
      ok: false,
      status: "blocked",
      setup_id: setupId,
      reason: "setup_session_expired",
      repair: "Start setup again; Teami will create a fresh authorization URL.",
    };
  }
  if (!tracked && canResumeAfterDurableLinearSetup(state)) {
    // Linear's ordinary app credential was already promoted durably before later phases ran.
    // Re-enter through the same idempotent setup engine without retaining the original token in
    // setup state or process memory. The engine resolves the complete team credential itself.
    tracked = {
      kind: "app",
      session: null,
      status: "fulfilled",
      tokenSet: null,
      error: null,
      resumedFromDurableLinear: true,
    };
  }
  if (!tracked) {
    setupStore.recordPhase(setupId, "linear", {
      status: "blocked",
      reason: "authorization_process_restarted",
      setupStatus: "blocked",
    });
    return {
      ok: false,
      status: "blocked",
      setup_id: setupId,
      reason: "authorization_process_restarted",
      repair: "The prior callback listener is no longer alive. Start setup again for a fresh URL; no OAuth secret was persisted in setup state.",
    };
  }
  if (tracked.status === "pending") {
    return authorizationAwaitingResult({
      setupId,
      session: tracked.session,
      kind: tracked.kind === "admin" ? "linear_admin" : "linear_app",
    });
  }
  if (tracked.status === "rejected") {
    const failure = tracked.kind === "admin"
      ? classifyAdminAuthorizationSessionFailure(tracked.error)
      : classifyAuthorizationSessionFailure(tracked.error);
    setupStore.recordPhase(setupId, "linear", {
      status: "blocked",
      reason: failure.reason,
      setupStatus: "blocked",
    });
    authorizationSessions.delete(setupId);
    return { ok: false, status: "blocked", setup_id: setupId, ...failure };
  }

  if (
    tracked.kind === "app" &&
    tracked.workspaceReplacement &&
    !tracked.linearWorkspaceReplacementConfirmed
  ) {
    if (args.linear_workspace_replace_confirm !== true) {
      return workspaceReplacementRequiredResult({
        setupId,
        savedTeam: tracked.workspaceReplacement.savedTeam,
        authorizedWorkspace: tracked.workspaceReplacement.authorizedWorkspace,
      });
    }
    tracked.linearWorkspaceReplacementConfirmed = true;
  }

  let selectedLinearTeam = null;
  if (tracked.kind === "app" && state.status === "team_selection_required") {
    const teams = Array.isArray(tracked.availableLinearTeams) ? tracked.availableLinearTeams : [];
    const selectedTeamId = optionalString(args.linear_team_id);
    selectedLinearTeam = teams.find((team) => team.id === selectedTeamId) || null;
    if (!selectedLinearTeam || args.linear_team_confirm !== true) {
      return linearTeamSelectionRequiredResult({
        setupId,
        workspace: tracked.linearWorkspace,
        teams,
        ...(selectedTeamId && !selectedLinearTeam ? { reason: "linear_team_selection_invalid" } : {}),
      });
    }
    setupStore.update(setupId, (next) => {
      next.input.linear_team_id = selectedLinearTeam.id;
      next.input.linear_team_confirm = true;
      return next;
    });
  }

  if (tracked.kind === "app" && state.status === "admin_consent_required" && args.admin_confirm === true) {
    return beginAdminAuthorizationSession({
      setupId,
      trackedApp: tracked,
      authorizationSessions,
      setupStore,
      config,
      openBrowser,
      fetchImpl,
      startAdminAuthorization,
      adminGrantUseWindowMs,
    });
  }

  const lock = setupStore.acquire({ purpose: "setup" });
  if (!lock.ok) return setupLockHeldResult(lock, setupId);
  try {
    const setupArgs = {
      ...persistedSetupArgs(state.input),
      ...(optionalString(args.github_owner) ? { github_owner: optionalString(args.github_owner) } : {}),
      ...(optionalString(args.github_repo) ? { github_repo: optionalString(args.github_repo) } : {}),
      ...(selectedLinearTeam
        ? { linear_team_id: selectedLinearTeam.id, linear_team_confirm: true }
        : {}),
      ...(tracked.linearWorkspaceReplacementConfirmed
        ? { linear_workspace_replace_confirm: true }
        : {}),
    };
    try {
      onSetupProgress?.({
        phase: "post_authorization",
        message: "Authorization approved; finishing setup",
      });
      const result = await runSetup(
        setupArgs,
        tracked.kind === "admin" ? tracked.appTokenSet : tracked.tokenSet,
        tracked.kind === "admin" ? tracked : null,
      );
      if (tracked.kind === "admin" && !tracked.grantConsumed && setupStore.read(setupId).admin_revocation_required) {
        await teardownTrackedAdminGrant({ tracked, setupStore, setupId });
      }
      authorizationSessions.delete(setupId);
      const persisted = setupStore.read(setupId);
      if (persisted.admin_revocation_required) return adminRevocationRequiredResult(setupId);
      setupStore.update(setupId, (next) => {
        next.status = result.status;
        return next;
      });
      return {
        ...result,
        setup_id: setupId,
      };
    } catch (error) {
      if (
        tracked.kind === "app" &&
        error?.code === "workspace_mismatch" &&
        error?.savedTeam &&
        !tracked.linearWorkspaceReplacementConfirmed
      ) {
        tracked.workspaceReplacement = {
          savedTeam: structuredClone(error.savedTeam),
          authorizedWorkspace: structuredClone(error.grantedWorkspace || {}),
        };
        setupStore.recordPhase(setupId, "linear", {
          status: "input_required",
          reason: "workspace_mismatch",
          setupStatus: "blocked",
        });
        return workspaceReplacementRequiredResult({
          setupId,
          savedTeam: tracked.workspaceReplacement.savedTeam,
          authorizedWorkspace: tracked.workspaceReplacement.authorizedWorkspace,
        });
      }
      if (error?.setupIncompleteCause === "linear_team_limit_reached" &&
          Array.isArray(error.availableTeams) && error.availableTeams.length > 0) {
        tracked.availableLinearTeams = error.availableTeams;
        tracked.linearWorkspace = error.workspace || null;
        setupStore.recordPhase(setupId, "linear", {
          status: "input_required",
          reason: "linear_team_limit_reached",
          setupStatus: "team_selection_required",
        });
        return linearTeamSelectionRequiredResult({
          setupId,
          workspace: tracked.linearWorkspace,
          teams: tracked.availableLinearTeams,
        });
      }
      if (error instanceof ProjectMcpToolError && error.code === "admin_consent_required") {
        setupStore.recordPhase(setupId, "linear", {
          status: "consent_required",
          reason: "one_shot_admin_consent_required",
          setupStatus: "admin_consent_required",
        });
        return {
          ok: false,
          status: "admin_consent_required",
          setup_id: setupId,
          reason: "one_shot_admin_consent_required",
          disclosure: setupEffectsDisclosure().effects.find((effect) => effect.id === "linear_admin_exception"),
          next_steps: ["Ask the adopter for explicit confirmation, then call init_onboarding with setup_id and admin_confirm: true."],
        };
      }
      if (tracked.kind === "admin" && !tracked.grantConsumed) {
        await teardownTrackedAdminGrant({ tracked, setupStore, setupId });
      }
      const sanitized = sanitizeProjectMcpError(error, { packageVersion });
      const reason = sanitized.error?.code || "setup_failed";
      if (error?.durableLinear === true) {
        setupStore.recordPhase(setupId, "linear", { status: "healthy", reason: "linear_setup_verified" });
        setupStore.recordPhase(setupId, "product_repos", {
          status: "healthy",
          reason: state.input.repo_intent.mode,
        });
        setupStore.recordPhase(setupId, error.phase || "github", {
          status: "blocked",
          reason,
          setupStatus: "blocked",
        });
      } else {
        setupStore.recordPhase(setupId, "linear", { status: "blocked", reason, setupStatus: "blocked" });
      }
      authorizationSessions.delete(setupId);
      return { ...sanitized, status: "blocked", setup_id: setupId, reason };
    }
  } finally {
    lock.release();
  }
}

async function beginAdminAuthorizationSession({
  setupId,
  trackedApp,
  authorizationSessions,
  setupStore,
  config,
  openBrowser,
  fetchImpl,
  startAdminAuthorization,
  adminGrantUseWindowMs = ADMIN_GRANT_USE_WINDOW_MS,
} = {}) {
  const lock = setupStore.acquire({ purpose: "setup-admin-authorization" });
  if (!lock.ok) return setupLockHeldResult(lock, setupId);
  try {
    // Persist only the fact that elevated authority may now exist. The grant, code, and PKCE
    // material remain exclusively inside the live callback session below.
    setupStore.markAdminRevocationRequired(setupId);
    setupStore.markGlobalAdminRevocationRequired({ surface: "mcp" });
    let session;
    try {
      session = await startAdminAuthorization({
        config,
        fetchImpl,
        ...(openBrowser ? { openBrowser } : {}),
      });
    } catch (error) {
      setupStore.recordPhase(setupId, "linear", {
        status: "blocked",
        reason: "admin_authorization_start_failed",
        setupStatus: "blocked",
      });
      return {
        ok: false,
        status: "blocked",
        setup_id: setupId,
        reason: "admin_authorization_start_failed",
        repair: "Review and revoke Teami admin access in Linear Settings -> Applications, then start setup again.",
      };
    }
    const tracked = {
      kind: "admin",
      session,
      status: "pending",
      appTokenSet: trackedApp.tokenSet,
      workspaceReplacement: trackedApp.workspaceReplacement || null,
      linearWorkspaceReplacementConfirmed:
        trackedApp.linearWorkspaceReplacementConfirmed === true,
      adminGrant: null,
      grantConsumed: false,
      grantUseTimer: null,
      error: null,
    };
    authorizationSessions.set(setupId, tracked);
    session.waitForGrant().then((grant) => {
      tracked.status = "fulfilled";
      tracked.adminGrant = grant;
      tracked.grantUseTimer = setTimeout(async () => {
        if (tracked.grantConsumed || tracked.status !== "fulfilled") return;
        const teardown = await teardownTrackedAdminGrant({ tracked, setupStore, setupId });
        const error = new Error("The one-shot admin grant use window expired before setup resumed.");
        error.code = "admin_grant_use_window_expired";
        error.revokeVerified = teardown?.revokeVerified === true;
        tracked.status = "rejected";
        tracked.error = error;
      }, adminGrantUseWindowMs);
      tracked.grantUseTimer.unref?.();
    }, (error) => {
      tracked.status = "rejected";
      tracked.error = error;
    });
    setupStore.recordPhase(setupId, "linear", {
      status: "awaiting_authorization",
      reason: "linear_admin_browser_callback_pending",
      setupStatus: "awaiting_authorization",
    });
    return authorizationAwaitingResult({ setupId, session, kind: "linear_admin" });
  } finally {
    lock.release();
  }
}

async function teardownTrackedAdminGrant({ tracked, setupStore, setupId } = {}) {
  if (tracked?.grantUseTimer) {
    clearTimeout(tracked.grantUseTimer);
    tracked.grantUseTimer = null;
  }
  if (!tracked?.adminGrant?.teardown) return { revokeVerified: false };
  let result;
  try {
    result = await tracked.adminGrant.teardown();
  } catch {
    result = { revokeVerified: false };
  }
  if (result?.revokeVerified === true) {
    setupStore.clearAdminRevocationRequired(setupId, { revokeVerified: true });
    setupStore.clearGlobalAdminRevocationRequired({ revokeVerified: true });
  }
  return result;
}

function canResumeAfterDurableLinearSetup(state) {
  return ["blocked", "degraded", "running"].includes(state?.status) &&
    state?.phases?.linear?.status === "healthy";
}

function completedSetupStateResult(state) {
  return {
    ok: true,
    status: "complete",
    setup_id: state.setup_id,
    steps: Object.fromEntries(Object.entries(state.phases || {}).map(([phase, receipt]) => [
      phase,
      {
        ok: receipt?.status === "healthy",
        status: receipt?.status || "pending",
        reason: receipt?.reason || null,
      },
    ])),
    health: { ok: true, status: "complete" },
    next_steps: [],
  };
}

function initOnboardingNeedsResult({ teamName = DEFAULT_SETUP_TEAM_NAME, teamRequired = false } = {}) {
  const needs = [];
  if (teamRequired) {
    needs.push({
      field: "team",
      required: true,
      question: "Ask which existing Teami team to repair.",
    });
  }
  needs.push({
    field: "confirm",
    required: true,
    question: "Summarize the setup changes in plain language and ask for explicit confirmation.",
  });
  return {
    ok: false,
    status: "consent_required",
    disclosure: setupEffectsDisclosure(),
    defaults: {
      team: teamName || null,
      product_repositories: "none",
    },
    needs,
    next_steps: [
      "Tell the adopter that product repositories stay disconnected during setup.",
      `After explicit confirmation, call init_onboarding with confirm: true, disclosure_version: ${SETUP_DISCLOSURE_VERSION}, and disclosure_hash: ${SETUP_DISCLOSURE_HASH}.`,
    ],
  };
}

function inferredSetupTeamName(registry = emptyTeamRegistry()) {
  const teams = (registry?.teams || []).filter((team) => team?.status !== "removed");
  if (teams.length === 0) return DEFAULT_SETUP_TEAM_NAME;
  if (teams.length === 1) return teams[0].adopter_provided_name || teams[0].id || DEFAULT_SETUP_TEAM_NAME;
  return null;
}

function authorizationAwaitingResult({ setupId, session, progress = [], kind = "linear_app" } = {}) {
  const browser = session.browser || { opened: null, reason: null };
  const isAdmin = kind === "linear_admin";
  return {
    ok: false,
    status: "awaiting_authorization",
    setup_id: setupId,
    authorization_url: session.authorizationUrl,
    authorization: {
      kind,
      url: session.authorizationUrl,
      expires_at: session.expiresAt,
      browser_opened: browser.opened,
      ...(browser.reason ? { browser_error: browser.reason } : {}),
    },
    recovery: {
      browser_not_opened: "Open authorization_url manually; the local callback listener is already waiting.",
      installed_app: isAdmin
        ? "If Linear does not redirect after admin approval, review and revoke Teami under Linear Settings -> Applications before restarting setup."
        : "Linear can say \"Teami already installed\" when the workspace still has an old workspace-scoped Teami installation but this computer no longer has its matching grant. Removing it disconnects Teami for everyone in that Linear workspace, so coordinate first in a shared workspace. Then click Manage, use the ... menu beside Teami to remove it, return to the authorization tab, and refresh it while this setup session is still open.",
      expired: isAdmin
        ? "If this admin URL expires, review and revoke Teami admin access before restarting. Teami never persists the admin grant, OAuth code, or PKCE material."
        : "If this URL expires, start setup again. Teami never persists OAuth codes or PKCE material in setup state.",
      resume: "Call init_onboarding again with setup_id after the browser redirects back to Teami.",
    },
    ...(progress.length > 0 ? { progress: progress.filter(Boolean) } : {}),
  };
}

function linearTeamSelectionRequiredResult({
  setupId,
  workspace = null,
  teams = [],
  reason = "linear_team_limit_reached",
} = {}) {
  const choices = teams.map((team) => ({
    id: team.id,
    key: team.key || null,
    name: team.name,
  }));
  return {
    ok: false,
    status: "team_selection_required",
    setup_id: setupId,
    reason,
    ...(workspace ? { workspace } : {}),
    teams: choices,
    effects: [
      "Teami will add or reconcile its issue labels and workflow statuses in the team you select.",
      "Teami will not delete existing issues or projects.",
      "Choose a dedicated or unused team if possible.",
    ],
    needs: [
      {
        field: "linear_team_id",
        required: true,
        choices,
        question: "Ask the adopter which existing Linear team Teami may configure.",
      },
      {
        field: "linear_team_confirm",
        required: true,
        question: "Continue only after the adopter explicitly approves the selected team's listed effects.",
      },
    ],
    next_steps: [
      "Explain the effects and choices in plain language.",
      "After explicit approval, call init_onboarding with this setup_id, linear_team_id, and linear_team_confirm: true.",
    ],
  };
}

function workspaceReplacementRequiredResult({
  setupId,
  savedTeam = {},
  authorizedWorkspace = {},
} = {}) {
  const teamName = savedTeam.name || savedTeam.ref || "the saved Team";
  const savedWorkspace = savedTeam.workspace_name || savedTeam.workspace_id || "the saved workspace";
  const nextWorkspace = authorizedWorkspace.name || authorizedWorkspace.id || "the workspace just authorized";
  return {
    ok: false,
    status: "workspace_replacement_required",
    setup_id: setupId,
    reason: "workspace_mismatch",
    saved_team: structuredClone(savedTeam),
    authorized_workspace: structuredClone(authorizedWorkspace),
    question: `Use "${nextWorkspace}" for Team "${teamName}" instead of "${savedWorkspace}"?`,
    effects: [
      `Teami will replace Team "${teamName}"'s saved local Linear connection with "${nextWorkspace}".`,
      "Product-repository access will not carry across the workspace boundary.",
      `Nothing will be deleted or changed in Linear workspace "${savedWorkspace}".`,
      "Setup will continue with the browser approval already completed.",
    ],
    needs: [{
      field: "linear_workspace_replace_confirm",
      required: true,
      question: "Ask the adopter this one yes/no question and continue only after explicit confirmation.",
    }],
    next_steps: [
      "After explicit approval, call init_onboarding with this setup_id and linear_workspace_replace_confirm: true.",
    ],
  };
}

function setupLockHeldResult(lock, setupId = null) {
  return {
    ok: false,
    status: "blocked",
    ...(setupId ? { setup_id: setupId } : {}),
    reason: "setup_lock_held",
    ...(lock.reason ? { lock_reason: lock.reason } : {}),
    repair: "Another CLI or conversational setup is active. Wait for it to finish, then resume this setup.",
  };
}

function adminRevocationRequiredResult(setupId) {
  return {
    ok: false,
    status: "blocked",
    ...(setupId ? { setup_id: setupId } : {}),
    reason: "admin_revocation_required",
    repair: adminRevocationRecoveryInstruction(),
  };
}

function adminRevocationRecoveryInstruction() {
  return "Teami cannot prove the interrupted one-time Linear admin token was revoked. Open Linear Settings -> Applications and revoke Teami access. A fresh token cannot prove the lost token is gone, so Teami will not clear this marker automatically; after external revocation, uninstall the blocked local state and start setup again.";
}

function discardTrackedAuthorizationSession(authorizationSessions, setupId) {
  const tracked = authorizationSessions.get(setupId);
  if (!tracked) return false;
  if (tracked.grantUseTimer) clearTimeout(tracked.grantUseTimer);
  try {
    tracked.session?.close?.();
  } catch {
    // External revocation is already adopter-confirmed; local close is memory hygiene only.
  }
  tracked.adminGrant = null;
  tracked.appTokenSet = null;
  tracked.tokenSet = null;
  authorizationSessions.delete(setupId);
  return true;
}

function adminAuthorizationProcessRestartedResult(setupId) {
  return {
    ok: false,
    status: "blocked",
    setup_id: setupId,
    reason: "admin_authorization_process_restarted",
    repair: `The one-time admin callback listener is no longer alive. ${adminRevocationRecoveryInstruction()} No admin token, OAuth code, or PKCE material was persisted in setup state.`,
  };
}

function classifyAuthorizationSessionFailure(error) {
  const message = redactOAuthSecrets(error?.message || String(error || "authorization failed"));
  if (/timed out waiting for Linear OAuth authorization callback/i.test(message)) {
    return {
      reason: "linear_authorization_expired",
      repair: "Start setup again for a fresh authorization URL.",
    };
  }
  if (/already installed/i.test(message)) {
    return {
      reason: "linear_app_already_installed_no_callback",
      repair: "Remove Teami under Linear Settings -> Applications, then start setup again for a fresh URL.",
    };
  }
  return {
    reason: "linear_authorization_failed",
    repair: "Start setup again for a fresh authorization URL. If the workspace was wrong, select the intended workspace in Linear's consent screen.",
  };
}

function classifyAdminAuthorizationSessionFailure(error) {
  const message = redactOAuthSecrets(error?.message || String(error || "admin authorization failed"));
  if (error?.code === "admin_grant_use_window_expired") {
    return error.revokeVerified === true
      ? {
          reason: "linear_admin_grant_use_window_expired",
          repair: "The unused admin grant was automatically revoked. Start setup again when you are ready to finish the approval immediately.",
        }
      : {
          reason: "linear_admin_grant_use_window_expired",
          repair: "The unused admin grant expired locally, but remote revocation was unverified. Review and revoke Teami admin access in Linear Settings -> Applications before restarting setup.",
        };
  }
  if (/timed out waiting for Linear OAuth authorization callback/i.test(message)) {
    return {
      reason: "linear_admin_authorization_expired",
      repair: "Review and revoke Teami admin access in Linear Settings -> Applications, then start setup again with a fresh URL.",
    };
  }
  return {
    reason: "linear_admin_authorization_failed",
    repair: "Review and revoke Teami admin access in Linear Settings -> Applications, then start setup again.",
  };
}

function persistedSetupArgs(input = {}) {
  return {
    team: input.team,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    repo_intent: input.repo_intent,
    repos: input.repo_intent?.repos || [],
    ...(input.github_owner ? { github_owner: input.github_owner } : {}),
    ...(input.github_repo ? { github_repo: input.github_repo } : {}),
    ...(input.github_dry_run ? { github_dry_run: true } : {}),
    ...(input.github_replacement_explicit ? { github_replacement_explicit: true } : {}),
    ...(input.linear_team_id ? { linear_team_id: input.linear_team_id } : {}),
    ...(input.linear_team_confirm ? { linear_team_confirm: true } : {}),
  };
}

async function runInitOnboardingSetup({
  args,
  config,
  repoRoot,
  home,
  registry = null,
  readCache = readLinearCache,
  createCredentialStore = createLinearCredentialStore,
  createBootstrapCredentialStore = createBootstrapLinearCredentialStore,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  createLinearSetupAuth = null,
  authorizeLinearBrowser = authorizeWithBrowser,
  authorizeOneShotAdmin = authorizeOneShotLinearAdmin,
  openBrowser = undefined,
  fetchImpl = globalThis.fetch,
  runGitHubPhase = runGitHubInitPhase,
  githubInitTransportFromFlags = githubSetupTransportFromFlags,
  githubSetupTransport = null,
  githubDiscoveryRunCommand = null,
  runGit = null,
  runClaudePluginRegistration = runClaudePluginRegistrationStep,
  claudePluginRunCommand = null,
  claudePluginMarketplaceSource = undefined,
  setupStore = null,
  setupId = null,
  adminConfirm = false,
  ensurePhoenix = ensurePhoenixReady,
  runPhoenixPreflight = runLocalPhoenixTracePreflight,
  runRuntimeSmoke = runRuntimeSmokeChecks,
  runSetupDoctor = doctorGraphqlLinear,
  promptLinearWorkspaceConfirmation = autoProceedReauthorizationPrompt,
  githubReplacementExplicit = false,
} = {}) {
  const input = normalizeInitOnboardingInput(args);
  const progress = [];
  let authorizationUrl = null;
  const recordAuthorizationUrl = (url) => {
    const value = optionalString(url);
    if (value && !authorizationUrl) authorizationUrl = value;
  };
  const log = (line) => {
    const text = String(line || "");
    if (text) progress.push(text);
    const url = authorizationUrlFromProgress(text);
    if (url) recordAuthorizationUrl(url);
  };

  const currentRegistry = registry || readTeamRegistry({ home }) || emptyTeamRegistry();
  const initArgs = ["--team", input.team, ...(input.workspace ? ["--workspace", input.workspace] : [])];
  const teamNameResolution = resolveSetupCommandTeamNameHint(initArgs, currentRegistry);
  const resumeTeam = teamNameResolution.resumeTeam || teamNameResolution.completeResumeTeam || null;
  const completeResumeTeam = teamNameResolution.completeResumeTeam || null;
  const replacingWorkspace = Boolean(
    completeResumeTeam && input.linear_workspace_replace_confirm === true,
  );
  const authorizationRegistry = registryWithoutRemovedTeamsForName(currentRegistry, input.team);
  const resumeCredentialTeam = teamHasLinearCredentialIdentity(resumeTeam) ? resumeTeam : null;
  const resumeContext = resumeCredentialTeam
    ? buildTeamContext({ team: resumeCredentialTeam, config, repoRoot, home })
    : null;
  const credentialStore = resumeContext
    ? createCredentialStore({ config, repoRoot, home, teamContext: resumeContext })
    : createBootstrapCredentialStore({ config, repoRoot, home });
  const obsoleteBootstrapStore = !completeResumeTeam && resumeContext
    ? createBootstrapCredentialStore({ config, repoRoot, home })
    : null;
  const obsoleteBootstrapToken = obsoleteBootstrapStore
    ? await obsoleteBootstrapStore.readTokenSet()
    : null;
  const setupAuthFactory = createLinearSetupAuth || ((options) => createSetupGraphqlClient(options));
  const setupFlags = setupFlagsForInitOnboarding(input);
  const promptAdminProvisioning = async () => {
    if (adminConfirm !== true) {
      throw new ProjectMcpToolError(
        "admin_consent_required",
        "Principal Escalation is missing. Explicit just-in-time confirmation is required before Teami opens one-shot Linear admin authorization.",
      );
    }
    if (!setupStore || !setupId) throw new Error("setup_admin_marker_store_required");
    setupStore.markAdminRevocationRequired(setupId);
    setupStore.markGlobalAdminRevocationRequired({ surface: "mcp" });
    return "";
  };
  const authorizeAdminWithRevocationProof = async (options = {}) => {
    const grant = await authorizeOneShotAdmin({
      ...options,
      fetchImpl,
      authorize: authorizeLinearBrowser,
      ...(openBrowser ? { openBrowser } : {}),
      onAuthorizationUrl: recordAuthorizationUrl,
    });
    return {
      ...grant,
      async teardown() {
        const result = await grant.teardown?.();
        if (result?.revokeVerified === true) {
          setupStore.clearAdminRevocationRequired(setupId, { revokeVerified: true });
          setupStore.clearGlobalAdminRevocationRequired({ revokeVerified: true });
        }
        return result;
      },
    };
  };

  const workspaceAuthorization = await authorizeLinearSetupWorkspace({
    config,
    repoRoot,
    credentialStore,
    registry: authorizationRegistry,
    flags: setupFlags,
    env: process.env,
    teamNameHint: input.team,
    resumeTeam,
    isTTY: true,
    log,
    createSetupAuth: (options) => setupAuthFactory({
      ...options,
      fetchImpl,
      authorize: authorizeLinearBrowser,
      ...(openBrowser ? { openBrowser } : {}),
      onAuthorizationUrl: recordAuthorizationUrl,
    }),
    authorizeOneShotAdmin: authorizeAdminWithRevocationProof,
    promptAdminProvisioning,
    promptReauthorize: promptLinearWorkspaceConfirmation,
    allowWorkspaceReplacement: replacingWorkspace,
  });

  let linearResult = await setupLinearTeam({
    client: workspaceAuthorization.setupAuth.client,
    config,
    registry: currentRegistry,
    repoRoot,
    home,
    teamName: input.team,
    cache: resumeContext ? readCache(resumeContext.linear.cachePath) : null,
    resumeTeam,
    workspace: workspaceAuthorization.workspace,
    declaredWorkspace: workspaceAuthorization.declaredWorkspace,
    replaceWorkspaceConfirmed: replacingWorkspace,
    ensureNeedsPrincipalProjectStatus: () => ensureNeedsPrincipalProjectStatus({
      appClient: workspaceAuthorization.setupAuth.client,
      adminAuth: () => authorizeAdminWithRevocationProof({
        config,
        fetchImpl,
        authorize: authorizeLinearBrowser,
        ...(openBrowser ? { openBrowser } : {}),
        onAuthorizationUrl: recordAuthorizationUrl,
        onProgress: log,
      }),
      log,
      interactive: true,
      prompt: promptAdminProvisioning,
    }),
    writeCache: (nextCache, context) => {
      writeLinearCache(context.linear.cachePath, nextCache);
    },
    writeRegistry: createAtomicTeamRegistryWriter({ home, initialRegistry: currentRegistry }),
    promoteCredential: resumeContext
      ? async () => {
          if (obsoleteBootstrapToken) {
            await obsoleteBootstrapStore.deleteTokenSetIfEqual(obsoleteBootstrapToken);
          }
        }
      : ({ context }) => promoteSetupCredentialToTeam({
          setupCredentialStore: credentialStore,
          config,
          repoRoot,
          home,
          teamContext: context,
        }),
    onPreview: log,
    selectedExistingTeamId: input.linear_team_confirm === true ? input.linear_team_id : null,
  });

  const allowlistUpdate = completeResumeTeam && !replacingWorkspace
    ? {
        team: linearResult.team,
        registry: linearResult.registry,
        resources: (linearResult.team.resources || []).filter((resource) => resource.kind === "git_repo"),
      }
    : await (async () => {
        const allowlistRepos = await resolveInitOnboardingRepoAllowlist({
          requestedRepos: input.repos,
          runCommand: githubDiscoveryRunCommand,
        });
        return persistTeamGitHubRepoAllowlist({
          repoRoot,
          home,
          teamRef: linearResult.team.id,
          repos: allowlistRepos,
        });
      })();
  linearResult = {
    ...linearResult,
    team: allowlistUpdate.team,
    registry: allowlistUpdate.registry,
    context: buildTeamContext({
      team: allowlistUpdate.team,
      config,
      repoRoot,
      home,
      behaviorRepoId: linearResult.context?.trace?.behavior_repo_id,
    }),
  };

  const githubFlags = githubFlagsForInitOnboarding(input);
  const githubConfig = configWithGithubFlags(config, githubFlags);
  const existingGitHub = completeResumeTeam ? readGitHubConnectionState({ repoRoot, home }) : null;
  const existingConnection = existingGitHub?.ok === true ? existingGitHub.connection : null;
  let requestedGithubOwner = input.github_owner || existingConnection?.repo?.owner || null;
  let requestedGithubRepo = input.github_repo || existingConnection?.repo?.name || null;
  const resolvedGithubTransport = await resolveInitOnboardingGitHubTransport({
    githubSetupTransport,
    githubInitTransportFromFlags,
    config: githubConfig,
    flags: githubFlags,
    repoRoot,
    onProgress: log,
  });
  let githubPhase = null;
  const githubPhaseInput = {
    repoRoot,
    home,
    config: githubConfig,
    transport: resolvedGithubTransport,
    requestedOwner: requestedGithubOwner,
    requestedRepoName: requestedGithubRepo,
    requestedVisibility: null,
    onProgress: log,
    isTTY: false,
    ...(runGit ? { runGit } : {}),
    replacementExplicit: githubReplacementExplicit === true,
  };
  githubPhase ||= await runGitHubPhase(githubPhaseInput);
  if (!githubPhase?.ok) {
    throw new ProjectMcpToolError(
      githubPhase?.reason || "github_setup_failed",
      githubSetupFailureMessage(githubPhase),
      {
        repair: githubPhase?.repair || `Repair local GitHub auth, then re-run ${formatCommand("init")}.`,
        phase: "github",
        durableLinear: true,
      },
    );
  }

  const pluginStep = await runInitOnboardingPluginStep({
    repoRoot,
    registerPlugin: runClaudePluginRegistration,
    runCommand: claudePluginRunCommand,
    marketplaceSource: claudePluginMarketplaceSource,
  });

  const linearStep = publicInitOnboardingLinearStep(linearResult, allowlistUpdate.resources);
  const githubStep = publicInitOnboardingGitHubStep(githubPhase, resolvedGithubTransport);
  let phoenixStep = { ok: false, status: "degraded", reason: "phoenix_not_run" };
  let runtimeStep = { ok: false, status: "blocked", reason: "runtime_not_run" };
  let doctorStep = { ok: false, status: "blocked", reason: "doctor_not_run", checks: [] };
  const health = await runSetupCompletionContract({
    setupId,
    store: setupStore,
    startAt: "consent",
    continueAfterBlocked: true,
    phaseAdapters: {
      consent: async () => ({ status: "healthy", reason: "explicitly_confirmed" }),
      linear: async () => ({
        status: linearStep.ok ? "healthy" : "blocked",
        reason: linearStep.ok ? "linear_setup_verified" : "linear_unhealthy",
      }),
      product_repos: async () => ({ status: "healthy", reason: input.repo_intent.mode }),
      github: async () => ({
        status: githubStep.ok && githubStep.mode !== "dry_run" ? "healthy" : "blocked",
        reason: githubStep.mode === "dry_run"
          ? "github_dry_run_not_complete"
          : githubStep.ok ? "github_connection_verified" : "github_unhealthy",
      }),
      plugin: async () => ({
        status: pluginStep.ok ? "healthy" : "blocked",
        reason: pluginStep.reason || "claude_plugin_checked",
      }),
      phoenix: async () => {
        phoenixStep = await runInitOnboardingPhoenixStep({
          repoRoot,
          teamContext: linearResult.context,
          ensurePhoenix,
          runPhoenixPreflight,
          onProgress: log,
        });
        return { status: phoenixStep.ok ? "healthy" : "degraded", reason: phoenixStep.reason || null };
      },
      runtime: async () => {
        runtimeStep = await runInitOnboardingRuntimeStep({ config, repoRoot, home, runRuntimeSmoke });
        return { status: runtimeStep.ok ? "healthy" : "blocked", reason: runtimeStep.reason || null };
      },
      doctor: async () => {
        doctorStep = await runInitOnboardingDoctorStep({
          config,
          repoRoot,
          home,
          cachePath: linearResult.context?.linear?.cachePath,
          teamRef: linearResult.team.id,
          pluginStep,
          runSetupDoctor,
          claudePluginRunCommand,
          claudePluginMarketplaceSource,
        });
        return { status: doctorStep.ok ? "healthy" : "blocked", reason: doctorStep.reason || null };
      },
    },
  });

  return {
    ok: health.ok,
    status: health.status,
    reason: health.reason,
    steps: {
      consent: { ok: true, version: SETUP_DISCLOSURE_VERSION, hash: SETUP_DISCLOSURE_HASH },
      linear: linearStep,
      product_repos: { ok: true, mode: input.repo_intent.mode, repos: linearStep.repos },
      github: githubStep,
      plugin: pluginStep,
      phoenix: phoenixStep,
      runtime: runtimeStep,
      doctor: doctorStep,
    },
    health,
    ...(authorizationUrl ? { authorization_url: authorizationUrl } : {}),
    next_steps: initOnboardingNextSteps({
      githubPhase,
      pluginStep,
      phoenixStep,
      runtimeStep,
      doctorStep,
      health,
    }),
  };
}

function teamHasLinearCredentialIdentity(team) {
  return Boolean(team?.id && team?.linear?.workspace_id && team?.linear?.team_id);
}

async function runInitOnboardingPhoenixStep({
  repoRoot,
  teamContext,
  ensurePhoenix,
  runPhoenixPreflight,
  onProgress,
} = {}) {
  let ready;
  try {
    ready = await ensurePhoenix({ repoRoot, onProgress });
  } catch (error) {
    return { ok: false, status: "degraded", reason: redactOAuthSecrets(error.message) };
  }
  if (!ready?.ok) {
    return {
      ok: false,
      status: "degraded",
      reason: ready?.reason || ready?.status || "phoenix_unavailable",
      ...(ready?.repairHint ? { repair: ready.repairHint } : {}),
    };
  }
  let preflight;
  try {
    preflight = await runPhoenixPreflight({
      repoRoot,
      ensureReady: async () => ready,
      teamContext,
    });
  } catch (error) {
    preflight = { ok: false, reason: redactOAuthSecrets(error.message) };
  }
  if (!preflight?.ok) {
    return {
      ok: false,
      status: "degraded",
      reason: preflight?.reason || preflight?.status || "phoenix_trace_preflight_failed",
      ...(preflight?.repairHint ? { repair: preflight.repairHint } : {}),
    };
  }
  return {
    ok: true,
    status: "healthy",
    trace_preflight: true,
    ...(ready.appUrl ? { app_url: ready.appUrl } : {}),
  };
}

async function runInitOnboardingRuntimeStep({ config, repoRoot, home, runRuntimeSmoke } = {}) {
  try {
    const result = await runRuntimeSmoke({ config, repoRoot, home });
    const failures = (Array.isArray(result?.results) ? result.results : [])
      .filter((entry) => entry?.ok !== true)
      .map((entry) => {
        const label = entry?.runtime || entry?.role || entry?.name || "runtime";
        const detail = entry?.error || entry?.message || entry?.reason || "check failed";
        return `${label}: ${redactOAuthSecrets(detail)}`;
      });
    const detail = failures.join("; ") ||
      (result?.error ? redactOAuthSecrets(result.error) : "runtime smoke did not pass");
    return {
      ok: result?.ok === true,
      status: result?.ok === true ? "healthy" : "blocked",
      checked: Array.isArray(result?.results) ? result.results.length : 0,
      ...(!result?.ok
        ? {
          reason: "runtime_smoke_failed",
          detail,
          failures,
          repair: `Run ${formatCommand("runtime-smoke")}, repair the named runtime, then re-run ${formatCommand("init")}.`,
        }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      checked: 0,
      reason: "runtime_smoke_exception",
      detail: redactOAuthSecrets(error.message),
      repair: `Run ${formatCommand("runtime-smoke")}, repair the reported failure, then re-run ${formatCommand("init")}.`,
    };
  }
}

async function runInitOnboardingDoctorStep({
  config,
  repoRoot,
  home,
  cachePath,
  teamRef,
  pluginStep,
  runSetupDoctor,
  claudePluginRunCommand,
  claudePluginMarketplaceSource,
} = {}) {
  let checks;
  try {
    const pluginVersion = verifiedSetupPluginVersion(pluginStep);
    const doctorChecks = await runSetupDoctor({
      config,
      repoRoot,
      home,
      cachePath,
      teamRef,
      includeRuntimeSmoke: false,
      includePhoenix: false,
      includeClaudePlugin: pluginVersion === null,
      claudePluginRunCommand,
      claudePluginMarketplaceSource,
    });
    checks = normalizeDoctorChecks([
      ...doctorChecks,
      ...(pluginVersion === null
        ? []
        : [{
            name: "Claude plugin launch contract",
            ok: true,
            message: `verified during this setup run at ${pluginVersion}`,
          }]),
    ]);
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      reason: "doctor_check_exception",
      detail: redactOAuthSecrets(error.message),
      repair: `Run ${formatCommand("doctor")}, repair the reported check, then re-run ${formatCommand("init")}.`,
      checks: [],
    };
  }
  const ok = checks.length > 0 && checks.every((check) => check.state !== "fail");
  return {
    ok,
    status: ok ? "healthy" : "blocked",
    reason: ok ? null : "doctor_failed",
    checks: checks.map((check) => ({
      name: check.name,
      state: check.state,
      ...(check.message ? { message: check.message } : {}),
      ...(check.state !== "ok" && check.fix ? { repair: check.fix } : {}),
    })),
  };
}

function verifiedSetupPluginVersion(pluginStep = {}) {
  const version = typeof pluginStep.version === "string" ? pluginStep.version.trim() : "";
  if (pluginStep.ok !== true || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null;
  return version;
}

function normalizeInitOnboardingInput(args = {}) {
  const team = optionalString(args.team);
  if (!team) throw new ProjectMcpToolError("invalid_input", "team is required to run setup.");
  let repoIntent;
  try {
    repoIntent = normalizeSetupRepoIntent(args.repo_intent || { mode: "non_code" });
  } catch (error) {
    throw new ProjectMcpToolError("invalid_input", error.message);
  }
  return {
    team,
    workspace: optionalString(args.workspace),
    repo_intent: repoIntent,
    repos: normalizeInitOnboardingRepos(repoIntent.repos),
    github_repo: optionalString(args.github_repo),
    github_owner: optionalString(args.github_owner),
    github_dry_run: args.github_dry_run === true,
    github_replacement_explicit: args.github_replacement_explicit === true,
    linear_team_id: optionalString(args.linear_team_id),
    linear_team_confirm: args.linear_team_confirm === true,
    linear_workspace_replace_confirm: args.linear_workspace_replace_confirm === true,
  };
}

function normalizeInitOnboardingRepos(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProjectMcpToolError("invalid_input", "repos must be an array of owner/repo strings.");
  }
  return value.map((entry) => normalizeInitOnboardingRepo(entry));
}

function normalizeInitOnboardingRepo(value) {
  if (typeof value !== "string") {
    throw new ProjectMcpToolError("invalid_input", "repos must contain owner/repo strings.");
  }
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0] || "") ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1] || "")
  ) {
    throw new ProjectMcpToolError("invalid_input", `repo must be shaped as owner/repo: ${trimmed || "(blank)"}`);
  }
  return { owner: parts[0], repo: parts[1], label: `${parts[0]}/${parts[1]}` };
}

async function resolveInitOnboardingRepoAllowlist({ requestedRepos = [], runCommand = null } = {}) {
  if (requestedRepos.length === 0) return [];
  let discoveredRepos;
  try {
    discoveredRepos = await discoverGitHubRepos({ ...(runCommand ? { runCommand } : {}) });
  } catch (error) {
    throw new ProjectMcpToolError(
      "github_repo_discovery_failed",
      `Could not verify the requested repo allowlist with GitHub CLI: ${redactOAuthSecrets(error.message)}. Repair local gh auth, then retry setup.`,
      { repair: "Repair local gh auth, then retry setup." },
    );
  }
  const discoveredByKey = new Map(discoveredRepos.map((repo) => [repoKey(repo), repo]));
  const missing = [];
  const selected = [];
  for (const requested of requestedRepos) {
    const discovered = discoveredByKey.get(repoKey(requested));
    if (!discovered) {
      missing.push(requested.label);
      continue;
    }
    selected.push(discovered);
  }
  if (missing.length > 0) {
    throw new ProjectMcpToolError(
      "github_repo_allowlist_unknown_repo",
      `Requested repo(s) were not visible to GitHub CLI discovery: ${missing.join(", ")}. Choose repos from gh repo list or repair local gh auth.`,
      { repair: "Choose repos from gh repo list or repair local gh auth, then retry setup." },
    );
  }
  return selected;
}

function repoKey(repo) {
  return `${String(repo?.owner || "").trim().toLowerCase()}/${String(repo?.repo || "").trim().toLowerCase()}`;
}

function setupFlagsForInitOnboarding(input) {
  return {
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

function githubFlagsForInitOnboarding(input) {
  return {
    ...(input.github_owner ? { "github-owner": input.github_owner } : {}),
    ...(input.github_repo ? { "github-repo": input.github_repo } : {}),
    ...(input.github_dry_run ? { "github-dry-run": true } : {}),
  };
}

async function resolveInitOnboardingGitHubTransport({
  githubSetupTransport,
  githubInitTransportFromFlags,
  config,
  flags,
  repoRoot,
  onProgress,
} = {}) {
  if (typeof githubSetupTransport === "function") {
    return githubSetupTransport({ config, flags, repoRoot, onProgress });
  }
  if (githubSetupTransport) return githubSetupTransport;
  return githubInitTransportFromFlags({ config, flags, repoRoot, onProgress });
}

function autoProceedReauthorizationPrompt({ signal } = {}) {
  if (!signal) return "";
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("");
      return;
    }
    signal.addEventListener("abort", () => resolve(""), { once: true });
  });
}

function authorizationUrlFromProgress(line) {
  const match = String(line || "").match(/https?:\/\/\S*oauth\/authorize\S*/i);
  return match ? match[0] : null;
}

async function runInitOnboardingPluginStep({
  repoRoot,
  registerPlugin = runClaudePluginRegistrationStep,
  runCommand = null,
  marketplaceSource = undefined,
} = {}) {
  const output = createMemoryCliOutput();
  const previousExitCode = process.exitCode;
  try {
    const result = await registerPlugin({
      repoRoot,
      output,
      totalSteps: 3,
      stepNumber: 3,
      ...(runCommand ? { runCommand } : {}),
      ...(marketplaceSource ? { marketplaceSource } : {}),
    });
    return publicInitOnboardingPluginStep(result);
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      failed: true,
      reason: "claude_plugin_exception",
      detail: redactOAuthSecrets(error.message),
      repair: `Repair Claude Code plugin access, then re-run ${formatCommand("init")}.`,
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

function publicInitOnboardingPluginStep(result = {}) {
  if (result?.ok === true) {
    return {
      ok: true,
      status: result.status || "installed",
      installed: result.status === "installed",
      already_installed: result.status === "already_installed",
      plugin_name: result.pluginName || "teami",
      ...(result.version ? { version: result.version } : {}),
      ...(result.marketplaceName ? { marketplace_name: result.marketplaceName } : {}),
      ...(result.marketplace ? { marketplace: result.marketplace } : {}),
    };
  }
  return {
    ok: false,
    status: "failed",
    failed: true,
    reason: result?.reason || "claude_plugin_registration_failed",
    ...(result?.detail ? { detail: redactOAuthSecrets(result.detail) } : {}),
    repair: `Repair Claude Code plugin access, then re-run ${formatCommand("init")}.`,
  };
}

function publicInitOnboardingLinearStep(result, resources = []) {
  const team = result.team || {};
  return {
    ok: result.ok === true,
    team: {
      id: team.id || null,
      status: team.status || null,
    },
    workspace: {
      id: team.linear?.workspace_id || result.cache?.workspaceId || null,
      name: team.linear?.workspace_name || null,
    },
    team: {
      id: team.linear?.team_id || result.cache?.teamId || null,
      key: team.linear?.team_key || result.cache?.teamKey || null,
      name: team.linear?.team_name || null,
    },
    repos: resources.map((resource) => ({
      owner: resource.binding.owner,
      repo: resource.binding.repo,
      default_branch: resource.binding.default_branch,
    })),
  };
}

function publicInitOnboardingGitHubStep(result = {}, transport = null) {
  const connection = result.connection || {};
  const repo = connection.repo || {};
  return {
    ok: result.ok === true,
    status: result.status || connection.status || null,
    mode: connection.connection_mode || null,
    connected: result.ok === true,
    created: Array.isArray(transport?.calls)
      ? transport.calls.some((call) => call?.endpointId === "create_repository")
      : null,
    repo: {
      id: repo.id || null,
      owner: repo.owner || null,
      name: repo.name || null,
      full_name: repo.full_name || null,
      url: repo.url || null,
      visibility: repo.visibility || null,
    },
    ...(result.transport_kind ? { transport_kind: result.transport_kind } : {}),
  };
}

function initOnboardingNextSteps({
  githubPhase = {},
  pluginStep = {},
  phoenixStep = {},
  runtimeStep = {},
  doctorStep = {},
  health = {},
} = {}) {
  const steps = [];
  const add = (value) => {
    if (value && !steps.includes(value)) steps.push(value);
  };
  const mode = githubPhase.connection?.connection_mode;
  if (mode === "dry_run") {
    add("GitHub was recorded as a dry run; re-run setup without github_dry_run before relying on promotion PRs.");
  }
  if (pluginStep?.failed) {
    add(pluginStep.repair || `Repair Claude Code plugin access, then re-run ${formatCommand("init")}.`);
  }
  if (phoenixStep?.ok !== true) {
    add(phoenixStep.repair || `Repair local Phoenix, then re-run ${formatCommand("init")}.`);
  }
  if (runtimeStep?.ok !== true) {
    add(runtimeStep.repair || `Run ${formatCommand("runtime-smoke")}, then re-run ${formatCommand("init")}.`);
  }
  if (doctorStep?.ok !== true) {
    add(doctorStep.repair || (doctorStep.checks || []).find((check) => check.repair)?.repair ||
      `Run ${formatCommand("doctor")}, repair the named check, then re-run ${formatCommand("init")}.`);
  }
  if (health?.ok !== true) {
    return steps;
  }
  add("Open a new Claude Code session and run /teami:plan to shape your first project.");
  add("Call listener_status. If Teami is stopped, ask the adopter whether to start it, then call listener_start with confirm: true only after they agree.");
  add(`The listener keeps running after the agent session closes. Turn it off with listener_stop after confirmation or ${formatCommand("gateway stop")}.`);
  return steps;
}

function githubSetupFailureMessage(result = {}) {
  const reason = result?.reason || "github_setup_failed";
  const detail = result?.detail ? ` Detail: ${redactOAuthSecrets(result.detail)}` : "";
  const repair = result?.repair ? ` Repair: ${result.repair}` : ` Repair local GitHub auth, then re-run ${formatCommand("init")}.`;
  return `GitHub setup failed: ${reason}.${detail}${repair}`;
}

function createMemoryCliOutput() {
  const lines = [];
  const push = (level, value) => {
    if (typeof value === "string") lines.push({ level, text: value });
  };
  return {
    lines,
    symbols: { separator: "-", ellipsis: "..." },
    style: { dim: (value) => String(value || "") },
    heading: (text) => push("heading", text),
    section: (text) => push("section", text),
    step: (_step, _total, text) => push("step", text),
    detail: (text) => push("detail", text),
    info: (text) => push("info", text),
    success: (text) => push("success", text),
    warn: (text) => push("warn", text),
    error: (entry) => push("error", entry?.what || entry?.message || String(entry || "")),
    done: (text) => push("done", text),
    nextSteps: (items) => push("next", (items || []).map((item) => item.text || item).join(" | ")),
    raw: (text) => push("raw", text),
    progress: (text) => {
      push("progress", text);
      return { stop: () => {} };
    },
  };
}
async function emitPlanningSessionTrace({
  repoRoot,
  traceSink = null,
  createTraceSink = null,
  context = null,
  project = null,
  outcome = null,
  planningTelemetry = null,
} = {}) {
  try {
    const sink = traceSink || (typeof createTraceSink === "function" ? createTraceSink({ repoRoot }) : null);
    if (!sink || !project?.id || !outcome) return null;
    try {
      const observedAt = new Date().toISOString();
      const trace = buildPlanningSessionTrace({
        context,
        project,
        outcome,
        planningTelemetry,
        observedAt,
      });
      const projectId = project.id;
      const teamRef = context?.trace?.team_ref || context?.teamRef || null;
      const workspaceId = context?.trace?.workspace_id || context?.linear?.workspaceId || null;
      const teamId = context?.trace?.team_id || context?.linear?.teamId || null;
      const runId = `planning-session-${outcome}-${projectId}-${Date.now()}`;
      const wake = {
        id: `${PLANNING_SESSION_TRACE_KIND}:${outcome}:${projectId}`,
        team_ref: teamRef,
        workspace_id: workspaceId,
        team_id: teamId,
        object_id: projectId,
        workflow_type: PLANNING_SESSION_TRACE_KIND,
        trigger_type: PLANNING_SESSION_TRACE_KIND,
        attempt_count: null,
      };
      const sourceEvent = {
        id: `${PLANNING_SESSION_TRACE_KIND}:${outcome}:${projectId}`,
        provider: "linear",
        event_id: `${PLANNING_SESSION_TRACE_KIND}:${outcome}:${projectId}`,
      };
      const session = await sink.startRun?.({
        wake,
        sourceEvent,
        runId,
        workspaceId,
        teamContext: context,
      });
      return await sink.finishRun?.({
        session,
        result: {
          status: "completed",
          reason: null,
          trace,
        },
        wake,
      });
    } finally {
      await sink.shutdown?.();
    }
  } catch {
    return null;
  }
}

function buildPlanningSessionTrace({
  context = null,
  project = null,
  outcome = null,
  planningTelemetry = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const projectId = project?.id || null;
  const attributes = knownTraceAttributes({
    "workflow.name": PLANNING_SESSION_TRACE_KIND,
    "workflow.version": "v1",
    "teami.team_ref": context?.trace?.team_ref || context?.teamRef || null,
    "teami.behavior_repo_id": context?.trace?.behavior_repo_id,
    "linear.workspace_id": context?.trace?.workspace_id || context?.linear?.workspaceId || null,
    "linear.team_id": context?.trace?.team_id || context?.linear?.teamId || null,
    "linear.project_id": projectId,
    linear_project_id: projectId,
    outcome,
  });
  const trace = createTrace(PLANNING_SESSION_TRACE_KIND, attributes);
  const spanAttributes = knownTraceAttributes({
    ...attributes,
    ...projectNameTraceAttributes(project?.name),
    ...planningTelemetryTraceAttributes(planningTelemetry),
    planning_telemetry: planningTelemetry,
    ...planningBodyTraceAttributes(project?.content),
  });
  const span = recordPolicyCheckedPlanningSpan(trace, "planning_session", spanAttributes);
  span.startedAt = observedAt;
  span.endedAt = observedAt;
  return trace;
}

function planningBodyTraceAttributes(content) {
  if (typeof content !== "string") return { project_body_present: false };
  return {
    project_body_present: true,
    project_body_length: content.length,
    project_body_digest_kind: "sha256",
    project_body_digest: digestTraceField(content),
    project_body: content,
  };
}

function projectNameTraceAttributes(name) {
  if (typeof name !== "string") return {};
  return {
    project_name: name,
    project_name_length: name.length,
    project_name_digest_kind: "sha256",
    project_name_digest: digestTraceField(name),
  };
}

function planningTelemetryTraceAttributes(planningTelemetry) {
  if (!isRecord(planningTelemetry)) return { planning_telemetry_present: false };
  return {
    planning_telemetry_present: true,
    planning_telemetry_digest_kind: "sha256",
    planning_telemetry_digest: digestTraceField(planningTelemetry),
  };
}

function recordPolicyCheckedPlanningSpan(trace, name, attributes) {
  const policy = enforceTraceContentPolicy(
    { spans: [{ name, attributes }] },
    LOCAL_FULL_CONTENT_TRACE_POLICY_OPTIONS,
  );
  if (policy.ok) {
    return recordSpan(trace, name, attributes);
  }
  return recordSpan(trace, "planning_artifact_unavailable", knownTraceAttributes({
    "workflow.name": attributes["workflow.name"],
    "linear.project_id": attributes["linear.project_id"],
    linear_project_id: attributes.linear_project_id,
    outcome: attributes.outcome,
    project_name_length: attributes.project_name_length,
    project_name_digest_kind: attributes.project_name_digest_kind,
    project_name_digest: attributes.project_name_digest,
    project_body_present: attributes.project_body_present,
    project_body_length: attributes.project_body_length,
    project_body_digest_kind: attributes.project_body_digest_kind,
    project_body_digest: attributes.project_body_digest,
    planning_telemetry_present: attributes.planning_telemetry_present,
    planning_telemetry_digest_kind: attributes.planning_telemetry_digest_kind,
    planning_telemetry_digest: attributes.planning_telemetry_digest,
    reason: policy.reason,
  }));
}

function normalizePlanningTelemetry(value) {
  if (!isRecord(value)) return null;
  const telemetry = {};
  if (Number.isFinite(value.elicitation_rounds)) {
    telemetry.elicitation_rounds = value.elicitation_rounds;
  }
  if (Number.isFinite(value.human_only_decisions_surfaced)) {
    telemetry.human_only_decisions_surfaced = value.human_only_decisions_surfaced;
  }
  const verdict = optionalString(value.pressure_test_verdict);
  if (verdict) telemetry.pressure_test_verdict = verdict;
  if (typeof value.advisor_used === "boolean") {
    telemetry.advisor_used = value.advisor_used;
  }
  return Object.keys(telemetry).length > 0 ? telemetry : null;
}

export function sanitizeProjectMcpError(error, { packageVersion = TEAMI_PACKAGE_VERSION } = {}) {
  const teamMissing = completeTeamTeamMissingRecoveryFromError(error);
  if (teamMissing) {
    return {
      ok: false,
      error: {
        code: teamMissing.code,
        message: `${teamMissing.what} ${teamMissing.why}`,
        repair: teamMissing.fix,
      },
    };
  }
  if (error instanceof ProjectMcpToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.repair ? { repair: error.repair } : {}),
      },
    };
  }

  if (isReauthorizeError(error)) {
    return { ok: false, error: { code: "reauthorize", message: "reauthorize" } };
  }

  const reason = typeof error?.reason === "string" ? error.reason : "";
  if (TEAM_ERROR_MESSAGES[reason]) {
    return {
      ok: false,
      error: {
        code: reason,
        message: TEAM_ERROR_MESSAGES[reason],
        ...(Array.isArray(error?.candidates) ? { candidates: error.candidates } : {}),
      },
    };
  }

  if (isSetupOnboardingError(error)) {
    return {
      ok: false,
      error: {
        code: setupOnboardingErrorCode(error),
        message: setupOnboardingErrorMessage(error),
        repair: setupOnboardingRepairHint(error, { packageVersion }),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "tool_failed",
      message: `The Linear project tool failed. Run ${formatCommandForContext("doctor", { packageVersion })}, then retry.`,
    },
  };
}

function isSetupOnboardingError(error) {
  const message = String(error?.message || error || "");
  return Boolean(
    error?.setupIncompleteCause ||
    error?.code === "workspace_mismatch" ||
    error?.code === "linear_authorization_failed" ||
    /Linear OAuth|OAuth authorization|authorization callback|workspace_authorization_retries_exhausted/i.test(message) ||
    /Principal Escalation project status/i.test(message) ||
    /setup_incomplete|credential_promotion_failed|registry_write_failed|cache_write_failed/i.test(message)
  );
}

function setupOnboardingErrorCode(error) {
  if (error?.setupIncompleteCause) return error.setupIncompleteCause;
  if (error?.code === "workspace_mismatch") return "workspace_mismatch";
  if (error?.code === "linear_authorization_failed") return "linear_authorization_failed";
  const message = String(error?.message || error || "");
  if (/timed out waiting for Linear OAuth authorization callback/i.test(message)) return "linear_oauth_timeout";
  if (/Linear OAuth|OAuth authorization|authorization callback/i.test(message)) return "linear_oauth_failed";
  if (/Principal Escalation project status/i.test(message)) return "linear_project_status_repair_required";
  return "setup_failed";
}

function setupOnboardingErrorMessage(error) {
  if (error?.code === "workspace_mismatch" && error?.savedTeam) {
    const team = error.savedTeam;
    const savedWorkspace = team.workspace_name || team.workspace_id || "the saved workspace";
    const grantedWorkspace = error.grantedWorkspace?.name || error.grantedWorkspace?.id || "a different workspace";
    return `Saved Team "${team.name || team.ref}" is tied to Linear workspace "${savedWorkspace}", but Linear authorized "${grantedWorkspace}". Teami left the saved Team unchanged.`;
  }
  return redactOAuthSecrets(error?.message || String(error || "Setup failed"));
}

function setupOnboardingRepairHint(error, { packageVersion = TEAMI_PACKAGE_VERSION } = {}) {
  const message = String(error?.message || error || "");
  if (error?.code === "workspace_mismatch") {
    if (error?.savedTeam) {
      const team = error.savedTeam;
      const savedWorkspace = team.workspace_name || team.workspace_id || "the saved workspace";
      const grantedWorkspace = error.grantedWorkspace?.name || error.grantedWorkspace?.id || "the newly authorized workspace";
      const initCommand = formatCommandForContext("init", { packageVersion });
      const uninstallCommand = formatCommandForContext(`uninstall --team ${team.ref}`, { packageVersion });
      return `If "${savedWorkspace}" is the Team you want, re-run ${initCommand} and choose that workspace in Linear. If this is a fresh adoption or you want "${grantedWorkspace}", run ${uninstallCommand}, then ${initCommand}.`;
    }
    return "Start setup again for a fresh Linear authorization URL and choose the workspace named in the setup request.";
  }
  if (/already installed/i.test(message)) {
    return `Revoke Teami in Linear Settings -> Applications, then re-run ${formatCommandForContext("init", { packageVersion })}.`;
  }
  if (/Principal Escalation project status/i.test(message)) {
    return `Re-run ${formatCommandForContext("init", { packageVersion })} from a browser-capable session so Teami can ask once for Linear admin approval.`;
  }
  if (error?.setupIncompleteCause) {
    return `Setup stopped at ${error.setupIncompleteCause}. Repair the cause, then re-run ${formatCommandForContext("init", { packageVersion })}.`;
  }
  return `Run ${formatCommandForContext("doctor", { packageVersion })}, repair the red check, then retry setup.`;
}
function isReauthorizeError(error) {
  const message = String(error?.message || error || "");
  return (
    error?.code === "reauthorize" ||
    error?.httpStatus === 401 ||
    /Linear OAuth authorization is missing/i.test(message) ||
    /Linear OAuth access token is expired or unavailable/i.test(message) ||
    /Linear GraphQL OAuth token is missing/i.test(message) ||
    /Linear GraphQL request failed with HTTP 401/i.test(message) ||
    /\bunauthorized\b/i.test(message)
  );
}

const TEAM_ERROR_MESSAGES = Object.freeze({
  team_required: "More than one active Teami Team could apply. Show the candidate Team and workspace names, then ask the human to choose before continuing.",
  no_active_teams: `No active Teami Team is configured. Ask the human to run ${formatCommand("init")} before continuing.`,
  team_not_found: "The requested Teami Team is not configured. Show any candidates and ask the human to choose before continuing.",
  team_not_active: "The selected Teami Team is not active. Explain its status and ask the human to choose an active Team or repair setup.",
});

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectMcpToolError("invalid_input", `${fieldName} is required.`);
  }
  return value.trim();
}

function requiredContentString(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectMcpToolError("invalid_input", "content is required.");
  }
  return value;
}

function requiredProjectBodyContent(args) {
  if (Object.hasOwn(args, "slots")) {
    if (!isRecord(args.slots)) {
      throw new ProjectMcpToolError("invalid_input", "slots must be an object.");
    }
    // Slots are canonical. If callers send both slots and content, render slots
    // so the stored body stays byte-aligned with renderPlanningBody.
    return renderPlanningBody(args.slots);
  }
  return requiredContentString(args.content);
}

function optionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicTeamContext(context) {
  return {
    team_ref: context.teamRef,
    workspace_id: context.linear.workspaceId,
    workspace_name: context.linear.workspaceName,
    team_id: context.linear.teamId,
    team_key: context.linear.teamKey,
    team_name: context.linear.teamName,
  };
}

function resolvedTeamSummary(team, approvedRepositories) {
  const workspace = team.workspace_name || team.workspace_id || "unknown workspace";
  const teamName = team.team_name || team.team_key || team.team_id || team.team_ref;
  if (approvedRepositories.length === 0) {
    return `Team "${teamName}" in workspace "${workspace}"; no product repositories are connected.`;
  }
  const repositories = approvedRepositories
    .map((repository) => `${repository.owner}/${repository.repo}`)
    .join(", ");
  return `Team "${teamName}" in workspace "${workspace}"; approved repositories: ${repositories}.`;
}

function listenerLaunchContract(packageVersion) {
  const build = String(packageVersion || "").trim();
  if (!/^[0-9A-Za-z.+-]+$/.test(build)) {
    throw new ProjectMcpToolError(
      "package_version_invalid",
      "Teami could not identify the exact build needed to start its listener.",
      { repair: `Run ${formatCommand("doctor")} and repair the package installation before starting the listener.` },
    );
  }
  const launcher = `npx -y @shulmansj/teami@${build}`;
  return {
    build,
    start_command: `${launcher} gateway start --background`,
    status_command: `${launcher} gateway status`,
    stop_command: `${launcher} gateway stop`,
    lifecycle: "background_until_stopped_signout_restart_or_failure",
  };
}

function listenerRegistry({ registry = null, home = resolveTeamiHome() } = {}) {
  return registry || readTeamRegistry({ home }) || emptyTeamRegistry();
}

function listenerPublicStatus(state) {
  if (state === HOME_STATE.LISTENING) return "running";
  if (state === HOME_STATE.IDLE) return "stopped";
  if (state === HOME_STATE.UNINITIALIZED) return "not_ready";
  return "degraded";
}

function listenerStatusSummary({ state, mode = "stopped" } = {}) {
  if (state === HOME_STATE.LISTENING) {
    return mode === "background"
      ? "Teami is listening in the background on this computer."
      : "Teami is listening in another terminal on this computer.";
  }
  if (state === HOME_STATE.IDLE) {
    return "Teami is ready but not listening. Planned projects wait safely in Linear until the listener starts.";
  }
  if (state === HOME_STATE.UNINITIALIZED) {
    return "Teami setup is not complete, so the listener cannot start yet.";
  }
  return "Teami could not read its local setup state cleanly. Run doctor before starting the listener.";
}

function listenerStartError(error, packageVersion) {
  return new ProjectMcpToolError(
    "listener_start_failed",
    `Teami's local listener did not start: ${redactOAuthSecrets(error?.message || String(error || "unknown failure"))}`,
    { repair: `Run ${formatCommandForContext("gateway status", { packageVersion })}, then try again.` },
  );
}

function publicCacheSummary(cache) {
  return {
    present: Boolean(cache),
    team_ref: cache?.teamRef || null,
    workspace_id: cache?.workspaceId || null,
    team_id: cache?.teamId || null,
  };
}

function publicProject(project) {
  return {
    id: project?.id || null,
    name: project?.name || null,
    url: project?.url || null,
    status_id: project?.status?.id || project?.statusId || null,
    status_name: project?.status?.name || null,
    team_ids: Array.isArray(project?.teamIds) ? [...project.teamIds] : [],
  };
}
