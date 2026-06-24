import crypto from "node:crypto";

import { normalizeProjectStatusType, projectStatusTypeFromPayload } from "./inbox-store.mjs";
import { candidateTriggersForEvent, wakeKeyForTrigger } from "./trigger-registry.mjs";

export const MAX_WEBHOOK_BODY_BYTES = 1048576;

export function generateWebhookSigningSecret({ randomBytes = crypto.randomBytes } = {}) {
  return randomBytes(32).toString("hex");
}

export function linearWebhookSignature({ rawBody, signingSecret }) {
  return crypto.createHmac("sha256", signingSecret).update(rawBody || "").digest("hex");
}

export function normalizeLinearWebhookDelivery({
  headers = {},
  rawBody,
  workspaceId = null,
  receivedAt = new Date().toISOString(),
  deliveryRecordId = null,
  webhookId = null,
  trustedTeamId = null,
} = {}) {
  const payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  const normalizedHeaders = normalizeHeaders(headers);
  const deliveryId =
    normalizedHeaders["linear-delivery"] ||
    payload?.webhookId ||
    `${payload?.type || "unknown"}:${payload?.data?.id || "unknown"}:${payload?.webhookTimestamp || receivedAt}`;
  const providerWorkspaceId = workspaceId || payload?.organizationId;
  const objectType = String(payload?.type || "").toLowerCase();
  const action = payload?.action || "unknown";
  const changedFields = Object.keys(payload?.updatedFrom || {});

  return {
    schema_version: 1,
    provider: "linear",
    workspace_id: providerWorkspaceId,
    event_id: deliveryId,
    event_type: `linear.${objectType}.${action === "update" ? "updated" : action}`,
    occurred_at: payload?.createdAt || new Date(payload?.webhookTimestamp || Date.now()).toISOString(),
    received_at: receivedAt,
    actor: payload?.actor?.id ? { provider_user_id: payload.actor.id } : null,
    object: {
      type: objectType,
      id: payload?.data?.id,
    },
    changed_fields: changedFields,
    webhook_id: webhookId,
    team_ids: projectTeamIdsForTrustedDelivery(payload, trustedTeamId),
    raw_event_ref: deliveryRecordId,
    requires_runner_verification: true,
    // Derived routing fact instead of the raw payload: trigger events persist
    // no product content (data minimization); routing only needs the status type.
    project_status_type: projectStatusTypeFromPayload(payload?.data),
  };
}

export function ingestLinearWebhookDelivery({
  store,
  workspaceId,
  headers = {},
  rawBody,
  receivedAt = new Date().toISOString(),
} = {}) {
  if (!store) throw new Error("inbox store is required.");
  const normalizedHeaders = normalizeHeaders(headers);
  if (Buffer.byteLength(rawBody || "", "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return rejectedLinearDelivery("payload_too_large");
  }
  const signature = normalizedHeaders["linear-signature"];
  if (!signature) return rejectedLinearDelivery("missing_signature_header");
  const deliveryId = normalizedHeaders["linear-delivery"];
  if (!deliveryId) return rejectedLinearDelivery("missing_delivery_header");
  const verification = store.verifyLinearWebhookSignature({ workspaceId, rawBody, signature });
  if (!verification.ok) {
    return rejectedLinearDelivery(verification.reason);
  }
  const trustedTeamId = verification.teamId || null;
  const payload = trustedTeamId ? JSON.parse(rawBody || "{}") : null;
  if (trustedTeamId && !projectTeamIdsFromPayload(payload).includes(trustedTeamId)) {
    return rejectedLinearDelivery("delivery_team_not_in_webhook_scope");
  }
  const deliveryResult = store.recordWebhookDelivery({
    provider: "linear",
    workspaceId,
    deliveryId,
    webhookId: verification.webhookId,
    webhookSecretId: verification.secretId,
    signatureValid: true,
    rawHeaders: headers,
    rawBody,
    receivedAt,
  });
  if (deliveryResult.duplicate) {
    return {
      accepted: true,
      duplicate: true,
      delivery: deliveryResult.delivery,
      wakeups: [],
    };
  }
  const event = normalizeLinearWebhookDelivery({
    headers,
    rawBody,
    workspaceId,
    receivedAt,
    deliveryRecordId: deliveryResult.delivery.id,
    webhookId: verification.webhookId,
    trustedTeamId,
  });
  const eventResult = store.recordTriggerEvent(event);
  const wakeups = routeTriggerEventToWakeups({ store, event: eventResult.event, trustedTeamId });
  return {
    accepted: true,
    duplicate: false,
    delivery: deliveryResult.delivery,
    event: eventResult.event,
    wakeups,
  };
}

function rejectedLinearDelivery(reason) {
  return {
    accepted: false,
    reason,
    duplicate: false,
    delivery: null,
    wakeups: [],
  };
}

export function routeTriggerEventToWakeups({ store, event, registry, trustedTeamId = null } = {}) {
  if (!store) throw new Error("inbox store is required.");
  const wakeups = [];
  for (const trigger of candidateTriggersForEvent(event, registry)) {
    if (!isPlausibleProjectPlannedEvent(event)) continue;
    const workflowType = trigger.workflow_type || trigger.candidate_workflow;
    const wakeResult = store.enqueueWake({
      workspaceId: event.workspace_id,
      triggerType: trigger.trigger_type,
      workflowType,
      objectType: event.object.type,
      objectId: event.object.id,
      wakeKey: wakeKeyForTrigger(trigger, event),
      sourceEventId: event.id,
      requiresRunnerVerification: true,
      reason: event.requires_runner_verification ? "requires_runner_verification" : null,
      webhookIds: event.webhook_id ? [event.webhook_id] : [],
      teamIds: event.team_ids || [],
      routingScopeTeamId: trustedTeamId,
    });
    wakeups.push(wakeResult);
  }
  return wakeups;
}

export function isPlausibleProjectPlannedEvent(event) {
  if (event?.provider !== "linear") return false;
  if (event.event_type !== "linear.project.updated") return false;
  if (event.object?.type !== "project" || !event.object?.id) return false;
  const changed = new Set(event.changed_fields || []);
  const hasStatusChange = hasProjectStatusChange(changed);
  if (changed.size > 0 && !hasStatusChange) return false;
  // Prefer the derived routing fact; fall back to raw_payload only for legacy
  // events recorded before data minimization.
  const currentStatusType =
    normalizeProjectStatusType(event.project_status_type) ??
    projectStatusTypeFromPayload(event.raw_payload?.data);
  if (currentStatusType) return currentStatusType === "planned";
  return changed.size === 0 || hasStatusChange;
}

function hasProjectStatusChange(changed) {
  return (
    changed.has("status") ||
    changed.has("statusId") ||
    changed.has("status_id") ||
    changed.has("state") ||
    changed.has("stateId") ||
    changed.has("projectStatus") ||
    changed.has("projectStatusId") ||
    changed.has("workflowStatus") ||
    changed.has("workflowStatusId")
  );
}

function projectTeamIdsFromPayload(payload = {}) {
  const teamIds = payload?.data?.teamIds;
  if (!Array.isArray(teamIds)) return [];
  return [...new Set(teamIds.filter((teamId) => typeof teamId === "string" && teamId.trim() !== ""))].sort();
}

function projectTeamIdsForTrustedDelivery(payload = {}, trustedTeamId = null) {
  const payloadTeamIds = projectTeamIdsFromPayload(payload);
  if (typeof trustedTeamId !== "string" || trustedTeamId.trim() === "") return payloadTeamIds;
  return payloadTeamIds.length > 1 && payloadTeamIds.includes(trustedTeamId) ? payloadTeamIds : [trustedTeamId];
}

export function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]),
  );
}
