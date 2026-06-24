import { CANDIDATE_KINDS } from "./request-contract.mjs";
import {
  controllerNamespacePr,
  PROMOTION_MARKER_KEY,
  PROMOTION_MARKER_SENTINEL_BEGIN,
  PROMOTION_MARKER_SENTINEL_END,
} from "../promotion-workspace.mjs";
import {
  defaultPromotionMarkerPacketFacts,
  normalizePromotionMarkerPacketFacts,
  validPromotionMarkerPacketFactsShape,
} from "./proposal-packet-schema.mjs";
import { MARKER_UNDO_BOUNDS_SCHEMA_VERSION } from "./marker-undo-frame.mjs";

export { PROMOTION_MARKER_KEY, PROMOTION_MARKER_SENTINEL_BEGIN, PROMOTION_MARKER_SENTINEL_END };

// ---------------------------------------------------------------------------
// Machine-readable PR marker (CONSTRAINTS #10; Track A template grammar).
//
// SENTINEL-BOUNDED (outside-review FIX 2b): the authentic marker is wrapped in
// controller-owned HTML-comment sentinels and ONLY sentinel-bounded fenced
// JSON is ever parsed. Untrusted prose is escaped before rendering (newlines
// collapsed, backticks escaped, "<" entity-escaped), so adversarial annotation
// text can neither open a fence nor forge a sentinel. If a body carries more
// than one sentinel-bounded marker, the marker is UNREADABLE — the controller
// never picks one.
// The sentinel strings themselves are owned by promotion-workspace.mjs and
// re-exported at the top of this module.
// ---------------------------------------------------------------------------

export function buildPromotionMarker({
  proposalInstanceId,
  candidateTargetKey,
  candidateKind,
  candidateVersionId,
  acceptedBaselineId,
  normalizedEnvelopeHash,
  policyHash,
  phoenixScope,
  evidenceIds,
  acceptCrossVersionComparison = false,
  proposalState = "proposed",
  supersededBy = null,
  repairState = "none",
  packet = defaultPromotionMarkerPacketFacts(),
  advisories = null,
  undoBounds = null,
  mergedAcceptedRef = null,
} = {}) {
  return {
    [PROMOTION_MARKER_KEY]: {
      schema_version: 1,
      proposal_instance_id: proposalInstanceId,
      requested_action: "propose_repo_change",
      candidate_target_key: candidateTargetKey,
      candidate_kind: candidateKind,
      candidate_version_id: candidateVersionId,
      accepted_baseline_id: acceptedBaselineId,
      normalized_envelope_hash: normalizedEnvelopeHash,
      policy_hash: policyHash,
      phoenix_scope: {
        origin: phoenixScope.origin,
        project_name: phoenixScope.project_name,
      },
      evidence_ids: {
        experiments: [...(evidenceIds?.experiments || [])],
        datasets: [...(evidenceIds?.datasets || [])],
        annotations: [...(evidenceIds?.annotations || [])],
      },
      // Request-visible reviewer acceptance of cross-version comparison
      // (outside-review FIX 4): disclosed here so the HITL reviewer sees it.
      accept_cross_version_comparison: Boolean(acceptCrossVersionComparison),
      proposal_state: proposalState,
      superseded_by: supersededBy,
      // Phoenix audit repair status recorded in the repo artifact
      // (outside-review FIX 7; CONSTRAINTS #16).
      repair_state: repairState,
      // PKT-01 structured packet facts. This is a renderer/read-model fact,
      // not a guard verdict; PKT-02 owns guard enforcement.
      packet: normalizePromotionMarkerPacketFacts(packet),
      // A-CONTENT-DEMOTE: the demoted-view advisory (PATH-map + PROMPT-PROSE
      // factory labels that were demoted from a hard block to a non-gating
      // advisory). Recorded on the marker for accountability; NOT rendered in
      // the PR packet body (Phase 6) and NOT a guard verdict.
      ...(advisories ? { advisories } : {}),
      // B-UNDO (S-UNDO): the static, proposal-time-knowable undo facts
      // (`what_undo_changes` + `external_side_effects`). `consumed_downstream` /
      // `reversible` are NOT here — they are read-time facts (B-READ) bounded by
      // the PR's merge time, so persisting them now would make them permanently
      // false.
      ...(undoBounds ? { undo_bounds: undoBounds } : {}),
      // B-UNDO (S-UNDO): the version this candidate BECOMES the accepted
      // baseline when merged, in the same normalized shape as a run-version
      // record's `accepted_refs[]` entry — the join key B-READ uses against the
      // run records. This is the NEW (post-merge) version, NOT the OLD
      // `accepted_baseline_id` above.
      ...(mergedAcceptedRef ? { merged_accepted_ref: mergedAcceptedRef } : {}),
    },
  };
}

export function renderPromotionMarkerBlock(marker) {
  return (
    PROMOTION_MARKER_SENTINEL_BEGIN
    + "\n```json\n"
    + JSON.stringify(marker, null, 2)
    + "\n```\n"
    + PROMOTION_MARKER_SENTINEL_END
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SENTINEL_REGION_PATTERN = new RegExp(
  `${escapeRegExp(PROMOTION_MARKER_SENTINEL_BEGIN)}([\\s\\S]*?)${escapeRegExp(PROMOTION_MARKER_SENTINEL_END)}`,
  "g",
);
const MARKER_FENCE_PATTERN = /```json\s*\n([\s\S]*?)```/g;

function findSentinelRegions(body) {
  if (typeof body !== "string") return [];
  const regions = [];
  SENTINEL_REGION_PATTERN.lastIndex = 0;
  let match;
  while ((match = SENTINEL_REGION_PATTERN.exec(body)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  return regions;
}

function parseMarkersInRegion(inner) {
  const markers = [];
  MARKER_FENCE_PATTERN.lastIndex = 0;
  let match;
  while ((match = MARKER_FENCE_PATTERN.exec(inner)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && parsed[PROMOTION_MARKER_KEY]) {
        markers.push(parsed[PROMOTION_MARKER_KEY]);
      }
    } catch {
      // not a marker block
    }
  }
  return markers;
}

const PROMOTION_MARKER_PROPOSAL_STATES = new Set(["proposed", "superseded", "blocked"]);
const PROMOTION_MARKER_REPAIR_STATES = new Set([
  "none",
  "packet_completeness_repair_needed",
  "evidence_repair_needed",
  "phoenix_audit_retry_needed",
  "supersede_retry_needed",
  "branch_repair_needed",
  "github_connection_repair_needed",
]);
const RETRYABLE_REGISTRY_BLOCK_REASONS = new Set([
  "promotion_marker_unreadable",
  "suppressed_by_human_rejection",
]);
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

// B-UNDO: typed clauses for the static undo frame. The fields are optional
// (older markers and non-undo paths omit them), but when present they must be
// well-formed — a malformed undo frame makes the marker unreadable rather than
// silently trusted.
function validMarkerUndoBoundsShape(undoBounds) {
  if (!undoBounds || typeof undoBounds !== "object" || Array.isArray(undoBounds)) return false;
  if (undoBounds.schema_version !== MARKER_UNDO_BOUNDS_SCHEMA_VERSION) return false;
  if (!nonEmptyString(undoBounds.what_undo_changes)) return false;
  if (typeof undoBounds.external_side_effects !== "boolean") return false;
  return true;
}

function validMergedAcceptedRefShape(ref) {
  // Same normalized shape as a run-version record's `accepted_refs[]` entry
  // (run-accepted-refs.mjs normalizeAcceptedRef): a non-empty target_key plus
  // accepted_baseline_id / snapshot_sha256 that are each a string or null.
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
  if (!nonEmptyString(ref.target_key)) return false;
  if (!stringOrNull(ref.accepted_baseline_id)) return false;
  if (!stringOrNull(ref.snapshot_sha256)) return false;
  return true;
}

function stringOrNull(value) {
  return value === null || typeof value === "string";
}

function validPromotionMarkerShape(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.schema_version !== 1) return false;
  if (marker.requested_action !== "propose_repo_change") return false;
  if (!nonEmptyString(marker.proposal_instance_id)) return false;
  if (!nonEmptyString(marker.candidate_target_key)) return false;
  if (!CANDIDATE_KINDS.includes(marker.candidate_kind)) return false;
  if (!nonEmptyString(marker.candidate_version_id)) return false;
  if (!nonEmptyString(marker.accepted_baseline_id)) return false;
  if (!HEX_SHA256_PATTERN.test(marker.normalized_envelope_hash)) return false;
  if (!nonEmptyString(marker.policy_hash)) return false;
  if (!PROMOTION_MARKER_PROPOSAL_STATES.has(marker.proposal_state)) return false;
  if (!PROMOTION_MARKER_REPAIR_STATES.has(marker.repair_state)) return false;
  if (marker.packet !== undefined && !validPromotionMarkerPacketFactsShape(marker.packet)) return false;
  if (marker.undo_bounds !== undefined && !validMarkerUndoBoundsShape(marker.undo_bounds)) return false;
  if (marker.merged_accepted_ref !== undefined && !validMergedAcceptedRefShape(marker.merged_accepted_ref)) {
    return false;
  }
  if (marker.superseded_by !== null && !nonEmptyString(marker.superseded_by)) return false;
  if (typeof marker.accept_cross_version_comparison !== "boolean") return false;
  if (!marker.phoenix_scope || typeof marker.phoenix_scope !== "object" || Array.isArray(marker.phoenix_scope)) {
    return false;
  }
  if (!nonEmptyString(marker.phoenix_scope.origin)) return false;
  if (!nonEmptyString(marker.phoenix_scope.project_name)) return false;
  if (!marker.evidence_ids || typeof marker.evidence_ids !== "object" || Array.isArray(marker.evidence_ids)) {
    return false;
  }
  if (!stringArray(marker.evidence_ids.experiments)) return false;
  if (!stringArray(marker.evidence_ids.annotations)) return false;
  if (!Array.isArray(marker.evidence_ids.datasets)) return false;
  for (const dataset of marker.evidence_ids.datasets) {
    if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) return false;
    if (!nonEmptyString(dataset.dataset_id) || !nonEmptyString(dataset.dataset_version_id)) return false;
  }
  return true;
}

export function registryPrReuseNeedsLiveValidation({ selection, record } = {}) {
  if (selection?.mode === "dry_run") return false;
  return true;
}

export function registryPrRecordStaleInCurrentMode({ selection, record } = {}) {
  return selection?.mode !== "dry_run" && Boolean(record?.pr?.dry_run);
}

export function registryPrValidationShouldFailClosed(result) {
  return result?.reason === "registry_pr_refetch_failed";
}

export function registryBlockedOutcomeIsRetryable(record) {
  return RETRYABLE_REGISTRY_BLOCK_REASONS.has(record?.outcome?.reason);
}

export async function validateRegistryRecordedPullRequest({
  github,
  record,
  envelopeHash,
} = {}) {
  if (!record?.pr?.number) return { ok: false, reason: "registry_pr_missing" };
  if (!nonEmptyString(record.branch)) return { ok: false, reason: "registry_branch_missing" };
  if (!controllerNamespacePr({ head: { ref: record.branch } })) {
    return { ok: false, reason: "registry_pr_not_namespaced" };
  }
  let current;
  try {
    current = await github.getPullRequest({ number: record.pr.number });
  } catch (error) {
    return { ok: false, reason: "registry_pr_refetch_failed", detail: error.message };
  }
  const pr = current?.data ?? null;
  if (!pr) return { ok: false, reason: "registry_pr_not_found" };
  if (pr.state !== "open") return { ok: false, reason: "registry_pr_not_open" };
  if (!controllerNamespacePr(pr)) {
    return { ok: false, reason: "registry_pr_not_namespaced" };
  }
  const headRef = pr?.head?.ref ?? pr?.head_ref ?? null;
  if (headRef !== record.branch) {
    return { ok: false, reason: "registry_pr_branch_mismatch" };
  }
  const read = readPromotionMarker(pr.body);
  if (read.status !== "ok") {
    return {
      ok: false,
      reason: "registry_pr_marker_unreadable",
      detail: `${read.status}${read.reason ? `:${read.reason}` : ""}`,
    };
  }
  if (read.marker.normalized_envelope_hash !== envelopeHash) {
    return { ok: false, reason: "registry_pr_marker_envelope_mismatch" };
  }
  return { ok: true, pr, marker: read.marker };
}

export function supersedeRepairDetail({ createdPrNumber, failures } = {}) {
  const stale = (failures || [])
    .map((entry) => `#${entry.pr_number}${entry.error ? ` (${entry.error})` : ""}`)
    .join(", ");
  return `created PR #${createdPrNumber} but could not mark older PR(s) ${stale} superseded; retry will repair.`;
}

// Parses agentic_factory_promotion markers out of a PR body — ONLY from
// sentinel-bounded regions. Fenced JSON outside the sentinels (including any
// fence an adversary smuggles through prose) is never parsed.
export function parsePromotionMarkers(body) {
  return findSentinelRegions(body).flatMap((region) => parseMarkersInRegion(region.inner));
}

// Controller-owned single-marker read with explicit trust states
// (outside-review FIX 2b/5):
//   ok         — exactly one sentinel-bounded region carrying exactly one marker
//   missing    — no sentinel-bounded region exists in the body
//   unreadable — multiple sentinel regions, multiple markers, or an
//                unparseable region; the controller NEVER picks one.
export function readPromotionMarker(body) {
  const regions = findSentinelRegions(body);
  if (regions.length === 0) return { status: "missing", marker: null };
  if (regions.length > 1) {
    return { status: "unreadable", marker: null, reason: "multiple_sentinel_bounded_markers" };
  }
  const markers = parseMarkersInRegion(regions[0].inner);
  if (markers.length === 1) {
    if (!validPromotionMarkerShape(markers[0])) {
      return { status: "unreadable", marker: null, reason: "marker_shape_invalid" };
    }
    return { status: "ok", marker: markers[0] };
  }
  return {
    status: "unreadable",
    marker: null,
    reason: markers.length === 0
      ? "sentinel_region_without_parseable_marker"
      : "multiple_markers_in_sentinel_region",
  };
}

// Rewrites the sentinel-bounded marker inside an existing PR body (supersede /
// repair-state paths), leaving prose untouched. Bodies without exactly one
// readable marker are returned unchanged — callers only patch PRs whose
// marker already read as ok.
export function updateMarkerInBody(body, patch) {
  const read = readPromotionMarker(body);
  if (read.status !== "ok") return body;
  const region = findSentinelRegions(body)[0];
  const updated = { [PROMOTION_MARKER_KEY]: { ...read.marker, ...patch } };
  return body.slice(0, region.start) + renderPromotionMarkerBlock(updated) + body.slice(region.end);
}

// ---------------------------------------------------------------------------
// GitHub Markdown safety (CONSTRAINTS #29 + outside-review FIX 2a): untrusted
// prose rendered into a PR body must not ping people, autolink to arbitrary
// targets, spoof link text, or FORGE STRUCTURE — newlines are collapsed (all
// prose call sites are inline contexts: list items, table cells), backticks
// are escaped (no code fence or code span can be opened from prose), and "<"
// becomes an entity (no HTML, and no fake sentinel comments). Together with
// sentinel-bounded marker parsing below, adversarial annotation text cannot
// inject a parseable agentic_factory_promotion marker.
// ---------------------------------------------------------------------------

const BARE_URL_PATTERN = /\bhttps?:\/\/[^\s)\]}"'<>`]+/gi;

export function escapeGitHubMarkdownProse(text) {
  let out = String(text ?? "");
  // Collapse newlines first: every prose render site is an inline context, so
  // untrusted text can never start a new markdown line (which code fences,
  // headings, and HTML comments all require).
  out = out.replace(/[\r\n]+/g, " ");
  // Escape backticks so prose can never open a code span or fence.
  out = out.replace(/`/g, "\\`");
  // Neutralize "<": no raw HTML and no spoofed sentinel comments from prose.
  out = out.replace(/</g, "&lt;");
  // Neutralize markdown link/image syntax (spoofed link text): a literal
  // bracket cannot open a link once escaped.
  out = out.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  // Neutralize @mentions: the HTML entity renders as "@" without linking.
  out = out.replace(/@(?=[A-Za-z0-9_-])/g, "&#64;");
  // Neutralize bare-URL autolinks: code spans render the URL without linking.
  out = out.replace(BARE_URL_PATTERN, (url) => `\`${url}\``);
  return out;
}
