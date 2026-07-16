import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTeamConfinedPlanningMutations } from "../src/team-confined-planning-mutations.mjs";
import { formatCommand } from "../src/cli/operator-output.mjs";

const createError = (code, message, repair) => Object.assign(new Error(message), { code, repair });

test("planning mutation repair uses the runnable launcher for its package context", () => {
  assert.throws(
    () => createTeamConfinedPlanningMutations({ client: {}, context: {}, createError }),
    (error) => {
      assert.equal(error.code, "project_team_unresolved");
      assert.equal(error.repair, `Run ${formatCommand("doctor")}, resolve the intended team, then retry.`);
      assert.doesNotMatch(error.repair, /Run teami doctor/);
      return true;
    },
  );
});

test("planning mutation adapter injects the resolved team and validates every update before mutation", async () => {
  const calls = [];
  const client = {
    createProject: async (input) => {
      calls.push(["create", input]);
      return { id: "project-1", ...input };
    },
    getProject: async (id) => {
      calls.push(["read", id]);
      return { id, teamIds: ["team-1"] };
    },
    updateProject: async (id, patch) => {
      calls.push(["update", id, patch]);
      return { id, ...patch };
    },
  };
  const mutations = createTeamConfinedPlanningMutations({
    client,
    context: { linear: { teamId: "team-1" } },
    createError,
  });
  await mutations.createProject({ name: "Plan", teamIds: ["attacker-team"] });
  await mutations.updateProject("project-1", { content: "bounded" });
  assert.deepEqual(calls, [
    ["create", { name: "Plan", teamIds: ["team-1"] }],
    ["read", "project-1"],
    ["update", "project-1", { content: "bounded" }],
  ]);
});

test("planning mutation adapter fails outside-team updates before the mutation call", async () => {
  let updated = false;
  const mutations = createTeamConfinedPlanningMutations({
    client: {
      getProject: async (id) => ({ id, teamIds: ["team-2"] }),
      updateProject: async () => { updated = true; },
      createProject: async () => ({}),
    },
    context: { linear: { teamId: "team-1" } },
    createError,
  });
  await assert.rejects(() => mutations.updateProject("project-1", {}), (error) => error.code === "project_outside_team");
  assert.equal(updated, false);
});

test("MCP planning tools have no direct Linear project mutation bypass", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/project-mcp-tools.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /prepared\.client\.(?:create|update|archive|delete)Project\s*\(/);
  for (const tool of ["project_create", "project_write_body", "project_move_status"]) {
    const start = source.indexOf(`async function ${tool}`);
    const end = source.indexOf("\n  async function ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);
    assert.match(body, /prepared\.mutations\.(?:createProject|updateProject)\s*\(/, `${tool} must use the confined adapter`);
  }
});
