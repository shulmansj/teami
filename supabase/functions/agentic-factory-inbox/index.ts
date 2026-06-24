import jwt from "npm:jsonwebtoken@9.0.2";
import { createClient } from "npm:@supabase/supabase-js@2.107.0";

const FUNCTION_SLUG = "agentic-factory-inbox";
const ADMIN_HEADER = "x-agentic-factory-inbox-admin-token";
const SETUP_GRANT_HEADER = "x-agentic-factory-setup-grant";
const BREAK_GLASS_REASON_HEADER = "x-agentic-factory-break-glass-reason";
const DEFAULT_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WEBHOOK_BODY_BYTES = 1048576;
const SETUP_GRANT_MUTATION_TTL_MS = 15 * 60 * 1000;
const SETUP_GRANT_CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_GRANT_ISSUANCE_WINDOW_MS = 60 * 60 * 1000;
const SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE = 10;
// The per-workspace cap is the TARGETED control. The global cap is only a runaway-row
// backstop set far above any real fleet's burst: a low shared global cap is itself a
// lockout DoS (one attacker spamming fake workspaces could block ALL tenants for the
// window). Real cross-workspace abuse control is per-IP / gateway rate limiting, which is
// deploy-side (see the C4 follow-up note) — not a low global app-level counter.
const SETUP_GRANT_ISSUANCE_MAX_GLOBAL = 10000;
const GITHUB_INSTALL_STATE_TTL_MS = 15 * 60 * 1000;
const GITHUB_INSTALLATION_DISCOVERY_ATTEMPTS = 3;
const GITHUB_INSTALLATION_DISCOVERY_RETRY_MS = 500;
const BROKER_CREDENTIAL_TTL_SECONDS = 60 * 60;
const BROKER_CREDENTIAL_REMINT_WINDOW_MS = 60 * 60 * 1000;
const BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW = 30;
const BROKER_CREDENTIAL_PREFIX = "af_broker_v1";
const REQUIRED_CAPABILITIES = ["linear.project.planned", "decomposition.trigger_runner.v1"];
const TERMINAL_STATUS_VALUES = ["paused", "completed", "rejected", "dead_letter"];
const TERMINAL_STATUSES = new Set(TERMINAL_STATUS_VALUES);
const ACTIVE_STATUSES = ["queued", "leased", "running", "routing_error"];
const MAINTENANCE_DELETE_BATCH_SIZE = 500;
const RETENTION_MS = {
  terminalWakes: 90 * DAY_MS, // terminal wake rows by terminal_at, falling back to created_at.
  triggerEvents: 90 * DAY_MS, // trigger_events by received_at.
  webhookDeliveries: RAW_PAYLOAD_RETENTION_MS, // deliveries use each row's retention_expires_at.
  workflowRuns: 90 * DAY_MS, // terminal workflow_runs by terminal_at, falling back to started_at.
  deadLetters: 180 * DAY_MS, // dead_letters by created_at.
  inactiveSetupGrants: 30 * DAY_MS, // revoked/expired/superseded grants by revoked_at, falling back to created_at.
  inactiveRunnerCredentials: 30 * DAY_MS, // inactive runner credentials by revoked_at, falling back to created_at.
} as const;
// C4 follow-up: per-IP/gateway limits and bad-signature lockouts need deploy-side state
// (Supabase gateway or a future failure-tracking table) to stay deterministic across stores.
const ROUTING_ERROR_REASONS = new Set([
  "missing_workspace_id",
  "no_active_domain_for_workspace",
  "webhook_id_mismatch",
  "ambiguous_webhook_id",
  "team_id_mismatch",
  "ambiguous_team_id",
  "no_domain_project_team_intersection",
  "ambiguous_domain_project_team_intersection",
  "cross_domain_team_conflict",
  "insufficient_wake_identity",
  "unknown_workflow_type",
  "domain_not_found",
  "domain_not_active",
  "no_active_domains",
  "domain_required",
]);

const TABLES = {
  setupGrants: "agentic_factory_inbox_setup_grants",
  webhookSecrets: "agentic_factory_inbox_linear_webhook_secrets",
  deliveries: "agentic_factory_inbox_webhook_deliveries",
  events: "agentic_factory_inbox_trigger_events",
  wakeups: "agentic_factory_inbox_workflow_wakeups",
  runnerCredentials: "agentic_factory_inbox_runner_credentials",
  runnerHeartbeats: "agentic_factory_inbox_runner_heartbeats",
  workflowRuns: "agentic_factory_inbox_workflow_runs",
  deadLetters: "agentic_factory_inbox_dead_letters",
} as const;

type HttpLikeError = {
  status?: number;
  message?: string;
  details?: Record<string, unknown>;
};

type LinearSignatureVerification =
  | { ok: true; secretId: string; webhookId: string; secret: Record<string, any> }
  | { ok: false; reason: string };

type RunnerCredentialScope = {
  storedWebhookIds: string[];
  storedTeamId: string | null;
  storedDomainId: string | null;
};

type SetupGrant = Record<string, any>;

type BrokerCredentialPayload = {
  v: 1;
  workspaceId: string;
  teamId: string;
  installationId: string;
  owner: string;
  repo: string;
  exp: number;
};

type StructuredLogFieldValue = string | number | boolean | null | undefined;

const STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  hosted_inbox_auth_denied: new Set(["route", "reason", "status"]),
  setup_grant_issued: new Set(["workspaceId", "teamId", "domainId", "authMode", "setupGrantRowId"]),
  setup_grant_rate_limited: new Set(["workspaceId", "teamId", "authMode", "scope", "limit", "windowMs", "count"]),
  broker_credential_minted: new Set([
    "workspaceId",
    "teamId",
    "owner",
    "repo",
    "installationId",
    "authMode",
    "ttlSeconds",
    "remintCount",
    "remintWindowStartedAt",
  ]),
  broker_credential_remint_rate_limited: new Set([
    "workspaceId",
    "teamId",
    "owner",
    "repo",
    "installationId",
    "authMode",
    "limit",
    "windowMs",
    "windowStartedAt",
    "count",
  ]),
  maintenance_sweep_completed: new Set([
    "at",
    "authMode",
    "breakGlassReason",
    "expiredGrants",
    "expiredLeases",
    "prunedWorkflowWakeups",
    "prunedTriggerEvents",
    "prunedWebhookDeliveries",
    "prunedWorkflowRuns",
    "prunedDeadLetters",
    "prunedSetupGrants",
    "prunedRunnerCredentials",
  ]),
};

const STRUCTURED_SECURITY_LOG_SENSITIVE_VALUE_PATTERNS = [
  /\bgh[opsru]_[A-Za-z0-9_]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\baf_(?:setup|broker|runner)_v\d_[A-Za-z0-9_-]+/i,
  /\bri_[A-Za-z0-9]{32,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const db = createClient(Deno.env.get("SUPABASE_URL")!, supabaseSecretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req: Request) => {
  let route = "/";
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    route = routeFor(req);
    if (route === "/status" && req.method === "GET") return json({ ok: true, service: FUNCTION_SLUG });
    if (route === "/v1/webhooks/linear" && req.method === "POST") {
      return json(await handleLinearWebhook(req));
    }
    if (route === "/v1/github/install-callback" && req.method === "GET") {
      return handleGitHubInstallCallback(req);
    }

    const body = await readJson(req);
    switch (`${req.method} ${route}`) {
      case "POST /v1/setup-grants":
        return json(await issueSetupGrantRoute(req, body));
      case "POST /v1/setup-grants/status": {
        const grant = await requireSetupGrant(req, body, { allowExpired: true });
        return json(setupGrantStatus(grant));
      }
      case "POST /v1/setup-grants/revoke":
        return json(await revokeSetupGrantRoute(req, body));
      case "POST /v1/setup-grants/recover":
        return json(await recoverSetupGrant(req, body));
      case "POST /v1/github/install-intent":
        return json(await issueGitHubInstallIntent(body, await requireSetupGrant(req, body, { consumeUse: true })));
      case "POST /v1/maintenance":
        return json(await runMaintenance({ breakGlassReason: requireBreakGlassAuth(req) }));
      case "PUT /v1/linear/webhook-secret":
        return json(await putLinearWebhookSecret(body, await requireSetupGrant(req, body, { consumeUse: true })));
      case "POST /v1/linear/webhook-secret/verify": {
        const grant = await requireSetupGrant(req, body);
        return json(linearSignatureVerificationResponse(await verifyLinearWebhookSecret(body, grant)));
      }
      case "DELETE /v1/linear/webhook-secret":
        return json(await deleteLinearWebhookSecret(body, await requireSetupGrant(req, body, { consumeUse: true })));
      case "POST /v1/broker-credentials":
        return json(await issueBrokerCredential(body, await requireSetupGrant(req, body, { steadyState: true })));
      case "POST /v1/runner-credentials":
        return json(await mintRunnerCredential(req, body, await requireSetupGrant(req, body, { consumeUse: true })));
      case "POST /v1/runner-credentials/verify":
        return json(runnerCredentialVerificationResponse(await verifyRunnerCredential(body)));
      case "POST /v1/runner-credentials/revoke":
        await requireRunnerCredential(body);
        return json(await revokeRunnerCredential(body));
      case "POST /v1/runner-heartbeats": {
        const credential = await requireRunnerCredential(body);
        return json(await heartbeatRunner(body, { storedCapabilities: credential.capabilities }));
      }
      case "POST /v1/wakeups/claim": {
        const credential = await requireRunnerCredential(body);
        return json(await claimWake(body, {
          storedCapabilities: credential.capabilities,
          credentialScope: runnerCredentialScope(credential),
        }));
      }
      case "POST /v1/wakeups/renew-lease": {
        const credential = await requireRunnerCredential(body);
        return json(await renewWakeLease(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/mark-running": {
        const credential = await requireRunnerCredential(body);
        return json(await markWakeRunning(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/release": {
        const credential = await requireRunnerCredential(body);
        return json(await releaseWake(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/routing-error": {
        const credential = await requireRunnerCredential(body);
        return json(await markWakeRoutingError(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/requeue": {
        const credential = await requireRunnerCredential(body);
        return json(await requeueWake(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/mark-mutation-started": {
        const credential = await requireRunnerCredential(body);
        return json(await markWakeMutationStarted(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/complete": {
        const credential = await requireRunnerCredential(body);
        return json(await completeWake(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/dead-letter": {
        const credential = await requireRunnerCredential(body);
        return json(await deadLetterWake(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/get": {
        const credential = await requireRunnerCredential(body);
        return json(await getWake(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      case "POST /v1/wakeups/views": {
        const credential = await requireRunnerCredential(body);
        return json(await listWakeViews(body, { credentialScope: runnerCredentialScope(credential) }));
      }
      default:
        throw httpError(404, `Unknown inbox route: ${route}`);
    }
  } catch (error) {
    const caught = error as HttpLikeError | null | undefined;
    const status = typeof caught?.status === "number" ? caught.status : 500;
    if (status === 401 || status === 403) {
      emitHostedSecurityLog("hosted_inbox_auth_denied", {
        route,
        status,
        reason: caught?.message || "unknown error",
      });
    }
    return json({ ok: false, ...(caught?.details || {}), error: caught?.message || "unknown error" }, status);
  }
});

async function handleLinearWebhook(req: Request) {
  assertContentLengthWithinCap(req.headers);
  const { signature, deliveryId } = requireLinearWebhookHeaders(req.headers);
  const rawBody = await readCappedBody(req);
  const payload = JSON.parse(rawBody);
  const workspaceId = payload?.organizationId;
  if (!workspaceId) throw httpError(400, "Linear webhook organizationId is required.");
  await pruneExpiredDeliveries();
  const verification = await verifyStoredLinearSignature({ workspaceId, rawBody, signature });
  if (!verification.ok) {
    throw httpError(401, verification.reason);
  }
  const trustedTeamId = trustedTeamIdFromVerification(verification);
  if (trustedTeamId && !projectTeamIdsFromPayload(payload).includes(trustedTeamId)) {
    throw httpError(401, "delivery_team_not_in_webhook_scope");
  }
  const receivedAt = new Date().toISOString();
  await confirmSetupGrantForDelivery({ verification, payload, deliveryId, receivedAt });

  // Data minimization: the hosted inbox stores no product content. The raw
  // webhook body is consumed in memory for signature verification and event
  // normalization, then only its hash and an allowlisted header subset are
  // persisted. The runner re-reads Linear through the adopter's own OAuth.
  const delivery = {
    id: id("delivery"),
    provider: "linear",
    workspace_id: workspaceId,
    delivery_id: deliveryId,
    webhook_id: verification.webhookId,
    webhook_secret_id: verification.secretId,
    signature_valid: true,
    raw_headers: allowlistedHeaders(req.headers),
    raw_body: null,
    raw_body_sha256: await sha256Hex(rawBody),
    received_at: receivedAt,
    dedupe_key: `linear:${workspaceId}:${deliveryId}`,
    retention_expires_at: plusMs(receivedAt, RAW_PAYLOAD_RETENTION_MS),
  };
  const deliveryInsert = await db.from(TABLES.deliveries).insert(delivery).select().maybeSingle();
  if (deliveryInsert.error?.code === "23505") {
    const existing = await selectOne(
      db.from(TABLES.deliveries)
        .select("*")
        .eq("provider", "linear")
        .eq("workspace_id", workspaceId)
        .eq("delivery_id", deliveryId)
        .limit(1),
      "existing delivery",
    );
    return { accepted: true, duplicate: true, delivery: existing, wakeups: [] };
  }
  if (deliveryInsert.error) throw new Error(deliveryInsert.error.message);

  const event = normalizeLinearEvent({
    payload,
    workspaceId,
    deliveryId,
    deliveryRecordId: delivery.id,
    receivedAt: delivery.received_at,
    webhookId: verification.webhookId,
    trustedTeamId,
  });
  const eventResult = await recordTriggerEvent(event);
  const wakeups = eventResult.duplicate ? [] : await routeTriggerEvent(eventResult.event, { trustedTeamId });
  return {
    accepted: true,
    duplicate: false,
    delivery: deliveryInsert.data,
    event: eventResult.event,
    wakeups,
  };
}

async function issueSetupGrant(
  input: Record<string, unknown>,
  {
    createdBy = "anonymous_init",
    bypassActiveConflict = false,
  }: { createdBy?: string; bypassActiveConflict?: boolean } = {},
) {
  requireString(input.workspaceId, "workspaceId");
  requireString(input.teamId, "teamId");
  const workspaceId = String(input.workspaceId);
  const teamId = String(input.teamId);
  const now = new Date().toISOString();

  // Issuance abuse bound: throttle how fast seats can be grabbed per workspace and globally.
  // This is the pre-launch mitigation for the accepted setup-ownership residual (the inbox cannot
  // prove provider origin, so a flood of anonymous issuances for team ids is rate-limited
  // and recoverable via break-glass).
  if (!bypassActiveConflict) {
    const windowStart = plusMs(now, -SETUP_GRANT_ISSUANCE_WINDOW_MS);
    const recent = await db.from(TABLES.setupGrants)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", windowStart);
    if (recent.error) throw new Error(recent.error.message);
    if ((recent.count ?? 0) >= SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE) {
      emitHostedSecurityLog("setup_grant_rate_limited", {
        workspaceId,
        teamId,
        authMode: auditSetupGrantAuthMode(createdBy, bypassActiveConflict),
        scope: "workspace",
        limit: SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE,
        windowMs: SETUP_GRANT_ISSUANCE_WINDOW_MS,
        count: recent.count ?? 0,
      });
      throw httpError(429, "setup_grant_rate_limited", {
        guidance: "Too many setup attempts for this workspace recently. Wait and retry, or use break-glass recovery after out-of-band proof.",
      });
    }
    const recentGlobal = await db.from(TABLES.setupGrants)
      .select("id", { count: "exact", head: true })
      .gte("created_at", windowStart);
    if (recentGlobal.error) throw new Error(recentGlobal.error.message);
    if ((recentGlobal.count ?? 0) >= SETUP_GRANT_ISSUANCE_MAX_GLOBAL) {
      emitHostedSecurityLog("setup_grant_rate_limited", {
        workspaceId,
        teamId,
        authMode: auditSetupGrantAuthMode(createdBy, bypassActiveConflict),
        scope: "global",
        limit: SETUP_GRANT_ISSUANCE_MAX_GLOBAL,
        windowMs: SETUP_GRANT_ISSUANCE_WINDOW_MS,
        count: recentGlobal.count ?? 0,
      });
      throw httpError(429, "setup_grant_rate_limited", {
        guidance: "Too many setup attempts across all workspaces recently. Wait and retry, or use break-glass recovery after out-of-band proof.",
      });
    }
  }
  if (!bypassActiveConflict) await expireConflictingProvisionalGrants({ workspaceId, teamId, now });
  const activeGrant = await selectActiveSetupGrant({ workspaceId, teamId });
  if (activeGrant && !bypassActiveConflict) {
    throw httpError(409, "setup_grant_conflict", {
      guidance: "An active setup grant already exists for this Linear team. Wait for it to expire, revoke it, or use break-glass recovery after out-of-band proof.",
      grantId: activeGrant.grant_id,
      status: activeGrant.status,
      expiresAt: activeGrant.expires_at,
      confirmationExpiresAt: activeGrant.confirmation_expires_at,
    });
  }

  const grantId = setupGrantPublicId();
  const secret = setupGrantSecret();
  const token = `af_setup_v1_${grantId}_${secret}`;
  const record = {
    id: id("setup_grant"),
    grant_id: grantId,
    secret_hash: await sha256Hex(secret),
    workspace_id: workspaceId,
    team_id: teamId,
    domain_id: optionalString(input.domainId ?? input.domain_id),
    webhook_id: null,
    status: "provisional",
    scopes: ["linear.webhook_secret.setup", "runner_credentials.mint"],
    uses_remaining: 8,
    expires_at: plusMs(now, SETUP_GRANT_MUTATION_TTL_MS),
    confirmation_expires_at: plusMs(now, SETUP_GRANT_CONFIRMATION_TTL_MS),
    created_at: now,
    created_by: createdBy,
  };
  const result = await db.from(TABLES.setupGrants).insert(record).select().single();
  if (result.error?.code === "23505") {
    throw httpError(409, "setup_grant_conflict", {
      guidance: "An active setup grant already exists for this Linear team. Re-run status/revoke or use break-glass recovery after out-of-band proof.",
    });
  }
  if (result.error) throw new Error(result.error.message);
  emitHostedSecurityLog("setup_grant_issued", {
    workspaceId,
    teamId,
    domainId: optionalString(input.domainId ?? input.domain_id),
    authMode: auditSetupGrantAuthMode(createdBy, bypassActiveConflict),
    setupGrantRowId: String(result.data.id),
  });
  return { ok: true, setupGrant: token, grant: setupGrantStatus(result.data) };
}

async function issueSetupGrantRoute(req: Request, input: Record<string, unknown>) {
  if (input.bypassActiveConflict === true) {
    return refreshSetupGrantRoute(req, input);
  }
  return issueSetupGrant(input);
}

async function refreshSetupGrantRoute(req: Request, input: Record<string, unknown>) {
  const setupGrant = req.headers.get(SETUP_GRANT_HEADER) || "";
  const grant = await requireSetupGrant(req, input);
  const now = new Date().toISOString();
  if (grant.status === "provisional" && Date.parse(String(grant.confirmation_expires_at)) <= Date.parse(now)) {
    await expireSetupGrant(grant, "setup grant confirmation window expired");
    throw httpError(401, "setup grant confirmation window expired");
  }
  const refreshed = await db.from(TABLES.setupGrants)
    .update({
      expires_at: plusMs(now, SETUP_GRANT_MUTATION_TTL_MS),
      last_used_at: now,
    })
    .eq("id", grant.id)
    .in("status", ["provisional", "confirmed"])
    .select()
    .maybeSingle();
  if (refreshed.error) throw new Error(refreshed.error.message);
  if (!refreshed.data) throw httpError(401, "setup grant is not active");
  return { ok: true, refreshed: true, setupGrant, grant: setupGrantStatus(refreshed.data) };
}

async function requireSetupGrant(
  req: Request,
  body: Record<string, unknown>,
  {
    consumeUse = false,
    allowExpired = false,
    steadyState = false,
  }: { consumeUse?: boolean; allowExpired?: boolean; steadyState?: boolean } = {},
) {
  // workspaceId/teamId are DERIVED from the authenticated grant below — callers may omit
  // them. The grant row (selected by the token's grant_id) is the authoritative scope;
  // downstream handlers already derive workspace/team/webhook/domain from it. Requiring the
  // caller to also restate these ids is a footgun for grant-authed setup routes; we still
  // validate workspaceId/teamId when supplied (fail closed on mismatch).
  const token = req.headers.get(SETUP_GRANT_HEADER) || "";
  const parsed = parseSetupGrantToken(token);
  if (!parsed) throw httpError(401, "invalid setup grant");
  const grant = await selectMaybeOne(
    db.from(TABLES.setupGrants)
      .select("*")
      .eq("grant_id", parsed.grantId)
      .limit(1),
    "setup grant",
  );
  if (!grant) throw httpError(401, "invalid setup grant");
  const actualHash = await sha256Hex(parsed.secret);
  if (!constantTimeEqual(actualHash, String(grant.secret_hash))) throw httpError(401, "invalid setup grant");
  // The broker-credential route (steadyState) gates on github_repo_verified_at (below) — the
  // install binding is the proof of GitHub repo-write authority. It must NOT also require
  // Linear-webhook confirmation: init mints the INITIAL broker credential before any Linear
  // delivery confirms the grant (deferred confirmation). So accept a github-verified
  // PROVISIONAL grant too — bounded, since provisional grants expire in 7 days.
  const allowedStatuses = steadyState
    ? ["provisional", "confirmed"]
    : allowExpired ? ["provisional", "confirmed", "expired"] : ["provisional", "confirmed"];
  if (!allowedStatuses.includes(String(grant.status))) throw httpError(401, "setup grant is not active");
  if (body.workspaceId != null && String(body.workspaceId) !== grant.workspace_id) {
    throw httpError(403, "setup_grant_scope_mismatch");
  }
  if (body.teamId != null && String(body.teamId) !== grant.team_id) {
    throw httpError(403, "setup_grant_scope_mismatch");
  }
  if (steadyState && !optionalString(grant.github_repo_verified_at)) {
    throw httpError(409, "github_repo_not_verified", {
      guidance: "Complete the GitHub App install in the browser with repo write permission, then retry GitHub setup.",
    });
  }
  // Bounded relaxation: a github-verified PROVISIONAL grant may mint the initial broker
  // credential, but ONLY within its confirmation window — enforced here at mint time rather
  // than relying on the maintenance sweep having flipped status to expired. Confirmed grants
  // have no confirmation window.
  if (
    steadyState
    && grant.status === "provisional"
    && Date.parse(String(grant.confirmation_expires_at)) <= Date.now()
  ) {
    throw httpError(401, "setup grant is not active");
  }
  if (steadyState) return grant;
  const now = new Date().toISOString();
  if (Date.parse(String(grant.expires_at)) <= Date.parse(now)) {
    // Mutation window lapsed. Expire only an abandoned UNBOUND setup; a BOUND provisional
    // grant stays confirmable until the 7-day window (deferred confirmation can take days),
    // so we never expire it here and only refuse further MUTATIONS (consumeUse calls). A
    // status poll past the mutation window must leave a bound grant still provisional.
    if (grant.status === "provisional" && !grant.webhook_id) {
      await expireSetupGrant(grant, "setup grant mutation window expired");
      grant.status = "expired";
      grant.revoked_at = now;
      grant.revoked_reason = "setup grant mutation window expired";
    }
    if (consumeUse) throw httpError(401, "setup grant mutation window expired");
    if (grant.status === "expired" && !allowExpired) throw httpError(401, "setup grant expired");
  }
  if (!consumeUse) return grant;
  if (Number(grant.uses_remaining) <= 0) throw httpError(401, "setup grant uses exhausted");
  const consumed = await db.from(TABLES.setupGrants)
    .update({ uses_remaining: Number(grant.uses_remaining) - 1, last_used_at: now })
    .eq("id", grant.id)
    .gt("uses_remaining", 0)
    .select()
    .maybeSingle();
  if (consumed.error) throw new Error(consumed.error.message);
  if (!consumed.data) throw httpError(401, "setup grant uses exhausted");
  return consumed.data;
}

function setupGrantStatus(grant: SetupGrant) {
  return {
    ok: true,
    grantId: grant.grant_id,
    status: grant.status,
    workspaceId: grant.workspace_id,
    teamId: grant.team_id,
    domainId: grant.domain_id,
    webhookId: grant.webhook_id,
    githubInstallationId: grant.github_installation_id,
    githubOwner: grant.github_owner,
    githubRepo: grant.github_repo,
    githubRepoVerifiedAt: grant.github_repo_verified_at,
    githubInstallationBoundAt: grant.github_installation_bound_at,
    githubInstallStateExpiresAt: grant.github_install_state_expires_at,
    githubInstallFlow: grant.github_install_flow,
    scopes: grant.scopes || [],
    usesRemaining: grant.uses_remaining,
    expiresAt: grant.expires_at,
    confirmationExpiresAt: grant.confirmation_expires_at,
    confirmedAt: grant.confirmed_at,
    confirmationDeliveryId: grant.confirmation_delivery_id,
    revokedAt: grant.revoked_at,
    revokedReason: grant.revoked_reason,
  };
}

async function revokeSetupGrantRoute(req: Request, body: Record<string, unknown>) {
  const token = req.headers.get(SETUP_GRANT_HEADER);
  if (token) {
    const grant = await requireSetupGrant(req, body, { consumeUse: true });
    return revokeSetupGrantAndCredentials(grant, "grant holder requested revoke");
  }
  const reason = requireBreakGlassAuth(req);
  const grant = await selectGrantForBreakGlass(body);
  return revokeSetupGrantAndCredentials(grant, reason);
}

async function recoverSetupGrant(req: Request, input: Record<string, unknown>) {
  const reason = requireBreakGlassAuth(req);
  requireString(input.workspaceId, "workspaceId");
  requireString(input.teamId, "teamId");
  const auditActor = optionalString(input.auditActor ?? input.operatorId ?? input.operator ?? input.createdBy);
  const auditNote = optionalString(input.auditNote ?? input.outOfBandProof ?? input.proof);
  if (!auditActor || !auditNote) throw httpError(400, "break_glass_audit_fields_required");
  const workspaceId = String(input.workspaceId);
  const teamId = String(input.teamId);
  const supersededAt = new Date().toISOString();
  const superseded = await db.from(TABLES.setupGrants)
    .update({
      status: "superseded",
      revoked_at: supersededAt,
      revoked_reason: `break_glass_recover:${reason}:${auditActor}:${auditNote}`,
    })
    .eq("workspace_id", workspaceId)
    .eq("team_id", teamId)
    .in("status", ["provisional", "confirmed"])
    .select("*");
  if (superseded.error) throw new Error(superseded.error.message);
  for (const grant of superseded.data || []) {
    await revokeCredentialsForGrant(grant, supersededAt);
    await deactivateWebhookSecretsForGrant(grant, supersededAt);
  }
  const issued = await issueSetupGrant(input, {
    createdBy: `break_glass:${auditActor}`,
    bypassActiveConflict: true,
  });
  return { ...issued, superseded: (superseded.data || []).map((grant: SetupGrant) => setupGrantStatus(grant)) };
}

async function confirmSetupGrantForDelivery({
  verification,
  payload,
  deliveryId,
  receivedAt,
}: {
  verification: Extract<LinearSignatureVerification, { ok: true }>;
  payload: Record<string, any>;
  deliveryId: string;
  receivedAt: string;
}) {
  const secret = verification.secret;
  if (secret.confirmation_state !== "provisional") return null;
  if (!secret.setup_grant_id) throw httpError(401, "setup grant confirmation missing");
  const grant = await selectMaybeOne(
    db.from(TABLES.setupGrants)
      .select("*")
      .eq("grant_id", secret.setup_grant_id)
      .eq("status", "provisional")
      .limit(1),
    "setup grant",
  );
  if (!grant) throw httpError(401, "setup grant confirmation unavailable");
  if (Date.parse(String(grant.confirmation_expires_at)) <= Date.parse(receivedAt)) {
    await expireSetupGrant(grant, "setup grant confirmation window expired");
    throw httpError(401, "setup grant confirmation expired");
  }
  const payloadTeamIds = projectTeamIdsFromPayload(payload);
  if (
    payload?.organizationId !== grant.workspace_id ||
    !payloadTeamIds.includes(grant.team_id) ||
    secret.webhook_id !== grant.webhook_id ||
    secret.team_id !== grant.team_id
  ) {
    throw httpError(401, "setup grant confirmation scope mismatch");
  }
  const confirmedGrant = await db.from(TABLES.setupGrants)
    .update({
      status: "confirmed",
      confirmed_at: receivedAt,
      confirmation_delivery_id: deliveryId,
      last_used_at: receivedAt,
    })
    .eq("id", grant.id)
    .eq("status", "provisional")
    .select()
    .maybeSingle();
  if (confirmedGrant.error) throw new Error(confirmedGrant.error.message);
  if (!confirmedGrant.data) throw httpError(409, "setup grant confirmation race");
  const confirmedSecret = await db.from(TABLES.webhookSecrets)
    .update({ confirmation_state: "confirmed", updated_at: receivedAt })
    .eq("id", secret.id);
  if (confirmedSecret.error) throw new Error(confirmedSecret.error.message);
  return confirmedGrant.data;
}

async function putLinearWebhookSecret(input: Record<string, unknown>, grant: SetupGrant) {
  requireString(input.webhookId, "webhookId");
  requireString(input.signingSecret, "signingSecret");
  if (grant.webhook_id && grant.webhook_id !== input.webhookId) {
    throw httpError(409, "setup_grant_webhook_mismatch");
  }
  const conflicting = await selectMaybeOne(
    db.from(TABLES.webhookSecrets)
      .select("id, setup_grant_id, team_id")
      .eq("workspace_id", grant.workspace_id)
      .eq("webhook_id", String(input.webhookId))
      .limit(1),
    "webhook secret",
  );
  if (conflicting && conflicting.setup_grant_id !== grant.grant_id) {
    // A grant may only (re)bind a webhook id that is unbound or already its own. The upsert
    // key is (workspace_id, webhook_id), so without this check one team's grant could
    // clobber another team's stored secret/team binding by reusing its webhook id.
    throw httpError(409, "webhook_id_bound_to_other_team");
  }
  const now = new Date().toISOString();
  const webhookId = String(input.webhookId);
  const record = {
    id: id("webhook_secret"),
    workspace_id: grant.workspace_id,
    webhook_id: webhookId,
    team_id: grant.team_id,
    setup_grant_id: grant.grant_id,
    confirmation_state: "provisional",
    webhook_url: input.webhookUrl ?? null,
    signing_secret: input.signingSecret,
    active: true,
    rotated_at: now,
    updated_at: now,
  };
  const result = await db.from(TABLES.webhookSecrets)
    .upsert(record, { onConflict: "workspace_id,webhook_id" })
    .select("id, workspace_id, webhook_id, team_id, setup_grant_id, confirmation_state, webhook_url, active, rotated_at, created_at, updated_at")
    .single();
  if (result.error) throw new Error(result.error.message);
  const grantUpdate = await db.from(TABLES.setupGrants)
    .update({ webhook_id: webhookId, last_used_at: now })
    .eq("id", grant.id)
    .select()
    .single();
  if (grantUpdate.error) throw new Error(grantUpdate.error.message);
  return { ok: true, secret: result.data };
}

async function verifyLinearWebhookSecret(input: Record<string, unknown>, grant: SetupGrant) {
  requireString(input.rawBody, "rawBody");
  requireString(input.signature, "signature");
  return verifyStoredLinearSignature({
    workspaceId: String(grant.workspace_id),
    rawBody: String(input.rawBody),
    signature: String(input.signature),
  });
}

async function deleteLinearWebhookSecret(input: Record<string, unknown>, grant: SetupGrant) {
  const webhookId = optionalString(input.webhookId) ?? optionalString(grant.webhook_id);
  if (!webhookId) throw httpError(409, "setup_grant_webhook_required");
  if (grant.webhook_id && webhookId !== grant.webhook_id) throw httpError(409, "setup_grant_webhook_mismatch");
  const result = await db.from(TABLES.webhookSecrets)
    .delete()
    .eq("workspace_id", grant.workspace_id)
    .eq("webhook_id", webhookId)
    .eq("setup_grant_id", grant.grant_id)
    .select("id");
  if (result.error) throw new Error(result.error.message);
  return { ok: true, deleted: result.data?.length || 0 };
}

async function issueGitHubInstallIntent(input: Record<string, unknown>, grant: SetupGrant) {
  requireString(input.appSlug, "appSlug");
  requireString(input.owner, "owner");
  requireString(input.repo, "repo");
  const appSlug = String(input.appSlug).trim();
  const owner = String(input.owner).trim();
  const repo = String(input.repo).trim();
  const state = randomStateNonce();
  const now = new Date().toISOString();
  const expiresAt = plusMs(now, GITHUB_INSTALL_STATE_TTL_MS);
  const installation = await fetchGitHubRepoInstallation({ owner, repo, retryNotInstalled: false });
  if (!installation.ok && installation.reason !== "github_app_not_installed") {
    throw httpError(installation.status, installation.reason);
  }
  const flow = installation.ok ? "authorize_existing_installation" : "install_app";
  const updated = await db.from(TABLES.setupGrants)
    .update({
      github_installation_id: null,
      github_owner: owner,
      github_repo: repo,
      github_repo_verified_at: null,
      github_install_state_hash: await sha256Hex(state),
      github_install_state_expires_at: expiresAt,
      github_installation_bound_at: null,
      github_install_flow: flow,
      last_used_at: now,
    })
    .eq("id", grant.id)
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return {
    ok: true,
    installUrl: installation.ok
      ? githubOAuthAuthorizeUrl({ state })
      : githubAppInstallUrl({ appSlug, state }),
    flow,
    state,
    expiresAt,
  };
}

async function handleGitHubInstallCallback(req: Request) {
  const url = new URL(req.url);
  const state = optionalString(url.searchParams.get("state"));
  const code = optionalString(url.searchParams.get("code"));
  if (!state) return html("invalid or expired install link", 400);
  const stateHash = await sha256Hex(state);
  const now = new Date().toISOString();
  const grant = await selectMaybeOne(
    db.from(TABLES.setupGrants)
      .select("*")
      .eq("github_install_state_hash", stateHash)
      .gt("github_install_state_expires_at", now)
      .in("status", ["provisional", "confirmed"])
      .limit(1),
    "setup grant",
  );
  if (!grant) return html("invalid or expired install link", 400);
  const owner = optionalString(grant.github_owner);
  const repo = optionalString(grant.github_repo);
  if (!owner || !repo) return html("github_repo_not_bound", 400);
  if (code) {
    const verification = await verifyGitHubOAuthRepoWritePermission({ code, owner, repo });
    if (!verification.ok) return html(verification.reason, verification.status);
  } else if (grant.github_install_flow !== "install_app") {
    return html("github_oauth_code_required", 400);
  }
  const installation = await fetchGitHubRepoInstallation({ owner, repo });
  if (!installation.ok) return html(installation.reason, installation.status);
  const installationId = githubInstallationId(installation.installation.id);
  if (!installationId) return html("github_app_installation_lookup_failed", 400);
  const bound = await db.from(TABLES.setupGrants)
    .update({
      github_installation_id: installationId,
      github_owner: owner,
      github_repo: repo,
      github_repo_verified_at: now,
      github_installation_bound_at: now,
      github_install_state_hash: null,
      github_install_state_expires_at: null,
      github_install_flow: null,
      last_used_at: now,
    })
    .eq("id", grant.id)
    .eq("github_install_state_hash", stateHash)
    .gt("github_install_state_expires_at", now)
    .in("status", ["provisional", "confirmed"])
    .select()
    .maybeSingle();
  if (bound.error) throw new Error(bound.error.message);
  if (!bound.data) return html("invalid or expired install link", 400);
  return html("GitHub App authorized — you can return to your terminal");
}

function githubAppInstallUrl({ appSlug, state }: { appSlug: string; state: string }) {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

function githubOAuthAuthorizeUrl({ state }: { state: string }) {
  const clientId = optionalString(Deno.env.get("AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_ID"));
  if (!clientId) throw httpError(503, "github_oauth_not_configured");
  const query = new URLSearchParams({ client_id: clientId, state });
  return `https://github.com/login/oauth/authorize?${query.toString()}`;
}

async function fetchGitHubRepoInstallation({
  owner,
  repo,
  retryNotInstalled = true,
}: {
  owner: string;
  repo: string;
  retryNotInstalled?: boolean;
}): Promise<
  | { ok: true; installation: Record<string, any> }
  | { ok: false; status: number; reason: string }
> {
  let last:
    | { ok: true; installation: Record<string, any> }
    | { ok: false; status: number; reason: string }
    | null = null;
  for (let attempt = 0; attempt < GITHUB_INSTALLATION_DISCOVERY_ATTEMPTS; attempt += 1) {
    last = await fetchGitHubRepoInstallationOnce({ owner, repo });
    if (
      last.ok ||
      !retryableGitHubInstallationLookup(last, { retryNotInstalled }) ||
      attempt === GITHUB_INSTALLATION_DISCOVERY_ATTEMPTS - 1
    ) {
      return last;
    }
    await delay(GITHUB_INSTALLATION_DISCOVERY_RETRY_MS * (attempt + 1));
  }
  return last || { ok: false, status: 400, reason: "github_app_installation_lookup_failed" };
}

async function fetchGitHubRepoInstallationOnce({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Promise<
  | { ok: true; installation: Record<string, any> }
  | { ok: false; status: number; reason: string }
> {
  let appJwt: string;
  try {
    appJwt = githubAppJwt();
  } catch (error) {
    const caught = error as HttpLikeError | null | undefined;
    return { ok: false, status: caught?.status || 503, reason: caught?.message || "github_app_identity_not_configured" };
  }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, status: 503, reason: "github_app_installation_lookup_failed" };
  }
  const payload = await parseJsonResponse(response);
  if (response.status === 404) return { ok: false, status: 404, reason: "github_app_not_installed" };
  if (!response.ok) return { ok: false, status: response.status, reason: "github_app_installation_lookup_failed" };
  return { ok: true, installation: payload };
}

function retryableGitHubInstallationLookup(
  result: { ok: false; status: number; reason: string },
  { retryNotInstalled = true } = {},
) {
  if (result.reason === "github_app_not_installed") return retryNotInstalled;
  if (result.reason !== "github_app_installation_lookup_failed") return false;
  return result.status === 408 || result.status === 429 || result.status >= 500;
}

function githubInstallationId(value: unknown) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function githubAppJwt() {
  const appId = optionalString(Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_ID") || Deno.env.get("GITHUB_APP_ID"));
  const privateKey = optionalString(Deno.env.get("AGENTIC_FACTORY_GITHUB_APP_PRIVATE_KEY") || Deno.env.get("GITHUB_APP_PRIVATE_KEY"));
  if (!appId) throw httpError(503, "github_app_id_not_configured");
  if (!privateKey) throw httpError(503, "github_app_private_key_not_configured");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId },
    privateKey.replace(/\\n/g, "\n"),
    { algorithm: "RS256" },
  );
}

async function verifyGitHubOAuthRepoWritePermission({
  code,
  owner,
  repo,
}: {
  code: string;
  owner: string;
  repo: string;
}): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const exchanged = await exchangeGitHubOAuthCodeForUserToken(code);
  if (!exchanged.ok) return exchanged;
  const repoAccess = await fetchGitHubRepoPermissions({ owner, repo, accessToken: exchanged.accessToken });
  if (!repoAccess.ok) return repoAccess;
  const hasWrite = repoAccess.permissions.push === true || repoAccess.permissions.admin === true;
  if (!hasWrite) {
    return { ok: false, status: 401, reason: "repo_write_permission_required" };
  }
  return { ok: true };
}

async function exchangeGitHubOAuthCodeForUserToken(
  code: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; status: number; reason: string }> {
  const clientId = optionalString(Deno.env.get("AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_ID"));
  const clientSecret = optionalString(Deno.env.get("AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_SECRET"));
  if (!clientId || !clientSecret) return { ok: false, status: 503, reason: "github_oauth_not_configured" };
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    return { ok: false, status: 400, reason: "github_oauth_exchange_failed" };
  }
  const payload = await parseJsonResponse(response);
  const accessToken = optionalString((payload as Record<string, unknown>).access_token);
  if (!response.ok || !accessToken) return { ok: false, status: 400, reason: "github_oauth_exchange_failed" };
  return { ok: true, accessToken };
}

async function fetchGitHubRepoPermissions({
  owner,
  repo,
  accessToken,
}: {
  owner: string;
  repo: string;
  accessToken: string;
}): Promise<{ ok: true; permissions: Record<string, unknown> } | { ok: false; status: number; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, status: 400, reason: "github_repo_permissions_lookup_failed" };
  }
  const payload = await parseJsonResponse(response);
  if (response.status === 403 || response.status === 404) {
    return { ok: false, status: 401, reason: "repo_write_permission_required" };
  }
  if (!response.ok) return { ok: false, status: 400, reason: "github_repo_permissions_lookup_failed" };
  const permissions = (payload as Record<string, unknown>).permissions;
  return {
    ok: true,
    permissions: typeof permissions === "object" && permissions !== null
      ? permissions as Record<string, unknown>
      : {},
  };
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function issueBrokerCredential(input: Record<string, unknown>, grant: SetupGrant) {
  const key = Deno.env.get("AGENTIC_FACTORY_BROKER_CREDENTIAL_SIGNING_KEY");
  if (!key) throw httpError(503, "broker_credential_signing_key_not_configured");
  const now = new Date().toISOString();
  const owner = optionalString(grant.github_owner);
  const repo = optionalString(grant.github_repo);
  const repoVerifiedAt = optionalString(grant.github_repo_verified_at);
  if (!owner || !repo || !repoVerifiedAt) {
    throw httpError(409, "github_repo_not_verified", {
      guidance: "Complete the GitHub App install in the browser with repo write permission, then retry GitHub setup.",
    });
  }
  const installationId = optionalString(grant.github_installation_id);
  if (!installationId) {
    throw httpError(409, "github_installation_not_bound", {
      guidance: "Complete the GitHub App install in the browser, then retry GitHub setup.",
    });
  }
  const remintRecord = await recordBrokerCredentialRemint(grant, now);
  const exp = Math.floor(Date.parse(now) / 1000) + BROKER_CREDENTIAL_TTL_SECONDS;
  const payload: BrokerCredentialPayload = {
    v: 1,
    workspaceId: String(grant.workspace_id),
    teamId: String(grant.team_id),
    installationId,
    owner,
    repo,
    exp,
  };
  const brokerCredential = await signBrokerCredential({ key, payload });
  emitHostedSecurityLog("broker_credential_minted", {
    workspaceId: String(grant.workspace_id),
    teamId: String(grant.team_id),
    owner,
    repo,
    installationId,
    authMode: "setup_grant",
    ttlSeconds: BROKER_CREDENTIAL_TTL_SECONDS,
    remintCount: Number(remintRecord.github_broker_remint_count) || null,
    remintWindowStartedAt: optionalString(remintRecord.github_broker_remint_window_started_at),
  });
  return {
    ok: true,
    brokerCredential,
    owner,
    repo,
    installationId,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

async function recordBrokerCredentialRemint(grant: SetupGrant, issuedAt: string) {
  const remint = nextBrokerCredentialRemintWindow(grant, issuedAt);
  if (!remint.ok) {
    emitHostedSecurityLog("broker_credential_remint_rate_limited", {
      workspaceId: String(grant.workspace_id),
      teamId: String(grant.team_id),
      owner: optionalString(grant.github_owner),
      repo: optionalString(grant.github_repo),
      installationId: optionalString(grant.github_installation_id),
      authMode: "setup_grant",
      limit: BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW,
      windowMs: BROKER_CREDENTIAL_REMINT_WINDOW_MS,
      windowStartedAt: optionalString(grant.github_broker_remint_window_started_at),
      count: Number(grant.github_broker_remint_count) || 0,
    });
    throw httpError(429, "broker_credential_remint_rate_limited", {
      guidance: "Too many GitHub broker credentials were issued from this setup grant recently. Wait for the window to reset or revoke and recover the grant if this was unexpected.",
    });
  }
  const updated = await db.from(TABLES.setupGrants)
    .update({
      last_used_at: issuedAt,
      github_broker_remint_count: remint.count,
      github_broker_remint_window_started_at: remint.windowStartedAt,
    })
    .eq("id", grant.id)
    // Accept github-verified provisional grants (init mints before Linear confirmation);
    // still fails closed on revoked/expired status.
    .in("status", ["provisional", "confirmed"])
    .select()
    .maybeSingle();
  if (updated.error) throw new Error(updated.error.message);
  if (!updated.data) throw httpError(401, "setup grant is not active");
  return updated.data;
}

function nextBrokerCredentialRemintWindow(grant: SetupGrant, issuedAt: string) {
  const currentWindowStartedAt = optionalString(grant.github_broker_remint_window_started_at);
  const currentCountValue = Number(grant.github_broker_remint_count);
  const currentCount = Number.isFinite(currentCountValue) && currentCountValue > 0 ? currentCountValue : 0;
  const issuedAtMs = Date.parse(issuedAt);
  const windowStartedAtMs = currentWindowStartedAt ? Date.parse(currentWindowStartedAt) : NaN;
  const resetWindow = !currentWindowStartedAt ||
    !Number.isFinite(windowStartedAtMs) ||
    issuedAtMs - windowStartedAtMs >= BROKER_CREDENTIAL_REMINT_WINDOW_MS;
  if (!resetWindow && currentCount >= BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW) {
    return { ok: false as const };
  }
  return {
    ok: true as const,
    count: resetWindow ? 1 : currentCount + 1,
    windowStartedAt: resetWindow ? issuedAt : currentWindowStartedAt,
  };
}

async function mintRunnerCredential(req: Request, input: Record<string, unknown>, grant: SetupGrant) {
  const webhookId = optionalString(grant.webhook_id);
  if (!webhookId) throw httpError(409, "setup_grant_webhook_required");
  assertMintRequestDoesNotWidenGrant(input, grant);
  const credentialId = id("runner_credential");
  const token = `ri_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const capabilities = arrayOfStrings(input.capabilities).length
    ? arrayOfStrings(input.capabilities)
    : REQUIRED_CAPABILITIES;
  const teamId = String(grant.team_id);
  const webhookIds = [webhookId];
  const domainId = optionalString(grant.domain_id);
  const createdAt = new Date().toISOString();
  const result = await db.from(TABLES.runnerCredentials).insert({
    id: id("runner_credential_row"),
    workspace_id: grant.workspace_id,
    credential_id: credentialId,
    token_hash: await sha256Hex(token),
    runner_name: typeof input.runnerName === "string" ? input.runnerName : "local-runner",
    capabilities,
    team_id: teamId,
    webhook_ids: webhookIds,
    domain_id: domainId,
    active: true,
    created_at: createdAt,
  });
  if (result.error) throw new Error(result.error.message);
  return {
    credentialId,
    token,
    endpoint: `${originBaseUrl(req)}/v1/runner`,
    capabilities,
    team_id: teamId,
    webhook_ids: webhookIds,
    domain_id: domainId,
    createdAt,
  };
}

async function verifyRunnerCredential(input: Record<string, unknown>) {
  requireString(input.credentialId, "credentialId");
  requireString(input.token, "token");
  let query = db.from(TABLES.runnerCredentials)
    .select("*")
    .eq("credential_id", input.credentialId)
    .eq("active", true)
    .limit(1);
  if (input.workspaceId) query = query.eq("workspace_id", input.workspaceId);
  const credential = await selectMaybeOne(query, "runner credential");
  if (!credential) return null;
  const actual = await sha256Hex(String(input.token));
  return constantTimeEqual(actual, credential.token_hash) ? credential : null;
}

async function requireRunnerCredential(input: Record<string, unknown>) {
  const credential = await verifyRunnerCredential(input);
  if (!credential) throw httpError(401, "invalid runner inbox credential");
  if (!input.workspaceId) input.workspaceId = credential.workspace_id;
  return credential;
}

function runnerCredentialVerificationResponse(credential: Record<string, any> | null) {
  if (!credential) return { ok: false };
  const scope = runnerCredentialScope(credential);
  return {
    ok: true,
    workspaceId: credential.workspace_id,
    capabilities: Array.isArray(credential.capabilities) ? credential.capabilities : [],
    team_id: scope.storedTeamId,
    webhook_ids: scope.storedWebhookIds,
    domain_id: scope.storedDomainId,
  };
}

function runnerCredentialScope(credential: Record<string, any>): RunnerCredentialScope {
  return {
    storedWebhookIds: sortedStrings(credential.webhook_ids),
    storedTeamId: optionalString(credential.team_id),
    storedDomainId: optionalString(credential.domain_id),
  };
}

async function revokeRunnerCredential(input: Record<string, unknown>) {
  const result = await db.from(TABLES.runnerCredentials)
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq("workspace_id", input.workspaceId)
    .eq("credential_id", input.credentialId);
  if (result.error) throw new Error(result.error.message);
  return { ok: true };
}

async function heartbeatRunner(
  input: Record<string, unknown>,
  { storedCapabilities = null }: { storedCapabilities?: unknown } = {},
) {
  requireString(input.runnerId, "runnerId");
  requireString(input.workspaceId, "workspaceId");
  const heartbeat = {
    workspace_id: input.workspaceId,
    runner_id: input.runnerId,
    version: input.version ?? null,
    // Store the capabilities the runner can actually back with its credential, not
    // self-attested strings, so derivedWakeStatus cannot show a wake as ready for a
    // runner that could never claim it.
    capabilities: effectiveClaimCapabilities({ storedCapabilities, presentedCapabilities: input.capabilities }),
    last_seen_at: new Date().toISOString(),
    current_wake_id: input.currentWakeId ?? null,
  };
  const result = await db.from(TABLES.runnerHeartbeats)
    .upsert(heartbeat, { onConflict: "workspace_id,runner_id" })
    .select()
    .single();
  if (result.error) throw new Error(result.error.message);
  return camelWakeLike(result.data);
}

async function claimWake(
  input: Record<string, unknown>,
  {
    storedCapabilities = null,
    credentialScope = null,
  }: { storedCapabilities?: unknown; credentialScope?: RunnerCredentialScope | null } = {},
) {
  requireString(input.workspaceId, "workspaceId");
  requireString(input.runnerId, "runnerId");
  await expireLeases(String(input.workspaceId));
  await heartbeatRunner(input, { storedCapabilities });
  const capabilities = effectiveClaimCapabilities({ storedCapabilities, presentedCapabilities: input.capabilities });
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  const webhookIds = effectiveWebhookIdsForCredentialScope(scope, input.webhookIds);
  if (storedWebhookScopeActive(scope) && webhookIds.length === 0) return { ok: false, reason: "no_queued_wake" };
  const leaseDurationMs = numberOrDefault(input.leaseDurationMs, DEFAULT_LEASE_DURATION_MS);
  const candidate = input.wakeId
    ? await selectMaybeOne(
        db.from(TABLES.wakeups)
          .select("*")
          .eq("id", input.wakeId)
          .eq("workspace_id", input.workspaceId)
          .limit(1),
        "specific wake",
      )
    : await selectMaybeOne(
        withCredentialScopeFilter(
          db.from(TABLES.wakeups)
            .select("*")
            .eq("workspace_id", input.workspaceId)
            .eq("status", "queued")
            .order("created_at", { ascending: true }),
          scope,
          webhookIds,
        ).limit(1),
        "queued wake",
      );
  if (!candidate) return { ok: false, reason: "no_queued_wake" };
  if (!wakeMatchesCredentialScope(candidate, scope, webhookIds)) return { ok: false, reason: "no_queued_wake" };
  if (candidate.status !== "queued") {
    return { ok: false, reason: `wake_not_queued:${candidate.status}`, wake: redactedWake(candidate) };
  }
  const missing = missingCapabilities(candidate.workflow_type, capabilities);
  if (missing.length > 0) {
    await db.from(TABLES.wakeups)
      .update({ last_claim_rejection_reason: `missing_capabilities:${missing.join(",")}` })
      .eq("id", candidate.id);
    return {
      ok: false,
      reason: "capability_mismatch",
      wake: redactedWake({ ...candidate, last_claim_rejection_reason: `missing_capabilities:${missing.join(",")}` }),
      missingCapabilities: missing,
    };
  }
  const now = new Date().toISOString();
  const leaseToken = id("lease");
  const update = await db.from(TABLES.wakeups)
    .update({
      status: "leased",
      claimed_at: now,
      runner_id: input.runnerId,
      lease_token: leaseToken,
      lease_expires_at: plusMs(now, leaseDurationMs),
      attempt_count: candidate.attempt_count + 1,
      last_claim_rejection_reason: null,
    })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select()
    .maybeSingle();
  if (update.error) throw new Error(update.error.message);
  if (!update.data) return { ok: false, reason: "wake_not_queued:race" };
  await heartbeatRunner({ ...input, currentWakeId: update.data.id }, { storedCapabilities });
  const event = update.data.source_event_id
    ? await selectMaybeOne(db.from(TABLES.events).select("*").eq("id", update.data.source_event_id).limit(1), "source event")
    : null;
  return { ok: true, wake: camelWake(update.data), leaseToken, event: event ? camelEvent(event) : null };
}

async function renewWakeLease(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  const now = new Date().toISOString();
  const result = await db.from(TABLES.wakeups)
    .update({ lease_expires_at: plusMs(now, numberOrDefault(input.leaseDurationMs, DEFAULT_LEASE_DURATION_MS)) })
    .eq("id", wake.id)
    .select()
    .single();
  if (result.error) throw new Error(result.error.message);
  return { ok: true, wake: camelWake(result.data) };
}

async function markWakeRunning(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake: camelWake(wake) };
  requireString(input.runId, "runId");
  const now = new Date().toISOString();
  if (!isNonEmptyString(input.domainId)) throw httpError(400, "missing_domain_id");
  const domainId = String(input.domainId);
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  if (scope.storedDomainId && scope.storedDomainId !== domainId) {
    // A credential scoped to one domain may not label a wake with another domain. (Team and
    // webhook isolation is enforced in assertLease; this closes the domain dimension.)
    throw httpError(403, "domain_outside_credential_scope");
  }
  const updated = await db.from(TABLES.wakeups)
    .update({ status: "running", started_at: now, run_id: input.runId, domain_id: domainId })
    .eq("id", wake.id)
    .eq("status", "leased")
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  const run = await db.from(TABLES.workflowRuns).insert({
    run_id: input.runId,
    workspace_id: wake.workspace_id,
    workflow_type: wake.workflow_type,
    wake_id: wake.id,
    object_id: wake.object_id,
    status: "running",
    started_at: now,
    terminal_reason: null,
    artifact_pointer: input.artifactPointer ?? null,
    provider_update_ids: [],
  });
  if (run.error?.code !== "23505" && run.error) throw new Error(run.error.message);
  return { ok: true, wake: camelWake(updated.data) };
}

async function releaseWake(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  if (wake.status !== "leased") throw httpError(409, `wake_not_leased:${wake.status}`);
  if (input.reason !== "domain_not_served") throw httpError(400, `invalid_release_reason:${input.reason}`);
  const updated = await db.from(TABLES.wakeups)
    .update({
      status: "queued",
      claimed_at: null,
      runner_id: null,
      lease_token: null,
      lease_expires_at: null,
      started_at: null,
      run_id: null,
    })
    .eq("id", wake.id)
    .eq("status", "leased")
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return {
    ok: true,
    wakeId: updated.data.id,
    status: "queued",
    attemptCount: updated.data.attempt_count,
  };
}

async function markWakeRoutingError(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  if (wake.status !== "leased") throw httpError(409, `wake_not_leased:${wake.status}`);
  requireString(input.reason, "reason");
  if (!ROUTING_ERROR_REASONS.has(String(input.reason))) {
    throw httpError(400, `invalid_routing_error_reason:${input.reason}`);
  }
  const normalizedCandidates = normalizeRoutingCandidates(input.candidates);
  if (!normalizedCandidates.ok) throw httpError(400, "invalid_candidates");
  const updated = await db.from(TABLES.wakeups)
    .update({
      status: "routing_error",
      routing_error_reason: input.reason,
      routing_candidates: normalizedCandidates.candidates,
      claimed_at: null,
      runner_id: null,
      lease_token: null,
      lease_expires_at: null,
    })
    .eq("id", wake.id)
    .eq("status", "leased")
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return { ok: true, wakeId: updated.data.id, status: "routing_error" };
}

async function requeueWake(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  requireString(input.workspaceId, "workspaceId");
  requireString(input.wakeId, "wakeId");
  const wake = await getRawWake(String(input.wakeId), String(input.workspaceId));
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  const webhookIds = effectiveWebhookIdsForCredentialScope(scope, input.webhookIds);
  if (!wake || !wakeMatchesCredentialScope(wake, scope, webhookIds)) throw httpError(404, "wake_not_found");
  if (wake.status !== "routing_error") throw httpError(409, `wake_not_routing_error:${wake.status}`);
  const updated = await db.from(TABLES.wakeups)
    .update({
      status: "queued",
      routing_error_reason: null,
      routing_candidates: null,
      domain_id: null,
    })
    .eq("id", wake.id)
    .eq("status", "routing_error")
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return { ok: true, wakeId: updated.data.id, status: "queued" };
}

async function markWakeMutationStarted(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  const result = await db.from(TABLES.wakeups)
    .update({ mutation_started_at: new Date().toISOString() })
    .eq("id", wake.id)
    .select()
    .single();
  if (result.error) throw new Error(result.error.message);
  return { ok: true, wake: camelWake(result.data) };
}

async function completeWake(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  requireString(input.status, "status");
  if (!TERMINAL_STATUSES.has(String(input.status))) throw httpError(400, `Invalid terminal wake status: ${input.status}`);
  const now = new Date().toISOString();
  const updated = await db.from(TABLES.wakeups)
    .update({
      status: input.status,
      reason: input.reason ?? null,
      terminal_at: now,
      lease_expires_at: null,
      lease_token: null,
    })
    .eq("id", wake.id)
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  let run = null;
  if (wake.run_id) {
    const runResult = await db.from(TABLES.workflowRuns)
      .update({
        status: input.status,
        terminal_at: now,
        terminal_reason: input.reason ?? null,
        provider_update_ids: arrayOfStrings(input.providerUpdateIds),
      })
      .eq("wake_id", wake.id)
      .eq("run_id", wake.run_id)
      .select()
      .maybeSingle();
    if (runResult.error) throw new Error(runResult.error.message);
    run = runResult.data;
  }
  return { ok: true, wake: camelWake(updated.data), run: run ? camelRun(run) : null };
}

async function deadLetterWake(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  const wake = await assertLease(input, { credentialScope });
  if (wake.status === "routing_error") throw httpError(409, "wake_not_dead_letterable:routing_error");
  const now = new Date().toISOString();
  const reason = typeof input.reason === "string" && input.reason ? input.reason : "dead_letter";
  const updated = await db.from(TABLES.wakeups)
    .update({ status: "dead_letter", reason, terminal_at: now, lease_expires_at: null, lease_token: null })
    .eq("id", wake.id)
    .select()
    .single();
  if (updated.error) throw new Error(updated.error.message);
  const dead = await db.from(TABLES.deadLetters).insert({ id: id("dead_letter"), wake_id: wake.id, reason, created_at: now });
  if (dead.error) throw new Error(dead.error.message);
  if (wake.run_id) {
    await db.from(TABLES.workflowRuns)
      .update({ status: "dead_letter", terminal_at: now, terminal_reason: reason })
      .eq("wake_id", wake.id)
      .eq("run_id", wake.run_id);
  }
  return { ok: true, wake: camelWake(updated.data) };
}

async function getWake(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  requireString(input.wakeId, "wakeId");
  const wake = await getRawWake(String(input.wakeId), String(input.workspaceId));
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  const webhookIds = effectiveWebhookIdsForCredentialScope(scope, input.webhookIds);
  return wake && wakeMatchesCredentialScope(wake, scope, webhookIds) ? redactedWake(wake) : null;
}

async function listWakeViews(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  requireString(input.workspaceId, "workspaceId");
  await expireLeases(String(input.workspaceId));
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  const webhookIds = effectiveWebhookIdsForCredentialScope(scope, input.webhookIds);
  if (storedWebhookScopeActive(scope) && webhookIds.length === 0) return [];
  const result = await withCredentialScopeFilter(
    db.from(TABLES.wakeups)
      .select("*")
      .eq("workspace_id", input.workspaceId)
      .order("created_at", { ascending: false }),
    scope,
    webhookIds,
  ).limit(100);
  if (result.error) throw new Error(result.error.message);
  const heartbeats = await freshHeartbeats(String(input.workspaceId), numberOrDefault(input.heartbeatStaleMs, DEFAULT_HEARTBEAT_STALE_MS));
  return (result.data || [])
    .filter((wake: Record<string, any>) => wakeMatchesCredentialScope(wake, scope, webhookIds))
    .map((wake: Record<string, any>) => ({
      ...redactedWake(wake),
      derived_status: derivedWakeStatus(wake, heartbeats),
    }));
}

async function routeTriggerEvent(
  event: Record<string, unknown>,
  { trustedTeamId = null }: { trustedTeamId?: string | null } = {},
) {
  if (!isPlausibleProjectPlannedEvent(event)) return [];
  const object = event.object as Record<string, unknown>;
  const wake = {
    id: id("wake"),
    workspace_id: event.workspace_id,
    trigger_type: "linear.project.planned",
    workflow_type: "decomposition",
    object_type: "project",
    object_id: object.id,
    wake_key: scopedWakeKeyForTrustedTeam(`linear:project:${object.id}:decomposition`, trustedTeamId),
    status: "queued",
    reason: "requires_runner_verification",
    source_event_id: event.id,
    requires_runner_verification: true,
    webhook_ids: event.webhook_id ? [event.webhook_id] : [],
    team_ids: arrayOfStrings(event.team_ids),
    created_at: new Date().toISOString(),
    attempt_count: 0,
  };
  const inserted = await db.from(TABLES.wakeups).insert(wake).select().maybeSingle();
  if (inserted.error?.code === "23505") {
    const existing = await selectMaybeOne(
      db.from(TABLES.wakeups)
        .select("*")
        .eq("workspace_id", wake.workspace_id)
        .eq("wake_key", wake.wake_key)
        .in("status", ACTIVE_STATUSES)
        .limit(1),
      "active wake",
    );
    if (!existing) return [{ duplicate: true, wake: null }];
    const accumulated = await db.from(TABLES.wakeups)
      .update({
        webhook_ids: unionSortedStrings(existing.webhook_ids, wake.webhook_ids),
        team_ids: unionSortedStrings(existing.team_ids, wake.team_ids),
      })
      .eq("id", existing.id)
      .in("status", ACTIVE_STATUSES)
      .select()
      .maybeSingle();
    if (accumulated.error) throw new Error(accumulated.error.message);
    if (!accumulated.data) {
      const freshWake = { ...wake, id: id("wake") };
      const fresh = await db.from(TABLES.wakeups).insert(freshWake).select().maybeSingle();
      if (fresh.error?.code === "23505") return routeTriggerEvent(event, { trustedTeamId });
      if (fresh.error) throw new Error(fresh.error.message);
      return [{ duplicate: false, wake: redactedWake(fresh.data) }];
    }
    return [{ duplicate: true, wake: redactedWake(accumulated.data) }];
  }
  if (inserted.error) throw new Error(inserted.error.message);
  return [{ duplicate: false, wake: redactedWake(inserted.data) }];
}

async function recordTriggerEvent(event: Record<string, unknown>) {
  const inserted = await db.from(TABLES.events).insert(event).select().maybeSingle();
  if (inserted.error?.code === "23505") {
    const existing = await selectOne(
      db.from(TABLES.events)
        .select("*")
        .eq("provider", event.provider)
        .eq("workspace_id", event.workspace_id)
        .eq("event_id", event.event_id)
        .limit(1),
      "existing event",
    );
    return { duplicate: true, event: camelEvent(existing) };
  }
  if (inserted.error) throw new Error(inserted.error.message);
  return { duplicate: false, event: camelEvent(inserted.data) };
}

function normalizeLinearEvent({
  payload,
  workspaceId,
  deliveryId,
  deliveryRecordId,
  receivedAt,
  webhookId,
  trustedTeamId,
}: {
  payload: Record<string, any>;
  workspaceId: string;
  deliveryId: string;
  deliveryRecordId: string;
  receivedAt: string;
  webhookId: string;
  trustedTeamId?: string | null;
}) {
  const objectType = String(payload?.type || "").toLowerCase();
  const action = payload?.action || "unknown";
  return {
    id: id("event"),
    schema_version: 1,
    provider: "linear",
    workspace_id: workspaceId,
    event_id: deliveryId,
    event_type: `linear.${objectType}.${action === "update" ? "updated" : action}`,
    occurred_at: payload?.createdAt || new Date(payload?.webhookTimestamp || Date.now()).toISOString(),
    received_at: receivedAt,
    actor: payload?.actor?.id ? { provider_user_id: payload.actor.id } : null,
    object: { type: objectType, id: payload?.data?.id },
    changed_fields: Object.keys(payload?.updatedFrom || {}),
    webhook_id: webhookId,
    team_ids: projectTeamIdsForTrustedDelivery(payload, trustedTeamId),
    raw_event_ref: deliveryRecordId,
    requires_runner_verification: true,
    // Derived routing fact instead of the raw payload: the only thing routing
    // needs from the body is the project status type (data minimization).
    project_status_type: projectStatusTypeFromPayload(payload?.data),
  };
}

function isPlausibleProjectPlannedEvent(event: Record<string, any>) {
  if (event?.provider !== "linear") return false;
  if (event.event_type !== "linear.project.updated") return false;
  if (event.object?.type !== "project" || !event.object?.id) return false;
  const changed = new Set<string>((event.changed_fields || []) as string[]);
  const hasStatusChange = hasProjectStatusChange(changed);
  if (changed.size > 0 && !hasStatusChange) return false;
  // Prefer the derived routing fact; fall back to raw_payload only for legacy
  // rows recorded before data minimization.
  const currentStatusType =
    normalizeProjectStatusType(event.project_status_type) ??
    projectStatusTypeFromPayload(event.raw_payload?.data);
  if (currentStatusType) return currentStatusType === "planned";
  return changed.size === 0 || hasStatusChange;
}

function hasProjectStatusChange(changed: Set<string>) {
  return [
    "status",
    "statusId",
    "status_id",
    "state",
    "stateId",
    "projectStatus",
    "projectStatusId",
    "workflowStatus",
    "workflowStatusId",
  ].some((field) => changed.has(field));
}

function projectStatusTypeFromPayload(data: Record<string, any> = {}) {
  return normalizeProjectStatusType(data.status || data.projectStatus || data.workflowStatus || data.state);
}

function normalizeProjectStatusType(status: unknown): string | null {
  if (!status) return null;
  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    return ["planned", "backlog", "started", "completed", "canceled", "cancelled"].includes(normalized)
      ? normalized
      : null;
  }
  if (typeof status !== "object") return null;
  const value = (status as Record<string, unknown>).type || (status as Record<string, unknown>).name;
  return typeof value === "string" ? normalizeProjectStatusType(value) : null;
}

async function assertLease(
  input: Record<string, unknown>,
  { credentialScope = null }: { credentialScope?: RunnerCredentialScope | null } = {},
) {
  requireString(input.workspaceId, "workspaceId");
  requireString(input.wakeId, "wakeId");
  const wake = await getRawWake(String(input.wakeId), String(input.workspaceId));
  const scope = credentialScope ?? unscopedRunnerCredentialScope();
  const webhookIds = effectiveWebhookIdsForCredentialScope(scope, input.webhookIds);
  if (!wake || !wakeMatchesCredentialScope(wake, scope, webhookIds)) throw httpError(404, "wake_not_found");
  if (input.runnerId !== undefined && input.runnerId !== null && wake.runner_id !== input.runnerId) {
    throw httpError(409, "runner_mismatch");
  }
  if (
    typeof input.leaseToken !== "string" ||
    input.leaseToken.trim() === "" ||
    wake.lease_token !== input.leaseToken
  ) {
    throw httpError(409, "lease_token_mismatch");
  }
  if (wake.lease_expires_at && Date.parse(String(wake.lease_expires_at)) <= Date.now()) {
    throw httpError(409, "lease_expired");
  }
  return wake;
}

async function runMaintenance(
  { at = new Date().toISOString(), breakGlassReason = null }: { at?: string; breakGlassReason?: string | null } = {},
) {
  const expiredGrants = await expireDueSetupGrants(at);
  const expiredLeases = await expireLeases(undefined, at);
  const pruned = await pruneExpired(at);
  emitHostedSecurityLog("maintenance_sweep_completed", {
    at,
    authMode: "break_glass",
    breakGlassReason,
    expiredGrants,
    expiredLeases,
    prunedWorkflowWakeups: pruned.workflowWakeups,
    prunedTriggerEvents: pruned.triggerEvents,
    prunedWebhookDeliveries: pruned.webhookDeliveries,
    prunedWorkflowRuns: pruned.workflowRuns,
    prunedDeadLetters: pruned.deadLetters,
    prunedSetupGrants: pruned.setupGrants,
    prunedRunnerCredentials: pruned.runnerCredentials,
  });
  return { ok: true, expiredGrants, expiredLeases, pruned };
}

async function expireDueSetupGrants(at: string) {
  const result = await db.from(TABLES.setupGrants)
    .update({ status: "expired", revoked_at: at, revoked_reason: "setup grant confirmation window expired" })
    .eq("status", "provisional")
    .lte("confirmation_expires_at", at)
    .select("id");
  if (result.error) throw new Error(result.error.message);
  return result.data?.length || 0;
}

async function pruneExpired(at: string) {
  const workflowRuns = await pruneTerminalWorkflowRuns(at);
  const deadLetters = await pruneDeadLetters(at);
  const workflowWakeups = await pruneTerminalWakeups(at);
  const triggerEvents = await pruneTriggerEvents(at);
  const webhookDeliveries = await pruneExpiredDeliveries(at);
  const setupGrants = await pruneInactiveSetupGrants(at);
  const runnerCredentials = await pruneInactiveRunnerCredentials(at);
  return {
    workflowWakeups,
    triggerEvents,
    webhookDeliveries,
    workflowRuns,
    deadLetters,
    setupGrants,
    runnerCredentials,
  };
}

async function pruneTerminalWakeups(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.terminalWakes);
  return await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.wakeups)
      .select("id")
      .in("status", TERMINAL_STATUS_VALUES)
      .lte("terminal_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.wakeups)
      .delete()
      .in("id", ids)
      .in("status", TERMINAL_STATUS_VALUES)
      .lte("terminal_at", cutoff)
      .select("id"),
  }) + await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.wakeups)
      .select("id")
      .in("status", TERMINAL_STATUS_VALUES)
      .is("terminal_at", null)
      .lte("created_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.wakeups)
      .delete()
      .in("id", ids)
      .in("status", TERMINAL_STATUS_VALUES)
      .is("terminal_at", null)
      .lte("created_at", cutoff)
      .select("id"),
  });
}

async function pruneTriggerEvents(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.triggerEvents);
  return deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.events)
      .select("id")
      .lte("received_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.events)
      .delete()
      .in("id", ids)
      .lte("received_at", cutoff)
      .select("id"),
  });
}

async function pruneTerminalWorkflowRuns(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.workflowRuns);
  return await deleteMatchingBatches({
    keyColumn: "run_id",
    selectKeys: () => db.from(TABLES.workflowRuns)
      .select("run_id")
      .in("status", TERMINAL_STATUS_VALUES)
      .lte("terminal_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.workflowRuns)
      .delete()
      .in("run_id", ids)
      .in("status", TERMINAL_STATUS_VALUES)
      .lte("terminal_at", cutoff)
      .select("run_id"),
  }) + await deleteMatchingBatches({
    keyColumn: "run_id",
    selectKeys: () => db.from(TABLES.workflowRuns)
      .select("run_id")
      .in("status", TERMINAL_STATUS_VALUES)
      .is("terminal_at", null)
      .lte("started_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.workflowRuns)
      .delete()
      .in("run_id", ids)
      .in("status", TERMINAL_STATUS_VALUES)
      .is("terminal_at", null)
      .lte("started_at", cutoff)
      .select("run_id"),
  });
}

async function pruneDeadLetters(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.deadLetters);
  return deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.deadLetters)
      .select("id")
      .lte("created_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.deadLetters)
      .delete()
      .in("id", ids)
      .lte("created_at", cutoff)
      .select("id"),
  });
}

async function pruneInactiveSetupGrants(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.inactiveSetupGrants);
  const inactiveStatuses = ["revoked", "expired", "superseded"];
  return await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.setupGrants)
      .select("id")
      .in("status", inactiveStatuses)
      .lte("revoked_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.setupGrants)
      .delete()
      .in("id", ids)
      .in("status", inactiveStatuses)
      .lte("revoked_at", cutoff)
      .select("id"),
  }) + await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.setupGrants)
      .select("id")
      .in("status", inactiveStatuses)
      .is("revoked_at", null)
      .lte("created_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.setupGrants)
      .delete()
      .in("id", ids)
      .in("status", inactiveStatuses)
      .is("revoked_at", null)
      .lte("created_at", cutoff)
      .select("id"),
  });
}

async function pruneInactiveRunnerCredentials(at: string) {
  const cutoff = plusMs(at, -RETENTION_MS.inactiveRunnerCredentials);
  return await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.runnerCredentials)
      .select("id")
      .eq("active", false)
      .lte("revoked_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.runnerCredentials)
      .delete()
      .in("id", ids)
      .eq("active", false)
      .lte("revoked_at", cutoff)
      .select("id"),
  }) + await deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.runnerCredentials)
      .select("id")
      .eq("active", false)
      .is("revoked_at", null)
      .lte("created_at", cutoff),
    deleteKeys: (ids) => db.from(TABLES.runnerCredentials)
      .delete()
      .in("id", ids)
      .eq("active", false)
      .is("revoked_at", null)
      .lte("created_at", cutoff)
      .select("id"),
  });
}

async function deleteMatchingBatches({
  keyColumn,
  selectKeys,
  deleteKeys,
}: {
  keyColumn: string;
  selectKeys: () => any;
  deleteKeys: (ids: string[]) => any;
}) {
  let deletedTotal = 0;
  for (;;) {
    const selected = await selectKeys().limit(MAINTENANCE_DELETE_BATCH_SIZE);
    if (selected.error) throw new Error(selected.error.message);
    const ids = (selected.data || [])
      .map((row: Record<string, unknown>) => row[keyColumn])
      .filter((value: unknown): value is string => typeof value === "string" && value.trim() !== "");
    if (ids.length === 0) return deletedTotal;
    const deleted = await deleteKeys(ids);
    if (deleted.error) throw new Error(deleted.error.message);
    const count = deleted.data?.length || 0;
    deletedTotal += count;
    if (ids.length < MAINTENANCE_DELETE_BATCH_SIZE || count === 0) return deletedTotal;
  }
}

async function expireLeases(workspaceId?: string, at = new Date().toISOString()) {
  let query = db.from(TABLES.wakeups)
    .select("*")
    .in("status", ["leased", "running"])
    .lte("lease_expires_at", at);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const expired = await query;
  if (expired.error) throw new Error(expired.error.message);
  let count = 0;
  for (const wake of expired.data || []) {
    if (wake.mutation_started_at) {
      const acted = await deadLetterWakeWithoutLease(wake, `runner_lost_after_linear_mutation_started:${wake.runner_id}`, at);
      if (acted) count += 1;
    } else {
      // Conditional reset (anti-race): only requeue if the lease is STILL the one we observed
      // and STILL expired. A runner that renewed (new lease_expires_at) or re-claimed (new
      // lease_token) between the select above and here will not match, so active work is never
      // clobbered — zero updated rows is a benign race.
      const reset = await db.from(TABLES.wakeups)
        .update({
          status: "queued",
          claimed_at: null,
          runner_id: null,
          lease_token: null,
          lease_expires_at: null,
          started_at: null,
          run_id: null,
        })
        .eq("id", wake.id)
        .eq("lease_token", wake.lease_token)
        .in("status", ["leased", "running"])
        .lte("lease_expires_at", at)
        .select("id");
      if (reset.error) throw new Error(reset.error.message);
      if ((reset.data?.length ?? 0) > 0) count += 1;
    }
  }
  return count;
}

async function deadLetterWakeWithoutLease(wake: Record<string, any>, reason: string, at = new Date().toISOString()) {
  const now = at;
  // Same anti-race guard as the reset path: only dead-letter if the observed lease is still
  // present and still expired. A renewed/re-claimed lease means the runner is alive and must
  // not be dead-lettered; zero updated rows is a benign race and we do nothing further.
  const updated = await db.from(TABLES.wakeups)
    .update({ status: "dead_letter", reason, terminal_at: now, lease_expires_at: null, lease_token: null })
    .eq("id", wake.id)
    .eq("lease_token", wake.lease_token)
    .in("status", ["leased", "running"])
    .lte("lease_expires_at", at)
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  if ((updated.data?.length ?? 0) === 0) return false;
  const dead = await db.from(TABLES.deadLetters).insert({ id: id("dead_letter"), wake_id: wake.id, reason, created_at: now });
  if (dead.error) throw new Error(dead.error.message);
  if (wake.run_id) {
    const run = await db.from(TABLES.workflowRuns)
      .update({ status: "dead_letter", terminal_at: now, terminal_reason: reason })
      .eq("wake_id", wake.id)
      .eq("run_id", wake.run_id);
    if (run.error) throw new Error(run.error.message);
  }
  return true;
}

async function pruneExpiredDeliveries(at = new Date().toISOString()) {
  return deleteMatchingBatches({
    keyColumn: "id",
    selectKeys: () => db.from(TABLES.deliveries)
      .select("id")
      .lte("retention_expires_at", at),
    deleteKeys: (ids) => db.from(TABLES.deliveries)
      .delete()
      .in("id", ids)
      .lte("retention_expires_at", at)
      .select("id"),
  });
}

async function verifyStoredLinearSignature({
  workspaceId,
  rawBody,
  signature,
}: {
  workspaceId: string;
  rawBody: string;
  signature: string;
}): Promise<LinearSignatureVerification> {
  const secrets = await db.from(TABLES.webhookSecrets)
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("active", true);
  if (secrets.error) throw new Error(secrets.error.message);
  if (!secrets.data?.length) return { ok: false, reason: "missing_signing_secret" };
  for (const secret of secrets.data) {
    const expected = await hmacHex(String(secret.signing_secret), rawBody);
    if (constantTimeEqual(expected, signature)) {
      return { ok: true, secretId: secret.id, webhookId: secret.webhook_id, secret };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

async function freshHeartbeats(workspaceId: string, staleMs: number) {
  const threshold = plusMs(new Date().toISOString(), -staleMs);
  const result = await db.from(TABLES.runnerHeartbeats)
    .select("*")
    .eq("workspace_id", workspaceId)
    .gte("last_seen_at", threshold);
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

function derivedWakeStatus(wake: Record<string, any>, heartbeats: Record<string, any>[]) {
  if (wake.status !== "queued") return wake.status;
  const fresh = heartbeats.some((heartbeat) => {
    const capabilities = new Set(heartbeat.capabilities || []);
    return REQUIRED_CAPABILITIES.every((capability) => capabilities.has(capability));
  });
  return fresh ? "queued" : "waiting_for_runner";
}

function missingCapabilities(workflowType: string, capabilities: string[]) {
  if (workflowType !== "decomposition") return [];
  const runnerCapabilities = new Set(capabilities);
  return REQUIRED_CAPABILITIES.filter((capability) => !runnerCapabilities.has(capability));
}

function effectiveClaimCapabilities({
  storedCapabilities,
  presentedCapabilities,
}: {
  storedCapabilities: unknown;
  presentedCapabilities: unknown;
}) {
  const stored = arrayOfStrings(storedCapabilities);
  const presented = arrayOfStrings(presentedCapabilities);
  if (presented.length === 0) return stored;
  const presentedSet = new Set(presented);
  return stored.filter((capability) => presentedSet.has(capability));
}

function unscopedRunnerCredentialScope(): RunnerCredentialScope {
  return { storedWebhookIds: [], storedTeamId: null, storedDomainId: null };
}

function storedWebhookScopeActive(scope: RunnerCredentialScope) {
  return scope.storedWebhookIds.length > 0;
}

function effectiveWebhookIdsForCredentialScope(scope: RunnerCredentialScope, presentedWebhookIds: unknown) {
  const presented = sortedStrings(presentedWebhookIds);
  if (!storedWebhookScopeActive(scope)) return presented;
  if (presented.length === 0) return scope.storedWebhookIds;
  const presentedSet = new Set(presented);
  return scope.storedWebhookIds.filter((webhookId) => presentedSet.has(webhookId));
}

function wakeMatchesCredentialScope(
  wake: Record<string, any>,
  scope: RunnerCredentialScope,
  effectiveWebhookIds: string[],
) {
  if (storedWebhookScopeActive(scope)) {
    if (effectiveWebhookIds.length === 0) return false;
    if (!wakeMatchesWebhookFilter(wake, effectiveWebhookIds)) return false;
  } else if (effectiveWebhookIds.length > 0 && !wakeMatchesWebhookFilter(wake, effectiveWebhookIds)) {
    return false;
  }
  return wakeMatchesStoredTeamScope(wake, scope);
}

function wakeMatchesStoredTeamScope(wake: Record<string, any>, scope: RunnerCredentialScope) {
  if (!scope.storedTeamId) return true;
  const wakeTeamIds = sortedStrings(wake.team_ids);
  return wakeTeamIds.length === 0 || wakeTeamIds.includes(scope.storedTeamId);
}

async function getRawWake(wakeId: string, workspaceId: string) {
  return selectMaybeOne(
    db.from(TABLES.wakeups).select("*").eq("id", wakeId).eq("workspace_id", workspaceId).limit(1),
    "wake",
  );
}

async function selectOne(query: any, label: string) {
  const result = await query.maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw httpError(404, `${label} not found`);
  return result.data;
}

async function selectMaybeOne(query: any, _label: string) {
  const result = await query.maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data || null;
}

async function selectActiveSetupGrant({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
  return selectMaybeOne(
    db.from(TABLES.setupGrants)
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("team_id", teamId)
      .in("status", ["provisional", "confirmed"])
      .limit(1),
    "active setup grant",
  );
}

async function expireConflictingProvisionalGrants({
  workspaceId,
  teamId,
  now,
}: {
  workspaceId: string;
  teamId: string;
  now: string;
}) {
  // A provisional grant stays active until its CONFIRMATION window (days), not the short
  // mutation window (minutes). Deferred confirmation waits for the team's first Planned
  // delivery, which can be days out, so a bound grant must remain confirmable (and must
  // keep blocking re-issuance) past the mutation window. Expire only when the confirmation
  // window has lapsed, or when setup was abandoned before a webhook was bound and the
  // mutation window has lapsed (frees the slot for re-init).
  const confirmationLapsed = await db.from(TABLES.setupGrants)
    .update({ status: "expired", revoked_at: now, revoked_reason: "setup grant confirmation window expired" })
    .eq("workspace_id", workspaceId)
    .eq("team_id", teamId)
    .eq("status", "provisional")
    .lte("confirmation_expires_at", now);
  if (confirmationLapsed.error) throw new Error(confirmationLapsed.error.message);
  const abandonedUnbound = await db.from(TABLES.setupGrants)
    .update({ status: "expired", revoked_at: now, revoked_reason: "setup grant mutation window expired" })
    .eq("workspace_id", workspaceId)
    .eq("team_id", teamId)
    .eq("status", "provisional")
    .is("webhook_id", null)
    .lte("expires_at", now);
  if (abandonedUnbound.error) throw new Error(abandonedUnbound.error.message);
}

async function expireSetupGrant(grant: SetupGrant, reason: string) {
  const expired = await db.from(TABLES.setupGrants)
    .update({ status: "expired", revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("id", grant.id)
    .eq("status", "provisional");
  if (expired.error) throw new Error(expired.error.message);
}

async function selectGrantForBreakGlass(input: Record<string, unknown>) {
  const grantId = optionalString(input.grantId ?? input.grant_id);
  if (grantId) {
    return selectOne(
      db.from(TABLES.setupGrants).select("*").eq("grant_id", grantId).limit(1),
      "setup grant",
    );
  }
  requireString(input.workspaceId, "workspaceId");
  requireString(input.teamId, "teamId");
  return selectOne(
    db.from(TABLES.setupGrants)
      .select("*")
      .eq("workspace_id", input.workspaceId)
      .eq("team_id", input.teamId)
      .in("status", ["provisional", "confirmed"])
      .limit(1),
    "active setup grant",
  );
}

async function revokeSetupGrantAndCredentials(grant: SetupGrant, reason: string) {
  const revokedAt = new Date().toISOString();
  const revoked = await db.from(TABLES.setupGrants)
    .update({ status: "revoked", revoked_at: revokedAt, revoked_reason: reason })
    .eq("id", grant.id)
    .select()
    .single();
  if (revoked.error) throw new Error(revoked.error.message);
  const revokedCredentials = await revokeCredentialsForGrant(grant, revokedAt);
  const revokedWebhookSecrets = await deactivateWebhookSecretsForGrant(grant, revokedAt);
  return {
    ok: true,
    grant: setupGrantStatus(revoked.data),
    revokedCredentials,
    revokedWebhookSecrets,
  };
}

async function revokeCredentialsForGrant(grant: SetupGrant, revokedAt: string) {
  const webhookId = optionalString(grant.webhook_id);
  if (!webhookId) return 0;
  let query = db.from(TABLES.runnerCredentials)
    .update({ active: false, revoked_at: revokedAt })
    .eq("workspace_id", grant.workspace_id)
    .eq("team_id", grant.team_id)
    .contains("webhook_ids", [webhookId]);
  if (grant.domain_id) query = query.eq("domain_id", grant.domain_id);
  const result = await query.select("id");
  if (result.error) throw new Error(result.error.message);
  return result.data?.length || 0;
}

async function deactivateWebhookSecretsForGrant(grant: SetupGrant, revokedAt: string) {
  const result = await db.from(TABLES.webhookSecrets)
    .update({ active: false, updated_at: revokedAt })
    .eq("setup_grant_id", grant.grant_id)
    .select("id");
  if (result.error) throw new Error(result.error.message);
  return result.data?.length || 0;
}

function requireBreakGlassAuth(req: Request) {
  const expected = Deno.env.get("AGENTIC_FACTORY_INBOX_ADMIN_TOKEN");
  if (!expected) throw httpError(503, "break-glass admin token is not configured");
  const actual = req.headers.get(ADMIN_HEADER) || "";
  if (!constantTimeEqual(actual, expected)) throw httpError(401, "invalid break-glass admin token");
  const reason = req.headers.get(BREAK_GLASS_REASON_HEADER);
  if (!reason || reason.trim() === "") throw httpError(400, "break_glass_reason_required");
  return reason.trim();
}

function parseSetupGrantToken(token: string) {
  const match = token.match(/^af_setup_v1_([^_]+)_([^_]+)$/);
  if (!match) return null;
  return { grantId: match[1], secret: match[2] };
}

function setupGrantPublicId() {
  return `sg${crypto.randomUUID().replaceAll("-", "")}`;
}

function setupGrantSecret() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function randomStateNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function assertMintRequestDoesNotWidenGrant(input: Record<string, unknown>, grant: SetupGrant) {
  const teamId = optionalString(input.teamId ?? input.team_id);
  if (teamId && teamId !== grant.team_id) throw httpError(403, "setup_grant_scope_mismatch");
  const domainId = optionalString(input.domainId ?? input.domain_id);
  if (domainId && domainId !== optionalString(grant.domain_id)) throw httpError(403, "setup_grant_scope_mismatch");
  const requestedWebhookIds = sortedStrings(input.webhookIds ?? input.webhook_ids);
  if (requestedWebhookIds.length > 0 && !requestedWebhookIds.every((webhookId) => webhookId === grant.webhook_id)) {
    throw httpError(403, "setup_grant_scope_mismatch");
  }
}

function linearSignatureVerificationResponse(verification: LinearSignatureVerification) {
  if (!verification.ok) return verification;
  return {
    ok: true,
    secretId: verification.secretId,
    webhookId: verification.webhookId,
  };
}

function supabaseSecretKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed = JSON.parse(secretKeys);
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("Supabase service role key is unavailable to the Edge Function.");
}

function routeFor(req: Request) {
  const url = new URL(req.url);
  const marker = `/${FUNCTION_SLUG}`;
  const index = url.pathname.indexOf(marker);
  const route = index >= 0 ? url.pathname.slice(index + marker.length) : url.pathname;
  return route || "/";
}

function auditSetupGrantAuthMode(createdBy: string, bypassActiveConflict: boolean) {
  if (bypassActiveConflict) return "setup_grant_refresh";
  if (createdBy.startsWith("break_glass:")) return "break_glass";
  return createdBy === "anonymous_init" ? "anonymous" : "other";
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

function originBaseUrl(req: Request) {
  const url = new URL(req.url);
  const marker = `/${FUNCTION_SLUG}`;
  const index = url.pathname.indexOf(marker);
  return `${url.origin}${index >= 0 ? url.pathname.slice(0, index + marker.length) : marker}`;
}

async function readJson(req: Request) {
  const text = await readCappedBody(req);
  return text ? JSON.parse(text) : {};
}

async function readCappedBody(req: Request) {
  assertContentLengthWithinCap(req.headers);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES) {
    throw httpError(413, "payload_too_large");
  }
  return text;
}

function assertContentLengthWithinCap(headers: Headers) {
  const contentLength = headers.get("content-length");
  if (contentLength == null || contentLength.trim() === "") return;
  const bytes = Number(contentLength);
  if (Number.isFinite(bytes) && bytes > MAX_WEBHOOK_BODY_BYTES) {
    throw httpError(413, "payload_too_large");
  }
}

function requireLinearWebhookHeaders(headers: Headers) {
  const signature = headers.get("linear-signature")?.trim();
  if (!signature) throw httpError(401, "missing_signature_header");
  const deliveryId = headers.get("linear-delivery")?.trim();
  if (!deliveryId) throw httpError(400, "missing_delivery_header");
  return { signature, deliveryId };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Agentic Factory GitHub App</title><body>${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function httpError(status: number, message: string, details: Record<string, unknown> = {}) {
  const error = new Error(message) as Error & { status: number; details: Record<string, unknown> };
  error.status = status;
  error.details = details;
  return error;
}

const PERSISTED_HEADER_ALLOWLIST = ["linear-delivery", "linear-signature", "content-type", "user-agent"];

function allowlistedHeaders(headers: Headers) {
  const value: Record<string, string> = {};
  for (const key of PERSISTED_HEADER_ALLOWLIST) {
    const headerValue = headers.get(key);
    if (headerValue) value[key] = headerValue;
  }
  return value;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") throw httpError(400, `${label} is required`);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sortedStrings(value: unknown) {
  return [...new Set(arrayOfStrings(value).filter((item) => item.trim() !== ""))].sort();
}

function unionSortedStrings(left: unknown, right: unknown) {
  return sortedStrings([...sortedStrings(left), ...sortedStrings(right)]);
}

function withCredentialScopeFilter(query: any, scope: RunnerCredentialScope, effectiveWebhookIds: string[]) {
  const webhookConditions = sortedStrings(effectiveWebhookIds)
    .map((webhookId) => `webhook_ids.cs.${JSON.stringify([webhookId])}`);
  const teamConditions = scope.storedTeamId
    ? [`team_ids.eq.${JSON.stringify([])}`, `team_ids.cs.${JSON.stringify([scope.storedTeamId])}`]
    : [];
  if (storedWebhookScopeActive(scope) && webhookConditions.length === 0) return query.eq("id", "__credential_scope_empty__");
  if (webhookConditions.length > 0 && teamConditions.length > 0) {
    const filters = webhookConditions.flatMap((webhookCondition) =>
      teamConditions.map((teamCondition) => `and(${webhookCondition},${teamCondition})`)
    );
    return query.or(filters.join(","));
  }
  if (webhookConditions.length > 0) return query.or(webhookConditions.join(","));
  if (teamConditions.length > 0) return query.or(teamConditions.join(","));
  return query;
}

function withWebhookIdsFilter(query: any, webhookIds: string[]) {
  const ids = sortedStrings(webhookIds);
  if (!ids.length) return query;
  const filters = ids.map((webhookId) => `webhook_ids.cs.${JSON.stringify([webhookId])}`);
  return query.or(filters.join(","));
}

function wakeMatchesWebhookFilter(wake: Record<string, any>, webhookIds: string[]) {
  const ids = sortedStrings(webhookIds);
  if (!ids.length) return true;
  const wakeWebhookIds = new Set(sortedStrings(wake.webhook_ids));
  return ids.some((webhookId) => wakeWebhookIds.has(webhookId));
}

function projectTeamIdsFromPayload(payload: Record<string, any>) {
  return sortedStrings(payload?.data?.teamIds);
}

function projectTeamIdsForTrustedDelivery(payload: Record<string, any>, trustedTeamId: string | null = null) {
  const payloadTeamIds = projectTeamIdsFromPayload(payload);
  const teamId = optionalString(trustedTeamId);
  return teamId && !(payloadTeamIds.length > 1 && payloadTeamIds.includes(teamId)) ? [teamId] : payloadTeamIds;
}

function trustedTeamIdFromVerification(verification: Extract<LinearSignatureVerification, { ok: true }>) {
  return optionalString(verification.secret?.team_id);
}

function scopedWakeKeyForTrustedTeam(wakeKey: string, trustedTeamId: string | null = null) {
  const teamId = optionalString(trustedTeamId);
  return teamId ? `${wakeKey}:scope:team:${encodeURIComponent(teamId)}` : wakeKey;
}

function normalizeRoutingCandidates(value: unknown) {
  if (!Array.isArray(value)) return { ok: false };
  const candidates = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return { ok: false };
    const record = candidate as Record<string, unknown>;
    if (!isNonEmptyString(record.domainId)) return { ok: false };
    if (!isNonEmptyString(record.status)) return { ok: false };
    if (!(typeof record.teamId === "string" || record.teamId === null)) return { ok: false };
    candidates.push({
      domainId: record.domainId,
      status: record.status,
      teamId: record.teamId,
    });
  }
  return { ok: true, candidates };
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() !== "";
}

function numberOrDefault(value: unknown, defaultValue: number) {
  return Number.isFinite(value) ? Number(value) : defaultValue;
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function plusMs(baseIso: string, ms: number) {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return hex(new Uint8Array(signature));
}

async function signBrokerCredential({ key, payload }: { key: string; payload: BrokerCredentialPayload }) {
  const segment = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(segment));
  const sig = base64UrlEncode(new Uint8Array(signature));
  return `${BROKER_CREDENTIAL_PREFIX}.${segment}.${sig}`;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function camelWake(wake: Record<string, any>) {
  return {
    id: wake.id,
    workspace_id: wake.workspace_id,
    trigger_type: wake.trigger_type,
    workflow_type: wake.workflow_type,
    object_type: wake.object_type,
    object_id: wake.object_id,
    wake_key: wake.wake_key,
    status: wake.status,
    reason: wake.reason,
    source_event_id: wake.source_event_id,
    requires_runner_verification: wake.requires_runner_verification,
    webhook_ids: wake.webhook_ids || [],
    team_ids: wake.team_ids || [],
    domain_id: wake.domain_id,
    routing_error_reason: wake.routing_error_reason,
    routing_candidates: wake.routing_candidates,
    created_at: wake.created_at,
    claimed_at: wake.claimed_at,
    runner_id: wake.runner_id,
    lease_token: wake.lease_token,
    lease_expires_at: wake.lease_expires_at,
    started_at: wake.started_at,
    mutation_started_at: wake.mutation_started_at,
    attempt_count: wake.attempt_count,
    terminal_at: wake.terminal_at,
    run_id: wake.run_id,
    last_claim_rejection_reason: wake.last_claim_rejection_reason,
  };
}

function redactedWake(wake: Record<string, any>) {
  const copy = camelWake(wake);
  delete (copy as Record<string, unknown>).lease_token;
  return copy;
}

function camelEvent(event: Record<string, any>) {
  return event;
}

function camelRun(run: Record<string, any>) {
  return {
    run_id: run.run_id,
    workspace_id: run.workspace_id,
    workflow_type: run.workflow_type,
    wake_id: run.wake_id,
    object_id: run.object_id,
    status: run.status,
    started_at: run.started_at,
    terminal_at: run.terminal_at,
    terminal_reason: run.terminal_reason,
    artifact_pointer: run.artifact_pointer,
    provider_update_ids: run.provider_update_ids || [],
  };
}

function camelWakeLike(value: Record<string, any>) {
  return value;
}
