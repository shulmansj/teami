import {
  domainRegistryPath,
  readDomainRegistry,
  validateDomainRegistry,
} from "../domain-registry.mjs";
import {
  check,
  issueLabelNames,
  projectLabelNames,
  resultFromMatches,
  templateHasRequiredBody,
  validateCache,
} from "./matching-utils.mjs";
import {
  resolveProjectStatusMappings,
} from "./shape-resolver.mjs";
import { repairPathForSetupIncompleteCause } from "./setup-service.mjs";

export const MERGE_DONE_AUTOMATION_CHECK_NAME = "merge-to-Done automation";

const PROJECT_STATUS_ROLES = Object.freeze(["backlog", "planned", "in_progress", "completed"]);
const ISSUE_STATUS_ROLES = Object.freeze(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);

export async function doctorLinear({ client, config, cache = null } = {}) {
  const checks = [];

  await check("auth", checks, async () => {
    await client.verifyAuth?.();
  });

  const teams = await client.listTeams();
  const matchingTeams = teams.filter((team) => team.key === config.linear.team.key);
  checks.push(resultFromMatches("team", matchingTeams, config.linear.team.key));
  const team = matchingTeams[0];

  for (const labelName of projectLabelNames(config)) {
    if (cache) {
      await check(`project label ${labelName}`, checks, async () => {
        await verifyCachedProjectLabel({ client, cache, labelName });
      });
    } else {
      const labels = await client.findProjectLabelsByName(labelName);
      checks.push(resultFromMatches(`project label ${labelName}`, labels, labelName));
    }
  }

  for (const labelName of issueLabelNames(config)) {
    if (cache) {
      await check(`issue label ${labelName}`, checks, async () => {
        await verifyCachedIssueLabel({ client, cache, labelName, teamId: team?.id || cache.teamId });
      });
    } else {
      const labels = await client.findIssueLabelsByName(labelName, team?.id);
      checks.push(resultFromMatches(`issue label ${labelName}`, labels, labelName));
    }
  }

  await check("project status mappings", checks, async () => {
    if (cache) {
      await verifyCachedProjectStatusMappings({ client, config, cache });
    } else {
      await resolveProjectStatusMappings({ client, config, cache, failClosed: true });
    }
  });

  const templates = await client.findTemplatesByName(
    config.linear.project.template_name,
    "project",
    team?.id,
  );
  const templateCheck = resultFromMatches(
    "Linear project template",
    templates,
    config.linear.project.template_name,
  );
  if (templateCheck.ok && !templateHasRequiredBody(templates[0])) {
    templateCheck.ok = false;
    templateCheck.message =
      "Project template must contain a blank Open Questions section and must not contain Discovery Findings.";
  }
  checks.push(templateCheck);

  if (cache) {
    checks.push(...(await validateCache(client, cache)));
  }

  if (team) {
    await check("issue status mappings", checks, async () => {
      await verifyIssueStatusMappings({ client, config, teamId: team.id, cache });
    });
    checks.push(await doctorMergeDoneAutomationCheck({ client, team }));
  }

  return {
    healthy: checks.every((checkResult) => checkResult.ok),
    checks,
  };
}

async function verifyCachedProjectStatusMappings({ client, config, cache }) {
  const statuses = await client.listProjectStatuses();
  for (const role of PROJECT_STATUS_ROLES) {
    const configuredStatus = config?.linear?.project?.statuses?.[role];
    if (!configuredStatus) {
      throw new Error(`Linear project status role ${role} is not configured.`);
    }
    const cachedId = cache?.projectStatuses?.[role];
    if (!cachedId) {
      throw new Error(`Cached Linear project status ${role} is missing.`);
    }
    const status = uniqueCachedEntity(
      statuses.filter((candidate) => candidate.id === cachedId),
      `Linear project status ${role}`,
      cachedId,
    );
    if (status.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear project status ${role} has type ${status.type}, expected ${configuredStatus.type}.`,
      );
    }
  }
}

async function verifyIssueStatusMappings({ client, config, teamId, cache }) {
  const states = await client.listWorkflowStates?.(teamId);
  if (!states) {
    throw new Error("Cannot resolve Linear issue statuses: client cannot list workflow states.");
  }

  for (const role of ISSUE_STATUS_ROLES) {
    const configuredStatus = config?.linear?.issue?.statuses?.[role];
    if (!configuredStatus) {
      throw new Error(`Linear issue status role ${role} is not configured.`);
    }

    if (!cache) {
      const matches = states.filter((state) => state.name === configuredStatus.name);
      if (matches.length !== 1) {
        throw new Error(
          `Cannot resolve issue status mapping '${role}' by configured name '${configuredStatus.name}': found ${matches.length}.`,
        );
      }
      if (matches[0].type !== configuredStatus.type) {
        throw new Error(
          `Configured Linear issue status ${role} has type ${matches[0].type}, expected ${configuredStatus.type}.`,
        );
      }
      continue;
    }

    const cachedId = cache?.issueStatuses?.[role];
    if (!cachedId) {
      throw new Error(`Cached Linear issue status ${role} is missing.`);
    }
    const state = uniqueCachedEntity(
      states.filter((candidate) => candidate.id === cachedId),
      `Linear issue status ${role}`,
      cachedId,
    );
    if (state.type !== configuredStatus.type) {
      throw new Error(
        `Cached Linear issue status ${role} has type ${state.type}, expected ${configuredStatus.type}.`,
      );
    }
  }
}

async function verifyCachedProjectLabel({ client, cache, labelName }) {
  const cachedId = cache?.projectLabels?.[labelName];
  if (!cachedId) {
    throw new Error(`Cached Linear project label ${labelName} is missing.`);
  }
  const labels = await client.findProjectLabelsByName(null);
  uniqueCachedEntity(
    labels.filter((candidate) => candidate.id === cachedId),
    `Linear project label ${labelName}`,
    cachedId,
  );
}

async function verifyCachedIssueLabel({ client, cache, labelName, teamId }) {
  const cachedId = cache?.issueLabels?.[labelName];
  if (!cachedId) {
    throw new Error(`Cached Linear issue label ${labelName} is missing.`);
  }
  const labels = await client.findIssueLabelsByName(null, teamId);
  uniqueCachedEntity(
    labels.filter((candidate) => candidate.id === cachedId),
    `Linear issue label ${labelName}`,
    cachedId,
  );
}

function uniqueCachedEntity(matches, label, id) {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`Cached ${label}=${id} no longer exists.`);
  }
  throw new Error(`Cached ${label}=${id} is ambiguous: found ${matches.length}.`);
}

export async function doctorMergeDoneAutomationCheck({ client, team } = {}) {
  const teamName = formatTeamName(team);
  try {
    if (typeof client?.getTeamGitAutomationSettings !== "function") {
      return mergeDoneFailureCheck(
        teamName,
        "Linear client cannot inspect Git automation settings",
      );
    }
    const automation = await client.getTeamGitAutomationSettings(team?.id);
    return mergeDoneAutomationVerdict({ automation, teamName });
  } catch (error) {
    return mergeDoneFailureCheck(
      teamName,
      `could not inspect Linear Git automation settings: ${error.message}`,
    );
  }
}

export function mergeDoneAutomationVerdict({ automation = {}, teamName = "selected team" } = {}) {
  const wired = mergeDoneAutomationEvidence(automation);
  if (wired) {
    return {
      name: MERGE_DONE_AUTOMATION_CHECK_NAME,
      ok: true,
      message:
        `PR merge automation is wired for ${teamName}: ${wired.source} moves linked issues to ` +
        `${formatWorkflowState(wired.state)}.`,
    };
  }

  return mergeDoneFailureCheck(
    teamName,
    mergeDoneAutomationProblem(automation),
  );
}

function mergeDoneAutomationEvidence(automation = {}) {
  const explicitRule = (automation.gitAutomationStates || []).find(
    (rule) => isMergeAutomationEvent(rule?.event) && isDoneWorkflowState(rule?.state),
  );
  if (explicitRule) {
    return {
      source: `git automation event ${explicitRule.event}${explicitRule.branchPattern ? ` on ${explicitRule.branchPattern}` : ""}`,
      state: explicitRule.state,
    };
  }

  if (isDoneWorkflowState(automation.mergeWorkflowState)) {
    return {
      source: "mergeWorkflowState",
      state: automation.mergeWorkflowState,
    };
  }

  return null;
}

function mergeDoneAutomationProblem(automation = {}) {
  const mergeRules = (automation.gitAutomationStates || []).filter((rule) =>
    isMergeAutomationEvent(rule?.event));
  if (automation.mergeWorkflowState) {
    return `PR merged currently targets ${formatWorkflowState(automation.mergeWorkflowState)}, not a completed/Done state`;
  }
  if (mergeRules.length > 0) {
    const targets = mergeRules
      .map((rule) => `${rule.event} -> ${formatWorkflowState(rule.state)}`)
      .join("; ");
    return `PR-merge git automation exists but does not target a completed/Done state (${targets})`;
  }
  return "no PR-merged rule targets a completed/Done workflow state";
}

function mergeDoneFailureCheck(teamName, reason) {
  return {
    name: MERGE_DONE_AUTOMATION_CHECK_NAME,
    ok: false,
    message:
      `Linear/GitHub merge-to-Done automation is not wired for ${teamName}: ${reason}. ` +
      "Dependents will stall until you wire this automation, or move issues manually after merging.",
  };
}

function isMergeAutomationEvent(event) {
  const normalized = String(event || "").toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "merge" || normalized.includes("merged");
}

function isDoneWorkflowState(state) {
  const type = String(state?.type || "").toLowerCase();
  const name = String(state?.name || "").trim().toLowerCase();
  return type === "completed" || (!type && name === "done");
}

function formatWorkflowState(state) {
  if (!state) return "no workflow state";
  const name = state.name || state.id || "unknown";
  return state.type ? `${name} (${state.type})` : name;
}

function formatTeamName(team = {}) {
  const label = [team.key, team.name].filter(Boolean).join(" ");
  return label || team.id || "selected team";
}

export function doctorDomainRegistryFromDisk({
  repoRoot = process.cwd(),
  orphanHints = [],
} = {}) {
  try {
    const registry = readDomainRegistry({ repoRoot });
    if (!registry) {
      return doctorDomainRegistry({
        registryError: new Error(`Domain registry not found: ${domainRegistryPath(repoRoot)}`),
        orphanHints,
      });
    }
    return doctorDomainRegistry({ registry, orphanHints });
  } catch (error) {
    return doctorDomainRegistry({ registryError: error, orphanHints });
  }
}

export function doctorDomainRegistry({ registry = null, registryError = null, orphanHints = [] } = {}) {
  if (registryError) {
    const orphanText = orphanHints.length > 0
      ? ` Likely orphaned local state: ${orphanHints.join("; ")}.`
      : " No specific orphaned local state was found in this pass.";
    return {
      healthy: false,
      registryAvailable: false,
      checks: [{
        name: "domain registry",
        ok: false,
        message:
          `${registryError.message}.${orphanText} Run npm run reset to remove local setup state; no domain was inferred from names.`,
      }],
    };
  }

  validateDomainRegistry(registry);
  const checks = registry.domains.map((domain) => {
    if (domain.status === "setup_incomplete") {
      const cause = domain.setup_incomplete_cause || "setup_incomplete";
      return {
        name: `domain ${domain.id}`,
        ok: false,
        message: `${cause}; ${repairPathForSetupIncompleteCause(cause)}`,
        fix: repairPathForSetupIncompleteCause(cause),
      };
    }
    return {
      name: `domain ${domain.id}`,
      ok: domain.status === "active",
      message:
        `${domain.status}; workspace=${domain.linear.workspace_id || "missing"}; ` +
        `team=${domain.linear.team_id || "missing"} ${domain.linear.team_key || ""} ${domain.linear.team_name || ""}; ` +
        `webhook=${domain.linear.webhook_id || "missing"}; cache=${domain.linear.cache_path}`,
    };
  });
  return {
    healthy: checks.every((check) => check.ok),
    registryAvailable: true,
    checks,
  };
}
