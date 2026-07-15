import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";

import {
  LINEAR_OAUTH_CALLBACK,
  isLinearOAuthCallbackPort,
} from "./config.mjs";
import { redactGitHubSecrets } from "./github-secret-hygiene.mjs";
import { formatCommand } from "./cli/operator-output.mjs";

const DEFAULT_AUTHORIZATION_ENDPOINT = "https://linear.app/oauth/authorize";
const DEFAULT_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CALLBACK_WAIT_HINT_MS = 30 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
export const LINEAR_OAUTH_WAIT_ESCAPED_CODE = "linear_oauth_wait_escaped";
export const OAUTH_CALLBACK_LISTENER = LINEAR_OAUTH_CALLBACK;

export function generatePkcePair({ randomBytes = crypto.randomBytes } = {}) {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

// prompt defaults to NONE to avoid an unnecessary repeated consent screen. Linear's actor=app
// flow can still land on the non-redirecting "already installed / Manage" page with or without
// prompt=consent. Callers must surface that recovery branch while the callback listener is alive.
// Paths that genuinely need the workspace picker still pass prompt: "consent" explicitly.
export function buildAuthorizationUrl({
  config,
  pkce,
  state,
  authorizationEndpoint = DEFAULT_AUTHORIZATION_ENDPOINT,
  prompt = null,
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
  onAuthorizationUrl = null,
  openBrowser = openSystemBrowser,
  deferTokenPersistence = false,
  prompt = null,
  waitEscape = null,
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
        throw new Error(`Linear OAuth access token is expired or unavailable; run ${formatCommand("init")}.`);
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
      throw new Error(`Linear OAuth authorization is missing; run ${formatCommand("init")}.`);
    }

    onProgress?.("Opening Linear authorization in your browser...");
    const authorized = await authorize({
      config,
      fetchImpl,
      openBrowser,
      onProgress,
      onAuthorizationUrl,
      prompt,
      waitEscape,
    });
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
  onAuthorizationUrl = null,
  prompt = null,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  callbackWaitHintMs = DEFAULT_CALLBACK_WAIT_HINT_MS,
  waitEscape = null,
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
  const callbackConfig = configWithOAuthRedirectUri(config, callbackServer.redirectUri.toString());

  try {
    const authorizationUrl = buildAuthorizationUrl({ config: callbackConfig, pkce, state, prompt });
    onAuthorizationUrl?.(authorizationUrl.toString());
    onProgress?.(`If the browser does not open, paste this Linear authorization URL: ${authorizationUrl.toString()}`);
    await openBrowser(authorizationUrl.toString());
    // No dead air: the moment the wait begins, state every plausible browser outcome and the
    // exact action for each. A user staring at Linear's "already installed" page must not sit
    // through a silent timer wondering whether setup is broken — the fork is disclosed up front
    // and the press-Enter escape (when interactive) is live from second zero. The timer below is
    // only a gentle reminder, never the first disclosure.
    onProgress?.("Waiting for Linear authorization callback...");
    onProgress?.("-> If Linear asks you to authorize: approve, and setup continues automatically.");
    onProgress?.(
      typeof waitEscape === "function"
        ? "-> If Linear shows 'Teami already installed': that page will not redirect. Click Manage there (or open Linear Settings -> Applications) and remove Teami's access, then press Enter here to reopen a fresh sign-in."
        : "-> If Linear shows 'Teami already installed': that page will not redirect. Click Manage there (or open Linear Settings -> Applications) and remove Teami's access, then re-run setup.",
    );
    let callbackWaitHintTimer = null;
    let authorizationSettled = false;
    let waitEscapeCancel = null;
    let waitEscapeCancelCalled = false;
    let resolveWaitEscaped;
    const waitEscaped = new Promise((resolve) => {
      resolveWaitEscaped = resolve;
    });
    const cancelWaitEscape = () => {
      if (!waitEscapeCancel || waitEscapeCancelCalled) return;
      waitEscapeCancelCalled = true;
      try {
        waitEscapeCancel();
      } catch {
        // Best-effort cleanup only. OAuth outcome should be driven by Linear's callback.
      }
    };
    const markWaitEscaped = () => {
      if (!authorizationSettled) resolveWaitEscaped({ type: "wait_escape" });
    };
    const attachWaitEscapeSession = (session) => {
      if (!session) return;
      if (typeof session.then === "function") {
        session.then((value) => {
          if (value && typeof value === "object" && ("promise" in value || "cancel" in value)) {
            attachWaitEscapeSession(value);
            return;
          }
          markWaitEscaped();
        }, () => {});
        return;
      }
      if (typeof session.cancel === "function") {
        waitEscapeCancel = session.cancel;
        if (authorizationSettled) cancelWaitEscape();
      }
      Promise.resolve(session.promise).then(markWaitEscaped, () => {});
    };
    const startWaitEscape = () => {
      if (typeof waitEscape !== "function") return;
      try {
        attachWaitEscapeSession(waitEscape());
      } catch {
        // The escape hook is an interactive affordance. If it fails, keep waiting for Linear.
      }
    };
    try {
      startWaitEscape();
      if (typeof onProgress === "function" && Number.isFinite(callbackWaitHintMs) && callbackWaitHintMs >= 0) {
        callbackWaitHintTimer = setTimeout(() => {
          onProgress(
            "Still waiting for Linear — the two options above still apply.",
          );
        }, callbackWaitHintMs);
        callbackWaitHintTimer.unref?.();
      }
      const waitResult = await Promise.race([
        callbackServer.waitForCode.then((code) => ({ type: "callback", code })),
        waitEscaped,
      ]);
      authorizationSettled = true;
      if (waitResult?.type === "wait_escape") {
        throw linearOAuthWaitEscapedError();
      }
      cancelWaitEscape();
      const code = waitResult.code;
      return exchangeAuthorizationCode({
        config: callbackConfig,
        code,
        codeVerifier: pkce.verifier,
        fetchImpl,
      });
    } finally {
      authorizationSettled = true;
      if (callbackWaitHintTimer) clearTimeout(callbackWaitHintTimer);
      cancelWaitEscape();
    }
  } finally {
    await callbackServer.close();
  }
}

// Starts the exact same browser/callback implementation used by the blocking CLI surface, but
// exposes the live URL before the callback completes. No OAuth code, PKCE verifier, or token is
// returned until waitForToken() resolves, and callers must keep this in process memory only.
export async function startLinearBrowserAuthorizationSession({
  config,
  fetchImpl = globalThis.fetch,
  openBrowser = openSystemBrowser,
  onProgress = null,
  onAuthorizationUrl = null,
  prompt = null,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  callbackWaitHintMs = DEFAULT_CALLBACK_WAIT_HINT_MS,
  now = () => Date.now(),
} = {}) {
  let settleStarted;
  let rejectStarted;
  let settleClose;
  let closed = false;
  let started = false;
  let browser = { opened: null, reason: null };
  const startedPromise = new Promise((resolve, reject) => {
    settleStarted = resolve;
    rejectStarted = reject;
  });
  const closePromise = new Promise((resolve) => {
    settleClose = resolve;
  });

  const tokenPromise = authorizeWithBrowser({
    config,
    fetchImpl,
    onProgress,
    onAuthorizationUrl: (url) => {
      onAuthorizationUrl?.(url);
    },
    prompt,
    timeoutMs,
    callbackWaitHintMs,
    waitEscape: () => ({
      promise: closePromise,
      cancel() {},
    }),
    openBrowser: async (url) => {
      try {
        await openBrowser(url);
        browser = { opened: true, reason: null };
      } catch (error) {
        // Keep the callback listener alive: the returned manual URL is the recovery path.
        browser = {
          opened: false,
          reason: redactOAuthSecrets(error?.message || String(error)),
        };
      }
      started = true;
      settleStarted({ authorizationUrl: url });
    },
  });
  tokenPromise.catch((error) => {
    if (!started) rejectStarted(error);
  });

  const { authorizationUrl } = await startedPromise;
  const expiresAt = new Date(now() + timeoutMs).toISOString();
  return Object.freeze({
    authorizationUrl,
    expiresAt,
    get browser() {
      return Object.freeze({ ...browser });
    },
    waitForToken: () => tokenPromise,
    async close() {
      if (closed) return false;
      closed = true;
      settleClose();
      await tokenPromise.catch(() => {});
      return true;
    },
  });
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
  return redactGitHubSecrets(redacted);
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
  let activeRedirectUri = redirectUri;

  const requestListener = (request, response) => {
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

      const callback = new URL(request.url, activeRedirectUri.origin);
      if (callback.pathname !== activeRedirectUri.pathname) {
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
          "Return to your terminal to confirm the authorized Linear workspace. Teami will not create anything until the workspace is verified.",
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
  };

  const listenResult = await listenOnAvailableCallbackPort({ redirectUri, requestListener });
  const server = listenResult.server;
  activeRedirectUri = listenResult.redirectUri;
  const waitForCode = new Promise((resolve, reject) => {
    settleCode = resolve;
    settleError = reject;
  });

  const timer = setTimeout(() => {
    rejectCallback(linearOAuthCallbackTimeoutError());
    server.close();
  }, timeoutMs);

  server.on("close", () => {
    clearTimeout(timer);
  });
  server.on("error", (error) => rejectCallback(callbackServerError(error)));

  return {
    redirectUri: activeRedirectUri,
    waitForCode,
    async close() {
      clearTimeout(timer);
      if (!server.listening) return;
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

export function isLinearOAuthWaitEscapedError(error) {
  return error?.code === LINEAR_OAUTH_WAIT_ESCAPED_CODE;
}

function linearOAuthWaitEscapedError() {
  const error = new Error("Linear OAuth authorization wait was escaped; reopen the browser authorization.");
  error.code = LINEAR_OAUTH_WAIT_ESCAPED_CODE;
  return error;
}

function linearOAuthCallbackTimeoutError() {
  const firewallHint = oauthFirewallHint();
  return new Error(
    "Timed out waiting for Linear OAuth authorization callback. " +
      "Linear never sent the browser callback to Teami's local listener. " +
      "This most commonly happens when the browser shows 'Teami already installed' instead of an authorize screen; that Linear management page does not redirect back to Teami. " +
      `Revoke Teami under Linear Settings -> Applications, then re-run ${formatCommand("init")}.` +
      (firewallHint ? ` ${firewallHint}` : ""),
  );
}

async function listenOnAvailableCallbackPort({ redirectUri, requestListener }) {
  const preferredPort = Number(redirectUri.port);
  const candidatePorts = oauthCallbackPortCandidates(preferredPort);
  let lastInUseError = null;

  for (const port of candidatePorts) {
    const server = http.createServer(requestListener);
    try {
      await listenOnCallbackPort(server, port);
      return { server, redirectUri: callbackRedirectUriForPort(redirectUri, port) };
    } catch (error) {
      server.removeAllListeners();
      if (error.code === "EADDRINUSE") {
        lastInUseError = error;
        continue;
      }
      throw callbackServerError(error);
    }
  }

  throw callbackPortRangeUnavailableError(lastInUseError);
}

function listenOnCallbackPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LINEAR_OAUTH_CALLBACK.host);
  });
}

function oauthCallbackPortCandidates(preferredPort) {
  const { start, end } = LINEAR_OAUTH_CALLBACK.portRange;
  const ports = [];
  if (isLinearOAuthCallbackPort(preferredPort)) ports.push(preferredPort);
  for (let port = start; port <= end; port += 1) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function callbackRedirectUriForPort(redirectUri, port) {
  const url = new URL(redirectUri.toString());
  url.port = String(port);
  return url;
}

function callbackServerError(error) {
  if (error.code === "EADDRINUSE") {
    return callbackPortRangeUnavailableError(error);
  }
  return new Error(`Linear OAuth callback server failed: ${redactOAuthSecrets(error.message)}`);
}

function callbackPortRangeUnavailableError(cause = null) {
  const { start, end } = LINEAR_OAUTH_CALLBACK.portRange;
  const label = start === end ? String(start) : `${start}-${end}`;
  const detail = cause?.code ? ` (${cause.code})` : "";
  return new Error(`Linear OAuth callback ports ${label} are already in use${detail}; close another local setup and rerun ${formatCommand("init")}.`);
}

function parseCallbackRedirectUri(redirectUri) {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || url.hostname !== LINEAR_OAUTH_CALLBACK.host) {
    throw new Error(`Linear OAuth callback must bind to http://${LINEAR_OAUTH_CALLBACK.host}.`);
  }
  if (!isLinearOAuthCallbackPort(url.port) || url.pathname !== LINEAR_OAUTH_CALLBACK.pathname) {
    const { start, end } = LINEAR_OAUTH_CALLBACK.portRange;
    const label = start === end ? String(start) : `${start}-${end}`;
    throw new Error(`Linear OAuth callback must use ${LINEAR_OAUTH_CALLBACK.pathname} on registered port ${label}.`);
  }
  return url;
}

function configWithOAuthRedirectUri(config, redirectUri) {
  return {
    ...config,
    linear: {
      ...config?.linear,
      oauth: {
        ...config?.linear?.oauth,
        redirect_uri: redirectUri,
      },
    },
  };
}

export function oauthFirewallHint({ platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  const { start, end } = LINEAR_OAUTH_CALLBACK.portRange;
  const portLabel = start === end ? String(start) : `${start}-${end}`;
  return `Windows may show a Defender Firewall prompt the first time Teami opens the Linear sign-in callback. Allow private networks for Node.js; Teami only listens on ${LINEAR_OAUTH_CALLBACK.host} ports ${portLabel} so your browser can return the authorization code to this terminal.`;
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
