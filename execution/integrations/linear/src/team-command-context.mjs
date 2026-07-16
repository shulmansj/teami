import { readLinearCache } from "./cache.mjs";
import { emptyTeamRegistry, readTeamRegistry } from "./team-registry.mjs";
import {
  resolveForegroundTeamContext,
  resolveWakeTeamContext,
} from "./team-resolver.mjs";
import { resolveTeamiHome } from "./app-home.mjs";
import { formatCommand } from "./cli/operator-output.mjs";

export function resolveForegroundTeamCache({
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  registry = null,
  teamRef = null,
  readCache = readLinearCache,
} = {}) {
  const loadedRegistry = registry || readTeamRegistry({ home }) || emptyTeamRegistry();
  const resolved = resolveForegroundTeamContext({
    registry: loadedRegistry,
    teamRef,
    config,
    repoRoot,
    home,
  });
  if (!resolved.ok) {
    const error = new Error(foregroundTeamErrorMessage(resolved));
    error.reason = resolved.reason;
    error.candidates = resolved.candidates || [];
    throw error;
  }
  const context = resolved.context;
  return {
    context,
    cachePath: context.linear.cachePath,
    cache: readCache(context.linear.cachePath),
    config: configWithTeamLinearTeam(config, context),
  };
}

export function configWithTeamLinearTeam(config, teamContext) {
  const next = structuredClone(config);
  next.linear.team = {
    ...(next.linear.team || {}),
    key: teamContext.linear.teamKey,
    name: teamContext.linear.teamName,
  };
  return next;
}

export function foregroundTeamErrorMessage(resolved) {
  const candidates = (resolved?.candidates || [])
    .map((candidate) => {
      const workspace = candidate.workspaceName || candidate.workspaceId || "unknown workspace";
      const linearTeam = candidate.teamName || candidate.teamKey || candidate.teamId || "unknown Linear Team";
      return `${candidate.teamRef} (${candidate.status}; ${workspace}; ${linearTeam})`;
    })
    .join(", ");
  const suffix = candidates ? ` Candidates: ${candidates}.` : "";
  if (resolved?.reason === "team_required") {
    return `team_required: multiple active teams are configured; pass --team <team_ref>.${suffix}`;
  }
  if (resolved?.reason === "no_active_teams") {
    return `no_active_teams: no active teams are configured. Run ${formatCommand("init")}.${suffix}`;
  }
  if (resolved?.reason === "team_not_found") {
    return `team_not_found: no configured team matches --team.${suffix}`;
  }
  if (resolved?.reason === "team_not_active") {
    const status = resolved.candidates?.[0]?.status ? ` status=${resolved.candidates[0].status}` : "";
    return `team_not_active: the selected team is not active${status}.${suffix}`;
  }
  return `${resolved?.reason || "team_resolution_failed"}: could not resolve a foreground team.${suffix}`;
}

export function decorateWakeViewsForTeams({ views, registry, config, repoRoot = process.cwd(), home = resolveTeamiHome(), teamRef = null } = {}) {
  return (views || [])
    .map((wake) => decorateWakeViewForTeams({ wake, registry, config, repoRoot, home }))
    .filter((wake) => !teamRef || wake.teamRef === teamRef || wake.resolvedTeamRef === teamRef);
}

export async function listWakeViewsForTeams({
} = {}) {
  throw new Error(`wake_views_retired: use ${formatCommand("gateway status")} for local trigger state.`);
}

export function decorateWakeViewForTeams({ wake, registry, config, repoRoot = process.cwd(), home = resolveTeamiHome() } = {}) {
  const loadedRegistry = registry || readTeamRegistry({ home }) || emptyTeamRegistry();
  const workspaceId = wake.workspace_id || wake.workspaceId || wake.organization_id || null;
  const webhookIds = wake.webhook_ids || wake.webhookIds || (wake.webhook_id ? [wake.webhook_id] : []);
  const teamIds = wake.team_ids || wake.teamIds || wake.project_team_ids || wake.projectTeamIds || [];
  const storedTeamRef = wake.team_ref || wake.teamRef || null;
  let resolvedTeamRef = storedTeamRef;
  let resolutionReason = null;
  let candidates = wake.routing_candidates || wake.routingCandidates || [];

  if (!resolvedTeamRef) {
    const resolved = resolveWakeTeamContext({
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
      resolvedTeamRef = resolved.context.teamRef;
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
    teamRef: storedTeamRef,
    resolvedTeamRef,
    teamLabel: resolvedTeamRef ? `team=${resolvedTeamRef}` : `team_unresolved=${resolutionReason || "missing_identity"}`,
    displayReason,
    routingCandidates: candidates,
  };
}
