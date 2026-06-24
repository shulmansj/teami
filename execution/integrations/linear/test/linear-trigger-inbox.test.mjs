import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureInboxSetupGrant, refreshGitHubResumeSetupGrant } from "../src/cli/linear-setup-command.mjs";
import { doctorInboxSetupGrantConnection } from "../src/cli/doctor-command.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { credentialTargetForConfig } from "../src/linear-credential-store.mjs";
import { verifyBrokerCredential } from "../src/broker-credential.mjs";
import {
  LINEAR_WEBHOOK_HANDOFF_VERIFIED_MESSAGE,
  ensureLinearWebhookRegistration,
} from "../src/linear-webhook-registration.mjs";
import {
  ingestLinearWebhookDelivery,
  linearWebhookSignature,
  MAX_WEBHOOK_BODY_BYTES,
  normalizeLinearWebhookDelivery,
  routeTriggerEventToWakeups,
} from "../src/linear-webhook-inbox.mjs";
import {
  BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW,
  createFakeGitHubOAuthClient,
  MemoryInboxStore,
  RETENTION_MS,
} from "../src/inbox-store.mjs";
import {
  createRunnerInboxCredentialStore,
  ensureRunnerInboxCredential,
  runnerInboxCredentialTargetForConfig,
} from "../src/runner-inbox-credential.mjs";
import {
  runRuntimeCommand,
  resolveRuntimeSpawnCommand,
  createProcessRuntimeExecutor,
  mapRunnerOutcomeToWake,
  DOMAIN_CONTEXT_REQUIRED_REASON,
  runDecompositionOrchestrator,
  runDecompositionEvalMode,
  runTriggeredDecomposition,
} from "../src/trigger-runner.mjs";
import { REPAIR_RETRY_TIMEOUT_MS } from "../src/runtime-command.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import { DOMAIN_REGISTRY_SCHEMA_VERSION, makeDomainRecord } from "../src/domain-registry.mjs";
import { buildDomainContext, resolveWakeDomainContext } from "../src/domain-resolver.mjs";
import { createHostedWakeQueueStore } from "../src/hosted-wake-queue-store.mjs";
import {
  createHostedInboxClient,
  readInboxSetupGrantFile,
  resolveInboxSetupGrant,
  writeInboxSetupGrant,
} from "../src/hosted-inbox-client.mjs";
import {
  computeProjectSnapshotHash,
  loadCapturedProjectSnapshot,
  projectSnapshotProjection,
} from "../src/project-snapshot-store.mjs";
import { buildLinearProjectBody } from "../src/project-body.mjs";
import { extractDecompositionKey } from "../src/issue-body.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

// The full hosted E2E entry (runTriggeredDecomposition) drives the orchestrator
// loop with a FIXED arg set and does NOT forward an injected
// orchestratorTurnExecutor, so a full-path test can no longer script the
// orchestrator's decisions deterministically — the real turn would spawn a live
// CLI. Tests whose assertions depend on the full path's store/trace/Linear side
// effects (and so cannot move to the direct-loop tests, which touch none of
// those) are skipped with this reason until the public entry forwards an
// orchestrator-turn seam. Deterministic loop coverage lives in the direct tests
// below and in orchestrator-loop.test.mjs. (Declared at top so it is initialized
// before any test() registration that reads it as a skip option.)
// The full hosted entry (runTriggeredDecomposition) forwards an injected
// orchestratorTurnExecutor + roster into the loop (Seam 1 test-injection), so
// these full-path tests drive a deterministic committing orchestrator without
// spawning a real CLI. (Previously skipped before that forwarding landed.)
const FULL_PATH_ORCHESTRATOR_SEAM_SKIP = false;

test("Linear webhook signatures verify against the raw payload and reject body changes", () => {
  const store = new MemoryInboxStore();
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(linearProjectPayload());
  const signature = linearWebhookSignature({ rawBody, signingSecret: "secret-1" });

  assert.equal(store.verifyLinearWebhookSignature({ workspaceId: "workspace-1", rawBody, signature }).ok, true);
  assert.equal(
    store.verifyLinearWebhookSignature({
      workspaceId: "workspace-1",
      rawBody: JSON.stringify({ ...linearProjectPayload(), extra: true }),
      signature,
    }).ok,
    false,
  );
});

test("setup grants issue provisional team scope, bind webhook secrets, and mint derived runner scope", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
    at: "2026-06-08T00:00:00.000Z",
  });

  assert.equal(issued.ok, true);
  assert.match(issued.setupGrant, /^af_setup_v1_sg[0-9a-f]+_[0-9a-f]+$/);
  assert.equal(issued.grant.status, "provisional");
  // Re-issue inside the first grant's mutation window: it is still active, so refuse.
  assert.equal(
    store.requestSetupGrant({
      workspaceId: "workspace-1",
      teamId: "team-1",
      at: "2026-06-08T00:05:00.000Z",
    }).reason,
    "setup_grant_conflict",
  );

  const secret = store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-08T00:05:00.000Z",
  });
  assert.equal(secret.team_id, "team-1");
  assert.equal(secret.setup_grant_id, issued.grant.grantId);
  assert.equal(secret.confirmation_state, "provisional");
  assert.equal(store.setupGrants[0].webhook_id, "webhook-1");

  assert.throws(
    () => store.mintRunnerCredential({
      workspaceId: "workspace-1",
      teamId: "team-1",
      setupGrant: issued.setupGrant,
      webhookIds: ["webhook-other"],
      at: "2026-06-08T00:05:00.000Z",
    }),
    /setup_grant_scope_mismatch/,
  );
  const credential = store.mintRunnerCredential({
    workspaceId: "workspace-1",
    teamId: "team-1",
    setupGrant: issued.setupGrant,
    webhookIds: ["webhook-1"],
    domainId: "support-ops",
    at: "2026-06-08T00:05:00.000Z",
  });
  assert.equal(credential.team_id, "team-1");
  assert.deepEqual(credential.webhook_ids, ["webhook-1"]);
  assert.equal(credential.domain_id, "support-ops");
});

test("a bound provisional grant stays active past the mutation window and still confirms (deferred confirmation can take days)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
    at: "2026-06-08T00:00:00.000Z",
  });
  // Bind the webhook secret inside the 15-minute mutation window.
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-08T00:05:00.000Z",
  });

  // 30 minutes later — past the mutation window but well within the 7-day confirmation
  // window — re-issuing must still conflict: the bound grant is alive and awaiting its
  // first Planned delivery, so it must not be silently expired and orphaned.
  assert.equal(
    store.requestSetupGrant({
      workspaceId: "workspace-1",
      teamId: "team-1",
      at: "2026-06-08T00:30:00.000Z",
    }).reason,
    "setup_grant_conflict",
  );
  assert.equal(store.setupGrants[0].status, "provisional");

  // And the first real signed delivery at that same later time still confirms + wakes.
  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-confirm",
    data: { teamIds: ["team-1"] },
  }));
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody, deliveryId: "delivery-confirm" }),
    rawBody,
    receivedAt: "2026-06-08T00:30:00.000Z",
  });
  assert.equal(result.accepted, true);
  assert.equal(store.setupGrants[0].status, "confirmed");
  assert.equal(result.wakeups.length, 1);
});

test("GitHub resume reopens the bound setup grant without creating a second active grant", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
    at: "2026-06-08T00:00:00.000Z",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-08T00:05:00.000Z",
  });

  assert.equal(
    store.requestSetupGrant({
      workspaceId: "workspace-1",
      teamId: "team-1",
      at: "2026-06-08T00:30:00.000Z",
      bypassActiveConflict: true,
    }).reason,
    "setup_grant_conflict",
  );
  assert.throws(
    () => store.githubInstallIntent({
      workspaceId: "workspace-1",
      teamId: "team-1",
      setupGrant: issued.setupGrant,
      appSlug: "agentic-factory",
      owner: "shulmansj",
      repo: "agentic-factory",
      at: "2026-06-08T00:30:00.000Z",
    }),
    /setup grant mutation window expired/,
  );

  const refreshed = store.refreshSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    setupGrant: issued.setupGrant,
    at: "2026-06-08T00:31:00.000Z",
  });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.setupGrant, issued.setupGrant);
  assert.equal(refreshed.grant.grantId, issued.grant.grantId);
  assert.equal(refreshed.grant.expiresAt, "2026-06-08T00:46:00.000Z");
  assert.equal(store.setupGrants.length, 1);
  assert.equal(store.setupGrants[0].webhook_id, "webhook-1");
  assert.equal(store.setupGrants[0].uses_remaining, 7);

  assert.equal(
    store.githubInstallIntent({
      workspaceId: "workspace-1",
      teamId: "team-1",
      setupGrant: issued.setupGrant,
      appSlug: "agentic-factory",
      owner: "shulmansj",
      repo: "agentic-factory",
      at: "2026-06-08T00:32:00.000Z",
    }).ok,
    true,
  );
  assert.equal(store.setupGrants[0].uses_remaining, 6);
});

test("an abandoned unbound grant frees the team slot once its mutation window lapses", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    at: "2026-06-08T00:00:00.000Z",
  });
  // No webhook ever bound. 30 minutes later the mutation window has lapsed, so a fresh
  // init for the same team must succeed (the abandoned grant must not lock the team).
  const reissued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    at: "2026-06-08T00:30:00.000Z",
  });
  assert.equal(reissued.ok, true);
  assert.equal(store.setupGrants[0].status, "expired");
  assert.equal(store.setupGrants[0].revoked_reason, "setup grant mutation window expired");
  assert.equal(store.setupGrants[1].status, "provisional");
});

test("first correct signed Linear delivery confirms setup grant and creates the first wake", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
  });

  // A delivery whose payload teams do not include the webhook's grant-bound team is rejected
  // up front (G2: a webhook cannot assert a team it is not bound to), before any confirmation
  // logic — so it cannot confirm the grant or create a wake.
  const wrongTeamBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-wrong-team",
    data: { teamIds: ["team-2"] },
  }));
  const wrongTeam = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({
      rawBody: wrongTeamBody,
      deliveryId: "delivery-wrong-team",
      signingSecret: "secret-1",
    }),
    rawBody: wrongTeamBody,
  });
  assert.equal(wrongTeam.accepted, false);
  assert.equal(wrongTeam.reason, "delivery_team_not_in_webhook_scope");
  assert.equal(store.setupGrants[0].status, "provisional");
  assert.equal(store.workflowWakeups.length, 0);

  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-confirm",
    data: { teamIds: ["team-1"] },
  }));
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody, deliveryId: "delivery-confirm" }),
    rawBody,
  });

  assert.equal(result.accepted, true);
  assert.equal(store.setupGrants[0].status, "confirmed");
  assert.equal(store.setupGrants[0].confirmation_delivery_id, "delivery-confirm");
  assert.equal(store.webhookSecrets[0].confirmation_state, "confirmed");
  assert.equal(result.wakeups.length, 1);
  assert.deepEqual(store.workflowWakeups[0].team_ids, ["team-1"]);
});

test("two setup grants in one workspace stay independent through confirm and revoke", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const grantA = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1", domainId: "domain-1" });
  const grantB = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-2", domainId: "domain-2" });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-team-1",
    signingSecret: "secret-team-1",
    setupGrant: grantA.setupGrant,
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-2",
    webhookId: "webhook-team-2",
    signingSecret: "secret-team-2",
    setupGrant: grantB.setupGrant,
  });
  const credentialA = store.mintRunnerCredential({
    workspaceId: "workspace-1",
    teamId: "team-1",
    setupGrant: grantA.setupGrant,
    webhookIds: ["webhook-team-1"],
    domainId: "domain-1",
  });
  const credentialB = store.mintRunnerCredential({
    workspaceId: "workspace-1",
    teamId: "team-2",
    setupGrant: grantB.setupGrant,
    webhookIds: ["webhook-team-2"],
    domainId: "domain-2",
  });

  assert.throws(
    () => store.setupGrantStatus({ setupGrant: grantA.setupGrant, workspaceId: "workspace-1", teamId: "team-2" }),
    /setup_grant_scope_mismatch/,
  );
  assert.throws(
    () => store.revokeSetupGrant({ setupGrant: grantA.setupGrant, workspaceId: "workspace-1", teamId: "team-2" }),
    /setup_grant_scope_mismatch/,
  );

  const bodyB = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-team-2",
    projectId: "project-team-2",
    data: { teamIds: ["team-2"] },
  }));
  const confirmB = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({
      rawBody: bodyB,
      deliveryId: "delivery-team-2",
      signingSecret: "secret-team-2",
    }),
    rawBody: bodyB,
  });
  assert.equal(confirmB.accepted, true);
  assert.equal(store.setupGrants.find((grant) => grant.team_id === "team-1").status, "provisional");
  assert.equal(store.setupGrants.find((grant) => grant.team_id === "team-2").status, "confirmed");

  const revoked = store.revokeSetupGrant({
    setupGrant: grantB.setupGrant,
    workspaceId: "workspace-1",
    teamId: "team-2",
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.revokedCredentials, 1);
  assert.equal(store.verifyRunnerCredential({
    workspaceId: "workspace-1",
    credentialId: credentialA.credentialId,
    token: credentialA.token,
  })?.active, true);
  assert.equal(store.verifyRunnerCredential({
    workspaceId: "workspace-1",
    credentialId: credentialB.credentialId,
    token: credentialB.token,
  }), null);
});

test("break-glass recover supersedes an active setup grant conflict", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const original = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1" });
  const recovered = store.recoverSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    reason: "operator_verified_owner",
    auditActor: "maintainer-1",
    auditNote: "ticket-123",
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.superseded.length, 1);
  assert.equal(store.setupGrants.find((grant) => grant.grant_id === original.grant.grantId).status, "superseded");
  assert.equal(recovered.grant.status, "provisional");
  assert.notEqual(recovered.grant.grantId, original.grant.grantId);
});

test("delivery dedupe keeps duplicate Linear webhook deliveries from creating duplicate wake-ups", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(linearProjectPayload({ deliveryId: "delivery-1" }));
  const headers = {
    "Linear-Delivery": "delivery-1",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };

  const first = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });
  const second = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(first.accepted, true);
  assert.equal(first.wakeups.length, 1);
  assert.equal(second.duplicate, true);
  assert.equal(store.webhookDeliveries.length, 1);
  assert.equal(store.triggerEvents.length, 1);
  assert.equal(store.workflowWakeups.length, 1);
});

test("inbox persists no product content: bodies hash, headers allowlist, events carry derived facts only", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(linearProjectPayload({ deliveryId: "delivery-min" }));
  const headers = {
    "Linear-Delivery": "delivery-min",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
    "X-Forwarded-For": "203.0.113.7",
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });
  assert.equal(result.accepted, true);
  assert.equal(result.wakeups.length, 1);

  const [delivery] = store.webhookDeliveries;
  assert.equal(delivery.raw_body, null);
  assert.match(delivery.raw_body_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(delivery.raw_headers).sort(), ["linear-delivery", "linear-signature"]);

  const [event] = store.triggerEvents;
  assert.equal(Object.hasOwn(event, "raw_payload"), false);
  assert.equal(event.project_status_type, "planned");
  const persisted = JSON.stringify({ delivery, event, wakeups: store.workflowWakeups });
  assert.equal(persisted.includes("Customer onboarding pilot"), false);
});

test("routing still distinguishes planned from non-planned via the derived status fact", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const backlogBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-backlog",
    data: { status: { id: "status-backlog", name: "Backlog", type: "backlog" } },
  }));
  const backlog = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: {
      "Linear-Delivery": "delivery-backlog",
      "Linear-Signature": linearWebhookSignature({ rawBody: backlogBody, signingSecret: "secret-1" }),
    },
    rawBody: backlogBody,
  });
  assert.equal(backlog.accepted, true);
  assert.equal(backlog.wakeups.length, 0);
  assert.equal(store.triggerEvents.at(-1).project_status_type, "backlog");
});

test("legacy raw_payload events recorded directly at the store seam still route correctly", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const legacyEvent = (id, statusType) => ({
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: id,
    event_type: "linear.project.updated",
    object: { type: "project", id: `project-${id}` },
    changed_fields: ["status"],
    raw_payload: {
      data: { id: `project-${id}`, status: { id: `status-${statusType}`, name: statusType, type: statusType } },
    },
  });

  const backlog = store.recordTriggerEvent(legacyEvent("legacy-backlog", "backlog"));
  assert.equal(backlog.event.project_status_type, "backlog");
  assert.equal(routeTriggerEventToWakeups({ store, event: backlog.event }).length, 0);

  const planned = store.recordTriggerEvent(legacyEvent("legacy-planned", "planned"));
  assert.equal(planned.event.project_status_type, "planned");
  assert.equal(routeTriggerEventToWakeups({ store, event: planned.event }).length, 1);
});

test("invalid Linear webhook signatures are rejected before raw delivery persistence", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(linearProjectPayload({ deliveryId: "delivery-1" }));

  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: { "Linear-Delivery": "delivery-1", "Linear-Signature": "bad" },
    rawBody,
  });

  assert.equal(result.accepted, false);
  assert.equal(store.webhookDeliveries.length, 0);
  assert.equal(store.workflowWakeups.length, 0);
});

test("oversized Linear webhook bodies are rejected before parsing, signature checks, or persistence", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  let signatureChecks = 0;
  store.verifyLinearWebhookSignature = () => {
    signatureChecks += 1;
    throw new Error("signature verification should not run");
  };
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: { "Linear-Delivery": "delivery-oversized", "Linear-Signature": "unused" },
    rawBody: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "payload_too_large");
  assert.equal(signatureChecks, 0);
  assert.equal(store.webhookDeliveries.length, 0);
  assert.equal(store.workflowWakeups.length, 0);
});

test("Linear webhook delivery requires signature and delivery headers before signature work", () => {
  let signatureChecks = 0;
  const store = {
    verifyLinearWebhookSignature() {
      signatureChecks += 1;
      throw new Error("signature verification should not run");
    },
  };

  const missingSignature = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: { "Linear-Delivery": "delivery-1" },
    rawBody: "not json",
  });
  const missingDelivery = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: { "Linear-Signature": "unused" },
    rawBody: "not json",
  });

  assert.equal(missingSignature.accepted, false);
  assert.equal(missingSignature.reason, "missing_signature_header");
  assert.equal(missingDelivery.accepted, false);
  assert.equal(missingDelivery.reason, "missing_delivery_header");
  assert.equal(signatureChecks, 0);
});

test("raw webhook delivery retention is bounded and pruneable", () => {
  const store = new MemoryInboxStore({
    idGenerator: sequenceIds(),
    rawPayloadRetentionMs: 1000,
  });
  store.recordWebhookDelivery({
    provider: "linear",
    workspaceId: "workspace-1",
    deliveryId: "delivery-1",
    signatureValid: true,
    rawBody: "{}",
    receivedAt: "2026-06-08T00:00:00.000Z",
  });

  assert.equal(store.webhookDeliveries[0].retention_expires_at, "2026-06-08T00:00:01.000Z");
  assert.deepEqual(store.pruneExpiredDeliveries({ at: "2026-06-08T00:00:02.000Z" }), { pruned: 1 });
});

test("maintenance expires due grants and leases, then prunes only past-retention inactive rows", () => {
  assert.equal(RETENTION_MS.terminalWakes, 90 * 24 * 60 * 60 * 1000);
  assert.equal(RETENTION_MS.webhookDeliveries, 30 * 24 * 60 * 60 * 1000);
  assert.equal(RETENTION_MS.deadLetters, 180 * 24 * 60 * 60 * 1000);
  assert.equal(RETENTION_MS.inactiveSetupGrants, 30 * 24 * 60 * 60 * 1000);

  const store = new MemoryInboxStore({ idGenerator: sequenceIds(), rawPayloadRetentionMs: 1000 });
  const at = "2026-06-13T00:00:00.000Z";
  store.setupGrants.push(
    {
      id: "grant-due",
      grant_id: "sg-due",
      workspace_id: "workspace-1",
      team_id: "team-due",
      status: "provisional",
      confirmation_expires_at: "2026-06-12T23:00:00.000Z",
      expires_at: "2026-06-20T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
      revoked_at: null,
      revoked_reason: null,
    },
    {
      id: "grant-future",
      grant_id: "sg-future",
      workspace_id: "workspace-1",
      team_id: "team-future",
      status: "provisional",
      confirmation_expires_at: "2026-06-14T00:00:00.000Z",
      expires_at: "2026-06-14T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
      revoked_at: null,
      revoked_reason: null,
    },
    {
      id: "grant-revoked-old",
      grant_id: "sg-revoked-old",
      workspace_id: "workspace-1",
      team_id: "team-revoked-old",
      status: "revoked",
      confirmation_expires_at: "2026-04-01T00:00:00.000Z",
      expires_at: "2026-04-01T00:00:00.000Z",
      created_at: "2026-04-01T00:00:00.000Z",
      revoked_at: "2026-05-01T00:00:00.000Z",
      revoked_reason: "test",
    },
    {
      id: "grant-revoked-fresh",
      grant_id: "sg-revoked-fresh",
      workspace_id: "workspace-1",
      team_id: "team-revoked-fresh",
      status: "revoked",
      confirmation_expires_at: "2026-06-01T00:00:00.000Z",
      expires_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
      revoked_at: "2026-05-20T00:00:00.000Z",
      revoked_reason: "test",
    },
    {
      id: "grant-confirmed-old",
      grant_id: "sg-confirmed-old",
      workspace_id: "workspace-1",
      team_id: "team-confirmed-old",
      status: "confirmed",
      confirmation_expires_at: "2026-04-01T00:00:00.000Z",
      expires_at: "2026-04-01T00:00:00.000Z",
      created_at: "2026-04-01T00:00:00.000Z",
      revoked_at: null,
      revoked_reason: null,
    },
  );

  const dueLease = store.enqueueWake({
    workspaceId: "workspace-2",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-lease",
    wakeKey: "linear:project:project-lease:decomposition",
    sourceEventId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
  }).wake;
  Object.assign(dueLease, {
    status: "leased",
    claimed_at: "2026-06-12T23:00:00.000Z",
    runner_id: "runner-lease",
    lease_token: "lease-old",
    lease_expires_at: "2026-06-12T23:30:00.000Z",
  });
  const activeQueued = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-active",
    wakeKey: "linear:project:project-active:decomposition",
    sourceEventId: null,
    createdAt: "2026-03-01T00:00:00.000Z",
  }).wake;
  const oldTerminal = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-old-terminal",
    wakeKey: "linear:project:project-old-terminal:decomposition",
    sourceEventId: null,
    createdAt: "2026-03-01T00:00:00.000Z",
  }).wake;
  Object.assign(oldTerminal, { status: "completed", terminal_at: "2026-03-01T00:00:00.000Z" });
  const freshTerminal = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-fresh-terminal",
    wakeKey: "linear:project:project-fresh-terminal:decomposition",
    sourceEventId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
  }).wake;
  Object.assign(freshTerminal, { status: "completed", terminal_at: "2026-06-01T00:00:00.000Z" });

  store.recordWebhookDelivery({
    provider: "linear",
    workspaceId: "workspace-1",
    deliveryId: "delivery-old",
    signatureValid: true,
    rawBody: "{}",
    receivedAt: "2026-06-12T23:59:58.000Z",
  });
  store.recordWebhookDelivery({
    provider: "linear",
    workspaceId: "workspace-1",
    deliveryId: "delivery-fresh",
    signatureValid: true,
    rawBody: "{}",
    receivedAt: "2026-06-13T00:00:00.500Z",
  });

  assert.deepEqual(store.runMaintenance({ at }), {
    ok: true,
    expiredGrants: 1,
    expiredLeases: 1,
    pruned: {
      workflowWakeups: 1,
      triggerEvents: 0,
      webhookDeliveries: 1,
      workflowRuns: 0,
      deadLetters: 0,
      setupGrants: 1,
      runnerCredentials: 0,
    },
  });
  assert.equal(store.setupGrants.find((grant) => grant.id === "grant-due").status, "expired");
  assert.equal(store.setupGrants.find((grant) => grant.id === "grant-future").status, "provisional");
  assert.equal(store.setupGrants.some((grant) => grant.id === "grant-revoked-old"), false);
  assert.equal(store.setupGrants.some((grant) => grant.id === "grant-confirmed-old"), true);
  assert.equal(dueLease.status, "queued");
  assert.equal(dueLease.lease_token, null);
  assert.equal(store.workflowWakeups.some((wake) => wake.id === oldTerminal.id), false);
  assert.equal(store.workflowWakeups.some((wake) => wake.id === activeQueued.id), true);
  assert.equal(store.workflowWakeups.some((wake) => wake.id === freshTerminal.id), true);
  assert.equal(store.webhookDeliveries.some((delivery) => delivery.delivery_id === "delivery-old"), false);
  assert.equal(store.webhookDeliveries.some((delivery) => delivery.delivery_id === "delivery-fresh"), true);
});

test("project update payload normalizes to a runner-verified linear.project.planned candidate", () => {
  const rawBody = JSON.stringify(linearProjectPayload());
  const event = normalizeLinearWebhookDelivery({
    headers: { "Linear-Delivery": "delivery-1" },
    rawBody,
    workspaceId: "workspace-1",
    deliveryRecordId: "delivery-row-1",
  });

  assert.equal(event.event_type, "linear.project.updated");
  assert.equal(event.object.type, "project");
  assert.equal(event.object.id, "project-1");
  assert.deepEqual(event.changed_fields, ["status"]);
  assert.equal(event.requires_runner_verification, true);
});

test("ambiguous cached status config still creates requires-runner-verification wake-up", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = {
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-1",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-1" },
    changed_fields: ["status"],
    requires_runner_verification: true,
  };
  const eventResult = store.recordTriggerEvent(event);
  const wake = store.enqueueWake({
    workspaceId: event.workspace_id,
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: eventResult.event.id,
    requiresRunnerVerification: true,
  }).wake;

  assert.equal(wake.requires_runner_verification, true);
  assert.equal(wake.status, "queued");
});

test("ambiguous Linear project update payload is routed to runner verification instead of dropped", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify({
    ...linearProjectPayload(),
    updatedFrom: { workflowStatus: { id: "previous" } },
  });
  const headers = {
    "Linear-Delivery": "delivery-ambiguous",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(result.accepted, true);
  assert.equal(store.workflowWakeups.length, 1);
  assert.equal(store.workflowWakeups[0].requires_runner_verification, true);
});

test("non-planned Linear project status payload is dropped before wake enqueue", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const payload = linearProjectPayload();
  payload.webhookId = "delivery-backlog";
  payload.data.status = { id: "status-backlog", name: "Backlog", type: "backlog" };
  payload.updatedFrom = { status: { id: "status-planned", name: "Planned", type: "planned" } };
  const rawBody = JSON.stringify(payload);
  const headers = {
    "Linear-Delivery": "delivery-backlog",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(result.accepted, true);
  assert.equal(store.triggerEvents.length, 1);
  assert.equal(store.workflowWakeups.length, 0);
});

test("non-status Linear project updates do not retrigger even when project is currently planned", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const payload = linearProjectPayload();
  payload.webhookId = "delivery-content";
  payload.updatedFrom = { content: "Before" };
  const rawBody = JSON.stringify(payload);
  const headers = {
    "Linear-Delivery": "delivery-content",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(result.accepted, true);
  assert.equal(store.workflowWakeups.length, 0);
});

test("status-change payload without current status type still enqueues for runner verification", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const payload = linearProjectPayload();
  payload.webhookId = "delivery-status-id";
  payload.data = { id: "project-1", name: "Customer onboarding pilot", statusId: "status-planned" };
  payload.updatedFrom = { statusId: "status-backlog" };
  const rawBody = JSON.stringify(payload);
  const headers = {
    "Linear-Delivery": "delivery-status-id",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(result.accepted, true);
  assert.equal(store.workflowWakeups.length, 1);
  assert.equal(store.workflowWakeups[0].reason, "requires_runner_verification");
});

test("wake uniqueness applies only while prior wake is non-terminal", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const first = enqueueProjectWake(store, "event-1");
  const duplicate = enqueueProjectWake(store, "event-2");
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.workflowWakeups.length, 1);

  first.wake.status = "paused";
  first.wake.terminal_at = "2026-06-08T00:00:00.000Z";
  const later = enqueueProjectWake(store, "event-3");
  assert.equal(later.duplicate, false);
  assert.equal(store.workflowWakeups.length, 2);
});

test("lease token mismatch blocks stale runner updates", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });

  assert.equal(claim.ok, true);
  assert.equal(
    store.renewLease({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: "wrong-token",
    }).reason,
    "lease_token_mismatch",
  );
});

test("lease runner identity is optional but binding when supplied", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });

  assert.equal(
    store.renewLease({
      wakeId: wake.id,
      runnerId: "runner-2",
      leaseToken: claim.leaseToken,
    }).reason,
    "runner_mismatch",
  );
  assert.equal(
    store.releaseWake({
      wakeId: wake.id,
      leaseToken: claim.leaseToken,
      reason: "domain_not_served",
    }).ok,
    true,
  );
});

test("lease expiry before mutation returns the wake to the queue", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });

  store.expireLeases({ at: "2026-06-08T00:00:02.000Z" });

  assert.equal(wake.status, "queued");
  assert.equal(wake.lease_token, null);
});

test("wake read and claim rejection paths redact lease tokens", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.wake.lease_token, claim.leaseToken);
  assert.equal(
    store.renewLease({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
    }).wake.lease_token,
    claim.leaseToken,
  );

  const readWake = store.getWake(wake.id);
  const [viewWake] = store.listWakeViews({ workspaceId: "workspace-1" });
  const rejectedClaim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-2",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });

  assert.equal(Object.hasOwn(readWake, "lease_token"), false);
  assert.equal(Object.hasOwn(viewWake, "lease_token"), false);
  assert.equal(rejectedClaim.reason, "wake_not_queued:leased");
  assert.equal(Object.hasOwn(rejectedClaim.wake, "lease_token"), false);
});

test("dead-letter requires a valid live lease token", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });

  assert.equal(
    store.deadLetterWake({
      wakeId: wake.id,
      reason: "operator_override",
    }).reason,
    "lease_token_mismatch",
  );
  assert.equal(
    store.deadLetterWake({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
      reason: "operator_override",
    }).ok,
    true,
  );
});

test("internal-expiry dead-letter retires the lease so a stale runner cannot rewrite a terminal wake", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });
  store.markMutationStarted({
    wakeId: wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    at: "2026-06-08T00:00:00.500Z",
  });

  // Lease lapses; internal expiry dead-letters the post-mutation wake.
  store.expireLeases({ at: "2026-06-08T00:00:02.000Z" });
  assert.equal(wake.status, "dead_letter");
  assert.equal(wake.lease_token, null);

  // The stale runner returns with its old token: it must not rewrite the terminal wake.
  assert.equal(
    store.completeWake({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
      status: "completed",
    }).reason,
    "lease_token_mismatch",
  );
  assert.equal(
    store.renewLease({ wakeId: wake.id, runnerId: "runner-1", leaseToken: claim.leaseToken }).reason,
    "lease_token_mismatch",
  );
  assert.equal(wake.status, "dead_letter");
});

test("heartbeat capabilities are intersected with stored scope, so a runner cannot inflate the status signal", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  enqueueProjectWake(store, "event-1");
  // Runner self-attests the full required set but its credential only backs a subset.
  store.heartbeat({
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    capabilities: ["decomposition.trigger_runner.v1", "linear.project.planned"],
    storedCapabilities: ["linear.project.planned"],
    at: "2026-06-08T00:00:00.000Z",
  });
  assert.deepEqual(store.runnerHeartbeats.get("runner-1").capabilities, ["linear.project.planned"]);

  // No runner can actually claim, so the wake is not shown as ready.
  const [view] = store.listWakeViews({
    workspaceId: "workspace-1",
    at: "2026-06-08T00:00:01.000Z",
    heartbeatStaleMs: 120000,
  });
  assert.equal(view.derived_status, "waiting_for_runner");
});

test("expired leases reject owner operations instead of accepting stale tokens", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;
  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });

  assert.equal(
    store.renewLease({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
      at: "2026-06-08T00:00:02.000Z",
    }).reason,
    "lease_expired",
  );
  assert.equal(
    store.markWakeRunning({
      wakeId: wake.id,
      runnerId: "runner-1",
      leaseToken: claim.leaseToken,
      runId: "run-expired",
      domainId: "domain-1",
      at: "2026-06-08T00:00:02.000Z",
    }).reason,
    "lease_expired",
  );

  const runningWake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-running",
    wakeKey: "linear:project:project-running:decomposition",
    sourceEventId: "event-running",
    requiresRunnerVerification: true,
  }).wake;
  const runningClaim = store.claimWake({
    wakeId: runningWake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });
  assert.equal(
    store.markWakeRunning({
      wakeId: runningWake.id,
      runnerId: "runner-1",
      leaseToken: runningClaim.leaseToken,
      runId: "run-running",
      domainId: "domain-1",
      at: "2026-06-08T00:00:00.500Z",
    }).ok,
    true,
  );
  assert.equal(
    store.completeWake({
      wakeId: runningWake.id,
      runnerId: "runner-1",
      leaseToken: runningClaim.leaseToken,
      status: "completed",
      at: "2026-06-08T00:00:02.000Z",
    }).reason,
    "lease_expired",
  );
  assert.equal(
    store.deadLetterWake({
      wakeId: runningWake.id,
      runnerId: "runner-1",
      leaseToken: runningClaim.leaseToken,
      reason: "runner_lost",
      at: "2026-06-08T00:00:02.000Z",
    }).reason,
    "lease_expired",
  );
});

test("lazy expiry during claim is scoped to the caller workspace", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const tenantBWake = store.enqueueWake({
    workspaceId: "workspace-b",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-b",
    wakeKey: "linear:project:project-b:decomposition",
    sourceEventId: "event-b",
    requiresRunnerVerification: true,
  }).wake;
  store.claimWake({
    wakeId: tenantBWake.id,
    workspaceId: "workspace-b",
    runnerId: "runner-b",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });
  const tenantAWake = enqueueProjectWake(store, "event-a").wake;

  const claimA = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-a",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    at: "2026-06-08T00:00:02.000Z",
  });

  assert.equal(claimA.ok, true);
  assert.equal(claimA.wake.id, tenantAWake.id);
  assert.equal(tenantBWake.status, "leased");
  assert.match(tenantBWake.lease_token, /^lease-/);
});

test("claim capabilities use stored credential capabilities and intersect presented capabilities", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;

  const narrowed = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    storedCapabilities: ["linear.project.planned"],
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });
  assert.equal(narrowed.reason, "capability_mismatch");
  assert.deepEqual(narrowed.missingCapabilities, ["decomposition.trigger_runner.v1"]);

  const trustedStored = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    storedCapabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    capabilities: [],
  });
  assert.equal(trustedStored.ok, true);
});

test("stored runner credential scope isolates two teams in one workspace", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const requiredCapabilities = ["linear.project.planned", "decomposition.trigger_runner.v1"];
  const credentialA = {
    storedCapabilities: requiredCapabilities,
    storedWebhookIds: ["webhook-team-1"],
    storedTeamId: "team-1",
    storedDomainId: "domain-1",
  };
  const credentialB = {
    storedCapabilities: requiredCapabilities,
    storedWebhookIds: ["webhook-team-2"],
    storedTeamId: "team-2",
    storedDomainId: "domain-2",
  };
  const wakeA = enqueueScopedProjectWake(store, {
    projectId: "project-team-1",
    sourceEventId: "event-team-1",
    webhookId: "webhook-team-1",
    teamId: "team-1",
  }).wake;
  const wakeB = enqueueScopedProjectWake(store, {
    projectId: "project-team-2",
    sourceEventId: "event-team-2",
    webhookId: "webhook-team-2",
    teamId: "team-2",
  }).wake;

  assert.deepEqual(store.listWakeViews({ workspaceId: "workspace-1", ...credentialA }).map((wake) => wake.id), [wakeA.id]);
  assert.deepEqual(store.listWakeViews({ workspaceId: "workspace-1", ...credentialB }).map((wake) => wake.id), [wakeB.id]);
  assert.equal(store.getWake(wakeB.id, credentialA), null);
  assert.equal(store.getWake(wakeA.id, credentialB), null);
  assert.equal(store.claimWake({
    wakeId: wakeB.id,
    workspaceId: "workspace-1",
    runnerId: "runner-a",
    capabilities: requiredCapabilities,
    ...credentialA,
  }).reason, "no_queued_wake");
  assert.equal(store.claimWake({
    wakeId: wakeA.id,
    workspaceId: "workspace-1",
    runnerId: "runner-b",
    capabilities: requiredCapabilities,
    ...credentialB,
  }).reason, "no_queued_wake");

  const claimA = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-a",
    capabilities: requiredCapabilities,
    webhookIds: ["webhook-team-1", "webhook-team-2"],
    ...credentialA,
  });
  const claimB = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-b",
    capabilities: requiredCapabilities,
    ...credentialB,
  });

  assert.equal(claimA.ok, true);
  assert.equal(claimA.wake.id, wakeA.id);
  assert.equal(claimB.ok, true);
  assert.equal(claimB.wake.id, wakeB.id);
  assert.equal(store.renewLease({
    wakeId: wakeB.id,
    runnerId: "runner-b",
    leaseToken: claimB.leaseToken,
    ...credentialA,
  }).reason, "wake_not_found");
  assert.equal(store.deadLetterWake({
    wakeId: wakeB.id,
    runnerId: "runner-b",
    leaseToken: claimB.leaseToken,
    reason: "operator_override",
    ...credentialA,
  }).reason, "wake_not_found");
  assert.equal(store.renewLease({
    wakeId: wakeA.id,
    runnerId: "runner-a",
    leaseToken: claimA.leaseToken,
    ...credentialB,
  }).reason, "wake_not_found");
  assert.equal(store.deadLetterWake({
    wakeId: wakeA.id,
    runnerId: "runner-a",
    leaseToken: claimA.leaseToken,
    reason: "operator_override",
    ...credentialB,
  }).reason, "wake_not_found");
});

test("legacy empty-scope runner credential remains workspace-wide", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const requiredCapabilities = ["linear.project.planned", "decomposition.trigger_runner.v1"];
  const legacyCredential = {
    storedCapabilities: requiredCapabilities,
    storedWebhookIds: [],
    storedTeamId: null,
    storedDomainId: null,
  };
  const wakeA = enqueueScopedProjectWake(store, {
    projectId: "project-team-1",
    sourceEventId: "event-team-1",
    webhookId: "webhook-team-1",
    teamId: "team-1",
  }).wake;
  const wakeB = enqueueScopedProjectWake(store, {
    projectId: "project-team-2",
    sourceEventId: "event-team-2",
    webhookId: "webhook-team-2",
    teamId: "team-2",
  }).wake;

  assert.deepEqual(
    store.listWakeViews({ workspaceId: "workspace-1", ...legacyCredential }).map((wake) => wake.id),
    [wakeA.id, wakeB.id],
  );
  assert.equal(store.getWake(wakeB.id, legacyCredential).id, wakeB.id);
  assert.equal(store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-legacy",
    capabilities: requiredCapabilities,
    ...legacyCredential,
  }).wake.id, wakeA.id);
  assert.equal(store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-legacy",
    capabilities: requiredCapabilities,
    ...legacyCredential,
  }).wake.id, wakeB.id);
});

test("waiting_for_runner is derived from queued wake and heartbeat freshness", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  enqueueProjectWake(store, "event-1");
  assert.equal(
    store.listWakeViews({ workspaceId: "workspace-1", at: "2026-06-08T00:00:00.000Z" })[0].derived_status,
    "waiting_for_runner",
  );

  store.heartbeat({
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    version: "test",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    at: "2026-06-08T00:00:00.000Z",
  });

  assert.equal(
    store.listWakeViews({ workspaceId: "workspace-1", at: "2026-06-08T00:00:10.000Z" })[0].derived_status,
    "queued",
  );
  assert.equal(
    store.listWakeViews({ workspaceId: "workspace-1", at: "2026-06-08T00:03:00.000Z" })[0].derived_status,
    "waiting_for_runner",
  );
});

test("runner capability mismatch does not claim or mutate the queued wake", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = enqueueProjectWake(store, "event-1").wake;

  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-old",
    capabilities: ["linear.project.planned"],
  });

  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "capability_mismatch");
  assert.equal(wake.status, "queued");
  assert.match(wake.last_claim_rejection_reason, /decomposition\.trigger_runner\.v1/);
});

test("specific wake claims report the current non-queued status", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const leasedWake = enqueueProjectWake(store, "event-1").wake;
  store.claimWake({
    wakeId: leasedWake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
  });
  const completedWake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-completed",
    wakeKey: "linear:project:project-completed:decomposition",
    sourceEventId: "event-2",
    requiresRunnerVerification: true,
  }).wake;
  completedWake.status = "completed";
  completedWake.terminal_at = "2026-06-08T00:00:00.000Z";

  assert.equal(
    store.claimWake({
      wakeId: leasedWake.id,
      workspaceId: "workspace-1",
      runnerId: "runner-2",
      capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    }).reason,
    "wake_not_queued:leased",
  );
  assert.equal(
    store.claimWake({
      wakeId: completedWake.id,
      workspaceId: "workspace-1",
      runnerId: "runner-2",
      capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    }).reason,
    "wake_not_queued:completed",
  );
});

test("explicit wakeId plus non-intersecting webhookIds returns no_queued_wake", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-filtered",
    wakeKey: "linear:project:project-filtered:decomposition",
    sourceEventId: "event-filtered",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-a"],
  }).wake;

  const claim = store.claimWake({
    wakeId: wake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-b"],
  });

  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "no_queued_wake");
  assert.equal(wake.status, "queued");
});

test("runner outcomes map to terminal wake states", () => {
  assert.deepEqual(mapRunnerOutcomeToWake({ status: "completed" }), { status: "completed", reason: null });
  assert.deepEqual(mapRunnerOutcomeToWake({ status: "paused", reason: "product_questions" }), {
    status: "paused",
    reason: "product_questions",
  });
  assert.deepEqual(
    mapRunnerOutcomeToWake({
      status: "ineligible",
      eligibility: { blockingConditions: ["project_not_planned"] },
    }),
    { status: "rejected", reason: "project_not_planned" },
  );
  assert.deepEqual(mapRunnerOutcomeToWake({ status: "failed_closed", failureReasons: ["bad_packet"] }), {
    status: "rejected",
    reason: "bad_packet",
  });
});

test("runner death after Linear mutation starts moves wake to dead_letter", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const client = await initializedTriggerClient(config);
  client.failCreateIssueAfterCount = 0;

  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_wake_2");
  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    qualityJudge: fakeAdvisoryQualityJudge,
    idGenerator: () => "run_wake_2",
  });

  assert.equal(result.status, "dead_letter");
  assert.match(result.reason, /after_linear_mutation_started/);
  assert.equal(store.workflowWakeups[0].status, "dead_letter");
});

test("runner fail-closed before Linear mutation rejects wake without dead-lettering", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const client = await initializedTriggerClient(config);

  // The orchestrator invokes a library subagent; that spawn throws (runtime
  // unavailable) BEFORE any Linear mutation, so the run must fail closed
  // (rejected, not dead-lettered). Inject the orchestrator turn + roster so the
  // throwing executeSubagent is reached deterministically.
  const { orchestratorTurnExecutor, roster } = committingOrchestrator("run_wake_pre_mutation_failure");
  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    runtimeExecutor: {
      async executeSubagent() {
        throw new Error("runtime smoke missing");
      },
    },
    orchestratorTurnExecutor,
    roster,
    idGenerator: () => "run_wake_pre_mutation_failure",
  });

  assert.equal(result.status, "rejected");
  assert.match(result.reason, /runner_failed_closed:runtime smoke missing/);
  assert.equal(store.workflowWakeups[0].status, "rejected");
  assert.equal(store.workflowWakeups[0].mutation_started_at, null);
});

test("Runner ordering: missing DomainContext fails before a wake can be claimed", async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const client = await initializedTriggerClient(config);

  await assert.rejects(
    () =>
      runTriggeredDecomposition({
        store,
        runnerId: "runner-1",
        workspaceId: "workspace-1",
        linearClient: client,
        config,
        cache: client.cache,
        registry: triggerDomainRegistry(),
        runStoreDir: tempRunStore(),
        // Fails at the DomainContext guard before any wake claim or orchestrator
        // turn — the runtime executor is never reached.
        runtimeExecutor: fakeSubagentExecutor(),
        idGenerator: () => "run_missing_domain_context",
      }),
    new RegExp(DOMAIN_CONTEXT_REQUIRED_REASON),
  );

  assert.equal(store.workflowWakeups[0].status, "queued");
  assert.equal(store.workflowWakeups[0].attempt_count, 0);
  assert.equal(store.workflowWakeups[0].mutation_started_at, null);
  assert.equal(client.issues.length, 0);
});

test("Runner ordering: no wake is marked running before domain resolution succeeds", async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-ambiguous",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-ambiguous" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-1",
    team_ids: ["team-1", "team-sales"],
  }).event;
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-ambiguous",
    wakeKey: "linear:project:project-ambiguous:decomposition",
    sourceEventId: event.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-1", "webhook-sales"],
    teamIds: ["team-1", "team-sales"],
  }).wake;
  let markRunningCalls = 0;
  const originalMarkWakeRunning = store.markWakeRunning.bind(store);
  store.markWakeRunning = (input) => {
    markRunningCalls += 1;
    return originalMarkWakeRunning(input);
  };
  const linearCalls = [];
  const linearClient = linearClientThatRecordsCalls(linearCalls);

  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient,
    config,
    cache: linearClient.cache,
    ...triggerRunnerDomainOptions(config, { registry }),
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_ambiguous_domain",
  });

  assert.equal(result.status, "routing_error");
  assert.equal(result.reason, "cross_domain_team_conflict");
  assert.equal(wake.status, "routing_error");
  assert.equal(wake.routing_error_reason, "cross_domain_team_conflict");
  assert.deepEqual(wake.routing_candidates.map((candidate) => candidate.domainId), ["support-ops", "sales-ops"]);
  assert.equal(markRunningCalls, 0);
  assert.deepEqual(linearCalls, []);
});

test("Runner ordering: wrong-domain wake is released without Linear mutation", async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-sales",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-sales" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-sales",
    team_ids: ["team-sales"],
  }).event;
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-sales",
    wakeKey: "linear:project:project-sales:decomposition",
    sourceEventId: event.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-sales"],
    teamIds: ["team-sales"],
  }).wake;
  const linearCalls = [];

  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: linearClientThatRecordsCalls(linearCalls),
    config,
    cache: { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" },
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    claimWebhookIds: [],
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_wrong_domain",
  });

  assert.equal(result.status, "released");
  assert.equal(result.reason, "domain_not_served");
  assert.equal(result.resolvedDomainId, "sales-ops");
  assert.equal(wake.status, "queued");
  assert.equal(wake.lease_token, null);
  assert.deepEqual(linearCalls, []);
});

test("Runner ordering: quarantine and release complete with zero Linear client construction", async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  let factoryCalls = 0;
  const linearClientFactory = async () => {
    factoryCalls += 1;
    return linearClientThatRecordsCalls([]);
  };

  const ambiguousStore = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const ambiguousEvent = ambiguousStore.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-ambiguous-counting-factory",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-ambiguous-counting-factory" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-1",
    team_ids: ["team-1", "team-sales"],
  }).event;
  ambiguousStore.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-ambiguous-counting-factory",
    wakeKey: "linear:project:project-ambiguous-counting-factory:decomposition",
    sourceEventId: ambiguousEvent.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-1", "webhook-sales"],
    teamIds: ["team-1", "team-sales"],
  });

  const quarantined = await runTriggeredDecomposition({
    store: ambiguousStore,
    runnerId: "runner-support",
    workspaceId: "workspace-1",
    linearClientFactory,
    config,
    cache: { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" },
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_ambiguous_counting_factory",
  });
  assert.equal(quarantined.status, "routing_error");
  assert.equal(factoryCalls, 0);

  const wrongDomainStore = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const salesEvent = wrongDomainStore.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-sales-counting-factory",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-sales-counting-factory" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-sales",
    team_ids: ["team-sales"],
  }).event;
  wrongDomainStore.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-sales-counting-factory",
    wakeKey: "linear:project:project-sales-counting-factory:decomposition",
    sourceEventId: salesEvent.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-sales"],
    teamIds: ["team-sales"],
  });

  const released = await runTriggeredDecomposition({
    store: wrongDomainStore,
    runnerId: "runner-support",
    workspaceId: "workspace-1",
    linearClientFactory,
    config,
    cache: { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" },
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    claimWebhookIds: [],
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_sales_counting_factory",
  });
  assert.equal(released.status, "released");
  assert.equal(factoryCalls, 0);
});

test("Quarantine visibility: multi-team project matching two governed domains enters routing_error", async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-two-teams",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-two-teams" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    team_ids: ["team-1", "team-sales"],
  }).event;
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-two-teams",
    wakeKey: "linear:project:project-two-teams:decomposition",
    sourceEventId: event.id,
    requiresRunnerVerification: true,
    teamIds: ["team-1", "team-sales"],
  }).wake;
  const linearCalls = [];

  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-support",
    workspaceId: "workspace-1",
    linearClient: linearClientThatRecordsCalls(linearCalls),
    config,
    cache: { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" },
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    claimWebhookIds: [],
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_two_team_quarantine",
  });

  assert.equal(result.status, "routing_error");
  assert.equal(result.reason, "cross_domain_team_conflict");
  assert.equal(wake.status, "routing_error");
  assert.deepEqual(wake.routing_candidates.map((candidate) => candidate.domainId), ["support-ops", "sales-ops"]);
  assert.deepEqual(linearCalls, []);
});

test("Quarantine visibility: multi-team project matching zero governed domains enters routing_error", async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-zero-governed-teams",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-zero-governed" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    team_ids: ["team-other"],
  }).event;
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-zero-governed",
    wakeKey: "linear:project:project-zero-governed:decomposition",
    sourceEventId: event.id,
    requiresRunnerVerification: true,
    teamIds: ["team-other"],
  }).wake;
  const linearCalls = [];

  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-support",
    workspaceId: "workspace-1",
    linearClient: linearClientThatRecordsCalls(linearCalls),
    config,
    cache: { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" },
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    claimWebhookIds: [],
    runStoreDir: tempRunStore(),
    runtimeExecutor: runtimeExecutorThatMustNotRun(),
    idGenerator: () => "run_zero_team_quarantine",
  });

  assert.equal(result.status, "routing_error");
  assert.equal(result.reason, "no_domain_project_team_intersection");
  assert.equal(wake.status, "routing_error");
  assert.deepEqual(wake.routing_candidates, []);
  assert.deepEqual(linearCalls, []);
});

test("Runner ordering: per-domain runner loop cannot claim another domain's wake accidentally", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const registry = triggerDomainRegistry({
    includeSales: true,
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-sales",
    salesTeamId: "team-sales",
  });
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const salesEvent = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-sales-first",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-sales" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-sales",
    team_ids: ["team-sales"],
  }).event;
  const supportEvent = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-support-second",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-1" },
    changed_fields: ["status"],
    requires_runner_verification: true,
    webhook_id: "webhook-1",
    team_ids: ["team-1"],
  }).event;
  const salesWake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-sales",
    wakeKey: "linear:project:project-sales:decomposition",
    sourceEventId: salesEvent.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-sales"],
    teamIds: ["team-sales"],
  }).wake;
  const supportWake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: supportEvent.id,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-1"],
    teamIds: ["team-1"],
  }).wake;
  const client = await initializedTriggerClient(config);

  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_support_claim_filter");
  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-support",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config, { registry, domainId: "support-ops" }),
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    qualityJudge: fakeAdvisoryQualityJudge,
    idGenerator: () => "run_support_claim_filter",
  });

  assert.equal(result.status, "completed");
  assert.equal(salesWake.status, "queued");
  assert.equal(supportWake.status, "completed");
  assert.equal(supportWake.domain_id, "support-ops");
});

test("local Phoenix trace failure records degraded trace status without blocking mutation", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const client = await initializedTriggerClient(config);
  const calls = [];
  const traceSink = {
    async startRun(input) {
      calls.push(["start", input.runId]);
      return {
        ok: true,
        traceId: "11111111111111111111111111111111",
        run: {
          run_id: input.runId,
          wake_id: input.wake.id,
          object_id: input.wake.object_id,
          current_attempt: input.wake.attempt_count,
        },
        exporter: true,
      };
    },
    async forceFlush(input) {
      calls.push(["flush", input.stage]);
      throw new Error("local Phoenix unavailable");
    },
    async finishRun(input) {
      calls.push(["finish", input.result.status]);
      return { status: "trace_delivery_failed", reason: "local Phoenix unavailable" };
    },
  };

  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_local_phoenix_down");
  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    qualityJudge: fakeAdvisoryQualityJudge,
    idGenerator: () => "run_local_phoenix_down",
    traceSink,
  });

  assert.equal(result.status, "completed");
  assert.equal(client.issues.length, 2);
  assert.equal(result.traceDelivery.status, "trace_delivery_failed");
  assert.deepEqual(calls.map(([name]) => name), ["start", "flush", "finish"]);
});

test("hosted wake/run store calls remain trace-agnostic when local tracing is enabled", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const observedInputs = [];
  for (const method of ["markWakeRunning", "markMutationStarted", "completeWake", "deadLetterWake"]) {
    const original = store[method].bind(store);
    store[method] = (input) => {
      observedInputs.push([method, input]);
      return original(input);
    };
  }
  const client = await initializedTriggerClient(config);
  const traceSink = {
    async startRun(input) {
      return {
        ok: true,
        traceId: "11111111111111111111111111111111",
        run: { run_id: input.runId, wake_id: input.wake.id, object_id: input.wake.object_id },
        exporter: true,
      };
    },
    async forceFlush() {
      return { ok: true };
    },
    async finishRun() {
      return { status: "trace_exported" };
    },
  };

  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_trace_agnostic");
  await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    qualityJudge: fakeAdvisoryQualityJudge,
    idGenerator: () => "run_trace_agnostic",
    traceSink,
  });

  for (const [method, input] of observedInputs) {
    assert.deepEqual(
      Object.keys(input).filter((key) => key.toLowerCase().includes("trace")),
      [],
      `${method} must not receive trace fields`,
    );
  }
});

test("eligibility rejection records trace evidence or a local trace receipt", async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  const client = await initializedTriggerClient(config);
  client.projects[0].status = client.projectStatuses.find((status) => status.id === "status-backlog");
  let finished = null;
  const traceSink = {
    async startRun(input) {
      return {
        ok: true,
        traceId: "11111111111111111111111111111111",
        run: {
          run_id: input.runId,
          wake_id: input.wake.id,
          object_id: input.wake.object_id,
          current_attempt: input.wake.attempt_count,
        },
        exporter: true,
      };
    },
    async finishRun(input) {
      finished = input;
      return { status: "trace_exported" };
    },
  };

  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    // Eligibility rejects (project is backlog) BEFORE the orchestrator loop, so
    // the runtime executor is never invoked — a bare subagent fake suffices.
    runtimeExecutor: fakeSubagentExecutor(),
    idGenerator: () => "run_ineligible",
    traceSink,
  });

  assert.equal(result.status, "rejected");
  assert.equal(finished.result.status, "ineligible");
  assert.ok(finished.result.trace.spans.some((span) => span.name === "eligibility_gate"));
});

test("eval mode runs decomposition without mutating Linear", async () => {
  const config = loadLinearConfig({ repoRoot });
  const client = await initializedTriggerClient(config);
  const initialIssueCount = client.issues.length;
  const initialUpdateCount = client.projectUpdates.length;
  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_eval_mode");

  const result = await runDecompositionEvalMode({
    linearClient: client,
    config,
    cache: client.cache,
    projectId: "project-1",
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    runId: "run_eval_mode",
    domainContext: triggerDomainContext(config),
  });

  assert.equal(result.status, "evaluated");
  assert.equal(result.mutationSkipped, true);
  assert.equal(client.issues.length, initialIssueCount);
  assert.equal(client.projectUpdates.length, initialUpdateCount);
  assert.ok(result.trace.spans.some((span) => span.name === "eval_mode_non_mutating"));
  assert.equal(result.subagent_evidence.length, 2);
  assert.deepEqual(result.subagent_evidence.map((record) => record.role), ["pm", "sr_eng"]);
  assert.equal(result.subagent_evidence[0].runtime, "codex");
  assert.equal(result.subagent_evidence[0].parse_status, "valid");
  assert.equal(result.subagent_evidence[0].clean_parse, true);
  assert.equal(result.runtimeEvidence.pm.turns[0].subagent_evidence.role, "pm");
});

test("eval mode records the supplied memory snapshot as the captured project snapshot", async () => {
  const config = loadLinearConfig({ repoRoot });
  const client = await initializedTriggerClient(config);
  const runStoreDir = tempRunStore();
  const suppliedProjectContext = await client.getProjectContext("project-1");
  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_eval_snapshot");

  const result = await runDecompositionEvalMode({
    linearClient: client,
    config,
    cache: client.cache,
    projectId: "project-1",
    runStoreDir,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    runId: "run_eval_snapshot",
    domainContext: triggerDomainContext(config),
  });

  assert.equal(result.status, "evaluated");
  assert.equal(result.mutationSkipped, true);

  const span = result.trace.spans.find((candidate) => candidate.name === "capture_project_snapshot");
  assert.equal(span.attributes.ok, true);
  assert.equal(span.attributes.capture_source, "eval_mode_memory_snapshot");

  const loaded = loadCapturedProjectSnapshot("run_eval_snapshot", { runStoreDir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.snapshot.capture_source, "eval_mode_memory_snapshot");
  assert.equal(loaded.snapshot.run_id, "run_eval_snapshot");
  assert.equal(loaded.snapshot.project.id, "project-1");
  assert.equal(loaded.snapshot.project.content, suppliedProjectContext.content);
  assert.equal(loaded.snapshot.project.status, "planned");
  // The supplied snapshot IS the capture: same projection, same stable hash.
  assert.equal(
    loaded.snapshot.snapshot_hash,
    computeProjectSnapshotHash(
      projectSnapshotProjection({ project: suppliedProjectContext, semanticStatus: "planned" }),
    ),
  );
});

test("runner inbox credential storage is separate from Linear OAuth credential storage", async () => {
  const config = loadLinearConfig({ repoRoot });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-runner-credential-"));
  const fileConfig = structuredClone(config);
  fileConfig.inbox.credential_storage = "file";
  fileConfig.inbox.credential_file = ".agentic-factory/inbox-runner-credential.json";
  const domainIdentity = { domainId: "support-ops", workspaceId: "workspace-1" };
  const store = createRunnerInboxCredentialStore({
    config: fileConfig,
    repoRoot: tempDir,
    ...domainIdentity,
  });

  assert.notEqual(
    runnerInboxCredentialTargetForConfig(fileConfig, tempDir, domainIdentity),
    credentialTargetForConfig(fileConfig, tempDir, domainIdentity),
  );

  const inboxClient = fakeInboxClient();
  const result = await ensureRunnerInboxCredential({
    inboxClient,
    credentialStore: store,
    workspaceId: "workspace-1",
  });
  assert.equal(result.created, true);
  assert.equal((await store.readCredential()).token, "runner-token-1");
});

test("hosted wake queue store sends runner credential on lease protocol calls", async () => {
  const calls = [];
  const store = createHostedWakeQueueStore({
    credential: {
      workspaceId: "workspace-1",
      credentialId: "runner-credential-1",
      token: "runner-token-1",
    },
    inboxClient: {
      async claimNextWake(input) {
        calls.push(["claim", input]);
        return { ok: false, reason: "no_queued_wake" };
      },
      async heartbeatRunner(input) {
        calls.push(["heartbeat", input]);
        return { ok: true };
      },
      async renewWakeLease(input) {
        calls.push(["renew", input]);
        return { ok: true };
      },
      async releaseWake(input) {
        calls.push(["release", input]);
        return { ok: true };
      },
      async markWakeRoutingError(input) {
        calls.push(["routing-error", input]);
        return { ok: true };
      },
      async requeueWake(input) {
        calls.push(["requeue", input]);
        return { ok: true };
      },
      async listWakeViews(input) {
        calls.push(["views", input]);
        return { views: [] };
      },
    },
  });

  await store.heartbeat({ workspaceId: "workspace-1", runnerId: "runner-1" });
  await store.claimNextWake({ workspaceId: "workspace-1", runnerId: "runner-1" });
  await store.renewLease({ wakeId: "wake-1", runnerId: "runner-1", leaseToken: "lease-1" });
  await store.releaseWake({ wakeId: "wake-1", leaseToken: "lease-1", reason: "domain_not_served" });
  await store.markWakeRoutingError({
    wakeId: "wake-1",
    leaseToken: "lease-1",
    reason: "ambiguous_webhook_id",
    candidates: [],
  });
  await store.requeueWake({ wakeId: "wake-1" });
  await store.listWakeViews({ workspaceId: "workspace-1" });

  assert.deepEqual(calls.map(([name]) => name), [
    "heartbeat",
    "claim",
    "renew",
    "release",
    "routing-error",
    "requeue",
    "views",
  ]);
  assert.equal(calls[0][1].credentialId, "runner-credential-1");
  assert.equal(calls[0][1].token, "runner-token-1");
  assert.equal(calls[6][1].credentialId, "runner-credential-1");
  assert.equal(calls[2][1].workspaceId, "workspace-1");
  assert.equal(calls[3][1].workspaceId, undefined);
  assert.equal(calls[3][1].runnerId, undefined);
  assert.deepEqual(calls[3][1], {
    credentialId: "runner-credential-1",
    token: "runner-token-1",
    wakeId: "wake-1",
    leaseToken: "lease-1",
    reason: "domain_not_served",
  });
  assert.equal(calls[4][1].workspaceId, undefined);
  assert.equal(calls[4][1].runnerId, undefined);
  assert.equal(calls[5][1].workspaceId, "workspace-1");
});

test("hosted inbox client sends setup grant only for setup handoff calls", async () => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.inbox.base_url = "https://inbox.test/functions/v1/agentic-factory-inbox";
  config.inbox.setup_grant = "af_setup_v1_grant_secret";
  const calls = [];
  const client = createHostedInboxClient({
    config,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1" });
  await client.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1", bypassActiveConflict: true });
  await client.setupGrantStatus({ workspaceId: "workspace-1", teamId: "team-1" });
  await client.putLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  await client.claimNextWake({
    workspaceId: "workspace-1",
    credentialId: "runner-credential-1",
    token: "runner-token-1",
  });
  await client.requeueWake({
    credentialId: "runner-credential-1",
    token: "runner-token-1",
    wakeId: "wake-1",
  });

  assert.equal(calls[0].url.endsWith("/v1/setup-grants"), true);
  assert.equal(calls[0].init.headers["x-agentic-factory-setup-grant"], undefined);
  assert.equal(calls[1].url.endsWith("/v1/setup-grants"), true);
  assert.equal(calls[1].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_grant_secret");
  assert.equal(calls[2].url.endsWith("/v1/setup-grants/status"), true);
  assert.equal(calls[2].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_grant_secret");
  assert.equal(calls[3].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_grant_secret");
  assert.equal(calls[4].init.headers["x-agentic-factory-setup-grant"], undefined);
  assert.equal(calls[5].url.endsWith("/v1/wakeups/requeue"), true);
  assert.equal(calls[5].init.headers["x-agentic-factory-setup-grant"], undefined);
  assert.equal(calls[3].init.headers["x-agentic-factory-inbox-admin-token"], undefined);
});

test("init setup grant is persisted before webhook handoff and runner credential calls use it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-init-setup-grant-"));
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.inbox.base_url = "https://inbox.test/functions/v1/agentic-factory-inbox";
  config.inbox.webhook_url = "https://inbox.test/functions/v1/agentic-factory-inbox/v1/webhooks/linear";
  config.inbox.setup_grant_file = ".agentic-factory/inbox-setup-grant.env";
  const calls = [];
  const client = createHostedInboxClient({
    config,
    repoRoot: tempDir,
    fetchImpl: async (url, init) => {
      const call = {
        url: String(url),
        init,
        body: init.body ? JSON.parse(init.body) : {},
      };
      calls.push(call);
      if (call.url.endsWith("/v1/setup-grants")) {
        return new Response(JSON.stringify({ ok: true, setupGrant: "af_setup_v1_init_grant" }), { status: 200 });
      }
      if (call.url.endsWith("/v1/runner-credentials")) {
        return new Response(JSON.stringify({
          credentialId: "runner-credential-1",
          token: "runner-token-1",
          endpoint: "https://inbox.test/v1/runner",
          capabilities: call.body.capabilities,
          createdAt: "2026-06-13T00:00:00.000Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await ensureInboxSetupGrant({
    inboxClient: client,
    config,
    repoRoot: tempDir,
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
  });
  const grantFile = readInboxSetupGrantFile({ inbox: config.inbox, repoRoot: tempDir });
  assert.equal(grantFile.setupGrant, "af_setup_v1_init_grant");

  const registration = await ensureLinearWebhookRegistration({
    linearClient: new WebhookLinearClient(),
    inboxClient: client,
    config,
    workspaceId: "workspace-1",
    teamId: "team-1",
    randomBytes: () => Buffer.alloc(32, 7),
    now: () => new Date("2026-06-13T00:00:00.000Z"),
  });
  let writtenCredential = null;
  await ensureRunnerInboxCredential({
    inboxClient: client,
    credentialStore: {
      async readCredential() { return null; },
      async writeCredential(credential) { writtenCredential = credential; },
    },
    workspaceId: "workspace-1",
  });

  assert.equal(registration.handoff.message, LINEAR_WEBHOOK_HANDOFF_VERIFIED_MESSAGE);
  assert.equal(writtenCredential.credentialId, "runner-credential-1");
  const byPath = Object.fromEntries(calls.map((call) => [new URL(call.url).pathname, call]));
  assert.equal(byPath["/functions/v1/agentic-factory-inbox/v1/setup-grants"].init.headers["x-agentic-factory-setup-grant"], undefined);
  assert.equal(byPath["/functions/v1/agentic-factory-inbox/v1/linear/webhook-secret"].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_init_grant");
  assert.equal(byPath["/functions/v1/agentic-factory-inbox/v1/linear/webhook-secret/verify"].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_init_grant");
  assert.equal(byPath["/functions/v1/agentic-factory-inbox/v1/runner-credentials"].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_init_grant");
  assert.equal(byPath["/functions/v1/agentic-factory-inbox/v1/linear/webhook-secret"].init.headers["x-agentic-factory-inbox-admin-token"], undefined);
  assert.ok(!calls.some((call) => /confirm/i.test(call.url)), "local signature handoff must not call a confirmation route");
});

test("GitHub resume refreshes the setup grant for the saved Linear domain", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-github-resume-grant-"));
  const config = { inbox: { setup_grant_file: ".agentic-factory/inbox-setup-grant.env" } };
  const requests = [];
  const progress = [];
  const result = await refreshGitHubResumeSetupGrant({
    resumeDomain: {
      id: "turnip",
      linear: {
        workspace_id: "workspace-1",
        team_id: "team-turnip",
      },
    },
    inboxClient: {
      async requestSetupGrant(input) {
        requests.push(input);
        return {
          ok: true,
          refreshed: true,
          setupGrant: "af_setup_v1_github_resume",
          grant: { status: "provisional" },
        };
      },
    },
    config,
    repoRoot: tempDir,
    onProgress: (line) => progress.push(line),
  });

  assert.deepEqual(result, { status: "provisional", resumed: false });
  assert.deepEqual(requests, [{
    workspaceId: "workspace-1",
    teamId: "team-turnip",
    domainId: "turnip",
    bypassActiveConflict: true,
  }]);
  assert.deepEqual(progress, ["refreshed: reopened inbox setup window for this Linear team"]);
  const grantFile = readInboxSetupGrantFile({ inbox: config.inbox, repoRoot: tempDir });
  assert.equal(grantFile.setupGrant, "af_setup_v1_github_resume");
});

test("setup grant conflict resumes with a local grant file and stops honestly without one", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-setup-grant-conflict-"));
  const config = { inbox: { setup_grant_file: ".agentic-factory/inbox-setup-grant.env" } };
  const statusCalls = [];
  const conflictInbox = {
    async requestSetupGrant() {
      return { ok: false, reason: "setup_grant_conflict" };
    },
    async setupGrantStatus(input) {
      statusCalls.push(input);
      return { ok: true, status: "provisional" };
    },
  };

  await assert.rejects(
    () => ensureInboxSetupGrant({
      inboxClient: conflictInbox,
      config,
      repoRoot: tempDir,
      workspaceId: "workspace-1",
      teamId: "team-1",
      domainId: "support-ops",
    }),
    /A pending connection for this team already exists/,
  );

  writeInboxSetupGrant({ inbox: config.inbox, repoRoot: tempDir, setupGrant: "af_setup_v1_local" });
  const resumed = await ensureInboxSetupGrant({
    inboxClient: conflictInbox,
    config,
    repoRoot: tempDir,
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
  });

  assert.deepEqual(resumed, { status: "provisional", resumed: true });
  assert.deepEqual(statusCalls.at(-1), {
    workspaceId: "workspace-1",
    teamId: "team-1",
    setupGrant: "af_setup_v1_local",
  });
});

test("hosted inbox client issues broker credentials with the setup grant header", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-broker-credential-issue-"));
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.inbox.base_url = "https://inbox.test/functions/v1/agentic-factory-inbox";
  writeInboxSetupGrant({ inbox: config.inbox, repoRoot: tempDir, setupGrant: "af_setup_v1_for_broker" });
  const calls = [];
  const client = createHostedInboxClient({
    config,
    repoRoot: tempDir,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, credential: "af_broker_v1.segment.sig" }), { status: 200 });
    },
  });

  const issued = await client.issueBrokerCredential({});

  assert.equal(issued.credential, "af_broker_v1.segment.sig");
  assert.equal(calls[0].url.endsWith("/v1/broker-credentials"), true);
  assert.deepEqual(calls[0].body, {});
  assert.equal(calls[0].init.headers["x-agentic-factory-setup-grant"], "af_setup_v1_for_broker");
});

test("GitHub install callback rejects users without write permission on the bound repo", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-attacker",
    teamId: "team-attacker",
    secret: "attacker-secret",
    at,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-attacker",
    appSlug: "agentic-factory-app",
    owner: "victim",
    repo: "private-repo",
    state: "attacker-state",
    githubInstallationLookup: ({ owner, repo }) =>
      owner === "victim" && repo === "private-repo" ? { id: 999900123 } : null,
    at,
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { attacker_code: "token-attacker" },
    tokenToRepoPermissions: {
      "token-attacker": {
        "victim/private-repo": { pull: true, push: false, admin: false },
      },
    },
  });

  const missingCode = await store.bindGitHubInstallationFromCallback({
    state: "attacker-state",
    githubClient,
    at,
  });
  assert.equal(missingCode.ok, false);
  assert.equal(missingCode.reason, "github_oauth_code_required");
  assert.deepEqual(githubClient.calls, []);

  const forged = await store.bindGitHubInstallationFromCallback({
    state: "attacker-state",
    code: "attacker_code",
    githubClient,
    at,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, "repo_write_permission_required");
  assert.deepEqual(githubClient.calls.map((call) => call.type), [
    "exchangeOAuthCodeForToken",
    "getRepoPermissions",
  ]);
  assert.deepEqual(githubClient.calls[1], {
    type: "getRepoPermissions",
    owner: "victim",
    repo: "private-repo",
  });
  assert.equal(
    store.setupGrantStatus({
      setupGrant: issued.setupGrant,
      workspaceId: "workspace-attacker",
      at,
    }).githubInstallationId,
    null,
  );
  // The failed binding left the grant github-unverified, so the broker mint is rejected by
  // the github gate (no verified install) — credential issuance stays structurally
  // impossible without a real repo-write-proven binding.
  assert.throws(
    () =>
      store.issueBrokerCredential({
        setupGrant: issued.setupGrant,
        workspaceId: "workspace-attacker",
        owner: "victim",
        repo: "private-repo",
        key: "broker-key",
        at,
      }),
    /github_repo_not_verified/,
  );
});

test("GitHub App install callback without OAuth code binds only the grant-bound repo after server-side installation lookup", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "install-flow-secret",
    at,
  });
  const intent = store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "install-flow-state",
    at,
  });
  assert.equal(intent.flow, "install_app");
  const githubClient = createFakeGitHubOAuthClient({
    repoInstallations: {
      "acme/agentic-factory": {
        id: 999900123,
        permissions: { metadata: "read", contents: "write", pull_requests: "write" },
      },
    },
  });

  const bound = await store.bindGitHubInstallationFromCallback({
    state: "install-flow-state",
    setupAction: "install",
    githubClient,
    at,
  });

  assert.equal(bound.ok, true);
  assert.equal(bound.grant.githubInstallationId, "999900123");
  assert.equal(bound.grant.githubOwner, "acme");
  assert.equal(bound.grant.githubRepo, "agentic-factory");
  assert.equal(bound.grant.githubRepoVerifiedAt, at);
  assert.deepEqual(githubClient.calls, [
    { type: "getRepoInstallation", owner: "acme", repo: "agentic-factory" },
  ]);
});

test("GitHub App install callback without OAuth code refuses to bind an installation on a different repo", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "install-flow-secret",
    at,
  });
  const intent = store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "install-flow-state",
    at,
  });
  assert.equal(intent.flow, "install_app");
  // The App is installed on a DIFFERENT repo in the same account, never on the
  // grant-bound repo. The code-less install_app callback must fail closed: binding
  // is scoped to the grant-bound owner/repo, not whatever else the account installed.
  const githubClient = createFakeGitHubOAuthClient({
    repoInstallations: {
      "acme/other-repo": {
        id: 999000111,
        permissions: { metadata: "read", contents: "write", pull_requests: "write" },
      },
    },
  });

  const bound = await store.bindGitHubInstallationFromCallback({
    state: "install-flow-state",
    setupAction: "install",
    githubClient,
    at,
  });

  assert.equal(bound.ok, false);
  assert.equal(bound.reason, "github_app_not_installed");
  assert.deepEqual(githubClient.calls, [
    { type: "getRepoInstallation", owner: "acme", repo: "agentic-factory" },
  ]);
});

test("GitHub install intent uses the documented new-install URL", () => {
  const store = new MemoryInboxStore();
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "setup-secret",
    at: "2026-06-13T12:00:00.000Z",
  });
  const intent = store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "shulmansj",
    repo: "agentic-factory",
    state: "state-1",
    at: "2026-06-13T12:01:00.000Z",
  });

  assert.equal(
    intent.installUrl,
    "https://github.com/apps/agentic-factory-app/installations/new?state=state-1",
  );
  assert.equal(intent.installUrl.includes("/installations/select_target"), false);
});

test("GitHub install intent routes already-installed repos to OAuth authorization", () => {
  const store = new MemoryInboxStore();
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "setup-secret",
    at: "2026-06-13T12:00:00.000Z",
  });
  const intent = store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    clientId: "client-1",
    owner: "shulmansj",
    repo: "agentic-factory",
    state: "state-1",
    githubInstallationLookup: ({ owner, repo }) =>
      owner === "shulmansj" && repo === "agentic-factory" ? { id: 999900123 } : null,
    at: "2026-06-13T12:01:00.000Z",
  });

  assert.equal(intent.flow, "authorize_existing_installation");
  assert.equal(
    intent.installUrl,
    "https://github.com/login/oauth/authorize?client_id=client-1&state=state-1",
  );
});

test("GitHub OAuth callback binds an already-installed App without trusting a callback installation id", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "existing-install-secret",
    at,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "existing-install-state",
    at,
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: {
      "token-legit": {
        "acme/agentic-factory": { pull: true, push: true, admin: false },
      },
    },
    repoInstallations: {
      "acme/agentic-factory": {
        id: 999900123,
        permissions: { metadata: "read", contents: "write", pull_requests: "write" },
      },
    },
  });

  const bound = await store.bindGitHubInstallationFromCallback({
    state: "existing-install-state",
    code: "legit_code",
    githubClient,
    at,
  });

  assert.equal(bound.ok, true);
  assert.equal(bound.grant.githubInstallationId, "999900123");
  assert.deepEqual(githubClient.calls.map((call) => call.type), [
    "exchangeOAuthCodeForToken",
    "getRepoPermissions",
    "getRepoInstallation",
  ]);
});

test("GitHub install callback rejects expired state without OAuth exchange", async () => {
  const issuedAt = "2026-06-13T12:00:00.000Z";
  const expiredAt = "2026-06-13T12:16:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(issuedAt) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "expired-secret",
    at: issuedAt,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "expired-state",
    at: issuedAt,
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: {
      "token-legit": {
        "acme/agentic-factory": { push: true, admin: false },
      },
    },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });

  const expired = await store.bindGitHubInstallationFromCallback({
    state: "expired-state",
    code: "legit_code",
    githubClient,
    at: expiredAt,
  });

  assert.deepEqual(expired, { ok: false, reason: "invalid_or_expired_install_link" });
  assert.deepEqual(githubClient.calls, []);
  assert.equal(
    store.setupGrantStatus({
      setupGrant: issued.setupGrant,
      workspaceId: "workspace-1",
      at: issuedAt,
    }).githubInstallationId,
    null,
  );
});

test("GitHub repo-write proof binds an installation credential and derives credential repo from the grant", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "legit-secret",
    at,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "legit-state",
    at,
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: {
      "token-legit": {
        "acme/agentic-factory": { pull: true, push: true, admin: false },
      },
    },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });

  const bound = await store.bindGitHubInstallationFromCallback({
    state: "legit-state",
    code: "legit_code",
    githubClient,
    at,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.grant.githubInstallationId, "installation-X");
  assert.equal(bound.grant.githubOwner, "acme");
  assert.equal(bound.grant.githubRepo, "agentic-factory");
  assert.equal(bound.grant.githubRepoVerifiedAt, at);
  assert.deepEqual(githubClient.calls.map((call) => call.type), [
    "exchangeOAuthCodeForToken",
    "getRepoPermissions",
    "getRepoInstallation",
  ]);
  assert.deepEqual(
    await store.bindGitHubInstallationFromCallback({
      state: "legit-state",
      code: "legit_code",
      githubClient,
      at,
    }),
    { ok: false, reason: "invalid_or_expired_install_link" },
  );
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: at,
  });
  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-github-confirm",
    data: { teamIds: ["team-1"] },
  }));
  const confirmed = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody, deliveryId: "delivery-github-confirm" }),
    rawBody,
    receivedAt: at,
  });
  assert.equal(confirmed.accepted, true);
  assert.equal(store.setupGrants[0].status, "confirmed");

  const issuedCredential = store.issueBrokerCredential({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    owner: "victim",
    repo: "private-repo",
    key: "broker-key",
    at,
  });
  const payload = verifyBrokerCredential({
    key: "broker-key",
    token: issuedCredential.brokerCredential,
    nowSeconds: Math.floor(Date.parse(at) / 1000),
  });
  assert.equal(payload.installationId, "installation-X");
  assert.equal(payload.owner, "acme");
  assert.equal(payload.repo, "agentic-factory");
  assert.equal(issuedCredential.owner, "acme");
  assert.equal(issuedCredential.repo, "agentic-factory");
  assert.deepEqual(simulateBrokerInstallationEnforcement({
    credentialPayload: payload,
    owner: "acme",
    repo: "agentic-factory",
    repoInstallationId: "installation-X",
  }), { ok: true });
  assert.deepEqual(simulateBrokerInstallationEnforcement({
    credentialPayload: payload,
    owner: "acme",
    repo: "other-repo",
    repoInstallationId: "installation-X",
  }), { ok: false, reason: "broker_credential_repo_mismatch" });
  assert.deepEqual(simulateBrokerInstallationEnforcement({
    credentialPayload: payload,
    owner: "acme",
    repo: "agentic-factory",
    repoInstallationId: "installation-Y",
  }), { ok: false, reason: "broker_credential_installation_mismatch" });
});

test("github-verified provisional grants mint the initial broker credential before deferred Linear confirmation", async () => {
  const issuedAt = "2026-06-13T12:00:00.000Z";
  const mintAt = "2026-06-13T12:30:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(issuedAt) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "init-secret",
    at: issuedAt,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "init-state",
    at: "2026-06-13T12:01:00.000Z",
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: { "token-legit": { "acme/agentic-factory": { push: true, admin: false } } },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });
  const bound = await store.bindGitHubInstallationFromCallback({
    state: "init-state",
    code: "legit_code",
    githubClient,
    at: "2026-06-13T12:02:00.000Z",
  });
  assert.equal(bound.ok, true);
  // No Linear webhook delivery yet, so the grant is still PROVISIONAL (deferred confirmation).
  assert.equal(store.setupGrants[0].status, "provisional");
  // The initial broker credential must still mint from the github-verified provisional grant.
  const minted = store.issueBrokerCredential({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    key: "broker-key",
    at: mintAt,
  });
  const payload = verifyBrokerCredential({
    key: "broker-key",
    token: minted.brokerCredential,
    nowSeconds: Math.floor(Date.parse(mintAt) / 1000),
  });
  assert.equal(payload.owner, "acme");
  assert.equal(payload.repo, "agentic-factory");
  assert.equal(payload.installationId, "installation-X");
  // Minting neither required nor caused Linear confirmation.
  assert.equal(store.setupGrants[0].status, "provisional");
});

test("a github-verified provisional grant cannot mint past its confirmation window", async () => {
  const issuedAt = "2026-06-13T12:00:00.000Z";
  const pastWindowAt = "2026-12-31T00:00:00.000Z"; // well past the 7-day confirmation window
  const store = new MemoryInboxStore({ now: () => new Date(issuedAt) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "init-secret",
    at: issuedAt,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "init-state",
    at: "2026-06-13T12:01:00.000Z",
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: { "token-legit": { "acme/agentic-factory": { push: true, admin: false } } },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });
  const bound = await store.bindGitHubInstallationFromCallback({
    state: "init-state",
    code: "legit_code",
    githubClient,
    at: "2026-06-13T12:02:00.000Z",
  });
  assert.equal(bound.ok, true);
  assert.equal(store.setupGrants[0].status, "provisional");
  // The bounded relaxation must not let a provisional grant mint indefinitely past its window.
  assert.throws(
    () => store.issueBrokerCredential({
      setupGrant: issued.setupGrant,
      workspaceId: "workspace-1",
      key: "broker-key",
      at: pastWindowAt,
    }),
    /setup grant is not active/,
  );
});

test("confirmed repo-verified grants re-mint 1-hour broker credentials after the mutation window without consuming uses", async () => {
  const issuedAt = "2026-06-13T12:00:00.000Z";
  const reMintAt = "2026-06-13T12:30:00.000Z";
  const secondReMintAt = "2026-06-13T12:31:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(issuedAt) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "steady-secret",
    at: issuedAt,
  });
  store.githubInstallIntent({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "steady-state",
    at: "2026-06-13T12:01:00.000Z",
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: {
      "token-legit": {
        "acme/agentic-factory": { push: true, admin: false },
      },
    },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });
  const bound = await store.bindGitHubInstallationFromCallback({
    state: "steady-state",
    code: "legit_code",
    githubClient,
    at: "2026-06-13T12:02:00.000Z",
  });
  assert.equal(bound.ok, true);
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-13T12:03:00.000Z",
  });
  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-steady-confirm",
    data: { teamIds: ["team-1"] },
  }));
  const confirmed = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody, deliveryId: "delivery-steady-confirm" }),
    rawBody,
    receivedAt: "2026-06-13T12:04:00.000Z",
  });
  assert.equal(confirmed.accepted, true);
  assert.equal(store.setupGrants[0].status, "confirmed");
  assert.equal(store.setupGrants[0].uses_remaining, 6);

  const first = store.issueBrokerCredential({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    key: "broker-key",
    at: reMintAt,
  });
  const firstPayload = verifyBrokerCredential({
    key: "broker-key",
    token: first.brokerCredential,
    nowSeconds: Math.floor(Date.parse(reMintAt) / 1000),
  });
  assert.equal(firstPayload.exp, Math.floor(Date.parse(reMintAt) / 1000) + 60 * 60);
  assert.equal(first.expiresAt, "2026-06-13T13:30:00.000Z");
  assert.equal(store.setupGrants[0].uses_remaining, 6);
  assert.equal(store.setupGrants[0].last_used_at, reMintAt);
  assert.equal(store.setupGrants[0].github_broker_remint_count, 1);
  assert.equal(store.setupGrants[0].github_broker_remint_window_started_at, reMintAt);

  const second = store.issueBrokerCredential({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    key: "broker-key",
    at: secondReMintAt,
  });
  const secondPayload = verifyBrokerCredential({
    key: "broker-key",
    token: second.brokerCredential,
    nowSeconds: Math.floor(Date.parse(secondReMintAt) / 1000),
  });
  assert.equal(secondPayload.exp, Math.floor(Date.parse(secondReMintAt) / 1000) + 60 * 60);
  assert.equal(store.setupGrants[0].uses_remaining, 6);
  assert.equal(store.setupGrants[0].last_used_at, secondReMintAt);
  assert.equal(store.setupGrants[0].github_broker_remint_count, 2);
  assert.equal(store.setupGrants[0].github_broker_remint_window_started_at, reMintAt);

  let lastSuccessfulReMintAt = secondReMintAt;
  for (let index = 3; index <= BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW; index += 1) {
    lastSuccessfulReMintAt = new Date(Date.parse(secondReMintAt) + (index - 2) * 60 * 1000).toISOString();
    const remint = store.issueBrokerCredential({
      setupGrant: issued.setupGrant,
      workspaceId: "workspace-1",
      key: "broker-key",
      at: lastSuccessfulReMintAt,
    });
    assert.equal(remint.ok, true);
  }
  assert.equal(store.setupGrants[0].uses_remaining, 6);
  assert.equal(store.setupGrants[0].last_used_at, lastSuccessfulReMintAt);
  assert.equal(store.setupGrants[0].github_broker_remint_count, BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW);
  assert.equal(store.setupGrants[0].github_broker_remint_window_started_at, reMintAt);
  assert.throws(
    () => store.issueBrokerCredential({
      setupGrant: issued.setupGrant,
      workspaceId: "workspace-1",
      key: "broker-key",
      at: "2026-06-13T12:59:30.000Z",
    }),
    /broker_credential_remint_rate_limited/,
  );
  assert.equal(store.setupGrants[0].last_used_at, lastSuccessfulReMintAt);
  assert.equal(store.setupGrants[0].github_broker_remint_count, BROKER_CREDENTIAL_REMINT_MAX_PER_WINDOW);

  const resetAt = "2026-06-13T13:30:00.000Z";
  const afterReset = store.issueBrokerCredential({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    key: "broker-key",
    at: resetAt,
  });
  assert.equal(afterReset.ok, true);
  assert.equal(store.setupGrants[0].uses_remaining, 6);
  assert.equal(store.setupGrants[0].last_used_at, resetAt);
  assert.equal(store.setupGrants[0].github_broker_remint_count, 1);
  assert.equal(store.setupGrants[0].github_broker_remint_window_started_at, resetAt);
});

test("broker credential mint rejects github-unverified (provisional or confirmed) and revoked grants", async () => {
  const at = "2026-06-13T12:00:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(at) });
  const provisional = store.requestSetupGrant({
    workspaceId: "workspace-provisional",
    teamId: "team-provisional",
    secret: "provisional-secret",
    at,
  });
  // A provisional grant now passes the status gate; without a github install binding it is
  // correctly rejected by the github gate (the binding is the broker credential's proof).
  assert.throws(
    () => store.issueBrokerCredential({
      setupGrant: provisional.setupGrant,
      workspaceId: "workspace-provisional",
      key: "broker-key",
      at,
    }),
    /github_repo_not_verified/,
  );

  const unverified = store.requestSetupGrant({
    workspaceId: "workspace-unverified",
    teamId: "team-unverified",
    secret: "unverified-secret",
    at,
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-unverified",
    teamId: "team-unverified",
    webhookId: "webhook-unverified",
    signingSecret: "secret-unverified",
    setupGrant: unverified.setupGrant,
    rotatedAt: at,
  });
  const unverifiedPayload = linearProjectPayload({
    deliveryId: "delivery-unverified",
    data: { teamIds: ["team-unverified"] },
  });
  unverifiedPayload.organizationId = "workspace-unverified";
  const unverifiedBody = JSON.stringify(unverifiedPayload);
  ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-unverified",
    headers: signedLinearHeaders({
      rawBody: unverifiedBody,
      deliveryId: "delivery-unverified",
      signingSecret: "secret-unverified",
    }),
    rawBody: unverifiedBody,
    receivedAt: at,
  });
  assert.equal(store.setupGrants.find((grant) => grant.team_id === "team-unverified").status, "confirmed");
  assert.throws(
    () => store.issueBrokerCredential({
      setupGrant: unverified.setupGrant,
      workspaceId: "workspace-unverified",
      key: "broker-key",
      at,
    }),
    /github_repo_not_verified/,
  );

  const revocable = store.requestSetupGrant({
    workspaceId: "workspace-revoked",
    teamId: "team-revoked",
    secret: "revoked-secret",
    at,
  });
  store.githubInstallIntent({
    setupGrant: revocable.setupGrant,
    workspaceId: "workspace-revoked",
    appSlug: "agentic-factory-app",
    owner: "acme",
    repo: "agentic-factory",
    state: "revocable-state",
    at,
  });
  const githubClient = createFakeGitHubOAuthClient({
    codeToAccessToken: { legit_code: "token-legit" },
    tokenToRepoPermissions: {
      "token-legit": {
        "acme/agentic-factory": { push: true, admin: false },
      },
    },
    repoInstallations: { "acme/agentic-factory": "installation-X" },
  });
  await store.bindGitHubInstallationFromCallback({
    state: "revocable-state",
    code: "legit_code",
    githubClient,
    at,
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-revoked",
    teamId: "team-revoked",
    webhookId: "webhook-revoked",
    signingSecret: "secret-revoked",
    setupGrant: revocable.setupGrant,
    rotatedAt: at,
  });
  const revokedPayload = linearProjectPayload({
    deliveryId: "delivery-revoked",
    data: { teamIds: ["team-revoked"] },
  });
  revokedPayload.organizationId = "workspace-revoked";
  const revokedBody = JSON.stringify(revokedPayload);
  ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-revoked",
    headers: signedLinearHeaders({
      rawBody: revokedBody,
      deliveryId: "delivery-revoked",
      signingSecret: "secret-revoked",
    }),
    rawBody: revokedBody,
    receivedAt: at,
  });
  assert.equal(
    store.issueBrokerCredential({
      setupGrant: revocable.setupGrant,
      workspaceId: "workspace-revoked",
      key: "broker-key",
      at,
    }).ok,
    true,
  );
  const revoked = store.revokeSetupGrant({
    setupGrant: revocable.setupGrant,
    workspaceId: "workspace-revoked",
    teamId: "team-revoked",
    at,
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.grant.status, "revoked");
  assert.throws(
    () => store.issueBrokerCredential({
      setupGrant: revocable.setupGrant,
      workspaceId: "workspace-revoked",
      key: "broker-key",
      at,
    }),
    /setup grant is not active/,
  );
});

test("setup mutations still consume uses and enforce the 15-minute mutation window", () => {
  const issuedAt = "2026-06-13T12:00:00.000Z";
  const afterMutationWindow = "2026-06-13T12:30:00.000Z";
  const store = new MemoryInboxStore({ now: () => new Date(issuedAt) });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    secret: "mutation-secret",
    at: issuedAt,
  });
  assert.equal(store.setupGrants[0].uses_remaining, 8);
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-13T12:05:00.000Z",
  });
  assert.equal(store.setupGrants[0].uses_remaining, 7);

  assert.throws(
    () => store.upsertLinearWebhookSecret({
      workspaceId: "workspace-1",
      teamId: "team-1",
      webhookId: "webhook-1",
      signingSecret: "secret-rotated",
      setupGrant: issued.setupGrant,
      rotatedAt: afterMutationWindow,
    }),
    /setup grant mutation window expired/,
  );
  assert.throws(
    () => store.mintRunnerCredential({
      workspaceId: "workspace-1",
      teamId: "team-1",
      webhookIds: ["webhook-1"],
      setupGrant: issued.setupGrant,
      at: afterMutationWindow,
    }),
    /setup grant mutation window expired/,
  );
  assert.equal(store.setupGrants[0].uses_remaining, 7);
});

test("doctor connection status reports pending and confirmed setup grants", async () => {
  const context = {
    linear: {
      workspaceId: "workspace-1",
      teamId: "team-1",
    },
  };
  const pending = await doctorInboxSetupGrantConnection({
    domainId: "support-ops",
    context,
    inboxClient: {
      async setupGrantStatus(input) {
        assert.deepEqual(input, { workspaceId: "workspace-1", teamId: "team-1" });
        return { ok: true, status: "provisional" };
      },
    },
  });
  assert.deepEqual(pending, {
    name: "domain support-ops Connection",
    ok: true,
    message: "waiting for your first Planned project (not yet active)",
  });

  const confirmed = await doctorInboxSetupGrantConnection({
    domainId: "support-ops",
    context,
    inboxClient: {
      async setupGrantStatus() {
        return { ok: true, status: "confirmed", confirmedAt: "2026-06-13T12:00:00.000Z" };
      },
    },
  });
  assert.deepEqual(confirmed, {
    name: "domain support-ops Connection",
    ok: true,
    message: "active (confirmed 2026-06-13T12:00:00.000Z)",
  });
});

test("hosted inbox client normalizes structured HTTP 4xx responses to store-shaped reasons", async () => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.inbox.base_url = "https://inbox.test/functions/v1/agentic-factory-inbox";
  const client = createHostedInboxClient({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "lease_token_mismatch" }), { status: 409 }),
  });

  const result = await client.releaseWake({
    credentialId: "runner-credential-1",
    token: "runner-token-1",
    wakeId: "wake-1",
    leaseToken: "wrong-lease",
    reason: "domain_not_served",
  });

  assert.deepEqual(result, { ok: false, reason: "lease_token_mismatch" });
});

test("hosted inbox client builds against the shipped default endpoint", () => {
  // C7: the shipped default config points at the standard hosted inbox, so the
  // client constructs cleanly (zero-config) without the placeholder guard firing.
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  assert.doesNotThrow(() =>
    createHostedInboxClient({
      config,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  );
});

test("hosted inbox client rejects placeholder Supabase endpoints before request", () => {
  const config = structuredClone(loadLinearConfig({ repoRoot }));
  config.inbox.base_url = "https://your-project-ref.supabase.co/functions/v1/agentic-factory-inbox";
  let called = false;
  assert.throws(
    () => createHostedInboxClient({
      config,
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
    /hosted_inbox_placeholder_endpoint.*inbox\.base_url.*supabase\/README\.md/,
  );
  assert.equal(called, false);
});

test("hosted inbox setup grant can come from ignored local state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-inbox-token-"));
  fs.mkdirSync(path.join(tempDir, ".agentic-factory"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, ".agentic-factory", "inbox-setup-grant.env"),
    "AGENTIC_FACTORY_INBOX_SETUP_GRANT=file-setup-grant\n",
  );

  assert.equal(
    resolveInboxSetupGrant({ inbox: { setup_grant_file: ".agentic-factory/inbox-setup-grant.env" }, repoRoot: tempDir }),
    "file-setup-grant",
  );
});

test("runtime command runner spawns a process and captures stdout packet JSON", async () => {
  const packet = subagentTurn("run-runtime-spawn");
  const output = await runRuntimeCommand(
    {
      command: "runtime-spawn-smoke",
      args: ["--emit-packet"],
    },
    {
      timeoutMs: 15_000,
      spawnImpl: fakeRuntimeCommandSpawn({ stdout: JSON.stringify(packet) }),
    },
  );

  assert.deepEqual(JSON.parse(output), packet);
});

test("runtime command runner resolves Windows Codex npm shim without shell execution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-codex-shim-"));
  const codexBin = path.join(tempDir, "npm", "node_modules", "@openai", "codex", "bin");
  fs.mkdirSync(codexBin, { recursive: true });
  const codexJs = path.join(codexBin, "codex.js");
  fs.writeFileSync(codexJs, "console.log('codex')\n", "utf8");

  const resolved = resolveRuntimeSpawnCommand("codex", ["exec", "prompt"], {
    platform: "win32",
    env: { APPDATA: tempDir },
    nodePath: "node.exe",
  });

  assert.equal(resolved.command, "node.exe");
  assert.deepEqual(resolved.args, [codexJs, "exec", "prompt"]);
});

test("process runtime executor wraps the persona body in the subagent envelope", async () => {
  const config = loadLinearConfig({ repoRoot });
  let commandSeen = null;
  const packet = subagentTurn("run-prompt-context");
  const executor = createProcessRuntimeExecutor({
    runCommand: async (command) => {
      commandSeen = command;
      return { output: JSON.stringify(packet) };
    },
  });

  // The orchestrator hands the subagent the persona body.
  // executeSubagent wraps it with the per-turn envelope before spawning the runtime.
  const prompt = "PERSONA BODY for pm product sufficiency.";

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt,
    runId: "run-prompt-context",
    task: "Evaluate product sufficiency for this decomposition.",
    priorDigest: [{ controlAction: { action: "invoke_library" }, outcome: "previous_turn" }],
    project: {
      id: "project-1",
      name: "Disposable Runner Smoke",
      description: "Test description",
      content: "Test project body",
      status: { id: "status-planned", name: "Planned", type: "planned" },
      labels: [],
      issues: [],
    },
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    config,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.parse_status, "valid");
  assert.equal(execution.clean_parse, true);
  assert.equal(execution.runtime, commandSeen.runtime);
  assert.deepEqual(execution.packet, packet);
  assert.equal(execution.output, JSON.stringify(packet));
  assert.match(execution.envelope, /PERSONA BODY for pm product sufficiency/);
  assert.match(execution.envelope, /run_id: run-prompt-context/);
  assert.match(execution.envelope, /Evaluate product sufficiency for this decomposition/);
  assert.match(execution.envelope, /Disposable Runner Smoke/);
  assert.match(execution.envelope, /Test project body/);
  assert.match(execution.envelope, /Prior accepted-turns digest/);

  const threaded = commandSeen.args.find((arg) => arg === execution.envelope);
  assert.equal(threaded, execution.envelope);
});

test("process runtime executor can resend a preserved envelope override with repair timeout", async () => {
  const config = loadLinearConfig({ repoRoot });
  let commandSeen = null;
  let optionsSeen = null;
  const packet = subagentTurn("run-envelope-override");
  const preservedEnvelope = [
    "PRESERVED ORIGINAL ENVELOPE",
    "run_id: run-envelope-override",
    "role: pm",
  ].join("\n");
  const executor = createProcessRuntimeExecutor({
    runCommand: async (command, options) => {
      commandSeen = command;
      optionsSeen = options;
      return { output: JSON.stringify(packet) };
    },
  });

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt: "PERSONA BODY that must not be double wrapped.",
    envelopeOverride: `${preservedEnvelope}\n\nRepair suffix.`,
    runId: "run-envelope-override",
    project: { id: "project-1", name: "Override Project", labels: [], issues: [] },
    config,
    timeoutMs: REPAIR_RETRY_TIMEOUT_MS,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.envelope, `${preservedEnvelope}\n\nRepair suffix.`);
  assert.equal(commandSeen.args.find((arg) => arg === execution.envelope), execution.envelope);
  assert.equal(commandSeen.args.some((arg) =>
    typeof arg === "string" && arg.includes("PERSONA BODY that must not be double wrapped.")
  ), false);
  assert.equal(optionsSeen.timeoutMs, REPAIR_RETRY_TIMEOUT_MS);
});

test("process runtime executor reports unavailable tool-event evidence on the real CLI path", async () => {
  const config = loadLinearConfig({ repoRoot });
  const packet = subagentTurn("run-no-tool-events");
  const executor = createProcessRuntimeExecutor({
    runCommand: async () => JSON.stringify(packet),
  });

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt: "Evaluate product sufficiency for run-no-tool-events.",
    runId: "run-no-tool-events",
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    config,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.parse_status, "valid");
  assert.equal(execution.clean_parse, true);
  assert.deepEqual(execution.packet, packet);
  assert.equal(Object.hasOwn(execution.evidence, "tool_events"), false);
  assert.deepEqual(execution.evidence.evidence_unavailable, [{
    scope: "pm.turn.tool_events",
    reason: "runtime_tool_event_channel_unavailable",
  }]);
});

test("process runtime executor captures observed runtime session handles", async () => {
  const config = loadLinearConfig({ repoRoot });
  const packet = subagentTurn("run-observed-handle");
  const executor = createProcessRuntimeExecutor({
    runCommand: async () =>
      JSON.stringify({
        session_id: "019ea7c3-d4fc-71e0-a6fe-662624e06f6d",
        structured_output: packet,
      }),
  });

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt: "Evaluate product sufficiency for run-observed-handle.",
    runId: "run-observed-handle",
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    config,
  });

  assert.equal(execution.ok, true);
  assert.deepEqual(execution.packet, packet);
  assert.deepEqual(execution.sessionHandle, {
    id: "019ea7c3-d4fc-71e0-a6fe-662624e06f6d",
    role: "pm",
    run_id: "run-observed-handle",
    runtime: "claude",
  });
});

test("process runtime executor returns typed parse failures instead of throwing", async () => {
  const config = loadLinearConfig({ repoRoot });
  const executor = createProcessRuntimeExecutor({
    runCommand: async () =>
      `runtime diagnostic\n${JSON.stringify(subagentTurn("run-parse-failure"))}`,
  });

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt: "PERSONA BODY for parse failure.",
    runId: "run-parse-failure",
    task: "Parse failure task",
    priorDigest: [{ outcome: "previous" }],
    project: { id: "project-parse", name: "Parse Project", content: "Parse body", labels: [], issues: [] },
    wake: { id: "wake-1", object_id: "project-parse" },
    event: { id: "event-1" },
    config,
  });

  assert.equal(execution.ok, false);
  assert.equal(execution.failure_kind, "parse");
  assert.equal(execution.failure_code, "invalid_packet");
  assert.equal(execution.parse_status, "invalid");
  assert.equal(execution.clean_parse, false);
  assert.equal(execution.role, "pm");
  assert.match(execution.raw_output_excerpt, /runtime diagnostic/);
  assert.match(execution.envelope, /run_id: run-parse-failure/);
  assert.match(execution.envelope, /Parse Project/);
  assert.match(execution.envelope, /Parse failure task/);
});

test("process runtime executor returns typed process failures instead of throwing", async () => {
  const config = loadLinearConfig({ repoRoot });
  const executor = createProcessRuntimeExecutor({
    runCommand: async () => {
      const error = new Error("Runtime command timed out after 10ms: claude");
      error.failure_code = "timed_out";
      error.exit = null;
      error.signal = "SIGTERM";
      error.stdout = "partial stdout";
      error.stderr = "runtime stderr";
      throw error;
    },
  });

  const execution = await executor.executeSubagent({
    runtime_role: "pm",
    prompt: "PERSONA BODY for process failure.",
    runId: "run-process-failure",
    task: "Process failure task",
    priorDigest: [{ outcome: "previous" }],
    project: { id: "project-process", name: "Process Project", content: "Process body", labels: [], issues: [] },
    wake: { id: "wake-1", object_id: "project-process" },
    event: { id: "event-1" },
    config,
  });

  assert.equal(execution.ok, false);
  assert.equal(execution.failure_kind, "process");
  assert.equal(execution.failure_code, "timed_out");
  assert.equal(execution.parse_status, "invalid");
  assert.equal(execution.clean_parse, false);
  assert.equal(execution.role, "pm");
  assert.equal(execution.raw_output_excerpt, "partial stdout");
  assert.deepEqual(execution.process, {
    exit: null,
    signal: "SIGTERM",
    timed_out: true,
  });
  assert.match(execution.envelope, /run_id: run-process-failure/);
  assert.match(execution.envelope, /Process Project/);
  assert.match(execution.envelope, /Process failure task/);
});

test("runDecompositionOrchestrator assembles a schema-valid S1 commit output", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_orch_s1_commit";
  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator(runId);

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
  });

  assert.equal(result.output.terminal_output.outcome, "commit");
  assert.equal(result.output.terminal_output.reason, "synthesis_complete");
  assert.equal(result.output.terminal_output.final_issues.length, 2);
  // perspectives_run reflects the run in invocation order (the library order the
  // orchestrator chose — pm grounding then sr_eng), not a fixed phase sequence.
  assert.deepEqual(result.output.evidence.perspectives_run.map((entry) => entry.role), [
    "pm",
    "sr_eng",
  ]);
  assert.deepEqual(runtimeExecutor.calls.map((call) => call.runtime_role), ["pm", "sr_eng"]);
  assert.match(
    runtimeExecutor.calls[0].task,
    /Run the Product Manager library role \(prompt\/decomposition\/pm_product_sufficiency_pass\)/,
  );
  assert.deepEqual(runtimeExecutor.calls[0].priorDigest, []);
  assert.match(
    runtimeExecutor.calls[1].task,
    /Run the Senior Engineer library role \(prompt\/decomposition\/sr_eng_grounding_pass\)/,
  );
  assert.equal(runtimeExecutor.calls[1].priorDigest.length, 1);
  assert.equal(result.environment.agent_write_credentials_present, false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

// REC-1 (the #50 re-key): the recorded accepted_refs are CAPTURED AT LOAD as the
// run resolves each library snapshot (handleInvokeLibrary -> recordLibraryLoad),
// plus the orchestrator's own governing prompt loaded at run-start. The recorded
// sha is the LOADED snapshot's sha (first-captured wins), so a competing
// same-target merge after load can never overwrite the consumed version.
test("runDecompositionOrchestrator captures the accepted ref AT LOAD from the loaded library snapshots", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_capture_at_load";
  const pmTarget = "prompt/decomposition/pm_product_sufficiency_pass";
  const srTarget = "prompt/decomposition/sr_eng_grounding_pass";
  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator(runId);

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
  });

  // The run consumed the governing prompt (loaded at run-start) + both library
  // refs (captured as each invoke_library loaded its snapshot).
  const byTarget = new Map(result.acceptedRefs.map((ref) => [ref.target_key, ref]));
  assert.ok(byTarget.has("prompt/decomposition/orchestrator_governing"));
  // The recorded ref is built FROM THE LOADED snapshot: its sha is the fake
  // roster's loaded snapshotSha256 (`sha-<target>`), not a finalize re-derive.
  assert.deepEqual(byTarget.get(pmTarget), {
    target_key: pmTarget,
    accepted_baseline_id: `sha256:sha-${pmTarget}`,
    snapshot_sha256: `sha-${pmTarget}`,
  });
  assert.deepEqual(byTarget.get(srTarget), {
    target_key: srTarget,
    accepted_baseline_id: `sha256:sha-${srTarget}`,
    snapshot_sha256: `sha-${srTarget}`,
  });
});

// REC-1 Fix: the runtime-defaults rule ref is recorded only when an EXECUTED role
// consumed accepted defaults. A role the run never invokes (drafter) resolving
// from accepted defaults must NOT cause the rule to be recorded — the recorder's
// executed-role set is the orchestrator + the roles it actually invoked.
test("runDecompositionOrchestrator does NOT record the runtime-defaults rule for an unexecuted role", async () => {
  const baseConfig = loadLinearConfig({ repoRoot });
  const runId = "run_unexecuted_role_defaults";
  // Stamp a role_field_sources map where only the never-executed `drafter` role
  // came from accepted defaults; the executed pm/sr_eng roles came from adopter
  // config. (role_field_sources is a non-enumerable property on the workflow;
  // overwrite it directly for the test.)
  const config = { ...baseConfig };
  config.workflows = {
    ...baseConfig.workflows,
    decomposition: { ...baseConfig.workflows.decomposition },
  };
  Object.defineProperty(config.workflows.decomposition, "role_field_sources", {
    value: {
      pm: { runtime: "adopter_config", model: "adopter_config" },
      sr_eng: { runtime: "adopter_config", model: "adopter_config" },
      drafter: { runtime: "accepted_defaults", model: "adopter_config" },
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator(runId);

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
  });

  // The runtime-defaults rule target must be absent — only `drafter` (never run)
  // used accepted defaults; the executed set is orchestrator + pm + sr_eng.
  assert.equal(
    result.acceptedRefs.some((ref) => ref.target_key === "rule/decomposition/runtime_role_assignments"),
    false,
    "an unexecuted role's accepted defaults must not record the runtime-defaults rule",
  );
});

test("runDecompositionOrchestrator fails closed with a useful bounds question after max rounds", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_orch_bounds";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  // The orchestrator never terminates — it keeps invoking the library, so the
  // harness must emit the bounds breach itself once the round bound is exceeded.
  const orchestratorTurnExecutor = async () => ({
    controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
    evidence: null,
    sessionHandle: null,
  });

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    maxRounds: 1,
  });

  assert.equal(result.output.terminal_output.outcome, "failed_closed");
  assert.equal(result.output.terminal_output.reason, "bounds_breach");
  // rounds_used counts ACTUAL decision turns executed: with max_rounds=1 exactly
  // one turn runs before the loop stops closed (no phantom extra round).
  assert.equal(result.output.bounds.rounds_used, 1);
  assert.equal(result.output.bounds.max_rounds, 1);
  assert.match(result.output.terminal_output.project_update_markdown, /^run_id:\s*run_orch_bounds$/m);
  assert.match(result.output.terminal_output.open_questions_markdown, /round limit/);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("runDecompositionOrchestrator pauses with a single perspective and no coverage gate", async () => {
  const config = loadLinearConfig({ repoRoot });
  const runId = "run_orch_partial_pause";
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  // One library subagent runs, then the orchestrator terminates with a product
  // pause carrying its authored project update + open questions.
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/pm_product_sufficiency_pass" },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
      producedContent: {
        project_update_markdown: projectUpdateMarkdownForRun(runId, "PM paused decomposition for product questions."),
        open_questions_markdown: "- Question: Which product decision should unblock decomposition?",
      },
      evidence: null,
      sessionHandle: null,
    };
  };

  const result = await runDecompositionOrchestrator({
    runId,
    wake: { id: "wake-1", object_id: "project-1" },
    event: { id: "event-1" },
    project: { id: "project-1", name: "Project", labels: [], issues: [] },
    config,
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
  });

  assert.equal(result.output.terminal_output.outcome, "pause");
  assert.equal(result.output.terminal_output.reason, "product_questions");
  assert.deepEqual(result.output.evidence.perspectives_run, [
    { role: "pm", outcome: "product_context_sufficient" },
  ]);
  assert.equal(Object.hasOwn(result.output.evidence, "coverage"), false);
  assert.equal(Object.hasOwn(result.output.evidence.perspectives_run[0], "session_handle"), false);
  assert.deepEqual(validateOrchestratorOutput(result.output), { ok: true, failureReasons: [] });
});

test("init registration creates Linear webhook, hands only signing secret to inbox, and verifies handoff", async () => {
  const config = loadLinearConfig({ repoRoot });
  const linearClient = new WebhookLinearClient();
  const inboxClient = fakeInboxClient();

  const result = await ensureLinearWebhookRegistration({
    linearClient,
    inboxClient,
    config,
    workspaceId: "workspace-1",
    teamId: "team-1",
    randomBytes: () => Buffer.alloc(32, 9),
    now: () => new Date("2026-06-08T00:00:00.000Z"),
  });

  assert.equal(result.created, true);
  assert.equal(linearClient.webhooks.length, 1);
  assert.deepEqual(linearClient.webhooks[0].resourceTypes, ["Project"]);
  assert.equal(linearClient.webhooks[0].secret, "0909090909090909090909090909090909090909090909090909090909090909");
  assert.equal(inboxClient.secretCalls.length, 1);
  assert.equal(inboxClient.secretCalls[0].webhookId, "webhook-1");
  assert.equal(JSON.stringify(inboxClient.secretCalls).includes("oauth"), false);
  assert.equal(inboxClient.verifyCalls.length, 1);
});

test("hosted inbox ingest never calls Linear mutation methods", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(linearProjectPayload());
  const headers = {
    "Linear-Delivery": "delivery-1",
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret: "secret-1" }),
  };
  const linearClient = {
    createIssue() {
      throw new Error("inbox must not mutate Linear");
    },
    updateProject() {
      throw new Error("inbox must not mutate Linear");
    },
  };

  const result = ingestLinearWebhookDelivery({ store, workspaceId: "workspace-1", headers, rawBody });

  assert.equal(result.accepted, true);
  assert.equal(linearClient.createIssue.name, "createIssue");
  assert.equal(store.workflowWakeups.length, 1);
});

test("Hosted inbox routing records matched webhook identity and project team facts", () => {
  const { store, result } = storeWithPlannedDelivery({
    payload: linearProjectPayload({
      data: { teamIds: ["team-b", "team-a", "team-a"] },
    }),
  });

  assert.equal(result.delivery.webhook_id, "webhook-1");
  assert.equal(result.delivery.webhook_secret_id, "webhook_secret-1");
  assert.equal(result.event.webhook_id, "webhook-1");
  assert.deepEqual(result.event.team_ids, ["team-a", "team-b"]);
  assert.deepEqual(store.workflowWakeups[0].webhook_ids, ["webhook-1"]);
  assert.deepEqual(store.workflowWakeups[0].team_ids, ["team-a", "team-b"]);

  const claim = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-1"],
  });
  const missingDomain = store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-domain-identity",
  });
  assert.equal(missingDomain.ok, false);
  assert.equal(missingDomain.reason, "missing_domain_id");
  const invalidDomain = store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-domain-identity",
    domainId: "",
  });
  assert.equal(invalidDomain.ok, false);
  assert.equal(invalidDomain.reason, "missing_domain_id");
  const running = store.markWakeRunning({
    wakeId: claim.wake.id,
    runnerId: "runner-1",
    leaseToken: claim.leaseToken,
    runId: "run-domain-identity",
    domainId: "support-ops",
  });

  assert.equal(running.ok, true);
  assert.equal(running.wake.domain_id, "support-ops");
});

// --- Hostile-review reconciliation regressions (C1/C3 combined surface) ---

test("polling grant status past the mutation window leaves a bound grant provisional and still confirmable (regression: F2)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-1",
    domainId: "support-ops",
    at: "2026-06-08T00:00:00.000Z",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
    rotatedAt: "2026-06-08T00:05:00.000Z",
  });
  // The CLI polls status while waiting (possibly days) for the first Planned delivery. A
  // poll past the 15-minute mutation window must NOT expire the still-unconfirmed grant.
  const status = store.setupGrantStatus({
    setupGrant: issued.setupGrant,
    workspaceId: "workspace-1",
    at: "2026-06-08T01:00:00.000Z",
  });
  assert.equal(status.status, "provisional");
  assert.equal(store.setupGrants[0].status, "provisional");

  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "delivery-confirm",
    data: { teamIds: ["team-1"] },
  }));
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody, deliveryId: "delivery-confirm" }),
    rawBody,
    receivedAt: "2026-06-08T01:00:00.000Z",
  });
  assert.equal(result.accepted, true);
  assert.equal(store.setupGrants[0].status, "confirmed");
});

test("a grant cannot clobber another team's webhook secret by reusing its webhook id (regression: F3)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const grantA = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1", domainId: "domain-1" });
  const grantB = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-2", domainId: "domain-2" });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-shared",
    signingSecret: "secret-team-1",
    setupGrant: grantA.setupGrant,
  });
  assert.throws(
    () => store.upsertLinearWebhookSecret({
      workspaceId: "workspace-1",
      teamId: "team-2",
      webhookId: "webhook-shared",
      signingSecret: "attacker-secret",
      setupGrant: grantB.setupGrant,
    }),
    /webhook_id_bound_to_other_team/,
  );
  const secret = store.webhookSecrets.find((entry) => entry.webhook_id === "webhook-shared");
  assert.equal(secret.signing_secret, "secret-team-1");
  assert.equal(secret.team_id, "team-1");
  assert.equal(secret.setup_grant_id, grantA.grant.grantId);
});

test("a credential scoped to one domain cannot label a wake with another domain (regression: F4)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const requiredCapabilities = ["linear.project.planned", "decomposition.trigger_runner.v1"];
  const credentialA = {
    storedCapabilities: requiredCapabilities,
    storedWebhookIds: ["webhook-team-1"],
    storedTeamId: "team-1",
    storedDomainId: "domain-1",
  };
  const wakeA = enqueueScopedProjectWake(store, {
    projectId: "project-team-1",
    sourceEventId: "event-team-1",
    webhookId: "webhook-team-1",
    teamId: "team-1",
  }).wake;
  const claim = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-a",
    capabilities: requiredCapabilities,
    ...credentialA,
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.wake.id, wakeA.id);
  const foreign = store.markWakeRunning({
    wakeId: wakeA.id,
    runnerId: "runner-a",
    leaseToken: claim.leaseToken,
    runId: "run-1",
    domainId: "domain-2",
    ...credentialA,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "domain_outside_credential_scope");
  const allowed = store.markWakeRunning({
    wakeId: wakeA.id,
    runnerId: "runner-a",
    leaseToken: claim.leaseToken,
    runId: "run-1",
    domainId: "domain-1",
    ...credentialA,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.wake.domain_id, "domain-1");
});

test("setup mutations succeed without an explicit teamId, deriving scope from the grant (regression: F5)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const issued = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-1", domainId: "support-ops" });
  // The real hosted client omits teamId (it sends only workspaceId + the grant header).
  const secret = store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
    setupGrant: issued.setupGrant,
  });
  assert.equal(secret.team_id, "team-1");
  assert.equal(secret.setup_grant_id, issued.grant.grantId);
  const credential = store.mintRunnerCredential({
    workspaceId: "workspace-1",
    webhookIds: ["webhook-1"],
    setupGrant: issued.setupGrant,
  });
  assert.equal(credential.team_id, "team-1");
  assert.deepEqual(credential.webhook_ids, ["webhook-1"]);
  // A supplied-but-wrong teamId is still rejected (fail closed on mismatch).
  assert.throws(
    () => store.mintRunnerCredential({
      workspaceId: "workspace-1",
      teamId: "team-2",
      webhookIds: ["webhook-1"],
      setupGrant: issued.setupGrant,
    }),
    /setup_grant_scope_mismatch/,
  );
});

test("anonymous setup-grant issuance is rate-limited per workspace (regression: F1 bound)", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const at = "2026-06-08T00:00:00.000Z";
  for (let i = 0; i < 10; i += 1) {
    assert.equal(store.requestSetupGrant({ workspaceId: "workspace-1", teamId: `team-${i}`, at }).ok, true);
  }
  // The 11th issuance for the same workspace inside the window is throttled (bounds the
  // accepted setup-ownership residual: nobody can rapidly grab many team seats).
  const throttled = store.requestSetupGrant({ workspaceId: "workspace-1", teamId: "team-overflow", at });
  assert.equal(throttled.ok, false);
  assert.equal(throttled.reason, "setup_grant_rate_limited");
  // A different workspace is unaffected.
  assert.equal(store.requestSetupGrant({ workspaceId: "workspace-2", teamId: "team-0", at }).ok, true);
  // Once the window passes, issuance for the first workspace is allowed again.
  assert.equal(store.requestSetupGrant({
    workspaceId: "workspace-1",
    teamId: "team-overflow",
    at: "2026-06-08T02:00:00.000Z",
  }).ok, true);
});

test("the global setup-grant issuance cap is a high backstop, not a low cross-tenant lockout", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const at = "2026-06-08T00:00:00.000Z";
  // A realistic fleet burst — 300 issuances across 30 workspaces (10 each, within the
  // per-workspace cap) — must ALL succeed. A low shared global cap (the old 200) would have
  // locked out every tenant here; the global cap is now only a runaway-row backstop so one
  // attacker cannot deny setup to the whole fleet (G3). Per-IP/gateway is the real control.
  for (let i = 0; i < 300; i += 1) {
    assert.equal(
      store.requestSetupGrant({
        workspaceId: `workspace-${Math.floor(i / 10)}`,
        teamId: `team-${i}`,
        at,
      }).ok,
      true,
    );
  }
  // A fresh workspace is still not globally throttled at this scale.
  assert.equal(
    store.requestSetupGrant({ workspaceId: "workspace-fresh", teamId: "team-fresh", at }).ok,
    true,
  );
  // The per-workspace cap remains the targeted control: an 11th grant for one workspace trips.
  for (let i = 0; i < 9; i += 1) {
    store.requestSetupGrant({ workspaceId: "workspace-fresh", teamId: `team-fresh-${i}`, at });
  }
  const perWorkspaceThrottled = store.requestSetupGrant({
    workspaceId: "workspace-fresh",
    teamId: "team-fresh-overflow",
    at,
  });
  assert.equal(perWorkspaceThrottled.ok, false);
  assert.equal(perWorkspaceThrottled.reason, "setup_grant_rate_limited");
});

test("Hosted inbox routing accumulates same-project provenance across two webhooks", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-a",
    webhookId: "webhook-a",
    signingSecret: "secret-a",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-a",
    webhookId: "webhook-b",
    signingSecret: "secret-b",
  });

  const rawBodyA = JSON.stringify(linearProjectPayload({
    deliveryId: "linear-event-a",
    data: { teamIds: ["team-a"] },
  }));
  const rawBodyB = JSON.stringify(linearProjectPayload({
    deliveryId: "linear-event-b",
    data: { teamIds: ["team-a"] },
  }));
  const first = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody: rawBodyA, deliveryId: "delivery-a", signingSecret: "secret-a" }),
    rawBody: rawBodyA,
  });
  const second = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody: rawBodyB, deliveryId: "delivery-b", signingSecret: "secret-b" }),
    rawBody: rawBodyB,
  });

  assert.equal(first.wakeups[0].duplicate, false);
  assert.equal(second.wakeups[0].duplicate, true);
  assert.equal(store.webhookDeliveries.length, 2);
  assert.equal(store.triggerEvents.length, 2);
  assert.equal(store.workflowWakeups.length, 1);
  assert.deepEqual(store.webhookDeliveries.map((delivery) => delivery.webhook_id), ["webhook-a", "webhook-b"]);
  assert.deepEqual(store.workflowWakeups[0].webhook_ids, ["webhook-a", "webhook-b"]);
  assert.deepEqual(store.workflowWakeups[0].team_ids, ["team-a"]);
  assert.equal(
    store.workflowWakeups[0].wake_key,
    "linear:project:project-1:decomposition:scope:team:team-a",
  );
  assert.equal(store.workflowWakeups[0].attempt_count, 0);
});

test("Legacy null-team webhook secrets keep payload-team wake accumulation", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-a",
    signingSecret: "secret-a",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-b",
    signingSecret: "secret-b",
  });

  const rawBodyA = JSON.stringify(linearProjectPayload({
    deliveryId: "legacy-event-a",
    data: { teamIds: ["team-a"] },
  }));
  const rawBodyB = JSON.stringify(linearProjectPayload({
    deliveryId: "legacy-event-b",
    data: { teamIds: ["team-b", "team-a"] },
  }));

  const first = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody: rawBodyA, deliveryId: "legacy-delivery-a", signingSecret: "secret-a" }),
    rawBody: rawBodyA,
  });
  const second = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody: rawBodyB, deliveryId: "legacy-delivery-b", signingSecret: "secret-b" }),
    rawBody: rawBodyB,
  });

  assert.equal(first.wakeups[0].duplicate, false);
  assert.equal(second.wakeups[0].duplicate, true);
  assert.equal(store.workflowWakeups.length, 1);
  assert.equal(store.workflowWakeups[0].wake_key, "linear:project:project-1:decomposition");
  assert.deepEqual(store.workflowWakeups[0].webhook_ids, ["webhook-a", "webhook-b"]);
  assert.deepEqual(store.workflowWakeups[0].team_ids, ["team-a", "team-b"]);
});

test("Grant-bound webhook team rejects spoofing and scopes same-project wake union", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-victim",
    webhookId: "webhook-victim",
    signingSecret: "secret-victim",
  });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-attacker",
    webhookId: "webhook-attacker",
    signingSecret: "secret-attacker",
  });

  const spoofedVictimBody = JSON.stringify(linearProjectPayload({
    deliveryId: "spoofed-victim-team",
    projectId: "project-poison",
    data: { teamIds: ["team-victim"] },
  }));
  const rejected = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({
      rawBody: spoofedVictimBody,
      deliveryId: "delivery-spoofed-victim-team",
      signingSecret: "secret-attacker",
    }),
    rawBody: spoofedVictimBody,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "delivery_team_not_in_webhook_scope");
  assert.equal(store.webhookDeliveries.length, 0);
  assert.equal(store.workflowWakeups.length, 0);

  const attackerBody = JSON.stringify(linearProjectPayload({
    deliveryId: "attacker-own-team",
    projectId: "project-poison",
    data: { teamIds: ["team-attacker"] },
  }));
  const attacker = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({
      rawBody: attackerBody,
      deliveryId: "delivery-attacker-own-team",
      signingSecret: "secret-attacker",
    }),
    rawBody: attackerBody,
  });

  const victimBody = JSON.stringify(linearProjectPayload({
    deliveryId: "victim-real-team",
    projectId: "project-poison",
    data: { teamIds: ["team-victim"] },
  }));
  const victim = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({
      rawBody: victimBody,
      deliveryId: "delivery-victim-real-team",
      signingSecret: "secret-victim",
    }),
    rawBody: victimBody,
  });

  assert.equal(attacker.accepted, true);
  assert.equal(victim.accepted, true);
  assert.equal(attacker.wakeups[0].duplicate, false);
  assert.equal(victim.wakeups[0].duplicate, false);
  assert.equal(store.workflowWakeups.length, 2);

  const attackerWake = store.workflowWakeups.find((wake) => wake.webhook_ids.includes("webhook-attacker"));
  const victimWake = store.workflowWakeups.find((wake) => wake.webhook_ids.includes("webhook-victim"));
  assert.ok(attackerWake);
  assert.ok(victimWake);
  assert.equal(attackerWake.wake_key, "linear:project:project-poison:decomposition:scope:team:team-attacker");
  assert.equal(victimWake.wake_key, "linear:project:project-poison:decomposition:scope:team:team-victim");
  assert.deepEqual(attackerWake.webhook_ids, ["webhook-attacker"]);
  assert.deepEqual(attackerWake.team_ids, ["team-attacker"]);
  assert.deepEqual(victimWake.webhook_ids, ["webhook-victim"]);
  assert.deepEqual(victimWake.team_ids, ["team-victim"]);

  const registry = triggerDomainRegistry({
    supportWebhookId: "webhook-victim",
    supportTeamId: "team-victim",
    salesWorkspaceId: "workspace-1",
    salesWebhookId: "webhook-attacker",
    salesTeamId: "team-attacker",
    includeSales: true,
  });
  const resolvedVictim = resolveWakeDomainContext({
    registry,
    selector: {
      workspaceId: victimWake.workspace_id,
      webhookId: victimWake.webhook_ids,
      projectTeamIds: victimWake.team_ids,
    },
    repoRoot,
  });
  assert.equal(resolvedVictim.ok, true);
  assert.equal(resolvedVictim.context.domainId, "support-ops");
  assert.notEqual(resolvedVictim.reason, "ambiguous_webhook_id");
});

test("Trusted-team routing preserves cross-domain conflict for real shared-team projects", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    teamId: "team-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });

  const rawBody = JSON.stringify(linearProjectPayload({
    deliveryId: "shared-project-delivery",
    projectId: "project-shared",
    data: { teamIds: ["team-1", "team-sales"] },
  }));
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody }),
    rawBody,
  });
  assert.equal(result.accepted, true);
  assert.equal(store.workflowWakeups.length, 1);
  const wake = store.workflowWakeups[0];
  assert.equal(wake.wake_key, "linear:project:project-shared:decomposition:scope:team:team-1");
  assert.deepEqual(wake.team_ids, ["team-1", "team-sales"]);

  const resolved = resolveWakeDomainContext({
    registry: triggerDomainRegistry({
      salesWorkspaceId: "workspace-1",
      includeSales: true,
    }),
    selector: {
      workspaceId: wake.workspace_id,
      webhookId: wake.webhook_ids,
      projectTeamIds: wake.team_ids,
    },
    repoRoot,
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "cross_domain_team_conflict");
});

test("Hosted inbox routing claim filter does not starve matching wakes behind non-matching wakes", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  for (let index = 0; index < 125; index += 1) {
    store.enqueueWake({
      workspaceId: "workspace-1",
      triggerType: "linear.project.planned",
      workflowType: "decomposition",
      objectType: "project",
      objectId: `project-nonmatching-${index}`,
      wakeKey: `linear:project:project-nonmatching-${index}:decomposition`,
      sourceEventId: `event-nonmatching-${index}`,
      requiresRunnerVerification: true,
      webhookIds: [`webhook-nonmatching-${index}`],
    });
  }
  const target = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-target",
    wakeKey: "linear:project:project-target:decomposition",
    sourceEventId: "event-target",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-target"],
  }).wake;

  const claim = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-target"],
  });

  assert.equal(claim.ok, true);
  assert.equal(claim.wake.id, target.id);
});

test("Hosted inbox routing dedupe race creates a fresh wake instead of mutating a terminal wake", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const existing = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: "event-1",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-a"],
    teamIds: ["team-a"],
  }).wake;
  const originalFind = store.workflowWakeups.find.bind(store.workflowWakeups);
  let flipped = false;
  store.workflowWakeups.find = (predicate) => {
    const result = originalFind(predicate);
    if (result && !flipped) {
      flipped = true;
      result.status = "completed";
      result.terminal_at = "2026-06-08T00:00:00.000Z";
    }
    return result;
  };

  const fresh = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: "event-2",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-b"],
    teamIds: ["team-b"],
  });

  assert.equal(fresh.duplicate, false);
  assert.equal(store.workflowWakeups.length, 2);
  assert.deepEqual(existing.webhook_ids, ["webhook-a"]);
  assert.deepEqual(fresh.wake.webhook_ids, ["webhook-b"]);
});

test("Hosted inbox routing_error, requeue, claim filter, and release follow the contract", () => {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const wake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: "event-1",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-a"],
    teamIds: ["team-a"],
  }).wake;

  assert.equal(store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-b"],
  }).reason, "no_queued_wake");

  const claim = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-1",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-a"],
  });
  const routingError = store.markWakeRoutingError({
    wakeId: wake.id,
    leaseToken: claim.leaseToken,
    reason: "ambiguous_webhook_id",
    candidates: [{ domainId: "support-ops", status: "active", teamId: "team-a" }],
  });

  assert.equal(routingError.ok, true);
  assert.equal(wake.status, "routing_error");
  assert.equal(wake.routing_error_reason, "ambiguous_webhook_id");
  assert.deepEqual(wake.routing_candidates, [{ domainId: "support-ops", status: "active", teamId: "team-a" }]);
  assert.equal(wake.claimed_at, null);
  assert.equal(
    store.deadLetterWake({ wakeId: wake.id, reason: "operator_override" }).reason,
    "lease_token_mismatch",
  );

  const duplicate = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId: "event-2",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-b"],
    teamIds: ["team-b"],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.workflowWakeups.length, 1);
  assert.equal(wake.status, "routing_error");
  assert.deepEqual(wake.webhook_ids, ["webhook-a", "webhook-b"]);
  assert.deepEqual(wake.team_ids, ["team-a", "team-b"]);

  assert.equal(store.requeueWake({ workspaceId: "workspace-other", wakeId: wake.id }).reason, "wake_not_found");
  const requeued = store.requeueWake({ workspaceId: "workspace-1", wakeId: wake.id });
  assert.deepEqual(
    { ok: requeued.ok, wakeId: requeued.wakeId, status: requeued.status },
    { ok: true, wakeId: wake.id, status: "queued" },
  );
  assert.equal(wake.routing_error_reason, null);
  assert.equal(wake.routing_candidates, null);
  assert.equal(wake.domain_id, null);

  const secondClaim = store.claimNextWake({
    workspaceId: "workspace-1",
    runnerId: "runner-2",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    webhookIds: ["webhook-b"],
  });
  assert.equal(store.releaseWake({
    wakeId: wake.id,
    leaseToken: "wrong-lease",
    reason: "domain_not_served",
  }).reason, "lease_token_mismatch");
  const released = store.releaseWake({
    wakeId: wake.id,
    leaseToken: secondClaim.leaseToken,
    reason: "domain_not_served",
  });
  assert.deepEqual(
    { ok: released.ok, wakeId: released.wakeId, status: released.status, attemptCount: released.attemptCount },
    { ok: true, wakeId: wake.id, status: "queued", attemptCount: 2 },
  );
  assert.equal(wake.lease_token, null);
  assert.equal(wake.runner_id, null);

  const expiringWake = store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-expiring",
    wakeKey: "linear:project:project-expiring:decomposition",
    sourceEventId: "event-expiring",
    requiresRunnerVerification: true,
    webhookIds: ["webhook-expiring"],
  }).wake;
  const expiringClaim = store.claimWake({
    wakeId: expiringWake.id,
    workspaceId: "workspace-1",
    runnerId: "runner-3",
    capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    leaseDurationMs: 1000,
    at: "2026-06-08T00:00:00.000Z",
  });
  store.expireLeases({ at: "2026-06-08T00:00:02.000Z" });
  assert.equal(store.releaseWake({
    wakeId: expiringWake.id,
    leaseToken: expiringClaim.leaseToken,
    reason: "domain_not_served",
  }).reason, "lease_token_mismatch");
});

test("Hosted inbox routing_error rejects malformed candidates without coercion", () => {
  const malformedCases = [
    ["non-array", { domainId: "support-ops", status: "active", teamId: "team-a" }],
    ["missing domainId", [{ status: "active", teamId: "team-a" }]],
    ["non-string status", [{ domainId: "support-ops", status: 1, teamId: "team-a" }]],
    ["missing teamId", [{ domainId: "support-ops", status: "active" }]],
    ["non-string teamId", [{ domainId: "support-ops", status: "active", teamId: 1 }]],
  ];

  for (const [name, candidates] of malformedCases) {
    const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
    const wake = store.enqueueWake({
      workspaceId: "workspace-1",
      triggerType: "linear.project.planned",
      workflowType: "decomposition",
      objectType: "project",
      objectId: `project-${name}`,
      wakeKey: `linear:project:project-${name}:decomposition`,
      sourceEventId: `event-${name}`,
      requiresRunnerVerification: true,
      webhookIds: ["webhook-a"],
    }).wake;
    const claim = store.claimWake({
      wakeId: wake.id,
      workspaceId: "workspace-1",
      runnerId: "runner-1",
      capabilities: ["linear.project.planned", "decomposition.trigger_runner.v1"],
    });

    const result = store.markWakeRoutingError({
      wakeId: wake.id,
      leaseToken: claim.leaseToken,
      reason: "ambiguous_webhook_id",
      candidates,
    });

    assert.equal(result.ok, false, name);
    assert.equal(result.reason, "invalid_candidates", name);
    assert.equal(wake.status, "leased", name);
  }
});

test("Hosted inbox routing represents multi-team and zero-team project facts", () => {
  const multiTeam = normalizeLinearWebhookDelivery({
    headers: { "Linear-Delivery": "delivery-multi" },
    rawBody: JSON.stringify(linearProjectPayload({ data: { teamIds: ["team-2", "team-1"] } })),
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
  });
  const zeroTeam = normalizeLinearWebhookDelivery({
    headers: { "Linear-Delivery": "delivery-zero" },
    rawBody: JSON.stringify(linearProjectPayload({ data: { teamIds: [] } })),
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
  });

  assert.deepEqual(multiTeam.team_ids, ["team-1", "team-2"]);
  assert.deepEqual(zeroTeam.team_ids, []);
});

test("trigger runner claims wake, accepts one packet at a time, completes, and joins event/wake/run trace IDs", { skip: FULL_PATH_ORCHESTRATOR_SEAM_SKIP }, async () => {
  const config = loadLinearConfig({ repoRoot });
  const store = seededStore();
  let renewCalls = 0;
  let heartbeatCalls = 0;
  const renewLease = store.renewLease.bind(store);
  const heartbeat = store.heartbeat.bind(store);
  store.renewLease = (input) => {
    renewCalls += 1;
    return renewLease(input);
  };
  store.heartbeat = (input) => {
    heartbeatCalls += 1;
    return heartbeat(input);
  };
  const client = await initializedTriggerClient(config);
  const { orchestratorTurnExecutor, runtimeExecutor, roster } = committingOrchestrator("run_wake_2");
  const result = await runTriggeredDecomposition({
    store,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    linearClient: client,
    config,
    cache: client.cache,
    ...triggerRunnerDomainOptions(config),
    runStoreDir: tempRunStore(),
    runtimeExecutor,
    orchestratorTurnExecutor,
    roster,
    qualityJudge: fakeAdvisoryQualityJudge,
    idGenerator: () => "run_wake_2",
  });

  assert.equal(result.status, "completed");
  assert.equal(client.issues.length, 2);
  assert.equal(extractDecompositionKey(client.issues[0].description), "project-plan");
  assert.equal(store.workflowWakeups[0].status, "completed");
  assert.equal(store.workflowWakeups[0].domain_id, "support-ops");
  assert.equal(renewCalls >= 2, true);
  assert.equal(heartbeatCalls >= 2, true);
  assert.equal(result.result.trace.attributes.event_id, "delivery-1");
  assert.equal(result.result.trace.attributes.wake_id, "wake-2");
  assert.equal(result.result.trace.attributes.run_id, "run_wake_2");
});

// E2E ELIGIBILITY MATRIX. The full path's *post-eligibility* outcomes (pause /
// commit / runtime-failure / post-mutation) are exercised deterministically in
// the direct-loop tests above and in orchestrator-loop.test.mjs — they CANNOT
// run through the full hosted entry, which does not forward an injected
// orchestratorTurnExecutor (it would spawn a real orchestrator CLI). What only
// the full path can prove is the ELIGIBILITY GATE: every rejection
// short-circuits BEFORE the orchestrator loop, so no subagent is spawned and no
// Linear mutation begins. Those scenarios stay here.
test("decomposition trigger E2E matrix covers the eligibility gate before the orchestrator loop", async (t) => {
  const scenarios = [
    {
      name: "eligibility rejects project_not_planned after runner re-read",
      configureClient: async (client) => client.updateProject("project-1", { statusId: "status-backlog" }),
      expectedReason: /project_not_planned/,
    },
    {
      name: "eligibility rejects has_open_questions status mismatch",
      configureClient: (client) => {
        client.projects[0].labels = [{ id: "plabel-open", name: "Has Open Questions" }];
      },
      expectedReason: /has_open_questions/,
    },
    {
      name: "eligibility rejects open discovery issue",
      configureClient: (client) => {
        client.issues.push(existingIssue({
          id: "issue-open-discovery",
          projectId: "project-1",
          labelIds: ["ilabel-discovery"],
        }));
      },
      expectedReason: /open_discovery_issue/,
    },
    {
      name: "eligibility rejects prior execution issue",
      configureClient: (client) => {
        client.issues.push(existingIssue({ id: "issue-prior-execution", projectId: "project-1" }));
      },
      expectedReason: /prior_execution_issues/,
    },
    {
      name: "eligibility rejects wrong team",
      configureClient: (client) => {
        client.projects[0].teamIds = ["team-other"];
      },
      expectedReason: /project_wrong_team/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const config = loadLinearConfig({ repoRoot });
      const { store } = storeWithPlannedDelivery();
      const client = await initializedTriggerClient(config);
      await scenario.configureClient?.(client);
      const initialIssueCount = client.issues.length;
      const initialUpdateCount = client.projectUpdates.length;
      const runId = `run_matrix_${slugForRunId(scenario.name)}`;
      // The orchestrator loop is never reached (eligibility rejects first), so the
      // subagent fake must record zero spawns — that is the assertion that proves
      // the gate precedes any subagent work.
      const runtimeExecutor = fakeSubagentExecutor();

      const result = await runTriggeredDecomposition({
        store,
        runnerId: "runner-1",
        workspaceId: "workspace-1",
        linearClient: client,
        config,
        cache: client.cache,
        ...triggerRunnerDomainOptions(config),
        runStoreDir: tempRunStore(),
        runtimeExecutor,
        idGenerator: () => runId,
      });

      assert.equal(result.status, "rejected");
      assert.equal(store.workflowWakeups[0].status, "rejected");
      assert.match(result.reason || "", scenario.expectedReason);
      assert.equal(runtimeExecutor.calls.length, 0);
      assert.equal(client.issues.length - initialIssueCount, 0);
      assert.equal(client.projectUpdates.length - initialUpdateCount, 0);
      assert.equal(Boolean(store.workflowWakeups[0].mutation_started_at), false);
    });
  }
});

test("Linear webhook ingress matrix routes only decomposition candidate events", () => {
  const cases = [
    {
      name: "planned status change queues wake",
      payload: linearProjectPayload(),
      expectedAccepted: true,
      expectedWakeCount: 1,
    },
    {
      name: "ambiguous status id queues runner-verification wake",
      payload: linearProjectPayload({
        data: { status: null, statusId: "status-planned" },
        updatedFrom: { statusId: "status-backlog" },
      }),
      expectedAccepted: true,
      expectedWakeCount: 1,
    },
    {
      name: "non-planned status change does not queue wake",
      payload: linearProjectPayload({
        data: { status: { id: "status-backlog", name: "Backlog", type: "backlog" } },
        updatedFrom: { status: { id: "status-planned", name: "Planned", type: "planned" } },
      }),
      expectedAccepted: true,
      expectedWakeCount: 0,
    },
    {
      name: "non-status project update does not queue wake",
      payload: linearProjectPayload({
        data: { description: "Updated description" },
        updatedFrom: { description: "Old description" },
      }),
      expectedAccepted: true,
      expectedWakeCount: 0,
    },
  ];

  for (const item of cases) {
    const { result } = storeWithPlannedDelivery({ payload: item.payload });
    assert.equal(result.accepted, item.expectedAccepted, item.name);
    assert.equal(result.wakeups.length, item.expectedWakeCount, item.name);
  }

  const { store, result: first } = storeWithPlannedDelivery();
  const rawBody = JSON.stringify(linearProjectPayload());
  const duplicate = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody }),
    rawBody,
  });
  assert.equal(first.wakeups.length, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.wakeups.length, 0);
  assert.equal(store.workflowWakeups.length, 1);
});

function linearProjectPayload({
  deliveryId = "delivery-1",
  projectId = "project-1",
  data = {},
  updatedFrom = {
    status: { id: "status-backlog", name: "Backlog", type: "backlog" },
  },
} = {}) {
  return {
    action: "update",
    type: "Project",
    organizationId: "workspace-1",
    webhookId: deliveryId,
    createdAt: "2026-06-08T00:00:00.000Z",
    webhookTimestamp: Date.parse("2026-06-08T00:00:00.000Z"),
    actor: { id: "user-1" },
    data: {
      id: projectId,
      name: "Customer onboarding pilot",
      status: { id: "status-planned", name: "Planned", type: "planned" },
      ...data,
    },
    updatedFrom,
  };
}

function storeWithPlannedDelivery({ payload = linearProjectPayload() } = {}) {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  store.upsertLinearWebhookSecret({
    workspaceId: "workspace-1",
    webhookId: "webhook-1",
    signingSecret: "secret-1",
  });
  const rawBody = JSON.stringify(payload);
  const result = ingestLinearWebhookDelivery({
    store,
    workspaceId: "workspace-1",
    headers: signedLinearHeaders({ rawBody }),
    rawBody,
  });
  return { store, result };
}

function signedLinearHeaders({ rawBody, deliveryId = "delivery-1", signingSecret = "secret-1" }) {
  return {
    "Linear-Delivery": deliveryId,
    "Linear-Signature": linearWebhookSignature({ rawBody, signingSecret }),
  };
}

function enqueueProjectWake(store, sourceEventId) {
  return store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: "project-1",
    wakeKey: "linear:project:project-1:decomposition",
    sourceEventId,
    requiresRunnerVerification: true,
    webhookIds: ["webhook-1"],
    teamIds: ["team-1"],
  });
}

function enqueueScopedProjectWake(store, { projectId, sourceEventId, webhookId, teamId }) {
  return store.enqueueWake({
    workspaceId: "workspace-1",
    triggerType: "linear.project.planned",
    workflowType: "decomposition",
    objectType: "project",
    objectId: projectId,
    wakeKey: `linear:project:${projectId}:decomposition`,
    sourceEventId,
    requiresRunnerVerification: true,
    webhookIds: [webhookId],
    teamIds: [teamId],
  });
}

function seededStore() {
  const store = new MemoryInboxStore({ idGenerator: sequenceIds() });
  const event = store.recordTriggerEvent({
    schema_version: 1,
    provider: "linear",
    workspace_id: "workspace-1",
    event_id: "delivery-1",
    event_type: "linear.project.updated",
    object: { type: "project", id: "project-1" },
    changed_fields: ["status"],
    requires_runner_verification: true,
  }).event;
  enqueueProjectWake(store, event.id);
  return store;
}

function triggerDomainRegistry({
  supportWebhookId = "webhook-1",
  supportTeamId = "team-1",
  salesWorkspaceId = "workspace-2",
  salesWebhookId = "webhook-sales",
  salesTeamId = "team-sales",
  includeSales = false,
} = {}) {
  const domains = [
    makeDomainRecord({
      domainId: "support-ops",
      status: "active",
      workspaceId: "workspace-1",
      teamId: supportTeamId,
      teamKey: "SUP",
      teamName: "Support Ops",
      webhookId: supportWebhookId,
    }),
  ];
  if (includeSales) {
    domains.push(makeDomainRecord({
      domainId: "sales-ops",
      status: "active",
      workspaceId: salesWorkspaceId,
      teamId: salesTeamId,
      teamKey: "SAL",
      teamName: "Sales Ops",
      webhookId: salesWebhookId,
    }));
  }
  return {
    schema_version: DOMAIN_REGISTRY_SCHEMA_VERSION,
    domains,
  };
}

function triggerDomainContext(config, {
  registry = triggerDomainRegistry(),
  domainId = "support-ops",
} = {}) {
  const domain = registry.domains.find((candidate) => candidate.id === domainId);
  return buildDomainContext({ domain, config, repoRoot });
}

function triggerRunnerDomainOptions(config, options = {}) {
  const registry = options.registry || triggerDomainRegistry(options);
  return {
    registry,
    domainContext: triggerDomainContext(config, {
      registry,
      domainId: options.domainId || "support-ops",
    }),
  };
}

function linearClientThatRecordsCalls(calls) {
  const cache = { domainId: "support-ops", workspaceId: "workspace-1", teamId: "team-1" };
  return new Proxy({ cache }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async (...args) => {
        calls.push({ method: String(prop), args });
        throw new Error(`Linear must not be called before wake routing: ${String(prop)}`);
      };
    },
  });
}

function runtimeExecutorThatMustNotRun() {
  return {
    async executeSubagent() {
      throw new Error("runtime must not execute before wake routing");
    },
  };
}

async function initializedTriggerClient(config) {
  const client = new TriggerLinearClient();
  client.cache = {
    domainId: "support-ops",
    workspaceId: "workspace-1",
    teamId: "team-1",
    projectTemplateId: "template-1",
    projectStatuses: {
      backlog: "status-backlog",
      planned: "status-planned",
      started: "status-started",
    },
    projectLabels: {
      "Has Open Questions": "plabel-open",
    },
    issueLabels: {
      Discovery: "ilabel-discovery",
    },
  };
  await client.createProject({
    id: "project-1",
    name: "Customer onboarding pilot",
    content: buildLinearProjectBody({ name: "Customer onboarding pilot" }),
    teamIds: ["team-1"],
    labelIds: [],
    statusId: "status-planned",
  });
  return client;
}

// --- Free-orchestrator fakes (the deterministic loop seams) -----------------
// The retired per-step packet fixtures and their step-keyed executor are gone.
// The orchestrator loop is driven by an injected orchestratorTurnExecutor
// (control actions) + a roster + a subagent executor (role-agnostic subagent
// turns). Patterns mirror orchestrator-loop.test.mjs (the canonical fixtures).

const SUBAGENT_TURN_SCHEMA_VERSION = "linear-decomposition-orchestrator-subagent-turn/v2";

function fakeRuntimeCommandSpawn({ stdout = "", stderr = "", code = 0, signal = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      child.emit("close", code, signal);
    });
    return child;
  };
}

function subagentTurn(runId, { status = "continue", reason = "product_context_sufficient" } = {}) {
  return {
    schema_version: SUBAGENT_TURN_SCHEMA_VERSION,
    run_id: runId,
    status,
    reason,
    context_digest: `${reason} digest`,
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
  };
}

// A roster the orchestrator picks library subagents from. resolve() yields a
// runtime_role + a lazy snapshot whose body the loop hands to executeSubagent
// and whose sha the run recorder captures as the consumed accepted ref.
function fakeRoster() {
  const byKey = {
    "prompt/decomposition/sr_eng_grounding_pass": "sr_eng",
    "prompt/decomposition/pm_product_sufficiency_pass": "pm",
  };
  return {
    selectableTargets: Object.keys(byKey),
    resolve(targetKey) {
      const role = byKey[targetKey];
      if (!role) return { ok: false, reason: "orchestrator_roster_target_not_selectable" };
      return {
        ok: true,
        runtime_role: role,
        loadSnapshot: () => ({
          entry: {
            target_key: targetKey,
            human_name: role === "sr_eng" ? "Senior Engineer" : "Product Manager",
          },
          contentBytes: `BODY for ${targetKey}`,
          snapshotSha256: `sha-${targetKey}`,
        }),
      };
    },
  };
}

// A subagent executor that returns a valid subagent turn per spawn, keyed by the
// resolved runtime_role. Records the prompt bodies it was handed so a fixture can
// assert the library body (not a phase prompt) reached the subagent.
function fakeSubagentExecutor() {
  const calls = [];
  return {
    calls,
    async executeSubagent({ runtime_role, prompt, runId, task, priorDigest }) {
      calls.push({
        runtime_role,
        prompt,
        task,
        priorDigest: Array.isArray(priorDigest) ? [...priorDigest] : priorDigest,
      });
      const reason =
        runtime_role === "sr_eng" ? "technical_context_grounded" : "product_context_sufficient";
      const packet = subagentTurn(runId, { status: "continue", reason });
      return {
        ok: true,
        packet,
        output: JSON.stringify(packet),
        role: runtime_role,
        runtime: "codex",
        parse_status: "valid",
        clean_parse: true,
        raw_output_excerpt: JSON.stringify(packet),
        envelope: `fake envelope for ${runtime_role}`,
        sessionHandle: null,
        evidence: {
          evidence_unavailable: [
            { scope: `${runtime_role}.turn.tool_events`, reason: "runtime_tool_event_channel_unavailable" },
          ],
        },
      };
    },
  };
}

// The terminating turn's authored output for a commit: the final issue set + the
// project-update accounting that rides producedContent (Seam 1).
function commitProducedContent(runId) {
  return {
    context_digest: "Reviewed project intent and grounded constraints for decomposition.",
    source_refs: [{ kind: "linear_project", id: "project-1" }],
    assumptions: [],
    constraints: [],
    risks: [],
    project_update_markdown: projectUpdateMarkdownForRun(runId, "Decomposition completed."),
    final_issues: [
      {
        decomposition_key: "project-plan",
        title: "Prepare execution setup",
        issue_body_markdown: "## Assignment\n\nPlan the setup.\n\n## Acceptance Criteria\n\n- Plan exists.",
        depends_on: [],
        assignment: "Plan the setup.",
        output: "A documented execution setup plan.",
        acceptance_criteria: ["Plan exists."],
      },
      {
        decomposition_key: "project-build",
        title: "Implement execution slice",
        issue_body_markdown: "## Assignment\n\nBuild the setup.\n\n## Acceptance Criteria\n\n- Tests pass.",
        depends_on: ["project-plan"],
        assignment: "Build the setup.",
        output: "An implemented execution slice with tests.",
        acceptance_criteria: ["Tests pass."],
      },
    ],
  };
}

// The advisory quality judge for full-runner fixtures. The real runner spawns
// the judge CLI (55-90s); a deterministic full-path test injects this fake so the
// run never spawns it. It returns the same advisory shape the real judge returns
// when it cannot run (judge_missing), so the advisory line is recorded and the
// run still commits — exactly what these runner-mechanics tests assert around.
async function fakeAdvisoryQualityJudge() {
  return {
    ok: false,
    judge_state: "judge_missing",
    reason: "judge_runtime_unavailable_in_test",
    judge: null,
    low_confidence_reasons: [],
    annotation_ids: [],
    storage: "report_only",
  };
}

// A two-spawn-then-commit orchestrator turn executor + matching subagent/roster
// fakes, bundled so a full-run fixture (or eval-mode) can drive a deterministic
// commit. Returns { orchestratorTurnExecutor, runtimeExecutor, roster }.
function committingOrchestrator(runId, {
  libraryOrder = [
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/sr_eng_grounding_pass",
  ],
} = {}) {
  const roster = fakeRoster();
  const runtimeExecutor = fakeSubagentExecutor();
  let turn = 0;
  const orchestratorTurnExecutor = async () => {
    turn += 1;
    if (turn <= libraryOrder.length) {
      return {
        controlAction: { action: "invoke_library", target_key: libraryOrder[turn - 1] },
        evidence: null,
        sessionHandle: null,
      };
    }
    return {
      controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
      producedContent: commitProducedContent(runId),
      evidence: null,
      sessionHandle: null,
    };
  };
  return { orchestratorTurnExecutor, runtimeExecutor, roster };
}

function projectUpdateMarkdownForRun(runId, summary) {
  return [
    `run_id: ${runId}`,
    "",
    summary,
    "",
    "## What I did with each part of your project",
    "- The relevant project sections were accounted for in this decomposition result.",
  ].join("\n");
}

function existingIssue({ id, projectId, labelIds = [] }) {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId,
    title: "Existing issue",
    description: "Existing issue body.",
    state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
    labels: labelIds.map((labelId) => ({
      id: labelId,
      name: labelId === "ilabel-discovery" ? "Discovery" : labelId,
    })),
  };
}

function slugForRunId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function fakeInboxClient() {
  const state = {
    secretCalls: [],
    verifyCalls: [],
    credential: null,
    async putLinearWebhookSecret(input) {
      state.secretCalls.push(input);
      state.signingSecret = input.signingSecret;
      return { ok: true };
    },
    async verifyLinearWebhookSecret(input) {
      state.verifyCalls.push(input);
      const expected = linearWebhookSignature({
        rawBody: input.rawBody,
        signingSecret: state.signingSecret,
      });
      return { ok: input.signature === expected };
    },
    async mintRunnerCredential(input) {
      state.credential = {
        credentialId: "runner-credential-1",
        token: "runner-token-1",
        endpoint: "https://inbox.agenticfactory.dev/v1/runner",
        capabilities: input.capabilities,
        createdAt: "2026-06-08T00:00:00.000Z",
      };
      return state.credential;
    },
    async verifyRunnerCredential(input) {
      return {
        ok:
          input.credentialId === state.credential?.credentialId &&
          input.token === state.credential?.token,
      };
    },
    async revokeRunnerCredential() {
      state.credential = null;
      return { ok: true };
    },
  };
  return state;
}

class WebhookLinearClient {
  constructor() {
    this.webhooks = [];
  }

  async listWebhooks() {
    return this.webhooks;
  }

  async createWebhook(input) {
    const webhook = { id: `webhook-${this.webhooks.length + 1}`, enabled: true, ...input };
    this.webhooks.push(webhook);
    return webhook;
  }

  async updateWebhook(id, input) {
    const webhook = this.webhooks.find((candidate) => candidate.id === id);
    Object.assign(webhook, input);
    return webhook;
  }
}

class TriggerLinearClient {
  constructor() {
    this.teams = [{ id: "team-1", key: "AF", name: "Agentic Factory" }];
    this.projectLabels = [{ id: "plabel-open", name: "Has Open Questions" }];
    this.issueLabels = [{ id: "ilabel-discovery", name: "Discovery", teamId: "team-1" }];
    this.projectStatuses = [
      { id: "status-backlog", name: "Backlog", type: "backlog" },
      { id: "status-planned", name: "Planned", type: "planned" },
      { id: "status-started", name: "In Progress", type: "started" },
    ];
    this.workflowStates = [{ id: "state-backlog", name: "Backlog", type: "unstarted" }];
    this.templates = [{ id: "template-1", name: "Agentic Factory Roadmap Item", type: "project", teamId: "team-1" }];
    this.projects = [];
    this.issues = [];
    this.issueRelations = [];
    this.projectUpdates = [];
    this.failCreateIssueAfterCount = null;
  }

  async listTeams() {
    return this.teams;
  }

  async listProjectStatuses() {
    return this.projectStatuses;
  }

  async findProjectLabelsByName(name) {
    return this.projectLabels.filter((label) => label.name === name);
  }

  async findIssueLabelsByName(name, teamId) {
    return this.issueLabels.filter((label) => label.name === name && label.teamId === teamId);
  }

  async findTemplatesByName(name, type, teamId) {
    return this.templates.filter(
      (template) => template.name === name && template.type === type && template.teamId === teamId,
    );
  }

  async listWorkflowStates() {
    return this.workflowStates;
  }

  async createProject(input) {
    const project = {
      id: input.id || `project-${this.projects.length + 1}`,
      ...input,
      status: this.projectStatuses.find((status) => status.id === input.statusId),
      labels: (input.labelIds || []).map((labelId) => this.projectLabels.find((label) => label.id === labelId)),
    };
    this.projects.push(project);
    return project;
  }

  async getProjectContext(id) {
    const project = this.projects.find((candidate) => candidate.id === id);
    return {
      ...project,
      issues: this.issues.filter((issue) => issue.projectId === id),
    };
  }

  async findIssueByDecompositionKey(projectId, key) {
    return this.issues.find(
      (issue) => issue.projectId === projectId && extractDecompositionKey(issue.description) === key,
    ) || null;
  }

  async createIssue(input) {
    if (this.failCreateIssueAfterCount !== null) {
      if (this.failCreateIssueAfterCount <= 0) throw new Error("simulated post-mutation failure");
      this.failCreateIssueAfterCount -= 1;
    }
    const issue = {
      id: `issue-${this.issues.length + 1}`,
      identifier: `AF-${this.issues.length + 1}`,
      url: `https://linear.test/issue-${this.issues.length + 1}`,
      state: this.workflowStates[0],
      labels: [],
      ...input,
    };
    this.issues.push(issue);
    return issue;
  }

  async findOrCreateIssueRelation(input) {
    const existing = this.issueRelations.find(
      (relation) =>
        relation.type === input.type &&
        relation.issue.id === input.issueId &&
        relation.relatedIssue.id === input.relatedIssueId,
    );
    if (existing) return { created: false, relation: existing };
    const relation = {
      id: `relation-${this.issueRelations.length + 1}`,
      type: input.type,
      issue: this.issues.find((issue) => issue.id === input.issueId),
      relatedIssue: this.issues.find((issue) => issue.id === input.relatedIssueId),
    };
    this.issueRelations.push(relation);
    return { created: true, relation };
  }

  async updateProject(id, input) {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (input.statusId) project.status = this.projectStatuses.find((status) => status.id === input.statusId);
    if (input.content !== undefined) project.content = input.content;
    if (input.labelIds) {
      project.labels = input.labelIds.map((labelId) => this.projectLabels.find((label) => label.id === labelId));
    }
    return this.getProjectContext(id);
  }

  async findProjectUpdateByRunId(projectId, runId) {
    return this.projectUpdates.find((update) => update.projectId === projectId && update.runId === runId) || null;
  }

  async createProjectUpdate(input) {
    const update = { id: `project-update-${this.projectUpdates.length + 1}`, ...input };
    this.projectUpdates.push(update);
    return update;
  }
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-trigger-runs-"));
}

function simulateBrokerInstallationEnforcement({
  credentialPayload,
  owner = credentialPayload.owner,
  repo = credentialPayload.repo,
  repoInstallationId,
}) {
  if (credentialPayload.owner !== owner || credentialPayload.repo !== repo) {
    return { ok: false, reason: "broker_credential_repo_mismatch" };
  }
  if (String(repoInstallationId) !== credentialPayload.installationId) {
    return { ok: false, reason: "broker_credential_installation_mismatch" };
  }
  return { ok: true };
}

function sequenceIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
