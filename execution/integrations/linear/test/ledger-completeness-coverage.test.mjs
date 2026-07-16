import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_CONFIG_PATH,
  loadLinearConfig,
  UNPINNED_RUNTIME_DEV_FLAG,
} from "../src/config.mjs";
import { createSnapshotEvalLinearClient } from "../src/decomposition-eval-cli.mjs";
import { readRunArtifact } from "../../../engine/run-store.mjs";
import {
  runDecomposition,
} from "../src/workflows/decomposition/run-service.mjs";
import {
  runDecompositionOrchestrator,
} from "../src/trigger-runner.mjs";
import { DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY } from "../src/promotion-target-keys.mjs";
import {
  loadJudgePromptContract,
  loadPromptRegistrationContract,
} from "../src/decomposition-quality-judge.mjs";

// ---------------------------------------------------------------------------
// The #50 ledger-completeness COVERAGE TEST (Seam 3 of the agent-driven-
// orchestrator breakdown — I-3). BUILD ACCEPTANCE: no accepted state ships
// with an incomplete run-version ledger (the #50 re-key). Two required parts:
//
//   (1) RUNTIME per-path assertions — drive the orchestrator loop with fakes
//       and prove the run's accepted_refs capture EXACTLY the accepted-behavior
//       versions a run consumed, and nothing it did not:
//         - library prompts that were invoked (invoke_library) ARE captured;
//         - uncalled roster entries are ABSENT;
//         - one-off prompt BODIES are absent (one-offs mint no accepted ref);
//         - the runtime-role-defaults rule is captured on BOTH a library-only
//           run AND a one-off-only run (an executed role consumed accepted
//           defaults);
//         - the JUDGE is captured (when qualityJudge ran), appended post-
//           assembly to the artifact's accepted_refs;
//         - the GOVERNING prompt is captured EVEN ON A ONE-OFF-ONLY RUN (it
//           loads through the recorder at run-start, regardless of which
//           subagents ran).
//
//   (2) STATIC completeness guard — enumerate EVERY accepted-snapshot load site
//       in execution/integrations/linear/src and assert each is EITHER routed
//       through the run recorder / the run loop OR on a NAMED non-run allowlist.
//       A NEW run-path accepted-snapshot load that is neither recorder-routed
//       nor allowlisted FAILS this test (this is what keeps the ledger complete
//       as load paths are added).
// ---------------------------------------------------------------------------

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..", "..");

const GOVERNING_TARGET_KEY = "prompt/decomposition/orchestrator_governing";
const RUNTIME_ROLE_DEFAULTS_TARGET_KEY = "rule/decomposition/runtime_role_assignments";
const SR_ENG_LIBRARY = "prompt/decomposition/sr_eng_grounding_pass";
const PM_LIBRARY = "prompt/decomposition/pm_product_sufficiency_pass";

// ---------------------------------------------------------------------------
// Self-contained fakes (modeled on orchestrator-loop.test.mjs) so the loop
// never spawns a real CLI and the test owns no real Linear surface.
// ---------------------------------------------------------------------------

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

function subagentTurn(runId, reason) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status: "continue",
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

// A roster whose resolve() yields a runtime_role + a synthetic snapshot whose
// snapshotSha256 is TRUTHY (so recordLibraryLoad mints a real captured ref).
function fakeRoster() {
  const byKey = {
    [SR_ENG_LIBRARY]: "sr_eng",
    [PM_LIBRARY]: "pm",
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
          entry: { target_key: targetKey },
          contentBytes: `BODY for ${targetKey}`,
          snapshotSha256: `sha-${targetKey}`,
        }),
      };
    },
  };
}

function fakeSubagentExecutor() {
  const calls = [];
  return {
    calls,
    async executeSubagent({ runtime_role, prompt, runId }) {
      calls.push({ runtime_role, prompt });
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      return {
        packet: subagentTurn(runId, reason),
        role: runtime_role,
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
}

function commitProducedContent(runId) {
  return {
    context_digest: "Reviewed project intent and grounded constraints for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: [
      `run_id: ${runId}`,
      "",
      "Decomposed the project into an agent-ready issue set.",
      "",
      "## What I did with each part of your project",
      "- The goal section became the plan issue; nothing is blocked.",
    ].join("\n"),
    final_issues: [
      {
        decomposition_key: "project-plan",
        title: "Prepare execution setup",
        issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
        depends_on: [],
        assignment: "Plan the setup.",
        output: "A documented execution setup plan.",
        acceptance_criteria: ["Plan exists."],
      },
    ],
  };
}

// A library-only orchestrator: invokes the given library targets in order, then
// terminate(commit) with valid producedContent.
function libraryOnlyOrchestrator(runId, libraryOrder) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };
}

// A one-off-only orchestrator: invokes ONE improvised subagent on a whitelisted
// runtime_role (mints no accepted-prompt ref), then terminate(commit).
function oneOffOnlyOrchestrator(runId, runtimeRole, oneOffPromptBody) {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: {
          action: "invoke_one_off",
          role_label: "ad_hoc_reviewer",
          task: "Spot-check the issue split.",
          prompt: oneOffPromptBody,
          runtime_role: runtimeRole,
        },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };
}

// Clone the loaded config and mark ONE executed role as resolving its runtime
// from the accepted runtime-role defaults (vs adopter config), plus the stashed
// load-time ref — so the run records the runtime-defaults rule (Seam 3:
// "an executed role consumed accepted defaults"). The example config otherwise
// pins every role in adopter config, so the rule ref is absent by default.
function configWithAcceptedDefaultsFor(role) {
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const decomposition = config.workflows.decomposition;
  decomposition.role_field_sources = {
    ...(decomposition.role_field_sources || {}),
    [role]: { runtime: "accepted_defaults", model: "adopter_config" },
  };
  decomposition.accepted_runtime_defaults_ref = {
    target_key: RUNTIME_ROLE_DEFAULTS_TARGET_KEY,
    accepted_baseline_id: "sha256:loadtime-defaults",
    snapshot_sha256: "loadtime-defaults",
  };
  return config;
}

function configWithPinnedRuntimeRoles(rolePins) {
  const config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  for (const [role, fields] of Object.entries(rolePins)) {
    config.workflows.decomposition.roles[role] ??= {};
    Object.assign(config.workflows.decomposition.roles[role], fields);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-pinned-config-"));
  const configPath = path.join(tempDir, "config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return loadLinearConfig({ repoRoot: REPO_ROOT, configPath });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function targetKeys(acceptedRefs) {
  return acceptedRefs.map((ref) => ref.target_key);
}

function ledgerCoverageRunStoreDir(runId) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `ledger-coverage-test-${runId}-${suffix}`);
}

// Single funnel for the orchestrator run loop so the per-path tests share ONE
// call site (the loop entry point is the live run-loop API). Per-test variation
// rides on the options.
function runLoop({
  runId,
  config,
  project = { id: "project-1", name: "Project" },
  wake = { id: "wake-1", object_id: "project-1" },
  event = { id: "event-1" },
  runtimeExecutor,
  orchestratorTurnExecutor,
  roster = fakeRoster(),
}) {
  return runDecompositionOrchestrator({
    runId,
    wake,
    event,
    project,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    repoRoot: REPO_ROOT,
  });
}

// ---------------------------------------------------------------------------
// PART 1 — runtime per-path assertions.
// ---------------------------------------------------------------------------

test("ledger coverage: a library-only run captures invoked libraries + governing + the runtime-defaults rule; uncalled roster entries are absent", async () => {
  const runId = "ledger_library_only";
  // sr_eng resolves runtime from accepted defaults; sr_eng IS executed (the run
  // invokes the sr_eng library), so the runtime-defaults rule must be captured.
  const config = configWithAcceptedDefaultsFor("sr_eng");
  const runtimeExecutor = fakeSubagentExecutor();

  // Invoke ONLY sr_eng (pm_product_sufficiency_pass stays uncalled).
  const result = await runLoop({
    runId,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor: libraryOnlyOrchestrator(runId, [SR_ENG_LIBRARY]),
  });

  const keys = targetKeys(result.acceptedRefs);
  // The invoked library IS captured.
  assert.ok(keys.includes(SR_ENG_LIBRARY), `expected ${SR_ENG_LIBRARY} captured: ${keys.join(", ")}`);
  // The governing prompt is captured (loaded through the recorder at run-start).
  assert.ok(keys.includes(GOVERNING_TARGET_KEY), `expected governing captured: ${keys.join(", ")}`);
  // The runtime-defaults rule is captured (sr_eng executed and used accepted defaults).
  assert.ok(keys.includes(RUNTIME_ROLE_DEFAULTS_TARGET_KEY), `expected rule captured: ${keys.join(", ")}`);
  // The uncalled roster entry is ABSENT (it was never invoked, so never loaded).
  assert.ok(!keys.includes(PM_LIBRARY), `uncalled ${PM_LIBRARY} must be absent: ${keys.join(", ")}`);
  // The captured-at-load runtime-defaults ref is recorded verbatim (joinable).
  const ruleRef = result.acceptedRefs.find((r) => r.target_key === RUNTIME_ROLE_DEFAULTS_TARGET_KEY);
  assert.equal(ruleRef.snapshot_sha256, "loadtime-defaults");
});

test("ledger coverage: a one-off-only run captures the governing prompt + the runtime-defaults rule, but NO one-off prompt body", async () => {
  const runId = "ledger_one_off_only";
  // pm resolves runtime from accepted defaults; pm IS executed (the one-off runs
  // on the pm runtime role), so the runtime-defaults rule must be captured.
  const config = configWithAcceptedDefaultsFor("pm");
  const runtimeExecutor = fakeSubagentExecutor();
  const oneOffPromptBody = "ONE-OFF BODY: improvised reviewer instructions (never an accepted prompt).";

  const result = await runLoop({
    runId,
    config,
    runtimeExecutor,
    orchestratorTurnExecutor: oneOffOnlyOrchestrator(runId, "pm", oneOffPromptBody),
  });

  // The one-off actually ran on the pm runtime role.
  assert.deepEqual(runtimeExecutor.calls.map((c) => c.runtime_role), ["pm"]);
  assert.equal(runtimeExecutor.calls[0].prompt, oneOffPromptBody);

  const keys = targetKeys(result.acceptedRefs);
  // GOVERNING captured EVEN ON A ONE-OFF-ONLY RUN (run-start load, not subagent-gated).
  assert.ok(keys.includes(GOVERNING_TARGET_KEY), `expected governing captured on one-off-only run: ${keys.join(", ")}`);
  // The runtime-defaults rule is captured (pm executed and used accepted defaults).
  assert.ok(keys.includes(RUNTIME_ROLE_DEFAULTS_TARGET_KEY), `expected rule captured: ${keys.join(", ")}`);
  // NO library refs (a one-off mints no accepted-prompt ref).
  assert.ok(!keys.includes(SR_ENG_LIBRARY) && !keys.includes(PM_LIBRARY), `no library refs expected: ${keys.join(", ")}`);
  // The one-off BODY is nowhere in the accepted refs (one-offs are not accepted behavior).
  const serialized = JSON.stringify(result.acceptedRefs);
  assert.ok(!serialized.includes("ONE-OFF BODY"), "one-off prompt body must not appear in accepted_refs");
  // Only the governing prompt + the runtime-defaults rule are present.
  assert.deepEqual(
    keys.slice().sort(),
    [GOVERNING_TARGET_KEY, RUNTIME_ROLE_DEFAULTS_TARGET_KEY].sort(),
  );
});

test("ledger coverage: with every role pinned in adopter config, the runtime-defaults rule is ABSENT (only consumed defaults are recorded)", async () => {
  const runId = "ledger_no_defaults";
  // Under W5-1, config.example intentionally resolves runtime roles from
  // accepted defaults. To exercise the "no consumed defaults" invariant, this
  // test must opt into adopter overrides and pin every executed role.
  const previousDevFlag = process.env[UNPINNED_RUNTIME_DEV_FLAG];
  process.env[UNPINNED_RUNTIME_DEV_FLAG] = "1";
  try {
    const config = configWithPinnedRuntimeRoles({
      orchestrator: { runtime: "claude", model: "test-orchestrator-model" },
      sr_eng: { runtime: "codex", model: "test-sr-eng-model" },
      pm: { runtime: "claude", model: "test-pm-model" },
    });

    assert.deepEqual(config.workflows.decomposition.role_field_sources.orchestrator, {
      runtime: "adopter_config",
      model: "adopter_config",
    });
    assert.deepEqual(config.workflows.decomposition.role_field_sources.sr_eng, {
      runtime: "adopter_config",
      model: "adopter_config",
    });
    assert.deepEqual(config.workflows.decomposition.role_field_sources.pm, {
      runtime: "adopter_config",
      model: "adopter_config",
    });

    const result = await runLoop({
      runId,
      config,
      runtimeExecutor: fakeSubagentExecutor(),
      orchestratorTurnExecutor: libraryOnlyOrchestrator(runId, [SR_ENG_LIBRARY, PM_LIBRARY]),
    });

    const keys = targetKeys(result.acceptedRefs);
    assert.ok(keys.includes(SR_ENG_LIBRARY) && keys.includes(PM_LIBRARY));
    assert.ok(keys.includes(GOVERNING_TARGET_KEY));
    assert.ok(
      !keys.some((k) => k.startsWith("rule/")),
      `no rule ref expected when nothing consumed accepted defaults: ${keys.join(", ")}`,
    );
  } finally {
    if (previousDevFlag === undefined) {
      delete process.env[UNPINNED_RUNTIME_DEV_FLAG];
    } else {
      process.env[UNPINNED_RUNTIME_DEV_FLAG] = previousDevFlag;
    }
  }
});

test("ledger coverage: the JUDGE accepted ref is appended to the artifact when qualityJudge ran (the Seam-3 cross-path)", async () => {
  const runId = "ledger_judge_capture";
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const project = {
    id: "project-1",
    name: "Eval Project",
    description: null,
    content: "## Goal\n\nShip it.\n",
    status: "planned",
    labels: [],
    existing_issues: [],
  };
  const { client, cache } = createSnapshotEvalLinearClient({ config, project });
  const teamContext = Object.freeze({
    teamRef: "support-ops",
    linear: Object.freeze({ workspaceId: "ws-1", teamId: "team-1" }),
    trace: Object.freeze({ team_ref: "support-ops", workspace_id: "ws-1", team_id: "team-1", behavior_repo_id: "local:test" }),
  });

  // Run the orchestrator loop (recorder path) — its accepted_refs are FROZEN
  // into the artifact before the judge runs.
  const orchestratorRun = await runLoop({
    runId,
    config,
    project,
    wake: { id: `eval_${runId}`, object_id: project.id },
    event: null,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: libraryOnlyOrchestrator(runId, [PM_LIBRARY]),
  });

  // The harness's frozen refs do NOT include the judge (it is captured cross-path).
  assert.ok(
    !targetKeys(orchestratorRun.acceptedRefs).includes(DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY),
    "the recorder must not capture the judge (it runs post-assembly)",
  );

  const runStoreDir = ledgerCoverageRunStoreDir(runId);
  fs.rmSync(runStoreDir, { recursive: true, force: true });

  // runDecomposition with qualityJudge enabled: even a fake judge fn that
  // returns null still means the judge RAN (its accepted prompt was consumed),
  // so the judge ref is appended to the artifact post-assembly. evalMode keeps
  // the run read-only (no Linear mutation).
  const result = await runDecomposition({
    client,
    config,
    cache,
    projectId: project.id,
    runStoreDir,
    runResult: orchestratorRun.output,
    environment: orchestratorRun.environment,
    runtimeEvidence: orchestratorRun.runtimeEvidence,
    runId,
    acceptedRefs: orchestratorRun.acceptedRefs,
    evalMode: true,
    teamContext,
    qualityJudge: async () => null,
  });
  // eval-mode is read-only: the run reaches a terminal artifact without a live
  // Linear mutation (status "evaluated"), but the artifact is still persisted.
  assert.equal(result.status, "evaluated");

  const persisted = readRunArtifact({ runId, runStoreDir });
  const keys = targetKeys(persisted.accepted_refs || []);
  // The JUDGE ref is now on the persisted artifact's accepted_refs.
  assert.ok(
    keys.includes(DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY),
    `expected judge captured on the artifact: ${keys.join(", ")}`,
  );
  // The harness-frozen refs (governing + the invoked library) are still present.
  assert.ok(keys.includes(GOVERNING_TARGET_KEY));
  assert.ok(keys.includes(PM_LIBRARY));
  // The judge ref's accepted_baseline_id is the manifest's accepted_prompt_version_id
  // (not a sha fallback), matching how every other captured ref is shaped.
  const judgeRef = persisted.accepted_refs.find((r) => r.target_key === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY);
  assert.equal(typeof judgeRef.accepted_baseline_id, "string");
  assert.equal(typeof judgeRef.snapshot_sha256, "string");
  // Idempotent: the judge target appears exactly once (deduped by target_key).
  assert.equal(keys.filter((k) => k === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY).length, 1);

  fs.rmSync(runStoreDir, { recursive: true, force: true });
});

test("ledger coverage: when the judge RAN but its contract ref cannot be resolved, the judge is recorded as an UNJOINABLE coverage marker (consumed, version unknown) — NEVER omitted", async () => {
  const runId = "ledger_judge_unresolvable";
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const project = {
    id: "project-1",
    name: "Eval Project",
    description: null,
    content: "## Goal\n\nShip it.\n",
    status: "planned",
    labels: [],
    existing_issues: [],
  };
  const { client, cache } = createSnapshotEvalLinearClient({ config, project });
  const teamContext = Object.freeze({
    teamRef: "support-ops",
    linear: Object.freeze({ workspaceId: "ws-1", teamId: "team-1" }),
    trace: Object.freeze({ team_ref: "support-ops", workspace_id: "ws-1", team_id: "team-1", behavior_repo_id: "local:test" }),
  });

  const orchestratorRun = await runLoop({
    runId,
    config,
    project,
    wake: { id: `eval_${runId}`, object_id: project.id },
    event: null,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: libraryOnlyOrchestrator(runId, [PM_LIBRARY]),
  });

  const runStoreDir = ledgerCoverageRunStoreDir(runId);
  fs.rmSync(runStoreDir, { recursive: true, force: true });

  // The judge RAN (qualityJudge enabled), so its accepted prompt WAS consumed —
  // but its version cannot be resolved (the injected contract loader throws, as
  // an unrecoverable manifest/snapshot read would). The ledger must degrade to
  // "consumed, version unknown" (the unjoinable marker), NOT a false "judge not
  // used" that would license a false safe-to-undo.
  const result = await runDecomposition({
    client,
    config,
    cache,
    projectId: project.id,
    runStoreDir,
    runResult: orchestratorRun.output,
    environment: orchestratorRun.environment,
    runtimeEvidence: orchestratorRun.runtimeEvidence,
    runId,
    acceptedRefs: orchestratorRun.acceptedRefs,
    evalMode: true,
    teamContext,
    qualityJudge: async () => null,
    loadJudgeContractFn: () => {
      throw new Error("simulated judge contract resolution failure");
    },
  });
  assert.equal(result.status, "evaluated");

  const persisted = readRunArtifact({ runId, runStoreDir });
  const refs = persisted.accepted_refs || [];
  const keys = targetKeys(refs);
  // The judge entry is PRESENT despite the unresolvable version (not omitted).
  assert.ok(
    keys.includes(DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY),
    `the judge ran, so its consumption must be recorded even when unresolvable: ${keys.join(", ")}`,
  );
  // It is the UNJOINABLE marker: target_key present, both identifiers null, so a
  // downstream read degrades to `unknown` (never a confident not_used).
  const judgeRef = refs.find((r) => r.target_key === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY);
  assert.equal(judgeRef.accepted_baseline_id, null);
  assert.equal(judgeRef.snapshot_sha256, null);
  // Still exactly once (deduped by target_key).
  assert.equal(keys.filter((k) => k === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY).length, 1);

  fs.rmSync(runStoreDir, { recursive: true, force: true });
});

test("ledger coverage: the captured judge ref provably matches what the judge ITSELF consumed — same contract loader, exactly one judge ref", async () => {
  // The prior judge-capture test uses a fake judge fn (qualityJudge: () => null),
  // so the judge ref appears only because appendJudgeAcceptedRef loads it. This
  // test ties the captured version to the JUDGE'S OWN consumption:
  //   (1) provenance — appendJudgeAcceptedRef defaults to the SAME loader the
  //       judge's loadJudgePromptContract uses (loadPromptRegistrationContract),
  //       so the captured snapshot_sha256 IS the version the judge would consume;
  //   (2) the captured ref equals that loader's snapshot for the judge target.
  //
  // We do NOT run the real default judge end-to-end: runDecompositionQualityJudge
  // requires a configured model and SPAWNS a runtime CLI at step 7. Asserting
  // same-loader provenance (CLI-free) is the faithful substitute; the limitation
  // is that the model invocation itself is not exercised here (it is covered by
  // decomposition-quality-judge.test.mjs).
  const runId = "ledger_judge_real_consumption";
  const config = loadLinearConfig({ repoRoot: REPO_ROOT });
  const project = {
    id: "project-1",
    name: "Eval Project",
    description: null,
    content: "## Goal\n\nShip it.\n",
    status: "planned",
    labels: [],
    existing_issues: [],
  };
  const { client, cache } = createSnapshotEvalLinearClient({ config, project });
  const teamContext = Object.freeze({
    teamRef: "support-ops",
    linear: Object.freeze({ workspaceId: "ws-1", teamId: "team-1" }),
    trace: Object.freeze({ team_ref: "support-ops", workspace_id: "ws-1", team_id: "team-1", behavior_repo_id: "local:test" }),
  });

  // The judge's OWN contract load (the version it consumes at judge time). This
  // is the real loadJudgePromptContract path — it loads the accepted snapshot
  // through loadPromptRegistrationContract, the exact loader appendJudgeAcceptedRef
  // defaults to.
  const judgeContract = loadJudgePromptContract();
  const registrationContract = loadPromptRegistrationContract({
    targetKey: DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY,
  });
  // Same loader, same accepted snapshot identity.
  assert.equal(judgeContract.snapshotSha256, registrationContract.snapshotSha256);

  const orchestratorRun = await runLoop({
    runId,
    config,
    project,
    wake: { id: `eval_${runId}`, object_id: project.id },
    event: null,
    runtimeExecutor: fakeSubagentExecutor(),
    orchestratorTurnExecutor: libraryOnlyOrchestrator(runId, [PM_LIBRARY]),
  });

  const runStoreDir = ledgerCoverageRunStoreDir(runId);
  fs.rmSync(runStoreDir, { recursive: true, force: true });

  // qualityJudge enabled; NO injected loader, so the append path uses the real
  // default loadPromptRegistrationContract — the same load the judge performs.
  const result = await runDecomposition({
    client,
    config,
    cache,
    projectId: project.id,
    runStoreDir,
    runResult: orchestratorRun.output,
    environment: orchestratorRun.environment,
    runtimeEvidence: orchestratorRun.runtimeEvidence,
    runId,
    acceptedRefs: orchestratorRun.acceptedRefs,
    evalMode: true,
    teamContext,
    qualityJudge: async () => null,
  });
  assert.equal(result.status, "evaluated");

  const persisted = readRunArtifact({ runId, runStoreDir });
  const refs = persisted.accepted_refs || [];
  const judgeRefs = refs.filter((r) => r.target_key === DECOMPOSITION_QUALITY_JUDGE_TARGET_KEY);
  // EXACTLY ONE judge ref.
  assert.equal(judgeRefs.length, 1, `expected exactly one judge ref: ${JSON.stringify(judgeRefs)}`);
  // The captured snapshot_sha256 IS the judge's own consumed snapshot — so the
  // ledger records the precise version the judge consumed, not a re-derivation.
  assert.equal(judgeRefs[0].snapshot_sha256, judgeContract.snapshotSha256);

  fs.rmSync(runStoreDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PART 2 — static completeness guard (SITE-LEVEL + BROADENED).
//
// Enumerate every ACCEPTED-BEHAVIOR consumption load CALL SITE in
// execution/integrations/linear/src and assert each is EITHER routed through a
// decomposition run (recorder / config-load capture / judge append) OR on a
// NAMED non-run allowlist. A new un-routed accepted-artifact load ANYWHERE in
// the src tree FAILS this test — that is what keeps the #50 ledger complete as
// load paths are added.
//
// Two properties versus the prior file-level prompt-only guard:
//   - SITE-LEVEL (count-based, like the RET-CHECK gate): each occurrence is
//     keyed by `${relpath} ::: ${trimmedLine}` with TRUE MULTIPLICITY. A 2nd
//     un-listed accepted load added inside an ALREADY-listed file is a NEW key
//     (different line) — or a duplicate line bumps the count past its sanction —
//     so it trips the gate. File-level allowlisting (first-load-per-file) could
//     not see it.
//   - BROADENED to ALL accepted-behavior consumption loaders a RUN can reach,
//     not just the accepted-prompt body loader:
//       * loadAcceptedPromptSnapshot  — accepted PROMPT body
//       * resolveAcceptedBaseline      — shared accepted RULE/PROMPT resolver
//       * readArtifactBytes            — the byte-read callback inside the above
//       * resolveAcceptedRefForTarget  — the run-version ref for a target
//     (config.mjs's accepted-runtime-roles VALUE read rides on its
//     resolveAcceptedRefForTarget version capture — see ROUTED_SITES below.)
//
// "Load site" = a line that INVOKES one of the loader tokens, or passes the
// readArtifactBytes callback. Definitions, imports, re-exports, and bare
// destructure specifiers are not call sites and are skipped.
// ---------------------------------------------------------------------------

const SRC_ROOTS = [
  path.join(REPO_ROOT, "execution", "engine"),
  path.join(REPO_ROOT, "execution", "integrations", "linear", "src"),
];
const SCANNED_EXTENSIONS = new Set([".mjs", ".cjs", ".js"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

const KEY_SEP = " ::: ";

// The accepted-behavior consumption loader tokens. Each entry: the symbol and a
// regex matching a CALL/USE site (not a definition/import). readArtifactBytes is
// matched as the property-callback form it always takes at a resolve site.
const ACCEPTED_LOADER_TOKENS = [
  { name: "loadAcceptedPromptSnapshot", regex: /\bloadAcceptedPromptSnapshot\s*\(/ },
  { name: "resolveAcceptedBaseline", regex: /\bresolveAcceptedBaseline\s*\(/ },
  { name: "resolveAcceptedRefForTarget", regex: /\bresolveAcceptedRefForTarget\s*\(/ },
  // The byte-read callback handed to resolveAcceptedBaseline (the actual
  // accepted-artifact bytes read). Matches the `readArtifactBytes: (...) =>`
  // property form at a resolve site; the bare destructured param and the inner
  // `readArtifactBytes(path)` invocations inside the resolver definition are
  // filtered as non-call lines below.
  { name: "readArtifactBytes", regex: /\breadArtifactBytes\s*:/ },
];

// A line that DEFINES / re-exports / imports a loader, or is the loader's own
// internal machinery — NOT a consuming call site. These are not classified.
function isDefinitionOrImport(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("import ")) return true;
  if (trimmed.startsWith("export {")) return true;
  if (trimmed.startsWith("export function ")) return true;
  if (trimmed.startsWith("export const ")) return true;
  if (trimmed.startsWith("export default")) return true;
  // A bare symbol on its own line inside a multi-line import/destructure list
  // (e.g. "  resolveAcceptedBaseline," or "  readArtifactBytes,").
  if (/^[A-Za-z_$][\w$]*\s*,?$/.test(trimmed)) return true;
  return false;
}

// EXPLICIT accounted sites, keyed `${relpath}${KEY_SEP}${trimmedLine}`, each with
// its true multiplicity (a key occurring N times appears N times). Re-seed by
// running with LEDGER_SITE_DUMP=1 (the dump block at the bottom).
//
// ROUTED_SITES — accepted-behavior loads that ARE part of a decomposition run and
// feed the #50 ledger (the run recorder, the config-load runtime-defaults
// capture, or the judge cross-path append). One justification line each.
const ROUTED_SITES = [
  // orchestrator-roster.mjs: roster.resolve().loadSnapshot() — the single library
  // body load the invoke_library handler threads to recordLibraryLoad. (SELFIMP
  // made this definition-driven: the workflow's own definition replaces the
  // hardcoded decompositionDefinition; still the run-routed library load.)
  "execution/integrations/linear/src/orchestrator-roster.mjs ::: : () => loadAcceptedPromptSnapshot({ repoRoot, definition, targetKey: key });",
  // orchestrator-loop.mjs: the run-start governing-prompt load → recordGoverningLoad
  // (moved here from trigger-runner.mjs by the W1a-1 engine-loop split).
  "execution/engine/orchestrator-loop.mjs ::: const governingSnapshot = loadAcceptedPromptSnapshot({",
  // run-accepted-refs.mjs: resolveAcceptedRefForTarget → resolveAcceptedBaseline is
  // THE run-path resolver; its result is the captured runtime-defaults ref.
  "execution/engine/run-accepted-refs.mjs ::: const resolution = resolveAcceptedBaseline({",
  // run-accepted-refs.mjs: the bytes read inside that run-path resolver.
  "execution/engine/run-accepted-refs.mjs ::: readArtifactBytes: (relativePath) => {",
  // config.mjs: capture-at-config-load of the runtime-defaults accepted ref. This
  // ALSO covers the accepted-runtime-roles.json VALUE read (resolveAcceptedRuntimeRoleDefaults):
  // the version this run consumed is recorded here and stashed for collectRunAcceptedRefs.
  "execution/integrations/linear/src/config.mjs ::: ? resolveAcceptedRefForTarget({",
];

// NON_RUN_SITES — accepted-behavior loads that are NOT a decomposition run,
// enumerated explicitly with one justification line each.
const NON_RUN_SITES = [
  // improvement-drafter.mjs: the self-improvement drafter loads the accepted
  // prompt it is rewriting — the drafting path, not a run.
  "execution/integrations/linear/src/improvement-drafter.mjs ::: snapshot = loadAcceptedPromptSnapshot({",
  // decomposition-quality-judge.mjs: the judge's OWN contract loader loads the
  // judge snapshot; the judge's RUN consumption is captured via the run-service
  // cross-path append (appendJudgeAcceptedRef), not this raw load.
  "execution/integrations/linear/src/decomposition-quality-judge.mjs ::: const snapshot = loadAcceptedPromptSnapshot({",
  // phoenix-experiment.mjs: experiment LAUNCH baseline derivation (the eval/
  // experiment surface), not a decomposition run.
  "execution/integrations/linear/src/phoenix-experiment.mjs ::: const resolution = resolveAcceptedBaseline({",
  "execution/integrations/linear/src/phoenix-experiment.mjs ::: readArtifactBytes: (relativePath) => {",
  // process-change-gate.mjs: the process-change (HITL acceptance) gate derives
  // the accepted baseline to gate a proposal — not a run.
  "execution/integrations/linear/src/process-change-gate.mjs ::: const resolution = resolveAcceptedBaseline({",
  "execution/integrations/linear/src/process-change-gate.mjs ::: readArtifactBytes: (relativePath) => {",
  // promotion-scanner/baseline-resolver.mjs: promotion-scanner baseline derivation
  // (trusted-clone + active-checkout). Two resolve sites; each with its bytes read.
  "execution/integrations/linear/src/promotion-scanner/baseline-resolver.mjs ::: const resolution = resolveAcceptedBaseline({",
  "execution/integrations/linear/src/promotion-scanner/baseline-resolver.mjs ::: const resolution = resolveAcceptedBaseline({",
  "execution/integrations/linear/src/promotion-scanner/baseline-resolver.mjs ::: readArtifactBytes: (relativePath) => relativePath === referencedPath",
  "execution/integrations/linear/src/promotion-scanner/baseline-resolver.mjs ::: readArtifactBytes: (relativePath) => {",
  // promotion/proposal-worklist-read-model.mjs: B-READ read-model — the READER
  // that asks "is this proposal superseded?", not a consuming run.
  "execution/integrations/linear/src/promotion/proposal-worklist-read-model.mjs ::: const currentRef = resolveAcceptedRefForTarget({",
];

function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function listScannableSrcFiles() {
  const files = [];
  for (const srcRoot of SRC_ROOTS) {
    walk(srcRoot, files);
  }
  return files.sort();
}

function walk(absDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(absDir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(path.join(absDir, entry.name));
  }
}

// Scan the src tree for accepted-behavior loader CALL SITES. Returns a Map<key,
// count> keyed by `${relpath}${KEY_SEP}${trimmedLine}` with the occurrence count
// (a textually-identical site appearing twice has count 2). Definitions /
// imports / re-exports are skipped. The accepted-baseline.mjs resolver
// DEFINITION (which both defines resolveAcceptedBaseline and invokes
// readArtifactBytes(path) internally) is skipped wholesale — it is the loader
// itself, not a consuming site.
function scanAcceptedLoaderSites() {
  const sites = new Map();
  const selfRel = toRepoRelative(fileURLToPath(import.meta.url));
  const resolverDefRel = "execution/integrations/linear/src/promotion-scanner/accepted-baseline.mjs";
  for (const absFile of listScannableSrcFiles()) {
    const rel = toRepoRelative(absFile);
    if (rel === selfRel) continue;
    if (rel === resolverDefRel) continue; // the resolver's own definition module.
    const lines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (isDefinitionOrImport(line)) continue;
      for (const token of ACCEPTED_LOADER_TOKENS) {
        if (token.regex.test(line)) {
          const key = `${rel}${KEY_SEP}${line.trim()}`;
          sites.set(key, (sites.get(key) || 0) + 1);
          break; // one classification per line is enough for the key.
        }
      }
    }
  }
  return sites;
}

// Turn an allowlist array (with multiplicity) into a Map<key, count>.
function countByKey(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}

test("ledger completeness static guard (site-level + broadened): every accepted-behavior load site is run-routed or named-allowlisted", () => {
  if (process.env.LEDGER_SITE_DUMP === "1") {
    const sites = scanAcceptedLoaderSites();
    const dump = [...sites.entries()]
      .flatMap(([key, count]) => Array.from({ length: count }, () => `  ${JSON.stringify(key)},`))
      .sort();
    console.log(`\nLEDGER SITE DUMP (${dump.length} occurrence(s)):\n${dump.join("\n")}\n`);
  }

  const sites = scanAcceptedLoaderSites();

  // Sanity: the scan is not silently empty (it must see the known loaders).
  assert.ok(sites.size >= 5, `expected to find accepted-behavior load sites, found: ${[...sites.keys()].join(", ")}`);

  const accounted = new Map();
  for (const [key, count] of [...countByKey(ROUTED_SITES), ...countByKey(NON_RUN_SITES)]) {
    accounted.set(key, (accounted.get(key) || 0) + count);
  }

  // 1. Every CURRENT occurrence must be accounted for, with enough sanctioned
  //    multiplicity. A NEW un-listed site (fresh file OR a 2nd line in an
  //    already-listed file) appears as an unaccounted key or an over-count.
  const overCount = [];
  for (const [key, count] of sites) {
    const sanctioned = accounted.get(key) || 0;
    if (count > sanctioned) overCount.push({ key, count, sanctioned });
  }
  if (overCount.length > 0) {
    const detail = overCount
      .map(({ key, count, sanctioned }) => `  (${sanctioned} sanctioned, ${count} found) ${key}`)
      .join("\n");
    assert.fail(
      [
        "Unaccounted accepted-behavior load occurrence(s) — the #50 ledger may be incomplete.",
        "Each accepted-artifact load in execution/integrations/linear/src must be EITHER routed",
        "through a decomposition run (add to ROUTED_SITES with a justification), OR a NAMED non-run",
        "path (add to NON_RUN_SITES with a justification). Re-seed with LEDGER_SITE_DUMP=1:",
        detail,
      ].join("\n"),
    );
  }

  // 2. No STALE allowlist entries: every sanctioned key must be a current site,
  //    and at the right multiplicity (so deletions shrink the lists honestly).
  const stale = [];
  for (const [key, sanctioned] of accounted) {
    const found = sites.get(key) || 0;
    if (sanctioned > found) stale.push({ key, sanctioned, found });
  }
  if (stale.length > 0) {
    const detail = stale
      .map(({ key, sanctioned, found }) => `  (${sanctioned} listed, ${found} found) ${key}`)
      .join("\n");
    assert.fail(`Stale allowlist entr(ies) — prune ROUTED_SITES / NON_RUN_SITES:\n${detail}`);
  }
});
