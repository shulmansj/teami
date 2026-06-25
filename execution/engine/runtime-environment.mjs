export const REPAIR_RETRY_TIMEOUT_MS = 2 * 60 * 1000;

const AGENT_WRITE_CREDENTIAL_ENV_NAMES = new Set([
  "AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN",
  "AGENTIC_FACTORY_GITHUB_BROKER_TOKEN",
  "AGENTIC_FACTORY_GITHUB_BROKER_CREDENTIAL",
  "AGENTIC_FACTORY_INBOX_SETUP_GRANT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_ACCESS_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_AUTH_SOCK",
]);

const RUNTIME_AUTH_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
];

const CREDENTIAL_MARKERS = [
  "TOKEN",
  "CREDENTIAL",
  "CREDENTIALS",
  "SECRET",
  "PASSWORD",
  "PRIVATE",
  "KEY",
];

const CREDENTIAL_PHRASES = [
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
];

export function scrubChildEnv(env = process.env) {
  const childEnv = { ...(env || {}) };
  // Blacklist only write credentials: runtime CLIs rely on broad OS env and auth prefixes.
  for (const name of Object.keys(childEnv)) {
    if (isAgentWriteCredentialEnvName(name)) delete childEnv[name];
  }
  return childEnv;
}

export function runtimeCommandEnvironmentProof(env = process.env) {
  return {
    agent_write_credentials_present: Object.keys(env || {}).some(isAgentWriteCredentialEnvName),
  };
}

function isAgentWriteCredentialEnvName(name) {
  const normalized = String(name || "").toUpperCase();
  if (isRuntimeAuthEnvName(normalized)) return false;
  if (AGENT_WRITE_CREDENTIAL_ENV_NAMES.has(normalized)) return true;
  if (normalized.startsWith("AF_LINEAR_")) return true;
  if (normalized.startsWith("LINEAR_")) return hasCredentialMarker(normalized.slice("LINEAR_".length));
  if (normalized.startsWith("GITHUB_") || normalized.startsWith("GH_")) {
    return hasCredentialMarker(normalized);
  }
  return hasCredentialMarker(normalized);
}

function isRuntimeAuthEnvName(normalized) {
  return RUNTIME_AUTH_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function hasCredentialMarker(normalized) {
  const parts = normalized.split("_").filter(Boolean);
  return CREDENTIAL_MARKERS.some((marker) => parts.includes(marker))
    || CREDENTIAL_PHRASES.some((phrase) => normalized.includes(phrase));
}
