import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const hostedInboxSource = fs.readFileSync(
  path.join(repoRoot, "supabase/functions/agentic-factory-inbox/index.ts"),
  "utf8",
);
const brokerSource = fs.readFileSync(
  path.join(repoRoot, "supabase/functions/agentic-factory-github-broker/index.ts"),
  "utf8",
);
const memoryInboxSource = fs.readFileSync(
  path.join(repoRoot, "execution/integrations/linear/src/inbox-store.mjs"),
  "utf8",
);
const webhookInboxSource = fs.readFileSync(
  path.join(repoRoot, "execution/integrations/linear/src/linear-webhook-inbox.mjs"),
  "utf8",
);
const legacyWakeRepairMigration = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260612100000_legacy_wake_routing_repair.sql"),
  "utf8",
);
const setupGrantMigration = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260613090001_setup_grants.sql"),
  "utf8",
);
const githubInstallGrantMigration = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260613100000_github_installation_bound_setup_grants.sql"),
  "utf8",
);
const brokerRemintGrantMigration = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260613110000_broker_credential_remint_throttle_setup_grants.sql"),
  "utf8",
);
const githubInstallFlowGrantMigration = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260615023000_github_install_flow_setup_grants.sql"),
  "utf8",
);

test("hosted and memory inbox routing-error reasons stay in parity", () => {
  assert.deepEqual(
    extractSetStrings(hostedInboxSource, "ROUTING_ERROR_REASONS").sort(),
    extractSetStrings(memoryInboxSource, "ROUTING_ERROR_REASONS").sort(),
  );
});

test("hosted inbox delivery storage remains data-minimized", () => {
  assert.match(hostedInboxSource, /raw_body:\s*null/);
  assert.match(hostedInboxSource, /raw_body_sha256:\s*await sha256Hex\(rawBody\)/);
  assert.doesNotMatch(hostedInboxSource, /raw_body:\s*(rawBody|payload|JSON\.stringify|String\()/);
});

test("hosted and mirror webhook ingress enforce C4 fail-fast abuse guards", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const handleWebhook = extractFunctionBody(hostedInboxSource, "handleLinearWebhook");
  const readJson = extractFunctionBody(hostedInboxSource, "readJson");
  const readCappedBody = extractFunctionBody(hostedInboxSource, "readCappedBody");
  const contentLength = extractFunctionBody(hostedInboxSource, "assertContentLengthWithinCap");
  const requireHeaders = extractFunctionBody(hostedInboxSource, "requireLinearWebhookHeaders");
  const ingest = extractFunctionBody(webhookInboxSource, "ingestLinearWebhookDelivery");

  assert.match(hostedInboxSource, /const MAX_WEBHOOK_BODY_BYTES = 1048576/);
  assert.match(webhookInboxSource, /export const MAX_WEBHOOK_BODY_BYTES = 1048576/);
  assert.match(routeHandler, /const body = await readJson\(req\)/);
  assert.match(readJson, /const text = await readCappedBody\(req\)/);
  assert.match(readCappedBody, /assertContentLengthWithinCap\(req\.headers\)/);
  assert.match(readCappedBody, /new TextEncoder\(\)\.encode\(text\)\.length > MAX_WEBHOOK_BODY_BYTES/);
  assert.match(readCappedBody, /httpError\(413, "payload_too_large"\)/);
  assert.match(contentLength, /headers\.get\("content-length"\)/);
  assert.match(contentLength, /bytes > MAX_WEBHOOK_BODY_BYTES/);
  assert.match(contentLength, /httpError\(413, "payload_too_large"\)/);

  assert.match(handleWebhook, /assertContentLengthWithinCap\(req\.headers\)/);
  assert.match(handleWebhook, /const \{ signature, deliveryId \} = requireLinearWebhookHeaders\(req\.headers\)/);
  assert.match(handleWebhook, /const rawBody = await readCappedBody\(req\)/);
  assert.ok(
    handleWebhook.indexOf("requireLinearWebhookHeaders") < handleWebhook.indexOf("JSON.parse(rawBody)"),
    "webhook header prechecks must happen before JSON.parse",
  );
  assert.ok(
    handleWebhook.indexOf("readCappedBody") < handleWebhook.indexOf("JSON.parse(rawBody)"),
    "webhook body cap must happen before JSON.parse",
  );
  assert.match(requireHeaders, /missing_signature_header/);
  assert.match(requireHeaders, /missing_delivery_header/);

  assert.match(webhookInboxSource, /function rejectedLinearDelivery\(reason\)/);
  assert.match(ingest, /Buffer\.byteLength\(rawBody \|\| "", "utf8"\) > MAX_WEBHOOK_BODY_BYTES/);
  assert.match(ingest, /rejectedLinearDelivery\("payload_too_large"\)/);
  assert.match(ingest, /rejectedLinearDelivery\("missing_signature_header"\)/);
  assert.match(ingest, /rejectedLinearDelivery\("missing_delivery_header"\)/);
  assert.ok(
    ingest.indexOf("missing_delivery_header") < ingest.indexOf("verifyLinearWebhookSignature"),
    "mirror header prechecks must happen before signature verification",
  );
});

test("hosted and memory setup-grant issuance caps include the C4 global anonymous limit", () => {
  const issueSetupGrant = extractFunctionBody(hostedInboxSource, "issueSetupGrant");
  const requestSetupGrant = extractMethodBody(memoryInboxSource, "requestSetupGrant({");

  // Per-workspace cap is the targeted control (10). The global cap is a HIGH runaway-row
  // backstop (>= 10000), not a low cross-tenant lockout (G3): a low shared global cap would
  // let one attacker deny setup to the whole fleet. Pin both stores to the same high value.
  assert.match(hostedInboxSource, /const SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE = 10/);
  assert.match(hostedInboxSource, /const SETUP_GRANT_ISSUANCE_MAX_GLOBAL = 10000/);
  assert.match(memoryInboxSource, /const SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE = 10/);
  assert.match(memoryInboxSource, /const SETUP_GRANT_ISSUANCE_MAX_GLOBAL = 10000/);
  assert.match(issueSetupGrant, /if \(!bypassActiveConflict\) \{/);
  assert.match(issueSetupGrant, /recentGlobal[\s\S]*SETUP_GRANT_ISSUANCE_MAX_GLOBAL/);
  assert.match(issueSetupGrant, /setup_grant_rate_limited/);
  assert.match(requestSetupGrant, /if \(!bypassActiveConflict\) \{/);
  assert.match(requestSetupGrant, /recentGlobal[\s\S]*SETUP_GRANT_ISSUANCE_MAX_GLOBAL/);
  assert.match(requestSetupGrant, /setup_grant_rate_limited/);
});

test("wake read surfaces redact lease tokens while claim and renew can return owner tokens", () => {
  const hostedGetWake = extractFunctionBody(hostedInboxSource, "getWake");
  const hostedListWakeViews = extractFunctionBody(hostedInboxSource, "listWakeViews");
  const hostedClaimWake = extractFunctionBody(hostedInboxSource, "claimWake");
  const hostedRenewWakeLease = extractFunctionBody(hostedInboxSource, "renewWakeLease");
  const memoryGetWake = extractMethodBody(memoryInboxSource, "getWake(wakeId,");
  const memoryListWakeViews = extractMethodBody(memoryInboxSource, "listWakeViews");

  assert.match(hostedInboxSource, /function redactedWake\(wake: Record<string, any>\)/);
  assert.match(hostedGetWake, /redactedWake\(wake\)/);
  assert.doesNotMatch(hostedGetWake, /lease_token|camelWake\(wake\)/);
  assert.match(hostedListWakeViews, /redactedWake\(wake\)/);
  assert.doesNotMatch(hostedListWakeViews, /lease_token/);
  assert.match(hostedClaimWake, /wake:\s*redactedWake\(candidate\)/);
  assert.match(hostedClaimWake, /wake:\s*redactedWake\(\{\s*\.\.\.candidate/);
  assert.match(hostedClaimWake, /return \{ ok: true, wake: camelWake\(update\.data\), leaseToken/);
  assert.match(hostedRenewWakeLease, /return \{ ok: true, wake: camelWake\(result\.data\) \}/);

  assert.match(memoryInboxSource, /function redactedWake\(wake\)/);
  assert.match(memoryGetWake, /redactedWake\(wake\)/);
  assert.doesNotMatch(memoryGetWake, /lease_token/);
  assert.match(memoryListWakeViews, /redactedWake\(wake\)/);
  assert.doesNotMatch(memoryListWakeViews, /lease_token/);
});

test("hosted runner lease operations fail closed on missing or expired lease tokens", () => {
  const deadLetterWake = extractFunctionBody(hostedInboxSource, "deadLetterWake");
  const assertLease = extractFunctionBody(hostedInboxSource, "assertLease");

  assert.match(deadLetterWake, /const wake = await assertLease\(input, \{ credentialScope \}\);/);
  assert.doesNotMatch(deadLetterWake, /input\.leaseToken\s*\|\|\s*input\.runnerId/);
  assert.match(assertLease, /lease_token_mismatch/);
  assert.match(assertLease, /lease_expired/);
});

test("hosted lazy lease expiry is scoped to the caller workspace", () => {
  const claimWake = extractFunctionBody(hostedInboxSource, "claimWake");
  const listWakeViews = extractFunctionBody(hostedInboxSource, "listWakeViews");
  const expireLeases = extractFunctionBody(hostedInboxSource, "expireLeases");

  assert.match(claimWake, /await expireLeases\(String\(input\.workspaceId\)\)/);
  assert.match(listWakeViews, /await expireLeases\(String\(input\.workspaceId\)\)/);
  assert.match(expireLeases, /query = query\.eq\("workspace_id", workspaceId\)/);
});

test("hosted maintenance route is break-glass authed and never prunes active rows", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const maintenanceStart = routeHandler.indexOf('case "POST /v1/maintenance"');
  const maintenanceEnd = routeHandler.indexOf('case "PUT /v1/linear/webhook-secret"');
  const maintenanceCase = routeHandler.slice(maintenanceStart, maintenanceEnd);
  const runMaintenance = extractFunctionBody(hostedInboxSource, "runMaintenance");
  const expireDueSetupGrants = extractFunctionBody(hostedInboxSource, "expireDueSetupGrants");
  const expireLeases = extractFunctionBody(hostedInboxSource, "expireLeases");
  const pruneTerminalWakeups = extractFunctionBody(hostedInboxSource, "pruneTerminalWakeups");
  const pruneInactiveSetupGrants = extractFunctionBody(hostedInboxSource, "pruneInactiveSetupGrants");
  const pruneInactiveRunnerCredentials = extractFunctionBody(hostedInboxSource, "pruneInactiveRunnerCredentials");

  assert.notEqual(maintenanceStart, -1, "missing maintenance route");
  assert.match(maintenanceCase, /requireBreakGlassAuth\(req\)/);
  assert.match(
    maintenanceCase,
    /return json\(await runMaintenance\(\{ breakGlassReason: requireBreakGlassAuth\(req\) \}\)\)/,
    "maintenance must authenticate and pass the break-glass reason before running the sweep",
  );
  assert.match(hostedInboxSource, /const RETENTION_MS = \{/);
  assert.match(runMaintenance, /expireDueSetupGrants\(at\)/);
  assert.match(runMaintenance, /expireLeases\(undefined, at\)/);
  assert.match(runMaintenance, /pruneExpired\(at\)/);
  assert.match(expireDueSetupGrants, /\.eq\("status", "provisional"\)/);
  assert.match(expireLeases, /if \(workspaceId\) query = query\.eq\("workspace_id", workspaceId\)/);
  assert.match(pruneTerminalWakeups, /\.in\("status", TERMINAL_STATUS_VALUES\)/);
  assert.doesNotMatch(pruneTerminalWakeups, /queued|leased|running/);
  assert.match(pruneInactiveSetupGrants, /\.in\("status", inactiveStatuses\)/);
  assert.doesNotMatch(pruneInactiveSetupGrants, /provisional|confirmed/);
  assert.match(pruneInactiveRunnerCredentials, /\.eq\("active", false\)/);
  assert.doesNotMatch(pruneInactiveRunnerCredentials, /\.eq\("active", true\)/);
});

test("hosted abuse paths emit structured non-secret security log events", () => {
  const inboxRouteHandler = extractServeHandlerBody(hostedInboxSource);
  const brokerRouteHandler = extractServeHandlerBody(brokerSource);
  const inboxSecurityLog = extractFunctionBody(hostedInboxSource, "emitHostedSecurityLog");
  const brokerSecurityLog = extractFunctionBody(brokerSource, "emitHostedSecurityLog");
  const inboxValueGuard = extractFunctionBody(hostedInboxSource, "structuredLogValueAllowed");
  const brokerValueGuard = extractFunctionBody(brokerSource, "structuredLogValueAllowed");
  const issueSetupGrant = extractFunctionBody(hostedInboxSource, "issueSetupGrant");
  const issueBrokerCredential = extractFunctionBody(hostedInboxSource, "issueBrokerCredential");
  const recordBrokerCredentialRemint = extractFunctionBody(hostedInboxSource, "recordBrokerCredentialRemint");
  const runMaintenance = extractFunctionBody(hostedInboxSource, "runMaintenance");
  const mintInstallationToken = extractFunctionBody(brokerSource, "mintInstallationToken");

  assert.match(hostedInboxSource, /STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS/);
  assert.match(brokerSource, /STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS/);
  assert.doesNotMatch(hostedInboxSource, /sensitiveAuditField|emitHostedAudit/);
  assert.doesNotMatch(brokerSource, /sensitiveAuditField|emitHostedAudit/);
  assert.match(inboxSecurityLog, /service:\s*FUNCTION_SLUG/);
  assert.match(inboxSecurityLog, /STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS\[event\]/);
  assert.match(inboxSecurityLog, /key === "event" \|\| key === "service" \|\| !allowedFields\.has\(key\)/);
  assert.match(inboxSecurityLog, /structuredLogValueAllowed\(value\)/);
  assert.match(inboxSecurityLog, /console\.info\(JSON\.stringify\(entry\)\)/);
  assert.match(brokerSecurityLog, /service:\s*FUNCTION_SLUG/);
  assert.match(brokerSecurityLog, /STRUCTURED_SECURITY_LOG_ALLOWED_FIELDS\[event\]/);
  assert.match(brokerSecurityLog, /key === "event" \|\| key === "service" \|\| !allowedFields\.has\(key\)/);
  assert.match(brokerSecurityLog, /structuredLogValueAllowed\(value\)/);
  assert.match(brokerSecurityLog, /console\.info\(JSON\.stringify\(entry\)\)/);
  for (const valueGuard of [inboxValueGuard, brokerValueGuard]) {
    assert.match(valueGuard, /typeof value !== "string"/);
    assert.match(valueGuard, /value\.length > 512/);
    assert.match(valueGuard, /STRUCTURED_SECURITY_LOG_SENSITIVE_VALUE_PATTERNS\.some/);
  }
  assert.match(hostedInboxSource, /gh\[opsru\]_/);
  assert.match(hostedInboxSource, /github_pat_/);
  assert.ok(hostedInboxSource.includes("af_(?:setup|broker|runner)_v\\d_"));
  assert.ok(hostedInboxSource.includes("eyJ[A-Za-z0-9_-"));
  assert.match(brokerSource, /gh\[opsru\]_/);
  assert.match(brokerSource, /github_pat_/);
  assert.ok(brokerSource.includes("af_(?:setup|broker|runner)_v\\d_"));
  assert.ok(brokerSource.includes("eyJ[A-Za-z0-9_-"));

  assert.match(inboxRouteHandler, /emitHostedSecurityLog\("hosted_inbox_auth_denied"/);
  assert.match(inboxRouteHandler, /status === 401 \|\| status === 403/);
  assert.match(inboxRouteHandler, /route/);
  assert.match(inboxRouteHandler, /reason: caught\?\.message \|\| "unknown error"/);
  assert.match(brokerRouteHandler, /emitHostedSecurityLog\("github_broker_auth_denied"/);
  assert.match(brokerRouteHandler, /status === 401 \|\| status === 403/);
  assert.match(brokerRouteHandler, /route/);

  assert.match(issueSetupGrant, /emitHostedSecurityLog\("setup_grant_rate_limited"/);
  assert.match(issueSetupGrant, /scope:\s*"workspace"/);
  assert.match(issueSetupGrant, /scope:\s*"global"/);
  assert.match(issueSetupGrant, /limit:\s*SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE/);
  assert.match(issueSetupGrant, /limit:\s*SETUP_GRANT_ISSUANCE_MAX_GLOBAL/);
  assert.match(issueSetupGrant, /windowMs:\s*SETUP_GRANT_ISSUANCE_WINDOW_MS/);
  assert.match(issueSetupGrant, /emitHostedSecurityLog\("setup_grant_issued"/);
  assert.match(issueSetupGrant, /authMode:\s*auditSetupGrantAuthMode\(createdBy, bypassActiveConflict\)/);
  assert.match(issueSetupGrant, /setupGrantRowId:\s*String\(result\.data\.id\)/);

  assert.match(issueBrokerCredential, /const remintRecord = await recordBrokerCredentialRemint\(grant, now\)/);
  assert.match(issueBrokerCredential, /emitHostedSecurityLog\("broker_credential_minted"/);
  assert.match(issueBrokerCredential, /workspaceId:\s*String\(grant\.workspace_id\)/);
  assert.match(issueBrokerCredential, /teamId:\s*String\(grant\.team_id\)/);
  assert.match(issueBrokerCredential, /owner/);
  assert.match(issueBrokerCredential, /repo/);
  assert.match(issueBrokerCredential, /installationId/);
  assert.match(issueBrokerCredential, /ttlSeconds:\s*BROKER_CREDENTIAL_TTL_SECONDS/);
  assert.match(recordBrokerCredentialRemint, /emitHostedSecurityLog\("broker_credential_remint_rate_limited"/);
  assert.match(recordBrokerCredentialRemint, /limit:\s*BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW/);
  assert.match(recordBrokerCredentialRemint, /windowMs:\s*BROKER_CREDENTIAL_REMINT_WINDOW_MS/);

  assert.match(mintInstallationToken, /emitHostedSecurityLog\("github_installation_token_minted"/);
  assert.match(mintInstallationToken, /authMode:\s*auth\.mode/);
  assert.match(mintInstallationToken, /workspaceId:\s*auth\.mode === "credential" \? auth\.workspaceId : null/);
  assert.match(mintInstallationToken, /teamId:\s*auth\.mode === "credential" \? auth\.teamId : null/);
  assert.match(mintInstallationToken, /permissionKeys:\s*Object\.keys\(permissions\)\.sort\(\)\.join\(","\)/);

  assert.match(runMaintenance, /emitHostedSecurityLog\("maintenance_sweep_completed"/);
  assert.match(runMaintenance, /authMode:\s*"break_glass"/);
  assert.match(runMaintenance, /breakGlassReason/);
  assert.match(runMaintenance, /expiredGrants/);
  assert.match(runMaintenance, /expiredLeases/);
  assert.match(runMaintenance, /prunedWebhookDeliveries:\s*pruned\.webhookDeliveries/);
  assert.match(runMaintenance, /prunedRunnerCredentials:\s*pruned\.runnerCredentials/);

  const logFieldBodies = [
    ...extractStructuredLogFieldBodies(hostedInboxSource, "hosted_inbox_auth_denied"),
    ...extractStructuredLogFieldBodies(hostedInboxSource, "setup_grant_rate_limited"),
    ...extractStructuredLogFieldBodies(hostedInboxSource, "setup_grant_issued"),
    ...extractStructuredLogFieldBodies(hostedInboxSource, "broker_credential_minted"),
    ...extractStructuredLogFieldBodies(hostedInboxSource, "broker_credential_remint_rate_limited"),
    ...extractStructuredLogFieldBodies(hostedInboxSource, "maintenance_sweep_completed"),
    ...extractStructuredLogFieldBodies(brokerSource, "github_broker_auth_denied"),
    ...extractStructuredLogFieldBodies(brokerSource, "github_installation_token_minted"),
  ].join("\n");
  assert.doesNotMatch(
    logFieldBodies,
    /\b(token|secret|brokerCredential|runnerCredential|privateKey|rawBody|rawPayload|payload|repoContents|accessToken)\b/i,
  );
  assert.doesNotMatch(logFieldBodies, /response\.token|JSON\.stringify\(payload\)|rawBody|rawPayload/i);
});

test("hosted claim uses stored runner credential capabilities and scope, not self-attested input alone", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const claimWake = extractFunctionBody(hostedInboxSource, "claimWake");

  assert.match(routeHandler, /const credential = await requireRunnerCredential\(body\);/);
  assert.match(routeHandler, /storedCapabilities: credential\.capabilities/);
  assert.match(routeHandler, /credentialScope: runnerCredentialScope\(credential\)/);
  assert.match(claimWake, /effectiveClaimCapabilities\(\{ storedCapabilities, presentedCapabilities: input\.capabilities \}\)/);
  assert.match(claimWake, /effectiveWebhookIdsForCredentialScope\(scope, input\.webhookIds\)/);
  assert.match(claimWake, /wakeMatchesCredentialScope\(candidate, scope, webhookIds\)/);
});

test("hosted credential scope is server-bound for verify, wake reads, and lease operations", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const verifyResponse = extractFunctionBody(hostedInboxSource, "runnerCredentialVerificationResponse");
  const assertLease = extractFunctionBody(hostedInboxSource, "assertLease");
  const getWake = extractFunctionBody(hostedInboxSource, "getWake");
  const listWakeViews = extractFunctionBody(hostedInboxSource, "listWakeViews");

  assert.match(verifyResponse, /team_id: scope\.storedTeamId/);
  assert.match(verifyResponse, /webhook_ids: scope\.storedWebhookIds/);
  assert.match(verifyResponse, /domain_id: scope\.storedDomainId/);
  assert.match(routeHandler, /renewWakeLease\(body, \{ credentialScope: runnerCredentialScope\(credential\) \}\)/);
  assert.match(routeHandler, /getWake\(body, \{ credentialScope: runnerCredentialScope\(credential\) \}\)/);
  assert.match(routeHandler, /listWakeViews\(body, \{ credentialScope: runnerCredentialScope\(credential\) \}\)/);
  assert.match(assertLease, /wakeMatchesCredentialScope\(wake, scope, webhookIds\)/);
  assert.match(getWake, /wakeMatchesCredentialScope\(wake, scope, webhookIds\)/);
  assert.match(listWakeViews, /withCredentialScopeFilter/);
});

test("hosted setup routes use team-scoped setup grants, with admin token only for break-glass", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const putSecret = extractFunctionBody(hostedInboxSource, "putLinearWebhookSecret");
  const deleteSecret = extractFunctionBody(hostedInboxSource, "deleteLinearWebhookSecret");
  const mintCredential = extractFunctionBody(hostedInboxSource, "mintRunnerCredential");

  assert.match(hostedInboxSource, /const SETUP_GRANT_HEADER = "x-agentic-factory-setup-grant"/);
  assert.match(routeHandler, /POST \/v1\/setup-grants/);
  assert.match(routeHandler, /issueSetupGrantRoute\(req, body\)/);
  assert.match(routeHandler, /POST \/v1\/setup-grants\/status/);
  assert.match(routeHandler, /POST \/v1\/setup-grants\/revoke/);
  assert.match(routeHandler, /POST \/v1\/setup-grants\/recover/);
  assert.match(routeHandler, /issueGitHubInstallIntent\(body, await requireSetupGrant\(req, body, \{ consumeUse: true \}\)\)/);
  assert.match(routeHandler, /putLinearWebhookSecret\(body, await requireSetupGrant\(req, body, \{ consumeUse: true \}\)\)/);
  assert.match(routeHandler, /verifyLinearWebhookSecret\(body, grant\)/);
  assert.match(routeHandler, /deleteLinearWebhookSecret\(body, await requireSetupGrant\(req, body, \{ consumeUse: true \}\)\)/);
  assert.match(routeHandler, /mintRunnerCredential\(req, body, await requireSetupGrant\(req, body, \{ consumeUse: true \}\)\)/);
  assert.doesNotMatch(routeHandler, /requireSetupAuth/);
  assert.match(routeHandler, /recoverSetupGrant\(req, body\)/);
  const issueSetupGrantRoute = extractFunctionBody(hostedInboxSource, "issueSetupGrantRoute");
  assert.match(issueSetupGrantRoute, /input\.bypassActiveConflict === true/);
  assert.match(issueSetupGrantRoute, /refreshSetupGrantRoute\(req, input\)/);
  const refreshSetupGrantRoute = extractFunctionBody(hostedInboxSource, "refreshSetupGrantRoute");
  assert.match(refreshSetupGrantRoute, /requireSetupGrant\(req, input\)/);
  assert.match(refreshSetupGrantRoute, /grant\.status === "provisional"/);
  assert.match(refreshSetupGrantRoute, /confirmation_expires_at/);
  assert.match(refreshSetupGrantRoute, /expires_at: plusMs\(now, SETUP_GRANT_MUTATION_TTL_MS\)/);
  assert.match(refreshSetupGrantRoute, /\.in\("status", \["provisional", "confirmed"\]\)/);
  assert.match(refreshSetupGrantRoute, /return \{ ok: true, refreshed: true, setupGrant, grant: setupGrantStatus\(refreshed\.data\) \}/);
  assert.doesNotMatch(refreshSetupGrantRoute, /uses_remaining/);
  assert.match(hostedInboxSource, /function requireBreakGlassAuth\(req: Request\)/);

  assert.match(putSecret, /setup_grant_id: grant\.grant_id/);
  assert.match(putSecret, /team_id: grant\.team_id/);
  assert.match(putSecret, /confirmation_state: "provisional"/);
  assert.match(deleteSecret, /\.eq\("setup_grant_id", grant\.grant_id\)/);
  assert.doesNotMatch(mintCredential, /optionalString\(input\.teamId|sortedStrings\(input\.webhookIds|optionalString\(input\.domainId/);
  assert.match(mintCredential, /const teamId = String\(grant\.team_id\)/);
  assert.match(mintCredential, /const webhookIds = \[webhookId\]/);
  assert.match(mintCredential, /const domainId = optionalString\(grant\.domain_id\)/);
});

test("hosted setup grant + credential surface keeps the hostile-review reconciliation invariants", () => {
  // F5: requireSetupGrant derives teamId from the authenticated grant (the real client omits
  // it), and only validates a supplied teamId — not a hard requireString on the body. The
  // remaining input.teamId requirements are issuance/break-glass, where no grant exists yet.
  assert.doesNotMatch(hostedInboxSource, /requireString\(body\.teamId/);
  assert.match(hostedInboxSource, /body\.teamId != null && String\(body\.teamId\) !== grant\.team_id/);

  // F2: a bound provisional grant is never expired on the 15-minute mutation clock; only an
  // abandoned UNBOUND setup is. Liveness/confirmation is gated by the 7-day window.
  assert.match(hostedInboxSource, /grant\.status === "provisional" && !grant\.webhook_id/);
  assert.match(hostedInboxSource, /if \(consumeUse\) throw httpError\(401, "setup grant mutation window expired"\)/);
  assert.match(hostedInboxSource, /\.lte\("confirmation_expires_at", now\)/);

  // F3: a grant cannot clobber another team's stored webhook secret by reusing its id.
  assert.match(hostedInboxSource, /webhook_id_bound_to_other_team/);
  assert.match(hostedInboxSource, /conflicting\.setup_grant_id !== grant\.grant_id/);

  // F4: domain isolation is enforced when a wake is labeled at mark-running.
  assert.match(hostedInboxSource, /domain_outside_credential_scope/);
  assert.match(hostedInboxSource, /scope\.storedDomainId && scope\.storedDomainId !== domainId/);

  // F1 bound: anonymous issuance is rate-limited per workspace (server-enforced), the
  // pre-launch mitigation for the accepted setup-ownership residual.
  assert.match(hostedInboxSource, /setup_grant_rate_limited/);
  assert.match(hostedInboxSource, /SETUP_GRANT_ISSUANCE_MAX_PER_WORKSPACE/);
});

test("hosted setup grant confirmation only happens on first real signed matching delivery", () => {
  const handleWebhook = extractFunctionBody(hostedInboxSource, "handleLinearWebhook");
  const verifyLocal = extractFunctionBody(hostedInboxSource, "verifyLinearWebhookSecret");
  const confirm = extractFunctionBody(hostedInboxSource, "confirmSetupGrantForDelivery");

  assert.match(handleWebhook, /await confirmSetupGrantForDelivery\(\{ verification, payload, deliveryId, receivedAt \}\)/);
  assert.doesNotMatch(verifyLocal, /confirmSetupGrantForDelivery|confirmed_at|confirmation_delivery_id/);
  assert.match(confirm, /secret\.confirmation_state !== "provisional"/);
  assert.match(confirm, /\.eq\("grant_id", secret\.setup_grant_id\)/);
  assert.match(confirm, /\.eq\("status", "provisional"\)/);
  assert.match(confirm, /payload\?\.organizationId !== grant\.workspace_id/);
  assert.match(confirm, /!payloadTeamIds\.includes\(grant\.team_id\)/);
  assert.match(confirm, /secret\.webhook_id !== grant\.webhook_id/);
  assert.match(confirm, /secret\.team_id !== grant\.team_id/);
  assert.match(confirm, /status: "confirmed"/);
  assert.match(confirm, /confirmation_delivery_id: deliveryId/);
  assert.match(confirm, /confirmation_state: "confirmed"/);
});

test("hosted and mirror webhook routing use grant-bound team scope for reject and wake dedupe", () => {
  const handleWebhook = extractFunctionBody(hostedInboxSource, "handleLinearWebhook");
  const hostedNormalize = extractFunctionBody(hostedInboxSource, "normalizeLinearEvent");
  const hostedRoute = extractFunctionBody(hostedInboxSource, "routeTriggerEvent");
  const mirrorIngest = extractFunctionBody(webhookInboxSource, "ingestLinearWebhookDelivery");
  const mirrorRoute = extractFunctionBody(webhookInboxSource, "routeTriggerEventToWakeups");
  const mirrorEnqueue = extractMethodBody(memoryInboxSource, "enqueueWake({");

  assert.match(handleWebhook, /const trustedTeamId = trustedTeamIdFromVerification\(verification\)/);
  assert.match(handleWebhook, /delivery_team_not_in_webhook_scope/);
  assert.ok(
    handleWebhook.indexOf("delivery_team_not_in_webhook_scope") < handleWebhook.indexOf("confirmSetupGrantForDelivery"),
    "hosted team-scope reject must happen before confirmation or persistence",
  );
  assert.match(hostedInboxSource, /trustedTeamId\?: string \| null/);
  assert.match(hostedNormalize, /team_ids: projectTeamIdsForTrustedDelivery\(payload, trustedTeamId\)/);
  assert.match(hostedInboxSource, /trustedTeamId = null/);
  assert.match(
    hostedRoute,
    /wake_key: scopedWakeKeyForTrustedTeam\(`linear:project:\$\{object\.id\}:decomposition`, trustedTeamId\)/,
  );
  assert.match(hostedRoute, /\.eq\("wake_key", wake\.wake_key\)/);
  assert.match(hostedRoute, /webhook_ids: unionSortedStrings\(existing\.webhook_ids, wake\.webhook_ids\)/);
  assert.match(hostedInboxSource, /function scopedWakeKeyForTrustedTeam\(wakeKey: string, trustedTeamId: string \| null = null\)/);
  assert.match(hostedInboxSource, /:scope:team:\$\{encodeURIComponent\(teamId\)\}/);

  assert.match(mirrorIngest, /const trustedTeamId = verification\.teamId \|\| null/);
  assert.match(mirrorIngest, /delivery_team_not_in_webhook_scope/);
  assert.match(webhookInboxSource, /trustedTeamId = null/);
  assert.match(mirrorRoute, /routingScopeTeamId: trustedTeamId/);
  assert.match(mirrorEnqueue, /const scopedWakeKey = scopedWakeKeyForTrustedTeam\(wakeKey, routingScopeTeamId\)/);
  assert.match(mirrorEnqueue, /wake\.wake_key === scopedWakeKey/);
});

test("setup grant migration is service-role-only and preserves legacy confirmed secrets", () => {
  assert.match(setupGrantMigration, /create table if not exists public\.agentic_factory_inbox_setup_grants/);
  assert.match(setupGrantMigration, /grant_id text not null unique/);
  assert.match(setupGrantMigration, /secret_hash text not null/);
  assert.match(setupGrantMigration, /where status in \('provisional', 'confirmed'\)/);
  assert.match(setupGrantMigration, /confirmation_state text not null default 'confirmed'/);
  assert.match(setupGrantMigration, /alter table public\.agentic_factory_inbox_setup_grants enable row level security/);
  assert.match(setupGrantMigration, /revoke all on table public\.agentic_factory_inbox_setup_grants from anon, authenticated/);
  assert.match(setupGrantMigration, /grant all on table public\.agentic_factory_inbox_setup_grants to service_role/);
  assert.match(githubInstallGrantMigration, /github_owner text/);
  assert.match(githubInstallGrantMigration, /github_repo text/);
  assert.match(githubInstallGrantMigration, /github_repo_verified_at timestamptz/);
  assert.match(githubInstallFlowGrantMigration, /github_install_flow text/);
  assert.match(githubInstallFlowGrantMigration, /'install_app', 'authorize_existing_installation'/);
  assert.match(brokerRemintGrantMigration, /github_broker_remint_count integer not null default 0/);
  assert.match(brokerRemintGrantMigration, /github_broker_remint_window_started_at timestamptz/);
});

test("GitHub broker expected App identity only comes from hosted environment", () => {
  const verifyExpectedApp = extractFunctionBody(brokerSource, "verifyExpectedApp");

  assert.doesNotMatch(verifyExpectedApp, /input\.appId|input\.appSlug/);
  assert.match(brokerSource, /github_app_identity_not_configured/);
  assert.match(verifyExpectedApp, /github_app_slug_unverifiable/);
  assert.match(verifyExpectedApp, /github_app_id_mismatch/);
  assert.match(verifyExpectedApp, /github_app_slug_mismatch/);
});

test("hosted GitHub install callback binds server-discovered installations after OAuth repo-write proof", () => {
  const installIntent = extractFunctionBody(hostedInboxSource, "issueGitHubInstallIntent");
  const callback = extractFunctionBody(hostedInboxSource, "handleGitHubInstallCallback");

  assert.match(installIntent, /requireString\(input\.owner, "owner"\)/);
  assert.match(installIntent, /requireString\(input\.repo, "repo"\)/);
  assert.match(installIntent, /github_owner: owner/);
  assert.match(installIntent, /github_repo: repo/);
  assert.match(installIntent, /github_repo_verified_at: null/);
  assert.match(installIntent, /const flow = installation\.ok \? "authorize_existing_installation" : "install_app"/);
  assert.match(installIntent, /github_install_flow: flow/);
  assert.match(hostedInboxSource, /installations\/new\?state=/);
  assert.doesNotMatch(hostedInboxSource, /installations\/select_target/);
  assert.match(installIntent, /fetchGitHubRepoInstallation\(\{ owner, repo, retryNotInstalled: false \}\)/);
  assert.match(installIntent, /flow/);

  // Callback ordering: existing-install OAuth callbacks verify repo WRITE on the
  // grant-bound owner/repo. Install/configure callbacks without OAuth code are
  // accepted only for grants that initiated the install_app flow. Both paths bind
  // the installation discovered by the server for that repo. The browser query
  // installation_id is not used as the binding source.
  assert.match(callback, /url\.searchParams\.get\("code"\)/);
  assert.match(callback, /github_oauth_code_required/);
  assert.match(callback, /const owner = optionalString\(grant\.github_owner\)/);
  assert.match(callback, /const repo = optionalString\(grant\.github_repo\)/);
  assert.match(callback, /if \(code\)/);
  assert.match(callback, /verifyGitHubOAuthRepoWritePermission\(\{ code, owner, repo \}\)/);
  assert.match(callback, /grant\.github_install_flow !== "install_app"/);
  assert.match(callback, /fetchGitHubRepoInstallation\(\{ owner, repo \}\)/);
  assert.match(callback, /githubInstallationId\(installation\.installation\.id\)/);
  assert.doesNotMatch(callback, /url\.searchParams\.get\("installation_id"\)/);
  assert.doesNotMatch(callback, /github_installation_id:\s*url\.searchParams/);
  assert.ok(
    callback.indexOf("const owner = optionalString(grant.github_owner)") < callback.indexOf("fetchGitHubRepoInstallation"),
    "callback must use the grant-bound owner/repo before discovering and binding the installation",
  );
  assert.match(callback, /github_repo_verified_at: now/);
  assert.match(callback, /github_install_flow: null/);
  // The binding update re-checks the grant is still active, so a grant revoked or
  // superseded mid-callback cannot receive GitHub binding fields. The status filter
  // after `github_install_flow: null` belongs to the UPDATE, not the earlier SELECT.
  assert.match(callback, /github_install_flow: null,[\s\S]*\.in\("status", \["provisional", "confirmed"\]\)/);
  // OAuth exchange + GET /repos/{owner}/{repo} write proof. Matched against the whole source:
  // these helpers' multi-line `{...}` return-type annotations defeat function-body extraction.
  assert.match(hostedInboxSource, /AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_ID/);
  assert.match(hostedInboxSource, /AGENTIC_FACTORY_GITHUB_OAUTH_CLIENT_SECRET/);
  assert.match(hostedInboxSource, /github_oauth_not_configured/);
  assert.match(hostedInboxSource, /https:\/\/github\.com\/login\/oauth\/access_token/);
  assert.match(hostedInboxSource, /https:\/\/github\.com\/login\/oauth\/authorize/);
  assert.match(hostedInboxSource, /github_oauth_exchange_failed/);
  assert.match(hostedInboxSource, /https:\/\/api\.github\.com\/repos\/\$\{encodeURIComponent\(owner\)\}\/\$\{encodeURIComponent\(repo\)\}/);
  assert.match(hostedInboxSource, /\/repos\/\$\{encodeURIComponent\(owner\)\}\/\$\{encodeURIComponent\(repo\)\}\/installation/);
  assert.match(hostedInboxSource, /AGENTIC_FACTORY_GITHUB_APP_PRIVATE_KEY/);
  assert.match(hostedInboxSource, /const GITHUB_INSTALLATION_DISCOVERY_ATTEMPTS = 3/);
  assert.match(hostedInboxSource, /function retryableGitHubInstallationLookup/);
  assert.match(hostedInboxSource, /retryNotInstalled: false/);
  assert.match(hostedInboxSource, /await delay\(GITHUB_INSTALLATION_DISCOVERY_RETRY_MS/);
  assert.match(hostedInboxSource, /function githubInstallationId/);
  assert.match(hostedInboxSource, /Number\.isSafeInteger\(value\)/);
  assert.match(hostedInboxSource, /permissions\.push === true \|\| [\w.]*permissions\.admin === true/);
  assert.match(hostedInboxSource, /repo_write_permission_required/);
  assert.doesNotMatch(hostedInboxSource, /https:\/\/api\.github\.com\/user\/installations\?per_page=100/);
  assert.doesNotMatch(hostedInboxSource, /githubUserInstallationsInclude|installation_not_owned_by_user/);
});

test("hosted inbox issues repo-bound broker credentials from setup grants", () => {
  const routeHandler = extractServeHandlerBody(hostedInboxSource);
  const requireSetupGrant = extractFunctionBody(hostedInboxSource, "requireSetupGrant");
  const issueBrokerCredential = extractFunctionBody(hostedInboxSource, "issueBrokerCredential");
  const recordBrokerCredentialRemint = extractFunctionBody(hostedInboxSource, "recordBrokerCredentialRemint");
  const nextHostedRemintWindow = extractFunctionBody(hostedInboxSource, "nextBrokerCredentialRemintWindow");
  const memoryIssueBrokerCredential = extractMethodBody(memoryInboxSource, "issueBrokerCredential({");
  const nextMemoryRemintWindow = extractFunctionBody(memoryInboxSource, "nextBrokerCredentialRemintWindow");
  const signBrokerCredential = extractFunctionBody(hostedInboxSource, "signBrokerCredential");

  assert.match(routeHandler, /POST \/v1\/broker-credentials/);
  assert.match(
    routeHandler,
    /issueBrokerCredential\(body, await requireSetupGrant\(req, body, \{ steadyState: true \}\)\)/,
  );
  assert.doesNotMatch(requireSetupGrant, /requireString\(body\.workspaceId/);
  assert.match(requireSetupGrant, /body\.workspaceId != null && String\(body\.workspaceId\) !== grant\.workspace_id/);
  assert.match(hostedInboxSource, /steadyState = false/); // signature default (outside the extracted body)
  // Broker credential (steadyState) accepts a github-verified PROVISIONAL grant too, so init
  // can mint before deferred Linear confirmation; the github_repo_verified_at gate below is
  // the real proof.
  assert.match(requireSetupGrant, /steadyState\s*\?\s*\["provisional",\s*"confirmed"\]/);
  assert.match(requireSetupGrant, /if \(steadyState && !optionalString\(grant\.github_repo_verified_at\)\)/);
  // Bounded relaxation: a provisional grant may mint only within its confirmation window.
  assert.match(requireSetupGrant, /grant\.status === "provisional"[\s\S]{0,120}confirmation_expires_at/);
  assert.match(requireSetupGrant, /if \(steadyState\) return grant/);
  assert.ok(
    requireSetupGrant.indexOf("if (steadyState) return grant") <
      requireSetupGrant.indexOf("Date.parse(String(grant.expires_at))"),
    "steady-state broker re-mint must bypass the 15-minute mutation window",
  );
  assert.ok(
    requireSetupGrant.indexOf("if (steadyState) return grant") <
      requireSetupGrant.indexOf("Number(grant.uses_remaining)"),
    "steady-state broker re-mint must not consume grant uses",
  );
  assert.doesNotMatch(issueBrokerCredential, /requireString\(input\.owner, "owner"\)/);
  assert.doesNotMatch(issueBrokerCredential, /requireString\(input\.repo, "repo"\)/);
  assert.match(issueBrokerCredential, /AGENTIC_FACTORY_BROKER_CREDENTIAL_SIGNING_KEY/);
  assert.match(issueBrokerCredential, /broker_credential_signing_key_not_configured/);
  assert.match(issueBrokerCredential, /optionalString\(grant\.github_owner\)/);
  assert.match(issueBrokerCredential, /optionalString\(grant\.github_repo\)/);
  assert.match(issueBrokerCredential, /optionalString\(grant\.github_repo_verified_at\)/);
  assert.match(issueBrokerCredential, /github_repo_not_verified/);
  assert.match(issueBrokerCredential, /github_installation_not_bound/);
  assert.match(issueBrokerCredential, /workspaceId: String\(grant\.workspace_id\)/);
  assert.match(issueBrokerCredential, /teamId: String\(grant\.team_id\)/);
  assert.match(issueBrokerCredential, /installationId/);
  assert.match(hostedInboxSource, /const BROKER_CREDENTIAL_REMINT_WINDOW_MS = 60 \* 60 \* 1000/);
  assert.match(hostedInboxSource, /const BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW = 30/);
  assert.match(memoryInboxSource, /export const BROKER_CREDENTIAL_REMINT_WINDOW_MS = 60 \* 60 \* 1000/);
  assert.match(memoryInboxSource, /export const BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW = 30/);
  assert.match(issueBrokerCredential, /const now = new Date\(\)\.toISOString\(\)/);
  assert.match(issueBrokerCredential, /await recordBrokerCredentialRemint\(grant, now\)/);
  assert.match(recordBrokerCredentialRemint, /broker_credential_remint_rate_limited/);
  assert.match(recordBrokerCredentialRemint, /last_used_at: issuedAt/);
  assert.match(recordBrokerCredentialRemint, /github_broker_remint_count: remint\.count/);
  assert.match(recordBrokerCredentialRemint, /github_broker_remint_window_started_at: remint\.windowStartedAt/);
  assert.match(nextHostedRemintWindow, /currentCount >= BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW/);
  assert.match(nextHostedRemintWindow, /issuedAtMs - windowStartedAtMs >= BROKER_CREDENTIAL_REMINT_WINDOW_MS/);
  assert.match(memoryIssueBrokerCredential, /const remint = nextBrokerCredentialRemintWindow\(grant, at\)/);
  assert.match(memoryIssueBrokerCredential, /broker_credential_remint_rate_limited/);
  assert.match(memoryIssueBrokerCredential, /grant\.last_used_at = at/);
  assert.match(memoryIssueBrokerCredential, /grant\.github_broker_remint_count = remint\.count/);
  assert.match(memoryIssueBrokerCredential, /grant\.github_broker_remint_window_started_at = remint\.windowStartedAt/);
  assert.match(nextMemoryRemintWindow, /currentCount >= BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW/);
  assert.match(nextMemoryRemintWindow, /issuedAtMs - windowStartedAtMs >= BROKER_CREDENTIAL_REMINT_WINDOW_MS/);
  assert.doesNotMatch(issueBrokerCredential, /input\.owner|input\.repo|input\.workspaceId|input\.workspace_id|input\.teamId|input\.team_id/);
  assert.match(hostedInboxSource, /const BROKER_CREDENTIAL_TTL_SECONDS = 60 \* 60/);
  assert.match(signBrokerCredential, /JSON\.stringify\(payload\)/);
  assert.match(signBrokerCredential, /crypto\.subtle\.importKey\(\s*"raw"[\s\S]*\{ name: "HMAC", hash: "SHA-256" \}/);
  assert.match(signBrokerCredential, /crypto\.subtle\.sign\("HMAC", cryptoKey, new TextEncoder\(\)\.encode\(segment\)\)/);
  assert.match(signBrokerCredential, /BROKER_CREDENTIAL_PREFIX/);
  assert.match(signBrokerCredential, /base64UrlEncode/);
});

test("hosted GitHub broker verifies repo-bound credentials and preserves break-glass", () => {
  const routeHandler = extractServeHandlerBody(brokerSource);
  const resolveBrokerAuth = extractFunctionBody(brokerSource, "resolveBrokerAuth");
  const verifyBrokerCredential = extractFunctionBody(brokerSource, "verifyBrokerCredential");
  const hmacSegment = extractFunctionBody(brokerSource, "hmacBrokerCredentialSegment");
  const verifyInstallation = extractFunctionBody(brokerSource, "verifyInstallation");
  const mintInstallationToken = extractFunctionBody(brokerSource, "mintInstallationToken");
  const enforceInstallation = extractFunctionBody(brokerSource, "enforceBrokerCredentialInstallationScope");

  assert.match(routeHandler, /const auth = await resolveBrokerAuth\(req\)/);
  assert.match(routeHandler, /verifyInstallation\(body, auth\)/);
  assert.match(routeHandler, /mintInstallationToken\(body, auth\)/);
  assert.match(brokerSource, /const BROKER_CREDENTIAL_HEADER = "x-agentic-factory-github-broker-credential"/);
  assert.match(brokerSource, /const BROKER_CREDENTIAL_PREFIX = "af_broker_v1"/);
  assert.match(resolveBrokerAuth, /AGENTIC_FACTORY_BROKER_CREDENTIAL_SIGNING_KEY/);
  assert.match(resolveBrokerAuth, /broker_credential_signing_key_not_configured/);
  assert.match(resolveBrokerAuth, /invalid_github_broker_credential/);
  assert.match(resolveBrokerAuth, /AGENTIC_FACTORY_GITHUB_BROKER_TOKEN/);
  assert.match(resolveBrokerAuth, /mode: "break_glass"/);
  assert.match(verifyBrokerCredential, /parts\.length !== 3 \|\| parts\[0\] !== BROKER_CREDENTIAL_PREFIX/);
  assert.match(verifyBrokerCredential, /hmacBrokerCredentialSegment\(\{ key, segment \}\)/);
  assert.match(verifyBrokerCredential, /constantTimeEqual\(sig, expectedSig\)/);
  assert.match(verifyBrokerCredential, /JSON\.parse\(new TextDecoder\(\)\.decode\(base64UrlDecode\(segment\)\)\)/);
  assert.match(verifyBrokerCredential, /payload\.exp <= nowSeconds/);
  assert.match(hmacSegment, /crypto\.subtle\.importKey\(\s*"raw"[\s\S]*\{ name: "HMAC", hash: "SHA-256" \}/);
  assert.match(hmacSegment, /crypto\.subtle\.sign\("HMAC", cryptoKey, new TextEncoder\(\)\.encode\(segment\)\)/);
  assert.match(brokerSource, /function constantTimeEqual\(a: string, b: string\)/);
  assert.match(verifyInstallation, /enforceBrokerCredentialRepoScope\(auth, \{ owner, repo \}\)/);
  assert.match(mintInstallationToken, /enforceBrokerCredentialRepoScope\(auth, \{ owner, repo \}\)/);
  assert.match(verifyInstallation, /enforceBrokerCredentialInstallationScope\(auth, installation\)/);
  assert.match(mintInstallationToken, /enforceBrokerCredentialInstallationScope\(auth, \{ id: verified\.installation\.id \}\)/);
  assert.match(enforceInstallation, /broker_credential_installation_mismatch/);
  assert.match(brokerSource, /broker_credential_repo_mismatch/);
});

test("hosted Edge Functions do not emit wildcard CORS headers", () => {
  assert.doesNotMatch(hostedInboxSource, /access-control-allow-origin/i);
  assert.doesNotMatch(brokerSource, /access-control-allow-origin/i);
  assert.match(hostedInboxSource, /if \(req\.method === "OPTIONS"\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(brokerSource, /if \(req\.method === "OPTIONS"\) return new Response\(null, \{ status: 204 \}\)/);
});

test("legacy wake routing repair recovers or quarantines, and never silently strands queued wakes", () => {
  // Recovery reads the derived trigger_events.webhook_id column...
  assert.match(
    legacyWakeRepairMigration,
    /set webhook_ids = jsonb_build_array\(e\.webhook_id\)/,
  );
  // ...never raw_payload (executable SQL only; the header comment may name it),
  // so the repair is decoupled from the data-minimization scrub.
  const repairSql = legacyWakeRepairMigration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(repairSql, /raw_payload/);
  // Unrecovered queued legacy wakes are terminally dead-lettered (visible, frees the
  // active wake-key slot so the source project regenerates) rather than left invisible
  // or falsely presented as requeueable.
  assert.match(legacyWakeRepairMigration, /set status = 'dead_letter'/);
  assert.match(legacyWakeRepairMigration, /reason = 'legacy_wake_missing_routing_identity'/);
  // Idempotent and tightly scoped: only queued wakes with an empty webhook_ids array.
  assert.match(legacyWakeRepairMigration, /where status = 'queued'\s*\n\s*and webhook_ids = '\[\]'::jsonb/);
});

function extractSetStrings(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `missing ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  // Skip the parameter list before the body brace: a destructured parameter
  // (e.g. claimWake's `{ storedCapabilities = null }`) opens a brace that is not
  // the function body. Walk paren depth from the param list's `(` to its match,
  // then take the next `{` as the body.
  const parenOpen = source.indexOf("(", start);
  assert.notEqual(parenOpen, -1, `missing parameter list for ${name}`);
  let depth = 0;
  let index = parenOpen;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return extractBodyFromOpenBrace(source, source.indexOf("{", index));
}

function extractMethodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing method ${signature}`);
  // Same parameter-list skip as extractFunctionBody: mirror methods use
  // destructured params (e.g. listWakeViews({ workspaceId, ... } = {})) whose
  // brace precedes the body brace.
  const parenOpen = source.indexOf("(", start);
  assert.notEqual(parenOpen, -1, `missing parameter list for ${signature}`);
  let depth = 0;
  let index = parenOpen;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return extractBodyFromOpenBrace(source, source.indexOf("{", index));
}

function extractServeHandlerBody(source) {
  const start = source.indexOf("Deno.serve");
  assert.notEqual(start, -1, "missing Deno.serve handler");
  return extractBodyFromOpenBrace(source, source.indexOf("{", start));
}

function extractStructuredLogFieldBodies(source, eventName) {
  const bodies = [];
  const needle = `emitHostedSecurityLog("${eventName}"`;
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    const openBrace = source.indexOf("{", start);
    assert.notEqual(openBrace, -1, `missing structured security log fields for ${eventName}`);
    bodies.push(extractBodyFromOpenBrace(source, openBrace));
    from = openBrace + 1;
  }
  assert.ok(bodies.length > 0, `missing structured security log event ${eventName}`);
  return bodies;
}

function extractBodyFromOpenBrace(source, openBrace) {
  assert.notEqual(openBrace, -1, "missing opening brace");
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  throw new Error("missing closing brace");
}
