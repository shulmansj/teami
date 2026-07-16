import {
  defaultRunCommand,
  ghJsonWithAmbientAuth,
} from "../github-setup.mjs";
import {
  readTeamRegistry,
  upsertTeamRecord,
  updateTeamRegistry,
  writeTeamRegistry,
} from "../team-registry.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import {
  gitRepoResourceId,
  registerGitRepoResourceKind,
} from "../../../git/git-repo-materializer.mjs";
import { parseCliFlags } from "./flags.mjs";
import {
  agenticFactoryHeading,
  formatCommand,
  printVerboseHint,
} from "./operator-output.mjs";

const TEAM_COMMAND_USAGE = Object.freeze({
  "team:show": `Usage: ${formatCommand("team show <id>")}`,
  "team:grant": `Usage: ${formatCommand("team grant <id> --repo <owner/name>")}`,
  "team:revoke": `Usage: ${formatCommand("team revoke <id> --repo <owner/name>")}`,
});

export async function runTeamCommand({
  context,
  command,
  args = [],
  runCommand = context?.runCommand ?? context?.githubDiscoveryRunCommand ?? defaultRunCommand,
} = {}) {
  const { output, repoRoot, home = resolveTeamiHome() } = context;
  const verb = commandVerb(command);
  agenticFactoryHeading(output, `team ${verb}`);

  try {
    if (command === "team:show") {
      const parsed = parseTeamShowArgs(args);
      if (!parsed) return usageError(output, command);
      renderTeamGrantSet(
        readTeamGrantSet({ repoRoot, home, teamRef: parsed.teamRef }),
        output,
      );
      process.exitCode = 0;
      return;
    }

    if (command === "team:grant") {
      const parsed = parseTeamRepoArgs(args);
      if (!parsed) return usageError(output, command);
      const result = await grantTeamGitRepoResource({
        repoRoot,
        home,
        teamRef: parsed.teamRef,
        repoSlug: parsed.repoSlug,
        runCommand,
      });
      renderGrantResult(result, output);
      process.exitCode = 0;
      return;
    }

    if (command === "team:revoke") {
      const parsed = parseTeamRepoArgs(args);
      if (!parsed) return usageError(output, command);
      const result = revokeTeamGitRepoResource({
        repoRoot,
        home,
        teamRef: parsed.teamRef,
        repoSlug: parsed.repoSlug,
      });
      renderRevokeResult(result, output);
      process.exitCode = 0;
      return;
    }

    output.error({ what: TEAM_COMMAND_USAGE[command] || "Unknown team command" });
    process.exitCode = 2;
  } catch (error) {
    output.error({
      what: `Team ${verb} failed`,
      why: error.message,
      fix: teamCommandRepairHint(error),
    });
    process.exitCode = 1;
  }
}

export function readTeamGrantSet({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef,
} = {}) {
  registerGitRepoResourceKind();
  const { team } = requireTeam({ repoRoot, home, teamRef });
  return {
    team,
    resources: gitRepoResources(team),
  };
}

export async function grantTeamGitRepoResource({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef,
  repoSlug,
  runCommand = defaultRunCommand,
  registry = null,
  writeRegistry = null,
} = {}) {
  registerGitRepoResourceKind();
  const requested = parseGitHubRepoSlug(repoSlug);
  const requestedId = gitRepoResourceId(requested);
  const currentRegistry = registry || readTeamRegistry({ home });
  if (!currentRegistry) throw new Error("team_registry_missing");
  const team = requireMutableTeamFromRegistry(currentRegistry, teamRef);

  const existingIndex = (team.resources || []).findIndex((resource) => resource.id === requestedId);
  let resource = null;
  if (existingIndex !== -1) {
    const existing = team.resources[existingIndex];
    const existingDefaultBranch = nonEmptyString(existing?.binding?.default_branch);
    if (existingDefaultBranch) {
      resource = gitRepoResourceFromBinding({
        owner: nonEmptyString(existing?.binding?.owner) || requested.owner,
        repo: nonEmptyString(existing?.binding?.repo) || requested.repo,
        default_branch: existingDefaultBranch,
      });
    }
  }

  resource ||= gitRepoResourceFromBinding(await resolveGitHubRepoBinding({
    repoSlug: requested,
    runCommand,
  }));

  if (registry !== null || typeof writeRegistry === "function") {
    return commitInjectedTeamResourceUpdate({
      currentRegistry,
      writeRegistry: writeRegistry || ((nextRegistry) => writeTeamRegistry({ home }, nextRegistry)),
      update: (latestRegistry) => grantResourceUpdate(latestRegistry, { teamRef, resource }),
    });
  }
  return teamResourceUpdateResult(updateTeamRegistry(
    { home },
    (latestRegistry) => grantResourceUpdate(latestRegistry, { teamRef, resource }),
  ));
}

export function revokeTeamGitRepoResource({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  teamRef,
  repoSlug,
  registry = null,
  writeRegistry = null,
} = {}) {
  registerGitRepoResourceKind();
  const requested = parseGitHubRepoSlug(repoSlug);
  const requestedId = gitRepoResourceId(requested);
  const resource = gitRepoResourceFromBinding({
    ...requested,
    default_branch: "unknown",
  });
  if (registry !== null || typeof writeRegistry === "function") {
    const currentRegistry = registry || readTeamRegistry({ home });
    if (!currentRegistry) throw new Error("team_registry_missing");
    return commitInjectedTeamResourceUpdate({
      currentRegistry,
      writeRegistry: writeRegistry || ((nextRegistry) => writeTeamRegistry({ home }, nextRegistry)),
      update: (latestRegistry) => revokeResourceUpdate(latestRegistry, {
        teamRef,
        requestedId,
        resource,
      }),
    });
  }
  return teamResourceUpdateResult(updateTeamRegistry(
    { home },
    (latestRegistry) => revokeResourceUpdate(latestRegistry, {
      teamRef,
      requestedId,
      resource,
    }),
  ));
}

export async function resolveGitHubRepoBinding({
  repoSlug,
  runCommand = defaultRunCommand,
} = {}) {
  const requested = typeof repoSlug === "string" ? parseGitHubRepoSlug(repoSlug) : repoSlug;
  const data = await ghJsonWithAmbientAuth({
    runCommand,
    args: [
      "repo",
      "view",
      `${requested.owner}/${requested.repo}`,
      "--json",
      "nameWithOwner,defaultBranchRef",
    ],
    missingOk: true,
  });
  if (!data) throw new Error(`team_git_repo_not_found:${requested.owner}/${requested.repo}`);
  return normalizeGitHubRepoView(data, requested);
}

function grantResourceUpdate(currentRegistry, { teamRef, resource }) {
  const team = requireMutableTeamFromRegistry(currentRegistry, teamRef);
  const existingIndex = (team.resources || []).findIndex((candidate) => candidate.id === resource.id);
  if (existingIndex !== -1 && isSameGitRepoResource(team.resources[existingIndex], resource)) {
    return { action: "unchanged", registry: currentRegistry, resource, teamRef };
  }
  const resources = existingIndex === -1
    ? [...(team.resources || []), resource]
    : team.resources.map((candidate, index) => index === existingIndex ? resource : candidate);
  const updatedTeam = {
    ...structuredClone(team),
    resources,
  };
  return {
    action: existingIndex === -1 ? "added" : "canonicalized",
    registry: upsertTeamRecord(currentRegistry, updatedTeam),
    resource,
    teamRef,
  };
}

function revokeResourceUpdate(currentRegistry, { teamRef, requestedId, resource }) {
  const team = requireMutableTeamFromRegistry(currentRegistry, teamRef);
  const resources = (team.resources || []).filter((candidate) => candidate.id !== requestedId);
  if (resources.length === (team.resources || []).length) {
    return { action: "unchanged", registry: currentRegistry, resource, teamRef };
  }
  return {
    action: "removed",
    registry: upsertTeamRecord(currentRegistry, {
      ...structuredClone(team),
      resources,
    }),
    resource,
    teamRef,
  };
}

function commitInjectedTeamResourceUpdate({ currentRegistry, writeRegistry, update }) {
  const outcome = update(currentRegistry);
  const changed = JSON.stringify(outcome.registry) !== JSON.stringify(currentRegistry);
  const registryPath = changed ? writeRegistry(outcome.registry, currentRegistry) : null;
  return teamResourceUpdateResult({ ...outcome, changed, registryPath });
}

function teamResourceUpdateResult(outcome) {
  return {
    action: outcome.action,
    changed: outcome.changed,
    team: requireTeamFromRegistry(outcome.registry, outcome.teamRef),
    registry: outcome.registry,
    registryPath: outcome.registryPath,
    resource: outcome.resource,
  };
}

function requireTeamFromRegistry(registry, teamRef) {
  if (!registry) throw new Error("team_registry_missing");
  const team = registry.teams.find((candidate) => candidate.id === teamRef);
  if (!team) throw new Error(`team_unknown:${teamRef}`);
  return team;
}

function requireMutableTeamFromRegistry(registry, teamRef) {
  const team = requireTeamFromRegistry(registry, teamRef);
  if (team.status === "removed") throw new Error(`team_removed:${teamRef}`);
  return team;
}

function renderTeamGrantSet({ team, resources }, output) {
  output.keyValues([
    ["Team", team.id],
    ["Repos granted", String(resources.length)],
  ]);
  if (resources.length === 0) {
    output.info("No GitHub repos granted.");
    return;
  }
  for (const resource of resources) {
    output.keyValues([
      ["Repo", repoLabel(resource.binding)],
      ["Resource", resource.id],
      ["Role", resource.role],
      ["Default branch", resource.binding.default_branch],
    ], { heading: repoLabel(resource.binding) });
  }
}

function renderGrantResult(result, output) {
  if (result.action === "unchanged") {
    output.success(`Repo already granted: ${repoLabel(result.resource.binding)}`);
  } else {
    output.success(`Repo granted: ${repoLabel(result.resource.binding)}`);
  }
  output.keyValues([
    ["Team", result.team.id],
    ["Resource", result.resource.id],
    ["Role", result.resource.role],
    ["Default branch", result.resource.binding.default_branch],
  ]);
  printVerboseHint(output);
}

function renderRevokeResult(result, output) {
  if (result.action === "unchanged") {
    output.success(`Repo was not granted: ${repoLabel(result.resource.binding)}`);
  } else {
    output.success(`Repo revoked: ${repoLabel(result.resource.binding)}`);
  }
  output.keyValues([
    ["Team", result.team.id],
    ["Resource", result.resource.id],
  ]);
  printVerboseHint(output);
}

function requireTeam({
  repoRoot,
  home = resolveTeamiHome(),
  teamRef,
} = {}) {
  void repoRoot;
  if (!nonEmptyString(teamRef)) throw new Error("team_missing");
  const registry = readTeamRegistry({ home });
  if (!registry) throw new Error("team_registry_missing");
  const team = registry.teams.find((candidate) => candidate.id === teamRef);
  if (!team) throw new Error(`team_unknown:${teamRef}`);
  return { registry, team };
}

function parseTeamShowArgs(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  if (positionals.length !== 1 || Object.keys(flags).length > 0) return null;
  const teamRef = nonEmptyString(positionals[0]);
  return teamRef ? { teamRef } : null;
}

function parseTeamRepoArgs(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  const flagNames = Object.keys(flags);
  if (positionals.length !== 1 || flagNames.length !== 1 || flagNames[0] !== "repo") return null;
  const teamRef = nonEmptyString(positionals[0]);
  const repoSlug = nonEmptyString(flags.repo);
  if (!teamRef || !repoSlug) return null;
  return { teamRef, repoSlug };
}

function parseGitHubRepoSlug(value) {
  const slug = nonEmptyString(value);
  if (!slug) throw new Error("team_git_repo_missing_repo");
  const parts = slug.split("/");
  if (parts.length !== 2) throw new Error(`team_git_repo_invalid_repo:${slug}`);
  const owner = nonEmptyString(parts[0]);
  const repo = nonEmptyString(parts[1]);
  if (!owner || !repo || /[\s\\]/.test(owner) || /[\s\\]/.test(repo)) {
    throw new Error(`team_git_repo_invalid_repo:${slug}`);
  }
  return { owner, repo };
}

function normalizeGitHubRepoView(data, fallback) {
  const nameWithOwner = nonEmptyString(data?.nameWithOwner) || `${fallback.owner}/${fallback.repo}`;
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !nonEmptyString(parts[0]) || !nonEmptyString(parts[1])) {
    throw new Error(`team_git_repo_invalid_repo:${nameWithOwner}`);
  }
  const defaultBranch = nonEmptyString(data?.defaultBranchRef?.name);
  if (!defaultBranch) throw new Error(`team_git_repo_default_branch_missing:${nameWithOwner}`);
  return {
    owner: nonEmptyString(parts[0]),
    repo: nonEmptyString(parts[1]),
    default_branch: defaultBranch,
  };
}

function gitRepoResourceFromBinding(binding) {
  return {
    id: gitRepoResourceId(binding),
    kind: "git_repo",
    role: "primary",
    binding: {
      owner: binding.owner,
      repo: binding.repo,
      default_branch: binding.default_branch,
    },
  };
}

function gitRepoResources(team) {
  return (team.resources || []).filter((resource) => resource.kind === "git_repo");
}

function isSameGitRepoResource(left, right) {
  return left?.id === right.id
    && left?.kind === right.kind
    && left?.role === right.role
    && Object.keys(left?.binding || {}).sort().join(",") === "default_branch,owner,repo"
    && left.binding.owner === right.binding.owner
    && left.binding.repo === right.binding.repo
    && left.binding.default_branch === right.binding.default_branch;
}

function usageError(output, command) {
  output.error({ what: TEAM_COMMAND_USAGE[command] || `Usage: ${formatCommand("team <show|grant|revoke>")}` });
  process.exitCode = 2;
}

function teamCommandRepairHint(error) {
  const message = error?.message || "";
  if (message === "team_registry_missing" || message.startsWith("team_unknown")) {
    return `run ${formatCommand("init")} or ${formatCommand("team add")} first, then retry with an existing team id`;
  }
  if (
    message === "team_git_repo_missing_repo"
    || message.startsWith("team_git_repo_invalid_repo")
  ) {
    return "pass --repo as owner/name, for example --repo acme/app";
  }
  if (
    message.startsWith("team_git_repo_not_found")
    || message.startsWith("team_git_repo_default_branch_missing")
  ) {
    return "check the GitHub repo name and local gh auth, then retry";
  }
  return "check the team id, repo name, and local GitHub auth, then retry";
}

function commandVerb(command) {
  return String(command || "").split(":")[1] || "command";
}

function repoLabel(binding) {
  return `${binding.owner}/${binding.repo}`;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
