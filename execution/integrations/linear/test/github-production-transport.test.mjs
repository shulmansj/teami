import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createProductionGitHubPromotionTransport } from "../src/github-production-transport.mjs";

test("production GitHub transport stays dry-run unless the connection state is real", () => {
  const selection = createProductionGitHubPromotionTransport({
    repoIdentity: { connection_mode: "dry_run" },
  });
  assert.equal(selection.mode, "dry_run");
  assert.equal(selection.transport.kind, "dry_run");
});

test("production GitHub transport resolves local ambient mode for verified real connections", () => {
  const selection = createProductionGitHubPromotionTransport({
    repoRoot: "C:/Users/example/factory",
    repoIdentity: {
      connection_mode: "real",
      repo: { owner: "acme", repo: "teami" },
      repo_id: "R_repo_teami_1",
      default_branch: "main",
      checkout_path: "C:/Users/example/factory",
      push_auth: "ssh",
      real_push_enabled: true,
    },
  });
  assert.equal(selection.mode, "local_ambient");
  assert.equal(selection.transport.kind, "local_ambient");
  assert.equal(selection.owner, "acme");
  assert.equal(selection.repo, "teami");
  assert.equal(selection.defaultBranch, "main");
  assert.equal(selection.checkoutPath, "C:/Users/example/factory");
  assert.equal(selection.pushAuth, "ssh");
  assert.equal(selection.realPushEnabled, true);
});

test("verified real connections default to https push auth and disabled real push until init proves it", () => {
  const selection = createProductionGitHubPromotionTransport({
    repoIdentity: {
      connection_mode: "real",
      repo: { owner: "acme", repo: "teami" },
      repo_id: "R_repo_teami_1",
    },
  });
  assert.equal(selection.mode, "local_ambient");
  assert.equal(selection.pushAuth, "https");
  assert.equal(selection.realPushEnabled, false);
});

test("local ambient transport shells the five PR operations plus immutable repository identity through gh api", async () => {
  const { spawnImpl, calls } = fakeGhSpawn((call) => {
    if (call.args[0] === "auth") return { stdout: "github.com logged in\n" };
    if (call.args.includes("state=open")) {
      return { stdout: JSON.stringify([[{ number: 1 }], [{ number: 2 }]]) };
    }
    if (call.args.includes("state=closed")) return { stdout: JSON.stringify([[]]) };
    const apiPath = call.args.find((arg) => arg.startsWith("repos/"));
    if (call.args.includes("GET") && apiPath === "repos/acme/teami") {
      return { stdout: JSON.stringify({ id: 12345, node_id: "R_repo_teami_1", name: "teami" }) };
    }
    if (call.args.includes("--method") && call.args.includes("POST")) {
      return { stdout: JSON.stringify({ number: 3, title: "Ship local gh", state: "open" }) };
    }
    if (call.args.includes("--method") && call.args.includes("PATCH")) {
      return { stdout: JSON.stringify({ number: 3, body: "updated body" }) };
    }
    return { stdout: JSON.stringify({ number: 2, state: "open" }) };
  });
  const selection = createProductionGitHubPromotionTransport({
    repoRoot: "C:/Users/example/factory",
    env: {
      PATH: "path-value",
      GH_TOKEN: "ghp_secret123456789",
      GITHUB_TOKEN: "github_pat_secret123456789",
      GIT_ASKPASS: "askpass-helper",
      SSH_AUTH_SOCK: "ssh-agent-sock",
      UNRELATED_VALUE: "keep-me",
    },
    repoIdentity: {
      connection_mode: "real",
      repo: { owner: "acme", repo: "teami" },
      repo_id: "R_repo_teami_1",
      push_auth: "ssh",
    },
    spawnImpl,
  });

  const listOpen = await request(selection.transport, "list_open_pull_requests", "GET", "/repos/{owner}/{repo}/pulls");
  const listClosed = await request(selection.transport, "list_closed_pull_requests", "GET", "/repos/{owner}/{repo}/pulls");
  const getPr = await request(selection.transport, "get_pull_request", "GET", "/repos/{owner}/{repo}/pulls/{number}", { number: 2 });
  const identity = await request(selection.transport, "get_repository_identity", "GET", "/repos/{owner}/{repo}");
  const createPr = await request(selection.transport, "create_pull_request", "POST", "/repos/{owner}/{repo}/pulls", {
    title: "Ship local gh",
    head: "proposal/af-123/agent",
    base: "main",
    body: "created body",
    draft: true,
  });
  const updatePr = await request(selection.transport, "update_pull_request_body", "PATCH", "/repos/{owner}/{repo}/pulls/{number}", {
    number: 3,
    body: "updated body",
  });

  assert.deepEqual(listOpen, { data: [{ number: 1 }, { number: 2 }] });
  assert.deepEqual(listClosed, { data: [] });
  assert.deepEqual(getPr, { data: { number: 2, state: "open" } });
  assert.equal(identity.data.id, "R_repo_teami_1");
  assert.equal(identity.data.node_id, "R_repo_teami_1");
  assert.deepEqual(createPr, { data: { number: 3, title: "Ship local gh", state: "open" } });
  assert.deepEqual(updatePr, { data: { number: 3, body: "updated body" } });
  assert.deepEqual(calls.map((call) => call.args[0]), [
    "auth", "api",
    "auth", "api",
    "auth", "api",
    "auth", "api",
    "auth", "api",
    "auth", "api",
  ]);
  for (const call of calls) {
    assert.equal(call.command, "gh");
    assert.equal(call.options.cwd, "C:/Users/example/factory");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.GH_PROMPT_DISABLED, "1");
    assert.equal(call.options.env.UNRELATED_VALUE, "keep-me");
    assert.equal(call.options.env.SSH_AUTH_SOCK, "ssh-agent-sock");
    assert.equal(Object.hasOwn(call.options.env, "GH_TOKEN"), false);
    assert.equal(Object.hasOwn(call.options.env, "GITHUB_TOKEN"), false);
    assert.equal(Object.hasOwn(call.options.env, "GIT_ASKPASS"), false);
  }

  const apiCalls = calls.filter((call) => call.args[0] === "api");
  assert.deepEqual(apiCalls[0].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "GET",
    "repos/acme/teami/pulls",
    "-f",
    "state=open",
    "-F",
    "per_page=100",
    "--paginate",
    "--slurp",
  ]);
  assert.deepEqual(apiCalls[1].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "GET",
    "repos/acme/teami/pulls",
    "-f",
    "state=closed",
    "-F",
    "per_page=100",
    "--paginate",
    "--slurp",
  ]);
  assert.deepEqual(apiCalls[2].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "GET",
    "repos/acme/teami/pulls/2",
  ]);
  assert.deepEqual(apiCalls[3].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "GET",
    "repos/acme/teami",
  ]);
  assert.deepEqual(apiCalls[4].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "POST",
    "repos/acme/teami/pulls",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(apiCalls[4].stdin), {
    title: "Ship local gh",
    head: "proposal/af-123/agent",
    base: "main",
    body: "created body",
    draft: true,
  });
  assert.deepEqual(apiCalls[5].args, [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--method",
    "PATCH",
    "repos/acme/teami/pulls/3",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(apiCalls[5].stdin), { body: "updated body" });
});

test("real promotion transport fails closed without the approved immutable repository ID", () => {
  assert.throws(
    () => createProductionGitHubPromotionTransport({
      repoIdentity: {
        connection_mode: "real",
        repo: { owner: "acme", repo: "teami" },
      },
    }),
    /github_durable_repo_identity_required/,
  );
});

test("local ambient transport rejects malformed gh api stdout", async () => {
  const { spawnImpl } = fakeGhSpawn((call) => {
    if (call.args[0] === "auth") return { stdout: "ok\n" };
    return { stdout: "not-json" };
  });
  const selection = realSelection({ spawnImpl });

  await assert.rejects(
    () => request(selection.transport, "get_pull_request", "GET", "/repos/{owner}/{repo}/pulls/{number}", { number: 7 }),
    /github_api_request_failed:get_pull_request:malformed_json/,
  );
});

test("local ambient transport rejects unexpected gh api stdout shape", async () => {
  const { spawnImpl } = fakeGhSpawn((call) => {
    if (call.args[0] === "auth") return { stdout: "ok\n" };
    return { stdout: JSON.stringify({ number: 1 }) };
  });
  const selection = realSelection({ spawnImpl });

  await assert.rejects(
    () => request(selection.transport, "list_open_pull_requests", "GET", "/repos/{owner}/{repo}/pulls"),
    /github_api_request_failed:list_open_pull_requests:unexpected_response_shape/,
  );
});

test("local ambient transport discards gh failure diagnostics", async () => {
  const leakedToken = "ghp_secret123456789";
  const { spawnImpl } = fakeGhSpawn((call) => {
    if (call.args[0] === "auth") {
      return { code: 1, stderr: `GITHUB_TOKEN=${leakedToken}` };
    }
    return { stdout: "{}" };
  });
  const selection = realSelection({ spawnImpl });

  await assert.rejects(
    () => request(selection.transport, "get_pull_request", "GET", "/repos/{owner}/{repo}/pulls/{number}", { number: 7 }),
    (error) => {
      assert.match(error.message, /github_api_request_failed:get_pull_request:auth_status:exit_1/);
      assert.equal(error.message.includes(leakedToken), false);
      assert.equal(error.message.includes("GITHUB_TOKEN"), false);
      assert.match(error.message, /gh_command_failed/);
      return true;
    },
  );
});

test("timed-out GitHub mutations expose reconciliation-required handling", async () => {
  const selection = createProductionGitHubPromotionTransport({
    repoIdentity: {
      connection_mode: "real",
      repo: { owner: "acme", repo: "teami" },
      repo_id: "R_repo_teami_1",
    },
    runSubprocess: async ({ operation }) => operation === "gh_auth_read"
      ? { ok: true, stdout: "authenticated", stderr: "", status: 0, signal: null }
      : {
          ok: false,
          stdout: "",
          stderr: "[captured failure output redacted: command timed out]",
          status: null,
          signal: "SIGKILL",
          outcome: "reconciliation_required",
          reconciliationRequired: true,
          failureCode: null,
        },
  });

  await assert.rejects(
    () => request(selection.transport, "create_pull_request", "POST", "/repos/{owner}/{repo}/pulls", {
      title: "Title",
      body: "Body",
      head: "branch",
      base: "main",
    }),
    (error) => {
      assert.equal(error.reconciliationRequired, true);
      assert.equal(error.outcome, "reconciliation_required");
      return true;
    },
  );
});

function realSelection({ spawnImpl }) {
  return createProductionGitHubPromotionTransport({
    repoIdentity: {
      connection_mode: "real",
      repo: { owner: "acme", repo: "teami" },
      repo_id: "R_repo_teami_1",
    },
    spawnImpl,
  });
}

function request(transport, endpointId, method, path, params = {}) {
  return transport.request({
    endpointId,
    method,
    path,
    owner: "acme",
    repo: "teami",
    params,
  });
}

function fakeGhSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(chunk) {
        call.stdin += chunk.toString("utf8");
      },
      end() {
        call.stdinEnded = true;
      },
    };
    child.kill = () => {
      child.killed = true;
    };
    setImmediate(() => {
      const response = handler(call) || {};
      if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout, "utf8"));
      if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr, "utf8"));
      if (response.error) {
        child.emit("error", response.error);
        return;
      }
      child.emit("close", response.code ?? 0, response.signal ?? null);
    });
    return child;
  };
  return { spawnImpl, calls };
}
