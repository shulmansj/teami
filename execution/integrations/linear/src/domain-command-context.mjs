import { readLinearCache } from "./cache.mjs";
import { emptyDomainRegistry, readDomainRegistry } from "./domain-registry.mjs";
import {
  resolveForegroundDomainContext,
  resolveWakeDomainContext,
} from "./domain-resolver.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import { formatCommand } from "./cli/operator-output.mjs";

export function resolveForegroundDomainCache({
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registry = null,
  domainId = null,
  readCache = readLinearCache,
} = {}) {
  const loadedRegistry = registry || readDomainRegistry({ home }) || emptyDomainRegistry();
  const resolved = resolveForegroundDomainContext({
    registry: loadedRegistry,
    domainId,
    config,
    repoRoot,
    home,
  });
  if (!resolved.ok) {
    const error = new Error(foregroundDomainErrorMessage(resolved));
    error.reason = resolved.reason;
    error.candidates = resolved.candidates || [];
    throw error;
  }
  const context = resolved.context;
  return {
    context,
    cachePath: context.linear.cachePath,
    cache: readCache(context.linear.cachePath),
    config: configWithDomainLinearTeam(config, context),
  };
}

export function configWithDomainLinearTeam(config, domainContext) {
  const next = structuredClone(config);
  next.linear.team = {
    ...(next.linear.team || {}),
    key: domainContext.linear.teamKey,
    name: domainContext.linear.teamName,
  };
  return next;
}

export function foregroundDomainErrorMessage(resolved) {
  const candidates = (resolved?.candidates || [])
    .map((candidate) => `${candidate.domainId}(${candidate.status}${candidate.teamId ? `, team=${candidate.teamId}` : ""})`)
    .join(", ");
  const suffix = candidates ? ` Candidates: ${candidates}.` : "";
  if (resolved?.reason === "domain_required") {
    return `domain_required: multiple active domains are configured; pass --domain <domain_id>.${suffix}`;
  }
  if (resolved?.reason === "no_active_domains") {
    return `no_active_domains: no active domains are configured. Run ${formatCommand("init")}.${suffix}`;
  }
  if (resolved?.reason === "domain_not_found") {
    return `domain_not_found: no configured domain matches --domain.${suffix}`;
  }
  if (resolved?.reason === "domain_not_active") {
    const status = resolved.candidates?.[0]?.status ? ` status=${resolved.candidates[0].status}` : "";
    return `domain_not_active: the selected domain is not active${status}.${suffix}`;
  }
  return `${resolved?.reason || "domain_resolution_failed"}: could not resolve a foreground domain.${suffix}`;
}

export function decorateWakeViewsForDomains({ views, registry, config, repoRoot = process.cwd(), home = resolveTeamiHome(), domainId = null } = {}) {
  return (views || [])
    .map((wake) => decorateWakeViewForDomains({ wake, registry, config, repoRoot, home }))
    .filter((wake) => !domainId || wake.domainId === domainId || wake.resolvedDomainId === domainId);
}

export async function listWakeViewsForDomains({
} = {}) {
  throw new Error(`wake_views_retired: use ${formatCommand("gateway status")} for local trigger state.`);
}

export function decorateWakeViewForDomains({ wake, registry, config, repoRoot = process.cwd(), home = resolveTeamiHome() } = {}) {
  const loadedRegistry = registry || readDomainRegistry({ home }) || emptyDomainRegistry();
  const workspaceId = wake.workspace_id || wake.workspaceId || wake.organization_id || null;
  const webhookIds = wake.webhook_ids || wake.webhookIds || (wake.webhook_id ? [wake.webhook_id] : []);
  const teamIds = wake.team_ids || wake.teamIds || wake.project_team_ids || wake.projectTeamIds || [];
  const storedDomainId = wake.domain_id || wake.domainId || null;
  let resolvedDomainId = storedDomainId;
  let resolutionReason = null;
  let candidates = wake.routing_candidates || wake.routingCandidates || [];

  if (!resolvedDomainId) {
    const resolved = resolveWakeDomainContext({
      registry: loadedRegistry,
      config,
      repoRoot,
      home,
      selector: {
        workspaceId,
        webhookId: webhookIds,
        projectTeamIds: teamIds,
      },
    });
    if (resolved.ok) {
      resolvedDomainId = resolved.context.domainId;
    } else {
      resolutionReason = resolved.reason;
      candidates = resolved.candidates || candidates;
    }
  }

  const displayReason =
    wake.routing_error_reason ||
    wake.routingErrorReason ||
    wake.reason ||
    resolutionReason ||
    "";
  return {
    ...wake,
    domainId: storedDomainId,
    resolvedDomainId,
    domainLabel: resolvedDomainId ? `domain=${resolvedDomainId}` : `domain_unresolved=${resolutionReason || "missing_identity"}`,
    displayReason,
    routingCandidates: candidates,
  };
}
