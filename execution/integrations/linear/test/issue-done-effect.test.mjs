import assert from "node:assert/strict";
import test from "node:test";

import { applyCommitEffects } from "../../../engine/commit-effects.mjs";
import {
  LINEAR_ISSUE_DONE_EFFECT_ID,
  issueDoneEffect,
  verifyIssueDoneEffect,
} from "../src/linear/issue-done-effect.mjs";

test("linear_issue_done moves only the target issue to cached Done from each dispatch source", async () => {
  for (const sourceRole of ["in_review", "human_review"]) {
    const issue = issueForRole({ id: `issue-${sourceRole}`, role: sourceRole });
    const sibling = issueForRole({ id: `sibling-${sourceRole}`, role: sourceRole });
    const client = createLinearClient({
      issues: [issue, sibling],
      extraStates: [{ id: "state-done-cached", name: "Done", type: "completed", teamId: "team-1" }],
    });

    const result = await applyCommitEffects({
      effects: [issueDoneEffect],
      ctx: {
        client,
        config: configWithIssueStatuses(),
        cache: cacheForRoles(sourceRole),
        issue,
        expected_source_role: sourceRole,
        runId: `run-done-${sourceRole}`,
        store: forbiddenStore(),
        prAdapter: forbiddenPrAdapter(),
      },
    });

    assert.equal(result.outcome, "ok", sourceRole);
    assert.deepEqual(linearUpdates(client), [{
      method: "updateIssue",
      id: issue.id,
      input: { stateId: "state-done-cached" },
    }], sourceRole);
    assert.equal(issue.state.id, "state-done-cached", sourceRole);
    assert.equal(sibling.state.id, stateForRole(sourceRole).id, sourceRole);
    assert.deepEqual(result.applied, [{
      id: LINEAR_ISSUE_DONE_EFFECT_ID,
      identity: {
        linear_issue_id: issue.id,
        issue_id: issue.id,
        issue_key: issue.identifier,
        target_type: "status",
        target_id: "state-done-cached",
        status: "Done",
        status_id: "state-done-cached",
        state_id: "state-done-cached",
      },
    }], sourceRole);
  }
});

test("linear_issue_done skips as success when the issue already left the expected source", async () => {
  const staleIssue = issueForRole({ id: "issue-skip", role: "in_review" });
  const liveIssue = issueForRole({ id: "issue-skip", role: "todo" });
  const client = createLinearClient({
    issues: [liveIssue],
    extraStates: [{ id: "state-done-cached", name: "Done", type: "completed", teamId: "team-1" }],
  });
  const trace = { spans: [] };
  const ctx = {
    client,
    config: configWithIssueStatuses(),
    cache: cacheForRoles("in_review"),
    issue: staleIssue,
    expected_source_role: "in_review",
    runId: "run-done-skip",
    store: forbiddenStore(),
    prAdapter: forbiddenPrAdapter(),
  };

  const result = await applyCommitEffects({
    effects: [issueDoneEffect],
    ctx,
    trace,
  });

  assert.equal(result.outcome, "ok");
  assert.deepEqual(linearUpdates(client), []);
  assert.equal(liveIssue.state.id, "state-todo");
  assert.ok(client.events.some((event) => event.method === "getIssue"), "guard must fresh-read Linear");
  assert.equal(
    trace.spans.find((span) => span.name === "commit_effect_apply")?.attributes.outcome,
    "ok",
  );
  assert.equal(
    trace.spans.find((span) => span.name === "commit_effect_verify")?.attributes.outcome,
    "ok",
  );
  assert.deepEqual(await verifyIssueDoneEffect(ctx), {
    ok: true,
    skipped: true,
    reason: "linear_issue_done_source_mismatch",
  });
});

test("linear_issue_done fails closed when dispatch does not supply an expected source role", async () => {
  for (const role of ["in_review", "done"]) {
    const issue = issueForRole({ id: `issue-missing-source-${role}`, role });
    const client = createLinearClient({
      issues: [issue],
      extraStates: [{ id: "state-done-cached", name: "Done", type: "completed", teamId: "team-1" }],
    });

    const result = await applyCommitEffects({
      effects: [issueDoneEffect],
      ctx: {
        client,
        config: configWithIssueStatuses(),
        cache: cacheForRoles("in_review"),
        issue,
        runId: `run-done-source-missing-${role}`,
        store: forbiddenStore(),
        prAdapter: forbiddenPrAdapter(),
      },
    });

    assert.equal(result.outcome, "failed_closed", role);
    assert.equal(result.pending_effect_id, LINEAR_ISSUE_DONE_EFFECT_ID, role);
    assert.equal(result.reason, "linear_issue_done_expected_source_role_missing", role);
    assert.deepEqual(linearUpdates(client), [], role);
  }
});

function createLinearClient({ issues, extraStates = [] }) {
  const issueMap = new Map(issues.map((issue) => [issue.id, issue]));
  const states = new Map(
    ["backlog", "todo", "in_progress", "in_review", "human_review", "needs_principal", "done"]
      .map((role) => [stateForRole(role).id, stateForRole(role)]),
  );
  for (const state of extraStates) states.set(state.id, state);
  const events = [];
  return {
    events,
    async listWorkflowStates(teamId) {
      events.push({ method: "listWorkflowStates", teamId });
      assert.equal(teamId, "team-1");
      return [...states.values()];
    },
    async getIssue(id) {
      events.push({ method: "getIssue", id });
      assert.ok(issueMap.has(id), `unknown issue: ${id}`);
      return issueMap.get(id);
    },
    async updateIssue(id, input) {
      events.push({ method: "updateIssue", id, input });
      assert.ok(issueMap.has(id), `unknown issue: ${id}`);
      const issue = issueMap.get(id);
      if (input.stateId) {
        assert.ok(states.has(input.stateId), `unknown state: ${input.stateId}`);
        issue.state = states.get(input.stateId);
      }
      return issue;
    },
  };
}

function issueForRole({ id, role }) {
  return {
    id,
    identifier: `${role.toUpperCase()}-123`,
    teamId: "team-1",
    state: stateForRole(role),
    labels: [],
  };
}

function linearUpdates(client) {
  return client.events.filter((event) => event.method === "updateIssue");
}

function cacheForRoles(sourceRole) {
  return {
    teamId: "team-1",
    issueStatuses: {
      [sourceRole]: stateForRole(sourceRole).id,
      done: "state-done-cached",
    },
  };
}

function stateForRole(role) {
  const states = {
    backlog: { id: "state-backlog", name: "Backlog", type: "backlog", teamId: "team-1" },
    todo: { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1" },
    in_progress: { id: "state-in-progress", name: "In Progress", type: "started", teamId: "team-1" },
    in_review: { id: "state-in-review", name: "In Review", type: "started", teamId: "team-1" },
    human_review: { id: "state-human-review", name: "Principal Review", type: "started", teamId: "team-1" },
    needs_principal: { id: "state-needs-principal", name: "Principal Escalation", type: "started", teamId: "team-1" },
    done: { id: "state-done", name: "Done", type: "completed", teamId: "team-1" },
  };
  return { ...states[role] };
}

function configWithIssueStatuses() {
  return {
    linear: {
      issue: {
        labels: {
          discovery: "Discovery",
          needs_principal: "Needs Principal",
          human_review: "human-review",
        },
        statuses: {
          backlog: { name: "Backlog", type: "backlog" },
          todo: { name: "Todo", type: "unstarted" },
          in_progress: { name: "In Progress", type: "started" },
          in_review: { name: "In Review", type: "started" },
          human_review: { name: "Principal Review", type: "started" },
          needs_principal: { name: "Principal Escalation", type: "started" },
          done: { name: "Done", type: "completed" },
        },
      },
    },
  };
}

function forbiddenStore() {
  return {
    parkRecords() {
      throw new Error("linear_issue_done_must_not_read_park_records");
    },
    findLatestRunForObject() {
      throw new Error("linear_issue_done_must_not_read_run_records");
    },
  };
}

function forbiddenPrAdapter() {
  return {
    getPullRequest() {
      throw new Error("linear_issue_done_must_not_read_pr_state");
    },
    getCommitStatuses() {
      throw new Error("linear_issue_done_must_not_read_commit_statuses");
    },
  };
}
