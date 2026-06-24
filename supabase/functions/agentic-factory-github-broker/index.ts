import jwt from "npm:jsonwebtoken@9.0.2";

const FUNCTION_SLUG = "agentic-factory-github-broker";
const BROKER_HEADER = "x-agentic-factory-github-broker-token";
const BROKER_CREDENTIAL_HEADER = "x-agentic-factory-github-broker-credential";
const BROKER_CREDENTIAL_PREFIX = "af_broker_v1";
// Broker request bodies are tiny (owner/repo/permissions). Cap them so an unauthenticated
// caller can't force a large allocation. (True streaming abort is a deploy-side follow-up;
// the Supabase gateway also bounds request size — this is in-code defense in depth.)
const MAX_BROKER_BODY_BYTES = 64 * 1024;
const REQUIRED_APP_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
};

type BrokerCredentialPayload = {
  v: 1;
  workspaceId: string;
  teamId: string;
  installationId: string;
  owner: string;
  repo: string;
  exp: number;
};

type BrokerAuthScope =
  | { mode: "credential"; owner: string; repo: string; workspaceId: string; teamId: string; installationId: string }
  | { mode: "break_glass" };

type StructuredLogFieldValue = string | number | boolean | null | undefined;

const STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  github_broker_auth_denied: new Set(["route", "reason", "status"]),
  github_installation_token_minted: new Set([
    "owner",
    "repo",
    "installationId",
    "authMode",
    "workspaceId",
    "teamId",
    "permissionKeys",
    "repositorySelection",
  ]),
};

const STRUCTURED_SECURITY_LOG_SENSITIVE_VALUE_PATTERNS = [
  /\bgh[opsru]_[A-Za-z0-9_]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\baf_(?:setup|broker|runner)_v\d_[A-Za-z0-9_-]+/i,
  /\bri_[A-Za-z0-9]{32,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

Deno.serve(async (req: Request) => {
  let route = "/";
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    route = routeFor(req);
    if (route === "/status" && req.method === "GET") return json({ ok: true, service: FUNCTION_SLUG });
    const auth = await resolveBrokerAuth(req);
    const body = await readJson(req);
    switch (`${req.method} ${route}`) {
      case "POST /v1/installations/verify":
        return json(await verifyInstallation(body, auth));
      case "POST /v1/installation-token":
        return json(await mintInstallationToken(body, auth));
      default:
        throw httpError(404, `Unknown GitHub broker route: ${route}`);
    }
  } catch (error) {
    const caught = error as { status?: number; message?: string } | null | undefined;
    const status = typeof caught?.status === "number" ? caught.status : 500;
    if (status === 401 || status === 403) {
      emitHostedSecurityLog("github_broker_auth_denied", {
        route,
        status,
        reason: caught?.message || "unknown error",
      });
    }
    return json({ ok: false, error: caught?.message || "unknown error" }, status);
  }
});

async function verifyInstallation(input: Record<string, unknown>, auth: BrokerAuthScope) {
  const owner = requireString(input.owner, "owner");
  const repo = requireString(input.repo, "repo");
  enforceBrokerCredentialRepoScope(auth, { owner, repo });
  expectedAppIdentity();
  const installation = await getRepoInstallation({ owner, repo });
  enforceBrokerCredentialInstallationScope(auth, installation);
  verifyExpectedApp(installation);
  const permissionVerification = verifyPermissionSnapshot(installation.permissions || {});
  if (!permissionVerification.ok) {
    throw httpError(409, `github_app_permissions_not_exact:${describePermissionVerification(permissionVerification)}`);
  }
  return {
    ok: true,
    installation: {
      id: installation.id,
      app_id: installation.app_id,
      app_slug: installation.app_slug,
      account: installation.account?.login ?? null,
      repository_selection: installation.repository_selection ?? null,
      permissions: installation.permissions || {},
    },
  };
}

async function mintInstallationToken(input: Record<string, unknown>, auth: BrokerAuthScope) {
  const owner = requireString(input.owner, "owner");
  const repo = requireString(input.repo, "repo");
  enforceBrokerCredentialRepoScope(auth, { owner, repo });
  const verified = await verifyInstallation(input, auth);
  enforceBrokerCredentialInstallationScope(auth, { id: verified.installation.id });
  const permissions = requestedPermissions(input.permissions);
  const response = await githubJson(`/app/installations/${verified.installation.id}/access_tokens`, {
    method: "POST",
    appJwt: githubAppJwt(),
    body: {
      repositories: [repo],
      permissions,
    },
  });
  emitHostedSecurityLog("github_installation_token_minted", {
    owner,
    repo,
    installationId: String(verified.installation.id),
    authMode: auth.mode,
    workspaceId: auth.mode === "credential" ? auth.workspaceId : null,
    teamId: auth.mode === "credential" ? auth.teamId : null,
    permissionKeys: Object.keys(permissions).sort().join(","),
    repositorySelection: String(response.repository_selection ?? "selected"),
  });
  return {
    ok: true,
    token: response.token,
    expires_at: response.expires_at,
    permissions: response.permissions || permissions,
    repository_selection: response.repository_selection ?? "selected",
  };
}

async function getRepoInstallation({ owner, repo }: { owner: string; repo: string }) {
  return githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
    method: "GET",
    appJwt: githubAppJwt(),
  });
}

async function githubJson(path: string, {
  method,
  appJwt,
  body = null,
}: {
  method: string;
  appJwt: string;
  body?: Record<string, unknown> | null;
}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw httpError(response.status, `github_api_failed:${method}:${path}:${payload.message || "unknown"}`);
  }
  return payload;
}

function githubAppJwt() {
  const appId = Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_ID") || Deno.env.get("GITHUB_APP_ID");
  const privateKey = Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_PRIVATE_KEY") || Deno.env.get("GITHUB_APP_PRIVATE_KEY");
  if (!appId) throw httpError(503, "github_app_id_not_configured");
  if (!privateKey) throw httpError(503, "github_app_private_key_not_configured");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId },
    privateKey.replace(/\\n/g, "\n"),
    { algorithm: "RS256" },
  );
}

function verifyExpectedApp(installation: Record<string, any>) {
  const { expectedId, expectedSlug } = expectedAppIdentity();
  if (expectedId && String(installation.app_id) !== expectedId) {
    throw httpError(409, `github_app_id_mismatch:expected=${expectedId}:actual=${installation.app_id}`);
  }
  if (!installation.app_slug) {
    throw httpError(409, "github_app_slug_unverifiable");
  }
  if (expectedSlug && String(installation.app_slug) !== expectedSlug) {
    throw httpError(409, `github_app_slug_mismatch:expected=${expectedSlug}:actual=${installation.app_slug}`);
  }
}

function expectedAppIdentity() {
  const expectedId = String(Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_ID") || Deno.env.get("GITHUB_APP_ID") || "");
  const expectedSlug = String(Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_SLUG") || Deno.env.get("GITHUB_APP_SLUG") || "");
  if (!expectedId || !expectedSlug) {
    throw httpError(503, "github_app_identity_not_configured");
  }
  return { expectedId, expectedSlug };
}

function verifyPermissionSnapshot(permissions: Record<string, string>) {
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const [key, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    if (!(key in permissions)) missing.push(key);
    else if (permissions[key] !== level) wrong.push(`${key}=${permissions[key]} (expected ${level})`);
  }
  const extra = Object.keys(permissions).filter((key) => !(key in REQUIRED_APP_PERMISSIONS));
  return {
    ok: missing.length === 0 && wrong.length === 0 && extra.length === 0,
    missing,
    wrong,
    extra,
  };
}

function describePermissionVerification(verification: { missing: string[]; wrong: string[]; extra: string[] }) {
  const parts = [];
  if (verification.missing.length > 0) parts.push(`missing=${verification.missing.join(",")}`);
  if (verification.wrong.length > 0) parts.push(`wrong=${verification.wrong.join(",")}`);
  if (verification.extra.length > 0) parts.push(`extra=${verification.extra.join(",")}`);
  return parts.join(";") || "ok";
}

function requestedPermissions(value: unknown) {
  const requested = typeof value === "object" && value ? value as Record<string, string> : {};
  const allowed = new Set(Object.keys(REQUIRED_APP_PERMISSIONS));
  for (const key of Object.keys(requested)) {
    if (!allowed.has(key)) throw httpError(400, `permission_not_allowed:${key}`);
    if (!["read", "write"].includes(requested[key])) throw httpError(400, `invalid_permission_level:${key}`);
    if (REQUIRED_APP_PERMISSIONS[key] === "read" && requested[key] !== "read") {
      throw httpError(400, `permission_level_too_high:${key}`);
    }
  }
  return Object.keys(requested).length > 0 ? requested : { contents: "write", pull_requests: "write" };
}

async function resolveBrokerAuth(req: Request): Promise<BrokerAuthScope> {
  const credential = req.headers.get(BROKER_CREDENTIAL_HEADER) || "";
  if (credential) {
    const key = Deno.env.get("AGENTIC_FACTORY_BROKER_CREDENTIAL_SIGNING_KEY");
    if (!key) throw httpError(503, "broker_credential_signing_key_not_configured");
    const payload = await verifyBrokerCredential({
      key,
      token: credential,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!payload) throw httpError(401, "invalid_github_broker_credential");
    return {
      mode: "credential",
      owner: payload.owner,
      repo: payload.repo,
      workspaceId: payload.workspaceId,
      teamId: payload.teamId,
      installationId: payload.installationId,
    };
  }

  const breakGlassToken = req.headers.get(BROKER_HEADER) || "";
  const expected = Deno.env.get("AGENTIC_FACTORY_GITHUB_BROKER_TOKEN") || Deno.env.get("GITHUB_BROKER_TOKEN");
  if (breakGlassToken && expected && constantTimeEqual(breakGlassToken, expected)) {
    return { mode: "break_glass" };
  }
  if (breakGlassToken && !expected) throw httpError(503, "github_broker_token_not_configured");
  if (breakGlassToken) throw httpError(401, "invalid_github_broker_token");
  throw httpError(401, "github_broker_auth_required");
}

function enforceBrokerCredentialRepoScope(
  auth: BrokerAuthScope,
  { owner, repo }: { owner: string; repo: string },
) {
  if (auth.mode !== "credential") return;
  if (auth.owner !== owner || auth.repo !== repo) {
    throw httpError(403, "broker_credential_repo_mismatch");
  }
}

function enforceBrokerCredentialInstallationScope(auth: BrokerAuthScope, installation: Record<string, unknown>) {
  if (auth.mode !== "credential") return;
  if (String(installation.id) !== auth.installationId) {
    throw httpError(403, "broker_credential_installation_mismatch");
  }
}

async function verifyBrokerCredential({
  key,
  token,
  nowSeconds,
}: {
  key: string;
  token: string;
  nowSeconds: number;
}): Promise<BrokerCredentialPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== BROKER_CREDENTIAL_PREFIX) return null;
    const segment = parts[1];
    const sig = parts[2];
    const expectedSig = await hmacBrokerCredentialSegment({ key, segment });
    if (!constantTimeEqual(sig, expectedSig)) return null;
    const payload = brokerCredentialPayloadFromUnknown(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))),
    );
    if (!payload) return null;
    if (payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacBrokerCredentialSegment({ key, segment }: { key: string; segment: string }) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(segment));
  return base64UrlEncode(new Uint8Array(signature));
}

function brokerCredentialPayloadFromUnknown(value: unknown): BrokerCredentialPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (!isNonEmptyString(record.workspaceId)) return null;
  if (!isNonEmptyString(record.teamId)) return null;
  if (!isNonEmptyString(record.installationId)) return null;
  if (!isNonEmptyString(record.owner)) return null;
  if (!isNonEmptyString(record.repo)) return null;
  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  return {
    v: 1,
    workspaceId: String(record.workspaceId),
    teamId: String(record.teamId),
    installationId: String(record.installationId),
    owner: String(record.owner),
    repo: String(record.repo),
    exp: record.exp,
  };
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readJson(req: Request) {
  const contentLength = req.headers.get("content-length");
  if (contentLength != null && contentLength.trim() !== "") {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared > MAX_BROKER_BODY_BYTES) {
      throw httpError(413, "payload_too_large");
    }
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BROKER_BODY_BYTES) {
    throw httpError(413, "payload_too_large");
  }
  return text ? JSON.parse(text) : {};
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emitHostedSecurityLog(event: string, fields: Record<string, StructuredLogFieldValue> = {}) {
  const allowedFields = STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS[event] || new Set();
  const entry: Record<string, string | number | boolean | null> = {
    event,
    service: FUNCTION_SLUG,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "event" || key === "service" || !allowedFields.has(key)) continue;
    if (!structuredLogValueAllowed(value)) continue;
    entry[key] = value;
  }
  console.info(JSON.stringify(entry));
}

function structuredLogValueAllowed(value: unknown): value is string | number | boolean | null {
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  if (value.length > 512) return false;
  return !STRUCTURED_SECURITY_LOG_SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function routeFor(req: Request) {
  const url = new URL(req.url);
  const marker = `/${FUNCTION_SLUG}`;
  const index = url.pathname.indexOf(marker);
  const route = index >= 0 ? url.pathname.slice(index + marker.length) : url.pathname;
  return route || "/";
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") throw httpError(400, `${label}_required`);
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function constantTimeEqual(a: string, b: string) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}
