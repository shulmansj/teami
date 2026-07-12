import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyGateReconciliationItem,
  deriveHumanReviewGateStatusReport,
} from "../src/linear/human-review-gate-status.mjs";
import { decideMergeGateAction } from "../src/linear/merge-gate-decision.mjs";

const fixturePath = path.join(
  import.meta.dirname,
  "fixtures",
  "human-review-gate-status",
  "report-cases.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("human review gate status derives queue ages and reconciliation categories from frozen fixtures", () => {
  const report = deriveHumanReviewGateStatusReport({
    items: fixture.items,
    runRecords: fixture.run_records,
    now: () => new Date(fixture.now),
  });

  const queue = rowByIssue(report.queue);
  assert.equal(queue.get("issue-queue").age_ms, 2 * 60 * 60 * 1000);
  assert.equal(
    queue.get("issue-queue").reason,
    "parked head is still green and labeled; wait for human acceptance",
  );

  const reconciliation = rowsByCategory(report.reconciliation);
  assert.equal(
    only(reconciliation, "missing_briefing", "issue-missing-briefing").reason,
    "human review briefing is missing for the parked head",
  );
  assert.equal(
    only(reconciliation, "label_changed_while_parked", "issue-label-removed").reason,
    "deliberate un-gate: human-review label was removed while parked",
  );
  assert.equal(
    only(reconciliation, "drift_churn", "issue-drift").reason,
    "parked review is stale or missing; move back to In Review",
  );
  assert.equal(
    only(reconciliation, "unvetted_done", "issue-unvetted-done").reason,
    "issue is Done but the parked PR has not landed yet",
  );
  assert.equal(
    only(reconciliation, "landed_done", "issue-landed-done").reason,
    "parked head already landed; finish park-record cleanup",
  );
  assert.equal(only(reconciliation, "in_flight", "issue-todo-open").issue_status_role, "todo");

  const orphanedIssues = (reconciliation.get("orphaned") || []).map((row) => row.issue_id).sort();
  assert.deepEqual(orphanedIssues, ["issue-absent", "issue-closed-done"]);
  assert.equal((reconciliation.get("orphaned") || []).some((row) => row.issue_id === "issue-todo-open"), false);
});

test("human review gate status derives the three report verdicts without bounded recency", () => {
  const report = deriveHumanReviewGateStatusReport({
    items: fixture.items,
    runRecords: fixture.run_records,
    now: () => new Date(fixture.now),
  });

  const verdicts = rowsByVerdict(report.verdicts);
  assert.deepEqual(only(verdicts, "accepted", "issue-accepted-no-record"), {
    verdict: "accepted",
    issue_id: "issue-accepted-no-record",
    pr_number: 21,
    head_sha: "6666666666666666666666666666666666666666",
    run_id: "run-accepted-old",
    observed_at: "2026-06-01T00:05:00.000Z",
    reason: "parked head merged",
  });
  assert.equal(
    only(verdicts, "sent_back", "issue-sent-back").observed_at,
    "2026-07-02T05:30:00.000Z",
  );
  assert.equal(
    only(verdicts, "accepted_landing_failed", "issue-landing-failed").reason,
    "GitHub refused the merge because the PR was not mergeable.",
  );
});

test("reconciliation surface reasons stay verbatim from the merge gate decision table", () => {
  const item = {
    issue_id: "issue-shipped-outside",
    issue_status_role: "done",
    gate_label_present: true,
    park_record: {
      issue_id: "issue-shipped-outside",
      pr_number: 23,
      parked_head_sha: "8888888888888888888888888888888888888888",
      parked_at: "2026-07-03T01:00:00.000Z",
    },
    pr_number: 23,
    current_head_sha: "9999999999999999999999999999999999999999",
    check_state: "green",
    check_head_sha: "9999999999999999999999999999999999999999",
    pr_state: "merged",
  };
  const expected = decideMergeGateAction({
    issueStatusRole: "done",
    gateLabelPresent: true,
    parkRecord: {
      parked_head_sha: "8888888888888888888888888888888888888888",
      pr_number: 23,
    },
    currentHeadSha: "9999999999999999999999999999999999999999",
    checkState: "green",
    checkHeadSha: "9999999999999999999999999999999999999999",
    prState: "merged",
  }).reason;

  const rows = classifyGateReconciliationItem(item);
  assert.equal(rows.find((row) => row.category === "shipped_outside_gate").reason, expected);
  assert.equal(rows.find((row) => row.category === "surface").reason, expected);
});

test("reconciliation read failures surface as warnings without placeholder PR classification", () => {
  const rows = classifyGateReconciliationItem({
    issue_id: "issue-read-failed",
    issue_status_role: "done",
    gate_label_present: true,
    read_error: "GitHub PR state unavailable: network blocked",
    park_record: {
      issue_id: "issue-read-failed",
      pr_number: 24,
      parked_head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parked_at: "2026-07-03T01:00:00.000Z",
    },
  });

  assert.deepEqual(rows.map((row) => row.category), ["read_warning"]);
  assert.equal(rows[0].reason, "GitHub PR state unavailable: network blocked");
});

test("needs_principal is active for reconciliation while unknown statuses fail closed", () => {
  const parked = {
    issue_id: "issue-escalated",
    pr_number: 25,
    parked_head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    parked_at: "2026-07-03T01:00:00.000Z",
  };
  const escalatedRows = classifyGateReconciliationItem({
    issue_id: "issue-escalated",
    issue_status_role: "needs_principal",
    gate_label_present: true,
    park_record: parked,
    pr_number: 25,
    current_head_sha: parked.parked_head_sha,
    check_state: "green",
    check_head_sha: parked.parked_head_sha,
    pr_state: "open",
  });

  assert.deepEqual(escalatedRows.map((row) => row.category), ["in_flight"]);
  assert.equal(escalatedRows[0].issue_status_role, "needs_principal");

  const unknownRows = classifyGateReconciliationItem({
    issue_id: "issue-unknown-status",
    issue_status_role: null,
    gate_label_present: true,
    park_record: { ...parked, issue_id: "issue-unknown-status" },
    pr_number: 25,
    current_head_sha: parked.parked_head_sha,
    check_state: "green",
    check_head_sha: parked.parked_head_sha,
    pr_state: "open",
  });

  assert.deepEqual(unknownRows.map((row) => row.category), ["surface"]);
});

function rowByIssue(rows) {
  return new Map(rows.map((row) => [row.issue_id, row]));
}

function rowsByCategory(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.category)) grouped.set(row.category, []);
    grouped.get(row.category).push(row);
  }
  return grouped;
}

function rowsByVerdict(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.verdict)) grouped.set(row.verdict, []);
    grouped.get(row.verdict).push(row);
  }
  return grouped;
}

function only(grouped, key, issueId) {
  const matches = (grouped.get(key) || []).filter((row) => row.issue_id === issueId);
  assert.equal(matches.length, 1, `${key} should have one row for ${issueId}`);
  return matches[0];
}
