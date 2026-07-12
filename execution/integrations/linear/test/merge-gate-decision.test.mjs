import assert from "node:assert/strict";
import test from "node:test";

import { decideMergeGateAction } from "../src/linear/merge-gate-decision.mjs";

const PARK_RECORD = Object.freeze({
  parked_head_sha: "head-a",
  pr_number: 7,
});

test("decideMergeGateAction covers representative rows from the merge gate table", () => {
  const cases = [
    {
      row: "1",
      name: "in_review green at current without gate label merges",
      input: snapshot(),
      expected: { action: "merge" },
    },
    {
      row: "2",
      name: "in_review green at current with gate label parks",
      input: snapshot({ gateLabelPresent: true }),
      expected: { action: "park" },
    },
    {
      row: "3",
      name: "in_review red review does nothing",
      input: snapshot({ gateLabelPresent: true, checkState: "red" }),
      expected: { action: "none" },
    },
    {
      row: "3b",
      name: "in_review absent review evidence does nothing",
      input: snapshot({ gateLabelPresent: true, checkState: "absent", checkHeadSha: null }),
      expected: { action: "none" },
    },
    {
      row: "4",
      name: "human_review parked green labeled waits for the human",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
      }),
      expected: { action: "none" },
    },
    {
      row: "5",
      name: "human_review parked green with label removed merges",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: false,
        parkRecord: PARK_RECORD,
      }),
      expected: { action: "merge" },
    },
    {
      row: "6",
      name: "human_review head drift invalidates",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
        currentHeadSha: "head-b",
        checkHeadSha: "head-a",
      }),
      expected: { action: "invalidate" },
    },
    {
      row: "6b",
      name: "human_review missing check invalidates even without head drift",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
        checkState: "absent",
        checkHeadSha: null,
      }),
      expected: { action: "invalidate" },
    },
    {
      row: "7",
      name: "human_review without a park record surfaces out of order",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: true,
        parkRecord: null,
      }),
      expected: { action: "surface", reasonIncludes: "out of order" },
    },
    {
      row: "8",
      name: "done with accepted parked open head merges",
      input: snapshot({
        issueStatusRole: "done",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
      }),
      expected: { action: "merge" },
    },
    {
      row: "8b",
      name: "done acceptance ignores label removal and still merges parked head",
      input: snapshot({
        issueStatusRole: "done",
        gateLabelPresent: false,
        parkRecord: PARK_RECORD,
      }),
      expected: { action: "merge" },
    },
    {
      row: "9",
      name: "done already merged at parked head cleans up",
      input: snapshot({
        issueStatusRole: "done",
        parkRecord: PARK_RECORD,
        prState: "merged",
        checkState: "absent",
        checkHeadSha: null,
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "10",
      name: "done merged at a different head with label present surfaces and keeps record",
      input: snapshot({
        issueStatusRole: "done",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
        currentHeadSha: "head-b",
        prState: "merged",
      }),
      expected: { action: "surface", reasonIncludes: "shipped outside the gate" },
    },
    {
      row: "11",
      name: "done merged at a different head with label absent cleans up",
      input: snapshot({
        issueStatusRole: "done",
        gateLabelPresent: false,
        parkRecord: PARK_RECORD,
        currentHeadSha: "head-b",
        prState: "merged",
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "12",
      name: "done open PR with drift bounces to in_review",
      input: snapshot({
        issueStatusRole: "done",
        parkRecord: PARK_RECORD,
        currentHeadSha: "head-b",
        checkHeadSha: "head-a",
      }),
      expected: { action: "bounce", bounceTo: "in_review" },
    },
    {
      row: "13",
      name: "done closed unmerged bounces to todo",
      input: snapshot({
        issueStatusRole: "done",
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "bounce", bounceTo: "todo" },
    },
    {
      row: "14",
      name: "send-back status with park record does nothing",
      input: snapshot({
        issueStatusRole: "todo",
        parkRecord: PARK_RECORD,
        checkState: "red",
      }),
      expected: { action: "none" },
    },
    {
      row: "14b",
      name: "in_progress send-back with park record does nothing",
      input: snapshot({
        issueStatusRole: "in_progress",
        parkRecord: PARK_RECORD,
        checkState: "red",
      }),
      expected: { action: "none" },
    },
    {
      row: "14c",
      name: "needs_principal send-back with park record does nothing",
      input: snapshot({
        issueStatusRole: "needs_principal",
        parkRecord: PARK_RECORD,
        checkState: "absent",
        checkHeadSha: null,
      }),
      expected: { action: "none" },
    },
    {
      row: "16",
      name: "in_review with a park record on a closed unmerged PR deletes the dead record instead of parking",
      input: snapshot({
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "16b",
      name: "in_review with a park record on a closed unmerged PR deletes the dead record instead of merging",
      input: snapshot({
        gateLabelPresent: false,
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "17",
      name: "human_review parked on a closed unmerged PR invalidates instead of waiting",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: true,
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "invalidate", reasonIncludes: "closed without merging" },
    },
    {
      row: "17b",
      name: "human_review un-gate on a closed unmerged PR invalidates instead of merging",
      input: snapshot({
        issueStatusRole: "human_review",
        gateLabelPresent: false,
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "invalidate", reasonIncludes: "closed without merging" },
    },
    {
      row: "18",
      name: "todo send-back with a park record on a closed unmerged PR deletes the dead record",
      input: snapshot({
        issueStatusRole: "todo",
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "18b",
      name: "in_progress send-back with a park record on a closed unmerged PR deletes the dead record",
      input: snapshot({
        issueStatusRole: "in_progress",
        parkRecord: PARK_RECORD,
        prState: "closed",
        checkState: "absent",
        checkHeadSha: null,
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "18c",
      name: "needs_principal send-back with a park record on a closed unmerged PR deletes the dead record",
      input: snapshot({
        issueStatusRole: "needs_principal",
        parkRecord: PARK_RECORD,
        prState: "closed",
      }),
      expected: { action: "none", deleteParkRecord: true },
    },
    {
      row: "15",
      name: "unrecognized combination surfaces with the combination named",
      input: snapshot({
        issueStatusRole: "backlog",
        parkRecord: null,
      }),
      expected: { action: "surface", reasonIncludes: "status=backlog" },
    },
    {
      row: "15b",
      name: "unvetted Done without a park record surfaces",
      input: snapshot({
        issueStatusRole: "done",
        parkRecord: null,
      }),
      expected: { action: "surface", reasonIncludes: "status=done" },
    },
  ];

  const observed = cases.map(({ row, name, input, expected }) => {
    const result = decideMergeGateAction(input);
    assert.equal(result.action, expected.action, `${row}: ${name}`);
    assert.equal(typeof result.reason, "string", `${row}: reason is a plain string`);
    assert.notEqual(result.reason.trim(), "", `${row}: reason is populated`);

    if (expected.reasonIncludes) assert.match(result.reason, new RegExp(expected.reasonIncludes), `${row}: reason`);
    if (expected.bounceTo) assert.equal(result.bounceTo, expected.bounceTo, `${row}: bounce target`);
    else assert.equal(Object.hasOwn(result, "bounceTo"), false, `${row}: no bounce target`);

    if (expected.deleteParkRecord) assert.equal(result.deleteParkRecord, true, `${row}: deletes park record`);
    else assert.equal(Object.hasOwn(result, "deleteParkRecord"), false, `${row}: does not delete park record`);

    return { row, result };
  });

  assert.deepEqual(
    observed.filter(({ result }) => result.deleteParkRecord === true).map(({ row }) => row),
    ["9", "11", "16", "16b", "18", "18b", "18c"],
  );
  assert.equal(Object.hasOwn(observed.find(({ row }) => row === "10").result, "deleteParkRecord"), false);
});

test("decideMergeGateAction is pure over its input snapshot", () => {
  const input = deepFreeze(snapshot({
    issueStatusRole: "human_review",
    gateLabelPresent: true,
    parkRecord: { parked_head_sha: "head-a", pr_number: 7 },
  }));
  const before = structuredClone(input);

  const first = decideMergeGateAction(input);
  const second = decideMergeGateAction(input);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
});

function snapshot(overrides = {}) {
  return {
    issueStatusRole: "in_review",
    gateLabelPresent: false,
    parkRecord: null,
    currentHeadSha: "head-a",
    checkState: "green",
    checkHeadSha: "head-a",
    prState: "open",
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
