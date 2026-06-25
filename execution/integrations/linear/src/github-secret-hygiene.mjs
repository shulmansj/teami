const REDACTED = "[redacted]";

export const GITHUB_AUTH_ENV_NAMES = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "AGENTIC_FACTORY_GITHUB_INSTALLATION_TOKEN",
  "GITHUB_ACCESS_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
]);

const GITHUB_AUTH_ENV_NAME_SET = new Set(GITHUB_AUTH_ENV_NAMES);
const GITHUB_AUTH_ENV_ASSIGNMENT = new RegExp(
  `\\b(${GITHUB_AUTH_ENV_NAMES.map(escapeRegExp).join("|")})(\\s*[=:]\\s*)(["']?)([^\\s'",;)}]+)`,
  "gi",
);

const GITHUB_TOKEN_VALUE_PATTERNS = Object.freeze([
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gi,
]);

export function scrubGitHubAuthEnv(env = process.env, { pushAuth } = {}) {
  const scrubbed = { ...(env || {}) };
  for (const name of Object.keys(scrubbed)) {
    if (shouldScrubGitHubAuthEnvName(name, { pushAuth })) delete scrubbed[name];
  }
  return scrubbed;
}

export function redactGitHubSecrets(text) {
  let redacted = String(text ?? "");
  for (const pattern of GITHUB_TOKEN_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, `$1${REDACTED}`);
  redacted = redacted.replace(
    GITHUB_AUTH_ENV_ASSIGNMENT,
    (_match, name, separator, quote) => `${name}${separator}${quote}${REDACTED}`,
  );
  return redacted;
}

function shouldScrubGitHubAuthEnvName(name, { pushAuth } = {}) {
  const normalized = String(name || "").toUpperCase();
  if (GITHUB_AUTH_ENV_NAME_SET.has(normalized)) return true;
  return normalized === "SSH_AUTH_SOCK" && pushAuth === "https";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
