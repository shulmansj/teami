import fs from "node:fs";
import path from "node:path";

export const HOSTED_SURFACE_SPECS = Object.freeze([
  Object.freeze({
    id: "hosted_inbox_client",
    relativePath: path.join("execution", "integrations", "linear", "src", "hosted-inbox-client.mjs"),
    mode: "absent",
  }),
  Object.freeze({
    id: "github_token_broker_client",
    relativePath: path.join("execution", "integrations", "linear", "src", "github-token-broker-client.mjs"),
    mode: "absent",
  }),
  Object.freeze({
    id: "hosted_inbox_edge_function",
    relativePath: path.join("supabase", "functions", "teami-inbox"),
    mode: "absent",
  }),
  Object.freeze({
    id: "github_broker_edge_function",
    relativePath: path.join("supabase", "functions", "teami-github-broker"),
    mode: "absent",
  }),
  Object.freeze({
    id: "supabase_edge_functions",
    relativePath: path.join("supabase", "functions"),
    mode: "absent_or_empty_dir",
  }),
]);

const HOSTED_ENDPOINT_PATTERNS = Object.freeze([
  Object.freeze({
    id: "supabase_functions_url",
    pattern: /https?:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[^\s"'<>)]*/i,
  }),
  Object.freeze({
    id: "teami_hosted_endpoint_url",
    pattern: /https?:\/\/[^\s"'<>)]*(?:teami-(?:inbox|github-broker)|hosted-inbox|github-token-broker)[^\s"'<>)]*/i,
  }),
  Object.freeze({
    id: "supabase_functions_endpoint_path",
    pattern: /\bfunctions\/v1\/(?:teami-inbox|teami-github-broker)\b/i,
  }),
  Object.freeze({
    id: "hosted_inbox_endpoint",
    pattern: /\bteami-inbox\b/i,
  }),
  Object.freeze({
    id: "github_broker_endpoint",
    pattern: /\bteami-github-broker\b/i,
  }),
  Object.freeze({
    id: "hosted_inbox_client_reference",
    pattern: /\bhosted-inbox-client(?:\.mjs)?\b/i,
  }),
  Object.freeze({
    id: "github_token_broker_client_reference",
    pattern: /\bgithub-token-broker-client(?:\.mjs)?\b/i,
  }),
]);

const HOSTED_INBOX_KEYS = new Set([
  "hosted",
  "hosted_inbox",
  "inbox",
  "inbox_base_url",
  "inbox_endpoint",
  "inbox_url",
  "runner_inbox",
  "runner_inbox_url",
  "webhook_endpoint",
  "webhook_secret",
  "webhook_url",
]);

const GITHUB_BROKER_OR_APP_KEYS = new Set([
  "app",
  "app_id",
  "app_installation_id",
  "app_private_key",
  "app_slug",
  "broker",
  "broker_base_url",
  "broker_credential",
  "broker_token",
  "broker_url",
  "github_app",
  "github_broker",
  "github_token_broker",
  "installation_id",
  "installation_token",
  "private_key",
  "token_broker",
  "token_broker_url",
]);

class NoHostedAssertionError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = "NoHostedAssertionError";
    this.code = "hosted_surface_detected";
    this.findings = findings;
  }
}

export { NoHostedAssertionError };

export function scanHostedEndpointReferences(value, { label = "records" } = {}) {
  const findings = [];
  visitRecord(value, [label], ({ path: recordPath, value: leaf }) => {
    if (typeof leaf !== "string") return;
    for (const { id, pattern } of HOSTED_ENDPOINT_PATTERNS) {
      const match = pattern.exec(leaf);
      if (!match) continue;
      findings.push({
        id,
        path: recordPath.join("."),
        excerpt: excerptForMatch(leaf, match.index, match[0].length),
      });
    }
  });
  return { ok: findings.length === 0, findings };
}

export function assertNoHostedEndpointReferences(value, { label = "records" } = {}) {
  const scan = scanHostedEndpointReferences(value, { label });
  if (scan.ok) return true;
  throw new NoHostedAssertionError(
    `hosted_endpoint_reference_detected:${formatFindings(scan.findings)}`,
    scan.findings,
  );
}

export function findHostedConfigurationFindings({
  config = null,
  domainRegistry = null,
  githubConnection = null,
} = {}) {
  const surfaces = [
    { label: "config", value: config, source: "config" },
    { label: "domain_registry", value: domainRegistry, source: "domain_registry" },
    { label: "github_connection", value: githubConnection, source: "github_connection" },
  ];
  const findings = [];
  for (const surface of surfaces) {
    if (surface.value === null || surface.value === undefined) continue;
    findings.push(...findHostedKeyFindings(surface));
    findings.push(...scanHostedEndpointReferences(surface.value, { label: surface.label }).findings);
  }
  return findings;
}

export function assertNoHostedConfiguration(input = {}) {
  const findings = findHostedConfigurationFindings(input);
  if (findings.length === 0) return true;
  throw new NoHostedAssertionError(
    `hosted_configuration_detected:${formatFindings(findings)}`,
    findings,
  );
}

export function findHostedSurfaceFiles({
  repoRoot = process.cwd(),
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const findings = [];
  for (const spec of HOSTED_SURFACE_SPECS) {
    const filePath = path.resolve(repoRoot, spec.relativePath);
    if (!existsSync(filePath)) continue;
    if (spec.mode === "absent_or_empty_dir") {
      let stats = null;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }
      if (stats.isDirectory?.()) {
        const entries = readdirSync(filePath);
        if (entries.length === 0) continue;
      }
    }
    findings.push({
      id: spec.id,
      path: spec.relativePath.replace(/\\/g, "/"),
      reason: "hosted_surface_file_present",
    });
  }
  return findings;
}

export function assertHostedSurfaceFilesRemoved(input = {}) {
  const findings = findHostedSurfaceFiles(input);
  if (findings.length === 0) return true;
  throw new NoHostedAssertionError(
    `hosted_surface_files_present:${formatFindings(findings)}`,
    findings,
  );
}

function findHostedKeyFindings({ label, value, source }) {
  const findings = [];
  visitRecord(value, [label], ({ path: recordPath, key, value: leaf }) => {
    if (!key) return;
    const normalizedKey = normalizeKey(key);
    const normalizedPath = recordPath.map(normalizeKey);
    const pathText = normalizedPath.join(".");

    if (normalizedKey === "webhook_id") {
      if (hasMeaningfulValue(leaf)) {
        findings.push({
          id: "hosted_linear_webhook_id",
          path: recordPath.join("."),
          reason: "domain_state_has_legacy_webhook_id",
        });
      }
      return;
    }

    if (HOSTED_INBOX_KEYS.has(normalizedKey) && shouldRejectKey({ source, normalizedKey, value: leaf })) {
      findings.push({
        id: "hosted_inbox_config_key",
        path: recordPath.join("."),
        reason: `hosted_inbox_key:${normalizedKey}`,
      });
      return;
    }

    const githubScoped = pathText.includes(".github.") || pathText.endsWith(".github")
      || source === "github_connection";
    if (
      githubScoped
      && (GITHUB_BROKER_OR_APP_KEYS.has(normalizedKey) || normalizedKey.includes("broker"))
      && shouldRejectKey({ source, normalizedKey, value: leaf })
    ) {
      findings.push({
        id: "github_broker_or_app_config_key",
        path: recordPath.join("."),
        reason: `github_broker_or_app_key:${normalizedKey}`,
      });
    }
  });
  return findings;
}

function visitRecord(value, trail, onLeaf) {
  if (value === null || value === undefined) {
    onLeaf({ path: trail, key: trail.at(-1), value });
    return;
  }
  if (typeof value !== "object") {
    onLeaf({ path: trail, key: trail.at(-1), value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitRecord(entry, [...trail, String(index)], onLeaf));
    return;
  }
  onLeaf({ path: trail, key: trail.at(-1), value });
  for (const [key, entry] of Object.entries(value)) {
    visitRecord(entry, [...trail, key], onLeaf);
  }
}

function shouldRejectKey({ source, normalizedKey, value }) {
  if (source === "domain_registry" && normalizedKey === "webhook_id") return hasMeaningfulValue(value);
  if (normalizedKey === "hosted") return hasMeaningfulValue(value);
  return value !== null && value !== undefined;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function excerptForMatch(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function formatFindings(findings) {
  return findings
    .map((finding) => `${finding.path || "unknown"}:${finding.id || finding.reason || "unknown"}`)
    .join(",");
}
