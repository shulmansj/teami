import os from "node:os";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const DOMAIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function resolveTeamiHome({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir,
} = {}) {
  const pathApi = pathApiForPlatform(platform);
  const home = readHomedir(homedir);
  const teamiHome = stringEnv(env, "TEAMI_HOME");
  const expandedTeamiHome = expandTildeHome(teamiHome, { pathApi, home });
  if (expandedTeamiHome && pathApi.isAbsolute(expandedTeamiHome)) {
    return pathApi.normalize(expandedTeamiHome);
  }

  if (platform === "darwin") {
    return absoluteJoin(path.posix, home, "Library", "Application Support", "teami");
  }

  if (platform === "win32") {
    const localAppData = absoluteEnvPath(path.win32, env, "LOCALAPPDATA");
    if (localAppData) return path.win32.join(localAppData, "teami");

    const appData = absoluteEnvPath(path.win32, env, "APPDATA");
    if (appData) return path.win32.join(appData, "teami");

    return absoluteJoin(path.win32, home, ".teami");
  }

  const xdgStateHome = absoluteEnvPath(path.posix, env, "XDG_STATE_HOME");
  if (xdgStateHome) return path.posix.join(xdgStateHome, "teami");

  if (home && path.posix.isAbsolute(home)) {
    return path.posix.join(home, ".local", "state", "teami");
  }

  return absoluteJoin(path.posix, home, ".teami");
}

export function teamiHomePaths({ home = resolveTeamiHome(), domainId = null } = {}) {
  const pathApi = pathApiForHome(home);
  const paths = {
    home,
    registryPath: pathApi.join(home, "domains.json"),
    gatewayLockPath: pathApi.join(home, "gateway.lock"),
    githubConnectionPath: pathApi.join(home, "github-connection.json"),
    behaviorMirrorDir: pathApi.join(home, "behavior-mirror"),
    runtimeDir: pathApi.join(home, "runtime"),
    phoenixDataDir: pathApi.join(home, "phoenix-data"),
    domainDir: null,
    domainCachePath: null,
  };

  if (domainId === null) return paths;
  if (typeof domainId !== "string" || !DOMAIN_ID_PATTERN.test(domainId)) {
    throw new Error(`invalid_domain_id:${String(domainId)}`);
  }

  paths.domainDir = pathApi.join(home, "domains", domainId);
  paths.domainCachePath = pathApi.join(paths.domainDir, "linear.json");
  return paths;
}

export function resolvePackagedDefault(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("invalid_packaged_default_path");
  }
  if (path.isAbsolute(relPath) || path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw new Error(`packaged_default_path_must_be_relative:${relPath}`);
  }
  if (relPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`packaged_default_path_traversal:${relPath}`);
  }

  return path.resolve(PACKAGE_ROOT, relPath);
}

function pathApiForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathApiForHome(home) {
  if (typeof home === "string" && (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\"))) {
    return path.win32;
  }
  return path.posix;
}

function stringEnv(env, key) {
  let value;
  try {
    value = env?.[key];
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function absoluteEnvPath(pathApi, env, key) {
  const value = stringEnv(env, key);
  if (!value || !pathApi.isAbsolute(value)) return null;
  return pathApi.normalize(value);
}

function expandTildeHome(value, { pathApi, home }) {
  if (!value) return null;
  if (value === "~") return home || value;
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
  if (!home || !pathApi.isAbsolute(home)) return value;
  return pathApi.join(home, value.slice(2));
}

function readHomedir(homedir) {
  try {
    const value = typeof homedir === "function" ? homedir() : homedir;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function absoluteJoin(pathApi, root, ...parts) {
  if (root && pathApi.isAbsolute(root)) return pathApi.join(root, ...parts);
  const fallbackRoot = pathApi === path.win32 ? "C:\\" : "/";
  return pathApi.join(fallbackRoot, ...parts);
}
