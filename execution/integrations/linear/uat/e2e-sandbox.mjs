// Disposable end-to-end harness for the self-improvement loop.
//
// One command that runs the loop unattended against a DISPOSABLE test
// environment: a throwaway Linear test team (the bound team), local Phoenix,
// the claude/codex CLIs, and the bound behavior repo. It creates only
// test-prefixed Linear artifacts and is intended for a disposable workspace
// where real model runs and self-fabricated labels are acceptable. It does not
// touch any production workspace.
//
// Design: thin glue over existing entrypoints, NOT a new framework. Each step
// reuses a real product entrypoint and reports an honest status (ok / skip /
// fail with a reason).
//
// The loop, one slice (decomposition) first, then expand to execution + review:
//   reset -> produce (gateway, real decomposition) -> judge -> fabricated label
//   -> improvement proposal (PR on the bound behavior repo).
//
// Usage:  npm run uat:e2e-sandbox -- --team <id> [--keep] [--label good|bad]
//         npm run uat:e2e-sandbox -- --team <id> --preflight-only   (check env readiness only)

import path from "node:path";
import { pathToFileURL } from "node:url";

import { readLinearCache } from "../src/cache.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readTeamRegistry } from "../src/team-registry.mjs";
import { buildTeamContext } from "../src/team-resolver.mjs";
import { selectGatewayTeams, runGatewayOnce } from "../src/gateway-loop.mjs";
import { registerGitRepoResourceKind } from "../../git/git-repo-materializer.mjs";
import { createLinearCredentialStore } from "../src/linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../src/linear-setup-auth.mjs";
import { resolveLinearShape } from "../src/linear/shape-resolver.mjs";
import { renderPlanningBody } from "../src/project-planning-body.mjs";
import { ensurePhoenixReady } from "../src/local-phoenix-manager.mjs";
import { readRuntimeSmokeCache, runtimeSmokeCachePath, runtimeVersionsFromRuntimeSmokeCache } from "../src/runtime-smoke.mjs";
import { readLocalTriggerState, localTriggerStorePath } from "../src/local-trigger-store.mjs";
import { readTraceReceipt } from "../src/trace-status-store.mjs";
import { runDecompositionQualityJudge } from "../src/decomposition-quality-judge.mjs";
import { createPhoenixTraceAnnotation, resolveAnnotationIdentifier } from "../src/phoenix-self-improvement.mjs";
import { resolveBehaviorRepoIdentity } from "../src/github-setup.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const TEST_PREFIX = "AF-E2E";
const TEST_PREFIXES = ["AF-E2E", "AF-UAT", "AF-DIAG"];

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { teamRef: null, keep: false, label: "good", repoRoot: REPO_ROOT, preflightOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--team") {
      const teamRef = argv[++i];
      if (!teamRef || teamRef.startsWith("--")) throw new Error("uat:e2e-sandbox requires --team <id> (integration smoke targets one explicit team)");
      opts.teamRef = teamRef;
    }
    else if (a === "--keep") opts.keep = true;
    else if (a === "--label") opts.label = argv[++i];
    else if (a === "--repo-root") opts.repoRoot = path.resolve(argv[++i]);
    else if (a === "--preflight-only") opts.preflightOnly = true;
    else throw new Error(`unknown uat:e2e-sandbox flag: ${a}`);
  }
  if (!["good", "bad"].includes(opts.label)) throw new Error(`--label must be good|bad`);
  return opts;
}

const stamp = () => new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15);

export function requireExplicitTeamRef(opts = {}) {
  if (!opts?.teamRef) {
    throw new Error("uat:e2e-sandbox requires --team <id> (integration smoke targets one explicit team)");
  }
  return opts.teamRef;
}

export function verifyPollScopeApplied(pollResult, seededProjectId) {
  const expectedProjectId = typeof seededProjectId === "string" && seededProjectId.length > 0 ? seededProjectId : null;
  const processedProjectIds = [];
  const offenders = [];
  let seededProcessed = false;
  for (const team of pollResult?.poll?.teams || []) {
    const teamRef = team?.teamRef ?? null;
    let index = 0;
    for (const entry of team?.processed || []) {
      const projectId = entry?.projectId;
      processedProjectIds.push(projectId);
      if (expectedProjectId !== null && projectId === expectedProjectId) {
        seededProcessed = true;
      } else if (projectId !== null && projectId !== undefined) {
        // A processed entry carrying a DIFFERENT project id is a real scope leak.
        // Entries with no project id are non-project poll work (status/marker sweeps
        // and other bookkeeping targets that legitimately run under any scope) — the
        // scope is proven by the seeded project being processed and no OTHER project
        // appearing, not by every poll entry naming the seeded project.
        offenders.push({ teamRef, index, projectId });
      }
      index += 1;
    }
  }
  return {
    ok: Boolean(expectedProjectId) && seededProcessed && offenders.length === 0,
    processedProjectIds,
    offenders,
  };
}

export function buildAcceptanceRecord({
  team,
  seededProjectId,
  pollScopeResult,
  produceOk,
  judgeOk,
  labelOk,
  teardown,
} = {}) {
  const teardownData = teardown?.data || teardown || {};
  return {
    team: typeof team === "string" ? team : team?.id ?? null,
    seeded_project_id: seededProjectId ?? null,
    poll_scope_applied: Boolean(pollScopeResult?.ok),
    loop: {
      produce: Boolean(produceOk),
      judge: Boolean(judgeOk),
      label: Boolean(labelOk),
    },
    teardown_action: teardownData.teardown_action ?? null,
    board_empty: teardown?.ok === false ? false : teardownData.board_empty ?? null,
  };
}

export function acceptanceRecordPasses(record) {
  return Boolean(
    typeof record?.team === "string"
      && record.team.length > 0
      && typeof record.seeded_project_id === "string"
      && record.seeded_project_id.length > 0
      && record.poll_scope_applied === true
      && record.loop?.produce === true
      && record.loop?.judge === true
      && record.loop?.label === true
      && ["archived", "parked"].includes(record.teardown_action)
      && record.board_empty === true,
  );
}

async function buildContext(opts) {
  requireExplicitTeamRef(opts);
  // The team registry can bind git_repo resources (since #90); register that resource kind
  // before reading the registry, or readTeamRegistry throws unknown_resource_kind:git_repo.
  registerGitRepoResourceKind();
  const repoRoot = opts.repoRoot;
  const config = loadLinearConfig({ repoRoot });
  const registry = readTeamRegistry({ repoRoot });
  const teams = selectGatewayTeams({ registry, teamRef: opts.teamRef });
  const team = teams.find((d) => d.id === opts.teamRef);
  if (!team) throw new Error("no active Linear team — run npm run init against the disposable test team");
  const teamContext = buildTeamContext({ team, config, repoRoot });
  const credentialStore = createLinearCredentialStore({ config, repoRoot, teamContext });
  const client = createLinearSetupGraphqlClient({
    config, repoRoot, credentialStore, allowBrowserAuth: false, allowRefresh: true,
  }).client;
  await client.verifyAuth();
  const cache = readLinearCache(teamContext.linear.cachePath);
  const shape = await resolveLinearShape({ client, config, cache });
  return { repoRoot, config, registry, team, teamContext, client, shape };
}

// --- Steps. Each returns { ok, status, detail, data? } and never throws. ---

async function stepPreflight(ctx) {
  const checks = [];
  checks.push({ name: "linear team", ok: ctx.team?.status === "active", detail: `${ctx.team?.id} (${ctx.shape?.team?.id})` });
  const smoke = readRuntimeSmokeCache(runtimeSmokeCachePath(ctx.config, ctx.repoRoot));
  const versions = runtimeVersionsFromRuntimeSmokeCache(smoke) || {};
  const haveRuntimes = Boolean(versions.claude && versions.codex);
  checks.push({ name: "runtime smoke cache", ok: haveRuntimes, detail: haveRuntimes ? `claude ${versions.claude}, codex ${versions.codex}` : "missing — run npm run runtime-smoke" });
  let phoenix = null;
  try { phoenix = await ensurePhoenixReady({ repoRoot: ctx.repoRoot }); } catch (e) { phoenix = { ok: false, reason: e.message }; }
  checks.push({ name: "local phoenix", ok: Boolean(phoenix?.ok), detail: phoenix?.appUrl || phoenix?.reason || "unavailable" });
  const behaviorRepo = resolveBehaviorRepoIdentity({ repoRoot: ctx.repoRoot });
  checks.push({
    name: "sandbox behavior repo",
    ok: Boolean(behaviorRepo?.ok),
    detail: behaviorRepo?.ok ? `${behaviorRepo.owner}/${behaviorRepo.repo}` : `not wired (${behaviorRepo?.reason || "no verified connection"}) — improvement PR step will be skipped`,
  });
  ctx.phoenix = phoenix;
  ctx.behaviorRepo = behaviorRepo;
  const hardOk = checks.filter((c) => c.name !== "sandbox behavior repo").every((c) => c.ok);
  return { ok: hardOk, status: hardOk ? "ok" : "fail", detail: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n      "), data: { checks } };
}

// Ephemeral reset: park any leftover test-prefixed PLANNED project (the only
// state the gateway polls) into backlog so a run starts from a clean queue.
async function stepReset(ctx) {
  let parked = 0;
  for (const p of await listTestPrefixedPlannedProjects(ctx)) {
    await ctx.client.updateProject(p.id, { statusId: ctx.shape.projectStatuses.backlog.id });
    parked += 1;
  }
  return { ok: true, status: "ok", detail: `parked ${parked} leftover planned test project(s) into backlog` };
}

async function listTestPrefixedPlannedProjects(ctx) {
  const teamId = ctx.team.linear.team_id;
  const projects = [];
  let after = null;
  do {
    const page = await ctx.client.listPlannedProjectCandidates(teamId, { first: 50, after });
    for (const p of page.candidates || []) {
      if (TEST_PREFIXES.some((pre) => (p.name || "").startsWith(pre))) projects.push(p);
    }
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return projects;
}

// Produce a real decomposition trace via the gateway (the actual product path:
// Planned project -> gateway -> real orchestrator -> commit + Phoenix trace).
async function stepProduce(ctx) {
  const name = `${TEST_PREFIX} ${stamp()} decomposition`;
  const content = renderPlanningBody({
    problem: `Disposable e2e decomposition project: ${name}.`,
    audience: "Teami maintainers validating the local gateway against disposable Linear artifacts.",
    desired_outcome: "Produce a real decomposition trace through the gateway and local Phoenix.",
    acceptance: "The gateway observes the Planned project, runs decomposition, and records trace evidence.",
    scope: "Disposable e2e only; do not use production Linear artifacts or product repositories.",
    constraints: "Use the bound team, local credentials, and configured gateway path.",
    sources: "Generated by the e2e sandbox harness for live UAT coverage.",
    human_decisions: "None for this disposable verification run.",
  });
  const project = await ctx.client.createProject({
    name,
    description: "Disposable e2e: real decomposition for the self-improvement loop.",
    content,
    teamIds: [ctx.shape.team.id],
    statusId: ctx.shape.projectStatuses.planned.id,
  });
  ctx.project = project;

  // One real gateway pass. No runFreshProject override -> the real orchestrator
  // (claude pm + codex sr_eng) runs and writes the run to the default store +
  // a Phoenix trace receipt.
  const result = await runGatewayOnce({
    repoRoot: ctx.repoRoot,
    config: ctx.config,
    registry: ctx.registry,
    teams: [ctx.team],
    pollScope: { projectIds: [ctx.project.id] },
  });
  ctx.pollResult = result;
  if (!result.ok) return { ok: false, status: "fail", detail: `gateway pass not ok: ${result.reason || result.status}` };

  const state = readLocalTriggerState(localTriggerStorePath());
  const run = [...(state.runs || [])].reverse().find((r) => r.object_id === project.id && r.run_id);
  if (!run) return { ok: false, status: "fail", detail: "no run recorded for the produced project" };
  ctx.runId = run.run_id;
  const receipt = readTraceReceipt({ repoRoot: ctx.repoRoot, runId: run.run_id });
  ctx.traceId = receipt?.trace_id || null;
  // Both terminal outcomes are real, judgeable, traced runs: a `completed` run
  // committed issues; a `paused` run raised a project-comment question. The loop
  // (judge -> label) runs over either — only a non-terminal run is a failure.
  const terminal = ["completed", "paused"].includes(run.status);
  return {
    ok: terminal,
    status: terminal ? "ok" : "fail",
    detail: `run=${run.run_id} outcome=${run.status === "paused" ? "paused (human input needed)" : run.status} trace=${ctx.traceId || "none"}`,
    data: { runId: run.run_id, traceId: ctx.traceId, outcome: run.status },
  };
}

async function stepJudge(ctx) {
  if (!ctx.runId) return { ok: false, status: "skip", detail: "no run to judge" };
  const result = await runDecompositionQualityJudge({ repoRoot: ctx.repoRoot, runId: ctx.runId, config: ctx.config });
  return {
    ok: Boolean(result?.ok),
    status: result?.ok ? "ok" : "fail",
    detail: result?.ok ? `judge label=${result.label ?? "?"} score=${result.score ?? "?"}` : `judge: ${result?.reason || "failed"}`,
    data: { judge: result },
  };
}

// Fabricated HUMAN label: in this disposable env the agent invents a good/bad
// label so the human-annotation arm of the loop runs without a human present.
async function stepFabricatedLabel(ctx, opts) {
  if (!ctx.traceId) return { ok: false, status: "skip", detail: "no Phoenix trace_id to annotate (Phoenix trace receipt missing)" };
  const score = opts.label === "good" ? 0.9 : 0.2;
  // Resolve a non-empty annotation identifier first (Phoenix upserts by
  // (name, target, identifier); an empty identifier could merge/overwrite other
  // judgments). The CLI does this too — the harness must not skip it.
  const resolvedIdentifier = resolveAnnotationIdentifier({ annotatorKind: "HUMAN", config: ctx.config });
  // Canonical quality label set is pass|needs_revision|blocking_failure (must not drift).
  const annotation = await createPhoenixTraceAnnotation({
    repoRoot: ctx.repoRoot,
    traceId: ctx.traceId,
    name: "quality",
    label: opts.label === "good" ? "pass" : "needs_revision",
    score,
    explanation: `Disposable e2e fabricated human label (${opts.label}); agent-invented in the test sandbox.`,
    annotatorKind: "HUMAN",
    identifier: resolvedIdentifier.identifier,
    workspaceMaturity: "new",
  });
  return { ok: true, status: "ok", detail: `annotated trace ${ctx.traceId} as ${opts.label}`, data: { annotation } };
}

// Improvement proposal -> PR on the bound behavior repo. It needs a verified
// behavior-repo connection in a dedicated checkout, plus explicit candidate
// intent. Until that is stood up it reports honestly as skipped rather than
// pretending a PR was opened.
async function stepImprovementPr(ctx) {
  if (!ctx.behaviorRepo?.ok) {
    return { ok: false, status: "skip", detail: `improvement PR step needs a verified behavior-repo connection in a dedicated checkout (currently: ${ctx.behaviorRepo?.reason || "not wired"}).` };
  }
  // Wired but intentionally conservative: opening a real PR requires explicit
  // candidate intent (a Phoenix promotion-candidate tag or a promotion_candidate
  // receipt) and the promotion scan/drafter against the sandbox checkout. Left
  // as the final wire so this harness never fabricates a proposal.
  return { ok: false, status: "skip", detail: "candidate-intent + drafter against the sandbox checkout is the final wire (see plan); not auto-run to avoid a fabricated proposal" };
}

export async function stepTeardown(ctx, opts = {}) {
  if (opts.keep) {
    return {
      ok: true,
      status: "skip",
      detail: "--keep set; skipped teardown, so board-empty acceptance is not claimed",
      data: { teardown_action: null, board_empty: null },
    };
  }
  if (!ctx.project?.id) {
    return {
      ok: false,
      status: "fail",
      detail: "no seeded project was recorded for teardown",
      data: { teardown_action: null, board_empty: false },
    };
  }

  let teardownAction = null;
  try {
    if (typeof ctx.client.archiveProject === "function") {
      await ctx.client.archiveProject(ctx.project.id);
      teardownAction = "archived";
    } else {
      await ctx.client.updateProject(ctx.project.id, { statusId: ctx.shape.projectStatuses.backlog.id });
      teardownAction = "parked";
    }
  } catch (e) {
    // A *completed* decomposition leaves the project holding issues, and Linear
    // refuses to archive/delete such a project. Parking it out of Planned is
    // always safe and fully clears the trigger board (the gateway only polls
    // Planned), so fall back to a park before failing.
    try {
      await ctx.client.updateProject(ctx.project.id, { statusId: ctx.shape.projectStatuses.backlog.id });
      teardownAction = "parked";
    } catch (parkError) {
      return {
        ok: false,
        status: "fail",
        detail: `teardown failed while ${teardownAction || "cleaning up"} seeded project: ${e.message}; park fallback also failed: ${parkError.message}`,
        data: { teardown_action: null, board_empty: false },
      };
    }
  }

  try {
    const remaining = await listTestPrefixedPlannedProjects(ctx);
    const boardEmpty = remaining.length === 0;
    return {
      ok: boardEmpty,
      status: boardEmpty ? "ok" : "fail",
      detail: boardEmpty
        ? `${teardownAction} seeded project; test-prefixed Planned board is empty`
        : `${teardownAction} seeded project, but test-prefixed Planned project(s) remain: ${remaining.map((p) => p.name || p.id).join(", ")}`,
      data: { teardown_action: teardownAction, board_empty: boardEmpty },
    };
  } catch (e) {
    return {
      ok: false,
      status: "fail",
      detail: `${teardownAction} seeded project, but board-empty verification failed: ${e.message}`,
      data: { teardown_action: teardownAction, board_empty: false },
    };
  }
}

export async function runE2eSandbox(opts = parseArgs()) {
  const ctx = await buildContext(opts);
  const steps = [];
  const record = async (name, fn) => {
    process.stdout.write(`\n[${name}] ...\n`);
    let r;
    try { r = await fn(); }
    catch (e) { r = { ok: false, status: "fail", detail: e.message }; }
    steps.push({ name, ...r });
    process.stdout.write(`[${name}] ${r.status.toUpperCase()} — ${r.detail}\n`);
    return r;
  };

  const pre = await record("preflight", () => stepPreflight(ctx));
  if (!pre.ok) {
    process.stdout.write("\nPreflight failed — fix the env above and re-run.\n");
    return { ok: false, steps };
  }
  await record("reset", () => stepReset(ctx));
  if (opts.preflightOnly) {
    process.stdout.write("\n--preflight-only: env is ready; stopping before the real-model produce step.\n");
    return { ok: true, steps, preflightOnly: true };
  }
  const produced = await record("produce (gateway decomposition)", () => stepProduce(ctx));
  let judged = null;
  let labeled = null;
  if (produced.ok) {
    judged = await record("judge", () => stepJudge(ctx));
    labeled = await record("fabricated label", () => stepFabricatedLabel(ctx, opts));
  }
  await record("improvement PR", () => stepImprovementPr(ctx));
  const teardown = await record("teardown", () => stepTeardown(ctx, opts));

  const pollScopeResult = verifyPollScopeApplied(ctx.pollResult, ctx.project?.id);
  const acceptance = buildAcceptanceRecord({
    team: ctx.team,
    seededProjectId: ctx.project?.id,
    pollScopeResult,
    produceOk: produced.ok,
    judgeOk: judged?.ok,
    labelOk: labeled?.ok,
    teardown,
  });
  const coreOk = produced.ok && Boolean(judged?.ok) && Boolean(labeled?.ok);
  const acceptanceOk = acceptanceRecordPasses(acceptance);
  process.stdout.write(`\n=== Disposable e2e summary ===\n`);
  for (const s of steps) process.stdout.write(`  ${s.status === "ok" ? "✓" : s.status === "skip" ? "·" : "✗"} ${s.name}: ${s.detail.split("\n")[0]}\n`);
  process.stdout.write(`\nLoop core (produce→judge→label): ${coreOk ? "GREEN" : "incomplete"}. Improvement PR: see status above.\n`);
  process.stdout.write(`ACCEPTANCE ${JSON.stringify(acceptance)}\n`);
  return {
    ok: acceptanceOk,
    steps,
    acceptance,
    pollScopeResult,
    ctx: { runId: ctx.runId, traceId: ctx.traceId, projectId: ctx.project?.id },
  };
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  runE2eSandbox().then((r) => { process.exitCode = r.ok ? 0 : 1; }).catch((e) => {
    console.error(`E2E SANDBOX FAIL: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
