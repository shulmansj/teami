import path from "node:path";

import { ensurePhoenixReady } from "./local-phoenix-manager.mjs";
import { promoteCandidate } from "./promote-candidate.mjs";
import { PROMOTION_POLICY_PATH, resolveTrustedPolicyRead } from "./promotion-policy.mjs";
import {
  ownerCopyForPromotionWriteGuard,
  resolvePromotionWriteGuard,
  resolvePromotionWriteGuardActivationState,
} from "./promotion-write-guard.mjs";
import {
  agentBehaviorTargetsFromManifest,
  agentBehaviorPromptTargetsFromManifest,
} from "./promotion/agent-behavior-scope.mjs";
import {
  defaultPromotionWorkspaceDir,
  ensurePromotionWorkspace,
} from "./promotion-workspace.mjs";
import {
  deriveLaunchBaselineFromActiveManifest,
  deriveLaunchBaselineFromTrustedClone,
  readPhoenixAssetsManifestFromActiveCheckout,
  readPhoenixAssetsManifestFromTrustedClone,
} from "./promotion-scanner/baseline-resolver.mjs";
import { classifyReceiptCandidates } from "./promotion-scanner/classifier.mjs";
import {
  candidateSortKey,
  defaultPromotionCandidateLedgerDir,
  promotionScannerHealthPath,
  promotionScannerLedgerPath,
  scanIdFromDate,
  setCandidateStatus,
} from "./promotion-scanner/ledger-store.mjs";
import {
  acquirePromotionCandidateScannerLock,
  DEFAULT_SCANNER_LOCK_STALE_MS,
} from "./promotion-scanner/lock.mjs";
import {
  loadReceiptCandidates,
  markAmbiguousReceiptJoins,
  reconcilePromptTagsWithReceipts,
  resolveExperimentSummaries,
  resolvePhoenixReady,
  scanPhoenixPromptCandidateTags,
} from "./promotion-scanner/phoenix-tags.mjs";
import { scanRepoCandidateArtifactStubs } from "./promotion-scanner/repo-artifacts.mjs";
import { deriveScannerRepoMarkerState } from "./promotion-scanner/repo-marker-state.mjs";
import {
  deriveScanHealthStatus,
  ledgerEntry,
  suppressReadyCandidates,
  writeLedgerAndHealth,
} from "./promotion-scanner/health-report.mjs";

// Step 12: deterministic candidate-intent scanner. This module is plumbing:
// it detects explicit intent, reconciles evidence joins, records local status,
// and calls the committed promotion controller only through the production
// promoteCandidate() API. It never assigns evidence_quality/promotion_risk and
// never writes product explanations (CONSTRAINTS #18).

export {
  defaultPromotionCandidateLedgerDir,
  PROMOTION_SCANNER_HEALTH_SCHEMA_VERSION,
  PROMOTION_SCANNER_LEDGER_SCHEMA_VERSION,
  promotionScannerHealthPath,
  promotionScannerLedgerPath,
  promotionScannerLockPath,
  readPromotionScannerLedger,
} from "./promotion-scanner/ledger-store.mjs";
export {
  acquirePromotionCandidateScannerLock,
  DEFAULT_SCANNER_LOCK_STALE_MS,
  PROMOTION_SCANNER_LOCK_SCHEMA_VERSION,
} from "./promotion-scanner/lock.mjs";
export { PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN } from "./promotion-scanner/phoenix-tags.mjs";
export { REPO_CANDIDATE_ARTIFACT_STUB_SCHEMA_VERSION } from "./promotion-scanner/repo-artifacts.mjs";
export { deriveScannerRepoMarkerState } from "./promotion-scanner/repo-marker-state.mjs";
export { formatPromotionCandidateScanReport } from "./promotion-scanner/health-report.mjs";

export const SCANNER_CANDIDATE_STATUSES = Object.freeze([
  "candidate_intent_ready",
  "controller_called",
  "discovered_evidence_without_intent",
  "ignored_unmanaged_target",
  "needs_reconciliation",
  "promotion_write_report_only",
  "suppressed_by_policy",
  "withdrawn_no_action",
]);

export const UNTRUSTED_SCANNER_OVERRIDE_KEYS = Object.freeze([
  "ensureReady",
  "fetchImpl",
  "promoteCandidateFn",
  "githubTransport",
  "policyPath",
  "receiptDir",
  "ledgerDir",
  "env",
  "now",
  "lockStaleAfterMs",
  "policyReadMode",
]);

export async function scanPromotionCandidates(options = {}) {
  for (const key of UNTRUSTED_SCANNER_OVERRIDE_KEYS) {
    if (key in options) {
      throw new Error(
        `untrusted_scanner_override_rejected:${key} — production scanner calls the production promoteCandidate API and uses production resolver/transports; injection exists only behind createPromotionCandidateScannerTestHarness.`,
      );
    }
  }
  return scanPromotionCandidatesWithOverrides({ ...options, policyReadMode: "unattended" });
}

export function createPromotionCandidateScannerTestHarness(overrides = {}) {
  return {
    kind: "promotion_candidate_scanner_test_harness",
    scanPromotionCandidates: (options = {}) =>
      scanPromotionCandidatesWithOverrides({ ...overrides, ...options }),
  };
}

async function scanPromotionCandidatesWithOverrides({
  repoRoot = process.cwd(),
  onProgress = () => {},
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  promoteCandidateFn = promoteCandidate,
  githubTransport = null,
  policyPath = PROMOTION_POLICY_PATH,
  receiptDir = null,
  ledgerDir = null,
  env = process.env,
  now = () => new Date(),
  lockStaleAfterMs = DEFAULT_SCANNER_LOCK_STALE_MS,
  policyReadMode = "user_invoked",
} = {}) {
  const startedDate = now();
  const startedAt = startedDate.toISOString();
  const scanId = scanIdFromDate(startedDate);
  const resolvedLedgerDir = ledgerDir || defaultPromotionCandidateLedgerDir(repoRoot);
  const lock = acquirePromotionCandidateScannerLock({
    ledgerDir: resolvedLedgerDir,
    now,
    staleAfterMs: lockStaleAfterMs,
  });
  if (!lock.ok) {
    return {
      ok: false,
      status: "blocked",
      scan_id: scanId,
      reason: lock.reason,
      detail: lock.detail,
      lock_path: lock.lock_path,
      candidates: [],
    };
  }

  let releaseCalled = false;
  try {
    onProgress(`promotion scanner: acquired ledger lock ${lock.lock_path}`);
    let internalCloneDir = path.join(defaultPromotionWorkspaceDir(repoRoot), "repo");
    if (policyReadMode === "unattended") {
      const workspace = ensurePromotionWorkspace({ repoRoot });
      if (!workspace.ok) {
        const finishedAt = now().toISOString();
        const candidates = [];
        const repoMarkerState = null;
        const phoenixScan = { ok: false, status: "not_run", reason: "internal_promotion_workspace_unavailable" };
        const { ledger, health } = writeLedgerAndHealth({
          ledgerDir: resolvedLedgerDir,
          scanId,
          startedAt,
          finishedAt,
          candidates,
          status: "blocked",
          policyRead: null,
          phoenixScan,
          repoMarkerState,
        });
        return {
          ok: false,
          status: "blocked",
          scan_id: scanId,
          reason: workspace.reason,
          detail: workspace.detail ?? null,
          candidates,
          ledger_path: promotionScannerLedgerPath(resolvedLedgerDir),
          health_path: promotionScannerHealthPath(resolvedLedgerDir),
          ledger,
          health,
        };
      }
      internalCloneDir = workspace.cloneDir;
    }
    const policyRead = resolveTrustedPolicyRead({
      mode: policyReadMode,
      policyPath,
      internalCloneDir,
    });
    if (!policyRead.ok) {
      const finishedAt = now().toISOString();
      const candidates = [];
      const repoMarkerState = null;
      const phoenixScan = { ok: false, status: "not_run", reason: "promotion_policy_unavailable" };
      const { ledger, health } = writeLedgerAndHealth({
        ledgerDir: resolvedLedgerDir,
        scanId,
        startedAt,
        finishedAt,
        candidates,
        status: "blocked",
        policyRead: null,
        phoenixScan,
        repoMarkerState,
      });
      return {
        ok: false,
        status: "blocked",
        scan_id: scanId,
        reason: policyRead.reason,
        detail: policyRead.detail ?? null,
        candidates,
        ledger_path: promotionScannerLedgerPath(resolvedLedgerDir),
        health_path: promotionScannerHealthPath(resolvedLedgerDir),
        ledger,
        health,
      };
    }
    const policy = policyRead.policy;
    const receiptScan = loadReceiptCandidates({ repoRoot, receiptDir });
    const candidates = [...receiptScan.candidates];
    markAmbiguousReceiptJoins(candidates);
    const baselineResolutionCache = new Map();
    const baselineResolver = (candidateTargetKey) => {
      const key = candidateTargetKey;
      if (!key) {
        return {
          ok: false,
          reason: "candidate_target_key_required_for_baseline",
          detail: "scanner baseline resolution requires an explicit candidate target key.",
        };
      }
      if (!baselineResolutionCache.has(key)) {
        baselineResolutionCache.set(
          key,
          policyReadMode === "unattended"
            ? deriveLaunchBaselineFromTrustedClone({ internalCloneDir, candidateTargetKey: key })
            : deriveLaunchBaselineFromActiveManifest({ repoRoot, candidateTargetKey: key }),
        );
      }
      return baselineResolutionCache.get(key);
    };
    const manifestResolution = policyReadMode === "unattended"
      ? readPhoenixAssetsManifestFromTrustedClone({ internalCloneDir })
      : readPhoenixAssetsManifestFromActiveCheckout({ repoRoot });
    const scannerAgentBehaviorTargets = manifestResolution.ok
      ? agentBehaviorTargetsFromManifest(manifestResolution.manifest)
      : [];
    const scannerPromptTargets = manifestResolution.ok
      ? agentBehaviorPromptTargetsFromManifest(manifestResolution.manifest)
      : [];
    const scannerAgentBehaviorTargetKeys = new Set(
      scannerAgentBehaviorTargets.map((target) => target.target_key),
    );

    const phoenixReady = await resolvePhoenixReady({
      repoRoot,
      ensureReady,
      fetchImpl,
      env,
      onProgress,
    });
    let tagScan = { ok: false, status: "not_run", reason: "scanner_routing_disabled" };
    let experimentSummaries = new Map();
    if (phoenixReady.ok && policy.scanner_routing.enabled && manifestResolution.ok) {
      tagScan = await scanPhoenixPromptCandidateTags({
        appUrl: phoenixReady.appUrl,
        policy,
        promptTargets: scannerPromptTargets,
        fetchImpl,
      });
      if (tagScan.ok) {
        candidates.push(...reconcilePromptTagsWithReceipts({ candidates, tagScan }));
      }
      experimentSummaries = await resolveExperimentSummaries({
        appUrl: phoenixReady.appUrl,
        candidates,
        fetchImpl,
      });
    } else if (!phoenixReady.ok) {
      tagScan = { ok: false, status: "degraded", reason: phoenixReady.reason, detail: phoenixReady.detail };
    } else if (phoenixReady.ok && !manifestResolution.ok) {
      tagScan = {
        ok: false,
        status: "degraded",
        reason: "agent_behavior_target_catalog_unavailable",
        detail: manifestResolution.detail || manifestResolution.reason,
        tags: [],
      };
    }

    candidates.push(...scanRepoCandidateArtifactStubs({
      repoRoot,
      policy,
      trustedClone: policyReadMode === "unattended" ? { internalCloneDir } : null,
    }));
    classifyReceiptCandidates({
      candidates,
      policy,
      phoenixReady,
      tagScan,
      experimentSummaries,
      baselineResolver,
      agentBehaviorTargetKeys: scannerAgentBehaviorTargetKeys,
      agentBehaviorCatalog: manifestResolution,
      now,
    });

    const repoMarkerState = await deriveScannerRepoMarkerState({
      repoRoot,
      policy,
      githubTransport,
      now,
    });
    if (!repoMarkerState.controller_calls_allowed) {
      suppressReadyCandidates({
        candidates,
        reason: repoMarkerState.reason,
        detail: repoMarkerState.detail,
      });
    }

    const activationState = resolvePromotionWriteGuardActivationState({ env });
    candidates.sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));
    for (const candidate of candidates) {
      if (candidate.status !== "candidate_intent_ready") continue;
      // DEFERRED GAP (Phase 8): the unattended scanner does NOT yet compute a
      // real per-candidate meta-change classification here — it hands the write
      // guard a fixed `ordinary_semantic` stub. Real classification (meta vs
      // ordinary, protected paths, affected surfaces) is only derived inside the
      // controller from the MATERIALIZED diff (classifyMaterializedPromotionFiles
      // in experiment-branch.mjs), which the controller's own write guard then
      // re-evaluates. The scanner's stub is conservative for the current
      // unattended posture (the controller is the authoritative gate and the
      // commit enforces the path allowlist regardless), so this is a known,
      // intentional gap to close when the scanner gains real classification,
      // not a silent bypass. No behavior change here.
      const scannerWriteGuard = resolvePromotionWriteGuard({
        invocation: {
          transport: "promotion_candidate_scanner",
          unattended: policyReadMode === "unattended",
        },
        classification: {
          class: "ordinary_semantic",
          reasons: [],
          protected_paths: [],
          affected_surfaces: [],
          mixed_classes: [],
        },
        activationState,
      });
      if (scannerWriteGuard.mode !== "write") {
        candidate.write_guard = scannerWriteGuard;
        setCandidateStatus(
          candidate,
          scannerWriteGuard.mode === "report_only"
            ? "promotion_write_report_only"
            : "suppressed_by_policy",
          scannerWriteGuard.reason,
          ownerCopyForPromotionWriteGuard(scannerWriteGuard),
        );
        continue;
      }
      onProgress(`promotion scanner: calling controller for ${candidate.candidate_key}`);
      const controllerResult = await promoteCandidateFn({
        repoRoot,
        request: candidate.controller_request,
        invocation: { transport: "promotion_candidate_scanner" },
        onProgress,
      });
      candidate.controller_result = {
        ok: Boolean(controllerResult.ok),
        outcome: controllerResult.outcome ?? null,
        reason: controllerResult.reason ?? null,
        detail: controllerResult.detail ?? null,
        terminal: controllerResult.terminal ?? null,
        evidence_repair: Boolean(controllerResult.evidence_repair),
        improvement_opportunity: controllerResult.improvement_opportunity ?? null,
        proposal_instance_id: controllerResult.proposal_instance_id ?? null,
        normalized_envelope_hash: controllerResult.normalized_envelope_hash ?? null,
        pr_title: controllerResult.pr_title ?? controllerResult.pr?.title ?? null,
        pr: controllerResult.pr ?? null,
      };
      setCandidateStatus(candidate, "controller_called", "controller_invoked", controllerResult.outcome ?? null);
    }

    const finishedAt = now().toISOString();
    const status = deriveScanHealthStatus({
      candidates,
      phoenixReady,
      tagScan,
      repoMarkerState,
    });
    const { ledger, health } = writeLedgerAndHealth({
      ledgerDir: resolvedLedgerDir,
      scanId,
      startedAt,
      finishedAt,
      candidates,
      status,
      policyRead,
      phoenixScan: {
        ok: phoenixReady.ok && tagScan.ok !== false,
        ready: phoenixReady.ok,
        reason: phoenixReady.ok ? tagScan.reason ?? null : phoenixReady.reason,
        detail: phoenixReady.ok ? tagScan.detail ?? null : phoenixReady.detail,
        app_url: phoenixReady.ok ? phoenixReady.appUrl : phoenixReady.configured.appUrl,
        project_name: phoenixReady.ok ? phoenixReady.projectName : phoenixReady.configured.projectName,
        prompt_tag_scan: tagScan,
      },
      repoMarkerState,
    });
    return {
      ok: true,
      status,
      scan_id: scanId,
      started_at: startedAt,
      finished_at: finishedAt,
      candidates: candidates.map(ledgerEntry),
      policy: {
        policy_version: policy.policy_version,
        policy_hash: policyRead.policy_hash,
        read_path: policyRead.read_path,
      },
      phoenix_scan: health.phoenix_scan,
      repo_marker_state: health.repo_marker_state,
      ledger_path: promotionScannerLedgerPath(resolvedLedgerDir),
      health_path: promotionScannerHealthPath(resolvedLedgerDir),
      ledger,
      health,
    };
  } finally {
    if (!releaseCalled) {
      releaseCalled = true;
      lock.release();
    }
  }
}
