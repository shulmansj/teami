import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectNextResumeReconciliation,
  cleanupLocalSupervisorLocalState,
  formatNextResumeReconciliationReport,
  formatLocalSupervisorRunReport,
  localSupervisorDisablePath,
  localSupervisorRegistrationPath,
  LOCAL_SUPERVISOR_STATE_SCHEMA_VERSION,
  localSupervisorStatePath,
  LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON,
  localSupervisorDoctorChecks,
  NEXT_RESUME_RECONCILIATION_SCHEMA_VERSION,
  PROVISIONAL_PM_STATES,
  readLocalSupervisorStatus,
  registerLocalSupervisorStub,
  runLocalSupervisorLoop,
  setLocalSupervisorDisabled,
} from "../src/local-supervisor.mjs";

const repoCheckout = path.resolve(import.meta.dirname, "../../../..");

function tempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-local-supervisor-"));
  fs.mkdirSync(path.join(repoRoot, ".agentic-factory"), { recursive: true });
  return repoRoot;
}

function testConfig(overrides = {}) {
  return {
    linear: {},
    runtime: {},
    workflows: { decomposition: { roles: {} } },
    local_supervisor: {
      crash_backoff_base_ms: 60_000,
      crash_backoff_max_ms: 60_000,
      ...overrides.local_supervisor,
    },
  };
}

function writeWorkspaceCache(repoRoot) {
  const cachePath = path.join(repoRoot, ".agentic-factory", "linear.json");
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({
      workspaceId: "workspace-1",
      teamId: "team-1",
    }, null, 2)}\n`,
    "utf8",
  );
  return cachePath;
}

test("localSupervisorDoctorChecks names are clean: no double prefix, single consent", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  const checks = await localSupervisorDoctorChecks({ repoRoot, config: testConfig(), cachePath });
  const names = checks.map((check) => check.name);
  assert.equal(
    names.filter((name) => name.includes("local supervisor local supervisor")).length,
    0,
    `double-prefixed supervisor check name(s): ${names.join(", ")}`,
  );
  assert.equal(
    names.filter((name) => name === "local supervisor consent").length,
    1,
    `expected exactly one consent check: ${names.join(", ")}`,
  );
  assert.ok(
    names.includes("local supervisor workspace cache"),
    `expected consistently prefixed workspace-cache check: ${names.join(", ")}`,
  );
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRunArtifact(repoRoot, runId, artifact) {
  writeJson(path.join(repoRoot, ".agentic-factory", "runs", `${runId}.json`), {
    schema_version: "linear-decomposition-run-artifact/v1",
    workflow_version: "0.2.0",
    run_id: runId,
    runtime_assignments: {},
    runtime_metadata: {},
    ...artifact,
  });
}

test("local supervisor registration requires explicit consent and writes only a dry-run stub", () => {
  const repoRoot = tempRepo();

  const blocked = registerLocalSupervisorStub({ repoRoot, explicitConsent: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "explicit_supervisor_consent_required");
  assert.equal(fs.existsSync(localSupervisorRegistrationPath(repoRoot)), false);

  const registered = registerLocalSupervisorStub({
    repoRoot,
    explicitConsent: true,
    trigger: "test",
    platform: "win32",
    now: () => new Date("2026-06-10T10:00:00.000Z"),
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.dry_run, true);
  assert.equal(registered.registration.status, "dry_run_registered");
  assert.equal(registered.registration.os_registration.will_write_os, false);
  assert.equal(registered.registration.os_registration.status, "stubbed_no_os_write");
  assert.equal(registered.registration.os_registration.mechanism, "windows_task_scheduler_logon_task");
  assert.equal(registered.registration.local_credential_custody.owns_new_credentials, false);
  assert.match(registered.registration.os_registration.todo, /not implemented/);
  assert.ok(registered.registration.authorized_capabilities.includes("scanner_work"));
  for (const forbidden of [
    "auto_merge",
    "apply_behavior_change",
    "mark_ready_for_review",
    "submit_pr_review",
    "status_override",
    "branch_protection_bypass",
    "privileged_workflow_triggers",
    "write_token_ci",
    "proposal_branch_secrets",
    "artifact_log_exfiltration",
    "maintainer_originated_adopter_pr",
  ]) {
    assert.ok(registered.registration.forbidden_capabilities.includes(forbidden), forbidden);
    assert.equal(registered.registration.authorized_capabilities.includes(forbidden), false, forbidden);
  }
});

test("foreground runner and supervisor source do not expose direct GitHub proposal authority", () => {
  const sourceFiles = [
    "execution/integrations/linear/src/foreground-runner.mjs",
    "execution/integrations/linear/src/trigger-runner.mjs",
    "execution/integrations/linear/src/local-supervisor.mjs",
    "execution/integrations/linear/src/supervisor/jobs.mjs",
    "execution/integrations/linear/src/supervisor/loop.mjs",
  ];
  const source = sourceFiles
    .map((relative) => fs.readFileSync(path.join(repoCheckout, ...relative.split("/")), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /createGitHubPromotionClient/);
  assert.doesNotMatch(source, /pushPromotionBranchWithInstallationToken/);
  assert.doesNotMatch(source, /createPullRequest/);
  assert.doesNotMatch(source, /mergePullRequest|markReadyForReview|submitReview|createReview/);
});

test("local supervisor run leaves gateway autostart deferred and runs the scanner once", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  registerLocalSupervisorStub({ repoRoot, explicitConsent: true });
  let runnerCalls = 0;
  let scannerCalls = 0;

  const result = await runLocalSupervisorLoop({
    repoRoot,
    config: testConfig(),
    cachePath,
    runRunnerOnce: async () => {
      runnerCalls += 1;
      return { status: "idle" };
    },
    scanPromotionCandidatesFn: async ({ repoRoot: scanRepoRoot }) => {
      scannerCalls += 1;
      assert.equal(scanRepoRoot, repoRoot);
      return {
        ok: true,
        status: "ok",
        scan_id: "scan-1",
        candidates: [],
        ledger_path: path.join(repoRoot, ".agentic-factory", "promotion-candidates", "scanner-ledger.json"),
        health_path: path.join(repoRoot, ".agentic-factory", "promotion-candidates", "scanner-health.json"),
      };
    },
    now: () => new Date("2026-06-10T10:01:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.iterations.length, 1);
  assert.equal(runnerCalls, 0);
  assert.equal(scannerCalls, 1);
  assert.equal(result.iterations[0].runner.status, "skipped");
  assert.equal(result.iterations[0].runner.reason, LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON);
  assert.match(result.iterations[0].runner.detail, /Gateway autostart is deferred/);
  assert.equal(result.iterations[0].scanner.status, "ok");

  const state = JSON.parse(fs.readFileSync(localSupervisorStatePath(repoRoot), "utf8"));
  assert.equal(state.status, "ok");
  assert.equal(state.last_iteration.runner.reason, LOCAL_SUPERVISOR_HARDFLOOR_RUNNER_STUB_REASON);
  assert.match(formatLocalSupervisorRunReport(result).join("\n"), /gateway_autostart_deferred/);
});

test("local supervisor propagates scanner report-only state without adding a writer", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  registerLocalSupervisorStub({ repoRoot, explicitConsent: true });
  let scannerCalls = 0;

  const result = await runLocalSupervisorLoop({
    repoRoot,
    config: testConfig(),
    cachePath,
    scanPromotionCandidatesFn: async () => {
      scannerCalls += 1;
      return {
        ok: true,
        status: "ok",
        scan_id: "scan-report-only",
        candidates: [{
          status: "promotion_write_report_only",
          reason: "promotion_write_guard_pre_activation_unattended_report_only",
        }],
        ledger_path: path.join(repoRoot, ".agentic-factory", "promotion-candidates", "scanner-ledger.json"),
        health_path: path.join(repoRoot, ".agentic-factory", "promotion-candidates", "scanner-health.json"),
      };
    },
    now: () => new Date("2026-06-10T10:01:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(scannerCalls, 1);
  assert.equal(result.iterations[0].scanner.status, "ok");
  assert.equal(result.iterations[0].scanner.candidate_count, 1);
  assert.equal(result.iterations[0].scanner.scan_id, "scan-report-only");
});

test("local supervisor disable flag prevents runner and scanner work", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  registerLocalSupervisorStub({ repoRoot, explicitConsent: true });
  const disabled = setLocalSupervisorDisabled({
    repoRoot,
    reason: "operator_pause",
    now: () => new Date("2026-06-10T10:02:00.000Z"),
  });
  assert.equal(disabled.disabled, true);
  assert.equal(fs.existsSync(localSupervisorDisablePath(repoRoot)), true);

  let scannerCalls = 0;
  const result = await runLocalSupervisorLoop({
    repoRoot,
    config: testConfig(),
    cachePath,
    runRunnerOnce: async () => {
      throw new Error("runner should not be called while disabled");
    },
    scanPromotionCandidatesFn: async () => {
      scannerCalls += 1;
      throw new Error("scanner should not be called while disabled");
    },
    now: () => new Date("2026-06-10T10:03:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "disabled");
  assert.equal(result.iterations[0].reason, "operator_pause");
  assert.equal(scannerCalls, 0);
});

test("local supervisor crash-loop backoff blocks the next start until the recorded time", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  registerLocalSupervisorStub({ repoRoot, explicitConsent: true });
  let current = new Date("2026-06-10T10:04:00.000Z");
  let scannerCalls = 0;

  const first = await runLocalSupervisorLoop({
    repoRoot,
    config: testConfig(),
    cachePath,
    scanPromotionCandidatesFn: async () => {
      scannerCalls += 1;
      throw new Error("scanner exploded");
    },
    now: () => current,
  });

  assert.equal(first.ok, false);
  assert.equal(first.status, "failed");
  assert.equal(scannerCalls, 1);
  const stateAfterCrash = JSON.parse(fs.readFileSync(localSupervisorStatePath(repoRoot), "utf8"));
  assert.equal(stateAfterCrash.status, "backoff");
  assert.equal(stateAfterCrash.crash_loop.consecutive_failure_count, 1);
  assert.equal(stateAfterCrash.crash_loop.next_allowed_start_at, "2026-06-10T10:05:00.000Z");

  current = new Date("2026-06-10T10:04:30.000Z");
  const second = await runLocalSupervisorLoop({
    repoRoot,
    config: testConfig(),
    cachePath,
    scanPromotionCandidatesFn: async () => {
      scannerCalls += 1;
      return { ok: true, status: "ok", candidates: [] };
    },
    now: () => current,
  });

  assert.equal(second.ok, false);
  assert.equal(second.status, "backoff");
  assert.equal(second.iterations[0].reason, "crash_loop_backoff_active");
  assert.equal(scannerCalls, 1);
});

test("local supervisor status and cleanup report local-only state", async () => {
  const repoRoot = tempRepo();
  const cachePath = writeWorkspaceCache(repoRoot);
  registerLocalSupervisorStub({ repoRoot, explicitConsent: true });
  setLocalSupervisorDisabled({ repoRoot, reason: "maintenance" });

  const status = await readLocalSupervisorStatus({
    repoRoot,
    config: testConfig(),
    cachePath,
  });
  assert.equal(status.registration.ok, true);
  assert.equal(status.disable.disabled, true);
  assert.equal(status.preflight.ok, true);

  const cleanup = cleanupLocalSupervisorLocalState({ repoRoot });
  assert.equal(cleanup.ok, true);
  assert.ok(cleanup.removed.some((entry) => entry.label === "local supervisor registration stub"));
  assert.ok(cleanup.removed.some((entry) => entry.label === "local supervisor disable flag"));
  assert.match(cleanup.todo, /not implemented/);
  assert.equal(fs.existsSync(localSupervisorRegistrationPath(repoRoot)), false);
  assert.equal(fs.existsSync(localSupervisorStatePath(repoRoot)), false);
  assert.equal(fs.existsSync(localSupervisorDisablePath(repoRoot)), false);
});

test("next-resume reconciliation classifies aged, commit-unconfirmed, resumed, and attention work", async () => {
  const repoRoot = tempRepo();
  const scannerDir = path.join(repoRoot, ".agentic-factory", "promotion-candidates");
  writeJson(localSupervisorStatePath(repoRoot), {
    schema_version: LOCAL_SUPERVISOR_STATE_SCHEMA_VERSION,
    status: "ok",
    created_at: "2026-06-10T08:00:00.000Z",
    updated_at: "2026-06-10T09:00:00.000Z",
    crash_loop: { consecutive_failure_count: 0, next_allowed_start_at: null, last_error: null },
    last_iteration: {
      ok: true,
      status: "ok",
      started_at: "2026-06-10T08:59:00.000Z",
      finished_at: "2026-06-10T09:00:00.000Z",
    },
  });
  writeJson(path.join(scannerDir, "scanner-health.json"), {
    schema_version: "agentic-factory-promotion-scanner-health/v1",
    scan_id: "scan-1",
    status: "ok",
    started_at: "2026-06-10T11:50:00.000Z",
    finished_at: "2026-06-10T11:50:01.000Z",
    summary: { candidate_count: 1 },
  });
  writeJson(path.join(scannerDir, "scanner-ledger.json"), {
    schema_version: "agentic-factory-promotion-scanner-ledger/v1",
    entries: [{
      candidate_key: "candidate-attention",
      source: "managed_experiment_receipt",
      status: "needs_reconciliation",
      reason: "lost_receipt_phoenix_native_ambiguity",
      candidate_target_key: "prompt/decomposition/decomposition_quality_judge",
    }],
  });
  writeRunArtifact(repoRoot, "run-paused", {
    kind: "pause",
    pause_packet: { open_questions_markdown: "Which tradeoff should win?" },
  });
  writeRunArtifact(repoRoot, "run-resumed", {
    kind: "resume",
    packet: { open_questions_markdown: "" },
  });
  writeRunArtifact(repoRoot, "run-commit", {
    kind: "commit",
    linear_project_id: "project-commit",
  });
  writeJson(path.join(repoRoot, ".agentic-factory", "runs", "unconfirmed-linear-mutation-intents", "run-commit.json"), {
    schema_version: "agentic-factory-unconfirmed-linear-mutation-intent/v1",
    run_id: "run-commit",
    artifact_kind: "commit",
    linear_project_id: "project-commit",
    domain_id: "support-ops",
    wake_id: "wake-commit",
    started_at: "2026-06-10T11:45:00.000Z",
  });

  const report = await collectNextResumeReconciliation({
    repoRoot,
    now: () => new Date("2026-06-10T12:00:00.000Z"),
    agedAfterMs: 60 * 60 * 1000,
  });

  assert.equal(report.schema_version, NEXT_RESUME_RECONCILIATION_SCHEMA_VERSION);
  const classifications = new Set(report.items.map((item) => item.classification));
  for (const expected of ["aged", "resumed", "attention"]) {
    assert.ok(classifications.has(expected), `missing classification ${expected}`);
  }
  assert.ok(report.items.some((item) => item.reason === "commit_mutation_unconfirmed"));
  for (const item of report.items) {
    assert.ok(PROVISIONAL_PM_STATES.includes(item.pm_state), `unexpected PM state ${item.pm_state}`);
  }
  assert.ok(report.summary.by_pm_state["Needs your decision"] >= 1);
  assert.ok(report.summary.by_pm_state["Blocked but safe"] >= 1);
  assert.ok(report.summary.by_pm_state.Working >= 1);
  const lines = formatNextResumeReconciliationReport(report).join("\n");
  assert.match(lines, /Needs your decision=/);
  assert.match(lines, /Blocked but safe=/);
  assert.match(lines, /Proposal ready=/);
  assert.match(lines, /no gateway work claimed, no Linear writes, no GitHub writes/);
});

test("next-resume reconciliation surfaces local proposal registry records as Proposal ready", async () => {
  const repoRoot = tempRepo();
  writeJson(path.join(repoRoot, ".agentic-factory", "promotion-candidates", "a".repeat(64) + ".json"), {
    schema_version: "agentic-factory-promotion-candidate-registry/v1",
    normalized_envelope_hash: "a".repeat(64),
    proposal_instance_id: "prop-ready",
    candidate_target_key: "prompt/decomposition/decomposition_quality_judge",
    candidate_kind: "prompt",
    candidate_version_id: "PV1",
    accepted_baseline_id: "BASE1",
    pr: { number: 42, url: "dry-run://github/owner/repo/pull/42", dry_run: true },
    outcome: { outcome: "route_to_hitl" },
    repair_state: "none",
    last_stage: "pr_created",
    events: [],
  });

  const report = await collectNextResumeReconciliation({
    repoRoot,
    now: () => new Date("2026-06-10T12:00:00.000Z"),
  });
  const proposal = report.items.find((item) => item.ref === "prop-ready");
  assert.ok(proposal);
  assert.equal(proposal.pm_state, "Proposal ready");
  assert.equal(proposal.classification, "proposal-ready");
  assert.equal(proposal.source, "proposal_registry");
  assert.match(proposal.detail, /\[DRY RUN\]/);
});

test("next-resume reconciliation surfaces scanner v2 ledger statuses", async () => {
  const repoRoot = tempRepo();
  const scannerDir = path.join(repoRoot, ".agentic-factory", "promotion-candidates");
  writeJson(path.join(scannerDir, "scanner-health.json"), {
    schema_version: "agentic-factory-promotion-scanner-health/v2",
    scan_id: "scan-v2",
    status: "ok",
    started_at: "2026-06-10T11:50:00.000Z",
    finished_at: "2026-06-10T11:50:01.000Z",
    summary: { candidate_count: 4 },
  });
  writeJson(path.join(scannerDir, "scanner-ledger.json"), {
    schema_version: "agentic-factory-promotion-scanner-ledger/v2",
    entries: [
      {
        candidate_key: "candidate-ready-v2",
        status: "controller_called_pr_opened",
        proposal_instance_id: "prop-ready-v2",
        candidate_target_key: "prompt/decomposition/decomposition_quality_judge",
        pr: { number: 91, url: "mock://github/o/r/pull/91" },
      },
      {
        candidate_key: "candidate-opportunity",
        status: "improvement_opportunity",
        candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
        reason: "improvement_opportunity_no_proposed_change",
        improvement_opportunity: { human_name: "Sr-eng grounding prompt" },
      },
      {
        candidate_key: "candidate-blocked-repo",
        status: "blocked_by_verified_repo_state",
        candidate_target_key: "prompt/decomposition/blocked",
        reason: "github_pr_listing_truncated",
        detail: "page 2 failed",
      },
      {
        candidate_key: "candidate-ready-v1",
        status: "controller_called",
        proposal_instance_id: "prop-ready-v1",
        candidate_target_key: "prompt/decomposition/legacy",
        pr: { number: 92, url: "mock://github/o/r/pull/92", dry_run: true },
      },
    ],
  });

  const report = await collectNextResumeReconciliation({
    repoRoot,
    now: () => new Date("2026-06-10T12:00:00.000Z"),
  });
  const readyV2 = report.items.find((item) => item.id === "proposal:prop-ready-v2");
  assert.equal(readyV2.pm_state, "Proposal ready");
  assert.equal(readyV2.classification, "proposal-ready");
  const readyV1 = report.items.find((item) => item.id === "proposal:prop-ready-v1");
  assert.equal(readyV1.pm_state, "Proposal ready");
  assert.equal(readyV1.classification, "proposal-ready");
  const opportunity = report.items.find((item) => item.id === "scanner:improvement:candidate-opportunity");
  assert.equal(opportunity.pm_state, "Needs your decision");
  assert.equal(opportunity.classification, "attention");
  assert.equal(opportunity.detail, "Improvement opportunity found: Sr-eng grounding prompt");
  const blocked = report.items.find((item) => item.id === "scanner:verified-repo-state:candidate-blocked-repo");
  assert.equal(blocked.pm_state, "Blocked but safe");
  assert.equal(blocked.classification, "attention");
  assert.equal(blocked.reason, "github_pr_listing_truncated");
  assert.equal(blocked.detail, "page 2 failed");
});

test("next-resume CLI source pin uses local reconciliation without gateway wake claims", () => {
  const cliSource = fs.readFileSync(
    path.join(repoCheckout, "execution", "integrations", "linear", "cli.mjs"),
    "utf8",
  );
  assert.match(cliSource, /supervisor:reconcile/);
  // Post-split, the reconcile wiring and inspectTriggerStatus body live in
  // src/cli/ modules; the pins follow the wiring (end anchor re-homed to the
  // next function in runner-command.mjs).
  const supervisorCommandSource = fs.readFileSync(
    path.join(repoCheckout, "execution", "integrations", "linear", "src", "cli", "supervisor-command.mjs"),
    "utf8",
  );
  assert.match(supervisorCommandSource, /collectNextResumeReconciliation/);
  const runnerCommandSource = fs.readFileSync(
    path.join(repoCheckout, "execution", "integrations", "linear", "src", "cli", "runner-command.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    `${supervisorCommandSource}\n${runnerCommandSource}`,
    /listWakeViews|claimWake|heartbeatRunner|requeueWake/,
  );
});
