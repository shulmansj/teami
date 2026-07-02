import {
  collectLocalProposalResumeItems,
  collectLocalRunResumeItems,
  collectScannerResumeItems,
  collectSupervisorResumeItems,
} from "./resume-collectors.mjs";

export const NEXT_RESUME_RECONCILIATION_SCHEMA_VERSION =
  "teami-next-resume-reconciliation/v1";

export const PROVISIONAL_PM_STATES = Object.freeze([
  "Working",
  "Needs your decision",
  "Blocked but safe",
  "Proposal ready",
]);

const DEFAULT_NEXT_RESUME_AGED_MS = 2 * 60 * 60_000;

export async function collectNextResumeReconciliation({
  repoRoot = process.cwd(),
  now = () => new Date(),
  agedAfterMs = DEFAULT_NEXT_RESUME_AGED_MS,
} = {}) {
  const observedAtDate = asDate(now());
  const observedAt = observedAtDate.toISOString();
  const itemsById = new Map();
  const sources = [];
  const addItem = (item) => {
    if (!PROVISIONAL_PM_STATES.includes(item.pm_state)) {
      throw new Error(`invalid provisional PM state: ${item.pm_state}`);
    }
    const id = item.id || `${item.source}:${item.classification}:${item.ref}`;
    if (itemsById.has(id)) return;
    itemsById.set(id, {
      id,
      pm_state: item.pm_state,
      classification: item.classification,
      source: item.source,
      ref: item.ref,
      reason: item.reason,
      detail: item.detail ?? null,
      observed_at: item.observed_at ?? null,
      age_ms: item.age_ms ?? null,
      next_surface: item.next_surface ?? null,
    });
  };

  collectSupervisorResumeItems({ repoRoot, observedAtDate, agedAfterMs, sources, addItem });
  collectScannerResumeItems({ repoRoot, observedAtDate, agedAfterMs, sources, addItem });
  collectLocalRunResumeItems({ repoRoot, sources, addItem });
  collectLocalProposalResumeItems({ repoRoot, sources, addItem });

  const items = [...itemsById.values()].sort(compareReconciliationItems);
  const summary = {
    item_count: items.length,
    by_pm_state: countBy(items, "pm_state", PROVISIONAL_PM_STATES),
    by_classification: countBy(items, "classification"),
  };
  return {
    schema_version: NEXT_RESUME_RECONCILIATION_SCHEMA_VERSION,
    _note:
      "Derived read-time status only. It is not persisted to Phoenix or Linear and is never authority for queue, budget, dedupe, or acceptance.",
    ok: summary.by_pm_state["Blocked but safe"] === 0,
    generated_at: observedAt,
    thresholds: { aged_after_ms: agedAfterMs },
    summary,
    items,
    sources,
  };
}

export function formatNextResumeReconciliationReport(report) {
  const lines = [];
  lines.push(
    `next-resume reconciliation: ${report.summary.item_count} item(s) - derived, read-only, not persisted`,
  );
  lines.push(`  PM states: ${formatPmStateCounts(report.summary.by_pm_state)}`);
  const unavailableSources = report.sources
    .filter((source) => source.status === "unavailable" || source.status === "unreadable")
    .map((source) => `${source.id}=${source.reason || source.status}`);
  if (unavailableSources.length > 0) {
    lines.push(`  degraded sources: ${unavailableSources.join(", ")}`);
  }
  if (report.summary.item_count === 0) {
    lines.push("  no aged, expired, dead-lettered, resumed, proposal, or attention work found");
    return lines;
  }
  for (const item of report.items) {
    lines.push(
      `  - ${item.pm_state} [${item.classification}] ${item.ref}: ${item.reason}`,
    );
    if (item.detail) lines.push(`    ${item.detail}`);
    if (item.next_surface) lines.push(`    surface: ${item.next_surface}`);
  }
  lines.push("  external actions: no gateway work claimed, no Linear writes, no GitHub writes");
  return lines;
}

function compareReconciliationItems(a, b) {
  const pmDelta = pmStateRank(a.pm_state) - pmStateRank(b.pm_state);
  if (pmDelta !== 0) return pmDelta;
  const classDelta = classificationRank(a.classification) - classificationRank(b.classification);
  if (classDelta !== 0) return classDelta;
  return String(a.ref).localeCompare(String(b.ref));
}

function pmStateRank(state) {
  return {
    "Needs your decision": 0,
    "Proposal ready": 1,
    "Blocked but safe": 2,
    Working: 3,
  }[state] ?? 99;
}

function classificationRank(classification) {
  return {
    attention: 0,
    "proposal-ready": 1,
    "dead-lettered": 2,
    expired: 3,
    aged: 4,
    resumed: 5,
    working: 6,
  }[classification] ?? 99;
}

function formatPmStateCounts(counts) {
  return PROVISIONAL_PM_STATES
    .map((state) => `${state}=${counts?.[state] || 0}`)
    .join(", ");
}

function countBy(items, key, orderedKeys = null) {
  const counts = {};
  if (orderedKeys) {
    for (const entry of orderedKeys) counts[entry] = 0;
  }
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function asDate(value) {
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) return new Date();
  return candidate;
}

export { formatPmStateCounts };
