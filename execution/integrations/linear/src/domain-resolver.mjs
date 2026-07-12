import crypto from "node:crypto";
import path from "node:path";

import { credentialTargetForConfig } from "./linear-credential-store.mjs";
import {
  domainCachePath,
  readDomainRegistry,
  validateDomainRegistry,
} from "./domain-registry.mjs";
import { resolveTeamiHome } from "./app-home.mjs";

export function resolveDomainContext({
  registry,
  domainId,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const loaded = loadRegistry(registry, home);
  const domain = loaded.domains.find((candidate) => candidate.id === domainId);
  if (!domain) {
    return {
      ok: false,
      reason: "domain_not_found",
      candidates: domainCandidates(loaded.domains),
    };
  }
  if (domain.status !== "active") {
    return {
      ok: false,
      reason: "domain_not_active",
      candidates: domainCandidates([domain]),
    };
  }
  return { ok: true, context: buildDomainContext({ domain, config, repoRoot, home, behaviorRepoId }) };
}

export function resolveForegroundDomainContext({
  registry,
  domainId = null,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const loaded = loadRegistry(registry, home);
  if (domainId) {
    return resolveDomainContext({ registry: loaded, domainId, config, repoRoot, home, behaviorRepoId });
  }

  const activeDomains = loaded.domains.filter((domain) => domain.status === "active");
  if (activeDomains.length === 1) {
    return {
      ok: true,
      context: buildDomainContext({ domain: activeDomains[0], config, repoRoot, home, behaviorRepoId }),
    };
  }
  return {
    ok: false,
    reason: activeDomains.length === 0 ? "no_active_domains" : "domain_required",
    message: activeDomains.length === 0
      ? "No active domains are configured."
      : "Multiple active domains are configured; pass --domain <domain_id>.",
    candidates: domainCandidates(activeDomains),
  };
}

export function resolveWakeDomainContext({
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

  const workspaceDomains = loaded.domains.filter(
    (domain) => domain.linear.workspace_id === workspaceId,
  );
  const activeWorkspaceDomains = workspaceDomains.filter((domain) => domain.status === "active");
  if (activeWorkspaceDomains.length === 0) {
    return {
      ok: false,
      reason: "no_active_domain_for_workspace",
      candidates: domainCandidates(workspaceDomains),
    };
  }

  const projectTeamIds = values(selector.projectTeamIds);
  const projectTeamMatches = activeWorkspaceDomains.filter(
    (domain) => projectTeamIds.includes(domain.linear.team_id),
  );
  if (projectTeamMatches.length > 1) {
    return {
      ok: false,
      reason: "cross_domain_team_conflict",
      candidates: domainCandidates(projectTeamMatches),
    };
  }

  const webhookIds = values(selector.webhookId);
  if (webhookIds.length > 0) {
    const matches = activeWorkspaceDomains.filter((domain) => webhookIds.includes(domain.linear.webhook_id));
    return oneOrFailure({
      matches,
      allCandidates: activeWorkspaceDomains,
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
    const matches = activeWorkspaceDomains.filter((domain) => teamIds.includes(domain.linear.team_id));
    return oneOrFailure({
      matches,
      allCandidates: activeWorkspaceDomains,
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
      reasonZero: "no_domain_project_team_intersection",
      reasonMany: "ambiguous_domain_project_team_intersection",
      config,
      repoRoot,
      home,
      behaviorRepoId,
    });
  }

  if (workspaceDomains.length === 1 && workspaceDomains[0].status === "active") {
    return {
      ok: true,
      context: buildDomainContext({ domain: workspaceDomains[0], config, repoRoot, home, behaviorRepoId }),
    };
  }
  return {
    ok: false,
    reason: "insufficient_wake_identity",
    candidates: domainCandidates(workspaceDomains),
  };
}

export function buildDomainContext({
  domain,
  config,
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  behaviorRepoId = behaviorRepoIdForRepoRoot(repoRoot),
} = {}) {
  const context = {
    domainId: domain.id,
    status: domain.status,
    resources: structuredClone(domain.resources || []),
    allowedRepoPacket: allowedRepoPacketFromDomainResources(domain.resources || []),
    linear: {
      workspaceId: domain.linear.workspace_id,
      teamId: domain.linear.team_id,
      teamKey: domain.linear.team_key,
      teamName: domain.linear.team_name,
      webhookId: domain.linear.webhook_id,
      cachePath: domainCachePath({
        home,
        domainId: domain.id,
        cachePath: domain.linear.cache_path,
      }),
    },
    credentialTargets: {
      linearOAuth: config
        ? credentialTargetForConfig(config, repoRoot, {
            domainId: domain.id,
            workspaceId: domain.linear.workspace_id,
          })
        : null,
    },
    trace: {
      domain_id: domain.id,
      workspace_id: domain.linear.workspace_id,
      team_id: domain.linear.team_id,
      behavior_repo_id: behaviorRepoId,
    },
  };
  return deepFreeze(context);
}

export function allowedRepoPacketFromDomainResources(resources = []) {
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
  const loaded = registry || readDomainRegistry({ home });
  validateDomainRegistry(loaded);
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
    return { ok: true, context: buildDomainContext({ domain: matches[0], config, repoRoot, home, behaviorRepoId }) };
  }
  return {
    ok: false,
    reason: matches.length === 0 ? reasonZero : reasonMany,
    candidates: domainCandidates(matches.length === 0 ? allCandidates : matches),
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

function domainCandidates(domains) {
  return domains.map((domain) => ({
    domainId: domain.id,
    status: domain.status,
    teamId: domain.linear.team_id,
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
