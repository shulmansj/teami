import crypto from "node:crypto";
import path from "node:path";

import {
  createRawFileCredentialStore,
  createRawOsCredentialStore,
} from "./linear-credential-store.mjs";

const DEFAULT_RUNNER_CREDENTIAL_FILE = path.join(".agentic-factory", "inbox-runner-credential.json");

export function createRunnerInboxCredentialStore({
  config,
  domainContext = null,
  domainId = null,
  workspaceId = null,
  target = null,
  repoRoot = process.cwd(),
  platform = process.platform,
  run,
} = {}) {
  const inbox = config?.inbox || {};
  const storage = inbox.credential_storage || "os";
  const identity = runnerCredentialIdentity({ domainContext, domainId, workspaceId });
  const resolvedTarget = target || runnerInboxCredentialTargetForConfig(config, repoRoot, identity);
  const parse = (secret) => {
    if (!secret) return null;
    return JSON.parse(secret);
  };
  const serialize = (credential) => {
    validateRunnerInboxCredential(credential);
    return `${JSON.stringify(credential)}\n`;
  };

  const raw =
    storage === "file"
      ? createRawFileCredentialStore({
          filePath: path.resolve(repoRoot, runnerCredentialFilePath({ inbox, domainId: identity.domainId })),
          target: resolvedTarget,
          warning:
            "Runner inbox credential_storage=file stores a local runner token in an ignored file. Use only for local testing when OS credential storage is unavailable.",
        })
      : createRawOsCredentialStore({ platform, run, target: resolvedTarget });

  return {
    kind: raw.kind,
    target: resolvedTarget,
    warning: raw.warning,

    async readCredential() {
      return parse(await raw.readSecret());
    },

    async writeCredential(credential) {
      await raw.writeSecret(serialize(credential));
    },

    async deleteCredential() {
      await raw.deleteSecret();
    },
  };
}

export async function ensureRunnerInboxCredential({
  inboxClient,
  credentialStore,
  workspaceId,
  runnerName = "local-runner",
  capabilities = ["linear.project.planned", "decomposition.trigger_runner.v1"],
  now = () => new Date(),
} = {}) {
  if (!inboxClient) throw new Error("Hosted inbox client is required to mint runner credentials.");
  if (!credentialStore) throw new Error("Runner inbox credential store is required.");

  const existing = await credentialStore.readCredential();
  if (existing?.token && existing?.workspaceId === workspaceId) {
    const verification = await inboxClient.verifyRunnerCredential({
      workspaceId,
      credentialId: existing.credentialId,
      token: existing.token,
    });
    if (verification?.ok === true) return { credential: existing, created: false, verified: true };
  }

  const minted = await inboxClient.mintRunnerCredential({
    workspaceId,
    runnerName,
    capabilities,
  });
  const credential = {
    schema_version: 1,
    workspaceId,
    credentialId: minted.credentialId,
    token: minted.token,
    endpoint: minted.endpoint || null,
    capabilities: minted.capabilities || capabilities,
    createdAt: minted.createdAt || now().toISOString(),
  };
  await credentialStore.writeCredential(credential);
  return { credential, created: true, verified: false };
}

export async function removeRunnerInboxCredential({ inboxClient, credentialStore, workspaceId } = {}) {
  const existing = await credentialStore?.readCredential?.();
  if (existing?.credentialId && inboxClient?.revokeRunnerCredential) {
    await inboxClient.revokeRunnerCredential({
      workspaceId: workspaceId || existing.workspaceId,
      credentialId: existing.credentialId,
      token: existing.token,
    });
  }
  await credentialStore?.deleteCredential?.();
  return { removed: Boolean(existing) };
}

export function validateRunnerInboxCredential(credential) {
  const failures = [];
  if (credential?.schema_version !== 1) failures.push("unsupported_schema_version");
  if (!credential?.workspaceId) failures.push("missing_workspace_id");
  if (!credential?.credentialId) failures.push("missing_credential_id");
  if (!credential?.token) failures.push("missing_runner_token");
  if (!Array.isArray(credential?.capabilities)) failures.push("missing_capabilities");
  if (failures.length > 0) {
    throw new Error(`Invalid runner inbox credential: ${failures.join(", ")}`);
  }
  return true;
}

export function runnerInboxCredentialTargetForConfig(config, repoRoot = process.cwd(), domainIdentity = {}) {
  const inbox = config?.inbox || {};
  const identityFields = requireRunnerCredentialIdentity(domainIdentity, "Runner inbox credential target");
  const identity = [
    "agentic-factory-inbox-runner",
    inbox.base_url || "",
    inbox.webhook_url || "",
    path.resolve(repoRoot),
    `workspace_id:${identityFields.workspaceId}`,
    `domain_id:${identityFields.domainId}`,
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryInboxRunner:${digest}`;
}

export function legacyRunnerInboxCredentialTargetForConfig(config, repoRoot = process.cwd()) {
  const inbox = config?.inbox || {};
  const identity = [
    "agentic-factory-inbox-runner",
    inbox.base_url || "",
    inbox.webhook_url || "",
    path.resolve(repoRoot),
  ].join("\n");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `AgenticFactoryInboxRunner:${digest}`;
}

export function isLegacyRunnerInboxCredentialTargetForConfig(target, config, repoRoot = process.cwd()) {
  return target === legacyRunnerInboxCredentialTargetForConfig(config, repoRoot);
}

function runnerCredentialFilePath({ inbox, domainId }) {
  if (domainId) {
    return path.join(".agentic-factory", "domains", domainId, "inbox-runner-credential.json");
  }
  return inbox.credential_file || DEFAULT_RUNNER_CREDENTIAL_FILE;
}

function runnerCredentialIdentity(input = {}) {
  const source = input?.domainContext || input?.context || input || {};
  return {
    domainId:
      input.domainId ||
      source.domainId ||
      source.domain_id ||
      source.trace?.domain_id ||
      null,
    workspaceId:
      input.workspaceId ||
      source.workspaceId ||
      source.workspace_id ||
      source.linear?.workspaceId ||
      source.trace?.workspace_id ||
      null,
  };
}

function requireRunnerCredentialIdentity(input = {}, label) {
  const identity = runnerCredentialIdentity(input);
  const missing = [];
  if (!identity.workspaceId) missing.push("workspace_id");
  if (!identity.domainId) missing.push("domain_id");
  if (missing.length > 0) {
    throw new Error(`${label} requires ${missing.join(" and ")}.`);
  }
  return identity;
}
