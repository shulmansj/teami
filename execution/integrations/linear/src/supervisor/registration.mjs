import fs from "node:fs";
import path from "node:path";

import {
  envFlag,
  localSupervisorDir,
  localSupervisorDisablePath,
  localSupervisorRegistrationPath,
  localSupervisorStatePath,
  readJsonIfExists,
  removePathIfExists,
  writeJsonAtomic,
} from "./state-store.mjs";

export const LOCAL_SUPERVISOR_REGISTRATION_SCHEMA_VERSION =
  "agentic-factory-local-supervisor-registration/v1";
export const LOCAL_SUPERVISOR_DISABLE_SCHEMA_VERSION =
  "agentic-factory-local-supervisor-disable/v1";

export const LOCAL_SUPERVISOR_CONSENT_FLAG = "consent-local-supervisor";

const AUTHORIZED_AFTER_GRANT = Object.freeze([
  "runner_work",
  "scanner_work",
  "evidence_resolution",
  "hitl_proposal_drafting",
  "github_pr_opening",
]);

// Descriptive registration manifest only. Enforcement lives in the GitHub
// endpoint allowlist, scanner production boundary, and promotion ref guards.
const FORBIDDEN_CAPABILITIES = Object.freeze([
  "auto_merge",
  "apply_behavior_change",
  "mark_ready_for_review",
  "submit_pr_review",
  "status_override",
  "branch_protection_bypass",
  "privileged_workflow_triggers",
  "write_token_ci",
  "proposal_branch_secrets",
  "artifact_log_exfiltration",
  "maintainer_originated_adopter_pr",
  "auto_acceptance",
  "unattended_linear_writes_while_machine_off",
  "policy_bypass",
  "real_os_autostart_registration_tonight",
]);

export function planLocalSupervisorAutostartRegistration({
  repoRoot = process.cwd(),
  platform = process.platform,
} = {}) {
  const command = "npm run supervisor:run";
  let mechanism = "user_login_keep_alive";
  if (platform === "win32") mechanism = "windows_task_scheduler_logon_task";
  else if (platform === "darwin") mechanism = "launchd_user_agent";
  else if (platform === "linux") mechanism = "systemd_user_service_or_xdg_autostart";
  return {
    mechanism,
    command,
    cwd: path.resolve(repoRoot),
    will_write_os: false,
    status: "stubbed_no_os_write",
    todo:
      "Real OS keep-alive/login registration is not implemented; no OS autostart writes are performed.",
  };
}

export function registerLocalSupervisorStub({
  repoRoot = process.cwd(),
  explicitConsent = false,
  trigger = "manual",
  now = () => new Date(),
  platform = process.platform,
} = {}) {
  if (explicitConsent !== true) {
    return {
      ok: false,
      reason: "explicit_supervisor_consent_required",
      detail:
        `rerun with --${LOCAL_SUPERVISOR_CONSENT_FLAG}; local supervisor registration is never silent`,
    };
  }
  const registrationPath = localSupervisorRegistrationPath(repoRoot);
  const existing = readJsonIfExists(registrationPath);
  const observedAt = now().toISOString();
  const registration = {
    schema_version: LOCAL_SUPERVISOR_REGISTRATION_SCHEMA_VERSION,
    status: "dry_run_registered",
    dry_run: true,
    consent: {
      granted: true,
      granted_at: existing?.consent?.granted_at || observedAt,
      latest_confirmed_at: observedAt,
      trigger,
    },
    authorized_capabilities: AUTHORIZED_AFTER_GRANT,
    forbidden_capabilities: FORBIDDEN_CAPABILITIES,
    os_registration: planLocalSupervisorAutostartRegistration({ repoRoot, platform }),
    local_credential_custody: {
      owns_new_credentials: false,
      runner_authority_source: "existing_local_trigger_store_and_linear_oauth",
      github_authority_source: "existing_github_connection_state_and_local_ambient_auth",
      note:
        "The supervisor stores no tokens in this registration file; uninstall removes this stub and the existing local credential paths remove local authority.",
    },
    updated_at: observedAt,
    created_at: existing?.created_at || observedAt,
  };
  writeJsonAtomic(registrationPath, registration);
  return {
    ok: true,
    dry_run: true,
    registration,
    registration_path: registrationPath,
  };
}

export function unregisterLocalSupervisorStub({ repoRoot = process.cwd() } = {}) {
  return cleanupLocalSupervisorLocalState({ repoRoot });
}

export function setLocalSupervisorDisabled({
  repoRoot = process.cwd(),
  disabled = true,
  reason = "operator_disabled",
  runnerDisabled = null,
  scannerDisabled = null,
  now = () => new Date(),
} = {}) {
  const disablePath = localSupervisorDisablePath(repoRoot);
  if (!disabled) {
    const removed = removePathIfExists(disablePath);
    return {
      ok: true,
      disabled: false,
      removed,
      disable_path: disablePath,
    };
  }
  const record = {
    schema_version: LOCAL_SUPERVISOR_DISABLE_SCHEMA_VERSION,
    disabled: true,
    reason,
    runner_disabled: runnerDisabled === null ? true : Boolean(runnerDisabled),
    scanner_disabled: scannerDisabled === null ? true : Boolean(scannerDisabled),
    disabled_at: now().toISOString(),
  };
  writeJsonAtomic(disablePath, record);
  return {
    ok: true,
    disabled: true,
    disable_path: disablePath,
    record,
  };
}

export function cleanupLocalSupervisorLocalState({ repoRoot = process.cwd() } = {}) {
  const paths = [
    [localSupervisorRegistrationPath(repoRoot), "local supervisor registration stub"],
    [localSupervisorStatePath(repoRoot), "local supervisor state"],
    [localSupervisorDisablePath(repoRoot), "local supervisor disable flag"],
  ];
  const removed = [];
  const alreadyClean = [];
  for (const [filePath, label] of paths) {
    if (removePathIfExists(filePath)) removed.push({ path: filePath, label });
    else alreadyClean.push({ path: filePath, label });
  }
  try {
    fs.rmdirSync(localSupervisorDir(repoRoot));
  } catch {
    // Leaving a non-empty or missing local directory is harmless.
  }
  return {
    ok: true,
    removed,
    already_clean: alreadyClean,
    todo:
      "Real OS login/autostart deregistration is not implemented because no OS registration is written.",
  };
}

function readLocalSupervisorRegistration({ repoRoot = process.cwd() } = {}) {
  const registrationPath = localSupervisorRegistrationPath(repoRoot);
  const registration = readJsonIfExists(registrationPath);
  if (!registration) {
    return { ok: false, reason: "missing_local_supervisor_registration", registration_path: registrationPath };
  }
  if (registration.schema_version !== LOCAL_SUPERVISOR_REGISTRATION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "invalid_local_supervisor_registration",
      registration_path: registrationPath,
    };
  }
  return { ok: true, registration, registration_path: registrationPath };
}

function readLocalSupervisorDisable({ repoRoot = process.cwd(), env = process.env } = {}) {
  const fileRecord = readJsonIfExists(localSupervisorDisablePath(repoRoot));
  const envAll = envFlag(env.AGENTIC_FACTORY_SUPERVISOR_DISABLED);
  const envRunner = envFlag(env.AGENTIC_FACTORY_SUPERVISOR_DISABLE_RUNNER);
  const envScanner = envFlag(env.AGENTIC_FACTORY_SUPERVISOR_DISABLE_SCANNER);
  const disabled = envAll || fileRecord?.disabled === true;
  const runnerDisabled = disabled || envRunner || fileRecord?.runner_disabled === true;
  const scannerDisabled = disabled || envScanner || fileRecord?.scanner_disabled === true;
  return {
    disabled,
    runner_disabled: runnerDisabled,
    scanner_disabled: scannerDisabled,
    reason: envAll
      ? "env:AGENTIC_FACTORY_SUPERVISOR_DISABLED"
      : fileRecord?.reason || (runnerDisabled || scannerDisabled ? "capability_disabled" : null),
    file: fileRecord || null,
  };
}

export {
  readLocalSupervisorDisable,
  readLocalSupervisorRegistration,
};
