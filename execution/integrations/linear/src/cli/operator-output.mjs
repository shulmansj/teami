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

// The repo-local launcher is invoked differently per OS: PowerShell and cmd.exe need the
// `.\teami.cmd` form (PowerShell will not run a current-dir command by bare name, and
// `.\teami.cmd` works in both Windows shells), while POSIX shells use `./teami`. Every
// adopter-facing next-step / fix / help / home line renders through this helper so no stream
// hands back a command the user's own shell rejects. Bare launcher when no subcommand is given.
function formatCommand(subcommand = "") {
  const launcher = process.platform === "win32" ? ".\\teami.cmd" : "./teami";
  return subcommand ? `${launcher} ${subcommand}` : launcher;
}

export {
  agenticFactoryHeading,
  compactPairs,
  formatCommand,
  humanizeInterval,
  humanizeToken,
  printVerboseHint,
  yesNo,
};
