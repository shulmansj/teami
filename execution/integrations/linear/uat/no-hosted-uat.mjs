import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultRunStoreDir } from "../../../engine/run-store.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { readDomainRegistry } from "../src/domain-registry.mjs";
import { buildDomainContext } from "../src/domain-resolver.mjs";
import { readGitHubConnectionState, resolveBehaviorRepoIdentity } from "../src/github-setup.mjs";
import { redactGitHubSecrets } from "../src/github-secret-hygiene.mjs";
import { createLinearCredentialStore } from "../src/linear-credential-store.mjs";
import {
  DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
  assertGitHubLocalUatBinding,
  githubLocalUatBranchName,
  runGitHubLocalUat,
} from "./github-local-uat.mjs";
import {
  DEFAULT_CONSECUTIVE_COMMITS,
  DEFAULT_POLL_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UAT_PREFIX,
  NO_LINEAR_DOMAIN_MESSAGE,
  runGatewayUat,
  selectUatDomain,
} from "./gateway-uat.mjs";
import {
  assertHostedSurfaceFilesRemoved,
  assertNoHostedConfiguration,
  assertNoHostedEndpointReferences,
  NoHostedAssertionError,
  scanHostedEndpointReferences,
} from "./no-hosted-assertions.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const DEFAULT_NO_HOSTED_PREFIX = "AF-NO-HOSTED-UAT";

class NoHostedUatUserError extends Error {
  constructor(message, code = "uat_user_error") {
    super(message);
    this.name = "NoHostedUatUserError";
    this.code = code;
  }
}

export function parseNoHostedUatArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repoRoot: path.resolve(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_REPO_ROOT
        || env.AGENTIC_FACTORY_UAT_REPO_ROOT
        || REPO_ROOT,
    ),
    domainId: env.AGENTIC_FACTORY_NO_HOSTED_UAT_DOMAIN || env.AGENTIC_FACTORY_UAT_DOMAIN || null,
    prefix: env.AGENTIC_FACTORY_NO_HOSTED_UAT_PREFIX || env.AGENTIC_FACTORY_UAT_PREFIX || DEFAULT_NO_HOSTED_PREFIX,
    consecutive: parsePositiveInteger(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_CONSECUTIVE || env.AGENTIC_FACTORY_UAT_CONSECUTIVE,
      DEFAULT_CONSECUTIVE_COMMITS,
    ),
    pollIntervalMs: parsePositiveInteger(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_POLL_INTERVAL_MS || env.AGENTIC_FACTORY_UAT_POLL_INTERVAL_MS,
      null,
    ),
    pollGraceMs: parsePositiveInteger(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_POLL_GRACE_MS || env.AGENTIC_FACTORY_UAT_POLL_GRACE_MS,
      DEFAULT_POLL_GRACE_MS,
    ),
    timeoutMs: parsePositiveInteger(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_TIMEOUT_MS || env.AGENTIC_FACTORY_UAT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    workspaceDir: env.AGENTIC_FACTORY_NO_HOSTED_UAT_WORKSPACE_DIR
      ? path.resolve(env.AGENTIC_FACTORY_NO_HOSTED_UAT_WORKSPACE_DIR)
      : env.AGENTIC_FACTORY_GITHUB_LOCAL_UAT_WORKSPACE_DIR
        ? path.resolve(env.AGENTIC_FACTORY_GITHUB_LOCAL_UAT_WORKSPACE_DIR)
        : null,
    branchPrefix: env.AGENTIC_FACTORY_NO_HOSTED_UAT_BRANCH_PREFIX
      || env.AGENTIC_FACTORY_GITHUB_LOCAL_UAT_BRANCH_PREFIX
      || DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
    keepArtifacts: truthy(
      env.AGENTIC_FACTORY_NO_HOSTED_UAT_KEEP_ARTIFACTS
        || env.AGENTIC_FACTORY_UAT_KEEP_ARTIFACTS
        || env.AGENTIC_FACTORY_GITHUB_LOCAL_UAT_KEEP_ARTIFACTS,
    ),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--domain") {
      options.domainId = requireNext(argv, ++index, arg);
    } else if (arg === "--prefix") {
      options.prefix = requireNext(argv, ++index, arg);
    } else if (arg === "--consecutive") {
      options.consecutive = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_CONSECUTIVE_COMMITS);
    } else if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = parsePositiveInteger(requireNext(argv, ++index, arg), null);
    } else if (arg === "--poll-grace-ms") {
      options.pollGraceMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_POLL_GRACE_MS);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(requireNext(argv, ++index, arg), DEFAULT_TIMEOUT_MS);
    } else if (arg === "--workspace-dir") {
      options.workspaceDir = path.resolve(requireNext(argv, ++index, arg));
    } else if (arg === "--branch-prefix") {
      options.branchPrefix = requireNext(argv, ++index, arg);
    } else if (arg === "--keep-artifacts") {
      options.keepArtifacts = true;
    } else {
      throw new NoHostedUatUserError(`unknown uat:no-hosted flag: ${arg}`, "usage");
    }
  }

  githubLocalUatBranchName({ branchPrefix: options.branchPrefix, stamp: "validate" });
  return options;
}

export function buildNoHostedUatUsage() {
  return [
    "Usage: npm run uat:no-hosted -- [--domain <id>] [--repo-root <path>] [--keep-artifacts]",
    "                               [--prefix AF-NO-HOSTED-UAT] [--consecutive 2]",
    "                               [--poll-interval-ms 10000] [--timeout-ms 600000]",
    "                               [--workspace-dir <path>] [--branch-prefix af-uat-github-local]",
    "",
    "Live prerequisites:",
    "- The selected Linear domain is authenticated locally and points at a disposable test team.",
    "- The behavior repo is bound as a real local_ambient GitHub connection.",
    "- Local git and gh auth can push a disposable branch and open a PR.",
    "",
    "Environment equivalents:",
    "- AGENTIC_FACTORY_NO_HOSTED_UAT_DOMAIN or AGENTIC_FACTORY_UAT_DOMAIN selects the Linear domain.",
    "- AGENTIC_FACTORY_NO_HOSTED_UAT_REPO_ROOT or AGENTIC_FACTORY_UAT_REPO_ROOT selects the checkout.",
    "- AGENTIC_FACTORY_NO_HOSTED_UAT_KEEP_ARTIFACTS=1 keeps disposable artifacts where child harnesses allow it.",
  ].join("\n");
}

export async function runNoHostedUat(options = parseNoHostedUatArgs()) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const preflight = assertNoHostedPreconditions({ repoRoot });
  const prerequisites = await assertNoHostedLivePrerequisites({
    repoRoot,
    domainId: options.domainId,
    branchPrefix: options.branchPrefix,
  });
  const beforeRunFiles = snapshotRunEvidenceFiles({ repoRoot });
  const report = {
    ok: false,
    repoRoot,
    noHostedPreflight: preflight,
    prerequisites,
    gateway: null,
    github: null,
    evidenceScan: null,
  };

  const gateway = await runGatewayUat({
    repoRoot,
    domainId: options.domainId,
    prefix: options.prefix || DEFAULT_UAT_PREFIX,
    consecutive: options.consecutive,
    pollIntervalMs: options.pollIntervalMs,
    pollGraceMs: options.pollGraceMs,
    timeoutMs: options.timeoutMs,
    keepArtifacts: options.keepArtifacts,
  });
  report.gateway = summarizeGatewayReport(gateway);

  const github = await runGitHubLocalUat({
    repoRoot,
    workspaceDir: options.workspaceDir,
    branchPrefix: options.branchPrefix,
    keepArtifacts: options.keepArtifacts,
  });
  report.github = summarizeGitHubReport(github);

  assertNoHostedEndpointReferences({ gateway: report.gateway, github: report.github }, { label: "uat_report" });
  assertNoHostedPreconditions({ repoRoot });
  const afterRunFiles = snapshotRunEvidenceFiles({ repoRoot });
  const changedFiles = changedRunEvidenceFiles(beforeRunFiles, afterRunFiles);
  report.evidenceScan = scanRunEvidenceFiles({ files: changedFiles });
  if (!report.evidenceScan.ok) {
    throw new NoHostedAssertionError(
      `hosted_endpoint_reference_detected:${report.evidenceScan.findings
        .map((finding) => `${finding.path}:${finding.id}`)
        .join(",")}`,
      report.evidenceScan.findings,
    );
  }

  report.ok = true;
  return report;
}

export async function assertNoHostedLivePrerequisites({
  repoRoot = process.cwd(),
  domainId = null,
  branchPrefix = DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
} = {}) {
  const config = loadLinearConfig({ repoRoot });
  const registry = readDomainRegistry({ repoRoot });
  const domain = selectUatDomain({ registry, domainId });
  const domainContext = buildDomainContext({ domain, config, repoRoot });
  const credentialStore = createLinearCredentialStore({ config, repoRoot, domainContext });
  let tokenSet = null;
  try {
    tokenSet = await credentialStore.readTokenSet();
  } catch {
    throw new NoHostedUatUserError(NO_LINEAR_DOMAIN_MESSAGE, "no_linear_credential");
  }
  if (!tokenSet?.refreshToken && !tokenSet?.accessToken) {
    throw new NoHostedUatUserError(NO_LINEAR_DOMAIN_MESSAGE, "no_linear_credential");
  }

  githubLocalUatBranchName({ branchPrefix, stamp: "validate" });
  const github = assertGitHubLocalUatBinding(
    resolveBehaviorRepoIdentity({ repoRoot }),
    { repoRoot },
  );

  return {
    ok: true,
    domainId: domain.id,
    github: {
      owner: github.repo.owner,
      repo: github.repo.repo,
      defaultBranch: github.default_branch,
      pushAuth: github.push_auth,
    },
  };
}

export function assertNoHostedPreconditions({ repoRoot = process.cwd() } = {}) {
  const config = loadLinearConfig({ repoRoot });
  const domainRegistry = readDomainRegistry({ repoRoot });
  const githubConnectionRead = readGitHubConnectionState({ repoRoot });
  const githubConnection = githubConnectionRead.ok ? githubConnectionRead.connection : null;
  assertNoHostedConfiguration({ config, domainRegistry, githubConnection });
  assertHostedSurfaceFilesRemoved({ repoRoot });
  return {
    ok: true,
    configLoaded: true,
    domainRegistryLoaded: Boolean(domainRegistry),
    githubConnectionLoaded: githubConnectionRead.ok,
    githubConnectionReason: githubConnectionRead.ok ? null : githubConnectionRead.reason,
  };
}

function snapshotRunEvidenceFiles({ repoRoot = process.cwd() } = {}) {
  const runStoreDir = defaultRunStoreDir(repoRoot);
  if (!fs.existsSync(runStoreDir)) return new Map();
  const files = new Map();
  for (const filePath of listFilesRecursive(runStoreDir)) {
    const stats = fs.statSync(filePath);
    files.set(filePath, {
      path: filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }
  return files;
}

function changedRunEvidenceFiles(before, after) {
  const changed = [];
  for (const [filePath, current] of after.entries()) {
    const previous = before.get(filePath);
    if (!previous || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
      changed.push(filePath);
    }
  }
  return changed.sort();
}

function scanRunEvidenceFiles({ files }) {
  const findings = [];
  for (const filePath of files) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      findings.push({
        id: "run_evidence_unreadable",
        path: filePath,
        reason: error.message,
      });
      continue;
    }
    const scan = scanHostedEndpointReferences(text, { label: filePath });
    findings.push(...scan.findings);
  }
  return { ok: findings.length === 0, findings, files };
}

function listFilesRecursive(dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function summarizeGatewayReport(report = {}) {
  return {
    ok: report.ok === true,
    domainId: report.domainId,
    prefix: report.prefix,
    createdProjectCount: Array.isArray(report.createdProjects) ? report.createdProjects.length : 0,
    scenarios: Array.isArray(report.scenarios)
      ? report.scenarios.map((scenario) => ({
        ok: scenario.ok === true,
        name: scenario.name,
        projectId: scenario.projectId ?? null,
        runId: scenario.runId ?? null,
        artifactKind: scenario.artifactKind ?? null,
        terminalStatus: scenario.terminalStatus ?? null,
      }))
      : [],
    cleanup: report.cleanup ?? null,
  };
}

function summarizeGitHubReport(report = {}) {
  return {
    ok: report.ok === true,
    runId: report.runId ?? null,
    branch: report.branch ?? null,
    pr: report.pr ?? null,
    evidencePath: report.evidencePath ?? null,
    cleanup: report.cleanup ?? null,
    logs: report.logs ?? [],
  };
}

function parsePositiveInteger(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new NoHostedUatUserError(`expected a positive integer, got ${value}`, "usage");
  }
  return parsed;
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new NoHostedUatUserError(`${flag} requires a value`, "usage");
  return value;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export async function main({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  exit = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let options;
  try {
    options = parseNoHostedUatArgs(argv);
  } catch (error) {
    stderr(error.message);
    exit(2);
    return { ok: false, stage: "usage", error };
  }

  if (options.help) {
    stdout(buildNoHostedUatUsage());
    exit(0);
    return { ok: true, stage: "help" };
  }

  try {
    const report = await runNoHostedUat(options);
    stdout("PASS no-hosted config and source surface");
    for (const scenario of report.gateway.scenarios) {
      stdout(`PASS gateway ${scenario.name}`);
    }
    stdout(`PASS github local PR #${report.github.pr?.number}: ${report.github.pr?.url}`);
    stdout(`PASS hosted endpoint scan (${report.evidenceScan.files.length} changed run evidence file(s))`);
    stdout("NO-HOSTED UAT PASS");
    exit(0);
    return { ok: true, report };
  } catch (error) {
    const safeMessage = redactGitHubSecrets(error?.message || String(error));
    stderr(error?.code === "hosted_surface_detected"
      ? `NO-HOSTED UAT FAIL: ${safeMessage}`
      : safeMessage.startsWith("NO-HOSTED UAT FAIL:")
        ? safeMessage
        : `NO-HOSTED UAT FAIL: ${safeMessage}`);
    exit(error instanceof NoHostedUatUserError && error.code === "usage" ? 2 : 1);
    return { ok: false, stage: "run", error };
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(redactGitHubSecrets(`NO-HOSTED UAT FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
