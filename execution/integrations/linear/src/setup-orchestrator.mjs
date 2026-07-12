import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../../../engine/atomic-file.mjs";
import { acquireExclusiveFileLock } from "../../../engine/exclusive-file-lock.mjs";

export const SETUP_DISCLOSURE_VERSION = "teami-setup-effects/v3";
export const SETUP_STATE_SCHEMA_VERSION = "teami-setup-state/v1";
export const DEFAULT_SETUP_STATE_TTL_MS = 60 * 60 * 1000;

export const SETUP_PHASES = Object.freeze([
  Object.freeze({ id: "consent", failure: "blocked" }),
  Object.freeze({ id: "linear", failure: "blocked" }),
  Object.freeze({ id: "product_repos", failure: "blocked" }),
  Object.freeze({ id: "github", failure: "blocked" }),
  Object.freeze({ id: "plugin", failure: "blocked" }),
  Object.freeze({ id: "phoenix", failure: "degraded" }),
  Object.freeze({ id: "runtime", failure: "blocked" }),
  Object.freeze({ id: "doctor", failure: "blocked" }),
]);

export const SETUP_EFFECTS_DISCLOSURE = deepFreeze({
  version: SETUP_DISCLOSURE_VERSION,
  title: "What Teami setup will do",
  summary: "Teami runs locally and uses only authority already approved on this computer.",
  effects: [
    {
      id: "linear_workspace",
      title: "Connect and configure Linear",
      detail: "Open Linear in your browser, request workspace-wide read/write access, and create or reconcile the dedicated Teami team, required issue labels, project statuses, project template, and workflow shape. Linear offers no narrower workspace scope.",
      authority: "Browser approval is the authorization gate.",
      retention: "The resulting Linear workspace objects remain in Linear; the normal read/write grant is stored locally for Teami operation.",
    },
    {
      id: "linear_admin_exception",
      title: "Possibly request one-time Linear admin approval",
      detail: "Only if Principal Escalation is missing, Teami may ask again immediately before creating that one project status.",
      authority: "A separate browser approval and just-in-time confirmation are required.",
      retention: "The admin grant is never persisted. Teami discards it from memory after the one status operation and asks Linear to revoke that exact token. If provider revocation cannot be verified before the token is lost, setup stays blocked; the adopter must revoke Teami access in Linear Settings and reset the blocked local setup because a fresh token cannot prove the lost token is gone.",
    },
    {
      id: "product_repo_allowlist",
      title: "Record product repositories",
      detail: "Record the explicitly selected owner/repo allowlist, or record that this is a non-code team.",
      authority: "The allowlist is the boundary for future local repository work.",
      retention: "Repository coordinates, never GitHub credentials, are stored locally.",
    },
    {
      id: "behavior_repo",
      title: "Connect the Teami behavior repository",
      detail: "Create or connect the dedicated behavior repository through this computer's existing git and GitHub CLI authority.",
      authority: "Teami receives no GitHub App installation or hosted token.",
      retention: "Only local connection evidence and repository identity are stored.",
    },
    {
      id: "claude_plugin",
      title: "Register the Claude plugin",
      detail: "Add the Teami marketplace and install the Teami Claude Code plugin for the current user.",
      authority: "Claude Code performs the local registration.",
      retention: "Claude Code keeps its normal local plugin registration.",
    },
    {
      id: "local_state",
      title: "Create local Teami and Phoenix state",
      detail: "Create local setup, gateway, runtime-check, and Phoenix trace state under the Teami home on this computer.",
      authority: "No hosted Teami service receives this state.",
      retention: "State remains local until the adopter removes it.",
    },
  ],
});

export const SETUP_DISCLOSURE_HASH = sha256(JSON.stringify(SETUP_EFFECTS_DISCLOSURE));

const SETUP_STATUSES = new Set([
  "consent_required",
  "awaiting_authorization",
  "admin_consent_required",
  "running",
  "blocked",
  "degraded",
  "complete",
]);
const PHASE_STATUSES = new Set([
  "pending",
  "healthy",
  "degraded",
  "blocked",
  "awaiting_authorization",
  "consent_required",
]);
const FORBIDDEN_STATE_KEY = /(?:^|_)(?:access|refresh|admin)?_?token$|oauth_code|authorization_code|pkce|code_verifier|client_secret/i;

export function setupEffectsDisclosure() {
  return {
    ...structuredClone(SETUP_EFFECTS_DISCLOSURE),
    hash: SETUP_DISCLOSURE_HASH,
  };
}

export function verifySetupConsent({ confirm, disclosureVersion, disclosureHash } = {}) {
  if (confirm !== true) {
    return {
      ok: false,
      status: "consent_required",
      reason: "explicit_setup_consent_required",
      disclosure: setupEffectsDisclosure(),
    };
  }
  if (disclosureVersion !== SETUP_DISCLOSURE_VERSION || disclosureHash !== SETUP_DISCLOSURE_HASH) {
    return {
      ok: false,
      status: "consent_required",
      reason: "setup_disclosure_changed",
      disclosure: setupEffectsDisclosure(),
    };
  }
  return {
    ok: true,
    status: "confirmed",
    version: disclosureVersion,
    hash: disclosureHash,
  };
}

export function normalizeSetupRepoIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("setup_repo_intent_required");
  }
  if (value.mode === "non_code") return Object.freeze({ mode: "non_code", repos: [] });
  if (value.mode !== "allowlist") throw new Error("setup_repo_intent_mode_invalid");
  if (!Array.isArray(value.repos) || value.repos.length === 0) {
    throw new Error("setup_repo_allowlist_requires_repo");
  }
  const repos = [...new Set(value.repos.map(normalizeRepoCoordinate))];
  return Object.freeze({ mode: "allowlist", repos });
}

export function aggregateLiveSetupHealth(steps = []) {
  const byPhase = new Map();
  for (const raw of steps) {
    const step = normalizeLiveStep(raw);
    if (byPhase.has(step.phase)) throw new Error(`duplicate_setup_health_phase:${step.phase}`);
    byPhase.set(step.phase, step);
  }

  const ordered = SETUP_PHASES.map((definition) => byPhase.get(definition.id) || {
    phase: definition.id,
    status: "pending",
    source: "live",
    observed_at: new Date(0).toISOString(),
    reason: "live_check_missing",
  });
  const awaiting = ordered.find((step) => step.status === "awaiting_authorization");
  if (awaiting) return healthResult("awaiting_authorization", ordered, awaiting.reason);
  const consent = ordered.find((step) => step.status === "consent_required");
  if (consent) return healthResult("consent_required", ordered, consent.reason);
  const blocked = ordered.find((step) => {
    const definition = SETUP_PHASES.find((candidate) => candidate.id === step.phase);
    return step.status === "blocked" || step.status === "pending" ||
      (step.status === "degraded" && definition?.failure === "blocked");
  });
  if (blocked) return healthResult("blocked", ordered, blocked.reason || `${blocked.phase}_unhealthy`);
  const degraded = ordered.find((step) => step.status === "degraded");
  if (degraded) return healthResult("degraded", ordered, degraded.reason || `${degraded.phase}_degraded`);
  return healthResult("complete", ordered, null);
}

export function buildLiveSetupSteps(observations = {}, {
  observedAt = new Date().toISOString(),
} = {}) {
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) {
    throw new Error("setup_live_observations_invalid");
  }
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("setup_live_observed_at_invalid");
  return SETUP_PHASES.map(({ id }) => {
    const observation = observations[id];
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      return {
        phase: id,
        status: "pending",
        source: "live",
        observed_at: observedAt,
        reason: "live_check_missing",
      };
    }
    return {
      phase: id,
      status: normalizePhaseStatus(observation.status),
      source: "live",
      observed_at: observedAt,
      reason: observation.reason || null,
    };
  });
}

export function createSetupStateStore({
  home,
  now = () => Date.now(),
  ttlMs = DEFAULT_SETUP_STATE_TTL_MS,
  fsApi = fs,
  onWriteBoundary = () => {},
} = {}) {
  if (typeof home !== "string" || home.trim() === "") throw new Error("setup_state_home_required");
  const root = path.join(home, "setup");
  const sessionsDir = path.join(root, "sessions");
  const lockPath = path.join(root, "setup.lock");
  const adminMarkerPath = path.join(root, "admin-revocation-required.json");

  function start({ input, consent, setupId = crypto.randomUUID() } = {}) {
    assertSetupId(setupId);
    const verified = verifySetupConsent({
      confirm: consent?.confirmed === true,
      disclosureVersion: consent?.version,
      disclosureHash: consent?.hash,
    });
    if (!verified.ok) throw new Error(verified.reason);
    const timestamp = new Date(now()).toISOString();
    const state = {
      schema_version: SETUP_STATE_SCHEMA_VERSION,
      setup_id: setupId,
      status: "running",
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: new Date(now() + ttlMs).toISOString(),
      consent: {
        version: verified.version,
        hash: verified.hash,
        confirmed_at: timestamp,
      },
      input: normalizePersistedInput(input),
      phases: {
        consent: phaseReceipt({ status: "healthy", observedAt: timestamp, reason: "explicitly_confirmed" }),
      },
      admin_revocation_required: null,
    };
    write(state);
    return structuredClone(state);
  }

  function read(setupId) {
    assertSetupId(setupId);
    const filePath = sessionPath(sessionsDir, setupId);
    if (!fsApi.existsSync(filePath)) return null;
    const state = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    validateSetupState(state);
    return state;
  }

  function update(setupId, updater) {
    const current = read(setupId);
    if (!current) throw new Error("setup_state_not_found");
    const next = updater(structuredClone(current));
    if (!next || typeof next !== "object") throw new Error("setup_state_updater_invalid");
    next.updated_at = new Date(now()).toISOString();
    next.expires_at = new Date(now() + ttlMs).toISOString();
    write(next);
    return structuredClone(next);
  }

  function recordPhase(setupId, phase, outcome = {}) {
    if (!SETUP_PHASES.some((definition) => definition.id === phase)) {
      throw new Error(`unknown_setup_phase:${phase}`);
    }
    return update(setupId, (state) => {
      state.phases[phase] = phaseReceipt({
        status: outcome.status,
        observedAt: new Date(now()).toISOString(),
        reason: outcome.reason || null,
      });
      if (outcome.setupStatus) state.status = outcome.setupStatus;
      return state;
    });
  }

  function markAdminRevocationRequired(setupId) {
    return update(setupId, (state) => {
      state.admin_revocation_required = {
        status: "required",
        marked_at: new Date(now()).toISOString(),
        reason: "one_shot_admin_oauth_started",
      };
      state.status = "running";
      return state;
    });
  }

  function clearAdminRevocationRequired(setupId, { revokeVerified } = {}) {
    if (revokeVerified !== true) throw new Error("admin_revoke_verification_required");
    return update(setupId, (state) => {
      state.admin_revocation_required = null;
      return state;
    });
  }

  function readGlobalAdminRevocationRequired() {
    if (!fsApi.existsSync(adminMarkerPath)) return null;
    const marker = JSON.parse(fsApi.readFileSync(adminMarkerPath, "utf8"));
    validateGlobalAdminMarker(marker);
    return marker;
  }

  function markGlobalAdminRevocationRequired({ surface = "unknown" } = {}) {
    const marker = {
      schema_version: SETUP_STATE_SCHEMA_VERSION,
      status: "required",
      surface: nonEmptyString(surface, "setup_admin_marker_surface_required"),
      marked_at: new Date(now()).toISOString(),
      reason: "one_shot_admin_oauth_started",
    };
    writeAtomicJson({
      filePath: adminMarkerPath,
      value: marker,
      validate: validateGlobalAdminMarker,
      fsApi,
      onBoundary: onWriteBoundary,
    });
    return structuredClone(marker);
  }

  function clearGlobalAdminRevocationRequired({ revokeVerified } = {}) {
    if (revokeVerified !== true) throw new Error("admin_revoke_verification_required");
    fsApi.rmSync(adminMarkerPath, { force: true });
    return true;
  }

  function readAdminRevocationRequirement() {
    const global = readGlobalAdminRevocationRequired();
    const setupIds = [];
    if (fsApi.existsSync(sessionsDir)) {
      for (const entry of fsApi.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const state = JSON.parse(fsApi.readFileSync(path.join(sessionsDir, entry.name), "utf8"));
        validateSetupState(state);
        if (state.admin_revocation_required) setupIds.push(state.setup_id);
      }
    }
    if (!global && setupIds.length === 0) return null;
    return Object.freeze({
      global: global ? structuredClone(global) : null,
      setup_ids: Object.freeze(setupIds.sort()),
    });
  }

  function acquire({ purpose = "setup" } = {}) {
    return acquireExclusiveFileLock({ lockPath, purpose, now, fsApi });
  }

  function cleanupExpired() {
    if (!fsApi.existsSync(sessionsDir)) return { removed: 0 };
    let removed = 0;
    for (const entry of fsApi.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(sessionsDir, entry.name);
      try {
        const state = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
        // Revocation uncertainty is a durable safety boundary, not disposable setup progress.
        // Never let ordinary session expiry erase it; only positive revoke proof may clear it.
        if (state.admin_revocation_required) continue;
        if (Date.parse(state.expires_at || "") > now()) continue;
      } catch {
        // Invalid setup state is not silently removed; doctor must be able to report it.
        continue;
      }
      fsApi.rmSync(filePath, { force: true });
      removed += 1;
    }
    return { removed };
  }

  function findActive({ excludeSetupId = null } = {}) {
    if (!fsApi.existsSync(sessionsDir)) return null;
    const activeStatuses = new Set(["awaiting_authorization", "admin_consent_required", "running"]);
    const candidates = [];
    for (const entry of fsApi.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const state = JSON.parse(fsApi.readFileSync(path.join(sessionsDir, entry.name), "utf8"));
        validateSetupState(state);
        if (state.setup_id === excludeSetupId || !activeStatuses.has(state.status)) continue;
        if (!state.admin_revocation_required && Date.parse(state.expires_at) <= now()) continue;
        candidates.push(state);
      } catch {
        // Corrupt state is a doctor concern; it cannot safely be guessed into an active session.
      }
    }
    candidates.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    return candidates.length > 0 ? structuredClone(candidates[0]) : null;
  }

  function write(state) {
    validateSetupState(state);
    writeAtomicJson({
      filePath: sessionPath(sessionsDir, state.setup_id),
      value: state,
      validate: validateSetupState,
      fsApi,
      onBoundary: onWriteBoundary,
    });
  }

  return Object.freeze({
    root,
    lockPath,
    adminMarkerPath,
    start,
    read,
    update,
    recordPhase,
    markAdminRevocationRequired,
    clearAdminRevocationRequired,
    readGlobalAdminRevocationRequired,
    markGlobalAdminRevocationRequired,
    clearGlobalAdminRevocationRequired,
    readAdminRevocationRequirement,
    acquire,
    cleanupExpired,
    findActive,
  });
}

function validateGlobalAdminMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("admin_revocation_marker_invalid");
  if (marker.schema_version !== SETUP_STATE_SCHEMA_VERSION || marker.status !== "required") {
    throw new Error("admin_revocation_marker_invalid");
  }
  nonEmptyString(marker.surface, "admin_revocation_marker_invalid");
  if (!Number.isFinite(Date.parse(marker.marked_at || "")) || marker.reason !== "one_shot_admin_oauth_started") {
    throw new Error("admin_revocation_marker_invalid");
  }
  rejectSecretState(marker);
  return true;
}

export async function runSharedSetupStateMachine({
  setupId,
  store = null,
  phaseRunners = {},
  startAt = "linear",
  onPhase = () => {},
  liveHealth,
  continueAfterBlocked = false,
} = {}) {
  if (store && typeof store.recordPhase !== "function") throw new Error("setup_state_store_invalid");
  if (store && !setupId) throw new Error("setup_id_required_with_state_store");
  if (typeof liveHealth !== "function") throw new Error("setup_live_health_required");
  const startIndex = SETUP_PHASES.findIndex((phase) => phase.id === startAt);
  if (startIndex < 0) throw new Error(`unknown_setup_phase:${startAt}`);
  const context = {};
  for (const definition of SETUP_PHASES.slice(startIndex)) {
    const runner = phaseRunners[definition.id];
    if (typeof runner !== "function") continue;
    onPhase({ phase: definition.id, event: "started" });
    const outcome = await runner({ setupId, context });
    const status = normalizePhaseStatus(outcome?.status);
    store?.recordPhase(setupId, definition.id, {
      status,
      reason: outcome?.reason || null,
      setupStatus: setupStatusForPhaseOutcome(status, definition),
    });
    if (outcome?.context && typeof outcome.context === "object") Object.assign(context, outcome.context);
    onPhase({ phase: definition.id, event: "finished", status });
    if (!continueAfterBlocked && ["blocked", "awaiting_authorization", "consent_required"].includes(status)) break;
  }
  return aggregateLiveSetupHealth(await liveHealth({ setupId, context }));
}

export async function runSetupCompletionContract({
  setupId,
  store = null,
  startAt = "consent",
  continueAfterBlocked = true,
  phaseAdapters = {},
  onPhase = () => {},
} = {}) {
  if (!phaseAdapters || typeof phaseAdapters !== "object" || Array.isArray(phaseAdapters)) {
    throw new Error("setup_phase_adapters_invalid");
  }
  const observations = {};
  const phaseRunners = Object.fromEntries(SETUP_PHASES.map(({ id }) => [id, async (args) => {
    const adapter = phaseAdapters[id];
    if (typeof adapter !== "function") {
      return { status: "pending", reason: "setup_phase_adapter_missing" };
    }
    const outcome = await adapter(args);
    observations[id] = {
      status: normalizePhaseStatus(outcome?.status),
      reason: outcome?.reason || null,
    };
    return outcome;
  }]));
  return runSharedSetupStateMachine({
    setupId,
    store,
    startAt,
    continueAfterBlocked,
    phaseRunners,
    onPhase,
    liveHealth: async () => buildLiveSetupSteps(observations),
  });
}

function normalizePersistedInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("setup_input_required");
  const domain = nonEmptyString(input.domain, "setup_domain_required");
  const repoIntent = normalizeSetupRepoIntent(input.repo_intent);
  return {
    domain,
    workspace: optionalString(input.workspace),
    repo_intent: repoIntent,
    github_owner: optionalString(input.github_owner),
    github_repo: optionalString(input.github_repo),
    github_dry_run: input.github_dry_run === true,
  };
}

function validateSetupState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("setup_state_invalid");
  if (state.schema_version !== SETUP_STATE_SCHEMA_VERSION) throw new Error("setup_state_schema_invalid");
  assertSetupId(state.setup_id);
  if (!SETUP_STATUSES.has(state.status)) throw new Error("setup_state_status_invalid");
  if (!Number.isFinite(Date.parse(state.created_at)) || !Number.isFinite(Date.parse(state.updated_at)) ||
      !Number.isFinite(Date.parse(state.expires_at))) {
    throw new Error("setup_state_timestamp_invalid");
  }
  const consent = verifySetupConsent({
    confirm: true,
    disclosureVersion: state.consent?.version,
    disclosureHash: state.consent?.hash,
  });
  if (!consent.ok || !Number.isFinite(Date.parse(state.consent?.confirmed_at))) {
    throw new Error("setup_state_consent_invalid");
  }
  normalizePersistedInput(state.input);
  if (!state.phases || typeof state.phases !== "object" || Array.isArray(state.phases)) {
    throw new Error("setup_state_phases_invalid");
  }
  for (const [phase, receipt] of Object.entries(state.phases)) {
    if (!SETUP_PHASES.some((definition) => definition.id === phase)) throw new Error(`unknown_setup_phase:${phase}`);
    validatePhaseReceipt(receipt);
  }
  if (state.admin_revocation_required !== null) {
    if (state.admin_revocation_required?.status !== "required" ||
        !Number.isFinite(Date.parse(state.admin_revocation_required?.marked_at))) {
      throw new Error("admin_revocation_marker_invalid");
    }
  }
  if (state.admin_revocation_confirmation !== undefined && state.admin_revocation_confirmation !== null) {
    if (state.admin_revocation_confirmation?.status !== "verified_cleanup" ||
        !Number.isFinite(Date.parse(state.admin_revocation_confirmation?.confirmed_at)) ||
        state.admin_revocation_confirmation?.evidence !== "fresh_cleanup_grant_provider_revocation_verified") {
      throw new Error("admin_revocation_confirmation_invalid");
    }
  }
  rejectSecretState(state);
  return true;
}

function normalizeLiveStep(step) {
  if (!step || typeof step !== "object") throw new Error("setup_health_step_invalid");
  if (!SETUP_PHASES.some((definition) => definition.id === step.phase)) {
    throw new Error(`unknown_setup_phase:${step.phase}`);
  }
  if (step.source !== "live") throw new Error(`setup_health_requires_live_source:${step.phase}`);
  if (!Number.isFinite(Date.parse(step.observed_at || ""))) {
    throw new Error(`setup_health_observed_at_required:${step.phase}`);
  }
  return {
    phase: step.phase,
    status: normalizePhaseStatus(step.status),
    source: "live",
    observed_at: step.observed_at,
    reason: step.reason || null,
    repair: step.repair || null,
  };
}

function phaseReceipt({ status, observedAt, reason }) {
  const receipt = {
    status: normalizePhaseStatus(status),
    recorded_at: observedAt,
  };
  if (reason) receipt.reason = String(reason);
  return receipt;
}

function validatePhaseReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") throw new Error("setup_phase_receipt_invalid");
  normalizePhaseStatus(receipt.status);
  if (!Number.isFinite(Date.parse(receipt.recorded_at || ""))) throw new Error("setup_phase_receipt_time_invalid");
}

function normalizePhaseStatus(status) {
  if (!PHASE_STATUSES.has(status)) throw new Error(`setup_phase_status_invalid:${status || "missing"}`);
  return status;
}

function setupStatusForPhaseOutcome(status, definition) {
  if (status === "awaiting_authorization") return "awaiting_authorization";
  if (status === "consent_required") return "admin_consent_required";
  if (status === "blocked" || (status === "degraded" && definition.failure === "blocked")) return "blocked";
  if (status === "degraded") return "degraded";
  return "running";
}

function healthResult(status, steps, reason) {
  return {
    ok: status === "complete",
    status,
    reason,
    steps,
  };
}

function rejectSecretState(value, pathParts = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STATE_KEY.test(key)) throw new Error(`setup_state_secret_key_forbidden:${[...pathParts, key].join(".")}`);
    rejectSecretState(child, [...pathParts, key]);
  }
}

function sessionPath(sessionsDir, setupId) {
  return path.join(sessionsDir, `${setupId}.json`);
}

function assertSetupId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("setup_id_invalid");
}

function normalizeRepoCoordinate(value) {
  if (typeof value !== "string") throw new Error("setup_repo_coordinate_invalid");
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) throw new Error(`setup_repo_coordinate_invalid:${trimmed || "blank"}`);
  return trimmed;
}

function nonEmptyString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}
