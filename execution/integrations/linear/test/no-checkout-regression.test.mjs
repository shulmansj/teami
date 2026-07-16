import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TEAMI_PROJECT_MCP_TOOL_NAMES } from "../src/project-mcp-tools.mjs";
import {
  assertNoCheckoutDirectory,
  connectNoCheckoutMcpServer,
  createNoCheckoutFixture,
  gatewayLockIsUnderHome,
  runCredentialRoundTripFromNoCheckoutCwds,
  runNoCheckoutGatewayStart,
} from "./no-checkout-harness.mjs";

test("repo-less MCP, gateway lock, and file credentials persist from no-checkout cwds", async () => {
  const fixture = createNoCheckoutFixture();
  try {
    await assertAllMcpToolsWorkFromNoCheckoutCwd(fixture);

    const gateway = await runNoCheckoutGatewayStart(fixture);
    assert.equal(gateway.liveLock.live, true);
    assert.equal(gateway.liveLock.lock.pid > 0, true);
    assert.equal(gatewayLockIsUnderHome(fixture.home), true);
    assert.equal(gateway.result.code, 0, `${gateway.result.stdout}\n${gateway.result.stderr}`);
    if (gateway.result.stdout) assert.match(gateway.result.stdout, /Gateway completed/);
    else assert.equal(gateway.result.status, "completed");

    const roundTrip = await runCredentialRoundTripFromNoCheckoutCwds(fixture);
    assert.deepEqual(roundTrip.read.tokenSet, roundTrip.expectedTokenSet);
    assert.notEqual(roundTrip.written.cwd, roundTrip.read.cwd);
    assert.equal(roundTrip.written.target, roundTrip.read.target);

    for (const cwd of [
      fixture.cwdMcp,
      fixture.cwdGateway,
      fixture.cwdTokenWrite,
      fixture.cwdTokenRead,
    ]) {
      assertNoCheckoutDirectory(cwd);
      assert.equal(fs.existsSync(path.join(cwd, "gateway.lock")), false);
    }
  } finally {
    fixture.cleanup();
  }
});

async function assertAllMcpToolsWorkFromNoCheckoutCwd(fixture) {
  const mcp = await connectNoCheckoutMcpServer(fixture);
  try {
    const listed = await mcp.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...TEAMI_PROJECT_MCP_TOOL_NAMES].sort(),
    );

    const onboarding = await mcp.client.callTool({
      name: "init_onboarding",
      arguments: {},
    });
    assert.equal(onboarding.isError, undefined, JSON.stringify(onboarding.structuredContent));
    assert.equal(onboarding.structuredContent.ok, false);
    assert.deepEqual(onboarding.structuredContent.needs.map((need) => need.field), ["confirm"]);
    assert.deepEqual(onboarding.structuredContent.defaults, {
      team: fixture.team.teamRef,
      product_repositories: "none",
    });
    assert.equal(Object.hasOwn(onboarding.structuredContent, "authorization_url"), false);

    const resolved = await mcp.client.callTool({
      name: "resolve_team",
      arguments: { team: fixture.team.teamRef },
    });
    assert.equal(resolved.isError, undefined, JSON.stringify(resolved.structuredContent));
    assert.equal(resolved.structuredContent.team.team_ref, fixture.team.teamRef);
    assert.equal(resolved.structuredContent.cache.present, true);

    const created = await mcp.client.callTool({
      name: "project_create",
      arguments: {
        team: fixture.team.teamRef,
        name: "No-checkout planning project",
        description: "Created by a repo-less regression harness.",
      },
    });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
    assert.equal(created.structuredContent.status.id, "status-backlog");

    const projectId = created.structuredContent.project.id;
    const body = "## Problem Or Opportunity\n\nFounders should not need a Teami checkout to plan work.\n";
    const written = await mcp.client.callTool({
      name: "project_write_body",
      arguments: {
        team: fixture.team.teamRef,
        project_id: projectId,
        content: body,
      },
    });
    assert.equal(written.isError, undefined, JSON.stringify(written.structuredContent));
    assert.equal(written.structuredContent.content_length, body.length);

    const moved = await mcp.client.callTool({
      name: "project_move_status",
      arguments: {
        team: fixture.team.teamRef,
        project_id: projectId,
        confirm: true,
      },
    });
    assert.equal(moved.isError, undefined, JSON.stringify(moved.structuredContent));
    assert.equal(moved.structuredContent.status.id, "status-planned");
  } finally {
    await mcp.close();
  }
}
