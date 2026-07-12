import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findBannedWorkflowStateMetadataKeys } from "../eval-annotation-contract.mjs";
import {
  defaultExperimentReceiptDir,
  deriveExperimentReceiptState,
} from "../phoenix-experiment.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import { resolveDefaultBranchRef } from "../promotion-policy.mjs";
import { defaultRunGit } from "../promotion-workspace.mjs";
import { newTraceId } from "../../../../engine/trace-contract.mjs";
import { evalNamespacePaths } from "../../../../engine/eval-namespace.mjs";
import { getWorkflowDefinition } from "../../../../engine/workflow-registry.mjs";
import {
  PROMOTION_OUTCOME_ANNOTATION_NAME,
  PROMOTION_OUTCOME_IDENTIFIER,
  PROMOTION_OUTCOME_LABELS,
  normalizeOrigin,
  phoenixRequestJson,
  validatePhoenixDeepLink,
  waitForPhoenixTraceVisible,
} from "./request-contract.mjs";
import { readJsonTolerant } from "./registry-store.mjs";
import "../trigger-registry.mjs";

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");

function workflowTypeFromTargetKey(candidateTargetKey) {
  const segments = String(candidateTargetKey ?? "").split("/");
  return segments.length >= 3 && segments[1] ? segments[1] : "decomposition";
}

function evalPathsForCandidateTargetKey(candidateTargetKey) {
  const workflowType = workflowTypeFromTargetKey(candidateTargetKey);
  try {
    return evalNamespacePaths(getWorkflowDefinition(workflowType));
  } catch {
    return evalNamespacePaths({
      workflow_type: workflowType,
      eval_namespace: `execution/evals/${workflowType}`,
    });
  }
}

export function findReceiptByExperimentId({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  receiptDir = null,
  experimentId,
} = {}) {
  void repoRoot;
  const dir = receiptDir || defaultExperimentReceiptDir(home);
  if (!fs.existsSync(dir)) return { matches: [] };
  const matches = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const receipt = readJsonTolerant(path.join(dir, name));
    if (receipt?.schema_version !== "teami-managed-experiment-receipt/v1") continue;
    let state;
    try {
      state = deriveExperimentReceiptState(receipt);
    } catch {
      continue;
    }
    if (state.phoenix_experiment_id === experimentId) matches.push({ receipt, state });
  }
  return { matches };
}

// ---------------------------------------------------------------------------
// Phoenix promotion outcome annotation (observability ONLY, never authority —
// CONSTRAINTS #3/#16). Shape pinned by annotation.schema.json
// $defs/promotion_outcome_annotation: label-only, CODE, required provenance
// metadata. Written ONLY after a PR is created or the controller blocks.
// ---------------------------------------------------------------------------

export function buildPromotionOutcomeAnnotationPayload({
  traceId,
  label,
  proposalInstanceId,
  candidateTargetKey,
  repoReviewUrl = null,
  normalizedEnvelopeHash,
  repairState = "none",
} = {}) {
  if (!PROMOTION_OUTCOME_LABELS.includes(label)) {
    throw new Error(`promotion outcome label must be one of ${PROMOTION_OUTCOME_LABELS.join("|")}`);
  }
  const metadata = {
    proposal_instance_id: proposalInstanceId,
    candidate_target_key: candidateTargetKey,
    repo_review_url: repoReviewUrl,
    normalized_envelope_hash: normalizedEnvelopeHash,
    repair_state: repairState,
  };
  const banned = findBannedWorkflowStateMetadataKeys(metadata);
  if (banned.length > 0) {
    throw new Error(`promotion outcome metadata contains workflow-state keys: ${banned.join(",")}`);
  }
  return {
    data: [{
      name: PROMOTION_OUTCOME_ANNOTATION_NAME,
      annotator_kind: "CODE",
      trace_id: traceId,
      result: { label },
      metadata,
      identifier: PROMOTION_OUTCOME_IDENTIFIER,
    }],
  };
}

// Exports one controller span through the documented REST span path and
// attaches the outcome annotation to that trace. Failure is NEVER fatal: the
// repo artifact stays authoritative and the caller records
// phoenix_audit_retry_needed (CONSTRAINTS #16).
export async function recordPhoenixOutcomeObservation({
  appUrl,
  projectName,
  fetchImpl,
  label,
  proposalInstanceId,
  candidateTargetKey,
  repoReviewUrl,
  normalizedEnvelopeHash,
  now,
}) {
  try {
    const traceId = newTraceId();
    const spanId = randomBytes(8).toString("hex");
    const at = now().toISOString();
    const projects = await phoenixRequestJson({
      appUrl,
      pathname: "/v1/projects",
      searchParams: { name: projectName, limit: "10" },
      fetchImpl,
    });
    if (!(projects?.data || []).some((project) => project.name === projectName)) {
      await phoenixRequestJson({
        appUrl,
        pathname: "/v1/projects",
        method: "POST",
        payload: { name: projectName, description: "Teami local traces" },
        fetchImpl,
      });
    }
    await phoenixRequestJson({
      appUrl,
      pathname: `/v1/projects/${encodeURIComponent(projectName)}/spans`,
      method: "POST",
      payload: {
        data: [{
          name: "teami.promote_candidate",
          context: { trace_id: traceId, span_id: spanId },
          span_kind: "CHAIN",
          start_time: at,
          end_time: at,
          status_code: "OK",
          status_message: "",
          attributes: {
            "teami.proposal_instance_id": proposalInstanceId,
            "teami.candidate_target_key": candidateTargetKey,
            "teami.outcome": label,
          },
          events: [],
        }],
      },
      fetchImpl,
    });
    await waitForPhoenixTraceVisible({
      appUrl,
      projectName,
      traceId,
      fetchImpl,
    });
    const payload = buildPromotionOutcomeAnnotationPayload({
      traceId,
      label,
      proposalInstanceId,
      candidateTargetKey,
      repoReviewUrl,
      normalizedEnvelopeHash,
      repairState: "none",
    });
    const body = await phoenixRequestJson({
      appUrl,
      pathname: "/v1/trace_annotations",
      searchParams: { sync: "true" },
      method: "POST",
      payload,
      fetchImpl,
    });
    return {
      recorded: true,
      trace_id: traceId,
      annotation_ids: (body.data || []).map((item) => item.id).filter(Boolean),
      repair_state: "none",
    };
  } catch (error) {
    return { recorded: false, reason: error.message, repair_state: "phoenix_audit_retry_needed" };
  }
}

function activeCheckoutPath(repoRoot, relativePath) {
  const repoRootPath = path.join(repoRoot, ...String(relativePath).split("/"));
  const repoRootControllerPath = path.join(
    repoRoot,
    "execution",
    "integrations",
    "linear",
    "src",
    "promote-candidate.mjs",
  );
  if (fs.existsSync(repoRootPath) || fs.existsSync(repoRootControllerPath)) {
    return repoRootPath;
  }
  return path.join(MODULE_REPO_ROOT, ...String(relativePath).split("/"));
}

function trustedArtifactFailure(relativePath, detail) {
  return {
    ok: false,
    reason: `trusted_artifact_read_failed:${relativePath}`,
    detail,
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readTrustedArtifactText({
  mode,
  repoRoot,
  relativePath,
  internalCloneDir,
  runGit = defaultRunGit,
} = {}) {
  if (mode === "user_invoked") {
    const filePath = activeCheckoutPath(repoRoot, relativePath);
    try {
      const bytes = fs.readFileSync(filePath);
      return {
        ok: true,
        content: bytes.toString("utf8"),
        bytes,
        source: filePath,
        read_path: "user_invoked_active_checkout",
      };
    } catch (error) {
      return trustedArtifactFailure(relativePath, error.message);
    }
  }
  if (mode === "unattended") {
    if (!internalCloneDir || !fs.existsSync(path.join(internalCloneDir, ".git"))) {
      return trustedArtifactFailure(
        relativePath,
        "unattended trusted artifact reads require the internal promotion clone.",
      );
    }
    const head = await resolveDefaultBranchRef({ internalCloneDir, runGit });
    if (!head.ok) return trustedArtifactFailure(relativePath, head.detail || head.reason);
    const show = await runGit(["show", `${head.ref}:${relativePath}`], { cwd: internalCloneDir });
    if (!show.ok) {
      return trustedArtifactFailure(
        relativePath,
        `git show ${head.ref}:${relativePath} failed: ${show.stderr.trim() || show.stdout.trim()}`,
      );
    }
    return {
      ok: true,
      content: show.stdout,
      bytes: Buffer.from(show.stdout, "utf8"),
      source: `${head.ref}:${relativePath}`,
      read_path: "unattended_internal_clone_default_branch_head",
    };
  }
  return trustedArtifactFailure(relativePath, `invalid trusted artifact read mode: ${String(mode)}`);
}

function parseTrustedJsonArtifact({ content, relativePath } = {}) {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    return trustedArtifactFailure(relativePath, error.message);
  }
}

function manifestTargets(manifest) {
  return [
    ...(Array.isArray(manifest?.prompts) ? manifest.prompts : []),
    ...(Array.isArray(manifest?.evaluators) ? manifest.evaluators : []),
    ...(Array.isArray(manifest?.rules) ? manifest.rules : []),
  ];
}

export function findManifestTarget(manifest, candidateTargetKey) {
  return manifestTargets(manifest).find((entry) => entry?.target_key === candidateTargetKey) || null;
}

export async function resolveTrustedPromotionArtifacts({
  mode,
  repoRoot,
  candidateTargetKey,
  internalCloneDir,
  runGit = defaultRunGit,
} = {}) {
  const evalPaths = evalPathsForCandidateTargetKey(candidateTargetKey);
  const manifestRead = await readTrustedArtifactText({
    mode,
    repoRoot,
    relativePath: evalPaths.manifest,
    internalCloneDir,
    runGit,
  });
  if (!manifestRead.ok) return manifestRead;
  const manifestParsed = parseTrustedJsonArtifact({
    content: manifestRead.content,
    relativePath: evalPaths.manifest,
  });
  if (!manifestParsed.ok) return manifestParsed;

  const taxonomyRead = await readTrustedArtifactText({
    mode,
    repoRoot,
    relativePath: evalPaths.taxonomy,
    internalCloneDir,
    runGit,
  });
  if (!taxonomyRead.ok) return taxonomyRead;
  const taxonomyParsed = parseTrustedJsonArtifact({
    content: taxonomyRead.content,
    relativePath: evalPaths.taxonomy,
  });
  if (!taxonomyParsed.ok) return taxonomyParsed;

  const target = findManifestTarget(manifestParsed.value, candidateTargetKey);
  let currentAcceptedSnapshotContent = null;
  let snapshotSource = null;
  const acceptedContentPath = target?.snapshot_path ?? target?.artifact_path;
  if (typeof acceptedContentPath === "string" && acceptedContentPath.trim() !== "") {
    const snapshotRead = await readTrustedArtifactText({
      mode,
      repoRoot,
      relativePath: acceptedContentPath,
      internalCloneDir,
      runGit,
    });
    if (!snapshotRead.ok) return snapshotRead;
    if (typeof candidateTargetKey === "string" && candidateTargetKey.startsWith("rule/")) {
      const artifactSha256 = sha256Hex(snapshotRead.bytes ?? Buffer.from(snapshotRead.content ?? "", "utf8"));
      if (artifactSha256 !== target?.snapshot_sha256) {
        return {
          ok: false,
          reason: "accepted_rule_snapshot_drift",
          detail: `artifact ${acceptedContentPath} hashes to ${artifactSha256} but phoenix-assets.json pins ${target?.snapshot_sha256}.`,
        };
      }
    }
    currentAcceptedSnapshotContent = snapshotRead.content;
    snapshotSource = snapshotRead.source;
  }

  return {
    ok: true,
    manifest: manifestParsed.value,
    manifestContent: manifestRead.content,
    manifestSource: manifestRead.source,
    taxonomy: taxonomyParsed.value,
    taxonomyContent: taxonomyRead.content,
    taxonomySource: taxonomyRead.source,
    // This field also carries rule artifact content for rule targets.
    currentAcceptedSnapshotContent,
    snapshotSource,
  };
}

function collectFailureModeIds(value, ids = []) {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectFailureModeIds(item, ids);
    return ids;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (["failure_modes", "failureModeIds", "failure_mode_ids", "code_failure_modes"].includes(key)
      && Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === "string") ids.push(item);
      }
      continue;
    }
    collectFailureModeIds(nested, ids);
  }
  return ids;
}

function appendTaxonomyModes(modes, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === "string") {
      modes.push({ id: value, label: value });
    } else if (value && typeof value === "object" && typeof value.id === "string") {
      modes.push({ id: value.id, label: typeof value.label === "string" ? value.label : value.id });
    }
  }
}

function taxonomyModeMap(taxonomy) {
  const modes = [];
  appendTaxonomyModes(modes, taxonomy?.structural?.failure_modes);
  for (const workflow of Object.values(taxonomy?.workflows || {})) {
    appendTaxonomyModes(modes, workflow?.failure_modes);
  }
  const result = new Map();
  for (const mode of modes) {
    if (!result.has(mode.id)) result.set(mode.id, { ...mode, order: result.size });
  }
  return result;
}

export function validatedFailureModes({ gateReport, taxonomy } = {}) {
  const modeMap = taxonomyModeMap(taxonomy);
  const seen = new Set();
  const modes = [];
  for (const id of collectFailureModeIds(gateReport)) {
    const entry = modeMap.get(id);
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    modes.push(entry);
  }
  return modes.sort((a, b) => a.order - b.order);
}

export function buildPhoenixDeepLinksFromEvidenceIds({ evidenceIds, configuredOrigin } = {}) {
  const origin = normalizeOrigin(configuredOrigin);
  const links = [];
  const datasetIds = [...(evidenceIds?.datasets || [])]
    .map((entry) => entry?.dataset_id)
    .filter((value) => typeof value === "string" && value.length > 0);
  for (const datasetId of datasetIds) {
    const link = `${origin}/datasets/${datasetId}`;
    if (validatePhoenixDeepLink({ deepLink: link, configuredOrigin: origin }).ok) links.push(link);
  }
  const datasetId = datasetIds[0] ?? null;
  if (datasetId) {
    for (const experimentId of evidenceIds?.experiments || []) {
      if (typeof experimentId !== "string" || experimentId.length === 0) continue;
      const link = `${origin}/datasets/${datasetId}/experiments/${experimentId}`;
      if (validatePhoenixDeepLink({ deepLink: link, configuredOrigin: origin }).ok) links.push(link);
    }
  }
  return [...new Set(links)];
}

export function buildEvidenceRefsFromEnvelope({ envelope, phoenixDeepLinks } = {}) {
  return {
    experiment_ids: [...(envelope?.evidence_ids?.experiments || [])],
    dataset_version_ids: [...(envelope?.evidence_ids?.datasets || [])]
      .map((entry) => entry?.dataset_version_id)
      .filter((value) => typeof value === "string" && value.length > 0),
    annotation_ids: [...(envelope?.evidence_ids?.annotations || [])],
    phoenix_deep_links: [...(phoenixDeepLinks || [])],
  };
}

export function extractCandidateSnapshotExcerpt({ materializerFiles, target, resolvedCandidate } = {}) {
  if (target?.snapshot_path && typeof materializerFiles?.[target.snapshot_path] === "string") {
    return materializerFiles[target.snapshot_path];
  }
  const version = resolvedCandidate?.data && typeof resolvedCandidate.data === "object"
    ? resolvedCandidate.data
    : resolvedCandidate;
  const messages = version?.template?.messages;
  if (!Array.isArray(messages)) return "";
  const systemMessage = messages.find((message) =>
    typeof message?.role === "string" && message.role.replace(/-/g, "_").toUpperCase() === "SYSTEM");
  return typeof systemMessage?.content === "string" ? systemMessage.content : "";
}

export function humanNameForTarget(target, fallback) {
  return typeof target?.human_name === "string" && target.human_name.trim() !== ""
    ? target.human_name
    : fallback;
}
