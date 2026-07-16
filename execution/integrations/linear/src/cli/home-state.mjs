import fs from "node:fs";
import path from "node:path";

import { DEFAULT_CONFIG_PATH, loadLinearConfig } from "../config.mjs";
import { readTeamRegistry } from "../team-registry.mjs";
import { readGatewayLockLiveness } from "../gateway-loop.mjs";
import { resolveTeamiHome } from "../app-home.mjs";

// The four states the home screen (G2/G3) and the read-only `gateway status` (E1) render from.
export const HOME_STATE = Object.freeze({
  UNINITIALIZED: "uninitialized",
  IDLE: "idle",
  LISTENING: "listening",
  DEGRADED: "degraded",
});

// Mirror loadLinearConfig's own path resolution (config.mjs) so we can tell a MISSING config
// (fresh checkout — uninitialized) apart from a PRESENT-but-unreadable one (corrupt — degraded)
// without matching on an error message.
function resolveConfigPath(repoRoot) {
  const configPath = process.env.TEAMI_LINEAR_CONFIG || DEFAULT_CONFIG_PATH;
  return path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath);
}

function probeResult(state, evidence) {
  return { state, evidence };
}

// Side-effect-free classifier for "what state is my factory in, and what's the next step?"
// STRICTLY read-only: it reads config, the team registry, and the gateway lock; it never calls
// runGatewayOnce, never touches the network, and never writes. It NEVER throws — every reader
// error is caught and classified (an unreadable config/registry is `degraded`).
//
// Classification (S4):
//   missing config OR missing registry OR no active team  -> uninitialized
//   active team + live .teami/gateway.lock       -> listening
//   active team + no/stale gateway lock                    -> idle
//   any parse/validation/read error from config or registry  -> degraded
export function homeStateProbe({ repoRoot = process.cwd(), home = resolveTeamiHome(), config = null } = {}) {
  const evidence = {
    hasConfig: false,
    activeTeamRef: null,
    lockLive: false,
  };

  // --- config: missing => uninitialized; present-but-bad => degraded ---
  if (config) {
    evidence.hasConfig = true;
  } else {
    if (!fs.existsSync(resolveConfigPath(repoRoot))) {
      return probeResult(HOME_STATE.UNINITIALIZED, evidence);
    }
    try {
      loadLinearConfig({ repoRoot });
      evidence.hasConfig = true;
    } catch {
      return probeResult(HOME_STATE.DEGRADED, evidence);
    }
  }

  // --- team registry: missing => uninitialized; unreadable => degraded ---
  let registry;
  try {
    registry = readTeamRegistry({ home }); // null when the registry file is absent
  } catch {
    return probeResult(HOME_STATE.DEGRADED, evidence);
  }
  if (registry == null) {
    return probeResult(HOME_STATE.UNINITIALIZED, evidence);
  }

  // --- active team: none => nothing to run yet, treat as uninitialized ---
  const activeTeam = (registry.teams || []).find((team) => team?.status === "active") || null;
  if (!activeTeam) {
    return probeResult(HOME_STATE.UNINITIALIZED, evidence);
  }
  evidence.activeTeamRef = activeTeam.id ?? null;

  // --- gateway lock: live => listening; missing/stale => idle (read-only liveness) ---
  // A lock-read problem is not a corrupt-config; the right next step is still `gateway start`,
  // so it classifies as idle rather than degraded.
  evidence.lockLive = readGatewayLockLiveness({ home }).live === true;
  return probeResult(evidence.lockLive ? HOME_STATE.LISTENING : HOME_STATE.IDLE, evidence);
}
