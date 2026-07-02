import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_UPDATE_ACCOUNTABILITY_HEADING } from "../../../engine/engine-markdown.mjs";
import { SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION } from "../../../engine/orchestrator-turn-contract.mjs";
import { defaultRunStoreDir } from "../../../engine/run-store.mjs";
import { readLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readDomainRegistry } from "../src/domain-registry.mjs";
import { buildDomainContext } from "../src/domain-resolver.mjs";
import {
  acquireGatewayLock,
  runFreshSyntheticWake,
  runGatewayLoop,
  runGatewayOnce,
} from "../src/gateway-loop.mjs";
import { createLinearCredentialStore } from "../src/linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../src/linear-setup-auth.mjs";
import { resolveLinearShape } from "../src/linear/shape-resolver.mjs";
import { matchesStatus } from "../src/linear/matching-utils.mjs";
import { createLocalTriggerStore, localTriggerStorePath, readLocalTriggerState } from "../src/local-trigger-store.mjs";
import { buildProjectTemplateBody } from "../src/project-body.mjs";
import { runTriggeredDecomposition } from "../src/trigger-runner.mjs";
import {
  readReplayPending,
} from "../src/trigger-idempotency.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const HARNESS_PATH = path.join(MODULE_DIR, "gateway-uat.mjs");

export const NO_LINEAR_DOMAIN_MESSAGE =
  "no Linear domain configured — run npm run init against a disposable test team";
export const DEFAULT_UAT_PREFIX = "AF-UAT";
export const DEFAULT_CONSECUTIVE_COMMITS = 2;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_POLL_GRACE_MS = 5_000;
export const DEFAULT_CHILD_CRASH_TIMEOUT_MS = 5 * 60 * 1000;

const CHILD_EVENT_TYPE = "teami_gateway_uat";
const TERMINAL_PROJECT_STATUSES = new Set(["started", "backlog", "completed", "canceled", "cancelled"]);
const CRASH_SCENARIOS = Object.freeze({
  commit_before_started: Object.freeze({
    outcome: "commit",
    terminalStatus: "started",
    description: "kill between issue-create and status started",
  }),
  before_mutation: Object.freeze({
    outcome: "commit",
    terminalStatus: "started",
    description: "kill after mutation intent before any Linear mutation",
  }),
  pause_before_discovery: Object.freeze({
    outcome: "pause",
    terminalStatus: "backlog",
    description: "kill on a pause before discovery issue creation",
  }),
});

class UatUserError extends Error {
  constructor(message, code = "uat_user_error") {
    super(message);
    this.name = "UatUserError";
    this.code = code;
  }
}

export function parseGatewayUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(env.TEAMI_UAT_REPO_ROOT || REPO_ROOT),
    domainId: env.TEAMI_UAT_DOMAIN || null,
    prefix: env.TEAMI_UAT_PREFIX || DEFAULT_UAT_PREFIX,
    consecutive: parsePositiveInteger(env.TEAMI_UAT_CONSECUTIVE, DEFAULT_CONSECUTIVE_COMMITS),
    pollIntervalMs: parsePositiveInteger(env.TEAMI_UAT_POLL_INTERVAL_MS, null),
    pollGraceMs: parsePositiveInteger(env.TEAMI_UAT_POLL_GRACE_MS, DEFAULT_POLL_GRACE_MS),
    timeoutMs: parsePositiveInteger(env.TEAMI_UAT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    keepArtifacts: truthy(env.TEAMI_UAT_KEEP_ARTIFACTS),
    childCrash: null,
    childProjectId: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--domain") {
      options.domainId = requireNext(argv, ++index, arg);
    } else if (arg === "--prefix") {
      options.prefix = requireNext(argv, ++index, arg);
    } else if (arg === "--consecutive") {
      options.consecutive = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_CONSECUTIVE_COMMITS);
    } else if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = parsePositiveInteger(requireNext(argv, ++index, arg), null);
    } else if (arg === "--poll-grace-ms") {
      options.pollGraceMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_POLL_GRACE_MS);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_TIMEOUT_MS);
    } else if (arg === "--keep-artifacts") {
      options.keepArtifacts = true;
    } else if (arg === "--child-crash") {
      options.childCrash = requireNext(argv, ++index, arg);
    } else if (arg === "--project-id") {
      options.childProjectId = requireNext(argv, ++index, arg);
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else {
      throw new UatUserError(`unknown uat:gateway flag: ${arg}`, "usage");
    }
  }

  if (options.childCrash && !CRASH_SCENARIOS[options.childCrash]) {
    throw new UatUserError(`unknown crash scenario: ${options.childCrash}`, "usage");
  }
  if (options.childCrash && !options.childProjectId) {
    throw new UatUserError("--project-id is required with --child-crash", "usage");
  }
  return options;
}

export function selectUatDomain({ registry, domainId = null } = {}) {
  const domains = Array.isArray(registry?.domains) ? registry.domains : [];
  const active = domains.filter((domain) => domain.status === "active");
  if (active.length === 0) throw new UatUserError(NO_LINEAR_DOMAIN_MESSAGE, "no_linear_domain");
  if (domainId) {
    const selected = active.find((domain) => domain.id === domainId);
    if (!selected) throw new UatUserError(`domain not active or not found for gateway UAT: ${domainId}`, "domain");
    return selected;
  }
  if (active.length > 1) {
    const ids = active.map((domain) => domain.id).join(", ");
    throw new UatUserError(`multiple Linear domains configured (${ids}) - pass --domain <domain_id> for the disposable test team`, "domain");
  }
  return active[0];
}

export function classifyReplayRecovery({ statuses = [], projectId, expectedRunId = null, pendingBefore, pendingAfter }) {
  const projectEvents = statuses.filter((event) => event.projectId === projectId);
  const replay = projectEvents.find((event) =>
    event.state === "replaying" && (!expectedRunId || event.runId === expectedRunId));
  const fresh = projectEvents.find((event) => event.state === "working");
  const reasons = [];
  if (!pendingBefore) reasons.push("missing_pending_intent_before_restart");
  if (!replay) reasons.push("missing_replaying_status");
  if (fresh) reasons.push("fresh_decompose_seen_during_replay");
  if (pendingAfter) reasons.push("pending_intent_not_cleared");
  return {
    ok: reasons.length === 0,
    reasons,
    replay,
    fresh,
  };
}

export function buildGatewayUatUsage() {
  return [
    "Usage: npm run uat:gateway -- [--domain <id>] [--prefix AF-UAT] [--consecutive 2]",
    "",
    "Environment equivalents:",
    "- TEAMI_UAT_DOMAIN selects the disposable Linear domain/team.",
    "- TEAMI_UAT_PREFIX controls test-created Linear project name prefixes.",
    "- TEAMI_UAT_POLL_INTERVAL_MS overrides poll.interval_ms for the harness run.",
    "- TEAMI_UAT_KEEP_ARTIFACTS=1 keeps test artifacts where the scenarios leave them.",
  ].join("\n");
}

export async function runGatewayUat(options = parseGatewayUatArgs()) {
  const context = await prepareLiveUatContext(options);
  const createdProjects = [];
  const report = {
    ok: false,
    domainId: context.domain.id,
    prefix: context.prefix,
    scenarios: [],
    createdProjects,
  };

  try {
    report.scenarios.push(await runSecondGatewayRefusedScenario(context));
    for (let index = 0; index < context.consecutive; index += 1) {
      report.scenarios.push(await runCommitPickupScenario(context, {
        index: index + 1,
        createdProjects,
      }));
    }
    for (const crashMode of Object.keys(CRASH_SCENARIOS)) {
      report.scenarios.push(await runCrashScenario(context, {
        crashMode,
        createdProjects,
      }));
    }
    report.scenarios.push(await runRejectedSuppressionScenario(context, { createdProjects }));
    report.ok = report.scenarios.every((scenario) => scenario.ok);
    return report;
  } finally {
    report.cleanup = await cleanupProjects(context, createdProjects);
  }
}

async function prepareLiveUatContext(options) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const config = loadLinearConfig({ repoRoot });
  const registry = readDomainRegistry({ repoRoot });
  const domain = selectUatDomain({ registry, domainId: options.domainId });
  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const credentialStore = createLinearCredentialStore({ config, repoRoot, domainContext });
  let tokenSet = null;
  try {
    tokenSet = await credentialStore.readTokenSet();
  } catch {
    throw new UatUserError(NO_LINEAR_DOMAIN_MESSAGE, "no_linear_credential");
  }
  if (!tokenSet?.refreshToken && !tokenSet?.accessToken) {
    throw new UatUserError(NO_LINEAR_DOMAIN_MESSAGE, "no_linear_credential");
  }

  const client = createLinearSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    allowBrowserAuth: false,
    allowRefresh: true,
  }).client;
  await client.verifyAuth();
  const cache = readLinearCache(domainContext.linear.cachePath);
  const shape = await resolveLinearShape({ client, config, cache });
  const pollIntervalMs = options.pollIntervalMs || config.poll?.interval_ms || 10_000;
  const liveConfig = structuredClone(config);
  liveConfig.poll ||= {};
  liveConfig.poll.interval_ms = pollIntervalMs;

  return {
    ...options,
    repoRoot,
    config: liveConfig,
    registry,
    domain,
    domainContext,
    cache,
    client,
    shape,
    pollIntervalMs,
    prefix: options.prefix || DEFAULT_UAT_PREFIX,
    consecutive: options.consecutive || DEFAULT_CONSECUTIVE_COMMITS,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    pollGraceMs: options.pollGraceMs || DEFAULT_POLL_GRACE_MS,
  };
}

async function runSecondGatewayRefusedScenario(context) {
  const first = acquireGatewayLock({
    repoRoot: context.repoRoot,
    installHandlers: false,
  });
  if (!first.ok) {
    throw new Error(`gateway lock precondition failed: ${first.reason || "unknown"}`);
  }
  try {
    const second = acquireGatewayLock({
      repoRoot: context.repoRoot,
      installHandlers: false,
      isProcessAlive: () => true,
    });
    assertCondition(second.ok === false && second.reason === "gateway_already_running", "second gateway was not refused");
    return {
      ok: true,
      name: "second-gateway-refused",
      reason: second.reason,
      lockPath: second.lockPath,
    };
  } finally {
    first.release();
  }
}

async function runCommitPickupScenario(context, { index, createdProjects }) {
  const project = await createDisposableProject(context, {
    name: scenarioProjectName(context, `commit-${index}`),
    summary: "Gateway UAT commit pickup fixture.",
    status: "backlog",
  });
  createdProjects.push(project.id);

  const events = [];
  const controller = new AbortController();
  let gatewayError = null;
  const loop = runGatewayLoop({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    domains: [context.domain],
    pollIntervalMs: context.pollIntervalMs,
    signal: controller.signal,
    sleep: abortableSleep,
    runTimeoutMs: context.timeoutMs,
    onStatus: (event) => events.push({ ...event, observedAtMs: Date.now() }),
    runFreshProject: deterministicRunFreshProject({ outcome: "commit" }),
  }).catch((error) => {
    gatewayError = error;
  });

  let pickedWithinMs = null;
  let terminal = null;
  let scenarioError = null;
  try {
    await sleep(250);
    const plannedAtMs = Date.now();
    await moveProjectToStatus(context, project.id, "planned");
    const pickupDeadlineMs = context.pollIntervalMs + context.pollGraceMs;
    const picked = await waitForValue(
      () => events.find((event) => event.projectId === project.id && event.state === "working") || null,
      { timeoutMs: pickupDeadlineMs, label: "gateway working event after Planned transition" },
    );
    pickedWithinMs = picked.observedAtMs - plannedAtMs;
    terminal = await waitForProjectStatus(context, project.id, {
      status: "started",
      timeoutMs: context.timeoutMs,
    });
    assertCondition(
      pickedWithinMs <= pickupDeadlineMs,
      `project pickup exceeded interval budget: ${pickedWithinMs}ms > ${pickupDeadlineMs}ms`,
    );
  } catch (error) {
    scenarioError = error;
  } finally {
    controller.abort();
    await loop;
  }
  if (scenarioError) throw scenarioError;
  if (gatewayError) throw gatewayError;

  const issueCount = (terminal.issues || []).length;
  assertCondition(issueCount > 0, "commit scenario did not create Linear issues");

  return {
    ok: true,
    name: `planned-pickup-commit-${index}`,
    projectId: project.id,
    pickedWithinMs,
    terminalStatus: terminal.status?.type || terminal.status?.name || null,
    issueCount,
  };
}

async function runCrashScenario(context, { crashMode, createdProjects }) {
  const spec = CRASH_SCENARIOS[crashMode];
  const project = await createDisposableProject(context, {
    name: scenarioProjectName(context, `crash-${crashMode}`),
    summary: `Gateway UAT crash fixture: ${spec.description}.`,
    status: "backlog",
  });
  createdProjects.push(project.id);
  await moveProjectToStatus(context, project.id, "planned");

  const crash = await spawnCrashChild(context, { crashMode, projectId: project.id });
  const pendingBefore = readReplayPending({
    domainId: context.domain.id,
    projectId: project.id,
    repoRoot: context.repoRoot,
  });
  assertCondition(pendingBefore, `crash scenario ${crashMode} did not leave a replay intent`);
  assertCondition(
    !crash.event.runId || pendingBefore.runId === crash.event.runId,
    `crash scenario ${crashMode} pending run mismatch`,
  );

  const postCrashProject = await context.client.getProjectContext(project.id);
  assertCrashPreReplayState({ crashMode, project: postCrashProject, shape: context.shape });

  const replayEvents = [];
  const replayResult = await runGatewayOnce({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    domains: [context.domain],
    runTimeoutMs: context.timeoutMs,
    onStatus: (event) => replayEvents.push(event),
    runFreshProject: async ({ projectId }) => {
      throw new Error(`fresh_decompose_unexpected_during_replay:${projectId}`);
    },
  });
  assertCondition(replayResult.ok, `gateway replay pass failed: ${replayResult.reason || replayResult.status}`);
  const pendingAfter = readReplayPending({
    domainId: context.domain.id,
    projectId: project.id,
    repoRoot: context.repoRoot,
  });
  const replayClassification = classifyReplayRecovery({
    statuses: replayEvents,
    projectId: project.id,
    expectedRunId: pendingBefore.runId,
    pendingBefore,
    pendingAfter,
  });
  assertCondition(replayClassification.ok, `replay recovery failed: ${replayClassification.reasons.join(", ")}`);

  const terminal = await waitForProjectStatus(context, project.id, {
    status: spec.terminalStatus,
    timeoutMs: context.timeoutMs,
  });
  return {
    ok: true,
    name: `crash-${crashMode}`,
    projectId: project.id,
    runId: pendingBefore.runId,
    artifactKind: pendingBefore.artifactKind,
    replayEvents,
    terminalStatus: terminal.status?.type || terminal.status?.name || null,
  };
}

async function runRejectedSuppressionScenario(context, { createdProjects }) {
  const project = await createDisposableProject(context, {
    name: scenarioProjectName(context, "rejected-suppression"),
    summary: "Gateway UAT ineligible Planned fixture.",
    status: "backlog",
    labelIds: [context.shape.projectLabels.hasOpenQuestions.id],
  });
  createdProjects.push(project.id);
  await moveProjectToStatus(context, project.id, "planned", {
    labelIds: [context.shape.projectLabels.hasOpenQuestions.id],
  });

  const firstEvents = await runSingleGatewayPass(context, { outcome: "commit" });
  const firstRuns = localRunsForProject(context, project.id);
  assertCondition(firstEvents.some((event) => event.projectId === project.id && event.state === "working"), "rejected project was not selected once");
  assertCondition(firstRuns.length === 1, `expected one rejected run, found ${firstRuns.length}`);

  const secondEvents = await runSingleGatewayPass(context, { outcome: "commit" });
  const secondRuns = localRunsForProject(context, project.id);
  assertCondition(secondEvents.some((event) => event.projectId === project.id && event.state === "suppressed"), "rejected project was not suppressed on same fingerprint");
  assertCondition(secondRuns.length === firstRuns.length, "suppressed project looped into another run");

  await context.client.updateProject(project.id, {
    description: `Human change to retrigger gateway UAT at ${new Date().toISOString()}.`,
  });
  const thirdEvents = await runSingleGatewayPass(context, { outcome: "commit" });
  const thirdRuns = localRunsForProject(context, project.id);
  assertCondition(thirdEvents.some((event) => event.projectId === project.id && event.state === "working"), "human change did not retrigger ineligible project");
  assertCondition(thirdRuns.length === firstRuns.length + 1, "human change did not create exactly one new rejected run");

  return {
    ok: true,
    name: "rejected-suppression-retrigger",
    projectId: project.id,
    firstRunCount: firstRuns.length,
    suppressedRunCount: secondRuns.length,
    retriggeredRunCount: thirdRuns.length,
  };
}

async function runSingleGatewayPass(context, { outcome }) {
  const events = [];
  const result = await runGatewayOnce({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    domains: [context.domain],
    runTimeoutMs: context.timeoutMs,
    onStatus: (event) => events.push(event),
    runFreshProject: deterministicRunFreshProject({ outcome }),
  });
  assertCondition(result.ok, `gateway pass failed: ${result.reason || result.status}`);
  return events;
}

async function spawnCrashChild(context, { crashMode, projectId }) {
  const args = [
    HARNESS_PATH,
    "--child-crash",
    crashMode,
    "--project-id",
    projectId,
    "--domain",
    context.domain.id,
    "--repo-root",
    context.repoRoot,
    "--timeout-ms",
    String(context.timeoutMs),
  ];
  if (context.pollIntervalMs) args.push("--poll-interval-ms", String(context.pollIntervalMs));

  const child = spawn(process.execPath, args, {
    cwd: context.repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = [];
  let stdout = "";
  let stderr = "";
  let settled = false;
  const waitForCrash = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      reject(new Error(`crash child timed out waiting for ${crashMode}. stdout=${stdout} stderr=${stderr}`));
    }, DEFAULT_CHILD_CRASH_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of drainJsonLines(stdout)) {
        if (line.remainder !== undefined) {
          stdout = line.remainder;
          continue;
        }
        if (line.value?.type !== CHILD_EVENT_TYPE) continue;
        events.push(line.value);
        if (line.value.event === "crash_point_reached" && !settled) {
          settled = true;
          clearTimeout(timer);
          killChild(child);
          resolve(line.value);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`crash child exited before crash point: exit=${code} signal=${signal || "none"} stdout=${stdout} stderr=${stderr}`));
    });
  });

  const event = await waitForCrash;
  await waitForChildClose(child, { timeoutMs: 10_000 });
  return { event, events };
}

async function runChildCrashGateway(options) {
  const context = await prepareLiveUatContext(options);
  const spec = CRASH_SCENARIOS[options.childCrash];
  const events = [];
  const result = await runGatewayLoop({
    repoRoot: context.repoRoot,
    config: context.config,
    registry: context.registry,
    domains: [context.domain],
    pollIntervalMs: context.pollIntervalMs,
    maxIterations: 1,
    runTimeoutMs: context.timeoutMs,
    sleep: abortableSleep,
    onStatus: (event) => {
      events.push(event);
      emitChildEvent({ event: "status", status: event });
    },
    runFreshProject: deterministicRunFreshProject({
      outcome: spec.outcome,
      crashMode: options.childCrash,
      crashProjectId: options.childProjectId,
      notifyCrash: (payload) => {
        emitChildEvent({ event: "crash_point_reached", crashMode: options.childCrash, ...payload });
      },
    }),
  });
  emitChildEvent({ event: "child_completed_without_crash", result, events });
}

function deterministicRunFreshProject({ outcome, crashMode = null, crashProjectId = null, notifyCrash = null } = {}) {
  return async function runDeterministicFreshProject(input = {}) {
    const crashController = crashMode
      ? createCrashController({ crashMode, projectId: crashProjectId, notifyCrash })
      : null;
    return runFreshSyntheticWake({
      ...input,
      createTraceSink: createNoopTraceSink,
      createStore: crashController
        ? (storeInput) => crashController.wrapStore(createLocalTriggerStore(storeInput))
        : undefined,
      createSetupGraphqlClient: crashController
        ? (clientInput) => {
          const setup = createLinearSetupGraphqlClient(clientInput);
          return { ...setup, client: crashController.wrapClient(setup.client) };
        }
        : undefined,
      runTriggeredDecompositionFn: async (runnerInput) => runTriggeredDecomposition({
        ...runnerInput,
        ...deterministicOrchestrator({ outcome }),
        qualityJudge: false,
      }),
    });
  };
}

function deterministicOrchestrator({ outcome }) {
  const roster = fakeRoster();
  const runtimeExecutor = fakeRuntimeExecutor();
  let turn = 0;
  return {
    roster,
    runtimeExecutor,
    orchestratorTurnExecutor: async (input = {}) => {
      turn += 1;
      if (outcome === "commit" && turn === 1) {
        return {
          controlAction: {
            action: "invoke_library",
            target_key: "prompt/decomposition/pm_product_sufficiency_pass",
          },
          evidence: null,
          sessionHandle: null,
        };
      }
      return {
        controlAction: {
          action: "terminate",
          outcome,
          reason: outcome === "commit" ? "synthesis_complete" : "discovery_needed",
        },
        producedContent: outcome === "commit"
          ? commitProducedContent(input.runId, input.project)
          : pauseProducedContent(input.runId, input.project),
        evidence: null,
        sessionHandle: null,
      };
    },
  };
}

function fakeRoster() {
  const byKey = {
    "prompt/decomposition/pm_product_sufficiency_pass": "pm",
    "prompt/decomposition/sr_eng_grounding_pass": "sr_eng",
  };
  return {
    selectableTargets: Object.keys(byKey),
    resolve(targetKey) {
      const role = byKey[targetKey];
      if (!role) return { ok: false, reason: "orchestrator_roster_target_not_selectable" };
      return {
        ok: true,
        runtime_role: role,
        loadSnapshot: () => ({
          entry: {
            target_key: targetKey,
            human_name: role === "sr_eng" ? "Senior Engineer" : "Product Manager",
          },
          contentBytes: `Gateway UAT deterministic library body for ${targetKey}.`,
          snapshotSha256: `gateway-uat-${role}`,
        }),
      };
    },
  };
}

function fakeRuntimeExecutor() {
  return {
    async executeSubagent({ runtime_role, runId }) {
      const reason = runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      const packet = {
        schema_version: SUBAGENT_TURN_CONTRACT_SCHEMA_VERSION,
        run_id: runId,
        status: "continue",
        reason,
        context_digest: `Gateway UAT ${runtime_role} deterministic context.`,
        source_refs: [{ kind: "gateway_uat", id: runId }],
        assumptions: [],
        constraints: [],
        risks: [],
      };
      return {
        ok: true,
        packet,
        output: JSON.stringify(packet),
        role: runtime_role,
        runtime: "gateway-uat",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: JSON.stringify(packet),
        envelope: `gateway uat deterministic ${runtime_role}`,
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "gateway_uat_deterministic_runtime" },
          ],
        },
      };
    },
  };
}

function commitProducedContent(runId, project = {}) {
  return {
    context_digest: "Gateway UAT produced a deterministic commit artifact for local poll/replay verification.",
    source_refs: [{ kind: "linear_project", id: project?.id || "unknown" }],
    assumptions: [],
    constraints: ["gateway_uat_deterministic_orchestrator"],
    risks: [],
    project_update_markdown: projectUpdateMarkdownForRun(runId, "Gateway UAT committed a deterministic issue set."),
    final_issues: [
      {
        decomposition_key: "gateway-uat-plan",
        title: "Gateway UAT execution issue",
        issue_body_markdown: [
          "## Assignment",
          "",
          "Verify the local gateway committed this disposable Planned project.",
          "",
          "## Acceptance Criteria",
          "",
          "- The project leaves Planned.",
          "- Replay can reuse this issue idempotently if the runner crashes.",
        ].join("\n"),
        depends_on: [],
        assignment: "Verify the local gateway committed this disposable Planned project.",
        output: "A committed Linear issue proving the gateway mutation path ran.",
        acceptance_criteria: [
          "The project leaves Planned.",
          "Replay can reuse this issue idempotently if the runner crashes.",
        ],
      },
    ],
  };
}

function pauseProducedContent(runId, project = {}) {
  return {
    context_digest: "Gateway UAT produced a deterministic pause artifact for local replay verification.",
    source_refs: [{ kind: "linear_project", id: project?.id || "unknown" }],
    assumptions: [],
    constraints: ["gateway_uat_deterministic_orchestrator"],
    risks: [],
    open_questions_markdown: [
      "- Question: Which disposable UAT decision should unblock this project?",
      "  Owner: Gateway UAT",
    ].join("\n"),
    project_update_markdown: projectUpdateMarkdownForRun(runId, "Gateway UAT paused for deterministic discovery."),
    discovery_issues: [
      {
        discovery_key: "gateway-uat-discovery",
        title: "Gateway UAT discovery issue",
        body_markdown: [
          "Confirm the pause replay path creates discovery issues after a crash before discovery.",
          "",
          "Evidence: the parent UAT process killed the child before this issue could be created.",
        ].join("\n"),
        in_session_research: "Not applicable to deterministic gateway UAT.",
        evidence_gap: "Live Linear replay behavior must create this issue idempotently.",
      },
    ],
  };
}

function projectUpdateMarkdownForRun(runId, summary) {
  return [
    `run_id: ${runId}`,
    "",
    summary,
    "",
    PROJECT_UPDATE_ACCOUNTABILITY_HEADING,
    "- This update was authored by the gateway UAT harness for disposable Linear artifacts.",
  ].join("\n");
}

function createCrashController({ crashMode, projectId, notifyCrash }) {
  let mutationIntent = null;
  let crashed = false;
  let keepAlive = null;
  const park = (payload) => {
    if (crashed) return new Promise(() => {});
    crashed = true;
    keepAlive = setInterval(() => {}, 60_000);
    notifyCrash?.({
      projectId,
      runId: mutationIntent?.runId || null,
      artifactKind: mutationIntent?.artifactKind || null,
      ...payload,
    });
    return new Promise(() => {});
  };
  return {
    wrapStore(store) {
      return {
        ...store,
        async markMutationStarted(input) {
          const result = await store.markMutationStarted(input);
          mutationIntent = {
            runId: input.runId,
            artifactKind: input.artifactKind,
          };
          if (crashMode === "before_mutation" && input.artifactKind === "commit") {
            return park({ crashPoint: "after_mutation_intent_before_linear_mutation" });
          }
          return result;
        },
      };
    },
    wrapClient(client) {
      return new Proxy(client, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "updateProject") {
            return async (id, input = {}) => {
              if (
                crashMode === "commit_before_started" &&
                id === projectId &&
                mutationIntent?.artifactKind === "commit" &&
                input?.statusId
              ) {
                return park({ crashPoint: "after_issue_create_before_project_started" });
              }
              return value.call(target, id, input);
            };
          }
          if (prop === "createIssue") {
            return async (input = {}) => {
              if (
                crashMode === "pause_before_discovery" &&
                input?.projectId === projectId &&
                mutationIntent?.artifactKind === "pause"
              ) {
                return park({ crashPoint: "after_pause_project_update_before_discovery_issue" });
              }
              return value.call(target, input);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

async function createDisposableProject(context, { name, summary, status, labelIds = [] }) {
  const project = await context.client.createProject({
    name,
    description: summary,
    content: testProjectContent({ name, summary }),
    teamIds: [context.shape.team.id],
    statusId: context.shape.projectStatuses[status].id,
    labelIds,
  });
  return project;
}

async function moveProjectToStatus(context, projectId, status, extra = {}) {
  return context.client.updateProject(projectId, {
    statusId: context.shape.projectStatuses[status].id,
    ...(Array.isArray(extra.labelIds) ? { labelIds: extra.labelIds } : {}),
  });
}

async function cleanupProjects(context, projectIds) {
  const results = [];
  if (context.keepArtifacts) {
    return { skipped: true, reason: "keep_artifacts", projects: [...projectIds] };
  }
  for (const projectId of [...new Set(projectIds)]) {
    try {
      const project = await context.client.getProjectContext(projectId);
      if (isTerminalProjectStatus(project.status)) {
        results.push({ projectId, ok: true, action: "already_terminal", status: project.status?.type || project.status?.name || null });
        continue;
      }
      await moveProjectToStatus(context, projectId, "backlog");
      results.push({ projectId, ok: true, action: "moved_to_backlog" });
    } catch (error) {
      results.push({ projectId, ok: false, error: error.message });
    }
  }
  return {
    skipped: false,
    ok: results.every((result) => result.ok),
    results,
  };
}

function assertCrashPreReplayState({ crashMode, project, shape }) {
  if (crashMode === "before_mutation") {
    assertCondition(matchesStatus(project.status, shape.projectStatuses.planned), "before-mutation crash moved project before replay");
    assertCondition((project.issues || []).length === 0, "before-mutation crash created Linear issues");
  } else if (crashMode === "commit_before_started") {
    assertCondition(matchesStatus(project.status, shape.projectStatuses.planned), "commit crash moved project to started before replay");
    assertCondition((project.issues || []).length > 0, "commit crash did not create issues before status update");
  } else if (crashMode === "pause_before_discovery") {
    assertCondition(matchesStatus(project.status, shape.projectStatuses.backlog), "pause crash did not move project to backlog before replay");
    assertCondition((project.issues || []).length === 0, "pause crash created discovery issues before replay");
  }
}

async function waitForProjectStatus(context, projectId, { status, timeoutMs }) {
  return waitForValue(async () => {
    const project = await context.client.getProjectContext(projectId);
    return matchesStatus(project.status, context.shape.projectStatuses[status]) ? project : null;
  }, { timeoutMs, intervalMs: 1_000, label: `project ${projectId} status ${status}` });
}

function localRunsForProject(context, projectId) {
  const state = readLocalTriggerState(localTriggerStorePath(context.repoRoot));
  return state.runs.filter((run) => run.object_id === projectId);
}

function scenarioProjectName(context, slug) {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15);
  return `${context.prefix} ${stamp} ${slug}`;
}

function testProjectContent({ name, summary }) {
  return buildProjectTemplateBody()
    .replace("Linear project: {project_name}", `Linear project: ${name}`)
    .replace("## Problem Or Opportunity\n", `## Problem Or Opportunity\n${summary}\n\n`)
    .replace("## Desired Outcome\n", "## Desired Outcome\nProve the local gateway poll and replay paths against disposable live Linear artifacts.\n\n")
    .replace("## Acceptance Evidence\n", "## Acceptance Evidence\nThe UAT harness observes status events and terminal Linear state.\n\n");
}

function isTerminalProjectStatus(status = {}) {
  const type = String(status?.type || "").toLowerCase();
  const name = String(status?.name || "").toLowerCase();
  return TERMINAL_PROJECT_STATUSES.has(type) || TERMINAL_PROJECT_STATUSES.has(name);
}

function createNoopTraceSink() {
  return {
    async startRun() {
      return { ok: true, traceId: null, status: "noop" };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun() {
      return { status: "noop" };
    },
    async shutdown() {},
  };
}

async function waitForValue(fn, { timeoutMs, intervalMs = 250, label }) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

function abortableSleep(ms, { signal = null } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    // NOTE: do NOT unref this timer. The UAT harness is a foreground process
    // that must stay alive across its poll/sleep windows; unref'ing would let
    // the event loop empty mid-run and exit 0 silently (no TTY holds it open).
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

function sleep(ms) {
  // Ref'd on purpose (see abortableSleep): the harness must not exit mid-run
  // while only a sleep timer is pending.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 2_000).unref?.();
}

function waitForChildClose(child, { timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function drainJsonLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || "";
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push({ value: JSON.parse(line) });
    } catch {
      // Ignore non-JSON subprocess output.
    }
  }
  parsed.push({ remainder });
  return parsed;
}

function emitChildEvent(payload) {
  process.stdout.write(`${JSON.stringify({ type: CHILD_EVENT_TYPE, ...payload })}\n`);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePositiveInteger(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UatUserError(`expected a positive integer, got ${value}`, "usage");
  }
  return parsed;
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new UatUserError(`${flag} requires a value`, "usage");
  return value;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export async function main({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  exit = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let options;
  try {
    options = parseGatewayUatArgs(argv);
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildGatewayUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    if (options.childCrash) {
      await runChildCrashGateway(options);
      exit(1);
      return { ok: false, stage: "child_completed_without_crash" };
    }

    const report = await runGatewayUat(options);
    for (const scenario of report.scenarios) {
      stdout(`PASS ${scenario.name}`);
    }
    stdout(`Gateway UAT created ${report.createdProjects.length} disposable Linear project(s).`);
    if (report.cleanup?.skipped) {
      stdout(`Cleanup skipped: ${report.cleanup.reason}.`);
    } else if (report.cleanup?.ok === false) {
      stderr(`Cleanup had failures: ${JSON.stringify(report.cleanup.results)}`);
      exit(1);
      return { ok: false, stage: "cleanup", report };
    }
    stdout("GATEWAY UAT PASS");
    exit(0);
    return { ok: true, report };
  } catch (error) {
    const message = error instanceof UatUserError ? error.message : `GATEWAY UAT FAIL: ${error?.message || String(error)}`;
    stderr(message);
    if (!(error instanceof UatUserError)) {
      stderr(`Run store: ${defaultRunStoreDir(options.repoRoot)}`);
    }
    exit(error instanceof UatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "run", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(`GATEWAY UAT FAIL: ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
