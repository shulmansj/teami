import {
  createDryRunGitHubSetupTransport,
  createLocalAmbientGitHubSetupTransport,
  readGitHubConnectionState,
} from "../github-setup.mjs";
function configWithGithubFlags(config, flags = {}) {
  const github = { ...(config.github || {}) };
  if (flags["github-starter-remote-url"]) {
    const existing = Array.isArray(github.starter_remote_urls) ? github.starter_remote_urls : [];
    github.starter_remote_urls = [...existing, flags["github-starter-remote-url"]];
  }
  return { ...config, github };
}

async function githubSetupTransportFromFlags({
  config,
  flags = {},
  repoRoot,
  onProgress = () => {},
} = {}) {
  if (githubDryRunRequested(flags)) return createDryRunGitHubSetupTransport();
  onProgress("GitHub setup: using local ambient git/gh auth; no GitHub secret will be stored.");
  return createLocalAmbientGitHubSetupTransport({ repoRoot });
}

function githubDoctorTransportFromConnection({ config, repoRoot }) {
  const read = readGitHubConnectionState({ repoRoot });
  if (!read.ok || read.connection?.connection_mode !== "real") return null;
  return createLocalAmbientGitHubSetupTransport({ repoRoot });
}

// Maps a GitHub setup-phase failure reason code to a human, adopter-facing
// title. Shared by both CLI entry points (`init` and the standalone
// `github:init`) so the reason->title contract has a single source of truth.
function githubFailureTitle(reason) {
  return {
    behavior_repo_creation_pending_org_approval: "GitHub repo creation needs org approval",
    behavior_repo_unreachable: "GitHub behavior repo is not reachable",
    github_owner_not_selected: "GitHub owner was not selected",
    initial_push_blocked_token_shaped_content: "Initial GitHub push was blocked",
  }[reason] || "GitHub connection failed";
}

export {
  configWithGithubFlags,
  githubDryRunRequested,
  githubDoctorTransportFromConnection,
  githubFailureTitle,
  githubSetupTransportFromFlags,
};

function githubDryRunRequested(flags = {}) {
  if (flags["github-dry-run"] === true) return true;
  if (!Object.prototype.hasOwnProperty.call(flags, "github-setup-transport")) return false;
  const transport = String(flags["github-setup-transport"] || "").trim().toLowerCase();
  if (["dry-run", "dry_run"].includes(transport)) return true;
  if (["local", "local_ambient", "ambient", "real", "live"].includes(transport)) return false;
  // Fail closed: an unknown transport (e.g. a typo like "dryrun") must NOT fall
  // through to the real/live path and create GitHub side effects.
  throw new Error(
    `unknown_github_setup_transport: "${flags["github-setup-transport"]}" - use "dry-run" (rehearsal) or "local_ambient" (real)`,
  );
}
