import fs from "node:fs";
import path from "node:path";

const DEFAULT_SETUP_GRANT_FILE = path.join(".agentic-factory", "inbox-setup-grant.env");

export function createHostedInboxClient({
  config,
  fetchImpl = globalThis.fetch,
  repoRoot = globalThis.process?.cwd?.() || ".",
} = {}) {
  const inbox = config?.inbox;
  if (!inbox?.base_url) throw new Error("Hosted inbox base_url is required.");
  if (typeof fetchImpl !== "function") throw new Error("Hosted inbox client requires fetch.");
  const baseUrl = inbox.base_url.replace(/\/+$/, "");
  assertNotPlaceholderSupabaseEndpoint(baseUrl);
  const resolveSetupGrant = () => resolveInboxSetupGrant({ inbox, repoRoot });

  return {
    async requestSetupGrant(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/setup-grants`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: input?.bypassActiveConflict ? setupGrantForRequest(input, resolveSetupGrant) : null,
      });
    },

    async setupGrantStatus(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/setup-grants/status`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async revokeSetupGrant(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/setup-grants/revoke`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async githubInstallIntent(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/github/install-intent`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async githubInstallStatus(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/setup-grants/status`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async issueBrokerCredential(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/broker-credentials`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async putLinearWebhookSecret(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/linear/webhook-secret`, {
        method: "PUT",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async verifyLinearWebhookSecret(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/linear/webhook-secret/verify`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async deleteLinearWebhookSecret(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/linear/webhook-secret`, {
        method: "DELETE",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async mintRunnerCredential(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/runner-credentials`, {
        method: "POST",
        body: stripSetupGrant(input),
        setupGrant: setupGrantForRequest(input, resolveSetupGrant),
      });
    },

    async verifyRunnerCredential(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/runner-credentials/verify`, {
        method: "POST",
        body: input,
      });
    },

    async revokeRunnerCredential(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/runner-credentials/revoke`, {
        method: "POST",
        body: input,
      });
    },

    async heartbeatRunner(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/runner-heartbeats`, {
        method: "POST",
        body: input,
      });
    },

    async claimNextWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/claim`, {
        method: "POST",
        body: input,
      });
    },

    async renewWakeLease(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/renew-lease`, {
        method: "POST",
        body: input,
      });
    },

    async markWakeRunning(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/mark-running`, {
        method: "POST",
        body: input,
      });
    },

    async releaseWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/release`, {
        method: "POST",
        body: input,
      });
    },

    async markWakeRoutingError(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/routing-error`, {
        method: "POST",
        body: input,
      });
    },

    async requeueWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/requeue`, {
        method: "POST",
        body: input,
      });
    },

    async markWakeMutationStarted(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/mark-mutation-started`, {
        method: "POST",
        body: input,
      });
    },

    async completeWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/complete`, {
        method: "POST",
        body: input,
      });
    },

    async deadLetterWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/dead-letter`, {
        method: "POST",
        body: input,
      });
    },

    async getWake(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/get`, {
        method: "POST",
        body: input,
      });
    },

    async listWakeViews(input) {
      return requestJson(fetchImpl, `${baseUrl}/v1/wakeups/views`, {
        method: "POST",
        body: input,
      });
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
    "hosted_inbox_placeholder_endpoint: inbox.base_url still points at your-project-ref.supabase.co; configure the hosted inbox endpoint from your setup provider or self-host using supabase/README.md.",
  );
}

export function resolveInboxSetupGrant({ inbox, repoRoot = globalThis.process?.cwd?.() || "." } = {}) {
  if (inbox?.setup_grant) return inbox.setup_grant;
  if (inbox?.setup_grant_token) return inbox.setup_grant_token;
  if (globalThis.process?.env?.AGENTIC_FACTORY_INBOX_SETUP_GRANT) {
    return globalThis.process.env.AGENTIC_FACTORY_INBOX_SETUP_GRANT;
  }
  return readInboxSetupGrantFile({ inbox, repoRoot }).setupGrant;
}

export function inboxSetupGrantFilePath({ inbox = {}, repoRoot = globalThis.process?.cwd?.() || "." } = {}) {
  return path.resolve(repoRoot, inbox?.setup_grant_file || DEFAULT_SETUP_GRANT_FILE);
}

export function readInboxSetupGrantFile({ inbox = {}, repoRoot = globalThis.process?.cwd?.() || "." } = {}) {
  const resolvedPath = inboxSetupGrantFilePath({ inbox, repoRoot });
  if (!fs.existsSync(resolvedPath)) return { exists: false, path: resolvedPath, setupGrant: null };
  const content = fs.readFileSync(resolvedPath, "utf8");
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("AGENTIC_FACTORY_INBOX_SETUP_GRANT="));
  const setupGrant = line
    ? line.replace(/^AGENTIC_FACTORY_INBOX_SETUP_GRANT=/, "").trim()
    : content.trim() || null;
  return { exists: true, path: resolvedPath, setupGrant };
}

export function writeInboxSetupGrant({
  inbox = {},
  repoRoot = globalThis.process?.cwd?.() || ".",
  setupGrant,
} = {}) {
  if (typeof setupGrant !== "string" || setupGrant.trim() === "") {
    throw new Error("inbox_setup_grant_missing: cannot persist an empty setup grant");
  }
  const resolvedPath = inboxSetupGrantFilePath({ inbox, repoRoot });
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  // The setup grant is a bearer secret — write owner-only (0600) so it can't leak to other
  // local users via the default 0644 in a 0755 .agentic-factory dir. writeFileSync mode only
  // applies on create, so chmod (best-effort; no-op on Windows) covers rotate-over-existing.
  fs.writeFileSync(
    resolvedPath,
    `AGENTIC_FACTORY_INBOX_SETUP_GRANT=${setupGrant.trim()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try { fs.chmodSync(resolvedPath, 0o600); } catch { /* best effort */ }
  return { path: resolvedPath };
}

function setupGrantForRequest(input = {}, resolvedSetupGrant = null) {
  return input?.setupGrant || input?.setupGrantToken || input?.setup_grant ||
    (typeof resolvedSetupGrant === "function" ? resolvedSetupGrant() : resolvedSetupGrant);
}

function stripSetupGrant(input = {}) {
  const { setupGrant, setupGrantToken, setup_grant, ...body } = input || {};
  return body;
}

async function requestJson(fetchImpl, url, { method, body, setupGrant = null }) {
  const headers = { "content-type": "application/json" };
  if (setupGrant) headers["x-agentic-factory-setup-grant"] = setupGrant;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && payload && payload.ok === false) {
      return { ok: false, reason: payload.reason || payload.error || `http_${response.status}` };
    }
    throw new Error(`Hosted inbox request failed with HTTP ${response.status}: ${payload.error || "unknown error"}`);
  }
  return payload;
}
