import fs from "node:fs";
import path from "node:path";

import {
  getWorkflowDefinition,
  registeredWorkflowTypes,
} from "../../../engine/workflow-registry.mjs";
import { runAutonomousImprovementDrafter } from "./improvement-drafter.mjs";
import { scanPromotionCandidates } from "./promotion-candidate-scanner.mjs";
import {
  resolvePromotionPolicyPath,
  resolveTrustedPolicyRead,
} from "./promotion-policy.mjs";
import { defaultGateReportDir } from "./process-change-gate.mjs";
import {
  AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION,
  appendAutonomousDiagnosisEvent,
  buildAutonomousDiagnosisRecord,
  listPendingAutonomousDiagnosisRecords,
  readAutonomousDiagnosisRecord,
  writeAutonomousDiagnosisRecord,
} from "./promotion/autonomous-diagnosis-store.mjs";
import {
  collectAutonomousLoopSignalSurfaces,
} from "./promotion/autonomous-loop-state.mjs";
import { defaultPromotionRegistryDir } from "./promotion/registry-store.mjs";
import { traceTelemetryPaths } from "./trace-status-store.mjs";

export {
  AUTONOMOUS_DIAGNOSIS_SCHEMA_VERSION,
  buildAutonomousDiagnosisRecord,
  readAutonomousDiagnosisRecord,
  writeAutonomousDiagnosisRecord,
};

const DEFAULT_AUTONOMOUS_DIAGNOSIS_MAX_RECORDS_PER_SCAN = 1;

export const UNTRUSTED_AUTONOMOUS_DIAGNOSIS_OVERRIDE_KEYS = Object.freeze([
  "registryDir",
  "runAutonomousDiagnosisCallerImpl",
  "runAutonomousDiagnosisPassImpl",
  "runAutonomousImprovementDrafterImpl",
  "scanPromotionCandidatesFn",
  "workflowTypes",
  "resolveTrustedPolicyReadImpl",
  "collectAutonomousLoopSignalSurfacesImpl",
  "appendEvent",
  "now",
  "maxRecordsPerScan",
]);

export async function runAutonomousDiagnosisCaller(options = {}) {
  rejectUntrustedAutonomousDiagnosisOverrides(options);
  return runAutonomousDiagnosisCallerWithOverrides(options);
}

export function createAutonomousDiagnosisCallerTestHarness(overrides = {}) {
  return {
    kind: "autonomous_diagnosis_caller_test_harness",
    runAutonomousDiagnosisCaller: (options = {}) =>
      runAutonomousDiagnosisCallerWithOverrides({ ...overrides, ...options }),
    runAutonomousDiagnosisScan: (options = {}) =>
      runAutonomousDiagnosisScanWithOverrides({ ...overrides, ...options }),
    runAutonomousDiagnosisPass: (options = {}) =>
      runAutonomousDiagnosisPassWithOverrides({ ...overrides, ...options }),
  };
}

export async function runAutonomousDiagnosisScan(options = {}) {
  rejectUntrustedAutonomousDiagnosisOverrides(options);
  return runAutonomousDiagnosisScanWithOverrides(options);
}

export async function runAutonomousDiagnosisPass(options = {}) {
  rejectUntrustedAutonomousDiagnosisOverrides(options);
  return runAutonomousDiagnosisPassWithOverrides(options);
}

function rejectUntrustedAutonomousDiagnosisOverrides(options) {
  for (const key of UNTRUSTED_AUTONOMOUS_DIAGNOSIS_OVERRIDE_KEYS) {
    if (key in options) {
      throw new Error(
        `untrusted_autonomous_diagnosis_override_rejected:${key} - production autonomous diagnosis uses only the repo registry, production drafter, scanner, and controller; injection exists only behind createAutonomousDiagnosisCallerTestHarness.`,
      );
    }
  }
}

async function runAutonomousDiagnosisScanWithOverrides({
  repoRoot = process.cwd(),
  registryDir = null,
  runAutonomousDiagnosisCallerImpl = runAutonomousDiagnosisCallerWithOverrides,
  runAutonomousDiagnosisPassImpl = runAutonomousDiagnosisPassWithOverrides,
  onProgress = () => {},
  now = () => new Date(),
  maxRecordsPerScan = DEFAULT_AUTONOMOUS_DIAGNOSIS_MAX_RECORDS_PER_SCAN,
  ...overrides
} = {}) {
  const diagnosisPass = await runAutonomousDiagnosisPassImpl({
    repoRoot,
    registryDir,
    onProgress,
    now,
    ...overrides,
  });
  if (diagnosisPass?.ok === false) return diagnosisPass;
  const listed = listPendingAutonomousDiagnosisRecords({ repoRoot, registryDir: registryDir || undefined });
  if (!listed.ok) return listed;
  const bounds = {
    rounds_used: listed.records.length,
    max_rounds: maxRecordsPerScan,
  };
  if (listed.records.length > maxRecordsPerScan) {
    return {
      ok: true,
      status: "paused",
      outcome: "pause",
      reason: "bounds_breach",
      detail: `${listed.records.length} autonomous diagnosis record(s) are pending; the per-run bound is ${maxRecordsPerScan}.`,
      scanned_count: 0,
      opened_pr_count: 0,
      skipped_count: 0,
      drafted_no_pr_count: 0,
      diagnosis_pass: diagnosisPass,
      bounds,
      results: [],
    };
  }
  const results = [];
  for (const record of listed.records) {
    const result = await runAutonomousDiagnosisCallerImpl({
      repoRoot,
      registryDir,
      opportunityHash: record.opportunity_hash,
      onProgress,
      now,
      ...overrides,
    });
    results.push(result);
  }
  return {
    ok: results.every((result) => result.ok !== false),
    status: results.length === 0 ? "idle" : "completed",
    scanned_count: listed.records.length,
    opened_pr_count: results.filter((result) => result.status === "opened_pr").length,
    skipped_count: results.filter((result) => result.status === "skipped").length,
    drafted_no_pr_count: results.filter((result) =>
      result.status === "drafted_no_pr" || result.status === "manual_propose_ready").length,
    diagnosis_pass: diagnosisPass,
    bounds,
    results,
  };
}

async function runAutonomousDiagnosisPassWithOverrides({
  repoRoot = process.cwd(),
  registryDir = null,
  workflowTypes = null,
  resolveTrustedPolicyReadImpl = resolveTrustedPolicyRead,
  collectAutonomousLoopSignalSurfacesImpl = collectAutonomousLoopSignalSurfaces,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  const resolvedRegistryDir = registryDir || defaultPromotionRegistryDir(repoRoot);
  const types = Array.isArray(workflowTypes) && workflowTypes.length > 0
    ? workflowTypes
    : registeredWorkflowTypes();
  const results = [];
  for (const workflowType of types) {
    const result = diagnoseWorkflow({
      repoRoot,
      registryDir: resolvedRegistryDir,
      workflowType,
      resolveTrustedPolicyReadImpl,
      collectAutonomousLoopSignalSurfacesImpl,
      onProgress,
      now,
    });
    results.push(result);
  }
  return {
    ok: results.every((result) => result.ok !== false),
    status: results.some((result) => result.status === "record_created") ? "completed" : "idle",
    diagnosed_count: results.filter((result) => result.status === "record_created").length,
    skipped_count: results.filter((result) => result.status === "skipped").length,
    results,
  };
}

function diagnoseWorkflow({
  repoRoot,
  registryDir,
  workflowType,
  resolveTrustedPolicyReadImpl,
  collectAutonomousLoopSignalSurfacesImpl,
  onProgress,
  now,
} = {}) {
  let definition;
  try {
    definition = getWorkflowDefinition(workflowType);
  } catch (error) {
    return { ok: true, status: "skipped", reason: "workflow_definition_unavailable", detail: error.message, workflow_type: workflowType };
  }
  const policyPaths = resolvePromotionPolicyPath(definition, repoRoot);
  const policyRead = resolveTrustedPolicyReadImpl({
    mode: "user_invoked",
    policyPath: policyPaths.path,
    policyRelativePath: policyPaths.relativePath,
  });
  if (!policyRead.ok) {
    return {
      ok: true,
      status: "skipped",
      reason: policyRead.reason,
      detail: policyRead.detail ?? null,
      workflow_type: workflowType,
      eval_namespace: definition.eval_namespace,
    };
  }
  const surfaces = collectAutonomousLoopSignalSurfacesImpl({
    repoRoot,
    registryDir,
    gateReportDir: defaultGateReportDir(repoRoot),
  });
  const gateReports = (surfaces.gate_reports || [])
    .filter((report) => reportWorkflowType(report) === workflowType)
    .sort((a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || "")));
  const failingReport = gateReports.find((report) =>
    Array.isArray(report.failed_condition_ids) && report.failed_condition_ids.length > 0);
  const traceReceipts = readRecentTraceReceipts({ repoRoot, workflowType, lookbackDays: policyRead.policy.lookback_days, now });
  if (!failingReport && traceReceipts.length === 0) {
    return {
      ok: true,
      status: "skipped",
      reason: "no_recent_trace_or_grade_evidence",
      workflow_type: workflowType,
      eval_namespace: definition.eval_namespace,
    };
  }
  if (!failingReport) {
    return {
      ok: true,
      status: "skipped",
      reason: "no_recent_grade_failure",
      workflow_type: workflowType,
      eval_namespace: definition.eval_namespace,
      trace_count: traceReceipts.length,
    };
  }
  const targetKey = failingReport.candidate_target_key || definition.driver_governing_target_key;
  const endedAt = now().toISOString();
  const startedAt = new Date(
    now().getTime() - policyRead.policy.lookback_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const record = buildAutonomousDiagnosisRecord({
    workflowType: definition.workflow_type,
    evalNamespace: definition.eval_namespace,
    policy: {
      version: policyRead.policy.policy_version,
      hash: policyRead.policy_hash,
      read_path: policyRead.read_path,
    },
    evidenceQuery: {
      provider: "phoenix",
      project: policyRead.policy.scanner_routing?.eligible_phoenix?.project_names?.[0] || null,
      datasets: policyRead.policy.scanner_routing?.eligible_phoenix?.dataset_names || [],
      splits: policyRead.policy.scanner_routing?.eligible_phoenix?.split_names || [],
      filters: {
        workflow_type: definition.workflow_type,
        eval_namespace: definition.eval_namespace,
        failed_condition_ids: failingReport.failed_condition_ids || [],
        outcome_observations: [],
      },
    },
    evidenceWindow: {
      started_at: startedAt,
      ended_at: endedAt,
      freshness_window_days: policyRead.policy.lookback_days,
    },
    targetSelection: {
      target_key: targetKey,
      selection_source: "eval_namespace_manifest",
      manifest_path: `${definition.eval_namespace}/phoenix-assets.json`,
      selection_rule: "latest_failing_gold_or_grade_signal",
    },
    scannerTrigger: {
      after_chain_state: "tagged",
      command: "promotion:scan",
    },
    improvementOpportunity: {
      status: "improvement_opportunity",
      target: targetKey,
      human_name: targetKey,
      summary: `Recent ${definition.workflow_type} grades produced failing condition(s): ${(failingReport.failed_condition_ids || []).join(", ")}.`,
      failure_mode_ids: failingReport.failed_condition_ids || [],
      next_action: "draft_proposed_change",
      suggested_draft_prompt: "Use the failing grade evidence to tighten the accepted behavior target without broadening scope.",
      evidence_refs: {
        gate_report_ids: [failingReport.gate_report_id].filter(Boolean),
        trace_ids: traceReceipts.map((receipt) => receipt.trace_id).filter(Boolean).slice(0, 10),
        outcome_observation_ids: [],
      },
    },
  });
  const existing = readAutonomousDiagnosisRecord({
    repoRoot,
    registryDir,
    opportunityHash: record.opportunity_hash,
  });
  if (existing.ok) {
    return {
      ok: true,
      status: "skipped",
      reason: "autonomous_diagnosis_record_already_exists",
      workflow_type: workflowType,
      eval_namespace: definition.eval_namespace,
      opportunity_hash: record.opportunity_hash,
      path: existing.path,
    };
  }
  const written = writeAutonomousDiagnosisRecord({ repoRoot, registryDir, record });
  onProgress(`autonomous diagnosis: recorded opportunity ${record.opportunity_hash} for ${workflowType}`);
  return {
    ok: true,
    status: "record_created",
    workflow_type: workflowType,
    eval_namespace: definition.eval_namespace,
    opportunity_hash: record.opportunity_hash,
    path: written.path,
    target_key: targetKey,
  };
}

async function runAutonomousDiagnosisCallerWithOverrides({
  repoRoot = process.cwd(),
  registryDir = null,
  opportunityHash,
  runAutonomousImprovementDrafterImpl = runAutonomousImprovementDrafter,
  scanPromotionCandidatesFn = scanPromotionCandidates,
  appendEvent = appendAutonomousDiagnosisEvent,
  onProgress = () => {},
  now = () => new Date(),
} = {}) {
  const read = readAutonomousDiagnosisRecord({
    repoRoot,
    registryDir: registryDir || undefined,
    opportunityHash,
  });
  if (!read.ok) {
    return {
      ok: false,
      status: "blocked",
      reason: read.reason,
      detail: read.path,
      opportunity_hash: opportunityHash ?? null,
    };
  }
  const hash = read.record.opportunity_hash;
  const append = (event) => appendEvent({
    repoRoot,
    registryDir: registryDir || undefined,
    opportunityHash: hash,
    event,
    now,
  });
  append({ action: "autonomous_chain_started", status: "running" });
  onProgress(`autonomous diagnosis: drafting candidate for opportunity ${hash}`);
  const drafterOptions = {
    repoRoot,
    opportunityHash: hash,
    onProgress,
  };
  if (registryDir) drafterOptions.registryDir = registryDir;
  const drafter = await runAutonomousImprovementDrafterImpl(drafterOptions);
  append({
    action: "autonomous_drafter_finished",
    status: drafter.status || (drafter.ok ? "completed" : "blocked"),
    reason: drafter.reason || null,
    chain_state: drafter.chain_state || null,
  });
  if (drafter.status === "skipped" && drafter.terminal === true) {
    append({
      action: "autonomous_chain_skipped",
      status: "skipped",
      reason: drafter.reason || "autonomous_drafter_skipped",
    });
    return {
      ok: true,
      status: "skipped",
      terminal: true,
      reason: drafter.reason || "autonomous_drafter_skipped",
      opportunity_hash: hash,
      drafter,
    };
  }
  if (!drafter.ok || drafter.chain_state !== "tagged") {
    append({
      action: "autonomous_chain_failed",
      status: "blocked",
      reason: drafter.reason || drafter.chain_state || "autonomous_drafter_not_tagged",
    });
    return {
      ok: false,
      status: "blocked",
      reason: drafter.reason || "autonomous_drafter_not_tagged",
      opportunity_hash: hash,
      drafter,
    };
  }

  onProgress(`autonomous diagnosis: scanning tagged candidate for opportunity ${hash}`);
  const scan = await scanPromotionCandidatesFn({ repoRoot, onProgress });
  const opened = findOpenedProposalCandidate(scan);
  append({
    action: "autonomous_scan_finished",
    status: scan.status || (scan.ok === false ? "blocked" : "completed"),
    reason: scan.reason || null,
    candidate_count: Array.isArray(scan.candidates) ? scan.candidates.length : null,
    opened_pr: opened?.pr ?? null,
  });
  if (opened) {
    append({
      action: "autonomous_chain_completed",
      status: "opened_pr",
      pr: opened.pr,
      proposal_instance_id: opened.proposal_instance_id ?? null,
      normalized_envelope_hash: opened.normalized_envelope_hash ?? null,
    });
    return {
      ok: true,
      status: "opened_pr",
      outcome: "route_to_hitl",
      terminal: true,
      opportunity_hash: hash,
      pr: opened.pr,
      proposal_instance_id: opened.proposal_instance_id ?? null,
      normalized_envelope_hash: opened.normalized_envelope_hash ?? null,
      drafter,
      scan,
    };
  }
  append({
    action: "autonomous_chain_failed",
    status: "blocked",
    reason: scan.reason || "autonomous_scan_opened_no_pr",
  });
  return {
    ok: false,
    status: "blocked",
    reason: scan.reason || "autonomous_scan_opened_no_pr",
    opportunity_hash: hash,
    drafter,
    scan,
  };
}

function findOpenedProposalCandidate(scan) {
  if (!Array.isArray(scan?.candidates)) return null;
  return scan.candidates.find((candidate) =>
    candidate.status === "controller_called_pr_opened"
    && candidate.pr
    && (candidate.pr.url || candidate.pr.number));
}

function reportWorkflowType(report) {
  const targetKey = report?.candidate_target_key;
  const match = String(targetKey || "").match(/^[^/]+\/([^/]+)\//);
  return match?.[1] || null;
}

function readRecentTraceReceipts({
  repoRoot,
  workflowType,
  lookbackDays,
  now,
} = {}) {
  const paths = traceTelemetryPaths(repoRoot);
  if (!fs.existsSync(paths.runsDir)) return [];
  const cutoffMs = now().getTime() - Math.max(1, Number(lookbackDays) || 1) * 24 * 60 * 60 * 1000;
  const receipts = [];
  for (const entry of fs.readdirSync(paths.runsDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(paths.runsDir, entry);
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (receipt?.workflow_type !== workflowType) continue;
    const observedMs = Date.parse(receipt.observed_at || "");
    if (Number.isFinite(observedMs) && observedMs < cutoffMs) continue;
    receipts.push(receipt);
  }
  return receipts;
}
