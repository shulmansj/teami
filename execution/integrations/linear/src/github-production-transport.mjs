import { spawn } from "node:child_process";

import {
  assertGitHubPromotionEndpointShape,
  createDryRunGitHubTransport,
} from "./github-promotion-client.mjs";
import {
  redactGitHubSecrets,
  scrubGitHubAuthEnv,
} from "./github-secret-hygiene.mjs";

const GITHUB_API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2022-11-28",
]);

export function createProductionGitHubPromotionTransport({
  repoRoot = process.cwd(),
  repoIdentity = null,
  now = () => new Date(),
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  if (repoIdentity?.connection_mode === "real") {
    const pushAuth = repoIdentity.push_auth === "ssh" ? "ssh" : "https";
    return {
      transport: createLocalAmbientGitHubTransport({
        repoRoot,
        now,
        env,
        pushAuth,
        spawnImpl,
      }),
      mode: "local_ambient",
      owner: repoIdentity.repo?.owner ?? null,
      repo: repoIdentity.repo?.repo ?? null,
      defaultBranch: repoIdentity.default_branch ?? null,
      checkoutPath: repoIdentity.checkout_path || repoRoot,
      pushAuth,
      realPushEnabled: repoIdentity.real_push_enabled === true,
    };
  }
  return {
    transport: createDryRunGitHubTransport({ now }),
    mode: "dry_run",
    owner: repoIdentity?.repo?.owner ?? null,
    repo: repoIdentity?.repo?.repo ?? null,
    defaultBranch: repoIdentity?.default_branch ?? null,
    checkoutPath: repoIdentity?.checkout_path || repoRoot,
    pushAuth: repoIdentity?.push_auth === "ssh" ? "ssh" : "https",
    realPushEnabled: false,
  };
}

function createLocalAmbientGitHubTransport({
  repoRoot,
  now,
  env,
  pushAuth,
  spawnImpl,
}) {
  const calls = [];
  return {
    kind: "local_ambient",
    calls,
    async request({ endpointId, method, path, owner, repo, params = {} }) {
      assertGitHubPromotionEndpointShape({ endpointId, method, path });
      calls.push({
        endpointId,
        method,
        path,
        owner,
        repo,
        params: safeCallParams(params),
        at: now().toISOString(),
      });
      await runGh({
        endpointId,
        phase: "auth_status",
        args: ["auth", "status", "--hostname", "github.com"],
        repoRoot,
        env,
        pushAuth,
        spawnImpl,
      });
      const stdout = await runGh({
        endpointId,
        phase: "gh_api",
        args: ghApiArgsForRequest({ endpointId, owner, repo, params }),
        input: ghApiInputForRequest({ endpointId, params }),
        repoRoot,
        env,
        pushAuth,
        spawnImpl,
      });
      return { data: parseGitHubApiResponse({ endpointId, stdout }) };
    },
  };
}

function ghApiArgsForRequest({ endpointId, owner, repo, params = {} }) {
  const pullsPath = `repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls`;
  const common = ["api", "--hostname", "github.com", ...GITHUB_API_HEADERS];
  if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
    const state = endpointId === "list_open_pull_requests" ? "open" : "closed";
    return [
      ...common,
      "--method",
      "GET",
      pullsPath,
      "-f",
      `state=${state}`,
      "-F",
      "per_page=100",
      "--paginate",
      "--slurp",
    ];
  }
  if (endpointId === "get_pull_request") {
    return [
      ...common,
      "--method",
      "GET",
      `${pullsPath}/${encodePathSegment(params.number)}`,
    ];
  }
  if (endpointId === "create_pull_request") {
    return [
      ...common,
      "--method",
      "POST",
      pullsPath,
      "--input",
      "-",
    ];
  }
  if (endpointId === "update_pull_request_body") {
    return [
      ...common,
      "--method",
      "PATCH",
      `${pullsPath}/${encodePathSegment(params.number)}`,
      "--input",
      "-",
    ];
  }
  throw new Error(`github_endpoint_not_allowlisted:${endpointId}`);
}

function ghApiInputForRequest({ endpointId, params = {} }) {
  if (endpointId === "create_pull_request") {
    return JSON.stringify({
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: Boolean(params.draft),
    });
  }
  if (endpointId === "update_pull_request_body") {
    return JSON.stringify({ body: params.body });
  }
  return null;
}

function parseGitHubApiResponse({ endpointId, stdout }) {
  let payload;
  try {
    payload = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    throw new Error(`github_api_request_failed:${endpointId}:malformed_json`);
  }
  if (endpointId === "list_open_pull_requests" || endpointId === "list_closed_pull_requests") {
    if (!Array.isArray(payload) || payload.some((page) => !Array.isArray(page))) {
      throw new Error(`github_api_request_failed:${endpointId}:unexpected_response_shape`);
    }
    return payload.flat();
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error(`github_api_request_failed:${endpointId}:unexpected_response_shape`);
  }
  return payload;
}

function runGh({
  endpointId,
  phase,
  args,
  input = null,
  repoRoot,
  env,
  pushAuth,
  spawnImpl,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...scrubGitHubAuthEnv(env, { pushAuth }),
      GH_PROMPT_DISABLED: "1",
    };
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawnImpl("gh", args, {
        cwd: repoRoot,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(githubApiRequestError({
        endpointId,
        phase,
        code: null,
        signal: null,
        detail: `spawn_failed:${error.message}`,
      }));
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(githubApiRequestError({
        endpointId,
        phase,
        code: null,
        signal: null,
        detail: `spawn_failed:${error.message}`,
      }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(githubApiRequestError({
          endpointId,
          phase,
          code,
          signal,
          detail: stderr.trim() || stdout.trim() || "gh command failed",
        }));
        return;
      }
      resolve(stdout);
    });

    if (child.stdin) {
      if (input !== null) child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function githubApiRequestError({
  endpointId,
  phase,
  code,
  signal,
  detail,
}) {
  const status = code === null || code === undefined
    ? `signal_${signal || "unknown"}`
    : `exit_${code}`;
  return new Error(redactGitHubSecrets(
    `github_api_request_failed:${endpointId}:${phase}:${status}:${detail || "unknown"}`,
  ));
}

function safeCallParams(params = {}) {
  const copy = { ...params };
  if (typeof copy.body === "string") copy.body = `[redacted github body length=${copy.body.length}]`;
  return copy;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}
