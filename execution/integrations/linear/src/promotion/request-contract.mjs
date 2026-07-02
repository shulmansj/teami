// Step 10 (Track G): the `teami.promote_candidate` MVP promotion
// controller. One controller, called from every surface (tonight: the CLI
// agent-session transport only). It owns the OUTCOME — callers supply context,
// never authority (CONSTRAINTS #7).
//
// Trust posture (CONSTRAINTS #5/#6/#12/#13/#17):
// - trigger_authenticity is derived from the actual invocation transport.
//   Caller-supplied authenticity claims are IGNORED (recorded as ignored).
//   The CLI local-session transport does not authenticate, so MVP items say
//   `asserted` (D4).
// - The Phoenix origin comes from local Teami config ONLY. Deep
//   links are optional ID carriers, validated against that origin and a
//   STRICT path allowlist before any ID is extracted.
// - All evidence is re-resolved through the one verified local Phoenix REST
//   resolver path (the same GET surface the step 9 gate uses); in-process or
//   caller-supplied objects are never trusted.
// - `evidence_quality` and `promotion_risk` are assigned by a DETERMINISTIC
//   rubric over step 9 gate facts (documented at the rubric functions below).
//   MVP posture: no LLM is called for labeling; adversarial prose in any
//   evidence is data, never instructions — the rubric never reads prose.
//
// Outcomes (plan ~1696-1748): `route_to_hitl` is the terminal automated MVP
// success (internal branch + commit + HITL PR with the machine-readable
// marker; dry-run connections record the PR shape only); `blocked` records why a promotion did not proceed. Invalid
// requests are `rejected` before any evidence work. NEVER auto-merge,
// auto-apply, or mark-ready (CONSTRAINTS #8 — enforced in the GitHub client).
//
// GitHub live posture (CONSTRAINTS #22/#23/#25): dry-run connections still use
// the dry-run transport, but a VERIFIED real connection selects the adopter's
// local ambient git/gh auth. Local transport unavailable fails closed;
// production callers cannot inject a transport.

import {
  classifyAgentBehaviorProposalScope,
} from "./agent-behavior-scope.mjs";
import {
  judgeImprovementEvidenceFromProcessGate,
} from "./judge-alignment-evidence.mjs";

export const PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION =
  "teami-promote-candidate-request/v1";

export const PROMOTION_OUTCOME_ANNOTATION_NAME = "teami_promotion_outcome";
export const PROMOTION_OUTCOME_IDENTIFIER = "teami_promote_candidate_v1";
export const PROMOTION_OUTCOME_LABELS = Object.freeze(["route_to_hitl", "blocked", "superseded"]);

export const CANDIDATE_KINDS = Object.freeze([
  "prompt", "evaluator_prompt", "rule", "schema", "code_evaluator", "policy",
]);

// The PRODUCTION behavior-repo identity comes from the local GitHub
// connection state written by the step 11 `npm run init` GitHub phase
// (.teami/github-connection.json, resolveBehaviorRepoIdentity).
// When no verified connection exists, this placeholder keeps the request
// shapes honest without naming a real repo.
export const DEFAULT_GITHUB_REPO_PLACEHOLDER = Object.freeze({
  owner: "your-github-owner",
  repo: "teami",
});

const PHOENIX_ID_PATTERN = /^[A-Za-z0-9+/=:_-]+$/;
const PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN = /^Experiment-[0-9a-f]{24}$/i;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const PROMOTION_OUTCOME_TRACE_VISIBILITY_ATTEMPTS = 20;
const PROMOTION_OUTCOME_TRACE_VISIBILITY_INTERVAL_MS = 250;

// Caller-supplied trust claims are never honored; their presence is recorded
// so the HITL item can say "the caller claimed X and the controller ignored it".
const IGNORED_CALLER_TRUST_FIELDS = Object.freeze([
  "trigger_authenticity", "authenticity", "authenticated", "content_trust", "trusted",
]);

// ---------------------------------------------------------------------------
// Request validation (transport D3: CLI JSON envelope).
// ---------------------------------------------------------------------------

function validId(value) {
  return typeof value === "string" && value.length > 0 && PHOENIX_ID_PATTERN.test(value);
}

export function validatePromotionRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, reason: "request_not_object" };
  }
  if (request.schema_version !== PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported_request_schema_version",
      detail: `expected ${PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION}`,
    };
  }
  // MVP requested_action: propose_repo_change ONLY (CONSTRAINTS #7).
  // route_to_hitl / blocked are controller OUTCOMES, never caller authority.
  if (request.requested_action !== "propose_repo_change") {
    return {
      ok: false,
      reason: "requested_action_not_allowed",
      detail:
        `requested_action must be "propose_repo_change" (got "${request.requested_action ?? ""}"); route_to_hitl/blocked are controller outcomes, never caller-granted authority.`,
    };
  }
  for (const field of ["source", "actor_id", "expected_project"]) {
    if (typeof request[field] !== "string" || !request[field].trim()) {
      return { ok: false, reason: `missing_${field}` };
    }
  }
  if (request.policy_edit !== undefined && request.policy_edit !== null) {
    return {
      ok: false,
      reason: "policy_edit_out_of_scope",
      detail:
        "promotion-policy edits are factory behavior; the adopter self-improvement loop may propose only manifest-declared agent-behavior targets.",
    };
  }
  const experimentIds = [];
  if (request.experiment_id !== undefined && request.experiment_id !== null) {
    experimentIds.push(request.experiment_id);
  }
  if (Array.isArray(request.experiment_ids)) experimentIds.push(...request.experiment_ids);
  const uniqueExperimentIds = [...new Set(experimentIds)];
  if (uniqueExperimentIds.length > 1) {
    return {
      ok: false,
      reason: "multiple_experiment_ids_unsupported_in_mvp",
      detail: "MVP receipts pin exactly one Phoenix experiment; supply one experiment id.",
    };
  }
  const optionalIds = {
    prompt_version_id: request.prompt_version_id ?? null,
    evaluator_id: request.evaluator_id ?? null,
    dataset_version_id: request.dataset_version_id ?? null,
  };
  for (const [field, value] of Object.entries({
    ...(uniqueExperimentIds[0] !== undefined ? { experiment_id: uniqueExperimentIds[0] } : {}),
    ...Object.fromEntries(Object.entries(optionalIds).filter(([, v]) => v !== null)),
  })) {
    if (!validId(value)) {
      return { ok: false, reason: "invalid_phoenix_id_format", detail: `${field}: ${String(value)}` };
    }
  }
  let annotationIds = [];
  if (request.annotation_ids !== undefined && request.annotation_ids !== null) {
    if (!Array.isArray(request.annotation_ids) || !request.annotation_ids.every(validId)) {
      return { ok: false, reason: "invalid_annotation_ids" };
    }
    annotationIds = [...new Set(request.annotation_ids)];
  }
  if (request.phoenix_deep_link !== undefined && request.phoenix_deep_link !== null
    && typeof request.phoenix_deep_link !== "string") {
    return { ok: false, reason: "invalid_phoenix_deep_link" };
  }
  if (uniqueExperimentIds.length === 0 && !request.phoenix_deep_link) {
    return {
      ok: false,
      reason: "missing_experiment_id",
      detail: "supply experiment_id or a Phoenix deep link that names an experiment.",
    };
  }
  // REQUEST-VISIBLE cross-version acceptance (outside-review FIX 4): explicit
  // human acceptance of comparing examples judged under older
  // workflow/rubric/taxonomy versions travels in the request envelope — never
  // as an invisible in-process option — and is disclosed in the marker and
  // proposal document.
  if (request.accept_cross_version_comparison !== undefined
    && request.accept_cross_version_comparison !== null
    && typeof request.accept_cross_version_comparison !== "boolean") {
    return {
      ok: false,
      reason: "invalid_accept_cross_version_comparison",
      detail: "accept_cross_version_comparison must be a boolean when supplied.",
    };
  }
  const ignoredCallerTrustFields = IGNORED_CALLER_TRUST_FIELDS.filter(
    (field) => request[field] !== undefined,
  );
  return {
    ok: true,
    normalized: {
      schema_version: request.schema_version,
      source: request.source.trim(),
      actor_id: request.actor_id.trim(),
      expected_project: request.expected_project.trim(),
      phoenix_deep_link: request.phoenix_deep_link ?? null,
      experiment_id: uniqueExperimentIds[0] ?? null,
      prompt_version_id: optionalIds.prompt_version_id,
      evaluator_id: optionalIds.evaluator_id,
      dataset_version_id: optionalIds.dataset_version_id,
      annotation_ids: annotationIds,
      requested_action: request.requested_action,
      policy_edit: null,
      candidate_kind: null,
      candidate_target_key: null,
      accept_cross_version_comparison: request.accept_cross_version_comparison === true,
      ignored_caller_trust_fields: ignoredCallerTrustFields,
    },
  };
}

// trigger_authenticity from the ACTUAL invocation transport (CONSTRAINTS #5).
// Tonight the local CLI session and deterministic local scanner are asserted,
// not authenticated (D4). Any other transport string is unsupported and the
// request is rejected rather than guessed at.
export function deriveTriggerAuthenticity({ transport } = {}) {
  if (transport === "cli_local_session") {
    return {
      ok: true,
      value: "asserted",
      derived_from: "cli_local_session",
      detail:
        "local CLI invocation; the transport does not authenticate the caller, so the trigger is asserted, never authenticated (D4).",
    };
  }
  if (transport === "promotion_candidate_scanner") {
    return {
      ok: true,
      value: "asserted",
      derived_from: "promotion_candidate_scanner",
      detail:
        "deterministic local scanner invocation; the scanner detects explicit intent only and does not authenticate a human actor, so the trigger is asserted, never authenticated (D4/D18).",
    };
  }
  return { ok: false, reason: "unsupported_invocation_transport", detail: String(transport ?? "") };
}

export function isPhoenixGeneratedExperimentProjectName(projectName) {
  return typeof projectName === "string"
    && PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN.test(projectName);
}

// ---------------------------------------------------------------------------
// Deep-link validation (CONSTRAINTS #6): origin must equal the locally
// configured Phoenix origin; path must match a STRICT allowlist of known
// Phoenix UI shapes for experiments/datasets/prompts; queries and fragments
// are rejected outright. IDs are extracted only after validation.
// ---------------------------------------------------------------------------

const DEEP_LINK_PATH_ALLOWLIST = Object.freeze([
  {
    shape: "dataset_experiment",
    pattern: /^\/datasets\/([A-Za-z0-9+/=_-]+)\/experiments\/([A-Za-z0-9+/=_-]+)$/,
    extract: (match) => ({ dataset_id: match[1], experiment_id: match[2] }),
  },
  {
    shape: "dataset",
    pattern: /^\/datasets\/([A-Za-z0-9+/=_-]+)$/,
    extract: (match) => ({ dataset_id: match[1] }),
  },
  {
    shape: "prompt",
    pattern: /^\/prompts\/([A-Za-z0-9+/=_-]+)$/,
    extract: (match) => ({ prompt_id: match[1] }),
  },
]);

export function normalizeOrigin(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}

export function validatePhoenixDeepLink({ deepLink, configuredOrigin } = {}) {
  let parsed;
  try {
    parsed = new URL(deepLink);
  } catch {
    return { ok: false, reason: "deep_link_unparseable", detail: String(deepLink).slice(0, 120) };
  }
  if (normalizeOrigin(parsed.origin) !== normalizeOrigin(configuredOrigin)) {
    return {
      ok: false,
      reason: "deep_link_origin_mismatch",
      detail: `deep link origin ${parsed.origin} does not match the locally configured Phoenix origin ${configuredOrigin}; caller-supplied origins are rejected (CONSTRAINTS #6).`,
    };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return {
      ok: false,
      reason: "deep_link_query_not_allowlisted",
      detail: "the strict deep-link allowlist accepts path-only Phoenix UI links (no query, no fragment).",
    };
  }
  for (const entry of DEEP_LINK_PATH_ALLOWLIST) {
    const match = parsed.pathname.match(entry.pattern);
    if (match) {
      return { ok: true, shape: entry.shape, ids: entry.extract(match) };
    }
  }
  return {
    ok: false,
    reason: "deep_link_path_not_allowlisted",
    detail: `path ${parsed.pathname} is not a known Phoenix UI shape for experiments/datasets/prompts.`,
  };
}

// ---------------------------------------------------------------------------
// Verified resolver helpers (one local Phoenix REST path; CONSTRAINTS #12).
// ---------------------------------------------------------------------------

export async function phoenixRequestJson({
  appUrl,
  pathname,
  searchParams = {},
  method = "GET",
  payload = null,
  fetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
  const url = new URL(pathname, appUrl);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`phoenix_fetch_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });
  const init = { method, signal: controller.signal };
  if (payload !== null) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  let response;
  try {
    response = await Promise.race([fetchImpl(url, init), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw_text: text };
    }
  }
  if (!response.ok) {
    const error = new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForPhoenixTraceVisible({
  appUrl,
  projectName,
  traceId,
  fetchImpl,
  attempts = PROMOTION_OUTCOME_TRACE_VISIBILITY_ATTEMPTS,
  intervalMs = PROMOTION_OUTCOME_TRACE_VISIBILITY_INTERVAL_MS,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = await phoenixRequestJson({
      appUrl,
      pathname: `/v1/projects/${encodeURIComponent(projectName)}/traces`,
      searchParams: { include_spans: "true", limit: "100" },
      fetchImpl,
    });
    const traces = Array.isArray(body?.data) ? body.data : [];
    if (traces.some((trace) => trace?.trace_id === traceId)) return true;
    if (attempt + 1 < attempts) await waitMs(intervalMs);
  }
  throw new Error(`phoenix_trace_not_visible_after_span_upload:${traceId}`);
}

// Per-object-type resolver capability preflight against the LIVE openapi
// surface. A missing capability fails closed for THAT object type with a
// named gap (CONSTRAINTS #12: per capability, not globally).
export const PROMOTION_RESOLVER_CAPABILITIES = Object.freeze({
  experiment: { method: "get", path: "/v1/experiments/{experiment_id}" },
  prompt_version: { method: "get", path: "/v1/prompt_versions/{prompt_version_id}" },
  // Required ONLY when a /prompts/{id} deep link is supplied: the deep-link id
  // may name a prompt (not a version), and reconciling it against the
  // receipt-pinned candidate version requires enumerating the prompt's
  // versions. Pinned Phoenix 14.13.0 exposes this path (PHOENIX-CAPABILITIES);
  // if a future pin drops it, prompt deep links FAIL CLOSED per capability
  // (outside-review FIX 1), never silently allow.
  prompt: { method: "get", path: "/v1/prompts/{prompt_identifier}/versions" },
  dataset_version: { method: "get", path: "/v1/datasets/{id}/versions" },
  annotations: { method: "get", path: "/v1/projects/{project_identifier}/trace_annotations" },
});

export async function preflightPromotionResolverCapabilities({
  appUrl,
  fetchImpl,
  requiredObjectTypes,
} = {}) {
  let spec;
  try {
    spec = await phoenixRequestJson({ appUrl, pathname: "/openapi.json", fetchImpl });
  } catch (error) {
    return {
      ok: false,
      reason: "resolver_capability_preflight_unavailable",
      detail: error.message,
      missing: [...requiredObjectTypes],
    };
  }
  const missing = [];
  for (const objectType of requiredObjectTypes) {
    const capability = PROMOTION_RESOLVER_CAPABILITIES[objectType];
    if (!capability || !spec?.paths?.[capability.path]?.[capability.method]) {
      missing.push(objectType);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `resolver_capability_missing:${missing.join(",")}`,
      missing,
    };
  }
  return { ok: true, checked: [...requiredObjectTypes] };
}

export async function resolveExperimentSummary({ appUrl, experimentId, fetchImpl }) {
  try {
    const body = await phoenixRequestJson({
      appUrl,
      pathname: `/v1/experiments/${encodeURIComponent(experimentId)}`,
      fetchImpl,
    });
    const experiment = body?.data || null;
    if (!experiment?.id) return { ok: false, reason: "experiment_unresolvable", experiment_id: experimentId };
    return { ok: true, experiment };
  } catch (error) {
    return { ok: false, reason: "experiment_unresolvable", detail: error.message, experiment_id: experimentId };
  }
}

// Outside-review FIX 1: a /prompts/{id} deep link is allowlisted, so its id
// MUST be reconciled like every other deep-link id (CONSTRAINTS #6) — through
// the verified resolver, against the request's prompt_version_id AND the
// receipt-pinned candidate version. The id may name a prompt VERSION (resolved
// directly) or a PROMPT (its versions are enumerated and the candidate version
// must belong to it). Any mismatch or resolution failure blocks before
// drafting; nothing about a prompt deep link is ever silently allowed.
export async function reconcilePromptDeepLink({
  appUrl,
  promptDeepLinkId,
  requestPromptVersionId,
  receiptPromptVersionId,
  fetchImpl,
}) {
  // 1. Try the id as a prompt VERSION via the verified resolver.
  let resolvedAsVersion = false;
  try {
    await phoenixRequestJson({
      appUrl,
      pathname: `/v1/prompt_versions/${encodeURIComponent(promptDeepLinkId)}`,
      fetchImpl,
    });
    resolvedAsVersion = true;
  } catch (error) {
    if (error.status !== 404) {
      return {
        ok: false,
        reason: "prompt_deep_link_unresolvable",
        detail: `deep-link prompt id ${promptDeepLinkId} could not be resolved as a prompt version through the verified resolver (${error.message}); unresolvable deep-link ids are refused before drafting.`,
      };
    }
  }
  if (resolvedAsVersion) {
    const disagreements = [];
    if (requestPromptVersionId && requestPromptVersionId !== promptDeepLinkId) {
      disagreements.push(`the request pins prompt_version_id ${requestPromptVersionId}`);
    }
    if (!receiptPromptVersionId) {
      disagreements.push("the managed receipt pins no candidate prompt version");
    } else if (receiptPromptVersionId !== promptDeepLinkId) {
      disagreements.push(`the receipt-pinned candidate version is ${receiptPromptVersionId}`);
    }
    if (disagreements.length > 0) {
      return {
        ok: false,
        reason: "deep_link_id_mismatch",
        detail: `the deep link names prompt version ${promptDeepLinkId} but ${disagreements.join(" and ")}; both sides were resolved through the verified resolver and the mismatch is rejected before drafting.`,
      };
    }
    return { ok: true, mode: "prompt_version" };
  }
  // 2. Not a version: try the id as a PROMPT and enumerate its versions.
  let versionIds;
  try {
    const body = await phoenixRequestJson({
      appUrl,
      pathname: `/v1/prompts/${encodeURIComponent(promptDeepLinkId)}/versions`,
      searchParams: { limit: "100" },
      fetchImpl,
    });
    versionIds = (body?.data || []).map((entry) => entry?.id).filter(Boolean);
  } catch (error) {
    return {
      ok: false,
      reason: "prompt_deep_link_unresolvable",
      detail: `deep-link prompt id ${promptDeepLinkId} resolved as neither a prompt version nor a prompt (${error.message}); unresolvable deep-link ids are refused before drafting (fail closed).`,
    };
  }
  if (!receiptPromptVersionId) {
    return {
      ok: false,
      reason: "deep_link_id_mismatch",
      detail: `the deep link names prompt ${promptDeepLinkId} but the managed receipt pins no candidate prompt version, so the prompt deep link cannot be reconciled with the candidate.`,
    };
  }
  if (!versionIds.includes(receiptPromptVersionId)) {
    return {
      ok: false,
      reason: "deep_link_id_mismatch",
      detail: `the deep link names prompt ${promptDeepLinkId} but the receipt-pinned candidate version ${receiptPromptVersionId} is not one of its versions; the mismatch is rejected before drafting.`,
    };
  }
  if (requestPromptVersionId && !versionIds.includes(requestPromptVersionId)) {
    return {
      ok: false,
      reason: "deep_link_id_mismatch",
      detail: `the deep link names prompt ${promptDeepLinkId} but the request's prompt_version_id ${requestPromptVersionId} is not one of its versions; the mismatch is rejected before drafting.`,
    };
  }
  return { ok: true, mode: "prompt", version_ids: versionIds };
}

// ---------------------------------------------------------------------------
// Managed receipt join: the receipt is loaded BY experiment id from local
// custody and re-derived; Phoenix-native evidence without a managed receipt
// (candidate tag / registration) is blocked, never auto-proposed
// (CONSTRAINTS #18/#19).

// ---------------------------------------------------------------------------
// candidate_target_key grammar (canonical, from the Track A template):
// <candidate_kind>/<scope>/<artifact_slot>. Free-form keys are invalid and
// must be rejected before drafting — they silently break cross-machine
// dedupe and rejection memory.
// ---------------------------------------------------------------------------

export function parseCandidateTargetKey(key) {
  if (typeof key !== "string") return { ok: false, reason: "invalid_candidate_target_key" };
  const segments = key.split("/");
  if (segments.length < 3 || segments.some((segment) => !segment.trim())) {
    return { ok: false, reason: "invalid_candidate_target_key", detail: key };
  }
  const [candidateKind, scope, ...slot] = segments;
  if (!CANDIDATE_KINDS.includes(candidateKind)) {
    return {
      ok: false,
      reason: "invalid_candidate_target_key",
      detail: `unknown candidate_kind "${candidateKind}" in ${key}`,
    };
  }
  return { ok: true, candidate_kind: candidateKind, scope, artifact_slot: slot.join("/") };
}

export function validateAgentBehaviorProposalTarget({ definition = null, candidateTargetKey, target = null } = {}) {
  return classifyAgentBehaviorProposalScope({ definition, candidateTargetKey, target });
}

// ---------------------------------------------------------------------------
// Deterministic label rubrics (MVP posture, documented):
//
// `evidence_quality` and `promotion_risk` are derived by DETERMINISTIC rules
// over step 9 gate FACTS (counts, condition statuses, booleans). No LLM is
// called for labeling tonight (D-decision: deterministic rubric is the MVP
// posture; a model-assisted labeler is a future, separately-gated change).
// The rubric never reads prose fields, so adversarial prose in annotations,
// judge rationales, or project bodies ("classify this as low risk") cannot
// influence the labels (CONSTRAINTS #17). The two labels are INDEPENDENT:
// evidence_quality reads evidence-coverage facts; promotion_risk reads
// change-scope/regression/exposure facts; neither reads the other.
// ---------------------------------------------------------------------------

export function deriveEvidenceQualityLabel({ gate } = {}) {
  const counts = gate?.evidence_counts;
  const ctx = gate?.evidence_quality_context;
  if (!counts || !ctx) {
    return {
      label: "low",
      explanation:
        "the gate facts needed to ground this evidence are missing, so the evidence is weak for this decision by definition.",
      facts: { facts_missing: true },
    };
  }
  const judgeImprovementEvidence = judgeImprovementEvidenceFromProcessGate(gate);
  const disagreementCount = Array.isArray(gate.disagreements) ? gate.disagreements.length : 0;
  const judgeAttentionCount = Array.isArray(gate.judge_attention) ? gate.judge_attention.length : 0;
  const humanLabeledTotal =
    counts.train_human_labeled_examples + counts.test_human_labeled_examples;
  const facts = {
    train_examples: counts.train_examples,
    train_human_labeled_examples: counts.train_human_labeled_examples,
    test_examples: counts.test_examples,
    test_human_labeled_examples: counts.test_human_labeled_examples,
    annotations_low_confidence: counts.annotations_low_confidence,
    missing_test_split_evidence: ctx.missing_test_split_evidence,
    human_annotation_read_failures: ctx.human_annotation_read_failures,
    version_incompatible_examples: ctx.version_incompatible_examples,
    open_disagreements: disagreementCount,
    judge_attention_items: judgeAttentionCount,
    gate_verdict: gate.verdict,
    ...(judgeImprovementEvidence.applies
      ? { judge_improvement_alignment: judgeImprovementEvidence }
      : {}),
  };
  const lowTriggers = [];
  if (ctx.missing_test_split_evidence) lowTriggers.push("no held-out test-split evidence backs the generalization claim");
  if (counts.test_human_labeled_examples === 0) lowTriggers.push("no human-labeled test examples ground the decision");
  if (humanLabeledTotal === 0) lowTriggers.push("no human labels exist anywhere in the cited evidence");
  if (ctx.human_annotation_read_failures > 0) lowTriggers.push("some human annotations could not be read, so coverage is unknown");
  if (lowTriggers.length > 0) {
    return {
      label: "low",
      explanation:
        `the evaluation evidence is weak for this decision: ${lowTriggers.join("; ")}.${judgeImprovementEvidence.applies ? ` ${judgeImprovementEvidence.pr_language}` : ""}`,
      facts,
    };
  }
  const mediumTriggers = [];
  if (gate.verdict !== "pass") mediumTriggers.push("the process-change gate did not pass on this evidence");
  if (counts.train_human_labeled_examples === 0) mediumTriggers.push("no human-labeled training examples");
  if (counts.annotations_low_confidence > 0) {
    mediumTriggers.push(`${counts.annotations_low_confidence} annotation(s) carry a label/score band mismatch`);
  }
  if (disagreementCount > 0) mediumTriggers.push(`${disagreementCount} open human/model/code disagreement(s)`);
  if (judgeAttentionCount > 0) mediumTriggers.push(`${judgeAttentionCount} judge result(s) need attention`);
  if (ctx.version_incompatible_examples > 0) {
    mediumTriggers.push(`${ctx.version_incompatible_examples} example(s) were excluded as version-incompatible`);
  }
  if (mediumTriggers.length > 0) {
    return {
      label: "medium",
      explanation:
        `the evaluation evidence supports a decision but has disclosed gaps: ${mediumTriggers.join("; ")}.${judgeImprovementEvidence.applies ? ` ${judgeImprovementEvidence.pr_language}` : ""}`,
      facts,
    };
  }
  return {
    label: "high",
    explanation:
      `the evaluation evidence is well grounded: ${counts.test_human_labeled_examples} human-labeled held-out test example(s), ${counts.train_human_labeled_examples} human-labeled training example(s), no open disagreements, no judge-attention items, no band mismatches, and a passing process-change gate all support the same reading.${judgeImprovementEvidence.applies ? ` ${judgeImprovementEvidence.pr_language}` : ""}`,
    facts,
  };
}

export function derivePromotionRiskLabel({
  gate,
  receiptState,
  policy,
  candidateKind,
  phoenixNativeRegistered = false,
} = {}) {
  const exposureDefaultsHighRisk =
    policy?.risk_defaults?.prior_test_split_exposure_defaults_high_risk !== false;
  const gateCondition = (id) =>
    (Array.isArray(gate?.conditions) ? gate.conditions : []).find((entry) => entry.id === id);
  const regression = gateCondition("no_human_labeled_regression");
  const labelDegradations = regression?.evidence?.label_degradations?.length ?? null;
  const disagreementCount = Array.isArray(gate?.disagreements) ? gate.disagreements.length : null;
  const judgeAttentionCount = Array.isArray(gate?.judge_attention) ? gate.judge_attention.length : null;
  const reclassifiedIntent = receiptState?.intent_source === "amendment_reclassify";
  const facts = {
    candidate_kind: candidateKind ?? null,
    defaults_high_risk_from_gate: gate?.defaults_high_risk ?? null,
    prior_test_split_exposure: gate?.test_split_exposure?.prior_test_split_exposure ?? null,
    exposure_defaults_high_risk_policy: exposureDefaultsHighRisk,
    phoenix_native_registered_match: Boolean(phoenixNativeRegistered),
    intent_reclassified_by_amendment: Boolean(reclassifiedIntent),
    human_label_degradations: labelDegradations,
    open_disagreements: disagreementCount,
    judge_attention_items: judgeAttentionCount,
    gate_verdict: gate?.verdict ?? null,
  };
  const triggers = [];
  // "If unsure -> high_risk": any required fact that cannot be derived is a
  // high-risk trigger by itself (CONSTRAINTS #17).
  if (gate?.verdict === undefined || labelDegradations === null
    || disagreementCount === null || judgeAttentionCount === null
    || !candidateKind) {
    triggers.push("the controller could not derive every risk fact (when unsure, classify high_risk)");
  }
  if (gate?.defaults_high_risk && exposureDefaultsHighRisk) {
    triggers.push(
      `prior test-split exposure on this candidate target lineage (${gate.test_split_exposure?.prior_test_split_exposure}); human-led experimentation over test examples defaults the candidate to high_risk`,
    );
  }
  if (phoenixNativeRegistered) {
    triggers.push("the experiment evidence was attached by retroactive registration (Phoenix-native match), which defaults to high_risk");
  }
  if (reclassifiedIntent) {
    triggers.push("promotion intent was declared by retroactive reclassification (operator-override path), which deserves extra scrutiny");
  }
  if (candidateKind && candidateKind !== "prompt" && candidateKind !== "evaluator_prompt") {
    triggers.push(
      `the candidate targets ${candidateKind} behavior (rules, schemas, code evaluators, or policies can change what counts as good or touch self-policy scope)`,
    );
  }
  if (typeof labelDegradations === "number" && labelDegradations > 0) {
    triggers.push(`${labelDegradations} human-labeled example(s) regress under the candidate (meaningful regression)`);
  }
  if (typeof disagreementCount === "number" && disagreementCount > 0) {
    triggers.push(`${disagreementCount} unresolved human/model/code disagreement(s) on the cited evidence`);
  }
  if (typeof judgeAttentionCount === "number" && judgeAttentionCount > 0) {
    triggers.push(`${judgeAttentionCount} judge result(s) need attention, so the product explanation is uncertain`);
  }
  if (gate?.verdict === "fail") {
    triggers.push("the process-change gate failed on this evidence");
  }
  if (triggers.length > 0) {
    return {
      label: "high_risk",
      explanation: `this change deserves extra scrutiny: ${triggers.join("; ")}.`,
      facts,
    };
  }
  return {
    label: "low_risk",
    explanation:
      "the proposed change is a narrow prompt-target change with no known meaningful regression, no unresolved disagreement, no prior test-split exposure on its lineage, and no evaluator/promotion-policy scope; it has a coherent product explanation in the evidence summary.",
    facts,
  };
}
