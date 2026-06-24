import {
  createDryRunGitHubSetupTransport,
  createRealGitHubSetupTransport,
  readGitHubConnectionState,
  resolveGitHubSetupSettings,
} from "../github-setup.mjs";
import {
  createGitHubTokenBrokerClient,
  writeGitHubBrokerCredential,
} from "../github-token-broker-client.mjs";
function configWithGithubFlags(config, flags = {}) {
  const github = { ...(config.github || {}) };
  if (flags["github-app-slug"]) github.app_slug = flags["github-app-slug"];
  if (flags["github-app-id"]) github.app_id = String(flags["github-app-id"]);
  if (flags["github-broker-url"] || flags["github-broker-token-file"]) {
    github.token_broker = { ...(github.token_broker || {}) };
    if (flags["github-broker-url"]) github.token_broker.base_url = flags["github-broker-url"];
    if (flags["github-broker-token-file"]) github.token_broker.token_file = flags["github-broker-token-file"];
  }
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
  inboxClient = null,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  promptGitHubOwner = undefined,
  resolveAuthenticatedGitHubLogin = undefined,
} = {}) {
  if (githubDryRunRequested(flags)) return createDryRunGitHubSetupTransport();
  const settings = await resolveGitHubSetupSettings({
    config,
    requestedOwner: flags["github-owner"] || null,
    requestedRepoName: flags["github-repo"] || null,
    requestedVisibility: flags["github-visibility"] || null,
    connectionMode: "real",
    isTTY,
    promptGitHubOwner,
    resolveAuthenticatedGitHubLogin,
  });
  if (!settings.ok) return realTransportForSettingsFailure(settings);
  if (typeof inboxClient?.issueBrokerCredential !== "function") {
    throw new Error("github_broker_credential_issue_unavailable: hosted inbox client cannot issue installation-bound broker credentials");
  }
  const issued = await inboxClient.issueBrokerCredential({});
  if (issued?.ok === false) {
    throw new Error(`github_broker_credential_issue_failed: ${issued.reason || issued.error || "unknown"}`);
  }
  const credential = brokerCredentialFromIssueResponse(issued);
  writeGitHubBrokerCredential({
    broker: config?.github?.token_broker || {},
    repoRoot,
    credential,
  });
  onProgress(`GitHub broker credential: installation-bound credential saved for ${settings.fullName}`);
  const brokerClient = createGitHubTokenBrokerClient({ config, repoRoot, fetchImpl });
  return createRealGitHubSetupTransport({ brokerClient, repoRoot });
}

function githubDoctorTransportFromConnection({ config, repoRoot }) {
  const read = readGitHubConnectionState({ repoRoot });
  if (!read.ok || read.connection?.connection_mode !== "real") return null;
  const brokerClient = createGitHubTokenBrokerClient({ config, repoRoot });
  return createRealGitHubSetupTransport({ brokerClient, repoRoot });
}

// Maps a GitHub setup-phase failure reason code to a human, adopter-facing
// title. Shared by both CLI entry points (`init` and the standalone
// `github:init`) so the reason->title contract has a single source of truth.
function githubFailureTitle(reason) {
  return {
    behavior_repo_creation_pending_org_approval: "GitHub repo creation needs org approval",
    behavior_repo_name_collision: "GitHub repo name is already taken",
    github_app_installation_pending_approval: "GitHub App installation needs org approval",
    github_app_not_installed: "GitHub App is not installed",
    github_app_permissions_not_exact: "GitHub App permissions need adjustment",
    github_owner_not_selected: "GitHub owner was not selected",
    initial_push_blocked_token_shaped_content: "Initial GitHub push was blocked",
    setup_grant_revocation_unconfirmed: "GitHub setup grant revocation is unconfirmed",
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
  if (["broker", "real", "live"].includes(transport)) return false;
  // Fail closed: an unknown transport (e.g. a typo like "dryrun") must NOT fall
  // through to the real/live path and create GitHub side effects.
  throw new Error(
    `unknown_github_setup_transport: "${flags["github-setup-transport"]}" — use "dry-run" (rehearsal) or "broker" (real)`,
  );
}

function brokerCredentialFromIssueResponse(payload = {}) {
  const credential =
    payload.brokerCredential ||
    payload.broker_credential ||
    payload.credential ||
    payload.token ||
    payload.githubBrokerCredential ||
    payload.github_broker_credential;
  if (typeof credential !== "string" || credential.trim() === "") {
    throw new Error("github_broker_credential_issue_failed: response did not include a broker credential");
  }
  return credential;
}

function realTransportForSettingsFailure(settings) {
  return {
    kind: "real",
    async request() {
      throw new Error(`github_setup_settings_invalid:${settings.reason || "unknown"}`);
    },
  };
}
