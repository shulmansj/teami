import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";

const DEFAULT_AUTHORIZATION_ENDPOINT = "https://linear.app/oauth/authorize";
const DEFAULT_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

export function generatePkcePair({ randomBytes = crypto.randomBytes } = {}) {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function buildAuthorizationUrl({
  config,
  pkce,
  state,
  authorizationEndpoint = DEFAULT_AUTHORIZATION_ENDPOINT,
  prompt = "consent",
} = {}) {
  const oauth = requiredOAuthConfig(config);
  if (!pkce?.challenge) throw new Error("PKCE code challenge is required.");
  if (!state) throw new Error("Linear OAuth state is required.");

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", oauth.client_id);
  url.searchParams.set("redirect_uri", oauth.redirect_uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", oauth.scopes.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("actor", oauth.actor);
  if (prompt) url.searchParams.set("prompt", prompt);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method || "S256");
  return url;
}

export async function exchangeAuthorizationCode({
  config,
  code,
  codeVerifier,
  fetchImpl = globalThis.fetch,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const oauth = requiredOAuthConfig(config);
  if (!code) throw new Error("Linear OAuth authorization code is required.");
  if (!codeVerifier) throw new Error("Linear OAuth PKCE code verifier is required.");
  return requestOAuthToken({
    fetchImpl,
    tokenEndpoint,
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: oauth.redirect_uri,
      client_id: oauth.client_id,
      code_verifier: codeVerifier,
    },
    requiredScopes: oauth.scopes,
    requireReturnedScopes: true,
    requireRefreshToken: true,
    secretValues: [code, codeVerifier],
    requestTimeoutMs,
  });
}

export async function refreshOAuthToken({
  config,
  refreshToken,
  fetchImpl = globalThis.fetch,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const oauth = requiredOAuthConfig(config);
  if (!refreshToken) throw new Error("Linear OAuth refresh token is required.");
  return requestOAuthToken({
    fetchImpl,
    tokenEndpoint,
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oauth.client_id,
    },
    requiredScopes: oauth.scopes,
    requireReturnedScopes: false,
    requireRefreshToken: false,
    fallbackRefreshToken: refreshToken,
    secretValues: [refreshToken],
    requestTimeoutMs,
  });
}

export function createLinearOAuthTokenProvider({
  config,
  credentialStore,
  fetchImpl = globalThis.fetch,
  allowBrowserAuth = false,
  allowRefresh = true,
  authorize = authorizeWithBrowser,
  now = () => Date.now(),
  onProgress = null,
  openBrowser = openSystemBrowser,
  deferTokenPersistence = false,
} = {}) {
  if (!credentialStore) throw new Error("Linear OAuth credential store is required.");
  let cachedTokenSet = null;
  let inFlightToken = null;
  let pendingTokenSet = null;

  const provider = async () => {
    if (tokenSetHasUsableAccessToken(cachedTokenSet, now())) return cachedTokenSet.accessToken;
    if (!inFlightToken) {
      inFlightToken = resolveToken().finally(() => {
        inFlightToken = null;
      });
    }
    return inFlightToken;
  };

  async function resolveToken() {
    if (tokenSetHasUsableAccessToken(cachedTokenSet, now())) return cachedTokenSet.accessToken;

    const storedTokenSet = await credentialStore.readTokenSet();
    if (tokenSetHasUsableAccessToken(storedTokenSet, now())) {
      cachedTokenSet = storedTokenSet;
      provider.lastTokenSource = "stored";
      return storedTokenSet.accessToken;
    }

    if (storedTokenSet?.refreshToken) {
      if (!allowRefresh) {
        throw new Error("Linear OAuth access token is expired or unavailable; run npm run init.");
      }
      const refreshed = await refreshOAuthToken({
        config,
        refreshToken: storedTokenSet.refreshToken,
        fetchImpl,
      });
      cachedTokenSet = tokenResponseToStoredTokenSet(refreshed, now(), storedTokenSet);
      provider.lastTokenSource = "refresh";
      await persistResolvedTokenSet(cachedTokenSet);
      return cachedTokenSet.accessToken;
    }

    if (!allowBrowserAuth) {
      throw new Error("Linear OAuth authorization is missing; run npm run init.");
    }

    onProgress?.("Opening Linear authorization in your browser...");
    const authorized = await authorize({ config, fetchImpl, openBrowser, onProgress });
    cachedTokenSet = tokenResponseToStoredTokenSet(authorized, now());
    provider.lastTokenSource = "browser";
    await persistResolvedTokenSet(cachedTokenSet);
    return cachedTokenSet.accessToken;
  }

  async function persistResolvedTokenSet(tokenSet) {
    if (deferTokenPersistence) {
      pendingTokenSet = tokenSet;
      provider.hasPendingTokenSet = true;
      return;
    }
    await credentialStore.writeTokenSet(tokenSet);
    provider.hasPendingTokenSet = false;
  }

  provider.clear = async () => {
    cachedTokenSet = null;
    inFlightToken = null;
    pendingTokenSet = null;
    provider.hasPendingTokenSet = false;
    provider.lastTokenSource = null;
    await credentialStore.deleteTokenSet();
  };

  provider.persistPendingTokenSet = async () => {
    if (!pendingTokenSet) return false;
    await credentialStore.writeTokenSet(pendingTokenSet);
    pendingTokenSet = null;
    provider.hasPendingTokenSet = false;
    return true;
  };

  provider.discardPendingTokenSet = async () => {
    pendingTokenSet = null;
    cachedTokenSet = null;
    inFlightToken = null;
    provider.hasPendingTokenSet = false;
  };

  provider.lastTokenSource = null;
  provider.hasPendingTokenSet = false;
  provider.credentialStore = credentialStore;
  return provider;
}

export async function authorizeWithBrowser({
  config,
  fetchImpl = globalThis.fetch,
  openBrowser = openSystemBrowser,
  onProgress = null,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
} = {}) {
  const oauth = requiredOAuthConfig(config);
  const redirectUri = parseCallbackRedirectUri(oauth.redirect_uri);
  const pkce = generatePkcePair();
  const state = base64Url(crypto.randomBytes(24));
  const callbackServer = await startOAuthCallbackServer({
    redirectUri,
    expectedState: state,
    timeoutMs,
  });
  callbackServer.waitForCode.catch(() => {});

  try {
    const authorizationUrl = buildAuthorizationUrl({ config, pkce, state });
    onProgress?.(`If the browser does not open, paste this Linear authorization URL: ${authorizationUrl.toString()}`);
    await openBrowser(authorizationUrl.toString());
    onProgress?.("Waiting for Linear authorization callback...");
    const code = await callbackServer.waitForCode;
    return exchangeAuthorizationCode({
      config,
      code,
      codeVerifier: pkce.verifier,
      fetchImpl,
    });
  } finally {
    await callbackServer.close();
  }
}

export function parseGrantedScopes(scope) {
  if (Array.isArray(scope)) return scope;
  if (typeof scope !== "string") return [];
  return scope.split(/[,\s]+/).filter(Boolean);
}

export function redactOAuthSecrets(message, secretValues = []) {
  let redacted = String(message || "");
  for (const secret of secretValues.filter(Boolean)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(
    /https?:\/\/127\.0\.0\.1:\d+\/linear\/oauth\/callback\?[^\s)]+/gi,
    "Linear OAuth callback URL [redacted]",
  );
  redacted = redacted.replace(
    /\b(access_token|refresh_token|client_secret|code|code_verifier)=([^&\s]+)/gi,
    "$1=[redacted]",
  );
  return redacted;
}

async function requestOAuthToken({
  fetchImpl,
  tokenEndpoint,
  form,
  requiredScopes,
  requireReturnedScopes,
  requireRefreshToken,
  fallbackRefreshToken,
  secretValues,
  requestTimeoutMs,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Linear OAuth requires a fetch implementation.");
  }

  const body = new URLSearchParams(form);
  const response = await fetchWithTimeout(
    fetchImpl,
    tokenEndpoint,
    {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    },
    requestTimeoutMs,
    "OAuth token request",
  );
  const payload = await parseOAuthResponse(response, secretValues);

  if (!response.ok) {
    throw new Error(
      `Linear OAuth token request failed with HTTP ${response.status}: ${oauthErrorMessage(payload, secretValues)}`,
    );
  }

  const tokenResponse = normalizeTokenResponse(payload, { requireRefreshToken, fallbackRefreshToken });
  if (requireReturnedScopes || tokenResponse.scope) {
    ensureRequiredScopes(tokenResponse.scope, requiredScopes);
  }
  return tokenResponse;
}

async function parseOAuthResponse(response, secretValues) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Linear OAuth response was not valid JSON: ${redactOAuthSecrets(text.slice(0, 160), secretValues)}`,
    );
  }
}

function normalizeTokenResponse(payload, { requireRefreshToken, fallbackRefreshToken } = {}) {
  if (!payload?.access_token) {
    throw new Error("Linear OAuth token response did not include an access token.");
  }
  if (requireRefreshToken && !payload.refresh_token) {
    throw new Error("Linear OAuth token response did not include a refresh token.");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || fallbackRefreshToken,
    tokenType: payload.token_type || "Bearer",
    expiresIn: payload.expires_in ?? null,
    scope: payload.scope || null,
  };
}

function ensureRequiredScopes(scope, requiredScopes) {
  const granted = new Set(parseGrantedScopes(scope));
  const missing = requiredScopes.filter((requiredScope) => !granted.has(requiredScope));
  if (missing.length > 0) {
    throw new Error(`Linear OAuth grant is missing required scope(s): ${missing.join(", ")}.`);
  }
}

function tokenResponseToStoredTokenSet(tokenResponse, nowMs, previousTokenSet = null) {
  const expiresAt =
    tokenResponse.expiresIn === null || tokenResponse.expiresIn === undefined
      ? null
      : new Date(nowMs + Number(tokenResponse.expiresIn) * 1000).toISOString();
  return {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    tokenType: tokenResponse.tokenType,
    ...(expiresAt ? { expiresAt } : {}),
    ...(tokenResponse.scope || previousTokenSet?.scope
      ? { scope: tokenResponse.scope || previousTokenSet.scope }
      : {}),
  };
}

function tokenSetHasUsableAccessToken(tokenSet, nowMs) {
  if (!tokenSet?.accessToken) return false;
  if (!tokenSet.expiresAt) return true;
  const expiresAt = Date.parse(tokenSet.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - TOKEN_EXPIRY_SKEW_MS > nowMs;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Linear ${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startOAuthCallbackServer({ redirectUri, expectedState, timeoutMs }) {
  let settled = false;
  let settleCode;
  let settleError;
  const waitForCode = new Promise((resolve, reject) => {
    settleCode = resolve;
    settleError = reject;
  });

  const server = http.createServer((request, response) => {
    const finish = (status, html) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    };

    try {
      if (request.method !== "GET") {
        finish(405, oauthCallbackPage({
          status: "failed",
          title: "Linear authorization failed",
          heading: "Unsupported callback method",
          body: "Return to your terminal and rerun setup if authorization did not continue.",
        }));
        return;
      }

      const callback = new URL(request.url, redirectUri.origin);
      if (callback.pathname !== redirectUri.pathname) {
        finish(404, oauthCallbackPage({
          status: "failed",
          title: "Linear authorization failed",
          heading: "Unexpected callback path",
          body: "Return to your terminal and rerun setup if authorization did not continue.",
        }));
        return;
      }

      const oauthError = callback.searchParams.get("error");
      if (oauthError) {
        finish(400, oauthCallbackPage({
          status: "failed",
          title: "Linear authorization failed",
          heading: "Linear authorization was not completed",
          body: "Return to your terminal for the exact error and next step. Nothing has been created.",
        }));
        rejectCallback(new Error(`Linear OAuth authorization failed: ${redactOAuthSecrets(oauthError)}`));
        return;
      }

      const returnedState = callback.searchParams.get("state");
      if (returnedState !== expectedState) {
        finish(400, oauthCallbackPage({
          status: "failed",
          title: "Linear authorization failed",
          heading: "Authorization session did not match",
          body: "Return to your terminal and rerun setup. Nothing has been created.",
        }));
        rejectCallback(new Error("Linear OAuth callback state did not match; authorization was rejected."));
        return;
      }

      const code = callback.searchParams.get("code");
      if (!code) {
        finish(400, oauthCallbackPage({
          status: "failed",
          title: "Linear authorization failed",
          heading: "Authorization code missing",
          body: "Return to your terminal and rerun setup. Nothing has been created.",
        }));
        rejectCallback(new Error("Linear OAuth callback did not include an authorization code."));
        return;
      }

      finish(200, oauthCallbackPage({
        status: "complete",
        title: "Linear authorization received",
        heading: "Linear authorization received",
        body:
          "Return to your terminal to confirm the authorized Linear workspace. Agentic Factory will not create anything until the workspace is verified.",
        next: "You can close this tab.",
      }));
      resolveCallback(code);
    } catch {
      finish(400, oauthCallbackPage({
        status: "failed",
        title: "Linear authorization failed",
        heading: "Callback could not be processed",
        body: "Return to your terminal and rerun setup. Nothing has been created.",
      }));
      rejectCallback(new Error("Linear OAuth callback could not be processed."));
    }
  });

  const timer = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for Linear OAuth authorization callback."));
    server.close();
  }, timeoutMs);

  server.on("close", () => {
    clearTimeout(timer);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      const cleanError = callbackServerError(error);
      rejectCallback(cleanError);
      reject(cleanError);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      server.on("error", (error) => rejectCallback(callbackServerError(error)));
      resolve();
    });
    server.listen(Number(redirectUri.port), "127.0.0.1");
  });

  return {
    waitForCode,
    async close() {
      clearTimeout(timer);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  function resolveCallback(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settleCode(code);
  }

  function rejectCallback(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settleError(error);
  }
}

function callbackServerError(error) {
  if (error.code === "EADDRINUSE") {
    return new Error("Linear OAuth callback port 8723 is already in use; free that port and rerun npm run init.");
  }
  return new Error(`Linear OAuth callback server failed: ${redactOAuthSecrets(error.message)}`);
}

function parseCallbackRedirectUri(redirectUri) {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Linear OAuth callback must bind to http://127.0.0.1.");
  }
  if (url.port !== "8723") {
    throw new Error("Linear OAuth callback must use registered port 8723.");
  }
  return url;
}

function oauthCallbackPage({ status, title, heading, body, next = "" } = {}) {
  const isComplete = status === "complete";
  const accent = isComplete ? "#0f7b45" : "#a33a24";
  const badge = isComplete ? "Authorization received" : "Action needed";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title || "Linear authorization")}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f8;
      color: #1d252c;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
    }
    main {
      width: min(560px, 100%);
      border: 1px solid #d9dee3;
      border-radius: 8px;
      background: #ffffff;
      padding: 32px;
      box-shadow: 0 16px 40px rgb(20 32 43 / 10%);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
      color: ${accent};
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: ${accent};
    }
    h1 {
      margin: 0 0 14px;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #4a5661;
      font-size: 16px;
      line-height: 1.55;
    }
    .next {
      margin-top: 20px;
      color: #1d252c;
      font-weight: 650;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        background: #11161b;
        color: #eef2f5;
      }
      main {
        background: #171d23;
        border-color: #303942;
        box-shadow: none;
      }
      p {
        color: #c3cbd2;
      }
      .next {
        color: #eef2f5;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="badge"><span class="dot"></span>${escapeHtml(badge)}</div>
    <h1>${escapeHtml(heading || title || "Linear authorization")}</h1>
    <p>${escapeHtml(body || "")}</p>
    ${next ? `<p class="next">${escapeHtml(next)}</p>` : ""}
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requiredOAuthConfig(config) {
  const oauth = config?.linear?.oauth;
  if (!oauth?.client_id || !oauth?.redirect_uri || !Array.isArray(oauth?.scopes) || !oauth?.actor) {
    throw new Error("Linear OAuth config is incomplete.");
  }
  return oauth;
}

function oauthErrorMessage(payload, secretValues) {
  const message = payload.error_description || payload.error || "unknown error";
  return redactOAuthSecrets(message, secretValues);
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function browserOpenInvocation(url, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
      env: process.env,
    };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url], env: process.env };
  }
  return { command: "xdg-open", args: [url], env: process.env };
}

function openSystemBrowser(url) {
  const invocation = browserOpenInvocation(url);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    env: invocation.env,
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(
          `Could not open the Linear authorization URL automatically: ${redactOAuthSecrets(error.message)}. Paste this URL in your browser: ${url}`,
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
