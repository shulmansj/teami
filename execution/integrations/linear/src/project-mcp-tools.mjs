import { readLinearCache, writeLinearCache } from "./cache.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import { loadLinearConfig } from "./config.mjs";
import { normalizeDoctorChecks } from "./doctor-check.mjs";
import { createDomainConfinedPlanningMutations } from "./domain-confined-planning-mutations.mjs";
import { resolveForegroundDomainCache } from "./domain-command-context.mjs";
import { buildDomainContext } from "./domain-resolver.mjs";
import {
  emptyDomainRegistry,
  readDomainRegistry,
  writeDomainRegistry,
} from "./domain-registry.mjs";
import {
  createBootstrapLinearCredentialStore,
  promoteSetupCredentialToDomain,
} from "./cli/local-setup-cleanup.mjs";
import {
  authorizeLinearSetupWorkspace,
  discoverGitHubRepos,
  ensureNeedsPrincipalProjectStatus,
  persistDomainGitHubRepoAllowlist,
  registryWithoutRemovedDomainsForName,
  resolveSetupCommandDomainNameHint,
  runClaudePluginRegistrationStep,
} from "./cli/linear-setup-command.mjs";
import {
  configWithGithubFlags,
  githubSetupTransportFromFlags,
} from "./cli/github-command-options.mjs";
import {
  completeDomainTeamMissingRecoveryFromError,
  formatCommand,
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
import { setupLinearDomain } from "./linear-service.mjs";
import { renderPlanningBody } from "./project-planning-body.mjs";
import { createTrace, recordSpan } from "./trace.mjs";
import { runRuntimeSmokeChecks } from "./runtime-smoke.mjs";
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
  "resolve_domain",
  "project_create",
  "project_write_body",
  "project_move_status",
]);
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
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
  linearClient = null,
  linearClientFactory = null,
  resolveShape = resolveLinearShape,
  planningTraceSink = null,
  createPlanningTraceSink = null,
  awaitPlanningTraceEmission = false,
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
      });
    }
    const currentRegistry = readDomainRegistry({ home }) || emptyDomainRegistry();
    const domainName = optionalString(args.domain) || inferredSetupDomainName(currentRegistry);
    if (!domainName || args.confirm !== true) {
      return initOnboardingNeedsResult({
        domainName,
        domainRequired: !domainName,
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
      domain: domainName,
      repo_intent: { mode: "non_code" },
    };
    const domainResolution = resolveSetupCommandDomainNameHint(
      ["--domain", domainName],
      currentRegistry,
    );
    const completeDomain = domainResolution.completeResumeDomain || null;
    const incompleteDomain = domainResolution.resumeDomain || null;
    setupArgs.github_replacement_explicit = Boolean(
      completeDomain && optionalString(args.github_owner) && optionalString(args.github_repo),
    );
    let existingTokenSet = null;
    if (completeDomain || incompleteDomain) {
      const existingCredentialStore = completeDomain
        ? createCredentialStore({
            config: baseConfig,
            repoRoot,
            domainContext: buildDomainContext({ domain: completeDomain, config: baseConfig, repoRoot, home }),
          })
        : createBootstrapLinearCredentialStore({ config: baseConfig, repoRoot });
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
          const expectedWorkspaceId = (completeDomain || incompleteDomain)?.linear?.workspace_id || null;
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
          await existingCredentialStore.deleteTokenSet?.();
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

  async function resolve_domain(args = {}) {
    const { context, cache } = resolveDomainCache(args);
    return {
      ok: true,
      domain: publicDomainContext(context),
      cache: publicCacheSummary(cache),
    };
  }

  async function project_create(args = {}) {
    const name = requiredString(args.name, "name");
    const description = optionalString(args.description);
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
      domain: publicDomainContext(prepared.context),
      status: {
        role: "backlog",
        id: backlogStatusId,
      },
    };
  }

  async function project_write_body(args = {}) {
    const projectId = requiredString(args.project_id || args.projectId, "project_id");
    const content = requiredProjectBodyContent(args);
    const prepared = await prepareLinear(args, { resolveShapeForStatus: false });
    const project = await prepared.mutations.updateProject(projectId, { content });

    return {
      ok: true,
      project: publicProject(project),
      domain: publicDomainContext(prepared.context),
      content_length: content.length,
    };
  }

  async function project_move_status(args = {}) {
    const projectId = requiredString(args.project_id || args.projectId, "project_id");
    if (args.confirm !== true) {
      throw new ProjectMcpToolError(
        "confirmation_required",
        "project_move_status requires confirm: true before moving a project to Planned.",
      );
    }

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
      domain: publicDomainContext(prepared.context),
      status: {
        role: "planned",
        id: plannedStatusId,
      },
    };
  }

  async function prepareLinear(args = {}, { resolveShapeForStatus = true } = {}) {
    const { context, cache, config: domainConfig } = resolveDomainCache(args);
    const client = await resolveClient({ context, config: domainConfig });
    const shape = resolveShapeForStatus
      ? await resolveShape({ client, config: domainConfig, cache })
      : null;
    const mutations = createDomainConfinedPlanningMutations({
      client,
      context,
      createError: (code, message, repair) => new ProjectMcpToolError(code, message, { repair }),
    });
    return { context, cache, config: domainConfig, client, mutations, shape };
  }

  function resolveDomainCache(args = {}) {
    return resolveForegroundDomainCache({
      config: baseConfig,
      repoRoot,
      registry,
      domainId: optionalString(args.domain || args.domain_id || args.domainId),
      readCache,
    });
  }

  async function resolveClient({ context, config: domainConfig }) {
    if (linearClient) return linearClient;
    if (linearClientFactory) {
      return linearClientFactory({ context, config: domainConfig, repoRoot });
    }
    const credentialStore = createCredentialStore({
      config: domainConfig,
      domainContext: context,
      repoRoot,
    });
    const { client } = createSetupGraphqlClient({
      config: domainConfig,
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
    resolve_domain,
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
        reason: "existing_domain_authorization_reused",
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
    // setup state or process memory. The engine resolves the complete domain credential itself.
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
      const sanitized = sanitizeProjectMcpError(error);
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

function initOnboardingNeedsResult({ domainName = DEFAULT_SETUP_TEAM_NAME, domainRequired = false } = {}) {
  const needs = [];
  if (domainRequired) {
    needs.push({
      field: "domain",
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
      team: domainName || null,
      product_repositories: "none",
    },
    needs,
    next_steps: [
      "Tell the adopter that product repositories stay disconnected during setup.",
      `After explicit confirmation, call init_onboarding with confirm: true, disclosure_version: ${SETUP_DISCLOSURE_VERSION}, and disclosure_hash: ${SETUP_DISCLOSURE_HASH}.`,
    ],
  };
}

function inferredSetupDomainName(registry = emptyDomainRegistry()) {
  const domains = (registry?.domains || []).filter((domain) => domain?.status !== "removed");
  if (domains.length === 0) return DEFAULT_SETUP_TEAM_NAME;
  if (domains.length === 1) return domains[0].adopter_provided_name || domains[0].id || DEFAULT_SETUP_TEAM_NAME;
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
    domain: input.domain,
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

  const currentRegistry = registry || readDomainRegistry({ home }) || emptyDomainRegistry();
  const initArgs = ["--domain", input.domain, ...(input.workspace ? ["--workspace", input.workspace] : [])];
  const domainNameResolution = resolveSetupCommandDomainNameHint(initArgs, currentRegistry);
  const resumeDomain = domainNameResolution.resumeDomain || domainNameResolution.completeResumeDomain || null;
  const completeResumeDomain = domainNameResolution.completeResumeDomain || null;
  const setupRegistry = registryWithoutRemovedDomainsForName(currentRegistry, input.domain);
  const completeResumeContext = completeResumeDomain
    ? buildDomainContext({ domain: completeResumeDomain, config, repoRoot, home })
    : null;
  const credentialStore = completeResumeContext
    ? createCredentialStore({ config, repoRoot, domainContext: completeResumeContext })
    : createBootstrapLinearCredentialStore({ config, repoRoot });
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
    registry: setupRegistry,
    flags: setupFlags,
    env: process.env,
    domainNameHint: input.domain,
    resumeDomain,
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
  });

  let linearResult = await setupLinearDomain({
    client: workspaceAuthorization.setupAuth.client,
    config,
    registry: setupRegistry,
    repoRoot,
    home,
    domainName: input.domain,
    cache: completeResumeContext ? readCache(completeResumeContext.linear.cachePath) : null,
    resumeDomain,
    workspace: workspaceAuthorization.workspace,
    declaredWorkspace: workspaceAuthorization.declaredWorkspace,
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
    writeRegistry: (nextRegistry) => writeDomainRegistry({ home }, nextRegistry),
    promoteCredential: completeResumeDomain
      ? async () => {}
      : ({ context }) => promoteSetupCredentialToDomain({
          setupCredentialStore: credentialStore,
          config,
          repoRoot,
          domainContext: context,
        }),
    onPreview: log,
    selectedExistingTeamId: input.linear_team_confirm === true ? input.linear_team_id : null,
  });

  const allowlistUpdate = completeResumeDomain
    ? {
        domain: linearResult.domain,
        registry: linearResult.registry,
        resources: (linearResult.domain.resources || []).filter((resource) => resource.kind === "git_repo"),
      }
    : await (async () => {
        const allowlistRepos = await resolveInitOnboardingRepoAllowlist({
          requestedRepos: input.repos,
          runCommand: githubDiscoveryRunCommand,
        });
        return persistDomainGitHubRepoAllowlist({
          repoRoot,
          home,
          domainId: linearResult.domain.id,
          repos: allowlistRepos,
          registry: linearResult.registry,
          writeRegistry: (nextRegistry) => writeDomainRegistry({ home }, nextRegistry),
        });
      })();
  linearResult = {
    ...linearResult,
    domain: allowlistUpdate.domain,
    registry: allowlistUpdate.registry,
    context: buildDomainContext({
      domain: allowlistUpdate.domain,
      config,
      repoRoot,
      home,
      behaviorRepoId: linearResult.context?.trace?.behavior_repo_id,
    }),
  };

  const githubFlags = githubFlagsForInitOnboarding(input);
  const githubConfig = configWithGithubFlags(config, githubFlags);
  const existingGitHub = completeResumeDomain ? readGitHubConnectionState({ repoRoot, home }) : null;
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
          domainContext: linearResult.context,
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
          domainId: linearResult.domain.id,
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

async function runInitOnboardingPhoenixStep({
  repoRoot,
  domainContext,
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
      domainContext,
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
  domainId,
  runSetupDoctor,
  claudePluginRunCommand,
  claudePluginMarketplaceSource,
} = {}) {
  let checks;
  try {
    checks = normalizeDoctorChecks(await runSetupDoctor({
      config,
      repoRoot,
      home,
      cachePath,
      domainId,
      includeRuntimeSmoke: false,
      includePhoenix: false,
      claudePluginRunCommand,
      claudePluginMarketplaceSource,
    }));
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

function normalizeInitOnboardingInput(args = {}) {
  const domain = optionalString(args.domain);
  if (!domain) throw new ProjectMcpToolError("invalid_input", "domain is required to run setup.");
  let repoIntent;
  try {
    repoIntent = normalizeSetupRepoIntent(args.repo_intent || { mode: "non_code" });
  } catch (error) {
    throw new ProjectMcpToolError("invalid_input", error.message);
  }
  return {
    domain,
    workspace: optionalString(args.workspace),
    repo_intent: repoIntent,
    repos: normalizeInitOnboardingRepos(repoIntent.repos),
    github_repo: optionalString(args.github_repo),
    github_owner: optionalString(args.github_owner),
    github_dry_run: args.github_dry_run === true,
    github_replacement_explicit: args.github_replacement_explicit === true,
    linear_team_id: optionalString(args.linear_team_id),
    linear_team_confirm: args.linear_team_confirm === true,
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
  const domain = result.domain || {};
  return {
    ok: result.ok === true,
    domain: {
      id: domain.id || null,
      status: domain.status || null,
    },
    workspace: {
      id: domain.linear?.workspace_id || result.cache?.workspaceId || null,
      name: domain.linear?.workspace_name || null,
    },
    team: {
      id: domain.linear?.team_id || result.cache?.teamId || null,
      key: domain.linear?.team_key || result.cache?.teamKey || null,
      name: domain.linear?.team_name || null,
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
  add(`When you are ready for Planned work to run, keep Teami's local listener open with ${formatCommand("gateway start")}.`);
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
      const domainId = context?.trace?.domain_id || context?.domainId || null;
      const workspaceId = context?.trace?.workspace_id || context?.linear?.workspaceId || null;
      const teamId = context?.trace?.team_id || context?.linear?.teamId || null;
      const runId = `planning-session-${outcome}-${projectId}-${Date.now()}`;
      const wake = {
        id: `${PLANNING_SESSION_TRACE_KIND}:${outcome}:${projectId}`,
        domain_id: domainId,
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
        domainContext: context,
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
    "teami.domain_id": context?.trace?.domain_id || context?.domainId || null,
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

export function sanitizeProjectMcpError(error) {
  const teamMissing = completeDomainTeamMissingRecoveryFromError(error);
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
  if (DOMAIN_ERROR_MESSAGES[reason]) {
    return {
      ok: false,
      error: {
        code: reason,
        message: DOMAIN_ERROR_MESSAGES[reason],
      },
    };
  }

  if (isSetupOnboardingError(error)) {
    return {
      ok: false,
      error: {
        code: setupOnboardingErrorCode(error),
        message: redactOAuthSecrets(error.message),
        repair: setupOnboardingRepairHint(error),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "tool_failed",
      message: `The Linear project tool failed. Run ${formatCommand("doctor")}, then retry.`,
    },
  };
}

function isSetupOnboardingError(error) {
  const message = String(error?.message || error || "");
  return Boolean(
    error?.setupIncompleteCause ||
    error?.code === "workspace_mismatch" ||
    /Linear OAuth|OAuth authorization|authorization callback|workspace_authorization_retries_exhausted/i.test(message) ||
    /Principal Escalation project status/i.test(message) ||
    /setup_incomplete|credential_promotion_failed|registry_write_failed|cache_write_failed/i.test(message)
  );
}

function setupOnboardingErrorCode(error) {
  if (error?.setupIncompleteCause) return error.setupIncompleteCause;
  if (error?.code === "workspace_mismatch") return "workspace_mismatch";
  const message = String(error?.message || error || "");
  if (/timed out waiting for Linear OAuth authorization callback/i.test(message)) return "linear_oauth_timeout";
  if (/Linear OAuth|OAuth authorization|authorization callback/i.test(message)) return "linear_oauth_failed";
  if (/Principal Escalation project status/i.test(message)) return "linear_project_status_repair_required";
  return "setup_failed";
}

function setupOnboardingRepairHint(error) {
  const message = String(error?.message || error || "");
  if (error?.code === "workspace_mismatch") {
    return "Start setup again for a fresh Linear authorization URL and choose the workspace named in the setup request.";
  }
  if (/already installed/i.test(message)) {
    return `Revoke Teami in Linear Settings -> Applications, then re-run ${formatCommand("init")}.`;
  }
  if (/Principal Escalation project status/i.test(message)) {
    return `Re-run ${formatCommand("init")} from a browser-capable session so Teami can ask once for Linear admin approval.`;
  }
  if (error?.setupIncompleteCause) {
    return `Setup stopped at ${error.setupIncompleteCause}. Repair the cause, then re-run ${formatCommand("init")}.`;
  }
  return `Run ${formatCommand("doctor")}, repair the red check, then retry setup.`;
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

const DOMAIN_ERROR_MESSAGES = Object.freeze({
  domain_required: "domain_required",
  no_active_domains: "no_active_domains",
  domain_not_found: "domain_not_found",
  domain_not_active: "domain_not_active",
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

function publicDomainContext(context) {
  return {
    domain_id: context.domainId,
    workspace_id: context.linear.workspaceId,
    team_id: context.linear.teamId,
    team_key: context.linear.teamKey,
    team_name: context.linear.teamName,
  };
}

function publicCacheSummary(cache) {
  return {
    present: Boolean(cache),
    domain_id: cache?.domainId || null,
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
