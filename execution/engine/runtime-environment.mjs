export const REPAIR_RETRY_TIMEOUT_MS = 2 * 60 * 1000;

// codex's workspace-write sandbox setup enumerates the temp roots named by
// TMPDIR/TMP/TEMP to grant write access, so a bloated host temp directory
// wedges every sandboxed worker command past the runtime timeout (observed
// live on 2026-07-05: a 329k-entry %TEMP% outlived the 10-minute bound on
// every worker attempt). Factory runs are hermetic against host temp state
// by construction: a run's children get all three variables pointed at an
// engine-owned per-run directory that is created with the run workspace and
// removed with it. All three names are set on every platform so the redirect
// holds regardless of which name the runtime or its child tooling reads.
export const PER_RUN_TEMP_ENV_NAMES = Object.freeze(["TMPDIR", "TMP", "TEMP"]);

export function perRunTempEnv(tmpDir) {
  if (typeof tmpDir !== "string" || tmpDir.trim() === "") {
    throw new Error("per_run_temp_dir_required");
  }
  return Object.fromEntries(PER_RUN_TEMP_ENV_NAMES.map((name) => [name, tmpDir]));
}

export function perRunTempEnvSubset(envAugment = {}) {
  const subset = {};
  for (const name of PER_RUN_TEMP_ENV_NAMES) {
    const value = envAugment?.[name];
    if (typeof value === "string" && value !== "") subset[name] = value;
  }
  return subset;
}

// Overlay an env augment onto a child env. On win32 the OS resolves variable
// names case-insensitively but a JS spread does not: a host env carrying a
// case-variant key (Temp vs TEMP) would survive next to the augmented key and
// the child could still read the host value. Deleting case-variant duplicates
// of every augmented name on win32 makes an engine override actually override;
// POSIX env names are case-sensitive and left alone.
export function applyEnvAugment(baseEnv = {}, envAugment = {}, { platform = process.platform } = {}) {
  const childEnv = { ...(baseEnv || {}) };
  for (const [name, value] of Object.entries(envAugment || {})) {
    if (platform === "win32") {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(childEnv)) {
        if (existing !== name && existing.toUpperCase() === upper) delete childEnv[existing];
      }
    }
    childEnv[name] = value;
  }
  return childEnv;
}

const AGENT_WRITE_CREDENTIAL_ENV_NAMES = new Set([
  "TEAMI_GITHUB_INSTALLATION_TOKEN",
  "TEAMI_GITHUB_BROKER_TOKEN",
  "TEAMI_GITHUB_BROKER_CREDENTIAL",
  "TEAMI_INBOX_SETUP_GRANT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_ACCESS_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
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
