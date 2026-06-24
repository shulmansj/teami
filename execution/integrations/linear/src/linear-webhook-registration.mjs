import { generateWebhookSigningSecret, linearWebhookSignature } from "./linear-webhook-inbox.mjs";

export const LINEAR_WEBHOOK_HANDOFF_VERIFIED_MESSAGE =
  "connection handoff verified ✓ (the inbox has your signing secret; this does NOT activate your factory — see the next step)";

export async function ensureLinearWebhookRegistration({
  linearClient,
  inboxClient,
  config,
  cache = null,
  workspaceId,
  teamId,
  randomBytes,
  now = () => new Date(),
} = {}) {
  if (!linearClient) throw new Error("Linear client is required for webhook registration.");
  if (!inboxClient) throw new Error("Hosted inbox client is required for webhook registration.");
  const webhookConfig = requiredWebhookConfig(config);
  const resourceTypes = webhookConfig.resource_types || ["Project"];
  const label = webhookConfig.webhook_label || "Agentic Factory hosted inbox";
  const existing = await findExistingWebhook({ linearClient, teamId, label, url: webhookConfig.url, cache });
  const signingSecret = generateWebhookSigningSecret({ randomBytes });

  const webhook = existing
    ? await linearClient.updateWebhook(existing.id, {
        url: webhookConfig.url,
        label,
        teamId,
        resourceTypes,
        secret: signingSecret,
        enabled: true,
      })
    : await linearClient.createWebhook({
        url: webhookConfig.url,
        label,
        teamId,
        resourceTypes,
        secret: signingSecret,
        enabled: true,
      });

  await inboxClient.putLinearWebhookSecret({
    workspaceId,
    webhookId: webhook.id,
    webhookUrl: webhookConfig.url,
    signingSecret,
  });

  const rawBody = JSON.stringify({
    type: "Project",
    action: "update",
    organizationId: workspaceId,
    data: { id: "agentic-factory-signature-check" },
    updatedFrom: { status: { id: "previous" } },
    createdAt: now().toISOString(),
    webhookTimestamp: Date.parse(now().toISOString()),
  });
  const signature = linearWebhookSignature({ rawBody, signingSecret });
  const handoff = await inboxClient.verifyLinearWebhookSecret({
    workspaceId,
    webhookId: webhook.id,
    rawBody,
    signature,
  });
  if (handoff?.ok !== true) {
    throw new Error("Hosted inbox could not verify the Linear webhook signing secret handoff.");
  }

  const handoffVerifiedAt = now().toISOString();
  return {
    webhook: {
      id: webhook.id,
      url: webhook.url || webhookConfig.url,
      label: webhook.label || label,
      enabled: webhook.enabled !== false,
      resourceTypes: webhook.resourceTypes || resourceTypes,
      workspaceId,
      handoffVerifiedAt,
    },
    handoff: {
      ok: true,
      message: LINEAR_WEBHOOK_HANDOFF_VERIFIED_MESSAGE,
      verifiedAt: handoffVerifiedAt,
    },
    created: !existing,
    rotated: Boolean(existing),
  };
}

export async function removeLinearWebhookRegistration({
  linearClient,
  inboxClient,
  workspaceId,
  teamId = null,
  webhookId = null,
} = {}) {
  const result = { webhookDeleted: false, secretDeleted: false };
  if (!webhookId) {
    throw new Error(
      "Cannot remove Linear webhook registration without a concrete webhook_id from the domain registry. Run npm run doctor and delete the webhook manually in Linear if the registry is incomplete.",
    );
  }
  if (webhookId && linearClient?.deleteWebhook) {
    await linearClient.deleteWebhook(webhookId);
    result.webhookDeleted = true;
    const remaining = await linearClient.listWebhooks?.({ teamId });
    if (remaining?.some((webhook) => webhook.id === webhookId)) {
      throw new Error(`Linear webhook ${webhookId} still exists after deletion.`);
    }
  }
  if (workspaceId && inboxClient?.deleteLinearWebhookSecret) {
    await inboxClient.deleteLinearWebhookSecret({ workspaceId, webhookId });
    result.secretDeleted = true;
  }
  return result;
}

async function findExistingWebhook({ linearClient, teamId, label, url, cache }) {
  const cachedId = cache?.webhook?.id || cache?.inbox?.linearWebhook?.id;
  const webhooks = await linearClient.listWebhooks?.({ teamId });
  if (!webhooks) throw new Error("Linear client cannot list webhooks.");
  return (
    webhooks.find((webhook) => cachedId && webhook.id === cachedId) ||
    webhooks.find((webhook) => webhook.label === label && webhook.url === url) ||
    null
  );
}

function requiredWebhookConfig(config) {
  const linear = config?.inbox?.linear || {};
  const url = linear.webhook_url || config?.inbox?.webhook_url;
  if (!url) throw new Error("config.inbox.webhook_url is required for Linear webhook registration.");
  return {
    url,
    webhook_label: linear.webhook_label,
    resource_types: linear.resource_types,
  };
}
