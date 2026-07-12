import { runBoundedSubprocess } from "../../git/bounded-subprocess.mjs";
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
  spawnImpl = undefined,
  runSubprocess = runBoundedSubprocess,
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
        runSubprocess,
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
  runSubprocess,
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
        runSubprocess,
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
        runSubprocess,
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

async function runGh({
  endpointId,
  phase,
  args,
  input = null,
  repoRoot,
  env,
  pushAuth,
  spawnImpl,
  runSubprocess,
}) {
  const result = await runSubprocess({
    command: "gh",
    args,
    operation: ghOperation({ phase, args }),
    cwd: repoRoot,
    env: scrubGitHubAuthEnv(env, { pushAuth }),
    input,
    ...(spawnImpl ? { spawnImpl } : {}),
    classifyFailure: ({ stdout, stderr }) => classifyGhFailure(`${stderr}\n${stdout}`),
  });
  if (!result.ok) {
    throw githubApiRequestError({
      endpointId,
      phase,
      code: result.status,
      signal: result.signal,
      detail: result.failureCode || result.outcome,
      reconciliationRequired: result.reconciliationRequired,
    });
  }
  return result.stdout;
}

function githubApiRequestError({
  endpointId,
  phase,
  code,
  signal,
  detail,
  reconciliationRequired = false,
}) {
  const status = code === null || code === undefined
    ? `signal_${signal || "unknown"}`
    : `exit_${code}`;
  const error = new Error(redactGitHubSecrets(
    `github_api_request_failed:${endpointId}:${phase}:${status}:${detail || "unknown"}`,
  ));
  error.code = "github_api_request_failed";
  error.outcome = reconciliationRequired ? "reconciliation_required" : "failed";
  error.reconciliationRequired = reconciliationRequired;
  return error;
}

function ghOperation({ phase, args }) {
  if (phase === "auth_status") return "gh_auth_read";
  const methodIndex = args.indexOf("--method");
  const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
  return ["GET", "HEAD"].includes(String(method || "").toUpperCase())
    ? "gh_api_read"
    : "gh_api_mutation";
}

function classifyGhFailure(output) {
  if (/not found|could not resolve|HTTP 404/i.test(output)) return "not_found";
  if (/authentication|not logged|HTTP 401|HTTP 403/i.test(output)) return "auth_failed";
  if (/rate.?limit|HTTP 429/i.test(output)) return "rate_limited";
  return "gh_command_failed";
}

function safeCallParams(params = {}) {
  const copy = { ...params };
  if (typeof copy.body === "string") copy.body = `[redacted github body length=${copy.body.length}]`;
  return copy;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}
