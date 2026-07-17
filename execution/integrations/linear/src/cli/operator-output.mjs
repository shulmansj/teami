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
  packageVersion = null,
} = {}) {
  if (installedPackageContext) {
    const exactVersion = typeof packageVersion === "string" && /^[0-9A-Za-z.+-]+$/.test(packageVersion.trim())
      ? packageVersion.trim()
      : null;
    const launcher = exactVersion
      ? `npx -y @shulmansj/teami@${exactVersion}`
      : "npx @shulmansj/teami";
    return subcommand ? `${launcher} ${subcommand}` : launcher;
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

const CONFIGURED_LINEAR_TEAM_MISSING_PATTERN =
  /^configured_linear_team_missing: Team (.+?) points to Linear team (.+?), but that team was not found in workspace (.+?)\.$/;

function completeTeamTeamMissingDiagnostic({ teamRef, teamId, workspace } = {}) {
  return `configured_linear_team_missing: Team ${teamRef || "unknown"} points to Linear team ${teamId || "unknown"}, but that team was not found in workspace ${workspace || "unknown"}.`;
}

function completeTeamTeamMissingFix(teamRef) {
  const teamArg = teamRef || "<id>";
  return (
    `Run ${formatCommand(`uninstall --team ${teamArg}`)}, then ` +
    `${formatCommand(`init --team ${teamArg}`)} to start this team fresh, or restore the team in Linear ` +
    `and re-run ${formatCommand(`init --team ${teamArg}`)}.`
  );
}

function completeTeamTeamMissingRecovery({ teamRef, teamId, workspace, diagnostic = null } = {}) {
  const renderedDiagnostic = diagnostic || completeTeamTeamMissingDiagnostic({ teamRef, teamId, workspace });
  return {
    code: "configured_linear_team_missing",
    teamRef: teamRef || "unknown",
    teamId: teamId || "unknown",
    workspace: workspace || "unknown",
    diagnostic: renderedDiagnostic,
    what:
      `The Linear team saved for team "${teamRef || "unknown"}" no longer exists in workspace ${workspace || "unknown"}. ` +
      renderedDiagnostic,
    why: `Teami resolves this team by its saved team id ${teamId || "unknown"} and will not guess by name or silently recreate it.`,
    fix: completeTeamTeamMissingFix(teamRef),
  };
}

function completeTeamTeamMissingRecoveryFromError(error) {
  const message = String(error?.message || error || "");
  const match = message.match(CONFIGURED_LINEAR_TEAM_MISSING_PATTERN);
  if (!match) return null;
  const [, teamRef, teamId, workspace] = match;
  return completeTeamTeamMissingRecovery({
    teamRef,
    teamId,
    workspace,
    diagnostic: message,
  });
}

function completeTeamTeamMissingRecoveryForTeam(team = {}) {
  return completeTeamTeamMissingRecovery({
    teamRef: team?.id || "unknown",
    teamId: team?.linear?.team_id || "unknown",
    workspace: team?.linear?.workspace_name || team?.linear?.workspace_id || "unknown",
  });
}

export {
  agenticFactoryHeading,
  compactPairs,
  completeTeamTeamMissingRecoveryForTeam,
  completeTeamTeamMissingRecoveryFromError,
  formatCommand,
  formatCommandForContext,
  humanizeInterval,
  humanizeToken,
  isInstalledPackageModulePath,
  printVerboseHint,
  yesNo,
};
