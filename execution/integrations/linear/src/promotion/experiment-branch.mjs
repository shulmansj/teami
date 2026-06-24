import path from "node:path";

import { collectExperimentEvidence } from "../disagreement-report.mjs";
import { sanitizeAndClassifyContent } from "../eval-content-gate.mjs";
import { createGitHubPromotionClient } from "../github-promotion-client.mjs";
import { createProductionGitHubPromotionTransport } from "../github-production-transport.mjs";
import { resolveBehaviorRepoIdentity } from "../github-setup.mjs";
import { ensurePhoenixReady, resolvePhoenixConfig } from "../local-phoenix-manager.mjs";
import { evaluateProcessChangeGate } from "../process-change-gate.mjs";
import { PROMOTION_POLICY_PATH, resolveTrustedPolicyRead } from "../promotion-policy.mjs";
import {
  allowedPromotionArtifactPaths,
  materializePromotionCandidate,
  resolveMaterializerTarget,
  validateBehaviorDiff,
} from "../promotion-materializer.mjs";
import {
  classifyMaterializedPromotionFiles,
  ownerCopyForPromotionWriteGuard,
  resolvePromotionWriteGuard,
  resolvePromotionWriteGuardActivationState,
} from "../promotion-write-guard.mjs";
import {
  markerAdvisoriesFor,
} from "./factory-change-disposition.mjs";
import {
  PACKET_COMPLETENESS_GUARD_REASON,
  PACKET_COMPLETENESS_REPAIR_STATE,
  applyPromotionPacketGuardStatus,
  buildPromotionProposalPacket,
  buildPromotionPrTitle,
  markPromotionPrBodyBlockedForRepair,
  ownerCopyForPacketCompletenessRepair,
  promotionPacketGuardRegistryRecord,
  renderPromotionProposalPacketMarkdown,
  validatePromotionPacketCompleteness,
} from "../promotion-pr-body.mjs";
import {
  branchExists,
  checkoutPromotionBranch,
  commitPromotionDraft,
  controllerNamespacePr,
  defaultPromotionWorkspaceDir,
  defaultRunGit,
  ensurePromotionWorkspace,
  promotionBranchName,
  pushBranchPlaceholder,
  pushPromotionBranchWithInstallationToken,
  verifyPromotionBranchEnvelope,
} from "../promotion-workspace.mjs";
import {
  DEFAULT_GITHUB_REPO_PLACEHOLDER,
  deriveEvidenceQualityLabel,
  derivePromotionRiskLabel,
  deriveTriggerAuthenticity,
  isPhoenixGeneratedExperimentProjectName,
  normalizeOrigin,
  parseCandidateTargetKey,
  phoenixRequestJson,
  preflightPromotionResolverCapabilities,
  reconcilePromptDeepLink,
  resolveExperimentSummary,
  validatePhoenixDeepLink,
  validatePromotionRequest,
} from "./request-contract.mjs";
import {
  classifyAgentBehaviorProposalScope,
  ownerCopyForAgentBehaviorScope,
} from "./agent-behavior-scope.mjs";
import {
  resolvePromotionAcceptancePolicyDecision,
} from "./acceptance-policy-decision.mjs";
import { acquirePromotionControllerLock, promotionControllerStateDirForRegistryDir } from "./controller-lock.mjs";
import {
  PROMOTION_REGISTRY_SCHEMA_VERSION,
  appendRegistryStage,
  computeNormalizedEnvelope,
  defaultPromotionRegistryDir,
  readPromotionRegistryRecord,
  writeRegistryFile,
} from "./registry-store.mjs";
import {
  buildPromotionMarker,
  readPromotionMarker,
  registryBlockedOutcomeIsRetryable,
  registryPrRecordStaleInCurrentMode,
  registryPrReuseNeedsLiveValidation,
  registryPrValidationShouldFailClosed,
  supersedeRepairDetail,
  updateMarkerInBody,
  validateRegistryRecordedPullRequest,
} from "./pr-marker.mjs";
import {
  buildMarkerUndoBounds,
  buildMergedAcceptedRef,
} from "./marker-undo-frame.mjs";
import {
  PR_EVIDENCE_SUMMARY_CONTENT_POLICY,
  buildEvidenceSummaryPayload,
  buildPromotionEvidenceSummaryLines,
} from "./evidence-summary.mjs";
import {
  buildEvidenceRefsFromEnvelope,
  buildPhoenixDeepLinksFromEvidenceIds,
  extractCandidateSnapshotExcerpt,
  findManifestTarget,
  findReceiptByExperimentId,
  humanNameForTarget,
  recordPhoenixOutcomeObservation,
  resolveTrustedPromotionArtifacts,
  validatedFailureModes,
} from "./trusted-artifacts.mjs";
import { DECOMPOSITION_EVAL_PATHS } from "../workflows/decomposition/eval-paths.mjs";

function postRejectionRegisterSuppliesNewEvidence({
  amendments = [],
  latestRejection = null,
  currentExperimentId = null,
  currentEnvelopeHash = null,
  rejectionMemory = [],
} = {}) {
  const latestRejectionMs = latestRejection ? new Date(latestRejection).getTime() : null;
  return amendments.some((amendment) => {
    if (amendment?.action !== "register") return false;
    const amendedAt = amendment.amended_at || amendment.at;
    if (!amendedAt) return false;
    const amendedMs = new Date(amendedAt).getTime();
    if (!Number.isFinite(amendedMs)) return false;
    if (latestRejectionMs !== null && amendedMs <= latestRejectionMs) return false;
    const registeredExperimentId = typeof amendment.experiment_id === "string"
      ? amendment.experiment_id.trim()
      : "";
    if (!registeredExperimentId || registeredExperimentId !== currentExperimentId) return false;
    return !rejectionMemory.some((entry) => {
      const rejectedExperiments = Array.isArray(entry?.marker?.evidence_ids?.experiments)
        ? entry.marker.evidence_ids.experiments
        : [];
      return entry?.marker?.normalized_envelope_hash === currentEnvelopeHash
        || rejectedExperiments.includes(registeredExperimentId);
    });
  });
}

export const UNTRUSTED_PROMOTION_OVERRIDE_KEYS = Object.freeze([
  "githubTransport",
  "githubRepo",
  "promotionPolicyPath",
  "workspaceEvalPolicyPath",
  "baselineExperimentOverride",
  "ensureReady",
  "fetchImpl",
  "runGit",
  "env",
  "acceptCrossVersion",
  "materializePromotionCandidateImpl",
]);

export async function promoteCandidate(options = {}) {
  for (const key of UNTRUSTED_PROMOTION_OVERRIDE_KEYS) {
    if (key in options) {
      throw new Error(
        `untrusted_override_rejected:${key} — the production promoteCandidate API accepts operational options only; trust-affecting injection exists only behind createPromoteCandidateTestHarness (tests), and cross-version acceptance travels in the request envelope as accept_cross_version_comparison.`,
      );
    }
  }
  return promoteCandidateWithOverrides(options);
}

// TEST-ONLY construction seam (outside-review FIX 4): the single place where
// transports/policy paths/baseline override/fetch/git/env may be injected.
// Production code (cli.mjs and any future scanner/supervisor caller) calls
// promoteCandidate above and can never reach these seams.
export function createPromoteCandidateTestHarness(overrides = {}) {
  if ("acceptCrossVersion" in overrides) {
    throw new Error(
      "untrusted_override_rejected:acceptCrossVersion — cross-version acceptance is request-visible only; set accept_cross_version_comparison: true on the request envelope.",
    );
  }
  return {
    kind: "promote_candidate_test_harness",
    promoteCandidate: (options = {}) =>
      promoteCandidateWithOverrides({ ...overrides, ...options }),
  };
}

async function promoteCandidateWithOverrides(options = {}) {
  const lockRef = { lock: null };
  try {
    return await promoteCandidateWithOverridesUnlocked(options, lockRef);
  } finally {
    lockRef.lock?.release();
  }
}

async function promoteCandidateWithOverridesUnlocked({
  repoRoot = process.cwd(),
  request,
  invocation = { transport: "cli_local_session" },
  githubTransport = null,
  githubRepo = null,
  receiptDir = null,
  registryDir = null,
  workspaceDir = null,
  promotionPolicyPath = PROMOTION_POLICY_PATH,
  workspaceEvalPolicyPath = undefined,
  gateReportDir = null,
  evalRunStoreDir = null,
  // Test-only injection mirroring steps 8/9: no baseline experiment is pinned
  // in the committed manifest yet, so offline tests must inject one.
  baselineExperimentOverride = undefined,
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  runGit = defaultRunGit,
  env = process.env,
  now = () => new Date(),
  onProgress = () => {},
  materializePromotionCandidateImpl = materializePromotionCandidate,
} = {}, lockRef = { lock: null }) {
  const startedAt = now().toISOString();
  const resolvedRegistryDir = registryDir || defaultPromotionRegistryDir(repoRoot);
  const acquireMutationLock = () => {
    if (lockRef.lock) return { ok: true, lock: lockRef.lock };
    const lock = acquirePromotionControllerLock({
      stateDir: promotionControllerStateDirForRegistryDir(resolvedRegistryDir),
      now,
    });
    if (lock.ok) lockRef.lock = lock;
    return lock.ok ? { ok: true, lock } : lock;
  };

  // Behavior-repo identity (step 11 wiring): production calls resolve the
  // repo from the local GitHub connection state written by `npm run init`
  // (the injected githubRepo override is test-harness-only, FIX 4). Missing
  // or unverified connection state falls back to the neutral placeholder
  // so dry-run request shapes stay honest without naming a real repo.
  let githubRepoSource = "test_harness_override";
  let repoIdentity = null;
  if (!githubRepo) {
    repoIdentity = resolveBehaviorRepoIdentity({ repoRoot });
    if (repoIdentity.ok) {
      githubRepo = repoIdentity.repo;
      githubRepoSource = `github_connection_state:${repoIdentity.connection_mode}`;
    } else {
      githubRepo = DEFAULT_GITHUB_REPO_PLACEHOLDER;
      githubRepoSource = "placeholder_no_verified_github_connection";
    }
  }
  onProgress(`behavior repo: ${githubRepo.owner}/${githubRepo.repo} (${githubRepoSource})`);

  const rejected = (reason, detail = null) => ({
    ok: false,
    outcome: "rejected",
    reason,
    ...(detail ? { detail } : {}),
    started_at: startedAt,
  });

  // 1. Transport + request validation (rejections happen before any evidence
  // work; they are caller errors, not controller outcomes).
  const authenticity = deriveTriggerAuthenticity({ transport: invocation?.transport });
  if (!authenticity.ok) return rejected(authenticity.reason, authenticity.detail);
  const validation = validatePromotionRequest(request);
  if (!validation.ok) return rejected(validation.reason, validation.detail);
  const normalized = validation.normalized;
  const triggerAuthenticity = {
    value: authenticity.value,
    derived_from: authenticity.derived_from,
    detail: authenticity.detail,
    ignored_caller_fields: normalized.ignored_caller_trust_fields,
  };
  if (normalized.ignored_caller_trust_fields.length > 0) {
    onProgress(
      `WARNING caller-supplied trust claims ignored (${normalized.ignored_caller_trust_fields.join(", ")}); trigger_authenticity is derived from the invocation transport only.`,
    );
  }

  // 2. Phoenix scope from LOCAL config only (CONSTRAINTS #6).
  const phoenixConfig = resolvePhoenixConfig({ repoRoot, env });
  const configuredOrigin = normalizeOrigin(phoenixConfig.appUrl);
  const configuredProject = phoenixConfig.projectName;
  const phoenixScope = { origin: configuredOrigin, project_name: configuredProject };
  // Pre-envelope blocks: controller outcomes with a named reason, but no
  // durable registry row / Phoenix outcome annotation exists yet because no
  // normalized envelope exists yet. Deterministic re-invocation re-validates.
  const blockedEarly = (reason, detail = null, extra = {}) => ({
    ok: false,
    outcome: "blocked",
    reason,
    ...(detail ? { detail } : {}),
    terminal: false,
    trigger_authenticity: triggerAuthenticity,
    phoenix_scope: phoenixScope,
    started_at: startedAt,
    ...extra,
  });
  if (normalized.expected_project !== configuredProject) {
    return blockedEarly(
      "expected_project_mismatch",
      `the request expects Phoenix project "${normalized.expected_project}" but the locally configured scope is "${configuredProject}"; cross-project/cross-tenant evidence is refused.`,
    );
  }

  // 3. Optional deep link: strict origin + path allowlist BEFORE extraction.
  let deepLinkIds = null;
  if (normalized.phoenix_deep_link) {
    const deepLink = validatePhoenixDeepLink({
      deepLink: normalized.phoenix_deep_link,
      configuredOrigin,
    });
    if (!deepLink.ok) return blockedEarly(deepLink.reason, deepLink.detail);
    deepLinkIds = deepLink.ids;
  }
  const effectiveExperimentId = normalized.experiment_id ?? deepLinkIds?.experiment_id ?? null;
  if (!effectiveExperimentId) {
    return blockedEarly(
      "missing_experiment_id",
      "neither the explicit IDs nor the validated deep link named a Phoenix experiment.",
    );
  }

  // 4. Trusted promotion-policy read (CONSTRAINTS #14): the CLI transport is
  // an explicit user invocation; unattended callers must read from the
  // internal clone at default-branch HEAD and fail closed without it.
  const policyMode = invocation?.transport === "cli_local_session" ? "user_invoked" : "unattended";
  const policyRead = resolveTrustedPolicyRead({
    mode: policyMode,
    policyPath: promotionPolicyPath,
    internalCloneDir: workspaceDir
      ? path.join(workspaceDir, "repo")
      : path.join(defaultPromotionWorkspaceDir(repoRoot), "repo"),
    runGit,
  });
  if (!policyRead.ok) return blockedEarly(policyRead.reason, policyRead.detail);
  const policy = policyRead.policy;
  const policyHash = policyRead.policy_hash;
  if (policy.disabled) {
    return blockedEarly(
      "promotion_disabled_by_policy",
      "promotion-policy.json sets disabled: true; the controller drafts nothing while the repo-owned disable flag is set.",
    );
  }
  // 5. Local Phoenix readiness; the live origin must equal the configured one.
  let ready;
  try {
    ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  } catch (error) {
    return blockedEarly("local_phoenix_unavailable", error.message);
  }
  if (!ready?.ok) return blockedEarly("local_phoenix_unavailable", ready?.reason || null);
  const appUrl = ready.appUrl;
  if (normalizeOrigin(appUrl) !== configuredOrigin) {
    return blockedEarly(
      "phoenix_origin_mismatch",
      `the live Phoenix origin ${appUrl} does not match the locally configured origin ${configuredOrigin}.`,
    );
  }

  // 6. Per-object resolver capability preflight (fail closed per capability).
  const requiredObjectTypes = ["experiment", "dataset_version", "annotations"];
  if (normalized.prompt_version_id || deepLinkIds?.prompt_id) requiredObjectTypes.push("prompt_version");
  // A /prompts/{id} deep link additionally requires the prompt-versions
  // listing capability so the id can be reconciled when it names a prompt
  // rather than a version (outside-review FIX 1). If the pinned Phoenix lacks
  // it, the prompt deep link FAILS CLOSED with the named capability gap
  // (resolver_capability_missing:prompt) — never a silent allow.
  if (deepLinkIds?.prompt_id) requiredObjectTypes.push("prompt");
  const capability = await preflightPromotionResolverCapabilities({
    appUrl,
    fetchImpl,
    requiredObjectTypes,
  });
  if (!capability.ok) return blockedEarly(capability.reason, capability.detail ?? null);

  // 7. Resolve evidence through the verified resolver. If the deep link and
  // explicit IDs disagree, BOTH are resolved and the mismatch is rejected
  // before drafting (CONSTRAINTS #6).
  if (deepLinkIds?.experiment_id && normalized.experiment_id
    && deepLinkIds.experiment_id !== normalized.experiment_id) {
    const [explicit, linked] = await Promise.all([
      resolveExperimentSummary({ appUrl, experimentId: normalized.experiment_id, fetchImpl }),
      resolveExperimentSummary({ appUrl, experimentId: deepLinkIds.experiment_id, fetchImpl }),
    ]);
    return blockedEarly(
      "deep_link_id_mismatch",
      `explicit experiment_id ${normalized.experiment_id} (${explicit.ok ? "resolves" : "unresolvable"}) and deep-link experiment id ${deepLinkIds.experiment_id} (${linked.ok ? "resolves" : "unresolvable"}) disagree; both were resolved through the verified resolver and the mismatch is rejected before drafting.`,
    );
  }
  const evidence = await collectExperimentEvidence({
    appUrl,
    projectName: configuredProject,
    experimentId: effectiveExperimentId,
    fetchImpl,
  });
  if (!evidence.ok) return blockedEarly(evidence.reason, evidence.detail ?? null);
  const experiment = evidence.experiment;
  // Phoenix 14 creates separate generated Experiment-* projects for
  // experiment-run traces. Those are storage metadata, not the source trace
  // project boundary; the gate still resolves HUMAN source annotations from
  // the locally configured project and fails closed if they are unreadable.
  if (experiment.project_name
    && experiment.project_name !== normalized.expected_project
    && !isPhoenixGeneratedExperimentProjectName(experiment.project_name)) {
    return blockedEarly(
      "cross_project_evidence",
      `experiment ${experiment.id} ran in Phoenix project "${experiment.project_name}", not the expected "${normalized.expected_project}"; cross-project IDs are refused before drafting.`,
    );
  }
  if (deepLinkIds?.dataset_id && deepLinkIds.dataset_id !== experiment.dataset_id) {
    return blockedEarly(
      "deep_link_id_mismatch",
      `the deep link names dataset ${deepLinkIds.dataset_id} but experiment ${experiment.id} belongs to dataset ${experiment.dataset_id}.`,
    );
  }

  // 8. Managed receipt join (explicit intent; CONSTRAINTS #18/#19).
  const join = findReceiptByExperimentId({
    repoRoot,
    receiptDir,
    experimentId: effectiveExperimentId,
  });
  if (join.matches.length === 0) {
    return blockedEarly(
      "discovered_evidence_without_intent",
      `experiment ${effectiveExperimentId} has no managed receipt, candidate prompt-version tag registration, or authenticated registration; discovered Phoenix-native evidence is never auto-proposed (CONSTRAINTS #18).`,
    );
  }
  if (join.matches.length > 1) {
    return blockedEarly(
      "ambiguous_receipt_join",
      `${join.matches.length} managed receipts claim experiment ${effectiveExperimentId}; reconcile the receipts before promotion.`,
    );
  }
  const { receipt, state: receiptState } = join.matches[0];
  if (receiptState.state === "withdrawn") {
    return blockedEarly(
      "receipt_withdrawn",
      `receipt ${receiptState.receipt_id} is withdrawn; a withdrawn candidate cannot be promoted — launch a new experiment for materially new evidence.`,
    );
  }
  if (receiptState.intent !== "promotion_candidate") {
    return blockedEarly(
      "experiment_intent_not_promotion_candidate",
      `receipt ${receiptState.receipt_id} declares intent "${receiptState.intent}"; explicit promotion intent is required (amend with --action reclassify to declare it).`,
    );
  }
  const hasRegisterAmendment = (receipt.amendments || []).some(
    (amendment) => amendment.action === "register",
  );
  const effectiveLaunchSource = hasRegisterAmendment ? "phoenix_native_registered" : receipt.source;
  if (!policy.eligible_launch_sources.includes(effectiveLaunchSource)) {
    return blockedEarly(
      "launch_source_not_eligible",
      `launch source "${effectiveLaunchSource}" is not in promotion-policy eligible_launch_sources (${policy.eligible_launch_sources.join(", ")}).`,
    );
  }

  // 9. Cross-checks of caller-supplied IDs against the receipt + resolver
  // (re-resolution, never in-process trust; CONSTRAINTS #13).
  const receiptDataset = receipt.launch.dataset || {};
  if (normalized.dataset_version_id
    && normalized.dataset_version_id !== receiptDataset.dataset_version_id) {
    return blockedEarly(
      "dataset_version_id_mismatch",
      `the request pins dataset version ${normalized.dataset_version_id} but the managed receipt pins ${receiptDataset.dataset_version_id}.`,
    );
  }
  try {
    const versions = await phoenixRequestJson({
      appUrl,
      pathname: `/v1/datasets/${encodeURIComponent(receiptDataset.dataset_id)}/versions`,
      searchParams: { limit: "100" },
      fetchImpl,
    });
    const versionIds = (versions?.data || []).map((entry) => entry.version_id);
    if (!versionIds.includes(receiptDataset.dataset_version_id)) {
      return blockedEarly(
        "dataset_version_unresolvable",
        `dataset version ${receiptDataset.dataset_version_id} was not found on dataset ${receiptDataset.dataset_id}; stale or ambiguous pins are refused.`,
      );
    }
  } catch (error) {
    return blockedEarly("dataset_version_unresolvable", error.message);
  }
  const receiptPromptVersionId =
    receipt.launch.candidate?.judge_candidate_prompt_version_id ?? null;
  let resolvedCandidate = null;
  if (normalized.prompt_version_id && normalized.prompt_version_id !== receiptPromptVersionId) {
    return blockedEarly(
      "prompt_version_id_mismatch",
      `the request pins prompt version ${normalized.prompt_version_id} but the managed receipt pins ${receiptPromptVersionId ?? "none"}.`,
    );
  }
  if (receiptPromptVersionId) {
    try {
      resolvedCandidate = await phoenixRequestJson({
        appUrl,
        pathname: `/v1/prompt_versions/${encodeURIComponent(receiptPromptVersionId)}`,
        fetchImpl,
      });
    } catch (error) {
      return blockedEarly("prompt_version_unresolvable", error.message);
    }
  }
  // Outside-review FIX 1: reconcile a /prompts/{id} deep link against BOTH the
  // request's prompt_version_id and the receipt-pinned candidate version,
  // through the verified resolver — exactly like experiment/dataset deep-link
  // mismatches, before any drafting.
  if (deepLinkIds?.prompt_id) {
    const promptReconciliation = await reconcilePromptDeepLink({
      appUrl,
      promptDeepLinkId: deepLinkIds.prompt_id,
      requestPromptVersionId: normalized.prompt_version_id,
      receiptPromptVersionId,
      fetchImpl,
    });
    if (!promptReconciliation.ok) {
      return blockedEarly(promptReconciliation.reason, promptReconciliation.detail ?? null);
    }
  }
  const receiptEvaluatorId = receipt.launch.evaluators?.judge?.evaluator_id ?? null;
  if (normalized.evaluator_id && normalized.evaluator_id !== receiptEvaluatorId) {
    return blockedEarly(
      "evaluator_id_mismatch",
      `the request names evaluator ${normalized.evaluator_id} but the managed receipt pins ${receiptEvaluatorId ?? "none"} (evaluator identity is repo-owned; Phoenix has no evaluator resolver).`,
    );
  }
  const resolvedAnnotationIds = [...new Set(
    evidence.per_example.flatMap((entry) =>
      (entry.source_annotations || []).map((annotation) => annotation.annotation_id).filter(Boolean)),
  )].sort();
  if (normalized.annotation_ids.length > 0) {
    const unknown = normalized.annotation_ids.filter((id) => !resolvedAnnotationIds.includes(id));
    if (unknown.length > 0) {
      return blockedEarly(
        "annotation_ids_unresolvable",
        `annotation id(s) ${unknown.join(", ")} did not resolve on the cited experiment's evidence; missing or ambiguous IDs are refused.`,
      );
    }
  }

  // 10. Candidate target identity (canonical grammar; free-form keys break
  // cross-machine dedupe and are rejected before drafting).
  const candidateTargetKey = receipt.launch.candidate_target_key;
  const targetParse = parseCandidateTargetKey(candidateTargetKey);
  if (!targetParse.ok) return blockedEarly(targetParse.reason, targetParse.detail ?? null);
  const candidateKind = targetParse.candidate_kind;
  const candidateVersionId = receipt.launch.candidate?.candidate_version_id ?? null;
  const acceptedBaselineId = receipt.launch.launch_baseline?.accepted_baseline_id ?? null;
  let trustedArtifacts = resolveTrustedPromotionArtifacts({
    mode: policyMode,
    repoRoot,
    candidateTargetKey,
    internalCloneDir: workspaceDir
      ? path.join(workspaceDir, "repo")
      : path.join(defaultPromotionWorkspaceDir(repoRoot), "repo"),
    runGit,
  });
  if (!trustedArtifacts.ok) {
    return blockedEarly(trustedArtifacts.reason, trustedArtifacts.detail ?? null);
  }
  let materializerTarget = resolveMaterializerTarget({
    manifest: trustedArtifacts.manifest,
    candidateTargetKey,
  });
  let targetScope = classifyAgentBehaviorProposalScope({
    candidateTargetKey,
    target: materializerTarget.ok
      ? materializerTarget.target
      : findManifestTarget(trustedArtifacts.manifest, candidateTargetKey),
  });
  if (!targetScope.ok) {
    return {
      ok: false,
      outcome: "blocked",
      reason: targetScope.reason,
      detail: ownerCopyForAgentBehaviorScope(targetScope),
      terminal: true,
      candidate_target_key: candidateTargetKey,
      candidate_kind: candidateKind,
      candidate_version_id: candidateVersionId,
      accepted_baseline_id: acceptedBaselineId,
      target_scope: targetScope,
      trigger_authenticity: triggerAuthenticity,
      phoenix_scope: phoenixScope,
      started_at: startedAt,
    };
  }

  // 11. Step 9 process-change gate (mechanical conditions; adversarial prose
  // cannot waive them).
  const gate = await evaluateProcessChangeGate({
    repoRoot,
    receiptId: receiptState.receipt_id,
    receiptDir,
    evalRunStoreDir,
    gateReportDir,
    policyPath: workspaceEvalPolicyPath,
    // REQUEST-VISIBLE acceptance only (outside-review FIX 4): the explicit
    // human acceptance of cross-version comparison comes from the request
    // envelope and is disclosed in the marker and proposal document.
    acceptCrossVersion: normalized.accept_cross_version_comparison,
    baselineExperimentOverride,
    ensureReady: async () => ready,
    fetchImpl,
    onProgress,
    now,
  });
  if (!gate.ok) {
    // The gate failed closed before producing evidence facts (transient or
    // configuration causes); no envelope exists yet, so this block is
    // non-terminal and deterministic to retry.
    return blockedEarly("process_change_gate_failed_closed", `${gate.reason}${gate.detail ? ` — ${gate.detail}` : ""}`, {
      gate: { gate_report_id: gate.gate_report_id, reason: gate.reason },
    });
  }

  // 12. Deterministic advisory labels over gate facts (rubrics above).
  const evidenceQuality = deriveEvidenceQualityLabel({ gate });
  const promotionRisk = derivePromotionRiskLabel({
    gate,
    receiptState,
    policy,
    candidateKind,
    phoenixNativeRegistered: hasRegisterAmendment,
  });

  // 13. Normalized envelope + idempotency key (CONSTRAINTS #11).
  const evidenceIdsForEnvelope = {
    experiments: [experiment.id],
    datasets: [{
      dataset_id: receiptDataset.dataset_id,
      dataset_version_id: receiptDataset.dataset_version_id,
    }],
    annotations: resolvedAnnotationIds,
    prompt_versions: receiptPromptVersionId ? [receiptPromptVersionId] : [],
  };
  const { envelope, hash: envelopeHash } = computeNormalizedEnvelope({
    candidateTargetKey,
    candidateVersionId,
    acceptedBaselineId,
    policyHash,
    evidenceIds: evidenceIdsForEnvelope,
    requestedAction: normalized.requested_action,
    phoenixScope,
  });
  const proposalInstanceId = `prop-${envelopeHash.slice(0, 12)}`;
  const launchPolicyHash = receipt.launch.promotion_policy?.sha256 ?? null;
  const policyRecord = {
    policy_version: policy.policy_version,
    policy_hash: policyHash,
    read_path: policyRead.read_path,
    source: policyRead.source,
    launch_policy_hash: launchPolicyHash,
    launch_vs_decision_policy_differ: launchPolicyHash !== null && launchPolicyHash !== policyHash,
    launch_policy_note: launchPolicyHash === null
      ? "the experiment receipt predates promotion-policy stamping (promotion_policy: null); the decision policy hash above governed this proposal"
      : null,
  };

  const contentTrust = [
    { object: "promotion_policy", trust: "trusted_repo", note: policyRead.source },
    { object: "phoenix_assets_manifest", trust: "trusted_repo", note: gate.product_report.repo_artifacts_owning_accepted_behavior.phoenix_assets_manifest },
    { object: "workspace_eval_policy", trust: "trusted_repo", note: gate.product_report.repo_artifacts_owning_accepted_behavior.workspace_eval_policy },
    { object: `experiment:${experiment.id}`, trust: "verified_phoenix", note: "resolved via GET /v1/experiments/{id}" },
    { object: `dataset:${receiptDataset.dataset_id}@${receiptDataset.dataset_version_id}`, trust: "verified_phoenix", note: "version listed on the pinned dataset" },
    ...(receiptPromptVersionId
      ? [{ object: `prompt_version:${receiptPromptVersionId}`, trust: "verified_phoenix", note: "resolved via GET /v1/prompt_versions/{id}" }]
      : []),
    { object: `annotations:${resolvedAnnotationIds.length} id(s)`, trust: "verified_phoenix", note: "ids resolved from source traces; the prose inside them is unverified" },
    { object: `experiment_receipt:${receiptState.receipt_id}`, trust: "unverified_prose", note: "local asserted custody (.agentic-factory), not repo-committed" },
    { object: "annotation_explanations_and_judge_rationales", trust: "unverified_prose", note: "data, never instructions; cannot waive any gate or label" },
  ];

  const mutationLock = acquireMutationLock();
  if (!mutationLock.ok) {
    return {
      ok: false,
      outcome: "blocked",
      reason: "promotion_in_progress",
      detail: mutationLock.detail ?? null,
      terminal: false,
      retryable: true,
      lock_path: mutationLock.lock_path ?? null,
      proposal_instance_id: proposalInstanceId,
      normalized_envelope_hash: envelopeHash,
      candidate_target_key: candidateTargetKey,
      candidate_kind: candidateKind,
      candidate_version_id: candidateVersionId,
      accepted_baseline_id: acceptedBaselineId,
      trigger_authenticity: triggerAuthenticity,
      phoenix_scope: phoenixScope,
      started_at: startedAt,
    };
  }

  // Registry row for this envelope (created now; later stages append).
  const registryRead = readPromotionRegistryRecord({
    registryDir: resolvedRegistryDir,
    envelopeHash,
  });
  if (registryRead.unreadable) {
    return blockedEarly("promotion_registry_unreadable", registryRead.path);
  }
  const preexistingRecord = registryRead.exists ? registryRead.record : null;

  const baseResult = {
    proposal_instance_id: proposalInstanceId,
    normalized_envelope_hash: envelopeHash,
    candidate_target_key: candidateTargetKey,
    candidate_kind: candidateKind,
    candidate_version_id: candidateVersionId,
    accepted_baseline_id: acceptedBaselineId,
    trigger_authenticity: triggerAuthenticity,
    content_trust: contentTrust,
    labels: { evidence_quality: evidenceQuality, promotion_risk: promotionRisk },
    policy: policyRecord,
    evidence_ids: envelope.evidence_ids,
    evidence_counts: gate.evidence_counts,
    phoenix_scope: phoenixScope,
    gate: {
      gate_report_id: gate.gate_report_id,
      verdict: gate.verdict,
      failed_condition_ids: gate.failed_condition_ids,
    },
    evidence_lineage: gate.evidence_lineage ?? null,
    receipt_id: receiptState.receipt_id,
    registry_path: registryRead.path,
    started_at: startedAt,
  };

  const ensureRegistryRow = () => {
    const existing = readPromotionRegistryRecord({
      registryDir: resolvedRegistryDir,
      envelopeHash,
    });
    if (existing.exists && existing.record) return existing.record;
    const record = {
      schema_version: PROMOTION_REGISTRY_SCHEMA_VERSION,
      normalized_envelope_hash: envelopeHash,
      proposal_instance_id: proposalInstanceId,
      candidate_target_key: candidateTargetKey,
      candidate_kind: candidateKind,
      candidate_version_id: candidateVersionId,
      accepted_baseline_id: acceptedBaselineId,
      receipt_id: receiptState.receipt_id,
      phoenix_scope: phoenixScope,
      evidence_ids: envelope.evidence_ids,
      policy: policyRecord,
      labels: { evidence_quality: evidenceQuality.label, promotion_risk: promotionRisk.label },
      gate_report_id: gate.gate_report_id,
      branch: null,
      proposal_relative_path: null,
      commit_sha: null,
      pr: null,
      outcome: null,
      repair_state: null,
      last_stage: "validated",
      events: [{ stage: "validated", at: now().toISOString() }],
    };
    writeRegistryFile(registryRead.path, record);
    return record;
  };

  const appendStage = (stage, detail = {}, patch = {}) =>
    appendRegistryStage({
      registryDir: resolvedRegistryDir,
      envelopeHash,
      stage,
      detail,
      patch,
      now,
    });

  // Terminal blocked outcome: durable registry row + Phoenix outcome
  // annotation (label blocked), per "outcome annotations only after PR
  // created/blocked".
  const finalizeBlocked = async (reason, detail = null, extra = {}) => {
    ensureRegistryRow();
    appendStage("blocked", { reason, ...(detail ? { detail } : {}) }, {
      outcome: { outcome: "blocked", reason, detail },
    });
    const observation = await recordPhoenixOutcomeObservation({
      appUrl,
      projectName: configuredProject,
      fetchImpl,
      label: "blocked",
      proposalInstanceId,
      candidateTargetKey,
      repoReviewUrl: null,
      normalizedEnvelopeHash: envelopeHash,
      now,
    });
    if (observation.recorded) {
      appendStage("phoenix_outcome_recorded", { trace_id: observation.trace_id }, {
        phoenix_outcome: observation,
        repair_state: "none",
      });
    } else {
      appendStage("blocked", { phoenix_outcome_failed: observation.reason }, {
        phoenix_outcome: observation,
        repair_state: "phoenix_audit_retry_needed",
      });
    }
    return {
      ok: false,
      outcome: "blocked",
      reason,
      ...(detail ? { detail } : {}),
      terminal: true,
      phoenix_outcome: observation,
      ...extra,
      ...baseResult,
    };
  };

  // Transient/infrastructure blocks: durable event, NO outcome annotation
  // (the envelope has not reached a terminal controller decision; recovery
  // resumes from the last durable stage).
  const blockedRetryable = (reason, detail = null, extra = {}, patch = {}) => {
    ensureRegistryRow();
    appendStage(
      readPromotionRegistryRecord({ registryDir: resolvedRegistryDir, envelopeHash }).record.last_stage,
      { retryable_block: reason, ...(detail ? { detail } : {}) },
      patch,
    );
    return {
      ok: false,
      outcome: "blocked",
      reason,
      ...(detail ? { detail } : {}),
      terminal: false,
      retryable: true,
      ...extra,
      ...baseResult,
    };
  };

  const finalizeImprovementOpportunity = ({ materializerResult, target }) => {
    ensureRegistryRow();
    const phoenixDeepLinks = buildPhoenixDeepLinksFromEvidenceIds({
      evidenceIds: envelope.evidence_ids,
      configuredOrigin,
    });
    const evidenceRefs = buildEvidenceRefsFromEnvelope({ envelope, phoenixDeepLinks });
    const opportunity = {
      status: "improvement_opportunity",
      target: candidateTargetKey,
      human_name: humanNameForTarget(target, candidateTargetKey),
      summary: materializerResult.summary,
      failure_mode_labels: failureModesForPr.map((mode) => mode.label),
      next_action: materializerResult.nextAction || "draft_proposed_change",
      suggested_draft_prompt: materializerResult.suggestedDraftPrompt,
      pr_opened: false,
      evidence_refs: evidenceRefs,
    };
    appendStage("improvement_opportunity", opportunity, {
      outcome: {
        outcome: "blocked",
        reason: "improvement_opportunity_no_proposed_change",
        detail: materializerResult.reason ?? null,
      },
      improvement_opportunity: opportunity,
      repair_state: "none",
    });
    return {
      ok: false,
      outcome: "blocked",
      reason: "improvement_opportunity_no_proposed_change",
      detail: materializerResult.reason ?? null,
      terminal: true,
      improvement_opportunity: opportunity,
      ...baseResult,
    };
  };

  let githubSelection = null;
  const selectGitHub = () => {
    if (!githubSelection) {
      githubSelection = githubTransport
        ? { transport: githubTransport, brokerClient: null, mode: githubTransport.kind || "test_harness" }
        : createProductionGitHubPromotionTransport({ repoRoot, repoIdentity, now });
    }
    return githubSelection;
  };
  const createSelectedGitHubClient = () =>
    createGitHubPromotionClient({
      transport: selectGitHub().transport,
      repo: githubRepo,
    });
  const markerPacketStatusPassed = (marker) =>
    marker?.packet?.source === "structured_packet"
    && marker.packet.guard_status === "passed";
  const markerNeedsPacketRepair = (marker) => {
    if (!marker || marker.proposal_state === "superseded") return false;
    if (marker.repair_state && !["none", PACKET_COMPLETENESS_REPAIR_STATE].includes(marker.repair_state)) {
      return false;
    }
    return marker.proposal_state === "blocked"
      || marker.repair_state === PACKET_COMPLETENESS_REPAIR_STATE
      || !markerPacketStatusPassed(marker);
  };
  const existingPacketRepairGuard = () => ({
    ok: false,
    status: "blocked",
    reason: PACKET_COMPLETENESS_GUARD_REASON,
    repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
    copy_class: "blocked_for_repair",
    owner_copy: ownerCopyForPacketCompletenessRepair(),
    failed_checks: [{
      id: "existing_pr_packet_guard_not_passed",
      message:
        "The existing PR was opened before a passing packet-completeness marker was recorded.",
    }],
  });
  const blockExistingPrForPacketRepair = async ({ pr, marker }) => {
    const guard = existingPacketRepairGuard();
    const patch = {
      repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
      packet_guard: promotionPacketGuardRegistryRecord(guard),
    };
    try {
      const repairGithub = createSelectedGitHubClient();
      let currentBody = typeof pr?.body === "string" ? pr.body : null;
      if (currentBody === null && pr?.number) {
        currentBody = (await repairGithub.getPullRequest({ number: pr.number }))?.data?.body ?? null;
      }
      if (typeof currentBody === "string") {
        await repairGithub.updatePullRequestBody({
          number: pr.number,
          body: markPromotionPrBodyBlockedForRepair({
            body: currentBody,
            marker,
            ownerCopy: guard.owner_copy,
          }),
        });
      }
    } catch (error) {
      return blockedRetryable(
        "packet_completeness_repair_marker_update_failed",
        error.message,
        {
          pr: pr?.number ? { number: pr.number, url: pr.html_url ?? null, reused: true } : null,
          repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
          packet_guard: guard,
        },
        patch,
      );
    }
    return blockedRetryable(
      PACKET_COMPLETENESS_GUARD_REASON,
      guard.owner_copy,
      {
        pr: pr?.number ? { number: pr.number, url: pr.html_url ?? null, reused: true } : null,
        repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
        packet_guard: guard,
      },
      patch,
    );
  };
  const validatePreexistingRegistryPrForReuse = async () => {
    const selection = selectGitHub();
    if (registryPrRecordStaleInCurrentMode({ selection, record: preexistingRecord })) {
      return { ok: false, reason: "registry_pr_dry_run_record_in_real_mode" };
    }
    if (!registryPrReuseNeedsLiveValidation({ selection, record: preexistingRecord })) {
      return { ok: true };
    }
    return validateRegistryRecordedPullRequest({
      github: createSelectedGitHubClient(),
      record: preexistingRecord,
      envelopeHash,
    });
  };

  // 14. Duplicate-envelope reuse from the durable registry (CONSTRAINTS #11):
  // a terminal row short-circuits everything below — no duplicate artifacts,
  // PRs, or outcome annotations. A row stuck after commit resumes.
  if (preexistingRecord?.outcome?.outcome === "blocked" && !registryBlockedOutcomeIsRetryable(preexistingRecord)) {
    if (preexistingRecord.outcome.reason === "improvement_opportunity_no_proposed_change") {
      trustedArtifacts = resolveTrustedPromotionArtifacts({
        mode: policyMode,
        repoRoot,
        candidateTargetKey,
        internalCloneDir: workspaceDir
          ? path.join(workspaceDir, "repo")
          : path.join(defaultPromotionWorkspaceDir(repoRoot), "repo"),
        runGit,
      });
      if (!trustedArtifacts.ok) {
        return blockedRetryable(trustedArtifacts.reason, trustedArtifacts.detail ?? null);
      }
      const materializerAvailability = resolveMaterializerTarget({
        manifest: trustedArtifacts.manifest,
        candidateTargetKey,
      });
      if (materializerAvailability.ok) {
        onProgress(
          `NOTE prior improvement opportunity for ${candidateTargetKey} now has a materializer; continuing the same envelope instead of reusing the opportunity block.`,
        );
      } else {
        return {
          ok: false,
          outcome: "blocked",
          reason: preexistingRecord.outcome.reason,
          detail: preexistingRecord.outcome.detail ?? null,
          terminal: true,
          idempotent_reuse: true,
          improvement_opportunity: preexistingRecord.improvement_opportunity ?? null,
          ...baseResult,
        };
      }
    } else {
      return {
        ok: false,
        outcome: "blocked",
        reason: preexistingRecord.outcome.reason,
        detail: preexistingRecord.outcome.detail ?? null,
        terminal: true,
        idempotent_reuse: true,
        ...baseResult,
      };
    }
  }
  if (
    preexistingRecord?.pr?.number
    && preexistingRecord?.phoenix_outcome?.recorded
    && preexistingRecord?.repair_state !== "supersede_retry_needed"
  ) {
    const registryPrLive = await validatePreexistingRegistryPrForReuse();
    if (registryPrValidationShouldFailClosed(registryPrLive)) {
      return blockedRetryable(registryPrLive.reason, registryPrLive.detail ?? null);
    }
    if (registryPrLive.ok) {
      if (!registryPrLive.marker && preexistingRecord?.packet_guard?.status !== "passed") {
        return blockedRetryable(
          PACKET_COMPLETENESS_GUARD_REASON,
          ownerCopyForPacketCompletenessRepair(),
          { repair_state: PACKET_COMPLETENESS_REPAIR_STATE },
          { repair_state: PACKET_COMPLETENESS_REPAIR_STATE },
        );
      }
      if (registryPrLive.marker && markerNeedsPacketRepair(registryPrLive.marker)) {
        return blockExistingPrForPacketRepair({
          pr: registryPrLive.pr,
          marker: registryPrLive.marker,
        });
      }
      return {
        ok: true,
        outcome: "route_to_hitl",
        idempotent_reuse: true,
        branch: preexistingRecord.branch,
        commit_sha: preexistingRecord.commit_sha,
        proposal_relative_path: preexistingRecord.proposal_relative_path,
        pr: preexistingRecord.pr,
        phoenix_outcome: preexistingRecord.phoenix_outcome,
        dry_run: Boolean(preexistingRecord.pr.dry_run),
        ...baseResult,
      };
    }
  }
  if (
    preexistingRecord?.pr?.number
    && !preexistingRecord?.phoenix_outcome?.recorded
    && preexistingRecord?.repair_state !== "supersede_retry_needed"
  ) {
    const registryPrLive = await validatePreexistingRegistryPrForReuse();
    if (registryPrValidationShouldFailClosed(registryPrLive)) {
      return blockedRetryable(registryPrLive.reason, registryPrLive.detail ?? null);
    }
    if (!registryPrLive.ok) {
      // Stale local registry state is not authoritative. Continue into the
      // repo-visible marker evaluation below, which handles rejection memory,
      // missing markers, and recreation from live GitHub state.
    } else {
      if (!registryPrLive.marker && preexistingRecord?.packet_guard?.status !== "passed") {
        return blockedRetryable(
          PACKET_COMPLETENESS_GUARD_REASON,
          ownerCopyForPacketCompletenessRepair(),
          { repair_state: PACKET_COMPLETENESS_REPAIR_STATE },
          { repair_state: PACKET_COMPLETENESS_REPAIR_STATE },
        );
      }
      if (registryPrLive.marker && markerNeedsPacketRepair(registryPrLive.marker)) {
        return blockExistingPrForPacketRepair({
          pr: registryPrLive.pr,
          marker: registryPrLive.marker,
        });
      }
      // PR exists but the Phoenix audit write failed earlier: retry ONLY the
      // outcome write (repo artifact stays authoritative; CONSTRAINTS #16).
      const retried = await recordPhoenixOutcomeObservation({
        appUrl,
        projectName: configuredProject,
        fetchImpl,
        label: "route_to_hitl",
        proposalInstanceId,
        candidateTargetKey,
        repoReviewUrl: preexistingRecord.pr.url ?? null,
        normalizedEnvelopeHash: envelopeHash,
        now,
      });
      if (retried.recorded) {
        appendStage("phoenix_outcome_recorded", { trace_id: retried.trace_id, retried: true }, {
          phoenix_outcome: retried,
          repair_state: "none",
        });
        // Outside-review FIX 7: the repaired audit state is reflected back into
        // the repo artifact best-effort — the PR body marker returns to
        // repair_state none via the allowlisted update-body endpoint.
        try {
          const repairGithub = createSelectedGitHubClient();
          const current = await repairGithub.getPullRequest({ number: preexistingRecord.pr.number });
          const currentBody = current?.data?.body;
          if (typeof currentBody === "string") {
            const clearedBody = updateMarkerInBody(currentBody, { repair_state: "none" });
            if (clearedBody !== currentBody) {
              await repairGithub.updatePullRequestBody({
                number: preexistingRecord.pr.number,
                body: clearedBody,
              });
            }
          }
        } catch {
          // Best-effort: the registry already records the completed repair.
        }
      }
      return {
        ok: true,
        outcome: "route_to_hitl",
        idempotent_reuse: true,
        branch: preexistingRecord.branch,
        commit_sha: preexistingRecord.commit_sha,
        proposal_relative_path: preexistingRecord.proposal_relative_path,
        pr: preexistingRecord.pr,
        phoenix_outcome: retried,
        dry_run: Boolean(preexistingRecord.pr.dry_run),
        ...baseResult,
      };
    }
  }

  // 15. Gate verdict fail -> terminal blocked (the mechanical gate cannot be
  // waived by any label or prose; CONSTRAINTS #17/#34).
  if (gate.verdict !== "pass") {
    return finalizeBlocked(
      "process_change_gate_failed",
      `failed condition(s): ${gate.failed_condition_ids.join(", ")} (gate report ${gate.gate_report_id})`,
    );
  }

  if (!trustedArtifacts) {
    trustedArtifacts = resolveTrustedPromotionArtifacts({
      mode: policyMode,
      repoRoot,
      candidateTargetKey,
      internalCloneDir: workspaceDir
        ? path.join(workspaceDir, "repo")
        : path.join(defaultPromotionWorkspaceDir(repoRoot), "repo"),
      runGit,
    });
  }
  if (!trustedArtifacts.ok) {
    return blockedRetryable(trustedArtifacts.reason, trustedArtifacts.detail ?? null);
  }
  // 16. Standalone evidence summary THROUGH the content gate.
  const summaryPayload = buildEvidenceSummaryPayload({ gate, evidence });
  const gated = sanitizeAndClassifyContent({
    value: summaryPayload,
    policy: PR_EVIDENCE_SUMMARY_CONTENT_POLICY,
    label: "pr_evidence_summary",
  });
  if (!gated.ok) {
    const reason = gated.state === "cannot_promote"
      ? "evidence_summary_content_rejected"
      : "evidence_summary_needs_sanitization";
    return finalizeBlocked(
      reason,
      gated.state === "cannot_promote"
        ? `token/secret-shaped content at: ${gated.secret_paths.join(", ")} — secrets are never sanitized through (sanitizer report: ${JSON.stringify(gated.report)})`
        : `unclassified content at: ${gated.unclassified_paths.join(", ")}`,
    );
  }
  const summary = gated.value;
  const sanitizerReport = gated.report;
  const renderedEvidenceSummary = buildPromotionEvidenceSummaryLines({ summary, sanitizerReport });

  // 17. Repo-side dedupe from PR markers (CONSTRAINTS #10): open + closed-
  // unmerged PRs by candidate target inside the policy lookback; budgets and
  // caps derive from repo-visible markers, never the local ledger.
  let github;
  let openPrs;
  let closedPrs;
  try {
    github = createSelectedGitHubClient();
    openPrs = (await github.listOpenPullRequests())?.data || [];
    closedPrs = (await github.listClosedPullRequests())?.data || [];
  } catch (error) {
    const normalizedGitHubError = String(error.message || "").toLowerCase().replace(/\s+/g, "_");
    const reason = /github_pr_listing_truncated|pr_listing_truncated/.test(normalizedGitHubError)
      ? "github_pr_listing_truncated"
      : /github.*broker|github_token_broker|github_broker|github_transport/.test(normalizedGitHubError)
      ? "github_transport_unavailable"
      : "github_pr_listing_failed";
    return blockedRetryable(reason, error.message);
  }
  const nowMs = now().getTime();
  const lookbackMs = policy.lookback_days * 24 * 60 * 60 * 1000;
  // Outside-review FIX 5: a PR in the controller branch namespace whose marker
  // is missing/corrupted/unreadable CANNOT be silently ignored — dedupe,
  // rejection memory, and budgets would all silently skip it. Per the plan row
  // for "controller cannot find machine-readable promotion markers", the
  // controller fails closed until a human repairs or closes that PR.
  // Non-controller PRs (docs, features, dependabot) carry no marker and are
  // ignored as before.
  const markerStates = (prs) => prs.map((pr) => ({ pr, read: readPromotionMarker(pr?.body) }));
  const openStates = markerStates(openPrs);
  const closedStates = markerStates(closedPrs);
  const unreadableNamespacePrs = [...openStates, ...closedStates].filter(
    ({ pr, read }) => read.status !== "ok" && controllerNamespacePr(pr),
  );
  if (unreadableNamespacePrs.length > 0) {
    return blockedRetryable(
      "promotion_marker_unreadable",
      `controller-namespace PR(s) without a readable machine-readable promotion marker: ${unreadableNamespacePrs
        .map(({ pr, read }) => `#${pr.number} (${read.status}${read.reason ? `: ${read.reason}` : ""})`)
        .join(", ")} — dedupe/rejection-memory/budget state cannot be trusted, so the controller fails closed until a human repairs or closes them (CONSTRAINTS #10).`,
    );
  }
  const withMarkers = (states) =>
    states
      .filter(({ pr, read }) => read.status === "ok" && controllerNamespacePr(pr))
      .map(({ pr, read }) => ({ pr, marker: read.marker }));
  const openMarkers = withMarkers(openStates);
  const closedMarkers = withMarkers(closedStates);
  const unguardedOpenMarker = openMarkers.find((entry) => markerNeedsPacketRepair(entry.marker));
  if (unguardedOpenMarker) {
    return blockExistingPrForPacketRepair({
      pr: unguardedOpenMarker.pr,
      marker: unguardedOpenMarker.marker,
    });
  }
  const supersedeTargetsForCurrentEnvelope = () => openMarkers.filter(
    (entry) =>
      entry.marker.candidate_target_key === candidateTargetKey
      && entry.marker.normalized_envelope_hash !== envelopeHash
      && entry.marker.proposal_state === "proposed",
  );

  const sameEnvelopeOpen = openMarkers.find(
    (entry) => entry.marker.normalized_envelope_hash === envelopeHash,
  );
  if (sameEnvelopeOpen) {
    if (markerNeedsPacketRepair(sameEnvelopeOpen.marker)) {
      return blockExistingPrForPacketRepair({
        pr: sameEnvelopeOpen.pr,
        marker: sameEnvelopeOpen.marker,
      });
    }
    const superseded = [];
    for (const entry of supersedeTargetsForCurrentEnvelope()) {
      try {
        const updatedBody = updateMarkerInBody(entry.pr.body, {
          proposal_state: "superseded",
          superseded_by: proposalInstanceId,
        });
        await github.updatePullRequestBody({ number: entry.pr.number, body: updatedBody });
        const observation = await recordPhoenixOutcomeObservation({
          appUrl,
          projectName: configuredProject,
          fetchImpl,
          label: "superseded",
          proposalInstanceId: entry.marker.proposal_instance_id,
          candidateTargetKey,
          repoReviewUrl: entry.pr.html_url ?? null,
          normalizedEnvelopeHash: entry.marker.normalized_envelope_hash,
          now,
        });
        superseded.push({
          pr_number: entry.pr.number,
          proposal_instance_id: entry.marker.proposal_instance_id,
          phoenix_outcome_recorded: observation.recorded,
        });
      } catch (error) {
        superseded.push({ pr_number: entry.pr.number, error: error.message });
      }
    }
    const supersedeFailures = superseded.filter((entry) => entry.error);
    if (supersedeFailures.length > 0) {
      const detail = supersedeRepairDetail({
        createdPrNumber: sameEnvelopeOpen.pr.number,
        failures: supersedeFailures,
      });
      return blockedRetryable(
        "supersede_repair_needed",
        detail,
        {
          pr: {
            number: sameEnvelopeOpen.pr.number,
            url: sameEnvelopeOpen.pr.html_url ?? null,
            reused: true,
          },
          superseded,
          repair_state: "supersede_retry_needed",
        },
        { repair_state: "supersede_retry_needed" },
      );
    }
    ensureRegistryRow();
    appendStage("pr_created", { reused_existing_pr: sameEnvelopeOpen.pr.number }, {
      pr: {
        number: sameEnvelopeOpen.pr.number,
        url: sameEnvelopeOpen.pr.html_url ?? null,
        dry_run: Boolean(sameEnvelopeOpen.pr.dry_run),
        reused: true,
      },
      repair_state: "none",
      packet_guard: {
        status: "passed",
        reason: null,
        repair_state: "none",
        owner_copy: null,
        failed_checks: [],
      },
    });
    return {
      ok: true,
      outcome: "route_to_hitl",
      idempotent_reuse: true,
      pr: {
        number: sameEnvelopeOpen.pr.number,
        url: sameEnvelopeOpen.pr.html_url ?? null,
        reused: true,
      },
      superseded,
      ...baseResult,
    };
  }

  // Closed-unmerged same-target markers are HUMAN REJECTION MEMORY unless the
  // marker says superseded/blocked. MATERIALITY RULE (documented): only an
  // append-only register amendment dated after the rejection that joins a
  // different experiment identity re-opens the target; a merely newer local
  // timestamp or same-evidence reclassification does NOT.
  const rejectionMemory = closedMarkers.filter((entry) =>
    entry.marker.candidate_target_key === candidateTargetKey
    && !entry.pr.merged_at
    && !["superseded", "blocked"].includes(entry.marker.proposal_state)
    && (!entry.pr.closed_at || nowMs - new Date(entry.pr.closed_at).getTime() <= lookbackMs));
  if (rejectionMemory.length > 0) {
    const latestRejection = rejectionMemory
      .map((entry) => entry.pr.closed_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    const amendments = receipt.amendments || [];
    const materiallyNew = postRejectionRegisterSuppliesNewEvidence({
      amendments,
      latestRejection,
      currentExperimentId: experiment.id,
      currentEnvelopeHash: envelopeHash,
      rejectionMemory,
    });
    if (!materiallyNew) {
      return finalizeBlocked(
        "suppressed_by_human_rejection",
        `a human closed PR #${rejectionMemory[0].pr.number} for candidate target ${candidateTargetKey} without merging (marker state "${rejectionMemory[0].marker.proposal_state}"); the target stays suppressed inside the ${policy.lookback_days}-day lookback unless a post-rejection register amendment joins a different experiment identity as materially new evidence.`,
      );
    }
    onProgress(
      `NOTE human rejection memory for ${candidateTargetKey} overridden by a post-rejection register amendment with a different experiment identity (materially new evidence).`,
    );
  }

  // Budget/caps from repo-visible markers (local ledger is only a cache).
  const activeOpenMarkers = openMarkers.filter(
    (entry) => entry.marker.proposal_state !== "superseded",
  );
  if (activeOpenMarkers.length >= policy.max_open_proposals) {
    return finalizeBlocked(
      "max_open_proposals_reached",
      `${activeOpenMarkers.length} open controller proposal(s) already exist (max_open_proposals: ${policy.max_open_proposals}); close or merge existing proposals first.`,
    );
  }
  const periodMs = policy.proposal_budget.period_days * 24 * 60 * 60 * 1000;
  const recentProposals = [...openMarkers, ...closedMarkers].filter(
    (entry) => entry.pr.created_at && nowMs - new Date(entry.pr.created_at).getTime() <= periodMs,
  );
  if (recentProposals.length >= policy.proposal_budget.max_proposals) {
    return finalizeBlocked(
      "proposal_budget_exhausted",
      `${recentProposals.length} proposal(s) were opened in the last ${policy.proposal_budget.period_days} day(s) (budget: ${policy.proposal_budget.max_proposals}).`,
    );
  }
  const supersedeTargets = supersedeTargetsForCurrentEnvelope();

  ensureRegistryRow();
  appendStage("gate_evaluated", { gate_report_id: gate.gate_report_id, verdict: gate.verdict });

  const policyWithTaxonomy = { ...policy, failure_taxonomy: trustedArtifacts.taxonomy };
  const failureModesForPr = validatedFailureModes({
    gateReport: gate,
    taxonomy: trustedArtifacts.taxonomy,
  });
  const validatedFailureModeIds = failureModesForPr.map((mode) => mode.id);
  const materializerResult = await materializePromotionCandidateImpl({
    candidateTargetKey,
    candidateKind,
    candidateVersionId,
    acceptedBaselineId,
    resolvedCandidate,
    currentAcceptedSnapshotContent: trustedArtifacts.currentAcceptedSnapshotContent,
    manifestContent: trustedArtifacts.manifestContent,
    policy: policyWithTaxonomy,
    manifest: trustedArtifacts.manifest,
    gateReport: gate,
    fetchImpl,
    resolvedReceipt: receipt,
  });
  if (materializerResult?.kind === "improvement_opportunity") {
    return finalizeImprovementOpportunity({
      materializerResult,
      target: materializerTarget.ok
        ? materializerTarget.target
        : findManifestTarget(trustedArtifacts.manifest, candidateTargetKey),
    });
  }
  if (materializerResult?.kind === "blocked") {
    if (materializerResult.blockClass === "evidence_repair") {
      return blockedRetryable(
        materializerResult.reason,
        materializerResult.detail ?? null,
        { evidence_repair: true },
      );
    }
    // Carry the materializer's terminal metadata (blockClass + scope) onto the
    // blocked outcome so a factory-behavior block — e.g. a judge runtime/model
    // override rejected by the single self-improvement authority — is auditable
    // as such instead of being flattened to a bare reason.
    return finalizeBlocked(
      materializerResult.reason,
      materializerResult.detail ?? null,
      {
        ...(materializerResult.blockClass ? { block_class: materializerResult.blockClass } : {}),
        ...(materializerResult.scope ? { scope: materializerResult.scope } : {}),
      },
    );
  }
  if (materializerResult?.kind !== "behavior_diff") {
    return finalizeBlocked("materializer_result_invalid", "materializer returned no recognized result kind.");
  }
  if (!materializerTarget.ok) {
    return finalizeBlocked(materializerTarget.reason, "behavior_diff materializer result had no resolved target.");
  }
  const behaviorDiffValidation = validateBehaviorDiff({
    files: materializerResult.files,
    target: materializerTarget.target,
  });
  if (!behaviorDiffValidation.ok) {
    return finalizeBlocked(behaviorDiffValidation.reason, "materialized behavior diff failed controller validation.");
  }

  const metaClassification = classifyMaterializedPromotionFiles({
    files: materializerResult.files,
    beforeFiles: trustedBeforeFilesForClassification({
      target: materializerTarget.target,
      trustedArtifacts,
    }),
    target: materializerTarget.target,
  });
  const writeGuard = resolvePromotionWriteGuard({
    invocation,
    classification: metaClassification,
    activationState: resolvePromotionWriteGuardActivationState({ env }),
  });
  if (writeGuard.mode === "report_only") {
    return blockedRetryable(
      writeGuard.reason,
      ownerCopyForPromotionWriteGuard(writeGuard),
      {
        write_guard: writeGuard,
        meta_change_classification: metaClassification,
      },
      {
        write_guard: writeGuard,
        meta_change_classification: metaClassification,
      },
    );
  }
  if (!writeGuard.allowed) {
    const blocked = await finalizeBlocked(
      writeGuard.reason,
      ownerCopyForPromotionWriteGuard(writeGuard),
    );
    return {
      ...blocked,
      write_guard: writeGuard,
      meta_change_classification: metaClassification,
    };
  }

  // B-UNDO (S-UNDO): the static, proposal-time-knowable undo facts and the
  // post-merge accepted-version reference. `merged_accepted_ref` is sourced from
  // the materializer's NEW snapshot/version (the version this candidate becomes
  // the accepted baseline when merged) — NOT the OLD `acceptedBaselineId` above
  // — so the read-time undo answer (B-READ) joins it against the run-version
  // records. `consumed_downstream` / `reversible` are deliberately NOT persisted
  // here (read-time facts; persisting them now makes them permanently false).
  const markerUndoBounds = buildMarkerUndoBounds({
    humanSummary: materializerResult.humanSummary,
    candidateKind,
  });
  const mergedAcceptedRef = buildMergedAcceptedRef({
    candidateTargetKey,
    humanSummary: materializerResult.humanSummary,
    changedArtifacts: materializerResult.changedArtifacts,
  });
  const marker = buildPromotionMarker({
    proposalInstanceId,
    candidateTargetKey,
    candidateKind,
    candidateVersionId,
    acceptedBaselineId,
    normalizedEnvelopeHash: envelopeHash,
    policyHash,
    phoenixScope,
    evidenceIds: envelope.evidence_ids,
    acceptCrossVersionComparison: normalized.accept_cross_version_comparison,
    proposalState: "proposed",
    supersededBy: null,
    repairState: "none",
    undoBounds: markerUndoBounds,
    mergedAcceptedRef,
    // A-CONTENT-DEMOTE: record the demoted-view advisory (path/prose factory
    // labels) on the marker ONLY when a factory class was actually demoted. The
    // write-guard already cleared any GATING factory class above; this is
    // accountability metadata, not a gate, and is not rendered in the PR body
    // (Phase 6). A purely ordinary change records no advisory (marker stays lean
    // and the template marker grammar is unchanged).
    advisories: markerAdvisoriesFor(metaClassification),
  });
  const disclosure = gate.pr_disclosure;
  const materialDisagreement = disclosure.proceeds_despite_disagreement_requires_rationale;
  const controllerRationale = materialDisagreement
    ? `The controller routes this proposal to human review (the terminal MVP outcome) despite ${disclosure.disagreement_count} disagreement(s) and ${disclosure.judge_attention_count} judge-attention item(s): every conflict is surfaced above with raw records preserved, promotion_risk is ${promotionRisk.label}, and no automated acceptance path exists — a human decides with the conflicts in view.`
    : null;
  const prTitle = buildPromotionPrTitle({
    target: materializerTarget.target,
    validatedFailureModeIds,
  });
  const phoenixDeepLinks = buildPhoenixDeepLinksFromEvidenceIds({
    evidenceIds: envelope.evidence_ids,
    configuredOrigin,
  });
  const proposalPacketDraft = buildPromotionProposalPacket({
    target: materializerTarget.target,
    marker,
    humanSummary: materializerResult.humanSummary,
    gateFacts: {
      verdict: gate.verdict,
      evidence_counts: gate.evidence_counts,
      conditions: gate.conditions,
      evidence_lineage: gate.evidence_lineage,
    },
    evidenceQualityLabel: evidenceQuality,
    promotionRiskLabel: promotionRisk,
    evidenceSummaryLines: renderedEvidenceSummary.evidenceSummaryLines,
    sanitizerReport: renderedEvidenceSummary.sanitizerReport,
    disagreementDisclosure: disclosure,
    candidateContentExcerpt: extractCandidateSnapshotExcerpt({
      materializerFiles: materializerResult.files,
      target: materializerTarget.target,
      resolvedCandidate,
    }),
    phoenixDeepLinks,
    machineAuthorship: receipt.launch?.drafted_by,
    allowedOriginPrefix: configuredOrigin,
  });
  const packetGuard = validatePromotionPacketCompleteness({
    packet: proposalPacketDraft,
    requiredEvidenceIdKinds: policy.required_evidence_id_kinds,
    deterministicGate: {
      ok: gate.verdict === "pass",
      reason: gate.failed_condition_ids?.join(", ") || null,
    },
    evidenceAccess: { ok: true },
    classification: metaClassification,
    approvalAttempt: { attempted: false },
  });
  if (!packetGuard.ok) {
    return blockedRetryable(
      PACKET_COMPLETENESS_GUARD_REASON,
      packetGuard.owner_copy,
      {
        repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
        packet_guard: packetGuard,
      },
      {
        repair_state: PACKET_COMPLETENESS_REPAIR_STATE,
        packet_guard: promotionPacketGuardRegistryRecord(packetGuard),
      },
    );
  }
  const acceptanceDecision = resolvePromotionAcceptancePolicyDecision({
    scope: targetScope,
    packetGuard,
    policy,
  });
  if (acceptanceDecision.decision !== "route_to_hitl") {
    return finalizeBlocked(acceptanceDecision.reason, acceptanceDecision.detail ?? null);
  }
  const prBody = renderPromotionProposalPacketMarkdown(
    applyPromotionPacketGuardStatus(proposalPacketDraft, packetGuard),
  );

  // 18. Internal workspace (dirty gate) + deterministic branch.
  const workspace = ensurePromotionWorkspace({ repoRoot, workspaceDir, runGit });
  if (!workspace.ok) return blockedRetryable(workspace.reason, workspace.detail ?? null);
  const branch = promotionBranchName({ candidateTargetKey, envelopeHash });
  const proposalRelativePath = `${DECOMPOSITION_EVAL_PATHS.proposals}/${proposalInstanceId}.md`;
  const branchAlreadyExists = branchExists({ cloneDir: workspace.cloneDir, branch, runGit });
  if (branchAlreadyExists && !preexistingRecord) {
    // An orphan internal branch with no registry row is surfaced as repair
    // state, never silently retried into duplicates (CONSTRAINTS #16).
    return finalizeBlocked(
      "orphan_promotion_branch_requires_repair",
      `internal branch ${branch} exists but no durable registry row covers envelope ${envelopeHash}; inspect ${workspace.cloneDir} and delete or reconcile the branch before retrying.`,
    );
  }
  if (branchAlreadyExists) {
    const branchEnvelope = verifyPromotionBranchEnvelope({
      cloneDir: workspace.cloneDir,
      branch,
      envelopeHash,
      proposalInstanceId,
      candidateTargetKey,
      proposalRelativePath,
      // Resume integrity: when a prior commit SHA was recorded for this
      // envelope, require the live branch tip still equals it (fails closed on
      // a moved/rewritten branch). Null for envelopes recorded before the field.
      recordedCommitSha: preexistingRecord?.commit_sha ?? null,
      runGit,
    });
    if (!branchEnvelope.verified) {
      const carried = branchEnvelope.method === "proposal_document"
        ? (branchEnvelope.committedMarker
            ? `envelope ${branchEnvelope.committedMarker.normalized_envelope_hash}`
            : "no parseable promotion marker")
        : (branchEnvelope.trailers
            ? `promotion trailers envelope ${branchEnvelope.trailers.envelope}`
            : "malformed promotion commit trailers");
      return finalizeBlocked(
        "branch_envelope_mismatch",
        `internal branch ${branch} carries ${carried}, not the current envelope ${envelopeHash}; the controller never overwrites an existing branch with a different envelope — repair or delete the branch.`,
      );
    }
  }

  // 19. Draft + commit (resume-aware: a registry row at >= committed with the
  // matching branch skips re-drafting).
  let commitSha = preexistingRecord?.commit_sha ?? null;
  const resumeFromCommit = Boolean(commitSha && branchAlreadyExists);
  if (!resumeFromCommit) {
    const checkout = checkoutPromotionBranch({
      cloneDir: workspace.cloneDir,
      branch,
      defaultBranchRef: workspace.defaultBranchRef,
      runGit,
    });
    if (!checkout.ok) return blockedRetryable(checkout.reason, checkout.detail ?? null);
    appendStage("drafted", { materialized_paths: Object.keys(materializerResult.files || {}).sort() }, {
      branch,
      proposal_relative_path: null,
      materialized_paths: Object.keys(materializerResult.files || {}).sort(),
    });
    const commit = commitPromotionDraft({
      cloneDir: workspace.cloneDir,
      files: materializerResult.files,
      message: `promotion proposal ${proposalInstanceId} for ${candidateTargetKey}`,
      normalizedEnvelopeHash: envelopeHash,
      proposalInstanceId,
      candidateTargetKey,
      // POSITIVE path allowlist derived from the resolved target's manifest
      // entry: the commit enforces it against the REAL staged diff, the same
      // set the materializer validates against (one source of truth).
      allowedPaths: allowedPromotionArtifactPaths(materializerTarget.target),
      runGit,
    });
    if (!commit.ok) {
      if (commit.reason === "workflows_dir_diff_blocked"
        || commit.reason === "promotion_path_not_in_allowlist") {
        return finalizeBlocked(commit.reason, commit.detail ?? null);
      }
      return blockedRetryable(commit.reason, commit.detail ?? null);
    }
    commitSha = commit.commit_sha;
    appendStage("committed", { commit_sha: commitSha }, { commit_sha: commitSha, branch });
  } else {
    onProgress(
      `NOTE resuming from durable stage "committed" for envelope ${envelopeHash}: branch ${branch} and commit ${commitSha} already exist; skipping re-draft.`,
    );
  }

  // 20. Push branch (real broker connection) or dry-run push-equivalent, then PR.
  let push;
  if (selectGitHub().brokerClient) {
    try {
      const token = await selectGitHub().brokerClient.mintInstallationToken({
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        permissions: { contents: "write" },
      });
      push = pushPromotionBranchWithInstallationToken({
        cloneDir: workspace.cloneDir,
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        branch,
        token: token.token,
        runGit,
      });
      if (!push.ok) return blockedRetryable(push.reason, push.detail ?? null);
    } catch (error) {
      return blockedRetryable("github_promotion_branch_push_failed", error.message);
    }
  } else {
    push = pushBranchPlaceholder({ branch });
  }
  let createdPr;
  try {
    const baseBranch = workspace.defaultBranchRef.replace(/^origin\//, "");
    const created = await github.createPullRequest({
      title: prTitle,
      head: branch,
      base: baseBranch,
      body: prBody,
      draft: false,
    });
    createdPr = created?.data || null;
    if (!createdPr?.number) throw new Error("github_create_pr_returned_no_number");
  } catch (error) {
    return blockedRetryable("github_pr_creation_failed", error.message);
  }
  const prRecord = {
    number: createdPr.number,
    url: createdPr.html_url ?? null,
    title: createdPr.title ?? prTitle,
    dry_run: selectGitHub().mode === "dry_run" || Boolean(createdPr.dry_run),
    reused: false,
  };
  appendStage("pr_created", { pr_number: prRecord.number }, {
    pr: prRecord,
    packet_guard: promotionPacketGuardRegistryRecord(packetGuard),
  });

  // 21. Supersede older open same-target proposals AFTER the new PR lands:
  // update their marker to proposal_state superseded + superseded_by.
  const superseded = [];
  for (const entry of supersedeTargets) {
    try {
      const updatedBody = updateMarkerInBody(entry.pr.body, {
        proposal_state: "superseded",
        superseded_by: proposalInstanceId,
      });
      await github.updatePullRequestBody({ number: entry.pr.number, body: updatedBody });
      const observation = await recordPhoenixOutcomeObservation({
        appUrl,
        projectName: configuredProject,
        fetchImpl,
        label: "superseded",
        proposalInstanceId: entry.marker.proposal_instance_id,
        candidateTargetKey,
        repoReviewUrl: entry.pr.html_url ?? null,
        normalizedEnvelopeHash: entry.marker.normalized_envelope_hash,
        now,
      });
      superseded.push({
        pr_number: entry.pr.number,
        proposal_instance_id: entry.marker.proposal_instance_id,
        phoenix_outcome_recorded: observation.recorded,
      });
    } catch (error) {
      superseded.push({ pr_number: entry.pr.number, error: error.message });
    }
  }
  const supersedeFailures = superseded.filter((entry) => entry.error);
  if (supersedeFailures.length > 0) {
    const detail = supersedeRepairDetail({
      createdPrNumber: prRecord.number,
      failures: supersedeFailures,
    });
    return blockedRetryable(
      "supersede_repair_needed",
      detail,
      { pr: prRecord, superseded, repair_state: "supersede_retry_needed" },
      { repair_state: "supersede_retry_needed" },
    );
  }

  // 22. Phoenix outcome annotation — ONLY now, after the PR exists. A failed
  // write leaves the repo artifact authoritative + a durable
  // phoenix_audit_retry_needed repair state (CONSTRAINTS #16); re-invoking
  // with the same envelope retries only this write.
  const observation = await recordPhoenixOutcomeObservation({
    appUrl,
    projectName: configuredProject,
    fetchImpl,
    label: "route_to_hitl",
    proposalInstanceId,
    candidateTargetKey,
    repoReviewUrl: prRecord.url,
    normalizedEnvelopeHash: envelopeHash,
    now,
  });
  if (observation.recorded) {
    appendStage("phoenix_outcome_recorded", { trace_id: observation.trace_id }, {
      phoenix_outcome: observation,
      outcome: { outcome: "route_to_hitl", reason: null },
      acceptance_policy_decision: acceptanceDecision,
      repair_state: "none",
    });
  } else {
    // New-style behavior-diff repair custody is PR-body marker + local
    // registry only; behavior files are never recommitted for audit state.
    const repairedPrBody = updateMarkerInBody(prBody, {
      repair_state: "phoenix_audit_retry_needed",
    });
    let repairStateInPrBody = false;
    try {
      await github.updatePullRequestBody({ number: prRecord.number, body: repairedPrBody });
      repairStateInPrBody = true;
    } catch {
      repairStateInPrBody = false;
    }
    appendStage("pr_created", {
      phoenix_outcome_failed: observation.reason,
      repair_state_recorded_in_pr_body: repairStateInPrBody,
    }, {
      phoenix_outcome: observation,
      outcome: { outcome: "route_to_hitl", reason: null },
      acceptance_policy_decision: acceptanceDecision,
      repair_state: "phoenix_audit_retry_needed",
    });
    onProgress(
      "WARNING the Phoenix outcome write failed after the repo artifact was created; the repo artifact is authoritative, phoenix_audit_retry_needed was recorded in the PR body marker and local registry (re-run with the same request to retry the audit write).",
    );
  }

  return {
    ok: true,
    outcome: "route_to_hitl",
    idempotent_reuse: false,
    branch,
    commit_sha: commitSha,
    proposal_relative_path: null,
    pr_title: prTitle,
    pr_body: observation.recorded ? prBody : updateMarkerInBody(prBody, {
      repair_state: "phoenix_audit_retry_needed",
    }),
    proposal_document: observation.recorded ? prBody : updateMarkerInBody(prBody, {
      repair_state: "phoenix_audit_retry_needed",
    }),
    push,
    pr: prRecord,
    superseded,
    sanitizer_report: sanitizerReport,
    controller_rationale: controllerRationale,
    phoenix_outcome: observation,
    dry_run: prRecord.dry_run,
    write_guard: writeGuard,
    meta_change_classification: metaClassification,
    packet_guard: packetGuard,
    acceptance_policy_decision: acceptanceDecision,
    target_scope: targetScope,
    ...baseResult,
  };
}

function trustedBeforeFilesForClassification({ target = {}, trustedArtifacts = {} } = {}) {
  const beforeFiles = {};
  const artifactPath = target.snapshot_path || target.artifact_path;
  if (
    typeof artifactPath === "string"
    && typeof trustedArtifacts.currentAcceptedSnapshotContent === "string"
  ) {
    beforeFiles[artifactPath] = trustedArtifacts.currentAcceptedSnapshotContent;
  }
  const manifestPath = target.manifest_path || DECOMPOSITION_EVAL_PATHS.manifest;
  if (typeof trustedArtifacts.manifestContent === "string") {
    beforeFiles[manifestPath] = trustedArtifacts.manifestContent;
  }
  return beforeFiles;
}
