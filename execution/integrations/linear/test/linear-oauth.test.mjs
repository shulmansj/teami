import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { loadLinearConfig, validateLinearConfig } from "../src/config.mjs";
import {
  authorizeWithBrowser,
  browserOpenInvocation,
  buildAuthorizationUrl,
  createLinearOAuthTokenProvider,
  exchangeAuthorizationCode,
  generatePkcePair,
  parseGrantedScopes,
  refreshOAuthToken,
} from "../src/linear-oauth.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
let browserAuthPortChain = Promise.resolve();

test("config requires Agentic Factory OAuth setup fields", () => {
  const config = loadLinearConfig({ repoRoot });
  validateLinearConfig(config, "test-config");

  const missingClient = structuredClone(config);
  delete missingClient.linear.oauth.client_id;
  assert.throws(
    () => validateLinearConfig(missingClient, "test-config"),
    /linear\.oauth\.client_id/,
  );

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

  const appActor = structuredClone(config);
  appActor.linear.oauth.actor = "app";
  assert.throws(
    () => validateLinearConfig(appActor, "test-config"),
    /actor=user/,
  );
});

test("authorization URL uses PKCE, user actor, required scopes, and no secret", () => {
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
  assert.equal(url.searchParams.get("scope"), "read,write,admin");
  assert.equal(url.searchParams.get("actor"), "user");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("client_secret"), false);

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
      scope: "read write admin",
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
      scope: "read,write,admin",
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
      scope: "read write admin",
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
        scope: "read write admin",
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

  await assert.rejects(() => provider(), /run npm run init/);
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
        scope: "read write admin",
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
  assert.equal(openedUrl.searchParams.get("prompt"), "consent");
  assert.equal(exchangedCode, "browser-code");
  assert.equal(token.accessToken, "access-browser");
  assert.match(callbackHtml, /Return to your terminal to confirm the authorized Linear workspace/);
  assert.match(callbackHtml, /will not create anything until the workspace is verified/);
  assert.match(failedCallbackHtml, /Action needed/);
  assert.match(failedCallbackHtml, /Unexpected callback path/);
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

  await assert.rejects(
    () =>
      refreshOAuthToken({
        config,
        refreshToken: "refresh-secret",
        fetchImpl: async () =>
          jsonResponse(
            {
              error_description:
                "refresh-secret failed at http://127.0.0.1:8723/linear/oauth/callback?code=secret-code&state=abc",
            },
            { ok: false, status: 400 },
          ),
      }),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /refresh-secret/);
      assert.doesNotMatch(error.message, /secret-code/);
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
