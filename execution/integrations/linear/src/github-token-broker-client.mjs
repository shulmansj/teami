import fs from "node:fs";
import path from "node:path";

const BROKER_TOKEN_AUTH_HEADER = "x-agentic-factory-github-broker-token";
const BROKER_CREDENTIAL_AUTH_HEADER = "x-agentic-factory-github-broker-credential";
const DEFAULT_BROKER_TOKEN_FILE = path.join(".agentic-factory", "github-broker-token.env");
const DEFAULT_BROKER_CREDENTIAL_FILE = path.join(".agentic-factory", "github-broker-credential.env");

function normalizeGitHubTokenBrokerBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("github_token_broker_url_invalid: base_url must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("github_token_broker_url_invalid: base_url must not include username or password");
  }
  if (!parsed.hostname) {
    throw new Error("github_token_broker_url_invalid: base_url host is required");
  }
  const localHttp = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("github_token_broker_url_invalid: base_url must use https unless it is localhost or 127.0.0.1");
  }
  return parsed.href.replace(/\/+$/, "");
}

function resolveContainedTokenFilePath({
  repoRoot,
  tokenFile,
  fileLabel = "token_file",
  errorPrefix = "github_token_broker_token_file_invalid",
}) {
  if (typeof tokenFile !== "string" || tokenFile.trim() === "") {
    throw new Error(`${errorPrefix}: ${fileLabel} must be a non-empty string`);
  }
  const parts = tokenFile.split(/[\\/]+/);
  if (parts.includes("..")) {
    throw new Error(`${errorPrefix}: ${fileLabel} may not contain traversal`);
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRepoRoot, tokenFile);
  const relative = path.relative(resolvedRepoRoot, resolvedPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${errorPrefix}: ${fileLabel} must resolve inside the repo root`);
  }
  return resolvedPath;
}

export function createGitHubTokenBrokerClient({
  config = null,
  fetchImpl = globalThis.fetch,
  repoRoot = globalThis.process?.cwd?.() || ".",
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("github_token_broker_fetch_required");
  const broker = config?.github?.token_broker || {};
  const baseUrl = normalizeGitHubTokenBrokerBaseUrl(
    broker.base_url || globalThis.process?.env?.AGENTIC_FACTORY_GITHUB_BROKER_URL || "",
  );
  assertNotPlaceholderSupabaseEndpoint(baseUrl);
  const credential = resolveGitHubBrokerCredential({ broker, repoRoot });
  const token = credential ? null : resolveGitHubBrokerToken({ broker, repoRoot });
  if (!baseUrl || (!credential && !token)) {
    throw new Error(
      "github_token_broker_not_configured: set github.token_broker.base_url and an installation-bound broker credential (github.token_broker.credential, credential_file, or env AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL). Maintainer sandbox proof tokens are accepted only through AGENTIC_FACTORY_GITHUB_BROKER_TOKEN or github.token_broker.token_file.",
    );
  }
  const auth = credential
    ? { header: BROKER_CREDENTIAL_AUTH_HEADER, value: credential }
    : { header: BROKER_TOKEN_AUTH_HEADER, value: token };
  const request = (route, body) =>
    requestJson(fetchImpl, `${baseUrl}${route}`, {
      method: "POST",
      body,
      auth,
    });
  return {
    baseUrl,
    async verifyInstallation(input) {
      return request("/v1/installations/verify", input);
    },
    async mintInstallationToken(input) {
      return request("/v1/installation-token", input);
    },
  };
}

function assertNotPlaceholderSupabaseEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return;
  }
  if (!parsed.hostname.toLowerCase().includes("your-project-ref")) return;
  throw new Error(
    "github_token_broker_placeholder_endpoint: github.token_broker.base_url still points at your-project-ref.supabase.co; configure the hosted GitHub broker endpoint from your setup provider or self-host using supabase/README.md.",
  );
}

export function resolveGitHubBrokerToken({
  broker = {},
  repoRoot = globalThis.process?.cwd?.() || ".",
} = {}) {
  if (broker.token) return String(broker.token);
  if (globalThis.process?.env?.AGENTIC_FACTORY_GITHUB_BROKER_TOKEN) {
    return globalThis.process.env.AGENTIC_FACTORY_GITHUB_BROKER_TOKEN;
  }
  const tokenFile = broker.token_file || DEFAULT_BROKER_TOKEN_FILE;
  const resolvedPath = resolveContainedTokenFilePath({ repoRoot, tokenFile });
  if (!fs.existsSync(resolvedPath)) return null;
  return readBrokerSecretFile(resolvedPath, "AGENTIC_FACTORY_GITHUB_BROKER_TOKEN");
}

export function resolveGitHubBrokerCredential({
  broker = {},
  repoRoot = globalThis.process?.cwd?.() || ".",
} = {}) {
  if (broker.credential) return String(broker.credential);
  const resolvedPath = githubBrokerCredentialFilePath({ broker, repoRoot });
  if (fs.existsSync(resolvedPath)) {
    return readBrokerSecretFile(resolvedPath, "AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL");
  }
  if (globalThis.process?.env?.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL) {
    return globalThis.process.env.AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL;
  }
  return null;
}

export function githubBrokerCredentialFilePath({
  broker = {},
  repoRoot = globalThis.process?.cwd?.() || ".",
} = {}) {
  return resolveContainedTokenFilePath({
    repoRoot,
    tokenFile: broker.credential_file || DEFAULT_BROKER_CREDENTIAL_FILE,
    fileLabel: "credential_file",
    errorPrefix: "github_token_broker_credential_file_invalid",
  });
}

export function writeGitHubBrokerCredential({
  broker = {},
  repoRoot = globalThis.process?.cwd?.() || ".",
  credential,
} = {}) {
  if (typeof credential !== "string" || credential.trim() === "") {
    throw new Error("github_broker_credential_missing: cannot persist an empty broker credential");
  }
  const resolvedPath = githubBrokerCredentialFilePath({ broker, repoRoot });
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  // The broker credential is a 1-hour bearer secret — write owner-only (0600). writeFileSync
  // mode only applies on create, so chmod (best-effort; no-op on Windows) covers rotation.
  fs.writeFileSync(
    resolvedPath,
    `AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL=${credential.trim()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try { fs.chmodSync(resolvedPath, 0o600); } catch { /* best effort */ }
  return { path: resolvedPath };
}

function readBrokerSecretFile(resolvedPath, envName) {
  const content = fs.readFileSync(resolvedPath, "utf8");
  const prefix = `${envName}=`;
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : content.trim() || null;
}

async function requestJson(fetchImpl, url, { method, body, auth }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      "content-type": "application/json",
      [auth.header]: auth.value,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GitHub token broker request failed with HTTP ${response.status}: ${payload.error || "unknown error"}`);
  }
  return payload;
}
