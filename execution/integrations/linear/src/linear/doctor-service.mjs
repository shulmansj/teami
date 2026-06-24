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
  resolveIssueStatuses,
  resolveProjectStatusMappings,
} from "./shape-resolver.mjs";
import { repairPathForSetupIncompleteCause } from "./setup-service.mjs";

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
    const labels = await client.findProjectLabelsByName(labelName);
    checks.push(resultFromMatches(`project label ${labelName}`, labels, labelName));
  }

  for (const labelName of issueLabelNames(config)) {
    const labels = await client.findIssueLabelsByName(labelName, team?.id);
    checks.push(resultFromMatches(`issue label ${labelName}`, labels, labelName));
  }

  await check("project status mappings", checks, async () => {
    await resolveProjectStatusMappings({ client, config, cache, failClosed: true });
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
      await resolveIssueStatuses(client, config, team.id);
    });
  }

  return {
    healthy: checks.every((checkResult) => checkResult.ok),
    checks,
  };
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

