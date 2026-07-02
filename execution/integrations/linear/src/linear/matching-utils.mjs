import { emptyDomainRegistry } from "../domain-registry.mjs";
import { behaviorRepoIdForRepoRoot } from "../domain-resolver.mjs";
import { buildProjectTemplateBody } from "../project-body.mjs";
import { STABLE_KEY_PATTERN } from "../../../../engine/stable-key-pattern.mjs";

export { STABLE_KEY_PATTERN } from "../../../../engine/stable-key-pattern.mjs";

export const CLOSED_ISSUE_TYPES = new Set(["completed", "canceled", "cancelled"]);

export function knownRegistryWorkspaces(registry = emptyDomainRegistry()) {
  const workspaces = new Map();
  for (const domain of registry?.domains || []) {
    const workspaceId = domain?.linear?.workspace_id || null;
    if (!workspaceId) continue;
    if (!workspaces.has(workspaceId)) {
      workspaces.set(workspaceId, {
        mode: "known",
        workspaceId,
        workspaceName: domain.linear?.workspace_name || null,
        domains: [],
      });
    }
    const workspace = workspaces.get(workspaceId);
    if (!workspace.workspaceName && domain.linear?.workspace_name) {
      workspace.workspaceName = domain.linear.workspace_name;
    }
    workspace.domains.push({
      id: domain.id,
      status: domain.status,
      teamName: domain.linear?.team_name || null,
    });
  }
  return [...workspaces.values()];
}

export function normalizeLinearWorkspace(workspace = {}) {
  return {
    id: workspace.id || workspace.workspaceId || workspace.workspace_id || null,
    name: workspace.name || workspace.workspaceName || workspace.workspace_name || null,
    urlKey: workspace.urlKey || workspace.url_key || null,
  };
}

export function workspaceLabel(workspace = {}) {
  const normalized = normalizeLinearWorkspace(workspace);
  return normalized.name || normalized.id || workspace.workspaceName || workspace.workspaceId || workspace.value || "unknown";
}

export function discoveryIssuesForProject(project, shape) {
  return (project.issues || []).filter((issue) => issueHasLabel(issue, shape.issueLabels.discovery.id));
}

export function discoveryIssueKey(discoveryIssue) {
  return (
    discoveryIssue.discovery_key ||
    discoveryIssue.decomposition_key ||
    discoveryIssue.decompositionKey ||
    discoveryIssue.discoveryKey
  );
}

export function issueKey(issue) {
  return issue.decomposition_key || issue.decompositionKey;
}

export function issueBodyMarkdown(issue) {
  return issue.issue_body_markdown || issue.issueBodyMarkdown || "";
}

export function issueDependencies(issue) {
  return issue.depends_on || issue.dependsOn || [];
}

export function issueHasLabel(issue, labelId) {
  return issue.labels?.some((label) => label.id === labelId);
}

export function projectBelongsToTeam(project, teamId) {
  if (!teamId) return false;
  if (project.teamId === teamId) return true;
  if (project.team?.id === teamId) return true;
  if (project.teamIds?.includes(teamId)) return true;
  const teams = Array.isArray(project.teams) ? project.teams : project.teams?.nodes || [];
  return teams.some((team) => team?.id === teamId);
}

export function isIssueClosed(issue) {
  return CLOSED_ISSUE_TYPES.has(String(issue?.state?.type || "").toLowerCase());
}

export function isIssueOpen(issue) {
  return !isIssueClosed(issue);
}

export function matchesStatus(actual, expected) {
  if (!actual || !expected) return false;
  if (expected.id) return actual.id === expected.id;
  return actual.type && expected.type && actual.type === expected.type;
}

export function projectLabelNames(config) {
  return [config.linear.project.labels.has_open_questions];
}

export function issueLabelNames(config) {
  return [
    config.linear.issue.labels.discovery,
    config.linear.issue.labels.needs_principal,
    config.linear.issue.labels.work_type_code,
    config.linear.issue.labels.work_type_non_code,
  ].filter(Boolean);
}

export function configWithLinearTeam(config, team) {
  const next = structuredClone(config);
  next.linear.team = {
    ...(next.linear.team || {}),
    key: team.key,
    name: team.name,
  };
  return next;
}

export function resolveDomainTrace({ domainContext, traceContext = {}, cache = null, repoRoot = process.cwd() } = {}) {
  return {
    domain_id: domainContext?.trace?.domain_id || traceContext.domain_id || cache?.domainId || null,
    workspace_id:
      domainContext?.trace?.workspace_id ||
      traceContext.workspace_id ||
      cache?.workspaceId ||
      null,
    team_id:
      domainContext?.trace?.team_id ||
      traceContext.team_id ||
      cache?.teamId ||
      null,
    behavior_repo_id:
      domainContext?.trace?.behavior_repo_id ||
      traceContext.behavior_repo_id ||
      behaviorRepoIdForRepoRoot(repoRoot),
  };
}

export function knownTraceAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export function normalizeDeclaredWorkspace(declaredWorkspace) {
  if (!declaredWorkspace) return null;
  if (typeof declaredWorkspace === "string") {
    const value = declaredWorkspace.trim();
    return value ? { mode: "expected", value } : null;
  }
  const mode = declaredWorkspace.mode || "expected";
  if (mode === "known") {
    const normalized = normalizeLinearWorkspace(declaredWorkspace);
    return {
      mode: "known",
      workspaceId: normalized.id,
      workspaceName: normalized.name,
    };
  }
  if (mode === "expected") {
    const value = String(declaredWorkspace.value || declaredWorkspace.workspaceId || declaredWorkspace.workspaceName || "").trim();
    return value ? { mode: "expected", value } : null;
  }
  if (mode === "different") return { mode: "different" };
  return { ...declaredWorkspace, mode };
}

export function domainNameMatchesRegistryDomain(domain, requestedName, requestedSlug = null) {
  if (!domain) return false;
  if (domain.adopter_provided_name && equalsFolded(domain.adopter_provided_name, requestedName)) return true;
  if (domain.linear?.team_name && equalsFolded(domain.linear.team_name, requestedName)) return true;
  return Boolean(domain.status === "setup_incomplete" && requestedSlug && domain.id === requestedSlug);
}

export function workspaceMismatchError({ granted, declared, detail, domains = [] } = {}) {
  const grantedWorkspace = normalizeLinearWorkspace(granted);
  const declaredWorkspace = normalizeDeclaredWorkspace(declared) || {};
  const grantedId = grantedWorkspace.id || "unknown";
  const expectedId = declaredWorkspace.workspaceId || declaredWorkspace.value || "unknown";
  const grantedName = grantedWorkspace.name || "unknown";
  const expectedName = declaredWorkspace.workspaceName || declaredWorkspace.value || "unknown";
  const secondary = [
    `granted_name=${grantedName}`,
    `expected_name=${expectedName}`,
    detail ? `detail=${detail}` : null,
    domains.length ? `domains=${domains.join(",")}` : null,
  ].filter(Boolean).join(" ");
  const error = new Error(
    `workspace_mismatch: granted=${grantedId} expected=${expectedId} (${secondary})`,
  );
  error.code = "workspace_mismatch";
  error.granted = grantedWorkspace;
  error.expected = declaredWorkspace;
  error.detail = detail;
  error.domains = domains;
  return error;
}

export function equalsFolded(left, right) {
  return String(left || "").trim().toLocaleLowerCase() === String(right || "").trim().toLocaleLowerCase();
}

export function normalizedErrors(payload) {
  if (Array.isArray(payload?.errors)) return payload.errors;
  if (Array.isArray(payload?.payload?.errors)) return payload.payload.errors;
  if (Array.isArray(payload?.graphqlPayload?.errors)) return payload.graphqlPayload.errors;
  if (Array.isArray(payload?.response?.errors)) return payload.response.errors;
  if (Array.isArray(payload?.cause?.errors)) return payload.cause.errors;
  if (payload instanceof Error) {
    return [{
      message: payload.message,
      path: payload.path,
      extensions: payload.extensions,
      type: payload.type,
    }];
  }
  if (payload && typeof payload === "object") {
    return [{
      message: payload.message || String(payload),
      path: payload.path,
      extensions: payload.extensions,
      type: payload.type,
    }];
  }
  return [{ message: String(payload || "unknown teamCreate error") }];
}

export function projectTemplateData() {
  return {
    content: buildProjectTemplateBody(),
  };
}

function templateBody(template) {
  return template.templateData?.content || template.content || template.description || "";
}

export function templateHasRequiredBody(template) {
  const body = templateBody(template);
  const openQuestions = /^## Open Questions[ \t]*\n([\s\S]*?)(?=^##\s|\s*$)/m.exec(body);
  return (
    body.includes("## Open Questions") &&
    openQuestions?.[1].trim() === "" &&
    !openQuestions?.[1].includes("None.") &&
    !body.includes("## Discovery Findings")
  );
}

export function uniqueOrThrow(matches, label) {
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}.`);
  }
  return matches[0];
}

export async function resolveLabelByNameOrId({ list, id, label }) {
  const matches = id ? list.filter((candidate) => candidate.id === id) : list;
  return uniqueOrThrow(matches, label);
}

export async function check(name, checks, fn) {
  try {
    await fn();
    checks.push({ name, ok: true, message: "ok" });
  } catch (error) {
    checks.push({ name, ok: false, message: error.message });
  }
}

export function resultFromMatches(name, matches, expected) {
  if (matches.length === 1) return { name, ok: true, message: `found ${expected}` };
  if (matches.length === 0) return { name, ok: false, message: `missing ${expected}` };
  return { name, ok: false, message: `ambiguous ${expected}: found ${matches.length}` };
}

export async function validateCache(client, cache) {
  const checks = [];
  if (cache.teamId) {
    const teams = await client.listTeams();
    checks.push({
      name: "cache teamId",
      ok: teams.some((team) => team.id === cache.teamId),
      message: `teamId ${cache.teamId}`,
    });
  }
  if (cache.projectTemplateId) {
    const templates = await client.findTemplatesByName("", "project");
    checks.push({
      name: "cache projectTemplateId",
      ok: templates.some((template) => template.id === cache.projectTemplateId),
      message: `projectTemplateId ${cache.projectTemplateId}`,
    });
  }
  return checks;
}
