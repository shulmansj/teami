import { readLinearCache } from "../cache.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import { createLinearCredentialStore } from "../linear-credential-store.mjs";
import { createLinearSetupGraphqlClient } from "../linear-setup-auth.mjs";
import {
  emptyTeamRegistry,
  readTeamRegistry,
} from "../team-registry.mjs";
import { buildTeamContext } from "../team-resolver.mjs";
import {
  createLocalTriggerStore,
  localTriggerStorePath,
  readLocalTriggerState,
} from "../local-trigger-store.mjs";
import {
  AF_REVIEW_STATUS_CONTEXT,
  createDefaultExecutionPullRequestAdapter,
} from "../execution-pr-adapter.mjs";
import { resourcesToRepoIdentity } from "../review-pr-discovery.mjs";
import { issueHasLabel } from "./matching-utils.mjs";
import { decideMergeGateAction } from "./merge-gate-decision.mjs";
import { lookupHumanReviewBriefingComment } from "../review/teami-review-effects.mjs";

const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]);
const WORK_ACTIVE_OR_GATED_ROLES = new Set(["todo", "in_progress", "in_review", "human_review", "needs_principal"]);
const IN_FLIGHT_ROLES = new Set(["todo", "in_progress", "in_review", "needs_principal"]);

export async function collectHumanReviewGateStatusReport({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  config,
  registry = readTeamRegistry({ home }) || emptyTeamRegistry(),
  store = createLocalTriggerStore({ repoRoot, home }),
  createLinearClient = createReadOnlyLinearClient,
  createPrAdapter = ({ repoIdentity }) => createDefaultExecutionPullRequestAdapter({ repoIdentity }),
  now = () => new Date(),
} = {}) {
  const activeTeams = (registry?.teams || []).filter((team) => team.status === "active");
  const warnings = [];
  const records = safeParkRecords(store, warnings);
  const runRecords = safeRunRecords(home, warnings);
  const itemsByIssue = new Map();

  for (const team of activeTeams) {
    const teamContext = buildTeamContext({ team, config, repoRoot, home });
    const cache = readLinearCache(teamContext.linear.cachePath);
    if (!cache) {
      warnings.push({
        team_ref: team.id,
        reason: "linear cache missing; human-review gate status skipped for this team",
      });
      continue;
    }

    let client;
    try {
      client = await createLinearClient({ config, repoRoot, team, teamContext });
    } catch (error) {
      warnings.push({
        team_ref: team.id,
        reason: `Linear read unavailable: ${safeErrorMessage(error)}`,
      });
      continue;
    }

    await collectTeamIssues({
      config,
      team,
      teamContext,
      cache,
      client,
      records,
      itemsByIssue,
      warnings,
    });
  }

  for (const record of records) {
    if (itemsByIssue.has(record.issue_id)) continue;
    itemsByIssue.set(record.issue_id, baseGateStatusItem({
      issueId: record.issue_id,
      parkRecord: record,
      issueMissing: true,
      readError: "Linear issue was not found in active teams",
    }));
  }

  const items = [];
  for (const item of itemsByIssue.values()) {
    items.push(await hydrateGateStatusItem({
      item,
      store,
      createPrAdapter,
      warnings,
      now,
    }));
  }

  return {
    ...deriveHumanReviewGateStatusReport({
      items,
      runRecords,
      now,
    }),
    warnings,
    sources: {
      active_team_count: activeTeams.length,
      park_record_count: records.length,
      run_record_count: runRecords.length,
    },
  };
}

export function deriveHumanReviewGateStatusReport({
  items = [],
  runRecords = [],
  now = () => new Date(),
} = {}) {
  const normalizedItems = items.map(normalizeGateStatusItem);
  return {
    generated_at: toDate(typeof now === "function" ? now() : now).toISOString(),
    queue: deriveGateQueue(normalizedItems, { now }),
    reconciliation: deriveGateReconciliation(normalizedItems),
    verdicts: deriveGateVerdicts({ items: normalizedItems, runRecords }),
  };
}

export function deriveGateQueue(items = [], { now = () => new Date() } = {}) {
  return items
    .filter((item) => item.issue_status_role === "human_review")
    .map((item) => {
      const decision = gateDecisionForItem(item);
      return {
        kind: "queue",
        team_ref: item.team_ref,
        issue_id: item.issue_id,
        identifier: item.identifier,
        title: item.title,
        pr_number: prNumberForItem(item),
        parked_head_sha: item.park_record?.parked_head_sha || null,
        parked_at: item.park_record?.parked_at || null,
        age_ms: ageMs(item.park_record?.parked_at, now),
        reason: decision?.reason || "issue is in Principal Review",
      };
    })
    .sort(compareQueueRows);
}

export function deriveGateReconciliation(items = []) {
  const rows = [];
  for (const item of items) {
    rows.push(...classifyGateReconciliationItem(item));
  }
  return rows.sort(compareReconciliationRows);
}

export function classifyGateReconciliationItem(input = {}) {
  const item = normalizeGateStatusItem(input);
  const rows = [];
  const decision = gateDecisionForItem(item);
  const reason = decision?.reason || item.read_error || "human-review gate status needs attention";
  const base = reconciliationBase(item, reason);

  if (item.issue_missing) {
    return [{
      ...base,
      category: "orphaned",
      severity: "warning",
      reason: item.read_error || "orphaned park record: Linear issue is absent",
    }];
  }

  if (item.read_error) {
    return [{
      ...base,
      category: "read_warning",
      severity: "warning",
      reason: item.read_error,
    }];
  }

  if (isCanceledIssue(item)) {
    rows.push({
      ...base,
      category: "orphaned",
      severity: "warning",
      reason: "orphaned park record: Linear issue is canceled",
    });
  }

  if (item.park_record && item.pr_state === "closed" && !WORK_ACTIVE_OR_GATED_ROLES.has(item.issue_status_role)) {
    rows.push({
      ...base,
      category: "orphaned",
      severity: "warning",
      reason: "orphaned park record: PR is closed without merging and the issue is not active or gated",
    });
  }

  if (item.park_record && IN_FLIGHT_ROLES.has(item.issue_status_role) && item.pr_state === "open") {
    rows.push({
      ...base,
      category: "in_flight",
      severity: "info",
      reason: "park record follows active work; leave it in place",
    });
  }

  if (item.issue_status_role === "human_review" && item.park_record && item.gate_label_present === false) {
    rows.push({
      ...base,
      category: "label_changed_while_parked",
      severity: "warning",
      reason,
    });
  }

  if (item.issue_status_role === "human_review" && item.park_record && item.briefing_status === "missing") {
    rows.push({
      ...base,
      category: "missing_briefing",
      severity: "warning",
      reason: "human review briefing is missing for the parked head",
    });
  }

  if (item.park_record && item.issue_status_role === "human_review" && gateHeadDrifted(item)) {
    rows.push({
      ...base,
      category: "drift_churn",
      severity: "warning",
      reason,
    });
  }

  if (item.park_record && item.issue_status_role === "done") {
    if (item.pr_state === "merged") {
      rows.push({
        ...base,
        category: headMatchesParked(item) ? "landed_done" : "shipped_outside_gate",
        severity: headMatchesParked(item) ? "success" : "warning",
        reason,
      });
    } else if (item.pr_state === "open") {
      rows.push({
        ...base,
        category: headMatchesParked(item) ? "unvetted_done" : "drift_churn",
        severity: "warning",
        reason: headMatchesParked(item)
          ? "issue is Done but the parked PR has not landed yet"
          : reason,
      });
    }
  }

  if (decision?.action === "surface") {
    rows.push({
      ...base,
      category: "surface",
      severity: "warning",
      reason,
    });
  }

  return dedupeReconciliationRows(rows);
}

export function deriveGateVerdicts({ items = [], runRecords = [] } = {}) {
  const verdicts = [];
  const seen = new Set();
  const normalizedItems = items.map(normalizeGateStatusItem);
  for (const run of mergeOutcomeRuns(runRecords)) {
    const outcome = run.merge_outcome;
    if (outcome.outcome === "merged") {
      pushVerdict(verdicts, seen, {
        verdict: "accepted",
        issue_id: outcome.issue_id,
        pr_number: outcome.pr_number,
        head_sha: outcome.head_sha,
        run_id: run.run_id || null,
        observed_at: outcome.observed_at,
        reason: outcome.reason,
      });
    }
    if (outcome.outcome === "failed" && hasLiveParkRecordForOutcome(normalizedItems, outcome)) {
      pushVerdict(verdicts, seen, {
        verdict: "accepted_landing_failed",
        issue_id: outcome.issue_id,
        pr_number: outcome.pr_number,
        head_sha: outcome.head_sha,
        run_id: run.run_id || null,
        observed_at: outcome.observed_at,
        reason: outcome.reason,
      });
    }
  }

  for (const item of normalizedItems) {
    if (!item.park_record || item.issue_status_role !== "todo" || !item.latest_execution_run) continue;
    pushVerdict(verdicts, seen, {
      verdict: "sent_back",
      issue_id: item.issue_id,
      pr_number: item.park_record.pr_number,
      head_sha: item.park_record.parked_head_sha,
      run_id: item.latest_execution_run.run_id || null,
      observed_at: item.latest_execution_run.started_at || item.latest_execution_run.terminal_at || item.park_record.parked_at,
      reason: item.latest_execution_run.terminal_reason || "todo re-entry run observed",
    });
  }

  return verdicts.sort(compareVerdicts);
}

function hasLiveParkRecordForOutcome(items, outcome = {}) {
  return items.some((item) =>
    item.park_record?.issue_id === outcome.issue_id &&
    item.park_record?.pr_number === outcome.pr_number &&
    item.park_record?.parked_head_sha === outcome.head_sha
  );
}

async function collectTeamIssues({
  config = null,
  team,
  teamContext,
  cache,
  client,
  records,
  itemsByIssue,
  warnings,
} = {}) {
  const gateLabelId = humanReviewLabelId({ cache, config });
  const humanReviewStateId = cache?.issueStatuses?.human_review || null;

  const candidates = [];
  if (gateLabelId && typeof client.listIssues === "function") {
    candidates.push(...await readIssueList({
      client,
      teamRef: team.id,
      warnings,
      query: { teamId: team.linear.team_id, labelId: gateLabelId },
      source: "human_review_label",
    }));
  }
  if (humanReviewStateId && typeof client.listIssues === "function") {
    candidates.push(...await readIssueList({
      client,
      teamRef: team.id,
      warnings,
      query: { teamId: team.linear.team_id, stateId: humanReviewStateId },
      source: "human_review_status",
    }));
  }

  const recordByIssue = new Map(records.map((record) => [record.issue_id, record]));
  for (const record of records) {
    if (candidates.some((issue) => issue?.id === record.issue_id)) continue;
    const issue = await readIssueOrNull(client, record.issue_id);
    if (issue) candidates.push(issue);
  }

  for (const issue of candidates) {
    if (!issue?.id) continue;
    const existing = itemsByIssue.get(issue.id);
    if (existing && existing.park_record) continue;
    const item = baseGateStatusItem({
      teamRef: team.id,
      teamContext,
      cache,
      issue,
      issueId: issue.id,
      parkRecord: recordByIssue.get(issue.id) || null,
      gateLabelId,
      client,
    });
    itemsByIssue.set(issue.id, item);
  }
}

async function hydrateGateStatusItem({
  item,
  store,
  createPrAdapter,
  warnings,
} = {}) {
  const next = { ...item };
  if (next.issue_missing) return normalizeGateStatusItem(next);

  next.latest_execution_run = latestExecutionRun(store, next.issue_id);
  const prNumber = prNumberForItem(next);
  if (!prNumber) return normalizeGateStatusItem(next);

  let adapter;
  try {
    const repoIdentity = resourcesToRepoIdentity(next.team_context, {
      resourceId: next.issue?.resource_target?.id,
    });
    adapter = await createPrAdapter({ repoIdentity, item: next });
  } catch (error) {
    next.read_error = `GitHub PR adapter unavailable: ${safeErrorMessage(error)}`;
    warnings.push({ issue_id: next.issue_id, reason: next.read_error });
    return normalizeGateStatusItem(next);
  }

  try {
    const pullRequest = await adapter.getPullRequest(prNumber);
    next.current_head_sha = pullRequestHeadSha(pullRequest);
    next.pr_state = derivePrState(pullRequest);
    const statuses = await adapter.getCommitStatuses(next.current_head_sha);
    const status = latestAfReviewStatus(statuses);
    next.check_state = checkStateForAfReviewStatus(status);
    next.check_head_sha = next.check_state === "absent" ? null : next.current_head_sha;
  } catch (error) {
    next.read_error = `GitHub PR state unavailable: ${safeErrorMessage(error)}`;
    warnings.push({ issue_id: next.issue_id, reason: next.read_error });
  }

  next.latest_merge_run = latestMergeRun(store, {
    issueId: next.issue_id,
    prNumber,
    headSha: next.park_record?.parked_head_sha || next.current_head_sha,
  });

  if (next.park_record && next.issue_status_role === "human_review") {
    next.briefing_status = await readBriefingStatus({
      store,
      client: next.client,
      issueId: next.issue_id,
      headSha: next.park_record.parked_head_sha,
      warnings,
    });
  }

  return normalizeGateStatusItem(next);
}

function baseGateStatusItem({
  teamRef = null,
  teamContext = null,
  cache = null,
  issue = null,
  issueId,
  parkRecord = null,
  gateLabelId = null,
  client = null,
  issueMissing = false,
  readError = null,
} = {}) {
  return {
    team_ref: teamRef,
    team_context: teamContext,
    cache,
    client,
    issue,
    issue_id: issueId,
    identifier: issue?.identifier || null,
    title: issue?.title || null,
    issue_status_role: issueMissing ? null : issueStatusRole(issue, cache),
    issue_state_type: issue?.state?.type || null,
    gate_label_present: gateLabelId ? issueHasLabel(issue, gateLabelId) : false,
    park_record: parkRecord,
    issue_missing: issueMissing,
    read_error: readError,
    pr_number: parkRecord?.pr_number || null,
    current_head_sha: null,
    check_state: "absent",
    check_head_sha: null,
    pr_state: "open",
    briefing_status: "unknown",
    latest_execution_run: null,
    latest_merge_run: null,
  };
}

async function readIssueList({ client, teamRef, warnings, query, source }) {
  try {
    return await client.listIssues(query);
  } catch (error) {
    warnings.push({
      team_ref: teamRef,
      reason: `${source} issue read failed: ${safeErrorMessage(error)}`,
    });
    return [];
  }
}

async function readIssueOrNull(client, issueId) {
  try {
    if (typeof client.getIssue === "function") return await client.getIssue(issueId);
    if (typeof client.getIssueContext === "function") return await client.getIssueContext(issueId);
  } catch {
    return null;
  }
  return null;
}

async function readBriefingStatus({ store, client, issueId, headSha, warnings } = {}) {
  if (typeof store?.briefingRecords !== "function") return "unknown";
  if (typeof client?.listIssueComments !== "function") return "unknown";
  try {
    const lookup = await lookupHumanReviewBriefingComment({
      store,
      client,
      review: { issue_id: issueId, head_sha: headSha },
    });
    return lookup.status === "found" ? "found" : "missing";
  } catch (error) {
    warnings.push({
      issue_id: issueId,
      reason: `human review briefing lookup failed: ${safeErrorMessage(error)}`,
    });
    return "unknown";
  }
}

function safeParkRecords(store, warnings) {
  try {
    if (typeof store?.parkRecords !== "function") throw new Error("parkRecords method missing");
    const records = store.parkRecords();
    return Array.isArray(records) ? records : [];
  } catch (error) {
    warnings.push({ reason: `park records could not be read: ${safeErrorMessage(error)}` });
    return [];
  }
}

function safeRunRecords(home, warnings) {
  try {
    return readLocalTriggerState(localTriggerStorePath(home)).runs || [];
  } catch (error) {
    warnings.push({ reason: `local trigger run records could not be read: ${safeErrorMessage(error)}` });
    return [];
  }
}

function latestExecutionRun(store, issueId) {
  try {
    if (typeof store?.findLatestRunForObject !== "function") return null;
    return store.findLatestRunForObject(issueId);
  } catch {
    return null;
  }
}

function latestMergeRun(store, { issueId, prNumber, headSha } = {}) {
  try {
    if (typeof store?.findLatestMergeRunForIssuePrHead !== "function") return null;
    if (!issueId || !prNumber || !headSha) return null;
    return store.findLatestMergeRunForIssuePrHead({ issueId, prNumber, headSha });
  } catch {
    return null;
  }
}

async function createReadOnlyLinearClient({
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamContext,
  createSetupGraphqlClient = createLinearSetupGraphqlClient,
} = {}) {
  const credentialStore = createLinearCredentialStore({
    config,
    repoRoot,
    home,
    teamContext,
    promoteLegacyOnRead: false,
  });
  return createSetupGraphqlClient({
    config,
    repoRoot,
    credentialStore,
    teamContext,
    allowBrowserAuth: false,
    allowRefresh: false,
  }).client;
}

function normalizeGateStatusItem(item = {}) {
  const parkRecord = item.park_record || item.parkRecord || null;
  const currentHeadSha = stringOrNull(item.current_head_sha || item.currentHeadSha);
  const checkState = item.check_state || item.checkState || "absent";
  const prState = item.pr_state || item.prState || "open";
  return {
    ...item,
    team_ref: stringOrNull(item.team_ref || item.teamRef),
    issue_id: stringOrNull(item.issue_id || item.issueId),
    identifier: stringOrNull(item.identifier),
    title: stringOrNull(item.title),
    issue_status_role: stringOrNull(item.issue_status_role || item.issueStatusRole),
    issue_state_type: stringOrNull(item.issue_state_type || item.issueStateType),
    gate_label_present: item.gate_label_present ?? item.gateLabelPresent ?? false,
    park_record: parkRecord ? {
      issue_id: parkRecord.issue_id || parkRecord.issueId || item.issue_id || item.issueId,
      pr_number: Number(parkRecord.pr_number ?? parkRecord.prNumber),
      parked_head_sha: stringOrNull(parkRecord.parked_head_sha || parkRecord.parkedHeadSha),
      parked_at: stringOrNull(parkRecord.parked_at || parkRecord.parkedAt),
    } : null,
    issue_missing: item.issue_missing === true || item.issueMissing === true,
    read_error: stringOrNull(item.read_error || item.readError),
    pr_number: positiveInteger(item.pr_number ?? item.prNumber ?? parkRecord?.pr_number ?? parkRecord?.prNumber),
    current_head_sha: currentHeadSha,
    check_state: checkState === "green" || checkState === "red" ? checkState : "absent",
    check_head_sha: stringOrNull(item.check_head_sha || item.checkHeadSha),
    pr_state: prState === "merged" || prState === "closed" ? prState : "open",
    briefing_status: ["found", "missing", "unknown"].includes(item.briefing_status || item.briefingStatus)
      ? item.briefing_status || item.briefingStatus
      : "unknown",
    latest_execution_run: item.latest_execution_run || item.latestExecutionRun || null,
    latest_merge_run: item.latest_merge_run || item.latestMergeRun || null,
  };
}

function gateDecisionForItem(item = {}) {
  const normalized = normalizeGateStatusItem(item);
  if (!normalized.issue_status_role && !normalized.park_record) return null;
  return decideMergeGateAction({
    issueStatusRole: normalized.issue_status_role,
    gateLabelPresent: Boolean(normalized.gate_label_present),
    parkRecord: normalized.park_record
      ? {
          parked_head_sha: normalized.park_record.parked_head_sha,
          pr_number: normalized.park_record.pr_number,
        }
      : null,
    currentHeadSha: normalized.current_head_sha,
    checkState: normalized.check_state,
    checkHeadSha: normalized.check_head_sha,
    prState: normalized.pr_state,
  });
}

function reconciliationBase(item, reason) {
  return {
    team_ref: item.team_ref,
    issue_id: item.issue_id,
    identifier: item.identifier,
    title: item.title,
    issue_status_role: item.issue_status_role,
    pr_number: prNumberForItem(item),
    parked_head_sha: item.park_record?.parked_head_sha || null,
    current_head_sha: item.current_head_sha || null,
    pr_state: item.pr_state,
    observed_at: item.park_record?.parked_at || null,
    reason,
  };
}

function dedupeReconciliationRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.issue_id}:${row.category}:${row.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function mergeOutcomeRuns(runRecords = []) {
  return (Array.isArray(runRecords) ? runRecords : [])
    .filter((run) => run?.workflow_type === "merge" && run?.merge_outcome)
    .sort((left, right) =>
      Date.parse(right.merge_outcome.observed_at || "") - Date.parse(left.merge_outcome.observed_at || ""));
}

function pushVerdict(verdicts, seen, verdict) {
  const key = `${verdict.verdict}:${verdict.issue_id}:${verdict.pr_number}:${verdict.head_sha}:${verdict.run_id}`;
  if (seen.has(key)) return;
  seen.add(key);
  verdicts.push(verdict);
}

function issueStatusRole(issue = {}, cache = null) {
  const stateId = stringOrNull(issue?.state?.id || issue?.stateId || issue?.state_id);
  if (!stateId) return null;
  for (const role of ISSUE_STATUS_ROLES) {
    if (cache?.issueStatuses?.[role] === stateId) return role;
  }
  return null;
}

function humanReviewLabelId({ cache = null, config = null } = {}) {
  const labelName = stringOrNull(config?.linear?.issue?.labels?.human_review);
  if (labelName && cache?.issueLabels?.[labelName]) return stringOrNull(cache.issueLabels[labelName]);
  return stringOrNull(cache?.issueLabels?.human_review);
}

function latestAfReviewStatus(statuses) {
  if (!Array.isArray(statuses)) return null;
  let latest = null;
  statuses.forEach((status, index) => {
    if (!status || typeof status !== "object" || Array.isArray(status)) return;
    if (status.context !== AF_REVIEW_STATUS_CONTEXT || !status.state) return;
    const candidate = { status, index, time: timestamp(status.created_at) };
    if (!latest || isLaterStatus(candidate, latest)) latest = candidate;
  });
  return latest?.status || null;
}

function checkStateForAfReviewStatus(status) {
  if (!status) return "absent";
  if (status.state === "success") return "green";
  if (status.state === "failure" || status.state === "error") return "red";
  return "absent";
}

function derivePrState(pullRequest) {
  const state = stringOrNull(pullRequest?.state)?.toLowerCase();
  if (state === "open") return "open";
  if (state === "closed") {
    if (pullRequest?.merged === true || pullRequest?.merged_at != null) return "merged";
    return "closed";
  }
  return "open";
}

function pullRequestHeadSha(pullRequest) {
  return stringOrNull(pullRequest?.head?.sha || pullRequest?.head_sha || pullRequest?.headSha);
}

function isLaterStatus(left, right) {
  const leftHasTime = Number.isFinite(left.time);
  const rightHasTime = Number.isFinite(right.time);
  if (leftHasTime && rightHasTime && left.time !== right.time) return left.time > right.time;
  if (leftHasTime !== rightHasTime) return leftHasTime;
  return left.index > right.index;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isCanceledIssue(item) {
  const type = String(item.issue_state_type || "").toLowerCase();
  return type === "canceled" || type === "cancelled";
}

function gateHeadDrifted(item) {
  return !headMatchesParked(item) || item.check_state === "absent";
}

function headMatchesParked(item) {
  return Boolean(item.park_record?.parked_head_sha && item.park_record.parked_head_sha === item.current_head_sha);
}

function prNumberForItem(item = {}) {
  return positiveInteger(item.pr_number ?? item.prNumber ?? item.park_record?.pr_number ?? item.parkRecord?.pr_number);
}

function ageMs(parkedAt, now = () => new Date()) {
  const parked = Date.parse(parkedAt || "");
  if (!Number.isFinite(parked)) return null;
  const current = toDate(typeof now === "function" ? now() : now).getTime();
  return Math.max(0, current - parked);
}

function compareQueueRows(left, right) {
  const leftTime = Date.parse(left.parked_at || "");
  const rightTime = Date.parse(right.parked_at || "");
  const leftSort = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
  const rightSort = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
  return leftSort - rightSort || String(left.issue_id || "").localeCompare(String(right.issue_id || ""));
}

function compareReconciliationRows(left, right) {
  return severityRank(right.severity) - severityRank(left.severity)
    || String(left.category || "").localeCompare(String(right.category || ""))
    || String(left.issue_id || "").localeCompare(String(right.issue_id || ""));
}

function compareVerdicts(left, right) {
  const timeDiff = Date.parse(right.observed_at || "") - Date.parse(left.observed_at || "");
  if (timeDiff !== 0) return timeDiff;
  return String(left.issue_id || "").localeCompare(String(right.issue_id || ""));
}

function severityRank(value) {
  if (value === "warning") return 3;
  if (value === "info") return 2;
  if (value === "success") return 1;
  return 0;
}

function safeErrorMessage(error) {
  return String(error?.message || error || "unknown_error").slice(0, 240);
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}
