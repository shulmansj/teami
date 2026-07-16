import crypto from "node:crypto";
import path from "node:path";

import { credentialTargetForConfig } from "./linear-credential-store.mjs";
import {
  teamCachePath,
  readTeamRegistry,
  validateTeamRegistry,
} from "./team-registry.mjs";
import { resolveTeamiHome } from "./app-home.mjs";

export function resolveTeamContext({
  registry,
  teamRef,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const loaded = loadRegistry(registry, home);
  const team = loaded.teams.find((candidate) => candidate.id === teamRef);
  if (!team) {
    return {
      ok: false,
      reason: "team_not_found",
      candidates: teamCandidates(loaded.teams),
    };
  }
  if (team.status !== "active") {
    return {
      ok: false,
      reason: "team_not_active",
      candidates: teamCandidates([team]),
    };
  }
  return { ok: true, context: buildTeamContext({ team, config, repoRoot, home, behaviorRepoId }) };
}

export function resolveForegroundTeamContext({
  registry,
  teamRef = null,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const loaded = loadRegistry(registry, home);
  if (teamRef) {
    return resolveTeamContext({ registry: loaded, teamRef, config, repoRoot, home, behaviorRepoId });
  }

  const activeTeams = loaded.teams.filter((team) => team.status === "active");
  if (activeTeams.length === 1) {
    return {
      ok: true,
      context: buildTeamContext({ team: activeTeams[0], config, repoRoot, home, behaviorRepoId }),
    };
  }
  return {
    ok: false,
    reason: activeTeams.length === 0 ? "no_active_teams" : "team_required",
    message: activeTeams.length === 0
      ? "No active teams are configured."
      : "Multiple active teams are configured; pass --team <team_ref>.",
    candidates: teamCandidates(activeTeams),
  };
}

export function resolveWakeTeamContext({
  registry,
  selector = {},
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const loaded = loadRegistry(registry, home);
  const workspaceId = selector.workspaceId || null;
  if (!workspaceId) {
    return { ok: false, reason: "missing_workspace_id", candidates: [] };
  }

  const workspaceTeams = loaded.teams.filter(
    (team) => team.linear.workspace_id === workspaceId,
  );
  const activeWorkspaceTeams = workspaceTeams.filter((team) => team.status === "active");
  if (activeWorkspaceTeams.length === 0) {
    return {
      ok: false,
      reason: "no_active_team_for_workspace",
      candidates: teamCandidates(workspaceTeams),
    };
  }

  const projectTeamIds = values(selector.projectTeamIds);
  const projectTeamMatches = activeWorkspaceTeams.filter(
    (team) => projectTeamIds.includes(team.linear.team_id),
  );
  if (projectTeamMatches.length > 1) {
    return {
      ok: false,
      reason: "cross_team_conflict",
      candidates: teamCandidates(projectTeamMatches),
    };
  }

  const webhookIds = values(selector.webhookId);
  if (webhookIds.length > 0) {
    const matches = activeWorkspaceTeams.filter((team) => webhookIds.includes(team.linear.webhook_id));
    return oneOrFailure({
      matches,
      allCandidates: activeWorkspaceTeams,
      reasonZero: "webhook_id_mismatch",
      reasonMany: "ambiguous_webhook_id",
      config,
      repoRoot,
      home,
      behaviorRepoId,
    });
  }

  const teamIds = values(selector.teamId);
  if (teamIds.length > 0) {
    const matches = activeWorkspaceTeams.filter((team) => teamIds.includes(team.linear.team_id));
    return oneOrFailure({
      matches,
      allCandidates: activeWorkspaceTeams,
      reasonZero: "team_id_mismatch",
      reasonMany: "ambiguous_team_id",
      config,
      repoRoot,
      home,
      behaviorRepoId,
    });
  }

  if (projectTeamIds.length > 0) {
    return oneOrFailure({
      matches: projectTeamMatches,
      allCandidates: projectTeamMatches,
      reasonZero: "no_team_project_team_intersection",
      reasonMany: "ambiguous_team_project_team_intersection",
      config,
      repoRoot,
      home,
      behaviorRepoId,
    });
  }

  if (workspaceTeams.length === 1 && workspaceTeams[0].status === "active") {
    return {
      ok: true,
      context: buildTeamContext({ team: workspaceTeams[0], config, repoRoot, home, behaviorRepoId }),
    };
  }
  return {
    ok: false,
    reason: "insufficient_wake_identity",
    candidates: teamCandidates(workspaceTeams),
  };
}

export function buildTeamContext({
  team,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const context = {
    teamRef: team.id,
    status: team.status,
    resources: structuredClone(team.resources || []),
    allowedRepoPacket: allowedRepoPacketFromTeamResources(team.resources || []),
    linear: {
      workspaceId: team.linear.workspace_id,
      workspaceName: team.linear.workspace_name,
      teamId: team.linear.team_id,
      teamKey: team.linear.team_key,
      teamName: team.linear.team_name,
      webhookId: team.linear.webhook_id,
      cachePath: teamCachePath({
        home,
        teamRef: team.id,
        cachePath: team.linear.cache_path,
      }),
    },
    credentialTargets: {
      linearOAuth: config
        ? credentialTargetForConfig(config, repoRoot, {
            teamRef: team.id,
            workspaceId: team.linear.workspace_id,
          })
        : null,
    },
    trace: {
      team_ref: team.id,
      workspace_id: team.linear.workspace_id,
      team_id: team.linear.team_id,
      behavior_repo_id: behaviorRepoId,
    },
  };
  return deepFreeze(context);
}

export function allowedRepoPacketFromTeamResources(resources = []) {
  return (Array.isArray(resources) ? resources : [])
    .filter((resource) => resource?.kind === "git_repo" && resource.binding)
    .map((resource) => {
      const binding = resource.binding;
      const entry = {
        resource_id: resource.id,
        owner: binding.owner,
        repo: binding.repo,
        default_branch: binding.default_branch,
      };
      if (typeof binding.repo_scope === "string" && binding.repo_scope.trim() !== "") {
        entry.repo_scope = binding.repo_scope;
      }
      return entry;
    });
}

export function behaviorRepoIdForRepoRoot(repoRoot = process.cwd()) {
  const resolved = path.resolve(repoRoot);
  const digest = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `local:${digest}`;
}

function loadRegistry(registry, home) {
  const loaded = registry || readTeamRegistry({ home });
  validateTeamRegistry(loaded);
  return loaded;
}

function oneOrFailure({
  matches,
  allCandidates,
  reasonZero,
  reasonMany,
  config,
  repoRoot,
  home,
  behaviorRepoId,
}) {
  if (matches.length === 1) {
    return { ok: true, context: buildTeamContext({ team: matches[0], config, repoRoot, home, behaviorRepoId }) };
  }
  return {
    ok: false,
    reason: matches.length === 0 ? reasonZero : reasonMany,
    candidates: teamCandidates(matches.length === 0 ? allCandidates : matches),
  };
}

function values(...inputs) {
  return [
    ...new Set(
      inputs
        .flatMap((input) => (Array.isArray(input) ? input : [input]))
        .filter((value) => typeof value === "string" && value.trim() !== ""),
    ),
  ];
}

function teamCandidates(teams) {
  return teams.map((team) => ({
    teamRef: team.id,
    status: team.status,
    workspaceId: team.linear.workspace_id,
    workspaceName: team.linear.workspace_name,
    teamId: team.linear.team_id,
    teamKey: team.linear.team_key,
    teamName: team.linear.team_name,
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
