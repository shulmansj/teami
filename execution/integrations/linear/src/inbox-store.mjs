import crypto from "node:crypto";

import { signBrokerCredential } from "./broker-credential.mjs";
import { requiredCapabilitiesForWorkflow } from "./trigger-registry.mjs";

export const TERMINAL_WAKE_STATUSES = new Set(["paused", "completed", "rejected", "dead_letter"]);
export const ACTIVE_WAKE_STATUSES = new Set(["queued", "leased", "running", "routing_error"]);

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
  "domain_not_found",
  "domain_not_active",
  "no_active_domains",
  "domain_required",
  "unknown_workflow_type",
]);

const DEFAULT_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RAW_PAYLOAD_RETENTION_MS = 30 * DAY_MS;
const SETUP_GRANT_MUTATION_TTL_MS = 15 * 60 * 1000;
const SETUP_GRANT_CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_GRANT_ISSUANCE_WINDOW_MS = 60 * 60 * 1000;
const SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE = 10;
const GITHUB_INSTALL_STATE_TTL_MS = 15 * 60 * 1000;
const BROKER_CREDENTIAL_TTL_SECONDS = 60 * 60;
export const BROKER_CREDENTIAL_REMINT_WINDOW_MS = 60 * 60 * 1000;
export const BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW = 30;
// Per-workspace cap is the targeted control; the global cap is only a runaway-row backstop
// far above any real fleet burst (a low shared global cap is itself a lockout DoS). Real
// cross-workspace abuse control is per-IP / gateway, which is deploy-side (C4 follow-up).
const SETUP_GRANT_ISSUANCE_MAX_GLOBAL = 10000;
export const RETENTION_MS = Object.freeze({
  terminalWakes: 90 * DAY_MS, // terminal wake rows by terminal_at, falling back to updated_at/created_at.
  triggerEvents: 90 * DAY_MS, // trigger_events by received_at, falling back to created_at.
  webhookDeliveries: DEFAULT_RAW_PAYLOAD_RETENTION_MS, // deliveries use each row's retention_expires_at.
  workflowRuns: 90 * DAY_MS, // terminal workflow_runs by terminal_at, falling back to started_at.
  deadLetters: 180 * DAY_MS, // dead_letters by created_at.
  inactiveSetupGrants: 30 * DAY_MS, // revoked/expired/superseded grants by revoked_at, falling back to created_at.
  inactiveRunnerCredentials: 30 * DAY_MS, // inactive runner credentials by revoked_at, falling back to created_at.
});

export class MemoryInboxStore {
  constructor({
    now = () => new Date(),
    idGenerator = defaultIdGenerator(),
    heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
    rawPayloadRetentionMs = DEFAULT_RAW_PAYLOAD_RETENTION_MS,
  } = {}) {
    this.now = now;
    this.idGenerator = idGenerator;
    this.heartbeatStaleMs = heartbeatStaleMs;
    this.rawPayloadRetentionMs = rawPayloadRetentionMs;
    this.setupGrants = [];
    this.webhookSecrets = [];
    this.webhookDeliveries = [];
    this.triggerEvents = [];
    this.workflowWakeups = [];
    this.runnerCredentials = [];
    this.runnerHeartbeats = new Map();
    this.workflowRuns = [];
    this.deadLetters = [];
  }

  requestSetupGrant({
    workspaceId,
    teamId,
    domainId = null,
    createdBy = "anonymous_init",
    secret = setupGrantSecret(),
    at = this.isoNow(),
    bypassActiveConflict = false,
  } = {}) {
    requireString(workspaceId, "workspaceId");
    requireString(teamId, "teamId");
    // Issuance abuse bound: throttle how fast seats can be grabbed per workspace and globally
    // (the pre-launch mitigation for the accepted setup-ownership residual).
    if (!bypassActiveConflict) {
      const windowStartMs = Date.parse(at) - SETUP_GRANT_ISSUANCE_WINDOW_MS;
      const recent = this.setupGrants.filter(
        (candidate) => candidate.workspace_id === workspaceId && Date.parse(candidate.created_at) >= windowStartMs,
      ).length;
      if (recent >= SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE) {
        return {
          ok: false,
          reason: "setup_grant_rate_limited",
          guidance: "Too many setup attempts for this workspace recently. Wait and retry, or create a diagnostic export for support. Support cannot recover credentials or operate this factory for you.",
        };
      }
      const recentGlobal = this.setupGrants.filter(
        (candidate) => Date.parse(candidate.created_at) >= windowStartMs,
      ).length;
      if (recentGlobal >= SETUP_GRANT_ISSUANCE_MAX_GLOBAL) {
        return {
          ok: false,
          reason: "setup_grant_rate_limited",
          guidance: "Too many setup attempts across all workspaces recently. Wait and retry, or create a diagnostic export for support. Support cannot recover credentials or operate this factory for you.",
        };
      }
    }
    if (!bypassActiveConflict) this.expireConflictingProvisionalGrants({ workspaceId, teamId, at });
    const active = this.setupGrants.find(
      (grant) =>
        grant.workspace_id === workspaceId &&
        grant.team_id === teamId &&
        ["provisional", "confirmed"].includes(grant.status),
    );
    if (active) {
      return {
        ok: false,
        reason: "setup_grant_conflict",
        guidance: "An active setup grant already exists for this Linear team.",
        grant: redactSetupGrant(active),
      };
    }
    const grantId = setupGrantPublicId();
    const grant = {
      id: this.idGenerator("setup_grant"),
      grant_id: grantId,
      secret_hash: sha256Hex(secret),
      workspace_id: workspaceId,
      team_id: teamId,
      domain_id: optionalString(domainId),
      webhook_id: null,
      github_installation_id: null,
      github_owner: null,
      github_repo: null,
      github_repo_verified_at: null,
      github_install_state_hash: null,
      github_install_state_expires_at: null,
      github_installation_bound_at: null,
      github_install_flow: null,
      status: "provisional",
      scopes: ["linear.webhook_secret.setup", "runner_credentials.mint"],
      uses_remaining: 8,
      expires_at: plusMsIso(at, SETUP_GRANT_MUTATION_TTL_MS),
      confirmation_expires_at: plusMsIso(at, SETUP_GRANT_CONFIRMATION_TTL_MS),
      confirmed_at: null,
      confirmation_delivery_id: null,
      created_at: at,
      created_by: createdBy,
      revoked_at: null,
      revoked_reason: null,
      last_used_at: null,
      github_broker_remint_count: 0,
      github_broker_remint_window_started_at: null,
    };
    this.setupGrants.push(grant);
    return {
      ok: true,
      setupGrant: `af_setup_v1_${grantId}_${secret}`,
      grant: redactSetupGrant(grant),
    };
  }

  refreshSetupGrant({ setupGrant, workspaceId, teamId = null, at = this.isoNow() } = {}) {
    const grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, at });
    if (grant.status === "provisional" && Date.parse(grant.confirmation_expires_at) <= Date.parse(at)) {
      grant.status = "expired";
      grant.revoked_at = at;
      grant.revoked_reason = "setup grant confirmation window expired";
      throw new Error("setup grant confirmation window expired");
    }
    grant.expires_at = plusMsIso(at, SETUP_GRANT_MUTATION_TTL_MS);
    grant.last_used_at = at;
    return {
      ok: true,
      refreshed: true,
      setupGrant,
      grant: redactSetupGrant(grant),
    };
  }

  setupGrantStatus({ setupGrant, workspaceId, teamId, at = this.isoNow() } = {}) {
    const grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, at, allowExpired: true });
    return redactSetupGrant(grant);
  }

  githubInstallIntent({
    setupGrant,
    workspaceId,
    teamId = null,
    appSlug,
    clientId = "github-app-client",
    owner,
    repo,
    state = setupGrantSecret(),
    githubInstallationLookup = null,
    at = this.isoNow(),
  } = {}) {
    requireString(appSlug, "appSlug");
    requireString(owner, "owner");
    requireString(repo, "repo");
    const grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, consumeUse: true, at });
    const ownerTrim = String(owner).trim();
    const repoTrim = String(repo).trim();
    // Classify the flow before mutating the grant, mirroring the hosted edge
    // function's ordering (decide install_app vs authorize_existing_installation,
    // then persist) so the two implementations stay structurally in parity.
    const existingInstallation = typeof githubInstallationLookup === "function"
      ? githubInstallationLookup({ owner: ownerTrim, repo: repoTrim })
      : null;
    const existingInstallationId = githubInstallationId(existingInstallation?.id ?? existingInstallation?.installation?.id);
    const flow = existingInstallationId ? "authorize_existing_installation" : "install_app";
    const expiresAt = plusMsIso(at, GITHUB_INSTALL_STATE_TTL_MS);
    grant.github_installation_id = null;
    grant.github_owner = ownerTrim;
    grant.github_repo = repoTrim;
    grant.github_repo_verified_at = null;
    grant.github_install_state_hash = sha256Hex(state);
    grant.github_install_state_expires_at = expiresAt;
    grant.github_installation_bound_at = null;
    grant.github_install_flow = flow;
    grant.last_used_at = at;
    return {
      ok: true,
      installUrl: existingInstallationId
        ? githubOAuthAuthorizeUrl({ clientId, state })
        : githubInstallUrl({ appSlug, state }),
      flow,
      state,
      expiresAt,
    };
  }

  async bindGitHubInstallationFromCallback({
    state,
    code = null,
    githubClient = null,
    setupAction = null,
    at = this.isoNow(),
  } = {}) {
    requireString(state, "state");
    const stateHash = sha256Hex(state);
    const grant = this.setupGrants.find((candidate) =>
      candidate.github_install_state_hash === stateHash &&
      candidate.github_install_state_expires_at &&
      Date.parse(candidate.github_install_state_expires_at) > Date.parse(at) &&
      ["provisional", "confirmed"].includes(candidate.status)
    );
    if (!grant) return { ok: false, reason: "invalid_or_expired_install_link" };
    const owner = optionalString(grant.github_owner);
    const repo = optionalString(grant.github_repo);
    if (!owner || !repo) return { ok: false, status: 400, reason: "github_repo_not_bound" };
    if (optionalString(code)) {
      const verification = await verifyGitHubOAuthRepoWritePermissionWithClient({
        githubClient,
        code: optionalString(code),
        owner,
        repo,
      });
      if (!verification.ok) return verification;
    } else if (grant.github_install_flow !== "install_app") {
      return { ok: false, status: 400, reason: "github_oauth_code_required" };
    }
    const installation = await resolveGitHubInstallationIdWithClient({
      githubClient,
      owner,
      repo,
    });
    if (!installation.ok) return installation;
    grant.github_installation_id = installation.installationId;
    grant.github_owner = owner;
    grant.github_repo = repo;
    grant.github_repo_verified_at = at;
    grant.github_installation_bound_at = at;
    grant.github_install_state_hash = null;
    grant.github_install_state_expires_at = null;
    grant.github_install_flow = null;
    grant.last_used_at = at;
    return { ok: true, setupAction, grant: redactSetupGrant(grant) };
  }

  issueBrokerCredential({
    setupGrant,
    workspaceId,
    teamId = null,
    key,
    at = this.isoNow(),
  } = {}) {
    requireString(key, "key");
    const grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, steadyState: true, at });
    if (!grant.github_owner || !grant.github_repo || !grant.github_repo_verified_at) {
      throw new Error("github_repo_not_verified");
    }
    if (!grant.github_installation_id) {
      throw new Error("github_installation_not_bound");
    }
    const remint = nextBrokerCredentialRemintWindow(grant, at);
    if (!remint.ok) throw new Error("broker_credential_remint_rate_limited");
    grant.last_used_at = at;
    grant.github_broker_remint_count = remint.count;
    grant.github_broker_remint_window_started_at = remint.windowStartedAt;
    const exp = Math.floor(Date.parse(at) / 1000) + BROKER_CREDENTIAL_TTL_SECONDS;
    const payload = {
      v: 1,
      workspaceId: grant.workspace_id,
      teamId: grant.team_id,
      installationId: grant.github_installation_id,
      owner: grant.github_owner,
      repo: grant.github_repo,
      exp,
    };
    return {
      ok: true,
      brokerCredential: signBrokerCredential({ key, payload }),
      owner: payload.owner,
      repo: payload.repo,
      installationId: payload.installationId,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  revokeSetupGrant({ setupGrant = null, workspaceId, teamId, grantId = null, reason = "grant holder requested revoke", at = this.isoNow() } = {}) {
    const grant = setupGrant
      ? this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, consumeUse: true, at })
      : this.selectSetupGrantForRecovery({ workspaceId, teamId, grantId });
    return this.revokeSetupGrantAndCredentials(grant, { reason, at });
  }

  recoverSetupGrant({
    workspaceId,
    teamId,
    domainId = null,
    reason,
    auditActor,
    auditNote,
    at = this.isoNow(),
  } = {}) {
    requireString(reason, "reason");
    requireString(auditActor, "auditActor");
    requireString(auditNote, "auditNote");
    const superseded = this.setupGrants.filter(
      (grant) =>
        grant.workspace_id === workspaceId &&
        grant.team_id === teamId &&
        ["provisional", "confirmed"].includes(grant.status),
    );
    for (const grant of superseded) {
      grant.status = "superseded";
      grant.revoked_at = at;
      grant.revoked_reason = `break_glass_recover:${reason}:${auditActor}:${auditNote}`;
      this.revokeCredentialsForGrant(grant, { at });
      this.deactivateWebhookSecretsForGrant(grant, { at });
    }
    const issued = this.requestSetupGrant({
      workspaceId,
      teamId,
      domainId,
      createdBy: `break_glass:${auditActor}`,
      at,
      bypassActiveConflict: true,
    });
    return { ...issued, superseded: superseded.map((grant) => redactSetupGrant(grant)) };
  }

  authenticateSetupGrant({
    setupGrant,
    workspaceId,
    teamId = null,
    consumeUse = false,
    allowExpired = false,
    steadyState = false,
    at = this.isoNow(),
  } = {}) {
    requireString(workspaceId, "workspaceId");
    // teamId is derived from the grant; validate only if the caller supplied it (parity with
    // the hosted requireSetupGrant, which derives team from the authenticated grant token so
    // a setup caller that omits teamId is not rejected).
    const parsed = parseSetupGrantToken(setupGrant);
    if (!parsed) throw new Error("invalid setup grant");
    const grant = this.setupGrants.find((candidate) => candidate.grant_id === parsed.grantId);
    if (!grant || !timingSafeEqualHex(sha256Hex(parsed.secret), grant.secret_hash)) {
      throw new Error("invalid setup grant");
    }
    // Mirror of requireSetupGrant: the broker-credential route (steadyState) gates on
    // github_repo_verified_at (below), not Linear-webhook confirmation — init mints the
    // initial broker credential from a github-verified PROVISIONAL grant before any Linear
    // delivery confirms it (deferred confirmation; provisional grants expire in 7 days).
    const allowedStatuses = steadyState
      ? ["provisional", "confirmed"]
      : allowExpired ? ["provisional", "confirmed", "expired"] : ["provisional", "confirmed"];
    if (!allowedStatuses.includes(grant.status)) throw new Error("setup grant is not active");
    if (grant.workspace_id !== workspaceId) throw new Error("setup_grant_scope_mismatch");
    if (teamId != null && grant.team_id !== teamId) throw new Error("setup_grant_scope_mismatch");
    if (steadyState && !optionalString(grant.github_repo_verified_at)) {
      throw new Error("github_repo_not_verified");
    }
    // Bounded relaxation (mirror of requireSetupGrant): a github-verified provisional grant
    // may mint only within its confirmation window — never indefinitely past it.
    if (steadyState && grant.status === "provisional" && Date.parse(grant.confirmation_expires_at) <= Date.parse(at)) {
      throw new Error("setup grant is not active");
    }
    if (steadyState) return grant;
    if (Date.parse(grant.expires_at) <= Date.parse(at)) {
      // Mutation window lapsed. A grant that never bound a webhook is an abandoned setup —
      // expire it so the team slot frees. A BOUND provisional grant must stay confirmable
      // until the 7-day window (deferred confirmation can take days), so we never expire it
      // here; we only refuse further MUTATIONS (consumeUse calls). A status poll past the
      // mutation window must therefore leave a bound grant untouched and still provisional.
      if (grant.status === "provisional" && !grant.webhook_id) {
        grant.status = "expired";
        grant.revoked_at = at;
        grant.revoked_reason = "setup grant mutation window expired";
      }
      if (consumeUse) throw new Error("setup grant mutation window expired");
      if (grant.status === "expired" && !allowExpired) throw new Error("setup grant expired");
    }
    if (consumeUse) {
      if (grant.uses_remaining <= 0) throw new Error("setup grant uses exhausted");
      grant.uses_remaining -= 1;
      grant.last_used_at = at;
    }
    return grant;
  }

  expireConflictingProvisionalGrants({ workspaceId, teamId, at = this.isoNow() } = {}) {
    for (const grant of this.setupGrants) {
      if (grant.workspace_id !== workspaceId || grant.team_id !== teamId) continue;
      if (grant.status !== "provisional") continue;
      // A provisional grant stays active until its CONFIRMATION window (days), not the
      // short mutation window (minutes). Deferred confirmation waits for the team's first
      // Planned delivery, which can be days out, so a bound grant must remain confirmable
      // (and must keep blocking re-issuance) past the mutation window. Expire only when
      // (a) the confirmation window itself has lapsed, or (b) setup was abandoned before a
      // webhook was bound and the mutation window has lapsed (frees the slot for re-init).
      const confirmationLapsed = Date.parse(grant.confirmation_expires_at) <= Date.parse(at);
      const abandonedUnbound = !grant.webhook_id && Date.parse(grant.expires_at) <= Date.parse(at);
      if (confirmationLapsed) {
        grant.status = "expired";
        grant.revoked_at = at;
        grant.revoked_reason = "setup grant confirmation window expired";
      } else if (abandonedUnbound) {
        grant.status = "expired";
        grant.revoked_at = at;
        grant.revoked_reason = "setup grant mutation window expired";
      }
    }
  }

  upsertLinearWebhookSecret({
    workspaceId,
    teamId = null,
    webhookId = null,
    webhookUrl = null,
    signingSecret,
    active = true,
    rotatedAt = this.isoNow(),
    setupGrant = null,
  } = {}) {
    requireString(signingSecret, "signingSecret");
    let grant = null;
    if (setupGrant) {
      grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, consumeUse: true, at: rotatedAt });
      if (grant.webhook_id && grant.webhook_id !== webhookId) throw new Error("setup_grant_webhook_mismatch");
    } else {
      requireString(workspaceId, "workspaceId");
    }
    const existing = this.webhookSecrets.find(
      (secret) => secret.workspace_id === (grant?.workspace_id || workspaceId) && secret.webhook_id === webhookId,
    );
    if (grant && existing && existing.setup_grant_id !== grant.grant_id) {
      // A grant may only (re)bind a webhook id that is unbound or already its own. This stops
      // one team's grant from clobbering another team's stored secret/binding by reusing its
      // webhook id (records key on (workspace_id, webhook_id)).
      throw new Error("webhook_id_bound_to_other_team");
    }
    if (grant) {
      grant.webhook_id = webhookId;
      grant.last_used_at = rotatedAt;
    }
    const record = {
      id: existing?.id || this.idGenerator("webhook_secret"),
      workspace_id: grant?.workspace_id || workspaceId,
      webhook_id: webhookId,
      team_id: grant?.team_id || optionalString(teamId),
      setup_grant_id: grant?.grant_id || null,
      confirmation_state: grant ? "provisional" : "confirmed",
      webhook_url: webhookUrl,
      signing_secret: signingSecret,
      active,
      rotated_at: rotatedAt,
    };
    if (existing) Object.assign(existing, record);
    else this.webhookSecrets.push(record);
    return redactSecretRecord(record);
  }

  deleteLinearWebhookSecret({ workspaceId, teamId = null, webhookId = null, setupGrant = null, at = this.isoNow() } = {}) {
    let grant = null;
    if (setupGrant) {
      grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, consumeUse: true, at });
      webhookId = webhookId || grant.webhook_id;
      if (!webhookId) throw new Error("setup_grant_webhook_required");
      if (grant.webhook_id && webhookId !== grant.webhook_id) throw new Error("setup_grant_webhook_mismatch");
      workspaceId = grant.workspace_id;
    }
    const before = this.webhookSecrets.length;
    this.webhookSecrets = this.webhookSecrets.filter(
      (secret) =>
        !(
          secret.workspace_id === workspaceId &&
          (!webhookId || secret.webhook_id === webhookId) &&
          (!grant || secret.setup_grant_id === grant.grant_id)
        ),
    );
    return { deleted: before - this.webhookSecrets.length };
  }

  verifyLinearWebhookSignature({ workspaceId, rawBody, signature } = {}) {
    const secrets = this.webhookSecrets.filter(
      (secret) => secret.workspace_id === workspaceId && secret.active,
    );
    for (const secret of secrets) {
      if (verifyHmacSignature({ rawBody, signature, secret: secret.signing_secret })) {
        return {
          ok: true,
          secretId: secret.id,
          webhookId: secret.webhook_id,
          teamId: optionalString(secret.team_id),
        };
      }
    }
    return { ok: false, reason: secrets.length === 0 ? "missing_signing_secret" : "signature_mismatch" };
  }

  recordWebhookDelivery({
    provider,
    workspaceId,
    deliveryId,
    webhookId = null,
    webhookSecretId = null,
    signatureValid,
    rawHeaders = {},
    rawBody,
    receivedAt = this.isoNow(),
  } = {}) {
    requireString(provider, "provider");
    requireString(workspaceId, "workspaceId");
    requireString(deliveryId, "deliveryId");
    const existing = this.webhookDeliveries.find(
      (delivery) =>
        delivery.provider === provider &&
        delivery.workspace_id === workspaceId &&
        delivery.delivery_id === deliveryId,
    );
    if (existing) return { duplicate: true, delivery: existing };
    // Data minimization: the inbox stores no product content. Bodies are
    // verified in memory; only a hash and an allowlisted header subset persist.
    const delivery = {
      id: this.idGenerator("delivery"),
      provider,
      workspace_id: workspaceId,
      delivery_id: deliveryId,
      webhook_id: webhookId,
      webhook_secret_id: webhookSecretId,
      signature_valid: Boolean(signatureValid),
      received_at: receivedAt,
      raw_headers: allowlistedHeaders(rawHeaders),
      raw_body: null,
      raw_body_sha256: sha256Hex(rawBody),
      dedupe_key: `${provider}:${workspaceId}:${deliveryId}`,
      retention_expires_at: plusMsIso(receivedAt, this.rawPayloadRetentionMs),
    };
    if (provider === "linear") {
      this.confirmSetupGrantForDelivery({
        webhookSecretId,
        workspaceId,
        deliveryId,
        rawBody,
        at: receivedAt,
      });
    }
    this.webhookDeliveries.push(delivery);
    return { duplicate: false, delivery };
  }

  confirmSetupGrantForDelivery({ webhookSecretId, workspaceId, deliveryId, rawBody, at = this.isoNow() } = {}) {
    const secret = this.webhookSecrets.find((candidate) => candidate.id === webhookSecretId);
    if (!secret || secret.confirmation_state !== "provisional") return null;
    if (!secret.setup_grant_id) throw new Error("setup grant confirmation missing");
    const grant = this.setupGrants.find(
      (candidate) => candidate.grant_id === secret.setup_grant_id && candidate.status === "provisional",
    );
    if (!grant) throw new Error("setup grant confirmation unavailable");
    if (Date.parse(grant.confirmation_expires_at) <= Date.parse(at)) {
      grant.status = "expired";
      grant.revoked_at = at;
      grant.revoked_reason = "setup grant confirmation window expired";
      throw new Error("setup grant confirmation expired");
    }
    const payload = JSON.parse(rawBody || "{}");
    const payloadTeamIds = sortedStrings(payload?.data?.teamIds);
    if (
      payload?.organizationId !== grant.workspace_id ||
      !payloadTeamIds.includes(grant.team_id) ||
      secret.webhook_id !== grant.webhook_id ||
      secret.team_id !== grant.team_id
    ) {
      throw new Error("setup grant confirmation scope mismatch");
    }
    grant.status = "confirmed";
    grant.confirmed_at = at;
    grant.confirmation_delivery_id = deliveryId;
    grant.last_used_at = at;
    secret.confirmation_state = "confirmed";
    return grant;
  }

  mintRunnerCredential({
    setupGrant,
    workspaceId,
    teamId,
    runnerName = "local-runner",
    capabilities = ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds = [],
    domainId = null,
    at = this.isoNow(),
  } = {}) {
    const grant = this.authenticateSetupGrant({ setupGrant, workspaceId, teamId, consumeUse: true, at });
    if (!grant.webhook_id) throw new Error("setup_grant_webhook_required");
    assertGrantScopeRequest({
      requestedTeamId: teamId,
      requestedDomainId: domainId,
      requestedWebhookIds: webhookIds,
      grant,
    });
    const token = `ri_${setupGrantSecret()}`;
    const credential = {
      id: this.idGenerator("runner_credential_row"),
      workspace_id: grant.workspace_id,
      credential_id: this.idGenerator("runner_credential"),
      token_hash: sha256Hex(token),
      runner_name: runnerName,
      capabilities: sortedStrings(capabilities),
      team_id: grant.team_id,
      webhook_ids: [grant.webhook_id],
      domain_id: grant.domain_id,
      active: true,
      created_at: at,
      revoked_at: null,
    };
    this.runnerCredentials.push(credential);
    return {
      credentialId: credential.credential_id,
      token,
      endpoint: "/v1/runner",
      capabilities: credential.capabilities,
      team_id: credential.team_id,
      webhook_ids: credential.webhook_ids,
      domain_id: credential.domain_id,
      createdAt: credential.created_at,
    };
  }

  verifyRunnerCredential({ workspaceId = null, credentialId, token } = {}) {
    const credential = this.runnerCredentials.find(
      (candidate) =>
        candidate.credential_id === credentialId &&
        candidate.active &&
        (!workspaceId || candidate.workspace_id === workspaceId),
    );
    if (!credential) return null;
    return timingSafeEqualHex(sha256Hex(token), credential.token_hash) ? credential : null;
  }

  selectSetupGrantForRecovery({ workspaceId, teamId, grantId = null } = {}) {
    if (grantId) {
      const grant = this.setupGrants.find((candidate) => candidate.grant_id === grantId);
      if (!grant) throw new Error("setup grant not found");
      return grant;
    }
    const grant = this.setupGrants.find(
      (candidate) =>
        candidate.workspace_id === workspaceId &&
        candidate.team_id === teamId &&
        ["provisional", "confirmed"].includes(candidate.status),
    );
    if (!grant) throw new Error("setup grant not found");
    return grant;
  }

  revokeSetupGrantAndCredentials(grant, { reason, at = this.isoNow() } = {}) {
    grant.status = "revoked";
    grant.revoked_at = at;
    grant.revoked_reason = reason;
    const revokedCredentials = this.revokeCredentialsForGrant(grant, { at });
    const revokedWebhookSecrets = this.deactivateWebhookSecretsForGrant(grant, { at });
    return {
      ok: true,
      grant: redactSetupGrant(grant),
      revokedCredentials,
      revokedWebhookSecrets,
    };
  }

  revokeCredentialsForGrant(grant, { at = this.isoNow() } = {}) {
    if (!grant.webhook_id) return 0;
    let count = 0;
    for (const credential of this.runnerCredentials) {
      if (!credential.active) continue;
      if (credential.workspace_id !== grant.workspace_id) continue;
      if (credential.team_id !== grant.team_id) continue;
      if (grant.domain_id && credential.domain_id !== grant.domain_id) continue;
      if (!sortedStrings(credential.webhook_ids).includes(grant.webhook_id)) continue;
      credential.active = false;
      credential.revoked_at = at;
      count += 1;
    }
    return count;
  }

  deactivateWebhookSecretsForGrant(grant, { at = this.isoNow() } = {}) {
    let count = 0;
    for (const secret of this.webhookSecrets) {
      if (secret.setup_grant_id !== grant.grant_id) continue;
      if (!secret.active) continue;
      secret.active = false;
      secret.updated_at = at;
      count += 1;
    }
    return count;
  }

  recordTriggerEvent(event) {
    requireString(event?.provider, "event.provider");
    requireString(event?.workspace_id, "event.workspace_id");
    requireString(event?.event_id, "event.event_id");
    const existing = this.triggerEvents.find(
      (candidate) =>
        candidate.provider === event.provider &&
        candidate.workspace_id === event.workspace_id &&
        candidate.event_id === event.event_id,
    );
    if (existing) return { duplicate: true, event: existing };
    const record = {
      id: this.idGenerator("event"),
      schema_version: event.schema_version || 1,
      provider: event.provider,
      workspace_id: event.workspace_id,
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at || this.isoNow(),
      received_at: event.received_at || this.isoNow(),
      actor: event.actor || null,
      object: event.object,
      changed_fields: event.changed_fields || [],
      webhook_id: event.webhook_id || null,
      team_ids: sortedStrings(event.team_ids),
      raw_event_ref: event.raw_event_ref || null,
      requires_runner_verification: event.requires_runner_verification !== false,
      // Derive the routing fact from a legacy raw_payload event shape before
      // discarding the payload, so direct store callers keep correct routing.
      project_status_type:
        event.project_status_type
        || projectStatusTypeFromPayload(event.raw_payload?.data)
        || null,
    };
    this.triggerEvents.push(record);
    return { duplicate: false, event: record };
  }

  enqueueWake({
    workspaceId,
    triggerType,
    workflowType,
    objectType,
    objectId,
    wakeKey,
    sourceEventId,
    requiresRunnerVerification = true,
    reason = null,
    webhookIds = [],
    teamIds = [],
    routingScopeTeamId = null,
    domainId = null,
    routingErrorReason = null,
    routingCandidates = null,
    createdAt = this.isoNow(),
  } = {}) {
    requireString(workspaceId, "workspaceId");
    requireString(wakeKey, "wakeKey");
    const scopedWakeKey = scopedWakeKeyForTrustedTeam(wakeKey, routingScopeTeamId);
    const existing = this.workflowWakeups.find(
      (wake) =>
        wake.workspace_id === workspaceId &&
        wake.wake_key === scopedWakeKey &&
        ACTIVE_WAKE_STATUSES.has(wake.status),
    );
    if (existing && ACTIVE_WAKE_STATUSES.has(existing.status)) {
      existing.webhook_ids = unionSortedStrings(existing.webhook_ids, webhookIds);
      existing.team_ids = unionSortedStrings(existing.team_ids, teamIds);
      return { duplicate: true, wake: existing };
    }
    const wake = {
      id: this.idGenerator("wake"),
      workspace_id: workspaceId,
      trigger_type: triggerType,
      workflow_type: workflowType,
      object_type: objectType,
      object_id: objectId,
      wake_key: scopedWakeKey,
      status: "queued",
      reason,
      source_event_id: sourceEventId,
      requires_runner_verification: requiresRunnerVerification,
      webhook_ids: sortedStrings(webhookIds),
      team_ids: sortedStrings(teamIds),
      domain_id: domainId,
      routing_error_reason: routingErrorReason,
      routing_candidates: routingCandidates,
      created_at: createdAt,
      claimed_at: null,
      runner_id: null,
      lease_token: null,
      lease_expires_at: null,
      started_at: null,
      mutation_started_at: null,
      attempt_count: 0,
      terminal_at: null,
      run_id: null,
      last_claim_rejection_reason: null,
    };
    this.workflowWakeups.push(wake);
    return { duplicate: false, wake };
  }

  heartbeat({
    runnerId,
    workspaceId,
    version,
    capabilities = [],
    storedCapabilities = null,
    currentWakeId = null,
    at = this.isoNow(),
  } = {}) {
    requireString(runnerId, "runnerId");
    requireString(workspaceId, "workspaceId");
    const heartbeat = {
      runner_id: runnerId,
      workspace_id: workspaceId,
      version: version || null,
      // Effective capabilities (stored ∩ presented when a credential scope is
      // supplied) so the derived status signal cannot be inflated by self-attestation.
      capabilities: effectiveClaimCapabilities({ storedCapabilities, presentedCapabilities: capabilities }),
      last_seen_at: at,
      current_wake_id: currentWakeId,
    };
    this.runnerHeartbeats.set(runnerId, heartbeat);
    return heartbeat;
  }

  claimNextWake({
    wakeId = null,
    workspaceId,
    runnerId,
    version = null,
    capabilities = [],
    storedCapabilities = null,
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
    webhookIds = [],
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    at = this.isoNow(),
  } = {}) {
    requireString(workspaceId, "workspaceId");
    requireString(runnerId, "runnerId");
    this.expireLeases({ workspaceId, at });
    this.heartbeat({ runnerId, workspaceId, version, capabilities, storedCapabilities, at });
    const claimCapabilities = effectiveClaimCapabilities({ storedCapabilities, presentedCapabilities: capabilities });
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(scope, webhookIds);
    if (storedWebhookScopeActive(scope) && effectiveWebhookIds.length === 0) {
      return { ok: false, reason: "no_queued_wake" };
    }
    const candidate = this.workflowWakeups.find(
      (wake) =>
        wake.workspace_id === workspaceId &&
        wake.status === "queued" &&
        (!wakeId || wake.id === wakeId) &&
        wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds),
    );
    if (!candidate) return { ok: false, reason: "no_queued_wake" };
    const missing = missingCapabilities(candidate.workflow_type, claimCapabilities);
    if (missing.length > 0) {
      candidate.last_claim_rejection_reason = `missing_capabilities:${missing.join(",")}`;
      return { ok: false, reason: "capability_mismatch", wake: redactedWake(candidate), missingCapabilities: missing };
    }
    return this.claimWake({
      wakeId: candidate.id,
      workspaceId,
      runnerId,
      version,
      capabilities,
      storedCapabilities,
      storedWebhookIds,
      storedTeamId,
      storedDomainId,
      credentialScope,
      webhookIds,
      leaseDurationMs,
      at,
    });
  }

  claimWake({
    wakeId,
    workspaceId,
    runnerId,
    version = null,
    capabilities = [],
    storedCapabilities = null,
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
    webhookIds = [],
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    at = this.isoNow(),
  } = {}) {
    if (workspaceId) this.expireLeases({ workspaceId, at });
    const wake = this.getRawWake(wakeId);
    if (!wake || wake.workspace_id !== workspaceId) return { ok: false, reason: "wake_not_found" };
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(scope, webhookIds);
    if (!wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds)) return { ok: false, reason: "no_queued_wake" };
    if (wake.status !== "queued") return { ok: false, reason: `wake_not_queued:${wake.status}`, wake: redactedWake(wake) };
    const claimCapabilities = effectiveClaimCapabilities({ storedCapabilities, presentedCapabilities: capabilities });
    const missing = missingCapabilities(wake.workflow_type, claimCapabilities);
    if (missing.length > 0) {
      wake.last_claim_rejection_reason = `missing_capabilities:${missing.join(",")}`;
      return { ok: false, reason: "capability_mismatch", wake: redactedWake(wake), missingCapabilities: missing };
    }
    const leaseToken = this.idGenerator("lease");
    Object.assign(wake, {
      status: "leased",
      claimed_at: at,
      runner_id: runnerId,
      lease_token: leaseToken,
      lease_expires_at: plusMsIso(at, leaseDurationMs),
      attempt_count: wake.attempt_count + 1,
      last_claim_rejection_reason: null,
    });
    this.heartbeat({ runnerId, workspaceId, version, capabilities, storedCapabilities, currentWakeId: wake.id, at });
    return { ok: true, wake, leaseToken };
  }

  renewLease({
    wakeId,
    runnerId,
    leaseToken,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    wake.lease_expires_at = plusMsIso(at, leaseDurationMs);
    return { ok: true, wake };
  }

  markWakeRunning({
    wakeId,
    runnerId,
    leaseToken,
    runId,
    domainId = null,
    at = this.isoNow(),
    artifactPointer = null,
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake };
    if (!isNonEmptyString(domainId)) {
      return { ok: false, reason: "missing_domain_id", wake };
    }
    if (scope.storedDomainId && scope.storedDomainId !== domainId) {
      // A credential scoped to one domain may not label a wake with another domain. (Team
      // and webhook isolation is enforced by assertLeaseToken; this closes the domain axis.)
      return { ok: false, reason: "domain_outside_credential_scope", wake };
    }
    wake.status = "running";
    wake.started_at = at;
    wake.run_id = runId;
    wake.domain_id = domainId;
    this.workflowRuns.push({
      run_id: runId,
      workspace_id: wake.workspace_id,
      workflow_type: wake.workflow_type,
      wake_id: wake.id,
      object_id: wake.object_id,
      status: "running",
      started_at: at,
      terminal_at: null,
      terminal_reason: null,
      artifact_pointer: artifactPointer,
      provider_update_ids: [],
    });
    return { ok: true, wake };
  }

  releaseWake({
    wakeId,
    runnerId,
    leaseToken,
    reason = "domain_not_served",
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake };
    if (reason !== "domain_not_served") return { ok: false, reason: `invalid_release_reason:${reason}`, wake };
    Object.assign(wake, {
      status: "queued",
      claimed_at: null,
      runner_id: null,
      lease_token: null,
      lease_expires_at: null,
      started_at: null,
      run_id: null,
    });
    return { ok: true, wakeId: wake.id, status: "queued", attemptCount: wake.attempt_count };
  }

  markWakeRoutingError({
    wakeId,
    runnerId,
    leaseToken,
    reason,
    candidates = [],
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    if (wake.status !== "leased") return { ok: false, reason: `wake_not_leased:${wake.status}`, wake };
    if (!ROUTING_ERROR_REASONS.has(reason)) return { ok: false, reason: `invalid_routing_error_reason:${reason}`, wake };
    const normalizedCandidates = normalizeRoutingCandidates(candidates);
    if (!normalizedCandidates.ok) return { ok: false, reason: "invalid_candidates", wake };
    Object.assign(wake, {
      status: "routing_error",
      routing_error_reason: reason,
      routing_candidates: normalizedCandidates.candidates,
      claimed_at: null,
      runner_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
    return { ok: true, wakeId: wake.id, status: "routing_error" };
  }

  requeueWake({
    workspaceId,
    wakeId,
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(scope, webhookIds);
    if (!wake || wake.workspace_id !== workspaceId || !wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds)) {
      return { ok: false, reason: "wake_not_found" };
    }
    if (wake.status !== "routing_error") {
      return { ok: false, reason: `wake_not_routing_error:${wake.status}`, wake: redactedWake(wake) };
    }
    Object.assign(wake, {
      status: "queued",
      routing_error_reason: null,
      routing_candidates: null,
      domain_id: null,
    });
    return { ok: true, wakeId: wake.id, status: "queued" };
  }

  markMutationStarted({
    wakeId,
    runnerId,
    leaseToken,
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    wake.mutation_started_at = at;
    return { ok: true, wake };
  }

  completeWake({
    wakeId,
    runnerId,
    leaseToken,
    status,
    reason = null,
    providerUpdateIds = [],
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    if (!TERMINAL_WAKE_STATUSES.has(status)) {
      throw new Error(`Invalid terminal wake status: ${status}`);
    }
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    wake.status = status;
    wake.reason = reason;
    wake.terminal_at = at;
    wake.lease_expires_at = null;
    wake.lease_token = null;
    const run = this.workflowRuns.find((candidate) => candidate.wake_id === wake.id && candidate.run_id === wake.run_id);
    if (run) {
      run.status = status;
      run.terminal_at = at;
      run.terminal_reason = reason;
      run.provider_update_ids = providerUpdateIds;
    }
    return { ok: true, wake, run };
  }

  deadLetterWake({
    wakeId,
    runnerId = null,
    leaseToken = null,
    reason,
    at = this.isoNow(),
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const token = this.assertLeaseToken(wake, runnerId, leaseToken, { at, webhookIds, credentialScope: scope });
    if (!token.ok) return token;
    if (wake.status === "routing_error") {
      return { ok: false, reason: "wake_not_dead_letterable:routing_error", wake: redactedWake(wake) };
    }
    return this.#deadLetterWakeWithoutLease(wake, { reason, at });
  }

  #deadLetterWakeWithoutLease(wake, { reason, at = this.isoNow() } = {}) {
    wake.status = "dead_letter";
    wake.reason = reason || "dead_letter";
    wake.terminal_at = at;
    wake.lease_expires_at = null;
    wake.lease_token = null;
    this.deadLetters.push({ wake_id: wake.id, reason: wake.reason, created_at: at });
    const run = this.workflowRuns.find((candidate) => candidate.wake_id === wake.id && candidate.run_id === wake.run_id);
    if (run) {
      run.status = "dead_letter";
      run.terminal_at = at;
      run.terminal_reason = wake.reason;
    }
    return { ok: true, wake };
  }

  expireLeases({ workspaceId = null, at = this.isoNow() } = {}) {
    const expired = [];
    for (const wake of this.workflowWakeups) {
      if (workspaceId && wake.workspace_id !== workspaceId) continue;
      if (!["leased", "running"].includes(wake.status)) continue;
      if (!wake.lease_expires_at || Date.parse(wake.lease_expires_at) > Date.parse(at)) continue;
      if (wake.mutation_started_at) {
        this.#deadLetterWakeWithoutLease(wake, {
          reason: `runner_lost_after_linear_mutation_started:${wake.runner_id}`,
          at,
        });
      } else {
        Object.assign(wake, {
          status: "queued",
          claimed_at: null,
          runner_id: null,
          lease_token: null,
          lease_expires_at: null,
          started_at: null,
          run_id: null,
        });
      }
      expired.push(wake);
    }
    return expired;
  }

  pruneExpiredDeliveries({ at = this.isoNow() } = {}) {
    const before = this.webhookDeliveries.length;
    this.webhookDeliveries = this.webhookDeliveries.filter(
      (delivery) =>
        !delivery.retention_expires_at || Date.parse(delivery.retention_expires_at) > Date.parse(at),
    );
    return { pruned: before - this.webhookDeliveries.length };
  }

  runMaintenance({ at = this.isoNow() } = {}) {
    const expiredGrants = this.expireDueSetupGrants({ at });
    const expiredLeases = this.expireLeases({ at }).length;
    const pruned = this.pruneExpired({ at });
    return { ok: true, expiredGrants, expiredLeases, pruned };
  }

  expireDueSetupGrants({ at = this.isoNow() } = {}) {
    let expired = 0;
    for (const grant of this.setupGrants) {
      if (grant.status !== "provisional") continue;
      if (!timestampAtOrBefore(grant.confirmation_expires_at, at)) continue;
      grant.status = "expired";
      grant.revoked_at = at;
      grant.revoked_reason = "setup grant confirmation window expired";
      expired += 1;
    }
    return expired;
  }

  pruneExpired({ at = this.isoNow() } = {}) {
    const workflowRunCutoff = plusMsIso(at, -RETENTION_MS.workflowRuns);
    const workflowRuns = pruneRows(this.workflowRuns, (run) =>
      TERMINAL_WAKE_STATUSES.has(run.status) &&
      timestampAtOrBefore(run.terminal_at || run.started_at, workflowRunCutoff)
    );
    this.workflowRuns = workflowRuns.rows;

    const deadLetterCutoff = plusMsIso(at, -RETENTION_MS.deadLetters);
    const deadLetters = pruneRows(this.deadLetters, (letter) =>
      timestampAtOrBefore(letter.created_at, deadLetterCutoff)
    );
    this.deadLetters = deadLetters.rows;

    const wakeCutoff = plusMsIso(at, -RETENTION_MS.terminalWakes);
    const workflowWakeups = pruneRows(this.workflowWakeups, (wake) =>
      TERMINAL_WAKE_STATUSES.has(wake.status) &&
      timestampAtOrBefore(wake.terminal_at || wake.updated_at || wake.created_at, wakeCutoff)
    );
    this.workflowWakeups = workflowWakeups.rows;

    const triggerEventCutoff = plusMsIso(at, -RETENTION_MS.triggerEvents);
    const triggerEvents = pruneRows(this.triggerEvents, (event) =>
      timestampAtOrBefore(event.received_at || event.created_at, triggerEventCutoff)
    );
    this.triggerEvents = triggerEvents.rows;

    const webhookDeliveries = this.pruneExpiredDeliveries({ at }).pruned;

    const setupGrantCutoff = plusMsIso(at, -RETENTION_MS.inactiveSetupGrants);
    const setupGrants = pruneRows(this.setupGrants, (grant) =>
      ["revoked", "expired", "superseded"].includes(grant.status) &&
      timestampAtOrBefore(grant.revoked_at || grant.created_at, setupGrantCutoff)
    );
    this.setupGrants = setupGrants.rows;

    const runnerCredentialCutoff = plusMsIso(at, -RETENTION_MS.inactiveRunnerCredentials);
    const runnerCredentials = pruneRows(this.runnerCredentials, (credential) =>
      credential.active === false &&
      timestampAtOrBefore(credential.revoked_at || credential.created_at, runnerCredentialCutoff)
    );
    this.runnerCredentials = runnerCredentials.rows;

    return {
      workflowWakeups: workflowWakeups.pruned,
      triggerEvents: triggerEvents.pruned,
      webhookDeliveries,
      workflowRuns: workflowRuns.pruned,
      deadLetters: deadLetters.pruned,
      setupGrants: setupGrants.pruned,
      runnerCredentials: runnerCredentials.pruned,
    };
  }

  getWake(wakeId, {
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    const wake = this.getRawWake(wakeId);
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(scope, webhookIds);
    return wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds) ? redactedWake(wake) : null;
  }

  getRawWake(wakeId) {
    return this.workflowWakeups.find((wake) => wake.id === wakeId) || null;
  }

  listWakeViews({
    workspaceId,
    at = this.isoNow(),
    heartbeatStaleMs = this.heartbeatStaleMs,
    webhookIds = [],
    storedWebhookIds = [],
    storedTeamId = null,
    storedDomainId = null,
    credentialScope = null,
  } = {}) {
    this.expireLeases({ workspaceId, at });
    const scope = runnerCredentialScope({ credentialScope, storedWebhookIds, storedTeamId, storedDomainId });
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(scope, webhookIds);
    return this.workflowWakeups
      .filter((wake) => !workspaceId || wake.workspace_id === workspaceId)
      .filter((wake) => wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds))
      .map((wake) => ({
        ...redactedWake(wake),
        derived_status: this.derivedWakeStatus({ wake, at, heartbeatStaleMs }),
      }));
  }

  derivedWakeStatus({ wake, at = this.isoNow(), heartbeatStaleMs = this.heartbeatStaleMs } = {}) {
    if (wake.status !== "queued") return wake.status;
    const heartbeat = this.freshRunnerForWake({ wake, at, heartbeatStaleMs });
    return heartbeat ? "queued" : "waiting_for_runner";
  }

  freshRunnerForWake({ wake, at = this.isoNow(), heartbeatStaleMs = this.heartbeatStaleMs } = {}) {
    const required = requiredCapabilitiesForWorkflow(wake.workflow_type);
    return [...this.runnerHeartbeats.values()].find((heartbeat) => {
      if (heartbeat.workspace_id !== wake.workspace_id) return false;
      if (Date.parse(at) - Date.parse(heartbeat.last_seen_at) > heartbeatStaleMs) return false;
      const runnerCapabilities = new Set(heartbeat.capabilities || []);
      return required.every((capability) => runnerCapabilities.has(capability));
    }) || null;
  }

  assertLeaseToken(wake, runnerId, leaseToken, {
    at = this.isoNow(),
    webhookIds = [],
    credentialScope = unscopedRunnerCredentialScope(),
  } = {}) {
    if (!wake) return { ok: false, reason: "wake_not_found" };
    const effectiveWebhookIds = effectiveWebhookIdsForCredentialScope(credentialScope, webhookIds);
    if (!wakeMatchesCredentialScope(wake, credentialScope, effectiveWebhookIds)) {
      return { ok: false, reason: "wake_not_found" };
    }
    if (runnerId !== undefined && runnerId !== null && wake.runner_id !== runnerId) {
      return { ok: false, reason: "runner_mismatch", wake };
    }
    if (!leaseToken || wake.lease_token !== leaseToken) {
      return { ok: false, reason: "lease_token_mismatch", wake };
    }
    if (wake.lease_expires_at && Date.parse(wake.lease_expires_at) <= Date.parse(at)) {
      return { ok: false, reason: "lease_expired", wake };
    }
    return { ok: true, wake };
  }

  isoNow() {
    const value = this.now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}

export function createMemoryInboxStore(options = {}) {
  return new MemoryInboxStore(options);
}

export function createFakeGitHubOAuthClient({
  codeToAccessToken = {},
  tokenToRepoPermissions = {},
  repoInstallations = null,
  failures = {},
} = {}) {
  const calls = [];
  const client = {
    calls,
    async exchangeOAuthCodeForToken({ code } = {}) {
      calls.push({ type: "exchangeOAuthCodeForToken" });
      if (failures.exchangeOAuthCodeForToken) throw failureToError(failures.exchangeOAuthCodeForToken);
      const accessToken = mapLookup(codeToAccessToken, code);
      return accessToken ? { ok: true, accessToken } : { ok: false };
    },
    async getRepoPermissions({ accessToken, owner, repo } = {}) {
      calls.push({ type: "getRepoPermissions", owner, repo });
      if (failures.getRepoPermissions) throw failureToError(failures.getRepoPermissions);
      const permissions = repoPermissionsLookup(tokenToRepoPermissions, { accessToken, owner, repo }) || {};
      if (permissions?.ok === false) return permissions;
      return {
        ok: true,
        permissions,
      };
    },
  };
  if (repoInstallations) {
    client.getRepoInstallation = async ({ owner, repo } = {}) => {
      calls.push({ type: "getRepoInstallation", owner, repo });
      if (failures.getRepoInstallation) throw failureToError(failures.getRepoInstallation);
      const repoKey = `${owner}/${repo}`;
      const installation = mapLookup(repoInstallations, repoKey) || mapLookup(repoInstallations, repoKey.toLowerCase());
      if (installation?.ok === false) return installation;
      if (!installation) return { ok: false, status: 404, reason: "github_app_not_installed" };
      if (typeof installation === "string") return { ok: true, installation: { id: installation } };
      return { ok: true, installation };
    };
  }
  return client;
}

export function normalizeProjectStatusType(status) {
  if (!status) return null;
  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    return ["planned", "backlog", "started", "completed", "canceled", "cancelled"].includes(normalized)
      ? normalized
      : null;
  }
  if (typeof status !== "object") return null;
  const value = status.type || status.name;
  return typeof value === "string" ? normalizeProjectStatusType(value) : null;
}

export function projectStatusTypeFromPayload(data = {}) {
  return normalizeProjectStatusType(data?.status || data?.projectStatus || data?.workflowStatus || data?.state);
}

const PERSISTED_HEADER_ALLOWLIST = ["linear-delivery", "linear-signature", "content-type", "user-agent"];

function allowlistedHeaders(rawHeaders = {}) {
  const normalized = Object.fromEntries(
    Object.entries(rawHeaders || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const persisted = {};
  for (const key of PERSISTED_HEADER_ALLOWLIST) {
    if (normalized[key]) persisted[key] = normalized[key];
  }
  return persisted;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value || "").digest("hex");
}

function setupGrantPublicId() {
  return `sg${crypto.randomUUID().replaceAll("-", "")}`;
}

function setupGrantSecret() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function parseSetupGrantToken(token) {
  if (typeof token !== "string") return null;
  const match = token.match(/^af_setup_v1_([^_]+)_([^_]+)$/);
  return match ? { grantId: match[1], secret: match[2] } : null;
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function nextBrokerCredentialRemintWindow(grant, issuedAt) {
  const currentWindowStartedAt = optionalString(grant.github_broker_remint_window_started_at);
  const currentCountValue = Number(grant.github_broker_remint_count);
  const currentCount = Number.isFinite(currentCountValue) && currentCountValue > 0 ? currentCountValue : 0;
  const issuedAtMs = Date.parse(issuedAt);
  const windowStartedAtMs = currentWindowStartedAt ? Date.parse(currentWindowStartedAt) : NaN;
  const resetWindow = !currentWindowStartedAt ||
    !Number.isFinite(windowStartedAtMs) ||
    issuedAtMs - windowStartedAtMs >= BROKER_CREDENTIAL_REMINT_WINDOW_MS;
  if (!resetWindow && currentCount >= BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW) {
    return { ok: false };
  }
  return {
    ok: true,
    count: resetWindow ? 1 : currentCount + 1,
    windowStartedAt: resetWindow ? issuedAt : currentWindowStartedAt,
  };
}

function redactSetupGrant(grant) {
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

async function verifyGitHubOAuthRepoWritePermissionWithClient({
  githubClient,
  code,
  owner,
  repo,
} = {}) {
  if (
    !githubClient ||
    typeof githubClient.exchangeOAuthCodeForToken !== "function" ||
    typeof githubClient.getRepoPermissions !== "function"
  ) {
    return { ok: false, status: 503, reason: "github_oauth_not_configured" };
  }
  let exchanged;
  try {
    exchanged = await githubClient.exchangeOAuthCodeForToken({ code });
  } catch {
    return { ok: false, status: 400, reason: "github_oauth_exchange_failed" };
  }
  const accessToken = optionalString(exchanged?.accessToken ?? exchanged?.access_token ?? exchanged?.token);
  if (exchanged?.ok === false || !accessToken) {
    return { ok: false, status: 400, reason: "github_oauth_exchange_failed" };
  }
  let repoAccess;
  try {
    repoAccess = await githubClient.getRepoPermissions({ accessToken, owner, repo });
  } catch {
    return { ok: false, status: 400, reason: "github_repo_permissions_lookup_failed" };
  }
  if (repoAccess?.ok === false) {
    return {
      ok: false,
      status: repoAccess.status || 400,
      reason: repoAccess.reason || "github_repo_permissions_lookup_failed",
    };
  }
  const permissions = repoAccess?.permissions || {};
  const hasWrite = permissions.push === true || permissions.admin === true;
  if (!hasWrite) {
    return { ok: false, status: 401, reason: "repo_write_permission_required" };
  }
  return { ok: true };
}

function mapLookup(source, key) {
  if (source instanceof Map) return source.get(key);
  return source?.[key];
}

function repoPermissionsLookup(source, { accessToken, owner, repo } = {}) {
  const repoKey = `${owner}/${repo}`;
  const tokenValue = mapLookup(source, accessToken);
  if (tokenValue && typeof tokenValue === "object") {
    return mapLookup(tokenValue, repoKey) || mapLookup(tokenValue, repoKey.toLowerCase());
  }
  return mapLookup(source, `${accessToken}:${repoKey}`) || mapLookup(source, `${accessToken}:${repoKey.toLowerCase()}`);
}

function failureToError(value) {
  return value instanceof Error ? value : new Error(String(value || "fake_github_oauth_failure"));
}

function githubInstallUrl({ appSlug, state } = {}) {
  return `https://github.com/apps/${encodeURIComponent(String(appSlug).trim())}/installations/new?state=${encodeURIComponent(state)}`;
}

async function resolveGitHubInstallationIdWithClient({
  githubClient,
  owner,
  repo,
} = {}) {
  if (githubClient && typeof githubClient.getRepoInstallation === "function") {
    let response;
    try {
      response = await githubClient.getRepoInstallation({ owner, repo });
    } catch {
      return { ok: false, status: 400, reason: "github_app_installation_lookup_failed" };
    }
    if (response?.ok === false) {
      return {
        ok: false,
        status: response.status || 400,
        reason: response.reason || "github_app_installation_lookup_failed",
      };
    }
    const installationId = githubInstallationId(response?.installation?.id ?? response?.id);
    if (!installationId) return { ok: false, status: 400, reason: "github_app_installation_lookup_failed" };
    return { ok: true, installationId };
  }
  return { ok: false, status: 400, reason: "github_app_installation_lookup_failed" };
}

function githubOAuthAuthorizeUrl({ clientId, state } = {}) {
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(String(clientId).trim())}&state=${encodeURIComponent(state)}`;
}

function githubInstallationId(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function assertGrantScopeRequest({ requestedTeamId = null, requestedDomainId = null, requestedWebhookIds = [], grant } = {}) {
  const teamId = optionalString(requestedTeamId);
  if (teamId && teamId !== grant.team_id) throw new Error("setup_grant_scope_mismatch");
  const domainId = optionalString(requestedDomainId);
  if (domainId && domainId !== optionalString(grant.domain_id)) throw new Error("setup_grant_scope_mismatch");
  const webhookIds = sortedStrings(requestedWebhookIds);
  if (webhookIds.length > 0 && !webhookIds.every((webhookId) => webhookId === grant.webhook_id)) {
    throw new Error("setup_grant_scope_mismatch");
  }
}

export function verifyHmacSignature({ rawBody, signature, secret } = {}) {
  if (typeof signature !== "string" || signature.trim() === "") return false;
  if (typeof secret !== "string" || secret.trim() === "") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody || "").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

function missingCapabilities(workflowType, capabilities) {
  const runnerCapabilities = new Set(capabilities || []);
  return requiredCapabilitiesForWorkflow(workflowType).filter((capability) => !runnerCapabilities.has(capability));
}

function effectiveClaimCapabilities({ storedCapabilities = null, presentedCapabilities = [] } = {}) {
  const presented = sortedStrings(presentedCapabilities);
  if (!Array.isArray(storedCapabilities)) return presented;
  const stored = sortedStrings(storedCapabilities);
  if (presented.length === 0) return stored;
  const presentedSet = new Set(presented);
  return stored.filter((capability) => presentedSet.has(capability));
}

function runnerCredentialScope({
  credentialScope = null,
  storedWebhookIds = [],
  storedTeamId = null,
  storedDomainId = null,
} = {}) {
  if (credentialScope) {
    return {
      storedWebhookIds: sortedStrings(credentialScope.storedWebhookIds || credentialScope.webhook_ids),
      storedTeamId: optionalString(credentialScope.storedTeamId || credentialScope.team_id),
      storedDomainId: optionalString(credentialScope.storedDomainId || credentialScope.domain_id),
    };
  }
  return {
    storedWebhookIds: sortedStrings(storedWebhookIds),
    storedTeamId: optionalString(storedTeamId),
    storedDomainId: optionalString(storedDomainId),
  };
}

function unscopedRunnerCredentialScope() {
  return { storedWebhookIds: [], storedTeamId: null, storedDomainId: null };
}

function storedWebhookScopeActive(scope) {
  return scope.storedWebhookIds.length > 0;
}

function effectiveWebhookIdsForCredentialScope(scope, presentedWebhookIds = []) {
  const presented = sortedStrings(presentedWebhookIds);
  if (!storedWebhookScopeActive(scope)) return presented;
  if (presented.length === 0) return scope.storedWebhookIds;
  const presentedSet = new Set(presented);
  return scope.storedWebhookIds.filter((webhookId) => presentedSet.has(webhookId));
}

function wakeMatchesCredentialScope(wake, scope, effectiveWebhookIds = []) {
  if (!wake) return false;
  if (storedWebhookScopeActive(scope)) {
    if (effectiveWebhookIds.length === 0) return false;
    if (!wakeMatchesWebhookFilter(wake, effectiveWebhookIds)) return false;
  } else if (effectiveWebhookIds.length > 0 && !wakeMatchesWebhookFilter(wake, effectiveWebhookIds)) {
    return false;
  }
  return wakeMatchesStoredTeamScope(wake, scope);
}

function wakeMatchesStoredTeamScope(wake, scope) {
  if (!scope.storedTeamId) return true;
  const wakeTeamIds = sortedStrings(wake.team_ids);
  return wakeTeamIds.length === 0 || wakeTeamIds.includes(scope.storedTeamId);
}

function redactedWake(wake) {
  if (!wake) return null;
  const copy = { ...wake };
  delete copy.lease_token;
  return copy;
}

function pruneRows(rows, shouldPrune) {
  const kept = [];
  let pruned = 0;
  for (const row of rows) {
    if (shouldPrune(row)) pruned += 1;
    else kept.push(row);
  }
  return { rows: kept, pruned };
}

function timestampAtOrBefore(value, cutoff) {
  if (typeof value !== "string" || value.trim() === "") return false;
  return Date.parse(value) <= Date.parse(cutoff);
}

function plusMsIso(baseIso, ms) {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function sortedStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim() !== ""))].sort();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function unionSortedStrings(left, right) {
  return sortedStrings([...sortedStrings(left), ...sortedStrings(right)]);
}

function scopedWakeKeyForTrustedTeam(wakeKey, trustedTeamId) {
  const teamId = optionalString(trustedTeamId);
  return teamId ? `${wakeKey}:scope:team:${encodeURIComponent(teamId)}` : wakeKey;
}

function wakeMatchesWebhookFilter(wake, webhookIds) {
  const filter = sortedStrings(webhookIds);
  if (filter.length === 0) return true;
  const wakeWebhookIds = new Set(sortedStrings(wake.webhook_ids));
  return filter.some((webhookId) => wakeWebhookIds.has(webhookId));
}

function normalizeRoutingCandidates(candidates) {
  if (!Array.isArray(candidates)) return { ok: false };
  const normalized = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") return { ok: false };
    if (!isNonEmptyString(candidate.domainId)) return { ok: false };
    if (!isNonEmptyString(candidate.status)) return { ok: false };
    if (!(typeof candidate.teamId === "string" || candidate.teamId === null)) return { ok: false };
    normalized.push({
      domainId: candidate.domainId,
      status: candidate.status,
      teamId: candidate.teamId,
    });
  }
  return { ok: true, candidates: normalized };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
}

function redactSecretRecord(record) {
  return {
    ...record,
    signing_secret: "[stored]",
  };
}

function defaultIdGenerator() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
