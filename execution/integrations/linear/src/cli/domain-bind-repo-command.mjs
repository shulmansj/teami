import fs from "node:fs";
import path from "node:path";

import {
  defaultRunGit,
} from "../../../git/git-repo-materializer.mjs";
import {
  readDomainRegistry,
  upsertDomainRecord,
  writeDomainRegistry,
} from "../domain-registry.mjs";
import { flagValue, parseCliFlags } from "./flags.mjs";
import {
  agenticFactoryHeading,
  printVerboseHint,
} from "./operator-output.mjs";

export const DOMAIN_BIND_REPO_USAGE =
  "Usage: npm run domain:bind-repo -- --domain <id> --path <existing checkout>";

export async function runDomainBindRepoCommand({
  context,
  args = [],
  runGit = context?.runGit ?? defaultRunGit,
} = {}) {
  const { output, repoRoot } = context;
  agenticFactoryHeading(output, "domain bind repo");

  const domainId = requiredStringFlag(args, "--domain");
  const checkoutPath = requiredStringFlag(args, "--path");
  if (!domainId || !checkoutPath) {
    output.error({ what: DOMAIN_BIND_REPO_USAGE });
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await bindRepoResourceToDomain({
      repoRoot,
      domainId,
      checkoutPath,
      runGit,
    });
  } catch (error) {
    output.error({
      what: "Domain repo binding failed",
      why: error.message,
      fix: domainBindRepoRepairHint(error),
    });
    process.exitCode = 1;
    return;
  }

  const { resource } = result;
  output.success(`Repository bound: ${resource.binding.owner}/${resource.binding.repo}`);
  output.keyValues([
    ["Domain", domainId],
    ["Resource", resource.id],
    ["Role", resource.role],
    ["Default branch", resource.binding.default_branch],
    ["Path", resource.binding.local_checkout_path],
  ]);
  printVerboseHint(output);
  process.exitCode = 0;
}

export async function bindRepoResourceToDomain({
  repoRoot = process.cwd(),
  domainId,
  checkoutPath,
  runGit = defaultRunGit,
} = {}) {
  if (!nonEmptyString(domainId)) {
    throw new Error("domain_bind_repo_missing_domain");
  }

  const localCheckoutPath = resolveExistingDirectory(checkoutPath);
  const registry = readDomainRegistry({ repoRoot });
  if (!registry) {
    throw new Error("domain_bind_repo_registry_missing");
  }

  const domain = registry.domains.find((candidate) => candidate.id === domainId);
  if (!domain) {
    throw new Error(`domain_bind_repo_unknown_domain:${domainId}`);
  }

  const existingGitRepo = domain.resources.find((resource) => resource.kind === "git_repo");
  if (existingGitRepo) {
    throw new Error(`domain_bind_repo_existing_git_repo:${existingGitRepo.id}`);
  }

  const binding = deriveGitRepoBindingFromCheckout({
    checkoutPath: localCheckoutPath,
    runGit,
  });
  const resource = {
    id: "git_repo",
    kind: "git_repo",
    role: "primary",
    binding,
  };
  const updatedDomain = {
    ...structuredClone(domain),
    resources: [...domain.resources, resource],
  };
  const nextRegistry = upsertDomainRecord(registry, updatedDomain);
  const registryPath = writeDomainRegistry({ repoRoot }, nextRegistry);

  return {
    domain: nextRegistry.domains.find((candidate) => candidate.id === domainId),
    registry: nextRegistry,
    registryPath,
    resource,
  };
}

export function deriveGitRepoBindingFromCheckout({
  checkoutPath,
  runGit = defaultRunGit,
} = {}) {
  const localCheckoutPath = path.resolve(checkoutPath);
  const remote = runGitResult(runGit, ["remote", "get-url", "origin"], { cwd: localCheckoutPath });
  const remoteUrl = remote.stdout.trim();
  if (!remote.ok || remoteUrl === "") {
    throw new Error("domain_bind_repo_origin_missing");
  }

  const parsedRemote = parseGitHubOriginRemote(remoteUrl);
  if (!parsedRemote) {
    throw new Error(`domain_bind_repo_origin_unparseable:${remoteUrl}`);
  }

  return {
    owner: parsedRemote.owner,
    repo: parsedRemote.repo,
    default_branch: deriveDefaultBranch({ checkoutPath: localCheckoutPath, runGit }),
    local_checkout_path: localCheckoutPath,
  };
}

export function parseGitHubOriginRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) {
    return normalizeGitHubRemoteParts(sshMatch[1], sshMatch[2]);
  }

  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (httpsMatch) {
    return normalizeGitHubRemoteParts(httpsMatch[1], httpsMatch[2]);
  }

  return null;
}

function deriveDefaultBranch({ checkoutPath, runGit }) {
  const symbolic = runGitResult(runGit, ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: checkoutPath });
  const symbolicBranch = parseOriginHeadRef(symbolic.stdout, "refs/remotes/origin/");
  if (symbolic.ok && symbolicBranch) return symbolicBranch;

  const abbrev = runGitResult(runGit, ["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: checkoutPath });
  const abbrevBranch = parseOriginHeadRef(abbrev.stdout, "origin/");
  if (abbrev.ok && abbrevBranch) return abbrevBranch;

  throw new Error("domain_bind_repo_default_branch_ambiguous");
}

function parseOriginHeadRef(value, prefix) {
  const ref = String(value || "").trim();
  if (!ref.startsWith(prefix)) return null;
  const branch = ref.slice(prefix.length);
  if (!branch || branch === "HEAD") return null;
  return branch;
}

function normalizeGitHubRemoteParts(owner, repoWithSuffix) {
  const repo = String(repoWithSuffix || "").replace(/\.git$/, "");
  if (!nonEmptyString(owner) || !nonEmptyString(repo) || repo.includes("/")) {
    return null;
  }
  return { owner, repo };
}

function runGitResult(runGit, args, options) {
  try {
    const result = runGit(args, options) || {};
    return {
      ok: result.ok === true,
      stdout: result.stdout == null ? "" : String(result.stdout),
      stderr: result.stderr == null ? "" : String(result.stderr),
      status: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error?.message || String(error),
      status: null,
    };
  }
}

function resolveExistingDirectory(value) {
  if (!nonEmptyString(value)) {
    throw new Error("domain_bind_repo_missing_path");
  }
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`domain_bind_repo_path_not_directory:${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`domain_bind_repo_path_not_directory:${resolved}`);
  }
  return resolved;
}

function requiredStringFlag(args, name) {
  const fromPrimitive = flagValue(args, name);
  const { flags } = parseCliFlags(args);
  const parsed = flags[name.slice(2)];
  if (!nonEmptyString(parsed) || parsed !== fromPrimitive) return null;
  return parsed.trim();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function domainBindRepoRepairHint(error) {
  const message = error?.message || "";
  if (message.startsWith("domain_bind_repo_path_not_directory") || message === "domain_bind_repo_missing_path") {
    return "Pass --path pointing at an existing local git checkout.";
  }
  if (message === "domain_bind_repo_registry_missing" || message.startsWith("domain_bind_repo_unknown_domain")) {
    return "Run npm run domain:add first, or pass an existing domain id.";
  }
  if (message.startsWith("domain_bind_repo_existing_git_repo")) {
    return "This domain already has a product repo binding; use a different domain or intentionally update the registry.";
  }
  if (message === "domain_bind_repo_origin_missing" || message.startsWith("domain_bind_repo_origin_unparseable")) {
    return "Set origin to a GitHub SSH or HTTPS remote, then retry.";
  }
  if (message === "domain_bind_repo_default_branch_ambiguous") {
    return "Run git remote set-head origin -a in that checkout, then retry.";
  }
  return "Check the domain id and checkout path, then retry.";
}
