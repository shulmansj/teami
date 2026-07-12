import { createLinearGraphqlClient } from "./linear-graphql-client.mjs";
import {
  authorizeWithBrowser,
  createLinearOAuthTokenProvider,
  parseGrantedScopes,
  startLinearBrowserAuthorizationSession,
} from "./linear-oauth.mjs";

const LINEAR_OAUTH_REVOKE_ENDPOINT = "https://api.linear.app/oauth/revoke";
const OAUTH_REVOKE_TIMEOUT_MS = 30 * 1000;
const ONE_SHOT_ADMIN_SCOPES = ["read", "write", "admin"];

export function createLinearSetupGraphqlClient({
  config,
  repoRoot = process.cwd(),
  credentialStore = null,
  fetchImpl = globalThis.fetch,
  allowBrowserAuth = false,
  allowRefresh = false,
  onProgress = null,
  onAuthorizationUrl = null,
  openBrowser = undefined,
  authorize = authorizeWithBrowser,
  deferTokenPersistence = false,
  prompt = null,
  waitEscape = null,
} = {}) {
  if (!credentialStore) {
    throw new Error("Linear setup auth requires an explicit credential store.");
  }
  const store = credentialStore;
  const tokenProvider = createLinearOAuthTokenProvider({
    config,
    credentialStore: store,
    fetchImpl,
    allowBrowserAuth,
    allowRefresh,
    onProgress,
    onAuthorizationUrl,
    authorize,
    deferTokenPersistence,
    prompt,
    waitEscape,
    ...(openBrowser ? { openBrowser } : {}),
  });

  return {
    client: createLinearGraphqlClient({ fetchImpl, tokenProvider }),
    credentialStore: store,
    tokenProvider,
  };
}

export async function verifyLinearSetupAuth(options = {}) {
  const { client, credentialStore } = createLinearSetupGraphqlClient(options);
  const result = await client.verifyAuth();
  return {
    ok: true,
    viewerId: result.viewerId,
    viewerName: result.viewerName || null,
    credentialStoreKind: credentialStore.kind,
  };
}

export async function authorizeOneShotLinearAdmin({
  config,
  fetchImpl = globalThis.fetch,
  authorize = authorizeWithBrowser,
  openBrowser = undefined,
  onProgress = null,
  onAuthorizationUrl = null,
  revokeEndpoint = LINEAR_OAUTH_REVOKE_ENDPOINT,
} = {}) {
  const adminConfig = oneShotAdminOAuthConfig(config);
  const authorizeOptions = {
    config: adminConfig,
    fetchImpl,
    onProgress,
    onAuthorizationUrl,
    prompt: "consent",
    deferTokenPersistence: true,
  };
  if (openBrowser) authorizeOptions.openBrowser = openBrowser;

  try {
    return createOneShotLinearAdminGrant({
      tokenResponse: await authorize(authorizeOptions),
      fetchImpl,
      revokeEndpoint,
    });
  } catch (error) {
    throw error;
  }
}

export async function startOneShotLinearAdminAuthorizationSession({
  config,
  fetchImpl = globalThis.fetch,
  openBrowser = undefined,
  onProgress = null,
  onAuthorizationUrl = null,
  revokeEndpoint = LINEAR_OAUTH_REVOKE_ENDPOINT,
  timeoutMs = undefined,
  callbackWaitHintMs = undefined,
} = {}) {
  const session = await startLinearBrowserAuthorizationSession({
    config: oneShotAdminOAuthConfig(config),
    fetchImpl,
    ...(openBrowser ? { openBrowser } : {}),
    onProgress,
    onAuthorizationUrl,
    prompt: "consent",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(callbackWaitHintMs === undefined ? {} : { callbackWaitHintMs }),
  });
  return Object.freeze({
    authorizationUrl: session.authorizationUrl,
    expiresAt: session.expiresAt,
    get browser() {
      return session.browser;
    },
    async waitForGrant() {
      return createOneShotLinearAdminGrant({
        tokenResponse: await session.waitForToken(),
        fetchImpl,
        revokeEndpoint,
      });
    },
    close: () => session.close(),
  });
}

function createOneShotLinearAdminGrant({ tokenResponse, fetchImpl, revokeEndpoint } = {}) {
  let tokenSet = normalizeOneShotTokenSet(tokenResponse);
  let tornDown = false;
  async function tokenProvider() {
    if (tornDown) throw new Error("Linear one-shot admin OAuth grant has been torn down.");
    if (!tokenSet?.accessToken) throw new Error("Linear one-shot admin OAuth grant is unavailable.");
    return tokenSet.accessToken;
  }
  const adminClient = oneShotAdminClient(createLinearGraphqlClient({ fetchImpl, tokenProvider }));
  return Object.freeze({
    adminClient,
    async teardown() {
      if (tornDown) return { revokeVerified: false, alreadyTornDown: true };
      const tokenSetForRevoke = tokenSet;
      tokenSet = null;
      tornDown = true;
      return {
        revokeVerified: await bestEffortRevokeTokenSet({
          fetchImpl,
          revokeEndpoint,
          tokenSet: tokenSetForRevoke,
        }),
      };
    },
  });
}

function oneShotAdminOAuthConfig(config) {
  return {
    ...config,
    linear: {
      ...config?.linear,
      oauth: {
        ...config?.linear?.oauth,
        actor: "user",
        scopes: ONE_SHOT_ADMIN_SCOPES,
      },
    },
  };
}

function normalizeOneShotTokenSet(tokenResponse) {
  if (!tokenResponse?.accessToken) {
    throw new Error("Linear one-shot admin OAuth authorization did not return an access token.");
  }
  const grantedScopes = new Set(parseGrantedScopes(tokenResponse.scope));
  const missingScopes = ONE_SHOT_ADMIN_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Linear one-shot admin OAuth grant is missing required scope(s): ${missingScopes.join(", ")}.`);
  }
  return {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken || null,
    tokenType: tokenResponse.tokenType || "Bearer",
    scope: tokenResponse.scope || null,
  };
}

function oneShotAdminClient(rawClient) {
  const client = {};
  if (typeof rawClient.createProjectStatus === "function") {
    client.createProjectStatus = (...args) => rawClient.createProjectStatus(...args);
  }
  if (typeof rawClient.getOrganization === "function") {
    client.getOrganization = (...args) => rawClient.getOrganization(...args);
  }
  return Object.freeze(client);
}

async function bestEffortRevokeTokenSet({ fetchImpl, revokeEndpoint, tokenSet } = {}) {
  if (!tokenSet) return false;
  const tokens = [
    ["refresh_token", tokenSet.refreshToken],
    ["access_token", tokenSet.accessToken],
  ].filter(([, token]) => token);

  if (tokens.length === 0 || typeof fetchImpl !== "function") return false;
  let verified = true;
  for (const [tokenTypeHint, token] of tokens) {
    try {
      const response = await postOAuthRevoke({ fetchImpl, revokeEndpoint, token, tokenTypeHint });
      if (!await revokeResponseVerified(response)) verified = false;
    } catch {
      // Memory discard is the guarantee; remote revocation is defense-in-depth.
      verified = false;
    }
  }
  return verified;
}

async function revokeResponseVerified(response) {
  if (response?.ok) return true;
  if (![400, 401].includes(response?.status) || typeof response.text !== "function") return false;
  try {
    const body = (await response.text()).slice(0, 512);
    return /"error"\s*:\s*"Token has already been revoked\."/i.test(body);
  } catch {
    return false;
  }
}

export async function revokeLinearOAuthTokenSet({
  tokenSet,
  fetchImpl = globalThis.fetch,
  revokeEndpoint = LINEAR_OAUTH_REVOKE_ENDPOINT,
} = {}) {
  return {
    revokeVerified: await bestEffortRevokeTokenSet({ fetchImpl, revokeEndpoint, tokenSet }),
  };
}

async function postOAuthRevoke({ fetchImpl, revokeEndpoint, token, tokenTypeHint }) {
  if (typeof fetchImpl !== "function") return;
  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_REVOKE_TIMEOUT_MS);
  try {
    return await fetchImpl(revokeEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
