import {
  defaultRunCommand,
  ghJsonWithAmbientAuth,
} from "../github-setup.mjs";
import {
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../domain-registry.mjs";
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

const DOMAIN_COMMAND_USAGE = Object.freeze({
  "domain:show": `Usage: ${formatCommand("domain show <id>")}`,
  "domain:grant": `Usage: ${formatCommand("domain grant <id> --repo <owner/name>")}`,
  "domain:revoke": `Usage: ${formatCommand("domain revoke <id> --repo <owner/name>")}`,
});

export async function runDomainCommand({
  context,
  command,
  args = [],
  runCommand = context?.runCommand ?? context?.githubDiscoveryRunCommand ?? defaultRunCommand,
} = {}) {
  const { output, repoRoot } = context;
  const verb = commandVerb(command);
  agenticFactoryHeading(output, `domain ${verb}`);

  try {
    if (command === "domain:show") {
      const parsed = parseDomainShowArgs(args);
      if (!parsed) return usageError(output, command);
      renderDomainGrantSet(
        readDomainGrantSet({ repoRoot, domainId: parsed.domainId }),
        output,
      );
      process.exitCode = 0;
      return;
    }

    if (command === "domain:grant") {
      const parsed = parseDomainRepoArgs(args);
      if (!parsed) return usageError(output, command);
      const result = await grantDomainGitRepoResource({
        repoRoot,
        domainId: parsed.domainId,
        repoSlug: parsed.repoSlug,
        runCommand,
      });
      renderGrantResult(result, output);
      process.exitCode = 0;
      return;
    }

    if (command === "domain:revoke") {
      const parsed = parseDomainRepoArgs(args);
      if (!parsed) return usageError(output, command);
      const result = revokeDomainGitRepoResource({
        repoRoot,
        domainId: parsed.domainId,
        repoSlug: parsed.repoSlug,
      });
      renderRevokeResult(result, output);
      process.exitCode = 0;
      return;
    }

    output.error({ what: DOMAIN_COMMAND_USAGE[command] || "Unknown domain command" });
    process.exitCode = 2;
  } catch (error) {
    output.error({
      what: `Domain ${verb} failed`,
      why: error.message,
      fix: domainCommandRepairHint(error),
    });
    process.exitCode = 1;
  }
}

export function readDomainGrantSet({
  repoRoot = process.cwd(),
  domainId,
} = {}) {
  registerGitRepoResourceKind();
  const { domain } = requireDomain({ repoRoot, domainId });
  return {
    domain,
    resources: gitRepoResources(domain),
  };
}

export async function grantDomainGitRepoResource({
  repoRoot = process.cwd(),
  domainId,
  repoSlug,
  runCommand = defaultRunCommand,
  registry = null,
  writeRegistry = (nextRegistry) => writeDomainRegistry({ repoRoot }, nextRegistry),
} = {}) {
  registerGitRepoResourceKind();
  const requested = parseGitHubRepoSlug(repoSlug);
  const requestedId = gitRepoResourceId(requested);
  const currentRegistry = registry || readDomainRegistry({ repoRoot });
  if (!currentRegistry) throw new Error("domain_registry_missing");
  const domain = currentRegistry.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`domain_unknown:${domainId}`);

  const existingIndex = (domain.resources || []).findIndex((resource) => resource.id === requestedId);
  if (existingIndex !== -1) {
    const existing = domain.resources[existingIndex];
    const existingDefaultBranch = nonEmptyString(existing?.binding?.default_branch);
    if (existingDefaultBranch) {
      const resource = gitRepoResourceFromBinding({
        owner: nonEmptyString(existing?.binding?.owner) || requested.owner,
        repo: nonEmptyString(existing?.binding?.repo) || requested.repo,
        default_branch: existingDefaultBranch,
      });
      if (isSameGitRepoResource(existing, resource)) {
        return {
          action: "unchanged",
          changed: false,
          domain,
          registry: currentRegistry,
          registryPath: null,
          resource,
        };
      }
      return writeUpdatedDomainResources({
        currentRegistry,
        domain,
        resources: domain.resources.map((candidate, index) => index === existingIndex ? resource : candidate),
        writeRegistry,
        action: "canonicalized",
        resource,
      });
    }
  }

  const resource = gitRepoResourceFromBinding(resolveGitHubRepoBinding({
    repoSlug: requested,
    runCommand,
  }));
  const resources = existingIndex === -1
    ? [...(domain.resources || []), resource]
    : domain.resources.map((candidate, index) => index === existingIndex ? resource : candidate);

  return writeUpdatedDomainResources({
    currentRegistry,
    domain,
    resources,
    writeRegistry,
    action: existingIndex === -1 ? "added" : "canonicalized",
    resource,
  });
}

export function revokeDomainGitRepoResource({
  repoRoot = process.cwd(),
  domainId,
  repoSlug,
  registry = null,
  writeRegistry = (nextRegistry) => writeDomainRegistry({ repoRoot }, nextRegistry),
} = {}) {
  registerGitRepoResourceKind();
  const requested = parseGitHubRepoSlug(repoSlug);
  const requestedId = gitRepoResourceId(requested);
  const currentRegistry = registry || readDomainRegistry({ repoRoot });
  if (!currentRegistry) throw new Error("domain_registry_missing");
  const domain = currentRegistry.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`domain_unknown:${domainId}`);

  const resources = (domain.resources || []).filter((resource) => resource.id !== requestedId);
  if (resources.length === (domain.resources || []).length) {
    return {
      action: "unchanged",
      changed: false,
      domain,
      registry: currentRegistry,
      registryPath: null,
      resource: gitRepoResourceFromBinding({
        ...requested,
        default_branch: "unknown",
      }),
    };
  }

  return writeUpdatedDomainResources({
    currentRegistry,
    domain,
    resources,
    writeRegistry,
    action: "removed",
    resource: gitRepoResourceFromBinding({
      ...requested,
      default_branch: "unknown",
    }),
  });
}

export function resolveGitHubRepoBinding({
  repoSlug,
  runCommand = defaultRunCommand,
} = {}) {
  const requested = typeof repoSlug === "string" ? parseGitHubRepoSlug(repoSlug) : repoSlug;
  const data = ghJsonWithAmbientAuth({
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
  if (!data) throw new Error(`domain_git_repo_not_found:${requested.owner}/${requested.repo}`);
  return normalizeGitHubRepoView(data, requested);
}

function writeUpdatedDomainResources({
  currentRegistry,
  domain,
  resources,
  writeRegistry,
  action,
  resource,
}) {
  const updatedDomain = {
    ...structuredClone(domain),
    resources,
  };
  const nextRegistry = upsertDomainRecord(currentRegistry, updatedDomain);
  const registryPath = writeRegistry(nextRegistry);
  return {
    action,
    changed: true,
    domain: nextRegistry.domains.find((candidate) => candidate.id === domain.id),
    registry: nextRegistry,
    registryPath,
    resource,
  };
}

function renderDomainGrantSet({ domain, resources }, output) {
  output.keyValues([
    ["Domain", domain.id],
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
    ["Domain", result.domain.id],
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
    ["Domain", result.domain.id],
    ["Resource", result.resource.id],
  ]);
  printVerboseHint(output);
}

function requireDomain({
  repoRoot,
  domainId,
} = {}) {
  if (!nonEmptyString(domainId)) throw new Error("domain_missing");
  const registry = readDomainRegistry({ repoRoot });
  if (!registry) throw new Error("domain_registry_missing");
  const domain = registry.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`domain_unknown:${domainId}`);
  return { registry, domain };
}

function parseDomainShowArgs(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  if (positionals.length !== 1 || Object.keys(flags).length > 0) return null;
  const domainId = nonEmptyString(positionals[0]);
  return domainId ? { domainId } : null;
}

function parseDomainRepoArgs(args = []) {
  const { positionals, flags } = parseCliFlags(args);
  const flagNames = Object.keys(flags);
  if (positionals.length !== 1 || flagNames.length !== 1 || flagNames[0] !== "repo") return null;
  const domainId = nonEmptyString(positionals[0]);
  const repoSlug = nonEmptyString(flags.repo);
  if (!domainId || !repoSlug) return null;
  return { domainId, repoSlug };
}

function parseGitHubRepoSlug(value) {
  const slug = nonEmptyString(value);
  if (!slug) throw new Error("domain_git_repo_missing_repo");
  const parts = slug.split("/");
  if (parts.length !== 2) throw new Error(`domain_git_repo_invalid_repo:${slug}`);
  const owner = nonEmptyString(parts[0]);
  const repo = nonEmptyString(parts[1]);
  if (!owner || !repo || /[\s\\]/.test(owner) || /[\s\\]/.test(repo)) {
    throw new Error(`domain_git_repo_invalid_repo:${slug}`);
  }
  return { owner, repo };
}

function normalizeGitHubRepoView(data, fallback) {
  const nameWithOwner = nonEmptyString(data?.nameWithOwner) || `${fallback.owner}/${fallback.repo}`;
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !nonEmptyString(parts[0]) || !nonEmptyString(parts[1])) {
    throw new Error(`domain_git_repo_invalid_repo:${nameWithOwner}`);
  }
  const defaultBranch = nonEmptyString(data?.defaultBranchRef?.name);
  if (!defaultBranch) throw new Error(`domain_git_repo_default_branch_missing:${nameWithOwner}`);
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

function gitRepoResources(domain) {
  return (domain.resources || []).filter((resource) => resource.kind === "git_repo");
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
  output.error({ what: DOMAIN_COMMAND_USAGE[command] || `Usage: ${formatCommand("domain <show|grant|revoke>")}` });
  process.exitCode = 2;
}

function domainCommandRepairHint(error) {
  const message = error?.message || "";
  if (message === "domain_registry_missing" || message.startsWith("domain_unknown")) {
    return `run ${formatCommand("init")} or ${formatCommand("domain add")} first, then retry with an existing domain id`;
  }
  if (
    message === "domain_git_repo_missing_repo"
    || message.startsWith("domain_git_repo_invalid_repo")
  ) {
    return "pass --repo as owner/name, for example --repo acme/app";
  }
  if (
    message.startsWith("domain_git_repo_not_found")
    || message.startsWith("domain_git_repo_default_branch_missing")
  ) {
    return "check the GitHub repo name and local gh auth, then retry";
  }
  return "check the domain id, repo name, and local GitHub auth, then retry";
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
