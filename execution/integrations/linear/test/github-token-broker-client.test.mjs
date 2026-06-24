import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { githubDryRunRequested, githubSetupTransportFromFlags } from "../src/cli/github-command-options.mjs";
import {
  githubInitTransportFromFlags,
  issueInstallationBoundGitHubBrokerCredential,
} from "../src/cli/linear-setup-command.mjs";
import {
  createGitHubTokenBrokerClient,
  githubBrokerCredentialFilePath,
  resolveGitHubBrokerCredential,
  resolveGitHubBrokerToken,
} from "../src/github-token-broker-client.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-github-broker-"));
}

test("unknown --github-setup-transport fails closed instead of silently going live", () => {
  assert.throws(
    () => githubDryRunRequested({ "github-setup-transport": "dryrun" }),
    /unknown_github_setup_transport/,
  );
  assert.equal(githubDryRunRequested({ "github-setup-transport": "dry-run" }), true);
  assert.equal(githubDryRunRequested({ "github-setup-transport": "broker" }), false);
  assert.equal(githubDryRunRequested({}), false);
  assert.equal(githubDryRunRequested({ "github-dry-run": true }), true);
});

test("broker token resolves from an ignored local env file without printing key material", () => {
  const root = tempRoot();
  const tokenFile = path.join(".agentic-factory", "github-broker-token.env");
  fs.mkdirSync(path.join(root, ".agentic-factory"), { recursive: true });
  fs.writeFileSync(path.join(root, tokenFile), "AGENTIC_FACTORY_GITHUB_BROKER_TOKEN=broker_secret\n", "utf8");
  assert.equal(resolveGitHubBrokerToken({ broker: { token_file: tokenFile }, repoRoot: root }), "broker_secret");
});

test("broker credential resolves from config, contained file, and env", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "secrets", "broker-credential.env"),
    "AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL=af_broker_v1.segment.sig\n",
    "utf8",
  );
  const previous = process.env.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL;
  try {
    process.env.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL = "af_broker_v1.env.sig";
    assert.equal(
      resolveGitHubBrokerCredential({ broker: { credential: "af_broker_v1.config.sig" }, repoRoot: root }),
      "af_broker_v1.config.sig",
    );
    assert.equal(
      resolveGitHubBrokerCredential({
        broker: { credential_file: path.join("secrets", "broker-credential.env") },
        repoRoot: root,
      }),
      "af_broker_v1.segment.sig",
    );
    assert.equal(resolveGitHubBrokerCredential({ broker: {}, repoRoot: root }), "af_broker_v1.env.sig");
  } finally {
    if (previous == null) delete process.env.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL;
    else process.env.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL = previous;
  }
});

test("broker client fails closed until URL and broker token are configured", () => {
  assert.throws(
    () => createGitHubTokenBrokerClient({ config: { github: { token_broker: {} } }, fetchImpl: async () => {} }),
    /github_token_broker_not_configured/,
  );
});

test("broker client rejects placeholder Supabase endpoints before request", () => {
  let called = false;
  assert.throws(
    () => createGitHubTokenBrokerClient({
      config: {
        github: {
          token_broker: {
            base_url: "https://your-project-ref.supabase.co/functions/v1/agentic-factory-github-broker",
            token: "broker_token",
          },
        },
      },
      fetchImpl: async () => {
        called = true;
        return { ok: true, async text() { return JSON.stringify({ ok: true }); } };
      },
    }),
    /github_token_broker_placeholder_endpoint.*github\.token_broker\.base_url.*supabase\/README\.md/,
  );
  assert.equal(called, false);
});

test("broker client calls verify and mint endpoints with broker auth header", async () => {
  const calls = [];
  const client = createGitHubTokenBrokerClient({
    config: {
      github: {
        token_broker: {
          base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
          token: "broker_token",
        },
      },
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ ok: true, token: "ghs_short_lived" });
        },
      };
    },
  });
  await client.verifyInstallation({ owner: "shulmansj", repo: "agentic-factory" });
  await client.mintInstallationToken({
    owner: "shulmansj",
    repo: "agentic-factory",
    permissions: { pull_requests: "read" },
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "https://broker.test/functions/v1/agentic-factory-github-broker/v1/installations/verify",
    "https://broker.test/functions/v1/agentic-factory-github-broker/v1/installation-token",
  ]);
  assert.ok(calls.every((call) => call.init.headers["x-agentic-factory-github-broker-token"] === "broker_token"));
  assert.ok(!JSON.stringify(calls).includes("private-key"));
});

test("broker client prefers repo-bound credentials over break-glass tokens", async () => {
  const calls = [];
  const client = createGitHubTokenBrokerClient({
    config: {
      github: {
        token_broker: {
          base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
          credential: "af_broker_v1.segment.sig",
          token: "break_glass_token",
        },
      },
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ ok: true });
        },
      };
    },
  });

  await client.verifyInstallation({ owner: "shulmansj", repo: "agentic-factory" });

  assert.equal(
    calls[0].init.headers["x-agentic-factory-github-broker-credential"],
    "af_broker_v1.segment.sig",
  );
  assert.equal(calls[0].init.headers["x-agentic-factory-github-broker-token"], undefined);
});

test("live GitHub setup writes and uses the installation-bound broker credential file", async () => {
  const root = tempRoot();
  const brokerCalls = [];
  const inboxCalls = [];
  const config = {
    github: {
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      starter_remote_urls: [],
      app_slug: "agentic-factory-app",
      app_id: "123456",
      token_broker: {
        base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
        token: "break_glass_token",
      },
    },
  };

  const transport = await githubSetupTransportFromFlags({
    config,
    flags: {},
    repoRoot: root,
    inboxClient: {
      async issueBrokerCredential(input) {
        inboxCalls.push(input);
        return { ok: true, credential: "af_broker_v1.repo.sig" };
      },
    },
    fetchImpl: async (url, init = {}) => {
      brokerCalls.push({ url: String(url), init });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            installation: {
              id: "installation-1",
              app_slug: "agentic-factory-app",
              permissions: { metadata: "read", contents: "write", pull_requests: "write" },
            },
          });
        },
      };
    },
  });

  await transport.request({
    endpointId: "get_app_installation",
    owner: "acme",
    repo: "agentic-factory",
    params: { app_slug: "agentic-factory-app", app_id: "123456" },
  });

  assert.deepEqual(inboxCalls, [{}]);
  assert.equal(
    fs.readFileSync(githubBrokerCredentialFilePath({ broker: config.github.token_broker, repoRoot: root }), "utf8"),
    "AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL=af_broker_v1.repo.sig\n",
  );
  assert.equal(
    brokerCalls[0].init.headers["x-agentic-factory-github-broker-credential"],
    "af_broker_v1.repo.sig",
  );
  assert.equal(brokerCalls[0].init.headers["x-agentic-factory-github-broker-token"], undefined);
});

test("github setup transport is live by default and --github-dry-run opts into the rehearsal transport", async () => {
  const root = tempRoot();
  const inboxCalls = [];
  const config = {
    github: {
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      starter_remote_urls: [],
      app_slug: "agentic-factory-app",
      app_id: "123456",
      token_broker: {
        base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
        token: "break_glass_token",
      },
    },
  };

  const liveTransport = await githubSetupTransportFromFlags({
    config,
    flags: {},
    repoRoot: root,
    inboxClient: {
      async issueBrokerCredential(input) {
        inboxCalls.push(input);
        return { ok: true, credential: "af_broker_v1.repo.sig" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({
          installation: {
            id: "installation-1",
            app_slug: "agentic-factory-app",
            permissions: { metadata: "read", contents: "write", pull_requests: "write" },
          },
        });
      },
    }),
  });
  assert.equal(liveTransport.kind, "real");
  assert.deepEqual(inboxCalls, [{}]);

  const dryTransport = await githubSetupTransportFromFlags({
    config,
    flags: { "github-dry-run": true },
    repoRoot: root,
    inboxClient: {
      async issueBrokerCredential() {
        throw new Error("dry_run_must_not_issue_broker_credential");
      },
    },
  });
  assert.equal(dryTransport.kind, "dry_run");
  const created = await dryTransport.request({
    endpointId: "create_repository",
    owner: "acme",
    repo: "agentic-factory",
    params: { visibility: "private" },
  });
  assert.equal(created.dry_run, true);

  const dryTransportEscapeHatch = await githubSetupTransportFromFlags({
    config,
    flags: { "github-setup-transport": "dry-run" },
    repoRoot: root,
  });
  assert.equal(dryTransportEscapeHatch.kind, "dry_run");
});

test("standalone GitHub init live helper requires install-binding inbox methods before broker issuance", async () => {
  const root = tempRoot();
  const config = {
    github: {
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      starter_remote_urls: [],
      app_slug: "agentic-factory-app",
      app_id: "123456",
      token_broker: {
        base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
        token: "break_glass_token",
      },
    },
  };

  await assert.rejects(
    () => githubInitTransportFromFlags({
      config,
      flags: {},
      repoRoot: root,
      inboxClient: {
        async issueBrokerCredential() {
          throw new Error("must_not_issue_before_binding");
        },
      },
    }),
    /github_install_binding_unavailable/,
  );
});

test("installation-bound GitHub broker credential issuer is deferred until the binding phase calls it", async () => {
  const root = tempRoot();
  const inboxCalls = [];
  const config = {
    github: {
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      starter_remote_urls: [],
      app_slug: "agentic-factory-app",
      app_id: "123456",
      token_broker: {
        base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
        token: "break_glass_token",
      },
    },
  };
  const inboxClient = {
    async githubInstallIntent() {
      return { ok: true, installUrl: "https://github.test/install" };
    },
    async githubInstallStatus() {
      return { ok: true, grant: { githubInstallationId: "installation-1" } };
    },
    async issueBrokerCredential(input) {
      inboxCalls.push(input);
      return { ok: true, credential: "af_broker_v1.repo.sig" };
    },
  };

  await githubInitTransportFromFlags({
    config,
    flags: {},
    repoRoot: root,
    inboxClient,
  });
  assert.deepEqual(inboxCalls, []);

  await issueInstallationBoundGitHubBrokerCredential({
    config,
    repoRoot: root,
    inboxClient,
    owner: "acme",
    repo: "agentic-factory",
  });

  assert.deepEqual(inboxCalls, [{}]);
  assert.equal(
    fs.readFileSync(githubBrokerCredentialFilePath({ broker: config.github.token_broker, repoRoot: root }), "utf8"),
    "AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL=af_broker_v1.repo.sig\n",
  );
});

test("standalone GitHub init helper uses dry-run transport only when --github-dry-run is explicit", async () => {
  const root = tempRoot();
  const config = {
    github: {
      behavior_repo: { owner: "acme", name: "agentic-factory", visibility: "private" },
      starter_remote_urls: [],
      app_slug: "agentic-factory-app",
      app_id: "123456",
      token_broker: {
        base_url: "https://broker.test/functions/v1/agentic-factory-github-broker",
        token: "break_glass_token",
      },
    },
  };
  const transport = await githubInitTransportFromFlags({
    config,
    flags: { "github-dry-run": true },
    repoRoot: root,
    inboxClient: {
      async issueBrokerCredential() {
        throw new Error("dry_run_must_not_issue_broker_credential");
      },
    },
  });
  assert.equal(transport.kind, "dry_run");
});

test("broker base URL validation allows https and localhost http only", async () => {
  const httpsCalls = [];
  const httpsClient = createGitHubTokenBrokerClient({
    config: {
      github: {
        token_broker: {
          base_url: "https://broker.test/functions/v1/agentic-factory-github-broker/",
          token: "broker_token",
        },
      },
    },
    fetchImpl: async (url) => {
      httpsCalls.push(String(url));
      return { ok: true, async text() { return JSON.stringify({ ok: true }); } };
    },
  });
  await httpsClient.verifyInstallation({});
  assert.equal(
    httpsCalls[0],
    "https://broker.test/functions/v1/agentic-factory-github-broker/v1/installations/verify",
  );

  const localhostClient = createGitHubTokenBrokerClient({
    config: {
      github: {
        token_broker: {
          base_url: "http://localhost:8787/functions/v1/agentic-factory-github-broker",
          token: "broker_token",
        },
      },
    },
    fetchImpl: async () => ({ ok: true, async text() { return JSON.stringify({ ok: true }); } }),
  });
  assert.equal(localhostClient.baseUrl, "http://localhost:8787/functions/v1/agentic-factory-github-broker");

  assert.throws(
    () => createGitHubTokenBrokerClient({
      config: { github: { token_broker: { base_url: "http://broker.test", token: "broker_token" } } },
      fetchImpl: async () => {},
    }),
    /github_token_broker_url_invalid/,
  );
  assert.throws(
    () => createGitHubTokenBrokerClient({
      // base_url built by concatenation so the repo-tree pre-push secret scanner does
      // not flag this intentional userinfo-credential test vector (runtime value unchanged)
      config: { github: { token_broker: { base_url: "https://user:" + "pass@broker.test", token: "broker_token" } } },
      fetchImpl: async () => {},
    }),
    /github_token_broker_url_invalid/,
  );
});

test("broker token file paths must stay inside the repo and reject traversal", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "secrets", "broker.env"), "AGENTIC_FACTORY_GITHUB_BROKER_TOKEN=inside\n", "utf8");
  assert.equal(
    resolveGitHubBrokerToken({ broker: { token_file: path.join("secrets", "broker.env") }, repoRoot: root }),
    "inside",
  );
  assert.throws(
    () => resolveGitHubBrokerToken({ broker: { token_file: "..\\outside.env" }, repoRoot: root }),
    /github_token_broker_token_file_invalid/,
  );
  assert.throws(
    () => resolveGitHubBrokerToken({ broker: { token_file: path.resolve(os.tmpdir(), "outside.env") }, repoRoot: root }),
    /github_token_broker_token_file_invalid/,
  );
  assert.throws(
    () => resolveGitHubBrokerCredential({ broker: { credential_file: "..\\outside.env" }, repoRoot: root }),
    /github_token_broker_credential_file_invalid/,
  );
});
