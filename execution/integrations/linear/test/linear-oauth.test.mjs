import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { formatCommand } from "../src/cli/operator-output.mjs";
import {
  LINEAR_OAUTH_CALLBACK,
  loadLinearConfig,
  validateLinearConfig,
} from "../src/config.mjs";
import {
  authorizeOneShotLinearAdmin,
  revokeLinearOAuthTokenSet,
  startOneShotLinearAdminAuthorizationSession,
} from "../src/linear-setup-auth.mjs";
import {
  LINEAR_OAUTH_WAIT_ESCAPED_CODE,
  OAUTH_CALLBACK_LISTENER,
  authorizeWithBrowser,
  browserOpenInvocation,
  buildAuthorizationUrl,
  createLinearOAuthTokenProvider,
  exchangeAuthorizationCode,
  generatePkcePair,
  oauthFirewallHint,
  parseGrantedScopes,
  refreshOAuthToken,
  startLinearBrowserAuthorizationSession,
} from "../src/linear-oauth.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
let browserAuthPortChain = Promise.resolve();

test("config requires Teami OAuth setup fields", () => {
  const config = loadLinearConfig({ repoRoot });
  validateLinearConfig(config, "test-config");

  // client_id is optional at config-load time: the identity-clean packaged default omits it, so a
  // fresh (unconfigured) install still loads and `teami doctor`/first-run report "not set up" rather
  // than crashing. Sign-in enforces client_id at OAuth time (linear-oauth.mjs requiredOAuthConfig).
  const missingClient = structuredClone(config);
  delete missingClient.linear.oauth.client_id;
  assert.doesNotThrow(() => validateLinearConfig(missingClient, "test-config"));

  const wrongRedirect = structuredClone(config);
  wrongRedirect.linear.oauth.redirect_uri = "http://localhost:9999/callback";
  assert.throws(
    () => validateLinearConfig(wrongRedirect, "test-config"),
    /127\.0\.0\.1/,
  );

  const missingWriteScope = structuredClone(config);
  missingWriteScope.linear.oauth.scopes = ["read"];
  assert.throws(
    () => validateLinearConfig(missingWriteScope, "test-config"),
    /scope write/,
  );

  const adminScope = structuredClone(config);
  adminScope.linear.oauth.scopes = ["read", "write", "admin"];
  assert.throws(
    () => validateLinearConfig(adminScope, "test-config"),
    /unsupported Linear OAuth scope admin/,
  );

  const userActor = structuredClone(config);
  userActor.linear.oauth.actor = "user";
  assert.throws(
    () => validateLinearConfig(userActor, "test-config"),
    /actor=app; re-run `npm run init` to re-authorize as the app/,
  );
});

test("config accepts only the registered Linear OAuth loopback callback port", async () => {
  const config = loadLinearConfig({ repoRoot });
  const { host, pathname, portRange } = LINEAR_OAUTH_CALLBACK;

  const candidate = structuredClone(config);
  candidate.linear.oauth.redirect_uri = `http://${host}:${portRange.start}${pathname}`;
  assert.equal(validateLinearConfig(candidate, "test-config", { repoRoot }), true);

  const outsideRange = structuredClone(config);
  outsideRange.linear.oauth.redirect_uri = `http://${host}:${portRange.end + 1}${pathname}`;
  assert.throws(
    () => validateLinearConfig(outsideRange, "test-config", { repoRoot }),
    /port 8723/,
  );

  assert.deepEqual(OAUTH_CALLBACK_LISTENER, LINEAR_OAUTH_CALLBACK);
  assert.match(oauthFirewallHint({ platform: "win32" }), /Defender Firewall/);
  assert.equal(oauthFirewallHint({ platform: "linux" }), null);

  const cliSetup = await import("../src/cli/linear-setup-command.mjs");
  assert.equal(cliSetup.oauthFirewallHint, oauthFirewallHint);
  assert.deepEqual(cliSetup.OAUTH_CALLBACK_LISTENER, LINEAR_OAUTH_CALLBACK);
});

test("authorization URL uses PKCE, app actor, required scopes, and no secret", () => {
  const config = loadLinearConfig({ repoRoot });
  const pkce = { challenge: "challenge-123", method: "S256" };
  const url = buildAuthorizationUrl({
    config,
    pkce,
    state: "state-123",
    authorizationEndpoint: "https://linear.test/oauth/authorize",
  });

  assert.equal(url.origin + url.pathname, "https://linear.test/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), config.linear.oauth.client_id);
  assert.equal(url.searchParams.get("redirect_uri"), config.linear.oauth.redirect_uri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "read,write");
  assert.equal(url.searchParams.get("actor"), "app");
  // No prompt by default: an already-installed app must auto-redirect straight back (forcing
  // consent lands installed apps on Linear's "already installed" page, which never redirects).
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("client_secret"), false);

  const consentUrl = buildAuthorizationUrl({
    config,
    pkce,
    state: "state-123",
    authorizationEndpoint: "https://linear.test/oauth/authorize",
    prompt: "consent",
  });
  assert.equal(consentUrl.searchParams.get("prompt"), "consent");

  const generated = generatePkcePair({ randomBytes: () => Buffer.alloc(32, 7) });
  assert.match(generated.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(generated.challenge, /^[A-Za-z0-9_-]+$/);
});

test("Windows browser opener passes the full OAuth URL as one process argument", () => {
  const url =
    "https://linear.app/oauth/authorize?client_id=client&response_type=code&scope=read,write&state=abc";
  const invocation = browserOpenInvocation(url, "win32");

  assert.equal(invocation.command, "rundll32.exe");
  assert.deepEqual(invocation.args, ["url.dll,FileProtocolHandler", url]);
});

test("token exchange and refresh use form encoding without client secrets", async () => {
  const config = loadLinearConfig({ repoRoot });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, form: new URLSearchParams(options.body) });
    return jsonResponse({
      access_token: `access-${calls.length}`,
      refresh_token: `refresh-${calls.length}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read write",
    });
  };

  const exchanged = await exchangeAuthorizationCode({
    config,
    code: "auth-code",
    codeVerifier: "verifier",
    fetchImpl,
    tokenEndpoint: "https://linear.test/oauth/token",
  });
  const refreshed = await refreshOAuthToken({
    config,
    refreshToken: "refresh-existing",
    fetchImpl,
    tokenEndpoint: "https://linear.test/oauth/token",
  });

  assert.equal(exchanged.accessToken, "access-1");
  assert.equal(refreshed.refreshToken, "refresh-2");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://linear.test/oauth/token");
  assert.equal(calls[0].options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].form.get("grant_type"), "authorization_code");
  assert.equal(calls[0].form.get("client_id"), config.linear.oauth.client_id);
  assert.equal(calls[0].form.get("code"), "auth-code");
  assert.equal(calls[0].form.get("code_verifier"), "verifier");
  assert.equal(calls[0].form.has("client_secret"), false);
  assert.equal(calls[1].form.get("grant_type"), "refresh_token");
  assert.equal(calls[1].form.get("refresh_token"), "refresh-existing");
  assert.equal(calls[1].form.has("client_secret"), false);
});

test("token provider refreshes stored OAuth credentials and persists rotation", async () => {
  const config = loadLinearConfig({ repoRoot });
  const writes = [];
  const credentialStore = {
    async readTokenSet() {
      return {
        refreshToken: "refresh-old",
      };
    },
    async writeTokenSet(tokenSet) {
      writes.push(tokenSet);
    },
    async deleteTokenSet() {},
  };
  const fetchImpl = async () =>
    jsonResponse({
      access_token: "access-new",
      refresh_token: "refresh-new",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read,write",
    });
  const provider = createLinearOAuthTokenProvider({
    config,
    credentialStore,
    fetchImpl,
    now: () => Date.parse("2026-06-07T20:00:00.000Z"),
  });

  assert.equal(await provider(), "access-new");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].refreshToken, "refresh-new");
  assert.equal(writes[0].accessToken, "access-new");
  assert.equal(writes[0].expiresAt, "2026-06-07T21:00:00.000Z");
});

test("a refresh paused across uninstall cannot recreate the deleted Team credential", async () => {
  const config = loadLinearConfig({ repoRoot });
  const observed = { refreshToken: "refresh-before-uninstall" };
  let current = observed;
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const refreshMayFinish = new Promise((resolve) => { releaseRefresh = resolve; });
  const credentialStore = {
    async readTokenSet() {
      return current;
    },
    async replaceTokenSetIfEqual(expected, tokenSet) {
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        return { ok: false, status: "conflict" };
      }
      current = tokenSet;
      return { ok: true, status: "replaced" };
    },
    async writeTokenSet() {
      throw new Error("refresh must use compare-replace");
    },
  };
  const provider = createLinearOAuthTokenProvider({
    config,
    credentialStore,
    fetchImpl: async () => {
      markRefreshStarted();
      await refreshMayFinish;
      return jsonResponse({
        access_token: "access-after-uninstall",
        refresh_token: "refresh-after-uninstall",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      });
    },
  });

  const refresh = provider();
  await refreshStarted;
  current = null; // Uninstall removes the Team credential while the network request is paused.
  releaseRefresh();

  await assert.rejects(refresh, /credential changed while authorization was in progress/);
  assert.equal(current, null);
});

test("token provider can defer browser OAuth persistence until explicit commit", async () => {
  const config = loadLinearConfig({ repoRoot });
  const writes = [];
  const provider = createLinearOAuthTokenProvider({
    config,
    allowBrowserAuth: true,
    deferTokenPersistence: true,
    credentialStore: {
      async readTokenSet() {
        return null;
      },
      async writeTokenSet(tokenSet) {
        writes.push(tokenSet);
      },
      async deleteTokenSet() {},
    },
    authorize: async () => ({
      accessToken: "access-browser",
      refreshToken: "refresh-browser",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "read write",
    }),
    now: () => Date.parse("2026-06-07T20:00:00.000Z"),
  });

  assert.equal(await provider(), "access-browser");
  assert.equal(provider.lastTokenSource, "browser");
  assert.equal(provider.hasPendingTokenSet, true);
  assert.deepEqual(writes, []);

  assert.equal(await provider.persistPendingTokenSet(), true);
  assert.equal(provider.hasPendingTokenSet, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].accessToken, "access-browser");
  assert.equal(writes[0].refreshToken, "refresh-browser");
});

test("token provider clear preserves a credential refreshed after observation", async () => {
  const config = loadLinearConfig({ repoRoot });
  const observed = {
    accessToken: "access-observed",
    refreshToken: "refresh-observed",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  let current = observed;
  const credentialStore = {
    async readTokenSet() {
      return current;
    },
    async writeTokenSet(tokenSet) {
      current = tokenSet;
    },
    async deleteTokenSetIfEqual(expected) {
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        return { ok: false, status: "conflict" };
      }
      current = null;
      return { ok: true, status: "deleted" };
    },
    async deleteTokenSet() {
      throw new Error("compare-delete must protect observed credentials");
    },
  };
  const provider = createLinearOAuthTokenProvider({ config, credentialStore });
  assert.equal(await provider(), "access-observed");

  current = {
    accessToken: "access-refreshed",
    refreshToken: "refresh-refreshed",
    expiresAt: "2099-01-02T00:00:00.000Z",
  };
  await provider.clear();

  assert.equal(current.refreshToken, "refresh-refreshed");
});

test("one-shot admin OAuth uses user admin consent without mutating or persisting standing auth", async () => {
  const config = loadLinearConfig({ repoRoot });
  const standingOAuth = structuredClone(config.linear.oauth);
  const authCalls = [];
  const fetchCalls = [];
  const credentialStoreCalls = [];
  const throwingCredentialStore = {
    async readTokenSet() {
      credentialStoreCalls.push("read");
      throw new Error("one-shot admin auth must not read the credential store");
    },
    async writeTokenSet() {
      credentialStoreCalls.push("write");
      throw new Error("one-shot admin auth must not write the credential store");
    },
    async deleteTokenSet() {
      credentialStoreCalls.push("delete");
      throw new Error("one-shot admin auth must not delete the credential store");
    },
  };

  const authorize = async (options) => {
    authCalls.push({
      oauth: structuredClone(options.config.linear.oauth),
      prompt: options.prompt,
      deferTokenPersistence: options.deferTokenPersistence,
    });
    return {
      accessToken: "adm1",
      refreshToken: "ref1",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "read write admin",
    };
  };

  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url, options, body: String(options.body || "") });
    if (url.endsWith("/graphql")) {
      assert.equal(options.headers.authorization, "Bearer adm1");
      return jsonResponse({
        data: {
          organization: {
            id: "org1",
            name: "Acme",
            urlKey: "acme",
          },
        },
      });
    }
    if (url.endsWith("/oauth/revoke")) {
      return jsonResponse({}, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const { adminClient, teardown } = await authorizeOneShotLinearAdmin({
    config,
    fetchImpl,
    authorize,
    credentialStore: throwingCredentialStore,
  });

  assert.deepEqual(config.linear.oauth, standingOAuth);
  assert.deepEqual(authCalls, [{
    oauth: {
      ...standingOAuth,
      actor: "user",
      scopes: ["read", "write", "admin"],
    },
    prompt: "consent",
    deferTokenPersistence: true,
  }]);
  assert.equal(typeof adminClient.getOrganization, "function");
  assert.equal("request" in adminClient, false);

  const organization = await adminClient.getOrganization();
  assert.deepEqual(organization, { id: "org1", name: "Acme", urlKey: "acme" });

  assert.deepEqual(await teardown(), { revokeVerified: true });

  assert.deepEqual(config.linear.oauth, standingOAuth);
  assert.deepEqual(credentialStoreCalls, []);
  const revokeCalls = fetchCalls.filter((call) => call.url.endsWith("/oauth/revoke"));
  assert.equal(revokeCalls.length, 2);
  assert.match(revokeCalls[0].body, /token=ref1/);
  assert.match(revokeCalls[0].body, /token_type_hint=refresh_token/);
  assert.match(revokeCalls[1].body, /token=adm1/);
  assert.match(revokeCalls[1].body, /token_type_hint=access_token/);
  await assert.rejects(() => adminClient.getOrganization(), /one-shot admin OAuth grant has been torn down/);

  const adminScope = structuredClone(config);
  adminScope.linear.oauth.scopes = ["read", "write", "admin"];
  assert.throws(
    () => validateLinearConfig(adminScope, "test-config"),
    /unsupported Linear OAuth scope admin/,
  );

  const userActor = structuredClone(config);
  userActor.linear.oauth.actor = "user";
  assert.throws(
    () => validateLinearConfig(userActor, "test-config"),
    /actor=app; re-run `npm run init` to re-authorize as the app/,
  );
});

test("one-shot admin teardown discards the token after caller failure and swallows revoke failure", async () => {
  const config = loadLinearConfig({ repoRoot });
  const revokeBodies = [];
  const grant = await authorizeOneShotLinearAdmin({
    config,
    authorize: async () => ({
      accessToken: "adm2",
      refreshToken: "ref2",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "read write admin",
    }),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/graphql")) {
        return jsonResponse({
          errors: [{ message: "organization unavailable" }],
        });
      }
      if (url.endsWith("/oauth/revoke")) {
        revokeBodies.push(String(options.body || ""));
        throw new Error("revocation service unavailable");
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    async () => {
      try {
        await grant.adminClient.getOrganization();
      } finally {
        assert.deepEqual(await grant.teardown(), { revokeVerified: false });
      }
    },
    /organization unavailable/,
  );

  assert.equal(revokeBodies.length, 2);
  await assert.rejects(
    () => grant.adminClient.getOrganization(),
    /one-shot admin OAuth grant has been torn down/,
  );
  assert.deepEqual(await grant.teardown(), { revokeVerified: false, alreadyTornDown: true });
});

test("OAuth revocation accepts only Linear's explicit already-revoked response", async () => {
  const tokenSet = { accessToken: "access", refreshToken: "refresh" };
  const alreadyRevoked = await revokeLinearOAuthTokenSet({
    tokenSet,
    fetchImpl: async () => jsonResponse(
      { error: "Token has already been revoked." },
      { ok: false, status: 401 },
    ),
  });
  assert.deepEqual(alreadyRevoked, { revokeVerified: true });

  const genericUnauthorized = await revokeLinearOAuthTokenSet({
    tokenSet,
    fetchImpl: async () => jsonResponse(
      { error: "Unable to authenticate." },
      { ok: false, status: 401 },
    ),
  });
  assert.deepEqual(genericUnauthorized, { revokeVerified: false });
});

test("token refresh tolerates unchanged refresh tokens, unchanged scopes, and absent expiry", async () => {
  const config = loadLinearConfig({ repoRoot });
  const writes = [];
  const provider = createLinearOAuthTokenProvider({
    config,
    credentialStore: {
      async readTokenSet() {
        return {
          accessToken: "access-old",
          refreshToken: "refresh-stable",
          expiresAt: "2026-06-07T19:00:00.000Z",
          scope: "read write",
        };
      },
      async writeTokenSet(tokenSet) {
        writes.push(tokenSet);
      },
      async deleteTokenSet() {},
    },
    fetchImpl: async () =>
      jsonResponse({
        access_token: "access-refreshed",
        token_type: "Bearer",
      }),
    now: () => Date.parse("2026-06-07T20:00:00.000Z"),
  });

  assert.equal(await provider(), "access-refreshed");
  assert.deepEqual(writes, [
    {
      accessToken: "access-refreshed",
      refreshToken: "refresh-stable",
      tokenType: "Bearer",
      scope: "read write",
    },
  ]);
});

test("token provider de-dupes concurrent refreshes", async () => {
  const config = loadLinearConfig({ repoRoot });
  let refreshCalls = 0;
  let resolver;
  const refreshStarted = new Promise((resolve) => {
    resolver = resolve;
  });
  const provider = createLinearOAuthTokenProvider({
    config,
    credentialStore: {
      async readTokenSet() {
        return { refreshToken: "refresh-shared" };
      },
      async writeTokenSet() {},
      async deleteTokenSet() {},
    },
    fetchImpl: async () => {
      refreshCalls += 1;
      resolver();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({
        access_token: "access-shared",
        refresh_token: "refresh-shared-next",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      });
    },
  });

  const first = provider();
  await refreshStarted;
  const second = provider();

  assert.deepEqual(await Promise.all([first, second]), ["access-shared", "access-shared"]);
  assert.equal(refreshCalls, 1);
});

test("doctor-style token provider fails without browser auth or refresh side effects", async () => {
  const config = loadLinearConfig({ repoRoot });
  let wrote = false;
  const provider = createLinearOAuthTokenProvider({
    config,
    allowBrowserAuth: false,
    allowRefresh: false,
    credentialStore: {
      async readTokenSet() {
        return { refreshToken: "refresh-old" };
      },
      async writeTokenSet() {
        wrote = true;
      },
      async deleteTokenSet() {},
    },
  });

  // The repair command renders through formatCommand (context-aware: npx vs repo launcher).
  await assert.rejects(
    () => provider(),
    (error) => error.message.includes(`run ${formatCommand("init")}`),
  );
  assert.equal(wrote, false);
});

test("automatic browser opener failures include a manual authorization URL", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const messages = [];

  await assert.rejects(
    () =>
      authorizeWithBrowser({
        config,
        timeoutMs: 5_000,
        openBrowser: async () => {
          throw new Error("browser unavailable");
        },
        onProgress: (message) => messages.push(message),
      }),
    /Paste this URL|browser unavailable/,
  );
  assert.equal(messages.some((message) => message.includes("response_type=code")), true);
}));

test("resumable browser authorization returns a live URL before the callback completes", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const session = await startLinearBrowserAuthorizationSession({
    config,
    timeoutMs: 5_000,
    openBrowser: async () => {},
  });
  assert.match(session.authorizationUrl, /response_type=code/);
  assert.equal(session.browser.opened, true);

  let settled = false;
  session.waitForToken().finally(() => {
    settled = true;
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "the callback remains the sole completion source");
  assert.equal(await session.close(), true);
  assert.equal(await session.close(), false);
}));

test("resumable browser authorization retains the manual URL when browser launch fails", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const session = await startLinearBrowserAuthorizationSession({
    config,
    timeoutMs: 5_000,
    openBrowser: async () => {
      throw new Error("browser unavailable");
    },
  });
  assert.match(session.authorizationUrl, /response_type=code/);
  assert.deepEqual(session.browser, { opened: false, reason: "browser unavailable" });
  await session.close();
}));

test("resumable one-shot admin authorization returns the elevated URL before callback", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const session = await startOneShotLinearAdminAuthorizationSession({
    config,
    timeoutMs: 5_000,
    callbackWaitHintMs: 5_000,
    openBrowser: async () => {},
  });
  const url = new URL(session.authorizationUrl);
  assert.equal(url.searchParams.get("actor"), "user");
  assert.match(url.searchParams.get("scope"), /admin/);
  assert.equal(typeof session.waitForGrant, "function");
  await session.close();
}));

test("browser authorization emits installed-app guidance once while waiting for callback", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const messages = [];

  await assert.rejects(
    () =>
      authorizeWithBrowser({
        config,
        timeoutMs: 80,
        callbackWaitHintMs: 5,
        openBrowser: async () => {},
        onProgress: (message) => messages.push(message),
      }),
    /Timed out waiting for Linear OAuth authorization callback/,
  );

  // No dead air: the installed-app fork is disclosed the moment the wait begins, and the timer
  // only issues a gentle reminder afterward.
  const guidance = messages.filter((message) => message.startsWith("-> If Linear shows 'Teami already installed'"));
  assert.equal(guidance.length, 1);
  // No escape hook was provided (non-interactive), so the fork must not advertise press-Enter.
  assert.match(guidance[0], /then re-run setup\.$/);
  assert.equal(messages.some((message) => message.includes("press Enter here")), false);
  const reminders = messages.filter((message) => message.startsWith("Still waiting for Linear"));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0], "Still waiting for Linear — the two options above still apply.");
  assert.ok(messages.indexOf(guidance[0]) < messages.indexOf(reminders[0]));
}));

test("browser authorization wait escape can be retried with fresh state", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const openedUrls = [];
  const messages = [];
  let fetchCalls = 0;
  let token = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      token = await authorizeWithBrowser({
        config,
        fetchImpl: async () => {
          fetchCalls += 1;
          return jsonResponse({
            access_token: "access-escape-retry",
            refresh_token: "refresh-escape-retry",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read write",
          });
        },
        timeoutMs: 5_000,
        // Large hint threshold: the escape is live from second zero now, so this test must not
        // depend on the reminder timer firing at all.
        callbackWaitHintMs: 5_000,
        waitEscape: attempt === 0
          ? () => ({
              promise: Promise.resolve(),
              cancel() {},
            })
          : null,
        openBrowser: async (url) => {
          const openedUrl = new URL(url);
          openedUrls.push(openedUrl);
          if (attempt === 1) {
            const callback = new URL(openedUrl.searchParams.get("redirect_uri"));
            callback.searchParams.set("code", "browser-code-after-escape" );
            callback.searchParams.set("state", openedUrl.searchParams.get("state"));
            await requestCallback(callback);
          }
        },
        onProgress: (message) => messages.push(message),
      });
      break;
    } catch (error) {
      assert.equal(error.code, LINEAR_OAUTH_WAIT_ESCAPED_CODE);
    }
  }

  assert.equal(token.accessToken, "access-escape-retry");
  assert.equal(fetchCalls, 1);
  assert.equal(openedUrls.length, 2);
  assert.notEqual(openedUrls[0].searchParams.get("state"), openedUrls[1].searchParams.get("state"));
  assert.equal(
    new URL(openedUrls[0].searchParams.get("redirect_uri" )).port,
    new URL(openedUrls[1].searchParams.get("redirect_uri" )).port,
  );
  // The escape resolved before the reminder threshold, so no reminder fired — but the fork
  // guidance must have been disclosed up front, in the right variant for each attempt.
  assert.equal(messages.filter((message) => message.startsWith("Still waiting for Linear")).length, 0);
  assert.equal(messages.filter((message) => message.includes("press Enter here to reopen a fresh sign-in")).length, 1);
  assert.equal(messages.filter((message) => message.endsWith("then re-run setup.")).length, 1);
}));

test("browser authorization cancels wait escape when callback wins", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const messages = [];
  let waitEscapeCalls = 0;
  let cancelCalls = 0;
  let resolveEscape;
  const escapePromise = new Promise((resolve) => {
    resolveEscape = resolve;
  });

  const token = await authorizeWithBrowser({
    config,
    fetchImpl: async () => jsonResponse({
      access_token: "access-callback-wins",
      refresh_token: "refresh-callback-wins",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read write",
    }),
    timeoutMs: 5_000,
    callbackWaitHintMs: 5,
    waitEscape: () => {
      waitEscapeCalls += 1;
      return {
        promise: escapePromise,
        cancel() {
          cancelCalls += 1;
        },
      };
    },
    openBrowser: async (url) => {
      const openedUrl = new URL(url);
      const callback = new URL(openedUrl.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", "browser-code-callback-wins" );
      callback.searchParams.set("state", openedUrl.searchParams.get("state"));
      setTimeout(() => {
        void requestCallback(callback);
      }, 25);
    },
    onProgress: (message) => messages.push(message),
  });

  assert.equal(token.accessToken, "access-callback-wins" );
  assert.equal(waitEscapeCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(messages.filter((message) => message.startsWith("Still waiting for Linear")).length, 1);
  resolveEscape();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelCalls, 1);
}));

test("browser authorization timeout explains missing callback and revoke recovery", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const messages = [];

  await assert.rejects(
    () =>
      authorizeWithBrowser({
        config,
        timeoutMs: 5,
        callbackWaitHintMs: 50,
        openBrowser: async () => {},
        onProgress: (message) => messages.push(message),
      }),
    (error) => {
      assert.match(error.message, /Timed out waiting for Linear OAuth authorization callback/);
      assert.match(error.message, /Linear never sent the browser callback/);
      assert.match(error.message, /Teami already installed/);
      assert.match(error.message, /does not redirect back to Teami/);
      assert.match(error.message, /Revoke Teami under Linear Settings -> Applications/);
      assert.match(error.message, new RegExp(escapeRegExp(formatCommand("init"))));
      return true;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(messages.some((message) => message.startsWith("Still waiting for Linear")), false);
}));

test("browser authorization clears installed-app guidance after callback completes", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  const messages = [];
  const fetchImpl = async () => jsonResponse({
    access_token: "access-no-hint",
    refresh_token: "refresh-no-hint",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "read write",
  });

  const token = await authorizeWithBrowser({
    config,
    fetchImpl,
    timeoutMs: 5_000,
    callbackWaitHintMs: 10,
    openBrowser: async (url) => {
      const openedUrl = new URL(url);
      const callback = new URL(openedUrl.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", "browser-code");
      callback.searchParams.set("state", openedUrl.searchParams.get("state"));
      await requestCallback(callback);
    },
    onProgress: (message) => messages.push(message),
  });

  assert.equal(token.accessToken, "access-no-hint");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messages.some((message) => message.startsWith("Still waiting for Linear")), false);
}));

test("browser authorization validates callback state and exchanges the returned code", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  let exchangedCode = null;
  let openedUrl = null;
  let callbackHtml = null;
  let failedCallbackHtml = null;
  const fetchImpl = async (_url, options) => {
    const form = new URLSearchParams(options.body);
    exchangedCode = form.get("code");
    return jsonResponse({
      access_token: "access-browser",
      refresh_token: "refresh-browser",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read write",
    });
  };

  const token = await authorizeWithBrowser({
    config,
    fetchImpl,
    timeoutMs: 5_000,
    openBrowser: async (url) => {
      openedUrl = new URL(url);
      const callback = new URL(openedUrl.searchParams.get("redirect_uri"));
      const wrongPath = new URL("/linear/oauth/unexpected", callback.origin);
      failedCallbackHtml = await get(wrongPath);
      callback.searchParams.set("code", "browser-code");
      callback.searchParams.set("state", openedUrl.searchParams.get("state"));
      callbackHtml = await get(callback);
    },
  });

  assert.equal(openedUrl.searchParams.get("client_id"), config.linear.oauth.client_id);
  // Default browser auth must NOT force consent so already-installed apps auto-redirect.
  assert.equal(openedUrl.searchParams.has("prompt"), false);
  assert.equal(exchangedCode, "browser-code");
  assert.equal(token.accessToken, "access-browser");
  assert.match(callbackHtml, /Return to your terminal to confirm the authorized Linear workspace/);
  assert.match(callbackHtml, /will not create anything until the workspace is verified/);
  assert.match(failedCallbackHtml, /Action needed/);
  assert.match(failedCallbackHtml, /Unexpected callback path/);
}));

test("browser authorization fails immediately when the registered callback port is busy", async () => withBrowserAuthPort(async () => {
  const { portRange } = LINEAR_OAUTH_CALLBACK;
  const blocker = await listenOnLoopbackPort(portRange.start);
  try {
    const config = loadLinearConfig({ repoRoot });
    let browserOpened = false;
    await assert.rejects(
      () => authorizeWithBrowser({
        config,
        timeoutMs: 5_000,
        openBrowser: async () => {
          browserOpened = true;
        },
      }),
      /callback ports? 8723.*already in use/i,
    );
    assert.equal(browserOpened, false);
  } finally {
    await closeServer(blocker);
  }
}));

test("browser authorization rejects callback state mismatch before token exchange", async () => withBrowserAuthPort(async () => {
  const config = loadLinearConfig({ repoRoot });
  let tokenExchangeAttempted = false;

  await assert.rejects(
    () =>
      authorizeWithBrowser({
        config,
        timeoutMs: 5_000,
        fetchImpl: async () => {
          tokenExchangeAttempted = true;
          return jsonResponse({});
        },
        openBrowser: async (url) => {
          const openedUrl = new URL(url);
          const callback = new URL(openedUrl.searchParams.get("redirect_uri"));
          callback.searchParams.set("code", "browser-code");
          callback.searchParams.set("state", "wrong-state");
          await requestCallback(callback);
        },
      }),
    /state did not match/,
  );
  assert.equal(tokenExchangeAttempted, false);
}));

test("OAuth errors redact token material", async () => {
  const config = loadLinearConfig({ repoRoot });
  const githubToken = "ghp_" + "a".repeat(16);

  await assert.rejects(
    () =>
      refreshOAuthToken({
        config,
        refreshToken: "refresh-secret",
        fetchImpl: async () =>
          jsonResponse(
            {
              error_description:
                `refresh-secret failed with ${githubToken} at http://127.0.0.1:8723/linear/oauth/callback?code=secret-code&state=abc`,
            },
            { ok: false, status: 400 },
          ),
      }),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /refresh-secret/);
      assert.doesNotMatch(error.message, /secret-code/);
      assert.doesNotMatch(error.message, new RegExp(githubToken));
      assert.match(error.message, /Linear OAuth callback URL \[redacted\]/);
      return true;
    },
  );
});

test("scope parser accepts Linear grants returned with comma or whitespace separators", () => {
  assert.deepEqual(parseGrantedScopes("read,write"), ["read", "write"]);
  assert.deepEqual(parseGrantedScopes("read write"), ["read", "write"]);
  assert.deepEqual(parseGrantedScopes("read, write"), ["read", "write"]);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
  });
}

function requestCallback(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", resolve);
  });
}

function listenOnLoopbackPort(port) {
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LINEAR_OAUTH_CALLBACK.host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function withBrowserAuthPort(fn) {
  const previous = browserAuthPortChain;
  let release;
  browserAuthPortChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    return await fn();
  } finally {
    release();
  }
}
