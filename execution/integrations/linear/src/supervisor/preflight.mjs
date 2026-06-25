import { readLinearCache } from "../cache.mjs";

import { readLocalSupervisorRegistration } from "./registration.mjs";

export async function preflightLocalSupervisor({
  repoRoot = process.cwd(),
  config,
  cachePath,
} = {}) {
  const checks = [];
  const registration = readLocalSupervisorRegistration({ repoRoot });
  checks.push({
    name: "local supervisor consent",
    ok: registration.ok && registration.registration?.consent?.granted === true,
    message: registration.ok
      ? `recorded (${registration.registration.status}; ${registration.registration.os_registration?.status || "unknown"})`
      : "not registered; run npm run supervisor:register -- --consent-local-supervisor",
  });
  checks.push({
    name: "local supervisor config",
    ok: Boolean(config?.linear && config?.runtime && config?.workflows),
    message: config ? "config object loaded" : "config missing",
  });

  let cache = null;
  try {
    cache = readLinearCache(cachePath);
    checks.push({
      name: "workspace cache",
      ok: Boolean(cache?.workspaceId && cache?.teamId),
      message: cache?.workspaceId && cache?.teamId
        ? `workspace ${cache.workspaceId}, team ${cache.teamId}`
        : "missing workspace cache; run npm run init",
    });
  } catch (error) {
    checks.push({ name: "workspace cache", ok: false, message: error.message });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    registration,
    cache,
  };
}
