import fs from "node:fs";
import path from "node:path";

import { resolvePhoenixConfig } from "../local-phoenix-manager.mjs";
import {
  defaultExperimentReceiptDir,
  deriveExperimentReceiptState,
} from "../phoenix-experiment.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import { SCANNER_MANAGED_RECEIPT_INTENT } from "../promotion-policy.mjs";
import {
  normalizeOrigin,
  readJsonTolerant,
  setCandidateStatus,
} from "./ledger-store.mjs";

export const PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN = /^Experiment-[0-9a-f]{24}$/i;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function isPhoenixGeneratedExperimentProjectName(projectName) {
  return typeof projectName === "string"
    && PHOENIX_GENERATED_EXPERIMENT_PROJECT_PATTERN.test(projectName);
}
async function phoenixGetJson({
  appUrl,
  pathname,
  searchParams = {},
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
  let response;
  try {
    response = await Promise.race([fetchImpl(url, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`phoenix_http_${response.status}:${body.detail || body.error || text}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function openApiHas(spec, alternatives, method = "get") {
  return alternatives.some((pathname) => spec?.paths?.[pathname]?.[method]);
}

export async function resolvePhoenixReady({
  repoRoot,
  ensureReady,
  fetchImpl,
  env,
  onProgress,
}) {
  const configured = resolvePhoenixConfig({ repoRoot, env });
  try {
    const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
    if (!ready?.ok) {
      return {
        ok: false,
        status: "degraded",
        reason: "local_phoenix_unavailable",
        detail: ready?.reason || null,
        configured,
      };
    }
    if (normalizeOrigin(ready.appUrl) !== normalizeOrigin(configured.appUrl)) {
      return {
        ok: false,
        status: "degraded",
        reason: "phoenix_origin_mismatch",
        detail: `live Phoenix origin ${ready.appUrl} does not match configured origin ${configured.appUrl}`,
        configured,
      };
    }
    return {
      ok: true,
      appUrl: ready.appUrl,
      projectName: ready.projectName || configured.projectName,
      configured,
    };
  } catch (error) {
    return {
      ok: false,
      status: "degraded",
      reason: "local_phoenix_unavailable",
      detail: error.message,
      configured,
    };
  }
}

export function loadReceiptCandidates({ repoRoot, home = resolveTeamiHome(), receiptDir = null }) {
  void repoRoot;
  const dir = receiptDir || defaultExperimentReceiptDir(home);
  if (!fs.existsSync(dir)) return { receipt_dir: dir, candidates: [] };
  const candidates = [];
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const filePath = path.join(dir, name);
    const receipt = readJsonTolerant(filePath);
    if (!receipt) {
      candidates.push(setCandidateStatus({
        candidate_key: `receipt-file:${name}`,
        source: "managed_experiment_receipt",
        receipt_path: filePath,
        evidence: { managed_receipt: true, phoenix_candidate_tag: false },
      }, "needs_reconciliation", "experiment_receipt_unreadable", filePath));
      continue;
    }
    let state;
    try {
      state = deriveExperimentReceiptState(receipt);
    } catch (error) {
      candidates.push(setCandidateStatus({
        candidate_key: `receipt:${receipt.receipt_id || name}`,
        source: "managed_experiment_receipt",
        receipt_id: receipt.receipt_id ?? null,
        receipt_path: filePath,
        evidence: { managed_receipt: true, phoenix_candidate_tag: false },
      }, "needs_reconciliation", "experiment_receipt_malformed", error.message));
      continue;
    }
    const promptVersionId = receipt.launch?.candidate?.judge_candidate_prompt_version_id ?? null;
    candidates.push({
      candidate_key: `receipt:${state.receipt_id}`,
      source: "managed_experiment_receipt",
      receipt_id: state.receipt_id,
      receipt_path: filePath,
      receipt,
      receipt_state: state,
      experiment_id: state.phoenix_experiment_id,
      candidate_target_key: state.candidate_target_key,
      candidate_version_id: state.candidate_version_id,
      prompt_version_id: promptVersionId,
      dataset_id: state.dataset?.dataset_id ?? null,
      dataset_name: state.dataset?.name ?? null,
      dataset_version_id: state.dataset?.dataset_version_id ?? null,
      launched_at: receipt.launch?.launched_at ?? receipt.created_at ?? null,
      source_launch: state.source,
      evidence: { managed_receipt: true, phoenix_candidate_tag: false },
      status: "unclassified",
      reason: null,
      detail: null,
    });
  }
  return { receipt_dir: dir, candidates };
}

export function markAmbiguousReceiptJoins(candidates) {
  const byExperiment = new Map();
  for (const candidate of candidates) {
    if (candidate.source !== "managed_experiment_receipt" || !candidate.experiment_id) continue;
    const list = byExperiment.get(candidate.experiment_id) || [];
    list.push(candidate);
    byExperiment.set(candidate.experiment_id, list);
  }
  for (const [experimentId, list] of byExperiment.entries()) {
    if (list.length <= 1) continue;
    for (const candidate of list) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "ambiguous_receipt_join",
        `${list.length} managed receipts claim experiment ${experimentId}`,
      );
    }
  }
}

function promptTargetForPrompt(promptTargets, prompt) {
  return promptTargets.find((target) =>
    promptAliasesForTarget(target).some((alias) =>
      (prompt.id && alias === prompt.id) || (prompt.name && alias === prompt.name))) || null;
}

function promptAliasesForTarget(target = {}) {
  const aliases = new Set();
  for (const value of [
    target.prompt_id,
    target.prompt_name,
    target.role,
    typeof target.target_key === "string" ? target.target_key.split("/").at(-1) : null,
  ]) {
    if (typeof value === "string" && value.trim() !== "") aliases.add(value.trim());
  }
  return [...aliases];
}

function promptVersionIdFromTagBody(body) {
  const data = body?.data ?? body;
  return data?.id ?? data?.prompt_version_id ?? data?.version_id ?? null;
}

export async function scanPhoenixPromptCandidateTags({
  appUrl,
  policy,
  promptTargets = [],
  fetchImpl,
}) {
  const tagName = policy.scanner_routing.explicit_intent_signals.prompt_version_candidate_tag;
  let spec;
  try {
    spec = await phoenixGetJson({ appUrl, pathname: "/openapi.json", fetchImpl });
  } catch (error) {
    return { ok: false, status: "degraded", reason: "phoenix_openapi_unavailable", detail: error.message, tags: [] };
  }
  const required = [
    {
      name: "prompts",
      ok: openApiHas(spec, ["/v1/prompts"], "get"),
    },
    {
      name: "prompt_tag_resolver",
      ok: openApiHas(spec, [
        "/v1/prompts/{prompt_identifier}/tags/{tag_name}",
        "/v1/prompts/{id}/tags/{tag_name}",
      ], "get"),
    },
    {
      name: "prompt_version",
      ok: openApiHas(spec, ["/v1/prompt_versions/{prompt_version_id}", "/v1/prompt_versions/{id}"], "get"),
    },
  ];
  const missing = required.filter((entry) => !entry.ok).map((entry) => entry.name);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "degraded",
      reason: "phoenix_prompt_tag_capability_missing",
      detail: missing.join(","),
      tags: [],
    };
  }

  const prompts = [];
  let cursor = null;
  do {
    const body = await phoenixGetJson({
      appUrl,
      pathname: "/v1/prompts",
      searchParams: { limit: "100", ...(cursor ? { cursor } : {}) },
      fetchImpl,
    });
    prompts.push(...(Array.isArray(body?.data) ? body.data : []));
    cursor = body?.next_cursor ?? null;
  } while (cursor);
  prompts.sort((a, b) => String(a?.id ?? a?.name ?? "").localeCompare(String(b?.id ?? b?.name ?? "")));

  const tags = [];
  for (const prompt of prompts) {
    const promptIdentifier = prompt?.id ?? prompt?.name ?? null;
    if (!promptIdentifier) continue;
    let tagBody;
    try {
      tagBody = await phoenixGetJson({
        appUrl,
        pathname: `/v1/prompts/${encodeURIComponent(promptIdentifier)}/tags/${encodeURIComponent(tagName)}`,
        fetchImpl,
      });
    } catch (error) {
      if (error.status === 404) continue;
      return {
        ok: false,
        status: "degraded",
        reason: "phoenix_prompt_tag_scan_failed",
        detail: error.message,
        tags,
      };
    }
    const promptVersionId = promptVersionIdFromTagBody(tagBody);
    if (!promptVersionId) {
      tags.push({
        status: "needs_reconciliation",
        reason: "prompt_candidate_tag_unresolvable",
        prompt_id: prompt.id ?? null,
        prompt_name: prompt.name ?? null,
        detail: "tag response did not include a prompt version id",
      });
      continue;
    }
    let version;
    try {
      const versionBody = await phoenixGetJson({
        appUrl,
        pathname: `/v1/prompt_versions/${encodeURIComponent(promptVersionId)}`,
        fetchImpl,
      });
      version = versionBody?.data || null;
    } catch (error) {
      tags.push({
        status: "needs_reconciliation",
        reason: "prompt_candidate_tag_unresolvable",
        prompt_id: prompt.id ?? null,
        prompt_name: prompt.name ?? null,
        prompt_version_id: promptVersionId,
        detail: error.message,
      });
      continue;
    }
    const target = promptTargetForPrompt(promptTargets, prompt);
    if (!target) {
      tags.push({
        status: "needs_reconciliation",
        reason: "prompt_candidate_tag_target_unknown",
        prompt_id: prompt.id ?? null,
        prompt_name: prompt.name ?? null,
        prompt_version_id: promptVersionId,
        detail: "the tagged prompt is not a manifest-declared agent behavior prompt target",
      });
      continue;
    }
    tags.push({
      status: "tagged_candidate",
      prompt_id: prompt.id ?? version?.prompt_id ?? null,
      prompt_name: prompt.name ?? null,
      prompt_version_id: promptVersionId,
      candidate_target_key: target.candidate_target_key ?? target.target_key,
      prompt_role: target.prompt_role ?? target.role ?? null,
      tag_name: tagName,
    });
  }

  return {
    ok: true,
    status: "scanned",
    tag_name: tagName,
    prompts_checked: prompts.length,
    tags,
  };
}

export async function resolveExperimentSummaries({
  appUrl,
  candidates,
  fetchImpl,
}) {
  const summaries = new Map();
  const ids = [...new Set(candidates.map((candidate) => candidate.experiment_id).filter(Boolean))].sort();
  for (const experimentId of ids) {
    try {
      const body = await phoenixGetJson({
        appUrl,
        pathname: `/v1/experiments/${encodeURIComponent(experimentId)}`,
        fetchImpl,
      });
      const experiment = body?.data || null;
      if (!experiment?.id) {
        summaries.set(experimentId, { ok: false, reason: "experiment_unresolvable" });
      } else {
        summaries.set(experimentId, { ok: true, experiment });
      }
    } catch (error) {
      summaries.set(experimentId, {
        ok: false,
        reason: "experiment_unresolvable",
        detail: error.message,
      });
    }
  }
  return summaries;
}

export function reconcilePromptTagsWithReceipts({ candidates, tagScan }) {
  const additions = [];
  const receiptCandidates = candidates.filter((candidate) => candidate.source === "managed_experiment_receipt");
  const byPromptVersion = new Map();
  for (const candidate of receiptCandidates) {
    if (!candidate.prompt_version_id) continue;
    const list = byPromptVersion.get(candidate.prompt_version_id) || [];
    list.push(candidate);
    byPromptVersion.set(candidate.prompt_version_id, list);
  }
  const taggedByTarget = new Map();
  for (const tag of tagScan.tags || []) {
    if (tag.status !== "tagged_candidate") {
      additions.push(setCandidateStatus({
        candidate_key: `phoenix-tag:${tag.prompt_name || tag.prompt_id || "unknown"}:${tag.prompt_version_id || "unknown"}`,
        source: "phoenix_prompt_candidate_tag",
        candidate_target_key: tag.candidate_target_key ?? null,
        candidate_version_id: tag.prompt_version_id ?? null,
        prompt_version_id: tag.prompt_version_id ?? null,
        evidence: { managed_receipt: false, phoenix_candidate_tag: true },
      }, "needs_reconciliation", tag.reason, tag.detail ?? null));
      continue;
    }
    taggedByTarget.set(tag.candidate_target_key, tag);
    const matches = byPromptVersion.get(tag.prompt_version_id) || [];
    if (matches.length === 0) {
      additions.push(setCandidateStatus({
        candidate_key: `phoenix-tag:${tag.candidate_target_key}:${tag.prompt_version_id}`,
        source: "phoenix_prompt_candidate_tag",
        candidate_target_key: tag.candidate_target_key,
        candidate_version_id: tag.prompt_version_id,
        prompt_version_id: tag.prompt_version_id,
        evidence: { managed_receipt: false, phoenix_candidate_tag: true },
      }, "needs_reconciliation", "lost_receipt_phoenix_native_ambiguity",
      `candidate tag ${tag.tag_name} points at prompt version ${tag.prompt_version_id}, but no managed receipt or authenticated registration provides the required experiment join`));
      continue;
    }
    if (matches.length > 1) {
      additions.push(setCandidateStatus({
        candidate_key: `phoenix-tag:${tag.candidate_target_key}:${tag.prompt_version_id}`,
        source: "phoenix_prompt_candidate_tag",
        candidate_target_key: tag.candidate_target_key,
        candidate_version_id: tag.prompt_version_id,
        prompt_version_id: tag.prompt_version_id,
        evidence: { managed_receipt: true, phoenix_candidate_tag: true },
      }, "needs_reconciliation", "ambiguous_prompt_tag_receipt_join",
      `${matches.length} managed receipts point at prompt version ${tag.prompt_version_id}`));
      for (const candidate of matches) {
        setCandidateStatus(candidate, "needs_reconciliation", "ambiguous_prompt_tag_receipt_join", tag.prompt_version_id);
      }
      continue;
    }
    const [candidate] = matches;
    candidate.evidence.phoenix_candidate_tag = true;
    candidate.evidence.phoenix_candidate_tag_detail = tag;
    if (candidate.receipt_state?.state === "withdrawn") {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "withdrawn_receipt_still_tagged",
        `receipt ${candidate.receipt_id} is withdrawn but Phoenix prompt version ${tag.prompt_version_id} still carries ${tag.tag_name}`,
      );
    } else if (candidate.receipt_state?.intent !== SCANNER_MANAGED_RECEIPT_INTENT) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "receipt_intent_conflicts_with_phoenix_tag",
        `receipt ${candidate.receipt_id} intent is ${candidate.receipt_state?.intent}, while the Phoenix tag declares prompt candidate intent`,
      );
    } else if (candidate.candidate_target_key !== tag.candidate_target_key) {
      setCandidateStatus(
        candidate,
        "needs_reconciliation",
        "prompt_candidate_tag_target_mismatch",
        `receipt target ${candidate.candidate_target_key} does not match policy target ${tag.candidate_target_key}`,
      );
    }
  }

  for (const candidate of receiptCandidates) {
    if (!candidate.prompt_version_id || !candidate.candidate_target_key) continue;
    const tag = taggedByTarget.get(candidate.candidate_target_key);
    if (!tag || tag.prompt_version_id === candidate.prompt_version_id) continue;
    setCandidateStatus(
      candidate,
      "needs_reconciliation",
      "prompt_candidate_tag_mismatch",
      `Phoenix candidate tag for ${candidate.candidate_target_key} points at ${tag.prompt_version_id}, but receipt ${candidate.receipt_id} points at ${candidate.prompt_version_id}`,
    );
  }

  return additions;
}
