import { createLinearGraphqlClient } from "./linear-graphql-client.mjs";
import { createLinearOAuthTokenProvider } from "./linear-oauth.mjs";

export function createLinearSetupGraphqlClient({
  config,
  repoRoot = process.cwd(),
  credentialStore = null,
  fetchImpl = globalThis.fetch,
  allowBrowserAuth = false,
  allowRefresh = false,
  onProgress = null,
  openBrowser = undefined,
  deferTokenPersistence = false,
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
    deferTokenPersistence,
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
    credentialStoreKind: credentialStore.kind,
  };
}
