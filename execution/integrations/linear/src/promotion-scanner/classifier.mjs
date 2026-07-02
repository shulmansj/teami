import {
  parseCandidateTargetKey,
  PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
} from "../promote-candidate.mjs";
import {
  canonicalJson,
  isTerminalNoControllerStatus,
  setCandidateStatus,
  sha256,
} from "./ledger-store.mjs";
import { isPhoenixGeneratedExperimentProjectName } from "./phoenix-tags.mjs";

function latestReceiptEventTime(candidate) {
  const receipt = candidate.receipt;
  const times = [
    receipt?.created_at,
    receipt?.launch?.launched_at,
    ...(receipt?.events || []).map((event) => event.at),
    ...(receipt?.amendments || []).map((event) => event.amended_at || event.at),
  ].filter(Boolean).sort();
  return times.at(-1) || null;
}

export function classifyReceiptCandidates({
  candidates,
  policy,
  phoenixReady,
  tagScan,
  experimentSummaries,
  baselineResolver,
  agentBehaviorTargetKeys = new Set(),
  agentBehaviorCatalog = { ok: true },
  now,
}) {
  const scanner = policy.scanner_routing;
  const projectNames = new Set(scanner.eligible_phoenix.project_names);
  const datasetNames = new Set(scanner.eligible_phoenix.dataset_names);
  const splitNames = new Set(scanner.eligible_phoenix.split_names);
  const freshnessMs = scanner.freshness_window_days * 24 * 60 * 60 * 1000;
  for (const candidate of candidates) {
    if (candidate.source !== "managed_experiment_receipt") continue;
    if (candidate.status !== "unclassified" && isTerminalNoControllerStatus(candidate.status)) continue;
    const state = candidate.receipt_state;
    const receipt = candidate.receipt;
    if (!state) continue;
    if (!state.phoenix_experiment_id) {
      setCandidateStatus(candidate, "needs_reconciliation", "missing_experiment_join", "receipt has no Phoenix experiment id");
      continue;
    }
    if (candidate.status === "needs_reconciliation") continue;
    if (state.state === "withdrawn") {
      setCandidateStatus(candidate, "withdrawn_no_action", "receipt_withdrawn", "withdrawn receipt has no still-visible Phoenix tag");
      continue;
    }
    if (state.intent !== scanner.explicit_intent_signals.managed_experiment_receipt_intent) {
      setCandidateStatus(
        candidate,
        "discovered_evidence_without_intent",
        "experiment_intent_not_promotion_candidate",
        `receipt intent is ${state.intent}`,
      );
      continue;
    }
    if (!policy.eligible_launch_sources.includes(state.source)) {
      setCandidateStatus(candidate, "needs_reconciliation", "launch_source_not_eligible", state.source);
      continue;
    }
    const targetParse = parseCandidateTargetKey(candidate.candidate_target_key);
    if (!targetParse.ok) {
      setCandidateStatus(candidate, "needs_reconciliation", targetParse.reason, targetParse.detail ?? null);
      continue;
    }
    if (!agentBehaviorCatalog.ok) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "agent_behavior_target_catalog_unavailable",
        agentBehaviorCatalog.detail || agentBehaviorCatalog.reason || null,
      );
      continue;
    }
    if (!agentBehaviorTargetKeys.has(candidate.candidate_target_key)) {
      setCandidateStatus(
        candidate,
        "ignored_unmanaged_target",
        "candidate_target_not_manifest_agent_behavior",
        "the scanner candidate catalog contains only manifest-declared agent behavior targets",
      );
      continue;
    }
    const latestAt = latestReceiptEventTime(candidate);
    const latestMs = latestAt ? new Date(latestAt).getTime() : NaN;
    if (!Number.isFinite(latestMs) || now().getTime() - latestMs > freshnessMs) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "stale_evidence",
        `latest receipt event ${latestAt || "missing"} is outside scanner freshness_window_days=${scanner.freshness_window_days}`,
      );
      continue;
    }
    const launchScope = receipt.launch?.phoenix_scope || {};
    if (
      launchScope.project_name
      && !projectNames.has(launchScope.project_name)
      && !isPhoenixGeneratedExperimentProjectName(launchScope.project_name)
    ) {
      setCandidateStatus(candidate, "needs_reconciliation", "phoenix_project_not_eligible", launchScope.project_name);
      continue;
    }
    if (candidate.dataset_name && !datasetNames.has(candidate.dataset_name)) {
      setCandidateStatus(candidate, "needs_reconciliation", "dataset_not_eligible_for_scanner", candidate.dataset_name);
      continue;
    }
    const requestedSplit = receipt.launch?.split?.requested ?? null;
    if (requestedSplit && !splitNames.has(requestedSplit)) {
      setCandidateStatus(candidate, "needs_reconciliation", "split_not_eligible_for_scanner", requestedSplit);
      continue;
    }
    const baselineResolution = baselineResolver(candidate.candidate_target_key);
    if (!baselineResolution.ok) {
      setCandidateStatus(candidate, "needs_reconciliation", baselineResolution.reason, baselineResolution.detail ?? null);
      continue;
    }
    const currentBaselineId = baselineResolution.baseline.accepted_baseline_id;
    const receiptBaselineId = receipt.launch?.launch_baseline?.accepted_baseline_id ?? null;
    if (receiptBaselineId !== currentBaselineId) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "stale_baseline_identity",
        `receipt baseline ${receiptBaselineId} does not match current repo baseline ${currentBaselineId}`,
      );
      continue;
    }
    if (!phoenixReady.ok) {
      setCandidateStatus(candidate, "needs_reconciliation", "phoenix_scan_unavailable", phoenixReady.detail || phoenixReady.reason);
      continue;
    }
    if (candidate.prompt_version_id && tagScan?.ok === false) {
      setCandidateStatus(candidate, "needs_reconciliation", "phoenix_prompt_tag_scan_unavailable", tagScan.detail || tagScan.reason);
      continue;
    }
    const resolved = experimentSummaries.get(state.phoenix_experiment_id);
    if (!resolved?.ok) {
      setCandidateStatus(candidate, "needs_reconciliation", resolved?.reason || "experiment_unresolvable", resolved?.detail ?? null);
      continue;
    }
    const experiment = resolved.experiment;
    if (
      experiment.project_name
      && !projectNames.has(experiment.project_name)
      && !isPhoenixGeneratedExperimentProjectName(experiment.project_name)
    ) {
      setCandidateStatus(candidate, "needs_reconciliation", "phoenix_project_not_eligible", experiment.project_name);
      continue;
    }
    if (experiment.dataset_id !== candidate.dataset_id
      || (experiment.dataset_version_id ?? null) !== candidate.dataset_version_id) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "experiment_receipt_mismatch",
        `experiment resolves to dataset ${experiment.dataset_id}@${experiment.dataset_version_id ?? "unknown"} but receipt pins ${candidate.dataset_id}@${candidate.dataset_version_id}`,
      );
      continue;
    }
    candidate.controller_request = buildPromotionRequestFromCandidate({
      candidate,
      expectedProject: phoenixReady.projectName,
    });
    candidate.request_hash = sha256(canonicalJson(candidate.controller_request));
    setCandidateStatus(candidate, "candidate_intent_ready", "explicit_intent_packaged", null);
  }
}

function buildPromotionRequestFromCandidate({ candidate, expectedProject }) {
  return {
    schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
    source: "promotion_candidate_scanner",
    actor_id: "teami_scanner",
    expected_project: expectedProject,
    experiment_id: candidate.experiment_id,
    ...(candidate.prompt_version_id ? { prompt_version_id: candidate.prompt_version_id } : {}),
    ...(candidate.receipt?.launch?.evaluators?.judge?.evaluator_id
      ? { evaluator_id: candidate.receipt.launch.evaluators.judge.evaluator_id }
      : {}),
    ...(candidate.dataset_version_id ? { dataset_version_id: candidate.dataset_version_id } : {}),
    requested_action: "propose_repo_change",
  };
}
