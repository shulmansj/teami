function agenticFactoryHeading(output, readableCommand) {
  output.heading(`Agentic Factory ${output.symbols.separator} ${readableCommand}`);
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

function yesNo(value) {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export {
  agenticFactoryHeading,
  compactPairs,
  humanizeToken,
  printVerboseHint,
  yesNo,
};
