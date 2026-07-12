import fs from "node:fs";
import path from "node:path";

import { defaultGateReportDir } from "../process-change-gate.mjs";
import { defaultPromotionRegistryDir, readJsonTolerant } from "./registry-store.mjs";
import { resolveTeamiHome } from "../app-home.mjs";

export function collectAutonomousLoopSignalSurfaces({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registryDir = defaultPromotionRegistryDir(home),
  gateReportDir = defaultGateReportDir(home),
  repoMarkerState = null,
} = {}) {
  void repoRoot;
  return {
    registry_records: readRegistryRecords(registryDir),
    gate_reports: readGateReports(gateReportDir),
    repo_marker_state: repoMarkerState,
  };
}

export function computeAutonomousLoopSignals({
  registryRecords = [],
  gateReports = [],
  repoMarkerState = null,
} = {}) {
  const proposalRecords = registryRecords.filter((record) =>
    record?.schema_version === "teami-promotion-candidate-registry/v1");
  const targetKeys = proposalRecords
    .map((record) => record.candidate_target_key)
    .filter((value) => typeof value === "string" && value.trim());
  const duplicateCount = Math.max(0, targetKeys.length - new Set(targetKeys).size);

  const counts = repoMarkerState?.counts || {};
  const closedUnmerged = nonNegativeNumber(
    counts.closed_unmerged_proposals,
    counts.readable_closed_unmerged_markers,
    0,
  );
  const open = nonNegativeNumber(counts.active_open_proposals, 0);
  const readableClosed = nonNegativeNumber(counts.readable_closed_markers, closedUnmerged);
  const proposalDenominator = Math.max(1, open + readableClosed);

  const gateDenominator = Math.max(1, gateReports.length);
  const noLiftCount = gateReports.filter((report) =>
    report?.failed_condition_ids?.includes?.("improves_target_scores")
    || report?.conditions?.some?.((entry) => entry?.id === "improves_target_scores" && entry.status === "fail"));
  const goldExamples = gateReports.reduce(
    (sum, report) => sum + nonNegativeNumber(report?.evidence_counts?.test_human_labeled_examples, 0),
    0,
  );
  const goldDisagreements = gateReports.reduce(
    (sum, report) => sum + (Array.isArray(report?.disagreements) ? report.disagreements.length : 0),
    0,
  );
  return {
    decline_rate: closedUnmerged / proposalDenominator,
    duplicate_proposal_rate: duplicateCount / Math.max(1, proposalRecords.length),
    no_experiment_lift: noLiftCount.length / gateDenominator,
    gold_label_disagreement_rate: goldDisagreements / Math.max(1, goldExamples),
    global_open_auto_prs: open,
    counts: {
      proposal_records: proposalRecords.length,
      duplicate_proposals: duplicateCount,
      closed_unmerged_proposals: closedUnmerged,
      gate_reports: gateReports.length,
      no_lift_gate_reports: noLiftCount.length,
      gold_holdout_examples: goldExamples,
      gold_label_disagreements: goldDisagreements,
    },
  };
}

function readRegistryRecords(registryDir) {
  if (!fs.existsSync(registryDir)) return [];
  const records = [];
  for (const entry of fs.readdirSync(registryDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonTolerant(path.join(registryDir, entry));
    if (record) records.push(record);
  }
  return records;
}

function readGateReports(gateReportDir) {
  if (!fs.existsSync(gateReportDir)) return [];
  const reports = [];
  for (const entry of fs.readdirSync(gateReportDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonTolerant(path.join(gateReportDir, entry));
    if (record?.schema_version === "teami-process-change-gate-report/v1") reports.push(record);
  }
  return reports;
}

function nonNegativeNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}
