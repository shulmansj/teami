import path from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const CLAUDE_PLUGIN_READ_RETRY_DELAYS_MS = Object.freeze([250, 750, 2_000, 5_000]);
const CLAUDE_PLUGIN_READ_COMMAND_TIMEOUT_MS = 10_000;

export async function readClaudePluginHealth({
  repoRoot = process.cwd(),
  runCommand,
  pluginName = "teami",
  packageName = "@shulmansj/teami",
  marketplaceName = "teami",
  marketplaceSource,
  scope = "user",
  readRetryDelaysMs = CLAUDE_PLUGIN_READ_RETRY_DELAYS_MS,
} = {}) {
  let retryDelaysMs;
  try {
    retryDelaysMs = normalizedRetryDelays(readRetryDelaysMs);
  } catch {
    return failure("claude_plugin_read_policy_invalid", "Claude plugin health retry policy is invalid");
  }
  const marketplace = await readTrustedMarketplace({
    repoRoot,
    runCommand,
    marketplaceName,
    marketplaceSource,
    retryDelaysMs,
  });
  if (!marketplace.ok) return marketplace;

  const listed = await runClaudePluginReadCommand({
    runCommand,
    repoRoot,
    args: ["plugin", "list", "--json"],
    retryDelaysMs,
  });
  if (!listed.ok) return failure("claude_plugin_list_failed", safeClaudeCliDetail(listed));

  let candidates;
  try {
    candidates = flattenClaudePluginListPayload(JSON.parse(String(listed.stdout || "").trim() || "[]"));
  } catch (error) {
    return failure("claude_plugin_list_invalid_json", error.message);
  }
  const expectedId = `${pluginName}@${marketplaceName}`;
  const plugin = candidates.find((candidate) => claudePluginId(candidate) === expectedId) || null;
  if (!plugin) {
    const collision = candidates.find((candidate) => claudePluginBaseName(candidate) === pluginName);
    return collision
      ? failure("claude_plugin_identity_mismatch", `installed plugin identity is ${claudePluginId(collision) || "missing"}; expected ${expectedId}`)
      : failure("claude_plugin_missing", `installed plugin ${expectedId} was not present in Claude's read-back`);
  }
  const contract = validateInstalledClaudePlugin({ plugin, pluginName, packageName, marketplaceName, scope });
  if (!contract.ok) return failure("claude_plugin_launch_contract_mismatch", contract.detail);
  return {
    ok: true,
    status: "healthy",
    plugin_id: expectedId,
    version: contract.version,
    marketplace: marketplace.marketplace,
  };
}

export async function ensureTrustedClaudeMarketplace({
  repoRoot = process.cwd(),
  runCommand,
  marketplaceName = "teami",
  marketplaceSource,
  scope = "user",
  readRetryDelaysMs = CLAUDE_PLUGIN_READ_RETRY_DELAYS_MS,
} = {}) {
  let retryDelaysMs;
  try {
    retryDelaysMs = normalizedRetryDelays(readRetryDelaysMs);
  } catch {
    return failure("claude_plugin_read_policy_invalid", "Claude plugin health retry policy is invalid");
  }
  let current = await readTrustedMarketplace({
    repoRoot,
    runCommand,
    marketplaceName,
    marketplaceSource,
    retryDelaysMs,
  });
  if (current.ok) {
    const updated = await runClaudePluginCommand({
      runCommand,
      repoRoot,
      args: ["plugin", "marketplace", "update", marketplaceName],
    });
    if (!updated.ok) return failure("claude_plugin_marketplace_update_failed", safeClaudeCliDetail(updated));
    current = await readTrustedMarketplace({
      repoRoot,
      runCommand,
      marketplaceName,
      marketplaceSource,
      retryDelaysMs,
    });
    return current.ok ? { ...current, status: "updated" } : current;
  }
  if (current.reason !== "claude_plugin_marketplace_missing") return current;

  const added = await runClaudePluginCommand({
    runCommand,
    repoRoot,
    args: ["plugin", "marketplace", "add", marketplaceSource, "--scope", scope],
  });
  if (!added.ok) {
    // A concurrent add is safe only if read-back proves the exact trusted identity.
    const raced = await readTrustedMarketplace({
      repoRoot,
      runCommand,
      marketplaceName,
      marketplaceSource,
      retryDelaysMs,
    });
    if (!raced.ok) {
      return failure("claude_plugin_marketplace_add_failed", safeClaudeCliDetail(added) || raced.detail);
    }
    return { ...raced, status: "existing" };
  }
  const verified = await readTrustedMarketplace({
    repoRoot,
    runCommand,
    marketplaceName,
    marketplaceSource,
    retryDelaysMs,
  });
  return verified.ok ? { ...verified, status: "added" } : verified;
}

async function readTrustedMarketplace({
  repoRoot,
  runCommand,
  marketplaceName,
  marketplaceSource,
  retryDelaysMs = CLAUDE_PLUGIN_READ_RETRY_DELAYS_MS,
} = {}) {
  const listed = await runClaudePluginReadCommand({
    runCommand,
    repoRoot,
    args: ["plugin", "marketplace", "list", "--json"],
    retryDelaysMs,
  });
  if (!listed.ok) return failure("claude_plugin_marketplace_list_failed", safeClaudeCliDetail(listed));
  let entries;
  try {
    const parsed = JSON.parse(String(listed.stdout || "").trim() || "[]");
    entries = Array.isArray(parsed) ? parsed : arrayField(parsed.marketplaces);
  } catch (error) {
    return failure("claude_plugin_marketplace_list_invalid_json", error.message);
  }
  const marketplace = entries.find((entry) => entry?.name === marketplaceName) || null;
  if (!marketplace) return failure("claude_plugin_marketplace_missing", `marketplace ${marketplaceName} is not registered`);
  if (!marketplaceMatchesSource(marketplace, marketplaceSource)) {
    return failure(
      "claude_plugin_marketplace_source_mismatch",
      `marketplace ${marketplaceName} is registered from an untrusted source; remove the collision before setup`,
    );
  }
  return { ok: true, status: "trusted", marketplace: publicMarketplaceIdentity(marketplace) };
}

function marketplaceMatchesSource(marketplace, expectedSource) {
  const expected = String(expectedSource || "").trim();
  if (!expected) return false;
  const github = githubRepoCoordinate(expected);
  if (github) {
    const actualRepo = String(marketplace.repo || marketplace.repository || "").replace(/\.git$/i, "");
    if (actualRepo.toLowerCase() === github.toLowerCase()) return true;
    const actualUrl = String(marketplace.url || marketplace.sourceUrl || "").replace(/\.git$/i, "");
    return githubRepoCoordinate(actualUrl)?.toLowerCase() === github.toLowerCase();
  }
  const actualPath = marketplace.path || marketplace.directory ||
    (marketplace.source === "directory" ? marketplace.installLocation : null);
  return typeof actualPath === "string" && path.resolve(actualPath) === path.resolve(expected);
}

function githubRepoCoordinate(value) {
  const match = String(value || "").match(/^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : null;
}

function publicMarketplaceIdentity(marketplace) {
  return {
    name: marketplace.name,
    source: marketplace.source || null,
    ...(marketplace.repo ? { repo: marketplace.repo } : {}),
    ...(marketplace.path ? { path: marketplace.path } : {}),
  };
}

function validateInstalledClaudePlugin({ plugin, pluginName, packageName, marketplaceName, scope }) {
  const expectedId = `${pluginName}@${marketplaceName}`;
  if (claudePluginId(plugin) !== expectedId) {
    return { ok: false, detail: `installed plugin identity must be exactly ${expectedId}` };
  }
  if (plugin.enabled !== true) return { ok: false, detail: "installed plugin is not enabled" };
  if (plugin.scope !== scope) {
    return { ok: false, detail: `installed plugin scope is ${plugin.scope || "missing"}; expected ${scope}` };
  }
  const version = typeof plugin.version === "string" ? plugin.version.trim() : "";
  if (!SEMVER.test(version)) return { ok: false, detail: "installed plugin version is missing or not concrete" };
  const server = plugin.mcpServers?.[pluginName];
  const expectedArgs = ["-y", `${packageName}@${version}`, "mcp"];
  if (server?.command !== "npx" || JSON.stringify(server?.args) !== JSON.stringify(expectedArgs)) {
    return {
      ok: false,
      detail: `installed plugin MCP launch must be npx ${expectedArgs.join(" ")} with no publication placeholder`,
    };
  }
  return { ok: true, version };
}

function claudePluginId(candidate) {
  if (typeof candidate === "string") return candidate.trim();
  if (!candidate || typeof candidate !== "object") return "";
  const value = candidate.id || candidate.ref || candidate.plugin || candidate.package || "";
  return typeof value === "string" ? value.trim() : "";
}

function claudePluginBaseName(candidate) {
  const id = claudePluginId(candidate);
  if (id) return id.split("@")[0];
  return typeof candidate?.name === "string" ? candidate.name.trim() : "";
}

function flattenClaudePluginListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  return [
    ...arrayField(payload.plugins),
    ...arrayField(payload.installed),
    ...arrayField(payload.installedPlugins),
    ...arrayField(payload.user),
    ...arrayField(payload.project),
    ...arrayField(payload.local),
  ];
}

function arrayField(value) {
  return Array.isArray(value) ? value : [];
}

async function runClaudePluginCommand({ runCommand, repoRoot, args, timeoutMs = null } = {}) {
  if (typeof runCommand !== "function") return failure("claude_plugin_command_unavailable", "Claude command runner is unavailable");
  try {
    const result = await runCommand("claude", args, {
      cwd: repoRoot,
      ...(timeoutMs === null ? {} : { timeoutMs }),
    });
    const status = Number.isInteger(result?.status) ? result.status : result?.ok === true ? 0 : 1;
    return {
      ok: result?.ok === true || status === 0,
      status,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      timedOut: result?.timedOut === true,
      outputTruncated: result?.outputTruncated === true,
    };
  } catch (error) {
    return { ok: false, status: 1, stdout: "", stderr: error.message };
  }
}

async function runClaudePluginReadCommand(options = {}) {
  let retryDelaysMs;
  try {
    retryDelaysMs = normalizedRetryDelays(options.retryDelaysMs);
  } catch {
    return { ok: false, status: 1, stdout: "", stderr: "Claude plugin health retry policy is invalid" };
  }
  const commandOptions = { ...options, timeoutMs: CLAUDE_PLUGIN_READ_COMMAND_TIMEOUT_MS };
  let result = await runClaudePluginCommand(commandOptions);
  for (const delayMs of retryDelaysMs) {
    if (!claudeReadShouldRetry(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await runClaudePluginCommand(commandOptions);
  }
  return result;
}

function claudeReadShouldRetry(result) {
  if (result.ok || result.timedOut || result.outputTruncated) return false;
  return !/command could not start/i.test(String(result.stderr || ""));
}

function normalizedRetryDelays(value) {
  const delays = value ?? CLAUDE_PLUGIN_READ_RETRY_DELAYS_MS;
  if (!Array.isArray(delays) || delays.length > 8 || delays.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 10_000)) {
    throw new Error("claude_plugin_read_retry_delays_invalid");
  }
  return delays;
}

function failure(reason, detail = "") {
  return { ok: false, status: "blocked", reason, ...(detail ? { detail } : {}) };
}

function safeClaudeCliDetail(result = null) {
  const text = String(result?.stderr || result?.stdout || "").trim();
  if (!text) return "";
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|secret|authorization)=\S+/gi, (match) => `${match.split("=")[0]}=[redacted]`)
    .slice(0, 500);
}
