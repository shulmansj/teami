import { fileURLToPath } from "node:url";

function agenticFactoryHeading(output, readableCommand) {
  output.heading(`Teami ${output.symbols.separator} ${readableCommand}`);
}

function printVerboseHint(output) {
  if (output.verbose) return;
  output.raw(`\n  ${output.style.dim("(Run with --verbose for full detail.)")}\n`);
}

function compactPairs(pairs = []) {
  return pairs.filter(([, value]) => value !== null && value !== undefined && value !== "");
}

function humanizeToken(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

// Render a poll interval as plain English from the ACTUAL configured value (never the raw
// "10000ms", never a hard-coded "10s"). e.g. 10000 -> "10 seconds", 90000 -> "2 minutes".
function humanizeInterval(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  const minutes = Math.round(totalSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function yesNo(value) {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}

function isInstalledPackageModulePath(modulePath) {
  return String(modulePath || "").split(/[\\/]+/).includes("node_modules");
}

const INSTALLED_PACKAGE_CONTEXT = isInstalledPackageModulePath(fileURLToPath(import.meta.url));

function formatCommandForContext(subcommand = "", {
  installedPackageContext = INSTALLED_PACKAGE_CONTEXT,
  platform = process.platform,
} = {}) {
  if (installedPackageContext) {
    return subcommand ? `npx @shulmansj/teami ${subcommand}` : "npx @shulmansj/teami";
  }

  const launcher = platform === "win32" ? ".\\teami.cmd" : "./teami";
  return subcommand ? `${launcher} ${subcommand}` : launcher;
}

// The repo-local launcher is invoked differently per OS: PowerShell and cmd.exe need the
// `.\teami.cmd` form (PowerShell will not run a current-dir command by bare name, and
// `.\teami.cmd` works in both Windows shells), while POSIX shells use `./teami`. When this
// CLI is running from an installed package, adopter-facing commands use the package launcher
// instead. Bare launcher when no subcommand is given.
function formatCommand(subcommand = "") {
  return formatCommandForContext(subcommand);
}

const COMPLETE_DOMAIN_TEAM_MISSING_PATTERN =
  /^complete_domain_team_missing: domain (.+?) records Linear team (.+?), but that team was not found in workspace (.+?)\.$/;

function completeDomainTeamMissingDiagnostic({ domainId, teamId, workspace } = {}) {
  return `complete_domain_team_missing: domain ${domainId || "unknown"} records Linear team ${teamId || "unknown"}, but that team was not found in workspace ${workspace || "unknown"}.`;
}

function completeDomainTeamMissingFix(domainId) {
  const domainArg = domainId || "<id>";
  return (
    `Run ${formatCommand(`uninstall --domain ${domainArg}`)}, then ` +
    `${formatCommand(`init --domain ${domainArg}`)} to start this domain fresh, or restore the team in Linear ` +
    `and re-run ${formatCommand(`init --domain ${domainArg}`)}.`
  );
}

function completeDomainTeamMissingRecovery({ domainId, teamId, workspace, diagnostic = null } = {}) {
  const renderedDiagnostic = diagnostic || completeDomainTeamMissingDiagnostic({ domainId, teamId, workspace });
  return {
    code: "complete_domain_team_missing",
    domainId: domainId || "unknown",
    teamId: teamId || "unknown",
    workspace: workspace || "unknown",
    diagnostic: renderedDiagnostic,
    what:
      `The Linear team saved for domain "${domainId || "unknown"}" no longer exists in workspace ${workspace || "unknown"}. ` +
      renderedDiagnostic,
    why: `Teami resolves this domain by its saved team id ${teamId || "unknown"} and will not guess by name or silently recreate it.`,
    fix: completeDomainTeamMissingFix(domainId),
  };
}

function completeDomainTeamMissingRecoveryFromError(error) {
  const message = String(error?.message || error || "");
  const match = message.match(COMPLETE_DOMAIN_TEAM_MISSING_PATTERN);
  if (!match) return null;
  const [, domainId, teamId, workspace] = match;
  return completeDomainTeamMissingRecovery({
    domainId,
    teamId,
    workspace,
    diagnostic: message,
  });
}

function completeDomainTeamMissingRecoveryForDomain(domain = {}) {
  return completeDomainTeamMissingRecovery({
    domainId: domain?.id || "unknown",
    teamId: domain?.linear?.team_id || "unknown",
    workspace: domain?.linear?.workspace_name || domain?.linear?.workspace_id || "unknown",
  });
}

export {
  agenticFactoryHeading,
  compactPairs,
  completeDomainTeamMissingRecoveryForDomain,
  completeDomainTeamMissingRecoveryFromError,
  formatCommand,
  formatCommandForContext,
  humanizeInterval,
  humanizeToken,
  isInstalledPackageModulePath,
  printVerboseHint,
  yesNo,
};
